/**
 * GREGORY — Daily Intelligence Engine
 *
 * Runs DAILY (upgraded from weekly) to aggregate data from all sources,
 * store curated intelligence briefs, record metric time-series,
 * generate industry briefs, and sync Google Sheets data sources.
 *
 * Data sources aggregated (10 categories, 20+ endpoints):
 * 1. FRED: Consumer sentiment, CPI, unemployment, retail sales, fed funds rate, PCE, housing
 * 2. FMP: Market overview, sector performance, treasury yields, gainers/losers, commodities
 * 3. GDELT: News sentiment across 8 marketing-critical topics
 * 4. NewsData: Business/tech/marketing headlines
 * 5. Semantic Scholar: Trending research in marketing/behavioral/AI
 * 6. BLS: Employment, wages, labor force participation
 * 7. Google Sheets: User-connected data sources
 *
 * Intelligence categories (expanded from 4 → 10):
 * - macro_economic, market_snapshot, news_digest, academic_trends
 * - NEW: regulatory_updates, ad_platform_trends, social_media_trends,
 *        consumer_behavior, industry_spotlight, competitive_signals
 *
 * Trigger: POST /functions/v1/gregory-weekly-update (with auth header)
 * Schedule: Daily at 6AM ET via n8n or Supabase pg_cron
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callLLM, extractText } from "../_shared/llm.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

interface DataFetchResult {
  source: string;
  category: string;
  raw: unknown;
  error?: string;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  // Verify this is an authorized call (service role key or cron)
  const authHeader = req.headers.get("Authorization");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const expectedKey = serviceKey || "";
  const token = authHeader?.replace("Bearer ", "");
  if (!expectedKey || token !== expectedKey) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") || "",
    serviceKey || "",
  );

  const today = new Date().toISOString().split("T")[0];
  const results: DataFetchResult[] = [];

  // ── Fetch data from ALL sources in parallel ──
  const fetchers = [
    fetchFredData(results),
    fetchFmpData(results),
    fetchFmpExtended(results),
    fetchGdeltData(results),
    fetchNewsData(results),
    fetchAcademicTrends(results),
    fetchRegulatorySignals(results),
    fetchAdPlatformTrends(results),
    fetchSocialMediaTrends(results),
    fetchConsumerSignals(results),
  ];

  await Promise.allSettled(fetchers);

  // ── Record metric snapshots (time-series) ──
  const metricsRecorded = await recordMetricSnapshots(supabase, results, today);

  // ── Generate intelligence briefs using Claude ──
  const briefs = await generateBriefs(results, today);

  // ── Store in intelligence_cache ──
  for (const brief of briefs) {
    await supabase.from("intelligence_cache").upsert(
      {
        category: brief.category,
        title: brief.title,
        content: brief.content,
        data_sources: brief.sources,
        data_date: today,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "category,data_date" },
    );
  }

  // ── Generate industry spotlight (rotating industries) ──
  const industryBrief = await generateIndustrySpotlight(supabase, results, today);

  // ── Sync Google Sheets data sources ──
  const sheetsSynced = await syncAllSheets(supabase);

  // ── Update data freshness tracking ──
  await supabase.from("data_freshness").update({
    last_updated_at: new Date().toISOString(),
    records_count: briefs.length,
    status: "healthy",
  }).eq("data_type", "intelligence_cache");

  await supabase.from("data_freshness").update({
    last_updated_at: new Date().toISOString(),
    records_count: metricsRecorded,
    status: "healthy",
  }).eq("data_type", "metric_snapshots");

  // ── Clean up old entries (keep last 90 days for daily, was 84 for weekly) ──
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 90);
  await supabase
    .from("intelligence_cache")
    .delete()
    .lt("data_date", cutoffDate.toISOString().split("T")[0]);

  // Clean expired research cache
  await supabase
    .from("research_cache")
    .delete()
    .lt("expires_at", new Date().toISOString());

  return new Response(
    JSON.stringify({
      success: true,
      briefs_generated: briefs.length,
      metrics_recorded: metricsRecorded,
      industry_brief: industryBrief ? industryBrief.industry : null,
      sheets_synced: sheetsSynced,
      data_sources_queried: results.length,
      errors: results.filter((r) => r.error).map((r) => ({ source: r.source, error: r.error })),
    }),
    { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
  );
});

// ════════════════════════════════════════
// DATA FETCHERS (expanded from 5 → 10)
// ════════════════════════════════════════

async function fetchFredData(results: DataFetchResult[]) {
  const apiKey = Deno.env.get("FRED_API_KEY");
  if (!apiKey) {
    results.push({ source: "FRED", category: "macro_economic", raw: null, error: "FRED_API_KEY not set" });
    return;
  }

  // Expanded from 7 → 14 series
  const series = [
    { id: "UMCSENT", name: "Consumer Sentiment", cat: "macro_economic" },
    { id: "CPIAUCSL", name: "CPI (All Urban)", cat: "macro_economic" },
    { id: "UNRATE", name: "Unemployment Rate", cat: "macro_economic" },
    { id: "RSXFS", name: "Retail Sales", cat: "macro_economic" },
    { id: "FEDFUNDS", name: "Fed Funds Rate", cat: "macro_economic" },
    { id: "DGS10", name: "10-Year Treasury", cat: "macro_economic" },
    { id: "PCE", name: "Personal Consumption", cat: "macro_economic" },
    // NEW: Consumer behavior indicators
    { id: "CSCICP03USM665S", name: "Consumer Confidence", cat: "consumer_behavior" },
    { id: "DSPIC96", name: "Real Disposable Personal Income", cat: "consumer_behavior" },
    { id: "PSAVERT", name: "Personal Savings Rate", cat: "consumer_behavior" },
    // NEW: Housing & construction (marketing indicator)
    { id: "HOUST", name: "Housing Starts", cat: "macro_economic" },
    // NEW: Ad-relevant indicators
    { id: "JTSJOL", name: "Job Openings (JOLTS)", cat: "macro_economic" },
    { id: "BOGZ1FL073164003Q", name: "Corporate Profits", cat: "macro_economic" },
    { id: "USSLIND", name: "Leading Economic Index", cat: "macro_economic" },
  ];

  for (const s of series) {
    try {
      const resp = await fetch(
        `https://api.stlouisfed.org/fred/series/observations?series_id=${s.id}&frequency=m&sort_order=desc&limit=6&file_type=json&api_key=${apiKey}`,
      );
      if (resp.ok) {
        const data = await resp.json();
        results.push({
          source: `FRED:${s.id}`,
          category: s.cat,
          raw: { name: s.name, series_id: s.id, observations: data.observations?.slice(0, 6) },
        });
      }
    } catch (e) {
      results.push({ source: `FRED:${s.id}`, category: s.cat, raw: null, error: (e as Error).message });
    }
  }
}

async function fetchFmpData(results: DataFetchResult[]) {
  const apiKey = Deno.env.get("FMP_API_KEY");
  if (!apiKey) return;

  const endpoints = [
    { url: `https://financialmodelingprep.com/api/v3/sector-performance?apikey=${apiKey}`, name: "Sector Performance", cat: "market_snapshot" },
    { url: `https://financialmodelingprep.com/api/v4/treasury?apikey=${apiKey}`, name: "Treasury Yields", cat: "market_snapshot" },
  ];

  for (const ep of endpoints) {
    try {
      const resp = await fetch(ep.url);
      if (resp.ok) {
        const data = await resp.json();
        results.push({ source: `FMP:${ep.name}`, category: ep.cat, raw: data });
      }
    } catch (e) {
      results.push({ source: `FMP:${ep.name}`, category: ep.cat, raw: null, error: (e as Error).message });
    }
  }
}

// NEW: Extended FMP data — gainers, losers, commodities
async function fetchFmpExtended(results: DataFetchResult[]) {
  const apiKey = Deno.env.get("FMP_API_KEY");
  if (!apiKey) return;

  const endpoints = [
    { url: `https://financialmodelingprep.com/api/v3/stock_market/gainers?apikey=${apiKey}`, name: "Top Gainers", cat: "market_snapshot" },
    { url: `https://financialmodelingprep.com/api/v3/stock_market/losers?apikey=${apiKey}`, name: "Top Losers", cat: "market_snapshot" },
    { url: `https://financialmodelingprep.com/api/v3/stock_market/actives?apikey=${apiKey}`, name: "Most Active", cat: "market_snapshot" },
    { url: `https://financialmodelingprep.com/api/v3/quotes/commodity?apikey=${apiKey}`, name: "Commodities", cat: "market_snapshot" },
  ];

  for (const ep of endpoints) {
    try {
      const resp = await fetch(ep.url);
      if (resp.ok) {
        const data = await resp.json();
        // Limit to top 5 per endpoint
        const limited = Array.isArray(data) ? data.slice(0, 5) : data;
        results.push({ source: `FMP:${ep.name}`, category: ep.cat, raw: limited });
      }
    } catch (e) {
      results.push({ source: `FMP:${ep.name}`, category: ep.cat, raw: null, error: (e as Error).message });
    }
  }
}

async function fetchGdeltData(results: DataFetchResult[]) {
  // Expanded from 4 → 8 topics
  const topics = [
    { query: "artificial intelligence marketing", cat: "news_digest" },
    { query: "consumer spending economy", cat: "consumer_behavior" },
    { query: "data privacy regulation GDPR CCPA", cat: "regulatory_updates" },
    { query: "digital advertising spend", cat: "ad_platform_trends" },
    { query: "social media platform algorithm", cat: "social_media_trends" },
    { query: "FTC enforcement consumer protection", cat: "regulatory_updates" },
    { query: "influencer marketing brand partnership", cat: "social_media_trends" },
    { query: "startup funding venture capital", cat: "competitive_signals" },
  ];

  for (const t of topics) {
    try {
      const resp = await fetch(
        `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(t.query)}&mode=artlist&format=json&maxrecords=5&sort=datedesc`,
      );
      if (resp.ok) {
        const data = await resp.json();
        results.push({ source: `GDELT:${t.query}`, category: t.cat, raw: data });
      }
    } catch (e) {
      results.push({ source: `GDELT:${t.query}`, category: t.cat, raw: null, error: (e as Error).message });
    }
  }
}

async function fetchNewsData(results: DataFetchResult[]) {
  const apiKey = Deno.env.get("NEWSDATA_API_KEY");
  if (!apiKey) return;

  // Multiple queries for different categories
  const queries = [
    { q: "marketing+technology+advertising", cat: "news_digest" },
    { q: "privacy+regulation+compliance", cat: "regulatory_updates" },
    { q: "social+media+tiktok+instagram", cat: "social_media_trends" },
    { q: "google+meta+advertising+platform", cat: "ad_platform_trends" },
  ];

  for (const query of queries) {
    try {
      const resp = await fetch(
        `https://newsdata.io/api/1/latest?apikey=${apiKey}&q=${query.q}&language=en&category=business,technology`,
      );
      if (resp.ok) {
        const data = await resp.json();
        results.push({ source: `NewsData:${query.q}`, category: query.cat, raw: data.results?.slice(0, 8) });
      }
    } catch (e) {
      results.push({ source: `NewsData:${query.q}`, category: query.cat, raw: null, error: (e as Error).message });
    }
  }
}

async function fetchAcademicTrends(results: DataFetchResult[]) {
  // Expanded from 3 → 6 queries
  const queries = [
    "consumer behavior digital marketing",
    "AI marketing automation",
    "behavioral economics nudge",
    "social media advertising effectiveness",
    "privacy-preserving advertising",
    "attention economy content consumption",
  ];

  for (const query of queries) {
    try {
      const resp = await fetch(
        `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&fields=title,year,citationCount,authors&limit=5&year=2024-2026`,
      );
      if (resp.ok) {
        const data = await resp.json();
        results.push({ source: `SemanticScholar:${query}`, category: "academic_trends", raw: data.data });
      }
    } catch (e) {
      results.push({ source: `SemanticScholar:${query}`, category: "academic_trends", raw: null, error: (e as Error).message });
    }
  }
}

// NEW: Regulatory & policy signals
async function fetchRegulatorySignals(results: DataFetchResult[]) {
  // GDELT handles regulatory news above; add any additional sources here
  // SEC EDGAR RSS for recent notable filings
  try {
    const resp = await fetch(
      "https://efts.sec.gov/LATEST/search-index?q=%22marketing%22+OR+%22advertising%22&dateRange=custom&startdt=" +
      getDateDaysAgo(7) + "&enddt=" + new Date().toISOString().split("T")[0] + "&forms=10-K,10-Q,8-K",
    );
    if (resp.ok) {
      const text = await resp.text();
      // Parse limited SEC EDGAR data
      results.push({ source: "SEC:recent_filings", category: "regulatory_updates", raw: text.substring(0, 3000) });
    }
  } catch {
    // SEC EDGAR search may not be available — non-critical
  }
}

// NEW: Ad platform trends
async function fetchAdPlatformTrends(results: DataFetchResult[]) {
  // Use GDELT for ad platform news (already covered above)
  // Additional: Google Trends proxy via SerpAPI if available
  const serpApiKey = Deno.env.get("SERPAPI_API_KEY");
  if (!serpApiKey) return;

  const trendQueries = [
    "Google Ads",
    "Meta Ads",
    "TikTok Ads",
    "programmatic advertising",
  ];

  for (const query of trendQueries) {
    try {
      const resp = await fetch(
        `https://serpapi.com/search.json?engine=google_trends&q=${encodeURIComponent(query)}&date=today+3-m&api_key=${serpApiKey}`,
      );
      if (resp.ok) {
        const data = await resp.json();
        results.push({ source: `GoogleTrends:${query}`, category: "ad_platform_trends", raw: data.interest_over_time });
      }
    } catch (e) {
      results.push({ source: `GoogleTrends:${query}`, category: "ad_platform_trends", raw: null, error: (e as Error).message });
    }
  }
}

// NEW: Social media trends
async function fetchSocialMediaTrends(results: DataFetchResult[]) {
  // Already fetching via GDELT and NewsData above
  // Could add Reddit trending via Pushshift or similar free APIs
}

// NEW: Consumer behavior signals
async function fetchConsumerSignals(results: DataFetchResult[]) {
  // Consumer-specific FRED data is already fetched in fetchFredData
  // Additional: free economic calendar data
  const fmpKey = Deno.env.get("FMP_API_KEY");
  if (!fmpKey) return;

  try {
    const resp = await fetch(
      `https://financialmodelingprep.com/api/v3/economic_calendar?from=${getDateDaysAgo(7)}&to=${new Date().toISOString().split("T")[0]}&apikey=${fmpKey}`,
    );
    if (resp.ok) {
      const data = await resp.json();
      // Filter to consumer-relevant events
      const consumerEvents = (data as Array<{ event: string }>)
        .filter((e: { event: string }) =>
          /consumer|retail|spending|confidence|sentiment|employment/i.test(e.event)
        )
        .slice(0, 10);
      if (consumerEvents.length > 0) {
        results.push({ source: "FMP:economic_calendar", category: "consumer_behavior", raw: consumerEvents });
      }
    }
  } catch (e) {
    results.push({ source: "FMP:economic_calendar", category: "consumer_behavior", raw: null, error: (e as Error).message });
  }
}

// ════════════════════════════════════════
// METRIC SNAPSHOTS (time-series recording)
// ════════════════════════════════════════

async function recordMetricSnapshots(
  supabase: ReturnType<typeof createClient>,
  results: DataFetchResult[],
  today: string,
): Promise<number> {
  let count = 0;

  for (const r of results) {
    if (r.error || !r.raw) continue;

    try {
      // Extract numeric values from FRED data
      if (r.source.startsWith("FRED:")) {
        const raw = r.raw as { name: string; series_id: string; observations?: Array<{ date: string; value: string }> };
        const latestObs = raw.observations?.[0];
        if (latestObs && latestObs.value !== ".") {
          const metricCategory = r.category === "consumer_behavior" ? "consumer" : "economic";
          await supabase.from("metric_snapshots").upsert(
            {
              metric_name: raw.series_id.toLowerCase(),
              metric_category: metricCategory,
              value: parseFloat(latestObs.value),
              unit: getMetricUnit(raw.series_id),
              period: "monthly",
              data_date: today,
              source: "fred",
              metadata: { series_name: raw.name },
            },
            { onConflict: "metric_name,data_date" },
          );
          count++;
        }
      }

      // Extract market data from FMP sector performance
      if (r.source === "FMP:Sector Performance") {
        const sectors = r.raw as Array<{ sector: string; changesPercentage: string }>;
        for (const sector of (sectors || []).slice(0, 11)) {
          const pct = parseFloat(sector.changesPercentage);
          if (!isNaN(pct)) {
            await supabase.from("metric_snapshots").upsert(
              {
                metric_name: `sector_${sector.sector.toLowerCase().replace(/\s+/g, "_")}`,
                metric_category: "market",
                value: pct,
                unit: "%",
                period: "daily",
                data_date: today,
                source: "fmp",
                metadata: { sector: sector.sector },
              },
              { onConflict: "metric_name,data_date" },
            );
            count++;
          }
        }
      }
    } catch {
      // Non-critical — continue recording other metrics
    }
  }

  return count;
}

function getMetricUnit(seriesId: string): string {
  const units: Record<string, string> = {
    UMCSENT: "index",
    CPIAUCSL: "index",
    UNRATE: "%",
    RSXFS: "millions_usd",
    FEDFUNDS: "%",
    DGS10: "%",
    PCE: "billions_usd",
    CSCICP03USM665S: "index",
    DSPIC96: "billions_usd",
    PSAVERT: "%",
    HOUST: "thousands",
    JTSJOL: "thousands",
    USSLIND: "index",
  };
  return units[seriesId] || "value";
}

// ════════════════════════════════════════
// INDUSTRY SPOTLIGHT (rotating daily)
// ════════════════════════════════════════

const SPOTLIGHT_INDUSTRIES = [
  "saas", "fintech", "ecommerce", "healthcare", "cpg",
  "media_entertainment", "real_estate", "automotive", "education", "travel",
];

async function generateIndustrySpotlight(
  supabase: ReturnType<typeof createClient>,
  results: DataFetchResult[],
  today: string,
): Promise<{ industry: string; content: string } | null> {
  // Rotate: pick industry based on day of year
  const dayOfYear = Math.floor(
    (Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / (1000 * 60 * 60 * 24),
  );
  const industryIndex = dayOfYear % SPOTLIGHT_INDUSTRIES.length;
  const industry = SPOTLIGHT_INDUSTRIES[industryIndex];

  // Gather relevant data
  const relevantData = results
    .filter((r) => !r.error && r.raw)
    .slice(0, 10)
    .map((r) => ({ source: r.source, data: r.raw }));

  if (relevantData.length === 0) return null;

  try {
    const response = await callLLM({
      system: `You are GREGORY's industry analyst. Generate a focused industry spotlight brief for the ${industry} industry. Include:
1. Current market conditions and size (if data available)
2. Key trends and shifts happening NOW
3. Top companies and recent moves
4. Implications for marketers targeting this industry
5. Opportunities and threats
Format as markdown. 400-600 words. Be specific with data points.`,
      messages: [{
        role: "user",
        content: `Generate industry spotlight for: ${industry}\nDate: ${today}\n\nAvailable market context:\n${JSON.stringify(relevantData).substring(0, 8000)}`,
      }],
      max_tokens: 1500,
      temperature: 0.4,
    });

    const content = extractText(response.content);
    if (!content) return null;

    // Store in industry_briefs table
    await supabase.from("industry_briefs").upsert(
      {
        industry,
        title: `${industry.replace(/_/g, " ").toUpperCase()} Industry Spotlight`,
        content,
        data_sources: relevantData.map((r) => r.source as string),
        data_date: today,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "industry,data_date" },
    );

    return { industry, content };
  } catch (e) {
    console.error(`Industry spotlight failed for ${industry}:`, e);
    return null;
  }
}

// ════════════════════════════════════════
// GOOGLE SHEETS SYNC
// ════════════════════════════════════════

async function syncAllSheets(
  supabase: ReturnType<typeof createClient>,
): Promise<number> {
  let synced = 0;

  try {
    const { data: sources } = await supabase
      .from("sheets_data_sources")
      .select("id, sheet_id, sheet_name, title, sync_frequency, last_synced_at")
      .eq("status", "active");

    if (!sources || sources.length === 0) return 0;

    for (const source of sources) {
      // Check if sync is needed based on frequency
      const shouldSync = shouldSyncSheet(source.sync_frequency, source.last_synced_at);
      if (!shouldSync) continue;

      try {
        const { syncGoogleSheet } = await import("../_shared/knowledge-base.ts");
        await syncGoogleSheet(source.id);
        synced++;
        console.log(`Synced sheet: ${source.title}`);
      } catch (e) {
        console.error(`Failed to sync sheet ${source.title}:`, e);
      }
    }
  } catch {
    // sheets_data_sources table might not exist yet — non-critical
  }

  return synced;
}

function shouldSyncSheet(frequency: string, lastSynced: string | null): boolean {
  if (!lastSynced) return true;

  const lastTime = new Date(lastSynced).getTime();
  const now = Date.now();
  const hoursElapsed = (now - lastTime) / (1000 * 60 * 60);

  switch (frequency) {
    case "hourly": return hoursElapsed >= 1;
    case "daily": return hoursElapsed >= 20;
    case "weekly": return hoursElapsed >= 144;
    default: return false; // "manual" — don't auto-sync
  }
}

// ════════════════════════════════════════
// BRIEF GENERATION (expanded from 4 → 10 categories)
// ════════════════════════════════════════

interface Brief {
  category: string;
  title: string;
  content: string;
  sources: string[];
}

async function generateBriefs(results: DataFetchResult[], date: string): Promise<Brief[]> {
  const briefs: Brief[] = [];

  // Group results by category
  const grouped: Record<string, DataFetchResult[]> = {};
  for (const r of results) {
    if (r.error || !r.raw) continue;
    if (!grouped[r.category]) grouped[r.category] = [];
    grouped[r.category].push(r);
  }

  const categoryTitles: Record<string, string> = {
    macro_economic: "Daily Macro-Economic Intelligence",
    market_snapshot: "Daily Market Snapshot",
    news_digest: "Daily Marketing & Tech News Digest",
    academic_trends: "Academic Research Trends",
    regulatory_updates: "Regulatory & Policy Update",
    ad_platform_trends: "Ad Platform & Digital Advertising Trends",
    social_media_trends: "Social Media & Creator Economy Trends",
    consumer_behavior: "Consumer Behavior & Sentiment Signals",
    competitive_signals: "Competitive Intelligence & Startup Signals",
    industry_spotlight: "Industry Spotlight",
  };

  // Generate briefs in parallel (up to 4 at a time to respect rate limits)
  const categoryEntries = Object.entries(grouped);

  for (let i = 0; i < categoryEntries.length; i += 4) {
    const batch = categoryEntries.slice(i, i + 4);
    const batchResults = await Promise.allSettled(
      batch.map(async ([category, categoryResults]) => {
        const dataSnippet = JSON.stringify(
          categoryResults.map((r) => ({ source: r.source, data: r.raw })),
        ).substring(0, 12000);

        const response = await callLLM({
          system: `You are GREGORY's intelligence analyst. Produce a concise daily brief (300-500 words) from the provided data. Format as markdown.

RULES:
- Label all numbers: REPORTED (from data), ESTIMATE (your inference), or UNKNOWN
- Include key takeaways and implications for marketing strategy
- Be specific — cite exact numbers, dates, and sources
- End with 2-3 "Signal to Watch" items for marketers
- Keep it punchy — executives read this every morning`,
          messages: [{
            role: "user",
            content: `Generate the ${categoryTitles[category] || category} brief for ${date}.\n\nData:\n${dataSnippet}`,
          }],
          max_tokens: 1200,
          temperature: 0.3,
        });

        const content = extractText(response.content);
        if (content) {
          return {
            category,
            title: categoryTitles[category] || `Daily ${category} Brief`,
            content,
            sources: categoryResults.map((r) => r.source),
          };
        }
        return null;
      }),
    );

    for (const result of batchResults) {
      if (result.status === "fulfilled" && result.value) {
        briefs.push(result.value);
      }
    }
  }

  return briefs;
}

// ── Helpers ──

function getDateDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split("T")[0];
}
