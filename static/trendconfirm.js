/* NIFTY trend CONFIRMATION + HYSTERESIS layer (shared).
   Purpose: the engines' fast NIFTY signals (EMA9/21 cross, RSI/Bollinger %B
   reversals) flip BULL/BEAR on momentary intraday noise, which makes trend
   following open strikes on the wrong side. This module:
     1. reads a SLOWER "long" regime straight off NIFTY 15-min candles
        (price vs a slow EMA + its slope), and
     2. runs a direction state machine that only COMMITS a flip after the new
        fast direction has persisted for a minimum wall-clock hold, with the
        15-min regime backing it, and never re-flips within a cooldown.
   Pure + deterministic (ES5); no DOM/timing deps. Each engine passes its own
   fast signal ('BULL'|'BEAR'|null), the 15-min regime ('BULL'|'BEAR'|'RANGE'|
   null) and a timestamp; the returned state is the CONFIRMED direction that
   engines must use for every trend-side decision (entries + flips). */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  function emaSeries(vals, period) {
    var out = [], i, prev;
    for (i = 0; i < vals.length; i++) {
      var v = Number(vals[i]);
      if (!isFinite(v)) { out.push(prev != null ? prev : 0); continue; }
      if (i === 0) { prev = v; out.push(v); continue; }
      prev = v * (2 / (period + 1)) + prev * (1 - 2 / (period + 1));
      out.push(prev);
    }
    return out;
  }

  /* Slow "long" regime straight off a candle array ({time,open,high,low,close}).
     Adaptive slow EMA period so early sessions (few 15-min bars) still degrade
     gracefully to a 25-bar floor, otherwise returns {dir:null}. A 0.15% band
     around the EMA is treated as neutral so tiny overshoots do not flip the
     regime. */
  function regime(candles) {
    if (!candles || candles.length < 25) return { dir: null, bars: candles ? candles.length : 0, price: null, ema: null, slope: null };
    var closes = [];
    for (var i = 0; i < candles.length; i++) {
      var c = Number(candles[i].close);
      closes.push(isFinite(c) ? c : (closes.length ? closes[closes.length - 1] : 0));
    }
    var n = closes.length;
    var period = n >= 90 ? 90 : (n >= 60 ? 60 : (n >= 40 ? 40 : 25));
    var e = emaSeries(closes, period);
    var iL = n - 1;
    var price = closes[iL];
    var ema = e[iL];
    var back = Math.max(0, iL - 3);
    var prev = e[back];
    var slope = ema - prev;
    var band = Math.max(Math.abs(ema) * 0.0015, 0.05);
    var dir;
    if (price > ema + band && slope > 0) dir = 'BULL';
    else if (price < ema - band && slope < 0) dir = 'BEAR';
    else dir = 'RANGE';
    return { dir: dir, bars: n, period: period, price: price, ema: ema, slope: slope };
  }

  function opp(d) { return d === 'BULL' ? 'BEAR' : d === 'BEAR' ? 'BULL' : null; }

  function create() {
    return {
      dir: null,            /* CONFIRMED direction engines must use */
      since: 0,             /* when the confirmed direction was committed */
      pending: null,        /* candidate being watched ('BULL'|'BEAR'|null) */
      pendingSince: 0,
      pendingHold: 0,       /* hold budget currently required (ms) */
      lastFlipAt: 0,
      flips: 0
    };
  }

  /* Defaults (ms / counts):
     agreeHold     - fast + 15-min regime both point the same way
     medHold       - 15-min regime is neutral/unknown (only momentum available)
     overrideHold  - fast fights the (still old) 15-min regime; only a strong,
                     sustained push may flip the confirmed direction
     readings      - consecutive engine reads the candidate must survive
     cooldown      - minimum time between two confirmed flips (anti-oscillation) */
  var DEFAULTS = {
    agreeHold: 90 * 1000,
    medHold: 180 * 1000,
    overrideHold: 300 * 1000,
    readings: 3,
    cooldown: 240 * 1000
  };

  /* Advance the state machine with the latest raw fast signal. Mutates and
     returns `st`. Returns {st, changed} convenience too. */
  function step(st, fast, htf, now, opts) {
    var o = opts || {};
    var agreeHold = o.agreeHold != null ? o.agreeHold : DEFAULTS.agreeHold;
    var medHold = o.medHold != null ? o.medHold : DEFAULTS.medHold;
    var overrideHold = o.overrideHold != null ? o.overrideHold : DEFAULTS.overrideHold;
    var readings = o.readings != null ? o.readings : DEFAULTS.readings;
    var cooldown = o.cooldown != null ? o.cooldown : DEFAULTS.cooldown;
    var changed = false;

    fast = (fast === 'BULL' || fast === 'BEAR') ? fast : null;
    htf = (htf === 'BULL' || htf === 'BEAR' || htf === 'RANGE') ? htf : null;

    if (fast === st.dir) { st.pending = null; st.pendingSince = 0; st.pendingHold = 0; return { st: st, changed: false }; }

    /* First confirmed direction: seed immediately when the regime does not
       oppose (unknown/neutral counts as clear enough for a cold start). */
    if (st.dir === null) {
      if (fast === null) { st.pending = null; st.pendingSince = 0; st.pendingHold = 0; return { st: st, changed: false }; }
      if (htf === opp(fast)) {
        /* Cold start against the slow regime: start (but do not reset on every
           read) an override timer and let it elapse below before committing. */
        if (st.pending !== fast) {
          st.pending = fast; st.pendingSince = now; st.pendingHold = overrideHold;
        }
        if (now - st.pendingSince < overrideHold) return { st: st, changed: false };
        if (st.lastFlipAt && now - st.lastFlipAt < cooldown && st.flips > 0) return { st: st, changed: false };
        st.dir = fast; st.since = now; st.lastFlipAt = now; st.flips += 1;
        st.pending = null; st.pendingSince = 0; st.pendingHold = 0;
        return { st: st, changed: true };
      }
      st.dir = fast; st.since = now; st.lastFlipAt = now; st.pending = null;
      st.pendingSince = 0; st.pendingHold = 0;
      return { st: st, changed: true };
    }

    /* Candidate is a real flip (including to neutral). Pick the hold budget. */
    var hold;
    if (fast === null) {
      /* Dropping to neutral: if the slow regime still confirms the old side,
         treat it like an override (needs a long, sustained pause). */
      hold = (htf === st.dir) ? overrideHold : agreeHold;
    } else if (htf === fast) {
      hold = agreeHold;
    } else if (htf === null || htf === 'RANGE') {
      hold = medHold;
    } else {
      hold = overrideHold; /* htf still points at the old direction */
    }

    if (st.pending !== fast) {
      st.pending = fast; st.pendingSince = now; st.pendingHold = hold;
      return { st: st, changed: false };
    }
    if (hold !== st.pendingHold) { st.pendingSince = now; st.pendingHold = hold; }
    if (now - st.pendingSince < hold) return { st: st, changed: false };

    /* Respect the anti-oscillation cooldown between confirmed flips. */
    if (st.lastFlipAt && now - st.lastFlipAt < cooldown && st.flips > 0) return { st: st, changed: false };

    st.dir = fast; st.since = now; st.lastFlipAt = now; st.flips += 1;
    st.pending = null; st.pendingSince = 0; st.pendingHold = 0;
    return { st: st, changed: true };
  }

  function status(st) {
    if (!st) return '';
    var txt = st.dir === 'BULL' ? 'BULL (confirmed)' : st.dir === 'BEAR' ? 'BEAR (confirmed)' : 'neutral';
    if (st.pending !== null) {
      txt += ' · pending ' + (st.pending === 'BULL' ? 'BULL' : st.pending === 'BEAR' ? 'BEAR' : 'neutral');
      var left = Math.max(0, Math.round((st.pendingSince + st.pendingHold - Date.now()) / 1000));
      txt += ' ~' + left + 's';
    }
    return txt;
  }

  window.TrendConfirm = {
    emaSeries: emaSeries,
    regime: regime,
    opp: opp,
    create: create,
    step: step,
    status: status,
    DEFAULTS: DEFAULTS
  };
})();
