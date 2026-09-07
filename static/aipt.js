/* Dhan Algo - AI Paper Trade (smart AI-driven paper trading system)
 *
 * Imports only the scored STRATEGY TEMPLATES produced by the Auto Experiment
 * engine (no symbol/strike info - the experiment's per-stock results are
 * de-duplicated down to their unique strategies). The imported strategies are
 * run on the CURRENT chart symbol.
 *
 * Two independent selection modes decide which strategies trade:
 *   - Manual select  : enable/disable checkbox, then tick each strategy.
 *   - AI smart pick  : enable/disable checkbox + a number input; the AI
 *                      automatically picks the top-N highest-scoring strategies.
 *
 * The AI brain (`analyze`) reads the chart in one pass and derives an
 * entry/exit plan from candlestick patterns, symmetry, structure,
 * consolidation, liquidity grabbing, up to 10 overlay + 10 pane indicators
 * (crossed-above / crossed-below / gt / lt / increasing-up / increasing-down),
 * and the EMA 9/21 gap. The strategy's own entry/exit conditions (evaluated via
 * window.StratEngine) are ANDed with the AI confirmation.
 *
 * Positions are held per strategy (not per symbol) so many strategies can run
 * on the same symbol at once. Live P&L / realized P&L / win rate / trades are
 * aggregated across all running strategies and shown with a live "Open Chart"
 * button in the Paper Trade tab.
 *
 * Paper trading remains fully simulated (no real money).
 */
window.createAIPaperTrade = function (suffix) {
  'use strict';
  suffix = suffix || '';

  const SAVE_KEY = 'algodhan_aipt_v1' + suffix;
  const POLL_MS = 1500;

  const $id = id => document.getElementById(id + suffix) || document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (v, lo, hi) => v < lo ? lo : (v > hi ? hi : v);
  const fmt2 = n => (n === null || n === undefined || isNaN(n)) ? '--' : Number(n).toFixed(2);
  const fmtMoney = n => (n === null || n === undefined || isNaN(n)) ? '--' : '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function setText(id, text, color) {
    const el = $id(id);
    if (!el) return;
    el.textContent = text;
    if (color) el.style.color = color;
  }

  /* ---------------- state ---------------- */
  let state = load();

  function defaultState() {
    return {
      strategies: [],     // imported scored strategy templates (symbol-agnostic)
      autoTrade: false,   // master AI autotrader toggle
      manualMode: false,  // manual checkbox selection mode
      aiMode: false,      // AI smart top-N selection mode
      aiTopNBull: 5,
      aiTopNBear: 5,
      selected: {},       // strategy key -> boolean (manual selection)
      removedKeys: {},    // strategy key -> true for strategies the user removed
      minConf: 0.55,      // minimum AI confidence to act
      positions: {},      // "strategyKey@instrumentId" -> open position
      closed: [],         // closed AI trades
      lots: 1,
      margin: 100000,
      tradeCounts: {},    // strategy key -> trades taken today (Max trades / AI auto trades)
      tradeCountDay: '',
      runProgress: {}     // strategy key -> { pct, status, updated } live per-tick pipeline progress
    };
  }

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
      if (s) {
        const d = Object.assign(defaultState(), s);
        if (!d.removedKeys || typeof d.removedKeys !== 'object') d.removedKeys = {};
        return d;
      }
    } catch (e) {}
    return defaultState();
  }

  function save() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  /* ---------------- scoring / categorization ---------------- */
  function categoryOf(score) {
    if (score >= 75) return 'Elite';
    if (score >= 60) return 'Good';
    if (score >= 45) return 'Moderate';
    return 'Weak';
  }

  const CAT_COLOR = { Elite: '#ffd700', Good: '#00d4aa', Moderate: '#ff9800', Weak: '#888' };

  /* ---------------- detail rendering (read-only) ---------------- */
  function indName(id) {
    const def = (window.IndChart && IndChart.IND) ? IndChart.IND[id] : null;
    return def ? (def.name || id) : id;
  }
  function patternName(key) {
    const CP = window.CandlePatterns;
    return (CP && CP.PATTERNS && CP.PATTERNS[key]) ? CP.PATTERNS[key].name : key;
  }
  function indSettingsLabel(settings) {
    if (!settings) return '';
    const keys = ['length', 'fast', 'slow', 'signal', 'atrPeriod', 'factor', 'maLength', 'smooth', 'signalLength', 'mult'];
    const parts = [];
    keys.forEach(k => { if (settings[k] != null && settings[k] !== '') parts.push(k + '=' + settings[k]); });
    if (!parts.length) return '';
    return ' (' + parts.join(', ') + ')';
  }
  function condLabel(c, join) {
    if (Array.isArray(c)) return c.map(x => condLabel(x, join)).join(join || ' AND ');
    if (!c) return 'none';
    if (c.cmpType === 'candlestick_pattern' || c.cmpType === 'pattern') {
      return (c.candlePatterns || []).map(patternName).join(', ');
    }
    if (!c.indId) return 'none';
    const primary = indName(c.indId);
    const logicMap = { gt: '>', lt: '<', gte: '>=', lte: '<=', eq: '=', neq: '!=', crossAbove: 'crosses above', crossBelow: 'crosses below', incUp: 'increasing upward', incDown: 'increasing downward' };
    const lg = logicMap[c.logic] || c.logic;
    if (c.logic === 'incUp' || c.logic === 'incDown') return primary + ' ' + lg;
    let cmp;
    if (c.cmpType === 'number') cmp = c.number;
    else if (c.cmpType === 'candle') cmp = 'candle ' + (c.candleKey || 'close');
    else if (c.cmpType === 'smoothed') cmp = 'signal (' + indName(c.indId) + ')';
    else if (c.cmpType === 'plot') cmp = 'plot (' + indName(c.indId) + ')';
    else if (c.cmpType === 'indicator') cmp = indName(c.cmpIndId) + indSettingsLabel(c.cmpSettings);
    else cmp = '?';
    return primary + indSettingsLabel(c.indSettings) + ' ' + lg + ' ' + cmp;
  }

  /* ---------------- import (strategies only, no symbol) ---------------- */

  /* Normalize an Auto Experiment result into the symbol-agnostic strategy
     shape stored in the paper-trade list. Strips the strike/CE/PE suffix the
     experiment appends to the template name, so the paper-trade list shows the
     pure strategy (it runs on the current chart symbol, not the experiment's
     option strike). */
  function strategyFromResult(r) {
    let cleanName = r.name || 'Strategy';
    if (r.optionStrike != null && r.optionType) {
      const suffix = ' ' + r.optionStrike + ' ' + r.optionType;
      if (cleanName.endsWith(suffix)) cleanName = cleanName.slice(0, -suffix.length);
    }
    return {
      key: r.tplKey || r.name,
      name: cleanName,
      cat: r.cat || 'bullish',
      method: r.method || '',
      tf: r.tf || (typeof chartTf !== 'undefined' ? chartTf : '5min'),
      score: r.score || 0,
      verdict: r.verdict || categoryOf(r.score || 0),
      entry: r.entry || null,
      exit: r.exit || null,
      entryExtra: r.entryExtra || null,
      exitExtra: r.exitExtra || null,
      entryThreshold: r.entryThreshold != null ? r.entryThreshold : null,
      candlestick: r.candlestick || { enabled: false, entry: [], exit: [] }
    };
  }

  /* De-duplicate the Auto Experiment results down to their unique strategy
     templates (an experiment runs each template across many symbols/strikes).
     Keeps the highest-scoring instance of each unique strategy. */
  function importFromAE(opts) {
    opts = opts || {};
    const ae = window.AutoExperiment;
    if (!ae || !ae.getState) { if (!opts.silent) log('Auto Experiment engine not ready', 'warn'); return 0; }
    const st = ae.getState();
    const results = (st && st.results) || [];

    /* An empty result set must not wipe the imported list. "Remove All" in the
       Auto Experiment engine clears its own results; if an auto re-import (boot /
       tab-show) or an explicit "Send to Paper Trade" then ran against that empty
       set, it would silently delete the user's paper-trade strategies. Only a
       send with actual results may replace the list. */
    if (!results.length) {
      if (!opts.silent) log('No auto experiment results to import - keeping existing strategies', 'warn');
      return 0;
    }

    /* When the caller passes an explicit selection of result keys (the Auto
       Experiment engine's ticked result cards), import only those and treat the
       explicit re-selection as re-adding them. Otherwise import every unique
       strategy, but skip any strategy the user explicitly removed from this
       paper-trade list so a later "Send to Paper Trade" never silently brings
       back an old removed bullish/bearish strategy. */
    if (!state.removedKeys || typeof state.removedKeys !== 'object') state.removedKeys = {};
    const onlyKeys = (opts.onlyKeys && opts.onlyKeys.length) ? new Set(opts.onlyKeys) : null;
    let src;
    if (onlyKeys) {
      src = results.filter(r => onlyKeys.has(r.key));
      src.forEach(r => { delete state.removedKeys[r.tplKey || r.name]; });
    } else {
      src = results.filter(r => !state.removedKeys[r.tplKey || r.name]);
    }
    if (!src.length) {
      if (!opts.silent) log('No new strategies to import - keeping existing strategies', 'warn');
      return 0;
    }

    /* Merge the imported strategies into the existing paper-trade list instead
       of replacing it. Sending only the bullish (or only the bearish) cards
       from an experiment must never wipe out the opposite side that is already
       imported and trading; each side's strategies survive their own separate
       list until the user explicitly removes them. Dedupe by strategy key
       keeping the highest-scoring instance of each unique strategy. */
    const byKey = new Map();
    (Array.isArray(state.strategies) ? state.strategies : []).forEach(s => {
      if (s && s.key != null) byKey.set(String(s.key), s);
    });
    const fromSrc = new Set();
    src.forEach(r => {
      const k = String(r.tplKey || r.name);
      fromSrc.add(k);
      const prev = byKey.get(k);
      if (prev && (r.score || 0) <= (prev.score || 0)) return;
      byKey.set(k, strategyFromResult(r));
    });

    state.strategies = Array.from(byKey.values());
    state.strategies.forEach(s => { if (state.selected[s.key] == null) state.selected[s.key] = true; });
    save();
    render();
    try { window.dispatchEvent(new Event('strategies-imported')); } catch (e) {}
    const sent = state.strategies.filter(s => fromSrc.has(String(s.key))).length;
    if (!opts.silent) log('Imported ' + sent + ' strategy(s) from Auto Experiment (kept ' + state.strategies.length + ' total in Paper Trade)', 'ok');
    return sent;
  }

  /* Import strategies pushed from the AI Smart Trading engine (the "auto
     strategy sender"). `list` holds strategy objects in the same symbol-agnostic
     shape used by importFromAE. Dedupes by key keeping the highest score, never
     wipes removed strategies, and marks the merged set selected so they start
     trading. */
  function importFromAST(list, opts) {
    opts = opts || {};
    if (!list || !list.length) return 0;
    if (!state.removedKeys || typeof state.removedKeys !== 'object') state.removedKeys = {};
    const byKey = new Map();
    (Array.isArray(state.strategies) ? state.strategies : []).forEach(s => {
      if (s && s.key != null) byKey.set(String(s.key), s);
    });
    let added = 0;
    list.forEach(r => {
      if (!r || r.key == null) return;
      const k = String(r.key);
      if (state.removedKeys[k]) return;
      const prev = byKey.get(k);
      if (prev && (r.score || 0) <= (prev.score || 0)) return;
      byKey.set(k, {
        key: k,
        name: r.name || 'Strategy',
        cat: r.cat || 'bullish',
        method: r.method || '',
        tf: r.tf || (typeof chartTf !== 'undefined' ? chartTf : '5min'),
        score: r.score || 0,
        verdict: r.verdict || categoryOf(r.score || 0),
        entry: r.entry || null,
        exit: r.exit || null,
        entryExtra: r.entryExtra || null,
        exitExtra: r.exitExtra || null,
        entryThreshold: r.entryThreshold != null ? r.entryThreshold : null,
        candlestick: r.candlestick || { enabled: false, entry: [], exit: [] }
      });
      if (!prev) added++;
    });
    state.strategies = Array.from(byKey.values());
    state.strategies.forEach(s => { if (state.selected[s.key] == null) state.selected[s.key] = true; });
    save();
    render();
    if (!opts.silent) log('Auto strategy sender: received ' + added + ' strategy(s) from AI Smart Trading', added ? 'ok' : 'warn');
    try { window.dispatchEvent(new Event('strategies-imported')); } catch (e) {}
    return added;
  }

  /* Which strategies actually trade, per the two selection modes.
     AI smart pick runs the top-N BULLISH and the top-N BEARISH strategies
     independently, so both directions are always covered. */
  function activeStrategies() {
    let list = state.strategies.slice();
    if (state.aiMode) {
      const bull = list.filter(s => s.cat !== 'bearish')
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, Math.max(1, state.aiTopNBull));
      const bear = list.filter(s => s.cat === 'bearish')
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, Math.max(1, state.aiTopNBear));
      list = bull.concat(bear);
    }
    if (state.manualMode) {
      list = list.filter(s => !!state.selected[s.key]);
    }
    return list;
  }

  /* ---------------- AI brain ---------------- */

  function ema(arr, period) {
    const k = 2 / (period + 1);
    let e = arr[0], out = [e];
    for (let i = 1; i < arr.length; i++) { e += k * (arr[i] - e); out.push(e); }
    return out;
  }

  function atrPct(arr, period) {
    if (!arr || arr.length < period + 1) return 0;
    let trSum = 0;
    for (let i = arr.length - period; i < arr.length; i++) {
      const c = arr[i], p = arr[i - 1];
      trSum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    }
    const atr = trSum / period;
    const close = arr[arr.length - 1].close;
    return close > 0 ? atr / close * 100 : 0;
  }

  function avgRange(arr, period) {
    const n = arr.length;
    if (n < period) return 0;
    let s = 0;
    for (let i = n - period; i < n; i++) s += (arr[i].high - arr[i].low);
    return s / period;
  }

  function symmetryScore(arr) {
    const n = arr.length;
    if (n < 12) return 0.5;
    const swings = [];
    for (let i = 2; i < n - 2; i++) {
      const c = arr[i];
      if (c.high >= arr[i - 1].high && c.high >= arr[i - 2].high && c.high >= arr[i + 1].high && c.high >= arr[i + 2].high) swings.push({ t: 'H', price: c.high });
      if (c.low <= arr[i - 1].low && c.low <= arr[i - 2].low && c.low <= arr[i + 1].low && c.low <= arr[i + 2].low) swings.push({ t: 'L', price: c.low });
    }
    const recent = swings.slice(-4);
    const highs = recent.filter(s => s.t === 'H').map(s => s.price);
    const lows = recent.filter(s => s.t === 'L').map(s => s.price);
    if (highs.length < 2 || lows.length < 2) return 0.5;
    const up = Math.abs(highs[highs.length - 1] - lows[lows.length - 2]);
    const down = Math.abs(highs[highs.length - 2] - lows[lows.length - 1]);
    const mx = Math.max(up, down);
    if (mx <= 0) return 0.5;
    return clamp(1 - Math.abs(up - down) / mx, 0, 1);
  }

  function structureOf(arr) {
    const n = arr.length;
    const swings = [];
    for (let i = 2; i < n - 2; i++) {
      const c = arr[i];
      if (c.high >= arr[i - 1].high && c.high >= arr[i - 2].high && c.high >= arr[i + 1].high && c.high >= arr[i + 2].high) swings.push({ t: 'H', price: c.high });
      if (c.low <= arr[i - 1].low && c.low <= arr[i - 2].low && c.low <= arr[i + 1].low && c.low <= arr[i + 2].low) swings.push({ t: 'L', price: c.low });
    }
    const recent = swings.slice(-4);
    const highs = recent.filter(s => s.t === 'H').map(s => s.price);
    const lows = recent.filter(s => s.t === 'L').map(s => s.price);
    let trend = 'range', hh = false, ll = false;
    if (highs.length >= 2 && lows.length >= 2) {
      hh = highs[highs.length - 1] > highs[highs.length - 2];
      ll = lows[lows.length - 1] > lows[lows.length - 2];
      if (hh && ll) trend = 'up';
      else if (!hh && !ll) trend = 'down';
    }
    const look = arr.slice(-20);
    let chHigh = -Infinity, chLow = Infinity;
    for (const c of look) { if (c.high > chHigh) chHigh = c.high; if (c.low < chLow) chLow = c.low; }
    return { trend, hh, ll, chHigh, chLow };
  }

  function detectConsolidation(arr, patHits) {
    const n = arr.length;
    if (n < 20) return false;
    const r5 = avgRange(arr, 5), r20 = avgRange(arr, 20);
    const compression = r20 > 0 ? r5 / r20 : 1;
    const closes = arr.slice(-8).map(c => c.close);
    const flat = window.CrossDetector && CrossDetector.seriesDirection ? CrossDetector.seriesDirection(closes) === 'flat' : false;
    return compression < 0.55 || patHits >= 2 || flat;
  }

  function indicatorVotes(arr) {
    let bull = 0, bear = 0, overlayUsed = 0, paneUsed = 0;
    const CD = window.CrossDetector;
    const IND = (window.IndChart && IndChart.IND) ? IndChart.IND : {};
    const deployed = (window.IndChart && IndChart.getDeployedIndicators) ? IndChart.getDeployedIndicators() : [];
    const overlays = [], panes = [];
    deployed.forEach(d => {
      const def = IND[d.id];
      if (!def || !def.compute) return;
      if (def.type === 'overlay') overlays.push({ id: d.id, settings: d.settings || {} });
      else panes.push({ id: d.id, settings: d.settings || {} });
    });

    const lastC = arr[arr.length - 1], prevC = arr[arr.length - 2];
    const closeLast = lastC.close, closePrev = prevC.close;

    for (const o of overlays.slice(0, 10)) {
      overlayUsed++;
      if (!CD) break;
      const lt = CD.readLastTwo({ type: 'ind', id: o.id, settings: o.settings, key: 'v0' }, arr);
      if (!lt || lt.last == null) continue;
      const indLast = lt.last, indPrev = lt.prev;
      if (indPrev != null) {
        if (closePrev <= indPrev && closeLast > indLast) bull += 1;
        else if (closePrev >= indPrev && closeLast < indLast) bear += 1;
      }
      if (closeLast > indLast) bull += 0.5; else if (closeLast < indLast) bear += 0.5;
      const vals = CD.readLastN({ type: 'ind', id: o.id, settings: o.settings, key: 'v0' }, arr, 8);
      const dir = CD.seriesDirection(vals);
      if (dir === 'up') bull += 0.5; else if (dir === 'down') bear += 0.5;
    }

    for (const p of panes.slice(0, 10)) {
      paneUsed++;
      if (!CD) break;
      const vals = CD.readLastN({ type: 'ind', id: p.id, settings: p.settings, key: 'v0' }, arr, 8);
      const dir = CD.seriesDirection(vals);
      if (dir === 'up') bull += 0.6; else if (dir === 'down') bear += 0.6;
      const v = vals.length ? vals[vals.length - 1] : null;
      if (v != null) {
        let mn = Infinity, mx = -Infinity;
        for (const x of vals) { if (x < mn) mn = x; if (x > mx) mx = x; }
        if (mx > mn) {
          const pos = (v - mn) / (mx - mn);
          if (pos < 0.2) bull += 0.5;
          else if (pos > 0.8) bear += 0.5;
        }
      }
    }
    return { bull, bear, overlayUsed, paneUsed };
  }

  function gapAnalysis(arr) {
    const closes = arr.map(c => c.close);
    const e9 = ema(closes, 9), e21 = ema(closes, 21);
    const n = closes.length;
    if (n < 22) return { bullish: false, bearish: false, label: 'n/a', emaGap: 0, devPct: 0 };
    const gLast = e9[n - 1] - e21[n - 1], gPrev = e9[n - 2] - e21[n - 2];
    let bullish = false, bearish = false, label = 'flat';
    if (gLast > gPrev && gLast > 0) { bullish = true; label = 'gap widening up'; }
    else if (gLast < gPrev && gLast < 0) { bearish = true; label = 'gap widening down'; }
    else if (gLast > 0) { bullish = true; label = 'gap above'; }
    else if (gLast < 0) { bearish = true; label = 'gap below'; }
    const devPct = e21[n - 1] !== 0 ? (closes[n - 1] - e21[n - 1]) / e21[n - 1] * 100 : 0;
    return { bullish, bearish, label, emaGap: gLast, devPct: devPct };
  }

  function neutralPlan(reason) {
    return { side: null, conf: 0, bullScore: 0, bearScore: 0, tpPct: 1, slPct: 0.5, reasons: [reason], phase: 'unknown', symmetry: 0, structure: null, consolidation: false, liqBull: false, liqBear: false, gap: null };
  }

  function analyze(candles) {
    if (!candles || candles.length < 30) return neutralPlan('insufficient data');
    const arr = candles.slice(-120);
    const n = arr.length;
    const closes = arr.map(c => c.close);
    const close = closes[n - 1];

    let bullCandle = 0, bearCandle = 0, liqBull = false, liqBear = false, consHits = 0;
    const patNames = [];
    const CP = window.CandlePatterns;
    if (CP && CP.PATTERNS) {
      for (const key in CP.PATTERNS) {
        const p = CP.PATTERNS[key];
        let hit = false;
        try { hit = CP.detect(key, candles); } catch (e) { hit = false; }
        if (!hit) continue;
        const w = (p.winRate || 50) / 100;
        if (p.direction === 'bullish') bullCandle += w;
        else if (p.direction === 'bearish') bearCandle += w;
        if (p.type === 'liquidity') {
          if (p.direction === 'bullish') liqBull = true;
          else if (p.direction === 'bearish') liqBear = true;
        }
        if (p.type === 'consolidation') consHits++;
        if (patNames.length < 8) patNames.push(p.name);
      }
    }

    const symmetry = symmetryScore(arr);
    const structure = structureOf(arr);
    const consolidation = detectConsolidation(arr, consHits);
    const ind = indicatorVotes(arr);
    const gap = gapAnalysis(arr);

    const mom = closes[n - 1] - closes[n - 8];
    const momPct = closes[n - 8] !== 0 ? mom / closes[n - 8] * 100 : 0;

    let bull = 0, bear = 0;
    const cs = Math.max(bullCandle, bearCandle, 1);
    bull += (bullCandle / cs) * 0.20;
    bear += (bearCandle / cs) * 0.20;

    if (structure.trend === 'up') bull += 0.18;
    else if (structure.trend === 'down') bear += 0.18;
    else { bull += 0.09; bear += 0.09; }

    if (liqBull) bull += 0.14;
    if (liqBear) bear += 0.14;

    const indTot = ind.bull + ind.bear;
    if (indTot > 0) { bull += (ind.bull / indTot) * 0.22; bear += (ind.bear / indTot) * 0.22; }

    if (gap.bullish) bull += 0.16; else if (gap.bearish) bear += 0.16;
    if (momPct > 0.05) bull += 0.10; else if (momPct < -0.05) bear += 0.10;

    const side = bull > bear ? 'BUY' : 'SELL';
    const diff = Math.abs(bull - bear);
    const conf = clamp(0.5 + diff, 0, 1);

    const atr = atrPct(arr, 14);
    const tpPct = clamp(atr * 1.5, 0.3, 3);
    const slPct = clamp(atr, 0.2, 2);

    let phase = 'trending';
    if (consolidation) phase = 'consolidation';
    if (liqBull || liqBear) phase = 'liquidity-grab';

    const reasons = [];
    if (patNames.length) reasons.push('patterns: ' + patNames.slice(0, 4).join(', '));
    reasons.push('structure: ' + structure.trend);
    if (consolidation) reasons.push('consolidation');
    if (liqBull) reasons.push('liquidity-grab-below');
    if (liqBear) reasons.push('liquidity-grab-above');
    reasons.push('symmetry ' + symmetry.toFixed(2));
    reasons.push('gap ' + gap.label);
    reasons.push(ind.overlayUsed + 'ov/' + ind.paneUsed + 'pane');

    return {
      side, conf: Math.round(conf * 100) / 100,
      bullScore: Math.round(bull * 100) / 100,
      bearScore: Math.round(bear * 100) / 100,
      tpPct: Math.round(tpPct * 100) / 100,
      slPct: Math.round(slPct * 100) / 100,
      reasons: reasons.slice(0, 8),
      phase, symmetry, structure, consolidation, liqBull, liqBear, gap
    };
  }

  const _analysisCache = { sig: '', res: null };
  function analyzeCached(key, candles) {
    if (!candles || !candles.length) return null;
    const last = candles[candles.length - 1];
    const sig = key + '|' + candles.length + '|' + (last.time || '') + '|' + last.close;
    if (_analysisCache.sig === sig && _analysisCache.res) return _analysisCache.res;
    const res = analyze(candles);
    _analysisCache.sig = sig;
    _analysisCache.res = res;
    return res;
  }

  /* ---------------- quotes / sizing (current chart symbol) ---------------- */

  function currentSymbol() {
    return (typeof selectedSymbol !== 'undefined') ? selectedSymbol : null;
  }

  function quote() {
    const sym = currentSymbol();
    if (!sym) return null;
    const key = sym.exch === 'IDX_I' ? 'IDX_I:' + sym.id : String(sym.id);
    return (window.clientQuotes || {})[key] || null;
  }

  function lotSizeFor(sym) {
    if (!sym) return 1;
    if (window.PaperTrade && PaperTrade.lotSizeFor) {
      const ls = PaperTrade.lotSizeFor(sym);
      if (ls) return ls;
    }
    return sym.lotSize || 1;
  }

  function aePaper() {
    return (window.AutoExperiment && AutoExperiment.paper) ? AutoExperiment.paper : null;
  }

  /* Live snapshot of the AI Smart Trader Engine settings (the shared
     AutoExperiment state). Every engine setting is read on each tick so the
     mirrored controls in Paper Trade immediately drive the selected
     strategies. */
  function settingsNow() {
    const ae = window.AutoExperiment;
    const st = (ae && ae.getState) ? ae.getState() : null;
    return {
      universal: (st && st.universal) || {},
      strike: (st && st.strike) || {},
      groups: (st && st.groups) || null,
      filters: (st && st.filters) || {},
      symbols: (st && st.symbols) || [],
      movers: (st && st.movers) || {}
    };
  }

  function spotLtp() {
    const q = quote();
    return (q && q.ltp != null) ? Number(q.ltp) : 0;
  }

  function instrumentId(instr) {
    if (instr.kind === 'option') return 'opt:' + instr.sid;
    const sym = instr.symbol;
    return 'sym:' + sym.id + ':' + (sym.exch || '');
  }

  function instrumentName(instr) {
    if (instr.kind === 'option') return (instr.symbol.name || instr.symbol.id) + ' ' + instr.strike + ' ' + instr.optionType;
    return instr.symbol.name || ('Symbol ' + instr.symbol.id);
  }

  function instrumentQuote(instr) {
    const qm = window.clientQuotes || {};
    if (instr.kind === 'option') return qm[String(instr.sid)] || null;
    const sym = instr.symbol;
    return qm[sym.exch === 'IDX_I' ? 'IDX_I:' + sym.id : String(sym.id)] || null;
  }

  /* Resolve the trading instruments for the current tick: every symbol from the
     engine symbol set (manual list, top movers, or the current chart symbol)
     expanded into its option strikes (CE/PE per the strike settings). Falls back
     to the underlying when the option chain is unavailable. */
  async function resolveInstruments() {
    const paper = aePaper();
    const syms = (paper && paper.experimentSymbols) ? paper.experimentSymbols() : [];
    if (!syms.length) {
      const cur = currentSymbol();
      return cur ? [{ kind: 'underlying', symbol: cur }] : [];
    }
    const spot = spotLtp();
    const out = [];
    for (const sym of syms) {
      let contracts = null;
      if (paper && paper.contractsFor) {
        try { contracts = await paper.contractsFor(sym, spot); } catch (e) { contracts = null; }
      }
      if (contracts && contracts.length) {
        for (const c of contracts) out.push({ kind: 'option', symbol: sym, strike: c.strike, optionType: c.optionType, sid: c.sid, premium: c.premium });
      } else {
        out.push({ kind: 'underlying', symbol: sym });
      }
    }
    return out;
  }

  /* Sizing derived from the engine's Universal defaults (lot size override,
     lots, margin), falling back to the broker scrip master lot size. */
  function sizingFor(instr, u) {
    const sym = instr.symbol;
    let lotSize = (u && u.lotSize != null && u.lotSize !== '') ? Number(u.lotSize) : null;
    if (lotSize == null) lotSize = lotSizeFor(sym);
    const lots = (u && u.lots != null) ? (Number(u.lots) || 1) : 1;
    const qty = Math.max(1, Math.round(lots)) * lotSize;
    return { lotSize: lotSize, lots: lots, qty: qty, margin: (u && u.margin != null) ? Number(u.margin) : 0 };
  }

  function pnlFor(p, cur) {
    return p.side === 'BUY' ? (cur - p.entryPrice) * p.qty : (p.entryPrice - cur) * p.qty;
  }

  function pnlPctFor(p, pnl) {
    return (p.entryPrice && p.qty) ? (pnl / (p.entryPrice * p.qty)) * 100 : 0;
  }

  function posQuote(p) {
    if (p && p.instrument) return instrumentQuote(p.instrument);
    return quote();
  }

  /* ---------------- live trading loop ---------------- */
  let _pollTimer = null;
  /* Incremented by stopAllStrategies so an in-flight tick (which already passed
     the autoTrade gate) can detect that Close All ran mid-evaluation and abort
     before placing a fresh trade. */
  let _stopGen = 0;
  let _candleCache = {};
  const _sig = {};

  function signalFor(key) {
    if (!_sig[key]) _sig[key] = {};
    return _sig[key];
  }

  async function fetchCandlesForTf(tf) {
    if (_candleCache[tf]) return _candleCache[tf];
    const sym = currentSymbol();
    let c = null;
    if (sym && window.StratEngine && StratEngine.fetchCandlesFor) {
      try { c = await StratEngine.fetchCandlesFor(sym, tf); } catch (e) { c = null; }
    }
    _candleCache[tf] = c || null;
    return _candleCache[tf];
  }

  /* Candles for an instrument: the option premium chart when it is a strike
     (via the engine's candlesForOption), else the underlying. Indices always
     trade on the premium chart; F&O stocks fall back to the underlying when a
     strike's option candles are unavailable. */
  async function candlesForInstrument(instr, tf) {
    const paper = aePaper();
    if (instr.kind === 'option' && paper && paper.candlesForOption) {
      const c = await paper.candlesForOption(instr.symbol, instr.sid, tf);
      if (c && c.length >= 10) return c;
      if (paper.isIndex && paper.isIndex(instr.symbol)) return null;
    }
    if (paper && paper.candlesFor) return paper.candlesFor(instr.symbol, tf);
    return fetchCandlesForTf(tf);
  }

  /* Stateless flat-condition evaluation at bar index `i`. StratEngine sees bar
     `i` as the last bar by slicing, so a fresh cross on the just-closed candle
     is found even when the fetched series already carries a newer forming
     candle. */
  function condAt(cond, i, candles) {
    if (!cond || !cond.indId) return true;
    const SE = window.StratEngine;
    if (!SE) return false;
    const slice = i === candles.length - 1 ? candles : candles.slice(0, i + 1);
    return !!SE.evalSingle(cond, slice);
  }

  function candleEntryAt(s, i, candles) {
    if (!s.candlestick || !s.candlestick.entry || !s.candlestick.entry.length) return true;
    const CP = window.CandlePatterns;
    if (!CP || !CP.detectAny) return true;
    const slice = candles.slice(Math.max(0, i - 6), i + 1);
    return !!CP.detectAny(s.candlestick.entry, slice);
  }

  /* Entry extras (AND / N-of-threshold) evaluated statelessly at bar `i`. The
     old shared edge signal (exSig) latched on continuously-true "gt"/"lt" gates
     so they only ever passed once; stateless evaluation re-checks them each bar. */
  function entryExtraAt(s, i, candles) {
    const ex = s.entryExtra;
    if (!ex || !ex.length) return true;
    const need = (s.entryThreshold != null && s.entryThreshold >= 1) ? Math.min(s.entryThreshold, ex.length) : ex.length;
    let hit = 0;
    for (const c of ex) {
      let ok = false;
      if (c && c.indId) ok = condAt(c, i, candles);
      else if (c && (c.cmpType === 'candlestick_pattern' || c.cmpType === 'pattern')) {
        const CP = window.CandlePatterns;
        const slice = candles.slice(Math.max(0, i - 6), i + 1);
        ok = !!(CP && CP.detectAny && CP.detectAny(c.candlePatterns || [], slice));
      }
      if (ok && ++hit >= need) return true;
    }
    return hit >= need;
  }

  function entryFireAt(s, i, candles) {
    const gapOk = (i === candles.length - 1 && s.entry && s.entry.gap && s.entry.gap.enabled && window.StratEngine)
      ? window.StratEngine.evalGap(s.entry.gap, candles) !== false
      : true;
    return condAt(s.entry, i, candles) && entryExtraAt(s, i, candles) && candleEntryAt(s, i, candles) && gapOk;
  }

  function evalEntry(s, candles, ai, bias) {
    const sig = signalFor(s.key);
    const hasCond = !!(s.entry && s.entry.indId);
    const hasCandle = !!(s.candlestick && s.candlestick.entry && s.candlestick.entry.length);
    const hasStrategyEntry = hasCond || hasCandle;

    const aiConfOk = ai.conf >= state.minConf;
    const biasOk = !bias || (ai.side === bias);
    if (!biasOk || !aiConfOk) return false;

    if (hasStrategyEntry) {
      // Scan the most recent bars for a fresh strategy entry signal, firing once
      // per bar so the strategy keeps trading on every new signal.
      const n = candles.length;
      for (let k = 1; k <= 2 && k <= n; k++) {
        const i = n - k;
        if (entryFireAt(s, i, candles)) {
          const bar = candles[i] ? candles[i].time : null;
          if (bar != null && sig.lastEntryBar === bar) return false;
          sig.lastEntryBar = bar;
          return true;
        }
      }
      return false;
    }
    const aiEdge = ai.side !== sig.aiDir;
    sig.aiDir = ai.side;
    return aiEdge;
  }

  function closePosition(posKey, reason, fillPrice) {
    const p = state.positions[posKey];
    if (!p) return;
    const q = posQuote(p);
    /* Protection exits fill at the protection level (the stop/trail/TP order
       price), not at the last tick that already overshot it. Falls back to the
       live LTP when no explicit fill price is supplied (manual / signal exit). */
    const cur = (fillPrice != null && isFinite(fillPrice) && Number(fillPrice) > 0)
      ? Number(fillPrice)
      : ((q && q.ltp != null) ? Number(q.ltp) : p.entryPrice);
    const pnl = pnlFor(p, cur);
    const pnlPct = pnlPctFor(p, pnl);
    /* Shared Dhan broker-charge simulation: bank the round-trip charge on the
       closed record so summary P&L can be shown net of charges. */
    let netPnl = null, charges = 0;
    if (window.PaperTrade && PaperTrade.computeChargesForTrade && PaperTrade.getCharges && PaperTrade.getCharges()) {
      const c = PaperTrade.computeChargesForTrade(p, cur);
      if (c) { netPnl = c.net; charges = c.total; }
    }
    const at = Date.now();
    state.closed.unshift({ key: p.key, name: p.name, side: p.side, qty: p.qty, entry: p.entryPrice, exit: cur, pnl: pnl, pnlPct: pnlPct, netPnl: netPnl, charges: charges, at: at, reason: reason, instrumentName: p.instrumentName });
    delete state.positions[posKey];
    /* Feed the Strategy Container (Paper Trade tab) so this strategy's daily
       paper-trade stats (P&L / win rate / avg per trade) stay current. */
    try {
      if (window.StrategyContainer && StrategyContainer.recordTrade) {
        StrategyContainer.recordTrade({
          paperKey: p.key,
          symbol: p.instrumentName,
          side: p.side,
          qty: p.qty,
          entry: p.entryPrice,
          exit: cur,
          pnl: pnl,
          pnlPct: pnlPct,
          netPnl: netPnl,
          charges: charges,
          at: at,
          reason: reason
        });
      }
    } catch (e) {}
    const paper = aePaper();
    if (paper) { if (paper.dropTrailEngine) paper.dropTrailEngine(posKey); if (paper.dropAiTrailEngine) paper.dropAiTrailEngine(posKey); }
    log(reason + ' ' + p.side + ' "' + p.name + '" (' + (p.instrumentName || '') + ') | P&L ' + (netPnl != null ? ((netPnl >= 0 ? '+' : '') + fmtMoney(netPnl) + ' net (charges ' + fmtMoney(charges) + ')') : (pnl >= 0 ? '+' : '') + fmtMoney(pnl)) + ' (' + fmt2(pnlPct) + '%)', pnl >= 0 ? 'buy' : 'sell');
  }

  function stopStrategy(key) {
    const posKey = Object.keys(state.positions).find(k => state.positions[k].key === key);
    if (!posKey) return;
    const p = state.positions[posKey];
    closePosition(posKey, 'Manual stop');
    save();
    render();
    log('Manually stopped "' + p.name + '"', 'warn');
  }

  function stopAll() {
    const keys = Object.keys(state.positions);
    if (!keys.length) { log('No running strategies to stop', 'warn'); return; }
    keys.forEach(k => closePosition(k, 'Stop all'));
    save();
    render();
    log('Stopped all ' + keys.length + ' running strategies', 'warn');
  }

  /* Stop EVERYTHING in this engine: turn off AI + manual modes, un-tick all
     strategies and square off all open positions. Used by the unified Close All
     Strategies / Close All Trades controls. */
  function stopAllStrategies(keepEnabled) {
    state.aiMode = false;
    state.manualMode = false;
    if (!keepEnabled) state.autoTrade = false;
    _stopGen++;
    state.strategies.forEach(s => { state.selected[s.key] = false; });
    stopAll();
    save();
    render();
    log(keepEnabled
      ? 'All AI Paper Trade positions closed - strategies unticked (re-tick to resume)'
      : 'All AI Paper Trade strategies stopped', 'warn');
  }

  /* Remove strategies from the imported list, either all of one category or
     only the ticked ones. Open positions of removed strategies are squared off
     first so no orphan rows remain. */
  function removeList(cat, mode) {
    const isBear = cat === 'bear';
    const inCat = s => isBear ? s.cat === 'bearish' : s.cat !== 'bearish';
    const removeKeys = new Set();
    state.strategies.forEach(s => {
      if (inCat(s) && (mode === 'all' || !!state.selected[s.key])) removeKeys.add(s.key);
    });
    if (!removeKeys.size) {
      log('No ' + (isBear ? 'bearish' : 'bullish') + ' strategies to remove', 'warn');
      return;
    }
    Object.keys(state.positions).forEach(k => {
      if (removeKeys.has(state.positions[k].key)) closePosition(k, 'Strategy removed');
    });
    state.strategies = state.strategies.filter(s => !removeKeys.has(s.key));
    removeKeys.forEach(k => {
      delete state.selected[k];
      delete state.tradeCounts[k];
      delete state.runProgress[k];
      state.removedKeys[k] = true;
    });
    save();
    render();
    log('Removed ' + removeKeys.size + ' ' + (isBear ? 'bearish' : 'bullish') + ' strategies', 'warn');
  }

  /* Send the currently selected strategies (manual ticks or the AI top-N picks)
     into the AI Smart Trading Engine's "Selected Strategies" section so it can
     paper-trade exactly what was selected here. */
  function sendToAISmart() {
    const ast = window.AISmartTrading;
    if (!ast || !ast.importFromPaperTrade) { log('AI Smart Trading Engine not ready', 'warn'); return; }
    let list = [];
    if (state.aiMode) {
      list = activeStrategies();
    } else {
      list = state.strategies.filter(s => !!state.selected[s.key]);
    }
    if (!list.length) {
      log('No strategies selected to send - tick at least one strategy or run the AI Smart Trader', 'warn');
      return;
    }
    const count = ast.importFromPaperTrade(list);
    if (count > 0) log('Sent ' + count + ' strategy(s) to the AI Smart Trading Engine Selected Strategies', 'ok');
  }

  /* NSE cash / F&O session check (09:15 - 15:30 IST, Mon-Fri) on the client
     clock. Mirrors the AI Smart engine's marketSessionOpen() so this engine's
     tick never opens a NEW trade after the day's market has closed (off-hours
     auto entries skew the day's P&L statistics). Exits stay unaffected - the
     gate only blocks fresh entries. */
  function nseMarketSessionOpen() {
    const now = new Date(Date.now() + 5.5 * 3600 * 1000);
    const day = now.getUTCDay();
    if (day === 0 || day === 6) return false;
    const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
    return minute >= 555 && minute < 930;
  }
  /* The synthetic market-off simulation stream (SIM / 900001) is exempt - its
     whole purpose is keeping a live feed trading while the market is closed. */
  function isSimTradedSymbol(symbol) {
    if (!symbol) return false;
    if (symbol.sim === true) return true;
    if (symbol.id !== undefined && Number(symbol.id) === 900001) return true;
    const nm = String(symbol.name || '').toUpperCase();
    const ex = String(symbol.exch || symbol.ocExch || '').toUpperCase();
    return nm.indexOf('SIM') === 0 || ex === 'SIM';
  }

  /* Per-day trade budget for the AI Smart Trader, mirroring the engine's
     Max trades / AI auto trades counters. Reset on a new IST day. */
  function resetTradeCountsIfNewDay() {
    const d = new Date(Date.now() + 5.5 * 3600 * 1000);
    const day = d.getUTCFullYear() + '-' + (d.getUTCMonth() + 1) + '-' + d.getUTCDate();
    if (day !== state.tradeCountDay) {
      state.tradeCountDay = day;
      state.tradeCounts = {};
    }
  }

  function allowedTradesForStrategy(s, instr, candles) {
    const paper = aePaper();
    if (paper && paper.allowedTradesFor) {
      const r = { key: s.key, cat: s.cat, optionSid: instr.kind === 'option' ? instr.sid : null, symbol: instr.symbol };
      try { return paper.allowedTradesFor(r, candles); } catch (e) { return null; }
    }
    return null;
  }

  async function tick() {
    if (!state.autoTrade) return;
    const stopGen = _stopGen;
    const list = activeStrategies();
    if (!list.length) return;
    resetTradeCountsIfNewDay();

    /* Live pipeline progress for a running strategy, surfaced on its row in the
       Running Strategies view. `pct` is the furthest stage reached in the last
       tick's entry pipeline and `status` the human-readable reason it stopped. */
    const _prog = state.runProgress || (state.runProgress = {});
    const prog = (key, pct, status) => {
      if (!key) return;
      _prog[key] = { pct: Math.max(0, Math.min(100, Math.round(pct))), status: String(status || ''), updated: Date.now() };
    };

    const settings = settingsNow();
    const u = settings.universal;

    let instruments;
    try { instruments = await resolveInstruments(); } catch (e) { instruments = []; }
    if (!instruments.length) {
      const cur = currentSymbol();
      if (cur) instruments = [{ kind: 'underlying', symbol: cur }];
    }
    if (!instruments.length) return;

    for (const s of list) {
      /* Apply the engine's Bullish/Bearish entry filters to this strategy (they
         append incUp/incDown/crossAbove/crossBelow gates to its entry extras). */
      let st = s;
      const paper = aePaper();
      if (paper && paper.applyFilters) { try { st = paper.applyFilters(s); } catch (e) {} }

      const tf = st.tf || (typeof chartTf !== 'undefined' ? chartTf : '5min');

      for (const instr of instruments) {
        const posKey = st.key + '@' + instrumentId(instr);
        const candles = await candlesForInstrument(instr, tf);
        if (!candles || candles.length < 30) { prog(st.key, 5, 'Waiting candles'); continue; }
        const ai = analyzeCached(st.key + ':' + instrumentId(instr) + ':' + tf, candles);
        if (!ai || !ai.side) { prog(st.key, 15, 'Evaluating'); continue; }
        prog(st.key, 30, 'Evaluating on ' + instrumentName(instr));

        const q = instrumentQuote(instr);
        const px = (q && q.live && q.ltp != null) ? Number(q.ltp) : null;

        const pos = state.positions[posKey];
        if (pos) {
          prog(st.key, 50, 'Managing position');
          /* Profit-taking exits close a trade, mirroring the Paper Trade
             engine's checkAutoTargetSl:
               - Stop-loss protection closes the trade at the set SL % (below
                 entry for BUY / above entry for SELL), capping the loss on a
                 losing trade. Only active when a positive SL % was set.
               - Fixed take-profit (tpPct/tpPrice) banks a set profit off entry.
               - Trailing take-profit banks profit: it is a % of the RUNNING
                 profit (peak - entry), auto-re-sets on every new peak, active
                 from the first paisa of profit, and never fills below entry.
             Fills are priced at the protection level (the trail/TP/SL order)
             so a gap through a level never books a worse fill than the level. */
          const q = instrumentQuote(instr);
          const cur = (q && q.live && q.ltp != null) ? Number(q.ltp) : null;
          if (cur !== null) {
            const trailPct = pos.targetPct || 0;
            if (pos.side === 'BUY') {
              if (pos.peakPrice == null || cur > pos.peakPrice) pos.peakPrice = cur;
              /* Trailing stop-loss ratchets the stop up behind the RUNNING
                 PROFIT (peak - entry), mirroring the Paper Trade engine: it
                 keeps (100 - trail%)% of the peak profit and only gives back
                 trail% of it, so the SL hugs the profit and slides up behind it
                 tick by tick. Only active once the trade is IN PROFIT - it must
                 never pull the stop up against an open loss. */
              if ((pos.slPct > 0 || pos.slTrailPct > 0) && pos.slTrailPct > 0 && pos.stopLoss != null && pos.peakPrice > pos.entryPrice) {
                const peakProfit = pos.peakPrice - pos.entryPrice;
                const ratchet = pos.entryPrice + peakProfit * (1 - pos.slTrailPct / 100);
                if (ratchet > pos.stopLoss) { pos.stopLoss = ratchet; pos.slTrailed = true; }
              }
              if ((pos.slPct > 0 || pos.slTrailPct > 0) && pos.stopLoss != null && cur <= pos.stopLoss) { closePosition(posKey, pos.slTrailed ? 'Trailing SL hit' : 'Stop loss hit', pos.stopLoss); continue; }
              if (pos.tpPct > 0 && cur >= pos.tpPrice) { closePosition(posKey, 'Take profit hit', pos.tpPrice); continue; }
              if (trailPct > 0) {
                const peakProfit = pos.peakPrice - pos.entryPrice;
                const trail = Math.max(pos.entryPrice + peakProfit * (1 - trailPct / 100), pos.entryPrice);
                pos.targetPrice = trail;
                if (peakProfit > 0 && cur <= trail) { closePosition(posKey, 'Trailing target hit', trail); continue; }
              } else {
                pos.targetPrice = pos.peakPrice;
              }
            } else {
              if (pos.peakPrice == null || cur < pos.peakPrice) pos.peakPrice = cur;
              if ((pos.slPct > 0 || pos.slTrailPct > 0) && pos.slTrailPct > 0 && pos.stopLoss != null && pos.peakPrice < pos.entryPrice) {
                const peakProfit = pos.entryPrice - pos.peakPrice;
                const ratchet = pos.entryPrice - peakProfit * (1 - pos.slTrailPct / 100);
                if (ratchet < pos.stopLoss) { pos.stopLoss = ratchet; pos.slTrailed = true; }
              }
              if ((pos.slPct > 0 || pos.slTrailPct > 0) && pos.stopLoss != null && cur >= pos.stopLoss) { closePosition(posKey, pos.slTrailed ? 'Trailing SL hit' : 'Stop loss hit', pos.stopLoss); continue; }
              if (pos.tpPct > 0 && cur <= pos.tpPrice) { closePosition(posKey, 'Take profit hit', pos.tpPrice); continue; }
              if (trailPct > 0) {
                const peakProfit = pos.entryPrice - pos.peakPrice;
                const trail = Math.min(pos.entryPrice - peakProfit * (1 - trailPct / 100), pos.entryPrice);
                pos.targetPrice = trail;
                if (peakProfit > 0 && cur >= trail) { closePosition(posKey, 'Trailing target hit', trail); continue; }
              } else {
                pos.targetPrice = pos.peakPrice;
              }
            }
          }
          continue;
        }

        const bias = st.cat === 'bearish' ? 'SELL' : (st.cat === 'bullish' ? 'BUY' : null);
        if (!evalEntry(st, candles, ai, bias)) { prog(st.key, 70, 'Waiting entry signal'); continue; }
        const side = 'BUY'; // buy-only engine: the AI analysis still detects the bearish/bullish trend, but every executed trade is BUY
        if (px == null) { prog(st.key, 75, 'Blocked: no live price'); continue; }
        /* NSE market-hours gate: no NEW auto entry while the market is closed
           (09:15-15:30 IST). Blocks off-hours entries that would land on the
           day's P&L statistics after the session ended. */
        const sym = (instr && (instr.symbol || instr.underlying)) || null;
        if (sym && !isSimTradedSymbol(sym) && !nseMarketSessionOpen()) {
          prog(st.key, 78, 'Blocked: NSE market closed (09:15-15:30 IST) - no new entries');
          continue;
        }
        prog(st.key, 90, 'Placing entry');
        /* Close All ran while this poll was evaluating: abort before any fresh
           entry can be placed. */
        if (stopGen !== _stopGen) { prog(st.key, 95, 'Stopped by Close All'); return; }

        /* Per-day trade budget (Max trades / AI auto trades) checked before the
           entry so an exhausted budget blocks new entries. */
        const allowed = allowedTradesForStrategy(st, instr, candles);
        if (allowed != null && (state.tradeCounts[st.key] || 0) >= allowed) { prog(st.key, 60, 'Blocked: trade limit reached'); continue; }

        const sizing = sizingFor(instr, u);
        /* Risk management follows the same universal toggles as the AI Smart
           Trading / Auto Experiment engines, applied together on EVERY trade:
             - SL: Manual SL % or AI SL (ATR-hunting-aware).
             - Trailing TP: Manual Trail TP % or AI Trail TP (u.tpPct trail gate).
             - Fixed TP: Manual TP % or AI TP (volatility-scaled).
           Each pair is mutually exclusive (enabling one disables the other). */
        const manualSLOn = u.manualSL === true;
        const manualTrailSLOn = u.manualTrailSL === true;
        const manualTrailTPOn = u.manualTrailTP === true;
        const manualTPOn = u.manualTP === true;
        const aiSlOn = !manualSLOn && !manualTrailSLOn && u.aiSl !== false;
        const aiTpOn = !manualTrailTPOn && u.aiTp !== false;
        const aiTPOn = !manualTPOn && u.aiTP !== false;
          const slPct = manualSLOn ? (Number(u.manualSLPct) || 0) : (aiSlOn ? (st.autoSlPct != null ? st.autoSlPct : ai.slPct) : 0);
          const slTrailPct = manualTrailSLOn ? (Number(u.manualTrailSLPct) || 0) : 0;
          const effSlPct = slPct > 0 ? slPct : (slTrailPct > 0 ? slTrailPct : 0);
        const tpPct = manualTrailTPOn ? (Number(u.manualTrailTPPct) || 0) : (aiTpOn ? (Number(u.tpPct) > 0 ? Number(u.tpPct) : 1) : 0);
        const fixedTpPct = manualTPOn ? (Number(u.manualTPPct) || 0) : (aiTPOn ? (Number(ai.tpPct) > 0 ? ai.tpPct : 0) : 0);

        /* Strategy / chart execution fills AT the live chart price (LTP). No
           spread-crossing ask+buffer fill - a position must never open already
           underwater against the bid-ask spread. */
        const fnoLimit = false;
        const fillPx = px;
        const orderType = 'MARKET';
        const limitPrice = 0;

        state.positions[posKey] = {
          key: st.key,
          name: st.name,
          side: side,
          qty: sizing.qty,
          lotSize: sizing.lotSize,
          lots: sizing.lots,
          margin: sizing.margin,
          entryPrice: fillPx,
          peakPrice: fillPx,
          orderType: orderType, limitPrice: limitPrice,
          targetPct: tpPct, slPct: slPct,
          slTrailPct: slTrailPct, slTrailed: false,
          targetPrice: fillPx,
          stopLoss: side === 'BUY' ? fillPx * (1 - effSlPct / 100) : fillPx * (1 + effSlPct / 100),
          tpPct: fixedTpPct > 0 ? fixedTpPct : 0,
          tpPrice: fixedTpPct > 0 ? (side === 'BUY' ? fillPx * (1 + fixedTpPct / 100) : fillPx * (1 - fixedTpPct / 100)) : 0,
          instrument: instr,
          instrumentId: instrumentId(instr),
          instrumentName: instrumentName(instr),
          openedAt: Date.now()
        };
        state.tradeCounts[st.key] = (state.tradeCounts[st.key] || 0) + 1;
        prog(st.key, 100, 'Entry placed');
        log('AI ' + side + ' "' + st.name + '" @ ' + fmt2(fillPx) + (orderType === 'LIMIT' ? ' [LIMIT]' : '') + ' (' + instrumentName(instr) + ') conf ' + ai.conf + ' | ' + (ai.reasons[0] || ''), side === 'BUY' ? 'buy' : 'sell');
      }
    }
    save();
    render();
  }

  function startPoll() {
    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = setInterval(tick, POLL_MS);
  }
  function stopPoll() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  }

  /* ---------------- rendering ---------------- */

  function renderSummary() {
    const chargesOn = !!(window.PaperTrade && PaperTrade.getCharges && PaperTrade.getCharges());
    const realized = state.closed.reduce((a, t) => a + ((chargesOn && t.netPnl != null) ? t.netPnl : t.pnl), 0);
    let unreal = 0;
    for (const k in state.positions) {
      const p = state.positions[k];
      const q = posQuote(p);
      if (q && q.live && q.ltp != null) {
        const g = pnlFor(p, Number(q.ltp));
        unreal += (chargesOn && window.PaperTrade && PaperTrade.chargesTotalForOpen)
          ? g - PaperTrade.chargesTotalForOpen(p, Number(q.ltp))
          : g;
      }
    }
    const live = realized + unreal;
    const wins = state.closed.filter(t => ((chargesOn && t.netPnl != null) ? t.netPnl : t.pnl) > 0).length;
    const total = state.closed.length;
    const wr = total ? wins / total * 100 : 0;
    setText('aiptLivePnl', (live >= 0 ? '+' : '') + fmtMoney(live), live >= 0 ? '#00d4aa' : '#ef5350');
    setText('aiptRealized', (realized >= 0 ? '+' : '') + fmtMoney(realized), realized >= 0 ? '#00d4aa' : '#ef5350');
    setText('aiptWinRate', fmt2(wr) + '%', wr >= 50 ? '#00d4aa' : '#ff9800');
    setText('aiptTrades', total + ' (' + wins + 'W / ' + (total - wins) + 'L)');
    const chEl = $id('aiptCharges');
    if (chEl) chEl.textContent = (chargesOn ? '-' : '') + fmtMoney(state.closed.reduce((a, t) => a + (t.charges || 0), 0));
  }

  function strategyRow(s, isActive) {
    const sideCol = s.cat === 'bearish' ? '#ef5350' : '#00d4aa';
    const sideTag = 'LONG'; // buy-only engine: every trade executes LONG
    const checked = state.selected[s.key] ? 'checked' : '';
    const vCol = CAT_COLOR[s.verdict] || '#888';
    return '<div style="display:flex;align-items:center;gap:8px;background:#12122a;border:1px solid ' + (isActive ? '#2d6d5a' : '#2d2d50') + ';border-radius:4px;padding:4px 8px;margin:2px 0;font-size:10px">' +
      '<input type="checkbox" data-key="' + esc(s.key) + '" ' + checked + ' style="accent-color:#00d4aa">' +
      '<span style="color:' + sideCol + ';font-weight:700;min-width:38px">' + sideTag + '</span>' +
      '<span style="color:#fff;flex:1">' + esc(s.name) + (s.tf ? ' <span style="color:#666">· ' + esc(s.tf) + '</span>' : '') + '</span>' +
      '<span style="color:' + vCol + ';min-width:36px;text-align:right">' + s.score + '</span>' +
      '<span style="color:' + (isActive ? '#00d4aa' : '#555') + ';min-width:52px;text-align:right;font-weight:700">' + (isActive ? 'RUNNING' : 'IDLE') + '</span>' +
      '<button class="btn-action" style="width:auto;padding:2px 8px;margin:0;font-size:9px" onclick="AIPaperTrade.detail(\'' + esc(s.key) + '\')">Details</button>' +
      (isActive ? '<button class="btn-action" style="width:auto;padding:2px 8px;margin:0;font-size:9px;background:#ef5350;color:#fff" onclick="AIPaperTrade.stopStrategy(\'' + esc(s.key) + '\')">Stop</button>' : '') +
      '</div>';
  }

  function renderList() {
    const bullHost = $id('aiptBullList');
    const bearHost = $id('aiptBearList');
    const bullHead = $id('aiptBullHeader');
    const bearHead = $id('aiptBearHeader');

    if (!state.strategies.length) {
      if (bullHead) bullHead.innerHTML = 'Bullish (CE)';
      if (bearHead) bearHead.innerHTML = 'Bearish (PE)';
      if (bullHost) bullHost.innerHTML = '<div class="ind-empty">No strategies imported. Run an Auto Experiment then click "Send to Paper Trade".</div>';
      if (bearHost) bearHost.innerHTML = '';
      return;
    }

    const active = new Set(activeStrategies().map(s => s.key));
    const bull = state.strategies.filter(s => s.cat !== 'bearish').sort((a, b) => (b.score || 0) - (a.score || 0));
    const bear = state.strategies.filter(s => s.cat === 'bearish').sort((a, b) => (b.score || 0) - (a.score || 0));

    const headerBtns = (cat) =>
      '<span style="float:right">' +
      '<button class="btn-action" style="width:auto;padding:1px 8px;margin:0 2px;font-size:9px;background:#26a69a;color:#fff" onclick="AIPaperTrade.removeList(\'' + cat + '\',\'selected\')">Remove Selected</button>' +
      '<button class="btn-action" style="width:auto;padding:1px 8px;margin:0;font-size:9px;background:#ef5350;color:#fff" onclick="AIPaperTrade.removeList(\'' + cat + '\',\'all\')">Remove All</button>' +
      '</span>';

    if (bullHead) bullHead.innerHTML = 'Bullish (CE) <span style="color:#666;font-weight:400;font-size:9px">(' + bull.length + ')</span>' + headerBtns('bull');
    if (bearHead) bearHead.innerHTML = 'Bearish (PE) <span style="color:#666;font-weight:400;font-size:9px">(' + bear.length + ')</span>' + headerBtns('bear');
    if (bullHost) bullHost.innerHTML = bull.length ? bull.map(s => strategyRow(s, active.has(s.key))).join('') : '<div class="ind-empty" style="padding:6px">No bullish strategies</div>';
    if (bearHost) bearHost.innerHTML = bear.length ? bear.map(s => strategyRow(s, active.has(s.key))).join('') : '<div class="ind-empty" style="padding:6px">No bearish strategies</div>';

    [bullHost, bearHost].forEach(host => {
      if (!host) return;
      host.querySelectorAll('input[type="checkbox"][data-key]').forEach(cb => {
        cb.addEventListener('change', () => api.onStrategyCheck(cb.getAttribute('data-key'), cb.checked));
      });
    });
  }

  function renderOpen() {
    const host = $id('aiptOpenList');
    if (!host) return;
    const active = activeStrategies();
    const openPositions = Object.keys(state.positions).map(k => state.positions[k]);

    if (!active.length && !openPositions.length) {
      let msg;
      if (!state.strategies.length) {
        msg = 'No strategies imported. Run an Auto Experiment then click "Send to Paper Trade" (or press Refresh here).';
      } else if (!state.manualMode && !state.aiMode) {
        msg = 'Press "Run Manual Strategies" or "Run AI Smart Trader" to start.';
      } else {
        msg = 'No strategies qualified to run. In manual mode tick at least one strategy, or in AI mode raise the top-N values.';
      }
      host.innerHTML = '<div style="color:#ff9800;font-size:10px;padding:4px 8px">' + msg + '</div>';
      return;
    }

    const q = quote();
    const cur = (q && q.live && q.ltp != null) ? Number(q.ltp) : null;

    const rows = [];
    /* Active strategies with no open position yet: show as waiting rows. */
    active.forEach(s => {
      if (!openPositions.some(p => p.key === s.key)) rows.push(runningRow(s, null, cur));
    });
    /* Open positions (per strategy x strike): show live rows. */
    openPositions.forEach(p => rows.push(positionRow(p)));
    host.innerHTML = rows.join('');
  }

  function runningRow(s, p, cur) {
    const sideCol = s.cat === 'bearish' ? '#ef5350' : '#00d4aa';
    const sideTag = 'LONG'; // buy-only engine: every trade executes LONG
    const vCol = CAT_COLOR[s.verdict] || '#888';
    if (!p) {
      return '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:#12122a;border:1px solid #2d2d50;border-radius:4px;padding:5px 8px;margin:2px 0;font-size:10px">' +
        '<span style="color:' + sideCol + ';font-weight:700;min-width:38px">' + sideTag + '</span>' +
        '<span style="color:#fff;flex:1;min-width:120px">' + esc(s.name) + (s.tf ? ' <span style="color:#666">· ' + esc(s.tf) + '</span>' : '') + '</span>' +
        '<span style="color:' + vCol + ';min-width:36px;text-align:right">' + s.score + '</span>' +
        '<span style="color:#888;min-width:64px;text-align:right">LTP ' + (cur != null ? fmt2(cur) : '--') + '</span>' +
        '<span style="color:#ff9800;min-width:96px;text-align:right">Waiting for entry</span>' +
        '<button class="btn-action" style="width:auto;padding:2px 8px;margin:0;font-size:9px" onclick="AIPaperTrade.detail(\'' + esc(s.key) + '\')">Details</button>' +
        '</div>';
    }
    return positionRow(p);
  }

  function positionRow(p) {
    const q = posQuote(p);
    const cur = (q && q.live && q.ltp != null) ? Number(q.ltp) : null;
    const pnl = cur != null ? pnlFor(p, cur) : null;
    const chargesOn = !!(window.PaperTrade && PaperTrade.getCharges && PaperTrade.getCharges());
    const charges = (chargesOn && cur != null && window.PaperTrade && PaperTrade.chargesTotalForOpen)
      ? PaperTrade.chargesTotalForOpen(p, cur)
      : 0;
    const net = pnl != null ? pnl - charges : null;
    const pnlPct = pnl != null ? pnlPctFor(p, pnl) : null;
    const col = net == null ? '#888' : (net >= 0 ? '#00d4aa' : '#ef5350');
    const sideCol = p.side === 'BUY' ? '#00d4aa' : '#ef5350';
    return '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:#12122a;border:1px solid #2d6d5a;border-radius:4px;padding:5px 8px;margin:2px 0;font-size:10px">' +
      '<span style="color:' + sideCol + ';font-weight:700;min-width:38px">' + (p.side === 'BUY' ? 'LONG' : 'SHORT') + '</span>' +
      '<span style="color:#fff;flex:1;min-width:120px">' + esc(p.name) + (p.instrumentName ? ' <span style="color:#888">· ' + esc(p.instrumentName) + '</span>' : '') + '</span>' +
      '<span style="color:#888;min-width:90px">' + fmt2(p.entryPrice) + ' \u2192 ' + (cur != null ? fmt2(cur) : '--') + '</span>' +
      '<span style="color:#00d4aa;min-width:44px;text-align:right">TP ' + fmt2(p.targetPrice) + (p.tpPct > 0 ? '<br><span style="color:#26a69a;font-size:8px">FIX ' + fmt2(p.tpPrice) + '</span>' : '') + '</span>' +
      '<span style="color:#ef5350;min-width:44px;text-align:right">SL ' + fmt2(p.stopLoss) + '</span>' +
      '<span style="color:' + col + ';min-width:80px;text-align:right">' + (net == null ? '--' : (net >= 0 ? '+' : '') + fmtMoney(net) + ' (' + fmt2(pnlPct) + '%)' + (chargesOn && pnl != null ? '<br><span style="font-size:8px;color:#888">gross ' + (pnl >= 0 ? '+' : '') + fmtMoney(pnl) + '</span>' : '')) + '</span>' +
      '<button class="btn-action" style="width:auto;padding:2px 8px;margin:0;font-size:9px" onclick="AIPaperTrade.detail(\'' + esc(p.key) + '\')">Details</button>' +
      '<button class="btn-action" style="width:auto;padding:2px 8px;margin:0;font-size:9px;background:#ef5350;color:#fff" onclick="AIPaperTrade.stopStrategy(\'' + esc(p.key) + '\')">Stop</button>' +
      '</div>';
  }

  function renderClosed() {
    const host = $id('aiptClosed');
    if (!host) return;
    if (!state.closed.length) {
      host.innerHTML = '<div style="color:#666;font-size:10px;padding:4px 8px">No closed AI trades</div>';
      return;
    }
    host.innerHTML = state.closed.slice(0, 15).map(t => {
      const chargesOn = !!(window.PaperTrade && PaperTrade.getCharges && PaperTrade.getCharges());
      const net = (chargesOn && t.netPnl != null) ? t.netPnl : t.pnl;
      const col = net >= 0 ? '#00d4aa' : '#ef5350';
      const d = new Date(t.at);
      const ts = (window.IST12 && IST12.fmtMs) ? IST12.fmtMs(t.at) : String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
      return '<div style="display:flex;gap:8px;background:#12122a;border:1px solid #2d2d50;border-radius:4px;padding:4px 8px;margin:2px 0;font-size:10px">' +
        '<span style="color:#fff;flex:1">' + esc(t.name) + '</span>' +
        '<span style="color:' + (t.side === 'BUY' ? '#00d4aa' : '#ef5350') + '">' + (t.side === 'BUY' ? 'LONG' : 'SHORT') + '</span>' +
        '<span style="color:#888">' + fmt2(t.entry) + ' \u2192 ' + fmt2(t.exit) + '</span>' +
        '<span style="color:' + col + '">' + (net >= 0 ? '+' : '') + fmtMoney(net) + ' (' + fmt2(t.pnlPct) + '%)' + (chargesOn && t.netPnl != null ? '<span style="font-size:8px;color:#888"> gross ' + (t.pnl >= 0 ? '+' : '') + fmtMoney(t.pnl) + '</span>' : '') + '</span>' +
        '<span style="color:#888">' + ts + '</span>' +
        '</div>';
    }).join('');
  }

  function showDetail(key) {
    const s = state.strategies.find(x => x.key === key);
    const m = $id('aiptDetailModal');
    if (!s || !m) return;
    const t = $id('aiptDetailTitle');
    if (t) t.textContent = s.name;
    const entryStr = condLabel(s.entry, ' AND ');
    const entryExtraStr = condLabel(s.entryExtra, ' AND ');
    const exitStr = condLabel(s.exit, ' AND ');
    const exitExtraStr = condLabel(s.exitExtra, ' OR ');
    let patStr = 'none';
    if (s.candlestick) {
      const pe = (s.candlestick.entry || []).map(patternName).join(', ') || 'none';
      const px = (s.candlestick.exit || []).map(patternName).join(', ') || 'none';
      patStr = 'Entry: ' + pe + ' &middot; Exit: ' + px;
    }
    const vCol = s.verdict === 'Elite' ? '#ffd700' : (s.verdict === 'Good' ? '#00d4aa' : (s.verdict === 'Moderate' ? '#ff9800' : '#888'));
    const sideCol = s.cat === 'bearish' ? '#ef5350' : '#00d4aa';
    const sideTag = 'LONG'; // buy-only engine: every trade executes LONG

    const body = $id('aiptDetailBody');
    if (!body) return;
    body.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin:6px 0">' +
        '<span style="color:' + sideCol + ';font-weight:700">' + sideTag + '</span>' +
        '<span style="color:' + vCol + ';font-weight:700">' + esc(s.verdict) + ' ' + s.score + '</span>' +
        '<span style="color:#888">' + esc(s.method) + '</span>' +
      '</div>' +
      '<div style="margin:6px 0"><b style="color:#00d4aa">Category:</b> ' + esc(s.cat) + '</div>' +
      '<div style="margin:6px 0"><b style="color:#00d4aa">Timeframe:</b> ' + esc(s.tf) + '</div>' +
      '<div style="margin:6px 0"><b style="color:#00d4aa">Entry:</b> ' + esc(entryStr) + '</div>' +
      (entryExtraStr && entryExtraStr !== 'none' ? '<div style="margin:6px 0"><b style="color:#00d4aa">Entry extra (AND):</b> ' + esc(entryExtraStr) + '</div>' : '') +
      '<div style="margin:6px 0"><b style="color:#00d4aa">Exit:</b> ' + esc(exitStr) + '</div>' +
      (exitExtraStr && exitExtraStr !== 'none' ? '<div style="margin:6px 0"><b style="color:#00d4aa">Exit extra (OR):</b> ' + esc(exitExtraStr) + '</div>' : '') +
      '<div style="margin:6px 0"><b style="color:#00d4aa">Candlestick:</b> ' + patStr + '</div>' +
      '<div style="margin:6px 0;color:#888">Read-only snapshot. Paper trade runs this exact strategy on the current chart symbol.</div>';
    m.classList.remove('hidden');
  }

  function render() {
    const btn = $id('aiptAutoToggle');
    if (btn) { btn.textContent = 'AI Paper Trade: ' + (state.autoTrade ? 'ON' : 'OFF'); btn.style.background = state.autoTrade ? '#00d4aa' : '#e67e22'; }
    const mbtn = $id('aiptRunSelectedBtn');
    if (mbtn) { mbtn.textContent = (state.manualMode && state.autoTrade) ? 'Stop Manual Strategies' : 'Run Manual Strategies'; mbtn.style.background = (state.manualMode && state.autoTrade) ? '#ef5350' : '#00d4aa'; }
    const abtn = $id('aiptRunAiBtn');
    if (abtn) { abtn.textContent = (state.aiMode && state.autoTrade) ? 'Stop AI Smart Trader' : 'Run AI Smart Trader'; abtn.style.background = (state.aiMode && state.autoTrade) ? '#ef5350' : '#66ccff'; }
    const tnB = $id('aiptTopNBull');
    if (tnB && document.activeElement !== tnB) tnB.value = String(state.aiTopNBull);
    const tnS = $id('aiptTopNBear');
    if (tnS && document.activeElement !== tnS) tnS.value = String(state.aiTopNBear);
    renderSummary();
    renderList();
    renderOpen();
    renderClosed();
  }

  function log(msg, cls) {
    const el = $id('aiptLog');
    if (el) {
      const d = new Date();
      const ts = (window.IST12 && IST12.fmtMs) ? IST12.fmtMs(d.getTime()) : String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
      const col = cls === 'buy' ? '#00d4aa' : (cls === 'sell' ? '#ef5350' : (cls === 'warn' ? '#ff9800' : (cls === 'ok' ? '#00d4aa' : '#888')));
      const div = document.createElement('div');
      div.innerHTML = '<span style="color:#555">' + ts + '</span> <span style="color:' + col + '">' + esc(msg) + '</span>';
      el.appendChild(div);
      while (el.children.length > 40) el.removeChild(el.firstChild);
      el.scrollTop = el.scrollHeight;
    }
  }

  /* ---------------- embedded live chart ---------------- */
  let _mini = null;      /* { chart, series, lines[] } */
  let _miniTimer = null;
  let _miniInstr = null; /* instrument currently shown in the mini chart */

  function miniTf() {
    if (state.strategies.length) {
      const tfs = {};
      state.strategies.forEach(s => { if (s.tf) tfs[s.tf] = (tfs[s.tf] || 0) + 1; });
      let best = null, bestN = -1;
      for (const t in tfs) if (tfs[t] > bestN) { bestN = tfs[t]; best = t; }
      if (best) return best;
    }
    return (typeof chartTf !== 'undefined' && chartTf) ? chartTf : '5min';
  }

  function clearMiniLines() {
    if (_mini && _mini.series) {
      (_mini.lines || []).forEach(l => { try { _mini.series.removePriceLine(l); } catch (e) {} });
      _mini.lines = [];
    }
  }

  function addMiniLine(price, color, style, title) {
    if (!_mini || !_mini.series || !(price > 0)) return;
    try {
      _mini.lines.push(_mini.series.createPriceLine({
        price: price, color: color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title: title
      }));
    } catch (e) {}
  }

  async function refreshMiniChart() {
    const host = $id('aiptChart');
    const panel = $id('aiptChartPanel');
    if (!host || !panel || panel.style.display === 'none') return;
    const instr = _miniInstr || (currentSymbol() ? { kind: 'underlying', symbol: currentSymbol() } : null);
    if (!instr) { if (_mini && _mini.chart) { try { _mini.chart.remove(); } catch (e) {} _mini = null; } host.innerHTML = '<div style="color:#888;font-size:10px;padding:12px">No symbol selected</div>'; return; }
    if (!window.LightweightCharts) { host.innerHTML = '<div style="color:#888;font-size:10px;padding:12px">Chart library not loaded</div>'; return; }

    const tf = miniTf();
    const candles = await candlesForInstrument(instr, tf);
    if (!candles || candles.length < 5) {
      if (_mini && _mini.chart) { try { _mini.chart.remove(); } catch (e) {} _mini = null; }
      host.innerHTML = '<div style="color:#888;font-size:10px;padding:12px">No candle data for ' + esc(instrumentName(instr)) + '</div>';
      return;
    }

    if (!_mini) _mini = { chart: null, series: null, lines: [] };
    if (!_mini.chart) {
      const w = host.clientWidth || 800;
      const h = host.clientHeight || 260;
      _mini.chart = window.LightweightCharts.createChart(host, {
        layout: { background: { color: '#0b0b1a' }, textColor: '#d0d0d0' },
        grid: { vertLines: { color: '#1a1a30' }, horzLines: { color: '#1a1a30' } },
        crosshair: { mode: 1 },
        rightPriceScale: { borderColor: '#2d2d50' },
        timeScale: { borderColor: '#2d2d50', timeVisible: true, secondsVisible: false },
        localization: {
          timeFormatter: function (ts) {
            if (window.IST12 && IST12.fmtCandle) return IST12.fmtCandle(ts, false);
            const d = new Date(ts * 1000);
            const h = d.getUTCHours();
            const m = String(d.getUTCMinutes()).padStart(2, '0');
            const ap = h >= 12 ? 'PM' : 'AM', h12 = h % 12 || 12;
            return h12 + ':' + m + ' ' + ap;
          }
        },
        width: w, height: h
      });
      _mini.series = _mini.chart.addSeries(window.LightweightCharts.CandlestickSeries, {
        upColor: '#00d4aa', downColor: '#ff5252',
        borderUpColor: '#00d4aa', borderDownColor: '#ff5252',
        wickUpColor: '#00d4aa', wickDownColor: '#ff5252'
      });
    }

    _mini.series.setData(candles.slice(-400).map(x => ({ time: x.time, open: x.open, high: x.high, low: x.low, close: x.close })));

    clearMiniLines();
    /* Only draw entry/TP/SL lines for positions on the displayed instrument. */
    Object.keys(state.positions).forEach(k => {
      const p = state.positions[k];
      if (p.instrumentId !== instrumentId(instr)) return;
      const tag = p.name ? p.name.slice(0, 12) : 'pos';
      addMiniLine(p.entryPrice, '#ffffff', 2, 'E ' + tag);
      addMiniLine(p.targetPrice, '#00d4aa', 2, 'TP ' + tag);
      addMiniLine(p.stopLoss, '#ef5350', 2, 'SL ' + tag);
    });

    try {
      const last = candles.length - 1;
      _mini.chart.timeScale().applyOptions({ barSpacing: 8, rightOffset: 2 });
      _mini.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, last - 119), to: last });
    } catch (e) {}
  }

  function startMiniPoll() {
    if (_miniTimer) clearInterval(_miniTimer);
    _miniTimer = setInterval(refreshMiniChart, 3000);
  }
  function stopMiniPoll() {
    if (_miniTimer) { clearInterval(_miniTimer); _miniTimer = null; }
  }

  function openMiniChart(instrId) {
    let instr = null;
    if (instrId) {
      for (const k in state.positions) {
        if (state.positions[k].instrumentId === instrId) { instr = state.positions[k].instrument; break; }
      }
    }
    if (!instr) { const cur = currentSymbol(); instr = cur ? { kind: 'underlying', symbol: cur } : null; }
    _miniInstr = instr;
    const panel = $id('aiptChartPanel');
    if (panel) panel.style.display = '';
    const title = $id('aiptChartTitle');
    if (title) title.textContent = instr ? (instrumentName(instr) + ' \u00b7 ' + miniTf()) : '';
    refreshMiniChart();
    startMiniPoll();
  }
  function closeMiniChart() {
    const panel = $id('aiptChartPanel');
    if (panel) panel.style.display = 'none';
    stopMiniPoll();
  }

  /* ---------------- public API ---------------- */
  const api = {
    importFromAE,
    importFromAST,
    refresh() {
      const n = importFromAE();
      log(n ? 'Refreshed ' + n + ' strategies' : 'No strategies to import', n ? 'ok' : 'warn');
      return n;
    },
    toggleAutoTrade() {
      state.autoTrade = !state.autoTrade;
      save();
      render();
      log('AI Paper Trade ' + (state.autoTrade ? 'enabled' : 'disabled'), state.autoTrade ? 'ok' : 'warn');
    },
    runManual() {
      if (state.manualMode && state.autoTrade) {
        state.manualMode = false;
        state.autoTrade = false;
        save();
        render();
        log('Manual strategies stopped', 'warn');
        return;
      }
      state.manualMode = true;
      state.aiMode = false;
      state.autoTrade = true;
      if (!state.strategies.some(s => state.selected[s.key])) {
        state.strategies.forEach(s => { state.selected[s.key] = true; });
        log('No strategies ticked - selected all by default', 'warn');
      }
      save();
      render();
      log('Running manually selected strategies on current symbol', 'ok');
    },
    runAi() {
      if (state.aiMode && state.autoTrade) {
        state.aiMode = false;
        state.autoTrade = false;
        save();
        render();
        log('AI smart trader stopped', 'warn');
        return;
      }
      state.aiMode = true;
      state.manualMode = false;
      state.autoTrade = true;
      save();
      render();
      log('Running AI smart trader: top ' + state.aiTopNBull + ' bullish + top ' + state.aiTopNBear + ' bearish', 'ok');
    },
    onTopNBullInput() {
      const n = $id('aiptTopNBull');
      state.aiTopNBull = n ? Math.max(1, Number(n.value) || 5) : 5;
      save();
      render();
    },
    onTopNBearInput() {
      const n = $id('aiptTopNBear');
      state.aiTopNBear = n ? Math.max(1, Number(n.value) || 5) : 5;
      save();
      render();
    },
    onStrategyCheck(key, checked) {
      state.selected[key] = !!checked;
      save();
      render();
    },
    selectAll() {
      state.strategies.forEach(s => { state.selected[s.key] = true; });
      save();
      render();
      log('Selected all ' + state.strategies.length + ' strategies', 'ok');
    },
    selectNone() {
      state.strategies.forEach(s => { state.selected[s.key] = false; });
      save();
      render();
      log('Cleared strategy selection', 'warn');
    },
    removeList(cat, mode) {
      removeList(cat, mode);
    },
    openChart(instrId) {
      openMiniChart(instrId);
    },
    closeChart() {
      closeMiniChart();
    },
    stopStrategy(key) {
      stopStrategy(key);
    },
    stopAll() {
      stopAll();
    },
    stopAllStrategies() {
      stopAllStrategies();
    },
    sendToAISmart() {
      sendToAISmart();
    },
    detail(key) {
      showDetail(key);
    },
    closeDetail() {
      const m = $id('aiptDetailModal');
      if (m) m.classList.add('hidden');
    },
    getState() { return state; },
    runningStrategies() { return activeStrategies(); },
    tick,
    onTabShow() {
      render();
    }
  };
  api.boot = boot;
  api.startPoll = startPoll;
  api.stopPoll = stopPoll;
  api.startMiniPoll = startMiniPoll;
  api.stopMiniPoll = stopMiniPoll;

  /* Lightweight live re-render of the Running positions + summary only (no
     strategy list / mini-chart re-render). Driven by the throttled ~250ms
     quote loop so the Running P&L uses the exact same live quote the chart
     shows, instead of lagging behind the multi-second poll tick. */
  api.refreshLiveRunning = function () {
    renderOpen();
    renderSummary();
  };

  /* Per-tab instance registry + active-tab facade. Each paper engine keeps its
     own registry (TabEngines.aipt / papertrade / aismart / paperrun) but they
     all share the same tab id key ("papertrade" for the base tab, "paperN" for
     duplicated tabs), so a single window._paperActiveEngine routes every paper
     engine call to the correct duplicated tab's instance. */
  if (!window.TabEngines) window.TabEngines = {};
  if (!window.TabEngines.aipt) window.TabEngines.aipt = {};
  const instKey = suffix.replace(/^_/, '') || 'papertrade';
  window.TabEngines.aipt[instKey] = api;

  if (!window._AIPaperFacade) {
    const base = api;
    window._AIPaperFacade = new Proxy(base, {
      get(t, prop) {
        const key = window._paperActiveEngine || 'papertrade';
        const eng = window.TabEngines.aipt[key] || t;
        const v = eng[prop];
        return typeof v === 'function' ? v.bind(eng) : v;
      },
      set(t, prop, val) {
        const key = window._paperActiveEngine || 'papertrade';
        const eng = window.TabEngines.aipt[key] || t;
        eng[prop] = val;
        return true;
      }
    });
    window.AIPaperTrade = window._AIPaperFacade;
  }

  /* ---------------- boot ---------------- */
  function boot() {
    const tnB = $id('aiptTopNBull');
    if (tnB) tnB.addEventListener('input', () => api.onTopNBullInput());
    const tnS = $id('aiptTopNBear');
    if (tnS) tnS.addEventListener('input', () => api.onTopNBearInput());
    render();
    startPoll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
  return api;
}
