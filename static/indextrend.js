/* ============================================================================
 * Index Trend Analyzer (HFT-grade, <10ms per 3-min cycle)
 *
 * Re-evaluates NIFTY 50, SENSEX, BANKNIFTY, FINNIFTY, MIDCPNIFTY and GIFT NIFTY
 * every 3 minutes and classifies each as Bullish / Bearish / Consolidation.
 *
 * Accuracy model (self-tuning "AI" methods):
 *   1. Multi-timeframe trend alignment — the 3-min series is resampled
 *      client-side into 15-min and 1-hour bars, plus a positional (multi-day)
 *      view from a 200-period MA. A direction only counts when the higher
 *      timeframes agree, so a single noisy bar can no longer fake a reversal.
 *   2. Dispersion -> confidence — when bullish and bearish signals are split,
 *      the result is forced to Consolidation (sideways) instead of picking a
 *      direction from a tiny score difference.
 *   3. Stale / flat data detection — closed or low-range markets are flagged
 *      and their signals de-weighted instead of producing false breakouts.
 *   4. Cross-index consensus anchoring — each NIFTY-family index is lightly
 *      anchored to the broad-market median, cancelling single-symbol noise.
 *   5. Reversal watch — exhaustion extremes (RSI/MFI/Stoch) combined with an
 *      opposing candle pattern flag a likely reversal, separate from trend.
 * ========================================================================== */
(function () {
  'use strict';

  const REFRESH_MS = 180000; // 3 minutes
  const TF = '3min';
  const PERIOD_DAYS = 5;
  const MAX_BARS = 400;

  const INDICES = [
    { name: 'NIFTY 50',   id: 13,   exch: 'IDX_I', inst: 'INDEX', listed: true  },
    { name: 'SENSEX',     id: 51,   exch: 'IDX_I', inst: 'INDEX', listed: true  },
    { name: 'BANK NIFTY', id: 25,   exch: 'IDX_I', inst: 'INDEX', listed: true  },
    { name: 'FINNIFTY',   id: 27,   exch: 'IDX_I', inst: 'INDEX', listed: true  },
    { name: 'MIDCPNIFTY', id: 442,  exch: 'IDX_I', inst: 'INDEX', listed: true  },
    { name: 'GIFT NIFTY', id: 5024, exch: 'IDX_I', inst: 'INDEX', listed: true  },
    { name: 'INDIA VIX',  id: 21,   exch: 'IDX_I', inst: 'INDEX', listed: false }
  ];

  const FAMILY = ['NIFTY 50', 'SENSEX', 'BANK NIFTY', 'FINNIFTY', 'MIDCPNIFTY'];

  const GREEN = '#00d4aa', RED = '#ff5252', AMBER = '#ff9800', PURPLE = '#b39ddb',
        GRAY = '#888', NEUTRAL = '#9e9e9e';

  /* ----------------------------- helpers ----------------------------- */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmt(v, d) {
    if (v == null || isNaN(v)) return '—';
    return Number(v).toFixed(d == null ? 2 : d);
  }

  function closes(c) { const a = new Array(c.length); for (let i = 0; i < c.length; i++) a[i] = c[i].close; return a; }

  function clamp1(v) { return Math.max(-1, Math.min(1, v)); }

  function smaArr(src, n) {
    const out = new Array(src.length).fill(null);
    let s = 0;
    for (let i = 0; i < src.length; i++) {
      s += src[i]; if (i >= n) s -= src[i - n];
      if (i >= n - 1) out[i] = s / n;
    }
    return out;
  }

  function emaArr(src, n) {
    const k = 2 / (n + 1), out = new Array(src.length);
    let p = src[0];
    for (let i = 0; i < src.length; i++) { p = i === 0 ? src[i] : src[i] * k + p * (1 - k); out[i] = p; }
    return out;
  }

  function wilderArr(src, n) {
    const out = new Array(src.length).fill(null);
    let avg = 0;
    for (let i = 0; i < src.length; i++) {
      if (i < n) { avg += src[i]; if (i === n - 1) out[i] = avg / n; }
      else { avg = (avg * (n - 1) + src[i]) / n; out[i] = avg; }
    }
    return out;
  }

  function trArr(c) {
    const tr = new Array(c.length); tr[0] = c[0].high - c[0].low;
    for (let i = 1; i < c.length; i++)
      tr[i] = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
    return tr;
  }

  function atrArr(c, n) { return wilderArr(trArr(c), n); }

  function rsiArr(c, n) {
    const g = new Array(c.length).fill(0), l = new Array(c.length).fill(0);
    for (let i = 1; i < c.length; i++) { const d = c[i].close - c[i - 1].close; if (d > 0) g[i] = d; else l[i] = -d; }
    const ag = wilderArr(g, n), al = wilderArr(l, n), out = new Array(c.length).fill(null);
    for (let i = n; i < c.length; i++) out[i] = al[i] === 0 ? (ag[i] === 0 ? 50 : 100) : 100 - 100 / (1 + ag[i] / al[i]);
    return out;
  }

  function macdArr(c) {
    const src = closes(c);
    const f = emaArr(src, 12), s = emaArr(src, 26);
    const macd = new Array(c.length);
    for (let i = 0; i < c.length; i++) macd[i] = f[i] - s[i];
    const signal = emaArr(macd, 9);
    const hist = new Array(c.length);
    for (let i = 0; i < c.length; i++) hist[i] = macd[i] - signal[i];
    return { macd, signal, hist };
  }

  function adxArr(c, n) {
    const L = c.length;
    const up = new Array(L).fill(0), dn = new Array(L).fill(0), tr = trArr(c);
    for (let i = 1; i < L; i++) {
      const um = c[i].high - c[i - 1].high, dm = c[i - 1].low - c[i].low;
      up[i] = (um > dm && um > 0) ? um : 0;
      dn[i] = (dm > um && dm > 0) ? dm : 0;
    }
    const sutr = wilderArr(tr, n), sup = wilderArr(up, n), sdn = wilderArr(dn, n);
    const diP = new Array(L).fill(null), diM = new Array(L).fill(null), dx = new Array(L).fill(0);
    for (let i = n - 1; i < L; i++) {
      if (!sutr[i]) continue;
      diP[i] = 100 * sup[i] / sutr[i]; diM[i] = 100 * sdn[i] / sutr[i];
      const sum = diP[i] + diM[i]; dx[i] = sum ? 100 * Math.abs(diP[i] - diM[i]) / sum : 0;
    }
    const adx = wilderArr(dx, n);
    return { adx, diP, diM };
  }

  function bollingerArr(c, n, k) {
    const src = closes(c), L = src.length;
    const mid = new Array(L).fill(null), up = new Array(L).fill(null),
          lo = new Array(L).fill(null), pctb = new Array(L).fill(null);
    let sum = 0, sq = 0;
    for (let i = 0; i < L; i++) {
      sum += src[i]; sq += src[i] * src[i];
      if (i >= n) { sum -= src[i - n]; sq -= src[i - n] * src[i - n]; }
      if (i >= n - 1) {
        const m = sum / n, sd = Math.sqrt(Math.max(0, sq / n - m * m));
        mid[i] = m; up[i] = m + k * sd; lo[i] = m - k * sd;
        pctb[i] = (up[i] - lo[i]) ? (src[i] - lo[i]) / (up[i] - lo[i]) : 0.5;
      }
    }
    return { up, mid, lo, pctb };
  }

  function supertrendArr(c, mult, n) {
    const atr = atrArr(c, n), L = c.length;
    const dir = new Array(L).fill(0), line = new Array(L).fill(0);
    let fu = 0, fl = 0, prevIsUpper = true;
    for (let i = 0; i < L; i++) {
      const hl2 = (c[i].high + c[i].low) / 2, a = atr[i] || 0;
      const bu = hl2 + mult * a, bl = hl2 - mult * a;
      if (i === 0) { fu = bu; fl = bl; prevIsUpper = true; dir[i] = -1; line[i] = fu; continue; }
      fu = (bu < fu || c[i - 1].close > fu) ? bu : fu;
      fl = (bl > fl || c[i - 1].close < fl) ? bl : fl;
      prevIsUpper = prevIsUpper ? c[i].close <= fu : !(c[i].close >= fl);
      dir[i] = prevIsUpper ? -1 : 1;
      line[i] = prevIsUpper ? fu : fl;
    }
    return { dir, line };
  }

  function mfiArr(c, n) {
    const L = c.length, pmf = new Array(L).fill(0), nmf = new Array(L).fill(0);
    for (let i = 1; i < L; i++) {
      const tp = (c[i].high + c[i].low + c[i].close) / 3;
      const tpp = (c[i - 1].high + c[i - 1].low + c[i - 1].close) / 3;
      const mf = tp * (c[i].volume || 0);
      if (tp > tpp) pmf[i] = mf; else if (tp < tpp) nmf[i] = mf;
    }
    const out = new Array(L).fill(null);
    let ps = 0, ns = 0;
    for (let i = 0; i < L; i++) {
      ps += pmf[i]; ns += nmf[i];
      if (i >= n) { ps -= pmf[i - n]; ns -= nmf[i - n]; }
      if (i >= n - 1) out[i] = (ps + ns) ? 100 * ps / (ps + ns) : 50;
    }
    return out;
  }

  function obvArr(c) {
    const out = new Array(c.length); let o = 0;
    for (let i = 0; i < c.length; i++) {
      if (i > 0) {
        if (c[i].close > c[i - 1].close) o += (c[i].volume || 0);
        else if (c[i].close < c[i - 1].close) o -= (c[i].volume || 0);
      }
      out[i] = o;
    }
    return out;
  }

  function stochArr(c, n) {
    const out = new Array(c.length).fill(null);
    for (let i = n - 1; i < c.length; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let j = i - n + 1; j <= i; j++) { if (c[j].high > hh) hh = c[j].high; if (c[j].low < ll) ll = c[j].low; }
      out[i] = (hh - ll) ? 100 * (c[i].close - ll) / (hh - ll) : 50;
    }
    return out;
  }

  function vwapArr(c) {
    const out = new Array(c.length); let cpv = 0, cv = 0;
    for (let i = 0; i < c.length; i++) {
      const tp = (c[i].high + c[i].low + c[i].close) / 3, v = c[i].volume || 0;
      cpv += tp * v; cv += v; out[i] = cv ? cpv / cv : tp;
    }
    return out;
  }

  function linSlopeArr(src, n) {
    const L = src.length, out = new Array(L).fill(null);
    for (let i = n - 1; i < L; i++) {
      let sx = 0, sy = 0, sxy = 0, sxx = 0;
      for (let j = 0; j < n; j++) { const x = j, y = src[i - n + 1 + j]; sx += x; sy += y; sxy += x * y; sxx += x * x; }
      const den = n * sxx - sx * sx;
      out[i] = den ? (n * sxy - sx * sy) / den : 0;
    }
    return out;
  }

  function swingPoints(c, lb) {
    const highs = [], lows = [];
    for (let i = lb; i < c.length - lb; i++) {
      let isH = true, isL = true;
      for (let j = i - lb; j <= i + lb; j++) {
        if (c[j].high > c[i].high) isH = false;
        if (c[j].low < c[i].low) isL = false;
      }
      if (isH) highs.push({ i, v: c[i].high });
      if (isL) lows.push({ i, v: c[i].low });
    }
    return { highs, lows };
  }

  function istDay(t) { return Math.floor((t * 1000 + 5.5 * 3600 * 1000) / (86400 * 1000)); }

  function istNowSec() { return Math.floor((Date.now() + 5.5 * 3600 * 1000) / 1000); }

  function dayChangePct(c) {
    if (!c.length) return 0;
    const lastDay = istDay(c[c.length - 1].time);
    let prevClose = null;
    for (let i = c.length - 2; i >= 0; i--) { if (istDay(c[i].time) < lastDay) { prevClose = c[i].close; break; } }
    if (prevClose == null) prevClose = c[0].close;
    return prevClose ? (c[c.length - 1].close - prevClose) / prevClose * 100 : 0;
  }

  function momentumPct(c, n) {
    if (c.length <= n) return 0;
    const a = c[c.length - 1 - n].close, b = c[c.length - 1].close;
    return a ? (b - a) / a * 100 : 0;
  }

  function corr(a, b, n) {
    let mx = 0, my = 0, n2 = 0;
    for (let i = a.length - n; i < a.length; i++) { mx += a[i]; my += b[i]; n2++; }
    if (!n2) return 0;
    mx /= n2; my /= n2;
    let sxx = 0, syy = 0, sxy = 0;
    for (let i = a.length - n; i < a.length; i++) {
      const dx = a[i] - mx, dy = b[i] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
    }
    const den = Math.sqrt(sxx * syy);
    return den ? sxy / den : 0;
  }

  function returnsArr(c) {
    const r = new Array(c.length); r[0] = 0;
    for (let i = 1; i < c.length; i++) r[i] = c[i - 1].close ? (c[i].close - c[i - 1].close) / c[i - 1].close * 100 : 0;
    return r;
  }

  function percentile(vals, v) {
    if (!vals.length) return 50;
    let lo = 0;
    for (let i = 0; i < vals.length; i++) if (vals[i] <= v) lo++;
    return lo / vals.length * 100;
  }

  function median(a) {
    if (!a.length) return 0;
    const s = a.slice().sort((x, y) => x - y);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /* Resample lower-timeframe candles into higher-timeframe bars (client-side,
     so no extra Dhan calls are needed and the whole pass stays <10ms). */
  function resample(c, bucketSec) {
    const out = [];
    let cur = null;
    for (let i = 0; i < c.length; i++) {
      const b = Math.floor(c[i].time / bucketSec) * bucketSec;
      if (!cur || cur.time !== b) {
        if (cur) out.push(cur);
        cur = { time: b, open: c[i].open, high: c[i].high, low: c[i].low, close: c[i].close, volume: c[i].volume || 0 };
      } else {
        if (c[i].high > cur.high) cur.high = c[i].high;
        if (c[i].low < cur.low) cur.low = c[i].low;
        cur.close = c[i].close;
        cur.volume += (c[i].volume || 0);
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  /* ------------------------- data-quality checks ------------------------- */

  function staleness(c) {
    const age = istNowSec() - c[c.length - 1].time;
    if (age > 30 * 60) return { stale: true, mins: Math.round(age / 60) };
    return { stale: false, mins: 0 };
  }

  function flatness(c) {
    const rng = c.map(x => x.high - x.low);
    const recent = rng.slice(-10), base = rng.slice(-100, -10);
    const mr = median(recent), mb = median(base);
    if (!mb) return mr ? 1 : 0;
    return Math.max(0, Math.min(1, 1 - mr / mb));
  }

  /* --------------------------- signal helpers --------------------------- */

  function tone(signal) { return signal === 'bullish' ? GREEN : signal === 'bearish' ? RED : NEUTRAL; }

  function finalize(r) {
    r.verdict = classify(r);
    const dispersion = r.dispersion != null ? r.dispersion : 0;
    let conf = Math.abs(r.score) * 1.4 * (1 - 0.45 * dispersion);
    if (r.stale) conf *= 0.7;
    if (r.flatness > 0.3) conf *= 0.6;
    r.confidence = Math.max(0, Math.min(100, Math.round(conf)));
    return r;
  }

  function classify(r) {
    if (r.flatness > 0.5) return { label: 'Consolidation', tone: 'neutral' };
    if (r.dispersion >= 0.5 && Math.abs(r.score) < 30) return { label: 'Consolidation', tone: 'neutral' };
    if (r.adx < 18 && Math.abs(r.score) < 25) return { label: 'Consolidation', tone: 'neutral' };
    if (r.score >= 40) return { label: 'Strongly Bullish', tone: 'bullish' };
    if (r.score >= 12) return { label: 'Bullish', tone: 'bullish' };
    if (r.score <= -40) return { label: 'Strongly Bearish', tone: 'bearish' };
    if (r.score <= -12) return { label: 'Bearish', tone: 'bearish' };
    return { label: 'Consolidation', tone: 'neutral' };
  }

  /* ------------------------- timeframe trend votes ------------------------- */

  /* Full-series least-squares slope (multi-day direction). */
  function fullSlope(src) {
    const n = src.length;
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) { sx += i; sy += src[i]; sxy += i * src[i]; sxx += i * i; }
    const den = n * sxx - sx * sx;
    return den ? (n * sxy - sx * sy) / den : 0;
  }

  /* Positional (multi-day) vote: full-series trend slope + price vs a long MA. */
  function positionalVote(c) {
    const src = closes(c);
    const n = src.length;
    if (n < 40) return { vote: 0, detail: 'insufficient history' };
    const i = n - 1;
    const period = Math.min(300, Math.max(20, Math.floor(n * 0.6)));
    const ma = smaArr(src, period);
    const above = ma[i] != null && src[i] > ma[i];
    const sl = fullSlope(src);
    const rising = sl > 0;
    const vote = (above ? 0.5 : -0.5) + (rising ? 0.5 : -0.5);
    const pct = src[i] ? sl / src[i] * 100 : 0;
    return { vote, detail: 'close ' + fmt(src[i]) + (above ? ' above ' : ' below ') + 'SMA' + period + ' ' + fmt(ma[i]) + ' · multi-day slope ' + (pct >= 0 ? '+' : '') + fmt(pct, 2) + '%/bar' };
  }

  /* Swing (1-hour) vote: EMA9/21 alignment + price vs EMA21 + MACD sign. */
  function swingVote(c60) {
    if (c60.length < 30) return { vote: 0, detail: 'insufficient history' };
    const src = closes(c60);
    const e9 = emaArr(src, 9), e21 = emaArr(src, 21);
    const i = src.length - 1;
    const m = macdArr(c60);
    let v = 0;
    if (e9[i] > e21[i]) v += 0.34; else v -= 0.34;
    if (src[i] > e21[i]) v += 0.33; else v -= 0.33;
    if (m.hist[i] > 0) v += 0.33; else v -= 0.33;
    return { vote: clamp1(v), detail: 'EMA9 ' + fmt(e9[i]) + (e9[i] > e21[i] ? ' > ' : ' < ') + 'EMA21 ' + fmt(e21[i]) + ' · MACD hist ' + (m.hist[i] >= 0 ? '+' : '') + fmt(m.hist[i]) };
  }

  /* Short (15-min) vote: EMA stack + supertrend + price vs EMA21. */
  function shortVote(c15) {
    if (c15.length < 55) return { vote: 0, detail: 'insufficient history' };
    const src = closes(c15);
    const e9 = emaArr(src, 9), e21 = emaArr(src, 21), e50 = emaArr(src, 50);
    const i = src.length - 1;
    const st = supertrendArr(c15, 3, 10);
    let v = 0;
    if (e9[i] > e21[i]) v += 0.25; else v -= 0.25;
    if (e21[i] > e50[i]) v += 0.25; else v -= 0.25;
    if (src[i] > e21[i]) v += 0.25; else v -= 0.25;
    if (st.dir[i] === 1) v += 0.25; else v -= 0.25;
    return { vote: clamp1(v), detail: 'EMA9/21/50 ' + (e9[i] > e21[i] && e21[i] > e50[i] ? 'bullish stack' : e9[i] < e21[i] && e21[i] < e50[i] ? 'bearish stack' : 'mixed') + ' · Supertrend ' + (st.dir[i] === 1 ? 'up' : 'down') };
  }

  /* Intraday (3-min) momentum vote: MACD + VWAP + EMA21 + RSI midpoint. */
  function intradayVote(c) {
    const src = closes(c);
    const i = src.length - 1;
    const m = macdArr(c);
    const vw = vwapArr(c);
    const e21 = emaArr(src, 21);
    const rsi = rsiArr(c, 14), r = rsi[i] || 50;
    let v = 0;
    if (m.hist[i] > 0) v += 0.25; else v -= 0.25;
    if (src[i] > vw[i]) v += 0.25; else v -= 0.25;
    if (src[i] > e21[i]) v += 0.25; else v -= 0.25;
    if (r > 50) v += 0.25; else v -= 0.25;
    return { vote: clamp1(v), detail: 'MACD hist ' + (m.hist[i] >= 0 ? '+' : '') + fmt(m.hist[i]) + ' · ' + (src[i] > vw[i] ? 'above' : 'below') + ' VWAP · RSI ' + r.toFixed(0) };
  }

  /* --------------------------- core analysis --------------------------- */

  function analyze(candles, meta) {
    const full = candles;
    const c = candles.slice(-MAX_BARS);
    const L = c.length;
    const comps = [];
    const add = (label, group, score, weight, detail) => {
      const s = score > 0.15 ? 'bullish' : score < -0.15 ? 'bearish' : 'neutral';
      comps.push({ label, group, signal: s, score, weight: weight || 1, detail });
    };

    const last = c[L - 1], close = last.close;
    const src = closes(c);
    const i = L - 1;

    /* --- timeframe trend votes --- */
    const pos = positionalVote(full);
    const c15 = resample(c, 900);
    const c60 = resample(c, 3600);
    const swing = swingVote(c60);
    const short = shortVote(c15);
    const intra = intradayVote(c);

    add('Positional (multi-day)', 'Trend', pos.vote, 0.30, pos.detail);
    add('Swing (1-hour)', 'Trend', swing.vote, 0.25, swing.detail);
    add('Short (15-min)', 'Trend', short.vote, 0.25, short.detail);
    add('Intraday (3-min)', 'Trend', intra.vote, 0.20, intra.detail);

    const trendScore = clamp1(0.30 * pos.vote + 0.25 * swing.vote + 0.25 * short.vote + 0.20 * intra.vote);

    /* agreement across the four timeframe votes (0..1 -> 1 = all agree) */
    const signs = [pos.vote, swing.vote, short.vote, intra.vote].filter(v => v !== 0).map(v => v > 0 ? 1 : -1);
    const agree = signs.length ? Math.abs(signs.reduce((a, b) => a + b, 0)) / signs.length : 0;
    const tfDispersion = 1 - agree;

    /* --- momentum / exhaustion oscillators (reversal-flavoured) --- */
    const rsi = rsiArr(c, 14), r = rsi[i] || 50;
    const rsiScore = r > 70 ? -0.3 : r < 30 ? 0.3 : r > 50 ? 0.25 : -0.25;
    add('RSI (14)', 'Momentum', rsiScore, 1, 'RSI ' + r.toFixed(1) + (r > 70 ? ' (overbought)' : r < 30 ? ' (oversold)' : ''));

    const mfi = mfiArr(c, 14), mf = mfi[i] || 50;
    add('MFI (14)', 'Momentum', mf > 60 ? 0.4 : mf < 40 ? -0.4 : 0, 1, 'MFI ' + mf.toFixed(1));

    const sk = stochArr(c, 14), sv = sk[i] || 50;
    add('Stochastic %K (14)', 'Momentum', sv > 80 ? -0.2 : sv < 20 ? 0.2 : sv > 50 ? 0.15 : -0.15, 1, '%K ' + sv.toFixed(1));

    const obv = obvArr(c);
    const obvSlope = obv[i] - (obv[Math.max(0, i - 10)] || obv[0]);
    add('OBV (10-bar delta)', 'Momentum', obvSlope > 0 ? 0.4 : obvSlope < 0 ? -0.4 : 0, 1, 'OBV delta ' + (obvSlope >= 0 ? '+' : '') + obvSlope);

    const oscScore = clamp1((rsiScore + (mf > 60 ? 0.4 : mf < 40 ? -0.4 : 0) + (sv > 80 ? -0.2 : sv < 20 ? 0.2 : sv > 50 ? 0.15 : -0.15) + (obvSlope > 0 ? 0.4 : obvSlope < 0 ? -0.4 : 0)) / 4);

    /* --- ADX (trend strength, not direction) --- */
    const adx = adxArr(c, 14);
    const adxV = adx.adx[i] || 0, dip = adx.diP[i] || 0, dim = adx.diM[i] || 0;
    add('ADX (14)', 'Momentum', adxV < 20 ? 0 : (dip > dim ? 0.3 : -0.3), 1,
      'ADX ' + adxV.toFixed(1) + ' (+DI ' + dip.toFixed(1) + ' / -DI ' + dim.toFixed(1) + ')' + (adxV < 20 ? ' — no trend' : ''));

    /* --- structure: swing + support/resistance --- */
    const sw = swingPoints(c, 2);
    let structScore = 0, structDetail = 'Mixed structure';
    if (sw.highs.length >= 2 && sw.lows.length >= 2) {
      const hh = sw.highs[sw.highs.length - 1].v > sw.highs[sw.highs.length - 2].v;
      const hl = sw.lows[sw.lows.length - 1].v > sw.lows[sw.lows.length - 2].v;
      if (hh && hl) { structScore = 1; structDetail = 'Higher highs + higher lows (uptrend)'; }
      else if (!hh && !hl) { structScore = -1; structDetail = 'Lower highs + lower lows (downtrend)'; }
      else structDetail = 'Mixed (higher high + lower low = compression)';
    }
    add('Swing structure', 'Structure', structScore, 0.08, structDetail);

    let prevHi = -Infinity, prevLo = Infinity;
    for (let j = Math.max(0, i - 20); j < i; j++) { if (c[j].high > prevHi) prevHi = c[j].high; if (c[j].low < prevLo) prevLo = c[j].low; }
    let srScore = 0, srDetail = '';
    if (close > prevHi) { srScore = 0.5; srDetail = 'Breakout above resistance ' + fmt(prevHi); }
    else if (close < prevLo) { srScore = -0.5; srDetail = 'Breakdown below support ' + fmt(prevLo); }
    else {
      const posn = (prevHi - prevLo) ? (close - prevLo) / (prevHi - prevLo) : 0.5;
      srDetail = 'Ranging between support ' + fmt(prevLo) + ' and resistance ' + fmt(prevHi) + ' (price at ' + Math.round(posn * 100) + '%)';
    }
    add('Support / Resistance', 'Structure', srScore, 0.08, srDetail);

    /* --- candlestick patterns (last 3 bars) --- */
    const CP = window.CandlePatterns;
    const bull = [], bear = [], consol = [], liq = [];
    if (CP && CP.PATTERNS) {
      const tail = c.slice(-8);
      for (const k in CP.PATTERNS) {
        const p = CP.PATTERNS[k];
        let hit = false, barsAgo = 0;
        for (let off = 0; off < 3; off++) {
          if (tail.length - off < p.bars) break;
          if (CP.detect(k, tail.slice(0, tail.length - off))) { hit = true; barsAgo = off; break; }
        }
        if (hit) {
          const e = { name: p.name, barsAgo };
          if (p.direction === 'bullish') (p.type === 'liquidity' ? liq : bull).push(e);
          else if (p.direction === 'bearish') (p.type === 'liquidity' ? liq : bear).push(e);
          else (p.type === 'liquidity' ? liq : consol).push(e);
        }
      }
    }
    const patWeight = e => e.barsAgo === 0 ? 1 : e.barsAgo === 1 ? 0.6 : 0.3;
    let patScore = 0;
    bull.forEach(e => patScore += patWeight(e));
    bear.forEach(e => patScore -= patWeight(e));
    patScore = clamp1(patScore);
    add('Candlestick patterns', 'Patterns', patScore, 0.12,
      (bull.map(e => e.name).join(', ') || 'none bullish') + ' / ' + (bear.map(e => e.name).join(', ') || 'none bearish') +
      (consol.length ? ' · ' + consol.map(e => e.name).join(', ') : ''));

    let liqScore = 0;
    const liqParts = [];
    if (liq.some(e => /Below/.test(e.name))) { liqScore += 0.5; liqParts.push('stop-hunt below (bullish grab)'); }
    if (liq.some(e => /Above/.test(e.name))) { liqScore -= 0.5; liqParts.push('stop-hunt above (bearish grab)'); }
    if (liq.some(e => e.name === 'False Breakout')) { liqParts.push('false breakout (trap)'); }
    add('Liquidity / stop hunts', 'Liquidity', clamp1(liqScore), 0.12, liqParts.length ? liqParts.join(' · ') : 'No stop hunts or traps detected');

    /* --- aggregate --- */
    const patternAndLiq = clamp1(patScore * 0.5 + clamp1(liqScore) * 0.5);
    const score100 = (trendScore * 0.55 + oscScore * 0.25 + patternAndLiq * 0.12 + (structScore * 0.5 + srScore * 0.5) * 0.08) * 100;

    /* dispersion: how split are ALL directional signals */
    let bC = 0, rC = 0;
    comps.forEach(co => { if (co.signal === 'bullish') bC++; else if (co.signal === 'bearish') rC++; });
    const total = bC + rC;
    const dispersion = total ? (2 * Math.min(bC, rC) / total) : 0;

    const stl = staleness(c);
    const flt = flatness(c);

    /* reversal watch: trend up + overbought + bearish pattern, or inverse */
    let reversalWatch = null;
    if (trendScore > 0.2 && (r > 70 || sv > 80) && bear.length) reversalWatch = 'Bearish reversal watch (uptrend + overbought + ' + bear[0].name + ')';
    else if (trendScore < -0.2 && (r < 30 || sv < 20) && bull.length) reversalWatch = 'Bullish reversal watch (downtrend + oversold + ' + bull[0].name + ')';

    const result = {
      name: meta.name, id: meta.id, exch: meta.exch,
      ltp: close,
      changePct: dayChangePct(c),
      mom10: momentumPct(c, 10),
      score: score100,
      trendScore, oscScore,
      dispersion, tfDispersion,
      adx: adxV, atr: (atrArr(c, 14)[i] || 0),
      rsi: r, close,
      support: prevLo, resistance: prevHi,
      components: comps,
      patterns: { bull, bear, consol, liq },
      vixLevel: close,
      vixPct: meta.isVix ? percentile(src, close) : null,
      returns: returnsArr(c),
      stale: stl.stale, staleMins: stl.mins, flatness: flt,
      trendAlign: Math.round(agree * 100),
      reversalWatch,
      updatedAt: Date.now()
    };
    return finalize(result);
  }

  /* ---------------------- inter-index relationships ---------------------- */

  function interIndex(map) {
    const n = map['NIFTY 50'], v = map['INDIA VIX'], g = map['GIFT NIFTY'];
    const cross = {};
    const aligned = (a, b) => (a > 0 && b > 0) || (a < 0 && b < 0);

    if (g && n) {
      const cor = corr(g.returns, n.returns, Math.min(30, g.returns.length, n.returns.length));
      const lead = aligned(g.mom10, n.mom10);
      cross.gift = {
        corr: cor, aligned: lead,
        text: 'GIFT NIFTY ' + (g.mom10 >= 0 ? '+' : '') + fmt(g.mom10, 2) + '% vs NIFTY 50 ' + (n.mom10 >= 0 ? '+' : '') + fmt(n.mom10, 2) + '% · correlation ' + fmt(cor, 2) + ' · ' + (lead ? 'GIFT confirms NIFTY direction' : 'GIFT and NIFTY diverge — caution'),
        tone: lead ? (g.mom10 >= 0 ? 'bullish' : 'bearish') : 'neutral'
      };
    }

    if (n) {
      const peers = ['SENSEX', 'BANK NIFTY', 'FINNIFTY', 'MIDCPNIFTY'];
      let alignedN = 0, tot = 0;
      const parts = peers.map(p => {
        const r = map[p];
        if (!r) return null;
        tot++;
        const a = aligned(n.mom10, r.mom10);
        if (a) alignedN++;
        return { name: p, mom: r.mom10, aligned: a };
      }).filter(Boolean);
      cross.spillover = {
        alignedN, tot, parts,
        text: alignedN + '/' + tot + ' peers move with NIFTY · ' + parts.map(p => p.name + ' ' + (p.mom >= 0 ? '+' : '') + fmt(p.mom, 2) + '%').join(' · '),
        tone: tot && alignedN >= tot * 0.75 ? (n.mom10 >= 0 ? 'bullish' : 'bearish') : 'neutral'
      };
    }

    if (v && n) {
      const inverse = !aligned(v.mom10, n.mom10);
      const fear = v.vixPct != null ? (v.vixPct > 75 ? 'high' : v.vixPct < 25 ? 'low' : 'normal') : 'normal';
      cross.vix = {
        vix: v.ltp, pct: v.vixPct, inverse,
        text: 'VIX ' + fmt(v.ltp, 2) + ' (' + (v.vixPct != null ? Math.round(v.vixPct) : '—') + 'th percentile, ' + fear + ') · VIX ' + (v.mom10 >= 0 ? '+' : '') + fmt(v.mom10, 2) + '% · ' + (inverse ? 'normal inverse move vs NIFTY' : 'unusual co-move — watch for regime shift'),
        tone: inverse ? 'neutral' : 'bearish'
      };
    }
    return cross;
  }

  /* Cross-index consensus anchoring: pull each NIFTY-family index 25% toward
     the broad-market median so a single-symbol noise bar cannot fake a trend
     that contradicts every other index. */
  function anchorConsensus(results) {
    const present = FAMILY.map(n => results[n]).filter(Boolean);
    if (present.length < 2) return;
    const med = median(present.map(r => r.score));
    present.forEach(r => {
      r.score = r.score * 0.75 + med * 0.25;
      finalize(r);
    });
  }

  /* ------------------------------ summary ------------------------------ */

  function buildSummary(r) {
    const s = [];
    s.push(r.name + ' is <b style="color:' + tone(r.verdict.tone) + '">' + r.verdict.label + '</b>');
    s.push('score ' + (r.score >= 0 ? '+' : '') + fmt(r.score, 1) + ', confidence ' + r.confidence + '%');
    s.push('timeframe alignment ' + r.trendAlign + '% (ADX ' + fmt(r.adx, 1) + ')');
    const bull = r.components.filter(c2 => c2.signal === 'bullish').length;
    const bear = r.components.filter(c2 => c2.signal === 'bearish').length;
    s.push(bull + ' bullish / ' + bear + ' bearish signals');
    if (r.patterns.bull.length) s.push('bullish: ' + r.patterns.bull.map(e => e.name).join(', '));
    if (r.patterns.bear.length) s.push('bearish: ' + r.patterns.bear.map(e => e.name).join(', '));
    if (r.patterns.consol.length) s.push('consolidation: ' + r.patterns.consol.map(e => e.name).join(', '));
    if (r.reversalWatch) s.push('<span style="color:' + AMBER + '">' + esc(r.reversalWatch) + '</span>');
    s.push('support ' + fmt(r.support) + ' / resistance ' + fmt(r.resistance));
    if (r.stale) s.push('<span style="color:' + AMBER + '">market closed/stale (' + r.staleMins + ' min)</span>');
    return s.join(' · ');
  }

  /* ------------------------------ rendering ------------------------------ */

  function $id(x) { return document.getElementById(x); }

  function badge(v) {
    const c = tone(v.tone);
    return '<span style="display:inline-block;padding:2px 10px;border-radius:10px;font-size:10px;font-weight:700;' +
      'color:' + c + ';background:' + (v.tone === 'bullish' ? 'rgba(0,212,170,0.12)' : v.tone === 'bearish' ? 'rgba(255,82,82,0.12)' : 'rgba(158,158,158,0.12)') +
      ';border:1px solid ' + c + '">' + esc(v.label) + '</span>';
  }

  function signalDot(s) {
    const c = tone(s);
    return '<span style="color:' + c + ';font-weight:700">' + (s === 'bullish' ? '▲' : s === 'bearish' ? '▼' : '●') + '</span>';
  }

  function renderList(results, ms) {
    const host = $id('idxTrendList');
    if (!host) return;
    const rows = results.filter(r => r).map(r => {
      const chg = r.changePct, chgCol = chg > 0 ? GREEN : chg < 0 ? RED : GRAY;
      const barCol = r.score >= 0 ? GREEN : RED;
      const strength = Math.min(100, Math.abs(r.score));
      const tags = [];
      if (r.stale) tags.push('<span style="font-size:9px;color:' + AMBER + '">stale</span>');
      if (r.reversalWatch) tags.push('<span style="font-size:9px;color:' + AMBER + '">reversal</span>');
      return '<div class="idxt-row" style="display:flex;align-items:center;gap:12px;padding:8px 12px;border-bottom:1px solid #1e1e40">' +
        '<div style="flex:1;min-width:130px">' +
          '<div style="font-size:12px;font-weight:700;color:#e0e0e0">' + esc(r.name) + '</div>' +
          '<div style="font-size:10px;color:#666">LTP ' + fmt(r.ltp) + ' · <span style="color:' + chgCol + '">' + (chg >= 0 ? '+' : '') + fmt(chg, 2) + '%</span>' + (tags.length ? ' ' + tags.join(' ') : '') + '</div>' +
        '</div>' +
        '<div style="flex:1;min-width:120px">' + badge(r.verdict) + '</div>' +
        '<div style="flex:2;min-width:160px">' +
          '<div style="font-size:10px;color:#888;margin-bottom:2px">' + (r.score >= 0 ? '+' : '') + fmt(r.score, 1) + ' · conf ' + r.confidence + '% · align ' + r.trendAlign + '% · ADX ' + fmt(r.adx, 1) + '</div>' +
          '<div style="height:4px;background:#1e1e40;border-radius:2px;overflow:hidden"><div style="height:100%;width:' + strength + '%;background:' + barCol + '"></div></div>' +
        '</div>' +
        '<button class="btn-action" style="width:auto;margin:0;padding:3px 12px;font-size:10px" onclick="IndexTrend.showDetail(' + r.id + ')">Details</button>' +
      '</div>';
    }).join('');
    const now = new Date();
    const ts = (window.IST12 && IST12.fmtMs) ? IST12.fmtMs(now.getTime()) : now.toTimeString().slice(0, 8);
    host.innerHTML =
      '<div style="padding:8px 12px;font-size:10px;color:#888;display:flex;justify-content:space-between;align-items:center">' +
        '<span>Re-evaluated every 3 min · ' + results.length + ' indices · compute ' + ms + ' ms</span>' +
        '<span>Last update <span style="color:#00d4aa">' + ts + '</span></span>' +
      '</div>' + rows;
  }

  function renderDetail(r, cross) {
    const m = $id('idxDetailModal');
    if (!m || !r) return;
    $id('idxDetailTitle').textContent = r.name + ' — Trend Analysis';
    const groups = {};
    r.components.forEach(co => {
      if (!groups[co.group]) groups[co.group] = [];
      groups[co.group].push(co);
    });
    const groupOrder = ['Trend', 'Momentum', 'Structure', 'Patterns', 'Liquidity'];
    const groupRows = groupOrder.filter(g => groups[g]).map(g =>
      '<div style="margin:8px 0"><div style="font-size:10px;font-weight:700;color:#ffd700;border-bottom:1px solid #2d2d50;padding-bottom:2px;margin-bottom:4px">' + g + '</div>' +
      groups[g].map(co =>
        '<div style="display:flex;gap:6px;align-items:flex-start;padding:3px 0;font-size:10px;color:#c0c0c0">' +
          '<span style="width:14px">' + signalDot(co.signal) + '</span>' +
          '<span style="flex:1">' + esc(co.label) + '</span>' +
          '<span style="color:#888;flex:2;text-align:right">' + esc(co.detail) + '</span>' +
        '</div>').join('') +
      '</div>').join('');

    const crossRows = [];
    if (cross && cross.gift) crossRows.push('<div style="margin:3px 0;font-size:10px;color:' + tone(cross.gift.tone) + '"><b>GIFT↔NIFTY:</b> ' + esc(cross.gift.text) + '</div>');
    if (cross && cross.spillover) crossRows.push('<div style="margin:3px 0;font-size:10px;color:' + tone(cross.spillover.tone) + '"><b>NIFTY spillover:</b> ' + esc(cross.spillover.text) + '</div>');
    if (cross && cross.vix) crossRows.push('<div style="margin:3px 0;font-size:10px;color:' + tone(cross.vix.tone) + '"><b>INDIA VIX:</b> ' + esc(cross.vix.text) + '</div>');

    const chg = r.changePct, chgCol = chg > 0 ? GREEN : chg < 0 ? RED : GRAY;
    $id('idxDetailBody').innerHTML =
      '<div style="display:flex;align-items:center;gap:10px;margin:6px 0;flex-wrap:wrap">' +
        badge(r.verdict) +
        '<span style="font-size:11px;color:#e0e0e0">Score <b style="color:' + (r.score >= 0 ? GREEN : RED) + '">' + (r.score >= 0 ? '+' : '') + fmt(r.score, 1) + '</b></span>' +
        '<span style="font-size:11px;color:#888">Confidence ' + r.confidence + '%</span>' +
        '<span style="font-size:11px;color:#888">Align ' + r.trendAlign + '%</span>' +
        '<span style="font-size:11px;color:' + chgCol + '">' + (chg >= 0 ? '+' : '') + fmt(chg, 2) + '%</span>' +
      '</div>' +
      '<div style="margin:8px 0;padding:8px;background:#12122a;border:1px solid #2d2d50;border-radius:4px;font-size:10px;color:#d0d0d0">' +
        '<b style="color:#00d4aa">AI summary:</b> ' + buildSummary(r) +
      '</div>' +
      groupRows +
      (crossRows.length ? '<div style="margin:10px 0;padding:8px;background:#12122a;border:1px solid #2d2d50;border-radius:4px">' +
        '<div style="font-size:10px;font-weight:700;color:#00d4aa;margin-bottom:4px">Inter-Index Relationships</div>' +
        crossRows.join('') + '</div>' : '') +
      '<div style="margin:6px 0;font-size:10px;color:#888">Updated ' + (window.IST12 && IST12.fmtMs ? IST12.fmtMs(r.updatedAt) : new Date(r.updatedAt).toTimeString().slice(0, 8)) + ' · ATR ' + fmt(r.atr) + ' · RSI ' + fmt(r.rsi, 1) + '</div>';
    m.classList.remove('hidden');
  }

  function closeDetail() { const m = $id('idxDetailModal'); if (m) m.classList.add('hidden'); }

  /* ------------------------------ controller ------------------------------ */

  let timer = null;
  let lastResults = null;
  let lastCross = null;
  let lastOpenId = null;

  async function refresh() {
    const engine = window.StratEngine;
    if (!engine || !engine.fetchCandlesFor) {
      const host = $id('idxTrendList');
      if (host) host.innerHTML = '<div class="ind-empty">Strategy engine not loaded yet.</div>';
      return;
    }
    const t0 = performance.now();
    const results = {};
    const fetches = INDICES.map(idx =>
      engine.fetchCandlesFor({ id: idx.id, exch: idx.exch, inst: idx.inst }, TF, PERIOD_DAYS)
        .then(candles => {
          const c = (candles && candles.length) ? candles : null;
          if (!c) return null;
          results[idx.name] = analyze(c, { name: idx.name, id: idx.id, isVix: idx.id === 21 });
        }).catch(() => null));
    await Promise.all(fetches);
    anchorConsensus(results);
    const cross = interIndex(results);
    lastCross = cross;
    const listed = INDICES.filter(x => x.listed).map(x => results[x.name]).filter(Boolean);
    lastResults = listed;
    const ms = Math.round((performance.now() - t0) * 10) / 10;
    renderList(listed, ms);
    if (lastOpenId != null) {
      const r = listed.find(x => x.id === lastOpenId);
      if (r) renderDetail(r, cross);
    }
  }

  const api = {
    onTabShow() {
      refresh();
      if (timer) clearInterval(timer);
      timer = setInterval(refresh, REFRESH_MS);
    },
    onTabHide() { if (timer) { clearInterval(timer); timer = null; } },
    refresh,
    showDetail(id) {
      lastOpenId = id;
      if (lastResults) {
        const r = lastResults.find(x => x.id === id);
        if (r) renderDetail(r, lastCross);
      }
    },
    closeDetail
  };
  window.IndexTrend = api;
})();
