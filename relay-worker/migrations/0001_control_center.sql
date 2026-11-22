-- AI Relay Control Center v1.0
-- D1/SQLite schema. Apply with: wrangler d1 migrations apply ai-relay-control --remote

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'custom',
  role TEXT NOT NULL DEFAULT 'observer',
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'registered' CHECK (status IN ('registered', 'online', 'busy', 'offline')),
  last_heartbeat_at TEXT,
  current_task_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  conversation_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'stopped' CHECK (state IN ('stopped', 'running', 'paused', 'archived')),
  max_rounds INTEGER NOT NULL DEFAULT 10,
  round_delay_seconds INTEGER NOT NULL DEFAULT 300,
  poll_interval_seconds INTEGER NOT NULL DEFAULT 60,
  active_hours_json TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  require_approval INTEGER NOT NULL DEFAULT 0 CHECK (require_approval IN (0, 1)),
  next_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_activity_at TEXT,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS conversation_agents (
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  role TEXT NOT NULL DEFAULT 'participant',
  PRIMARY KEY (conversation_id, agent_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'message',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'leased', 'running', 'succeeded', 'failed', 'cancelled')),
  idempotency_key TEXT NOT NULL UNIQUE,
  requested_by TEXT NOT NULL,
  assigned_agent_id TEXT REFERENCES agents(agent_id),
  payload_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  error_text TEXT,
  lease_expires_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  approval_required INTEGER NOT NULL DEFAULT 0 CHECK (approval_required IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS message_index (
  message_id TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(conversation_id) ON DELETE SET NULL,
  from_agent TEXT NOT NULL,
  to_agents_json TEXT NOT NULL DEFAULT '[]',
  type TEXT NOT NULL,
  reply_to TEXT,
  task_id TEXT,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL,
  risk_level TEXT NOT NULL DEFAULT 'medium',
  operation TEXT NOT NULL,
  files_json TEXT NOT NULL DEFAULT '[]',
  impact TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  decision_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_heartbeats (
  heartbeat_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  current_task_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  event_id TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversations_state_updated ON conversations(state, updated_at);
CREATE INDEX IF NOT EXISTS idx_conversation_agents_agent ON conversation_agents(agent_id, conversation_id);
CREATE INDEX IF NOT EXISTS idx_tasks_claimable ON tasks(status, lease_expires_at, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_conversation ON tasks(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_message_index_conversation ON message_index(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_approvals_status_created ON approvals(status, created_at);
CREATE INDEX IF NOT EXISTS idx_heartbeats_agent_created ON agent_heartbeats(agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_conversation_created ON audit_events(conversation_id, created_at);
