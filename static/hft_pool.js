/* ============================================================
   HFT DATA POOL
   One authoritative, shared candle/quote source that every
   strategy-runner tab reads from.

   Why a pool:
     - One fetch per (symbol x timeframe) serves every strategy that
       needs that series (single-flight + TTL + bar-current freshness).
     - The pool returns the SAME candle array reference until a refresh,
       so indicator series cached by the shared AE evaluator (a WeakMap
       keyed by array identity) are computed EXACTLY ONCE per bar no
       matter how many strategies / tabs read them.
     - Quotes come from the live WebSocket-broadcast clientQuotes map
       (the server's realtime source of truth), never a stale local copy.

   Accuracy guarantees:
     - Always requests /api/candles with force:1 so the server patches
       the last bar with the live LTP and subscribes the contract to the
       feed; the server itself is single-flight + cached per key.
     - Client single-flight: concurrent callers share one in-flight request.
     - A failed fetch never overwrites a good snapshot (stale fallback).
   ============================================================ */
(function () {
  if (window.HftPool) return;

  var CANDLE_TTL = 60 * 1000;
  var BAR_GRACE_MS = 150 * 1000;

  var store = {};
  var subs = [];

  /* One shared, live-patched copy per pool key. The pool hands every reader the
     SAME patched array (same identity + same content) until either the raw
     candles refetch OR the live feed LTP for that symbol changes, so the
     content-keyed indicator cache computes each series once and every strategy
     on the symbol reads the identical values. */
  var patchedStore = {};

  function keyFor(symbol, tf, days) {
    return String(symbol.id) + ':' + (symbol.exch || '') + ':' + (tf || '') + ':' + (days || 0);
  }

  function barMins(tf) {
    if (tf === 'day') return 1440;
    if (tf === 'week') return 10080;
    if (tf === 'month') return 43200;
    if (tf === 'year') return 525600;
    var n = parseInt(tf, 10);
    return (!isNaN(n) && n > 0) ? n : 5;
  }

  function lastBarTime(candles) {
    return (candles && candles.length) ? candles[candles.length - 1].time : 0;
  }

  function barIsCurrent(tf, ts) {
    if (!ts) return false;
    return (Date.now() / 1000 - ts) < (barMins(tf) * 60 + BAR_GRACE_MS / 1000);
  }

  function fetchCandles(symbol, tf, days) {
    return fetch('/api/candles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        security_id: symbol.id,
        exchange_segment: symbol.exch,
        instrument_type: symbol.inst || 'INDEX',
        timeframe: tf,
        force: 1,
        period_days: days || null
      })
    }).then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.status === 'success' && Array.isArray(d.data) && d.data.length) return d.data;
        return null;
      });
  }

  function fireBar() {
    for (var i = 0; i < subs.length; i++) {
      try { subs[i](); } catch (e) {}
    }
  }

  function getCandles(symbol, tf, days, ttl) {
    var k = keyFor(symbol, tf, days);
    var ttlMs = (ttl && ttl > 0) ? ttl : CANDLE_TTL;
    var now = Date.now();
    var e = store[k];
    if (e && e.candles && now - e.at < ttlMs) {
      return Promise.resolve(e.candles);
    }
    if (e && e.promise) return e.promise;
    if (!e) {
      e = store[k] = { candles: null, at: 0, lastBar: 0, promise: null };
    }
    var p = fetchCandles(symbol, tf, days).then(function (arr) {
      var cur = store[k] || (store[k] = { candles: null, at: 0, lastBar: 0, promise: null });
      if (arr) {
        var prev = cur.candles;
        var lb = lastBarTime(arr);
        cur.candles = arr;
        cur.at = Date.now();
        cur.lastBar = lb;
        if (prev && lb !== lastBarTime(prev)) fireBar();
      } else if (cur.candles) {
        cur.at = Date.now();
      }
      return cur.candles || [];
    }).finally(function () {
      var c = store[k];
      if (c) c.promise = null;
    });
    e.promise = p;
    return p;
  }

  /* Shared candles with the last (forming) bar's close patched to the live feed
     LTP. Patches ONE shared copy (not per reader) and reuses it until the raw
     array refetches or the LTP changes, so every consumer on this key sees the
     exact same series. */
  function getPatched(symbol, tf, days, ttl) {
    var k = keyFor(symbol, tf, days);
    return getCandles(symbol, tf, days, ttl).then(function (candles) {
      if (!candles || !candles.length) return candles;
      var q = quote(symbol);
      var ltp = (q && q.ltp != null) ? Number(q.ltp) : null;
      var e = patchedStore[k];
      if (e && e.ref === candles && e.ltp === ltp) return e.patched;
      var last = candles[candles.length - 1];
      var out;
      if (ltp && isFinite(ltp) && ltp > 0) {
        out = candles.slice();
        out[out.length - 1] = Object.assign({}, last, {
          close: ltp,
          high: Math.max(Number(last.high) || ltp, ltp),
          low: Math.min(Number(last.low) || ltp, ltp)
        });
      } else {
        out = candles;
      }
      patchedStore[k] = { ref: candles, ltp: ltp, patched: out };
      return out;
    });
  }

  function quote(symbol) {
    if (!symbol) return null;
    var q = (typeof clientQuotes !== 'undefined') ? clientQuotes : {};
    var key = symbol.exch === 'IDX_I' ? 'IDX_I:' + symbol.id : String(symbol.id);
    return q[key] || null;
  }

  function evalEntry(r, candles) {
    if (!r || !candles || !candles.length || !window.AEval || !window.AEval.entryFireState) return false;
    try { return !!window.AEval.entryFireState(r, candles); } catch (e) { return false; }
  }

  function indSeries(candles, indId, settings, valueKey) {
    if (!window.AEval || !window.AEval.alignedSeries) return null;
    try { return window.AEval.alignedSeries(indId, settings, valueKey || 'v0', candles); }
    catch (e) { return null; }
  }

  function onBar(cb) {
    if (typeof cb === 'function') subs.push(cb);
  }

  function stats() {
    var o = {};
    Object.keys(store).forEach(function (k) {
      var e = store[k];
      o[k] = { bars: e.candles ? e.candles.length : 0, lastBar: e.lastBar, ageMs: Date.now() - e.at, inflight: !!e.promise };
    });
    return o;
  }

  window.HftPool = {
    getCandles: getCandles,
    getPatched: getPatched,
    quote: quote,
    evalEntry: evalEntry,
    indSeries: indSeries,
    onBar: onBar,
    stats: stats,
    lastBarTime: lastBarTime,
    barIsCurrent: barIsCurrent,
    start: function () { window.HftPool._started = true; }
  };
})();
