// dream3.js — 簇驱动的记忆整理引擎（本机重写入版，替换上游 dream.js 的调度与逻辑）。
//
// 与上游的三个根本区别：
//   1. 触发是"持久谓词"而非进程内闹钟：pending（上次成功以来新写入的条数）与
//      last_run 持久化在 user_settings kv，服务关机几天后开机照样补跑；条件
//      持续成立时按指数退避轮询重试，失败绝不连发白烧。
//   2. 视野与预算解耦：每次都对全库活跃行做向量聚类找"嫌疑重复簇"（纯本地
//      算术，零 LLM），只把最可疑的少数簇送进一次 LLM 裁决——旧记忆永远在
//      视野内，输入规模与库总量无关，单次请求几十秒内完成（不再撞 300s 掐杀）。
//   3. 已裁决且成员未变的簇永久豁免（dream3_state.clusters 指纹），整理过的
//      不再重复劳动；重新变"脏"只因成员变化或新邻居靠入。
//
// 复用上游 decisions.js 的校验与落地（validateDecisions/applyDecisions：CAS、
// 事务、宽容路径都现成）。审计沿用 dream_runs 表（run_type='auto'），面板的
// dream-status 端点原样可读。
import { randomUUID } from "node:crypto";
import { validateDecisions, applyDecisions } from "./dream/decisions.js";
import { cosineSimilarity } from "./dream/clustering.js";
import { resolveRoute, withEffortFallback, describeStreamFailure, resolveDreamEffort } from "./dream.js";

const STATE_KEY = "dream3_state";
const KV_KEY = "dream3_kv";

// 裁决提示词：只给簇、要求逐簇给决策；允许 []；merge 必须同类型且给 reason。
function buildPrompt(clusters) {
  const blocks = clusters.map((cluster, i) =>
    `## 疑似重复簇 ${i + 1}\n` +
    cluster.map((m) => `id=${m.id} | type=${m.type} | importance=${m.importance} | updated=${m.updated_at} | title=${m.title} | content=${m.content}`).join("\n")
  ).join("\n\n");
  return `你是记忆库整理员。下面每个"簇"里的记忆经向量判定彼此相似，需要你逐簇裁决。只输出一个 JSON 数组（不是记忆正文，而是操作决策），无问题的簇不必输出（视为 keep）。
可用动作：
1. {"action":"merge","ids":["id1","id2"],"keepSource":"保留条的id","title":"合并后标题","content":"合并后正文","importance":1-5} —— 同一事实的多条重复，合并为一条；ids 必须全部来自同一个簇；keepSource 必须是 ids 之一；importance 取组内最高或更高。
2. {"action":"archive","ids":["id"],"reason":"依据（只允许：与同簇某条重复 / 明显过时）"} —— 冗余或过时才归档；这是价值判断禁区：不得因"价值低/一次性细节"归档。
3. {"action":"update","ids":["单条id"],"content":"修正后正文","reason":"矛盾点"} —— 簇内互相矛盾且新事实明确时改写（不归档任何一方）。
4. {"action":"conflict","winner":"较可信id","loser":"被否决id"} —— 直接矛盾、必须二选一时。
约束：不许跨簇引用 id；一条 id 只能出现在一个决策里；拿不准就不输出（keep）。只输出 JSON 数组。

${blocks}`;
}

function loadState(settings) {
  try {
    const raw = settings.getKV(STATE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.clusters)) return parsed;
    }
  } catch { /* 状态损坏：重新开始 */ }
  return { clusters: [], stats: { runs: 0, merged: 0, archived: 0, exempt_skips: 0 } };
}
function saveState(settings, state) {
  try { settings.setKV(STATE_KEY, JSON.stringify(state)); } catch { /* 尽力而为 */ }
}
function loadKv(settings) {
  try {
    const raw = settings.getKV(KV_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return { pending: 0, fails: 0, ...parsed };
    }
  } catch { /* 重新开始 */ }
  return { pending: 0, fails: 0 };
}
function saveKv(settings, kv) {
  try { settings.setKV(KV_KEY, JSON.stringify(kv)); } catch { /* 尽力而为 */ }
}

// 并查集式聚类：相似度达标的活跃同类型行并入同簇。O(n²) 余弦，千行毫秒级。
export function findDuplicateClusters(memories, vectors, threshold) {
  const n = memories.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < n; i++) {
    if (!vectors[i]) continue;
    for (let j = i + 1; j < n; j++) {
      if (!vectors[j]) continue;
      if (memories[i].type !== memories[j].type) continue;
      if (cosineSimilarity(vectors[i], vectors[j]) >= threshold) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(memories[i]);
  }
  return [...groups.values()].filter((g) => g.length >= 2);
}

const fingerprint = (cluster) => cluster.map((m) => `${m.id}:${m.updated_at ?? m.content?.length ?? 0}`).sort().join("|");

// 归档理由护栏（#104 教训）：本引擎只授权 merge/archive/conflict/update，且
// archive 必须带非空 reason——价值判断型"顺手大扫除"在提示词与代码层都拒绝。
function retainDecisions(decisions) {
  return decisions.filter((d) => {
    if (!d || !["merge", "archive", "conflict", "update"].includes(d.action)) return false;
    if (d.action === "archive") return typeof d.reason === "string" && d.reason.trim().length > 0;
    return true;
  });
}

export function createDream3({ ctx, service, config, settings, semantic }) {
  const state = loadState(settings);
  let kv = loadKv(settings);
  let running = false;
  let disposed = false;
  let lastAttempt = 0;
  let timer = null;
  let inFlight = null;
  let lastActivityAt = 0;

  const thresholdCount = Math.max(1, config.dreamV2ThresholdCount ?? 20);
  const maxAgeMs = Math.max(1, config.dreamV2MaxAgeHours ?? 72) * 3600000;
  const idleMs = Math.max(0, config.dreamV2IdleMinutes ?? 2) * 60000;
  const maxClusters = Math.max(1, config.dreamV2MaxClusters ?? 8);
  const clusterThreshold = config.dreamV2ClusterThreshold ?? 0.82;
  const maxPairs = config.dreamV2MaxPairs ?? 0; // >0 时限制全库 O(n²) 扫描成本

  function shouldFire() {
    if (disposed || running || !config.autoDream) return false;
    if (idleMs > 0 && Date.now() - lastActivityAt < idleMs) return false; // 用户正忙：让路
    const backoffMs = Math.min(2 ** (kv.fails ?? 0), 48) * 30 * 60000; // 失败退避 30m→封顶 24h
    const age = Date.now() - (kv.last_run ? Date.parse(kv.last_run) : 0);
    if ((kv.pending ?? 0) >= thresholdCount) return true; // 条数油门：不受退避限制
    if ((kv.pending ?? 0) >= 1 && age >= maxAgeMs) return Date.now() - lastAttempt >= backoffMs;
    return false;
  }

  function pendingCount() {
    // pending = 上次成功以来新写入的条数。用 created_at 与 last_run 比较即可，
    // 无需额外游标；无 last_run（首次）时取全库活跃行数（首轮即自动消化存量）。
    const since = kv.last_run ? Date.parse(kv.last_run) : 0;
    return service.all().filter((m) => !m.archived && m.type !== "summary" && (!since || Date.parse(m.created_at ?? "") > since)).length;
  }

  function schedule(delay = 15000) {
    if (disposed || timer) return;
    timer = setTimeout(() => {
      timer = null;
      kv.pending = pendingCount();
      if (!shouldFire()) {
        saveKv(settings, kv);
        schedule(Math.max(delay, 30000));
        return;
      }
      lastAttempt = Date.now();
      running = true;
      inFlight = Promise.resolve()
        .then(() => runRun())
        .catch((e) => { ctx.logger?.warn?.(`dsh-mneme dream3: ${String(e?.message ?? e)}`); })
        .finally(() => { running = false; inFlight = null; });
    }, delay);
    if (typeof timer.unref === "function") timer.unref();
  }

  async function collectVectors(memories) {
    const { embedder, vectorIndex } = semantic ?? {};
    if (!embedder || typeof embedder.embedSingle !== "function") return null;
    const vectors = new Array(memories.length);
    const missing = [];
    for (let i = 0; i < memories.length; i++) {
      const cached = vectorIndex?.getEmbedding?.(memories[i].id);
      if (cached) vectors[i] = cached; else missing.push(i);
    }
    // 缺向量的行逐条补嵌（本地小模型毫秒级；失败只影响覆盖度，不阻断）。
    for (const i of missing) {
      try {
        const v = await embedder.embedSingle([memories[i].title, memories[i].content].filter(Boolean).join("\n"));
        if (Array.isArray(v) && v.length) { vectors[i] = v; vectorIndex?.saveEmbedding?.(memories[i].id, v); }
      } catch { /* 端点不可达：本轮该行进不了簇 */ }
    }
    return vectors;
  }

  async function runRun() {
    const route = resolveRoute(ctx, config, ctx.logger);
    if (!route) { kv.fails = (kv.fails ?? 0) + 1; saveKv(settings, kv); return { ok: false }; }
    const startedAt = Date.now();
    const memories = service.all().filter((m) => !m.archived && m.type !== "summary" && m.id);
    const runId = randomUUID();
    const vectors = await collectVectors(memories);
    let clusters = [];
    if (vectors) {
      // 规模护栏：默认关（0=全库 O(n²)，千行毫秒级）；开启时按 updated_at
      // 保留最近前缀，向量按 id 对齐重建。
      let scanMemories = memories;
      let scanVectors = vectors;
      if (maxPairs > 0 && (memories.length * (memories.length - 1)) / 2 > maxPairs) {
        const keep = Math.ceil(Math.sqrt(maxPairs * 2));
        const order = memories
          .map((m, i) => ({ m, i }))
          .sort((a, b) => String(b.m.updated_at ?? "").localeCompare(String(a.m.updated_at ?? "")))
          .slice(0, keep);
        scanMemories = order.map((x) => x.m);
        scanVectors = order.map((x) => vectors[x.i]);
      }
      clusters = findDuplicateClusters(scanMemories, scanVectors, clusterThreshold);
    }
    // 豁免：指纹与既有已裁决簇完全一致的不再送审。
    const exempt = new Set(state.clusters.map((c) => c.fp));
    const fresh = clusters.filter((c) => {
      const fp = fingerprint(c);
      if (exempt.has(fp)) { state.stats.exempt_skips++; return false; }
      return true;
    });
    // 预算：按"更新者优先"挑 ≤ maxClusters 个簇（新簇成员较新，前沿语义）。
    fresh.sort((a, b) => {
      const na = Math.max(...a.map((m) => String(m.updated_at ?? "")));
      const nb = Math.max(...b.map((m) => String(m.updated_at ?? "")));
      return na < nb ? 1 : -1;
    });
    const chosen = fresh.slice(0, maxClusters);
    if (chosen.length === 0) {
      // 无可疑簇：谓词归零（零 LLM 消耗），并记一次空跑时间戳。
      kv = { pending: 0, fails: 0, last_run: new Date().toISOString() };
      saveKv(settings, kv);
      return { ok: true, applied: 0, skipped: true };
    }
    const snapshot = new Map(chosen.flat().map((m) => [m.id, m]));
    const prompt = buildPrompt(chosen);
    const effort = await resolveDreamEffort(ctx, route, config.dreamReasoningEffort, ctx.logger);
    let streamFailure = "";
    let decisions = null;
    const attempt = (withEffort) => streamJson(ctx, config, {
      provider: route.provider,
      model: route.model,
      ...(withEffort && effort ? { reasoningEffort: effort } : {}),
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }]
    }, (reason) => { streamFailure = describeStreamFailure(reason); }, (arr) => { decisions = arr; });
    let decisionText;
    try {
      decisionText = await withEffortFallback(ctx, effort, () => attempt(true), () => attempt(false), () => streamFailure);
    } catch (error) {
      finish({ ok: false, error: `llm failed: ${String(error?.message ?? error)}` }, runId, snapshot, startedAt);
      kv.fails = (kv.fails ?? 0) + 1; saveKv(settings, kv);
      return { ok: false };
    }
    if (decisionText === undefined) {
      finish({ ok: false, error: streamFailure ? `llm stream failed (${streamFailure})` : "llm stream failed" }, runId, snapshot, startedAt);
      kv.fails = (kv.fails ?? 0) + 1; saveKv(settings, kv);
      return { ok: false };
    }
    if (!Array.isArray(decisions)) decisions = extractJsonArray(decisionText);
    if (!Array.isArray(decisions)) {
      finish({ ok: false, error: "no json array in llm output" }, runId, snapshot, startedAt);
      kv.fails = (kv.fails ?? 0) + 1; saveKv(settings, kv);
      return { ok: false };
    }
    decisions = retainDecisions(decisions);
    const { ok, errors, skipped } = validateDecisions(decisions, snapshot, {
      skipInvalid: config.dreamSkipInvalid !== false,
      maxUpdatePerRun: 6, // 8 簇 × 2-3 条：上游默认 2 过紧
      minAgeHours: 0, // 本地库不做 24h 保护期
      dreamImplicitKeep: true, // 未提及 = keep；截断输出已在 parse 层拒绝
      dreamMinExplicitCoverage: 0,
      allowCrossTypeMerge: false
    });
    if (!ok) {
      finish({ ok: false, error: `invalid decisions: ${errors.join("; ")}`, decisions }, runId, snapshot, startedAt);
      kv.fails = (kv.fails ?? 0) + 1; saveKv(settings, kv);
      return { ok: false };
    }
    if (skipped?.length) ctx.logger?.warn?.(`dsh-mneme dream3: skipped ${skipped.length} invalid decisions`);
    const result = applyDecisions(decisions, service, ctx.logger, snapshot, config);
    // 豁免语义（设计核心）：一次成功裁决覆盖本批全部送审簇——模型未提及即
    // keep（隐式 keep 也是裁决）；唯独应用失败/CAS 冲突涉及的簇保持可疑身份、
    // 下轮重新入审。不可按"committed 是否触及"判定：隐式 keep 会让每个簇都
    // "被触及"，而空数组整体确认（全 keep）又会让干净簇永不豁免，两头都错。
    const suspect = new Set([...(result.failures ?? []), ...(result.conflicts ?? [])].flatMap((f) => f.ids ?? []));
    for (const cluster of chosen) {
      if (!cluster.some((m) => suspect.has(m.id))) state.clusters.push({ fp: fingerprint(cluster), run: runId });
    }
    // 豁免表防膨胀：只保留成员仍然活跃的指纹。
    const live = new Set(memories.map((m) => m.id));
    state.clusters = state.clusters.filter((c) => c.fp.split("|").some((part) => live.has(part.split(":")[0])));
    state.stats.runs++;
    state.stats.merged += decisions.filter((d) => d.action === "merge").length;
    state.stats.archived += decisions.filter((d) => d.action === "archive").length;
    saveState(settings, state);
    finish({
      ok: true,
      applied: result.applied,
      decisions,
      outcome: { conflicts: result.conflicts, failures: result.failures }
    }, runId, snapshot, startedAt);
    kv = { pending: 0, fails: 0, last_run: new Date().toISOString() };
    saveKv(settings, kv);
    return { ok: true, applied: result.applied };
  }

  function finish(result, runId, snapshot, startedAt) {
    try {
      service.saveDreamRun({
        id: runId,
        status: result.ok ? (result.skipped ? "noop" : "ok") : "failed",
        error: result.error,
        snapshot_hash: `dream3:${snapshot.size}`,
        input_count: snapshot.size,
        input: [...snapshot.values()].map((m) => ({
          id: m.id, type: m.type, title: m.title,
          content: m.content?.slice(0, 400), importance: m.importance, updated_at: m.updated_at
        })),
        decisions: result.decisions,
        outcome: result.outcome,
        applied: result.applied ?? 0,
        summary_stored: false,
        receipt: `dream3-run ${runId.slice(0, 8)} at ${new Date(startedAt).toISOString()} +${Date.now() - startedAt}ms`,
        run_type: "auto"
      });
    } catch { /* 审计不阻断 */ }
    try {
      service.saveLlmAudit?.({
        timestamp: new Date(startedAt).toISOString(),
        trigger_source: "autoDream",
        operation_type: "dream_consolidate",
        model_id: "dream3",
        input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: 0,
        duration_ms: Date.now() - startedAt,
        status: result.ok ? "success" : "error",
        error_message: result.error ?? null,
        related_memory_ids: [...snapshot.keys()]
      });
    } catch { /* 同上 */ }
  }

  schedule(); // 开机检查点：谓词若成立，等用户空闲后自动补跑

  return {
    noteActivity() { lastActivityAt = Date.now(); },
    maybeSchedule() {
      kv = loadKv(settings); // 外部（手动按钮/其它进程）可能已改库
      schedule(Math.max(2000, config.dreamDelayMs ?? 2000));
    },
    async runNow() {
      if (running) return { ok: false, error: "already running" };
      running = true;
      try { return await runRun(); } finally { running = false; }
    },
    getStatus() {
      return { engine: "dream3", pending: kv.pending ?? 0, fails: kv.fails ?? 0, last_run: kv.last_run ?? null, stats: state.stats, running };
    },
    async dispose() {
      disposed = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (inFlight) await inFlight.catch(() => {});
    }
  };
}

// —— 流式调用 + JSON 抽取（沿用上游 dream.js 的消耗约定：finish chunk 的
//    error/aborted 视为失败，绝不把半截 JSON 当成有效决策）——
function extractJsonArray(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const cleaned = text.replace(/```(?:json)?\s*([\s\S]*?)```/gi, "$1").trim();
  const start = cleaned.indexOf("[");
  if (start === -1) return null;
  for (let end = cleaned.lastIndexOf("]"); end > start; end = cleaned.lastIndexOf("]", end - 1)) {
    try {
      const parsed = JSON.parse(cleaned.slice(start, end + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch { /* 继续收缩右边界 */ }
  }
  return null;
}

async function streamJson(ctx, config, options, onStreamError, onDecisions) {
  let text = "";
  let failure = null;
  try {
    for await (const chunk of ctx.llm.stream({ purpose: "compaction", maxTokens: config.dreamMaxTokens ?? 8192, ...options })) {
      if (chunk.type === "text-delta") text += chunk.text ?? chunk.delta ?? "";
      if (chunk.type === "finish") {
        const kind = chunk.reason?.kind ?? chunk.kind;
        if (kind === "error" || kind === "aborted") { failure = chunk.reason ?? chunk; onStreamError?.(failure); break; }
      }
    }
  } catch (error) {
    onStreamError?.(error);
    throw error;
  }
  if (failure) return undefined;
  const arr = extractJsonArray(text);
  if (Array.isArray(arr)) onDecisions?.(arr);
  return text;
}