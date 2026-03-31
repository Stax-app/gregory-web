/* ============================================================
   GREGORY — Notification Settings Dashboard
   Channel management, alert configuration, alert history
   ============================================================ */

async function renderNotificationsDashboard() {
  if (!requireAuth()) return;

  const header = document.getElementById('dashboardHeader');
  const content = document.getElementById('dashboardContent');

  header.innerHTML = `
    <h2><span class="dash-icon">\u{1F514}</span> Notifications</h2>
    <div class="dashboard-header-actions">
      <button class="dash-btn dash-btn-primary" id="addChannelBtn">+ Add Channel</button>
    </div>`;

  content.innerHTML = '<div class="dash-loading">Loading notifications</div>';

  try {
    const [channelsData, alertsData] = await Promise.all([
      dashboardAPI('notifications', 'list_channels'),
      dashboardAPI('notifications', 'list_alerts', { limit: 50 }),
    ]);
    renderNotificationsContent(channelsData, alertsData);
  } catch (e) {
    content.innerHTML = `<div class="dash-empty"><div class="dash-empty-icon">\u{1F514}</div><h3>Notifications</h3><p>Set up Slack or webhook channels to receive alerts.</p><button class="dash-btn dash-btn-primary" onclick="showAddChannelModal()">+ Add Channel</button></div>`;
  }

  document.getElementById('addChannelBtn')?.addEventListener('click', showAddChannelModal);
}

function renderNotificationsContent(channelsData, alertsData) {
  const content = document.getElementById('dashboardContent');
  const channels = channelsData.channels || [];
  const alerts = alertsData.alerts || [];

  let html = '';

  // Channels section
  html += `
    <div class="dash-card" style="margin-bottom:20px">
      <div class="dash-card-header">
        <div class="dash-card-title">Notification Channels</div>
      </div>`;

  if (channels.length === 0) {
    html += `<div class="dash-empty" style="padding:24px"><p>No channels configured. Add a Slack webhook to start receiving alerts.</p></div>`;
  } else {
    html += '<div style="display:flex;flex-direction:column;gap:8px">';
    for (const ch of channels) {
      const typeIcon = { slack: '\u{1F4AC}', email: '\u{1F4E7}', webhook: '\u{1F517}' }[ch.channel_type] || '\u{1F514}';
      const configDisplay = ch.channel_type === 'slack'
        ? maskUrl(ch.config?.webhook_url)
        : ch.channel_type === 'email'
        ? ch.config?.email_address || 'No email'
        : maskUrl(ch.config?.webhook_url);

      html += `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:12px;background:var(--bg-primary);border-radius:var(--radius-sm);border:1px solid var(--border)">
          <div style="display:flex;align-items:center;gap:12px">
            <span style="font-size:1.3rem">${typeIcon}</span>
            <div>
              <div style="font-weight:600;color:var(--text-primary)">${ch.channel_name}</div>
              <div style="font-size:0.78rem;color:var(--text-muted)">${ch.channel_type} &middot; ${configDisplay}</div>
            </div>
          </div>
          <div style="display:flex;gap:6px">
            <button class="dash-btn dash-btn-sm" onclick="testNotificationChannel('${ch.id}')">Test</button>
            <button class="dash-btn dash-btn-sm dash-btn-danger" onclick="removeNotificationChannel('${ch.id}')">Remove</button>
          </div>
        </div>`;
    }
    html += '</div>';
  }
  html += '</div>';

  // Alert history
  html += `
    <div class="dash-card">
      <div class="dash-card-header">
        <div class="dash-card-title">Alert History</div>
        <div style="display:flex;gap:6px">
          <button class="dash-btn dash-btn-sm" onclick="filterAlerts(null)">All</button>
          <button class="dash-btn dash-btn-sm" onclick="filterAlerts('competitive_intel')">Competitive</button>
          <button class="dash-btn dash-btn-sm" onclick="filterAlerts('brand_health')">Brand</button>
          <button class="dash-btn dash-btn-sm" onclick="filterAlerts('lead_intel')">Leads</button>
        </div>
      </div>
      <div id="alertsList">`;

  if (alerts.length === 0) {
    html += '<div class="dash-empty" style="padding:24px"><p>No alerts yet. Alerts are generated automatically when monitors detect changes.</p></div>';
  } else {
    const unreadIds = alerts.filter(a => !a.is_read).map(a => a.id);
    if (unreadIds.length > 0) {
      html += `<div style="padding:8px 12px;text-align:right"><button class="dash-btn dash-btn-sm" onclick="markAllRead()">Mark all as read (${unreadIds.length})</button></div>`;
    }

    for (const alert of alerts) {
      const featureLabel = {
        competitive_intel: 'Competitive',
        brand_health: 'Brand',
        campaign: 'Campaign',
        lead_intel: 'Leads',
        system: 'System',
      }[alert.feature] || alert.feature;

      html += `
        <div class="dash-alert-item ${alert.is_read ? '' : 'unread'}" data-feature="${alert.feature}">
          <div class="dash-alert-severity">${severityEmoji(alert.severity)}</div>
          <div class="dash-alert-body">
            <div class="dash-alert-title">${alert.title}</div>
            <div class="dash-alert-text">${alert.body}</div>
            <div class="dash-alert-time">
              <span class="dash-card-badge ${alert.severity === 'critical' ? 'dash-badge-critical' : alert.severity === 'warning' ? 'dash-badge-warning' : 'dash-badge-info'}" style="font-size:0.65rem">${featureLabel}</span>
              &middot; ${timeAgo(alert.created_at)}
              ${alert.delivered_at ? ' &middot; Delivered' : ''}
            </div>
          </div>
        </div>`;
    }
  }

  html += '</div></div>';

  content.innerHTML = html;
}

function maskUrl(url) {
  if (!url) return 'Not configured';
  try {
    const u = new URL(url);
    return u.hostname + '/...';
  } catch {
    return '***configured***';
  }
}

function showAddChannelModal() {
  showDashModal('Add Notification Channel', `
    <div class="dash-form-group">
      <label class="dash-form-label">Channel Type</label>
      <select class="dash-form-select" id="channelType" onchange="updateChannelForm()">
        <option value="slack">Slack Webhook</option>
        <option value="webhook">Generic Webhook</option>
      </select>
    </div>
    <div class="dash-form-group">
      <label class="dash-form-label">Channel Name</label>
      <input type="text" class="dash-form-input" id="channelName" placeholder="e.g. #marketing-alerts">
    </div>
    <div id="channelConfigFields">
      <div class="dash-form-group">
        <label class="dash-form-label">Webhook URL</label>
        <input type="text" class="dash-form-input" id="channelWebhookUrl" placeholder="https://hooks.slack.com/services/...">
        <div style="font-size:0.75rem;color:var(--text-muted);margin-top:4px">Get this from Slack > Apps > Incoming Webhooks</div>
      </div>
    </div>
  `, [{
    label: 'Add Channel',
    primary: true,
    handler: async () => {
      const channelType = document.getElementById('channelType')?.value;
      const channelName = document.getElementById('channelName')?.value?.trim() || 'Default';
      const webhookUrl = document.getElementById('channelWebhookUrl')?.value?.trim();

      if (!webhookUrl) { alert('Webhook URL is required'); return; }

      try {
        await dashboardAPI('notifications', 'add_channel', {
          channel_type: channelType,
          channel_name: channelName,
          config: { webhook_url: webhookUrl },
        });
        renderNotificationsDashboard();
      } catch (e) {
        alert(e.message);
      }
    }
  }]);
}

function updateChannelForm() {
  // Both slack and webhook use webhook_url, so no change needed
  // This is here in case we add email support later
}

async function testNotificationChannel(channelId) {
  try {
    const result = await dashboardAPI('notifications', 'test_channel', { channel_id: channelId });
    alert(result.success ? 'Test notification sent successfully!' : 'Failed to send test notification.');
  } catch (e) {
    alert('Test failed: ' + e.message);
  }
}

async function removeNotificationChannel(channelId) {
  if (!confirm('Remove this notification channel?')) return;
  try {
    await dashboardAPI('notifications', 'remove_channel', { channel_id: channelId });
    renderNotificationsDashboard();
  } catch (e) {
    alert(e.message);
  }
}

async function filterAlerts(feature) {
  const items = document.querySelectorAll('.dash-alert-item');
  items.forEach(item => {
    if (!feature || item.dataset.feature === feature) {
      item.style.display = '';
    } else {
      item.style.display = 'none';
    }
  });
}

async function markAllRead() {
  try {
    const { alerts } = await dashboardAPI('notifications', 'list_alerts', { unread_only: true });
    if (alerts && alerts.length > 0) {
      await dashboardAPI('notifications', 'mark_read', { alert_ids: alerts.map(a => a.id) });
      renderNotificationsDashboard();
    }
  } catch (e) {
    alert(e.message);
  }
}
