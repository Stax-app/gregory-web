/* ============================================================
   GREGORY — Dashboard Shell & Shared Components
   Navigation, API client, chart rendering, reusable components
   ============================================================ */

// ── Dashboard State ──
const dashboardState = {
  activeDashboard: null,
  cache: {},
};

const DASHBOARD_API = 'https://civpkkhofvpaifprhpii.supabase.co/functions/v1/gregory-dashboards';

// ── API Client ──

async function dashboardAPI(feature, action, params = {}) {
  const headers = { 'Content-Type': 'application/json' };

  // Get auth token
  if (typeof supabaseClient !== 'undefined' && appState?.user) {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (session) {
      headers['Authorization'] = 'Bearer ' + session.access_token;
    }
  }

  // Fallback to anon key
  if (!headers['Authorization']) {
    headers['Authorization'] = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNpdnBra2hvZnZwYWlmcHJocGlpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDAyNTAyNjIsImV4cCI6MjA1NTgyNjI2Mn0.vu3t2VAkwz1jMwysU0y-2HqlKGbeQifjrbPhqxaM0fU';
  }

  const resp = await fetch(DASHBOARD_API, {
    method: 'POST',
    headers,
    body: JSON.stringify({ feature, action, ...params }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(err.error || `API error: ${resp.status}`);
  }

  return resp.json();
}

// ── Navigation ──

function navigateToDashboard(key) {
  const dc = document.getElementById('dashboardContainer');
  const cc = document.getElementById('chatContainer');
  const ia = document.querySelector('.input-area');

  // Hide chat, show dashboard
  if (cc) cc.style.display = 'none';
  if (ia) ia.style.display = 'none';
  if (dc) dc.style.display = '';

  // Update sidebar active states
  document.querySelectorAll('.agent-nav-item').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.dashboard-nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.dashboard === key);
  });

  // Close mobile sidebar
  document.getElementById('sidebar')?.classList.remove('open');

  dashboardState.activeDashboard = key;

  // Render the appropriate dashboard
  const renderers = {
    competitive: typeof renderCompetitiveDashboard === 'function' ? renderCompetitiveDashboard : null,
    brand: typeof renderBrandDashboard === 'function' ? renderBrandDashboard : null,
    leads: typeof renderLeadsDashboard === 'function' ? renderLeadsDashboard : null,
    campaigns: typeof renderCampaignsDashboard === 'function' ? renderCampaignsDashboard : null,
    notifications: typeof renderNotificationsDashboard === 'function' ? renderNotificationsDashboard : null,
  };

  const renderer = renderers[key];
  if (renderer) {
    renderer();
  } else {
    const content = document.getElementById('dashboardContent');
    content.innerHTML = `<div class="dash-empty"><div class="dash-empty-icon">🚧</div><h3>Coming Soon</h3><p>This dashboard is under development.</p></div>`;
  }
}

// ── Auth Guard ──

function requireAuth() {
  if (!appState?.user) {
    const content = document.getElementById('dashboardContent');
    const header = document.getElementById('dashboardHeader');
    header.innerHTML = '';
    content.innerHTML = `
      <div class="dash-empty">
        <div class="dash-empty-icon">🔒</div>
        <h3>Sign In Required</h3>
        <p>Please sign in to access dashboards.</p>
      </div>`;
    return false;
  }
  return true;
}

// ── SVG Line Chart ──

function renderLineChart(containerId, data, opts = {}) {
  const container = document.getElementById(containerId);
  if (!container || !data || data.length === 0) {
    if (container) container.innerHTML = '<div class="dash-empty" style="padding:24px"><p>No data available</p></div>';
    return;
  }

  const width = opts.width || container.clientWidth || 600;
  const height = opts.height || 180;
  const padding = { top: 20, right: 20, bottom: 30, left: 50 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const values = data.map(d => d.value);
  const minVal = opts.minVal !== undefined ? opts.minVal : Math.min(...values);
  const maxVal = opts.maxVal !== undefined ? opts.maxVal : Math.max(...values);
  const range = maxVal - minVal || 1;

  const scaleX = (i) => padding.left + (i / (data.length - 1)) * chartW;
  const scaleY = (v) => padding.top + chartH - ((v - minVal) / range) * chartH;

  // Build path
  const points = data.map((d, i) => `${scaleX(i).toFixed(1)},${scaleY(d.value).toFixed(1)}`);
  const linePath = `M${points.join('L')}`;
  const areaPath = `${linePath}L${scaleX(data.length - 1).toFixed(1)},${(padding.top + chartH).toFixed(1)}L${padding.left},${(padding.top + chartH).toFixed(1)}Z`;

  // Grid lines
  const gridCount = 4;
  let gridLines = '';
  for (let i = 0; i <= gridCount; i++) {
    const y = padding.top + (i / gridCount) * chartH;
    const val = maxVal - (i / gridCount) * range;
    gridLines += `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" class="dash-chart-grid"/>`;
    gridLines += `<text x="${padding.left - 6}" y="${y + 3}" text-anchor="end" class="dash-chart-label">${opts.formatValue ? opts.formatValue(val) : val.toFixed(1)}</text>`;
  }

  // X labels (show max 7)
  let xLabels = '';
  const step = Math.max(1, Math.floor(data.length / 7));
  for (let i = 0; i < data.length; i += step) {
    xLabels += `<text x="${scaleX(i)}" y="${height - 4}" text-anchor="middle" class="dash-chart-label">${data[i].label || ''}</text>`;
  }

  // Dots
  const dots = data.map((d, i) =>
    `<circle cx="${scaleX(i).toFixed(1)}" cy="${scaleY(d.value).toFixed(1)}" class="dash-chart-dot"/>`
  ).join('');

  const color = opts.color || 'var(--accent)';

  container.innerHTML = `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" class="dash-chart">
      ${gridLines}
      <path d="${areaPath}" fill="${color}" opacity="0.1"/>
      <path d="${linePath}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      ${dots}
      ${xLabels}
    </svg>`;
}

// ── Score Color Helper ──

function scoreColor(score) {
  if (score >= 70) return 'var(--success)';
  if (score >= 40) return 'var(--warning)';
  return 'var(--error)';
}

function scoreClass(score) {
  if (score >= 70) return 'score-high';
  if (score >= 40) return 'score-mid';
  return 'score-low';
}

function severityEmoji(severity) {
  return { info: 'ℹ️', warning: '⚠️', critical: '🚨' }[severity] || 'ℹ️';
}

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ── Simple Markdown Renderer (for digests) ──

function renderSimpleMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/### (.+)/g, '<h3>$1</h3>')
    .replace(/## (.+)/g, '<h2>$1</h2>')
    .replace(/# (.+)/g, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>')
    .replace(/\n{2,}/g, '<br><br>')
    .replace(/\n/g, '<br>');
}

// ── Modal Helper ──

function showDashModal(title, bodyHtml, actions = []) {
  const existing = document.querySelector('.dash-modal-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'dash-modal-overlay';
  overlay.innerHTML = `
    <div class="dash-modal">
      <h3>${title}</h3>
      <div class="dash-modal-body">${bodyHtml}</div>
      <div class="dash-modal-actions">
        <button class="dash-btn" onclick="this.closest('.dash-modal-overlay').remove()">Cancel</button>
        ${actions.map((a, i) => `<button class="dash-btn ${a.primary ? 'dash-btn-primary' : ''}" id="dashModalAction${i}">${a.label}</button>`).join('')}
      </div>
    </div>`;

  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  // Bind action handlers
  actions.forEach((a, i) => {
    const btn = document.getElementById(`dashModalAction${i}`);
    if (btn) btn.addEventListener('click', () => { a.handler(); overlay.remove(); });
  });

  return overlay;
}
