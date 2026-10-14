import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createApi } from "../src/api.js";

class FakeRes extends EventEmitter {
  constructor() { super(); this.statusCode = 200; this.body = ""; }
  writeHead(code) { this.statusCode = code; return this; }
  end(text) { this.body = text ?? ""; this.emit("end"); return this; }
}

test("GET /api/dsh-mneme/activity reports live distillation state", async () => {
  const routes = [];
  const activity = { snapshot: () => ({ active: true, tasks: 1, sessions: ["s1"], revision: 2 }) };
  const ctx = { webServer: { register(route) { routes.push(route); return () => {}; } } };
  const service = {};
  const settings = { getFeatureFlags: () => ({}) };
  const commands = { add() {}, remove() {}, list() { return []; } };
  createApi(ctx, service, settings, commands, null, undefined, "", null, activity);
  const response = new FakeRes();
  const request = { method: "GET", url: "/api/dsh-mneme/activity", headers: {} };
  await routes.find((route) => route.path === request.url).handler(request, response);
  assert.deepEqual(JSON.parse(response.body), activity.snapshot());
});

test("POST /api/dsh-mneme/activity cancels only the requested session", async () => {
  const routes = [];
  const cancelled = [];
  const activity = {
    cancel(sessionId) { cancelled.push(sessionId); return 1; },
    snapshot: () => ({ active: false, tasks: 0, sessions: [], revision: 4 })
  };
  const ctx = { webServer: { register(route) { routes.push(route); return () => {}; } } };
  const settings = { getFeatureFlags: () => ({}) };
  const commands = { add() {}, remove() {}, list() { return []; } };
  createApi(ctx, {}, settings, commands, null, undefined, "", null, activity);

  const request = new EventEmitter();
  request.method = "POST";
  request.url = "/api/dsh-mneme/activity";
  request.headers = { "content-type": "application/json" };
  const response = new FakeRes();
  const pending = routes.find((route) => route.path === request.url).handler(request, response);
  request.emit("data", JSON.stringify({ sessionId: "s1" }));
  request.emit("end");
  await pending;

  assert.deepEqual(cancelled, ["s1"]);
  assert.deepEqual(JSON.parse(response.body), { cancelled: 1, activity: activity.snapshot() });
});
