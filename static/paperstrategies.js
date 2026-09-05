/* Dhan Algo - Paper Trade Strategy Lists (Bullish / Bearish)
 *
 * The staging area for strategies created by the Auto Experiment engine.
 * Pressing "Send to Paper Trade" in the Auto Experiment tab (or the experiment
 * auto-sender) lands the created strategies here first, grouped into the
 * Bullish (CE) and Bearish (PE) lists.
 *
 * From these lists the strategies are handed to the AI Smart Trading engine:
 *   - automatically, when the "Auto send to AST" switch is on (newly arrived
 *     strategies are imported into AST immediately), or
 *   - manually, by ticking strategies in either list and pressing the single
 *     "Send selected to AST" button - the one button sends whatever is ticked
 *     in whichever list.
 *
 * Strategies that already live in AST show a SENT badge; ones AST is currently
 * running show a RUNNING badge. Once AST runs paper trading, executed trades
 * appear in the Running Strategies / Running Trades lists below. The staged
 * list is persisted in localStorage so it survives a reload.
 */
window.createPaperStrategies = function (suffix) {
  'use strict';
  suffix = suffix || '';

  const STORE_KEY = 'algodhan_paperstrategies_v1';
  const AUTO_KEY = 'algodhan_paperstrategies_auto_v1';

  const $id = id => document.getElementById(id + suffix) || document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* Show a message in the Strategy Lists status line (self-contained - the
     shared paper log panel no longer exists, so this section shows its own). */
  function log(msg, cls) {
    const el = $id('psStatus');
    if (el) {
      el.textContent = String(msg);
      el.style.color = cls === 'ok' ? '#00d4aa' : (cls === 'warn' ? '#ff9800' : '#888');
    }
    if (typeof console !== 'undefined' && console.log) console.log('[PaperStrategies] ' + msg);
  }

  /* ---------------- persisted staging store ---------------- */

  function loadStore() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return [];
      const o = JSON.parse(raw);
      const items = (o && Array.isArray(o.items)) ? o.items : [];
      /* Auto-purge duplicate strategies (same key) so the Bullish / Bearish
         lists never show the same strategy twice. Prefers the copy that was
         already sent to AST, then the newest; cleans the persisted store on
         every read so stale duplicates are removed automatically. */
      const deduped = dedupeItems(items);
      if (deduped.length !== items.length) saveStore(deduped);
      return deduped;
    } catch (e) { return []; }
  }

  function saveStore(items) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ v: 1, items: items || [] })); } catch (e) {}
  }

  /* Collapse a list of staged strategies to one copy per key. The surviving
     copy is the one most ready to trade: sent to AST beats pending, and among
     equal sent-state the newest addedAt wins (a refresh replaces the stale
     definition with the latest version of the same strategy). Entries without
     a key are kept as-is. */
  function dedupeItems(items) {
    if (!Array.isArray(items)) return items || [];
    const best = new Map();
    const rank = s => (s && s.sentAt ? 1 : 0) * 1e15 + (s && s.addedAt ? s.addedAt : 0);
    items.forEach(s => {
      if (!s || s.key == null) return;
      const cur = best.get(s.key);
      if (!cur || rank(s) >= rank(cur)) best.set(s.key, s);
    });
    const seen = new Set();
    return items.filter(s => {
      if (!s || s.key == null) return true;
      if (seen.has(s.key)) return false;
      if (best.get(s.key) !== s) return false;
      seen.add(s.key);
      return true;
    });
  }

  /* ---------------- auto-send flag ---------------- */

  function getAuto() {
    try { return localStorage.getItem(AUTO_KEY) === '1'; } catch (e) { return false; }
  }

  function setAuto(v) {
    try { localStorage.setItem(AUTO_KEY, v ? '1' : '0'); } catch (e) {}
  }

  /* ---------------- AST side state ---------------- */

  function astImportedIds() {
    const e = window.AISmartTrading;
    const st = (e && e.getState) ? e.getState() : null;
    const set = new Set();
    if (st && Array.isArray(st.imported)) {
      st.imported.forEach(s => { if (s && s.id != null) set.add(String(s.id)); });
    }
    return set;
  }

  function astRunningIds() {
    const e = window.AISmartTrading;
    const set = new Set();
    if (e && e.runningStrategies) {
      try {
        (e.runningStrategies() || []).forEach(s => { if (s && s.id != null) set.add(String(s.id)); });
      } catch (err) {}
    }
    return set;
  }

  /* A strategy is "in AST" when its imported id ("pt:" + tplKey) exists in the
     AI Smart engine's imported list. */
  function astIdFor(key) {
    return 'pt:' + key;
  }

  /* ---------------- normalization ---------------- */

  /* Strip the AE backtest suffix ("2450 CE" / "24500 PE") from a strategy
     name before it lands in the Paper Trade lists / AST. The strike + CE/PE
     belong to the AE backtest leg - the AST engine runs on its own universe
     and the global "Run Strategy In" CE/PE control decides the side, so the
     label must not leak into the imported strategy. */
  function aeCleanName(n) {
    const raw = String(n == null ? '' : n);
    const s = raw.replace(/\s+\d+(?:\.\d+)?\s+(CE|PE)\s*$/i, '').trim();
    return s || raw;
  }

  /* Normalize a raw Auto Experiment result into the staged/import shape used by
     the AI Smart engine (the same field mapping the AE engine uses). FNO stock
     data (symbol/spot) is deliberately dropped - the Paper Trade lists carry
     the strategy only, not instrument info. The overall SL % / trail SL % and
     timeframe are kept as reference-only info for display; AST always runs on
     its own settings basis. */
  function normalizeResult(r) {
    if (!r) return null;
    return {
      key: r.tplKey || r.name,
      name: aeCleanName(r.name),
      cat: r.cat || 'bullish',
      method: r.method || '',
      tf: r.tf || '5min',
      score: r.score || 0,
      verdict: r.verdict || 'Moderate',
      entry: r.entry || null,
      exit: r.exit || null,
      entryExtra: r.entryExtra || null,
      exitExtra: r.exitExtra || null,
      entryThreshold: r.entryThreshold != null ? r.entryThreshold : null,
      candlestick: r.candlestick || { enabled: false, entry: [], exit: [] },
      refSlPct: (r.refSlPct != null) ? r.refSlPct : (r.autoSlPct != null ? r.autoSlPct : null),
      refTrailSlPct: (r.refTrailSlPct != null) ? r.refTrailSlPct : null,
      marginCap: (r.marginCap != null && isFinite(Number(r.marginCap)) && Number(r.marginCap) > 0) ? Number(r.marginCap) : null
    };
  }

  /* ---------------- selection ---------------- */

  const _sel = { bullish: new Set(), bearish: new Set() };

  function catOf(item) {
    return (item && item.cat === 'bearish') ? 'bearish' : 'bullish';
  }

  function selectionCount() {
    return _sel.bullish.size + _sel.bearish.size;
  }

  /* ---------------- staging ---------------- */

  /* Accept new strategies (raw Auto Experiment results, or already-normalized
     payloads) and land them in the staged lists, de-duplicated by template key.
     When the auto-send switch is on the newly arrived strategies are imported
     into the AI Smart engine right away. Returns the number added. */
  function addFromAE(list) {
    const items = loadStore();
    const have = new Set(items.map(x => x.key));
    const added = [];
    (Array.isArray(list) ? list : []).forEach(r => {
      const item = (r && r.tplKey != null) ? normalizeResult(r) : r;
      if (!item || !item.key) return;
      if (have.has(item.key)) return;
      have.add(item.key);
      const fresh = Object.assign({}, item, { addedAt: Date.now(), sentAt: null });
      items.push(fresh);
      added.push(fresh);
    });
    if (!added.length) return 0;
    saveStore(items);
    if (getAuto()) importToAst(added);
    render(true);
    return added.length;
  }

  function importToAst(items) {
    if (!window.AISmartTrading || !AISmartTrading.importFromPaperTrade) return 0;
    const payload = (items || []).map(s => ({
      key: s.key,
      name: aeCleanName(s.name),
      cat: s.cat || 'bullish',
      method: s.method || '',
      tf: s.tf || '5min',
      score: s.score || 0,
      verdict: s.verdict || 'Moderate',
      entry: s.entry || null,
      exit: s.exit || null,
      entryExtra: s.entryExtra || null,
      exitExtra: s.exitExtra || null,
      entryThreshold: s.entryThreshold != null ? s.entryThreshold : null,
      candlestick: s.candlestick || { enabled: false, entry: [], exit: [] },
      /* Reference-only info (overall SL % + trail SL %) so the Strategy
         Container can display what the AE engine used. AST execution ignores
         these - it runs on its own settings basis. */
      refSlPct: (s.refSlPct != null) ? s.refSlPct : (s.autoSlPct != null ? s.autoSlPct : null),
      refTrailSlPct: (s.refTrailSlPct != null) ? s.refTrailSlPct : null,
      marginCap: (s.marginCap != null && isFinite(Number(s.marginCap)) && Number(s.marginCap) > 0) ? Number(s.marginCap) : null
    })).filter(s => s && s.key);
    if (!payload.length) return 0;
    const n = AISmartTrading.importFromPaperTrade(payload);
    const now = Date.now();
    const store = loadStore();
    let changed = false;
    store.forEach(s => {
      if (payload.some(p => p.key === s.key) && !s.sentAt) { s.sentAt = now; changed = true; }
    });
    if (changed) saveStore(store);
    return n;
  }

  /* ---------------- actions ---------------- */

  function sendSelected() {
    const store = loadStore();
    const sel = new Set([..._sel.bullish, ..._sel.bearish]);
    const chosen = store.filter(s => sel.has(s.key));
    if (!chosen.length) {
      log('Tick at least one strategy in the Bullish or Bearish list to send it to AST', 'warn');
      return;
    }
    const n = importToAst(chosen);
    if (n) log('Sent ' + n + ' selected strategy(s) to the AI Smart Trading engine', 'ok');
    else log('Selected strategies are already in the AI Smart Trading engine', 'warn');
    if (window.StrategyContainer && StrategyContainer.refresh) {
      try { StrategyContainer.refresh(); } catch (e) {}
    }
    render(true);
  }

  function removeFromAst(key) {
    if (!window.AISmartTrading) return;
    const id = astIdFor(key);
    if (AISmartTrading.removeImported) { try { AISmartTrading.removeImported(id); } catch (e) {} }
    if (AISmartTrading.stopPosition) { try { AISmartTrading.stopPosition(id); } catch (e) {} }
  }

  function removeSelected() {
    const sel = new Set([..._sel.bullish, ..._sel.bearish]);
    const store = loadStore();
    const kept = store.filter(s => !sel.has(s.key));
    const removed = store.filter(s => sel.has(s.key));
    if (!removed.length) {
      log('Tick at least one strategy to remove it from the lists', 'warn');
      return;
    }
    removed.forEach(s => removeFromAst(s.key));
    saveStore(kept);
    _sel.bullish.clear();
    _sel.bearish.clear();
    log('Removed ' + removed.length + ' strategy(s) from the Paper Trade lists', 'warn');
    render(true);
  }

  function removeAll() {
    const store = loadStore();
    if (!store.length) {
      log('No strategies in the Paper Trade lists to remove', 'warn');
      return;
    }
    store.forEach(s => removeFromAst(s.key));
    saveStore([]);
    _sel.bullish.clear();
    _sel.bearish.clear();
    log('Removed all ' + store.length + ' strategy(s) from the Paper Trade lists', 'warn');
    render(true);
  }

  function toggleAuto() {
    const cb = $id('psAutoSend');
    const on = !!(cb && cb.checked);
    setAuto(on);
    if (on) {
      const store = loadStore();
      const pending = store.filter(s => !s.sentAt);
      if (pending.length) {
        const n = importToAst(pending);
        log('Auto send to AST on: sent ' + n + ' pending strategy(s) to the AI Smart Trading engine', 'ok');
      } else {
        log('Auto send to AST switched on', 'ok');
      }
      if (window.StrategyContainer && StrategyContainer.refresh) {
        try { StrategyContainer.refresh(); } catch (e) {}
      }
    } else {
      log('Auto send to AST switched off - strategies wait in the lists until sent manually', 'warn');
    }
    render(true);
  }

  /* ---------------- rendering ---------------- */

  function scoreColor(score) {
    return score >= 75 ? '#ffd700' : (score >= 60 ? '#00d4aa' : (score >= 45 ? '#ff9800' : '#888'));
  }

  function badgeHTML(item, inAst, running) {
    if (running) {
      return '<span style="color:#66ccff;font-size:8px;border:1px solid #66ccff;border-radius:3px;padding:0 4px">RUNNING</span>';
    }
    if (inAst) {
      return '<span style="color:#00d4aa;font-size:8px;border:1px solid #00d4aa;border-radius:3px;padding:0 4px">SENT</span>';
    }
    return '<span style="color:#888;font-size:8px;border:1px solid #444;border-radius:3px;padding:0 4px">PENDING</span>';
  }

  function strategyRowHTML(item, cat, checked, inAst, running) {
    const sideCol = cat === 'bearish' ? '#ef5350' : '#00d4aa';
    const vCol = scoreColor(item.score);
    /* Reference-only info from the AE engine that generated the strategy:
       timeframe + overall SL % + trail SL %. Purely informational - AST runs
       on its own settings basis and ignores these values. */
    const refParts = [];
    if (item.tf) refParts.push('TF ' + esc(item.tf));
    if (item.refSlPct != null) refParts.push('SL ' + esc(item.refSlPct) + '%');
    if (item.refTrailSlPct != null && Number(item.refTrailSlPct) > 0) refParts.push('Trail ' + esc(item.refTrailSlPct) + '%');
    const refTxt = refParts.length ? ' <span style="color:#5a5a7a;font-size:8px">· ' + refParts.join(' · ') + '</span>' : '';
    return '<div style="background:#12122a;border:1px solid #2d2d50;border-radius:4px;padding:5px 8px;margin:2px 0;font-size:10px">' +
      '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">' +
        '<input type="checkbox" data-ps-cat="' + cat + '" data-ps-key="' + esc(item.key) + '" ' + (checked ? 'checked ' : '') + 'title="Tick to select this strategy">' +
        '<span style="color:' + sideCol + ';font-weight:700;min-width:34px">LONG</span>' +
        '<span style="color:#fff;flex:1;min-width:110px">' + esc(item.name) + refTxt + '</span>' +
        '<span style="color:' + vCol + ';min-width:30px;text-align:right">' + (item.score || 0) + '</span>' +
        '<span style="color:#666;font-size:8px;min-width:44px;text-align:right">' + esc(item.verdict || '') + '</span>' +
        badgeHTML(item, inAst, running) +
      '</div>' +
    '</div>';
  }

  function emptyHTML(msg) {
    return '<div style="color:#666;font-size:10px;padding:6px 8px">' + msg + '</div>';
  }

  function renderList(cat, hostId, countId) {
    const host = $id(hostId);
    if (!host) return;
    const items = loadStore().filter(s => catOf(s) === cat);
    const count = $id(countId);
    if (count) count.textContent = items.length ? '(' + items.length + ')' : '';
    if (!items.length) {
      host.innerHTML = emptyHTML(cat === 'bearish'
        ? 'No bearish strategies. Send strategies from Auto Experiment and they land here.'
        : 'No bullish strategies. Send strategies from Auto Experiment and they land here.');
      return;
    }
    const inAst = astImportedIds();
    const running = astRunningIds();
    host.innerHTML = items.map(s => {
      const inAstFlag = inAst.has(astIdFor(s.key));
      const runningFlag = running.has(astIdFor(s.key));
      const checked = _sel[cat].has(s.key);
      return strategyRowHTML(s, cat, checked, inAstFlag, runningFlag);
    }).join('');
  }

  /* One delegated change listener per list: re-renders replace the rows'
     innerHTML, so the handler must live on the container, not the rows. The
     row keys are carried in data- attributes (safe for any key characters). */
  function bindListEvents() {
    ['psBullList', 'psBearList'].forEach(listId => {
      const el = $id(listId);
      if (el && !el.getAttribute('data-ps-bound')) {
        el.setAttribute('data-ps-bound', '1');
        el.addEventListener('change', e => {
          const cb = e.target;
          if (cb && cb.hasAttribute('data-ps-key')) {
            onStrategyCheck(cb.getAttribute('data-ps-cat') || 'bullish',
              cb.getAttribute('data-ps-key'), cb.checked);
          }
        });
      }
    });
  }

  function render(force) {
    bindListEvents();
    renderList('bullish', 'psBullList', 'psBullCount');
    renderList('bearish', 'psBearList', 'psBearCount');
    const cb = $id('psAutoSend');
    if (cb) cb.checked = getAuto();
    const btn = $id('psSendBtn');
    if (btn) {
      const n = selectionCount();
      btn.textContent = n ? 'Send selected to AST (' + n + ')' : 'Send selected to AST';
    }
    return true;
  }

  /* ---------------- public API ---------------- */

  function onStrategyCheck(cat, key, checked) {
    const c = (cat === 'bearish') ? 'bearish' : 'bullish';
    if (checked) _sel[c].add(key); else _sel[c].delete(key);
    render(true);
  }

  const api = {
    render,
    addFromAE,
    getAuto,

    onStrategyCheck,

    selectAll(cat) {
      const c = (cat === 'bearish') ? 'bearish' : 'bullish';
      loadStore().filter(s => catOf(s) === c).forEach(s => _sel[c].add(s.key));
      render(true);
    },

    selectNone(cat) {
      const c = (cat === 'bearish') ? 'bearish' : 'bullish';
      _sel[c].clear();
      render(true);
    },

    selectAllBoth() {
      loadStore().forEach(s => _sel[catOf(s)].add(s.key));
      render(true);
    },

    selectNoneBoth() {
      _sel.bullish.clear();
      _sel.bearish.clear();
      render(true);
    },

    sendSelected,
    removeSelected,
    removeAll,
    toggleAuto
  };

  /* Per-tab instance registry + active-tab facade (same scheme as the other
     paper engines). */
  if (!window.TabEngines) window.TabEngines = {};
  if (!window.TabEngines.paperstrategies) window.TabEngines.paperstrategies = {};
  const instKey = suffix.replace(/^_/, '') || 'papertrade';
  window.TabEngines.paperstrategies[instKey] = api;

  if (!window._PaperStrategiesFacade) {
    const base = api;
    window._PaperStrategiesFacade = new Proxy(base, {
      get(t, prop) {
        const key = window._paperActiveEngine || 'papertrade';
        const eng = window.TabEngines.paperstrategies[key] || t;
        const v = eng[prop];
        return typeof v === 'function' ? v.bind(eng) : v;
      },
      set(t, prop, val) {
        const key = window._paperActiveEngine || 'papertrade';
        const eng = window.TabEngines.paperstrategies[key] || t;
        eng[prop] = val;
        return true;
      }
    });
    window.PaperStrategies = window._PaperStrategiesFacade;
  }
  /* Render once at creation so the lists are populated immediately (also on a
     reload that restores the Paper Trade tab directly). */
  try { render(true); } catch (e) {}
  return api;
};
