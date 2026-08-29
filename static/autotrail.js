/* Dhan Algo - Auto Trail Engine (HFT-class incremental trail%)
 *
 * Decides the "Trail %" a position gives back before banking profit, from a
 * fused per-bar read of market conditions:
 *   - trend regime          (EMA9/EMA21 gap + EMA slope + MACD histogram, ATR-normalized)
 *   - chart patterns        (engulfing, hammer / shooting-star, doji at extremes)
 *   - indicator extremes    (RSI overbought / oversold + rollovers)
 *   - RSI swing divergence  (price HH/LL vs RSI LL/HH at confirmed pivots)
 *   - Bollinger %B          (extension beyond the bands + squeeze)
 *   - breakouts             (clean range expansion = let the move run)
 *   - fake breakouts        (range breach that closes back inside = trap)
 *   - rejection wicks       (price / volatility rejection at the extremes)
 *   - impulse continuation  (strong trend with shallow retrace - Elliott-like)
 *   - exhaustion            (large multi-bar move that stalls)
 *
 * The engine is INCREMENTAL: every update() is O(1)-amortized (a fixed 20-bar
 * window scan + ~40 float ops), so a live tick costs a few microseconds, far
 * under 10ms even with dozens of open positions. batch() runs the same loop
 * over a full series for backtests and is O(n).
 *
 * Output: a retracement percent. High reversal conviction tightens the trail
 * so profits are banked before the turn; a clean trending move widens it so
 * the move is given room to run. Every decision stays auditable via reason
 * tags, which the Auto Experiment UI renders live.
 */
(function () {
  'use strict';

  var FLOOR = 0.15;       /* absolute floor for the trail % (never tighter)  */
  var CAP = 1.8;          /* max trail % as a multiple of the base trail %   */
  var W = 3;              /* swing-pivot half window                         */
  var RB = 20;            /* breakout / bollinger lookback                   */
  var WARM = 25;          /* bars before the engine emits a real trail       */

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function r2(v) { return Math.round(v * 100) / 100; }

  /* Ring buffer of the last n values with O(1) push and O(n) scan (n<=20). */
  function Ring(n) {
    this.n = n; this.buf = new Float64Array(n); this.len = 0; this.head = 0;
  }
  Ring.prototype.push = function (v) {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.n;
    if (this.len < this.n) this.len++;
  };
  Ring.prototype.at = function (i) { /* 0 = newest */
    return this.buf[(this.head - i - 1 + this.n) % this.n];
  };
  Ring.prototype.max = function () {
    var m = -Infinity, b = this.buf, h = this.head, n = this.n, i;
    for (i = 0; i < this.len; i++) { var v = b[(h - i - 1 + n) % n]; if (v > m) m = v; }
    return m;
  };
  Ring.prototype.min = function () {
    var m = Infinity, b = this.buf, h = this.head, n = this.n, i;
    for (i = 0; i < this.len; i++) { var v = b[(h - i - 1 + n) % n]; if (v < m) m = v; }
    return m;
  };
  Ring.prototype.mean = function () {
    var s = 0, b = this.buf, h = this.head, n = this.n, i;
    for (i = 0; i < this.len; i++) s += b[(h - i - 1 + n) % n];
    return this.len ? s / this.len : 0;
  };
  Ring.prototype.dev = function () {
    var m = this.mean(), s = 0, b = this.buf, h = this.head, n = this.n, i;
    for (i = 0; i < this.len; i++) { var d = b[(h - i - 1 + n) % n] - m; s += d * d; }
    return this.len ? Math.sqrt(s / this.len) : 0;
  };

  function Engine(side, baseTp, collectReasons) {
    this.side = (side === 'short') ? -1 : 1;      /* +1 long, -1 short */
    this.baseTp = (baseTp != null && baseTp > 0) ? baseTp : 1;
    this.collect = collectReasons !== false;      /* live path wants reason tags */
    this.bars = 0;
    this.prevClose = null;
    this.prevOpen = null;
    this.ema9 = null; this.ema21 = null;
    this.ema12 = null; this.ema26 = null;
    this.macd = null; this.macdSig = null;
    this.avgGain = 0; this.avgLoss = 0;
    this.rsi = 50; this.rsiPrev = 50;
    this.atr = null;
    this.c20 = new Ring(RB); this.h20 = new Ring(RB); this.l20 = new Ring(RB);
    this.c10 = new Ring(10);
    this.pBuf = [];                       /* {o,h,l,c,r} last 2W+1 bars */
    this.pivH1 = null; this.pivH2 = null; /* last two pivot highs {p,r} */
    this.pivL1 = null; this.pivL2 = null; /* last two pivot lows {p,r}  */
    this.divBear = 0;                     /* bearish divergence countdown */
    this.divBull = 0;                     /* bullish divergence countdown */
    this.lastTrail = { pct: this.baseTp, reasons: [], conf: 0 };
  }

  Engine.prototype.setBase = function (b) {
    if (b != null && b > 0) this.baseTp = b;
  };

  Engine.prototype.update = function (c) {
    var s = this.side;
    this.bars++;
    var close = c.close, hi = c.high, lo = c.low, open = c.open;

    if (this.prevClose === null) {
      this.prevClose = close; this.prevOpen = open;
      this.ema9 = this.ema21 = this.ema12 = this.ema26 = close;
      this.lastTrail = { pct: this.baseTp, reasons: [], conf: 0 };
      return;
    }

    /* --- indicators, all O(1) --- */
    var pc = this.prevClose;
    var k9 = 2 / 10, k21 = 2 / 22, k12 = 2 / 13, k26 = 2 / 27;
    this.ema9 += k9 * (close - this.ema9);
    this.ema21 += k21 * (close - this.ema21);
    this.ema12 += k12 * (close - this.ema12);
    this.ema26 += k26 * (close - this.ema26);
    var macdLine = this.ema12 - this.ema26;
    if (this.macd === null) this.macd = macdLine;
    this.macdSig = (this.macdSig === null) ? macdLine : (this.macdSig + 0.2 * (macdLine - this.macdSig));
    this.macd = macdLine;

    var delta = close - pc;
    var gain = delta > 0 ? delta : 0, loss = delta < 0 ? -delta : 0;
    var a = 1 / 14;
    this.avgGain += a * (gain - this.avgGain);
    this.avgLoss += a * (loss - this.avgLoss);
    this.rsiPrev = this.rsi;
    this.rsi = this.avgLoss > 0 ? 100 - 100 / (1 + this.avgGain / this.avgLoss) : 100;

    var tr = Math.max(hi - lo, Math.abs(hi - pc), Math.abs(lo - pc));
    if (this.atr === null) this.atr = tr; else this.atr += a * (tr - this.atr);
    var atr = this.atr > 0 ? this.atr : 1e-9;

    /* Range / Bollinger references over the prior 20 bars. */
    var refH = this.h20.len >= 5 ? this.h20.max() : null;
    var refL = this.l20.len >= 5 ? this.l20.min() : null;

    this.c20.push(close); this.h20.push(hi); this.l20.push(lo); this.c10.push(close);

    var mid = this.c20.mean(), dev = this.c20.dev();
    var bPct = (4 * dev) > 0 ? (close - (mid - 2 * dev)) / (4 * dev) : 0.5;

    /* Swing pivots (confirmed W bars behind) for RSI divergence. */
    this.pBuf.push({ o: open, h: hi, l: lo, c: close, r: this.rsi });
    if (this.pBuf.length > 2 * W) {
      var cand = this.pBuf.shift();
      var isH = true, isL = true, i;
      for (i = 0; i < this.pBuf.length; i++) {
        var o2 = this.pBuf[i];
        if (o2.h >= cand.h) isH = false;
        if (o2.l <= cand.l) isL = false;
      }
      if (isH) {
        this.pivH2 = this.pivH1; this.pivH1 = { p: cand.h, r: cand.r };
        if (this.pivH2 && this.pivH1.p > this.pivH2.p && this.pivH1.r < this.pivH2.r) this.divBear = 7;
      }
      if (isL) {
        this.pivL2 = this.pivL1; this.pivL1 = { p: cand.l, r: cand.r };
        if (this.pivL2 && this.pivL1.p < this.pivL2.p && this.pivL1.r > this.pivL2.r) this.divBull = 7;
      }
    }
    if (this.divBear > 0) this.divBear--;
    if (this.divBull > 0) this.divBull--;

    this.prevClose = close;
    this.prevOpen = open;

    /* --- score the current bar --- */
    var fear = 0, wide = 0, reasons = [], collect = this.collect;
    var addR = function (v, label) { if (collect) reasons.push(label); return v; };

    var trendGap = s * (this.ema9 - this.ema21) / atr;
    var slope = s * (this.ema9 - pc) / atr;
    var macdSlope = (this.macd != null && this.macdSig != null) ? s * (this.macd - this.macdSig) / atr : 0;

    /* 1. Trend regime */
    if (trendGap > 0.4) { wide = Math.max(wide, 0.5); if (slope > 0.2) wide = Math.max(wide, 0.8); }
    if (trendGap < -0.4) fear += 0.3;
    if (macdSlope > 0.25) wide = Math.max(wide, 0.4);

    /* 2. RSI extremes / rollover / divergence */
    if (s === 1) {
      if (this.rsi > 70 && this.rsi < this.rsiPrev) fear += addR(0.35, 'RSI OB rollover');
      else if (this.rsi > 74) fear += addR(0.2, 'RSI overbought');
      if (this.rsi < 30) fear += 0.15;
      if (this.divBear > 0) fear += addR(0.6, 'RSI divergence');
    } else {
      if (this.rsi < 30 && this.rsi > this.rsiPrev) fear += addR(0.35, 'RSI OS rollover');
      else if (this.rsi < 26) fear += addR(0.2, 'RSI oversold');
      if (this.rsi > 70) fear += 0.15;
      if (this.divBull > 0) fear += addR(0.6, 'RSI divergence');
    }

    /* 3. Bollinger %B extension + squeeze */
    if (s === 1) {
      if (bPct > 1.05) fear += addR(0.45, 'BB% extended');
      else if (bPct > 0.9) fear += 0.2;
      if (bPct < 0.1) fear += 0.1;
    } else {
      if (bPct < -0.05) fear += addR(0.45, 'BB% extended');
      else if (bPct < 0.1) fear += 0.2;
      if (bPct > 0.9) fear += 0.1;
    }
    if (dev > 0 && mid > 0 && (dev / mid) < 0.004 && this.c20.len === RB) fear += 0.15;

    /* 4. Genuine breakout vs fake breakout */
    if (refH != null) {
      if (s === 1) {
        if (close > refH) wide = Math.max(wide, 0.6);
        else if (pc > refH && close <= refH) fear += addR(0.55, 'Fake breakout');
      } else {
        if (close < refL) wide = Math.max(wide, 0.6);
        else if (pc < refL && close >= refL) fear += addR(0.55, 'Fake breakout');
      }
    }

    /* 5. Rejection wicks / weak close */
    var rng = hi - lo;
    if (rng > 0) {
      var rAt = rng / atr;
      if (s === 1) {
        if ((hi - close) / rng > 0.62 && rAt > 0.7) fear += addR(0.4, 'Upper rejection');
        if ((close - lo) / rng > 0.8) wide = Math.max(wide, 0.2);
        if ((close - lo) / rng < 0.25 && rAt < 0.8) fear += 0.2;
      } else {
        if ((close - lo) / rng > 0.62 && rAt > 0.7) fear += addR(0.4, 'Lower rejection');
        if ((hi - close) / rng > 0.8) wide = Math.max(wide, 0.2);
        if ((hi - close) / rng < 0.25 && rAt < 0.8) fear += 0.2;
      }
    }

    /* 6. Candlestick patterns on the last bar */
    var bodyAbs = Math.abs(close - open);
    var po = this.prevOpen;
    var isDoji = rng > 0 && bodyAbs / rng < 0.1;
    var bullEng = close > open && po != null && pc < po && open <= pc && close > po;
    var bearEng = close < open && po != null && pc > po && open >= pc && close < po;
    var hammer = rng > 0 && (Math.min(close, open) - lo) > 2 * Math.max(bodyAbs, 1e-9) && (hi - Math.max(close, open)) < 0.5 * (Math.min(close, open) - lo);
    var shooting = rng > 0 && (hi - Math.max(close, open)) > 2 * Math.max(bodyAbs, 1e-9) && (Math.min(close, open) - lo) < 0.5 * (hi - Math.max(close, open));

    if (s === 1) {
      if (bearEng) fear += addR(0.35, 'Bearish engulf');
      if (shooting) fear += addR(0.35, 'Shooting star');
      if (isDoji && (bPct > 0.9 || bPct < 0.1)) fear += addR(0.25, 'Doji');
      if (bullEng) wide = Math.max(wide, 0.2);
      if (hammer) wide = Math.max(wide, 0.15);
    } else {
      if (bullEng) fear += addR(0.35, 'Bullish engulf');
      if (hammer) fear += addR(0.35, 'Hammer');
      if (isDoji && (bPct > 0.9 || bPct < 0.1)) fear += addR(0.25, 'Doji');
      if (bearEng) wide = Math.max(wide, 0.2);
      if (shooting) wide = Math.max(wide, 0.15);
    }

    /* 7. Impulse continuation (Elliott-like) vs exhaustion */
    if (this.c10.len >= 6) {
      var mv5 = close - this.c10.at(4);
      var rng10 = this.c10.max() - this.c10.min();
      var retr10 = rng10 > 0 ? (this.c10.max() - this.c10.at(0)) / rng10 : 1;
      var retr10Short = rng10 > 0 ? (this.c10.at(0) - this.c10.min()) / rng10 : 1;
      if (s === 1 && trendGap > 0.3 && mv5 > 0 && retr10 < 0.35) wide = Math.max(wide, 0.35);
      if (s === -1 && trendGap > 0.3 && mv5 < 0 && retr10Short < 0.35) wide = Math.max(wide, 0.35);
      if (Math.abs(mv5) > 2.2 * atr && rng < 0.5 * atr) fear += addR(0.3, 'Exhaustion');
    }

    /* --- combine --- */
    fear = clamp(fear, 0, 1);
    wide = clamp(wide, 0, 1);
    var trail = this.baseTp * (1 - 0.62 * fear) * (1 + 0.45 * wide);
    trail = clamp(trail, FLOOR, this.baseTp * CAP);
    trail = r2(trail);
    this.lastTrail = {
      pct: this.bars < WARM ? this.baseTp : trail,
      reasons: (this.bars < WARM || !collect) ? [] : reasons.slice(0, 4),
      conf: this.bars < WARM ? 0 : clamp(0.5 + (wide - fear) * 0.3, 0, 1)
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

  window.AutoTrailEngine = { create: create, batch: batch, FLOOR: FLOOR };
})();
