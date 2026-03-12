/* ============================================================
   STAXLABS — Content Engine Application Logic
   ============================================================ */

const StaxApp = (() => {

  // ---------- CONFIG ----------

  const SUPABASE_URL = 'https://civpkkhofvpaifprhpii.supabase.co';
  const CONTENT_FUNCTION = SUPABASE_URL + '/functions/v1/staxlabs-content';
  const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNpdnBra2hvZnZwYWlmcHJocGlpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDk4ODc2NDksImV4cCI6MjA2NTQ2MzY0OX0.Vu7gH2SZ41OCqH6i9lio3FESM6dL0k3hdIsb-0n_Xww';

  // ---------- SVG ICONS ----------

  const ICONS = {
    weekly_recap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 17V13"/><path d="M12 17V9"/><path d="M17 17V5"/></svg>',
    top_movers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 7l-6-5-6 5"/><path d="M12 2v10"/><path d="M6 17l6 5 6-5"/><path d="M12 22V12"/></svg>',
    strategy_spotlight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
    core4_score: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>',
    hedge_fund_intel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="10" width="4" height="10" rx="1"/><rect x="10" y="6" width="4" height="14" rx="1"/><rect x="17" y="2" width="4" height="18" rx="1"/><path d="M2 22h20"/></svg>',
    user_shareable: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9H4.5a2.5 2.5 0 010-5C6 4 6 6 6 6"/><path d="M18 9h1.5a2.5 2.5 0 000-5C18 4 18 6 18 6"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 1012 0V2Z"/></svg>'
  };

  // ---------- CONTENT TYPES ----------

  const CONTENT_TYPES = {
    weekly_recap: {
      name: 'Weekly Market Recap',
      icon: 'weekly_recap',
      description: 'S&P performance, sector rotation, top movers, key events',
      hasParams: false,
      cardType: 'static'
    },
    top_movers: {
      name: 'Top Movers',
      icon: 'top_movers',
      description: 'Top 5 gainers and losers with analysis',
      hasParams: false,
      cardType: 'static'
    },
    strategy_spotlight: {
      name: 'Strategy Spotlight',
      icon: 'strategy_spotlight',
      description: 'Highlight a backtest strategy and results',
      hasParams: true,
      params: [{ name: 'strategy_name', label: 'Strategy Name', placeholder: 'e.g., Momentum Breakout' }],
      cardType: 'static'
    },
    core4_score: {
      name: 'Core4 Score Cards',
      icon: 'core4_score',
      description: 'Stock analysis cards with performance/value/stability/momentum',
      hasParams: true,
      params: [{ name: 'symbols', label: 'Stock Symbols', placeholder: 'AAPL, MSFT, NVDA, GOOGL, TSLA' }],
      cardType: 'static'
    },
    hedge_fund_intel: {
      name: 'Hedge Fund Intel',
      icon: 'hedge_fund_intel',
      description: 'What top funds are buying and selling',
      hasParams: true,
      params: [{ name: 'symbol', label: 'Stock Symbol', placeholder: 'AAPL' }],
      cardType: 'static'
    },
    user_shareable: {
      name: 'User Shareable',
      icon: 'user_shareable',
      description: 'Achievement and milestone cards for users to share',
      hasParams: true,
      params: [
        { name: 'achievement_type', label: 'Type', placeholder: 'milestone, streak, or returns' },
        { name: 'stat', label: 'Key Stat', placeholder: 'e.g., +47% returns, 30-day streak' }
      ],
      cardType: 'static'
    }
  };

  // ---------- STATE ----------

  let currentType = null;
  let lastPayload = null;
  let lastCardHtml = null;

  // ---------- DOM HELPERS ----------

  const $ = (id) => document.getElementById(id);

  function escapeHtml(text) {
    if (!text) return '';
    const d = document.createElement('div');
    d.textContent = String(text);
    return d.innerHTML;
  }

  // ---------- INIT ----------

  function init() {
    renderTemplateGrid();
    loadHistory();
  }

  // ---------- TEMPLATE GRID ----------

  function renderTemplateGrid() {
    const container = $('templateCards');
    container.innerHTML = Object.entries(CONTENT_TYPES).map(([key, ct]) => `
      <div class="sl-card" onclick="StaxApp.selectTemplate('${key}')">
        <div class="sl-card-icon">${ICONS[ct.icon] || ''}</div>
        <div class="sl-card-name">${escapeHtml(ct.name)}</div>
        <div class="sl-card-desc">${escapeHtml(ct.description)}</div>
      </div>
    `).join('');
  }

  // ---------- SELECT TEMPLATE ----------

  function selectTemplate(contentType) {
    currentType = contentType;
    const ct = CONTENT_TYPES[contentType];
    if (!ct) return;

    $('templateGrid').style.display = 'none';
    $('historySection').style.display = 'none';
    $('generatePanel').style.display = 'block';

    // Header
    $('genHeader').innerHTML = `
      <h2>${escapeHtml(ct.name)}</h2>
      <p>${escapeHtml(ct.description)}</p>
    `;

    // Params
    const paramsEl = $('genParams');
    if (ct.hasParams && ct.params) {
      paramsEl.innerHTML = ct.params.map(p => `
        <div class="sl-param-group">
          <label class="sl-param-label" for="param-${p.name}">${escapeHtml(p.label)}</label>
          <input type="text" class="sl-param-input" id="param-${p.name}" placeholder="${escapeHtml(p.placeholder)}" />
        </div>
      `).join('');
    } else {
      paramsEl.innerHTML = '';
    }

    // Reset preview
    $('loadingState').style.display = 'none';
    $('previewArea').style.display = 'none';
    $('generateBtn').disabled = false;
    $('generateBtn').style.display = '';
  }

  // ---------- GO BACK ----------

  function goBack() {
    currentType = null;
    lastPayload = null;
    lastCardHtml = null;
    $('generatePanel').style.display = 'none';
    $('templateGrid').style.display = '';
    $('historySection').style.display = '';
  }

  // ---------- GENERATE ----------

  async function handleGenerate() {
    if (!currentType) return;
    const ct = CONTENT_TYPES[currentType];

    // Gather params
    const params = {};
    if (ct.hasParams && ct.params) {
      ct.params.forEach(p => {
        const el = document.getElementById('param-' + p.name);
        if (el && el.value.trim()) {
          params[p.name] = el.value.trim();
        }
      });
    }

    await generateContent(currentType, params);
  }

  async function generateContent(contentType, params) {
    $('generateBtn').disabled = true;
    $('generateBtn').style.display = 'none';
    $('loadingState').style.display = 'flex';
    $('previewArea').style.display = 'none';

    try {
      const body = { action: 'generate', content_type: contentType, ...params };
      const res = await fetch(CONTENT_FUNCTION, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + ANON_KEY,
          'apikey': ANON_KEY
        },
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`API error ${res.status}: ${errText}`);
      }

      const payload = await res.json();
      lastPayload = payload;
      renderPreview(contentType, payload);
    } catch (err) {
      $('loadingState').style.display = 'none';
      $('previewArea').style.display = 'block';
      $('previewContent').innerHTML = `<div class="sl-error">Error: ${escapeHtml(err.message)}</div>`;
      $('actionButtons').style.display = 'none';
      $('captionTabs').style.display = 'none';
      $('generateBtn').disabled = false;
      $('generateBtn').style.display = '';
    }
  }

  // ---------- RENDER PREVIEW ----------

  function renderPreview(contentType, payload) {
    $('loadingState').style.display = 'none';
    $('previewArea').style.display = 'block';

    const data = payload.data || payload;
    const hasScript = data.script && data.script.scenes;
    const hasCard = !hasScript;

    let previewHtml = '';

    if (hasScript) {
      // Video content — show script
      previewHtml = renderScriptPreview(data.script);
    } else {
      // Static card — render using card generators
      previewHtml = renderCardPreview(contentType, data);
    }

    $('previewContent').innerHTML = previewHtml;

    // Action buttons
    $('actionButtons').style.display = 'block';
    setupActionTabs(contentType, data, hasScript);

    // Caption tabs
    const captions = data.captions || payload.captions;
    if (captions && Object.keys(captions).length > 0) {
      $('captionTabs').style.display = 'block';
      renderCaptionTabs(captions);
    } else {
      $('captionTabs').style.display = 'none';
    }
  }

  // ---------- SCRIPT PREVIEW ----------

  function renderScriptPreview(script) {
    const scenes = script.scenes || [];
    return `
      <div class="sl-script">
        ${script.title ? `<div style="font-size:1.1rem;font-weight:700;margin-bottom:16px;">${escapeHtml(script.title)}</div>` : ''}
        ${scenes.map((scene, i) => `
          <div class="sl-script-scene">
            <div class="sl-script-scene-num">Scene ${i + 1}${scene.duration ? ` — ${escapeHtml(scene.duration)}` : ''}</div>
            ${scene.visual ? `<div class="sl-script-row"><span class="sl-script-label">Visual:</span><span class="sl-script-value">${escapeHtml(scene.visual)}</span></div>` : ''}
            ${scene.voiceover ? `<div class="sl-script-row"><span class="sl-script-label">Voiceover:</span><span class="sl-script-value">${escapeHtml(scene.voiceover)}</span></div>` : ''}
            ${scene.text_overlay ? `<div class="sl-script-row"><span class="sl-script-label">Text:</span><span class="sl-script-value">${escapeHtml(scene.text_overlay)}</span></div>` : ''}
          </div>
        `).join('')}
      </div>
    `;
  }

  // ---------- CARD PREVIEW ----------

  function renderCardPreview(contentType, data) {
    let cardHtml = '';

    switch (contentType) {
      case 'weekly_recap':
        cardHtml = StaxCards.renderWeeklyRecapCard(data);
        break;
      case 'top_movers':
        // Render both gainers and losers if available
        const gainersHtml = StaxCards.renderTopMoversCard({ movers: data.gainers || data.top_gainers, date: data.date }, 'gainers');
        const losersHtml = StaxCards.renderTopMoversCard({ movers: data.losers || data.top_losers, date: data.date }, 'losers');
        cardHtml = gainersHtml + '<div style="height:24px;"></div>' + losersHtml;
        break;
      case 'strategy_spotlight':
        cardHtml = StaxCards.renderStrategyCard(data);
        break;
      case 'core4_score':
        const cards = data.cards || data.stocks || [data];
        cardHtml = cards.map(c => StaxCards.renderCore4ScoreCard(c)).join('<div style="height:24px;"></div>');
        break;
      case 'hedge_fund_intel':
        const funds = data.funds || [data];
        cardHtml = funds.map((f, i) => StaxCards.renderHedgeFundSlide({ funds }, i)).join('<div style="height:24px;"></div>');
        break;
      case 'user_shareable':
        cardHtml = StaxCards.renderUserShareableCard(data);
        break;
      default:
        cardHtml = `<pre style="color:#8892B0;">${escapeHtml(JSON.stringify(data, null, 2))}</pre>`;
    }

    lastCardHtml = cardHtml;
    return `<div class="sl-card-preview-wrapper">${cardHtml}</div>`;
  }

  // ---------- ACTION TABS ----------

  function setupActionTabs(contentType, data, hasScript) {
    const tabScript = $('tabScript');
    const tabDownload = $('tabDownload');
    const tabCaption = $('tabCaption');

    // Show/hide tabs based on content
    tabScript.style.display = hasScript ? '' : 'none';
    tabDownload.style.display = hasScript ? 'none' : '';

    // Reset active
    [tabScript, tabDownload, tabCaption].forEach(t => t.classList.remove('active'));
    if (hasScript) {
      tabScript.classList.add('active');
      showScriptAction(data);
    } else {
      tabDownload.classList.add('active');
      showDownloadAction();
    }

    // Tab click handlers
    tabScript.onclick = () => {
      setActiveTab(tabScript);
      showScriptAction(data);
    };
    tabDownload.onclick = () => {
      setActiveTab(tabDownload);
      showDownloadAction();
    };
    tabCaption.onclick = () => {
      setActiveTab(tabCaption);
      showCaptionAction(data);
    };
  }

  function setActiveTab(activeEl) {
    [$('tabScript'), $('tabDownload'), $('tabCaption')].forEach(t => t.classList.remove('active'));
    activeEl.classList.add('active');
  }

  function showScriptAction(data) {
    const script = data.script;
    const fullText = script ? script.scenes.map((s, i) =>
      `SCENE ${i + 1}${s.duration ? ' (' + s.duration + ')' : ''}\nVisual: ${s.visual || ''}\nVoiceover: ${s.voiceover || ''}\nText: ${s.text_overlay || ''}`
    ).join('\n\n') : JSON.stringify(data, null, 2);

    $('actionContent').innerHTML = `
      <button class="sl-btn sl-btn-secondary sl-btn-sm" onclick="StaxApp.copyToClipboard(${escapeAttr(fullText)})">
        Copy Full Script
      </button>
      <span class="sl-copied" id="copyFeedback">Copied!</span>
    `;
  }

  function showDownloadAction() {
    $('actionContent').innerHTML = `
      <div class="sl-download-area">
        <p style="font-size:0.82rem;color:#8892B0;margin-bottom:8px;">Download card as PNG image</p>
        <div class="sl-download-format">
          <button class="sl-btn sl-btn-primary sl-btn-sm" onclick="StaxApp.downloadCard()">Download PNG</button>
        </div>
      </div>
    `;
  }

  function showCaptionAction(data) {
    const captions = data.captions || lastPayload?.captions;
    if (captions && Object.keys(captions).length > 0) {
      const first = Object.keys(captions)[0];
      $('actionContent').innerHTML = `
        <button class="sl-btn sl-btn-secondary sl-btn-sm" onclick="StaxApp.copyToClipboard(${escapeAttr(captions[first])})">
          Copy Caption
        </button>
        <span class="sl-copied" id="copyFeedback">Copied!</span>
      `;
    } else {
      $('actionContent').innerHTML = '<p style="font-size:0.82rem;color:#8892B0;">No captions available.</p>';
    }
  }

  function escapeAttr(text) {
    return "'" + String(text || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n') + "'";
  }

  // ---------- CAPTION TABS ----------

  function renderCaptionTabs(captions) {
    const platforms = Object.keys(captions);
    const platformLabels = {
      instagram: 'Instagram', tiktok: 'TikTok', x: 'X / Twitter', twitter: 'X / Twitter', linkedin: 'LinkedIn'
    };

    $('captionTabBar').innerHTML = platforms.map((p, i) => `
      <button class="sl-caption-tab ${i === 0 ? 'active' : ''}" data-platform="${p}" onclick="StaxApp.switchCaptionTab('${p}')">${platformLabels[p] || p}</button>
    `).join('');

    showCaption(platforms[0], captions);
  }

  function switchCaptionTab(platform) {
    const captions = (lastPayload?.data || lastPayload)?.captions || lastPayload?.captions || {};
    document.querySelectorAll('.sl-caption-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.platform === platform);
    });
    showCaption(platform, captions);
  }

  function showCaption(platform, captions) {
    const text = captions[platform] || '';
    $('captionBody').innerHTML = `
      ${escapeHtml(text)}
      <div class="sl-caption-copy">
        <button class="sl-btn sl-btn-ghost sl-btn-sm" onclick="StaxApp.copyToClipboard(${escapeAttr(text)})">Copy</button>
      </div>
    `;
  }

  // ---------- COPY ----------

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      const fb = document.getElementById('copyFeedback') || document.querySelector('.sl-copied');
      if (fb) {
        fb.classList.add('show');
        setTimeout(() => fb.classList.remove('show'), 2000);
      }
    } catch (e) {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
  }

  // ---------- DOWNLOAD CARD ----------

  async function downloadCard() {
    const wrapper = document.querySelector('.sl-card-preview-wrapper');
    if (!wrapper) return;

    // Find the first card element (the 1080px div)
    const cardEl = wrapper.querySelector('div[style*="1080"]') || wrapper.firstElementChild;
    if (!cardEl) return;

    try {
      const canvas = await html2canvas(cardEl, {
        backgroundColor: '#0A0A0A',
        scale: 1,
        useCORS: true,
        logging: false
      });

      const link = document.createElement('a');
      link.download = `staxlabs-${currentType || 'card'}-${Date.now()}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
    } catch (err) {
      console.error('Download failed:', err);
    }
  }

  // ---------- HISTORY ----------

  async function loadHistory() {
    try {
      const res = await fetch(CONTENT_FUNCTION, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + ANON_KEY,
          'apikey': ANON_KEY
        },
        body: JSON.stringify({ action: 'list', limit: 10 })
      });

      if (!res.ok) return;
      const result = await res.json();
      const items = result.items || result.data || [];

      if (items.length === 0) return;

      const listEl = $('historyList');
      listEl.innerHTML = items.map(item => {
        const ct = CONTENT_TYPES[item.content_type];
        const name = ct ? ct.name : item.content_type;
        const date = item.created_at ? new Date(item.created_at).toLocaleDateString() : '';
        return `
          <div class="sl-history-item" onclick="StaxApp.viewHistoryItem(${escapeAttr(JSON.stringify(item))})">
            <span class="sl-history-type">${escapeHtml(name)}</span>
            <span class="sl-history-title">${escapeHtml(item.title || item.summary || '')}</span>
            <span class="sl-history-date">${escapeHtml(date)}</span>
          </div>
        `;
      }).join('');
    } catch (e) {
      // Silently fail — history is optional
      console.log('History load skipped:', e.message);
    }
  }

  function viewHistoryItem(item) {
    if (!item || !item.content_type) return;
    selectTemplate(item.content_type);
    if (item.data || item.result) {
      lastPayload = item.data || item.result;
      renderPreview(item.content_type, lastPayload);
      $('generateBtn').style.display = 'none';
    }
  }

  // ---------- BOOT ----------

  document.addEventListener('DOMContentLoaded', init);

  // Public API
  return {
    selectTemplate,
    goBack,
    handleGenerate,
    copyToClipboard,
    downloadCard,
    switchCaptionTab,
    viewHistoryItem,
    escapeHtml
  };

})();
