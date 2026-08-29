/* Dhan Algo - AI Decided Trail % (adaptive profit-maximizing engine)
 *
 * A SEPARATE trail decision engine from the rule-based Auto Trail Engine
 * (autotrail.js). Instead of scoring pre-defined conditions, this engine
 * DECIDES the trail % directly from the recent tape: it simulates a trailing
 * stop over the last N bars across a grid of candidate trail % values and
 * picks the one that captures the most profit on average. The chosen value is
 * then fused with a volatility / trend-regime adjustment so the live decision
 * stays adaptive even between re-learns.
 *
 * What it is optimizing:
 *   - entered at each recent bar, a trail % t rides the peak and exits on a
 *     t% retracement; the engine picks t that maximizes captured profit.
 *   - This is a small online "learn the optimal give-back" step, i.e. an AI
 *     decision about how much profit to let run vs how much to bank, aiming
 *     for maximum profit per trade.
 *
 * API mirrors AutoTrailEngine so the Auto Experiment engine can treat both
 * interchangeably: create(side, baseTp), update(candle), setBase(b),
 * trail() -> { pct, reasons, conf }, batch(candles, side, baseTp).
 *
 * Perf: update() is O(1)-amortized; the optimizer runs once every
 * OPT_EVERY bars over a fixed ~30-bar window x ~14 candidates (~12k simple
 * ops) so a live tick stays far under 10ms.
 */
(function () {
  'use strict';

  var FLOOR = 0.15;          /* never tighter than this (avoid noise exits) */
  var CAP = 2.5;             /* max trail % as a multiple of the base trail % */
  var WINDOW = 30;           /* bars used by the optimizer                    */
  var OPT_EVERY = 5;         /* re-learn cadence                             */
  var MIN_BARS = 15;         /* bars before a real decision is emitted       */
  var ATR = 14;              /* ATR period                                   */

  /* Candidate trail % grid the optimizer searches over. */
  var CANDIDATES = [0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.75, 1.0, 1.25, 1.5, 1.8, 2.0, 2.5];

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function r2(v) { return Math.round(v * 100) / 100; }

  /* Simulate ONE trailing-stop trade on the candle sub-array starting at
     index `start`. Returns the captured return in % (positive = profit). */
  function simTrade(arr, start, t, long) {
    var entry = arr[start].close;
    var peak = entry;
    var exitPrice = null;
    for (var i = start + 1; i < arr.length; i++) {
      var hi = arr[i].high, lo = arr[i].low;
      if (long) {
        if (hi > peak) peak = hi;
        var trail = peak * (1 - t / 100);
        if (trail > entry && lo <= trail) { exitPrice = trail; break; }
      } else {
        if (lo < peak) peak = lo;
        var trailS = peak * (1 + t / 100);
        if (trailS < entry && hi >= trailS) { exitPrice = trailS; break; }
      }
    }
    if (exitPrice == null) exitPrice = arr[arr.length - 1].close;
    return long ? (exitPrice - entry) / entry * 100 : (entry - exitPrice) / entry * 100;
  }

  function Engine(side, baseTp, collectReasons) {
    this.side = (side === 'short') ? -1 : 1;      /* +1 long, -1 short */
    this.baseTp = (baseTp != null && baseTp > 0) ? baseTp : 1;
    this.collect = collectReasons !== false;
    this.bars = 0;
    this.candles = [];
    this.atr = null;
    this.prevClose = null;
    this.ema9 = null; this.ema21 = null;
    this.learned = null;      /* last optimizer pick */
    this.learnedProfit = 0;   /* its simulated captured profit */
    this.sinceOpt = 0;
    this.atrRing = [];
    this.lastTrail = { pct: this.baseTp, reasons: [], conf: 0 };
  }

  Engine.prototype.setBase = function (b) {
    if (b != null && b > 0) this.baseTp = b;
  };

  Engine.prototype._updateAtr = function (hi, lo, close) {
    var pc = this.prevClose;
    var tr = Math.max(hi - lo, Math.abs(hi - pc), Math.abs(lo - pc));
    if (this.atr === null) this.atr = tr; else this.atr += (1 / ATR) * (tr - this.atr);
    this.atrRing.push(this.atr);
    if (this.atrRing.length > 60) this.atrRing.shift();
  };

  /* Run the optimizer: simulate a trailing stop for every candidate trail %
     on the recent window and keep the one that captures maximum profit. */
  Engine.prototype._learn = function () {
    var n = this.candles.length;
    if (n < MIN_BARS) return;
    var arr = this.candles.slice(-WINDOW);
    var long = this.side === 1;
    var best = null, bestProfit = -Infinity;
    for (var ci = 0; ci < CANDIDATES.length; ci++) {
      var t = CANDIDATES[ci];
      var sum = 0, cnt = 0;
      var end = arr.length - 5; /* leave room for the trade to develop */
      for (var s = 0; s < end; s++) {
        sum += simTrade(arr, s, t, long);
        cnt++;
      }
      var avg = cnt ? sum / cnt : 0;
      if (avg > bestProfit) { bestProfit = avg; best = t; }
    }
    if (best == null) return;
    this.learned = best;
    this.learnedProfit = bestProfit;
  };

  Engine.prototype.update = function (c) {
    this.bars++;
    var close = c.close, hi = c.high, lo = c.low, open = c.open;

    if (this.prevClose === null) {
      this.prevClose = close;
      this.ema9 = this.ema21 = close;
      this.lastTrail = { pct: this.baseTp, reasons: [], conf: 0 };
      this.candles.push(c);
      return;
    }
    this._updateAtr(hi, lo, close);
    var pc = this.prevClose;
    this.ema9 += (2 / 10) * (close - this.ema9);
    this.ema21 += (2 / 22) * (close - this.ema21);
    this.candles.push(c);
    if (this.candles.length > WINDOW + 5) this.candles.shift();
    this.prevClose = close;

    this.sinceOpt++;
    if (this.sinceOpt >= OPT_EVERY) {
      this.sinceOpt = 0;
      this._learn();
    }

    /* --- regime fusing --- */
    var reasons = [], collect = this.collect;
    var addR = function (v, label) { if (collect) reasons.push(label); return v; };
    var atrPct = (this.atr && close > 0) ? this.atr / close * 100 : 0;
    var trend = (close > 0) ? (this.ema9 - this.ema21) / close * 100 : 0;

    var base = (this.learned != null) ? this.learned : this.baseTp;

    /* Volatility regime: in high vol the move needs room (widen), in a quiet
       tape profits should be banked earlier (tighten). */
    var volFactor = 1;
    if (atrPct > 0 && this.atrRing.length >= 20) {
      var med = this.atrRing[Math.floor(this.atrRing.length / 2)];
      var ratio = this.atr / (med || 1e-9);
      if (ratio > 1.15) { volFactor = 1.25; addR(0, 'vol-widen'); }
      else if (ratio < 0.85) { volFactor = 0.85; addR(0, 'vol-tighten'); }
    }
    /* Trend strength: a clean aligned trend should be ridden (widen). */
    var trendFactor = 1;
    if (this.side === 1 && trend > 0.08) { trendFactor = 1.2; addR(0, 'trend-run'); }
    else if (this.side === -1 && trend < -0.08) { trendFactor = 1.2; addR(0, 'trend-run'); }
    else if (Math.abs(trend) < 0.04) { trendFactor = 0.9; addR(0, 'chop-tighten'); }

    var pct = base * volFactor * trendFactor;
    pct = clamp(pct, FLOOR, this.baseTp * CAP);
    pct = r2(pct);

    if (collect && this.learned != null) {
      var simTxt = this.learnedProfit >= 0
        ? '+' + this.learnedProfit.toFixed(2) + '%'
        : this.learnedProfit.toFixed(2) + '%';
      reasons.unshift('AI ' + this.learned + '% (sim ' + simTxt + ')');
    }
    this.lastTrail = {
      pct: this.bars < MIN_BARS ? this.baseTp : pct,
      reasons: (this.bars < MIN_BARS || !collect) ? [] : reasons.slice(0, 4),
      conf: this.bars < MIN_BARS ? 0 : clamp(0.4 + Math.min(Math.abs(this.learnedProfit), 5) * 0.08, 0, 1)
    };
  };

  Engine.prototype.trail = function () { return this.lastTrail; };

  Engine.prototype.batch = function (candles) {
    var n = candles.length, out = new Array(n), i;
    for (i = 0; i < n; i++) { this.update(candles[i]); out[i] = this.lastTrail.pct; }
    return out;
  };

  function create(side, baseTp) { return new Engine(side, baseTp); }

  function batch(candles, side, baseTp) {
    if (!candles || candles.length < 2) return null;
    var e = new Engine(side, baseTp, false);
    return e.batch(candles);
  }

  window.AiTrailEngine = { create: create, batch: batch, FLOOR: FLOOR };
})();
