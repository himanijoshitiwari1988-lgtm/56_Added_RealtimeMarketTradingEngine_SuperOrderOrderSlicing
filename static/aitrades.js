/* Dhan Algo - AI Auto Trades (smart trade-count decision engine)
 *
 * Decides HOW MANY trades the Auto Experiment engine should take per strategy
 * by analysing the market as a whole. The engine fuses a broad set of
 * conditions so the budget is genuinely "smart" and auditable:
 *
 *   - Overlay / chart conditions: EMA 9/21 trend, ATR% volatility regime.
 *   - Pane indicators (computed up to 10 in total):
 *       RSI(14), MACD(12,26,9), Bollinger %B(20,2), Stochastic(14),
 *       Williams %R(14), Volume, Volume Oscillator(5,20), Volume Ratio,
 *       Open Interest (live, when available).
 *   - Win potential: a trailing-stop strategy is simulated over the recent
 *     window; its average captured profit + win rate probe the question
 *     "would this tape pay a trader right now?".
 *   - Market open / close time + volatility stabilisation: NSE session phases
 *     (opening / mid / afternoon / closing) are derived from candle
 *     timestamps. After the opening bell the market is treated as unsettled
 *     until its volatility stabilises (recent ATR settles near the session
 *     median) - the engine waits rather than chasing the opening spike.
 *
 * API: decide(candles, live, ctx) -> { trades, reasons, conf }.
 * ctx (optional) may carry live Open Interest: { oi, oiPrev }.
 */
(function () {
  'use strict';

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function median(a) { var s = a.slice().sort(function (x, y) { return x - y; }); return s[Math.floor(s.length / 2)]; }

  var ATR_P = 14, RSI_P = 14;

  /* ---------- indicator computations (array form over the window) ---------- */

  function emaSeries(arr, period) {
    var k = 2 / (period + 1), e = arr[0].close, out = [e], i;
    for (i = 1; i < arr.length; i++) { e += k * (arr[i].close - e); out.push(e); }
    return out;
  }

  function rsiSeries(arr) {
    var out = [], i;
    for (i = 0; i < arr.length; i++) {
      if (i < RSI_P) { out.push(50); continue; }
      var gains = 0, losses = 0, j;
      for (j = i - RSI_P + 1; j <= i; j++) {
        var d = arr[j].close - arr[j - 1].close;
        if (d > 0) gains += d; else losses += -d;
      }
      out.push(losses === 0 ? 100 : 100 - 100 / (1 + gains / losses));
    }
    return out;
  }

  function atrSeries(arr) {
    var out = [null, null], prevClose = arr[0].close, atr = null, i;
    for (i = 1; i < arr.length; i++) {
      var hi = arr[i].high, lo = arr[i].low;
      var tr = Math.max(hi - lo, Math.abs(hi - prevClose), Math.abs(lo - prevClose));
      prevClose = arr[i].close;
      if (atr === null) atr = tr; else atr += (1 / ATR_P) * (tr - atr);
      out.push(atr);
    }
    return out;
  }

  function macdSeries(arr) {
    var f = emaSeries(arr, 12), s = emaSeries(arr, 26), line = [], i;
    for (i = 0; i < arr.length; i++) line.push(f[i] - s[i]);
    var sig = [], e = line[0], k = 2 / 10, j;
    for (j = 0; j < line.length; j++) { if (j === 0) { sig.push(line[0]); } else { e += k * (line[j] - e); sig.push(e); } }
    return { line: line, sig: sig };
  }

  function sma(arr, period, idx, field) {
    if (idx + 1 < period) return null;
    var s = 0, i;
    for (i = idx - period + 1; i <= idx; i++) s += arr[i][field || 'close'];
    return s / period;
  }

  function stdDev(arr, period, idx) {
    var m = sma(arr, period, idx, 'close');
    if (m == null) return null;
    var s = 0, i;
    for (i = idx - period + 1; i <= idx; i++) { var d = arr[i].close - m; s += d * d; }
    return Math.sqrt(s / period);
  }

  function stochAt(arr, idx, period) {
    if (idx + 1 < period) return 50;
    var hh = -Infinity, ll = Infinity, i;
    for (i = idx - period + 1; i <= idx; i++) {
      if (arr[i].high > hh) hh = arr[i].high;
      if (arr[i].low < ll) ll = arr[i].low;
    }
    if (hh === ll) return 50;
    return (arr[idx].close - ll) / (hh - ll) * 100;
  }

  function williamsRAt(arr, idx, period) {
    if (idx + 1 < period) return -50;
    var hh = -Infinity, ll = Infinity, i;
    for (i = idx - period + 1; i <= idx; i++) {
      if (arr[i].high > hh) hh = arr[i].high;
      if (arr[i].low < ll) ll = arr[i].low;
    }
    if (hh === ll) return -50;
    return (hh - arr[idx].close) / (hh - ll) * -100;
  }

  /* ---------- win-potential probe ---------- */

  function simTrade(arr, start) {
    var entry = arr[start].close, peak = entry, exitPrice = null;
    for (var i = start + 1; i < arr.length; i++) {
      var hi = arr[i].high, lo = arr[i].low;
      if (hi > peak) peak = hi;
      var trail = peak * (1 - 0.01);
      if (trail > entry && lo <= trail) { exitPrice = trail; break; }
    }
    if (exitPrice == null) exitPrice = arr[arr.length - 1].close;
    return (exitPrice - entry) / entry * 100;
  }

  function simWinPotential(arr) {
    var end = arr.length - 5, sum = 0, wins = 0, cnt = 0, i;
    for (i = 0; i < end; i++) { var r = simTrade(arr, i); sum += r; cnt++; if (r > 0) wins++; }
    if (!cnt) return { winRate: 0, avg: 0, n: 0 };
    return { winRate: wins / cnt, avg: sum / cnt, n: cnt };
  }

  /* ---------- market open / close time conditions ---------- */

  /* NSE session phase for an IST wall-clock (naive-UTC encoded) candle time.
     9:15-10:15 opening, 10:15-13:00 mid, 13:00-14:30 afternoon,
     14:30-15:30 closing, anything else = closed. */
  function phaseOf(t) {
    var d = new Date(t * 1000);
    var m = d.getUTCHours() * 60 + d.getUTCMinutes();
    if (m < 555 || m >= 930) return 'closed';
    if (m < 615) return 'opening';
    if (m < 780) return 'mid';
    if (m < 870) return 'afternoon';
    return 'closing';
  }

  function dominantPhase(arr) {
    var counts = { opening: 0, mid: 0, afternoon: 0, closing: 0, closed: 0 };
    var n = arr.length, start = Math.max(0, n - 60), i;
    for (i = start; i < n; i++) counts[phaseOf(arr[i].time || 0)]++;
    var best = 'mid', bestC = -1;
    for (var k in counts) if (counts[k] > bestC) { bestC = counts[k]; best = k; }
    return best;
  }

  /* Volatility stabilisation after the opening bell: how close the recent ATR%
     is to the session's median. A freshly-opened market still digesting the
     opening spike has recent vol far above its median (score -> 0, wait);
     once vol settles near the session median the tape is treated as stable
     (score -> 1) and the engine trades normally. */
  function volStabScore(arr, atrs, idx) {
    var n = idx + 1;
    if (n < 25) return 0.5;
    var pcts = [], i;
    for (i = 10; i <= idx; i++) {
      var p = arr[i].close;
      if (p > 0 && atrs[i] != null) pcts.push(atrs[i] / p * 100);
    }
    if (pcts.length < 15) return 0.5;
    var med = median(pcts) || 0.5;
    var recent = pcts.slice(-10);
    var recentMed = recent.length ? median(recent) : med;
    var diff = Math.abs(recentMed - med) / (med || 1e-9);
    return clamp(1 - diff / 1.5, 0, 1);
  }

  /* ---------- main decision ---------- */

  function decide(candles, live, ctx) {
    if (!candles || candles.length < 30) {
      return { trades: 1, reasons: ['insufficient data'], conf: 0 };
    }
    var arr = candles.slice(-90);
    var n = arr.length, last = n - 1;
    var close = arr[last].close;

    var atrs = atrSeries(arr);
    var atr = atrs[last], atrPct = (atr && close > 0) ? atr / close * 100 : 0;
    var stabScore = volStabScore(arr, atrs, last);

    var e9 = emaSeries(arr, 9), e21 = emaSeries(arr, 21);
    var trendPct = (e9[last] - e21[last]) / (close || 1) * 100;
    var bull = 0, bear = 0, i;
    for (i = 21; i < n; i++) { if (arr[i].close > e21[i]) bull++; else bear++; }
    var align = (n > 21) ? Math.max(bull, bear) / (n - 21) : 0.5;

    var rsiArr = rsiSeries(arr);
    var rsi = rsiArr[last];
    var macd = macdSeries(arr);
    var macdHist = macd.line[last] - macd.sig[last];

    var lastVol = arr[last].volume != null ? Number(arr[last].volume) : 0;
    var v5 = sma(arr, 5, last, 'volume'), v20 = sma(arr, 20, last, 'volume');
    var volOsc = (v5 != null && v20 > 0) ? (v5 - v20) / v20 * 100 : 0;
    var volRatio = v20 > 0 ? lastVol / v20 : 1;

    var bbMid = sma(arr, 20, last, 'close');
    var bbStd = stdDev(arr, 20, last);
    var pctB = (bbMid != null && bbStd > 0) ? (close - (bbMid - 2 * bbStd)) / (4 * bbStd) : 0.5;

    var stochK = stochAt(arr, last, 14);
    var willR = williamsRAt(arr, last, 14);

    var oi = (ctx && ctx.oi != null) ? Number(ctx.oi) : null;
    var oiPrev = (ctx && ctx.oiPrev != null) ? Number(ctx.oiPrev) : null;
    var oiChgPct = (oi != null && oiPrev != null && oiPrev !== 0) ? (oi - oiPrev) / oiPrev * 100 : null;

    /* ---------- indicator scores (each 0..1) ---------- */
    var sim = simWinPotential(arr);
    var winScore = clamp(sim.winRate, 0, 1) * 0.6 + clamp(sim.avg > 0 ? Math.min(sim.avg, 3) / 3 : 0, 0, 1) * 0.4;

    var trendScore = clamp(Math.abs(trendPct) / 0.5, 0, 1) * 0.5 + align * 0.5;

    var rsiScore = clamp((50 - Math.abs(rsi - 50)) / 20, 0, 1);
    var macdScore = clamp(Math.abs(macdHist) / ((atrPct || 0.2) * 0.6), 0, 1);
    var momentumScore = rsiScore * 0.5 + macdScore * 0.5;

    var volScore = 1 - clamp(Math.abs(atrPct - 0.8) / 1.2, 0, 1);

    var volOscScore = clamp((volOsc + 10) / 20, 0, 1);
    var volRatioScore = clamp((volRatio - 0.5) / 1.5, 0, 1);

    var oiScore = (oiChgPct != null) ? clamp((oiChgPct + 3) / 6, 0, 1) : 0.5;

    var stochScore = clamp((50 - Math.abs(stochK - 50)) / 25, 0, 1);
    var willScore = clamp((50 - Math.abs(willR + 50)) / 25, 0, 1);
    var oscScore = stochScore * 0.5 + willScore * 0.5;

    var bbScore = clamp((50 - Math.abs(pctB * 100 - 50)) / 50, 0, 1);

    /* Weighted blend of every condition into a single opportunity score. */
    var score =
      winScore * 0.20 +
      trendScore * 0.13 +
      momentumScore * 0.11 +
      stabScore * 0.12 +
      volScore * 0.07 +
      volOscScore * 0.10 +
      volRatioScore * 0.06 +
      oiScore * 0.07 +
      oscScore * 0.08 +
      bbScore * 0.06;

    var phase = dominantPhase(arr);
    var closed = phase === 'closed';
    /* After the opening bell the engine waits for volatility to stabilise
       before treating the opening as a full opportunity window; the closing
       window is an opportunity; the quiet afternoon is de-rated. */
    var phaseAdj = 0;
    if (phase === 'opening') phaseAdj = stabScore > 0.6 ? 1 : 0;
    else if (phase === 'closing') phaseAdj = 1;
    else if (phase === 'afternoon') phaseAdj = -1;

    var trades = 1 + Math.round(score * 7) + phaseAdj;
    trades = Math.max(1, Math.min(10, trades));
    if (closed && live) trades = 0;

    /* ---------- reasons (auditable) ---------- */
    var reasons = [];
    reasons.push(winScore >= 0.6 ? 'high-win-potential' : 'win-potential-' + Math.round(sim.winRate * 100) + '%');
    if (Math.abs(trendPct) > 0.2) reasons.push(trendPct > 0 ? 'uptrend' : 'downtrend');
    else reasons.push('range');
    if (rsi > 70) reasons.push('rsi-overbought');
    else if (rsi < 30) reasons.push('rsi-oversold');
    else reasons.push('rsi-neutral');
    reasons.push(macdHist > 0 ? 'macd-bull' : 'macd-bear');
    if (atrPct > 1.2) reasons.push('high-vol');
    else if (atrPct < 0.4) reasons.push('low-vol');
    reasons.push(stabScore < 0.4 ? 'vol-unsettled-post-open' : (stabScore > 0.7 ? 'vol-stable' : 'vol-settling'));
    if (volOsc > 5) reasons.push('vol-expansion');
    else if (volOsc < -5) reasons.push('vol-contraction');
    if (volRatio > 1.2) reasons.push('volume-surge');
    if (oiChgPct != null) reasons.push(oiChgPct > 0 ? 'oi-rising' : 'oi-falling');
    reasons.push('phase:' + phase);
    if (closed) reasons.push('market-closed');
    if (trades >= 7) reasons.push('aggressive');
    else if (trades <= 2) reasons.push('conservative');

    return {
      trades: trades,
      reasons: reasons.slice(0, 6),
      conf: clamp(0.4 + score * 0.6, 0, 1),
      stab: Math.round(stabScore * 100) / 100
    };
  }

  window.AITradesEngine = { decide: decide };
})();
