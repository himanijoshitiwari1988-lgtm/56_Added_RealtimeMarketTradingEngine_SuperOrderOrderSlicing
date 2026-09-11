/* Dhan Algo - Realtime Broker adapter (REAL orders)
 *
 * Implements the window.RealtimeBroker interface consumed by
 * static/realtime.js, so the Realtime Trading Engine places REAL orders on the
 * connected Dhan account instead of paper trades:
 *
 *   window.RealtimeBroker = {
 *     placeEntry(side, opts)        -> { ok, orderId, entryPrice }
 *     placeExit(position, exitPrice)-> { ok, exitPrice, orderId }
 *     getLtp(symbol|name)           -> number | null
 *     lotSizeFor(symbol)            -> number
 *     arm() / disarm() / isArmed() / toggleArm()
 *   }
 *
 * SAFETY - the live path is DISARMED by default and persists its state in
 * localStorage ("algodhan_realtime_armed_v1"). While disarmed every entry is
 * refused, so cloning the AST UI and toggling "Run" cannot accidentally hit
 * the market. Press the ARM button on the Realtime tab to go live.
 *
 * Order placement is synchronous (the AST engine's scanner is synchronous and
 * reads the position it just opened in the same tick). Entries are only ever
 * fired from a signal, throttled by the engine's orders/sec budget, so the
 * brief block is bounded and infrequent.
 *
 * NOTE: fills are not reconciled yet - the engine books the proxy price
 * (premium / last fallback LTP) as the entry. Broker-side fill + SL/TP /
 * trailing reconciliation is the next step.
 */
(function () {
  'use strict';

  var ARM_KEY = 'algodhan_realtime_armed_v1';
  var _ltpById = {};
  var _ltpByName = {};
  var _ltpAt = 0;
  var _ltpBusy = false;
  var _availMargin = null;
  var _availAt = 0;
  /* Full Dhan position row by security_id (buy_avg / ltp / pnl / pnl_pct / qty)
     so the live chart can draw the broker's OWN numbers (real fill average, real
     running P&L) instead of the app's proxy entry price. */
  var _posById = {};

  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function round2(v) { return Math.round(num(v) * 100) / 100; }
  /* ---- percent <-> points/prices (pure, allocation-light) -----------------
     Dhan Super Orders have NO percent field: the stop-loss leg takes an
     absolute PRICE (stopLossPrice) and the trail takes an absolute PRICE JUMP
     (trailingJump). The app lets the operator set Overall SL and Trail SL as a
     percent of the entry; these helpers convert one way (place) and back the
     other way (mirror the broker's live SL leg as a percent). */
  function pctToSlPrice(base, pct, isBuy) {
    base = num(base); pct = num(pct);
    if (base <= 0 || pct <= 0) return 0;
    return isBuy ? base * (1 - pct / 100) : base * (1 + pct / 100);
  }
  function pctToJump(base, pct) {
    base = num(base); pct = num(pct);
    if (base <= 0 || pct <= 0) return 0;
    return base * pct / 100;
  }
  function priceToPct(base, price) {
    base = num(base); price = num(price);
    if (base <= 0 || price <= 0) return null;
    return Math.abs(base - price) / base * 100;
  }
  function jumpToPct(base, jump) {
    base = num(base); jump = num(jump);
    if (base <= 0 || jump <= 0) return null;
    return jump / base * 100;
  }
  /* Option/index tick is 0.05; snap prices so Dhan never rejects an off-tick
     stop-loss / target while keeping the percent error below half a tick. */
  function tickRound(v, segment) {
    v = num(v);
    if (v <= 0) return 0;
    var tick = /^NSE|^BSE/.test(String(segment || '').toUpperCase()) ? 0.05 : 0.01;
    return Math.round(Math.round(v / tick) * tick * 100) / 100;
  }
  function secId(sym) {
    if (sym == null || typeof sym !== 'object') return null;
    var v = (sym.id != null) ? sym.id : (sym.security_id != null ? sym.security_id : sym.sid);
    return v == null ? null : String(v);
  }
  /* ---- auto order slicing (Super-as-iceberg) ------------------------------
     Split a total order quantity into exchange-legal chunks. Pure, allocation
     light and O(number of chunks) - the whole plan is computed in microseconds
     so it never adds to the order hot path. chunkQty is the max quantity Dhan
     accepts in one Super order (the exchange freeze quantity). Every chunk is a
     multiple of the lot size; the last chunk carries the remainder. */
  function sliceQty(totalQty, chunkQty, lot) {
    totalQty = Math.floor(num(totalQty));
    chunkQty = Math.floor(num(chunkQty));
    lot = Math.floor(num(lot));
    if (totalQty <= 0) return [];
    if (chunkQty <= 0 || chunkQty >= totalQty) return [totalQty];
    if (lot <= 0) lot = 1;
    var step = Math.floor(chunkQty / lot) * lot;
    if (step <= 0) step = Math.min(lot, totalQty);
    var out = [];
    var left = totalQty;
    while (left > 0) { var q = Math.min(step, left); out.push(q); left -= q; }
    return out;
  }
  function exch(sym) {
    var e = (sym && (sym.exch || sym.exchange_segment || sym.exchange)) || 'NSE_FNO';
    return String(e).toUpperCase();
  }
  function isArmed() {
    try { return localStorage.getItem(ARM_KEY) === '1'; } catch (e) { return false; }
  }
  /* Hard gate #1: the Realtime AI Smart engine's master ON/OFF switch. While it
     is OFF the executor refuses every order, so a stale timer, a runaway loop or
     any future bug can never place an order behind the operator's back. */
  function engineActive() {
    try {
      var eng = window.TabEngines && window.TabEngines.aismart && window.TabEngines.aismart.realtime;
      var st = eng && eng.getState ? eng.getState() : null;
      return !!(st && st.enabled === true);
    } catch (e) { return false; }
  }
  function setArmed(on) {
    try { localStorage.setItem(ARM_KEY, on ? '1' : '0'); } catch (e) {}
    try { console.log('[RealtimeBroker] ' + (on ? 'ARMED - live orders ENABLED' : 'disarmed - live orders blocked')); } catch (e) {}
  }

  /* Synchronous POST helper. Used only on the order path where the caller
     (AST scanner) needs the result in the same tick. */
  function postSync(url, body) {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', url, false);
      xhr.setRequestHeader('Content-Type', 'application/json');
      try { xhr.timeout = 8000; } catch (e) {}
      xhr.send(JSON.stringify(body || {}));
      var parsed = null;
      try { parsed = JSON.parse(xhr.responseText || 'null'); } catch (e) {}
      return { http: xhr.status, body: parsed };
    } catch (e) {
      return { http: 0, body: null, error: e };
    }
  }

  function extractOrderId(payload) {
    if (!payload) return null;
    var d = payload;
    if (d && typeof d === 'object' && d.orderId == null && d.order_id == null && d.orderID == null &&
        d.data && typeof d.data === 'object') d = d.data;
    if (d && typeof d === 'object') {
      if (d.orderId != null) return d.orderId;
      if (d.order_id != null) return d.order_id;
      if (d.orderID != null) return d.orderID;
    }
    return null;
  }

  function refreshLtp() {
    if (_ltpBusy) return;
    _ltpBusy = true;
    fetch('/api/account').then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.status === 'success') {
        var ps = (d.data && d.data.positions) || [];
        var now = Date.now();
        ps.forEach(function (p) {
          var ltp = num(p.ltp);
          if (ltp <= 0) return;
          if (p.security_id != null) _ltpById[String(p.security_id)] = ltp;
          if (p.symbol) _ltpByName[String(p.symbol).trim().toUpperCase()] = ltp;
        });
        ps.forEach(function (p) {
          if (p && p.security_id != null) _posById[String(p.security_id)] = p;
        });
        if (d.data && d.data.balance && d.data.balance.available != null) {
          _availMargin = num(d.data.balance.available);
          _availAt = now;
        }
        _ltpAt = now;
      }
    }).catch(function () {}).then(function () { _ltpBusy = false; });
  }

  /* ---- super order mirror (broker-side SL / trail as percent) -------------- */
  var _supList = [];
  var _supAt = 0;
  var _supBusy = false;
  function refreshSuperOrders() {
    if (_supBusy) return Promise.resolve(_supList);
    _supBusy = true;
    return fetch('/api/super/orders').then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.status === 'success') { _supList = (d.data && d.data.orders) || []; _supAt = Date.now(); }
      return _supList;
    }).catch(function () { return _supList; }).then(function (v) { _supBusy = false; return v; });
  }
  function findSuperOrder(orderId) {
    if (orderId == null) return null;
    var k = String(orderId);
    for (var i = 0; i < _supList.length; i++) { if (String(_supList[i].orderId) === k) return _supList[i]; }
    return null;
  }
  /* Convert one super order's LIVE stop-loss leg back into the app's percent
     terms: slPct = |entry - SL price| / entry, trailPct = trailingJump / entry. */
  function deriveSuperTrail(o, entryPrice) {
    if (!o) return null;
    var leg = o.legs && (o.legs.STOP_LOSS_LEG || o.legs['STOP_LOSS_LEG']);
    if (!leg) return null;
    var base = num(entryPrice) || num(o.price);
    var slPrice = num(leg.price);
    var jump = num(leg.trailingJump);
    var st = String(o.orderStatus || '');
    var legSt = String(leg.orderStatus || '');
    var triggered = (st === 'CLOSED') || /TRADED|TRIGGERED|CANCELLED/.test(legSt);
    return {
      orderId: o.orderId, status: st, legStatus: legSt, triggered: triggered,
      entryPrice: base,
      slPrice: slPrice > 0 ? slPrice : null,
      trailingJump: jump > 0 ? jump : null,
      slPct: slPrice > 0 ? priceToPct(base, slPrice) : null,
      trailPct: jump > 0 ? jumpToPct(base, jump) : null,
      ltp: num(o.ltp) || null, remainingQuantity: o.remainingQuantity
    };
  }

  function lotSizeFor(sym) {
    if (!sym) return 1;
    if (sym.lotSize) return num(sym.lotSize) || 1;
    try {
      if (window.PaperTrade && typeof window.PaperTrade.lotSizeFor === 'function') {
        return num(window.PaperTrade.lotSizeFor(sym)) || 1;
      }
    } catch (e) {}
    return 1;
  }

  function orderMethod() {
    try {
      if (window.RealtimeOrders && typeof RealtimeOrders.current === 'function') return RealtimeOrders.current();
    } catch (e) {}
    return { key: 'normal', cfg: {} };
  }

  /* Place a large Super Order as N exchange-legal Super orders (Super treated
     as an iceberg). Every chunk carries the SAME broker-side target / stop-loss
     / trail, so each leg is self-protecting on Dhan. Returns one aggregate
     position carrying a `slices` list (child order ids) so the app can mirror
     and reconcile each child. `filledQty` is the qty actually placed, so a
     partial slice failure never makes the app send an oversized exit. */
  function placeSuperSlices(common, plan, chunks, sym, side, m) {
    var cfg = (m && m.cfg) || {};
    var children = [], failMsg = null, firstId = null, filled = 0;
    for (var i = 0; i < chunks.length; i++) {
      var body = Object.assign({}, common, {
        quantity: chunks[i],
        order_type: cfg.orderType || 'LIMIT', product_type: 'INTRA', price: plan.base,
        target_price: plan.targetPrice, stop_loss_price: plan.stopLossPrice, trailing_jump: plan.trailingJump
      });
      var res = postSync('/api/trade/super', body);
      var b = res.body || {};
      if (res.http >= 200 && res.http < 300 && b.status === 'success') {
        var oid = extractOrderId(b.data);
        if (firstId == null) firstId = oid;
        filled += chunks[i];
        children.push({ orderId: oid, qty: chunks[i], targetPrice: plan.targetPrice,
                        stopLossPrice: plan.stopLossPrice, trailingJump: plan.trailingJump });
      } else {
        failMsg = (b && b.message) || (res.error ? String(res.error.message || res.error) : ('HTTP ' + res.http));
        break;
      }
    }
    if (!children.length) return { ok: false, message: failMsg || 'slice placement failed' };
    try { console.log('[RealtimeBroker] ENTRY[super-slice] ' + side + ' ' + (sym.name || '') +
      ' legs=' + children.length + '/' + chunks.length + ' qty=' + filled); } catch (e) {}
    var out = { ok: true, orderId: firstId, entryPrice: plan.base, method: m.key, brokerTrail: true,
      targetPrice: plan.targetPrice, stopLossPrice: plan.stopLossPrice, trailingJump: plan.trailingJump,
      slPct: plan.slPct, trailPct: plan.trailPct, slices: children, filledQty: filled };
    if (failMsg) out.message = 'sliced ' + children.length + '/' + chunks.length + ' legs; ' + failMsg;
    return out;
  }

  var RealtimeBroker = {
    REFRESH_MS: 5000,

    isArmed: isArmed,
    engineActive: engineActive,
    canTrade: function () { return isArmed() && engineActive(); },
    arm: function () { setArmed(true); refreshLtp(); return true; },
    disarm: function () { setArmed(false); return false; },
    toggleArm: function () { var on = !isArmed(); setArmed(on); if (on) refreshLtp(); return on; },

    lotSizeFor: lotSizeFor,
    refreshLtp: refreshLtp,

    /* Broker-side super-order mirror. getSuperTrail accepts a tracked position
       ({ superOrderId, entryPrice }) or a bare order id and resolves to
       { slPrice, trailingJump, slPct, trailPct, status, triggered, ... } so the
       realtime UI can show the Dhan-managed SL/trail in the app's percent
       terms. Always refreshes the super book when the cache is older than
       ttlMs (default 2s). */
    refreshSuperOrders: refreshSuperOrders,
    superOrders: function () { return _supList.slice(); },
    /* Synchronous mirror of one super order's stop-loss leg from the last
       /api/super/orders poll (no fetch) - used by the chart overlay so it can
       draw Dhan's LIVE trailing stop without blocking on a network round-trip. */
    superTrailSync: function (orderId, entryPrice) {
      return deriveSuperTrail(findSuperOrder(orderId), entryPrice);
    },
    /* Dhan's own position row for a security_id (buy_avg fill, ltp, pnl,
       pnl_pct, qty) from the last /api/account poll. */
    positionSnapshot: function (symbolOrId) {
      var id = (symbolOrId && typeof symbolOrId === 'object') ? secId(symbolOrId)
             : (symbolOrId != null ? String(symbolOrId) : null);
      if (id == null) return null;
      return _posById[id] || null;
    },
    getSuperTrail: function (pos, ttlMs) {
      var orderId = (pos && typeof pos === 'object') ? (pos.superOrderId != null ? pos.superOrderId : pos.orderId) : pos;
      var entry = (pos && typeof pos === 'object') ? pos.entryPrice : null;
      var age = Date.now() - _supAt;
      var chain = (age > (ttlMs || 2000)) ? refreshSuperOrders() : Promise.resolve(_supList);
      return chain.then(function () { return deriveSuperTrail(findSuperOrder(orderId), entry); });
    },
    _util: { pctToSlPrice: pctToSlPrice, pctToJump: pctToJump, priceToPct: priceToPct, jumpToPct: jumpToPct, tickRound: tickRound, sliceQty: sliceQty },

    getAvailableMargin: function () {
      if (Date.now() - _availAt > 6000) refreshLtp();
      return _availMargin;
    },

    /* Symbol may be a target object ({id,exch,...}) or a display name string. */
    getLtp: function (symbolOrName) {
      if (symbolOrName && typeof symbolOrName === 'object') {
        var id = secId(symbolOrName);
        if (id != null && _ltpById[id] != null) return _ltpById[id];
        var nm = String(symbolOrName.name || symbolOrName.symbol || '').trim().toUpperCase();
        if (nm && _ltpByName[nm] != null) return _ltpByName[nm];
      } else if (symbolOrName != null) {
        var k = String(symbolOrName).trim().toUpperCase();
        if (_ltpByName[k] != null) return _ltpByName[k];
      }
      if (Date.now() - _ltpAt > 3000) refreshLtp();
      return null;
    },

    /* placeEntry(side, opts) -> { ok, orderId, entryPrice } */
    placeEntry: function (side, opts) {
      opts = opts || {};
      var sym = opts.symbol || {};
      side = String(side || '').toUpperCase();
      if (side !== 'BUY' && side !== 'SELL') return { ok: false, message: 'invalid side' };
      if (!engineActive()) { try { console.warn('[RealtimeBroker] entry refused - engine is OFF'); } catch (e) {} return { ok: false, message: 'realtime engine is OFF' }; }
      if (!isArmed()) { try { console.warn('[RealtimeBroker] entry refused - not ARMED'); } catch (e) {} return { ok: false, message: 'realtime not armed' }; }
      var id = secId(sym);
      if (id == null) { try { console.warn('[RealtimeBroker] entry refused - no security_id'); } catch (e) {} return { ok: false, message: 'no security_id' }; }
      var lot = num(opts.lotSize) || lotSizeFor(sym);
      var lots = num(opts.lots) || 1;
      var qty = lot * lots;
      if (qty <= 0) return { ok: false, message: 'qty<=0' };
      var price = num(sym.premium != null ? sym.premium : opts.fallbackLtp) || num(RealtimeBroker.getLtp(sym)) || 0;
      var m = orderMethod();
      var cfg = m.cfg || {};
      var common = { security_id: Number(id), exchange_segment: exch(sym), side: side, quantity: qty };
      var url, body;
      var plan = null;
      if (m.key === 'super') {
        /* Overall SL and Trail SL come from the app as PERCENTS. Dhan needs an
           absolute stopLossPrice and an absolute trailingJump, so convert both
           off the entry price here (the ticket's explicit price fields, when
           set, still win). Only one SL distance is used for the initial stop:
           Overall SL% when given, else the Trail SL% itself, so a trail-only
           setup still opens with a real stop leg. */
        var base = round2(price);
        var slPct = num(opts.slPct);
        var trailPct = num(opts.slTrailPct);
        var effSlPct = slPct > 0 ? slPct : trailPct;
        var tPrice = num(cfg.targetPrice);
        var sPrice = num(cfg.stopLossPrice);
        /* Explicit price fields win when set; the percent only drives the "auto"
           value (the ticket labels them "0=auto %"). */
        if (sPrice <= 0 && effSlPct > 0 && base > 0) sPrice = pctToSlPrice(base, effSlPct, side === 'BUY');
        var fixedTp = num(opts.fixedTpPct) > 0 ? num(opts.fixedTpPct) : num(opts.tpPct);
        if (tPrice <= 0 && fixedTp > 0 && base > 0) tPrice = (side === 'BUY') ? base * (1 + fixedTp / 100) : base * (1 - fixedTp / 100);
        var jump = num(cfg.trailingJump);
        if (jump <= 0 && trailPct > 0 && base > 0) jump = pctToJump(base, trailPct);
        tPrice = tickRound(tPrice, exch(sym));
        sPrice = tickRound(sPrice, exch(sym));
        jump = round2(jump);
        /* Dhan super-order leg validation: BUY target > price > SL, SELL
           target < price < SL. Drop any level on the wrong side instead of
           letting Dhan reject the whole order. */
        if (side === 'BUY') {
          if (tPrice > 0 && !(tPrice > base)) tPrice = 0;
          if (sPrice > 0 && !(sPrice < base)) sPrice = 0;
        } else {
          if (tPrice > 0 && !(tPrice < base)) tPrice = 0;
          if (sPrice > 0 && !(sPrice > base)) sPrice = 0;
        }
        if (jump < 0) jump = 0;
        if (base > 0 && (tPrice > 0 || sPrice > 0)) {
          url = '/api/trade/super';
          body = Object.assign({}, common, {
            order_type: cfg.orderType || 'LIMIT', product_type: 'INTRA', price: base,
            target_price: tPrice, stop_loss_price: sPrice, trailing_jump: jump
          });
          plan = { base: base, targetPrice: tPrice, stopLossPrice: sPrice, trailingJump: jump,
                   slPct: sPrice > 0 ? round2(Math.abs(base - sPrice) / base * 100) : 0,
                   trailPct: jump > 0 ? round2(jump / base * 100) : 0 };
          /* Super-as-iceberg: when Auto Order Slicing is on and the order is
             larger than the exchange freeze quantity, place N self-protecting
             Super orders instead of one oversized order Dhan would reject. */
          var sliceOn = false, chunkQty = 0;
          try {
            if (window.RealtimeOrders) {
              if (RealtimeOrders.autoSliceOn) sliceOn = RealtimeOrders.autoSliceOn();
              if (RealtimeOrders.resolveSliceChunk) chunkQty = num(RealtimeOrders.resolveSliceChunk(sym));
            }
          } catch (e) {}
          if (!chunkQty) chunkQty = num(cfg.sliceQty);
          if (sliceOn) {
            var chunks = sliceQty(qty, chunkQty, lot);
            if (chunks.length > 1) return placeSuperSlices(common, plan, chunks, sym, side, m);
          }
        } else {
          url = '/api/trade';
          body = Object.assign({}, common, { order_type: 'MARKET', product_type: 'INTRA', price: 0 });
        }
      } else if (m.key === 'forever') {
        var trg = num(cfg.triggerPrice) || round2(price);
        url = '/api/trade/forever';
        body = Object.assign({}, common, {
          order_type: cfg.orderType || 'LIMIT', product_type: 'CNC', price: round2(price),
          trigger_price: round2(trg), order_flag: cfg.flag || 'SINGLE', validity: cfg.validity || 'DAY',
          symbol: sym.name || sym.symbol || ''
        });
      } else if (m.key === 'slice') {
        var dq = Math.min(Math.max(0, num(cfg.disclosedQty)), qty);
        url = '/api/trade/slice';
        body = Object.assign({}, common, {
          order_type: cfg.orderType || 'MARKET', product_type: 'INTRA',
          price: (cfg.orderType === 'MARKET' ? 0 : round2(price)), trigger_price: 0, disclosed_quantity: dq
        });
      } else {
        var ot = cfg.orderType || 'MARKET';
        url = '/api/trade';
        body = Object.assign({}, common, {
          order_type: ot, product_type: 'INTRA',
          price: (ot === 'MARKET' ? 0 : round2(num(cfg.limitPrice) || price)),
          trigger_price: (ot === 'SL' || ot === 'SL-M') ? round2(num(cfg.limitPrice) || price) : 0
        });
      }
      var res = postSync(url, body);
      var b = res.body || {};
      if (res.http >= 200 && res.http < 300 && b.status === 'success') {
        var oid = extractOrderId(b.data);
        var proxy = price || num(RealtimeBroker.getLtp(sym));
        try { console.log('[RealtimeBroker] ENTRY[' + m.key + '] ' + side + ' ' + (sym.name || id) + ' qty=' + qty + (price ? ' px=' + round2(price) : '') + ' orderId=' + oid); } catch (e) {}
        var out = { ok: true, orderId: oid, entryPrice: proxy, method: m.key, brokerTrail: !!plan };
        if (plan) {
          out.targetPrice = plan.targetPrice; out.stopLossPrice = plan.stopLossPrice;
          out.trailingJump = plan.trailingJump; out.slPct = plan.slPct; out.trailPct = plan.trailPct;
        }
        return out;
      }
      var msg = (b && b.message) || (res.error ? String(res.error.message || res.error) : ('HTTP ' + res.http));
      try { console.warn('[RealtimeBroker] entry[' + m.key + '] rejected: ' + msg); } catch (e) {}
      return { ok: false, message: msg };
    },

    /* placeExit(position, exitPrice) -> { ok, exitPrice, orderId } */
    placeExit: function (p, exitPrice) {
      if (!p) return { ok: false, message: 'no position' };
      var price = num(exitPrice != null ? exitPrice : (p.exitPrice != null ? p.exitPrice : p.entryPrice));
      if (!engineActive()) { try { console.warn('[RealtimeBroker] exit refused - engine is OFF'); } catch (e) {} return { ok: false, exitPrice: price, message: 'realtime engine is OFF' }; }
      if (!isArmed()) { try { console.warn('[RealtimeBroker] exit refused - not ARMED'); } catch (e) {} return { ok: false, exitPrice: price, message: 'realtime not armed' }; }
      var id = (p.symbolId != null ? p.symbolId : secId(p.symbol));
      if (id == null) return { ok: false, exitPrice: price, message: 'no security_id' };
      var reverse = (String(p.side || '').toUpperCase() === 'SELL') ? 'BUY' : 'SELL';
      var res = postSync('/api/trade', {
        security_id: Number(id),
        exchange_segment: String(p.symbolExch || 'NSE_FNO').toUpperCase(),
        side: reverse,
        quantity: num(p.qty),
        order_type: 'MARKET',
        product_type: 'INTRA',
        price: 0
      });
      var b = res.body || {};
      if (res.http >= 200 && res.http < 300 && b.status === 'success') {
        try { console.log('[RealtimeBroker] EXIT ' + reverse + ' ' + (p.symbol || id) + ' qty=' + p.qty + ' orderId=' + extractOrderId(b.data)); } catch (e) {}
        return { ok: true, exitPrice: price, orderId: extractOrderId(b.data) };
      }
      var msg = (b && b.message) || (res.error ? String(res.error.message || res.error) : ('HTTP ' + res.http));
      try { console.warn('[RealtimeBroker] exit rejected: ' + msg); } catch (e) {}
      return { ok: false, exitPrice: price, message: msg };
    }
  };

  window.RealtimeBroker = RealtimeBroker;
  refreshLtp();
  try { setInterval(refreshLtp, RealtimeBroker.REFRESH_MS); } catch (e) {}
})();
