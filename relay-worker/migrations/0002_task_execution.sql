-- AI Relay Control Center v1.0 phase 2.
-- Additive migration: the original 0001 tasks columns remain for compatibility.

ALTER TABLE tasks ADD COLUMN target_agent_id TEXT;
ALTER TABLE tasks ADD COLUMN instruction TEXT NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN task_type TEXT NOT NULL DEFAULT 'read_only_analysis';
ALTER TABLE tasks ADD COLUMN working_directory_id TEXT;
ALTER TABLE tasks ADD COLUMN sandbox_mode TEXT NOT NULL DEFAULT 'read-only';
ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 50;
ALTER TABLE tasks ADD COLUMN available_at TEXT;
ALTER TABLE tasks ADD COLUMN claimed_at TEXT;
ALTER TABLE tasks ADD COLUMN lease_token TEXT;
ALTER TABLE tasks ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN started_at TEXT;
ALTER TABLE tasks ADD COLUMN finished_at TEXT;
ALTER TABLE tasks ADD COLUMN result_summary TEXT;
ALTER TABLE tasks ADD COLUMN error_code TEXT;
ALTER TABLE tasks ADD COLUMN approval_id TEXT;
ALTER TABLE tasks ADD COLUMN execution_state TEXT NOT NULL DEFAULT 'pending';

UPDATE tasks
SET execution_state = CASE status
  WHEN 'leased' THEN 'claimed'
  WHEN 'running' THEN 'running'
  WHEN 'succeeded' THEN 'succeeded'
  WHEN 'failed' THEN 'failed'
  WHEN 'cancelled' THEN 'cancelled'
  ELSE 'pending'
END,
attempt_count = attempts;

CREATE INDEX IF NOT EXISTS idx_tasks_execution_claim
  ON tasks(execution_state, target_agent_id, available_at, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_lease
  ON tasks(lease_expires_at, lease_token);
CREATE INDEX IF NOT EXISTS idx_tasks_approval
  ON tasks(approval_id, execution_state);
