import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const { default: worker } = await import("../src/index.js");

class FakeStatement {
  constructor(db, sql) { this.db = db; this.sql = sql.replace(/\s+/g, " ").trim(); this.args = []; }
  bind(...args) { this.args = args; return this; }
  async first() {
    const s = this.sql;
    if (s.startsWith("SELECT c.*") && s.includes("WHERE c.conversation_id = ?")) return this.db.conversationRow(this.args[0]);
    if (s.startsWith("SELECT agent_id FROM agents")) return this.db.agents.get(this.args[0]) || null;
    if (s.startsWith("SELECT * FROM tasks")) return null;
    return null;
  }
  async all() {
    const s = this.sql;
    if (s.startsWith("SELECT agent_id FROM agents WHERE agent_id IN")) return { results: this.args.map((id) => this.db.agents.get(id)).filter(Boolean).map((row) => ({ agent_id: row.agent_id })) };
    if (s.startsWith("SELECT agent_id, name, type")) return { results: [...this.db.agents.values()] };
    if (s.startsWith("SELECT c.*")) return { results: [...this.db.conversations.values()].filter((row) => !s.includes("WHERE c.archived_at") || !row.archived_at).map((row) => this.db.conversationRow(row.conversation_id)) };
    if (s.startsWith("SELECT event_id")) return { results: [...this.db.events].filter((row) => row.conversation_id === this.args[0]) };
    if (s.startsWith("SELECT message_id")) return { results: [] };
    if (s.startsWith("SELECT approval_id")) return { results: [] };
    return { results: [] };
  }
  async run() {
    const s = this.sql;
    if (s.startsWith("INSERT INTO agents")) {
      const [agent_id, name, type, role, capabilities_json, created_at, updated_at] = this.args;
      if (this.db.agents.has(agent_id)) throw new Error("UNIQUE agents.agent_id");
      this.db.agents.set(agent_id, { agent_id, name, type, role, capabilities_json, status: "registered", last_heartbeat_at: null, current_task_id: null, created_at, updated_at });
      return { meta: { changes: 1 } };
    }
    if (s.startsWith("INSERT INTO conversations")) {
      const [conversation_id, name, goal, max_rounds, round_delay_seconds, poll_interval_seconds, active_hours_json, timezone, require_approval, next_run_at, created_at, updated_at, last_activity_at] = this.args;
      if (this.db.conversations.has(conversation_id)) throw new Error("UNIQUE conversations.conversation_id");
      this.db.conversations.set(conversation_id, { conversation_id, name, goal, state: "stopped", max_rounds, round_delay_seconds, poll_interval_seconds, active_hours_json, timezone, require_approval, next_run_at, created_at, updated_at, last_activity_at, archived_at: null });
      return { meta: { changes: 1 } };
    }
    if (s.startsWith("INSERT INTO conversation_agents")) { if (this.db.failMemberAgent === this.args[1]) throw new Error("simulated participant insert failure"); this.db.members.push({ conversation_id: this.args[0], agent_id: this.args[1], role: this.args[2] }); return { meta: { changes: 1 } }; }
    if (s.startsWith("INSERT INTO audit_events")) { this.db.events.push({ event_id: this.args[0], conversation_id: this.args[1], actor: this.args[2], event_type: this.args[3], payload_json: this.args[4], created_at: this.args[5] }); return { meta: { changes: 1 } }; }
    if (s.startsWith("INSERT INTO agent_heartbeats")) return { meta: { changes: 1 } };
    if (s.startsWith("UPDATE conversations SET state")) { const row = this.db.conversations.get(this.args[3]); if (!row || !["stopped", "running", "paused", "archived"].includes(this.args[0])) return { meta: { changes: 0 } }; row.state = this.args[0]; row.updated_at = this.args[1]; row.last_activity_at = this.args[2]; return { meta: { changes: 1 } }; }
    if (s.startsWith("UPDATE conversations SET name")) { const row = this.db.conversations.get(this.args[12]); Object.assign(row, { name: this.args[0], goal: this.args[1], state: this.args[2], max_rounds: this.args[3], round_delay_seconds: this.args[4], poll_interval_seconds: this.args[5], active_hours_json: this.args[6], timezone: this.args[7], require_approval: this.args[8], next_run_at: this.args[9], archived_at: this.args[10], updated_at: this.args[11] }); return { meta: { changes: 1 } }; }
    if (s.startsWith("UPDATE agents SET status")) { const row = this.db.agents.get(this.args[4]); if (!row) return { meta: { changes: 0 } }; Object.assign(row, { status: this.args[0], last_heartbeat_at: this.args[1], current_task_id: this.args[2], updated_at: this.args[3] }); return { meta: { changes: 1 } }; }
    return { meta: { changes: 1 } };
  }
}

class FakeD1 {
  constructor() { this.agents = new Map(); this.conversations = new Map(); this.members = []; this.events = []; this.failMemberAgent = null; }
  prepare(sql) { return new FakeStatement(this, sql); }
  async batch(statements) {
    const agents = new Map(this.agents); const conversations = new Map(this.conversations); const members = [...this.members]; const events = [...this.events];
    try { const results = []; for (const statement of statements) results.push(await statement.run()); return results; }
    catch (error) { this.agents = agents; this.conversations = conversations; this.members = members; this.events = events; throw error; }
  }
  conversationRow(id) { const row = this.conversations.get(id); if (!row) return null; return { ...row, agents_json: JSON.stringify(this.members.filter((item) => item.conversation_id === id).map((item) => item.agent_id)) }; }
}

function env() { return { DB: new FakeD1(), MANAGEMENT_PASSWORD: "unit-admin-fixture", AGENT_KEYS: JSON.stringify({ "codex-local-01": "unit-agent-fixture" }) }; }
async function call(path, options, bindings) { return worker.fetch(new Request(`https://relay.test${path}`, options), bindings); }
async function body(response) { return response.json(); }

test("management API keeps auth separate and persists conversation state", async () => {
  const bindings = env();
  let response = await call("/api/conversations", { method: "GET" }, bindings);
  assert.equal(response.status, 401);
  const admin = { "X-Relay-Admin": "unit-admin-fixture", "Content-Type": "application/json" };
  response = await call("/api/agents", { method: "POST", headers: admin, body: JSON.stringify({ agent_id: "codex-local-01", name: "Local Codex", role: "executor" }) }, bindings);
  assert.equal(response.status, 201);
  response = await call("/api/conversations", { method: "POST", headers: admin, body: JSON.stringify({ conversation_id: "test-conversation", name: "测试对话", goal: "只读分析", agents: ["codex-local-01"] }) }, bindings);
  assert.equal(response.status, 201);
  assert.equal((await body(response)).conversation.state, "stopped");
  response = await call("/api/conversations/test-conversation/start", { method: "POST", headers: admin }, bindings);
  assert.equal(response.status, 200); assert.equal((await body(response)).state, "running");
  response = await call("/api/conversations/test-conversation/pause", { method: "POST", headers: admin }, bindings);
  assert.equal(response.status, 200); assert.equal((await body(response)).state, "paused");
  response = await call("/api/conversations/test-conversation/resume", { method: "POST", headers: admin }, bindings);
  assert.equal(response.status, 200); assert.equal((await body(response)).state, "running");
  response = await call("/api/conversations/test-conversation/stop", { method: "POST", headers: admin }, bindings);
  assert.equal(response.status, 200); assert.equal((await body(response)).state, "stopped");
  response = await call("/api/conversations/test-conversation", { method: "PATCH", headers: admin, body: JSON.stringify({ archived: true }) }, bindings);
  assert.equal(response.status, 200); assert.equal((await body(response)).conversation.state, "archived");
  response = await call("/api/conversations/test-conversation/start", { method: "POST", headers: admin }, bindings);
  assert.equal(response.status, 409);
});

test("agent heartbeat requires its own credential and real registration", async () => {
  const bindings = env();
  const admin = { "X-Relay-Admin": "unit-admin-fixture", "Content-Type": "application/json" };
  await call("/api/agents", { method: "POST", headers: admin, body: JSON.stringify({ agent_id: "codex-local-01" }) }, bindings);
  let response = await call("/api/agent/heartbeat", { method: "POST", headers: { "X-Agent-Key": "wrong", "Content-Type": "application/json" }, body: JSON.stringify({ agent_id: "codex-local-01" }) }, bindings);
  assert.equal(response.status, 401);
  response = await call("/api/agent/heartbeat", { method: "POST", headers: { "X-Agent-Key": "unit-agent-fixture", "Content-Type": "application/json" }, body: JSON.stringify({ agent_id: "codex-local-01", status: "online" }) }, bindings);
  assert.equal(response.status, 200); assert.equal((await body(response)).status, "online");
});

test("legacy health and CORS preflight remain available", async () => {
  const bindings = env();
  let response = await call("/health", { method: "GET", headers: { Origin: "https://zhaozw-szu.github.io" } }, bindings);
  assert.equal(response.status, 200); assert.equal((await body(response)).ok, true);
  response = await call("/api/agents", { method: "OPTIONS", headers: { Origin: "https://zhaozw-szu.github.io", "Access-Control-Request-Headers": "x-relay-admin" } }, bindings);
  assert.equal(response.status, 204); assert.match(response.headers.get("Access-Control-Allow-Headers"), /X-Relay-Admin/);
});

test("conversation creation validates agents and rolls back all participants atomically", async () => {
  const bindings = env();
  const admin = { "X-Relay-Admin": "unit-admin-fixture", "Content-Type": "application/json" };
  for (const agent_id of ["codex-local-01", "cloud-chatgpt-01"]) await call("/api/agents", { method: "POST", headers: admin, body: JSON.stringify({ agent_id }) }, bindings);
  bindings.DB.failMemberAgent = "cloud-chatgpt-01";
  let response = await call("/api/conversations", { method: "POST", headers: admin, body: JSON.stringify({ conversation_id: "partial-conversation", name: "Partial", agents: ["codex-local-01", "cloud-chatgpt-01"] }) }, bindings);
  assert.equal(response.status, 409);
  assert.equal(bindings.DB.conversations.has("partial-conversation"), false);
  assert.equal(bindings.DB.members.some((member) => member.conversation_id === "partial-conversation"), false);
  response = await call("/api/conversations", { method: "POST", headers: admin, body: JSON.stringify({ conversation_id: "missing-agent", name: "Missing", agents: ["codex-local-01", "not-registered"] }) }, bindings);
  assert.equal(response.status, 400);
});
