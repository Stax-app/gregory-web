/* ============================================================
   GREGORY — Competitive Intelligence Dashboard
   Monitor competitors: SEC filings, patents, news, hiring
   ============================================================ */

async function renderCompetitiveDashboard() {
  if (!requireAuth()) return;

  const header = document.getElementById('dashboardHeader');
  const content = document.getElementById('dashboardContent');

  header.innerHTML = `
    <h2><span class="dash-icon">\u{1F50D}</span> Competitive Intelligence</h2>
    <div class="dashboard-header-actions">
      <button class="dash-btn dash-btn-primary" id="addCompetitorBtn">+ Add Competitor</button>
    </div>`;

  content.innerHTML = '<div class="dash-loading">Loading competitive intelligence</div>';

  try {
    const data = await dashboardAPI('competitive', 'get_dashboard');
    renderCompetitiveContent(data);
  } catch (e) {
    content.innerHTML = `<div class="dash-empty"><div class="dash-empty-icon">\u{1F50D}</div><h3>Competitive Intelligence</h3><p>Start by adding competitors to monitor.</p><button class="dash-btn dash-btn-primary" onclick="showAddCompetitorModal()">+ Add Your First Competitor</button></div>`;
  }

  document.getElementById('addCompetitorBtn')?.addEventListener('click', showAddCompetitorModal);
}

function renderCompetitiveContent(data) {
  const content = document.getElementById('dashboardContent');
  const { monitors, snapshots, digest } = data;

  if (!monitors || monitors.length === 0) {
    content.innerHTML = `
      <div class="dash-empty">
        <div class="dash-empty-icon">\u{1F50D}</div>
        <h3>No Competitors Monitored</h3>
        <p>Add competitors to start tracking their SEC filings, patents, news, and hiring.</p>
        <button class="dash-btn dash-btn-primary" onclick="showAddCompetitorModal()">+ Add Competitor</button>
      </div>`;
    return;
  }

  let html = '';

  // Latest digest
  if (digest) {
    html += `
      <div class="dash-card" style="margin-bottom:20px">
        <div class="dash-card-header">
          <div>
            <div class="dash-card-title">Latest Intelligence Digest</div>
            <div class="dash-card-subtitle">${digest.data_date} &middot; ${(digest.companies_covered || []).join(', ')}</div>
          </div>
          <span class="dash-card-badge dash-badge-info">Daily</span>
        </div>
        <div class="dash-digest">${renderSimpleMarkdown(digest.content)}</div>
      </div>`;
  }

  // Competitor cards
  html += '<div class="dash-grid">';
  for (const monitor of monitors) {
    const monitorSnapshots = snapshots[monitor.id] || [];
    const latest = monitorSnapshots[0];

    const sentimentScore = latest?.news_sentiment?.tone;
    const sentimentDisplay = sentimentScore !== undefined
      ? `<span style="color:${sentimentScore >= 0 ? 'var(--success)' : 'var(--error)'}">${sentimentScore >= 0 ? '+' : ''}${sentimentScore.toFixed(2)}</span>`
      : '<span style="color:var(--text-muted)">N/A</span>';

    const filingCount = (latest?.sec_filings?.filings || latest?.sec_filings?.results || []).length;
    const patentCount = (latest?.patents?.patents || latest?.patents?.results || []).length;
    const hiringCount = (latest?.hiring_signals?.jobs || latest?.hiring_signals?.results || []).length;

    html += `
      <div class="dash-card">
        <div class="dash-card-header">
          <div>
            <div class="dash-card-title">${monitor.company_name}</div>
            <div class="dash-card-subtitle">${monitor.ticker ? monitor.ticker + ' &middot; ' : ''}Last checked: ${monitor.last_checked_at ? timeAgo(monitor.last_checked_at) : 'Never'}</div>
          </div>
          <button class="dash-btn dash-btn-sm dash-btn-danger" onclick="removeCompetitor('${monitor.id}')">Remove</button>
        </div>

        <div class="dash-metrics-row">
          <div class="dash-metric">
            <div class="dash-metric-value">${sentimentDisplay}</div>
            <div class="dash-metric-label">Sentiment</div>
          </div>
          <div class="dash-metric">
            <div class="dash-metric-value">${filingCount}</div>
            <div class="dash-metric-label">SEC Filings</div>
          </div>
          <div class="dash-metric">
            <div class="dash-metric-value">${patentCount}</div>
            <div class="dash-metric-label">Patents</div>
          </div>
          <div class="dash-metric">
            <div class="dash-metric-value">${hiringCount}</div>
            <div class="dash-metric-label">Job Posts</div>
          </div>
        </div>

        ${latest?.ai_summary ? `<p style="font-size:0.85rem;color:var(--text-secondary);margin:12px 0 0 0">${latest.ai_summary}</p>` : ''}

        <div style="margin-top:12px">
          <button class="dash-btn dash-btn-sm" onclick="viewCompetitorHistory('${monitor.id}', '${monitor.company_name}')">View History</button>
        </div>
      </div>`;
  }
  html += '</div>';

  content.innerHTML = html;
}

function showAddCompetitorModal() {
  showDashModal('Add Competitor', `
    <div class="dash-form-group">
      <label class="dash-form-label">Company Name</label>
      <input type="text" class="dash-form-input" id="newCompName" placeholder="e.g. Tesla">
    </div>
    <div class="dash-form-group">
      <label class="dash-form-label">Ticker (optional)</label>
      <input type="text" class="dash-form-input" id="newCompTicker" placeholder="e.g. TSLA">
    </div>
  `, [{
    label: 'Add Monitor',
    primary: true,
    handler: async () => {
      const name = document.getElementById('newCompName')?.value?.trim();
      const ticker = document.getElementById('newCompTicker')?.value?.trim();
      if (!name) return;
      try {
        await dashboardAPI('competitive', 'add_monitor', { company_name: name, ticker: ticker || undefined });
        renderCompetitiveDashboard();
      } catch (e) {
        alert(e.message);
      }
    }
  }]);
}

async function removeCompetitor(monitorId) {
  if (!confirm('Remove this competitor monitor?')) return;
  try {
    await dashboardAPI('competitive', 'remove_monitor', { monitor_id: monitorId });
    renderCompetitiveDashboard();
  } catch (e) {
    alert(e.message);
  }
}

async function viewCompetitorHistory(monitorId, companyName) {
  const content = document.getElementById('dashboardContent');
  content.innerHTML = '<div class="dash-loading">Loading history</div>';

  try {
    const { snapshots } = await dashboardAPI('competitive', 'get_snapshots', { monitor_id: monitorId, days: 30 });

    let html = `
      <div style="margin-bottom:16px">
        <button class="dash-btn" onclick="renderCompetitiveDashboard()">&larr; Back</button>
        <span style="margin-left:12px;font-weight:600;color:var(--text-primary)">${companyName} — 30 Day History</span>
      </div>`;

    if (snapshots && snapshots.length > 0) {
      // Sentiment trend chart
      const chartData = snapshots
        .filter(s => s.news_sentiment?.tone !== undefined)
        .map(s => ({
          label: s.snapshot_date.slice(5),
          value: s.news_sentiment.tone,
        }));

      if (chartData.length > 1) {
        html += `<div class="dash-card" style="margin-bottom:16px"><div class="dash-card-title" style="margin-bottom:8px">Sentiment Trend</div><div id="compSentimentChart"></div></div>`;
      }

      // Timeline
      html += '<div class="dash-card"><div class="dash-card-title" style="margin-bottom:12px">Daily Summaries</div>';
      for (const snap of [...snapshots].reverse()) {
        html += `
          <div style="padding:10px 0;border-bottom:1px solid var(--border)">
            <div style="font-weight:600;font-size:0.85rem;color:var(--text-primary)">${snap.snapshot_date}</div>
            <div style="font-size:0.83rem;color:var(--text-secondary);margin-top:4px">${snap.ai_summary || 'No summary'}</div>
          </div>`;
      }
      html += '</div>';

      content.innerHTML = html;

      if (chartData.length > 1) {
        renderLineChart('compSentimentChart', chartData, {
          minVal: -1, maxVal: 1,
          formatValue: v => v.toFixed(1),
          color: 'var(--accent)',
        });
      }
    } else {
      content.innerHTML = html + '<div class="dash-empty"><p>No snapshots yet. Data is collected daily at 7AM ET.</p></div>';
    }
  } catch (e) {
    content.innerHTML = `<div class="dash-empty"><p>Error loading history: ${e.message}</p></div>`;
  }
}
