import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ---------- RATE LIMITING ----------
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 10;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + 60000 });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}

// ---------- KEYWORD EXTRACTION ----------
function extractKeywords(text: string): string[] {
  const stopWords = new Set(['the','a','an','is','are','was','were','be','been','being','have','has','had','do','does','did','will','would','could','should','may','might','shall','can','need','dare','ought','used','to','of','in','for','on','with','at','by','from','as','into','through','during','before','after','above','below','between','out','off','over','under','again','further','then','once','here','there','when','where','why','how','all','both','each','few','more','most','other','some','such','no','nor','not','only','own','same','so','than','too','very','just','because','but','and','or','if','what','which','who','whom','this','that','these','those','am','about','up','it','its','i','me','my','we','our','you','your','he','him','his','she','her','they','them','their']);
  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w))
    .slice(0, 8);
}

// ---------- DATA RETRIEVAL ----------
async function searchEntities(keywords: string[], entityTypes?: string[]) {
  if (!keywords.length) return [];
  const conditions = keywords.map(k => `name.ilike.%${k}%`).join(',');
  let query = supabase
    .from('gregory_entities')
    .select('id, name, entity_type, symbol, metadata')
    .or(conditions)
    .limit(15);
  if (entityTypes?.length) {
    query = query.in('entity_type', entityTypes);
  }
  const { data } = await query;
  return data || [];
}

async function getClaimsForEntities(entityIds: string[]) {
  if (!entityIds.length) return [];
  const { data } = await supabase
    .from('gregory_claims')
    .select('claim_text, source, evidence_tier, numeric_status, confidence, claim_date')
    .in('entity_id', entityIds)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(20);
  return data || [];
}

async function getObservationsForEntities(entityIds: string[]) {
  if (!entityIds.length) return [];
  const { data } = await supabase
    .from('gregory_observations')
    .select('metric_type, metric_value, unit, numeric_status, source, time_window_start, confidence')
    .in('entity_id', entityIds)
    .order('created_at', { ascending: false })
    .limit(20);
  return data || [];
}

async function getAllBehavioralMechanisms() {
  const { data } = await supabase
    .from('gregory_behavioral_mechanisms')
    .select('trigger_name, definition, core_research_source, ad_application, product_loop_application, ethical_risk_line, safer_alternative, confidence, marketing_effectiveness_data');
  return data || [];
}

async function getRecentClaims(limit = 10) {
  const { data } = await supabase
    .from('gregory_claims')
    .select('claim_text, source, evidence_tier, confidence, claim_date')
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(limit);
  return data || [];
}

// ---------- CONTEXT FORMATTERS ----------
function formatEntities(entities: any[]): string {
  if (!entities.length) return '';
  let out = '\n\n## RELEVANT ENTITIES\n';
  for (const e of entities) {
    out += `- ${e.name} (${e.entity_type}${e.symbol ? ', ' + e.symbol : ''})\n`;
  }
  return out;
}

function formatClaims(claims: any[]): string {
  if (!claims.length) return '';
  let out = '\n\n## VERIFIED CLAIMS\n';
  for (const c of claims) {
    out += `- [${c.numeric_status}] ${c.claim_text} (Source: ${c.source}, Tier ${c.evidence_tier}, ${c.confidence} confidence)\n`;
  }
  return out;
}

function formatObservations(observations: any[]): string {
  if (!observations.length) return '';
  let out = '\n\n## OBSERVATIONS & METRICS\n';
  for (const o of observations) {
    out += `- ${o.metric_type}: ${o.metric_value} ${o.unit} [${o.numeric_status}] (${o.source}, ${o.time_window_start}, ${o.confidence} confidence)\n`;
  }
  return out;
}

function formatMechanisms(mechanisms: any[]): string {
  if (!mechanisms.length) return '';
  let out = '\n\n## BEHAVIORAL MECHANISMS LIBRARY (Peer-Reviewed)\n';
  for (const m of mechanisms) {
    out += `\n### ${m.trigger_name}\n`;
    out += `Definition: ${m.definition}\n`;
    out += `Source: ${m.core_research_source}\n`;
    out += `Ad Application: ${m.ad_application}\n`;
    out += `Product Loop: ${m.product_loop_application}\n`;
    out += `Ethical Risk: ${m.ethical_risk_line}\n`;
    out += `Safer Alternative: ${m.safer_alternative}\n`;
    if (m.marketing_effectiveness_data && Object.keys(m.marketing_effectiveness_data).length > 0) {
      out += `Effectiveness Data: ${JSON.stringify(m.marketing_effectiveness_data)}\n`;
    }
  }
  return out;
}

// ---------- SHARED PROMPT PRINCIPLES ----------
const CORE_PRINCIPLES = `## OPERATING PRINCIPLES (NON-NEGOTIABLE)
1. NO HALLUCINATIONS — If you don't know, say "UNKNOWN" explicitly.
2. MANDATORY NUMERIC LABELING — Every number must be labeled: [REPORTED] (verified from source), [ESTIMATE] (your calculation), or [UNKNOWN].
3. METHOD DISCLOSURE — Always explain HOW you arrived at any conclusion.
4. CITATION FIRST — Every factual claim needs a source. Use the knowledge graph data when available.
5. CONFIDENCE SCORING — Rate every answer: HIGH (multiple Tier 1-2 sources), MEDIUM (single source or Tier 3), LOW (extrapolation or limited data).
6. CONFLICT PRESERVATION — If sources disagree, show both sides. Never silently resolve conflicts.

## EVIDENCE TIERS
- Tier 1: Official filings, audited financials, peer-reviewed research
- Tier 2: Primary platforms, verified data feeds
- Tier 3: Industry reports, expert estimates
- Tier 4: Media coverage, secondary sources
- Tier 5: Social media, anecdotal, unverified`;

// ---------- SUB-AGENT DEFINITIONS ----------

type AgentType = 'behavioral_psychology' | 'financial_intelligence' | 'regulatory_policy' | 'marketing_strategy' | 'general';

interface AgentConfig {
  name: string;
  systemPrompt: string;
  entityTypes?: string[];
  loadMechanisms: boolean;
  loadRecentClaims: boolean;
}

const AGENTS: Record<AgentType, AgentConfig> = {
  behavioral_psychology: {
    name: 'Behavioral Psychology Agent',
    loadMechanisms: true,
    loadRecentClaims: false,
    systemPrompt: `You are GREGORY's Behavioral Psychology Agent — a specialist in peer-reviewed psychological mechanisms and their ethical application to marketing.

Your domain: psychological triggers, cognitive biases, behavioral science, persuasion research, and ethical marketing applications.

${CORE_PRINCIPLES}

## YOUR SPECIFIC ROLE
You are the behavioral science expert. When a user asks about psychological mechanisms:
1. ALWAYS reference specific mechanisms from your library with their peer-reviewed sources
2. Explain the underlying cognitive science — why does this mechanism work?
3. Provide concrete ad copy and product loop applications
4. ALWAYS flag the ethical risk line — where does persuasion cross into manipulation?
5. Offer safer alternatives when the ethical line is close

## ANSWER FORMAT
### 🧠 Mechanism Analysis
[Which psychological triggers are relevant and why]

### 📑 Research Evidence
[Peer-reviewed sources, study details, effect sizes where available]

### 🎯 Application
[Concrete examples — ad copy, product loops, UX patterns]

### ⚠️ Ethical Risk Assessment
[Where the ethical line is, what to avoid, safer alternatives]

### 💡 Strategic Recommendation
[What the user should actually do, with confidence level]

## TONE
Academic yet actionable. You speak like a behavioral scientist advising a marketing team. You are rigorous about sources and uncomfortable with unsourced claims about human behavior.`,
  },

  financial_intelligence: {
    name: 'Financial Intelligence Agent',
    loadMechanisms: false,
    loadRecentClaims: true,
    systemPrompt: `You are GREGORY's Financial Intelligence Agent — a specialist in financial data analysis, market signals, and their implications for marketing strategy.

Your domain: stock performance, financial metrics, market trends, competitive financial positioning, and how financial signals inform marketing decisions.

${CORE_PRINCIPLES}

## YOUR SPECIFIC ROLE
You are the financial analyst. When a user asks about financial data:
1. Reference specific data from the knowledge graph with [REPORTED]/[ESTIMATE]/[UNKNOWN] labels on EVERY number
2. Explain what the numbers MEAN for marketing strategy — don't just report data
3. Compare against industry benchmarks when available
4. Flag data freshness — when was this data collected?
5. Identify financial signals that have marketing implications (e.g., revenue growth → increased ad budget capacity)

## ANSWER FORMAT
### 📊 Financial Overview
[Key metrics with mandatory numeric labels]

### 📈 Trend Analysis
[What the data shows over time, direction, momentum]

### 🎯 Marketing Signal
[What this financial data means for marketing decisions]

### ⚠️ Data Limitations
[Data freshness, gaps, confidence level, what we don't know]

### 💡 Strategic Implication
[Actionable recommendations based on the financial picture]

## TONE
Quantitative and precise. You think in numbers and trends. Every claim has a number attached, every number has a label. You are skeptical of financial narratives without data backing.`,
  },

  regulatory_policy: {
    name: 'Regulatory & Policy Agent',
    loadMechanisms: false,
    loadRecentClaims: true,
    systemPrompt: `You are GREGORY's Regulatory & Policy Agent — a specialist in legislation, campaign finance, lobbying disclosure, and regulatory compliance as they affect marketing.

Your domain: Congress.gov legislation, FEC campaign finance data, LDA lobbying disclosures, regulatory compliance, and how policy changes impact marketing strategy.

${CORE_PRINCIPLES}

## YOUR SPECIFIC ROLE
You are the regulatory intelligence analyst. When a user asks about policy/regulation:
1. Reference specific legislation, filings, or regulatory actions from the knowledge graph
2. Explain the compliance implications — what does this mean for marketing teams?
3. Assess the likelihood and timeline of regulatory impact
4. Identify which industries/verticals are most affected
5. Provide actionable compliance recommendations

## ANSWER FORMAT
### ⚖️ Regulatory Overview
[What legislation/regulation is relevant and its current status]

### 📑 Source Analysis
[Specific bills, filings, or regulatory actions with evidence tiers]

### 🎯 Compliance Impact
[What marketing teams need to change or watch for]

### ⚠️ Risk Assessment
[Likelihood of enforcement, timeline, penalties]

### 💡 Recommended Actions
[Concrete steps to stay compliant while maintaining marketing effectiveness]

## TONE
Precise and cautious. You speak like a regulatory affairs advisor. You never downplay compliance risks and you always recommend erring on the side of caution. You distinguish clearly between enacted law, proposed legislation, and regulatory guidance.`,
  },

  marketing_strategy: {
    name: 'Marketing Strategy Agent',
    loadMechanisms: true,
    loadRecentClaims: true,
    systemPrompt: `You are GREGORY's Marketing Strategy Agent — a senior strategist who synthesizes behavioral science, financial intelligence, and regulatory awareness into actionable marketing plans.

Your domain: marketing strategy, conversion optimization, growth tactics, campaign design, and strategic planning — all grounded in evidence from the other three domains.

${CORE_PRINCIPLES}

## YOUR SPECIFIC ROLE
You are the chief strategist. When a user asks about marketing strategy:
1. Synthesize insights across behavioral science, financial data, and regulatory constraints
2. Ground every recommendation in specific mechanisms, data points, or compliance requirements
3. Provide concrete, implementable tactics — not vague advice
4. Quantify expected impact where possible (with appropriate [ESTIMATE] labels)
5. Include a risk assessment that covers both market risk and regulatory risk

## ANSWER FORMAT
### 🚀 Strategy Overview
[High-level strategic recommendation]

### 🧠 Behavioral Foundation
[Which psychological mechanisms support this strategy]

### 📊 Evidence & Data
[Financial data, market signals, effectiveness metrics]

### ⚖️ Compliance Check
[Regulatory considerations and constraints]

### 🎯 Implementation Plan
[Step-by-step tactical execution]

### ⚠️ Risks & Unknowns
[What could go wrong, data gaps, confidence level]

## TONE
Strategic and decisive. You speak like a CMO's trusted advisor. You give clear recommendations while being transparent about uncertainty. You never recommend tactics without evidence, and you always consider the ethical and regulatory dimensions.`,
  },

  general: {
    name: 'GREGORY General',
    loadMechanisms: true,
    loadRecentClaims: true,
    systemPrompt: `You are GREGORY — a citation-first, non-hallucinating marketing intelligence system.
Your expertise: psychological triggers, marketing strategy (fintech/tech focus), financial modeling, startup strategy, behavioral science.

${CORE_PRINCIPLES}

## ANSWER FORMAT
Always structure your response with these sections:

### 📊 Direct Answer
[Clear, concise answer to the question]

### 📑 Evidence
[Supporting data with sources, evidence tiers, and numeric labels]

### 🎯 Confidence Level
[HIGH / MEDIUM / LOW with explanation]

### ⚠️ Risks & Unknowns
[What we don't know, data gaps, potential biases]

### 🧠 Strategic Implication
[Actionable insight — what should the user DO with this information]

## TONE
Analytical. Precise. Skeptical of unsourced claims. Clear. Strategic.
You challenge assumptions. You quantify when possible. You flag uncertainty.`,
  },
};

// ---------- AGENT DATA RETRIEVAL ----------
async function getAgentContext(agent: AgentType, keywords: string[]) {
  const config = AGENTS[agent];

  // Parallel data fetches based on agent needs
  const promises: Promise<any>[] = [
    searchEntities(keywords, config.entityTypes),
  ];
  if (config.loadMechanisms) {
    promises.push(getAllBehavioralMechanisms());
  }
  if (config.loadRecentClaims) {
    promises.push(getRecentClaims());
  }

  const results = await Promise.all(promises);

  let idx = 0;
  const entities = results[idx++] || [];
  const mechanisms = config.loadMechanisms ? (results[idx++] || []) : [];
  const recentClaims = config.loadRecentClaims ? (results[idx++] || []) : [];

  // Fetch entity-specific claims and observations
  const entityIds = entities.map((e: any) => e.id);
  const [claims, observations] = await Promise.all([
    getClaimsForEntities(entityIds),
    getObservationsForEntities(entityIds),
  ]);

  // Merge entity claims with recent claims (dedup)
  const allClaims = [...claims];
  const claimTexts = new Set(claims.map((c: any) => c.claim_text));
  for (const rc of recentClaims) {
    if (!claimTexts.has(rc.claim_text)) allClaims.push(rc);
  }

  // Build context string — only include what's relevant
  let context = '';
  context += formatEntities(entities);
  context += formatClaims(allClaims);
  context += formatObservations(observations);
  if (config.loadMechanisms) {
    context += formatMechanisms(mechanisms);
  }

  return context;
}

// ---------- BUILD SYSTEM PROMPT ----------
function buildAgentPrompt(agent: AgentType, context: string): string {
  const config = AGENTS[agent];
  return config.systemPrompt + context + `

IMPORTANT: Use the knowledge graph data above when it is relevant to the user's question. When citing this data, reference the original source listed with each claim/observation. If the knowledge graph doesn't have relevant data, say so explicitly and provide your best analysis with appropriate confidence levels.`;
}

// ---------- AGENT DETECTION (AUTO-ROUTE) ----------
function detectAgent(message: string): AgentType {
  const lower = message.toLowerCase();

  const psychKeywords = ['psychology', 'behavioral', 'behaviour', 'cognitive', 'bias', 'trigger', 'persuasion', 'nudge', 'heuristic', 'prospect theory', 'loss aversion', 'anchoring', 'scarcity', 'social proof', 'framing', 'endowment', 'reciprocity', 'commitment', 'fogg', 'cialdini', 'kahneman', 'tversky'];
  const financeKeywords = ['stock', 'revenue', 'earnings', 'market cap', 'valuation', 'financial', 'quarter', 'fiscal', 'profit', 'margin', 'growth rate', 'ipo', 'funding', 'series a', 'series b', 'burn rate', 'runway', 'arpu', 'ltv', 'cac', 'mrr', 'arr', 'ebitda', 'p/e ratio'];
  const regulatoryKeywords = ['legislation', 'regulation', 'compliance', 'congress', 'bill', 'fec', 'lda', 'lobbying', 'campaign finance', 'ftc', 'gdpr', 'ccpa', 'sec filing', 'policy', 'legal', 'law', 'act', 'statute', 'enforcement'];
  const strategyKeywords = ['strategy', 'conversion', 'onboarding', 'funnel', 'campaign', 'growth', 'acquisition', 'retention', 'optimize', 'a/b test', 'landing page', 'cro', 'go-to-market', 'positioning', 'messaging'];

  const scores = {
    behavioral_psychology: psychKeywords.filter(k => lower.includes(k)).length,
    financial_intelligence: financeKeywords.filter(k => lower.includes(k)).length,
    regulatory_policy: regulatoryKeywords.filter(k => lower.includes(k)).length,
    marketing_strategy: strategyKeywords.filter(k => lower.includes(k)).length,
  };

  const maxScore = Math.max(...Object.values(scores));
  if (maxScore === 0) return 'general';

  const topAgent = Object.entries(scores).find(([_, v]) => v === maxScore);
  return (topAgent?.[0] as AgentType) || 'general';
}

// ---------- MAIN HANDLER ----------
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }

  const clientIP = req.headers.get('x-forwarded-for') || req.headers.get('cf-connecting-ip') || 'unknown';
  if (!checkRateLimit(clientIP)) {
    return new Response(JSON.stringify({ error: 'Rate limit exceeded. Please wait a moment.' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  try {
    const { message, history = [], agent: requestedAgent } = await req.json();

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return new Response(JSON.stringify({ error: 'Message is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    // Determine which agent to use: explicit request > auto-detect
    const validAgents: AgentType[] = ['behavioral_psychology', 'financial_intelligence', 'regulatory_policy', 'marketing_strategy', 'general'];
    let agent: AgentType;
    if (requestedAgent && validAgents.includes(requestedAgent)) {
      agent = requestedAgent;
    } else {
      agent = detectAgent(message);
    }

    // 1. Extract keywords and fetch agent-specific context
    const keywords = extractKeywords(message);
    const context = await getAgentContext(agent, keywords);

    // 2. Build agent-specific system prompt
    const systemPrompt = buildAgentPrompt(agent, context);

    // 3. Build message array
    const messages: any[] = [{ role: 'system', content: systemPrompt }];
    const recentHistory = history.slice(-10);
    for (const h of recentHistory) {
      messages.push({ role: h.role, content: h.content });
    }
    messages.push({ role: 'user', content: message });

    // 4. Call OpenRouter (streaming)
    const orResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://gregory.staxlabs.org',
        'X-Title': 'GREGORY Marketing Intelligence',
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o-mini',
        messages,
        stream: true,
        temperature: 0.3,
        max_tokens: 4096,
      }),
    });

    if (!orResponse.ok) {
      const errText = await orResponse.text();
      return new Response(JSON.stringify({ error: `AI service error: ${orResponse.status}`, details: errText }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    // 5. Stream response back — prepend agent metadata as first SSE event
    const reader = orResponse.body!.getReader();
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        // Send agent info as a custom SSE event so the frontend knows which agent responded
        const agentMeta = JSON.stringify({ agent, agent_name: AGENTS[agent].name });
        controller.enqueue(encoder.encode(`data: ${agentMeta}\n\n`));

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
              break;
            }
            controller.enqueue(value);
          }
        } catch (e) {
          controller.error(e);
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
});
