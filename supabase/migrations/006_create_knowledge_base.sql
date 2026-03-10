-- GREGORY — Knowledge Base & Intelligence Expansion
-- Massive database upgrade: company intel, industry tracking, trend time-series,
-- research cache, conversation analytics, source registry, data freshness,
-- user preferences, research threads, and Google Sheets integration.

-- ════════════════════════════════════════
-- 1. Company Knowledge Base
-- Persists everything Gregory learns about any company.
-- Next time someone asks about Nike, Gregory already knows.
-- ════════════════════════════════════════
CREATE TABLE IF NOT EXISTS company_intel (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  ticker TEXT,                        -- Stock ticker if public (e.g. AAPL)
  company_name TEXT NOT NULL,
  industry TEXT,
  sector TEXT,
  market_cap_bucket TEXT,             -- 'mega', 'large', 'mid', 'small', 'micro'
  headquarters TEXT,
  summary TEXT,                       -- AI-generated 2-3 sentence summary
  financials JSONB DEFAULT '{}',      -- Latest financial snapshot
  competitors TEXT[] DEFAULT '{}',    -- Known competitor tickers/names
  key_people JSONB DEFAULT '[]',      -- [{name, role, since}]
  recent_news JSONB DEFAULT '[]',     -- [{title, date, source, summary}]
  swot JSONB DEFAULT '{}',            -- {strengths:[], weaknesses:[], opportunities:[], threats:[]}
  moat_analysis TEXT,                 -- Competitive advantage analysis
  tags TEXT[] DEFAULT '{}',           -- Searchable tags
  data_quality_score REAL DEFAULT 0.5, -- 0-1 how complete/fresh the data is
  last_researched_at TIMESTAMPTZ,
  last_researched_by UUID,            -- user who triggered the research
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- No RLS — shared knowledge base accessible to all users
CREATE UNIQUE INDEX idx_company_intel_ticker ON company_intel(ticker) WHERE ticker IS NOT NULL;
CREATE UNIQUE INDEX idx_company_intel_name ON company_intel(LOWER(company_name));
CREATE INDEX idx_company_intel_industry ON company_intel(industry);
CREATE INDEX idx_company_intel_sector ON company_intel(sector);
CREATE INDEX idx_company_intel_tags ON company_intel USING GIN(tags);
CREATE INDEX idx_company_intel_updated ON company_intel(updated_at DESC);

-- ════════════════════════════════════════
-- 2. Industry Briefs
-- Sector-specific intelligence auto-generated and refreshed.
-- ════════════════════════════════════════
CREATE TABLE IF NOT EXISTS industry_briefs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  industry TEXT NOT NULL,             -- 'saas', 'cpg', 'fintech', 'healthcare', 'ecommerce', 'media', etc.
  title TEXT NOT NULL,
  content TEXT NOT NULL,              -- Markdown brief
  key_metrics JSONB DEFAULT '{}',     -- {market_size, growth_rate, avg_cac, avg_ltv, etc.}
  top_companies TEXT[] DEFAULT '{}',  -- Top companies in this industry
  trends TEXT[] DEFAULT '{}',         -- Current trends
  challenges TEXT[] DEFAULT '{}',     -- Current challenges
  data_sources TEXT[] DEFAULT '{}',
  data_date DATE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE industry_briefs ADD CONSTRAINT uq_industry_brief_date UNIQUE (industry, data_date);
CREATE INDEX idx_industry_briefs_industry ON industry_briefs(industry);
CREATE INDEX idx_industry_briefs_date ON industry_briefs(data_date DESC);

-- ════════════════════════════════════════
-- 3. Metric Snapshots (Time-Series)
-- Track key metrics over time so Gregory can identify trends.
-- ════════════════════════════════════════
CREATE TABLE IF NOT EXISTS metric_snapshots (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  metric_name TEXT NOT NULL,          -- 'sp500', 'consumer_sentiment', 'cpi', 'digital_ad_spend', etc.
  metric_category TEXT NOT NULL,      -- 'market', 'economic', 'advertising', 'consumer', 'employment'
  value REAL NOT NULL,
  unit TEXT,                          -- '%', 'USD', 'index', 'basis_points'
  period TEXT,                        -- 'daily', 'weekly', 'monthly'
  data_date DATE NOT NULL,
  source TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',        -- Additional context
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE metric_snapshots ADD CONSTRAINT uq_metric_date UNIQUE (metric_name, data_date);
CREATE INDEX idx_metric_snapshots_name ON metric_snapshots(metric_name);
CREATE INDEX idx_metric_snapshots_category ON metric_snapshots(metric_category);
CREATE INDEX idx_metric_snapshots_date ON metric_snapshots(data_date DESC);
CREATE INDEX idx_metric_snapshots_lookup ON metric_snapshots(metric_name, data_date DESC);

-- ════════════════════════════════════════
-- 4. Research Cache
-- Persist valuable tool call results across sessions.
-- Much longer TTL than the in-memory 5-min cache.
-- ════════════════════════════════════════
CREATE TABLE IF NOT EXISTS research_cache (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  cache_key TEXT NOT NULL UNIQUE,     -- tool_name:hash(input)
  tool_name TEXT NOT NULL,
  input_hash TEXT NOT NULL,           -- SHA-256 of input JSON
  input_summary TEXT,                 -- Human-readable summary of what was queried
  result JSONB NOT NULL,              -- The full tool result
  quality_score REAL DEFAULT 0.5,     -- 0-1 quality of this data
  access_count INTEGER DEFAULT 1,     -- How many times this has been accessed
  last_accessed_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,    -- Auto-expiry (varies by tool)
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_research_cache_key ON research_cache(cache_key);
CREATE INDEX idx_research_cache_tool ON research_cache(tool_name);
CREATE INDEX idx_research_cache_expires ON research_cache(expires_at);
CREATE INDEX idx_research_cache_popular ON research_cache(access_count DESC);

-- ════════════════════════════════════════
-- 5. Conversation Analytics
-- Track usage patterns to optimize Gregory's intelligence.
-- ════════════════════════════════════════
CREATE TABLE IF NOT EXISTS conversation_analytics (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID,                       -- NULL for anonymous
  session_id TEXT NOT NULL,           -- Groups messages in a session
  agent_used TEXT,                    -- Which agent handled this
  topic_tags TEXT[] DEFAULT '{}',     -- AI-extracted topics
  tools_used TEXT[] DEFAULT '{}',     -- Which tools were invoked
  tool_call_count INTEGER DEFAULT 0,
  message_count INTEGER DEFAULT 0,
  mode TEXT DEFAULT 'simple',         -- 'simple' or 'agentic'
  task_id UUID,                       -- If agentic, link to task
  duration_ms INTEGER,                -- How long the interaction took
  satisfaction_signal TEXT,           -- 'positive', 'negative', 'neutral', 'unknown'
  query_complexity TEXT,              -- 'simple', 'moderate', 'complex'
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- No RLS — analytics are platform-wide
CREATE INDEX idx_analytics_user ON conversation_analytics(user_id);
CREATE INDEX idx_analytics_agent ON conversation_analytics(agent_used);
CREATE INDEX idx_analytics_topics ON conversation_analytics USING GIN(topic_tags);
CREATE INDEX idx_analytics_created ON conversation_analytics(created_at DESC);
CREATE INDEX idx_analytics_session ON conversation_analytics(session_id);

-- ════════════════════════════════════════
-- 6. Source Authority Registry
-- Persistent quality scores per data source.
-- Gregory learns which sources are trustworthy over time.
-- ════════════════════════════════════════
CREATE TABLE IF NOT EXISTS source_registry (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  source_name TEXT NOT NULL UNIQUE,   -- 'tavily', 'fmp', 'fred', 'semantic_scholar', etc.
  source_type TEXT NOT NULL,          -- 'api', 'website', 'database', 'academic', 'government', 'news'
  authority_score REAL DEFAULT 0.5,   -- 0-1 overall quality rating
  reliability_score REAL DEFAULT 0.5, -- 0-1 uptime/consistency
  freshness_score REAL DEFAULT 0.5,   -- 0-1 how current the data is
  total_queries INTEGER DEFAULT 0,    -- Total times queried
  successful_queries INTEGER DEFAULT 0, -- Successful responses
  avg_response_ms INTEGER,            -- Average response time
  last_queried_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  notes TEXT,                         -- Any known limitations
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_source_registry_type ON source_registry(source_type);
CREATE INDEX idx_source_registry_authority ON source_registry(authority_score DESC);

-- Seed with known sources
INSERT INTO source_registry (source_name, source_type, authority_score, reliability_score, freshness_score, notes) VALUES
  ('fred', 'government', 0.95, 0.95, 0.8, 'Federal Reserve Economic Data — gold standard for US economic indicators'),
  ('fmp', 'api', 0.85, 0.9, 0.95, 'Financial Modeling Prep — real-time market data, company financials'),
  ('tavily', 'api', 0.7, 0.85, 0.95, 'Web search API — broad coverage, variable quality per result'),
  ('semantic_scholar', 'academic', 0.9, 0.85, 0.7, '220M+ peer-reviewed papers — excellent for academic citations'),
  ('crossref', 'academic', 0.95, 0.9, 0.7, 'DOI registry — definitive citation verification'),
  ('gdelt', 'database', 0.7, 0.8, 0.95, 'Global news monitoring — real-time sentiment, high volume'),
  ('newsdata', 'news', 0.65, 0.8, 0.9, 'News aggregator — business/tech focus'),
  ('sec_edgar', 'government', 0.95, 0.9, 0.85, 'SEC filings — authoritative corporate disclosures'),
  ('bls', 'government', 0.95, 0.9, 0.7, 'Bureau of Labor Statistics — employment, wages, CPI'),
  ('world_bank', 'government', 0.9, 0.85, 0.6, 'World Bank Open Data — global development indicators'),
  ('google_patents', 'government', 0.85, 0.85, 0.8, 'Patent search — innovation tracking'),
  ('jina_reader', 'api', 0.6, 0.8, 0.95, 'Web scraper — quality depends on target site'),
  ('google_sheets', 'database', 0.8, 0.9, 0.9, 'User-curated data via Google Sheets')
ON CONFLICT (source_name) DO NOTHING;

-- ════════════════════════════════════════
-- 7. Data Freshness Tracking
-- Gregory knows exactly when each data source was last updated.
-- ════════════════════════════════════════
CREATE TABLE IF NOT EXISTS data_freshness (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  data_type TEXT NOT NULL UNIQUE,     -- 'intelligence_cache', 'company_intel', 'metric_snapshots', etc.
  last_updated_at TIMESTAMPTZ NOT NULL,
  update_frequency TEXT NOT NULL,     -- 'daily', 'weekly', 'monthly', 'on_demand'
  next_update_at TIMESTAMPTZ,
  records_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'healthy',      -- 'healthy', 'stale', 'error', 'updating'
  last_error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO data_freshness (data_type, last_updated_at, update_frequency, status) VALUES
  ('intelligence_cache', NOW(), 'daily', 'healthy'),
  ('company_intel', NOW(), 'on_demand', 'healthy'),
  ('industry_briefs', NOW(), 'weekly', 'healthy'),
  ('metric_snapshots', NOW(), 'daily', 'healthy'),
  ('research_cache', NOW(), 'on_demand', 'healthy'),
  ('source_registry', NOW(), 'on_demand', 'healthy')
ON CONFLICT (data_type) DO NOTHING;

-- ════════════════════════════════════════
-- 8. Structured User Preferences
-- Separate from freeform memories for structured, queryable prefs.
-- ════════════════════════════════════════
CREATE TABLE IF NOT EXISTS user_preferences (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) NOT NULL UNIQUE,
  industries_of_interest TEXT[] DEFAULT '{}',    -- ['saas', 'fintech', 'cpg']
  companies_tracked TEXT[] DEFAULT '{}',          -- ['AAPL', 'GOOGL', 'Nike']
  competitors TEXT[] DEFAULT '{}',                -- Their competitors
  preferred_detail_level TEXT DEFAULT 'detailed', -- 'brief', 'detailed', 'exhaustive'
  report_format TEXT DEFAULT 'markdown',          -- 'markdown', 'bullets', 'executive_summary'
  focus_areas TEXT[] DEFAULT '{}',                -- ['pricing', 'gtm', 'brand', 'compliance']
  notification_topics TEXT[] DEFAULT '{}',        -- Topics to proactively alert about
  custom_data JSONB DEFAULT '{}',                 -- Any additional structured preferences
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY prefs_owner_select ON user_preferences FOR SELECT USING (user_id = auth.uid());
CREATE POLICY prefs_owner_insert ON user_preferences FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY prefs_owner_update ON user_preferences FOR UPDATE USING (user_id = auth.uid());
CREATE POLICY prefs_owner_delete ON user_preferences FOR DELETE USING (user_id = auth.uid());

-- ════════════════════════════════════════
-- 9. Research Threads
-- Link related conversations across sessions.
-- ════════════════════════════════════════
CREATE TABLE IF NOT EXISTS research_threads (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) NOT NULL,
  title TEXT NOT NULL,                -- AI-generated thread title
  topic_tags TEXT[] DEFAULT '{}',     -- Topics this thread covers
  related_companies TEXT[] DEFAULT '{}', -- Companies discussed
  related_industries TEXT[] DEFAULT '{}', -- Industries discussed
  conversation_ids TEXT[] DEFAULT '{}',  -- Session IDs that belong to this thread
  task_ids UUID[] DEFAULT '{}',       -- Linked task IDs
  summary TEXT,                       -- AI-generated running summary
  insight_count INTEGER DEFAULT 0,    -- How many insights extracted
  status TEXT DEFAULT 'active',       -- 'active', 'archived', 'merged'
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE research_threads ENABLE ROW LEVEL SECURITY;
CREATE POLICY threads_owner_select ON research_threads FOR SELECT USING (user_id = auth.uid());
CREATE POLICY threads_owner_insert ON research_threads FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY threads_owner_update ON research_threads FOR UPDATE USING (user_id = auth.uid());
CREATE POLICY threads_owner_delete ON research_threads FOR DELETE USING (user_id = auth.uid());

CREATE INDEX idx_research_threads_user ON research_threads(user_id);
CREATE INDEX idx_research_threads_topics ON research_threads USING GIN(topic_tags);
CREATE INDEX idx_research_threads_companies ON research_threads USING GIN(related_companies);
CREATE INDEX idx_research_threads_status ON research_threads(status);

-- ════════════════════════════════════════
-- 10. Google Sheets Data Sources
-- Registry of external Google Sheets that feed data into Gregory.
-- ════════════════════════════════════════
CREATE TABLE IF NOT EXISTS sheets_data_sources (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  sheet_id TEXT NOT NULL,             -- Google Sheets document ID
  sheet_name TEXT,                    -- Specific tab/sheet name
  title TEXT NOT NULL,                -- Human-readable name
  description TEXT,                   -- What this data contains
  category TEXT NOT NULL,             -- 'market_data', 'competitor_intel', 'industry_benchmarks', 'custom'
  data_schema JSONB DEFAULT '{}',     -- Expected columns and types
  last_synced_at TIMESTAMPTZ,
  sync_frequency TEXT DEFAULT 'daily', -- 'hourly', 'daily', 'weekly', 'manual'
  row_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',       -- 'active', 'paused', 'error'
  last_error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_sheets_sources_category ON sheets_data_sources(category);
CREATE INDEX idx_sheets_sources_status ON sheets_data_sources(status);

-- ════════════════════════════════════════
-- 11. Sheets Synced Data
-- Actual data rows synced from Google Sheets.
-- ════════════════════════════════════════
CREATE TABLE IF NOT EXISTS sheets_synced_data (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  source_id UUID REFERENCES sheets_data_sources(id) ON DELETE CASCADE NOT NULL,
  row_data JSONB NOT NULL,            -- The actual row data as key-value pairs
  row_index INTEGER,                  -- Original row number in the sheet
  data_date DATE,                     -- If the data has a date dimension
  synced_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_sheets_data_source ON sheets_synced_data(source_id);
CREATE INDEX idx_sheets_data_date ON sheets_synced_data(data_date DESC);
CREATE INDEX idx_sheets_data_row ON sheets_synced_data USING GIN(row_data);

-- ════════════════════════════════════════
-- 12. Expand intelligence_cache categories
-- Add new categories to support daily intelligence
-- ════════════════════════════════════════
-- (No schema change needed — category is TEXT, new values are added by the update function)

-- ════════════════════════════════════════
-- Cleanup: auto-expire research cache entries
-- ════════════════════════════════════════
-- Note: Expiry is handled in application code during reads. No pg_cron needed.
