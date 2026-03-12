/**
 * STAXLABS — Content Generation Edge Function
 *
 * Endpoints:
 *   POST { action: "generate", content_type: "weekly_recap"|"top_movers"|..., params?: {} }
 *     — Fetch FMP data, call LLM with tool-use, generate content, store in DB, return payload
 *   POST { action: "list", content_type?: string }
 *     — List recent generated content (last 20)
 *   POST { action: "get", id: string }
 *     — Get specific content by ID
 *
 * Requires: FMP_API_KEY, ANTHROPIC_API_KEY (or OPENROUTER_API_KEY) in environment
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callLLM, extractToolCalls, extractText } from "../_shared/llm.ts";
import type { ToolSchema } from "../_shared/llm.ts";

// ── CORS ──

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// ── FMP Data Fetching ──

const FMP_BASE = "https://financialmodelingprep.com/api";

async function fmpFetch(path: string, apiKey: string): Promise<unknown> {
  try {
    const sep = path.includes("?") ? "&" : "?";
    const resp = await fetch(`${FMP_BASE}${path}${sep}apikey=${apiKey}`);
    if (!resp.ok) return null;
    return await resp.json();
  } catch (_e) {
    return null;
  }
}

async function fetchWeeklyRecapData(apiKey: string): Promise<Record<string, unknown>> {
  const [sectorPerf, gainers, losers, sp500Quote, treasury] = await Promise.all([
    fmpFetch("/v3/sector-performance", apiKey),
    fmpFetch("/v3/stock_market/gainers", apiKey),
    fmpFetch("/v3/stock_market/losers", apiKey),
    fmpFetch("/v3/quote/SPY", apiKey),
    fmpFetch("/v4/treasury", apiKey),
  ]);
  return { sector_performance: sectorPerf, gainers, losers, sp500_quote: sp500Quote, treasury };
}

async function fetchTopMoversData(apiKey: string): Promise<Record<string, unknown>> {
  const [gainers, losers] = await Promise.all([
    fmpFetch("/v3/stock_market/gainers", apiKey),
    fmpFetch("/v3/stock_market/losers", apiKey),
  ]);
  return { gainers, losers };
}

async function fetchCore4Data(apiKey: string, symbols: string[]): Promise<Record<string, unknown>> {
  const results: Record<string, unknown> = {};
  await Promise.all(symbols.map(async (sym) => {
    const ticker = sym.trim().toUpperCase();
    const [quote, rating, keyMetrics] = await Promise.all([
      fmpFetch(`/v3/quote/${ticker}`, apiKey),
      fmpFetch(`/v3/rating/${ticker}`, apiKey),
      fmpFetch(`/v3/key-metrics/${ticker}?limit=1`, apiKey),
    ]);
    results[ticker] = { quote, rating, key_metrics: keyMetrics };
  }));
  return results;
}

async function fetchHedgeFundData(apiKey: string, fundName?: string): Promise<Record<string, unknown>> {
  // Fetch institutional holder data for major tickers as a proxy
  const tickers = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA", "BRK-B"];
  const holdings: Record<string, unknown> = {};
  await Promise.all(tickers.map(async (ticker) => {
    const data = await fmpFetch(`/v3/institutional-holder/${ticker}`, apiKey);
    holdings[ticker] = data;
  }));
  return { fund_name: fundName || "Top Institutional Holders", holdings };
}

// ── Brand Voice System Prompt ──

const BRAND_SYSTEM_PROMPT = `You are StaxLabs' content generation AI. StaxLabs is a quantitative trading platform for Gen-Z investors.

BRAND VOICE:
- Data-driven, bold, confident
- Use financial terminology but keep it accessible
- Edgy but professional — think "Bloomberg meets TikTok"
- Always include specific numbers and percentages
- StaxLabs brand colors: dark navy (#1A1A2E), accent red (#E94560), accent blue (#0F3460)

CRITICAL — CONTENT DEPTH TIER SYSTEM:
Content depth is rated on a 1-5 scale. NEVER go above Tier 3 for any content. The goal is to give valuable, interesting content that makes viewers want MORE — and that "more" lives on StaxLabs.

TIER SCALE:
- Tier 1: Surface-level (just a headline or stat, no context)
- Tier 2: Light context (stat + brief explanation, enough to be interesting)
- Tier 3: Moderate depth (multiple data points, some analysis, real value — but stops short of the full picture) ← THIS IS YOUR MAX
- Tier 4: Deep analysis (full breakdowns, actionable parameters) ← NEVER DO THIS
- Tier 5: Complete intel (everything needed to act without StaxLabs) ← NEVER DO THIS

EXAMPLES OF TIER 3 CONTENT:
- Core4 scores: Show the overall score AND the 4 sub-scores with brief context, but NOT the specific metrics that drive each score or how to improve them
- Top movers: Show the tickers, percentage moves, AND a brief "why it moved" — but NOT the signal analysis or what it means for your portfolio
- Strategy spotlight: Show the strategy concept, return %, Sharpe ratio, AND a high-level description — but NOT the exact entry/exit rules or parameter settings
- Hedge fund intel: Show what they bought/sold AND estimated position value — but NOT the historical pattern or what it signals
- Weekly recap: Show S&P performance, sector leaders/laggards, AND key narrative themes — but NOT the forward-looking AI analysis

THE HOOK: After giving Tier 3 value, always hint at what Tier 4-5 looks like on StaxLabs:
- "Want the full Core4 breakdown? It's on StaxLabs"
- "The strategy parameters are inside StaxLabs — build your own for free"
- "StaxLabs shows you exactly why this matters for your portfolio"
- "Get the AI analysis and real-time alerts on StaxLabs"
Video scripts must include a closing CTA scene. Captions must include a CTA line.

PLATFORM CAPTION RULES:
- Instagram: Up to 2200 chars, engaging hook first line, CTA to StaxLabs, hashtag block at end (#StaxLabs #Investing #FinTok #Markets #Trading #GenZFinance), question CTA to drive comments
- TikTok: Under 150 chars total, curiosity hook, trending hashtags (#StaxLabs #FinTok #Investing #StockMarket)
- X/Twitter: Under 280 chars, punchy, data-forward, CTA to StaxLabs
- LinkedIn: Professional tone, industry insight angle, longer form OK, thought-leadership framing, mention StaxLabs platform

Always use the provided tool to return structured content.`;

// ── Tool Schemas ──

const WEEKLY_RECAP_TOOL: ToolSchema = {
  name: "generate_weekly_recap",
  description: "Generate a complete weekly market recap content package.",
  input_schema: {
    type: "object",
    properties: {
      video_script: {
        type: "object",
        properties: {
          hook: { type: "string", description: "Scroll-stopping opening line under 15 words." },
          scenes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                scene_number: { type: "number" },
                duration: { type: "string", description: "Duration like '5s' or '8s'." },
                visual_description: { type: "string" },
                voiceover_text: { type: "string" },
                text_overlay: { type: "string", description: "Bold on-screen text, max 8 words." },
              },
              required: ["scene_number", "duration", "visual_description", "voiceover_text", "text_overlay"],
            },
          },
          closing_cta: { type: "string" },
        },
        required: ["hook", "scenes", "closing_cta"],
      },
      summary_card: {
        type: "object",
        properties: {
          week_label: { type: "string", description: "e.g. 'Week of Mar 10, 2026'" },
          sp500_change: { type: "string", description: "e.g. '+1.2%'" },
          sp500_price: { type: "string", description: "e.g. '5,234.56'" },
          top_sectors: {
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" }, change: { type: "string" } },
              required: ["name", "change"],
            },
          },
          bottom_sectors: {
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" }, change: { type: "string" } },
              required: ["name", "change"],
            },
          },
          top_gainers: {
            type: "array",
            items: {
              type: "object",
              properties: { ticker: { type: "string" }, change_pct: { type: "string" }, name: { type: "string" } },
              required: ["ticker", "change_pct", "name"],
            },
          },
          top_losers: {
            type: "array",
            items: {
              type: "object",
              properties: { ticker: { type: "string" }, change_pct: { type: "string" }, name: { type: "string" } },
              required: ["ticker", "change_pct", "name"],
            },
          },
          key_takeaway: { type: "string" },
        },
        required: ["week_label", "sp500_change", "sp500_price", "top_sectors", "bottom_sectors", "top_gainers", "top_losers", "key_takeaway"],
      },
      platform_captions: {
        type: "object",
        properties: {
          instagram: { type: "string" },
          tiktok: { type: "string" },
          x: { type: "string" },
          linkedin: { type: "string" },
        },
        required: ["instagram", "tiktok", "x", "linkedin"],
      },
    },
    required: ["video_script", "summary_card", "platform_captions"],
  },
};

const TOP_MOVERS_TOOL: ToolSchema = {
  name: "generate_top_movers",
  description: "Generate top movers content package with gainers, losers, video script, and captions.",
  input_schema: {
    type: "object",
    properties: {
      gainers: {
        type: "array",
        items: {
          type: "object",
          properties: {
            rank: { type: "number" },
            ticker: { type: "string" },
            name: { type: "string" },
            change_pct: { type: "string" },
            price: { type: "string" },
            one_liner: { type: "string", description: "Brief explanation of the move." },
          },
          required: ["rank", "ticker", "name", "change_pct", "price", "one_liner"],
        },
        description: "Top 5 gainers.",
      },
      losers: {
        type: "array",
        items: {
          type: "object",
          properties: {
            rank: { type: "number" },
            ticker: { type: "string" },
            name: { type: "string" },
            change_pct: { type: "string" },
            price: { type: "string" },
            one_liner: { type: "string" },
          },
          required: ["rank", "ticker", "name", "change_pct", "price", "one_liner"],
        },
        description: "Top 5 losers.",
      },
      video_script: {
        type: "object",
        properties: {
          hook: { type: "string" },
          scenes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                scene_number: { type: "number" },
                duration: { type: "string" },
                visual_description: { type: "string" },
                voiceover_text: { type: "string" },
                text_overlay: { type: "string" },
              },
              required: ["scene_number", "duration", "visual_description", "voiceover_text", "text_overlay"],
            },
          },
          closing_cta: { type: "string" },
        },
        required: ["hook", "scenes", "closing_cta"],
      },
      commentary: { type: "string", description: "2-3 sentence market commentary tying the movers together." },
      platform_captions: {
        type: "object",
        properties: {
          instagram: { type: "string" },
          tiktok: { type: "string" },
          x: { type: "string" },
          linkedin: { type: "string" },
        },
        required: ["instagram", "tiktok", "x", "linkedin"],
      },
    },
    required: ["gainers", "losers", "video_script", "commentary", "platform_captions"],
  },
};

const STRATEGY_SPOTLIGHT_TOOL: ToolSchema = {
  name: "generate_strategy_spotlight",
  description: "Generate a strategy spotlight content package.",
  input_schema: {
    type: "object",
    properties: {
      strategy_name: { type: "string" },
      description: { type: "string", description: "Plain-English explanation of the strategy." },
      parameters: {
        type: "object",
        description: "Key strategy parameters as key-value pairs.",
      },
      backtest_metrics: {
        type: "object",
        properties: {
          period: { type: "string" },
          return_pct: { type: "string" },
          sharpe_ratio: { type: "string" },
          max_drawdown: { type: "string" },
          win_rate: { type: "string" },
          total_trades: { type: "string" },
        },
        required: ["period", "return_pct", "sharpe_ratio", "max_drawdown", "win_rate", "total_trades"],
      },
      video_script: {
        type: "object",
        properties: {
          hook: { type: "string" },
          scenes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                scene_number: { type: "number" },
                duration: { type: "string" },
                visual_description: { type: "string" },
                voiceover_text: { type: "string" },
                text_overlay: { type: "string" },
              },
              required: ["scene_number", "duration", "visual_description", "voiceover_text", "text_overlay"],
            },
          },
          closing_cta: { type: "string" },
        },
        required: ["hook", "scenes", "closing_cta"],
      },
      key_insight: { type: "string", description: "Single most important takeaway about this strategy." },
      platform_captions: {
        type: "object",
        properties: {
          instagram: { type: "string" },
          tiktok: { type: "string" },
          x: { type: "string" },
          linkedin: { type: "string" },
        },
        required: ["instagram", "tiktok", "x", "linkedin"],
      },
    },
    required: ["strategy_name", "description", "parameters", "backtest_metrics", "video_script", "key_insight", "platform_captions"],
  },
};

const CORE4_SCORE_TOOL: ToolSchema = {
  name: "generate_core4_score",
  description: "Generate Core4 score cards for the given tickers.",
  input_schema: {
    type: "object",
    properties: {
      cards: {
        type: "array",
        items: {
          type: "object",
          properties: {
            ticker: { type: "string" },
            name: { type: "string" },
            price: { type: "string" },
            scores: {
              type: "object",
              properties: {
                performance: { type: "number", description: "1-10 score." },
                value: { type: "number" },
                stability: { type: "number" },
                momentum: { type: "number" },
                overall: { type: "number" },
              },
              required: ["performance", "value", "stability", "momentum", "overall"],
            },
            rating: { type: "string", description: "e.g. 'Strong Buy', 'Hold', 'Sell'." },
            one_liner: { type: "string", description: "Brief verdict on this stock." },
          },
          required: ["ticker", "name", "price", "scores", "rating", "one_liner"],
        },
      },
      platform_captions: {
        type: "object",
        properties: {
          instagram: { type: "string" },
          tiktok: { type: "string" },
          x: { type: "string" },
          linkedin: { type: "string" },
        },
        required: ["instagram", "tiktok", "x", "linkedin"],
      },
    },
    required: ["cards", "platform_captions"],
  },
};

const HEDGE_FUND_INTEL_TOOL: ToolSchema = {
  name: "generate_hedge_fund_intel",
  description: "Generate hedge fund intelligence content package.",
  input_schema: {
    type: "object",
    properties: {
      fund_name: { type: "string" },
      quarter: { type: "string", description: "e.g. 'Q1 2026'" },
      top_buys: {
        type: "array",
        items: {
          type: "object",
          properties: {
            ticker: { type: "string" },
            name: { type: "string" },
            shares: { type: "string" },
            value_change: { type: "string" },
          },
          required: ["ticker", "name", "shares", "value_change"],
        },
      },
      top_sells: {
        type: "array",
        items: {
          type: "object",
          properties: {
            ticker: { type: "string" },
            name: { type: "string" },
            shares: { type: "string" },
            value_change: { type: "string" },
          },
          required: ["ticker", "name", "shares", "value_change"],
        },
      },
      commentary: { type: "string" },
      carousel_slides: {
        type: "array",
        items: {
          type: "object",
          properties: {
            slide_number: { type: "number" },
            headline: { type: "string" },
            tickers: { type: "array", items: { type: "string" } },
            narrative: { type: "string" },
          },
          required: ["slide_number", "headline", "tickers", "narrative"],
        },
      },
      video_script: {
        type: "object",
        properties: {
          hook: { type: "string" },
          scenes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                scene_number: { type: "number" },
                duration: { type: "string" },
                visual_description: { type: "string" },
                voiceover_text: { type: "string" },
                text_overlay: { type: "string" },
              },
              required: ["scene_number", "duration", "visual_description", "voiceover_text", "text_overlay"],
            },
          },
          closing_cta: { type: "string" },
        },
        required: ["hook", "scenes", "closing_cta"],
      },
      platform_captions: {
        type: "object",
        properties: {
          instagram: { type: "string" },
          tiktok: { type: "string" },
          x: { type: "string" },
          linkedin: { type: "string" },
        },
        required: ["instagram", "tiktok", "x", "linkedin"],
      },
    },
    required: ["fund_name", "quarter", "top_buys", "top_sells", "commentary", "carousel_slides", "video_script", "platform_captions"],
  },
};

const USER_SHAREABLE_TOOL: ToolSchema = {
  name: "generate_user_shareable",
  description: "Generate a user shareable card content package.",
  input_schema: {
    type: "object",
    properties: {
      card_type: { type: "string", enum: ["achievement", "milestone", "streak", "returns"] },
      headline: { type: "string", description: "Bold card headline." },
      subtext: { type: "string", description: "Supporting text under the headline." },
      stat_display: { type: "string", description: "The big number/stat shown prominently." },
      badge_text: { type: "string", description: "Badge or label text, e.g. '30-Day Streak'" },
      platform_captions: {
        type: "object",
        properties: {
          instagram: { type: "string" },
          tiktok: { type: "string" },
          x: { type: "string" },
          linkedin: { type: "string" },
        },
        required: ["instagram", "tiktok", "x", "linkedin"],
      },
    },
    required: ["card_type", "headline", "subtext", "stat_display", "badge_text", "platform_captions"],
  },
};

// ── Content Generators ──

async function generateWeeklyRecap(apiKey: string): Promise<{ title: string; payload: unknown; fmpData: unknown; captions: unknown }> {
  const fmpData = await fetchWeeklyRecapData(apiKey);
  const dataSummary = JSON.stringify(fmpData).substring(0, 8000);

  const response = await callLLM({
    system: BRAND_SYSTEM_PROMPT + `\n\nYou are generating a WEEKLY MARKET RECAP for StaxLabs social channels. Analyze the FMP data and create a compelling recap with video script, summary card, and platform captions. Use the generate_weekly_recap tool.`,
    messages: [{ role: "user", content: `Generate a weekly market recap from this FMP data:\n\n${dataSummary}` }],
    tools: [WEEKLY_RECAP_TOOL],
    max_tokens: 4000,
    temperature: 0.5,
  });

  const toolCalls = extractToolCalls(response.content);
  if (toolCalls.length === 0) throw new Error("Weekly recap generation failed — no tool call returned.");
  const result = toolCalls[0].input as Record<string, unknown>;

  return {
    title: `Weekly Market Recap — ${(result.summary_card as Record<string, unknown>)?.week_label || new Date().toLocaleDateString()}`,
    payload: { video_script: result.video_script, summary_card: result.summary_card },
    fmpData,
    captions: result.platform_captions,
  };
}

async function generateTopMovers(apiKey: string): Promise<{ title: string; payload: unknown; fmpData: unknown; captions: unknown }> {
  const fmpData = await fetchTopMoversData(apiKey);
  const dataSummary = JSON.stringify(fmpData).substring(0, 8000);

  const response = await callLLM({
    system: BRAND_SYSTEM_PROMPT + `\n\nYou are generating a TOP MOVERS content package for StaxLabs. Analyze today's biggest gainers and losers. Pick the top 5 of each, write punchy one-liners, create a video script, and market commentary. Use the generate_top_movers tool.`,
    messages: [{ role: "user", content: `Generate top movers content from this FMP data:\n\n${dataSummary}` }],
    tools: [TOP_MOVERS_TOOL],
    max_tokens: 4000,
    temperature: 0.5,
  });

  const toolCalls = extractToolCalls(response.content);
  if (toolCalls.length === 0) throw new Error("Top movers generation failed — no tool call returned.");
  const result = toolCalls[0].input as Record<string, unknown>;

  return {
    title: `Top Movers — ${new Date().toLocaleDateString()}`,
    payload: { gainers: result.gainers, losers: result.losers, video_script: result.video_script, commentary: result.commentary },
    fmpData,
    captions: result.platform_captions,
  };
}

async function generateStrategySpotlight(params: Record<string, unknown>): Promise<{ title: string; payload: unknown; fmpData: unknown; captions: unknown }> {
  const strategyData = params.strategy ? JSON.stringify(params.strategy) : "No backtest data provided — create a hypothetical momentum strategy spotlight using realistic metrics.";

  const response = await callLLM({
    system: BRAND_SYSTEM_PROMPT + `\n\nYou are generating a STRATEGY SPOTLIGHT for StaxLabs. Break down a quantitative trading strategy in a way Gen-Z investors can understand. Include backtest metrics, a video script, and a key insight. Use the generate_strategy_spotlight tool.`,
    messages: [{ role: "user", content: `Generate a strategy spotlight content package. Strategy data:\n\n${strategyData}` }],
    tools: [STRATEGY_SPOTLIGHT_TOOL],
    max_tokens: 4000,
    temperature: 0.5,
  });

  const toolCalls = extractToolCalls(response.content);
  if (toolCalls.length === 0) throw new Error("Strategy spotlight generation failed — no tool call returned.");
  const result = toolCalls[0].input as Record<string, unknown>;

  return {
    title: `Strategy Spotlight: ${result.strategy_name}`,
    payload: {
      strategy_name: result.strategy_name,
      description: result.description,
      parameters: result.parameters,
      backtest_metrics: result.backtest_metrics,
      video_script: result.video_script,
      key_insight: result.key_insight,
    },
    fmpData: params.strategy || null,
    captions: result.platform_captions,
  };
}

async function generateCore4Score(apiKey: string, params: Record<string, unknown>): Promise<{ title: string; payload: unknown; fmpData: unknown; captions: unknown }> {
  const symbolsStr = (params.symbols as string) || "AAPL,MSFT,GOOGL,NVDA";
  const symbols = symbolsStr.split(",").map((s: string) => s.trim()).filter(Boolean);
  const fmpData = await fetchCore4Data(apiKey, symbols);
  const dataSummary = JSON.stringify(fmpData).substring(0, 8000);

  const response = await callLLM({
    system: BRAND_SYSTEM_PROMPT + `\n\nYou are generating CORE4 SCORE CARDS for StaxLabs. The Core4 scoring system rates stocks on 4 dimensions (performance, value, stability, momentum) each 1-10, plus an overall score. Analyze the FMP data (quote, rating, key-metrics) for each ticker and produce honest, data-backed scores. Use the generate_core4_score tool.`,
    messages: [{ role: "user", content: `Generate Core4 score cards for: ${symbols.join(", ")}\n\nFMP Data:\n${dataSummary}` }],
    tools: [CORE4_SCORE_TOOL],
    max_tokens: 4000,
    temperature: 0.3,
  });

  const toolCalls = extractToolCalls(response.content);
  if (toolCalls.length === 0) throw new Error("Core4 score generation failed — no tool call returned.");
  const result = toolCalls[0].input as Record<string, unknown>;

  return {
    title: `Core4 Score: ${symbols.join(", ")}`,
    payload: { cards: result.cards },
    fmpData,
    captions: result.platform_captions,
  };
}

async function generateHedgeFundIntel(apiKey: string, params: Record<string, unknown>): Promise<{ title: string; payload: unknown; fmpData: unknown; captions: unknown }> {
  const fundName = (params.fund_name as string) || undefined;
  const fmpData = await fetchHedgeFundData(apiKey, fundName);
  const dataSummary = JSON.stringify(fmpData).substring(0, 8000);

  const response = await callLLM({
    system: BRAND_SYSTEM_PROMPT + `\n\nYou are generating HEDGE FUND INTELLIGENCE for StaxLabs. Analyze institutional holder data to identify what the smart money is buying and selling. Create a compelling narrative around the data with carousel slides for Instagram and a video script. Use the generate_hedge_fund_intel tool.`,
    messages: [{ role: "user", content: `Generate hedge fund intel content. Data:\n\n${dataSummary}` }],
    tools: [HEDGE_FUND_INTEL_TOOL],
    max_tokens: 4000,
    temperature: 0.5,
  });

  const toolCalls = extractToolCalls(response.content);
  if (toolCalls.length === 0) throw new Error("Hedge fund intel generation failed — no tool call returned.");
  const result = toolCalls[0].input as Record<string, unknown>;

  return {
    title: `Hedge Fund Intel: ${result.fund_name} — ${result.quarter}`,
    payload: {
      fund_name: result.fund_name,
      quarter: result.quarter,
      top_buys: result.top_buys,
      top_sells: result.top_sells,
      commentary: result.commentary,
      carousel_slides: result.carousel_slides,
      video_script: result.video_script,
    },
    fmpData,
    captions: result.platform_captions,
  };
}

async function generateUserShareable(params: Record<string, unknown>): Promise<{ title: string; payload: unknown; fmpData: unknown; captions: unknown }> {
  const achievementData = JSON.stringify(params);

  const response = await callLLM({
    system: BRAND_SYSTEM_PROMPT + `\n\nYou are generating a USER SHAREABLE CARD for StaxLabs. These are cards users share on social media to flex their trading achievements. Make them feel proud and encourage sharing. The card should look like a premium achievement badge. Use the generate_user_shareable tool.`,
    messages: [{ role: "user", content: `Generate a user shareable card from this achievement data:\n\n${achievementData}` }],
    tools: [USER_SHAREABLE_TOOL],
    max_tokens: 2000,
    temperature: 0.5,
  });

  const toolCalls = extractToolCalls(response.content);
  if (toolCalls.length === 0) throw new Error("User shareable generation failed — no tool call returned.");
  const result = toolCalls[0].input as Record<string, unknown>;

  return {
    title: result.headline as string,
    payload: {
      card_type: result.card_type,
      headline: result.headline,
      subtext: result.subtext,
      stat_display: result.stat_display,
      badge_text: result.badge_text,
    },
    fmpData: null,
    captions: result.platform_captions,
  };
}

// ── Edge Function Handler ──

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const body = await req.json();
    const { action } = body;

    const fmpApiKey = Deno.env.get("FMP_API_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

    // ── ACTION: GENERATE ──
    if (action === "generate") {
      const contentType = body.content_type as string;
      const params = (body.params || {}) as Record<string, unknown>;

      const validTypes = ["weekly_recap", "top_movers", "strategy_spotlight", "core4_score", "hedge_fund_intel", "user_shareable"];
      if (!contentType || !validTypes.includes(contentType)) {
        return jsonResponse({ error: `Invalid content_type. Use: ${validTypes.join(", ")}` }, 400);
      }

      if (!fmpApiKey && ["weekly_recap", "top_movers", "core4_score", "hedge_fund_intel"].includes(contentType)) {
        return jsonResponse({ error: "FMP_API_KEY not configured" }, 500);
      }

      let generated: { title: string; payload: unknown; fmpData: unknown; captions: unknown };

      switch (contentType) {
        case "weekly_recap":
          generated = await generateWeeklyRecap(fmpApiKey!);
          break;
        case "top_movers":
          generated = await generateTopMovers(fmpApiKey!);
          break;
        case "strategy_spotlight":
          generated = await generateStrategySpotlight(params);
          break;
        case "core4_score":
          generated = await generateCore4Score(fmpApiKey!, params);
          break;
        case "hedge_fund_intel":
          generated = await generateHedgeFundIntel(fmpApiKey!, params);
          break;
        case "user_shareable":
          generated = await generateUserShareable(params);
          break;
        default:
          return jsonResponse({ error: "Unknown content_type" }, 400);
      }

      // Store in DB
      const record = {
        content_type: contentType,
        title: generated.title,
        payload: generated.payload,
        fmp_data_snapshot: generated.fmpData,
        platform_captions: generated.captions,
        status: "draft",
      };

      let storedId: string | null = null;
      if (supabase) {
        const { data, error: insertError } = await supabase
          .from("staxlabs_content")
          .insert(record)
          .select("id")
          .single();

        if (insertError) {
          console.error("DB insert error:", insertError.message);
          // Return content even if DB write fails
        } else {
          storedId = data?.id || null;
        }
      }

      return jsonResponse({
        id: storedId,
        content_type: contentType,
        title: generated.title,
        payload: generated.payload,
        platform_captions: generated.captions,
        status: "draft",
        created_at: new Date().toISOString(),
      });
    }

    // ── ACTION: LIST ──
    if (action === "list") {
      if (!supabase) {
        return jsonResponse({ error: "Supabase not configured" }, 500);
      }

      let query = supabase
        .from("staxlabs_content")
        .select("id, content_type, title, status, created_at")
        .order("created_at", { ascending: false })
        .limit(20);

      if (body.content_type) {
        query = query.eq("content_type", body.content_type);
      }

      const { data, error } = await query;
      if (error) {
        return jsonResponse({ error: `List failed: ${error.message}` }, 500);
      }

      return jsonResponse({ items: data || [] });
    }

    // ── ACTION: GET ──
    if (action === "get") {
      if (!supabase) {
        return jsonResponse({ error: "Supabase not configured" }, 500);
      }
      if (!body.id) {
        return jsonResponse({ error: "Missing id parameter" }, 400);
      }

      const { data, error } = await supabase
        .from("staxlabs_content")
        .select("*")
        .eq("id", body.id)
        .single();

      if (error) {
        return jsonResponse({ error: `Get failed: ${error.message}` }, 404);
      }

      return jsonResponse(data);
    }

    return jsonResponse({ error: "Invalid action. Use: generate, list, get" }, 400);
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 500);
  }
});
