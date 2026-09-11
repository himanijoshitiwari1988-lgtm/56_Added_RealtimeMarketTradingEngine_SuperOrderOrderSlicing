/* Dhan Algo - Realtime Running Strategies & Trades (Realtime Trading Engine tab)
 *
 * Renders the "Running Strategies & Trades" block that lives inside the
 * Realtime Trading Engine tab (cloned from the Paper Trade pane, ids suffixed
 * "_realtime"):
 *
 *   Running Strategies  -> the strategies currently running in the realtime
 *                          AI Smart instance (TabEngines.aismart.realtime),
 *                          i.e. the strategies ticked/armed in this tab.
 *   Running Trades      -> the OPEN POSITIONS fetched live from Dhan
 *                          (/api/account -> broker.get_positions()), with
 *                          buy avg, LTP and gross P&L. This is the broker's
 *                          real book, not the engine's local ledger.
 *
 * Polls only while the Realtime Trading Engine tab is visible.
 */
(function () {
  'use strict';
  var REFRESH_MS = 5000;
  var _timer = null;

  function el(id) { return document.getElementById(id + '_realtime'); }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmt2(n) { return (n === null || n === undefined || isNaN(n)) ? '--' : Number(n).toFixed(2); }
  function fmtMoney(n) {
    return (n === null || n === undefined || isNaN(n)) ? '--'
      : '\u20b9' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function astEngine() {
    return (window.TabEngines && window.TabEngines.aismart && window.TabEngines.aismart.realtime) || null;
  }
  function realtimeExec() {
    return (window.TabEngines && window.TabEngines.realtime && window.TabEngines.realtime.realtime) || null;
  }

  /* ---------------- running strategies (realtime engine) ---------------- */
  function renderStrategies() {
    var host = el('ptRunStrategies');
    if (!host) return;
    var eng = astEngine();
    var list = [], st = null;
    try { if (eng && eng.runningStrategies) list = eng.runningStrategies() || []; } catch (e) {}
    try { if (eng && eng.getState) st = eng.getState(); } catch (e) {}
    var engOn = !!(st && st.enabled);
    var armed = !!(window.RealtimeBroker && RealtimeBroker.isArmed && RealtimeBroker.isArmed());
    var armBtn = '';
    if (window.RealtimeBroker) {
      if (engOn) {
        armBtn = '<button onclick="RealtimeBroker.toggleArm();RealtimeRun.renderStrategies();RealtimeRun.renderTrades()" '
          + 'style="font-size:8px;padding:1px 7px;border-radius:3px;cursor:pointer;font-weight:600;'
          + 'border:1px solid ' + (armed ? '#ef5350' : '#00d4aa') + ';'
          + 'background:' + (armed ? 'rgba(239,83,80,.15)' : 'rgba(0,212,170,.12)') + ';'
          + 'color:' + (armed ? '#ef5350' : '#00d4aa') + '">' + (armed ? 'LIVE ARMED (pause)' : 'ARM LIVE') + '</button>';
      } else {
        armBtn = '<span style="font-size:8px;color:#888;border:1px solid #333;border-radius:3px;padding:1px 7px">ORDERS BLOCKED (engine OFF)</span>';
      }
    }
    var head = '<div style="display:flex;justify-content:space-between;align-items:center;gap:6px;font-size:9px;color:#888;padding:0 0 3px">'
      + '<span>' + (engOn ? '<span style="color:#00d4aa">Engine RUNNING</span>' : '<span style="color:#ffd700">Engine OFF</span>')
      + ' \u00b7 ' + list.length + ' strateg' + (list.length === 1 ? 'y' : 'ies') + '</span>' + armBtn + '</div>';
    if (!list.length) {
      host.innerHTML = head + '<div style="font-size:10px;color:#666;padding:2px 2px">Realtime engine me koi strategy running nahi hai. '
        + 'Realtime Trading Engine tab me strategies tick karke Run dabao.</div>';
      return;
    }
    host.innerHTML = head + list.map(function (s) {
      var cat = s.cat || 'bullish';
      var col = cat === 'bearish' ? '#ef5350' : (cat === 'sideways' ? '#b39ddb' : '#00d4aa');
      return '<div style="display:flex;justify-content:space-between;gap:6px;font-size:9px;border:1px solid #1e1e40;border-radius:3px;padding:2px 6px;margin:2px 0">' +
        '<span><b style="color:#d0d0d0">' + esc(s.name || s.key || 'Strategy') + '</b> ' +
        '<span style="color:' + col + '">' + esc(cat) + '</span></span>' +
        '<span style="color:#666">' + esc(s.tf || '') + '</span></div>';
    }).join('');
  }

  /* ---------------- running trades (live Dhan open positions) ---------------- */
  function renderTrades() {
    var host = el('ptRunTrades');
    if (!host) return;
    host.innerHTML = '<div style="font-size:9px;color:#666;padding:4px 2px">Fetching open positions from Dhan\u2026</div>';
    fetch('/api/account').then(function (r) { return r.json(); }).then(function (d) {
      if (!d || d.status !== 'success') {
        host.innerHTML = '<div style="font-size:10px;color:#ef5350;padding:6px 2px">Dhan: ' +
          esc((d && d.message) || 'not connected') + '</div>';
        return;
      }
      renderTradesFrom(d.data);
    }).catch(function (e) {
      host.innerHTML = '<div style="font-size:10px;color:#ef5350;padding:6px 2px">Dhan fetch error: ' +
        esc(e && e.message ? e.message : e) + '</div>';
    });
  }
  function renderTradesFrom(data) {
    var host = el('ptRunTrades');
    if (!host) return;
    var positions = (data && data.positions) || [];
    var at = new Date();
    if (!positions.length) {
      host.innerHTML = '<div style="font-size:10px;color:#666;padding:6px 2px">Dhan me koi open position nahi hai.</div>';
      return;
    }
    var tot = 0;
    var rows = positions.map(function (p) {
      var pnl = Number(p.pnl) || 0; tot += pnl;
      var col = pnl >= 0 ? '#00d4aa' : '#ef5350';
      return '<tr>' +
        '<td><b>' + esc(p.symbol) + '</b><br><span style="font-size:8px;color:#666">' +
          esc(p.exchange) + ' \u00b7 ' + esc(p.type) + (p.product ? ' \u00b7 ' + esc(p.product) : '') + '</span></td>' +
        '<td>' + esc(p.qty) + '</td>' +
        '<td>' + fmt2(p.buy_avg) + '</td>' +
        '<td>' + fmt2(p.ltp) + '</td>' +
        '<td style="color:' + col + '">' + (pnl >= 0 ? '+' : '-') + fmtMoney(Math.abs(pnl)) + '</td>' +
        '<td style="color:' + col + '">' + (p.pnl_pct >= 0 ? '+' : '') + esc(p.pnl_pct) + '%</td>' +
        '</tr>';
    }).join('');
    var totCol = tot >= 0 ? '#00d4aa' : '#ef5350';
    host.innerHTML = '<table class="account-table"><thead><tr><th>Symbol</th><th>Qty</th><th>Buy avg</th><th>LTP</th><th>P&amp;L</th><th>P&amp;L %</th></tr></thead><tbody>' +
      rows + '</tbody></table>' +
      '<div style="font-size:9px;color:#888;padding:3px 2px">Total gross P&amp;L: <b style="color:' + totCol + '">' +
      (tot >= 0 ? '+' : '-') + fmtMoney(Math.abs(tot)) + '</b> \u00b7 updated ' + at.toLocaleTimeString('en-IN') + '</div>';
  }

  /* ---------------- broker super-order trail mirror ---------------- */
  /* Super orders carry a native Dhan STOP_LOSS_LEG + trailingJump. The app does
     not double-manage those exits; it mirrors the broker leg back as Overall-SL%
     and Trail-SL% so the operator can watch the exact level Dhan will cut at.
     One host div is created as a sibling of the trades table (rebuilt tags let
     the trades table be re-rendered without wiping this panel). */
  function brokerTrailHost() {
    var trades = el('ptRunTrades');
    if (!trades || !trades.parentNode) return null;
    var h = document.getElementById('rtBrokerTrail_realtime');
    if (!h) {
      h = document.createElement('div');
      h.id = 'rtBrokerTrail_realtime';
      h.style.cssText = 'margin-top:8px';
      trades.parentNode.insertBefore(h, trades.nextSibling);
    }
    return h;
  }
  function pctTxt(v) { return (v == null || isNaN(v)) ? '--' : (Math.round(Number(v) * 100) / 100).toFixed(2) + '%'; }

  function renderBrokerTrail() {
    var host = brokerTrailHost();
    if (!host) return;
    var exec = realtimeExec();
    var all = (exec && exec.getState) ? (exec.getState().autoPositions || {}) : {};
    var keys = Object.keys(all).filter(function (k) {
      var p = all[k];
      return p && (p.brokerTrail === true || p.method === 'super') && p.superOrderId != null;
    });
    if (!keys.length) { host.innerHTML = ''; return; }
    var rows = keys.map(function (k) {
      var p = all[k];
      var col = p.side === 'SELL' ? '#ef5350' : '#00d4aa';
      var nLegs = (Array.isArray(p.slices) && p.slices.length) ? p.slices.length : 1;
      var sub = 'Dhan super SL leg' + (nLegs > 1 ? (' \u00b7 ' + nLegs + ' slice legs') : '');
      return '<tr data-key="' + esc(k) + '">' +
        '<td><b>' + esc(p.symbol) + '</b><br><span style="font-size:8px;color:#666">' + sub + '</span></td>' +
        '<td style="color:' + col + '">' + esc(p.side) + '</td>' +
        '<td>' + fmt2(p.entryPrice) + '</td>' +
        '<td class="rtt-sl">' + (p.brokerSlPrice != null ? fmt2(p.brokerSlPrice) : '--') + '</td>' +
        '<td class="rtt-slpct">' + pctTxt(p.brokerSlPct) + '</td>' +
        '<td class="rtt-trailpct" style="color:#ffb3b3">' + pctTxt(p.brokerTrailPct) + '</td>' +
        '<td class="rtt-status" style="color:#888">--</td>' +
        '</tr>';
    }).join('');
    host.innerHTML = '<div style="font-size:9px;color:#c4a9ff;font-weight:700;margin:2px 0">Dhan Super Order SL / Trail mirror (broker-side)</div>'
      + '<table class="account-table"><thead><tr><th>Symbol</th><th>Side</th><th>Entry</th><th>Broker SL</th><th>Overall SL%</th><th>Trail SL%</th><th>Status</th></tr></thead><tbody>'
      + rows + '</tbody></table>';
    if (!window.RealtimeBroker || !RealtimeBroker.getSuperTrail) return;
    keys.forEach(function (k) {
      var p = all[k];
      try {
        RealtimeBroker.getSuperTrail(p).then(function (t) {
          if (!t) return;
          var tr = host.querySelector('tr[data-key="' + k + '"]');
          if (!tr) return;
          var c = tr.querySelector('.rtt-sl'); if (c) c.textContent = t.slPrice != null ? fmt2(t.slPrice) : '--';
          var cp = tr.querySelector('.rtt-slpct'); if (cp) cp.textContent = pctTxt(t.slPct);
          var ct = tr.querySelector('.rtt-trailpct'); if (ct) ct.textContent = pctTxt(t.trailPct);
          var cs = tr.querySelector('.rtt-status');
          if (cs) {
            cs.textContent = t.triggered ? ('TRIGGERED (' + esc(t.legStatus || t.status) + ')') : esc(t.status || 'LIVE');
            cs.style.color = t.triggered ? '#ef5350' : '#00d4aa';
          }
          /* Keep the tracked position's broker snapshot fresh for the running
             list / order section readouts. */
          p.brokerSlPrice = t.slPrice; p.brokerTrailJump = t.trailingJump;
          p.brokerSlPct = t.slPct; p.brokerTrailPct = t.trailPct;
        }).catch(function () {});
      } catch (e) {}
    });
  }

  /* ---------------- app-side SL / trail mirror (non-super methods) ------- */
  /* Normal / Slice-Iceberg / Forever orders are ENTRY-ONLY on Dhan, so the app
     runs their full SL / trailing-SL / trailing-TP / fixed-TP lifecycle (see
     RealtimeTrail + the realtime executor's managePositions). This panel mirrors
     the live level the app will cut at, exactly like the super-order mirror
     above, so the operator can watch both protection paths in one place. */
  function appTrailHost() {
    var trades = el('ptRunTrades');
    if (!trades || !trades.parentNode) return null;
    var h = document.getElementById('rtAppTrail_realtime');
    if (!h) {
      h = document.createElement('div');
      h.id = 'rtAppTrail_realtime';
      h.style.cssText = 'margin-top:8px';
      trades.parentNode.insertBefore(h, trades.nextSibling);
    }
    return h;
  }
  function pctFrom(entry, px) {
    entry = Number(entry); px = Number(px);
    if (!(entry > 0) || !isFinite(px)) return null;
    return Math.abs(entry - px) / entry * 100;
  }

  function renderAppTrail() {
    var host = appTrailHost();
    if (!host) return;
    var exec = realtimeExec();
    var all = (exec && exec.getState) ? (exec.getState().autoPositions || {}) : {};
    var keys = Object.keys(all).filter(function (k) {
      var p = all[k];
      return p && p.brokerTrail !== true;
    });
    if (!keys.length) { host.innerHTML = ''; return; }
    var rows = keys.map(function (k) {
      var p = all[k];
      var col = p.side === 'SELL' ? '#ef5350' : '#00d4aa';
      var sl = (p.stopLoss != null && p.stopLoss > 0) ? p.stopLoss : null;
      var tp = (p.targetPrice != null && p.targetPrice > 0) ? p.targetPrice : null;
      var st = p.slTrailed ? 'TRAILING' : (sl || tp ? 'ACTIVE' : 'ENTRY');
      var stcol = p.slTrailed ? '#ffd700' : (sl || tp ? '#00d4aa' : '#888');
      return '<tr data-key="' + esc(k) + '">' +
        '<td><b>' + esc(p.symbol) + '</b><br><span style="font-size:8px;color:#666">' + esc(p.method || 'normal') + '</span></td>' +
        '<td style="color:' + col + '">' + esc(p.side) + '</td>' +
        '<td>' + fmt2(p.entryPrice) + '</td>' +
        '<td>' + (sl != null ? fmt2(sl) : '--') + '</td>' +
        '<td>' + pctTxt(pctFrom(p.entryPrice, sl)) + '</td>' +
        '<td>' + (tp != null ? fmt2(tp) : '--') + '</td>' +
        '<td style="color:' + stcol + '">' + esc(st) + '</td>' +
        '</tr>';
    }).join('');
    host.innerHTML = '<div style="font-size:9px;color:#ffd700;font-weight:700;margin:2px 0">App-managed SL / Trail (non-super methods, app-side)</div>'
      + '<table class="account-table"><thead><tr><th>Symbol</th><th>Side</th><th>Entry</th><th>App SL</th><th>SL %</th><th>Target</th><th>State</th></tr></thead><tbody>'
      + rows + '</tbody></table>';
  }

  /* ---------------- actions ---------------- */
  function closeAllTrades() {
    var exec = realtimeExec();
    if (!window.RealtimeBroker) {
      alert('RealtimeBroker load nahi hua - real positions close karne ke liye static/realtimebroker.js chahiye.');
      return;
    }
    if (!RealtimeBroker.isArmed()) { alert('Pehle ARM LIVE dabao, tabhi exit orders Dhan par jaayenge.'); return; }
    if (!RealtimeBroker.engineActive()) { alert('Engine OFF hai - pehle AI Smart Trading ko ON karo, tab exit orders jaayenge.'); return; }
    var keys = exec && exec.getState ? Object.keys(exec.getState().autoPositions || {}) : [];
    if (!keys.length) { alert('Realtime engine me koi open tracked position nahi hai.'); return; }
    if (!confirm('Close all ' + keys.length + ' realtime position(s)? This sends real exit orders to Dhan.')) return;
    keys.forEach(function (k) { try { exec.autoExit(k); } catch (e) {} });
    renderStrategies(); renderTrades();
  }
  function closeAllStrategies() {
    var eng = astEngine();
    if (!eng) return;
    if (!confirm('Stop all running strategies in the Realtime engine?')) return;
    try { if (eng.stopAll) eng.stopAll(); } catch (e) {}
    try { if (eng.stopAllStrategies) eng.stopAllStrategies(); } catch (e) {}
    if (window.RealtimeBroker) RealtimeBroker.disarm();
    renderStrategies();
  }

  function isActive() {
    var t = document.getElementById('tab-realtime');
    return !!(t && t.classList.contains('active'));
  }
  function tick() {
    if (!isActive()) return;
    renderStrategies();
    renderTrades();
    renderBrokerTrail();
    renderAppTrail();
    if (window.RealtimeOrders && RealtimeOrders.sync) RealtimeOrders.sync();
  }
  function start() { if (_timer) return; _timer = setInterval(tick, REFRESH_MS); }
  function stop() { if (_timer) { clearInterval(_timer); _timer = null; } }

  window.RealtimeRun = {
    onShow: function () {
      renderStrategies(); renderTrades(); renderBrokerTrail(); renderAppTrail(); start();
      if (window.RealtimeOrders && RealtimeOrders.sync) RealtimeOrders.sync();
    },
    onHide: stop,
    render: tick,
    renderStrategies: renderStrategies,
    renderTrades: renderTrades,
    renderBrokerTrail: renderBrokerTrail,
    renderAppTrail: renderAppTrail,
    closeAllTrades: closeAllTrades,
    closeAllStrategies: closeAllStrategies
  };
})();
