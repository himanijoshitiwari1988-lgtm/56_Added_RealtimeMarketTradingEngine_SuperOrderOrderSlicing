/* Ultrafast live candle feed for the AST engine (optional, checkbox-gated).

   Default data path: every strategy poll asks the server REST endpoint
   /api/candles through the shared HftPool (2s TTL), which trips Dhan's candle
   rate limit and can serve stale history during the 30s cooldown.

   This module replaces that path with a purely client-side live candle store:
   - initial history is seeded ONCE per symbol+timeframe (one REST fetch),
   - then every incoming WebSocket tick (already pushed to the browser over /ws
     every ~5ms) updates/rolls the forming candle in memory,
   - the strategy reads the in-memory series synchronously (<1ms) - no REST call
     in the live path at all.

   The AST checkbox "Ultrafast Live Feed" toggles it: ON -> strategies run and
   trade on these live candles; OFF -> the normal Data Pool path stays active. */
(function () {
  'use strict';

  var MIN_CANDLES = 10;
  var MAX_CANDLES = 400;
  var enabledFlag = false;
  var store = {};

  function barMins(tf) {
    if (tf === 'day') return 1440;
    if (tf === 'week') return 10080;
    if (tf === 'month') return 43200;
    var n = parseInt(tf, 10);
    return (!isNaN(n) && n > 0) ? n : 5;
  }

  function keyFor(sym, tf) {
    return String(sym.id) + ':' + (sym.exch || '') + ':' + tf;
  }

  function quoteKeyFor(sym) {
    return String(sym.exch) === 'IDX_I' ? 'IDX_I:' + String(sym.id) : String(sym.id);
  }

  function entryFor(sym, tf) {
    var k = keyFor(sym, tf);
    var e = store[k];
    if (!e) {
      e = store[k] = {
        candles: [],
        tf: tf,
        barMins: barMins(tf),
        lastBar: 0,
        quoteKeys: {},
        seedP: null,
        at: 0
      };
    }
    e.quoteKeys[quoteKeyFor(sym)] = 1;
    return e;
  }

  /* Roll/update the forming bar with a live tick. A new array identity is
     produced whenever the close or the bar changed, so consumers (whose
     indicator caches are keyed by the candle array) always recompute on fresh
     data - mirroring HftPool.getPatched semantics. */
  function applyTick(e, ltp, volume) {
    var now = Date.now() / 1000;
    var barSec = e.barMins * 60;
    var start = Math.floor(now / barSec) * barSec;
    var candles = e.candles;
    var roll = false;
    if (!candles.length) {
      candles = [{ time: start, open: 0, high: 0, low: 0, close: 0, volume: 0 }];
      roll = true;
    } else if (candles[candles.length - 1].time !== start) {
      candles = candles.slice();
      candles.push({ time: start, open: 0, high: 0, low: 0, close: 0, volume: 0 });
      if (candles.length > MAX_CANDLES) candles = candles.slice(candles.length - MAX_CANDLES);
      roll = true;
    }
    var last = candles[candles.length - 1];
    var changed = roll || last.close !== ltp || !last.open || last.open <= 0;
    if (changed) {
      if (!roll) candles = candles.slice();
      last = candles[candles.length - 1];
      if (!last.open || last.open <= 0) last.open = ltp;
      if (!last.high || ltp > last.high) last.high = ltp;
      if (!last.low || ltp < last.low) last.low = ltp;
      last.close = ltp;
      if (volume != null && volume > 0) last.volume = volume;
      e.candles = candles;
    }
    e.lastBar = start;
    e.at = Date.now();
  }

  /* Called from the /ws quote merge for every incoming live quote. Updates the
     forming bar of every seeded series that carries this quote key. */
  function tick(key, q) {
    if (!enabledFlag) return;
    if (!q || q.ltp == null) return;
    var ltp = Number(q.ltp);
    if (!isFinite(ltp) || ltp <= 0) return;
    for (var k in store) {
      var e = store[k];
      if (!e || !e.quoteKeys[key]) continue;
      applyTick(e, ltp, (q.volume != null ? Number(q.volume) : null));
    }
  }

  /* Seed the series once from the server (this also subscribes the symbol on
     the server WS feed so live ticks start flowing). After seeding every read
     is purely from memory. */
  function seed(sym, tf) {
    var e = entryFor(sym, tf);
    if (e.seedP) return e.seedP;
    if (e.candles && e.candles.length >= MIN_CANDLES) return Promise.resolve(e.candles);
    e.seedP = (async function () {
      var arr = null;
      var SE = window.StratEngine;
      if (SE && SE.fetchCandlesFor) {
        try { arr = await SE.fetchCandlesFor(sym, tf); } catch (err) { arr = null; }
      }
      if ((!arr || !arr.length) && window.HftPool && HftPool.getCandles) {
        try { arr = await HftPool.getCandles(sym, tf, 0, 0); } catch (err) { arr = null; }
      }
      if (arr && arr.length) {
        e.candles = arr.slice();
        if (e.candles.length > MAX_CANDLES) e.candles = e.candles.slice(e.candles.length - MAX_CANDLES);
        var last = e.candles[e.candles.length - 1];
        e.lastBar = last ? last.time : 0;
      }
      e.seedP = null;
      e.at = Date.now();
      return e.candles;
    })();
    return e.seedP;
  }

  /* Patch the forming bar with the current live LTP so a read always returns
     the freshest price even between WS batches. Sub-microsecond; only re-slides
     the array when the close actually moved. */
  function patchLive(sym, e) {
    var qk = quoteKeyFor(sym);
    var qm = (typeof clientQuotes !== 'undefined' && clientQuotes) ? clientQuotes : {};
    var q = qm[qk] || null;
    if (!q || q.ltp == null || !e.candles.length) return;
    var ltp = Number(q.ltp);
    if (!isFinite(ltp) || ltp <= 0) return;
    var last = e.candles[e.candles.length - 1];
    if (last.close === ltp) return;
    var c = e.candles.slice();
    c[c.length - 1] = {
      time: last.time,
      open: last.open || ltp,
      high: Math.max(Number(last.high) || ltp, ltp),
      low: Math.min(Number(last.low) || ltp, ltp),
      close: ltp,
      volume: last.volume || 0
    };
    e.candles = c;
    e.at = Date.now();
  }

  /* The fast read path used by the AST engine. Resolves synchronously from
     memory once seeded; the first request seeds history in the background. */
  function candlesFor(sym, tf) {
    if (!sym || sym.id == null) return Promise.resolve([]);
    var e = entryFor(sym, tf);
    if (e.candles && e.candles.length >= MIN_CANDLES) {
      patchLive(sym, e);
      return Promise.resolve(e.candles);
    }
    return seed(sym, tf);
  }

  function activeCount() {
    var n = 0;
    for (var k in store) if (store[k].candles && store[k].candles.length) n++;
    return n;
  }

  function reset() {
    for (var k in store) delete store[k];
  }

  window.FastLive = {
    candlesFor: candlesFor,
    tick: tick,
    seed: seed,
    activeCount: activeCount,
    reset: reset,
    setEnabled: function (v) { enabledFlag = !!v; if (!enabledFlag) reset(); },
    get enabled() { return enabledFlag; }
  };
})();
