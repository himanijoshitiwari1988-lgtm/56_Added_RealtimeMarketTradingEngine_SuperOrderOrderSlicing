/* Dhan Algo - Final Strategy (Paper Trade tab, bottom section)
 *
 * A global "Final Strategy" panel that automatically collects the BEST
 * performing strategies from the Strategy Container (which aggregates the
 * paper trades taken by the Pooled Strategy Runner, the Strategy Container
 * itself, and the AI Smart Trading paper engine) and keeps them saved.
 *
 * Qualification: a strategy with at least one paper trade is ranked by a
 * composite performance score that balances win rate (40%), average profit
 * per trade (30%) and overall net P&L (30%); the top N make it into the
 * Final Strategy section automatically and stay there (persisted) until the
 * user removes them.
 *
 * Each row shows a manual selection checkbox, a Select All button, Remove
 * Selected / Remove All buttons, the strategy's live performance stats, and
 * its SL / Trail SL / TP / AI Smart engine settings - exactly the settings
 * that were applied while the strategy was running (captured by the AST
 * engine at import + entry time in a per-strategy settings snapshot).
 *
 * Performance: the scan runs on the container's cached stats (O(n) over the
 * ledger, sub-millisecond), computes the composite score in a single pass and
 * only re-renders when the leaderboard actually changed, so the auto-refresh
 * never perturbs the live HFT/poll loops.
 */
(function () {
  'use strict';
  if (window.FinalStrategy) return; // idempotent

  const STORE_KEY = 'algodhan_final_strategy_v1';
  const TOP_N = 10;            // how many top performers the section keeps
  const MIN_TRADES = 1;        // a strategy must have taken at least this many paper trades
  const SCAN_MS = 8000;        // auto-rescan cadence (cheap, cached stats only)

  const $id = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt2 = n => (n === null || n === undefined || isNaN(n)) ? '--' : Number(n).toFixed(2);
  const fmtPct = n => (n === null || n === undefined || isNaN(n)) ? '--' : Number(n).toFixed(1) + '%';
  const fmtMoney = n => (n === null || n === undefined || isNaN(n)) ? '--' : '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtMoneySigned = n => {
    if (n === null || n === undefined || isNaN(n)) return '--';
    const v = Number(n);
    return (v >= 0 ? '+' : '') + fmtMoney(v);
  };

  /* ---------------- persistence ---------------- */
  let store = load();
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (s && s.v === 1 && Array.isArray(s.strategies)) {
        return { v: 1, strategies: s.strategies, excluded: (s.excluded && typeof s.excluded === 'object') ? s.excluded : {}, updatedAt: s.updatedAt || 0 };
      }
    } catch (e) {}
    return { v: 1, strategies: [], excluded: {}, updatedAt: 0 };
  }
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ v: 1, strategies: store.strategies, excluded: store.excluded, updatedAt: store.updatedAt }));
    } catch (e) {}
  }

  /* ---------------- AST helpers ---------------- */
  function astState() {
    try {
      if (window.AISmartTrading && typeof AISmartTrading.getState === 'function') return AISmartTrading.getState();
    } catch (e) {}
    return null;
  }
  function astSnapshotFor(id) {
    if (!id) return null;
    try {
      const st = astState();
      if (!st) return null;
      if (st.settingsSnapshots && st.settingsSnapshots[id]) return st.settingsSnapshots[id];
      if (window.AISmartTrading && typeof AISmartTrading.getSettingsSnapshot === 'function') {
        const s = AISmartTrading.getSettingsSnapshot(id);
        if (s) return s;
      }
    } catch (e) {}
    return null;
  }

  /* Map a Strategy Container stats entry to the AST strategy id that ran it,
     so we can fetch its captured run settings. Paper-origin strategies carry
     the tplKey that the AST engine imports as 'pt:<key>'; auto (AE) strategies
     are matched by aeKey / name / id across the AST lists and saved library. */
  function astIdFor(st) {
    const strat = (st && st.strat) || {};
    if (strat.paper === true && strat.key) return 'pt:' + strat.key;
    const st2 = astState();
    const lists = [];
    if (st2) {
      if (Array.isArray(st2.imported)) lists.push.apply(lists, st2.imported);
      if (Array.isArray(st2.manual)) lists.push.apply(lists, st2.manual);
      if (Array.isArray(st2.aiPicks)) lists.push.apply(lists, st2.aiPicks);
    }
    try {
      const saved = JSON.parse(localStorage.getItem('algodhan_strategies_v1') || '[]');
      if (Array.isArray(saved)) lists.push.apply(lists, saved);
    } catch (e) {}
    let hit = null;
    if (strat.aeKey != null) {
      for (let i = 0; i < lists.length; i++) {
        if (lists[i] && lists[i].aeKey != null && String(lists[i].aeKey) === String(strat.aeKey)) { hit = lists[i]; break; }
      }
    }
    if (!hit && strat.id != null) {
      for (let i = 0; i < lists.length; i++) {
        if (lists[i] && lists[i].id != null && String(lists[i].id) === String(strat.id)) { hit = lists[i]; break; }
      }
    }
    if (!hit) {
      const name = String(strat.name || '').toLowerCase();
      const cat = strat.cat === 'bearish' ? 'bearish' : 'bullish';
      if (name) {
        for (let i = 0; i < lists.length; i++) {
          const s = lists[i];
          if (!s) continue;
          const scat = s.cat === 'bearish' ? 'bearish' : 'bullish';
          if (scat === cat && String(s.name || '').toLowerCase() === name) { hit = s; break; }
        }
      }
    }
    return hit ? hit.id : null;
  }

  /* ---------------- settings summarisation ---------------- */
  function summarizeSettings(snap) {
    const settings = (snap && snap.settings) ? snap.settings : snap;
    if (!settings) return null;
    const u = settings.universal || {};
    const slParts = [];
    if (u.manualSL === true) slParts.push('Overall SL ' + (Number(u.manualSLPct) || 0) + '%');
    if (u.manualTrailSL === true) slParts.push('Trail SL ' + (Number(u.manualTrailSLPct) || 0) + '%');
    if (!slParts.length && u.aiSl !== false) slParts.push('AI SL (auto)');
    const tpParts = [];
    if (u.manualTP === true) tpParts.push('Manual TP ' + (Number(u.manualTPPct) || 0) + '%');
    if (u.manualTrailTP === true) tpParts.push('Manual Trail TP ' + (Number(u.manualTrailTPPct) || 0) + '%');
    if (u.aiTP === true) tpParts.push('AI TP (auto)');
    if (u.aiTp !== false && u.manualTrailTP !== true) tpParts.push('AI Trail TP ' + (Number(u.tpPct) != null ? Number(u.tpPct) : 1) + '%');
    const tfs = Object.keys(u.tfs || {}).filter(k => u.tfs[k]).join(' / ') || '5min';
    const strike = settings.strike || {};
    const runIn = settings.runIn || {};
    const tradeIn = settings.tradeIn || {};
    return {
      sl: slParts.length ? slParts.join(' + ') : '--',
      tp: tpParts.length ? tpParts.join(' + ') : '--',
      lots: (u.lots != null && u.lots !== '') ? u.lots : '--',
      margin: (u.margin != null && u.margin !== '') ? fmtMoney(u.margin) : '--',
      tfs: tfs,
      hft: !!u.hft,
      hftOps: (u.hftOps != null) ? u.hftOps : '--',
      hftExecOn: u.hftExecOn || 'close',
      fnoLimit: !!u.fnoLimit,
      strike: strike.mode || '--',
      strikeCount: strike.count != null ? strike.count : '--',
      optionType: strike.optionType || 'both',
      positiveOnly: strike.positiveOnly !== false,
      runIn: runIn.index || '--',
      tradeIn: tradeIn.index || '--',
      premiumOnly: !!settings.premiumOnly,
      filterCount: settings.filters ? Object.keys(settings.filters).filter(k => settings.filters[k] === true).length : 0,
      capturedAt: snap ? (snap.capturedAt || settings.capturedAt) : (settings.capturedAt || null)
    };
  }

  /* Resolve + summarise the run settings for a container stats entry. */
  function resolveSettingsFor(st) {
    const id = astIdFor(st);
    const snap = id ? astSnapshotFor(id) : null;
    if (!snap) return null;
    const sum = summarizeSettings(snap);
    if (sum) sum.astId = id;
    return sum;
  }

  /* Resolve the RAW AST engine-settings snapshot captured while the strategy
     was running (the exact SL / trail SL / TP / timeframes / run-in settings),
     so a saved Final Strategy can be re-run with its original settings - the
     same way the AE -> AST import captures the engine settings at entry time. */
  function resolveSnapshotFor(st) {
    const id = astIdFor(st);
    if (!id) return null;
    const snap = astSnapshotFor(id);
    if (!snap) return null;
    try { return JSON.parse(JSON.stringify(snap)); } catch (e) { return null; }
  }

  /* ---------------- composite score ---------------- */
  function compositeScore(s, maxes) {
    const win = Math.max(0, Math.min(100, Number(s.winRate) || 0));
    const avgN = maxes.maxAvg > 0 ? (Math.max(0, Number(s.avgPerTrade) || 0) / maxes.maxAvg) * 100 : 0;
    const netN = maxes.maxNet > 0 ? (Math.max(0, Number(s.totalNet) || 0) / maxes.maxNet) * 100 : 0;
    return Math.round((win * 0.4 + avgN * 0.3 + netN * 0.3) * 100) / 100;
  }

  /* Top-N candidates from the Strategy Container stats (the aggregated paper
     performance of every strategy that ran through the pooled runner, the
     container itself or the AST paper engine). */
  function candidates() {
    if (!window.StrategyContainer || typeof StrategyContainer.computeStats !== 'function') return [];
    let stats;
    try { stats = StrategyContainer.computeStats(); } catch (e) { return []; }
    if (!Array.isArray(stats)) return [];
    const traded = stats.filter(s => s && s.trades >= MIN_TRADES);
    if (!traded.length) return [];
    const maxes = { maxAvg: 0, maxNet: 0 };
    for (let i = 0; i < traded.length; i++) {
      const t = traded[i];
      if (Number(t.avgPerTrade) > maxes.maxAvg) maxes.maxAvg = Number(t.avgPerTrade);
      if (Number(t.totalNet) > maxes.maxNet) maxes.maxNet = Number(t.totalNet);
    }
    const scored = traded.map(s => ({ s: s, sc: compositeScore(s, maxes) }));
    scored.sort((a, b) => (b.sc - a.sc) || (b.s.winRate - a.s.winRate) || (b.s.totalNet - a.s.totalNet));
    return scored.slice(0, TOP_N);
  }

  /* ---------------- auto-discovery scan ---------------- */
  let _lastSig = '';
  function scan() {
    const host = $id('fsBody');
    const top = candidates();
    const now = Date.now();
    let changed = false;
    if (!top.length) {
      if (_lastSig !== 'empty') { _lastSig = 'empty'; changed = true; }
    } else {
      /* cheap signature: top keys + their stats -> only re-render on change */
      const sig = top.map(c =>
        c.s.key + ':' + c.s.trades + ':' + Math.round(c.s.winRate * 10) + ':' + Math.round((c.s.totalNet || 0) * 100) + ':' + Math.round((c.s.avgPerTrade || 0) * 100)
      ).join('|');
      const byKey = new Map(store.strategies.map(x => [x.key, x]));
      top.forEach(c => {
        const st = c.s;
        const strat = st.strat || {};
        const key = st.key;
        if (!key) return;
        if (store.excluded[key]) return;
        const existing = byKey.get(key);
        const stats = {
          trades: st.trades, wins: st.wins, losses: st.losses,
          winRate: Math.round(st.winRate * 10) / 10,
          totalNet: Math.round((st.totalNet || 0) * 100) / 100,
          avgPerTrade: Math.round((st.avgPerTrade || 0) * 100) / 100,
          daysTraded: st.daysTraded, lastDay: st.lastDay || null,
          profitFactor: st.profitFactor, score: c.sc
        };
        const settings = resolveSettingsFor(st);
        const snapshot = resolveSnapshotFor(st);
        const stratDef = JSON.parse(JSON.stringify(strat || {}));
        if (existing) {
          existing.stats = stats;
          existing.lastUpdated = now;
          if (settings) existing.settings = settings;
          else if (!existing.settings) existing.settings = null;
          if (snapshot) existing.snapshot = snapshot;
          if (stratDef && Object.keys(stratDef).length) existing.strategy = stratDef;
        } else {
          byKey.set(key, {
            key: key,
            name: (strat.name || 'Strategy').replace(/^AE:\s*/, ''),
            cat: strat.cat === 'bearish' ? 'bearish' : 'bullish',
            method: strat.method || '',
            tf: strat.tf || '',
            symbol: (strat.symbol && strat.symbol.name) || null,
            addedAt: now, lastUpdated: now,
            stats: stats,
            settings: settings || null,
            snapshot: snapshot || null,
            strategy: (stratDef && Object.keys(stratDef).length) ? stratDef : null,
            source: 'auto'
          });
        }
      });
      store.strategies = Array.from(byKey.values());
      store.strategies.sort((a, b) => (b.stats.score - a.stats.score) || (b.stats.winRate - a.stats.winRate));
      store.updatedAt = now;
      if (_lastSig !== sig) { _lastSig = sig; changed = true; }
    }
    if (changed) { save(); render(); }
    else if (host && !host.innerHTML) render();
  }

  /* ---------------- rendering ---------------- */
  const _sel = new Set();

  function sideBadge(cat) {
    return cat === 'bearish'
      ? '<span style="color:#ef5350;font-size:8px;border:1px solid #ef5350;border-radius:2px;padding:1px 4px;font-weight:700">BEARISH</span>'
      : '<span style="color:#00d4aa;font-size:8px;border:1px solid #00d4aa;border-radius:2px;padding:1px 4px;font-weight:700">BULLISH</span>';
  }

  function chip(label, value, color) {
    return '<span style="background:#1a1a35;border:1px solid #2d2d50;border-radius:3px;padding:1px 6px;font-size:8px;color:' + (color || '#ccc') + ';white-space:nowrap">' + esc(label) + ': <b>' + esc(value) + '</b></span>';
  }

  function detailsHTML(s) {
    const st = s.stats || {};
    const set = s.settings;
    if (!set) {
      return '<div style="font-size:9px;color:#888;padding:2px 0">No AI Smart run settings recorded for this strategy yet (it has not run through the AST engine).</div>';
    }
    const strike = set.strike || '--';
    const optTxt = set.optionType === 'both' ? 'CE & PE' : set.optionType;
    const pos = set.positiveOnly ? 'yes' : 'no';
    const runIn = set.runIn || '--';
    const tradeIn = set.tradeIn || '--';
    return '<div style="font-size:9px;line-height:1.8;color:#b0b0b0;background:#0e0e24;border:1px dashed #2d2d50;border-radius:4px;padding:6px 8px;margin-top:4px">' +
      '<div style="color:#66ccff;font-weight:700;margin-bottom:2px">AST engine settings applied while running</div>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:2px 14px">' +
        '<span>Stop-loss: <b style="color:#ff9800">' + esc(set.sl) + '</b></span>' +
        '<span>Take-profit: <b style="color:#00d4aa">' + esc(set.tp) + '</b></span>' +
        '<span>Lots: <b>' + esc(set.lots) + '</b></span>' +
        '<span>Margin: <b>' + esc(set.margin) + '</b></span>' +
        '<span>Timeframes: <b>' + esc(set.tfs) + '</b></span>' +
        '<span>HFT: <b>' + (set.hft ? 'ON (' + set.hftOps + '/s, ' + set.hftExecOn + ')' : 'OFF') + '</b></span>' +
        '<span>F&O Limit: <b>' + (set.fnoLimit ? 'ON' : 'OFF') + '</b></span>' +
        '<span>Strike: <b>' + esc(strike) + ' · ' + set.strikeCount + ' (' + esc(optTxt) + ')</b></span>' +
        '<span>Positive-only: <b>' + pos + '</b></span>' +
        '<span>Run-in: <b>' + esc(runIn) + '</b></span>' +
        '<span>Trade-in: <b>' + esc(tradeIn) + '</b></span>' +
        '<span>Premium-only: <b>' + (set.premiumOnly ? 'ON' : 'OFF') + '</b></span>' +
        '<span>Filters enabled: <b>' + set.filterCount + '</b></span>' +
        (set.capturedAt ? '<span>Captured: <b>' + new Date(set.capturedAt).toLocaleTimeString('en-IN') + '</b></span>' : '') +
      '</div>' +
      '<div style="font-size:8px;color:#666;margin-top:3px">Settings captured at import / paper-entry time by the AI Smart Trading engine (strategy id ' + esc(set.astId || '?') + ').</div>' +
    '</div>';
  }

  function rowHTML(s) {
    const st = s.stats || {};
    const set = s.settings;
    const meta = [s.method, s.tf, s.symbol].filter(Boolean).join(' · ');
    const wrCls = st.winRate >= 50 ? '#00d4aa' : (st.winRate > 0 ? '#ffd700' : '#666');
    const netCls = st.totalNet >= 0 ? '#26a69a' : '#ef5350';
    const checked = _sel.has(s.key) ? 'checked ' : '';
    const settingsChips = set
      ? chip('SL', set.sl, '#ff9800') + chip('TP', set.tp, '#00d4aa') + chip('Lots', set.lots) + chip('Margin', set.margin) + chip('TF', set.tfs)
      : '<span style="font-size:8px;color:#666">no run settings recorded</span>';
    const srcBadge = s.source && s.source !== 'auto'
      ? '<span style="font-size:8px;color:#b39ddb;border:1px solid #2d2d50;border-radius:3px;padding:0 4px">' + esc(s.source === 'container' ? 'Container' : (s.source === 'pooled' ? 'Pooled' : (s.source === 'ast' ? 'AST' : 'Manual'))) + '</span>'
      : '';
    return '<div style="background:#12122a;border:1px solid #2d2d50;border-radius:4px;padding:5px 8px;margin:2px 0;font-size:10px" data-fs-row="' + esc(s.key) + '">' +
      '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">' +
        '<input type="checkbox" class="fs-sel" data-fs-key="' + esc(s.key) + '" ' + checked + 'title="Tick to select this strategy">' +
        sideBadge(s.cat) +
        '<span style="color:#fff;font-weight:700;flex:1;min-width:110px">' + esc(s.name) +
          (meta ? ' <span style="color:#666;font-weight:400;font-size:9px">· ' + esc(meta) + '</span>' : '') +
        '</span>' +
        srcBadge +
        '<span style="color:#888;font-size:9px">' + st.trades + ' <span style="color:#666">(' + st.wins + '/' + st.losses + ')</span></span>' +
        '<span style="color:' + wrCls + ';font-weight:700;min-width:44px;text-align:right">' + fmtPct(st.winRate) + '</span>' +
        '<span style="color:' + netCls + ';font-weight:700;min-width:80px;text-align:right">' + fmtMoneySigned(st.totalNet) + '</span>' +
        '<span style="color:' + netCls + ';min-width:80px;text-align:right">' + fmtMoneySigned(st.avgPerTrade) + '/tr</span>' +
        (st.lastDay ? '<span style="color:#888;font-size:8px">' + st.lastDay + '</span>' : '') +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin-top:3px">' + settingsChips +
        '<button data-fs-details="' + esc(s.key) + '" style="background:none;border:1px solid #66ccff;color:#66ccff;border-radius:3px;padding:1px 6px;font-size:8px;cursor:pointer">Settings details</button>' +
        '<button data-fs-run="' + esc(s.key) + '" title="Send this strategy to the AI Smart Trading engine and run it with its saved settings" style="background:#ffd700;border:none;color:#0a0a18;border-radius:3px;padding:1px 8px;font-size:8px;font-weight:700;cursor:pointer">Run</button>' +
        '<span style="margin-left:auto;font-size:8px;color:#666">score ' + (st.score != null ? st.score : '--') + '</span>' +
      '</div>' +
      '<div class="fs-details" data-fs-detail="' + esc(s.key) + '" style="display:none">' + detailsHTML(s) + '</div>' +
    '</div>';
  }

  function render() {
    const host = $id('fsBody');
    if (!host) return;
    const items = store.strategies.slice();
    if (!items.length) {
      host.innerHTML = '<div style="color:#666;font-size:10px;padding:6px 8px">No final strategies yet. The best performing strategies (highest win rate / average profit per trade / overall P&L) from the Strategy Container, Pooled Strategy Runner and AI Smart paper engine will appear here automatically once they have paper trades.</div>';
    } else {
      host.innerHTML = items.map(rowHTML).join('');
    }
    const cnt = $id('fsCount');
    if (cnt) cnt.textContent = items.length ? '(' + items.length + ')' : '';
    syncSelCount();
    const stat = $id('fsStatus');
    if (stat) stat.textContent = items.length
      ? 'Top ' + TOP_N + ' performers auto-saved from Paper Trade / Strategy Container / Pooled Strategy Runner (composite: win rate 40% + avg/trade 30% + net P&L 30%) · auto-updates every ' + (SCAN_MS / 1000) + 's'
      : 'Waiting for paper trades&hellip;';
  }

  function syncSelCount() {
    const cnt = $id('fsSelCount');
    if (cnt) cnt.textContent = _sel.size + ' selected';
    const all = $id('fsSelAll');
    if (all) {
      const host = $id('fsBody');
      const boxes = host ? host.querySelectorAll('.fs-sel') : [];
      all.checked = boxes.length > 0 && Array.from(boxes).every(cb => cb.checked);
    }
  }

  function bindEvents() {
    const host = $id('fsBody');
    if (!host || host.getAttribute('data-fs-bound')) return;
    host.setAttribute('data-fs-bound', '1');
    host.addEventListener('change', e => {
      const cb = e.target;
      if (cb && cb.classList.contains('fs-sel') && cb.hasAttribute('data-fs-key')) {
        const key = cb.getAttribute('data-fs-key');
        if (cb.checked) _sel.add(key); else _sel.delete(key);
        syncSelCount();
      }
    });
    host.addEventListener('click', e => {
      const btn = e.target && e.target.closest ? e.target.closest('[data-fs-details]') : null;
      if (btn) {
        const key = btn.getAttribute('data-fs-details');
        const hostEl = btn.closest('[data-fs-row]');
        const detail = hostEl ? hostEl.querySelector('.fs-details') : null;
        if (detail) detail.style.display = detail.style.display === 'none' ? 'block' : 'none';
        return;
      }
      const runBtn = e.target && e.target.closest ? e.target.closest('[data-fs-run]') : null;
      if (runBtn) {
        const key = runBtn.getAttribute('data-fs-run');
        runStrategy(key);
      }
    });
  }

  /* ---------------- actions ---------------- */
  function toggleSelectAll(el) {
    const want = !!(el && el.checked);
    const host = $id('fsBody');
    if (host) {
      host.querySelectorAll('.fs-sel').forEach(cb => {
        cb.checked = want;
        const key = cb.getAttribute('data-fs-key');
        if (key) { if (want) _sel.add(key); else _sel.delete(key); }
      });
    }
    syncSelCount();
  }

  function removeSelected() {
    if (!_sel.size) return;
    store.strategies = store.strategies.filter(s => !_sel.has(s.key));
    _sel.forEach(k => { store.excluded[k] = Date.now(); });
    _sel.clear();
    _lastSig = '';
    save();
    render();
  }

  function removeAll() {
    store.strategies = [];
    store.excluded = {};
    _sel.clear();
    _lastSig = '';
    save();
    render();
  }

  /* ---------------- manual save (Send to Final Strategy) ---------------- */
  /* Save an explicitly chosen strategy (from the Strategy Container, Pooled
     Strategy Runner or AST engine) into the Final Strategy section. The entry
     carries the strategy definition + its raw engine-settings snapshot so it can
     be re-run later with its ORIGINAL settings (SL / trail SL / TP / timeframes
     / run-in) - exactly the AE -> AST pattern. */
  function saveStrategy(payload) {
    if (!payload || !payload.key) return null;
    const now = Date.now();
    const strat = payload.strategy || {};
    const byKey = new Map(store.strategies.map(x => [x.key, x]));
    const existing = byKey.get(payload.key);
    const stats = payload.stats || (existing ? existing.stats : {});
    let settings = payload.settings || null;
    let snapshot = payload.snapshot || null;
    if (!settings && snapshot) settings = summarizeSettings(snapshot);
    const entry = existing || {};
    entry.key = payload.key;
    entry.name = payload.name || (strat.name || 'Strategy').replace(/^AE:\s*/, '');
    entry.cat = (payload.cat || strat.cat || 'bullish') === 'bearish' ? 'bearish' : 'bullish';
    entry.method = payload.method || strat.method || '';
    entry.tf = payload.tf || strat.tf || '';
    entry.symbol = payload.symbol || (strat.symbol && strat.symbol.name) || null;
    entry.addedAt = entry.addedAt || now;
    entry.lastUpdated = now;
    entry.stats = stats;
    if (settings) entry.settings = settings;
    if (snapshot) entry.snapshot = snapshot;
    if (strat && Object.keys(strat).length) entry.strategy = JSON.parse(JSON.stringify(strat));
    entry.source = payload.source || 'manual';
    delete store.excluded[payload.key];
    byKey.set(payload.key, entry);
    store.strategies = Array.from(byKey.values());
    store.strategies.sort((a, b) => (b.stats.score - a.stats.score) || (b.stats.winRate - a.stats.winRate));
    store.updatedAt = now;
    save();
    render();
    return entry;
  }

  /* Run a saved Final Strategy in the AI Smart Trading engine with its ORIGINAL
     settings: apply the captured engine-settings snapshot, then import the
     strategy definition the same way the AE engine hands a strategy to AST
     (importFromPaperTrade), which enables + ticks it. */
  function runStrategy(key) {
    const entry = store.strategies.find(x => x.key === key);
    if (!entry) return false;
    const AST = window.AISmartTrading;
    if (!AST || typeof AST.importFromPaperTrade !== 'function') {
      alert('AI Smart Trading engine not ready yet.');
      return false;
    }
    const strat = entry.strategy || {};
    if (entry.snapshot && typeof AST.applySnapshot === 'function') {
      try { AST.applySnapshot(JSON.parse(JSON.stringify(entry.snapshot))); } catch (e) {}
    }
    const payload = [{
      key: strat.key || strat.aeKey || ('fs:' + key),
      name: entry.name || strat.name || 'Final Strategy',
      cat: entry.cat || strat.cat || 'bullish',
      method: strat.method || entry.method || '',
      tf: strat.tf || entry.tf || '5min',
      score: strat.score || 0,
      verdict: strat.verdict || 'Moderate',
      entry: strat.entry || null,
      exit: strat.exit || null,
      entryExtra: strat.entryExtra || null,
      exitExtra: strat.exitExtra || null,
      entryThreshold: strat.entryThreshold != null ? strat.entryThreshold : null,
      candlestick: strat.candlestick || { enabled: false, entry: [], exit: [] },
      refSlPct: (strat.refSlPct != null) ? strat.refSlPct : (strat.autoSlPct != null ? strat.autoSlPct : null),
      refTrailSlPct: (strat.refTrailSlPct != null) ? strat.refTrailSlPct : null
    }];
    let n = 0;
    try { n = AST.importFromPaperTrade(payload); } catch (e) {}
    if (n > 0) {
      if (typeof switchTab === 'function') {
        try { switchTab('papertrade', document.querySelector('[data-tab="papertrade"]')); } catch (e) {}
      }
    } else {
      alert('Strategy could not be imported into the AI Smart Trading engine (it may already be running).');
    }
    return n > 0;
  }

  /* Save a strategy from the Strategy Container (by its identity key) into the
     Final Strategy section. Resolves the container's aggregated stats + the AST
     settings snapshot captured while it ran. */
  function saveFromContainer(key) {
    if (!key) return null;
    if (!window.StrategyContainer || typeof StrategyContainer.computeStats !== 'function') {
      alert('Strategy Container not ready yet.');
      return null;
    }
    let st = null;
    try { st = StrategyContainer.computeStats().find(x => x.key === key) || null; } catch (e) { st = null; }
    if (!st) return null;
    const strat = st.strat || {};
    const snapshot = resolveSnapshotFor(st);
    const settings = resolveSettingsFor(st);
    return saveStrategy({
      key: key,
      name: (strat.name || 'Strategy').replace(/^AE:\s*/, ''),
      cat: strat.cat === 'bearish' ? 'bearish' : 'bullish',
      method: strat.method || '',
      tf: strat.tf || '',
      symbol: (strat.symbol && strat.symbol.name) || null,
      stats: {
        trades: st.trades, wins: st.wins, losses: st.losses,
        winRate: Math.round(st.winRate * 10) / 10,
        totalNet: Math.round((st.totalNet || 0) * 100) / 100,
        avgPerTrade: Math.round((st.avgPerTrade || 0) * 100) / 100,
        daysTraded: st.daysTraded, lastDay: st.lastDay || null,
        profitFactor: st.profitFactor
      },
      settings: settings || null,
      snapshot: snapshot || null,
      strategy: JSON.parse(JSON.stringify(strat || {})),
      source: 'container'
    });
  }

  /* ---------------- public API ---------------- */
  const api = {
    scan: scan,
    render: render,
    toggleSelectAll: toggleSelectAll,
    removeSelected: removeSelected,
    removeAll: removeAll,
    saveStrategy: saveStrategy,
    runStrategy: runStrategy,
    saveFromContainer: saveFromContainer,
    getState: function () { return store; }
  };
  window.FinalStrategy = api;

  /* Boot: bind + first scan on DOM ready (idempotent), then keep the
     leaderboard fresh on the auto-scan cadence and on strategy imports. */
  function boot() {
    if (window.FinalStrategy._booted) return;
    window.FinalStrategy._booted = true;
    const run = function () { try { bindEvents(); scan(); } catch (e) {} };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', run);
    } else {
      run();
    }
    try {
      window.setInterval(function () { try { scan(); } catch (e) {} }, SCAN_MS);
    } catch (e) {}
    try {
      window.addEventListener('strategies-imported', function () { try { scan(); } catch (e) {} });
    } catch (e) {}
    try {
      if (window.StrategyContainer && typeof StrategyContainer.recordTrade === 'function') {
        const orig = StrategyContainer.recordTrade;
        StrategyContainer.recordTrade = function () {
          const r = orig.apply(this, arguments);
          try { scan(); } catch (e) {}
          return r;
        };
      }
    } catch (e) {}
  }
  if (typeof window !== 'undefined' && typeof document !== 'undefined') boot();
})();
