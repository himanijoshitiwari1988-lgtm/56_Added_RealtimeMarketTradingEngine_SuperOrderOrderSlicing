/* Dhan Algo - Running Strategies & Running Trades view (Paper Trade tab)
 *
 * A unified live view placed below the Closed Positions section. It is split
 * into two lists:
 *   - Running Strategies : every strategy the AI Smart Trading Engine is
 *     currently running, with every chart it runs on - the spot chart and/or
 *     the selected-strike option premium chart - listed separately. Each chart
 *     row has a "Show Chart" button and a "Details" button.
 *   - Running Trades     : every executed AI Smart paper trade still open.
 *     Each trade has an "Open Chart" button and a "Details" button.
 *
 * Only AST (AI Smart Trading) trades are shown here. Every other engine
 * (Pooled Strategy Runner, Smart NTrader) runs on its own isolated paper
 * engine and never appears in these lists.
 *
 * The view reads the engines' live state (no separate polling) and refreshes
 * in sync with the shared quote feed.
 */
window.createPaperRun = function (suffix) {
  'use strict';
  suffix = suffix || '';

  const $id = id => document.getElementById(id + suffix) || document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeId = s => String(s == null ? '' : s).replace(/[^a-zA-Z0-9_-]/g, '');
  const fmt2 = n => (n === null || n === undefined || isNaN(n)) ? '--' : Number(n).toFixed(2);
  const fmtMoney = n => (n === null || n === undefined || isNaN(n)) ? '--' : '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const ENGINE_TAG = {
    ast: { label: 'AI Smart', color: '#b39ddb' },
    ae: { label: 'Auto Exp', color: '#ffd700' },
    paper: { label: 'Manual', color: '#00d4aa' }
  };

  let _lastRender = 0;

  /* ---------------- engine state ---------------- */

  function aismartState() {
    const e = window.AISmartTrading;
    return (e && e.getState) ? e.getState() : null;
  }

  function aePaper() {
    return (window.AutoExperiment && AutoExperiment.paper) ? AutoExperiment.paper : null;
  }

  function isIndexSym(sym) {
    return !!(sym && (sym.inst === 'INDEX' || sym.ocExch === 'IDX_I'));
  }

  /* ---------------- running strategies collection ---------------- */

  function runningStrategies() {
    const out = [];
    const st = aismartState();
    if (st && st.enabled && window.AISmartTrading && AISmartTrading.runningStrategies) {
      const list = AISmartTrading.runningStrategies();
      (list || []).forEach(s => {
        if (!s) return;
        out.push({
          engine: 'ast',
          id: s.id != null ? s.id : s.key,
          name: s.name || 'Strategy',
          cat: s.cat || 'bullish',
          tf: s.tf || '',
          score: s.score || 0,
          method: s.method || '',
          entry: s.entry || null,
          exit: s.exit || null,
          entryExtra: s.entryExtra || null,
          exitExtra: s.exitExtra || null,
          candlestick: s.candlestick || null,
          symbol: s.symbol || null,
          runIn: st.runIn || {},
          premiumOnly: st.premiumOnly === true,
          strike: st.strike || {},
          /* Synthetic Indicator-filters-mode strategy (one per universe symbol);
             rendered with its own tag and its fetched strikes shown. */
          filterBuilt: s._filterBuilt === true,
          progress: (st.runProgress || {})[s.id != null ? s.id : s.key]
        });
      });
    }
    return out;
  }

  /* The run-in mode for a strategy: 'spot', 'premium' or 'both'. For engines
     with explicit run-in settings (AI Smart / Auto Exp) the mode follows the
     symbol type (index vs F&O stock); for AE strategies that carry a resolved
     option strike the mode is always premium. Premium-only mode locks the run
     chart to the option premium chart for every instrument type. F&O stocks
     default to the spot chart unless premium-only (or their own run-in choice)
     says otherwise. */
  function runInModeFor(s, sym) {
    if (s.premiumOnly) return 'premium';
    if (s.optionSid != null || (s.optionStrike != null && s.optionType)) return 'premium';
    const ri = s.runIn || {};
    if (!sym) {
      // AI Smart strategies run on the engine's symbol list rather than their
      // own symbol, so resolve the mode from the symbols actually traded.
      const syms = strategySymbols(s);
      sym = (syms && syms.length) ? syms[0] : null;
      if (!sym) sym = s.symbol || null;
      if (!sym && typeof selectedSymbol !== 'undefined') sym = selectedSymbol;
    }
    // Mirror the engine's runInMode(): commodities trade the FUTCOM contract
    // (spot); F&O stocks read their own "Strategy should be run in" dropdown.
    const isComm = !!(sym && (String(sym.exch || sym.ocExch || '').toUpperCase() === 'MCX_COMM' ||
      String(sym.inst || '').toUpperCase() === 'FUTCOM'));
    if (isComm) { const m = (ri && ri.comm) || 'spot'; return m === 'futures' ? 'spot' : m; }
    if (!isIndexSym(sym)) return (ri && ri.fno) || 'spot';
    return (ri && ri.index) || 'both';
  }

  /* The symbols a running strategy is actually trading on. Auto Experiment
     strategies carry their own symbol; AI Smart strategies do not, so fall back
     to the engine's active symbol list (top movers / added symbols / selected
     chart symbol). AI Paper strategies follow the currently selected chart. */
  function strategySymbols(s) {
    if (s.symbol) return [s.symbol];
    if (s.engine === 'ast' && window.AISmartTrading && AISmartTrading.experimentSymbols) {
      try {
        const syms = AISmartTrading.experimentSymbols();
        if (Array.isArray(syms) && syms.length) return syms;
      } catch (e) {}
    }
    if (typeof selectedSymbol !== 'undefined' && selectedSymbol) return [selectedSymbol];
    return [];
  }

  function spotSymbolFor(s, sym) {
    if (!sym) { sym = s.symbol; if (!sym && typeof selectedSymbol !== 'undefined') sym = selectedSymbol; }
    return sym ? JSON.parse(JSON.stringify(sym)) : null;
  }

  async function premiumSymbolFor(s, sym) {
    if (!sym) { sym = s.symbol; if (!sym && typeof selectedSymbol !== 'undefined') sym = selectedSymbol; }
    if (!sym) return null;
    const isIdx = isIndexSym(sym);
    if (s.optionSid != null) {
      return {
        id: Number(s.optionSid),
        exch: (sym.ocExch === 'BSE_FNO' ? 'BSE_FNO' : 'NSE_FNO'),
        inst: isIdx ? 'OPTIDX' : 'OPTSTK',
        name: (sym.name || '') + ' ' + s.optionStrike + ' ' + s.optionType,
        ocId: sym.ocId != null ? sym.ocId : sym.id,
        ocExch: sym.ocExch != null ? sym.ocExch : sym.exch,
        tf: s.tf
      };
    }
    const paper = aePaper();
    if (paper && paper.contractsFor) {
      try {
        const qm = (typeof clientQuotes !== 'undefined' && clientQuotes) ? clientQuotes : {};
        const qk = sym.exch === 'IDX_I' ? 'IDX_I:' + sym.id : String(sym.id);
        const sq = (qm[qk] && qm[qk].ltp != null) ? Number(qm[qk].ltp) : 0;
        const contracts = await paper.contractsFor(sym, sq);
        const c = (contracts && contracts.length) ? contracts[0] : null;
        if (c) {
          return {
            id: Number(c.sid),
            exch: (sym.ocExch === 'BSE_FNO' ? 'BSE_FNO' : 'NSE_FNO'),
            inst: isIdx ? 'OPTIDX' : 'OPTSTK',
            name: (sym.name || '') + ' ' + c.strike + ' ' + c.optionType,
            ocId: sym.ocId != null ? sym.ocId : sym.id,
            ocExch: sym.ocExch != null ? sym.ocExch : sym.exch,
            tf: s.tf
          };
        }
      } catch (e) {}
    }
    return null;
  }

  /* Every option premium chart an AI Smart strategy runs on, one row per picked
     contract. AI Smart strategies run on the engine's own resolved option
     contracts ("picked strikes" in aismart.js); each picked contract
     (sid/strike/optionType/premium) is its own chart. Falls back to the single
     legacy resolution when the engine has not picked anything for the symbol
     yet. */
  async function astPremiumChartsFor(s, sym) {
    const out = [];
    if (!window.AISmartTrading || !AISmartTrading.pickedStrikesFor) return out;
    let rec = null;
    try { rec = AISmartTrading.pickedStrikesFor(sym); } catch (e) { rec = null; }
    if (!rec || !rec.contracts || !rec.contracts.length) return out;
    const isIdx = isIndexSym(sym);
    for (const c of rec.contracts) {
      if (c.sid == null) continue;
      out.push({
        kind: 'premium',
        label: 'Option premium chart',
        sym: {
          id: Number(c.sid),
          exch: (sym.ocExch === 'BSE_FNO' ? 'BSE_FNO' : 'NSE_FNO'),
          inst: isIdx ? 'OPTIDX' : 'OPTSTK',
          name: (sym.name || '') + ' ' + c.strike + ' ' + c.optionType,
          ocId: sym.ocId != null ? sym.ocId : sym.id,
          ocExch: sym.ocExch != null ? sym.ocExch : sym.exch,
          strike: c.strike, optionType: c.optionType, premium: c.premium,
          tf: s.tf
        }
      });
    }
    return out;
  }

  /* ---------------- required capital ---------------- */

  /* AST's universal sizing settings (lots + optional manual lot-size override)
     used for the capital readout, so the money shown always matches what the
     engine would actually buy per entry. */
  function astUniversalCapital() {
    const st = aismartState();
    const u = (st && st.universal) || {};
    const lots = Math.max(1, Math.round(Number(u.lots) || 1));
    const lotSizeOverride = (u.lotSize != null && Number(u.lotSize) > 0) ? Math.max(1, Math.round(Number(u.lotSize))) : null;
    return { lots: lots, lotSizeOverride: lotSizeOverride };
  }

  /* The BASE paper engine (same one the AST engine pins every execution to).
     Its lotSizeFor() resolves an option's exchange lot from its underlying. */
  function astBaseEngine() {
    if (window.TabEngines && window.TabEngines.papertrade && window.TabEngines.papertrade.papertrade) {
      return window.TabEngines.papertrade.papertrade;
    }
    return (window.PaperTrade && window.PaperTrade.getState) ? window.PaperTrade : null;
  }

  /* Live premium of an option contract from the shared quote feed. */
  function livePremiumForSid(sid) {
    if (sid == null) return null;
    const qm = (typeof clientQuotes !== 'undefined' && clientQuotes) ? clientQuotes : {};
    const q = qm[String(sid)];
    return (q && q.ltp != null) ? Number(q.ltp) : null;
  }

  /* Required capital for ONE picked option contract, mirroring the engine's own
     sizing: qty = universal lots x (manual lot-size override or the underlying's
     exchange lot); money = qty x premium (live quote, snapshot premium as the
     fallback so the number still shows before the feed tick arrives). */
  function strikeCapital(sid, optionName, snapshotPremium) {
    const cap = astUniversalCapital();
    const base = astBaseEngine();
    let lotSize = cap.lotSizeOverride;
    if (lotSize == null) {
      lotSize = 1;
      if (base && base.lotSizeFor) {
        try { lotSize = Math.max(1, Math.round(Number(base.lotSizeFor({ name: optionName })) || 1)); }
        catch (e) { lotSize = 1; }
      }
    }
    const qty = Math.max(1, cap.lots) * Math.max(1, lotSize);
    const live = livePremiumForSid(sid);
    const premium = (live != null && live > 0) ? live
      : ((snapshotPremium != null && Number(snapshotPremium) > 0) ? Number(snapshotPremium) : null);
    const money = (premium != null && qty > 0) ? qty * premium : null;
    return { lots: cap.lots, lotSize: lotSize, qty: qty, premium: premium, money: money };
  }

  /* The unique premium contracts the Running Strategies list shows. Because
     every running AST strategy lists charts for the whole engine universe, the
     same picked strike appears under several strategies - the grand total must
     count each unique strike once, not once per strategy card. Resolved from the
     same engine data the chart rows are built from (AISmartTrading
     .pickedStrikesFor), so this is synchronous and needs no DOM probing. */
  function runningStrikeSummary() {
    const rows = [];
    const seen = {};
    if (!window.AISmartTrading || !AISmartTrading.pickedStrikesFor) return rows;
    const list = runningStrategies();
    for (const s of list) {
      if (s.engine !== 'ast') continue;
      const syms = strategySymbols(s);
      for (const sym of syms) {
        if (!sym || sym.id == null) continue;
        let rec = null;
        try { rec = AISmartTrading.pickedStrikesFor(sym); } catch (e) { rec = null; }
        if (!rec || !rec.contracts || !rec.contracts.length) continue;
        for (const c of rec.contracts) {
          if (c.sid == null) continue;
          const sid = Number(c.sid);
          if (seen[sid]) continue;
          seen[sid] = 1;
          const optionName = (sym.name || 'Symbol ' + sym.id) + ' ' + c.strike + ' ' + c.optionType;
          const cap = strikeCapital(sid, optionName, c.premium);
          rows.push({
            sid: sid,
            name: optionName,
            strike: c.strike,
            optionType: c.optionType,
            lots: cap.lots, lotSize: cap.lotSize, qty: cap.qty,
            premium: cap.premium, money: cap.money
          });
        }
      }
    }
    return rows;
  }

  function capitalBarHTML() {
    const rows = runningStrikeSummary();
    if (!rows.length) return '';
    let total = 0, priced = 0;
    const tip = [];
    rows.forEach(r => {
      if (r.money != null) { total += r.money; priced++; }
      tip.push(r.name + ' :: ' + r.qty + ' qty (' + r.lots + ' lots x ' + r.lotSize + ') x ' +
        (r.premium != null ? fmt2(r.premium) : '--') + (r.money != null ? ' = ' + fmtMoney(r.money) : ''));
    });
    return '<div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap">' +
      '<b style="color:#00d4aa;white-space:nowrap">Required capital:</b>' +
      '<b style="color:#ffd700;font-size:11px;white-space:nowrap" title="' + esc(tip.join('  |  ')) + '">' +
        (priced ? fmtMoney(total) : '--') +
      '</b>' +
      '<span style="color:#888;white-space:nowrap">' + rows.length + ' unique strike' + (rows.length === 1 ? '' : 's') + ' &middot; qty = ' + rows[0].lots + ' lots x lot size per strike</span>' +
      (priced !== rows.length ? '<span style="color:#ff9800;font-size:8px">(' + (rows.length - priced) + ' awaiting live premium)</span>' : '') +
      '</div>';
  }

  /* The charts a strategy runs on, each with its label and an opener. The spot
     chart and the selected-strike option premium charts are listed separately,
     once per symbol the strategy is actually trading on. AI Smart strategies
     list every picked premium contract as its own chart. The fetched selected
     strikes are ALWAYS listed for AI Smart strategies too - even when the run
     chart is spot (F&O stocks) the engine still resolves option contracts for
     execution, so the monitored/traded strikes stay visible in the list. */
  async function chartsForStrategy(s) {
    const syms = strategySymbols(s);
    const charts = [];
    const seen = {};
    const add = (c) => {
      if (!c || !c.sym || c.sym.id == null) return;
      const k = String(c.sym.id);
      if (seen[k]) return;
      seen[k] = 1;
      charts.push(c);
    };
    for (const sym of syms) {
      const mode = runInModeFor(s, sym);
      if (mode === 'spot' || mode === 'both') {
        const spot = spotSymbolFor(s, sym);
        if (spot) add({ kind: 'spot', label: 'Spot chart', sym: spot });
      }
      if (mode === 'premium' || mode === 'both') {
        if (s.engine === 'ast') {
          let premCharts = [];
          try { premCharts = await astPremiumChartsFor(s, sym); } catch (e) { premCharts = []; }
          if (premCharts.length) {
            premCharts.forEach(add);
            continue;
          }
        }
        const prem = await premiumSymbolFor(s, sym);
        if (prem) add({ kind: 'premium', label: 'Option premium chart', sym: prem });
      } else if (s.engine === 'ast') {
        /* Spot-run AI Smart strategy: append the fetched selected strikes
           (premium contracts resolved for execution) so they are visible. */
        let premCharts = [];
        try { premCharts = await astPremiumChartsFor(s, sym); } catch (e) { premCharts = []; }
        premCharts.forEach(add);
      }
    }
    if (!charts.length) {
      for (const sym of syms) {
        const spot = spotSymbolFor(s, sym);
        if (spot) add({ kind: 'spot', label: 'Spot chart', sym: spot });
      }
    }
    return charts;
  }

  /* ---------------- running trades collection ---------------- */

  function runningTrades() {
    const out = [];
    const st = aismartState();
    if (st && st.positions && typeof st.positions === 'object') {
      Object.keys(st.positions).forEach(k => { if (st.positions[k]) out.push({ engine: 'ast', key: k, pos: st.positions[k], src: 'ast' }); });
    }
    return out;
  }

  /* The chart's current price for a position: delegates to the single shared
     chart/candle source (tradeChartPrice in index.html) so the Running Trades
     P&L is guaranteed identical to the chart's running P&L — never the delayed
     live feed. Falls back to local chart/candle logic only if the shared
     helper is unavailable. */
  function premiumLastClose(pos) {
    if (typeof window.tradeChartPrice === 'function') return window.tradeChartPrice(pos);
    if (pos.symbolId == null) return null;
    const sid = Number(pos.symbolId);
    if (typeof selectedSymbol !== 'undefined' && selectedSymbol &&
        selectedSymbol.id === sid && window.IndChart && IndChart.getCandles) {
      const c = IndChart.getCandles();
      if (c && c.length) {
        const lc = Number(c[c.length - 1].close);
        if (lc > 0) return lc;
      }
    }
    const SE = window.StratEngine;
    const cache = (SE && SE.candleCache) || {};
    let best = null, bestAt = 0;
    for (const k in cache) {
      if (k.indexOf(sid + ':') !== 0) continue;
      const e = cache[k];
      if (e && e.candles && e.candles.length && e.at >= bestAt) {
        const lc = Number(e.candles[e.candles.length - 1].close);
        if (lc > 0) { best = lc; bestAt = e.at; }
      }
    }
    return best;
  }

  /* Current price for a position: the chart/candle close only. The live feed
     quote source (clientQuotes) was removed entirely — Running Trades P&L now
     always matches the chart's own price, never a delayed feed tick. */
  function currentPriceForPos(pos) {
    return premiumLastClose(pos);
  }

  /* A chart-openable symbol for a position. */
  function symbolForPos(pos) {
    const instr = pos.instrument || pos.instr;
    if (instr) {
      if (instr.kind === 'option' && instr.sid != null) {
        const sym = instr.symbol || {};
        const isIdx = isIndexSym(sym);
        return {
          id: Number(instr.sid),
          exch: (sym.ocExch === 'BSE_FNO' ? 'BSE_FNO' : 'NSE_FNO'),
          inst: isIdx ? 'OPTIDX' : 'OPTSTK',
          name: pos.instrumentName || ((sym.name || '') + ' ' + instr.strike + ' ' + instr.optionType),
          ocId: sym.ocId != null ? sym.ocId : null,
          ocExch: sym.ocExch != null ? sym.ocExch : null
        };
      }
      if (instr.symbol) return JSON.parse(JSON.stringify(instr.symbol));
    }
    if (pos.symbolId != null) {
      const exch = pos.symbolExch || 'NSE_EQ';
      const isOpt = pos.inst ? String(pos.inst).indexOf('OPT') >= 0 : String(exch).indexOf('FNO') >= 0;
      return {
        id: Number(pos.symbolId),
        exch: exch,
        inst: pos.inst || (isOpt ? 'OPTIDX' : (String(exch) === 'IDX_I' ? 'INDEX' : 'EQUITY')),
        name: pos.symbol || ('Symbol ' + pos.symbolId),
        ocId: pos.ocId != null ? pos.ocId : null,
        ocExch: pos.ocExch != null ? pos.ocExch : null
      };
    }
    if (typeof selectedSymbol !== 'undefined' && selectedSymbol) {
      return JSON.parse(JSON.stringify(selectedSymbol));
    }
    return null;
  }

  function tradeName(pos) {
    if (pos.instrumentName) return pos.instrumentName;
    if (pos.instrument) {
      if (pos.instrument.kind === 'option') return (pos.instrument.symbol.name || pos.instrument.symbol.id) + ' ' + pos.instrument.strike + ' ' + pos.instrument.optionType;
      return pos.instrument.symbol.name || ('Symbol ' + pos.instrument.symbol.id);
    }
    if (pos.instr) {
      if (pos.instr.kind === 'option') return (pos.instr.symbol.name || pos.instr.symbol.id) + ' ' + pos.instr.strike + ' ' + pos.instr.optionType;
      return pos.instr.symbol.name || ('Symbol ' + pos.instr.symbol.id);
    }
    return pos.symbol || ('Symbol ' + pos.symbolId);
  }

  function tradePnl(pos, cur) {
    if (cur == null || !pos.entryPrice || !pos.qty) return null;
    return pos.side === 'BUY' ? (cur - pos.entryPrice) * pos.qty : (pos.entryPrice - cur) * pos.qty;
  }

  /* ---------------- chart opening ---------------- */

  function openChartFor(sym, tf) {
    if (!sym) return;
    if (typeof selectedSymbol !== 'undefined') selectedSymbol = JSON.parse(JSON.stringify(sym));
    const label = $id('chartSymbolLabel');
    if (label) label.textContent = sym.name || ('Symbol ' + sym.id);
    const useTf = tf || sym.tf;
    if (useTf && typeof setChartTf === 'function') {
      setChartTf(useTf);
    } else if (typeof loadChart === 'function') {
      loadChart();
    }
    if (typeof activateTab === 'function') activateTab('chart');
  }

  /* ---------------- detail modal ---------------- */

  function indName(id) {
    const def = (window.IndChart && IndChart.IND) ? IndChart.IND[id] : null;
    return def ? (def.name || id) : id;
  }
  function patternName(key) {
    const CP = window.CandlePatterns;
    return (CP && CP.PATTERNS && CP.PATTERNS[key]) ? CP.PATTERNS[key].name : key;
  }
  function indSettingsShort(settings) {
    const s = settings || {};
    const p = [];
    if (s.length != null) p.push('len ' + s.length);
    if (s.factor != null) p.push('f ' + s.factor);
    if (s.atrPeriod != null) p.push('atr ' + s.atrPeriod);
    if (s.fast != null) p.push('fast ' + s.fast);
    if (s.slow != null) p.push('slow ' + s.slow);
    return p.length ? ' (' + p.join(', ') + ')' : '';
  }
  /* Human-readable entry/exit condition label. Candle-level gates (volume
     surge, fake breakout, reversal) carry no indicator id - render them with a
     real phrase instead of the old "none" placeholder. */
  function condLabel(c) {
    if (Array.isArray(c)) return c.map(x => condLabel(x)).join(' AND ');
    if (!c) return '';
    if (c.cmpType === 'candlestick_pattern' || c.cmpType === 'pattern') {
      return (c.candlePatterns || []).map(patternName).join(', ');
    }
    if (!c.indId) {
      const gates = {
        volUp: 'Volume surging up',
        volDown: 'Volume surging down',
        fakeBreakout: 'Fake breakout',
        reversal: 'Reversal',
        incUp: 'Increasing upward',
        incDown: 'Increasing downward'
      };
      return gates[c.logic] || (c.logic ? String(c.logic) : '');
    }
    const primary = indName(c.indId) + indSettingsShort(c.indSettings);
    const logicMap = {
      gt: '>', lt: '<', gte: '>=', lte: '<=', eq: '=', neq: '!=',
      crossAbove: 'crossed above', crossBelow: 'crossed below',
      crossUpNow: 'crossed above', crossDownNow: 'crossed below',
      incUp: 'increasing upward', incDown: 'increasing downward',
      closeCrossAbove: 'close crossed above', closeCrossBelow: 'close crossed below',
      gapUp: 'gap increasing vs', gapDown: 'gap decreasing vs',
      asrSupGapUp: 'support gap widening', asrResGapUp: 'resistance gap widening'
    };
    const lg = logicMap[c.logic] || c.logic;
    if (c.logic === 'incUp' || c.logic === 'incDown' || c.logic === 'asrSupGapUp' || c.logic === 'asrResGapUp') return primary + ' ' + lg;
    let cmp;
    if (c.cmpType === 'number') cmp = String(c.number);
    else if (c.cmpType === 'candle') cmp = 'candle ' + (c.candleKey || 'close');
    else if (c.cmpType === 'smoothed') cmp = 'signal (' + indName(c.indId) + ')';
    else if (c.cmpType === 'plot') cmp = 'plot (' + indName(c.indId) + ')';
    else if (c.cmpType === 'indicator') cmp = indName(c.cmpIndId) + indSettingsShort(c.cmpSettings);
    else cmp = '?';
    const bare = (c.logic === 'crossUpNow' || c.logic === 'crossDownNow' || c.logic === 'closeCrossAbove' || c.logic === 'closeCrossBelow');
    return primary + ' ' + lg + (bare || !cmp ? '' : ' ' + cmp);
  }

  function showStrategyDetail(s) {
    const m = $id('ptRunDetailModal');
    if (!m) return;
    const title = $id('ptRunDetailTitle');
    if (title) title.textContent = 'Running Strategy';
    const tag = s.filterBuilt ? { label: 'Indicator filter', color: '#b39ddb' } : (ENGINE_TAG[s.engine] || { label: s.engine, color: '#888' });
    const sideCol = s.filterBuilt ? '#b39ddb' : (s.cat === 'bearish' ? '#ef5350' : '#00d4aa');
    const sideTag = s.filterBuilt ? 'ALL' : 'LONG'; // buy-only engines: bearish strategies buy PE puts, never short
    const vCol = s.score >= 75 ? '#ffd700' : (s.score >= 60 ? '#00d4aa' : (s.score >= 45 ? '#ff9800' : '#888'));
    const mode = runInModeFor(s);
    const modeLabel = mode === 'spot' ? 'Spot chart' : (mode === 'both' ? 'Spot + option premium charts' : 'Option premium chart');
    const entryStr = condLabel(s.entry);
    const exitStr = (s.exit && (s.exit.indId || s.exit.logic || Array.isArray(s.exit)))
      ? condLabel(s.exit)
      : ((s.exitExtra && s.exitExtra.length) ? condLabel(s.exitExtra) : 'Managed by SL / Trail TP / Fixed TP');
    const entryExtraStr = s.entryExtra && s.entryExtra.length ? condLabel(s.entryExtra) : null;
    const exitExtraStr = s.exitExtra && s.exitExtra.length ? condLabel(s.exitExtra) : null;
    let patStr = 'none';
    if (s.candlestick) {
      const pe = (s.candlestick.entry || []).map(patternName).join(', ') || 'none';
      const px = (s.candlestick.exit || []).map(patternName).join(', ') || 'none';
      patStr = 'Entry: ' + pe + ' &middot; Exit: ' + px;
    }
    const body = $id('ptRunDetailBody');
    if (!body) return;
    body.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin:6px 0">' +
        '<span style="color:' + tag.color + ';font-weight:700">' + esc(tag.label) + '</span>' +
        '<span style="color:' + sideCol + ';font-weight:700">' + sideTag + '</span>' +
        '<span style="color:' + vCol + ';font-weight:700">' + (s.score || 0) + '</span>' +
        (s.tf ? '<span style="color:#888">' + esc(s.tf) + '</span>' : '') +
      '</div>' +
      '<div style="margin:6px 0;color:#fff;font-size:12px;font-weight:700">' + esc(s.name) + '</div>' +
      '<div style="margin:6px 0"><b style="color:#00d4aa">Run-in chart:</b> ' + modeLabel + '</div>' +
      '<div style="margin:6px 0"><b style="color:' + progressView(s).color + '">Progress:</b> ' + Math.round(progressView(s).pct) + '% &middot; ' + esc(progressView(s).status) + '</div>' +
      (s.method ? '<div style="margin:6px 0"><b style="color:#00d4aa">Method:</b> ' + esc(s.method) + '</div>' : '') +
      '<div style="margin:6px 0"><b style="color:#00d4aa">Entry:</b> ' + esc(entryStr) + '</div>' +
      (entryExtraStr ? '<div style="margin:6px 0"><b style="color:#00d4aa">Entry extra (AND):</b> ' + esc(entryExtraStr) + '</div>' : '') +
      '<div style="margin:6px 0"><b style="color:#00d4aa">Exit:</b> ' + esc(exitStr) + '</div>' +
      (exitExtraStr ? '<div style="margin:6px 0"><b style="color:#00d4aa">Exit extra (OR):</b> ' + esc(exitExtraStr) + '</div>' : '') +
      '<div style="margin:6px 0"><b style="color:#00d4aa">Candlestick:</b> ' + patStr + '</div>' +
      '<div style="margin:6px 0;color:#888">Live view of the strategy this engine is currently running.</div>';
    m.classList.remove('hidden');
  }

  function showTradeDetail(t) {
    const m = $id('ptRunDetailModal');
    if (!m) return;
    const title = $id('ptRunDetailTitle');
    if (title) title.textContent = 'Running Trade';
    const tag = ENGINE_TAG[t.engine] || { label: t.engine, color: '#888' };
    const p = t.pos;
    const sideCol = p.side === 'BUY' ? '#00d4aa' : '#ef5350';
    const cur = currentPriceForPos(p);
    const pnl = tradePnl(p, cur);
    const pnlCol = pnl == null ? '#888' : (pnl >= 0 ? '#00d4aa' : '#ef5350');
    const d = new Date(p.openedAt || Date.now());
    const ts = (window.IST12 && IST12.fmtMsDT) ? IST12.fmtMsDT(p.openedAt || Date.now()) : d.toLocaleDateString('en-IN') + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
    const body = $id('ptRunDetailBody');
    if (!body) return;
    body.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin:6px 0">' +
        '<span style="color:' + tag.color + ';font-weight:700">' + esc(tag.label) + '</span>' +
        '<span style="color:' + sideCol + ';font-weight:700">' + (p.side === 'BUY' ? 'LONG' : 'SHORT') + '</span>' +
        '<span style="color:#888;font-size:10px">' + esc(t.src || '') + '</span>' +
      '</div>' +
      '<div style="margin:6px 0;color:#fff;font-size:12px;font-weight:700">' + esc(tradeName(p)) + '</div>' +
      '<div style="margin:6px 0"><b style="color:#00d4aa">Qty:</b> ' + p.qty + (p.lots != null ? ' (lots ' + p.lots + ' x ' + p.lotSize + ')' : '') + '</div>' +
      '<div style="margin:6px 0"><b style="color:#00d4aa">Entry:</b> ' + fmt2(p.entryPrice) + ' &rarr; LTP ' + (cur != null ? fmt2(cur) : '--') + '</div>' +
      '<div style="margin:6px 0"><b style="color:#00d4aa">TP:</b> ' + fmt2(p.targetPrice) + '</div>' +
      '<div style="margin:6px 0"><b style="color:#00d4aa">SL:</b> ' + fmt2(p.stopLoss) + '</div>' +
      '<div style="margin:6px 0"><b style="color:' + pnlCol + '">P&L:</b> ' + (pnl == null ? '--' : (pnl >= 0 ? '+' : '') + fmtMoney(pnl)) + (pnl != null ? ' (' + fmt2(p.entryPrice && p.qty ? (pnl / (p.entryPrice * p.qty)) * 100 : 0) + '%)' : '') + '</div>' +
      '<div style="margin:6px 0"><b style="color:#00d4aa">Opened:</b> ' + ts + '</div>' +
      '<div style="margin:6px 0"><b style="color:#00d4aa">Status:</b> ' + esc(p.status || 'OPEN') + '</div>' +
      '<div style="margin:6px 0;color:#888">Executed paper trade, still running on the market feed.</div>';
    m.classList.remove('hidden');
  }

  /* ---------------- rendering ---------------- */

  /* Per-strategy pipeline progress for the progress bar: furthest stage reached
     in the last engine tick (0-100), the status text (why it stopped there) and
     a color. A missing or stale entry (>60s without a tick update) shows as
     idle so a strategy the engine no longer processes stands out. */
  function progressView(s) {
    const p = s.progress;
    const now = Date.now();
    const fresh = !!(p && p.updated && (now - p.updated) < 60000);
    const pct = (p && p.pct != null) ? Math.max(0, Math.min(100, Number(p.pct))) : 0;
    let status = 'Waiting for engine data';
    if (p && p.status) status = fresh ? p.status : p.status + ' (idle)';
    const txt = status.toLowerCase();
    let color = '#66ccff';
    if (txt.indexOf('placed') >= 0) color = '#00d4aa';
    else if (txt.indexOf('rejected') >= 0 || txt.indexOf('blocked') >= 0 || txt.indexOf('no live') >= 0) color = '#ff9800';
    return { pct, status, color, fresh };
  }

  function progressBarHTML(s) {
    const v = progressView(s);
    const pct = Math.round(v.pct);
    const fill = pct > 0 ? ('width:' + pct + '%;') : 'width:0%;';
    return '<div style="margin:4px 0 2px">' +
      '<div style="display:flex;align-items:center;gap:6px">' +
        '<div style="flex:1;background:#1a1a38;border:1px solid #2d2d50;border-radius:3px;height:7px;overflow:hidden">' +
          '<div style="height:100%;' + fill + 'background:' + v.color + ';transition:width .5s ease"></div>' +
        '</div>' +
        '<span style="color:' + v.color + ';font-size:8px;min-width:28px;text-align:right;font-weight:700">' + pct + '%</span>' +
      '</div>' +
      '<div style="margin-top:2px;font-size:8px;color:' + v.color + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="' + esc(v.status) + '">' + esc(v.status) + '</div>' +
    '</div>';
  }

  function strategyRowHTML(s) {
    const tag = s.filterBuilt ? { label: 'Indicator filter', color: '#b39ddb' } : (ENGINE_TAG[s.engine] || { label: s.engine, color: '#888' });
    const sideCol = s.filterBuilt ? '#b39ddb' : (s.cat === 'bearish' ? '#ef5350' : '#00d4aa');
    const sideTag = s.filterBuilt ? 'ALL' : 'LONG'; // buy-only engines: bearish strategies buy PE puts, never short
    const vCol = s.score >= 75 ? '#ffd700' : (s.score >= 60 ? '#00d4aa' : (s.score >= 45 ? '#ff9800' : '#888'));
    const mode = runInModeFor(s);
    const modeLabel = mode === 'spot' ? 'Spot' : (mode === 'both' ? 'Spot + Premium' : 'Premium');
    return '<div style="background:#12122a;border:1px solid #2d2d50;border-radius:4px;padding:5px 8px;margin:2px 0;font-size:10px">' +
      '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">' +
        '<span style="color:' + tag.color + ';font-weight:700;min-width:56px">' + esc(tag.label) + '</span>' +
        '<span style="color:' + sideCol + ';font-weight:700;min-width:38px">' + sideTag + '</span>' +
        '<span style="color:#fff;flex:1;min-width:110px">' + esc(s.name) + (s.tf ? ' <span style="color:#666">· ' + esc(s.tf) + '</span>' : '') + '</span>' +
        '<span style="color:' + vCol + ';min-width:30px;text-align:right">' + (s.score || 0) + '</span>' +
        '<span style="color:#66ccff;min-width:70px;text-align:right;font-size:9px">' + modeLabel + '</span>' +
        '<button class="btn-action" style="width:auto;padding:2px 8px;margin:0;font-size:9px" onclick="PaperRun.strategyDetails(\'' + safeId(s.id) + '\', \'' + safeId(s.engine) + '\')">Details</button>' +
        '<button class="btn-action" style="width:auto;padding:2px 8px;margin:0;font-size:9px;background:#ef5350;color:#fff" onclick="PaperRun.closeStrategy(\'' + safeId(s.id) + '\', \'' + safeId(s.engine) + '\')">Close</button>' +
      '</div>' +
      progressBarHTML(s) +
      '<div id="pr-charts-' + safeId(s.id) + '-' + safeId(s.engine) + '"></div>' +
    '</div>';
  }

  function chartRowHTML(s, chart, idx) {
    const symOk = chart.sym ? 1 : 0;
    let moneyChip = '';
    if (chart.kind === 'premium' && symOk && chart.sym.id != null) {
      const cap = strikeCapital(chart.sym.id, chart.sym.name || '', chart.sym.premium);
      const detail = (cap.money != null) ? fmtMoney(cap.money)
        : (cap.premium != null ? 'qty ' + cap.qty + ' x ' + fmt2(cap.premium) + ' (pending)' : '--');
      moneyChip = '<span style="color:#ffd700;min-width:86px;text-align:right;font-size:9px;font-weight:700;white-space:nowrap" title="Required: ' + cap.lots + ' lots x ' + cap.lotSize + ' lot size = qty ' + cap.qty + ' x premium ' + (cap.premium != null ? fmt2(cap.premium) : '--') + ' = ' + (cap.money != null ? fmtMoney(cap.money) : '--') + '">' +
        esc(detail) + '</span>';
    }
    return '<div style="display:flex;align-items:center;gap:6px;padding:2px 0 2px 10px;font-size:9px;color:#888">' +
      '<span style="color:#66ccff">' + (chart.kind === 'spot' ? 'Spot' : 'Premium') + '</span>' +
      '<span style="color:#aaa;flex:1;min-width:80px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(chart.sym ? chart.sym.name : 'no chart') + '</span>' +
      moneyChip +
      (symOk
        ? '<button class="btn-action" style="width:auto;padding:1px 6px;margin:0;font-size:8px" onclick="PaperRun.showChart(\'' + safeId(s.id) + '\', \'' + safeId(s.engine) + '\', ' + idx + ')">Show Chart</button>'
        : '<span style="color:#ff9800;font-size:8px">unavailable</span>') +
      '</div>';
  }

  function tradeRowHTML(t, idx) {
    const tag = ENGINE_TAG[t.engine] || { label: t.engine, color: '#888' };
    const p = t.pos;
    const sideCol = p.side === 'BUY' ? '#00d4aa' : '#ef5350';
    const cur = currentPriceForPos(p);
    const pnl = tradePnl(p, cur);
    /* Running Trades shows GROSS P&L only — no broker-charge deduction while
       the trade is open. Charges (entry + exit round-trip) are applied ONCE
       when the trade CLOSES and are shown net in Closed Positions. */
    const pnlCol = pnl == null ? '#888' : (pnl >= 0 ? '#00d4aa' : '#ef5350');
    const name = tradeName(p);
    const sym = symbolForPos(p);
    return '<div style="background:#12122a;border:1px solid #2d6d5a;border-radius:4px;padding:5px 8px;margin:2px 0;font-size:10px">' +
      '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">' +
        '<span style="color:' + tag.color + ';font-weight:700;min-width:56px">' + esc(tag.label) + '</span>' +
        '<span style="color:' + sideCol + ';font-weight:700;min-width:38px">' + (p.side === 'BUY' ? 'LONG' : 'SHORT') + '</span>' +
        '<span style="color:#fff;flex:1;min-width:100px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(name) + '</span>' +
        (p.orderType === 'LIMIT' ? '<span style="color:#ffd700;font-size:8px;border:1px solid #ffd700;border-radius:3px;padding:0 3px">LIMIT</span>' : '') +
        '<span style="color:#888;min-width:60px">' + fmt2(p.entryPrice) + ' &rarr; ' + (cur != null ? fmt2(cur) : '--') + '</span>' +
        '<span style="color:' + pnlCol + ';min-width:80px;text-align:right">' + (pnl == null ? '--' : (pnl >= 0 ? '+' : '') + fmtMoney(pnl)) + '</span>' +
        (sym
          ? '<button class="btn-action" style="width:auto;padding:2px 8px;margin:0;font-size:9px" onclick="PaperRun.openTradeChart(' + idx + ')">Open Chart</button>'
          : '') +
        '<button class="btn-action" style="width:auto;padding:2px 8px;margin:0;font-size:9px" onclick="PaperRun.tradeDetails(' + idx + ')">Details</button>' +
        '<button class="btn-action" style="width:auto;padding:2px 8px;margin:0;font-size:9px;background:#ef5350;color:#fff" onclick="PaperRun.closeTrade(' + idx + ')">Close</button>' +
      '</div>' +
    '</div>';
  }

  function emptyHTML(msg) {
    return '<div style="color:#666;font-size:10px;padding:4px 8px">' + msg + '</div>';
  }

  /* Cache the rendered chart rows per strategy so we don't re-resolve option
     contracts (async) on every quote tick. The key folds in the symbols the
     strategy trades on so the cache refreshes when the symbol set changes. */
  let _chartCache = {};
  /* Resolved chart list per cache key. Keeping the resolved lists (not just
     promises) lets re-renders paint the chart rows synchronously. */
  let _chartLists = {};
  /* Last successfully shown chart list per strategy. When a fresh resolve is
     needed (first load / engine re-pick / cache-key change) the OLD strikes
     stay visible until the new set resolves, so the rows never flash empty. */
  let _lastListByStrat = {};

  function _stratKey(s) { return String(s.engine) + ':' + String(s.id); }

  function _stratChartList(s) { return _lastListByStrat[_stratKey(s)] || null; }

  function chartCacheKey(s) {
    let key = String(s.engine) + ':' + String(s.id) + ':' +
      strategySymbols(s).map(x => (x && x.id != null ? String(x.id) : '') + ':' + (x && (x.exch || ''))).join(',');
    /* AI Smart chart rows come from the engine's live picked strikes; fold a
       fingerprint of THE STRATEGY'S OWN symbols into the key so the cache
       refreshes when the engine resolves new/extra premium contracts for the
       symbols this strategy actually trades. Folding every engine-wide pick
       in made an unrelated symbol's re-pick invalidate every strategy's cache
       at once, which is what made whole lists of strikes blink out together. */
    if (s.engine === 'ast' && window.AISmartTrading && AISmartTrading.pickedStrikesFor) {
      try {
        const syms = strategySymbols(s);
        for (const sym of syms) {
          if (!sym || sym.id == null) continue;
          const rec = AISmartTrading.pickedStrikesFor(sym);
          if (rec && rec.contracts) key += ':' + String(sym.id) + ':' + rec.contracts.length;
        }
      } catch (e) {}
    }
    return key;
  }

  function _fillChartRows(s, chartList) {
    const sub = $id('pr-charts-' + safeId(s.id) + '-' + safeId(s.engine));
    if (!sub) return;
    const l = chartList || [];
    sub.innerHTML = l.map((c, i) => chartRowHTML(s, c, i)).join('') || '';
    if (l.length) _lastListByStrat[_stratKey(s)] = l;
  }

  async function renderStrategies() {
    const host = $id('ptRunStrategies');
    if (!host) return;
    const bar = $id('ptRunCapitalBar');
    const list = runningStrategies();
    if (!list.length) {
      if (bar) { bar.style.display = 'none'; bar.innerHTML = ''; }
      host.innerHTML = emptyHTML('No running strategies. Toggle AI Smart Trading ON in the Paper Trade tab to start strategies.');
      return;
    }
    const barHTML = capitalBarHTML();
    if (bar) {
      if (barHTML) { bar.style.display = 'flex'; bar.innerHTML = barHTML; }
      else { bar.style.display = 'none'; bar.innerHTML = ''; }
    }
    const items = list.map(s => ({ s: s, ck: chartCacheKey(s) }));
    host.innerHTML = items.map(({ s }) => strategyRowHTML(s)).join('');
    for (const { s, ck } of items) {
      const resolved = _chartLists[ck];
      if (resolved) {
        _fillChartRows(s, resolved);
        continue;
      }
      /* No resolved charts for this cache key yet. Keep the strategy's last
         shown strikes visible while the new resolve is in flight so a re-pick
         never blanks the list, then swap in the fresh set when it lands. */
      const prev = _stratChartList(s);
      if (prev && prev.length) _fillChartRows(s, prev);
      if (!_chartCache[ck]) {
        _chartCache[ck] = chartsForStrategy(s).then((chartList) => {
          const l = chartList || [];
          _chartLists[ck] = l;
          _fillChartRows(s, l);
          return l;
        }, () => {
          /* drop a rejected promise so it refetches next render */
          delete _chartCache[ck];
        });
      } else {
        _chartCache[ck].then(() => {
          const l = _chartLists[ck];
          if (l) _fillChartRows(s, l);
        });
      }
    }
  }

  /* Margin/balance bar for the Running Trades list, mirroring the Required
     capital bar above the Running Strategies list. The balance is the AI Smart
     engine's own Margin input; the locked amount is the total cost (qty x entry)
     of the open running trades shown in the list, so the "Available now" number
     always reflects what a NEXT trade could still use. */
  function tradeMarginStats() {
    const st = aismartState();
    const u = (st && st.universal) || {};
    const budget = (Number(u.margin) > 0) ? Number(u.margin)
      : (() => { const el = document.getElementById('astMargin'); return el ? (Number(el.value) || 0) : 0; })();
    /* AE-imported strategies run on their own AE margin (per-origin cap), so
       their trades never lock the AI Smart budget - they are reported in a
       separate AE readout below the bar. */
    const wAP = (() => {
      try {
        const reg = window.TabEngines && window.TabEngines.papertrade;
        const base = reg && reg.papertrade;
        return (base && base.getAutoPositions) ? (base.getAutoPositions() || {}) : {};
      } catch (e) { return {}; }
    })();
    let locked = 0, count = 0, aeLocked = 0, aeCount = 0;
    const list = runningTrades();
    for (const t of list) {
      const p = t && t.pos;
      if (p && p.qty && p.entryPrice) {
        const b = wAP[t.key];
        if (b && b.budgetCap > 0) { aeLocked += p.qty * p.entryPrice; aeCount++; continue; }
        locked += p.qty * p.entryPrice; count++;
      }
    }
    const avail = budget > 0 ? Math.max(0, budget - locked) : 0;
    return { budget, locked, count, available: avail, capped: budget > 0, aeLocked, aeCount };
  }

  function updateTradeMarginBar() {
    const bar = $id('ptRunTradeCapitalBar');
    if (!bar) return;
    const m = tradeMarginStats();
    const openN = runningTrades().length;
    if (!m.capped && openN === 0) {
      bar.style.display = 'none';
      bar.innerHTML = '';
      return;
    }
    const tip = 'Balance (AI Smart Margin) - Locked in ' + m.count + ' running trade' + (m.count === 1 ? '' : 's') + ' = Available now.';
    bar.style.display = 'flex';
    let h =
      '<b style="color:#00d4aa;white-space:nowrap">Trade margin:</b>' +
      '<b style="color:#ffd700;font-size:11px;white-space:nowrap">' + fmtMoney(m.budget) + '</b>' +
      '<span style="color:#888;white-space:nowrap">Locked by ' + m.count + ' running trade' + (m.count === 1 ? '' : 's') + ': <b style="color:#ffd700">' + fmtMoney(m.locked) + '</b></span>' +
      '<span style="color:#888;white-space:nowrap">Available now: <b style="color:' + (m.available > 0 ? '#00d4aa' : '#ef5350') + '">' + fmtMoney(m.available) + '</b></span>' +
      '<span title="' + esc(tip) + '" style="color:#666;font-size:8px">next trade is blocked + warned when its required margin &gt; available</span>';
    if (m.aeCount) {
      h += '<span style="color:#b39ddb;white-space:nowrap" title="AE-imported strategies run on the Auto Experiment margin they were created under">AE trades (' + m.aeCount + '): <b style="color:#b39ddb">' + fmtMoney(m.aeLocked) + ' locked</b></span>';
    }
    bar.innerHTML = h;
  }

  function renderTrades() {
    const host = $id('ptRunTrades');
    if (!host) return;
    updateTradeMarginBar();
    const list = runningTrades();
    if (!list.length) {
      host.innerHTML = emptyHTML('No running trades. AI Smart paper trades that are still open appear here.');
      return;
    }
    /* Render each row defensively: one malformed position (e.g. a stale or
       partial record) must not kill the whole live P&L list. */
    const rows = [];
    for (let i = 0; i < list.length; i++) {
      try { rows.push(tradeRowHTML(list[i], i)); }
      catch (e) {}
    }
    host.innerHTML = rows.join('') || emptyHTML('No running trades. Executed paper trades that are still open appear here.');
  }

  async function render(force) {
    const now = Date.now();
    if (!force && now - _lastRender < 1500) return;
    _lastRender = now;
    /* Running Trades is cheap and quote-driven - render it FIRST so a slow or
       failing strategy-chart lookup can never freeze the live P&L. */
    renderTrades();
    try { await renderStrategies(); } catch (e) {}
  }

  /* ---------------- public API ---------------- */

  const api = {
    refresh() { render(true); },

    render,

    /* Close button on a running trade row: squares off that specific position.
       The closed trade then drops out of Running Trades and is recorded by the
       owning engine's own closed list. */
    closeTrade(idx) {
      const t = runningTrades()[idx];
      if (!t) return;
      const p = t.pos;
      if (t.engine === 'ast' && window.AISmartTrading) {
        if (AISmartTrading.stopPosition && p.strategyId) AISmartTrading.stopPosition(p.strategyId);
      }
      render(true);
    },

    /* Close button on a running strategy row: stops the strategy (un-ticks or
       un-deploys it) and squares off any of its open paper positions. */
    closeStrategy(id, engine) {
      const s = runningStrategies().find(x => safeId(x.id) === id && safeId(x.engine) === engine);
      if (!s) return;
      if (engine === 'ast' && window.AISmartTrading) {
        if (AISmartTrading.onStrategyCheck) AISmartTrading.onStrategyCheck(s.id, false);
        if (AISmartTrading.stopPosition) { try { AISmartTrading.stopPosition(s.id); } catch (e) {} }
      }
      _chartCache = {};
      _chartLists = {};
      _lastListByStrat = {};
      render(true);
    },

    /* Close every open paper trade across all engines and stop every running
       strategy so no trade can re-enter afterwards (positions only would let
       the still-running strategies open fresh trades on the next poll). The
       engine toggles stay ON - the close is permanent because strategies are
       unticked / undeployed and positions are persisted as closed. */
    closeAllTrades() {
      if (window.AISmartTrading && AISmartTrading.stopAllStrategies) { try { AISmartTrading.stopAllStrategies(true); } catch (e) {} }
      else if (window.AISmartTrading && AISmartTrading.stopAll) { try { AISmartTrading.stopAll(); } catch (e) {} }
      if (window.PaperTrade) {
        const pt = (PaperTrade.getState && PaperTrade.getState()) || null;
        if (pt && pt.autoPositions) {
          Object.keys(pt.autoPositions).forEach(k => { if (PaperTrade.autoExit) { try { PaperTrade.autoExit(k); } catch (e) {} } });
        }
        if (pt && pt.position && PaperTrade.closePosition) { try { PaperTrade.closePosition(); } catch (e) {} }
        if (pt && PaperTrade.save) { try { PaperTrade.save(); } catch (e) {} }
      }
      render(true);
    },

    /* Stop every running strategy across all engines (un-tick / un-deploy and
       turn off AI-pick modes), also squaring off their open positions. */
    closeAllStrategies() {
      if (window.AISmartTrading) {
        if (AISmartTrading.stopAllStrategies) { try { AISmartTrading.stopAllStrategies(); } catch (e) {} }
        else { if (AISmartTrading.selectNone) AISmartTrading.selectNone(); if (AISmartTrading.stopAll) AISmartTrading.stopAll(); }
      }
      _chartCache = {};
      _chartLists = {};
      _lastListByStrat = {};
      render(true);
    },

    /* Show Chart button on a running strategy chart row. */
    async showChart(id, engine, idx) {
      const list = runningStrategies().filter(s => safeId(s.id) === id && safeId(s.engine) === engine);
      if (!list.length) return;
      const s = list[0];
      const ck = chartCacheKey(s);
      if (!_chartCache[ck]) _chartCache[ck] = chartsForStrategy(s);
      const chartList = await _chartCache[ck];
      const chart = chartList && chartList[idx];
      if (chart && chart.sym) {
        openChartFor(chart.sym, s.tf);
      } else {
        openChartFor(spotSymbolFor(s), s.tf);
      }
    },

    /* Open Chart button on a running trade row. */
    openTradeChart(idx) {
      const list = runningTrades();
      const t = list[idx];
      if (!t) return;
      const sym = symbolForPos(t.pos);
      if (sym) openChartFor(sym);
    },

    strategyDetails(id, engine) {
      const s = runningStrategies().find(x => safeId(x.id) === id && safeId(x.engine) === engine);
      if (s) showStrategyDetail(s);
    },

    tradeDetails(idx) {
      const t = runningTrades()[idx];
      if (t) showTradeDetail(t);
    },

    closeDetail() {
      const m = $id('ptRunDetailModal');
      if (m) m.classList.add('hidden');
    }
  };

  if (!window.TabEngines) window.TabEngines = {};
  if (!window.TabEngines.paperrun) window.TabEngines.paperrun = {};
  const instKey = suffix.replace(/^_/, '') || 'papertrade';
  window.TabEngines.paperrun[instKey] = api;

  /* Pop the Close-button margin warning for this tab's own paper engine wallet
     when the engine refuses a NEXT auto trade (insufficient margin). The base
     AI Smart engine instance is registered as 'papertrade', so only the base
     Running view listens (duplicated paper tabs share that engine instance). */
  if (instKey === 'papertrade' && typeof document !== 'undefined' && document.addEventListener && window.CustomEvent) {
    document.addEventListener('paperAutoMarginBlock', (ev) => {
      const d = ev && ev.detail;
      if (!d || d.engine !== 'papertrade') return;
      if (window.PaperMarginModal && typeof window.PaperMarginModal.show === 'function') {
        try { window.PaperMarginModal.show(d); } catch (e) {}
      }
      render(true);
    });
  }

  if (!window._PaperRunFacade) {
    const base = api;
    window._PaperRunFacade = new Proxy(base, {
      get(t, prop) {
        const key = window._paperActiveEngine || 'papertrade';
        const eng = window.TabEngines.paperrun[key] || t;
        const v = eng[prop];
        return typeof v === 'function' ? v.bind(eng) : v;
      },
      set(t, prop, val) {
        const key = window._paperActiveEngine || 'papertrade';
        const eng = window.TabEngines.paperrun[key] || t;
        eng[prop] = val;
        return true;
      }
    });
    window.PaperRun = window._PaperRunFacade;
  }
  return api;
}
