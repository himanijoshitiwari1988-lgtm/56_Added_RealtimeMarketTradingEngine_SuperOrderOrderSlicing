(function () {
  'use strict';
  const ROWS = [
    { key: 'bull', color: '#00d4aa', label: 'BULL CE' },
    { key: 'bear', color: '#ff4d6a', label: 'BEAR PE' }
  ];
  const ALERT_MIN = -3, ALERT_MAX = 3;
  const CROSS_ABOVE = 'crossed_above', CROSS_BELOW = 'crossed_below';

  const instances = {};

  function defaults() {
    return {
      bull: { enabled: false, cond: CROSS_ABOVE, value: 0.8, side: 'CE' },
      bear: { enabled: false, cond: CROSS_BELOW, value: 0.2, side: 'PE' }
    };
  }
  function cloneCfg(cfg) {
    const d = defaults();
    const out = { bull: {}, bear: {} };
    ROWS.forEach(function (r) {
      const s = (cfg && cfg[r.key]) ? cfg[r.key] : {};
      out[r.key].enabled = !!s.enabled;
      out[r.key].cond = (s.cond === CROSS_BELOW) ? CROSS_BELOW : CROSS_ABOVE;
      out[r.key].value = (Number(s.value) >= ALERT_MIN && Number(s.value) <= ALERT_MAX) ? Number(s.value) : d[r.key].value;
      out[r.key].side = (s.side === 'PE' || s.side === 'CE') ? s.side : d[r.key].side;
    });
    return out;
  }
  function loadCfg(inst) {
    let out;
    try {
      const j = JSON.parse(localStorage.getItem(inst.cfgKey) || 'null');
      out = cloneCfg(j);
    } catch (e) { out = cloneCfg(null); }
    return out;
  }
  function saveCfg(inst) {
    try { localStorage.setItem(inst.cfgKey, JSON.stringify(inst.cfg || {})); } catch (e) {}
  }
  function loadDraft(inst) {
    try {
      const j = JSON.parse(localStorage.getItem(inst.draftKey) || 'null');
      if (j && (j.bull || j.bear)) return cloneCfg(j);
    } catch (e) {}
    return null;
  }
  function saveDraft(inst) {
    try { localStorage.setItem(inst.draftKey, JSON.stringify(inst.draft || {})); } catch (e) {}
  }
  function fmtV(v) {
    const n = Number(v);
    if (!isFinite(n)) return '--';
    return String(Math.round(n * 1000) / 1000);
  }
  function rowMeta(key) {
    for (let i = 0; i < ROWS.length; i++) if (ROWS[i].key === key) return ROWS[i];
    return ROWS[0];
  }
  function el(id) { return document.getElementById(id); }
  function toastMsg(msg) {
    let box = el('bbpToastBox');
    if (!box) {
      box = document.createElement('div');
      box.id = 'bbpToastBox';
      box.style.cssText = 'position:fixed;top:12px;right:12px;z-index:100000;display:flex;flex-direction:column;gap:6px;max-width:420px';
      document.body.appendChild(box);
    }
    const t = document.createElement('div');
    t.style.cssText = 'background:#1a1a35;border:1px solid #ffb300;border-left:3px solid #ffb300;color:#d0d0d0;padding:6px 10px;border-radius:4px;font-size:11px;box-shadow:0 4px 16px rgba(0,0,0,.5)';
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(function () {
      if (t.parentNode) t.parentNode.removeChild(t);
    }, 4000);
  }
  function chartOpts(host, height) {
    return {
      layout: { background: { color: '#0b0b1a' }, textColor: '#d0d0d0' },
      grid: { vertLines: { color: '#1a1a30' }, horzLines: { color: '#1a1a30' } },
      crosshair: { mode: 1 },
      rightPriceScale: { borderColor: '#2d2d50' },
      timeScale: { borderColor: '#2d2d50', timeVisible: true, secondsVisible: false },
      width: host.clientWidth || 600,
      height: height
    };
  }

  function attach(opts) {
    if (!opts || !opts.pfx) return null;
    if (instances[opts.pfx]) return instances[opts.pfx];
    const pfx = opts.pfx;
    const inst = {
      pfx: pfx,
      symbol: opts.symbol || { id: 13, exch: 'IDX_I', inst: 'INDEX', name: 'NIFTY 50' },
      tfGet: opts.tfGet || function () { return '5min'; },
      log: opts.log || null,
      onFire: opts.onFire || null,
      cfgKey: pfx + 'BbpAlertCfg',
      draftKey: pfx + 'BbpAlertDraft',
      enabledKey: pfx + 'BbpEnabled',
      cfg: null,
      draft: null,
      master: false,
      prev: null,
      lastPctt: null,
      lastFireAt: { bull: 0, bear: 0 },
      chart: null,
      series: null,
      guideLines: [],
      rowLines: []
    };
    inst.cfg = loadCfg(inst);
    inst.draft = loadDraft(inst) || cloneCfg(inst.cfg);
    inst.master = loadMaster(inst);
    instances[pfx] = inst;
    paint(inst);
    paintMaster(inst);
    syncEditor(inst);
    syncAlertBtn(inst);
    return inst;
  }

  function loadMaster(inst) {
    try { return localStorage.getItem(inst.enabledKey) === '1'; } catch (e) { return false; }
  }
  function paintMaster(inst) {
    const cb = el(inst.pfx + 'BbpEnabled');
    if (cb) cb.checked = inst.master;
    const chip = el(inst.pfx + 'BbpLive');
    if (chip) chip.style.borderColor = inst.master ? '#00d4aa' : '#4a3a10';
    const statusEl = el(inst.pfx + 'BbpStatus');
    if (statusEl) statusEl.style.borderLeft = inst.master ? '2px solid #00d4aa' : 'none';
  }
  function isEnabled(pfx) {
    const inst = instances[pfx];
    return !!(inst && inst.master);
  }
  function setEnabled(pfx, on) {
    const inst = attach({ pfx: pfx });
    if (!inst) return;
    inst.master = !!on;
    try { localStorage.setItem(inst.enabledKey, inst.master ? '1' : ''); } catch (e) {}
    paintMaster(inst);
    if (inst.log) inst.log(pfx.toUpperCase() + ' BB%b alert section ' + (inst.master ? 'ENABLED - naye entries ab BB%b alert signal ke baad hi lagegi' : 'DISABLED - BB%b gate off, engine normally trades'), inst.master ? 'ok' : 'warn');
  }
  function gateStatus(pfx) {
    const inst = instances[pfx];
    if (!inst) return { master: false };
    const last = (inst.lastPctt == null) ? null : Number(inst.lastPctt);
    function row(k) {
      const c = inst.cfg[k];
      const v = Number(c.value);
      let met = false;
      if (last != null && isFinite(v) && c.enabled) {
        met = (c.cond === CROSS_BELOW) ? (last <= v) : (last >= v);
      }
      return { enabled: !!c.enabled, cond: c.cond, value: v, met: met, valueText: fmtV(v) };
    }
    return {
      master: !!inst.master,
      last: last,
      lastText: (last == null) ? '--' : fmtV(last),
      bull: row('bull'),
      bear: row('bear')
    };
  }

  function rowSummary(row, s) {
    if (!s.enabled) return row.label + ' off';
    return row.label + ' ' + (s.cond === CROSS_BELOW ? 'below' : 'above') + ' ' + fmtV(s.value);
  }
  function paint(inst) {
    const statusEl = el(inst.pfx + 'BbpStatus');
    if (!statusEl) return;
    let active = 0, parts = [];
    ROWS.forEach(function (r) {
      const s = inst.cfg[r.key];
      parts.push('<span style="color:' + (s.enabled ? r.color : '#666') + '">' + rowSummary(r, s) + '</span>');
      if (s.enabled) active++;
    });
    statusEl.innerHTML = parts.join(' &nbsp;|&nbsp; ') || 'alerts off';
    statusEl.style.color = active ? '#ffd700' : '#777';
  }
  function paintLive(inst) {
    const chip = el(inst.pfx + 'BbpLive');
    if (!chip) return;
    chip.textContent = 'BB%b ' + (inst.lastPctt == null ? '--' : fmtV(inst.lastPctt));
    chip.title = 'NIFTY 50 Bollinger %B (current sample)';
  }
  function draftNote(inst) {
    const note = el(inst.pfx + 'BbpDraftNote');
    if (!note) return;
    const parts = ROWS.map(function (r) {
      const s = inst.draft[r.key];
      return '<span style="color:' + r.color + '">' + rowSummary(r, s) + (s.enabled ? ' <b style="color:#fff">(armed on SET)</b>' : '') + '</span>';
    });
    note.innerHTML = parts.join(' &nbsp;|&nbsp; ');
  }
  function syncEditorRow(inst, key) {
    const s = inst.draft[key];
    const en = el(inst.pfx + 'Bbp' + key[0].toUpperCase() + key.slice(1) + 'En');
    const cond = el(inst.pfx + 'Bbp' + key[0].toUpperCase() + key.slice(1) + 'Cond');
    const val = el(inst.pfx + 'Bbp' + key[0].toUpperCase() + key.slice(1) + 'Val');
    const side = el(inst.pfx + 'Bbp' + key[0].toUpperCase() + key.slice(1) + 'Side');
    if (en) en.checked = !!s.enabled;
    if (cond) cond.value = s.cond;
    if (val) val.value = s.value;
    if (side) side.value = s.side;
    [cond, val, side].forEach(function (c) { if (c) c.disabled = !s.enabled; });
    const wrap = el(inst.pfx + 'Bbp' + key[0].toUpperCase() + key.slice(1) + 'Wrap');
    if (wrap) wrap.style.opacity = s.enabled ? '1' : '0.55';
  }
  function syncEditor(inst) {
    ROWS.forEach(function (r) { syncEditorRow(inst, r.key); });
    draftNote(inst);
  }

  function editDraft(pfx, key, field, raw) {
    const inst = instances[pfx];
    if (!inst) return;
    const s = inst.draft[key];
    if (!s) return;
    if (field === 'enabled') s.enabled = !!raw;
    else if (field === 'cond') s.cond = (raw === CROSS_BELOW) ? CROSS_BELOW : CROSS_ABOVE;
    else if (field === 'side') s.side = (raw === 'PE') ? 'PE' : 'CE';
    else if (field === 'value') {
      const rawStr = String(raw == null ? '' : raw).trim();
      if (rawStr === '' || rawStr === '-' || rawStr === '+' || rawStr === '.') return;
      const v = parseFloat(rawStr);
      if (isFinite(v)) s.value = Math.min(ALERT_MAX, Math.max(ALERT_MIN, v));
      else s.value = (key === 'bear') ? 0.2 : 0.8;
    }
    saveDraft(inst);
    syncEditor(inst);
    if (inst.chart) rebuildRowLines(inst);
  }
  function arm(pfx) {
    const inst = instances[pfx];
    if (!inst) return;
    inst.cfg = cloneCfg(inst.draft);
    saveCfg(inst);
    paint(inst);
    if (inst.chart) rebuildRowLines(inst);
    if (inst.log) inst.log(pfx.toUpperCase() + ' BB%b alert SET: ' + ROWS.map(function (r) { return rowSummary(r, inst.cfg[r.key]); }).join(' | '), 'ok');
    toastMsg('BB%b alert armed: ' + ROWS.filter(function (r) { return inst.cfg[r.key].enabled; }).map(function (r) { return rowSummary(r, inst.cfg[r.key]); }).join(' | ') || 'none enabled');
  }

  function openEditor(pfx) {
    const inst = attach({ pfx: pfx });
    if (!inst) return;
    const box = el(pfx + 'BbpAlertBox');
    if (!box) return;
    const opening = box.style.display === 'none';
    box.style.display = opening ? 'flex' : 'none';
    if (opening) syncEditor(inst);
    syncAlertBtn(inst);
  }
  function closeEditor(pfx) {
    const box = el(pfx + 'BbpAlertBox');
    if (box) box.style.display = 'none';
    syncAlertBtn(attach({ pfx: pfx }));
  }
  function clearAlert(pfx) {
    const inst = instances[pfx];
    if (!inst) return;
    inst.cfg = defaults();
    inst.draft = defaults();
    saveCfg(inst);
    saveDraft(inst);
    paint(inst);
    syncEditor(inst);
    if (inst.chart) rebuildRowLines(inst);
    if (inst.log) inst.log(pfx.toUpperCase() + ' BB%b alerts cleared (all rows off)', 'warn');
    toastMsg('BB%b alerts removed - BULL CE & BEAR PE ab off hain');
  }
  function syncAlertBtn(inst) {
    if (!inst) return;
    const box = el(inst.pfx + 'BbpAlertBox');
    const btn = el(inst.pfx + 'BbpAlertBtn');
    if (!box || !btn) return;
    const open = box.style.display !== 'none';
    btn.textContent = open ? 'hide alerts' : '+ alert';
  }

  function reset(pfx) {
    const inst = instances[pfx];
    if (!inst) return;
    inst.prev = null;
    inst.lastPctt = null;
    paintLive(inst);
    if (inst.chart) renderPane(pfx);
  }

  function feed(pfx, live) {
    const inst = attach({ pfx: pfx });
    if (!inst || !live) return;
    const last = Number(live.pctb);
    if (!isFinite(last)) return;
    inst.lastPctt = last;
    paintLive(inst);
    const effTf = (typeof inst.tfGet === 'function') ? inst.tfGet() : '5min';
    if (inst.chart && inst.series && inst._lastDataTime && (effTf === '1min' || effTf === '5min')) {
      try { inst.series.update({ time: inst._lastDataTime, value: last }); } catch (e) {}
    }
    const prev = inst.prev;
    inst.prev = last;
    if (prev == null) return;
    ROWS.forEach(function (r) {
      const s = inst.cfg[r.key];
      if (!s || !s.enabled) return;
      const v = Number(s.value);
      if (!isFinite(v)) return;
      const fired = (s.cond === CROSS_BELOW) ? (prev > v && last <= v) : (prev < v && last >= v);
      if (!fired) return;
      if (Date.now() - inst.lastFireAt[r.key] < 5000) return;
      inst.lastFireAt[r.key] = Date.now();
      const msg = 'NIFTY BB%b ' + (s.cond === CROSS_BELOW ? 'CROSSED BELOW' : 'CROSSED ABOVE') + ' ' + fmtV(v) + ' -> ' + fmtV(last) + '  [' + (r.key === 'bull' ? 'BULLISH' : 'BEARISH') + ']';
      toastMsg(msg);
      if (inst.log) inst.log('[BB%b alert] FIRE ' + msg, 'warn');
      if (inst.onFire) {
        try { inst.onFire(r.key, cloneCfg({ bull: inst.cfg.bull, bear: inst.cfg.bear })[r.key], { pctb: last }); } catch (e) {}
      }
    });
  }

  function ensureChart(inst) {
    if (inst.chart) return inst.chart;
    const host = el(inst.pfx + 'BbpPane');
    if (!host || !window.LightweightCharts) return null;
    if (host.clientWidth < 2) return null;
    const chart = LightweightCharts.createChart(host, chartOpts(host, 110));
    const series = chart.addSeries(LightweightCharts.LineSeries, { color: '#ffb300', lineWidth: 1 });
    const style = { color: 'rgba(150,150,170,0.35)', lineStyle: 2, lineWidth: 1, axisLabelVisible: false, title: '' };
    try {
      inst.guideLines.push(series.createPriceLine(Object.assign({ price: 1 }, style)));
      inst.guideLines.push(series.createPriceLine(Object.assign({ price: 0 }, style)));
    } catch (e) {}
    inst.chart = chart;
    inst.series = series;
    return chart;
  }
  function rebuildRowLines(inst) {
    if (!inst.series) return;
    inst.rowLines.forEach(function (l) { try { inst.series.removePriceLine(l); } catch (e) {} });
    inst.rowLines = [];
    ROWS.forEach(function (r) {
      const s = inst.draft[r.key];
      if (!s || !s.enabled) return;
      try {
        inst.rowLines.push(inst.series.createPriceLine({
          price: Number(s.value),
          color: r.color,
          lineWidth: 1,
          lineStyle: 0,
          axisLabelVisible: true,
          title: r.label + ' ' + fmtV(s.value)
        }));
      } catch (e) {}
    });
  }
  function renderPane(pfx) {
    const inst = attach({ pfx: pfx });
    if (!inst) return;
    const chart = ensureChart(inst);
    if (!chart) return;
    const tf = inst.tfGet();
    const eff = (tf === '1min' || tf === '5min') ? tf : '5min';
    const tfEl = el(pfx + 'BbpPaneTf');
    if (tfEl) tfEl.textContent = eff + ' • BB(20,2)';
    const SE = window.StratEngine;
    if (!SE || !SE.fetchCandlesFor) return;
    const paneEl = el(inst.pfx + 'BbpPane');
    try { inst.chart.applyOptions({ width: (paneEl && paneEl.clientWidth) || 600 }); } catch (e) {}
    const days = eff === '1min' ? 1 : (eff === '5min' ? 3 : 5);
    SE.fetchCandlesFor(inst.symbol, eff, days).then(function (candles) {
      if (!Array.isArray(candles) || !candles.length || !inst.chart) {
        if (inst.series) { try { inst.series.setData([]); } catch (e) {} }
        return;
      }
      const def = (window.IndChart && IndChart.IND && IndChart.IND.bbpct) ? IndChart.IND.bbpct : null;
      if (!def) return;
      let out = null;
      try { out = def.compute(candles, { length: 20, mult: 2, smooth: 1, source: 'close', color: '#ffb300', lineWidth: 1 }); } catch (e) {}
      const o = out && out[0];
      if (!o) return;
      const data = (o.data || []).filter(function (d) { return d && d.value != null && isFinite(d.value); });
      try {
        inst.series.setData(data);
        inst._lastDataTime = data.length ? data[data.length - 1].time : null;
        if (data.length) inst.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, data.length - 130), to: data.length - 1 });
      } catch (e) {}
      rebuildRowLines(inst);
    });
  }
  function togglePane(pfx) {
    const inst = attach({ pfx: pfx });
    if (!inst) return;
    const wrap = el(pfx + 'BbpPaneWrap');
    const btn = el(pfx + 'BbpPaneBtn');
    if (!wrap) return;
    const opening = wrap.style.display === 'none';
    wrap.style.display = opening ? 'block' : 'none';
    if (btn) btn.textContent = opening ? 'pane: on' : 'pane: off';
    if (opening) {
      setTimeout(function () { renderPane(pfx); }, 30);
    }
  }
  function paneRefresh(pfx) {
    renderPane(pfx);
  }

  window.NiftyBbpAlert = {
    attach: attach,
    feed: feed,
    reset: reset,
    openEditor: openEditor,
    closeEditor: closeEditor,
    arm: arm,
    clearAlert: clearAlert,
    editDraft: editDraft,
    togglePane: togglePane,
    paneRefresh: paneRefresh,
    isEnabled: isEnabled,
    setEnabled: setEnabled,
    gateStatus: gateStatus
  };
})();
