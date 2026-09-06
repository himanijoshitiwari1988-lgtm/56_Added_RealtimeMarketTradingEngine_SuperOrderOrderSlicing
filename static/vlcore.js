/* VLCore — Volume-Liquidity Trend Core engine.
 *
 * A confluence, non-lagging trend engine built for the Dhan chart. It fuses the
 * research methods commonly used to separate REAL moves from stoploss hunts /
 * liquidity grabs into ONE causal state machine:
 *
 *   - Chart structure (fractal pivots, HH/HL, BOS/CHoCH breaks)
 *   - Liquidity-grab / sweep detection (wick beyond a swing, body refuses it)
 *   - Fake-breakout + fake-reversal rejection (bar confirmation + volume gates)
 *   - OI/volume confirmation (rising/falling volume, volume-pulse candles)
 *   - Candlestick patterns (engulfing, pin/rejection at structure)
 *   - Hull MA + linear-regression (low-lag anchors, LSMA is non-lagging)
 *   - ATR / volatility (dynamic noise band + offset distance)
 *   - Elliott-wave flavour (leg-length dampening avoids chasing over-extensions)
 *
 * Pure math, no DOM. Exposes window.VLCore so indicators.js can register it.
 */
(function (global) {
  'use strict';

  const V = {};

  function fill(n, val) { const a = new Array(n); a.fill(val); return a; }
  const clip = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

  function prefixSum(arr) {
    const n = arr.length, ps = new Array(n + 1), pjs = new Array(n + 1);
    ps[0] = 0; pjs[0] = 0;
    for (let i = 0; i < n; i++) {
      ps[i + 1] = ps[i] + arr[i];
      pjs[i + 1] = pjs[i] + i * arr[i];
    }
    return { ps: ps, pjs: pjs, n: n };
  }
  function range(ps, pjs, a, b) {
    return { s: ps[b + 1] - ps[a], js: pjs[b + 1] - pjs[a] };
  }

  function smaArr(vals, p) {
    const out = fill(vals.length, null);
    if (p <= 0) return out;
    let sum = 0;
    for (let i = 0; i < vals.length; i++) {
      sum += vals[i];
      if (i >= p) sum -= vals[i - p];
      if (i >= p - 1) out[i] = sum / p;
    }
    return out;
  }

  function emaArr(vals, p) {
    const out = fill(vals.length, null);
    const n = vals.length;
    if (n < p || p <= 0) return out;
    const k = 2 / (p + 1);
    let prev = 0;
    for (let i = 0; i < p; i++) prev += vals[i];
    prev /= p;
    out[p - 1] = prev;
    for (let i = p; i < n; i++) {
      prev = vals[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  /* Classic weighted moving average via prefix sums: oldest->newest weight 1..p. */
  function wmaArr(vals, p) {
    const out = fill(vals.length, null);
    const n = vals.length;
    if (p <= 0 || n < p) return out;
    const ps = prefixSum(vals);
    const denom = p * (p + 1) / 2;
    for (let i = p - 1; i < n; i++) {
      const a = i - p + 1;
      const r = range(ps.ps, ps.pjs, a, i);
      out[i] = (r.js - (a - 1) * r.s) / denom;
    }
    return out;
  }

  /* Hull Moving Average — low lag smoothing anchor. The final stage is a WMA of
     (2*WMA_half - WMA_full), which only exists once the full-period WMA exists.
     We compute it with a direct weighted sum over FULLY-valid windows only, so
     the leading nulls of the intermediate series can never leak in as zeros. */
  function hmaArr(vals, p) {
    const n = vals.length;
    const out = fill(n, null);
    if (p <= 0 || n < p) return out;
    const half = Math.max(1, Math.round(p / 2));
    const w1 = wmaArr(vals, half);
    const w2 = wmaArr(vals, p);
    const f = p - 1;                    /* first index with a full-period WMA */
    const sq = Math.max(1, Math.round(Math.sqrt(p)));
    const denom = sq * (sq + 1) / 2;
    for (let i = f + sq - 1; i < n; i++) {
      const a = i - sq + 1;
      let s = 0;
      for (let j = a; j <= i; j++) s += (j - a + 1) * (2 * w1[j] - w2[j]);
      out[i] = s / denom;
    }
    return out;
  }

  /* Linear-regression over last p bars: slope + endpoint value (LSMA). */
  function lsmaArr(vals, p) {
    const n = vals.length;
    const outV = fill(n, null), outS = fill(n, null);
    if (p < 2 || n < p) return { val: outV, slope: outS };
    const ps = prefixSum(vals);
    const mid = (p - 1) / 2;
    let varx = 0;
    for (let x = 0; x < p; x++) varx += (x - mid) * (x - mid);
    for (let i = p - 1; i < n; i++) {
      const a = i - p + 1;
      const r = range(ps.ps, ps.pjs, a, i);
      const mean = r.s / p;
      const meanJ = r.js / p;
      let cov = 0;
      for (let j = a; j <= i; j++) cov += ((j - a) - mid) * (vals[j] - mean);
      if (varx <= 0) { outV[i] = mean; outS[i] = 0; continue; }
      const slope = cov / varx;
      outS[i] = slope;
      outV[i] = mean + slope * (p - 1 - mid); /* endpoint of the fit */
    }
    return { val: outV, slope: outS };
  }

  function atrArr(c, p) {
    const n = c.length;
    const out = fill(n, null);
    if (n < p || p <= 0) return out;
    let s = 0;
    for (let i = 0; i < p && i < n; i++) {
      const h = c[i].high, l = c[i].low;
      const pc = i ? c[i - 1].close : l;
      s += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    }
    out[p - 1] = s / p;
    for (let i = p; i < n; i++) {
      const h = c[i].high, l = c[i].low;
      const pc = c[i - 1].close;
      const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
      out[i] = (out[i - 1] * (p - 1) + tr) / p;
    }
    return out;
  }

  /* Rolling min/max with a monotonic deque (causal). */
  function rollingExt(c, key, w, mode) {
    const n = c.length;
    const out = fill(n, null);
    const q = new Array(n);
    let head = 0, tail = 0;
    for (let i = 0; i < n; i++) {
      const v = c[i][key];
      while (tail > head && (mode > 0 ? c[q[tail - 1]][key] <= v : c[q[tail - 1]][key] >= v)) tail--;
      q[tail++] = i;
      while (q[head] <= i - w) head++;
      if (i >= w - 1) out[i] = c[q[head]][key];
    }
    return out;
  }

  /* Two-pass fractal pivots (window `w` bars each side). */
  function pivots(c, w) {
    const n = c.length;
    const isHi = new Uint8Array(n), isLo = new Uint8Array(n);
    for (let c2 = w; c2 < n - w; c2++) {
      let okHi = true, okLo = true;
      const base = c[c2];
      for (let k = -w; k <= w; k++) {
        if (!k) continue;
        const v = c[c2 + k];
        if (base.high <= v.high) okHi = false;
        if (base.low >= v.low) okLo = false;
        if (!okHi && !okLo) break;
      }
      if (okHi) isHi[c2] = 1;
      if (okLo) isLo[c2] = 1;
    }
    return { isHi: isHi, isLo: isLo };
  }

  V.engine = function (candles, o) {
    const n = candles.length;
    const res = { dir: fill(n, 0), conf: fill(n, 0), val: fill(n, null),
      sVal: fill(n, null), hVal: fill(n, null), atr: fill(n, null) };
    if (n < 10) return res;

    const L = Math.max(5, Math.round(o.length) || 21);
    const atrP = Math.max(2, Math.round(o.atrLength) || 14);
    const gap = Number(o.gap) >= 0 ? Number(o.gap) : 1.0;
    const useVol = o.useVolume !== false;
    const straight = o.straightLine !== false;
    const wick = Math.max(1, Math.round(o.wickLen) || 3);
    const confirm = Math.max(1, Math.round(o.confirm) || 2);
    const strong = Number(o.strongThr) >= 0.1 ? Number(o.strongThr) : 1.15;

    const hi = new Array(n), lo = new Array(n), cl = new Array(n);
    const op = new Array(n), hl = new Array(n), vol = new Array(n);
    for (let i = 0; i < n; i++) {
      hi[i] = candles[i].high; lo[i] = candles[i].low;
      cl[i] = candles[i].close; op[i] = candles[i].open;
      hl[i] = (hi[i] + lo[i]) / 2;
      vol[i] = candles[i].volume || 0;
    }

    const atr = atrArr(candles, atrP);
    const eFast = emaArr(cl, Math.max(2, Math.round(L * 0.4)));
    const eSlow = emaArr(cl, L);
    const hma = hmaArr(hl, L);
    const lr = lsmaArr(cl, L);

    const avgK = Math.max(2, Math.round(L / 3));
    const railW = Math.max(3, Math.round(L / 2));

    const rollHi = rollingExt(candles, 'high', railW, 1);
    const rollLo = rollingExt(candles, 'low', railW, -1);

    const vma = smaArr(vol, 20);
    const vr = fill(n, 1);
    for (let i = 0; i < n; i++) {
      if (vma[i] && vma[i] > 0 && vol[i] > 0) vr[i] = vol[i] / vma[i];
    }

    const atrSafe = fill(n, 0);
    let lastGoodAtr = 0;
    for (let i = 0; i < n; i++) {
      let a = atr[i];
      if (!a || !isFinite(a)) a = lastGoodAtr;
      if (a <= 0) a = Math.max(cl[i] * 0.001, 1e-9);
      atrSafe[i] = a;
      lastGoodAtr = a;
    }
    res.atr = atrSafe;

    /* --- per-bar confluence score (scale-free) --- */
    const sArr = fill(n, 0);
    for (let i = 1; i < n; i++) {
      const a = atrSafe[i];
      let fVel = 0, fPos = 0, fEma = 0;
      if (lr.slope[i] != null) fVel = clip(lr.slope[i] * L / a, -2, 2) / 2;
      if (hma[i] != null) fPos = clip((cl[i] - hma[i]) / (a * 1.2), -2, 2) / 2;
      if (eFast[i] != null && eSlow[i] != null) fEma = clip((eFast[i] - eSlow[i]) / (a * 0.9), -2, 2) / 2;

      let fPat = 0;
      const c = candles[i], pc = candles[i - 1];
      const rng = Math.max(c.high - c.low, 1e-9);
      if (pc) {
        const upWick = c.high - Math.max(c.open, c.close);
        const dnWick = Math.min(c.open, c.close) - c.low;
        if (upWick / rng > 0.6 && dnWick < rng * 0.25 && c.close < c.open) fPat -= 0.25;
        if (dnWick / rng > 0.6 && upWick < rng * 0.25 && c.close > c.open) fPat += 0.25;
        if (c.close > c.open && pc.close < pc.open && c.low <= pc.low &&
          c.close >= (pc.open + pc.close) / 2) fPat += 0.4;
        if (c.close < c.open && pc.close > pc.open && c.high >= pc.high &&
          c.close <= (pc.open + pc.close) / 2) fPat -= 0.4;
      }
      let volK = 1;
      if (useVol) {
        const r = vr[i];
        if (r >= 1.1) volK = Math.min(1.6, 0.8 + (r - 1) * 0.6);
        else if (r < 0.75) volK = 0.55;
      }
      const s = 0.42 * fVel + 0.30 * fPos + 0.27 * fEma + clip(fPat, -1, 1) * 0.5 * volK;
      sArr[i] = clip(s, -2, 2);
    }

    const pv = pivots(candles, wick);
    const pkHi = [], pkLo = [];
    for (let i = 0; i < n; i++) {
      if (pv.isHi[i]) pkHi.push(i);
      if (pv.isLo[i]) pkLo.push(i);
    }
    function firstGt(arr, idx) {
      let l = 0, r = arr.length - 1, ans = -1;
      while (l <= r) { const m = (l + r) >> 1; if (arr[m] >= idx) { ans = m; r = m - 1; } else l = m + 1; }
      return ans;
    }

    /* ---------------- state machine ---------------- */
    let dir = 0;
    let stLow = null, stHigh = null;      /* structural rails (for output only) */
    let pendingUp = 0, pendingDown = 0;   /* opposite-break confirmation bars */
    let grabUntil = -1;
    let prevCloseRef = -1;
    let processedLo = -1, processedHi = -1;
    /* drawn-line continuity: when the regime flips the line must GLIDE across
       the pivot (touch the structure) instead of teleporting to the opposite
       side of the market, which read as the line "running away from candles". */
    let prevOutDir = 0, glideRem = 0;
    let drawnVal = null;
    /* STRAIGHT mode drawing state (whole-leg LS chords).
       The line NEVER depends on the shape of the current candle: it advances by a
       FROZEN per-bar slope `mS` (a straight chord) while the market makes an
       impulse, and it FREEZES (flat) during liquidity-grab / pullback phases. The
       slope/level come from a least-squares fit over the WHOLE current leg, but are
       only re-read at "refresh" moments (regime flip, end of a grab-freeze, or when
       the frozen chord starts to deviate from that fit). Because the fit spans the
       whole leg, single big candles move it very little, so the line neither bends
       with candle shape nor jumps. */
    let dDir = 0;            /* current straight regime sign (±1) or 0 while neutral */
    let yv = null;           /* running straight value */
    let mS = 0;              /* frozen per-bar slope, signed (bull>0, bear<0) */
    let hold = false;        /* true while frozen flat (grab / pullback / overrun) */
    let holdWhy = '';        /* 'g' threat-grab freeze, 'o' price crossed the line */
    let lastRef = 0;         /* bar index of the last slope/level refresh */
    let needRef = false;     /* refresh pending (e.g. right after a freeze ends) */
    let gN = 0, gSx = 0, gSy = 0, gSxx = 0, gSxy = 0;   /* whole-leg LS accumulators */
    function feedSeg(i, y) {
      gSx += i; gSy += y; gSxx += i * i; gSxy += i * y; gN++;
    }
    function segSlope() {
      if (gN < 2) return 0;
      const den = gN * gSxx - gSx * gSx;
      if (Math.abs(den) < 1e-12) return 0;
      return (gN * gSxy - gSx * gSy) / den;
    }
    function segEnd(i) {
      if (gN < 1) return null;
      const sl = segSlope();
      return (gSy - sl * gSx) / gN + sl * i;
    }
    function resetRun() {
      dDir = 0; mS = 0; hold = false; holdWhy = ''; needRef = false;
      gN = 0; gSx = 0; gSy = 0; gSxx = 0; gSxy = 0;
    }

    const accStore = new Array(avgK).fill(0);

    function nextPivotLo(i) { const k = firstGt(pkLo, processedLo + 1); return (k >= 0 && pkLo[k] <= i - wick) ? pkLo[k] : -1; }
    function nextPivotHi(i) { const k = firstGt(pkHi, processedHi + 1); return (k >= 0 && pkHi[k] <= i - wick) ? pkHi[k] : -1; }

    function enterBull(i, a) {
      dir = 1;
      stLow = Math.min(rollLo[i] != null ? rollLo[i] : cl[i], cl[i]);
      stHigh = null;
      pendingUp = 0; pendingDown = 0;
      grabUntil = i + Math.max(wick, 2);
    }
    function enterBear(i, a) {
      dir = -1;
      stHigh = Math.max(rollHi[i] != null ? rollHi[i] : cl[i], cl[i]);
      stLow = null;
      pendingUp = 0; pendingDown = 0;
      grabUntil = i + Math.max(wick, 2);
    }

    for (let i = Math.max(2, railW); i < n; i++) {
      const c = candles[i];
      const a = atrSafe[i];
      const idx = i % avgK;
      accStore[idx] = sArr[i];
      let acc = 0;
      for (let t = 0; t < avgK; t++) acc += accStore[t];
      acc /= avgK;

      let threat = 0;   /* pullback / grab / overrun against the trend (line goes flat) */

      /* --- consume matured fractal pivots: raise/refresh structural rails --- */
      for (;;) {
        const plo = nextPivotLo(i);
        if (plo < 0) break;
        processedLo = plo;
        const lp = candles[plo].low;
        if (dir === 1) {
          if (stLow == null || lp >= stLow) stLow = lp;
        }
      }
      for (;;) {
        const phi = nextPivotHi(i);
        if (phi < 0) break;
        processedHi = phi;
        const hp = candles[phi].high;
        if (dir === -1) {
          if (stHigh == null || hp <= stHigh) stHigh = hp;
        }
      }

      const rlPrev = rollLo[i - 1] != null ? rollLo[i - 1] : (rollLo[i] != null ? rollLo[i] : c.low);
      const rhPrev = rollHi[i - 1] != null ? rollHi[i - 1] : (rollHi[i] != null ? rollHi[i] : c.high);

      /* Bull regime: local support = highest(stLow rail, recent close lows).
         A close BELOW that local support is a structure break (mini CHoCH). */
      if (dir === 1) {
        const local = Math.max(stLow != null ? stLow : -Infinity, rlPrev);
        const isGrab = c.low < local && c.close > local;   /* sweep refused */
        if (isGrab) grabUntil = i + Math.max(wick, 2);
        const under = c.close <= local;
        threat = (isGrab || under) ? 1 : 0;
        if (i > grabUntil && !isGrab) {
          if (under) {
            pendingDown++;
            const crash = c.close < c.open && acc <= -strong &&
              prevCloseRef >= 0 && c.close <= prevCloseRef - a * 0.6;
            if (pendingDown >= confirm || crash) enterBear(i, a);
          } else pendingDown = 0;
        }
        res.conf[i] = Math.min(1, Math.abs(acc));
      } else if (dir === -1) {
        const local = Math.min(stHigh != null ? stHigh : Infinity, rhPrev);
        const isGrab = c.high > local && c.close < local;
        if (isGrab) grabUntil = i + Math.max(wick, 2);
        const over = c.close >= local;
        threat = (isGrab || over) ? 1 : 0;
        if (i > grabUntil && !isGrab) {
          if (over) {
            pendingUp++;
            const crash = c.close > c.open && acc >= strong &&
              prevCloseRef >= 0 && c.close >= prevCloseRef + a * 0.6;
            if (pendingUp >= confirm || crash) enterBull(i, a);
          } else pendingUp = 0;
        }
        res.conf[i] = Math.min(1, Math.abs(acc));
      } else {
        /* neutral: commit only when momentum is decisive or first structure
           breaks — otherwise stay flat (gray) and avoid whipsaw. */
        if (acc >= 0.18) {
          if (c.close > rhPrev || acc >= strong) { enterBull(i, a); res.conf[i] = Math.abs(acc); }
        } else if (acc <= -0.18) {
          if (c.close < rlPrev || acc <= -strong) { enterBear(i, a); res.conf[i] = Math.abs(acc); }
        }
      }

      /* EW-flavour dampening on over-extended legs (avoid chasing tops/bottoms) */
      let legDamp = 1;
      if (dir === 1 && rollHi[i] != null) {
        const ext = Math.max(0, (rollHi[i] - cl[i]) / a);
        if (ext > 6) legDamp = Math.max(0.45, 1 - (ext - 6) * 0.05);
      } else if (dir === -1 && rollLo[i] != null) {
        const ext = Math.max(0, (cl[i] - rollLo[i]) / a);
        if (ext > 6) legDamp = Math.max(0.45, 1 - (ext - 6) * 0.05);
      }

      res.dir[i] = dir;
      res.conf[i] = Math.max(res.conf[i] || 0, Math.abs(acc)) * legDamp;

      /* ---- drawn line value ----
         STRAIGHT mode (default): the line advances by a FROZEN per-bar slope `mS`
         (a straight chord) while the market makes an impulse, and it FREEZES FLAT
         during liquidity-grab / pullback / overrun phases. The slope/level are
         taken from a least-squares fit over the WHOLE current leg but are only
         re-read at refresh moments (regime flip, end of a grab-freeze, or when the
         frozen chord deviates from that fit). Because the fit spans the whole leg,
         single big candles move it very little, so the line neither bends with
         candle shape nor jumps.
         SMOOTH mode (checkbox off): de-lagged Hull (EMA-like curve). */
      let target = null, anchor = null;
      if (straight) {
        if (dir !== 0) {
          if (dir !== dDir) {
            /* regime start / flip: fresh chord anchored on the structure pivot
               that started the move (bottom low for bull, top high for bear). */
            resetRun();
            dDir = dir;
            lastRef = i;
            if (dir === 1) {
              let j = i, jv = c.low;
              for (let t = Math.max(railW, i - railW); t <= i; t++) {
                if (candles[t].low <= jv) { jv = candles[t].low; j = t; }
              }
              yv = jv;
              const dx = i - j;
              mS = dx > 0 ? Math.max(0, (cl[i] - jv) / dx) : 0;
            } else {
              let j = i, jv = c.high;
              for (let t = Math.max(railW, i - railW); t <= i; t++) {
                if (candles[t].high >= jv) { jv = candles[t].high; j = t; }
              }
              yv = jv;
              const dx = i - j;
              mS = dx > 0 ? Math.min(0, (cl[i] - jv) / dx) : 0;
            }
            feedSeg(i, cl[i]);
            target = yv;
          } else {
            /* same regime: feed the close into the whole-leg LS fit */
            feedSeg(i, cl[i]);
            if (dir === 1) {
              if (hold) {
                if (holdWhy === 'g') { if (threat === 0) { hold = false; needRef = true; } }
                else if (c.close >= yv) { hold = false; needRef = true; }
              } else if (threat) {
                hold = true; holdWhy = 'g';
              }
              if (!hold) {
                if (yv == null || !isFinite(yv)) yv = cl[i];
                if (gN >= 4) {
                  const se = segEnd(i), sl = segSlope();
                  const driftSlope = Math.abs(mS - sl) * Math.max(1, i - lastRef);
                  const driftLevel = Math.abs(yv - se);
                  if (needRef || driftSlope > a * 0.35 || driftLevel > a * 1.5) {
                    mS = Math.max(0, sl);
                    if (se != null && isFinite(se)) {
                      let d = se - yv;
                      d = Math.max(-a * 0.5, Math.min(a * 0.5, d));
                      yv = yv + d;
                    }
                    lastRef = i; needRef = false;
                  }
                }
                if (c.close >= yv) yv = yv + mS;
                else { hold = true; holdWhy = 'o'; }
              }
            } else {
              if (hold) {
                if (holdWhy === 'g') { if (threat === 0) { hold = false; needRef = true; } }
                else if (c.close <= yv) { hold = false; needRef = true; }
              } else if (threat) {
                hold = true; holdWhy = 'g';
              }
              if (!hold) {
                if (yv == null || !isFinite(yv)) yv = cl[i];
                if (gN >= 4) {
                  const se = segEnd(i), sl = segSlope();
                  const driftSlope = Math.abs(mS - sl) * Math.max(1, i - lastRef);
                  const driftLevel = Math.abs(yv - se);
                  if (needRef || driftSlope > a * 0.35 || driftLevel > a * 1.5) {
                    mS = Math.min(0, sl);
                    if (se != null && isFinite(se)) {
                      let d = se - yv;
                      d = Math.max(-a * 0.5, Math.min(a * 0.5, d));
                      yv = yv + d;
                    }
                    lastRef = i; needRef = false;
                  }
                }
                if (c.close <= yv) yv = yv + mS;
                else { hold = true; holdWhy = 'o'; }
              }
            }
            target = yv;
          }
        } else {
          /* neutral: no active bull/bear leg. Draw a clearly visible FLAT gray
             level instead of chasing the per-bar close — chasing the close puts
             the line inside the candle bodies (same jagged path), where it reads
             as "no line at all". So we freeze on a structural reference: the last
             leg level if we have one, otherwise the Hull mid of the current range
             (pure sideways / liquidity-sweep zone that never committed). The level
             only eases forward when the neutral range itself migrates away by
             more than the ATR band, so grab/sweep phases show one steady flat
             line rather than disappearing. */
          if (dDir !== 0) resetRun();
          let ref = (yv != null && isFinite(yv)) ? yv : null;
          if (ref == null) {
            if (hma[i] != null && isFinite(hma[i])) ref = hma[i];
            else if (rollHi[i] != null && rollLo[i] != null) ref = (rollHi[i] + rollLo[i]) / 2;
            else ref = cl[i];
            yv = ref;
            lastRef = i;
          } else {
            const a = atrSafe[i];
            if (hma[i] != null && isFinite(hma[i]) &&
              (cl[i] < yv - a * 1.5 || cl[i] > yv + a * 1.5)) {
              let d = hma[i] - yv;
              d = Math.max(-a * 0.4, Math.min(a * 0.4, d));
              yv += d;
            }
          }
          target = yv;
        }
      } else {
        const lrVal = lr.val[i], lrSl = (lr.slope[i] != null && isFinite(lr.slope[i])) ? lr.slope[i] : 0;
        if (hma[i] != null && isFinite(hma[i])) anchor = hma[i] + lrSl;
        else anchor = lrVal;
        if (anchor == null || !isFinite(anchor)) anchor = cl[i];
        target = anchor;
      }
      if (target == null || !isFinite(target)) target = cl[i];
      res.sVal[i] = target; res.hVal[i] = (anchor != null) ? anchor : target;

      /* Glide the drawn value toward the target. On a regime change the line
         eases across the candles over a few bars (a visible "touch" at the
         pivot); in steady state it tracks the target directly. */
      if (dir !== prevOutDir) { glideRem = 4; prevOutDir = dir; }
      if (drawnVal == null || !isFinite(drawnVal)) { drawnVal = target; glideRem = 0; }
      else if (glideRem > 0) {
        drawnVal = drawnVal + (target - drawnVal) * 0.5;
        glideRem--;
      } else drawnVal = target;
      res.val[i] = drawnVal;
      prevCloseRef = c.close;
    }

    return res;
  };

  /* Convert engine output into ONE lightweight-charts line series. Every data
     point carries its own color (green under the candles during a bull leg, red
     above them during a bear leg, gray when flat), so the indicator is a single
     continuous line that only changes colour at regime turns. */
  V.series = function (candles, o) {
    const r = V.engine(candles, o);
    const n = candles.length;
    const upColor = o.upColor || '#26a69a';
    const downColor = o.downColor || '#ef5350';
    const flatColor = o.flatColor || '#6b6b88';
    const colFor = (d) => (d === 1 ? upColor : d === -1 ? downColor : flatColor);
    const data = [];
    for (let i = 0; i < n; i++) {
      const v = r.val[i];
      if (v == null || !isFinite(v)) continue;
      data.push({ time: candles[i].time, value: v, color: colFor(r.dir[i]) });
    }
    return {
      res: r,
      out: [
        { type: 'line', color: upColor, lineWidth: (o.lineWidth || 2), data: data }
      ]
    };
  };

  global.VLCore = V;
})(window);
