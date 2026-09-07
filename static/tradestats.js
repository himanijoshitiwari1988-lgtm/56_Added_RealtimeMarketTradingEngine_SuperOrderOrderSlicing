/* Executed-Trades Report tab (Trade Stats).
   Aggregates every closed paper trade from ALL paper engines (AI Smart base,
   Pooled Runner, Smart NTrader and each duplicated Paper tab) plus the AI Smart
   mirror ledgers (richer: entry time + strategy name), de-duplicated so each
   executed trade is counted exactly once. Renders period count chips, a
   timeframe dropdown (1H/Today/Week/Month/6M/Year/All) driving the executed
   table + stats + equity/P&L charts, and a "most profitable time of day /
   weekday" analysis of the executed history. */
(function () {
  if (typeof window === 'undefined') return;

  var $id = function (id) { return document.getElementById(id); };
  var MAX_ROWS = 300;

  /* ---------------- formatting ---------------- */
  function num(n) {
    if (n === null || n === undefined || n === '') return null;
    var x = Number(n);
    return isNaN(x) ? null : x;
  }
  function fmt2(n) {
    var x = num(n);
    return x === null ? '--' : x.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtMoney(n) {
    var x = num(n);
    if (x === null) return '--';
    return (x < 0 ? '-₹' : '₹') + Math.abs(x).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtPct(n) {
    var x = num(n);
    return x === null ? '--' : x.toFixed(1) + '%';
  }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  /* All date/hour windows and labels are anchored to IST (Asia/Kolkata) — the
     market timezone this dashboard trades in — so "Today", weekly/monthly/yearly
     windows, day/hour buckets and the time columns always match the NSE trading
     day no matter what timezone the user's browser runs in. India has no DST, so
     the +5:30 shift is constant. */
  var IST_MS = 330 * 60000;
  var MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function istParts(ts) {
    var x = num(ts);
    if (x === null) return null;
    var d = new Date(x + IST_MS);
    if (isNaN(d)) return null;
    return {
      y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(),
      h: d.getUTCHours(), min: d.getUTCMinutes(), wd: d.getUTCDay()
    };
  }
  function istDayStart(ts) {
    var p = istParts(ts);
    return p ? Date.UTC(p.y, p.m, p.d) - IST_MS : 0;
  }
  function fmtClock(ts) {
    var p = istParts(ts);
    if (!p) return null;
    var ap = p.h < 12 ? 'AM' : 'PM', h12 = p.h % 12 === 0 ? 12 : p.h % 12;
    return pad2(h12) + ':' + pad2(p.min) + ' ' + ap;
  }
  function fmtDT(ts) {
    var p = istParts(ts);
    if (!p) return null;
    var ap = p.h < 12 ? 'AM' : 'PM', h12 = p.h % 12 === 0 ? 12 : p.h % 12;
    return pad2(p.d) + ' ' + MONS[p.m] + ' ' + pad2(h12) + ':' + pad2(p.min) + ' ' + ap;
  }
  function dayKey(ts) {
    var p = istParts(ts);
    return p ? p.y + '-' + pad2(p.m + 1) + '-' + pad2(p.d) : '?';
  }
  function dayKeyLabel(k) {
    var p = String(k).split('-');
    if (p.length < 3) return k;
    return pad2(Number(p[2])) + ' ' + MONS[Number(p[1]) - 1];
  }
  function moneyColor(n) { return n >= 0 ? '#00d4aa' : '#ef5350'; }
  function pnlColor(n) { return n >= 0 ? 'green' : 'red'; }

  function engineFriendly(key) {
    if (key === 'papertrade') return 'AI Smart (base)';
    if (key === 'pool') return 'Pooled Runner';
    if (key === 'ntrader') return 'Smart NTrader';
    var pm = /^paper(\d+)$/.exec(key || '');
    if (pm) return 'Paper tab ' + pm[1];
    var am = /^ae(\d+)$/.exec(key || '');
    if (am) return 'AE tab ' + am[1];
    return key || '?';
  }

  /* ---------------- data gathering ---------------- */
  function engineInstances() {
    var out = [];
    var seen = {};
    var add = function (set) {
      if (!set) return;
      Object.keys(set).forEach(function (k) {
        if (!seen[k]) { seen[k] = 1; out.push(k); }
      });
    };
    add(window.TabEngines && window.TabEngines.papertrade);
    add(window.TabEngines && window.TabEngines.aismart);
    return out;
  }

  /* Effective net P&L of one recorded trade (net when charges were banked,
     else the gross P&L), matching how the engine reports its realized P&L. */
  function effNet(t) {
    if (t.netPnl !== null && t.netPnl !== undefined && !isNaN(Number(t.netPnl))) return Number(t.netPnl);
    return t.pnl !== null && t.pnl !== undefined && !isNaN(Number(t.pnl)) ? Number(t.pnl) : 0;
  }

  function norm(t, engineKey, src) {
    if (!t || t.at === null || t.at === undefined) return null;
    var out = {
      symbol: t.instrumentName || t.symbol || null,
      symbolId: t.symbolId != null ? t.symbolId : null,
      side: t.side, qty: num(t.qty), entry: num(t.entry), exit: num(t.exit),
      pnl: num(t.pnl), netPnl: num(t.netPnl), charges: num(t.charges),
      at: num(t.at), entryAt: num(t.entryAt),
      reason: t.reason || 'Closed',
      strategy: t.strategyName || null,
      lots: t.lots != null ? num(t.lots) : null,
      lotSize: t.lotSize != null ? num(t.lotSize) : null,
      engineKey: engineKey, src: src
    };
    if (out.symbol === null && out.symbolId === null) return null;
    return out;
  }

  function dupKey(n) {
    return [n.symbolId != null ? n.symbolId : ('s:' + n.symbol), n.side, n.qty, n.at].join('|');
  }

  /* Every executed trade across all engines, de-duplicated. AI Smart mirrors are
     read first (richer fields); the paper ledgers then fill anything the mirrors
     did not record (Pooled Runner / Smart NTrader / manual closes). */
  function collect() {
    var out = [];
    var seen = {};
    var add = function (t, engineKey, src) {
      var n = norm(t, engineKey, src);
      if (!n) return;
      var k = dupKey(n);
      if (seen[k]) return;
      seen[k] = 1;
      out.push(n);
    };
    var aism = (window.TabEngines && window.TabEngines.aismart) || {};
    Object.keys(aism).forEach(function (k) {
      try {
        var st = aism[k].getState ? aism[k].getState() : null;
        (st && Array.isArray(st.closed) ? st.closed : []).forEach(function (t) { add(t, k, 'ast'); });
      } catch (e) {}
    });
    var paps = (window.TabEngines && window.TabEngines.papertrade) || {};
    Object.keys(paps).forEach(function (k) {
      try {
        var st = paps[k].getState ? paps[k].getState() : null;
        (st && Array.isArray(st.closed) ? st.closed : []).forEach(function (t) { add(t, k, 'paper'); });
      } catch (e) {}
    });
    out.sort(function (a, b) { return a.at - b.at; });
    return out;
  }

  function filterByEngine(trades, engineKey) {
    if (!engineKey) return trades;
    return trades.filter(function (t) { return t.engineKey === engineKey; });
  }

  /* Mode split: trades recorded by the Indicator-filters run mode carry the
     synthetic "all-together" strategy name; everything else is a normal saved
     strategy. Used by the Mode dropdown and the strategy-wise table. */
  function isFilterTrade(t) {
    return t && /^indicator filter/i.test(String(t.strategy || ''));
  }
  function filterByMode(trades, mode) {
    if (mode === 'filter') return trades.filter(isFilterTrade);
    if (mode === 'strategy') return trades.filter(function (t) { return !isFilterTrade(t); });
    return trades;
  }
  function modeName(m) {
    return m === 'filter' ? 'Indicator-filter mode' : (m === 'strategy' ? 'Strategy mode' : 'All modes');
  }

  /* Rolling / calendar windows for the period dropdown. */
  var PERIODS = ['1h', 'today', 'week', 'month', '6m', 'year', 'all'];
  function periodMeta(pr) {
    var now = Date.now();
    var ps = istParts(now);
    var from = 0, to = Infinity, label = '';
    switch (pr) {
      case '1h': from = now - 3600000; label = 'Last 1 hour'; break;
      case 'today': from = istDayStart(now); label = 'Today'; break;
      case 'week': {
        var dow = (ps.wd + 6) % 7; /* IST Monday = 0 */
        from = istDayStart(now) - dow * 86400000;
        label = 'This week';
        break;
      }
      case 'month': from = Date.UTC(ps.y, ps.m, 1) - IST_MS; label = 'This month'; break;
      case '6m': {
        var mo = ps.m - 6, yy = ps.y;
        if (mo < 0) { mo += 12; yy -= 1; }
        from = Date.UTC(yy, mo, 1) - IST_MS;
        label = 'Last 6 months';
        break;
      }
      case 'year': from = Date.UTC(ps.y, 0, 1) - IST_MS; label = 'This year'; break;
      default: from = 0; to = Infinity; label = 'All time'; break;
    }
    return { from: from, to: to, label: label };
  }
  function inRange(t, meta) {
    return t.at >= meta.from && t.at <= meta.to;
  }

  /* ---------------- statistics ---------------- */
  function statsOf(trades) {
    var s = { n: 0, wins: 0, losses: 0, net: 0, charges: 0,
      grossProfit: 0, grossLoss: 0, avgWin: null, avgLoss: null,
      best: null, worst: null, profitFactor: null, maxDD: 0, maxDDPct: 0,
      streak: 0, maxStreak: 0, maxLoseStreak: 0, equity: [] };
    var peak = 0, streak = 0, loseStreak = 0;
    for (var i = 0; i < trades.length; i++) {
      var t = trades[i];
      var net = effNet(t);
      var charges = t.charges != null ? t.charges : 0;
      s.n++;
      s.charges += charges;
      s.net += net;
      s.equity.push({ at: t.at, y: s.net });
      if (net > 0) {
        s.wins++;
        s.grossProfit += net;
        streak++; loseStreak = 0;
        if (streak > s.maxStreak) s.maxStreak = streak;
        if (s.best === null || net > s.best) s.best = net;
      } else {
        s.losses++;
        s.grossLoss += Math.abs(net);
        loseStreak++; streak = 0;
        if (loseStreak > s.maxLoseStreak) s.maxLoseStreak = loseStreak;
        if (s.worst === null || net < s.worst) s.worst = net;
      }
      if (s.equity[i].y > peak) peak = s.equity[i].y;
      var dd = peak - s.equity[i].y;
      if (dd > s.maxDD) {
        s.maxDD = dd;
        if (peak > 0) s.maxDDPct = (dd / peak) * 100;
      }
    }
    if (s.wins) s.avgWin = s.grossProfit / s.wins;
    if (s.losses) s.avgLoss = s.grossLoss / s.losses;
    if (s.grossLoss > 0) s.profitFactor = s.grossProfit / s.grossLoss;
    else if (s.grossProfit > 0) s.profitFactor = Infinity;
    else s.profitFactor = 0;
    return s;
  }

  /* ---------------- UI state ---------------- */
  var _all = [];
  var _rangeSel = 'all';
  var _engineSel = '';
  var _modeSel = '';
  var _visible = false;

  function card(label, value, color, title) {
    return '<div class="acard" style="flex:1;min-width:96px" title="' + esc(title || label) + '">' +
      '<div class="label">' + esc(label) + '</div>' +
      '<div class="value" style="font-size:15px;color:' + (color || '#fff') + '">' + value + '</div></div>';
  }

  /* ---------------- render: engine select + chips + range controls ---------------- */
  function renderEngineSelect() {
    var el = $id('tsEngine');
    if (!el) return;
    var keys = engineInstances();
    var cur = _engineSel;
    var html = '<option value="">All engines (' + keys.length + ')</option>';
    keys.forEach(function (k) {
      html += '<option value="' + esc(k) + '">' + esc(engineFriendly(k)) + '</option>';
    });
    el.innerHTML = html;
    el.value = cur !== '' && keys.indexOf(cur) >= 0 ? cur : '';
    _engineSel = el.value;
  }

  function renderChips(trades) {
    var host = $id('tsChips');
    if (!host) return;
    var chips = [['1h', '1 hour'], ['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['6m', '6 months'], ['year', 'This year']];
    var html = '<span style="font-size:10px;color:#888;margin-right:2px">Total executed trades</span>';
    chips.forEach(function (c) {
      var meta = periodMeta(c[0]);
      var list = trades.filter(function (t) { return inRange(t, meta); });
      var st = statsOf(list);
      var col = st.net >= 0 ? '#00d4aa' : '#ef5350';
      html += '<button class="ts-chip" onclick="TradeStats.gotoPeriod(\'' + c[0] + '\')" title="Click to view this period in detail below">' +
        '<span style="color:#888">' + c[1] + '</span> &nbsp;<b>' + st.n + '</b>' +
        '<span style="color:' + col + '"> &nbsp;' + (st.net >= 0 ? '+' : '-') + fmtMoney(Math.abs(st.net)) + '</span></button>';
    });
    host.innerHTML = html;
  }

  function renderStats(st, label) {
    var host = $id('tsStats');
    if (!host) return;
    if (!st.n) {
      host.innerHTML = '<div style="font-size:10px;color:#666;padding:6px 2px">No executed trades in <b>' + esc(label) + '</b>.</div>';
      return;
    }
    var wr = st.n ? (st.wins / st.n) * 100 : 0;
    var netCol = moneyColor(st.net);
    var pf = st.profitFactor === Infinity ? '∞' : (st.profitFactor === null ? '--' : fmt2(st.profitFactor));
    var ddPct = st.maxDDPct > 0 ? ' (' + fmtPct(st.maxDDPct) + ')' : '';
    host.innerHTML =
      card('Trades (W/L)', st.n + ' <span style="font-size:10px;color:#666">(' + st.wins + 'W / ' + st.losses + 'L)</span>', '#fff') +
      card('Win rate', fmtPct(wr), wr >= 50 ? '#00d4aa' : (wr > 0 ? '#ffd700' : '#ef5350')) +
      card('Net P&L', (st.net >= 0 ? '+' : '-') + fmtMoney(Math.abs(st.net)), netCol) +
      card('Profit factor', pf, st.profitFactor !== null && st.profitFactor >= 1 ? '#00d4aa' : '#ef5350') +
      card('Avg trade', (st.n ? ((st.net >= 0 ? '+' : '-') + fmtMoney(Math.abs(st.net / st.n))) : '--'), netCol) +
      card('Avg win / loss', (st.avgWin !== null ? '+' + fmtMoney(st.avgWin) : '--') + ' / ' + (st.avgLoss !== null ? '-' + fmtMoney(st.avgLoss) : '--'), '#fff') +
      card('Best / Worst', (st.best !== null ? '+' + fmtMoney(st.best) : '--') + ' / ' + (st.worst !== null ? fmtMoney(st.worst) : '--'), '#fff') +
      card('Charges', '-' + fmtMoney(st.charges), '#ff9800') +
      card('Max drawdown', '-' + fmtMoney(st.maxDD) + ddPct, '#ef5350') +
      card('Best streak', st.maxStreak + 'W / ' + st.maxLoseStreak + 'L', '#fff');
  }

  /* ---------------- strategy-wise breakdown ---------------- */
  function renderStrategy(trades, st) {
    var body = $id('tsStrategyBody');
    var note = $id('tsStrategyNote');
    if (!body) return;
    if (!trades.length) {
      body.innerHTML = '<tr><td colspan="8" style="color:#666;font-size:10px;padding:8px">No executed trades in the selected period to break down.</td></tr>';
      if (note) note.textContent = '';
      return;
    }
    var map = {};
    trades.forEach(function (t) {
      var name = t.strategy || 'Strategy';
      var b = map[name] || (map[name] = { name: name, count: 0, wins: 0, losses: 0, net: 0, charges: 0, last: 0 });
      var net = effNet(t);
      b.count++;
      b.net += net;
      b.charges += (t.charges || 0);
      if (net > 0) b.wins++; else b.losses++;
      if (!b.last || t.at > b.last) b.last = t.at;
    });
    var names = Object.keys(map).sort(function (a, b) {
      var x = map[a], y = map[b];
      return (y.count - x.count) || (y.net - x.net);
    });
    var totalNet = names.reduce(function (s, n) { return s + map[n].net; }, 0);
    var rows = names.map(function (name) {
      var b = map[name];
      var wr = b.count ? (b.wins / b.count) * 100 : 0;
      var filterRow = isFilterTrade({ strategy: name });
      var contrib = totalNet !== 0 ? (b.net / totalNet) * 100 : 0;
      return '<tr' + (filterRow ? ' style="background:#0f2f28"' : '') + '>' +
        '<td>' + (filterRow ? '<span style="color:#00d4aa">&#9830;</span> ' : '') +
          '<b style="color:#d0d0d0">' + esc(name) + '</b>' +
          (filterRow ? '<br><span style="font-size:8px;color:#666">indicator-filter run mode</span>' : '') + '</td>' +
        '<td>' + b.count + ' <span style="font-size:10px;color:#666">(' + b.wins + 'W / ' + b.losses + 'L)</span></td>' +
        '<td>' + fmtPct(wr) + '</td>' +
        '<td class="' + pnlColor(b.net) + '">' + (b.net >= 0 ? '+' : '-') + fmtMoney(Math.abs(b.net)) + '</td>' +
        '<td class="' + pnlColor(b.net) + '">' + (b.net >= 0 ? '+' : '-') + fmtMoney(Math.abs(b.net / b.count)) + '</td>' +
        '<td style="color:#888">-' + fmtMoney(b.charges) + '</td>' +
        '<td class="' + pnlColor(contrib) + '">' + (contrib >= 0 ? '+' : '') + fmtPct(contrib) + '</td>' +
        '<td style="color:#888">' + fmtDT(b.last) + '</td>' +
        '</tr>';
    }).join('');
    body.innerHTML = rows;
    if (note) note.textContent = names.length + ' strateg' + (names.length === 1 ? 'y' : 'ies') +
      ' · net ' + (totalNet >= 0 ? '+' : '-') + fmtMoney(Math.abs(totalNet));
  }

  /* ---------------- charts ---------------- */
  var _charts = {};
  var hasChartLib = function () { return typeof Chart !== 'undefined'; };

  function drawChart(canvasId, cfg) {
    var c = $id(canvasId);
    if (!c) return;
    if (_charts[canvasId]) { try { _charts[canvasId].destroy(); } catch (e) {} _charts[canvasId] = null; }
    var empty = $id(canvasId + 'Empty');
    var showEmpty = function (msg) {
      if (empty) { empty.textContent = msg; empty.style.display = 'flex'; }
    };
    if (!cfg || !cfg.data || !cfg.data.labels || !cfg.data.labels.length) {
      showEmpty((cfg && cfg.emptyText) || 'No data yet');
      return;
    }
    if (!hasChartLib()) { showEmpty('Chart library not loaded'); return; }
    if (empty) empty.style.display = 'none';
    var base = {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false, backgroundColor: '#0a0a18', borderColor: '#3d3d7e', borderWidth: 1, titleColor: '#d0d0d0', bodyColor: '#d0d0d0' } },
      scales: {
        x: { ticks: { color: '#8a8ab0', maxRotation: 0, autoSkip: true, maxTicksLimit: 12, font: { size: 9 } }, grid: { color: 'rgba(60,60,110,0.25)' } },
        y: { ticks: { color: '#8a8ab0', font: { size: 9 } }, grid: { color: 'rgba(60,60,110,0.25)' } }
      }
    };
    var co = cfg.options || {};
    var conf = {
      type: cfg.type,
      data: cfg.data,
      options: {
        plugins: Object.assign({}, base.plugins, co.plugins || {}),
        scales: Object.assign({}, base.scales, co.scales || {})
      },
      responsive: base.responsive,
      maintainAspectRatio: base.maintainAspectRatio
    };
    try { _charts[canvasId] = new Chart(c.getContext('2d'), conf); } catch (e) {
      showEmpty('Chart error: ' + e.message);
    }
  }

  function drawEquity(trades) {
    if (!trades.length) { drawChart('tsEquity', null); return; }
    var pts = [];
    var step = Math.max(1, Math.floor(trades.length / 400));
    var cum = 0;
    for (var i = 0; i < trades.length; i++) {
      cum += effNet(trades[i]);
      if (i % step === 0 || i === trades.length - 1) pts.push({ at: trades[i].at, y: cum });
    }
    drawChart('tsEquity', {
      type: 'line',
      data: {
        labels: pts.map(function (p) { return fmtDT(p.at); }),
        datasets: [{ data: pts.map(function (p) { return p.y; }), borderColor: '#00d4aa', backgroundColor: 'rgba(0,212,170,0.12)', fill: true, tension: 0.15, borderWidth: 1.5, pointRadius: 0 }]
      },
      emptyText: 'Not enough data yet'
    });
  }

  function drawDist(trades) {
    if (!trades.length) { drawChart('tsDist', null); return; }
    var days = {};
    trades.forEach(function (t) { days[dayKey(t.at)] = 1; });
    var labels, values, colors;
    var byDay = Object.keys(days).length > 1;
    if (byDay) {
      var map = {};
      trades.forEach(function (t) { var k = dayKey(t.at); map[k] = (map[k] || 0) + effNet(t); });
      var keys = Object.keys(map).sort();
      labels = keys.map(function (k) { return dayKeyLabel(k); });
      values = keys.map(function (k) { return Math.round(map[k] * 100) / 100; });
      colors = values.map(function (v) { return v >= 0 ? 'rgba(0,212,170,0.75)' : 'rgba(239,83,80,0.75)'; });
    } else if (trades.length > 20) {
      var hourMap = {};
      trades.forEach(function (t) {
        var p = istParts(t.at);
        if (!p) return;
        hourMap[p.h] = (hourMap[p.h] || 0) + effNet(t);
      });
      var hk = Object.keys(hourMap).map(Number).sort(function (a, b) { return a - b; });
      labels = hk.map(function (h) { return pad2(h) + ':00'; });
      values = hk.map(function (h) { return Math.round(hourMap[h] * 100) / 100; });
      colors = values.map(function (v) { return v >= 0 ? 'rgba(0,212,170,0.75)' : 'rgba(239,83,80,0.75)'; });
    } else {
      labels = trades.map(function (t) { return fmtClock(t.at); });
      values = trades.map(function (t) { return Math.round(effNet(t) * 100) / 100; });
      colors = values.map(function (v) { return v >= 0 ? 'rgba(0,212,170,0.75)' : 'rgba(239,83,80,0.75)'; });
    }
    drawChart('tsDist', {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{ data: values, backgroundColor: colors, borderColor: colors, borderWidth: 1 }]
      },
      options: { plugins: { legend: { display: false } } },
      emptyText: 'Not enough data yet'
    });
  }

  /* ---------------- executed trades table ---------------- */
  function renderTable(trades, label) {
    var body = $id('tsBody');
    if (!body) return;
    var status = $id('tsStatus');
    if (!trades.length) {
      body.innerHTML = '<tr><td colspan="7" style="color:#666;font-size:10px;padding:8px">No executed trades in <b>' + esc(label) + '</b> yet.</td></tr>';
      return;
    }
    var rows = [];
    var i = 0;
    for (var idx = trades.length - 1; idx >= 0; idx--) {
      var t = trades[idx];
      var net = effNet(t);
      var qtyTxt = (t.lotSize && t.qty)
        ? t.qty + ' <span style="font-size:8px;color:#666">(' + (t.lots || Math.round(t.qty / t.lotSize)) + '×' + t.lotSize + ')</span>'
        : t.qty;
      var sideCol = t.side === 'BUY' ? '#00d4aa' : '#ef5350';
      var et = fmtClock(t.entryAt);
      var ct = fmtClock(t.at);
      rows.push('<tr>' +
        '<td><span style="color:#fff">' + esc(t.symbol) + '</span><br><span style="font-size:8px;color:#666">' +
          esc(engineFriendly(t.engineKey)) + (t.strategy ? ' · ' + esc(t.strategy) : '') +
          ' · <span style="color:' + sideCol + '">' + (t.side === 'BUY' ? 'LONG' : 'SHORT') + '</span></span></td>' +
        '<td>' + qtyTxt + '</td>' +
        '<td>' + fmt2(t.entry) + ' → ' + fmt2(t.exit) + '</td>' +
        '<td class="' + pnlColor(net) + '">' + (net >= 0 ? '+' : '-') + fmtMoney(Math.abs(net)) + '</td>' +
        '<td style="color:#888">' + (t.charges ? fmtMoney(t.charges) : '--') + '</td>' +
        '<td style="color:#ff9800">' + esc(t.reason) + '</td>' +
        '<td style="color:#888">' + (et ? et + ' → ' : '-- → ') + ct + '</td>' +
        '</tr>');
      i++;
      if (i >= MAX_ROWS) break;
    }
    var more = trades.length - i;
    body.innerHTML = rows.join('') +
      (more > 0 ? '<tr><td colspan="7" style="color:#666;font-size:9px;padding:6px">+ ' + more + ' older trade' + (more === 1 ? '' : 's') + ' not shown (newest ' + MAX_ROWS + ' listed)</td></tr>' : '');
    if (status) status.textContent = trades.length + ' executed trade' + (trades.length === 1 ? '' : 's') + ' in this period';
  }

  /* ---------------- time-of-day / weekday insights ---------------- */
  function insightScopeTrades(trades) {
    var scope = $id('tsInsightScope');
    var v = scope ? scope.value : 'all';
    var now = Date.now();
    if (v === 'today') return trades.filter(function (t) { return t.at >= istDayStart(now); });
    if (v === '7d') return trades.filter(function (t) { return t.at >= now - 7 * 86400000; });
    if (v === '30d') return trades.filter(function (t) { return t.at >= now - 30 * 86400000; });
    return trades;
  }

  function bucketBy(fn) {
    var m = {};
    var list = filterByMode(
      insightScopeTrades(_all).filter(function (t) { return t.engineKey === _engineSel || !_engineSel; }),
      _modeSel
    );
    if (!list.length) return { map: {}, total: 0 };
    list.forEach(function (t) {
      var k = fn(t);
      if (k === null || k === undefined) return;
      var net = effNet(t);
      var b = m[k] || (m[k] = { count: 0, wins: 0, losses: 0, net: 0, charges: 0 });
      b.count++;
      b.net += net;
      b.charges += (t.charges || 0);
      if (net > 0) b.wins++; else b.losses++;
    });
    return { map: m, total: list.length };
  }

  function hourKeysOf(res) {
    return Object.keys(res.map).map(Number).sort(function (a, b) { return a - b; });
  }

  function renderHourInsight() {
    var cardHost = $id('tsInsightBest');
    var wrapHost = $id('tsHourTable');
    if (!cardHost || !wrapHost) return;
    var res = bucketBy(function (t) {
      var ts = t.entryAt != null ? t.entryAt : t.at;
      var p = istParts(ts);
      return p ? p.h : null;
    });
    if (!res.total) {
      cardHost.innerHTML = '<div style="font-size:10px;color:#666">No trades yet to analyse.</div>';
      wrapHost.innerHTML = '';
      drawChart('tsHour', null);
      return;
    }
    var keys = hourKeysOf(res);
    if (!keys.length) {
      cardHost.innerHTML = '<div style="font-size:10px;color:#666">No timed trades yet to analyse.</div>';
      wrapHost.innerHTML = '';
      drawChart('tsHour', null);
      return;
    }
    var bestWinCount = null, bestWinKey = null;
    var bestNet = null, bestNetKey = null;
    var bestWr = null, bestWrKey = null;
    keys.forEach(function (k) {
      var b = res.map[k];
      if (bestWinCount === null || b.wins > bestWinCount) { bestWinCount = b.wins; bestWinKey = k; }
      if (bestNet === null || b.net > bestNet) { bestNet = b.net; bestNetKey = k; }
      var wr = b.count ? (b.wins / b.count) * 100 : 0;
      if (b.count >= 3 && (bestWr === null || wr > bestWr)) { bestWr = wr; bestWrKey = k; }
    });
    var hl = (bestWinKey !== null && res.map[bestWinKey] && res.map[bestWinKey].wins > 0) ? bestWinKey
      : (bestNetKey !== null && res.map[bestNetKey] && res.map[bestNetKey].net > 0 ? bestNetKey : null);
    var bw = hl !== null ? res.map[hl] : null;
    cardHost.innerHTML =
      (hl !== null && bw
        ? '<div style="font-size:10px;color:#888;margin-bottom:6px">Most profitable hour of the day: <b style="color:#00d4aa;font-size:14px">' +
          (hl < 10 ? '0' + hl : hl) + ':00 – ' + (hl < 10 ? '0' + hl : hl) + ':59</b> — ' +
          bw.wins + ' winning of ' + bw.count + ' trades · win rate ' + fmtPct(bw.count ? bw.wins / bw.count * 100 : 0) +
          ' · net ' + (bw.net >= 0 ? '+' : '-') + fmtMoney(Math.abs(bw.net)) + '</div>'
        : '<div style="font-size:10px;color:#666;margin-bottom:6px">No profitable hour found yet.</div>') +
      (bestNetKey !== null
        ? '<div style="font-size:9px;color:#888">Best by net P&L: <b style="color:#ffd700">' + (bestNetKey < 10 ? '0' + bestNetKey : bestNetKey) + ':00</b> (' + fmtMoney(res.map[bestNetKey].net) + ') · ' +
          'Highest win rate: <b style="color:#ffd700">' + (bestWrKey !== null ? (bestWrKey < 10 ? '0' + bestWrKey : bestWrKey) + ':00' : '—') + '</b> (' + (bestWr !== null ? fmtPct(bestWr) : '—') + ')</div>'
        : '');
    var rows = keys.map(function (k) {
      var b = res.map[k];
      var wr = b.count ? (b.wins / b.count) * 100 : 0;
      var isBest = hl === k;
      return '<tr' + (isBest ? ' style="background:#0f2f28;border:1px solid #00d4aa"' : '') + '>' +
        '<td><b style="color:' + (isBest ? '#00d4aa' : '#d0d0d0') + '">' + (k < 10 ? '0' + k : k) + ':00</b>' + (isBest ? ' ★' : '') + '</td>' +
        '<td>' + b.count + '</td>' +
        '<td style="color:#00d4aa">' + b.wins + '</td>' +
        '<td style="color:#ef5350">' + b.losses + '</td>' +
        '<td>' + fmtPct(wr) + '</td>' +
        '<td class="' + pnlColor(b.net) + '">' + (b.net >= 0 ? '+' : '-') + fmtMoney(Math.abs(b.net)) + '</td>' +
        '<td style="color:#888">' + fmtMoney(b.net / b.count) + '</td>' +
        '</tr>';
    }).join('');
    wrapHost.innerHTML = '<table class="ts-table"><thead><tr><th>Hour</th><th>Trades</th><th>Wins</th><th>Losses</th><th>Win rate</th><th>Net P&L</th><th>Avg trade</th></tr></thead><tbody>' + rows + '</tbody></table>';
    drawChart('tsHour', {
      type: 'bar',
      data: {
        labels: keys.map(function (k) { return (k < 10 ? '0' + k : k) + ':00'; }),
        datasets: [{ data: keys.map(function (k) { return Math.round(res.map[k].net * 100) / 100; }),
          backgroundColor: keys.map(function (k) { return k === hl ? 'rgba(0,212,170,0.95)' : (res.map[k].net >= 0 ? 'rgba(0,212,170,0.6)' : 'rgba(239,83,80,0.6)'); }) }]
      },
      emptyText: 'No data'
    });
    var scopeEl = $id('tsInsightScope');
    var scopeNote = $id('tsInsightScopeNote');
    if (scopeEl) {
      var sc = scopeEl.value;
      var scTxt = sc === 'all' ? 'All history' : sc === '30d' ? 'Last 30 days' : sc === '7d' ? 'Last 7 days' : 'Today';
      if (scopeNote) scopeNote.textContent = ' — ' + scTxt + (res.total ? ' · ' + res.total + ' trades' : '');
    }
  }

  function renderWeekdayInsight() {
    var wrapHost = $id('tsWeekTable');
    if (!wrapHost) return;
    var names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var res = bucketBy(function (t) {
      var p = istParts(t.at);
      return p ? p.wd : null;
    });
    if (!res.total) {
      wrapHost.innerHTML = '';
      drawChart('tsWeek', null);
      return;
    }
    var order = [1, 2, 3, 4, 5, 6, 0]; /* Mon-first trading week */
    var rows = [];
    var labels = [], values = [], colors = [];
    order.forEach(function (wd) {
      if (!res.map[wd]) return;
      var b = res.map[wd];
      var wr = b.count ? (b.wins / b.count) * 100 : 0;
      labels.push(names[wd]);
      values.push(Math.round(b.net * 100) / 100);
      colors.push(b.net >= 0 ? 'rgba(0,212,170,0.6)' : 'rgba(239,83,80,0.6)');
      rows.push('<tr><td><b style="color:#d0d0d0">' + names[wd] + '</b></td><td>' + b.count + '</td>' +
        '<td style="color:#00d4aa">' + b.wins + '</td><td style="color:#ef5350">' + b.losses + '</td>' +
        '<td>' + fmtPct(wr) + '</td>' +
        '<td class="' + pnlColor(b.net) + '">' + (b.net >= 0 ? '+' : '-') + fmtMoney(Math.abs(b.net)) + '</td>' +
        '<td style="color:#888">' + fmtMoney(b.net / b.count) + '</td></tr>');
    });
    wrapHost.innerHTML = '<table class="ts-table"><thead><tr><th>Day</th><th>Trades</th><th>Wins</th><th>Losses</th><th>Win rate</th><th>Net P&L</th><th>Avg trade</th></tr></thead><tbody>' + rows.join('') + '</tbody></table>';
    drawChart('tsWeek', { type: 'bar', data: { labels: labels, datasets: [{ data: values, backgroundColor: colors }] }, emptyText: 'No data' });
  }

  /* ---------------- export ---------------- */
  function exportCsv() {
    var meta = periodMeta(_rangeSel);
    var list = filterByMode(
      _all.filter(function (t) { return (t.engineKey === _engineSel || !_engineSel) && inRange(t, meta); }),
      _modeSel
    );
    if (!list.length) { alert('No trades in the selected period to export.'); return; }
    var head = ['Option', 'Qty', 'Entry', 'Exit', 'Side', 'P&L (net)', 'Charges', 'Reason', 'Entry time', 'Exit time', 'Engine', 'Strategy'];
    var q = function (s) { return '"' + String(s === null || s === undefined ? '' : s).replace(/"/g, '""') + '"'; };
    var lines = [head.join(',')];
    list.forEach(function (t) {
      lines.push([q(t.symbol), t.qty, t.entry, t.exit, t.side,
        effNet(t) != null ? effNet(t).toFixed(2) : '', (t.charges || 0).toFixed(2), q(t.reason),
        t.entryAt != null ? fmtDT(t.entryAt) : '', fmtDT(t.at), q(engineFriendly(t.engineKey)), q(t.strategy || '')].join(','));
    });
    var blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'executed-trades-' + _rangeSel + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(a.href); }, 200);
  }

  /* ---------------- main render ---------------- */
  var _force = true;
  var _lastSig = null;
  function dataSig() {
    var parts = [];
    var add = function (reg) {
      if (!reg) return;
      Object.keys(reg).forEach(function (k) {
        try {
          var st = reg[k].getState ? reg[k].getState() : null;
          var cl = (st && Array.isArray(st.closed)) ? st.closed : [];
          var last = 0;
          if (cl.length) { var f = cl[0]; if (f && f.at != null) last = f.at; }
          parts.push(k + ':' + cl.length + ':' + last);
        } catch (e) {}
      });
    };
    add(window.TabEngines && window.TabEngines.aismart);
    add(window.TabEngines && window.TabEngines.papertrade);
    return parts.join('|');
  }

  function render() {
    try {
      var sig = dataSig();
      if (sig === _lastSig && !_force) return;
      _lastSig = sig;
      _force = false;
      _all = collect();
      renderEngineSelect();
      var modeEl = $id('tsMode');
      if (modeEl && modeEl.value) _modeSel = modeEl.value;
      var scoped = filterByMode(filterByEngine(_all, _engineSel), _modeSel);
      renderChips(scoped);
      var meta = periodMeta(_rangeSel);
      var rangeTrades = scoped.filter(function (t) { return inRange(t, meta); });
      var st = statsOf(rangeTrades);
      renderStats(st, meta.label);
      renderStrategy(rangeTrades, st);
      drawEquity(rangeTrades);
      drawDist(rangeTrades);
      renderTable(rangeTrades, meta.label);
      renderHourInsight();
      renderWeekdayInsight();
      var rl = $id('tsRangeLabel');
      if (rl) rl.textContent = 'Showing ' + meta.label + (st.n ? ' · ' + st.n + ' trades · net ' + (st.net >= 0 ? '+' : '-') + fmtMoney(Math.abs(st.net)) : '');
    } catch (e) {
      try { if (window.console && console.warn) console.warn('[TradeStats] render failed:', e); } catch (e2) {}
    }
  }

  function onShow() {
    _visible = true;
    _force = true;
    render();
  }
  function onHide() { _visible = false; }

  function gotoPeriod(pr) {
    var el = $id('tsRange');
    if (el) el.value = pr;
    _rangeSel = pr;
    _force = true;
    render();
  }

  /* ---------------- wiring ---------------- */
  function bind() {
    var rs = $id('tsRange');
    if (rs && !rs._bound) {
      rs._bound = true;
      rs.value = _rangeSel;
      rs.onchange = function () { _rangeSel = rs.value; _force = true; render(); };
    }
    var eng = $id('tsEngine');
    if (eng && !eng._bound) {
      eng._bound = true;
      eng.onchange = function () { _engineSel = eng.value; _force = true; render(); };
    }
    var mode = $id('tsMode');
    if (mode && !mode._bound) {
      mode._bound = true;
      mode.onchange = function () { _modeSel = mode.value; _force = true; render(); };
    }
    var scope = $id('tsInsightScope');
    if (scope && !scope._bound) {
      scope._bound = true;
      scope.onchange = function () { renderHourInsight(); renderWeekdayInsight(); };
    }
    var rf = $id('tsRefresh');
    if (rf && !rf._bound) {
      rf._bound = true;
      rf.onclick = function () { _force = true; render(); };
    }
    var ex = $id('tsExportCsv');
    if (ex && !ex._bound) {
      ex._bound = true;
      ex.onclick = function () { exportCsv(); };
    }
  }

  var api = {
    render: render,
    onShow: onShow,
    onHide: onHide,
    gotoPeriod: gotoPeriod,
    refresh: render
  };
  window.TradeStats = api;

  function tick() {
    var p = $id('tab-tradestats');
    var active = p && p.classList.contains('active');
    if (active !== _visible) {
      _visible = active;
      if (active) render();
    } else if (active) {
      render();
    }
  }

  /* Initial render once the engines are up (they are created by the inline
     TabEnginesInit at the end of the page). Polls while the tab is shown. */
  setTimeout(function () {
    bind();
    tick();
    setInterval(function () {
      bind();
      tick();
    }, 5000);
  }, 1200);
})();
