/**
 * GREGORY — Backend Agent Configuration
 * Mirrors the frontend agents.js with added tool permissions per agent.
 * System prompts are imported from the frontend config at build time;
 * this module adds the backend-specific metadata and domain-specific
 * tool-usage instructions.
 */

// ── Types ──

export interface AgentConfig {
  key: string;
  name: string;
  shortName: string;
  /** Tools this agent is allowed to use */
  tools: string[];
  /** Domain-specific tool instructions appended to the system prompt */
  toolInstructions: string;
  /** The system prompt for this agent (loaded at runtime from frontend) */
  systemPrompt: string;
}

// ── Domain-Specific Tool Instructions ──

const BEHAVIORAL_TOOL_INSTRUCTIONS = `

═══ REAL-TIME TOOLS ═══

You have access to live data tools. Use them proactively to ground your psychology expertise in current evidence:

ACADEMIC RESEARCH:
- academic_search: Search 220M+ peer-reviewed papers on Semantic Scholar. USE THIS when citing specific researchers — verify the paper exists, get exact citation counts, and find the most-cited work in a subfield.
- citation_lookup: Look up DOIs on CrossRef to verify citations are real and get exact citation counts. USE THIS to validate any researcher/year claim before presenting it as fact.

MARKET & CONSUMER SIGNALS:
- google_trends: Compare search interest for psychological phenomena, product categories, or brand terms. USE THIS when analyzing consumer behavior trends or cultural shifts.
- news_sentiment: Track global news sentiment and volume on GDELT. USE THIS for real-time cultural mood analysis, crisis sentiment tracking, or brand perception monitoring.
- fred_economic_data: Get consumer sentiment index (UMCSENT), consumer confidence, and spending data. USE THIS when discussing how economic conditions affect consumer psychology.

GENERAL RESEARCH:
- web_search: Search the web for current studies, replications, and meta-analyses published after your training data.
- web_scrape: Read a specific URL — research paper landing pages, psychology blogs, university press releases.
- news_search: Search 75K+ news sources for recent coverage of behavioral science findings.

WHEN TO USE TOOLS:
- User asks about a specific researcher or study → academic_search + citation_lookup to verify
- User asks about current consumer behavior trends → google_trends + fred_economic_data
- User asks about public sentiment or brand perception → news_sentiment
- User asks about the replication status of a finding → academic_search for recent meta-analyses
- User references a specific paper → citation_lookup to get exact citation count and verify

WHEN NOT TO USE TOOLS:
- Explaining established theory (prospect theory, Big Five, etc.) from your training data
- Discussing frameworks and models you already know deeply
- Simple definitions or conceptual explanations`;

const FINANCIAL_TOOL_INSTRUCTIONS = `

═══ REAL-TIME TOOLS ═══

You have access to live financial data tools. Use them aggressively — your value is in combining institutional-grade frameworks with current data:

FINANCIAL DATA:
- financial_data: Stock quotes, company profiles, income statements, balance sheets, cash flow, ratios, sector performance, treasury yields from Financial Modeling Prep. All data labeled REPORTED.
- sec_company_facts: Structured XBRL data from SEC EDGAR — exact revenue, net income, EPS, assets, and 100s of other reported financial facts. USE THIS for precise financial figures.
- sec_filings: Full-text search across 20+ years of SEC filings. USE THIS to find competitor strategy language in 10-K management discussion sections.

ECONOMIC DATA:
- fred_economic_data: 840K+ Federal Reserve time series — CPI (CPIAUCSL), fed funds rate (FEDFUNDS), unemployment (UNRATE), GDP, consumer sentiment (UMCSENT), retail sales (RSXFS), 10-year treasury (DGS10), PCE.
- bls_data: Bureau of Labor Statistics — CPI by category, employment by industry, wages by occupation, JOLTS data. USE THIS for granular labor market and inflation data.
- world_bank_data: GDP per capita, trade, FDI, internet penetration across 200+ countries. USE THIS for international market sizing.

MARKET INTELLIGENCE:
- web_search: Search for earnings reports, analyst coverage, market news, IPO filings.
- google_trends: Compare search interest for competing products or market categories.
- news_sentiment: Track news volume and sentiment for a company or sector on GDELT.
- news_search: Real-time news from 75K+ sources for earnings coverage, M&A news, macro events.
- job_market: Search Adzuna job postings — competitor hiring surges signal expansion or product launches. Track salary benchmarks for labor cost analysis.

COMPETITIVE R&D:
- patent_search: Search USPTO patents by company or technology. USE THIS to reveal competitor R&D pipelines 18-24 months before product launches.

CITATION VERIFICATION:
- academic_search + citation_lookup: Verify financial research citations (Fama-French, behavioral finance studies).

WHEN TO USE TOOLS:
- ANY question about a specific company → financial_data + sec_company_facts
- Questions about market conditions → fred_economic_data + bls_data
- Valuation questions → financial_data for comps + sec_company_facts for fundamentals
- International expansion analysis → world_bank_data
- Competitor intelligence → sec_filings + patent_search + job_market
- Current events affecting markets → news_sentiment + news_search

WHEN NOT TO USE TOOLS:
- Explaining valuation methodology (DCF, comps, LBO) from your training
- Discussing financial theory or frameworks abstractly`;

const REGULATORY_TOOL_INSTRUCTIONS = `

═══ REAL-TIME TOOLS ═══

You have access to live regulatory and legal research tools. Use them to provide current, accurate compliance guidance:

REGULATORY DATA:
- sec_filings: Full-text search across all SEC filings — find enforcement actions, consent decrees, compliance disclosures. USE THIS to cite specific regulatory precedent.
- sec_company_facts: Structured SEC data for public companies — useful when analyzing compliance disclosures in financial statements.

NEWS & ENFORCEMENT:
- web_search: Search for recent FTC actions, state AG enforcement, privacy law updates, AI regulation developments. USE THIS for any question about "current" or "recent" regulatory changes.
- news_search: Real-time news from 75K+ sources — filter by topic to catch regulatory announcements, enforcement actions, and legislative updates.
- news_sentiment: Track GDELT news volume around regulatory topics — useful for gauging the intensity of regulatory scrutiny on an issue.

LEGISLATIVE CONTEXT:
- web_scrape: Read specific regulatory URLs — congress.gov bill pages, FTC guidance documents, state privacy law texts.
- fred_economic_data: Economic data relevant to regulation — when regulators cite economic conditions in enforcement rationale.

INDUSTRY INTELLIGENCE:
- patent_search: Search patents for technology that may face regulatory scrutiny (AI, biotech, fintech).
- job_market: Track compliance hiring trends — a surge in compliance officer postings at a company signals regulatory pressure.

ACADEMIC EVIDENCE:
- academic_search: Find peer-reviewed research on regulatory effectiveness, consumer protection outcomes, privacy impact studies. USE THIS when discussing whether a regulation actually achieves its stated goals.

WHEN TO USE TOOLS:
- ANY question about current law or recent changes → web_search + news_search
- Questions about enforcement precedent → sec_filings + web_search for FTC/AG actions
- Questions about pending legislation → web_scrape congress.gov pages
- Questions about privacy law landscape → web_search for state-by-state updates
- Questions about AI regulation → web_search + news_search for EU AI Act, state AI laws

WHEN NOT TO USE TOOLS:
- Explaining established regulatory frameworks (GDPR structure, CAN-SPAM requirements)
- Discussing general compliance principles from your training`;

const MARKETING_TOOL_INSTRUCTIONS = `

═══ REAL-TIME TOOLS ═══

You have access to live market intelligence tools. Use them to back every recommendation with current data:

MARKET RESEARCH:
- web_search: Search for current benchmarks, case studies, industry reports, competitor campaigns. USE THIS heavily — marketing strategy must be grounded in current market reality.
- google_trends: Compare search interest for competing brands, product categories, or marketing trends. USE THIS to validate market demand signals before recommending a strategy.
- news_search: Real-time news from 75K+ sources — track competitor launches, campaign coverage, industry trends.
- news_sentiment: Track brand sentiment and news volume on GDELT — monitor competitor PR, track campaign impact over time.

COMPETITIVE INTELLIGENCE:
- job_market: Search Adzuna for competitor hiring patterns. A competitor posting 30 new marketing roles = major campaign incoming. Track which roles they're hiring for to infer strategy (PLG hiring → product-led pivot, ABM hiring → enterprise push).
- patent_search: What technology are competitors patenting? USE THIS for product positioning insights.
- financial_data: Competitor revenue, margins, and growth rates from Financial Modeling Prep. USE THIS when recommending pricing strategy or competitive positioning.
- sec_filings: Search competitor 10-K filings for marketing spend disclosures, customer acquisition cost mentions, and strategic direction language.
- sec_company_facts: Exact revenue and segment data for public competitors.

CONSUMER & ECONOMIC CONTEXT:
- fred_economic_data: Consumer sentiment (UMCSENT), retail sales (RSXFS), CPI inflation (CPIAUCSL). USE THIS to contextualize marketing strategy within the current economic environment.
- bls_data: Employment data, wages by industry, CPI by category — relevant for targeting and pricing decisions.
- world_bank_data: International market sizing — GDP per capita, internet penetration, consumer spending by country. USE THIS for global GTM planning.

ACADEMIC EVIDENCE:
- academic_search: Find peer-reviewed evidence for marketing frameworks and tactics. USE THIS to cite specific research when recommending a strategy.
- citation_lookup: Verify that cited marketing research is real and well-cited.

WHEN TO USE TOOLS:
- ANY competitive analysis → job_market + financial_data + sec_filings + news_sentiment
- GTM strategy → google_trends + world_bank_data + web_search for market sizing
- Campaign recommendations → web_search for current benchmarks + news_search for industry context
- Pricing strategy → financial_data for competitor comps + fred_economic_data for macro context
- International expansion → world_bank_data + google_trends by geo

WHEN NOT TO USE TOOLS:
- Explaining established frameworks (AARRR, positioning, copy formulas)
- Generic strategic advice that doesn't need current data`;

const HUB_TOOL_INSTRUCTIONS = `

═══ REAL-TIME TOOLS ═══

As the senior orchestrator, you have access to ALL tools across all domains. Use them to synthesize cross-disciplinary intelligence:

FINANCIAL & ECONOMIC:
- financial_data: Stock quotes, financials, sector performance (REPORTED)
- sec_company_facts: Exact XBRL financial data from SEC filings
- sec_filings: Full-text search across 20+ years of SEC filings
- fred_economic_data: Federal Reserve time series — CPI, consumer sentiment, unemployment, GDP, interest rates
- bls_data: Bureau of Labor Statistics — employment, wages, CPI by category, JOLTS
- world_bank_data: International indicators across 200+ countries

NEWS & SENTIMENT:
- web_search: General web search for any current information
- news_search: Real-time news from 75K+ sources (NewsData.io)
- news_sentiment: Global news sentiment and volume tracking (GDELT)

COMPETITIVE INTELLIGENCE:
- job_market: Live job postings and salary data (Adzuna) — hiring surge detection
- patent_search: USPTO patent search — competitor R&D intelligence
- google_trends: Search interest comparison — market demand signals

ACADEMIC & RESEARCH:
- academic_search: 220M+ peer-reviewed papers (Semantic Scholar)
- citation_lookup: DOI and citation verification (CrossRef)

CONTENT EXTRACTION:
- web_scrape: Read any URL — articles, reports, regulatory guidance (Jina Reader)
- analyze_document: Read and analyze uploaded documents (PDF, CSV, XLSX, TXT). USE THIS when the user has attached a file and wants it analyzed, summarized, or referenced.

WHEN TO USE TOOLS:
- Always look up current data when a question would benefit from it
- For cross-domain synthesis, use multiple tools: financial_data + news_sentiment + academic_search
- For competitor deep-dives: financial_data + sec_filings + job_market + patent_search + news_sentiment
- For market entry: world_bank_data + google_trends + news_search
- For evidence-based strategy: academic_search + fred_economic_data + financial_data
- Cite the tool source with every data point: "(FRED: UMCSENT)" or "(SEC 10-K filing)" or "(Semantic Scholar: 2,341 citations)"

WHEN NOT TO USE TOOLS:
- Questions about established theory, frameworks, or methodology
- Simple explanations or definitions that your training covers deeply`;

// ── Agent Definitions ──

export const AGENT_CONFIGS: Record<string, AgentConfig> = {
  behavioral: {
    key: "behavioral",
    name: "Behavioral Psychology",
    shortName: "Behavioral",
    tools: [
      "web_search", "web_scrape", "google_trends",
      "academic_search", "citation_lookup",
      "news_sentiment", "news_search",
      "fred_economic_data",
      "analyze_document",
    ],
    toolInstructions: BEHAVIORAL_TOOL_INSTRUCTIONS,
    systemPrompt: "",
  },
  financial: {
    key: "financial",
    name: "Financial Intelligence",
    shortName: "Financial",
    tools: [
      "web_search", "web_scrape", "google_trends",
      "financial_data", "sec_filings", "sec_company_facts",
      "fred_economic_data", "bls_data", "world_bank_data",
      "news_sentiment", "news_search",
      "job_market", "patent_search",
      "academic_search", "citation_lookup",
      "analyze_document",
    ],
    toolInstructions: FINANCIAL_TOOL_INSTRUCTIONS,
    systemPrompt: "",
  },
  regulatory: {
    key: "regulatory",
    name: "Regulatory & Policy",
    shortName: "Regulatory",
    tools: [
      "web_search", "web_scrape",
      "sec_filings", "sec_company_facts",
      "news_search", "news_sentiment",
      "fred_economic_data",
      "patent_search", "job_market",
      "academic_search",
      "analyze_document",
    ],
    toolInstructions: REGULATORY_TOOL_INSTRUCTIONS,
    systemPrompt: "",
  },
  marketing: {
    key: "marketing",
    name: "Marketing Strategy",
    shortName: "Marketing",
    tools: [
      "web_search", "web_scrape", "google_trends",
      "financial_data", "sec_filings", "sec_company_facts",
      "fred_economic_data", "bls_data", "world_bank_data",
      "news_sentiment", "news_search",
      "job_market", "patent_search",
      "academic_search", "citation_lookup",
      "analyze_document",
    ],
    toolInstructions: MARKETING_TOOL_INSTRUCTIONS,
    systemPrompt: "",
  },
};

export const HUB_CONFIG: AgentConfig = {
  key: "gregory",
  name: "GREGORY Hub",
  shortName: "GREGORY",
  tools: [
    "web_search", "web_scrape", "google_trends",
    "financial_data", "sec_filings", "sec_company_facts",
    "fred_economic_data", "bls_data", "world_bank_data",
    "news_sentiment", "news_search",
    "job_market", "patent_search",
    "academic_search", "citation_lookup",
    "analyze_document",
  ],
  toolInstructions: HUB_TOOL_INSTRUCTIONS,
  systemPrompt: "",
};

/**
 * Get the agent config for a given key.
 * Returns the Hub config if key is null/undefined.
 */
export function getAgentConfig(agentKey: string | null): AgentConfig {
  if (!agentKey || agentKey === "gregory") return HUB_CONFIG;
  return AGENT_CONFIGS[agentKey] || HUB_CONFIG;
}

/**
 * Augment a system prompt with domain-specific tool-usage instructions.
 * Appends the agent's tailored tool instructions to the original system prompt.
 */
export function augmentWithToolInstructions(systemPrompt: string, agentKey?: string | null): string {
  const config = getAgentConfig(agentKey || null);
  return systemPrompt + config.toolInstructions;
}
