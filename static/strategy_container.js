/* Dhan Algo - Strategy Container (Paper Trade tab)
 *
 * A safe, de-duplicated store for every strategy that was saved / deployed
 * from the Auto Strategy Experiment. It:
 *   - syncs the Auto Experiment strategies out of the shared saved-strategy
 *     list (localStorage "algodhan_strategies_v1") and keeps exactly one copy
 *     of each (duplicates that are already in the container are dropped),
 *   - records every paper trade closed by those strategies (tagged with the
 *     experiment result key by the paper engine) in a daily ledger,
 *   - shows the strategies grouped Bullish / Bearish with each strategy's P&L,
 *     win rate, average profit per trade and every other stat computed from
 *     the paper trades it actually took, aggregated per day up to the last day
 *     it traded,
 *   - filters the list: highest win rate / most profitable / highest average
 *     profit per trade / most overall profit giving.
 */
window.createStrategyContainer = function () {
  'use strict';

  const STORE_KEY = 'algodhan_strategy_container_v1';
  const SAVED_STRATS_KEY = 'algodhan_strategies_v1';
  const ADDED_TPL_KEY = 'algodhan_sc_added_tpls_v1';
  const SAVE_CAP = 4000;

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
  const dayOf = at => {
    const d = new Date(at);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };

  /* ---------------- persistence ---------------- */
  function defaultStore() {
    return { strategies: [], ledger: [], lastSyncAt: null, lastTradedDay: null, view: 'all' };
  }
  let store = load();
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (s) {
        const st = Object.assign(defaultStore(), s);
        if (Array.isArray(st.strategies) && st.strategies.length > 1) {
          const deduped = dedupeStrategies(st.strategies);
          if (deduped.length !== st.strategies.length) {
            st.strategies = deduped;
            try {
              localStorage.setItem(STORE_KEY, JSON.stringify(st));
            } catch (e) {}
          }
        }
        return st;
      }
    } catch (e) {}
    return defaultStore();
  }
  /* Collapse stored strategies to one copy per stable identity. Mirrors the
     syncStrategies dedupe so stale duplicates persisted earlier are purged on
     load without waiting for a boot sync. Keeps the last copy per identity. */
  function dedupeStrategies(list) {
    const out = [];
    const seen = new Set();
    (Array.isArray(list) ? list : []).forEach(s => {
      const k = strategyIdentity(s);
      const key = k || ('raw:' + (s && s.id));
      if (seen.has(key)) return;
      seen.add(key);
      out.push(s);
    });
    return out;
  }
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        strategies: store.strategies,
        ledger: store.ledger.slice(-SAVE_CAP),
        lastSyncAt: store.lastSyncAt,
        lastTradedDay: store.lastTradedDay,
        view: store.view || 'all'
      }));
    } catch (e) {}
  }

  /* ---------------- strategy sync + de-dupe ---------------- */
  /* Identity of an Auto Experiment strategy: same aeKey + symbol + strike.
     Deploying the same experiment result repeatedly mints fresh ids, so the
     container keys on the stable identity and stores one copy per identity. */
  function strategyIdentity(s) {
    if (!s) return null;
    if (s.paper === true && s.key) return 'paper:' + s.key;
    if (s.auto && s.aeKey) {
      const symId = (s.symbol && s.symbol.id != null) ? String(s.symbol.id) : '';
      const strike = (s.optionStrike != null) ? String(s.optionStrike) + ':' + (s.optionType || '') : '';
      return 'auto:' + s.aeKey + '|' + symId + '|' + strike;
    }
    if (s.id) return 'id:' + s.id;
    return null;
  }

  function loadSavedStrategies() {
    let list;
    try { list = JSON.parse(localStorage.getItem(SAVED_STRATS_KEY) || '[]'); } catch (e) { list = []; }
    return Array.isArray(list) ? list : [];
  }

  /* Collect the state objects of every AI Smart Trading engine instance across
     all paper tabs: the in-memory instances (TabEngines.aismart / AISmartTrading
     facade) plus a direct read of their persisted storage keys
     (algodhan_aismart_v1*). The container is global, so it must see strategies
     that landed on any tab. */
  function collectAstStates() {
    const out = [];
    const seen = new Set();
    const addState = st => {
      if (!st || typeof st !== 'object') return;
      let sig;
      try {
        sig = JSON.stringify({ s: (st.imported || []).map(x => x && x.id), c: (st.closed || []).length });
      } catch (e) { sig = 'x'; }
      if (seen.has(sig)) return;
      seen.add(sig);
      out.push(st);
    };
    try {
      if (window.TabEngines && window.TabEngines.aismart) {
        Object.keys(window.TabEngines.aismart).forEach(k => {
          const eng = window.TabEngines.aismart[k];
          if (eng && eng.getState) { try { addState(eng.getState()); } catch (e) {} }
        });
      }
    } catch (e) {}
    try {
      if (window.AISmartTrading && AISmartTrading.getState) { try { addState(AISmartTrading.getState()); } catch (e) {} }
    } catch (e) {}
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || k.indexOf('algodhan_aismart_v1') !== 0) continue;
        try {
          const s = JSON.parse(localStorage.getItem(k) || 'null');
          if (s) addState(s);
        } catch (e) {}
      }
    } catch (e) {}
    return out;
  }

  /* Strategies the user sent to the AI Smart Trading engine via the Auto
     Experiment "Send to Paper Trade" flow live in the AST engine's imported
     list, not in the shared saved-strategy store. Pull them in as paper-origin
     strategies so they appear in the container with the same daily paper-trade
     stats. They are symbol-agnostic (they run on the current chart symbol). */
  function loadPaperStrategies() {
    const out = [];
    const seen = new Set();
    const addList = list => {
      if (!Array.isArray(list)) return;
      list.forEach(s => {
        if (!s || s.id == null) return;
        if (seen.has(String(s.id))) return;
        seen.add(String(s.id));
        const c = JSON.parse(JSON.stringify(s));
        c.key = c.id.indexOf('pt:') === 0 ? c.id.slice(3) : c.id;
        c.paper = true;
        out.push(c);
      });
    };
    collectAstStates().forEach(st => addList(st.imported));
    /* The Paper Trade tab's Bullish / Bearish staging lists hold every strategy
       the AE "Send to Paper Trade" button handed over - before AST import. Read
       them too so a sent strategy shows up in the Strategy Container even when
       the AST auto-send switch is off. Same key identity (paper:key) keeps them
       de-duplicated against the AST-imported copies. */
    const PS_STORE_KEY = 'algodhan_paperstrategies_v1';
    try {
      const raw = JSON.parse(localStorage.getItem(PS_STORE_KEY) || 'null');
      const items = (raw && Array.isArray(raw.items)) ? raw.items : [];
      items.forEach(s => {
        if (!s || s.key == null) return;
        const id = 'pt:' + s.key;
        if (seen.has(id)) return;
        seen.add(id);
        const c = JSON.parse(JSON.stringify(s));
        c.id = id;
        c.key = s.key;
        c.paper = true;
        out.push(c);
      });
    } catch (e) {}
    return out;
  }

  /* Pull the Auto Experiment strategies from the shared saved list and merge
     them into the container: fresh copies replace stale ones with the same
     identity, identities no longer in the saved list are kept (the container
     is a safe store), and duplicates already stored are never re-added. */
  function syncStrategies() {
    const saved = loadSavedStrategies().filter(s => s && s.auto === true && s.aeKey);
    const paper = loadPaperStrategies();
    const fresh = new Map();
    saved.forEach(s => {
      const k = strategyIdentity(s);
      if (k && !fresh.has(k)) fresh.set(k, s);
    });
    paper.forEach(s => {
      const k = strategyIdentity(s);
      if (k && !fresh.has(k)) fresh.set(k, s);
    });
    const existing = new Map();
    store.strategies.forEach(s => {
      const k = strategyIdentity(s);
      if (k) existing.set(k, s);
    });
    const out = [];
    const seen = new Set();
    fresh.forEach((s, k) => {
      const copy = JSON.parse(JSON.stringify(s));
      /* carry over the container's own bookkeeping fields */
      if (existing.has(k)) {
        const prev = existing.get(k);
        if (prev && prev.scId) copy.scId = prev.scId;
      }
      out.push(copy);
      seen.add(k);
    });
    existing.forEach((s, k) => {
      if (!seen.has(k)) { out.push(s); seen.add(k); }
    });
    store.strategies = out;
    store.lastSyncAt = Date.now();
    save();
    return store.strategies;
  }

  /* ---------------- trade attribution ---------------- */
  /* Score how well a stored strategy matches a closed paper trade. The trade
     carries the auto-experiment result key (autoKey) which embeds the template
     key (aeKey), the symbol id, and — for strike-scoped strategies — the
     strike/option-type suffix. */
  function matchScore(strat, trade) {
    if (!strat || !trade) return 0;
    /* Paper-origin strategies (sent to the AI Paper Trade engine) carry no
       aeKey/symbol; they match purely on the strategy key the engine stamps on
       every closed trade. */
    if (strat.paper === true && strat.key) {
      const pk = String(trade.paperKey != null ? trade.paperKey : (trade.autoKey || ''));
      if (!pk) return 0;
      return pk === String(strat.key) ? 6 : (pk.indexOf(String(strat.key)) >= 0 ? 4 : 0);
    }
    if (!(strat.auto && strat.aeKey)) return 0;
    const ak = String(trade.autoKey || '');
    if (!ak) return 0;
    let score = 0;
    if (ak.indexOf(strat.aeKey) < 0) return 0;
    score += 2;
    const stratSym = strat.symbol || null;
    const tradeSymId = (trade.symbolId != null) ? Number(trade.symbolId) : null;
    if (stratSym && tradeSymId != null) {
      if (Number(stratSym.id) !== tradeSymId) return 0;
      score += 2;
    } else if (stratSym && trade.symbol) {
      const n = String(trade.symbol).toUpperCase();
      const m = String(stratSym.name || '').toUpperCase();
      if (!n || !m || n.indexOf(m) < 0) return 0;
      score += 1;
    }
    if (strat.optionStrike != null) {
      if (ak.indexOf(':' + strat.optionStrike + ':' + (strat.optionType || '')) >= 0) score += 3;
    }
    return score;
  }

  function bestMatch(trade) {
    let best = null, bestScore = 0;
    for (const s of store.strategies) {
      const sc = matchScore(s, trade);
      if (sc > bestScore) { bestScore = sc; best = s; }
    }
    return (bestScore >= 4) ? best : null;
  }

  /* ---------------- ledger ---------------- */
  function recordTrade(t) {
    if (!t) return null;
    const hasAuto = t.autoKey != null && t.autoKey !== '';
    const hasPaper = t.paperKey != null && t.paperKey !== '';
    if (!hasAuto && !hasPaper) return null;
    const keyTok = hasAuto ? t.autoKey : ('paper:' + t.paperKey);
    const id = [t.at, t.symbol, t.side, t.qty, keyTok].join('|');
    if (store.ledger.some(x => x._id === id)) return null;
    const strat = bestMatch(t);
    if (!strat) return null;
    const net = (t.netPnl != null && isFinite(t.netPnl)) ? Number(t.netPnl) : Number(t.pnl || 0);
    const rec = {
      _id: id,
      strategyId: strategyIdentity(strat),
      day: dayOf(t.at),
      symbol: t.symbol,
      side: t.side,
      qty: t.qty,
      entry: t.entry,
      exit: t.exit,
      pnl: Number(t.pnl || 0),
      pnlPct: Number(t.pnlPct || 0),
      netPnl: net,
      charges: Number(t.charges || 0),
      at: t.at,
      reason: t.reason || '',
      autoKey: hasAuto ? t.autoKey : ('paper:' + t.paperKey)
    };
    store.ledger.push(rec);
    if (!store.lastTradedDay || rec.day > store.lastTradedDay) store.lastTradedDay = rec.day;
    save();
    scheduleRender();
    return rec;
  }

  /* Defensive backfill: pull any strategy-tagged closed trades from the paper
     engine(s) that were recorded before the container loaded (e.g. old records
     that were already closed). Idempotent through the _id dedupe. */
  function ingestFromPaper() {
    const seen = new Set(store.ledger.map(x => x._id));
    const tryState = st => {
      if (!st || !Array.isArray(st.closed)) return;
      st.closed.forEach(t => {
        if (!t || t.autoKey == null) return;
        const id = [t.at, t.symbol, t.side, t.qty, t.autoKey].join('|');
        if (seen.has(id)) return;
        const rec = recordTrade(t);
        if (rec) seen.add(rec._id);
      });
    };
    try {
      if (window.PaperTrade && PaperTrade.getState) tryState(PaperTrade.getState());
    } catch (e) {}
    try {
      if (window.TabEngines && window.TabEngines.papertrade) {
        Object.keys(window.TabEngines.papertrade).forEach(k => {
          const eng = window.TabEngines.papertrade[k];
          if (eng && eng.getState) tryState(eng.getState());
        });
      }
    } catch (e) {}
  }

  /* ---------------- daily stats ---------------- */
  function computeStats() {
    const buckets = {};
    store.strategies.forEach(s => {
      const k = strategyIdentity(s);
      if (!k) return;
      buckets[k] = { strat: s, trades: [], days: {} };
    });
    store.ledger.forEach(tr => {
      const b = buckets[tr.strategyId];
      if (!b) return;
      b.trades.push(tr);
      (b.days[tr.day] = b.days[tr.day] || []).push(tr);
    });
    const out = [];
    Object.keys(buckets).forEach(k => {
      const b = buckets[k];
      const days = Object.keys(b.days).sort();
      let wins = 0, grossWin = 0, grossLoss = 0;
      const dayStats = days.map(d => {
        let dp = 0;
        b.days[d].forEach(t => { dp += t.netPnl; });
        return { day: d, pnl: dp };
      });
      const dayMap = {};
      dayStats.forEach(d => { dayMap[d.day] = d.pnl; });
      let totalNet = 0;
      dayStats.forEach(d => { totalNet += d.pnl; });
      b.trades.forEach(t => {
        if (t.netPnl > 0) { wins++; grossWin += t.netPnl; } else { grossLoss += Math.abs(t.netPnl); }
      });
      const n = b.trades.length;
      let bestDay = null, worstDay = null;
      dayStats.forEach(d => {
        if (!bestDay || d.pnl > bestDay.pnl) bestDay = d;
        if (!worstDay || d.pnl < worstDay.pnl) worstDay = d;
      });
      const lastDay = days.length ? days[days.length - 1] : null;
      out.push({
        key: k,
        strat: b.strat,
        trades: n,
        wins: wins,
        losses: n - wins,
        winRate: n ? (wins / n) * 100 : 0,
        totalNet: totalNet,
        avgPerTrade: n ? totalNet / n : 0,
        daysTraded: days.length,
        lastDay: lastDay,
        lastDayPnl: lastDay != null ? (dayMap[lastDay] || 0) : null,
        bestDay: bestDay,
        worstDay: worstDay,
        profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0)
      });
    });
    return out;
  }

  /* ---------------- filters ---------------- */
  const FILTERS = {
    all:   { label: 'All strategies', sort: (a, b) => 0 },
    winrate: { label: 'Highest win rate', sort: (a, b) => (b.winRate - a.winRate) || (b.totalNet - a.totalNet) || (b.trades - a.trades) },
    profit:  { label: 'Most profitable (highest net P&L)', sort: (a, b) => (b.totalNet - a.totalNet) || (b.winRate - a.winRate) },
    avg:     { label: 'Highest average profit per trade', sort: (a, b) => (b.avgPerTrade - a.avgPerTrade) || (b.totalNet - a.totalNet) },
    overall: { label: 'Most overall profit giving', sort: (a, b) => (b.totalNet - a.totalNet) || (b.daysTraded - a.daysTraded) || (b.winRate - a.winRate) }
  };

  /* ---------------- UI ---------------- */
  /* ---------------- selection + pooled-runner batch add ---------------- */
  /* Strategy Container -> Pooled Strategy Runner flow: tick strategies, pick a
     saved paper-trade template (from the paper engine of the tab this container
     is shown in), then add them as enabled pooled-runner rows that trade on
     that template's lots/margin/TP/SL. Selection survives re-renders. */
  const _sel = new Set();

  /* Templates the user explicitly ADDED via the toolbar "Add" button, per tab.
     These are the templates the pooled runner trades under: their symbol/
     instrument sets are merged and every trade setting comes from them. */
  const _added = loadAdded();
  function loadAdded() {
    try {
      const a = JSON.parse(localStorage.getItem(ADDED_TPL_KEY) || '{}');
      return (a && typeof a === 'object') ? a : {};
    } catch (e) { return {}; }
  }
  function persistAdded() {
    try { localStorage.setItem(ADDED_TPL_KEY, JSON.stringify(_added)); } catch (e) {}
  }
  function addedFor(tab) {
    if (!_added[tab]) _added[tab] = [];
    return _added[tab];
  }

  function renderAddedTpls(tab) {
    const host = $id('scAddedTpls' + sfx(tab));
    if (!host) return;
    const list = addedFor(tab);
    if (!list.length) { host.innerHTML = '<span style="font-size:9px;color:#666">No template added yet - pick one above and press <b>Add</b>.</span>'; return; }
    host.innerHTML = '<span style="font-size:9px;color:#888;margin-right:4px">Added:</span>' + list.map(t => {
      const symCount = (t.source === 'ast' && Array.isArray(t.symbols)) ? t.symbols.length : (t.symbol ? 1 : 0);
      const symTxt = symCount ? (' <span style="color:#66ccff">[' + symCount + ' sym]</span>') : '';
      return '<span style="background:#1a1a35;border:1px solid #2d6d5a;border-radius:3px;padding:2px 6px;margin:0 4px 4px 0;display:inline-flex;align-items:center;gap:5px;font-size:9px;color:#9aa">' +
        '<span>' + esc(t.name) + symTxt + '</span>' +
        '<button title="Remove template" style="background:none;border:none;color:#ff8a80;cursor:pointer;font-size:11px;padding:0;line-height:1" onclick="window.StrategyContainer.removeAddedTpl(\'' + esc(String(tab)) + '\',\'' + esc(String(t.id)) + '\')">&times;</button>' +
        '</span>';
    }).join('');
  }

  function removeAddedTpl(tab, id) {
    addedFor(tab);
    _added[tab] = _added[tab].filter(t => String(t.id) !== String(id));
    persistAdded();
    renderAddedTpls(tab);
  }

  function sfx(tab) { return tab === 'papertrade' ? '' : '_' + tab; }

  function tabOf(el) {
    if (!el || !el.closest) return 'papertrade';
    const tc = el.closest('.tab-content');
    if (tc) { const m = /^tab-(paper\d+)$/.exec(tc.id || ''); if (m) return m[1]; }
    return 'papertrade';
  }

  function paperEngineFor(tab) {
    const instKey = tab === 'papertrade' ? 'papertrade' : tab;
    if (window.TabEngines && window.TabEngines.papertrade && window.TabEngines.papertrade[instKey]) {
      return window.TabEngines.papertrade[instKey];
    }
    return window.PaperTrade || null;
  }

  function astEngineFor(tab) {
    const instKey = tab === 'papertrade' ? 'papertrade' : tab;
    if (window.TabEngines && window.TabEngines.aismart && window.TabEngines.aismart[instKey]) {
      return window.TabEngines.aismart[instKey];
    }
    return window.AISmartTrading || null;
  }

  /* Templates available for a tab: this tab's AI Smart Trading Engine saved
     settings templates FIRST (the user's primary source), then this tab's
     paper-trade engine templates. */
  function templatesForTab(tab) {
    const astEng = astEngineFor(tab);
    const astTpls = (astEng && astEng.getTemplates ? astEng.getTemplates() : []) || [];
    const eng = paperEngineFor(tab);
    const ptTpls = (eng && eng.getTemplates ? eng.getTemplates() : []) || [];
    return astTpls.concat(ptTpls);
  }

  function selRow(cb) {
    if (!cb) return;
    const rid = cb.getAttribute('data-rid');
    if (!rid) return;
    if (cb.checked) _sel.add(rid); else _sel.delete(rid);
    syncSelCount(tabOf(cb));
  }

  function toggleSelectAll(el) {
    const tab = tabOf(el);
    const host = document.getElementById('scBody' + sfx(tab));
    const want = !!el.checked;
    if (host) {
      host.querySelectorAll('.sc-sel').forEach(cb => {
        cb.checked = want;
        const rid = cb.getAttribute('data-rid');
        if (rid) { if (want) _sel.add(rid); else _sel.delete(rid); }
      });
    }
    syncSelCount(tab);
  }

  function syncSelCount(tab) {
    const cnt = document.getElementById('scSelCount' + sfx(tab));
    if (cnt) cnt.textContent = _sel.size + ' selected';
    const all = document.getElementById('scSelAll' + sfx(tab));
    if (all) {
      const host = document.getElementById('scBody' + sfx(tab));
      const boxes = host ? host.querySelectorAll('.sc-sel') : [];
      all.checked = boxes.length > 0 && Array.from(boxes).every(cb => cb.checked);
    }
  }

  function populateTemplateDropdowns() {
    const sels = document.querySelectorAll ? document.querySelectorAll('[id^="scPtTemplate"]') : [];
    sels.forEach(sel => {
      const m = /_paper(\d+)$/.exec(sel.id || '');
      const tab = m ? 'paper' + m[1] : 'papertrade';
      renderAddedTpls(tab);
      const tpls = templatesForTab(tab);
      const cur = sel.value;
      if (!tpls.length) {
        if (!(sel.options.length === 1 && sel.options[0].value === '' && sel.options[0].textContent === 'No saved templates')) {
          sel.innerHTML = '<option value="">No saved templates</option>';
        }
        return;
      }
      const joined = tpls.map(t => String(t.id)).join('|');
      if (sel.dataset.tplIds === joined) {
        if (cur && sel.querySelector('option[value="' + cur + '"]')) sel.value = cur;
        return;
      }
      sel.dataset.tplIds = joined;
      let opts = '';
      tpls.forEach(t => {
        const symTxt = (t.symbol && t.symbol.name) ? (' [' + t.symbol.name + ']') : '';
        opts += '<option value="' + t.id + '">' + String(t.name) + symTxt + ' (lots ' + t.lots + ', margin ' + t.margin + ', TP ' + t.tpPct + '%, SL ' + t.slPct + '%)</option>';
      });
      sel.innerHTML = opts;
      /* Default to a saved template (the most recent) so strategies never run on
         the engine's live/broker-synced settings by mistake. */
      sel.value = (cur && sel.querySelector('option[value="' + cur + '"]')) ? cur : String(tpls[tpls.length - 1].id);
    });
  }

  /* "Add" button: load the selected template into the CURRENT tab's engines -
     for an AST template, applies its engine-settings snapshot (including its
     captured instrument set) to the tab's AI Smart Trading engine; for a paper
     template, sets the paper engine's symbol/lots/margin/TP/SL inputs. In both
     cases the template is ADDED to the tab's "Added templates" chip list, and
     the "Add selected & run paper trade" button trades its exact symbols +
     settings. */
  function addTemplateToEngine(el) {
    const tab = tabOf(el);
    const eng = paperEngineFor(tab);
    if (!eng) { alert('Paper trade engine for ' + tab + ' not ready yet.'); return; }
    const tpls = templatesForTab(tab);
    const tplSel = document.getElementById('scPtTemplate' + sfx(tab));
    const selVal = tplSel ? tplSel.value : '';
    let tpl = tpls.find(x => String(x.id) === String(selVal));
    if (!tpl && tpls.length) tpl = tpls[tpls.length - 1];
    if (!tpl) { alert('No saved template found. Save an engine template in the AI Smart Trading panel first (or a template in the paper-trade panel).'); return; }
    const sf = sfx(tab);
    const setId = (base, v) => {
      const el2 = document.getElementById(base + sf);
      if (el2) {
        el2.value = v;
        el2.dispatchEvent(new Event('input', { bubbles: true }));
      }
    };
    if (tpl.source === 'ast') {
      const astEng = astEngineFor(tab);
      if (astEng && astEng.openTemplate && tpl.astId != null) {
        try { astEng.openTemplate(tpl.astId); } catch (e) {}
      }
      /* Mirror the template's trade numbers into the paper panel too. */
      setId('paperLots', tpl.lots);
      setId('paperMargin', tpl.margin);
      setId('paperTargetPct', tpl.tpPct);
      setId('paperSlPct', tpl.slPct);
      if (eng.recompute) { try { eng.recompute(); } catch (e) {} }
    } else {
      setId('paperLots', tpl.lots);
      setId('paperMargin', tpl.margin);
      setId('paperTargetPct', tpl.tpPct);
      setId('paperSlPct', tpl.slPct);
      if (eng.recompute) { try { eng.recompute(); } catch (e) {} }
      /* Switch the chart symbol to the template's symbol when available. */
      if (tpl.symbol && tpl.symbol.id != null) applyTemplateSymbol(tpl.symbol);
    }
    /* Add to this tab's added-template list (de-dupe by id) and render chips. */
    const list = addedFor(tab);
    if (!list.some(x => String(x.id) === String(tpl.id))) {
      list.push(JSON.parse(JSON.stringify(tpl)));
      persistAdded();
    }
    renderAddedTpls(tab);
    populateTemplateDropdowns();
    if (eng.log) {
      try {
        eng.log('Added template "' + tpl.name + '" to ' + tab + (tpl.source === 'ast' ? ' AI Smart Trading engine' : ' paper engine') + (tpl.symbol && tpl.symbol.name ? ' [' + tpl.symbol.name + ']' : '') + ' (lots ' + tpl.lots + ', margin ' + tpl.margin + ', TP ' + tpl.tpPct + '%, SL ' + tpl.slPct + '%)', 'ok');
      } catch (e) {}
    }
    return tpl;
  }

  function applyTemplateSymbol(sym) {
    if (!sym || sym.id == null) return false;
    const s = document.getElementById('symbolSelect');
    if (!s || typeof onSymbolChange !== 'function') return false;
    for (let i = 0; i < s.options.length; i++) {
      const opt = s.options[i];
      const exch = opt.getAttribute('data-exch') || '';
      const sid = parseInt(opt.value, 10);
      if (sid === Number(sym.id) && (!sym.exch || exch === sym.exch)) {
        s.selectedIndex = i;
        try { onSymbolChange(); } catch (e) {}
        return true;
      }
    }
    return false;
  }

  function addSelectedToPaper(el) {
    const tab = tabOf(el);
    const eng = paperEngineFor(tab);
    if (!eng) { alert('Paper trade engine for ' + tab + ' not ready yet.'); return; }
    if (!window.HftRunner) { alert('Pooled Strategy Runner not loaded yet.'); return; }
    const toAdd = store.strategies.filter(s => _sel.has(strategyIdentity(s)));
    if (!toAdd.length) {
      alert('No strategies selected. Tick the checkbox in front of each strategy (or Select All) first.');
      return;
    }
    const astEng = astEngineFor(tab);
    /* Templates to trade under: the ADDED chips first; if none were added yet,
       fall back to the template currently picked in the dropdown. */
    let tplsToUse = addedFor(tab).slice();
    if (!tplsToUse.length) {
      const tpls = templatesForTab(tab);
      const tplSel = document.getElementById('scPtTemplate' + sfx(tab));
      const selVal = tplSel ? tplSel.value : '';
      let tpl = tpls.find(x => String(x.id) === String(selVal));
      if (!tpl && tpls.length) tpl = tpls[tpls.length - 1];
      if (tpl) tplsToUse = [tpl];
    }
    if (!tplsToUse.length) {
      alert('No template added. Pick a saved template in the dropdown and press "Add" first (or save one in the AI Smart Trading / paper-trade panel).');
      return;
    }
    /* Merge the instrument set: every added AST template contributes its
       captured symbols (falling back to the AST engine's current picks); paper
       templates contribute their single symbol. All settings (lots/margin/
       TP/SL) come from the last-added template. */
    const syms = [];
    const pushSym = s => {
      if (!s || s.id == null) return;
      if (!syms.some(x => Number(x.id) === Number(s.id) && (x.exch || '') === (s.exch || ''))) syms.push(s);
    };
    tplsToUse.forEach(t => {
      if (t.source === 'ast') {
        let arr = (Array.isArray(t.symbols) && t.symbols.length) ? t.symbols : [];
        if (!arr.length && astEng && typeof astEng.experimentSymbols === 'function') {
          try { arr = astEng.experimentSymbols() || []; } catch (e) { arr = []; }
        }
        arr.forEach(pushSym);
      } else if (t.symbol) {
        pushSym(t.symbol);
      }
    });
    if (!syms.length) {
      alert('The added template(s) have no symbols/instruments. Configure the instrument selection in the AI Smart Trading engine (NIFTY trend / movers / symbols), save the template again, then press "Add".');
      return;
    }
    const primary = tplsToUse[tplsToUse.length - 1];
    const settings = {
      lots: primary.lots, margin: primary.margin, tpPct: primary.tpPct, slPct: primary.slPct,
      fnoLimit: false, symbol: syms[0], symbols: syms.slice(),
      name: primary.name, source: primary.source || 'paper'
    };
    let added = 0;
    toAdd.forEach(s => {
      const row = HftRunner.addStrategyObject(tab, s, settings);
      row.enabled = true;   // run paper trade right away
      added++;
    });
    _sel.clear();
    syncSelCount(tab);
    if (eng.log) {
      try {
        eng.log('Strategy Container: added ' + added + ' selected strategy(ies) to pooled runner on template(s) "' + tplsToUse.map(t => t.name).join(', ') + '" · ' + syms.length + ' instrument(s): ' + syms.map(x => x.name).join(', '), 'ok');
      } catch (e) {}
    }
    return added;
  }

  function rowHTML(st) {
    const s = st.strat || {};
    const cat = s.cat === 'bearish' ? 'bearish' : 'bullish';
    const name = (s.name || 'Untitled').replace(/^AE:\s*/, '');
    const symName = (s.symbol && s.symbol.name) ? s.symbol.name : (s.symbol && s.symbol.id != null ? 'Sym ' + s.symbol.id : (s.paper ? 'Any symbol' : '--'));
    /* Reference-only info from the AE engine that generated the strategy:
       timeframe + overall SL % + trail SL %. Purely informational - the
       container's stats and AST execution both use their own settings basis. */
    const refParts = [];
    if (s.tf) refParts.push('TF ' + s.tf);
    const refSl = (s.refSlPct != null) ? s.refSlPct : (s.autoSlPct != null ? s.autoSlPct : null);
    if (refSl != null) refParts.push('SL ' + refSl + '%');
    if (s.refTrailSlPct != null && Number(s.refTrailSlPct) > 0) refParts.push('Trail ' + s.refTrailSlPct + '%');
    const refTxt = refParts.length ? ' <span style="color:#5a5a7a">[' + refParts.join(' · ') + ']</span>' : '';
    const meta = [s.method, symName + ' ' + (s.tf || '')].filter(Boolean).join(' · ');
    const netCls = st.totalNet >= 0 ? 'green' : 'red';
    const lastDayCls = st.lastDayPnl != null ? (st.lastDayPnl >= 0 ? 'green' : 'red') : '';
    const badge = cat === 'bearish'
      ? '<span style="color:#ef5350;font-size:8px;border:1px solid #ef5350;border-radius:2px;padding:1px 4px;font-weight:700">BEARISH</span>'
      : '<span style="color:#00d4aa;font-size:8px;border:1px solid #00d4aa;border-radius:2px;padding:1px 4px;font-weight:700">BULLISH</span>';
    return '<tr>' +
      '<td style="text-align:center"><input type="checkbox" class="sc-sel" data-rid="' + esc(strategyIdentity(s)) + '" onchange="StrategyContainer.selRow(this)" title="Select for pooled paper trading"></td>' +
      '<td style="max-width:190px"><div style="font-weight:700;color:#d0d0d0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="' + esc(name) + '">' + esc(name) + '</div>' +
        '<div style="font-size:8px;color:#777;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(meta) + refTxt + '</div></td>' +
      '<td>' + badge + '</td>' +
      '<td style="text-align:center">' + st.trades + ' <span style="color:#666">(' + st.wins + '/' + st.losses + ')</span></td>' +
      '<td style="color:' + (st.winRate >= 50 ? '#00d4aa' : st.winRate > 0 ? '#ffd700' : '#666') + ';font-weight:700">' + fmtPct(st.winRate) + '</td>' +
      '<td style="font-weight:700" class="' + netCls + '">' + fmtMoneySigned(st.totalNet) + '</td>' +
      '<td class="' + netCls + '">' + fmtMoneySigned(st.avgPerTrade) + '</td>' +
      '<td style="color:#888">' + (st.daysTraded ? st.daysTraded + (st.daysTraded === 1 ? ' day' : ' days') : '--') + '</td>' +
      '<td style="color:#888;white-space:nowrap">' + (st.lastDay || '--') + '</td>' +
      '<td class="' + lastDayCls + '">' + (st.lastDayPnl != null ? fmtMoneySigned(st.lastDayPnl) : '--') + '</td>' +
      '<td style="color:#ffd700">' + (st.bestDay ? st.bestDay.day + ' ' + fmtMoneySigned(st.bestDay.pnl) : '--') + '</td>' +
      '<td style="color:#666">' + (isFinite(st.profitFactor) ? fmt2(st.profitFactor) : (st.profitFactor === Infinity ? '∞' : '--')) + '</td>' +
    '</tr>';
  }

  function sectionHTML(title, color, list) {
    if (!list.length) {
      return '<div style="font-size:10px;color:#777;padding:6px 2px">No ' + title.toLowerCase() + ' strategies saved from the Auto Experiment yet.</div>';
    }
    return '<div style="margin-top:6px"><div style="font-size:10px;font-weight:700;color:' + color + ';margin:4px 0 2px">' + title + ' Strategies <span style="color:#666;font-weight:400">(' + list.length + ')</span></div>' +
      '<table class="account-table" style="font-size:9px"><thead><tr>' +
      '<th style="text-align:center" title="Select for pooled paper trading">Sel</th><th>Strategy</th><th>Type</th><th>Trades (W/L)</th><th>Win Rate</th><th>Total P&L</th><th>Avg/Trade</th><th>Days</th><th>Last Day</th><th>Last Day P&L</th><th>Best Day</th><th>PF</th>' +
      '</tr></thead><tbody>' + list.map(rowHTML).join('') + '</tbody></table></div>';
  }

  let _renderTimer = null;
  function scheduleRender() {
    if (_renderTimer) return;
    _renderTimer = setTimeout(() => { _renderTimer = null; render(); }, 250);
  }

  function render() {
    const hosts = [document.getElementById('scBody')];
    if (document.querySelectorAll) {
      document.querySelectorAll('[id^="scBody_paper"]').forEach(el => hosts.push(el));
    }
    const host = hosts[0];
    if (!host) return;
    const stats = computeStats();
    const filterSel = $id('scFilter');
    let filter = (filterSel && FILTERS[filterSel.value]) ? filterSel.value : 'all';
    const sorted = stats.slice().sort(FILTERS[filter].sort);
    const bullish = sorted.filter(x => !(x.strat.cat === 'bearish'));
    const bearish = sorted.filter(x => x.strat.cat === 'bearish');
    const withTrades = stats.filter(x => x.trades > 0);
    let topPnl = null;
    withTrades.forEach(x => { if (!topPnl || x.totalNet > topPnl.totalNet) topPnl = x; });
    const sum = $id('scSummary');
    if (sum) {
      const paperCount = store.strategies.filter(s => s && s.paper === true).length;
      const autoCount = store.strategies.filter(s => s && s.auto === true && s.aeKey).length;
      sum.innerHTML = '<div class="acard"><div class="label">Strategies</div><div class="value" style="color:#fff;font-size:14px">' + stats.length + '</div></div>' +
        '<div class="acard"><div class="label">Bullish</div><div class="value" style="color:#00d4aa;font-size:14px">' + bullish.length + '</div></div>' +
        '<div class="acard"><div class="label">Bearish</div><div class="value" style="color:#ef5350;font-size:14px">' + bearish.length + '</div></div>' +
        '<div class="acard"><div class="label">From AE Send</div><div class="value" style="color:#66ccff;font-size:12px">' + paperCount + '</div></div>' +
        '<div class="acard"><div class="label">Deployed</div><div class="value" style="color:#b39ddb;font-size:12px">' + autoCount + '</div></div>' +
        '<div class="acard"><div class="label">With Trades</div><div class="value" style="color:#66ccff;font-size:14px">' + withTrades.length + '</div></div>' +
        '<div class="acard"><div class="label">Paper Trades</div><div class="value" style="color:#fff;font-size:14px">' + store.ledger.length + '</div></div>' +
        '<div class="acard"><div class="label">Last Paper-Traded Day</div><div class="value" style="color:#ffd700;font-size:12px">' + (store.lastTradedDay || '--') + '</div></div>';
    }
    let html;
    if (!stats.length) {
      html = '<div class="strat-empty">No Auto Experiment strategies stored yet. Use "Send to Paper Trade" or "Deploy" in the Auto Strategy Experiment tab and they will appear here (de-duplicated). If you already sent some, press the Refresh button.</div>';
    } else {
      const note =
      '<div style="font-size:9px;color:#888;padding:2px 0 4px">Stats computed from the paper trades each strategy actually took, aggregated by day, up to the last paper-traded day (' +
      (store.lastTradedDay || '--') + ').' + (filter !== 'all' ? ' Filter: <b style="color:#66ccff">' + FILTERS[filter].label + '</b>.' : '') + '</div>';
      const view = (store.view === 'bullish' || store.view === 'bearish') ? store.view : 'all';
      if (view === 'bullish') {
        html = note + sectionHTML('Bullish', '#00d4aa', bullish);
      } else if (view === 'bearish') {
        html = note + sectionHTML('Bearish', '#ef5350', bearish);
      } else {
        html = note + sectionHTML('Bullish', '#00d4aa', bullish) + sectionHTML('Bearish', '#ef5350', bearish);
      }
    }
    hosts.forEach(h => { if (h) h.innerHTML = html; });
    hosts.forEach(h => {
      if (!h) return;
      const tab = /^scBody(_.*)?$/.exec(h.id) ? (/^scBody(_paper\d+)$/.exec(h.id) ? h.id.replace('scBody', '') : '') : '';
      const t = tab ? tab.replace(/^_/, '') : 'papertrade';
      h.querySelectorAll('.sc-sel').forEach(cb => {
        const rid = cb.getAttribute('data-rid');
        cb.checked = !!_sel.has(rid);
      });
      syncSelCount(t);
    });
    populateTemplateDropdowns();
    renderViewToggle(bullish.length, bearish.length);
  }

  /* ---------------- view toggle (All / Bullish / Bearish) ---------------- */
  function renderViewToggle(bullN, bearN) {
    const current = (store.view === 'bullish' || store.view === 'bearish') ? store.view : 'all';
    let hosts = [];
    try {
      const base = document.getElementById('scViewToggle');
      if (base) hosts.push(base);
      if (document.querySelectorAll) {
        document.querySelectorAll('[id^="scViewToggle_paper"]').forEach(el => hosts.push(el));
      }
    } catch (e) {}
    hosts.forEach(tg => {
      if (!tg || !tg.querySelectorAll) return;
      tg.querySelectorAll('[data-view]').forEach(btn => {
        const v = btn.getAttribute('data-view');
        const active = v === current;
        btn.className = 'sc-view-btn' + (active ? ' active' : '');
        if (v === 'bullish') btn.innerHTML = 'Bullish <b>(' + bullN + ')</b>';
        else if (v === 'bearish') btn.innerHTML = 'Bearish <b>(' + bearN + ')</b>';
        else btn.innerHTML = 'All <b>(' + (bullN + bearN) + ')</b>';
      });
    });
  }

  /* ---------------- diagnostics ---------------- */
  function diagnose() {
    const lines = [];
    const savedAuto = loadSavedStrategies().filter(s => s && s.auto === true && s.aeKey);
    lines.push('Saved-list auto strategies: ' + savedAuto.length);
    const states = collectAstStates();
    lines.push('AI Smart Trading states found: ' + states.length);
    states.forEach((st, i) => {
      lines.push('  [' + i + '] imported=' + ((st.imported || []).length) + ' ids=[' + (st.imported || []).map(s => s && s.id).join(',') + '] closed=' + ((st.closed || []).length));
    });
    const astKeys = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf('algodhan_aismart_v1') === 0) astKeys.push(k);
      }
    } catch (e) {}
    lines.push('algodhan_aismart_v1* storage keys: [' + astKeys.join(',') + ']');
    lines.push('Container store strategies: ' + store.strategies.length + ' [' + store.strategies.map(s => (s.paper ? 'paper:' : (s.auto ? 'auto:' : 'id:')) + (s.key || s.aeKey || s.id || '?')).join(',') + ']');
    lines.push('Container ledger trades: ' + store.ledger.length);
    return lines.join('\n');
  }

  /* ---------------- public API ---------------- */
  const api = {
    boot() {
      if (this._booted) return;
      this._booted = true;
      syncStrategies();
      ingestFromPaper();
      render();
      /* Keep the PT-template dropdown in sync: templates can be saved on any
         paper tab at any time, and the dropdown must pick them up without a
         manual refresh. Cheap, change-guarded, selection-preserving. */
      try {
        if (typeof window.setInterval === 'function') {
          this._tplTimer = window.setInterval(() => { try { populateTemplateDropdowns(); } catch (e) {} }, 4000);
        }
      } catch (e) {}
      /* Refresh the moment strategies are imported into the AI Paper Trade
         engine (covers "Send to Paper Trade" / autoSend on any tab). */
      try {
        if (typeof window.addEventListener === 'function') {
          window.addEventListener('strategies-imported', () => {
            try { api.refresh(); } catch (e) {}
          });
        }
      } catch (e) {}
    },
    refresh() {
      syncStrategies();
      ingestFromPaper();
      render();
    },
    syncStrategies: syncStrategies,
    ingestFromPaper: ingestFromPaper,
    recordTrade: recordTrade,
    onPaperClose: scheduleRender,
    computeStats: computeStats,
    render: render,
    setView(v) {
      if (v === 'bullish' || v === 'bearish') store.view = v;
      else store.view = 'all';
      save();
      render();
    },
    diagnose: diagnose,
    selRow: selRow,
    toggleSelectAll: toggleSelectAll,
    syncSelCount: syncSelCount,
    addSelectedToPaper: addSelectedToPaper,
    addTemplateToEngine: addTemplateToEngine,
    populateTemplateDropdowns: populateTemplateDropdowns,
    removeAddedTpl: removeAddedTpl,
    renderAddedTpls: renderAddedTpls,
    getAddedTpls(tab) { return addedFor(tab).slice(); },
    getState() { return store; }
  };
  window.StrategyContainer = api;
  return api;
};

if (typeof window !== 'undefined') {
  window.StrategyContainer = window.StrategyContainer || window.createStrategyContainer();
  /* Boot the container here instead of relying on the index.html guard: the
     module self-instantiates above, so the guard's `!window.StrategyContainer`
     check is always false and boot() never ran - which left the "strategies-
     imported" listener unregistered and the initial render/sync missing. Boot
     on DOM ready so the paper/AE engines (created right after this script)
     are already registered when we first sync. boot() is idempotent. */
  const scBoot = () => { try { window.StrategyContainer.boot(); } catch (e) {} };
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', scBoot);
    } else {
      scBoot();
    }
  }
}
