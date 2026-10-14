import test from "node:test";
import assert from "node:assert/strict";
import { createActivityTracker } from "../src/activity.js";

test("activity tracker spans queued work and clears each session exactly once", () => {
  const activity = createActivityTracker();
  const endA1 = activity.begin("a");
  const endA2 = activity.begin("a");
  const endB = activity.begin("b");
  assert.deepEqual(activity.snapshot(), {
    active: true,
    tasks: 3,
    sessions: ["a", "b"],
    revision: 3
  });
  endA1();
  endA1();
  endB();
  assert.deepEqual(activity.snapshot(), {
    active: true,
    tasks: 1,
    sessions: ["a"],
    revision: 5
  });
  endA2();
  assert.deepEqual(activity.snapshot(), {
    active: false,
    tasks: 0,
    sessions: [],
    revision: 6
  });
});

test("activity tracker cancels every task in one session exactly once", () => {
  const activity = createActivityTracker();
  const cancelled = [];
  const endA1 = activity.begin("a", () => cancelled.push("a1"));
  const endA2 = activity.begin("a", () => cancelled.push("a2"));
  const endB = activity.begin("b", () => cancelled.push("b"));

  assert.equal(activity.cancel("a"), 2);
  assert.deepEqual(cancelled, ["a1", "a2"]);
  assert.equal(activity.cancel("a"), 0, "repeated cancellation must be idempotent");
  assert.deepEqual(activity.snapshot().sessions, ["a", "b"]);

  endA1();
  endA2();
  endB();
  assert.equal(activity.snapshot().active, false);
});
