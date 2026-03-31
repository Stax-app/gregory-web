/* ============================================================
   GREGORY — Lead Intelligence Dashboard
   Upload, enrich, score, and prioritize accounts
   ============================================================ */

async function renderLeadsDashboard() {
  if (!requireAuth()) return;

  const header = document.getElementById('dashboardHeader');
  const content = document.getElementById('dashboardContent');

  header.innerHTML = `
    <h2><span class="dash-icon">\u{1F465}</span> Lead Intelligence</h2>
    <div class="dashboard-header-actions">
      <button class="dash-btn dash-btn-primary" id="uploadLeadsBtn">+ Upload Leads</button>
      <button class="dash-btn" id="addLeadManualBtn">+ Add Manually</button>
    </div>`;

  content.innerHTML = '<div class="dash-loading">Loading lead intelligence</div>';

  try {
    const data = await dashboardAPI('leads', 'get_dashboard');
    renderLeadsContent(data);
  } catch (e) {
    content.innerHTML = `<div class="dash-empty"><div class="dash-empty-icon">\u{1F465}</div><h3>Lead Intelligence</h3><p>Upload a CSV or add companies manually to start enriching.</p><button class="dash-btn dash-btn-primary" onclick="showUploadLeadsModal()">+ Upload Your First List</button></div>`;
  }

  document.getElementById('uploadLeadsBtn')?.addEventListener('click', showUploadLeadsModal);
  document.getElementById('addLeadManualBtn')?.addEventListener('click', showAddLeadManualModal);
}

function renderLeadsContent(data) {
  const content = document.getElementById('dashboardContent');
  const { lists, top_leads } = data;

  if (!lists || lists.length === 0) {
    content.innerHTML = `
      <div class="dash-empty">
        <div class="dash-empty-icon">\u{1F465}</div>
        <h3>No Lead Lists</h3>
        <p>Upload a CSV with company names to start enriching and scoring.</p>
        <button class="dash-btn dash-btn-primary" onclick="showUploadLeadsModal()">+ Upload Leads</button>
      </div>`;
    return;
  }

  let html = '';

  // Lead Lists overview
  html += '<div class="dash-grid" style="margin-bottom:24px">';
  for (const list of lists) {
    const progress = list.total_leads > 0 ? Math.round((list.enriched_count / list.total_leads) * 100) : 0;
    const statusBadge = {
      pending: 'dash-badge-warning',
      enriching: 'dash-badge-info',
      ready: 'dash-badge-success',
      error: 'dash-badge-critical',
    }[list.status] || 'dash-badge-info';

    html += `
      <div class="dash-card">
        <div class="dash-card-header">
          <div>
            <div class="dash-card-title">${list.name}</div>
            <div class="dash-card-subtitle">${list.total_leads} leads &middot; Created ${timeAgo(list.created_at)}</div>
          </div>
          <span class="dash-card-badge ${statusBadge}">${list.status}</span>
        </div>

        <div style="margin:12px 0">
          <div style="display:flex;justify-content:space-between;font-size:0.8rem;margin-bottom:4px">
            <span style="color:var(--text-secondary)">Enrichment Progress</span>
            <span style="color:var(--text-primary);font-weight:600">${list.enriched_count}/${list.total_leads} (${progress}%)</span>
          </div>
          <div class="dash-score-bar">
            <div class="dash-score-bar-fill ${progress >= 70 ? 'score-high' : progress >= 30 ? 'score-mid' : 'score-low'}" style="width:${progress}%"></div>
          </div>
        </div>

        <div style="display:flex;gap:6px">
          <button class="dash-btn dash-btn-sm" onclick="viewLeadList('${list.id}')">View Leads</button>
          ${list.status !== 'enriching' ? `<button class="dash-btn dash-btn-sm dash-btn-primary" onclick="enrichLeadList('${list.id}')">Enrich</button>` : ''}
          <button class="dash-btn dash-btn-sm dash-btn-danger" onclick="deleteLeadList('${list.id}')">Delete</button>
        </div>
      </div>`;
  }
  html += '</div>';

  // Top scored leads
  if (top_leads && top_leads.length > 0) {
    html += `
      <div class="dash-card">
        <div class="dash-card-header">
          <div class="dash-card-title">Top Scored Leads</div>
          <span class="dash-card-badge dash-badge-success">Enriched</span>
        </div>
        <table class="dash-table">
          <thead>
            <tr>
              <th>Company</th>
              <th>Score</th>
              <th>Financial</th>
              <th>Sentiment</th>
              <th>Hiring</th>
              <th>Summary</th>
            </tr>
          </thead>
          <tbody>
            ${top_leads.map(lead => {
              const b = lead.score_breakdown || {};
              return `<tr>
                <td>
                  <div style="font-weight:600">${lead.company_name}</div>
                  ${lead.ticker ? `<div style="font-size:0.75rem;color:var(--text-muted)">${lead.ticker}</div>` : ''}
                </td>
                <td class="td-score" style="color:${scoreColor(lead.score || 0)}">${lead.score || 'N/A'}</td>
                <td>${renderMiniScore(b.financial_health)}</td>
                <td>${renderMiniScore(b.news_sentiment)}</td>
                <td>${renderMiniScore(b.hiring_signals)}</td>
                <td style="font-size:0.8rem;color:var(--text-secondary);max-width:300px">${(lead.ai_summary || '').substring(0, 120)}${(lead.ai_summary || '').length > 120 ? '...' : ''}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
  }

  content.innerHTML = html;
}

function renderMiniScore(score) {
  if (score === undefined || score === null) return '<span style="color:var(--text-muted)">-</span>';
  return `<span style="color:${scoreColor(score)};font-weight:600;font-size:0.85rem">${score}</span>`;
}

// ── Upload Modal ──

function showUploadLeadsModal() {
  showDashModal('Upload Lead List', `
    <div class="dash-form-group">
      <label class="dash-form-label">List Name</label>
      <input type="text" class="dash-form-input" id="leadListName" placeholder="e.g. Q2 Target Accounts">
    </div>
    <div class="dash-form-group">
      <label class="dash-form-label">CSV Data</label>
      <textarea class="dash-form-textarea" id="leadsCsvData" placeholder="company_name,ticker
Apple,AAPL
Google,GOOGL
Tesla,TSLA" style="min-height:140px;font-family:'JetBrains Mono',monospace;font-size:0.8rem"></textarea>
      <div style="font-size:0.75rem;color:var(--text-muted);margin-top:4px">Paste CSV with headers. Required: company_name. Optional: ticker, contact_name, contact_title, contact_email, website</div>
    </div>
  `, [{
    label: 'Upload & Create List',
    primary: true,
    handler: async () => {
      const name = document.getElementById('leadListName')?.value?.trim();
      const csv = document.getElementById('leadsCsvData')?.value?.trim();
      if (!name || !csv) return;

      const leads = parseCSV(csv);
      if (leads.length === 0) { alert('No valid leads found in CSV'); return; }

      try {
        await dashboardAPI('leads', 'create_list', { name, leads });
        renderLeadsDashboard();
      } catch (e) {
        alert(e.message);
      }
    }
  }]);
}

function showAddLeadManualModal() {
  showDashModal('Add Lead Manually', `
    <div class="dash-form-group">
      <label class="dash-form-label">List Name</label>
      <input type="text" class="dash-form-input" id="manualListName" placeholder="e.g. Quick Research">
    </div>
    <div class="dash-form-group">
      <label class="dash-form-label">Company Name</label>
      <input type="text" class="dash-form-input" id="manualCompanyName" placeholder="e.g. Stripe">
    </div>
    <div class="dash-form-row">
      <div class="dash-form-group">
        <label class="dash-form-label">Ticker (optional)</label>
        <input type="text" class="dash-form-input" id="manualTicker" placeholder="e.g. AAPL">
      </div>
      <div class="dash-form-group">
        <label class="dash-form-label">Website (optional)</label>
        <input type="text" class="dash-form-input" id="manualWebsite" placeholder="e.g. stripe.com">
      </div>
    </div>
  `, [{
    label: 'Add Lead',
    primary: true,
    handler: async () => {
      const listName = document.getElementById('manualListName')?.value?.trim() || 'Manual Entry';
      const companyName = document.getElementById('manualCompanyName')?.value?.trim();
      if (!companyName) return;

      const lead = {
        company_name: companyName,
        ticker: document.getElementById('manualTicker')?.value?.trim() || undefined,
        website: document.getElementById('manualWebsite')?.value?.trim() || undefined,
      };

      try {
        await dashboardAPI('leads', 'create_list', { name: listName, leads: [lead] });
        renderLeadsDashboard();
      } catch (e) {
        alert(e.message);
      }
    }
  }]);
}

// ── CSV Parser ──

function parseCSV(csv) {
  const lines = csv.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/['"]/g, ''));
  const leads = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.trim().replace(/['"]/g, ''));
    const obj = {};
    headers.forEach((h, j) => { if (values[j]) obj[h] = values[j]; });
    if (obj.company_name || obj.company || obj.name) {
      leads.push(obj);
    }
  }

  return leads;
}

// ── Lead List Detail View ──

async function viewLeadList(listId) {
  const content = document.getElementById('dashboardContent');
  content.innerHTML = '<div class="dash-loading">Loading leads</div>';

  try {
    const { list, leads } = await dashboardAPI('leads', 'get_list', { list_id: listId });

    let html = `
      <div style="margin-bottom:16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <button class="dash-btn" onclick="renderLeadsDashboard()">&larr; Back</button>
        <span style="font-weight:600;color:var(--text-primary)">${list.name}</span>
        <span style="color:var(--text-secondary);font-size:0.85rem">${list.total_leads} leads &middot; ${list.enriched_count} enriched</span>
        ${list.status !== 'enriching' ? `<button class="dash-btn dash-btn-sm dash-btn-primary" onclick="enrichLeadList('${listId}')">Enrich All</button>` : '<span class="dash-card-badge dash-badge-info">Enriching...</span>'}
      </div>`;

    if (leads && leads.length > 0) {
      html += `
        <div class="dash-card">
          <table class="dash-table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Status</th>
                <th>Score</th>
                <th>Financial</th>
                <th>Sentiment</th>
                <th>Regulatory</th>
                <th>Hiring</th>
                <th>Patents</th>
                <th>Summary</th>
              </tr>
            </thead>
            <tbody>
              ${leads.map(lead => {
                const b = lead.score_breakdown || {};
                const statusBadge = {
                  pending: '<span class="dash-card-badge dash-badge-warning">Pending</span>',
                  enriching: '<span class="dash-card-badge dash-badge-info">Enriching</span>',
                  enriched: '<span class="dash-card-badge dash-badge-success">Done</span>',
                  error: '<span class="dash-card-badge dash-badge-critical">Error</span>',
                }[lead.status] || '';

                return `<tr>
                  <td>
                    <div style="font-weight:600">${lead.company_name}</div>
                    ${lead.ticker ? `<div style="font-size:0.75rem;color:var(--text-muted)">${lead.ticker}</div>` : ''}
                    ${lead.contact_name ? `<div style="font-size:0.75rem;color:var(--text-muted)">${lead.contact_name}${lead.contact_title ? ' - ' + lead.contact_title : ''}</div>` : ''}
                  </td>
                  <td>${statusBadge}</td>
                  <td class="td-score" style="color:${scoreColor(lead.score || 0)};font-size:1.1rem">${lead.score !== null ? lead.score : '-'}</td>
                  <td>${renderMiniScore(b.financial_health)}</td>
                  <td>${renderMiniScore(b.news_sentiment)}</td>
                  <td>${renderMiniScore(b.regulatory_exposure)}</td>
                  <td>${renderMiniScore(b.hiring_signals)}</td>
                  <td>${renderMiniScore(b.patent_activity)}</td>
                  <td style="font-size:0.78rem;color:var(--text-secondary);max-width:250px">${(lead.ai_summary || '-').substring(0, 100)}${(lead.ai_summary || '').length > 100 ? '...' : ''}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>`;
    } else {
      html += '<div class="dash-empty"><p>No leads in this list.</p></div>';
    }

    content.innerHTML = html;
  } catch (e) {
    content.innerHTML = `<div class="dash-empty"><p>Error: ${e.message}</p></div>`;
  }
}

async function enrichLeadList(listId) {
  try {
    const result = await dashboardAPI('leads', 'enrich', { list_id: listId });
    if (result.all_done) {
      alert(`Enrichment complete! ${result.total_enriched} leads enriched.`);
    } else {
      alert(`Enriched ${result.enriched} leads this batch. ${result.total_enriched} total. Run again for remaining.`);
    }
    renderLeadsDashboard();
  } catch (e) {
    alert('Enrichment error: ' + e.message);
  }
}

async function deleteLeadList(listId) {
  if (!confirm('Delete this lead list and all its leads?')) return;
  try {
    await dashboardAPI('leads', 'delete_list', { list_id: listId });
    renderLeadsDashboard();
  } catch (e) {
    alert(e.message);
  }
}
