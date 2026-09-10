/* Dhan Algo - Smart Chart List + Open Chart (inside the Paper Trade tab)
   Shows one live row per resolved instrument of the running AST engine
   (indicator-filter / strategy mode). Rows open/close as symbols join/leave
   the selected universe (NIFTY trend following / Top Movers). Two rows:
     - top   : STRATEGY RUNNING  - instrument being live-evaluated, no open trade
     - bottom: TRADE EXECUTION   - open position rows with running P&L (a row
               moves here on entry and stays until its trade closes, even if the
               symbol left the universe)
   Each row is a COMPACT LISTING: symbol + engine timeframe badge + live LTP /
   P&L status + an "Open chart" button. No mini candlestick is drawn inside the
   grid (that was the source of blank / flickering sticks). Analysis + paper
   trade execution run engine-wide on every selected strike simultaneously and
   in realtime (the AST engine drives that, independent of the grid).
   Clicking "Open chart" loads that symbol in the option-chain style main
   candlestick chart tab - full REST history + realtime WS patch - auto-deploys
   the AST-selected indicator overlays and shows ENTRY / SL / TRAIL SL / TP
   lines for open positions. Signal alerts already surface in the right-hand
   event log; the chart is opened to verify them. */
(function () {
  'use strict';

  if (window.ChartGrid) return;

  function fmtPx(v, d) {
    if (v == null || !isFinite(v)) return '-';
    d = d == null ? 2 : d;
    return v.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function fmtMoney(v) {
    if (v == null || !isFinite(v)) return '-';
    var s = v < 0 ? '-' : '';
    return s + '\u20b9' + Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  }

  /* ---------------- grid state ---------------- */
  var store = {};            /* engine suffix ('', '_paper1'...) -> last snapshot */
  var cards = {};            /* key -> row state object                          */
  var cardScope = null;      /* suffix of the paper tab currently rendered        */
  var timer = null;
  var colSeq = 0;

  function activeScope() {
    var act = document.querySelector('.tab-content.active');
    if (!act) return null;
    var id = act.id || '';
    if (id === 'tab-papertrade') return { el: act, suffix: '' };
    var m = /^tab-(paper\d+)$/.exec(id);
    if (m) return { el: act, suffix: '_' + m[1] };
    return null;
  }

  function qid(scope, base) {
    return scope.el.querySelector('#' + base + scope.suffix);
  }

  function lastSnap(scope) {
    if (!scope) return null;
    return store[scope.suffix] || null;
  }

  /* Public entry called by every AST engine instance after each tick.        */
  function onAstSnapshot(snap) {
    if (!snap) return;
    store[snap.eng || ''] = snap;
    if (window.ChartGrid._view === 'grid') {
      var sc = activeScope();
      if (sc && (snap.eng || '') === sc.suffix) {
        reconcile(sc);
      }
    }
  }

  function showView(btn) {
    var tab = btn && btn.closest ? btn.closest('.tab-content') : null;
    var view = btn ? (btn.getAttribute('data-ptview') || 'engine') : 'engine';
    if (!tab) { var sc = activeScope(); if (sc) tab = sc.el; }
    if (!tab) return;
    var engineView = tab.querySelector('[id^="ptEngineView"]');
    var gridView = tab.querySelector('[id^="ptGridView"]');
    var bar = tab.querySelector('.pt-subbar');
    if (bar) {
      bar.querySelectorAll('.pt-view-btn').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-ptview') === view);
      });
    }
    if (engineView) engineView.style.display = view === 'engine' ? 'flex' : 'none';
    if (gridView) gridView.style.display = view === 'grid' ? 'flex' : 'none';
    window.ChartGrid._view = view;
    if (view === 'grid') {
      requestAnimationFrame(function () {
        reconcile(tabToScope(tab));
      });
    }
    updateSubStatus();
  }

  function tabToScope(tab) {
    var id = tab.id || '';
    if (id === 'tab-papertrade') return { el: tab, suffix: '' };
    var m = /^tab-(paper\d+)$/.exec(id);
    return m ? { el: tab, suffix: '_' + m[1] } : { el: tab, suffix: '' };
  }

  function updateSubStatus() {
    document.querySelectorAll('.pt-subbar').forEach(function (bar) {
      var st = bar.querySelector('[id^="ptGridSubStatus"]');
      if (!st) return;
      var view = window.ChartGrid._view || 'engine';
      if (view === 'grid') {
        var n = 0, p = 0;
        Object.keys(cards).forEach(function (k) { if (cards[k].row === 'exec') p++; else n++; });
        st.textContent = 'strategy ' + n + ' | execution ' + p;
      } else {
        st.textContent = '';
      }
    });
  }

  /* ---------------- signal / trade-executed event log (right panel) -------- */
  /* Rendered newest-first. `evRef` holds the newest already-rendered event
     object (identity, not seq) so engine restarts that reset the ring are
     detected and the whole fresh log is shown again instead of skipping. */
  var evRef = {};                 /* engine suffix -> newest rendered event obj */
  var MAX_EV_DOM = 40;

  function _pad2(n) { return (n < 10 ? '0' : '') + n; }

  function evTime(ts) {
    if (window.IST12 && IST12.fmtMs && IST12.fmtD) {
      return IST12.fmtMs(ts) + ' ' + IST12.fmtD(ts);
    }
    var d = new Date(ts);
    return _pad2(d.getHours()) + ':' + _pad2(d.getMinutes()) + ':' + _pad2(d.getSeconds()) +
      ' ' + _pad2(d.getDate()) + '/' + _pad2(d.getMonth() + 1);
  }

  function evRow(e) {
    var w = document.createElement('div');
    w.className = 'cg-ev ' + (e.type === 'entry' ? 'entry' : 'signal');
    var top = document.createElement('div');
    top.className = 'cg-ev-top';
    var b = document.createElement('span');
    b.className = 'cg-ev-badge';
    b.textContent = e.type === 'entry' ? 'TRADE EXECUTED' : 'SIGNAL MEET';
    var t = document.createElement('span');
    t.className = 'cg-ev-time';
    t.textContent = evTime(e.ts);
    top.appendChild(b);
    top.appendChild(t);
    var nm = document.createElement('div');
    nm.className = 'cg-ev-name';
    nm.textContent = e.name || 'Unknown chart';
    var sub = document.createElement('div');
    sub.className = 'cg-ev-sub';
    if (e.type === 'entry') {
      sub.textContent = ((e.strategy ? e.strategy + ' \u00b7 ' : '')) +
        (e.side || '') + ' ' + (e.qty || '') + ' @ ' + (e.price != null ? Number(e.price).toFixed(2) : '-');
    } else {
      sub.textContent = ((e.strategy ? e.strategy + ' \u00b7 ' : '')) + 'entry conditions met';
    }
    w.appendChild(top);
    w.appendChild(nm);
    w.appendChild(sub);
    return w;
  }

  function syncEvents(scope) {
    var list = qid(scope, 'ptCgEventsList');
    if (!list) return;
    var snap = lastSnap(scope);
    var evs = (snap && snap.events) || [];
    var key = scope.suffix || '';
    var prev = evRef[key] || null;
    var fresh;
    if (!prev) {
      fresh = evs;
    } else {
      var idx = -1;
      for (var i = 0; i < evs.length; i++) { if (evs[i] === prev) { idx = i; break; } }
      fresh = idx >= 0 ? evs.slice(idx + 1) : evs;
    }
    if (fresh.length) {
      for (var ci = list.children.length - 1; ci >= 0; ci--) {
        var ch = list.children[ci];
        if (ch && ch.className && String(ch.className).indexOf('cg-ev-empty') >= 0) list.removeChild(ch);
      }
      for (var j = 0; j < fresh.length; j++) {
        list.insertBefore(evRow(fresh[j]), list.firstChild);
      }
      evRef[key] = fresh[fresh.length - 1];
    }
    while (list.children.length > MAX_EV_DOM) list.removeChild(list.lastChild);
    var count = 0;
    for (var k = 0; k < list.children.length; k++) {
      if (list.children[k] && list.children[k].className && String(list.children[k].className).indexOf('cg-ev ') >= 0) count++;
    }
    var cEl = qid(scope, 'ptCgEvCount');
    if (cEl) cEl.textContent = count ? (count + (count === 1 ? ' event' : ' events')) : 'session log';
  }

  /* ---------------- row lifecycle ---------------- */

  function symOf(item) {
    return { id: Number(item.id), exch: item.exch, inst: item.inst, name: item.name || '' };
  }

  /* Live LTP for a symbol from the merged WS quote store (same keying as
     HftPool.quote / PaperTrade.quoteFor). Undefined when no quote arrived yet. */
  function liveQuoteOf(sym) {
    if (!sym) return null;
    var qm = (typeof clientQuotes !== 'undefined') ? clientQuotes : null;
    if (!qm) return null;
    var key = sym.exch === 'IDX_I' ? 'IDX_I:' + sym.id : String(sym.id);
    var q = qm[key] || null;
    return (q && q.ltp != null && isFinite(Number(q.ltp)) && Number(q.ltp) > 0) ? Number(q.ltp) : null;
  }

  function execCardItem(p, pk) {
    var sid = Number(p.symbolId);
    if (!(sid > 0)) return null;
    return {
      key: pk || (String(sid) + ':' + (p.symbolExch || 'NSE')),
      id: sid, exch: p.symbolExch || 'NSE', inst: p.inst || 'OPTIDX',
      name: p.instrumentName || (p.symbol || ('#' + sid)),
      tf: p.entryTf || '1min'
    };
  }

  function entryTfOf(snap, item, pos) {
    var w = null;
    if (snap && snap.entryTf) w = snap.entryTf;
    if (!w && item && item.tf) w = item.tf;
    return w === '5min' ? '5min' : '1min';
  }

  function buildRow(scope, key, item, pos) {
    var row = pos ? qid(scope, 'ptCgExecRow') : qid(scope, 'ptCgStrategyRow');
    if (!row) return null;
    var el = document.createElement('div');
    el.className = 'cg-row-el' + (pos ? ' exec' : '');
    el.setAttribute('data-key', key);
    el.innerHTML =
      '<div class="cg-rmain">' +
      '<span class="cg-rtf"></span>' +
      '<span class="cg-rname"></span>' +
      '<span class="cg-rtext"></span>' +
      '</div>' +
      '<button type="button" class="cg-open">Open chart</button>';
    var snap = lastSnap(scope);
    var cd = {
      key: key, el: el, row: pos ? 'exec' : 'strategy', oid: (++colSeq),
      item: item, pos: pos || null, snap: snap,
      tf: entryTfOf(snap, item, pos), _last: null, _prev: null
    };
    cards[key] = cd;
    var btn = el.querySelector('.cg-open');
    if (btn) {
      btn.textContent = 'Open chart';
      btn.addEventListener('click', function () { openChartFor(cd); });
    }
    row.appendChild(el);
    updateRow(cd);
    return cd;
  }

  function destroyRow(key) {
    var cd = cards[key];
    if (!cd) return;
    if (cd.el && cd.el.parentNode) cd.el.parentNode.removeChild(cd.el);
    delete cards[key];
  }

  function moveToRow(cd, scope, exec) {
    var row = exec ? qid(scope, 'ptCgExecRow') : qid(scope, 'ptCgStrategyRow');
    if (!row) return;
    if (cd.el.parentNode === row) return;
    cd.el.className = 'cg-row-el' + (exec ? ' exec' : '');
    cd.row = exec ? 'exec' : 'strategy';
    row.appendChild(cd.el);
  }

  /* Recompute the row text. Uses the WS quote store for live LTP; without a
     quote the last known value is kept so rows never flicker to '-'. */
  function updateRow(cd, fromQuote) {
    if (!cd || !cd.el || !cd.el.isConnected) return;
    var rt = cd.el.querySelector('.cg-rtf');
    if (rt) rt.textContent = cd.tf === '5min' ? '5m' : '1m';
    var rname = cd.el.querySelector('.cg-rname');
    if (rname) {
      var nm = (cd.item && (cd.item.name || cd.item.instrumentName)) || cd.key || '';
      if (rname.textContent !== nm) rname.textContent = nm;
    }
    var cur = fromQuote === undefined ? liveQuoteOf(symOf(cd.item || {})) : fromQuote;
    if (cur != null) {
      if (!cd.pos && cd._prev != null) cd._chg = cur - cd._prev;
      cd._prev = cur;
      cd._last = cur;
    }
    var disp = cd._last;
    var rtext = cd.el.querySelector('.cg-rtext');
    if (!rtext) return;
    var p = cd.pos;
    var txt;
    if (p) {
      /* Exec rows share the single canonical mark + money-P&L with the chart's
         running-P&L label and the AST Running Trades rows (live feed first,
         chart/candle-close fallback), so the same open position is worth the
         exact same number in every view. Falls back to this row's live quote. */
      var mark = (typeof window.positionMarkPrice === 'function') ? window.positionMarkPrice(p) : null;
      if (!(mark > 0)) mark = disp;
      var side = (p.side || 'BUY').toUpperCase();
      var qty = Number(p.qty) || 0;
      var entry = Number(p.entryPrice);
      var pnl;
      if (typeof window.positionMoneyPnl === 'function') {
        pnl = window.positionMoneyPnl(p, mark);
      } else {
        pnl = (mark != null && entry > 0 && qty > 0)
          ? ((side === 'BUY' ? 1 : -1) * (mark - entry)) * qty : null;
      }
      txt = 'LTP ' + fmtPx(mark) + ' | ' + side + ' ' + qty + ' @ ' + fmtPx(entry) +
        ' | P&L ' + (pnl == null ? '\u2026' : (pnl >= 0 ? '+' : '') + fmtMoney(pnl));
      if (Number(p.stopLoss) > 0) txt += ' | ' + (p.slTrailed ? 'TRAIL SL' : 'SL') + ' ' + fmtPx(p.stopLoss);
      if (Number(p.tpPct) > 0) txt += ' | TP ' + Number(p.tpPct) + '%';
      rtext.textContent = txt;
    } else {
      if (disp != null) {
        txt = 'LTP ' + fmtPx(disp) + (cd._chg == null ? '' : (cd._chg >= 0 ? '  +' : '  ') + fmtPx(Math.abs(cd._chg)));
        rtext.textContent = txt;
      } else if (!cd._noQuote) {
        cd._noQuote = true;
        rtext.textContent = 'waiting for live quote\u2026';
      }
    }
  }

  /* Build the desired row set from the latest snapshot and sync DOM.       */
  function reconcile(scope) {
    if (!scope) return;
    if (cardScope !== scope.suffix) {
      Object.keys(cards).forEach(function (k) { destroyRow(k); });
      cardScope = scope.suffix;
    }
    var snap = lastSnap(scope);
    var strategyRow = qid(scope, 'ptCgStrategyRow');
    var execRow = qid(scope, 'ptCgExecRow');
    var statusEl = qid(scope, 'ptCgStatus');
    if (!strategyRow || !execRow) return;

    var desired = {};   /* key -> {item, pos} */
    if (snap) {
      (snap.cards || []).forEach(function (it) {
        if (!it || !it.key) return;
        desired[it.key] = { item: it, pos: null };
      });
      Object.keys(snap.positions || {}).forEach(function (pk) {
        var p = snap.positions[pk];
        if (!p || !p.symbolId) return;
        var it = execCardItem(p, pk);
        if (!it) return;
        desired[it.key] = { item: it, pos: p };
      });
    }

    var keep = {};
    Object.keys(desired).forEach(function (k) {
      var cfg = desired[k];
      var cd = cards[k];
      if (cd) {
        cd.item = cfg.item;
        cd.pos = cfg.pos;
        cd.snap = snap;
        var wantTf = entryTfOf(snap, cfg.item, cfg.pos);
        if (cd.tf !== wantTf) cd.tf = wantTf;
        moveToRow(cd, scope, !!cfg.pos);
      } else {
        cd = buildRow(scope, k, cfg.item, cfg.pos);
      }
      if (cd) { cd.snap = snap; updateRow(cd); }
      keep[k] = true;
    });

    Object.keys(cards).forEach(function (k) {
      if (!keep[k]) destroyRow(k);
    });

    [strategyRow, execRow].forEach(function (rowEl, ri) {
      var prev = rowEl.querySelector('.cg-empty');
      if (prev) prev.parentNode.removeChild(prev);
      var kind = ri === 0 ? 'strategy' : 'exec';
      if (!rowEl.children.length) {
        var e = document.createElement('div');
        e.className = 'cg-empty';
        e.textContent = kind === 'strategy'
          ? 'No instruments being evaluated yet - start / run the AI Smart engine and the resolved symbols open here automatically.'
          : 'No open positions yet.';
        rowEl.appendChild(e);
      }
    });

    var info = '';
    if (snap) {
      var ov = (snap.overlays || []).length;
      info = 'universe ' + (snap.cards || []).length + ' | open ' + (Object.keys(snap.positions || {}).length) +
        (ov ? ' | indicator filters ' + ov : '') + (snap.fast ? '' : ' | Ultrafast OFF');
    }
    if (statusEl) statusEl.textContent = info;
    updateSubStatus();
    syncEvents(scope);
  }

  /* ---------------- Open chart -> option-chain style main chart tab -------- */

  /* Deploy the AST-selected indicator overlays so the opened chart shows exactly
     what the engine evaluates. The deploy is IDEMPOTENT against the live chart
     state (not a "deployed once per page session" flag): IndChart stores each
     indicator's settings MERGED with its defaults, so a raw JSON equality check
     against our sparse spec settings never matches and identical overlays stack
     on every open. We therefore match by the spec keys only, and when the chart
     already carries duplicate instances of a wanted overlay we collapse them to
     one via restoreIndicators (only if the API is available). Repeated "Open
     chart" clicks can never multiply the same indicators again. */
  function _specMatch(stored, want) {
    if (!want) return true;
    for (var k in want) {
      if (Object.prototype.hasOwnProperty.call(want, k) && stored[k] !== want[k]) return false;
    }
    return true;
  }

  function deployOverlays(specs) {
    var IC = window.IndChart;
    if (!IC || !specs || !specs.length) return;
    if (typeof IC.addIndicator !== 'function' || !IC.IND) return;
    var want = [];
    specs.forEach(function (s) { if (s && s.id) want.push(s); });
    if (!want.length) return;
    var cur = [];
    try { cur = (typeof IC.getIndicators === 'function') ? IC.getIndicators() : []; } catch (e) { cur = []; }
    /* A wanted spec is already satisfied when ANY deployed instance carries the
       same id and settings values for every key the spec declares. */
    function satisfied(id, settings) {
      for (var i = 0; i < cur.length; i++) {
        if (cur[i] && cur[i].id === id && _specMatch(cur[i].settings || {}, settings || {})) return true;
      }
      return false;
    }
    function matchesSpec(it) {
      for (var j = 0; j < want.length; j++) {
        if (want[j].id === it.id && _specMatch(it.settings || {}, want[j].settings || {})) return true;
      }
      return false;
    }
    /* Duplicate detection: does any wanted overlay already exist more than once
       (legacy stacking from earlier deploys)? */
    var hasDup = false;
    for (var di = 0; di < want.length && !hasDup; di++) {
      var cnt = 0;
      for (var ci = 0; ci < cur.length; ci++) {
        if (cur[ci] && cur[ci].id === want[di].id && _specMatch(cur[ci].settings || {}, want[di].settings || {})) cnt++;
      }
      if (cnt > 1) hasDup = true;
    }
    if (hasDup && typeof IC.restoreIndicators === 'function') {
      /* Self-heal: keep every non-matching overlay untouched, then emit exactly
         one instance per wanted overlay. */
      var keep = [];
      cur.forEach(function (it) { if (!matchesSpec(it)) keep.push({ id: it.id, settings: it.settings }); });
      want.forEach(function (w) { keep.push({ id: w.id, settings: w.settings || {} }); });
      try { IC.restoreIndicators(keep); return; } catch (e) {}
    }
    want.forEach(function (w) {
      if (satisfied(w.id, w.settings)) return;
      try { IC.addIndicator(w.id, w.settings || {}); } catch (e) {}
    });
  }

  function openChartFor(cd) {
    if (!cd || !cd.item) return;
    var it = cd.item;
    var sid = Number(it.id);
    if (!(sid > 0)) return;
    var tf = (cd.tf === '5min' || cd.tf === '1min') ? cd.tf : null;
    try {
      if (tf && typeof window.setChartTfOnly === 'function') window.setChartTfOnly(tf);
      else if (tf) window.chartTf = tf;
    } catch (e) {}
    var p = null;
    try {
      if (typeof window.openOptionChartBySid === 'function') {
        p = window.openOptionChartBySid(sid, it.exch || 'NSE_FNO', it.inst || 'OPTIDX', it.name || it.instrumentName || ('#' + sid));
      }
    } catch (e) { p = null; }
    var scope = activeScope();
    var specs = null;
    if (scope) { var sn = lastSnap(scope); if (sn) specs = sn.overlays || null; }
    function deploy() { try { deployOverlays(specs); } catch (e) {} }
    if (p && typeof p.then === 'function') { p.then(deploy, deploy); }
    else setTimeout(deploy, 400);
  }

  /* ---------------- live price pump (1s text refresh) ---------------- */

  function pumpOnce() {
    var scope = activeScope();
    if (!scope) return;
    if (window.ChartGrid._view !== 'grid') return;
    var gv = qid(scope, 'ptGridView');
    if (!gv || gv.style.display === 'none') return;
    Object.keys(cards).forEach(function (k) {
      var cd = cards[k];
      if (!cd || !cd.el || !cd.el.isConnected) return;
      try { updateRow(cd); } catch (e) {}
    });
  }

  /* ---------------- public API ---------------- */

  function refresh() {
    var sc = activeScope();
    if (!sc) return;
    reconcile(sc);
    pumpOnce();
    if (timer) { clearInterval(timer); timer = null; }
    startPump();
  }

  function startPump() {
    if (!timer) {
      timer = setInterval(function () { pumpOnce(); }, 1000);
    }
  }

  function init() {
    if (window.ChartGrid._started) return;
    window.ChartGrid._started = true;
    startPump();
    window.addEventListener('astTickEnd', function (e) {
      if (e && e.detail) onAstSnapshot(e.detail);
    });
    reconcile(activeScope());
  }

  window.ChartGrid = {
    init: init,
    showView: showView,
    refresh: refresh,
    onAstSnapshot: onAstSnapshot,
    openChartFor: openChartFor,
    _view: 'engine',
    _cards: cards
  };
})();
