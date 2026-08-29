/* Market-Off Candle Simulator (frontend module)
   ------------------------------------------------------------------
   Runs the server-side /api/sim/* simulator and renders its live candle
   stream on the Simulator tab. While running it continuously injects a live
   quote for the synthetic symbol (SIM / 900001) into the shared clientQuotes
   store, so the paper-trade / AI Smart Trading engines see a real-time price
   and can keep opening, managing and closing paper positions even when the
   real market is closed.
   ------------------------------------------------------------------ */
(function () {
  const SIM_ID = 900001;
  const SIM_EXCH = 'SIM';
  const SIM_NAME = 'SIM CHART';
  const POLL_MS = 900;
  const TF_OPTIONS = [['1min', '1m'], ['5min', '5m']];

  let chart = null;
  let candleSeries = null;
  let volSeries = null;
  let pollTimer = null;
  let running = false;
  let visible = false;
  let lastBarTime = 0;
  let lastQuote = null;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function statusLabel(st) {
    if (!st || !st.running) return 'STOPPED';
    const c = st.config || {};
    const trend = c.trend === 'bullish' ? 'Bullish' : (c.trend === 'bearish' ? 'Bearish' : 'Range');
    return 'RUNNING · ' + trend + ' · ' + (c.timeframe || '1min') + ' · LTP ' + (st.ltp != null ? Number(st.ltp).toFixed(2) : '--');
  }

  function setStatus(text, cls) {
    const el = $('simStatus');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = cls || (running ? '#00d4aa' : '#e67e22');
  }

  function buildChart() {
    const host = $('simChartContainer');
    if (!host || !window.LightweightCharts) return null;
    if (chart) { try { chart.remove(); } catch (e) {} chart = null; }
    chart = LightweightCharts.createChart(host, {
      layout: { background: { color: '#0b0b1a' }, textColor: '#d0d0d0' },
      grid: { vertLines: { color: '#1a1a30' }, horzLines: { color: '#1a1a30' } },
      crosshair: { mode: 1 },
      rightPriceScale: { borderColor: '#2d2d50' },
      timeScale: { borderColor: '#2d2d50', timeVisible: true, secondsVisible: false },
      localization: {
        timeFormatter: function (ts) {
          const d = new Date(ts * 1000);
          const h = d.getUTCHours(), m = String(d.getUTCMinutes()).padStart(2, '0');
          const ampm = h >= 12 ? 'PM' : 'AM', h12 = h % 12 || 12;
          return h12 + ':' + m + ' ' + ampm;
        }
      },
      width: host.clientWidth || 900,
      height: host.clientHeight || 460,
      autoSize: true
    });
    candleSeries = chart.addSeries(LightweightCharts.CandlestickSeries, {
      upColor: '#00d4aa', downColor: '#ef5350', borderVisible: false,
      wickUpColor: '#00d4aa', wickDownColor: '#ef5350'
    });
    volSeries = chart.addSeries(LightweightCharts.HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
      lastValueVisible: false, priceLineVisible: false
    });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    try { chart.timeScale().fitContent(); } catch (e) {}
    return chart;
  }

  function resize() {
    if (chart) { try { chart.applyOptions({ width: $('simChartContainer').clientWidth || 900, height: $('simChartContainer').clientHeight || 460 }); } catch (e) {} }
  }

  function renderCandles(candles) {
    if (!candleSeries || !candles || !candles.length) return;
    const tf = ($('simTf') && $('simTf').value) || '1min';
    const chartCandles = candles.filter(c => c && c.time != null && c.open != null);
    const patch = [];
    for (let i = 0; i < chartCandles.length; i++) {
      const c = chartCandles[i];
      const t = Math.floor(Number(c.time));
      const item = { time: t, open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close) };
      const vitem = { time: t, value: Number(c.volume) || 0, color: Number(c.close) >= Number(c.open) ? 'rgba(0,212,170,0.35)' : 'rgba(239,83,80,0.35)' };
      if (i === chartCandles.length - 1) {
        // Forming candle: patch in place if the bar time is unchanged.
        if (t === lastBarTime) { try { candleSeries.update(item); volSeries.update(vitem); } catch (e) {} }
        else {
          try { candleSeries.update(item); volSeries.update(vitem); } catch (e) {}
          try { chart.timeScale().scrollToRealTime(); } catch (e) {}
        }
        lastBarTime = t;
      } else {
        patch.push(item);
        patch.push(vitem);
      }
    }
    if (patch.length) {
      try {
        candleSeries.setData(patch.filter(p => p.high !== undefined));
        volSeries.setData(patch.filter(p => p.value !== undefined));
      } catch (e) {}
    }
  }

  function injectQuote(st) {
    if (!st || !st.ltp) return;
    const candlesQ = lastCandles || [];
    const last = candlesQ.length ? candlesQ[candlesQ.length - 1] : null;
    const prevClose = st.prev_close != null ? Number(st.prev_close) : (last ? Number(last.open) : Number(st.ltp));
    const ltp = Number(st.ltp);
    const change = ltp - prevClose;
    const changePct = prevClose ? (change / prevClose) * 100 : 0;
    const at = (typeof serverNowSec === 'function') ? serverNowSec() : Math.floor(Date.now() / 1000);
    const q = { ltp, close: prevClose, change, change_pct: changePct, at, live: true, exch: SIM_EXCH, name: SIM_NAME, source: 'sim' };
    try { if (typeof clientQuotes !== 'undefined') clientQuotes[String(SIM_ID)] = q; } catch (e) {}
    lastQuote = q;
  }

  let lastCandles = [];
  async function poll() {
    try {
      const st = await fetch('/api/sim/status').then(r => r.json());
      running = !!(st && st.running);
      setStatus(statusLabel(st));
      if (!running) { if (visible) lastBarTime = 0; return; }
      const tf = ($('simTf') && $('simTf').value) || '1min';
      const body = JSON.stringify({ timeframe: tf });
      const d = await fetch('/api/sim/candles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).then(r => r.json());
      if (d && d.status === 'success' && Array.isArray(d.data)) {
        lastCandles = d.data;
        injectQuote(Object.assign({}, st, { prev_close: d.prev_close }));
        if (visible) renderCandles(d.data);
      } else {
        injectQuote(st);
      }
    } catch (e) {
      setStatus('Simulator unavailable', '#ef5350');
    }
  }

  function startPoll() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(poll, POLL_MS);
    poll();
  }

  async function start() {
    const body = {
      trend: ($('simTrend') && $('simTrend').value) || 'bullish',
      timeframe: ($('simTf') && $('simTf').value) || '1min',
      base: Number(($('simBase') && $('simBase').value) || 24000),
      volatility: Number(($('simVol') && $('simVol').value) || 0.0008),
      speed: Number(($('simSpeed') && $('simSpeed').value) || 20)
    };
    try {
      const r = await fetch('/api/sim/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json());
      if (r && r.status === 'success') {
        running = true;
        lastBarTime = 0;
        startPoll();
        setStatus(statusLabel(r), '#00d4aa');
      } else {
        setStatus('Failed to start: ' + (r && r.message ? r.message : 'unknown'), '#ef5350');
      }
    } catch (e) {
      setStatus('Failed to start simulator', '#ef5350');
    }
  }

  async function stop() {
    try { await fetch('/api/sim/stop', { method: 'POST' }).then(r => r.json()); } catch (e) {}
    running = false;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    setStatus('STOPPED', '#e67e22');
  }

  /* Auto-start the simulator (used by AI Smart Trading's Simulation Chart
     toggle so the engines always have a live synthetic feed). */
  async function ensureRunning() {
    const st = await fetch('/api/sim/status').then(r => r.json()).catch(() => null);
    if (st && st.running) {
      running = true;
      startPoll();
      return;
    }
    await start();
  }

  function onShow() {
    visible = true;
    if (!chart) buildChart();
    resize();
    poll();
  }
  function onHide() { visible = false; }

  /* Tab initialisation - wire the controls. */
  function init() {
    const btn = $('simStartBtn');
    if (btn) btn.onclick = () => { if (running) stop(); else start(); };
    const tfSel = $('simTf');
    if (tfSel && !tfSel.options.length) {
      TF_OPTIONS.forEach(([v, l]) => {
        const o = document.createElement('option');
        o.value = v; o.textContent = l; tfSel.appendChild(o);
      });
      tfSel.value = '1min';
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.Simulator = { init, start, stop, poll, onShow, onHide, resize, ensureRunning, isRunning: () => running, SIM_ID, SIM_NAME };
})();
