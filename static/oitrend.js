/* OITrend - "OI Trend + Levels" overlay.
 *
 * Reads the options-chain (per-strike CE/PE OI, change-in-OI, volume, premium,
 * IV) of the currently watched underlying and paints, on the main candle chart:
 *
 *   1. OI LEVEL LINES (spot/futures/index views only)
 *        - strongest CE (call-writer) walls above spot  -> RESISTANCE
 *        - strongest PE (put-writer) walls below spot   -> SUPPORT
 *        - Max Pain strike (whole-chain option-payout argmin)
 *        - Expected max range from ATM implied volatility (1-sigma band)
 *   1b. On PREMIUM OPTION charts a compact strip under the price chart shows the
 *        same chain as OI ORDERED BY STRIKE: CE OI extends left, PE OI right,
 *        with the actual spot line drawn horizontally between CE and PE where
 *        the market actually is (plus Max Pain / expected range / PCR chips).
 *   2. An EMA-LIKE TREND-STATE LINE (spot/futures/index views only)
 *        - bull trend  : line drifts up    + up arrow   + "Trend Continue"
 *        - bear trend  : line drifts down  + down arrow + "Trend Continue"
 *        - reversal    : flipped arrow + "Reversal" (near an OI wall / PCR /
 *                        volume-divergence trigger)
 *        - consolidation: FLAT line + converging glyph arrows + "Consolidation
 *                        Liquidity Grabbing Phase"
 *   Volume agreement decides trend STRENGTH (trend + rising volume = strong,
 *   trend + fading volume = weak). PCR extremes add reversal weight.
 *
 * Level labels are deterministic functions of the chain snapshot; direction
 * arrows are re-evaluated on every quote tick (renderQuotes ~250ms) so they
 * flip BEFORE the forming candle closes.
 *
 * The heavy math lives in OITrend.Pure so it can be unit-tested headlessly
 * (node) with synthetic candles + a real chain JSON.
 */
(function () {
  'use strict';
  const G = (typeof window !== 'undefined') ? window : globalThis;
  const IC = function () { return G.IndChart || null; };
  const LS_KEY = 'oitrend:enabled';

  /* The dashboard declares selectedSymbol / clientQuotes with a top-level `let`
     in an inline classic script (templates/index.html). Top-level let/const live
     in the global LEXICAL scope, NOT as properties of window, so reading them as
     G.selectedSymbol / G.clientQuotes always returned undefined. syncUnder() then
     bailed on every tick, _under stayed null and fetchChain() returned before the
     request: no option chain was ever fetched, which left EVERTHING OI-driven blank
     (OI Trend overlay + the standalone IV / PCR EMA / OI Rails indicators). Read
     the lexical bindings directly (visible across classic scripts) behind a typeof
     guard, with the window property as a fallback for other embeddings. */
  function gSelSymbol() {
    try { if (typeof selectedSymbol !== 'undefined' && selectedSymbol) return selectedSymbol; } catch (e) {}
    return G.selectedSymbol || null;
  }
  function gClientQuotes() {
    try { if (typeof clientQuotes !== 'undefined' && clientQuotes) return clientQuotes; } catch (e) {}
    return G.clientQuotes || null;
  }

  /* --------------------------- pure math -------------------------------- */
  function emaArr(vals, n) {
    const k = 2 / (n + 1);
    const out = new Array(vals.length);
    let p = vals[0];
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i];
      if (v == null || isNaN(v)) { out[i] = p; continue; }
      p = (i === 0) ? v : v * k + p * (1 - k);
      out[i] = p;
    }
    return out;
  }
  function smaArr(vals, n) {
    const out = new Array(vals.length).fill(null);
    let sum = 0;
    for (let i = 0; i < vals.length; i++) {
      sum += (vals[i] || 0);
      if (i >= n) sum -= (vals[i - n] || 0);
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }
  function trueRangeAt(c, p) {
    if (!p) return c.high - c.low;
    return Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  function atrArr(candles, n) {
    const out = new Array(candles.length).fill(null);
    if (!candles.length) return out;
    let tr = trueRangeAt(candles[0], null);
    out[0] = tr;
    for (let i = 1; i < candles.length; i++) {
      tr = trueRangeAt(candles[i], candles[i - 1]);
      const prev = out[i - 1];
      out[i] = prev == null ? tr : (prev * (n - 1) + tr) / n;
    }
    return out;
  }

  /* Standard-normal cdf/pdf (Abramowitz-Stegun 7.1.26 erf approximation, same
     spirit as the server-side Black-Scholes so the client ATM greeks track it). */
  function normCdf(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989422804014327 * Math.exp(-x * x / 2);
    const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return x >= 0 ? 1 - p : p;
  }
  function normPdf(x) {
    return 0.3989422804014327 * Math.exp(-x * x / 2);
  }
  /* ATM greeks from spot / strike / IV(percent) / days-to-expiry. Returns
     {delta, vega} for the ATM CALL (vega is call/put symmetric). */
  function atmGreeks(spot, strike, ivPct, dteDays) {
    const S = +spot, K = +strike, sig = (+ivPct) / 100;
    const T = Math.max(+dteDays || 7, 0.5) / 365;
    if (!(S > 0 && K > 0 && sig > 0 && T > 0)) return null;
    const root = sig * Math.sqrt(T);
    const d1 = (Math.log(S / K) + (0.06 + 0.5 * sig * sig) * T) / root;
    return { delta: normCdf(d1), vega: S * normPdf(d1) * Math.sqrt(T) };
  }

  /* Chain snapshot -> level geometry (pure; row keys match /api/option_chain). */
  function levelData(records, spot, opts) {
    opts = opts || {};
    const clusterPct = opts.clusterPct != null ? opts.clusterPct : 0.004; /* merge walls within ±0.4% */
    const oiThreshPct = opts.oiThreshPct != null ? opts.oiThreshPct : 0.05; /* wall min = 5% of side OI */
    const res = {
      rows: 0, pcr: null, pcrChg: null, totalCeOi: 0, totalPeOi: 0,
      totalCeChg: 0, totalPeChg: 0, maxPain: null, walls: [], atm: null,
      expMove: null, expHi: null, expLo: null, iv: null, spot: spot || null,
      delta: null, vega: null,
      error: null
    };
    if (!records || !records.length) return res;
    const fin = x => { const v = parseFloat(x); return isFinite(v) ? v : 0; };
    const list = [];
    let ceOi = 0, peOi = 0, ceChg = 0, peChg = 0;
    let ivSum = 0, ivN = 0, atmDist = Infinity, atmRow = null;
    for (const r of records) {
      const s = fin(r.Strike != null ? r.Strike : r.strike);
      if (!(s > 0)) continue;
      const cOi = Math.max(0, fin(r['CE OI'] != null ? r['CE OI'] : r.ceOi));
      const pOi = Math.max(0, fin(r['PE OI'] != null ? r['PE OI'] : r.peOi));
      const cChg = fin(r['CE Chg OI'] != null ? r['CE Chg OI'] : r.ceChgOi);
      const pChg = fin(r['PE Chg OI'] != null ? r['PE Chg OI'] : r.peChgOi);
      const row = {
        strike: s, ceOi: cOi, peOi: pOi, ceChg: cChg, peChg: pChg,
        ceVol: fin(r['CE Volume'] != null ? r['CE Volume'] : r.ceVolume),
        peVol: fin(r['PE Volume'] != null ? r['PE Volume'] : r.peVolume),
        ceLtp: fin(r['CE LTP'] != null ? r['CE LTP'] : r.ceLtp),
        peLtp: fin(r['PE LTP'] != null ? r['PE LTP'] : r.peLtp),
        ceIv: fin(r['CE IV'] != null ? r['CE IV'] : r.ceIv),
        peIv: fin(r['PE IV'] != null ? r['PE IV'] : r.peIv),
        ceSid: r['CE SID'] != null ? r['CE SID'] : r.ceSid,
        peSid: r['PE SID'] != null ? r['PE SID'] : r.peSid
      };
      list.push(row);
      ceOi += cOi; peOi += pOi; ceChg += cChg; peChg += pChg;
      if (spot > 0) {
        const d = Math.abs(s - spot);
        if (d < atmDist) { atmDist = d; atmRow = row; }
        const a = fin(r['CE IV']), b = fin(r['PE IV']);
        if (a > 0 && b > 0) { ivSum += (a + b) / 2; ivN++; }
      }
    }
    res.rows = list.length;
    res.totalCeOi = ceOi; res.totalPeOi = peOi;
    res.totalCeChg = ceChg; res.totalPeChg = peChg;
    res.pcr = ceOi > 0 ? peOi / ceOi : null;
    /* Change-in-OI ratio. A pure put build with zero call change would divide
       by zero - clamp to a large finite sentinel so display and the pcrDir
       lean in contextOf() never see Infinity. */
    res.pcrChg = (ceChg !== 0) ? peChg / ceChg : ((peChg !== 0) ? (peChg > 0 ? 99 : -99) : null);
    if (spot > 0 && atmRow) {
      res.atm = atmRow;
      res.iv = ivN ? ivSum / ivN : (atmRow.ceIv + atmRow.peIv) / 2 || null;
      const dte = opts.dteDays != null ? opts.dteDays : 7;
      let move = null;
      if (res.iv) {
        move = spot * (res.iv / 100) * Math.sqrt(Math.max(dte, 0.5) / 365);
        const g = atmGreeks(spot, atmRow.strike, res.iv, dte);
        if (g) { res.delta = g.delta; res.vega = g.vega; }
      }
      if (!(move > 0)) {
        const st = (atmRow.ceLtp || 0) + (atmRow.peLtp || 0);
        if (st > 0) move = st * 1.25;
      }
      if (move > 0) {
        res.expMove = move;
        res.expHi = spot + move;
        res.expLo = spot - move;
      }
    }
    /* Max pain over the chain: strike minimizing total ITM option payout. */
    if (spot > 0 && list.length) {
      let best = null, bestPain = Infinity;
      for (const cand of list) {
        if ((cand.ceOi + cand.peOi) <= 0) continue;
        let pain = 0;
        for (const r of list) {
          if (r.strike >= cand.strike) pain += r.ceOi * (r.strike - cand.strike);
          if (r.strike <= cand.strike) pain += r.peOi * (cand.strike - r.strike);
        }
        if (pain < bestPain) { bestPain = pain; best = cand; }
      }
      if (best) res.maxPain = best.strike;
    }
    /* Cluster CE walls above spot / PE walls below spot, return strongest. */
    if (spot > 0 && list.length) {
      const cluster = (rows) => {
        if (!rows.length) return [];
        rows.sort((a, b) => a.strike - b.strike);
        const groups = [];
        let cur = null;
        for (const r of rows) {
          if (!cur || r.strike > cur.lim) {
            cur = { rows: [], lim: r.strike * (1 + clusterPct), hi: r.strike, lo: r.strike };
            groups.push(cur);
          }
          cur.rows.push(r);
          cur.lim = r.strike * (1 + clusterPct);
          cur.hi = r.strike;
        }
        return groups.map(g => {
          const rows = g.rows;
          let oi = 0, chg = 0, vol = 0, wSum = 0, wOi = 0;
          for (const r of rows) { oi += r.oi; chg += r.chg; vol += r.vol; wOi += r.oi; wSum += r.oi * r.strike; }
          return { strike: wOi ? wSum / wOi : g.lo, lo: rows[0].strike, hi: rows[rows.length - 1].strike, oi, chg, vol, rows };
        }).sort((a, b) => b.oi - a.oi);
      };
      const cRows = list.filter(r => r.strike > spot && r.ceOi > 0).map(r => ({ strike: r.strike, oi: r.ceOi, chg: r.ceChg, vol: r.ceVol }));
      const pRows = list.filter(r => r.strike < spot && r.peOi > 0).map(r => ({ strike: r.strike, oi: r.peOi, chg: r.peChg, vol: r.peVol }));
      const tCe = ceOi || 1, tPe = peOi || 1;
      const walls = [];
      cluster(cRows).forEach(g => {
        if (g.oi >= tCe * oiThreshPct) walls.push({ kind: 'res', strike: Math.round(g.strike), oi: g.oi, chg: g.chg, vol: g.vol, fresh: g.chg > 0 });
      });
      cluster(pRows).forEach(g => {
        if (g.oi >= tPe * oiThreshPct) walls.push({ kind: 'sup', strike: Math.round(g.strike), oi: g.oi, chg: g.chg, vol: g.vol, fresh: g.chg > 0 });
      });
      walls.sort((a, b) => b.oi - a.oi);
      res.walls = walls.slice(0, (opts.maxWalls != null ? opts.maxWalls : 10));
    }
    /* PER-STRIKE CE/PE OI interplay right around the current price (both legs).
       The two decisive strikes are the strongest call wall just ABOVE spot
       (overhead supply that caps up-moves) and the strongest put wall just
       BELOW spot (underfoot support that cushions down-moves). Comparing them
       answers exactly "call OI high at a strike while put OI there is low/high
       and how it pushes the trend":
         resOverhead = ceOi / (ceOi+peOi) of those two near strikes (0..1, 1 =
                       calls dominate overhead -> caps bulls),
         supUnder    = peOi / (ceOi+peOi) (1 = puts dominate below -> aids bulls),
         netOi       = supUnder - resOverhead (-1..1, >0 bullish put build below),
         box         = min(resOverhead, supUnder) (high when BOTH legs are heavy
                       near spot -> the price is PINCHED between the camps). */
    if (spot > 0 && list.length) {
      const nearPct = opts.oiNearPct != null ? opts.oiNearPct : 0.006;
      const loB = spot * (1 - nearPct), hiB = spot * (1 + nearPct);
      let nearCe = { strike: 0, oi: 0, chg: 0 }, nearPe = { strike: 0, oi: 0, chg: 0 };
      let ceB = 0, peB = 0;
      for (const r of list) {
        if (r.strike > spot && r.strike <= hiB && r.ceOi > nearCe.oi) nearCe = { strike: r.strike, oi: r.ceOi, chg: r.ceChg };
        if (r.strike < spot && r.strike >= loB && r.peOi > nearPe.oi) nearPe = { strike: r.strike, oi: r.peOi, chg: r.peChg };
        if (r.strike >= loB && r.strike <= hiB) { ceB += r.ceOi; peB += r.peOi; }
      }
      const tot = nearCe.oi + nearPe.oi;
      const resOverhead = tot > 0 ? nearCe.oi / tot : 0;
      const supUnder = tot > 0 ? nearPe.oi / tot : 0;
      res.resOverhead = resOverhead;
      res.supUnder = supUnder;
      res.netOi = tot > 0 ? (nearPe.oi - nearCe.oi) / tot : 0;
      res.box = Math.min(resOverhead, supUnder);
      res.nearCe = nearCe.oi > 0 ? nearCe : null;
      res.nearPe = nearPe.oi > 0 ? nearPe : null;
      res.pcrBand = ceB > 0 ? peB / ceB : (peB > 0 ? 3 : null);
      res.ceOiBand = ceB; res.peOiBand = peB;
    }
    return res;
  }

  /* Records -> ascending active-strike rows for the ordered OI strip (pure).
     Rows with zero total OI are dropped; when a spot is known, far out-of-
     the-money strikes are filtered out so the strip window hugs the action. */
  function oiRows(records, spot, opts) {
    opts = opts || {};
    const rangePct = opts.rangePct != null ? opts.rangePct : 0.12;
    const out = [];
    if (!records || !records.length) return out;
    const fin = x => { const v = parseFloat(x); return isFinite(v) ? v : 0; };
    for (const r of records) {
      const s = fin(r.Strike != null ? r.Strike : r.strike);
      if (!(s > 0)) continue;
      if (spot > 0 && Math.abs(s - spot) / spot > rangePct) continue;
      const ceOi = Math.max(0, fin(r['CE OI'] != null ? r['CE OI'] : r.ceOi));
      const peOi = Math.max(0, fin(r['PE OI'] != null ? r['PE OI'] : r.peOi));
      if (ceOi + peOi <= 0) continue;
      out.push({
        strike: s,
        ceOi, peOi,
        ceChg: fin(r['CE Chg OI'] != null ? r['CE Chg OI'] : r.ceChgOi),
        peChg: fin(r['PE Chg OI'] != null ? r['PE Chg OI'] : r.peChgOi)
      });
    }
    out.sort((a, b) => a.strike - b.strike);
    return out;
  }

  /* EMA-like trend-state line from candles (pure).
     Regimes (with hysteresis): up / down / flat.
     Flat holds the line horizontal (plateau) at the transition point; trend
     phases let the line track the fast EMA. Returns per-bar data + regime map. */
  function regimeLine(candles, opts) {
    opts = opts || {};
    const fast = opts.fast || 9, slow = opts.slow || 21;
    const enterK = opts.enterK != null ? opts.enterK : 0.45;
    const exitK = opts.exitK != null ? opts.exitK : 0.12;
    const n = candles.length;
    const closes = new Array(n), vols = new Array(n);
    for (let i = 0; i < n; i++) { closes[i] = candles[i].close; vols[i] = candles[i].volume || 0; }
    const eF = emaArr(closes, fast), eS = emaArr(closes, slow);
    const atrs = atrArr(candles, 14);
    const volAvg = smaArr(vols, 20);
    const regs = new Array(n).fill('flat');
    let regime = 'flat';
    for (let i = 0; i < n; i++) {
      const at = atrs[i] || 0;
      if (at > 0) {
        const d = eF[i] - eS[i];
        if (regime === 'flat') { if (d > at * enterK) regime = 'up'; else if (d < -at * enterK) regime = 'down'; }
        else if (regime === 'up' && d < -at * exitK) regime = 'flat';
        else if (regime === 'down' && d > at * exitK) regime = 'flat';
      }
      regs[i] = regime;
    }
    const data = [];
    let state = 'flat', pivot = null;
    for (let i = 0; i < n; i++) {
      const r = regs[i];
      if (r !== 'flat' && state === 'flat') { state = r; pivot = null; }
      else if (r === 'flat' && state !== 'flat') { state = 'flat'; pivot = eF[i]; }
      let value;
      if (state === 'flat') {
        if (pivot == null) pivot = eF[i];
        value = pivot;
      } else {
        value = eF[i];
      }
      data.push({ time: candles[i].time, value: Math.round(value * 100) / 100 });
    }
    const li = n - 1;
    return {
      data,
      regs,
      last: {
        regime: regs[li], emaF: eF[li], emaS: eS[li], atr: atrs[li] || 0,
        vol: vols[li], volAvg: volAvg[li], close: closes[li]
      }
    };
  }

  /* Direction-aware Supertrend band array (pure). Returns per-bar
     {dir: 1|-1, band} where dir 1 = uptrend (band is the lower trail). */
  function stSeries(candles, period, factor) {
    const n = candles.length;
    const atrs = atrArr(candles, period);
    const out = new Array(n);
    const hl2 = new Array(n);
    for (let i = 0; i < n; i++) hl2[i] = (candles[i].high + candles[i].low) / 2;
    let prevF = null, prevFU = null, prevFD = null, dir = 1;
    for (let i = 0; i < n; i++) {
      const up = hl2[i] + factor * (atrs[i] || 0);
      const dn = hl2[i] - factor * (atrs[i] || 0);
      const fu = (prevFU == null) ? up : Math.min(up, prevFU);
      const fd = (prevFD == null) ? dn : Math.max(dn, prevFD);
      if (prevF == null) dir = 1;
      else if (candles[i].close > (prevFU == null ? up : prevFU)) dir = 1;
      else if (candles[i].close < (prevFD == null ? dn : prevFD)) dir = -1;
      const band = dir === 1 ? fd : fu;
      prevFU = fu; prevFD = fd; prevF = band;
      out[i] = { dir, band };
    }
    return out;
  }

  /* Volume trend over the most recent bars (pure): +1 rising / -1 falling /
     0 flat, computed from the growth of the trailing volume average vs a
     longer baseline window before it, plus a clamped linear slope so the
     magnitude is usable as a confirmation weight. */
  function volTrendOf(vols, cfg) {
    cfg = cfg || {};
    const win = cfg.volWin || 6;
    const n = vols.length;
    const dead = cfg.volDead != null ? cfg.volDead : 0.03;
    const scale = cfg.volScale != null ? cfg.volScale : 0.12;
    if (n < win * 5 + 2) return { dir: 0, slope: 0, rel: 0 };
    const segA = vols.slice(n - win, n);
    const segB = vols.slice(n - win * 4, n - win); /* longer baseline (4x window) */
    const avg = a => {
      let s = 0, c = 0;
      for (const v of a) { if (v > 0) { s += v; c++; } }
      return c ? s / c : 0;
    };
    const a = avg(segA), b = avg(segB);
    if (!(a > 0)) return { dir: 0, slope: 0, rel: 0 };
    const rel = (a - b) / a; /* >0 rising vs the longer baseline */
    const m = a || 1;
    let sxy = 0, sxx = 0, sy = 0;
    for (let i = 0; i < win; i++) {
      const x = i - (win - 1) / 2;
      const v = vols[n - win + i];
      sxy += x * v; sxx += x * x; sy += v;
    }
    const slope = sxx ? (sxy / sxx) / Math.max(m, 1e-9) : 0;
    const dir = rel > dead ? 1 : (rel < -dead ? -1 : 0);
    return { dir, slope, rel: Math.max(-1, Math.min(1, rel / scale)) };
  }

  /* Full trend-movement CONTEXT of the last candle: every price method the
     chart can compute is folded into one agreement score, then the volume
     trend and the chain PCR (level + change) are added, each with their own
     sign convention so a single weighted sum below decides direction. This is
     the "combine volume increasing/decreasing + PCR with all the other
     methods" calculation (no separate filter - it is internal to the trend
     state shown on the chart). */
  function contextOf(candles, level, cfg) {
    cfg = cfg || {};
    const n = candles.length;
    const li = n - 1;
    const spot = (level && level.spot) || candles[li].close || 0;
    const ctx = {
      spot, methods: [], agreement: 0, methodN: 0,
      vol: { dir: 0, slope: 0, rel: 0 },
      pcr: level && level.pcr != null ? level.pcr : null,
      pcrChg: level && level.pcrChg != null ? level.pcrChg : null,
      pcrDir: 0,      /* +1 = put-OI share FALLING (risk-on) - aids bulls */
      pcrLevel: 0,    /* +1 extreme-low(call-heavy), -1 extreme-high(put-heavy) */
      walls: (level && level.walls) || []
    };
    ctx.oi = (level && (level.netOi != null || level.box != null)) ? {
      res: level.resOverhead || 0,   /* call OI share overhead (caps up-moves) */
      sup: level.supUnder || 0,      /* put OI share underfoot (supports bulls) */
      net: level.netOi || 0,         /* sup - res */
      box: level.box || 0            /* min(res,sup): OI pinch both sides */
    } : null;
    if (n < 5) return ctx;
    const closes = new Array(n), vols = new Array(n), highs = new Array(n), lows = new Array(n);
    for (let i = 0; i < n; i++) { closes[i] = candles[i].close; highs[i] = candles[i].high; lows[i] = candles[i].low; vols[i] = candles[i].volume || 0; }
    const ema = {};
    [9, 21, 35, 50, 100, 200].forEach(len => {
      if (n >= len) ema[len] = emaArr(closes, len);
    });
    const have = len => ema[len] != null && li >= len - 1;
    /* Price methods: each one is +1 when the bullish level-relation holds,
       -1 when the bearish one holds, skipped when there are not enough bars. */
    const methods = [
      { ok: have(9) && have(21), bull: () => ema[9][li] > ema[21][li] },
      { ok: have(21) && have(35), bull: () => ema[21][li] > ema[35][li] },
      { ok: have(35) && have(50), bull: () => ema[35][li] > ema[50][li] },
      { ok: have(50) && have(100), bull: () => ema[50][li] > ema[100][li] },
      { ok: have(100) && have(200), bull: () => ema[100][li] > ema[200][li] },
      { ok: n >= 22, bull: () => candles[li].close > ema[21][li] }
    ];
    const st1 = n >= 22 ? stSeries(candles, 10, 1) : null;
    const st2 = n >= 22 ? stSeries(candles, 10, 2) : null;
    if (st1) methods.push({ ok: true, bull: () => st1[li].dir === 1 && candles[li].close >= st1[li].band });
    if (st2) methods.push({ ok: true, bull: () => st2[li].dir === 1 });
    let agg = 0, mN = 0;
    for (const m of methods) {
      if (!m.ok) continue;
      agg += m.bull() ? 1 : -1;
      mN++;
    }
    ctx.methodN = mN;
    ctx.methods = methods;
    ctx.agreement = mN ? agg / mN : 0;
    /* Volume: rising volume confirms whichever way price is already moving;
       falling volume (or drying up) pulls the trend score toward 0. */
    ctx.vol = volTrendOf(vols, cfg);
    /* PCR change: pcr = total PE OI / total CE OI. A RISING pcr means put OI
       is building faster than call OI -> defensive/put pressure (bearish
       momentum lean); a FALLING pcr means call OI is building faster -> risk-on
       (bullish lean). We encode pcrDir as +1 bullish. */
    if (ctx.pcr != null && ctx.pcr > 0 && ctx.pcrChg != null && isFinite(ctx.pcrChg)) {
      const rel = Math.abs(ctx.pcrChg / ctx.pcr);
      const dead = cfg.pcrDead != null ? cfg.pcrDead : 0.02;
      const mx = cfg.pcrScale != null ? cfg.pcrScale : 0.08;
      if (rel >= dead) ctx.pcrDir = -Math.max(-1, Math.min(1, (ctx.pcrChg / ctx.pcr) / mx));
    }
    /* PCR level extremes: <~0.75 the chain is call-heavy (heavy sellers above
       -> resistance, works against an up-trend when price is near the call
       walls) ; >~1.3 put-heavy (support below, works against a down-trend). */
    const pcrHi = cfg.pcrHi != null ? cfg.pcrHi : 1.3;
    const pcrLo = cfg.pcrLo != null ? cfg.pcrLo : 0.75;
    if (ctx.pcr != null) {
      ctx.pcrLevel = ctx.pcr <= pcrLo ? 1 : (ctx.pcr >= pcrHi ? -1 : 0);
    }
    return ctx;
  }

  /* Turn the regime + the combined trend-movement context into the arrow /
     label / color. Returns {kind:'continue'|'reversal'|'consolidation',
     arrow:'up'|'down'|null, label, color, wall, ctx}.
     A single weighted score fuses price-method agreement, volume trend, PCR
     and the PER-STRIKE CE/PE OI interplay around the current price (both
     legs), so volume increasing/decreasing + PCR + OI all take part in every
     trend state - never separate filters.

     Per-strike OI (ctx.oi): the strongest call wall just ABOVE spot
     (ctx.oi.res = overhead call supply that caps rallies) vs the strongest
     put wall just BELOW spot (ctx.oi.sup = underfoot put support).
       net = sup - res : <0 means call OI dominates at the strikes around the
             price (caps an up-trend / presses it down), >0 means put OI
             dominates (cushions a down-trend / lifts it up).
       box = min(res,sup) : high when BOTH legs have built heavy OI on both
             sides of the current price -> the move is PINCHED between them.
     Consolidation is therefore detected not only from the EMA9/21 price
     regime being flat but ALSO from this OI pinch (both camps heavy near the
     price). And a flat EMA regime with a strongly one-sided OI build becomes
     an OI-bias continue arrow (leading signal) instead of consolidation. */
  function classify(last, ctx, cfg) {
    cfg = cfg || {};
    const revColor = '#ff9100';
    const nearPct = cfg.nearPct != null ? cfg.nearPct : 0.006;
    if (!last || !ctx) return { kind: 'consolidation', arrow: null, label: 'Consolidation Liquidity Grabbing Phase', color: '#ffc107', ctx };
    const oi = ctx.oi || {};
    const net = oi.net || 0;       /* sup - res: <0 call-heavy overhead, >0 put-heavy below */
    const box = oi.box || 0;       /* min(res,sup): both OI camps heavy near spot => squeeze */
    const boxFloor = cfg.oiBoxFloor != null ? cfg.oiBoxFloor : 0.30;
    const balMax = cfg.oiBalMax != null ? cfg.oiBalMax : 0.45;
    const consScoreT = cfg.consScoreT != null ? cfg.consScoreT : 0.22;
    const breakTh = cfg.oiBreakTh != null ? cfg.oiBreakTh : 0.5;
    const squeeze = box >= boxFloor && Math.abs(net) <= balMax;
    const plainCons = { kind: 'consolidation', arrow: null, label: 'Consolidation Liquidity Grabbing Phase', color: '#ffc107', ctx, net, box };
    const pinCons = { kind: 'consolidation', arrow: null, label: 'Consolidation · OI squeeze (CE & PE walls both sides)', color: '#ffc107', ctx, net, box };
    const bias = (dir) => {
      const upB = dir === 'up';
      return {
        kind: 'continue', arrow: dir,
        label: upB ? 'OI Bias UP (put OI heavy below)' : 'OI Bias DOWN (call OI heavy above)',
        color: upB ? '#26c6da' : '#ff7043',
        strength: 'weak', preview: true, net, box, ctx
      };
    };
    /* EMA regime FLAT: consolidation UNLESS the per-strike OI build is strongly
       one-sided (net passes the break threshold on either side -> an OI-bias
       leading arrow) or both camps are balanced-heavy (OI pinch -> still
       consolidation, that is the squeeze the phase name is about). */
    if (last.regime === 'flat') {
      if (!squeeze && net >= breakTh) return bias('up');
      if (!squeeze && net <= -breakTh) return bias('down');
      return squeeze ? pinCons : plainCons;
    }
    const up = last.regime === 'up';
    const regSign = up ? 1 : -1;
    /* Weights of the fused components (always add to 1). */
    const wAgr = cfg.wAgr != null ? cfg.wAgr : 0.40;  /* all price methods (EMA ladder, supertrend, close vs EMA) */
    const wVol = cfg.wVol != null ? cfg.wVol : 0.25;  /* volume increasing / decreasing */
    const wPcr = cfg.wPcr != null ? cfg.wPcr : 0.20;  /* PCR level change + call/put-wall lean */
    const wOi = cfg.wOi != null ? cfg.wOi : 0.15;     /* per-strike CE vs PE OI at the current price */
    const spot = ctx.spot || last.close || 0;
    /* Combined trend score in [-1,1]; positive always means "supports the
       current regime direction", negative means it is being fought. */
    const agr = (ctx.agreement || 0) * regSign;
    const v = ctx.vol;
    const vol = ((v && v.dir) || 0) * regSign;          /* + rising vol along the trend */
    let pcr = 0;
    if (ctx.pcrDir != null) pcr += ctx.pcrDir * regSign;   /* put/call flow along the trend */
    if (ctx.pcrLevel != null) {
      /* call-heavy (pcrLevel +1) caps an up-trend at the call wall only; we
         add it to the wall check below, not to the running score, so a plain
         low pcr mid-range does not veto the move. */
    }
    const oiDir = net * regSign;   /* net<0 + up-regime = the call wall overhead is capping the rally */
    const score = wAgr * agr + wVol * vol + wPcr * pcr + wOi * oiDir;
    const strongT = cfg.strongT != null ? cfg.strongT : 0.18;
    const weakT = cfg.weakT != null ? cfg.weakT : -0.15;
    const strong = score >= strongT;
    const weak = score <= weakT;
    const dirColor = up ? '#00e676' : '#ff5252';
    const dimColor = up ? 'rgba(0,230,118,0.55)' : 'rgba(255,82,82,0.55)';
    /* Reversal: the regime is still trending but the OI/volume/price context
       near the strike wall disagrees hard enough to warn of a flip BEFORE the
       candle closes. Wall side: up-trend meets a fresh/heavy CE (call) wall;
       down-trend meets a fresh/heavy PE (put) wall. */
    let reversal = null;
    if (spot > 0 && ctx.walls && ctx.walls.length) {
      const side = up ? 'res' : 'sup';
      const hit = ctx.walls
        .filter(w => w.kind === side && (up ? w.strike > spot : w.strike < spot))
        .find(w => Math.abs(w.strike - spot) / spot <= nearPct * 2.5);
      if (hit) {
        const wallArg = hit.chg > 0;                       /* fresh OI building AT the wall */
        const extreme = up ? ctx.pcrLevel === 1 : ctx.pcrLevel === -1; /* call-heavy above / put-heavy below */
        if (wallArg || extreme || score <= weakT || (up ? ctx.pcrDir < -0.4 : ctx.pcrDir > 0.4)) {
          const strikeTxt = Math.round(hit.strike * 100) / 100;
          reversal = { kind: 'reversal', arrow: up ? 'down' : 'up', label: 'Reversal @ ' + strikeTxt, color: revColor, wall: hit, ctx };
        }
      }
    }
    if (reversal) return reversal;
    /* OI pinch: the price is parked between heavy call OI above AND heavy put
       OI below (both legs built near spot) and the fused score has no
       directional conviction -> consolidation even if the short EMA still
       leans one way. This is the OI-based consolidation detection. */
    if (squeeze && Math.abs(score) < consScoreT) return pinCons;
    const label = strong ? 'Trend Continue' : (weak ? 'Trend Continue (weak)' : 'Trend Continue');
    return {
      kind: 'continue', arrow: up ? 'up' : 'down', label,
      color: strong ? dirColor : (weak ? 'rgba(255,255,255,0.35)' : dimColor),
      strength: strong ? 'strong' : (weak ? 'weak' : 'normal'),
      score, agr, vol, pcr, oiDir, net, box, ctx
    };
  }

  const Pure = { emaArr, smaArr, atrArr, stSeries, volTrendOf, contextOf, levelData, oiRows, regimeLine, classify };

  /* Register the OI Trend direction line as an evaluable indicator (id
     'oitrend') on the shared IndChart.IND registry. Its compute reuses
     regimeLine() - the exact series the OI Trend overlay draws - so the AST /
     AE engines can gate entries on the SAME line the user sees on the
     candlestick chart: bullish when the OI Trend line is increasing upward,
     bearish when it is increasing downward. Registering on the IND map (not
     the IND_LIST menu) keeps the standalone OI Trend toggle the only visual
     path, while the engine filter evaluation resolves it identically. */
  function registerOitInd() {
    try {
      const ind = IC() && IC().IND;
      if (!ind || ind.oitrend) return;
      ind.oitrend = {
        id: 'oitrend', name: 'OI Trend', fullName: 'OI Trend direction line', cat: 'OI', type: 'overlay',
        inputs: [
          { key: 'fast', label: 'Fast EMA length', def: 9, min: 1, max: 100, step: 1 },
          { key: 'slow', label: 'Slow EMA length', def: 21, min: 2, max: 200, step: 1 },
          { key: 'enterK', label: 'Enter ATR mult', def: 0.45, min: 0.05, max: 2, step: 0.05 },
          { key: 'exitK', label: 'Exit ATR mult', def: 0.12, min: 0.02, max: 1, step: 0.02 }
        ],
        style: [
          { key: 'color', label: 'Color', def: '#26c6da' },
          { key: 'lineWidth', label: 'Line width', def: 2, min: 1, max: 5, step: 1 }
        ],
        compute(c, o) {
          const R = regimeLine(c, o || {});
          return [{ type: 'line', color: (o && o.color) || '#26c6da', lineWidth: (o && o.lineWidth) || 2, data: R.data }];
        }
      };
    } catch (e) {}
  }
  registerOitInd();

  /* ------------------------- runtime glue ------------------------------- */
  const CFG = {
    refreshMs: 60000,        /* auto chain refresh when healthy */
    maxWallsPerSide: 2,      /* strongest walls drawn per side */
    maxWallsAll: 8,
    backoffMs: [60000, 120000, 180000, 300000],
    expiresCacheMs: 300000
  };
  let enabled = false;
  try { enabled = localStorage.getItem(LS_KEY) === '1'; } catch (e) {}
  /* Set when a standalone PCR consumer (PCR EMA pane / OI Rails overlay) is on
     the chart. Those indicators need the live chain + snapshot even when the
     OI Trend direction overlay itself is switched off, so this keeps the chain
     fetch alive independently of the toolbar toggle. */
  let _wantData = false;
  let _under = null;          /* {ocId,ocExch,name,id,exch,inst} underlying context */
  let _chartKind = 'spot';    /* 'spot' | 'opt' */
  let _chain = null;          /* {ctxKey, records, expiry, spot, at} */
  let _chainFails = 0;
  let _chainCool = 0;         /* non-forced fetches pause while cooling down */
  let _chainBusy = false;     /* request in flight -> drop duplicate non-forced calls */
  let _chainSeq = 0;          /* discard stale responses after a symbol switch */
  let _refreshTimer = null;
  let _tickTimer = null;
  let _lastSig = null;        /* last candle signature drawn */
  let _lastLvlDraw = null;    /* last time OC level lines were (re)computed */
  let _lastState = null;
  let _lastLvl = null;        /* last levelData snapshot (PCR/walls) for the PCR indicators */
  const _pcrHist = [];        /* [{time, at, pcr, pcrChg, resWall, supWall, maxPain, expHi, expLo, spot}] */
  const PCR_HIST_MAX = 600;
  const PCR_LS = 'oitrend.pcrHist.v1';
  let _pcrHistKey = null;     /* under + expiry the in-memory history belongs to */
  let _pcrSaveT = null;
  let _pcrRepaintT = null;
  function pcrCtxKey() { return underKey() + '|' + (_chain && _chain.expiry ? _chain.expiry : ''); }
  function _loadPcrHist(ck) {
    try {
      const raw = localStorage.getItem(PCR_LS);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d && d.key === ck && Array.isArray(d.arr)) {
        for (let i = 0; i < d.arr.length; i++) { const r = d.arr[i]; if (r && r.time != null) _pcrHist.push(r); }
      }
    } catch (e) {}
  }
  function _savePcrHist() {
    try { if (_pcrHistKey) localStorage.setItem(PCR_LS, JSON.stringify({ key: _pcrHistKey, arr: _pcrHist })); } catch (e) {}
  }
  function _schedulePcrSave() { if (_pcrSaveT) return; _pcrSaveT = setTimeout(function () { _pcrSaveT = null; _savePcrHist(); }, 1500); }
  /* Coalesce nudges to the indicator engine: whenever the PCR snapshot series
     changes, the standalone PCR EMA / OI Rails series must be recomputed. The
     candle series does not change on a closed market, so without this the lines
     stayed blank after being added until the next bar. */
  function _schedulePcrRepaint() {
    if (_pcrRepaintT) return;
    _pcrRepaintT = setTimeout(function () {
      _pcrRepaintT = null;
      try { if (IC() && IC().repaint) IC().repaint(); } catch (e) {}
    }, 250);
  }
  /* Drop the tracking series when the chain context changes (symbol or expiry)
     so the PCR indicators never carry a stale series into a new chart. History
     is persisted per context, so returning to the same symbol/expiry restores
     the PCR EMA instead of starting from a single dot after a reload. */
  function resetOiSeriesCaches() { _pcrHist.length = 0; _lastLvl = null; _pcrHistKey = null; _fallbackExpiry = null; }
  let _prevKind = null;
  let _legEl = null;          /* trend-state legend chip over the chart */

  function docEl(id) { try { return document.getElementById(id); } catch (e) { return null; } }
  let _fallbackExpiry = null;   /* nearest expiry resolved from /api/expiries when the dropdown is empty */
  let _expFallbackBusy = false;
  let _expFallbackCool = 0;
  function ocExpiry() {
    const el = docEl('ocExpirySelect');
    const v = el ? el.value : '';
    if (v && !/^(--|Loading)/.test(v)) return v;
    try { const s = JSON.parse(localStorage.getItem('nifty_deck_save') || 'null'); if (s && s.ocExpiry) return s.ocExpiry; } catch (e) {}
    return _fallbackExpiry;
  }
  /* The standalone PCR indicators may be used without ever opening the option
     chain panel, so the expiry dropdown can still be empty. Resolve the nearest
     expiry ourselves and retry the fetch. */
  function ensureFallbackExpiry() {
    if (_fallbackExpiry || _expFallbackBusy || !_under) return;
    if (Date.now() < _expFallbackCool) return;
    _expFallbackBusy = true;
    _expFallbackCool = Date.now() + 60000;
    fetch('/api/expiries', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        security_id: _under.ocId || _under.id,
        exchange_segment: _under.ocExch || (_under.inst === 'INDEX' ? 'IDX_I' : 'NSE_EQ'),
        symbol_name: _under.name
      })
    }).then(r => r.json()).then(d => {
      if (d && d.status === 'success' && Array.isArray(d.data) && d.data.length) {
        _fallbackExpiry = d.data[0];
        _expFallbackCool = 0;
        fetchChain(true);
      }
    }).catch(() => {}).finally(() => { _expFallbackBusy = false; });
  }
  function currentSpot() {
    try {
      const sym = gSelSymbol();
      const qm = gClientQuotes();
      if (qm && sym) {
        const key = sym.exch === 'IDX_I' ? 'IDX_I:' + sym.id : String(sym.id);
        const q = qm[key];
        if (q && q.ltp > 0) return q.ltp;
      }
    } catch (e) {}
    try {
      const cs = IC() && IC().getCandles ? IC().getCandles() : [];
      if (cs && cs.length && cs[cs.length - 1].close > 0) return cs[cs.length - 1].close;
    } catch (e) {}
    return null;
  }
  function syncToggleUI() {
    const el = docEl('oiTrendToggle');
    if (el && el.checked !== enabled) el.checked = enabled;
  }

  /* Cache-busting chain fetch that obeys the server's rate limits: full chain
     is expensive (~20s REST / 120s server cache), so we never hammer it. */
  function fetchChain(force) {
    if ((!enabled && !_wantData) || !_under) return;
    const now = Date.now();
    if (!force && _chainBusy) return;
    if (!force && now < _chainCool) return;
    if (!force && _chain && _chain.ctxKey === underKey() && (now - _chain.at) < CFG.refreshMs) return;
    const expiry = ocExpiry();
    if (!expiry) { ensureFallbackExpiry(); return; }
    const ctxKey = underKey() + '|' + expiry;
    if (_chain && _chain.ctxKey === ctxKey && !force && _chain.records) return;
    if (_chain && _chain.ctxKey !== ctxKey) resetOiSeriesCaches();
    const seq = ++_chainSeq;
    const spot = _chartKind === 'spot' ? currentSpot() : null;
    const body = {
      security_id: _under.ocId || _under.id,
      exchange_segment: _under.ocExch || (_under.inst === 'INDEX' ? 'IDX_I' : 'NSE_EQ'),
      expiry,
      symbol_name: _under.name,
      spot: spot || undefined
    };
    const done = () => { if (seq === _chainSeq) _chainBusy = false; };
    const doBackoff = () => {
      if (seq !== _chainSeq) { done(); return; }
      _chainFails++;
      const idx = Math.min(_chainFails - 1, CFG.backoffMs.length - 1);
      _chainCool = Date.now() + CFG.backoffMs[idx];
      _scheduleRefresh(CFG.backoffMs[idx]);
      done();
    };
    _chainBusy = true;
    fetch('/api/option_chain', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).then(r => r.json()).then(d => {
      if (seq !== _chainSeq) { done(); return; }
      if (d && d.status === 'success' && Array.isArray(d.data) && d.data.length) {
        _chain = { ctxKey, records: d.data, expiry, spot: d.spot_price || spot, at: Date.now() };
        _chainFails = 0;
        _scheduleRefresh(CFG.refreshMs);
        if (_chartKind === 'opt') drawStrip(); else drawLevels();
        /* Always snapshot the chain: standalone PCR EMA / OI Rails indicators
           need this history whether or not the OI Trend direction overlay is
           enabled (on an option chart drawDir() never runs at all). */
        recordSnapshotFromChain(spot);
      } else if (d && (d.status === 'loading' || d.status === 'partial')) {
        _scheduleRefresh(30000);
      } else {
        doBackoff();
      }
      done();
    }).catch(() => doBackoff());
  }
  function _scheduleRefresh(ms) {
    if (_refreshTimer) clearTimeout(_refreshTimer);
    _refreshTimer = setTimeout(() => { _refreshTimer = null; fetchChain(false); }, ms);
  }

  function underKey() {
    return _under ? (_under.ocId || _under.id) + '|' + (_under.ocExch || _under.exch) : '';
  }
  function syncUnder() {
    const sym = gSelSymbol();
    if (!sym) return;
    const isOpt = /^OPT/.test(sym.inst || '');
    _chartKind = isOpt ? 'opt' : 'spot';
    if (_prevKind !== null && _prevKind !== _chartKind) {
      _lastSig = null; _lastState = null; _lastLvlDraw = null;
    }
    _prevKind = _chartKind;
    if (isOpt) {
      /* A premium option chart anchors its chain through the option's own
         ocId/ocExch (the UNDERLYING SID the strike was opened from) - that way
         the chain cache is shared with the underlying view (identical key), so
         no duplicate Dhan /optionchain request fires when spot <-> option views
         of the same underlying are toggled. */
      const ocId = (sym.ocId != null && sym.ocId !== '' && String(sym.ocId) !== 'null') ? sym.ocId : null;
      const ocExch = sym.ocExch || sym.exch || 'NSE_FNO';
      if (ocId == null) { _under = null; _chain = null; resetOiSeriesCaches(); return; }
      const key = String(ocId) + '|' + ocExch;
      if (!_under || _under.key !== key) {
        _lastSig = null; _lastState = null; _lastLvlDraw = null;
        resetOiSeriesCaches();
        _under = {
          key, id: sym.id, exch: sym.exch, inst: sym.inst, name: sym.name,
          ocId, ocExch
        };
        _chain = null;
        fetchChain(true);
      }
      return;
    }
    const key = (sym.ocId || sym.id) + '|' + (sym.ocExch || sym.exch);
    if (!_under || _under.key !== key) {
      _lastSig = null; _lastState = null; _lastLvlDraw = null;
      resetOiSeriesCaches();
      _under = {
        key, id: sym.id, exch: sym.exch, inst: sym.inst, name: sym.name,
        ocId: sym.ocId, ocExch: sym.ocExch
      };
      _chain = null;
      drawLevels();
      fetchChain(true);
    }
  }

  function fmtOi(v) {
    if (v == null || isNaN(v)) return '--';
    const a = Math.abs(v);
    if (a >= 1e7) return (v / 1e7).toFixed(2) + 'Cr';
    if (a >= 1e5) return (v / 1e5).toFixed(2) + 'L';
    if (a >= 1e3) return (v / 1e3).toFixed(0) + 'K';
    return String(Math.round(v));
  }
  function strikeLabel(price) {
    if (price == null) return null;
    return (price >= 1000) ? String(Math.round(price)) : String(Math.round(price * 10) / 10);
  }

  /* Draw the OC level lines for the CURRENT (non-option) chart view.
     Throttled to ~1s (the PCR price-line tracks the live spot); the lines are
     re-drawn automatically from onTick(), so switching option-chart -> spot
     (which clears the registry via IndChart.setCandles) repaints within a
     second instead of waiting for the next 60s chain refresh. */
  function drawLevels() {
    const now = Date.now();
    if (_lastLvlDraw && (now - _lastLvlDraw) < 1000) return;
    _lastLvlDraw = now;
    if (!IC() || !IC().setOcLevelLines) return;
    if (!enabled || _chartKind !== 'spot') { IC().clearOcLevelLines(); return; }
    if (!_chain || !_chain.records) { IC().clearOcLevelLines(); return; }
    const spot = currentSpot() || _chain.spot;
    if (!(spot > 0)) { IC().clearOcLevelLines(); return; }
    const L = levelData(_chain.records, spot, {
      maxWalls: CFG.maxWallsAll, dteDays: dteFromExpiry(_chain.expiry)
    });
    if (!L || !L.walls.length && !L.expHi && !L.maxPain) { IC().clearOcLevelLines(); return; }
    const lines = {};
    const resW = L.walls.filter(w => w.kind === 'res').slice(0, CFG.maxWallsPerSide);
    const supW = L.walls.filter(w => w.kind === 'sup').slice(0, CFG.maxWallsPerSide);
    resW.forEach((w, i) => {
      const fresh = (w.chg > 0) ? ' ↑' : '';
      lines['res' + i] = {
        price: w.strike, title: 'RES ' + strikeLabel(w.strike) + ' | CE ' + fmtOi(w.oi) + fresh,
        color: '#ff5252', style: 2, lineWidth: w.fresh ? 2 : 1
      };
    });
    supW.forEach((w, i) => {
      const fresh = (w.chg > 0) ? ' ↑' : '';
      lines['sup' + i] = {
        price: w.strike, title: 'SUP ' + strikeLabel(w.strike) + ' | PE ' + fmtOi(w.oi) + fresh,
        color: '#00d4aa', style: 2, lineWidth: w.fresh ? 2 : 1
      };
    });
    if (L.maxPain) {
      lines.maxpain = { price: L.maxPain, title: 'MAX PAIN ' + strikeLabel(L.maxPain), color: '#b39ddb', style: 3, lineWidth: 1 };
    }
    if (L.expHi && L.expLo) {
      lines.exphi = { price: L.expHi, title: 'EXP MAX ' + strikeLabel(L.expHi) + ' (' + Math.round(L.expMove) + ')', color: '#4fc3f7', style: 2, lineWidth: 1 };
      lines.explo = { price: L.expLo, title: 'EXP MIN ' + strikeLabel(L.expLo), color: '#4fc3f7', style: 2, lineWidth: 1 };
    }
    if (L.pcr != null) {
      lines.pcr = {
        price: spot, title: 'PCR ' + L.pcr.toFixed(2) + (L.pcrChg != null ? ' (chg ' + (L.pcrChg < 0 ? '' : '+') + L.pcrChg.toFixed(2) + ')' : ''),
        color: 'rgba(255,255,255,0.6)', style: 1, lineWidth: 1
      };
    }
    IC().setOcLevelLines(lines);
  }
  function dteFromExpiry(expiry) {
    try {
      const ms = Date.parse(expiry + 'T00:00:00+05:30');
      if (isNaN(ms)) return 7;
      return Math.max(0.5, (ms - Date.now()) / 86400000);
    } catch (e) { return 7; }
  }

  /* Strongest CE/PE OI wall strike of a side (used by the PCR rails indicator). */
  function topWall(lvl, kind) {
    if (!lvl || !lvl.walls || !lvl.walls.length) return null;
    const w = lvl.walls.find(x => x.kind === kind);
    return w ? w.strike : null;
  }
  /* Keep a small time series of PCR / OI-wall snapshots so the standalone PCR
     indicator can plot a PCR EMA line and right-extended rails even though the
     chain itself is only refreshed periodically. One entry per candle time. */
  function recordPcrSnapshot(lvl, time) {
    if (!lvl) return;
    _lastLvl = lvl;
    /* Keep the standalone OI Rails fed even when PCR itself is missing or we
       have no candle time yet (fresh chart) — those indicators read _lastLvl. */
    if (lvl.pcr == null || time == null) { _schedulePcrRepaint(); return; }
    /* Adopt the persisted series the first time this chart context records a
       snapshot, so a reload resumes the same PCR history instead of a dot. */
    const ck = pcrCtxKey();
    if (ck !== _pcrHistKey) { _pcrHist.length = 0; _pcrHistKey = ck; _loadPcrHist(ck); }
    const rec = {
      time: time, at: Date.now(), pcr: lvl.pcr, pcrChg: lvl.pcrChg,
      resWall: topWall(lvl, 'res'), supWall: topWall(lvl, 'sup'),
      maxPain: lvl.maxPain != null ? lvl.maxPain : null,
      expHi: lvl.expHi != null ? lvl.expHi : null, expLo: lvl.expLo != null ? lvl.expLo : null,
      spot: lvl.spot != null ? lvl.spot : null
    };
    const last = _pcrHist[_pcrHist.length - 1];
    if (last && last.time === time) _pcrHist[_pcrHist.length - 1] = rec;
    else { _pcrHist.push(rec); if (_pcrHist.length > PCR_HIST_MAX) _pcrHist.splice(0, _pcrHist.length - PCR_HIST_MAX); }
    _schedulePcrSave();
    _schedulePcrRepaint();
  }

  /* Record a snapshot straight from the fetched chain. Used when the OI Trend
     direction overlay is off but a standalone PCR indicator still needs data
     (drawDir would otherwise be the only caller of recordPcrSnapshot). */
  function recordSnapshotFromChain(spot) {
    try {
      const cs = IC() ? IC().getCandles() : [];
      if (!cs || !cs.length) return;
      const lb = cs[cs.length - 1];
      /* On an option-premium chart the plotted candles are premiums, not the
         underlying, so take the spot from the chain response instead. The OI
         walls / PCR levels are all relative to the underlying. */
      const s = (_chartKind === 'opt')
        ? ((_chain && _chain.spot) || null)
        : (currentSpot() || (_chain && _chain.spot) || spot || (lb && lb.close));
      if (!(s > 0)) return;
      const lvl = levelData(_chain.records, s, { maxWalls: CFG.maxWallsAll, dteDays: dteFromExpiry(_chain.expiry) });
      recordPcrSnapshot(lvl, lb.time);
    } catch (e) {}
  }

  /* Recompute & repaint the EMA-like direction line + arrow markers. */
  function drawDir() {
    if (!IC() || !IC().setDirSeries || !IC().setDirMarkers) return;
    if (!enabled || _chartKind !== 'spot') return;
    const cs = IC() ? IC().getCandles() : [];
    if (!cs || cs.length < 40) return;
    const lb = cs[cs.length - 1];
    const sig = lb.time + '|' + lb.close + '|' + lb.volume + '|' + cs.length + '|' + (_chain ? _chain.at : 0) + '|' + (_chain && _chain.ctxKey ? _chain.ctxKey : '');
    if (_lastSig === sig && _lastState) { paintLast(_lastState); return; }
    _lastSig = sig;
    const R = regimeLine(cs, { fast: 9, slow: 21 });
    let lvl = null;
    if (_chain && _chain.records) {
      lvl = levelData(_chain.records, currentSpot() || _chain.spot || (cs[cs.length - 1] || {}).close, { maxWalls: CFG.maxWallsAll, dteDays: dteFromExpiry(_chain.expiry) });
    } else {
      lvl = { spot: currentSpot() || (cs[cs.length - 1] || {}).close, pcr: null, walls: [] };
    }
    recordPcrSnapshot(lvl, lb.time);
    const ctx = contextOf(cs, lvl, {});
    const st = classify(R.last, ctx, {});
    _lastState = { st, R };
    paintLast(_lastState);
  }
  function paintLast(s) {
    if (!s || !s.R) return;
    const st = s.st;
    const up = st.arrow === 'up';
    const data = s.R.data;
    const n = data.length;
    if (!n) return;
    /* Draw the trend-state line as straight intersecting segments (same regime
       values, only the drawn geometry is simplified). The regime array / engine
       reading is untouched, so strategy logic is unchanged. */
    let lineData = data;
    try {
      if (window.IndChart && typeof window.IndChart.straightenLine === 'function') {
        lineData = window.IndChart.straightenLine(data, 0.08);
      }
    } catch (e) { lineData = data; }
    IC().setDirSeries(lineData, { color: st.color, lineWidth: 2 });
    const li = n - 1;
    const t = data[li].time;
    const mk = [];
    const infoText = trendInfoText(st);
    if (st.kind === 'consolidation') {
      mk.push({ time: t, position: 'belowBar', shape: 'circle', color: st.color, text: '◀' });
      mk.push({ time: t, position: 'aboveBar', shape: 'circle', color: st.color, text: st.label || 'Consolidation Liquidity Grabbing Phase' + (infoText ? ' | ' + infoText : '') });
    } else {
      mk.push({
        time: t,
        position: up ? 'belowBar' : 'aboveBar',
        shape: up ? 'arrowUp' : 'arrowDown',
        color: st.color,
        text: st.label || (st.kind === 'reversal' ? 'Reversal Point' : (st.strength === 'weak' ? 'Trend Continue (weak)' : 'Trend Continue'))
      });
      if (infoText) {
        mk.push({
          time: t,
          position: up ? 'aboveBar' : 'belowBar',
          shape: 'circle',
          color: 'rgba(255,255,255,0.75)',
          text: infoText
        });
      }
    }
    /* flip markers on recent regime turns -> visible reversal history */
    try {
      const regs = s.R.regs, nR = regs.length;
      const curReg = regs[nR - 1];
      let back = 0;
      for (let i = nR - 1; i >= 0; i--) {
        if (regs[i] !== curReg) break;
        back++;
      }
      if (back >= 1 && back <= 8 && nR - 1 - back >= 0 && mk.length < 3) {
        const ft = data[nR - 1 - back].time;
        mk.push({
          time: ft,
          position: curReg === 'up' ? 'belowBar' : 'aboveBar',
          shape: curReg === 'up' ? 'arrowUp' : 'arrowDown',
          color: st.color,
          text: ''
        });
      }
    } catch (e) {}
    const setMk = (IC().setCandleMarkers || IC().setDirMarkers || null);
    if (setMk) { try { setMk.call(IC(), mk); } catch (e) {} }
  }
  /* Compact "why" line showing that volume up/down + PCR feed the state. */
  function trendInfoText(st) {
    try {
      const ctx = st.ctx;
      if (!ctx) return '';
      const parts = [];
      if (ctx.pcr != null) {
        let p = 'PCR ' + ctx.pcr.toFixed(2);
        if (ctx.pcrChg != null && isFinite(ctx.pcrChg)) p += ' chg ' + (ctx.pcrChg < 0 ? '' : '+') + ctx.pcrChg.toFixed(2);
        parts.push(p);
      }
      const vd = ctx.vol ? ctx.vol.dir : 0;
      parts.push('Vol ' + (vd > 0 ? 'rising' : (vd < 0 ? 'falling' : 'flat')));
      if (st.agr != null) parts.push('Price ' + (st.agr > 0 ? '+' : '') + st.agr.toFixed(2));
      if (st.score != null) parts.push('Score ' + (st.score > 0 ? '+' : '') + st.score.toFixed(2));
      const oi2 = ctx.oi;
      if (oi2 && (Math.abs(oi2.net || 0) >= 0.05 || (oi2.box || 0) >= 0.2)) {
        parts.push('OI sup ' + ((oi2.sup || 0) >= 0.99 ? '1' : (oi2.sup || 0).toFixed(2)) + '/res ' + ((oi2.res || 0) >= 0.99 ? '1' : (oi2.res || 0).toFixed(2)));
      }
      return parts.join(' | ');
    } catch (e) { return ''; }
  }

  /* ---- Always-visible trend-state legend (the arrow + the reversal / trend
     continue / consolidation TEXT that the user asked for). It is a DOM chip
     overlaid on the chart so it can never be hidden behind candles or clipped
     at the right edge like tiny series markers were. ---- */
  function ensureLegend() {
    if (_legEl && _legEl.isConnected) return _legEl;
    const cont = docEl('chart-container');
    if (!cont) return null;
    try {
      const el = document.createElement('div');
      el.id = 'oiTrendLegend';
      el.style.cssText = 'position:absolute;left:10px;top:8px;z-index:5;pointer-events:none;font:600 11px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:rgba(10,10,28,0.8);border:1px solid rgba(120,120,200,0.4);border-radius:6px;padding:4px 10px;color:#e0e0ff;white-space:nowrap;display:none;';
      cont.appendChild(el);
      _legEl = el;
      return el;
    } catch (e) { return null; }
  }
  function hideLegend() { if (_legEl) { try { _legEl.style.display = 'none'; } catch (e) {} } }
  function paintLegend(st) {
    const el = ensureLegend();
    if (!el) return;
    if (!enabled || _chartKind !== 'spot' || !st) { hideLegend(); return; }
    try {
      const ctx = st.ctx || {};
      let head;
      if (st.kind === 'consolidation') {
        head = '· ' + (st.label || 'CONSOLIDATION');
      } else if (st.kind === 'reversal') {
        head = (st.arrow === 'up' ? '↑' : '↓') + ' ' + (st.label || 'REVERSAL POINT (OI wall)');
      } else {
        const arrow = st.arrow === 'up' ? '↑' : '↓';
        head = arrow + ' ' + (st.arrow === 'up' ? 'UP' : 'DOWN') + ' · ' + st.label + (st.strength ? ' (' + st.strength + ')' : '');
      }
      const h = document.createElement('span');
      h.style.cssText = 'font-weight:700;color:' + (st.color || '#e0e0ff') + ';';
      h.appendChild(document.createTextNode(head));
      const parts = [];
      if (st.score != null) parts.push('Score ' + (st.score > 0 ? '+' : '') + st.score.toFixed(2));
      if (ctx.pcr != null) {
        let p = 'PCR ' + ctx.pcr.toFixed(2);
        if (ctx.pcrChg != null && isFinite(ctx.pcrChg)) p += ' (' + (ctx.pcrChg < 0 ? '' : '+') + ctx.pcrChg.toFixed(2) + ')';
        parts.push(p);
      }
      const vd = ctx.vol ? ctx.vol.dir : 0;
      parts.push('Vol ' + (vd > 0 ? 'rising' : (vd < 0 ? 'falling' : 'flat')));
      const oi2 = ctx.oi;
      if (oi2 && (Math.abs(oi2.net || 0) >= 0.05 || (oi2.box || 0) >= 0.2)) {
        parts.push('OI sup ' + ((oi2.sup || 0) >= 0.99 ? '1' : (oi2.sup || 0).toFixed(2)) + '/res ' + ((oi2.res || 0) >= 0.99 ? '1' : (oi2.res || 0).toFixed(2)));
      }
      el.innerHTML = '';
      el.appendChild(h);
      const s = document.createElement('span');
      s.style.cssText = 'color:#9fa8da;margin-left:10px;';
      s.appendChild(document.createTextNode(parts.join('  ·  ')));
      el.appendChild(s);
      el.style.display = 'block';
    } catch (e) { hideLegend(); }
  }

  /* ----- option-strike ordered OI strip (premium option charts only) -----
     When the chart is showing an option's own premium candles, the underlying
     levels can no longer sit on the price axis, so a slim strip under the chart
     repaints the chain as OI ORDERED BY STRIKE: CE OI extends left of the
     central axis, PE OI extends right, and the ACTUAL SPOT line is drawn
     horizontally between CE and PE at the strike where the market is. Max Pain,
     expected range, PCR and CE/PE totals ride along as chips. */
  let _stripEl = null, _stripCv = null, _stripHead = null;
  let _stripLast = 0, _stripW = 0, _wasOpt = false;

  function ensureStrip() {
    if (_stripEl && _stripEl.isConnected) return _stripEl;
    const host = docEl('oiStripHost');
    if (host) {
      _stripEl = host; _stripCv = docEl('oiStripCv'); _stripHead = docEl('oiStripHead');
      return host;
    }
    const cont = docEl('chart-container');
    const parent = cont && cont.parentNode;
    if (!parent) return null;
    const el = document.createElement('div');
    el.id = 'oiStripHost';
    el.style.cssText = 'display:none;border-top:1px solid #1e1e40;background:#0b0b1e;padding:4px 6px 2px;';
    const head = document.createElement('div');
    head.id = 'oiStripHead';
    head.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;font-size:10px;color:#9fa8da;align-items:center;line-height:1.4;padding:0 2px 4px;';
    const cv = document.createElement('canvas');
    cv.id = 'oiStripCv';
    cv.style.cssText = 'display:block;width:100%;height:96px;';
    el.appendChild(head);
    el.appendChild(cv);
    parent.insertBefore(el, cont.nextSibling);
    _stripEl = el; _stripCv = cv; _stripHead = head;
    return el;
  }
  function hideStrip() { if (_stripEl) _stripEl.style.display = 'none'; }
  function fmtNum(v) {
    if (v == null || isNaN(v)) return '--';
    if (Math.abs(v) >= 1000) return String(Math.round(v).toLocaleString('en-IN'));
    return String(Math.round(v * 100) / 100);
  }
  function chip(label, val, labelColor, boldColor) {
    const s = document.createElement('span');
    s.style.cssText = 'white-space:nowrap;';
    if (labelColor) s.style.color = labelColor;
    s.appendChild(document.createTextNode(label + ' '));
    const b = document.createElement('b');
    b.style.color = boldColor || labelColor || '#e0e0ff';
    b.appendChild(document.createTextNode(val == null || val === '' ? '--' : String(val)));
    s.appendChild(b);
    return s;
  }
  function stripStatusHead(text) {
    if (!_stripHead) return;
    _stripHead.innerHTML = '';
    _stripHead.appendChild(chip('OI', text, '#9fa8da', '#ffb74d'));
  }
  function drawStrip() {
    if (!enabled || _chartKind !== 'opt') { hideStrip(); return; }
    const ic = IC();
    if (!ic || !ic.hasChart || !ic.hasChart()) { hideStrip(); return; }
    const host = ensureStrip();
    const cv = _stripCv, head = _stripHead;
    if (!host || !cv || !head || !cv.getContext) { return; }
    const now = Date.now();
    const redraw = (now - _stripLast) >= 700;
    host.style.display = 'block';
    if (!_under || !_under.ocId) {
      stripStatusHead('open a CE/PE from the option chain to see OI ordered by strike');
      return;
    }
    /* Chain missing, empty, or for a stale expiry -> (re)load. */
    const wantKey = underKey() + '|' + (ocExpiry() || '');
    const staleKey = _chain && wantKey && _chain.ctxKey !== wantKey;
    if (!_chain || !_chain.records || !_chain.records.length || staleKey) {
      if (_chain && !staleKey && _chain.records && _chain.records.length) {
        stripStatusHead('OI chain returned no rows');
      } else {
        stripStatusHead(staleKey ? 'OI chain refreshing for expiry…' : 'loading OI chain…');
      }
      fetchChain(false);
      return;
    }
    const spot = _chain.spot > 0 ? _chain.spot : 0;
    const L = spot > 0 ? levelData(_chain.records, spot, {
      maxWalls: CFG.maxWallsAll, dteDays: dteFromExpiry(_chain.expiry)
    }) : null;
    const rows = oiRows(_chain.records, spot > 0 ? spot : null, { rangePct: 0.12 });
    if (!rows.length) { stripStatusHead('no active-OI strikes in range'); return; }
    if (redraw) {
      const totCe = rows.reduce((a, r) => a + r.ceOi, 0);
      const totPe = rows.reduce((a, r) => a + r.peOi, 0);
      head.innerHTML = '';
      head.appendChild(chip('SPOT', spot > 0 ? fmtNum(spot) : '--', '#ffffff', '#ffd54f'));
      if (L && L.maxPain) head.appendChild(chip('MAX PAIN', fmtNum(L.maxPain), '#b39ddb', '#b39ddb'));
      if (L && L.pcr != null) {
        let t = L.pcr.toFixed(2);
        if (L.pcrChg != null && isFinite(L.pcrChg)) t += ' chg ' + (L.pcrChg < 0 ? '' : '+') + L.pcrChg.toFixed(2);
        head.appendChild(chip('PCR', t, '#9fa8da', (L.pcr >= 1 ? '#00d4aa' : '#ff5252')));
      }
      if (L && L.expHi && L.expLo) head.appendChild(chip('EXP', fmtNum(L.expLo) + ' - ' + fmtNum(L.expHi), '#4fc3f7', '#4fc3f7'));
      head.appendChild(chip('CE OI', fmtOi(totCe), '#ff5252', '#ff8a80'));
      head.appendChild(chip('PE OI', fmtOi(totPe), '#00d4aa', '#80cbc4'));
    }
    if (!redraw && _stripW === cv.clientWidth) { return; }
    _stripW = cv.clientWidth;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(120, cv.clientWidth || host.clientWidth || 400);
    const h = Math.max(60, cv.clientHeight || 96);
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const plotL = 4, plotR = w - 4, plotT = 3, plotB = h - 5;
    const minS = rows[0].strike, maxS = rows[rows.length - 1].strike;
    const span = (maxS - minS) || 1;
    const yOf = s => plotB - ((s - minS) / span) * (plotB - plotT);
    const centerX = (plotL + plotR) / 2;
    const halfW = Math.max(8, Math.min(centerX - plotL, plotR - centerX) - 4);
    const barH = Math.max(1.2, Math.min(2.6, (plotB - plotT) / Math.max(1, rows.length) * 0.55));
    let maxOi = 1, hiCe = null, hiPe = null;
    for (const r of rows) {
      if (r.ceOi > maxOi) maxOi = r.ceOi;
      if (r.peOi > maxOi) maxOi = r.peOi;
      if (!hiCe || r.ceOi > hiCe.ceOi) hiCe = r;
      if (!hiPe || r.peOi > hiPe.peOi) hiPe = r;
    }
    g.strokeStyle = 'rgba(255,255,255,0.22)';
    g.lineWidth = 1;
    g.setLineDash([]);
    g.beginPath(); g.moveTo(Math.round(centerX) + 0.5, plotT); g.lineTo(Math.round(centerX) + 0.5, plotB); g.stroke();
    g.textAlign = 'left'; g.textBaseline = 'middle';
    g.font = '8px sans-serif';
    g.fillStyle = 'rgba(255,255,255,0.35)';
    g.fillText(strikeLabel(minS) || '', plotL, plotB);
    g.textAlign = 'right';
    g.fillText(strikeLabel(maxS) || '', plotR, plotT + 1);
    for (const r of rows) {
      const y = Math.round(yOf(r.strike));
      const cBar = Math.max(1.5, (r.ceOi / maxOi) * halfW);
      const pBar = Math.max(1.5, (r.peOi / maxOi) * halfW);
      g.fillStyle = (r === hiCe) ? 'rgba(255,138,128,0.95)' : 'rgba(255,82,82,0.7)';
      g.fillRect(centerX - cBar, y - barH / 2, cBar, barH);
      g.fillStyle = (r === hiPe) ? 'rgba(128,203,196,0.95)' : 'rgba(0,212,170,0.7)';
      g.fillRect(centerX, y - barH / 2, pBar, barH);
    }
    const dashLine = (y, color, dash, alpha) => {
      g.setLineDash(dash);
      g.strokeStyle = color;
      g.globalAlpha = alpha;
      g.beginPath(); g.moveTo(plotL, y); g.lineTo(plotR, y); g.stroke();
      g.setLineDash([]);
      g.globalAlpha = 1;
    };
    if (spot > 0 && spot >= minS && spot <= maxS) {
      const ys = Math.round(yOf(spot));
      dashLine(ys, '#ffd54f', [5, 4], 0.9);
      g.fillStyle = '#ffd54f';
      g.font = 'bold 9px sans-serif';
      g.textAlign = 'left'; g.textBaseline = 'bottom';
      g.fillText('SPOT ' + fmtNum(spot), plotL + 2, ys - 1);
    }
    if (L && L.maxPain && L.maxPain >= minS && L.maxPain <= maxS) {
      const ym = Math.round(yOf(L.maxPain));
      dashLine(ym, '#b39ddb', [2, 3], 0.7);
      g.font = '9px sans-serif';
      g.textAlign = 'right'; g.textBaseline = 'top';
      g.fillStyle = '#b39ddb';
      g.fillText('MP ' + fmtNum(L.maxPain), plotR - 2, ym + 1);
    }
    const selS = gSelSymbol() && gSelSymbol().strike != null ? parseFloat(gSelSymbol().strike) : NaN;
    if (isFinite(selS) && selS >= minS && selS <= maxS) {
      const ys2 = Math.round(yOf(selS));
      g.fillStyle = 'rgba(255,255,255,0.6)';
      g.fillRect(centerX - 0.5, ys2 - 3, 1, 6);
    }
    _stripLast = now;
  }

  /* tick(): called by the dashboard render loop on every live quote (~250ms).
     Kept extremely cheap: identical candle signature -> no recompute. */
  function onTick() {
    if ((!enabled && !_wantData) || !IC() || !IC().hasChart) return;
    if (!IC().hasChart()) return;
    syncUnder();
    syncToggleUI();
    /* Data-only mode: keep the chain fresh for the standalone PCR indicators,
       but skip every OI Trend overlay (arrows / level lines / strip / legend). */
    if (!enabled) { fetchChain(false); return; }
    if (_chartKind === 'opt') {
      if (!_wasOpt) {
        try { if (IC().clearDirOverlay) IC().clearDirOverlay(); if (IC().clearOcLevelLines) IC().clearOcLevelLines(); } catch (e) {}
      }
      _wasOpt = true;
      hideLegend();
      drawStrip();
      return;
    }
    if (_wasOpt) { try { if (IC().clearDirOverlay) IC().clearDirOverlay(); } catch (e) {} }
    _wasOpt = false;
    drawDir();
    drawLevels();
    paintLegend(_lastState ? _lastState.st : null);
  }
  function setEnabled(on) {
    enabled = !!on;
    try { localStorage.setItem(LS_KEY, enabled ? '1' : '0'); } catch (e) {}
    syncToggleUI();
    if (!enabled) {
      if (IC() && IC().clearDirOverlay) IC().clearDirOverlay();
      if (IC() && IC().clearOcLevelLines) IC().clearOcLevelLines();
      hideStrip();
      hideLegend();
      _lastSig = null;
      _lastState = null;
      return;
    }
    _chain = null;
    syncUnder();
    if (_chartKind === 'opt') { drawStrip(); } else { drawDir(); drawLevels(); }
    fetchChain(true);
  }

  /* heartbeat ticker (fallback when quotes are idle, e.g. market closed) */
  function startTicker() {
    if (_tickTimer) return;
    _tickTimer = setInterval(() => { if (enabled || _wantData) onTick(); }, 1000);
  }

  function bootstrap() {
    syncToggleUI();
    startTicker();
    fetchChain(true);
  }

  const OITrend = {
    Pure,
    bootstrap, onTick, setEnabled,
    setDirSeries: (d, o) => { const ic = IC(); if (ic && ic.setDirSeries) ic.setDirSeries(d, o); },
    refresh: () => fetchChain(true),
    /* Keep the live chain flowing while the standalone PCR indicators (PCR EMA
       pane / OI Rails overlay) are deployed, regardless of the OI Trend toggle.
       Called by the chart indicator engine on every (re)render. */
    setDataMode: (on) => {
      const want = !!on;
      if (want === _wantData) { if (want) fetchChain(false); return; }
      _wantData = want;
      if (!_wantData) return;
      syncUnder();
      fetchChain(true);
    },
    /* Snapshot + history for the standalone PCR indicators (PCR EMA pane and
       OI-wall rails overlay). Empty until a chain has been fetched. */
    snapshot: () => _lastLvl ? {
      pcr: _lastLvl.pcr, pcrChg: _lastLvl.pcrChg, spot: _lastLvl.spot,
      iv: _lastLvl.iv != null ? _lastLvl.iv : null,
      delta: _lastLvl.delta != null ? _lastLvl.delta : null,
      vega: _lastLvl.vega != null ? _lastLvl.vega : null,
      resWall: topWall(_lastLvl, 'res'), supWall: topWall(_lastLvl, 'sup'),
      maxPain: _lastLvl.maxPain != null ? _lastLvl.maxPain : null,
      expHi: _lastLvl.expHi != null ? _lastLvl.expHi : null, expLo: _lastLvl.expLo != null ? _lastLvl.expLo : null,
      at: Date.now()
    } : null,
    getPcrHist: () => _pcrHist.slice(),
    getState: () => ({ enabled, under: _under ? { key: _under.key, name: _under.name } : null, chain: _chain ? { expiry: _chain.expiry, rows: (_chain.records || []).length, spot: _chain.spot, at: _chain.at } : null })
  };
  G.OITrend = OITrend;
  /* Auto-boot once the DOM is ready (the checkbox lives in the chart toolbar):
     restores the persisted enable state, syncs the toggle UI and starts the
     1s heartbeat. Order-independent - it also works if the inline scripts that
     later connect to Dhan run before or after this file. */
  if (typeof document !== 'undefined') {
    const boot = function () { try { bootstrap(); } catch (e) {} };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else setTimeout(boot, 0);
  }
})();
