/* Dhan Algo - Realtime app-side trail loop
 *
 * The Realtime Trading Engine's broker adapter only ever places ENTRY orders
 * for the Normal / Slice-Iceberg / Forever methods (Dhan has no native stop or
 * trailing leg for them). The Super method is different: Dhan holds a real
 * STOP_LOSS_LEG + target leg and trails it itself, so the app only mirrors it.
 *
 * This module runs the missing half for the non-super methods:
 *
 *   - every TICK_MS it asks the realtime executor to re-derive each position's
 *     SL / trailing-SL / trailing-TP / fixed-TP level (a pure, sub-2ms scan),
 *   - and when a level is breached the executor sends the reverse MARKET order
 *     and books the trade closed,
 *   - for REAL super orders it detects the broker leg triggering and books the
 *     close (no order is re-sent - Dhan already exited), keeping the app ledger
 *     in step with the broker.
 *
 * The loop is hard-gated by the Realtime engine's master switch AND the ARM
 * flag, so OFF / disarmed never touches the market. It runs across tab switches
 * (risk management must be continuous), not just while the Realtime tab shows.
 */
(function () {
  'use strict';

  var TICK_MS = 300;
  var LTP_REFRESH_MS = 1500;
  var SUP_RECON_MS = 2000;
  var _timer = null;
  var _lastLtp = 0;
  var _lastSup = 0;

  function broker() { return window.RealtimeBroker || null; }
  function exec() {
    return (window.TabEngines && window.TabEngines.realtime && window.TabEngines.realtime.realtime) || null;
  }
  function active() {
    var b = broker();
    return !!(b && b.engineActive && b.engineActive() && b.isArmed && b.isArmed());
  }

  /* Book a real Dhan super order's close once its stop-loss / target leg has
     triggered. Dhan already squared the position; we only write the ledger.
     A sliced (Super-as-iceberg) position has one self-protecting order per leg,
     so each leg is booked independently and the aggregate shrinks; the position
     closes when its last live leg is booked. */
  function reconcileSuper(ex) {
    var b = broker();
    if (!b || !b.getSuperTrail) return;
    var now = Date.now();
    if (now - _lastSup < SUP_RECON_MS) return;
    _lastSup = now;
    var st = ex.getState ? ex.getState() : null;
    var ap = (st && st.autoPositions) || {};
    Object.keys(ap).forEach(function (key) {
      var p = ap[key];
      if (!p || p.brokerTrail !== true) return;
      var entries;
      if (Array.isArray(p.slices) && p.slices.length) {
        entries = p.slices.map(function (s) { return { orderId: s.orderId, qty: Number(s.qty) || 0, ref: s }; });
      } else if (p.superOrderId != null) {
        entries = [{ orderId: p.superOrderId, qty: Number(p.qty) || 0, ref: null }];
      } else { return; }
      entries.forEach(function (en) {
        if (en.orderId == null || (en.ref && en.ref._booking)) return;
        try {
          b.getSuperTrail({ superOrderId: en.orderId, entryPrice: p.entryPrice }).then(function (t) {
            /* Keep the broker's LIVE stop-loss leg (price + derived percent) on
               the position so the chart can draw Dhan's real trailing stop. */
            if (t) {
              if (t.slPrice != null) p.brokerSlPrice = t.slPrice;
              if (t.slPct != null) p.brokerSlPct = t.slPct;
              if (t.trailPct != null) p.brokerTrailPct = t.trailPct;
              if (t.trailingJump != null) p.brokerTrailJump = t.trailingJump;
            }
            if (!t || !t.triggered) return;
            var e2 = exec();
            if (!e2) return;
            if (en.ref) en.ref._booking = true;
            var px = (t.slPrice != null && t.slPrice > 0) ? t.slPrice : p.entryPrice;
            var why = (t.status === 'CLOSED' ? 'Dhan super order closed' : ('Dhan super ' + (t.legStatus || 'leg') + ' hit'));
            if (en.ref && e2.bookPartial) {
              e2.bookPartial(key, en.qty, px, why);
              var idx = p.slices ? p.slices.indexOf(en.ref) : -1;
              if (idx >= 0) p.slices.splice(idx, 1);
              /* Keep the primary super order id pointing at a LIVE leg so the
                 broker-trail mirror never shows a booked leg's status. */
              if (Array.isArray(p.slices) && p.slices.length && p.slices[0] && p.slices[0].orderId != null) {
                p.superOrderId = p.slices[0].orderId;
              }
            } else if (e2.bookClosed) {
              e2.bookClosed(key, px, why);
            }
          }).catch(function () { if (en.ref) en.ref._booking = false; });
        } catch (e) { if (en.ref) en.ref._booking = false; }
      });
    });
  }

  function tick() {
    if (!active()) return;
    var ex = exec();
    if (!ex) return;
    /* Keep the broker LTP cache fresh so the trail levels track the market. */
    var now = Date.now();
    if (window.RealtimeBroker && RealtimeBroker.refreshLtp && (now - _lastLtp > LTP_REFRESH_MS)) {
      _lastLtp = now;
      try { RealtimeBroker.refreshLtp(); } catch (e) {}
    }
    try { if (ex.managePositions) ex.managePositions(); } catch (e) {}
    try { reconcileSuper(ex); } catch (e) {}
  }

  function start() { if (_timer) return; _timer = setInterval(tick, TICK_MS); }
  function stop() { if (_timer) { clearInterval(_timer); _timer = null; } }

  window.RealtimeTrail = {
    TICK_MS: TICK_MS,
    start: start,
    stop: stop,
    tick: tick,
    active: active
  };
})();
