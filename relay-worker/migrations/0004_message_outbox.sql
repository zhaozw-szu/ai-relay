-- Durable task-result message delivery.
-- The encrypted record and deterministic GitHub path are stored before the
-- first delivery attempt so retries never execute the task again or create a
-- second message.

CREATE TABLE IF NOT EXISTS message_outbox (
  outbox_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(task_id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  from_agent TEXT NOT NULL,
  to_agents_json TEXT NOT NULL DEFAULT '[]',
  type TEXT NOT NULL,
  reply_to TEXT,
  path TEXT NOT NULL,
  record_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'index_pending', 'delivered')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_message_outbox_status_attempt
  ON message_outbox(status, next_attempt_at, created_at);
