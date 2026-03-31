-- GREGORY — Marketing Platform Expansion
-- Features: Competitive Intelligence, Campaign Strategist, Lead Intelligence, Brand Health Monitor
-- Shared: Notification channels and alerts system

-- ════════════════════════════════════════
-- SHARED: Notification Channels
-- Where alerts get delivered (Slack webhooks, email, etc.)
-- ════════════════════════════════════════
CREATE TABLE IF NOT EXISTS notification_channels (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  channel_type TEXT NOT NULL CHECK (channel_type IN ('slack', 'email', 'webhook')),
  channel_name TEXT NOT NULL DEFAULT 'Default',
  config JSONB NOT NULL DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE notification_channels ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own channels" ON notification_channels
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ════════════════════════════════════════
-- SHARED: Alerts
-- All alerts across all features in one table
-- ════════════════════════════════════════
CREATE TABLE IF NOT EXISTS alerts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  feature TEXT NOT NULL,
  alert_type TEXT NOT NULL,
  severity TEXT DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  is_read BOOLEAN DEFAULT false,
  channel_id UUID REFERENCES notification_channels(id) ON DELETE SET NULL,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own alerts" ON alerts
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX idx_alerts_user_unread ON alerts(user_id, is_read) WHERE is_read = false;
CREATE INDEX idx_alerts_feature ON alerts(user_id, feature, created_at DESC);

-- ════════════════════════════════════════
-- FEATURE 2: Competitive Intelligence
-- ════════════════════════════════════════

-- Which companies each user is monitoring
CREATE TABLE IF NOT EXISTS competitor_monitors (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  company_name TEXT NOT NULL,
  ticker TEXT,
  monitor_config JSONB DEFAULT '{"track_sec": true, "track_patents": true, "track_news": true, "track_hiring": true}',
  is_active BOOLEAN DEFAULT true,
  last_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE competitor_monitors ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own monitors" ON competitor_monitors
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE UNIQUE INDEX idx_competitor_monitors_unique ON competitor_monitors(user_id, LOWER(company_name));

-- Daily snapshots per competitor
CREATE TABLE IF NOT EXISTS competitor_snapshots (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  monitor_id UUID REFERENCES competitor_monitors(id) ON DELETE CASCADE NOT NULL,
  snapshot_date DATE NOT NULL,
  sec_filings JSONB DEFAULT '[]',
  patents JSONB DEFAULT '[]',
  news_sentiment JSONB DEFAULT '{}',
  hiring_signals JSONB DEFAULT '{}',
  financial_snapshot JSONB DEFAULT '{}',
  ai_summary TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(monitor_id, snapshot_date)
);

CREATE INDEX idx_competitor_snapshots_date ON competitor_snapshots(monitor_id, snapshot_date DESC);

-- Generated digests (daily/weekly summaries)
CREATE TABLE IF NOT EXISTS competitive_digests (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  digest_type TEXT DEFAULT 'daily' CHECK (digest_type IN ('daily', 'weekly')),
  content TEXT NOT NULL,
  companies_covered TEXT[] DEFAULT '{}',
  data_date DATE NOT NULL,
  delivered BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE competitive_digests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own digests" ON competitive_digests
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ════════════════════════════════════════
-- FEATURE 3: Campaign Strategist
-- ════════════════════════════════════════
CREATE TABLE IF NOT EXISTS campaigns (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'planning', 'active', 'paused', 'completed')),
  inputs JSONB NOT NULL DEFAULT '{}',
  plan JSONB DEFAULT '{}',
  performance_sheet_id UUID,
  performance_data JSONB DEFAULT '{}',
  ai_recommendations TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own campaigns" ON campaigns
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ════════════════════════════════════════
-- FEATURE 4: Lead / Audience Intelligence
-- ════════════════════════════════════════

-- Uploaded or connected lead lists
CREATE TABLE IF NOT EXISTS lead_lists (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  source TEXT DEFAULT 'upload' CHECK (source IN ('upload', 'sheets', 'manual')),
  source_id UUID,
  total_leads INTEGER DEFAULT 0,
  enriched_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'enriching', 'ready', 'error')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE lead_lists ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own lead_lists" ON lead_lists
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Individual leads with enrichment data
CREATE TABLE IF NOT EXISTS leads (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  list_id UUID REFERENCES lead_lists(id) ON DELETE CASCADE NOT NULL,
  company_name TEXT NOT NULL,
  ticker TEXT,
  contact_name TEXT,
  contact_title TEXT,
  contact_email TEXT,
  website TEXT,
  raw_data JSONB DEFAULT '{}',
  enrichment JSONB DEFAULT '{}',
  score REAL,
  score_breakdown JSONB DEFAULT '{}',
  ai_summary TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'enriching', 'enriched', 'error')),
  enriched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_leads_list ON leads(list_id, score DESC NULLS LAST);
CREATE INDEX idx_leads_status ON leads(list_id, status);

-- ════════════════════════════════════════
-- FEATURE 5: Brand Health Monitor
-- ════════════════════════════════════════

-- Brand monitoring configuration
CREATE TABLE IF NOT EXISTS brand_monitors (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  brand_name TEXT NOT NULL,
  keywords TEXT[] DEFAULT '{}',
  competitors TEXT[] DEFAULT '{}',
  alert_config JSONB DEFAULT '{"sentiment_drop_threshold": -0.2, "volume_spike_multiplier": 2.0, "notify_on_competitor_mention": true}',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE brand_monitors ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own brand_monitors" ON brand_monitors
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE UNIQUE INDEX idx_brand_monitors_unique ON brand_monitors(user_id, LOWER(brand_name));

-- Daily brand health snapshots
CREATE TABLE IF NOT EXISTS brand_snapshots (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  monitor_id UUID REFERENCES brand_monitors(id) ON DELETE CASCADE NOT NULL,
  snapshot_date DATE NOT NULL,
  sentiment_score REAL,
  sentiment_volume INTEGER DEFAULT 0,
  news_articles JSONB DEFAULT '[]',
  trend_data JSONB DEFAULT '{}',
  competitor_comparison JSONB DEFAULT '{}',
  ai_summary TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(monitor_id, snapshot_date)
);

CREATE INDEX idx_brand_snapshots_date ON brand_snapshots(monitor_id, snapshot_date DESC);
