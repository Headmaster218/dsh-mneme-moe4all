import test from "node:test";
import assert from "node:assert/strict";
import { createActivityTracker } from "../src/activity.js";
import { createSummarizer } from "../src/distill2.js";

test("v2 distillation activity spans queued LLM work and clears on completion", async () => {
  let handler;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const activity = createActivityTracker();
  const ctx = {
    on(name, fn) {
      assert.equal(name, "session/event");
      handler = fn;
      return () => {};
    },
    llm: {
      stream() {
        return (async function* () {
          await gate;
          yield { type: "block-start", index: 0, blockType: "text" };
          yield { type: "text-delta", index: 0, text: "[]" };
          yield { type: "block-end", index: 0, block: { type: "text", text: "[]" } };
          yield { type: "finish", reason: { kind: "stop" } };
        })();
      }
    },
    logger: { warn() {} }
  };
  const service = {
    all: () => [],
    saveWithDedupe() { throw new Error("empty decisions must not write memories"); }
  };
  const summarizer = createSummarizer(ctx, service, {
    autoSummarize: true,
    summarizeProvider: "moe4all",
    summarizeModel: "chat",
    distillReasoningEffort: "none",
    llmAudit: { enabled: false }
  }, activity);
  const session = {
    id: "v2-activity-session",
    snapshotEvents: () => [{
      type: "user/message",
      data: { source: { kind: "user" }, content: [{ type: "text", text: "记住这一轮" }] }
    }]
  };

  const running = handler(session, { type: "turn/end", data: { reason: { kind: "stop" } } });
  assert.deepEqual(activity.snapshot().sessions, ["v2-activity-session"]);
  release();
  await running;
  assert.equal(activity.snapshot().active, false);
  summarizer.dispose();
});

test("v2 distillation can be cancelled without storing or retrying the turn", async () => {
  let handler;
  let started;
  let markStarted;
  started = new Promise((resolve) => { markStarted = resolve; });
  const calls = [];
  const writes = [];
  const activity = createActivityTracker();
  const ctx = {
    on(_name, fn) { handler = fn; return () => {}; },
    llm: {
      stream(options) {
        calls.push(options);
        if (calls.length > 1) {
          return (async function* () {
            yield { type: "text-delta", text: "[]" };
            yield { type: "finish", reason: { kind: "stop" } };
          })();
        }
        return (async function* () {
          markStarted();
          await new Promise((resolve, reject) => {
            const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            if (options.signal.aborted) fail();
            else options.signal.addEventListener("abort", fail, { once: true });
          });
        })();
      }
    },
    logger: { warn() {} }
  };
  const service = {
    all: () => [],
    saveWithDedupe(memory) { writes.push(memory); }
  };
  const summarizer = createSummarizer(ctx, service, {
    autoSummarize: true,
    summarizeProvider: "moe4all",
    summarizeModel: "chat",
    distillReasoningEffort: "none",
    llmAudit: { enabled: false }
  }, activity);
  const session = {
    id: "cancel-v2",
    snapshotEvents: () => [{
      type: "user/message",
      data: { source: { kind: "user" }, content: [{ type: "text", text: "不要记住这一轮" }] }
    }]
  };

  const running = handler(session, { type: "turn/end", data: { reason: { kind: "stop" } } });
  await started;
  assert.equal(activity.cancel(session.id), 1);
  await running;
  assert.equal(activity.snapshot().active, false);
  assert.deepEqual(writes, []);

  session.snapshotEvents = () => [{
    type: "user/message",
    data: { source: { kind: "user" }, content: [{ type: "text", text: "下一轮" }] }
  }];
  await handler(session, { type: "turn/end", data: { reason: { kind: "stop" } } });
  assert.equal(calls.length, 2);
  assert.equal(JSON.stringify(calls[1].messages).includes("此前有"), false, "cancelled turns must not enter the retry buffer");
  assert.deepEqual(writes, []);
  summarizer.dispose();
});
