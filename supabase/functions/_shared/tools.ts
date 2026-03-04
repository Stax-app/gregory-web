/**
 * GREGORY — Tool Registry & Executors
 * Defines all tools available to agentic Gregory: web search, financial data,
 * web scraping, SEC filings, Google Trends, and document analysis.
 */

import type { ToolSchema } from "./llm.ts";

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
      required: [],
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
    } else if (mimeType === "application/pdf") {
      // For PDFs, we use the raw text extraction approach
      // Supabase Edge Functions can't run native PDF parsers,
      // so we convert to text via Jina Reader as a workaround
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
            extractedText = "[PDF content could not be extracted. The file was uploaded but text extraction failed.]";
          }
        } catch {
          extractedText = "[PDF extraction service unavailable.]";
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

  try {
    const result = await Promise.race([
      tool.execute(input, ctx),
      new Promise<ToolResult>((_, reject) => {
        controller.signal.addEventListener("abort", () =>
          reject(new Error(`Tool ${toolName} timed out after ${tool.timeout_ms}ms`))
        );
      }),
    ]);
    return result;
  } catch (e) {
    return {
      success: false,
      data: null,
      error: `Tool execution failed: ${(e as Error).message}`,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
