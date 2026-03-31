/**
 * GREGORY — Lead Enrichment Module
 *
 * Enriches company/lead data by calling existing tools from TOOL_REGISTRY.
 * Returns a composite score based on financial health, news sentiment,
 * regulatory exposure, and hiring signals.
 */

import { executeTool, type ToolResult } from "./tools.ts";
import { callLLM, extractText } from "./llm.ts";

// ── Types ──

export interface EnrichmentResult {
  financial_health: {
    score: number; // 0-100
    market_cap?: number;
    revenue_growth?: string;
    pe_ratio?: number;
    sector?: string;
    summary?: string;
    raw?: unknown;
  };
  news_sentiment: {
    score: number; // 0-100
    sentiment?: number; // -1 to 1
    volume?: number;
    top_articles?: Array<{ title: string; url?: string }>;
    raw?: unknown;
  };
  regulatory_exposure: {
    score: number; // 0-100 (higher = less risk)
    recent_filings?: number;
    notable_filings?: string[];
    raw?: unknown;
  };
  hiring_signals: {
    score: number; // 0-100
    total_postings?: number;
    top_roles?: string[];
    raw?: unknown;
  };
  patent_activity: {
    score: number; // 0-100
    patent_count?: number;
    recent_patents?: string[];
    raw?: unknown;
  };
}

export interface ScoredEnrichment {
  enrichment: EnrichmentResult;
  score: number; // 0-100 composite
  breakdown: Record<string, number>;
  ai_summary: string;
}

// ── Weights for composite score ──
const WEIGHTS = {
  financial_health: 0.30,
  news_sentiment: 0.25,
  regulatory_exposure: 0.15,
  hiring_signals: 0.20,
  patent_activity: 0.10,
};

// ── Enrichment Pipeline ──

/**
 * Enrich a company using existing Gregory tools.
 * Runs tools in parallel for speed, handles individual failures gracefully.
 */
export async function enrichCompany(
  companyName: string,
  ticker?: string,
): Promise<EnrichmentResult> {
  const ctx = { user_id: "system", task_id: "enrichment" };
  const searchTerm = ticker || companyName;

  // Run all tool calls in parallel
  const [financialRes, sentimentRes, secRes, hiringRes, patentRes] = await Promise.allSettled([
    ticker
      ? executeTool("financial_data", { endpoint: "quote", symbol: ticker }, ctx)
      : executeTool("financial_data", { endpoint: "search", query: companyName }, ctx),
    executeTool("news_sentiment", { query: companyName, mode: "artlist", max_records: 10 }, ctx),
    executeTool("sec_filings", { query: searchTerm, form_type: "10-K,10-Q,8-K", limit: 5 }, ctx),
    executeTool("job_market", { query: companyName, limit: 10 }, ctx),
    executeTool("patent_search", { query: companyName, limit: 5 }, ctx),
  ]);

  return {
    financial_health: parseFinancial(financialRes),
    news_sentiment: parseSentiment(sentimentRes),
    regulatory_exposure: parseRegulatory(secRes),
    hiring_signals: parseHiring(hiringRes),
    patent_activity: parsePatents(patentRes),
  };
}

/**
 * Score an enrichment result and generate an AI summary.
 */
export async function scoreAndSummarize(
  companyName: string,
  enrichment: EnrichmentResult,
): Promise<ScoredEnrichment> {
  const breakdown: Record<string, number> = {};
  let composite = 0;

  for (const [key, weight] of Object.entries(WEIGHTS)) {
    const dimScore = (enrichment as Record<string, { score: number }>)[key]?.score || 50;
    breakdown[key] = Math.round(dimScore);
    composite += dimScore * weight;
  }

  const score = Math.round(composite);

  // Generate AI summary
  let ai_summary = "";
  try {
    const summaryPrompt = `You are a lead intelligence analyst. Summarize this company's profile in 2-3 sentences for a sales/marketing team.

Company: ${companyName}
Composite Score: ${score}/100
Financial Health: ${breakdown.financial_health}/100
News Sentiment: ${breakdown.news_sentiment}/100
Regulatory Exposure: ${breakdown.regulatory_exposure}/100
Hiring Signals: ${breakdown.hiring_signals}/100
Patent Activity: ${breakdown.patent_activity}/100

Financial data: ${JSON.stringify(enrichment.financial_health.summary || "N/A")}
News: ${JSON.stringify(enrichment.news_sentiment.top_articles?.slice(0, 3) || [])}
Hiring: ${enrichment.hiring_signals.total_postings || 0} open positions

Be concise and actionable. Focus on what matters for deciding whether to engage this lead.`;

    const resp = await callLLM({
      system: "You are a concise business analyst.",
      messages: [{ role: "user", content: summaryPrompt }],
      max_tokens: 200,
      temperature: 0.3,
    });
    ai_summary = extractText(resp.content);
  } catch (e) {
    ai_summary = `Score: ${score}/100. Financial: ${breakdown.financial_health}, Sentiment: ${breakdown.news_sentiment}, Hiring: ${breakdown.hiring_signals}.`;
    console.error("AI summary generation failed:", e);
  }

  return { enrichment, score, breakdown, ai_summary };
}

// ── Parsers (extract scores from tool results) ──

function safeResult(settled: PromiseSettledResult<ToolResult>): ToolResult | null {
  if (settled.status === "fulfilled" && settled.value.success) return settled.value;
  return null;
}

function parseFinancial(settled: PromiseSettledResult<ToolResult>): EnrichmentResult["financial_health"] {
  const res = safeResult(settled);
  if (!res) return { score: 50, summary: "Data unavailable" };

  const data = res.data as Record<string, unknown>;
  let score = 50;

  // If we got a quote, evaluate based on available metrics
  if (data && typeof data === "object") {
    const quote = Array.isArray(data) ? data[0] : data;
    const marketCap = (quote as Record<string, unknown>)?.marketCap as number;
    const pe = (quote as Record<string, unknown>)?.pe as number;

    // Larger market cap = higher score (more established)
    if (marketCap) {
      if (marketCap > 100e9) score = 90;
      else if (marketCap > 10e9) score = 75;
      else if (marketCap > 1e9) score = 60;
      else score = 45;
    }

    return {
      score,
      market_cap: marketCap,
      pe_ratio: pe,
      sector: (quote as Record<string, unknown>)?.sector as string,
      summary: `Market Cap: ${marketCap ? `$${(marketCap / 1e9).toFixed(1)}B` : "N/A"}, P/E: ${pe || "N/A"}`,
      raw: quote,
    };
  }

  return { score, summary: "Limited financial data", raw: data };
}

function parseSentiment(settled: PromiseSettledResult<ToolResult>): EnrichmentResult["news_sentiment"] {
  const res = safeResult(settled);
  if (!res) return { score: 50 };

  const data = res.data as Record<string, unknown>;
  if (!data) return { score: 50 };

  const articles = (data.articles || data.results || []) as Array<Record<string, unknown>>;
  const tone = data.tone as number | undefined;

  // Convert tone (-1 to 1) to score (0 to 100)
  let score = 50;
  if (tone !== undefined) {
    score = Math.round((tone + 1) * 50);
  } else if (articles.length > 0) {
    // Neutral if we have articles but no tone
    score = 55;
  }

  return {
    score,
    sentiment: tone,
    volume: articles.length,
    top_articles: articles.slice(0, 5).map((a) => ({
      title: (a.title || a.headline || "Untitled") as string,
      url: a.url as string,
    })),
    raw: data,
  };
}

function parseRegulatory(settled: PromiseSettledResult<ToolResult>): EnrichmentResult["regulatory_exposure"] {
  const res = safeResult(settled);
  if (!res) return { score: 70, recent_filings: 0 };

  const data = res.data as Record<string, unknown>;
  const filings = (data?.filings || data?.results || []) as Array<Record<string, unknown>>;

  // More recent filings = company is active and compliant (higher score)
  // But too many 8-Ks could signal volatility
  const eightKCount = filings.filter((f) => (f.form_type || f.formType) === "8-K").length;
  let score = 70;
  if (filings.length > 0) score = 75;
  if (eightKCount > 3) score = 55; // Many 8-Ks = potential volatility

  return {
    score,
    recent_filings: filings.length,
    notable_filings: filings.slice(0, 3).map(
      (f) => `${f.form_type || f.formType}: ${f.description || f.title || "Filing"}`,
    ),
    raw: data,
  };
}

function parseHiring(settled: PromiseSettledResult<ToolResult>): EnrichmentResult["hiring_signals"] {
  const res = safeResult(settled);
  if (!res) return { score: 50 };

  const data = res.data as Record<string, unknown>;
  const jobs = (data?.jobs || data?.results || []) as Array<Record<string, unknown>>;
  const totalPostings = jobs.length;

  // More job postings = company is growing
  let score = 40;
  if (totalPostings >= 50) score = 90;
  else if (totalPostings >= 20) score = 75;
  else if (totalPostings >= 5) score = 60;
  else if (totalPostings > 0) score = 50;

  const roles = jobs.slice(0, 5).map((j) => (j.title || j.job_title || "Unknown") as string);

  return { score, total_postings: totalPostings, top_roles: roles, raw: data };
}

function parsePatents(settled: PromiseSettledResult<ToolResult>): EnrichmentResult["patent_activity"] {
  const res = safeResult(settled);
  if (!res) return { score: 50 };

  const data = res.data as Record<string, unknown>;
  const patents = (data?.patents || data?.results || []) as Array<Record<string, unknown>>;

  let score = 40;
  if (patents.length >= 20) score = 90;
  else if (patents.length >= 10) score = 75;
  else if (patents.length >= 3) score = 60;
  else if (patents.length > 0) score = 50;

  return {
    score,
    patent_count: patents.length,
    recent_patents: patents.slice(0, 3).map(
      (p) => (p.title || p.patent_title || "Patent") as string,
    ),
    raw: data,
  };
}
