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
