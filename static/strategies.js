/* Dhan Algo - Indicator Based Strategy system
 * Builder (sidebar) + saved strategies + realtime evaluation engine.
 * Strategies reference indicators deployed on the candlestick chart and evaluate
 * their realtime readings against candles of the chosen timeframe, then compute
 * option strikes (relative to ATM) and lot quantity from OI/Volume percentage. */
(function () {
  'use strict';

  const SAVED_KEY = 'algodhan_strategies_v1';
  const ACTIVE_KEY = 'algodhan_active_strategies_v1';
  const ASSIGN_KEY = 'algodhan_strategy_assignments_v1';

  const LOGIC_OPS = [
    ['gt', 'Greater than'],
    ['lt', 'Less than'],
    ['gte', 'Greater than or equal'],
    ['lte', 'Less than or equal'],
    ['eq', 'Equal to'],
    ['neq', 'Not equal to'],
    ['crossAbove', 'Crossed above'],
    ['crossBelow', 'Crossed below'],
    ['andFirst', 'And with first logic']
  ];

  const STRIKE_MODES = [
    ['above', 'Above ATM'],
    ['below', 'Below ATM'],
    ['both_atm', 'Above & below ATM'],
    ['above_atm', 'Above including ATM'],
    ['below_atm', 'Below including ATM'],
    ['both_atm_inc', 'Above & below including ATM']
  ];

  const STRAT_TF = [['1min', '1m'], ['5min', '5m'], ['15min', '15m'], ['30min', '30m'],
                    ['1hour', '1h'], ['4hour', '4h'], ['day', 'D'], ['year', 'Y']];

  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* fetch() with an AbortController timeout so a hanging candle request (Dhan
     gateway stall) rejects instead of leaving the experiment run blocked on a
     promise that never settles. The caller treats a rejection as "no data". */
  const fetchWithTimeout = (url, opts, ms) => new Promise((resolve, reject) => {
    const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timer = setTimeout(() => ctrl && ctrl.abort(), ms || 90000);
    fetch(url, Object.assign({}, opts, ctrl ? { signal: ctrl.signal } : {}))
      .then(resolve, reject)
      .then(() => clearTimeout(timer));
  });

  function defaultStrategy() {
    return {
      id: 'strat-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      name: '',
      symbol: (typeof selectedSymbol !== 'undefined' && selectedSymbol) ? JSON.parse(JSON.stringify(selectedSymbol)) : null,
      tf: '5min',
      entry: { indId: '', indSettings: {}, indValue: '', valueKey: 'v0', logic: 'gt', cmpType: 'number', cmpIndId: '', cmpSettings: {}, cmpIndValue: '', cmpValueKey: 'v0', candleKey: 'close', number: 0, gap: { enabled: false, pair: [], st: [], band: [] } },
      exit: { indId: '', indSettings: {}, indValue: '', valueKey: 'v0', logic: 'lt', cmpType: 'candle', candleKey: 'close', cmpIndId: '', cmpSettings: {}, cmpIndValue: '', cmpValueKey: 'v0', number: 0, candlePatterns: [], gap: { enabled: false, pair: [], st: [], band: [] } },
      strike: { mode: 'both_atm', count: 3, includeAtm: false, optionType: 'both' },
      lot: { auto: true, basis: 'OI', pct: 1, manualQty: 1 },
      gate: { enabled: false, conds: [], patterns: [] },
      candlestick: { enabled: false, entry: [], exit: [] },
      indexConfirmation: { enabled: false, indices: [], strategyId: null },
      gateStatus: null,
      createdAt: Date.now()
    };
  }

  /* ---------------- engine ---------------- */
  const engine = {
    POLL_MS: 1500,
    /* Candle data is fetched with force:1 so the server refetches from Dhan
       every time. A 1.5s TTL meant every monitor tick AND every strategy tick
       re-hit /api/candles for the same symbol, which is the main driver of the
       DH-904 rate-limit storms seen in the logs. Candle bars only advance at
       their timeframe boundary (1min/5min...), so a 5s TTL is still
       effectively live while cutting the historical-surface load ~3x. */
    CANDLE_TTL_MS: 5000,
    /* Index strategies resolve the option chain per symbol. The OC surface is
       server-throttled to 1 req/3s and the chain (strikes/greeks) does not
       change between ticks, so re-fetching it every 3s is pure waste. */
    CHAIN_TTL_MS: 10000,
    running: new Map(),
    candleCache: {},
    ocCache: {},

    isIndex(symbol) {
      return symbol && (symbol.exch === 'IDX_I' || symbol.inst === 'INDEX');
    },

    getLegs(st) {
      if (st.cat === 'bullish') return ['CE'];
      if (st.cat === 'bearish') return ['PE'];
      if (st.strike.optionType === 'both') return ['CE', 'PE'];
      return [st.strike.optionType];
    },

    settingsFor(indId) {
      const deps = window.IndChart ? IndChart.getDeployedIndicators() : [];
      const ind = deps.find(i => i.id === indId);
      return ind ? JSON.parse(JSON.stringify(ind.settings)) : {};
    },

    start(strategy) {
      if (this.running.has(strategy.id)) return;
      this.autoDeployIndicators(strategy);
      const state = {
        id: strategy.id,
        strategy: JSON.parse(JSON.stringify(strategy)),
        timer: null,
        inPosition: false,
        candles: [],
        expiry: null,
        enteredLegs: [],
        lastReads: { entry: null, exit: null },
        entrySig: window.CrossDetector ? CrossDetector.createSignal() : null,
        exitSig: window.CrossDetector ? CrossDetector.createSignal() : null,
        _indexLegs: null
      };
      this.running.set(strategy.id, state);
      StratUI.setStatus(strategy.id, 'Running');
      this.beginPoll(state);
    },

    autoDeployIndicators(strategy) {
      if (!window.IndChart || !IndChart.addIndicator) return;
      const toDeploy = new Set();
      if (strategy.entry && strategy.entry.indId) toDeploy.add(strategy.entry.indId);
      if (strategy.entry && strategy.entry.cmpType === 'indicator' && strategy.entry.cmpIndId) toDeploy.add(strategy.entry.cmpIndId);
      if (strategy.entry && strategy.entry.paneCond && strategy.entry.paneCond.indId) toDeploy.add(strategy.entry.paneCond.indId);
      if (strategy.entry && strategy.entry.paneConds && strategy.entry.paneConds.length) {
        strategy.entry.paneConds.forEach(p => { if (p && p.indId) toDeploy.add(p.indId); });
      }
      if (strategy.entry && strategy.entry.paneMove && strategy.entry.paneMove.indId) toDeploy.add(strategy.entry.paneMove.indId);
      if (strategy.entry && strategy.entry.paneMoves && strategy.entry.paneMoves.length) {
        strategy.entry.paneMoves.forEach(pm => { if (pm && pm.indId) toDeploy.add(pm.indId); });
      }
      if (strategy.exit && strategy.exit.indId) toDeploy.add(strategy.exit.indId);
      if (strategy.exit && strategy.exit.cmpType === 'indicator' && strategy.exit.cmpIndId) toDeploy.add(strategy.exit.cmpIndId);
      if (strategy.exit && strategy.exit.paneCond && strategy.exit.paneCond.indId) toDeploy.add(strategy.exit.paneCond.indId);
      if (strategy.exit && strategy.exit.paneConds && strategy.exit.paneConds.length) {
        strategy.exit.paneConds.forEach(p => { if (p && p.indId) toDeploy.add(p.indId); });
      }
      toDeploy.forEach(id => {
        if (!IndChart.isDeployed(id)) IndChart.addIndicator(id);
      });
    },

    beginPoll(state) {
      this.tick(state);
      state.timer = setInterval(() => this.tick(state), this.POLL_MS);
    },

    stop(id) {
      const state = this.running.get(id);
      if (state) { clearInterval(state.timer); this.running.delete(id); }
      StratUI.setStatus(id, 'Stopped');
    },

    async stopTrade(id) {
      const state = this.running.get(id);
      if (!state) { StratUI.log(id, 'Strategy not running', 'warn'); return; }
      if (state._indexLegs) {
        const active = Object.values(state._indexLegs).filter(l => l.inPosition);
        if (!active.length) { StratUI.log(id, 'No open strategy position to square off', 'warn'); return; }
        StratUI.log(id, 'Manual STOP TRADE - squaring off all strategy legs', 'exit');
        for (const l of active) {
          StratUI.log(id, `SELL ${l.strike} ${l.leg} qty=${l.qty}`, 'trade');
          const res = await this.placeOrder(l, 'SELL', l.qty);
          StratUI.log(id, 'Square-off order: ' + JSON.stringify(res.data || res), 'trade');
          l.inPosition = false;
        }
        StratUI.setStatus(id, 'Running');
        return;
      }
      if (!state.inPosition) { StratUI.log(id, 'No open strategy position to square off', 'warn'); return; }
      StratUI.log(id, 'Manual STOP TRADE - squaring off all strategy legs', 'exit');
      for (const leg of state.enteredLegs) {
        StratUI.log(id, `SELL ${leg.strike} ${leg.leg} qty=${leg.qty}`, 'trade');
        const res = await this.placeOrder(leg, 'SELL', leg.qty);
        StratUI.log(id, 'Square-off order: ' + JSON.stringify(res.data || res), 'trade');
      }
      state.enteredLegs = [];
      state.inPosition = false;
      StratUI.setStatus(id, 'Running');
    },

    async tick(state) {
      if (state.busy) return;
      state.busy = true;
      const st = state.strategy;
      try {
        if (this.isIndex(st.symbol)) {
          await this.indexTick(state);
        } else {
          await this.equityTick(state);
        }
      } catch (e) {
        StratUI.log(state.id, 'Tick error: ' + (e && e.message ? e.message : e), 'warn');
      } finally {
        state.busy = false;
      }
    },

    async equityTick(state) {
      const st = state.strategy;
      const candles = await this.fetchCandles(st);
      if (!candles || candles.length < 3) return;
      state.candles = candles;

      const gateOk = this.evalGate(st.gate || {}, candles);
      if (st.gate && st.gate.enabled) {
        const newStatus = gateOk ? 'running' : 'blocked';
        if (st.gateStatus !== newStatus) {
          st.gateStatus = newStatus;
          StratUI.setGateStatus(state.id, newStatus);
          StratUI.log(state.id, 'Gate: ' + (gateOk ? 'Strategy allowed to run' : 'STRATEGY BLOCKED - consolidation / liquidity grab detected'), gateOk ? 'entry' : 'warn');
        }
        if (!gateOk) return;
      }

      const entryEdge = this.evalCondEdge(st.entry, candles, state.entrySig);
      const exitEdge = (st.exit && st.exit.indId) ? this.evalCondEdge(st.exit, candles, state.exitSig) : false;
      const entryGap = this.evalGap((st.entry && st.entry.gap) || {}, candles);
      const exitGap = this.evalGap((st.exit && st.exit.gap) || {}, candles);

      state.lastReads = { entry: entryEdge, exit: exitEdge };
      const candleEntryOk = this.evalCandlestick(st.candlestick || {}, candles);
      const candleExitSig = this.evalCandlestickExit(st.candlestick || {}, candles);
      StratUI.updateReadings(state.id, st, candles);

      if (!state.inPosition) {
        const canEnter = entryEdge && ((!st.entry.gap || !st.entry.gap.enabled) || entryGap) && candleEntryOk;
        if (canEnter) {
          const icOk = await this.indexConfirmationOk(state);
          if (icOk) await this.executeEntry(state);
        }
      } else {
        const exitCondMet = exitEdge && ((!st.exit.gap || !st.exit.gap.enabled) || exitGap);
        if (this.signalExitAllowed(st) && (exitCondMet || candleExitSig)) await this.executeExit(state);
      }
    },

    async indexTick(state) {
      const st = state.strategy;
      let icOk = true;
      if (st.indexConfirmation && st.indexConfirmation.enabled) {
        icOk = await this.indexConfirmationOk(state);
      }
      const chain = await this.fetchChain(state);
      const atm = this.findAtm(chain.records, chain.spot);
      if (atm == null) return;

      let gateCandles = null;
      if (st.gate && st.gate.enabled) {
        try {
          gateCandles = await this.fetchCandles(st);
        } catch (e) {}
        if (gateCandles && gateCandles.length >= 10) {
          const gateOk = this.evalGate(st.gate, gateCandles);
          const newStatus = gateOk ? 'running' : 'blocked';
          if (st.gateStatus !== newStatus) {
            st.gateStatus = newStatus;
            StratUI.setGateStatus(state.id, newStatus);
            StratUI.log(state.id, 'Gate: ' + (gateOk ? 'Strategy allowed to run' : 'STRATEGY BLOCKED - consolidation / liquidity grab detected'), gateOk ? 'entry' : 'warn');
          }
          if (!gateOk) return;
        }
      }

      const strikes = this.computeStrikes(chain.records, atm, st.strike);
      const legs = this.getLegs(st);
      if (!state._indexLegs) state._indexLegs = {};
      let anyReading = false;
      for (const s of strikes) {
        for (const leg of legs) {
          const lk = s + '_' + leg;
          let lstate = state._indexLegs[lk];
          if (!lstate) {
            const row = this.findChainRow(chain.records, s);
            if (!row) continue;
            const basisVal = Number(st.lot.basis === 'OI' ? row[leg + ' OI'] : row[leg + ' Volume']) || 0;
            const qty = st.lot.auto ? this.lotFromPct(basisVal, st.lot.pct) : Math.max(1, Math.round(Number(st.lot.manualQty) || 0));
            if (!qty) continue;
            let sec;
            try { sec = await this.resolveOptionSecurity(st, chain.expiry, s, leg); } catch (e) { sec = null; }
            /* Fallback: the option chain row carries the security id of each leg,
               use it when the API resolution fails so the right strike is still traded. */
            if (!sec && row) {
              const sid = leg === 'CE' ? row['CE SID'] : row['PE SID'];
              if (sid) {
                sec = {
                  security_id: parseInt(sid),
                  exchange_segment: (st.symbol && st.symbol.ocExch === 'BSE_FNO') ? 'BSE_FNO' : 'NSE_FNO',
                  instrument_type: symbolUnderlyingIsIndex(st.symbol) ? 'OPTIDX' : 'OPTSTK',
                  trading_symbol: ((st.symbol && st.symbol.name) || '') + ' ' + s.toFixed(0) + ' ' + leg
                };
              }
            }
            if (!sec) continue;
            lstate = {
              entrySig: window.CrossDetector ? CrossDetector.createSignal() : null,
              exitSig: window.CrossDetector ? CrossDetector.createSignal() : null,
              inPosition: false,
              security_id: sec.security_id,
              exchange_segment: sec.exchange_segment,
              instrument_type: sec.instrument_type || 'OPTIDX',
              trading_symbol: sec.trading_symbol,
              strike: s, leg, qty
            };
            state._indexLegs[lk] = lstate;
          }
          let candles;
          try {
            candles = await this.fetchOptionCandles(lstate.security_id, lstate.exchange_segment, lstate.instrument_type || 'OPTIDX', st.tf);
          } catch (e) { continue; }
          if (!candles || candles.length < 3) continue;
          lstate.candles = candles;
          const entryEdge = this.evalCondEdge(st.entry, candles, lstate.entrySig);
          const exitEdge = (st.exit && st.exit.indId) ? this.evalCondEdge(st.exit, candles, lstate.exitSig) : false;
          const entryGap = this.evalGap((st.entry && st.entry.gap) || {}, candles);
          const exitGap = this.evalGap((st.exit && st.exit.gap) || {}, candles);
          const candleEntryOk = this.evalCandlestick(st.candlestick || {}, candles);
          const candleExitSig = this.evalCandlestickExit(st.candlestick || {}, candles);
          anyReading = true;
          if (!lstate.inPosition) {
            const canEnter = entryEdge && ((!st.entry.gap || !st.entry.gap.enabled) || entryGap) && candleEntryOk && icOk;
            if (canEnter) {
              StratUI.log(state.id, 'ENTRY ' + lstate.strike + ' ' + lstate.leg + ' [option premium chart]', 'entry');
              const res = await this.placeOrder(lstate, 'BUY', lstate.qty);
              StratUI.log(state.id, 'Order: ' + JSON.stringify(res.data || res), 'trade');
              lstate.inPosition = true;
              if (lstate.entrySig && lstate.entrySig.reset) lstate.entrySig.reset();
            }
          } else {
            const exitCondMet = exitEdge && ((!st.exit.gap || !st.exit.gap.enabled) || exitGap);
            if (this.signalExitAllowed(st) && (exitCondMet || candleExitSig)) {
              StratUI.log(state.id, 'EXIT ' + lstate.strike + ' ' + lstate.leg + ' [option premium chart]', 'exit');
              const res = await this.placeOrder(lstate, 'SELL', lstate.qty);
              StratUI.log(state.id, 'Exit order: ' + JSON.stringify(res.data || res), 'trade');
              lstate.inPosition = false;
              if (lstate.exitSig && lstate.exitSig.reset) lstate.exitSig.reset();
            }
          }
        }
      }
      if (anyReading) {
        const inPos = Object.values(state._indexLegs).filter(l => l.inPosition).length;
        StratUI.setStatus(state.id, inPos > 0 ? 'In position (' + inPos + ' leg' + (inPos > 1 ? 's' : '') + ')' : 'Running');
      }
    },

    async fetchOptionCandles(securityId, exchangeSegment, instrumentType, tf) {
      const key = securityId + ':' + tf;
      const cached = this.candleCache[key];
      const now = Date.now();
      if (cached && now - cached.at < this.CANDLE_TTL_MS) return cached.candles;
      const d = await fetch('/api/candles', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ security_id: securityId, exchange_segment: exchangeSegment, instrument_type: instrumentType, timeframe: tf, force: 1 })
      }).then(r => r.json());
      if (d && d.status === 'success' && d.data && d.data.length) {
        this.candleCache[key] = { at: Date.now(), candles: d.data };
        return d.data;
      }
      if (cached) return cached.candles;
      return [];
    },

    /* Normalize a condition (or a chain) into CrossDetector source descriptors:
       [{ a: src, logic, b: src }, ...]. Empty condition -> empty chain (false). */
    toChain(cond) {
      if (!cond) return [];
      if (!cond.indId && cond.cmpType !== 'candlestick_pattern') return [];
      const mk = (indId, settings, key) => ({ type: 'ind', id: indId, settings: settings || {}, key: key || 'v0' });
      const a = mk(cond.indId, cond.indSettings, cond.valueKey);
      const selfKey = cond.cmpType === 'plot' ? 'v0' : (cond.cmpType === 'smoothed' ? 'v1' : null);
      let b;
      if (cond.cmpType === 'number') b = { type: 'number', value: Number(cond.number) || 0 };
      else if (cond.cmpType === 'candle') b = { type: 'candle', key: cond.candleKey || 'close' };
      else if (cond.cmpType === 'candlestick_pattern') b = { type: 'candlestick_pattern', patterns: cond.candlePatterns || [] };
      else if (cond.cmpType === 'paneLine') b = mk(cond.indId, cond.indSettings, cond.paneLineB);
      else if (selfKey) b = mk(cond.indId, cond.indSettings, selfKey);
      else b = mk(cond.cmpIndId, cond.cmpSettings, cond.cmpValueKey);
      const chain = [{ a, logic: cond.logic, b }];
      if (Array.isArray(cond.chain)) {
        cond.chain.forEach(c => {
          if (!c) return;
          if (!c.indId && c.cmpType !== 'candlestick_pattern') return;
          const a2 = mk(c.indId, c.indSettings, c.valueKey);
          const cSelfKey = c.cmpType === 'plot' ? 'v0' : (c.cmpType === 'smoothed' ? 'v1' : null);
          let b2;
          if (c.cmpType === 'number') b2 = { type: 'number', value: Number(c.number) || 0 };
          else if (c.cmpType === 'candle') b2 = { type: 'candle', key: c.candleKey || 'close' };
          else if (c.cmpType === 'candlestick_pattern') b2 = { type: 'candlestick_pattern', patterns: c.candlePatterns || [] };
          else if (c.cmpType === 'paneLine') b2 = mk(c.indId, c.indSettings, c.paneLineB);
          else if (cSelfKey) b2 = mk(c.indId, c.indSettings, cSelfKey);
          else b2 = mk(c.cmpIndId, c.cmpSettings, c.cmpValueKey);
          chain.push({ a: a2, logic: c.logic, b: b2 });
        });
      }
      const paneList = cond.paneConds && cond.paneConds.length ? cond.paneConds : (cond.paneCond && cond.paneCond.indId ? [cond.paneCond] : []);
      for (const p of paneList) {
        if (!p || !p.indId) continue;
        const a3 = mk(p.indId, p.indSettings || cond.indSettings || {}, p.lineA || 'v0');
        const b3 = mk(p.indId, p.indSettings || cond.indSettings || {}, p.lineB || 'v1');
        chain.push({ a: a3, logic: p.logic || 'crossAbove', b: b3 });
      }
      return chain;
    },

    /* Edge-fired chain evaluation via the fast CrossDetector engine.
       Chains that use an AND/OR connector with a pane-movement gate cannot be
       expressed as a flat AND chain, so those take the connector-aware path. */
    evalCondEdge(cond, candles, sig) {
      const chain = this.toChain(cond);
      if (!chain.length) return false;
      const paneList = cond.paneConds && cond.paneConds.length ? cond.paneConds : (cond.paneCond && cond.paneCond.indId ? [cond.paneCond] : []);
      const hasConn = (cond.chain || []).some(c => c && c.conn && (c.conn.join === 'or' || c.conn.move !== 'off'))
        || paneList.some(p => p && p.indId && p.join === 'or')
        || !!(cond.paneMoves && cond.paneMoves.length)
        || !!(cond.paneMove && cond.paneMove.indId);
      if (!hasConn) {
        if (!sig || !window.CrossDetector) {
          return CrossDetector.evalChain(chain, candles);
        }
        return sig.fire(chain, candles);
      }
      const now = this.evalCond(cond, candles);
      if (!sig) return now;
      const edge = now && !sig.last;
      sig.last = now;
      return edge;
    },

    /* Evaluate gap condition against candle data.
       gap = { enabled, pair:[{primary,primaryVal,logic,comparator,comparatorVal}],
               st:[{trend,trendVal,logic}], band:[{indicator,indicatorVal,candleLogic,gapLogic}] } */
    evalGap(gap, candles) {
      if (!gap || !gap.enabled || !candles || candles.length < 3) return null;
      let passed = true;

      for (const c of (gap.pair || [])) {
        if (!c.primary || !c.comparator || !c.logic) continue;
        const plen = (c.primaryVal != null && c.primaryVal !== '') ? c.primaryVal : (primaryInput(c.primary) || { def: 20 }).def;
        const clen = (c.comparatorVal != null && c.comparatorVal !== '') ? c.comparatorVal : (primaryInput(c.comparator) || { def: 20 }).def;
        const r1 = this.lastTwoOf(c.primary, { length: plen }, 'v0', candles);
        const r2 = this.lastTwoOf(c.comparator, { length: clen }, 'v0', candles);
        if (r1.last != null && r1.prev != null && r2.last != null && r2.prev != null) {
          const curGap = r1.last - r2.last;
          const prevGap = r1.prev - r2.prev;
          if (c.logic === 'inc' && curGap <= prevGap) passed = false;
          if (c.logic === 'dec' && curGap >= prevGap) passed = false;
        } else {
          passed = false;
        }
      }

      for (const c of (gap.st || [])) {
        if (!c.trend || !c.logic) continue;
        const plen = (c.trendVal != null && c.trendVal !== '') ? c.trendVal : (primaryInput(c.trend) || { def: 10 }).def;
        const r3 = this.lastTwoOf(c.trend, { period: plen, multiplier: 3 }, 'v0', candles);
        const lastC = candles[candles.length - 1];
        if (r3.last != null && lastC) {
          if (c.logic === 'uptrend' && r3.last >= lastC.close) passed = false;
          if (c.logic === 'downtrend' && r3.last <= lastC.close) passed = false;
        } else {
          passed = false;
        }
      }

      for (const c of (gap.band || [])) {
        if (!c.indicator || !c.candleLogic || !c.gapLogic) continue;
        const plen = (c.indicatorVal != null && c.indicatorVal !== '') ? c.indicatorVal : (primaryInput(c.indicator) || { def: 20 }).def;
        const r4 = this.lastTwoOf(c.indicator, { length: plen, mult: 2 }, 'v1', candles);
        if (r4.last != null) {
          const lastC = candles[candles.length - 1];
          if (lastC) {
            if (c.candleLogic === 'above' && r4.last <= lastC.close) passed = false;
            if (c.candleLogic === 'below' && r4.last >= lastC.close) passed = false;
            if (r4.prev != null) {
              const prevC = candles[candles.length - 2];
              const curGap = Math.abs(r4.last - lastC.close);
              const prevGap = Math.abs(r4.prev - (prevC ? prevC.close : 0));
              if (c.gapLogic === 'inc' && curGap <= prevGap) passed = false;
              if (c.gapLogic === 'dec' && curGap >= prevGap) passed = false;
            }
          }
        } else {
          passed = false;
        }
      }

      return passed;
    },

    /* Evaluate gate condition - returns true if strategy should RUN (gate is clear), false if blocked */
    evalGate(gate, candles) {
      if (!gate || !gate.enabled || !candles || candles.length < 10) return true;
      let blocked = false;

      /* Check consolidation / liquidity grab candlestick patterns */
      const CP = window.CandlePatterns;
      if (CP && gate.patterns && gate.patterns.length) {
        if (CP.detectAny(gate.patterns, candles)) blocked = true;
      }

      /* Check gate conditions (flatline / parallel flatline detection) */
      if (!blocked && gate.conds && gate.conds.length) {
        for (const gc of gate.conds) {
          if (this.evalGateCond(gc, candles)) { blocked = true; break; }
        }
      }

      return !blocked;
    },

    /* Detect whether an indicator's recent readings form a horizontal flatline
       (consolidation / sideways mode). Range of last readings within 1% of average. */
    isFlatline(indId, settings, valueKey, candles) {
      if (!indId || !candles || candles.length < 5) return false;
      const n = candles.length;
      const lookback = Math.min(8, n);
      const vals = [];
      for (let i = n - lookback; i < n; i++) {
        const partial = candles.slice(0, i + 1);
        const r = this.lastTwoOf(indId, settings || {}, valueKey || 'v0', partial);
        if (r && r.last != null) vals.push(r.last);
      }
      if (vals.length < 4) return false;
      const first = vals[0];
      const lastVal = vals[vals.length - 1];
      const range = Math.abs(first - lastVal);
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      const relChange = avg > 0 ? range / avg : range;
      return relChange <= 0.01;
    },

    /* Evaluate a single gate condition row.
       - type 'flat': true when the indicator forms a horizontal flatline continuously.
       - type 'parallel': true when BOTH indicators form flatlines parallel to each other
         AND the above/below relation holds on the latest reading. */
    evalGateCond(gc, candles) {
      if (!gc || !gc.indId) return false;
      if (gc.type === 'parallel') {
        const aFlat = this.isFlatline(gc.indId, gc.indSettings, gc.valueKey, candles);
        const bFlat = this.isFlatline(gc.cmpIndId, gc.cmpSettings, gc.cmpValueKey, candles);
        if (!aFlat || !bFlat) return false;
        const a = this.lastTwoOf(gc.indId, gc.indSettings || {}, gc.valueKey || 'v0', candles);
        const b = this.lastTwoOf(gc.cmpIndId, gc.cmpSettings || {}, gc.cmpValueKey || 'v0', candles);
        if (a.last == null || b.last == null) return false;
        if (gc.rel === 'both') {
          return Math.abs(a.last - b.last) <= Math.max(Math.abs(a.last), Math.abs(b.last)) * 0.01;
        }
        if (gc.rel === 'above') return a.last > b.last;
        if (gc.rel === 'below') return a.last < b.last;
        return false;
      }
      return this.isFlatline(gc.indId, gc.indSettings, gc.valueKey, candles);
    },

    evalCandlestick(candlestick, candles) {
      if (!candlestick || !candlestick.enabled) return true;
      if (!candles || !candles.length) return false;
      const CP = window.CandlePatterns;
      if (!CP) return true;
      if (candlestick.entry && candlestick.entry.length) {
        if (!CP.detectAny(candlestick.entry, candles)) return false;
      }
      return true;
    },

    evalCandlestickExit(candlestick, candles) {
      if (!candlestick || !candlestick.enabled) return false;
      if (!candles || !candles.length) return false;
      const CP = window.CandlePatterns;
      if (!CP) return false;
      if (candlestick.exit && candlestick.exit.length) {
        return !!CP.detectAny(candlestick.exit, candles);
      }
      return false;
    },

    /* Evaluate one condition against the last two candles */
    evalCond(cond, candles) {
      if (!cond || !cond.indId) return false;
      if (cond.cmpType === 'candlestick_pattern') {
        const CP = window.CandlePatterns;
        if (!CP || !cond.candlePatterns || !cond.candlePatterns.length) return false;
        return !!CP.detectAny(cond.candlePatterns, candles);
      }
      const chain = (cond.chain || []).slice();
      const paneList = cond.paneConds && cond.paneConds.length ? cond.paneConds : (cond.paneCond && cond.paneCond.indId ? [cond.paneCond] : []);
      for (const p of paneList) {
        if (p && p.indId) chain.push(paneCondToCond(p));
      }
      const hasConn = chain.some(c => c && c.conn && (c.conn.join === 'or' || c.conn.move !== 'off'));
      let result = this.evalSingle(cond, candles);
      if (!hasConn) {
        for (const c of chain) {
          if (!c || !c.indId) continue;
          result = result && this.evalSingle(c, candles);
        }
        return this.evalPaneMoveGate(cond, result, candles);
      }
      /* Connector-aware: each extra condition is joined to the running result by
         its AND/OR connector, and the connector's pane-movement gate (increasing
         upward / downward) is ANDed into that extra condition. */
      for (const c of chain) {
        if (!c || !c.indId) continue;
        const conn = c.conn || { join: 'and', move: 'off' };
        let combined = this.evalSingle(c, candles);
        if (conn.move && conn.move !== 'off') {
          combined = combined && this.evalMovement(cond, conn.move, candles);
        }
        result = conn.join === 'or' ? (result || combined) : (result && combined);
      }
      return this.evalPaneMoveGate(cond, result, candles);
    },

    /* The entry-form "Additional Pane Indicator Movement" gate: every line the
       selected pane indicator draws must be rising/falling together (the pane
       movement check) joined to the rest of the condition by AND/OR. */
    evalPaneMoveGate(cond, result, candles) {
      const moveList = cond && cond.paneMoves && cond.paneMoves.length ? cond.paneMoves : (cond && cond.paneMove && cond.paneMove.indId ? [cond.paneMove] : []);
      if (!moveList.length) return result;
      for (const pm of moveList) {
        if (!pm || !pm.indId || !pm.logic) continue;
        const mv = window.CrossDetector && CrossDetector.movementDirection
          ? CrossDetector.movementDirection(pm.indId, pm.indSettings || {}, pm.logic, candles)
          : false;
        result = pm.join === 'or' ? (result || mv) : (result && mv);
      }
      return result;
    },

    /* Evaluate a single condition (no chain connectors). */
    evalSingle(cond, candles) {
      if (!cond || !cond.indId) return false;
      if (cond.cmpType === 'candlestick_pattern') {
        const CP = window.CandlePatterns;
        if (!CP || !cond.candlePatterns || !cond.candlePatterns.length) return false;
        return !!CP.detectAny(cond.candlePatterns, candles);
      }
      if (cond.logic === 'incUp' || cond.logic === 'incDown' || cond.logic === 'andFirst') {
        const chain = this.toChain(cond);
        return window.CrossDetector ? CrossDetector.evalChain(chain, candles) : false;
      }
      const prim = this.lastTwoOf(cond.indId, cond.indSettings || {}, cond.valueKey, candles);
      const cmp = this.cmpReadings(cond, candles);
      return this.applyLogic(cond.logic, prim.last, prim.prev, cmp.last, cmp.prev);
    },

    /* Pane-indicator movement gate used by the strategy-builder connector:
       checks that the primary indicator's Plot, Smoothed MA and movement lines
       are ALL increasing upward / all increasing downward together. */
    evalMovement(cond, move, candles) {
      if (!cond || !cond.indId) return false;
      if (!move || move === 'off') return true;
      return window.CrossDetector && CrossDetector.movementDirection
        ? CrossDetector.movementDirection(cond.indId, cond.indSettings || {}, move, candles)
        : false;
    },

    /* Fastest accurate last-two read: try the chart's already-rendered overlay
       series, then the memoized/incremental compute, then the plain compute. */
    lastTwoOf(indId, settings, valueKey, candles) {
      if (window.IndChart && IndChart.renderedLastTwo) {
        const fast = IndChart.renderedLastTwo(indId, settings, valueKey, candles);
        if (fast) return fast;
      }
      return IndChart.computeLastTwo(indId, settings || {}, valueKey, candles);
    },

    cmpReadings(cond, candles) {
      if (cond.cmpType === 'number') {
        const n = Number(cond.number) || 0;
        return { last: n, prev: n };
      }
      if (cond.cmpType === 'candle') {
        const k = cond.candleKey || 'close';
        const last = candles.length ? candles[candles.length - 1][k] : null;
        const prev = candles.length > 1 ? candles[candles.length - 2][k] : null;
        return { last, prev };
      }
      if (cond.cmpType === 'plot') {
        return this.lastTwoOf(cond.indId, cond.indSettings || {}, 'v0', candles);
      }
      if (cond.cmpType === 'smoothed') {
        return this.lastTwoOf(cond.indId, cond.indSettings || {}, 'v1', candles);
      }
      if (cond.cmpType === 'paneLine') {
        return this.lastTwoOf(cond.indId, cond.indSettings || {}, cond.paneLineB || 'v1', candles);
      }
      return this.lastTwoOf(cond.cmpIndId, cond.cmpSettings || {}, cond.cmpValueKey, candles);
    },

    applyLogic(logic, last, prev, cmpLast, cmpPrev) {
      if (last == null || cmpLast == null) return false;
      switch (logic) {
        case 'gt': return last > cmpLast;
        case 'lt': return last < cmpLast;
        case 'gte': return last >= cmpLast;
        case 'lte': return last <= cmpLast;
        case 'eq': return Math.abs(last - cmpLast) < 1e-9;
        case 'neq': return Math.abs(last - cmpLast) >= 1e-9;
        /* State-based crosses: true whenever the current relationship holds
           (not only on the bar the crossing event happened), so a strategy
           whose price already sits above/below the indicator band fires
           immediately instead of waiting for a flip that already occurred. */
        case 'crossAbove':
          return last > cmpLast;
        case 'crossBelow':
          return last < cmpLast;
        default: return false;
      }
    },

    async fetchCandles(st) {
      const key = st.symbol.id + ':' + st.tf;
      const cached = this.candleCache[key];
      const now = Date.now();
      if (cached && now - cached.at < this.CANDLE_TTL_MS) return cached.candles;
      const chartCandles = (typeof chartTf !== 'undefined' && typeof selectedSymbol !== 'undefined' &&
        window.IndChart && st.symbol && chartTf === st.tf &&
        selectedSymbol && selectedSymbol.id === st.symbol.id && selectedSymbol.exch === st.symbol.exch)
        ? IndChart.getCandles() : null;
      if (chartCandles && chartCandles.length >= 3) {
        this.candleCache[key] = { at: Date.now(), candles: chartCandles };
        return chartCandles;
      }
      const d = await fetch('/api/candles', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ security_id: st.symbol.id, exchange_segment: st.symbol.exch, instrument_type: st.symbol.inst || 'INDEX', timeframe: st.tf, force: 1 })
      }).then(r => r.json());
      if (d && d.status === 'success' && d.data && d.data.length) {
        this.candleCache[key] = { at: Date.now(), candles: d.data };
        return d.data;
      }
      if (cached) return cached.candles;
      return [];
    },

    /* Fetch candles for an arbitrary symbol/timeframe (used by the multi-chart
       strategy monitor). Keys the cache on id+exch+tf to avoid collisions across
       exchange segments, and reuses the chart's live candles when they match. */
    async fetchCandlesFor(symbol, tf, periodDays) {
      if (!symbol || symbol.id == null) return [];
      const key = symbol.id + ':' + (symbol.exch || '') + ':' + tf + ':' + (periodDays || 0);
      const cached = this.candleCache[key];
      const now = Date.now();
      if (cached && now - cached.at < this.CANDLE_TTL_MS) return cached.candles;
      const chartCandles = (!periodDays && typeof chartTf !== 'undefined' && typeof selectedSymbol !== 'undefined' &&
        window.IndChart && chartTf === tf &&
        selectedSymbol && selectedSymbol.id === symbol.id && selectedSymbol.exch === symbol.exch)
        ? IndChart.getCandles() : null;
      if (chartCandles && chartCandles.length >= 3) {
        this.candleCache[key] = { at: Date.now(), candles: chartCandles };
        return chartCandles;
      }
      const d = await fetchWithTimeout('/api/candles', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ security_id: symbol.id, exchange_segment: symbol.exch, instrument_type: symbol.inst || 'INDEX', timeframe: tf, force: 1, period_days: periodDays || null })
      }).then(r => r.json());
      if (d && d.status === 'success' && d.data && d.data.length) {
        this.candleCache[key] = { at: Date.now(), candles: d.data };
        return d.data;
      }
      /* Dhan rate-limit / temporary-unavailable (503): the server parks the
         key for ~30s and returns 503 so clients stop hammering. A transient
         503 is NOT "no data" - retry with a growing backoff that rides out the
         park window, otherwise an experiment firing many concurrent candle
         fetches skips every rate-limited symbol and produces no strategies. */
      if (d && (d.status === 'error' || d.status === 'unavailable') && /rate|limit|unavailable/i.test(String(d.message || ''))) {
        for (let attempt = 1; attempt <= 3; attempt++) {
          await new Promise(r => setTimeout(r, Math.min(3000, 2000 * attempt)));
          const d2 = await fetchWithTimeout('/api/candles', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ security_id: symbol.id, exchange_segment: symbol.exch, instrument_type: symbol.inst || 'INDEX', timeframe: tf, force: 1, period_days: periodDays || null })
          }).then(r => r.json());
          if (d2 && d2.status === 'success' && d2.data && d2.data.length) {
            this.candleCache[key] = { at: Date.now(), candles: d2.data };
            return d2.data;
          }
        }
      }
      if (cached) return cached.candles;
      return [];
    },

    /* Fetch candles for an arbitrary index symbol (used by Index Confirmation).
       Mirrors fetchCandles but is not bound to the chart's selected symbol. */
    async fetchIndexCandles(index, tf) {
      if (!index || !index.id) return [];
      const key = 'IDX_' + index.id + ':' + tf;
      const cached = this.candleCache[key];
      const now = Date.now();
      if (cached && now - cached.at < this.CANDLE_TTL_MS) return cached.candles;
      const d = await fetchWithTimeout('/api/candles', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ security_id: index.id, exchange_segment: index.exch || 'IDX_I', instrument_type: index.inst || 'INDEX', timeframe: tf, force: 1 })
      }).then(r => r.json());
      if (d && d.status === 'success' && d.data && d.data.length) {
        this.candleCache[key] = { at: Date.now(), candles: d.data };
        return d.data;
      }
      if (cached) return cached.candles;
      return [];
    },

    /* Index Confirmation gate. When a strategy's indexConfirmation is enabled and
       indices + an assigned saved strategy are configured, the strategy may only
       enter a trade when the ASSIGNED strategy's entry logic is currently met on
       the selected index/indices candlestick chart and indicators. The assigned
       strategy's entry indicator condition, its chain and its candlestick entry
       patterns are all evaluated against the index candles. Applies to every
       strategy type (index-option and F&O stock strategies alike). */
    async indexConfirmationOk(state) {
      const st = state.strategy;
      const ic = st && st.indexConfirmation;
      if (!ic || !ic.enabled) return true;
      if (!ic.indices || !ic.indices.length || !ic.strategyId) {
        StratUI.log(state.id, 'Index Confirmation: enabled but no indices/strategy configured - entry blocked', 'warn');
        return false;
      }
      const assigned = loadSaved().find(s => s.id === ic.strategyId);
      if (!assigned || !assigned.entry || !assigned.entry.indId) {
        StratUI.log(state.id, 'Index Confirmation: assigned strategy not found - entry blocked', 'warn');
        return false;
      }
      const tf = assigned.tf || st.tf;
      const results = [];
      for (const index of ic.indices) {
        let candles = [];
        try { candles = await this.fetchIndexCandles(index, tf); } catch (e) { candles = []; }
        const condOk = candles.length >= 3 && this.evalCondEdge(assigned.entry, candles, null);
        const candleOk = this.evalCandlestick(assigned.candlestick || {}, candles);
        const ok = !!condOk && candleOk;
        results.push({ name: index.name || index.id, ok });
      }
      const allOk = results.length > 0 && results.every(r => r.ok);
      StratUI.log(state.id, 'Index Confirmation: ' + results.map(r => r.name + (r.ok ? ' PASS' : ' FAIL')).join(' | ') + (allOk ? ' -> ALLOW ENTRY' : ' -> BLOCK ENTRY'), allOk ? 'entry' : 'warn');
      return allOk;
    },

    async fetchChain(state) {
      const st = state.strategy;
      if (!st.symbol || !this.isIndex(st.symbol)) return null;
      const key = st.symbol.id + ':' + st.symbol.exch;
      const cached = this.ocCache[key];
      if (cached && Date.now() - cached.at < this.CHAIN_TTL_MS) return cached.data;
      /* The /api/option_chain endpoint REQUIRES an expiry and reads security_id.
         The old call sent neither, so the server replied "Expiry date required"
         and index strategies never got a chain — and therefore never traded the
         right strikes. Resolve an expiry the same way the monitor does. */
      const expiry = await resolveChainExpiry(st);
      if (!expiry) {
        if (cached) return cached.data;
        return null;
      }
      let d = null;
      try {
        d = await fetch('/api/option_chain', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ security_id: st.symbol.id, exchange_segment: st.symbol.exch, expiry: expiry })
        }).then(r => r.json());
      } catch (e) { d = null; }
      if (d && d.status === 'success') {
        const records = (d.data && d.data.records) ? d.data.records : (d.records || []);
        const chain = { expiry: expiry, spot: d.spot_price, records: records };
        this.ocCache[key] = { at: Date.now(), data: chain };
        return chain;
      }
      if (cached) return cached.data;
      return null;
    },

    findAtm(records, spot) {
      /* A 0 / NaN / missing spot means the underlying last price is unavailable —
         do NOT pick the lowest strike as a fake ATM, otherwise "above ATM"
         strikes are computed from the wrong base. */
      if (!records || !spot || isNaN(spot) || spot <= 0) return null;
      let best = null, bestDiff = Infinity;
      for (const r of records) {
        const s = Number(r.Strike || r.strike) || 0;
        if (!s) continue;
        const diff = Math.abs(s - spot);
        if (diff < bestDiff) { bestDiff = diff; best = s; }
      }
      return best;
    },

    computeStrikes(records, atm, strikeCfg) {
      const strikes = [...new Set(records.map(r => Number(r.Strike || r.strike) || 0).filter(s => s > 0))].sort((a, b) => a - b);
      /* Never fabricate a strike. Without a valid chain or ATM we trade nothing
         rather than a strike that does not exist in the option chain. */
      if (!strikes.length || !atm || isNaN(atm) || atm <= 0) return [];
      const mode = strikeCfg.mode, count = Math.max(0, strikeCfg.count || 0);
      /* ATM inclusion is decided by the mode itself: the plain modes never
         include the ATM strike, the "including ATM" modes always do. */
      let base = mode, includeAtm = false;
      if (mode === 'above_atm') { base = 'above'; includeAtm = true; }
      else if (mode === 'below_atm') { base = 'below'; includeAtm = true; }
      else if (mode === 'both_atm_inc') { base = 'both_atm'; includeAtm = true; }
      if (mode === 'band') {
        const atmIdx = strikes.indexOf(atm);
        if (atmIdx < 0) return [];
        const result = [];
        for (let i = 1; i <= count; i++) {
          if (atmIdx - i >= 0) result.push(strikes[atmIdx - i]);
          if (atmIdx + i < strikes.length) result.push(strikes[atmIdx + i]);
        }
        if (strikeCfg.includeAtm) result.push(atm);
        return result.sort((a, b) => a - b);
      }
      const atmIdx = strikes.indexOf(atm);
      if (atmIdx < 0) return [];
      let out = [];
      if (base === 'both_atm') {
        for (let i = 1; i <= count; i++) {
          if (atmIdx + i < strikes.length) out.push(strikes[atmIdx + i]);
        }
        for (let i = count; i >= 1; i--) {
          if (atmIdx - i >= 0) out.push(strikes[atmIdx - i]);
        }
        if (includeAtm) out.push(atm);
      } else if (base === 'above') {
        for (let i = 1; i <= count; i++) {
          if (atmIdx + i < strikes.length) out.push(strikes[atmIdx + i]);
        }
        if (includeAtm) out.push(atm);
      } else if (base === 'below') {
        for (let i = 1; i <= count; i++) {
          if (atmIdx - i >= 0) out.push(strikes[atmIdx - i]);
        }
        if (includeAtm) out.push(atm);
      }
      return out.sort((a, b) => a - b);
    },

    findChainRow(records, strike) {
      return records.find(r => (Number(r.Strike || r.strike) || 0) === strike);
    },

    lotFromPct(base, pct) {
      return Math.max(1, Math.round((base || 0) * (pct || 0) / 100));
    },

    async resolveOptionSecurity(st, expiry, strike, leg) {
      const cacheKey = st.symbol.id + ':' + expiry + ':' + strike + ':' + leg;
      const cached = this.ocCache[cacheKey];
      if (cached && Date.now() - cached.at < 60000) return cached.data;
      /* The /api/option_security endpoint requires the underlying's display
         name (symbol_name), not the numeric security id. Sending the wrong key
         made every option resolution fail, so the correct strike was never
         traded. */
      const d = await fetch('/api/option_security', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol_name: (st.symbol && st.symbol.name) || '',
          exchange_segment: st.symbol.exch,
          expiry: expiry,
          strike: strike,
          option_type: leg
        })
      }).then(r => r.json());
      if (d && d.status === 'success') {
        this.ocCache[cacheKey] = { at: Date.now(), data: d.data };
        return d.data;
      }
      if (cached) return cached.data;
      return null;
    },

    async placeOrder(lstate, direction, qty) {
      return fetch('/api/trade', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          security_id: lstate.security_id,
          exchange_segment: lstate.exchange_segment,
          instrument_type: lstate.instrument_type,
          direction: direction,
          quantity: qty
        })
      }).then(r => r.json());
    },

    async executeEntry(state) {
      const st = state.strategy;
      if (this.isIndex(st.symbol)) {
        StratUI.log(state.id, 'Index strategy ENTRY fired - check per-leg execution in log', 'entry');
        return;
      }
      StratUI.log(state.id, 'ENTRY signal fired', 'entry');
      const qty = st.lot.auto ? this.lotFromPct(0, st.lot.pct) : Math.max(1, Math.round(Number(st.lot.manualQty) || 0));
      const leg = st.cat === 'bearish' ? 'PE' : 'CE';
      try {
        const res = await this.placeOrder({ security_id: st.symbol.id, exchange_segment: st.symbol.exch, instrument_type: st.symbol.inst || 'EQUITY' }, 'BUY', qty);
        StratUI.log(state.id, 'Order: ' + JSON.stringify(res.data || res), 'trade');
        state.enteredLegs = [{ strike: 0, leg, qty, security_id: st.symbol.id, exchange_segment: st.symbol.exch, instrument_type: st.symbol.inst || 'EQUITY' }];
        state.inPosition = true;
        StratUI.setStatus(state.id, 'In position');
        if (state.entrySig && state.entrySig.reset) state.entrySig.reset();
      } catch (e) {
        StratUI.log(state.id, 'Entry order failed: ' + (e && e.message ? e.message : e), 'warn');
      }
    },

    async executeExit(state) {
      StratUI.log(state.id, 'EXIT signal fired', 'exit');
      for (const leg of state.enteredLegs) {
        try {
          const res = await this.placeOrder(leg, 'SELL', leg.qty);
          StratUI.log(state.id, 'Exit order: ' + JSON.stringify(res.data || res), 'trade');
        } catch (e) {
          StratUI.log(state.id, 'Exit order failed: ' + (e && e.message ? e.message : e), 'warn');
        }
      }
      state.enteredLegs = [];
      state.inPosition = false;
      StratUI.setStatus(state.id, 'Running');
    },

    /* AE-deployed auto strategies must respect the Auto Experiment "Signal
       exit" checkbox: when it is OFF the strategy's own exit signal/pattern may
       NOT close the position (only the auto SL / trailing target can). Manual
       user-created strategies are unaffected. */
    signalExitAllowed(st) {
      if (st && st.auto && window.AutoExperiment && window.AutoExperiment.getState) {
        const u = window.AutoExperiment.getState().universal;
        if (u && u.signalExit === false) return false;
      }
      return true;
    }
  };

  /* ---------------- builder ---------------- */
  let selectedTf = '5min';
  let editId = null;
  let _entryCondEditingIdx = -1;
  let _exitCondEditingIdx = -1;
  let _editingCond = null;
  let _tempEntryConditions = [];
  let _tempExitConditions = [];
  let _tempPaneConds = [];
  let _paneCondEditingIdx = -1;
  let _tempPaneMoves = [];
  let _paneMoveEditingIdx = -1;
  let _exitReverseOn = false;
  let activeStrategies = [];
  let assignedSymbols = [];
  let _chartModalStratId = null;
  let _icTargetId = null;
  let _icIndices = [];
  let _icStratId = '';

  /* Indices available for Index Confirmation (from the app's master SYMBOLS). */
  const IC_INDICES = (function () {
    try {
      if (typeof SYMBOLS === 'undefined' || !Array.isArray(SYMBOLS)) return [];
      return SYMBOLS.filter(s => Array.isArray(s) && (s[6] === 'Indices' || s[2] === 'IDX_I') && s[3] === 'INDEX')
        .map(s => ({ id: s[1], exch: s[2], inst: s[3], name: s[0] }));
    } catch (e) { return []; }
  })();

  function populateICIndexSelect() {
    const sel = $('icIndexSelect');
    if (!sel) return;
    sel.innerHTML = '<option value="">-- Select index --</option>';
    IC_INDICES.forEach(i => {
      const o = document.createElement('option');
      o.value = i.id;
      o.textContent = i.name;
      sel.appendChild(o);
    });
  }

  function renderICIndexTags() {
    const wrap = $('icIndexTags');
    if (!wrap) return;
    wrap.innerHTML = '';
    _icIndices.forEach((idx, i) => {
      const tag = document.createElement('span');
      tag.className = 'assign-tag';
      tag.innerHTML = idx.name + ' <span class="x" onclick="StratUI.removeICIndex(' + i + ')">&times;</span>';
      wrap.appendChild(tag);
    });
  }

  function populateICStratSelect() {
    const sel = $('icStratSelect');
    if (!sel) return;
    sel.innerHTML = '<option value="">-- Select saved strategy --</option>';
    loadSaved().forEach(s => {
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = (s.name || 'Untitled') + ' [' + s.tf + ']';
      sel.appendChild(o);
    });
  }

  function loadSaved() {
    let list;
    try { list = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'); } catch (e) { list = []; }
    if (!Array.isArray(list)) return [];
    /* Clean duplicates: auto-deployed Auto Experiment strategies share the same
       aeKey + symbol + strike identity (each deploy got a fresh id), so they
       stacked up in the saved-strategy list. Keep the first occurrence of each
       auto strategy and each regular strategy id. */
    const seen = new Set();
    const out = [];
    list.forEach(s => {
      if (!s || !s.id) return;
      const k = (s.auto && s.aeKey)
        ? 'auto:' + s.aeKey + '|' + String((s.symbol && s.symbol.id) != null ? s.symbol.id : '') + '|' +
          (s.optionStrike != null ? s.optionStrike + ':' + (s.optionType || '') : '')
        : 'id:' + s.id;
      if (seen.has(k)) return;
      seen.add(k);
      out.push(s);
    });
    if (out.length !== list.length) {
      try { localStorage.setItem(SAVED_KEY, JSON.stringify(out)); } catch (e) {}
    }
    return out;
  }
  function persistSaved(saved) { localStorage.setItem(SAVED_KEY, JSON.stringify(saved)); }
  function loadActive() { try { return JSON.parse(localStorage.getItem(ACTIVE_KEY) || '[]'); } catch (e) { return []; } }
  function persistActive() { localStorage.setItem(ACTIVE_KEY, JSON.stringify(activeStrategies)); }
  function loadAssignments() { try { return JSON.parse(localStorage.getItem(ASSIGN_KEY) || '{}'); } catch (e) { return {}; } }
  function persistAssignments(map) { localStorage.setItem(ASSIGN_KEY, JSON.stringify(map)); }

  function popIndicatorSelect(sel, restoredId) {
    if (!sel) return;
    sel.innerHTML = '<option value="">-- Select --</option>';
    const list = (window.IndChart && IndChart.IND_LIST) ? IndChart.IND_LIST : [];
    const deployed = window.IndChart ? IndChart.getDeployedIndicators() : [];
    const seen = new Set();
    list.forEach(def => {
      if (!def || !def.id || seen.has(def.id)) return;
      seen.add(def.id);
      const o = document.createElement('option');
      o.value = def.id;
      o.textContent = def.name;
      sel.appendChild(o);
    });
    deployed.forEach(ind => {
      if (!ind || !ind.id || seen.has(ind.id)) return;
      seen.add(ind.id);
      const o = document.createElement('option');
      o.value = ind.id;
      o.textContent = (ind.name || ind.id) + ' (deployed)';
      sel.appendChild(o);
    });
    if (restoredId && [...sel.options].some(o => o.value === restoredId)) {
      sel.value = restoredId;
    } else {
      const def = (list.length && list[0] && list[0].id) ? (list.find(d => d.id === restoredId) ? restoredId : '') : '';
      sel.value = def;
    }
  }

  function updateLiveReading() {
    const entrySel = $('stratCmpNumber');
    const exitSel = $('exitCmpNumber');
    const entryEl = $('stratLiveReading');
    const exitEl = $('exitLiveReading');
    if (entryEl && entrySel) {
      entryEl.textContent = 'Reading: ' + (entrySel.value || '0');
    }
    if (exitEl && exitSel) {
      exitEl.textContent = 'Reading: ' + (exitSel.value || '0');
    }
  }

  function allSymbolOptions() {
    const sel = document.getElementById('symbolSelect');
    if (!sel) return [];
    const out = [];
    for (const opt of sel.options) {
      out.push({
        id: parseInt(opt.value),
        exch: opt.getAttribute('data-exch') || 'IDX_I',
        inst: opt.getAttribute('data-inst') || 'INDEX',
        name: opt.getAttribute('data-symbol-name') || opt.textContent.split('  ')[0]
      });
    }
    return out;
  }

  function populateAssignSymbolSelect() {
    const sel = $('assignSymbolSelect');
    if (!sel) return;
    sel.innerHTML = '<option value="">-- Select symbol --</option>';
    allSymbolOptions().forEach(o => {
      const opt = document.createElement('option');
      opt.value = o.id;
      opt.textContent = o.name;
      sel.appendChild(opt);
    });
  }

  function renderAssignSymbolTags() {
    const wrap = $('assignSymbolTags');
    if (!wrap) return;
    wrap.innerHTML = '';
    assignedSymbols.forEach((s, i) => {
      const tag = document.createElement('span');
      tag.className = 'assign-tag';
      tag.innerHTML = s.name + ' <span class="x" onclick="StratUI.removeAssignedSymbol(' + i + ')">&times;</span>';
      wrap.appendChild(tag);
    });
  }

  function populateAssignStratSelect() {
    const sel = $('assignStratSelect');
    if (!sel) return;
    sel.innerHTML = '<option value="">-- Select saved strategy --</option>';
    loadSaved().forEach(s => {
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = s.name || 'Untitled';
      sel.appendChild(o);
    });
  }

  function populateOpenChartStratSelect() {
    const sel = $('openChartStratSelect');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">-- Select strategy --</option>';
    const saved = loadSaved();
    saved.forEach(s => {
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = (s.name || 'Untitled') + ' [' + s.tf + ']';
      sel.appendChild(o);
    });
    const active = activeStrategies;
    if (active.length) {
      const g = document.createElement('optgroup');
      g.label = 'Opened Strategies';
      active.forEach(s => {
        const o = document.createElement('option');
        o.value = s.id;
        o.textContent = (s.name || 'Untitled') + ' (' + (s.symbol && s.symbol.name || '-') + ')';
        g.appendChild(o);
      });
      sel.appendChild(g);
    }
    if (cur && [...sel.options].some(o => o.value === cur)) sel.value = cur;
  }

  function renderAssignmentList() {
    const host = $('assignList');
    if (!host) return;
    const map = loadAssignments();
    host.innerHTML = '';
    Object.entries(map).forEach(([stratId, syms]) => {
      const saved = loadSaved();
      const s = saved.find(x => x.id === stratId) || activeStrategies.find(x => x.id === stratId);
      if (!s || !syms || !syms.length) return;
      syms.forEach(sym => {
        const div = document.createElement('div');
        div.className = 'assign-item';
        div.innerHTML = '<div class="sym-row">' + esc(sym.name) + '</div><div class="strat-row">' + esc(s.name || 'Untitled') +
          ' <span class="remove-assign" onclick="StratUI.removeAssignment(\'' + stratId + '\',\'' + sym.id + '\',\'' + sym.exch + '\')">&times;</span></div>';
        host.appendChild(div);
      });
    });
  }

  function show(el, on) { if (el) el.classList.toggle('hidden', !on); }

  function condLabel(cond) {
    if (!cond || !cond.indId) return '';
    const def = (window.IndChart && IndChart.IND) ? IndChart.IND[cond.indId] : null;
    const name = def ? def.name : cond.indId;
    const settings = cond.indSettings || {};
    const parts = [];
    if (def && def.inputs) {
      def.inputs.forEach(inp => {
        const v = settings[inp.key] != null ? settings[inp.key] : inp.def;
        parts.push(inp.label + ': ' + v);
      });
    }
    const val = parts.length ? parts.join(', ') : (cond.indValue != null ? cond.indValue : '');
    let cmpLabel = '';
    if (cond.cmpType === 'number') cmpLabel = String(cond.number != null ? cond.number : 0);
    else if (cond.cmpType === 'candle') cmpLabel = cond.candleKey || 'close';
    else if (cond.cmpType === 'plot') cmpLabel = cmpSelfLabels(cond.indId)[0];
    else if (cond.cmpType === 'smoothed') cmpLabel = cmpSelfLabels(cond.indId)[1] || 'Smoothed MA';
    else if (cond.cmpType === 'paneLine') cmpLabel = lineLabel(cond.indId, cond.paneLineB);
    else if (cond.cmpType === 'indicator') {
      const cdef = (window.IndChart && IndChart.IND) ? IndChart.IND[cond.cmpIndId] : null;
      const cname = cdef ? cdef.name : (cond.cmpIndId || '');
      const cval = cond.cmpIndValue != null ? cond.cmpIndValue : '';
      cmpLabel = cname + (cval ? '(' + cval + ')' : '');
    } else if (cond.cmpType === 'candlestick_pattern') {
      const CP = window.CandlePatterns;
      const names = (cond.candlePatterns || []).map(k => CP && CP.PATTERNS[k] ? CP.PATTERNS[k].name : k);
      cmpLabel = names.length ? names.join(', ') : '--';
    }
    const logicLbl = (LOGIC_OPS.find(l => l[0] === cond.logic) || [cond.logic, cond.logic])[1];
    const isTrend = cond.logic === 'incUp' || cond.logic === 'incDown';
    let out = name + (val ? ' (' + val + ')' : '') + ' ' + logicLbl + (isTrend ? '' : ' ' + cmpLabel);
    const paneList = cond.paneConds && cond.paneConds.length ? cond.paneConds : (cond.paneCond && cond.paneCond.indId ? [cond.paneCond] : []);
    for (const p of paneList) {
      if (!p || !p.indId) continue;
      const pdef = (window.IndChart && IndChart.IND) ? IndChart.IND[p.indId] : null;
      const pname = pdef ? pdef.name : p.indId;
      const joinLbl = p.join === 'or' ? 'OR' : 'AND';
      const pLogicLbl = (LOGIC_OPS.find(l => l[0] === p.logic) || [p.logic, p.logic])[1];
      out += ' ' + joinLbl + ' ' + pname + ' ' + lineLabel(p.indId, p.lineA) + ' ' + pLogicLbl + ' ' + lineLabel(p.indId, p.lineB);
    }
    const moveList = cond.paneMoves && cond.paneMoves.length ? cond.paneMoves : (cond.paneMove && cond.paneMove.indId ? [cond.paneMove] : []);
    for (const pm of moveList) {
      if (!pm || !pm.indId) continue;
      const pmdef = (window.IndChart && IndChart.IND) ? IndChart.IND[pm.indId] : null;
      const pmname = pmdef ? pmdef.name : pm.indId;
      const joinLbl = pm.join === 'or' ? 'OR' : 'AND';
      const mvLbl = moveLabel(pm.logic, pm.indId === 'macd');
      out += ' ' + joinLbl + ' ' + pmname + ' movement: ' + mvLbl;
    }
    return out;
  }

  function collectCondFromForm(isEntry) {
    const p = isEntry ? 'strat' : 'exit';
    const indId = $(p + 'Ind').value;
    const indSettings = {};
    const container = document.getElementById(isEntry ? 'stratIndInputs' : 'exitIndInputs');
    if (container) {
      container.querySelectorAll('.ind-inp').forEach(el => {
        const key = el.dataset.key;
        const v = el.value;
        indSettings[key] = el.tagName === 'SELECT' ? v : (isNaN(Number(v)) ? v : Number(v));
      });
    }
    const inp = primaryInput(indId);
    const indVal = inp && indSettings[inp.key] != null ? String(indSettings[inp.key]) : '';
    const cmpVal = $(p + 'CmpVal').value;
    const cmpIndId = $(p + 'CmpInd').value;
    const cmpType = $(p + 'CmpType').value;
    let candlePatterns = [];
    if (cmpType === 'candlestick_pattern') {
      candlePatterns = isEntry ? [] : collectExitCandlePatterns();
    }
    let paneCond = null;
    let paneConds = null;
    if (isEntry) {
      if ($('stratPaneInd') && $('stratPaneInd').value && _paneCondEditingIdx < 0) {
        const pc = _readPaneCondFromForm();
        if (pc) {
          if (_tempPaneConds.length === 0) {
            _tempPaneConds.push(pc);
          }
        }
      }
      if (_tempPaneConds.length) {
        paneConds = _tempPaneConds.map(c => JSON.parse(JSON.stringify(c)));
        paneCond = paneConds[0];
      }
    }
    let paneMove = null;
    let paneMoves = null;
    if (isEntry) {
      if ($('stratPaneMoveInd') && $('stratPaneMoveInd').value && _paneMoveEditingIdx < 0) {
        const pm = _readPaneMoveFromForm();
        if (pm) {
          if (_tempPaneMoves.length === 0) {
            _tempPaneMoves.push(pm);
          }
        }
      }
      if (_tempPaneMoves.length) {
        paneMoves = _tempPaneMoves.map(p => JSON.parse(JSON.stringify(p)));
        paneMove = paneMoves[0];
      }
    }
    return {
      indId,
      indSettings: Object.keys(indSettings).length ? indSettings : (indId ? defaultSettingsFor(indId) : {}),
      indValue: indVal,
      valueKey: defaultValueKey(indId),
      logic: $(p + 'Logic').value,
      cmpType,
      cmpIndId,
      cmpSettings: cmpIndId ? applyIndValue(defaultSettingsFor(cmpIndId), cmpIndId, cmpVal) : {},
      cmpIndValue: cmpVal,
      cmpValueKey: defaultValueKey(cmpIndId),
      candleKey: $(p + 'CandleKey').value || 'close',
      number: Number($(p + 'CmpNumber').value) || 0,
      candlePatterns,
      paneCond,
      paneConds,
      paneMove,
      paneMoves
    };
  }

  function _loadCondIntoForm(cond, isEntry) {
    const p = isEntry ? 'strat' : 'exit';
    $(p + 'Ind').value = cond.indId || '';
    $(p + 'CmpType').value = cond.cmpType || (isEntry ? 'number' : 'candle');
    $(p + 'CmpInd').value = cond.cmpIndId || '';
    $(p + 'CmpVal').value = cond.cmpIndValue != null ? cond.cmpIndValue : '';
    $(p + 'CandleKey').value = cond.candleKey || 'close';
    $(p + 'CmpNumber').value = cond.number != null ? cond.number : 0;
    if (cond.cmpType === 'candlestick_pattern') loadExitCandlePatterns(cond.candlePatterns || []);
    _editingCond = cond;
    renderIndInputs(p);
    _editingCond = null;
    $(p + 'Logic').value = cond.logic || (isEntry ? 'gt' : 'lt');
    if (isEntry && $('stratPaneInd')) {
      _tempPaneConds = [];
      _paneCondEditingIdx = -1;
      if (cond.paneConds && cond.paneConds.length) {
        _tempPaneConds = cond.paneConds.map(c => JSON.parse(JSON.stringify(c)));
        _clearPaneCondForm();
        _renderPaneCondList();
      } else if (cond.paneCond && cond.paneCond.indId) {
        _tempPaneConds = [JSON.parse(JSON.stringify(cond.paneCond))];
        _clearPaneCondForm();
        _renderPaneCondList();
      } else {
        _tempPaneConds = [];
        _clearPaneCondForm();
        _renderPaneCondList();
      }
    }
    syncBuilderFields();
    if (isEntry && $('stratPaneMoveInd')) {
      _tempPaneMoves = [];
      _paneMoveEditingIdx = -1;
      if (cond.paneMoves && cond.paneMoves.length) {
        _tempPaneMoves = cond.paneMoves.map(p => JSON.parse(JSON.stringify(p)));
        _clearPaneMoveCondForm();
        _renderPaneMoveCondList();
      } else if (cond.paneMove && cond.paneMove.indId) {
        _tempPaneMoves = [JSON.parse(JSON.stringify(cond.paneMove))];
        _clearPaneMoveCondForm();
        _renderPaneMoveCondList();
      } else {
        _tempPaneMoves = [];
        _clearPaneMoveCondForm();
        _renderPaneMoveCondList();
      }
    }
  }

  function _clearCondForm(isEntry) {
    const p = isEntry ? 'strat' : 'exit';
    $(p + 'Ind').value = '';
    const indValEl = $(p + 'IndVal');
    if (indValEl) indValEl.value = '';
    $(p + 'Logic').value = isEntry ? 'gt' : 'lt';
    $(p + 'CmpType').value = isEntry ? 'number' : 'candle';
    $(p + 'CmpInd').value = '';
    $(p + 'CmpVal').value = '';
    $(p + 'CandleKey').value = 'close';
    $(p + 'CmpNumber').value = 0;
    const inpContainer = document.getElementById(isEntry ? 'stratIndInputs' : 'exitIndInputs');
    if (inpContainer) inpContainer.innerHTML = '';
    loadExitCandlePatterns([]);
    if (isEntry && $('stratPaneInd')) {
      _tempPaneConds = [];
      _paneCondEditingIdx = -1;
      _clearPaneCondForm();
      _renderPaneCondList();
    }
    if (isEntry && $('stratPaneMoveInd')) {
      _tempPaneMoves = [];
      _paneMoveEditingIdx = -1;
      _clearPaneMoveCondForm();
      _renderPaneMoveCondList();
    }
    if (isEntry) _entryCondEditingIdx = -1; else _exitCondEditingIdx = -1;
    syncBuilderFields();
  }

  /* True when the first saved entry condition uses a pane indicator. The
     pane-movement gate (increasing upward / downward) is only shown then. */
  function primaryEntryIsPane() {
    const prim = _tempEntryConditions[0];
    if (!prim || !prim.indId) return false;
    const def = (window.IndChart && IndChart.IND) ? IndChart.IND[prim.indId] : null;
    return !!(def && def.type === 'pane');
  }

  /* True when the first saved entry condition is MACD. The connector's movement
     dropdown then shows MACD-specific options (MACD line + Signal line). */
  function primaryEntryIsMacd() {
    const prim = _tempEntryConditions[0];
    return !!(prim && prim.indId === 'macd');
  }

  /* True when the indicator currently selected in the entry-condition form is a
     pane indicator. The "Additional Pane Indicator Condition" and movement
     connector sections are only shown then. */
  function currentEntryIsPane() {
    const indId = $('stratInd') ? $('stratInd').value : '';
    if (!indId) return false;
    const def = (window.IndChart && IndChart.IND) ? IndChart.IND[indId] : null;
    return !!(def && def.type === 'pane');
  }

  /* Human label for a movement gate, MACD-aware. */
  function moveLabel(move, isMacd) {
    if (move === 'incUp') return isMacd ? 'MACD line & Signal line increasing upward' : 'Increasing upward';
    if (move === 'incDown') return isMacd ? 'MACD line & Signal line increasing downward' : 'Increasing downward';
    return '';
  }

  /* Connector row placed between two entry conditions: an AND/OR join is always
     offered; the pane-movement gate (increasing upward / downward) is only shown
     when the primary entry indicator is a pane indicator. For MACD the gate is
     labelled in terms of the MACD line + Signal line. */
  function connectorRow(idx, conn, showMove, isMacd) {
    const c = conn || { join: 'and', move: 'off' };
    const div = document.createElement('div');
    div.className = 'cond-connector';
    let html =
      '<span class="cond-conn-label">Connector</span>' +
      '<select class="conn-join" onchange="StratUI.setEntryConn(' + idx + ',\'join\',this.value)">' +
      '<option value="and"' + (c.join === 'or' ? '' : ' selected') + '>And</option>' +
      '<option value="or"' + (c.join === 'or' ? ' selected' : '') + '>Or</option>' +
      '</select>';
    if (showMove) {
      const upLbl = moveLabel('incUp', isMacd);
      const dnLbl = moveLabel('incDown', isMacd);
      html +=
        '<select class="conn-move" onchange="StratUI.setEntryConn(' + idx + ',\'move\',this.value)">' +
        '<option value="off"' + (c.move === 'off' || !c.move ? ' selected' : '') + '>Off</option>' +
        '<option value="incUp"' + (c.move === 'incUp' ? ' selected' : '') + '>' + upLbl + '</option>' +
        '<option value="incDown"' + (c.move === 'incDown' ? ' selected' : '') + '>' + dnLbl + '</option>' +
        '</select>';
    }
    div.innerHTML = html;
    return div;
  }

  function _renderCondList(containerId, arr, prefix, readOnly) {
    const host = document.getElementById(containerId);
    if (!host) return;
    host.innerHTML = '';
    const isEntry = prefix === 'entry';
    const showConn = isEntry && !readOnly && arr.length >= 2;
    const showMove = showConn && primaryEntryIsPane();
    const isMacd = showMove && primaryEntryIsMacd();
    arr.forEach((c, i) => {
      const label = condLabel(c) || 'Empty condition';
      const card = document.createElement('div');
      card.className = readOnly ? 'cond-card cond-card-faded' : 'cond-card';
      if (readOnly) {
        card.innerHTML =
          '<span class="cond-card-text">#' + (i + 1) + ' ' + label + '</span>' +
          '<span class="cond-card-lock">read-only</span>';
      } else {
        card.innerHTML =
          '<span class="cond-card-text">#' + (i + 1) + ' ' + label + '</span>' +
          '<div class="cond-card-btns">' +
          '<button onclick="StratUI.editCond(\'' + prefix + '\',' + i + ')">Edit</button>' +
          '<button class="cond-del" onclick="StratUI.removeCond(\'' + prefix + '\',' + i + ')">x</button>' +
          '</div>';
      }
      host.appendChild(card);
      if (showConn && i < arr.length - 1) {
        const next = arr[i + 1];
        if (!next.conn) next.conn = { join: 'and', move: 'off' };
        host.appendChild(connectorRow(i + 1, next.conn, showMove, isMacd));
      }
    });
  }

  function saveEntryCondition() {
    if (!$('stratInd').value) { alert('Select an entry indicator first'); return; }
    const cond = collectCondFromForm(true);
    if (!cond.conn) {
      cond.conn = (_editingCond && _editingCond.conn)
        ? JSON.parse(JSON.stringify(_editingCond.conn))
        : { join: 'and', move: 'off' };
    }
    if (_entryCondEditingIdx >= 0) {
      _tempEntryConditions[_entryCondEditingIdx] = cond;
    } else {
      _tempEntryConditions.push(cond);
    }
    _renderCondList('entryCondList', _tempEntryConditions, 'entry');
    _clearCondForm(true);
    refreshGapGateDropdowns();
    if (_exitReverseOn) syncReverseExitConditions();
  }

  /* Return the exact opposite logic operator. */
  function reverseLogic(logic) {
    return { gt: 'lt', lt: 'gt', gte: 'lte', lte: 'gte', eq: 'neq', neq: 'eq',
             crossAbove: 'crossBelow', crossBelow: 'crossAbove' }[logic] || logic;
  }

  /* Build the "reverse" copy of a saved entry condition: same indicator +
     comparator, but the logic flipped so it is the exact opposite condition. */
  function reverseCondition(cond) {
    if (!cond || !cond.indId) return null;
    const c = JSON.parse(JSON.stringify(cond));
    c.logic = reverseLogic(c.logic);
    delete c.candlePatterns;
    if (c.conn && c.conn.move && c.conn.move !== 'off') {
      c.conn.move = c.conn.move === 'incUp' ? 'incDown' : 'incUp';
    }
    if (c.paneCond) {
      c.paneCond.logic = reverseLogic(c.paneCond.logic);
    }
    if (c.paneConds && c.paneConds.length) {
      c.paneConds = c.paneConds.map(p => { p.logic = reverseLogic(p.logic); return p; });
    }
    if (c.paneMove) {
      c.paneMove.logic = c.paneMove.logic === 'incUp' ? 'incDown' : 'incUp';
    }
    if (c.paneMoves && c.paneMoves.length) {
      c.paneMoves = c.paneMoves.map(pm => { pm.logic = pm.logic === 'incUp' ? 'incDown' : 'incUp'; return pm; });
    }
    return c;
  }

  function syncReverseExitConditions() {
    _tempExitConditions = _tempEntryConditions.map(reverseCondition).filter(Boolean);
    _renderCondList('exitCondList', _tempExitConditions, 'exit', true);
  }

  function onExitReverseToggle() {
    _exitReverseOn = !!(($('exitReverseToggle') || {}).checked);
    show($('exitManualWrap'), !_exitReverseOn);
    show($('exitReverseNote'), _exitReverseOn);
    if (_exitReverseOn) {
      _exitCondEditingIdx = -1;
      _clearCondForm(false);
      syncReverseExitConditions();
    } else {
      _tempExitConditions = [];
      _renderCondList('exitCondList', [], 'exit');
    }
    syncBuilderFields();
  }

  function saveExitCondition() {
    if (_exitReverseOn) { alert('Exit condition is auto-generated (reverse of entry). Turn off "Reverse the Entry Condition" to edit manually.'); return; }
    if (!$('exitInd').value) { alert('Select an exit indicator first'); return; }
    const cond = collectCondFromForm(false);
    if (_exitCondEditingIdx >= 0) {
      _tempExitConditions[_exitCondEditingIdx] = cond;
    } else {
      _tempExitConditions.push(cond);
    }
    _renderCondList('exitCondList', _tempExitConditions, 'exit');
    _clearCondForm(false);
  }

  function addEntryCondition() {
    if (!_tempEntryConditions.length) { alert('Save the first entry condition before adding another'); return; }
    if ($('stratInd').value && _entryCondEditingIdx < 0) saveEntryCondition();
    _clearCondForm(true);
  }

  function addExitCondition() {
    if (_exitReverseOn) { alert('Exit condition is auto-generated (reverse of entry). Turn off "Reverse the Entry Condition" to edit manually.'); return; }
    if (!_tempExitConditions.length) { alert('Save the first exit condition before adding another'); return; }
    if ($('exitInd').value && _exitCondEditingIdx < 0) saveExitCondition();
    _clearCondForm(false);
  }

  /* ---------------- additional pane condition (multi) ---------------- */

  function _renderPaneCondList() {
    const host = document.getElementById('paneCondList');
    if (!host) return;
    host.innerHTML = '';
    _tempPaneConds.forEach((c, i) => {
      const pdef = (window.IndChart && IndChart.IND) ? IndChart.IND[c.indId] : null;
      const pname = pdef ? pdef.name : c.indId;
      const lA = lineLabel(c.indId, c.lineA);
      const lB = lineLabel(c.indId, c.lineB);
      const logicLbl = (LOGIC_OPS.find(l => l[0] === c.logic) || [c.logic, c.logic])[1];
      const label = pname + ' ' + lA + ' ' + logicLbl + ' ' + lB;
      const card = document.createElement('div');
      card.className = 'cond-card';
      card.innerHTML =
        '<span class="cond-card-text">#' + (i + 1) + ' ' + label + '</span>' +
        '<div class="cond-card-btns">' +
        '<button onclick="StratUI.editPaneCond(' + i + ')">Edit</button>' +
        '<button class="cond-del" onclick="StratUI.removePaneCond(' + i + ')">x</button>' +
        '</div>';
      host.appendChild(card);
      if (i < _tempPaneConds.length - 1) {
        const next = _tempPaneConds[i + 1];
        if (!next.join) next.join = 'and';
        const div = document.createElement('div');
        div.className = 'cond-connector';
        div.innerHTML =
          '<span class="cond-conn-label">Connector</span>' +
          '<select class="conn-join" onchange="StratUI.setPaneCondJoin(' + (i + 1) + ',this.value)">' +
          '<option value="and"' + (next.join !== 'or' ? ' selected' : '') + '>And</option>' +
          '<option value="or"' + (next.join === 'or' ? ' selected' : '') + '>Or</option>' +
          '</select>';
        host.appendChild(div);
      }
    });
  }

  function setPaneCondJoin(idx, val) {
    if (idx < 0 || idx >= _tempPaneConds.length) return;
    _tempPaneConds[idx].join = val === 'or' ? 'or' : 'and';
    _renderPaneCondList();
  }

  function _readPaneCondFromForm() {
    if (!$('stratPaneInd') || !$('stratPaneInd').value) return null;
    const indId = $('stratPaneInd').value;
    const lineA = ($('stratPaneLineA') || {}).value || '';
    const lineB = ($('stratPaneLineB') || {}).value || '';
    if (!lineA || !lineB) return null;
    const paneIndId = indId;
    const entryIndId = ($('stratInd') || {}).value;
    let indSettings = {};
    if (paneIndId === entryIndId) {
      const container = document.getElementById('stratIndInputs');
      if (container) {
        container.querySelectorAll('.ind-inp').forEach(el => {
          const key = el.dataset.key;
          const v = el.value;
          indSettings[key] = el.tagName === 'SELECT' ? v : (isNaN(Number(v)) ? v : Number(v));
        });
      }
    }
    if (!Object.keys(indSettings).length) {
      indSettings = defaultSettingsFor(paneIndId);
    }
    return {
      join: $('stratPaneJoin').value === 'or' ? 'or' : 'and',
      indId: paneIndId,
      indSettings: indSettings,
      lineA: lineA,
      logic: $('stratPaneLogic').value || 'crossAbove',
      lineB: lineB
    };
  }

  function _loadPaneCondIntoForm(pc) {
    if (!$('stratPaneInd')) return;
    $('stratPaneJoin').value = pc.join === 'or' ? 'or' : 'and';
    $('stratPaneInd').value = pc.indId || '';
    populatePaneLineSelects();
    if (pc.lineA && $('stratPaneLineA') && [...$('stratPaneLineA').options].some(o => o.value === pc.lineA)) {
      $('stratPaneLineA').value = pc.lineA;
    }
    if (pc.lineB && $('stratPaneLineB') && [...$('stratPaneLineB').options].some(o => o.value === pc.lineB)) {
      $('stratPaneLineB').value = pc.lineB;
    }
    $('stratPaneLogic').value = pc.logic || 'crossAbove';
  }

  function savePaneCondition() {
    if (!$('stratPaneInd') || !$('stratPaneInd').value) { alert('Select a pane indicator first'); return; }
    const pc = _readPaneCondFromForm();
    if (!pc) return;
    if (_paneCondEditingIdx >= 0) {
      const existing = _tempPaneConds[_paneCondEditingIdx];
      if (existing && existing.indId === pc.indId) {
        pc.indSettings = existing.indSettings;
      }
      _tempPaneConds[_paneCondEditingIdx] = pc;
    } else {
      _tempPaneConds.push(pc);
    }
    _renderPaneCondList();
    _clearPaneCondForm();
  }

  function addPaneCondition() {
    if (!_tempPaneConds.length) { alert('Save the first pane condition before adding another'); return; }
    if ($('stratPaneInd') && $('stratPaneInd').value && _paneCondEditingIdx < 0) savePaneCondition();
    _clearPaneCondForm();
  }

  function editPaneCond(idx) {
    if (idx < 0 || idx >= _tempPaneConds.length) return;
    if ($('stratPaneInd') && $('stratPaneInd').value && _paneCondEditingIdx < 0) savePaneCondition();
    _loadPaneCondIntoForm(_tempPaneConds[idx]);
    _paneCondEditingIdx = idx;
  }

  function removePaneCond(idx) {
    if (idx < 0 || idx >= _tempPaneConds.length) return;
    _tempPaneConds.splice(idx, 1);
    if (_paneCondEditingIdx === idx) { _paneCondEditingIdx = -1; _clearPaneCondForm(); }
    else if (_paneCondEditingIdx > idx) _paneCondEditingIdx--;
    _renderPaneCondList();
  }

  function _clearPaneCondForm() {
    if ($('stratPaneInd')) $('stratPaneInd').value = '';
    if ($('stratPaneJoin')) $('stratPaneJoin').value = 'and';
    if ($('stratPaneLogic')) $('stratPaneLogic').value = 'crossAbove';
    populatePaneLineSelects();
    _paneCondEditingIdx = -1;
  }

  /* ---------------- end pane condition multi ---------------- */

  /* ---------------- pane indicator movement multi ---------------- */

  function _renderPaneMoveCondList() {
    const host = document.getElementById('paneMoveCondList');
    if (!host) return;
    host.innerHTML = '';
    _tempPaneMoves.forEach((pm, i) => {
      const pdef = (window.IndChart && IndChart.IND) ? IndChart.IND[pm.indId] : null;
      const pname = pdef ? pdef.name : pm.indId;
      const mvLbl = moveLabel(pm.logic, pm.indId === 'macd');
      const label = pname + ' movement: ' + mvLbl;
      const card = document.createElement('div');
      card.className = 'cond-card';
      card.innerHTML =
        '<span class="cond-card-text">#' + (i + 1) + ' ' + label + '</span>' +
        '<div class="cond-card-btns">' +
        '<button onclick="StratUI.editPaneMoveCond(' + i + ')">Edit</button>' +
        '<button class="cond-del" onclick="StratUI.removePaneMoveCond(' + i + ')">x</button>' +
        '</div>';
      host.appendChild(card);
      if (i < _tempPaneMoves.length - 1) {
        const next = _tempPaneMoves[i + 1];
        if (!next.join) next.join = 'and';
        const div = document.createElement('div');
        div.className = 'cond-connector';
        div.innerHTML =
          '<span class="cond-conn-label">Connector</span>' +
          '<select class="conn-join" onchange="StratUI.setPaneMoveJoin(' + (i + 1) + ',this.value)">' +
          '<option value="and"' + (next.join !== 'or' ? ' selected' : '') + '>And</option>' +
          '<option value="or"' + (next.join === 'or' ? ' selected' : '') + '>Or</option>' +
          '</select>';
        host.appendChild(div);
      }
    });
  }

  function setPaneMoveJoin(idx, val) {
    if (idx < 0 || idx >= _tempPaneMoves.length) return;
    _tempPaneMoves[idx].join = val === 'or' ? 'or' : 'and';
    _renderPaneMoveCondList();
  }

  function _readPaneMoveFromForm() {
    if (!$('stratPaneMoveInd') || !$('stratPaneMoveInd').value) return null;
    const indId = $('stratPaneMoveInd').value;
    const line = ($('stratPaneMoveLine') || {}).value || '';
    if (!line) return null;
    const entryIndId = ($('stratInd') || {}).value;
    let indSettings = {};
    if (indId === entryIndId) {
      const container = document.getElementById('stratIndInputs');
      if (container) {
        container.querySelectorAll('.ind-inp').forEach(el => {
          const key = el.dataset.key;
          const v = el.value;
          indSettings[key] = el.tagName === 'SELECT' ? v : (isNaN(Number(v)) ? v : Number(v));
        });
      }
    }
    if (!Object.keys(indSettings).length) {
      indSettings = defaultSettingsFor(indId);
    }
    return {
      join: $('stratPaneMoveJoin').value === 'or' ? 'or' : 'and',
      indId: indId,
      indSettings: indSettings,
      line: line,
      logic: $('stratPaneMoveLogic').value || 'incUp'
    };
  }

  function _loadPaneMoveIntoForm(pm) {
    if (!$('stratPaneMoveInd')) return;
    $('stratPaneMoveJoin').value = pm.join === 'or' ? 'or' : 'and';
    $('stratPaneMoveInd').value = pm.indId || '';
    populatePaneMoveLineSelect();
    if (pm.line && $('stratPaneMoveLine') && [...$('stratPaneMoveLine').options].some(o => o.value === pm.line)) {
      $('stratPaneMoveLine').value = pm.line;
    }
    $('stratPaneMoveLogic').value = pm.logic || 'incUp';
  }

  function savePaneMoveCondition() {
    if (!$('stratPaneMoveInd') || !$('stratPaneMoveInd').value) { alert('Select a pane indicator first'); return; }
    const pm = _readPaneMoveFromForm();
    if (!pm) return;
    if (_paneMoveEditingIdx >= 0) {
      const existing = _tempPaneMoves[_paneMoveEditingIdx];
      if (existing && existing.indId === pm.indId) {
        pm.indSettings = existing.indSettings;
      }
      _tempPaneMoves[_paneMoveEditingIdx] = pm;
    } else {
      _tempPaneMoves.push(pm);
    }
    _renderPaneMoveCondList();
    _clearPaneMoveCondForm();
  }

  function addPaneMoveCondition() {
    if (!_tempPaneMoves.length) { alert('Save the first movement condition before adding another'); return; }
    if ($('stratPaneMoveInd') && $('stratPaneMoveInd').value && _paneMoveEditingIdx < 0) savePaneMoveCondition();
    _clearPaneMoveCondForm();
  }

  function editPaneMoveCond(idx) {
    if (idx < 0 || idx >= _tempPaneMoves.length) return;
    if ($('stratPaneMoveInd') && $('stratPaneMoveInd').value && _paneMoveEditingIdx < 0) savePaneMoveCondition();
    _loadPaneMoveIntoForm(_tempPaneMoves[idx]);
    _paneMoveEditingIdx = idx;
  }

  function removePaneMoveCond(idx) {
    if (idx < 0 || idx >= _tempPaneMoves.length) return;
    _tempPaneMoves.splice(idx, 1);
    if (_paneMoveEditingIdx === idx) { _paneMoveEditingIdx = -1; _clearPaneMoveCondForm(); }
    else if (_paneMoveEditingIdx > idx) _paneMoveEditingIdx--;
    _renderPaneMoveCondList();
  }

  function _clearPaneMoveCondForm() {
    if ($('stratPaneMoveInd')) $('stratPaneMoveInd').value = '';
    if ($('stratPaneMoveJoin')) $('stratPaneMoveJoin').value = 'and';
    if ($('stratPaneMoveLogic')) $('stratPaneMoveLogic').value = 'incUp';
    populatePaneMoveLineSelect();
    _paneMoveEditingIdx = -1;
  }

  /* ---------------- end pane movement multi ---------------- */

  function editCond(prefix, idx) {
    const isEntry = prefix === 'entry';
    if (!isEntry && _exitReverseOn) return;
    const arr = isEntry ? _tempEntryConditions : _tempExitConditions;
    if (idx >= arr.length) return;
    if (isEntry && $('stratInd').value && _entryCondEditingIdx < 0) saveEntryCondition();
    if (!isEntry && $('exitInd').value && _exitCondEditingIdx < 0) saveExitCondition();
    const cond = arr[idx];
    _loadCondIntoForm(cond, isEntry);
    if (isEntry) _entryCondEditingIdx = idx; else _exitCondEditingIdx = idx;
    arr.splice(idx, 1);
    _renderCondList(isEntry ? 'entryCondList' : 'exitCondList', arr, prefix);
  }

  function removeCond(prefix, idx) {
    const isEntry = prefix === 'entry';
    if (!isEntry && _exitReverseOn) return;
    const arr = isEntry ? _tempEntryConditions : _tempExitConditions;
    if (idx >= arr.length) return;
    arr.splice(idx, 1);
    _renderCondList(isEntry ? 'entryCondList' : 'exitCondList', arr, prefix);
    if (isEntry) {
      if (_entryCondEditingIdx === idx) { _entryCondEditingIdx = -1; _clearCondForm(true); }
      else if (_entryCondEditingIdx > idx) _entryCondEditingIdx--;
      if (_exitReverseOn) syncReverseExitConditions();
    } else {
      if (_exitCondEditingIdx === idx) { _exitCondEditingIdx = -1; _clearCondForm(false); }
      else if (_exitCondEditingIdx > idx) _exitCondEditingIdx--;
    }
  }

  /* Update an entry condition's connector (AND/OR join + pane-movement gate). */
  function setEntryConn(idx, field, value) {
    const c = _tempEntryConditions[idx];
    if (!c) return;
    if (!c.conn) c.conn = { join: 'and', move: 'off' };
    c.conn[field] = value;
    _renderCondList('entryCondList', _tempEntryConditions, 'entry');
    if (_exitReverseOn) syncReverseExitConditions();
  }

  function syncBuilderFields() {
    refreshCmpTypeOptions('strat');
    refreshCmpTypeOptions('exit');
    refreshPaneConnFields();
    refreshPaneMoveFields();
    const entryIsPane = currentEntryIsPane() || _tempPaneConds.length > 0 || _tempPaneMoves.length > 0;
    show($('stratPaneConnWrap'), entryIsPane);
    show($('stratPaneMoveWrap'), entryIsPane);
    const cmpType = $('stratCmpType').value;
    show($('stratCmpIndWrap'), cmpType === 'indicator');
    show($('stratCmpCandleWrap'), cmpType === 'candle');
    show($('stratCmpNumWrap'), cmpType === 'number');
    show($('stratCmpSelfHint'), cmpType === 'plot' || cmpType === 'smoothed');
    if (cmpType === 'indicator') popIndicatorSelect($('stratCmpInd'), null);
    const ecmp = $('exitCmpType').value;
    show($('exitCmpIndWrap'), ecmp === 'indicator');
    show($('exitCmpCandleWrap'), ecmp === 'candle');
    show($('exitCmpNumWrap'), ecmp === 'number');
    show($('exitCmpSelfHint'), ecmp === 'plot' || ecmp === 'smoothed');
    show($('exitCmpCandlePatternWrap'), ecmp === 'candlestick_pattern');
    if (ecmp === 'candlestick_pattern') renderExitPatternGrid($('stratCat').value);
    if (ecmp === 'indicator') popIndicatorSelect($('exitCmpInd'), null);
    const auto = $('lotAuto').value === 'yes';
    show($('lotBasisWrap'), auto);
    show($('lotManualWrap'), !auto);

    const hasEntry = _tempEntryConditions.length > 0;
    const builderVisible = !$('strategyBuilder').classList.contains('hidden');
    const showGap = builderVisible && !_exitReverseOn;
    show($('exitReverseNote'), _exitReverseOn && builderVisible);
    show($('exitManualWrap'), !_exitReverseOn);
    show($('entryGapSection'), builderVisible);
    show($('exitGapSection'), showGap);
    const gapWasHidden = hasEntry && $('entryGapSection').classList.contains('hidden');
    if ($('entryGapToggle')) { $('entryGapToggle').disabled = !hasEntry; }
    if ($('exitGapToggle')) { $('exitGapToggle').disabled = !hasEntry; }
    if (gapWasHidden) {
      refreshGapGateDropdowns();
    }

    const entryGapOn = hasEntry && $('entryGapToggle').checked;
    show($('entryGapBody'), entryGapOn);
    const exitGapOn = hasEntry && $('exitGapToggle').checked;
    show($('exitGapBody'), exitGapOn);
    if (exitGapOn) refreshExitGapRows();
    const gateOn = $('gateToggle').checked;
    show($('gateBody'), gateOn);
    if (gateOn) renderGateSection();
    const candleOn = $('candleToggle').checked;
    show($('candleBody'), candleOn);
    if (candleOn) renderCandlestickSection($('stratCat').value);
    updateIndValLabels();
    updateLiveReading();
  }

  function updateIndValLabels() {
    const eLbl = $('stratIndValLabel');
    const xLbl = $('exitIndValLabel');
    const eIndId = $('stratInd').value;
    const xIndId = $('exitInd').value;
    if (eLbl) eLbl.textContent = (isMiddleIndicator(eIndId) ? 'Middle Band' : 'Indicator Value') + ' (' + primaryInputLabel(eIndId) + ')';
    if (xLbl) xLbl.textContent = (isMiddleIndicator(xIndId) ? 'Middle Band' : 'Indicator Value') + ' (' + primaryInputLabel(xIndId) + ')';
    const ecLbl = $('stratCmpValLabel');
    const xcLbl = $('exitCmpValLabel');
    const ecIndId = $('stratCmpInd').value;
    const xcIndId = $('exitCmpInd').value;
    if (ecLbl) ecLbl.textContent = 'Comparator Value (' + primaryInputLabel(ecIndId) + ')';
    if (xcLbl) xcLbl.textContent = 'Comparator Value (' + primaryInputLabel(xcIndId) + ')';
  }

  function getIndInfo(indId, indVal) {
    if (!indId) return null;
    const def = (window.IndChart && IndChart.IND) ? IndChart.IND[indId] : null;
    const name = def ? def.name : indId;
    const label = primaryInputLabel(indId);
    const val = indVal || (def && def.inputs && def.inputs.length ? def.inputs[0].def : '');
    return { id: indId, name, label, val };
  }

  function getBuilderEntryIndicators() {
    const indId = $('stratInd').value;
    const valEl = $('stratIndVal');
    const indVal = valEl ? valEl.value : '';
    return getIndInfo(indId, indVal);
  }

  function getBuilderExitIndicators() {
    const indId = $('exitInd').value;
    const valEl = $('exitIndVal');
    const indVal = valEl ? valEl.value : '';
    return getIndInfo(indId, indVal);
  }

  function refreshGapGateDropdowns() {
    _populateAllGapIndSelectors();
    document.querySelectorAll('#entryGapRows .gap-ind-sel, #exitGapRows .gap-ind-sel').forEach(sel => {
      if (sel.value) _onGapIndChange(sel);
    });
    renderGateSection();
  }

  function oppositeLogic(logic) {
    const map = { inc:'dec', dec:'inc', uptrend:'downtrend', downtrend:'uptrend', above:'below', below:'above' };
    return map[logic] || logic;
  }

  function fillGapFields(gap, prefix) {
    if (!gap) gap = { enabled: false, pair: [], st: [], band: [] };
    const t = $(prefix + 'Toggle');
    const b = $(prefix + 'Body');
    if (t) t.checked = !!gap.enabled;
    if (b) show(b, !!gap.enabled);

    if (prefix === 'exitGap') {
      const entryGap = $('entryGapToggle') && $('entryGapToggle').checked;
      if (entryGap) {
        const entryRows = collectGapFields('entryGap');
        fillGapRows(prefix + 'Rows', entryRows, true);
        return;
      }
    }

    fillGapRows(prefix + 'Rows', gap, false);
  }

  function fillGapRows(containerId, gapData, isExit) {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (isExit) {
      renderExitGapLines(container, gapData);
      return;
    }

    container.innerHTML = '';
    const allConds = [];
    (gapData.pair || []).forEach(c => allConds.push({ indId: c.primary, indVal: c.primaryVal, logic: c.logic, comparator: c.comparator, cmpVal: c.comparatorVal, cat: 'pair' }));
    (gapData.st || []).forEach(c => allConds.push({ indId: c.trend, indVal: c.trendVal, logic: c.logic, cat: 'st' }));
    (gapData.band || []).forEach(c => allConds.push({ indId: c.indicator, indVal: c.indicatorVal, candleLogic: c.candleLogic, gapLogic: c.gapLogic, cat: 'band' }));

    if (!allConds.length) {
      addGapRow(containerId, 'auto');
      return;
    }

    allConds.forEach(c => {
      const div = document.createElement('div');
      div.innerHTML = gapRowHtml();
      const row = div.firstElementChild;
      if (!row) return;
      const indSel = row.querySelector('.gap-ind-sel');
      if (indSel) indSel.value = c.indId || '';
      container.appendChild(row);
    });
    _populateAllGapIndSelectors();
    document.querySelectorAll('#' + containerId + ' .gap-ind-sel').forEach((sel, i) => {
      const c = allConds[i];
      if (!c) return;
      _onGapIndChange(sel);
      const row = sel.parentElement;
      if (!row) return;
      const logicSel = row.querySelector('.gap-logic-sel');
      if (logicSel) {
        if (c.cat === 'st' && c.logic) logicSel.value = c.logic;
        else if (c.cat === 'pair' && c.logic) logicSel.value = c.logic;
        else if (c.cat === 'band' && c.gapLogic) logicSel.value = c.gapLogic;
      }
      if (c.cat === 'pair' && c.comparator) {
        const cmpSel = row.querySelector('.gap-cmp-sel');
        if (cmpSel) cmpSel.value = c.comparator;
      }
      if (c.cat === 'band' && c.candleLogic) {
        const candleSel = row.querySelector('.gap-candle-sel');
        if (candleSel) candleSel.value = c.candleLogic;
      }
    });
  }

  function renderExitGapLines(container, gapData) {
    container.innerHTML = '';
    const allConds = [];
    (gapData.pair || []).forEach(c => allConds.push({ indId: c.primary, indVal: c.primaryVal, logic: oppositeLogic(c.logic), comparator: c.comparator, cat: 'pair' }));
    (gapData.st || []).forEach(c => allConds.push({ indId: c.trend, indVal: c.trendVal, logic: oppositeLogic(c.logic), cat: 'st' }));
    (gapData.band || []).forEach(c => allConds.push({ indId: c.indicator, indVal: c.indicatorVal, candleLogic: oppositeLogic(c.candleLogic), gapLogic: oppositeLogic(c.gapLogic), cat: 'band' }));

    if (!allConds.length) {
      container.innerHTML = '<div class="gap-info-line" style="color:#666;font-size:10px">No entry gap conditions configured</div>';
      return;
    }

    allConds.forEach(c => {
      const line = document.createElement('div');
      line.className = 'gap-info-line';
      line.style.cssText = 'padding:3px 0;font-size:10px;color:#00d4aa;border-bottom:1px solid #1a1a30';
      const def = (window.IndChart && IndChart.IND) ? IndChart.IND[c.indId] : null;
      const name = def ? def.name : (c.indId || '').toUpperCase();
      const val = c.indVal != null ? ' (' + c.indVal + ')' : '';
      let desc = name + val;

      if (c.cat === 'pair') {
        desc += ' Gap ' + (c.logic === 'inc' ? 'Increasing' : 'Decreasing');
        if (c.comparator) {
          const clabels = { candle_close:'Candle Close', candle_high:'Candle High', candle_low:'Candle Low', candle_open:'Candle Open' };
          const cmpLabel = clabels[c.comparator] || (c.comparator || '').toUpperCase();
          desc += ' > ' + cmpLabel;
        }
      } else if (c.cat === 'st') {
        desc += ' In ' + (c.logic === 'uptrend' ? 'Uptrend' : 'Downtrend');
      } else if (c.cat === 'band') {
        desc += ' ' + (c.candleLogic === 'above' ? 'Above' : 'Below') + ' Candle, Gap ' + (c.gapLogic === 'inc' ? 'Increasing' : 'Decreasing');
      }

      line.textContent = desc;
      container.appendChild(line);
    });
  }

  function disableGapRowControls(container) {
    container.querySelectorAll('select, button').forEach(el => {
      el.disabled = true;
    });
  }

  function refreshExitGapRows() {
    if (!$('exitGapBody')) return;
    if ($('exitGapBody').classList.contains('hidden')) return;
    if (!$('entryGapToggle') || !$('entryGapToggle').checked) return;
    const entryData = collectGapFields('entryGap');
    fillGapRows('exitGapRows', entryData, true);
  }

  function collectRows(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return [];
    const rows = container.querySelectorAll('.gap-row');
    const result = [];
    rows.forEach(row => {
      const indSel = row.querySelector('.gap-ind-sel');
      const indId = indSel ? indSel.value : '';
      if (!indId) return;
      const cond = _tempEntryConditions.find(c => c.indId === indId);
      const indVal = cond ? cond.indValue : null;
      const pairIds = ['ema','ma','smma'];
      const bandIds = ['bb','pc'];
      if (pairIds.includes(indId)) {
        const logicSel = row.querySelector('.gap-logic-sel');
        const cmpSel = row.querySelector('.gap-cmp-sel');
        const cmpVal = cmpSel ? cmpSel.value : '';
        const candleKeys = ['candle_close','candle_high','candle_low','candle_open'];
        const isCandle = candleKeys.includes(cmpVal);
        const cmpCond = !isCandle && cmpVal ? _tempEntryConditions.find(c => c.indId === cmpVal) : null;
        result.push({
          indId, indVal, cat: 'pair',
          logic: logicSel ? logicSel.value : 'inc',
          comparator: cmpVal,
          comparatorVal: isCandle ? (cmpVal) : (cmpCond ? cmpCond.indValue : null)
        });
      } else if (indId === 'supertrend') {
        const logicSel = row.querySelector('.gap-logic-sel');
        result.push({ indId, indVal, cat: 'st', logic: logicSel ? logicSel.value : 'uptrend' });
      } else if (bandIds.includes(indId)) {
        const candleSel = row.querySelector('.gap-candle-sel');
        const logicSel = row.querySelector('.gap-logic-sel');
        result.push({
          indId, indVal, cat: 'band',
          candleLogic: candleSel ? candleSel.value : 'above',
          gapLogic: logicSel ? logicSel.value : 'inc'
        });
      }
    });
    return result;
  }

  function collectGapFields(prefix) {
    const containerId = prefix + 'Rows';
    const isExit = prefix === 'exitGap';
    if (isExit) {
      const entryEnabled = $('entryGapToggle').checked;
      if (entryEnabled) {
        const entryData = collectRows('entryGapRows');
        return _rowsToGap(entryData, true);
      }
      return { enabled: false, pair: [], st: [], band: [] };
    }
    const enabled = $('entryGapToggle').checked;
    if (!enabled) return { enabled: false, pair: [], st: [], band: [] };
    return _rowsToGap(collectRows(containerId), false);
  }

  function _rowsToGap(rows, isExit) {
    const pair = [];
    const st = [];
    const band = [];
    rows.forEach(r => {
      const pairIds = ['ema','ma','smma'];
      const bandIds = ['bb','pc'];
      if (pairIds.includes(r.indId)) {
        pair.push({
          primary: r.indId, primaryVal: r.indVal,
          logic: isExit ? oppositeLogic(r.logic) : r.logic,
          comparator: r.comparator || '', comparatorVal: r.comparatorVal
        });
      } else if (r.indId === 'supertrend') {
        st.push({
          trend: r.indId, trendVal: r.indVal,
          logic: isExit ? oppositeLogic(r.logic) : r.logic
        });
      } else if (bandIds.includes(r.indId)) {
        band.push({
          indicator: r.indId, indicatorVal: r.indVal,
          candleLogic: isExit ? oppositeLogic(r.candleLogic) : r.candleLogic,
          gapLogic: isExit ? oppositeLogic(r.gapLogic) : r.gapLogic
        });
      }
    });
    return { enabled: true, pair, st, band };
  }

  function collectGateFields() {
    const enabled = $('gateToggle').checked;
    const patterns = [];
    if (enabled) {
      const pGrid = $('gatePatternGrid');
      if (pGrid) pGrid.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        if (cb.checked) patterns.push(cb.dataset.key);
      });
      _gatePatterns = patterns.slice();
    }
    return { enabled, conds: enabled ? collectGateConds() : [], patterns };
  }

  function gapRowHtml() {
    return '<div class="gap-row">' +
      '<select class="gap-ind-sel"><option value="">-- Select Indicator --</option></select>' +
      '<span class="gap-arrow">&gt;</span>' +
      '<span class="gap-logic-area"></span>' +
      '<button class="gap-row-remove" type="button">x</button>' +
    '</div>';
  }

  function gapLogicHtml(indId, isExit) {
    const pairIds = ['ema','ma','smma'];
    const bandIds = ['bb','pc'];
    if (pairIds.includes(indId)) {
      return '<select class="gap-logic-sel">' +
        '<option value="inc">Gap Increasing</option>' +
        '<option value="dec">Gap Decreasing</option>' +
      '</select>' +
      '<span class="gap-arrow">&gt;</span>' +
      '<select class="gap-cmp-sel"><option value="">-- Select Comparator --</option></select>';
    }
    if (indId === 'supertrend') {
      return '<select class="gap-logic-sel">' +
        '<option value="uptrend">In Uptrend</option>' +
        '<option value="downtrend">In Downtrend</option>' +
      '</select>';
    }
    if (bandIds.includes(indId)) {
      return '<select class="gap-candle-sel">' +
        '<option value="above">Above Candle</option>' +
        '<option value="below">Below Candle</option>' +
      '</select>' +
      '<span class="gap-arrow">&gt;</span>' +
      '<select class="gap-logic-sel">' +
        '<option value="inc">Gap Increasing</option>' +
        '<option value="dec">Gap Decreasing</option>' +
      '</select>';
    }
    return '';
  }

  function _populateAllGapIndSelectors() {
    const allConds = [..._tempEntryConditions];
    const selectors = [
      ...document.querySelectorAll('#entryGapRows .gap-ind-sel'),
      ...document.querySelectorAll('#exitGapRows .gap-ind-sel')
    ];
    selectors.forEach(sel => {
      const cur = sel.value;
      sel.innerHTML = '<option value="">-- Select Indicator --</option>';
      const seen = new Set();
      allConds.forEach(c => {
        if (!c.indId || seen.has(c.indId)) return;
        seen.add(c.indId);
        const def = (window.IndChart && IndChart.IND) ? IndChart.IND[c.indId] : null;
        const name = def ? def.name : c.indId;
        const inp = primaryInput(c.indId);
        const label = inp ? inp.label || inp.key : 'Value';
        const displayVal = c.indValue || (inp ? String(c.indSettings[inp.key] != null ? c.indSettings[inp.key] : inp.def) : '');
        sel.innerHTML += '<option value="' + c.indId + '">' + name + ' (' + label + ': ' + displayVal + ')</option>';
      });
      if (cur && [...sel.options].some(o => o.value === cur)) sel.value = cur;
    });
  }

  function _populateGapComparators(row) {
    const indSel = row.querySelector('.gap-ind-sel');
    if (!indSel) return;
    const indId = indSel.value;
    const pairIds = ['ema','ma','smma'];
    if (!pairIds.includes(indId)) return;
    const cmpSel = row.querySelector('.gap-cmp-sel');
    if (!cmpSel) return;
    const cur = cmpSel.value;
    const allConds = [..._tempEntryConditions];
    cmpSel.innerHTML = '<option value="">-- Select --</option>' +
      '<option value="candle_close">Candle Close</option>' +
      '<option value="candle_high">Candle High</option>' +
      '<option value="candle_low">Candle Low</option>' +
      '<option value="candle_open">Candle Open</option>';
    const seen = new Set();
    allConds.forEach(c => {
      if (!pairIds.includes(c.indId) || c.indId === indId || seen.has(c.indId)) return;
      seen.add(c.indId);
      const inp = primaryInput(c.indId);
      const label = inp ? inp.label || inp.key : 'Value';
      const name = c.indId === 'ema' ? 'EMA' : c.indId.toUpperCase();
      cmpSel.innerHTML += '<option value="' + c.indId + '">' + name + ' (' + label + ': ' + c.indValue + ')</option>';
    });
    if (cur && [...cmpSel.options].some(o => o.value === cur)) cmpSel.value = cur;
  }

  function _onGapIndChange(sel) {
    const row = sel.parentElement;
    if (!row) return;
    const area = row.querySelector('.gap-logic-area');
    if (!area) return;
    const isExit = row.closest('#exitGapRows') !== null;
    area.innerHTML = gapLogicHtml(sel.value, isExit);
    _populateGapComparators(row);
    if (!isExit) refreshExitGapRows();
  }

  function removeGapRow(btn) {
    const row = btn.closest('.gap-row');
    if (!row) return;
    const isEntry = row.closest('#entryGapRows') !== null;
    row.remove();
    if (isEntry) refreshExitGapRows();
  }

  function addGapRow(containerId, type) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const div = document.createElement('div');
    div.innerHTML = gapRowHtml();
    const row = div.firstElementChild;
    if (!row) return;
    const indSel = row.querySelector('.gap-ind-sel');
    if (indSel) indSel.addEventListener('change', function() { _onGapIndChange(this); });
    container.appendChild(row);
    _populateAllGapIndSelectors();
  }

  let _savedGapConditions = [];

  function saveGapCondition() {
    const rows = collectRows('entryGapRows');
    const valid = rows.filter(r => r.indId && r.logic);
    if (!valid.length) { alert('Complete at least one gap condition before saving'); return; }
    _savedGapConditions = rows;
    refreshExitGapRows();
    alert('Gap condition saved (' + valid.length + ' condition' + (valid.length > 1 ? 's' : '') + ')');
  }

  function fillGateFields(gate) {
    if (!gate) gate = {};
    if ($('gateToggle')) $('gateToggle').checked = !!gate.enabled;
    _gatePatterns = (gate.patterns && gate.patterns.length) ? gate.patterns.slice() : [];
    fillGateConds(gate.conds || []);
  }

  function fillBuilder(strat) {
    editId = strat ? strat.id : null;
    _entryCondEditingIdx = -1;
    _exitCondEditingIdx = -1;
    _tempEntryConditions = [];
    _tempExitConditions = [];
    _exitReverseOn = !!(strat && strat.exitReverse);
    selectedTf = strat ? strat.tf : '5min';
    $('stratName').value = strat ? strat.name : '';
    $('stratCat').value = strat && strat.cat ? strat.cat : 'bullish';

    if (strat) {
      _tempEntryConditions.push({
        indId: strat.entry.indId || '', indSettings: strat.entry.indSettings || {},
        indValue: strat.entry.indValue, valueKey: strat.entry.valueKey || 'v0',
        logic: strat.entry.logic || 'gt', cmpType: strat.entry.cmpType || 'number',
        cmpIndId: strat.entry.cmpIndId || '', cmpSettings: strat.entry.cmpSettings || {},
        cmpIndValue: strat.entry.cmpIndValue, cmpValueKey: strat.entry.cmpValueKey || 'v0',
        candleKey: strat.entry.candleKey || 'close', number: strat.entry.number != null ? strat.entry.number : 0,
        paneCond: strat.entry.paneCond ? JSON.parse(JSON.stringify(strat.entry.paneCond)) : null,
        paneConds: strat.entry.paneConds ? JSON.parse(JSON.stringify(strat.entry.paneConds)) : null,
        paneMove: strat.entry.paneMove ? JSON.parse(JSON.stringify(strat.entry.paneMove)) : null,
        paneMoves: strat.entry.paneMoves ? JSON.parse(JSON.stringify(strat.entry.paneMoves)) : null
      });
      if (Array.isArray(strat.entry.chain)) {
        strat.entry.chain.forEach(c => _tempEntryConditions.push({
          indId: c.indId || '', indSettings: c.indSettings || {},
          indValue: '', valueKey: c.valueKey || 'v0',
          logic: c.logic || 'gt', cmpType: c.cmpType || 'number',
          cmpIndId: c.cmpIndId || '', cmpSettings: c.cmpSettings || {},
          cmpIndValue: '', cmpValueKey: c.cmpValueKey || 'v0',
          candleKey: c.candleKey || 'close', number: c.number != null ? c.number : 0,
          candlePatterns: c.candlePatterns || [],
          conn: c.conn ? { join: c.conn.join === 'or' ? 'or' : 'and', move: c.conn.move || 'off' } : { join: 'and', move: 'off' }
        }));
      }
      _tempExitConditions = _exitReverseOn ? _tempEntryConditions.map(reverseCondition).filter(Boolean) : [];
      if (!_exitReverseOn) {
        _tempExitConditions.push({
          indId: strat.exit.indId || '', indSettings: strat.exit.indSettings || {},
          indValue: strat.exit.indValue, valueKey: strat.exit.valueKey || 'v0',
          logic: strat.exit.logic || 'lt', cmpType: strat.exit.cmpType || 'candle',
          cmpIndId: strat.exit.cmpIndId || '', cmpSettings: strat.exit.cmpSettings || {},
          cmpIndValue: strat.exit.cmpIndValue, cmpValueKey: strat.exit.cmpValueKey || 'v0',
          candleKey: strat.exit.candleKey || 'close', number: strat.exit.number != null ? strat.exit.number : 0,
          candlePatterns: strat.exit.candlePatterns || [],
          paneCond: strat.exit.paneCond ? JSON.parse(JSON.stringify(strat.exit.paneCond)) : null,
          paneConds: strat.exit.paneConds ? JSON.parse(JSON.stringify(strat.exit.paneConds)) : null
        });
      }
      if (!_exitReverseOn && Array.isArray(strat.exit.chain)) {
        strat.exit.chain.forEach(c => _tempExitConditions.push({
          indId: c.indId || '', indSettings: c.indSettings || {},
          indValue: '', valueKey: c.valueKey || 'v0',
          logic: c.logic || 'lt', cmpType: c.cmpType || 'candle',
          cmpIndId: c.cmpIndId || '', cmpSettings: c.cmpSettings || {},
          cmpIndValue: '', cmpValueKey: c.cmpValueKey || 'v0',
          candleKey: c.candleKey || 'close', number: c.number != null ? c.number : 0,
          candlePatterns: c.candlePatterns || []
        }));
      }
      _renderCondList('entryCondList', _tempEntryConditions, 'entry');
      _renderCondList('exitCondList', _tempExitConditions, 'exit', _exitReverseOn);
    } else {
      _renderCondList('entryCondList', [], 'entry');
      _renderCondList('exitCondList', [], 'exit');
    }

    let _strikeMode = strat ? strat.strike.mode : 'both_atm';
    if (_strikeMode === 'band') _strikeMode = 'both_atm';
    $('strikeMode').value = _strikeMode;
    $('strikeCount').value = strat ? strat.strike.count : 3;
    $('optionType').value = strat ? strat.strike.optionType : 'both';
    $('lotAuto').value = strat ? (strat.lot.auto ? 'yes' : 'no') : 'yes';
    $('lotBasis').value = strat ? strat.lot.basis : 'OI';
    $('lotPct').value = strat ? strat.lot.pct : 1;
    $('lotManual').value = strat ? strat.lot.manualQty : 1;
    document.querySelectorAll('#stratTfGrid .tf-btn').forEach(b => b.classList.toggle('active', b.dataset.tf === selectedTf));
    refreshIndicatorSelects();
    refreshGapGateDropdowns();
    fillGapFields(strat ? (strat.entry.gap || {}) : {}, 'entryGap');
    fillGapFields(strat ? (strat.exit.gap || {}) : {}, 'exitGap');
    fillGateFields(strat ? (strat.gate || {}) : {});
    _loadPatternCheckboxes(strat ? (strat.candlestick || {}) : null);
    $('candleToggle').checked = !!(strat && strat.candlestick && strat.candlestick.enabled);
    const _revToggle = $('exitReverseToggle');
    if (_revToggle) _revToggle.checked = _exitReverseOn;
    syncBuilderFields();
    show($('strategyBuilder'), true);
    $('strategyBuilder').scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function refreshIndicatorSelects() {
    popIndicatorSelect($('stratInd'), null);
    popIndicatorSelect($('exitInd'), null);
    popIndicatorSelect($('stratCmpInd'), null);
    popIndicatorSelect($('exitCmpInd'), null);
    syncBuilderFields();
  }

  function defaultSettingsFor(indId) {
    const def = (window.IndChart && IndChart.IND) ? IndChart.IND[indId] : null;
    if (!def) return {};
    const d = {};
    (def.inputs || []).forEach(i => { d[i.key] = i.def; });
    (def.style || []).forEach(s => { d[s.key] = s.def; });
    return d;
  }

  /* Refresh the builder's logic dropdown. The "andFirst" logic (combine this
     condition with the first saved condition) is only meaningful once a first
     condition exists, so hide it while editing/adding the first one. */
  function refreshLogicOptions(prefix) {
    const sel = $(prefix + 'Logic');
    if (!sel) return;
    const cur = sel.value;
    const isEntry = prefix === 'strat';
    const arr = isEntry ? _tempEntryConditions : _tempExitConditions;
    const idx = isEntry ? _entryCondEditingIdx : _exitCondEditingIdx;
    const isFirst = idx === 0 || (idx < 0 && arr.length === 0);
    let ops = LOGIC_OPS;
    if (isFirst) ops = ops.filter(op => op[0] !== 'andFirst');
    sel.innerHTML = ops.map(([v, l]) => '<option value="' + v + '">' + l + '</option>').join('');
    if (cur && [...sel.options].some(o => o.value === cur)) sel.value = cur;
    else sel.value = prefix === 'exit' ? 'lt' : 'gt';
  }

  /* Current settings typed into the primary indicator's inputs container. */
  function collectSettingsFromForm(prefix) {
    const container = document.getElementById(prefix === 'strat' ? 'stratIndInputs' : 'exitIndInputs');
    const s = {};
    if (container) {
      container.querySelectorAll('.ind-inp').forEach(el => {
        const key = el.dataset.key;
        if (!key) return;
        s[key] = el.tagName === 'SELECT' ? el.value : (isNaN(Number(el.value)) ? el.value : Number(el.value));
      });
    }
    return s;
  }

  /* True when the pane indicator has a "Smoothed MA" series available to compare
     against (read as the indicator's own v1 line). True when either:
       - the indicator has an explicit smoothed-length setting enabled (e.g. RSI
         with "Smoothed MA length" > 0), or
       - the indicator draws a second series at all (MACD Signal, ADX, SMI, PPO,
         OBV, Bollinger / price channel middle band, ...). */
  function indHasSmoothedSeries(indId, settings) {
    const def = indId && window.IndChart && IndChart.IND ? IndChart.IND[indId] : null;
    if (!def || def.type !== 'pane') return false;
    if (Array.isArray(def.inputs)) {
      for (const inp of def.inputs) {
        if (!/smoothed/i.test(inp.label || '')) continue;
        const v = settings && settings[inp.key] != null ? settings[inp.key] : inp.def;
        if (Number(v) > 0) return true;
      }
    }
    if (window.IndChart && IndChart.valueOptionsFor) {
      const opts = IndChart.valueOptionsFor(indId);
      if (Array.isArray(opts) && opts.length > 1) return true;
    }
    return false;
  }

  /* Line series available for a pane indicator, keyed by series key. The labels
     mirror what the pane actually draws (MACD line + Signal line, RSI + Smoothed
     MA, OBV + Signal line, ...). Histogram series are excluded - they aren't
     lines and can't be compared / crossed meaningfully. */
  const PANE_LINE_OPTS = {
    adx: [['v0', 'ADX'], ['v1', '+DI'], ['v2', '-DI']],
    macd: [['v0', 'MACD line'], ['v1', 'Signal line']],
    rsi: [['v0', 'RSI'], ['v1', 'Smoothed MA']],
    smiio: [['v0', 'SMI'], ['v1', 'Signal'], ['v2', 'Histogram']],
    ppo: [['v0', 'PPO'], ['v1', 'Signal']],
    obv: [['v0', 'OBV'], ['v1', 'Signal line']]
  };

  function paneLineOptions(indId) {
    if (PANE_LINE_OPTS[indId]) return PANE_LINE_OPTS[indId];
    if (window.IndChart && IndChart.valueOptionsFor) {
      const opts = IndChart.valueOptionsFor(indId);
      if (Array.isArray(opts) && opts.length) return opts;
    }
    return [['v0', 'Value']];
  }

  /* Human label of a pane indicator's series key (e.g. macd + 'v1' -> "Signal line"). */
  function lineLabel(indId, key) {
    const opts = paneLineOptions(indId);
    const o = opts.find(x => x[0] === key);
    return o ? o[1] : (key || '');
  }

  /* Labels used for the primary indicator's own series in the "Compare Against"
     dropdown and the condition cards. Pane indicators show their actual line
     names (MACD line / Signal line) instead of the generic Plot / Smoothed MA. */
  function cmpSelfLabels(indId) {
    const opts = paneLineOptions(indId);
    return [opts[0][1], (opts[1] || [])[1] || 'Smoothed MA'];
  }

  /* Normalize a saved pane-line condition into a standard chain condition so the
     shared evaluation paths (chain connectors, CrossDetector chain) can use it.
     The comparison is between two series of the SAME pane indicator: lineA (the
     primary value) vs lineB (the comparator), joined by the pane condition's
     AND/OR connector. */
  function paneCondToCond(p) {
    return {
      indId: p.indId,
      indSettings: p.indSettings || {},
      valueKey: p.lineA || 'v0',
      logic: p.logic || 'crossAbove',
      cmpType: 'paneLine',
      paneLineB: p.lineB || 'v1',
      conn: { join: p.join === 'or' ? 'or' : 'and', move: 'off' }
    };
  }

  /* Compare-against options depend on the primary indicator type. Pane indicators
     can't be meaningfully compared to another indicator (different scales), so
     offer their own series (from the primary indicator's settings) instead. The
     option labels use the pane indicator's real line names (e.g. "MACD line" and
     "Signal line" for MACD). Overlay indicators keep the indicator comparison. */
  function refreshCmpTypeOptions(prefix) {
    const sel = $(prefix + 'CmpType');
    if (!sel) return;
    const cur = sel.value;
    const isExit = prefix === 'exit';
    const indId = $(prefix + 'Ind').value;
    const def = indId && window.IndChart && IndChart.IND ? IndChart.IND[indId] : null;
    const isPane = !!(def && def.type === 'pane');
    const opts = [
      ['number', 'Number (fixed value)'],
      ['candle', 'Candlestick value']
    ];
    if (isPane) {
      const labels = cmpSelfLabels(indId);
      opts.push(['plot', labels[0]]);
      if (indHasSmoothedSeries(indId, collectSettingsFromForm(prefix))) {
        opts.push(['smoothed', labels[1] || 'Smoothed MA']);
      }
    } else {
      opts.push(['indicator', 'Indicator (realtime reading)']);
    }
    if (isExit) opts.push(['candlestick_pattern', 'Candlestick Pattern (Reversal)']);
    sel.innerHTML = opts.map(([v, l]) => '<option value="' + v + '">' + l + '</option>').join('');
    if (cur && [...sel.options].some(o => o.value === cur)) sel.value = cur;
    else sel.value = isExit ? 'candle' : 'number';
  }

  function renderIndInputs(prefix) {
    const isEntry = prefix === 'strat';
    const container = document.getElementById(isEntry ? 'stratIndInputs' : 'exitIndInputs');
    if (!container) return;
    const indId = $(prefix + 'Ind').value;
    refreshLogicOptions(prefix);
    refreshCmpTypeOptions(prefix);
    if (!indId) { container.innerHTML = ''; return; }
    const def = (window.IndChart && IndChart.IND) ? IndChart.IND[indId] : null;
    if (!def || !def.inputs || !def.inputs.length) { container.innerHTML = ''; return; }
    const arr = isEntry ? _tempEntryConditions : _tempExitConditions;
    const idx = isEntry ? _entryCondEditingIdx : _exitCondEditingIdx;
    const saved = _editingCond ? (_editingCond.indSettings || {}) : (idx >= 0 && arr[idx] ? arr[idx].indSettings : {});
    let html = '';
    def.inputs.forEach(inp => {
      const val = saved[inp.key] != null ? saved[inp.key] : inp.def;
      html += '<div style="display:flex;align-items:center;gap:4px;margin-bottom:3px">';
      html += '<label style="font-size:9px;color:#888;white-space:nowrap;min-width:60px">' + (inp.label || inp.key) + '</label>';
      if (inp.options) {
        html += '<select class="ind-inp" data-key="' + inp.key + '" onchange="StratUI.syncFields()" style="flex:1;padding:4px 6px;background:#1a1a35;border:1px solid #2d2d50;color:#d0d0d0;border-radius:3px;font-size:10px">';
        inp.options.forEach(([v, label]) => {
          html += '<option value="' + v + '"' + (val === v ? ' selected' : '') + '>' + label + '</option>';
        });
        html += '</select>';
      } else if (typeof inp.def === 'number') {
        html += '<input type="number" class="ind-inp" data-key="' + inp.key + '" value="' + val + '" step="' + (inp.step || '1') + '" min="' + (inp.min || 1) + '" max="' + (inp.max || 9999) + '" onchange="StratUI.syncFields()" style="flex:1;padding:4px 6px;background:#1a1a35;border:1px solid #2d2d50;color:#d0d0d0;border-radius:3px;font-size:10px;outline:none">';
      }
      html += '</div>';
    });
    container.innerHTML = html;
  }

  /* ---------------- extra pane-line condition connector ---------------- */

  /* Populate the extra pane-line condition dropdowns in the entry builder:
     the pane-indicator select (pane indicators only) and its Line A / Line B
     line dropdowns. A "-- None --" option disables the extra condition. */
  function refreshPaneConnFields() {
    const sel = $('stratPaneInd');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">-- None --</option>';
    const list = (window.IndChart && IndChart.IND_LIST) ? IndChart.IND_LIST : [];
    const deployed = window.IndChart ? IndChart.getDeployedIndicators() : [];
    const seen = new Set();
    list.forEach(def => {
      if (!def || !def.id || seen.has(def.id) || def.type !== 'pane') return;
      seen.add(def.id);
      const o = document.createElement('option');
      o.value = def.id;
      o.textContent = def.name;
      sel.appendChild(o);
    });
    deployed.forEach(ind => {
      if (!ind || !ind.id || seen.has(ind.id)) return;
      const def = (window.IndChart && IndChart.IND) ? IndChart.IND[ind.id] : null;
      if (!def || def.type !== 'pane') return;
      seen.add(ind.id);
      const o = document.createElement('option');
      o.value = ind.id;
      o.textContent = (ind.name || ind.id) + ' (deployed)';
      sel.appendChild(o);
    });
    if (cur && [...sel.options].some(o => o.value === cur)) sel.value = cur;
    populatePaneLineSelects();
  }

  /* Fill the Line A / Line B dropdowns for the currently selected pane indicator. */
  function populatePaneLineSelects() {
    const indSel = $('stratPaneInd');
    const aSel = $('stratPaneLineA');
    const bSel = $('stratPaneLineB');
    if (!indSel || !aSel || !bSel) return;
    const indId = indSel.value;
    const opts = indId ? paneLineOptions(indId) : [];
    const curA = aSel.value, curB = bSel.value;
    aSel.innerHTML = opts.map(([v, l]) => '<option value="' + v + '">' + l + '</option>').join('');
    bSel.innerHTML = opts.map(([v, l]) => '<option value="' + v + '">' + l + '</option>').join('');
    if (opts.length) {
      if (curA && opts.some(o => o[0] === curA)) aSel.value = curA;
      else aSel.value = opts[0][0];
      if (curB && opts.some(o => o[0] === curB)) bSel.value = curB;
      else bSel.value = opts.length > 1 ? opts[1][0] : opts[0][0];
    }
  }

  function onPaneIndChange() {
    populatePaneLineSelects();
    syncBuilderFields();
  }

  /* ---------------- extra pane-line MOVEMENT connector ---------------- */

  /* Populate the pane-movement connector dropdowns in the entry builder:
     the pane-indicator select (pane indicators only) and a single line
     dropdown that lists ALL lines the selected pane indicator draws (e.g.
     MACD -> "MACD line" + "Signal line"). The movement gate then requires
     every listed line to be increasing upward / downward together. */
  function refreshPaneMoveFields() {
    const sel = $('stratPaneMoveInd');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">-- None --</option>';
    const list = (window.IndChart && IndChart.IND_LIST) ? IndChart.IND_LIST : [];
    const deployed = window.IndChart ? IndChart.getDeployedIndicators() : [];
    const seen = new Set();
    list.forEach(def => {
      if (!def || !def.id || seen.has(def.id) || def.type !== 'pane') return;
      seen.add(def.id);
      const o = document.createElement('option');
      o.value = def.id;
      o.textContent = def.name;
      sel.appendChild(o);
    });
    deployed.forEach(ind => {
      if (!ind || !ind.id || seen.has(ind.id)) return;
      const def = (window.IndChart && IndChart.IND) ? IndChart.IND[ind.id] : null;
      if (!def || def.type !== 'pane') return;
      seen.add(ind.id);
      const o = document.createElement('option');
      o.value = ind.id;
      o.textContent = (ind.name || ind.id) + ' (deployed)';
      sel.appendChild(o);
    });
    if (cur && [...sel.options].some(o => o.value === cur)) sel.value = cur;
    populatePaneMoveLineSelect();
  }

  /* Fill the single line dropdown with every line of the selected pane
     indicator (e.g. MACD -> MACD line + Signal line in one dropdown). */
  function populatePaneMoveLineSelect() {
    const indSel = $('stratPaneMoveInd');
    const lineSel = $('stratPaneMoveLine');
    if (!indSel || !lineSel) return;
    const indId = indSel.value;
    const opts = indId ? paneLineOptions(indId) : [];
    const cur = lineSel.value;
    lineSel.innerHTML = opts.map(([v, l]) => '<option value="' + v + '">' + l + '</option>').join('');
    if (opts.length) {
      if (cur && opts.some(o => o[0] === cur)) lineSel.value = cur;
      else lineSel.value = opts[0][0];
    }
  }

  function onPaneMoveIndChange() {
    populatePaneMoveLineSelect();
    syncBuilderFields();
  }

  /* ---------------- candlestick pattern section ---------------- */
  const BULLISH_ENTRY_PATTERNS = [
    'bullish_engulfing', 'hammer', 'morning_star', 'piercing_line',
    'three_white_soldiers', 'bullish_harami', 'rising_three_methods',
    'doji_bullish', 'tweezers_bottom', 'inverted_hammer'
  ];
  const BULLISH_EXIT_PATTERNS = [
    'bearish_engulfing', 'shooting_star', 'evening_star', 'dark_cloud_cover',
    'three_black_crows', 'bearish_harami', 'falling_three_methods',
    'doji_bearish', 'tweezers_top', 'hanging_man'
  ];

  function renderCandlestickSection(cat) {
    const CP = window.CandlePatterns;
    if (!CP) return;
    const isBull = cat === 'bullish';
    const entryKeys = isBull ? BULLISH_ENTRY_PATTERNS : BULLISH_EXIT_PATTERNS;
    const exitKeys = isBull ? BULLISH_EXIT_PATTERNS : BULLISH_ENTRY_PATTERNS;
    const eTitle = $('candleEntryTitle'), xTitle = $('candleExitTitle');
    const hint = $('candleHint');
    if (eTitle) eTitle.textContent = isBull ? 'Entry Patterns (Bullish)' : 'Entry Patterns (Bearish)';
    if (xTitle) xTitle.textContent = isBull ? 'Exit / Reversal Patterns (Bearish → Signal Reversal)' : 'Exit / Reversal Patterns (Bullish → Signal Reversal)';
    if (hint) hint.textContent = isBull ? 'Select confirmation patterns for bullish entry and reversal patterns for exit.' : 'Select confirmation patterns for bearish entry and reversal patterns for exit.';

    const savedEntry = (_candleEntry || []).slice();
    const savedExit = (_candleExit || []).slice();

    renderPatternGrid($('candleEntryPatterns'), entryKeys, savedEntry, CP);
    renderPatternGrid($('candleExitPatterns'), exitKeys, savedExit, CP);
  }

  function renderPatternGrid(container, keys, saved, CP) {
    if (!container) return;
    let html = '';
    keys.forEach(k => {
      const p = CP.PATTERNS[k];
      if (!p) return;
      const checked = saved.indexOf(k) >= 0;
      html += '<div class="cp-item' + (checked ? ' checked' : '') + '" onclick="(function(el){el.classList.toggle(\'checked\');var cb=el.querySelector(\'input\');cb.checked=!cb.checked;StratUI._candleChanged();})(this)">';
      html += '<input type="checkbox" data-key="' + k + '" ' + (checked ? 'checked' : '') + ' onclick="event.stopPropagation();StratUI._candleChanged()">';
      html += '<label>' + p.name + '</label>';
      html += '<span class="cp-rate">' + p.winRate + '%</span>';
      html += '</div>';
    });
    container.innerHTML = html;
  }

  function collectCandlestickPatterns() {
    const entry = [], exit = [];
    const eGrid = $('candleEntryPatterns');
    const xGrid = $('candleExitPatterns');
    if (eGrid) eGrid.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      if (cb.checked) entry.push(cb.dataset.key);
    });
    if (xGrid) xGrid.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      if (cb.checked) exit.push(cb.dataset.key);
    });
    return { entry, exit };
  }

  function _loadPatternCheckboxes(patterns) {
    _candleEntry = (patterns && patterns.entry) ? patterns.entry.slice() : [];
    _candleExit = (patterns && patterns.exit) ? patterns.exit.slice() : [];
  }

  let _candleEntry = [];
  let _candleExit = [];
  let _exitCandlePatterns = [];
  let _gatePatterns = [];
  let _gateConds = [];

  function gateIndOptions() {
    const seen = new Set();
    const out = [];
    _tempEntryConditions.forEach(c => {
      if (c && c.indId && !seen.has(c.indId)) {
        seen.add(c.indId);
        out.push({ indId: c.indId, indSettings: c.indSettings, indValue: c.indValue, valueKey: c.valueKey || 'v0' });
      }
      if (c && c.cmpType === 'indicator' && c.cmpIndId && !seen.has(c.cmpIndId)) {
        seen.add(c.cmpIndId);
        out.push({ indId: c.cmpIndId, indSettings: c.cmpSettings, indValue: c.cmpIndValue, valueKey: c.cmpValueKey || 'v0' });
      }
    });
    return out;
  }

  function gateIndHtml(sel, skipId) {
    const cur = sel ? sel.value : '';
    let html = '<option value="">-- Select Indicator --</option>';
    gateIndOptions().forEach(o => {
      if (o.indId === skipId) return;
      const def = (window.IndChart && IndChart.IND) ? IndChart.IND[o.indId] : null;
      const name = def ? def.name : o.indId;
      const inp = primaryInput(o.indId);
      const label = inp ? (inp.label || inp.key) : 'Value';
      const v = o.indValue != null ? o.indValue : (inp ? String(o.indSettings[inp.key] != null ? o.indSettings[inp.key] : inp.def) : '');
      html += '<option value="' + o.indId + '">' + name + ' (' + label + ': ' + v + ')</option>';
    });
    return html;
  }

  function gateCondRowHtml(type) {
    if (type === 'parallel') {
      return '<div class="gate-cond-row" data-gtype="parallel">' +
        '<div class="gc-line1">' +
        '<span class="gc-type-tag">Parallel Flatline</span>' +
        '<select class="gc-ind-sel"></select>' +
        '<span class="gc-arrow">&gt;</span>' +
        '<select class="gc-logic-sel"><option value="parallel">Forming horizontal flatline parallel to each other</option></select>' +
        '<select class="gc-rel-sel"><option value="above">Above</option><option value="below">Below</option><option value="both">Above &amp; Below</option></select>' +
        '<button class="gc-remove" type="button" title="Remove">x</button>' +
        '</div>' +
        '<div class="gc-line2">' +
        '<span class="gc-type-tag">Comparator</span>' +
        '<select class="gc-cmp-sel"></select>' +
        '</div>' +
        '</div>';
    }
    return '<div class="gate-cond-row" data-gtype="flat">' +
      '<div class="gc-line1">' +
      '<span class="gc-type-tag">Flatline</span>' +
      '<select class="gc-ind-sel"></select>' +
      '<span class="gc-arrow">&gt;</span>' +
      '<select class="gc-logic-sel"><option value="flat">Forming horizontal flatline continuously</option></select>' +
      '<button class="gc-remove" type="button" title="Remove">x</button>' +
      '</div>' +
      '</div>';
  }

  function renderGateCondRows() {
    const host = $('gateCondRows');
    if (!host) return;
    const domConds = collectGateConds();
    if (domConds.length) _gateConds = domConds;
    host.innerHTML = '';
    if (!_gateConds.length) {
      host.innerHTML = '<div style="font-size:8px;color:#888;padding:4px">No gate conditions yet. Add a flatline or parallel flatline condition above.</div>';
      return;
    }
    _gateConds.forEach(c => {
      const type = c.type === 'parallel' ? 'parallel' : 'flat';
      const div = document.createElement('div');
      div.innerHTML = gateCondRowHtml(type);
      const row = div.firstElementChild;
      if (!row) return;
      host.appendChild(row);
      const indSel = row.querySelector('.gc-ind-sel');
      if (indSel) {
        indSel.innerHTML = gateIndHtml(indSel);
        indSel.value = c.indId || '';
        indSel.addEventListener('change', () => { if (row.dataset.gtype === 'parallel') populateGateCmpSel(row); });
      }
      if (type === 'parallel') {
        populateGateCmpSel(row);
        const cmpSel = row.querySelector('.gc-cmp-sel');
        if (cmpSel) cmpSel.value = c.cmpIndId || '';
        const relSel = row.querySelector('.gc-rel-sel');
        if (relSel) relSel.value = c.rel || 'above';
      }
      const rm = row.querySelector('.gc-remove');
      if (rm) rm.addEventListener('click', () => { row.remove(); });
    });
  }

  function populateGateCmpSel(row) {
    const indSel = row.querySelector('.gc-ind-sel');
    const cmpSel = row.querySelector('.gc-cmp-sel');
    if (!cmpSel) return;
    cmpSel.innerHTML = gateIndHtml(cmpSel, indSel ? indSel.value : '');
  }

  function findEntrySource(indId) {
    if (!indId) return null;
    let c = _tempEntryConditions.find(x => x && x.indId === indId);
    if (c) return {
      indSettings: c.indSettings || {},
      indValue: c.indValue,
      valueKey: c.valueKey || defaultValueKey(indId)
    };
    c = _tempEntryConditions.find(x => x && x.cmpType === 'indicator' && x.cmpIndId === indId);
    if (c) return {
      indSettings: c.cmpSettings || {},
      indValue: c.cmpIndValue,
      valueKey: c.cmpValueKey || defaultValueKey(indId)
    };
    return null;
  }

  function collectGateConds() {
    const host = $('gateCondRows');
    if (!host) return [];
    const out = [];
    host.querySelectorAll('.gate-cond-row').forEach(row => {
      const type = row.dataset.gtype === 'parallel' ? 'parallel' : 'flat';
      const indSel = row.querySelector('.gc-ind-sel');
      const indId = indSel ? indSel.value : '';
      if (!indId) return;
      const src = findEntrySource(indId) || {};
      const cond = {
        type,
        indId,
        indSettings: src.indSettings || defaultSettingsFor(indId),
        indValue: src.indValue != null ? src.indValue : null,
        valueKey: src.valueKey || defaultValueKey(indId)
      };
      if (type === 'parallel') {
        const cmpSel = row.querySelector('.gc-cmp-sel');
        const cmpIndId = cmpSel ? cmpSel.value : '';
        if (!cmpIndId) return;
        const src2 = findEntrySource(cmpIndId) || {};
        cond.rel = (row.querySelector('.gc-rel-sel') || {}).value || 'above';
        cond.cmpIndId = cmpIndId;
        cond.cmpSettings = src2.indSettings || defaultSettingsFor(cmpIndId);
        cond.cmpIndValue = src2.indValue != null ? src2.indValue : null;
        cond.cmpValueKey = src2.valueKey || defaultValueKey(cmpIndId);
      }
      out.push(cond);
    });
    return out;
  }

  function addGateCond(type) {
    const host = $('gateCondRows');
    if (!host) return;
    const div = document.createElement('div');
    div.innerHTML = gateCondRowHtml(type);
    const row = div.firstElementChild;
    if (!row) return;
    host.appendChild(row);
    const indSel = row.querySelector('.gc-ind-sel');
    if (indSel) {
      indSel.innerHTML = gateIndHtml(indSel);
      indSel.addEventListener('change', () => { if (row.dataset.gtype === 'parallel') populateGateCmpSel(row); });
    }
    if (type === 'parallel') populateGateCmpSel(row);
    const rm = row.querySelector('.gc-remove');
    if (rm) rm.addEventListener('click', () => { row.remove(); });
    const empty = host.querySelector('div[style*="No gate conditions"]');
    if (empty) empty.remove();
  }

  function fillGateConds(conds) {
    _gateConds = (conds && conds.length) ? JSON.parse(JSON.stringify(conds)) : [];
    const host = $('gateCondRows');
    if (host) host.innerHTML = '';
    renderGateCondRows();
  }

  const GATE_PATTERNS = [
    'long_legged_doji', 'spinning_top', 'inside_bar', 'narrow_range',
    'stop_hunt_below', 'stop_hunt_above', 'false_breakout',
    'doji_bullish', 'doji_bearish'
  ];

  function renderGateSection() {
    renderGateCondRows();
    renderGatePatternGrid();
  }

  function renderGatePatternGrid() {
    const grid = $('gatePatternGrid');
    if (!grid) return;
    const CP = window.CandlePatterns;
    if (!CP) { grid.innerHTML = ''; return; }
    const saved = _gatePatterns.slice();
    renderPatternGrid(grid, GATE_PATTERNS, saved, CP);
  }

  function renderExitPatternGrid(cat) {
    const grid = $('exitCmpPatternGrid');
    const hint = $('exitCmpPatternHint');
    if (!grid) return;
    const CP = window.CandlePatterns;
    if (!CP) { grid.innerHTML = ''; return; }
    const isBull = cat === 'bullish';
    const keys = isBull ? BULLISH_EXIT_PATTERNS : BULLISH_ENTRY_PATTERNS;
    if (hint) hint.textContent = isBull
      ? 'Select bearish reversal patterns to detect bullish->bearish trend change:'
      : 'Select bullish reversal patterns to detect bearish->bullish trend change:';
    const saved = _exitCandlePatterns.slice();
    renderPatternGrid(grid, keys, saved, CP);
  }

  function collectExitCandlePatterns() {
    const out = [];
    const grid = $('exitCmpPatternGrid');
    if (grid) grid.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      if (cb.checked) out.push(cb.dataset.key);
    });
    _exitCandlePatterns = out.slice();
    return out;
  }

  function loadExitCandlePatterns(arr) {
    _exitCandlePatterns = (arr && arr.length) ? arr.slice() : [];
  }

  function primaryInput(indId) {
    const def = (window.IndChart && IndChart.IND) ? IndChart.IND[indId] : null;
    if (!def || !def.inputs) return null;
    for (const inp of def.inputs) {
      if (inp && typeof inp.def === 'number' && !inp.options) return inp;
    }
    return null;
  }

  function primaryInputLabel(indId) {
    const inp = primaryInput(indId);
    return inp ? (inp.label || inp.key) : 'Value';
  }

  function defaultValueKey(indId) {
    if (indId === 'bb' || indId === 'pc') return 'v1';
    return 'v0';
  }

  function isMiddleIndicator(indId) {
    return indId === 'bb' || indId === 'pc';
  }

  function applyIndValue(settings, indId, indValue) {
    if (indValue === '' || indValue == null) return settings;
    const inp = primaryInput(indId);
    if (!inp) return settings;
    const v = Number(indValue);
    if (isNaN(v) || v <= 0) return settings;
    const s = Object.assign({}, settings || {});
    s[inp.key] = v;
    return s;
  }

  function saveStrategy() {
    const name = $('stratName').value.trim();
    if (!name) { alert('Enter a strategy name'); return; }
    if (!_tempEntryConditions.length) { alert('Save at least one entry condition'); return; }

    const primaryEntry = _tempEntryConditions[0];
    const entry = {
      indId: primaryEntry.indId,
      indSettings: primaryEntry.indSettings,
      indValue: primaryEntry.indValue,
      valueKey: primaryEntry.valueKey,
      logic: primaryEntry.logic,
      cmpType: primaryEntry.cmpType,
      cmpIndId: primaryEntry.cmpIndId,
      cmpSettings: primaryEntry.cmpSettings,
      cmpIndValue: primaryEntry.cmpIndValue,
      cmpValueKey: primaryEntry.cmpValueKey,
      candleKey: primaryEntry.candleKey,
      number: primaryEntry.number
    };
    if (primaryEntry.paneCond) entry.paneCond = JSON.parse(JSON.stringify(primaryEntry.paneCond));
    if (primaryEntry.paneConds && primaryEntry.paneConds.length) entry.paneConds = JSON.parse(JSON.stringify(primaryEntry.paneConds));
    if (primaryEntry.paneMove) entry.paneMove = JSON.parse(JSON.stringify(primaryEntry.paneMove));
    if (primaryEntry.paneMoves && primaryEntry.paneMoves.length) entry.paneMoves = JSON.parse(JSON.stringify(primaryEntry.paneMoves));
    if (_tempEntryConditions.length > 1) {
      entry.chain = _tempEntryConditions.slice(1).map(c => ({
        indId: c.indId, indSettings: c.indSettings, valueKey: c.valueKey,
        logic: c.logic, cmpType: c.cmpType, cmpIndId: c.cmpIndId,
        cmpSettings: c.cmpSettings, cmpValueKey: c.cmpValueKey,
        candleKey: c.candleKey, number: c.number,
        conn: c.conn ? { join: c.conn.join === 'or' ? 'or' : 'and', move: c.conn.move || 'off' } : { join: 'and', move: 'off' }
      }));
    }
    const revExits = _exitReverseOn ? _tempEntryConditions.map(reverseCondition).filter(Boolean) : [];
    const primaryExit = (revExits.length ? revExits[0] : _tempExitConditions[0]) || { indId: '', indSettings: {}, indValue: '', valueKey: 'v0', logic: 'lt', cmpType: 'candle', cmpIndId: '', cmpSettings: {}, cmpIndValue: '', cmpValueKey: 'v0', candleKey: 'close', number: 0 };
    const exit = {
      indId: primaryExit.indId,
      indSettings: primaryExit.indSettings,
      indValue: primaryExit.indValue,
      valueKey: primaryExit.valueKey,
      logic: primaryExit.logic,
      cmpType: primaryExit.cmpType,
      cmpIndId: primaryExit.cmpIndId,
      cmpSettings: primaryExit.cmpSettings,
      cmpIndValue: primaryExit.cmpIndValue,
      cmpValueKey: primaryExit.cmpValueKey,
      candleKey: primaryExit.candleKey,
      number: primaryExit.number,
      candlePatterns: primaryExit.candlePatterns || []
    };
    if (primaryExit.paneCond) exit.paneCond = JSON.parse(JSON.stringify(primaryExit.paneCond));
    if (primaryExit.paneConds && primaryExit.paneConds.length) exit.paneConds = JSON.parse(JSON.stringify(primaryExit.paneConds));
    const extraExits = revExits.length ? revExits.slice(1) : _tempExitConditions.slice(1);
    if (extraExits.length) {
      exit.chain = extraExits.map(c => ({
        indId: c.indId, indSettings: c.indSettings, valueKey: c.valueKey,
        logic: c.logic, cmpType: c.cmpType, cmpIndId: c.cmpIndId,
        cmpSettings: c.cmpSettings, cmpValueKey: c.cmpValueKey,
        candleKey: c.candleKey, number: c.number, candlePatterns: c.candlePatterns || [],
        conn: c.conn ? { join: c.conn.join === 'or' ? 'or' : 'and', move: c.conn.move || 'off' } : { join: 'and', move: 'off' }
      }));
    }
    const strat = {
      id: editId || 'strat-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      name,
      cat: $('stratCat').value || 'bullish',
      symbol: (typeof selectedSymbol !== 'undefined' && selectedSymbol) ? JSON.parse(JSON.stringify(selectedSymbol)) : null,
      tf: selectedTf,
      entry, exit,
      exitReverse: !!_exitReverseOn,
      strike: {
        mode: $('strikeMode').value,
        count: Math.max(0, Number($('strikeCount').value) || 0),
        includeAtm: ['above_atm', 'below_atm', 'both_atm_inc'].includes($('strikeMode').value),
        optionType: $('optionType').value
      },
      lot: {
        auto: $('lotAuto').value === 'yes',
        basis: $('lotBasis').value,
        pct: Number($('lotPct').value) || 0,
        manualQty: Number($('lotManual').value) || 1
      },
      entryGap: collectGapFields('entryGap'),
      exitGap: collectGapFields('exitGap'),
      gate: collectGateFields(),
      candlestick: (function () {
        const enabled = $('candleToggle').checked;
        if (!enabled) return { enabled: false, entry: [], exit: [] };
        const p = collectCandlestickPatterns();
        return { enabled: true, entry: p.entry, exit: p.exit };
      })(),
      createdAt: Date.now()
    };
    if (strat.entryGap) strat.entry.gap = strat.entryGap;
    if (strat.exitGap) strat.exit.gap = strat.exitGap;
    delete strat.entryGap;
    delete strat.exitGap;
    if (editId) {
      const prev = [...loadSaved(), ...activeStrategies].find(s => s.id === editId);
      if (prev && prev.indexConfirmation) strat.indexConfirmation = JSON.parse(JSON.stringify(prev.indexConfirmation));
    }
    let saved = loadSaved();
    const i = saved.findIndex(s => s.id === strat.id);
    if (i >= 0) { saved[i] = strat; }
    else { saved.push(strat); }
    persistSaved(saved);
    if (editId) {
      const ai = activeStrategies.findIndex(a => a.id === editId);
      if (ai >= 0) { activeStrategies[ai] = JSON.parse(JSON.stringify(strat)); persistActive(); }
    }
    renderSavedDropdown();
    renderActiveList();
    show($('strategyBuilder'), false);
    editId = null;
  }

  function renderSavedDropdown() {
    const sel = $('savedStratSelect');
    const list = loadSaved();
    sel.innerHTML = '';
    if (!list.length) {
      const o = document.createElement('option'); o.value = ''; o.textContent = 'No saved strategies yet'; sel.appendChild(o);
    } else {
      const bullish = list.filter(s => (!s.cat || s.cat === 'bullish'));
      const bearish = list.filter(s => s.cat === 'bearish');
      if (bullish.length) {
        const g = document.createElement('optgroup'); g.label = 'Bullish Strategy';
        bullish.forEach(s => { const o = document.createElement('option'); o.value = s.id; o.textContent = s.name || 'Untitled'; g.appendChild(o); });
        sel.appendChild(g);
      }
      if (bearish.length) {
        const g = document.createElement('optgroup'); g.label = 'Bearish Strategy';
        bearish.forEach(s => { const o = document.createElement('option'); o.value = s.id; o.textContent = s.name || 'Untitled'; g.appendChild(o); });
        sel.appendChild(g);
      }
    }
    populateAssignStratSelect();
    renderSavedList();
  }

  function renderSavedList() {
    const host = $('savedStratList');
    if (!host) return;
    host.innerHTML = '';
    const list = loadSaved();
    if (!list.length) {
      host.innerHTML = '<div class="strat-empty">No saved strategies yet.</div>';
      return;
    }
    list.forEach(s => {
      const icOn = s.indexConfirmation && s.indexConfirmation.enabled;
      const card = document.createElement('div');
      card.className = 'strat-card';
      card.innerHTML =
        '<div class="strat-head"><span class="strat-name">' + esc(s.name || 'Untitled') + '</span>' +
        (icOn ? '<span class="ic-tag">Index Conf: ON</span>' : '') + '</div>' +
        '<div class="strat-meta">' + esc((s.symbol && s.symbol.name) || '-') + ' &middot; ' + esc(s.tf) + '</div>' +
        '<div class="strat-actions">' +
        '<button class="sbtn" onclick="StratUI.edit(\'' + s.id + '\')">Edit</button>' +
        '<button class="sbtn" onclick="StratUI.openIndexConf(\'' + s.id + '\')">Index Confirmation</button>' +
        '<button class="sbtn run" onclick="StratUI.runSaved(\'' + s.id + '\')">Run Strategy</button>' +
        '</div>';
      host.appendChild(card);
    });
  }

  function openSelected() {
    const id = $('savedStratSelect').value;
    if (!id) return;
    const list = loadSaved();
    const s = list.find(x => x.id === id);
    if (!s) return;
    if (activeStrategies.some(a => a.id === s.id)) { alert('Strategy "' + (s.name || '') + '" is already open'); return; }
    activeStrategies.push(JSON.parse(JSON.stringify(s)));
    persistActive();
    renderActiveList();
  }

  function renderActiveList() {
    const host = $('strategyList');
    host.innerHTML = '';
    if (!activeStrategies.length) {
      host.innerHTML = '<div class="strat-empty">No strategies opened. Create one or open a saved strategy.</div>';
      return;
    }
    activeStrategies.forEach(s => {
      const running = engine.running.has(s.id);
      const assigned = getAssignedSymbols(s.id);
      const hasAssigned = assigned && assigned.length > 0;
      const st = s.strike;
      const modeLbl = (STRIKE_MODES.find(m => m[0] === st.mode) || [st.mode, st.mode])[1];
      const card = document.createElement('div');
      card.className = 'strat-card';
      card.id = 'strat-card-' + s.id;
      const gs = s.gateStatus;
      const gsTag = gs === 'running' ? '<span class="gate-status-tag run">Gate: Run</span>' :
                    gs === 'blocked' ? '<span class="gate-status-tag blocked">Gate: Blocked</span>' :
                    (s.gate && s.gate.enabled) ? '<span class="gate-status-tag unset">Gate: Pending</span>' : '';
      card.innerHTML =
        '<div class="strat-head"><span class="strat-name">' + esc(s.name || 'Untitled') + '</span>' +
        '<span class="strat-status" id="strat-status-' + s.id + '">' + (running ? 'Running' : 'Stopped') + '</span></div>' +
        '<div class="strat-meta">' + esc((s.symbol && s.symbol.name) || '-') + ' &middot; ' + esc(s.tf) + ' &middot; ' + esc(modeLbl) +
        (s.lot.auto ? ' &middot; auto lot ' + s.lot.pct + '% ' + s.lot.basis : ' &middot; qty ' + s.lot.manualQty) +
        (hasAssigned ? ' &middot; ' + assigned.length + ' symbol(s)' : '') +
        ((s.indexConfirmation && s.indexConfirmation.enabled) ? ' &middot; <span class="ic-tag">Index Conf: ON</span>' : '') + '</div>' +
        '<div class="strat-reads" id="strat-reads-' + s.id + '">Readings: --</div>' +
        '<div class="strat-actions">' +
        '<button class="sbtn" onclick="StratUI.edit(\'' + s.id + '\')">Edit</button>' +
        '<button class="sbtn" onclick="StratUI.openIndexConf(\'' + s.id + '\')">Index Confirmation</button>' + gsTag +
        '<button class="sbtn run" onclick="StratUI.run(\'' + s.id + '\')">Run Strategy</button>' +
        '<button class="sbtn stoptrade" onclick="StratUI.stopTrade(\'' + s.id + '\')">Stop Trade</button>' +
        '<button class="sbtn stop" onclick="StratUI.stop(\'' + s.id + '\')">Stop</button>' +
        '<button class="sbtn x" title="Remove" onclick="StratUI.remove(\'' + s.id + '\')">x</button></div>' +
        '<div class="strat-log" id="strat-log-' + s.id + '"></div>';
      host.appendChild(card);
    });
  }

  const statusEl = id => $('strat-status-' + id);
  function setStatus(id, status) {
    const el = statusEl(id);
    if (el) { el.textContent = status; el.className = 'strat-status ' + (status === 'Running' ? 'on' : status === 'In position' ? 'pos' : ''); }
  }

  function setGateStatus(id, gs) {
    const card = document.getElementById('strat-card-' + id);
    if (!card) return;
    const existing = card.querySelector('.gate-status-tag');
    if (existing) existing.remove();
    const act = card.querySelector('.strat-actions');
    if (!act || !gs) return;
    const tagCls = gs === 'running' ? 'run' : gs === 'blocked' ? 'blocked' : 'unset';
    const tagLabel = gs === 'running' ? 'Gate: Run' : gs === 'blocked' ? 'Gate: Blocked' : 'Gate: Pending';
    const btn = act.querySelector('.sbtn');
    if (!btn) return;
    const tag = document.createElement('span');
    tag.className = 'gate-status-tag ' + tagCls;
    tag.textContent = tagLabel;
    btn.after(tag);
  }

  function log(id, msg, cls) {
    const el = $('strat-log-' + id);
    if (!el) return;
    const now = new Date();
    const t = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0') + ':' + String(now.getSeconds()).padStart(2, '0');
    const div = document.createElement('div');
    div.className = 'slog ' + (cls || '');
    div.textContent = '[' + t + '] ' + msg;
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
  }

  function updateReadings(id, strat, candles) {
    const el = $('strat-reads-' + id);
    if (!el) return;
    let en = '--', ex = '--';
    if (strat && strat.entry.indId) {
      const r = engine.lastTwoOf(strat.entry.indId, strat.entry.indSettings || {}, strat.entry.valueKey, candles);
      en = r.last != null ? (IndChart.fmtReading(r.last, (IndChart.IND[strat.entry.indId] || {}).format)) : '--';
    }
    if (strat && strat.exit && strat.exit.indId) {
      const r = engine.lastTwoOf(strat.exit.indId, strat.exit.indSettings || {}, strat.exit.valueKey, candles);
      ex = r.last != null ? (IndChart.fmtReading(r.last, (IndChart.IND[strat.exit.indId] || {}).format)) : '--';
    }
    el.textContent = 'Entry: ' + en + ' | Exit: ' + ex;
  }

  function getAssignedSymbols(stratId) {
    const map = loadAssignments();
    return map[stratId] || [];
  }

  /* The list of charts a strategy monitors: its primary symbol plus every
     symbol it is assigned to. Each entry carries the symbol and timeframe. */
  function strategyCharts(s) {
    const out = [];
    const seen = {};
    const push = (sym) => {
      if (!sym || sym.id == null) return;
      const k = sym.id + ':' + (sym.exch || '');
      if (seen[k]) return;
      seen[k] = true;
      out.push({ symbol: sym, tf: s.tf });
    };
    push(s.symbol);
    (getAssignedSymbols(s.id) || []).forEach(push);
    return out;
  }

  /* ---------------- strategy live monitor ----------------
   * A dedicated tab where saved strategies are added to a watch list. Each card
   * has a Details button that expands into a live, realtime panel showing the
   * current reading of EVERY indicator (overlay + pane), candlestick pattern and
   * chart pattern defined in that strategy — pulled from the same realtime
   * candle data the chart engine uses, refreshed every 2 seconds. */
  const MONITOR_KEY = 'algodhan_monitor_v1';
  let monitorList = loadMonitorList();
  let monitorExpanded = new Set();
  let monitorCharts = {};
  let monitorPollTimer = null;

  /* Caches for the monitor "Strategy Strike Prices" section */
  const strikeChainCache = {};   // ocId|ocExch|expiry -> {at, chain}
  const strikeExpiryCache = {};  // ocId|ocExch -> {at, expiry}
  const strikeInfoCache = {};    // strategyId -> last rendered strike HTML

  function loadMonitorList() { try { return JSON.parse(localStorage.getItem(MONITOR_KEY) || '[]'); } catch (e) { return []; } }
  function persistMonitorList() { localStorage.setItem(MONITOR_KEY, JSON.stringify(monitorList)); }

  function indicatorDef(id) { return (window.IndChart && IndChart.IND) ? IndChart.IND[id] : null; }

  function indName(id) {
    const def = indicatorDef(id);
    return def ? def.name : String(id == null ? '' : id).toUpperCase();
  }

  function fmtNum(v) {
    if (v == null || isNaN(v)) return '--';
    return (window.IndChart && IndChart.fmtCompact) ? IndChart.fmtCompact(v, 2) : Number(v).toFixed(2);
  }

  /* Human label for a CrossDetector source descriptor. */
  function srcLabel(src) {
    if (!src) return '--';
    if (src.type === 'number') return 'Fixed value';
    if (src.type === 'candle') return 'Candle ' + String(src.key || 'close').toUpperCase();
    if (src.type === 'candlestick_pattern') {
      const CP = window.CandlePatterns;
      const names = (src.patterns || []).map(k => CP && CP.PATTERNS[k] ? CP.PATTERNS[k].name : k);
      return 'Pattern: ' + (names.length ? names.join(', ') : '--');
    }
    if (src.type === 'ind') {
      const def = indicatorDef(src.id);
      const name = def ? def.name : src.id;
      const settings = src.settings || {};
      const parts = ((def && def.inputs) || []).map(inp => {
        const v = settings[inp.key] != null ? settings[inp.key] : inp.def;
        return (inp.label || inp.key) + '=' + v;
      });
      const opts = (window.IndChart && IndChart.valueOptionsFor) ? IndChart.valueOptionsFor(src.id) : [];
      const opt = opts.find(o => o[0] === src.key);
      const series = opt ? opt[1] : src.key;
      return name + (parts.length ? '(' + parts.join(', ') + ')' : '') + ' ' + series;
    }
    return '--';
  }

  function fmtSrcVal(src, v) {
    if (v == null || isNaN(v)) return '--';
    if (src.type === 'ind') {
      const def = indicatorDef(src.id);
      return (window.IndChart && IndChart.fmtReading) ? IndChart.fmtReading(v, def && def.format) : v;
    }
    return (window.IndChart && IndChart.fmtReading) ? IndChart.fmtReading(v, null) : v;
  }

  /* Live reading HTML for one source descriptor: value + previous value. */
  function srcReadHTML(src, candles) {
    if (!src) return '<span class="md-val">--</span>';
    if (src.type === 'candlestick_pattern') {
      const CP = window.CandlePatterns;
      const keys = src.patterns || [];
      const hit = CP ? CP.detectAny(keys, candles) : null;
      if (hit) {
        const nm = CP && CP.PATTERNS[hit] ? CP.PATTERNS[hit].name : hit;
        return '<span class="md-val" style="color:#00d4aa">FORMING</span> <span class="md-prev">' + esc(nm) + '</span>';
      }
      return '<span class="md-val" style="color:#777">--</span> <span class="md-prev">no pattern</span>';
    }
    const r = CrossDetector.readLastTwo(src, candles);
    const last = fmtSrcVal(src, r.last);
    const prev = r.prev != null ? 'prev ' + fmtSrcVal(src, r.prev) : '';
    return '<span class="md-val">' + last + '</span>' + (prev ? ' <span class="md-prev">(' + prev + ')</span>' : '');
  }

  /* One condition block (entry/exit) with both sides' live readings + result. */
  function condChainBlocks(title, conds, candles) {
    if (!conds || !conds.length) return '';
    let html = '<div class="md-section"><div class="md-title">' + esc(title) + '</div>';
    conds.forEach((c, i) => {
      if (!c || !c.indId) return;
      if (i > 0) {
        const conn = c.conn || { join: 'and', move: 'off' };
        if (conn.join === 'or' || (conn.move && conn.move !== 'off')) {
          const joinLbl = conn.join === 'or' ? 'OR' : 'AND';
          const isMacd = !!(conds[0] && conds[0].indId === 'macd');
          let connTxt = '<span class="md-logic">' + joinLbl + '</span>';
          if (conn.move && conn.move !== 'off') {
            const prim = conds[0];
            const movePass = (prim && candles) ? engine.evalMovement(prim, conn.move, candles) : false;
            const moveLbl = moveLabel(conn.move, isMacd);
            connTxt += ' &middot; <span class="md-logic">' + esc(moveLbl) + ': ' +
              (movePass ? '<span style="color:#00d4aa">PASS</span>' : '<span style="color:#ef5350">NOT MET</span>') + '</span>';
          }
          html += '<div class="md-cond-conn">' + connTxt + '</div>';
        }
      }
      const a = { type: 'ind', id: c.indId, settings: c.indSettings || {}, key: c.valueKey || defaultValueKey(c.indId) };
      let b;
      if (c.cmpType === 'number') b = { type: 'number', value: Number(c.number) || 0 };
      else if (c.cmpType === 'candle') b = { type: 'candle', key: c.candleKey || 'close' };
      else if (c.cmpType === 'candlestick_pattern') b = { type: 'candlestick_pattern', patterns: c.candlePatterns || [] };
      else if (c.cmpType === 'plot') b = { type: 'ind', id: c.indId, settings: c.indSettings || {}, key: 'v0' };
      else if (c.cmpType === 'smoothed') b = { type: 'ind', id: c.indId, settings: c.indSettings || {}, key: 'v1' };
      else if (c.cmpType === 'paneLine') b = { type: 'ind', id: c.indId, settings: c.indSettings || {}, key: c.paneLineB || 'v1' };
      else if (c.cmpIndId) b = { type: 'ind', id: c.cmpIndId, settings: c.cmpSettings || {}, key: c.cmpValueKey || defaultValueKey(c.cmpIndId) };
      else b = { type: 'number', value: Number(c.number) || 0 };
      const pass = window.CrossDetector ? CrossDetector.evalChain([{ a, logic: c.logic || 'gt', b }], candles) : false;
      const logicLbl = (LOGIC_OPS.find(l => l[0] === c.logic) || [c.logic, c.logic])[1];
      html += '<div class="md-cond">' +
        '<div class="md-cond-head">#' + (i + 1) + ' &middot; ' + esc(logicLbl) + '</div>' +
        '<div class="md-row"><span class="md-src">' + esc(srcLabel(a)) + '</span> ' + srcReadHTML(a, candles) + '</div>' +
        '<div class="md-row"><span class="md-src">' + esc(srcLabel(b)) + '</span> ' + srcReadHTML(b, candles) + '</div>' +
        '<div class="md-result ' + (pass ? 'pass' : 'fail') + '">' + (pass ? 'PASS' : 'NOT MET') + '</div></div>';
    });
    html += '</div>';
    return html;
  }

  function paneMoveBlock(title, pm, candles) {
    const def = (window.IndChart && IndChart.IND) ? IndChart.IND[pm.indId] : null;
    const name = def ? def.name : pm.indId;
    const mvPass = window.CrossDetector && CrossDetector.movementDirection
      ? CrossDetector.movementDirection(pm.indId, pm.indSettings || {}, pm.logic, candles)
      : false;
    const mvLbl = moveLabel(pm.logic, pm.indId === 'macd');
    const joinLbl = pm.join === 'or' ? 'OR' : 'AND';
    const allPass = mvPass;
    return '<div class="md-section"><div class="md-title">' + esc(title) + '</div>' +
      '<div class="md-cond">' +
      '<div class="md-cond-head">' + esc(name) + ' &middot; ' + joinLbl + ' ' + esc(mvLbl) + '</div>' +
      '<div class="md-row"><span class="md-src">Movement gate</span> ' +
      (mvPass ? '<span style="color:#00d4aa">PASS</span>' : '<span style="color:#ef5350">NOT MET</span>') + '</div>' +
      '<div class="md-result ' + (allPass ? 'pass' : 'fail') + '">' + (allPass ? 'PASS' : 'NOT MET') + '</div></div></div>';
  }

  function gapRowCard(head, lines, pass) {
    return '<div class="md-cond"><div class="md-cond-head">' + esc(head) + '</div>' +
      lines.map(l => '<div class="md-row"><span class="md-logic">' + l + '</span></div>').join('') +
      '<div class="md-result ' + (pass ? 'pass' : 'fail') + '">' + (pass ? 'PASS' : 'NOT MET') + '</div></div>';
  }

  /* Gap conditions with live readings (pair / supertrend / band). */
  function gapRowsHTML(title, gap, candles) {
    if (!gap || !gap.enabled) return '';
    let html = '<div class="md-section"><div class="md-title">' + esc(title) + '</div>';
    let any = false;
    const lastC = candles[candles.length - 1];
    const prevC = candles[candles.length - 2];

    (gap.pair || []).forEach((c, i) => {
      if (!c.primary || !c.comparator) return;
      any = true;
      const plen = (c.primaryVal != null && c.primaryVal !== '') ? c.primaryVal : (primaryInput(c.primary) || { def: 20 }).def;
      const clen = (c.comparatorVal != null && c.comparatorVal !== '') ? c.comparatorVal : (primaryInput(c.comparator) || { def: 20 }).def;
      const r1 = engine.lastTwoOf(c.primary, { length: plen }, 'v0', candles);
      const isCandle = ['candle_close', 'candle_high', 'candle_low', 'candle_open'].includes(c.comparator);
      let cmpLast = null, cmpPrev = null;
      if (isCandle) {
        const k = c.comparator.replace('candle_', '');
        cmpLast = lastC ? lastC[k] : null;
        cmpPrev = prevC ? prevC[k] : null;
      } else {
        const r2 = engine.lastTwoOf(c.comparator, { length: clen }, 'v0', candles);
        cmpLast = r2.last; cmpPrev = r2.prev;
      }
      const curGap = (r1.last != null && cmpLast != null) ? r1.last - cmpLast : null;
      const prevGap = (r1.prev != null && cmpPrev != null) ? r1.prev - cmpPrev : null;
      const pass = curGap != null && prevGap != null && ((c.logic === 'inc') ? curGap > prevGap : curGap < prevGap);
      html += gapRowCard('#' + (i + 1) + ' ' + indName(c.primary) + ' - ' + indName(c.comparator) + ' (' + (c.logic === 'inc' ? 'gap increasing' : 'gap decreasing') + ')',
        ['Current gap: ' + fmtNum(curGap) + ' &nbsp;(prev: ' + fmtNum(prevGap) + ')',
         indName(c.primary) + ': ' + fmtNum(r1.last) + ' &nbsp;' + indName(c.comparator) + ': ' + fmtNum(cmpLast)], pass);
    });

    (gap.st || []).forEach((c, i) => {
      if (!c.trend || !c.logic) return;
      any = true;
      const plen = (c.trendVal != null && c.trendVal !== '') ? c.trendVal : (primaryInput(c.trend) || { def: 10 }).def;
      const r3 = engine.lastTwoOf(c.trend, { period: plen, multiplier: 3 }, 'v0', candles);
      const pass = r3.last != null && lastC && ((c.logic === 'uptrend') ? r3.last < lastC.close : r3.last > lastC.close);
      html += gapRowCard('#' + (i + 1) + ' ' + indName(c.trend) + ' in ' + (c.logic === 'uptrend' ? 'Uptrend' : 'Downtrend'),
        [indName(c.trend) + ': ' + fmtNum(r3.last) + ' &nbsp;Candle close: ' + fmtNum(lastC ? lastC.close : null)], pass);
    });

    (gap.band || []).forEach((c, i) => {
      if (!c.indicator || !c.candleLogic || !c.gapLogic) return;
      any = true;
      const plen = (c.indicatorVal != null && c.indicatorVal !== '') ? c.indicatorVal : (primaryInput(c.indicator) || { def: 20 }).def;
      const r4 = engine.lastTwoOf(c.indicator, { length: plen, mult: 2 }, 'v1', candles);
      const above = c.candleLogic === 'above';
      const candleOk = r4.last != null && lastC && (above ? r4.last > lastC.close : r4.last < lastC.close);
      let gapOk = true;
      if (r4.prev != null && prevC) {
        const curGap = Math.abs(r4.last - lastC.close);
        const prevGap = Math.abs(r4.prev - prevC.close);
        gapOk = (c.gapLogic === 'inc') ? curGap > prevGap : curGap < prevGap;
      }
      const pass = candleOk && gapOk;
      html += gapRowCard('#' + (i + 1) + ' ' + indName(c.indicator) + ' ' + (above ? 'above' : 'below') + ' candle, gap ' + (c.gapLogic === 'inc' ? 'increasing' : 'decreasing'),
        [indName(c.indicator) + ': ' + fmtNum(r4.last) + ' &nbsp;Candle close: ' + fmtNum(lastC ? lastC.close : null)], pass);
    });

    if (!any) html += '<div class="md-empty">No gap conditions configured</div>';
    html += '</div>';
    return html;
  }

  /* Gate (consolidation / liquidity grab) with live flatline detection. */
  function gateHTML(gate, candles) {
    if (!gate || !gate.enabled) return '';
    let html = '<div class="md-section"><div class="md-title">Gate (Consolidation / Liquidity Grab)</div>';
    let any = false;
    (gate.conds || []).forEach((gc, i) => {
      if (!gc || !gc.indId) return;
      any = true;
      if (gc.type === 'parallel') {
        const aFlat = engine.isFlatline(gc.indId, gc.indSettings || {}, gc.valueKey || 'v0', candles);
        const bFlat = engine.isFlatline(gc.cmpIndId, gc.cmpSettings || {}, gc.cmpValueKey || 'v0', candles);
        const a = engine.lastTwoOf(gc.indId, gc.indSettings || {}, gc.valueKey || 'v0', candles);
        const b = engine.lastTwoOf(gc.cmpIndId, gc.cmpSettings || {}, gc.cmpValueKey || 'v0', candles);
        const relLbl = { both: 'within 1%', above: 'above', below: 'below' }[gc.rel] || gc.rel;
        const blocked = aFlat && bFlat;
        html += '<div class="md-cond"><div class="md-cond-head">#' + (i + 1) + ' Parallel Flatline (' + relLbl + ')</div>' +
          '<div class="md-row"><span class="md-src">' + esc(indName(gc.indId)) + '</span> <span class="md-val">' + fmtNum(a.last) + '</span> <span class="md-logic">flat: ' + (aFlat ? 'yes' : 'no') + '</span></div>' +
          '<div class="md-row"><span class="md-src">' + esc(indName(gc.cmpIndId)) + '</span> <span class="md-val">' + fmtNum(b.last) + '</span> <span class="md-logic">flat: ' + (bFlat ? 'yes' : 'no') + '</span></div>' +
          '<div class="md-result ' + (blocked ? 'fail' : 'pass') + '">' + (blocked ? 'FLAT / BLOCKED' : 'NOT FLAT') + '</div></div>';
      } else {
        const flat = engine.isFlatline(gc.indId, gc.indSettings || {}, gc.valueKey || 'v0', candles);
        const r = engine.lastTwoOf(gc.indId, gc.indSettings || {}, gc.valueKey || 'v0', candles);
        html += '<div class="md-cond"><div class="md-cond-head">#' + (i + 1) + ' Flatline</div>' +
          '<div class="md-row"><span class="md-src">' + esc(indName(gc.indId)) + '</span> <span class="md-val">' + fmtNum(r.last) + '</span></div>' +
          '<div class="md-result ' + (flat ? 'fail' : 'pass') + '">' + (flat ? 'FLAT / BLOCKED' : 'NOT FLAT') + '</div></div>';
      }
    });
    if (gate.patterns && gate.patterns.length) {
      any = true;
      html += '<div class="md-sub">Gate Patterns</div>' + patternRowsHTML(gate.patterns, candles);
    }
    if (!any) html += '<div class="md-empty">No gate conditions configured</div>';
    html += '</div>';
    return html;
  }

  /* Candlestick / chart pattern rows: each pattern, one line, forming status. */
  function patternRowsHTML(keys, candles) {
    const CP = window.CandlePatterns;
    let html = '';
    (keys || []).forEach(k => {
      const p = CP && CP.PATTERNS[k];
      const name = p ? p.name : k;
      const on = CP ? CP.detect(k, candles) : false;
      html += '<div class="md-pattern"><span class="dot ' + (on ? 'on' : 'off') + '"></span><span class="pname">' + esc(name) + '</span>' +
        (on ? '<span class="pstat" style="color:#00d4aa">FORMING</span>' : '<span class="pstat">not forming</span>') + '</div>';
    });
    return html;
  }

  function candlestickHTML(candlestick, candles) {
    if (!candlestick || !candlestick.enabled) return '';
    let html = '<div class="md-section"><div class="md-title">Candlestick Pattern Confirmation</div>';
    const en = candlestick.entry || [];
    const ex = candlestick.exit || [];
    if (en.length) { html += '<div class="md-sub">Entry Patterns</div>' + patternRowsHTML(en, candles); }
    if (ex.length) { html += '<div class="md-sub">Exit / Reversal Patterns</div>' + patternRowsHTML(ex, candles); }
    if (!en.length && !ex.length) html += '<div class="md-empty">No confirmation patterns configured</div>';
    html += '</div>';
    return html;
  }

  /* Live value reading of a condition's primary indicator source. */
  function condLastReading(cond, candles) {
    if (!cond || !cond.indId) return null;
    const src = { type: 'ind', id: cond.indId, settings: cond.indSettings || {}, key: cond.valueKey || defaultValueKey(cond.indId) };
    const r = CrossDetector.readLastTwo(src, candles);
    return r ? r.last : null;
  }

  /* Summary line for one chart of a strategy (per-chart readings). */
  function chartSummaryHTML(s, chart) {
    const candles = chart.candles;
    const parts = [];
    if (s.entry && s.entry.indId) {
      const entryPass = engine.evalCondEdge(s.entry, candles, null);
      const v = condLastReading(s.entry, candles);
      const vLbl = (v != null && !isNaN(v)) ? indName(s.entry.indId) + ' <b>' + fmtNum(v) + '</b>' : indName(s.entry.indId);
      parts.push('Entry ' + vLbl + ' ' + (entryPass ? '<span style="color:#00d4aa">PASS</span>' : '<span style="color:#ff5252">--</span>'));
    }
    if (s.exit && s.exit.indId) {
      const exitPass = engine.evalCondEdge(s.exit, candles, null);
      const v = condLastReading(s.exit, candles);
      const vLbl = (v != null && !isNaN(v)) ? indName(s.exit.indId) + ' <b>' + fmtNum(v) + '</b>' : indName(s.exit.indId);
      parts.push('Exit ' + vLbl + ' ' + (exitPass ? '<span style="color:#00d4aa">PASS</span>' : '<span style="color:#ff5252">--</span>'));
    }
    if (s.gate && s.gate.enabled) {
      const gateOk = engine.evalGate(s.gate, candles);
      parts.push('Gate ' + (gateOk ? '<span style="color:#00d4aa">Run</span>' : '<span style="color:#ff9800">Blocked</span>'));
    }
    if (s.candlestick && s.candlestick.enabled) {
      const ok = engine.evalCandlestick(s.candlestick, candles);
      parts.push('Pattern ' + (ok ? '<span style="color:#00d4aa">Ok</span>' : '<span style="color:#ff5252">No</span>'));
    }
    if (!parts.length) parts.push('Readings: --');
    return parts.join(' &nbsp;|&nbsp; ');
  }

  function monitorSummaryHTML(s, charts) {
    const all = (charts || []).filter(c => c && c.symbol);
    if (!all.length) return '<span style="color:#666">Readings: waiting for live data...</span>';
    return all.map(ch => {
      const name = (ch.symbol && ch.symbol.name) || (ch.symbol && ch.symbol.id) || '-';
      const body = (ch.candles && ch.candles.length) ? chartSummaryHTML(s, ch) : '<span style="color:#666">waiting for data...</span>';
      return '<span class="md-chart-chip">' + esc(name) + '</span> ' + body;
    }).join('<br>');
  }

  /* ---------------- monitor: strategy strike prices ----------------
   * Shows the exact strikes the strategy will trade (computed from its
   * strike config relative to live ATM) with the current option premium and a
   * button to open the option-premium candlestick chart of that strike, so the
   * user can verify strategy execution against the right chart. */

  function strategyUnderlying(s) {
    if (!s || !s.symbol) return null;
    const sym = s.symbol;
    return {
      id: sym.ocId != null ? sym.ocId : sym.id,
      exch: sym.ocExch || sym.exch,
      name: sym.name || '-'
    };
  }

  /* Index options use OPTIDX, stock options use OPTSTK. The underlying's index-ness
     must be derived from the underlying exchange (IDX_I), not just symbol.inst,
     because a strategy's symbol can be a resolved option (inst=OPTIDX) whose ocExch
     still points at the underlying index. */
  function symbolUnderlyingIsIndex(sym) {
    if (!sym) return false;
    return sym.exch === 'IDX_I' || sym.inst === 'INDEX' || sym.ocExch === 'IDX_I';
  }

  async function resolveChainExpiry(s) {
    const under = strategyUnderlying(s);
    if (!under || under.id == null) return null;
    const key = under.id + '|' + under.exch;
    /* Prefer the Option Chain tab's live selection when it matches this underlying */
    const ocSel = document.getElementById('ocExpirySelect');
    if (typeof selectedSymbol !== 'undefined' && selectedSymbol && ocSel &&
        String(selectedSymbol.ocId) === String(under.id) && ocSel.value && !ocSel.value.startsWith('--')) {
      return ocSel.value;
    }
    const hit = strikeExpiryCache[key];
    if (hit && Date.now() - hit.at < 60000) return hit.expiry;
    let expiry = null;
    try {
      const d = await fetch('/api/expiries', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ security_id: under.id, exchange_segment: under.exch }) }).then(r => r.json());
      if (d && d.status === 'success' && d.data && d.data.length) expiry = d.data[0];
    } catch (e) {}
    strikeExpiryCache[key] = { at: Date.now(), expiry };
    return expiry;
  }

  async function fetchStrikeChain(s) {
    const under = strategyUnderlying(s);
    if (!under || under.id == null) return null;
    const expiry = await resolveChainExpiry(s);
    if (!expiry) return null;
    const key = under.id + '|' + under.exch + '|' + expiry;
    const hit = strikeChainCache[key];
    if (hit && Date.now() - hit.at < 15000) return hit.chain;
    let chain = null;
    try {
      const d = await fetch('/api/option_chain', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ security_id: under.id, exchange_segment: under.exch, expiry: expiry }) }).then(r => r.json());
      if (d && d.status === 'success') {
        chain = { expiry: expiry, spot: d.spot_price, records: d.data || [] };
        strikeChainCache[key] = { at: Date.now(), chain: chain };
      }
    } catch (e) {}
    return chain;
  }

  function strikeSectionHTML(s) {
    const cached = strikeInfoCache[s.id];
    return '<div class="md-section">' +
      '<div class="md-title">Strategy Strike Prices <span style="font-weight:400;text-transform:none;letter-spacing:0;color:#888;font-size:9px">(option premium charts)</span></div>' +
      '<div id="monitor-strikes-' + s.id + '">' +
      (cached ? cached : '<div class="md-empty">Loading strike prices...</div>') +
      '</div></div>';
  }

  async function loadStrikeInfo(s, id) {
    const host = document.getElementById('monitor-strikes-' + id);
    if (!host) return;
    const render = (html) => {
      strikeInfoCache[id] = html;
      const el = document.getElementById('monitor-strikes-' + id);
      if (el) el.innerHTML = html;
    };
    try {
      const chain = await fetchStrikeChain(s);
      if (!chain || !chain.records || !chain.records.length) {
        render('<div class="md-empty">Option chain unavailable. Make sure you are connected to Dhan and the underlying is listed in the Option Chain tab.</div>');
        return;
      }
      const atm = engine.findAtm(chain.records, chain.spot);
      if (atm == null) {
        render('<div class="md-empty">Could not determine the ATM strike from the live option chain.</div>');
        return;
      }
      const strikes = engine.computeStrikes(chain.records, atm, s.strike || {});
      const legs = engine.getLegs(s);
      const under = strategyUnderlying(s);
      const rows = strikes.map(strike => {
        const row = engine.findChainRow(chain.records, strike);
        const cells = legs.map(leg => {
          const ltp = row ? (Number(row[leg + ' LTP']) || 0) : 0;
          const chg = row ? (Number(row[leg + ' Chg%']) || 0) : 0;
          return '<span class="strike-prem">' + leg + ' <b>' + fmtNum(ltp) + '</b>' +
            ' <small class="' + (chg >= 0 ? 'strike-up' : 'strike-down') + '">' + (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%</small></span>';
        }).join('');
        const btns = legs.map(leg =>
          '<button class="sbtn run strike-chart-btn" onclick="StratUI.openStrikeChart(\'' + esc(s.id) + '\',' + strike + ',\'' + leg + '\')">Open Chart</button>'
        ).join('');
        return '<div class="strike-row"><span class="strike-label">' + strike + '</span><span class="strike-premia">' + cells + '</span><span class="strike-btns">' + btns + '</span></div>';
      }).join('');
      render(
        '<div class="strike-meta">Underlying: ' + esc((under && under.name) || '-') +
        ' &middot; Expiry: ' + esc(chain.expiry || '-') +
        ' &middot; ATM: ' + atm +
        ' &middot; Legs: ' + legs.join(', ') + '</div>' +
        '<div class="strike-list">' + rows + '</div>'
      );
    } catch (e) {
      render('<div class="md-empty">Could not load strike prices.</div>');
    }
  }

  async function resolveOptionForChart(s, chain, strike, leg) {
    const under = strategyUnderlying(s);
    if (!under) return null;
    /* Primary: resolve via API using the underlying's display name */
    try {
      const sec = await fetch('/api/option_security', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol_name: under.name, expiry: chain.expiry, strike: strike,
          option_type: leg, exchange_segment: under.exch })
      }).then(r => r.json());
      if (sec && sec.status === 'success' && sec.data) return sec.data;
    } catch (e) {}
    /* Fallback: use the security id embedded in the cached option chain */
    const row = engine.findChainRow(chain.records, strike);
    if (row) {
      const sid = leg === 'CE' ? row['CE SID'] : row['PE SID'];
      if (sid) {
        return {
          security_id: parseInt(sid),
          exchange_segment: under.exch === 'BSE_FNO' ? 'BSE_FNO' : 'NSE_FNO',
          trading_symbol: (under.name || '') + ' ' + strike.toFixed(0) + ' ' + leg,
          instrument_type: symbolUnderlyingIsIndex(s.symbol) ? 'OPTIDX' : 'OPTSTK'
        };
      }
    }
    return null;
  }

  async function openStrikeChart(strategyId, strike, leg) {
    const list = [...loadSaved(), ...activeStrategies];
    const s = list.find(x => x.id === strategyId);
    if (!s) { alert('Strategy not found'); return; }
    try {
      const chain = await fetchStrikeChain(s);
      if (!chain) { alert('Could not fetch the option chain for this strategy'); return; }
      const sec = await resolveOptionForChart(s, chain, strike, leg);
      if (!sec) { alert('Could not resolve the option security for strike ' + strike + ' ' + leg); return; }
      const under = strategyUnderlying(s);
      const optInst = sec.instrument_type || (symbolUnderlyingIsIndex(s.symbol) ? 'OPTIDX' : 'OPTSTK');
      if (typeof selectedSymbol !== 'undefined') {
        selectedSymbol = { id: sec.security_id, exch: sec.exchange_segment, inst: optInst,
          name: sec.trading_symbol, ocId: (under && under.id), ocExch: (under && under.exch) };
      }
      const tf = s.tf || '5min';
      if (typeof setChartTf === 'function') setChartTf(tf);
      const d = await fetch('/api/candles', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ security_id: sec.security_id, exchange_segment: sec.exchange_segment,
          instrument_type: optInst, timeframe: tf, force: 1 }) }).then(r => r.json());
      if (d && d.status === 'success' && d.data && d.data.length && window.IndChart) {
        IndChart.setCandles(d.data, true);
        if (typeof activateTab === 'function') activateTab('chart');
        const label = document.getElementById('chartSymbolLabel');
        if (label) label.textContent = sec.trading_symbol;
        document.getElementById('status').textContent = 'Strike chart: ' + sec.trading_symbol + ' (' + leg + ')';
      } else {
        alert('No candle data available yet for ' + strike + ' ' + leg);
      }
    } catch (e) {
      alert('Could not open strike chart: ' + (e && e.message ? e.message : e));
    }
  }

  function monitorDetailsHTML(s, charts) {
    let html = '';
    html += strikeSectionHTML(s);
    const all = (charts || []).filter(c => c && c.symbol);
    if (!all.length) return html + '<div class="md-empty">No charts monitored for this strategy yet — assign symbols in the Assign tab.</div>';
    const entryConds = (s.entry && s.entry.indId) ? [s.entry].concat(s.entry.chain || []) : [];
    const exitConds = (s.exit && s.exit.indId) ? [s.exit].concat(s.exit.chain || []) : [];
    if (s.entry && s.entry.paneCond && s.entry.paneCond.indId) entryConds.push(paneCondToCond(s.entry.paneCond));
    if (s.entry && s.entry.paneConds && s.entry.paneConds.length) {
      s.entry.paneConds.forEach(p => { if (p && p.indId) entryConds.push(paneCondToCond(p)); });
    }
    if (s.exit && s.exit.paneCond && s.exit.paneCond.indId) exitConds.push(paneCondToCond(s.exit.paneCond));
    if (s.exit && s.exit.paneConds && s.exit.paneConds.length) {
      s.exit.paneConds.forEach(p => { if (p && p.indId) exitConds.push(paneCondToCond(p)); });
    }
    const moveList = s.entry && s.entry.paneMoves && s.entry.paneMoves.length ? s.entry.paneMoves : (s.entry && s.entry.paneMove && s.entry.paneMove.indId ? [s.entry.paneMove] : []);
    /* One automatically-created section per chart the strategy monitors. */
    all.forEach((ch, idx) => {
      const candles = ch.candles || [];
      const name = (ch.symbol && ch.symbol.name) || (ch.symbol && ch.symbol.id) || ('Chart ' + (idx + 1));
      html += '<div class="md-chart">' +
        '<div class="md-chart-head"><span class="md-chart-name">' + esc(name) + '</span>' +
        '<span class="md-chart-tf">' + esc(s.tf) + '</span>' +
        (candles.length ? '<span class="md-chart-prev">close ' + fmtNum(candles[candles.length - 1].close) + '</span>' : '') + '</div>';
      if (!candles.length) {
        html += '<div class="md-empty">No candle data for this chart yet — waiting for realtime market data...</div>';
      } else {
        if (entryConds.length) html += condChainBlocks('Entry Conditions', entryConds, candles);
        moveList.forEach(pm => {
          if (pm && pm.indId) html += paneMoveBlock('Entry Pane Movement', pm, candles);
        });
        if (exitConds.length) html += condChainBlocks('Exit Conditions', exitConds, candles);
        html += gapRowsHTML('Entry Gap Conditions', (s.entry && s.entry.gap) || {}, candles);
        html += gateHTML(s.gate || {}, candles);
        html += candlestickHTML(s.candlestick || {}, candles);
        html += '<div class="md-section"><div class="md-title">Overall</div><div class="md-row">' + chartSummaryHTML(s, ch) + '</div></div>';
      }
      html += '</div>';
    });
    return html;
  }

  function renderMonitorDropdown() {
    const sel = $('monitorStratSelect');
    if (!sel) return;
    sel.innerHTML = '';
    const list = loadSaved();
    if (!list.length) {
      const o = document.createElement('option');
      o.value = ''; o.textContent = 'No saved strategies yet — create one in the Strategies tab';
      sel.appendChild(o);
      return;
    }
    list.forEach(s => {
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = (s.name || 'Untitled') + ' [' + s.tf + ']';
      sel.appendChild(o);
    });
  }

  function addToMonitor() {
    const id = $('monitorStratSelect').value;
    if (!id) return;
    if (!monitorList.includes(id)) monitorList.push(id);
    persistMonitorList();
    renderMonitorList();
    startMonitorPoll();
  }

  function removeFromMonitor(id) {
    monitorList = monitorList.filter(x => x !== id);
    monitorExpanded.delete(id);
    delete monitorCharts[id];
    persistMonitorList();
    renderMonitorList();
  }

  function toggleMonitorDetails(id) {
    if (monitorExpanded.has(id)) monitorExpanded.delete(id);
    else monitorExpanded.add(id);
    renderMonitorList();
    if (monitorExpanded.has(id)) {
      const saved = loadSaved();
      const s = saved.find(x => x.id === id) || activeStrategies.find(x => x.id === id);
      if (s) loadStrikeInfo(s, id);
    }
  }

  function renderMonitorList() {
    const host = $('monitorList');
    if (!host) return;
    host.innerHTML = '';
    if (!monitorList.length) {
      host.innerHTML = '<div class="strat-empty">No strategies added to monitor. Pick a saved strategy above and press "+ Add to Monitor".</div>';
      return;
    }
    const saved = loadSaved();
    monitorList.forEach(id => {
      const s = saved.find(x => x.id === id) || activeStrategies.find(x => x.id === id);
      if (!s) return;
      const expanded = monitorExpanded.has(id);
      const charts = monitorCharts[id] || [];
      const meta = (s.symbol && s.symbol.name) || '-';
      const entryInd = s.entry && s.entry.indId ? indName(s.entry.indId) : 'no entry';
      const exitInd = s.exit && s.exit.indId ? indName(s.exit.indId) : 'no exit';
      const card = document.createElement('div');
      card.className = 'monitor-card' + (expanded ? ' expanded' : '');
      card.id = 'monitor-card-' + id;
      const summary = charts.length ? monitorSummaryHTML(s, charts) : '<span style="color:#666">Readings: waiting for live data...</span>';
      card.innerHTML =
        '<div class="monitor-head"><span class="monitor-name">' + esc(s.name || 'Untitled') + '</span>' +
        '<span class="monitor-badge">' + esc(s.cat === 'bearish' ? 'Bearish' : 'Bullish') + '</span></div>' +
        '<div class="monitor-meta">' + esc(meta) + ' &middot; ' + esc(s.tf) + ' &middot; entry: ' + esc(entryInd) +
        (s.exit && s.exit.indId ? ' &middot; exit: ' + esc(exitInd) : '') + '</div>' +
        '<div class="monitor-summary" id="monitor-summary-' + id + '">' + summary + '</div>' +
        '<div class="monitor-actions">' +
        '<button class="sbtn run" onclick="StratUI.toggleMonitorDetails(\'' + id + '\')">' + (expanded ? 'Hide Details' : 'Details') + '</button>' +
        '<button class="sbtn x" onclick="StratUI.removeFromMonitor(\'' + id + '\')">x Remove</button></div>' +
        (expanded ? '<div class="monitor-detail" id="monitor-detail-' + id + '">' + (charts.length ? monitorDetailsHTML(s, charts) : '<div class="md-empty">Fetching live readings...</div>') + '</div>' : '');
      host.appendChild(card);
    });
  }

  async function monitorTick() {
    if (!monitorList.length) return;
    const saved = loadSaved();
    for (const id of monitorList) {
      const s = saved.find(x => x.id === id) || activeStrategies.find(x => x.id === id);
      if (!s) continue;
      if (monitorExpanded.has(id)) loadStrikeInfo(s, id);
      const charts = strategyCharts(s);
      if (!charts.length) continue;
      const reads = [];
      for (const ch of charts) {
        let candles = null;
        try { candles = await engine.fetchCandlesFor(ch.symbol, ch.tf); } catch (e) { candles = null; }
        reads.push({ symbol: ch.symbol, candles: candles || [] });
      }
      if (!reads.some(r => r.candles && r.candles.length)) continue;
      monitorCharts[id] = reads;
      const detailHost = document.getElementById('monitor-detail-' + id);
      if (detailHost) detailHost.innerHTML = monitorDetailsHTML(s, reads);
      const sum = document.getElementById('monitor-summary-' + id);
      if (sum) sum.innerHTML = monitorSummaryHTML(s, reads);
    }
  }

  function startMonitorPoll() {
    if (monitorPollTimer) return;
    monitorTick();
    monitorPollTimer = setInterval(() => { monitorTick(); }, 2000);
  }

  /* ---------------- public ---------------- */
  function renderStratTfGrid() {
    const grid = $('stratTfGrid');
    if (!grid || grid.childElementCount) return;
    STRAT_TF.forEach(([tf, label]) => {
      const b = document.createElement('button');
      b.className = 'tf-btn' + (tf === selectedTf ? ' active' : '');
      b.textContent = label;
      b.dataset.tf = tf;
      b.onclick = () => {
        selectedTf = tf;
        grid.querySelectorAll('.tf-btn').forEach(x => x.classList.toggle('active', x.dataset.tf === tf));
      };
      grid.appendChild(b);
    });
  }

  const StratUI = {
    init() {
      renderStratTfGrid();
      activeStrategies = loadActive();
      renderSavedDropdown();
      renderActiveList();
      populateAssignSymbolSelect();
      populateAssignStratSelect();
      populateOpenChartStratSelect();
      renderAssignmentList();
      renderMonitorDropdown();
      renderMonitorList();
      if (monitorList.length) startMonitorPoll();
      document.addEventListener('statechange', () => {
        if (editId || !$('strategyBuilder').classList.contains('hidden')) {
          refreshIndicatorSelects();
          updateLiveReading();
        }
      });
      document.addEventListener('click', (e) => {
        /* Clicking a modal trigger button must not immediately close the modal
           it just opened (the button lives outside .assign-modal-box). */
        const t = e.target;
        const openIC = t.closest && t.closest('[onclick*="openIndexConf"]');
        const openChart = t.closest && t.closest('[onclick*="openChartForStrategy"], [onclick*="openChartModal"]');
        const m = $('assignChartModal');
        if (m && !m.classList.contains('hidden') && !e.target.closest('.assign-modal-box') && !openChart) {
          show(m, false);
          _chartModalStratId = null;
        }
        const icm = $('indexConfModal');
        if (icm && !icm.classList.contains('hidden') && !e.target.closest('.assign-modal-box') && !openIC) {
          show(icm, false);
          _icTargetId = null;
        }
        if (e.target.classList.contains('gap-row-remove')) {
          e.stopPropagation();
          removeGapRow(e.target);
        }
      });
      setInterval(() => {
        if (!$('strategyBuilder').classList.contains('hidden')) updateLiveReading();
      }, 1500);
      const catSel = $('stratCat');
      if (catSel) catSel.addEventListener('change', () => {
        if ($('candleToggle').checked) renderCandlestickSection(catSel.value);
      });
    },
    newStrategy() { fillBuilder(null); },
    cancelBuilder() { show($('strategyBuilder'), false); editId = null; },
    edit(id) {
      const s = activeStrategies.find(a => a.id === id) || loadSaved().find(a => a.id === id);
      if (s) fillBuilder(s);
    },
    save() { saveStrategy(); },
    addToMonitor,
    removeFromMonitor,
    toggleMonitorDetails,
    loadStrikeInfo,
    openStrikeChart,
    renderMonitorDropdown,
    openSelected,
    renderSavedDropdown,
    syncFields() { syncBuilderFields(); },
    onEntryIndChange() { renderIndInputs('strat'); refreshGapGateDropdowns(); syncBuilderFields(); },
    onExitIndChange() { renderIndInputs('exit'); refreshGapGateDropdowns(); syncBuilderFields(); },
    onPaneIndChange() { onPaneIndChange(); },
    onPaneMoveIndChange() { onPaneMoveIndChange(); },
    async viewTfChart() {
      if (typeof activateTab === 'function') activateTab('chart');
      if (typeof setChartTf === 'function') setChartTf(selectedTf);
      if (typeof selectedSymbol === 'undefined' || !selectedSymbol) return;
      if (!engine.isIndex(selectedSymbol)) return;
      const cat = $('stratCat').value || 'bullish';
      const leg = cat === 'bearish' ? 'PE' : 'CE';
      try {
        const tempSt = { strategy: { symbol: selectedSymbol }, expiry: null };
        const chain = await engine.fetchChain(tempSt);
        if (!chain || !chain.records) return;
        const atm = engine.findAtm(chain.records, chain.spot);
        if (atm == null) return;
        const stratStub = { cat, strike: { optionType: leg }, symbol: selectedSymbol };
        const sec = await engine.resolveOptionSecurity(stratStub, chain.expiry, atm, leg);
        if (typeof selectedSymbol !== 'undefined') {
          selectedSymbol = { id: sec.security_id, exch: sec.exchange_segment, inst: sec.instrument_type || 'OPTIDX',
            name: sec.trading_symbol, ocId: selectedSymbol.ocId, ocExch: selectedSymbol.ocExch };
        }
        const tf = typeof chartTf !== 'undefined' ? chartTf : '5min';
        const d = await fetch('/api/candles', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ security_id: sec.security_id, exchange_segment: sec.exchange_segment, instrument_type: sec.instrument_type || 'OPTIDX', timeframe: tf })
        }).then(r => r.json());
        if (d && d.status === 'success' && d.data && d.data.length && window.IndChart) {
          IndChart.setCandles(d.data, true);
          document.getElementById('chartSymbolLabel').textContent = sec.trading_symbol;
          document.getElementById('status').textContent = 'ATM option chart: ' + sec.trading_symbol;
        }
      } catch (e) {
        document.getElementById('status').textContent = 'Could not load ATM option chart';
      }
    },
    addAssignedSymbol() {
      const sel = $('assignSymbolSelect');
      if (!sel || !sel.value) return;
      const opts = allSymbolOptions();
      const found = opts.find(o => o.id === parseInt(sel.value));
      if (!found) return;
      if (assignedSymbols.some(s => s.id === found.id && s.exch === found.exch)) return;
      assignedSymbols.push(found);
      renderAssignSymbolTags();
    },
    removeAssignedSymbol(i) {
      assignedSymbols.splice(i, 1);
      renderAssignSymbolTags();
    },
    assignStrategy() {
      const stratId = $('assignStratSelect').value;
      if (!stratId) { alert('Select a strategy'); return; }
      if (!assignedSymbols.length) { alert('Add at least one symbol'); return; }
      const map = loadAssignments();
      const existing = map[stratId] || [];
      const merged = existing.slice();
      assignedSymbols.forEach(sym => {
        if (!merged.some(e => e.id === sym.id && e.exch === sym.exch)) merged.push(sym);
      });
      map[stratId] = merged;
      persistAssignments(map);
      assignedSymbols = [];
      renderAssignSymbolTags();
      renderAssignmentList();
    },
    removeAssignment(stratId, symId, exchStr) {
      const map = loadAssignments();
      const symIdNum = parseInt(symId);
      if (map[stratId]) {
        map[stratId] = map[stratId].filter(s => !(s.id === symIdNum && s.exch === exchStr));
        if (!map[stratId].length) delete map[stratId];
        persistAssignments(map);
        renderAssignmentList();
      }
    },
    onOpenChartStratChange() {
      const stratId = $('openChartStratSelect').value;
      const symSel = $('openChartSymbolSelect');
      if (!symSel || !stratId) return;
      const saved = loadSaved();
      const s = [...saved, ...activeStrategies].find(x => x.id === stratId);
      symSel.innerHTML = '<option value="">-- Select symbol --</option>';
      const ass = getAssignedSymbols(stratId);
      ass.forEach(sym => {
        const o = document.createElement('option');
        o.value = sym.id + ':' + sym.exch;
        o.textContent = sym.name;
        symSel.appendChild(o);
      });
      if (s && s.symbol) {
        const o = document.createElement('option');
        o.value = s.symbol.id + ':' + s.symbol.exch;
        o.textContent = s.symbol.name + ' (strategy symbol)';
        symSel.appendChild(o);
      }
    },
    openChartForStrategy() {
      const stratId = $('openChartStratSelect').value;
      if (!stratId) return;
      const symOpt = $('openChartSymbolSelect').value;
      const saved = loadSaved();
      const s = [...saved, ...activeStrategies].find(x => x.id === stratId);
      if (!s) return;
      const ass = getAssignedSymbols(stratId);
      let sym;
      if (symOpt) {
        const [idStr, exch] = symOpt.split(':');
        sym = ass.find(x => String(x.id) === idStr && x.exch === exch) || (s.symbol && String(s.symbol.id) === idStr ? s.symbol : null);
        if (!sym) sym = ass[0] || s.symbol;
      } else {
        sym = ass[0] || s.symbol;
      }
      if (!sym) { alert('No symbol available for this strategy'); return; }
      if (typeof selectedSymbol !== 'undefined') {
        selectedSymbol = JSON.parse(JSON.stringify(sym));
      }
      if (typeof setChartTf === 'function') setChartTf(s.tf);
      if (typeof onSymbolChange === 'function') {
        const sel = document.getElementById('symbolSelect');
        if (sel) {
          for (const opt of sel.options) {
            if (parseInt(opt.value) === sym.id && opt.getAttribute('data-exch') === sym.exch) {
              sel.value = opt.value;
              break;
            }
          }
        }
        onSymbolChange();
      }
      if (typeof activateTab === 'function') activateTab('chart');
    },
    run(id) {
      const s = activeStrategies.find(a => a.id === id);
      if (!s) return;
      engine.start(s);
    },
    runSaved(id) {
      const list = loadSaved();
      const s = list.find(x => x.id === id);
      if (!s) return;
      if (!activeStrategies.some(a => a.id === s.id)) {
        activeStrategies.push(JSON.parse(JSON.stringify(s)));
        persistActive();
      }
      renderActiveList();
      engine.start(activeStrategies.find(a => a.id === id));
    },
    openIndexConf(id) {
      _icTargetId = id;
      const saved = loadSaved();
      const active = activeStrategies;
      const s = [...saved, ...active].find(x => x.id === id);
      if (!s) return;
      const ic = s.indexConfirmation || { enabled: false, indices: [], strategyId: null };
      $('icEnabled').checked = !!ic.enabled;
      _icIndices = (ic.indices || []).slice();
      _icStratId = ic.strategyId || '';
      populateICIndexSelect();
      renderICIndexTags();
      populateICStratSelect();
      $('icStratSelect').value = _icStratId;
      $('indexConfTitle').textContent = 'Index Confirmation - ' + (s.name || 'Untitled');
      show($('indexConfModal'), true);
    },
    closeIndexConf() {
      show($('indexConfModal'), false);
      _icTargetId = null;
    },
    addICIndex() {
      const sel = $('icIndexSelect');
      if (!sel || !sel.value) return;
      const idx = IC_INDICES.find(i => i.id === parseInt(sel.value));
      if (!idx) return;
      if (_icIndices.some(i => i.id === idx.id)) return;
      _icIndices.push(JSON.parse(JSON.stringify(idx)));
      renderICIndexTags();
    },
    removeICIndex(i) {
      _icIndices.splice(i, 1);
      renderICIndexTags();
    },
    saveIndexConf() {
      if (!_icTargetId) return;
      const cfg = {
        enabled: $('icEnabled').checked,
        indices: _icIndices.slice(),
        strategyId: $('icStratSelect').value || null
      };
      if (cfg.enabled && (!cfg.indices.length || !cfg.strategyId)) {
        alert('Select at least one index and one saved strategy, or disable Index Confirmation.');
        return;
      }
      const saved = loadSaved();
      const si = saved.findIndex(s => s.id === _icTargetId);
      if (si >= 0) { saved[si].indexConfirmation = JSON.parse(JSON.stringify(cfg)); persistSaved(saved); }
      const ai = activeStrategies.findIndex(a => a.id === _icTargetId);
      if (ai >= 0) { activeStrategies[ai].indexConfirmation = JSON.parse(JSON.stringify(cfg)); persistActive(); }
      const running = engine.running.get(_icTargetId);
      if (running) running.strategy.indexConfirmation = JSON.parse(JSON.stringify(cfg));
      renderSavedList();
      renderActiveList();
      show($('indexConfModal'), false);
      _icTargetId = null;
    },
    stop(id) { engine.stop(id); },
    stopTrade(id) { engine.stopTrade(id); },
    remove(id) {
      engine.stop(id);
      activeStrategies = activeStrategies.filter(a => a.id !== id);
      persistActive();
      renderActiveList();
    },
    log,
    setStatus,
    setGateStatus,
    addGapRow,
    removeGapRow,
    addGateCond,
    saveGapCondition,
    saveEntryCondition,
    saveExitCondition,
    onExitReverseToggle,
    syncReverseExitConditions,
    addEntryCondition,
    addExitCondition,
    editCond,
    removeCond,
    setEntryConn,
    savePaneCondition,
    addPaneCondition,
    editPaneCond,
    removePaneCond,
    setPaneCondJoin,
    savePaneMoveCondition,
    addPaneMoveCondition,
    editPaneMoveCond,
    removePaneMoveCond,
    setPaneMoveJoin,
    _candleChanged() {
      const p = collectCandlestickPatterns();
      _candleEntry = p.entry;
      _candleExit = p.exit;
      collectExitCandlePatterns();
      const gGrid = $('gatePatternGrid');
      if (gGrid) {
        _gatePatterns = [];
        gGrid.querySelectorAll('input[type="checkbox"]').forEach(cb => {
          if (cb.checked) _gatePatterns.push(cb.dataset.key);
        });
      }
      syncBuilderFields();
    }
  };

  window.StratUI = StratUI;
  window.StratEngine = engine;

  /* init when DOM ready */
  function boot() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => StratUI.init());
    } else {
      StratUI.init();
    }
  }
  boot();

})();
