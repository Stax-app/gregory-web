/* ============================================================
   GREGORY — Campaign Strategist Dashboard
   AI-powered GTM plans using all 4 specialist agents
   ============================================================ */

async function renderCampaignsDashboard() {
  if (!requireAuth()) return;

  const header = document.getElementById('dashboardHeader');
  const content = document.getElementById('dashboardContent');

  header.innerHTML = `
    <h2><span class="dash-icon">\u{1F3AF}</span> Campaign Strategist</h2>
    <div class="dashboard-header-actions">
      <button class="dash-btn dash-btn-primary" id="newCampaignBtn">+ New Campaign</button>
    </div>`;

  content.innerHTML = '<div class="dash-loading">Loading campaigns</div>';

  try {
    const data = await dashboardAPI('campaign', 'list');
    renderCampaignsContent(data);
  } catch (e) {
    content.innerHTML = `<div class="dash-empty"><div class="dash-empty-icon">\u{1F3AF}</div><h3>Campaign Strategist</h3><p>Create your first AI-powered marketing campaign plan.</p><button class="dash-btn dash-btn-primary" onclick="showNewCampaignModal()">+ Create Campaign</button></div>`;
  }

  document.getElementById('newCampaignBtn')?.addEventListener('click', showNewCampaignModal);
}

function renderCampaignsContent(data) {
  const content = document.getElementById('dashboardContent');
  const { campaigns } = data;

  if (!campaigns || campaigns.length === 0) {
    content.innerHTML = `
      <div class="dash-empty">
        <div class="dash-empty-icon">\u{1F3AF}</div>
        <h3>No Campaigns Yet</h3>
        <p>Create a campaign and let Gregory's agents build you a full GTM plan.</p>
        <button class="dash-btn dash-btn-primary" onclick="showNewCampaignModal()">+ Create Campaign</button>
      </div>`;
    return;
  }

  let html = '<div class="dash-grid">';
  for (const campaign of campaigns) {
    const inputs = campaign.inputs || {};
    const statusBadge = {
      draft: 'dash-badge-warning',
      planning: 'dash-badge-info',
      active: 'dash-badge-success',
      paused: 'dash-badge-warning',
      completed: 'dash-badge-success',
    }[campaign.status] || 'dash-badge-info';

    html += `
      <div class="dash-card">
        <div class="dash-card-header">
          <div>
            <div class="dash-card-title">${campaign.name}</div>
            <div class="dash-card-subtitle">${inputs.product || 'No product specified'} &middot; ${inputs.budget || 'No budget'}</div>
          </div>
          <span class="dash-card-badge ${statusBadge}">${campaign.status}</span>
        </div>

        <div style="font-size:0.83rem;color:var(--text-secondary);margin:8px 0">
          ${inputs.audience ? `<div><strong>Audience:</strong> ${inputs.audience}</div>` : ''}
          ${inputs.goals ? `<div><strong>Goals:</strong> ${inputs.goals}</div>` : ''}
          ${inputs.timeline ? `<div><strong>Timeline:</strong> ${inputs.timeline}</div>` : ''}
        </div>

        <div style="display:flex;gap:6px;margin-top:12px">
          <button class="dash-btn dash-btn-sm" onclick="viewCampaign('${campaign.id}')">View Plan</button>
          ${campaign.status === 'draft' ? `<button class="dash-btn dash-btn-sm dash-btn-primary" onclick="generateCampaignPlan('${campaign.id}')">Generate Plan</button>` : ''}
          <button class="dash-btn dash-btn-sm dash-btn-danger" onclick="deleteCampaign('${campaign.id}')">Delete</button>
        </div>
      </div>`;
  }
  html += '</div>';

  content.innerHTML = html;
}

function showNewCampaignModal() {
  showDashModal('Create New Campaign', `
    <div class="dash-form-group">
      <label class="dash-form-label">Campaign Name</label>
      <input type="text" class="dash-form-input" id="campName" placeholder="e.g. Q3 Product Launch">
    </div>
    <div class="dash-form-group">
      <label class="dash-form-label">Product / Service</label>
      <input type="text" class="dash-form-input" id="campProduct" placeholder="e.g. Investment analytics platform">
    </div>
    <div class="dash-form-group">
      <label class="dash-form-label">Target Audience</label>
      <input type="text" class="dash-form-input" id="campAudience" placeholder="e.g. Retail investors aged 25-45">
    </div>
    <div class="dash-form-row">
      <div class="dash-form-group">
        <label class="dash-form-label">Budget</label>
        <input type="text" class="dash-form-input" id="campBudget" placeholder="e.g. $50,000">
      </div>
      <div class="dash-form-group">
        <label class="dash-form-label">Timeline</label>
        <input type="text" class="dash-form-input" id="campTimeline" placeholder="e.g. 3 months">
      </div>
    </div>
    <div class="dash-form-group">
      <label class="dash-form-label">Goals</label>
      <textarea class="dash-form-textarea" id="campGoals" placeholder="e.g. 10,000 signups, 5% conversion rate, brand awareness in fintech space"></textarea>
    </div>
    <div class="dash-form-group">
      <label class="dash-form-label">Industry (optional)</label>
      <input type="text" class="dash-form-input" id="campIndustry" placeholder="e.g. Fintech">
    </div>
  `, [{
    label: 'Create & Generate Plan',
    primary: true,
    handler: async () => {
      const name = document.getElementById('campName')?.value?.trim();
      if (!name) return;

      const inputs = {
        product: document.getElementById('campProduct')?.value?.trim() || '',
        audience: document.getElementById('campAudience')?.value?.trim() || '',
        budget: document.getElementById('campBudget')?.value?.trim() || '',
        timeline: document.getElementById('campTimeline')?.value?.trim() || '',
        goals: document.getElementById('campGoals')?.value?.trim() || '',
        industry: document.getElementById('campIndustry')?.value?.trim() || '',
      };

      try {
        const { campaign } = await dashboardAPI('campaign', 'create', { name, inputs });
        // Auto-generate plan
        await generateCampaignPlan(campaign.id);
      } catch (e) {
        alert(e.message);
      }
    }
  }]);
}

async function generateCampaignPlan(campaignId) {
  const content = document.getElementById('dashboardContent');
  content.innerHTML = '<div class="dash-loading">Gregory is analyzing market data and generating your GTM plan. This may take 30-60 seconds</div>';

  try {
    const result = await dashboardAPI('campaign', 'generate_plan', { campaign_id: campaignId });
    viewCampaign(campaignId);
  } catch (e) {
    content.innerHTML = `<div class="dash-empty"><p>Error generating plan: ${e.message}</p><button class="dash-btn" onclick="renderCampaignsDashboard()">Back to Campaigns</button></div>`;
  }
}

async function viewCampaign(campaignId) {
  const content = document.getElementById('dashboardContent');
  content.innerHTML = '<div class="dash-loading">Loading campaign</div>';

  try {
    const { campaign } = await dashboardAPI('campaign', 'get', { campaign_id: campaignId });
    const plan = campaign.plan || {};
    const inputs = campaign.inputs || {};

    let html = `
      <div style="margin-bottom:16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <button class="dash-btn" onclick="renderCampaignsDashboard()">&larr; Back</button>
        <span style="font-weight:600;color:var(--text-primary);font-size:1.1rem">${campaign.name}</span>
        <span class="dash-card-badge ${campaign.status === 'active' ? 'dash-badge-success' : 'dash-badge-warning'}">${campaign.status}</span>
        ${campaign.status !== 'planning' ? `<button class="dash-btn dash-btn-sm" onclick="generateCampaignPlan('${campaignId}')">Regenerate Plan</button>` : ''}
      </div>`;

    // Campaign inputs summary
    html += `
      <div class="dash-card" style="margin-bottom:16px">
        <div class="dash-card-title" style="margin-bottom:8px">Campaign Brief</div>
        <div class="dash-grid" style="gap:8px;margin:0">
          ${inputs.product ? `<div><span style="color:var(--text-secondary);font-size:0.8rem">PRODUCT</span><br><strong>${inputs.product}</strong></div>` : ''}
          ${inputs.audience ? `<div><span style="color:var(--text-secondary);font-size:0.8rem">AUDIENCE</span><br><strong>${inputs.audience}</strong></div>` : ''}
          ${inputs.budget ? `<div><span style="color:var(--text-secondary);font-size:0.8rem">BUDGET</span><br><strong>${inputs.budget}</strong></div>` : ''}
          ${inputs.timeline ? `<div><span style="color:var(--text-secondary);font-size:0.8rem">TIMELINE</span><br><strong>${inputs.timeline}</strong></div>` : ''}
        </div>
        ${inputs.goals ? `<div style="margin-top:8px"><span style="color:var(--text-secondary);font-size:0.8rem">GOALS</span><br>${inputs.goals}</div>` : ''}
      </div>`;

    if (plan.parse_error) {
      // Raw plan text if JSON parsing failed
      html += `<div class="dash-card"><div class="dash-card-title">Generated Plan</div><div class="dash-digest" style="margin-top:8px">${renderSimpleMarkdown(plan.raw_plan || 'No plan generated')}</div></div>`;
    } else if (plan.executive_summary) {
      // Structured plan
      html += renderStructuredPlan(plan);
    } else {
      html += '<div class="dash-empty"><p>No plan generated yet.</p><button class="dash-btn dash-btn-primary" onclick="generateCampaignPlan(\'' + campaignId + '\')">Generate Plan</button></div>';
    }

    content.innerHTML = html;
  } catch (e) {
    content.innerHTML = `<div class="dash-empty"><p>Error: ${e.message}</p><button class="dash-btn" onclick="renderCampaignsDashboard()">Back</button></div>`;
  }
}

function renderStructuredPlan(plan) {
  let html = '';

  // Executive Summary
  if (plan.executive_summary) {
    html += `
      <div class="dash-card" style="margin-bottom:16px">
        <div class="dash-card-title">Executive Summary</div>
        <p style="font-size:0.9rem;color:var(--text-primary);margin:8px 0 0 0">${plan.executive_summary}</p>
      </div>`;
  }

  // Channel Mix
  if (plan.channel_mix && plan.channel_mix.length > 0) {
    html += `
      <div class="dash-card" style="margin-bottom:16px">
        <div class="dash-card-title" style="margin-bottom:12px">Channel Mix</div>
        <table class="dash-table">
          <thead><tr><th>Channel</th><th>Budget %</th><th>Expected ROI</th><th>Rationale</th></tr></thead>
          <tbody>
            ${plan.channel_mix.map(ch => `
              <tr>
                <td style="font-weight:600">${ch.channel}</td>
                <td><div style="display:flex;align-items:center;gap:8px">
                  <div class="dash-score-bar" style="width:80px"><div class="dash-score-bar-fill score-high" style="width:${ch.budget_pct || 0}%"></div></div>
                  <span>${ch.budget_pct || 0}%</span>
                </div></td>
                <td style="color:var(--success)">${ch.expected_roi || 'TBD'}</td>
                <td style="font-size:0.82rem;color:var(--text-secondary)">${ch.rationale || ''}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  // Messaging
  if (plan.messaging) {
    const m = plan.messaging;
    html += `
      <div class="dash-card" style="margin-bottom:16px">
        <div class="dash-card-title" style="margin-bottom:12px">Messaging Strategy</div>
        ${m.core_positioning ? `<div style="margin-bottom:12px"><span style="color:var(--text-secondary);font-size:0.8rem">CORE POSITIONING</span><br><strong style="font-size:1rem">${m.core_positioning}</strong></div>` : ''}
        ${m.tone ? `<div style="margin-bottom:12px"><span style="color:var(--text-secondary);font-size:0.8rem">TONE</span><br>${m.tone}</div>` : ''}
        ${m.key_messages ? `<div style="margin-bottom:12px"><span style="color:var(--text-secondary);font-size:0.8rem">KEY MESSAGES</span><ul style="margin:4px 0 0 0;padding-left:20px">${m.key_messages.map(msg => `<li style="margin:4px 0">${msg}</li>`).join('')}</ul></div>` : ''}
        ${m.behavioral_hooks ? `<div><span style="color:var(--text-secondary);font-size:0.8rem">BEHAVIORAL HOOKS</span><ul style="margin:4px 0 0 0;padding-left:20px">${m.behavioral_hooks.map(h => `<li style="margin:4px 0;color:var(--accent-light)">${h}</li>`).join('')}</ul></div>` : ''}
      </div>`;
  }

  // Timeline
  if (plan.timeline && plan.timeline.length > 0) {
    html += `
      <div class="dash-card" style="margin-bottom:16px">
        <div class="dash-card-title" style="margin-bottom:12px">Timeline</div>
        ${plan.timeline.map((phase, i) => `
          <div style="padding:12px 0;border-bottom:1px solid var(--border);display:flex;gap:16px">
            <div style="width:32px;height:32px;border-radius:50%;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:0.85rem;flex-shrink:0">${i + 1}</div>
            <div style="flex:1">
              <div style="font-weight:600;color:var(--text-primary)">${phase.phase} <span style="color:var(--text-muted);font-weight:400">&middot; ${phase.duration || ''}</span></div>
              ${phase.activities ? `<ul style="margin:6px 0 0 0;padding-left:18px;font-size:0.83rem;color:var(--text-secondary)">${phase.activities.map(a => `<li>${a}</li>`).join('')}</ul>` : ''}
              ${phase.milestones ? `<div style="margin-top:6px;font-size:0.8rem;color:var(--success)">Milestones: ${phase.milestones.join(', ')}</div>` : ''}
            </div>
          </div>`).join('')}
      </div>`;
  }

  // KPIs
  if (plan.kpis && plan.kpis.length > 0) {
    html += `
      <div class="dash-card" style="margin-bottom:16px">
        <div class="dash-card-title" style="margin-bottom:12px">Key Performance Indicators</div>
        <table class="dash-table">
          <thead><tr><th>Metric</th><th>Target</th><th>Measurement</th></tr></thead>
          <tbody>${plan.kpis.map(k => `<tr><td style="font-weight:600">${k.metric}</td><td style="color:var(--accent)">${k.target}</td><td style="font-size:0.83rem;color:var(--text-secondary)">${k.measurement || ''}</td></tr>`).join('')}</tbody>
        </table>
      </div>`;
  }

  // Regulatory Flags
  if (plan.regulatory_flags && plan.regulatory_flags.length > 0) {
    html += `
      <div class="dash-card" style="margin-bottom:16px">
        <div class="dash-card-header">
          <div class="dash-card-title">Regulatory Flags</div>
          <span class="dash-card-badge dash-badge-warning">Review Required</span>
        </div>
        <ul style="margin:8px 0 0 0;padding-left:20px;font-size:0.88rem">
          ${plan.regulatory_flags.map(f => `<li style="margin:6px 0;color:var(--warning)">${f}</li>`).join('')}
        </ul>
      </div>`;
  }

  // Competitive Positioning
  if (plan.competitive_positioning) {
    html += `
      <div class="dash-card" style="margin-bottom:16px">
        <div class="dash-card-title">Competitive Positioning</div>
        <p style="font-size:0.9rem;color:var(--text-primary);margin:8px 0 0 0">${plan.competitive_positioning}</p>
      </div>`;
  }

  return html;
}

async function deleteCampaign(campaignId) {
  if (!confirm('Delete this campaign?')) return;
  try {
    await dashboardAPI('campaign', 'delete', { campaign_id: campaignId });
    renderCampaignsDashboard();
  } catch (e) {
    alert(e.message);
  }
}
