import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const { default: worker } = await import("../src/index.js");

class SQLiteD1 {
  constructor(database) { this.database = database; this.failMessageIndex = false; }
  prepare(sql) { return new SQLiteStatement(this.database, sql, this); }
  batch(statements) {
    this.database.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.runSync());
      this.database.exec("COMMIT");
      return Promise.resolve(results);
    } catch (error) {
      this.database.exec("ROLLBACK");
      return Promise.reject(error);
    }
  }
}

class SQLiteStatement {
  constructor(database, sql, owner) { this.database = database; this.sql = sql; this.owner = owner; this.args = []; }
  bind(...args) {
    const placeholders = (this.sql.match(/\?/g) || []).length;
    if (placeholders !== args.length) throw new Error(`SQLite bind mismatch: expected ${placeholders}, received ${args.length}: ${this.sql}`);
    this.args = args;
    return this;
  }
  runSync() {
    if (this.owner.failMessageIndex && this.sql.trim().startsWith("INSERT OR IGNORE INTO message_index")) throw new Error("simulated message index failure");
    const result = this.database.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(result.changes) } };
  }
  async run() { return this.runSync(); }
  async first() { return this.database.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return { results: this.database.prepare(this.sql).all(...this.args) }; }
}

function makeDatabase() {
  const database = new DatabaseSync(":memory:");
  for (const name of ["0001_control_center.sql", "0002_task_execution.sql", "0003_result_idempotency.sql", "0004_message_outbox.sql"]) {
    database.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  database.exec("INSERT INTO agents (agent_id, name, type, role, created_at, updated_at) VALUES ('codex-local-01', 'Codex', 'local', 'executor', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'), ('cloud-chatgpt-01', 'Cloud', 'cloud', 'planner', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')");
  database.exec("INSERT INTO conversations (conversation_id, name, state, created_at, updated_at, last_activity_at) VALUES ('sqlite-conversation', 'SQLite', 'running', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')");
  database.exec("INSERT INTO conversation_agents (conversation_id, agent_id, role) VALUES ('sqlite-conversation', 'codex-local-01', 'executor'), ('sqlite-conversation', 'cloud-chatgpt-01', 'planner')");
  return database;
}

const admin = { "X-Relay-Admin": "sqlite-admin", "Content-Type": "application/json" };
const agent = { "X-Agent-Key": "sqlite-agent", "Content-Type": "application/json" };
function bindings(database) { return { DB: new SQLiteD1(database), MANAGEMENT_PASSWORD: "sqlite-admin", AGENT_KEYS: JSON.stringify({ "codex-local-01": "sqlite-agent" }) }; }
async function call(path, options, env) { return worker.fetch(new Request(`https://relay.test${path}`, options), env); }

function githubFetchFixture({ putMode = "success" } = {}) {
  const files = new Map();
  const calls = [];
  let mode = putMode;
  const fetch = async (input, options = {}) => {
    const url = new URL(input);
    const path = decodeURIComponent(url.pathname.split("/contents/")[1] || "");
    calls.push({ method: options.method || "GET", path });
    if ((options.method || "GET") === "PUT") {
      const body = JSON.parse(options.body);
      if (mode === "503") return new Response(JSON.stringify({ message: "busy" }), { status: 503, headers: { "Content-Type": "application/json" } });
      files.set(path, body.content);
      if (mode === "response-lost") throw new TypeError("response connection lost");
      return new Response(JSON.stringify({ content: { path } }), { status: 201, headers: { "Content-Type": "application/json" } });
    }
    if (!files.has(path)) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ content: files.get(path), encoding: "base64", path }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { fetch, files, calls, setMode(nextMode) { mode = nextMode; } };
}

async function createClaimedTask(env, idempotencyKey) {
  const created = await (await call("/api/conversations/sqlite-conversation/tasks", { method: "POST", headers: admin, body: JSON.stringify({ target_agent_id: "codex-local-01", instruction: "inspect files", idempotency_key: idempotencyKey }) }, env)).json();
  const claimed = await (await call("/api/agent/claim", { method: "POST", headers: agent, body: JSON.stringify({ agent_id: "codex-local-01" }) }, env)).json();
  await call(`/api/agent/tasks/${claimed.task.task_id}/ack`, { method: "POST", headers: agent, body: JSON.stringify({ agent_id: "codex-local-01", lease_token: claimed.task.lease_token }) }, env);
  return { taskId: created.task.task_id, claimed };
}

test("real SQLite persists result fields, validates SQL parameters, and makes result retry idempotent", async () => {
  const database = makeDatabase();
  try {
    const env = bindings(database);
    let response = await call("/api/conversations", { method: "POST", headers: admin, body: JSON.stringify({ conversation_id: "sqlite-created", name: "Created", agents: ["codex-local-01", "cloud-chatgpt-01"] }) }, env);
    assert.equal(response.status, 201);
    response = await call("/api/conversations/sqlite-conversation/tasks", { method: "POST", headers: admin, body: JSON.stringify({ target_agent_id: "codex-local-01", instruction: "await approval", task_type: "code_change", sandbox_mode: "workspace-write", idempotency_key: "sqlite-approval" }) }, env);
    assert.equal(response.status, 201);
    response = await call("/api/conversations/sqlite-conversation/tasks", { method: "POST", headers: admin, body: JSON.stringify({ target_agent_id: "codex-local-01", instruction: "inspect files", idempotency_key: "sqlite-result" }) }, env);
    assert.equal(response.status, 201);
    const created = await response.json();
    const taskId = created.task.task_id;
    const claimed = await (await call("/api/agent/claim", { method: "POST", headers: agent, body: JSON.stringify({ agent_id: "codex-local-01" }) }, env)).json();
    assert.equal(claimed.task.task_id, taskId);
    response = await call(`/api/agent/tasks/${taskId}/ack`, { method: "POST", headers: agent, body: JSON.stringify({ agent_id: "codex-local-01", lease_token: claimed.task.lease_token }) }, env);
    assert.equal(response.status, 200);
    const resultPayload = { agent_id: "codex-local-01", lease_token: claimed.task.lease_token, result_id: "sqlite-result-1", status: "succeeded", result_summary: "SQLite result persisted", result: { answer: 42 } };
    response = await call(`/api/agent/tasks/${taskId}/result`, { method: "POST", headers: agent, body: JSON.stringify(resultPayload) }, env);
    assert.equal(response.status, 200);
    const persisted = database.prepare("SELECT result_id, result_summary, finished_at, execution_state, result_json FROM tasks WHERE task_id = ?").get(taskId);
    assert.equal(persisted.result_id, "sqlite-result-1");
    assert.equal(persisted.result_summary, "SQLite result persisted");
    assert.ok(persisted.finished_at);
    assert.equal(persisted.execution_state, "succeeded");
    assert.deepEqual(JSON.parse(persisted.result_json), { answer: 42 });
    response = await call(`/api/agent/tasks/${taskId}/result`, { method: "POST", headers: agent, body: JSON.stringify(resultPayload) }, env);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).idempotent_replay, true);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM tasks WHERE task_id = ?").get(taskId).count, 1);
  } finally {
    database.close();
  }
});

test("real SQLite rejects an old lease token after the task is reclaimed", async () => {
  const database = makeDatabase();
  try {
    const env = bindings(database);
    const response = await call("/api/conversations/sqlite-conversation/tasks", { method: "POST", headers: admin, body: JSON.stringify({ target_agent_id: "codex-local-01", instruction: "inspect files", idempotency_key: "sqlite-lease" }) }, env);
    const taskId = (await response.json()).task.task_id;
    const first = await (await call("/api/agent/claim", { method: "POST", headers: agent, body: JSON.stringify({ agent_id: "codex-local-01" }) }, env)).json();
    database.prepare("UPDATE tasks SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE task_id = ?").run(taskId);
    const second = await (await call("/api/agent/claim", { method: "POST", headers: agent, body: JSON.stringify({ agent_id: "codex-local-01" }) }, env)).json();
    assert.notEqual(second.task.lease_token, first.task.lease_token);
    const stale = await call(`/api/agent/tasks/${taskId}/result`, { method: "POST", headers: agent, body: JSON.stringify({ agent_id: "codex-local-01", lease_token: first.task.lease_token, result_id: "stale", status: "succeeded", result_summary: "stale" }) }, env);
    assert.equal(stale.status, 403);
  } finally {
    database.close();
  }
});

test("message outbox retains a succeeded task after GitHub 503 and retries without rerunning", async () => {
  const database = makeDatabase();
  const env = bindings(database); env.RELAY_PASSWORD = "sqlite-relay"; env.GITHUB_TOKEN = "fixture-token";
  const fixture = githubFetchFixture({ putMode: "503" });
  const originalFetch = globalThis.fetch; globalThis.fetch = fixture.fetch;
  try {
    const { taskId, claimed } = await createClaimedTask(env, "outbox-503");
    const payload = { agent_id: "codex-local-01", lease_token: claimed.task.lease_token, result_id: "outbox-result-503", status: "succeeded", result_summary: "deliver later" };
    let response = await call(`/api/agent/tasks/${taskId}/result`, { method: "POST", headers: agent, body: JSON.stringify(payload) }, env);
    assert.equal(response.status, 202);
    assert.equal(database.prepare("SELECT execution_state FROM tasks WHERE task_id = ?").get(taskId).execution_state, "succeeded");
    assert.equal(database.prepare("SELECT status, attempts FROM message_outbox WHERE task_id = ?").get(taskId).status, "pending");
    fixture.setMode("success");
    response = await call(`/api/agent/tasks/${taskId}/result`, { method: "POST", headers: agent, body: JSON.stringify(payload) }, env);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).idempotent_replay, true);
    assert.equal(database.prepare("SELECT status FROM message_outbox WHERE task_id = ?").get(taskId).status, "delivered");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM message_index WHERE task_id = ?").get(taskId).count, 1);
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test("message outbox recognizes a GitHub response lost after the file was committed", async () => {
  const database = makeDatabase();
  const env = bindings(database); env.RELAY_PASSWORD = "sqlite-relay"; env.GITHUB_TOKEN = "fixture-token";
  const fixture = githubFetchFixture({ putMode: "response-lost" });
  const originalFetch = globalThis.fetch; globalThis.fetch = fixture.fetch;
  try {
    const { taskId, claimed } = await createClaimedTask(env, "outbox-response-lost");
    const response = await call(`/api/agent/tasks/${taskId}/result`, { method: "POST", headers: agent, body: JSON.stringify({ agent_id: "codex-local-01", lease_token: claimed.task.lease_token, result_id: "outbox-result-lost", status: "succeeded", result_summary: "already committed" }) }, env);
    assert.equal(response.status, 200);
    assert.equal(database.prepare("SELECT status FROM message_outbox WHERE task_id = ?").get(taskId).status, "delivered");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM message_index WHERE task_id = ?").get(taskId).count, 1);
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test("message index failure leaves index_pending and compensates on retry", async () => {
  const database = makeDatabase();
  const env = bindings(database); env.RELAY_PASSWORD = "sqlite-relay"; env.GITHUB_TOKEN = "fixture-token"; env.DB.failMessageIndex = true;
  const fixture = githubFetchFixture();
  const originalFetch = globalThis.fetch; globalThis.fetch = fixture.fetch;
  try {
    const { taskId, claimed } = await createClaimedTask(env, "outbox-index-failure");
    let response = await call(`/api/agent/tasks/${taskId}/result`, { method: "POST", headers: agent, body: JSON.stringify({ agent_id: "codex-local-01", lease_token: claimed.task.lease_token, result_id: "outbox-result-index", status: "succeeded", result_summary: "index later" }) }, env);
    assert.equal(response.status, 202);
    assert.equal(database.prepare("SELECT status FROM message_outbox WHERE task_id = ?").get(taskId).status, "index_pending");
    env.DB.failMessageIndex = false;
    const outboxId = database.prepare("SELECT outbox_id FROM message_outbox WHERE task_id = ?").get(taskId).outbox_id;
    response = await call(`/api/message-outbox/${outboxId}/retry`, { method: "POST", headers: admin }, env);
    assert.equal(response.status, 200);
    assert.equal(database.prepare("SELECT status FROM message_outbox WHERE task_id = ?").get(taskId).status, "delivered");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM message_index WHERE task_id = ?").get(taskId).count, 1);
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test("claim skips a higher-priority task outside its active window and takes the eligible task", async () => {
  const database = makeDatabase();
  try {
    const future = new Date(Date.now() + 120000);
    const futureMinute = `${String(future.getUTCHours()).padStart(2, "0")}:${String(future.getUTCMinutes()).padStart(2, "0")}`;
    database.prepare("INSERT INTO conversations (conversation_id, name, state, active_hours_json, timezone, created_at, updated_at, last_activity_at) VALUES (?, ?, 'running', ?, 'UTC', ?, ?, ?), (?, ?, 'running', NULL, 'UTC', ?, ?, ?)").run("blocked-high", "Blocked", JSON.stringify({ start: futureMinute, end: futureMinute }), "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "eligible-low", "Eligible", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    database.exec("INSERT INTO conversation_agents (conversation_id, agent_id, role) VALUES ('blocked-high', 'codex-local-01', 'executor'), ('eligible-low', 'codex-local-01', 'executor')");
    const env = bindings(database);
    await call("/api/conversations/blocked-high/tasks", { method: "POST", headers: admin, body: JSON.stringify({ target_agent_id: "codex-local-01", instruction: "blocked", priority: 100, idempotency_key: "blocked-high-task" }) }, env);
    await call("/api/conversations/eligible-low/tasks", { method: "POST", headers: admin, body: JSON.stringify({ target_agent_id: "codex-local-01", instruction: "eligible", priority: 1, idempotency_key: "eligible-low-task" }) }, env);
    const claimed = await (await call("/api/agent/claim", { method: "POST", headers: agent, body: JSON.stringify({ agent_id: "codex-local-01" }) }, env)).json();
    assert.equal(claimed.task.instruction, "eligible");
  } finally {
    database.close();
  }
});
