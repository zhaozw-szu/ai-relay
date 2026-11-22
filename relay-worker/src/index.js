const encoder = new TextEncoder();
// Keep the default within the Workers Free plan's 10 ms CPU limit.
// Each message stores its own iteration count, so older messages remain readable.
const ITERATIONS = 20000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MANAGEMENT_HEADER = "X-Relay-Admin";
const AGENT_HEADER = "X-Agent-Key";

function corsHeaders(request, env) {
  const headers = {
    "Access-Control-Allow-Headers": `Content-Type, Accept, X-Relay-Password, ${MANAGEMENT_HEADER}, ${AGENT_HEADER}`,
    "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
    Vary: "Origin",
  };
  const origin = request?.headers.get("Origin");
  const configured = String(env?.CORS_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!configured.length) headers["Access-Control-Allow-Origin"] = "*";
  else if (origin && configured.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(data, status = 200, request = null, env = {}) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders(request, env) });
}

function text(value) { return typeof value === "string" ? value.trim() : ""; }
function bool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  return value === true || value === 1 || value === "1" || value === "true";
}
function safeAgentId(value) { return typeof value === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(value); }
function safeConversationId(value) { return typeof value === "string" && /^[A-Za-z0-9._-]{1,96}$/.test(value); }
function safeId(value) { return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value); }

function newId(prefix) {
  const stamp = new Date().toISOString().replace(/[-:.]/g, "").replace(/Z$/, "Z");
  const random = hex(crypto.getRandomValues(new Uint8Array(6)));
  return `${prefix}-${stamp}-${random}`;
}
function base64(bytes) {
  let result = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) result += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(result);
}
function fromBase64(value) {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function hex(bytes) { return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join(""); }
function timestampId(date) {
  const stamp = date.toISOString().replace(/[-:.]/g, "").replace(/Z$/, "Z");
  const random = hex(crypto.getRandomValues(new Uint8Array(6)));
  return { stamp, id: `msg-${stamp}-${random}` };
}

async function encryptText(plainText, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plainText));
  return { algorithm: "AES-256-GCM", kdf: "PBKDF2-SHA256", iterations: ITERATIONS, salt_b64: base64(salt), iv_b64: base64(iv), ciphertext_b64: base64(new Uint8Array(encrypted)) };
}
async function decryptText(record, password) {
  const info = record.crypto;
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt: fromBase64(info.salt_b64), iterations: Number(info.iterations), hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(info.iv_b64) }, key, fromBase64(record.ciphertext_b64));
  return new TextDecoder().decode(decrypted);
}
function encodedPath(path) { return path.split("/").map(encodeURIComponent).join("/"); }

async function readGitHubJson(env, path) {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodedPath(path)}?ref=${encodeURIComponent(env.GITHUB_BRANCH || "main")}`;
  let response;
  try {
    response = await fetch(url, { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${env.GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "ai-relay-worker" } });
  } catch (error) {
    return { ok: false, status: 502, details: `GitHub request failed: ${String(error).slice(0, 160)}` };
  }
  if (!response.ok) {
    let details = "GitHub returned an error";
    try { const errorBody = await response.json(); if (typeof errorBody.message === "string") details = errorBody.message.slice(0, 160); } catch { /* generic */ }
    return { ok: false, status: response.status, details };
  }
  return { ok: true, data: await response.json() };
}
async function writeGitHubFile(env, path, contents, message) {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodedPath(path)}`;
  const body = { message, content: base64(encoder.encode(contents)), branch: env.GITHUB_BRANCH || "main" };
  let response;
  try {
    response = await fetch(url, { method: "PUT", headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${env.GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "ai-relay-worker", "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch (error) {
    return { ok: false, status: 502, details: `GitHub request failed: ${String(error).slice(0, 160)}` };
  }
  if (!response.ok) {
    let details = "GitHub returned an error";
    try { const errorBody = await response.json(); if (typeof errorBody.message === "string") details = errorBody.message.slice(0, 160); } catch { /* generic */ }
    return { ok: false, status: response.status, details };
  }
  return { ok: true };
}

function database(env) { return env.DB || env.D1 || null; }
function requireDatabase(request, env) { return database(env) ? null : json({ error: "D1 is not configured" }, 503, request, env); }
async function dbFirst(env, sql, ...args) { return database(env).prepare(sql).bind(...args).first(); }
async function dbAll(env, sql, ...args) { const result = await database(env).prepare(sql).bind(...args).all(); return result.results || []; }
async function dbRun(env, sql, ...args) { return database(env).prepare(sql).bind(...args).run(); }
async function dbBatch(env, statements) { return database(env).batch(statements); }
async function audit(env, { conversationId = null, actor, eventType, payload = {} }) {
  await dbRun(env, `INSERT INTO audit_events (event_id, conversation_id, actor, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`, newId("audit"), conversationId, actor, eventType, JSON.stringify(payload), new Date().toISOString());
}
function parseJson(value, fallback) { if (value === null || value === undefined || value === "") return fallback; try { return JSON.parse(value); } catch { return fallback; } }
function conversationView(row) {
  if (!row) return null;
  return { conversation_id: row.conversation_id, name: row.name, goal: row.goal, state: row.state, agents: parseJson(row.agents_json, []), max_rounds: Number(row.max_rounds), round_delay_seconds: Number(row.round_delay_seconds), poll_interval_seconds: Number(row.poll_interval_seconds), active_hours: parseJson(row.active_hours_json, null), timezone: row.timezone, require_approval: Number(row.require_approval) === 1, next_run_at: row.next_run_at, created_at: row.created_at, updated_at: row.updated_at, last_activity_at: row.last_activity_at, archived_at: row.archived_at };
}
function limitFrom(url, fallback = DEFAULT_LIMIT) { const value = Number.parseInt(url.searchParams.get("limit") || String(fallback), 10); return Number.isFinite(value) ? Math.min(Math.max(value, 1), MAX_LIMIT) : fallback; }
function configuredAdminPassword(env) { return text(env.MANAGEMENT_PASSWORD || env.ADMIN_PASSWORD); }
function isAdmin(request, env) { const expected = configuredAdminPassword(env); return Boolean(expected && request.headers.get(MANAGEMENT_HEADER) === expected); }
function adminError(request, env) { return !configuredAdminPassword(env) ? json({ error: "management authentication is not configured" }, 503, request, env) : json({ error: "management authentication failed" }, 401, request, env); }
function agentKeys(env) {
  const raw = text(env.AGENT_KEYS);
  if (!raw) return {};
  try { const parsed = JSON.parse(raw); if (parsed && typeof parsed === "object") return parsed; } catch { /* id:key fallback */ }
  return Object.fromEntries(raw.split(",").map((item) => item.split(":", 2)).filter(([id, key]) => safeAgentId(id) && key));
}
function agentError(request, env) { return json(!text(env.AGENT_KEYS) ? { error: "agent authentication is not configured" } : { error: "agent authentication failed" }, !text(env.AGENT_KEYS) ? 503 : 401, request, env); }
function isAuthenticatedAgent(request, env, agentId) { const keys = agentKeys(env); return Boolean(safeAgentId(agentId) && keys[agentId] && request.headers.get(AGENT_HEADER) === keys[agentId]); }
async function readBody(request) { try { return await request.json(); } catch { return null; } }
function messageRecipients(value) { const list = Array.isArray(value) ? value : [value]; return list.length && list.every((item) => item === "broadcast" || safeAgentId(item)) ? list : null; }

async function createMessage(env, body, password) {
  if (!safeAgentId(body.agent_id)) return { error: "invalid agent_id" };
  if (typeof body.content !== "string" || body.content.length === 0 || body.content.length > 100000) return { error: "content must be 1-100000 characters" };
  const recipients = messageRecipients(body.to || "broadcast");
  if (!recipients) return { error: "invalid recipient" };
  const createdAt = new Date();
  const { stamp, id } = timestampId(createdAt);
  const encrypted = await encryptText(body.content, password);
  const record = { version: 2, id, from: body.agent_id, to: recipients, conversation_id: safeConversationId(body.conversation_id) ? body.conversation_id : null, type: typeof body.type === "string" ? body.type.slice(0, 32) : "task", reply_to: typeof body.reply_to === "string" ? body.reply_to.slice(0, 128) : null, task_id: typeof body.task_id === "string" ? body.task_id.slice(0, 128) : null, created_at: createdAt.toISOString(), crypto: { algorithm: encrypted.algorithm, kdf: encrypted.kdf, iterations: encrypted.iterations, salt_b64: encrypted.salt_b64, iv_b64: encrypted.iv_b64 }, ciphertext_b64: encrypted.ciphertext_b64 };
  const path = `messages/${body.agent_id}/${stamp}-${id.slice(-12)}.json`;
  const result = await writeGitHubFile(env, path, JSON.stringify(record, null, 2), `relay: ${body.agent_id} ${id}`);
  if (!result.ok) return { error: "GitHub write failed", status: result.status, details: result.details };
  return { ok: true, record, path };
}

async function handleLegacyRead(request, env, url) {
  if (!env.RELAY_PASSWORD || !env.GITHUB_TOKEN) return json({ error: "worker secrets are not configured" }, 500, request, env);
  if (request.headers.get("X-Relay-Password") !== env.RELAY_PASSWORD) return json({ error: "invalid relay password" }, 401, request, env);
  const recipient = url.searchParams.get("agent_id") || "cloud-chatgpt-01";
  const conversationId = url.searchParams.get("conversation_id");
  const limit = limitFrom(url);
  if (!safeAgentId(recipient)) return json({ error: "invalid agent_id" }, 400, request, env);
  const root = await readGitHubJson(env, "messages");
  if (!root.ok) return json({ error: "GitHub read failed", status: root.status, details: root.details }, 502, request, env);
  const directories = Array.isArray(root.data) ? root.data.filter((entry) => entry.type === "dir" && safeAgentId(entry.name)) : [];
  const messages = [];
  for (const directory of directories) {
    const listing = await readGitHubJson(env, `messages/${directory.name}`);
    if (!listing.ok || !Array.isArray(listing.data)) continue;
    const files = listing.data.filter((entry) => entry.type === "file" && entry.name.endsWith(".json"));
    for (const file of files) {
      const item = await readGitHubJson(env, `messages/${directory.name}/${file.name}`);
      if (!item.ok || !item.data || typeof item.data.content !== "string") continue;
      let record;
      try { record = JSON.parse(new TextDecoder().decode(fromBase64(item.data.content))); } catch { continue; }
      if (!Array.isArray(record.to) || (!record.to.includes(recipient) && !record.to.includes("broadcast"))) continue;
      if (conversationId && record.conversation_id !== conversationId) continue;
      try { messages.push({ id: record.id, from: record.from, to: record.to, conversation_id: record.conversation_id, type: record.type, reply_to: record.reply_to || null, task_id: record.task_id || null, created_at: record.created_at, content: await decryptText(record, env.RELAY_PASSWORD) }); } catch { /* incompatible message */ }
    }
  }
  messages.sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
  return json({ ok: true, agent_id: recipient, conversation_id: conversationId, messages: messages.slice(-limit) }, 200, request, env);
}

async function getConversation(env, conversationId) {
  return dbFirst(env, `SELECT c.*, COALESCE((SELECT json_group_array(agent_id) FROM conversation_agents ca WHERE ca.conversation_id = c.conversation_id), '[]') AS agents_json FROM conversations c WHERE c.conversation_id = ?`, conversationId);
}
function conversationInput(body, existing = {}) {
  const result = { name: text(body.name ?? existing.name), goal: text(body.goal ?? existing.goal), max_rounds: Number(body.max_rounds ?? existing.max_rounds ?? 10), round_delay_seconds: Number(body.round_delay_seconds ?? existing.round_delay_seconds ?? 300), poll_interval_seconds: Number(body.poll_interval_seconds ?? existing.poll_interval_seconds ?? 60), active_hours: body.active_hours ?? (existing.active_hours_json ? parseJson(existing.active_hours_json, null) : null), timezone: text(body.timezone ?? existing.timezone) || "UTC", require_approval: bool(body.require_approval ?? existing.require_approval, false), next_run_at: body.next_run_at ?? existing.next_run_at ?? null };
  if (!result.name || result.name.length > 160) return { error: "name is required and must be <=160 characters" };
  if (result.goal.length > 10000) return { error: "goal must be <=10000 characters" };
  if (!Number.isInteger(result.max_rounds) || result.max_rounds < 1 || result.max_rounds > 10000) return { error: "invalid max_rounds" };
  if (!Number.isInteger(result.round_delay_seconds) || result.round_delay_seconds < 0 || result.round_delay_seconds > 86400) return { error: "invalid round_delay_seconds" };
  if (!Number.isInteger(result.poll_interval_seconds) || result.poll_interval_seconds < 5 || result.poll_interval_seconds > 86400) return { error: "invalid poll_interval_seconds" };
  return result;
}

function taskView(row, includeLease = false) {
  if (!row) return null;
  return {
    task_id: row.task_id,
    conversation_id: row.conversation_id,
    target_agent_id: row.target_agent_id || row.assigned_agent_id,
    instruction: row.instruction || parseJson(row.payload_json, {}).instruction || "",
    task_type: row.task_type || "read_only_analysis",
    working_directory_id: row.working_directory_id,
    sandbox_mode: row.sandbox_mode || "read-only",
    status: row.execution_state || (row.status === "leased" ? "claimed" : row.status === "queued" ? "pending" : row.status),
    priority: Number(row.priority ?? 50),
    idempotency_key: row.idempotency_key,
    created_at: row.created_at,
    available_at: row.available_at,
    claimed_at: row.claimed_at,
    lease_expires_at: row.lease_expires_at,
    lease_token: includeLease ? (row.lease_token || null) : null,
    attempt_count: Number(row.attempt_count ?? row.attempts ?? 0),
    max_attempts: Number(row.max_attempts ?? 3),
    started_at: row.started_at,
    finished_at: row.finished_at,
    result_summary: row.result_summary || "",
    error_code: row.error_code || null,
    approval_id: row.approval_id || null,
    approval_status: row.approval_status || null,
    assigned_agent_id: row.assigned_agent_id || null,
    result_id: row.result_id || null,
    result: parseJson(row.result_json, null),
    error: row.error_text || null,
  };
}

async function getTask(env, taskId) {
  return dbFirst(env, `SELECT t.*, a.status AS approval_status FROM tasks t LEFT JOIN approvals a ON a.approval_id = t.approval_id WHERE t.task_id = ?`, taskId);
}

async function conversationAgents(env, conversationId) {
  return dbAll(env, `SELECT agent_id, role FROM conversation_agents WHERE conversation_id = ? ORDER BY agent_id`, conversationId);
}

function validIsoDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function activeHoursAllow(activeHoursJson, timezone, now = new Date()) {
  const activeHours = parseJson(activeHoursJson, null);
  if (!activeHours || typeof activeHours !== "object") return true;
  const start = text(activeHours.start || activeHours.from);
  const end = text(activeHours.end || activeHours.to);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end)) return true;
  let current;
  try {
    current = new Intl.DateTimeFormat("en-GB", { timeZone: timezone || "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  } catch {
    return false;
  }
  if (start <= end) return current >= start && current <= end;
  return current >= start || current <= end;
}

function taskStateToLegacyStatus(state) {
  if (state === "claimed") return "leased";
  if (state === "pending" || state === "waiting_approval") return "queued";
  if (state === "timed_out") return "failed";
  return state;
}

function taskPayload(body, conversation) {
  const taskType = text(body.task_type || body.type) || "read_only_analysis";
  const sandbox = text(body.sandbox_mode) || (taskType === "read_only_analysis" ? "read-only" : "workspace-write");
  const forcedApproval = Boolean(conversation.require_approval || taskType !== "read_only_analysis" || sandbox !== "read-only");
  const requiresApproval = forcedApproval || bool(body.requires_approval, false);
  if (!['read_only_analysis', 'code_change', 'command'].includes(taskType)) return { error: "unsupported task_type" };
  if (!['read-only', 'workspace-write'].includes(sandbox)) return { error: "unsupported sandbox_mode" };
  if (taskType === "read_only_analysis" && sandbox !== "read-only") return { error: "read_only_analysis requires read-only sandbox" };
  if (sandbox === "workspace-write" && !requiresApproval) return { error: "workspace-write tasks require approval" };
  const instruction = text(body.instruction || body.content);
  if (!instruction || instruction.length > 20000) return { error: "instruction is required and must be <=20000 characters" };
  const priority = Number(body.priority ?? 50);
  if (!Number.isInteger(priority) || priority < 0 || priority > 100) return { error: "priority must be an integer from 0 to 100" };
  const maxAttempts = Number(body.max_attempts ?? 3);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) return { error: "invalid max_attempts" };
  return { taskType, sandbox, requiresApproval, instruction, priority, maxAttempts };
}

async function lastFinishedTask(env, conversationId) {
  return dbFirst(env, `SELECT finished_at FROM tasks WHERE conversation_id = ? AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`, conversationId);
}

async function handleTaskCreate(request, env, conversationId) {
  const missing = requireDatabase(request, env); if (missing) return missing;
  if (!isAdmin(request, env)) return adminError(request, env);
  if (!safeConversationId(conversationId)) return json({ error: "invalid conversation_id" }, 400, request, env);
  const conversation = await getConversation(env, conversationId);
  if (!conversation || conversation.archived_at) return json({ error: "conversation not found or archived" }, 404, request, env);
  const body = await readBody(request); if (!body) return json({ error: "request body must be JSON" }, 400, request, env);
  const targetAgentId = body.target_agent_id || body.agent_id || "codex-local-01";
  if (!safeAgentId(targetAgentId)) return json({ error: "valid target_agent_id is required" }, 400, request, env);
  const members = await conversationAgents(env, conversationId);
  if (!members.some((member) => member.agent_id === targetAgentId)) return json({ error: "target agent is not a conversation participant" }, 400, request, env);
  const payload = taskPayload(body, conversation); if (payload.error) return json(payload, 400, request, env);
  const roundCount = await dbFirst(env, `SELECT COUNT(*) AS count FROM tasks WHERE conversation_id = ? AND execution_state NOT IN ('cancelled', 'timed_out')`, conversationId);
  if (Number(roundCount?.count || 0) >= Number(conversation.max_rounds || 10)) return json({ error: "conversation max_rounds has been reached" }, 409, request, env);
  const idempotencyKey = text(body.idempotency_key) || newId("idem");
  if (idempotencyKey.length > 160) return json({ error: "idempotency_key must be <=160 characters" }, 400, request, env);
  const existing = await dbFirst(env, `SELECT * FROM tasks WHERE idempotency_key = ?`, idempotencyKey);
  if (existing) return json({ ok: true, idempotent_replay: true, task: taskView(existing) }, 200, request, env);
  const requestedAt = new Date().toISOString();
  const explicitAvailableAt = validIsoDate(body.available_at);
  if (body.available_at && !explicitAvailableAt) return json({ error: "available_at must be a valid ISO timestamp" }, 400, request, env);
  let availableAt = explicitAvailableAt || requestedAt;
  const previous = await lastFinishedTask(env, conversationId);
  if (!explicitAvailableAt && previous?.finished_at && conversation.round_delay_seconds > 0) {
    const earliest = new Date(new Date(previous.finished_at).getTime() + Number(conversation.round_delay_seconds) * 1000).toISOString();
    if (earliest > availableAt) availableAt = earliest;
  }
  const taskId = newId("task");
  const approvalId = payload.requiresApproval ? newId("approval") : null;
  const executionState = payload.requiresApproval ? "waiting_approval" : "pending";
  const now = new Date().toISOString();
  try {
    const statements = [database(env).prepare(`INSERT INTO tasks (task_id, conversation_id, kind, status, idempotency_key, requested_by, assigned_agent_id, payload_json, approval_required, created_at, updated_at, target_agent_id, instruction, task_type, working_directory_id, sandbox_mode, priority, available_at, max_attempts, attempt_count, approval_id, execution_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(taskId, conversationId, payload.taskType, taskStateToLegacyStatus(executionState), idempotencyKey, "admin", null, JSON.stringify({ instruction: payload.instruction }), payload.requiresApproval ? 1 : 0, now, now, targetAgentId, payload.instruction, payload.taskType, text(body.working_directory_id) || null, payload.sandbox, payload.priority, availableAt, payload.maxAttempts, 0, approvalId, executionState)];
    if (approvalId) statements.push(database(env).prepare(`INSERT INTO approvals (approval_id, task_id, conversation_id, requested_by, risk_level, operation, files_json, impact, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`).bind(approvalId, taskId, conversationId, "admin", payload.sandbox === "workspace-write" ? "high" : "medium", payload.taskType, JSON.stringify(Array.isArray(body.files) ? body.files.slice(0, 100) : []), text(body.impact).slice(0, 2000), now));
    await dbBatch(env, statements);
  } catch (error) {
    return json({ error: "task could not be created", details: String(error).slice(0, 180) }, 409, request, env);
  }
  await audit(env, { conversationId, actor: "admin", eventType: "task.created", payload: { task_id: taskId, target_agent_id: targetAgentId, execution_state: executionState, approval_id: approvalId } });
  return json({ ok: true, task: taskView(await getTask(env, taskId)) }, 201, request, env);
}

async function handleTaskList(request, env, url, conversationId) {
  const missing = requireDatabase(request, env); if (missing) return missing;
  if (!isAdmin(request, env)) return adminError(request, env);
  const rows = await dbAll(env, `SELECT t.*, a.status AS approval_status FROM tasks t LEFT JOIN approvals a ON a.approval_id = t.approval_id WHERE t.conversation_id = ? ORDER BY t.created_at DESC LIMIT ?`, conversationId, limitFrom(url, 100));
  return json({ ok: true, conversation_id: conversationId, tasks: rows.map(taskView) }, 200, request, env);
}

async function handleTaskGet(request, env, taskId) {
  const missing = requireDatabase(request, env); if (missing) return missing;
  if (!isAdmin(request, env)) return adminError(request, env);
  const row = await getTask(env, taskId); if (!row) return json({ error: "task not found" }, 404, request, env);
  return json({ ok: true, task: taskView(row) }, 200, request, env);
}

async function handleAgents(request, env) {
  const missing = requireDatabase(request, env); if (missing) return missing;
  if (!isAdmin(request, env)) return adminError(request, env);
  if (request.method === "GET") {
    const rows = await dbAll(env, `SELECT agent_id, name, type, role, capabilities_json, status, last_heartbeat_at, current_task_id, created_at, updated_at FROM agents ORDER BY agent_id`);
    return json({ ok: true, agents: rows.map((row) => ({ ...row, capabilities: parseJson(row.capabilities_json, []) })) }, 200, request, env);
  }
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405, request, env);
  const body = await readBody(request);
  if (!body || !safeAgentId(body.agent_id)) return json({ error: "valid agent_id is required" }, 400, request, env);
  const now = new Date().toISOString();
  try { await dbRun(env, `INSERT INTO agents (agent_id, name, type, role, capabilities_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'registered', ?, ?)`, body.agent_id, text(body.name) || body.agent_id, text(body.type) || "custom", text(body.role) || "observer", JSON.stringify(Array.isArray(body.capabilities) ? body.capabilities.slice(0, 50) : []), now, now); } catch (error) { return json({ error: "agent already exists or could not be created", details: String(error).slice(0, 160) }, 409, request, env); }
  await audit(env, { actor: "admin", eventType: "agent.registered", payload: { agent_id: body.agent_id } });
  return json({ ok: true, agent_id: body.agent_id }, 201, request, env);
}

async function handleConversations(request, env, url, conversationId = null) {
  const missing = requireDatabase(request, env); if (missing) return missing;
  if (!isAdmin(request, env)) return adminError(request, env);
  if (!conversationId && request.method === "GET") {
    const includeArchived = bool(url.searchParams.get("include_archived"));
    const rows = await dbAll(env, `SELECT c.*, COALESCE((SELECT json_group_array(agent_id) FROM conversation_agents ca WHERE ca.conversation_id = c.conversation_id), '[]') AS agents_json FROM conversations c ${includeArchived ? "" : "WHERE c.archived_at IS NULL"} ORDER BY c.updated_at DESC LIMIT ?`, limitFrom(url, 100));
    return json({ ok: true, conversations: rows.map(conversationView) }, 200, request, env);
  }
  if (!conversationId && request.method === "POST") {
    const body = await readBody(request); const id = body?.conversation_id || newId("conv");
    if (!safeConversationId(id)) return json({ error: "invalid conversation_id" }, 400, request, env);
    const input = conversationInput(body || {}); if (input.error) return json(input, 400, request, env);
    const agents = Array.isArray(body.agents) ? body.agents : Array.isArray(body.agent_ids) ? body.agent_ids.map((agent_id) => ({ agent_id })) : [];
    if (!agents.length || !agents.every((item) => safeAgentId(typeof item === "string" ? item : item.agent_id))) return json({ error: "at least one valid agent is required" }, 400, request, env);
    const now = new Date().toISOString();
    try {
      await dbRun(env, `INSERT INTO conversations (conversation_id, name, goal, state, max_rounds, round_delay_seconds, poll_interval_seconds, active_hours_json, timezone, require_approval, next_run_at, created_at, updated_at, last_activity_at) VALUES (?, ?, ?, 'stopped', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, input.name, input.goal, input.max_rounds, input.round_delay_seconds, input.poll_interval_seconds, JSON.stringify(input.active_hours), input.timezone, input.require_approval ? 1 : 0, input.next_run_at, now, now, now);
      for (const item of agents) { const agentId = typeof item === "string" ? item : item.agent_id; await dbRun(env, `INSERT INTO conversation_agents (conversation_id, agent_id, role) VALUES (?, ?, ?)`, id, agentId, text(typeof item === "string" ? "" : item.role) || "participant"); }
    } catch (error) { return json({ error: "conversation could not be created", details: String(error).slice(0, 160) }, 409, request, env); }
    await audit(env, { conversationId: id, actor: "admin", eventType: "conversation.created", payload: { agents: agents.map((item) => typeof item === "string" ? item : item.agent_id) } });
    return json({ ok: true, conversation: conversationView(await getConversation(env, id)) }, 201, request, env);
  }
  if (!safeConversationId(conversationId)) return json({ error: "invalid conversation_id" }, 400, request, env);
  const row = await getConversation(env, conversationId); if (!row) return json({ error: "conversation not found" }, 404, request, env);
  const actionMatch = url.pathname.match(/\/api\/conversations\/[^/]+\/(start|pause|resume|stop)$/);
  if (actionMatch && request.method === "POST") {
    const action = actionMatch[1]; const transitions = { start: ["stopped", "paused"], pause: ["running"], resume: ["paused"], stop: ["running", "paused", "stopped"] };
    if (row.state === "archived") return json({ error: "archived conversation cannot be started" }, 409, request, env);
    if (!transitions[action].includes(row.state)) return json({ error: `cannot ${action} conversation from state ${row.state}` }, 409, request, env);
    const nextState = action === "pause" ? "paused" : action === "stop" ? "stopped" : "running"; const now = new Date().toISOString();
    const placeholders = transitions[action].map(() => "?").join(",");
    const updated = await dbRun(env, `UPDATE conversations SET state = ?, updated_at = ?, last_activity_at = ? WHERE conversation_id = ? AND state IN (${placeholders})`, nextState, now, now, conversationId, ...transitions[action]);
    if (!updated.meta?.changes) return json({ error: `conversation state changed; retry ${action}` }, 409, request, env);
    if (action === "stop") {
      await dbRun(env, `UPDATE tasks SET execution_state = 'cancelled', status = 'cancelled', finished_at = ?, updated_at = ? WHERE conversation_id = ? AND execution_state IN ('pending', 'waiting_approval')`, now, now, conversationId);
    }
    await audit(env, { conversationId, actor: "admin", eventType: `conversation.${action}`, payload: { from: row.state, to: nextState } });
    return json({ ok: true, state: nextState, conversation: conversationView(await getConversation(env, conversationId)) }, 200, request, env);
  }
  if (url.pathname.endsWith("/events") && request.method === "GET") {
    const events = await dbAll(env, `SELECT event_id, actor, event_type, payload_json, created_at FROM audit_events WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?`, conversationId, limitFrom(url));
    return json({ ok: true, conversation_id: conversationId, events: events.map((event) => ({ ...event, payload: parseJson(event.payload_json, {}) })) }, 200, request, env);
  }
  if (url.pathname.endsWith("/messages") && request.method === "GET") {
    const messages = await dbAll(env, `SELECT message_id, from_agent, to_agents_json, type, reply_to, task_id, created_at, path FROM message_index WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?`, conversationId, limitFrom(url));
    return json({ ok: true, conversation_id: conversationId, messages: messages.map((message) => ({ ...message, to: parseJson(message.to_agents_json, []) })) }, 200, request, env);
  }
  if (url.pathname.endsWith("/messages") && request.method === "POST") {
    if (!env.RELAY_PASSWORD || !env.GITHUB_TOKEN) return json({ error: "legacy relay secrets are not configured" }, 503, request, env);
    const body = await readBody(request); if (!body) return json({ error: "request body must be JSON" }, 400, request, env);
    const result = await createMessage(env, { ...body, conversation_id: conversationId, agent_id: body.agent_id || "cloud-chatgpt-01" }, env.RELAY_PASSWORD);
    if (!result.ok) return json(result, result.status === 401 ? 502 : 400, request, env);
    try { await dbRun(env, `INSERT INTO message_index (message_id, conversation_id, from_agent, to_agents_json, type, reply_to, task_id, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, result.record.id, conversationId, result.record.from, JSON.stringify(result.record.to), result.record.type, result.record.reply_to, result.record.task_id, result.path, result.record.created_at); } catch (error) { return json({ error: "message written but index update failed", index_repair_required: true, path: result.path, message_id: result.record.id, details: String(error).slice(0, 160) }, 502, request, env); }
    await audit(env, { conversationId, actor: "admin", eventType: "message.created", payload: { message_id: result.record.id, path: result.path } });
    return json({ ok: true, id: result.record.id, path: result.path, created_at: result.record.created_at }, 201, request, env);
  }
  if (request.method === "GET") return json({ ok: true, conversation: conversationView(row) }, 200, request, env);
  if (request.method === "PATCH") {
    const body = await readBody(request); const input = conversationInput(body || {}, row); if (input.error) return json(input, 400, request, env);
    const archive = body?.archived === true || body?.state === "archived"; const unarchive = body?.archived === false; const nextState = archive ? "archived" : unarchive && row.state === "archived" ? "stopped" : row.state; const archivedAt = archive ? new Date().toISOString() : unarchive ? null : row.archived_at; const now = new Date().toISOString();
    await dbRun(env, `UPDATE conversations SET name = ?, goal = ?, state = ?, max_rounds = ?, round_delay_seconds = ?, poll_interval_seconds = ?, active_hours_json = ?, timezone = ?, require_approval = ?, next_run_at = ?, archived_at = ?, updated_at = ? WHERE conversation_id = ?`, input.name, input.goal, nextState, input.max_rounds, input.round_delay_seconds, input.poll_interval_seconds, JSON.stringify(input.active_hours), input.timezone, input.require_approval ? 1 : 0, input.next_run_at, archivedAt, now, conversationId);
    await audit(env, { conversationId, actor: "admin", eventType: archive ? "conversation.archived" : unarchive ? "conversation.unarchived" : "conversation.updated", payload: { fields: Object.keys(body || {}) } });
    return json({ ok: true, conversation: conversationView(await getConversation(env, conversationId)) }, 200, request, env);
  }
  return json({ error: "method not allowed" }, 405, request, env);
}

async function handleHeartbeat(request, env) {
  const missing = requireDatabase(request, env); if (missing) return missing;
  const body = await readBody(request); const agentId = body?.agent_id;
  if (!safeAgentId(agentId)) return json({ error: "valid agent_id is required" }, 400, request, env);
  if (!isAuthenticatedAgent(request, env, agentId)) return agentError(request, env);
  const now = new Date().toISOString(); const status = ["online", "busy", "offline"].includes(body.status) ? body.status : "online";
  const result = await dbRun(env, `UPDATE agents SET status = ?, last_heartbeat_at = ?, current_task_id = ?, updated_at = ? WHERE agent_id = ?`, status, now, body.current_task_id || null, now, agentId);
  if (!result.meta?.changes) return json({ error: "agent is not registered" }, 404, request, env);
  await dbRun(env, `INSERT INTO agent_heartbeats (heartbeat_id, agent_id, status, current_task_id, created_at) VALUES (?, ?, ?, ?, ?)`, newId("hb"), agentId, status, body.current_task_id || null, now);
  return json({ ok: true, agent_id: agentId, status, last_heartbeat_at: now }, 200, request, env);
}
async function handleClaim(request, env) {
  const missing = requireDatabase(request, env); if (missing) return missing;
  const body = await readBody(request); const agentId = body?.agent_id;
  if (!safeAgentId(agentId)) return json({ error: "valid agent_id is required" }, 400, request, env);
  if (!isAuthenticatedAgent(request, env, agentId)) return agentError(request, env);
  if (!await dbFirst(env, `SELECT agent_id FROM agents WHERE agent_id = ?`, agentId)) return json({ error: "agent is not registered" }, 404, request, env);
  const now = new Date().toISOString();
  await dbRun(env, `UPDATE tasks SET execution_state = CASE WHEN attempt_count >= max_attempts THEN 'timed_out' ELSE 'pending' END, status = CASE WHEN attempt_count >= max_attempts THEN 'failed' ELSE 'queued' END, assigned_agent_id = NULL, lease_expires_at = NULL, lease_token = NULL, updated_at = ? WHERE execution_state IN ('claimed', 'running') AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`, now, now);
  const candidate = await dbFirst(env, `SELECT t.*, c.state AS conversation_state, c.active_hours_json, c.timezone, a.status AS approval_status FROM tasks t JOIN conversations c ON c.conversation_id = t.conversation_id LEFT JOIN approvals a ON a.approval_id = t.approval_id WHERE t.target_agent_id = ? AND t.execution_state = 'pending' AND t.attempt_count < t.max_attempts AND c.state = 'running' AND (t.available_at IS NULL OR t.available_at <= ?) AND (t.approval_id IS NULL OR a.status = 'approved') ORDER BY t.priority DESC, t.created_at LIMIT 1`, agentId, now);
  if (!candidate) return json({ ok: true, task: null }, 200, request, env);
  if (!activeHoursAllow(candidate.active_hours_json, candidate.timezone)) return json({ ok: true, task: null, outside_active_hours: true }, 200, request, env);
  const leaseSeconds = Math.min(Math.max(Number(body.lease_seconds || 900), 30), 3600);
  const lease = new Date(Date.now() + leaseSeconds * 1000).toISOString();
  const leaseToken = newId("lease");
  const updated = await dbRun(env, `UPDATE tasks SET execution_state = 'claimed', status = 'leased', assigned_agent_id = ?, claimed_at = ?, lease_expires_at = ?, lease_token = ?, attempt_count = attempt_count + 1, attempts = attempts + 1, updated_at = ? WHERE task_id = ? AND target_agent_id = ? AND execution_state = 'pending' AND attempt_count < max_attempts AND (available_at IS NULL OR available_at <= ?) AND EXISTS (SELECT 1 FROM conversations c WHERE c.conversation_id = tasks.conversation_id AND c.state = 'running') AND (tasks.approval_id IS NULL OR EXISTS (SELECT 1 FROM approvals a WHERE a.approval_id = tasks.approval_id AND a.status = 'approved'))`, agentId, now, lease, leaseToken, now, candidate.task_id, agentId, now);
  if (!updated.meta?.changes) return json({ ok: true, task: null, retry: true }, 200, request, env);
  const claimed = await getTask(env, candidate.task_id);
  return json({ ok: true, task: taskView({ ...claimed, lease_token: leaseToken, assigned_agent_id: agentId, execution_state: "claimed", approval_status: candidate.approval_status }, true) }, 200, request, env);
}
async function handleTaskAction(request, env, taskId, action) {
  const missing = requireDatabase(request, env); if (missing) return missing;
  if (!safeId(taskId)) return json({ error: "invalid task_id" }, 400, request, env);
  const body = await readBody(request); const agentId = body?.agent_id;
  if (!safeAgentId(agentId) || !isAuthenticatedAgent(request, env, agentId)) return agentError(request, env);
  const task = await dbFirst(env, `SELECT * FROM tasks WHERE task_id = ?`, taskId); if (!task) return json({ error: "task not found" }, 404, request, env);
  if (task.assigned_agent_id !== agentId) return json({ error: "task is assigned to another agent" }, 403, request, env);
  const resultId = action === "result" ? text(body.result_id) : "";
  if (action === "result" && body.result_id !== undefined && !safeId(resultId)) return json({ error: "result_id must be a valid id" }, 400, request, env);
  if (action === "result" && resultId && task.result_id === resultId && ["succeeded", "failed", "timed_out", "cancelled"].includes(task.execution_state)) {
    return json({ ok: true, task_id: taskId, status: task.execution_state, result_id: resultId, idempotent_replay: true }, 200, request, env);
  }
  if (!body.lease_token || body.lease_token !== task.lease_token) return json({ error: "valid lease_token is required" }, 403, request, env);
  const now = new Date().toISOString();
  if (action === "ack") {
    const updated = await dbRun(env, `UPDATE tasks SET execution_state = 'running', status = 'running', started_at = COALESCE(started_at, ?), updated_at = ? WHERE task_id = ? AND assigned_agent_id = ? AND lease_token = ? AND execution_state = 'claimed' AND lease_expires_at > ?`, now, now, taskId, agentId, body.lease_token, now);
    if (!updated.meta?.changes) return json({ error: "task lease is invalid or expired" }, 409, request, env);
    return json({ ok: true, task_id: taskId, status: "running" }, 200, request, env);
  }
  if (action === "renew") {
    const leaseSeconds = Math.min(Math.max(Number(body.lease_seconds || 900), 30), 3600);
    const lease = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    const updated = await dbRun(env, `UPDATE tasks SET lease_expires_at = ?, updated_at = ? WHERE task_id = ? AND assigned_agent_id = ? AND lease_token = ? AND execution_state IN ('claimed', 'running') AND lease_expires_at > ?`, lease, now, taskId, agentId, body.lease_token, now);
    if (!updated.meta?.changes) return json({ error: "task lease is invalid or expired" }, 409, request, env);
    return json({ ok: true, task_id: taskId, lease_expires_at: lease }, 200, request, env);
  }
  const requestedStatus = body.status === "timed_out" ? "timed_out" : body.status === "failed" ? "failed" : "succeeded";
  let updated;
  try {
    updated = await dbRun(env, `UPDATE tasks SET execution_state = ?, status = ?, result_id = ?, result_json = ?, result_summary = ?, error_text = ?, error_code = ?, finished_at = ?, lease_expires_at = NULL, lease_token = NULL, updated_at = ? WHERE task_id = ? AND assigned_agent_id = ? AND lease_token = ? AND execution_state IN ('claimed', 'running') AND lease_expires_at > ?`, requestedStatus, taskStateToLegacyStatus(requestedStatus), resultId || null, JSON.stringify(body.result ?? null), text(body.result_summary).slice(0, 10000), body.error ? text(body.error).slice(0, 2000) : null, text(body.error_code).slice(0, 80) || null, now, taskId, agentId, body.lease_token, now);
  } catch (error) {
    return json({ error: "task result could not be recorded", details: String(error).slice(0, 180) }, 409, request, env);
  }
  if (!updated.meta?.changes) return json({ error: "task lease is invalid, expired, or already completed" }, 409, request, env);
  await audit(env, { conversationId: task.conversation_id, actor: agentId, eventType: `task.${requestedStatus}`, payload: { task_id: taskId } });
  let message = null;
  if (env.RELAY_PASSWORD && env.GITHUB_TOKEN && text(body.result_summary)) {
    const members = await conversationAgents(env, task.conversation_id);
    const recipients = members.map((item) => item.agent_id).filter((id) => id !== agentId);
    if (recipients.length) {
      const written = await createMessage(env, { agent_id: agentId, to: recipients, conversation_id: task.conversation_id, type: requestedStatus === "succeeded" ? "result" : "question", task_id: taskId, content: text(body.result_summary) }, env.RELAY_PASSWORD);
      if (written.ok) {
        try {
          await dbRun(env, `INSERT INTO message_index (message_id, conversation_id, from_agent, to_agents_json, type, reply_to, task_id, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, written.record.id, task.conversation_id, written.record.from, JSON.stringify(written.record.to), written.record.type, written.record.reply_to, taskId, written.path, written.record.created_at);
          message = { id: written.record.id, path: written.path };
        } catch (error) {
          message = { id: written.record.id, path: written.path, index_repair_required: true, details: String(error).slice(0, 160) };
        }
      } else {
        message = { message_write_failed: true, details: written.error || "message write failed" };
      }
    }
  }
  return json({ ok: true, task_id: taskId, status: requestedStatus, result_id: resultId || null, message }, 200, request, env);
}
async function handleApprovals(request, env, url, approvalId = null) {
  const missing = requireDatabase(request, env); if (missing) return missing;
  if (!isAdmin(request, env)) return adminError(request, env);
  if (request.method === "GET") { const rows = await dbAll(env, `SELECT approval_id, task_id, conversation_id, requested_by, risk_level, operation, files_json, impact, status, decision_by, decided_at, created_at FROM approvals ${approvalId ? "WHERE approval_id = ?" : "WHERE status = 'pending'"} ORDER BY created_at DESC LIMIT ?`, ...(approvalId ? [approvalId, limitFrom(url)] : [limitFrom(url)])); return json({ ok: true, approvals: rows.map((row) => ({ ...row, files: parseJson(row.files_json, []) })) }, 200, request, env); }
  if (!approvalId || request.method !== "POST") return json({ error: "use POST /api/approvals/:approval_id/decision" }, 405, request, env);
  const body = await readBody(request); const decision = body?.decision; if (!["approved", "rejected"].includes(decision)) return json({ error: "decision must be approved or rejected" }, 400, request, env);
  const now = new Date().toISOString(); const result = await dbRun(env, `UPDATE approvals SET status = ?, decision_by = ?, decided_at = ? WHERE approval_id = ? AND status = 'pending'`, decision, "admin", now, approvalId);
  if (!result.meta?.changes) return json({ error: "approval not found or already decided" }, 409, request, env);
  const approval = await dbFirst(env, `SELECT task_id, conversation_id FROM approvals WHERE approval_id = ?`, approvalId);
  if (approval) {
    if (decision === "approved") await dbRun(env, `UPDATE tasks SET execution_state = 'pending', status = 'queued', updated_at = ? WHERE task_id = ? AND execution_state = 'waiting_approval'`, now, approval.task_id);
    else await dbRun(env, `UPDATE tasks SET execution_state = 'cancelled', status = 'cancelled', finished_at = ?, updated_at = ? WHERE task_id = ? AND execution_state = 'waiting_approval'`, now, now, approval.task_id);
    await audit(env, { conversationId: approval.conversation_id, actor: "admin", eventType: `approval.${decision}`, payload: { approval_id: approvalId, task_id: approval.task_id } });
  }
  return json({ ok: true, approval_id: approvalId, status: decision, decided_at: now }, 200, request, env);
}

async function routeApi(request, env, url) {
  if (url.pathname === "/api/agents") return handleAgents(request, env);
  if (url.pathname === "/api/agent/heartbeat" && request.method === "POST") return handleHeartbeat(request, env);
  if (url.pathname === "/api/agent/claim" && request.method === "POST") return handleClaim(request, env);
  const taskMatch = url.pathname.match(/^\/api\/agent\/tasks\/([^/]+)\/(ack|renew|result)$/); if (taskMatch && request.method === "POST") return handleTaskAction(request, env, taskMatch[1], taskMatch[2]);
  const approvalMatch = url.pathname.match(/^\/api\/approvals(?:\/([^/]+)\/decision)?$/); if (approvalMatch) return handleApprovals(request, env, url, approvalMatch[1] || null);
  if (url.pathname === "/api/conversations") return handleConversations(request, env, url);
  const taskCreateMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/tasks$/); if (taskCreateMatch && request.method === "POST") return handleTaskCreate(request, env, taskCreateMatch[1]);
  const taskListMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/tasks$/); if (taskListMatch && request.method === "GET") return handleTaskList(request, env, url, taskListMatch[1]);
  const taskGetMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/); if (taskGetMatch && request.method === "GET") return handleTaskGet(request, env, taskGetMatch[1]);
  const conversationMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)(?:\/(start|pause|resume|stop|events|messages))?$/); if (conversationMatch) return handleConversations(request, env, url, conversationMatch[1]);
  return json({ error: "unknown management endpoint" }, 404, request, env);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true, service: "ai-relay-writer" }, 200, request, env);
    if (url.pathname.startsWith("/api/")) { try { return await routeApi(request, env, url); } catch (error) { return json({ error: "management request failed", details: String(error).slice(0, 240) }, 500, request, env); } }
    if (request.method === "GET" && url.pathname === "/read") { try { return await handleLegacyRead(request, env, url); } catch (error) { return json({ error: "read failed", details: String(error).slice(0, 240) }, 500, request, env); } }
    if (request.method !== "POST" || url.pathname !== "/write") return json({ error: "use POST /write, GET /read, GET /health, or /api/*" }, 404, request, env);
    if (!env.RELAY_PASSWORD || !env.GITHUB_TOKEN) return json({ error: "worker secrets are not configured" }, 500, request, env);
    const body = await readBody(request); if (!body) return json({ error: "request body must be JSON" }, 400, request, env);
    // Passwords are accepted only in the header. This keeps secrets out of request bodies and logs.
    if (request.headers.get("X-Relay-Password") !== env.RELAY_PASSWORD) return json({ error: "invalid relay password" }, 401, request, env);
    try { const result = await createMessage(env, body, env.RELAY_PASSWORD); if (!result.ok) return json(result, result.status === 401 ? 502 : 400, request, env); return json({ ok: true, id: result.record.id, path: result.path, created_at: result.record.created_at }, 200, request, env); } catch (error) { return json({ error: "write failed", details: String(error).slice(0, 240) }, 500, request, env); }
  },
};

export { decryptText, encryptText, safeAgentId, safeConversationId };
