/**
 * GREGORY — Dashboards API
 *
 * Unified edge function serving all 4 marketing features:
 *   - Competitive Intelligence (feature: "competitive")
 *   - Campaign Strategist (feature: "campaign")
 *   - Lead Intelligence (feature: "leads")
 *   - Brand Health Monitor (feature: "brand")
 *   - Notification management (feature: "notifications")
 *
 * Route: POST { feature, action, ...params }
 */

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callLLM, extractText } from "../_shared/llm.ts";
import { executeTool } from "../_shared/tools.ts";
import { enrichCompany, scoreAndSummarize } from "../_shared/enrichment.ts";
import {
  getUserChannels,
  addChannel,
  removeChannel,
  testChannel,
  getUserAlerts,
  markAlertsRead,
} from "../_shared/notifications.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function err(message: string, status = 400) {
  return json({ error: message }, status);
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  // ── Auth ──
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return err("Missing authorization", 401);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_ANON_KEY") || "",
    { global: { headers: { Authorization: authHeader } } },
  );

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return err("Unauthorized", 401);

  // Service-role client for inserts that need to bypass RLS in joins
  const sbAdmin = createClient(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
  );

  // ── Parse request ──
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return err("Invalid JSON body");
  }

  const feature = body.feature as string;
  const action = body.action as string;

  if (!feature || !action) {
    return err("Missing feature or action");
  }

  try {
    switch (feature) {
      case "competitive":
        return await handleCompetitive(supabase, sbAdmin, user.id, action, body);
      case "campaign":
        return await handleCampaign(supabase, sbAdmin, user.id, action, body);
      case "leads":
        return await handleLeads(supabase, sbAdmin, user.id, action, body);
      case "brand":
        return await handleBrand(supabase, sbAdmin, user.id, action, body);
      case "notifications":
        return await handleNotifications(user.id, action, body);
      default:
        return err(`Unknown feature: ${feature}`);
    }
  } catch (e) {
    console.error(`Error in ${feature}/${action}:`, e);
    return err(`Internal error: ${(e as Error).message}`, 500);
  }
});

// ════════════════════════════════════════
// COMPETITIVE INTELLIGENCE
// ════════════════════════════════════════

async function handleCompetitive(
  sb: SupabaseClient,
  sbAdmin: SupabaseClient,
  userId: string,
  action: string,
  body: Record<string, unknown>,
): Promise<Response> {
  switch (action) {
    case "list_monitors": {
      const { data } = await sb
        .from("competitor_monitors")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: true });
      return json({ monitors: data || [] });
    }

    case "add_monitor": {
      const companyName = body.company_name as string;
      const ticker = body.ticker as string | undefined;
      if (!companyName) return err("company_name required");

      const { data, error } = await sb
        .from("competitor_monitors")
        .insert({
          user_id: userId,
          company_name: companyName,
          ticker: ticker || null,
          monitor_config: body.monitor_config || {
            track_sec: true, track_patents: true, track_news: true, track_hiring: true,
          },
        })
        .select("*")
        .single();

      if (error) {
        if (error.code === "23505") return err("Already monitoring this company");
        return err(error.message);
      }
      return json({ monitor: data });
    }

    case "remove_monitor": {
      const monitorId = body.monitor_id as string;
      if (!monitorId) return err("monitor_id required");
      await sb.from("competitor_monitors").delete().eq("id", monitorId).eq("user_id", userId);
      return json({ success: true });
    }

    case "get_dashboard": {
      // Get all monitors with their latest snapshots
      const { data: monitors } = await sb
        .from("competitor_monitors")
        .select("*")
        .eq("user_id", userId)
        .eq("is_active", true);

      if (!monitors || monitors.length === 0) {
        return json({ monitors: [], snapshots: {}, digest: null });
      }

      const monitorIds = monitors.map((m: Record<string, unknown>) => m.id);
      const { data: snapshots } = await sbAdmin
        .from("competitor_snapshots")
        .select("*")
        .in("monitor_id", monitorIds)
        .order("snapshot_date", { ascending: false })
        .limit(monitors.length * 7); // Last 7 days per monitor

      // Group snapshots by monitor_id
      const grouped: Record<string, unknown[]> = {};
      for (const s of (snapshots || []) as Array<Record<string, unknown>>) {
        const mid = s.monitor_id as string;
        if (!grouped[mid]) grouped[mid] = [];
        grouped[mid].push(s);
      }

      // Get latest digest
      const { data: digest } = await sb
        .from("competitive_digests")
        .select("*")
        .eq("user_id", userId)
        .order("data_date", { ascending: false })
        .limit(1)
        .maybeSingle();

      return json({ monitors, snapshots: grouped, digest });
    }

    case "get_snapshots": {
      const monitorId = body.monitor_id as string;
      const days = (body.days as number) || 30;
      if (!monitorId) return err("monitor_id required");

      const since = new Date();
      since.setDate(since.getDate() - days);

      const { data } = await sbAdmin
        .from("competitor_snapshots")
        .select("*")
        .eq("monitor_id", monitorId)
        .gte("snapshot_date", since.toISOString().split("T")[0])
        .order("snapshot_date", { ascending: true });

      return json({ snapshots: data || [] });
    }

    case "get_digests": {
      const limit = (body.limit as number) || 10;
      const { data } = await sb
        .from("competitive_digests")
        .select("*")
        .eq("user_id", userId)
        .order("data_date", { ascending: false })
        .limit(limit);
      return json({ digests: data || [] });
    }

    default:
      return err(`Unknown competitive action: ${action}`);
  }
}

// ════════════════════════════════════════
// CAMPAIGN STRATEGIST
// ════════════════════════════════════════

async function handleCampaign(
  sb: SupabaseClient,
  _sbAdmin: SupabaseClient,
  userId: string,
  action: string,
  body: Record<string, unknown>,
): Promise<Response> {
  switch (action) {
    case "list": {
      const { data } = await sb
        .from("campaigns")
        .select("id, name, status, inputs, created_at, updated_at")
        .eq("user_id", userId)
        .order("updated_at", { ascending: false });
      return json({ campaigns: data || [] });
    }

    case "create": {
      const name = body.name as string;
      const inputs = body.inputs as Record<string, unknown>;
      if (!name) return err("name required");

      const { data, error } = await sb
        .from("campaigns")
        .insert({ user_id: userId, name, inputs: inputs || {} })
        .select("*")
        .single();

      if (error) return err(error.message);
      return json({ campaign: data });
    }

    case "get": {
      const id = body.campaign_id as string;
      if (!id) return err("campaign_id required");

      const { data } = await sb.from("campaigns").select("*").eq("id", id).eq("user_id", userId).single();
      if (!data) return err("Campaign not found", 404);
      return json({ campaign: data });
    }

    case "generate_plan": {
      const id = body.campaign_id as string;
      if (!id) return err("campaign_id required");

      const { data: campaign } = await sb.from("campaigns").select("*").eq("id", id).eq("user_id", userId).single();
      if (!campaign) return err("Campaign not found", 404);

      // Update status
      await sb.from("campaigns").update({ status: "planning" }).eq("id", id);

      const inputs = campaign.inputs as Record<string, unknown>;

      // Gather market intelligence for the plan
      const ctx = { user_id: userId, task_id: `campaign_${id}` };
      const [trendsRes, sentimentRes, economicRes] = await Promise.allSettled([
        inputs.industry
          ? executeTool("google_trends", { keywords: [inputs.product, inputs.industry].filter(Boolean).join(",") }, ctx)
          : Promise.resolve({ success: false, data: null } as { success: boolean; data: null }),
        inputs.product
          ? executeTool("news_sentiment", { query: inputs.product as string, mode: "artlist", max_records: 5 }, ctx)
          : Promise.resolve({ success: false, data: null } as { success: boolean; data: null }),
        executeTool("fred_economic_data", { series_id: "UMCSENT" }, ctx),
      ]);

      const marketContext = {
        trends: trendsRes.status === "fulfilled" ? trendsRes.value.data : null,
        sentiment: sentimentRes.status === "fulfilled" ? sentimentRes.value.data : null,
        consumer_sentiment: economicRes.status === "fulfilled" ? economicRes.value.data : null,
      };

      // Generate GTM plan using Claude
      const prompt = `You are a senior marketing strategist. Generate a comprehensive go-to-market campaign plan.

## Campaign Inputs
- Product/Service: ${inputs.product || "Not specified"}
- Target Audience: ${inputs.audience || "Not specified"}
- Budget: ${inputs.budget || "Not specified"}
- Goals: ${inputs.goals || "Not specified"}
- Timeline: ${inputs.timeline || "Not specified"}
- Industry: ${inputs.industry || "Not specified"}

## Current Market Context
${JSON.stringify(marketContext, null, 2)}

Generate a structured JSON plan with these sections:
{
  "executive_summary": "2-3 sentence overview",
  "channel_mix": [{"channel": "name", "budget_pct": 25, "rationale": "why", "expected_roi": "X:1"}],
  "messaging": {
    "core_positioning": "one line",
    "key_messages": ["msg1", "msg2", "msg3"],
    "behavioral_hooks": ["psychological principle and application"],
    "tone": "description"
  },
  "budget_allocation": {"channel_name": {"amount": "$X", "pct": 25}},
  "timeline": [{"phase": "name", "duration": "X weeks", "activities": ["activity"], "milestones": ["milestone"]}],
  "kpis": [{"metric": "name", "target": "value", "measurement": "how"}],
  "regulatory_flags": ["potential compliance issues"],
  "competitive_positioning": "how to differentiate"
}

Return ONLY valid JSON, no markdown fences.`;

      const resp = await callLLM({
        system: "You are a CMO-level marketing strategist. Output structured JSON only.",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 3000,
        temperature: 0.4,
      });

      let plan: Record<string, unknown> = {};
      const text = extractText(resp.content);
      try {
        // Strip markdown fences if present
        const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
        plan = JSON.parse(cleaned);
      } catch {
        plan = { raw_plan: text, parse_error: true };
      }

      await sb.from("campaigns").update({
        plan,
        status: "active",
        updated_at: new Date().toISOString(),
      }).eq("id", id);

      return json({ campaign_id: id, plan });
    }

    case "update": {
      const id = body.campaign_id as string;
      if (!id) return err("campaign_id required");

      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (body.name) updates.name = body.name;
      if (body.status) updates.status = body.status;
      if (body.inputs) updates.inputs = body.inputs;
      if (body.performance_data) updates.performance_data = body.performance_data;

      const { data, error } = await sb
        .from("campaigns")
        .update(updates)
        .eq("id", id)
        .eq("user_id", userId)
        .select("*")
        .single();

      if (error) return err(error.message);
      return json({ campaign: data });
    }

    case "delete": {
      const id = body.campaign_id as string;
      if (!id) return err("campaign_id required");
      await sb.from("campaigns").delete().eq("id", id).eq("user_id", userId);
      return json({ success: true });
    }

    default:
      return err(`Unknown campaign action: ${action}`);
  }
}

// ════════════════════════════════════════
// LEAD INTELLIGENCE
// ════════════════════════════════════════

async function handleLeads(
  sb: SupabaseClient,
  sbAdmin: SupabaseClient,
  userId: string,
  action: string,
  body: Record<string, unknown>,
): Promise<Response> {
  switch (action) {
    case "list_lists": {
      const { data } = await sb
        .from("lead_lists")
        .select("*")
        .eq("user_id", userId)
        .order("updated_at", { ascending: false });
      return json({ lists: data || [] });
    }

    case "create_list": {
      const name = body.name as string;
      const leads = body.leads as Array<Record<string, unknown>>;
      if (!name) return err("name required");
      if (!leads || !Array.isArray(leads) || leads.length === 0) return err("leads array required");

      // Create the list
      const { data: list, error: listErr } = await sb
        .from("lead_lists")
        .insert({
          user_id: userId,
          name,
          source: "upload",
          total_leads: leads.length,
        })
        .select("*")
        .single();

      if (listErr || !list) return err(listErr?.message || "Failed to create list");

      // Insert leads
      const leadRows = leads.map((l) => ({
        list_id: list.id,
        company_name: l.company_name || l.company || l.name || "Unknown",
        ticker: l.ticker || l.symbol || null,
        contact_name: l.contact_name || l.contact || null,
        contact_title: l.contact_title || l.title || null,
        contact_email: l.contact_email || l.email || null,
        website: l.website || l.url || null,
        raw_data: l,
      }));

      await sbAdmin.from("leads").insert(leadRows);

      return json({ list });
    }

    case "get_list": {
      const listId = body.list_id as string;
      if (!listId) return err("list_id required");

      const { data: list } = await sb
        .from("lead_lists")
        .select("*")
        .eq("id", listId)
        .eq("user_id", userId)
        .single();

      if (!list) return err("List not found", 404);

      const { data: leads } = await sbAdmin
        .from("leads")
        .select("*")
        .eq("list_id", listId)
        .order("score", { ascending: false, nullsFirst: false });

      return json({ list, leads: leads || [] });
    }

    case "enrich": {
      const listId = body.list_id as string;
      if (!listId) return err("list_id required");

      // Verify ownership
      const { data: list } = await sb
        .from("lead_lists")
        .select("*")
        .eq("id", listId)
        .eq("user_id", userId)
        .single();
      if (!list) return err("List not found", 404);

      // Update list status
      await sb.from("lead_lists").update({ status: "enriching", updated_at: new Date().toISOString() }).eq("id", listId);

      // Get pending leads
      const { data: leads } = await sbAdmin
        .from("leads")
        .select("*")
        .eq("list_id", listId)
        .eq("status", "pending")
        .limit(25); // Process in batches of 25 to avoid timeouts

      if (!leads || leads.length === 0) {
        await sb.from("lead_lists").update({ status: "ready", updated_at: new Date().toISOString() }).eq("id", listId);
        return json({ message: "No pending leads to enrich", enriched: 0 });
      }

      let enrichedCount = 0;
      for (const lead of leads) {
        try {
          await sbAdmin.from("leads").update({ status: "enriching" }).eq("id", lead.id);

          const enrichment = await enrichCompany(lead.company_name, lead.ticker);
          const scored = await scoreAndSummarize(lead.company_name, enrichment);

          await sbAdmin.from("leads").update({
            enrichment: scored.enrichment,
            score: scored.score,
            score_breakdown: scored.breakdown,
            ai_summary: scored.ai_summary,
            status: "enriched",
            enriched_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }).eq("id", lead.id);

          enrichedCount++;
        } catch (e) {
          console.error(`Failed to enrich lead ${lead.id}:`, e);
          await sbAdmin.from("leads").update({ status: "error" }).eq("id", lead.id);
        }
      }

      // Update list counts
      const { count } = await sbAdmin
        .from("leads")
        .select("*", { count: "exact", head: true })
        .eq("list_id", listId)
        .eq("status", "enriched");

      const totalEnriched = count || 0;
      const { count: totalCount } = await sbAdmin
        .from("leads")
        .select("*", { count: "exact", head: true })
        .eq("list_id", listId);

      const allDone = totalEnriched === (totalCount || 0);

      await sb.from("lead_lists").update({
        enriched_count: totalEnriched,
        status: allDone ? "ready" : "enriching",
        updated_at: new Date().toISOString(),
      }).eq("id", listId);

      return json({ enriched: enrichedCount, total_enriched: totalEnriched, all_done: allDone });
    }

    case "get_dashboard": {
      const { data: lists } = await sb
        .from("lead_lists")
        .select("*")
        .eq("user_id", userId)
        .order("updated_at", { ascending: false });

      // Get top scored leads across all lists
      const listIds = (lists || []).map((l: Record<string, unknown>) => l.id);
      let topLeads: unknown[] = [];
      if (listIds.length > 0) {
        const { data } = await sbAdmin
          .from("leads")
          .select("*")
          .in("list_id", listIds)
          .eq("status", "enriched")
          .order("score", { ascending: false })
          .limit(20);
        topLeads = data || [];
      }

      return json({ lists: lists || [], top_leads: topLeads });
    }

    case "delete_list": {
      const listId = body.list_id as string;
      if (!listId) return err("list_id required");
      await sb.from("lead_lists").delete().eq("id", listId).eq("user_id", userId);
      return json({ success: true });
    }

    default:
      return err(`Unknown leads action: ${action}`);
  }
}

// ════════════════════════════════════════
// BRAND HEALTH MONITOR
// ════════════════════════════════════════

async function handleBrand(
  sb: SupabaseClient,
  sbAdmin: SupabaseClient,
  userId: string,
  action: string,
  body: Record<string, unknown>,
): Promise<Response> {
  switch (action) {
    case "list_monitors": {
      const { data } = await sb
        .from("brand_monitors")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: true });
      return json({ monitors: data || [] });
    }

    case "add_monitor": {
      const brandName = body.brand_name as string;
      if (!brandName) return err("brand_name required");

      const { data, error } = await sb
        .from("brand_monitors")
        .insert({
          user_id: userId,
          brand_name: brandName,
          keywords: (body.keywords as string[]) || [],
          competitors: (body.competitors as string[]) || [],
          alert_config: body.alert_config || {
            sentiment_drop_threshold: -0.2,
            volume_spike_multiplier: 2.0,
            notify_on_competitor_mention: true,
          },
        })
        .select("*")
        .single();

      if (error) {
        if (error.code === "23505") return err("Already monitoring this brand");
        return err(error.message);
      }
      return json({ monitor: data });
    }

    case "remove_monitor": {
      const monitorId = body.monitor_id as string;
      if (!monitorId) return err("monitor_id required");
      await sb.from("brand_monitors").delete().eq("id", monitorId).eq("user_id", userId);
      return json({ success: true });
    }

    case "update_monitor": {
      const monitorId = body.monitor_id as string;
      if (!monitorId) return err("monitor_id required");

      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (body.keywords) updates.keywords = body.keywords;
      if (body.competitors) updates.competitors = body.competitors;
      if (body.alert_config) updates.alert_config = body.alert_config;
      if (body.is_active !== undefined) updates.is_active = body.is_active;

      const { data } = await sb
        .from("brand_monitors")
        .update(updates)
        .eq("id", monitorId)
        .eq("user_id", userId)
        .select("*")
        .single();

      return json({ monitor: data });
    }

    case "get_dashboard": {
      const { data: monitors } = await sb
        .from("brand_monitors")
        .select("*")
        .eq("user_id", userId)
        .eq("is_active", true);

      if (!monitors || monitors.length === 0) {
        return json({ monitors: [], snapshots: {}, alerts: [] });
      }

      const monitorIds = monitors.map((m: Record<string, unknown>) => m.id);
      const { data: snapshots } = await sbAdmin
        .from("brand_snapshots")
        .select("*")
        .in("monitor_id", monitorIds)
        .order("snapshot_date", { ascending: false })
        .limit(monitors.length * 30); // Last 30 days per monitor

      const grouped: Record<string, unknown[]> = {};
      for (const s of (snapshots || []) as Array<Record<string, unknown>>) {
        const mid = s.monitor_id as string;
        if (!grouped[mid]) grouped[mid] = [];
        grouped[mid].push(s);
      }

      // Recent alerts for brand health
      const { data: alerts } = await sb
        .from("alerts")
        .select("*")
        .eq("user_id", userId)
        .eq("feature", "brand_health")
        .order("created_at", { ascending: false })
        .limit(20);

      return json({ monitors, snapshots: grouped, alerts: alerts || [] });
    }

    case "get_snapshots": {
      const monitorId = body.monitor_id as string;
      const days = (body.days as number) || 30;
      if (!monitorId) return err("monitor_id required");

      const since = new Date();
      since.setDate(since.getDate() - days);

      const { data } = await sbAdmin
        .from("brand_snapshots")
        .select("*")
        .eq("monitor_id", monitorId)
        .gte("snapshot_date", since.toISOString().split("T")[0])
        .order("snapshot_date", { ascending: true });

      return json({ snapshots: data || [] });
    }

    default:
      return err(`Unknown brand action: ${action}`);
  }
}

// ════════════════════════════════════════
// NOTIFICATIONS
// ════════════════════════════════════════

async function handleNotifications(
  userId: string,
  action: string,
  body: Record<string, unknown>,
): Promise<Response> {
  switch (action) {
    case "list_channels": {
      const channels = await getUserChannels(userId);
      return json({ channels });
    }

    case "add_channel": {
      const channelType = body.channel_type as string;
      const channelName = body.channel_name as string;
      const config = body.config as Record<string, unknown>;
      if (!channelType || !config) return err("channel_type and config required");

      const ch = await addChannel(userId, channelType, channelName || "Default", config);
      if (!ch) return err("Failed to add channel");
      return json({ channel: ch });
    }

    case "remove_channel": {
      const channelId = body.channel_id as string;
      if (!channelId) return err("channel_id required");
      const ok = await removeChannel(channelId, userId);
      return json({ success: ok });
    }

    case "test_channel": {
      const channelId = body.channel_id as string;
      if (!channelId) return err("channel_id required");
      const ok = await testChannel(channelId, userId);
      return json({ success: ok });
    }

    case "list_alerts": {
      const alerts = await getUserAlerts(userId, {
        feature: body.feature as string | undefined,
        unread_only: body.unread_only as boolean | undefined,
        limit: body.limit as number | undefined,
      });
      return json({ alerts });
    }

    case "mark_read": {
      const alertIds = body.alert_ids as string[];
      if (!alertIds || alertIds.length === 0) return err("alert_ids required");
      await markAlertsRead(alertIds, userId);
      return json({ success: true });
    }

    default:
      return err(`Unknown notifications action: ${action}`);
  }
}
