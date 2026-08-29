/* Dhan Algo - Fast Cross Detection Engine (nanosecond-class overlay cross detection)
 *
 * Detects "crossed above" / "crossed below" between ANY two series on the candlestick
 * chart in O(1) by reading {prev, last} of each source through the fastest available
 * path (already-rendered chart series, then memoized/incremental compute). Supports:
 *
 *   - overlay indicator  vs  overlay indicator  (EMA cross SMA, Supertrend cross EMA, ...)
 *   - overlay indicator  vs  candle close/open/high/low
 *   - candle field       vs  candle field        (close crossed above Bollinger mid = bb v1)
 *   - fixed number
 *
 * Chain evaluation: a chain is an AND-list of conditions evaluated against the SAME
 * candle state; it short-circuits on the first failing condition so a chain that is
 * usually false runs in a handful of arithmetic ops. The engine emits a "signal"
 * (false -> true edge) so the strategy engine fires once per cross, not every tick.
 */
(function () {
  'use strict';

  /* A source descriptor is one of:
   *   { type: 'ind',    id, settings, key }        -> indicator series value
   *   { type: 'candle', key }                      -> candle open/high/low/close
   *   { type: 'number', value }                    -> fixed number
   *   { type: 'candlestick_pattern', patterns[] }  -> 1 if any pattern detected, 0 otherwise
   */
  function readLastTwo(src, candles) {
    if (!src) return { last: null, prev: null };
    if (src.type === 'number') {
      const n = Number(src.value) || 0;
      return { last: n, prev: n };
    }
    if (src.type === 'candle') {
      const k = src.key || 'close';
      const n = candles ? candles.length : 0;
      const last = n ? candles[n - 1][k] : null;
      const prev = n > 1 ? candles[n - 2][k] : null;
      return { last: last == null ? null : Number(last), prev: prev == null ? null : Number(prev) };
    }
    if (src.type === 'candlestick_pattern') {
      const CP = window.CandlePatterns;
      const patterns = src.patterns || [];
      if (!CP || !patterns.length) return { last: 0, prev: 0 };
      const hit = CP.detectAny(patterns, candles) ? 1 : 0;
      return { last: hit, prev: hit };
    }
    /* indicator */
    if (window.IndChart && IndChart.renderedLastTwo) {
      const fast = IndChart.renderedLastTwo(src.id, src.settings || {}, src.key || 'v0', candles);
      if (fast) return fast;
    }
    if (window.IndChart && IndChart.computeLastTwo) {
      return IndChart.computeLastTwo(src.id, src.settings || {}, src.key || 'v0', candles);
    }
    return { last: null, prev: null };
  }

  /* Core cross detection. Returns boolean.
   *
   * crossAbove / crossBelow are STATE-based (level checks), not edge-based:
   * they return true whenever the current relationship already holds
   * (a.last > b.last / a.last < b.last). The engine deliberately does NOT
   * require a fresh crossing event on the current bar, so a strategy whose
   * price already sits above the Supertrend band fires immediately instead of
   * waiting for a flip that already happened in the past. */
  function detect(logic, a, b) {
    if (a == null || b == null) return false;
    if (a.last == null || b.last == null) return false;
    switch (logic) {
      case 'crossAbove': return a.last > b.last;
      case 'crossBelow': return a.last < b.last;
      case 'gt': return a.last > b.last;
      case 'lt': return a.last < b.last;
      case 'gte': return a.last >= b.last;
      case 'lte': return a.last <= b.last;
      case 'eq': return Math.abs(a.last - b.last) < 1e-9;
      case 'neq': return Math.abs(a.last - b.last) >= 1e-9;
      default: return false;
    }
  }

  /* Read the last n valid readings of an indicator source's series.
     Needed for stable trend / slope checks (incUp / incDown). */
  function readLastN(src, candles, n) {
    if (!src || src.type !== 'ind' || !window.IndChart || !IndChart.IND) return [];
    const def = IndChart.IND[src.id];
    if (!def || !def.compute) return [];
    let out;
    try { out = def.compute(candles, src.settings || {}); } catch (e) { return []; }
    if (!Array.isArray(out) || !out.length) return [];
    const idx = parseInt(String(src.key || 'v0').replace(/^v/, ''), 10) || 0;
    const s = out[idx];
    if (!s || !s.data) return [];
    const vals = [];
    const arr = s.data;
    for (let i = arr.length - 1; i >= 0 && vals.length < n; i--) {
      const v = arr[i];
      if (v && v.value != null && !isNaN(v.value)) vals.push(v.value);
    }
    return vals.reverse();
  }

  /* Linear-regression slope of the given values (per-bar change rate). */
  function trendSlope(vals) {
    const n = vals.length;
    if (n < 2) return 0;
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) { sx += i; sy += vals[i]; sxy += i * vals[i]; sxx += i * i; }
    const denom = n * sxx - sx * sx;
    if (denom === 0) return 0;
    return (n * sxy - sx * sy) / denom;
  }

  /* Robust direction of a numeric series: 'up' | 'down' | 'flat'.
   *
   * A line is judged "increasing upward" only when ALL of the following hold
   * over the lookback window (avoids noise / single-bar spikes):
   *   - net change (last - first) is material (> 0.15% of the line's scale)
   *   - linear-regression slope agrees with the net change
   *   - a clear majority (>= 60%) of the bar-to-bar moves point the same way
   *   - at least (n-1) bars moved (not mostly do-nothing bars)
   */
  function seriesDirection(vals) {
    const n = vals.length;
    if (n < 4) return 'flat';
    const clean = [];
    for (let i = 0; i < n; i++) {
      const v = vals[i];
      if (v != null && !isNaN(v)) clean.push(Number(v));
    }
    if (clean.length < 4) return 'flat';
    const first = clean[0];
    const last = clean[clean.length - 1];
    const sum = clean.reduce(function (a, b) { return a + b; }, 0);
    const avg = sum / clean.length;
    const scale = Math.abs(avg) > 1e-12 ? Math.abs(avg) : 1;
    const net = last - first;
    if (Math.abs(net) / scale < 0.0015) return 'flat';
    let ups = 0, downs = 0, flatBars = 0;
    for (let i = 1; i < clean.length; i++) {
      const d = clean[i] - clean[i - 1];
      if (d > 0) ups++; else if (d < 0) downs++; else flatBars++;
    }
    if (ups + downs < clean.length - 1) return 'flat';
    const upFrac = ups / (ups + downs);
    const slope = trendSlope(clean);
    if (net > 0 && slope > 0 && upFrac >= 0.6) return 'up';
    if (net < 0 && slope < 0 && upFrac <= 0.4) return 'down';
    return 'flat';
  }

  /* Series memoization so the connector's movement evaluation does not recompute
     the whole indicator series on every tick within the same candle state. */
  const SR_CACHE = new Map();
  const SR_MAX = 128;

  function seriesSig(candles, id, settings, key) {
    const n = candles ? candles.length : 0;
    const last = n ? candles[n - 1] : null;
    const prev = n > 1 ? candles[n - 2] : null;
    return n + ':' + (last ? last.time + ':' + last.close + ':' + last.high + ':' + last.low : '') +
      ':' + (prev ? prev.time + ':' + prev.close : '') + ':' + id + ':' + JSON.stringify(settings) + ':' + key;
  }

  /* Compute the full indicator series once and read the trailing values of each
     line the indicator draws (plot = v0, second line = v1 when present). */
  function movementLines(indId, settings, candles, n) {
    const def = window.IndChart && IndChart.IND ? IndChart.IND[indId] : null;
    if (!def || !def.compute || !candles || !candles.length) return { plot: [], second: [] };
    const sig = seriesSig(candles, indId, settings || {}, '__all__');
    const hit = SR_CACHE.get(sig);
    if (hit) return hit;
    let out;
    try { out = def.compute(candles, settings || {}); } catch (e) { return { plot: [], second: [] }; }
    const grab = function (s, cnt) {
      const vals = [];
      if (!s || !s.data) return vals;
      const arr = s.data;
      for (let i = arr.length - 1; i >= 0 && vals.length < cnt; i--) {
        const v = arr[i];
        if (v && v.value != null && !isNaN(v.value)) vals.push(v.value);
      }
      return vals.reverse();
    };
    const res = {
      plot: Array.isArray(out) && out.length ? grab(out[0], n) : [],
      second: Array.isArray(out) && out.length > 1 ? grab(out[1], n) : []
    };
    SR_CACHE.set(sig, res);
    if (SR_CACHE.size > SR_MAX) { const k = SR_CACHE.keys().next().value; SR_CACHE.delete(k); }
    return res;
  }

  /* Simple moving average of a series (for de-noising the movement line). */
  function sma(vals, len) {
    if (!vals || vals.length < len) return [];
    const out = [];
    for (let i = len - 1; i < vals.length; i++) {
      let s = 0;
      for (let j = 0; j < len; j++) s += vals[i - j];
      out.push(s / len);
    }
    return out;
  }

  /* Pane-indicator movement check for the strategy-builder connector.
   *
   * "Increasing upward" is true only when EVERY relevant line the pane indicator
   * draws is simultaneously rising; "increasing downward" is the exact mirror.
   * Requiring all lines to agree filters out chop and single-bar spikes, giving
   * a high-accuracy trend read.
   *
   * MACD is treated specially: the movement is defined strictly by the MACD line
   * (v0) and the Signal line (v1) — both must be rising / falling together. The
   * generic velocity/acceleration leg is skipped because the Signal line already
   * lags the MACD line, so a steady move would otherwise never qualify.
   */
  function movementDirection(indId, settings, move, candles) {
    if (!indId) return false;
    if (move !== 'incUp' && move !== 'incDown') return false;
    if (!candles || candles.length < 12) return false;
    const want = move === 'incUp' ? 'up' : 'down';
    const { plot, second } = movementLines(indId, settings, candles, 8);
    if (plot.length < 5) return false;
    if (seriesDirection(plot) !== want) return false;
    if (second.length >= 4 && seriesDirection(second) !== want) return false;
    if (indId === 'macd') return true;
    const vel = [];
    for (let i = 1; i < plot.length; i++) vel.push(plot[i] - plot[i - 1]);
    if (vel.length < 4) return false;
    const velLine = vel.length >= 5 ? sma(vel, 3) : sma(vel, 2);
    if (seriesDirection(velLine) !== want) return false;
    return true;
  }

  /* Evaluate incUp / incDown: the indicator's recent readings are rising
     (slope > 0 and last above first) or falling (slope < 0 and last below first)
     across a small window, so trend is judged on direction, not one noisy bar. */
  function trendDirection(vals, logic) {
    if (vals.length < 3) return false;
    const slope = trendSlope(vals);
    if (logic === 'incUp') return slope > 0 && vals[vals.length - 1] > vals[0];
    if (logic === 'incDown') return slope < 0 && vals[vals.length - 1] < vals[0];
    return false;
  }

  /* Evaluate one condition: { a: src, logic, b: src } */
  function evalCondition(cond, candles) {
    if (!cond) return false;
    if (cond.logic === 'incUp' || cond.logic === 'incDown') {
      return trendDirection(readLastN(cond.a, candles, 5), cond.logic);
    }
    if (cond.logic === 'andFirst') {
      const a = readLastTwo(cond.a, candles);
      const b = readLastTwo(cond.b, candles);
      return detect('gt', a, b);
    }
    const a = readLastTwo(cond.a, candles);
    const b = readLastTwo(cond.b, candles);
    return detect(cond.logic, a, b);
  }

  /* Evaluate a chain: array of conditions, ALL must be true (AND).
     Short-circuits on first false -> fastest path for a usually-false chain.
     A condition with the "andFirst" logic additionally requires the FIRST
     condition in the chain to also be true. */
  function evalChain(chain, candles) {
    if (!chain || !chain.length) return false;
    for (let i = 0; i < chain.length; i++) {
      const cond = chain[i];
      if (cond && cond.logic === 'andFirst' && i > 0) {
        if (!evalCondition(chain[0], candles)) return false;
      }
      if (!evalCondition(cond, candles)) return false;
    }
    return true;
  }

  /* Signal state tracker: returns true only on the false -> true edge of a chain,
     so a strategy fires once per cross event instead of every poll tick.
     Exposes `last` so the strategy engine can drive the edge when a chain uses
     AND/OR connectors + pane-movement gates (which the flat AND-chain cannot). */
  function createSignal() {
    let prev = false;
    const sig = {
      fire(chain, candles) {
        const now = evalChain(chain, candles);
        const edge = now && !prev;
        prev = now;
        return edge;
      },
      reset() { prev = false; },
      get last() { return prev; },
      set last(v) { prev = !!v; }
    };
    return sig;
  }

  window.CrossDetector = {
    readLastTwo,
    readLastN,
    trendSlope,
    trendDirection,
    seriesDirection,
    movementDirection,
    detect,
    evalCondition,
    evalChain,
    createSignal
  };
})();
