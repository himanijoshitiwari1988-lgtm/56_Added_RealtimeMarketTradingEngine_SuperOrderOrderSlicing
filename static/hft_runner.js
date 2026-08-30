/* ============================================================
   HFT STRATEGY RUNNER (per paper-trade tab)
   Runs a LIST of strategies per paper-trade tab (base + every cloned
   tab), all fed by the shared HftPool so data is fetched once and
   shared across every tab and every strategy.

   Symbols + every trade setting come ONLY from the assigned template
   (AI Smart Trading Engine saved template for the Strategy Container
   flow - its captured instrument pick set and lots/margin/TP/SL; paper
   template symbol otherwise). The runner NEVER falls back to the
   left-side paper engine / sidebar symbol list, so pooled strategies
   cannot leak the sidebar symbol or LTP.

   Each row can trade its strategy across MULTIPLE instruments (the AST
   template's symbol set). Each (row,symbol) owns an isolated paper
   position key so many strategies can trade the SAME symbol without
   colliding in the symbol-keyed autoPositions map.

   Each row shows LIVE realtime data: aggregate P&L across its
   instruments, and an expandable DETAILS section listing every
   instrument with its own P&L plus the row's executed-trade info
   (trades, W/L, win rate, realized P&L).

   Loop (single 2s timer, shared pool):
     1. Read every enabled row's strategy from the AE results by key.
     2. Pull candles via HftPool (single-flight, shared array reference).
     3. Evaluate the entry signal with the shared AE evaluator.
     4. On a NEW bar with a fresh signal, execute a BUY paper entry
        through the tab's own PaperTrade engine with a per-row posKey.
        TP/SL exits run through the paper engine's own machinery.
   ============================================================ */
(function () {
  if (window.HftRunner) return;

  var SAVE_KEY = 'algodhan_hft_jobs_v1';
  var TICK_MS = 2000;

  var jobs = {};
  var timer = null;
  var lastResultsLen = -1;

  function loadAll() {
    var o = {};
    try { o = JSON.parse(localStorage.getItem(SAVE_KEY) || '{}'); } catch (e) { o = {}; }
    return (o && typeof o === 'object') ? o : {};
  }

  function persist() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(jobs)); } catch (e) {}
  }

  function sfxFor(tab) {
    return tab === 'papertrade' ? '' : '_' + tab;
  }

  function el(tab, base) {
    return document.getElementById(base + sfxFor(tab));
  }

  function tabOf(node) {
    if (!node) return 'papertrade';
    var rowEl = node.closest ? node.closest('.hft-row') : null;
    if (rowEl && rowEl.dataset && rowEl.dataset.tab) return rowEl.dataset.tab;
    return 'papertrade';
  }

  function engineFor(tab) {
    /* The base paper tab's pooled strategies run on their OWN isolated paper
       engine ('pool'), never on the base engine that AI Smart Trading drives,
       so pooled posKeys can never collide with AI Smart positions. */
    var instKey = tab === 'papertrade' ? 'pool' : tab;
    if (!window.TabEngines || !window.TabEngines.papertrade || !window.TabEngines.papertrade[instKey]) {
      if (instKey === 'pool' && window.createPaperTrade) { try { window.createPaperTrade('_pool'); } catch (e) {} }
    }
    if (window.TabEngines && window.TabEngines.papertrade && window.TabEngines.papertrade[instKey]) {
      return window.TabEngines.papertrade[instKey];
    }
    return window.PaperTrade || null;
  }

  function aeEngine() {
    if (window.TabEngines && window.TabEngines.ae && window.TabEngines.ae.autoexperiment) return window.TabEngines.ae.autoexperiment;
    return window.AutoExperiment || null;
  }

  function aeResults() {
    var eng = aeEngine();
    if (!eng || !eng.getState) return [];
    var st = eng.getState();
    return (st && Array.isArray(st.results)) ? st.results : [];
  }

  function symbolList() {
    var list = [];
    var eng = aeEngine();
    if (eng && eng.getState) {
      var st = eng.getState();
      if (Array.isArray(st && st.symbols)) list = list.concat(st.symbols);
    }
    return list;
  }

  function resultsMap() {
    var m = {};
    aeResults().forEach(function (r) { if (r && r.key) m[r.key] = r; });
    return m;
  }

  function newRow(strategyKey, strategy) {
    return { id: Date.now() + '-' + Math.floor(Math.random() * 1e6), enabled: false, strategyKey: strategyKey || '', strategy: strategy || null, symbolName: '', symbolOverride: null, symbols: [], tf: '', lots: 1, margin: 0, tpPct: 0, slPct: 0, slTrailPct: 0, fnoLimit: true, firedBar: 0, firedBars: {}, tplName: '', astTpl: false };
  }

  /* A row's strategy definition: either an Auto Experiment result keyed from
     getState().results, or a full saved strategy object (e.g. from the Strategy
     Container) stored directly on the row. */
  function resolveStrategy(row, rmap) {
    if (row.strategy) return row.strategy;
    if (row.strategyKey && rmap) return rmap[row.strategyKey];
    return null;
  }

  /* ---- strategy picker ---- */
  function populateStrategySelect(tab) {
    var sel = el(tab, 'ptHftStrategy');
    if (!sel) return;
    var res = aeResults();
    var current = sel.value;
    var html = '<option value="">-- select a strategy --</option>';
    res.forEach(function (r) {
      var symName = (r.symbol && r.symbol.name) ? (' @ ' + r.symbol.name) : '';
      var label = String(r.name || r.key) + symName + (r.tf ? ' ' + r.tf : '');
      html += '<option value="' + r.key + '">' + label + '</option>';
    });
    sel.innerHTML = html;
    if (current) sel.value = current;
  }

  /* ---- row identity / symbols ---- */
  function rowKeyFor(tab, row) {
    return 'hft:' + tab + ':' + row.id;
  }

  function strategyKeyPart(row, r) {
    var k = (row.strategy && row.strategy.aeKey) || (r && r.aeKey) || '';
    return k ? ':' + k : '';
  }

  /* Instrument set for a row: resolved option instruments first (index symbols
     are converted to their selected-strike option contract at runtime so the
     pooled paper trade is placed on the realistic premium instrument), then the
     template symbols, then the template's single symbol, then the row/strategy's
     own symbol. NEVER falls back to the sidebar/paper-engine symbol list or
     selectedSymbol. */
  function resolveSymbols(row, r) {
    if (row._optSyms && Array.isArray(row._optSyms.symbols) && row._optSyms.symbols.length && (Date.now() - (row._optSyms.at || 0)) < 90000) {
      return row._optSyms.symbols;
    }
    if (Array.isArray(row.symbols) && row.symbols.length) return row.symbols;
    if (row.symbolOverride && row.symbolOverride.id != null) return [row.symbolOverride];
    if (row.symbolName) {
      var list = symbolList();
      var want = String(row.symbolName).toLowerCase();
      var hit = list.find(function (s) { return s && String(s.name || '').toLowerCase() === want; });
      if (hit) return [hit];
    }
    if (r && r.symbol) return [r.symbol];
    return [];
  }

  function posKeyFor(symbol, tab, row) {
    var base = (symbol.exch === 'IDX_I' ? 'IDX_I:' + symbol.id : String(symbol.id));
    return base + ':hft:' + tab + ':' + row.id;
  }

  /* ---- formatting ---- */
  function fmt(n, d) {
    return Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function fmtMoney(n) {
    return '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /* ---- per-row executed trade stats (from this row's closed trades) ---- */
  function rowClosedTrades(tab, row) {
    var eng = engineFor(tab);
    if (!eng || !eng.getState) return [];
    var base = rowKeyFor(tab, row);
    var prefix = base + ':';
    return ((eng.getState().closed) || []).filter(function (t) {
      return t && t.autoKey && (String(t.autoKey) === base || String(t.autoKey).indexOf(prefix) === 0);
    });
  }

  function rowStats(tab, row) {
    var trades = rowClosedTrades(tab, row);
    var wins = 0, losses = 0, realized = 0;
    trades.forEach(function (t) {
      var p = (t.netPnl != null ? t.netPnl : t.pnl) || 0;
      realized += p;
      if (p > 0) wins++; else if (p < 0) losses++;
    });
    return {
      trades: trades.length, wins: wins, losses: losses,
      winRate: trades.length ? (wins / trades.length) * 100 : null,
      realized: realized
    };
  }

  /* ---- row rendering ---- */
  function labelFor(r, symCount) {
    if (!r) return '(unknown strategy)';
    var base = String(r.name || r.key);
    if (symCount > 1) base += ' [' + symCount + ' instruments]';
    return base;
  }

  function renderRow(tab, row, idx, rmap) {
    var wrap = document.createElement('div');
    wrap.className = 'hft-row';
    wrap.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:4px 0;padding:5px;border:1px solid #23234a;border-radius:3px;background:#12122a';
    wrap.dataset.idx = String(idx);
    wrap.dataset.tab = tab;
    var r = resolveStrategy(row, rmap);
    var symCount = (Array.isArray(row.symbols) ? row.symbols.length : 0) || (row.symbolOverride ? 1 : 0);
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!row.enabled;
    cb.title = 'Enable this strategy';
    cb.onchange = function () { row.enabled = cb.checked; persist(); runStrategy(tab, row, cb); updateLive(tab, row); };
    wrap.appendChild(cb);

    var name = document.createElement('span');
    name.textContent = labelFor(r, symCount);
    name.title = 'Strategy ' + row.strategyKey + (row.tplName ? ' · template: ' + row.tplName : '');
    name.style.cssText = 'min-width:150px;font-size:10px;color:#9aa';
    wrap.appendChild(name);

    var live = document.createElement('span');
    live.className = 'hft-live';
    live.style.cssText = 'font-size:9px;color:#777';
    live.textContent = 'flat';
    wrap.appendChild(live);
    row._liveEl = live;

    var st = document.createElement('span');
    st.className = 'hft-status';
    st.style.cssText = 'font-size:9px;color:#888;margin-left:auto';
    wrap.appendChild(st);
    row._statusEl = st;

    var det = document.createElement('button');
    det.textContent = 'details';
    det.title = 'Show/hide instruments, lot size, P&L, win rate and executed trades';
    det.style.cssText = 'background:#23234a;color:#66ccff;border:1px solid #2d2d50;border-radius:3px;cursor:pointer;padding:2px 6px;font-size:9px';
    det.onclick = function () {
      if (row._detailsEl) row._detailsEl.style.display = (row._detailsEl.style.display === 'none' ? 'block' : 'none');
    };
    wrap.appendChild(det);

    var fin = document.createElement('button');
    fin.textContent = 'Final';
    fin.title = 'Save this pooled strategy to the Final Strategy section (with its win rate, avg/trade, SL / trail SL, timeframe and running settings)';
    fin.style.cssText = 'background:#ffd700;color:#0a0a18;border:none;border-radius:3px;cursor:pointer;padding:2px 6px;font-size:9px;font-weight:700';
    fin.onclick = function () { sendToFinal(tab, row); };
    wrap.appendChild(fin);

    var close = document.createElement('button');
    close.textContent = 'close';
    close.title = 'Square off this row\'s open positions';
    close.style.cssText = 'background:#333;color:#ffb74d;border:1px solid #555;border-radius:3px;cursor:pointer;padding:2px 6px;font-size:9px';
    close.onclick = function () { closePosition(close); };
    wrap.appendChild(close);

    var rm = document.createElement('button');
    rm.textContent = 'x';
    rm.title = 'Remove row';
    rm.style.cssText = 'background:#4a1f26;color:#ff8a80;border:1px solid #5c2730;border-radius:3px;cursor:pointer;padding:2px 6px;font-size:10px';
    rm.onclick = function () {
      if (jobs[tab]) jobs[tab].strategies.splice(idx, 1);
      persist();
      renderList(tab);
    };
    wrap.appendChild(rm);

    var detWrap = document.createElement('div');
    detWrap.className = 'hft-details';
    detWrap.style.cssText = 'flex-basis:100%;display:none;border-top:1px dashed #23234a;margin-top:4px;padding-top:3px;font-size:9px';
    detWrap.innerHTML = '';
    wrap.appendChild(detWrap);
    row._detailsEl = detWrap;

    return wrap;
  }

  function renderList(tab) {
    var listEl = el(tab, 'ptHftList');
    if (!listEl) return;
    listEl.innerHTML = '';
    var rows = (jobs[tab] && jobs[tab].strategies) || [];
    var rmap = resultsMap();
    rows.forEach(function (row, i) {
      listEl.appendChild(renderRow(tab, row, i, rmap));
    });
  }

  function statusElFor(rowEl) {
    return rowEl ? rowEl.querySelector('.hft-status') : null;
  }

  /* ---- live readout (aggregate across the row's instruments) ---- */
  function liveInfo(tab, row, rmap, syms) {
    var r = resolveStrategy(row, rmap);
    var symbols = resolveSymbols(row, r);
    if (!symbols.length) return null;
    var eng = engineFor(tab);
    if (!eng || !eng.getState) return null;
    var positions = eng.getState().autoPositions || {};
    var totalPnl = 0, openCount = 0, invested = 0;
    var per = symbols.map(function (symbol) {
      var pos = positions[posKeyFor(symbol, tab, row)];
      var q = HftPool.quote(symbol);
      var ltp = q ? q.ltp : null;
      var lotSize = (typeof eng.lotSizeFor === 'function') ? (Number(eng.lotSizeFor(symbol)) || 1) : 1;
      if (!pos) return { symbol: symbol, open: false, symName: symbol.name || String(symbol.id), ltp: ltp, lotSize: lotSize };
      var cur = ltp || pos.entryPrice;
      var pnl = (pos.side === 'SELL') ? (pos.entryPrice - cur) * pos.qty : (cur - pos.entryPrice) * pos.qty;
      var pnlPct = (pos.entryPrice && pos.qty) ? (pnl / (pos.entryPrice * pos.qty)) * 100 : 0;
      totalPnl += pnl;
      invested += pos.entryPrice * pos.qty;
      openCount++;
      return {
        symbol: symbol, open: true, side: pos.side, qty: pos.qty,
        symName: symbol.name || String(symbol.id), entry: pos.entryPrice, ltp: cur,
        pnl: pnl, pnlPct: pnlPct, lotSize: lotSize,
        tp: pos.targetPrice != null ? pos.targetPrice : 0,
        sl: pos.stopLoss != null ? pos.stopLoss : 0
      };
    });
    return {
      open: openCount > 0, openCount: openCount, totalPnl: totalPnl,
      totalPnlPct: invested ? (totalPnl / invested) * 100 : 0,
      per: per,
      names: symbols.map(function (s) { return s.name || String(s.id); }),
      lotSize: per[0] ? per[0].lotSize : 1,
      lots: row.lots || 1, margin: row.margin || 0,
      tpPct: row.tpPct || 0, slPct: row.slPct || 0, trailSlPct: row.slTrailPct || 0,
      tplName: row.tplName || ''
    };
  }

  function updateDetails(tab, row, info) {
    var detEl = row._detailsEl;
    if (!detEl) return;
    var stats = rowStats(tab, row);
    var html = '';
    info.per.forEach(function (p) {
      if (p.open) {
        var col = p.pnl >= 0 ? '#00d4aa' : '#ef5350';
        html += '<div style="font-size:9px;color:#9aa">' + p.symName + ' · <span style="color:' + col + '">' + (p.side === 'BUY' ? 'LONG' : 'SHORT') + '</span> ' + p.qty +
          ' · lot size ' + p.lotSize +
          ' · E ' + fmt(p.entry, 2) + ' · LTP ' + fmt(p.ltp, 2) +
          ' · <b style="color:' + col + '">' + (p.pnl >= 0 ? '+' : '') + fmtMoney(p.pnl) + ' (' + (p.pnlPct >= 0 ? '+' : '') + fmt(p.pnlPct, 2) + '%)</b>' +
          ' · TP ' + fmt(p.tp, 2) + ' SL ' + fmt(p.sl, 2) + '</div>';
      } else {
        html += '<div style="font-size:9px;color:#666">' + p.symName + ' · flat · lot size ' + p.lotSize + (p.ltp != null ? ' · LTP ' + fmt(p.ltp, 2) : '') + '</div>';
      }
    });
    var wrTxt = stats.winRate == null ? '--' : fmt(stats.winRate, 1) + '%';
    html += '<div style="font-size:9px;color:#b39ddb;border-top:1px solid #23234a;margin-top:2px;padding-top:2px">' +
      'Executed ' + stats.trades + ' · W/L ' + stats.wins + '/' + stats.losses +
      ' · Win rate ' + wrTxt +
      ' · Realized ' + (stats.realized >= 0 ? '+' : '') + fmtMoney(stats.realized) +
      (info.open ? ' · Open P&L ' + (info.totalPnl >= 0 ? '+' : '') + fmtMoney(info.totalPnl) : '') +
      '</div>';
    detEl.innerHTML = html;
  }

  function updateLive(tab, row, rmap, syms) {
    var liveEl = row._liveEl;
    if (!liveEl) return;
    var info = liveInfo(tab, row, rmap, syms);
    if (!info) {
      liveEl.textContent = 'no symbols (assigned via template)';
      liveEl.style.color = '#ef5350';
      if (row._detailsEl) row._detailsEl.innerHTML = '<div style="font-size:9px;color:#ef5350">No instrument set - the assigned template has no symbols.</div>';
      return;
    }
    if (!info.open) {
      liveEl.textContent = info.names.length + ' instruments · flat · ' +
        (info.tplName ? '[' + info.tplName + '] ' : '') + 'lots ' + info.lots +
        (info.lotSize ? ' · lot size ' + info.lotSize : '') +
        (info.margin ? ' · margin ' + fmtMoney(info.margin) : '') +
        ' · TP ' + info.tpPct + '% · SL ' + info.slPct + '%' +
        (info.trailSlPct > 0 ? ' (trail ' + info.trailSlPct + '%)' : '');
      liveEl.style.color = '#777';
    } else {
      var col = info.totalPnl >= 0 ? '#00d4aa' : '#ef5350';
      liveEl.style.color = col;
      var namePart = info.names.slice(0, 3).join(', ') + (info.names.length > 3 ? ' +' + (info.names.length - 3) : '');
      liveEl.innerHTML = '<span style="color:#9aa">' + info.openCount + '/' + info.per.length + ' active · ' + namePart + '</span> · ' +
        '<b>P&L ' + (info.totalPnl >= 0 ? '+' : '') + fmtMoney(info.totalPnl) +
        (info.totalPnlPct ? ' (' + (info.totalPnlPct >= 0 ? '+' : '') + fmt(info.totalPnlPct, 2) + '%)' : '') + '</b>';
    }
    updateDetails(tab, row, info);
  }

  async function runStrategy(tab, row, cb, rmap, syms) {
    if (!row.enabled) {
      if (cb) { var st0 = statusElFor(cb.parentElement); if (st0) st0.textContent = 'disabled'; }
      return;
    }
    rmap = rmap || resultsMap();
    syms = syms || symbolList();
    var r = resolveStrategy(row, rmap);
    var statusEl = cb ? statusElFor(cb.parentElement) : (row._statusEl || null);
    if (!r) {
      if (statusEl) { statusEl.textContent = 'strategy not found'; statusEl.style.color = '#ef5350'; }
      return;
    }
    var symbols = resolveSymbols(row, r);
    if (!symbols.length) {
      if (statusEl) { statusEl.textContent = 'no symbols from template'; statusEl.style.color = '#ef5350'; }
      return;
    }
    /* Index symbols are converted to their selected-strike option contract so
       the pooled paper trade executes on the realistic premium instrument
       (small notional that fits the template margin) - exactly like the AI
       Smart engine's own trade-in mode. Falls back to the spot symbol when no
       contract can be resolved (e.g. the option chain is rate-limited). */
    var effSymbols = symbols;
    if (window.AISmartTrading && typeof AISmartTrading.resolveOptionSymbols === 'function') {
      try {
        effSymbols = await AISmartTrading.resolveOptionSymbols(symbols);
      } catch (e) {}
    }
    if (!Array.isArray(effSymbols) || !effSymbols.length) effSymbols = symbols;
    row._optSyms = { symbols: effSymbols, at: Date.now() };

    var tf = row.tf || r.tf || '5min';
    var eng = engineFor(tab);
    var rowKey = rowKeyFor(tab, row) + strategyKeyPart(row, r);
    if (statusEl) { statusEl.textContent = effSymbols.length + ' instruments · ' + tf; statusEl.style.color = '#888'; }
    var origById = {};
    symbols.forEach(function (s0) { if (s0 && s0.id != null) origById[String(s0.id)] = s0; });
    function underlyingSpotFor(symbol) {
      if (!symbol || symbol.spotId == null) return null;
      var o = origById[String(symbol.spotId)];
      if (o) return o;
      return { id: Number(symbol.spotId), exch: symbol.spotExch || symbol.exch, inst: 'INDEX', name: symbol.name };
    }
    effSymbols.forEach(function (symbol) {
      var symKey = String(symbol.id) + ':' + (symbol.exch || '');
      /* Index symbol whose option chain could not be resolved (rate-limited /
         unavailable). The raw index notional can never fit the paper margin, so
         report the retry state instead of attempting an impossible entry -
         mirrors the AI Smart engine skipping a premium run-in when its chain is
         missing. */
      if (symbol._noChain) {
        var stNC = statusEl;
        if (stNC) { stNC.textContent = 'option chain unavailable - retrying'; stNC.style.color = '#ff9800'; }
        return;
      }
      /* Evaluate the entry signal on the given candle series and, when it fires,
         place the pooled paper BUY on the given execution symbol. execSymbol is
         the option contract normally, or the underlying spot symbol when the
         premium chart has no candles (fallback path). */
      function trySignal(candles, execSymbol, isFbk) {
        var st = statusEl;
        var lastTs = candles[candles.length - 1].time || 0;
        var signal = HftPool.evalEntry(r, candles);
        var q = HftPool.quote(execSymbol);
        var ltp = q ? q.ltp : null;
        var fired = row.firedBars ? row.firedBars[symKey] : 0;
        if (signal && lastTs !== (fired || 0)) {
          if (!eng || !eng.autoEntry) {
            if (st) { st.textContent = 'paper engine not ready'; st.style.color = '#ef5350'; }
            return;
          }
          /* Margin-aware quantity: the strategy may request N lots, but the
             pooled trade can never exceed the margin the template assigns. The
             engine itself re-checks against its live used-margin, so capping
             here just picks the largest whole lots that fit before the call. */
          var fillRef = ltp || (execSymbol.premium != null ? Number(execSymbol.premium) : 0);
          var lotSz = (eng.lotSizeFor) ? (Number(eng.lotSizeFor(execSymbol)) || 1) : 1;
          var marginAvail = (row.margin > 0) ? row.margin : ((eng && typeof eng.getTradeSettings === 'function' && eng.getTradeSettings()) ? (Number(eng.getTradeSettings().margin) || 0) : 0);
          var lotsN = Math.max(1, Math.round(Number(row.lots) || 1));
          if (fillRef > 0 && lotSz > 0 && marginAvail > 0) {
            var afford = Math.floor(marginAvail / (lotSz * fillRef));
            if (afford >= 1) lotsN = Math.min(lotsN, afford);
          }
          var opts = {
            key: rowKey,
            posKey: posKeyFor(execSymbol, tab, row),
            symbol: execSymbol,
            lots: lotsN,
            margin: marginAvail,
            tpPct: row.tpPct || 0,
            slPct: row.slPct || 0,
            slTrailPct: row.slTrailPct || 0,
            fnoLimit: row.fnoLimit !== false
          };
          if (eng.lotSizeFor) opts.lotSize = eng.lotSizeFor(execSymbol);
          if (execSymbol.premium != null) opts.fallbackLtp = execSymbol.premium;
          var ok = eng.autoEntry('BUY', opts);
          if (!row.firedBars) row.firedBars = {};
          row.firedBars[symKey] = lastTs;
          row.firedBar = lastTs;
          persist();
          if (st) {
            if (ok) { st.textContent = 'BUY ' + (execSymbol.name || execSymbol.id) + ' ' + tf + ' bar ' + lastTs + (isFbk ? ' [premium chart missing]' : ''); st.style.color = '#00d4aa'; }
            else { st.textContent = 'entry: ' + (eng.lastAutoSkip || 'rejected'); st.style.color = '#ef5350'; }
          }
        } else {
          if (st) {
            st.textContent = (signal ? 'signal ON ' + (execSymbol.name || execSymbol.id) + ' (bar ' + lastTs + ')' : 'waiting') + (ltp != null ? ' | LTP ' + ltp : '') + (isFbk ? ' [premium chart missing]' : '');
            st.style.color = signal ? '#00d4aa' : '#888';
          }
        }
      }
      HftPool.getCandles(symbol, tf).then(function (candles) {
        var st = statusEl;
        if (!candles || !candles.length) {
          /* Premium chart candles unavailable (new/illiquid strike, feed gap):
             fall back to the underlying spot chart so the strategy still
             evaluates its indicators and still trades instead of being
             skipped. The pooled trade executes on the underlying symbol. */
          var spot = underlyingSpotFor(symbol);
          if (spot && spot.id !== symbol.id) {
            return HftPool.getCandles(spot, tf).then(function (spotCandles) {
              if (!spotCandles || !spotCandles.length) {
                if (st) { st.textContent = 'no candle data for ' + (symbol.name || symbol.id) + ' - retrying'; st.style.color = '#ef5350'; }
                return;
              }
              trySignal(spotCandles, spot, true);
            });
          }
          if (st) { st.textContent = 'no candle data for ' + (symbol.name || symbol.id) + ' - retrying'; st.style.color = '#ef5350'; }
          return;
        }
        trySignal(candles, symbol, false);
      }).catch(function () {
        if (statusEl) { statusEl.textContent = 'fetch failed'; statusEl.style.color = '#ef5350'; }
      });
    });
  }

  async function runJob(tab) {
    var rows = (jobs[tab] && jobs[tab].strategies) || [];
    if (!rows.some(function (r) { return r.enabled; })) { renderPool(); return; }
    var rmap = resultsMap();
    var syms = symbolList();
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row.enabled) { try { await runStrategy(tab, row, null, rmap, syms); } catch (e) {} }
    }
    rows.forEach(function (row) { try { updateLive(tab, row, rmap, syms); } catch (e) {} });
    renderPool();
  }

  function renderPool() {
    var strip = document.getElementById('ptHftPool');
    if (!strip) return;
    var stats = HftPool.stats();
    var keys = Object.keys(stats);
    var rows = 0;
    keys.forEach(function (k) { rows += stats[k].bars; });
    var enabled = 0;
    Object.keys(jobs).forEach(function (t) {
      (jobs[t].strategies || []).forEach(function (r) { if (r.enabled) enabled++; });
    });
    strip.textContent = 'pool: ' + keys.length + ' series / ' + rows + ' bars | ' + enabled + ' strategies enabled' + ' | tick ' + TICK_MS + 'ms';
  }

  function tick() {
    var resLen = aeResults().length;
    if (resLen !== lastResultsLen) {
      lastResultsLen = resLen;
      Object.keys(jobs).forEach(populateStrategySelect);
    }
    Object.keys(jobs).forEach(runJob);
  }

  /* ---- public API ---- */
  /* Strategy-owned risk snapshot: the SL / trailing-SL the AE engine actually
     used when the strategy was designed/tested (refSlPct / autoSlPct for SL,
     refTrailSlPct for trailing SL). When present, these WIN over the assigned
     template's SL so the pooled runner behaves exactly like the AST engine's
     strategy-owned risk fix. Returns { sl, trailSl } with nulls when absent. */
  function ownRiskFor(strategy) {
    var sl = null;
    var trailSl = null;
    if (strategy) {
      if (strategy.refSlPct != null && Number(strategy.refSlPct) > 0) sl = Number(strategy.refSlPct);
      else if (strategy.autoSlPct != null && Number(strategy.autoSlPct) > 0) sl = Number(strategy.autoSlPct);
      if (strategy.refTrailSlPct != null && Number(strategy.refTrailSlPct) > 0) trailSl = Number(strategy.refTrailSlPct);
    }
    return { sl: sl, trailSl: trailSl };
  }
  function addStrategy(tab, strategyKey, strategy) {
    var row = newRow(strategyKey || '', strategy || null);
    var eng = engineFor(tab);
    if (eng && eng.getTradeSettings) {
      var s = eng.getTradeSettings();
      row.lots = s.lots || 1;
      row.margin = s.margin || 0;
      row.tpPct = s.tpPct || 0;
      row.slPct = s.slPct || 0;
      row.slTrailPct = s.slTrailPct || 0;
      row.fnoLimit = s.fnoLimit !== false;
      if (s.symbol && s.symbol.id != null) row.symbolOverride = s.symbol;
    }
    var own = ownRiskFor(strategy);
    if (own.sl != null) row.slPct = own.sl;
    if (own.trailSl != null) row.slTrailPct = own.trailSl;
    if (!jobs[tab]) jobs[tab] = { strategies: [] };
    jobs[tab].strategies.push(row);
    persist();
    renderList(tab);
    return row;
  }

  /* Add a row for a full saved strategy object (Strategy Container flow),
     preloaded with the chosen template's trade settings AND its instrument
     set (settings.symbols for AST templates / settings.symbol otherwise) -
     every trade detail (symbols, lots, margin, TP/trail, SL) comes from the
     assigned template, never the sidebar. */
  function addStrategyObject(tab, strategy, settings) {
    var row = newRow(null, strategy);
    if (settings) {
      row.lots = settings.lots || 1;
      row.margin = settings.margin || 0;
      row.tpPct = settings.tpPct || 0;
      row.slPct = settings.slPct || 0;
      row.fnoLimit = settings.fnoLimit !== false;
      if (Array.isArray(settings.symbols) && settings.symbols.length) {
        row.symbols = settings.symbols.slice();
        row.symbolOverride = row.symbols[0];
      } else if (settings.symbol && settings.symbol.id != null) {
        row.symbolOverride = settings.symbol;
        row.symbols = [settings.symbol];
      }
      if (settings.name) row.tplName = String(settings.name);
      row.astTpl = settings.source === 'ast';
    }
    /* Strategy-owned risk wins over the template's SL: an AST strategy carries
       the SL/trailing-SL the AE engine used (refSlPct/autoSlPct/refTrailSlPct)
       and the pooled runner applies those instead of the template's saved SL. */
    var own = ownRiskFor(strategy);
    if (own.sl != null) row.slPct = own.sl;
    if (own.trailSl != null) row.slTrailPct = own.trailSl;
    if (!jobs[tab]) jobs[tab] = { strategies: [] };
    jobs[tab].strategies.push(row);
    persist();
    renderList(tab);
    return row;
  }

  /* Append many strategy rows and render the list ONCE (the single-row add
     re-renders per row, which is quadratic for thousands of rows). */
  function bulkAddStrategies(tab, keys, noRender) {
    if (!jobs[tab]) jobs[tab] = { strategies: [] };
    (keys || []).forEach(function (k) { jobs[tab].strategies.push(newRow(k || '')); });
    persist();
    if (!noRender) renderList(tab);
    return jobs[tab].strategies.length;
  }

  function addFromPicker(btnEl) {
    var sec = btnEl.closest('[id^="ptHftSection"]');
    var tab = 'papertrade';
    if (sec) {
      var m = /_paper(\d+)$/.exec(sec.id || '');
      if (m) tab = 'paper' + m[1];
    }
    var sel = document.getElementById('ptHftStrategy' + sfxFor(tab));
    addStrategy(tab, sel ? sel.value : '');
  }

  function removeStrategy(tab, idx) {
    if (jobs[tab]) jobs[tab].strategies.splice(idx, 1);
    persist();
    renderList(tab);
  }

  /* Save a pooled-runner row into the Final Strategy section. Captures the
     row's own trade settings (lots / margin / TP / SL / trail SL / timeframes /
     instruments) as a raw engine-settings snapshot so the saved strategy can be
     re-run with the exact settings it used on this row. */
  function sendToFinal(tab, row) {
    if (!window.FinalStrategy || typeof FinalStrategy.saveStrategy !== 'function') {
      alert('Final Strategy module not ready yet.');
      return null;
    }
    if (!row) return null;
    var rmap = resultsMap();
    var r = resolveStrategy(row, rmap);
    if (!r && !row.strategy) {
      alert('Strategy definition not found for this row.');
      return null;
    }
    var stats = rowStats(tab, row);
    var tf = row.tf || (r && r.tf) || '5min';
    var tfs = {};
    tfs[tf] = true;
    var symbols = resolveSymbols(row, r);
    var snapshot = {
      universal: {
        lots: row.lots || 1,
        margin: row.margin || 0,
        manualSL: true,
        manualSLPct: Number(row.slPct) || 0,
        manualTrailSL: true,
        manualTrailSLPct: Number(row.slTrailPct) || 0,
        manualTP: Number(row.tpPct) > 0,
        manualTPPct: Number(row.tpPct) || 0,
        tfs: tfs,
        fnoLimit: row.fnoLimit !== false
      },
      strike: {},
      runIn: {},
      tradeIn: {},
      premiumOnly: false,
      filters: {},
      capturedAt: Date.now()
    };
    var strat = row.strategy || r || {};
    var entry = FinalStrategy.saveStrategy({
      key: rowKeyFor(tab, row) + (strat.aeKey ? ':' + strat.aeKey : ''),
      name: (strat.name || 'Pooled Strategy').replace(/^AE:\s*/, ''),
      cat: (strat.cat === 'bearish') ? 'bearish' : 'bullish',
      method: strat.method || '',
      tf: tf,
      symbol: (symbols && symbols[0] && symbols[0].name) || (strat.symbol && strat.symbol.name) || null,
      stats: {
        trades: stats.trades, wins: stats.wins, losses: stats.losses,
        winRate: stats.winRate == null ? 0 : Math.round(stats.winRate * 10) / 10,
        totalNet: Math.round((stats.realized || 0) * 100) / 100,
        avgPerTrade: stats.trades ? Math.round(((stats.realized || 0) / stats.trades) * 100) / 100 : 0,
        daysTraded: 0, lastDay: null,
        profitFactor: null
      },
      settings: null,
      snapshot: snapshot,
      strategy: JSON.parse(JSON.stringify(strat || {})),
      source: 'pooled'
    });
    if (entry) alert('"' + entry.name + '" saved to Final Strategy.');
    return entry;
  }

  function closePosition(btnEl) {
    var rowEl = btnEl.closest('.hft-row');
    if (!rowEl) return;
    var tab = tabOf(rowEl);
    var idx = parseInt(rowEl.dataset.idx, 10);
    var row = jobs[tab] && jobs[tab].strategies[idx];
    if (!row) return;
    var r = resultsMap()[row.strategyKey] || row.strategy;
    var symbols = resolveSymbols(row, r);
    var eng = engineFor(tab);
    var st = statusElFor(rowEl);
    if (!eng || !eng.autoExit) return;
    var closedAny = false;
    symbols.forEach(function (symbol) {
      if (eng.autoExit(posKeyFor(symbol, tab, row))) closedAny = true;
    });
    if (st) {
      if (closedAny) { st.textContent = 'positions closed'; st.style.color = '#00d4aa'; }
      else { st.textContent = 'no open positions'; st.style.color = '#888'; }
    }
    updateLive(tab, row);
  }

  function register(tab) {
    var loaded = loadAll();
    var prev = (loaded[tab] && Array.isArray(loaded[tab].strategies)) ? loaded[tab].strategies : [];
    jobs[tab] = { strategies: prev.map(function (s) { return Object.assign(newRow(), s); }) };
    if (el(tab, 'ptHftSection')) {
      populateStrategySelect(tab);
      renderList(tab);
    }
    if (!timer) { timer = setInterval(tick, TICK_MS); }
    return jobs[tab];
  }

  function unregister(tab) {
    delete jobs[tab];
    persist();
  }

  function refreshSelects() {
    Object.keys(jobs).forEach(populateStrategySelect);
  }

  function init() {
    register('papertrade');
    document.querySelectorAll('.tab-bar .tab-btn[data-tab]').forEach(function (btn) {
      var tab = btn.getAttribute('data-tab');
      if (/^paper\d+$/.test(tab)) register(tab);
    });
    if (window.HftPool && window.HftPool.onBar) window.HftPool.onBar(tick);
  }

  window.HftRunner = {
    register: register,
    unregister: unregister,
    addStrategy: addStrategy,
    addStrategyObject: addStrategyObject,
    bulkAddStrategies: bulkAddStrategies,
    removeStrategy: removeStrategy,
    closePosition: closePosition,
    sendToFinal: sendToFinal,
    refreshSelects: refreshSelects,
    init: init,
    jobs: jobs,
    populateStrategySelect: populateStrategySelect,
    renderList: renderList,
    runJob: runJob,
    addFromPicker: addFromPicker,
    newRow: newRow,
    posKeyFor: posKeyFor,
    rowKeyFor: rowKeyFor,
    resolveSymbols: resolveSymbols,
    rowStats: rowStats,
    liveInfo: liveInfo
  };
})();
