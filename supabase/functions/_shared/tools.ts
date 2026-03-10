/**
 * GREGORY — Tool Registry & Executors
 * Defines all tools available to agentic Gregory: web search, financial data,
 * web scraping, SEC filings, Google Trends, and document analysis.
 */

import type { ToolSchema } from "./llm.ts";

// ── Response Cache ──
// Simple in-memory cache for identical tool calls within the same function invocation.
// Reduces duplicate API calls and saves cost/latency.

const _toolCache = new Map<string, { result: ToolResult; timestamp: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCacheKey(toolName: string, input: Record<string, unknown>): string {
  return `${toolName}:${JSON.stringify(input)}`;
}

function getCachedResult(toolName: string, input: Record<string, unknown>): ToolResult | null {
  const key = getCacheKey(toolName, input);
  const cached = _toolCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    // Return cached result with cached flag
    const result = { ...cached.result };
    if (result.metadata) result.metadata = { ...result.metadata, cached: true };
    return result;
  }
  if (cached) _toolCache.delete(key); // Expired
  return null;
}

function setCachedResult(toolName: string, input: Record<string, unknown>, result: ToolResult): void {
  // Only cache successful results from external APIs (not local tools)
  if (!result.success) return;
  const nonCacheable = new Set(["analyze_document", "decompose_query"]);
  if (nonCacheable.has(toolName)) return;
  const key = getCacheKey(toolName, input);
  _toolCache.set(key, { result, timestamp: Date.now() });
  // Evict old entries if cache grows too large
  if (_toolCache.size > 100) {
    const oldest = _toolCache.keys().next().value;
    if (oldest) _toolCache.delete(oldest);
  }
}

// ── Types ──

export interface ToolContext {
  user_id?: string;
  task_id?: string;
}

export interface ToolResult {
  success: boolean;
  data: unknown;
  error?: string;
  metadata?: {
    source: string;
    cached: boolean;
    cost_indicator: "free" | "paid";
    quality_score?: number;
  };
}

export interface ToolDefinition {
  schema: ToolSchema;
  execute: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
  timeout_ms: number;
}

// ── Tool Implementations ──

/** Web Search via Tavily API */
const webSearchTool: ToolDefinition = {
  schema: {
    name: "web_search",
    description:
      "Search the web for current information. Returns relevant snippets with source URLs. Use for real-time data, news, market research, competitor analysis.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query",
        },
        search_depth: {
          type: "string",
          enum: ["basic", "advanced"],
          description: "basic = fast, advanced = more thorough. Default: basic",
        },
        max_results: {
          type: "number",
          description: "Number of results (1-10). Default: 5",
        },
      },
      required: ["query"],
    },
  },
  async execute(input, _ctx) {
    const apiKey = Deno.env.get("TAVILY_API_KEY");
    if (!apiKey) {
      return { success: false, data: null, error: "TAVILY_API_KEY not configured" };
    }

    const resp = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query: input.query as string,
        search_depth: (input.search_depth as string) || "basic",
        max_results: (input.max_results as number) || 5,
        include_raw_content: false,
        include_answer: true,
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      return { success: false, data: null, error: `Tavily error: ${err}` };
    }

    const data = await resp.json();
    return {
      success: true,
      data: {
        answer: data.answer,
        results: data.results?.map((r: { title: string; url: string; content: string }) => ({
          title: r.title,
          url: r.url,
          content: r.content,
        })),
      },
      metadata: { source: "tavily", cached: false, cost_indicator: "paid" },
    };
  },
  timeout_ms: 15000,
};

/** Web Scraping via Jina Reader API */
const webScrapeTool: ToolDefinition = {
  schema: {
    name: "web_scrape",
    description:
      "Fetch and extract text content from a specific URL. Returns clean markdown. Use when you need to read a specific webpage, article, or document.",
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to scrape",
        },
      },
      required: ["url"],
    },
  },
  async execute(input, _ctx) {
    const url = input.url as string;
    try {
      const resp = await fetch(`https://r.jina.ai/${url}`, {
        headers: { Accept: "text/markdown" },
      });

      if (!resp.ok) {
        return { success: false, data: null, error: `Jina Reader error: ${resp.status}` };
      }

      const content = await resp.text();
      // Truncate to avoid token limits
      const truncated = content.substring(0, 8000);
      return {
        success: true,
        data: { content: truncated, url, truncated: content.length > 8000 },
        metadata: { source: "jina_reader", cached: false, cost_indicator: "free" },
      };
    } catch (e) {
      return { success: false, data: null, error: `Scrape failed: ${(e as Error).message}` };
    }
  },
  timeout_ms: 20000,
};

/** Financial Data via Financial Modeling Prep API */
const financialDataTool: ToolDefinition = {
  schema: {
    name: "financial_data",
    description:
      "Fetch financial data: stock quotes, company profiles, income statements, balance sheets, cash flow, ratios, market overview, sector performance, treasury yields. Data labeled REPORTED.",
    input_schema: {
      type: "object",
      properties: {
        endpoint: {
          type: "string",
          enum: [
            "quote",
            "profile",
            "income-statement",
            "balance-sheet-statement",
            "cash-flow-statement",
            "ratios",
            "market-overview",
            "sector-performance",
            "treasury",
          ],
          description: "Which financial data endpoint to query",
        },
        symbol: {
          type: "string",
          description: "Stock ticker (e.g. AAPL, MSFT). Required for company-specific endpoints.",
        },
        period: {
          type: "string",
          enum: ["annual", "quarter"],
          description: "Annual or quarterly data. Default: annual",
        },
      },
      required: ["endpoint"],
    },
  },
  async execute(input, _ctx) {
    const apiKey = Deno.env.get("FMP_API_KEY");
    if (!apiKey) {
      return { success: false, data: null, error: "FMP_API_KEY not configured" };
    }

    const endpoint = input.endpoint as string;
    const symbol = input.symbol as string | undefined;
    const period = (input.period as string) || "annual";

    let url: string;
    switch (endpoint) {
      case "quote":
      case "profile":
        if (!symbol) return { success: false, data: null, error: "Symbol required for this endpoint" };
        url = `https://financialmodelingprep.com/api/v3/${endpoint}/${symbol}?apikey=${apiKey}`;
        break;
      case "income-statement":
      case "balance-sheet-statement":
      case "cash-flow-statement":
      case "ratios":
        if (!symbol) return { success: false, data: null, error: "Symbol required for this endpoint" };
        url = `https://financialmodelingprep.com/api/v3/${endpoint}/${symbol}?period=${period}&limit=4&apikey=${apiKey}`;
        break;
      case "market-overview":
        url = `https://financialmodelingprep.com/api/v3/market-overview?apikey=${apiKey}`;
        break;
      case "sector-performance":
        url = `https://financialmodelingprep.com/api/v3/sector-performance?apikey=${apiKey}`;
        break;
      case "treasury":
        url = `https://financialmodelingprep.com/api/v4/treasury?apikey=${apiKey}`;
        break;
      default:
        return { success: false, data: null, error: `Unknown endpoint: ${endpoint}` };
    }

    const resp = await fetch(url);
    if (!resp.ok) {
      return { success: false, data: null, error: `FMP error: ${resp.status}` };
    }

    const data = await resp.json();
    return {
      success: true,
      data,
      metadata: { source: "financial_modeling_prep", cached: false, cost_indicator: "paid" },
    };
  },
  timeout_ms: 10000,
};

/** SEC EDGAR Filings Search */
const secFilingsTool: ToolDefinition = {
  schema: {
    name: "sec_filings",
    description:
      "Search SEC EDGAR for company filings (10-K, 10-Q, 8-K, S-1, proxy statements). Free, no API key needed.",
    input_schema: {
      type: "object",
      properties: {
        company: {
          type: "string",
          description: "Company name or CIK number",
        },
        filing_type: {
          type: "string",
          enum: ["10-K", "10-Q", "8-K", "S-1", "DEF 14A", "all"],
          description: "Type of filing to search for. Default: all",
        },
        limit: {
          type: "number",
          description: "Max results to return (1-10). Default: 5",
        },
      },
      required: ["company"],
    },
  },
  async execute(input, _ctx) {
    const company = input.company as string;
    const filingType = (input.filing_type as string) || "all";
    const limit = (input.limit as number) || 5;

    const forms = filingType === "all" ? "" : filingType;
    const url = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(company)}&forms=${forms}&from=0&size=${limit}`;

    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": "GREGORY AI research@gregory-ai.com" },
      });

      if (!resp.ok) {
        return { success: false, data: null, error: `EDGAR error: ${resp.status}` };
      }

      const data = await resp.json();
      return {
        success: true,
        data,
        metadata: { source: "sec_edgar", cached: false, cost_indicator: "free" },
      };
    } catch (e) {
      return { success: false, data: null, error: `EDGAR failed: ${(e as Error).message}` };
    }
  },
  timeout_ms: 10000,
};

/** Google Trends via SerpApi */
const googleTrendsTool: ToolDefinition = {
  schema: {
    name: "google_trends",
    description:
      "Get Google Trends data showing search interest over time for up to 5 keywords. Useful for market demand signals and competitive analysis.",
    input_schema: {
      type: "object",
      properties: {
        keywords: {
          type: "array",
          items: { type: "string" },
          description: "Keywords to compare (1-5)",
        },
        timeframe: {
          type: "string",
          enum: ["past_day", "past_week", "past_month", "past_year", "past_5_years"],
          description: "Time range. Default: past_year",
        },
        geo: {
          type: "string",
          description: "Country code (e.g. US, GB, DE). Default: US",
        },
      },
      required: ["keywords"],
    },
  },
  async execute(input, _ctx) {
    const apiKey = Deno.env.get("SERPAPI_KEY");
    if (!apiKey) {
      return { success: false, data: null, error: "SERPAPI_KEY not configured" };
    }

    const keywords = input.keywords as string[];
    const timeframe = (input.timeframe as string) || "past_year";
    const geo = (input.geo as string) || "US";

    // Map timeframe to SerpApi's date parameter
    const dateMap: Record<string, string> = {
      past_day: "now 1-d",
      past_week: "now 7-d",
      past_month: "today 1-m",
      past_year: "today 12-m",
      past_5_years: "today 5-y",
    };

    const params = new URLSearchParams({
      engine: "google_trends",
      q: keywords.join(","),
      data_type: "TIMESERIES",
      date: dateMap[timeframe] || "today 12-m",
      geo,
      api_key: apiKey,
    });

    const resp = await fetch(`https://serpapi.com/search.json?${params}`);
    if (!resp.ok) {
      return { success: false, data: null, error: `SerpApi error: ${resp.status}` };
    }

    const data = await resp.json();
    return {
      success: true,
      data: {
        interest_over_time: data.interest_over_time,
        compared_breakdown: data.compared_breakdown_by_region,
      },
      metadata: { source: "serpapi_trends", cached: false, cost_indicator: "paid" },
    };
  },
  timeout_ms: 15000,
};

// ── Tier 1 Tools ──

/** FRED (Federal Reserve Economic Data) — 840K+ economic time series */
const fredTool: ToolDefinition = {
  schema: {
    name: "fred_economic_data",
    description:
      "Fetch US economic data from the Federal Reserve (FRED): CPI, consumer sentiment, retail sales, unemployment, interest rates, GDP, PCE, and 840K+ other time series. Data labeled REPORTED.",
    input_schema: {
      type: "object",
      properties: {
        series_id: {
          type: "string",
          description: "FRED series ID. Common IDs: UMCSENT (consumer sentiment), CPIAUCSL (CPI), RSXFS (retail sales), UNRATE (unemployment), PCE (personal consumption), FEDFUNDS (fed funds rate), GDP, JTSJOL (job openings), DGS10 (10-year treasury)",
        },
        observation_start: {
          type: "string",
          description: "Start date (YYYY-MM-DD). Default: 1 year ago",
        },
        frequency: {
          type: "string",
          enum: ["d", "w", "m", "q", "a"],
          description: "Frequency: d=daily, w=weekly, m=monthly, q=quarterly, a=annual. Default: m",
        },
      },
      required: ["series_id"],
    },
  },
  async execute(input, _ctx) {
    const apiKey = Deno.env.get("FRED_API_KEY");
    if (!apiKey) {
      return { success: false, data: null, error: "FRED_API_KEY not configured" };
    }

    const seriesId = input.series_id as string;
    const frequency = (input.frequency as string) || "m";
    const now = new Date();
    const defaultStart = new Date(now.getFullYear() - 1, now.getMonth(), 1).toISOString().split("T")[0];
    const start = (input.observation_start as string) || defaultStart;

    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&observation_start=${start}&frequency=${frequency}&file_type=json&api_key=${apiKey}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      return { success: false, data: null, error: `FRED error: ${resp.status}` };
    }
    const data = await resp.json();
    return {
      success: true,
      data: {
        series_id: seriesId,
        observations: data.observations?.slice(-24), // Last 24 data points
      },
      metadata: { source: "fred", cached: false, cost_indicator: "free" },
    };
  },
  timeout_ms: 10000,
};

/** GDELT — Real-time global news sentiment and volume tracking */
const gdeltTool: ToolDefinition = {
  schema: {
    name: "news_sentiment",
    description:
      "Track global news volume and sentiment for any topic, brand, or company using GDELT (100+ countries, 65+ languages). Returns article counts over time, average sentiment tone, and recent article links. No API key needed.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query — brand name, company, topic, or keyword phrase",
        },
        mode: {
          type: "string",
          enum: ["timelinevol", "timelinetone", "artlist"],
          description: "timelinevol = volume over time, timelinetone = sentiment over time, artlist = recent articles. Default: artlist",
        },
        max_records: {
          type: "number",
          description: "Max articles to return (for artlist mode). Default: 10",
        },
      },
      required: ["query"],
    },
  },
  async execute(input, _ctx) {
    const query = input.query as string;
    const mode = (input.mode as string) || "artlist";
    const maxRecords = (input.max_records as number) || 10;

    // Default to last 3 months
    const now = new Date();
    const start = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const startDt = start.toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const endDt = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);

    const params = new URLSearchParams({
      query: query,
      mode: mode,
      format: "json",
      startdatetime: startDt,
      enddatetime: endDt,
      ...(mode === "artlist" ? { maxrecords: String(maxRecords), sort: "datedesc" } : {}),
      ...(mode === "timelinevol" ? { timelinesmooth: "5" } : {}),
    });

    const url = `https://api.gdeltproject.org/api/v2/doc/doc?${params}`;
    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        return { success: false, data: null, error: `GDELT error: ${resp.status}` };
      }
      const data = await resp.json();
      return {
        success: true,
        data,
        metadata: { source: "gdelt", cached: false, cost_indicator: "free" },
      };
    } catch (e) {
      return { success: false, data: null, error: `GDELT failed: ${(e as Error).message}` };
    }
  },
  timeout_ms: 15000,
};

/** SEC EDGAR Enhanced — Structured XBRL financial data (exact revenue, segments) */
const secCompanyFactsTool: ToolDefinition = {
  schema: {
    name: "sec_company_facts",
    description:
      "Get structured financial data from SEC EDGAR for any public company: exact revenue, net income, assets, EPS, shares outstanding, and 100s of other XBRL-reported facts. Data labeled REPORTED. Also retrieves full submission history.",
    input_schema: {
      type: "object",
      properties: {
        cik: {
          type: "string",
          description: "Company CIK number (e.g. '0001318605' for Tesla, '0000320193' for Apple). Pad with leading zeros to 10 digits.",
        },
        concept: {
          type: "string",
          description: "Specific XBRL concept to retrieve (e.g. 'us-gaap/Revenues', 'us-gaap/NetIncomeLoss', 'us-gaap/Assets', 'us-gaap/EarningsPerShareBasic'). If omitted, returns all company facts.",
        },
      },
      required: ["cik"],
    },
  },
  async execute(input, _ctx) {
    const cik = (input.cik as string).padStart(10, "0");
    const concept = input.concept as string | undefined;
    const headers = { "User-Agent": "GREGORY AI research@gregory-ai.com" };

    let url: string;
    if (concept) {
      url = `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/${concept}.json`;
    } else {
      url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
    }

    try {
      const resp = await fetch(url, { headers });
      if (!resp.ok) {
        return { success: false, data: null, error: `SEC data.sec.gov error: ${resp.status}` };
      }
      const data = await resp.json();
      // Truncate to avoid massive payloads
      if (!concept && data.facts) {
        const usgaap = data.facts["us-gaap"] || {};
        const keys = Object.keys(usgaap);
        // Return only the most useful financial concepts
        const importantConcepts = ["Revenues", "NetIncomeLoss", "Assets", "StockholdersEquity",
          "EarningsPerShareBasic", "CommonStockSharesOutstanding", "OperatingIncomeLoss",
          "CostOfRevenue", "GrossProfit", "ResearchAndDevelopmentExpense"];
        const filtered: Record<string, unknown> = {};
        for (const key of importantConcepts) {
          if (usgaap[key]) filtered[key] = usgaap[key];
        }
        return {
          success: true,
          data: { entityName: data.entityName, cik: data.cik, facts: filtered },
          metadata: { source: "sec_edgar_xbrl", cached: false, cost_indicator: "free" },
        };
      }
      return {
        success: true,
        data,
        metadata: { source: "sec_edgar_xbrl", cached: false, cost_indicator: "free" },
      };
    } catch (e) {
      return { success: false, data: null, error: `SEC XBRL failed: ${(e as Error).message}` };
    }
  },
  timeout_ms: 10000,
};

/** USPTO PatentsView — US patent search for competitive R&D intelligence */
const patentSearchTool: ToolDefinition = {
  schema: {
    name: "patent_search",
    description:
      "Search US patents since 1976 by company (assignee), technology keywords, or CPC classification. Reveals competitor R&D focus 18-24 months before products ship. Free, no key needed.",
    input_schema: {
      type: "object",
      properties: {
        assignee: {
          type: "string",
          description: "Company name (patent assignee), e.g. 'Google LLC', 'Apple Inc.'",
        },
        query: {
          type: "string",
          description: "Keyword search in patent title and abstract",
        },
        min_date: {
          type: "string",
          description: "Minimum patent grant date (YYYY-MM-DD). Default: 2 years ago",
        },
        limit: {
          type: "number",
          description: "Max results (1-25). Default: 10",
        },
      },
      required: ["query"],
    },
  },
  async execute(input, _ctx) {
    const assignee = input.assignee as string | undefined;
    const query = input.query as string | undefined;
    const limit = (input.limit as number) || 10;
    const now = new Date();
    const defaultMinDate = new Date(now.getFullYear() - 2, now.getMonth(), 1).toISOString().split("T")[0];
    const minDate = (input.min_date as string) || defaultMinDate;

    // Build query filter
    const conditions: Record<string, unknown>[] = [];
    if (assignee) conditions.push({ "_contains": { "assignees.assignee_organization": assignee } });
    if (query) conditions.push({ "_text_any": { "patent_title": query } });
    conditions.push({ "_gte": { "patent_date": minDate } });

    const q = conditions.length === 1 ? conditions[0] : { "_and": conditions };

    const url = `https://api.patentsview.org/patents/query?q=${encodeURIComponent(JSON.stringify(q))}&f=["patent_number","patent_title","patent_abstract","patent_date","assignees.assignee_organization"]&o={"per_page":${limit},"sort":[{"patent_date":"desc"}]}`;

    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        return { success: false, data: null, error: `PatentsView error: ${resp.status}` };
      }
      const data = await resp.json();
      return {
        success: true,
        data: { total_patent_count: data.total_patent_count, patents: data.patents },
        metadata: { source: "uspto_patentsview", cached: false, cost_indicator: "free" },
      };
    } catch (e) {
      return { success: false, data: null, error: `PatentsView failed: ${(e as Error).message}` };
    }
  },
  timeout_ms: 10000,
};

// ── Tier 2 Tools ──

/** Semantic Scholar — 220M+ peer-reviewed academic papers */
const academicSearchTool: ToolDefinition = {
  schema: {
    name: "academic_search",
    description:
      "Search 220M+ peer-reviewed academic papers via Semantic Scholar. Returns titles, abstracts, citation counts, authors, and publication years. Use to find research backing for marketing claims, behavioral science evidence, or to verify citations.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query for academic papers",
        },
        year_range: {
          type: "string",
          description: "Year range filter, e.g. '2020-2025'. Default: no filter",
        },
        limit: {
          type: "number",
          description: "Max results (1-20). Default: 10",
        },
      },
      required: ["query"],
    },
  },
  async execute(input, _ctx) {
    const query = input.query as string;
    const limit = (input.limit as number) || 10;
    const yearRange = input.year_range as string | undefined;

    let url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&fields=title,abstract,citationCount,authors,year,url&limit=${limit}`;
    if (yearRange) {
      const [start, end] = yearRange.split("-");
      if (start) url += `&year=${start}-${end || ""}`;
    }

    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        return { success: false, data: null, error: `Semantic Scholar error: ${resp.status}` };
      }
      const data = await resp.json();
      return {
        success: true,
        data: {
          total: data.total,
          papers: data.data?.map((p: Record<string, unknown>) => ({
            title: p.title,
            abstract: (p.abstract as string)?.substring(0, 500),
            authors: (p.authors as Array<{ name: string }>)?.map((a) => a.name).slice(0, 5),
            year: p.year,
            citationCount: p.citationCount,
            url: p.url,
          })),
        },
        metadata: { source: "semantic_scholar", cached: false, cost_indicator: "free" },
      };
    } catch (e) {
      return { success: false, data: null, error: `Semantic Scholar failed: ${(e as Error).message}` };
    }
  },
  timeout_ms: 10000,
};

/** CrossRef — DOI resolution and citation counts for 150M+ works */
const crossrefTool: ToolDefinition = {
  schema: {
    name: "citation_lookup",
    description:
      "Look up academic citation data via CrossRef: search works by topic, get citation counts, verify DOIs, find journal metadata. 150M+ works indexed. Use to validate that cited research is real and well-cited.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query for academic works, OR a DOI to look up directly (e.g. '10.1086/209570')",
        },
        sort_by_citations: {
          type: "boolean",
          description: "Sort results by citation count (highest first). Default: true",
        },
        limit: {
          type: "number",
          description: "Max results (1-20). Default: 10",
        },
      },
      required: ["query"],
    },
  },
  async execute(input, _ctx) {
    const query = input.query as string;
    const limit = (input.limit as number) || 10;
    const sortByCitations = (input.sort_by_citations as boolean) !== false;

    let url: string;
    if (query.startsWith("10.")) {
      // DOI lookup
      url = `https://api.crossref.org/works/${encodeURIComponent(query)}?mailto=research@gregory-ai.com`;
    } else {
      url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${limit}&mailto=research@gregory-ai.com`;
      if (sortByCitations) url += "&sort=is-referenced-by-count&order=desc";
    }

    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        return { success: false, data: null, error: `CrossRef error: ${resp.status}` };
      }
      const data = await resp.json();

      if (query.startsWith("10.")) {
        const work = data.message;
        return {
          success: true,
          data: {
            title: work.title?.[0],
            authors: work.author?.map((a: Record<string, string>) => `${a.given} ${a.family}`).slice(0, 5),
            published: work.published?.["date-parts"]?.[0],
            citation_count: work["is-referenced-by-count"],
            journal: work["container-title"]?.[0],
            doi: work.DOI,
          },
          metadata: { source: "crossref", cached: false, cost_indicator: "free" },
        };
      }

      return {
        success: true,
        data: {
          total_results: data.message?.["total-results"],
          works: data.message?.items?.map((w: Record<string, unknown>) => ({
            title: (w.title as string[])?.[0],
            authors: (w.author as Array<Record<string, string>>)?.map((a) => `${a.given} ${a.family}`).slice(0, 3),
            year: (w.published as Record<string, unknown>)?.["date-parts"]?.[0]?.[0],
            citation_count: w["is-referenced-by-count"],
            journal: (w["container-title"] as string[])?.[0],
            doi: w.DOI,
          })),
        },
        metadata: { source: "crossref", cached: false, cost_indicator: "free" },
      };
    } catch (e) {
      return { success: false, data: null, error: `CrossRef failed: ${(e as Error).message}` };
    }
  },
  timeout_ms: 10000,
};

/** Adzuna Jobs API — hiring intelligence across 12 countries */
const jobSearchTool: ToolDefinition = {
  schema: {
    name: "job_market",
    description:
      "Search live job postings and salary data across 12 countries. Detect competitor hiring surges (signals campaign launches or product pivots), track salary benchmarks, and identify which roles companies are building around.",
    input_schema: {
      type: "object",
      properties: {
        what: {
          type: "string",
          description: "Job title or keywords (e.g. 'growth marketing manager', 'machine learning engineer')",
        },
        company: {
          type: "string",
          description: "Filter by company name",
        },
        where: {
          type: "string",
          description: "Location (city, state, or country). Default: any",
        },
        country: {
          type: "string",
          enum: ["us", "gb", "ca", "au", "de", "fr", "in", "nl", "br", "pl", "it", "at"],
          description: "Country code. Default: us",
        },
        mode: {
          type: "string",
          enum: ["search", "histogram", "top_companies"],
          description: "search = job listings, histogram = salary distribution, top_companies = who's hiring most. Default: search",
        },
      },
      required: ["what"],
    },
  },
  async execute(input, _ctx) {
    const appId = Deno.env.get("ADZUNA_APP_ID");
    const appKey = Deno.env.get("ADZUNA_APP_KEY");
    if (!appId || !appKey) {
      return { success: false, data: null, error: "ADZUNA_APP_ID or ADZUNA_APP_KEY not configured" };
    }

    const what = input.what as string;
    const company = input.company as string | undefined;
    const where = input.where as string | undefined;
    const country = (input.country as string) || "us";
    const mode = (input.mode as string) || "search";

    let url: string;
    const baseParams = `app_id=${appId}&app_key=${appKey}&what=${encodeURIComponent(what)}`;

    switch (mode) {
      case "histogram":
        url = `https://api.adzuna.com/v1/api/jobs/${country}/histogram?${baseParams}`;
        if (where) url += `&where=${encodeURIComponent(where)}`;
        break;
      case "top_companies":
        url = `https://api.adzuna.com/v1/api/jobs/${country}/top_companies?${baseParams}`;
        break;
      default:
        url = `https://api.adzuna.com/v1/api/jobs/${country}/search/1?${baseParams}&results_per_page=15`;
        if (company) url += `&company=${encodeURIComponent(company)}`;
        if (where) url += `&where=${encodeURIComponent(where)}`;
    }

    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        return { success: false, data: null, error: `Adzuna error: ${resp.status}` };
      }
      const data = await resp.json();
      return {
        success: true,
        data,
        metadata: { source: "adzuna", cached: false, cost_indicator: "free" },
      };
    } catch (e) {
      return { success: false, data: null, error: `Adzuna failed: ${(e as Error).message}` };
    }
  },
  timeout_ms: 10000,
};

/** BLS — Bureau of Labor Statistics: CPI by category, employment, wages */
const blsTool: ToolDefinition = {
  schema: {
    name: "bls_data",
    description:
      "Fetch Bureau of Labor Statistics data: CPI by category, employment by industry, wages by occupation, producer price index. Key series: CES0000000001 (nonfarm payrolls), CUSR0000SA0 (CPI all urban), LNS14000000 (unemployment rate). Data labeled REPORTED.",
    input_schema: {
      type: "object",
      properties: {
        series_ids: {
          type: "array",
          items: { type: "string" },
          description: "BLS series IDs to fetch (max 5). E.g. ['CUSR0000SA0', 'CES0000000001']",
        },
        start_year: {
          type: "string",
          description: "Start year (YYYY). Default: 2 years ago",
        },
        end_year: {
          type: "string",
          description: "End year (YYYY). Default: current year",
        },
      },
      required: ["series_ids"],
    },
  },
  async execute(input, _ctx) {
    const apiKey = Deno.env.get("BLS_API_KEY");
    const seriesIds = (input.series_ids as string[]).slice(0, 5);
    const now = new Date();
    const startYear = (input.start_year as string) || String(now.getFullYear() - 2);
    const endYear = (input.end_year as string) || String(now.getFullYear());

    const body: Record<string, unknown> = {
      seriesid: seriesIds,
      startyear: startYear,
      endyear: endYear,
    };
    if (apiKey) body.registrationkey = apiKey;

    try {
      const resp = await fetch("https://api.bls.gov/publicAPI/v2/timeseries/data/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        return { success: false, data: null, error: `BLS error: ${resp.status}` };
      }
      const data = await resp.json();
      return {
        success: true,
        data: data.Results,
        metadata: { source: "bls", cached: false, cost_indicator: "free" },
      };
    } catch (e) {
      return { success: false, data: null, error: `BLS failed: ${(e as Error).message}` };
    }
  },
  timeout_ms: 10000,
};

/** World Bank Open Data — international market sizing across 200+ countries */
const worldBankTool: ToolDefinition = {
  schema: {
    name: "world_bank_data",
    description:
      "Fetch World Bank indicators for 200+ countries: GDP per capita, internet penetration, consumer spending, trade, FDI, population, urbanization. Essential for international market sizing and expansion analysis.",
    input_schema: {
      type: "object",
      properties: {
        indicator: {
          type: "string",
          description: "World Bank indicator code. Common: NY.GDP.PCAP.CD (GDP per capita), IT.NET.USER.ZS (internet users %), SP.POP.TOTL (population), NE.CON.PRVT.CD (household consumption), BX.KLT.DINV.CD.WD (FDI inflows)",
        },
        countries: {
          type: "string",
          description: "Semicolon-separated country codes (ISO 2-letter), e.g. 'US;GB;DE;IN;BR'. Use 'all' for all countries. Default: all",
        },
        most_recent_values: {
          type: "number",
          description: "Number of most recent data points per country (1-10). Default: 5",
        },
      },
      required: ["indicator"],
    },
  },
  async execute(input, _ctx) {
    const indicator = input.indicator as string;
    const countries = (input.countries as string) || "all";
    const mrv = (input.most_recent_values as number) || 5;

    const url = `https://api.worldbank.org/v2/country/${countries}/indicator/${indicator}?format=json&per_page=300&mrv=${mrv}`;

    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        return { success: false, data: null, error: `World Bank error: ${resp.status}` };
      }
      const data = await resp.json();
      // World Bank returns [metadata, data_array]
      const records = data[1] || [];
      return {
        success: true,
        data: {
          indicator: indicator,
          records: records.slice(0, 50).map((r: Record<string, unknown>) => ({
            country: (r.country as Record<string, string>)?.value,
            country_code: (r.countryiso3code as string),
            year: r.date,
            value: r.value,
          })),
        },
        metadata: { source: "world_bank", cached: false, cost_indicator: "free" },
      };
    } catch (e) {
      return { success: false, data: null, error: `World Bank failed: ${(e as Error).message}` };
    }
  },
  timeout_ms: 10000,
};

/** NewsData.io — Real-time news from 75K+ sources with sentiment */
const newsDataTool: ToolDefinition = {
  schema: {
    name: "news_search",
    description:
      "Search real-time news from 75,000+ sources worldwide. Filter by topic, country, language, and sentiment. Returns headlines, descriptions, source, and publication time. Use for brand monitoring, competitor press coverage, and industry news.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query — brand name, company, topic, or keywords",
        },
        category: {
          type: "string",
          enum: ["business", "technology", "science", "health", "entertainment", "sports", "politics", "world"],
          description: "News category filter. Default: no filter",
        },
        country: {
          type: "string",
          description: "Country code (e.g. 'us', 'gb', 'de'). Default: no filter",
        },
        sentiment: {
          type: "string",
          enum: ["positive", "negative", "neutral"],
          description: "Filter by article sentiment. Default: no filter",
        },
      },
      required: ["query"],
    },
  },
  async execute(input, _ctx) {
    const apiKey = Deno.env.get("NEWSDATA_API_KEY");
    if (!apiKey) {
      return { success: false, data: null, error: "NEWSDATA_API_KEY not configured" };
    }

    const params = new URLSearchParams({
      apikey: apiKey,
      q: input.query as string,
      language: "en",
    });

    if (input.category) params.set("category", input.category as string);
    if (input.country) params.set("country", input.country as string);
    if (input.sentiment) params.set("sentiment", input.sentiment as string);

    try {
      const resp = await fetch(`https://newsdata.io/api/1/latest?${params}`);
      if (!resp.ok) {
        return { success: false, data: null, error: `NewsData error: ${resp.status}` };
      }
      const data = await resp.json();
      return {
        success: true,
        data: {
          total_results: data.totalResults,
          articles: data.results?.slice(0, 10).map((a: Record<string, unknown>) => ({
            title: a.title,
            description: a.description,
            source: (a.source_name as string),
            url: a.link,
            published: a.pubDate,
            sentiment: a.sentiment,
          })),
        },
        metadata: { source: "newsdata", cached: false, cost_indicator: "free" },
      };
    } catch (e) {
      return { success: false, data: null, error: `NewsData failed: ${(e as Error).message}` };
    }
  },
  timeout_ms: 10000,
};

// ── Document Analysis Tool ──

/** Analyze Document — fetches from Supabase Storage and extracts text */
const analyzeDocumentTool: ToolDefinition = {
  schema: {
    name: "analyze_document",
    description:
      "Retrieve and analyze an uploaded document (PDF, CSV, XLSX, TXT, DOCX). Returns the extracted text content for analysis. Use when the user has uploaded a file and wants it analyzed, summarized, or referenced.",
    input_schema: {
      type: "object",
      properties: {
        document_id: {
          type: "string",
          description: "The document UUID returned from the upload endpoint",
        },
        query: {
          type: "string",
          description: "What to look for or analyze in the document. If omitted, returns the full extracted text.",
        },
      },
      required: ["document_id"],
    },
  },
  async execute(input, ctx) {
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") || "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    );

    const docId = input.document_id as string;

    // Fetch document metadata
    const { data: doc, error: docErr } = await supabase
      .from("documents")
      .select("*")
      .eq("id", docId)
      .single();

    if (docErr || !doc) {
      return { success: false, data: null, error: `Document not found: ${docId}` };
    }

    // Download from Storage
    const { data: fileData, error: storageErr } = await supabase.storage
      .from("documents")
      .download(doc.storage_path);

    if (storageErr || !fileData) {
      return { success: false, data: null, error: `Failed to download: ${storageErr?.message}` };
    }

    // Extract text based on mime type
    let extractedText = "";
    const mimeType = doc.mime_type as string;

    if (mimeType === "text/plain" || mimeType === "text/markdown" || mimeType === "text/html") {
      extractedText = await fileData.text();
    } else if (mimeType === "text/csv" || mimeType === "application/vnd.ms-excel") {
      extractedText = await fileData.text();
      // Cap CSV to avoid token overrun
      if (extractedText.length > 15000) {
        const lines = extractedText.split("\n");
        extractedText = lines.slice(0, 100).join("\n") + `\n\n... [${lines.length - 100} more rows truncated]`;
      }
    } else if (mimeType === "application/json") {
      const jsonText = await fileData.text();
      try {
        const parsed = JSON.parse(jsonText);
        extractedText = JSON.stringify(parsed, null, 2).substring(0, 15000);
      } catch {
        extractedText = jsonText.substring(0, 15000);
      }
    } else if (
      mimeType === "application/pdf" ||
      mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      // Binary formats (PDF, XLSX, DOCX) — extract via Jina Reader
      const { data: signedUrl } = await supabase.storage
        .from("documents")
        .createSignedUrl(doc.storage_path, 300);

      if (signedUrl?.signedUrl) {
        try {
          const jinaResp = await fetch(`https://r.jina.ai/${signedUrl.signedUrl}`, {
            headers: { Accept: "text/markdown" },
          });
          if (jinaResp.ok) {
            extractedText = await jinaResp.text();
            if (extractedText.length > 15000) {
              extractedText = extractedText.substring(0, 15000) + "\n\n... [content truncated]";
            }
          } else {
            extractedText = `[${mimeType} content could not be extracted. The file was uploaded but text extraction failed.]`;
          }
        } catch {
          extractedText = "[Document extraction service unavailable.]";
        }
      }
    } else {
      // Attempt raw text extraction for unknown types
      try {
        extractedText = await fileData.text();
        if (extractedText.length > 15000) {
          extractedText = extractedText.substring(0, 15000) + "\n\n... [content truncated]";
        }
      } catch {
        return { success: false, data: null, error: `Unsupported file type: ${mimeType}` };
      }
    }

    return {
      success: true,
      data: {
        document_id: docId,
        filename: doc.filename,
        mime_type: mimeType,
        size_bytes: doc.size_bytes,
        content: extractedText,
        query: input.query || null,
      },
      metadata: { source: "document_upload", cached: false, cost_indicator: "free" },
    };
  },
  timeout_ms: 30000,
};

// ── Additional Financial Tools ──

/** FMP Earnings Call Transcripts */
const earningsTranscriptTool: ToolDefinition = {
  schema: {
    name: "earnings_transcript",
    description:
      "Fetch earnings call transcripts for public companies. Reveals management commentary on strategy, outlook, competitive positioning, and guidance. Essential for understanding company direction beyond the numbers.",
    input_schema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Stock ticker (e.g. AAPL, MSFT)" },
        year: { type: "number", description: "Year of the earnings call. Default: current year" },
        quarter: { type: "number", enum: [1, 2, 3, 4], description: "Quarter (1-4). Default: most recent" },
      },
      required: ["symbol"],
    },
  },
  async execute(input, _ctx) {
    const apiKey = Deno.env.get("FMP_API_KEY");
    if (!apiKey) return { success: false, data: null, error: "FMP_API_KEY not configured" };

    const symbol = input.symbol as string;
    const year = (input.year as number) || new Date().getFullYear();
    const quarter = (input.quarter as number) || Math.ceil((new Date().getMonth() + 1) / 3);

    const url = `https://financialmodelingprep.com/api/v3/earning_call_transcript/${symbol}?year=${year}&quarter=${quarter}&apikey=${apiKey}`;

    try {
      const resp = await fetch(url);
      if (!resp.ok) return { success: false, data: null, error: `FMP transcript error: ${resp.status}` };
      const data = await resp.json();
      // Truncate long transcripts
      if (Array.isArray(data) && data.length > 0 && data[0].content) {
        data[0].content = data[0].content.substring(0, 12000);
      }
      return {
        success: true,
        data,
        metadata: { source: "financial_modeling_prep", cached: false, cost_indicator: "paid" },
      };
    } catch (e) {
      return { success: false, data: null, error: `Transcript failed: ${(e as Error).message}` };
    }
  },
  timeout_ms: 15000,
};

/** FMP Company News */
const companyNewsTool: ToolDefinition = {
  schema: {
    name: "company_news",
    description:
      "Fetch recent news articles for a specific company. Returns headlines, summaries, sentiment, and source URLs. Use for tracking competitor moves, M&A rumors, product launches, and executive changes.",
    input_schema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Stock ticker (e.g. AAPL, TSLA)" },
        limit: { type: "number", description: "Number of articles (1-50). Default: 15" },
      },
      required: ["symbol"],
    },
  },
  async execute(input, _ctx) {
    const apiKey = Deno.env.get("FMP_API_KEY");
    if (!apiKey) return { success: false, data: null, error: "FMP_API_KEY not configured" };

    const symbol = input.symbol as string;
    const limit = (input.limit as number) || 15;

    const url = `https://financialmodelingprep.com/api/v3/stock_news?tickers=${symbol}&limit=${limit}&apikey=${apiKey}`;

    try {
      const resp = await fetch(url);
      if (!resp.ok) return { success: false, data: null, error: `FMP news error: ${resp.status}` };
      const data = await resp.json();
      return {
        success: true,
        data: {
          symbol,
          articles: (data || []).map((a: Record<string, unknown>) => ({
            title: a.title,
            text: (a.text as string)?.substring(0, 300),
            url: a.url,
            source: a.site,
            published: a.publishedDate,
            sentiment: a.sentiment,
          })),
        },
        metadata: { source: "financial_modeling_prep", cached: false, cost_indicator: "paid" },
      };
    } catch (e) {
      return { success: false, data: null, error: `Company news failed: ${(e as Error).message}` };
    }
  },
  timeout_ms: 10000,
};

// ── Analysis & Planning Tools ──

/** Calculator / Data Analysis — evaluates mathematical expressions */
const calculatorTool: ToolDefinition = {
  schema: {
    name: "calculate",
    description:
      "Evaluate mathematical expressions, financial calculations, statistical analysis. Handles: DCF models, growth rates, CAGR, ratios, percentage changes, NPV, IRR estimates, weighted averages, and basic statistics. Returns precise numerical results.",
    input_schema: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "Mathematical expression to evaluate. Supports: +, -, *, /, **, %, Math functions (sqrt, log, pow, abs, round, floor, ceil, min, max). Examples: '(1500000 / 500000) * 100', 'Math.pow(1.15, 5)', '((125-100)/100)*100'",
        },
        description: {
          type: "string",
          description: "What this calculation represents (e.g. '5-year CAGR for AAPL revenue')",
        },
        variables: {
          type: "object",
          description: "Named variables to use in the expression. E.g. {revenue_2024: 394000000000, revenue_2020: 274000000000}",
        },
      },
      required: ["expression"],
    },
  },
  async execute(input, _ctx) {
    const expression = input.expression as string;
    const description = input.description as string | undefined;
    const variables = input.variables as Record<string, number> | undefined;

    try {
      let evalExpr = expression;
      if (variables) {
        for (const [key, value] of Object.entries(variables)) {
          evalExpr = evalExpr.replace(new RegExp(`\\b${key}\\b`, "g"), String(value));
        }
      }

      const result = new Function("Math", `"use strict"; return (${evalExpr})`)(Math);

      if (typeof result !== "number" || !isFinite(result)) {
        return { success: false, data: null, error: `Expression evaluated to non-finite number: ${result}` };
      }

      return {
        success: true,
        data: {
          expression,
          result,
          formatted: result.toLocaleString("en-US", { maximumFractionDigits: 6 }),
          description: description || null,
        },
        metadata: { source: "calculator", cached: false, cost_indicator: "free" },
      };
    } catch (e) {
      return { success: false, data: null, error: `Calculation error: ${(e as Error).message}` };
    }
  },
  timeout_ms: 5000,
};

/** Query Decomposition — generates optimized search queries from a natural language question */
const queryDecomposeTool: ToolDefinition = {
  schema: {
    name: "decompose_query",
    description:
      "Break a complex research question into multiple optimized search queries. Use BEFORE web_search or academic_search when the user's question is broad or multi-faceted. Returns 3-5 focused, keyword-rich queries that together cover the full question.",
    input_schema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The complex question to decompose into search queries",
        },
        target_tools: {
          type: "array",
          items: { type: "string", enum: ["web_search", "academic_search", "news_sentiment", "financial_data", "sec_filings"] },
          description: "Which tools these queries will be used with (affects query optimization)",
        },
      },
      required: ["question"],
    },
  },
  async execute(input, _ctx) {
    const { callLLM, extractText } = await import("./llm.ts");
    const question = input.question as string;
    const targetTools = (input.target_tools as string[]) || ["web_search"];

    const response = await callLLM({
      system: `You decompose complex research questions into 3-5 focused search queries optimized for the specified tools. Return ONLY a JSON array of query strings. Each query should:
- Be specific and keyword-rich (not natural language questions)
- Cover a different facet of the original question
- Be optimized for the target search tool (e.g., web_search queries should include recent date markers like "2025" or "2026", academic_search should use technical terms)
Example: For "What is Nike's competitive position in the athletic wear market?"
["Nike market share athletic footwear 2025 2026", "Nike vs Adidas vs New Balance revenue comparison", "Nike DTC strategy direct-to-consumer growth", "athletic wear industry trends 2025 consumer preferences", "Nike brand perception Gen Z millennials 2025"]`,
      messages: [{ role: "user", content: `Question: ${question}\nTarget tools: ${targetTools.join(", ")}` }],
      max_tokens: 500,
      temperature: 0.3,
    });

    const text = extractText(response.content);
    try {
      const queries = JSON.parse(text.trim());
      return {
        success: true,
        data: { original_question: question, optimized_queries: queries, target_tools: targetTools },
        metadata: { source: "query_decomposition", cached: false, cost_indicator: "free" },
      };
    } catch {
      const queries = text.split("\n").filter((l: string) => l.trim()).map((l: string) => l.replace(/^[\d\-.*"]+\s*/, "").replace(/"$/, ""));
      return {
        success: true,
        data: { original_question: question, optimized_queries: queries.slice(0, 5), target_tools: targetTools },
        metadata: { source: "query_decomposition", cached: false, cost_indicator: "free" },
      };
    }
  },
  timeout_ms: 15000,
};

/**
 * Score source quality based on source type, recency, and authority.
 * Returns a 0-1 score where 1 = highest quality.
 */
export function scoreSourceQuality(source: string, _data: unknown): number {
  const authorityScores: Record<string, number> = {
    sec_edgar: 0.95, sec_edgar_xbrl: 0.95,
    fred: 0.9, bls: 0.9, world_bank: 0.85,
    financial_modeling_prep: 0.8,
    semantic_scholar: 0.85, crossref: 0.85,
    tavily: 0.6, jina_reader: 0.5,
    gdelt: 0.7, newsdata: 0.6,
    adzuna: 0.7, serpapi_trends: 0.7,
    uspto_patentsview: 0.9,
    calculator: 1.0,
    document_upload: 0.5,
    query_decomposition: 0.8,
  };
  return authorityScores[source] || 0.5;
}

// ── Knowledge Base Tools ──

/** Company Knowledge Base Lookup */
const companyLookupTool: ToolDefinition = {
  schema: {
    name: "company_lookup",
    description:
      "Look up a company in Gregory's persistent knowledge base. Returns stored intelligence including financials, competitors, SWOT analysis, and recent news. Much faster than re-researching — use this FIRST before web search or financial_data for any company query.",
    input_schema: {
      type: "object",
      properties: {
        identifier: {
          type: "string",
          description: "Company name or stock ticker (e.g. 'Nike' or 'NKE')",
        },
        search_industry: {
          type: "string",
          description: "Optionally search all companies in an industry (e.g. 'saas', 'fintech')",
        },
      },
      required: ["identifier"],
    },
  },
  async execute(input, _ctx) {
    const { getCompanyIntel, searchCompanies, getCompaniesByIndustry } = await import("./knowledge-base.ts");

    const identifier = input.identifier as string;
    const searchIndustry = input.search_industry as string | undefined;

    if (searchIndustry) {
      const companies = await getCompaniesByIndustry(searchIndustry);
      return {
        success: true,
        data: { companies, count: companies.length },
        metadata: { source: "knowledge_base", cached: false, cost_indicator: "free" as const },
      };
    }

    const company = await getCompanyIntel(identifier);
    if (company) {
      return {
        success: true,
        data: company,
        metadata: { source: "knowledge_base", cached: false, cost_indicator: "free" as const },
      };
    }

    // Try fuzzy search
    const results = await searchCompanies(identifier, 5);
    if (results.length > 0) {
      return {
        success: true,
        data: { exact_match: false, suggestions: results },
        metadata: { source: "knowledge_base", cached: false, cost_indicator: "free" as const },
      };
    }

    return {
      success: true,
      data: { found: false, message: `No data on '${identifier}' yet. Use financial_data or web_search to research, and Gregory will remember for next time.` },
      metadata: { source: "knowledge_base", cached: false, cost_indicator: "free" as const },
    };
  },
  timeout_ms: 5000,
};

/** Metric Trend Analysis */
const metricTrendTool: ToolDefinition = {
  schema: {
    name: "metric_trend",
    description:
      "Get historical trend data for key metrics tracked by Gregory (S&P 500, consumer sentiment, CPI, unemployment, ad spend, etc.). Returns time-series data for trend analysis without needing an API call.",
    input_schema: {
      type: "object",
      properties: {
        metric_name: {
          type: "string",
          description: "Name of the metric (e.g. 'sp500', 'consumer_sentiment', 'cpi', 'unemployment_rate', 'digital_ad_spend')",
        },
        days: {
          type: "number",
          description: "Number of days of history to retrieve. Default: 30",
        },
        category: {
          type: "string",
          enum: ["market", "economic", "advertising", "consumer", "employment"],
          description: "Get latest values for all metrics in this category",
        },
      },
      required: [],
    },
  },
  async execute(input, _ctx) {
    const { getMetricTrend, getLatestMetrics } = await import("./knowledge-base.ts");

    const metricName = input.metric_name as string | undefined;
    const days = (input.days as number) || 30;
    const category = input.category as string | undefined;

    if (category) {
      const metrics = await getLatestMetrics(category);
      return {
        success: true,
        data: { category, metrics, count: metrics.length },
        metadata: { source: "metric_snapshots", cached: false, cost_indicator: "free" as const },
      };
    }

    if (metricName) {
      const trend = await getMetricTrend(metricName, days);
      if (trend.length === 0) {
        return {
          success: true,
          data: { metric: metricName, found: false, message: "No trend data recorded yet for this metric." },
          metadata: { source: "metric_snapshots", cached: false, cost_indicator: "free" as const },
        };
      }

      // Calculate basic stats
      const values = trend.map((t) => t.value);
      const latest = values[values.length - 1];
      const oldest = values[0];
      const change = latest - oldest;
      const changePercent = oldest !== 0 ? ((change / oldest) * 100).toFixed(2) : "N/A";

      return {
        success: true,
        data: {
          metric: metricName,
          trend,
          summary: {
            latest,
            oldest,
            change,
            change_percent: changePercent,
            min: Math.min(...values),
            max: Math.max(...values),
            data_points: trend.length,
          },
        },
        metadata: { source: "metric_snapshots", cached: false, cost_indicator: "free" as const },
      };
    }

    return {
      success: false,
      data: null,
      error: "Provide either metric_name or category",
    };
  },
  timeout_ms: 5000,
};

/** Knowledge Base Search (cross-table) */
const knowledgeSearchTool: ToolDefinition = {
  schema: {
    name: "knowledge_search",
    description:
      "Search Gregory's entire knowledge base across companies, industry briefs, research cache, and metric data. Use this for broad queries when you're not sure which specific source to check.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to search for (company, industry, topic, metric)",
        },
      },
      required: ["query"],
    },
  },
  async execute(input, _ctx) {
    const { searchCompanies, getLatestMetrics } = await import("./knowledge-base.ts");
    const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");

    const query = input.query as string;
    const lower = query.toLowerCase();
    const results: Record<string, unknown> = {};

    const sb = createClient(
      Deno.env.get("SUPABASE_URL") || "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    );

    // Search companies
    const companies = await searchCompanies(query, 5);
    if (companies.length > 0) {
      results.companies = companies.map((c) => ({
        name: c.company_name,
        ticker: c.ticker,
        industry: c.industry,
        summary: c.summary,
      }));
    }

    // Search industry briefs
    const { data: industries } = await sb
      .from("industry_briefs")
      .select("industry, title, content, data_date")
      .or(`industry.ilike.%${lower}%,title.ilike.%${lower}%`)
      .order("data_date", { ascending: false })
      .limit(3);
    if (industries && industries.length > 0) {
      results.industry_briefs = industries;
    }

    // Search intelligence cache
    const { data: intel } = await sb
      .from("intelligence_cache")
      .select("category, title, content, data_date")
      .ilike("content", `%${lower}%`)
      .order("data_date", { ascending: false })
      .limit(3);
    if (intel && intel.length > 0) {
      results.intelligence_briefs = intel.map((i: { title: string; data_date: string; content: string }) => ({
        title: i.title,
        date: i.data_date,
        preview: i.content.substring(0, 300),
      }));
    }

    // Search research cache
    const { data: research } = await sb
      .from("research_cache")
      .select("tool_name, input_summary, quality_score, created_at")
      .ilike("input_summary", `%${lower}%`)
      .gt("expires_at", new Date().toISOString())
      .order("access_count", { ascending: false })
      .limit(5);
    if (research && research.length > 0) {
      results.cached_research = research;
    }

    const totalResults = Object.values(results).reduce(
      (sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0),
      0,
    );

    return {
      success: true,
      data: { query, results, total_results: totalResults },
      metadata: { source: "knowledge_base", cached: false, cost_indicator: "free" as const },
    };
  },
  timeout_ms: 10000,
};

/** Google Sheets Data Tool */
const sheetsDataTool: ToolDefinition = {
  schema: {
    name: "sheets_data",
    description:
      "Query data from Google Sheets that have been connected to Gregory as data sources. Use for custom datasets, competitor trackers, industry benchmarks, and any user-curated data.",
    input_schema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: ["market_data", "competitor_intel", "industry_benchmarks", "custom"],
          description: "Category of sheet data to query",
        },
        sheet_id: {
          type: "string",
          description: "Specific Google Sheet ID to fetch fresh data from (bypasses sync)",
        },
      },
      required: [],
    },
  },
  async execute(input, _ctx) {
    const sheetId = input.sheet_id as string | undefined;
    const category = input.category as string | undefined;

    if (sheetId) {
      // Direct fetch from a specific sheet
      const { fetchGoogleSheet } = await import("./knowledge-base.ts");
      try {
        const rows = await fetchGoogleSheet(sheetId);
        return {
          success: true,
          data: { rows: rows.slice(0, 100), total_rows: rows.length, truncated: rows.length > 100 },
          metadata: { source: "google_sheets", cached: false, cost_indicator: "free" as const },
        };
      } catch (e) {
        return {
          success: false,
          data: null,
          error: `Failed to fetch sheet: ${(e as Error).message}. Make sure the sheet is published to web (File > Share > Publish to web).`,
        };
      }
    }

    if (category) {
      const { querySheetData } = await import("./knowledge-base.ts");
      const data = await querySheetData(category);
      return {
        success: true,
        data: { category, rows: data, count: data.length },
        metadata: { source: "google_sheets", cached: false, cost_indicator: "free" as const },
      };
    }

    return {
      success: false,
      data: null,
      error: "Provide either a category or a sheet_id to query",
    };
  },
  timeout_ms: 15000,
};

// ── Registry ──

/** All available tools */
export const TOOL_REGISTRY: Record<string, ToolDefinition> = {
  // Original tools
  web_search: webSearchTool,
  web_scrape: webScrapeTool,
  financial_data: financialDataTool,
  sec_filings: secFilingsTool,
  google_trends: googleTrendsTool,
  // Tier 1: High impact, zero/easy auth
  fred_economic_data: fredTool,
  news_sentiment: gdeltTool,
  sec_company_facts: secCompanyFactsTool,
  patent_search: patentSearchTool,
  // Document analysis
  analyze_document: analyzeDocumentTool,
  // Tier 2: High value, minimal setup
  academic_search: academicSearchTool,
  citation_lookup: crossrefTool,
  job_market: jobSearchTool,
  bls_data: blsTool,
  world_bank_data: worldBankTool,
  news_search: newsDataTool,
  // Additional financial
  earnings_transcript: earningsTranscriptTool,
  company_news: companyNewsTool,
  // Analysis & planning
  calculate: calculatorTool,
  decompose_query: queryDecomposeTool,
  // Knowledge base tools
  company_lookup: companyLookupTool,
  metric_trend: metricTrendTool,
  knowledge_search: knowledgeSearchTool,
  sheets_data: sheetsDataTool,
};

/**
 * Get tool schemas for a given set of tool names (for passing to LLM).
 */
export function getToolSchemas(toolNames: string[]): ToolSchema[] {
  return toolNames
    .map((name) => TOOL_REGISTRY[name]?.schema)
    .filter((s): s is ToolSchema => s !== undefined);
}

/**
 * Execute a tool by name with the given input.
 * Respects the tool's timeout.
 */
export async function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = TOOL_REGISTRY[toolName];
  if (!tool) {
    return { success: false, data: null, error: `Unknown tool: ${toolName}` };
  }

  // Wrap execution with a timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), tool.timeout_ms);

  // Check in-memory cache first
  const cachedResult = getCachedResult(toolName, input);
  if (cachedResult) return cachedResult;

  // Check persistent research cache (database-backed, longer TTL)
  try {
    const { getResearchCache } = await import("./knowledge-base.ts");
    const persistentCache = await getResearchCache(toolName, input);
    if (persistentCache) {
      const result: ToolResult = {
        success: true,
        data: persistentCache.data,
        metadata: {
          source: "research_cache",
          cached: true,
          cost_indicator: "free",
          quality_score: persistentCache.quality_score,
        },
      };
      return result;
    }
  } catch {
    // Persistent cache unavailable — continue with live call
  }

  const startMs = Date.now();

  try {
    const result = await Promise.race([
      tool.execute(input, ctx),
      new Promise<ToolResult>((_, reject) => {
        controller.signal.addEventListener("abort", () =>
          reject(new Error(`Tool ${toolName} timed out after ${tool.timeout_ms}ms`))
        );
      }),
    ]);

    const elapsedMs = Date.now() - startMs;

    // Add source quality score
    if (result.success && result.metadata) {
      result.metadata.quality_score = scoreSourceQuality(result.metadata.source, result.data);
    }

    // Cache the result (in-memory)
    setCachedResult(toolName, input, result);

    // Persist to research cache (database, non-blocking)
    if (result.success && result.metadata?.source !== "knowledge_base" && result.metadata?.source !== "research_cache") {
      import("./knowledge-base.ts").then(({ setResearchCache, recordSourceQuery }) => {
        setResearchCache(toolName, input, result.data, result.metadata?.quality_score || 0.5).catch(() => {});
        recordSourceQuery(result.metadata?.source || toolName, true, elapsedMs).catch(() => {});
      }).catch(() => {});
    }

    return result;
  } catch (e) {
    // Record source failure (non-blocking)
    import("./knowledge-base.ts").then(({ recordSourceQuery }) => {
      recordSourceQuery(toolName, false, Date.now() - startMs).catch(() => {});
    }).catch(() => {});

    return {
      success: false,
      data: null,
      error: `Tool execution failed: ${(e as Error).message}`,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
