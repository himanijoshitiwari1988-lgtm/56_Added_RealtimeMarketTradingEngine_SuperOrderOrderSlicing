(function () {
  'use strict';
  const ROWS = [
    { key: 'bull', color: '#00d4aa', label: 'BULL CE' },
    { key: 'bear', color: '#ff4d6a', label: 'BEAR PE' }
  ];
  const ALERT_MIN = -3, ALERT_MAX = 3;
  const CROSS_ABOVE = 'crossed_above', CROSS_BELOW = 'crossed_below';
  const TREND_UP = 1, TREND_DOWN = -1, TREND_FLAT = 0;
  const LOGIC_VALUE = 'value', LOGIC_TREND = 'trend';

  const instances = {};

  function defaults() {
    return {
      bull: { enabled: false, cond: CROSS_ABOVE, value: 0.8, side: 'CE', logic: LOGIC_VALUE, trendDir: 'bullish' },
      bear: { enabled: false, cond: CROSS_BELOW, value: 0.2, side: 'PE', logic: LOGIC_VALUE, trendDir: 'bearish' }
    };
  }
  /* Run Window config: an optional second BB%b control that AUTO-STARTS /
     AUTO-STOPS the engine run between two BB%b levels:
       - ACTIVE line   : when BB%b crosses it the engine run becomes ACTIVE
                         (new entries allowed).
       - INACTIVE line : when BB%b crosses it the engine run becomes INACTIVE
                         (no new entries - open trades keep running).
     This mirrors the "two alert lines" idea: the strategy / Indicator-filters
     mode only runs in the window between the two crossings, stays inactive the
     rest of the time. */
  const WIN_ROWS = ['active', 'inactive'];
  function defaultsWin() {
    return {
      enabled: false,
      active: { enabled: true, cond: CROSS_ABOVE, value: 0.8, logic: LOGIC_VALUE, trendDir: 'bullish' },
      inactive: { enabled: true, cond: CROSS_BELOW, value: 0.2, logic: LOGIC_VALUE, trendDir: 'bearish' }
    };
  }
  function cloneWin(cfg) {
    const d = defaultsWin();
    const out = { enabled: !!(cfg && cfg.enabled), active: {}, inactive: {} };
    WIN_ROWS.forEach(function (k) {
      const s = (cfg && cfg[k]) ? cfg[k] : {};
      const defCond = (k === 'active') ? CROSS_ABOVE : CROSS_BELOW;
      const defTrend = (k === 'active') ? 'bullish' : 'bearish';
      out[k].enabled = (s.enabled === undefined) ? true : !!s.enabled;
      out[k].cond = (s.cond === CROSS_ABOVE || s.cond === CROSS_BELOW) ? s.cond : defCond;
      out[k].value = (Number(s.value) >= ALERT_MIN && Number(s.value) <= ALERT_MAX) ? Number(s.value) : d[k].value;
      out[k].logic = (s.logic === LOGIC_TREND) ? LOGIC_TREND : LOGIC_VALUE;
      out[k].trendDir = (s.trendDir === 'bearish' || s.trendDir === 'bullish') ? s.trendDir : defTrend;
    });
    return out;
  }
  function loadWin(inst) {
    let out;
    try {
      const j = JSON.parse(localStorage.getItem(inst.winKey) || 'null');
      out = cloneWin(j);
    } catch (e) { out = cloneWin(null); }
    return out;
  }
  function saveWin(inst) {
    try { localStorage.setItem(inst.winKey, JSON.stringify(inst.win || {})); } catch (e) {}
  }
  /* Per-direction manual ENGINE ACTIVE / INACTIVE latch. Independent of the
     BB%b alert gate + run window: each direction (bull = CE, bear = PE) has its
     own checkbox. Checked = that direction's engine works normally. Unchecked =
     that direction's engine is COMPLETELY inactive: no new entries of that side
     are placed (open trades keep running to their own SL / trail / TP). */
  function defaultsEngActive() { return { bull: true, bear: true }; }
  function cloneEngActive(cfg) {
    return {
      bull: !(cfg && cfg.bull === false),
      bear: !(cfg && cfg.bear === false)
    };
  }
  function loadEngActive(inst) {
    let out;
    try { out = cloneEngActive(JSON.parse(localStorage.getItem(inst.engActiveKey) || 'null')); }
    catch (e) { out = cloneEngActive(null); }
    return out;
  }
  function saveEngActive(inst) {
    try { localStorage.setItem(inst.engActiveKey, JSON.stringify(inst.engActive || {})); } catch (e) {}
  }
  function syncEngActiveUI(inst) {
    if (!inst) return;
    const ea = inst.engActive || defaultsEngActive();
    const bullOn = ea.bull !== false, bearOn = ea.bear !== false;
    const b = el(inst.pfx + 'BbpEngBull');
    if (b) b.checked = bullOn;
    const r = el(inst.pfx + 'BbpEngBear');
    if (r) r.checked = bearOn;
    const st = el(inst.pfx + 'BbpEngState');
    if (st) {
      if (!inst.master) {
        st.textContent = 'Engine: -- (BB%b Gate OFF)';
        st.style.color = '#777';
        st.title = 'BB%b section disabled (Gate checkbox OFF) - engine ACTIVE/INACTIVE latch poora inactive hai.';
      } else {
        st.textContent = 'Engine: BULL ' + (bullOn ? 'ACTIVE' : 'INACTIVE') + ' | BEAR ' + (bearOn ? 'ACTIVE' : 'INACTIVE');
        st.style.color = (bullOn && bearOn) ? '#00d4aa' : '#ef5350';
        st.title = 'Bullish engine ' + (bullOn ? 'ACTIVE' : 'INACTIVE (CE nayi entries band)') + ' - Bearish engine ' + (bearOn ? 'ACTIVE' : 'INACTIVE (PE nayi entries band)');
      }
    }
    const bb = el(inst.pfx + 'BbpEngBullWrap');
    if (bb) bb.style.opacity = bullOn ? '1' : '0.55';
    const bw = el(inst.pfx + 'BbpEngBearWrap');
    if (bw) bw.style.opacity = bearOn ? '1' : '0.55';
  }
  function setSideActive(pfx, side, on) {
    const inst = attach({ pfx: pfx });
    if (!inst) return;
    /* Gate OFF = whole BB%b section fully inactive: never change the latch,
       never toast, never log - just snap the checkbox back to its saved state.
       This kills the "gate off but still gets an engine ACTIVE/INACTIVE alert"
       report at the source. */
    if (!inst.master) { syncEngActiveUI(inst); return; }
    const k = (side === 'bear') ? 'bear' : 'bull';
    if (!inst.engActive) inst.engActive = defaultsEngActive();
    inst.engActive[k] = !!on;
    saveEngActive(inst);
    syncEngActiveUI(inst);
    const lab = (k === 'bear') ? 'Bearish (PE)' : 'Bullish (CE)';
    if (inst.log) inst.log(pfx.toUpperCase() + ' BB%b engine ' + lab + ' ' + (on ? 'ACTIVE - is direction ki nayi entries allow' : 'INACTIVE - is direction ki nayi entries band (open trades apne SL/TP/trail par chalti rahengi)'), on ? 'ok' : 'warn');
    toastMsg('BB%b engine ' + lab + ' ' + (on ? 'ACTIVE' : 'INACTIVE'));
  }
  function sideActiveStatus(pfx) {
    const inst = instances[pfx];
    if (!inst) return { bull: true, bear: true };
    /* Section master Gate checkbox OFF = the WHOLE BB%b section is disabled:
       the per-direction engine latch must NOT block anything then (same no-op
       rule as the BB%b alert gate + run window, which all require inst.master).
       Without this the manual OFF still blocked entries even though the user
       had turned the whole BB%b section off. */
    if (!inst.master) return { bull: true, bear: true };
    const ea = inst.engActive || defaultsEngActive();
    return { bull: ea.bull !== false, bear: ea.bear !== false };
  }
  /* Line-trend mode helpers. Each alert / run-window row can run in one of two
     LOGICS:
       - value mode (existing): the row reacts to the BB%b VALUE crossing a
         configured level (cond + value).
       - trend mode (new): the row reacts to the direction the BB%b pane LINE is
         moving. "Bullish" = the recent multi-bar slope points up (line upar ki
         or), "Bearish" = slope points down. The row fires on the edge that turns
         the line INTO the chosen direction and stays "met" while it keeps that
         direction (mirrors how value mode fires on a cross and stays met on the
         side). */
  function isTrend(s) { return !!(s && s.logic === LOGIC_TREND); }
  function trendForDir(d) { return (d === 'bearish') ? TREND_DOWN : TREND_UP; }
  function trendLabel(t) {
    if (t === TREND_UP) return 'Bullish (line up)';
    if (t === TREND_DOWN) return 'Bearish (line down)';
    return 'Flat';
  }
  function rowMetValue(s, last) {
    if (!s || !s.enabled || last == null) return false;
    const v = Number(s.value);
    if (!isFinite(v)) return false;
    return (s.cond === CROSS_BELOW) ? (last <= v) : (last >= v);
  }
  function rowMet(s, last, lastTrend) {
    if (!s || !s.enabled) return false;
    if (isTrend(s)) return lastTrend != null && lastTrend === trendForDir(s.trendDir);
    return rowMetValue(s, last);
  }
  function rowCrossed(s, prev, last, prevTrend, lastTrend) {
    if (!s || !s.enabled) return false;
    if (isTrend(s)) {
      if (prevTrend == null || lastTrend == null) return false;
      const want = trendForDir(s.trendDir);
      return lastTrend === want && prevTrend !== want;
    }
    const v = Number(s.value);
    if (!isFinite(v) || prev == null || last == null) return false;
    return (s.cond === CROSS_BELOW) ? (prev > v && last <= v) : (prev < v && last >= v);
  }
  function modeRuleText(s) {
    return isTrend(s) ? 'line ' + (s.trendDir === 'bearish' ? 'Bearish (down)' : 'Bullish (up)') : 'BB%b ' + (s.cond === CROSS_BELOW ? 'below' : 'above') + ' ' + fmtV(s.value);
  }
  function winRowSummary(k, s) {
    const lab = k === 'active' ? 'ACTIVE' : 'INACTIVE';
    if (!s.enabled) return lab + ' off';
    return lab + ' when ' + modeRuleText(s);
  }
  /* Seed the window state from the current sample when the window is switched
     on (or reset): if the ACTIVE boundary is already met (and the INACTIVE one
     is not) the run starts ACTIVE immediately, otherwise it stays INACTIVE and
     waits for the ACTIVE trigger. Works for both value and line-trend rows. */
  function seedWindowState(inst) {
    if (inst.lastPctt == null) { inst.winState = 'inactive'; return; }
    const last = Number(inst.lastPctt);
    const aMet = rowMet(inst.win.active, last, inst.lastTrend);
    const iMet = rowMet(inst.win.inactive, last, inst.lastTrend);
    inst.winState = (aMet && !iMet) ? 'active' : 'inactive';
  }
  function paintWindowChip(inst) {
    const chip = el(inst.pfx + 'BbpWinState');
    if (!chip) return;
    const w = inst.win;
    /* Section master checkbox OFF = whole BB%b section fully inactive: the chip
       must not show a misleading "RUN INACTIVE (waiting...)" because the window
       cannot block anything while the gate is off. */
    if (!inst.master) {
      chip.textContent = 'BB%b off';
      chip.style.color = '#777';
      chip.title = 'BB%b section disabled (Gate checkbox OFF) - RUN WINDOW aur alert dono inactive.';
      return;
    }
    if (!w.enabled) { chip.textContent = 'Run Win off'; chip.style.color = '#777'; return; }
    const st = inst.winState === 'active';
    chip.textContent = 'RUN ' + (st ? 'ACTIVE' : 'INACTIVE') + (st ? '' : ' (waiting BB%b ' + winRowSummary('active', w.active) + ')');
    chip.style.color = st ? '#00d4aa' : '#ef5350';
    chip.title = st
      ? 'Engine run ACTIVE - new entries allowed. BB%b ne ACTIVE line cross kar di hai.'
      : 'Engine run INACTIVE - no new entries until BB%b ACTIVE line cross ho. Open trades chalti rahengi.';
  }
  /* Fade helper for a VALUE segment: dims + disables its numeric controls when
     the row runs in trend (line) logic (the old value rule is inactive). The
     trend segment is faded by its caller WITHOUT disabling its checkbox so the
     user can always switch the mode. */
  function setSeg(segEl, on) {
    if (!segEl) return;
    segEl.style.opacity = on ? '1' : '0.35';
    const d = segEl.querySelectorAll('input,select,button');
    for (let i = 0; i < d.length; i++) d[i].disabled = !on;
  }
  function syncWinEditorRow(inst, k) {
    const s = inst.win[k];
    const X = (k === 'active' ? 'Act' : 'Ina');
    const en = el(inst.pfx + 'BbpWin' + X + 'En');
    const logic = el(inst.pfx + 'BbpWin' + X + 'Logic');
    const trend = el(inst.pfx + 'BbpWin' + X + 'Trend');
    const cond = el(inst.pfx + 'BbpWin' + X + 'Cond');
    const val = el(inst.pfx + 'BbpWin' + X + 'Val');
    if (en) en.checked = !!s.enabled;
    if (logic) logic.checked = isTrend(s);
    if (trend) trend.value = s.trendDir;
    if (cond) cond.value = s.cond;
    if (val) val.value = s.value;
    const on = !!s.enabled;
    const trendOn = on && isTrend(s);
    [cond, val].forEach(function (c) { if (c) c.disabled = !(on && !isTrend(s)); });
    if (logic) logic.disabled = !on;
    if (trend) trend.disabled = !trendOn;
    setSeg(el(inst.pfx + 'BbpWin' + X + 'ValSeg'), on && !isTrend(s));
    const trendSeg = el(inst.pfx + 'BbpWin' + X + 'TrendSeg');
    if (trendSeg) trendSeg.style.opacity = trendOn ? '1' : '0.35';
    const wrap = el(inst.pfx + 'BbpWin' + X + 'Wrap');
    if (wrap) wrap.style.opacity = on ? '1' : '0.55';
  }
  function syncWinEditor(inst) {
    /* Restore the "engine runs between ACTIVE & INACTIVE only" master switch
       from the persisted window config. Without this the switch renders
       unchecked on every page load / sync while inst.win.enabled stays true in
       storage, so the engine kept enforcing an INACTIVE window that the UI
       showed as OFF (the "gate off but still blocking" report). */
    const en = el(inst.pfx + 'BbpWinEn');
    if (en) en.checked = !!inst.win.enabled;
    WIN_ROWS.forEach(function (k) { syncWinEditorRow(inst, k); });
    paintWindowChip(inst);
  }
  function setWindowEnabled(pfx, on) {
    const inst = attach({ pfx: pfx });
    if (!inst) return;
    /* Gate OFF = section fully inactive: do not change the window nor log. */
    if (!inst.master) { syncWinEditor(inst); return; }
    inst.win.enabled = !!on;
    if (inst.win.enabled) seedWindowState(inst);
    saveWin(inst);
    syncWinEditor(inst);
    if (inst.log) inst.log(pfx.toUpperCase() + ' BB%b RUN WINDOW ' + (inst.win.enabled ? 'ON - engine run ab BB%b ACTIVE line par start & INACTIVE line par stop hogi' : 'OFF - normal BB%b alert gate hi apply hoga'), inst.win.enabled ? 'ok' : 'warn');
    redrawPaneLines(pfx);
  }
  function editWinDraft(pfx, k, field, raw) {
    const inst = instances[pfx];
    if (!inst) return;
    const s = inst.win[k];
    if (!s) return;
    if (field === 'enabled') s.enabled = !!raw;
    else if (field === 'logic') s.logic = (raw === LOGIC_TREND) ? LOGIC_TREND : LOGIC_VALUE;
    else if (field === 'trendDir') s.trendDir = (raw === 'bearish') ? 'bearish' : 'bullish';
    else if (field === 'cond') s.cond = (raw === CROSS_BELOW) ? CROSS_BELOW : CROSS_ABOVE;
    else if (field === 'value') {
      const rawStr = String(raw == null ? '' : raw).trim();
      if (rawStr === '' || rawStr === '-' || rawStr === '+' || rawStr === '.') return;
      const v = parseFloat(rawStr);
      if (isFinite(v)) s.value = Math.min(ALERT_MAX, Math.max(ALERT_MIN, v));
      else s.value = (k === 'inactive') ? 0.2 : 0.8;
    }
    saveWin(inst);
    syncWinEditor(inst);
    redrawPaneLines(pfx);
  }
  function windowReset(pfx) {
    const inst = instances[pfx];
    if (!inst) return;
    /* Section master checkbox OFF = the WHOLE BB%b section is fully inactive:
       a reset must not touch the window state nor log while the gate is off
       (the engine already ignores the window then, and the log would only
       confuse - "no entry until BB%b crosses" while the section is disabled). */
    if (!inst.master) return;
    if (!inst.win || !inst.win.enabled) return;
    inst.winState = 'inactive';
    if (inst.log) inst.log(pfx.toUpperCase() + ' BB%b RUN WINDOW state reset -> INACTIVE (nayi entries tab tak nahi jab tak BB%b ' + modeRuleText(inst.win.active) + ' trigger na ho)', 'warn');
    paintWindowChip(inst);
  }
  function windowStatus(pfx) {
    const inst = instances[pfx];
    if (!inst) return { enabled: false, state: 'inactive' };
    const state = inst.winState === 'active' ? 'active' : 'inactive';
    function row(k) {
      const s = inst.win[k];
      return {
        enabled: !!s.enabled,
        logic: (s.logic === LOGIC_TREND) ? LOGIC_TREND : LOGIC_VALUE,
        trendDir: (s.trendDir === 'bearish') ? 'bearish' : 'bullish',
        cond: s.cond,
        value: Number(s.value),
        valueText: fmtV(s.value),
        ruleText: modeRuleText(s)
      };
    }
    return {
      /* The window can only ever gate the engine while the WHOLE BB%b section
         master Gate is ON: a disabled section must never report an enforcing
         window (otherwise a stale INACTIVE window keeps the engine dormant
         even though the user turned the BB%b section off). */
      enabled: !!(inst.master && inst.win.enabled),
      state: state,
      last: (inst.lastPctt == null) ? null : Number(inst.lastPctt),
      lastText: (inst.lastPctt == null) ? '--' : fmtV(inst.lastPctt),
      trend: (inst.lastTrend == null) ? null : inst.lastTrend,
      trendText: (inst.lastTrend == null) ? 'line trend --' : 'line ' + trendLabel(inst.lastTrend),
      active: row('active'),
      inactive: row('inactive')
    };
  }
  /* Called from feed() with the fresh prev/last sample pair: toggles the window
     state when the ACTIVE or INACTIVE boundary is crossed (BB%b value in value
     mode, or the line turning into the chosen direction in trend mode). */
  function stepWindowState(inst, prev, last) {
    /* Master Gate OFF = whole BB%b section dormant: never advance the run
       window nor fire the ACTIVE/INACTIVE toast/log, even if a stale window
       switch was left ON. Defensive at the source (feed() already returns
       early) so no caller can resurrect the "gate off but engine run dialog
       still fires" behaviour. */
    if (!inst || !inst.master) return;
    if (!inst.win || !inst.win.enabled) return;
    const pTrend = inst.prevTrend, lTrend = inst.lastTrend;
    let next = null;
    if (rowCrossed(inst.win.active, prev, last, pTrend, lTrend)) next = 'active';
    if (rowCrossed(inst.win.inactive, prev, last, pTrend, lTrend)) next = 'inactive';
    if (!next) return;
    if (next !== inst.winState) {
      const from = inst.winState;
      inst.winState = next;
      const row = inst.win[next === 'active' ? 'active' : 'inactive'];
      const why = isTrend(row)
        ? 'BB%b line ' + (row.trendDir === 'bullish' ? 'Bullish (up)' : 'Bearish (down)') + (isFinite(last) ? ' @ ' + fmtV(last) : '')
        : 'BB%b ' + winRowSummary(next === 'active' ? 'active' : 'inactive', row) + ' @ ' + fmtV(last);
      const msg = 'NIFTY BB%b RUN ' + (next === 'active' ? 'ACTIVE' : 'INACTIVE') +
        ' - ' + why + '  [engine run ' + (next === 'active' ? 'start/allow' : 'stop/no new entries') + ']';
      toastMsg('BB%b ' + (next === 'active' ? 'RUN ACTIVE' : 'RUN INACTIVE'));
      if (inst.log) inst.log('[BB%b run window] ' + msg, next === 'active' ? 'ok' : 'warn');
      if (next === 'inactive' && from === 'active') {
        toastMsg('Engine run INACTIVE - nayi entries band (open trades chalti rahengi). Wapas ACTIVE ke liye ' + winRowSummary('active', inst.win.active) + '.');
      }
      paintWindowChip(inst);
    }
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
      out[r.key].logic = (s.logic === LOGIC_TREND) ? LOGIC_TREND : LOGIC_VALUE;
      out[r.key].trendDir = (s.trendDir === 'bearish' || s.trendDir === 'bullish') ? s.trendDir : d[r.key].trendDir;
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
      localization: {
        timeFormatter: function (ts) {
          if (window.IST12 && IST12.fmtCandle) return IST12.fmtCandle(ts, false);
          const d = new Date(ts * 1000);
          const h = d.getUTCHours();
          const m = String(d.getUTCMinutes()).padStart(2, '0');
          const ap = h >= 12 ? 'PM' : 'AM', h12 = h % 12 || 12;
          return h12 + ':' + m + ' ' + ap;
        }
      },
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
      winKey: pfx + 'BbpWinCfg',
      engActiveKey: pfx + 'BbpEngActive',
      cfg: null,
      draft: null,
      master: false,
      win: null,
      engActive: null,
      winState: 'inactive',
      prev: null,
      lastPctt: null,
      lastFireAt: { bull: 0, bear: 0 },
      trendBuf: [],
      prevTrend: null,
      lastTrend: null,
      chart: null,
      series: null,
      guideLines: [],
      rowLines: [],
      winLines: []
    };
    inst.cfg = loadCfg(inst);
    inst.draft = loadDraft(inst) || cloneCfg(inst.cfg);
    inst.master = loadMaster(inst);
    inst.win = loadWin(inst);
    inst.engActive = loadEngActive(inst);
    seedWindowState(inst);
    instances[pfx] = inst;
    paint(inst);
    paintMaster(inst);
    paintWindowChip(inst);
    syncEditor(inst);
    syncWinEditor(inst);
    syncEngActiveUI(inst);
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
    /* Section master Gate OFF = whole BB%b section (alert + run window) is not
       enforced. Fade the RUN-WINDOW box so the user can see nothing in it is
       active, even if the window switch itself was left ON. */
    const winBox = el(inst.pfx + 'BbpWinBox');
    if (winBox) winBox.style.opacity = inst.master ? '1' : '0.45';
    /* The per-direction ENGINE ACTIVE/INACTIVE latch is part of the same BB%b
       section: fade it too so it is obvious it enforces nothing while the
       master Gate is OFF. */
    const engBox = el(inst.pfx + 'BbpEngBox');
    if (engBox) engBox.style.opacity = inst.master ? '1' : '0.45';
    /* Make the whole run-window + engine-latch area truly INACTIVE (disabled
       inputs), so a gate-OFF section cannot even be clicked into firing an
       "engine ON/OFF" toast or flipping a latch. */
    setSectionInputsDisabled(inst, !inst.master);
    /* Repaint the two status readouts that describe the engine state. Without
       this a Gate toggle left them stale: turning the Gate OFF really stopped
       every block helper (entry engine trades normally) but the run-window chip
       kept showing "RUN INACTIVE (waiting...)" and the engine latch kept showing
       "Engine: BULL/BEAR INACTIVE", so the box looked like the engine was still
       dormant. paintWindowChip + syncEngActiveUI both branch on inst.master, so
       they render "BB%b off" / "Engine: -- (BB%b Gate OFF)" the moment it is off. */
    paintWindowChip(inst);
    syncEngActiveUI(inst);
  }
  function isEnabled(pfx) {
    const inst = instances[pfx];
    return !!(inst && inst.master);
  }
  /* Gate checkbox OFF = the WHOLE BB%b section is fully INACTIVE: every control
     inside the run-window box and the per-direction engine-latch box is
     disabled (not merely faded), so no click can fire an "engine ACTIVE /
     INACTIVE" toast / log while the gate is off. The Gate checkbox itself, the
     show/hide-alerts button and the pane button live in the top bar and stay
     usable so the user can turn the section back on. */
  function setSectionInputsDisabled(inst, disabled) {
    if (!inst) return;
    ['BbpWinBox', 'BbpEngBox', 'BbpAlertBox'].forEach(function (bid) {
      const box = el(inst.pfx + bid);
      if (!box) return;
      const ctrls = box.querySelectorAll('input, select, button, textarea');
      for (let i = 0; i < ctrls.length; i++) ctrls[i].disabled = !!disabled;
    });
  }
  function setEnabled(pfx, on) {
    const inst = attach({ pfx: pfx });
    if (!inst) return;
    inst.master = !!on;
    try { localStorage.setItem(inst.enabledKey, inst.master ? '1' : ''); } catch (e) {}
    paintMaster(inst);
    /* Re-enabling the section: reset the firing baseline (value + line trend)
       and re-seed the run window from the CURRENT sample, so re-enabling
       mid-move never fires a stale cross/turn and the window chip reflects
       where BB%b sits right now. */
    if (inst.master) {
      inst.prev = null;
      inst.trendBuf = [];
      inst.prevTrend = null;
      inst.lastTrend = null;
      if (inst.win && inst.win.enabled) seedWindowState(inst);
      paintWindowChip(inst);
    }
    if (inst.log) inst.log(pfx.toUpperCase() + ' BB%b alert section ' + (inst.master ? 'ENABLED - naye entries ab BB%b alert signal ke baad hi lagegi' : 'DISABLED - BB%b gate off, engine normally trades'), inst.master ? 'ok' : 'warn');
  }
  function gateStatus(pfx) {
    const inst = instances[pfx];
    if (!inst) return { master: false };
    const last = (inst.lastPctt == null) ? null : Number(inst.lastPctt);
    function row(k) {
      const c = inst.cfg[k];
      const met = rowMet(c, last, inst.lastTrend);
      return {
        enabled: !!c.enabled,
        logic: (c.logic === LOGIC_TREND) ? LOGIC_TREND : LOGIC_VALUE,
        trendDir: (c.trendDir === 'bearish') ? 'bearish' : 'bullish',
        cond: c.cond,
        value: Number(c.value),
        met: met,
        valueText: fmtV(c.value),
        ruleText: modeRuleText(c)
      };
    }
    return {
      master: !!inst.master,
      last: last,
      lastText: (last == null) ? '--' : fmtV(last),
      trend: (inst.lastTrend == null) ? null : inst.lastTrend,
      trendText: (inst.lastTrend == null) ? 'line trend --' : 'line ' + trendLabel(inst.lastTrend),
      bull: row('bull'),
      bear: row('bear')
    };
  }

  function rowSummary(row, s) {
    if (!s.enabled) return row.label + ' off';
    if (isTrend(s)) return row.label + ' line ' + (s.trendDir === 'bearish' ? 'Bearish (down)' : 'Bullish (up)');
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
    const X = key[0].toUpperCase() + key.slice(1);
    const en = el(inst.pfx + 'Bbp' + X + 'En');
    const logic = el(inst.pfx + 'Bbp' + X + 'Logic');
    const trend = el(inst.pfx + 'Bbp' + X + 'Trend');
    const cond = el(inst.pfx + 'Bbp' + X + 'Cond');
    const val = el(inst.pfx + 'Bbp' + X + 'Val');
    const side = el(inst.pfx + 'Bbp' + X + 'Side');
    if (en) en.checked = !!s.enabled;
    if (logic) logic.checked = isTrend(s);
    if (trend) trend.value = s.trendDir;
    if (cond) cond.value = s.cond;
    if (val) val.value = s.value;
    if (side) side.value = s.side;
    const on = !!s.enabled;
    if (logic) logic.disabled = !on;
    if (trend) trend.disabled = !(on && isTrend(s));
    if (side) side.disabled = !on;
    [cond, val].forEach(function (c) { if (c) c.disabled = !(on && !isTrend(s)); });
    setSeg(el(inst.pfx + 'Bbp' + X + 'ValSeg'), on && !isTrend(s));
    const trendSeg = el(inst.pfx + 'Bbp' + X + 'TrendSeg');
    if (trendSeg) trendSeg.style.opacity = (on && isTrend(s)) ? '1' : '0.35';
    const wrap = el(inst.pfx + 'Bbp' + X + 'Wrap');
    if (wrap) wrap.style.opacity = on ? '1' : '0.55';
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
    else if (field === 'logic') s.logic = (raw === LOGIC_TREND) ? LOGIC_TREND : LOGIC_VALUE;
    else if (field === 'trendDir') s.trendDir = (raw === 'bearish') ? 'bearish' : 'bullish';
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
    redrawPaneLines(pfx);
  }
  function arm(pfx) {
    const inst = instances[pfx];
    if (!inst) return;
    inst.cfg = cloneCfg(inst.draft);
    saveCfg(inst);
    paint(inst);
    redrawPaneLines(pfx);
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
    if (opening) { paintMaster(inst); syncEditor(inst); syncEngActiveUI(inst); }
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
    redrawPaneLines(pfx);
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

  /* BB%b LINE TREND engine. The BB%b pane line only "moves" when a fresh
     sample arrives, so the trend is read from a small ring of the last distinct
     samples the feed produced (RING_N = 12 => a multi-bar slope over ~12 line
     points). A least-squares slope over the ring decides the direction; a
     relative dead-band keeps flat/noise readings from flipping the arrow. The
     whole step is O(RING_N) and stays far under the 5ms budget. */
  const RING_N = 12, RING_MIN = 4;
  function ringTrend(buf) {
    if (!buf || buf.length < RING_MIN) return null;
    const n = buf.length;
    let sx = 0, sy = 0, sxy = 0, sxx = 0, lo = buf[0], hi = buf[0];
    for (let i = 0; i < n; i++) {
      const y = buf[i], x = i + 1;
      sx += x; sy += y; sxy += x * y; sxx += x * x;
      if (y < lo) lo = y;
      else if (y > hi) hi = y;
    }
    const den = n * sxx - sx * sx;
    if (!den) return TREND_FLAT;
    const slope = (n * sxy - sx * sy) / den;
    const span = (hi - lo) || 0.05;
    /* Relative dead-band: need a slope clearly larger than the noise floor of
       the ring so a stationary / micro-wiggling line reads FLAT, not a trend. */
    const thr = Math.max(0.0015, (span * 0.08) / (n - 1));
    if (slope > thr) return TREND_UP;
    if (slope < -thr) return TREND_DOWN;
    return TREND_FLAT;
  }
  /* Push a fresh feed sample into the ring (identical consecutive samples are
     skipped - the line has not moved - so the ring holds real moves only) and
     advance the prev/last trend pair used for edge detection. */
  function ingestTrendSample(inst, v) {
    const b = inst.trendBuf;
    if (b.length && b[b.length - 1] === v) return;
    inst.prevTrend = inst.lastTrend;
    b.push(v);
    if (b.length > RING_N) b.shift();
    inst.lastTrend = ringTrend(b);
  }
  /* Compass arrow at the mouth of the BB%b pane line: points up while the line
     is trending Bullish, down while Bearish, disappears when Flat / unknown. */
  function applyArrow(inst, dir, time) {
    if (!inst || !inst.series || time == null) return;
    let markers = [];
    if (dir === TREND_UP || dir === TREND_DOWN) {
      markers = [{
        time: time,
        position: dir === TREND_UP ? 'aboveBar' : 'belowBar',
        shape: dir === TREND_UP ? 'arrowUp' : 'arrowDown',
        color: dir === TREND_UP ? '#00d4aa' : '#ef5350'
      }];
    }
    try { inst.series.setMarkers(markers); } catch (e) {}
  }
  function paintArrowFromData(inst, data) {
    if (!inst || !inst.series) return;
    if (!data || data.length < RING_MIN) { try { inst.series.setMarkers([]); } catch (e) {} return; }
    const from = Math.max(0, data.length - RING_N);
    const tail = [];
    for (let i = from; i < data.length; i++) tail.push(Number(data[i].value));
    const t = ringTrend(tail);
    /* Seed the live-line ring with the SAME rendered history the arrow uses.
       The live feed only produces one distinct BB%b sample per bar, so without
       this the ring needs ~RING_MIN bars before it can report a trend: the pane
       arrow showed Bullish/Bearish while the engine gate (rowMet -> lastTrend)
       still read null/Flat and blocked BOTH sides. Seeding makes the gate agree
       with the line the user actually sees, then live samples keep it fresh. */
    inst.trendBuf = tail.slice();
    inst.lastTrend = t;
    applyArrow(inst, t, data[data.length - 1].time);
  }

  function reset(pfx) {
    const inst = instances[pfx];
    if (!inst) return;
    inst.prev = null;
    inst.lastPctt = null;
    inst.trendBuf = [];
    inst.prevTrend = null;
    inst.lastTrend = null;
    /* A timeframe change restarts the BB%b history: re-arm the run window to
       dormant/INACTIVE until the ACTIVE trigger happens again on the new TF. */
    if (inst.win && inst.win.enabled) seedWindowState(inst);
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
    /* Section master checkbox OFF = the whole BB%b section is disabled: keep the
       value readout live but fire NO alert / run-window transitions (a disabled
       section must never keep signalling the engine or flipping the window). */
    if (!inst.master) { inst.prev = last; return; }
    /* Line-trend ring is fed from every gated sample; the pane value + compass
       arrow follow the same samples. */
    ingestTrendSample(inst, last);
    if (inst.chart && inst.series && inst._lastDataTime && (effTf === '1min' || effTf === '5min' || effTf === '15min')) {
      try { inst.series.update({ time: inst._lastDataTime, value: last }); } catch (e) {}
      applyArrow(inst, inst.lastTrend, inst._lastDataTime);
    }
    const prev = inst.prev;
    inst.prev = last;
    if (prev == null) return;
    /* Run window: advance the ACTIVE/INACTIVE latch from the same fresh sample
       pair the BB%b alert rows use. Runs before the per-row alert firing so the
       window chip/state reflect this tick even when an alert also fires. */
    stepWindowState(inst, prev, last);
    ROWS.forEach(function (r) {
      const s = inst.cfg[r.key];
      if (!s || !s.enabled) return;
      let fired = false;
      let what = '';
      if (isTrend(s)) {
        fired = rowCrossed(s, prev, last, inst.prevTrend, inst.lastTrend);
        what = 'LINE TURNED ' + trendLabel(inst.lastTrend) + ' (was ' + trendLabel(inst.prevTrend) + ')';
      } else {
        const v = Number(s.value);
        if (!isFinite(v)) return;
        fired = (s.cond === CROSS_BELOW) ? (prev > v && last <= v) : (prev < v && last >= v);
        what = (s.cond === CROSS_BELOW ? 'CROSSED BELOW' : 'CROSSED ABOVE') + ' ' + fmtV(v) + ' -> ' + fmtV(last);
      }
      if (!fired) return;
      if (Date.now() - inst.lastFireAt[r.key] < 5000) return;
      inst.lastFireAt[r.key] = Date.now();
      const msg = 'NIFTY BB%b ' + r.label + ' ' + what + '  [' + (s.trendDir === 'bearish' || r.key === 'bear' ? 'BEARISH' : 'BULLISH') + ']';
      toastMsg(msg);
      if (inst.log) inst.log('[BB%b alert] FIRE ' + msg, 'warn');
      if (inst.onFire) {
        try { inst.onFire(r.key, cloneCfg({ bull: inst.cfg.bull, bear: inst.cfg.bear })[r.key], { pctb: last, trend: inst.lastTrend }); } catch (e) {}
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
      /* Trend (line) rows have no numeric level - their signal is the line
         direction (arrow), so no horizontal value line is drawn for them. */
      if (isTrend(s)) return;
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
  /* RUN WINDOW ACTIVE / INACTIVE levels drawn on the pane. These follow
     inst.win (the config the engine gates on) and redraw live while the
     ACTIVE/INACTIVE numbers are edited, so the pair of green/red lines always
     shows where the run window really sits on the BB%b scale. */
  function rebuildWinLines(inst) {
    if (!inst.series) return;
    inst.winLines.forEach(function (l) { try { inst.series.removePriceLine(l); } catch (e) {} });
    inst.winLines = [];
    if (!inst.win || !inst.win.enabled) return;
    WIN_ROWS.forEach(function (k) {
      const s = inst.win[k];
      if (!s || !s.enabled) return;
      /* Line-trend window rows react to the BB%b line direction, not a numeric
         level, so no horizontal window line is drawn for them. */
      if (isTrend(s)) return;
      try {
        inst.winLines.push(inst.series.createPriceLine({
          price: Number(s.value),
          color: (k === 'active') ? '#00d4aa' : '#ef5350',
          lineWidth: 2,
          lineStyle: 0,
          axisLabelVisible: true,
          title: (k === 'active' ? 'ACTIVE' : 'INACTIVE') + ' ' + fmtV(s.value)
        }));
      } catch (e) {}
    });
  }
  function rebuildPaneLines(inst) {
    rebuildRowLines(inst);
    rebuildWinLines(inst);
  }
  /* Redraw the pane lines after an edit. If the chart is live, refresh the
     price lines in place. If the pane is open but no chart exists yet (e.g. it
     was rendered by a stale/detached instance) kick renderPane so the current
     draft value lands on the visible lines immediately instead of silently
     doing nothing. */
  function redrawPaneLines(pfx) {
    const inst = instances[pfx];
    if (!inst) return;
    if (inst.series) { rebuildPaneLines(inst); return; }
    const w = el(pfx + 'BbpPaneWrap');
    if (w && w.style.display === 'block') { try { renderPane(pfx); } catch (e) {} }
  }
  function renderPane(pfx) {
    const inst = attach({ pfx: pfx });
    if (!inst) return;
    const chart = ensureChart(inst);
    if (!chart) return;
    const tf = inst.tfGet();
    const eff = (tf === '1min' || tf === '5min' || tf === '15min') ? tf : '5min';
    const tfEl = el(pfx + 'BbpPaneTf');
    if (tfEl) tfEl.textContent = eff + ' • BB(20,2)';
    const SE = window.StratEngine;
    if (!SE || !SE.fetchCandlesFor) return;
    const paneEl = el(inst.pfx + 'BbpPane');
    try { inst.chart.applyOptions({ width: (paneEl && paneEl.clientWidth) || 600 }); } catch (e) {}
    const days = eff === '1min' ? 1 : (eff === '5min' ? 3 : (eff === '15min' ? 7 : 5));
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
      rebuildPaneLines(inst);
      /* Direction arrow at the line mouth from the rendered series itself. */
      paintArrowFromData(inst, data);
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
    gateStatus: gateStatus,
    setWindowEnabled: setWindowEnabled,
    editWinDraft: editWinDraft,
    windowReset: windowReset,
    windowStatus: windowStatus,
    setSideActive: setSideActive,
    sideActiveStatus: sideActiveStatus
  };
})();
