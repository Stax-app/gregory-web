/* ============================================================
   GREGORY — Brand Health Monitor Dashboard
   Real-time brand reputation tracking with alerts
   ============================================================ */

async function renderBrandDashboard() {
  if (!requireAuth()) return;

  const header = document.getElementById('dashboardHeader');
  const content = document.getElementById('dashboardContent');

  header.innerHTML = `
    <h2><span class="dash-icon">\u{1F4C8}</span> Brand Health Monitor</h2>
    <div class="dashboard-header-actions">
      <button class="dash-btn dash-btn-primary" id="addBrandBtn">+ Add Brand</button>
    </div>`;

  content.innerHTML = '<div class="dash-loading">Loading brand health data</div>';

  try {
    const data = await dashboardAPI('brand', 'get_dashboard');
    renderBrandContent(data);
  } catch (e) {
    content.innerHTML = `<div class="dash-empty"><div class="dash-empty-icon">\u{1F4C8}</div><h3>Brand Health Monitor</h3><p>Start tracking your brand's reputation.</p><button class="dash-btn dash-btn-primary" onclick="showAddBrandModal()">+ Add Your Brand</button></div>`;
  }

  document.getElementById('addBrandBtn')?.addEventListener('click', showAddBrandModal);
}

function renderBrandContent(data) {
  const content = document.getElementById('dashboardContent');
  const { monitors, snapshots, alerts } = data;

  if (!monitors || monitors.length === 0) {
    content.innerHTML = `
      <div class="dash-empty">
        <div class="dash-empty-icon">\u{1F4C8}</div>
        <h3>No Brands Monitored</h3>
        <p>Add brands to track sentiment, news volume, and competitor comparison.</p>
        <button class="dash-btn dash-btn-primary" onclick="showAddBrandModal()">+ Add Brand</button>
      </div>`;
    return;
  }

  let html = '';

  // Brand cards with sentiment overview
  for (const monitor of monitors) {
    const monitorSnapshots = (snapshots[monitor.id] || []).slice(0, 30);
    const latest = monitorSnapshots[0];

    const sentiment = latest?.sentiment_score;
    const volume = latest?.sentiment_volume || 0;

    // Determine sentiment status
    let sentimentStatus = 'Neutral';
    let sentimentColor = 'var(--warning)';
    if (sentiment > 0.2) { sentimentStatus = 'Positive'; sentimentColor = 'var(--success)'; }
    else if (sentiment < -0.2) { sentimentStatus = 'Negative'; sentimentColor = 'var(--error)'; }

    html += `
      <div class="dash-card" style="margin-bottom:20px">
        <div class="dash-card-header">
          <div>
            <div class="dash-card-title" style="font-size:1.1rem">${monitor.brand_name}</div>
            <div class="dash-card-subtitle">
              ${monitor.keywords?.length ? 'Keywords: ' + monitor.keywords.join(', ') + ' &middot; ' : ''}
              ${monitor.competitors?.length ? 'vs. ' + monitor.competitors.join(', ') : ''}
            </div>
          </div>
          <div style="display:flex;gap:6px">
            <button class="dash-btn dash-btn-sm" onclick="editBrandMonitor('${monitor.id}')">Edit</button>
            <button class="dash-btn dash-btn-sm dash-btn-danger" onclick="removeBrandMonitor('${monitor.id}')">Remove</button>
          </div>
        </div>

        <div class="dash-metrics-row">
          <div class="dash-metric">
            <div class="dash-metric-value" style="color:${sentimentColor}">${sentiment !== null && sentiment !== undefined ? (sentiment >= 0 ? '+' : '') + sentiment.toFixed(2) : 'N/A'}</div>
            <div class="dash-metric-label">Sentiment</div>
            <div class="dash-metric-change" style="color:${sentimentColor}">${sentimentStatus}</div>
          </div>
          <div class="dash-metric">
            <div class="dash-metric-value">${volume}</div>
            <div class="dash-metric-label">News Volume</div>
          </div>
          <div class="dash-metric">
            <div class="dash-metric-value">${monitor.competitors?.length || 0}</div>
            <div class="dash-metric-label">Competitors</div>
          </div>
        </div>

        <!-- Sentiment chart -->
        <div id="brandChart_${monitor.id}" style="margin-top:12px"></div>

        ${latest?.ai_summary ? `<p style="font-size:0.85rem;color:var(--text-secondary);margin:12px 0 0 0">${latest.ai_summary}</p>` : ''}

        <!-- Competitor comparison -->
        ${renderCompetitorComparison(latest?.competitor_comparison)}

        <!-- Recent articles -->
        ${renderNewsArticles(latest?.news_articles)}
      </div>`;
  }

  // Recent alerts
  if (alerts && alerts.length > 0) {
    html += `
      <div class="dash-card">
        <div class="dash-card-header">
          <div class="dash-card-title">Recent Alerts</div>
        </div>
        ${alerts.map(a => `
          <div class="dash-alert-item ${a.is_read ? '' : 'unread'}">
            <div class="dash-alert-severity">${severityEmoji(a.severity)}</div>
            <div class="dash-alert-body">
              <div class="dash-alert-title">${a.title}</div>
              <div class="dash-alert-text">${a.body}</div>
              <div class="dash-alert-time">${timeAgo(a.created_at)}</div>
            </div>
          </div>`).join('')}
      </div>`;
  }

  content.innerHTML = html;

  // Render charts after DOM is ready
  for (const monitor of monitors) {
    const monitorSnapshots = (snapshots[monitor.id] || []).slice(0, 30).reverse();
    if (monitorSnapshots.length > 1) {
      renderLineChart(`brandChart_${monitor.id}`, monitorSnapshots.map(s => ({
        label: (s.snapshot_date || '').slice(5),
        value: s.sentiment_score || 0,
      })), {
        minVal: -1, maxVal: 1,
        formatValue: v => v.toFixed(1),
        color: 'var(--accent)',
      });
    }
  }
}

function renderCompetitorComparison(comparison) {
  if (!comparison || Object.keys(comparison).length === 0) return '';

  let rows = '';
  for (const [comp, data] of Object.entries(comparison)) {
    const d = data || {};
    const articles = d.articles || d.results || [];
    const tone = d.tone;
    rows += `<tr>
      <td>${comp}</td>
      <td>${tone !== undefined ? (tone >= 0 ? '+' : '') + tone.toFixed(2) : 'N/A'}</td>
      <td>${articles.length} articles</td>
    </tr>`;
  }

  return `
    <div style="margin-top:16px">
      <div style="font-weight:600;font-size:0.85rem;color:var(--text-primary);margin-bottom:8px">Competitor Comparison</div>
      <table class="dash-table">
        <thead><tr><th>Competitor</th><th>Sentiment</th><th>Coverage</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderNewsArticles(articles) {
  if (!articles || articles.length === 0) return '';

  return `
    <div style="margin-top:16px">
      <div style="font-weight:600;font-size:0.85rem;color:var(--text-primary);margin-bottom:8px">Recent News</div>
      ${articles.slice(0, 5).map(a => `
        <div style="padding:6px 0;border-bottom:1px solid var(--border);font-size:0.83rem">
          ${a.url ? `<a href="${a.url}" target="_blank" class="source-link" style="color:var(--accent-light)">${a.title || 'Article'}</a>` : (a.title || 'Article')}
          ${a.source ? `<span style="color:var(--text-muted);margin-left:6px">${a.source}</span>` : ''}
        </div>`).join('')}
    </div>`;
}

function showAddBrandModal() {
  showDashModal('Add Brand Monitor', `
    <div class="dash-form-group">
      <label class="dash-form-label">Brand Name</label>
      <input type="text" class="dash-form-input" id="newBrandName" placeholder="e.g. Stax">
    </div>
    <div class="dash-form-group">
      <label class="dash-form-label">Additional Keywords (comma-separated)</label>
      <input type="text" class="dash-form-input" id="newBrandKeywords" placeholder="e.g. stax finance, stax app">
    </div>
    <div class="dash-form-group">
      <label class="dash-form-label">Competitors to Compare (comma-separated)</label>
      <input type="text" class="dash-form-input" id="newBrandCompetitors" placeholder="e.g. Robinhood, Wealthfront">
    </div>
  `, [{
    label: 'Start Monitoring',
    primary: true,
    handler: async () => {
      const name = document.getElementById('newBrandName')?.value?.trim();
      if (!name) return;
      const keywords = (document.getElementById('newBrandKeywords')?.value || '').split(',').map(s => s.trim()).filter(Boolean);
      const competitors = (document.getElementById('newBrandCompetitors')?.value || '').split(',').map(s => s.trim()).filter(Boolean);
      try {
        await dashboardAPI('brand', 'add_monitor', { brand_name: name, keywords, competitors });
        renderBrandDashboard();
      } catch (e) {
        alert(e.message);
      }
    }
  }]);
}

async function removeBrandMonitor(monitorId) {
  if (!confirm('Remove this brand monitor?')) return;
  try {
    await dashboardAPI('brand', 'remove_monitor', { monitor_id: monitorId });
    renderBrandDashboard();
  } catch (e) {
    alert(e.message);
  }
}

async function editBrandMonitor(monitorId) {
  // Re-fetch current monitor data
  const data = await dashboardAPI('brand', 'list_monitors');
  const monitor = (data.monitors || []).find(m => m.id === monitorId);
  if (!monitor) return;

  showDashModal('Edit Brand Monitor', `
    <div class="dash-form-group">
      <label class="dash-form-label">Brand Name</label>
      <input type="text" class="dash-form-input" id="editBrandName" value="${monitor.brand_name}" disabled>
    </div>
    <div class="dash-form-group">
      <label class="dash-form-label">Additional Keywords (comma-separated)</label>
      <input type="text" class="dash-form-input" id="editBrandKeywords" value="${(monitor.keywords || []).join(', ')}">
    </div>
    <div class="dash-form-group">
      <label class="dash-form-label">Competitors (comma-separated)</label>
      <input type="text" class="dash-form-input" id="editBrandCompetitors" value="${(monitor.competitors || []).join(', ')}">
    </div>
  `, [{
    label: 'Save',
    primary: true,
    handler: async () => {
      const keywords = (document.getElementById('editBrandKeywords')?.value || '').split(',').map(s => s.trim()).filter(Boolean);
      const competitors = (document.getElementById('editBrandCompetitors')?.value || '').split(',').map(s => s.trim()).filter(Boolean);
      try {
        await dashboardAPI('brand', 'update_monitor', { monitor_id: monitorId, keywords, competitors });
        renderBrandDashboard();
      } catch (e) {
        alert(e.message);
      }
    }
  }]);
}
