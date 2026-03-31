/**
 * GREGORY — Monitor Engine
 *
 * Daily automated data collection for:
 *   - Competitive Intelligence: SEC filings, patents, news sentiment, hiring, financials
 *   - Brand Health: GDELT sentiment, Google Trends, competitor comparison
 *
 * Schedule: Daily at 7AM ET (1hr after gregory-weekly-update at 6AM)
 * Auth: Service role key required
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callLLM, extractText } from "../_shared/llm.ts";
import { executeTool } from "../_shared/tools.ts";
import { createAndDispatchAlert, type AlertInput } from "../_shared/notifications.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  // ── Auth: service role only ──
  const authHeader = req.headers.get("Authorization");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const token = authHeader?.replace("Bearer ", "");
  if (!serviceKey || token !== serviceKey) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") || "",
    serviceKey,
  );

  const today = new Date().toISOString().split("T")[0];
  const ctx = { user_id: "monitor_engine", task_id: `monitor_${today}` };

  const stats = {
    competitors_checked: 0,
    competitor_snapshots_created: 0,
    brands_checked: 0,
    brand_snapshots_created: 0,
    digests_generated: 0,
    alerts_created: 0,
    errors: [] as string[],
  };

  // ════════════════════════════════════════
  // COMPETITIVE INTELLIGENCE MONITORING
  // ════════════════════════════════════════

  const { data: compMonitors } = await supabase
    .from("competitor_monitors")
    .select("*")
    .eq("is_active", true);

  if (compMonitors && compMonitors.length > 0) {
    // Group monitors by user for digest generation
    const byUser: Record<string, typeof compMonitors> = {};

    for (const monitor of compMonitors) {
      const userId = monitor.user_id as string;
      if (!byUser[userId]) byUser[userId] = [];
      byUser[userId].push(monitor);

      try {
        stats.competitors_checked++;
        const config = monitor.monitor_config as Record<string, boolean>;
        const company = monitor.company_name as string;
        const ticker = monitor.ticker as string | undefined;

        // Run tool calls based on monitor config (parallel)
        const toolCalls: Array<Promise<{ key: string; result: unknown }>> = [];

        if (config.track_news !== false) {
          toolCalls.push(
            executeTool("news_sentiment", { query: company, mode: "artlist", max_records: 10 }, ctx)
              .then((r) => ({ key: "news_sentiment", result: r.success ? r.data : null })),
          );
        }
        if (config.track_sec !== false && ticker) {
          toolCalls.push(
            executeTool("sec_filings", { query: ticker, form_type: "10-K,10-Q,8-K", limit: 5 }, ctx)
              .then((r) => ({ key: "sec_filings", result: r.success ? r.data : null })),
          );
        }
        if (config.track_patents !== false) {
          toolCalls.push(
            executeTool("patent_search", { query: company, limit: 5 }, ctx)
              .then((r) => ({ key: "patents", result: r.success ? r.data : null })),
          );
        }
        if (config.track_hiring !== false) {
          toolCalls.push(
            executeTool("job_market", { query: company, limit: 10 }, ctx)
              .then((r) => ({ key: "hiring_signals", result: r.success ? r.data : null })),
          );
        }
        if (ticker) {
          toolCalls.push(
            executeTool("financial_data", { endpoint: "quote", symbol: ticker }, ctx)
              .then((r) => ({ key: "financial_snapshot", result: r.success ? r.data : null })),
          );
        }

        const results = await Promise.allSettled(toolCalls);
        const snapshot: Record<string, unknown> = {
          monitor_id: monitor.id,
          snapshot_date: today,
        };

        for (const r of results) {
          if (r.status === "fulfilled") {
            const mapped = r.value;
            snapshot[mapped.key] = mapped.result || {};
          }
        }

        // Generate AI summary comparing to previous snapshot
        const { data: prevSnapshot } = await supabase
          .from("competitor_snapshots")
          .select("*")
          .eq("monitor_id", monitor.id)
          .order("snapshot_date", { ascending: false })
          .limit(1)
          .maybeSingle();

        try {
          const summaryResp = await callLLM({
            system: "You are a competitive intelligence analyst. Be concise and highlight changes.",
            messages: [{
              role: "user",
              content: `Summarize today's competitive intelligence for ${company}${ticker ? ` (${ticker})` : ""} in 2-3 sentences.

Today's data:
- News sentiment: ${JSON.stringify(snapshot.news_sentiment || {}).substring(0, 1000)}
- SEC filings: ${JSON.stringify(snapshot.sec_filings || {}).substring(0, 500)}
- Patents: ${JSON.stringify(snapshot.patents || {}).substring(0, 500)}
- Hiring: ${JSON.stringify(snapshot.hiring_signals || {}).substring(0, 500)}
- Financials: ${JSON.stringify(snapshot.financial_snapshot || {}).substring(0, 500)}

${prevSnapshot ? `Previous snapshot (${prevSnapshot.snapshot_date}): sentiment was ${JSON.stringify(prevSnapshot.news_sentiment?.score || "N/A")}, ${prevSnapshot.ai_summary || "no summary"}` : "No previous snapshot."}

Focus on what changed or what's notable. Be actionable.`,
            }],
            max_tokens: 200,
            temperature: 0.3,
          });
          snapshot.ai_summary = extractText(summaryResp.content);
        } catch {
          snapshot.ai_summary = `Data collected for ${company} on ${today}.`;
        }

        // Upsert snapshot
        await supabase.from("competitor_snapshots").upsert(snapshot, {
          onConflict: "monitor_id,snapshot_date",
        });
        stats.competitor_snapshots_created++;

        // ── Alert Detection ──
        if (prevSnapshot) {
          const alerts: AlertInput[] = [];
          const prevSentiment = (prevSnapshot.news_sentiment as Record<string, unknown>)?.tone as number | undefined;
          const currArticles = ((snapshot.news_sentiment as Record<string, unknown>)?.articles || []) as unknown[];
          const currTone = (snapshot.news_sentiment as Record<string, unknown>)?.tone as number | undefined;

          // Sentiment drop alert
          if (prevSentiment !== undefined && currTone !== undefined && currTone - prevSentiment < -0.3) {
            alerts.push({
              user_id: userId,
              feature: "competitive_intel",
              alert_type: "sentiment_shift",
              severity: "warning",
              title: `${company}: Negative sentiment shift`,
              body: `Sentiment dropped from ${prevSentiment.toFixed(2)} to ${currTone.toFixed(2)}. ${currArticles.length} articles tracked.`,
              metadata: { company, prev: prevSentiment, current: currTone },
            });
          }

          // New SEC filing alert
          const currFilings = ((snapshot.sec_filings as Record<string, unknown>)?.filings || []) as Array<Record<string, unknown>>;
          const prevFilings = ((prevSnapshot.sec_filings as Record<string, unknown>)?.filings || []) as Array<Record<string, unknown>>;
          const newFilings = currFilings.filter(
            (f) => !prevFilings.some((p) => (p.accession_number || p.id) === (f.accession_number || f.id)),
          );
          if (newFilings.length > 0) {
            alerts.push({
              user_id: userId,
              feature: "competitive_intel",
              alert_type: "new_filing",
              severity: "info",
              title: `${company}: ${newFilings.length} new SEC filing(s)`,
              body: newFilings.map((f) => `${f.form_type || f.formType}: ${f.description || f.title || "Filing"}`).join("\n"),
              metadata: { company, filings: newFilings.length },
            });
          }

          for (const alert of alerts) {
            await createAndDispatchAlert(alert);
            stats.alerts_created++;
          }
        }

        // Update last_checked_at
        await supabase
          .from("competitor_monitors")
          .update({ last_checked_at: new Date().toISOString() })
          .eq("id", monitor.id);

      } catch (e) {
        stats.errors.push(`Competitor ${monitor.company_name}: ${(e as Error).message}`);
      }
    }

    // ── Generate Digests per User ──
    for (const [userId, monitors] of Object.entries(byUser)) {
      try {
        const companies = monitors.map((m) => m.company_name as string);
        const monitorIds = monitors.map((m) => m.id);

        const { data: todaySnapshots } = await supabase
          .from("competitor_snapshots")
          .select("*")
          .in("monitor_id", monitorIds)
          .eq("snapshot_date", today);

        if (todaySnapshots && todaySnapshots.length > 0) {
          const summaries = todaySnapshots.map((s: Record<string, unknown>) => {
            const mon = monitors.find((m) => m.id === s.monitor_id);
            return `**${mon?.company_name || "Unknown"}**: ${s.ai_summary || "No data"}`;
          }).join("\n\n");

          const digestResp = await callLLM({
            system: "You are a competitive intelligence analyst writing a daily briefing.",
            messages: [{
              role: "user",
              content: `Write a concise daily competitive intelligence digest for ${today}.

Companies monitored: ${companies.join(", ")}

Individual summaries:
${summaries}

Format as a brief markdown document with:
1. A one-line headline
2. Key developments (bullet points)
3. Action items or things to watch`,
            }],
            max_tokens: 600,
            temperature: 0.3,
          });

          await supabase.from("competitive_digests").insert({
            user_id: userId,
            digest_type: "daily",
            content: extractText(digestResp.content),
            companies_covered: companies,
            data_date: today,
          });
          stats.digests_generated++;
        }
      } catch (e) {
        stats.errors.push(`Digest for user ${userId}: ${(e as Error).message}`);
      }
    }
  }

  // ════════════════════════════════════════
  // BRAND HEALTH MONITORING
  // ════════════════════════════════════════

  const { data: brandMonitors } = await supabase
    .from("brand_monitors")
    .select("*")
    .eq("is_active", true);

  if (brandMonitors && brandMonitors.length > 0) {
    for (const monitor of brandMonitors) {
      try {
        stats.brands_checked++;
        const brandName = monitor.brand_name as string;
        const keywords = (monitor.keywords as string[]) || [];
        const competitors = (monitor.competitors as string[]) || [];
        const alertConfig = monitor.alert_config as Record<string, unknown>;
        const userId = monitor.user_id as string;

        // Query for brand + keywords
        const searchTerms = [brandName, ...keywords].join(" OR ");

        const [sentimentRes, trendsRes] = await Promise.allSettled([
          executeTool("news_sentiment", { query: searchTerms, mode: "artlist", max_records: 15 }, ctx),
          executeTool("google_trends", { keywords: brandName }, ctx),
        ]);

        const sentimentData = sentimentRes.status === "fulfilled" && sentimentRes.value.success
          ? sentimentRes.value.data as Record<string, unknown>
          : {};
        const trendsData = trendsRes.status === "fulfilled" && trendsRes.value.success
          ? trendsRes.value.data as Record<string, unknown>
          : {};

        // Competitor comparison
        const competitorData: Record<string, unknown> = {};
        for (const comp of competitors.slice(0, 3)) { // Limit to 3 competitors to save API calls
          try {
            const compRes = await executeTool("news_sentiment", { query: comp, mode: "artlist", max_records: 5 }, ctx);
            if (compRes.success) {
              competitorData[comp] = compRes.data;
            }
          } catch {
            // Skip failed competitor lookups
          }
        }

        // Extract sentiment score and volume
        const articles = (sentimentData.articles || sentimentData.results || []) as unknown[];
        const tone = sentimentData.tone as number | undefined;
        const sentimentScore = tone !== undefined ? tone : 0;

        const snapshot: Record<string, unknown> = {
          monitor_id: monitor.id,
          snapshot_date: today,
          sentiment_score: sentimentScore,
          sentiment_volume: articles.length,
          news_articles: (articles as Array<Record<string, unknown>>).slice(0, 10).map((a) => ({
            title: a.title || a.headline,
            url: a.url,
            source: a.source || a.domain,
            tone: a.tone,
          })),
          trend_data: trendsData,
          competitor_comparison: competitorData,
        };

        // AI summary
        try {
          const summaryResp = await callLLM({
            system: "You are a brand reputation analyst. Be concise.",
            messages: [{
              role: "user",
              content: `Summarize brand health for "${brandName}" on ${today} in 2-3 sentences.

Sentiment score: ${sentimentScore} (scale: -1 negative to +1 positive)
News volume: ${articles.length} articles
Top headlines: ${(articles as Array<Record<string, unknown>>).slice(0, 3).map((a) => a.title || a.headline).join("; ")}
${competitors.length > 0 ? `Competitor mentions: ${JSON.stringify(Object.keys(competitorData))}` : ""}

Focus on reputation status and any concerns.`,
            }],
            max_tokens: 150,
            temperature: 0.3,
          });
          snapshot.ai_summary = extractText(summaryResp.content);
        } catch {
          snapshot.ai_summary = `Brand health data collected for ${brandName}. Sentiment: ${sentimentScore.toFixed(2)}, Volume: ${articles.length}.`;
        }

        await supabase.from("brand_snapshots").upsert(snapshot, {
          onConflict: "monitor_id,snapshot_date",
        });
        stats.brand_snapshots_created++;

        // ── Alert Detection ──
        const { data: prevSnapshot } = await supabase
          .from("brand_snapshots")
          .select("*")
          .eq("monitor_id", monitor.id)
          .neq("snapshot_date", today)
          .order("snapshot_date", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (prevSnapshot) {
          const prevSentiment = prevSnapshot.sentiment_score as number;
          const prevVolume = prevSnapshot.sentiment_volume as number;
          const dropThreshold = (alertConfig.sentiment_drop_threshold as number) || -0.2;
          const spikeMultiplier = (alertConfig.volume_spike_multiplier as number) || 2.0;

          // Sentiment drop
          if (sentimentScore - prevSentiment < dropThreshold) {
            await createAndDispatchAlert({
              user_id: userId,
              feature: "brand_health",
              alert_type: "sentiment_drop",
              severity: "warning",
              title: `${brandName}: Sentiment dropped`,
              body: `Sentiment fell from ${prevSentiment.toFixed(2)} to ${sentimentScore.toFixed(2)} (threshold: ${dropThreshold}).`,
              metadata: { brand: brandName, prev: prevSentiment, current: sentimentScore },
            });
            stats.alerts_created++;
          }

          // Volume spike
          if (prevVolume > 0 && articles.length > prevVolume * spikeMultiplier) {
            await createAndDispatchAlert({
              user_id: userId,
              feature: "brand_health",
              alert_type: "volume_spike",
              severity: "info",
              title: `${brandName}: News volume spike`,
              body: `${articles.length} articles today vs. ${prevVolume} previously (${spikeMultiplier}x threshold).`,
              metadata: { brand: brandName, prev_volume: prevVolume, current_volume: articles.length },
            });
            stats.alerts_created++;
          }
        }

      } catch (e) {
        stats.errors.push(`Brand ${monitor.brand_name}: ${(e as Error).message}`);
      }
    }
  }

  return new Response(
    JSON.stringify({ success: true, date: today, stats }),
    { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
  );
});
