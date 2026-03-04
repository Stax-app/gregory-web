-- GREGORY — Weekly Intelligence Cache
-- Stores aggregated data briefs from all sources, updated weekly.
-- Gregory references this cache for contextual awareness without
-- needing to make live API calls for background knowledge.

CREATE TABLE IF NOT EXISTS intelligence_cache (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  category TEXT NOT NULL,  -- 'macro_economic', 'market_snapshot', 'news_digest', 'academic_trends', 'job_market', 'patent_activity'
  title TEXT NOT NULL,
  content TEXT NOT NULL,    -- The curated intelligence brief (markdown)
  data_sources TEXT[] NOT NULL DEFAULT '{}',  -- Which APIs contributed
  data_date DATE NOT NULL,  -- The date this data represents
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- No RLS — this is shared data accessible to all agents
-- Unique constraint for upsert (one brief per category per date)
ALTER TABLE intelligence_cache ADD CONSTRAINT uq_intelligence_category_date UNIQUE (category, data_date);

CREATE INDEX idx_intelligence_cache_category ON intelligence_cache(category);
CREATE INDEX idx_intelligence_cache_date ON intelligence_cache(data_date DESC);

-- Keep only last 12 weeks of data per category (auto-cleanup handled by the weekly update function)
