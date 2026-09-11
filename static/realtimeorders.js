/* Dhan Algo - Realtime Order Placement Methods (inside the Realtime tab)
 *
 * Renders a horizontal row of Dhan order-placement methods ABOVE the AI Smart
 * Trading Engine block (below the P&L / Running section) in the Realtime
 * Trading Engine tab. Exactly ONE method is enabled at a time (radio-like
 * checkbox). Every method card mirrors the Realtime engine's universal trade
 * settings - lot size, lots, Overall SL, Trail SL, Take Profit (auto/manual) -
 * as EDITABLE inputs that write back to that engine (single source of truth),
 * and shows the live Dhan margin available plus the estimated margin required
 * to place this order.
 *
 * The selected method + its per-method options (order type, trailing jump,
 * target/SL price, GTT validity, slice disclosed qty, ...) are persisted and
 * read by static/realtimebroker.js at order time:
 *
 *     window.RealtimeOrders.current() -> { key, cfg }
 *
 * Methods: Normal (place_order), Super (place_super_order),
 *          Forever/GTT (place_forever), Slice/Iceberg (place_slice_order).
 */
(function () {
  'use strict';

  var SFX = '_realtime';
  var METHOD_KEY = 'algodhan_realtime_method_v1';
  var CFG_KEY = 'algodhan_realtime_ordercfg_v1';
  var AUTOLOTS_KEY = 'algodhan_realtime_autolots_v1';
  /* Auto Lots judges whether "itne lots" can actually be exited by looking at
     the traded strike's liquidity (min of OI and traded volume). We only ever
     use a small slice of the book so our own exit cannot move the price. */
  var LIQ_FRAC = 0.01;
  var _autoLots = false;
  var _marginPushedVal = null;

  /* Exchange freeze quantity fallback per underlying (max qty per single order).
     The authoritative value is fetched from /api/freeze_qty (Dhan's detailed
     scrip master, SM_FREEZE_QTY) and cached by security id; this small map only
     covers the moment before the async fetch lands or when the server is
     offline, so order placement stays instant. */
  var FREEZE_BY_UNDER = {
    BANKNIFTY: 601, NIFTY: 1756, FINNIFTY: 1801, MIDCPNIFTY: 2761,
    NIFTYNXT50: 601, SENSEX: 1001, BANKEX: 901, SENSEX50: 1801
  };
  var _freezeById = {};
  var _freezeBusy = {};
  var _freezePrefetchAt = 0;

  var METHODS = [
    {
      key: 'normal', name: 'Normal Order', sdk: 'place_order',
      desc: 'Ek single entry order (MARKET / LIMIT / SL / SL-M).',
      extras: [
        { k: 'orderType', label: 'Order type', type: 'select', opts: [['MARKET', 'MARKET'], ['LIMIT', 'LIMIT'], ['SL', 'SL'], ['SL-M', 'SL-M']], def: 'MARKET' },
        { k: 'limitPrice', label: 'Limit / trigger px', type: 'number', def: 0 }
      ]
    },
    {
      key: 'super', name: 'Super Order', sdk: 'place_super_order',
      desc: 'Entry + broker-side target + stop-loss + trailing (LIMIT / MARKET).',
      extras: [
        { k: 'orderType', label: 'Entry type', type: 'select', opts: [['LIMIT', 'LIMIT'], ['MARKET', 'MARKET']], def: 'LIMIT' },
        { k: 'trailingJump', label: 'Trail jump', type: 'number', def: 0 },
        { k: 'targetPrice', label: 'Target px (0=auto %)', type: 'number', def: 0 },
        { k: 'stopLossPrice', label: 'SL px (0=auto %)', type: 'number', def: 0 },
        { k: 'autoSlice', label: 'Auto Order Slicing', type: 'check', def: false },
        { k: 'sliceQty', label: 'Slice qty (0=freeze)', type: 'number', def: 0, cls: 'rtom-slice-qty' }
      ]
    },
    {
      key: 'forever', name: 'Forever / GTT', sdk: 'place_forever',
      desc: 'Good-till-triggered order, single ya OCO leg.',
      extras: [
        { k: 'orderType', label: 'Order type', type: 'select', opts: [['LIMIT', 'LIMIT'], ['MARKET', 'MARKET']], def: 'LIMIT' },
        { k: 'flag', label: 'Leg flag', type: 'select', opts: [['SINGLE', 'SINGLE'], ['OCO', 'OCO']], def: 'SINGLE' },
        { k: 'validity', label: 'Validity', type: 'select', opts: [['DAY', 'DAY'], ['IOC', 'IOC']], def: 'DAY' },
        { k: 'triggerPrice', label: 'Trigger px (0=auto)', type: 'number', def: 0 }
      ]
    },
    {
      key: 'slice', name: 'Slice / Iceberg', sdk: 'place_slice_order',
      desc: 'Badi qty ko slices me todkar bhejta hai; disclosed qty dikhai deti hai.',
      extras: [
        { k: 'orderType', label: 'Order type', type: 'select', opts: [['MARKET', 'MARKET'], ['LIMIT', 'LIMIT']], def: 'MARKET' },
        { k: 'disclosedQty', label: 'Disclosed qty', type: 'number', def: 0 }
      ]
    }
  ];

  var block = null;
  var selKey = 'normal';
  var cfg = {};
  var _suppress = false;
  var _built = false;

  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function el(id) { return document.getElementById(id); }
  function methodMeta(key) {
    for (var i = 0; i < METHODS.length; i++) { if (METHODS[i].key === key) return METHODS[i]; }
    return METHODS[0];
  }
  function load() {
    try { var k = localStorage.getItem(METHOD_KEY); if (k && methodMeta(k).key === k) selKey = k; } catch (e) {}
    try { _autoLots = localStorage.getItem(AUTOLOTS_KEY) === '1'; } catch (e) {}
    try { var c = JSON.parse(localStorage.getItem(CFG_KEY) || 'null'); if (c && typeof c === 'object') cfg = c; } catch (e) { cfg = {}; }
    METHODS.forEach(function (m) {
      if (!cfg[m.key] || typeof cfg[m.key] !== 'object') cfg[m.key] = {};
      m.extras.forEach(function (x) { if (cfg[m.key][x.k] == null) cfg[m.key][x.k] = x.def; });
    });
  }
  function saveSel() { try { localStorage.setItem(METHOD_KEY, selKey); } catch (e) {} }
  function saveCfg() { try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) {} }
  function saveAutoLots() { try { localStorage.setItem(AUTOLOTS_KEY, _autoLots ? '1' : '0'); } catch (e) {} }

  function astEngine() {
    return (window.TabEngines && window.TabEngines.aismart && window.TabEngines.aismart.realtime) || null;
  }

  function broker() { return window.RealtimeBroker || null; }

  /* Every option contract the engine is currently targeting for the realtime
     tab (with its live OI / volume / lot size threaded from the chain). */
  function pickedContracts() {
    var out = [];
    var ast = astEngine();
    try {
      if (ast && ast.pickedStrikes) {
        var ps = ast.pickedStrikes() || [];
        for (var i = 0; i < ps.length; i++) {
          var cs = (ps[i] && ps[i].contracts) || [];
          for (var j = 0; j < cs.length; j++) out.push(cs[j]);
        }
      }
    } catch (e) {}
    return out;
  }

  /* Broker / scrip-master lot size for the currently targeted strike. Falls back
     to the engine's own per-symbol resolver, then to 0 ("auto" - unknown). */
  function autoLotSize() {
    var cs = pickedContracts();
    for (var i = 0; i < cs.length; i++) { if (num(cs[i].lotSize) > 0) return num(cs[i].lotSize); }
    try {
      if (window.PaperTrade && typeof window.PaperTrade.lotSizeFor === 'function') {
        for (var k = 0; k < cs.length; k++) { var v = num(window.PaperTrade.lotSizeFor(cs[k])); if (v > 0) return v; }
      }
    } catch (e) {}
    return 0;
  }

  function brokerMargin() {
    try { if (broker() && broker().getAvailableMargin) return broker().getAvailableMargin(); } catch (e) {}
    return null;
  }

  /* ---- freeze quantity + auto order slicing ----
     "Super ko iceberg jaisa" treat karte hain: agar total qty exchange freeze
     quantity se badi hai to Super order ko chunks me todkar Dhan par place
     karte hain. Freeze qty authoritative /api/freeze_qty se aati hai (cached by
     security id), aur order hot path par sirf O(1) map lookup hota hai - koi
     network call nahi - isliye slicing decision sub-millisecond hai. */
  function secIdOf(sym) {
    if (sym == null) return null;
    if (typeof sym === 'object') {
      var v = (sym.id != null) ? sym.id : (sym.security_id != null ? sym.security_id : sym.sid);
      return v == null ? null : String(v);
    }
    return String(sym);
  }
  function underKey(sym) {
    var name = (sym && typeof sym === 'object') ? String(sym.name || sym.symbol || '') : String(sym || '');
    var u = name.toUpperCase().replace(/[^A-Z0-9]/g, '');
    var keys = Object.keys(FREEZE_BY_UNDER).sort(function (a, b) { return b.length - a.length; });
    for (var i = 0; i < keys.length; i++) { if (u.indexOf(keys[i]) >= 0) return keys[i]; }
    return null;
  }
  function freezeQtyFor(sym) {
    var id = secIdOf(sym);
    if (id != null && _freezeById[id] != null) return _freezeById[id];
    var uk = underKey(sym);
    if (uk && FREEZE_BY_UNDER[uk] != null) return FREEZE_BY_UNDER[uk];
    return 0;
  }
  /* Order-time chunk size: explicit sliceQty wins, else the contract's exchange
     freeze quantity. 0 means "freeze unknown - do not slice". */
  function resolveSliceChunk(sym) {
    var ov = num((cfg[selKey] || {}).sliceQty);
    if (ov > 0) return ov;
    return freezeQtyFor(sym);
  }
  function autoSliceOn() { return selKey === 'super' && cfg.super && isTruthy(cfg.super.autoSlice); }
  function isTruthy(v) { return v === true || v === 1 || v === '1' || v === 'true'; }

  /* Warm the freeze cache for the currently picked contracts OFF the hot path
     (called from sync, which runs every few seconds while the tab is visible). */
  function prefetchFreeze() {
    var now = Date.now();
    if (now - _freezePrefetchAt < 30000) return;
    _freezePrefetchAt = now;
    var cs = pickedContracts(), seen = {};
    for (var i = 0; i < cs.length; i++) {
      var id = secIdOf(cs[i]);
      if (id == null || _freezeById[id] != null || _freezeBusy[id] || seen[id]) continue;
      seen[id] = true; _freezeBusy[id] = true;
      (function (sid) {
        try {
          fetch('/api/freeze_qty?security_id=' + encodeURIComponent(sid))
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d && d.status === 'success' && d.freeze_qty != null) _freezeById[sid] = Number(d.freeze_qty); })
            .catch(function () {})
            .then(function () { _freezeBusy[sid] = false; });
        } catch (e) { _freezeBusy[sid] = false; }
      })(id);
    }
  }

  /* Fade the slice controls out while "Auto Order Slicing" is off/inactive. */
  function refreshSliceFade() {
    var c = card('super'); if (!c) return;
    var chk = c.querySelector('.rtom-slice-chk');
    var qty = c.querySelector('.rtom-slice-qty');
    var on = !!(chk && chk.checked) && selKey === 'super';
    if (qty) {
      qty.disabled = !on;
      var wrap = qty.parentNode;
      if (wrap) wrap.style.opacity = on ? '1' : '.35';
    }
  }

  /* Auto Lots: cap by (a) exit liquidity - a small slice of the strike's OI and
     traded volume, and (b) the real Dhan margin available. Never margin-only and
     never liquidity-only: whichever is tighter wins. Returns null lots when no
     signal at all is available (the caller then keeps the manual lots). */
  function calcAutoLots(lot, price) {
    lot = num(lot); price = num(price);
    var cs = pickedContracts();
    var vol = 0, oi = 0;
    for (var i = 0; i < cs.length; i++) {
      if (num(cs[i].volume) > vol) vol = num(cs[i].volume);
      if (num(cs[i].oi) > oi) oi = num(cs[i].oi);
    }
    var liqLots = null;
    if ((vol > 0 || oi > 0) && lot > 0) {
      var cap = (vol > 0 && oi > 0) ? Math.min(vol, oi) : (vol > 0 ? vol : oi);
      liqLots = Math.floor((cap * LIQ_FRAC) / lot);
      if (liqLots < 0) liqLots = 0;
    }
    var avail = brokerMargin();
    var marginLots = null;
    if (avail != null && avail > 0 && lot > 0 && price > 0) {
      marginLots = Math.floor((avail * 0.95) / (lot * price));
      if (marginLots < 0) marginLots = 0;
    }
    var finalLots = null;
    if (marginLots == null && liqLots == null) finalLots = null;
    else if (marginLots == null) finalLots = liqLots;
    else if (liqLots == null) finalLots = marginLots;
    else finalLots = Math.min(marginLots, liqLots);
    return { lots: finalLots, marginLots: marginLots, liqLots: liqLots, avail: avail, vol: vol, oi: oi };
  }

  /* Margin-required dialogue: shown when Auto Lots lands on 0 because the real
     Dhan margin is short of even one lot. Throttled so a signal storm cannot
     spam it. */
  var _marginDlgAt = 0;
  function showMarginRequired(required, avail) {
    var now = Date.now();
    if (now - _marginDlgAt < 60000) return;
    _marginDlgAt = now;
    var msg = 'Margin required!\n\n'
      + 'Est. required for 1 lot: ' + fmtMoney(required) + '\n'
      + 'Dhan margin available: ' + (avail == null ? '--' : fmtMoney(avail)) + '\n\n'
      + 'Auto Lots = 0, isliye koi order place nahi hua. Funds add karein ya lots/margin settings kam karein.';
    try { if (window.toast) window.toast(msg, 'warn'); } catch (e) {}
    try { window.alert(msg); } catch (e) {}
  }


  /* ---- engine write-through (editable fields sync to the engine) ---- */
  function engineInput(id, val) {
    var e = el(id + SFX) || el(id);
    if (e) e.value = val;
  }
  function engineCheck(id, on) {
    var e = el(id + SFX) || el(id);
    if (e) e.checked = !!on;
  }
  function commit() {
    var ast = astEngine();
    if (ast && typeof ast.onUniversalInput === 'function') { try { ast.onUniversalInput(); } catch (e) {} }
  }

  /* ---- card markup ---- */
  function fieldRow(kind, field, label, cls) {
    cls = cls || '';
    return '<label class="rtom-f" style="display:flex;align-items:center;gap:5px;font-size:11px;color:#b8b8c8">'
      + '<span style="min-width:88px">' + label + '</span>'
      + '<input type="' + kind + '" class="' + cls + '" data-field="' + field + '" style="width:84px;background:#1a1a35;border:1px solid #35356a;color:#eaeaf5;border-radius:3px;padding:4px 6px;font-size:12px">'
      + '</label>';
  }
  function selectRow(field, label, opts) {
    return '<label class="rtom-f" style="display:flex;align-items:center;gap:5px;font-size:11px;color:#b8b8c8">'
      + '<span style="min-width:88px">' + label + '</span>'
      + '<select class="rtom-extra" data-field="' + field + '" style="background:#1a1a35;border:1px solid #35356a;color:#eaeaf5;border-radius:3px;padding:4px 6px;font-size:12px">'
      + opts.map(function (o) { return '<option value="' + o[0] + '">' + o[1] + '</option>'; }).join('')
      + '</select></label>';
  }
  function checkRow(field, label) {
    return '<label class="rtom-f" style="display:flex;align-items:center;gap:6px;font-size:11px;color:#cfe8ff">'
      + '<input type="checkbox" class="rtom-extra rtom-slice-chk" data-field="' + field + '" '
      + 'style="accent-color:#66ccff;width:15px;height:15px"> '
      + label + '<span style="font-size:10px;color:#888">(super ko iceberg jaisa; off = slice band)</span></label>';
  }

  function cardHTML(m) {
    var isSel = m.key === selKey;
    var extras = m.extras.map(function (x) {
      if (x.type === 'select') return selectRow(x.k, x.label, x.opts);
      if (x.type === 'check') return checkRow(x.k, x.label);
      return fieldRow('number', x.k, x.label, 'rtom-extra' + (x.cls ? ' ' + x.cls : ''));
    }).join('');
    var inp = 'background:#1a1a35;border:1px solid #35356a;color:#eaeaf5;border-radius:3px;padding:4px 6px;font-size:12px';
    return '<div class="rtom-card" id="rtomCard' + SFX + '_' + m.key + '" data-key="' + m.key + '" '
      + 'style="flex:1;min-width:300px;border:1px solid ' + (isSel ? '#b39ddb' : '#2d2d50') + ';border-radius:5px;padding:8px 10px;background:' + (isSel ? '#1a1a30' : '#101024') + ';opacity:' + (isSel ? '1' : '.55') + '">'
      + '<label style="display:flex;align-items:center;gap:6px;font-size:14px;color:' + (isSel ? '#e6d8ff' : '#999') + ';font-weight:700;cursor:pointer">'
      + '<input type="checkbox" class="rtom-enable" data-key="' + m.key + '"' + (isSel ? ' checked' : '') + ' style="accent-color:#b39ddb;width:16px;height:16px">'
      + m.name + ' <span style="font-size:11px;color:#777;font-weight:400">' + m.sdk + '</span></label>'
      + '<div style="font-size:11px;color:#888;margin:3px 0 6px">' + m.desc + '</div>'
      + '<div class="rtom-grid" style="display:flex;flex-direction:column;gap:5px">'
      + '<label style="display:flex;align-items:center;gap:5px;font-size:11px;color:#b8b8c8">'
      + '<span style="min-width:88px">Lot size (auto)</span>'
      + '<input type="text" class="rtom-lot" data-field="lot" readonly title="Dhan scrip-master lot size - auto fetched" style="width:84px;background:#14142c;border:1px dashed #4a4a80;color:#cfe8ff;border-radius:3px;padding:4px 6px;font-size:12px">'
      + '<span style="font-size:10px;color:#777">broker se auto</span></label>'
      + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">'
      + '<label style="display:flex;align-items:center;gap:5px;font-size:11px;color:#b8b8c8">'
      + '<span style="min-width:88px">Lots</span>'
      + '<input type="number" class="rtom-lots" data-field="lots" min="1" step="1" style="width:84px;' + inp + '"></label>'
      + '<label style="display:flex;align-items:center;gap:5px;font-size:11px;color:#ffd9a0">'
      + '<input type="checkbox" class="rtom-autolots" data-key="' + m.key + '" style="accent-color:#ffd700;width:15px;height:15px"> Auto Lots'
      + '<span style="font-size:10px;color:#888">(OI + Volume liquidity)</span></label></div>'
      + '<label style="display:flex;align-items:center;gap:5px;font-size:11px;color:#e0e0e0">'
      + '<input type="checkbox" class="rtom-sl-chk" data-key="' + m.key + '" style="accent-color:#ffcc66;width:15px;height:15px"> Overall SL'
      + '<input type="number" class="rtom-sl-pct" data-key="' + m.key + '" min="0" step="0.01" style="width:64px;' + inp + '"> %</label>'
      + '<label style="display:flex;align-items:center;gap:5px;font-size:11px;color:#ffb3b3">'
      + '<input type="checkbox" class="rtom-trail-chk" data-key="' + m.key + '" style="accent-color:#ff6b6b;width:15px;height:15px"> Trail SL'
      + '<input type="number" class="rtom-trail-pct" data-key="' + m.key + '" min="0" max="100" step="0.01" style="width:64px;' + inp + '"> %</label>'
      + '<label style="display:flex;align-items:center;gap:5px;font-size:11px;color:#7fe0c8">'
      + '<span style="min-width:88px">Take Profit</span>'
      + '<select class="rtom-tp-mode" data-key="' + m.key + '" style="' + inp + '">'
      + '<option value="auto">Auto</option><option value="manual">Manual</option><option value="off">Off</option></select>'
      + '<input type="number" class="rtom-tp-pct" data-key="' + m.key + '" min="0" step="0.1" style="width:64px;' + inp + '"> %</label>'
      + fieldRow('number', 'price', 'Est. premium', 'rtom-price')
      + extras
      + '<div style="display:flex;gap:12px;font-size:11px;margin-top:5px;border-top:1px dashed #35356a;padding-top:5px">'
      + '<span style="color:#888">Margin avail: <b class="rtom-avail" style="color:#ffd700">--</b></span>'
      + '<span style="color:#888">Required: <b class="rtom-req" style="color:#66ccff">--</b></span></div>'
      + '</div></div>';
  }

  function blockHTML() {
    return '<div id="rtOrderMethods' + SFX + '" class="account-section" '
      + 'style="border:1px solid #4a2d7e;border-radius:5px;margin:6px 0;padding:8px 10px;background:#0d0d1e">'
      + '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">'
      + '<h3 style="font-size:14px;color:#c4a9ff;text-transform:uppercase;margin:0">Order Placement Method</h3>'
      + '<span style="font-size:11px;color:#888">Sirf ek method enable hota hai; uske fields Realtime engine ki universal settings se synced hain.</span>'
      + '<span style="font-size:12px;color:#bbb;margin-left:auto">Dhan margin available: <b id="rtomMarginAvail' + SFX + '" style="color:#ffd700">--</b></span>'
      + '</div>'
      + '<div id="rtomRow' + SFX + '" style="display:flex;gap:10px;flex-wrap:wrap;margin-top:8px">'
      + METHODS.map(cardHTML).join('')
      + '</div></div>';
  }

  function card(key) { return el('rtomCard' + SFX + '_' + key); }
  function q(key, field) {
    var c = card(key); if (!c) return null;
    return c.querySelector('.' + field);
  }

  /* ---- enable/disable exclusivity ---- */
  function applySelection() {
    METHODS.forEach(function (m) {
      var c = card(m.key); if (!c) return;
      var on = m.key === selKey;
      c.style.opacity = on ? '1' : '.55';
      c.style.background = on ? '#1a1a30' : '#101024';
      c.style.borderColor = on ? '#b39ddb' : '#2d2d50';
      var cb = c.querySelector('.rtom-enable'); if (cb) cb.checked = on;
      c.querySelectorAll('input:not(.rtom-enable),select').forEach(function (inp) { inp.disabled = !on; });
    });
    refreshSliceFade();
  }

  /* ---- engine -> cards ---- */
  function setValIfIdle(key, field, value) {
    var e = q(key, field); if (!e) return;
    if (document.activeElement === e) return;
    e.value = value;
  }
  function tpModeOf(u) {
    if (u.manualTP === true) return 'manual';
    if (u.aiTp === true) return 'auto';
    return 'off';
  }
  function sync() {
    if (!block || _suppress) return;
    var ast = astEngine();
    var st = ast && ast.getState ? ast.getState() : null;
    var u = (st && st.universal) || {};
    METHODS.forEach(function (m) {
      var c = card(m.key); if (!c) return;
      var autoLot = autoLotSize();
      var lotEl = c.querySelector('.rtom-lot');
      if (lotEl) lotEl.value = autoLot > 0 ? autoLot : 'auto';
      var lotsEl = c.querySelector('.rtom-lots');
      if (lotsEl && document.activeElement !== lotsEl) lotsEl.value = (u.lots != null ? u.lots : 1);
      var alChk = c.querySelector('.rtom-autolots');
      if (alChk && document.activeElement !== alChk) alChk.checked = _autoLots;
      if (lotsEl) {
        lotsEl.readOnly = _autoLots;
        lotsEl.style.opacity = _autoLots ? '.7' : '1';
        lotsEl.title = _autoLots ? 'Auto Lots ON - engine OI + volume se decide karega' : '';
      }
      var slChk = c.querySelector('.rtom-sl-chk'); if (slChk && document.activeElement !== slChk) slChk.checked = u.manualSL === true;
      setValIfIdle(m.key, 'rtom-sl-pct', num(u.manualSLPct) > 0 ? u.manualSLPct : '');
      var trChk = c.querySelector('.rtom-trail-chk'); if (trChk && document.activeElement !== trChk) trChk.checked = u.manualTrailSL === true;
      setValIfIdle(m.key, 'rtom-trail-pct', num(u.manualTrailSLPct) > 0 ? u.manualTrailSLPct : '');
      var tm = c.querySelector('.rtom-tp-mode'); if (tm && document.activeElement !== tm) tm.value = tpModeOf(u);
      setValIfIdle(m.key, 'rtom-tp-pct', num(u.manualTPPct) > 0 ? u.manualTPPct : (num(u.tpPct) > 0 ? u.tpPct : ''));
      var cfgM = cfg[m.key] || {};
      c.querySelectorAll('.rtom-extra').forEach(function (e) {
        if (document.activeElement === e) return;
        var f = e.getAttribute('data-field');
        var v = cfgM[f]; if (v == null) return;
        if (e.type === 'checkbox') e.checked = isTruthy(v);
        else e.value = v;
      });
      var p = c.querySelector('.rtom-price');
      if (p && document.activeElement !== p && (p.value === '' || p.value == null)) {
        var pe = priceEstimate();
        if (pe > 0) p.value = pe;
      }
    });
    updateMargin();
    prefetchFreeze();
    refreshSliceFade();
  }

  function priceEstimate() {
    var ast = astEngine();
    try {
      if (ast && ast.pickedStrikes) {
        var ps = ast.pickedStrikes() || [];
        for (var i = 0; i < ps.length; i++) {
          var cs = (ps[i] && ps[i].contracts) || [];
          for (var j = 0; j < cs.length; j++) { if (num(cs[j].premium) > 0) return num(cs[j].premium); }
        }
      }
    } catch (e) {}
    return 0;
  }

  function updateMargin() {
    var avail = brokerMargin();
    /* Fix: the realtime engine's Margin must reflect the REAL Dhan funds, not
       the paper engine's default 100000. Push the broker balance into the
       realtime engine's own margin input whenever it changes (0 included, so an
       empty account shows the truth instead of a fake 1 lakh). */
    if (avail != null && avail !== _marginPushedVal) {
      engineInput('astMargin', Math.round(avail));
      _marginPushedVal = avail;
      commit();
    }
    var ha = el('rtomMarginAvail' + SFX);
    if (ha) ha.textContent = avail == null ? '--' : fmtMoney(avail);
    var c = card(selKey); if (!c) return;
    var cAvail = c.querySelector('.rtom-avail');
    if (cAvail) cAvail.textContent = avail == null ? '--' : fmtMoney(avail);
    var lot = autoLotSize();
    if (!(lot > 0)) lot = num((q(selKey, 'rtom-lot') || {}).value);
    var lots = num((q(selKey, 'rtom-lots') || {}).value) || 1;
    if (_autoLots) {
      var pe = num((q(selKey, 'rtom-price') || {}).value) || priceEstimate();
      var a = calcAutoLots(lot, pe);
      if (a.lots != null) lots = a.lots;
    }
    var price = num((q(selKey, 'rtom-price') || {}).value);
    var qty = lot * lots;
    var req = qty * price;
    var cReq = c.querySelector('.rtom-req');
    if (cReq) cReq.textContent = (qty <= 0 || price <= 0) ? '--' : fmtMoney(req);
  }
  function fmtMoney(n) {
    if (n == null || isNaN(n)) return '--';
    return '\u20b9' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /* ---- card -> engine ---- */
  function onCommonInput(e) {
    var cardEl = (e.closest && e.closest('.rtom-card')) || null;
    var key = cardEl ? cardEl.getAttribute('data-key') : selKey;
    var cls = e.className || '';
    if (e.type === 'checkbox') {
      if (cls.indexOf('rtom-autolots') >= 0) { _autoLots = !!e.checked; saveAutoLots(); applySelection(); sync(); return; }
      if (cls.indexOf('rtom-extra') >= 0) {
        if (!cfg[key]) cfg[key] = {};
        cfg[key][e.getAttribute('data-field')] = e.checked;
        saveCfg();
        refreshSliceFade();
        sync();
        return;
      }
      if (cls.indexOf('rtom-sl-chk') >= 0) engineCheck('astManualSL', e.checked);
      else if (cls.indexOf('rtom-trail-chk') >= 0) engineCheck('astManualTrailSL', e.checked);
      commit();
    } else if (cls.indexOf('rtom-lot') >= 0) { /* read-only auto - never writes engine lot size */ }
    else if (cls.indexOf('rtom-lots') >= 0 && !_autoLots) { engineInput('astLots', e.value); commit(); }
    else if (cls.indexOf('rtom-sl-pct') >= 0) { engineCheck('astManualSL', true); engineInput('astManualSLPct', e.value); commit(); }
    else if (cls.indexOf('rtom-trail-pct') >= 0) { engineCheck('astManualTrailSL', true); engineInput('astManualTrailSLPct', e.value); commit(); }
    else if (cls.indexOf('rtom-tp-mode') >= 0) {
      if (e.value === 'auto') { engineCheck('astAiTp', true); engineCheck('astManualTP', false); }
      else if (e.value === 'manual') { engineCheck('astAiTp', false); engineCheck('astManualTP', true); engineInput('astManualTPPct', (q(key, 'rtom-tp-pct') || {}).value || 5); }
      else { engineCheck('astAiTp', false); engineCheck('astManualTP', false); }
      commit();
    }
    else if (cls.indexOf('rtom-tp-pct') >= 0) { engineCheck('astManualTP', true); engineCheck('astAiTp', false); engineInput('astManualTPPct', e.value); commit(); }
    else if (cls.indexOf('rtom-extra') >= 0) {
      if (!cfg[key]) cfg[key] = {};
      cfg[key][e.getAttribute('data-field')] = e.value;
      saveCfg();
    }
    sync();
  }

  function onPriceInput() { updateMargin(); }

  function build() {
    if (_built) return;
    var placeholder = el('tab-realtime');
    if (!placeholder) return;
    var engineSection = null;
    placeholder.querySelectorAll('.account-section').forEach(function (sec) {
      var h3 = sec.querySelector('h3');
      if (h3 && /AI Smart Trading Engine/i.test(h3.textContent || '')) engineSection = sec;
    });
    if (!engineSection) return;
    load();
    /* Lot size is broker-auto: clear any persisted engine lot size so the engine
       resolves it per-target from the broker scrip master (u.lotSize = null). */
    var lotInput = el('astLotSize' + SFX) || el('astLotSize');
    if (lotInput && lotInput.value) { lotInput.value = ''; commit(); }
    var wrap = document.createElement('div');
    wrap.innerHTML = blockHTML();
    var node = wrap.firstChild;
    /* Place the methods row INSIDE the AI Smart Trading Engine block, directly
       below the P&L summary (astSummary). Falls back to just after the engine
       header row, then to the section itself. */
    var anchor = el('astSummary' + SFX) || el('astMarginBar' + SFX);
    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(node, anchor.nextSibling);
    } else {
      var first = engineSection.firstElementChild;
      if (first && first.nextSibling) engineSection.insertBefore(node, first.nextSibling);
      else engineSection.appendChild(node);
    }
    block = node;
    _built = true;
    /* events */
    block.querySelectorAll('.rtom-enable').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var k = cb.getAttribute('data-key');
        if (k) { selKey = k; saveSel(); applySelection(); sync(); }
      });
    });
    block.querySelectorAll('input,select').forEach(function (inp) {
      inp.addEventListener('input', function () { onCommonInput(inp); });
      inp.addEventListener('change', function () { onCommonInput(inp); });
    });
    block.querySelectorAll('.rtom-price').forEach(function (p) { p.addEventListener('input', onPriceInput); });
    applySelection();
    sync();
  }

  window.RealtimeOrders = {
    build: build,
    sync: sync,
    current: function () { return { key: selKey, cfg: cfg[selKey] || {} }; },
    config: function (key) { return cfg[key] || {}; },
    selected: function () { return selKey; },
    priceEstimate: priceEstimate,
    autoLots: function () { return _autoLots; },
    setAutoLots: function (on) { _autoLots = !!on; saveAutoLots(); sync(); return _autoLots; },
    autoLotSize: autoLotSize,
    calcAutoLots: calcAutoLots,
    pickedContracts: pickedContracts,
    showMarginRequired: showMarginRequired,
    freezeQtyFor: freezeQtyFor,
    resolveSliceChunk: resolveSliceChunk,
    autoSliceOn: autoSliceOn,
    prefetchFreeze: prefetchFreeze,
    refreshSliceFade: refreshSliceFade,
    _methods: METHODS
  };
})();
