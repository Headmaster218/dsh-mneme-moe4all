// distill2.js — 每轮对话后的单次调用蒸馏引擎（本地重写入版）。
//
// 与上游 summarize.js 的区别（本机定制，重打补丁脚本见工作区 mneme-patch）：
//   1. 只蒸馏"刚结束的这一轮"（事件从最近一次 turn/start 起截取），不再每轮
//      把整个会话从头重蒸一遍；
//   2. 调用前先用本地检索注入最相关的既有记忆（向量+回退，零 LLM 成本），
//      让模型在同一次调用里完成 新建/合并/修正/跳过 四种决策 + 重要性判定；
//   3. 一轮恰好一次 LLM 调用，无任何按条扇出；失败的轮次转录进内存重试缓冲，
//      下一次成功调用一并带上（失败不静默丢数据，也不重复计费）。
//   4. 中断/出错的轮次（turn/end reason.kind = aborted/error）直接跳过——半截
//      对话提炼出的往往是误导性记忆。
//
// 审计语义保持与旧版一致：llm_audit_logs 记 token/时长/状态，
// trigger_source=autoSummarize、operation_type=summarize_decisions。
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
// 复用 dream.js 的推理档位三件套：resolveDreamEffort 会先问 harness 这个模型
// 到底声明了哪些档位（不支持就不发字段），withEffortFallback 兜住"provider 在
// 流里以 error finish 拒收"的情形（自动去掉字段重试一次）。
import { resolveDreamEffort, withEffortFallback, describeStreamFailure } from "./dream.js";

const TYPES = new Set(["preference", "project", "decision", "history", "rejected_solution", "pitfall", "constraint"]);

const SYSTEM_PROMPT = `你是记忆库管理员。给你两部分输入：①刚刚结束的这一轮对话的转录；②记忆库中与本轮内容相关的既有记忆（每条带 id）。
请输出一个 JSON 数组作为本轮的全部记忆操作；没有值得跨会话记住的内容就输出 []。可用动作：
1. {"action":"create","type":"preference|project|decision|history|rejected_solution|pitfall|constraint","title":"简短标题","content":"保留原始细节的一句话","importance":1-5} —— 本轮出现、且既有记忆中不存在的新事实。
2. {"action":"merge","ids":["既有记忆id","既有记忆id"],"title":"合并后的标题","content":"合并后的正文（保留各条独有细节）","importance":1-5,"reason":"为什么它们是同一事实"} —— 本轮内容与某条既有记忆说的是同一件事，或多条既有记忆彼此重复。ids 只能引用下方列出的既有记忆 id，至少 2 条。
3. {"action":"update","ids":["既有记忆id"],"content":"修正后的正文","reason":"旧内容与新事实矛盾在哪"} —— 新事实表明某条既有记忆已过时或说错了，改写它。必须给出 reason。
规则：
- 等价事实已存在时绝不 create（应 merge 或干脆不提）。
- 只记跨会话仍有价值的内容（偏好/决定/路径/配置/踩坑/结论）；寒暄、闲聊、一次性过程不记。
- importance 判定：5=长期身份级偏好或铁律；4=项目级决定/约束/关键路径；3=阶段性有效的事实；2=一次性细节（尽量别记录）；1=几乎无价值。
- 每条记忆自带完整上下文：数字、名字、路径、结论原文写进 content，不要抽象概括。
- 只输出 JSON 数组，不要输出任何其他文字。`;

// 与 summarize.js 相同的宽容 JSON 数组解析：容忍围栏/前后散文。
export function parseDecisionsJson(raw) {
  const text = String(raw ?? "");
  const start = text.indexOf("[");
  if (start === -1) return null;
  for (let end = text.lastIndexOf("]"); end > start; end = text.lastIndexOf("]", end - 1)) {
    const candidate = text.slice(start, end + 1);
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* 继续收缩右边界 */ }
  }
  return null;
}

const textOf = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (typeof b === "string" ? b : b && b.type === "text" && typeof b.text === "string" ? b.text : ""))
    .filter(Boolean)
    .join("\n");
};
const clip = (s, n) => (typeof s === "string" && s.length > n ? `${s.slice(0, n)}…` : s ?? "");

/**
 * 从会话事件里截取"最近一轮"的转录。事件流里最后一次 turn/start 之后的全部
 * 事件即当前轮；找不到 turn/start（首轮/旧版会话）时退回全量。
 * 返回 { transcript, userText }：transcript 交模型，userText 作检索查询。
 * 兼容严格/宽松两种 content 形状（同 summarize.js 的 textOf 约定）。
 */
export function buildTurnTranscript(events, maxChars = 24000) {
  const list = Array.isArray(events) ? events : [];
  let from = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.type === "turn/start") { from = i + 1; break; }
  }
  const lines = [];
  const userParts = [];
  for (const event of list.slice(from)) {
    if (event?.type === "turn/end" || event?.type === "turn/start") continue;
    const data = event?.data ?? {};
    switch (event?.type) {
      case "user/message": {
        const kind = data?.source?.kind;
        if (kind !== undefined && kind !== "user") break; // 插件注入的机器内容不进蒸馏
        const text = textOf(data?.content);
        if (text.trim()) { lines.push(`用户：${text}`); userParts.push(text); }
        break;
      }
      case "assistant/message": {
        // 刻意不采集 reasoning 私有推理块（同上游隐私约定）。
        const text = textOf(data?.message?.content);
        if (text.trim()) lines.push(`助手：${text}`);
        break;
      }
      case "tool/call": {
        const args = typeof data.arguments === "string" ? data.arguments : data.arguments ? JSON.stringify(data.arguments) : "";
        lines.push(`工具调用：${data.name ?? "?"}(${clip(args, 200)})`);
        break;
      }
      case "tool/result":
      case "tool/code-dispatch": {
        const out = typeof data.output === "string" ? data.output : data.output ? JSON.stringify(data.output) : "";
        lines.push(`${event.type === "tool/result" ? "工具结果" : "代码执行"}（${data.ok === false ? "失败" : "成功"}）：${clip(out, 300)}`);
        break;
      }
      default: break;
    }
  }
  return { transcript: clip(lines.join("\n"), maxChars), userText: userParts.join("\n") };
}

const clampImportance = (v) => (Number.isInteger(v) ? Math.min(5, Math.max(1, v)) : 3);

/**
 * 应用本轮决策。merge 的保留条取组内最旧行（创建时间升序第一位），其余归档；
 * update 必须带 reason 且旧文进 content_history（source=distill_update）。
 * 纯函数式依赖注入：service 只需 getById/update/setArchived/saveWithDedupe/transaction。
 */
export function applyTurnDecisions(decisions, service, logger, sourceLabel) {
  const outcome = { created: 0, merged: 0, updated: 0, skipped: [] };
  for (const [i, d] of (Array.isArray(decisions) ? decisions : []).entries()) {
    const at = `decision[${i}]`;
    try {
      if (!d || typeof d !== "object") { outcome.skipped.push(`${at}: not an object`); continue; }
      if (d.action === "create") {
        if (!TYPES.has(d.type) || typeof d.title !== "string" || !d.title.trim() || typeof d.content !== "string" || !d.content.trim()) {
          outcome.skipped.push(`${at}: create needs valid type/title/content`);
          continue;
        }
        service.saveWithDedupe({
          type: d.type,
          title: d.title.trim(),
          content: d.content.trim(),
          importance: clampImportance(d.importance),
          source: sourceLabel
        });
        outcome.created++;
      } else if (d.action === "merge") {
        const ids = Array.isArray(d.ids) ? d.ids.filter((x) => typeof x === "string") : [];
        const rows = ids.map((id) => service.getById(id)).filter((m) => m && !m.archived && m.type !== "summary");
        if (rows.length < 2) { outcome.skipped.push(`${at}: merge needs >=2 live existing targets`); continue; }
        if (new Set(rows.map((r) => r.type)).size > 1) { outcome.skipped.push(`${at}: merge spans multiple types`); continue; }
        if (typeof d.title !== "string" || !d.title.trim() || typeof d.content !== "string" || !d.content.trim()) {
          outcome.skipped.push(`${at}: merge needs title/content`);
          continue;
        }
        rows.sort((a, b) => (String(a.created_at ?? "") < String(b.created_at ?? "") ? -1 : 1));
        const [keeper, ...sources] = rows;
        const importance = d.importance === undefined
          ? Math.max(...rows.map((r) => r.importance ?? 1))
          : clampImportance(d.importance);
        service.transaction(() => {
          service.update(keeper.id, { title: d.title.trim(), content: d.content.trim(), importance });
          for (const s of sources) service.setArchived(s.id, true);
        });
        outcome.merged++;
      } else if (d.action === "update") {
        const id = Array.isArray(d.ids) ? d.ids[0] : undefined;
        const row = id ? service.getById(id) : undefined;
        if (!row || row.archived || row.type === "summary") { outcome.skipped.push(`${at}: update target missing/archived`); continue; }
        if (typeof d.reason !== "string" || !d.reason.trim()) { outcome.skipped.push(`${at}: update requires a reason`); continue; }
        const newContent = String(d.content ?? row.content ?? "").trim();
        if (!newContent) { outcome.skipped.push(`${at}: update content empty`); continue; }
        const history = [
          { content: row.content ?? "", source: "distill_update", updated_at: new Date().toISOString() },
          ...(Array.isArray(row.content_history) ? row.content_history : [])
        ].slice(0, 20);
        service.update(row.id, {
          title: typeof d.title === "string" && d.title.trim() ? d.title.trim() : row.title,
          content: newContent,
          importance: d.importance === undefined ? row.importance : clampImportance(d.importance),
          content_history: history
        });
        outcome.updated++;
      } else {
        outcome.skipped.push(`${at}: unknown action ${JSON.stringify(d?.action)}`);
      }
    } catch (error) {
      outcome.skipped.push(`${at}: ${String(error?.message ?? error)}`);
    }
  }
  return outcome;
}

// 注入候选：向量近邻优先（embedQuery 可用时），按相似度阈值取 top-K；
// 无向量能力时退回 importance 降序 + 更新时间。纯读，不碰 GPU（向量检索是本地算术）。
export async function pickInjection(service, query, topK) {
  const active = service.all().filter((m) => !m.archived && m.type !== "summary");
  const shorten = (m) => ({ ...m, content: clip(m.content, 400) });
  try {
    const vec = typeof service.embedQuery === "function" ? await service.embedQuery(query) : null;
    if (vec && vec.length) {
      const hits = service.searchVector(vec, { limit: topK, threshold: 0.2 })
        .filter((m) => m && !m.archived && m.type !== "summary");
      if (hits.length) return { picked: hits.slice(0, topK).map(shorten), mode: "vector" };
    }
  } catch { /* 向量不可用：退回规则式 */ }
  const ranked = [...active].sort((a, b) =>
    (b.importance ?? 0) - (a.importance ?? 0) || String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")));
  return { picked: ranked.slice(0, Math.min(topK, 6)).map(shorten), mode: "importance" };
}

function formatInjected(memories) {
  if (!memories.length) return "（暂无相关既有记忆）";
  return memories.map((m) => `- id=${m.id} | type=${m.type} | importance=${m.importance} | title=${m.title} | content=${m.content}`).join("\n");
}

const STREAM_CHUNK_TYPES = new Set(["block-start", "text-delta", "reasoning-delta", "tool-call-delta", "block-end", "usage", "finish"]);
function toProtocolChunk(chunk) {
  switch (chunk.type) {
    case "block-start": return { type: "block-start", index: chunk.index ?? 0, blockType: chunk.blockType ?? chunk.block?.type ?? "text" };
    case "text-delta":
    case "reasoning-delta": return { type: chunk.type, index: chunk.index ?? 0, text: chunk.text ?? chunk.delta ?? "" };
    case "block-end": return { type: "block-end", index: chunk.index ?? 0, block: chunk.block ?? { type: "text" } };
    case "finish": return { type: "finish", reason: chunk.reason ?? { kind: chunk.kind === "error" ? "error" : "stop" }, replayState: chunk.replayState };
    default: return chunk;
  }
}

async function streamOnce(ctx, options, signal, audit, collect, onStreamError) {
  const assembler = new BlockAssembler();
  let text = "";
  for await (const chunk of ctx.llm.stream(options)) {
    if (STREAM_CHUNK_TYPES.has(chunk.type)) assembler.push(toProtocolChunk(chunk));
    if (chunk.type === "text-delta") text += chunk.text ?? chunk.delta ?? "";
    if (chunk.type === "usage" && audit) {
      const i = chunk.input_tokens ?? chunk.inputTokens ?? chunk.prompt_tokens ?? chunk.promptTokens;
      const o = chunk.output_tokens ?? chunk.outputTokens ?? chunk.completion_tokens ?? chunk.completionTokens;
      if (Number.isFinite(i)) audit.inputTokens = i;
      if (Number.isFinite(o)) audit.outputTokens = o;
    }
    if (chunk.type === "finish") {
      const reasonKind = chunk.reason?.kind ?? chunk.kind;
      if (reasonKind === "error" || reasonKind === "aborted") {
        // 记下失败原因：withEffortFallback 靠它识别"provider 拒收 reasoningEffort"
        // 并自动去掉字段重试（dsh-llm 的 adapterStream 不抛错，只在流尾报错）。
        onStreamError?.(chunk.reason ?? chunk);
        if (audit) { audit.status = "error"; audit.errorMessage = `llm stream ${reasonKind}`; }
        return collect(null);
      }
    }
  }
  const assembled = assembler.blocks().filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  collect(text || assembled);
}

// 全局串行：同一时刻只有一轮蒸馏在跑（跨 session 也串行），一次调用进 GPU 队列。
let queueTail = Promise.resolve();
function enqueue(task) {
  const next = queueTail.then(task, task);
  queueTail = next.catch(() => {});
  return next;
}

export function createSummarizer(ctx, service, config, activity = null) {
  if (!config.autoSummarize) return { dispose: () => {} };
  let disposed = false;
  let inFlightSession = null;
  let pendingRetries = []; // 失败轮次的转录缓冲（上限 3，成功后清空）
  let pendingSessionId = null;

  async function distillOnce(session, transcript) {
    if (disposed) return;
    const header = session.requestHeader?.()?.config;
    const route = (config.summarizeProvider && config.summarizeModel)
      ? { provider: config.summarizeProvider, model: config.summarizeModel }
      : (header?.provider && header?.model)
        ? { provider: header.provider, model: header.model }
        : undefined;
    if (!route) return;

    const topK = Number.isInteger(config.distillInjectTopK) ? config.distillInjectTopK : 10;
    const { picked: injected } = await pickInjection(service, transcript.userText, topK);
    const retryPrefix = pendingSessionId === session.id && pendingRetries.length
      ? `【此前有 ${pendingRetries.length} 轮处理失败，转录一并纳入】\n${pendingRetries.join("\n\n……\n\n")}\n\n【本轮对话】\n`
      : "";
    const userText = `${retryPrefix}${transcript.transcript}`;

    let audit = null;
    if (config?.llmAudit?.enabled !== false && typeof service.saveLlmAudit === "function") {
      audit = { route, timestamp: new Date().toISOString(), startedAt: Date.now(), inputTokens: 0, outputTokens: 0, status: "success", errorMessage: null };
    }
    const options = {
      provider: route.provider,
      model: route.model,
      purpose: "summarization",
      maxTokens: Number.isInteger(config.distillMaxTokens) ? config.distillMaxTokens : 2048,
      messages: [
        { role: "system", content: [{ type: "text", text: SYSTEM_PROMPT }] },
        createUserMessage({ content: [{ type: "text", text: `# 既有相关记忆\n${formatInjected(injected)}\n\n# 本轮对话转录\n${userText}` }] })
      ],
      signal: undefined
    };

    // 思考档位封顶（distillReasoningEffort，默认 none = 完全不干预）。档位是否
    // 被这个模型接受由 resolveDreamEffort 问 harness 决定；provider 在流里拒收
    // 时 withEffortFallback 会去掉字段重试一次——与 dream3 走同一套安全机制。
    const effort = await resolveDreamEffort(ctx, route, config.distillReasoningEffort, ctx.logger);
    let streamFailure = "";
    let text = null;
    const attempt = (withEffort) => {
      streamFailure = "";
      // 每次真实调用都重置审计时钟与状态，回退重试不会把上一次的失败写进账。
      if (audit) { audit.startedAt = Date.now(); audit.status = "success"; audit.errorMessage = null; }
      return streamOnce(
        ctx,
        { ...options, ...(withEffort && effort ? { reasoningEffort: effort } : {}) },
        null,
        audit,
        (t) => { text = t; },
        (reason) => { streamFailure = describeStreamFailure(reason); }
      );
    };

    try {
      await withEffortFallback(ctx, effort, () => attempt(true), () => attempt(false), () => streamFailure);
    } catch (error) {
      if (audit) { audit.status = "error"; audit.errorMessage = String(error?.message ?? error); }
      // 抛错路径同样进重试缓冲：本轮不丢，下轮成功时一并处理。
      if (pendingSessionId !== session.id) { pendingSessionId = session.id; pendingRetries = []; }
      if (pendingRetries.length < 3) pendingRetries.push(transcript.transcript);
      throw error;
    } finally {
      if (audit) {
        try {
          service.saveLlmAudit({
            timestamp: audit.timestamp,
            trigger_source: "autoSummarize",
            operation_type: "summarize_decisions",
            model_id: `${audit.route.provider}:${audit.route.model}`,
            input_tokens: audit.inputTokens,
            output_tokens: audit.outputTokens,
            total_tokens: audit.inputTokens + audit.outputTokens,
            cost_usd: 0,
            duration_ms: Date.now() - audit.startedAt,
            status: audit.status,
            error_message: audit.errorMessage,
            related_memory_ids: injected.map((m) => m.id).filter(Boolean)
          });
        } catch { /* 审计失败不影响主流程 */ }
      }
    }

    const decisions = text === null ? null : parseDecisionsJson(text);
    if (!Array.isArray(decisions)) {
      // 解析失败/流被掐 → 本轮转录进重试缓冲，下轮成功时一并处理；不重复计费。
      if (pendingSessionId !== session.id) { pendingSessionId = session.id; pendingRetries = []; }
      if (pendingRetries.length < 3) pendingRetries.push(transcript.transcript);
      ctx.logger?.warn?.("dsh-mneme distill2: 本轮蒸馏输出不可解析，已转入重试缓冲");
      return;
    }
    const outcome = applyTurnDecisions(decisions, service, ctx.logger, `session:${session.id}`);
    pendingRetries = [];
    pendingSessionId = null;
    if (outcome.skipped.length) {
      ctx.logger?.warn?.(`dsh-mneme distill2: ${outcome.created}c/${outcome.merged}m/${outcome.updated}u, skipped: ${outcome.skipped.join("; ")}`);
    }
  }

  const unsubscribe = ctx.on("session/event", (session, event) => {
    if (disposed || event.type !== "turn/end") return;
    const reasonKind = event?.data?.reason?.kind;
    if (reasonKind === "aborted" || reasonKind === "error") return; // 半截轮次不提炼
    if (inFlightSession === session.id) return;
    const events = session.snapshotEvents?.() ?? session.events ?? [];
    const transcript = buildTurnTranscript(events, config.distillMaxChars ?? 24000);
    if (!transcript.userText.trim()) return; // 本轮没有人类发言：零成本跳过
    const header = session.requestHeader?.()?.config;
    const hasRoute = (config.summarizeProvider && config.summarizeModel)
      || (header?.provider && header?.model);
    if (!hasRoute) return;
    inFlightSession = session.id;
    const endActivity = activity?.begin?.(session.id) ?? (() => {});
    return enqueue(() => distillOnce(session, transcript)).catch((error) => {
      if (!disposed && error?.name !== "AbortError") {
        ctx.logger?.warn?.(`dsh-mneme distill2: summarization failed: ${String(error?.message ?? error)}`);
      }
    }).finally(() => {
      endActivity();
      inFlightSession = null;
    });
  });

  return {
    dispose() {
      disposed = true;
      unsubscribe?.();
    }
  };
}
