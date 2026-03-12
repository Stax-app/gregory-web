CREATE TABLE IF NOT EXISTS staxlabs_content (
  id TEXT PRIMARY KEY DEFAULT 'stax-' || extract(epoch from now())::bigint::text || '-' || substr(md5(random()::text), 1, 6),
  content_type TEXT NOT NULL CHECK (content_type IN (
    'weekly_recap', 'top_movers', 'strategy_spotlight',
    'core4_score', 'hedge_fund_intel', 'user_shareable'
  )),
  title TEXT NOT NULL,
  payload JSONB NOT NULL,
  fmp_data_snapshot JSONB,
  platform_captions JSONB,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_staxlabs_content_type ON staxlabs_content(content_type);
CREATE INDEX idx_staxlabs_content_created ON staxlabs_content(created_at DESC);
