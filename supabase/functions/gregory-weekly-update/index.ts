/**
 * GREGORY — Weekly Intelligence Update
 *
 * Runs weekly (triggered by cron/webhook) to aggregate data from all sources
 * and store curated intelligence briefs in the intelligence_cache table.
 * Gregory references these briefs for contextual awareness.
 *
 * Data sources aggregated:
 * 1. FRED: Consumer sentiment, CPI, unemployment, retail sales, fed funds rate
 * 2. BLS: Employment trends, wage data, JOLTS
 * 3. FMP: Market overview, sector performance, treasury yields
 * 4. GDELT: Top news sentiment trends
 * 5. Semantic Scholar: Trending research in marketing/behavioral science
 * 6. NewsData: Top business/tech headlines
 * 7. SEC EDGAR: Recent notable filings
 *
 * Trigger: POST /functions/v1/gregory-weekly-update (with auth header)
 * Can also be called from n8n cron or Supabase pg_cron.
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

  // ── Fetch data from all sources in parallel ──
  const fetchers = [
    fetchFredData(results),
    fetchFmpData(results),
    fetchGdeltData(results),
    fetchNewsData(results),
    fetchAcademicTrends(results),
  ];

  await Promise.allSettled(fetchers);

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

  // ── Clean up old entries (keep last 12 weeks) ──
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 84); // 12 weeks
  await supabase
    .from("intelligence_cache")
    .delete()
    .lt("data_date", cutoffDate.toISOString().split("T")[0]);

  return new Response(
    JSON.stringify({
      success: true,
      briefs_generated: briefs.length,
      data_sources_queried: results.length,
      errors: results.filter((r) => r.error).map((r) => ({ source: r.source, error: r.error })),
    }),
    { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
  );
});

// ── Data Fetchers ──

async function fetchFredData(results: DataFetchResult[]) {
  const apiKey = Deno.env.get("FRED_API_KEY");
  if (!apiKey) {
    results.push({ source: "FRED", category: "macro_economic", raw: null, error: "FRED_API_KEY not set" });
    return;
  }

  const series = [
    { id: "UMCSENT", name: "Consumer Sentiment" },
    { id: "CPIAUCSL", name: "CPI (All Urban)" },
    { id: "UNRATE", name: "Unemployment Rate" },
    { id: "RSXFS", name: "Retail Sales" },
    { id: "FEDFUNDS", name: "Fed Funds Rate" },
    { id: "DGS10", name: "10-Year Treasury" },
    { id: "PCE", name: "Personal Consumption" },
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
          category: "macro_economic",
          raw: { name: s.name, series_id: s.id, observations: data.observations?.slice(0, 6) },
        });
      }
    } catch (e) {
      results.push({ source: `FRED:${s.id}`, category: "macro_economic", raw: null, error: (e as Error).message });
    }
  }
}

async function fetchFmpData(results: DataFetchResult[]) {
  const apiKey = Deno.env.get("FMP_API_KEY");
  if (!apiKey) return;

  const endpoints = [
    { url: `https://financialmodelingprep.com/api/v3/sector-performance?apikey=${apiKey}`, name: "Sector Performance" },
    { url: `https://financialmodelingprep.com/api/v4/treasury?apikey=${apiKey}`, name: "Treasury Yields" },
  ];

  for (const ep of endpoints) {
    try {
      const resp = await fetch(ep.url);
      if (resp.ok) {
        const data = await resp.json();
        results.push({ source: `FMP:${ep.name}`, category: "market_snapshot", raw: data });
      }
    } catch (e) {
      results.push({ source: `FMP:${ep.name}`, category: "market_snapshot", raw: null, error: (e as Error).message });
    }
  }
}

async function fetchGdeltData(results: DataFetchResult[]) {
  const topics = [
    "artificial intelligence marketing",
    "consumer spending economy",
    "data privacy regulation",
    "digital advertising",
  ];

  for (const topic of topics) {
    try {
      const resp = await fetch(
        `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(topic)}&mode=artlist&format=json&maxrecords=5&sort=datedesc`,
      );
      if (resp.ok) {
        const data = await resp.json();
        results.push({ source: `GDELT:${topic}`, category: "news_digest", raw: data });
      }
    } catch (e) {
      results.push({ source: `GDELT:${topic}`, category: "news_digest", raw: null, error: (e as Error).message });
    }
  }
}

async function fetchNewsData(results: DataFetchResult[]) {
  const apiKey = Deno.env.get("NEWSDATA_API_KEY");
  if (!apiKey) return;

  try {
    const resp = await fetch(
      `https://newsdata.io/api/1/latest?apikey=${apiKey}&q=marketing+technology+advertising&language=en&category=business,technology`,
    );
    if (resp.ok) {
      const data = await resp.json();
      results.push({ source: "NewsData", category: "news_digest", raw: data.results?.slice(0, 10) });
    }
  } catch (e) {
    results.push({ source: "NewsData", category: "news_digest", raw: null, error: (e as Error).message });
  }
}

async function fetchAcademicTrends(results: DataFetchResult[]) {
  const queries = [
    "consumer behavior digital marketing",
    "AI marketing automation",
    "behavioral economics nudge",
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

// ── Brief Generation ──

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

  // Generate a brief for each category
  for (const [category, categoryResults] of Object.entries(grouped)) {
    const dataSnippet = JSON.stringify(
      categoryResults.map((r) => ({ source: r.source, data: r.raw })),
    ).substring(0, 12000); // Cap to avoid token limits

    const categoryTitles: Record<string, string> = {
      macro_economic: "Weekly Macro-Economic Intelligence Brief",
      market_snapshot: "Weekly Market Snapshot",
      news_digest: "Weekly Marketing & Tech News Digest",
      academic_trends: "Weekly Academic Research Trends",
    };

    try {
      const response = await callLLM({
        system: `You are GREGORY's intelligence analyst. Produce a concise weekly brief (400-600 words) from the provided data. Format as markdown. Label all numbers: REPORTED (from data), ESTIMATE (your inference), or UNKNOWN. Include key takeaways and implications for marketing strategy. Be specific — cite exact numbers, dates, and sources.`,
        messages: [
          {
            role: "user",
            content: `Generate the ${categoryTitles[category] || category} for the week of ${date}.\n\nData:\n${dataSnippet}`,
          },
        ],
        max_tokens: 1500,
        temperature: 0.3,
      });

      const content = extractText(response.content);
      if (content) {
        briefs.push({
          category,
          title: categoryTitles[category] || `Weekly ${category} Brief`,
          content,
          sources: categoryResults.map((r) => r.source),
        });
      }
    } catch (e) {
      console.error(`Failed to generate brief for ${category}:`, e);
    }
  }

  return briefs;
}
