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
