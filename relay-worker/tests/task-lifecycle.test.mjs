import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const { default: worker } = await import("../src/index.js");

class TaskStatement {
  constructor(db, sql) { this.db = db; this.sql = sql.replace(/\s+/g, " ").trim(); this.args = []; }
  bind(...args) { this.args = args; return this; }
  async first() {
    const s = this.sql;
    if (s.startsWith("SELECT c.*")) return this.db.conversationRow(this.args[0]);
    if (s.startsWith("SELECT agent_id FROM agents")) return this.db.agents.has(this.args[0]) ? { agent_id: this.args[0] } : null;
    if (s.startsWith("SELECT COUNT(*)")) return { count: [...this.db.tasks.values()].filter((task) => task.conversation_id === this.args[0] && !["cancelled", "timed_out"].includes(task.execution_state)).length };
    if (s.startsWith("SELECT * FROM tasks WHERE idempotency_key")) return [...this.db.tasks.values()].find((task) => task.idempotency_key === this.args[0]) || null;
    if (s.startsWith("SELECT * FROM tasks WHERE task_id")) return this.db.tasks.get(this.args[0]) || null;
    if (s.startsWith("SELECT finished_at")) return null;
    if (s.startsWith("SELECT t.*, a.status AS approval_status FROM tasks t LEFT JOIN approvals")) {
      const task = this.db.tasks.get(this.args[0]);
      return task ? { ...task, approval_status: task.approval_id ? this.db.approvals.get(task.approval_id)?.status || null : null } : null;
    }
    if (s.startsWith("SELECT t.*, c.state AS conversation_state")) {
      const task = [...this.db.tasks.values()].find((item) => item.target_agent_id === this.args[0] && item.execution_state === "pending" && item.available_at <= this.args[1] && this.db.conversations.get(item.conversation_id)?.state === "running" && (!item.approval_id || this.db.approvals.get(item.approval_id)?.status === "approved"));
      if (!task) return null;
      return { ...task, conversation_state: "running", active_hours_json: null, timezone: "UTC", approval_status: task.approval_id ? this.db.approvals.get(task.approval_id)?.status || null : null };
    }
    if (s.startsWith("SELECT approval_id")) return this.db.approvals.get(this.args[0]) || null;
    if (s.startsWith("SELECT task_id, conversation_id FROM approvals")) { const approval = this.db.approvals.get(this.args[0]); return approval ? { task_id: approval.task_id, conversation_id: approval.conversation_id } : null; }
    return null;
  }
  async all() {
    const s = this.sql;
    if (s.startsWith("SELECT agent_id, role FROM conversation_agents")) return { results: this.db.members.filter((item) => item.conversation_id === this.args[0]) };
    if (s.startsWith("SELECT t.*, a.status AS approval_status")) return { results: [...this.db.tasks.values()].filter((item) => item.conversation_id === this.args[0]).map((item) => ({ ...item, approval_status: null })) };
    return { results: [] };
  }
  async run() {
    const s = this.sql;
    if (s.startsWith("INSERT INTO tasks")) {
      const [task_id, conversation_id, kind, status, idempotency_key, requested_by, assigned_agent_id, payload_json, approval_required, created_at, updated_at, target_agent_id, instruction, task_type, working_directory_id, sandbox_mode, priority, available_at, max_attempts, attempt_count, approval_id, execution_state] = this.args;
      this.db.tasks.set(task_id, { task_id, conversation_id, kind, status, idempotency_key, requested_by, assigned_agent_id, payload_json, approval_required, created_at, updated_at, target_agent_id, instruction, task_type, working_directory_id, sandbox_mode, priority, available_at, max_attempts, attempt_count, approval_id, execution_state, attempts: 0, lease_token: null, lease_expires_at: null });
      return { meta: { changes: 1 } };
    }
    if (s.startsWith("INSERT INTO approvals")) { this.db.approvals.set(this.args[0], { approval_id: this.args[0], task_id: this.args[1], conversation_id: this.args[2], status: "pending" }); return { meta: { changes: 1 } }; }
    if (s.startsWith("INSERT INTO audit_events")) return { meta: { changes: 1 } };
    if (s.startsWith("UPDATE tasks SET execution_state = 'claimed'")) {
      const task = this.db.tasks.get(this.args[5]);
      if (!task || task.target_agent_id !== this.args[6] || task.execution_state !== "pending" || task.available_at > this.args[7]) return { meta: { changes: 0 } };
      Object.assign(task, { execution_state: "claimed", status: "leased", assigned_agent_id: this.args[0], claimed_at: this.args[1], lease_expires_at: this.args[2], lease_token: this.args[3], attempt_count: task.attempt_count + 1, attempts: task.attempts + 1, updated_at: this.args[4] });
      return { meta: { changes: 1 } };
    }
    if (s.startsWith("UPDATE approvals SET status")) { const approval = this.db.approvals.get(this.args[3]); if (!approval || approval.status !== "pending") return { meta: { changes: 0 } }; approval.status = this.args[0]; return { meta: { changes: 1 } }; }
    if (s.startsWith("UPDATE tasks SET execution_state = 'pending'")) { const task = this.db.tasks.get(this.args[1]); if (!task || task.execution_state !== "waiting_approval") return { meta: { changes: 0 } }; task.execution_state = "pending"; task.status = "queued"; return { meta: { changes: 1 } }; }
    if (s.startsWith("UPDATE tasks SET execution_state = 'running'")) { const task = this.db.tasks.get(this.args[2]); if (!task || task.lease_token !== this.args[4] || task.execution_state !== "claimed") return { meta: { changes: 0 } }; task.execution_state = "running"; task.status = "running"; return { meta: { changes: 1 } }; }
    if (s.startsWith("UPDATE tasks SET lease_expires_at")) { const task = this.db.tasks.get(this.args[2]); if (!task || task.lease_token !== this.args[4]) return { meta: { changes: 0 } }; task.lease_expires_at = this.args[0]; return { meta: { changes: 1 } }; }
    if (s.startsWith("UPDATE tasks SET execution_state = ?")) { const task = this.db.tasks.get(this.args[7]); if (!task || task.lease_token !== this.args[9]) return { meta: { changes: 0 } }; task.execution_state = this.args[0]; task.status = this.args[1]; task.lease_token = null; return { meta: { changes: 1 } }; }
    return { meta: { changes: 1 } };
  }
}

class TaskD1 {
  constructor() { this.agents = new Map([["codex-local-01", {}]]); this.conversations = new Map([['task-conversation', { conversation_id: 'task-conversation', name: 'Task test', goal: '', state: 'running', max_rounds: 10, round_delay_seconds: 0, require_approval: 0, archived_at: null }]]); this.members = [{ conversation_id: 'task-conversation', agent_id: 'codex-local-01', role: 'executor' }]; this.tasks = new Map(); this.approvals = new Map(); }
  prepare(sql) { return new TaskStatement(this, sql); }
  conversationRow(id) { const row = this.conversations.get(id); return row ? { ...row, agents_json: JSON.stringify(this.members.filter((item) => item.conversation_id === id).map((item) => item.agent_id)) } : null; }
}

const bindings = () => ({ DB: new TaskD1(), MANAGEMENT_PASSWORD: "unit-admin-fixture", AGENT_KEYS: JSON.stringify({ "codex-local-01": "unit-agent-fixture" }) });
const admin = { "X-Relay-Admin": "unit-admin-fixture", "Content-Type": "application/json" };
const agent = { "X-Agent-Key": "unit-agent-fixture", "Content-Type": "application/json" };
async function call(path, options, env) { return worker.fetch(new Request(`https://relay.test${path}`, options), env); }

test("task creation is idempotent and read-only tasks wait for a running conversation", async () => {
  const env = bindings();
  let response = await call("/api/conversations/task-conversation/tasks", { method: "POST", headers: admin, body: JSON.stringify({ target_agent_id: "codex-local-01", instruction: "inspect files", task_type: "read_only_analysis", idempotency_key: "same-task" }) }, env);
  assert.equal(response.status, 201); const first = await response.json(); assert.equal(first.task.status, "pending");
  response = await call("/api/conversations/task-conversation/tasks", { method: "POST", headers: admin, body: JSON.stringify({ target_agent_id: "codex-local-01", instruction: "inspect files", task_type: "read_only_analysis", idempotency_key: "same-task" }) }, env);
  assert.equal(response.status, 200); assert.equal((await response.json()).idempotent_replay, true);
});

test("two concurrent claims yield one lease", async () => {
  const env = bindings();
  await call("/api/conversations/task-conversation/tasks", { method: "POST", headers: admin, body: JSON.stringify({ target_agent_id: "codex-local-01", instruction: "inspect files", idempotency_key: "concurrent-task" }) }, env);
  const responses = await Promise.all([
    call("/api/agent/claim", { method: "POST", headers: agent, body: JSON.stringify({ agent_id: "codex-local-01" }) }, env),
    call("/api/agent/claim", { method: "POST", headers: agent, body: JSON.stringify({ agent_id: "codex-local-01" }) }, env),
  ]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  const claims = await Promise.all(responses.map((response) => response.json()));
  assert.equal(claims.filter((item) => item.task).length, 1);
  assert.equal(claims.filter((item) => item.task === null).length, 1);
});

test("approval gates write tasks and lease token gates completion", async () => {
  const env = bindings();
  let response = await call("/api/conversations/task-conversation/tasks", { method: "POST", headers: admin, body: JSON.stringify({ target_agent_id: "codex-local-01", instruction: "edit a file", task_type: "code_change", sandbox_mode: "workspace-write", working_directory_id: "project", idempotency_key: "approved-write" }) }, env);
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(created.task.status, "waiting_approval");
  assert.ok(created.task.approval_id);
  response = await call("/api/agent/claim", { method: "POST", headers: agent, body: JSON.stringify({ agent_id: "codex-local-01" }) }, env);
  assert.equal((await response.json()).task, null);
  response = await call(`/api/approvals/${created.task.approval_id}/decision`, { method: "POST", headers: admin, body: JSON.stringify({ decision: "approved" }) }, env);
  assert.equal(response.status, 200);
  response = await call("/api/agent/claim", { method: "POST", headers: agent, body: JSON.stringify({ agent_id: "codex-local-01" }) }, env);
  const claimed = await response.json(); assert.ok(claimed.task?.lease_token);
  response = await call(`/api/agent/tasks/${claimed.task.task_id}/result`, { method: "POST", headers: agent, body: JSON.stringify({ agent_id: "codex-local-01", lease_token: "wrong", status: "succeeded", result_summary: "bad" }) }, env);
  assert.equal(response.status, 403);
  response = await call(`/api/agent/tasks/${claimed.task.task_id}/ack`, { method: "POST", headers: agent, body: JSON.stringify({ agent_id: "codex-local-01", lease_token: claimed.task.lease_token }) }, env);
  assert.equal(response.status, 200);
  response = await call(`/api/agent/tasks/${claimed.task.task_id}/result`, { method: "POST", headers: agent, body: JSON.stringify({ agent_id: "codex-local-01", lease_token: claimed.task.lease_token, status: "succeeded", result_summary: "approved result" }) }, env);
  assert.equal(response.status, 200);
});
