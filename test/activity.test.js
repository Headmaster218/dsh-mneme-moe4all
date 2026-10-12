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
