-- Make result delivery retryable after a response is lost.
-- A result_id is optional for compatibility with older agents, but when
-- present it uniquely identifies one task result and makes POST /result safe
-- to repeat after a network failure.

ALTER TABLE tasks ADD COLUMN result_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_result_id
  ON tasks(result_id)
  WHERE result_id IS NOT NULL;
