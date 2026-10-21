-- AI funnel builder: one row per generation (prompt, assumptions, model, token use, validation report, checkpoint state) for audit, resume and "regenerate step".
CREATE TABLE IF NOT EXISTS ai_generations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT,
  kind TEXT NOT NULL DEFAULT 'funnel',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),
  provider TEXT NOT NULL DEFAULT 'heuristic',
  model TEXT,
  source TEXT,
  prompt TEXT NOT NULL DEFAULT '',
  input_json TEXT NOT NULL DEFAULT '{}',
  brief_json TEXT,
  assumptions_json TEXT NOT NULL DEFAULT '[]',
  strategy_json TEXT,
  stages_json TEXT NOT NULL DEFAULT '[]',
  state_json TEXT NOT NULL DEFAULT '{}',
  report_json TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  llm_calls INTEGER NOT NULL DEFAULT 0,
  funnel_id TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ai_generations_ws ON ai_generations(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_generations_funnel ON ai_generations(funnel_id);
