/* Dhan Algo - Paper Trading Module
 * Simulated brokerage execution (Dhan-account style) with no real money:
 *   - manual paper margin (editable balance)
 *   - lots x lot-size x realtime LTP exposure
 *   - market / limit order lifecycle (placed -> executed / pending)
 *   - target (take profit) and stop-loss percentages (SL supports decimals)
 *   - auto square-off on target / SL hit, realized + unrealized P&L
 * Quotes are read from the shared client-side cache fed by the live feed, so
 * the section updates tick-by-tick without extra polling.
 */
/* Manual stop-loss inputs accept EITHER a percentage (>= 1, e.g. 1 => 1%) or
   a decimal fraction (< 1, e.g. 0.05 => 5%). Return the effective percentage
   so a "0.05" stop-loss is 5% below entry instead of a 0.05% hair-trigger
   that fires on the very next candle and makes every trade exit at ~0.
   Shared by the paper-trade tab and both strategy engines. */
window.slPercentFromInput = function (v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return 0;
  return n < 1 ? n * 100 : n;
};

window.createPaperTrade = function (suffix) {
  'use strict';
  suffix = suffix || '';

  let _dirtySave = false;

  const SAVE_KEY = 'algodhan_papertrade_v1' + suffix;
  const PT_TPL_KEY = 'algodhan_pt_templates_v1' + suffix;

  const INDEX_LOT_SIZE = {
    'NIFTY 50': 75,
    'BANK NIFTY': 30,
    'FINNIFTY': 40,
    'SENSEX': 20,
    'MIDCPNIFTY': 120,
    'GIFT NIFTY': 75
  };

  /* UI symbol name -> F&O trading-symbol prefix (mirrors app.py _fno_underlying)
     so F&O stock lot sizes resolve through the scrip-master prefix map. */
  const FNO_PREFIX = {
    'NIFTY 50': 'NIFTY', 'BANK NIFTY': 'BANKNIFTY', 'FINNIFTY': 'FINNIFTY',
    'SENSEX': 'SENSEX', 'MIDCPNIFTY': 'MIDCPNIFTY', 'GIFT NIFTY': 'GIFTNIFTY',
    'BAJAJ-AUTO': 'BAJAJ', 'NAM-INDIA': 'NAM', 'TATACOMM': 'TATACOMM'
  };
  function underlyingPrefix(name) {
    const n = String(name || '').toUpperCase().trim();
    if (FNO_PREFIX[n]) return FNO_PREFIX[n];
    return n.replace(/\s+/g, '');
  }

  /* Realtime lot sizes from the Dhan scrip master (broker account data).
     Filled by /api/lot_sizes (all F&O + indices) and refreshed per-symbol by
     /api/lot_size so options/futures/equities always use the live exchange lot. */
  let LIVE_LOT_SIZES = { by_prefix: {}, by_name: {} };

  let _autoLots = false;        // fill the Lots field from affordable margin on next live price
  let _marginTouched = false;   // user edited the Paper Margin field manually

  /* F&O (derivative) instrument types: every option / future contract the
     engines trade on. Everything else (equity / index spot) is NOT an F&O
     instrument and is never re-priced by the limit-order logic below. */
  const FNO_INSTS = { OPTIDX: 1, OPTSTK: 1, FUTIDX: 1, FUTSTK: 1, FUTCOM: 1, OPTFUT: 1 };

  /* Fast F&O detection (HFT path, O(1), no allocations). A symbol is an F&O
     derivative when its instrument type is a future/option, when it carries
     option fields (strike / CE / PE), or when its exchange / derivative
     segment is the F&O segment (NSE_FNO / BSE_FNO — the way an F&O stock's
     spot leg is identified). */
  function isFnoSymbol(sym) {
    if (!sym) return false;
    if (FNO_INSTS[sym.inst]) return true;
    const ex = sym.exch || sym.ocExch;
    if (ex === 'NSE_FNO' || ex === 'BSE_FNO') return true;
    if (sym.strike != null || sym.optionType === 'CE' || sym.optionType === 'PE') return true;
    const n = String(sym.name || '');
    return /\b(CE|PE)\b/.test(n.toUpperCase());
  }

  /* Marketable F&O limit price with ~100% fill probability (O(1), <1ms).
     BUY-ONLY engine: SELL/short entries are removed, so only BUY is priced.
     The BUY limit crosses the spread AND adds a small safety buffer so the
     order fills even against a fast-moving book:
       BUY -> best ASK + buffer (always ABOVE the current price)
     Buffer = max(1 tick, ~0.1% of price): one tick is the minimum NSE
     options/futures price step; the % keeps it meaningful for higher
     premium / future contracts. When the top-of-book is absent the last
     traded price is used instead. Any non-BUY request is rejected (returns 0). */
  function fnoLimitPrice(side, q, ltp, offsetOverride) {
    if (side !== 'BUY') return 0;
    const ref = ltp > 0 ? Number(ltp) : 0;
    let buffer = ref > 0 ? Math.max(0.05, ref * 0.001) : 0.05;
    if (offsetOverride != null && Number(offsetOverride) > 0) buffer = Number(offsetOverride);
    const a = q && q.ask > 0 ? Number(q.ask) : 0;
    const base = a > 0 ? a : ref;
    return base > 0 ? base + buffer : 0;
  }

  /* Buy Only / Long Only engine: ENFORCED, not toggleable. Only BUY (long)
     trades are ever placed — SELL/short entry functions have been removed from
     the Auto Strategy Experiment engine, the AI Smart Trading Engine, AI paper
     trade and the manual Sell / Short button. Exits (square-off of open longs)
     still work. */
  const BUY_ONLY_KEY = 'algodhan_buy_only_v1' + suffix;
  let buyOnly = true;

  /* ------------------------------------------------------------------
     Dhan-style broker charge simulation (STT / brokerage / GST / etc.)

     All rates are Dhan's published tariffs (dhan.co/pricing, retail):
       Delivery:  brokerage ₹0, STT 0.1% (buy+sell), NSE txn 0.0030699%,
                  SEBI 0.0001%, stamp 0.015% (buy), IPFT 0.0000001%, GST 18%
       Intraday: brokerage ₹20 or 0.03% (lower of the two), STT 0.025% (sell),
                 NSE txn 0.0030699%, SEBI 0.0001%, stamp 0.003% (buy),
                 IPFT 0.0000001%, GST 18%
       Options:  brokerage ₹20 / executed order, STT 0.0625% of premium (sell),
                 NSE txn 0.03503% of premium, SEBI 0.0001%, stamp 0.003% (buy),
                 IPFT 0.0000001%, GST 18%
       Futures:  brokerage ₹20 / executed order, STT 0.02% of turnover (sell),
                 NSE txn 0.00173% of turnover, SEBI 0.0001%, stamp 0.003% (buy),
                 IPFT 0.0000001%, GST 18%
     Rounding: STT + stamp duty to the nearest rupee, everything else to 2 dp
     (Dhan contract-note rule). The whole simulation can be switched off with
     the shared "Broker charges" toggle so P&L can be seen gross or net.
     ------------------------------------------------------------------ */
  const CHARGES_KEY = 'algodhan_broker_charges_v1' + suffix;
  let chargesEnabled = localStorage.getItem(CHARGES_KEY) !== '0';
  const CHARGES_CONFIG = {
    delivery: { brokerageFlat: 0, brokeragePct: 0, txnPct: 0.0030699, sttBuyPct: 0.1, sttSellPct: 0.1, sebiPct: 0.0001, stampBuyPct: 0.015, stampSellPct: 0, gstPct: 18, ipftPct: 0.0000001 },
    intraday: { brokerageFlat: 20, brokeragePct: 0.03, txnPct: 0.0030699, sttBuyPct: 0, sttSellPct: 0.025, sebiPct: 0.0001, stampBuyPct: 0.003, stampSellPct: 0, gstPct: 18, ipftPct: 0.0000001 },
    options:  { brokerageFlat: 20, brokeragePct: 0, txnPct: 0.03503, sttBuyPct: 0, sttSellPct: 0.0625, sebiPct: 0.0001, stampBuyPct: 0.003, stampSellPct: 0, gstPct: 18, ipftPct: 0.0000001 },
    futures:  { brokerageFlat: 20, brokeragePct: 0, txnPct: 0.00173, sttBuyPct: 0, sttSellPct: 0.02, sebiPct: 0.0001, stampBuyPct: 0.003, stampSellPct: 0, gstPct: 18, ipftPct: 0.0000001 }
  };

  /* Charge segment for a position / symbol: OPT* -> options, FUT* -> futures,
     otherwise delivery (equity / index spot). */
  function segmentFor(pos) {
    const inst = pos.inst || (pos.instrument && (pos.instrument.instrumentType || (pos.instrument.symbol && pos.instrument.symbol.inst)));
    if (inst === 'OPTIDX' || inst === 'OPTSTK' || inst === 'OPTFUT' || inst === 'OPT') return 'options';
    if (inst === 'FUTIDX' || inst === 'FUTSTK' || inst === 'FUTCOM' || inst === 'FUT') return 'futures';
    const nm = String(pos.symbol || pos.instrumentName || '').toUpperCase();
    if (/\b(CE|PE)\b/.test(nm)) return 'options';
    return 'delivery';
  }

  /* Per-side charge line for one order (turnover = qty x price). STT + stamp
     round to the nearest rupee; all other charges to 2 decimals (Dhan rule). */
  function sideCharges(seg, orderSide, turnover) {
    const c = CHARGES_CONFIG[seg] || CHARGES_CONFIG.delivery;
    let brokerage = c.brokerageFlat;
    if (c.brokeragePct > 0) {
      const pct = (turnover * c.brokeragePct) / 100;
      brokerage = c.brokerageFlat > 0 ? Math.min(c.brokerageFlat, pct) : pct;
    }
    const txn = turnover * c.txnPct / 100;
    const stt = Math.round((orderSide === 'BUY' ? c.sttBuyPct : c.sttSellPct) * turnover / 100);
    const sebi = turnover * c.sebiPct / 100;
    const stamp = Math.round((orderSide === 'BUY' ? c.stampBuyPct : c.stampSellPct) * turnover / 100);
    const ipft = turnover * c.ipftPct / 100;
    const gst = (brokerage + txn + sebi + ipft) * c.gstPct / 100;
    return { brokerage: r2(brokerage), txn: r2(txn), stt: stt, sebi: r2(sebi), stamp: stamp, ipft: ipft, gst: r2(gst), total: r2(brokerage + txn + stt + sebi + stamp + ipft + gst) };
  }
  const r2 = n => Math.round(n * 100) / 100;

  /* Full round-trip charge estimate for a position closed at `exitPrice`.
     Returns null when the simulation is off. */
  function computeChargesForTrade(pos, exitPrice) {
    if (!chargesEnabled || !pos || !pos.qty || !pos.entryPrice || !exitPrice) return null;
    const seg = segmentFor(pos);
    const entryOrderSide = pos.side;                                   // long: BUY, short: SELL
    const exitOrderSide = pos.side === 'BUY' ? 'SELL' : 'BUY';
    const entry = sideCharges(seg, entryOrderSide, pos.qty * pos.entryPrice);
    const exit = sideCharges(seg, exitOrderSide, pos.qty * exitPrice);
    const total = r2(entry.total + exit.total);
    const gross = pnlFor(pos, exitPrice);
    return { seg: seg, entry: entry, exit: exit, total: total, gross: gross, net: r2(gross - total) };
  }
  function chargesTotalForOpen(pos, cur) {
    const c = computeChargesForTrade(pos, cur);
    return c ? c.total : 0;
  }
  function syncChargesUI() {
    const el = $id('paperBrokerCharges');
    if (el) el.checked = chargesEnabled;
  }

  function syncBuyOnlyUI() {
    const paperEl = $id('paperBuyOnly');
    if (paperEl) paperEl.checked = buyOnly;
    const aeEl = $id('aeBuyOnly');
    if (aeEl) aeEl.checked = buyOnly;
  }

  let state = {
    margin: 100000,
    position: null,        // open simulated position (manual / chart symbol)
    autoPositions: {},     // symKey -> auto-experiment paper position (multi-symbol)
    pending: null,         // pending limit order
    closed: [],
    log: []
  };

  const $id = id => document.getElementById(id + suffix) || document.getElementById(id);
  const fmt = (n, d) => (n === null || n === undefined || isNaN(n)) ? '--' : Number(n).toFixed(d);
  const fmtMoney = n => (n === null || n === undefined || isNaN(n)) ? '--' : '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  let ptChart = null;
  let _lastDash = 0;
  const equityCurve = [];   // { at, y } cumulative realized P&L after each closed trade

  function setText(id, text, color) {
    const el = $id(id);
    if (!el) return;
    el.textContent = text;
    if (color) el.style.color = color;
  }

  function realizedPnl() {
    if (!chargesEnabled) return state.closed.reduce((s, t) => s + t.pnl, 0);
    /* Net realized P&L: broker charges (STT/brokerage/GST etc.) were banked
       against each closed trade's gross P&L when it was squared off. */
    return state.closed.reduce((s, t) => s + (t.netPnl != null ? t.netPnl : t.pnl), 0);
  }

  function totalChargesPaid() {
    if (!chargesEnabled) return 0;
    return state.closed.reduce((s, t) => s + (t.charges || 0), 0);
  }

  function unrealizedPnl() {
    let sum = 0;
    const q = currentQuote();
    if (state.position && q && q.ltp) sum += pnlFor(state.position, Number(q.ltp));
    for (const ap of autoPositionsList()) {
      const aq = quoteFor({ id: ap.symbolId, exch: ap.symbolExch });
      if (aq && aq.ltp) sum += pnlFor(ap, Number(aq.ltp));
    }
    return sum;
  }

  /* Unrealized P&L after a projected round-trip charge estimate, so the Live
     P&L card shows the real (net-of-charges) picture while a position is open. */
  function unrealizedPnlNet() {
    let sum = 0;
    const q = currentQuote();
    if (state.position && q && q.ltp) sum += pnlFor(state.position, Number(q.ltp)) - chargesTotalForOpen(state.position, Number(q.ltp));
    for (const ap of autoPositionsList()) {
      const aq = quoteFor({ id: ap.symbolId, exch: ap.symbolExch });
      if (aq && aq.ltp) sum += pnlFor(ap, Number(aq.ltp)) - chargesTotalForOpen(ap, Number(aq.ltp));
    }
    return sum;
  }

  function renderOpenTable() {
    const tbody = document.querySelector('#ptOpenTable' + suffix + ' tbody');
    if (!tbody) return;
    const rows = [];
    if (state.position) rows.push({ p: state.position, quote: currentQuote() });
    for (const ap of autoPositionsList()) {
      rows.push({ p: ap, quote: quoteFor({ id: ap.symbolId, exch: ap.symbolExch }), auto: true });
    }
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="9" style="color:#888;text-align:center">No open positions</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(r => {
      const p = r.p;
      const cur = (r.quote && r.quote.live && r.quote.ltp != null) ? Number(r.quote.ltp) : null;
      const pnl = cur !== null ? pnlFor(p, cur) : null;
      const pnlPct = pnl !== null ? pnlPctFor(p, pnl) : null;
      const netPnl = (cur !== null && chargesEnabled) ? pnl - chargesTotalForOpen(p, cur) : pnl;
      const col = (chargesEnabled ? (netPnl === null ? '#888' : (netPnl >= 0 ? '#00d4aa' : '#ef5350')) : (pnl === null ? '#888' : (pnl >= 0 ? '#00d4aa' : '#ef5350')));
      const sideCol = p.side === 'BUY' ? '#00d4aa' : '#ef5350';
      const tag = r.auto ? ' <span style="color:#66ccff;font-size:8px">AUTO</span>' : '';
      return '<tr>' +
        '<td>' + (p.symbol || '') + tag + '</td>' +
        '<td style="color:' + sideCol + '">' + (p.side === 'BUY' ? 'LONG' : 'SHORT') + '</td>' +
        '<td>' + p.qty + (p.lotSize ? ' <span style="font-size:8px;color:#888">(' + (p.lots || Math.round(p.qty / p.lotSize)) + '&times;' + p.lotSize + ')</span>' : '') + '</td>' +
        '<td>' + fmt(p.entryPrice, 2) + '</td>' +
        '<td>' + (cur !== null ? fmt(cur, 2) : '--') + '</td>' +
        '<td style="color:#00d4aa">' + fmt(p.targetPrice, 2) + (p.tpPct > 0 ? ' <span style="color:#26a69a;font-size:8px">FIX ' + fmt(p.tpPrice, 2) + '</span>' : '') + '</td>' +
        '<td style="color:#ef5350">' + fmt(p.stopLoss, 2) + (p.slTrailPct > 0 ? ' <span style="color:#ff6b6b;font-size:8px">' + (trailArmed(p, cur) ? (p.slTrailed ? 'TRAIL↑' : 'TRAIL') : 'TRAIL*') + ' ' + fmt(p.slTrailPct, 2) + '%</span>' : '') + '</td>' +
        '<td style="color:' + col + '">' + (chargesEnabled ? (netPnl === null ? '--' : (netPnl >= 0 ? '+' : '') + fmtMoney(netPnl)) : (pnl === null ? '--' : (pnl >= 0 ? '+' : '') + fmtMoney(pnl))) + (chargesEnabled && pnl !== null ? '<div style="font-size:8px;color:#888">gross ' + (pnl >= 0 ? '+' : '') + fmtMoney(pnl) + '</div>' : '') + '</td>' +
        '<td style="color:' + col + '">' + (pnlPct === null ? '--' : fmt(pnlPct, 2) + '%') + '</td>' +
        '</tr>';
    }).join('');
  }

  function renderClosedTable() {
    const tbody = document.querySelector('#ptClosedTable' + suffix + ' tbody');
    if (!tbody) return;
    if (!state.closed.length) {
      tbody.innerHTML = '<tr><td colspan="11" style="color:#888;text-align:center">No closed trades</td></tr>';
      return;
    }
    tbody.innerHTML = state.closed.map((t, i) => {
      const net = (chargesEnabled && t.netPnl != null) ? t.netPnl : t.pnl;
      const col = net >= 0 ? '#00d4aa' : '#ef5350';
      const sideCol = t.side === 'BUY' ? '#00d4aa' : '#ef5350';
      const d = new Date(t.at);
      const ts = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
      return '<tr>' +
        '<td>' + (i + 1) + '</td>' +
        '<td>' + (t.symbol || '') + '</td>' +
        '<td style="color:' + sideCol + '">' + (t.side === 'BUY' ? 'LONG' : 'SHORT') + '</td>' +
        '<td>' + t.qty + '</td>' +
        '<td>' + fmt(t.entry, 2) + '</td>' +
        '<td>' + fmt(t.exit, 2) + '</td>' +
        '<td style="color:' + col + '">' + (net >= 0 ? '+' : '') + fmtMoney(net) + (chargesEnabled && t.netPnl != null ? '<div style="font-size:8px;color:#888">gross ' + (t.pnl >= 0 ? '+' : '') + fmtMoney(t.pnl) + '</div>' : '') + '</td>' +
        '<td style="color:' + col + '">' + fmt(t.pnlPct, 2) + '%</td>' +
        '<td>' + (t.reason || 'Closed') + '</td>' +
        '<td>' + (chargesEnabled ? fmtMoney(t.charges || 0) : '--') + '</td>' +
        '<td>' + ts + '</td>' +
        '</tr>';
    }).join('');
  }

  function renderSummary() {
    const realized = realizedPnl();
    const unrealized = chargesEnabled ? unrealizedPnlNet() : unrealizedPnl();
    const live = realized + unrealized;
    const wins = state.closed.filter(t => (chargesEnabled && t.netPnl != null ? t.netPnl : t.pnl) > 0).length;
    const total = state.closed.length;
    const losses = total - wins;
    const winRate = total ? (wins / total * 100) : 0;
    setText('ptLivePnl', (live >= 0 ? '+' : '') + fmtMoney(live), live >= 0 ? '#00d4aa' : '#ef5350');
    setText('ptRealized', (realized >= 0 ? '+' : '') + fmtMoney(realized), realized >= 0 ? '#00d4aa' : '#ef5350');
    setText('ptWinRate', fmt(winRate, 1) + '%', winRate >= 50 ? '#00d4aa' : '#ff9800');
    setText('ptTrades', total + ' (' + wins + 'W / ' + losses + 'L)');
    const chEl = $id('ptCharges');
    if (chEl) chEl.textContent = (chargesEnabled ? '-' : '') + fmtMoney(totalChargesPaid());
  }

  function renderChart() {
    const canvas = $id('ptChart');
    if (!canvas) return;
    const points = equityCurve.map(p => ({ at: p.at, y: Math.round(p.y * 100) / 100 }));
    if (state.closed.length || state.position || Object.keys(state.autoPositions || {}).length) {
      points.push({ at: Date.now(), y: Math.round((realizedPnl() + (chargesEnabled ? unrealizedPnlNet() : unrealizedPnl())) * 100) / 100 });
    }
    const labels = points.map(p => { const d = new Date(p.at); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0'); });
    const data = points.map(p => p.y);
    if (!ptChart) {
      ptChart = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
          labels: labels,
          datasets: [{ label: 'Cumulative P&L', data: data, borderColor: '#00d4aa', backgroundColor: 'rgba(0,212,170,0.15)', fill: true, borderWidth: 1.5, pointRadius: 1, tension: 0.2 }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { color: '#666', font: { size: 8 }, maxTicksLimit: 8 }, grid: { color: '#1a1a30' } },
            y: { ticks: { color: '#666', font: { size: 8 } }, grid: { color: '#1a1a30' } }
          }
        }
      });
    } else {
      ptChart.data.labels = labels;
      ptChart.data.datasets[0].data = data;
      ptChart.update('none');
    }
  }

  function renderDashboard(force) {
    renderSummary();
    renderOpenTable();
    renderClosedTable();
    const now = Date.now();
    if (force || now - _lastDash > 1000) {
      _lastDash = now;
      renderChart();
    }
  }

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
      if (s) state = Object.assign(state, s);
    } catch (e) {}
  }

  function save() {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        margin: state.margin,
        position: state.position,
        autoPositions: state.autoPositions || {},
        pending: state.pending,
        closed: state.closed.slice(-2000),
        log: state.log.slice(-50)
      }));
    } catch (e) {}
  }

  function log(msg, cls) {
    state.log.push({ t: Date.now(), msg: String(msg), cls: cls || '' });
    if (state.log.length > 50) state.log.shift();
    const el = $id('paperLog');
    if (!el) return;
    el.innerHTML = state.log.slice(-12).map(l => {
      const d = new Date(l.t);
      const ts = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
      const col = l.cls === 'buy' ? '#00d4aa' : (l.cls === 'sell' ? '#ef5350' : (l.cls === 'warn' ? '#ff9800' : '#888'));
      return '<div style="color:' + col + '"><span style="color:#555">' + ts + '</span> ' + l.msg + '</div>';
    }).join('');
    el.scrollTop = el.scrollHeight;
    save();
  }

  function currentQuote() {
    if (!selectedSymbol) return null;
    const key = selectedSymbol.exch === 'IDX_I' ? 'IDX_I:' + selectedSymbol.id : String(selectedSymbol.id);
    return (clientQuotes || {})[key] || null;
  }

  /* Symbol identity key used to bucket auto-experiment paper positions, which
     may be held on several symbols at once (one per symbol). */
  function symKey(symbol) {
    if (!symbol) return null;
    return String(symbol.id) + ':' + (symbol.exch || '');
  }

  /* Live quote for an arbitrary symbol (not just the chart symbol), read from
     the shared client-side cache fed by /api/quotes + the WebSocket push. */
  function quoteFor(symbol) {
    if (!symbol) return null;
    const key = symbol.exch === 'IDX_I' ? 'IDX_I:' + symbol.id : String(symbol.id);
    return (clientQuotes || {})[key] || null;
  }

  function autoPositionsList() {
    const out = [];
    for (const k in (state.autoPositions || {})) {
      if (state.autoPositions[k]) out.push(state.autoPositions[k]);
    }
    return out;
  }

  function defaultLotSize() {
    if (!selectedSymbol) return 1;
    if (selectedSymbol.lotSize) return Number(selectedSymbol.lotSize);
    const name = (selectedSymbol.name || '').toUpperCase().trim();
    if (LIVE_LOT_SIZES.by_name && LIVE_LOT_SIZES.by_name[name]) return LIVE_LOT_SIZES.by_name[name];
    if (LIVE_LOT_SIZES.by_prefix) {
      const prefix = name.replace(/\s+/g, '');
      if (LIVE_LOT_SIZES.by_prefix[prefix]) return LIVE_LOT_SIZES.by_prefix[prefix];
    }
    return INDEX_LOT_SIZE[name] || 1;
  }

  function setLotSizeInput(v) {
    const el = $id('paperLotSize');
    if (el) el.value = String(v);
  }

  function lotSizeSourceLabel(info) {
    if (!info) return 'hard-coded / manual';
    return (info.trading_symbol || info.instrument_type) + ' lot ' + Number(info.lot_size).toFixed(0) + ' (exchange)';
  }

  /* Realtime lot size for the currently selected symbol (index, F&O stock or
     option). Reads SEM_LOT_UNITS from the broker scrip master and auto-fills
     the lot-size field used for quantity / margin / total price of lot. */
  async function refreshLotSize() {
    if (!selectedSymbol) return;
    const body = {
      symbol_name: selectedSymbol.name || '',
      security_id: selectedSymbol.id,
      instrument_type: selectedSymbol.inst || '',
      exchange_segment: selectedSymbol.exch || ''
    };
    try {
      const r = await fetch('/api/lot_size', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      }).then(x => x.json());
      const srcEl = $id('paperLotSizeSrc');
      if (r && r.status === 'success' && r.data && r.data.lot_size) {
        selectedSymbol.lotSize = Number(r.data.lot_size);
        setLotSizeInput(selectedSymbol.lotSize);
        if (srcEl) { srcEl.textContent = lotSizeSourceLabel(r.data); srcEl.style.color = '#00d4aa'; }
        log('Live lot size ' + r.data.lot_size.toFixed(0) + ' from ' + r.data.trading_symbol, '');
      } else {
        selectedSymbol.lotSize = null;
        setLotSizeInput(defaultLotSize());
        if (srcEl) { srcEl.textContent = 'live lot size unavailable - fallback'; srcEl.style.color = '#ff9800'; }
      }
    } catch (e) {
      const srcEl = $id('paperLotSizeSrc');
      if (srcEl) { srcEl.textContent = 'live lot size unavailable - fallback'; srcEl.style.color = '#ff9800'; }
    }
    recompute();
  }

  /* Realtime lot sizes for ALL F&O underlyings and indices from the broker
     scrip master. Loaded once so every symbol in the list has a known lot. */
  async function loadLotSizes() {
    try {
      const r = await fetch('/api/lot_sizes').then(x => x.json());
      if (r && r.status === 'success' && r.data) {
        LIVE_LOT_SIZES = r.data;
        if (selectedSymbol && !selectedSymbol.lotSize) setLotSizeInput(defaultLotSize());
        recompute();
      }
    } catch (e) {}
  }

  /* Pull the real paper-margin from the live broker account balance so the
     margin used / total price of lot checks reflect the actual account. */
  async function syncMargin() {
    try {
      const r = await fetch('/api/account').then(x => x.json());
      if (r && r.status === 'success' && r.data && r.data.balance) {
        const avail = Number(r.data.balance.available || 0);
        state.margin = avail;
        const mgEl = $id('paperMargin');
        if (mgEl) mgEl.value = String(avail);
        log('Paper margin synced from broker account: ' + fmtMoney(avail), '');
        recompute();
      } else {
        log('Margin sync failed: ' + ((r && r.message) || 'not connected to Dhan'), 'warn');
      }
    } catch (e) {
      log('Margin sync failed: ' + e, 'warn');
    }
  }

  /* Max lots affordable with the current paper margin at the live price:
     lots = floor(margin / price-per-lot) where price-per-lot = LTP/premium x lot size. */
  function autoFillLots() {
    if (!_autoLots) return;
    const px = ltp();
    const ls = lotSize();
    const m = margin();
    if (!px || !ls || !m) return;
    const perLot = px * ls;
    if (perLot <= 0) return;
    const maxLots = Math.max(1, Math.floor(m / perLot));
    _autoLots = false;
    const lotsEl = $id('paperLots');
    if (lotsEl) lotsEl.value = String(maxLots);
    log('Lots auto-set to ' + maxLots + ' (margin ' + fmtMoney(m) + ' / ' + fmtMoney(perLot) + ' per lot)', '');
  }

  /* Auto-sync the real broker account balance into the paper margin on chart
     open - but never override a margin the user set for this session. */
  async function autoSyncMargin() {
    if (_marginTouched) return;
    try {
      const r = await fetch('/api/account').then(x => x.json());
      if (r && r.status === 'success' && r.data && r.data.balance) {
        const avail = Number(r.data.balance.available || 0);
        if (avail > 0) {
          state.margin = avail;
          const mgEl = $id('paperMargin');
          if (mgEl) mgEl.value = String(avail);
          log('Paper margin auto-synced from broker account: ' + fmtMoney(avail), '');
          recompute();
        }
      }
    } catch (e) {}
  }

  function lots() { const el = $id('paperLots'); return Math.max(1, el ? (parseInt(el.value || '1', 10) || 1) : 1); }
  function lotSize() { const el = $id('paperLotSize'); return Math.max(1, el ? (parseFloat(el.value || '1') || 1) : defaultLotSize()); }
  function qty() { return Math.round(lots() * lotSize()); }
  function ltp() { const q = currentQuote(); return (q && q.ltp) ? Number(q.ltp) : null; }
  function margin() { const el = $id('paperMargin'); return Math.max(0, el ? (parseFloat(el.value || '0') || 0) : state.margin); }
  function targetPct() { const el = $id('paperTargetPct'); return el ? (parseFloat(el.value || '0') || 0) : 0; }
  function slPct() { const el = $id('paperSlPct'); return Math.abs(window.slPercentFromInput(el ? el.value : '0')); }
  function slTrailOn() { const el = $id('paperSlTrail'); return !!(el && el.checked); }
  function slTrailPct() { const el = $id('paperSlTrailPct'); return Math.abs(window.slPercentFromInput(el ? el.value : '0')); }
  /* Effective SL % for the INITIAL stop level. When only a TRAILING SL is set
     (no fixed SL %), the stop opens trail% BELOW entry (BUY) instead of flat at
     the entry price: the trail line is then a visible protective level below
     the entry (not hidden under the entry line), and the ratchet (peak -
     trail%) engages on the very first upward tick instead of waiting for the
     price to first climb trail% above entry. A fixed SL % always wins because
     it is the wider protection. */
  function effectiveSlPct(slPctV, slTrailV) {
    if (slPctV > 0) return slPctV;
    if (slTrailV > 0) return slTrailV;
    return 0;
  }

  /* A trailing SL is considered ARMED (will actually ratchet) only while the
     trade is IN PROFIT RIGHT NOW - the live price must be beyond the entry
     (below for SELL). A one-tick blip above entry is NOT enough to label the
     trail active: if the trade has come back to / fallen into a loss the trail
     is shown as pending (TRAIL*), never as active. The stop level itself still
     ratchets only off a real peak above entry. */
  function trailArmed(p, live) {
    if (!p || !(p.slTrailPct > 0) || p.entryPrice == null) return false;
    if (live == null) return !!p.slTrailed;
    return p.side === 'BUY' ? live > p.entryPrice : live < p.entryPrice;
  }

  function marginUsed() {
    let used = 0;
    if (state.position) used += state.position.qty * state.position.entryPrice;
    for (const k in (state.autoPositions || {})) {
      const ap = state.autoPositions[k];
      if (ap) used += ap.qty * ap.entryPrice;
    }
    if (state.pending) used += state.pending.qty * (state.pending.price || 0);
    return used;
  }

  function recompute() {
    autoFillLots();
    const q = currentQuote();
    const ltpEl = $id('paperLtp');
    if (ltpEl) ltpEl.textContent = (q && q.ltp) ? fmt(q.ltp, 2) : '--';
    const qtyEl = $id('paperQty');
    if (qtyEl) qtyEl.textContent = String(qty());
    const px = (q && q.ltp) ? Number(q.ltp) : null;
    const totalEl = $id('paperTotal');
    if (totalEl) totalEl.textContent = px ? fmtMoney(px * qty()) : '--';

    // TP / SL price reference: entry price when in a position, else live LTP
    const ref = state.position ? state.position.entryPrice : px;
    const tpEl = $id('paperTpPrice'), slEl = $id('paperSlPrice');
    if (tpEl && slEl) {
      if (ref) {
        const tpPct = targetPct(), slPctv = slPct();
        if (state.position && state.position.side === 'SELL') {
          tpEl.textContent = fmt(ref * (1 - tpPct / 100), 2);
          slEl.textContent = fmt(ref * (1 + slPctv / 100), 2);
        } else {
          tpEl.textContent = fmt(ref * (1 + tpPct / 100), 2);
          slEl.textContent = fmt(ref * (1 - slPctv / 100), 2);
        }
      } else {
        tpEl.textContent = '--';
        slEl.textContent = '--';
      }
    }

    const used = marginUsed();
    const muEl = $id('paperMarginUsed'), maEl = $id('paperMarginAvail');
    if (muEl) muEl.textContent = fmt(used, 0);
    if (maEl) maEl.textContent = fmt(margin() - used, 0);
    state.margin = margin();

    const slTrailHint = $id('paperSlTrailHint');
    if (slTrailHint) slTrailHint.textContent = slTrailOn()
      ? 'Trailing SL ON — stop ratchets up to peak − ' + fmt(slTrailPct(), 2) + '% and never moves down.'
      : 'Trailing SL off — stop stays fixed at your SL %.';

    const psEl = $id('paperSymbol');
    if (psEl && selectedSymbol) {
      psEl.textContent = selectedSymbol.name || ('Symbol ' + selectedSymbol.id);
      psEl.style.color = '#ffd700';
    }

    renderPosition();
  }

  function renderPosition() {
    const el = $id('paperPosition');
    const btn = $id('paperCloseBtn');
    if (!el) return;
    let html = '';
    if (state.pending) {
      const pd = state.pending;
      const q = currentQuote();
      const cur = (q && q.ltp) ? Number(q.ltp) : null;
      const ready = cur !== null ? (pd.side === 'BUY' ? cur >= pd.price : cur <= pd.price) : false;
      html +=
        '<div style="background:#12122a;border:1px solid #5a4a1e;border-radius:4px;padding:6px 8px;margin:4px 0;font-size:10px">' +
          '<div style="display:flex;justify-content:space-between;margin-bottom:3px">' +
            '<b style="color:#ff9800">PENDING LIMIT ' + (pd.side === 'BUY' ? 'BUY' : 'SELL') + '</b>' +
            '<span>Qty <b style="color:#fff">' + pd.qty + '</b></span>' +
          '</div>' +
          '<div style="display:flex;justify-content:space-between;color:#888">' +
            '<span>Limit <b style="color:#fff">' + fmt(pd.price, 2) + '</b></span>' +
            '<span>LTP <b style="color:#fff">' + (cur !== null ? fmt(cur, 2) : '--') + '</b></span>' +
            '<span style="color:' + (ready ? '#00d4aa' : '#888') + '">' + (ready ? 'FILLING' : 'WAITING') + '</span>' +
          '</div>' +
        '</div>';
    }
    const p = state.position;
    if (!p) {
      el.innerHTML = html || '';
      if (btn) btn.style.display = 'none';
      return;
    }
    const q = currentQuote();
    const cur = (q && q.ltp) ? Number(q.ltp) : null;
    const pnl = cur !== null ? pnlFor(p, cur) : null;
    const pnlColor = !pnl ? '#888' : (pnl >= 0 ? '#00d4aa' : '#ef5350');
    const isLong = p.side === 'BUY';
    html +=
      '<div style="background:#12122a;border:1px solid #1e1e40;border-radius:4px;padding:6px 8px;margin:4px 0;font-size:10px">' +
        '<div style="display:flex;justify-content:space-between;margin-bottom:3px">' +
          '<b style="color:' + (isLong ? '#00d4aa' : '#ef5350') + '">' + (isLong ? 'LONG' : 'SHORT') + ' ' + (p.symbol || '') + '</b>' +
          '<span>Qty <b style="color:#fff">' + p.qty + '</b></span>' +
        '</div>' +
        '<div style="display:flex;justify-content:space-between;color:#888">' +
          '<span>Entry <b style="color:#fff">' + fmt(p.entryPrice, 2) + '</b></span>' +
          '<span>LTP <b style="color:#fff">' + (cur !== null ? fmt(cur, 2) : '--') + '</b></span>' +
          '<span>TP ' + fmt(p.targetPrice, 2) + ' | SL ' + fmt(p.stopLoss, 2) + (p.slTrailPct > 0 ? ' <span style="color:#ff6b6b">(trail ' + fmt(p.slTrailPct, 2) + '%' + (p.slTrailed ? ' ↑' : (trailArmed(p, cur) ? '' : ' pending-profit')) + ')</span>' : '') + '</span>' +
        '</div>' +
        '<div style="display:flex;justify-content:space-between;margin-top:4px;border-top:1px solid #1e1e40;padding-top:3px">' +
          '<span>P&L <b style="color:' + pnlColor + '">' + (pnl === null ? '--' : (pnl >= 0 ? '+' : '') + fmtMoney(pnl)) + '</b></span>' +
          '<span>' + (pnl === null ? '--' : fmt(pnlPctFor(p, pnl), 2) + '%') + '</span>' +
          '<span style="color:#ff9800">' + (p.status || 'OPEN') + '</span>' +
        '</div>' +
      '</div>';
    el.innerHTML = html;
    if (btn) btn.style.display = 'block';
  }

  function pnlFor(p, cur) {
    return p.side === 'BUY' ? (cur - p.entryPrice) * p.qty : (p.entryPrice - cur) * p.qty;
  }

  function pnlPctFor(p, pnl) {
    return p.entryPrice && p.qty ? (pnl / (p.entryPrice * p.qty)) * 100 : 0;
  }

  function currentSymbolInfo() {
    return {
      name: selectedSymbol.name || ('Symbol ' + selectedSymbol.id),
      exch: selectedSymbol.exch,
      inst: selectedSymbol.inst || 'EQUITY'
    };
  }

  function placeLimitOrder(side) {
    if (side !== 'BUY') { log('SELL/short orders removed — only BUY orders are allowed', 'warn'); return; }
    const lpEl = $id('paperLimitPrice');
    const price = lpEl ? parseFloat(lpEl.value) : NaN;
    if (!price || price <= 0) { log('Limit price required', 'warn'); return; }
    const q = qty(), px = ltp();
    const used = marginUsed();
    if (used + q * price > margin()) { log('Insufficient paper margin', 'warn'); return; }
    state.pending = {
      side: side,
      qty: q,
      price: price,
      lots: lots(), lotSize: lotSize(),
      targetPct: targetPct(), slPct: slPct(),
      symbol: currentSymbolInfo().name
    };
    log('Limit order placed: ' + side + ' ' + q + ' @ ' + fmt(price, 2) + ' (' + currentSymbolInfo().name + ')', side === 'BUY' ? 'buy' : 'sell');
    recompute();
  }

  function placeMarketOrder(side) {
    if (side !== 'BUY') { log('SELL/short orders removed — only BUY orders are allowed', 'warn'); return; }
    const px = ltp();
    if (px === null) { log('No live price available', 'warn'); return; }
    const q = qty(), used = marginUsed();
    if (used + q * px > margin()) { log('Insufficient paper margin', 'warn'); return; }
    execute(side, q, px);
  }

  function execute(side, q, price, tpPctOv, slPctOv) {
    if (side !== 'BUY') { log('SELL/short orders removed — only BUY orders are allowed', 'warn'); return; }
    const tp = (tpPctOv != null) ? tpPctOv : targetPct();
    const sl = (slPctOv != null) ? slPctOv : slPct();
    const slTrail = slTrailOn() ? slTrailPct() : 0;
    // Opposite-side open position gets squared off first (Dhan-account style)
    if (state.position && state.position.side !== side) {
      log('Existing ' + state.position.side + ' position squared off before ' + side, 'warn');
      closePosition(false);
    }
    if (state.position && state.position.side === side) {
      // Average-in on the same side
      const p = state.position;
      p.qty += q;
      p.entryPrice = (p.entryPrice * (p.qty - q) + price * q) / p.qty;
      p.targetPct = tp; p.slPct = sl;
      p.slTrailPct = slTrail; p.slTrailed = false;
      p.targetPrice = p.side === 'BUY' ? p.entryPrice * (1 + p.targetPct / 100) : p.entryPrice * (1 - p.targetPct / 100);
      p.stopLoss = p.side === 'BUY' ? p.entryPrice * (1 - effectiveSlPct(p.slPct, slTrail) / 100) : p.entryPrice * (1 + effectiveSlPct(p.slPct, slTrail) / 100);
      log('Executed ' + side + ' ' + q + ' @ ' + fmt(price, 2) + ' | Avg ' + fmt(p.entryPrice, 2), side === 'BUY' ? 'buy' : 'sell');
      recompute();
      return;
    }
    state.position = {
      side: side,
      qty: q,
      lots: lots(), lotSize: lotSize(),
      entryPrice: price,
      targetPct: tp, slPct: sl,
      slTrailPct: slTrail, slTrailed: false,
      targetPrice: side === 'BUY' ? price * (1 + tp / 100) : price * (1 - tp / 100),
      stopLoss: side === 'BUY' ? price * (1 - effectiveSlPct(sl, slTrail) / 100) : price * (1 + effectiveSlPct(sl, slTrail) / 100),
      symbol: currentSymbolInfo().name,
      status: 'OPEN',
      openedAt: Date.now()
    };
    log('Executed MARKET ' + side + ' ' + q + ' @ ' + fmt(price, 2) + ' (' + currentSymbolInfo().name + ')', side === 'BUY' ? 'buy' : 'sell');
    recompute();
  }

  function closePosition(manual) {
    const p = state.position;
    if (!p) { return; }
    const q = currentQuote();
    const cur = (q && q.ltp) ? Number(q.ltp) : p.entryPrice;
    const pnl = pnlFor(p, cur);
    const pnlPct = pnlPctFor(p, pnl);
    const charges = computeChargesForTrade(p, cur);
    const netPnl = charges ? charges.net : pnl;
    const exitSide = p.side === 'BUY' ? 'SELL' : 'BUY';
    const reason = manual === undefined || manual === true ? 'Position closed' : (p.exitReason || 'Closed');
    log(reason + ' ' + exitSide + ' ' + p.qty + ' @ ' + fmt(cur, 2) +
        ' | P&L ' + (chargesEnabled && charges ? ((netPnl >= 0 ? '+' : '') + fmtMoney(netPnl) + ' net (charges ' + fmtMoney(charges.total) + ')') : (pnl >= 0 ? '+' : '') + fmtMoney(pnl)) + ' (' + fmt(pnlPct, 2) + '%)',
        pnl >= 0 ? 'buy' : 'sell');
    state.closed.unshift({
      symbol: p.symbol, side: p.side, qty: p.qty, entry: p.entryPrice,
      exit: cur, pnl: pnl, pnlPct: pnlPct, netPnl: charges ? netPnl : null, charges: charges ? charges.total : 0, at: Date.now(), reason: reason
    });
    equityCurve.push({ at: Date.now(), y: realizedPnl() });
    state.position = null;
    recompute();
    renderDashboard(true);
    /* Feed the global Strategy Container so every strategy's paper-trade stats
       (win rate / P&L / per-trade average) stay current per day. */
    if (window.StrategyContainer && StrategyContainer.recordTrade) {
      try {
        StrategyContainer.recordTrade({
          symbol: p.symbol, side: p.side, qty: p.qty, entry: p.entryPrice,
          exit: cur, pnl: pnl, pnlPct: pnlPct, netPnl: charges ? netPnl : null,
          charges: charges ? charges.total : 0, at: Date.now(), reason: reason,
          autoKey: p.autoKey || null,
          symbolId: (p.symbolId != null) ? p.symbolId : ((selectedSymbol && selectedSymbol.id != null) ? selectedSymbol.id : null),
          symbolExch: (p.symbolExch != null) ? p.symbolExch : ((selectedSymbol && selectedSymbol.exch != null) ? selectedSymbol.exch : null)
        });
      } catch (e) {}
    }
  }

  function checkTargetSl() {
    const p = state.position;
    if (!p) return;
    const q = currentQuote();
    const cur = (q && q.live && q.ltp) ? Number(q.ltp) : null;
    if (cur === null) return;
    if (p.side === 'BUY') {
      if (p.peakPrice == null || cur > p.peakPrice) p.peakPrice = cur;
      /* Trail SL only activates once the trade is IN PROFIT (price has traded
         above the entry). While the trade sits at/below entry the SL stays at
         the fixed entry-based level; the ratchet must NOT pull the stop up
         against an open loss. As soon as the price goes above entry the trail
         is live on the very first tick. The stop then RIDES THE RUNNING PROFIT
         (peak - entry), not the raw peak: it keeps (100 - trail%)% of the peak
         profit and only gives back trail% of it, so the SL hugs the profit and
         slides up behind it tick by tick. */
      if ((p.slPct > 0 || p.slTrailPct > 0) && p.slTrailPct > 0 && p.stopLoss != null && p.peakPrice > p.entryPrice) {
        const peakProfit = p.peakPrice - p.entryPrice;
        const ratchet = p.entryPrice + peakProfit * (1 - p.slTrailPct / 100);
        if (ratchet > p.stopLoss) { p.stopLoss = ratchet; p.slTrailed = true; }
      }
      if ((p.slPct > 0 || p.slTrailPct > 0) && p.stopLoss != null && cur <= p.stopLoss) { p.exitReason = p.slTrailed ? 'Trailing SL hit' : 'Stop loss hit'; closePosition(false); return; }
      if (cur >= p.targetPrice) { p.exitReason = 'Target hit'; closePosition(false); return; }
    } else {
      if (p.peakPrice == null || cur < p.peakPrice) p.peakPrice = cur;
      if ((p.slPct > 0 || p.slTrailPct > 0) && p.slTrailPct > 0 && p.stopLoss != null && p.peakPrice < p.entryPrice) {
        const peakProfit = p.entryPrice - p.peakPrice;
        const ratchet = p.entryPrice - peakProfit * (1 - p.slTrailPct / 100);
        if (ratchet < p.stopLoss) { p.stopLoss = ratchet; p.slTrailed = true; }
      }
      if ((p.slPct > 0 || p.slTrailPct > 0) && p.stopLoss != null && cur >= p.stopLoss) { p.exitReason = p.slTrailed ? 'Trailing SL hit' : 'Stop loss hit'; closePosition(false); return; }
      if (cur <= p.targetPrice) { p.exitReason = 'Target hit'; closePosition(false); return; }
    }
  }

  function checkPendingFill() {
    const pd = state.pending;
    if (!pd) return;
    const q = currentQuote();
    const cur = (q && q.live && q.ltp) ? Number(q.ltp) : null;
    if (cur === null) return;
    const hit = pd.side === 'BUY' ? cur >= pd.price : cur <= pd.price;
    if (hit) {
      state.pending = null;
      log('Limit order filled @ ' + fmt(pd.price, 2), pd.side === 'BUY' ? 'buy' : 'sell');
      execute(pd.side, pd.qty, pd.price);
    }
  }

  /* Called every time a chart is opened (symbol dropdown, watchlist, option
     strike, strategy chart, refresh). Auto-fills the paper section with the
     live lot size, broker margin and the number of lots the margin allows. */
  function onChartOpen() {
    if (!selectedSymbol) return;
    selectedSymbol.lotSize = null;
    _autoLots = true;
    refreshLotSize();
    autoSyncMargin();
    recompute();
  }

  function update() {
    recompute();
    checkPendingFill();
    checkTargetSl();
    checkAutoTargetSl();
    renderDashboard(false);
    /* Flush any silent (tick-level) risk-scan closes to localStorage once per
       throttled cycle instead of writing on every ~5ms feed batch. */
    if (_dirtySave) { _dirtySave = false; save(); }
  }

  const api = {
    update: update,

    onInput() {
      const t = (typeof event !== 'undefined' && event && event.target) || null;
      if (t && t.id === 'paperLots') _autoLots = false;
      if (t && t.id === 'paperMargin') _marginTouched = true;
      recompute();
    },

    onOrderTypeChange() {
      const otEl = $id('paperOrderType');
      const v = otEl ? otEl.value : 'MARKET';
      const wrap = $id('paperLimitWrap');
      if (wrap) wrap.style.display = v === 'LIMIT' ? 'block' : 'none';
      recompute();
    },

    onSymbolChange() {
      onChartOpen();
    },

    onChartOpen: onChartOpen,

    buy() {
      if (!selectedSymbol) { log('Select a symbol first', 'warn'); return; }
      const otEl = $id('paperOrderType');
      if (otEl && otEl.value === 'LIMIT') placeLimitOrder('BUY');
      else placeMarketOrder('BUY');
    },

    sell() {
      log('SELL/short orders removed — only BUY orders are allowed', 'warn');
    },

    closePosition() {
      if (!state.position) return;
      closePosition(true);
    },

    /* Square off EVERY open paper position: the manual chart position plus all
       auto positions regardless of which engine opened them (AISmart, Auto
       Experiment, or the base paper engine). Returns the count of positions
       closed. Used by the daily auto square-off. */
    closeAllPositions(reason) {
      let closed = 0;
      if (state.position) { closePosition(false); closed++; }
      const keys = Object.keys(state.autoPositions || {});
      keys.forEach(k => { if (closeAutoPosition(k, reason || 'Auto square-off')) closed++; });
      if (closed) { save(); renderDashboard(true); }
      return closed;
    },

    reset() {
      state.position = null;
      state.autoPositions = {};
      state.pending = null;
      state.closed = [];
      equityCurve.length = 0;
      log('Paper trading reset', 'warn');
      recompute();
      renderDashboard(true);
    },

    onTabShow() {
      _lastDash = 0;
      renderDashboard(true);
      if (ptChart) ptChart.resize();
      onChartOpen();
      if (window.StrategyContainer && StrategyContainer.refresh) {
        try { StrategyContainer.refresh(); } catch (e) {}
      }
    },

    syncMargin: syncMargin,

    getState() { return state; },

    /* Buy Only / Long Only is ENFORCED — SELL/short orders have been removed
       from every engine and the manual Sell / Short button. Attempts to turn
       the mode off are ignored so only BUY/long entries can ever be placed.
       Exits (square-off of open longs) still work. */
    setBuyOnly(v) {
      buyOnly = true;
      localStorage.setItem(BUY_ONLY_KEY, '1');
      syncBuyOnlyUI();
      if (v !== true) {
        log('SELL/short orders are removed — Buy Only (Long Only) is enforced and cannot be turned off', 'warn');
      }
      renderDashboard(false);
    },

    getBuyOnly() { return buyOnly; },

    /* -------- paper-trade templates -------- */
    /* Saved trade-setting templates (lots / margin / trail-TP / SL) for this
       paper-trade engine instance. Saved per tab so each paper trade engine
       (base + clones) keeps its own set; the Strategy Container lists them to
       batch-add selected strategies that trade on the chosen template. */
    getTemplates() {
      try { return JSON.parse(localStorage.getItem(PT_TPL_KEY) || '[]'); } catch (e) { return []; }
    },
    getTradeSettings() {
      const sym = (typeof selectedSymbol !== 'undefined' && selectedSymbol) ? selectedSymbol : null;
      return {
        symbol: sym ? { id: sym.id, exch: sym.exch, name: sym.name, inst: sym.inst || null, ocId: sym.ocId != null ? sym.ocId : null, ocExch: sym.ocExch != null ? sym.ocExch : null } : null,
        lots: lots(), margin: margin(), tpPct: targetPct(), slPct: slPct(), fnoLimit: true
      };
    },
    saveTemplate(name) {
      const list = api.getTemplates();
      const tpl = Object.assign({ id: Date.now() + '-' + Math.floor(Math.random() * 1e6), name: String(name || 'Template ' + (list.length + 1)).trim() }, api.getTradeSettings());
      list.push(tpl);
      try { localStorage.setItem(PT_TPL_KEY, JSON.stringify(list)); } catch (e) {}
      log('Saved paper-trade template "' + tpl.name + '" (lots ' + tpl.lots + ', margin ' + fmtMoney(tpl.margin) + ', TP ' + tpl.tpPct + '%, SL ' + tpl.slPct + '%)', 'ok');
      api.refreshTemplates();
      return tpl;
    },
    deleteTemplate(id) {
      const list = api.getTemplates().filter(t => String(t.id) !== String(id));
      try { localStorage.setItem(PT_TPL_KEY, JSON.stringify(list)); } catch (e) {}
      api.refreshTemplates();
      return list;
    },
    /* Fill the paper panel's template dropdown (#paperTplApply) with this
       engine's saved templates (active tab). */
    refreshTemplates() {
      const sel = $id('paperTplApply');
      if (!sel) return;
      const list = api.getTemplates();
      let html = '<option value="">-- apply a saved template --</option>';
      list.forEach(t => {
        const symTxt = (t.symbol && t.symbol.name) ? (' [' + t.symbol.name + ']') : '';
        html += '<option value="' + t.id + '">' + String(t.name) + symTxt + ' (lots ' + t.lots + ', margin ' + t.margin + ', TP ' + t.tpPct + '%, SL ' + t.slPct + '%)</option>';
      });
      sel.innerHTML = html;
      return list.length;
    },
    applyTemplate(id) {
      const t = api.getTemplates().find(x => String(x.id) === String(id));
      if (!t) return false;
      if ($id('paperLots')) $id('paperLots').value = t.lots;
      if ($id('paperMargin')) $id('paperMargin').value = t.margin;
      if ($id('paperTargetPct')) $id('paperTargetPct').value = t.tpPct;
      if ($id('paperSlPct')) $id('paperSlPct').value = t.slPct;
      /* Switch the chart symbol to the template's symbol when available. */
      if (t.symbol && t.symbol.id != null && typeof onSymbolChange === 'function') {
        const s = document.getElementById('symbolSelect');
        if (s) {
          for (let i = 0; i < s.options.length; i++) {
            const opt = s.options[i];
            const exch = opt.getAttribute('data-exch') || '';
            const sid = parseInt(opt.value, 10);
            if (sid === Number(t.symbol.id) && (!t.symbol.exch || exch === t.symbol.exch)) {
              s.selectedIndex = i;
              try { onSymbolChange(); } catch (e) {}
              break;
            }
          }
        }
      }
      recompute();
      log('Applied paper-trade template "' + t.name + '" (lots ' + t.lots + ', margin ' + fmtMoney(t.margin) + ', TP ' + t.tpPct + '%, SL ' + t.slPct + '%)', 'ok');
      return true;
    },

    /* Dhan-style broker charge simulation toggle. When ON, P&L shown in the
       paper-trade UI is net of simulated broker charges (STT, brokerage, NSE
       transaction, SEBI, stamp duty, GST, IPFT). When OFF, gross P&L is shown. */
    setCharges(v) {
      chargesEnabled = !!v;
      localStorage.setItem(CHARGES_KEY, chargesEnabled ? '1' : '0');
      syncChargesUI();
      log('Broker charge simulation ' + (chargesEnabled ? 'ON — P&L shown net of Dhan charges (STT/GST/brokerage/txn/stamp/SEBI/IPFT)' : 'OFF — P&L shown gross of charges'), 'warn');
      renderDashboard(true);
      recompute();
    },

    getCharges() { return chargesEnabled; },
    computeChargesForTrade: computeChargesForTrade,
    chargesTotalForOpen: chargesTotalForOpen,
    totalChargesPaid: totalChargesPaid,

    /* F&O (derivative) detection + marketable limit price helpers, shared with
       the AI paper-trade engine so both entry paths price F&O entries with the
       same fast top-of-book logic. */
    isFnoSymbol: isFnoSymbol,
    fnoLimitPrice: fnoLimitPrice,

    /* Lot size for any symbol (index, F&O stock or option), falling back to
       the known index lot table. Used by the auto-experiment detail view to
       convert % P&L into rupees and by the auto paper-trade entry to size the
       quantity from the real exchange lot. */
    lotSizeFor(symbol) {
      if (!symbol) return 1;
      if (symbol.lotSize) return Number(symbol.lotSize);
      const name = String(symbol.name || '').toUpperCase().trim();
      // Option names ("NIFTY 50 25000 CE") resolve to their underlying so the
      // option lot = underlying F&O lot.
      const optMatch = name.match(/^(.*?)\s+\d+(\.\d+)?\s*(CE|PE)$/);
      const base = optMatch ? optMatch[1].trim() : name;
      if (LIVE_LOT_SIZES.by_name && LIVE_LOT_SIZES.by_name[base]) return LIVE_LOT_SIZES.by_name[base];
      if (LIVE_LOT_SIZES.by_prefix) {
        const prefix = underlyingPrefix(base);
        if (LIVE_LOT_SIZES.by_prefix[prefix]) return LIVE_LOT_SIZES.by_prefix[prefix];
      }
      return INDEX_LOT_SIZE[base] || 1;
    },

    /* Auto-experiment order entry: place a paper market order driven by an
       auto strategy signal, using explicit universal settings (lot size, lots,
       margin, take-profit / stop-loss %) instead of the sidebar form. Returns
        true when the order was executed, false when it was skipped. */
    autoEntry(side, opts) {
      opts = opts || {};
      // Why the last auto entry attempt succeeded or was rejected. Engines read
      // this after a failed autoEntry to surface the reason on each running
      // strategy's progress bar (e.g. "no live price" for an un-subscribed
      // option contract) instead of only seeing a silent skip.
      this.lastAutoSkip = 'OK';
      if (side !== 'BUY') {
        this.lastAutoSkip = 'Buy-only (Long Only) engine';
        log('Auto SELL skipped: SELL/short orders are removed (buy-only engine)', 'warn');
        return false;
      }
      const symbol = opts.symbol || ((typeof selectedSymbol !== 'undefined') ? selectedSymbol : null);
      /* Position identity key. Engines may pass opts.posKey to isolate their
         auto positions per tab / per strategy (e.g. the HFT runner) so several
         strategies can hold the SAME symbol independently instead of sharing
         one symbol-bucket that average-in on top of each other. Defaults to the
         symbol key for full backward compatibility. */
      const key = opts.posKey || symKey(symbol);
      if (!key) { this.lastAutoSkip = 'No symbol'; log('Auto ' + side + ' skipped: no symbol', 'warn'); return false; }
      const q = quoteFor(symbol) || (symbol === selectedSymbol ? currentQuote() : null);
      /* No entry until the contract has a LIVE feed quote. A stale option-chain
         premium (fallbackLtp) must NEVER price an entry: the chain snapshot can
         lag the market by seconds, the fill price would be wrong, and the trade
         would open already under water (the immediate-loss bug). The engines
         pre-fetch the contract's candles so the server subscribes its live feed;
         entries simply retry on the next evaluation cycle until the live tick
         arrives. */
      const px = (q && q.live && q.ltp) ? Number(q.ltp) : null;
      if (px === null || !(px > 0)) {
        this.lastAutoSkip = 'No live quote yet for ' + (symbol.name || symbol.id);
        log('Auto ' + side + ' ' + (symbol.name || symbol.id) + ' skipped: no live quote yet (waiting for feed)', 'warn');
        return false;
      }
      /* Fill price basis for strategy / chart execution. The default is to
         fill AT the live chart price (the LTP the chart shows) - no spread
         crossing, no ask+buffer premium, so a position never opens already
         underwater. Only a caller that explicitly opts in (opts.fnoLimit ===
         true - e.g. the dedicated HFT runner / limit-order engines) gets the
         MARKETABLE LIMIT priced at ask+buffer for ~100% fill probability. */
      const fnoLimit = opts.fnoLimit === true && isFnoSymbol(symbol);
      const fillPx = fnoLimit ? fnoLimitPrice(side, q, px, opts.limitOffset) : px;
      if (fnoLimit && fillPx <= 0) { this.lastAutoSkip = 'No limit price for ' + (symbol.name || symbol.id); log('Auto ' + side + ' ' + (symbol.name || symbol.id) + ' skipped: no limit price', 'warn'); return false; }
      const orderType = fnoLimit ? 'LIMIT' : 'MARKET';
      const limitPrice = fnoLimit ? fillPx : 0;
      const lotSz = (opts.lotSize != null) ? Math.max(1, Number(opts.lotSize)) : (typeof this.lotSizeFor === 'function' ? (Math.max(1, Number(this.lotSizeFor(symbol)) || 1)) : 1);
      const lotsN = (opts.lots != null) ? Math.max(1, Math.round(Number(opts.lots))) : lots();
      const qtyN = Math.round(lotsN * lotSz);
      const m = (opts.margin != null) ? Math.max(0, Number(opts.margin)) : margin();
      const tp = (opts.tpPct != null) ? Number(opts.tpPct) : targetPct();
      const sl = (opts.slPct != null) ? Number(opts.slPct) : slPct();
      const ftp = (opts.fixedTpPct != null) ? Number(opts.fixedTpPct) : 0;
      const slTrail = (opts.slTrailPct != null) ? Math.max(0, Number(opts.slTrailPct) || 0) : 0;
      const used = marginUsed();
      if (used + qtyN * fillPx > m) {
        this.lastAutoSkip = 'Insufficient margin (needs ' + Math.round(qtyN * fillPx).toLocaleString('en-IN') + ')';
        log('Auto ' + side + ' ' + (symbol.name || symbol.id) + ' skipped: insufficient margin', 'warn');
        return false;
      }
      const name = symbol.name || ('Symbol ' + symbol.id);
      const existing = state.autoPositions[key];
      if (existing && existing.side !== side) {
        // Opposite-side auto position on this symbol is squared off first.
        closeAutoPosition(key, 'Reversed');
      } else if (existing && existing.side === side) {
        // Average-in on the same side (Dhan-account style).
        const p = existing;
        p.qty += qtyN;
        p.entryPrice = (p.entryPrice * (p.qty - qtyN) + fillPx * qtyN) / p.qty;
        p.orderType = orderType; p.limitPrice = limitPrice;
        p.targetPct = tp; p.slPct = sl;
        p.slTrailPct = slTrail; p.slTrailed = false;
        if (p.peakPrice == null) p.peakPrice = p.entryPrice;
        p.targetPrice = p.entryPrice;
        p.stopLoss = side === 'BUY' ? p.entryPrice * (1 - effectiveSlPct(sl, slTrail) / 100) : p.entryPrice * (1 + effectiveSlPct(sl, slTrail) / 100);
        if (ftp > 0) { p.tpPct = ftp; p.tpPrice = side === 'BUY' ? p.entryPrice * (1 + ftp / 100) : p.entryPrice * (1 - ftp / 100); }
        else { delete p.tpPct; delete p.tpPrice; }
        log('Auto ' + side + ' ' + name + ' averaged @ ' + fmt(fillPx, 2), side === 'BUY' ? 'buy' : 'sell');
        recompute(); renderDashboard(true);
        return true;
      }
      state.autoPositions[key] = {
        side: side,
        qty: qtyN,
        lots: lotsN, lotSize: lotSz,
        entryPrice: fillPx,
        peakPrice: fillPx,
        orderType: orderType, limitPrice: limitPrice,
        targetPct: tp, slPct: sl,
        slTrailPct: slTrail, slTrailed: false,
        targetPrice: fillPx,
        stopLoss: side === 'BUY' ? fillPx * (1 - effectiveSlPct(sl, slTrail) / 100) : fillPx * (1 + effectiveSlPct(sl, slTrail) / 100),
        tpPct: ftp > 0 ? ftp : 0,
        tpPrice: ftp > 0 ? (side === 'BUY' ? fillPx * (1 + ftp / 100) : fillPx * (1 - ftp / 100)) : 0,
        symbol: name,
        symbolId: symbol.id, symbolExch: symbol.exch,
        inst: symbol.inst || null,
        ocId: symbol.ocId != null ? symbol.ocId : null,
        ocExch: symbol.ocExch != null ? symbol.ocExch : null,
        auto: true, autoKey: opts.key || null,
        status: 'OPEN', openedAt: Date.now()
      };
      log('Auto ' + side + ' ' + name + ' ' + qtyN + ' @ ' + fmt(fillPx, 2) + (orderType === 'LIMIT' ? ' [LIMIT]' : '') + ' (trail ' + fmt(state.autoPositions[key].targetPrice, 2) + ' / SL ' + fmt(state.autoPositions[key].stopLoss, 2) + ')', side === 'BUY' ? 'buy' : 'sell');
      recompute();
      renderDashboard(true);
      return true;
    },

    /* Square off an auto paper position for a symbol (identified by its
       symKey id:exch). Returns true when a position was closed. Used by the
       manual Stop / Close / Remove buttons; recorded as a manual close. */
    autoExit(key) {
      if (!key) {
        // Backward-compatible: close the chart symbol's auto position.
        const s = (typeof selectedSymbol !== 'undefined') ? selectedSymbol : null;
        key = symKey(s);
      }
      if (!key || !state.autoPositions[key]) return false;
      return closeAutoPosition(key, 'Manual');
    }
  };

  function closeAutoPosition(key, reason, fillPrice, silent) {
    const p = state.autoPositions[key];
    if (!p) return false;
    const q = quoteFor({ id: p.symbolId, exch: p.symbolExch });
    /* Protection exits fill at the protection level (the stop/trail/TP order
       price), not at the last tick that already overshot it. Falls back to the
       live LTP when no explicit fill price is supplied (manual / signal exit). */
    const cur = (fillPrice != null && isFinite(fillPrice) && Number(fillPrice) > 0)
      ? Number(fillPrice)
      : ((q && q.ltp) ? Number(q.ltp) : p.entryPrice);
    const pnl = pnlFor(p, cur);
    const pnlPct = pnlPctFor(p, pnl);
    const charges = computeChargesForTrade(p, cur);
    const netPnl = charges ? charges.net : pnl;
    const exitSide = p.side === 'BUY' ? 'SELL' : 'BUY';
    log(reason + ' ' + exitSide + ' ' + p.symbol + ' ' + p.qty + ' @ ' + fmt(cur, 2) +
        ' | P&L ' + (chargesEnabled && charges ? ((netPnl >= 0 ? '+' : '') + fmtMoney(netPnl) + ' net (charges ' + fmtMoney(charges.total) + ')') : (pnl >= 0 ? '+' : '') + fmtMoney(pnl)) + ' (' + fmt(pnlPct, 2) + '%)' +
        (p.slPct != null ? ' | SL ' + p.slPct + '%' : '') +
        (p.targetPct != null ? ' | Trail ' + p.targetPct + '%' : '') +
        (p.tpPct > 0 ? ' | FixTP ' + p.tpPct + '%' : ''),
        pnl >= 0 ? 'buy' : 'sell');
    state.closed.unshift({
      symbol: p.symbol, side: p.side, qty: p.qty, entry: p.entryPrice,
      exit: cur, pnl: pnl, pnlPct: pnlPct, netPnl: charges ? netPnl : null, charges: charges ? charges.total : 0, at: Date.now(), reason: reason,
      autoKey: p.autoKey || null,
      symbolId: p.symbolId != null ? p.symbolId : null,
      symbolExch: p.symbolExch != null ? p.symbolExch : null
    });
    equityCurve.push({ at: Date.now(), y: realizedPnl() });
    delete state.autoPositions[key];
    if (!silent) {
      recompute();
      save();
      renderDashboard(true);
    } else {
      _dirtySave = true;
    }
    /* Feed the global Strategy Container so every strategy's paper-trade stats
       (win rate / P&L / per-trade average) stay current per day. */
    if (window.StrategyContainer && StrategyContainer.recordTrade) {
      try {
        StrategyContainer.recordTrade({
          symbol: p.symbol, side: p.side, qty: p.qty, entry: p.entryPrice,
          exit: cur, pnl: pnl, pnlPct: pnlPct, netPnl: charges ? netPnl : null,
          charges: charges ? charges.total : 0, at: Date.now(), reason: reason,
          autoKey: p.autoKey || null,
          symbolId: p.symbolId != null ? p.symbolId : null,
          symbolExch: p.symbolExch != null ? p.symbolExch : null
        });
      } catch (e) {}
    }
    return true;
  }

  function checkAutoTargetSl(silent) {
    for (const key of Object.keys(state.autoPositions || {})) {
      const p = state.autoPositions[key];
      if (!p) continue;
      const q = quoteFor({ id: p.symbolId, exch: p.symbolExch });
      const cur = (q && q.ltp) ? Number(q.ltp) : null;
      /* Only LIVE feed quotes can close a position. Backfill / seeded quotes
         (no live flag) are stale or engine-seeded approximations and must never
         trigger a stop-loss / trail-TP / take-profit, or trades would close
         "suddenly" on a frozen or mismatched price. */
      if (cur === null || !q.live) continue;
      const trailPct = p.targetPct || 0;
      if (p.side === 'BUY') {
        /* Trailing stop-loss: as the peak rises, the SL ratchets UP behind it
           (peak - slTrailPct%), exactly like the trailing TP ratchets its exit
           level. It only ever moves in the favourable direction (never down for
           a BUY), so it first locks in protection and then locks in profit. The
           ratcheted level replaces the fixed entry-based SL, so the running SL
           line and the actual cut level always agree. */
        if (p.peakPrice == null || cur > p.peakPrice) p.peakPrice = cur;
        /* Trail SL only activates once the trade is IN PROFIT (price has traded
           above the entry). While the trade sits at/below entry the SL stays at
           the fixed entry-based level; the ratchet must NOT pull the stop up
           against an open loss. As soon as the price goes above entry the trail
           is live on the very first tick. The stop then RIDES THE RUNNING
           PROFIT (peak - entry), not the raw peak: it keeps (100 - trail%)% of
           the peak profit and only gives back trail% of it, so the SL hugs the
           profit and slides up behind it tick by tick. */
        if ((p.slPct > 0 || p.slTrailPct > 0) && p.slTrailPct > 0 && p.stopLoss != null && p.peakPrice > p.entryPrice) {
          const peakProfit = p.peakPrice - p.entryPrice;
          const ratchet = p.entryPrice + peakProfit * (1 - p.slTrailPct / 100);
          if (ratchet > p.stopLoss) { p.stopLoss = ratchet; p.slTrailed = true; }
        }
        // Stop-loss protection: closes the trade at the set SL % (below entry)
        // when the price falls to that level, capping the loss on a losing
        // trade. Only active when a positive SL % was set at entry. When a
        // trailing SL is active the level is the ratcheted (peak - trail%) one.
        if ((p.slPct > 0 || p.slTrailPct > 0) && p.stopLoss != null && cur <= p.stopLoss) { closeAutoPosition(key, p.slTrailed ? 'Trailing SL hit' : 'Stop loss hit', p.stopLoss, silent); continue; }
        // Profit-taking exits close a trade:
        //  - Trailing take-profit banks the profit: it is a % of the running
        //    profit (peak - entry). As the peak profit grows the trail auto-
        //    moves up, keeping (100 - trailPct)% of the peak profit and
        //    exiting when the profit falls back to that level. It is active
        //    from the first paisa of profit and never fills below entry.
        //  - A fixed take-profit % (tpPct) banks a set profit % off entry.
        //  Fills are priced at the protection level (the trail/TP order) so a
        //  gap through a level never books a worse fill than the level.
        if (p.tpPct > 0 && cur >= p.tpPrice) { closeAutoPosition(key, 'Take profit hit', p.tpPrice, silent); continue; }
        if (trailPct > 0) {
          const peakProfit = p.peakPrice - p.entryPrice;
          const trail = Math.max(p.entryPrice + peakProfit * (1 - trailPct / 100), p.entryPrice);
          p.targetPrice = trail;
          if (peakProfit > 0 && cur <= trail) { closeAutoPosition(key, 'Trailing target hit', trail, silent); continue; }
        } else {
          p.targetPrice = p.peakPrice;
        }
      } else {
        /* Trailing stop-loss for SELL: the SL ratchets DOWN as the price
           falls to a new low (peak + slTrailPct%), locking in profit. */
        if (p.peakPrice == null || cur < p.peakPrice) p.peakPrice = cur;
        if ((p.slPct > 0 || p.slTrailPct > 0) && p.slTrailPct > 0 && p.stopLoss != null && p.peakPrice < p.entryPrice) {
          const peakProfit = p.entryPrice - p.peakPrice;
          const ratchet = p.entryPrice - peakProfit * (1 - p.slTrailPct / 100);
          if (ratchet < p.stopLoss) { p.stopLoss = ratchet; p.slTrailed = true; }
        }
        // Stop-loss protection for SELL positions: closes when the price rises
        // to the SL % (above entry) level, capping the loss.
        if ((p.slPct > 0 || p.slTrailPct > 0) && p.stopLoss != null && cur >= p.stopLoss) { closeAutoPosition(key, p.slTrailed ? 'Trailing SL hit' : 'Stop loss hit', p.stopLoss, silent); continue; }
        if (p.tpPct > 0 && cur <= p.tpPrice) { closeAutoPosition(key, 'Take profit hit', p.tpPrice, silent); continue; }
        if (trailPct > 0) {
          const peakProfit = p.entryPrice - p.peakPrice;
          const trail = Math.min(p.entryPrice - peakProfit * (1 - trailPct / 100), p.entryPrice);
          p.targetPrice = trail;
          if (peakProfit > 0 && cur >= trail) { closeAutoPosition(key, 'Trailing target hit', trail, silent); continue; }
        } else {
          p.targetPrice = p.peakPrice;
        }
      }
    }
  }

  function init() {
    load();
    syncChargesUI();
    syncBuyOnlyUI();
    // rebuild equity curve from persisted closed trades (closed is newest-first)
    equityCurve.length = 0;
    let cum = 0;
    state.closed.slice().reverse().forEach(t => {
      cum += (chargesEnabled && t.netPnl != null ? t.netPnl : t.pnl);
      equityCurve.push({ at: t.at, y: Math.round(cum * 100) / 100 });
    });
    if (state.margin) {
      const mgEl = $id('paperMargin');
      if (mgEl) mgEl.value = String(state.margin);
    }
    const lsEl = $id('paperLotSize');
    if (lsEl) lsEl.value = String(defaultLotSize());
    const psEl = $id('paperSymbol');
    if (psEl && selectedSymbol) psEl.textContent = selectedSymbol.name || ('Symbol ' + selectedSymbol.id);
    loadLotSizes();
    onChartOpen();
    api.refreshTemplates();
    log('Paper trading ready. Margin ' + fmtMoney(state.margin), '');
    recompute();
    renderDashboard(true);
  }

  api.boot = init;

  /* Ultra-fast risk scan: called from the WS quote pipeline on every quote
     batch. Scans open auto positions against the just-updated live quotes and
     closes any that broke their SL / trailing-SL / TP / trailing-TP level,
     WITHOUT touching the DOM. This is the tick-level (not candle-close) exit
     that keeps fills at the drawn protection level. The normal throttled
     render path then re-renders the dashboard once per cycle. */
  api.riskScan = function () {
    try { checkAutoTargetSl(true); } catch (e) {}
    return state.autoPositions ? Object.keys(state.autoPositions).length : 0;
  };

  api.slTrailOn = slTrailOn;
  api.slTrailPct = slTrailPct;

  /* Lightweight live re-render of the running trades (open table + summary
     cards) only - no chart rebuild. Called from the throttled ~250ms quote
     loop so the Running P&L rides the exact same live quote the chart shows,
     instead of waiting for the multi-second poll tick. */
  api.refreshLiveRunning = function () {
    renderOpenTable();
    renderSummary();
  };

  /* Expose position snapshots for the chart overlay + dashboard render. */
  api.getAutoPositions = function () { return state.autoPositions || {}; };
  api.getManualPosition = function () { return state.position || null; };

  /* Per-tab instance registry + active-tab facade, mirroring the Auto
     Experiment engine: the base tab registers as "papertrade" and keeps full
     backward compatibility; duplicated paper tabs register under their own
     suffixed ids. window.PaperTrade forwards every call to whichever paper tab
     is active so each duplicated tab trades on its own state. */
  if (!window.TabEngines) window.TabEngines = {};
  if (!window.TabEngines.papertrade) window.TabEngines.papertrade = {};
  const instKey = suffix.replace(/^_/, '') || 'papertrade';
  window.TabEngines.papertrade[instKey] = api;

  if (!window._PaperFacade) {
    const base = api;
    window._PaperFacade = new Proxy(base, {
      get(t, prop) {
        const key = window._paperActiveEngine || 'papertrade';
        const eng = window.TabEngines.papertrade[key] || t;
        const v = eng[prop];
        return typeof v === 'function' ? v.bind(eng) : v;
      },
      set(t, prop, val) {
        const key = window._paperActiveEngine || 'papertrade';
        const eng = window.TabEngines.papertrade[key] || t;
        eng[prop] = val;
        return true;
      }
    });
    window.PaperTrade = window._PaperFacade;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  return api;
}
