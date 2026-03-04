-- GREGORY — Agentic Task Tables
-- Creates tables for task state, user memory, and document metadata

-- ════════════════════════════════════════
-- Tasks: persists agentic task state across Edge Function invocations
-- ════════════════════════════════════════
CREATE TABLE IF NOT EXISTS tasks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) NOT NULL,
  title TEXT NOT NULL,
  plan JSONB NOT NULL DEFAULT '{}',
  current_step_index INTEGER DEFAULT 0,
  step_results JSONB DEFAULT '{}'::jsonb,
  accumulated_context TEXT DEFAULT '',
  status TEXT DEFAULT 'planning'
    CHECK (status IN ('planning', 'awaiting_approval', 'executing', 'checkpoint', 'completed', 'failed', 'aborted')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY tasks_owner_select ON tasks FOR SELECT USING (user_id = auth.uid());
CREATE POLICY tasks_owner_insert ON tasks FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY tasks_owner_update ON tasks FOR UPDATE USING (user_id = auth.uid());
CREATE POLICY tasks_owner_delete ON tasks FOR DELETE USING (user_id = auth.uid());

-- ════════════════════════════════════════
-- User Memory: persistent facts/preferences across sessions
-- ════════════════════════════════════════
CREATE TABLE IF NOT EXISTS user_memory (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) NOT NULL,
  category TEXT NOT NULL,  -- 'company_info', 'preferences', 'prior_findings'
  content TEXT NOT NULL,
  source_task_id UUID REFERENCES tasks(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE user_memory ENABLE ROW LEVEL SECURITY;

CREATE POLICY memory_owner_select ON user_memory FOR SELECT USING (user_id = auth.uid());
CREATE POLICY memory_owner_insert ON user_memory FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY memory_owner_update ON user_memory FOR UPDATE USING (user_id = auth.uid());
CREATE POLICY memory_owner_delete ON user_memory FOR DELETE USING (user_id = auth.uid());

CREATE INDEX idx_user_memory_user_category ON user_memory(user_id, category);
CREATE INDEX idx_user_memory_created ON user_memory(user_id, created_at DESC);

-- ════════════════════════════════════════
-- Documents: metadata for uploaded files (stored in Supabase Storage)
-- ════════════════════════════════════════
CREATE TABLE IF NOT EXISTS documents (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY documents_owner_select ON documents FOR SELECT USING (user_id = auth.uid());
CREATE POLICY documents_owner_insert ON documents FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY documents_owner_delete ON documents FOR DELETE USING (user_id = auth.uid());

-- ════════════════════════════════════════
-- Storage Bucket for document uploads
-- ════════════════════════════════════════
INSERT INTO storage.buckets (id, name, public)
VALUES ('documents', 'documents', false)
ON CONFLICT (id) DO NOTHING;
