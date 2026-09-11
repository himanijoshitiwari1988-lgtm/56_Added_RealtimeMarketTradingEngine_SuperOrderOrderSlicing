/* Dhan Algo - Realtime Trading Engine
 *
 * A duplicate of the AI Smart Trading engine that executes REAL Dhan orders
 * instead of paper trades. The whole AST UI (strategy picker, indicator
 * filters, strike / symbol universe, SL / trail / TP settings, templates,
 * running + closed tables) is cloned from the Paper Trade tab at runtime with
 * every element id suffixed "_realtime", and a dedicated AST instance is
 * created against that clone:
 *
 *     createAISmartTrading("_realtime", { executor: createRealtimeTrade(...) })
 *
 * The executor override makes the instance route all of its execution /
 * reconcile calls to the broker adapter below, so it never writes a paper
 * trade and never shows up in the paper ledgers. The Paper Trade engine and the
 * paper AST are left completely untouched.
 *
 * BROKER HOOKS (provided by static/realtimebroker.js - window.RealtimeBroker):
 *   placeEntry(side, opts)          -> { ok, orderId, entryPrice }
 *   placeExit(position, exitPrice)  -> { ok, exitPrice }
 *   getLtp(symbol)                  -> number
 *   lotSizeFor(symbol)              -> number
 *
 * The live path is DISARMED by default; while disarmed every entry is refused,
 * so the engine evaluates signals but cannot hit the market until the operator
 * presses ARM REAL on the Realtime tab.
 */
(function () {
  'use strict';

  /* Same position-key scheme as the AST engine's internal posKeyOf(), so the
     engine can find the bucket it just created in getState().autoPositions. */
  function symbolKey(sym) {
    if (!sym) return 'rt_' + Date.now();
    const id = (sym.id != null) ? sym.id : (sym.security_id != null ? sym.security_id : sym.sid);
    if (id == null) return 'rt_' + Date.now();
    return String(id) + ':' + (sym.exch || '');
  }
  function broker() { return window.RealtimeBroker || null; }

  window.createRealtimeTrade = function (suffix) {
    suffix = suffix || '';
    const KEY = 'algodhan_realtime_v1' + suffix;
    const state = { autoPositions: {}, closed: [], realized: 0, charges: 0 };
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (s && typeof s === 'object') {
        state.autoPositions = s.autoPositions || {};
        state.closed = Array.isArray(s.closed) ? s.closed : [];
        state.realized = Number(s.realized) || 0;
        state.charges = Number(s.charges) || 0;
      }
    } catch (e) {}
    function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} }
    function log(msg, level) {
      try { if (window.console && level === 'warn') console.warn('[Realtime' + (suffix || '') + '] ' + msg); else if (window.console) console.log('[Realtime' + (suffix || '') + '] ' + msg); } catch (e) {}
    }
    function livePrice(p) {
      try { if (typeof window.positionMarkPrice === 'function') { const m = window.positionMarkPrice(p); if (m != null) return m; } } catch (e) {}
      const b = broker();
      if (b && typeof b.getLtp === 'function') { try { const v = b.getLtp(p.symbol); if (v != null) return Number(v); } catch (e) {} }
      return p.entryPrice;
    }
    function recordClose(p, exitPrice, reason, qtyOverride) {
      const exit = Number(exitPrice != null ? exitPrice : p.entryPrice);
      const qty = Number(qtyOverride != null ? qtyOverride : (p.qty || 0));
      const gross = (p.side === 'SELL') ? (p.entryPrice - exit) * qty : (exit - p.entryPrice) * qty;
      const notional = Math.abs((p.entryPrice || 0) * qty);
      const rec = {
        side: p.side, symbol: p.symbol, symbolId: p.symbolId != null ? p.symbolId : null,
        symbolExch: p.symbolExch != null ? p.symbolExch : null,
        qty: qty, lotSize: p.lotSize, lots: p.lots,
        entry: p.entryPrice, exit: exit,
        pnl: gross, pnlPct: notional ? (gross / notional) * 100 : 0,
        netPnl: gross, charges: 0, reason: reason || 'Realtime exit',
        at: Date.now(), entryAt: p.openedAt != null ? p.openedAt : null
      };
      state.closed.unshift(rec);
      state.realized = (state.realized || 0) + gross;
      save();
      log('EXIT ' + rec.side + ' ' + (p.symbol || '') + ' @ ' + exit + '  qty=' + qty + '  pnl=' + gross.toFixed(2));
    }

    /* Per-key cooldown for app-side exits: a broker-rejected exit leaves the
       position in the ledger (correct - never orphan a live trade), but must
       not be re-sent every tick until the broker accepts it. */
    const _exitAt = {};
    const _EXIT_COOLDOWN = 3000;

    const api = {
      getState() { return state; },
      getCharges() { return true; },
      lotSizeFor(sym) {
        const b = broker();
        if (b && typeof b.lotSizeFor === 'function') { try { const v = b.lotSizeFor(sym); if (v != null) return Number(v); } catch (e) {} }
        return (sym && sym.lotSize) || 1;
      },
      autoEntry(side, opts) {
        opts = opts || {};
        const b = broker();
        if (!b || typeof b.placeEntry !== 'function') {
          log('broker not configured - entry skipped (' + (opts.key || '') + ')', 'warn');
          return false;
        }
        const key = symbolKey(opts.symbol);
        if (state.autoPositions[key]) return false;
        /* Lot size is always broker-resolved (AST universal lot stays "auto"). */
        let lotSize = Number(opts.lotSize) || api.lotSizeFor(opts.symbol) || 1;
        opts.lotSize = lotSize;
        const prePrice = Number((opts.symbol && opts.symbol.premium) || opts.fallbackLtp || 0);
        /* Auto Lots: decide lots from the strike's OI + volume liquidity, capped
           by the real Dhan margin. 0 lots (or a margin shortfall) means NO order
           - and a margin-required dialogue when margin is the binding limit. */
        if (window.RealtimeOrders && RealtimeOrders.autoLots && RealtimeOrders.autoLots()) {
          const a = (RealtimeOrders.calcAutoLots ? RealtimeOrders.calcAutoLots(lotSize, prePrice) : null) || {};
          if (a.lots == null) {
            log('auto lots: OI/volume + margin data nahi mila - manual lots use kiye', 'warn');
          } else if (a.lots < 1) {
            if (a.marginLots != null && a.marginLots < 1) {
              if (RealtimeOrders.showMarginRequired) RealtimeOrders.showMarginRequired(lotSize * prePrice, a.avail);
              log('auto lots: margin insufficient (' + (a.avail == null ? '--' : a.avail) + ') - order skip', 'warn');
            } else {
              log('auto lots: strike liquidity kam (vol=' + a.vol + ' oi=' + a.oi + ') - order skip', 'warn');
            }
            return false;
          } else {
            opts.lots = a.lots;
          }
        }
        let res = null;
        try { res = b.placeEntry(side, opts) || null; }
        catch (e) { log('placeEntry failed - ' + (e && e.message ? e.message : e), 'warn'); return false; }
        if (!res || res.ok === false) { log('entry rejected by broker', 'warn'); return false; }
        const entryPrice = Number(res.entryPrice != null ? res.entryPrice : (opts.fallbackLtp || 0));
        const lots = Number(opts.lots || 1);
        const sym = opts.symbol || {};
        /* Super-as-iceberg may place the order as several child orders; always
           book the qty that was ACTUALLY placed so a partial slice failure can
           never make us send an oversized exit leg. */
        const placedQty = (res.filledQty != null && Number(res.filledQty) > 0)
          ? Number(res.filledQty) : (lotSize * lots);
        const placedLots = (lotSize > 0 && placedQty > 0) ? Math.round(placedQty / lotSize) : lots;
        state.autoPositions[key] = {
          key: key, side: side,
          symbol: sym.name || sym.symbol || (opts.key || ''), symbolId: (sym.id != null ? sym.id : null),
          symbolExch: sym.exch || null, inst: sym.inst || null,
          lotSize: lotSize, lots: placedLots, qty: placedQty,
          margin: Number(opts.margin || 0),
          entryPrice: entryPrice, entry: entryPrice, peakPrice: entryPrice,
          targetPct: Number(opts.tpPct || 0), slPct: Number(opts.slPct || 0),
          slTrailPct: Number(opts.slTrailPct || 0), slTrailed: false,
          targetPrice: 0, stopLoss: 0, autoTrail: !!opts.autoTrail,
          orderType: 'MARKET', limitPrice: 0,
          tpPct: Number(opts.fixedTpPct || 0), tpPrice: 0, tpSrc: opts.tpSrc || '',
          orderId: res.orderId != null ? res.orderId : null,
          /* Multi-leg Super (iceberg-style slice): child order ids so the app
             can mirror/reconcile each self-protecting leg. */
          slices: Array.isArray(res.slices) ? res.slices : null,
          /* Execution method + broker-side protection. A REAL Dhan super order
             carries a native STOP_LOSS_LEG (trailing via trailingJump), so the
             app only mirrors that leg. A super entry that fell back to a plain
             market order has no broker SL, so the app-side risk loop must
             manage it like any other method (brokerTrail false). */
          method: res.method || null,
          brokerTrail: res.brokerTrail === true,
          superOrderId: (res.brokerTrail === true && res.orderId != null) ? res.orderId : null,
          brokerSlPrice: (res.stopLossPrice != null ? res.stopLossPrice : null),
          brokerTrailJump: (res.trailingJump != null ? res.trailingJump : null),
          brokerSlPct: (res.slPct != null ? res.slPct : null),
          brokerTrailPct: (res.trailPct != null ? res.trailPct : null),
          strategyId: opts.strategyId, strategyName: opts.strategyName,
          openedAt: Date.now()
        };
        save();
        log('ENTRY ' + side + ' ' + state.autoPositions[key].symbol + ' @ ' + entryPrice);
        return true;
      },
      autoExit(key, exitPrice, reason) {
        const p = state.autoPositions[key];
        if (!p) return false;
        const b = broker();
        /* Real broker path: a rejected exit order must NOT drop the position
           from the ledger (that would silently orphan a live Dhan position).
           Keep it and let the engine retry / surface the failure. */
        if (b && typeof b.placeExit === 'function') {
          let r = null;
          try { r = b.placeExit(p, exitPrice) || {}; }
          catch (e) { log('placeExit failed - ' + (e && e.message ? e.message : e), 'warn'); return false; }
          if (r.ok === false) { log('exit rejected by broker (' + (r.message || '') + ') - position kept', 'warn'); return false; }
          const fp = (exitPrice != null && exitPrice > 0) ? Number(exitPrice)
            : ((r.exitPrice != null) ? r.exitPrice : livePrice(p));
          recordClose(p, fp, reason);
          delete state.autoPositions[key];
          save();
          return true;
        }
        /* No broker configured: keep the old paper-style bookkeeping. */
        const fallback = (exitPrice != null && exitPrice > 0) ? Number(exitPrice) : livePrice(p);
        recordClose(p, fallback, reason);
        delete state.autoPositions[key];
        save();
        return true;
      },
      /* Book a position the BROKER already closed (e.g. a Dhan super order's
         native stop-loss / target leg triggered). No reverse order is sent -
         the exit already happened on Dhan. */
      bookClosed(key, exitPrice, reason) {
        const p = state.autoPositions[key];
        if (!p) return false;
        recordClose(p, (exitPrice != null && exitPrice > 0) ? Number(exitPrice) : livePrice(p), reason || 'Broker closed');
        delete state.autoPositions[key];
        save();
        return true;
      },
      /* Book ONE leg of a sliced (Super-as-iceberg) position the broker already
         closed: record that leg's qty and shrink the aggregate. The position is
         removed only when its last live leg is booked. No order is sent - each
         leg carries its own native Dhan stop/target. */
      bookPartial(key, qty, exitPrice, reason) {
        const p = state.autoPositions[key];
        if (!p) return false;
        let q = Number(qty) || 0;
        const remaining = Number(p.qty || 0);
        if (q <= 0) return false;
        if (q >= remaining) return api.bookClosed(key, exitPrice, reason);
        recordClose(p, (exitPrice != null && exitPrice > 0) ? Number(exitPrice) : livePrice(p), reason || 'Broker leg closed', q);
        p.qty = remaining - q;
        p.lots = (Number(p.lotSize) > 0) ? Math.round(p.qty / p.lotSize) : p.lots;
        save();
        return true;
      },
      /* ---- app-side risk manager (non-super methods) ----
         A real Dhan super order protects itself (native STOP_LOSS_LEG + target
         leg); those positions are skipped here and mirrored by RealtimeTrail.
         Every other method is ENTRY-ONLY on Dhan, so the app runs the full
         SL / trailing-SL / trailing-TP / fixed-TP lifecycle: ratchet the peak,
         re-derive the protection levels, and fire a reverse MARKET order the
         moment a level is breached. The hot path is pure arithmetic over an
         O(1) live-price cache - a full scan stays well under 2ms. Orders are
         only sent when a level actually triggers and are throttled per key so a
         rejected exit cannot spam Dhan. Returns the number of exits fired. */
      managePositions() {
        const now = Date.now();
        let acts = null;
        for (const key in state.autoPositions) {
          const p = state.autoPositions[key];
          if (!p || p.brokerTrail === true) continue;
          const cur = livePrice(p);
          if (!(cur > 0)) continue;
          const entry = Number(p.entryPrice) || 0;
          if (!(entry > 0)) continue;
          const isBuy = p.side !== 'SELL';
          let peak = Number(p.peakPrice) || entry;
          if (isBuy) { if (cur > peak) peak = cur; } else { if (cur < peak) peak = cur; }
          p.peakPrice = peak;
          let sl = 0;
          const slPct = Number(p.slPct) || 0;
          if (slPct > 0) sl = isBuy ? entry - entry * slPct / 100 : entry + entry * slPct / 100;
          const slTrail = Number(p.slTrailPct) || 0;
          if (slTrail > 0) {
            const pp = isBuy ? (peak - entry) : (entry - peak);
            if (pp > 0) {
              const tr = isBuy ? entry + pp * (1 - slTrail / 100) : entry - pp * (1 - slTrail / 100);
              if (isBuy ? tr > sl : (sl <= 0 || tr < sl)) { sl = tr; p.slTrailed = true; }
            }
          } else if (p.autoTrail && slPct > 0) {
            const cushion = entry * slPct / 100;
            if (cushion > 0 && (isBuy ? peak > entry : peak < entry)) {
              const rat = isBuy ? Math.max(peak - cushion, entry) : Math.min(peak + cushion, entry);
              if (isBuy ? rat > sl : (sl <= 0 || rat < sl)) { sl = rat; p.slTrailed = true; }
            }
          }
          p.stopLoss = sl;
          if (sl > 0 && (isBuy ? cur <= sl : cur >= sl)) {
            if (!acts) acts = [];
            acts.push([key, p, p.slTrailed ? 'Trailing SL hit' : 'Stop loss hit', sl]);
            continue;
          }
          const fixedTp = Number(p.tpPct) || 0;
          if (fixedTp > 0) {
            const tpx = isBuy ? entry * (1 + fixedTp / 100) : entry * (1 - fixedTp / 100);
            p.tpPrice = tpx;
            if (isBuy ? cur >= tpx : cur <= tpx) {
              if (!acts) acts = [];
              acts.push([key, p, (p.tpSrc || 'Take profit') + ' hit', tpx]);
              continue;
            }
          }
          const trailTp = Number(p.targetPct) || 0;
          if (trailTp > 0) {
            const pprof = isBuy ? (peak - entry) : (entry - peak);
            const tlevel = isBuy ? Math.max(entry + pprof * (1 - trailTp / 100), entry)
                                 : Math.min(entry - pprof * (1 - trailTp / 100), entry);
            p.targetPrice = tlevel;
            if (pprof > 0 && (isBuy ? cur <= tlevel : cur >= tlevel)) {
              if (!acts) acts = [];
              acts.push([key, p, 'Trailing target hit', tlevel]);
              continue;
            }
          } else {
            p.targetPrice = peak;
          }
        }
        if (!acts) return 0;
        let fired = 0;
        for (let i = 0; i < acts.length; i++) {
          const k = acts[i][0], pos = acts[i][1], reason = acts[i][2], px = acts[i][3];
          if (now - (_exitAt[k] || 0) < _EXIT_COOLDOWN) continue;
          _exitAt[k] = now;
          let done = false;
          try { done = api.autoExit(k, px, reason); } catch (e) { done = false; }
          if (done) { delete _exitAt[k]; fired++; }
        }
        return fired;
      },
      reset() { state.autoPositions = {}; state.closed = []; state.realized = 0; state.charges = 0; save(); }
    };

    if (!window.TabEngines) window.TabEngines = {};
    if (!window.TabEngines.realtime) window.TabEngines.realtime = {};
    window.TabEngines.realtime[suffix.replace(/^_/, '') || 'realtime'] = api;
    return api;
  };

  /* ---- Tab builder -------------------------------------------------------
     Clone the Paper Trade pane, strip the paper-only sections (Pooled Strategy
     Runner, AE template linker, ChartGrid switcher, PaperRun running lists),
     suffix every id with _realtime and keep the full AI Smart Trading UI. */
  window.RealtimeTab = {
    TAB: 'realtime',
    _built: false,
    build() {
      if (this._built) return;
      const src = document.getElementById('tab-papertrade');
      const placeholder = document.getElementById('tab-' + this.TAB);
      if (!src || !placeholder) return;
      const clone = src.cloneNode(true);
      clone.id = 'tab-' + this.TAB;
      clone.classList.remove('active');
      const sfx = '_' + this.TAB;
      clone.querySelectorAll('[id]').forEach(el => { el.id = el.id + sfx; });
      ['ptSubBar', 'ptHftSection', 'ptAeTplSection'].forEach(id => {
        const el = clone.querySelector('[id="' + id + sfx + '"]');
        if (el) el.remove();
      });
      /* Keep the "Running Strategies & Trades" block, but repoint its paper
         controls at the realtime renderer and relabel the two panels. */
      const runStrat = clone.querySelector('[id="ptRunStrategies' + sfx + '"]');
      if (runStrat) {
        const sec = runStrat.closest('.account-section');
        if (sec) {
          sec.querySelectorAll('button').forEach(function (b) {
            const oc = b.getAttribute('onclick') || '';
            if (oc.indexOf('PaperRun.closeAllTrades') >= 0) { b.textContent = 'Close All Trades'; b.setAttribute('onclick', 'RealtimeRun.closeAllTrades()'); }
            else if (oc.indexOf('PaperRun.closeAllStrategies') >= 0) { b.textContent = 'Stop All Strategies'; b.setAttribute('onclick', 'RealtimeRun.closeAllStrategies()'); }
            else if (oc.indexOf('PaperRun.refresh') >= 0) { b.textContent = 'Refresh'; b.setAttribute('onclick', 'RealtimeRun.render()'); }
          });
          sec.querySelectorAll('div').forEach(function (d) {
            if (d.children.length) return;
            const tx = (d.textContent || '').trim();
            if (tx === 'Running Trades') d.textContent = 'Running Trades (Dhan open positions)';
            else if (tx === 'Running Strategies / Indicator filter based trades') d.textContent = 'Running Strategies (Realtime engine)';
          });
        }
      }
      /* switchTab adds .active to the placeholder BEFORE calling build(), so the
         clone that replaces it must inherit that class - otherwise the tab shows
         blank until the user switches away and back. */
      const wasActive = placeholder.classList.contains('active');
      placeholder.replaceWith(clone);
      if (wasActive) clone.classList.add('active');
      this._built = true;
      this.ensureEngines();
      if (window.RealtimeOrders && RealtimeOrders.build) RealtimeOrders.build();
      this.consolidateEngineFields(sfx);
    },
    /* Consolidate the engine's Universal defaults + AI risk management fields
       into the Order Placement Method block (order section becomes the single
       control panel):
         - Fields the order section ALREADY controls (Lot size, Lots, Overall SL,
           Trail SL, Manual/AI-Trail TP) are hidden here but kept in the DOM, so
           the engine's own readUniversal()/applyUniversalToUI() keep working and
           the order section keeps writing through to them.
         - Fields the order section does NOT control (Margin, SL auto, 1/5 min,
           Multi-TF, Use AST settings, AI Stop-Loss, AI TP %, Manual Trail TP)
           are MOVED into the order block - ids are preserved so every inline
           handler and the engine continue to resolve them by id.
       Realtime tab only: paper tab DOM is untouched. */
    consolidateEngineFields(sfx) {
      const root = document.getElementById('tab-' + this.TAB);
      const block = document.getElementById('rtOrderMethods' + sfx);
      if (!root || !block) return;
      const inp = (id) => document.getElementById(id + sfx);
      const labelOf = (id) => { const e = inp(id); return e ? e.closest('label') : null; };
      const HIDE = ['astLotSize', 'astLots', 'astManualSL', 'astManualSLPct',
        'astManualTrailSL', 'astManualTrailSLPct', 'astManualTP', 'astManualTPPct', 'astAiTp'];
      const MOVE = ['astMargin', 'astSlAuto', 'astTf1min', 'astTf5min', 'astMtf',
        'astUseOwnSettings', 'astAiSl', 'astAiTP', 'astManualTrailTP', 'astManualTrailTPPct'];
      HIDE.forEach((id) => { const l = labelOf(id); if (l) l.style.display = 'none'; });
      const host = document.createElement('div');
      host.id = 'rtEngineExtra' + sfx;
      host.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:8px;border-top:1px dashed #4a4a80;padding-top:8px;font-size:12px';
      const cap = document.createElement('span');
      cap.style.cssText = 'color:#c4a9ff;font-weight:700;font-size:12px;white-space:nowrap';
      cap.textContent = 'Engine controls:';
      host.appendChild(cap);
      MOVE.forEach((id) => { const l = labelOf(id); if (l) { l.style.fontSize = '12px'; host.appendChild(l); } });
      block.appendChild(host);
      /* Tidy the now-empty "Universal defaults" header row (everything either
         moved or hidden) so it does not render as a blank line. */
      const urow = inp('astLotSize') ? inp('astLotSize').closest('.monitor-toolbar-row') : null;
      if (urow) {
        Array.prototype.forEach.call(urow.children, (ch) => {
          const tx = (ch.textContent || '').trim();
          if (ch.tagName === 'DIV' && /^Universal defaults:/.test(tx)) ch.style.display = 'none';
          else if (ch.tagName === 'SPAN' && /Trade live on 1 min/.test(tx)) ch.style.display = 'none';
        });
      }
    },
    ensureEngines() {
      if (!window.createRealtimeTrade || !window.createAISmartTrading) return;
      if (!window.TabEngines) window.TabEngines = {};
      if (!window.TabEngines.realtime) window.TabEngines.realtime = {};
      if (!window.TabEngines.aismart) window.TabEngines.aismart = {};
      if (window.TabEngines.aismart[this.TAB]) return;
      const sfx = '_' + this.TAB;
      let exec = window.TabEngines.realtime[this.TAB];
      if (!exec) exec = window.createRealtimeTrade(sfx);
      const ast = window.createAISmartTrading(sfx, { executor: exec, realtime: true });
      /* Master ON/OFF. Turning the realtime engine ON (AI Smart Trading button)
         arms the live broker after an explicit confirm; turning it OFF disarms
         and the engine hard-stops every loop. The broker also independently
         refuses orders while the engine is OFF, so no stale timer/bug can fire. */
      const _origToggleAuto = ast.toggleAuto;
      ast.toggleAuto = function () {
        const was = !!(ast.getState && ast.getState().enabled);
        if (!was) {
          if (!window.confirm('Realtime engine ON karein?\n\nLIVE Dhan orders (ARMED) enable ho jayenge.\nSirf OK dabao jab aap real trades chahte ho.')) return;
          if (window.RealtimeBroker) RealtimeBroker.arm();
        }
        _origToggleAuto.call(ast);
        const now = !!(ast.getState && ast.getState().enabled);
        if (!now && was && window.RealtimeBroker) RealtimeBroker.disarm();
      };
      if (ast.boot) ast.boot();
      if (ast.stopPoll) ast.stopPoll();
      if (ast.stopResearchPoll) ast.stopResearchPoll();
      /* A reload leaves the engine OFF; make sure the live broker is disarmed
         too so the button state and the real order gate never disagree. */
      try {
        const en = !!(ast.getState && ast.getState().enabled);
        if (!en && window.RealtimeBroker && RealtimeBroker.isArmed()) RealtimeBroker.disarm();
      } catch (e) {}
      /* App-side risk loop: trails the non-super methods and mirrors the super
         orders' broker-side SL/target. Hard-gated by engine ON + ARMED inside
         the tick, so it is a no-op until the operator goes live. */
      if (window.RealtimeTrail && RealtimeTrail.start) RealtimeTrail.start();
    }
  };
})();
