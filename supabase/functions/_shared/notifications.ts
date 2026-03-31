/**
 * GREGORY — Notifications Module
 *
 * Dispatches alerts to configured channels (Slack webhooks, email).
 * Used by gregory-monitor-engine and gregory-dashboards.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function getSupabase() {
  return createClient(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
  );
}

// ── Types ──

export interface AlertInput {
  user_id: string;
  feature: string;
  alert_type: string;
  severity: "info" | "warning" | "critical";
  title: string;
  body: string;
  metadata?: Record<string, unknown>;
}

export interface NotificationChannel {
  id: string;
  user_id: string;
  channel_type: "slack" | "email" | "webhook";
  channel_name: string;
  config: Record<string, unknown>;
  is_active: boolean;
}

// ── Alert Creation ──

/**
 * Create an alert record and dispatch to active channels for the user.
 */
export async function createAndDispatchAlert(alert: AlertInput): Promise<string | null> {
  const sb = getSupabase();

  // Insert alert
  const { data: row, error } = await sb
    .from("alerts")
    .insert({
      user_id: alert.user_id,
      feature: alert.feature,
      alert_type: alert.alert_type,
      severity: alert.severity,
      title: alert.title,
      body: alert.body,
      metadata: alert.metadata || {},
    })
    .select("id")
    .single();

  if (error || !row) {
    console.error("Failed to create alert:", error);
    return null;
  }

  // Fetch active channels for this user
  const { data: channels } = await sb
    .from("notification_channels")
    .select("*")
    .eq("user_id", alert.user_id)
    .eq("is_active", true);

  if (channels && channels.length > 0) {
    for (const ch of channels as NotificationChannel[]) {
      try {
        let delivered = false;
        if (ch.channel_type === "slack") {
          delivered = await sendSlackWebhook(
            ch.config.webhook_url as string,
            alert.title,
            alert.body,
            alert.severity,
            alert.feature,
          );
        } else if (ch.channel_type === "webhook") {
          delivered = await sendGenericWebhook(
            ch.config.webhook_url as string,
            alert,
          );
        }
        // Email deferred — requires SMTP/Resend setup

        if (delivered) {
          await sb
            .from("alerts")
            .update({ delivered_at: new Date().toISOString(), channel_id: ch.id })
            .eq("id", row.id);
        }
      } catch (e) {
        console.error(`Failed to dispatch to channel ${ch.id}:`, e);
      }
    }
  }

  return row.id;
}

/**
 * Create multiple alerts and dispatch them.
 */
export async function dispatchAlerts(alerts: AlertInput[]): Promise<void> {
  for (const alert of alerts) {
    await createAndDispatchAlert(alert);
  }
}

// ── Slack Webhook ──

const SEVERITY_EMOJI: Record<string, string> = {
  info: "ℹ️",
  warning: "⚠️",
  critical: "🚨",
};

const FEATURE_LABEL: Record<string, string> = {
  competitive_intel: "Competitive Intelligence",
  brand_health: "Brand Health",
  campaign: "Campaign Strategist",
  lead_intel: "Lead Intelligence",
};

async function sendSlackWebhook(
  webhookUrl: string,
  title: string,
  body: string,
  severity: string,
  feature: string,
): Promise<boolean> {
  if (!webhookUrl) return false;

  const emoji = SEVERITY_EMOJI[severity] || "ℹ️";
  const featureLabel = FEATURE_LABEL[feature] || feature;

  const payload = {
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `${emoji} ${title}`, emoji: true },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: body },
      },
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: `*Feature:* ${featureLabel} | *Severity:* ${severity}` },
        ],
      },
    ],
  };

  try {
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

// ── Generic Webhook ──

async function sendGenericWebhook(
  webhookUrl: string,
  alert: AlertInput,
): Promise<boolean> {
  if (!webhookUrl) return false;

  try {
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "gregory_alert",
        ...alert,
        timestamp: new Date().toISOString(),
      }),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

// ── Channel CRUD helpers ──

export async function getUserChannels(userId: string): Promise<NotificationChannel[]> {
  const sb = getSupabase();
  const { data } = await sb
    .from("notification_channels")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  return (data || []) as NotificationChannel[];
}

export async function addChannel(
  userId: string,
  channelType: string,
  channelName: string,
  config: Record<string, unknown>,
): Promise<NotificationChannel | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("notification_channels")
    .insert({ user_id: userId, channel_type: channelType, channel_name: channelName, config })
    .select("*")
    .single();
  if (error) { console.error("addChannel error:", error); return null; }
  return data as NotificationChannel;
}

export async function removeChannel(channelId: string, userId: string): Promise<boolean> {
  const sb = getSupabase();
  const { error } = await sb
    .from("notification_channels")
    .delete()
    .eq("id", channelId)
    .eq("user_id", userId);
  return !error;
}

export async function testChannel(channelId: string, userId: string): Promise<boolean> {
  const sb = getSupabase();
  const { data } = await sb
    .from("notification_channels")
    .select("*")
    .eq("id", channelId)
    .eq("user_id", userId)
    .single();

  if (!data) return false;
  const ch = data as NotificationChannel;

  if (ch.channel_type === "slack") {
    return sendSlackWebhook(
      ch.config.webhook_url as string,
      "GREGORY Test Notification",
      "If you see this, your Slack integration is working correctly.",
      "info",
      "system",
    );
  }
  if (ch.channel_type === "webhook") {
    return sendGenericWebhook(ch.config.webhook_url as string, {
      user_id: userId,
      feature: "system",
      alert_type: "test",
      severity: "info",
      title: "GREGORY Test",
      body: "Webhook integration test successful.",
    });
  }

  return false;
}

// ── Alert query helpers ──

export async function getUserAlerts(
  userId: string,
  opts: { feature?: string; unread_only?: boolean; limit?: number } = {},
): Promise<unknown[]> {
  const sb = getSupabase();
  let query = sb
    .from("alerts")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(opts.limit || 50);

  if (opts.feature) query = query.eq("feature", opts.feature);
  if (opts.unread_only) query = query.eq("is_read", false);

  const { data } = await query;
  return data || [];
}

export async function markAlertsRead(
  alertIds: string[],
  userId: string,
): Promise<void> {
  const sb = getSupabase();
  await sb
    .from("alerts")
    .update({ is_read: true })
    .in("id", alertIds)
    .eq("user_id", userId);
}
