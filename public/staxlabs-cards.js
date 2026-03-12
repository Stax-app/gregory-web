/* ============================================================
   STAXLABS — Card Renderers
   Pure functions returning self-contained HTML strings
   with inline styles for html2canvas compatibility.
   ============================================================ */

const StaxCards = (() => {

  // Shared inline style constants
  const FONT = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";
  const BG = '#0A0A0A';
  const SURFACE = '#1A1A2E';
  const CARD_BG = '#16213E';
  const RED = '#E94560';
  const BLUE = '#0F3460';
  const WHITE = '#FFFFFF';
  const MUTED = '#8892B0';
  const GREEN = '#34D399';
  const RED_NEG = '#F87171';

  function watermark() {
    return `
      <div style="position:absolute;bottom:32px;left:0;right:0;display:flex;align-items:center;justify-content:center;gap:4px;">
        <span style="font-family:${FONT};font-size:14px;font-weight:900;letter-spacing:2px;color:${RED};">STAX</span>
        <span style="font-family:${FONT};font-size:14px;font-weight:900;letter-spacing:2px;color:${WHITE};">LABS</span>
      </div>
    `;
  }

  function cardShell(content, width = 1080, height = 1080) {
    return `
      <div style="width:${width}px;height:${height}px;background:${BG};font-family:${FONT};color:${WHITE};position:relative;overflow:hidden;padding:60px;">
        ${content}
        ${watermark()}
      </div>
    `;
  }

  // ---------- Weekly Recap ----------
  function renderWeeklyRecapCard(data) {
    const spChange = data.sp500_change || '+0.0%';
    const isPositive = !spChange.startsWith('-');
    const changeColor = isPositive ? GREEN : RED_NEG;

    const sectorsHtml = (data.top_sectors || []).slice(0, 3).map(s => {
      const pct = Math.min(Math.abs(parseFloat(s.change) || 0) * 10, 100);
      const sColor = (parseFloat(s.change) || 0) >= 0 ? GREEN : RED_NEG;
      return `
        <div style="margin-bottom:16px;">
          <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
            <span style="font-size:16px;font-weight:600;color:${WHITE};">${escapeHtml(s.name || 'Sector')}</span>
            <span style="font-size:16px;font-weight:700;color:${sColor};">${escapeHtml(s.change || '0%')}</span>
          </div>
          <div style="background:${SURFACE};border-radius:4px;height:8px;overflow:hidden;">
            <div style="width:${pct}%;height:100%;background:${sColor};border-radius:4px;"></div>
          </div>
        </div>
      `;
    }).join('');

    const moversHtml = (list, positive) => (list || []).slice(0, 3).map(m => `
      <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(136,146,176,0.1);">
        <span style="font-size:15px;font-weight:600;color:${WHITE};">${escapeHtml(m.symbol || m.ticker || '')}</span>
        <span style="font-size:15px;font-weight:700;color:${positive ? GREEN : RED_NEG};">${escapeHtml(m.change || '')}</span>
      </div>
    `).join('');

    const content = `
      <div style="margin-bottom:12px;">
        <span style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:${RED};">Weekly Market Recap</span>
      </div>
      <div style="font-size:14px;color:${MUTED};margin-bottom:24px;">${escapeHtml(data.week_label || 'This Week')}</div>
      <div style="margin-bottom:32px;">
        <div style="font-size:14px;color:${MUTED};margin-bottom:4px;">S&P 500</div>
        <div style="font-size:72px;font-weight:900;color:${changeColor};line-height:1;">${escapeHtml(spChange)}</div>
      </div>
      <div style="margin-bottom:28px;">
        <div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:${MUTED};margin-bottom:12px;">Top Sectors</div>
        ${sectorsHtml}
      </div>
      <div style="display:flex;gap:32px;margin-bottom:28px;">
        <div style="flex:1;">
          <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:${GREEN};margin-bottom:8px;">Gainers</div>
          ${moversHtml(data.top_gainers, true)}
        </div>
        <div style="flex:1;">
          <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:${RED_NEG};margin-bottom:8px;">Losers</div>
          ${moversHtml(data.top_losers, false)}
        </div>
      </div>
      ${data.takeaway ? `
        <div style="background:${CARD_BG};border-left:3px solid ${RED};border-radius:0 8px 8px 0;padding:16px;margin-bottom:24px;">
          <div style="font-size:12px;font-weight:700;text-transform:uppercase;color:${RED};margin-bottom:6px;">Key Takeaway</div>
          <div style="font-size:14px;color:${WHITE};line-height:1.5;">${escapeHtml(data.takeaway)}</div>
        </div>
      ` : ''}
    `;
    return cardShell(content);
  }

  // ---------- Top Movers ----------
  function renderTopMoversCard(data, type) {
    const isGainers = type === 'gainers';
    const accentColor = isGainers ? GREEN : RED_NEG;
    const title = isGainers ? 'Top Gainers' : 'Top Losers';
    const arrow = isGainers
      ? '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>'
      : '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/></svg>';

    const items = (data.movers || data.items || []).slice(0, 5);
    const listHtml = items.map((m, i) => `
      <div style="display:flex;align-items:center;gap:16px;padding:20px 0;${i < items.length - 1 ? `border-bottom:1px solid rgba(136,146,176,0.08);` : ''}">
        <div style="width:48px;height:48px;border-radius:12px;background:${SURFACE};display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:900;color:${accentColor};">${i + 1}</div>
        <div style="flex:1;">
          <div style="font-size:20px;font-weight:800;color:${WHITE};margin-bottom:2px;">${escapeHtml(m.symbol || m.ticker || '')}</div>
          <div style="font-size:13px;color:${MUTED};">${escapeHtml(m.name || m.company || '')}</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:24px;font-weight:900;color:${accentColor};">${escapeHtml(m.change || m.change_pct || '')}</div>
        </div>
      </div>
    `).join('');

    const content = `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
        <div style="color:${accentColor};">${arrow}</div>
        <span style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:${RED};">Today's ${title}</span>
      </div>
      <div style="font-size:14px;color:${MUTED};margin-bottom:32px;">${escapeHtml(data.date || new Date().toLocaleDateString())}</div>
      <div>${listHtml}</div>
    `;
    return cardShell(content);
  }

  // ---------- Core4 Score ----------
  function renderCore4ScoreCard(cardData) {
    const scores = [
      { label: 'Performance', key: 'performance', color: '#818CF8' },
      { label: 'Value', key: 'value', color: GREEN },
      { label: 'Stability', key: 'stability', color: '#FBBF24' },
      { label: 'Momentum', key: 'momentum', color: RED },
    ];

    const barsHtml = scores.map(s => {
      const val = cardData[s.key] || cardData.scores?.[s.key] || 0;
      const pct = Math.min(Math.max(val, 0), 100);
      return `
        <div style="margin-bottom:20px;">
          <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
            <span style="font-size:14px;font-weight:600;color:${MUTED};">${s.label}</span>
            <span style="font-size:14px;font-weight:800;color:${s.color};">${pct}</span>
          </div>
          <div style="background:${SURFACE};border-radius:6px;height:12px;overflow:hidden;">
            <div style="width:${pct}%;height:100%;background:${s.color};border-radius:6px;"></div>
          </div>
        </div>
      `;
    }).join('');

    const overall = cardData.overall || cardData.scores?.overall || 0;
    const rating = overall >= 80 ? 'Strong Buy' : overall >= 60 ? 'Buy' : overall >= 40 ? 'Hold' : 'Sell';
    const ratingColor = overall >= 80 ? GREEN : overall >= 60 ? '#818CF8' : overall >= 40 ? '#FBBF24' : RED_NEG;

    const content = `
      <div style="margin-bottom:12px;">
        <span style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:${RED};">Core4 Score</span>
      </div>
      <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:4px;">
        <span style="font-size:48px;font-weight:900;color:${WHITE};">${escapeHtml(cardData.symbol || cardData.ticker || '')}</span>
        <span style="font-size:18px;font-weight:500;color:${MUTED};">${escapeHtml(cardData.name || '')}</span>
      </div>
      <div style="font-size:28px;font-weight:700;color:${WHITE};margin-bottom:36px;">${escapeHtml(cardData.price || '')}</div>
      ${barsHtml}
      <div style="display:flex;align-items:center;justify-content:center;gap:16px;margin-top:32px;">
        <div style="width:80px;height:80px;border-radius:50%;background:${CARD_BG};border:3px solid ${ratingColor};display:flex;align-items:center;justify-content:center;">
          <span style="font-size:28px;font-weight:900;color:${ratingColor};">${overall}</span>
        </div>
        <div>
          <div style="font-size:24px;font-weight:800;color:${ratingColor};">${rating}</div>
          <div style="font-size:13px;color:${MUTED};">Overall Rating</div>
        </div>
      </div>
    `;
    return cardShell(content);
  }

  // ---------- Hedge Fund Intel ----------
  function renderHedgeFundSlide(data, slideIndex) {
    const fund = data.funds?.[slideIndex] || data;
    const fundName = fund.fund_name || fund.name || 'Fund';

    const renderList = (items, label, color) => {
      if (!items || !items.length) return '';
      return `
        <div style="margin-bottom:24px;">
          <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:${color};margin-bottom:12px;">${label}</div>
          ${items.slice(0, 5).map(item => `
            <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(136,146,176,0.08);">
              <div>
                <span style="font-size:16px;font-weight:700;color:${WHITE};">${escapeHtml(item.symbol || item.ticker || '')}</span>
                <span style="font-size:13px;color:${MUTED};margin-left:8px;">${escapeHtml(item.name || '')}</span>
              </div>
              <span style="font-size:14px;font-weight:700;color:${color};">${escapeHtml(item.value || item.change || '')}</span>
            </div>
          `).join('')}
        </div>
      `;
    };

    const content = `
      <div style="margin-bottom:12px;">
        <span style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:${RED};">Hedge Fund Intel</span>
      </div>
      <div style="font-size:36px;font-weight:900;color:${WHITE};margin-bottom:8px;">${escapeHtml(fundName)}</div>
      <div style="font-size:14px;color:${MUTED};margin-bottom:36px;">Latest 13F Filing</div>
      ${renderList(fund.buys || fund.new_positions, 'New Buys', GREEN)}
      ${renderList(fund.sells || fund.closed_positions, 'Sells / Exits', RED_NEG)}
    `;
    return cardShell(content);
  }

  // ---------- User Shareable ----------
  function renderUserShareableCard(data) {
    const typeLabel = (data.achievement_type || 'milestone').toUpperCase();
    const typeColors = { MILESTONE: '#818CF8', STREAK: '#FBBF24', RETURNS: GREEN };
    const typeColor = typeColors[typeLabel] || RED;

    const content = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;text-align:center;padding-bottom:60px;">
        <div style="background:${CARD_BG};border:2px solid ${typeColor};border-radius:12px;padding:8px 20px;margin-bottom:32px;">
          <span style="font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:2px;color:${typeColor};">${escapeHtml(typeLabel)}</span>
        </div>
        <div style="font-size:22px;font-weight:600;color:${MUTED};margin-bottom:16px;">${escapeHtml(data.headline || data.title || 'Achievement Unlocked')}</div>
        <div style="font-size:80px;font-weight:900;color:${WHITE};line-height:1;margin-bottom:20px;">${escapeHtml(data.stat || data.value || '')}</div>
        <div style="font-size:16px;color:${MUTED};max-width:600px;line-height:1.5;">${escapeHtml(data.subtext || data.description || '')}</div>
      </div>
    `;
    return cardShell(content);
  }

  // ---------- Strategy Spotlight ----------
  function renderStrategyCard(data) {
    const metrics = [
      { label: 'Total Return', value: data.total_return || data.return_pct || 'N/A', color: GREEN },
      { label: 'Sharpe Ratio', value: data.sharpe || data.sharpe_ratio || 'N/A', color: '#818CF8' },
      { label: 'Max Drawdown', value: data.drawdown || data.max_drawdown || 'N/A', color: RED_NEG },
      { label: 'Win Rate', value: data.win_rate || 'N/A', color: '#FBBF24' },
    ];

    const metricsHtml = metrics.map(m => `
      <div style="background:${CARD_BG};border-radius:12px;padding:24px;text-align:center;">
        <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:${MUTED};margin-bottom:10px;">${m.label}</div>
        <div style="font-size:32px;font-weight:900;color:${m.color};">${escapeHtml(String(m.value))}</div>
      </div>
    `).join('');

    const content = `
      <div style="margin-bottom:12px;">
        <span style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:${RED};">Strategy Spotlight</span>
      </div>
      <div style="font-size:40px;font-weight:900;color:${WHITE};margin-bottom:8px;line-height:1.1;">${escapeHtml(data.strategy_name || data.name || 'Strategy')}</div>
      <div style="font-size:14px;color:${MUTED};margin-bottom:40px;">${escapeHtml(data.period || data.backtest_period || '')}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:36px;">
        ${metricsHtml}
      </div>
      ${data.insight || data.key_insight ? `
        <div style="background:${CARD_BG};border-left:3px solid ${RED};border-radius:0 8px 8px 0;padding:20px;">
          <div style="font-size:12px;font-weight:700;text-transform:uppercase;color:${RED};margin-bottom:8px;">Key Insight</div>
          <div style="font-size:15px;color:${WHITE};line-height:1.6;">${escapeHtml(data.insight || data.key_insight)}</div>
        </div>
      ` : ''}
    `;
    return cardShell(content);
  }

  // ---------- Utility ----------
  function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
  }

  return {
    renderWeeklyRecapCard,
    renderTopMoversCard,
    renderCore4ScoreCard,
    renderHedgeFundSlide,
    renderUserShareableCard,
    renderStrategyCard,
    escapeHtml
  };
})();
