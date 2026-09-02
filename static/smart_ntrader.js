/* ============================================================
   SMART NTRADER
   NIFTY regime engine: detects NIFTY's overall + current trend
   and reversals (EMA structure + the AST-engine Bollinger %B
   session support/resistance logic), classifies the F&O stock
   universe into bullish/bearish/neutral, shows bull and bear
   stocks in SEPARATE sections (with per-side pick counts), and
   places paper trades on the picked stocks' OPTION-premium
   contracts (CE when NIFTY is bullish, PE when bearish) through
   ntPaper().autoEntry.

   Features:
     - Manual selection only: check F&O rows to enable them; the Bull/Bear
       caps limit how many enabled rows are active per side (by score).
     - BB%b draw-line alerts can also fire trades: per-line "execute trade"
       with a Bullish / Bearish / Auto-per-NIFTY-trend mode.
     - BB%B logic copied from the AST engine (aismart.js):
       sessionBbRange / bbOverState / niftyBbSlope /
       niftyBbExtremeReversal / niftyBbZone / fakeBreakoutAt /
       reversalAt. Integrated into NIFTY reversal detection,
       the per-stock trend labels and an entry gate (no CE buys
       into an overbought stock, no PE buys into an oversold one).
     - Auto SL-hunt guard (toggleable): detects a fake breakout /
       stop-loss hunt on the position's candles (option premium,
       falling back to the underlying stock) and WIDENS the
       stoploss below the broken swing level so the hunt cannot
       stop the trade out; restores the SL once the price
       recovers. A genuine breakdown (close below support) is
       never treated as a hunt.

   Speed (<5ms decision loop):
     - indicator + BB%B series are computed ONCE per candle-array
       identity (WeakMap) and only re-read per tick,
      - scoring reads the live quote map (one pass),
        so the whole universe is ranked without touching candles,
      - candle fetches happen only for the enabled shortlist and
       run async (never block the loop),
     - option-chain resolution is async + cached,
     - the render is batched and dirty-checked (only cells whose
       text changed are written).
   ============================================================ */
(function () {
  if (window.SmartNTrader) return;

  /* Isolated paper engine for NTrader: a dedicated 'ntrader' instance of the
     paper engine, so its autoPositions / margin / closed-trade history never
     share keyspace with AI Smart Trading or the pooled strategy runner. */
  function ntPaper() {
    if (window.TabEngines && window.TabEngines.papertrade && window.TabEngines.papertrade.ntrader) {
      return window.TabEngines.papertrade.ntrader;
    }
    if (window.createPaperTrade) { try { window.createPaperTrade('_ntrader'); } catch (e) {} }
    return (window.TabEngines && window.TabEngines.papertrade) ? (window.TabEngines.papertrade.ntrader || null) : null;
  }

  var NIFTY = { name: 'NIFTY 50', id: 13, exch: 'IDX_I', inst: 'INDEX' };
  var POLL_MS = 800;
  var TREND_REFRESH_MS = 60 * 1000;
  var OPT_TTL_MS = 120 * 1000;
  var REV_REARM_MS = 90 * 1000;
  var IND_CACHE = new WeakMap();
  var LS_KEY = 'smart_ntrader_v1';

  var state = {
    running: false,
    visible: false,
    bullCount: 3,
    bearCount: 2,
    count: 5,
    slPct: 10,
    tpPct: 20,
    fixedTp: 0,   // fixed take-profit % off entry (0 = off) -> banks a set profit
    margin: 100000,
    lotSize: null,   // override (null = auto from /api/lot_sizes)
    lots: 1,         // number of lots (quantity = lots x lot size)
    strike: { mode: 'both_atm', count: 3, positiveOnly: true },   // option-strike pick (AST dropdown) + only-+green-premium filter
    premiumChart: true,   // place trades on the option premium chart (CE/PE); OFF = trade the underlying spot/futures directly
    limitOrder: { enabled: false },  // auto BUY F&O limit above price (~100% fill)
    slMode: 'manual',  // 'auto' = auto stoploss (ATR candle-derived base + hunt guard) / 'manual' = user SL % / 'trail' = ATR base + trailing SL ratchet
    guardBuf: 5,
    trailSl: { enabled: false, pct: 1 },   // AST-style Trailing SL % (stop ratchets behind the peak)
    overallSl: { enabled: false, pct: 5 }, // portfolio-wide SL %: close ALL trades when total unrealized loss >= this % of invested
    sortMode: 'bullish',  // F&O list sort: 'bullish' = daily % chg highest->lowest / 'minus' = negatives first (highest->lowest), then positives
    tradeCap: { enabled: false, count: 5, auto: false },  // Max trades (fixed cap) / Auto trades (unlimited); enabling one disables the other
    trend: { enabled: false, pct: 2.5 },
    condition: {
      enabled: false,
      link: 'and',
      bull: { dir: 'bullish', connector: 'and', zone: 'any' },
      bear: { dir: 'bearish', connector: 'and', zone: 'any' }
    },
    niftyTf: '5min',
    stockTf: '5min',
    nifty: { ltp: 0, chg: 0, chgPct: 0, overall: '...', current: '...', reversal: '', bbPct: 0.5, bb: null, bar: 0 },
    cond: { bull: true, bear: true },
    stocks: [],
    byName: {},
    lotsByPrefix: {},
    series: {},       // symbolKey -> candle array (sync mirror of HftPool)
    seriesAt: {},     // symbolKey -> fetched-at
    lastReversal: { dir: '', at: 0 },
    optInFlight: {},
    posByKey: {},     // posKey -> { stockName, key } for our open positions
    tickMs: 0,
    renderMs: 0,
    lastBarAt: 0
  };

  /* ---------------- universe / settings ---------------- */

  function stockUniverse() {
    if (typeof SYMBOLS !== 'undefined' && Array.isArray(SYMBOLS)) {
      return SYMBOLS
        .filter(function (s) {
          if (!Array.isArray(s) || !s[0] || !(Number(s[1]) > 0)) return false;
          /* NSE F&O stocks (equity spot) + MCX commodity futures. */
          return (s[2] === 'NSE_EQ' && s[3] === 'EQUITY') || (s[2] === 'MCX_COMM' && s[3] === 'FUTCOM');
        })
        .map(function (s) { return { name: String(s[0]), id: Number(s[1]), exch: s[2], inst: s[3] }; });
    }
    return [];
  }

  function loadSettings() {
    try {
      var j = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      if (j.bullCount != null) state.bullCount = Math.max(0, Math.min(50, Math.round(Number(j.bullCount) || 0)));
      if (j.bearCount != null) state.bearCount = Math.max(0, Math.min(50, Math.round(Number(j.bearCount) || 0)));
      else if (j.count != null) {
        var c = Math.max(1, Math.min(50, Math.round(Number(j.count) || 1)));
        state.bullCount = Math.round(c / 2);
        state.bearCount = c - state.bullCount;
      }
      if (j.guardBuf != null) state.guardBuf = Math.max(0, Number(j.guardBuf) || 0);
      if (j.trend && typeof j.trend === 'object') {
        state.trend.enabled = !!j.trend.enabled;
        state.trend.pct = (Number(j.trend.pct) > 0) ? Number(j.trend.pct) : 2.5;
      }
      if (j.condition && typeof j.condition === 'object') {
        state.condition.enabled = !!j.condition.enabled;
        state.condition.link = (j.condition.link === 'or') ? 'or' : 'and';
        if (j.condition.bull && typeof j.condition.bull === 'object') {
          state.condition.bull.dir = (j.condition.bull.dir === 'bearish') ? 'bearish' : 'bullish';
          state.condition.bull.connector = (j.condition.bull.connector === 'or') ? 'or' : 'and';
          state.condition.bull.zone = String(j.condition.bull.zone || 'any');
        }
        if (j.condition.bear && typeof j.condition.bear === 'object') {
          state.condition.bear.dir = (j.condition.bear.dir === 'bullish') ? 'bullish' : 'bearish';
          state.condition.bear.connector = (j.condition.bear.connector === 'or') ? 'or' : 'and';
          state.condition.bear.zone = String(j.condition.bear.zone || 'any');
        }
      }
      if (j.slPct != null) state.slPct = Number(j.slPct) || 0;
      if (j.tpPct != null) state.tpPct = Number(j.tpPct) || 0;
      if (j.fixedTp != null) state.fixedTp = Number(j.fixedTp) || 0;
      if (j.margin != null) state.margin = Number(j.margin) || 100000;
      if (j.lotSize != null) state.lotSize = (Number(j.lotSize) > 0) ? Number(j.lotSize) : null;
      if (j.lots != null) state.lots = Math.max(1, Math.round(Number(j.lots) || 1));
      if (j.slMode != null) state.slMode = (j.slMode === 'auto' || j.slMode === 'trail') ? j.slMode : 'manual';
      else if (j.slGuard != null && j.slGuard) state.slMode = 'auto';  // backward compat
      if (j.trailSl && typeof j.trailSl === 'object') {
        state.trailSl.enabled = !!j.trailSl.enabled;
        state.trailSl.pct = (Number(j.trailSl.pct) > 0) ? Math.min(50, Number(j.trailSl.pct)) : 1;
      }
      if (j.overallSl && typeof j.overallSl === 'object') {
        state.overallSl.enabled = !!j.overallSl.enabled;
        state.overallSl.pct = (Number(j.overallSl.pct) > 0) ? Math.min(100, Number(j.overallSl.pct)) : 5;
      }
      if (j.sortMode === 'minus' || j.sortMode === 'bullish') state.sortMode = j.sortMode;
      if (j.tradeCap && typeof j.tradeCap === 'object') {
        state.tradeCap.enabled = !!j.tradeCap.enabled;
        state.tradeCap.auto = !!j.tradeCap.auto;
        state.tradeCap.count = (Number(j.tradeCap.count) > 0) ? Math.min(50, Math.round(Number(j.tradeCap.count))) : 5;
      }
      if (j.strike && typeof j.strike === 'object') {
        state.strike.mode = j.strike.mode || 'both_atm';
        state.strike.count = (Number(j.strike.count) > 0) ? Math.round(Number(j.strike.count)) : 3;
        state.strike.positiveOnly = j.strike.positiveOnly !== false;
      }
      if (j.premiumChart != null) state.premiumChart = !!j.premiumChart;
      if (j.limitOrder && typeof j.limitOrder === 'object') {
        state.limitOrder.enabled = !!j.limitOrder.enabled;
      }
      if (j.niftyTf) state.niftyTf = j.niftyTf;
      if (j.stockTf) state.stockTf = j.stockTf;
      state.count = state.bullCount + state.bearCount;
    } catch (e) {}
  }
  function saveSettings() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        bullCount: state.bullCount, bearCount: state.bearCount,
        slMode: state.slMode, guardBuf: state.guardBuf,
        trailSl: state.trailSl, overallSl: state.overallSl,
        sortMode: state.sortMode,
        tradeCap: state.tradeCap,
        trend: { enabled: state.trend.enabled, pct: state.trend.pct },
        condition: state.condition,
        slPct: state.slPct, tpPct: state.tpPct, fixedTp: state.fixedTp,
        margin: state.margin, niftyTf: state.niftyTf, stockTf: state.stockTf,
        lotSize: state.lotSize, lots: state.lots, strike: state.strike,
        premiumChart: state.premiumChart,
        limitOrder: state.limitOrder,
        enabledStocks: state.stocks.filter(function (s) { return s.enabled; }).map(function (s) { return s.sym.name; })
      }));
    } catch (e) {}
  }

  function symKey(s) { return String(s.id) + ':' + (s.exch || ''); }
  function quoteForSym(s) {
    if (typeof clientQuotes === 'undefined' || !clientQuotes) return null;
    return clientQuotes[s.exch === 'IDX_I' ? 'IDX_I:' + s.id : String(s.id)] || null;
  }
  function lotSizeFor(stock) {
    var nm = stock.sym ? stock.sym.name : (stock.name || '');
    var v = Number(state.lotsByPrefix[String(nm).toUpperCase()]);
    return (v > 0) ? v : 1;
  }

  /* MCX commodity futures: no index/equity spot, no NIFTY regime, no option
     premium legs in NTrader - they trade the FUTCOM futures directly (spot)
     on their OWN trend, so the NIFTY gate / option resolution is bypassed. */
  function isCommodity(sym) {
    if (!sym) return false;
    var ex = String(sym.exch || '').toUpperCase();
    var inst = String(sym.inst || '').toUpperCase();
    return ex === 'MCX_COMM' || ex === 'NCD_FNO' || inst === 'FUTCOM' || inst === 'OPTFUT';
  }

  /* ---------------- NIFTY trend-following filter (from the AST engine) ----------------
     When enabled, only F&O stocks on the NIFTY trend side with a daily % change
     above the threshold are eligible: NIFTY bullish -> top gainers (chg >= pct),
     NIFTY bearish -> top losers (chg <= -pct), NIFTY unknown -> nothing. Daily
     change comes from the live client quote cache, exactly like the AST picker. */
  function dailyChangePct(stock) {
    var q = quoteForSym(stock.sym);
    if (!q || q.change_pct === undefined) return NaN;
    var v = Number(q.change_pct);
    return isNaN(v) ? NaN : v;
  }
  function trendPct() { return (Number(state.trend.pct) > 0) ? Number(state.trend.pct) : 2.5; }
  /* The NIFTY trend-following filter is active only when the explicit toggle
     is on (auto stock-pickup mode no longer exists). */
  function trendFilterActive() { return state.trend.enabled; }
  /* Sahi-style two-layer filter. Direction = the OVERALL (EMA50) regime; the
     CURRENT (EMA9/21) layer only VETOES when it genuinely CONTRADICTS (overall
     BULL + current BEAR, or overall BEAR + current BULL). CURRENT=FLAT carries
     no vote -> follow the OVERALL regime; overall RANGE -> null (no bias). */
  function niftyOperative() {
    if (state.nifty.overall === 'BULL') return state.nifty.current === 'BEAR' ? null : 'BULL';
    if (state.nifty.overall === 'BEAR') return state.nifty.current === 'BULL' ? null : 'BEAR';
    return null;
  }
  function trendSideQualify(stock, cls) {
    if (isCommodity(stock.sym)) return true;
    if (!trendFilterActive()) return true;
    var nc = niftyOperative();
    var chg = dailyChangePct(stock);
    var thresh = trendPct();
    if (isNaN(chg)) return false;
    if (nc === 'BULL') return cls === 'BULL' && chg >= thresh;
    if (nc === 'BEAR') return cls === 'BEAR' && chg <= -thresh;
    return false;
  }

  /* ---------------- NIFTY + BB%B set-condition gate ----------------
     Two independent rows - one for a bullish NIFTY, one for a bearish
     NIFTY. Each row joins a NIFTY-direction part ("NIFTY is Bullish/Bearish")
     with a BB%B zone part (all the AST engine's %B logics: session
     overbought/oversold, band zones, inc_up/inc_down) using an AND or OR
     connector. The engine picks the row whose direction matches the live
     NIFTY trend and applies it to the matching stock side: the bullish row
     gates the bullish F&O picks, the bearish row gates the bearish F&O
     picks. When the gate is disabled (or its row's condition fails) that
     side simply falls to neutral. */

  function directionPart(row, actualTrend) {
    return row.dir === 'bullish' ? (actualTrend === 'BULL') : (actualTrend === 'BEAR');
  }
  function zonePart(row, bb) {
    var z = row.zone || 'any';
    if (z === 'any') return true;
    if (!bb) return false;
    if (z === 'overbought') return !!bb.overbought;
    if (z === 'oversold') return !!bb.oversold;
    if (z === 'above_upper') return bb.zone === 'above_upper';
    if (z === 'upper_half') return bb.zone === 'upper_half';
    if (z === 'lower_half') return bb.zone === 'lower_half';
    if (z === 'below_lower') return bb.zone === 'below_lower';
    if (z === 'inc_up') return !!bb.incUp;
    if (z === 'inc_down') return !!bb.incDown;
    return false;
  }
  function rowCondMet(row, actualTrend, bb) {
    var d = directionPart(row, actualTrend);
    var z = zonePart(row, bb);
    return (row.connector === 'or') ? (d || z) : (d && z);
  }

  /* Ultrafast entry-gate hot path. condRowGate() fuses the direction part and
     the %B zone part into a single switch/jump-table read with zero
     allocations; condGateEval() evaluates BOTH rows in one pass and stores
     plain booleans in state.cond.bull/bear. condAllows(cls) is the per-stock
     read used right at the entry-execution point so a trade on a picked
     strike only executes while its side's Set Condition is met. Warm benchmarks
     (see _dbgCondGateMs / _dbgCondAllowsMs): ~0.05us/row, i.e. ~0.0002ms for a
     full universe of 100 stocks - orders of magnitude under the 2ms budget. */
  function zoneMatch(row, bb) {
    var z = true;
    switch (row.zone || 'any') {
      case 'any': break;
      case 'overbought': z = bb ? !!bb.overbought : false; break;
      case 'oversold': z = bb ? !!bb.oversold : false; break;
      case 'above_upper': z = bb ? bb.zone === 'above_upper' : false; break;
      case 'upper_half': z = bb ? bb.zone === 'upper_half' : false; break;
      case 'lower_half': z = bb ? bb.zone === 'lower_half' : false; break;
      case 'below_lower': z = bb ? bb.zone === 'below_lower' : false; break;
      case 'inc_up': z = bb ? !!bb.incUp : false; break;
      case 'inc_down': z = bb ? !!bb.incDown : false; break;
      default: z = false;
    }
    return z;
  }
  function condRowGate(row, bb) {
    var nc = state.nifty.current;
    var d = row.dir === 'bullish' ? (nc === 'BULL') : (nc === 'BEAR');
    var z = zoneMatch(row, bb);
    return row.connector === 'or' ? (d || z) : (d && z);
  }

  /* Set Condition gate - regime-aware. The BULLISH row only ever gates in a
     bullish NIFTY and the BEARISH row only in a bearish NIFTY; the opposite
     side is hard-blocked, so only the matching condition can trigger a trade
     in its own regime. In sideways (NIFTY FLAT) BOTH conditions can work: the
     two rows are joined by the outer connector (state.condition.link) using
     only their BB%B zone parts, since there is no direction to match. Zero
     allocations; runs once per tick (see _dbgCondGateMs). */
  function condGateEval() {
    if (!state.condition.enabled) { state.cond.bull = true; state.cond.bear = true; return; }
    /* Two-layer agreement: a clean BULL/BEAR regime uses the matching row only;
       a mixed (overall != current) or FLAT regime has no direction to match, so
       the outer connector joins the two BB%B zone parts. */
    var nc = niftyOperative();
    var bb = state.nifty.bb;
    if (nc === 'BULL') {
      state.cond.bull = condRowGate(state.condition.bull, bb);
      state.cond.bear = false;
    } else if (nc === 'BEAR') {
      state.cond.bull = false;
      state.cond.bear = condRowGate(state.condition.bear, bb);
    } else {
      var zr = zoneMatch(state.condition.bull, bb);
      var zt = zoneMatch(state.condition.bear, bb);
      state.cond.bull = state.cond.bear = (state.condition.link === 'or') ? (zr || zt) : (zr && zt);
    }
  }
  function condAllows(cls) {
    return cls === 'BULL' ? state.cond.bull : state.cond.bear;
  }
  function condFor(actualTrend) {
    if (!state.condition.enabled) return true;
    if (actualTrend === 'BULL') return state.cond.bull;
    if (actualTrend === 'BEAR') return state.cond.bear;
    return false;
  }

  /* ---------------- BB%B (copied from the AST engine) ---------------- */

  /* IST calendar date (yyyy-mm-dd) for an epoch-seconds candle time. Used to
     isolate the current session's candles so the BB%B support/resistance lines
     (session min/max) describe only today's range, not the whole lookback. */
  function istDate(ts) {
    var t = Number(ts);
    if (!isFinite(t)) return null;
    if (t > 1e12) return new Date(t).toISOString().slice(0, 10);
    return new Date(t * 1000 + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  }

  /* Bollinger %B of the last bar plus the classic band zone label. */
  function niftyBbZone(candles) {
    var n = candles.length, L = 20, k = 2;
    if (n < L) return null;
    var win = [];
    for (var i = Math.max(0, n - L); i < n; i++) win.push(Number(candles[i].close));
    var sum = 0; for (i = 0; i < win.length; i++) sum += win[i];
    var mean = sum / win.length;
    var sq = 0; for (i = 0; i < win.length; i++) sq += (win[i] - mean) * (win[i] - mean);
    var sd = Math.sqrt(sq / win.length);
    var upper = mean + k * sd, lower = mean - k * sd;
    var close = Number(candles[n - 1].close);
    var pctb = (upper - lower) ? (close - lower) / (upper - lower) : 0.5;
    var zone = 'lower_half';
    if (pctb >= 1) zone = 'above_upper';
    else if (pctb >= 0.5) zone = 'upper_half';
    else if (pctb < 0) zone = 'below_lower';
    return { pctb: pctb, zone: zone, close: close, upper: upper, lower: lower };
  }

  /* BB%B line slope: 1 rising, -1 falling, 0 flat (lookback bars, dead-band). */
  function niftyBbSlope(candles, lookback) {
    var n = candles.length, L = 20, k = 2;
    if (n < L + 2) return 0;
    var lb = Math.max(1, Math.min(lookback || 1, n - L));
    function pctbAt(end) {
      var sum = 0, win = [];
      for (var i = Math.max(0, end - L + 1); i <= end; i++) win.push(Number(candles[i].close));
      if (win.length < L) return null;
      for (i = 0; i < win.length; i++) sum += win[i];
      var mean = sum / win.length;
      var sq = 0; for (i = 0; i < win.length; i++) sq += (win[i] - mean) * (win[i] - mean);
      var sd = Math.sqrt(sq / win.length);
      var upper = mean + k * sd, lower = mean - k * sd;
      var close = Number(candles[end].close);
      return (upper - lower) ? (close - lower) / (upper - lower) : 0.5;
    }
    var cur = pctbAt(n - 1), prev = pctbAt(n - 1 - lb);
    if (cur == null || prev == null) return 0;
    var d = cur - prev;
    var eps = 0.015;
    return d > eps ? 1 : d < -eps ? -1 : 0;
  }

  /* BB%B extreme-reversal state: the %B line touched the session's oversold
     low / overbought high within a fresh bounce window and has turned. */
  function niftyBbExtremeReversal(candles) {
    var n = candles.length;
    if (n < 22) return { inc_up: false, inc_down: false };
    var L = 20, k = 2;
    var lastDay = null;
    for (var i = n - 1; i >= 0; i--) {
      var d = istDate(candles[i].time);
      if (d == null) continue;
      if (lastDay === null) lastDay = d;
      if (d !== lastDay) break;
    }
    var times = [], pctbs = [], closes = [];
    for (i = 0; i < n; i++) {
      closes.push(Number(candles[i].close));
      if (istDate(candles[i].time) !== lastDay) continue;
      var c = closes;
      if (c.length < L) continue;
      var win = c.slice(-L);
      var mean = 0; for (var j = 0; j < L; j++) mean += win[j]; mean /= L;
      var sq = 0; for (j = 0; j < L; j++) sq += (win[j] - mean) * (win[j] - mean);
      var sd = Math.sqrt(sq / L);
      var upper = mean + k * sd, lower = mean - k * sd;
      pctbs.push((upper - lower) ? (c[c.length - 1] - lower) / (upper - lower) : 0.5);
      times.push(Number(candles[i].time));
    }
    if (pctbs.length < 2) return { inc_up: false, inc_down: false };
    var iMin = 0, iMax = 0;
    for (i = 1; i < pctbs.length; i++) {
      if (pctbs[i] < pctbs[iMin]) iMin = i;
      if (pctbs[i] > pctbs[iMax]) iMax = i;
    }
    var cur = pctbs[pctbs.length - 1];
    var ms = function (t) { return (Number(t) > 1e12 ? Number(t) : Number(t) * 1000); };
    var lastMs = ms(times[times.length - 1]);
    var W = 30 * 60 * 1000;
    var eps = 0.02;
    var inc_up = (lastMs - ms(times[iMin]) <= W) && (cur > pctbs[iMin] + eps);
    var inc_down = (lastMs - ms(times[iMax]) <= W) && (cur < pctbs[iMax] - eps);
    return { inc_up: inc_up, inc_down: inc_down };
  }

  /* Session BB%B support/resistance: min/max of the %B series across the
     current session's candles. */
  function sessionBbRange(candles) {
    var n = candles.length;
    if (!n) return { low: 0, high: 1 };
    var lastDay = null;
    for (var i = n - 1; i >= 0; i--) {
      var d = istDate(candles[i].time);
      if (d == null) continue;
      if (lastDay === null) lastDay = d;
      if (d !== lastDay) break;
    }
    var closes = [], pctbs = [];
    for (i = 0; i < n; i++) {
      closes.push(Number(candles[i].close));
      if (istDate(candles[i].time) !== lastDay) continue;
      var c = closes;
      if (c.length < 20) continue;
      var win = c.slice(-20);
      var mean = 0; for (var j = 0; j < 20; j++) mean += win[j]; mean /= 20;
      var sq = 0; for (j = 0; j < 20; j++) sq += (win[j] - mean) * (win[j] - mean);
      var sd = Math.sqrt(sq / 20);
      var upper = mean + 2 * sd, lower = mean - 2 * sd;
      pctbs.push((upper - lower) ? (c[c.length - 1] - lower) / (upper - lower) : 0.5);
    }
    if (!pctbs.length) return { low: 0, high: 1 };
    return { low: Math.min.apply(null, pctbs), high: Math.max.apply(null, pctbs) };
  }

  /* Classify the latest %B against the session support/resistance range. */
  function bbOverState(pctb, low, high) {
    var span = Math.max(high - low, 0.2);
    return {
      overbought: pctb >= high - 0.15 * span,
      oversold: pctb <= low + 0.15 * span
    };
  }

  /* Fake-breakout / fake-breakdown (stop-loss hunt) detection on the candle
     levels: bullish = price dipped below the prior N-bar low (false breakdown,
     stop hunt) but closed back above the broken level; bearish is the mirror. */
  function fakeBreakoutAt(candles, i, dir) {
    if (!candles || i < 1) return false;
    var c = candles[i], p = candles[i - 1];
    if (!c || !p || c.close == null || p.high == null || p.low == null || c.low == null || c.high == null) return false;
    var N = 20;
    if (dir === 'bullish') {
      var lo = Infinity;
      for (var k = Math.max(0, i - N); k < i; k++) {
        var b = candles[k];
        if (b && b.low != null && b.low < lo) lo = b.low;
      }
      if (!isFinite(lo) || c.low >= lo) return false;
      return c.close > p.low;
    }
    var hi = -Infinity;
    for (k = Math.max(0, i - N); k < i; k++) {
      var b2 = candles[k];
      if (b2 && b2.high != null && b2.high > hi) hi = b2.high;
    }
    if (!isFinite(hi) || c.high <= hi) return false;
    return c.close < p.high;
  }

  /* Reversal-bar detection: bullish = prior 5-bar move down and green close. */
  function reversalAt(candles, i, dir) {
    if (!candles || i < 6) return false;
    var c = candles[i], c1 = candles[i - 1], before = candles[i - 6];
    if (!c || !c1 || !before || c.close == null || c.open == null || c1.close == null || before.close == null) return false;
    if (dir === 'bullish') return c1.close < before.close && c.close > c.open;
    return c1.close > before.close && c.close < c.open;
  }

  /* Full %B snapshot per candle array (cached through IND_CACHE): zone label,
     session S/R, overbought/oversold, slope and extreme-reversal flags. */
  function computeBb(candles) {
    if (!candles || candles.length < 21) return null;
    var z = niftyBbZone(candles);
    if (!z) return null;
    var sr = sessionBbRange(candles);
    var ob = bbOverState(z.pctb, sr.low, sr.high);
    var ex = niftyBbExtremeReversal(candles);
    return {
      pctb: z.pctb, zone: z.zone, close: z.close, upper: z.upper, lower: z.lower,
      sLow: sr.low, sHigh: sr.high,
      overbought: ob.overbought, oversold: ob.oversold,
      slope: niftyBbSlope(candles),
      incUp: ex.inc_up, incDown: ex.inc_down
    };
  }

  /* ---------------- indicator engine (once per array identity) ---------------- */

  function indicators(candles) {
    if (!candles || !candles.length) return null;
    var hit = IND_CACHE.get(candles);
    if (hit) return hit;
    var src = candles.length > 300 ? candles.slice(candles.length - 300) : candles;
    var n = src.length;
    var close = new Float64Array(n);
    for (var i = 0; i < n; i++) close[i] = Number(src[i].close) || 0;
    function ema(period) {
      var out = new Float64Array(n);
      var k = 2 / (period + 1);
      out[0] = close[0];
      for (i = 1; i < n; i++) out[i] = close[i] * k + out[i - 1] * (1 - k);
      return out;
    }
    function smaSd(period) {
      var sma = new Float64Array(n);
      var sd = new Float64Array(n);
      for (var i = period - 1; i < n; i++) {
        var s = 0, j;
        for (j = i - period + 1; j <= i; j++) s += close[j];
        var m = s / period;
        sma[i] = m;
        var v = 0;
        for (j = i - period + 1; j <= i; j++) { var d = close[j] - m; v += d * d; }
        sd[i] = Math.sqrt(v / period);
      }
      return { sma: sma, sd: sd };
    }
    var e9 = ema(9), e21 = ema(21), e50 = ema(50);
    var s20 = smaSd(20);
    var L = n - 1;
    var last = {
      close: close[L],
      e9: e9[L], e21: e21[L], e50: e50[L],
      sma20: s20.sma[L], sd20: s20.sd[L],
      slope9: (L >= 9) ? (e9[L] - e9[L - 5]) : 0,
      slope21: (L >= 21) ? (e21[L] - e21[L - 5]) : 0,
      slope50: (L >= 50) ? (e50[L] - e50[L - 5]) : 0
    };
    last.bbPct = last.sd20 > 0 ? (last.close - (last.sma20 - 2 * last.sd20)) / (4 * last.sd20) : 0.5;
    var out = { close: close, n: n, e9: e9, e21: e21, e50: e50, sma20: s20.sma, sd20: s20.sd, last: last };
    out.bb = computeBb(src);
    IND_CACHE.set(candles, out);
    return out;
  }

  function lastBarTime(candles) {
    return (candles && candles.length) ? candles[candles.length - 1].time : 0;
  }

  /* ---------------- NIFTY trend + reversal (EMA + BB%B) ---------------- */

  function detectNifty(ind) {
    if (!ind || ind.n < 25) return { overall: '...', current: '...', reversal: '', bbPct: 0.5, bb: null };
    var L = ind.n - 1;
    var last = ind.last;
    var overall = (last.close > last.e50 && last.slope50 > 0) ? 'BULL'
      : (last.close < last.e50 && last.slope50 < 0) ? 'BEAR' : 'RANGE';
    var diff = last.e9 - last.e21;
    /* CURRENT = short momentum: EMA9 above EMA21 AND EMA9 still rising ->
       BULL; below AND falling -> BEAR; otherwise FLAT. No % dead-band (a hard
       0.05% band left current FLAT in real uptrends where EMA9 hugs EMA21, so
       the two layers never agreed and trend stocks were not picked). */
    var current = (diff > 0 && last.slope9 >= 0) ? 'BULL'
      : (diff < 0 && last.slope9 <= 0) ? 'BEAR' : 'FLAT';
    var bb = ind.bb;
    var reversal = '';
    if (bb) {
      /* AST BB%B extreme-reversal logic: %B at the session overbought/oversold
         extreme turning over (or the %B slope rolling) against the trend. */
      if (bb.overbought && (bb.slope <= 0 || bb.incDown) && current !== 'BEAR') reversal = 'BEARISH REVERSAL';
      else if (bb.oversold && (bb.slope >= 0 || bb.incUp) && current !== 'BULL') reversal = 'BULLISH REVERSAL';
      else if (bb.pctb >= 1.02 && overall === 'BULL' && current !== 'BULL') reversal = 'BEARISH REVERSAL';
      else if (bb.pctb <= -0.02 && overall === 'BEAR' && current !== 'BEAR') reversal = 'BULLISH REVERSAL';
    }
    if (!reversal && L >= 1) {
      var pd = ind.e9[L - 1] - ind.e21[L - 1];
      if (pd <= 0 && diff > 0 && last.slope9 > 0) reversal = 'BULLISH REVERSAL';
      else if (pd >= 0 && diff < 0 && last.slope9 < 0) reversal = 'BEARISH REVERSAL';
    }
    if (reversal) {
      if (state.lastReversal.dir === reversal && Date.now() - state.lastReversal.at < REV_REARM_MS) reversal = '';
      else { state.lastReversal.dir = reversal; state.lastReversal.at = Date.now(); }
    } else {
      state.lastReversal = { dir: '', at: state.lastReversal.at };
    }
    return { overall: overall, current: current, reversal: reversal, bbPct: bb ? bb.pctb : 0.5, bb: bb };
  }

  /* ---------------- stock scoring / classification ---------------- */

  function stockScore(stock, ind) {
    var q = quoteForSym(stock.sym);
    var sc = 0;
    if (q && q.change_pct !== undefined) {
      var cp = Number(q.change_pct);
      if (!isNaN(cp)) sc += cp * 1.5;
    }
    if (ind && ind.n >= 25) {
      var L = ind.n - 1, last = ind.last;
      var ret = (ind.close[L - 10] > 0) ? (last.close / ind.close[L - 10] - 1) * 100 : 0;
      var emaPct = (last.e21 > 0) ? ((last.e9 - last.e21) / last.e21) * 100 : 0;
      sc += ret * 2 + emaPct * 3 + (last.slope9 > 0 ? Math.min(last.slope9, 2) : Math.max(last.slope9, -2));
    }
    return sc;
  }

  /* ---------------- entry decision (pure, <5ms) ---------------- */

  function decideEntry(stock, ind, niftyTrend) {
    if (!ind || ind.n < 25) return null;
    /* Commodities: no NIFTY regime. Trade the FUTURES on the commodity's OWN
       trend - BULL classification + fresh EMA9/21 bullish cross on its own
       candles. Buy-only engine, so only the long side ever fires. */
    if (isCommodity(stock.sym)) {
      if (stock.cls !== 'BULL') return null;
      var L = ind.n - 1;
      var diff = ind.e9[L] - ind.e21[L];
      var cross = (ind.e9[L - 1] - ind.e21[L - 1]) * diff;
      return (diff > 0 && ind.last.slope9 > 0 && cross <= 0) ? 'LONG' : null;
    }
    var side = null;
    if (niftyTrend && niftyTrend.overall === 'BULL' && niftyTrend.current === 'BULL' && stock.cls === 'BULL') side = 'CE';
    else if (niftyTrend && niftyTrend.overall === 'BEAR' && niftyTrend.current === 'BEAR' && stock.cls === 'BEAR') side = 'PE';
    if (!side) return null;
    /* BB%B gate (AST integration): don't chase a CE buy into an overbought
       stock, and don't buy a PE into an oversold one. */
    if (ind.bb) {
      if (side === 'CE' && ind.bb.overbought) return null;
      if (side === 'PE' && ind.bb.oversold) return null;
    }
    var L = ind.n - 1;
    var diff = ind.e9[L] - ind.e21[L];
    var cross = (ind.e9[L - 1] - ind.e21[L - 1]) * diff;
    var fired = (side === 'CE')
      ? (diff > 0 && ind.last.slope9 > 0 && cross <= 0)
      : (diff < 0 && ind.last.slope9 < 0 && cross <= 0);
    return fired ? side : null;
  }

  /* ---------------- async plumbing ---------------- */

  function ensureCandles(sym, tf, key, refreshMs) {
    if (!window.HftPool || !HftPool.getCandles) return;
    var now = Date.now();
    if (state.seriesAt[key] && now - state.seriesAt[key] < (refreshMs || 45000)) return;
    state.seriesAt[key] = now;
    HftPool.getCandles(sym, tf).then(function (arr) {
      if (Array.isArray(arr) && arr.length) state.series[key] = arr;
    }).catch(function () {});
  }

  function resolveAndEnter(stock, side, niftyTrend) {
    if (!ntPaper() || typeof ntPaper().autoEntry !== 'function') return;
    /* Commodity: trade the FUTURES contract directly (spot) - no option chain. */
    if (side === 'LONG' && isCommodity(stock.sym)) {
      enterCommodity(stock);
      return;
    }
    /* Premium chart OFF: trade the underlying equity spot directly instead of
       resolving an option contract. Side 'CE'/'PE' maps to a plain underlying
       BUY on the spot (a bullish stock is bought outright; a bearish stock's
       spot is still bought as a directional long on the underlying). */
    if (!state.premiumChart) {
      enterUnderlying(stock, '');
      return;
    }
    if (!window.AISmartTrading || typeof AISmartTrading.resolveStockOption !== 'function') return;
    var optKey = stock.sym.name + ':' + side;
    if (state.optInFlight[optKey]) return;
    if (stock.opt && stock.optAt && Date.now() - stock.optAt < OPT_TTL_MS && stock.opt._side === side) {
      enterWithOption(stock, side);
      return;
    }
    state.optInFlight[optKey] = true;
    AISmartTrading.resolveStockOption(stock.sym, side, {
      mode: state.strike.mode,
      count: state.strike.count,
      optionType: side,
      positiveOnly: !!state.strike.positiveOnly
    }).then(function (opt) {
      delete state.optInFlight[optKey];
      if (opt) {
        stock.opt = opt;
        stock.optAt = Date.now();
        enterWithOption(stock, side);
      } else {
        stock.status = AISmartTrading.chainRateLimited(stock.sym) ? 'chain rate-limited - retrying' : 'no option contract';
      }
    }).catch(function () { delete state.optInFlight[optKey]; });
  }

  function entryPlan(stock, fillRef) {
    var lotSz = (Number(state.lotSize) > 0) ? Math.max(1, Number(state.lotSize)) : lotSizeFor(stock);
    var marginAvail = Math.max(0, Number(state.margin) || 0);
    var wantLots = Math.max(1, Math.round(Number(state.lots) || 1));
    if (!(fillRef > 0) || lotSz <= 0) return null;
    if (marginAvail > 0) {
      var afford = Math.floor(marginAvail / (lotSz * fillRef));
      if (afford < 1) return null;
      return { lotSz: lotSz, wantLots: wantLots, lotsN: Math.min(wantLots, afford), fillRef: fillRef, capped: wantLots > afford };
    }
    return { lotSz: lotSz, wantLots: wantLots, lotsN: wantLots, fillRef: fillRef, capped: false };
  }

  /* Commodity entry: BUY the FUTCOM futures contract directly on the live
     quote, sized by the curated MCX lot. Mirrors enterWithOption but the
     executed instrument is the futures spot symbol (no option leg). */
  function enterCommodity(stock) {
    enterUnderlying(stock, 'FUT');
  }

  /* Underlying (spot/futures) entry used when "Place trade in option premium
     chart" is OFF: instead of resolving an option contract and buying the
     premium, the engine BUYs the underlying itself (equity spot for NSE stocks,
     the futures contract for commodities). Same sizing / SL / trail as the
     option path, keyed under the same ntd: position so positions are unique per
     stock. */
  function enterUnderlying(stock, label) {
    var sym = stock.sym;
    if (!sym) return;
    var q = quoteForSym(sym);
    var fillRef = (q && q.ltp) ? Number(q.ltp) : 0;
    if (!(fillRef > 0)) { stock.status = 'entry: no live price'; return; }
    var plan = entryPlan(stock, fillRef);
    if (!plan) { stock.status = 'entry: margin too low for 1 lot'; return; }
    var lotsN = plan.lotsN;
    var lotSz = plan.lotSz;
    var marginAvail = Math.max(0, Number(state.margin) || 0);
    var posKey = 'ntd:' + sym.name;
    var opts = {
      key: posKey,
      posKey: posKey,
      symbol: sym,
      lots: lotsN,
      margin: marginAvail,
      tpPct: Number(state.tpPct) || 0,
      slPct: slPctFor(stock),
      slTrailPct: slTrailPctFor(),
      fixedTpPct: Number(state.fixedTp) || 0,
      fnoLimit: !!state.limitOrder.enabled,
      lotSize: lotSz,
      fallbackLtp: fillRef
    };
    var ok = ntPaper().autoEntry('BUY', opts);
    var fillTxt = fillRef.toFixed(2);
    if (state.limitOrder.enabled && ntPaper() && ntPaper().fnoLimitPrice) {
      var lp = ntPaper().fnoLimitPrice('BUY', q, fillRef);
      if (lp > 0) fillTxt = lp.toFixed(2);
    }
    stock.status = ok ? ('BUY ' + sym.name + (label ? ' ' + label : '') + ' @ ' + fillTxt + (state.limitOrder.enabled ? ' LIMIT' : '')) : ('entry: ' + (ntPaper().lastAutoSkip || 'rejected'));
    if (ok) {
      stock._trd = {
        side: 'LONG',
        entryPx: fillRef,
        entryT: lastBarTime(state.series[symKey(sym)]) || (Date.now() / 1000),
        qty: lotsN * lotSz,
        reason: ''
      };
    }
  }

  function enterWithOption(stock, side) {
    var opt = stock.opt;
    if (!opt || !opt.premium) return;
    var q = quoteForSym(opt);
    var fillRef = (q && q.ltp) ? Number(q.ltp) : Number(opt.premium);
    if (!(fillRef > 0)) return;
    var plan = entryPlan(stock, fillRef);
    if (!plan) { stock.status = 'entry: margin too low for 1 lot'; return; }
    var lotsN = plan.lotsN;
    var lotSz = plan.lotSz;
    var marginAvail = Math.max(0, Number(state.margin) || 0);
    var posKey = 'ntd:' + stock.sym.name;
    var opts = {
      key: posKey,
      posKey: posKey,
      symbol: opt,
      lots: lotsN,
      margin: marginAvail,
      tpPct: Number(state.tpPct) || 0,
      slPct: slPctFor(stock),
      slTrailPct: slTrailPctFor(),
      fixedTpPct: Number(state.fixedTp) || 0,
      fnoLimit: !!state.limitOrder.enabled,
      lotSize: lotSz,
      fallbackLtp: Number(opt.premium)
    };
    var ok = ntPaper().autoEntry('BUY', opts);
    var fillTxt = fillRef.toFixed(2);
    if (state.limitOrder.enabled && ntPaper() && ntPaper().fnoLimitPrice) {
      var lp = ntPaper().fnoLimitPrice('BUY', q, fillRef);
      if (lp > 0) fillTxt = lp.toFixed(2);
    }
    stock.status = ok ? ('BUY ' + (opt.strike != null ? opt.strike + ' ' + opt.optionType : opt.name) + ' @ ' + fillTxt + (state.limitOrder.enabled ? ' LIMIT' : '')) : ('entry: ' + (ntPaper().lastAutoSkip || 'rejected'));
    if (ok) {
      stock._trd = {
        side: side,
        entryPx: fillRef,
        entryT: lastBarTime(state.series[symKey(stock.sym)]) || (Date.now() / 1000),
        qty: lotsN * lotSz,
        exitPx: null,
        exitT: null,
        reason: ''
      };
    }
  }

  function exitPosition(stock, reason) {
    var posKey = 'ntd:' + stock.sym.name;
    if (ntPaper() && typeof ntPaper().autoExit === 'function') {
      ntPaper().autoExit(posKey);
      stock.status = reason || 'exit on reversal';
      if (stock._trd && !stock._trd.exitT) {
        stock._trd.exitT = (Date.now() / 1000);
        stock._trd.exitPx = optSeriesLast(stock);
        stock._trd.reason = reason || 'exit';
      }
    }
  }

  /* ---------------- classification + selection (bull/bear split) ---------------- */

  function classifyAll() {
    for (var i = 0; i < state.stocks.length; i++) {
      var s = state.stocks[i];
      var indC = indicators(state.series[symKey(s.sym)]);
      s.score = stockScore(s, indC);
      var chg = dailyChangePct(s);
      s.tfChg = isNaN(chg) ? null : chg;
      /* Bull/Bear classification follows each stock's OWN overall daily
         change (positive -> BULL, negative -> BEAR), never the NIFTY trend
         threshold. The trend-following threshold only feeds the position
         force-exit / neutral gate, not this side label. */
      s.cls = (isNaN(chg) || chg === 0) ? 'NEUTRAL' : (chg > 0 ? 'BULL' : 'BEAR');
      s.tfOk = trendSideQualify(s, s.cls);
      if (indC && indC.bb) {
        s.bbZone = indC.bb.zone;
        s.bbOb = indC.bb.overbought;
        s.bbOs = indC.bb.oversold;
      } else {
        s.bbZone = ''; s.bbOb = false; s.bbOs = false;
      }
    }
  }

  function sideGroups() {
    var bulls = [], bears = [], neus = [];
    for (var i = 0; i < state.stocks.length; i++) {
      var s = state.stocks[i];
      /* Arrangement is by the stock's own daily-change classification
         (BULL/BEAR/NEUTRAL), never gated by the NIFTY trend threshold. */
      if (s.cls === 'BULL') {
        if (state.cond.bull) bulls.push(s); else neus.push(s);
      }
      else if (s.cls === 'BEAR') {
        if (state.cond.bear) bears.push(s); else neus.push(s);
      }
      else neus.push(s);
    }
    bulls.sort(function (a, b) { return b.score - a.score; });
    bears.sort(function (a, b) { return a.score - b.score; });
    return { bulls: bulls, bears: bears, neus: neus };
  }

  function computeActive() {
    var g = sideGroups();
    /* Manual selection only: enabled bull/bear rows (capped per side) plus
       enabled neutral rows that pass the NIFTY condition gate. Every side is
       ALSO gated on the NIFTY trend-following threshold (tfOk): while the
       trend filter is ON, a stock below the set daily-change% is dropped from
       the active set immediately - never traded - exactly like the AST/AE
       trend-following picker (per-tick prune below the set percentage). */
    for (var j = 0; j < state.stocks.length; j++) state.stocks[j].active = false;
    var bullCap = state.bullCount > 0 ? state.bullCount : Infinity;
    var bearCap = state.bearCount > 0 ? state.bearCount : Infinity;
    var bIdx = 0, rIdx = 0;
    for (j = 0; j < g.bulls.length; j++) { var b = g.bulls[j]; if (b.enabled && b.tfOk !== false && bIdx < bullCap) { b.active = true; bIdx++; } }
    for (j = 0; j < g.bears.length; j++) { var r = g.bears[j]; if (r.enabled && r.tfOk !== false && rIdx < bearCap) { r.active = true; rIdx++; } }
    for (j = 0; j < g.neus.length; j++) { var nn = g.neus[j]; if (nn.enabled && nn.tfOk !== false && condFor(niftyOperative())) nn.active = true; }
  }

  /* ---------------- universe classification warmup ---------------- */

  var warmupQueue = null;
  function warmupUniverse() {
    if (warmupQueue) return;
    warmupQueue = state.stocks.slice();
    warmupStep();
  }
  function warmupStep() {
    if (!state.running || !state.visible) { warmupQueue = null; return; }
    var batch = 3;
    var taken = warmupQueue.splice(0, batch);
    for (var i = 0; i < taken.length; i++) {
      var k = symKey(taken[i].sym);
      if (!state.series[k] || !state.seriesAt[k]) {
        delete state.seriesAt[k];
        ensureCandles(taken[i].sym, state.stockTf, k, TREND_REFRESH_MS);
      }
    }
    if (warmupQueue.length) setTimeout(warmupStep, 1500);
    else warmupQueue = null;
  }

  /* ---------------- auto stop-loss hunt guard ---------------- */

  function baseSlFor(p) {
    if (p && p.slPct > 0 && p.side === 'BUY') return p.entryPrice * (1 - p.slPct / 100);
    return p ? p.stopLoss : null;
  }

  /* Series for an open position: the option premium's own candles first, the
     underlying stock's candles as a fallback. */
  function positionSeries(p) {
    var optKey = String(p.symbolId) + ':' + (p.symbolExch || 'NSE_FNO');
    if (!state.series[optKey]) {
      ensureCandles({ id: p.symbolId, exch: p.symbolExch || 'NSE_FNO', name: p.symbol || '', inst: p.inst || 'OPTIDX' }, state.stockTf, optKey, TREND_REFRESH_MS);
    }
    if (state.series[optKey] && state.series[optKey].length) return state.series[optKey];
    var nm = String(p.autoKey || p.symbol || '').replace(/^ntd:/, '').replace(/ \d+ (CE|PE)$/, '');
    var stock = state.byName[nm];
    if (!stock) return null;
    return state.series[symKey(stock.sym)] || null;
  }
  function optSeriesForStock(stock) {
    if (!stock || !stock.opt) return null;
    var okey = String(stock.opt.id) + ':' + (stock.opt.exch || 'NSE_FNO');
    return state.series[okey] || null;
  }
  function optSeriesLast(stock) {
    var cnd = optSeriesForStock(stock);
    if (cnd && cnd.length && cnd[cnd.length - 1].close != null) return cnd[cnd.length - 1].close;
    if (stock && stock.opt) {
      var q = quoteForSym(stock.opt);
      if (q && q.ltp) return Number(q.ltp);
    }
    return null;
  }

  /* Fake-breakout / stop-loss hunt on the last bar of a position series: the
     low broke the prior N-bar support but the close recovered above it. Returns
     a widened-SL target or null. A genuine breakdown (close below support) is
     NOT a hunt. The widen target sits below the DEEPER of the broken support
     and the hunt's own wick low (minus the guard buffer) so a retest of the
     level cannot stop the trade out. */
  function detectHunt(cnd) {
    if (!cnd || cnd.length < 22) return null;
    var n = cnd.length;
    var last = cnd[n - 1];
    if (!last || last.low == null || last.close == null) return null;
    var lo = Infinity;
    for (var k = Math.max(0, n - 21); k < n - 1; k++) {
      var b = cnd[k];
      if (b && b.low != null && b.low < lo) lo = b.low;
    }
    if (!isFinite(lo)) return null;
    var brokeLow = last.low < lo;
    var recovered = last.close > lo;
    if (brokeLow && recovered) {
      var huntLow = Math.min(last.low, lo);
      var widenTo = huntLow * (1 - (Number(state.guardBuf) || 5) / 100);
      return { widenTo: widenTo, level: lo, reason: 'SL-hunt: dipped below ' + lo.toFixed(2) + ', recovered' };
    }
    return null;
  }

  function slGuardTick() {
    var st = (ntPaper() && ntPaper().getState) ? ntPaper().getState() : null;
    if (!st || !st.autoPositions) return;
    var keys = Object.keys(st.autoPositions);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (key.indexOf('ntd:') !== 0) continue;
      var p = st.autoPositions[key];
      if (!p || p.side !== 'BUY') continue;
      if (state.slMode === 'manual') {
        /* Manual: keep the fixed SL base in sync with the user's % input. */
        var baseM = baseSlFor(p);
        if (baseM != null && p.stopLoss !== baseM) p.stopLoss = baseM;
        if (p._slGuard) p._slGuard = { hunt: false, mode: '', at: Date.now() };
        continue;
      }
      if (state.slMode === 'trail') continue;  /* trail: PaperTrade's ratchet is the protection */
      var base = baseSlFor(p);
      var cnd = positionSeries(p);
      var hunt = cnd ? detectHunt(cnd) : null;
      if (hunt) {
        var floor = p.entryPrice * 0.6;
        var widened = Math.max(hunt.widenTo, floor);
        if (widened < base) {
          p.stopLoss = widened;
          p._slGuard = { hunt: true, mode: 'HUNT', widenedTo: widened, level: hunt.level, at: Date.now(), reason: hunt.reason };
        } else {
          if (p.stopLoss !== base) p.stopLoss = base;
          p._slGuard = { hunt: false, mode: '', at: Date.now() };
        }
      } else {
        if (base != null && p.stopLoss !== base) p.stopLoss = base;
        p._slGuard = { hunt: false, mode: '', at: Date.now() };
      }
    }
  }

  function resetGuardAll() {
    var st = (ntPaper() && ntPaper().getState) ? ntPaper().getState() : null;
    if (!st || !st.autoPositions) return;
    var keys = Object.keys(st.autoPositions);
    for (var i = 0; i < keys.length; i++) {
      var p = st.autoPositions[keys[i]];
      if (!p || p.side !== 'BUY') continue;
      if (state.slMode === 'manual') {
        var base = baseSlFor(p);
        if (base != null && p.stopLoss !== base) p.stopLoss = base;
      }
      if (p._slGuard) p._slGuard = { hunt: false, mode: '', at: Date.now() };
    }
  }

  /* ---------------- NIFTY chart + BB%b pane ----------------
     Live NIFTY candlestick chart with a Bollinger %B pane below it, embedded in
     the Smart NTrader tab. Reuses the shared indicator engine (IndChart.IND.bbpct)
     and the HftPool candle/quote pool so no series math is duplicated:
       - candles refresh via HftPool.getCandles(NIFTY, state.niftyTf),
       - every tick the in-progress bar is patched from the live NIFTY quote
         (clientQuotes["IDX_I:13"]) and the BB%b pane is updated in place from
         the O((smooth+1)*length) rolling tail (well under 1 ms),
       - when BB%b crosses the configured draw-line level a toast alert fires.
     ---------------- */
  var NiftyChart = (function () {
    var candleChart = null, bbChart = null;
    var candleSeries = null, bbSeries = null;
    var candles = [];
    var settings = null;
    var noteEl = null;
    var _tf = '5min';
    var ALERT_CFG_KEY = 'ntrBbpAlertCfg';
    var ALERT_DRAFT_KEY = 'ntrBbpAlertDraft';
    /* alertCfg = ARMED (engine/lines wahi use karta hai). draftCfg = popover ke
       edit box me chal rahi values; sirf "Set Alert & Execute Trade" dabane par
       hi draft LOCK hokar alertCfg me replace hota hai. */
    var alertCfg = null;
    var draftCfg = null;
    var _bbPrev = null;
    var _lastFireAt = { bull: 0, bear: 0 };
    var _paneHost = null;
    var _ovHost = null;
    var _ovLines = {};
    var _ovDrag = null;
    var ALERT_ROW_DEFS = [
      { key: 'bull', color: '#00d4aa', label: 'BULL CE' },
      { key: 'bear', color: '#ff4d6a', label: 'BEAR PE' }
    ];

    var TF_SECS = { '1min': 60, '2min': 120, '3min': 180, '4min': 240, '5min': 300, '10min': 600, '15min': 900, '30min': 1800, '1hour': 3600, '4hour': 14400 };
    var BBSET_KEY = 'ntrBbpSettings';

    function defaultAlertCfg() {
      return {
        bull: { enabled: false, cond: 'crossed_above', value: 0.8, side: 'CE' },
        bear: { enabled: false, cond: 'crossed_below', value: 0.2, side: 'PE' }
      };
    }
    function loadAlertCfg() {
      var def = defaultAlertCfg();
      try {
        var j = JSON.parse(localStorage.getItem(ALERT_CFG_KEY) || 'null');
        if (j && j.bull) {
          def.bull.enabled = !!j.bull.enabled;
          def.bull.cond = (j.bull.cond === 'crossed_below') ? 'crossed_below' : 'crossed_above';
          def.bull.value = (Number(j.bull.value) >= 0 && Number(j.bull.value) <= 3) ? Number(j.bull.value) : 0.8;
          def.bull.side = (j.bull.side === 'PE') ? 'PE' : 'CE';
        }
        if (j && j.bear) {
          def.bear.enabled = !!j.bear.enabled;
          def.bear.cond = (j.bear.cond === 'crossed_above') ? 'crossed_above' : 'crossed_below';
          def.bear.value = (Number(j.bear.value) >= 0 && Number(j.bear.value) <= 3) ? Number(j.bear.value) : 0.2;
          def.bear.side = (j.bear.side === 'CE') ? 'CE' : 'PE';
        }
      } catch (e) {}
      return def;
    }
    function saveAlertCfg() {
      try { localStorage.setItem(ALERT_CFG_KEY, JSON.stringify(alertCfg || {})); } catch (e) {}
    }
    function cloneAlertCfg(c) {
      var base = defaultAlertCfg();
      var out = { bull: {}, bear: {} }, k, s;
      for (k in out) {
        s = (c && c[k]) ? c[k] : {};
        out[k].enabled = !!s.enabled;
        out[k].cond = (s.cond === 'crossed_below') ? 'crossed_below' : 'crossed_above';
        out[k].value = (Number(s.value) >= 0 && Number(s.value) <= 3) ? Number(s.value) : base[k].value;
        out[k].side = (s.side === 'PE' || s.side === 'CE') ? s.side : base[k].side;
      }
      return out;
    }
    function alertsEqual(a, b) {
      if (!a || !b) return false;
      return a.bull.enabled === b.bull.enabled && a.bull.cond === b.bull.cond &&
        Number(a.bull.value) === Number(b.bull.value) && a.bull.side === b.bull.side &&
        a.bear.enabled === b.bear.enabled && a.bear.cond === b.bear.cond &&
        Number(a.bear.value) === Number(b.bear.value) && a.bear.side === b.bear.side;
    }
    function loadDraftCfg() {
      try {
        var j = JSON.parse(localStorage.getItem(ALERT_DRAFT_KEY) || 'null');
        if (j && j.bull) return cloneAlertCfg(j);
      } catch (e) {}
      return null;
    }
    function saveDraftCfg() {
      try { localStorage.setItem(ALERT_DRAFT_KEY, JSON.stringify(draftCfg || {})); } catch (e) {}
    }

    function fmtV(v) {
      if (v == null || isNaN(v)) return '--';
      return Number(v).toFixed(3);
    }
    function bbpctDef() {
      return (window.IndChart && IndChart.IND && IndChart.IND.bbpct) ? IndChart.IND.bbpct : null;
    }
    function persistBbpSettings() {
      try { localStorage.setItem(BBSET_KEY, JSON.stringify(settings || {})); } catch (e) {}
    }
    function defaultSettings() {
      var s = { length: 20, mult: 2, smooth: 1, source: 'close', color: '#ffb300', lineWidth: 1 };
      var def = bbpctDef();
      if (def) {
        (def.inputs || []).forEach(function (i) { s[i.key] = i.def; });
        (def.style || []).forEach(function (i) { if (s[i.key] === undefined) s[i.key] = i.def; });
      }
      try {
        var j = JSON.parse(localStorage.getItem(BBSET_KEY) || '{}');
        for (var k in j) {
          if (j[k] === null || j[k] === undefined || j[k] === '') continue;
          if (k === 'length' || k === 'mult' || k === 'lineWidth' || k === 'smooth' || k === 'source' || k === 'color') s[k] = j[k];
        }
      } catch (e) {}
      return s;
    }
    function chartOptions(container, height) {
      return {
        layout: { background: { color: '#0b0b1a' }, textColor: '#d0d0d0' },
        grid: { vertLines: { color: '#1a1a30' }, horzLines: { color: '#1a1a30' } },
        crosshair: { mode: 1 },
        rightPriceScale: { borderColor: '#2d2d50' },
        timeScale: { borderColor: '#2d2d50', timeVisible: true, secondsVisible: false },
        localization: {
          timeFormatter: function (ts) {
            var d = new Date(ts * 1000);
            var h = d.getUTCHours(), m = String(d.getUTCMinutes()).padStart(2, '0');
            var ampm = h >= 12 ? 'PM' : 'AM', h12 = h % 12 || 12;
            return h12 + ':' + m + ' ' + ampm;
          }
        },
        width: container.clientWidth || 800,
        height: height
      };
    }
    function ensureChart() {
      var cHost = document.getElementById('ntrChart');
      if (!cHost || !window.LightweightCharts) return false;
      if (candleChart) return true;
      candleChart = LightweightCharts.createChart(cHost, chartOptions(cHost, 250));
      candleSeries = candleChart.addSeries(LightweightCharts.CandlestickSeries, {
        upColor: '#00d4aa', downColor: '#ff5252',
        borderUpColor: '#00d4aa', borderDownColor: '#ff5252',
        wickUpColor: '#00d4aa', wickDownColor: '#ff5252'
      });
      var pHost = document.getElementById('ntrBbpPane');
      if (pHost) {
        _paneHost = pHost;
        bbChart = LightweightCharts.createChart(pHost, chartOptions(pHost, 110));
        bbSeries = bbChart.addSeries(LightweightCharts.LineSeries, {
          color: (settings && settings.color) ? settings.color : '#ffb300',
          lineWidth: (settings && settings.lineWidth) || 1,
          priceFormat: { type: 'custom', formatter: fmtV }
        });
      }
      try {
        candleChart.timeScale().subscribeVisibleLogicalRangeChange(function (r) {
          if (bbChart && r) bbChart.timeScale().setVisibleLogicalRange(r);
        });
      } catch (e) {}
      noteEl = document.getElementById('ntrChartNote');
      setText('ntrChartTf', _tf);
      return true;
    }
    function resize() {
      var cHost = document.getElementById('ntrChart'), pHost = document.getElementById('ntrBbpPane');
      if (candleChart && cHost && cHost.clientWidth) candleChart.applyOptions({ width: cHost.clientWidth });
      if (bbChart && pHost && pHost.clientWidth) bbChart.applyOptions({ width: pHost.clientWidth });
      applyAlertLines();
    }
    function alertChipText(key) {
      var def = null;
      for (var i = 0; i < ALERT_ROW_DEFS.length; i++) if (ALERT_ROW_DEFS[i].key === key) def = ALERT_ROW_DEFS[i];
      var cfg = alertCfg ? alertCfg[key] : null;
      if (!def || !cfg) return '';
      return def.label + '  ' + (isFinite(Number(cfg.value)) ? Number(cfg.value).toFixed(2) : '--');
    }
    /* DOM overlay for the BULLISH / BEARISH alert levels. Instead of static
       dotted chart price-lines, each enabled level is a SOLID grab-bar that the
       user can drag up/down with the mouse (smooth movement); a live value chip
       on the line shows the exact BB%b level while dragging. Positions come from
       bbSeries.priceToCoordinate/coordinateToPrice so the bar always sits on the
       real %B scale even while the pane auto-scales. */
    function applyAlertLines() {
      if (!bbSeries || !_paneHost) return;
      if (!_ovHost) {
        if (_paneHost.style.position !== 'relative') _paneHost.style.position = 'relative';
        _ovHost = document.createElement('div');
        _ovHost.style.cssText = 'position:absolute;left:0;right:0;top:0;bottom:0;pointer-events:none;z-index:3;overflow:hidden';
        _paneHost.appendChild(_ovHost);
      }
      for (var i = 0; i < ALERT_ROW_DEFS.length; i++) applyAlertRowLine(ALERT_ROW_DEFS[i]);
    }
    function applyAlertRowLine(def) {
      var cfg = alertCfg ? alertCfg[def.key] : null;
      var el = _ovLines[def.key];
      var on = !!(cfg && cfg.enabled);
      var y = null;
      if (on) {
        var v = Number(cfg.value);
        if (isFinite(v) && bbSeries.priceToCoordinate) {
          try { y = bbSeries.priceToCoordinate(v); } catch (e) {}
        }
        if (y == null || !isFinite(y)) on = false;
      }
      if (!on) { if (el) el.style.display = 'none'; return; }
      if (!el) {
        el = document.createElement('div');
        el.dataset.key = def.key;
        el.style.cssText = 'position:absolute;left:0;right:0;height:4px;margin-top:-2px;cursor:ns-resize;pointer-events:auto;border-radius:2px;box-shadow:0 0 0 1px rgba(0,0,0,.45)';
        el.style.background = def.color;
        var chip = document.createElement('span');
        chip.style.cssText = 'position:absolute;top:-11px;left:6px;padding:1px 5px;font-size:9px;line-height:12px;border-radius:3px;color:#0b0b1a;font-weight:700;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.6)';
        chip.style.background = def.color;
        el.appendChild(chip);
        el.addEventListener('pointerdown', function (ev) {
          if (ev.button !== undefined && ev.button !== 0) return;
          var c = alertCfg ? alertCfg[this.dataset.key] : null;
          if (!c || !c.enabled) return;
          _ovDrag = { key: this.dataset.key };
          if (_ovHost && _ovHost.setPointerCapture) { try { _ovHost.setPointerCapture(ev.pointerId); } catch (err) {} }
          try { this.style.border = '1px solid #fff'; } catch (err) {}
          ev.preventDefault();
          ev.stopPropagation();
        });
        _ovLines[def.key] = el;
        _ovHost.appendChild(el);
      }
      var h = _paneHost.clientHeight || _paneHost.offsetHeight || 110;
      el.style.top = Math.max(0, Math.min(h - 4, y - 2)) + 'px';
      var ch = el.firstChild;
      if (ch) {
        ch.style.top = (y < 20) ? '5px' : '-11px';
        ch.textContent = alertChipText(def.key);
      }
      el.style.display = 'block';
      el.title = 'Drag to set the ' + def.label + ' BB%b alert level';
    }
    function onPanePointerMove(ev) {
      if (!_ovDrag || !bbSeries || !_paneHost) return;
      var cfg = alertCfg ? alertCfg[_ovDrag.key] : null;
      if (!cfg) return;
      var r = _paneHost.getBoundingClientRect();
      var yrel = ev.clientY - r.top;
      var val = null;
      if (bbSeries.coordinateToPrice) {
        try { val = bbSeries.coordinateToPrice(yrel); } catch (e) {}
      }
      if (val == null || !isFinite(val)) return;
      cfg.value = Math.round(Math.min(3, Math.max(0, val)) * 1000) / 1000;
      var el = _ovLines[_ovDrag.key];
      if (el) {
        var h = _paneHost.clientHeight || _paneHost.offsetHeight || 110;
        el.style.top = Math.max(0, Math.min(h - 4, yrel - 2)) + 'px';
        var ch = el.firstChild;
        if (ch) {
          ch.style.top = (yrel < 20) ? '5px' : '-11px';
          ch.textContent = alertChipText(_ovDrag.key);
        }
      }
      saveAlertCfg();
    }
    function onPanePointerUp() {
      if (_ovDrag) {
        _ovDrag = null;
        saveAlertCfg();
        if (draftCfg) { draftCfg = cloneAlertCfg(alertCfg); saveDraftCfg(); refreshAlertStatus(); }
      }
    }
    function renderBbp() {
      if (!bbSeries || !candles.length) return;
      var def = bbpctDef();
      if (!def) return;
      var out;
      try { out = def.compute(candles, settings); } catch (e) { return; }
      var o = out && out[0];
      if (!o) return;
      bbSeries.setData(o.data || []);
      try {
        bbSeries.applyOptions({
          color: (settings && settings.color) ? settings.color : '#ffb300',
          lineWidth: (settings && settings.lineWidth) || 1
        });
      } catch (e) {}
      applyAlertLines();
    }
    function renderCandles() {
      if (!candleSeries || !candles.length) return;
      candleSeries.setData(candles.map(function (x) {
        return { time: x.time, open: x.open, high: x.high, low: x.low, close: x.close };
      }));
      try {
        candleChart.timeScale().applyOptions({ barSpacing: 8, rightOffset: 2 });
        candleChart.timeScale().setVisibleLogicalRange({ from: Math.max(0, candles.length - 200), to: candles.length - 1 });
      } catch (e) {}
    }
    function refresh() {
      if (!window.HftPool || !HftPool.getCandles) return;
      var tf = (state && state.niftyTf) ? state.niftyTf : '5min';
      _tf = tf;
      setText('ntrChartTf', tf);
      HftPool.getCandles(NIFTY, tf).then(function (arr) {
        if (!Array.isArray(arr) || !arr.length) return;
        /* private copy: local in-progress bar pushes must never mutate the
           shared HftPool cached array that the engine's state.series reads */
        candles = arr.slice();
        _bbPrev = null;
        if (!ensureChart() || !candleSeries) return;
        renderCandles();
        renderBbp();
        setNote('NIFTY ' + tf + ' · ' + candles.length + ' candles · live');
      }).catch(function () {});
    }
    function setNote(t) {
      if (noteEl) noteEl.textContent = t;
    }
    function toast(msg) {
      var box = document.getElementById('indToastBox');
      if (!box) {
        box = document.createElement('div');
        box.id = 'indToastBox';
        box.style.cssText = 'position:fixed;top:12px;right:12px;z-index:99999;display:flex;flex-direction:column;gap:6px;max-width:340px';
        document.body.appendChild(box);
      }
      var t = document.createElement('div');
      t.style.cssText = 'background:#1a1a35;border:1px solid #ffb300;border-left:3px solid #ffb300;color:#d0d0d0;padding:8px 12px;border-radius:4px;font-size:11px;box-shadow:0 4px 16px rgba(0,0,0,.5);opacity:0;transform:translateX(12px);transition:all .18s ease';
      t.textContent = msg;
      box.appendChild(t);
      requestAnimationFrame(function () { t.style.opacity = '1'; t.style.transform = 'none'; });
      setTimeout(function () {
        t.style.opacity = '0'; t.style.transform = 'translateX(12px)';
        setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 200);
      }, 3500);
    }
    /* Real-time alert evaluation on every live BB%b sample. Two fixed rows -
       BULLISH and BEARISH (joined with OR). Each row fires once per crossing
       edge (armed when BB%b sits on the non-fire side), so a row never
       double-fires while BB%b stays beyond its level. */
    function checkAlertTick(prev, last) {
      if (!alertCfg || prev == null || last == null || isNaN(prev) || isNaN(last)) return;
      var keys = ['bull', 'bear'];
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var cfg = alertCfg[k];
        if (!cfg || !cfg.enabled) continue;
        var v = Number(cfg.value);
        if (!isFinite(v)) continue;
        var fired = (cfg.cond === 'crossed_below') ? (prev > v && last <= v) : (prev < v && last >= v);
        if (!fired) continue;
        if (Date.now() - _lastFireAt[k] < 5000) continue;
        _lastFireAt[k] = Date.now();
        toast('NIFTY BB%b ' + ((cfg.cond === 'crossed_below') ? 'CROSSED BELOW' : 'CROSSED ABOVE') + ' ' + fmtV(v) + '  ->  ' + fmtV(last) + (k === 'bull' ? '  [BULLISH]' : '  [BEARISH]'));
        fireAlertTrade(k, cfg);
      }
    }
    /* Targets for an alert-triggered trade. 'bull' -> active bullish stocks,
       'bear' -> active bearish stocks. */
    function alertTradeTargets(mode) {
      var sideCls = null;
      if (mode === 'bull') sideCls = 'BULL';
      else if (mode === 'bear') sideCls = 'BEAR';
      if (!sideCls) return [];
      var out = [];
      for (var i = 0; i < state.stocks.length; i++) {
        var s = state.stocks[i];
        if (s.active && s.cls === sideCls && !posAt('ntd:' + s.sym.name)) out.push(s);
      }
      return out;
    }
    /* Execute a BB%b alert trade: NIFTY bullish -> BUY CE (bullish stocks),
       NIFTY bearish -> BUY PE (bearish stocks). The row's own "side" dropdown
       acts as a filter - a bullish-CE row only fires while NIFTY is BULL, a
       bearish-PE row only while NIFTY is BEAR (no EMA-cross signal involved).
       When the Trend Following toggle is OFF the row's own side still gates,
       but the matching NIFTY regime is no longer required. */
    function fireAlertTrade(k, cfg) {
      if (!cfg || !cfg.enabled) return;
      if (!state.running) { toast('BB%b alert: engine RUNNING nahi hai'); return; }
      var op = niftyOperative();
      var execSide = (cfg.side === 'PE') ? 'PE' : 'CE';
      if (state.trend.enabled) {
        if (op !== 'BULL' && op !== 'BEAR') { toast('BB%b alert @ ' + fmtV(cfg.value) + ': NIFTY trend clear nahi (BULL/BEAR)'); return; }
        var want = (op === 'BULL') ? 'CE' : 'PE';
        if (execSide !== want) return;
      }
      var targets = alertTradeTargets(execSide === 'CE' ? 'bull' : 'bear');
      if (!targets.length) {
        toast('BB%b alert @ ' + fmtV(cfg.value) + ': koi enabled ' + (execSide === 'CE' ? 'bullish (CE)' : 'bearish (PE)') + ' stock nahi');
        return;
      }
      /* Max-trades cap (Max trades / Auto trades): Auto = unlimited; Max =
         fill only the remaining open-position slots, skip when reached. */
      var remaining = tradeCapRemaining();
      if (!isFinite(remaining)) remaining = targets.length;
      if (remaining <= 0) {
        toast('BB%b alert skipped: max trades reached');
        return;
      }
      if (remaining < targets.length) targets = targets.slice(0, remaining);
      for (var i = 0; i < targets.length; i++) {
        var st = targets[i];
        st.status = 'BB%b alert ' + fmtV(cfg.value) + ' -> ' + (execSide === 'CE' ? 'BUY CE bullish' : 'BUY PE bearish');
        try { resolveAndEnter(st, execSide, null); } catch (e) {}
      }
      toast('BB%b trade alert @ ' + fmtV(cfg.value) + ' -> ' + (execSide === 'CE' ? 'BUY CE bullish' : 'BUY PE bearish') + ' (' + targets.length + ' target' + (targets.length > 1 ? 's' : '') + ')');
    }
    /* "+" button popover: the BULLISH ... OR ... BEARISH alert auto-trade form. */
    function toggleAlertBox() {
      var box = document.getElementById('ntrBbpAlertBox');
      if (!box) return;
      var opening = box.style.display === 'none';
      box.style.display = opening ? '' : 'none';
      if (opening) renderAlertBox();
    }
    function renderAlertBox() {
      var box = document.getElementById('ntrBbpAlertBox');
      if (!box) return;
      if (!draftCfg) draftCfg = cloneAlertCfg(alertCfg || {});
      box.innerHTML = '';
      var hdr = document.createElement('div');
      hdr.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:4px';
      var title = document.createElement('div');
      title.textContent = 'BB%b Alert -> Auto Trade';
      title.style.cssText = 'font-size:9px;color:#ffb300;text-transform:uppercase;letter-spacing:.3px';
      hdr.appendChild(title);
      var chip = document.createElement('span');
      chip.id = 'ntrBbpAlertStatus';
      chip.textContent = '--';
      hdr.appendChild(chip);
      box.appendChild(hdr);
      var rows = [
        { key: 'bull', label: 'BULLISH', color: '#00d4aa' },
        { key: 'bear', label: 'BEARISH', color: '#ff4d6a' }
      ];
      for (var i = 0; i < rows.length; i++) {
        buildAlertRow(box, rows[i], i);
        if (i === 0) {
          var or = document.createElement('div');
          or.textContent = 'OR';
          or.style.cssText = 'font-size:9px;color:#ffb300;text-transform:uppercase;text-align:center;margin:2px 0;letter-spacing:1px';
          box.appendChild(or);
        }
      }
      var sum = document.createElement('div');
      sum.id = 'ntrBbpAlertActive';
      sum.style.cssText = 'font-size:8px;color:#99a;margin-top:5px;line-height:1.4;word-break:break-all';
      box.appendChild(sum);
      var setBtn = document.createElement('button');
      setBtn.textContent = '\u2713 Set Alert & Execute Trade';
      setBtn.style.cssText = 'width:100%;margin-top:6px;background:#00d4aa;color:#0b0b1a;border:none;border-radius:3px;padding:6px 8px;font-size:10px;font-weight:800;letter-spacing:.3px;cursor:pointer;text-transform:uppercase';
      setBtn.onclick = setArmedAlert;
      box.appendChild(setBtn);
      var note = document.createElement('div');
      note.textContent = 'BULLISH row (NIFTY BULL) -> BUY CE, BEARISH row (NIFTY BEAR) -> BUY PE. Trend Follow ON par sirf matching side fire hoti hai; engine RUNNING hona zaroori hai.';
      note.style.cssText = 'font-size:9px;color:#888;margin-top:6px;border-top:1px solid #1e1e40;padding-top:4px';
      box.appendChild(note);
      var hint = document.createElement('div');
      hint.textContent = 'Yahan kiye gaye changes sirf draft hain. SET dabane par hi alert LOCK hokar final hota hai aur trades us level ke crossing par shuru ho jaate hain; tab tak purana SET alert hi trade karta rahega.';
      hint.style.cssText = 'font-size:8px;color:#666;margin-top:3px;line-height:1.4';
      box.appendChild(hint);
      refreshAlertStatus();
    }
    /* Lock/draft indicator in the popover header + the active-armed summary.
       Green SET & EXECUTING = draft == armed (engine isliye chalta hai); amber
       CHANGED = box me badlaav hua par SET abhi nahi dabaya (old active hai). */
    function refreshAlertStatus() {
      var chip = document.getElementById('ntrBbpAlertStatus');
      var sum = document.getElementById('ntrBbpAlertActive');
      if (!chip) return;
      if (!draftCfg || !alertCfg) return;
      var locked = alertsEqual(draftCfg, alertCfg);
      var hasDraft = draftCfg.bull.enabled || draftCfg.bear.enabled;
      var hasArm = alertCfg.bull.enabled || alertCfg.bear.enabled;
      function fmtRows(cfgObj) {
        var out = [], i;
        for (i = 0; i < ALERT_ROW_DEFS.length; i++) {
          var r = ALERT_ROW_DEFS[i];
          var c = cfgObj ? cfgObj[r.key] : null;
          if (c && c.enabled) out.push((r.key === 'bull' ? 'BULL' : 'BEAR') + ' ' + (c.cond === 'crossed_below' ? 'below' : 'above') + ' ' + (isFinite(Number(c.value)) ? Number(c.value).toFixed(2) : '--') + ' -> ' + (c.side === 'PE' ? 'BUY PE' : 'BUY CE'));
        }
        return out.length ? out.join('  |  ') : 'none';
      }
      if (sum) sum.innerHTML = 'ACTIVE: ' + fmtRows(alertCfg) + '<br>BOX: ' + fmtRows(draftCfg);
      var txt, fg, bg;
      if (!hasDraft) { txt = 'NO ALERT'; fg = '#888'; bg = 'transparent'; }
      else if (locked) { txt = hasArm ? 'SET & EXECUTING' : 'SET (rows OFF)'; fg = '#0b0b1a'; bg = hasArm ? '#00d4aa' : 'transparent'; if (!hasArm) fg = '#888'; }
      else { txt = 'CHANGED - SET NAHI'; fg = '#0b0b1a'; bg = '#ffb300'; }
      chip.textContent = txt;
      chip.style.cssText = 'font-size:9px;font-weight:800;padding:2px 6px;border-radius:3px;letter-spacing:.3px;white-space:nowrap;color:' + fg + ';background:' + bg + ';border:1px solid ' + (bg === 'transparent' ? '#2d2d50' : bg);
    }
    /* Copy the popover draft into the armed config: old alert is replaced by
       the new one, then trades fire from the fresh levels immediately. */
    function setArmedAlert() {
      if (!draftCfg) return;
      var k, i;
      for (k in draftCfg) { var r = draftCfg[k]; if (r && isNaN(Number(r.value))) r.value = 0; }
      alertCfg = cloneAlertCfg(draftCfg);
      saveAlertCfg();
      saveDraftCfg();
      applyAlertLines();
      var note = [];
      for (i = 0; i < ALERT_ROW_DEFS.length; i++) {
        var d = ALERT_ROW_DEFS[i], c = alertCfg[d.key];
        if (c && c.enabled) note.push((d.key === 'bull' ? 'BULL' : 'BEAR') + ' ' + (c.cond === 'crossed_below' ? 'crossed below' : 'crossed above') + ' ' + Number(c.value).toFixed(2) + ' -> ' + (c.side === 'PE' ? 'BUY PE' : 'BUY CE'));
      }
      toast('BB%b Alert SET & LOCKED' + (note.length ? ': ' + note.join('  |  ') : ' (rows sab OFF)') + '. Ab level-crossing par trades execute honge.');
      renderAlertBox();
    }
    function styleAlertSel(s) {
      s.style.cssText = 'background:#1a1a35;border:1px solid #2d2d50;color:#d0d0d0;border-radius:3px;padding:1px 2px;font-size:9px;max-width:150px';
    }
    function buildAlertRow(box, meta, idx) {
      var cfg = draftCfg[meta.key];
      var wrap = document.createElement('div');
      wrap.style.cssText = 'border:1px solid ' + meta.color + ';border-radius:3px;padding:4px 6px';
      var ctl = document.createElement('div');
      ctl.style.cssText = 'display:flex;align-items:center;gap:5px;flex-wrap:wrap';
      var en = document.createElement('input');
      en.type = 'checkbox';
      en.checked = !!cfg.enabled;
      en.style.cssText = 'width:12px;height:12px;accent-color:' + meta.color + ';cursor:pointer';
      var enl = document.createElement('label');
      enl.textContent = meta.label;
      enl.style.cssText = 'font-size:10px;font-weight:700;color:' + meta.color + ';cursor:pointer;white-space:nowrap';
      ctl.appendChild(en); ctl.appendChild(enl);
      var when = document.createElement('span');
      when.textContent = 'when BB%b';
      when.style.cssText = 'font-size:9px;color:#888;white-space:nowrap';
      ctl.appendChild(when);
      var cond = document.createElement('select');
      ['crossed_above', 'crossed_below'].forEach(function (c) {
        var o = document.createElement('option');
        o.value = c;
        o.textContent = (c === 'crossed_above') ? 'crossed above' : 'crossed below';
        if (c === cfg.cond) o.selected = true;
        cond.appendChild(o);
      });
      styleAlertSel(cond);
      ctl.appendChild(cond);
      var val = document.createElement('input');
      val.type = 'number'; val.step = '0.05'; val.min = '0'; val.max = '3';
      val.value = cfg.value;
      val.title = 'BB%b value (0-3)';
      val.style.cssText = 'width:56px;background:#1a1a35;border:1px solid #2d2d50;color:#d0d0d0;border-radius:3px;padding:1px 4px;font-size:10px';
      ctl.appendChild(val);
      var ar = document.createElement('span');
      ar.textContent = '->';
      ar.style.cssText = 'font-size:9px;color:#888';
      ctl.appendChild(ar);
      var trade = document.createElement('span');
      trade.textContent = 'trade';
      trade.style.cssText = 'font-size:9px;color:#888';
      ctl.appendChild(trade);
      var side = document.createElement('select');
      var opts = [
        ['CE', 'BUY Bullish CE'],
        ['PE', 'BUY Bearish PE']
      ];
      opts.forEach(function (p) {
        var o = document.createElement('option');
        o.value = p[0]; o.textContent = p[1];
        if (p[0] === cfg.side) o.selected = true;
        side.appendChild(o);
      });
      styleAlertSel(side);
      ctl.appendChild(side);
      var tip = document.createElement('span');
      tip.style.cssText = 'font-size:8px;color:#666;white-space:nowrap';
      ctl.appendChild(tip);
      wrap.appendChild(ctl);
      box.appendChild(wrap);
      function persist() { saveDraftCfg(); refreshAlertStatus(); }
      function syncDisabled() {
        var on = en.checked;
        cond.disabled = !on; val.disabled = !on; side.disabled = !on;
        wrap.style.opacity = on ? '1' : '0.55';
        var op = niftyOperative();
        tip.textContent = state.trend.enabled
          ? ('NIFTY ' + (op === 'BULL' ? 'BULL' : op === 'BEAR' ? 'BEAR' : '--') + ' par ' + (cfg.side === 'CE' ? 'CE' : 'PE') + ' fire')
          : 'Trend Follow OFF: apni side par fire';
      }
      en.onchange = function () { cfg.enabled = en.checked; syncDisabled(); persist(); };
      enl.onclick = function () { en.checked = !en.checked; en.onchange(); };
      cond.onchange = function () { cfg.cond = cond.value; persist(); };
      val.onchange = function () {
        var v = parseFloat(val.value);
        if (isNaN(v) || v < 0) { val.value = cfg.value; return; }
        cfg.value = Math.min(3, Math.max(0, v));
        persist();
      };
      val.addEventListener('input', function () {
        var v = parseFloat(val.value);
        if (!isNaN(v) && v >= 0) { cfg.value = Math.min(3, v); saveDraftCfg(); refreshAlertStatus(); }
      });
      side.onchange = function () { cfg.side = side.value; syncDisabled(); persist(); };
      syncDisabled();
    }
    /* Gear button: popover with the BB%b pane settings (Length, Std.dev mult,
       Color, Line width). Changes apply live to the pane and persist. */
    function toggleSettings() {
      var box = document.getElementById('ntrBbpSettings');
      if (!box) return;
      var opening = box.style.display === 'none';
      box.style.display = opening ? '' : 'none';
      if (opening) renderSettingsForm();
    }
    function renderSettingsForm() {
      var box = document.getElementById('ntrBbpSettings');
      if (!box) return;
      box.innerHTML = '';
      var def = bbpctDef();
      var title = document.createElement('div');
      title.textContent = 'BB%b settings';
      title.style.cssText = 'font-size:9px;color:#ffb300;text-transform:uppercase;margin-bottom:4px';
      box.appendChild(title);
      var fields = [];
      if (def) {
        (def.inputs || []).forEach(function (f) {
          fields.push({ key: f.key, label: f.label, type: (typeof f.def === 'number') ? 'number' : 'text', min: f.min, max: f.max, step: f.step });
        });
        (def.style || []).forEach(function (f) {
          if (f.key === 'lineWidth') fields.push({ key: f.key, label: f.label, type: 'number', min: f.min, max: f.max, step: f.step });
          else fields.push({ key: f.key, label: f.label, type: 'color' });
        });
      } else {
        fields.push({ key: 'length', label: 'Length', type: 'number', min: 2, max: 200, step: 1 });
        fields.push({ key: 'mult', label: 'Std.dev mult', type: 'number', min: 0.1, max: 5, step: 0.1 });
        fields.push({ key: 'color', label: 'Color', type: 'color' });
        fields.push({ key: 'lineWidth', label: 'Line width', type: 'number', min: 1, max: 5, step: 1 });
      }
      var grid = document.createElement('div');
      grid.style.cssText = 'display:flex;flex-direction:column;gap:5px';
      fields.forEach(function (f) {
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px';
        var lab = document.createElement('label');
        lab.textContent = f.label;
        lab.style.cssText = 'flex:1;color:#d0d0d0';
        var ctl = document.createElement('input');
        if (f.type === 'number') {
          ctl.type = 'number'; ctl.min = f.min; ctl.max = f.max; ctl.step = f.step;
          ctl.value = settings[f.key] != null ? settings[f.key] : '';
          ctl.style.cssText = 'width:70px;background:#1a1a35;border:1px solid #2d2d50;color:#d0d0d0;border-radius:3px;padding:2px 4px;font-size:10px';
        } else {
          ctl.type = 'color';
          ctl.value = settings[f.key] || '#ffb300';
          ctl.style.cssText = 'width:34px;height:20px;padding:0;border:1px solid #2d2d50;border-radius:3px;background:none';
        }
        ctl.dataset.key = f.key;
        ctl.dataset.ktype = f.type;
        ctl.addEventListener('input', applyBbpSetting);
        ctl.addEventListener('change', applyBbpSetting);
        row.appendChild(lab); row.appendChild(ctl);
        grid.appendChild(row);
      });
      box.appendChild(grid);
      var reset = document.createElement('button');
      reset.textContent = 'Reset defaults';
      reset.style.cssText = 'margin-top:6px;background:none;border:1px solid #2d2d50;color:#888;border-radius:3px;padding:1px 8px;font-size:9px;cursor:pointer';
      reset.onclick = function () {
        try { localStorage.removeItem(BBSET_KEY); } catch (e) {}
        settings = defaultSettings();
        persistBbpSettings();
        if (bbSeries) try { bbSeries.applyOptions({ color: settings.color }); } catch (e) {}
        renderBbp();
        renderSettingsForm();
      };
      box.appendChild(reset);
    }
    function applyBbpSetting(ev) {
      var ctl = ev.target;
      var key = ctl.dataset.key;
      if (ctl.dataset.ktype === 'number') {
        var v = parseFloat(ctl.value);
        settings[key] = isNaN(v) ? 0 : v;
      } else {
        settings[key] = ctl.value;
      }
      persistBbpSettings();
      if (bbSeries && key === 'color') {
        try { bbSeries.applyOptions({ color: settings.color }); } catch (e) {}
      }
      renderBbp();
    }
    /* Patch the in-progress NIFTY candle + BB%b pane from the live quote */
    function onTick() {
      if (!candleChart || !candles.length) return;
      var q = (typeof clientQuotes !== 'undefined') ? clientQuotes['IDX_I:' + NIFTY.id] : null;
      if (!q || !q.ltp || !(q.ltp > 0)) return;
      if (q.live === false && (q.at && (Date.now() / 1000 - q.at) > 30)) return;
      var IST_OFF = 5.5 * 3600 * 1000;
      var nowSec = Math.floor((Date.now() + IST_OFF) / 1000);
      var secs = TF_SECS[_tf];
      if (!secs) return;
      var barStart = nowSec - (nowSec % secs);
      var last = candles[candles.length - 1];
      var ltp = Number(q.ltp);
      if (last.time === barStart) {
        if (ltp > last.high) last.high = ltp;
        if (ltp < last.low) last.low = ltp;
        last.close = ltp;
        try { candleSeries.update({ time: last.time, open: last.open, high: last.high, low: last.low, close: last.close }); } catch (e) {}
      } else if (last.time < barStart) {
        if (barStart - last.time > secs) return;
        candles.push({ time: barStart, open: ltp, high: ltp, low: ltp, close: ltp, volume: 0 });
        try {
          candleSeries.update({ time: barStart, open: ltp, high: ltp, low: ltp, close: ltp });
          candleChart.timeScale().applyOptions({ barSpacing: 8, rightOffset: 2 });
          candleChart.timeScale().setVisibleLogicalRange({ from: Math.max(0, candles.length - 200), to: candles.length - 1 });
        } catch (e) {}
      } else {
        return;
      }
      if (window.IndChart && IndChart.computeLastTwo && bbSeries) {
        var lt = IndChart.computeLastTwo('bbpct', settings, 'v0', candles);
        if (lt.last != null && !isNaN(lt.last)) {
          try { bbSeries.update({ time: last.time, value: lt.last }); } catch (e) {}
          if (_bbPrev != null && !isNaN(_bbPrev)) checkAlertTick(_bbPrev, lt.last);
          _bbPrev = lt.last;
          setText('ntrChartBb', 'BB%b ' + fmtV(lt.last));
        }
      }
      if (!_ovDrag) applyAlertLines();
    }
    function toggle() {
      var wrap = document.getElementById('ntrChartWrap');
      if (!wrap) return;
      var hidden = wrap.style.display === 'none';
      wrap.style.display = hidden ? '' : 'none';
      var btn = document.getElementById('ntrChartToggle');
      if (btn) btn.textContent = hidden ? 'Hide' : 'Show';
      if (hidden) { ensureChart(); refresh(); resize(); }
    }
    function init() {
      var btn = document.getElementById('ntrChartToggle');
      if (btn) btn.addEventListener('click', toggle);
      var plus = document.getElementById('ntrBbpPlus');
      if (plus) plus.addEventListener('click', toggleAlertBox);
      var gear = document.getElementById('ntrBbpGear');
      if (gear) gear.addEventListener('click', toggleSettings);
      settings = defaultSettings();
      alertCfg = loadAlertCfg();
      draftCfg = loadDraftCfg();
      if (!draftCfg) draftCfg = cloneAlertCfg(alertCfg);
      ensureChart();
      applyAlertLines();
      refresh();
      setInterval(function () { if (state.visible) onTick(); }, POLL_MS);
      setInterval(refresh, 20000);
      window.addEventListener('resize', resize);
      window.addEventListener('pointermove', onPanePointerMove);
      window.addEventListener('pointerup', onPanePointerUp);
    }
    function onTfChange() {
      candles = [];
      _bbPrev = null;
      refresh();
    }
    return { init: init, onTick: onTick, onTfChange: onTfChange, refresh: refresh, resize: resize };
  })();

  /* ---------------- Strike candlestick chart ----------------
     Shows the OPTION (strike) candles of a selected Smart NTrader stock with
     the trade's entry / SL / trailing-SL / TP levels drawn as price lines,
     entry+exit markers, and the running PnL - mirroring how AST surfaces its
     trade management on the candlestick chart. */
  var StrikeChart = (function () {
    var chart = null, series = null;
    var curStock = null;
    var _lastOpt = null;
    var _candles = [];
    var _loadedFor = null;

    function fmtNum(v, d) {
      if (v == null || isNaN(v)) return '--';
      return Number(v).toFixed(d == null ? 2 : d);
    }
    function chartOptions(container, height) {
      return {
        layout: { background: { color: '#0b0b1a' }, textColor: '#d0d0d0' },
        grid: { vertLines: { color: '#1a1a30' }, horzLines: { color: '#1a1a30' } },
        crosshair: { mode: 1 },
        rightPriceScale: { borderColor: '#2d2d50' },
        timeScale: { borderColor: '#2d2d50', timeVisible: true, secondsVisible: false },
        localization: {
          timeFormatter: function (ts) {
            var d = new Date(ts * 1000);
            var h = d.getUTCHours(), m = String(d.getUTCMinutes()).padStart(2, '0');
            var ampm = h >= 12 ? 'PM' : 'AM', h12 = h % 12 || 12;
            return h12 + ':' + m + ' ' + ampm;
          }
        },
        width: container.clientWidth || 800,
        height: height
      };
    }
    function ensure() {
      var host = document.getElementById('ntrStrikeChart');
      if (!host || !window.LightweightCharts) return false;
      if (chart) return true;
      chart = LightweightCharts.createChart(host, chartOptions(host, 240));
      series = chart.addSeries(LightweightCharts.CandlestickSeries, {
        upColor: '#00d4aa', downColor: '#ff5252',
        borderUpColor: '#00d4aa', borderDownColor: '#ff5252',
        wickUpColor: '#00d4aa', wickDownColor: '#ff5252'
      });
      return true;
    }
    function resize() {
      var host = document.getElementById('ntrStrikeChart');
      if (chart && host && host.clientWidth) chart.applyOptions({ width: host.clientWidth });
    }
    function optLabel(opt) {
      if (!opt) return '';
      if (opt.strike != null) return String(opt.strike) + ' ' + (opt.optionType || '');
      return opt.name || ('#' + opt.id);
    }
    function setText(id, txt) {
      var e = document.getElementById(id);
      if (e && e.textContent !== txt) e.textContent = txt;
    }
    function lastBarTime(cnd) {
      return (cnd && cnd.length) ? cnd[cnd.length - 1].time : null;
    }
    function clearLines() {
      if (!series) return;
      try {
        var pls = series.priceLines() || [];
        for (var i = 0; i < pls.length; i++) { try { series.removePriceLine(pls[i]); } catch (e) {} }
      } catch (e) {}
    }
    function setStock(stock) {
      curStock = stock || null;
      if (!stock) { clearLines(); if (series) { try { series.setMarkers([]); } catch (e) {} } setText('ntrStrikeInfo', '--'); setText('ntrStrikePnl', ''); return; }
      var opt = stock.opt;
      _lastOpt = opt;
      if (!opt) { setText('ntrStrikeInfo', stock.sym.name + ' - resolving option...'); return; }
      if (!window.HftPool || !HftPool.getCandles) return;
      HftPool.getCandles(opt, state.stockTf).then(function (arr) {
        if (!arr || !arr.length) return;
        if (curStock !== stock) return;
        if (!ensure()) return;
        _candles = arr;
        _loadedFor = (opt.id != null ? opt.id : opt.name);
        series.setData(_candles.map(function (x) { return { time: x.time, open: x.open, high: x.high, low: x.low, close: x.close }; }));
        try { chart.timeScale().fitContent(); } catch (e) {}
        setText('ntrStrikeInfo', stock.sym.name + ' · ' + optLabel(opt) + ' · ' + state.stockTf);
        updateOverlay(stock);
      }).catch(function () {});
    }
    function updateOverlay(stock) {
      if (!series || !stock) return;
      clearLines();
      var pos = posAt('ntd:' + stock.sym.name);
      var trd = stock._trd;
      if (trd && trd.entryPx > 0) {
        try { series.createPriceLine({ price: trd.entryPx, color: '#00d4aa', lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: 'ENTRY' }); } catch (e) {}
      }
      if (pos && pos.stopLoss) {
        try { series.createPriceLine({ price: pos.stopLoss, color: '#ff5252', lineWidth: 1, lineStyle: 1, axisLabelVisible: true, title: pos.slTrailed ? 'TRAIL SL' : 'SL' }); } catch (e) {}
      }
      if (pos && pos.tpPct > 0 && pos.tpPrice) {
        try { series.createPriceLine({ price: pos.tpPrice, color: '#ffb300', lineWidth: 1, lineStyle: 1, axisLabelVisible: true, title: 'TP ' + fmtNum(pos.tpPct, 1) + '%' }); } catch (e) {}
      }
      if (pos && pos.targetPct > 0 && pos.targetPrice) {
        try { series.createPriceLine({ price: pos.targetPrice, color: '#66ccff', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'TRAIL TP' }); } catch (e) {}
      }
      /* Entry / exit markers (clamped to the loaded bars so they always plot). */
      var lastT = lastBarTime(_candles);
      var mk = [];
      if (trd && trd.entryT && lastT != null) {
        mk.push({ time: Math.min(trd.entryT, lastT), position: 'belowBar', color: '#00d4aa', shape: 'arrowUp', text: 'BUY' });
      }
      if (trd && trd.exitT && lastT != null) {
        mk.push({ time: Math.min(trd.exitT, lastT), position: 'aboveBar', color: '#ff5252', shape: 'arrowDown', text: trd.reason || 'EXIT' });
      }
      if (mk.length > 1 && mk[0].time === mk[1].time) mk = [mk[1]];
      try { series.setMarkers(mk); } catch (e) {}
      /* PnL readout: open = live, closed = booked. All Smart NTrader legs are
         long premium, so PnL = (exit - entry) x qty. */
      var pnl = 0, tag = 'NO TRADE';
      if (pos) { pnl = livePnl(pos); tag = 'OPEN'; }
      else if (trd && trd.exitT != null && trd.entryPx > 0) { pnl = ((trd.exitPx != null ? trd.exitPx : trd.entryPx) - trd.entryPx) * (trd.qty || 1); tag = 'CLOSED'; }
      var col = pnl > 0 ? '#00d4aa' : (pnl < 0 ? '#ff4d6a' : '#888');
      setText('ntrStrikePnl', tag + ' · ' + (pnl >= 0 ? '+' : '') + fmtNum(pnl, 2) + '  (entry ' + fmtNum(trd ? trd.entryPx : null, 3) + ')');
      var pe = document.getElementById('ntrStrikePnl');
      if (pe) pe.style.color = col;
    }
    function refreshSelector() {
      var sel = document.getElementById('ntrStrikeSel');
      if (!sel) return;
      var cur = sel.value;
      var html = '<option value="">-- select a stock trade --</option>';
      var hasOpenIdx = -1, autoIdx = -1, latestT = 0;
      for (var i = 0; i < state.stocks.length; i++) {
        var s = state.stocks[i];
        var pos = posAt('ntd:' + s.sym.name);
        if (!s._trd && !s.enabled && !pos) continue;
        var lbl = s.sym.name + (s.opt && s.opt.strike != null ? ' ' + optLabel(s.opt) : '');
        if (pos) { lbl += ' ●'; if (hasOpenIdx === -1) hasOpenIdx = i; }
        else if (s._trd && s._trd.exitT) lbl += ' ✓';
        if (s._trd && s._trd.entryT && s._trd.entryT > latestT) { latestT = s._trd.entryT; autoIdx = i; }
        html += '<option value="' + i + '">' + lbl + '</option>';
      }
      if (sel.innerHTML !== html) sel.innerHTML = html;
      if (!cur && !curStock) {
        var pick = (hasOpenIdx >= 0) ? hasOpenIdx : autoIdx;
        if (pick >= 0) {
          sel.value = String(pick);
          setStock(state.stocks[pick]);
        }
      } else if (sel.value !== cur) {
        sel.value = cur;
      }
    }
    function tick() {
      refreshSelector();
      if (!chart || !curStock) return;
      var stock = curStock;
      /* Pick up a freshly resolved option contract and load its candles. */
      if (stock.opt && stock.opt !== _lastOpt) { setStock(stock); return; }
      if (!_loadedFor) return;
      /* Patch the forming bar from the live option quote. */
      var q = stock.opt ? quoteForSym(stock.opt) : null;
      if (q && q.ltp && _candles.length) {
        var last = _candles[_candles.length - 1];
        try {
          series.update({
            time: last.time,
            open: last.open,
            high: Math.max(last.high, q.ltp),
            low: Math.min(last.low, q.ltp),
            close: q.ltp
          });
        } catch (e) {}
      }
      updateOverlay(stock);
      refreshSelector();
    }
    function init() {
      var sel = document.getElementById('ntrStrikeSel');
      if (sel) {
        sel.addEventListener('change', function () {
          var v = parseInt(sel.value, 10);
          setStock(!isNaN(v) && state.stocks[v] ? state.stocks[v] : null);
        });
      }
      var tg = document.getElementById('ntrStrikeToggle');
      if (tg) {
        tg.addEventListener('click', function () {
          var wrap = document.getElementById('ntrStrikeWrap');
          if (!wrap) return;
          var hidden = wrap.style.display === 'none';
          wrap.style.display = hidden ? '' : 'none';
          tg.textContent = hidden ? 'Hide' : 'Show';
          if (hidden) { resize(); try { chart.timeScale().fitContent(); } catch (e) {} }
        });
      }
      window.addEventListener('resize', resize);
      refreshSelector();
    }
    function dbg() {
      return { stock: (curStock && curStock.sym) ? curStock.sym.name : null, candles: _candles.length, loadedFor: _loadedFor };
    }
    function reset() {
      _candles = [];
      _loadedFor = null;
      _lastOpt = null;
      if (series) {
        try { series.setData([]); } catch (e) {}
        clearLines();
      }
      if (curStock && curStock.opt) setStock(curStock);
      else if (curStock) setText('ntrStrikeInfo', curStock.sym.name + ' - resolving option...');
    }
    return { init: init, setStock: setStock, refreshSelector: refreshSelector, tick: tick, resize: resize, reset: reset, dbg: dbg };
  })();

  /* ---------------- main tick (<5ms decision core) ---------------- */

  function tick() {
    if (!state.running || !state.visible) return;
    var t0 = performance.now();

    var niftyKey = symKey(NIFTY);
    if (!state.series[niftyKey] || (Date.now() - (state.seriesAt[niftyKey] || 0)) > TREND_REFRESH_MS) {
      ensureCandles(NIFTY, state.niftyTf, niftyKey, TREND_REFRESH_MS);
    }
    var niftyInd = indicators(state.series[niftyKey]);
    var niftyTrend = detectNifty(niftyInd);
    var nq = quoteForSym(NIFTY);
    if (nq && nq.ltp) {
      state.nifty.ltp = Number(nq.ltp);
      state.nifty.chg = nq.change !== undefined ? Number(nq.change) : 0;
      state.nifty.chgPct = nq.change_pct !== undefined ? Number(nq.change_pct) : 0;
    }
    state.nifty.overall = niftyTrend.overall;
    state.nifty.current = niftyTrend.current;
    state.nifty.reversal = niftyTrend.reversal;
    state.nifty.bbPct = niftyTrend.bbPct;
    state.nifty.bb = niftyTrend.bb;

    /* NIFTY + BB%B set-condition gate: evaluate both rows against the live
       NIFTY trend and %B snapshot; the row matching the current direction
       gates its stock side (bull row -> bullish picks, bear row -> bearish).
       When disabled both sides pass. */
    condGateEval();

    /* Classify the whole universe (quotes one-pass; candles refine actives)
       and compute the active set (manual: enabled rows capped per side). */
    classifyAll();
    computeActive();

    /* NIFTY trend-following immediate removal (AST port): while trend mode is on,
       force-exit any open position whose stock is no longer on the NIFTY trend
       side / above the daily change% threshold (or has no live quote). */
    if (trendFilterActive()) {
      var nc = niftyOperative();
      var thresh = trendPct();
      for (var pi = 0; pi < state.stocks.length; pi++) {
        var ps = state.stocks[pi];
        if (isCommodity(ps.sym)) continue;
        var ppk = 'ntd:' + ps.sym.name;
        if (!posAt(ppk)) continue;
        var pchg = dailyChangePct(ps);
        var pdrop = (nc === 'BULL') ? !(pchg >= thresh) : (nc === 'BEAR') ? !(pchg <= -thresh) : true;
        if (pdrop) {
          ps.status = 'trend drop (daily chg ' + (isNaN(pchg) ? '--' : pchg.toFixed(2)) + '%)';
          exitPosition(ps, 'trend drop');
        }
      }
    }

    var actives = state.stocks.filter(function (s) { return s.active; });
    for (var a = 0; a < actives.length; a++) {
      var act = actives[a];
      var k = symKey(act.sym);
      ensureCandles(act.sym, state.stockTf, k, TREND_REFRESH_MS);
      var posKey = 'ntd:' + act.sym.name;
      var pos = posAt(posKey);
      act.inPos = !!pos;
      act.posQty = pos ? pos.qty : 0;
      act.posPnl = pos ? livePnl(pos) : 0;
      if (pos && !isCommodity(act.sym) && niftyTrend.reversal.indexOf(act.cls === 'BULL' ? 'BEARISH' : 'BULLISH') !== -1) {
        exitPosition(act);
      }
      /* Entries are BB%b-alert driven ONLY (no per-stock EMA-cross auto
         entries). decideEntry() is intentionally not called here: the armed
         BULLISH/BEARISH alert rows in the BB%b Alert -> Auto Trade box place
         CE (NIFTY BULL) / PE (NIFTY BEAR) trades themselves when the level
         crosses. Position management (SL/TP/trail/overall SL) still runs. */
    }

    /* Trade-close tracking: when a position disappears without our exitPosition
       (SL / trailing SL / TP hit inside PaperTrade), record the exit so the
       strike chart can draw the exit marker. */
    trackClosedTrades();

    /* Portfolio-wide Overall SL: close EVERY open position when the total
       unrealized loss reaches the configured % of the total invested. */
    if (overallSlBreached()) exitAllPositions('overall SL');

    slGuardTick();

    if (typeof StrikeChart !== 'undefined' && StrikeChart && StrikeChart.tick) StrikeChart.tick();

    state.tickMs = performance.now() - t0;
    render();
  }

  function trackClosedTrades() {
    for (var i = 0; i < state.stocks.length; i++) {
      var s = state.stocks[i];
      if (!s._trd || s._trd.exitT) continue;
      if (!posAt('ntd:' + s.sym.name)) {
        s._trd.exitT = (Date.now() / 1000);
        s._trd.exitPx = optSeriesLast(s);
        s._trd.reason = s._trd.reason || 'SL/TP exit';
      }
    }
  }

  /* ---------------- 30-second trend / % change auto-refresh ----------------
     Every TREND_REFRESH_MS we force a fresh check of the NIFTY trend info
     (candles -> indicators -> detectNifty) and the universe's daily % change
     (quotes re-poll + candle series refresh) so the NIFTY Trend Following
     gate and the NIFTY cards track live movement. Series are staggered
     through the warmup queue so the per-tick budget stays under 5ms. */

  function timeStr() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function refreshTrendData() {
    if (!state.running || !state.visible) return;
    var t0 = performance.now();
    try { if (typeof window.pollQuotes === 'function') window.pollQuotes(); } catch (e) {}
    var i, k;
    state.seriesAt[symKey(NIFTY)] = 0;
    for (i = 0; i < state.stocks.length; i++) {
      k = symKey(state.stocks[i].sym);
      state.seriesAt[k] = 0;
    }
    warmupUniverse();
    var nq = quoteForSym(NIFTY);
    var chgTxt = (nq && nq.change_pct != null) ? fmtNum(Number(nq.change_pct), 2) + '%' : '--';
    /* Daily % change up-to-date + re-sort of the F&O list so any stock that
       moved up into the top / flipped sign shows at its new rank. */
    state._sortDirty = true;
    var line = '60s refresh @ ' + timeStr() + ' · NIFTY ' + state.nifty.current + ' · chg ' + chgTxt +
      ' · ' + fmtNum(performance.now() - t0, 1) + 'ms';
    state.trendRefresh = line;
    setText('ntrTrendRefresh', line);
    console.log('[SmartNTrader]', line);
  }

  /* Stopped-state status pulse (AST/AE poll-timer port): while the engine is
     NOT running the NIFTY direction is still computed from the server candle
     series (available even with the market closed, like AST's niftyBias) so
     the NIFTY Trend Following fetched-stock list, NIFTY cards and F&O table
     stay live and visible. tick() already does all of this while running, so
     this only acts when state.running is false. */
  function statusPulse() {
    if (!state.visible || state.running) return;
    var nk = symKey(NIFTY);
    if (!state.series[nk] || (Date.now() - (state.seriesAt[nk] || 0)) > TREND_REFRESH_MS) {
      ensureCandles(NIFTY, state.niftyTf, nk, TREND_REFRESH_MS);
    }
    var niftyInd = indicators(state.series[nk]);
    var niftyTrend = detectNifty(niftyInd);
    if (niftyTrend && niftyTrend.current !== '...') {
      state.nifty.overall = niftyTrend.overall;
      state.nifty.current = niftyTrend.current;
      state.nifty.reversal = niftyTrend.reversal;
      state.nifty.bbPct = niftyTrend.bbPct;
      state.nifty.bb = niftyTrend.bb;
    }
    var nq = quoteForSym(NIFTY);
    if (nq && nq.ltp) {
      state.nifty.ltp = Number(nq.ltp);
      state.nifty.chg = nq.change !== undefined ? Number(nq.change) : 0;
      state.nifty.chgPct = nq.change_pct !== undefined ? Number(nq.change_pct) : 0;
    }
    render();
  }

  /* ---------------- position reads ---------------- */

  function posAt(posKey) {
    var st = (ntPaper() && ntPaper().getState) ? ntPaper().getState() : null;
    return (st && st.autoPositions) ? (st.autoPositions[posKey] || null) : null;
  }
  /* Trade cap (Max trades / Auto trades): Max = fixed cap on the number of
     open stock positions, Auto = unlimited (conditions-driven, overrides the
     cap). Enforcement gates BOTH manual active-row entries and BB%b alert
     trades. */
  function openTradeCount() {
    var n = 0;
    for (var i = 0; i < state.stocks.length; i++) {
      if (posAt('ntd:' + state.stocks[i].sym.name)) n++;
    }
    return n;
  }
  function tradeCapReached() {
    if (state.tradeCap.auto) return false;
    if (!state.tradeCap.enabled) return false;
    var cap = (Number(state.tradeCap.count) > 0) ? Math.round(Number(state.tradeCap.count)) : 1;
    return openTradeCount() >= cap;
  }
  function tradeCapRemaining() {
    if (state.tradeCap.auto) return Infinity;
    if (!state.tradeCap.enabled) return Infinity;
    var cap = (Number(state.tradeCap.count) > 0) ? Math.round(Number(state.tradeCap.count)) : 1;
    return Math.max(0, cap - openTradeCount());
  }
  /* Stop-loss modes: 'auto' = ATR candle-derived base + hunt guard, 'manual' =
     the user's SL % (no hunt guard), 'trail' = ATR candle-derived base PLUS a
     trailing SL that ratchets the stop behind the peak (never back down). */
  function slGuardActive() { return state.slMode === 'auto'; }
  function atrSlPct(cnd) {
    if (!cnd || cnd.length < 5) return null;
    var len = Math.min(14, cnd.length - 1);
    var trSum = 0, prevClose = cnd[0].close, cnt = 0;
    for (var i = 1; i <= len && i < cnd.length; i++) {
      var c = cnd[i];
      trSum += Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
      cnt++;
      prevClose = c.close;
    }
    var atr = cnt ? trSum / cnt : 0;
    var close = cnd[cnd.length - 1].close;
    if (!close || !atr) return null;
    var pct = Math.min(Math.max(atr / close * 100 * 1.6, 0.3), 3);
    return Math.round(pct * 100) / 100;
  }
  /* Candle-derived SL base (AST autoSLPct port): ATR over the last <=14 bars of
     the traded instrument (the option's own candles, the stock's as fallback),
     clamped to 0.3-3%. */
  function autoSlPctFor(stock) {
    if (stock) {
      var opt = stock.opt;
      if (opt) {
        var okey = String(opt.id) + ':' + (opt.exch || 'NSE_FNO');
        var op = atrSlPct(state.series[okey]);
        if (op != null) return op;
      }
      var st = atrSlPct(state.series[symKey(stock.sym)]);
      if (st != null) return st;
    }
    return (Number(state.tpPct) > 0) ? Number(state.tpPct) / 2 : 10;
  }
  function slPctFor(stock) {
    return (state.slMode === 'manual') ? (Number(state.slPct) || 0) : autoSlPctFor(stock);
  }
  function slTrailPctFor() {
    return (state.slMode === 'trail') ? ((Number(state.trailSl.pct) > 0) ? Number(state.trailSl.pct) : 1) : 0;
  }
  /* Portfolio-wide "Overall SL": close EVERY Smart NTrader position when the
     total unrealized loss across all open positions reaches the given % of the
     total invested (sum of entry price x qty). */
  function ntdPositions() {
    var out = [];
    for (var i = 0; i < state.stocks.length; i++) {
      var p = posAt('ntd:' + state.stocks[i].sym.name);
      if (p) out.push({ stock: state.stocks[i], pos: p });
    }
    return out;
  }
  function overallSlBreached() {
    if (!state.overallSl.enabled) return false;
    var pct = (Number(state.overallSl.pct) > 0) ? Number(state.overallSl.pct) : 5;
    var invested = 0, pnl = 0;
    var list = ntdPositions();
    for (var i = 0; i < list.length; i++) {
      var p = list[i].pos;
      invested += (Number(p.entryPrice) || 0) * (Number(p.qty) || 0);
      pnl += livePnl(p);
    }
    if (!(invested > 0)) return false;
    return pnl <= -(invested * pct / 100);
  }
  function exitAllPositions(reason) {
    var list = ntdPositions();
    for (var i = 0; i < list.length; i++) {
      list[i].stock.status = reason || 'overall SL';
      exitPosition(list[i].stock, reason || 'overall SL');
    }
    if (list.length) console.log('[SmartNTrader]', 'overall SL hit - closed', list.length, 'position(s)');
  }
  function livePnl(pos) {
    if (!pos) return 0;
    var q = quoteForSym({ id: pos.symbolId, exch: pos.symbolExch });
    var cur = (q && q.ltp) ? Number(q.ltp) : pos.entryPrice;
    return (pos.side === 'BUY') ? (cur - pos.entryPrice) * pos.qty : (pos.entryPrice - cur) * pos.qty;
  }

  /* ---------------- render (batched + dirty-checked) ---------------- */

  var _r = {};   // cached element refs
  function el(id) {
    if (_r[id] === undefined) _r[id] = document.getElementById(id);
    return _r[id];
  }
  function setText(id, txt) {
    var e = el(id);
    if (e && e.textContent !== txt) e.textContent = txt;
  }

  function badge(overall) {
    return { BULL: '▲ BULL', BEAR: '▼ BEAR', RANGE: '▬ RANGE', FLAT: '· FLAT', '...': '...' }[overall] || overall;
  }
  function badgeColor(v) {
    return (v === 'BULL' || v === 'BULLISH REVERSAL' || v === '▲ BULL') ? '#00d4aa'
      : (v === 'BEAR' || v === 'BEARISH REVERSAL' || v === '▼ BEAR') ? '#ff4d6a' : '#ff9800';
  }
  function fmtNum(x, d) {
    if (x === null || x === undefined || isNaN(x)) return '--';
    return Number(x).toFixed(d);
  }
  function fmtMoney(x) {
    if (x === null || x === undefined || isNaN(x)) return '--';
    var v = Number(x);
    var s = v < 0 ? '-' : '';
    return s + '₹' + Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  }
  var BB_SHORT = { above_upper: 'BB+', upper_half: 'UB', lower_half: 'LB', below_lower: 'BB-' };
  function bbShort(bb) {
    if (!bb) return '';
    if (bb.overbought) return 'OB';
    if (bb.oversold) return 'OS';
    return BB_SHORT[bb.zone] || '';
  }

  function activesCount() {
    return state.stocks.filter(function (s) { return s.active; }).length;
  }

  function render() {
    var t1 = performance.now();
    var nb = badge(state.nifty.overall), cb = badge(state.nifty.current);
    setText('ntrNiftyLtp', state.nifty.ltp ? fmtNum(state.nifty.ltp, 2) : '--');
    setText('ntrNiftyChg', (state.nifty.chgPct ? ((state.nifty.chgPct >= 0 ? '+' : '') + fmtNum(state.nifty.chgPct, 2) + '%') : '--'));
    var elo = el('ntrNiftyOverall');
    if (elo) { elo.textContent = nb; elo.style.color = badgeColor(state.nifty.overall); }
    var elc = el('ntrNiftyCurrent');
    if (elc) { elc.textContent = cb; elc.style.color = badgeColor(state.nifty.current); }
    var elr = el('ntrNiftyReversal');
    if (elr) { elr.textContent = state.nifty.reversal || '--'; elr.style.color = state.nifty.reversal ? badgeColor(state.nifty.reversal) : '#666'; }
    var elbb = el('ntrBb');
    if (elbb) {
      var bbs = state.nifty.bb ? (fmtNum(state.nifty.bb.pctb, 2) + ' ' + (bbShort(state.nifty.bb) || '')) : '--';
      elbb.textContent = bbs;
      elbb.style.color = state.nifty.bb ? (state.nifty.bb.overbought ? '#ff9800' : state.nifty.bb.oversold ? '#00d4aa' : '#888') : '#888';
      if (elbb.title !== '') elbb.title = state.nifty.bb ? ('%B ' + fmtNum(state.nifty.bb.pctb, 2) + ' · session S/R ' + fmtNum(state.nifty.bb.sLow, 2) + ' / ' + fmtNum(state.nifty.bb.sHigh, 2) + ' · slope ' + state.nifty.bb.slope) : '';
    }
    /* Live BB%B in the Set Condition rows (computed from the NIFTY series at
       the timeframe selected in the NIFTY TF dropdown, like the BB card). */
    setText('ntrCondBullBB', 'BB%B ' + fmtNum(state.nifty.bbPct, 2));
    setText('ntrCondBearBB', 'BB%B ' + fmtNum(state.nifty.bbPct, 2));
    setText('ntrTick', 'tick ' + fmtNum(state.tickMs, 2) + 'ms');
    setText('ntrStatus', (state.running ? 'RUNNING' : 'STOPPED') + ' · MANUAL · ' + activesCount() + ' active' +
      ' · SL ' + (state.slMode === 'trail' ? 'TRAIL ' + slTrailPctFor() + '%' : state.slMode === 'manual' ? 'MAN ' + (state.slPct || 0) + '%' : 'AUTO') +
      ' · guard ' + (slGuardActive() ? 'ON' : 'OFF') +
      ' · OSL ' + (state.overallSl.enabled ? state.overallSl.pct + '%' : 'OFF') +
      ' · TF ' + (trendFilterActive() ? 'ON (' + trendPct() + '%)' : 'OFF') +
      ' · TRD ' + (state.tradeCap.auto ? 'AUTO' : (state.tradeCap.enabled ? 'MAX ' + state.tradeCap.count + ' (' + openTradeCount() + ' open)' : 'OFF')) +
      ' · COND ' + (state.condition.enabled ? (niftyOperative() === 'BULL' ? (state.cond.bull ? 'BULL OK' : 'BULL BLOCKED') : niftyOperative() === 'BEAR' ? (state.cond.bear ? 'BEAR OK' : 'BEAR BLOCKED') : (state.cond.bull ? 'FLAT OK' : 'FLAT BLOCKED')) : 'OFF') +
      ' · NIFTY ' + (niftyOperative() || '--'));

    var tt = el('ntrTrendToggle');
    if (tt && tt.textContent !== ('Trend Follow: ' + (state.trend.enabled ? 'ON' : 'OFF'))) {
      tt.textContent = 'Trend Follow: ' + (state.trend.enabled ? 'ON' : 'OFF');
      tt.style.background = state.trend.enabled ? '#00d4aa' : '#e67e22';
    }
    var tpi = el('ntrTrendPct');
    if (tpi) { tpi.disabled = !state.trend.enabled; tpi.style.opacity = state.trend.enabled ? '1' : '0.5'; }

    renderStockRows();
    renderFetched();
    renderPicked();
    renderPositions();
    renderSummary();
    state.renderMs = performance.now() - t1;
  }

  /* F&O list is re-sorted on: initial build, arrow-toggle, and each 30s
     refresh (_sortDirty set by refreshTrendData / onSortToggle). Row cell
     values (LTP, %Chg, score) still update in place every tick, so the table
     stays live without reordering the DOM constantly. */

  /* Fetched-stocks display (AST renderNiftyTrendList port). Shows exactly the
     stocks the engine currently fetches by whichever method is active:
       - NIFTY Trend Following ON -> F&O stocks on the live NIFTY trend side
         whose daily change% is at/above the set threshold (pct for bullish,
         -pct for bearish), biggest movers first. Green border = currently
         active (enabled + qualifies + cap slot), dim = qualifies but not
         enabled so not traded yet.
       - Trend following OFF -> the manually enabled rows.
     The list re-renders every tick from the live client quote cache, so a
     stock that drops below the threshold disappears from the fetched set the
     same second its quote falls. */
  var _fetchedHtml = '';
  function renderFetched() {
    var box = el('ntrFetched');
    if (!box) return;
    var nc = niftyOperative();
    var out = '';
    if (trendFilterActive()) {
      var thresh = trendPct();
      var rows = [];
      for (var i = 0; i < state.stocks.length; i++) {
        var s = state.stocks[i];
        if (isCommodity(s.sym)) continue;
        var chg = dailyChangePct(s);
        if (isNaN(chg)) continue;
        var ok = (nc === 'BULL' && chg >= thresh) || (nc === 'BEAR' && chg <= -thresh);
        if (!ok) continue;
        rows.push({ s: s, chg: chg });
      }
      rows.sort(function (a, b) { return nc === 'BULL' ? b.chg - a.chg : a.chg - b.chg; });
      if (rows.length) {
        out = '<div style="font-size:9px;color:' + (nc === 'BULL' ? '#00d4aa' : '#ff4d6a') + ';margin-bottom:2px">NIFTY ' + nc +
          ' &middot; fetched ' + rows.length + ' F&amp;O stock' + (rows.length === 1 ? '' : 's') + ' with daily change% ' + (nc === 'BULL' ? '&ge; +' : '&le; -') + thresh + '%</div>';
        for (var r = 0; r < rows.length; r++) {
          var f = rows[r];
          var s2 = f.s;
          var border = s2.active ? '#00d4aa' : '#2d2d50';
          var col = s2.active ? '#d0d0d0' : '#777';
          out += '<span style="display:inline-flex;align-items:center;gap:4px;font-size:10px;background:#12122a;border:1px solid ' + border + ';border-radius:3px;padding:2px 6px;color:' + col + '" title="' + s2.sym.name + ' ' + (f.chg >= 0 ? '+' : '') + f.chg.toFixed(2) + '% daily' + (s2.active ? ' · ACTIVE (traded)' : ' · qualifies, not enabled') + '">' + s2.sym.name +
            ' <b style="color:' + (f.chg >= 0 ? '#00d4aa' : '#ff4d6a') + '">' + (f.chg >= 0 ? '+' : '') + f.chg.toFixed(2) + '%</b></span>';
        }
      } else {
        out = '<span style="font-size:10px;color:#555">No F&amp;O stocks currently qualify at ' + thresh + '% on NIFTY ' + (nc === 'BULL' || nc === 'BEAR' ? nc.toLowerCase() : 'trend unknown') + ' - lower the threshold or wait for stronger daily moves.</span>';
      }
    } else {
      var list = state.stocks.filter(function (s) { return !!s.enabled; });
      if (list.length) {
        out = '<div style="font-size:9px;color:#888;margin-bottom:2px">Trend following OFF - fetching the ' + list.length + ' manually enabled row' + (list.length === 1 ? '' : 's') + ':</div>';
        for (var m = 0; m < list.length; m++) {
          var ms = list[m];
          var mc = dailyChangePct(ms);
          var border2 = ms.active ? '#00d4aa' : '#2d2d50';
          var col2 = ms.active ? '#d0d0d0' : '#777';
          out += '<span style="display:inline-flex;align-items:center;gap:4px;font-size:10px;background:#12122a;border:1px solid ' + border2 + ';border-radius:3px;padding:2px 6px;color:' + col2 + '">' + ms.sym.name +
            ' <b style="color:' + (mc >= 0 ? '#00d4aa' : '#ff4d6a') + '">' + (isNaN(mc) ? '--' : (mc >= 0 ? '+' : '') + mc.toFixed(2) + '%') + '</b></span>';
        }
      } else {
        out = '<span style="font-size:10px;color:#555">No stocks fetched yet - check rows in the F&amp;O table or enable NIFTY Trend Following.</span>';
      }
    }
    if (out !== _fetchedHtml) { _fetchedHtml = out; box.innerHTML = out; }
  }

  /* One section for every manually enabled F&O stock + its picked strike.
     Blue chip = open position on that strike, amber = strike resolved but not
     yet in position, gray = still resolving the chain. */
  var _pickedHtml = '';
  function renderPicked() {
    var box = el('ntrPicked');    var box = el('ntrPicked');
    if (!box) return;
    var list = state.stocks.filter(function (s) { return !!s.enabled; });
    var out = '';
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      var nm = s.sym.name;
      var pos = posAt('ntd:' + nm);
      var inst = '', sub = '', col = '#888';
      if (pos) {
        var symName = nm + ' ';
        inst = (pos.symbol && pos.symbol.indexOf(symName) === 0) ? pos.symbol.slice(symName.length) : (pos.symbol || '');
        sub = '@ ' + fmtNum(pos.entryPrice, 2);
        col = '#66ccff';
      } else if (s.opt && s.opt.strike != null) {
        inst = s.opt.strike + ' ' + s.opt.optionType;
        sub = '@ ' + fmtNum(Number(s.opt.premium) || 0, 2);
        col = '#ffb74d';
      } else {
        inst = 'resolving...';
      }
      out += '<span style="display:inline-flex;align-items:center;gap:4px;font-size:10px;background:#12122a;border:1px solid #2d2d50;border-radius:3px;padding:2px 6px;color:#d0d0d0">' + nm +
        ' <span style="color:' + col + '">' + inst + '</span>' +
        (sub ? ' <span style="color:#888">' + sub + '</span>' : '') + '</span>';
    }
    if (!list.length) out = '<span style="font-size:10px;color:#555">No stocks picked yet - check rows in the F&amp;O table.</span>';
    if (out !== _pickedHtml) { _pickedHtml = out; box.innerHTML = out; }
  }

  function renderStockRows() {
    var tb = el('ntrBody');
    if (!tb) return;
    ensureRows(tb);
    if (state._sortDirty) { state._sortDirty = false; relayout(tb); }
    for (var a = 0; a < state.stocks.length; a++) {
      var s = state.stocks[a];
      var active = s.active;
      if (s._tr.style.opacity !== (active ? '1' : '0.45')) s._tr.style.opacity = active ? '1' : '0.45';
      if (s._cb.checked !== !!s.enabled) s._cb.checked = !!s.enabled;
      if (s._cb.disabled !== false) s._cb.disabled = false;
      var q = quoteForSym(s.sym);
      var ltp = q && q.ltp;
      var chg = q && q.change_pct !== undefined ? Number(q.change_pct) : null;
      setCell(s._cells.ltp, ltp != null ? fmtNum(ltp, 2) : '--');
      setCell(s._cells.chg, chg != null ? (chg >= 0 ? '+' : '') + fmtNum(chg, 2) + '%' : '--');
      setCell(s._cells.score, fmtNum(s.score, 2));
      var clsTxt = s.cls || '--';
      var clsCol = s.cls === 'BULL' ? '#00d4aa' : (s.cls === 'BEAR' ? '#ff4d6a' : '#888');
      var bbs = s.bbZone ? bbShort(s) : '';
      if (bbs) clsTxt += '·' + bbs;
      setCell(s._cells.cls, clsTxt, clsCol);
      setCell(s._cells.status, s.status || (s.inPos ? 'POSITION' : '--'), s.inPos ? '#66ccff' : '#888');
      setCell(s._cells.pnl, s.posPnl ? (s.posPnl >= 0 ? '+' : '') + fmtMoney(s.posPnl) : '--', s.posPnl > 0 ? '#00d4aa' : (s.posPnl < 0 ? '#ff4d6a' : '#666'));
    }
  }

  var groupHeaders = {};
  function groupHeaderEl(label, color) {
    var key = label + '|' + color;
    var h = groupHeaders[key];
    if (h && h._ntrLabel !== label) { h = null; }
    if (!h) {
      h = document.createElement('tr');
      h.className = 'ntr-group';
      h._ntrLabel = label;
      h.innerHTML = '<td colspan="8" style="background:#0e0e24;color:' + color + ';font-size:9px;font-weight:700;padding:4px 8px;text-transform:uppercase;letter-spacing:0.5px">' + label + '</td>';
      groupHeaders[key] = h;
    }
    return h;
  }
  function displayOrder() {
    var arr = state.stocks.slice();
    var minus = state.sortMode === 'minus';
    arr.sort(function (a, b) {
      var ca = dailyChangePct(a), cb = dailyChangePct(b);
      var na = isNaN(ca), nb = isNaN(cb);
      if (na && nb) { var sa = a.sym.name, sb = b.sym.name; return sa < sb ? -1 : sa > sb ? 1 : 0; }
      if (na) return 1;
      if (nb) return -1;
      if (minus) {
        var pa = ca >= 0, pb = cb >= 0;
        if (pa !== pb) return pa ? 1 : -1;  /* negatives first */
        if (pa) return cb - ca;             /* positives: highest -> lowest */
        return ca - cb;                     /* negatives: most bearish -> least bearish */
      }
      return cb - ca;
    });
    return arr;
  }
  function relayout(tb) {
    /* F&O list is displayed ranked by live daily % change (not grouped by
       BULL/BEAR/Neutral - that grouping still drives the pick logic inside
       computeActive). Arrow toggle picks the view: bullish = full list from
       highest daily % to lowest; minus = negative-change stocks first (still
       highest -> lowest) then the positives. */
    var minus = state.sortMode === 'minus';
    var label = minus
      ? 'MINUS — daily % chg: biggest fallers first (most bearish → least bearish), then positives (highest → lowest)'
      : 'BULLISH — daily % chg highest → lowest';
    var seq = [groupHeaderEl(label, minus ? '#ff4d6a' : '#00d4aa')];
    var order = displayOrder();
    for (var i = 0; i < order.length; i++) seq.push(order[i]._tr);
    var cursor = 0;
    for (i = 0; i < seq.length; i++) {
      var node = seq[i];
      var cur = tb.children[cursor];
      if (cur === node) { cursor++; continue; }
      tb.insertBefore(node, cur || null);
      cursor++;
    }
    while (tb.children.length > cursor) tb.removeChild(tb.children[tb.children.length - 1]);
  }

  function ensureRows(tb) {
    if (state._rowsBuilt) return;
    state._rowsBuilt = true;
    for (var i = 0; i < state.stocks.length; i++) {
      var s = state.stocks[i];
      var tr = document.createElement('tr');
      tr.innerHTML = '<td class="ntr-sel"></td><td>' + s.sym.name + '</td><td class="ntr-ltp">--</td><td class="ntr-chg">--</td><td class="ntr-score">--</td><td class="ntr-cls">--</td><td class="ntr-status">--</td><td class="ntr-pnl">--</td>';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!s.enabled;
      cb.addEventListener('change', (function (rec) {
        return function (ev) {
          rec.enabled = !!ev.target.checked;
          saveSettings();
        };
      })(s));
      tr.querySelector('.ntr-sel').appendChild(cb);
      s._tr = tr;
      s._cb = cb;
      s._cells = { ltp: tr.querySelector('.ntr-ltp'), chg: tr.querySelector('.ntr-chg'), score: tr.querySelector('.ntr-score'), cls: tr.querySelector('.ntr-cls'), status: tr.querySelector('.ntr-status'), pnl: tr.querySelector('.ntr-pnl') };
      tr.style.opacity = '0.45';
    }
  }

  function setCell(cell, txt, color) {
    if (!cell) return;
    if (cell.textContent !== txt) {
      cell.textContent = txt;
      if (color) cell.style.color = color;
    }
  }

  function chargesOn() {
    return !!(ntPaper() && ntPaper().getCharges && ntPaper().getCharges());
  }

  function renderPositions() {
    var st = (ntPaper() && ntPaper().getState) ? ntPaper().getState() : null;
    var tb = el('ntrRunBody');
    if (tb) {
      var html = '';
      if (st && st.autoPositions) {
        var keys = Object.keys(st.autoPositions);
        for (var i = 0; i < keys.length; i++) {
          var p = st.autoPositions[keys[i]];
          if (keys[i].indexOf('ntd:') !== 0) continue;
          var q = quoteForSym({ id: p.symbolId, exch: p.symbolExch });
          var cur = (q && q.ltp) ? Number(q.ltp) : p.entryPrice;
          var pnl = (p.side === 'BUY' ? (cur - p.entryPrice) : (p.entryPrice - cur)) * p.qty;
          /* Running/open trades show GROSS P&L only — no broker-charge
             deduction while the trade is open. Charges (entry + exit
             round-trip) are applied ONCE at close and show net in Closed. */
          var col = pnl >= 0 ? '#00d4aa' : '#ff4d6a';
          var guard = (p._slGuard && p._slGuard.hunt) ? '<span style="color:#ff9800">HUNT ' + (p._slGuard.widenedTo != null ? p._slGuard.widenedTo.toFixed(2) : '') + '</span>' : '--';
          var qtyTxt = p.qty;
          if (p.lotSize) qtyTxt = p.qty + ' <span style="font-size:8px;color:#666">(' + (p.lots || Math.round(p.qty / p.lotSize)) + '&times;' + p.lotSize + ')</span>';
          html += '<tr><td>' + p.symbol + '</td><td>' + qtyTxt + '</td><td>' + p.entryPrice.toFixed(2) + '</td><td>' + cur.toFixed(2) + '</td><td style="color:' + col + '">' + (pnl >= 0 ? '+' : '') + fmtMoney(pnl) + '</td><td style="color:#888">' + (p.slPct || 0) + '%/' + (p.targetPct || 0) + '%' + (p.tpPct > 0 ? ' <span style="color:#26a69a">TP ' + p.tpPct + '%</span>' : '') + '</td><td>' + guard + '</td></tr>';
        }
      }
      tb.innerHTML = html || '<tr><td colspan="7" style="color:#555;font-size:9px">No Smart NTrader positions open</td></tr>';
    }
    var tbc = el('ntrClosedBody');
    if (tbc) {
      var h2 = '';
      if (st && st.closed) {
        var n = 0;
        var chOn = chargesOn();
        for (i = 0; i < st.closed.length && n < 10; i++) {
          var t = st.closed[i];
          if ((t.autoKey || '').indexOf('ntd:') !== 0) continue;
          n++;
          var net = (chOn && t.netPnl != null) ? t.netPnl : (t.pnl || 0);
          var col2 = net >= 0 ? '#00d4aa' : '#ff4d6a';
          var qtyT2 = t.qty;
          if (t.lotSize) qtyT2 = t.qty + ' <span style="font-size:8px;color:#666">(' + (t.lots || Math.round(t.qty / t.lotSize)) + '&times;' + t.lotSize + ')</span>';
          h2 += '<tr><td>' + t.symbol + '</td><td>' + qtyT2 + '</td><td>' + (t.entry != null ? t.entry.toFixed(2) : '--') + ' → ' + (t.exit != null ? t.exit.toFixed(2) : '--') + '</td><td style="color:' + col2 + '">' + (net >= 0 ? '+' : '') + fmtMoney(net) + (chOn && t.netPnl != null ? '<br><span style="font-size:8px;color:#888">gross ' + ((t.pnl || 0) >= 0 ? '+' : '') + fmtMoney(t.pnl) + '</span>' : '') + '</td><td style="color:#888">' + (chOn ? fmtMoney(t.charges || 0) : '--') + '</td><td style="color:#888">' + (t.reason || '') + '</td></tr>';
        }
      }
      tbc.innerHTML = h2 || '<tr><td colspan="6" style="color:#555;font-size:9px">No Smart NTrader closed trades yet</td></tr>';
    }
  }

  function renderSummary() {
    var host = el('ntrSummary');
    if (!host) return;
    var st = (ntPaper() && ntPaper().getState) ? ntPaper().getState() : null;
    if (!st) return;
    var chOn = chargesOn();
    var closed = [], open = [];
    if (st.autoPositions) {
      Object.keys(st.autoPositions).forEach(function (k) {
        if (k.indexOf('ntd:') === 0) open.push(st.autoPositions[k]);
      });
    }
    if (st.closed) {
      for (var i = 0; i < st.closed.length; i++) {
        if ((st.closed[i].autoKey || '').indexOf('ntd:') === 0) closed.push(st.closed[i]);
      }
    }
    var realized = 0;
    for (i = 0; i < closed.length; i++) realized += (chOn && closed[i].netPnl != null) ? closed[i].netPnl : (closed[i].pnl || 0);
    var unreal = 0;
    /* Live P&L is GROSS: running trades never deduct broker charges — charges
       (entry + exit round-trip) are applied once at close and show in the
       realized P&L. */
    for (i = 0; i < open.length; i++) {
      var p = open[i];
      var q = quoteForSym({ id: p.symbolId, exch: p.symbolExch });
      if (q && q.ltp) {
        unreal += (p.side === 'BUY' ? (Number(q.ltp) - p.entryPrice) : (p.entryPrice - Number(q.ltp))) * p.qty;
      }
    }
    var live = realized + unreal;
    var wins = closed.filter(function (t) { return ((chOn && t.netPnl != null) ? t.netPnl : (t.pnl || 0)) > 0; }).length;
    var total = closed.length;
    var wr = total ? wins / total * 100 : 0;
    var chSum = 0;
    for (i = 0; i < closed.length; i++) chSum += (closed[i].charges || 0);
    var html =
      '<div class="acard" style="flex:1"><div class="label">Smart Live P&L</div><div class="value" style="color:' + (live >= 0 ? '#00d4aa' : '#ef5350') + '">' + (live >= 0 ? '+' : '') + fmtMoney(live) + '</div></div>' +
      '<div class="acard" style="flex:1"><div class="label">Smart Realized P&L</div><div class="value" style="color:' + (realized >= 0 ? '#00d4aa' : '#ef5350') + '">' + (realized >= 0 ? '+' : '') + fmtMoney(realized) + '</div></div>' +
      '<div class="acard" style="flex:1"><div class="label">Smart Win Rate</div><div class="value" style="color:' + (wr >= 50 ? '#00d4aa' : '#ff9800') + '">' + fmtNum(wr, 1) + '%</div></div>' +
      '<div class="acard" style="flex:1"><div class="label">Smart Trades (W/L)</div><div class="value" style="font-size:13px">' + total + ' (' + wins + 'W / ' + (total - wins) + 'L)</div></div>' +
      '<div class="acard" style="flex:1"><div class="label">Smart Charges</div><div class="value" style="color:#ff9800;font-size:13px">' + (chOn ? '-' : '') + fmtMoney(chSum) + '</div></div>';
    if (state._summaryHtml !== html) {
      state._summaryHtml = html;
      host.innerHTML = html;
    }
  }

  /* ---------------- public API ---------------- */

  function start() {
    if (state.running) return;
    state.running = true;
    warmupUniverse();
    setText('ntrToggle', 'Stop');
    var toggleBtn = el('ntrToggle');
    if (toggleBtn) { toggleBtn.textContent = 'Stop'; toggleBtn.classList.add('warn'); }
  }
  function stop() {
    if (!state.running) return;
    state.running = false;
    resetGuardAll();
    var toggleBtn = el('ntrToggle');
    if (toggleBtn) { toggleBtn.textContent = 'Start'; toggleBtn.classList.remove('warn'); }
  }
  function toggleRunning() { state.running ? stop() : start(); }

  function onSortToggle() {
    state.sortMode = (state.sortMode === 'minus') ? 'bullish' : 'minus';
    state._sortDirty = true;
    syncSortUI();
    saveSettings();
  }
  function syncSortUI() {
    var b = el('ntrSortToggle');
    if (b) b.textContent = (state.sortMode === 'minus') ? '▼ MINUS' : '▲ BULLISH';
    var c = el('ntrStockCount');
    if (c) c.textContent = state.stocks.length + ' stocks';
  }
  function syncCountTotal() {
    var t = el('ntrCount');
    if (t) t.value = Math.max(0, (state.bullCount || 0) + (state.bearCount || 0));
    state.count = (state.bullCount || 0) + (state.bearCount || 0);
  }
  function onBullCountChange() {
    var v = parseInt(el('ntrBullCount').value, 10);
    if (!isNaN(v)) {
      state.bullCount = Math.max(0, Math.min(50, v));
      syncCountTotal();
      state._sortDirty = true;
      saveSettings();
    }
  }
  function onBearCountChange() {
    var v = parseInt(el('ntrBearCount').value, 10);
    if (!isNaN(v)) {
      state.bearCount = Math.max(0, Math.min(50, v));
      syncCountTotal();
      state._sortDirty = true;
      saveSettings();
    }
  }
  /* Trade cap controls: "Max trades" (fixed cap) and "Auto trades"
     (unlimited, overrides the cap) are mutually exclusive - enabling one
     disables and fades out the other. */
  function onMaxTradesToggle() {
    state.tradeCap.enabled = !state.tradeCap.enabled;
    if (state.tradeCap.enabled) state.tradeCap.auto = false;
    saveSettings();
    syncTradesUI();
  }
  function onAutoTradesToggle() {
    state.tradeCap.auto = !state.tradeCap.auto;
    if (state.tradeCap.auto) state.tradeCap.enabled = false;
    saveSettings();
    syncTradesUI();
  }
  function onMaxTradesCountChange() {
    var v = parseInt(el('ntrMaxTradesCount').value, 10);
    state.tradeCap.count = (!isNaN(v) && v > 0) ? Math.min(50, v) : 5;
    saveSettings();
    syncTradesUI();
  }
  function syncTradesUI() {
    var mt = el('ntrMaxTrades'), mtn = el('ntrMaxTradesCount'), at = el('ntrAutoTrades'), st = el('ntrTradesStatus');
    var maxOn = !!state.tradeCap.enabled, autoOn = !!state.tradeCap.auto;
    if (mt) { mt.checked = maxOn; mt.disabled = !!autoOn; mt.style.opacity = autoOn ? '0.35' : '1'; }
    if (mtn) { mtn.value = state.tradeCap.count; mtn.disabled = !maxOn || autoOn; mtn.style.opacity = (maxOn && !autoOn) ? '1' : '0.35'; }
    if (at) { at.checked = autoOn; at.disabled = !!maxOn; at.style.opacity = maxOn ? '0.35' : '1'; }
    if (st) st.textContent = autoOn ? 'AUTO (unlimited)' : (maxOn ? 'MAX ' + state.tradeCap.count : '');
  }
  function onSlChange() { state.slPct = Math.max(0, parseFloat(el('ntrSl').value) || 0); saveSettings(); }
  function onTpChange() { state.tpPct = Math.max(0, parseFloat(el('ntrTp').value) || 0); saveSettings(); }
  function onFixedTpChange() { state.fixedTp = Math.max(0, parseFloat(el('ntrFixedTp').value) || 0); saveSettings(); }
  function onMarginChange() { state.margin = Math.max(0, parseFloat(el('ntrMargin').value) || 0); saveSettings(); }
  function onLotSizeChange() {
    var v = parseInt(el('ntrLotSize').value, 10);
    state.lotSize = (v > 0) ? v : null;
    saveSettings();
  }
  function onLotsChange() {
    var v = parseInt(el('ntrLots').value, 10);
    state.lots = (v > 0) ? v : 1;
    saveSettings();
  }
  function onStrikeModeChange() {
    state.strike.mode = el('ntrStrikeMode').value || 'both_atm';
    saveSettings();
  }
  function onStrikeCountChange() {
    var v = parseInt(el('ntrStrikeCount').value, 10);
    state.strike.count = (v > 0) ? v : 3;
    saveSettings();
  }
  function onGreenOnlyChange() {
    state.strike.positiveOnly = !!el('ntrGreenOnly').checked;
    saveSettings();
  }
  function onPremiumChartChange() {
    state.premiumChart = !!el('ntrPremiumChart').checked;
    saveSettings();
    syncPremiumChartUI();
  }
  function syncPremiumChartUI() {
    var pc = el('ntrPremiumChart');
    if (pc) pc.checked = !!state.premiumChart;
  }
  function syncGreenUI() {
    var g = el('ntrGreenOnly');
    if (g) g.checked = !!state.strike.positiveOnly;
  }
  function onLimitOrderChange() {
    state.limitOrder.enabled = !!el('ntrLimitOrder').checked;
    saveSettings();
    syncLimitUI();
  }
  function syncLimitUI() {
    var lo = el('ntrLimitOrder');
    if (lo) lo.checked = !!state.limitOrder.enabled;
  }
  function onGuardBufChange() { state.guardBuf = Math.max(0, parseFloat(el('ntrGuardBuf').value) || 0); saveSettings(); }
  function onTrailSlPctChange() {
    var v = parseFloat(el('ntrTrailSlPct').value);
    state.trailSl.pct = (!isNaN(v) && v > 0) ? Math.min(50, v) : 1;
    saveSettings();
    syncSlUI();
  }
  function onOverallSlToggle() {
    state.overallSl.enabled = el('ntrOverallSl') ? el('ntrOverallSl').checked : false;
    saveSettings();
    syncSlUI();
  }
  function onOverallSlPctChange() {
    var v = parseFloat(el('ntrOverallSlPct').value);
    state.overallSl.pct = (!isNaN(v) && v > 0) ? Math.min(100, v) : 5;
    saveSettings();
    syncSlUI();
  }
  function onSlModeChange() {
    var auto = el('ntrSlAuto') ? el('ntrSlAuto').checked : false;
    var manual = el('ntrSlManual') ? el('ntrSlManual').checked : false;
    var trail = el('ntrSlTrail') ? el('ntrSlTrail').checked : false;
    var mode = trail ? 'trail' : (manual ? 'manual' : (auto ? 'auto' : state.slMode));
    if (mode !== state.slMode) {
      state.slMode = mode;
      if (mode === 'manual') resetGuardAll();
    }
    saveSettings();
    syncSlUI();
  }
  /* AST-style fade/override: Auto SL / Manual SL / Trail SL mutually fade each
     other - the active mode's controls are live, the other two fade out
     (disabled) until the active one is un-ticked. */
  function syncSlUI() {
    var auto = state.slMode === 'auto', manual = state.slMode === 'manual', trail = state.slMode === 'trail';
    var sa = el('ntrSlAuto'), sm = el('ntrSlManual'), st = el('ntrSlTrail');
    if (sa) sa.checked = auto;
    if (sm) sm.checked = manual;
    if (st) st.checked = trail;
    var fade = function (e, on) {
      if (!e) return;
      e.disabled = on;
      e.style.opacity = on ? '0.35' : '1';
      e.style.pointerEvents = on ? 'none' : '';
      e.style.cursor = on ? 'not-allowed' : '';
      var lbl = e.closest ? e.closest('label') : null;
      if (lbl) { lbl.style.opacity = on ? '0.35' : '1'; lbl.style.pointerEvents = on ? 'none' : ''; lbl.style.cursor = on ? 'not-allowed' : ''; }
    };
    fade(sa, manual || trail);
    fade(sm, auto || trail);
    fade(st, auto || manual);
    var sl = el('ntrSl');
    if (sl) { sl.disabled = !manual; sl.style.opacity = manual ? '1' : '0.35'; }
    var tsl = el('ntrTrailSlPct');
    if (tsl) { tsl.disabled = !trail; tsl.style.opacity = trail ? '1' : '0.35'; }
    var gb = el('ntrGuardBuf');
    if (gb) { gb.disabled = !auto; gb.style.opacity = auto ? '1' : '0.35'; }
    var osl = el('ntrOverallSl'), osp = el('ntrOverallSlPct');
    if (osl) osl.checked = !!state.overallSl.enabled;
    if (osp) { osp.value = state.overallSl.pct; osp.disabled = !state.overallSl.enabled; osp.style.opacity = state.overallSl.enabled ? '1' : '0.35'; }
  }
  function onNiftyTfChange() { state.niftyTf = el('ntrNiftyTf').value; state.series[symKey(NIFTY)] = undefined; NiftyChart.onTfChange(); saveSettings(); }
  function onStockTfChange() { state.stockTf = el('ntrStockTf').value; state.series = {}; if (typeof StrikeChart !== 'undefined' && StrikeChart.reset) StrikeChart.reset(); saveSettings(); }

  function onShow() {
    state.visible = true;
    NiftyChart.resize();
    if (state.running) render();
  }
  function onHide() { state.visible = false; }

  function init() {
    loadSettings();
    var uni = stockUniverse();
    state.stocks = uni.map(function (s) {
      return {
        sym: s, enabled: false, active: false, score: 0, cls: '...',
        status: '', bbZone: '', bbOb: false, bbOs: false,
        opt: null, optAt: 0, firedBar: 0, inPos: false, posQty: 0, posPnl: 0,
        _tr: null, _cb: null, _cells: null
      };
    });
    state.byName = {};
    state.stocks.forEach(function (s) { state.byName[s.sym.name] = s; });
    /* Re-enable stocks the user had selected in a prior session. */
    try {
      var j = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      if (Array.isArray(j.enabledStocks)) {
        j.enabledStocks.forEach(function (nm) { var s = state.byName[nm]; if (s) s.enabled = true; });
      }
    } catch (e) {}
    /* Lot sizes for margin-aware quantity. */
    if (window.HftPool || true) {
      fetch('/api/lot_sizes', { method: 'GET' }).then(function (r) { return r.json(); }).then(function (d) {
        if (d && d.status === 'success' && d.data && d.data.by_prefix) {
          state.lotsByPrefix = d.data.by_prefix || {};
        }
      }).catch(function () {});
    }
    /* Subscribe the universe to the quote feed so auto-scoring has live data. */
    if (window.fetch) {
      var secs = state.stocks.map(function (s) { return { security_id: s.sym.id, exchange_segment: s.sym.exch || 'NSE_EQ' }; });
      secs.push({ security_id: NIFTY.id, exchange_segment: 'IDX_I' });
      fetch('/api/quotes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ securities: secs })
      }).catch(function () {});
    }
    wireUI();
    syncCountTotal();
    state._sortDirty = true;
    setInterval(tick, POLL_MS);
    setInterval(refreshTrendData, TREND_REFRESH_MS);
    setInterval(statusPulse, POLL_MS);
    NiftyChart.init();
    StrikeChart.init();
    state.visible = true;
    render();
  }
  function wireUI() {
    var b = el('ntrToggle');
    if (b) b.addEventListener('click', toggleRunning);
    var bc = el('ntrBullCount');
    if (bc) { bc.value = state.bullCount; bc.addEventListener('change', onBullCountChange); }
    var br = el('ntrBearCount');
    if (br) { br.value = state.bearCount; br.addEventListener('change', onBearCountChange); }
    var mto = el('ntrMaxTrades');
    if (mto) { mto.addEventListener('change', onMaxTradesToggle); }
    var mtc = el('ntrMaxTradesCount');
    if (mtc) { mtc.value = state.tradeCap.count; mtc.addEventListener('change', onMaxTradesCountChange); }
    var ato = el('ntrAutoTrades');
    if (ato) { ato.addEventListener('change', onAutoTradesToggle); }
    syncTradesUI();
    var st = el('ntrSortToggle');
    if (st) st.addEventListener('click', onSortToggle);
    syncSortUI();
    var sa = el('ntrSlAuto');
    if (sa) { sa.checked = (state.slMode === 'auto'); sa.addEventListener('change', onSlModeChange); }
    var sm = el('ntrSlManual');
    if (sm) { sm.checked = (state.slMode === 'manual'); sm.addEventListener('change', onSlModeChange); }
    var stl = el('ntrSlTrail');
    if (stl) { stl.checked = (state.slMode === 'trail'); stl.addEventListener('change', onSlModeChange); }
    var tsl = el('ntrTrailSlPct');
    if (tsl) { tsl.value = state.trailSl.pct; tsl.addEventListener('change', onTrailSlPctChange); }
    var osl = el('ntrOverallSl');
    if (osl) { osl.checked = !!state.overallSl.enabled; osl.addEventListener('change', onOverallSlToggle); }
    var osp = el('ntrOverallSlPct');
    if (osp) { osp.value = state.overallSl.pct; osp.addEventListener('change', onOverallSlPctChange); }
    syncSlUI();
    var gb = el('ntrGuardBuf');
    if (gb) { gb.value = state.guardBuf; gb.addEventListener('change', onGuardBufChange); }
    var sl = el('ntrSl');
    if (sl) { sl.value = state.slPct; sl.addEventListener('change', onSlChange); }
    var tp = el('ntrTp');
    if (tp) { tp.value = state.tpPct; tp.addEventListener('change', onTpChange); }
    var ftp = el('ntrFixedTp');
    if (ftp) { ftp.value = state.fixedTp; ftp.addEventListener('change', onFixedTpChange); }
    var m = el('ntrMargin');
    if (m) { m.value = state.margin; m.addEventListener('change', onMarginChange); }
    var ls = el('ntrLotSize');
    if (ls) { ls.value = state.lotSize || ''; ls.addEventListener('change', onLotSizeChange); }
    var lq = el('ntrLots');
    if (lq) { lq.value = state.lots; lq.addEventListener('change', onLotsChange); }
    var sm = el('ntrStrikeMode');
    if (sm) { sm.value = state.strike.mode; sm.addEventListener('change', onStrikeModeChange); }
    var sc = el('ntrStrikeCount');
    if (sc) { sc.value = state.strike.count; sc.addEventListener('change', onStrikeCountChange); }
    var gr = el('ntrGreenOnly');
    if (gr) { gr.checked = !!state.strike.positiveOnly; gr.addEventListener('change', onGreenOnlyChange); }
    syncGreenUI();
    var pc = el('ntrPremiumChart');
    if (pc) { pc.checked = !!state.premiumChart; pc.addEventListener('change', onPremiumChartChange); }
    syncPremiumChartUI();
    var lo = el('ntrLimitOrder');
    if (lo) { lo.checked = !!state.limitOrder.enabled; lo.addEventListener('change', onLimitOrderChange); }
    syncLimitUI();
    var nt = el('ntrNiftyTf');
    if (nt) { nt.value = state.niftyTf; nt.addEventListener('change', onNiftyTfChange); }
    var stf = el('ntrStockTf');
    if (stf) { stf.value = state.stockTf; stf.addEventListener('change', onStockTfChange); }
    var tt = el('ntrTrendToggle');
    if (tt) tt.addEventListener('click', onTrendToggle);
    var tpi = el('ntrTrendPct');
    if (tpi) { tpi.value = state.trend.pct; tpi.addEventListener('change', onTrendPctChange); }
    syncTrendUI();
    var ce = el('ntrCondEnable');
    if (ce) { ce.checked = !!state.condition.enabled; ce.addEventListener('change', onCondEnableChange); }
    var lk = el('ntrCondLink');
    if (lk) { lk.value = state.condition.link; lk.addEventListener('change', onCondChange); }
    var bd = el('ntrCondBullDir');
    if (bd) { bd.value = state.condition.bull.dir; bd.addEventListener('change', onCondChange); }
    var bc = el('ntrCondBullConn');
    if (bc) { bc.value = state.condition.bull.connector; bc.addEventListener('change', onCondChange); }
    var bz = el('ntrCondBullZone');
    if (bz) { bz.value = state.condition.bull.zone; bz.addEventListener('change', onCondChange); }
    var rd = el('ntrCondBearDir');
    if (rd) { rd.value = state.condition.bear.dir; rd.addEventListener('change', onCondChange); }
    var rc = el('ntrCondBearConn');
    if (rc) { rc.value = state.condition.bear.connector; rc.addEventListener('change', onCondChange); }
    var rz = el('ntrCondBearZone');
    if (rz) { rz.value = state.condition.bear.zone; rz.addEventListener('change', onCondChange); }
    syncCondUI();
  }

  function onTrendToggle() {
    state.trend.enabled = !state.trend.enabled;
    state._sortDirty = true;
    saveSettings();
    syncTrendUI();
  }
  function onTrendPctChange() {
    var v = parseFloat(el('ntrTrendPct').value);
    state.trend.pct = (v > 0) ? v : 2.5;
    state._sortDirty = true;
    saveSettings();
    syncTrendUI();
  }
  function syncTrendUI() {
    var tt = el('ntrTrendToggle');
    if (tt) {
      tt.textContent = 'Trend Follow: ' + (state.trend.enabled ? 'ON' : 'OFF');
      tt.style.background = state.trend.enabled ? '#00d4aa' : '#e67e22';
    }
    var tpi = el('ntrTrendPct');
    if (tpi) { tpi.value = state.trend.pct; tpi.disabled = !state.trend.enabled; tpi.style.opacity = state.trend.enabled ? '1' : '0.5'; }
    /* With NIFTY Trend Following on, the trend gate already decides which
       stocks qualify per side, so the manual Bull/Bear caps are inactive
       (faded out). */
    var ids = ['ntrBullCount', 'ntrBearCount', 'ntrCount'];
    for (var i = 0; i < ids.length; i++) {
      var e = el(ids[i]);
      if (!e) continue;
      e.disabled = !!state.trend.enabled;
      e.style.opacity = state.trend.enabled ? '0.35' : '1';
    }
  }

  function onCondEnableChange() {
    state.condition.enabled = !!el('ntrCondEnable').checked;
    state._sortDirty = true;
    saveSettings();
    syncCondUI();
  }
  function onCondChange() {
    var bull = state.condition.bull, bear = state.condition.bear;
    var lk = el('ntrCondLink'); if (lk) state.condition.link = lk.value === 'or' ? 'or' : 'and';
    var bd = el('ntrCondBullDir'); if (bd) bull.dir = bd.value === 'bearish' ? 'bearish' : 'bullish';
    var bc = el('ntrCondBullConn'); if (bc) bull.connector = bc.value === 'or' ? 'or' : 'and';
    var bz = el('ntrCondBullZone'); if (bz) bull.zone = bz.value || 'any';
    var rd = el('ntrCondBearDir'); if (rd) bear.dir = rd.value === 'bullish' ? 'bullish' : 'bearish';
    var rc = el('ntrCondBearConn'); if (rc) bear.connector = rc.value === 'or' ? 'or' : 'and';
    var rz = el('ntrCondBearZone'); if (rz) bear.zone = rz.value || 'any';
    state._sortDirty = true;
    saveSettings();
    syncCondUI();
  }
  function syncCondUI() {
    var ce = el('ntrCondEnable');
    if (ce) ce.checked = !!state.condition.enabled;
    var ids = ['ntrCondLink', 'ntrCondBullDir', 'ntrCondBullConn', 'ntrCondBullZone', 'ntrCondBearDir', 'ntrCondBearConn', 'ntrCondBearZone'];
    for (var i = 0; i < ids.length; i++) {
      var e = el(ids[i]);
      if (!e) continue;
      e.disabled = !state.condition.enabled;
      e.style.opacity = state.condition.enabled ? '1' : '0.5';
    }
  }

  window.SmartNTrader = {
    init: init,
    start: start,
    stop: stop,
    toggleRunning: toggleRunning,
    onShow: onShow,
    onHide: onHide,
    getState: function () { return state; },
    running: function () { return state.running; },
    _dbgIndicators: indicators,
    _dbgEntryPlan: entryPlan,
    _dbgRowCond: rowCondMet,
    _dbgCondState: function () {
      return {
        enabled: state.condition.enabled,
        bull: state.condition.bull, bear: state.condition.bear,
        cond: state.cond, nifty: state.nifty.current, bb: state.nifty.bb
      };
    },
    _dbgSideGroups: sideGroups,
    _dbgComputeActive: computeActive,
    _dbgTrendFilter: trendFilterActive,
    _dbgTrendQualify: trendSideQualify,
    _dbgOpenTrades: openTradeCount,
    _dbgTradeCapReached: tradeCapReached,
    _dbgFnoLimit: function (side, q, ltp, off) {
      return (ntPaper() && ntPaper().fnoLimitPrice) ? ntPaper().fnoLimitPrice(side, q, ltp, off) : -1;
    },
    _dbgTryResolve: function (name, side) {
      var s = state.byName[name];
      if (s) resolveAndEnter(s, side, state.nifty);
    },
    _dbgSlPctFor: slPctFor,
    _dbgSlGuardActive: slGuardActive,
    _dbgAutoSl: autoSlPctFor,
    _dbgSlTrail: slTrailPctFor,
    _dbgOverallSl: overallSlBreached,
    _dbgExitAll: exitAllPositions,
    _dbgStrikeChart: function () {
      return (typeof StrikeChart !== 'undefined' && StrikeChart.dbg) ? StrikeChart.dbg() : null;
    },
    _dbgStrikeSet: function (name) {
      var s = state.byName[name];
      if (s && typeof StrikeChart !== 'undefined' && StrikeChart.setStock) StrikeChart.setStock(s);
    },
    _dbgRenderPicked: renderPicked,
    _dbgCondRowGate: condRowGate,
    _dbgCondAllows: condAllows,
    _dbgCondGateEval: condGateEval,
    _dbgDisplayOrder: function () {
      return displayOrder().map(function (s) { return s.sym.name + ':' + (isNaN(dailyChangePct(s)) ? '--' : dailyChangePct(s).toFixed(2)); });
    },
    _dbgCondGateMs: function (n) {
      var N = n || 100000;
      var t = performance.now();
      for (var i = 0; i < N; i++) condGateEval();
      return (performance.now() - t) / N * 1000;
    },
    _dbgCondAllowsMs: function (n) {
      var N = n || 100000;
      var t = performance.now();
      var sc = state.stocks;
      for (var i = 0; i < N; i++) condAllows(sc[i % sc.length].cls);
      return (performance.now() - t) / N * 1000;
    }
  };
})();
