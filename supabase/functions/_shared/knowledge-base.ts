/**
 * GREGORY — Knowledge Base Module
 *
 * Manages the persistent company knowledge base, research cache,
 * conversation analytics, source registry, and data freshness tracking.
 * This is Gregory's long-term memory for factual intelligence.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callLLM, extractToolCalls, extractText, type ToolSchema } from "./llm.ts";

function getSupabase() {
  return createClient(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
  );
}

// ── Company Knowledge Base ──

export interface CompanyIntel {
  id?: string;
  ticker?: string;
  company_name: string;
  industry?: string;
  sector?: string;
  market_cap_bucket?: string;
  headquarters?: string;
  summary?: string;
  financials?: Record<string, unknown>;
  competitors?: string[];
  key_people?: Array<{ name: string; role: string; since?: string }>;
  recent_news?: Array<{ title: string; date: string; source: string; summary: string }>;
  swot?: { strengths?: string[]; weaknesses?: string[]; opportunities?: string[]; threats?: string[] };
  moat_analysis?: string;
  tags?: string[];
  data_quality_score?: number;
  last_researched_at?: string;
  updated_at?: string;
}

/**
 * Look up a company by ticker or name. Returns null if not found.
 */
export async function getCompanyIntel(identifier: string): Promise<CompanyIntel | null> {
  const sb = getSupabase();
  const upper = identifier.toUpperCase();
  const lower = identifier.toLowerCase();

  // Try ticker first
  const { data: byTicker } = await sb
    .from("company_intel")
    .select("*")
    .eq("ticker", upper)
    .maybeSingle();

  if (byTicker) return byTicker as CompanyIntel;

  // Try name (case-insensitive)
  const { data: byName } = await sb
    .from("company_intel")
    .select("*")
    .ilike("company_name", `%${lower}%`)
    .limit(1)
    .maybeSingle();

  return byName as CompanyIntel | null;
}

/**
 * Upsert company intelligence. Merges new data with existing.
 */
export async function upsertCompanyIntel(
  data: CompanyIntel,
  userId?: string,
): Promise<void> {
  const sb = getSupabase();
  const now = new Date().toISOString();

  const existing = data.ticker
    ? await getCompanyIntel(data.ticker)
    : await getCompanyIntel(data.company_name);

  if (existing) {
    // Merge: keep existing data where new data is missing
    const merged = {
      ...existing,
      ...Object.fromEntries(
        Object.entries(data).filter(([_, v]) => v !== undefined && v !== null),
      ),
      // Merge arrays instead of replacing
      competitors: [...new Set([...(existing.competitors || []), ...(data.competitors || [])])],
      tags: [...new Set([...(existing.tags || []), ...(data.tags || [])])],
      // Append news, don't replace
      recent_news: [
        ...(data.recent_news || []),
        ...(existing.recent_news || []).slice(0, 15), // Keep last 15 + new
      ].slice(0, 20),
      last_researched_at: now,
      last_researched_by: userId || existing.last_researched_by,
      updated_at: now,
    };

    await sb
      .from("company_intel")
      .update(merged)
      .eq("id", existing.id);
  } else {
    await sb.from("company_intel").insert({
      ...data,
      last_researched_at: now,
      last_researched_by: userId,
      updated_at: now,
    });
  }
}

/**
 * Search the company knowledge base by tags, industry, or text.
 */
export async function searchCompanies(
  query: string,
  limit = 10,
): Promise<CompanyIntel[]> {
  const sb = getSupabase();
  const lower = query.toLowerCase();

  const { data } = await sb
    .from("company_intel")
    .select("*")
    .or(`company_name.ilike.%${lower}%,industry.ilike.%${lower}%,sector.ilike.%${lower}%,ticker.ilike.%${lower}%`)
    .order("updated_at", { ascending: false })
    .limit(limit);

  return (data || []) as CompanyIntel[];
}

/**
 * Get all companies in a specific industry.
 */
export async function getCompaniesByIndustry(industry: string): Promise<CompanyIntel[]> {
  const sb = getSupabase();
  const { data } = await sb
    .from("company_intel")
    .select("company_name, ticker, summary, market_cap_bucket, data_quality_score")
    .ilike("industry", `%${industry}%`)
    .order("data_quality_score", { ascending: false })
    .limit(20);

  return (data || []) as CompanyIntel[];
}

// ── Research Cache (Persistent) ──

const TOOL_TTL_HOURS: Record<string, number> = {
  web_search: 4,          // Web results go stale quickly
  web_scrape: 12,         // Scraped pages change less often
  financial_data: 2,      // Market data changes fast
  sec_filings: 168,       // 7 days — SEC filings are durable
  google_trends: 24,      // Daily trends
  fred_economic_data: 72, // 3 days — updated monthly
  news_sentiment: 6,      // News is ephemeral
  academic_search: 168,   // 7 days — papers don't change often
  citation_lookup: 720,   // 30 days — citations are stable
  job_market: 48,         // 2 days
  bls_data: 168,          // 7 days
  world_bank_data: 168,   // 7 days
  news_search: 4,         // News moves fast
  earnings_transcript: 720, // 30 days — transcripts are permanent
  company_news: 6,        // News changes fast
  patent_search: 168,     // 7 days
};

function hashInput(input: Record<string, unknown>): string {
  // Simple hash for cache key — deterministic JSON stringify
  const sorted = JSON.stringify(input, Object.keys(input).sort());
  let hash = 0;
  for (let i = 0; i < sorted.length; i++) {
    const char = sorted.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Check the persistent research cache for a tool result.
 */
export async function getResearchCache(
  toolName: string,
  input: Record<string, unknown>,
): Promise<{ data: unknown; quality_score: number } | null> {
  const sb = getSupabase();
  const key = `${toolName}:${hashInput(input)}`;

  const { data } = await sb
    .from("research_cache")
    .select("result, quality_score")
    .eq("cache_key", key)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (data) {
    // Increment access count
    await sb
      .from("research_cache")
      .update({ access_count: sb.rpc ? undefined : 1, last_accessed_at: new Date().toISOString() })
      .eq("cache_key", key);

    // Use raw SQL increment via RPC if available, otherwise just update timestamp
    try {
      await sb.rpc("increment_cache_access", { p_cache_key: key });
    } catch {
      // RPC not available — that's fine, timestamp was updated
    }

    return { data: data.result, quality_score: data.quality_score };
  }

  return null;
}

/**
 * Store a tool result in the persistent research cache.
 */
export async function setResearchCache(
  toolName: string,
  input: Record<string, unknown>,
  result: unknown,
  qualityScore = 0.5,
): Promise<void> {
  const sb = getSupabase();
  const key = `${toolName}:${hashInput(input)}`;
  const ttlHours = TOOL_TTL_HOURS[toolName] || 24;
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();

  // Summarize the input for human readability
  const inputSummary = Object.entries(input)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ")
    .substring(0, 200);

  await sb.from("research_cache").upsert(
    {
      cache_key: key,
      tool_name: toolName,
      input_hash: hashInput(input),
      input_summary: inputSummary,
      result,
      quality_score: qualityScore,
      expires_at: expiresAt,
      last_accessed_at: new Date().toISOString(),
    },
    { onConflict: "cache_key" },
  );
}

/**
 * Clean expired research cache entries.
 */
export async function cleanResearchCache(): Promise<number> {
  const sb = getSupabase();
  const { data } = await sb
    .from("research_cache")
    .delete()
    .lt("expires_at", new Date().toISOString())
    .select("id");

  return data?.length || 0;
}

// ── Conversation Analytics ──

export interface AnalyticsEvent {
  user_id?: string;
  session_id: string;
  agent_used?: string;
  topic_tags?: string[];
  tools_used?: string[];
  tool_call_count?: number;
  message_count?: number;
  mode?: string;
  task_id?: string;
  duration_ms?: number;
  satisfaction_signal?: string;
  query_complexity?: string;
}

/**
 * Log a conversation analytics event.
 */
export async function logAnalytics(event: AnalyticsEvent): Promise<void> {
  const sb = getSupabase();
  await sb.from("conversation_analytics").insert(event);
}

/**
 * Extract topic tags from a message using lightweight classification.
 */
export function extractTopicTags(message: string): string[] {
  const topics: string[] = [];
  const lower = message.toLowerCase();

  const topicPatterns: Record<string, RegExp[]> = {
    pricing: [/pric/i, /cost/i, /revenue model/i, /monetiz/i],
    competitors: [/competitor/i, /competitive/i, /vs\b/i, /compare/i, /alternative/i],
    marketing: [/market(ing)?/i, /campaign/i, /brand/i, /advertis/i, /gtm/i],
    financial: [/financ/i, /revenue/i, /profit/i, /valuation/i, /stock/i, /earnings/i],
    consumer: [/consumer/i, /customer/i, /buyer/i, /audience/i, /segment/i],
    regulatory: [/regulat/i, /complian/i, /privacy/i, /gdpr/i, /legal/i],
    technology: [/ai\b/i, /machine learning/i, /saas/i, /tech/i, /software/i],
    strategy: [/strateg/i, /plan/i, /roadmap/i, /growth/i],
    research: [/research/i, /study/i, /academic/i, /paper/i, /data/i],
    social_media: [/social/i, /instagram/i, /tiktok/i, /twitter/i, /linkedin/i],
    seo: [/seo/i, /search engine/i, /organic/i, /ranking/i],
    content: [/content/i, /blog/i, /video/i, /podcast/i, /newsletter/i],
  };

  for (const [topic, patterns] of Object.entries(topicPatterns)) {
    if (patterns.some((p) => p.test(lower))) {
      topics.push(topic);
    }
  }

  return topics;
}

// ── Source Registry ──

/**
 * Record a source query (success or failure) to update reliability scores.
 */
export async function recordSourceQuery(
  sourceName: string,
  success: boolean,
  responseMs?: number,
): Promise<void> {
  const sb = getSupabase();
  const now = new Date().toISOString();

  const { data: existing } = await sb
    .from("source_registry")
    .select("*")
    .eq("source_name", sourceName)
    .maybeSingle();

  if (!existing) return; // Source not registered

  const totalQueries = (existing.total_queries || 0) + 1;
  const successfulQueries = (existing.successful_queries || 0) + (success ? 1 : 0);
  const reliability = successfulQueries / totalQueries;

  // Moving average for response time
  const avgResponse = existing.avg_response_ms
    ? Math.round((existing.avg_response_ms * 0.8) + ((responseMs || 0) * 0.2))
    : responseMs;

  await sb
    .from("source_registry")
    .update({
      total_queries: totalQueries,
      successful_queries: successfulQueries,
      reliability_score: Math.round(reliability * 100) / 100,
      avg_response_ms: avgResponse,
      last_queried_at: now,
      ...(success ? { last_success_at: now } : { last_failure_at: now }),
      updated_at: now,
    })
    .eq("source_name", sourceName);
}

/**
 * Get source authority scores for display or decision-making.
 */
export async function getSourceAuthority(sourceName: string): Promise<number> {
  const sb = getSupabase();
  const { data } = await sb
    .from("source_registry")
    .select("authority_score")
    .eq("source_name", sourceName)
    .maybeSingle();

  return data?.authority_score || 0.5;
}

// ── Data Freshness ──

/**
 * Update the freshness tracking for a data type.
 */
export async function updateFreshness(
  dataType: string,
  recordsCount?: number,
  error?: string,
): Promise<void> {
  const sb = getSupabase();
  const now = new Date().toISOString();

  await sb
    .from("data_freshness")
    .update({
      last_updated_at: now,
      records_count: recordsCount,
      status: error ? "error" : "healthy",
      last_error: error || null,
      updated_at: now,
    })
    .eq("data_type", dataType);
}

/**
 * Get freshness status for all data sources.
 */
export async function getDataFreshness(): Promise<
  Array<{ data_type: string; last_updated_at: string; status: string; update_frequency: string }>
> {
  const sb = getSupabase();
  const { data } = await sb
    .from("data_freshness")
    .select("data_type, last_updated_at, status, update_frequency")
    .order("data_type");

  return data || [];
}

// ── Research Threads ──

/**
 * Find or create a research thread for a conversation topic.
 */
export async function findOrCreateThread(
  userId: string,
  topicTags: string[],
  companies: string[],
  sessionId: string,
): Promise<string | null> {
  if (!userId || userId === "anonymous") return null;

  const sb = getSupabase();

  // Look for existing active threads with overlapping topics
  const { data: existing } = await sb
    .from("research_threads")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active")
    .order("updated_at", { ascending: false })
    .limit(10);

  if (existing) {
    for (const thread of existing) {
      const topicOverlap = (thread.topic_tags || []).filter((t: string) => topicTags.includes(t));
      const companyOverlap = (thread.related_companies || []).filter((c: string) => companies.includes(c));

      if (topicOverlap.length >= 2 || companyOverlap.length >= 1) {
        // Add this session to the existing thread
        const conversationIds = [...new Set([...(thread.conversation_ids || []), sessionId])];
        await sb
          .from("research_threads")
          .update({
            conversation_ids: conversationIds,
            topic_tags: [...new Set([...(thread.topic_tags || []), ...topicTags])],
            related_companies: [...new Set([...(thread.related_companies || []), ...companies])],
            updated_at: new Date().toISOString(),
          })
          .eq("id", thread.id);

        return thread.id;
      }
    }
  }

  // Create new thread if enough context
  if (topicTags.length >= 1 || companies.length >= 1) {
    const title = companies.length > 0
      ? `Research: ${companies.join(", ")}`
      : `Research: ${topicTags.slice(0, 3).join(", ")}`;

    const { data: newThread } = await sb
      .from("research_threads")
      .insert({
        user_id: userId,
        title,
        topic_tags: topicTags,
        related_companies: companies,
        conversation_ids: [sessionId],
      })
      .select("id")
      .single();

    return newThread?.id || null;
  }

  return null;
}

// ── Company Intel Auto-Extraction ──

const EXTRACT_COMPANY_TOOL: ToolSchema = {
  name: "extract_company_intel",
  description: "Extract company intelligence from a research result or conversation.",
  input_schema: {
    type: "object",
    properties: {
      companies: {
        type: "array",
        items: {
          type: "object",
          properties: {
            company_name: { type: "string" },
            ticker: { type: "string" },
            industry: { type: "string" },
            sector: { type: "string" },
            summary: { type: "string", description: "2-3 sentence company summary" },
            competitors: { type: "array", items: { type: "string" } },
            tags: { type: "array", items: { type: "string" } },
          },
          required: ["company_name"],
        },
      },
    },
    required: ["companies"],
  },
};

/**
 * Auto-extract company intelligence from text (conversation or tool result).
 * Non-blocking — fire and forget.
 */
export async function autoExtractCompanyIntel(
  text: string,
  userId?: string,
): Promise<void> {
  try {
    const response = await callLLM({
      system: `Extract any company/organization information mentioned in this text. Only extract companies that have substantive information — not just name mentions. Use the extract_company_intel tool.`,
      messages: [{ role: "user", content: text.substring(0, 4000) }],
      tools: [EXTRACT_COMPANY_TOOL],
      max_tokens: 1000,
      temperature: 0,
    });

    const toolCalls = extractToolCalls(response.content);
    if (toolCalls.length === 0) return;

    const extracted = toolCalls[0].input as {
      companies: CompanyIntel[];
    };

    for (const company of extracted.companies) {
      await upsertCompanyIntel(company, userId);
    }
  } catch {
    // Non-critical — don't let extraction failures break anything
  }
}

// ── Metric Snapshots ──

/**
 * Store a metric value in the time-series table.
 */
export async function recordMetric(
  metricName: string,
  category: string,
  value: number,
  unit: string,
  source: string,
  dataDate?: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const sb = getSupabase();
  const date = dataDate || new Date().toISOString().split("T")[0];

  await sb.from("metric_snapshots").upsert(
    {
      metric_name: metricName,
      metric_category: category,
      value,
      unit,
      period: "daily",
      data_date: date,
      source,
      metadata: metadata || {},
    },
    { onConflict: "metric_name,data_date" },
  );
}

/**
 * Get trend data for a metric over time.
 */
export async function getMetricTrend(
  metricName: string,
  days = 30,
): Promise<Array<{ date: string; value: number }>> {
  const sb = getSupabase();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const { data } = await sb
    .from("metric_snapshots")
    .select("data_date, value")
    .eq("metric_name", metricName)
    .gte("data_date", cutoff.toISOString().split("T")[0])
    .order("data_date", { ascending: true });

  return (data || []).map((d: { data_date: string; value: number }) => ({
    date: d.data_date,
    value: d.value,
  }));
}

/**
 * Get latest values for all metrics in a category.
 */
export async function getLatestMetrics(
  category: string,
): Promise<Array<{ name: string; value: number; unit: string; date: string }>> {
  const sb = getSupabase();

  // Get the most recent value for each metric in the category
  const { data } = await sb
    .from("metric_snapshots")
    .select("metric_name, value, unit, data_date")
    .eq("metric_category", category)
    .order("data_date", { ascending: false })
    .limit(50);

  if (!data) return [];

  // Deduplicate to latest per metric
  const seen = new Set<string>();
  const latest: Array<{ name: string; value: number; unit: string; date: string }> = [];

  for (const d of data) {
    if (!seen.has(d.metric_name)) {
      seen.add(d.metric_name);
      latest.push({
        name: d.metric_name,
        value: d.value,
        unit: d.unit,
        date: d.data_date,
      });
    }
  }

  return latest;
}

// ── Google Sheets Integration ──

/**
 * Fetch data from a public Google Sheet (published as CSV).
 * Sheet must be published to web: File > Share > Publish to web > CSV
 */
export async function fetchGoogleSheet(
  sheetId: string,
  tabGid = "0",
): Promise<Record<string, string>[]> {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${tabGid}`;

  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Failed to fetch Google Sheet: ${resp.status}`);
  }

  const csv = await resp.text();
  return parseCSV(csv);
}

function parseCSV(csv: string): Record<string, string>[] {
  const lines = csv.split("\n").map((l) => l.trim()).filter((l) => l);
  if (lines.length < 2) return [];

  const headers = parseCSVLine(lines[0]);
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] || "";
    }
    rows.push(row);
  }

  return rows;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

/**
 * Sync a registered Google Sheet data source into the database.
 */
export async function syncGoogleSheet(sourceId: string): Promise<number> {
  const sb = getSupabase();

  const { data: source } = await sb
    .from("sheets_data_sources")
    .select("*")
    .eq("id", sourceId)
    .single();

  if (!source) throw new Error(`Sheet source ${sourceId} not found`);

  try {
    const rows = await fetchGoogleSheet(source.sheet_id, source.sheet_name || "0");

    // Delete old synced data for this source
    await sb
      .from("sheets_synced_data")
      .delete()
      .eq("source_id", sourceId);

    // Insert new data
    const inserts = rows.map((row, idx) => ({
      source_id: sourceId,
      row_data: row,
      row_index: idx + 1,
      data_date: row.date || row.Date || null, // Try to extract date
    }));

    if (inserts.length > 0) {
      // Batch insert in chunks of 100
      for (let i = 0; i < inserts.length; i += 100) {
        await sb.from("sheets_synced_data").insert(inserts.slice(i, i + 100));
      }
    }

    // Update source metadata
    await sb
      .from("sheets_data_sources")
      .update({
        last_synced_at: new Date().toISOString(),
        row_count: rows.length,
        status: "active",
        last_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", sourceId);

    return rows.length;
  } catch (e) {
    await sb
      .from("sheets_data_sources")
      .update({
        status: "error",
        last_error: (e as Error).message,
        updated_at: new Date().toISOString(),
      })
      .eq("id", sourceId);

    throw e;
  }
}

/**
 * Query synced Google Sheets data by category.
 */
export async function querySheetData(
  category: string,
  limit = 50,
): Promise<Record<string, string>[]> {
  const sb = getSupabase();

  const { data: sources } = await sb
    .from("sheets_data_sources")
    .select("id")
    .eq("category", category)
    .eq("status", "active");

  if (!sources || sources.length === 0) return [];

  const sourceIds = sources.map((s: { id: string }) => s.id);

  const { data } = await sb
    .from("sheets_synced_data")
    .select("row_data, data_date")
    .in("source_id", sourceIds)
    .order("data_date", { ascending: false })
    .limit(limit);

  return (data || []).map((d: { row_data: Record<string, string> }) => d.row_data);
}
