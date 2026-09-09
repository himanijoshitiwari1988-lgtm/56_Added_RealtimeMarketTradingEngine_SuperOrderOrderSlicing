/* RSI Divergence detection core (pure, dependency-free).
 *
 * TradingView-style RSI divergence between the Wilder-smoothed RSI and price
 * swing pivots. Detects, on confirmed (non-repainting) swing points of the RSI:
 *
 *   REGULAR bullish  : price makes a LOWER low while RSI prints a HIGHER low
 *                      (reversal: falling momentum is fading at a new low)
 *   HIDDEN bullish   : price makes a HIGHER low while RSI prints a LOWER low
 *                      (continuation inside an up-leg)
 *   REGULAR bearish  : price makes a HIGHER high while RSI prints a LOWER high
 *                      (reversal: rising momentum is fading at a new high)
 *   HIDDEN bearish   : price makes a LOWER high while RSI prints a HIGHER high
 *                      (continuation inside a down-leg)
 *
 * Math notes:
 *  - RSI uses Wilder RMA smoothing (alpha = 1/length) seeded with an SMA over
 *    the first `length` gains/losses - the same definition TradingView's RSI
 *    uses, so the RSI line matches the platform exactly for the same input
 *    closes. avgLoss == 0 -> RSI 100; both zero -> 50 (neutral).
 *  - Swing pivots are strict fractals on the RSI series: bar i is a swing low
 *    only when RSI[i] is strictly lower than the `pivot` bars on BOTH sides.
 *    A pivot needs its full right window to exist, so nothing here ever looks
 *    into a future that has not printed yet (no repainting).
 *  - Each signal is drawn once its swing confirms, then never changes as later
 *    bars append - classification is stable for already-confirmed pivots.
 *
 * The module is a UMD: attaches to window.RsiDivCore in the browser and is
 * require()-able under Node so the divergence math can be unit-tested without
 * a DOM. No file in this project depends on chart/DOM internals.
 */
(function (root) {
  'use strict';

  function rsiWilder(closes, len) {
    const n = closes.length;
    const out = new Array(n).fill(NaN);
    if (n < len + 1 || len < 1) return out;
    /* Wilder RMA of gains / losses. Seed = SMA of the first `len` changes,
       then recurse with alpha = 1/len. gain/loss at bar i uses change vs bar
       i-1, so the first computable bar is index `len`. */
    let g = 0, l = 0;
    for (let i = 1; i <= len; i++) {
      const d = closes[i] - closes[i - 1];
      if (d > 0) g += d; else l -= d;
    }
    let avgG = g / len, avgL = l / len;
    out[len] = 100 - 100 / (1 + (avgL ? avgG / avgL : (avgG ? Infinity : 1)));
    if (!isFinite(out[len])) out[len] = avgL ? out[len] : (avgG ? 100 : 50);
    for (let i = len + 1; i < n; i++) {
      const d = closes[i] - closes[i - 1];
      const gain = d > 0 ? d : 0, loss = d < 0 ? -d : 0;
      avgG = (avgG * (len - 1) + gain) / len;
      avgL = (avgL * (len - 1) + loss) / len;
      let v;
      if (avgL === 0) v = avgG === 0 ? 50 : 100;
      else v = 100 - 100 / (1 + avgG / avgL);
      out[i] = v;
    }
    return out;
  }

  /* Strict-fractal swing points on a numeric series (NaN = "not a bar").
     `p` bars must exist on each side AND each of them must beat the centre
     strictly, so the classification is stable as soon as the right window has
     printed (a pivot never flips when later bars arrive - no repainting).

     Left/right extrema are computed in O(n*p) per index by scanning the two
     `p`-bar windows directly; an all-NaN window disqualifies the centre, which
     means a null RSI (warm-up zone) can never seed a pivot. */
  function swingPoints(vals, p) {
    const n = vals.length;
    const lows = [], highs = [];
    if (n < 2 * p + 1) return { lows, highs };
    /* leftExt[i] = {lo, hi} over vals[i-p .. i-1] (NaN if any is non-numeric);
       rightExt[i] = {lo, hi} over vals[i+1 .. i+p]. */
    const Llo = new Array(n), Lhi = new Array(n);
    const Rlo = new Array(n), Rhi = new Array(n);
    for (let i = 0; i < n; i++) {
      if (i >= p) {
        let mn = Infinity, mx = -Infinity, ok = true;
        for (let j = i - p; j < i; j++) {
          const w = vals[j];
          if (w == null || isNaN(w)) { ok = false; break; }
          if (w < mn) mn = w;
          if (w > mx) mx = w;
        }
        if (ok) { Llo[i] = mn; Lhi[i] = mx; }
      }
      if (i + p < n) {
        let mn = Infinity, mx = -Infinity, ok = true;
        for (let j = i + 1; j <= i + p; j++) {
          const w = vals[j];
          if (w == null || isNaN(w)) { ok = false; break; }
          if (w < mn) mn = w;
          if (w > mx) mx = w;
        }
        if (ok) { Rlo[i] = mn; Rhi[i] = mx; }
      }
    }
    for (let i = p; i < n - p; i++) {
      const v = vals[i];
      if (v == null || isNaN(v)) continue;
      if (Llo[i] == null || Rlo[i] == null) continue;
      if (Lhi[i] < v && Rhi[i] < v) highs.push(i);
      if (Llo[i] > v && Rlo[i] > v) lows.push(i);
    }
    return { lows, highs };
  }

  /* Full divergence scan on candles [{time, high, low, close}].
     opts: { length=14, pivot=5, lookback=200 }
     Returns { rsi, lows, highs, signals } where each signal is:
       { index, time, kind:'bull'|'bear', hidden:boolean,
         price, rsi, refIndex, refPrice, refRsi }
     A signal is emitted at the LATER (confirming) pivot of the pair. */
  function divergence(candles, opts) {
    opts = opts || {};
    const len = Math.max(1, Math.round(opts.length) || 14);
    const p = Math.max(1, Math.round(opts.pivot) || 5);
    const lookback = Math.max(p * 2, Math.round(opts.lookback) || 200);
    const n = candles.length;
    const closes = new Array(n), highs = new Array(n), lows = new Array(n);
    for (let i = 0; i < n; i++) {
      closes[i] = candles[i].close;
      highs[i] = candles[i].high;
      lows[i] = candles[i].low;
    }
    const rsi = rsiWilder(closes, len);
    const sp = swingPoints(rsi, p);
    const sig = [];
    for (let hi = 0; hi < sp.highs.length; hi++) {
      const i = sp.highs[hi];
      const rv = rsi[i], pv = highs[i];
      for (let k = hi - 1; k >= 0; k--) {
        const j = sp.highs[k];
        if (i - j > lookback) break;
        const rRef = rsi[j], pRef = highs[j];
        if (rRef == null || rRef === rv) continue;
        /* price HH + RSI lower high = regular bearish; price LH + RSI higher
           high = hidden bearish. Compare price high of BOTH pivot bars. */
        if (pv > pRef && rv < rRef) {
          sig.push({ index: i, time: candles[i].time, kind: 'bear', hidden: false, price: pv, rsi: rv, refIndex: j, refPrice: pRef, refRsi: rRef });
          break;
        }
        if (pv < pRef && rv > rRef) {
          sig.push({ index: i, time: candles[i].time, kind: 'bear', hidden: true, price: pv, rsi: rv, refIndex: j, refPrice: pRef, refRsi: rRef });
          break;
        }
      }
    }
    for (let lo = 0; lo < sp.lows.length; lo++) {
      const i = sp.lows[lo];
      const rv = rsi[i], pv = lows[i];
      for (let k = lo - 1; k >= 0; k--) {
        const j = sp.lows[k];
        if (i - j > lookback) break;
        const rRef = rsi[j], pRef = lows[j];
        if (rRef == null || rRef === rv) continue;
        /* price LL + RSI higher low = regular bullish; price HL + RSI lower
           low = hidden bullish. Compare price low of BOTH pivot bars. */
        if (pv < pRef && rv > rRef) {
          sig.push({ index: i, time: candles[i].time, kind: 'bull', hidden: false, price: pv, rsi: rv, refIndex: j, refPrice: pRef, refRsi: rRef });
          break;
        }
        if (pv > pRef && rv < rRef) {
          sig.push({ index: i, time: candles[i].time, kind: 'bull', hidden: true, price: pv, rsi: rv, refIndex: j, refPrice: pRef, refRsi: rRef });
          break;
        }
      }
    }
    sig.sort((a, b) => a.index - b.index);
    return { rsi, lows: sp.lows, highs: sp.highs, signals: sig };
  }

  const API = { rsiWilder, swingPoints, divergence };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.RsiDivCore = API;
})(typeof self !== 'undefined' ? self : this);
