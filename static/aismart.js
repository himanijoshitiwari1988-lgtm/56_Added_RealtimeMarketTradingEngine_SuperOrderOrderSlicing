/* Dhan Algo - AI Smart Trading Engine
 *
 * Applies the exact same live-trading settings as the Auto Strategy Experiment
 * Engine (universal defaults, strike modes, symbols / top movers, bullish /
 * bearish filters, trade limits, AI auto-trades, time gates, lot / margin /
 * take-profit / trails) but runs USER-SELECTED SAVED STRATEGIES from the
 * Paper Trade section live on realtime market data.
 *
 * There is NO backtest engine here: no backtest period, no AI auto-timeframe,
 * no experiment runner. Every selected saved strategy is evaluated on the
 * latest closed bar of each resolved instrument (option premium chart for
 * strikes, the underlying otherwise) and, when the entry signal fires and the
 * per-day budget allows, a simulated paper order is placed through
 * window.PaperTrade.autoEntry so the exact same SL / TP / trailing lifecycle
 * (checkAutoTargetSl) applies as the Auto Experiment paper trader.
 *
 * Performance: all settings are applied per strategy in well under 10ms.
 *   - candle series are fetched once per (instrument, timeframe) and cached
 *   - indicator arrays are computed once per candle array (WeakMap cache) and
 *     shared across every strategy that references the same indicator
 *   - only the LAST bar of each series is evaluated per strategy
 *   - the hot path contains no network calls (candles are cached for 1.5s)
 */
window.createAISmartTrading = function (suffix) {
  'use strict';
  suffix = suffix || '';

  const AST_KEY = 'algodhan_aismart_v1' + suffix;
  const SAVED_KEY = 'algodhan_strategies_v1';
  /* Poll cadence. 300ms hammered Dhan's chart API into rate-limit cooldown
     (36% of /api/candles calls returned 503), starving the engines of candles
     so trades never placed. 1000ms keeps entry response near-instant (signals
     land on closed candles, not on poll frequency) while cutting request load
     ~3x so the feed stays out of the rate-limit window. */
  const POLL_MS = 1000;
  const MAX_LOG = 60;

  /* The AST engine is a single always-on engine that mirrors its positions into
     the BASE paper-trade engine (TabEngines.papertrade.papertrade). The global
     window.PaperTrade facade routes to the ACTIVE paper tab (_paperActiveEngine)
     so duplicated paper tabs trade on their own state. If AST used the facade
     directly, simply clicking a cloned paper tab would silently re-point AST's
     entries AND its running-trade reconcile at that other engine: existing
     base-engine buckets would vanish from the AST running list (reconcileClosed
     deletes the mirror) and new entries would land in the wrong ledger. Every
     AST execution / reconcile / close / reset therefore pins to the base engine. */
  function basePaper() {
    if (window.TabEngines && window.TabEngines.papertrade && window.TabEngines.papertrade.papertrade) {
      return window.TabEngines.papertrade.papertrade;
    }
    return (window.PaperTrade && window.PaperTrade.getState) ? window.PaperTrade : null;
  }
  function astChargesOn() {
    const bpt = basePaper();
    return !!(bpt && bpt.getCharges && bpt.getCharges());
  }

  const GROUPS = [
    { key: 'candlestick', label: 'Candlestick patterns' },
    { key: 'elliott', label: 'Elliott Wave' },
    { key: 'indicator', label: 'Indicators' },
    { key: 'pane', label: 'Pane indicators (volume / money flow)' },
    { key: 'symmetry', label: 'Symmetry' },
    { key: 'structure', label: 'Chart structure' },
    { key: 'atr', label: 'ATR / Volatility' }
  ];
  const GROUP_KEYS = GROUPS.map(g => g.key);
  /* Research-stream scoping checkboxes inside the Bullish/Bearish indicator
     filter sections. Each key maps to the research group the engine is
     restricted to for that side when ticked. */
  const STREAM_FLAG_GROUPS = {
    bullCandle: 'candlestick', bullElliott: 'elliott', bullIndicator: 'indicator',
    bullPane: 'pane', bullSymmetry: 'symmetry', bullStructure: 'structure', bullAtr: 'atr',
    bearCandle: 'candlestick', bearElliott: 'elliott', bearIndicator: 'indicator',
    bearPane: 'pane', bearSymmetry: 'symmetry', bearStructure: 'structure', bearAtr: 'atr'
  };
  const STREAM_FLAG_KEYS = Object.keys(STREAM_FLAG_GROUPS);

  /* HTML element ids for the filter checkboxes are PascalCase
     ('astFilterPaneCrossUp'), while the state keys are camelCase
     ('paneCrossUp'). Capitalize the first letter when composing an id. */
  const capId = k => k.charAt(0).toUpperCase() + k.slice(1);

  /* Candle-level entry gates added to the Bullish/Bearish filter sections:
     volume trend, fake breakout / fake breakdown, reversal bars, and the
     pane-indicator gates (main line vs signal line crossover, and every line
     of every pane indicator trending the same way). */
  /* Pane Indicator Behaviour filter section. Every gate evaluates the pane
     indicator's MAIN line (v0) on the strategy's candle chart with the
     indicator's DEFAULT settings (the same cached alignedSeries path as the
     OI Trend / BBW gates - O(n), no per-bar scan) and only asks how the line
     BEHAVES: increasing upward or increasing downward. No fixed thresholds.
       Group 1 (direction mirror): MACD, PPO, AO, SMI, DPO, RSI, MFI, UO,
         Williams %R, BB%b, OBV, PVT, A/D, SMF. Bullish list = main line
         increasing upward; Bearish list = main line increasing downward.
         Flag key = bullPbr<Ind> / bearPbr<Ind>.
         Group 2 (trend strength): BBW, ATR. The line answers STRENGTH, not
          direction (rising = strong trend / expanding bands / wide candles), so
          BOTH the Bullish and Bearish list carry the SAME single toggle
          (<side>Pbr<Ind>Up = line increasing). No decreasing variant.
        Group 3 (participation): VolOsc. Volume participation only (rising =
          volume picking up). Same single rising toggle in both lists like
          Group 2. */
  const PB_G1 = ['macd', 'ppo', 'ao', 'smiio', 'dpo', 'rsi', 'mfi', 'uo', 'williamsR', 'bbpct', 'obv', 'pvt', 'ad', 'smf', 'cmf', 'tsi', 'cci', 'fisher', 'stochrsi', 'sqzmom', 'aroon', 'elderforce'];
  const PB_G2 = ['bbw', 'atr', 'volosc'];
  const PB_LABEL = {
    macd: 'MACD', ppo: 'PPO', ao: 'AO', smiio: 'SMI', dpo: 'DPO', rsi: 'RSI', mfi: 'MFI', uo: 'UO',
    williamsR: 'Williams %R', bbpct: 'BB%b', obv: 'OBV', pvt: 'PVT', ad: 'A/D', smf: 'SMF',
    adx: 'ADX', bbw: 'BBW', atr: 'ATR', volosc: 'VolOsc',
    cmf: 'CMF', tsi: 'TSI', cci: 'CCI', fisher: 'Fisher', stochrsi: 'Stoch RSI',
    sqzmom: 'Squeeze Mom.', aroon: 'Aroon', vortex: 'Vortex', elderforce: 'Force Index'
  };
  const PB_DEF_SETTINGS = {
    macd: { fast: 12, slow: 26, signal: 9 }, ppo: { fast: 12, slow: 26, signal: 9 },
    ao: { fast: 5, slow: 34 }, smiio: { shortlen: 13, longlen: 25, siglen: 9 }, dpo: { length: 20 },
    rsi: { length: 14, smoothLength: 0 }, mfi: { length: 14 }, uo: { fast: 7, medium: 14, slow: 28 },
    williamsR: { length: 14 }, bbpct: { length: 20, mult: 2 }, obv: { maLength: 30 }, pvt: {}, ad: {},
    smf: { length: 14, signalLen: 9, volLen: 20, pulseCap: 3 },
    adx: { length: 14 }, bbw: { length: 20, mult: 2, source: 'close' }, atr: { length: 14 },
    volosc: { fast: 5, slow: 14, center: 0 },
    cmf: { length: 20 }, tsi: { long: 25, short: 13, signal: 13 }, cci: { length: 20 },
    fisher: { length: 9 }, stochrsi: { rsiLen: 14, stochLen: 14, k: 3, d: 3 },
    sqzmom: { bbLen: 20, bbMult: 2, kcLen: 20, kcMult: 1.5 }, aroon: { length: 25 },
    vortex: { length: 14 }, elderforce: { smooth: 13 }
  };
  function pbCap(id) { return id.charAt(0).toUpperCase() + id.slice(1); }
  const PB_BULL_KEYS = PB_G1.map(id => 'bullPbr' + pbCap(id)).concat(PB_G2.map(id => 'bullPbr' + pbCap(id) + 'Up'));
  const PB_BEAR_KEYS = PB_G1.map(id => 'bearPbr' + pbCap(id)).concat(PB_G2.map(id => 'bearPbr' + pbCap(id) + 'Up'));
  /* Multi-Line Momentum Gap (PBG) Meet (level) gates. Every pane indicator that
     draws TWO lines (main + its signal / the competing direction line) exposes
     a bullish and a bearish level-hold toggle that reads the researched
     STRONG-TREND behaviour of the pair:
       - bull: main line sits ABOVE its signal (gap positive), the main line is
         NOT falling and the signed gap (main - signal) is NOT shrinking — i.e.
         momentum is up and the gap is holding or widening. Active WHILE the
         relationship holds (a "level"/Meet condition - a fresh cross event is
         NOT required, and a pinned steady gap stays active, e.g. Aroon Up
         holding above Aroon Down for the whole trend).
       - bear: mirror - main below signal, main not rising, gap not rising.
     `v`/`s` pick the two series of the indicator (default main v0 + signal v1).
     Evaluated through the cached alignedSeries path like every other PB gate -
     O(1) per bar, no extra scans. ADX is special-cased with its own custom
     function below: the purple ADX gauge (v0) has to be trending while the
     +DI (v1) / -DI (v2) pair decides the direction. */
  const PBG_LIST = [
    { id: 'macd', name: 'MACD', s: { fast: 12, slow: 26, signal: 9 } },
    { id: 'ppo', name: 'PPO', s: { fast: 12, slow: 26, signal: 9 } },
    { id: 'smiio', name: 'SMI', s: { shortlen: 13, longlen: 25, siglen: 9 }, pair: 'v2' },
    { id: 'tsi', name: 'TSI', s: { long: 25, short: 13, signal: 13 } },
    { id: 'stochrsi', name: 'Stoch RSI', s: { rsiLen: 14, stochLen: 14, k: 3, d: 3 } },
    { id: 'smf', name: 'SMF', s: { length: 14, signalLen: 9, volLen: 20, pulseCap: 3 } },
    { id: 'rsi', name: 'RSI', s: { length: 14, smoothLength: 9 } },
    { id: 'obv', name: 'OBV', s: { maLength: 30 } },
    { id: 'fisher', name: 'Fisher', s: { length: 9 } },
    { id: 'aroon', name: 'Aroon', s: { length: 25 } },
    { id: 'vortex', name: 'Vortex', s: { length: 14 } },
    { id: 'adx', name: 'ADX', s: { length: 14 } }
  ];
  const PBG_BULL_KEYS = PBG_LIST.map(d => 'bullPbg' + pbCap(d.id));
  const PBG_BEAR_KEYS = PBG_LIST.map(d => 'bearPbg' + pbCap(d.id));
  /* Overlay Indicator Behaviour (OBR). These are OVERLAY lines - indicator
     series drawn on the candle pane, so unlike the pane PB_* values they sit at
     real price levels. Each row is a direction-mirror toggle just like PB
     Group-1: Bullish list = the overlay line must be increasing upward,
     Bearish list = the overlay line must be increasing downward. */
  const OBR_LIST = [
    { tok: 'Hma', id: 'hma', valueKey: 'v0', settings: { length: 9, source: 'close' }, name: 'HMA' },
    { tok: 'Tenkan', id: 'ichimoku', valueKey: 'v0', settings: { tenkan: 9, kijun: 26, senkou: 52 }, name: 'Ichimoku Tenkan-sen' },
    { tok: 'Kijun', id: 'ichimoku', valueKey: 'v1', settings: { tenkan: 9, kijun: 26, senkou: 52 }, name: 'Ichimoku Kijun-sen' },
    { tok: 'SenkouA', id: 'ichimoku', valueKey: 'v2', settings: { tenkan: 9, kijun: 26, senkou: 52 }, name: 'Ichimoku Senkou A' },
    { tok: 'Keltner', id: 'keltner', valueKey: 'v1', settings: { length: 20, mult: 2 }, name: 'Keltner middle' },
    { tok: 'Donchian', id: 'donchian', valueKey: 'v1', settings: { length: 20 }, name: 'Donchian middle' },
    { tok: 'TrendCore', id: 'vlcore', valueKey: 'v0', settings: { length: 31, atrLength: 38, gap: 1.85, confirm: 1, wickLen: 1, straightLine: true, useVolume: true }, name: 'Trend Core' },
    { tok: 'SupplyDemand', id: 'supplydemand', valueKey: 'v0', settings: { atrPeriod: 14, atrMult: 2, minPct: 0.15, eqTol: 25 }, name: 'Supply Demand' }
  ];
  const OB_BULL_KEYS = OBR_LIST.map(d => 'bullObr' + d.tok);
  const OB_BEAR_KEYS = OBR_LIST.map(d => 'bearObr' + d.tok);
  /* Overlay Meet Condition (level) rows: the candle close must be above the
     overlay line (Bullish list) / below it (Bearish list). Unlike the OBR
     direction toggles these are level-holds - active while the relationship
     holds, a cross is not required. */
  const MEET_OVL_LIST = [
    { tok: 'Hma', id: 'hma', valueKey: 'v0', settings: { length: 9, source: 'close' }, name: 'HMA' },
    { tok: 'Tenkan', id: 'ichimoku', valueKey: 'v0', settings: { tenkan: 9, kijun: 26, senkou: 52 }, name: 'Ichimoku Tenkan-sen' },
    { tok: 'Kijun', id: 'ichimoku', valueKey: 'v1', settings: { tenkan: 9, kijun: 26, senkou: 52 }, name: 'Ichimoku Kijun-sen' },
    { tok: 'Keltner', id: 'keltner', valueKey: 'v1', settings: { length: 20, mult: 2 }, name: 'Keltner middle' },
    { tok: 'Donchian', id: 'donchian', valueKey: 'v1', settings: { length: 20 }, name: 'Donchian middle' },
    { tok: 'TrendCore', id: 'vlcore', valueKey: 'v0', settings: { length: 31, atrLength: 38, gap: 1.85, confirm: 1, wickLen: 1, straightLine: true, useVolume: true }, name: 'Trend Core' }
  ];
  const MEET_BULL_KEYS = MEET_OVL_LIST.map(d => 'bullMeetOvl' + d.tok);
  const MEET_BEAR_KEYS = MEET_OVL_LIST.map(d => 'bearMeetOvl' + d.tok);
  /* Is any Pane Indicator Behaviour sub-filter of one section ticked? */
  function pbrOn(f, side) {
    const pb = side === 'bull' ? PB_BULL_KEYS : PB_BEAR_KEYS;
    const ob = side === 'bull' ? OB_BULL_KEYS : OB_BEAR_KEYS;
    const mt = side === 'bull' ? MEET_BULL_KEYS : MEET_BEAR_KEYS;
    const pg = side === 'bull' ? PBG_BULL_KEYS : PBG_BEAR_KEYS;
    return !!f && (pb.concat(ob, mt, pg)).some(k => !!f[k]);
  }
  /* Readable name of an Overlay Indicator Behaviour flag for filter logs. */
  function obrName(k) {
    const tok = k.replace(/^(bull|bear)Obr/, '');
    const d = OBR_LIST.filter(x => x.tok === tok)[0];
    const nm = d ? d.name : tok;
    return nm + ' line ' + (/^bull/.test(k) ? 'increasing upward' : 'increasing downward');
  }
  /* Readable name of an Overlay Meet Condition (level) flag for filter logs. */
  function ovlMeetName(k) {
    const tok = k.replace(/^(bull|bear)MeetOvl/, '');
    const d = MEET_OVL_LIST.filter(x => x.tok === tok)[0];
    const nm = d ? d.name : tok;
    return 'Close ' + (/^bull/.test(k) ? 'above' : 'below') + ' ' + nm + ' (level)';
  }
  /* Readable name of a Pane Indicator Behaviour flag for filter logs. */
  function pbrName(k) {
    const raw = k.replace(/^(bull|bear)Pbr/, '');
    const lc = raw.charAt(0).toLowerCase() + raw.slice(1);
    const g2 = /^(adx|bbw|atr|volosc)Up$/.exec(lc);
    const nm = PB_LABEL[g2 ? g2[1] : lc] || raw;
    const rising = g2 ? true : /^bull/.test(k);
    return nm + ' line ' + (rising ? 'increasing upward' : 'increasing downward');
  }
  /* Readable name of a Multi-Line Momentum Gap (level) flag for filter logs. */
  function pbgName(k) {
    if (k === 'bullPbgVortex') return 'Vortex VI+ holds above VI- with VI+ rising & VI- falling (gap widening, level)';
    if (k === 'bearPbgVortex') return 'Vortex VI- holds above VI+ with VI- rising & VI+ falling (gap widening, level)';
    if (k === 'bullPbgAdx') return 'ADX rising, +DI above -DI and the +DI/-DI gap widening (level)';
    if (k === 'bearPbgAdx') return 'ADX falling, +DI below -DI and the +DI/-DI gap widening (level)';
    const raw = k.replace(/^(bull|bear)Pbg/, '');
    const d = PBG_LIST.filter(x => x.id.toLowerCase() === raw.toLowerCase())[0];
    const nm = d ? d.name : raw;
    return nm + ' main-vs-signal gap ' + (/^bull/.test(k) ? 'holding/widening upward (level)' : 'holding/widening downward (level)');
  }
  const FILTER_EXTRA_KEYS = ['bullVolUp', 'bullVolDown', 'bullFakeBreakout', 'bullReversal', 'bearVolUp', 'bearVolDown', 'bearFakeBreakout', 'bearReversal', 'bullGreenCandle', 'bearRedCandle', 'paneCrossUp', 'paneCrossDown', 'paneIncUpAll', 'paneIncDownAll', 'bullBbwInc', 'bearBbwInc', 'bullBbCrossBelow', 'bullBbCrossAbove', 'bullPcCrossBelow', 'bullPcCrossAbove', 'bearBbCrossBelow', 'bearBbCrossAbove', 'bearPcCrossBelow', 'bearPcCrossAbove', 'bullSmf', 'bearSmf', 'bullVl', 'bearVl', 'bullAsr', 'bearAsr', 'bullOit', 'bearOit', 'bullEma9_21', 'bearEma9_21', 'bullEma21_35', 'bearEma21_35', 'bullEma35_50', 'bearEma35_50', 'bullEma50_100', 'bearEma50_100', 'bullEma100_200', 'bearEma100_200', 'bullEma200_300', 'bearEma200_300', 'bullSt10_1_2', 'bearSt10_1_2', 'bullSt10_2_3', 'bearSt10_2_3', 'bullSt1CloseCrossAbove', 'bearSt1CloseCrossBelow', 'bullVwapCloseCrossAbove', 'bearVwapCloseCrossBelow', 'bullMeetEma9_21', 'bullMeetEma21_35', 'bullMeetEma35_50', 'bullMeetEma50_100', 'bullMeetEma100_200', 'bullMeetEma200_300', 'bearMeetEma9_21', 'bearMeetEma21_35', 'bearMeetEma35_50', 'bearMeetEma50_100', 'bearMeetEma100_200', 'bearMeetEma200_300', 'bullMeetSt10_1_2', 'bullMeetSt10_2_3', 'bearMeetSt10_1_2', 'bearMeetSt10_2_3', 'bullMeetCloseSt', 'bearMeetCloseSt', 'bullMeetCloseVwap', 'bearMeetCloseVwap', 'bullMeetPaneCross', 'bearMeetPaneCross', 'bullMeetCross', 'bearMeetCross', 'bullMeetCloseBb', 'bearMeetCloseBb', 'bullMeetClosePc', 'bearMeetClosePc', 'bullMeetVl', 'bearMeetVl'].concat(PB_BULL_KEYS, PB_BEAR_KEYS, OB_BULL_KEYS, OB_BEAR_KEYS, MEET_BULL_KEYS, MEET_BEAR_KEYS, PBG_BULL_KEYS, PBG_BEAR_KEYS);
  /* Directional filter keys: the Bullish / Bearish indicator-filter section
     sub-options. Used to strip the opposite-direction filters before they are
     appended to a running strategy (a bullish strategy never receives bearish
     filter gates and vice versa). */
  const BULL_FILTER_KEYS = ['incUp', 'crossUp', 'gapUp', 'incUpAll', 'gtUp', 'ltUp', 'bullVolUp', 'bullVolDown', 'bullFakeBreakout', 'bullReversal', 'bullGreenCandle', 'paneCrossUp', 'paneIncUpAll', 'bullBbwInc', 'bullBbCrossBelow', 'bullBbCrossAbove', 'bullPcCrossBelow', 'bullPcCrossAbove', 'bullSmf', 'bullVl', 'bullAsr', 'bullOit', 'bullEma9_21', 'bullEma21_35', 'bullEma35_50', 'bullEma50_100', 'bullEma100_200', 'bullEma200_300', 'bullSt10_1_2', 'bullSt10_2_3', 'bullSt1CloseCrossAbove', 'bullVwapCloseCrossAbove', 'bullMeetEma9_21', 'bullMeetEma21_35', 'bullMeetEma35_50', 'bullMeetEma50_100', 'bullMeetEma100_200', 'bullMeetEma200_300', 'bullMeetSt10_1_2', 'bullMeetSt10_2_3', 'bullMeetCloseSt', 'bullMeetCloseVwap', 'bullMeetPaneCross', 'bullMeetCross', 'bullMeetCloseBb', 'bullMeetClosePc', 'bullMeetVl'].concat(PB_BULL_KEYS, OB_BULL_KEYS, MEET_BULL_KEYS, PBG_BULL_KEYS);
  const BEAR_FILTER_KEYS = ['incDown', 'crossDown', 'gapDown', 'incDownAll', 'gtDown', 'ltDown', 'bearVolUp', 'bearVolDown', 'bearFakeBreakout', 'bearReversal', 'bearRedCandle', 'paneCrossDown', 'paneIncDownAll', 'bearBbwInc', 'bearBbCrossBelow', 'bearBbCrossAbove', 'bearPcCrossBelow', 'bearPcCrossAbove', 'bearSmf', 'bearVl', 'bearAsr', 'bearOit', 'bearEma9_21', 'bearEma21_35', 'bearEma35_50', 'bearEma50_100', 'bearEma100_200', 'bearEma200_300', 'bearSt10_1_2', 'bearSt10_2_3', 'bearSt1CloseCrossBelow', 'bearVwapCloseCrossBelow', 'bearMeetEma9_21', 'bearMeetEma21_35', 'bearMeetEma35_50', 'bearMeetEma50_100', 'bearMeetEma100_200', 'bearMeetEma200_300', 'bearMeetSt10_1_2', 'bearMeetSt10_2_3', 'bearMeetCloseSt', 'bearMeetCloseVwap', 'bearMeetPaneCross', 'bearMeetCross', 'bearMeetCloseBb', 'bearMeetClosePc', 'bearMeetVl'].concat(PB_BEAR_KEYS, OB_BEAR_KEYS, MEET_BEAR_KEYS, PBG_BEAR_KEYS);
  const VALID_MODES = ['above', 'below', 'both_atm', 'above_atm', 'below_atm', 'both_atm_inc', 'atm'];
  const VALID_TYPES = ['both', 'CE', 'PE'];
  const ALL_TIMEFRAMES = ['1min', '5min'];

  /* Market-off simulation chart symbol. This is a synthetic instrument served
     by the built-in CandleSimulator (traded as a spot underlying) - used to
     keep paper-trading alive when the real market is closed. */
  var SIM_SYMBOL = { id: 900001, exch: 'SIM', inst: 'EQUITY', name: 'SIM CHART', sim: true };
  function isSimSymbol(sym) {
    return !!(sym && (sym.sim === true || (sym.id !== undefined && sym.id === 900001)));
  }

  const _contractsCache = new Map();
  const _CONTRACTS_CACHE_MS = 120 * 1000;
  const _CACHE_MAX = 3000;
  /* Reload-survival snapshot of resolved option chains + picked strikes. A page
     reload wipes these in-memory maps, so right after a reload every symbol
     would re-resolve its chain against Dhan in one cold-start burst (503 storm,
     rate-limit cooldown) and the "Picked Strikes" panel + strategies would sit
     empty while the cooldown lasts. The snapshot is persisted (throttled) and
     restored on boot so reloads keep serving the last-known strikes/contracts
     instead of hammering the chain API again. */
  const _PICK_PERSIST_KEY = AST_KEY + ':strikes';
  const _PICK_PERSIST_MAX = 250;
  let _pickPersistTimer = 0;
  /* Premium-chart candle fallback: set per instrument when its run-in option
     premium chart has no candles. While set, the strategy evaluates its
     indicators on the underlying/spot chart AND executes on the underlying so
     the instrument is never skipped on a missing premium chart. Cleared as soon
     as the premium candles come back. */
  const _candleFbk = {};
  /* Live Data Pool: instruments resolved by the most recent engine tick, reused
     by the pool readout so it never re-resolves option chains (zero extra Dhan
     calls - it only reads the shared candle cache + live feed). */
  let _lastInstruments = [];
  /* Multi Chart Grid event log: appended whenever an open chart's entry
     condition / signal meets ('signal') or a paper trade executes ('entry').
     Owned by this engine instance (base vs clone tab logs stay separate) and
     serialised into every grid snapshot as `events`. */
  let _gridEvSeq = 0;
  const _gridEvents = [];
  function gridEvent(type, o) {
    try {
      _gridEvents.push(Object.assign({ seq: ++_gridEvSeq, ts: Date.now(), type: type }, o || {}));
      if (_gridEvents.length > 400) _gridEvents.shift();
    } catch (e) {}
  }
  /* Client-side option-chain rate-limit backoff. Dhan limits the option-chain
     surface independently of the chart surface; when /api/auto_strikes answers
     "Rate limited" the engine backs off ~30s before trying again instead of
     re-hitting it on every tick (each extra hit re-arms the server cooldown
     and starves the chart/candle calls the whole UI needs). */
   let _chainRlUntil = {};   // surface key -> cooldown-until timestamp
   const _CHAIN_RL_SEC = 30;
   /* The server cooldown is per derivative surface (IDX_I, NSE_FNO, BSE_FNO,
      ...), so the client backoff mirrors that: a 429 on one surface must not
      block option resolution on every other surface for the whole app. */
   function _chainSurface(symbol) {
     if (!symbol) return 'global';
     return isIndex(symbol) ? String(symbol.ocExch || 'IDX_I') : String(symbol.exch || 'NSE_EQ');
   }
   function chainRateLimited(symbol) {
     const k = _chainSurface(symbol);
     return Date.now() < (_chainRlUntil[k] || 0);
   }
   function markChainRateLimited(symbol) {
     const k = _chainSurface(symbol);
     if (Date.now() >= (_chainRlUntil[k] || 0)) _chainRlUntil[k] = Date.now() + _CHAIN_RL_SEC;
   }
  /* Symbol id -> { symbol, contracts, at } of the last option strikes resolved
     by contractsFor(). These are the strikes the engine picked up to execute
     paper trade / backtest and are shown in the "Picked Strikes" panel. */
  const _pickedStrikes = new Map();
  /* Identity key for a symbol in the picked-strikes map. The numeric id alone is
     NOT unique across segments (e.g. NIFTY 50 id 13 collides with the F&O stock
     ABB id 13), so the exchange segment is folded in to keep index and stock
     entries distinct. */
  function _pickedKey(symbol) {
    return String(symbol && symbol.id) + ':' + ((symbol && (symbol.ocExch || symbol.exch)) || '');
  }

  const $id = id => document.getElementById(id + suffix) || document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt2 = n => (n === null || n === undefined || isNaN(n)) ? '--' : Number(n).toFixed(2);
  const fmtMoney = n => (n === null || n === undefined || isNaN(n)) ? '--' : '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function _cacheSet(map, key, value) {
    if (map.size > _CACHE_MAX) map.clear();
    map.set(key, value);
  }

  function _persistPickedSnapshot() {
    try {
      const picked = [];
      _pickedStrikes.forEach((rec, key) => {
        if (!rec || !rec.symbol || !rec.contracts || !rec.contracts.length) return;
        picked.push({ key: key, symbol: rec.symbol, contracts: rec.contracts, at: rec.at || 0 });
      });
      const cache = [];
      _contractsCache.forEach((rec, key) => {
        if (!rec || !rec.contracts || !rec.contracts.length) return;
        cache.push({ key: key, contracts: rec.contracts, at: rec.at || 0 });
      });
      const snap = { v: 1, at: Date.now(), picked: picked.slice(-_PICK_PERSIST_MAX), cache: cache.slice(-(_PICK_PERSIST_MAX * 2)) };
      localStorage.setItem(_PICK_PERSIST_KEY, JSON.stringify(snap));
    } catch (e) {}
  }
  /* Throttled persistence: chains resolve on engine ticks (up to ~1/s per
     symbol), so persist at most every few seconds instead of on every set. */
  function _schedulePickedPersist() {
    if (_pickPersistTimer) return;
    _pickPersistTimer = setTimeout(() => {
      _pickPersistTimer = 0;
      _persistPickedSnapshot();
    }, 2500);
  }
  function _restorePickedSnapshot() {
    try {
      const snap = JSON.parse(localStorage.getItem(_PICK_PERSIST_KEY) || 'null');
      if (!snap) return;
      const now = Date.now();
      const MIN_AGE = 0;                 // never serve chains newer than this (ms)
      const MAX_AGE = _CONTRACTS_CACHE_MS * 3;  // 6min hard cap on snapshot reuse
      (snap.cache || []).forEach(e => {
        if (!e || !e.contracts || !e.contracts.length) return;
        const age = now - (e.at || 0);
        if (age > MAX_AGE || age < MIN_AGE) return;
        _cacheSet(_contractsCache, e.key, { at: e.at || now, contracts: e.contracts });
      });
      (snap.picked || []).forEach(e => {
        if (!e || !e.symbol || !e.contracts || !e.contracts.length) return;
        const age = now - (e.at || 0);
        if (age > MAX_AGE || age < MIN_AGE) return;
        _pickedStrikes.set(e.key, { symbol: e.symbol, contracts: e.contracts, at: e.at || now });
      });
    } catch (e) {}
  }

  /* ---------------- name lookups ---------------- */
  function indName(id) {
    const def = (window.IndChart && IndChart.IND) ? IndChart.IND[id] : null;
    return def ? (def.name || id) : id;
  }
  function patternName(key) {
    const CP = window.CandlePatterns;
    return (CP && CP.PATTERNS && CP.PATTERNS[key]) ? CP.PATTERNS[key].name : key;
  }
  function displayName(s) {
    if (s == null) return '';
    const id = s.id != null ? String(s.id) : null;
    if (id && typeof SYMBOL_DISPLAY_NAMES !== 'undefined' && SYMBOL_DISPLAY_NAMES[id]) return SYMBOL_DISPLAY_NAMES[id];
    return s.name || id || '';
  }
  function groupOf(method) {
    switch (method) {
      case 'Candlestick': return 'candlestick';
      case 'Elliott Wave': return 'elliott';
      case 'Indicator': return 'indicator';
      case 'Volume': case 'Supply/Demand': return 'pane';
      case 'Symmetry': return 'symmetry';
      case 'Chart Structure': return 'structure';
      case 'Volatility': return 'atr';
      default: return 'other';
    }
  }

  /* ---------------- condition builder (mirrors AE's cond) ---------------- */
  function cond(o) {
    return {
      indId: o.indId || '',
      indSettings: o.indSettings || {},
      valueKey: o.valueKey || 'v0',
      logic: o.logic || 'gt',
      cmpType: o.cmpType || 'number',
      cmpIndId: o.cmpIndId || '',
      cmpSettings: o.cmpSettings || {},
      cmpValueKey: o.cmpValueKey || 'v0',
      candleKey: o.candleKey || 'close',
      number: o.number != null ? o.number : 0,
      candlePatterns: o.candlePatterns || [],
      dir: o.dir != null ? o.dir : 0,
      pair: o.pair || ''
    };
  }

  /* ---------------- fast aligned series cache (pure, per candle array) ---------------- */
  const _seriesByCandles = new WeakMap();
  const _patternByCandles = new WeakMap();
  const _settingsKeyCache = new WeakMap();
  const _volCache = new WeakMap();

  function settingsKey(settings) {
    if (!settings) return '{}';
    let k = _settingsKeyCache.get(settings);
    if (k === undefined) { k = JSON.stringify(settings); _settingsKeyCache.set(settings, k); }
    return k;
  }
  function seriesMap(candles) {
    let m = _seriesByCandles.get(candles);
    if (!m) { m = new Map(); _seriesByCandles.set(candles, m); }
    return m;
  }
  function computeAligned(indId, settings, valueKey, candles) {
    const n = candles.length;
    const def = window.IndChart && window.IndChart.IND ? window.IndChart.IND[indId] : null;
    let arr = null;
    if (def && def.compute) {
      try {
        const out = def.compute(candles, settings || {});
        if (Array.isArray(out) && out.length) {
          const idx = parseInt(String(valueKey || 'v0').replace(/^v/, ''), 10) || 0;
          const s = out[idx];
          if (s && s.data && s.data.length) {
            const tmap = new Map();
            for (let i = 0; i < n; i++) tmap.set(candles[i].time, i);
            const aligned = new Array(n).fill(null);
            for (const p of s.data) {
              const i = tmap.get(p.time);
              if (i != null) aligned[i] = Number(p.value);
            }
            arr = aligned;
          }
        }
      } catch (e) { arr = null; }
    }
    return arr;
  }
  function alignedSeries(indId, settings, valueKey, candles) {
    if (!indId) return null;
    const m = seriesMap(candles);
    const key = indId + '|' + (valueKey || 'v0') + '|' + settingsKey(settings);
    if (m.has(key)) return m.get(key);
    const arr = computeAligned(indId, settings, valueKey, candles);
    m.set(key, arr);
    return arr;
  }
  function readTwo(indId, settings, valueKey, i, candles) {
    const arr = alignedSeries(indId, settings, valueKey, candles);
    if (!arr) return { last: null, prev: null };
    return { last: arr[i], prev: i > 0 ? arr[i - 1] : null };
  }

  function patternHits(patterns, candles) {
    if (!patterns || !patterns.length) return null;
    const CP = window.CandlePatterns;
    if (!CP || !CP.detectAny) return null;
    const n = candles.length;
    let map = _patternByCandles.get(candles);
    if (!map) { map = new Map(); _patternByCandles.set(candles, map); }
    const key = patterns.slice().sort().join(',');
    let hits = map.get(key);
    if (!hits) {
      hits = new Array(n).fill(false);
      for (let j = 0; j < n; j++) {
        const slice = candles.slice(Math.max(0, j - 6), j + 1);
        hits[j] = !!CP.detectAny(patterns, slice);
      }
      map.set(key, hits);
    }
    return hits;
  }
  function patternHitAt(patterns, i, candles) {
    const hits = patternHits(patterns, candles);
    return hits ? hits[i] : false;
  }

  function cmpReadAt(cond, i, candles) {
    switch (cond.cmpType) {
      case 'number': { const v = Number(cond.number) || 0; return { last: v, prev: v }; }
      case 'candle': {
        /* HFT execution-trigger override: the scanner can evaluate the strategy
           condition against the candle open / high / low / close (whichever the
           user picked) instead of the per-condition candleKey, while keeping the
           whole decision synchronous and under 2ms. */
        const k = _hftExecOn || cond.candleKey || 'close';
        return { last: candles[i] ? candles[i][k] : null, prev: i > 0 ? candles[i - 1][k] : null };
      }
      case 'self': { const key = cond.cmpValueKey || 'v1'; return readTwo(cond.indId, cond.indSettings, key, i, candles); }
      case 'plot': return readTwo(cond.indId, cond.indSettings, 'v0', i, candles);
      case 'smoothed': return readTwo(cond.indId, cond.indSettings, 'v1', i, candles);
      case 'indicator': return readTwo(cond.cmpIndId, cond.cmpSettings, cond.cmpValueKey || 'v0', i, candles);
      default: return { last: null, prev: null };
    }
  }

  function trendAt(arr, i, want) {
    if (!arr) return false;
    const vals = [];
    for (let k = Math.max(0, i - 6); k <= i; k++) {
      const v = arr[k];
      if (v != null && !isNaN(v)) vals.push(v);
    }
    if (vals.length < 4) return false;
    let dir;
    if (window.CrossDetector && CrossDetector.seriesDirection) {
      dir = CrossDetector.seriesDirection(vals);
    } else {
      dir = vals[vals.length - 1] > vals[0] ? 'up' : (vals[vals.length - 1] < vals[0] ? 'down' : 'flat');
    }
    return want === 'up' ? dir === 'up' : dir === 'down';
  }

  /* Cached volume series (per candle array) so the volume trend filters reuse
     one pass instead of recomputing per condition. */
  function volumeSeries(candles) {
    let a = _volCache.get(candles);
    if (!a) {
      a = candles.map(c => (c && c.volume != null) ? Number(c.volume) : 0);
      _volCache.set(candles, a);
    }
    return a;
  }

  /* Bollinger upper band minus lower band width per candle array, cached.
     An increasing width = band expansion = volatility expansion. */
  const _bbGapCache = new WeakMap();
  function bbGapSeries(settings, candles) {
    let m = _bbGapCache.get(candles);
    if (!m) { m = new Map(); _bbGapCache.set(candles, m); }
    const key = settingsKey(settings);
    if (m.has(key)) return m.get(key);
    const up = alignedSeries('bb', settings, 'v0', candles);
    const low = alignedSeries('bb', settings, 'v2', candles);
    const gap = new Array(candles.length).fill(null);
    for (let i = 0; i < candles.length; i++) {
      if (up[i] == null || low[i] == null) continue;
      gap[i] = up[i] - low[i];
    }
    m.set(key, gap);
    return gap;
  }

  /* Auto Support Resistance per-bar gap series (cached per candle array +
     settings + side). Replays the autosr indicator's ATR-scaled ZigZag exactly
     and records the support/resistance level AS OF EACH BAR (no lookahead),
     then returns the signed gap from the candle close to that level:
       side 'sup' -> close - support   (bullish: widening gap = price rising away)
       side 'res' -> resistance - close (bearish: widening gap = price falling)
     A widening gap is detected by trendAt(gap, i, 'up'). Single O(n) pass,
     no per-point allocation, well under 1ms for 2000 candles. */
  const _autoSRCache = new WeakMap();
  function autoSRGapSeries(settings, candles, side) {
    let m = _autoSRCache.get(candles);
    if (!m) { m = new Map(); _autoSRCache.set(candles, m); }
    const key = settingsKey(settings) + '|' + side;
    if (m.has(key)) return m.get(key);
    const n = candles.length;
    const gap = new Array(n).fill(null);
    if (n) {
      const atrPer = Math.max(2, Math.round(settings.atrPeriod) || 14);
      const atrMult = Number(settings.atrMult) > 0 ? Number(settings.atrMult) : 2;
      const minPct = Number(settings.minPct) >= 0 ? Number(settings.minPct) : 0.15;
      /* Wilder ATR inline (matches indicators.js wilderArr(trArr(c), atrPer)). */
      const atr = new Array(n).fill(null);
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const c = candles[i];
        const tr = i ? Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close)) : c.high - c.low;
        if (i < atrPer) { sum += tr; if (i === atrPer - 1) atr[i] = sum / atrPer; }
        else atr[i] = (atr[i - 1] * (atrPer - 1) + tr) / atrPer;
      }
      const th = (i, ref) => {
        const a = atr[i] != null && isFinite(atr[i]) ? atr[i] * atrMult : 0;
        const p = Math.abs(ref) * (minPct / 100);
        return Math.max(a, p);
      };
      /* ZigZag: track the current leg extreme, confirm a pivot only on a
         reversal >= the ATR threshold, remember the last confirmed pivot. */
      let dir = 1, ext = candles[0].high, extIdx = 0, lastPivot = null;
      let runMin = candles[0].low, runMax = candles[0].high;
      for (let i = 0; i < n; i++) {
        const c = candles[i];
        if (c.low < runMin) runMin = c.low;
        if (c.high > runMax) runMax = c.high;
        if (i > 0) {
          const t = th(i, c.close);
          if (dir >= 0) {
            if (c.high > ext) { ext = c.high; extIdx = i; }
            if (c.low <= ext - t) {
              lastPivot = { type: 'high', price: ext, idx: extIdx };
              dir = -1; ext = c.low; extIdx = i;
            }
          } else {
            if (c.low < ext) { ext = c.low; extIdx = i; }
            if (c.high >= ext + t) {
              lastPivot = { type: 'low', price: ext, idx: extIdx };
              dir = 1; ext = c.high; extIdx = i;
            }
          }
        }
        let sup = null, res = null;
        if (dir >= 0) { res = ext; sup = lastPivot ? lastPivot.price : runMin; }
        else { sup = ext; res = lastPivot ? lastPivot.price : runMax; }
        if (c.close == null) continue;
        gap[i] = side === 'sup' ? c.close - sup : res - c.close;
      }
    }
    m.set(key, gap);
    return gap;
  }

  /* Fake-breakout / fake-breakdown detection on the candle levels:
       - bullish: price dipped below the prior N-bar low (false breakdown, stop
         hunt) but closed back above the broken level.
       - bearish: price poked above the prior N-bar high (false breakout) but
         closed back below the broken level. */
  function fakeBreakoutAt(candles, i, dir) {
    if (!candles || i < 1) return false;
    const c = candles[i], p = candles[i - 1];
    if (!c || !p || c.close == null || p.high == null || p.low == null || c.low == null || c.high == null) return false;
    const N = 20;
    if (dir === 'bullish') {
      let lo = Infinity;
      for (let k = Math.max(0, i - N); k < i; k++) {
        const b = candles[k];
        if (b && b.low != null && b.low < lo) lo = b.low;
      }
      if (!isFinite(lo) || c.low >= lo) return false;
      return c.close > p.low;
    }
    let hi = -Infinity;
    for (let k = Math.max(0, i - N); k < i; k++) {
      const b = candles[k];
      if (b && b.high != null && b.high > hi) hi = b.high;
    }
    if (!isFinite(hi) || c.high <= hi) return false;
    return c.close < p.high;
  }

  /* Simple reversal-bar detection on the candle levels:
       - bullish: the prior 5-bar move was down and the current bar closes green.
       - bearish: the prior 5-bar move was up and the current bar closes red. */
  function reversalAt(candles, i, dir) {
    if (!candles || i < 6) return false;
    const c = candles[i], c1 = candles[i - 1], before = candles[i - 6];
    if (!c || !c1 || !before || c.close == null || c.open == null || c1.close == null || before.close == null) return false;
    if (dir === 'bullish') return c1.close < before.close && c.close > c.open;
    return c1.close > before.close && c.close < c.open;
  }

  /* Distinct pane-type indicators referenced by a strategy template (entry,
     exit, entryExtra, exitExtra). Pane indicators render in their own sub-pane
     (MACD, OBV, RSI, ADX, BBW, volume oscillators, ...). */
  function paneIndsOf(tpl) {
    const out = [];
    const seen = new Set();
    const add = (c) => {
      if (!c) return;
      if (Array.isArray(c)) { c.forEach(add); return; }
      if (!c.indId) return;
      const def = (window.IndChart && IndChart.IND) ? IndChart.IND[c.indId] : null;
      if (!def || def.type !== 'pane') return;
      const key = c.indId + '|' + JSON.stringify(c.indSettings || {});
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ indId: c.indId, indSettings: c.indSettings || {} });
    };
    add(Array.isArray(tpl.entry) ? tpl.entry[0] : tpl.entry);
    add(tpl.exit);
    (tpl.entryExtra || []).forEach(add);
    (tpl.exitExtra || []).forEach(add);
    return out;
  }

  /* Line/series keys of an indicator (v0 = main line, v1 = signal, v2 = ...). */
  function paneLineKeys(indId) {
    if (window.IndChart && IndChart.valueOptionsFor) {
      const opts = IndChart.valueOptionsFor(indId);
      if (opts && opts.length) return opts.map(o => o[0]);
    }
    return ['v0'];
  }

  function twinFor(indId, settings) {
    if (!indId || !settings) return null;
    const s = Object.assign({}, settings);
    const up = (v, max) => Math.min(max, Math.max(2, Math.round((Number(v) || 1) * 2)));
    if (indId === 'supertrend') {
      const f = Number(s.factor) || 3;
      s.factor = f > 1.5 ? f - 1 : f + 1;
      return Math.abs(Number(s.factor) - f) > 1e-9 ? s : null;
    }
    let changed = false;
    if (s.length != null) { s.length = up(s.length, 500); changed = true; }
    if (s.fast != null) { s.fast = up(s.fast, 200); changed = true; }
    if (s.slow != null) { s.slow = up(s.slow, 500); changed = true; }
    if (s.atrPeriod != null) { s.atrPeriod = up(s.atrPeriod, 200); changed = true; }
    if (s.signalLength != null) { s.signalLength = up(s.signalLength, 50); changed = true; }
    if (s.smooth != null) { s.smooth = up(s.smooth, 50); changed = true; }
    if (s.maLength != null) { s.maLength = up(s.maLength, 500); changed = true; }
    if (s.mult != null) { s.mult = Math.round(((Number(s.mult) || 2) * 1.5) * 100) / 100; changed = true; }
    return changed ? s : null;
  }

  /* Every distinct indicator series referenced by a strategy template (entry,
     exit, entryExtra, exitExtra). Used by the "all pane + overlay indicators"
     increasing-upward / increasing-downward filters so the trend gate applies
     to every indicator the strategy evaluates, not just the primary entry. */
  function templateIndicators(tpl) {
    const out = [];
    const seen = new Set();
    const add = (c) => {
      if (!c) return;
      if (Array.isArray(c)) { c.forEach(add); return; }
      if (!c.indId) return;
      const key = c.indId + '|' + JSON.stringify(c.indSettings || {}) + '|' + (c.valueKey || 'v0');
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ indId: c.indId, indSettings: c.indSettings || {}, valueKey: c.valueKey || 'v0' });
    };
    add(Array.isArray(tpl.entry) ? tpl.entry[0] : tpl.entry);
    add(tpl.exit);
    (tpl.entryExtra || []).forEach(add);
    (tpl.exitExtra || []).forEach(add);
    return out;
  }

  /* Entry filter conditions from the enabled Bullish/Bearish trend + cross
     gates. Parameterized on `filters` so they run against THIS engine's own
     settings instead of the Auto Experiment state. */
  function buildFilterConditions(tpl, filters) {
    const f = filters || {};
    const enabled = (f.bullish && (f.incUp || f.crossUp || f.gapUp || f.incUpAll || f.gtUp || f.ltUp || f.bullVolUp || f.bullVolDown || f.bullFakeBreakout || f.bullReversal || f.paneCrossUp || f.paneIncUpAll || f.bullBbwInc || f.bullBbCrossBelow || f.bullBbCrossAbove || f.bullPcCrossBelow || f.bullPcCrossAbove || f.bullSmf || f.bullVl || f.bullAsr || f.bullOit || f.bullEma9_21 || f.bullEma21_35 || f.bullEma35_50 || f.bullEma50_100 || f.bullEma100_200 || f.bullEma200_300 || f.bullSt10_1_2 || f.bullSt10_2_3 || f.bullSt1CloseCrossAbove || f.bullVwapCloseCrossAbove || f.bullMeetEma9_21 || f.bullMeetEma21_35 || f.bullMeetEma35_50 || f.bullMeetEma50_100 || f.bullMeetEma100_200 || f.bullMeetEma200_300 || f.bullMeetSt10_1_2 || f.bullMeetSt10_2_3 || f.bullMeetCloseSt || f.bullMeetCloseVwap || f.bullMeetPaneCross || f.bullMeetCross || f.bullMeetCloseBb || f.bullMeetClosePc || f.bullMeetVl || f.bullGreenCandle || pbrOn(f, 'bull'))) || (f.bearish && (f.incDown || f.crossDown || f.gapDown || f.incDownAll || f.gtDown || f.ltDown || f.bearVolUp || f.bearVolDown || f.bearFakeBreakout || f.bearReversal || f.paneCrossDown || f.paneIncDownAll || f.bearBbwInc || f.bearBbCrossBelow || f.bearBbCrossAbove || f.bearPcCrossBelow || f.bearPcCrossAbove || f.bearSmf || f.bearVl || f.bearAsr || f.bearOit || f.bearEma9_21 || f.bearEma21_35 || f.bearEma35_50 || f.bearEma50_100 || f.bearEma100_200 || f.bearEma200_300 || f.bearSt10_1_2 || f.bearSt10_2_3 || f.bearSt1CloseCrossBelow || f.bearVwapCloseCrossBelow || f.bearMeetEma9_21 || f.bearMeetEma21_35 || f.bearMeetEma35_50 || f.bearMeetEma50_100 || f.bearMeetEma100_200 || f.bearMeetEma200_300 || f.bearMeetSt10_1_2 || f.bearMeetSt10_2_3 || f.bearMeetCloseSt || f.bearMeetCloseVwap || f.bearMeetPaneCross || f.bearMeetCross || f.bearMeetCloseBb || f.bearMeetClosePc || f.bearMeetVl || f.bearRedCandle || pbrOn(f, 'bear')));
    if (!enabled) return [];
    const out = [];
    /* Candle-level gates (volume trend, fake breakout, reversal) apply to the
       strategy's candle chart directly and do not need a primary indicator. */
    if (f.bullish && f.bullVolUp) out.push(cond({ indId: '', logic: 'volUp', cmpType: 'candle' }));
    if (f.bullish && f.bullVolDown) out.push(cond({ indId: '', logic: 'volDown', cmpType: 'candle' }));
    if (f.bullish && f.bullFakeBreakout) out.push(cond({ indId: '', logic: 'fakeBreakout', cmpType: 'candle', dir: 1 }));
    if (f.bullish && f.bullReversal) out.push(cond({ indId: '', logic: 'reversal', cmpType: 'candle', dir: 1 }));
    /* Candle-color gate: the strategy may only ENTER while the candle at the
       decision bar is green (close above open). Other bullish filters can be
       met, but a red forming candle must first turn green before the trade
       opens - avoids entering into a falling candle. */
    if (f.bullish && f.bullGreenCandle) out.push(cond({ indId: '', logic: 'greenCandle', cmpType: 'candle' }));
    if (f.bearish && f.bearVolUp) out.push(cond({ indId: '', logic: 'volUp', cmpType: 'candle' }));
    if (f.bearish && f.bearVolDown) out.push(cond({ indId: '', logic: 'volDown', cmpType: 'candle' }));
    if (f.bearish && f.bearFakeBreakout) out.push(cond({ indId: '', logic: 'fakeBreakout', cmpType: 'candle', dir: -1 }));
    if (f.bearish && f.bearReversal) out.push(cond({ indId: '', logic: 'reversal', cmpType: 'candle', dir: -1 }));
    /* Candle-color gate (bearish mirror): entry only while the candle at the
       decision bar is red (close below open). */
    if (f.bearish && f.bearRedCandle) out.push(cond({ indId: '', logic: 'redCandle', cmpType: 'candle' }));
    /* Pane-indicator gates: main line vs signal line crossover (e.g. "MACD line
       crossed above signal line") for every pane indicator that has a signal,
       and every line of every pane indicator trending the same way. */
    if (f.paneCrossUp || f.paneCrossDown) {
      const logic = f.paneCrossUp ? 'crossAbove' : 'crossBelow';
      paneIndsOf(tpl).forEach(p => {
        if (paneLineKeys(p.indId).length < 2) return;
        out.push(cond({ indId: p.indId, indSettings: p.indSettings, valueKey: 'v0', logic, cmpType: 'smoothed' }));
      });
    }
    if (f.bullMeetPaneCross || f.bearMeetPaneCross) {
      const logic = f.bullMeetPaneCross ? 'crossAbove' : 'crossBelow';
      paneIndsOf(tpl).forEach(p => {
        if (paneLineKeys(p.indId).length < 2) return;
        out.push(cond({ indId: p.indId, indSettings: p.indSettings, valueKey: 'v0', logic, cmpType: 'smoothed' }));
      });
    }
    if (f.paneIncUpAll || f.paneIncDownAll) {
      const logic = f.paneIncUpAll ? 'incUp' : 'incDown';
      paneIndsOf(tpl).forEach(p => {
        paneLineKeys(p.indId).forEach(k => out.push(cond({ indId: p.indId, indSettings: p.indSettings, valueKey: k, logic, cmpType: 'number' })));
      });
    }
    if (f.bullBbwInc || f.bearBbwInc) {
      paneIndsOf(tpl).filter(p => p.indId === 'bbw').forEach(p => {
        out.push(cond({ indId: p.indId, indSettings: p.indSettings, valueKey: 'v0', logic: 'incUp', cmpType: 'number' }));
      });
    }
    /* Smart Money Flow gate: SMF main line above/below its signal line. The SMF
       indicator (id 'smf') is evaluated with default settings on the strategy's
       candle chart; a bullish gate requires main > signal (accumulation), a
       bearish gate requires main < signal (distribution). */
    const smfDef = { length: 14, signalLen: 9, volLen: 20, pulseCap: 3 };
    if (f.bullish && f.bullSmf) out.push(cond({ indId: 'smf', indSettings: smfDef, valueKey: 'v0', logic: 'crossAbove', cmpType: 'smoothed' }));
    if (f.bearish && f.bearSmf) out.push(cond({ indId: 'smf', indSettings: smfDef, valueKey: 'v0', logic: 'crossBelow', cmpType: 'smoothed' }));
    /* Volume Line gate: the volume line (vl) is the trend-following volume line.
       Bullish = VL increasing upward AND volume increasing; Bearish = VL
       increasing downward AND volume increasing. Both conditions are ANDed. */
    const vlDef = { length: 14, signalLen: 9, volLen: 20 };
    if (f.bullish && f.bullVl) {
      out.push(cond({ indId: 'vl', indSettings: vlDef, valueKey: 'v0', logic: 'incUp', cmpType: 'number' }));
      out.push(cond({ indId: '', logic: 'volUp', cmpType: 'candle' }));
    }
    if (f.bearish && f.bearVl) {
      out.push(cond({ indId: 'vl', indSettings: vlDef, valueKey: 'v0', logic: 'incDown', cmpType: 'number' }));
      out.push(cond({ indId: '', logic: 'volUp', cmpType: 'candle' }));
    }
    /* Volume Line level gate: the Volume Line holds above/below its own Signal
       line (vl v0 vs vl v1 as a level, not a fresh cross - mirrors the SMF gate
       and the (level) Meet filters). */
    if (f.bullish && f.bullMeetVl) out.push(cond({ indId: 'vl', indSettings: vlDef, valueKey: 'v0', logic: 'crossAbove', cmpType: 'smoothed' }));
    if (f.bearish && f.bearMeetVl) out.push(cond({ indId: 'vl', indSettings: vlDef, valueKey: 'v0', logic: 'crossBelow', cmpType: 'smoothed' }));
    /* OI Trend gate: the OI Trend regime line (the EMA9/21 ATR-hysteresis
       direction line the OI Trend overlay draws on the candlestick chart) must
       be increasing upward for a bullish filter and increasing downward for a
       bearish filter. Evaluated with the OI Trend default settings on the
       strategy's candle chart, so it works like the drawn line. */
    const oitDef = { fast: 9, slow: 21, enterK: 0.45, exitK: 0.12 };
    if (f.bullish && f.bullOit) out.push(cond({ indId: 'oitrend', indSettings: oitDef, valueKey: 'v0', logic: 'incUp', cmpType: 'number' }));
    if (f.bearish && f.bearOit) out.push(cond({ indId: 'oitrend', indSettings: oitDef, valueKey: 'v0', logic: 'incDown', cmpType: 'number' }));
    /* Auto Support Resistance gate: gap between the candle structure and the
       auto-drawn support/resistance lines. Bullish = the gap from the support
       line keeps widening (price rising away from support); bearish = the gap
       below the resistance line keeps widening (price falling away below
       resistance). The per-bar gap series is cached and O(n). */
    const asrDef = { atrPeriod: 14, atrMult: 2.0, minPct: 0.15 };
    if (f.bullish && f.bullAsr) out.push(cond({ indId: 'autosr', indSettings: asrDef, valueKey: 'v0', logic: 'asrSupGapUp', cmpType: 'number' }));
    if (f.bearish && f.bearAsr) out.push(cond({ indId: 'autosr', indSettings: asrDef, valueKey: 'v0', logic: 'asrResGapUp', cmpType: 'number' }));
    /* Candle close vs indicator middle-band gates: close crossed above / below
       the Bollinger Bands (bb) or Price Channel (pc) middle band (v1). These
       are computed with default indicator settings and apply to any strategy.
       The cross gates (close crossed above/below the middle band) are the
       expansion variant: they require the BB upper/lower bands to be moving
       apart (upper band moving away from lower band = rising volatility). The
       (level, middle rising/falling) Meet gates do NOT check band expansion.
       Both middle bands are analysed on a 10-period mid band. */
    const bbMid = { length: 20, mult: 2, source: 'close', midType: 'sma', midLength: 10 };
    const pcMid = { length: 20, midType: 'midpoint', midLength: 10 };
    if (f.bullBbCrossAbove || f.bearBbCrossAbove) out.push(cond({ indId: 'bb', indSettings: bbMid, valueKey: 'v1', logic: 'closeCrossAbove', expand: true }));
    if (f.bullBbCrossBelow || f.bearBbCrossBelow) out.push(cond({ indId: 'bb', indSettings: bbMid, valueKey: 'v1', logic: 'closeCrossBelow', expand: true }));
    if (f.bullPcCrossAbove || f.bearPcCrossAbove) out.push(cond({ indId: 'pc', indSettings: pcMid, valueKey: 'v1', logic: 'closeCrossAbove' }));
    if (f.bullPcCrossBelow || f.bearPcCrossBelow) out.push(cond({ indId: 'pc', indSettings: pcMid, valueKey: 'v1', logic: 'closeCrossBelow' }));
    if (f.bullMeetCloseBb) {
      out.push(cond({ indId: 'bb', indSettings: bbMid, valueKey: 'v1', logic: 'closeCrossAbove' }));
      out.push(cond({ indId: 'bb', indSettings: bbMid, valueKey: 'v1', logic: 'incUp', cmpType: 'number' }));
    }
    if (f.bearMeetCloseBb) {
      out.push(cond({ indId: 'bb', indSettings: bbMid, valueKey: 'v1', logic: 'closeCrossBelow' }));
      out.push(cond({ indId: 'bb', indSettings: bbMid, valueKey: 'v1', logic: 'incDown', cmpType: 'number' }));
    }
    if (f.bullMeetClosePc) {
      out.push(cond({ indId: 'pc', indSettings: pcMid, valueKey: 'v1', logic: 'closeCrossAbove' }));
      out.push(cond({ indId: 'pc', indSettings: pcMid, valueKey: 'v1', logic: 'incUp', cmpType: 'number' }));
    }
    if (f.bearMeetClosePc) {
      out.push(cond({ indId: 'pc', indSettings: pcMid, valueKey: 'v1', logic: 'closeCrossBelow' }));
      out.push(cond({ indId: 'pc', indSettings: pcMid, valueKey: 'v1', logic: 'incDown', cmpType: 'number' }));
    }
    /* EMA ladder + Supertrend twin gates: a faster EMA (or a lower-factor
       Supertrend band) must have crossed above/below a slower one. Both series
       are computed with default settings on the strategy's candle chart, so
       these gates apply to any strategy and do not need a primary indicator. */
    const emaLadder = [[9, 21], [21, 35], [35, 50], [50, 100], [100, 200], [200, 300]];
    emaLadder.forEach(function (pair) {
      const fast = pair[0], slow = pair[1];
      if (f.bullish && f['bullEma' + fast + '_' + slow]) out.push(cond({ indId: 'ema', indSettings: { length: fast, source: 'close' }, valueKey: 'v0', logic: 'crossUpNow', cmpType: 'indicator', cmpIndId: 'ema', cmpSettings: { length: slow, source: 'close' }, cmpValueKey: 'v0' }));
      if (f.bearish && f['bearEma' + fast + '_' + slow]) out.push(cond({ indId: 'ema', indSettings: { length: fast, source: 'close' }, valueKey: 'v0', logic: 'crossDownNow', cmpType: 'indicator', cmpIndId: 'ema', cmpSettings: { length: slow, source: 'close' }, cmpValueKey: 'v0' }));
      if (f['bullMeetEma' + fast + '_' + slow]) out.push(cond({ indId: 'ema', indSettings: { length: fast, source: 'close' }, valueKey: 'v0', logic: 'gt', cmpType: 'indicator', cmpIndId: 'ema', cmpSettings: { length: slow, source: 'close' }, cmpValueKey: 'v0' }));
      if (f['bearMeetEma' + fast + '_' + slow]) out.push(cond({ indId: 'ema', indSettings: { length: fast, source: 'close' }, valueKey: 'v0', logic: 'lt', cmpType: 'indicator', cmpIndId: 'ema', cmpSettings: { length: slow, source: 'close' }, cmpValueKey: 'v0' }));
    });
    const stTwins = [[1, 2], [2, 3]];
    stTwins.forEach(function (pair) {
      const lo = pair[0], hi = pair[1];
      if (f.bullish && f['bullSt10_' + lo + '_' + hi]) out.push(cond({ indId: 'supertrend', indSettings: { atrPeriod: 10, factor: lo }, valueKey: 'v0', logic: 'crossUpNow', cmpType: 'indicator', cmpIndId: 'supertrend', cmpSettings: { atrPeriod: 10, factor: hi }, cmpValueKey: 'v0' }));
      if (f.bearish && f['bearSt10_' + lo + '_' + hi]) out.push(cond({ indId: 'supertrend', indSettings: { atrPeriod: 10, factor: lo }, valueKey: 'v0', logic: 'crossDownNow', cmpType: 'indicator', cmpIndId: 'supertrend', cmpSettings: { atrPeriod: 10, factor: hi }, cmpValueKey: 'v0' }));
      if (f['bullMeetSt10_' + lo + '_' + hi]) out.push(cond({ indId: 'supertrend', indSettings: { atrPeriod: 10, factor: lo }, valueKey: 'v0', logic: 'gt', cmpType: 'indicator', cmpIndId: 'supertrend', cmpSettings: { atrPeriod: 10, factor: hi }, cmpValueKey: 'v0' }));
      if (f['bearMeetSt10_' + lo + '_' + hi]) out.push(cond({ indId: 'supertrend', indSettings: { atrPeriod: 10, factor: lo }, valueKey: 'v0', logic: 'lt', cmpType: 'indicator', cmpIndId: 'supertrend', cmpSettings: { atrPeriod: 10, factor: hi }, cmpValueKey: 'v0' }));
    });
    /* Candle close vs price-guidance line gates: the close must have crossed
       above/below the Supertrend(10,1) band or the VWAP line on this bar (true
       prev->current cross, not a level hold). Bullish = close above the line,
       bearish = close below it. */
    if (f.bullish && f.bullSt1CloseCrossAbove) out.push(cond({ indId: 'supertrend', indSettings: { atrPeriod: 10, factor: 1 }, valueKey: 'v0', logic: 'crossDownNow', cmpType: 'candle', candleKey: 'close' }));
    if (f.bearish && f.bearSt1CloseCrossBelow) out.push(cond({ indId: 'supertrend', indSettings: { atrPeriod: 10, factor: 1 }, valueKey: 'v0', logic: 'crossUpNow', cmpType: 'candle', candleKey: 'close' }));
    const vwapDef = { anchor: 'trend' };
    if (f.bullish && f.bullVwapCloseCrossAbove) out.push(cond({ indId: 'vwap', indSettings: vwapDef, valueKey: 'v0', logic: 'crossDownNow', cmpType: 'candle', candleKey: 'close' }));
    if (f.bearish && f.bearVwapCloseCrossBelow) out.push(cond({ indId: 'vwap', indSettings: vwapDef, valueKey: 'v0', logic: 'crossUpNow', cmpType: 'candle', candleKey: 'close' }));
    if (f.bullMeetCloseSt) out.push(cond({ indId: 'supertrend', indSettings: { atrPeriod: 10, factor: 1 }, valueKey: 'v0', logic: 'lt', cmpType: 'candle', candleKey: 'close' }));
    if (f.bearMeetCloseSt) out.push(cond({ indId: 'supertrend', indSettings: { atrPeriod: 10, factor: 1 }, valueKey: 'v0', logic: 'gt', cmpType: 'candle', candleKey: 'close' }));
    if (f.bullMeetCloseVwap) out.push(cond({ indId: 'vwap', indSettings: vwapDef, valueKey: 'v0', logic: 'lt', cmpType: 'candle', candleKey: 'close' }));
    if (f.bearMeetCloseVwap) out.push(cond({ indId: 'vwap', indSettings: vwapDef, valueKey: 'v0', logic: 'gt', cmpType: 'candle', candleKey: 'close' }));
    /* Pane Indicator Behaviour gates - see the PB_* tables at the top of the
       engine. Each gate evaluates the pane indicator's MAIN line (v0) with the
       indicator's DEFAULT settings on the strategy's candle chart and only asks
       how the line is behaving right now (cached alignedSeries + trendAt, the
       same cheap O(n) path as the OI Trend / BBW gates - no extra scans):
         Group-1 mirror toggles (bullPbr<Ind> / bearPbr<Ind>): the main line
           must be increasing upward (Bullish list) / downward (Bearish list).
         Group-2 (strength) & Group-3 (participation) toggles (<side>Pbr<Ind>Up
           only, identical set carried in BOTH sections): line rising = strong
           trend / expanding bands / wide candles / volume picking up. The
           decreasing (contracting / weak / narrow) variants are not offered;
           when the same condition is requested from both sections it is simply
           pushed once per side (identical boolean). */
    if (f.bullish) {
      PB_G1.forEach(id => { const k = 'bullPbr' + pbCap(id); if (f[k]) out.push(cond({ indId: id, indSettings: PB_DEF_SETTINGS[id], valueKey: 'v0', logic: 'incUp', cmpType: 'number' })); });
      PB_G2.forEach(id => { const k = 'bullPbr' + pbCap(id) + 'Up'; if (f[k]) out.push(cond({ indId: id, indSettings: PB_DEF_SETTINGS[id], valueKey: 'v0', logic: 'incUp', cmpType: 'number' })); });
    }
    if (f.bearish) {
      PB_G1.forEach(id => { const k = 'bearPbr' + pbCap(id); if (f[k]) out.push(cond({ indId: id, indSettings: PB_DEF_SETTINGS[id], valueKey: 'v0', logic: 'incDown', cmpType: 'number' })); });
      PB_G2.forEach(id => { const k = 'bearPbr' + pbCap(id) + 'Up'; if (f[k]) out.push(cond({ indId: id, indSettings: PB_DEF_SETTINGS[id], valueKey: 'v0', logic: 'incUp', cmpType: 'number' })); });
    }
    OBR_LIST.forEach(d => {
      if (f.bullish && f['bullObr' + d.tok]) out.push(cond({ indId: d.id, indSettings: d.settings, valueKey: d.valueKey, logic: 'incUp', cmpType: 'number' }));
      if (f.bearish && f['bearObr' + d.tok]) out.push(cond({ indId: d.id, indSettings: d.settings, valueKey: d.valueKey, logic: 'incDown', cmpType: 'number' }));
    });
    MEET_OVL_LIST.forEach(d => {
      if (f['bullMeetOvl' + d.tok]) out.push(cond({ indId: d.id, indSettings: d.settings, valueKey: d.valueKey, logic: 'lt', cmpType: 'candle', candleKey: 'close' }));
      if (f['bearMeetOvl' + d.tok]) out.push(cond({ indId: d.id, indSettings: d.settings, valueKey: d.valueKey, logic: 'gt', cmpType: 'candle', candleKey: 'close' }));
    });
    /* Multi-Line Momentum Gap (PBG) level gates - see PBG_LIST at the top of
       the engine. Each gate evaluates the pane indicator's MAIN series vs its
       SIGNAL series (level-hold: no fresh cross required). Bullish fires while
       main sits above the signal and both the main series and the signed gap
       (main - signal) are holding or widening; bearish is the exact mirror.
       Vortex and ADX are special-cased below with their own custom functions.
       All evaluated with the STRONG-TREND default settings of each pane on the
       strategy's candle chart through the cached alignedSeries path - O(1) at
       the decision bar. */
    if (f.bullish || f.bearish) {
      PBG_LIST.forEach(d => {
        const vk = d.v || 'v0', ck = d.c || 'v1';
        const pair = d.pair || '';
        if (d.id === 'vortex') {
          /* Vortex exception - the generic main-vs-signal PBG gate only asks
             "main not falling + gap not shrinking", but the Vortex pair (VI+ and
             VI-) is a competing-direction duo whose trend signal must show BOTH
             lines committed to the trend. Replaced with the user-specified
             function (still level-hold / "Meet" semantics - no fresh cross
             required, it stays active on every bar while the relationship
             holds): v0 = VI+ (positive directional movement) and v1 = VI-
             (negative directional movement).
               bull: VI+ sits ABOVE VI- (already crossed, holds) AND VI+ is
                     rising AND VI- is falling AND the (signed) gap is widening
                     (implied by the two slopes - kept for clarity).
               bear: exact mirror - VI- sits above VI+, VI+ falls, VI- rises. */
          if (f.bullish && f.bullPbgVortex) {
            out.push(cond({ indId: 'vortex', indSettings: d.s, valueKey: 'v0', logic: 'gt', cmpType: 'indicator', cmpIndId: 'vortex', cmpSettings: d.s, cmpValueKey: 'v1' }));
            out.push(cond({ indId: 'vortex', indSettings: d.s, valueKey: 'v0', logic: 'incUp', cmpType: 'number' }));
            out.push(cond({ indId: 'vortex', indSettings: d.s, valueKey: 'v1', logic: 'incDown', cmpType: 'number' }));
          }
          if (f.bearish && f.bearPbgVortex) {
            out.push(cond({ indId: 'vortex', indSettings: d.s, valueKey: 'v0', logic: 'lt', cmpType: 'indicator', cmpIndId: 'vortex', cmpSettings: d.s, cmpValueKey: 'v1' }));
            out.push(cond({ indId: 'vortex', indSettings: d.s, valueKey: 'v0', logic: 'incDown', cmpType: 'number' }));
            out.push(cond({ indId: 'vortex', indSettings: d.s, valueKey: 'v1', logic: 'incUp', cmpType: 'number' }));
          }
          return;
        }
        if (d.id === 'adx') {
          /* ADX custom function - replaces the old Group-2 "ADX line increasing"
             toggle (removed) and the generic +DI/-DI gap-hold. The ADX pane has
             three lines: the purple ADX gauge (v0), +DI (v1, green) and -DI
             (v2, red). Bullish fires while the ADX gauge is RISING, +DI holds
             ABOVE -DI ("crossed above" - level semantics, a fresh cross event is
             NOT required, it stays active on every bar while the relationship
             holds) AND the +DI/-DI gap is INCREASING (widening). Bearish is the
             exact mirror: ADX gauge falling, +DI below -DI, and the +DI/-DI gap
             still widening as -DI pulls away. Built purely from existing conds
             (incUp/incDown, crossAbove/crossBelow, gapUp) so the cached
             alignedSeries/trendAt path and the AE signal vectorizer handle it
             unchanged. */
          if (f.bullish && f.bullPbgAdx) {
            out.push(cond({ indId: 'adx', indSettings: d.s, valueKey: 'v0', logic: 'incUp', cmpType: 'number' }));
            out.push(cond({ indId: 'adx', indSettings: d.s, valueKey: 'v1', logic: 'crossAbove', cmpType: 'self', cmpValueKey: 'v2' }));
            out.push(cond({ indId: 'adx', indSettings: d.s, valueKey: 'v1', logic: 'gapUp', cmpType: 'self', cmpValueKey: 'v2' }));
          }
          if (f.bearish && f.bearPbgAdx) {
            out.push(cond({ indId: 'adx', indSettings: d.s, valueKey: 'v0', logic: 'incDown', cmpType: 'number' }));
            out.push(cond({ indId: 'adx', indSettings: d.s, valueKey: 'v1', logic: 'crossBelow', cmpType: 'self', cmpValueKey: 'v2' }));
            out.push(cond({ indId: 'adx', indSettings: d.s, valueKey: 'v1', logic: 'gapUp', cmpType: 'self', cmpValueKey: 'v2' }));
          }
          return;
        }
        if (f.bullish && f['bullPbg' + pbCap(d.id)]) out.push(cond({ indId: d.id, indSettings: d.s, valueKey: vk, logic: 'pbgBull', cmpType: 'self', cmpValueKey: ck, pair: pair }));
        if (f.bearish && f['bearPbg' + pbCap(d.id)]) out.push(cond({ indId: d.id, indSettings: d.s, valueKey: vk, logic: 'pbgBear', cmpType: 'self', cmpValueKey: ck, pair: pair }));
      });
    }
    const entry = Array.isArray(tpl.entry) ? tpl.entry[0] : tpl.entry;
    if (!entry || !entry.indId) return out;
    const prim = { indId: entry.indId, indSettings: entry.indSettings || {}, valueKey: entry.valueKey || 'v0' };
    if (f.bullish && f.incUp) out.push(cond({ indId: prim.indId, indSettings: prim.indSettings, valueKey: prim.valueKey, logic: 'incUp', cmpType: 'number' }));
    if (f.bearish && f.incDown) out.push(cond({ indId: prim.indId, indSettings: prim.indSettings, valueKey: prim.valueKey, logic: 'incDown', cmpType: 'number' }));
    if (f.bullish && f.incUpAll) {
      templateIndicators(tpl).forEach(s => out.push(cond({ indId: s.indId, indSettings: s.indSettings, valueKey: s.valueKey, logic: 'incUp', cmpType: 'number' })));
    }
    if (f.bearish && f.incDownAll) {
      templateIndicators(tpl).forEach(s => out.push(cond({ indId: s.indId, indSettings: s.indSettings, valueKey: s.valueKey, logic: 'incDown', cmpType: 'number' })));
    }
    if (f.bullish && f.gapUp) {
      out.push(cond({ indId: prim.indId, indSettings: prim.indSettings, valueKey: prim.valueKey, logic: 'gapUp', cmpType: 'candle', candleKey: 'close' }));
      const twin = twinFor(prim.indId, prim.indSettings);
      if (twin) out.push(cond({ indId: prim.indId, indSettings: prim.indSettings, valueKey: prim.valueKey, logic: 'gapUp', cmpType: 'indicator', cmpIndId: prim.indId, cmpSettings: twin, cmpValueKey: 'v0' }));
    }
    if (f.bearish && f.gapDown) {
      out.push(cond({ indId: prim.indId, indSettings: prim.indSettings, valueKey: prim.valueKey, logic: 'gapDown', cmpType: 'candle', candleKey: 'close' }));
      const twin = twinFor(prim.indId, prim.indSettings);
      if (twin) out.push(cond({ indId: prim.indId, indSettings: prim.indSettings, valueKey: prim.valueKey, logic: 'gapDown', cmpType: 'indicator', cmpIndId: prim.indId, cmpSettings: twin, cmpValueKey: 'v0' }));
    }
    if (f.gtUp || f.gtDown) out.push(cond({ indId: prim.indId, indSettings: prim.indSettings, valueKey: prim.valueKey, logic: 'gt', cmpType: 'candle', candleKey: 'close' }));
    if (f.ltUp || f.ltDown) out.push(cond({ indId: prim.indId, indSettings: prim.indSettings, valueKey: prim.valueKey, logic: 'lt', cmpType: 'candle', candleKey: 'close' }));
    const twin = twinFor(prim.indId, prim.indSettings);
    if (twin) {
      if (f.bullish && f.crossUp) out.push(cond({ indId: prim.indId, indSettings: prim.indSettings, valueKey: prim.valueKey, logic: 'crossAbove', cmpType: 'indicator', cmpIndId: prim.indId, cmpSettings: twin, cmpValueKey: 'v0' }));
      if (f.bearish && f.crossDown) out.push(cond({ indId: prim.indId, indSettings: prim.indSettings, valueKey: prim.valueKey, logic: 'crossBelow', cmpType: 'indicator', cmpIndId: prim.indId, cmpSettings: twin, cmpValueKey: 'v0' }));
      if (f.bullMeetCross) out.push(cond({ indId: prim.indId, indSettings: prim.indSettings, valueKey: prim.valueKey, logic: 'crossAbove', cmpType: 'indicator', cmpIndId: prim.indId, cmpSettings: twin, cmpValueKey: 'v0' }));
      if (f.bearMeetCross) out.push(cond({ indId: prim.indId, indSettings: prim.indSettings, valueKey: prim.valueKey, logic: 'crossBelow', cmpType: 'indicator', cmpIndId: prim.indId, cmpSettings: twin, cmpValueKey: 'v0' }));
    }
    return out;
  }

  /* Strategy-owned settings (the "signal layer"): whatever the strategy itself
     carries wins over the AST universal controls, so an imported strategy keeps
     behaving exactly as designed. AST's matching global controls are faded out
     in the UI while every running strategy drives that setting. */
  function strategyOwnTf(s) {
    if (!s || !s.tf) return '';
    return (ALL_TIMEFRAMES.indexOf(s.tf) >= 0) ? s.tf : '';
  }
  function strategyOwnSl(s) {
    if (!s) return null;
    if (s.refSlPct != null && Number(s.refSlPct) > 0) return Number(s.refSlPct);
    if (s.autoSlPct != null && Number(s.autoSlPct) > 0) return Number(s.autoSlPct);
    return null;
  }
  function strategyOwnTrailSl(s) {
    if (!s || s.refTrailSlPct == null) return null;
    return Number(s.refTrailSlPct) > 0 ? Number(s.refTrailSlPct) : null;
  }
  function strategyOwnFilters(s) {
    return !!((s && s.entryExtra && s.entryExtra.length));
  }
  /* Margin budget for an AE-created (imported) strategy. AE-origin strategies
     carry the Auto Experiment margin they were created under (marginCap) and
     run on THAT budget - never on the AI Smart / manual wallet margin - so
     every engine's trades stay inside the margin set in its own tab. Returns
     0 when the strategy has no AE cap (a normal AI Smart strategy): those run
     on the AST universal Margin input. */
  function strategyMarginCap(s) {
    if (!s) return 0;
    const v = (s.marginCap != null) ? Number(s.marginCap) : 0;
    return (isFinite(v) && v > 0) ? v : 0;
  }
  function strategyOverrideStatus() {
    const list = activeStrategies();
    if (!list.length) return { tf: false, sl: false, trailSl: false, filters: false };
    const all = pred => list.every(s => pred(s));
    const useAstOwn = (state.universal && state.universal.astUseOwnSettings === true);
    return {
      tf: !useAstOwn && all(s => !!strategyOwnTf(s)),
      sl: !useAstOwn && all(s => strategyOwnSl(s) != null),
      trailSl: !useAstOwn && all(s => strategyOwnTrailSl(s) != null),
      filters: all(s => strategyOwnFilters(s))
    };
  }

  /* Global "Run Strategy In" override config for the Selected Strategies
     section: { enabled, side, auto }. Applies to every selected strategy. */
  function runStrategyInConfig() {
    const rs = state.runStrategyIn || {};
    return {
      enabled: !!rs.enabled,
      side: rs.side === 'PE' ? 'PE' : 'CE',
      auto: !!rs.auto
    };
  }

  /* Auto-select CE/PE for the "Run Strategy In" override:
     - NIFTY trend following enabled -> NIFTY trend decides: bullish = CE for
       all symbols, bearish = PE (matches the "bearish stocks picked" set).
     - Otherwise classify the ACTUAL universe the engine is trading (top
       gainers/losers, an open chart symbol, or imported AE strategies) by its
       live daily change%: all losers -> PE, all gainers -> CE. When BOTH sides
       are present a specific strategy's own category breaks the tie
       (bearish -> PE, else CE); for the global control (no single strategy)
       the dominant universe side wins first (more losers -> PE, more
       gainers -> CE) and an exact tie falls back to the ticked strategies'
       categories (any bearish -> PE). This works for any universe source, so
       Auto Select Mode reflects the top gainers / top losers instead of always
       defaulting to CE.
     - No live change% at all -> null (caller falls back to the manual side). */
  function autoRunInSide(s) {
    const nt = state.niftyTrend || {};
    if (nt.enabled) {
      if (_lastNiftyDir === 'bearish') return 'PE';
      if (_lastNiftyDir === 'bullish') return 'CE';
      /* Trend direction not available yet - fall through to the universe
         classification so auto mode still has a signal to work with. */
    }
    let gainers = 0, losers = 0;
    for (const sym of experimentSymbols()) {
      if (isSimSymbol(sym) || isCommodity(sym)) continue;
      const q = quoteFor(sym);
      const pct = (q && q.change_pct !== undefined) ? Number(q.change_pct) : NaN;
      if (isNaN(pct)) continue;
      if (pct < 0) losers++; else gainers++;
    }
    if (gainers || losers) {
      if (losers && !gainers) return 'PE';
      if (gainers && !losers) return 'CE';
      if (s && s.cat) return s.cat === 'bearish' ? 'PE' : 'CE';
      if (losers > gainers) return 'PE';
      if (gainers > losers) return 'CE';
      const list = activeStrategies();
      return list.some(x => x.cat === 'bearish') ? 'PE' : 'CE';
    }
    return null;
  }

  /* Effective side the Selected Strategies run in once the override is enabled:
     the manual side, or the auto-computed side when Auto Select Mode is on
     (falling back to the manual side while no auto signal is available). */
  function effectiveRunInSide(s, rs) {
    if (!rs) return null;
    const side = rs.auto ? (autoRunInSide(s) || rs.side) : rs.side;
    return side === 'PE' ? 'PE' : 'CE';
  }

  /* The option side the poll's resolveInstruments() FORCES on every universe
     symbol via the "Run Strategy In" override (Selected Strategies section): CE
     or PE when that override is on, else null (the per-symbol dir-chain leg pick
     in contractsFor() then applies). The picked-strike reconciler and the HFT
     scanner must judge stale legs against this SAME side - when the override is
     active and the chosen auto side (e.g. PE from a bearish NIFTY) disagrees
     with the ticked indicator-filter direction, resolving against the filter
     side makes them delete the very records the poll re-creates every tick
     (permanent "removed N stale pick(s)" churn). */
  function runInForcedSide() {
    const rsiCfg = runStrategyInConfig();
    if (!rsiCfg.enabled) return null;
    const eff = effectiveRunInSide(null, rsiCfg);
    return (eff === 'CE' || eff === 'PE') ? eff : null;
  }

  /* Working copy of a saved strategy with the enabled filters appended to its
     entryExtra (cached per filters signature so re-evaluation is cheap). The
     global AST Bullish/Bearish filters are only appended when their direction
     matches the strategy's own category - a bullish strategy never receives
     bearish filter gates and vice versa, so the appended filters can only
     reinforce the strategy's direction instead of suppressing it. */
  const _workingCache = new Map();
  function workingStrategy(s) {
    const fsig = JSON.stringify(state.filters || {});
    const c = _workingCache.get(s.id);
    if (c && c.sig === fsig) return c.s;
    const copy = JSON.parse(JSON.stringify(s));
    /* Indicator-filters-mode synthetic strategies already carry the selected
       filter conditions as their entry conditions - do not append them again. */
    if (copy._filterBuilt) { _workingCache.set(s.id, { sig: fsig, s: copy }); return copy; }
    const side = (s.cat === 'bearish') ? 'bearish' : 'bullish';
    const f = JSON.parse(JSON.stringify(state.filters || {}));
    /* Zero the opposite-direction filter section so only matching-side
       conditions can be built (no cross-direction double gating). */
    if (side === 'bullish') {
      f.bearish = false;
      BEAR_FILTER_KEYS.forEach(k => delete f[k]);
    } else {
      f.bullish = false;
      BULL_FILTER_KEYS.forEach(k => delete f[k]);
    }
    const fc = buildFilterConditions(copy, f);
    if (fc.length) {
      copy.entryExtra = (copy.entryExtra || []).concat(fc);
      /* Appended direction-matched filters are mandatory confirmations on top of
         the strategy's own conditions: raise the pass-count to the sum so the
         N-of-M semantics of the strategy itself is preserved exactly (the
         threshold-distortion fix). */
      const ownNeed = (copy.entryThreshold != null && copy.entryThreshold >= 1)
        ? copy.entryThreshold
        : (copy.entryExtra.length - fc.length);
      copy.entryThreshold = ownNeed + fc.length;
    }
    _workingCache.set(s.id, { sig: fsig, s: copy });
    if (_workingCache.size > 500) _workingCache.clear();
    return copy;
  }

  /* Direction-matched filter conditions for a strategy template: only the
     filters whose direction matches the strategy's category are built, so the
     appended conditions can only reinforce the strategy's direction. Shared by
     the AST strict mode and the Auto Experiment engine's "all together" entry. */
  function directionFilterConditions(tpl) {
    const side = (tpl && tpl.cat === 'bearish') ? 'bearish' : 'bullish';
    const f = JSON.parse(JSON.stringify(state.filters || {}));
    if (side === 'bullish') {
      f.bearish = false;
      BEAR_FILTER_KEYS.forEach(k => delete f[k]);
    } else {
      f.bullish = false;
      BULL_FILTER_KEYS.forEach(k => delete f[k]);
    }
    return buildFilterConditions(tpl, f);
  }

  /* Strict all-together entry for any strategy template (AST strategy or AE
     result): the strategy's own conditions + all direction-matched filters must
     pass together on bar `i`. Used by the Auto Experiment engine when its
     "all together" checkbox is ON. */
  function strictEntryOkAt(tpl, candles, i) {
    if (!tpl) return false;
    const copy = JSON.parse(JSON.stringify(tpl));
    const extra = (copy.entryExtra || []).slice();
    const fc = directionFilterConditions(copy);
    if (fc.length) extra.push.apply(extra, fc);
    copy.entryExtra = extra;
    return entryFireAllInOne(copy, candles, i);
  }

  /* Which directional indicator filter (if any) is active for strike pick and
     trade placement: 'bullish' when the Bullish section master + any sub-option
     is on, 'bearish' for the Bearish section, or null. When a bullish filter is
     selected trades are placed BUY on CE calls only; when a bearish filter is
     selected trades are placed BUY on PE puts only. */
  function hasStreamFlags(f, side) {
    return STREAM_FLAG_KEYS.some(k => f[k] && k.indexOf(side) === 0);
  }

  function activeFilterDirection() {
    const f = state.filters || {};
    const bull = f.bullish && (f.incUp || f.crossUp || f.gapUp || f.incUpAll || f.gtUp || f.ltUp || f.bullVolUp || f.bullVolDown || f.bullFakeBreakout || f.bullReversal || f.paneCrossUp || f.paneIncUpAll || f.bullBbwInc || f.bullBbCrossBelow || f.bullBbCrossAbove || f.bullPcCrossBelow || f.bullPcCrossAbove || f.bullSmf || f.bullVl || f.bullAsr || f.bullOit || f.bullEma9_21 || f.bullEma21_35 || f.bullEma35_50 || f.bullEma50_100 || f.bullEma100_200 || f.bullEma200_300 || f.bullSt10_1_2 || f.bullSt10_2_3 || f.bullSt1CloseCrossAbove || f.bullVwapCloseCrossAbove || f.bullMeetEma9_21 || f.bullMeetEma21_35 || f.bullMeetEma35_50 || f.bullMeetEma50_100 || f.bullMeetEma100_200 || f.bullMeetEma200_300 || f.bullMeetSt10_1_2 || f.bullMeetSt10_2_3 || f.bullMeetCloseSt || f.bullMeetCloseVwap || f.bullMeetPaneCross || f.bullMeetCross || f.bullMeetCloseBb || f.bullMeetClosePc || f.bullMeetVl || f.bullGreenCandle || hasStreamFlags(f, 'bull') || pbrOn(f, 'bull'));
    const bear = f.bearish && (f.incDown || f.crossDown || f.gapDown || f.incDownAll || f.gtDown || f.ltDown || f.bearVolUp || f.bearVolDown || f.bearFakeBreakout || f.bearReversal || f.paneCrossDown || f.paneIncDownAll || f.bearBbwInc || f.bearBbCrossBelow || f.bearBbCrossAbove || f.bearPcCrossBelow || f.bearPcCrossAbove || f.bearSmf || f.bearVl || f.bearAsr || f.bearOit || f.bearEma9_21 || f.bearEma21_35 || f.bearEma35_50 || f.bearEma50_100 || f.bearEma100_200 || f.bearEma200_300 || f.bearSt10_1_2 || f.bearSt10_2_3 || f.bearSt1CloseCrossBelow || f.bearVwapCloseCrossBelow || f.bearMeetEma9_21 || f.bearMeetEma21_35 || f.bearMeetEma35_50 || f.bearMeetEma50_100 || f.bearMeetEma100_200 || f.bearMeetEma200_300 || f.bearMeetSt10_1_2 || f.bearMeetSt10_2_3 || f.bearMeetCloseSt || f.bearMeetCloseVwap || f.bearMeetPaneCross || f.bearMeetCross || f.bearMeetCloseBb || f.bearMeetClosePc || f.bearMeetVl || f.bearRedCandle || hasStreamFlags(f, 'bear') || pbrOn(f, 'bear'));
    if (bull && !bear) return 'bullish';
    if (bear && !bull) return 'bearish';
    return null;
  }

  /* Direction of the currently running strategies. When every running strategy
     shares the same category the leg is pinned to that side (bullish -> CE,
     bearish -> PE); when strategies disagree or none runs, returns null so the
     existing movers/filters/trend direction logic decides the leg. */
  function strategyDirectionFor() {
    const list = activeStrategies();
    if (!list.length) return null;
    const cats = list.map(s => s.cat === 'bearish' ? 'bearish' : 'bullish');
    const first = cats[0];
    return cats.every(c => c === first) ? first : null;
  }

  /* Research-stream scoping inside the Bullish/Bearish filter sections: when a
     stream checkbox is ticked, only strategies whose research group is in the
     ticked list for that side are picked/traded. Returns null when no stream
     checkbox is ticked in either section, otherwise
     { bullish: [group...], bearish: [group...] }. */
  function activeFilterGroups() {
    const f = state.filters || {};
    const bull = [];
    const bear = [];
    STREAM_FLAG_KEYS.forEach(k => {
      if (!f[k]) return;
      (k.indexOf('bull') === 0 ? bull : bear).push(STREAM_FLAG_GROUPS[k]);
    });
    if (!bull.length && !bear.length) return null;
    return { bullish: bull, bearish: bear };
  }

  function applyLogicAt(logic, last, prev, cmpLast, cmpPrev) {
    if (last == null || cmpLast == null) return false;
    switch (logic) {
      case 'gt': return last > cmpLast;
      case 'lt': return last < cmpLast;
      case 'gte': return last >= cmpLast;
      case 'lte': return last <= cmpLast;
      case 'eq': return Math.abs(last - cmpLast) < 1e-9;
      case 'neq': return Math.abs(last - cmpLast) >= 1e-9;
      case 'crossAbove':
        /* State-based cross: true whenever the current level holds, so a
           strategy already above the band fires immediately instead of waiting
           for a fresh flip on this bar. */
        return last > cmpLast;
      case 'crossBelow':
        return last < cmpLast;
      case 'crossUpNow':
        /* True cross detection: the primary must be above the comparator on
           this bar AND at/below it on the previous bar. Requires both previous
           values so the very first bars can never fire a phantom cross. */
        if (prev == null || cmpPrev == null) return false;
        return last > cmpLast && prev <= cmpPrev;
      case 'crossDownNow':
        if (prev == null || cmpPrev == null) return false;
        return last < cmpLast && prev >= cmpPrev;
      default: return false;
    }
  }

  function evalCondAt(cond, i, candles) {
    if (!cond) return false;
    if (cond.cmpType === 'candlestick_pattern' || cond.cmpType === 'pattern') {
      return patternHitAt(cond.candlePatterns, i, candles);
    }
    if (cond.logic === 'volUp' || cond.logic === 'volDown') {
      const vs = volumeSeries(candles);
      /* No-volume-data rule: the volume-trend gate needs real traded volume to
         say anything. When the recent window has NO volume at all (volume field
         missing / all-zero - illiquid option contracts, or live tick-built
         candles whose quote stream carries no cumulative volume) the gate cannot
         be evaluated. Treat that as PASS (unable to verify) instead of FAIL, so
         a missing volume feed can never silently block EVERY strict-AND
         indicator-filter trade the way "FAIL ? volUp [--]" did. Only a window
         that actually contains volume is tested for its rising/falling trend. */
      let hasVol = false;
      const j0 = Math.max(0, i - 6);
      for (let j = j0; j <= i; j++) {
        const v = vs[j];
        if (v != null && !isNaN(v) && v > 0) { hasVol = true; break; }
      }
      if (!hasVol) return true;
      return trendAt(vs, i, cond.logic === 'volUp' ? 'up' : 'down');
    }
    /* Auto Support Resistance gap gates: bullish fires when the gap between the
       candle close and the SUPPORT line keeps widening (price rising away from
       support); bearish fires when the gap between the RESISTANCE line and the
       candle close keeps widening (price falling away below resistance). Both
       read the cached per-bar gap series and test for a widening trend. */
    if (cond.logic === 'asrSupGapUp' || cond.logic === 'asrResGapUp') {
      const gap = autoSRGapSeries(cond.indSettings, candles, cond.logic === 'asrSupGapUp' ? 'sup' : 'res');
      /* The gap must be positive (price on the correct side of the line: above
         support for a bullish signal, below resistance for a bearish one) AND
         widening, otherwise a cross below support / above resistance would be
         misread as a valid trend signal. */
      if (gap[i] == null || gap[i] <= 0) return false;
      return trendAt(gap, i, 'up');
    }
    if (cond.logic === 'fakeBreakout') {
      return fakeBreakoutAt(candles, i, cond.dir === -1 ? 'bearish' : 'bullish');
    }
    if (cond.logic === 'reversal') {
      return reversalAt(candles, i, cond.dir === -1 ? 'bearish' : 'bullish');
    }
    /* Candle-color gate: the decision-bar candle must be green (close > open)
       for a bullish entry, red (close < open) for a bearish entry. Straight
       candle-shape check with no indicator needed. */
    if (cond.logic === 'greenCandle' || cond.logic === 'redCandle') {
      const bar = candles[i];
      if (!bar || bar.open == null || bar.close == null) return false;
      return cond.logic === 'greenCandle' ? bar.close > bar.open : bar.close < bar.open;
    }
    if (cond.logic === 'closeCrossAbove' || cond.logic === 'closeCrossBelow') {
      const bar = candles[i];
      const band = readTwo(cond.indId, cond.indSettings, cond.valueKey || 'v1', i, candles).last;
      if (!bar || band == null) return false;
      const crossed = cond.logic === 'closeCrossAbove' ? bar.close > band : bar.close < band;
      if (!crossed) return false;
      if (cond.expand && cond.indId === 'bb') {
        const gap = bbGapSeries(cond.indSettings, candles);
        if (!trendAt(gap, i, 'up')) return false;
      }
      return true;
    }
    if (!cond.indId) return false;
    if (cond.logic === 'incUp' || cond.logic === 'incDown') {
      const arr = alignedSeries(cond.indId, cond.indSettings, cond.valueKey, candles);
      return trendAt(arr, i, cond.logic === 'incUp' ? 'up' : 'down');
    }
    /* Multi-Line Momentum Gap (PBG) meet-level gates. Bull fires while the main
       series sits ABOVE the signal and is NOT falling and the signed gap
       (main - signal) is NOT shrinking; bear is the exact mirror. Pure level-
       hold semantics: a fresh cross event is NOT required and a pinned steady
       gap stays active for the whole trend (e.g. Aroon Up holding above Aroon
       Down with both lines pinned flat). O(1): only the two last cached bars of
       each series are read. */
    if (cond.logic === 'pbgBull' || cond.logic === 'pbgBear') {
      const wantBull = cond.logic === 'pbgBull';
      const m = alignedSeries(cond.indId, cond.indSettings, cond.valueKey, candles);
      const s = alignedSeries(cond.indId, cond.indSettings, cond.cmpValueKey, candles);
      if (!m || !s) return false;
      const v = m[i], s0 = s[i], vp = m[i - 1], s1 = s[i - 1];
      if (v == null || s0 == null || vp == null || s1 == null) return false;
      if (cond.pair) {
        /* SMI special "pair vs Histogram" mode: the SMI filter was redesigned
           as an OR of the two bullish variants the user described (bearish is
           the exact mirror). base = SMI & Signal both on the bullish side of
           the Histogram line (hist = SMI - Signal, so this pins the oscillator
           pair in its positive zone); variant-1 = base + both lines rising and
           pulling further away from the histogram; variant-2 = base + both
           lines rising and the histogram itself rising (acceleration). A bar
           passes when either variant holds. */
        const h = alignedSeries(cond.indId, cond.indSettings, cond.pair, candles);
        if (!h) return false;
        const hh = h[i], hp = h[i - 1];
        if (hh == null || hp == null) return false;
        if (wantBull) {
          if (v <= hh || s0 <= hh) return false;
          if (v < vp || s0 < s1) return false;
          const widen = (v - hh) >= (vp - hp) && (s0 - hh) >= (s1 - hp);
          if (!widen && !(hh >= hp)) return false;
        } else {
          if (v >= hh || s0 >= hh) return false;
          if (v > vp || s0 > s1) return false;
          const widen = (hh - v) >= (hp - vp) && (hh - s0) >= (hp - s1);
          if (!widen && !(hh <= hp)) return false;
        }
        return true;
      }
      const gap = v - s0, pg = vp - s1;
      if (wantBull) {
        if (gap <= 0) return false;
        if (v < vp) return false;
        if (gap < pg) return false;
      } else {
        if (gap >= 0) return false;
        if (v > vp) return false;
        if (gap > pg) return false;
      }
      return true;
    }
    const prim = readTwo(cond.indId, cond.indSettings, cond.valueKey, i, candles);
    const cmp = cmpReadAt(cond, i, candles);
    if (cond.logic === 'gapUp' || cond.logic === 'gapDown') {
      if (prim.last == null || prim.prev == null || cmp.last == null || cmp.prev == null) return false;
      const gap = Math.abs(prim.last - cmp.last);
      const prevGap = Math.abs(prim.prev - cmp.prev);
      return cond.logic === 'gapUp' ? gap > prevGap : gap < prevGap;
    }
    return applyLogicAt(cond.logic, prim.last, prim.prev, cmp.last, cmp.prev);
  }

  function evalCondAll(cond, i, candles) {
    if (Array.isArray(cond)) {
      for (const c of cond) if (!evalCondAt(c, i, candles)) return false;
      return cond.length > 0;
    }
    return evalCondAt(cond, i, candles);
  }

  function evalCondAny(cond, i, candles) {
    if (Array.isArray(cond)) {
      for (const c of cond) if (evalCondAt(c, i, candles)) return true;
      return false;
    }
    return evalCondAt(cond, i, candles);
  }

  function evalCondNof(conds, need, i, candles) {
    if (!conds || !conds.length) return need <= 0;
    const k = Math.max(1, Math.min(need, conds.length));
    let hit = 0;
    for (const c of conds) { if (evalCondAt(c, i, candles) && ++hit >= k) break; }
    return hit >= k;
  }

  /* Hunting-aware auto stop-loss (mirror of AE's autoSLPct). */
  function autoSLPct(candles) {
    const n = candles.length;
    if (n < 5) return 1;
    const length = Math.min(14, n - 1);
    let trSum = 0, prevClose = candles[0].close, cnt = 0;
    for (let i = 1; i <= length && i < n; i++) {
      const c = candles[i];
      const tr = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
      trSum += tr; cnt++;
      prevClose = c.close;
    }
    const atr = cnt ? trSum / cnt : 0;
    const close = candles[n - 1].close;
    if (!close || !atr) return 1;
    let pct = atr / close * 100 * 1.6;
    pct = Math.min(Math.max(pct, 0.3), 3);
    return Math.round(pct * 100) / 100;
  }

  /* Fixed take-profit % (off entry), AI-decided: volatility-scaled target that
     estimates how far (in %) the instrument can reasonably run beyond entry.
     A few ATRs of room, clamped to a sane band. */
  function aiTPPct(candles) {
    const n = candles.length;
    if (n < 5) return 5;
    const length = Math.min(20, n - 1);
    let trSum = 0, prevClose = candles[0].close, cnt = 0;
    for (let i = 1; i <= length && i < n; i++) {
      const c = candles[i];
      const tr = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
      trSum += tr; cnt++;
      prevClose = c.close;
    }
    const atr = cnt ? trSum / cnt : 0;
    const close = candles[n - 1].close;
    if (!close || !atr) return 5;
    let pct = atr / close * 100 * 2.5;
    pct = Math.min(Math.max(pct, 0.5), 10);
    return Math.round(pct * 100) / 100;
  }

  /* ---------------- state ---------------- */
  function defaultState() {
    return {
      enabled: false,
      universal: { lotSize: null, lots: 1, margin: 100000, tpPct: 1, manualTrail: true, aiSl: true, aiTp: true, manualSL: false, manualSLPct: 1, manualTrailTP: false, manualTrailTPPct: 20, manualTP: false, manualTPPct: 5, aiTP: false, rrEnabled: false, rrValue: 2, mtfConfirm: false, fnoLimit: true, tfs: { '1min': true, '5min': true }, tradeLimitEnabled: false, tradeLimitCount: 5, aiTrades: false, hft: false, hftOps: 6, hftExecEnabled: true, hftExecOn: 'close', startTradeAfterEnabled: false, startTradeAfter: '09:15', noTradeAfterEnabled: false, noTradeAfter: '15:30', autoSquareOffEnabled: false, autoSquareOffTime: '15:20', astUseOwnSettings: false },
      runProgress: {},     // strategyId -> { pct, status, updated } live per-tick pipeline progress
      strike: { mode: 'both_atm', count: 3, optionType: 'both', positiveOnly: true, fastestRising: false, fastestCount: 3 },
      runIn: { index: 'both', fno: 'spot', comm: 'spot', default: false }, // chart the strategy run + trade execution runs on: 'spot', 'premium' or 'both'
      tradeIn: { index: 'premium', fno: 'premium', comm: 'spot', default: false }, // chart the trade execution is done on: 'spot' or 'premium'
      premiumOnly: false, // when ON the strategy run AND trade execution both lock to the option premium chart for every instrument type
      groups: GROUP_KEYS.slice(),
      symbols: [],
      movers: { enabled: false, gainers: 5, losers: 5, indices: [], picked: [] },
      niftyTrend: { enabled: false, pct: 2.5, includeIndices: false, indices: [] }, // NIFTY trend-following F&O picker (directional gainers/losers above a daily change% threshold + optional indices)
      sim: { enabled: false }, // market-off simulation chart: trades the synthetic SIM 900001 stream instead of real strikes
      commodity: { enabled: false, sids: [] }, // MCX commodity futures paper trading: trades each +Add-ed FUTCOM contract directly (spot mode), alongside stocks/F&O
      showPickedStrikes: false,
      filters: { bullish: false, bearish: false, incUp: false, incDown: false, gapUp: false, gapDown: false, incUpAll: false, incDownAll: false, crossUp: false, crossDown: false, gtUp: false, ltUp: false, gtDown: false, ltDown: false, paneCrossUp: false, paneCrossDown: false, paneIncUpAll: false, paneIncDownAll: false, bullVolUp: false, bullVolDown: false, bullFakeBreakout: false, bullReversal: false, bullGreenCandle: false, bearRedCandle: false, bearVolUp: false, bearVolDown: false, bearFakeBreakout: false, bearReversal: false, bullBbwInc: false, bearBbwInc: false, bullBbCrossBelow: false, bullBbCrossAbove: false, bullPcCrossBelow: false, bullPcCrossAbove: false, bearBbCrossBelow: false, bearBbCrossAbove: false, bearPcCrossBelow: false, bearPcCrossAbove: false, bullSmf: false, bearSmf: false, bullVl: false, bearVl: false, bullAsr: false, bearAsr: false, bullOit: false, bearOit: false, bullEma9_21: false, bearEma9_21: false, bullEma21_35: false, bearEma21_35: false, bullEma35_50: false, bearEma35_50: false, bullEma50_100: false, bearEma50_100: false, bullEma100_200: false, bearEma100_200: false, bullEma200_300: false, bearEma200_300: false, bullSt10_1_2: false, bearSt10_1_2: false, bullSt10_2_3: false, bearSt10_2_3: false, bullSt1CloseCrossAbove: false, bearSt1CloseCrossBelow: false, bullVwapCloseCrossAbove: false, bullMeetEma9_21: false, bullMeetEma21_35: false, bullMeetEma35_50: false, bullMeetEma50_100: false, bullMeetEma100_200: false, bullMeetEma200_300: false, bullMeetSt10_1_2: false, bullMeetSt10_2_3: false, bullMeetCloseSt: false, bullMeetCloseVwap: false, bullMeetPaneCross: false, bullMeetCross: false, bullMeetCloseBb: false, bullMeetClosePc: false, bullMeetVl: false, bearMeetVl: false, bearVwapCloseCrossBelow: false, bearMeetEma9_21: false, bearMeetEma21_35: false, bearMeetEma35_50: false, bearMeetEma50_100: false, bearMeetEma100_200: false, bearMeetEma200_300: false, bearMeetSt10_1_2: false, bearMeetSt10_2_3: false, bearMeetCloseSt: false, bearMeetCloseVwap: false, bearMeetPaneCross: false, bearMeetCross: false, bearMeetCloseBb: false, bearMeetClosePc: false, bullCandle: false, bullElliott: false, bullIndicator: false, bullPane: false, bullSymmetry: false, bullStructure: false, bullAtr: false, bearCandle: false, bearElliott: false, bearIndicator: false, bearPane: false, bearSymmetry: false, bearStructure: false, bearAtr: false },
      /* All-indicators-together entry mode: when ON the strategy's entry fires
         only when the strategy's own conditions AND every selected indicator
         filter pass together on the same bar (strict AND - no N-of-M). When OFF
         the old default (threshold-based N-of-M) applies. */
      allInOne: false,
      /* Indicator-filters run mode: when ON the engine trades the selected
         universe (top movers / NIFTY trend / chart symbols) placing a trade
         only when ALL selected Bullish/Bearish indicator filters pass together
         on the symbol/instrument chart (strict AND) - no saved strategy needed.
         Mutually exclusive with the normal "Run Paper Trading" mode (checked
         via the checkbox next to the run buttons). */
      filterMode: false,
      /* Explicit run intent captured when the user presses Run Paper Trading /
         Indicator-filters Run (or toggles Auto ON): { active, mode ('normal' |
         'filter'), at }. Persisted so a page reload can re-arm the exact run
         mode automatically - emulating the button press - without depending on
         the enabled flag alone. */
      runIntent: { active: false, mode: 'normal', at: 0 },
      selected: {},
      imported: [],
      manual: [],
      aiPicks: [],
      /* Global "Run Strategy In" override for the Selected Strategies section:
         { enabled, side ('CE'|'PE'), auto }. When enabled EVERY selected
         strategy runs on the option premium chart of only that side for every
         symbol in the selected universe. auto = Auto Select Mode (side picked
         from the NIFTY trend-following direction or top gainers/losers). */
      runStrategyIn: { enabled: false, side: 'CE', auto: false },
      callManual: true,
      aiPick: false,
      aiPickN: 5,
      aiPickBull: true,
      aiPickBear: true,
      positions: {},
      closed: [],
      /* Running realized-P&L totals. Incremented at every close (never
         recomputed from the closed list) so the Smart Realized P&L / Charges /
         Trades / Win-Rate stay exact even if the closed list is ever trimmed
         for storage, and never silently shrink as old trades age out. */
      rpnl: { realized: 0, charges: 0, count: 0, wins: 0 },
      tradeCounts: {},
      tradeCountDay: '',
      /* Per-strategy engine-settings snapshots captured at import / entry time
         (strategyId -> { capturedAt, settings }). The Final Strategy section
         reads these to show the exact SL / Trail SL / TP / AI settings that
         were applied while a strategy was running. */
      settingsSnapshots: {},
      dataPool: false, // Live Data Pool monitor: shared realtime candle/indicator/filter readout for every resolved instrument
      fastData: false // Ultrafast live feed: strategies read in-browser live candles built from WebSocket ticks instead of the Data Pool REST path
    };
  }

  let state = load();
  /* Restore the last-known resolved chains / picked strikes so a page reload
     does not wipe them: strategies keep trading their resolved instruments and
     the Picked Strikes panel stays populated without a cold-start burst against
     Dhan's chain API. */
  _restorePickedSnapshot();

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(AST_KEY) || 'null');
      if (s) return sanitizeState(Object.assign(defaultState(), s));
    } catch (e) {}
    return defaultState();
  }

  function sanitizeState(s) {
    if (s && s.strike) {
      if (VALID_MODES.indexOf(s.strike.mode) < 0) s.strike.mode = 'both_atm';
      if (VALID_TYPES.indexOf(s.strike.optionType) < 0) s.strike.optionType = 'both';
      if (typeof s.strike.positiveOnly !== 'boolean') s.strike.positiveOnly = true;
      if (typeof s.strike.fastestRising !== 'boolean') s.strike.fastestRising = false;
      if (!Number.isFinite(s.strike.fastestCount) || s.strike.fastestCount < 1) s.strike.fastestCount = 3;
    }
    if (s && s.runIn) {
      // Both dropdowns accept 'spot' (underlying chart), 'premium' (option
      // premium chart) or 'both' (spot + premium). Indices default to 'both',
      // F&O stocks default to 'spot'. Commodities default to the futures
      // contract ('spot') but honour their own dropdown. Commodities also
      // accept 'futures' (explicit futures-contract chart, same underlying
      // near-month FUTCOM chart as 'spot').
      const OK = ['spot', 'premium', 'both'];
      const COMM_OK = ['spot', 'premium', 'both', 'futures'];
      if (OK.indexOf(s.runIn.index) < 0) s.runIn.index = 'both';
      if (OK.indexOf(s.runIn.fno) < 0) s.runIn.fno = 'spot';
      if (COMM_OK.indexOf(s.runIn.comm) < 0) s.runIn.comm = 'spot';
      if (typeof s.runIn.default !== 'boolean') s.runIn.default = false;
    } else if (s) {
      s.runIn = { index: 'both', fno: 'spot', comm: 'spot', default: false };
    }
    if (s && s.tradeIn) {
      // Trades always execute on the selected-strike option premium chart for
      // both indices and F&O stocks - never on the spot chart. Commodities
      // default to the futures contract ('spot') but honour their own dropdown.
      s.tradeIn.index = 'premium';
      s.tradeIn.fno = 'premium';
      if (['spot', 'premium', 'both'].indexOf(s.tradeIn.comm) < 0) s.tradeIn.comm = 'spot';
      if (typeof s.tradeIn.default !== 'boolean') s.tradeIn.default = false;
    } else if (s) {
      s.tradeIn = { index: 'premium', fno: 'premium', comm: 'spot', default: false };
    }
    if (s && typeof s.premiumOnly !== 'boolean') s.premiumOnly = false;
    if (s) {
      const ri = s.runIntent;
      if (!ri || typeof ri !== 'object') {
        s.runIntent = { active: false, mode: 'normal', at: 0 };
      } else {
        if (typeof ri.active !== 'boolean') ri.active = false;
        if (ri.mode !== 'filter' && ri.mode !== 'normal') ri.mode = 'normal';
        if (!Number.isFinite(Number(ri.at))) ri.at = 0;
      }
    }
    /* The Research-streams row was removed - streams are now scoped per-side
       through the Bullish/Bearish indicator filter sections, so the global
       group gate always stays all-on regardless of stale saved state. */
    if (s) s.groups = GROUP_KEYS.slice();
    if (s && s.universal) {
      if (typeof s.universal.manualTrail !== 'boolean') s.universal.manualTrail = true;
      if (typeof s.universal.aiSl !== 'boolean') s.universal.aiSl = true;
      if (typeof s.universal.aiTp !== 'boolean') s.universal.aiTp = true;
      if (typeof s.universal.manualSL !== 'boolean') s.universal.manualSL = false;
      if (!Number.isFinite(Number(s.universal.manualSLPct)) || Number(s.universal.manualSLPct) <= 0) s.universal.manualSLPct = 1;
      /* Manual SL % is stored and restored verbatim (raw percent): 0.05 means
         0.05%, so a saved value is never rescaled on reload. */
      if (typeof s.universal.manualTrailSL !== 'boolean') s.universal.manualTrailSL = false;
      if (!Number.isFinite(Number(s.universal.manualTrailSLPct))) s.universal.manualTrailSLPct = 0;
      else s.universal.manualTrailSLPct = Number(s.universal.manualTrailSLPct);
      /* One-time migration: a Trail SL % typed into the box while the Overall SL
         (the base floor) is engaged is treated as intent to trail. Before this,
         the % was silently ignored unless the Trail SL checkbox was separately
         ticked, so a green trade ran with no trailing stop at all and its whole
         profit (e.g. +600) gave back to zero. Only a non-default value (>1, the
         old fallback marker) triggers it so untouched configs stay untouched. */
      if (!s.universal.manualTrailSL && s.universal.manualSL === true &&
          Number(s.universal.manualTrailSLPct) > 1 && Number(s.universal.manualTrailSLPct) <= 100) {
        s.universal.manualTrailSL = true;
      }
      if (typeof s.universal.manualTrailTP !== 'boolean') s.universal.manualTrailTP = false;
      if (!Number.isFinite(Number(s.universal.manualTrailTPPct)) || Number(s.universal.manualTrailTPPct) <= 0) s.universal.manualTrailTPPct = 20;
      if (typeof s.universal.manualTP !== 'boolean') s.universal.manualTP = false;
      if (!Number.isFinite(Number(s.universal.manualTPPct)) || Number(s.universal.manualTPPct) <= 0) s.universal.manualTPPct = 5;
      if (typeof s.universal.aiTP !== 'boolean') s.universal.aiTP = false;
      if (typeof s.universal.rrEnabled !== 'boolean') s.universal.rrEnabled = false;
      if (!Number.isFinite(Number(s.universal.rrValue)) || Number(s.universal.rrValue) <= 0) s.universal.rrValue = 2;
      if (typeof s.universal.mtfConfirm !== 'boolean') s.universal.mtfConfirm = false;
      if (typeof s.universal.fnoLimit !== 'boolean') s.universal.fnoLimit = true;
      if (typeof s.universal.astUseOwnSettings !== 'boolean') s.universal.astUseOwnSettings = false;
      if (typeof s.dataPool !== 'boolean') s.dataPool = false;
      if (typeof s.fastData !== 'boolean') s.fastData = false;
      if (!s.universal.tfs || typeof s.universal.tfs !== 'object') s.universal.tfs = { '1min': true, '5min': true };
      if (typeof s.universal.tfs['1min'] !== 'boolean') s.universal.tfs['1min'] = true;
      if (typeof s.universal.tfs['5min'] !== 'boolean') s.universal.tfs['5min'] = true;
      if (typeof s.universal.tradeLimitEnabled !== 'boolean') s.universal.tradeLimitEnabled = false;
      if (!Number.isFinite(Number(s.universal.tradeLimitCount)) || Number(s.universal.tradeLimitCount) <= 0) s.universal.tradeLimitCount = 5;
      if (typeof s.universal.aiTrades !== 'boolean') s.universal.aiTrades = false;
      if (typeof s.universal.hft !== 'boolean') s.universal.hft = false;
      // Migrate legacy ms/s interval fields into the orders-per-second cap (Dhan default 6).
      if (s.universal.hftOps == null) {
        if (Number(s.universal.hftSec) > 0) s.universal.hftOps = Math.round(1000 / (Number(s.universal.hftSec) * 1000));
        else if (Number(s.universal.hftMs) > 0) s.universal.hftOps = Math.round(1000 / Number(s.universal.hftMs));
      }
      if (!Number.isFinite(Number(s.universal.hftOps)) || Number(s.universal.hftOps) < 1) s.universal.hftOps = 6;
      if (Number(s.universal.hftOps) > 30) s.universal.hftOps = 30;
      if (['open', 'high', 'low', 'close'].indexOf(s.universal.hftExecOn) < 0) s.universal.hftExecOn = 'close';
      if (typeof s.universal.hftExecEnabled !== 'boolean') s.universal.hftExecEnabled = true;
      if (typeof s.universal.startTradeAfterEnabled !== 'boolean') s.universal.startTradeAfterEnabled = false;
      if (typeof s.universal.noTradeAfterEnabled !== 'boolean') s.universal.noTradeAfterEnabled = false;
      if (typeof s.universal.autoSquareOffEnabled !== 'boolean') s.universal.autoSquareOffEnabled = false;
      if (!/^\d{2}:\d{2}$/.test(s.universal.startTradeAfter || '')) s.universal.startTradeAfter = '09:15';
      if (!/^\d{2}:\d{2}$/.test(s.universal.noTradeAfter || '')) s.universal.noTradeAfter = '15:30';
      if (!/^\d{2}:\d{2}$/.test(s.universal.autoSquareOffTime || '')) s.universal.autoSquareOffTime = '15:20';
    }
    if (s && s.movers) {
      if (typeof s.movers.enabled !== 'boolean') s.movers.enabled = false;
      s.movers.gainers = Math.max(0, Number(s.movers.gainers) || 0);
      s.movers.losers = Math.max(0, Number(s.movers.losers) || 0);
      if (!Array.isArray(s.movers.indices)) s.movers.indices = [];
      if (!Array.isArray(s.movers.picked)) s.movers.picked = [];
      delete s.movers.includeIndices;
    }
    if (s && s.niftyTrend) {
      if (typeof s.niftyTrend.enabled !== 'boolean') s.niftyTrend.enabled = false;
      if (!Number.isFinite(Number(s.niftyTrend.pct)) || Number(s.niftyTrend.pct) <= 0) s.niftyTrend.pct = 2.5;
      if (typeof s.niftyTrend.includeIndices !== 'boolean') s.niftyTrend.includeIndices = false;
      if (!Array.isArray(s.niftyTrend.indices)) s.niftyTrend.indices = [];
    } else if (s) {
      s.niftyTrend = { enabled: false, pct: 2.5, includeIndices: false, indices: [] };
    }
    if (s && s.filters) {
      ['bullish', 'bearish', 'incUp', 'incDown', 'gapUp', 'gapDown', 'incUpAll', 'incDownAll', 'crossUp', 'crossDown', 'gtUp', 'ltUp', 'gtDown', 'ltDown'].concat(FILTER_EXTRA_KEYS, STREAM_FLAG_KEYS).forEach(k => {
        if (typeof s.filters[k] !== 'boolean') s.filters[k] = false;
      });
    }
    if (s && !Array.isArray(s.imported)) s.imported = [];
    if (s && !Array.isArray(s.manual)) s.manual = [];
    if (s && !Array.isArray(s.aiPicks)) s.aiPicks = [];
    /* Global "Run Strategy In" config. Older saves carried a per-strategy map
       (strategyId -> { enabled, side, auto }); detect it by the presence of the
       boolean 'enabled' field and otherwise reset to the default config. */
    if (s && s.runStrategyIn) {
      const rs = s.runStrategyIn;
      if (typeof rs !== 'object' || rs === null || typeof rs.enabled !== 'boolean') {
        s.runStrategyIn = { enabled: false, side: 'CE', auto: false };
      } else {
        if (rs.side !== 'PE') rs.side = 'CE';
        if (typeof rs.auto !== 'boolean') rs.auto = false;
      }
    } else if (s) {
      s.runStrategyIn = { enabled: false, side: 'CE', auto: false };
    }
    if (s && typeof s.settingsSnapshots !== 'object') s.settingsSnapshots = {};
    /* Recompute the running realized totals from the closed history on every
       load (the closed list is the single source of truth and is never
       truncated), so the accumulator can never be stale or miss pre-upgrade
       trades. */
    if (s && Array.isArray(s.closed)) {
      let realized = 0, charges = 0, count = 0, wins = 0;
      for (const t of s.closed) {
        const net = (t.netPnl != null ? t.netPnl : (t.pnl || 0));
        realized += net;
        charges += (t.charges || 0);
        count++;
        if (net > 0) wins++;
      }
      s.rpnl = { realized: realized, charges: charges, count: count, wins: wins };
    } else if (s) {
      s.rpnl = { realized: 0, charges: 0, count: 0, wins: 0 };
    }
    if (s && typeof s.callManual !== 'boolean') s.callManual = true;
    if (s && typeof s.aiPick !== 'boolean') s.aiPick = false;
    if (s && (!Number.isFinite(Number(s.aiPickN)) || Number(s.aiPickN) <= 0)) s.aiPickN = 5;
    if (s && typeof s.aiPickBull !== 'boolean') s.aiPickBull = true;
    if (s && typeof s.aiPickBear !== 'boolean') s.aiPickBear = true;
    return s;
  }

  function save() {
    try {
      localStorage.setItem(AST_KEY, JSON.stringify({
        enabled: state.enabled, universal: state.universal, strike: state.strike,
        runIn: state.runIn, tradeIn: state.tradeIn, premiumOnly: state.premiumOnly,
        groups: state.groups, symbols: state.symbols, movers: state.movers,
        filters: state.filters, selected: state.selected,
        positions: state.positions, closed: state.closed, rpnl: state.rpnl,
        tradeCounts: state.tradeCounts, tradeCountDay: state.tradeCountDay,
        imported: state.imported, manual: state.manual, aiPicks: state.aiPicks,
        callManual: state.callManual, aiPick: state.aiPick, aiPickN: state.aiPickN,
        aiPickBull: state.aiPickBull, aiPickBear: state.aiPickBear,
        runStrategyIn: state.runStrategyIn,
        niftyTrend: state.niftyTrend,
        showPickedStrikes: state.showPickedStrikes,
        settingsSnapshots: state.settingsSnapshots,
        filterMode: state.filterMode,
        dataPool: state.dataPool,
        fastData: state.fastData,
        runIntent: state.runIntent
      }));
    } catch (e) {}
  }

  /* ---------------- saved strategies ---------------- */
  function loadSaved() {
    let list;
    try { list = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'); } catch (e) { list = []; }
    if (!Array.isArray(list)) return [];
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
    return out;
  }

  function groupOfStrategy(s) {
    if (!s) return 'other';
    if (s.group) return s.group;
    return groupOf(s.method);
  }

  /* Saved strategies filtered by the enabled research groups. Strategies with
     no known research group (manually created) always remain eligible. */
  function savedByGroup() {
    const groups = (state.groups && state.groups.length) ? state.groups : GROUP_KEYS.slice();
    return loadSaved().filter(s => {
      const g = groupOfStrategy(s);
      return g === 'other' || groups.indexOf(g) >= 0;
    });
  }

  function aiPickPool() {
    const out = [];
    const seen = new Set();
    const push = (s) => {
      if (!s) return;
      const k = s.id != null ? String(s.id) : String(s.key);
      if (seen.has(k)) return;
      seen.add(k);
      out.push(s);
    };
    loadSaved().forEach(push);
    (state.imported || []).forEach(push);
    (state.manual || []).forEach(push);
    return out;
  }

  function activeStrategies() {
    const seen = new Set();
    const uniq = (s) => {
      if (!s) return null;
      const k = s.id;
      if (seen.has(k)) return null;
      seen.add(k);
      return s;
    };
    const streamGroups = activeFilterGroups();
    const streamAllows = (s) => {
      if (!streamGroups) return true;
      const g = groupOfStrategy(s);
      if (g === 'other') return true;
      const side = (s.cat === 'bearish') ? 'bearish' : 'bullish';
      const want = streamGroups[side] || [];
      return want.indexOf(g) >= 0;
    };
    const out = [];
    if (state.callManual !== false) {
      const saved = savedByGroup().filter(s => !!state.selected[s.id]).map(uniq).filter(Boolean).filter(streamAllows);
      const imported = (state.imported || []).filter(s => !!state.selected[s.id]).map(uniq).filter(Boolean).filter(streamAllows);
      const manual = (state.manual || []).filter(s => !!state.selected[s.id]).map(uniq).filter(Boolean).filter(streamAllows);
      const aiPicks = (state.aiPicks || []).filter(s => !!state.selected[s.id]).map(uniq).filter(Boolean).filter(streamAllows);
      out.push(...saved, ...imported, ...manual, ...aiPicks);
    }
    if (state.aiPick) {
      const n = Math.max(1, Number(state.aiPickN) || 5);
      const pool = aiPickPool();
      if (state.aiPickBull !== false) {
        const bull = pool.filter(s => s.cat !== 'bearish').filter(streamAllows)
          .sort((a, b) => (b.score || 0) - (a.score || 0))
          .slice(0, n);
        out.push(...bull);
      }
      if (state.aiPickBear !== false) {
        const bear = pool.filter(s => s.cat === 'bearish').filter(streamAllows)
          .sort((a, b) => (b.score || 0) - (a.score || 0))
          .slice(0, n);
        out.push(...bear);
      }
    }
    return out;
  }

  /* ---------------- Indicator-filters run mode ----------------
     "Place trades based on Indicator filters: All together (strict AND)".
     Instead of running saved strategies, the engine monitors the selected
     universe (top gainers/losers, NIFTY trend-following stocks/strikes, or the
     open chart symbol) and places a BUY trade only when EVERY selected
     Bullish/Bearish indicator filter passes together on the symbol's chart
     (strict AND, no N-of-M). A SINGLE synthetic strategy carries ALL selected
     filter conditions in its primary entry (no entry-extra section - that stays
     for normal strategies) and runs on every universe symbol through the
     existing per-instrument evaluation/execution pipeline (same SL / trail TP /
     fixed TP / lots / margin / AI risk). */

  /* All selected Bullish+Bearish indicator filter conditions, built WITHOUT
     direction matching so every ticked sub-filter becomes a mandatory AND gate
     (contrast with directionFilterConditions used for normal strategies, which
     zeroes the opposite section). */
  function allSelectedFilterConditions() {
    const tpl = { entry: { indId: 'ema', indSettings: { length: 9, source: 'close' }, valueKey: 'v0' }, entryExtra: [], exit: null, exitExtra: [], candlestick: { enabled: false, entry: [], exit: [] } };
    return buildFilterConditions(tpl, state.filters || {});
  }

  /* The strategy set for Indicator-filters mode: exactly ONE synthetic strategy.
     Its primary `entry` holds every selected filter condition (AND) and its
     entry-extra is empty, so entry fires only when all selected filters pass
     together. The per-symbol execution side is decided by the universe method
     itself (NIFTY trend direction / top gainer-loser / active filter side), so
     no per-symbol strategy binding is needed. */
  function filterModeStrategies() {
    const conds = allSelectedFilterConditions();
    if (!conds.length) return [];
    return [{
      id: 'flt:all',
      name: 'Indicator filter based trades (all together)',
      cat: 'bullish',
      method: '',
      tf: '',
      /* Primary entry = ALL selected filter conditions (strict AND). */
      entry: conds,
      exit: null,
      entryExtra: [],
      exitExtra: [],
      entryThreshold: conds.length,
      candlestick: { enabled: false, entry: [], exit: [] },
      /* Synthetic strategy: never persisted and must not re-append the global
         filters (they ARE the entry conditions). */
      _filterBuilt: true,
      createdAt: Date.now(),
      autoSlPct: null
    }];
  }

  /* ---------------- symbol / instrument resolution ---------------- */
  function isIndex(symbol) {
    return !!(symbol && (symbol.inst === 'INDEX' || symbol.ocExch === 'IDX_I'));
  }
  /* MCX commodity futures / options. Commodities have no index/equity spot and
     no standard option-premium execution path in this engine - they trade the
     FUTCOM futures contract directly (spot mode) like an equity. */
  function isCommodity(symbol) {
    if (!symbol) return false;
    const ex = String(symbol.exch || symbol.ocExch || '').toUpperCase();
    const inst = String(symbol.inst || '').toUpperCase();
    return ex === 'MCX_COMM' || ex === 'NCD_FNO' || inst === 'FUTCOM' || inst === 'OPTFUT';
  }
  /* Chart the strategy run + trade execution should use for an instrument type:
     'spot' (underlying/spot chart), 'premium' (selected strike option premium
     chart) or 'both' (spot + premium). Indices, F&O stocks and commodities each
     read their own "Strategy should be run in" dropdown; commodities default to
     the FUTCOM futures contract (spot). */
  function runInMode(symbol) {
    // Premium-only mode locks BOTH the strategy run chart and the trade
    // execution chart to the option premium chart for every instrument type.
    // It takes precedence over the SIM spot shortcut: with premium-only ON the
    // synthetic SIM stream has no option premium chart, so the symbol is
    // resolved to premium and skipped upstream (never downgraded to spot).
    if (state.premiumOnly) return 'premium';
    // The market-off simulator chart always runs + executes on its own stream.
    if (isSimSymbol(symbol)) return 'spot';
    const ri = state.runIn || {};
    if (isCommodity(symbol)) {
      const m = (ri && ri.comm) || 'spot';
      // Commodities have no separate index/equity spot - both "Spot chart" and
      // "Futures contract" run on the near-month FUTCOM underlying chart, so
      // 'futures' behaves exactly like 'spot' (the near-month contract is the
      // commodity's underlying/main chart).
      return m === 'futures' ? 'spot' : m;
    }
    if (!isIndex(symbol)) return ri.fno || 'spot';
    return ri.index || 'both';
  }
  /* Chart the trade execution should use for an instrument type. Trades for
     BOTH indices and F&O stocks always execute on the selected-strike option
     premium chart ('premium') - never on the underlying/spot chart. Commodities
     execute per their own "Trade should be executed in" dropdown - default the
     FUTCOM futures contract itself ('spot'). */
  function tradeInMode(symbol) {
    if (state.premiumOnly) return 'premium';
    if (isSimSymbol(symbol)) return 'spot';
    const ti = state.tradeIn || {};
    if (isCommodity(symbol)) return (ti && ti.comm) || 'spot';
    if (!isIndex(symbol)) return 'premium';
    return ti.index || 'premium';
  }
  function optionExch(symbol) {
    if (isCommodity(symbol)) return 'MCX_COMM';
    return (symbol && symbol.ocExch === 'BSE_FNO') ? 'BSE_FNO' : 'NSE_FNO';
  }
  function optionInst(symbol) {
    if (isCommodity(symbol)) return 'OPTFUT';
    return isIndex(symbol) ? 'OPTIDX' : 'OPTSTK';
  }

  function quoteCache() {
    return (typeof clientQuotes !== 'undefined' && clientQuotes) ? clientQuotes : {};
  }
  function quoteFor(symbol) {
    if (!symbol) return null;
    const qm = quoteCache();
    return qm[symbol.exch === 'IDX_I' ? 'IDX_I:' + symbol.id : String(symbol.id)] || null;
  }
  function spotLtpFor(sym) {
    const q = quoteFor(sym);
    return (q && q.ltp != null) ? Number(q.ltp) : 0;
  }

  function topMoverSymbols() {
    const mv = state.movers || {};
    if (!mv.enabled) return [];
    const qm = quoteCache();
    const list = (typeof SYMBOLS !== 'undefined' && Array.isArray(SYMBOLS)) ? SYMBOLS : [];
    const gainers = [], losers = [];
    const byId = {};
    list.forEach(s => {
      const name = s[0], id = Number(s[1]), exch = s[2], inst = s[3], ocId = s[4], ocExch = s[5], grp = s[6];
      /* Commodities live in SYMBOLS too but are a SEPARATE, toggle-gated
         universe (state.commodity) - the movers / trend auto-scans must never
         pick them, or strategies run on commodities while the commodity toggle
         is OFF and nothing is +Add-ed. */
      if (!id || inst === 'INDEX' || isCommodity({ exch: exch, inst: inst, ocExch: ocExch })) return;
      byId[id] = { name, id, exch, inst, ocId, ocExch, grp };
    });
    for (const id in byId) {
      const s = byId[id];
      const q = qm[s.exch === 'IDX_I' ? 'IDX_I:' + s.id : String(s.id)];
      if (!q || q.change_pct === undefined) continue;
      const pct = Number(q.change_pct);
      if (isNaN(pct)) continue;
      (pct >= 0 ? gainers : losers).push({ s, pct });
    }
    gainers.sort((a, b) => b.pct - a.pct);
    losers.sort((a, b) => b.pct - a.pct);
    const wantG = Math.max(0, Number(mv.gainers) || 0);
    const wantL = Math.max(0, Number(mv.losers) || 0);
    const out = [];
    const seen = {};
    const push = (s) => {
      if (!s) return;
      const k = String(s.id) + ':' + (s.exch || '');
      if (seen[k]) return;
      seen[k] = 1;
      out.push(s);
    };
    // Manually picked gainers / losers take precedence over the auto top-N
    // counts, so "Add"-ed symbols run regardless of their current rank.
    const picked = Array.isArray(mv.picked) ? mv.picked : [];
    if (picked.length) {
      picked.forEach(s => push(s));
      const wantIdx = Array.isArray(mv.indices) ? mv.indices : [];
      wantIdx.forEach(s => push(s));
      return out;
    }
    gainers.slice(0, wantG).forEach(x => push(x.s));
    losers.sort((a, b) => a.pct - b.pct).slice(0, wantL).forEach(x => push(x.s));
    const wantIdx = Array.isArray(mv.indices) ? mv.indices : [];
    wantIdx.forEach(s => push(s));
    return out;
  }

  function experimentSymbols(niftyDir) {
    /* Market-off simulation chart: the universe collapses to the synthetic
       SIM 900001 stream (treated as a spot underlying). Mutually exclusive with
       every other universe. */
    if (state.sim && state.sim.enabled) return [SIM_SYMBOL];
    /* MCX commodity futures are NOT exclusive with the stock/F&O universes: the
       +Add-ed commodities (traded directly in spot mode) are ADDED to whatever
       the movers / NIFTY trend-following / manual symbol selection produces, so
       commodities can be paper-traded alongside stocks and F&O at the same time. */
    const out = [];
    if (state.commodity && state.commodity.enabled) out.push.apply(out, commoditySymbols());
    const mv = state.movers || {};
    const nt = state.niftyTrend || {};
    if (nt.enabled) {
      // NIFTY trend-following mode: universe = F&O stocks from the NIFTY trend
      // side whose daily change% is above the threshold (+ optional indices).
      out.push.apply(out, pruneNiftyTrendSymbols(niftyTrendSymbols(niftyDir || _lastNiftyDir), niftyDir || _lastNiftyDir));
    } else if (mv.enabled) {
      out.push.apply(out, topMoverSymbols());
    } else {
      const base = (state.symbols && state.symbols.length) ? state.symbols.slice() : [];
      if (base.length) {
        out.push.apply(out, base);
      } else {
        const cur = (typeof selectedSymbol !== 'undefined') ? selectedSymbol : null;
        /* A commodity chart left open must NOT auto-run here: commodities trade
           only when the dedicated commodity toggle (state.commodity.enabled) is
           ON, so the chart fallback skips commodities while it is OFF. */
        if (cur && !(isCommodity(cur) && !(state.commodity && state.commodity.enabled))) out.push(cur);
      }
    }
    /* Deduplicate (a commodity could coincide with a manual symbol). */
    const seen = {};
    return out.filter(s => {
      if (!s || s.id == null) return false;
      const k = String(s.id) + ':' + (s.exch || '');
      if (seen[k]) return false;
      seen[k] = 1;
      return true;
    });
  }

  /* All MCX commodity FUTCOM symbols currently inducted into SYMBOLS by
     loadCommodities() (or resolvable from the picker). Each row carries
     `[name, sid, "MCX_COMM", "FUTCOM", sid, "MCX_COMM", "Commodities (MCX)"]`
     and optionally a trailing has_options flag (slot 7). */
  function commoditySymbolsList() {
    const list = (typeof SYMBOLS !== 'undefined' && Array.isArray(SYMBOLS)) ? SYMBOLS : [];
    const out = [];
    const seen = {};
    list.forEach(s => {
      const name = s[0], id = Number(s[1]), exch = s[2], inst = s[3], ocId = s[4], ocExch = s[5], grp = s[6];
      if (!id || String(exch || '').toUpperCase() !== 'MCX_COMM') return;
      const key = String(id) + ':MCX_COMM';
      if (seen[key]) return;
      seen[key] = 1;
      out.push({
        name: name || ('MCX ' + id), id: id,
        exch: 'MCX_COMM', inst: 'FUTCOM',
        ocId: (ocId != null ? Number(ocId) : id), ocExch: 'MCX_COMM',
        grp: grp || 'Commodities (MCX)',
        hasOptions: (s[7] === undefined) ? true : !!s[7]
      });
    });
    return out;
  }

  /* Only commodities that have a listed option chain - the ones the engine
     dropdown offers, so a user can never pick a futures-only commodity. */
  function optionCommodities() {
    return commoditySymbolsList().filter(c => c.hasOptions !== false);
  }

  /* Migrate the single-selection commodity state ({enabled, sid}) saved by older
     builds to the multi-selection list ({enabled, sids}). Idempotent. */
  function _migrateCommodityState() {
    if (!state.commodity) state.commodity = { enabled: false, sids: [] };
    const c = state.commodity;
    if (c.sid != null && !Array.isArray(c.sids)) {
      c.sids = [];
      const v = Number(c.sid);
      if (c.sid !== '' && v > 0) c.sids.push(v);
      delete c.sid;
    }
    if (!Array.isArray(c.sids)) c.sids = [];
    c.sids = c.sids.filter((v, i, a) => a.indexOf(v) === i && Number(v) > 0);
  }

  /* The commodities the engine trades when commodity mode is ON: one symbol per
     sid in state.commodity.sids (the user's +Add-ed list). Contract ids roll over
     every expiry, so an expired id is dropped silently instead of breaking the
     run. */
  function commoditySymbols() {
    _migrateCommodityState();
    const all = commoditySymbolsList();
    const out = [];
    (state.commodity.sids || []).forEach(sid => {
      const found = all.find(c => Number(c.id) === Number(sid));
      if (found) out.push(found);
    });
    return out;
  }

  /* Direction tag for the Top Gainers / Losers + Indices universe. Each mover is
     traded on the side matching its own daily move: a top GAINER (daily change%
     >= 0) only picks CE call strikes and a top LOSER (daily change% < 0) only
     picks PE put strikes, so the option leg always bets with the stock's move.
     Returns null outside movers mode or without a live % change so callers can
     fall back to their normal leg selection. */
  function moverDirectionFor(symbol) {
    const mv = state.movers || {};
    if (!mv.enabled || !symbol) return null;
    const q = quoteFor(symbol);
    if (!q || q.change_pct === undefined) return null;
    const pct = Number(q.change_pct);
    if (isNaN(pct)) return null;
    return pct >= 0 ? 'bullish' : 'bearish';
  }

  /* ---- NIFTY trend-following F&O picker ----
     "Trade following NIFTY movement & trend": when enabled, the engine only
     paper-trades F&O stocks whose DAILY % change is ABOVE the configured
     threshold, taken from the side the live NIFTY trend points at:
       - NIFTY bullish -> top-gainer F&O stocks with daily change_pct >= pct
       - NIFTY bearish -> top-loser F&O stocks with daily change_pct <= -pct
       - NIFTY unknown/consolidation -> no F&O stock picked (no directional
         bias); explicitly +Add-ed indices still trade (see below)
     The "Include indices for trading" flag appends the chosen indices (NIFTY,
     SENSEX, MIDCPNIFTY, BANKNIFTY, FINNIFTY) alongside the F&O stocks so they
     are traded regardless of the change% threshold and even when NIFTY has no
     confirmed bias. Change% comes straight from the live client quote cache
     (clientQuotes[*].change_pct). */
  function niftyTrendSymbols(niftyDir) {
    const dir = niftyDir || _lastNiftyDir;
    const now = Date.now();
    /* Full-scan throttle: the universe pick only changes on a 1-minute cycle,
       keeping the scan cheap even though the per-tick prune handles immediate
       removals below the threshold. */
    if (dir === _trendScanDir && _trendScanCache && (now - _trendScanAt) < 60000) {
      return _trendScanCache;
    }
    const nt = state.niftyTrend || {};
    const thresh = (Number(nt.pct) > 0) ? Number(nt.pct) : 2.5;
    const qm = (typeof clientQuotes !== 'undefined' && clientQuotes) ? clientQuotes : {};
    const list = (typeof SYMBOLS !== 'undefined' && Array.isArray(SYMBOLS)) ? SYMBOLS : [];
    const byId = {};
    list.forEach(s => {
      const name = s[0], id = Number(s[1]), exch = s[2], inst = s[3], ocId = s[4], ocExch = s[5], grp = s[6];
      /* Commodities live in SYMBOLS too but are a SEPARATE, toggle-gated
         universe (state.commodity) - the movers / trend auto-scans must never
         pick them, or strategies run on commodities while the commodity toggle
         is OFF and nothing is +Add-ed. */
      if (!id || inst === 'INDEX' || isCommodity({ exch: exch, inst: inst, ocExch: ocExch })) return;
      byId[id] = { name, id, exch, inst, ocId, ocExch, grp };
    });
    const quoted = [];
    for (const id in byId) {
      const s = byId[id];
      const q = qm[s.exch === 'IDX_I' ? 'IDX_I:' + s.id : String(s.id)];
      if (!q || q.change_pct === undefined) continue;
      const pct = Number(q.change_pct);
      if (isNaN(pct)) continue;
      quoted.push({ s, pct });
    }
    const out = [];
    const seen = {};
    const push = (s) => {
      if (!s) return;
      const k = String(s.id) + ':' + (s.exch || '');
      if (seen[k]) return;
      seen[k] = 1;
      out.push(s);
    };
    if (dir === 'bullish') {
      quoted.filter(x => x.pct >= thresh).sort((a, b) => b.pct - a.pct).forEach(x => push(x.s));
    } else if (dir === 'bearish') {
      /* Biggest losers first: ascending by % change (most negative on top). */
      quoted.filter(x => x.pct <= -thresh).sort((a, b) => a.pct - b.pct).forEach(x => push(x.s));
    } else {
      /* NIFTY flat / direction unknown: no directional bias means no F&O stock
         is picked. Explicitly +Add-ed indices are NOT threshold/direction-gated
         (their own option leg direction is resolved per strategy/filter later),
         so they still enter the universe - otherwise trend mode silently ignored
         the chosen indices whenever NIFTY had no confirmed bias. */
      if (nt.includeIndices && Array.isArray(nt.indices) && nt.indices.length) {
        nt.indices.forEach(push);
        _trendScanAt = now; _trendScanDir = dir; _trendScanCache = out;
        return out;
      }
      _trendScanAt = now; _trendScanDir = dir; _trendScanCache = [];
      return [];
    }
    if (nt.includeIndices && Array.isArray(nt.indices)) {
      nt.indices.forEach(push);
    }
    _trendScanAt = now;
    _trendScanDir = dir;
    _trendScanCache = out;
    return out;
  }

  /* Per-tick reconciliation: removes any trend-following F&O stock that has
     dropped below the daily change% threshold (or no longer qualifies) from the
     active trading set immediately, without waiting for the next 60s scan.
     Symbols not currently in the pick set are dropped; indices and F&O stocks
     still above the threshold are kept. The caller exits any open positions
     tied to the dropped symbols. */
  function pruneNiftyTrendSymbols(syms, niftyDir) {
    const dir = niftyDir || _lastNiftyDir;
    const nt = state.niftyTrend || {};
    if (!nt.enabled) return syms;
    const thresh = (Number(nt.pct) > 0) ? Number(nt.pct) : 2.5;
    const qm = (typeof clientQuotes !== 'undefined' && clientQuotes) ? clientQuotes : {};
    const idxSet = {};
    if (nt.includeIndices && Array.isArray(nt.indices)) {
      nt.indices.forEach(s => { idxSet[String(s.id) + ':' + (s.exch || '')] = true; });
    }
    const keep = syms.filter(s => {
      const k = String(s.id) + ':' + (s.exch || '');
      if (idxSet[k]) return true;
      if (s.inst === 'INDEX') return true;
      const q = qm[s.exch === 'IDX_I' ? 'IDX_I:' + s.id : String(s.id)];
      if (!q || q.change_pct === undefined) return false;
      const pct = Number(q.change_pct);
      if (isNaN(pct)) return false;
      if (dir === 'bullish') return pct >= thresh;
      if (dir === 'bearish') return pct <= -thresh;
      return false;
    });
    return keep;
  }

  /* ---------------- NIFTY trend-following UI ---------------- */
  const NIFTY_TREND_INDEXES = ['NIFTY 50', 'SENSEX', 'MIDCPNIFTY', 'BANK NIFTY', 'FINNIFTY'];

  function niftyTrendIndicesList() {
    const list = (typeof SYMBOLS !== 'undefined' && Array.isArray(SYMBOLS)) ? SYMBOLS : [];
    const want = {};
    NIFTY_TREND_INDEXES.forEach(n => { want[String(n).toUpperCase()] = true; });
    return list.filter(s => s[3] === 'INDEX' && want[String(s[0]).toUpperCase()])
      .map(s => ({ id: Number(s[1]), exch: s[2], inst: s[3], name: s[0], ocId: s[4], ocExch: s[5], grp: s[6] }));
  }

  function populateNiftyTrendIndicesUI() {
    const el = $id('astNiftyTrendIndicesSelect');
    if (!el || el.dataset.populated) return;
    const list = niftyTrendIndicesList();
    if (!list.length) return;
    list.forEach(it => {
      const o = document.createElement('option');
      o.value = JSON.stringify(it);
      o.textContent = displayName(it);
      el.appendChild(o);
    });
    el.dataset.populated = '1';
  }

  function addNiftyTrendIndex() {
    const el = $id('astNiftyTrendIndicesSelect');
    if (!el || !el.value) { log('Select an index to add', 'warn'); return; }
    let it;
    try { it = JSON.parse(el.value); } catch (e) { return; }
    if (!state.niftyTrend) state.niftyTrend = { enabled: false, pct: 2.5, includeIndices: false, indices: [] };
    if (!Array.isArray(state.niftyTrend.indices)) state.niftyTrend.indices = [];
    const exists = state.niftyTrend.indices.some(s => String(s.id) === String(it.id) && String(s.exch || '') === String(it.exch || ''));
    if (!exists) {
      state.niftyTrend.indices.push(it);
      /* Adding an index is an explicit "trade this index" intent, so it turns
         on the "Include indices for trading" gate as well (parity with the
         movers universe, where an +Add-ed index is traded with no extra flag).
         Otherwise the chip sits in the list but never enters the trend universe
         and the engine appears to ignore the added index. */
      state.niftyTrend.includeIndices = true;
      save();
      _resetTrendScan();
      applyNiftyTrendToUI();
      log('Added index ' + displayName(it) + ' to NIFTY trend-following trading ("Include indices for trading" turned on)', 'ok');
      prewarmChain(it, false);
    }
  }

  function removeNiftyTrendIndex(id, exch) {
    if (!state.niftyTrend) state.niftyTrend = { enabled: false, pct: 2.5, includeIndices: false, indices: [] };
    state.niftyTrend.indices = (state.niftyTrend.indices || []).filter(s => !(String(s.id) === String(id) && String(s.exch || '') === String(exch || '')));
    save();
    _resetTrendScan();
    renderNiftyTrendIndicesList();
  }

  function renderNiftyTrendIndicesList() {
    const el = $id('astNiftyTrendIndicesList');
    if (!el) return;
    const nt = state.niftyTrend || {};
    const idx = Array.isArray(nt.indices) ? nt.indices : [];
    el.innerHTML = idx.map(s =>
      '<span style="background:#1a1a35;border:1px solid #2d2d50;border-radius:3px;padding:2px 6px;display:inline-flex;align-items:center;gap:4px">' + displayName(s) +
      ' <a href="javascript:void(0)" style="color:#ef5350;text-decoration:none;font-weight:700" onclick="AISmartTrading.removeNiftyTrendIndex(' + Number(s.id) + ', \'' + (s.exch || 'IDX_I') + '\')">&times;</a></span>'
    ).join('');
  }

  function readNiftyTrendUI() {
    const onEl = $id('astNiftyTrendEnabled'), pctEl = $id('astNiftyTrendPct'), incEl = $id('astNiftyTrendIndices');
    if (!state.niftyTrend) state.niftyTrend = { enabled: false, pct: 2.5, includeIndices: false, indices: [] };
    state.niftyTrend.enabled = onEl ? onEl.checked : false;
    state.niftyTrend.pct = pctEl ? (Number(pctEl.value) > 0 ? Number(pctEl.value) : 2.5) : 2.5;
    state.niftyTrend.includeIndices = incEl ? incEl.checked : false;
    save();
  }

  function applyNiftyTrendToUI() {
    const nt = state.niftyTrend || (state.niftyTrend = { enabled: false, pct: 2.5, includeIndices: false, indices: [] });
    if (!Array.isArray(nt.indices)) nt.indices = [];
    const ck = (id, v) => { const el = $id(id); if (el) el.checked = !!v; };
    const set = (id, v) => { const el = $id(id); if (el) el.value = v; };
    ck('astNiftyTrendEnabled', nt.enabled);
    ck('astNiftyTrendIndices', nt.includeIndices);
    set('astNiftyTrendPct', nt.pct);
    const btn = $id('astNiftyTrendToggle');
    if (btn) {
      btn.textContent = 'Trend Follow: ' + (nt.enabled ? 'ON' : 'OFF');
      btn.style.background = nt.enabled ? '#00d4aa' : '#e67e22';
    }
    populateNiftyTrendIndicesUI();
    renderNiftyTrendIndicesList();
    const on = !!nt.enabled;
    const simOn = !!(state.sim && state.sim.enabled);
    const active = on && !simOn;
    ['astNiftyTrendPct', 'astNiftyTrendIndices', 'astNiftyTrendIndicesSelect', 'astNiftyTrendIndicesAdd'].forEach(id => {
      const el = $id(id);
      if (el) { el.disabled = !active; el.style.opacity = active ? '1' : '0.5'; }
    });
    const nBtn = $id('astNiftyTrendToggle');
    if (nBtn && simOn) {
      nBtn.textContent = 'Trend Follow: OFF - Simulation on';
      nBtn.style.background = '#666';
      nBtn.style.opacity = '0.6';
    }
    renderNiftyTrendList();
    applyMoversToUI();
  }

  function toggleNiftyTrend() {
    if (!state.niftyTrend) state.niftyTrend = { enabled: false, pct: 2.5, includeIndices: false, indices: [] };
    state.niftyTrend.enabled = !state.niftyTrend.enabled;
    /* Mutually exclusive with Top Gainers / Losers + Indices: enabling trend
       following switches the paper engine into trend mode, so the movers
       universe is switched off and its controls fade to inactive. */
    if (state.niftyTrend.enabled && state.movers) state.movers.enabled = false;
    if (state.niftyTrend.enabled && state.sim) state.sim.enabled = false;
    save();
    _resetTrendScan();
    applyNiftyTrendToUI();
    applyMoversToUI();
    applySimToUI();
    applyCommodityToUI();
    log('NIFTY trend-following trading ' + (state.niftyTrend.enabled ? 'enabled' : 'disabled'), state.niftyTrend.enabled ? 'ok' : 'warn');
  }

  /* Market-off simulation chart toggle. Enabling it collapses the engine's
     universe to the synthetic SIM 900001 stream (traded as a spot underlying)
     and auto-starts the simulator so a live candle feed + quote are always
     present even when the real market is closed. Mutually exclusive with both
     the movers and the NIFTY trend-following universes. */
  function toggleSim() {
    if (!state.sim) state.sim = { enabled: false };
    state.sim.enabled = !state.sim.enabled;
    if (state.sim.enabled) {
      if (state.movers) state.movers.enabled = false;
      if (state.niftyTrend) { state.niftyTrend.enabled = false; _resetTrendScan(); }
      if (state.commodity) state.commodity.enabled = false;
      /* Make sure the server simulator is producing a live stream. */
      if (window.Simulator && typeof window.Simulator.ensureRunning === 'function') {
        window.Simulator.ensureRunning();
      }
    }
    save();
    applySimToUI();
    applyNiftyTrendToUI();
    applyMoversToUI();
    applyCommodityToUI();
    log('Simulation chart trading ' + (state.sim.enabled ? 'enabled' : 'disabled'), state.sim.enabled ? 'ok' : 'warn');
  }

  function applySimToUI() {
    const sim = state.sim || (state.sim = { enabled: false });
    const btn = $id('astSimToggle');
    if (btn) {
      const commOn = !!(state.commodity && state.commodity.enabled);
      btn.textContent = commOn ? 'Simulation Chart: OFF - Commodities on' : ('Simulation Chart: ' + (sim.enabled ? 'ON' : 'OFF'));
      btn.style.background = commOn ? '#666' : (sim.enabled ? '#00d4aa' : '#e67e22');
      btn.style.opacity = commOn ? '0.6' : '1';
    }
    const st = $id('astSimStatus');
    if (st) {
      st.innerHTML = sim.enabled
        ? 'Trading the simulated chart <b style="color:#ffd700">SIM&nbsp;900001</b> (market-off mode) - movers / NIFTY trend-following are disabled.'
        : 'When market is closed, run the algo on the simulated chart (SIM 900001) instead of real strikes.';
    }
  }

  /* MCX commodity futures toggle. Enabling it does NOT collapse the universe -
     the +Add-ed commodities (traded directly on the FUTCOM contract in spot
     mode) are combined with the movers / NIFTY trend-following / manual symbol
     selection so commodities trade alongside stocks and F&O. Only the market-off
     simulation stays exclusive. */
  function toggleCommodity() {
    _migrateCommodityState();
    state.commodity.enabled = !state.commodity.enabled;
    if (state.commodity.enabled) {
      if (state.sim) state.sim.enabled = false;
      /* If nothing is +Add-ed yet, default to the first available contract so
         enabling the mode always has a real symbol to run. */
      if (!state.commodity.sids.length) {
        const first = optionCommodities()[0];
        if (first) state.commodity.sids.push(first.id);
      }
    }
    save();
    applyCommodityToUI();
    applySimToUI();
    log('MCX commodity futures trading ' + (state.commodity.enabled ? 'enabled' : 'disabled'), state.commodity.enabled ? 'ok' : 'warn');
  }

  /* +Add the commodity picked in the dropdown to the trading list (defaulting to
     the first available contract when nothing is selected). Adding also enables
     the mode so the user never has a list with no trades. */
  function addCommodity() {
    _migrateCommodityState();
    const sel = $id('astCommoditySelect');
    let sid = sel ? Number(sel.value) : NaN;
    if (!(sid > 0)) {
      const first = optionCommodities()[0];
      sid = first ? first.id : 0;
    }
    if (!(sid > 0)) return;
    if (state.commodity.sids.indexOf(sid) === -1) state.commodity.sids.push(sid);
    state.commodity.enabled = true;
    save();
    applyCommodityToUI();
  }

  /* Remove one +Add-ed commodity from the trading list. */
  function removeCommodity(sid) {
    _migrateCommodityState();
    const v = Number(sid);
    state.commodity.sids = state.commodity.sids.filter(s => Number(s) !== v);
    save();
    applyCommodityToUI();
  }

  /* Fill the commodity dropdown from SYMBOLS (MCX_COMM/FUTCOM rows inducted by
     loadCommodities()). Because that induction is async, retry a few times so
     the dropdown catches the contracts whenever they arrive. */
  let _commodityUiTries = 0;
  function populateCommoditiesUI() {
    const sel = $id('astCommoditySelect');
    if (!sel) return;
    const comms = optionCommodities();
    if (!comms.length) {
      /* Not loaded yet - the page's loadCommodities() populates SYMBOLS asynchronously. */
      if (_commodityUiTries < 20) {
        _commodityUiTries++;
        setTimeout(populateCommoditiesUI, 1500);
      }
      return;
    }
    const keep = sel.value;
    sel.innerHTML = '<option value="">-- choose commodity --</option>' + comms.map(c =>
      '<option value="' + String(c.id) + '">' + esc(c.name) + '</option>').join('');
    if (keep) sel.value = keep;
  }

  function applyCommodityToUI() {
    _migrateCommodityState();
    const comm = state.commodity;
    const btn = $id('astCommodityToggle');
    if (btn) {
      btn.textContent = 'Commodities: ' + (comm.enabled ? 'ON' : 'OFF');
      btn.style.background = comm.enabled ? '#00d4aa' : '#e67e22';
      btn.style.opacity = '1';
      btn.disabled = false;
    }
    const sel = $id('astCommoditySelect');
    const addBtn = $id('astCommodityAdd');
    if (sel) {
      sel.disabled = false;
      sel.style.opacity = '1';
    }
    if (addBtn) {
      const v = sel ? Number(sel.value) : NaN;
      const picked = (v > 0) ? v : null;
      addBtn.disabled = picked != null && comm.sids.indexOf(picked) !== -1;
      addBtn.style.opacity = addBtn.disabled ? '0.5' : '1';
    }
    populateCommoditiesUI();
    /* Chips for every +Add-ed commodity, each with its own &times; remove. */
    const listEl = $id('astCommodityList');
    if (listEl) {
      const names = {};
      commoditySymbolsList().forEach(c => { names[Number(c.id)] = c.name; });
      listEl.innerHTML = (comm.sids || []).map(sid => {
        const nm = names[Number(sid)] || ('(expired ' + sid + ')');
        return '<span style="display:inline-flex;align-items:center;gap:4px;background:#1a1a35;border:1px solid #2d2d50;color:#ffd700;border-radius:3px;padding:2px 6px;font-size:9px;margin:1px">' + esc(nm) +
          ' <a href="javascript:void(0)" style="color:#ef5350;font-weight:700;text-decoration:none;font-size:11px" title="Remove" onclick="AISmartTrading.removeCommodity(' + Number(sid) + ')">&times;</a></span>';
      }).join('');
    }
    const st = $id('astCommodityStatus');
    if (st) {
      const chosen = commoditySymbols();
      if (comm.enabled) {
        st.innerHTML = chosen.length
          ? 'Paper trading ' + chosen.length + ' MCX commodity' + (chosen.length > 1 ? 's' : '') + ': <b style="color:#ffd700">' + chosen.map(c => esc(c.name)).join(', ') + '</b> - alongside your stock / F&O universe.'
          : 'No commodity selected - use + Add to pick contracts.';
      } else {
        st.innerHTML = 'Add MCX commodity futures to paper-trade them directly (spot mode), alongside stocks / F&O.';
      }
    }
  }

  /* Live preview of the symbols the NIFTY trend-following mode would pick right
     now (trend + qualifying F&O stocks above the threshold + included indices),
     refreshed every poll tick alongside the movers list. */
  function renderNiftyTrendList() {
    const host = $id('astNiftyTrendList');
    if (!host) return;
    const nt = state.niftyTrend || {};
    const qm = (typeof clientQuotes !== 'undefined' && clientQuotes) ? clientQuotes : {};
    const thresh = (Number(nt.pct) > 0) ? Number(nt.pct) : 2.5;
    const dir = _lastNiftyDir || null;
    if (!nt.enabled) {
      host.style.display = '';
      host.innerHTML = '<div style="color:#888;font-size:9px;margin-bottom:2px">NIFTY trend-following is <b style="color:#e67e22">OFF</b> - enable it to auto-pick F&O stocks from the NIFTY trend side with a minimum daily change%.</div>';
      return;
    }
    if (!dir) {
      host.style.display = '';
      const cached = _niftyBiasCache[_niftyTf];
      const nb = (cached && cached.bias) ? cached.bias : null;
      const idx = (nt.includeIndices && Array.isArray(nt.indices) && nt.indices.length) ? nt.indices.map(s => displayName(s)) : [];
      const idxNote = idx.length ? ' &middot; <b style="color:#00d4aa">added indices still trade:</b> ' + idx.join(', ') : '';
      if (nb && nb.overall && nb.current) {
        const o = nb.overall === 'BULL' ? 'Bullish' : nb.overall === 'BEAR' ? 'Bearish' : 'Range';
        const c = nb.current === 'BULL' ? 'Bullish' : nb.current === 'BEAR' ? 'Bearish' : 'Flat';
        host.innerHTML = '<div style="color:#888;font-size:9px;margin-bottom:2px">NIFTY trend is <b style="color:#e67e22">' + o + ' (overall) / ' + c + ' (current)</b> - the two layers do NOT agree, so there is <b style="color:#e67e22">no directional bias</b> right now (waiting for overall + current to agree) - no directional F&O stocks picked' + idxNote + '.</div>';
      } else {
        host.innerHTML = '<div style="color:#888;font-size:9px;margin-bottom:2px">NIFTY trend unknown yet (waiting for the live feed) - no directional F&O stocks picked' + idxNote + '.</div>';
      }
      return;
    }
    const list = (typeof SYMBOLS !== 'undefined' && Array.isArray(SYMBOLS)) ? SYMBOLS : [];
    const byId = {};
    list.forEach(s => {
      const name = s[0], id = Number(s[1]), exch = s[2], inst = s[3], ocId = s[4], ocExch = s[5], grp = s[6];
      /* Commodities live in SYMBOLS too but are a SEPARATE, toggle-gated
         universe (state.commodity) - the movers / trend auto-scans must never
         pick them, or strategies run on commodities while the commodity toggle
         is OFF and nothing is +Add-ed. */
      if (!id || inst === 'INDEX' || isCommodity({ exch: exch, inst: inst, ocExch: ocExch })) return;
      byId[id] = { name, id, exch, inst, ocId, ocExch, grp };
    });
    const rows = [];
    for (const id in byId) {
      const s = byId[id];
      const q = qm[s.exch === 'IDX_I' ? 'IDX_I:' + s.id : String(s.id)];
      if (!q || q.change_pct === undefined) continue;
      const pct = Number(q.change_pct);
      if (isNaN(pct)) continue;
      if (dir === 'bullish' && pct >= thresh) rows.push({ name: displayName(s), pct });
      else if (dir === 'bearish' && pct <= -thresh) rows.push({ name: displayName(s), pct });
    }
    rows.sort((a, b) => dir === 'bullish' ? b.pct - a.pct : a.pct - b.pct);
    const col = dir === 'bullish' ? '#00d4aa' : '#ef5350';
    let html = '<div style="color:' + col + ';font-size:9px;margin-bottom:2px">NIFTY ' + (dir === 'bullish' ? 'Bullish' : 'Bearish') +
      ' &middot; picking F&O stocks with daily change% ' + (dir === 'bullish' ? '&ge; +' : '&le; -') + thresh + '% (' + rows.length + ' match' + (rows.length === 1 ? '' : 'es') + ')</div>';
    if (rows.length) {
      html += '<div>' + rows.map(r =>
        '<span style="background:#1a1a35;border:1px solid #2d2d50;border-radius:3px;padding:2px 6px;margin:0 4px 4px 0;display:inline-flex;align-items:center;gap:4px">' + r.name +
        ' <b style="color:' + (r.pct >= 0 ? '#00d4aa' : '#ef5350') + '">' + (r.pct >= 0 ? '+' : '') + r.pct.toFixed(2) + '%</b></span>'
      ).join('') + '</div>';
    } else {
      html += '<div style="color:#888;font-size:9px">No F&O stocks currently qualify. Lower the threshold or wait for stronger daily moves.</div>';
    }
    const idx = (nt.includeIndices && Array.isArray(nt.indices)) ? nt.indices.map(s => displayName(s)) : [];
    if (idx.length) html += '<div style="color:#888;font-size:9px;margin-top:2px">Indices included: ' + idx.join(', ') + '</div>';
    host.style.display = '';
    host.innerHTML = html;
  }


  /* NIFTY 50 ensemble trend used by the live bias readout and the trend-
     following F&O stock picker. Candles are cached for 60s to stay within
     rate limits. */
  const NIFTY_IDX = { id: 13, exch: 'IDX_I', inst: 'INDEX', name: 'NIFTY 50' };
  /* Extra trend-confirmation indices used by the NIFTY ensemble: GIFT NIFTY
     (overnight/global NIFTY lead, voted like NIFTY itself) and INDIA VIX (fear
     gauge - a rising VIX adds bearish pressure, a falling VIX adds bullish
     pressure). Both are optional: if their candles are unavailable the trend
     falls back to NIFTY 50 alone. */
  const GIFT_NIFTY_IDX = { id: 5024, exch: 'IDX_I', inst: 'INDEX', name: 'GIFT NIFTY' };
  const INDIA_VIX_IDX = { id: 21, exch: 'IDX_I', inst: 'INDEX', name: 'INDIA VIX' };
  const NIFTY_ZONE_LABEL = { overbought: 'Overbought', oversold: 'Oversold', above_upper: 'Above upper band', upper_half: 'Upper half', lower_half: 'Lower half', below_lower: 'Below lower band', inc_up: 'Increasing upward', inc_down: 'Increasing downward' };
  const _NIFTY_TF_KEY = 'algodhan_ast_nifty_tf' + suffix;
  const _NIFTY_TF = (function () { const v = localStorage.getItem(_NIFTY_TF_KEY); return (v === '1min' || v === '5min' || v === 'both') ? v : '5min'; })();
  let _niftyTf = _NIFTY_TF;
  const _niftyBiasCache = {};
  /* Most recent NIFTY trend direction observed by this engine (updated by the
     paper poll). Drives the NIFTY trend-following symbol picker without
     re-fetching candles inside the synchronous symbol-selection path. */
  let _lastNiftyDir = null;
  /* NIFTY trend-following scan throttle: the full F&O universe scan (picking
     top gainers/losers above the daily change% threshold) runs at most once a
     minute; in between, the per-tick prune removes any stock that drops below
     the threshold immediately so it stops being traded without waiting for the
     next full scan. */
  let _trendScanAt = 0;
  let _trendScanDir = null;
  let _trendScanCache = null;
  /* Per-symbol throttle for the "dropped below threshold" removal note (the
     note must not spam the log every tick while the symbol is unqualified). */
  let _trendDropLogAt = {};

  function _resetTrendScan() {
    _trendScanAt = 0;
    _trendScanDir = null;
    _trendScanCache = null;
  }

  function emaSeries(values, period) {
    const k = 2 / (period + 1), out = new Array(values.length);
    let prev = values[0];
    for (let i = 0; i < values.length; i++) {
      prev = (i === 0) ? values[i] : values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  function rsiSeries(closes, period) {
    const n = closes.length, out = new Array(n).fill(null);
    if (n <= period) return out;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) {
      const ch = closes[i] - closes[i - 1];
      if (ch >= 0) gain += ch; else loss -= ch;
    }
    let avgG = gain / period, avgL = loss / period;
    out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
    for (let i = period + 1; i < n; i++) {
      const ch = closes[i] - closes[i - 1];
      avgG = (avgG * (period - 1) + (ch > 0 ? ch : 0)) / period;
      avgL = (avgL * (period - 1) + (ch < 0 ? -ch : 0)) / period;
      out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
    }
    return out;
  }

  function macdSeries(closes, fast, slow, signal) {
    const ef = emaSeries(closes, fast), es = emaSeries(closes, slow);
    const n = closes.length, macd = new Array(n), sig = new Array(n), hist = new Array(n);
    for (let i = 0; i < n; i++) macd[i] = ef[i] - es[i];
    sig[0] = macd[0];
    const k = 2 / (signal + 1);
    for (let i = 1; i < n; i++) sig[i] = macd[i] * k + sig[i - 1] * (1 - k);
    for (let i = 0; i < n; i++) hist[i] = macd[i] - sig[i];
    return { macd, signal: sig, hist };
  }

  function stochSeries(highs, lows, closes, period, smooth) {
    const n = closes.length, k = new Array(n).fill(null), d = new Array(n).fill(null);
    for (let i = period - 1; i < n; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let j = i - period + 1; j <= i; j++) {
        if (highs[j] > hh) hh = highs[j];
        if (lows[j] < ll) ll = lows[j];
      }
      k[i] = (hh - ll) === 0 ? 50 : ((closes[i] - ll) / (hh - ll)) * 100;
    }
    for (let i = 0; i < n; i++) {
      if (k[i] == null) continue;
      const start = i - smooth + 1;
      if (start < 0 || k[start] == null) continue;
      let sum = 0, cnt = 0;
      for (let j = start; j <= i; j++) { sum += k[j]; cnt++; }
      d[i] = sum / cnt;
    }
    return { k, d };
  }

  function diSeries(highs, lows, closes, period) {
    const n = closes.length;
    const plusDI = new Array(n).fill(null), minusDI = new Array(n).fill(null);
    const tr = new Array(n), pdm = new Array(n), mdm = new Array(n);
    for (let i = 0; i < n; i++) {
      const up = i > 0 ? highs[i] - highs[i - 1] : 0;
      const dn = i > 0 ? lows[i - 1] - lows[i] : 0;
      pdm[i] = (up > dn && up > 0) ? up : 0;
      mdm[i] = (dn > up && dn > 0) ? dn : 0;
      tr[i] = Math.max(highs[i] - lows[i], i > 0 ? Math.abs(highs[i] - closes[i - 1]) : 0, i > 0 ? Math.abs(lows[i] - closes[i - 1]) : 0);
    }
    let trSum = 0, pSum = 0, mSum = 0;
    for (let i = 0; i < n; i++) {
      trSum += tr[i]; pSum += pdm[i]; mSum += mdm[i];
      if (i >= period) { trSum -= tr[i - period]; pSum -= pdm[i - period]; mSum -= mdm[i - period]; }
      if (i >= period - 1 && trSum > 0) {
        plusDI[i] = (pSum / trSum) * 100;
        minusDI[i] = (mSum / trSum) * 100;
      }
    }
    return { plusDI, minusDI };
  }

  function niftyBbZone(candles) {
    const n = candles.length, L = 20, k = 2;
    const win = [];
    for (let i = Math.max(0, n - L); i < n; i++) win.push(Number(candles[i].close));
    let sum = 0; for (let i = 0; i < win.length; i++) sum += win[i];
    const mean = sum / win.length;
    let sq = 0; for (let i = 0; i < win.length; i++) sq += (win[i] - mean) * (win[i] - mean);
    const sd = Math.sqrt(sq / win.length);
    const upper = mean + k * sd, lower = mean - k * sd;
    const close = Number(candles[n - 1].close);
    const pctb = (upper - lower) ? (close - lower) / (upper - lower) : 0.5;
    let zone = 'lower_half';
    if (pctb >= 1) zone = 'above_upper';
    else if (pctb >= 0.5) zone = 'upper_half';
    else if (pctb < 0) zone = 'below_lower';
    return { pctb, zone, close, upper, lower };
  }

  /* BB%B line slope: 1 when the %B pane line is rising, -1 when it is falling,
     0 when flat. Compares the %B at the last bar against the previous bar
     (lookback 1; the %B pane's current direction, which tracks price direction
     ~92% of the time on NIFTY 5min) with a small dead-band so one-bar noise in
     the %B pane doesn't fire the gate. */
  function niftyBbSlope(candles, lookback) {
    const n = candles.length, L = 20, k = 2;
    if (n < L + 2) return 0;
    const lb = Math.max(1, Math.min(lookback || 1, n - L));
    const pctbAt = (end) => {
      let sum = 0;
      const win = [];
      for (let i = Math.max(0, end - L + 1); i <= end; i++) win.push(Number(candles[i].close));
      if (win.length < L) return null;
      for (let i = 0; i < win.length; i++) sum += win[i];
      const mean = sum / win.length;
      let sq = 0; for (let i = 0; i < win.length; i++) sq += (win[i] - mean) * (win[i] - mean);
      const sd = Math.sqrt(sq / win.length);
      const upper = mean + k * sd, lower = mean - k * sd;
      const close = Number(candles[end].close);
      return (upper - lower) ? (close - lower) / (upper - lower) : 0.5;
    };
    const cur = pctbAt(n - 1), prev = pctbAt(n - 1 - lb);
    if (cur == null || prev == null) return 0;
    const d = cur - prev;
    const eps = 0.015;
    return d > eps ? 1 : d < -eps ? -1 : 0;
  }

  /* BB%B extreme-reversal state for the inc_up / inc_down %B readouts.
     inc_up fires when the %B line has touched the SESSION's (today's) oversold
     low and has since turned upward - a rebound off the day's oversold extreme.
     inc_down is the mirror image off the session's overbought high. Unlike the
     plain 1-bar slope, this only holds while the move genuinely started at a
     daily extreme and is still within a fresh bounce window, so a %B line
     drifting up in the middle of its day range never flags the state. */
  function niftyBbExtremeReversal(candles) {
    const n = candles.length;
    if (n < 22) return { inc_up: false, inc_down: false };
    const L = 20, k = 2;
    /* Isolate today's bars so the extremes describe only this session. */
    let lastDay = null;
    for (let i = n - 1; i >= 0; i--) {
      const d = istDate(candles[i].time);
      if (d == null) continue;
      if (lastDay === null) lastDay = d;
      if (d !== lastDay) break;
    }
    /* %B per today's bar (trailing 20 closes, same as sessionBbRange). */
    const times = [], pctbs = [];
    const closes = [];
    for (let i = 0; i < n; i++) {
      closes.push(Number(candles[i].close));
      if (istDate(candles[i].time) !== lastDay) continue;
      const c = closes;
      if (c.length < L) continue;
      const win = c.slice(-L);
      const mean = win.reduce((a, b) => a + b, 0) / L;
      let sq = 0; for (let j = 0; j < L; j++) sq += (win[j] - mean) * (win[j] - mean);
      const sd = Math.sqrt(sq / L);
      const upper = mean + k * sd, lower = mean - k * sd;
      pctbs.push((upper - lower) ? (c[c.length - 1] - lower) / (upper - lower) : 0.5);
      times.push(Number(candles[i].time));
    }
    if (pctbs.length < 2) return { inc_up: false, inc_down: false };
    let iMin = 0, iMax = 0;
    for (let i = 1; i < pctbs.length; i++) {
      if (pctbs[i] < pctbs[iMin]) iMin = i;
      if (pctbs[i] > pctbs[iMax]) iMax = i;
    }
    const cur = pctbs[pctbs.length - 1];
    const ms = (t) => (Number(t) > 1e12 ? Number(t) : Number(t) * 1000);
    const lastMs = ms(times[times.length - 1]);
    /* Fresh-bounce window: the daily extreme must have been touched within the
       last ~30 minutes of candle time for the reversal to still count. */
    const W = 30 * 60 * 1000;
    const eps = 0.02;
    const inc_up = (lastMs - ms(times[iMin]) <= W) && (cur > pctbs[iMin] + eps);
    const inc_down = (lastMs - ms(times[iMax]) <= W) && (cur < pctbs[iMax] - eps);
    return { inc_up: inc_up, inc_down: inc_down };
  }

  /* IST calendar date (yyyy-mm-dd) for an epoch-seconds candle time. Used to
     isolate the current session's candles so the BB%B support/resistance lines
     (session min/max) describe only today's range, not the whole lookback. */
  function istDate(ts) {
    const t = Number(ts);
    if (!isFinite(t)) return null;
    if (t > 1e12) return new Date(t).toISOString().slice(0, 10);
    return new Date(t * 1000 + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  }

  /* Session BB%B support/resistance: the min and max of the %B series across
     the current session's candles. `pctb` (the latest %B) is classified against
     this range into an overbought (near the session high) / oversold (near the
     session low) state. The returned low/high are the session support/
     resistance lines surfaced by the NIFTY %B readout. */
  function sessionBbRange(candles) {
    const n = candles.length;
    if (!n) return { low: 0, high: 1, overbought: false, oversold: false };
    let lastDay = null;
    for (let i = n - 1; i >= 0; i--) {
      const d = istDate(candles[i].time);
      if (d == null) continue;
      if (lastDay === null) lastDay = d;
      if (d !== lastDay) break;
    }
    const closes = [], pctbs = [];
    for (let i = 0; i < n; i++) {
      closes.push(Number(candles[i].close));
      if (istDate(candles[i].time) !== lastDay) continue;
      const c = closes;
      if (c.length < 20) continue;
      const win = c.slice(-20);
      const mean = win.reduce((a, b) => a + b, 0) / 20;
      let sq = 0; for (let j = 0; j < 20; j++) sq += (win[j] - mean) * (win[j] - mean);
      const sd = Math.sqrt(sq / 20);
      const upper = mean + 2 * sd, lower = mean - 2 * sd;
      pctbs.push((upper - lower) ? (c[c.length - 1] - lower) / (upper - lower) : 0.5);
    }
    if (!pctbs.length) return { low: 0, high: 1, overbought: false, oversold: false };
    const low = Math.min.apply(null, pctbs);
    const high = Math.max.apply(null, pctbs);
    return { low: low, high: high };
  }

  function bbOverState(pctb, low, high) {
    const span = Math.max(high - low, 0.2);
    return {
      overbought: pctb >= high - 0.15 * span,
      oversold: pctb <= low + 0.15 * span
    };
  }

  /* Weighted ensemble of independent trend / momentum / structure / volatility /
     volume methods. Each method votes +/-1 (bullish / bearish); votes are
     weighted and combined into a single NIFTY direction plus a 0-100 confidence
     score, a strength label and a reversal flag (recent EMA9/21 cross or RSI
     oversold/overbought flip). All computation is O(n) over the 5min series so
     it stays fast enough to run every minute. */
  function niftyTrendAnalysis(candles) {
    const n = candles.length;
    const H = new Array(n), L = new Array(n), C = new Array(n), V = new Array(n);
    for (let i = 0; i < n; i++) {
      H[i] = Number(candles[i].high);
      L[i] = Number(candles[i].low);
      C[i] = Number(candles[i].close);
      V[i] = Number(candles[i].volume) || 0;
    }
    const i = n - 1;
    const e9 = emaSeries(C, 9), e21 = emaSeries(C, 21), e50 = emaSeries(C, 50);
    const e200 = n >= 220 ? emaSeries(C, 200) : null;

    /* Sahi-style two-layer trend filter. OVERALL = the big-picture regime:
       close vs EMA50 plus the EMA50 slope (BULL / BEAR / RANGE). CURRENT = the
       short momentum: EMA9 vs EMA21 (BULL / BEAR / FLAT). The operative
       direction follows OVERALL, and CURRENT only vetoes on a genuine
       contradiction (see niftyOperativeDir). Mirrors smart_ntrader detectNifty. */
    const slope9 = i >= 1 ? (e9[i] - e9[i - 1]) : 0;
    const slope50 = i >= 1 ? (e50[i] - e50[i - 1]) : 0;
    const overall = (C[i] > e50[i] && slope50 > 0) ? 'BULL' : (C[i] < e50[i] && slope50 < 0) ? 'BEAR' : 'RANGE';
    /* CURRENT = short momentum: EMA9 above EMA21 AND EMA9 still rising ->
       BULL; below AND falling -> BEAR; otherwise FLAT. No % dead-band: a hard
       0.05% separation band left current FLAT in real uptrends (EMA9 hugging
       EMA21), so the two layers almost never agreed and NO trend stocks were
       picked anywhere. Direction sign + slope direction is the confirmation. */
    const current = (e9[i] > e21[i] && slope9 >= 0) ? 'BULL' : (e9[i] < e21[i] && slope9 <= 0) ? 'BEAR' : 'FLAT';

    let score = 0, total = 0;
    const add = (signal, weight) => { total += weight; score += (signal || 0) * weight; };

    add(e9[i] > e21[i] ? 1 : -1, 3);
    add(e21[i] > e50[i] ? 1 : -1, 3);
    if (e200) add(C[i] > e200[i] ? 1 : -1, 2);
    add(C[i] > e21[i] ? 1 : -1, 2);
    add(C[i] > e50[i] ? 1 : -1, 2);
    add(i >= 3 ? (e9[i] > e9[i - 3] ? 1 : -1) : 0, 2);

    const macd = macdSeries(C, 12, 26, 9);
    add(macd.macd[i] > macd.signal[i] ? 1 : -1, 3);
    add(i >= 1 ? (macd.hist[i] > macd.hist[i - 1] ? 1 : -1) : 0, 2);

    const rsi = rsiSeries(C, 14), r = rsi[i];
    if (r != null) add(r > 55 ? 1 : r < 45 ? -1 : 0, 2);

    const stoch = stochSeries(H, L, C, 14, 3);
    if (stoch.k[i] != null && stoch.d[i] != null) add(stoch.k[i] > stoch.d[i] ? 1 : -1, 2);

    add(i >= 5 ? (C[i] > C[i - 5] ? 1 : -1) : 0, 2);
    add(i >= 10 ? (C[i] > C[i - 10] ? 1 : -1) : 0, 2);

    let hi20 = -Infinity, lo20 = Infinity;
    for (let k = Math.max(0, n - 20); k < n; k++) { if (H[k] > hi20) hi20 = H[k]; if (L[k] < lo20) lo20 = L[k]; }
    add(C[i] > ((hi20 + lo20) / 2) ? 1 : -1, 2);

    const dm = diSeries(H, L, C, 14);
    if (dm.plusDI[i] != null) add(dm.plusDI[i] > dm.minusDI[i] ? 1 : -1, 2);

    const bb = niftyBbZone(candles);
    add(bb.pctb > 0.5 ? 1 : -1, 1);

    let upVol = 0, dnVol = 0;
    for (let k = Math.max(1, n - 20); k < n; k++) { if (C[k] >= C[k - 1]) upVol += V[k]; else dnVol += V[k]; }
    add(upVol > dnVol ? 1 : upVol < dnVol ? -1 : 0, 1);

    const maxScore = total || 1;
    const confidence = Math.max(50, Math.min(100, Math.round((Math.abs(score) / maxScore) * 100)));
    const dir = score > 0 ? 'bullish' : score < 0 ? 'bearish' : (C[i] >= C[Math.max(0, i - 1)] ? 'bullish' : 'bearish');
    const strength = confidence >= 80 ? 'strong' : confidence >= 60 ? 'moderate' : 'weak';

    let reversal = false, reversalDir = null;
    for (let k = Math.max(1, n - 6); k < n; k++) {
      const prev = e9[k - 1] - e21[k - 1], cur = e9[k] - e21[k];
      if (prev <= 0 && cur > 0) { reversal = true; reversalDir = 'bullish'; break; }
      if (prev >= 0 && cur < 0) { reversal = true; reversalDir = 'bearish'; break; }
    }
    if (!reversal && r != null && i >= 1) {
      const rp = rsi[i - 1];
      if (rp != null) {
        if (rp < 30 && r >= 30) { reversal = true; reversalDir = 'bullish'; }
        else if (rp > 70 && r <= 70) { reversal = true; reversalDir = 'bearish'; }
      }
    }

    const er = niftyBbExtremeReversal(candles);
    return { dir, confidence, strength, reversal, reversalDir, zone: bb.zone, pctb: bb.pctb, close: bb.close, bbSlope: niftyBbSlope(candles), bbIncUp: er.inc_up, bbIncDown: er.inc_down, overall, current };
  }

  /* Combine the 1min and 5min ensemble analyses into a single NIFTY view:
     direction uses the longer 5min trend when the two disagree (flagged as
     mixed); confidence is 5min-weighted; BB%B support/resistance is the widest
     session range seen across both timeframes. */
  function combineNiftyTfs(c5, c1) {
    const ok5 = c5 && c5.length >= 30, ok1 = c1 && c1.length >= 30;
    if (!ok5 && !ok1) return null;
    const ta5 = ok5 ? niftyTrendAnalysis(c5) : null;
    const ta1 = ok1 ? niftyTrendAnalysis(c1) : null;
    const primary = ta5 || ta1;
    const agree = !!(ta5 && ta1 && ta5.dir === ta1.dir);
    const dir = agree ? primary.dir : (ta5 ? ta5.dir : ta1.dir);
    const confidence = (ta5 && ta1)
      ? Math.round(ta5.confidence * 0.6 + ta1.confidence * 0.4)
      : primary.confidence;
    const strength = confidence >= 80 ? 'strong' : confidence >= 60 ? 'moderate' : 'weak';
    const range5 = ok5 ? sessionBbRange(c5) : null;
    const range1 = ok1 ? sessionBbRange(c1) : null;
    const low = (range5 && range1) ? Math.min(range5.low, range1.low) : (range5 ? range5.low : (range1 ? range1.low : 0));
    const high = (range5 && range1) ? Math.max(range5.high, range1.high) : (range5 ? range5.high : (range1 ? range1.high : 1));
    const over = bbOverState(primary.pctb, low, high);
    return {
      dir: dir, confidence: confidence, strength: strength,
      reversal: primary.reversal, reversalDir: primary.reversalDir,
      overall: primary.overall, current: primary.current,
      zone: primary.zone, pctb: primary.pctb, close: primary.close,
      bbSlope: primary.bbSlope, bbIncUp: primary.bbIncUp, bbIncDown: primary.bbIncDown,
      sessLow: low, sessHigh: high, overbought: over.overbought, oversold: over.oversold,
      mixed: !agree && !!ta5 && !!ta1, tf: 'both'
    };
  }

  async function niftyBias(tf) {
    const t = (tf === '1min' || tf === '5min' || tf === 'both') ? tf : _niftyTf;
    const now = Date.now();
    const c = _niftyBiasCache[t];
    if (c && (now - c.at) < 60000) return c.bias;
    const SE = window.StratEngine;
    if (!SE || !SE.fetchCandlesFor) return (c && c.bias) || null;
    try {
      let bias = null;
      if (t === 'both') {
        const c5 = await SE.fetchCandlesFor(NIFTY_IDX, '5min', 3);
        const c1 = await SE.fetchCandlesFor(NIFTY_IDX, '1min', 3);
        bias = combineNiftyTfs(c5, c1);
        if (bias) bias.at = now;
      } else {
        const candles = await SE.fetchCandlesFor(NIFTY_IDX, t, 3);
        if (!candles || candles.length < 30) return (c && c.bias) || null;
        const ta = niftyTrendAnalysis(candles);
        const range = sessionBbRange(candles);
        const over = bbOverState(ta.pctb, range.low, range.high);
        bias = { dir: ta.dir, confidence: ta.confidence, strength: ta.strength, reversal: ta.reversal, reversalDir: ta.reversalDir, overall: ta.overall, current: ta.current, zone: ta.zone, pctb: ta.pctb, close: ta.close, bbSlope: ta.bbSlope, bbIncUp: ta.bbIncUp, bbIncDown: ta.bbIncDown, sessLow: range.low, sessHigh: range.high, overbought: over.overbought, oversold: over.oversold, mixed: false, tf: t, at: now };
      }
      if (!bias) return (c && c.bias) || null;
      bias = await enhanceNiftyBias(bias, t);
      _niftyBiasCache[t] = { at: now, bias };
      return bias;
    } catch (e) { return (c && c.bias) || null; }
  }

  /* GIFT NIFTY + INDIA VIX support for the NIFTY ensemble: the NIFTY direction
     is cross-checked against the GIFT NIFTY (overnight/global lead) trend and
     the INDIA VIX fear gauge. Each extra series casts a weighted vote so a weak
     NIFTY call can be flipped by agreement, but a strong, clear NIFTY trend
     still wins. Runs on the single engine timeframe (5min for the 'both'
     combined view) and is fully optional - any fetch failure keeps the
     NIFTY-only bias. */
  async function enhanceNiftyBias(bias, t) {
    const SE = window.StratEngine;
    if (!SE || !SE.fetchCandlesFor) return bias;
    const et = (t === '1min' || t === '5min') ? t : '5min';
    let scoreAdj = 0, weight = 0, giftRev = null, giftDir = null, vixVote = null;
    try {
      const giftC = await SE.fetchCandlesFor(GIFT_NIFTY_IDX, et, 3);
      if (giftC && giftC.length >= 30) {
        const g = niftyTrendAnalysis(giftC);
        if (g && g.dir) {
          giftDir = g.dir;
          scoreAdj += (g.dir === 'bullish' ? 1 : -1) * 3;
          weight += 3;
          if (g.reversal) giftRev = { reversal: true, reversalDir: g.reversalDir };
        }
      }
    } catch (e) {}
    try {
      const vixC = await SE.fetchCandlesFor(INDIA_VIX_IDX, et, 3);
      if (vixC && vixC.length >= 30) {
        const v = vixTrendSignal(vixC);
        if (v) { scoreAdj += v * 2; weight += 2; vixVote = v; }
      }
    } catch (e) {}
    if (!weight) return bias;
    const niftyWeight = 5;
    const adj = (niftyWeight * (bias.dir === 'bullish' ? 1 : -1)) + scoreAdj;
    const dir = adj > 0 ? 'bullish' : 'bearish';
    const out = Object.assign({}, bias, { dir: dir, enhanced: true, gift: giftDir, vix: vixVote });
    if (giftRev && !out.reversal) { out.reversal = true; out.reversalDir = giftRev.reversalDir; }
    return out;
  }

  /* INDIA VIX fear-gauge signal: a strongly rising VIX (fear spiking) casts a
     bearish vote on NIFTY, a strongly falling VIX casts a bullish vote; a flat
     or small move stays neutral. Compared over ~10 bars (~1 hour of 5min
     candles) with a small dead-band to ignore noise. */
  function vixTrendSignal(vixC) {
    if (!vixC || vixC.length < 12) return 0;
    const n = vixC.length;
    const back = Math.max(1, n - 11);
    const last = Number(vixC[n - 1].close);
    const prev = Number(vixC[back].close);
    if (!isFinite(last) || !isFinite(prev) || prev <= 0) return 0;
    const chg = (last - prev) / prev;
    if (chg > 0.01) return -1;   // VIX rising -> bearish pressure
    if (chg < -0.01) return 1;   // VIX falling -> bullish pressure
    return 0;
  }

  /* Sahi-style operative direction. Direction = the OVERALL (EMA50) regime;
     the CURRENT (EMA9/21) layer only VETOES when it genuinely CONTRADICTS
     (overall BULL + current BEAR, or overall BEAR + current BULL).
     CURRENT=FLAT carries no vote -> fall back to the OVERALL regime, so a flat
     short-term momentum never starves the trend picker. Overall RANGE ->
     null (no directional bias). */
  function niftyOperativeDir(n) {
    if (!n) return null;
    if (n.overall === 'BULL') return (n.current === 'BEAR') ? null : 'bullish';
    if (n.overall === 'BEAR') return (n.current === 'BULL') ? null : 'bearish';
    return null;
  }

  /* Trend-following PICK direction - deliberately FASTER than niftyOperativeDir
     (the conservative OVERALL / EMA50 regime). The NIFTY trend-following STOCK
     picker must follow the trend the market is turning INTO, otherwise a live
     reversal keeps it buying the OLD side's stocks
     (e.g. NIFTY reverses up while trend mode is still picking the bearish
     losers). So the picker follows the CURRENT (EMA9/21) momentum layer first:
        - CURRENT BULL/BEAR (EMA9 crossed + slope confirms) -> pick that side
          immediately (this is exactly the "trend has reversed" signal);
        - CURRENT FLAT -> fall back to the OVERALL regime so a flat short-term
          momentum never starves the pick set (overall RANGE -> no bias).
     CURRENT only turns BULL after EMA9 rises above EMA21 and is still rising,
     so shallow pullbacks inside an established trend leave CURRENT BULL (or
     FLAT) and the picker never churns to the wrong side. */
  function niftyPickDir(n) {
    if (!n) return null;
    if (n.current === 'BULL') return 'bullish';
    if (n.current === 'BEAR') return 'bearish';
    if (n.overall === 'BULL') return 'bullish';
    if (n.overall === 'BEAR') return 'bearish';
    return null;
  }

  /* ---------------- NIFTY confirmation + hysteresis layer ----------------
     niftyPickDir / niftyOperativeDir above flip on intraday 1/5-min noise,
     which makes the NIFTY trend-following CE/PE picks churn to the wrong side.
     This layer runs the shared TrendConfirm machine: the raw operative call
     ('bullish'|'bearish'|null) is the CANDIDATE and it only becomes the live
     `_lastNiftyDir` once it has persisted for the hold budget AND is backed by
     the slower 15-min NIFTY regime, with an anti-oscillation cooldown between
     flips. Every consumer of `_lastNiftyDir` (universe picker, option-leg side,
     picked-strike reconcile, BB%b gate) therefore sees the CONFIRMED direction
     and a momentary EMA/BB cross can never switch the engine to the opposite
     strike. */
  let _niftyConf = null;
  let _niftyHtfCache = null; /* { at, dir } 15-min regime, 150s TTL */

  function niftyConfirmedDir() {
    return (_niftyConf && (_niftyConf.dir === 'BULL' || _niftyConf.dir === 'BEAR')) ? _niftyConf.dir : null;
  }
  /* Confirmed operative as the engine's 'bullish'/'bearish' vocabulary. */
  function niftyConfirmedOperative() {
    const d = niftyConfirmedDir();
    return d === 'BULL' ? 'bullish' : d === 'BEAR' ? 'bearish' : null;
  }
  /* Slow 15-min NIFTY regime (shared TrendConfirm.regime), own cache so the
     coarse-tf fetch stays off the fast bias cache and out of Dhan's rate
     budget. */
  async function niftyHtfDir() {
    if (!window.TrendConfirm) return null;
    const now = Date.now();
    if (_niftyHtfCache && (now - _niftyHtfCache.at) < 150000) return _niftyHtfCache.dir;
    const SE = window.StratEngine;
    if (!SE || !SE.fetchCandlesFor) return _niftyHtfCache ? _niftyHtfCache.dir : null;
    try {
      const c = await SE.fetchCandlesFor(NIFTY_IDX, '15min', 7);
      const rg = (c && window.TrendConfirm.regime) ? window.TrendConfirm.regime(c) : null;
      const dir = (rg && rg.dir) ? rg.dir : null;
      _niftyHtfCache = { at: now, dir: dir };
      return dir;
    } catch (e) { return _niftyHtfCache ? _niftyHtfCache.dir : null; }
  }
  /* Step the machine with the raw operative call and store the confirmed pick
     into _lastNiftyDir. Returns the confirmed 'bullish'|'bearish'|null. */
  async function refreshConfirmedNifty(bias) {
    if (!window.TrendConfirm) { _lastNiftyDir = niftyPickDir(bias); return _lastNiftyDir; }
    if (!_niftyConf) _niftyConf = window.TrendConfirm.create();
    const fast = niftyOperativeDir(bias); /* 'bullish' | 'bearish' | null */
    const fastL = fast === 'bullish' ? 'BULL' : fast === 'bearish' ? 'BEAR' : null;
    const htf = await niftyHtfDir();
    window.TrendConfirm.step(_niftyConf, fastL, htf, Date.now());
    _lastNiftyDir = niftyConfirmedOperative();
    return _lastNiftyDir;
  }

  /* Beyond signal exits: open legs are only closed by the trailing take-profit
     / take-profit protections in checkAutoTargetSl (or a manual Stop/Close). */

  function _niftySummary(bias) {
    if (!bias || !bias.dir) return null;
    const conf = bias.confidence != null ? bias.confidence : 0;
    const rev = bias.reversal ? ' &middot; ' + (bias.reversalDir === 'bullish' ? 'Bullish' : 'Bearish') + ' reversal' : '';
    const mix = bias.mixed ? ' &middot; <span style="color:#b39ddb">1m/5m mixed</span>' : '';
    const sr = (bias.sessLow != null && bias.sessHigh != null)
      ? ' &middot; <span style="color:#ff9800">%B S/R ' + bias.sessLow.toFixed(2) + ' / ' + bias.sessHigh.toFixed(2) + '</span>' : '';
    const ob = bias.overbought ? ' &middot; <span style="color:#ef5350">Overbought</span>' : (bias.oversold ? ' &middot; <span style="color:#00d4aa">Oversold</span>' : '');
    const inc = bias.bbIncUp ? ' &middot; <span style="color:#00d4aa">Inc Up (rebound)</span>' : (bias.bbIncDown ? ' &middot; <span style="color:#ef5350">Inc Down (rollover)</span>' : '');
    const gv = [];
    if (bias.gift) gv.push('GIFT ' + (bias.gift === 'bullish' ? 'Bull' : 'Bear'));
    if (bias.vix) gv.push('VIX ' + (bias.vix === 1 ? 'fall' : 'rise'));
    const gvTxt = gv.length ? ' &middot; <span style="color:#7e57c2">' + gv.join(' / ') + '</span>' : '';
    const op = niftyOperativeDir(bias);
    const layTxt = (bias.overall && bias.current)
      ? ' &middot; <span style="color:#888">overall ' + bias.overall + ' / current ' + bias.current + (op ? '</span>' : ' &middot; no bias</span>') : '';
    return '<span style="color:' + (bias.dir === 'bullish' ? '#00d4aa' : '#ef5350') + '">NIFTY ' + (bias.dir === 'bullish' ? 'Bullish' : 'Bearish') +
      ' &middot; conf ' + conf + '% (' + (bias.strength || '') + ')' + layTxt + rev + mix + gvTxt +
      ' &middot; %B ' + (bias.pctb != null ? bias.pctb.toFixed(2) : '?') + ' (' + (NIFTY_ZONE_LABEL[bias.zone] || bias.zone) + ')' + ob + inc + sr + '</span>';
  }

  async function updateNiftyBiasStatus(bias) {
    const sum = _niftySummary(bias);
    const sumEl = $id('astNiftyStatus');
    if (sumEl) sumEl.innerHTML = (sum || '<span style="color:#666">waiting for NIFTY ' + _niftyTf + ' data&hellip;</span>') + ' ' + niftyConfirmStatusHtml();
    if (bias && isFinite(bias.pctb) && window.NiftyBbpAlert) {
      NiftyBbpAlert.feed('ast', { pctb: bias.pctb, overall: bias.overall });
    }
  }
  /* Confirmed-vs-raw NIFTY direction marker for the status readout. */
  function niftyConfirmStatusHtml() {
    if (!window.TrendConfirm) return '';
    const conf = _niftyConf;
    if (!conf) return '';
    const dir = conf.dir;
    const txt = dir === 'BULL' ? '<span style="color:#00d4aa">BULL confirmed</span>' : dir === 'BEAR' ? '<span style="color:#ef5350">BEAR confirmed</span>' : '<span style="color:#888">neutral</span>';
    let pend = '';
    if (conf.pending !== null) {
      const ptxt = conf.pending === 'BULL' ? 'BULL' : conf.pending === 'BEAR' ? 'BEAR' : 'neutral';
      const left = Math.max(0, Math.round(((conf.pendingSince + conf.pendingHold) - Date.now()) / 1000));
      pend = ' &middot; <span style="color:#ffd700">pending ' + ptxt + ' ~' + left + 's</span>';
    }
    return ' &middot; <span style="font-size:9px">' + txt + pend + '</span>';
  }

  /* BB%b alert gate (mirrors the NTR BB%b alert section). Only acts when the
     section's master "Gate" checkbox is ON. When ON, a new entry may only be
     placed once the matching set BB%b alert signal is currently met:
       - exactly ONE alert line armed (user's manual direction pick) -> that
         line alone decides for every instrument (manual top gainer/loser runs).
       - BOTH lines armed (needed in NIFTY trend-following auto runs, where the
         direction can flip) -> the executed option leg decides: CE leg -> BULL
         CE alert, PE leg -> BEAR PE alert.
       - no option leg known for the instrument -> the NIFTY trend-following
         direction (bullish -> BULL CE alert, bearish -> BEAR PE alert) decides.
     Returns null when the gate is off / satisfied, else a human reason. */
  function bbpGateBlock(instr, tradeTargets) {
    if (!window.NiftyBbpAlert) return null;
    const g = NiftyBbpAlert.gateStatus('ast');
    if (!g || !g.master) return null;
    if (g.last == null) return 'BB%b gate ON: NIFTY BB%b sample pending...';
    const armed = [];
    if (g.bull.enabled) armed.push('bull');
    if (g.bear.enabled) armed.push('bear');
    const rowWait = function (rk, met, valTxt) {
      const sideTxt = rk === 'bear' ? 'BEAR PE' : 'BULL CE';
      if (met) return null;
      return 'BB%b gate: waiting ' + sideTxt + ' alert (' + (rk === 'bear' ? 'BB%b below ' : 'BB%b above ') + valTxt + ', ab ' + g.lastText + ')';
    };
    /* Manual direction pick: one line armed -> that line gates every entry. */
    if (armed.length === 1) {
      const rk = armed[0];
      const row = (rk === 'bear') ? g.bear : g.bull;
      return rowWait(rk, row.met, row.valueText);
    }
    if (!armed.length) return 'BB%b gate ON: koi BB%b alert line LOCK/SET nahi hui - BULL CE ya BEAR PE line enable karke LOCK ALERT & SET dabao';
    /* Both lines armed (auto / trend-following run): the executed leg decides. */
    const probe = (instr && instr.kind === 'option' && (instr.optionType === 'CE' || instr.optionType === 'PE'))
      ? instr
      : (Array.isArray(tradeTargets) && tradeTargets.length && (tradeTargets[0].optionType === 'CE' || tradeTargets[0].optionType === 'PE'))
        ? tradeTargets[0]
        : null;
    let needBear;
    if (probe) {
      needBear = probe.optionType === 'PE';
    } else {
      const dir = _lastNiftyDir;
      if (dir !== 'bullish' && dir !== 'bearish') return 'BB%b gate ON: NIFTY trend direction clear nahi (bullish/bearish pending)';
      needBear = dir === 'bearish';
    }
    const row = needBear ? g.bear : g.bull;
    return rowWait(needBear ? 'bear' : 'bull', row.met, row.valueText);
  }

  /* NIFTY ensemble-trend timeframe (1 min / 5 min). Switching invalidates the
     cached bias so the trend is recomputed on the newly chosen timeframe, the
     static helper text is updated and the choice persists across reloads. */
  function syncNiftyTfUI() {
    const selEl = $id('astNiftyTf');
    if (selEl) selEl.value = _niftyTf;
    const labEl = $id('astNiftyTfLabel');
    if (labEl) labEl.textContent = (_niftyTf === 'both' ? '1min+5min' : _niftyTf) + ' ensemble trend, refreshed at most once a minute.';
  }

  function setNiftyTf(tf) {
    if (tf !== '1min' && tf !== '5min' && tf !== 'both') tf = '5min';
    _niftyTf = tf;
    localStorage.setItem(_NIFTY_TF_KEY, tf);
    delete _niftyBiasCache[tf];
    if (window.NiftyBbpAlert) NiftyBbpAlert.reset('ast');
    syncNiftyTfUI();
    updateNiftyBiasStatus(null);
    niftyBias().then(b => { if (b) updateNiftyBiasStatus(b); });
    log('NIFTY ensemble trend timeframe set to ' + (_niftyTf === 'both' ? '1 min + 5 min' : _niftyTf), 'ok');
  }

  /* Per-symbol trend/movement/direction classifier used to auto-pick the option
     leg for the "Only +green premium strikes" filter: when the underlying is
     bullish in trend/movement/direction the engine resolves only green CE
     strikes; when bearish it resolves only green PE strikes. Reuses the same
     weighted ensemble (EMA/MACD/RSI/Stoch/DI/Bollinger/volume) as the NIFTY
     bias. Cached per symbol for 60s to stay within Dhan's rate limits. */
  const _trendDirCache = new Map();
  const _TREND_DIR_CACHE_MS = 60000;
  async function trendDirectionFor(symbol) {
    if (!symbol) return null;
    const key = String(symbol.id) + ':' + (symbol.exch || '');
    const hit = _trendDirCache.get(key);
    if (hit && (Date.now() - hit.at) < _TREND_DIR_CACHE_MS) return hit.dir;
    const SE = window.StratEngine;
    if (!SE || !SE.fetchCandlesFor) return null;
    try {
      const candles = await SE.fetchCandlesFor(symbol, '5min');
      if (!candles || candles.length < 30) return null;
      const ta = niftyTrendAnalysis(candles);
      const dir = (ta && (ta.dir === 'bullish' || ta.dir === 'bearish')) ? ta.dir : null;
      if (dir) _trendDirCache.set(key, { at: Date.now(), dir });
      return dir;
    } catch (e) { return null; }
  }

  async function contractsFor(symbol, spot, so) {
    if (!symbol) return null;
    /* Per-call override (used by Smart NTrader to drive the strike mode/count
       from its own controls); anything not overridden falls back to the shared
       engine settings (option type / green-premium filter). */
    const st = (so && typeof so === 'object') ? Object.assign({}, state.strike, so) : state.strike;
    let ot = st.optionType || 'both';
    const onlyPos = st.positiveOnly !== false;
    /* "Pick fastest positive rising LTP / LTP change strike": rank the resolved
       strikes per option side so the strike whose LTP (and LTP change) is
       rising the FASTEST sits first, using ONLY the LTP + LTP change values the
       option chain already carries (no bid/ask or other data). Strikes with a
       minus/zero LTP change sink to the end, so every consumer that picks the
       first contract of a side (firstPerSide / contracts[0]) gets the fastest
       positive riser instead of the nearest-ATM row. */
    const fastestRising = st.fastestRising === true;
    const fastestCount = fastestRising ? Math.max(1, Math.floor(Number(st.fastestCount) || 3)) : 0;
    const _riseScore = (c) => {
      if (!c || !(c.premium > 0) || !(c.chg > 0)) return -Infinity;
      let pct = c.chgPct;
      if (pct == null || !isFinite(pct) || pct <= 0) pct = (c.premium > 0) ? (c.chg / c.premium) * 100 : 0;
      return pct <= 0 ? -Infinity : pct;
    };
    /* Rank the resolved strikes per option side (fastest positive riser first),
       then TRUNCATE each side to the top-N fastest rising strikes (N =
       fastestCount). Using ONLY the LTP + LTP change the chain already carries
       (no bid/ask). Minus/zero LTP-change strikes sink to the end and drop off
       when there are enough positive risers, so every consumer that picks the
       first contract of a side (firstPerSide / contracts[0]) still gets the
       single fastest riser, while the truncated list lets the run fan out over
       the top-N fastest rising strikes per side. */
    const _rankFastestRising = (list) => {
      if (!list || !list.length) return list;
      const grp = {};
      list.forEach(c => { const t = (c.optionType === 'PE') ? 'PE' : 'CE'; (grp[t] = grp[t] || []).push(c); });
      const k = Math.max(1, fastestCount);
      const ranked = ['CE', 'PE'].map(t => (grp[t] || []).slice().sort((a, b) => _riseScore(b) - _riseScore(a)).slice(0, k));
      const out = ranked[0].concat(ranked[1]);
      return out.length ? out : list;
    };
    /* NIFTY trend-following direction: when the NIFTY trend engine is enabled
       the CE/PE side is pinned to the LIVE NIFTY direction for every symbol it
       picked - bearish -> PE puts only, bullish -> CE calls only (matches the
       "bearish/bullish stocks picked" set). This is the auto side-selection the
       engine is supposed to apply on top of the mover / stock trend logic. */
    const ntSide = ((state.niftyTrend && state.niftyTrend.enabled) && (_lastNiftyDir === 'bullish' || _lastNiftyDir === 'bearish')) ? _lastNiftyDir : null;
     /* Direction-aware leg pick for the "Only +green premium strikes" filter.
        The leg bought must agree with the direction of the conditions that are
        evaluated on that leg's premium chart. Precedence (see the inline
        comment in the branch below): indicator-filters run side (filter mode),
        NIFTY trend-following side, the running strategies' shared category, the
        selected bullish/bearish indicator filter, the symbol's own daily move,
        then the underlying's own trend. Only if every source is unclassifiable
        does the user's option-type selector decide the legs (the green filter
        still applies). An explicit optionType in the per-call override (Smart
        NTrader pins its decided CE/PE side) wins - the green filter still
        applies to that side's strikes, but the caller's side is never
        overridden. */
    if ((onlyPos || moverDirectionFor(symbol) != null || ntSide) && (!so || !so.optionType)) {
      /* Leg side precedence. The conditions a strategy/filter evaluates are
         measured on the premium chart of the leg being bought, so the leg must
         agree with the DIRECTION those conditions express - otherwise a bullish
         condition judged against a PE premium (whose price mirrors the
         underlying) fires and the engine buys the OPPOSITE leg, entering trades
         whose chart never shows the ticked condition:
           - Indicator-filters run mode: the Bullish/Bearish filters the user
             ticked DEFINE this run's direction -> that side wins first.
           - NIFTY trend-following side (when that universe engine is on).
           - The unanimous category of the running strategies (a single
             bullish/bearish strategy set only ever trades its own side).
           - Only when NO directional choice is expressed does the symbol's own
             daily move auto-pick the leg (top-gainers->CE / top-losers->PE). */
      const dir = state.filterMode
        ? (activeFilterDirection() || ntSide || moverDirectionFor(symbol) || await trendDirectionFor(symbol))
        : (ntSide || strategyDirectionFor() || activeFilterDirection() || moverDirectionFor(symbol) || await trendDirectionFor(symbol));
      if (dir === 'bullish') ot = 'CE';
      else if (dir === 'bearish') ot = 'PE';
    }
    const mode = st.mode || 'both_atm';
    /* Fastest-rising run: fetch a pool at least as wide as the number of
       fastest risers to run on (fastestCount) so the top-N truncation actually
       has N+ candidates per side to choose from; the old "Number of Strikes"
       input only sizes the normal nearest-ATM pool and is disabled while the
       fastest-rising checkbox is on. */
    const baseCount = mode === 'atm' ? 1 : (st.count || 3);
    const count = fastestRising ? Math.max(baseCount, fastestCount) : baseCount;
    const cacheKey = 'ast:' + String(symbol.id) + ':' + (symbol.ocExch || '') + ':' + mode + ':' + count + ':' + ot + ':' + (onlyPos ? 'pos' : 'all') + ':' + (fastestRising ? 'fast:' + fastestCount : 'near');
    const hit = _contractsCache.get(cacheKey);
    if (hit && (Date.now() - hit.at) < _CONTRACTS_CACHE_MS && hit.contracts) {
      _pickedStrikes.set(_pickedKey(symbol), { symbol: symbol, contracts: hit.contracts, at: Date.now() });
      _schedulePickedPersist();
      return hit.contracts;
    }
    /* Inside the rate-limit backoff window: do NOT touch /api/auto_strikes.
       Serve the last-known contracts so open positions keep being managed, and
       return null when there is nothing cached so the caller reports the
        retry state instead of hammering Dhan. */
    if (chainRateLimited(symbol)) {
      if (hit && hit.contracts) {
        _pickedStrikes.set(_pickedKey(symbol), { symbol: symbol, contracts: hit.contracts, at: Date.now() });
        _schedulePickedPersist();
        return hit.contracts;
      }
      return null;
    }
    try {
      // Indices carry their derivative segment (IDX_I / BSE_FNO) in ocExch.
      // F&O stocks arrive as equity spots (NSE_EQ/BSE_EQ) and must be sent to
      // the server with that EQUITY segment so _resolve_fno_underlying maps them
      // to the FUTSTK underlying on NSE_FNO/BSE_FNO via symbol_name.
      const ocSeg = isIndex(symbol)
        ? (symbol.ocExch || 'IDX_I')
        : (symbol.exch || 'NSE_EQ');
      const body = {
        security_id: symbol.ocId != null ? symbol.ocId : symbol.id,
        exchange_segment: ocSeg,
        symbol_name: symbol.name || '',
        mode: mode,
        count: count,
        option_type: ot,
        spot: spot || 0
      };
      // Retry transient Dhan failures (rate-limit / flaky gateway) a couple of
      // times before giving up, so a single DH-904/805/cooldown blip does not
      // collapse every symbol into "No option contract" / "No execution target"
      // for the whole rate-limit backoff window.
      let j = null, res = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, 400 * attempt));
        res = await fetch('/api/auto_strikes', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        j = await res.json();
        if (j.status === 'success' && Array.isArray(j.data) && j.data.length) break;
        const msg = (j && j.message) || '';
        if (!/rate|limit|wait/i.test(msg)) break;
      }
      /* Dhan rate-limit / server-cooldown: back off and serve cached strikes so
         the next engine ticks do not pile more auto_strikes calls onto a Dhan
         surface that is already rejecting us (which re-arms the cooldown and
         freezes /api/candles for the whole app). */
      if (res.status === 429 || res.status === 503 || res.status >= 500 || (j && j.status !== 'success' && /rate\s*lim/i.test(String(j.message || '')))) {
        markChainRateLimited(symbol);
        log('Option chain rate-limited for ' + displayName(symbol) + ' - backing off ~' + _CHAIN_RL_SEC + 's', 'warn');
        if (hit && hit.contracts) {
          _pickedStrikes.set(_pickedKey(symbol), { symbol: symbol, contracts: hit.contracts, at: Date.now() });
          _schedulePickedPersist();
          return hit.contracts;
        }
        return null;
      }
      if (!j || j.status !== 'success' || !Array.isArray(j.data) || !j.data.length) return null;
      const build = (posOnly) => {
        const all = [], out = [];
        j.data.forEach(d => {
          const mk = (otype, ltp, chg, chgPct, delta, sid) => {
            if (ltp == null || chg == null || sid == null) return null;
            return { strike: d.strike, optionType: otype, premium: ltp, chg: chg, chgPct: chgPct, delta: delta, sid: sid, expiry: j.expiry };
          };
          if (ot === 'both' || ot === 'CE') {
            const c = mk('CE', d.ce_ltp, d.ce_chg, d.ce_chg_pct, d.ce_delta, d.ce_sid);
            if (c) { all.push(c); if (!posOnly || (c.premium > 0 && c.chg > 0)) out.push(c); }
          }
          if (ot === 'both' || ot === 'PE') {
            const p = mk('PE', d.pe_ltp, d.pe_chg, d.pe_chg_pct, d.pe_delta, d.pe_sid);
            if (p) { all.push(p); if (!posOnly || (p.premium > 0 && p.chg > 0)) out.push(p); }
          }
        });
        const filtered = out.filter(c => c.strike != null && c.premium != null);
        /* When the whole chain is red (minus/zero LTP or LTP change on every
           strike), the "+green premium" filter would leave zero contracts and
           every symbol would be skipped with "No option contract" / "No
           execution target". Relax to all strikes so the engine still runs and
           surfaces trades, mirroring the Auto Experiment engine's behaviour. */
        if (posOnly && !filtered.length && all.length) {
          log('No green/positive premium strikes for ' + displayName(symbol) + ' - using all strikes so trades still execute', 'warn');
          return all.filter(c => c.strike != null && c.premium != null);
        }
        return filtered;
      };
      let filtered = build(onlyPos);
      if (onlyPos && !filtered.length) {
        log('No +green premium strikes matched the "Only +green" filter for ' + displayName(symbol) + ' - no strikes picked (minus/zero LTP or LTP change strikes are always skipped)', 'warn');
      }
      if (fastestRising && filtered && filtered.length) filtered = _rankFastestRising(filtered);
      _cacheSet(_contractsCache, cacheKey, { at: Date.now(), contracts: filtered });
      _pickedStrikes.set(_pickedKey(symbol), { symbol: symbol, contracts: filtered, at: Date.now() });
      _schedulePickedPersist();
      return filtered;
    } catch (e) { return null; }
  }

  /* Plain ATM contract for the pooled runner. Ignores the engine's "+green
     premium" filter and directional leg pick - the pool only needs the current
     ATM strike premium (small notional that fits the template margin), so it is
     resolved directly when contractsFor() came back empty because that filter
     rejected every leg. Shares the same rate-limit backoff so it never hammers
     Dhan during a cooldown. */
  async function poolAtmContracts(symbol, spot) {
    if (chainRateLimited(symbol)) return null;
    try {
      const body = {
        security_id: symbol.ocId != null ? symbol.ocId : symbol.id,
        exchange_segment: isIndex(symbol) ? (symbol.ocExch || 'IDX_I') : (symbol.exch || 'NSE_EQ'),
        symbol_name: symbol.name || '',
        mode: 'atm',
        count: 1,
        option_type: moverDirectionFor(symbol) || (state.strike && state.strike.optionType) || 'both',
        spot: spot || 0
      };
      const res = await fetch('/api/auto_strikes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      const j = await res.json();
      if (res.status === 429 || res.status === 503 || res.status >= 500 || (j && j.status !== 'success' && /rate\s*lim/i.test(String(j.message || '')))) {
        markChainRateLimited(symbol);
        return null;
      }
      if (!j || j.status !== 'success' || !Array.isArray(j.data) || !j.data.length) return null;
      const out = [];
      j.data.forEach(d => {
        if (d.ce_ltp != null && d.ce_ltp > 0) out.push({ strike: d.strike, optionType: 'CE', premium: d.ce_ltp, chg: d.ce_chg, chgPct: d.ce_chg_pct, delta: d.ce_delta, sid: d.ce_sid, expiry: j.expiry });
        if (d.pe_ltp != null && d.pe_ltp > 0) out.push({ strike: d.strike, optionType: 'PE', premium: d.pe_ltp, chg: d.pe_chg, chgPct: d.pe_chg_pct, delta: d.pe_delta, sid: d.pe_sid, expiry: j.expiry });
      });
      return out.length ? out : null;
    } catch (e) { return null; }
  }

  /* One trade per symbol, directly on the chart that is actually traded:
     collapse a resolved chain down to the SINGLE nearest-ATM contract per
     option side (CE, PE). Before this, a symbol fanned out into every strike of
     the chain (e.g. 2160 PE + 2180 PE together) and the engine opened several
     legs per symbol. Chain rows arrive nearest-to-farthest, so the first CE and
     first PE row are the ATM strikes. */
  function firstPerSide(contracts) {
    const seen = {};
    const out = [];
    (contracts || []).forEach(c => {
      const t = c.optionType === 'PE' ? 'PE' : 'CE';
      if (seen[t]) return;
      seen[t] = true;
      out.push(c);
    });
    return out;
  }

  /* ---- Index chain pre-warm ----
     Indices +Add-ed to the Top Gainers/Losers universe (state.movers.indices) or
     to NIFTY trend-following (state.niftyTrend.indices) must resolve option
     strikes on the next auto pass so they materialise as Running Strategy rows,
     paper trades and indicator-filter instruments exactly like F&O stocks do.

     An index whose chain was never built in this server session starts COLD: the
     first /api/auto_strikes can come back empty/202 while the server's REST
     refresh runs, and a single empty response made resolveInstruments() drop the
     index for the whole run (its option:4 rows were only the stocks whose chains
     had been warmed earlier on charts). Pre-warming at +Add time - and re-arming
     below from resolveInstruments() for any index that still failed a pass -
     mirrors the OC-panel warm-up, caches the strikes (contractsFor) and tells
     the server to persist the chain so the index joins the run. */
  const _prewarmAt = {};     // picked key -> last pre-warm attempt timestamp
  const _prewarmLogAt = {};  // picked key -> last "chain still building" log timestamp
  const _prewarmReArmLog = {}; // picked key -> last "resolved no strikes, re-warming" log timestamp
  const _prewarmInFlight = {}; // picked key -> true while a warm-up request is running
  async function prewarmChain(sym, quiet) {
    if (!sym || isSimSymbol(sym) || isCommodity(sym)) return;
    const key = _pickedKey(sym);
    const now = Date.now();
    if (chainRateLimited(sym)) return;                 // backoff: a later pass retries
    if (now - (_prewarmAt[key] || 0) < 15000) return;  // one attempt / 15s / symbol is plenty
    if (_prewarmInFlight[key]) return;                 // a warm-up is already running
    _prewarmAt[key] = now;
    _prewarmInFlight[key] = true;
    try {
      const contracts = await contractsFor(sym, spotLtpFor(sym));
      if ((!contracts || !contracts.length) && !quiet && now - (_prewarmLogAt[key] || 0) > 60000) {
        _prewarmLogAt[key] = now;
        log('Option chain for ' + displayName(sym) + ' is still building - its strikes will appear once the chain is ready', 'warn');
      }
    } catch (e) {} finally { delete _prewarmInFlight[key]; }
  }

  /* The direction the current entry signal expresses, used to pick the leg
     (CE for bullish / PE for bearish) when executing straight on the chart.
     Normal strategies carry their own category. The Indicator-filters run is a
     synthetic strategy whose cat is always 'bullish', so its real direction
     comes from the ticked Bullish/Bearish filters. */
  function signalSideFor(s) {
    if (s && s._filterBuilt) return activeFilterDirection();
    const cat = s && s.cat;
    return cat === 'bearish' ? 'bearish' : (cat === 'bullish' ? 'bullish' : null);
  }

  async function resolveInstruments(side) {
    const syms = experimentSymbols();
    if (!syms.length) return [];
    /* "Pick fastest rising..." ON: the resolved chain is already truncated to the
       top-N fastest rising strikes of the decided side (bullish -> CE, bearish ->
       PE) by contractsFor(). Every one of those strikes becomes its own option
       instrument so the strategy / indicator filters analyse each fastest rising
       premium chart independently and a trade executes on EVERY strike whose
       chart fires - several simultaneous legs across the top-N strikes is the
       intended behaviour (Option A). Off: the historical one-trade-per-symbol
       collapse (firstPerSide) stays untouched. */
    const fastestOn = !!(state.strike && state.strike.fastestRising === true);
    const out = [];
    for (const sym of syms) {
      const spot = spotLtpFor(sym);
      /* Global "Run Strategy In" override (Selected Strategies section): run the
         selected strategies on the option premium chart of ONLY the chosen side
         (CE or PE) for every symbol in the selected universe. The run-in /
         trade-in dropdowns are ignored here - the override deliberately locks
         the strategies to the premium chart of that single side. The synthetic
         SIM stream and MCX commodities have no CE/PE option premium in this
         engine, so they are skipped for the override. */
      if (side === 'CE' || side === 'PE') {
        if (isSimSymbol(sym) || isCommodity(sym)) continue;
        let contracts = null;
        try { contracts = await contractsFor(sym, spot, { optionType: side }); } catch (e) { contracts = null; }
        if (contracts && contracts.length) {
          /* Fastest-rising run: every top-N strike of this single decided side
             becomes its own instrument so each is analysed + traded. Off: only
             the first (ATM/fastest) strike of the side is traded. */
          const picks = fastestOn ? contracts : firstPerSide(contracts);
          for (const c of picks) out.push({ kind: 'option', symbol: sym, strike: c.strike, optionType: c.optionType, sid: c.sid, premium: c.premium });
        } else {
          log('No ' + side + ' option contracts for ' + displayName(sym) + ' - skipping (Run Strategy In ' + side + ')', 'warn');
        }
        continue;
      }
      // "Strategy should be run in" = Spot chart: trade the underlying/spot
      // chart directly (no option chains / strikes are resolved), for both
      // indices and F&O stocks.
      if (runInMode(sym) === 'spot') {
        out.push({ kind: 'underlying', symbol: sym });
        continue;
      }
      let contracts = null;
      try { contracts = await contractsFor(sym, spot); } catch (e) { contracts = null; }
      // "Strategy should be run in" = Both: resolve a combined instrument that
      // carries the underlying spot chart (primary trend confirmation) plus the
      // selected-strike premium contracts (secondary confirmation). The entry
      // decision needs confirmation from both charts.
      if (runInMode(sym) === 'both') {
        if (contracts && contracts.length) {
          /* Fastest-rising run: the whole top-N per-side strike set is what must
             be analysed and traded together (Option A), so every strike becomes
             its own option instrument carrying its own premium chart - the
             combined single-instrument 'both' shape (one strike per symbol) can
             not represent several simultaneous fastest-rising legs. Off: the
             historical single combined spot+premium instrument stays. */
          if (fastestOn) {
            for (const c of contracts) out.push({ kind: 'option', symbol: sym, strike: c.strike, optionType: c.optionType, sid: c.sid, premium: c.premium });
          } else {
            out.push({ kind: 'both', symbol: sym, contracts });
          }
        } else {
          log('No option contracts for ' + displayName(sym) + ' - skipping (both run needs spot + premium)', 'warn');
        }
        continue;
      }
      if (contracts && contracts.length) {
        const picks = fastestOn ? contracts : firstPerSide(contracts);
        for (const c of picks) out.push({ kind: 'option', symbol: sym, strike: c.strike, optionType: c.optionType, sid: c.sid, premium: c.premium });
      } else {
        // No option contracts resolved (chain unavailable/rate-limited, or the
        // "Only +green premium strikes" filter removed every strike in a red
        // market). The premium run-in is honoured by skipping rather than
        // silently downgrading to the underlying/spot chart.
        log('No option contracts for ' + displayName(sym) + ' - skipping (premium run)', 'warn');
      }
    }
    /* Re-arm the warm-up for any INDEX still without a resolved instrument on
       this pass (cold chain / first build / a one-off empty response). A single
       empty /api/auto_strikes must not silently drop the index for the whole
       session: prewarmChain keeps asking in the background (throttled + honouring
       the surface backoff), and the next pass picks the strikes up from the
       shared contracts cache once the server has built the chain. */
    const _idxReArmLog = _prewarmReArmLog;
    syms.forEach(sy => {
      if (!isIndex(sy) || isSimSymbol(sy) || isCommodity(sy)) return;
      if (out.some(i => i && i.symbol && _pickedKey(i.symbol) === _pickedKey(sy))) return;
      const k = _pickedKey(sy);
      const now = Date.now();
      if (chainRateLimited(sy)) return;
      if (now - (_idxReArmLog[k] || 0) > 60000) {
        _idxReArmLog[k] = now;
        log('Index ' + displayName(sy) + ' resolved no strikes this pass - re-warming its option chain so it joins the run', 'warn');
      }
      prewarmChain(sy, true);
    });
    return out;
  }

  function instrumentId(instr) {
    if (instr.kind === 'option') return 'opt:' + instr.sid;
    const sym = instr.symbol;
    return 'sym:' + sym.id + ':' + (sym.exch || '');
  }
  function instrumentName(instr) {
    if (instr.kind === 'option') return (instr.symbol.name || instr.symbol.id) + ' ' + instr.strike + ' ' + instr.optionType;
    return instr.symbol.name || ('Symbol ' + instr.symbol.id);
  }
  function instrumentQuote(instr) {
    const qm = quoteCache();
    if (instr.kind === 'option') return qm[String(instr.sid)] || null;
    const sym = instr.symbol;
    return qm[sym.exch === 'IDX_I' ? 'IDX_I:' + sym.id : String(sym.id)] || null;
  }
  /* The chart's current price for a position: delegates to the single shared
     chart/candle source (tradeChartPrice in index.html) so the Running
     Positions P&L is guaranteed identical to the chart's running P&L — never
     the delayed live feed. Falls back to local chart/candle logic only if the
     shared helper is unavailable. */
  function positionPremiumLastClose(p) {
    /* Running P&L must reflect the SAME live price the engine actually trades
       and exits on (riskScan uses the live feed quote for the peak / trail-SL
       ratchet and the exit fill). The option-leg candle-close cache can sit far
       above the live premium for sparsely-traded strikes, which made Running
       Trades flash a large phantom profit while the real trail-SL close booked
       a small one. Fall back to the chart/candle close only when no live quote
       exists yet. */
    if (p && p.symbolId != null && typeof window.liveQuoteForSymbol === 'function') {
      try {
        const lq = window.liveQuoteForSymbol(Number(p.symbolId), p.symbolExch);
        if (lq != null && lq > 0) return lq;
      } catch (e) {}
    }
    if (typeof window.tradeChartPrice === 'function') return window.tradeChartPrice(p);
    if (p.symbolId == null) return null;
    const sid = Number(p.symbolId);
    if (typeof selectedSymbol !== 'undefined' && selectedSymbol &&
        selectedSymbol.id === sid && window.IndChart && IndChart.getCandles) {
      const c = IndChart.getCandles();
      if (c && c.length) {
        const lc = Number(c[c.length - 1].close);
        if (lc > 0) return lc;
      }
    }
    const SE = window.StratEngine;
    const cache = (SE && SE.candleCache) || {};
    let best = null, bestAt = 0;
    for (const k in cache) {
      if (k.indexOf(sid + ':') !== 0) continue;
      const e = cache[k];
      if (e && e.candles && e.candles.length && e.at >= bestAt) {
        const lc = Number(e.candles[e.candles.length - 1].close);
        if (lc > 0) { best = lc; bestAt = e.at; }
      }
    }
    return best;
  }
  /* Current price for a position: the chart/candle close only. The live feed
     quote source (clientQuotes) was removed entirely — Running Trades / Running
     Positions P&L now always matches the chart's own price, never a delayed
     feed tick. */
  function positionCurrentPrice(p) {
    return positionPremiumLastClose(p);
  }
  /* Execution targets per the "Trade should be executed in" setting: the
     underlying/spot chart ('spot'), the selected-strike option premium chart
     ('premium'), or BOTH charts ('both' -> a position on the spot underlying
     AND on the option contract). Signals are evaluated on the run-in
     instrument, while paper positions are placed on these targets. When
     execution is premium/both but the run-in instrument carries no option
     contract, the first selected strike's option contract is used. */
  async function executionSymbolsFor(instr, s) {
    const sym = instr.symbol;
    if (!sym) return [];
    const tiMode = tradeInMode(sym);
    /* Execute directly on the chart's own side: when the run chart is the
       underlying/spot (or fell back to it because the premium chart had no
       candles) and the entry signal carries a direction, the paper BUY goes to
       that direction's single ATM option (bullish -> CE, bearish -> PE) instead
       of buying the plain underlying - so a bearish chart signal buys the PE,
       never a long on the spot. Falls back to the spot symbol when no direction
       is known, the symbol has no options (commodity / SIM), or the chain is
       rate-limited. */
    const sideOpt = async () => {
      const side = signalSideFor(s);
      if (side !== 'bullish' && side !== 'bearish') return [];
      if (isCommodity(sym) || isSimSymbol(sym)) return [];
      try {
        const spot = spotLtpFor(sym);
        const contracts = await contractsFor(sym, spot, { optionType: side === 'bearish' ? 'PE' : 'CE' });
        const c = (contracts && contracts.length) ? contracts[0] : null;
        if (!c) return [];
        return [{ id: Number(c.sid), exch: optionExch(sym), inst: optionInst(sym), name: (sym.name || sym.id) + ' ' + c.strike + ' ' + c.optionType, strike: c.strike, optionType: c.optionType, premium: c.premium }];
      } catch (e) { return []; }
    };
    // Premium-chart candle fallback active: the run-in premium chart has no
    // candles so the strategy evaluates on the underlying chart - execute on
    // the underlying as well so the trade is never skipped. Premium-only mode
    // overrides this: execution stays on the premium chart only, never the
    // underlying.
    if (!state.premiumOnly && _candleFbk[instrumentId(instr)]) {
      const o = await sideOpt();
      return o.length ? o : [sym];
    }
    if (tiMode === 'spot') {
      const o = await sideOpt();
      return o.length ? o : [sym];
    }
    if (instr.kind === 'option') {
      const optSym = { id: Number(instr.sid), exch: optionExch(sym), inst: optionInst(sym), name: (instr.symbol.name || instr.symbol.id) + ' ' + instr.strike + ' ' + instr.optionType, strike: instr.strike, optionType: instr.optionType, premium: instr.premium };
      return tiMode === 'both' ? [sym, optSym] : [optSym];
    }
    let contracts = instr.contracts || null;
    if (!contracts) {
      const spot = spotLtpFor(sym);
      try { contracts = await contractsFor(sym, spot); } catch (e) { contracts = null; }
    }
    const c = (contracts && contracts.length) ? contracts[0] : null;
    if (!c) {
      log('No option contract for ' + displayName(sym) + ' - skipping (premium execution)', 'warn');
      return [];
    }
    const optSym = { id: Number(c.sid), exch: optionExch(sym), inst: optionInst(sym), name: (sym.name || sym.id) + ' ' + c.strike + ' ' + c.optionType, strike: c.strike, optionType: c.optionType, premium: c.premium };
    if (tiMode === 'both') return [sym, optSym];
    return [optSym];
  }
  function posKeyOf(tradeSym) {
    return String(tradeSym.id) + ':' + (tradeSym.exch || '');
  }
  function strategyKey(s, instr) {
    return 'ast:' + s.id + '@' + instrumentId(instr);
  }
  /* Option execution targets are not in the watchlist, so the feed delivers no
     LTP for them until their candles are fetched (the server subscribes the
     contract on /api/candles). This matters for F&O stocks (run spot / execute
     premium): without it every entry skips on "no live price" and, once a trade
     is open, auto SL / trail-TP never sees a price to close against. Seed a
     usable LTP from the resolved strike premium so entry is not blocked, then
     fetch candles once to subscribe the contract for live updates. */
  async function ensureOptionQuotes(targets, tf) {
    const SE = window.StratEngine;
    for (const tSym of targets) {
      if (!tSym || tSym.strike == null) continue;
      /* Only skip when a LIVE quote is already streaming. A stale REST
         snapshot entry (no live flag) must still trigger the candle fetch,
         because that fetch is what asks the server to WS-subscribe the
         contract - without it the strike never receives live ticks and the
         P&L display stays on "--" forever. */
      const have = quoteFor(tSym);
      if (have && have.live && have.ltp != null) continue;
      /* Otherwise fetch candles once so the server subscribes the contract for
         live updates. NOTE: the resolved premium is passed to
         PaperTrade.autoEntry as fallbackLtp for the ENTRY price - it is
         deliberately NOT written into the shared clientQuotes store, because a
         frozen, non-live quote there would be treated as a real price by the
         P&L display and by the auto SL / trail-TP (causing frozen P&L and
         sudden exits). */
      if (SE && SE.fetchCandlesFor) {
        try { await SE.fetchCandlesFor(tSym, tf); } catch (e) {}
      }
    }
  }

  async function candlesForInstrument(instr, tf) {
    /* REAL-TIME candle source for live strategy/filter evaluation - the REST
       /api/candles pool is NOT consulted here. During Dhan's chart-surface
       rate-limit cooldown (~30s) the pool serves a frozen snapshot of the last
       closed bar, so an option contract whose filter conditions had ALREADY met
       live on screen stayed on "Waiting entry signal" until the pool bar finally
       rolled - the 3-4 bar late entry. The series below is the SAME realtime
       data the user's chart shows:
         - the OPEN chart's own candles when this instrument IS the chart symbol
           at the chart timeframe (exact rendered lines, live quote-patched), or
         - the in-browser FastLive tick-built series (seeded once, then fed tick-
           by-tick by the /ws quote stream - the identical source that updates
           the charts), which is immune to the REST cooldown. */
    const chartMatch = (typeof window.currentChartSymKey === 'function' &&
      typeof selectedSymbol !== 'undefined' && selectedSymbol &&
      typeof chartTf !== 'undefined' && chartTf === tf &&
      window.IndChart && IndChart.getCandles &&
      String(selectedSymbol.id) === String(instr.kind === 'option' ? instr.sid : (instr.symbol && instr.symbol.id)));
    if (chartMatch) {
      /* Only use the chart's candles once its data actually belongs to this
         symbol+timeframe (IndChart.curSymKey) - while a newly selected chart is
         still loading, getCandles() would return the previous symbol's series. */
      const cc = (IndChart.curSymKey && window.currentChartSymKey() === IndChart.curSymKey) ? IndChart.getCandles() : null;
      if (cc && cc.length >= 10) return cc;
    }
    /* Ultrafast live feed: read the symbol's in-browser live candle series
       built from WebSocket ticks (initial history seeded once). No REST
       /api/candles call in the live path. The market-off SIM simulator streams
       its candles through /api/candles (not the /ws broadcast) and only injects
       a quote into clientQuotes, so FastLive would freeze on its seed bar -
       SIM instruments keep the REST fetch path instead. */
    const simEval = isSimSymbol(instr.symbol);
    if (state.fastData && window.FastLive && !simEval) {
      if (instr.kind === 'option') {
        const optSym = { id: Number(instr.sid), exch: optionExch(instr.symbol), inst: optionInst(instr.symbol), name: (instr.symbol.name || '') };
        try {
          const c = await FastLive.candlesFor(optSym, tf);
          if (c && c.length >= 10) {
            // Premium chart is back - resume premium evaluation/execution.
            delete _candleFbk[instrumentId(instr)];
            return c;
          }
        } catch (e) {}
        // Premium chart candles are unavailable (new/illiquid strike, feed gap).
        // Premium-only mode must NEVER downgrade to the underlying/spot chart: a
        // missing premium chart means the instrument is skipped until its premium
        // candles return, honouring the "run + trade on the premium chart only"
        // toggle instead of silently executing on the underlying.
        if (state.premiumOnly) {
          delete _candleFbk[instrumentId(instr)];
          return null;
        }
        // Fall back to the underlying/spot chart so the strategy still evaluates
        // its indicators and the trade still executes instead of the instrument
        // being skipped. Execution targets are switched to the underlying too.
        if (!_candleFbk[instrumentId(instr)]) log('Option premium candles unavailable for ' + displayName(instr.symbol) + ' - falling back to underlying chart', 'warn');
        _candleFbk[instrumentId(instr)] = 1;
      }
      if (instr.kind === 'both') {
        // Combined run-in instrument: the primary run chart is the underlying
        // spot chart; the premium confirmation series is fetched separately in
        // confirmCandlesFor().
        try {
          const c = await FastLive.candlesFor(instr.symbol, tf);
          return (c && c.length >= 10) ? c : null;
        } catch (e) { return null; }
      }
      try {
        const c = await FastLive.candlesFor(instr.symbol, tf);
        return (c && c.length >= 10) ? c : null;
      } catch (e) { return null; }
    }
    const SE = window.StratEngine;
    if (!SE || !SE.fetchCandlesFor) return null;
    if (instr.kind === 'option') {
      const optSym = { id: Number(instr.sid), exch: optionExch(instr.symbol), inst: optionInst(instr.symbol), name: (instr.symbol.name || '') };
      try {
        const c = await SE.fetchCandlesFor(optSym, tf);
        if (c && c.length >= 10) {
          // Premium chart is back - resume premium evaluation/execution.
          delete _candleFbk[instrumentId(instr)];
          return c;
        }
      } catch (e) {}
      // Premium chart candles are unavailable (new/illiquid strike, feed gap).
      // Premium-only mode must NEVER downgrade to the underlying/spot chart: a
      // missing premium chart means the instrument is skipped until its premium
      // candles return, honouring the "run + trade on the premium chart only"
      // toggle instead of silently executing on the underlying.
      if (state.premiumOnly) {
        delete _candleFbk[instrumentId(instr)];
        return null;
      }
      // Fall back to the underlying/spot chart so the strategy still evaluates
      // its indicators and the trade still executes instead of the instrument
      // being skipped. Execution targets are switched to the underlying too.
      if (!_candleFbk[instrumentId(instr)]) log('Option premium candles unavailable for ' + displayName(instr.symbol) + ' - falling back to underlying chart', 'warn');
      _candleFbk[instrumentId(instr)] = 1;
    }
    if (instr.kind === 'both') {
      // Combined run-in instrument: the primary run chart is the underlying
      // spot chart; the premium confirmation series is fetched separately in
      // confirmCandlesFor().
      try {
        const c = await SE.fetchCandlesFor(instr.symbol, tf);
        return (c && c.length >= 10) ? c : null;
      } catch (e) { return null; }
    }
    try {
      const c = await SE.fetchCandlesFor(instr.symbol, tf);
      return (c && c.length >= 10) ? c : null;
    } catch (e) { return null; }
  }

  /* Secondary confirmation series for a "both" run-in instrument: the first
     selected-strike option premium chart. Null when no contract or no option
     candles are available. */
  async function confirmCandlesFor(instr, tf, ci) {
    if (instr.kind !== 'both') return null;
    const c0 = (instr.contracts && instr.contracts.length) ? instr.contracts[ci || 0] : null;
    if (!c0) return null;
    const optSym = { id: Number(c0.sid), exch: optionExch(instr.symbol), inst: optionInst(instr.symbol), name: (instr.symbol.name || '') };
    /* Ultrafast live feed path: read the strike's in-browser live series. */
    if (state.fastData && window.FastLive) {
      try {
        const c = await FastLive.candlesFor(optSym, tf);
        return (c && c.length >= 10) ? c : null;
      } catch (e) { return null; }
    }
    const SE = window.StratEngine;
    if (!SE || !SE.fetchCandlesFor) return null;
    try {
      const c = await SE.fetchCandlesFor(optSym, tf);
      return (c && c.length >= 10) ? c : null;
    } catch (e) { return null; }
  }

  function pickTimeframe(s) {
    const tfs = (state.universal && state.universal.tfs) || { '1min': true, '5min': true };
    const enabled = ALL_TIMEFRAMES.filter(t => tfs[t] !== false);
    /* The strategy's OWN timeframe wins over the AST universal TF checkboxes:
       an imported strategy keeps running on the timeframe it was designed/tested
       on (the tf-mismatch conflict fix). Only when the strategy carries no
       usable tf does the AST enabled-TF list apply. The "Use AST settings"
       toggle (universal.astUseOwnSettings) flips this: when ON, AST's enabled
       timeframe checkboxes drive every strategy and the AE-defaulted strategy
       tf is ignored. */
    const ownTf = (state.universal && state.universal.astUseOwnSettings === true) ? '' : strategyOwnTf(s);
    if (ownTf) return ownTf;
    /* Strategies imported from the Paper Trade lists carry a reference-only
       timeframe (what the AE engine used) - AST ignores it and always runs on
       its own enabled timeframe settings basis. */
    const stf = (s && s.fromPaperTrade === true) ? '' : (s.tf || '');
    if (enabled.indexOf(stf) >= 0) return stf;
    if (enabled.length) return enabled[0];
    return '5min';
  }

  /* ---------------- time gates + trade budget ---------------- */
  function istDay() {
    const d = new Date(Date.now() + 5.5 * 3600 * 1000);
    return d.getUTCFullYear() + '-' + (d.getUTCMonth() + 1) + '-' + d.getUTCDate();
  }
  function timeToMin(str) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }
  function timeGateOk(minute, u) {
    if (!u) return true;
    if (u.startTradeAfterEnabled) {
      const s = timeToMin(u.startTradeAfter);
      if (s != null && minute < s) return false;
    }
    if (u.noTradeAfterEnabled) {
      const e = timeToMin(u.noTradeAfter);
      if (e != null && minute >= e) return false;
    }
    return true;
  }
  function liveTimeGateOk() {
    const now = new Date(Date.now() + 5.5 * 3600 * 1000);
    return timeGateOk(now.getUTCHours() * 60 + now.getUTCMinutes(), state.universal);
  }
  /* Unconditional NSE trading-session gate: no NEW paper entry may ever be
     placed while the exchange is closed, regardless of the optional start/no-
     trade toggles. Stale candles frozen after the 15:30 IST close (or before
     09:15, or on Sat/Sun) keep satisfying entry conditions, so without this
     hard gate the engine keeps "buying" after market hours on dead prices -
     those phantom fills corrupt the paper PnL. Open positions are untouched:
     they are still managed to their SL / TP / trail. Returns true only
     Mon-Fri between 09:15 and 15:30 IST. */
  function marketSessionOpen() {
    const now = new Date(Date.now() + 5.5 * 3600 * 1000);
    const day = now.getUTCDay();
    if (day === 0 || day === 6) return false;
    const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
    return minute >= 555 && minute < 930; // 09:15 .. 15:30 IST
  }
  /* One-shot "auto square off" gate: true only the first time the live IST clock
     reaches the configured square-off time on any given session day. The engine
     cuts every open position once, so a browser reload / long-running session
     never re-triggers the exit repeatedly for the same day. */
  let _autoSquareOffDoneDay = '';
  function autoSquareOffDue() {
    const u = state.universal;
    if (!u || !u.autoSquareOffEnabled) return false;
    const t = timeToMin(u.autoSquareOffTime);
    if (t == null) return false;
    const day = istDay();
    if (_autoSquareOffDoneDay === day) return false;
    const now = new Date(Date.now() + 5.5 * 3600 * 1000);
    const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
    if (minute >= t) { _autoSquareOffDoneDay = day; return true; }
    return false;
  }
  function resetTradeCountsIfNewDay() {
    const day = istDay();
    if (day !== state.tradeCountDay) {
      state.tradeCountDay = day;
      state.tradeCounts = {};
      clearFiredSignals();
    }
  }

  /* One-trade-per-signal latch: once a strategy+instrument signal has fired an
     entry, that same (still-true) condition may not fire another trade. The
     latch is released ONLY after an evaluation cycle observes the condition
     FALSE (the signal resets), so a stop-loss exit followed by an instant re-
     buy on the same persistent condition (the APLAPOLLO 2140 PE 24x churn) is
     blocked: each fresh condition-meeting arms exactly ONE new trade. An open
     position owned by the key keeps the latch armed while it is held, so a
     signal flip during the hold can never re-arm a re-entry at the exit moment
     - a released latch requires the signal to be observed false AFTER the close
     before a new meeting may trade again. */
  let _signalFired = {};
  function clearFiredSignals() { _signalFired = {}; }
  function firedSignal(key) { return _signalFired[key] === true; }
  function armFiredSignal(key) { _signalFired[key] = true; }
  function releaseFiredSignal(key) { if (_signalFired[key] === true) delete _signalFired[key]; }

  /* AI auto-trades decision (cached per newest candle). */
  const _aiTradesCache = { sig: '', dec: null };
  const _oiPrev = {};
  function liveOICtx(r) {
    let q = null;
    if (r && r.optionSid != null) {
      q = quoteCache()[String(r.optionSid)];
    } else if (r && r.symbol) {
      const s = r.symbol;
      q = quoteCache()[s.exch === 'IDX_I' ? 'IDX_I:' + s.id : String(s.id)];
    }
    const key = (r && r.optionSid != null) ? 'opt:' + r.optionSid
      : (r && r.symbol ? 'sym:' + r.symbol.id + ':' + (r.symbol.exch || '') : null);
    const oi = (q && q.oi != null) ? Number(q.oi) : null;
    const ctx = {};
    if (oi != null) {
      ctx.oi = oi;
      if (key && _oiPrev[key] != null) ctx.oiPrev = _oiPrev[key];
      if (key) _oiPrev[key] = oi;
    }
    return ctx;
  }
  function aiTradesDecisionFor(candles, ctx) {
    if (!candles || !candles.length || !window.AITradesEngine) return null;
    const last = candles[candles.length - 1];
    const sig = last.time + ':' + candles.length + ':' + ((ctx && ctx.oi != null) ? ctx.oi : '');
    if (_aiTradesCache.sig !== sig || !_aiTradesCache.dec) {
      const dec = window.AITradesEngine.decide(candles.slice(-120), true, ctx);
      _aiTradesCache.sig = sig;
      _aiTradesCache.dec = dec;
      updateAiTradesStatus(dec && dec.reasons && dec.reasons.length
        ? 'AI trades: unlimited · ' + ((dec.reasons || []).join(', '))
        : 'AI trades: unlimited');
    }
    return _aiTradesCache.dec;
  }

  function allowedTradesFor(s, instr, candles) {
    const u = state.universal;
    if (!liveTimeGateOk()) return 0;
    if (!marketSessionOpen()) return 0;
    if (u && u.aiTrades) {
      const r = { key: s.id, optionSid: instr.kind === 'option' ? instr.sid : null, symbol: instr.symbol };
      aiTradesDecisionFor(candles, liveOICtx(r));
      return null;
    }
    if (u && u.tradeLimitEnabled && Number(u.tradeLimitCount) > 0) return Number(u.tradeLimitCount);
    return null;
  }

  /* ---------------- HFT (ultrafast) execution mode ----------------
     Runs a separate synchronous scanner on its own timer (default 100ms)
     instead of the normal 1500ms poll. It only reads caches the poll keeps warm
     - StratEngine.candleCache for candles, _pickedStrikes for the resolved
     option strikes, clientQuotes for live LTPs - and evaluates every strategy's
     entry conditions synchronously on the cached bars + live quotes. A fresh
     signal is therefore caught and placed as a paper entry in under 2ms rather
     than waiting for the next poll cycle. The normal poll still manages the
     open positions (AI SL / trail TP) on its 1500ms cadence; the HFT loop only
     fires entries. */
  let _hftTimer = null;
  let _hftMs = 0;
  let _hftRunning = false;
  /* Which candle value (open/high/low/close) the HFT scanner evaluates strategy
     conditions against. Set synchronously for the duration of each hftScan; the
     normal 1500ms poll is unaffected (it reads null => per-condition key). */
  let _hftExecOn = null;

  /* Option leg (CE/PE) the engine should be trading for a symbol RIGHT NOW,
     using only synchronous signals (no async per-symbol trend call). Mirrors
     the side chain contractsFor() applies when auto-picking strikes, so the
     HFT scanner and the picked-strikes reconciler can enforce the same side the
     normal poll is resolving:
       indicator-filters run side (filter mode) -> NIFTY trend-following side ->
       the unanimous running-strategy category -> the single active
       indicator-filter direction -> the mover's own daily move.
     `stratDir` lets callers pass the precomputed running-strategy direction so
     it is not recomputed for every symbol in a loop. Returns null when no
     directional signal is live (callers then keep both legs, matching the
     default CE+PE resolution). */
   function optionSideFor(symbol, stratDir) {
     if (!symbol) return null;
     const nt = state.niftyTrend || {};
     const ntSide = (nt.enabled && (_lastNiftyDir === 'bullish' || _lastNiftyDir === 'bearish')) ? _lastNiftyDir : null;
     /* Mirror the contractsFor() leg precedence exactly (see there for why): in
        filter mode the ticked filter side wins; otherwise NIFTY-trend side, then
        the unanimous running-strategy category, then the ticked filter, and only
        then the symbol's own daily move. Keeps the HFT scanner / picked-strike
        reconciler trading the SAME leg the poll resolves. */
     const dir = state.filterMode
       ? (activeFilterDirection() || ntSide || moverDirectionFor(symbol) || (stratDir !== undefined ? stratDir : strategyDirectionFor()))
       : (ntSide || (stratDir !== undefined ? stratDir : strategyDirectionFor()) || activeFilterDirection() || moverDirectionFor(symbol));
     return dir === 'bullish' ? 'CE' : (dir === 'bearish' ? 'PE' : null);
   }

  /* Reconcile the picked-strikes map against the CURRENT run every tick: the
     "Picked Strikes" panel and the HFT scanner must only show / trade what the
     engine would resolve right now, never stale strikes accumulated since page
     load. Deletes entries whose symbol is no longer in the live universe (top
     movers / NIFTY trend-following / manual selection) and, whenever a side is
     currently known, entries still holding the OPPOSITE option leg (e.g. old CE
     picks left over from a bullish NIFTY phase after it flipped bearish). The
     next poll re-resolves only the matching side for surviving symbols. Open
     positions are never touched - they keep being managed to their SL/TP. */
  function reconcilePickedStrikes() {
    const cur = experimentSymbols();
    const curKeys = new Set();
    cur.forEach(s => curKeys.add(_pickedKey(s)));
    const stratDir = strategyDirectionFor();
    /* The poll resolves against the run-in override side when that override is
       active (Selected Strategies "Run Strategy In") - NOT the filter/trend
       chain. Mirror it here so records created by this tick's resolve are never
       judged stale by a side the resolve itself never produces (the filterMode
       ticked-filter bias vs auto NIFTY side mismatch). */
    const forcedSide = runInForcedSide();
    const stale = [];
    let legs = 0;
    _pickedStrikes.forEach((rec, k) => {
      if (!rec || !rec.symbol || !Array.isArray(rec.contracts) || !rec.contracts.length) {
        stale.push(k);
        if (rec && rec.contracts && rec.contracts.length) legs += rec.contracts.length;
        return;
      }
      if (!curKeys.has(k)) {
        stale.push(k);
        legs += rec.contracts.length;
        return;
      }
      const side = forcedSide || optionSideFor(rec.symbol, stratDir);
      /* Only a pick that holds NO matching-side contract is stale. A both-leg
         (CE+PE) record with the current side present must stay: deleting it here
         only makes the next resolveInstruments->contractsFor() re-add the same
         both-leg record on the very next poll, churning "removed N stale pick(s)"
         every tick. The wrong leg is filtered later at execution/HFT time. */
      if (side) {
        const hasSide = rec.contracts.some(c => c.optionType === side);
        const hasOpp = rec.contracts.some(c => c.optionType && c.optionType !== side);
        if (hasOpp && !hasSide) {
          stale.push(k);
          legs += rec.contracts.length;
        }
      }
    });
    if (stale.length) {
      const kinds = stale.map(k => {
        const r = _pickedStrikes.get(k);
        if (!r) return k;
        return displayName(r.symbol) + '[' + (r.contracts || []).map(c => c.optionType || '?').join('+') + ']';
      });
      stale.forEach(k => _pickedStrikes.delete(k));
      diag('pickedRecon', 20000, 'Picked strikes reconciled: removed ' + stale.length + ' stale pick(s) (' + legs + ' leg(s)) that no longer match the current universe / trend side' + (forcedSide ? ' (run side ' + forcedSide + ')' : '') + ' - old CE/PE picks will not be traded [' + kinds.join(', ') + ']', 'warn');
      _schedulePickedPersist();
    }
  }

  /* Instruments for the HFT scanner, built synchronously from the strikes the
     normal poll already resolved (_pickedStrikes). Symbols whose contracts have
     not been resolved yet are skipped this cycle (the poll warms them). When a
     directional side is currently live (NIFTY trend / mover / single-direction
     filter), only THAT side's contracts are used so the fast scanner can never
     fire on a stale opposite-side pick left in _pickedStrikes from an earlier
     trend. */
  function hftInstruments() {
    const syms = experimentSymbols();
    if (!syms.length) return [];
    const stratDir = strategyDirectionFor();
    /* Same run-in override side the poll resolves (see reconcilePickedStrikes):
       never filter the scanner's contracts against a side the resolve itself
       does not produce. */
    const forcedSide = runInForcedSide();
    const out = [];
    for (const sym of syms) {
      if (runInMode(sym) === 'spot') {
        out.push({ kind: 'underlying', symbol: sym });
        continue;
      }
      const rec = _pickedStrikes.get(_pickedKey(sym));
      let contracts = (rec && rec.contracts && rec.contracts.length) ? rec.contracts : null;
      const side = forcedSide || optionSideFor(sym, stratDir);
      if (contracts && side) {
        contracts = contracts.filter(c => c.optionType === side);
      }
      if (runInMode(sym) === 'both') {
        if (contracts && contracts.length) {
          /* Fastest-rising run: every top-N fastest-rising strike (of the live
             side) must be scanned + traded as its own instrument, matching the
             normal poll's fan-out. Off: the historical single combined
             spot+premium instrument is scanned. */
          if (state.strike && state.strike.fastestRising === true) {
            for (const c of contracts) out.push({ kind: 'option', symbol: sym, strike: c.strike, optionType: c.optionType, sid: c.sid, premium: c.premium });
          } else {
            out.push({ kind: 'both', symbol: sym, contracts });
          }
        }
        continue;
      }
      if (contracts && contracts.length) {
        for (const c of contracts) {
          out.push({ kind: 'option', symbol: sym, strike: c.strike, optionType: c.optionType, sid: c.sid, premium: c.premium });
        }
      }
    }
    return out;
  }

  function hftCandlesFor(instr, tf, SE) {
    const cache = (SE && SE.candleCache) || {};
    let key;
    if (instr.kind === 'option') {
      key = Number(instr.sid) + ':' + optionExch(instr.symbol) + ':' + tf + ':0';
    } else {
      const sym = instr.symbol;
      key = sym.id + ':' + (sym.exch || '') + ':' + tf + ':0';
    }
    const hit = cache[key];
    if (hit && hit.candles && hit.candles.length >= 10) {
      // Premium chart is back - resume premium evaluation/execution.
      delete _candleFbk[instrumentId(instr)];
      const optSym = (instr.kind === 'option') ? { id: Number(instr.sid), exch: optionExch(instr.symbol) } : instr.symbol;
      return (SE.liveBar ? SE.liveBar(hit.candles, optSym) : hit.candles);
    }
    // Premium-chart candles unavailable on the fast path: fall back to the
    // underlying/spot chart so the strategy still evaluates instead of the
    // instrument being skipped. Execution targets switch to the underlying too.
    // Premium-only mode overrides this: no premium candles means the instrument
    // is skipped until they return, never downgraded to the underlying.
    if (instr.kind === 'option') {
      if (state.premiumOnly) return null;
      if (!_candleFbk[instrumentId(instr)]) log('Option premium candles unavailable for ' + displayName(instr.symbol) + ' - falling back to underlying chart', 'warn');
      _candleFbk[instrumentId(instr)] = 1;
      const sym = instr.symbol;
      const sKey = sym.id + ':' + (sym.exch || '') + ':' + tf + ':0';
      const sHit = cache[sKey];
      return (sHit && sHit.candles && sHit.candles.length >= 10) ? (SE.liveBar ? SE.liveBar(sHit.candles, sym) : sHit.candles) : null;
    }
    return null;
  }

  function hftConfirmCandlesFor(instr, tf, SE) {
    if (instr.kind !== 'both') return null;
    const c0 = (instr.contracts && instr.contracts.length) ? instr.contracts[0] : null;
    if (!c0) return null;
    const cache = (SE && SE.candleCache) || {};
    const key = Number(c0.sid) + ':' + optionExch(instr.symbol) + ':' + tf + ':0';
    const hit = cache[key];
    const optSym = { id: Number(c0.sid), exch: optionExch(instr.symbol) };
    return (hit && hit.candles && hit.candles.length >= 10)
      ? (SE.liveBar ? SE.liveBar(hit.candles, optSym) : hit.candles)
      : null;
  }

  /* Execution targets per the "Trade should be executed in" setting, resolved
     synchronously from the instrument the scanner already holds (no async
     contract fetch on the fast path). */
  function hftTargetsFor(instr) {
    const sym = instr.symbol;
    if (!sym) return [];
    // Premium-chart candle fallback active: execute on the underlying so the
    // trade is not skipped while the premium chart has no candles. Premium-only
    // mode overrides this - execution stays on the premium chart only.
    if (!state.premiumOnly && _candleFbk[instrumentId(instr)]) return [sym];
    const tiMode = tradeInMode(sym);
    if (tiMode === 'spot') return [sym];
    if (instr.kind === 'option') {
      const optSym = { id: Number(instr.sid), exch: optionExch(sym), inst: optionInst(sym), name: (instr.symbol.name || instr.symbol.id) + ' ' + instr.strike + ' ' + instr.optionType, strike: instr.strike, optionType: instr.optionType, premium: instr.premium };
      return tiMode === 'both' ? [sym, optSym] : [optSym];
    }
    const c = (instr.contracts && instr.contracts.length) ? instr.contracts[0] : null;
    if (!c) return [];
    const optSym = { id: Number(c.sid), exch: optionExch(sym), inst: optionInst(sym), name: (sym.name || sym.id) + ' ' + c.strike + ' ' + c.optionType, strike: c.strike, optionType: c.optionType, premium: c.premium };
    return tiMode === 'both' ? [sym, optSym] : [optSym];
  }

  /* Orders-per-second budget: timestamps of every HFT paper order placed,
     used to throttle global order placement to the user's cap (Dhan allows
     ~6 orders/sec). The scanner itself runs fast (100ms) so decisions stay
     under 2ms, but order placement never exceeds the per-second budget. */
  let _hftOrderTimes = [];
  function hftOpsBudget() {
    const u = state.universal || {};
    const ops = Math.max(1, Math.min(30, Math.round(Number(u.hftOps) || 6)));
    const now = Date.now();
    _hftOrderTimes = _hftOrderTimes.filter(t => now - t < 1000);
    return { ops: ops, used: _hftOrderTimes.length, ok: _hftOrderTimes.length < ops };
  }
  function hftMarkOrder() {
    _hftOrderTimes.push(Date.now());
  }

  function hftScan() {
    if (!state.enabled) return;
    if (_hftRunning) return;
    _hftRunning = true;
    const t0 = performance.now();
    const u = state.universal || {};
    const prevExecOn = _hftExecOn;
    /* "execute on" enable checkbox: when ON (default) the scanner forces every
       candle-type strategy condition to be tested against the chosen candle
       value (open/high/low/close, default Candle Close). When OFF the override
       is disabled and each condition uses its own default candle key (same as
       the normal 1500ms poll). */
    _hftExecOn = (u.hftExecEnabled !== false) && ['open', 'high', 'low', 'close'].indexOf(u.hftExecOn) >= 0 ? u.hftExecOn : null;
    try {
    const pt = basePaper();
    const SE = window.StratEngine;
    if (!pt || !SE) return;
    resetTradeCountsIfNewDay();
    const ptState = pt.getState ? pt.getState() : null;
    const autoPositions = (ptState && ptState.autoPositions) || {};
    if (!(u && u.hft)) return;
      if (!liveTimeGateOk()) return;
      if (!marketSessionOpen()) return;
      const strategies = activeStrategies();
      if (!strategies.length) return;
      const instruments = hftInstruments();
      if (!instruments.length) return;
      cutStaleSideLegs(instruments, strategies);
      for (const s of strategies) {
        const working = workingStrategy(s);
        const tf = pickTimeframe(s);
        const mtf = (u.mtfConfirm === true) ? mtfPair() : null;
        const entryTf = mtf ? mtf.entry : tf;
        const trendTf = mtf ? mtf.trend : null;
        for (const instr of instruments) {
          const key = strategyKey(s, instr);
          const candles = hftCandlesFor(instr, entryTf, SE);
          if (!candles) continue;
          const tradeTargets = hftTargetsFor(instr);
          if (!tradeTargets.length) continue;
          let held = false;
          for (const tSym of tradeTargets) {
            if (autoPositions[posKeyOf(tSym)]) { held = true; break; }
          }
          if (held) continue;
          const allowed = allowedTradesFor(s, instr, candles);
          if (allowed != null && (state.tradeCounts[s.id] || 0) >= allowed) continue;
          /* Immediate chart-based execution: the strategy signal on the run
             chart fires the entry directly - no companion-chart confirmation
             wait. The fill itself happens at the live chart price. */
          const entryOk = mtf
            ? evalEntryMtfLive(working, candles, trendTf ? hftCandlesFor(instr, trendTf, SE) : null, key, instrumentName(instr))
            : evalEntryLive(working, candles, key, instrumentName(instr));
          if (!entryOk) {
            /* Signal reset observed while no position is held: release the
               one-trade-per-signal latch so the NEXT fresh meeting can arm. */
            releaseFiredSignal(key);
            continue;
          }
          /* One-trade-per-signal: this still-true condition already fired its
             trade - no re-entry until the signal resets and meets again. */
          if (firedSignal(key)) continue;
          const bbpBlock = bbpGateBlock(instr, tradeTargets);
          if (bbpBlock) continue;
          gridEvent('signal', { name: instrumentName(instr), strategy: s.name, key: key, dir: s.cat || '' });
          const side = 'BUY';
          let lotSize = u.lotSize != null ? Number(u.lotSize) : null;
          if (lotSize == null && pt.lotSizeFor) lotSize = pt.lotSizeFor(tradeTargets[0]);
          /* Strategy-owned risk: an imported strategy's own SL / trail SL (what
             the AE engine used) overrides the AST universal SL inputs so the
             strategy behaves as designed (the double-setting SL conflict fix).
             The "Use AST settings" toggle flips this: when ON, AST's universal
             SL / Trail SL inputs apply and the AE-defaulted strategy values are
             ignored. */
          const useAstOwn = (u.astUseOwnSettings === true);
          const ownSl = useAstOwn ? null : strategyOwnSl(s);
          const ownTrailSl = useAstOwn ? null : strategyOwnTrailSl(s);
          const manualSLOn = (u.manualSL === true) || ownSl != null;
          const manualTrailSLOn = (u.manualTrailSL === true) || ownTrailSl != null;
          const manualTrailTPOn = u.manualTrailTP === true;
          const manualTPOn = u.manualTP === true;
          const aiSlOn = !manualSLOn && !manualTrailSLOn && u.aiSl !== false;
          const aiTpOn = !manualTrailTPOn && u.aiTp !== false;
          const aiTPOn = !manualTPOn && u.aiTP !== false;
          const slPct = manualSLOn ? (ownSl != null ? ownSl : (Number(u.manualSLPct) || 0)) : (aiSlOn ? (s.autoSlPct != null ? s.autoSlPct : autoSLPct(candles)) : 0);
          const slTrailPct = manualTrailSLOn ? (ownTrailSl != null ? ownTrailSl : (Number(u.manualTrailSLPct) || 0)) : 0;
          const tpPct = manualTrailTPOn ? (Number(u.manualTrailTPPct) || 0) : (aiTpOn ? (u.manualTrail === false ? 1 : u.tpPct) : 0);
          const fixedTpPct = (u.rrEnabled === true && Number(u.rrValue) > 0 && slPct > 0)
            ? slPct * Number(u.rrValue)   // reward = risk x RR (overrides manual + AI TP)
            : (manualTPOn ? (Number(u.manualTPPct) || 0) : (aiTPOn ? aiTPPct(candles) : 0));
          if (manualSLOn && manualTrailSLOn) updateAiSlStatus('Overall SL ' + slPct.toFixed(2) + '% + Trail SL ' + slTrailPct.toFixed(2) + '%');
          else if (manualSLOn) updateAiSlStatus('Overall SL ' + slPct.toFixed(2) + '%');
          else if (manualTrailSLOn) updateAiSlStatus('Trail SL ' + slTrailPct.toFixed(2) + '%');
          else if (aiSlOn) updateAiSlStatus('AI SL ' + slPct.toFixed(2) + '%');
          else updateAiSlStatus('');
          if (manualTrailTPOn) updateAiTpStatus('Manual Trail TP ' + tpPct.toFixed(2) + '%');
          else if (aiTpOn) updateAiTpStatus('AI Trail TP on');
          else updateAiTpStatus('');
          if (u.rrEnabled === true && Number(u.rrValue) > 0 && slPct > 0) { updateAiTPStatus('Risk:Reward TP ' + fixedTpPct.toFixed(2) + '%'); updateRrStatus('Target RR ' + Number(u.rrValue) + ' x SL ' + slPct.toFixed(2) + '% = ' + fixedTpPct.toFixed(2) + '%'); }
          else if (manualTPOn) { updateAiTPStatus('Manual TP ' + fixedTpPct.toFixed(2) + '%'); updateRrStatus(''); }
          else if (aiTPOn) { updateAiTPStatus('AI TP ' + fixedTpPct.toFixed(2) + '%'); updateRrStatus(''); }
          else { updateAiTPStatus(''); updateRrStatus(''); }
          try { if (window.__astDiag !== false) log('TEMP-ENTRYDIAG hft ' + s.id + ' trailPct=' + slTrailPct + ' uPct=' + (Number(u.manualTrailSLPct) || 0) + ' inPct=' + (($id('astManualTrailSLPct') && $id('astManualTrailSLPct').value) || '') + ' mTrail=' + (u.manualTrailSL === true) + ' ownTr=' + (ownTrailSl == null ? '-' : ownTrailSl) + ' useOwn=' + (u.astUseOwnSettings === true)); } catch (e) {}
          let placedLegs = 0;
          for (const tSym of tradeTargets) {
            const pkey = posKeyOf(tSym);
            if (autoPositions[pkey]) continue;
            const budget = hftOpsBudget();
            if (!budget.ok) break;
            const sCap = strategyMarginCap(s);
            const ok = pt.autoEntry(side, { key: key, symbol: tSym, lotSize: lotSize, lots: u.lots, margin: (sCap > 0 ? sCap : u.margin), marginCap: sCap, tpPct: tpPct, slPct: slPct, slTrailPct: slTrailPct, fixedTpPct: fixedTpPct, fnoLimit: false, fallbackLtp: tSym.premium, autoTrail: (aiSlOn && slPct > 0) });
            if (ok) {
              placedLegs++;
              hftMarkOrder();
              const np = autoPositions[pkey];
              if (np) {
                state.positions[pkey] = {
                  strategyId: s.id, strategyName: s.name, cat: s.cat,
                  side: side, qty: np.qty, lotSize: np.lotSize, lots: np.lots, margin: np.margin,
                  entryPrice: np.entryPrice, peakPrice: np.entryPrice,
                  targetPct: np.targetPct, slPct: np.slPct,
                  slTrailPct: np.slTrailPct || 0, slTrailed: !!(np.slTrailed),
                  targetPrice: np.targetPrice, stopLoss: np.stopLoss,
                  orderType: np.orderType || 'MARKET', limitPrice: np.limitPrice || 0,
                  tpPct: np.tpPct || 0, tpPrice: np.tpPrice || 0,
                  instrumentName: np.symbol || instrumentName(instr),
                  symbol: np.symbol, symbolId: np.symbolId, symbolExch: np.symbolExch, inst: np.inst,
                  underId: underKeyOfInstr(instr),
                  underName: (instr && instr.symbol && (instr.symbol.name || instr.symbol.id)) || '',
                  optionType: optTypeOfLeg(np),
                  openedAt: Date.now()
                };
              }
              log('HFT auto ' + side + ' paper entry from "' + s.name + '" (' + instrumentName(instr) + ')', 'buy');
              gridEvent('entry', { name: np.symbol || instrumentName(instr), strategy: s.name, key: key, side: side, qty: np.qty, price: np.entryPrice });
            }
          }
          if (placedLegs) {
            state.tradeCounts[s.id] = (state.tradeCounts[s.id] || 0) + 1;
            setSettingsFor(s.id);
            armFiredSignal(key);
          }
        }
      }
      const dt = performance.now() - t0;
      const budget = hftOpsBudget();
      updateHftStatus('scan ' + dt.toFixed(3) + 'ms | ' + budget.used + '/' + budget.ops + ' orders/sec');
      if (dt > 2) diag('hftSlow', 15000, 'HFT scan took ' + dt.toFixed(1) + 'ms (>2ms)', 'warn');
    } finally {
      _hftExecOn = prevExecOn;
      _hftRunning = false;
    }
  }

  /* Start / stop the HFT timer and keep its input's disabled state in sync with
     the engine + master checkbox. Called from the universal readers/appliers on
     every settings change and engine toggle. The scanner runs at a fixed fast
     100ms cadence so decisions stay under 2ms; order placement is throttled to
     the user's orders-per-second budget (Dhan allows ~6/sec) inside hftScan. */
  function syncHftUI() {
    const u = state.universal || {};
    const hftOn = !!u.hft;
    const ms = 100;
    const opsEl = $id('astHftOps');
    if (opsEl) { opsEl.disabled = !hftOn; opsEl.style.opacity = hftOn ? '1' : '0.5'; }
    /* "execute on" enable checkbox + value select: both fade/disable when HFT is
       off; the value select additionally fades/disable when its enable checkbox
       is unchecked so the user sees the override is inactive. */
    const execCbEl = $id('astHftExecOnCb');
    if (execCbEl) { execCbEl.disabled = !hftOn; execCbEl.style.opacity = hftOn ? '1' : '0.5'; }
    const execEl = $id('astHftExecOn');
    const execOn = hftOn && u.hftExecEnabled !== false;
    if (execEl) { execEl.disabled = !execOn; execEl.style.opacity = execOn ? '1' : '0.5'; }
    if (hftOn && state.enabled && !_hftTimer) {
      _hftTimer = setInterval(hftScan, ms);
      _hftMs = ms;
      log('HFT mode: scanning every 100ms on cached candles + live quotes, throttled to ' + (Number(u.hftOps) || 6) + ' orders/sec', 'ok');
    } else if (hftOn && state.enabled && _hftTimer && ms !== _hftMs) {
      clearInterval(_hftTimer);
      _hftTimer = setInterval(hftScan, ms);
      _hftMs = ms;
    } else if ((!hftOn || !state.enabled) && _hftTimer) {
      clearInterval(_hftTimer);
      _hftTimer = null;
      _hftMs = 0;
      updateHftStatus('');
    }
  }

  /* ---------------- live condition evaluation ---------------- */
  const _sig = {};
  function signalFor(key) {
    if (!_sig[key]) _sig[key] = { lastEntryBar: null, prevExit: false };
    return _sig[key];
  }

  /* Builder-authored conditions can carry connector chains / gap / pane-movement
     gates that the flat evaluator (evalCondAt) does not model. Those keep using
     StratEngine's CrossDetector path; simpler flat conditions (the format the
     Auto Experiment engine emits) are evaluated with the same time-aligned
     alignedSeries path that backtested them, so imported/new strategies behave
     exactly like they did in the experiment. */
  function isComplexCond(cond) {
    if (!cond) return false;
    return !!((cond.chain && cond.chain.length) || cond.gap ||
      cond.paneConds || cond.paneCond || cond.paneMoves || cond.paneMove);
  }

  /* How many of the most recent bars to scan for a fresh entry signal. A cross /
     condition can land on the just-closed candle while the fetched series already
     carries a newer forming candle; scanning a small window catches the signal
     instead of letting it slip past between polls. */
  const ENTRY_LOOKBACK = 2;

  /* Whether the strategy's entry conditions fire at bar index `i` (no signal
     state mutation). `i` is normally the last (forming) bar, but the entry loop
     also probes the just-closed bar so a fresh cross is not missed. */
  /* Strict "all indicators & filters together" entry: the strategy's own
     conditions AND every extra condition / selected filter must ALL pass on the
     same bar - no N-of-M threshold, no partial pass. This is the "all together"
     mode the user enables from the Indicator filters toolbar. The primary
     (incl. chain/pane/gap) and candlestick gates still apply on top, so the
     entry only fires when the full set agrees. */
  function entryFireAllInOne(s, candles, i) {
    let condOk = true;
    if (s.entry) {
      /* Indicator-filters mode carries ALL selected filter conditions as an
         array in the primary entry - every one of them must pass (strict AND). */
      if (Array.isArray(s.entry)) {
        condOk = s.entry.length ? evalCondAll(s.entry, i, candles) : false;
      } else if (s.entry.indId) {
        if (isComplexCond(s.entry)) {
          condOk = (i === candles.length - 1 && window.StratEngine)
            ? !!StratEngine.evalCondEdge(s.entry, candles, null)
            : false;
        } else {
          condOk = evalCondAll(s.entry, i, candles);
        }
      }
    }
    let gapOk = true;
    if (i === candles.length - 1 && s.entry && !Array.isArray(s.entry) && s.entry.gap && s.entry.gap.enabled && window.StratEngine) {
      gapOk = StratEngine.evalGap(s.entry.gap, candles) !== false;
    }
    const extraOk = (s.entryExtra && s.entryExtra.length)
      ? evalCondAll(s.entryExtra, i, candles)
      : true;
    const patternOk = (!s.candlestick || !s.candlestick.entry || !s.candlestick.entry.length)
      ? true : patternHitAt(s.candlestick.entry, i, candles);
    return condOk && gapOk && extraOk && patternOk;
  }

  function entryFireAt(s, candles, i) {
    /* "All indicators & filters together" mode replaces the N-of-M entry path.
       Indicator-filters-mode strategies ALWAYS evaluate strict AND - the user
       explicitly chose "All together (strict AND)" when starting that mode. */
    if (state.allInOne || s._filterBuilt) return entryFireAllInOne(s, candles, i);
    let condOk = true;
    if (s.entry) {
      if (Array.isArray(s.entry)) {
        condOk = s.entry.length ? evalCondAll(s.entry, i, candles) : false;
      } else if (s.entry.indId) {
        if (isComplexCond(s.entry)) {
          condOk = (i === candles.length - 1 && window.StratEngine)
            ? !!StratEngine.evalCondEdge(s.entry, candles, null)
            : false;
        } else {
          condOk = evalCondAll(s.entry, i, candles);
        }
      }
    }
    let gapOk = true;
    if (i === candles.length - 1 && s.entry && !Array.isArray(s.entry) && s.entry.gap && s.entry.gap.enabled && window.StratEngine) {
      gapOk = StratEngine.evalGap(s.entry.gap, candles) !== false;
    }
    const extraOk = (s.entryExtra && s.entryExtra.length)
      ? evalCondNof(s.entryExtra, (s.entryThreshold != null && s.entryThreshold >= 1) ? s.entryThreshold : s.entryExtra.length, i, candles)
      : true;
    const patternOk = (!s.candlestick || !s.candlestick.entry || !s.candlestick.entry.length)
      ? true : patternHitAt(s.candlestick.entry, i, candles);
    return condOk && gapOk && extraOk && patternOk;
  }

  function entryFireState(s, candles) {
    return entryFireAt(s, candles, candles.length - 1);
  }

  /* Throttled diagnostic for a strategy that stays on "Waiting entry signal":
     log the last-bar indicator values + comparator and the pass/fail of each
     entry sub-condition so the reason the signal does not fire is visible in
     the AI Smart log instead of only a generic "waiting". */
  const _sigDiag = {};
  function signalDiag(s, candles, key, label) {
    if (!candles || !candles.length) return;
    const now = Date.now();
    if (_sigDiag[key] && now - _sigDiag[key] < 20000) return;
    _sigDiag[key] = now;
    const i = candles.length - 1;
    const c = candles[i];
    const d = new Date((c && c.time ? c.time : 0) * 1000);
    const tstr = d.getUTCHours() + ':' + String(d.getUTCMinutes()).padStart(2, '0') + ':' + String(d.getUTCSeconds()).padStart(2, '0');
    const parts = [];
    if (s.entry && !isComplexCond(s.entry)) {
      const list = Array.isArray(s.entry) ? s.entry : [s.entry];
      for (const cnd of list) {
        const ok = evalCondAt(cnd, i, candles);
        const prim = readTwo(cnd.indId, cnd.indSettings, cnd.valueKey, i, candles);
        const cmp = cmpReadAt(cnd, i, candles);
        const v = (v) => v == null || isNaN(v) ? '--' : Math.round(v * 10000) / 10000;
        let extra = '';
        if (cnd.logic === 'volUp' || cnd.logic === 'volDown') {
          const vsv = volumeSeries(candles);
          let hv = false;
          for (let j = Math.max(0, i - 6); j <= i; j++) { const vv = vsv[j]; if (vv != null && !isNaN(vv) && vv > 0) { hv = true; break; } }
          if (!hv) extra = ' no-vol-data';
        }
        parts.push((ok ? 'PASS' : 'FAIL') + ' ' + (cnd.indId || '?') + ' ' + (cnd.logic || '?') +
          ' [' + v(prim.last) + (prim.prev != null ? ' /' + v(prim.prev) : '') + ' vs ' +
          (cnd.cmpType === 'number' ? String(cnd.number) : (cnd.cmpType || '?') + ' ' + v(cmp.last)) + ']' + extra);
      }
    }
    if (s.entryExtra && s.entryExtra.length) {
      parts.push('extra[' + s.entryExtra.length + '] ' + (state.allInOne ? 'ALL' : 'need>=' + ((s.entryThreshold != null && s.entryThreshold >= 1) ? s.entryThreshold : s.entryExtra.length)));
    }
    log('Signal diag "' + s.name + '"' + (label ? ' [' + label + ']' : '') + ' @ ' + tstr + ' lastClose=' + (c ? c.close : '--') +
      ' -> ' + (parts.length ? parts.join(' | ') : 'no primary cond') +
      ' | gap=' + !!(s.entry && s.entry.gap && s.entry.gap.enabled) +
      ' | pattern=' + !!(s.candlestick && s.candlestick.entry && s.candlestick.entry.length) +
      ' | complex=' + !!(s.entry && isComplexCond(s.entry)), 'warn');
  }

  /* Fire a trade on a fresh entry signal. Unlike the old one-shot boolean latch
     (which only fired on a strict false->true edge and then had to be manually
     reset), this re-arms on every new bar: it scans the most recent bars for the
     entry condition and fires once per bar it finds it on. That lets a strategy
     keep trading throughout the day - every new entry signal opens a new
     position instead of firing only once and then stalling. */
  function freshEntry(s, candles, key) {
    const sig = signalFor(key);
    const n = candles.length;
    for (let k = 1; k <= ENTRY_LOOKBACK && k <= n; k++) {
      const i = n - k;
      if (entryFireAt(s, candles, i)) {
        const bar = candles[i] ? candles[i].time : null;
        if (bar != null && sig.lastEntryBar === bar) return false; // already fired for this bar
        sig.lastEntryBar = bar;
        return true;
      }
    }
    return false;
  }

  function evalEntryLive(s, candles, key, label) {
    const ok = freshEntry(s, candles, key);
    if (!ok) signalDiag(s, candles, key, label);
    return ok;
  }

  /* "Strategy should be run in" = Both: the strategy must fire the entry on the
     primary run chart AND on the companion chart (spot + selected-strike option
     premium). Only when both charts confirm the same trend/movement does the
     trade decision become actionable. */
  function evalEntryBothLive(s, primary, confirm, key, label) {
    const sig = signalFor(key);
    const pn = primary.length;
    const cn = confirm ? confirm.length : 0;
    for (let k = 1; k <= ENTRY_LOOKBACK; k++) {
      const pi = pn - k;
      const ci = cn - k;
      if (pi < 0 || ci < 0) continue;
      if (entryFireAt(s, primary, pi) && entryFireAt(s, confirm, ci)) {
        const bar = primary[pi] ? primary[pi].time : null;
        if (bar != null && sig.lastEntryBar === bar) return false;
        sig.lastEntryBar = bar;
        return true;
      }
    }
    signalDiag(s, primary, key, label);
    return false;
  }

  /* Multi-timeframe confirmation: the strategy is analyzed on BOTH enabled
     timeframes and only executes when they agree. The higher timeframe (5 min)
     acts as the trend/confirmation gate - the entry condition must be active on
     it within the recent window - while the lower timeframe (1 min) supplies the
     precise entry trigger. A trade fires only when the lower-TF signal lands
     while the higher TF is confirming the same condition, filtering out
     single-timeframe noise entries. */
  function evalEntryMtfLive(s, entryCandles, trendCandles, key, label) {
    if (!entryCandles || !trendCandles || entryCandles.length < 10 || trendCandles.length < 10) return false;
    const tn = trendCandles.length;
    let trendOk = false;
    for (let k = 1; k <= ENTRY_LOOKBACK && k <= tn; k++) {
      if (entryFireAt(s, trendCandles, tn - k)) { trendOk = true; break; }
    }
    if (!trendOk) { signalDiag(s, entryCandles, key, label); return false; }
    return freshEntry(s, entryCandles, key);
  }

  /* Timeframe pair used by the multi-TF confirmation: the enabled lower TF is
     the entry trigger, the enabled higher TF is the trend confirmation gate. */
  function mtfPair() {
    const tfs = (state.universal && state.universal.tfs) || { '1min': true, '5min': true };
    const enabled = ALL_TIMEFRAMES.filter(t => tfs[t] !== false);
    if (enabled.length < 2) return null;
    const entry = enabled[enabled.length - 1] === '5min' ? '1min' : enabled[0];
    const trend = enabled.indexOf('5min') >= 0 ? '5min' : enabled[enabled.length - 1];
    if (entry === trend) return null;
    return { entry, trend };
  }

  /* ---------------- live trading loop ---------------- */
  let _pollTimer = null;
  let _runningTick = false;
  /* Incremented by stopAllStrategies so an in-flight poll (which already passed
     the enabled gate) can detect that Close All ran mid-evaluation and abort
     before placing a fresh trade. */
  let _stopGen = 0;

  /* Throttled diagnostic logging so silent skip reasons are visible (once per
     key per interval) without flooding the log on every poll. */
  const _diag = {};
  function diag(key, ms, msg, cls) {
    const now = Date.now();
    if (_diag[key] && now - _diag[key] < ms) return;
    _diag[key] = now;
    log(msg, cls || 'warn');
  }

  /* Live pipeline progress for a running strategy, surfaced on its row in the
     Running Strategies view. `pct` is the furthest stage reached in the last
     tick's entry pipeline and `status` the human-readable reason it stopped
     there (waiting signal, blocked by a gate, entry rejected, entry placed). */
  const _astProg = state.runProgress || (state.runProgress = {});
  function prog(id, pct, status) {
    if (id == null) return;
    _astProg[id] = { pct: Math.max(0, Math.min(100, Math.round(pct))), status: String(status || ''), updated: Date.now() };
  }

  /* TRUE only when the user explicitly un-ticked the "Ultrafast Live Feed"
     checkbox during a run. Until the next run start this is respected - the
     engine will NOT fight the user and re-enable the feed mid-run. */
  let _userFastDataOff = false;
  /* Live evaluation must read ONLY realtime candle data (the same /ws-fed
     series the user's charts show), never the REST /api/candles pool: during
     Dhan's chart rate-limit cooldown (~30s) the pool serves a frozen snapshot
     of the last closed bar, which is what delayed entries by 3-4 bars even
     though the condition had already met live on the premium chart. So the
     moment any evaluation pass runs, the Ultrafast Live Feed is switched ON
     automatically (the checkbox reflects it). Un-ticking it mid-run is honoured
     via _userFastDataOff until the next run start. */
  function forceFastLiveForRun() {
    if (state.fastData === true) return;
    if (_userFastDataOff) return;
    if (!window.FastLive || !FastLive.setEnabled) return;
    state.fastData = true;
    try { if (FastLive.reset) FastLive.reset(); } catch (e) {}
    try { FastLive.setEnabled(true); } catch (e) {}
    save();
    log('Ultrafast live feed auto-ON for this run - strategies evaluate realtime in-browser candles only (REST /api/candles pool no longer drives entries)', 'ok');
  }

  /* One full strategy evaluation pass over the enabled strategies. Called by
     tick() directly, or once per selected engine template when the auto
     strategy sender is ON (each template's saved settings are applied silently
     before the pass and restored after). */
  async function tickBody(force) {
    const stopGen = _stopGen;
    const t0 = performance.now();
    try {
      forceFastLiveForRun();
      resetTradeCountsIfNewDay();
      const pt = basePaper();
      const SE = window.StratEngine;
      if (!pt || !SE) return;
      const ptState = pt.getState ? pt.getState() : null;
      const autoPositions = (ptState && ptState.autoPositions) || {};
      const paper = (window.AutoExperiment && AutoExperiment.paper) ? AutoExperiment.paper : null;
      const u = state.universal;

      if (!(u && u.aiTp !== false)) { updateAiTpStatus(''); updateAiTPStatus(''); }
      if (!(u && u.rrEnabled === true)) updateRrStatus('');
      if (!(u && u.aiSl !== false)) updateAiSlStatus('');

      /* Auto square-off: at the configured IST time cut EVERY open paper
         position regardless of how it was opened (manual chart position, auto
         positions opened by this engine, other engines, or the AI Paper Trade
         ledger), then remember the day so it fires once per session day. */
      if (autoSquareOffDue()) {
        let closed = 0;
      /* Closes the manual chart position + every auto position. */
      if (pt && pt.closeAllPositions) closed += pt.closeAllPositions('Auto square-off');
      /* Drop shared trail engines + clear this engine's mirror ledger. */
        const keys = Object.keys(state.positions);
        keys.forEach(k => {
          if (paper) { if (paper.dropTrailEngine) paper.dropTrailEngine(k); if (paper.dropAiTrailEngine) paper.dropAiTrailEngine(k); }
          if (state.positions[k]) recordClosedPosition(state.positions[k]);
          delete state.positions[k];
        });
        if (closed) {
          log('Auto square off: cut ' + closed + ' open position(s) at ' + (u && u.autoSquareOffTime ? u.autoSquareOffTime : '') + ' IST', 'warn');
        }
        save();
        render();
      }

      const filterMode = state.filterMode === true;
      /* Indicator-filters mode has its own strategy set: ONE synthetic strategy
         whose primary entry carries all selected filter conditions (strict AND)
         across the whole selected universe. Normal mode runs the ticked
         strategies as usual. */
      const strategies = filterMode ? filterModeStrategies() : activeStrategies();
      if (!strategies.length) {
        if (filterMode) {
          diag('noStrategies', 15000, 'Indicator-filters mode: no tradable symbol for the selected filter side(s) - tick at least one Bullish/Bearish indicator filter and enable a universe (Top Movers / NIFTY trend / chart symbol)', 'warn');
        } else {
          diag('noStrategies', 15000, 'No strategies ticked - tick at least one saved/imported/AI strategy to run it in paper mode', 'warn');
        }
        return;
      }

      // NIFTY market conditions (bias readout + trend-following pick direction)
      // are evaluated once per tick. NIFTY is fetched BEFORE instruments so the
      // trend-following symbol picker can build its F&O stock set from the
      // current NIFTY direction.
      const nifty = await niftyBias();
      if (nifty) await refreshConfirmedNifty(nifty);
      updateNiftyBiasStatus(nifty);

      // NIFTY trend-following per-tick removal: a picked F&O stock whose daily
      // change% has dropped below the threshold (or no longer moves on the
      // active NIFTY side) leaves the active pick set immediately (it stops
      // getting NEW entries because the universe below no longer resolves it).
      // Any position ALREADY OPEN on that symbol is deliberately NOT force-
      // exited: it keeps running and is closed by its own stop-loss / trail /
      // take-profit (managed every quote tick by the paper engine), so a live
      // NIFTY reversal or stock drop never cuts a running trade short.
      if (state.niftyTrend && state.niftyTrend.enabled && state.positions) {
        const tDir = nifty ? niftyOperativeDir(nifty) : null;
        if (tDir === 'bullish' || tDir === 'bearish') {
          const nt = state.niftyTrend;
          const tThresh = (Number(nt.pct) > 0) ? Number(nt.pct) : 2.5;
          const qm = (typeof clientQuotes !== 'undefined' && clientQuotes) ? clientQuotes : {};
          const idxSet = {};
          if (nt.includeIndices && Array.isArray(nt.indices)) {
            nt.indices.forEach(s => { idxSet[String(s.id) + ':' + (s.exch || '')] = true; });
          }
          const notQualify = Object.keys(state.positions).filter(k => {
            const p = state.positions[k];
            if (!p) return false;
            if (p.symbolExch === 'IDX_I' || idxSet[k] || idxSet[String(p.symbolId) + ':' + (p.symbolExch || '')]) return false;
            const q = qm[p.symbolExch === 'IDX_I' ? 'IDX_I:' + p.symbolId : String(p.symbolId)];
            if (!q || q.change_pct === undefined) return false;
            const pct = Number(q.change_pct);
            if (isNaN(pct)) return false;
            if (tDir === 'bullish') return pct < tThresh;
            return pct > -tThresh;
          });
          notQualify.forEach(k => {
            const now = Date.now();
            if (_trendDropLogAt[k] != null && (now - _trendDropLogAt[k]) < 5 * 60 * 1000) return;
            _trendDropLogAt[k] = now;
            const p = state.positions[k];
            const nm = (p && (p.instrumentName || p.symbol)) || k;
            log('NIFTY trend-following: ' + nm + ' no longer qualifies (needs ' + (tDir === 'bullish' ? '>= +' : '<= -') + tThresh + '% daily, NIFTY ' + tDir + ') - stopped from NEW entries; its open trade continues to its SL/TP', 'warn');
          });
        }
      }

      /* Picked-strike reconciliation: drop picks whose symbol left the live
         universe or whose option leg no longer matches the current trend side,
         so neither the Picked Strikes panel nor the HFT scanner keeps stale
         CE/PE strikes around after NIFTY flips direction. */
      reconcilePickedStrikes();

      /* Global "Run Strategy In" override (Selected Strategies section): when
         enabled every selected strategy runs on the option premium chart of
         ONLY the chosen side (manual CE/PE, or auto-picked from the NIFTY
         trend / top gainers-losers) for every symbol in the selected universe. */
      let instruments;
      const rsiCfg = runStrategyInConfig();
      try {
        instruments = rsiCfg.enabled
          ? await resolveInstruments(effectiveRunInSide(null, rsiCfg))
          : await resolveInstruments();
      } catch (e) { instruments = []; }
      _lastInstruments = instruments;
      if (!instruments.length) {
        diag('noInstruments', 15000, 'No tradeable instruments resolved - open a chart symbol, enable Top Movers, or enable NIFTY trend-following', 'warn');
        return;
      }

      /* Side-flip cleanup: after instruments/strategies are resolved this pass,
         actively cut stale open legs whose option side no longer matches the
         side their strategy trades now (NIFTY / filter direction flip), so
         pre-flip Running Trades rows never get stuck. */
      cutStaleSideLegs(instruments, strategies);

      let placedTotal = 0;
      const _newBucket = () => ({ candles: 0, targets: 0, nifty: 0, limit: 0, confirm: 0, signal: 0, bbp: 0 });
      const skips = { idx: _newBucket(), fno: _newBucket() };
      const bump = (instr, reason) => { const b = skips[isIndex(instr.symbol) ? 'idx' : 'fno']; if (b) b[reason]++; };

      for (const s of strategies) {
        const st0 = performance.now();
        const working = workingStrategy(s);
        const tf = pickTimeframe(s);
        const mtf = (u.mtfConfirm === true) ? mtfPair() : null;
        const entryTf = mtf ? mtf.entry : tf;
        const trendTf = mtf ? mtf.trend : null;

        for (const instr of instruments) {
          const key = strategyKey(s, instr);
          /* Indicator-filters mode runs ONE synthetic strategy across the whole
             selected universe (no per-symbol binding), so every instrument's
             chart is evaluated against all selected filters together. */
          if (s._bindSym) {
            const isym = instr.symbol;
            if (!isym || String(isym.id) + ':' + (isym.exch || '') !== s._bindSym) continue;
            if (instr.kind === 'option' && ((instr.optionType === 'CE') !== (s.cat !== 'bearish'))) continue;
          }
          const candles = await candlesForInstrument(instr, entryTf);
          if (!candles || candles.length < 10) { prog(s.id, 5, 'Waiting candles'); bump(instr, 'candles'); continue; }
          const trendCandles = trendTf ? await candlesForInstrument(instr, trendTf) : null;

          /* The entry DECISION runs on the real-time chart candles only: the
             option chain is not fetched and no REST quote/candle subscription
             happens while the engine is waiting for / analysing a signal. Those
             two steps are deferred until a fresh signal actually fires, just
             before the order is placed (below). A condition that meets on the
             chart therefore gets placed on the next poll without waiting on
             chain resolution. */
          // Immediate chart-based execution: a strategy signal on the run chart
          // fires the entry directly - the companion-chart confirmation wait is
          // removed. The fill happens at the live chart price.

          // Manage any open legs of this strategy+instrument (autoKey === key)
          // before considering a new entry - decided purely from the paper
          // engine's own positions, never from a chain fetch. While a position
          // of ours is open its signal episode stays latched, so an SL/TP exit
          // cannot be followed by an instant re-buy on the same still-true
          // condition.
          let anyOpen = false;
          for (const pkey of Object.keys(autoPositions)) {
            const open = autoPositions[pkey];
            if (!open) continue;
            if (String(open.autoKey || '') !== key) continue; /* owned by another engine / manual trade */
            anyOpen = true;
            /* An open position on this instrument means this signal episode has
               already been used - keep the one-trade-per-signal latch armed so a
               stop/TP exit cannot be followed by an instant re-buy while the
               same condition is still true. */
            armFiredSignal(key);
            /* Holding this instrument via this strategy: manage the exit. */
            const myPos = state.positions[pkey];
            const aside = open.side === 'BUY' ? 'long' : 'short';
            const baseTp = (u.manualTrail !== false && Number(u.tpPct) > 0) ? Number(u.tpPct) : 1;
            // Manual Trail TP (profit taking) - overrides the AI. When ticked,
            // the trail is a fixed manual % of the running profit: the position
            // rides the peak and exits once the profit gives back that % from
            // the peak. No AI / rule-based trail engine runs in this mode.
            // AI Trail TP (profit taking) - master-gated by the AI Trail TP
            // checkbox. AI decides the trail% live (profit-maximizing). When
            // OFF the trailing TP is disabled (targetPct 0) so only SL and the
            // fixed TP close the position.
            if (u.manualTrailTP === true) {
              open.targetPct = Number(u.manualTrailTPPct) || 0;
              if (myPos) { const pf = open.side === 'BUY' ? (open.peakPrice - open.entryPrice) : (open.entryPrice - open.peakPrice); myPos.targetPct = open.targetPct; myPos.targetPrice = open.side === 'BUY' ? open.entryPrice + pf * (1 - open.targetPct / 100) : open.entryPrice - pf * (1 - open.targetPct / 100); }
              if (paper) { if (paper.dropTrailEngine) paper.dropTrailEngine(pkey); if (paper.dropAiTrailEngine) paper.dropAiTrailEngine(pkey); }
              updateAiTpStatus('Manual Trail TP ' + open.targetPct + '%');
            } else if (u.aiTp !== false) {
              if (window.AiTrailEngine && paper && paper.aiTrailEngineFor) {
                try {
                  const eng = paper.aiTrailEngineFor(pkey, aside, baseTp, candles);
                  if (eng) {
                    const t = eng.trail();
                    if (t && t.pct > 0) {
                      open.targetPct = Math.round(t.pct * 1000) / 1000;
                      if (myPos) { const pf = open.side === 'BUY' ? (open.peakPrice - open.entryPrice) : (open.entryPrice - open.peakPrice); myPos.targetPct = open.targetPct; myPos.targetPrice = open.side === 'BUY' ? open.entryPrice + pf * (1 - open.targetPct / 100) : open.entryPrice - pf * (1 - open.targetPct / 100); }
                    }
                    updateAiTpStatus(t && t.reasons && t.reasons.length
                      ? 'AI Trail TP ' + t.pct.toFixed(2) + '% · ' + t.reasons.join(', ')
                      : 'AI Trail TP ' + (t ? t.pct.toFixed(2) : '?') + '%');
                  }
                } catch (e) {}
              }
            } else {
              open.targetPct = 0;
              if (myPos) { myPos.targetPct = 0; }
              if (paper) { if (paper.dropTrailEngine) paper.dropTrailEngine(pkey); if (paper.dropAiTrailEngine) paper.dropAiTrailEngine(pkey); }
              updateAiTpStatus('');
            }
          }
          if (anyOpen) { prog(s.id, 50, 'Managing open position'); continue; }

          if (!marketSessionOpen()) { prog(s.id, 53, 'Blocked: NSE market closed (09:15-15:30 IST) - no new entries'); continue; }

          const allowed = allowedTradesFor(s, instr, candles);
          if (allowed != null && (state.tradeCounts[s.id] || 0) >= allowed) { prog(s.id, 60, 'Blocked: trade limit reached'); bump(instr, 'limit'); continue; }

          const entryOk = mtf ? evalEntryMtfLive(working, candles, trendCandles, key, instrumentName(instr)) : evalEntryLive(working, candles, key, instrumentName(instr));
          if (!entryOk) {
            /* Signal reset observed while no position is held: release the
               one-trade-per-signal latch so the NEXT fresh meeting can arm. */
            releaseFiredSignal(key);
            prog(s.id, 70, mtf ? 'Waiting MTF confirmation' : 'Waiting entry signal'); bump(instr, 'signal'); continue;
          }
          /* One-trade-per-signal: this still-true condition already fired its
             trade - no re-entry until the signal resets and meets again. */
          if (firedSignal(key)) { prog(s.id, 72, 'One trade per signal - same condition still active, waiting for a fresh signal'); bump(instr, 'signal'); continue; }
          /* A fresh signal wants to trade - NOW resolve the execution leg(s).
             The option chain is consulted only here, to place the order; it is
             never needed to analyse. The quote/candle subscription runs at the
             same point so a wait on it can never delay a signal that is still
             building on the chart. */
          const tradeTargets = await executionSymbolsFor(instr, s);
          if (!tradeTargets.length) {
            if (chainRateLimited(instr.symbol)) prog(s.id, 15, 'Option chain rate-limited - retrying in ~' + _CHAIN_RL_SEC + 's');
            else prog(s.id, 15, 'No execution target (option chain unavailable)');
            bump(instr, 'targets'); continue;
          }
          await ensureOptionQuotes(tradeTargets, entryTf);
          prog(s.id, 30, 'Execution target ready');
          const bbpBlock = bbpGateBlock(instr, tradeTargets);
          if (bbpBlock) { prog(s.id, 77, bbpBlock); bump(instr, 'bbp'); continue; }
          gridEvent('signal', { name: instrumentName(instr), strategy: s.name, key: key, dir: s.cat || '' });
          prog(s.id, 90, 'Placing entry');

          const side = 'BUY'; // buy-only engine: bearish strategies analyze the bearish trend but always execute BUY
          let lotSize = u.lotSize != null ? Number(u.lotSize) : null;
          if (lotSize == null && pt.lotSizeFor) lotSize = pt.lotSizeFor(tradeTargets[0]);
          // AI-decided risk management, applied together on EVERY trade:
          //  - AI Stop-Loss protects capital (ATR hunting-aware).
          //  - AI Trail TP banks profit (profit-maximizing trailing TP).
          //  - AI TP % is a fixed take-profit off entry (volatility-scaled).
          // All are master-gated by their own checkboxes (aiSl / aiTp / aiTP).
          /* Strategy-owned risk: an imported strategy's own SL / trail SL (what
             the AE engine used) overrides the AST universal SL inputs so the
             strategy behaves as designed (the double-setting SL conflict fix).
             The "Use AST settings" toggle flips this: when ON, AST's universal
             SL / Trail SL inputs apply and the AE-defaulted strategy values are
             ignored. */
          const useAstOwn = (u.astUseOwnSettings === true);
          const ownSl = useAstOwn ? null : strategyOwnSl(s);
          const ownTrailSl = useAstOwn ? null : strategyOwnTrailSl(s);
          const manualSLOn = (u.manualSL === true) || ownSl != null;
          const manualTrailSLOn = (u.manualTrailSL === true) || ownTrailSl != null;
          const manualTrailTPOn = u.manualTrailTP === true;
          const manualTPOn = u.manualTP === true;
          const aiSlOn = !manualSLOn && !manualTrailSLOn && u.aiSl !== false;
          const aiTpOn = !manualTrailTPOn && u.aiTp !== false;
          const aiTPOn = !manualTPOn && u.aiTP !== false;
          const slPct = manualSLOn ? (ownSl != null ? ownSl : (Number(u.manualSLPct) || 0)) : (aiSlOn ? (s.autoSlPct != null ? s.autoSlPct : autoSLPct(candles)) : 0);
          const slTrailPct = manualTrailSLOn ? (ownTrailSl != null ? ownTrailSl : (Number(u.manualTrailSLPct) || 0)) : 0;
          const tpPct = manualTrailTPOn ? (Number(u.manualTrailTPPct) || 0) : (aiTpOn ? (u.manualTrail === false ? 1 : u.tpPct) : 0);
          const fixedTpPct = (u.rrEnabled === true && Number(u.rrValue) > 0 && slPct > 0)
            ? slPct * Number(u.rrValue)   // reward = risk x RR (overrides manual + AI TP)
            : (manualTPOn ? (Number(u.manualTPPct) || 0) : (aiTPOn ? aiTPPct(candles) : 0));
          if (manualSLOn && manualTrailSLOn) updateAiSlStatus('Overall SL ' + slPct.toFixed(2) + '% + Trail SL ' + slTrailPct.toFixed(2) + '%');
          else if (manualSLOn) updateAiSlStatus('Overall SL ' + slPct.toFixed(2) + '%');
          else if (manualTrailSLOn) updateAiSlStatus('Trail SL ' + slTrailPct.toFixed(2) + '%');
          else if (aiSlOn) updateAiSlStatus('AI SL ' + slPct.toFixed(2) + '%');
          else updateAiSlStatus('');
          if (manualTrailTPOn) updateAiTpStatus('Manual Trail TP ' + tpPct.toFixed(2) + '%');
          else if (aiTpOn) updateAiTpStatus('AI Trail TP on');
          else updateAiTpStatus('');
          if (u.rrEnabled === true && Number(u.rrValue) > 0 && slPct > 0) { updateAiTPStatus('Risk:Reward TP ' + fixedTpPct.toFixed(2) + '%'); updateRrStatus('Target RR ' + Number(u.rrValue) + ' x SL ' + slPct.toFixed(2) + '% = ' + fixedTpPct.toFixed(2) + '%'); }
          else if (manualTPOn) { updateAiTPStatus('Manual TP ' + fixedTpPct.toFixed(2) + '%'); updateRrStatus(''); }
          else if (aiTPOn) { updateAiTPStatus('AI TP ' + fixedTpPct.toFixed(2) + '%'); updateRrStatus(''); }
          else { updateAiTPStatus(''); updateRrStatus(''); }
          try { if (window.__astDiag !== false) log('TEMP-ENTRYDIAG poll ' + s.id + ' trailPct=' + slTrailPct + ' uPct=' + (Number(u.manualTrailSLPct) || 0) + ' inPct=' + (($id('astManualTrailSLPct') && $id('astManualTrailSLPct').value) || '') + ' mTrail=' + (u.manualTrailSL === true) + ' ownTr=' + (ownTrailSl == null ? '-' : ownTrailSl) + ' useOwn=' + (u.astUseOwnSettings === true)); } catch (e) {}
          let placed = 0;
          for (const tSym of tradeTargets) {
            const pkey = posKeyOf(tSym);
            if (autoPositions[pkey]) continue; // already holding this leg
            /* Close All ran while this poll was evaluating: abort before any
               fresh entry can be placed. */
            if (stopGen !== _stopGen) { prog(s.id, 95, 'Stopped by Close All'); return; }
            const sCap = strategyMarginCap(s);
            const ok = pt.autoEntry(side, { key: key, symbol: tSym, lotSize: lotSize, lots: u.lots, margin: (sCap > 0 ? sCap : u.margin), marginCap: sCap, tpPct: tpPct, slPct: slPct, slTrailPct: slTrailPct, fixedTpPct: fixedTpPct, fnoLimit: false, fallbackLtp: tSym.premium, autoTrail: (aiSlOn && slPct > 0) });
            if (ok) {
              placed++;
              const np = autoPositions[pkey];
              if (np) {
                state.positions[pkey] = {
                  strategyId: s.id, strategyName: s.name, cat: s.cat,
                  side: side, qty: np.qty, lotSize: np.lotSize, lots: np.lots, margin: np.margin,
                  entryPrice: np.entryPrice, peakPrice: np.entryPrice,
                  targetPct: np.targetPct, slPct: np.slPct,
                  slTrailPct: np.slTrailPct || 0, slTrailed: !!(np.slTrailed),
                  targetPrice: np.targetPrice, stopLoss: np.stopLoss,
                  orderType: np.orderType || 'MARKET', limitPrice: np.limitPrice || 0,
                  tpPct: np.tpPct || 0, tpPrice: np.tpPrice || 0,
                  instrumentName: np.symbol || instrumentName(instr),
                  symbol: np.symbol, symbolId: np.symbolId, symbolExch: np.symbolExch, inst: np.inst,
                  underId: underKeyOfInstr(instr),
                  underName: (instr && instr.symbol && (instr.symbol.name || instr.symbol.id)) || '',
                  optionType: optTypeOfLeg(np),
                  openedAt: Date.now()
                };
              }
              log('Auto ' + side + ' paper entry from "' + s.name + '" (' + instrumentName(instr) + ')', 'buy');
              gridEvent('entry', { name: np.symbol || instrumentName(instr), strategy: s.name, key: key, side: side, qty: np.qty, price: np.entryPrice });
            } else {
              prog(s.id, 92, 'Entry rejected: ' + (pt.lastAutoSkip || 'see Paper Trade log'));
            }
          }
          if (placed) {
            state.tradeCounts[s.id] = (state.tradeCounts[s.id] || 0) + 1;
            setSettingsFor(s.id);
            armFiredSignal(key);
            prog(s.id, 100, 'Entry placed');
          }
          placedTotal += placed;
        }

        const dt = performance.now() - st0;
        if (dt > 10) {
          log('"' + s.name + '" evaluation took ' + dt.toFixed(1) + 'ms (>10ms)', 'warn');
        }
      }

      if (placedTotal === 0) {
        const fmt = (b) => {
          const p = [];
          if (b.candles > 0) p.push(b.candles + ' no-candle');
          if (b.targets > 0) p.push(b.targets + ' no-execution-target');
          if (b.nifty > 0) p.push(b.nifty + ' nifty-gate-blocked');
          if (b.limit > 0) p.push(b.limit + ' trade-limit-reached');
          if (b.confirm > 0) p.push(b.confirm + ' missing-both-confirm');
          if (b.signal > 0) p.push(b.signal + ' no-signal');
          if (b.bbp > 0) p.push(b.bbp + ' bbp-gate-wait');
          return p.length ? p.join(', ') : 'none';
        };
        const idxPart = fmt(skips.idx);
        const fnoPart = fmt(skips.fno);
        const kindCounts = {};
        instruments.forEach(i => { kindCounts[i.kind] = (kindCounts[i.kind] || 0) + 1; });
        const kindPart = Object.keys(kindCounts).map(k => k + ':' + kindCounts[k]).join(', ');
        diag('noTrades', 20000,
          'No trades placed. Indices: ' + idxPart + '. F&O stocks: ' + fnoPart + '. ' +
          strategies.length + ' strategy(s) on ' + instruments.length + ' instrument(s) [' + kindPart + ']', 'warn');
      }

      const total = performance.now() - t0;
      updatePerfInfo(total, strategies.length);
    } catch (e) {
      log('AI Smart Trading tick error: ' + (e && e.message ? e.message : e), 'warn');
    }
  }

  /* Auto strategy sender scope: when ON with saved engine templates added, each
     tick runs a full evaluation pass under every selected template's settings
     (applied silently, restored between templates) and then auto-sends the
     ticked strategies to the Paper Trade engine. The option lives OUTSIDE
     engine settings, so saving/opening a template never touches it. */
  async function tick(force) {
    if (!state.enabled && !force) return;
    if (_runningTick) return;
    _runningTick = true;
    try {
      await tickBody(force);
    } catch (e) {
      log('AI Smart Trading tick error: ' + (e && e.message ? e.message : e), 'warn');
    } finally {
      _runningTick = false;
      save();
      render();
      try {
        if (window.ChartGrid) {
          const snap = gridSnapshot();
          window.dispatchEvent(new CustomEvent('astTickEnd', { detail: snap }));
        }
      } catch (e) {}
    }
  }

  /* ---------------- Multi Chart Grid snapshot ---------------- */
  const _emaPairs = [[9, 21], [21, 35], [35, 50], [50, 100], [100, 200], [200, 300]];

  function gridCardItem(instr) {
    if (!instr || !instr.symbol) return null;
    const sym = instr.symbol;
    if (isSimSymbol(sym)) return null;
    if (instr.kind === 'option' && instr.sid != null) {
      const exch = optionExch(sym), inst = optionInst(sym);
      return { key: String(instr.sid) + ':' + exch, id: Number(instr.sid), exch: exch, inst: inst,
        name: instrumentName(instr), kind: 'opt' };
    }
    if (instr.kind === 'underlying') {
      const exch = sym.exch || 'NSE';
      return { key: String(sym.id) + ':' + exch, id: Number(sym.id), exch: exch,
        inst: sym.inst || 'EQUITY', name: sym.name || instrumentName(instr), kind: 'sym' };
    }
    if (instr.kind === 'both' && Array.isArray(instr.contracts)) {
      /* Run-in "Both (spot + premium)": the strategy's own chart is the spot /
         underlying instrument (premium contracts are its execution targets and
         confirmation legs). The grid therefore shows the SPOT card here, never
         every premium leg - premium charts surface only once a trade is open
         (they come through the positions feed as TRADE EXECUTION rows). */
      const exch = sym.exch || 'NSE';
      return { key: String(sym.id) + ':' + exch, id: Number(sym.id), exch: exch,
        inst: sym.inst || 'EQUITY', name: sym.name || instrumentName(instr), kind: 'sym',
        runMode: 'both' };
    }
    return null;
  }

  function pushOvl(list, id, settings) {
    list.push({ id: id, settings: settings || {} });
  }

  function overlaySpecFromFilters(f) {
    const out = [];
    if (!f) return out;
    const has = (k) => !!(f[k]);
    _emaPairs.forEach(p => {
      ['bull', 'bear'].forEach(d => {
        ['', 'Meet'].forEach(pr => {
          const mk = pr + 'Ema' + p[0] + '_' + p[1];
          if (has(d + mk)) {
            pushOvl(out, 'ema', { length: p[0] });
            pushOvl(out, 'ema', { length: p[1] });
          }
        });
      });
    });
    const st = (period, f1, f2) => {
      pushOvl(out, 'supertrend', { atrPeriod: period, factor: f1 });
      pushOvl(out, 'supertrend', { atrPeriod: period, factor: f2 });
    };
    ['bull', 'bear'].forEach(d => {
      if (has(d + 'St10_1_2') || has(d + 'MeetSt10_1_2')) st(10, 1, 2, d);
      if (has(d + 'St10_2_3') || has(d + 'MeetSt10_2_3')) st(10, 2, 3, d);
      if (has(d + 'St1CloseCrossAbove') || has(d + 'St1CloseCrossBelow') || has(d + 'MeetCloseSt')) {
        pushOvl(out, 'supertrend', { atrPeriod: 10, factor: 1 });
      }
      if (has(d + 'VwapCloseCrossAbove') || has(d + 'VwapCloseCrossBelow') || has(d + 'MeetCloseVwap')) pushOvl(out, 'vwap', {});
      if (has(d + 'BbwInc') || has(d + 'BbCrossAbove') || has(d + 'BbCrossBelow') || has(d + 'MeetCloseBb')) {
        pushOvl(out, 'bb', { length: 20, mult: 2, source: 'close', midType: 'sma', midLength: 10 });
      }
      if (has(d + 'PcCrossAbove') || has(d + 'PcCrossBelow') || has(d + 'MeetClosePc')) {
        pushOvl(out, 'pc', { length: 20, midType: 'midpoint', midLength: 10 });
      }
      if (has(d + 'Asr')) pushOvl(out, 'autosr', { atrPeriod: 14, atrMult: 2.0, minPct: 0.15 });
      if (has(d + 'Vl') || has(d + 'MeetVl')) pushOvl(out, 'vl', { length: 14, signalLen: 9, volLen: 20 });
      if (has(d + 'Oit')) pushOvl(out, 'oitrend', { fast: 9, slow: 21, enterK: 0.45, exitK: 0.12 });
    });
    const seen = {};
    return out.filter(x => {
      const k = x.id + '|' + JSON.stringify(x.settings);
      if (seen[k]) return false;
      seen[k] = true;
      return true;
    });
  }

  /* Every distinct (indicatorId, settings) pair a single condition references -
     primary line, indicator-vs-indicator compare side, chain legs and pane
     conditions/moves - mirroring the legacy runner's _condIndSettings. */
  function condIndSpecs(c) {
    const out = [];
    const seen = new Set();
    const push = (id, settings) => {
      if (!id) return;
      const key = id + '|' + JSON.stringify(settings || {});
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ id: id, settings: settings || {} });
    };
    if (!c) return out;
    if (c.indId) push(c.indId, c.indSettings);
    if (c.cmpType === 'indicator' && c.cmpIndId) push(c.cmpIndId, c.cmpSettings);
    (c.chain || []).forEach(ch => {
      if (!ch) return;
      if (ch.indId) push(ch.indId, ch.indSettings);
      if (ch.cmpType === 'indicator' && ch.cmpIndId) push(ch.cmpIndId, ch.cmpSettings);
    });
    if (c.paneCond && c.paneCond.indId) push(c.paneCond.indId, c.paneCond.indSettings || c.indSettings);
    (c.paneConds || []).forEach(p => { if (p && p.indId) push(p.indId, p.indSettings || c.indSettings); });
    if (c.paneMove && c.paneMove.indId) push(c.paneMove.indId, c.paneMove.indSettings);
    (c.paneMoves || []).forEach(pm => { if (pm && pm.indId) push(pm.indId, pm.indSettings); });
    return out;
  }

  /* Every distinct indicator a running strategy template references across its
     entry / exit / entryExtra / exitExtra condition set, so "Open Chart" on a
     Running Strategy / Running Trade deploys the actual indicator lines the
     strategy evaluates - not just the AST indicator-filter overlays. A normal
     running strategy used to open a bare chart whenever no Bull/Bear AST
     filter was ticked, even though the strategy's own EMA/BB/trend lines were
     the ones firing its entries. */
  function overlaySpecFromStrategy(s) {
    const out = [];
    if (!s) return out;
    const walk = (c) => {
      if (!c) return;
      if (Array.isArray(c)) { c.forEach(walk); return; }
      condIndSpecs(c).forEach(p => pushOvl(out, p.id, p.settings));
    };
    walk(s.entry);
    walk(s.exit);
    (s.entryExtra || []).forEach(walk);
    (s.exitExtra || []).forEach(walk);
    return out;
  }

  /* The overlay set deployed for the active run: enabled AST indicator-filter
     lines PLUS every running strategy's own template indicator lines (deduped).
     Shared by the engine-tab "Open Chart" deploy and the ChartGrid snapshot so
     both surfaces always paint the lines the strategy is actually evaluating. */
  function runOverlaySpecs() {
    const out = [];
    const push = (w) => { if (w && w.id && !out.some(x => x.id === w.id && JSON.stringify(x.settings) === JSON.stringify(w.settings))) out.push(w); };
    overlaySpecFromFilters(state.filters || {}).forEach(push);
    ((state.filterMode === true) ? filterModeStrategies() : activeStrategies()).forEach(s => overlaySpecFromStrategy(s).forEach(push));
    return out;
  }

  function gridEntryTf() {
    const tfs = state.universal && state.universal.tfs;
    if (tfs && tfs['1min']) return '1min';
    if (tfs && tfs['5min']) return '5min';
    return '1min';
  }

  /* Idempotent AST-overlay deploy for the engine-tab "Open Chart" buttons
     (running strategies + running trades). The ChartGrid "Smart Chart List" had
     its own copy of this; the engine tab previously opened a bare chart with NO
     indicator filters, so the user could not see which AST indicator lines the
     strategy evaluates. This mirrors ChartGrid's deployOverlays semantics:
     each wanted overlay is added once; instances already present with matching
     settings are never duplicated. Runs only after the requested symbol's
     candles have painted (callers await openOptionChartBySid / loadChart first).
     `specs` defaults to the full active-run overlay set (AST filter lines +
     every running strategy's own indicator lines). */
  function deployAstOverlays(specs) {
    try {
      const want = Array.isArray(specs) ? specs : runOverlaySpecs();
      const IC = window.IndChart;
      if (!want.length || !IC || typeof IC.addIndicator !== 'function' || !IC.IND) return;
      let cur = [];
      try { cur = (typeof IC.getIndicators === 'function') ? IC.getIndicators() : []; } catch (e) { cur = []; }
      const match = (it, w) => {
        if (!it || it.id !== w.id) return false;
        const st = it.settings || {}, ws = w.settings || {};
        for (const k in ws) { if (Object.prototype.hasOwnProperty.call(ws, k) && st[k] !== ws[k]) return false; }
        return true;
      };
      want.forEach(w => {
        for (let i = 0; i < cur.length; i++) { if (match(cur[i], w)) return; }
        try { IC.addIndicator(w.id, w.settings || {}); } catch (e) {}
      });
    } catch (e) {}
  }
  function deployAstOverlaysAfter(promise, specs) {
    if (promise && typeof promise.then === 'function') { promise.then(() => deployAstOverlays(specs), () => deployAstOverlays(specs)); }
    else setTimeout(() => deployAstOverlays(specs), 350);
  }

  /* Overlay specs for opening THIS strategy's chart: the enabled AST
     indicator-filter lines plus the strategy's own template indicator lines
     (deduped), so the chart always shows what actually fires its entries. */
  function specsForOpenChart(s) {
    const out = [];
    const push = (w) => { if (w && w.id && !out.some(x => x.id === w.id && JSON.stringify(x.settings) === JSON.stringify(w.settings))) out.push(w); };
    overlaySpecFromFilters(state.filters || {}).forEach(push);
    overlaySpecFromStrategy(s).forEach(push);
    return out;
  }

  /* Grid STRATEGY RUNNING cards mirror the Paper Trade engine tab's running
     strategy list (paperrun chartsForStrategy) for this engine, so both views
     always show the same rows. Per symbol the "Strategy should be run in"
     dropdown decides whether the spot/underlying chart row is listed (spot +
     both) — exactly the same rule the engine tab applies (the engine tab does
     NOT drop the spot row when the global CE/PE "Run Strategy In" override is
     on, so the grid does not either). The engine's picked premium strikes are
     listed in every mode, just like the engine tab lists them. Rows collapse
     across strategies on the same symbol, and once a premium contract actually
     has an open trade its row moves to TRADE EXECUTION (same key). */
  function gridStrategyCards() {
    const strategies = (state.filterMode === true) ? filterModeStrategies() : activeStrategies();
    if (!strategies.length) return [];
    const out = [];
    const seen = new Set();
    const add = (card) => {
      if (!card || !card.key || seen.has(card.key)) return;
      seen.add(card.key);
      out.push(card);
    };
    const syms = experimentSymbols();
    for (const sym of syms) {
      if (!sym || sym.id == null) continue;
      if (isSimSymbol(sym)) continue;
      const mode = runInMode(sym);
      /* Spot/underlying row: listed whenever the run-in dropdown is spot or
         both (identical to the engine-tab list). Premium-only runs have no spot
         row, exactly like the engine-tab list. */
      if (mode === 'spot' || mode === 'both') {
        const card = gridCardItem({ kind: 'both', symbol: sym, contracts: [] });
        if (card) add(card);
      }
      /* Picked premium strike rows: every contract the engine resolved/picked
         for this symbol, matching the count the engine-tab running strategy list
         shows. Prefer the engine's picked strikes (full set, identical to the
         engine tab); fall back to this tick's resolved option instruments. */
      const rec = _pickedStrikes.get(_pickedKey(sym));
      const contracts = (rec && Array.isArray(rec.contracts)) ? rec.contracts : [];
      let added = false;
      if (contracts.length) {
        contracts.forEach(c => {
          if (!c || c.sid == null) return;
          const card = gridCardItem({ kind: 'option', symbol: sym, sid: c.sid, strike: c.strike, optionType: c.optionType, premium: c.premium });
          if (card) { add(card); added = true; }
        });
      }
      if (!added) {
        (_lastInstruments || []).forEach(instr => {
          if (!instr || instr.kind !== 'option' || instr.sid == null) return;
          if (!instr.symbol || instr.symbol.id !== sym.id ||
              (instr.symbol.exch || '') !== (sym.exch || '')) return;
          const card = gridCardItem(instr);
          if (card) add(card);
        });
      }
    }
    return out;
  }

  function gridSnapshot() {
    const cards = gridStrategyCards();
    const pos = {};
    Object.keys(state.positions || {}).forEach(k => { pos[k] = state.positions[k]; });
    return {
      eng: suffix || '',
      cards: cards,
      positions: pos,
      events: _gridEvents.slice(),
      overlays: runOverlaySpecs(),
      entryTf: gridEntryTf(),
      mtf: !!(state.universal && state.universal.mtfConfirm),
      fast: !!(state.fastData && window.FastLive && window.FastLive.enabled)
    };
  }

  function updatePerfInfo(totalMs, strategyCount) {
    const el = $id('astPerfInfo');
    if (!el) return;
    const avg = strategyCount ? (totalMs / strategyCount) : 0;
    const color = avg < 10 ? '#00d4aa' : '#ff9800';
    el.innerHTML = '<span style="color:#888">Tick:</span> <span style="color:' + color + ';font-weight:700">' + totalMs.toFixed(1) + 'ms</span> for ' + strategyCount +
      ' strategy(s) <span style="color:#666">(' + avg.toFixed(2) + 'ms/strategy · all settings applied live)</span>';
  }

  function startPoll() {
    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = setInterval(() => { tick(); refreshNiftyStatus(); renderMoversList(); renderNiftyTrendList(); renderPickedStrikes(); if (state.dataPool) poolScan(); syncFastDataUI(); }, POLL_MS);
  }
  function stopPoll() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  }
  /* Keep the NIFTY ensemble-trend status and the BB%B live values on screen
     even when no strategies are being ticked. niftyBias() is rate-limited by
     its own 60s cache, so this only re-fetches candles at most once a minute
     while the displayed reading refreshes on every poll. The fetch is skipped
     entirely while the engine is OFF (the status stays on the last reading) so
     an idle AST tab never consumes the shared Dhan chart rate-limit budget. */
  function refreshNiftyStatus() {
    if (state.enabled !== true) return;
    niftyBias().then(b => { if (b) { updateNiftyBiasStatus(b); return refreshConfirmedNifty(b); } }).catch(() => {});
  }

  /* ---------------- log ---------------- */
  function log(msg, cls) {
    /* TEMP DIAGNOSTIC (remove after AST no-trade bug fixed): mirror AST log
       lines to the server so skip reasons can be read from the server log. */
    try {
      const _txt = String(msg || '').slice(0, 4000);
      const _lk = 'astlog:' + _txt;
      const _now = Date.now();
      if (!window.__astMirror) window.__astMirror = {};
      if (window.__astMirror[_lk] && _now - window.__astMirror[_lk] < 8000) return;
      window.__astMirror[_lk] = _now;
      fetch('/api/client_error', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ errs: [{ type: 'astLog', msg: _txt, cls: cls || '' }] }) }).catch(() => {});
    } catch (e) {}
    const el = $id('astLog');
    if (!el) return;
    const d = new Date();
    const ts = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
    const col = cls === 'buy' ? '#00d4aa' : (cls === 'sell' ? '#ef5350' : (cls === 'warn' ? '#ff9800' : (cls === 'ok' ? '#00d4aa' : '#888')));
    const div = document.createElement('div');
    div.innerHTML = '<span style="color:#555">' + ts + '</span> <span style="color:' + col + '">' + esc(msg) + '</span>';
    el.appendChild(div);
    while (el.children.length > MAX_LOG) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
  }

  /* ---------------- settings readers (no backtest / aiTimeframe) ---------------- */
  function readUniversal() {
    const lotSizeEl = $id('astLotSize'), lotsEl = $id('astLots'), marginEl = $id('astMargin'), tpEl = $id('astTp');
    state.universal.lotSize = lotSizeEl && lotSizeEl.value ? Number(lotSizeEl.value) : null;
    state.universal.lots = lotsEl ? (Number(lotsEl.value) || 1) : 1;
    state.universal.margin = marginEl ? (Number(marginEl.value) || 0) : 0;
    state.universal.tpPct = tpEl ? (Number(tpEl.value) || 0) : (Number(state.universal.tpPct) > 0 ? state.universal.tpPct : 1);
    const mtEl = $id('astManualTrail'), tf1El = $id('astTf1min'), tf5El = $id('astTf5min');
    state.universal.manualTrail = mtEl ? mtEl.checked : true;
    const aiSlEl = $id('astAiSl'), aiTpEl = $id('astAiTp');
    state.universal.aiSl = aiSlEl ? aiSlEl.checked : true;
    state.universal.aiTp = aiTpEl ? aiTpEl.checked : true;
    const mslEl = $id('astManualSL'), mslPctEl = $id('astManualSLPct'), mttEl = $id('astManualTrailTP'), mttPctEl = $id('astManualTrailTPPct'), mtpEl = $id('astManualTP'), mtpPctEl = $id('astManualTPPct'), aitpEl = $id('astAiTP'), mtslEl = $id('astManualTrailSL'), mtslPctEl = $id('astManualTrailSLPct');
    state.universal.manualSL = mslEl ? mslEl.checked : false;
    state.universal.manualSLPct = mslPctEl ? (Number(mslPctEl.value) || 0) : 0;
    state.universal.manualTrailSL = mtslEl ? mtslEl.checked : false;
    state.universal.manualTrailSLPct = mtslPctEl ? (Number(mtslPctEl.value) || 0) : 0;
    state.universal.manualTrailTP = mttEl ? mttEl.checked : false;
    state.universal.manualTrailTPPct = mttPctEl ? (Number(mttPctEl.value) || 0) : 0;
    state.universal.manualTP = mtpEl ? mtpEl.checked : false;
    state.universal.manualTPPct = mtpPctEl ? (Number(mtpPctEl.value) || 0) : 0;
    state.universal.aiTP = aitpEl ? aitpEl.checked : false;
    const rrEl = $id('astRrEnabled'), rrValEl = $id('astRrValue');
    state.universal.rrEnabled = rrEl ? rrEl.checked : false;
    state.universal.rrValue = rrValEl ? (Number(rrValEl.value) || 0) : 0;
    const mtfEl = $id('astMtf');
    state.universal.mtfConfirm = mtfEl ? mtfEl.checked : false;
    state.universal.tfs = {
      '1min': tf1El ? tf1El.checked : true,
      '5min': tf5El ? tf5El.checked : true
    };
    const useOwnEl = $id('astUseOwnSettings');
    state.universal.astUseOwnSettings = useOwnEl ? useOwnEl.checked : false;
    const tlEl = $id('astTradeLimit'), tlCntEl = $id('astTradeLimitCount'), aiTrEl = $id('astAiTrades');
    state.universal.tradeLimitEnabled = tlEl ? tlEl.checked : false;
    state.universal.tradeLimitCount = tlCntEl ? (Number(tlCntEl.value) || 5) : 5;
    state.universal.aiTrades = aiTrEl ? aiTrEl.checked : false;
    const hftEl = $id('astHft'), hftOpsEl = $id('astHftOps'), hftExecEl = $id('astHftExecOn'), hftExecCbEl = $id('astHftExecOnCb');
    state.universal.hft = hftEl ? hftEl.checked : false;
    state.universal.hftOps = hftOpsEl ? (Number(hftOpsEl.value) || 6) : 6;
    state.universal.hftExecEnabled = hftExecCbEl ? hftExecCbEl.checked : true;
    state.universal.hftExecOn = hftExecEl ? (hftExecEl.value || 'close') : 'close';
    syncHftUI();
    const flEl = $id('astFnoLimit');
    state.universal.fnoLimit = flEl ? flEl.checked : true;
    const staEl = $id('astStartTradeAfter'), staOnEl = $id('astStartTradeAfterEnabled');
    state.universal.startTradeAfter = staEl ? staEl.value : '09:15';
    state.universal.startTradeAfterEnabled = staOnEl ? staOnEl.checked : false;
    const ntaEl = $id('astNoTradeAfter'), ntaOnEl = $id('astNoTradeAfterEnabled');
    state.universal.noTradeAfter = ntaEl ? ntaEl.value : '15:30';
    state.universal.noTradeAfterEnabled = ntaOnEl ? ntaOnEl.checked : false;
    const asoEl = $id('astAutoSquareOffTime'), asoOnEl = $id('astAutoSquareOffEnabled');
    state.universal.autoSquareOffTime = asoEl ? asoEl.value : '15:20';
    state.universal.autoSquareOffEnabled = asoOnEl ? asoOnEl.checked : false;
    syncManualTrailUI();
    syncManualSlTpUI();
    syncRrUI();
    syncTimeframeUI();
    syncTradesUI();
    syncTimeGateUI();
    syncStrategyOverrideUI();
    save();
  }

  function toggleAutoSl(on) {
    const aiSlEl = $id('astAiSl');
    if (aiSlEl) aiSlEl.checked = !!on;
    readUniversal();
  }

  let _fastestRisingPrevMode = null;
  let _fastestRisingPrevPos = null;
  /* When "Pick fastest positive rising LTP and LTP change strike" is switched
     ON, the strike pool must cover both sides of the ATM so the fastest positive
     riser (CE or PE, wherever it sits) can actually be inside the pool. If the
     user has a one-sided / ATM-only "Execute Trade In" mode selected we switch
     the dropdown to the widest near-ATM pool (above + below + ATM). The mode is
     only auto-selected at the moment the checkbox is toggled ON; afterwards the
     user is free to change the dropdown manually and the engine simply ranks
     inside whatever pool they pick. When the checkbox is switched back OFF the
     previously selected mode is restored. Fastest-rising selection only ever
     considers positive (+green) LTP / LTP-change strikes, so while it is ON the
     "Only +green premium strikes" checkbox is forced checked + inactive too
     (the fastest ranking already implies it) and the user's own checkbox state
     is restored when fastest mode is switched OFF. */
  function onFastestRisingInput() {
    const fastEl = $id('astFastestRising'), modeEl = $id('astStrikeMode'), posEl = $id('astOnlyPositive');
    if (fastEl && modeEl) {
      if (fastEl.checked) {
        const m = modeEl.value;
        if (m !== 'both_atm' && m !== 'both_atm_inc') {
          _fastestRisingPrevMode = m;
          modeEl.value = 'both_atm_inc';
          log('Pick fastest rising strike ON: "Execute Trade In" auto-set to Above and below including ATM so the fastest positive riser (CE or PE side) is inside the pool. You can still change the mode after this.', 'ok');
        }
        if (posEl && !posEl.checked) {
          _fastestRisingPrevPos = false;
          posEl.checked = true;
        }
      } else {
        if (_fastestRisingPrevMode) {
          modeEl.value = _fastestRisingPrevMode;
          _fastestRisingPrevMode = null;
        }
        if (_fastestRisingPrevPos != null && posEl) {
          posEl.checked = _fastestRisingPrevPos;
          _fastestRisingPrevPos = null;
        }
      }
    }
    syncStrikeUI();
    readStrikeUI();
  }

  function readStrikeUI() {
    const modeEl = $id('astStrikeMode'), cntEl = $id('astStrikeCount'), otEl = $id('astOptionType'), posEl = $id('astOnlyPositive'), fastEl = $id('astFastestRising'), fastCntEl = $id('astFastestCount');
    const mode = modeEl ? (modeEl.value || 'both_atm') : 'both_atm';
    state.strike.mode = mode;
    state.strike.count = mode === 'atm' ? 1 : (cntEl ? (Number(cntEl.value) || 3) : 3);
    state.strike.optionType = otEl ? (otEl.value || 'both') : 'both';
    state.strike.positiveOnly = posEl ? posEl.checked : true;
    state.strike.fastestRising = fastEl ? fastEl.checked : false;
    const fc = fastCntEl ? Number(fastCntEl.value) : NaN;
    state.strike.fastestCount = Number.isFinite(fc) && Math.floor(fc) >= 1 ? Math.floor(fc) : 3;
    syncStrikeUI();
    save();
  }

  function readRunInUI() {
    const idxEl = $id('astRunInIndex'), fnoEl = $id('astRunInFno'), commEl = $id('astRunInComm'), defEl = $id('astRunInDefault');
    const idx = idxEl ? idxEl.value : 'both';
    const fno = fnoEl ? fnoEl.value : 'spot';
    const comm = commEl ? commEl.value : 'spot';
    const def = defEl ? defEl.checked : false;
    state.runIn = state.runIn || { index: 'both', fno: 'spot', comm: 'spot', default: false };
    state.runIn.index = idx;
    state.runIn.fno = fno;
    state.runIn.comm = comm;
    state.runIn.default = def;
    save();
    log('Strategy run in: indices = ' + modeLabel(idx) + ', F&O stocks = ' + modeLabel(fno) + ', Commodities = ' + modeLabel(comm) + (def ? ' (saved as default for all future tasks)' : ''), def ? 'ok' : '');
  }

  function readTradeInUI() {
    const idxEl = $id('astTradeInIndex'), commEl = $id('astTradeInComm'), defEl = $id('astTradeInDefault');
    const idx = idxEl ? idxEl.value : 'premium';
    const comm = commEl ? commEl.value : 'spot';
    const def = defEl ? defEl.checked : false;
    state.tradeIn = state.tradeIn || { index: 'premium', fno: 'premium', comm: 'spot', default: false };
    state.tradeIn.index = idx;
    // F&O stocks are fixed to the premium chart regardless of the dropdown.
    state.tradeIn.fno = 'premium';
    state.tradeIn.comm = comm;
    state.tradeIn.default = def;
    save();
    log('Trade execution in: indices = ' + modeLabel(idx) + ', F&O stocks = ' + modeLabel('premium') + ', Commodities = ' + modeLabel(comm) + (def ? ' (saved as default for all future tasks)' : ''), def ? 'ok' : '');
  }

  function modeLabel(m) {
    if (m === 'spot') return 'spot chart';
    if (m === 'futures') return 'futures contract';
    return m === 'both' ? 'both spot + option premium charts (dual confirmation)' : 'option premium chart';
  }

  /* Premium-only mode: a single master toggle that locks the strategy run
     chart AND the trade execution chart to the selected-strike option premium
     chart for every instrument type (indices and F&O stocks alike). The
     per-instrument "Strategy should be run in" / "Trade should be executed in"
     dropdowns are faded out and disabled while this is ON. */
  function onPremiumOnlyInput() {
    const el = $id('astPremiumOnly');
    state.premiumOnly = el ? el.checked : false;
    save();
    syncPremiumOnlyUI();
    log('Premium-only mode: strategies run AND trades execute on the option premium chart ' + (state.premiumOnly ? 'ON' : 'OFF'), state.premiumOnly ? 'ok' : '');
  }
  function syncPremiumOnlyUI() {
    const el = $id('astPremiumOnly');
    if (el) el.checked = state.premiumOnly === true;
    const on = state.premiumOnly === true;
    ['astRunInRow', 'astTradeInRow'].forEach(id => {
      const row = $id(id);
      if (!row) return;
      row.style.opacity = on ? '0.35' : '1';
      row.style.pointerEvents = on ? 'none' : 'auto';
      const sel = row.querySelectorAll('select, input');
      for (let i = 0; i < sel.length; i++) sel[i].disabled = on;
    });
  }

  function readGroupsUI() {
    const enabled = [];
    GROUPS.forEach(g => {
      const el = $id('astGroup_' + g.key);
      if (el && el.checked) enabled.push(g.key);
    });
    state.groups = enabled.length ? enabled : GROUP_KEYS.slice();
    save();
    render();
  }

  function readMoversUI() {
    const g = $id('astMoversGainers'), l = $id('astMoversLosers');
    if (!state.movers) state.movers = { enabled: false, gainers: 5, losers: 5, indices: [] };
    state.movers.gainers = g ? (Number(g.value) || 0) : 0;
    state.movers.losers = l ? (Number(l.value) || 0) : 0;
    save();
  }

  function readFiltersUI() {
    if (!state.filters) state.filters = Object.assign({}, defaultState().filters);
    const prevMaster = { bullish: !!state.filters.bullish, bearish: !!state.filters.bearish };
    state.filters.bullish = !!($id('astFilterBullish') && $id('astFilterBullish').checked);
    state.filters.bearish = !!($id('astFilterBearish') && $id('astFilterBearish').checked);
    state.filters.incUp = !!($id('astFilterIncUp') && $id('astFilterIncUp').checked);
    state.filters.incDown = !!($id('astFilterIncDown') && $id('astFilterIncDown').checked);
    state.filters.gapUp = !!($id('astFilterGapUp') && $id('astFilterGapUp').checked);
    state.filters.gapDown = !!($id('astFilterGapDown') && $id('astFilterGapDown').checked);
    state.filters.incUpAll = !!($id('astFilterIncUpAll') && $id('astFilterIncUpAll').checked);
    state.filters.incDownAll = !!($id('astFilterIncDownAll') && $id('astFilterIncDownAll').checked);
    state.filters.crossUp = !!($id('astFilterCrossUp') && $id('astFilterCrossUp').checked);
    state.filters.crossDown = !!($id('astFilterCrossDown') && $id('astFilterCrossDown').checked);
    state.filters.gtUp = !!($id('astFilterGtUp') && $id('astFilterGtUp').checked);
    state.filters.ltUp = !!($id('astFilterLtUp') && $id('astFilterLtUp').checked);
    state.filters.gtDown = !!($id('astFilterGtDown') && $id('astFilterGtDown').checked);
    state.filters.ltDown = !!($id('astFilterLtDown') && $id('astFilterLtDown').checked);
    FILTER_EXTRA_KEYS.forEach(k => {
      state.filters[k] = !!($id('astFilter' + capId(k)) && $id('astFilter' + capId(k)).checked);
    });
    STREAM_FLAG_KEYS.forEach(k => {
      state.filters[k] = !!($id('astFilter' + capId(k)) && $id('astFilter' + capId(k)).checked);
    });
    syncFilterSections({ bullish: prevMaster.bullish && !state.filters.bullish, bearish: prevMaster.bearish && !state.filters.bearish });
    _workingCache.clear();
    save();
    const any = (state.filters.bullish && (state.filters.incUp || state.filters.crossUp || state.filters.gapUp || state.filters.incUpAll || state.filters.gtUp || state.filters.ltUp || state.filters.bullVolUp || state.filters.bullVolDown || state.filters.bullFakeBreakout || state.filters.bullReversal || state.filters.paneCrossUp || state.filters.paneIncUpAll || state.filters.bullBbwInc || state.filters.bullBbCrossBelow || state.filters.bullBbCrossAbove || state.filters.bullPcCrossBelow || state.filters.bullPcCrossAbove || state.filters.bullSmf || state.filters.bullVl || state.filters.bullAsr || state.filters.bullOit || state.filters.bullEma9_21 || state.filters.bullEma21_35 || state.filters.bullEma35_50 || state.filters.bullEma50_100 || state.filters.bullEma100_200 || state.filters.bullEma200_300 || state.filters.bullSt10_1_2 || state.filters.bullSt10_2_3 || state.filters.bullSt1CloseCrossAbove || state.filters.bullVwapCloseCrossAbove || state.filters.bullMeetEma9_21 || state.filters.bullMeetEma21_35 || state.filters.bullMeetEma35_50 || state.filters.bullMeetEma50_100 || state.filters.bullMeetEma100_200 || state.filters.bullMeetEma200_300 || state.filters.bullMeetSt10_1_2 || state.filters.bullMeetSt10_2_3 || state.filters.bullMeetCloseSt || state.filters.bullMeetCloseVwap || state.filters.bullMeetPaneCross || state.filters.bullMeetCross || state.filters.bullMeetCloseBb || state.filters.bullMeetClosePc || state.filters.bullMeetVl || state.filters.bullGreenCandle || hasStreamFlags(state.filters, 'bull') || pbrOn(state.filters, 'bull'))) ||
                (state.filters.bearish && (state.filters.incDown || state.filters.crossDown || state.filters.gapDown || state.filters.incDownAll || state.filters.gtDown || state.filters.ltDown || state.filters.bearVolUp || state.filters.bearVolDown || state.filters.bearFakeBreakout || state.filters.bearReversal || state.filters.paneCrossDown || state.filters.paneIncDownAll || state.filters.bearBbwInc || state.filters.bearBbCrossBelow || state.filters.bearBbCrossAbove || state.filters.bearPcCrossBelow || state.filters.bearPcCrossAbove || state.filters.bearSmf || state.filters.bearVl || state.filters.bearAsr || state.filters.bearOit || state.filters.bearEma9_21 || state.filters.bearEma21_35 || state.filters.bearEma35_50 || state.filters.bearEma50_100 || state.filters.bearEma100_200 || state.filters.bearEma200_300 || state.filters.bearSt10_1_2 || state.filters.bearSt10_2_3 || state.filters.bearSt1CloseCrossBelow || state.filters.bearVwapCloseCrossBelow || state.filters.bearMeetEma9_21 || state.filters.bearMeetEma21_35 || state.filters.bearMeetEma35_50 || state.filters.bearMeetEma50_100 || state.filters.bearMeetEma100_200 || state.filters.bearMeetEma200_300 || state.filters.bearMeetSt10_1_2 || state.filters.bearMeetSt10_2_3 || state.filters.bearMeetCloseSt || state.filters.bearMeetCloseVwap || state.filters.bearMeetPaneCross || state.filters.bearMeetCross || state.filters.bearMeetCloseBb || state.filters.bearMeetClosePc || state.filters.bearMeetVl || state.filters.bearRedCandle || hasStreamFlags(state.filters, 'bear') || pbrOn(state.filters, 'bear')));
    log('Entry filters ' + (any ? 'enabled: ' + filterSummary() : 'disabled'), any ? 'ok' : 'warn');
  }

  /* Readable names of EVERY currently-selected indicator filter that becomes an
     entry gate, one per ticked Bullish/Bearish sub-filter. Research-stream flags
     (Candlestick patterns / Elliott Wave / ...) are NOT entry filters - they
     gate which strategies the AI trader researches, so they are excluded here.
     Shared by filterSummary() and the Indicator-filters-mode start log so both
     list EXACTLY the filters AST reads/monitors. */
  function selectedFilterNames() {
    const f = state.filters || {};
    const out = [];
    const add = (sec, items) => {
      if (!f[sec]) return;
      items.forEach(n => { if (n) out.push((sec === 'bullish' ? 'Bullish' : 'Bearish') + ': ' + n); });
    };
    add('bullish', [f.incUp ? 'Increasing upward' : null, f.gapUp ? 'Gap increasing' : null, f.incUpAll ? 'Increasing upward (all)' : null, f.gtUp ? 'Greater than' : null, f.ltUp ? 'Less than' : null, f.crossUp ? 'Crossed above' : null, f.paneCrossUp ? 'Pane crossover' : null, f.paneIncUpAll ? 'Pane all lines increasing upward' : null, f.bullBbwInc ? 'BBW increasing' : null, f.bullBbCrossAbove ? 'Close crossed above BB middle band (upper+lower expanding)' : null, f.bullPcCrossAbove ? 'Close crossed above price channel middle line' : null, f.bullSmf ? 'Smart Money Flow bullish' : null, f.bullVl ? 'Volume Line rising + volume increasing' : null, f.bullAsr ? 'Support gap widening (price rising away from support)' : null, f.bullOit ? 'OI Trend increasing upward' : null, f.bullEma9_21 ? 'EMA 9 crossed above EMA 21' : null, f.bullEma21_35 ? 'EMA 21 crossed above EMA 35' : null, f.bullEma35_50 ? 'EMA 35 crossed above EMA 50' : null, f.bullEma50_100 ? 'EMA 50 crossed above EMA 100' : null, f.bullEma100_200 ? 'EMA 100 crossed above EMA 200' : null, f.bullEma200_300 ? 'EMA 200 crossed above EMA 300' : null, f.bullSt10_1_2 ? 'Supertrend(10,1) crossed above Supertrend(10,2)' : null, f.bullSt10_2_3 ? 'Supertrend(10,2) crossed above Supertrend(10,3)' : null, f.bullSt1CloseCrossAbove ? 'Close crossed above Supertrend(10,1) (ST crossed below close)' : null, f.bullVwapCloseCrossAbove ? 'Close crossed above VWAP' : null, f.bullMeetEma9_21 ? 'EMA 9 above EMA 21' : null, f.bullMeetEma21_35 ? 'EMA 21 above EMA 35' : null, f.bullMeetEma35_50 ? 'EMA 35 above EMA 50' : null, f.bullMeetEma50_100 ? 'EMA 50 above EMA 100' : null, f.bullMeetEma100_200 ? 'EMA 100 above EMA 200' : null, f.bullMeetEma200_300 ? 'EMA 200 above EMA 300' : null, f.bullMeetSt10_1_2 ? 'Supertrend(10,1) above Supertrend(10,2)' : null, f.bullMeetSt10_2_3 ? 'Supertrend(10,2) above Supertrend(10,3)' : null, f.bullMeetCloseSt ? 'Close above Supertrend(10,1) (ST below close)' : null, f.bullMeetCloseVwap ? 'Close above VWAP' : null, f.bullMeetPaneCross ? 'Pane main line above signal' : null, f.bullMeetCross ? 'Primary above twin line' : null, f.bullMeetCloseBb ? 'Close above BB middle band (middle rising)' : null, f.bullMeetClosePc ? 'Close above price channel middle line (middle rising)' : null, f.bullMeetVl ? 'Volume Line above Signal' : null, f.bullVolUp ? 'Volume increasing' : null, f.bullVolDown ? 'Volume decreasing' : null, f.bullFakeBreakout ? 'Fake breakout' : null, f.bullReversal ? 'Reversal' : null, f.bullGreenCandle ? 'Green candle entry (entry only while forming candle is green)' : null].filter(Boolean));
    add('bearish', [f.incDown ? 'Increasing downward' : null, f.gapDown ? 'Gap decreasing' : null, f.incDownAll ? 'Increasing downward (all)' : null, f.gtDown ? 'Greater than' : null, f.ltDown ? 'Less than' : null, f.crossDown ? 'Crossed below' : null, f.paneCrossDown ? 'Pane crossover' : null, f.paneIncDownAll ? 'Pane all lines increasing downward' : null, f.bearBbwInc ? 'BBW increasing' : null, f.bearBbCrossBelow ? 'Close crossed below BB middle band (upper+lower expanding)' : null, f.bearPcCrossBelow ? 'Close crossed below price channel middle line' : null, f.bearSmf ? 'Smart Money Flow bearish' : null, f.bearVl ? 'Volume Line falling + volume increasing' : null, f.bearAsr ? 'Resistance gap widening (price falling away below resistance)' : null, f.bearOit ? 'OI Trend increasing downward' : null, f.bearEma9_21 ? 'EMA 9 crossed below EMA 21' : null, f.bearEma21_35 ? 'EMA 21 crossed below EMA 35' : null, f.bearEma35_50 ? 'EMA 35 crossed below EMA 50' : null, f.bearEma50_100 ? 'EMA 50 crossed below EMA 100' : null, f.bearEma100_200 ? 'EMA 100 crossed below EMA 200' : null, f.bearEma200_300 ? 'EMA 200 crossed below EMA 300' : null, f.bearSt10_1_2 ? 'Supertrend(10,1) crossed below Supertrend(10,2)' : null, f.bearSt10_2_3 ? 'Supertrend(10,2) crossed below Supertrend(10,3)' : null, f.bearSt1CloseCrossBelow ? 'Close crossed below Supertrend(10,1) (ST crossed above close)' : null, f.bearVwapCloseCrossBelow ? 'Close crossed below VWAP' : null, f.bearMeetEma9_21 ? 'EMA 9 below EMA 21' : null, f.bearMeetEma21_35 ? 'EMA 21 below EMA 35' : null, f.bearMeetEma35_50 ? 'EMA 35 below EMA 50' : null, f.bearMeetEma50_100 ? 'EMA 50 below EMA 100' : null, f.bearMeetEma100_200 ? 'EMA 100 below EMA 200' : null, f.bearMeetEma200_300 ? 'EMA 200 below EMA 300' : null, f.bearMeetSt10_1_2 ? 'Supertrend(10,1) below Supertrend(10,2)' : null, f.bearMeetSt10_2_3 ? 'Supertrend(10,2) below Supertrend(10,3)' : null, f.bearMeetCloseSt ? 'Close below Supertrend(10,1) (ST above close)' : null, f.bearMeetCloseVwap ? 'Close below VWAP' : null, f.bearMeetPaneCross ? 'Pane main line below signal' : null, f.bearMeetCross ? 'Primary below twin line' : null, f.bearMeetCloseBb ? 'Close below BB middle band (middle falling)' : null, f.bearMeetClosePc ? 'Close below price channel middle line (middle falling)' : null, f.bearMeetVl ? 'Volume Line below Signal' : null, f.bearVolUp ? 'Volume increasing' : null, f.bearVolDown ? 'Volume decreasing' : null, f.bearFakeBreakout ? 'Fake breakout' : null, f.bearReversal ? 'Reversal' : null, f.bearRedCandle ? 'Red candle entry (entry only while forming candle is red)' : null].filter(Boolean));
    PB_BULL_KEYS.forEach(k => { if (f.bullish && f[k]) out.push('Bullish: ' + pbrName(k)); });
    PB_BEAR_KEYS.forEach(k => { if (f.bearish && f[k]) out.push('Bearish: ' + pbrName(k)); });
    PBG_BULL_KEYS.forEach(k => { if (f.bullish && f[k]) out.push('Bullish: ' + pbgName(k)); });
    PBG_BEAR_KEYS.forEach(k => { if (f.bearish && f[k]) out.push('Bearish: ' + pbgName(k)); });
    OB_BULL_KEYS.forEach(k => { if (f.bullish && f[k]) out.push('Bullish: ' + obrName(k)); });
    OB_BEAR_KEYS.forEach(k => { if (f.bearish && f[k]) out.push('Bearish: ' + obrName(k)); });
    MEET_BULL_KEYS.forEach(k => { if (f.bullish && f[k]) out.push('Bullish: ' + ovlMeetName(k)); });
    MEET_BEAR_KEYS.forEach(k => { if (f.bearish && f[k]) out.push('Bearish: ' + ovlMeetName(k)); });
    return out;
  }

  function filterSummary() {
    return selectedFilterNames().join(' | ');
  }

  function syncFilterSections(masterOff) {
    if (!state.filters) return;
    const masters = { bullish: 'astFilterBullish', bearish: 'astFilterBearish' };
    const subs = {
      bullish: [['astFilterIncUp', 'incUp'], ['astFilterGapUp', 'gapUp'], ['astFilterIncUpAll', 'incUpAll'], ['astFilterCrossUp', 'crossUp'], ['astFilterGtUp', 'gtUp'], ['astFilterLtUp', 'ltUp'], ['astFilterPaneCrossUp', 'paneCrossUp'], ['astFilterPaneIncUpAll', 'paneIncUpAll']].concat(FILTER_EXTRA_KEYS.filter(k => k.indexOf('bull') === 0).map(k => ['astFilter' + capId(k), k]), STREAM_FLAG_KEYS.filter(k => k.indexOf('bull') === 0).map(k => ['astFilter' + capId(k), k])),
      bearish: [['astFilterIncDown', 'incDown'], ['astFilterGapDown', 'gapDown'], ['astFilterIncDownAll', 'incDownAll'], ['astFilterCrossDown', 'crossDown'], ['astFilterGtDown', 'gtDown'], ['astFilterLtDown', 'ltDown'], ['astFilterPaneCrossDown', 'paneCrossDown'], ['astFilterPaneIncDownAll', 'paneIncDownAll']].concat(FILTER_EXTRA_KEYS.filter(k => k.indexOf('bear') === 0).map(k => ['astFilter' + capId(k), k]), STREAM_FLAG_KEYS.filter(k => k.indexOf('bear') === 0).map(k => ['astFilter' + capId(k), k]))
    };
    Object.keys(masters).forEach(sec => {
      let on = !!state.filters[sec];
      if (!(masterOff && masterOff[sec])) (subs[sec] || []).forEach(p => { if (state.filters[p[1]]) on = true; });
      state.filters[sec] = on;
      const box = $id(masters[sec]);
      if (box) box.checked = on;
      const secEl = $id('astFilterSection' + (sec === 'bullish' ? 'Bullish' : 'Bearish'));
      if (secEl) secEl.style.opacity = on ? '1' : '0.45';
      (subs[sec] || []).forEach(p => {
        const el = $id(p[0]);
        if (!el) return;
        el.checked = !!state.filters[p[1]];
      });
    });
  }

  /* Reflect the "All indicators & filters together" checkbox from saved state. */
  function applyAllInOneToUI() {
    const el = $id('astAllInOne');
    if (el) el.checked = state.allInOne === true;
  }

  function applyModeToUI() {
    const cmEl = $id('astCallManual');
    if (cmEl) cmEl.checked = state.callManual !== false;
    const aiEl = $id('astAiPick');
    if (aiEl) aiEl.checked = !!state.aiPick;
    const nEl = $id('astAiPickN');
    if (nEl) nEl.value = Math.max(1, Number(state.aiPickN) || 5);
    const bEl = $id('astAiPickBull');
    if (bEl) bEl.checked = state.aiPickBull !== false;
    const rEl = $id('astAiPickBear');
    if (rEl) rEl.checked = state.aiPickBear !== false;
  }

  function readModeUI() {
    const cmEl = $id('astCallManual');
    if (cmEl) state.callManual = cmEl.checked;
    const aiEl = $id('astAiPick');
    if (aiEl) state.aiPick = aiEl.checked;
    const nEl = $id('astAiPickN');
    if (nEl) state.aiPickN = Math.max(1, Number(nEl.value) || 5);
    const bEl = $id('astAiPickBull');
    if (bEl) state.aiPickBull = bEl.checked;
    const rEl = $id('astAiPickBear');
    if (rEl) state.aiPickBear = rEl.checked;
    save();
    render();
    const mode = [];
    if (state.callManual !== false) mode.push('manual selection');
    if (state.aiPick) {
      const sides = [];
      if (state.aiPickBull !== false) sides.push('bullish');
      if (state.aiPickBear !== false) sides.push('bearish');
      mode.push('AI picks top ' + state.aiPickN + ' from ' + (sides.length ? sides.join(' + ') : 'none'));
    }
    log('Selected strategies mode: ' + (mode.length ? mode.join(' + ') : 'none (nothing will run)'), mode.length ? 'ok' : 'warn');
  }

  /* ---------------- index selection UI ---------------- */
  function indexSymbolsList() {
    const list = (typeof SYMBOLS !== 'undefined' && Array.isArray(SYMBOLS)) ? SYMBOLS : [];
    return list.filter(s => s[3] === 'INDEX')
      .map(s => ({ id: Number(s[1]), exch: s[2], inst: s[3], name: s[0], ocId: s[4], ocExch: s[5], grp: s[6] }));
  }

  function populateMoversIndicesUI() {
    const el = $id('astMoversIndicesSelect');
    if (!el || el.dataset.populated) return;
    const list = indexSymbolsList();
    if (!list.length) return;
    list.forEach(it => {
      const o = document.createElement('option');
      o.value = JSON.stringify(it);
      o.textContent = displayName(it);
      el.appendChild(o);
    });
    el.dataset.populated = '1';
  }

  function addMoverIndex() {
    const el = $id('astMoversIndicesSelect');
    if (!el || !el.value) { log('Select an index to add', 'warn'); return; }
    let it;
    try { it = JSON.parse(el.value); } catch (e) { return; }
    if (!state.movers) state.movers = { enabled: false, gainers: 5, losers: 5, indices: [] };
    if (!Array.isArray(state.movers.indices)) state.movers.indices = [];
    const exists = state.movers.indices.some(s => String(s.id) === String(it.id) && String(s.exch || '') === String(it.exch || ''));
    if (!exists) {
      state.movers.indices.push(it);
      save();
      renderMoversIndicesList();
      log('Added index ' + displayName(it), 'ok');
      prewarmChain(it, false);
    }
  }

  function removeMoverIndex(id, exch) {
    if (!state.movers) state.movers = { enabled: false, gainers: 5, losers: 5, indices: [] };
    state.movers.indices = (state.movers.indices || []).filter(s => !(String(s.id) === String(id) && String(s.exch || '') === String(exch || '')));
    save();
    renderMoversIndicesList();
  }

  function renderMoversIndicesList() {
    const el = $id('astMoversIndicesList');
    if (!el) return;
    const mv = state.movers || {};
    const idx = Array.isArray(mv.indices) ? mv.indices : [];
    el.innerHTML = idx.map(s =>
      '<span style="background:#1a1a35;border:1px solid #2d2d50;border-radius:3px;padding:2px 6px;display:inline-flex;align-items:center;gap:4px">' +
      esc(displayName(s)) +
      '<span onclick="AISmartTrading.removeMoverIndex(\'' + esc(String(s.id)) + '\',\'' + esc(s.exch || '') + '\')" style="color:#ef5350;cursor:pointer;font-weight:700">x</span>' +
      '</span>').join('');
  }

  /* Symbol master (id:exch -> symbol object) for the top gainers / losers list,
     so inline Add/Remove buttons can re-look-up the full symbol cheaply. */
  const _moverMaster = {};
  function ensureMoverMaster() {
    if (Object.keys(_moverMaster).length) return;
    const list = (typeof SYMBOLS !== 'undefined' && Array.isArray(SYMBOLS)) ? SYMBOLS : [];
    list.forEach(s => {
      const name = s[0], id = Number(s[1]), exch = s[2], inst = s[3], ocId = s[4], ocExch = s[5], grp = s[6];
      if (!id) return;
      _moverMaster[String(id) + ':' + (exch || '')] = { name, id, exch, inst, ocId, ocExch, grp };
    });
  }
  function moverKeyOf(s) { return String(s.id) + ':' + (s.exch || ''); }
  function isMoverPicked(s) {
    const mv = state.movers || {};
    const picked = Array.isArray(mv.picked) ? mv.picked : [];
    return picked.some(x => moverKeyOf(x) === moverKeyOf(s));
  }
  function addPickedMover(id, exch) {
    ensureMoverMaster();
    const sym = _moverMaster[String(id) + ':' + (exch || '')];
    if (!sym) return;
    if (!state.movers) state.movers = { enabled: false, gainers: 5, losers: 5, indices: [], picked: [] };
    if (!Array.isArray(state.movers.picked)) state.movers.picked = [];
    if (!state.movers.picked.some(x => moverKeyOf(x) === moverKeyOf(sym))) {
      state.movers.picked.push(sym);
      save();
      renderMoversList();
      log('Added ' + displayName(sym) + ' to top movers - strategies now run on it', 'ok');
    }
  }
  function removePickedMover(id, exch) {
    if (!state.movers) state.movers = { enabled: false, gainers: 5, losers: 5, indices: [], picked: [] };
    state.movers.picked = (state.movers.picked || []).filter(x => !(String(x.id) === String(id) && String(x.exch || '') === String(exch || '')));
    save();
    renderMoversList();
  }

  function renderMoversList() {
    const host = $id('astMoversList');
    if (!host) return;
    const mv = state.movers || {};
    host.style.display = '';
    const qm = quoteCache();
    ensureMoverMaster();
    const list = (typeof SYMBOLS !== 'undefined' && Array.isArray(SYMBOLS)) ? SYMBOLS : [];
    const byId = {};
    list.forEach(s => {
      const name = s[0], id = Number(s[1]), exch = s[2], inst = s[3], ocId = s[4], ocExch = s[5], grp = s[6];
      /* Commodities live in SYMBOLS too but are a SEPARATE, toggle-gated
         universe (state.commodity) - the movers / trend auto-scans must never
         pick them, or strategies run on commodities while the commodity toggle
         is OFF and nothing is +Add-ed. */
      if (!id || inst === 'INDEX' || isCommodity({ exch: exch, inst: inst, ocExch: ocExch })) return;
      byId[String(id) + ':' + (exch || '')] = { name, id, exch, inst, ocId, ocExch, grp };
    });
    const quoted = [];
    for (const k in byId) {
      const s = byId[k];
      const q = qm[s.exch === 'IDX_I' ? 'IDX_I:' + s.id : String(s.id)];
      if (!q || q.change_pct === undefined) continue;
      quoted.push({ sym: s, name: displayName(s), pct: Number(q.change_pct) });
    }
    const withPct = quoted.filter(x => !isNaN(x.pct));
    const LIMIT = 20;
    const gainers = withPct.filter(x => x.pct >= 0).sort((a, b) => b.pct - a.pct).slice(0, LIMIT);
    const losers = withPct.filter(x => x.pct < 0).sort((a, b) => a.pct - b.pct).slice(0, LIMIT);
    const pctSpan = (pct) => (pct === null || pct === undefined)
      ? '<span style="color:#888">--</span>'
      : '<span style="color:' + (pct >= 0 ? '#00d4aa' : '#ef5350') + '">' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%</span>';
    const addBtn = (sym) =>
      '<button class="btn-action" style="width:auto;padding:0 6px;margin:0 0 0 6px;font-size:8px;line-height:1.6" onclick="AISmartTrading.addPickedMover(\'' + esc(String(sym.id)) + '\',\'' + esc(sym.exch || '') + '\')">Add</button>';
    const removeBtn = (sym) =>
      '<button class="btn-action" style="width:auto;padding:0 6px;margin:0 0 0 6px;font-size:8px;line-height:1.6;background:#ef5350;color:#fff" onclick="AISmartTrading.removePickedMover(\'' + esc(String(sym.id)) + '\',\'' + esc(sym.exch || '') + '\')">Remove</button>';
    const row = (it) => {
      const btn = isMoverPicked(it.sym) ? removeBtn(it.sym) : addBtn(it.sym);
      return '<div style="display:inline-block;min-width:210px;margin:0 12px 2px 0">' + esc(it.name) + ' <span style="color:#666">::</span> ' + pctSpan(it.pct) + btn + '</div>';
    };
    let html = '';
    const picked = Array.isArray(mv.picked) ? mv.picked : [];
    if (picked.length) {
      html += '<div style="color:#ffd700;font-weight:700;margin:2px 0">Selected (strategies run on these):</div>' +
        picked.map(s =>
          '<span style="background:#1a1a35;border:1px solid #2d2d50;border-radius:3px;padding:2px 6px;display:inline-flex;align-items:center;gap:4px;margin:0 6px 2px 0">' +
          esc(displayName(s)) +
          '<span onclick="AISmartTrading.removePickedMover(\'' + esc(String(s.id)) + '\',\'' + esc(s.exch || '') + '\')" style="color:#ef5350;cursor:pointer;font-weight:700">x</span>' +
          '</span>').join('') + '<br>';
    }
    if (gainers.length) html += '<div style="color:#00d4aa;font-weight:700;margin:2px 0">Top Gainers:</div>' + gainers.map(row).join('') + '<br>';
    if (losers.length) html += '<div style="color:#ef5350;font-weight:700;margin:2px 0">Top Losers:</div>' + losers.map(row).join('') + '<br>';
    const wantIdx = Array.isArray(mv.indices) ? mv.indices : [];
    if (wantIdx.length) {
      html += '<div style="color:#ffd700;font-weight:700;margin:2px 0">Indices:</div>' +
        wantIdx.map(s => {
          const q = qm[s.exch === 'IDX_I' ? 'IDX_I:' + s.id : String(s.id)];
          return '<div style="display:inline-block;min-width:170px;margin:0 12px 2px 0">' + esc(displayName(s)) + ' <span style="color:#666">::</span> ' + pctSpan(q && q.change_pct !== undefined ? Number(q.change_pct) : null) + '</div>';
        }).join('');
    }
    if (!html) html = '<span style="color:#888">No live quotes yet - connect to Dhan to see daily top gainers / losers.</span>';
    if (!mv.enabled) html = '<div style="color:#888;font-size:9px;margin-bottom:2px">Top Movers is <b style="color:#e67e22">OFF</b> - toggle it ON to run AI Smart Trading on these.</div>' + html;
    host.innerHTML = html;
  }

  /* Live list of the option strikes the engine picked up to execute paper trade
     / backtest. Each symbol shows its resolved CE / PE strikes with the live
     premium, exactly as contractsFor() resolved them for the current run. */
  function renderPickedStrikes() {
    const host = $id('astStrikesList');
    if (!host) return;
    if (!state.showPickedStrikes) { host.style.display = 'none'; return; }
    host.style.display = '';
    if (!_pickedStrikes.size) {
      host.innerHTML = '<span style="color:#888">No strikes picked up yet - run paper trading / backtest to resolve the option strikes.</span>';
      return;
    }
    const qm = quoteCache();
    let html = '';
    _pickedStrikes.forEach((rec, sid) => {
      if (!rec || !rec.contracts || !rec.contracts.length) return;
      const sym = rec.symbol || {};
      const name = displayName(sym);
      const chips = rec.contracts.map(c => {
        let q = null;
        if (c.sid != null) q = qm[String(c.sid)];
        const prem = (q && q.ltp != null) ? Number(q.ltp) : (c.premium != null ? Number(c.premium) : null);
        return '<span style="display:inline-block;background:#1a1a35;border:1px solid #2d2d50;border-radius:3px;padding:2px 7px;margin:0 4px 3px 0">' +
          esc(name) + ' <b style="color:' + (c.optionType === 'PE' ? '#ef5350' : '#00d4aa') + '">' + esc(String(c.strike)) + ' ' + esc(c.optionType) + '</b>' +
          ' <span style="color:#888">' + fmt2(prem) + '</span></span>';
      }).join('');
      if (chips) html += '<div style="margin:2px 0">' + chips + '</div>';
    });
    if (!html) html = '<span style="color:#888">No strikes picked up yet - run paper trading / backtest to resolve the option strikes.</span>';
    host.innerHTML = html;
  }

  function toggleStrikes() {
    state.showPickedStrikes = !state.showPickedStrikes;
    save();
    const btn = $id('astStrikesToggle');
    if (btn) {
      btn.textContent = 'Picked Strikes: ' + (state.showPickedStrikes ? 'ON' : 'OFF');
      btn.style.background = state.showPickedStrikes ? '#00d4aa' : '#e67e22';
    }
    renderPickedStrikes();
    log('Picked strikes list ' + (state.showPickedStrikes ? 'enabled' : 'disabled'), state.showPickedStrikes ? 'ok' : 'warn');
  }

  /* ---------------- UI sync ---------------- */

  function applyUniversalToUI() {
    const u = state.universal;
    const set = (id, v) => { const el = $id(id); if (el) el.value = v; };
    set('astLotSize', u.lotSize != null ? u.lotSize : '');
    set('astLots', u.lots);
    set('astMargin', u.margin);
    set('astTp', u.tpPct);
    const mtEl = $id('astManualTrail'); if (mtEl) mtEl.checked = u.manualTrail !== false;
    const aiSlEl = $id('astAiSl'); if (aiSlEl) aiSlEl.checked = u.aiSl !== false;
    const slAutoEl = $id('astSlAuto'); if (slAutoEl) slAutoEl.checked = u.aiSl !== false;
    const aiTpEl = $id('astAiTp'); if (aiTpEl) aiTpEl.checked = u.aiTp !== false;
    const mslEl = $id('astManualSL'); if (mslEl) mslEl.checked = u.manualSL === true;
    const mslPctEl = $id('astManualSLPct'); if (mslPctEl) mslPctEl.value = (Number(u.manualSLPct) > 0 ? u.manualSLPct : 1);
    const mtslEl = $id('astManualTrailSL'); if (mtslEl) mtslEl.checked = u.manualTrailSL === true;
    const mtslPctEl = $id('astManualTrailSLPct'); if (mtslPctEl) mtslPctEl.value = (Number(u.manualTrailSLPct) > 0 ? u.manualTrailSLPct : '');
    const mttEl = $id('astManualTrailTP'); if (mttEl) mttEl.checked = u.manualTrailTP === true;
    const mttPctEl = $id('astManualTrailTPPct'); if (mttPctEl) mttPctEl.value = (Number(u.manualTrailTPPct) > 0 ? u.manualTrailTPPct : 20);
    const mtpEl = $id('astManualTP'); if (mtpEl) mtpEl.checked = u.manualTP === true;
    const mtpPctEl = $id('astManualTPPct'); if (mtpPctEl) mtpPctEl.value = (Number(u.manualTPPct) > 0 ? u.manualTPPct : 5);
    const aitpEl = $id('astAiTP'); if (aitpEl) aitpEl.checked = !!u.aiTP;
    const rrEl = $id('astRrEnabled'); if (rrEl) rrEl.checked = u.rrEnabled === true;
    const rrValEl = $id('astRrValue'); if (rrValEl) rrValEl.value = (Number(u.rrValue) > 0 ? u.rrValue : 2);
    const mtfEl = $id('astMtf'); if (mtfEl) mtfEl.checked = u.mtfConfirm === true;
    const tf1El = $id('astTf1min'); if (tf1El) tf1El.checked = (u.tfs ? u.tfs['1min'] !== false : true);
    const tf5El = $id('astTf5min'); if (tf5El) tf5El.checked = (u.tfs ? u.tfs['5min'] !== false : true);
    const useOwnEl = $id('astUseOwnSettings'); if (useOwnEl) useOwnEl.checked = u.astUseOwnSettings === true;
    const dpEl = $id('astDataPool'); if (dpEl) dpEl.checked = state.dataPool === true;
    const dpBody = $id('astDataPoolBody'); if (dpBody) dpBody.style.display = state.dataPool ? 'block' : 'none';
    const dpInfo = $id('astDataPoolInfo'); if (dpInfo) dpInfo.textContent = state.dataPool ? 'scanning...' : 'OFF - shared pool feeds strategies only';
    syncFastDataUI();
    const tlEl = $id('astTradeLimit'); if (tlEl) tlEl.checked = !!u.tradeLimitEnabled;
    const tlCntEl = $id('astTradeLimitCount'); if (tlCntEl) tlCntEl.value = (Number(u.tradeLimitCount) > 0 ? u.tradeLimitCount : 5);
    const aiTrEl = $id('astAiTrades'); if (aiTrEl) aiTrEl.checked = !!u.aiTrades;
    const hftEl = $id('astHft'); if (hftEl) hftEl.checked = !!u.hft;
    const hftOpsEl = $id('astHftOps'); if (hftOpsEl) hftOpsEl.value = (Number(u.hftOps) > 0 ? u.hftOps : 6);
    const hftExecCbEl = $id('astHftExecOnCb'); if (hftExecCbEl) hftExecCbEl.checked = u.hftExecEnabled !== false;
    const hftExecEl = $id('astHftExecOn'); if (hftExecEl) hftExecEl.value = (['open', 'high', 'low', 'close'].indexOf(u.hftExecOn) >= 0 ? u.hftExecOn : 'close');
    const flEl = $id('astFnoLimit'); if (flEl) flEl.checked = u.fnoLimit !== false;
    const staEl = $id('astStartTradeAfter'); if (staEl) staEl.value = u.startTradeAfter || '09:15';
    const staOnEl = $id('astStartTradeAfterEnabled'); if (staOnEl) staOnEl.checked = !!u.startTradeAfterEnabled;
    const ntaEl = $id('astNoTradeAfter'); if (ntaEl) ntaEl.value = u.noTradeAfter || '15:30';
    const ntaOnEl = $id('astNoTradeAfterEnabled'); if (ntaOnEl) ntaOnEl.checked = !!u.noTradeAfterEnabled;
    const asoEl = $id('astAutoSquareOffTime'); if (asoEl) asoEl.value = u.autoSquareOffTime || '15:20';
    const asoOnEl = $id('astAutoSquareOffEnabled'); if (asoOnEl) asoOnEl.checked = !!u.autoSquareOffEnabled;
    syncHftUI();
    syncManualTrailUI();
    syncManualSlTpUI();
    syncRrUI();
    syncTimeframeUI();
    syncTradesUI();
    syncTimeGateUI();
    syncStrategyOverrideUI();
    const st = state.strike || {};
    set('astStrikeMode', st.mode || 'both_atm');
    set('astStrikeCount', st.count || 3);
    set('astOptionType', st.optionType || 'both');
    const posEl = $id('astOnlyPositive'); if (posEl) posEl.checked = st.positiveOnly !== false;
    const fastEl = $id('astFastestRising'); if (fastEl) fastEl.checked = st.fastestRising === true;
    const fastCntEl = $id('astFastestCount');
    if (fastCntEl) fastCntEl.value = Number.isFinite(Number(st.fastestCount)) && Math.floor(Number(st.fastestCount)) >= 1 ? Math.floor(Number(st.fastestCount)) : 3;
    if (st.fastestRising === true) {
      const modeEl = $id('astStrikeMode');
      if (modeEl && modeEl.value !== 'both_atm' && modeEl.value !== 'both_atm_inc') {
        modeEl.value = 'both_atm_inc';
        state.strike.mode = 'both_atm_inc';
      }
      // +green is implied by fastest-rising: keep it force-checked on reload too.
      if (posEl) posEl.checked = true;
      state.strike.positiveOnly = true;
    }
    syncStrikeUI();
    const ri = state.runIn || (state.runIn = { index: 'both', fno: 'spot', comm: 'spot', default: false });
    set('astRunInIndex', ri.index || 'both');
    set('astRunInFno', ri.fno || 'spot');
    set('astRunInComm', ri.comm || 'spot');
    const runInDefEl = $id('astRunInDefault'); if (runInDefEl) runInDefEl.checked = ri.default === true;
    const ti = state.tradeIn || (state.tradeIn = { index: 'premium', fno: 'premium', comm: 'spot', default: false });
    set('astTradeInIndex', ti.index || 'premium');
    set('astTradeInFno', ti.fno || 'premium');
    set('astTradeInComm', ti.comm || 'spot');
    const tradeInDefEl = $id('astTradeInDefault'); if (tradeInDefEl) tradeInDefEl.checked = ti.default === true;
    syncPremiumOnlyUI();
    const enabledGroups = (state.groups && state.groups.length) ? state.groups : GROUP_KEYS.slice();
    GROUPS.forEach(g => {
      const el = $id('astGroup_' + g.key);
      if (el) el.checked = enabledGroups.indexOf(g.key) >= 0;
    });
    const f = state.filters || (state.filters = { bullish: false, bearish: false, incUp: false, incDown: false, gapUp: false, gapDown: false, incUpAll: false, incDownAll: false, crossUp: false, crossDown: false, gtUp: false, ltUp: false, gtDown: false, ltDown: false });
    [['astFilterBullish', 'bullish'], ['astFilterBearish', 'bearish'], ['astFilterIncUp', 'incUp'], ['astFilterIncDown', 'incDown'], ['astFilterGapUp', 'gapUp'], ['astFilterGapDown', 'gapDown'], ['astFilterIncUpAll', 'incUpAll'], ['astFilterIncDownAll', 'incDownAll'], ['astFilterCrossUp', 'crossUp'], ['astFilterCrossDown', 'crossDown'], ['astFilterGtUp', 'gtUp'], ['astFilterLtUp', 'ltUp'], ['astFilterGtDown', 'gtDown'], ['astFilterLtDown', 'ltDown']].concat(FILTER_EXTRA_KEYS.map(k => ['astFilter' + capId(k), k]), STREAM_FLAG_KEYS.map(k => ['astFilter' + capId(k), k])).forEach(p => {
      const el = $id(p[0]);
      if (el) el.checked = !!f[p[1]];
      else f[p[1]] = false;
    });
    syncFilterSections();
    applyAllInOneToUI();
    applyRunModeUI();
    applyMoversToUI();
    applyNiftyTrendToUI();
    applySimToUI();
    applyModeToUI();
    const stBtn = $id('astStrikesToggle');
    if (stBtn) {
      stBtn.textContent = 'Picked Strikes: ' + (state.showPickedStrikes ? 'ON' : 'OFF');
      stBtn.style.background = state.showPickedStrikes ? '#00d4aa' : '#e67e22';
    }
    renderPickedStrikes();
    const t = $id('astAutoToggle');
    if (t) { t.textContent = 'AI Smart Trading: ' + (state.enabled ? 'ON' : 'OFF'); t.style.background = state.enabled ? '#00d4aa' : '#e67e22'; }
  }

  function syncManualTrailUI() {
    const mtEl = $id('astManualTrail'), tpEl = $id('astTp');
    if (tpEl && mtEl) tpEl.disabled = !mtEl.checked;
  }

  /* Manual Stop-Loss / Manual Trail TP / Manual TP override the AI risk
     management. Manual/AI are mutually exclusive per rule: when one is ticked
     its counterpart is faded out and unclickable, and the matching manual %
     input only enables while its checkbox is on. */
  function syncManualSlTpUI() {
    const u = state.universal || {};
    const mslEl = $id('astManualSL'), mslPctEl = $id('astManualSLPct');
    const mtslEl = $id('astManualTrailSL'), mtslPctEl = $id('astManualTrailSLPct');
    const mttEl = $id('astManualTrailTP'), mttPctEl = $id('astManualTrailTPPct');
    const mtpEl = $id('astManualTP'), mtpPctEl = $id('astManualTPPct');
    const aiSlEl = $id('astAiSl'), aiTpEl = $id('astAiTp'), aitpEl = $id('astAiTP');
    const fade = (el, on) => {
      if (!el) return;
      el.disabled = on;
      el.style.opacity = on ? '0.35' : '1';
      el.style.pointerEvents = on ? 'none' : '';
      el.style.cursor = on ? 'not-allowed' : '';
      const lbl = el.closest ? el.closest('label') : null;
      if (lbl) { lbl.style.opacity = on ? '0.35' : '1'; lbl.style.pointerEvents = on ? 'none' : ''; lbl.style.cursor = on ? 'not-allowed' : ''; }
    };
    const manualSLOn = u.manualSL === true;
    const aiSlOn = !manualSLOn && u.aiSl !== false;
    const manualTrailTPOn = u.manualTrailTP === true;
    const aiTpOn = !manualTrailTPOn && u.aiTp !== false;
    const manualTPOn = u.manualTP === true;
    const aiTPOn = !manualTPOn && u.aiTP !== false;
    const trailSLOn = u.manualTrailSL === true;
    /* Manual Overall SL and Manual Trail SL are NOT mutually exclusive: the
       overall SL is a fixed % below the entry (capital protection floor) while
       the trailing SL ratchets the stop up behind the peak - the trailing stop
       never moves below the overall floor. Both are passed to autoEntry and
       combined in PaperTrade, so keep both checkboxes usable side by side. */
    fade(aiSlEl, manualSLOn || trailSLOn);
    fade(mslEl, aiSlOn);
    fade(mtslEl, aiSlOn);
    fade(aiTpEl, manualTrailTPOn);
    fade(mttEl, aiTpOn);
    fade(aitpEl, manualTPOn);
    fade(mtpEl, aiTPOn);
    if (mslPctEl) { const on = !!(mslEl && mslEl.checked); mslPctEl.disabled = !on || aiSlOn; mslPctEl.style.opacity = (on && !aiSlOn) ? '1' : '0.5'; }
    if (mtslPctEl) { const on = !!(mtslEl && mtslEl.checked); mtslPctEl.disabled = !on || aiSlOn; mtslPctEl.style.opacity = (on && !aiSlOn) ? '1' : '0.5'; }
    if (mttPctEl) { const on = !!(mttEl && mttEl.checked); mttPctEl.disabled = !on || aiTpOn; mttPctEl.style.opacity = (on && !aiTpOn) ? '1' : '0.5'; }
    if (mtpPctEl) { const on = !!(mtpEl && mtpEl.checked); mtpPctEl.disabled = !on || aiTPOn; mtpPctEl.style.opacity = (on && !aiTPOn) ? '1' : '0.5'; }
  }

  /* The Risk:Reward target-RR input only matters while the "Set TP by
     Risk:Reward" checkbox is on. When RR is on it overrides the manual / AI
     TP % (target = SL % x Target RR), so those TP controls fade out; when RR
     is off they are left to the mutual-exclusion logic in syncManualSlTpUI. */
  function syncRrUI() {
    const rrEl = $id('astRrEnabled'), rrValEl = $id('astRrValue');
    const on = !!(rrEl && rrEl.checked);
    if (rrValEl) { rrValEl.disabled = !on; rrValEl.style.opacity = on ? '1' : '0.5'; rrValEl.style.pointerEvents = on ? '' : 'none'; }
    if (!on) return;
    const mtpEl = $id('astManualTP'), aitpEl = $id('astAiTP');
    const fade = (el) => {
      if (!el) return;
      el.disabled = true;
      el.style.opacity = '0.35';
      el.style.pointerEvents = 'none';
      el.style.cursor = 'not-allowed';
      const lbl = el.closest ? el.closest('label') : null;
      if (lbl) { lbl.style.opacity = '0.35'; lbl.style.pointerEvents = 'none'; lbl.style.cursor = 'not-allowed'; }
    };
    fade(mtpEl);
    fade(aitpEl);
  }

  function syncStrikeUI() {
    const modeEl = $id('astStrikeMode'), cntEl = $id('astStrikeCount');
    if (!modeEl) return;
    const atm = modeEl.value === 'atm';
    /* Fastest-rising checkbox ON: the normal "Number of Strikes" pool input is
       inactive (the fastest-rising number drives the run) and the dedicated
       fastest-count number input becomes active. Off: the normal count input
       follows the ATM/near pool as before and the fastest-count input fades. */
    const fastOn = !!(state.strike && state.strike.fastestRising === true);
    if (cntEl) {
      const dis = atm || fastOn;
      cntEl.disabled = dis;
      cntEl.style.opacity = dis ? '0.35' : '1';
      cntEl.style.pointerEvents = dis ? 'none' : '';
      cntEl.style.background = dis ? '#0b0b1a' : '';
      cntEl.style.color = dis ? '#666' : '';
      cntEl.style.cursor = dis ? 'not-allowed' : '';
      const cntWrap = cntEl.closest ? cntEl.closest('label') : null;
      if (cntWrap) { cntWrap.style.opacity = dis ? '0.5' : '1'; cntWrap.style.pointerEvents = dis ? 'none' : ''; }
    }
    const fastCntEl = $id('astFastestCount');
    if (fastCntEl) {
      fastCntEl.disabled = !fastOn;
      fastCntEl.style.opacity = fastOn ? '1' : '0.35';
      fastCntEl.style.pointerEvents = fastOn ? '' : 'none';
      fastCntEl.style.background = fastOn ? '' : '#0b0b1a';
      fastCntEl.style.color = fastOn ? '' : '#666';
      fastCntEl.style.cursor = fastOn ? '' : 'not-allowed';
      const wrap = fastCntEl.closest ? fastCntEl.closest('label') : null;
      if (wrap) { wrap.style.opacity = fastOn ? '1' : '0.5'; wrap.style.pointerEvents = fastOn ? '' : 'none'; }
    }
    /* Fastest-rising already only ever picks positive (+green) LTP / LTP-change
       strikes, so the "Only +green premium strikes" checkbox is redundant while
       it is on: disable + fade it (it stays force-checked via
       onFastestRisingInput / applyUniversalToUI). Off: fully interactive again. */
    const posEl = $id('astOnlyPositive');
    if (posEl) {
      posEl.disabled = fastOn;
      posEl.style.opacity = fastOn ? '0.5' : '1';
      posEl.style.pointerEvents = fastOn ? 'none' : '';
      const posWrap = posEl.closest ? posEl.closest('label') : null;
      if (posWrap) { posWrap.style.opacity = fastOn ? '0.6' : '1'; posWrap.style.pointerEvents = fastOn ? 'none' : ''; }
    }
  }

  function syncTimeframeUI() {
    const tf1El = $id('astTf1min'), tf5El = $id('astTf5min');
    if (tf1El) { tf1El.disabled = false; tf1El.style.opacity = '1'; }
    if (tf5El) { tf5El.disabled = false; tf5El.style.opacity = '1'; }
  }

  /* AST controls that are auto-synced from the running strategy(s) get faded
     out (disabled + dimmed): the strategy drives that setting, so the AST
     control is read-only. Lot size / margin / TP / trail-TP stay interactive
     because those are user-owned regardless of the strategy. */
  const _overridePreserve = new Map();
  function fadeAstControls(ids) {
    const list = Array.isArray(ids) ? ids : (ids ? [ids] : []);
    list.forEach(id => {
      const el = $id(id);
      if (!el) return;
      if (!_overridePreserve.has(id)) {
        _overridePreserve.set(id, { checked: el.checked, value: el.value });
      }
      el.disabled = true;
      el.style.opacity = '0.45';
      el.classList.add('ast-faded');
      el.title = 'Controlled by the running strategy - edit it on the strategy to change.';
    });
  }
  function unfadeAstControls(ids) {
    const list = Array.isArray(ids) ? ids : (ids ? [ids] : []);
    list.forEach(id => {
      const el = $id(id);
      if (!el) return;
      const prev = _overridePreserve.get(id);
      if (prev) {
        if (typeof prev.checked === 'boolean') el.checked = prev.checked;
        if (prev.value !== undefined) el.value = prev.value;
        _overridePreserve.delete(id);
      }
      el.disabled = false;
      el.style.opacity = '1';
      el.classList.remove('ast-faded');
      el.title = '';
    });
  }

  /* Sync the global "Run Strategy In" control bar (Selected Strategies
     section). When Auto Select Mode is on the manual CE/PE dropdown fades out
     and becomes inactive (disabled); when the manual side control is chosen the
     Auto Select Mode checkbox fades out (still clickable, so the user can
     switch back to auto mode). The status text shows the effective side. */
  function syncRunStrategyInUI() {
    const rs = runStrategyInConfig();
    const enEl = $id('astRunInEnabled');
    const sideEl = $id('astRunInSide');
    const autoEl = $id('astRunInAutoCb');
    const autoWrap = $id('astRunInAuto');
    const statusEl = $id('astRunInStatus');
    if (enEl && enEl.checked !== rs.enabled) enEl.checked = rs.enabled;
    if (sideEl) {
      const sel = rs.side === 'PE' ? 'PE' : 'CE';
      if (sideEl.value !== sel) sideEl.value = sel;
      const autoActive = rs.auto;
      sideEl.disabled = autoActive;
      sideEl.style.opacity = autoActive ? '0.45' : '1';
    }
    if (autoEl && autoEl.checked !== rs.auto) autoEl.checked = rs.auto;
    if (autoWrap) autoWrap.style.opacity = rs.auto ? '1' : '0.45';
    if (statusEl) {
      if (!rs.enabled) {
        statusEl.textContent = 'off';
      } else if (rs.auto) {
        const auto = autoRunInSide(null);
        statusEl.textContent = auto
          ? 'auto: ' + auto
          : 'auto: ' + (rs.side === 'PE' ? 'PE' : 'CE') + ' (no signal - manual side)';
      } else {
        statusEl.textContent = 'manual: ' + (rs.side === 'PE' ? 'PE' : 'CE');
      }
    }
  }

  /* Auto-sync the AST universal controls to match every running strategy's own
     settings (TF, filters, SL / trail-SL) and fade those controls out. When
     multiple strategies disagree (or a setting is missing) the control stays
     interactive so the user can keep manual control. */
  function syncStrategyOverrideUI() {
    const ov = strategyOverrideStatus();
    const hasAny = ov.tf || ov.sl || ov.trailSl || ov.filters;
    const tfBoxes = ['astTf1min', 'astTf5min'];
    const slBoxes = ['astManualSL', 'astManualSLPct', 'astManualTrailSL', 'astManualTrailSLPct'];
    const filterIds = Array.from(document.querySelectorAll('[id^="astFilter"]')).map(el => el.id);
    if (!hasAny) {
      unfadeAstControls(tfBoxes.concat(slBoxes, filterIds));
      return;
    }
    if (ov.tf) {
      /* Display the running strategies' agreed timeframe inside the faded TF
         checkboxes (only when they all carry the same tf; otherwise keep the
         current display - each strategy still runs on its own tf). */
      const list = activeStrategies();
      const tfs = list.map(strategyOwnTf).filter(Boolean);
      const agreed = tfs.length && tfs.every(t => t === tfs[0]) ? tfs[0] : null;
      if (agreed) {
        const tf1El = $id('astTf1min'), tf5El = $id('astTf5min');
        if (tf1El) tf1El.checked = (agreed === '1min');
        if (tf5El) tf5El.checked = (agreed === '5min');
      }
      fadeAstControls(tfBoxes);
    } else {
      unfadeAstControls(tfBoxes);
    }
    if (ov.sl || ov.trailSl) {
      const list = activeStrategies();
      const sls = list.map(strategyOwnSl).filter(v => v != null);
      const agreedSl = sls.length && sls.every(v => v === sls[0]) ? sls[0] : null;
      const trails = list.map(strategyOwnTrailSl).filter(v => v != null);
      const agreedTrail = trails.length && trails.every(v => v === trails[0]) ? trails[0] : null;
      const slEl = $id('astManualSL'), slPctEl = $id('astManualSLPct');
      const tslEl = $id('astManualTrailSL'), tslPctEl = $id('astManualTrailSLPct');
      if (agreedSl != null) {
        if (slEl) slEl.checked = true;
        if (slPctEl) slPctEl.value = agreedSl;
      }
      if (agreedTrail != null) {
        if (tslEl) tslEl.checked = true;
        if (tslPctEl) tslPctEl.value = agreedTrail;
      }
      fadeAstControls(slBoxes);
    } else {
      unfadeAstControls(slBoxes);
    }
    if (ov.filters) fadeAstControls(filterIds);
    else unfadeAstControls(filterIds);
  }

  function syncTradesUI() {
    const tlEl = $id('astTradeLimit'), tlCntEl = $id('astTradeLimitCount');
    const aiOn = !!(state.universal && state.universal.aiTrades);
    if (tlEl && tlCntEl) {
      const on = tlEl.checked && !aiOn;
      tlCntEl.disabled = !on;
      tlCntEl.style.opacity = on ? '1' : '0.5';
    }
  }

  function syncTimeGateUI() {
    const u = state.universal || {};
    [['astStartTradeAfter', 'astStartTradeAfterEnabled'], ['astNoTradeAfter', 'astNoTradeAfterEnabled'], ['astAutoSquareOffTime', 'astAutoSquareOffEnabled']].forEach(([selId, chkId]) => {
      const sel = $id(selId), chk = $id(chkId);
      if (sel && chk) {
        const on = !!chk.checked;
        sel.disabled = !on;
        sel.style.opacity = on ? '1' : '0.5';
      }
    });
  }

  function applyMoversToUI() {
    const mv = state.movers || (state.movers = { enabled: false, gainers: 5, losers: 5, indices: [] });
    if (!Array.isArray(mv.indices)) mv.indices = [];
    // One-time migration from the old "Include all indices" checkbox: when it
    // was on and the user never picked explicit indices, seed with every index
    // symbol so previous behaviour is preserved.
    if (!mv._migrated && mv.includeIndices && !mv.indices.length) {
      const all = indexSymbolsList();
      if (all.length) {
        mv.indices = all;
        save();
      }
    }
    mv._migrated = true;
    delete mv.includeIndices;
    const btn = $id('astMoversToggle');
    const trendOn = !!(state.niftyTrend && state.niftyTrend.enabled);
    const simOn = !!(state.sim && state.sim.enabled);
    const blocked = trendOn || simOn;
    const active = !!mv.enabled && !blocked;
    if (btn) {
      btn.textContent = trendOn ? 'Top Movers: OFF - Trend Follow on' : (simOn ? 'Top Movers: OFF - Simulation on' : ('Top Movers: ' + (mv.enabled ? 'ON' : 'OFF')));
      btn.style.background = active ? '#00d4aa' : (blocked ? '#666' : '#e67e22');
      btn.style.opacity = blocked ? '0.6' : '1';
      btn.disabled = false;
    }
    const setVal = (id, v) => { const el = $id(id); if (el) el.value = v; };
    setVal('astMoversGainers', mv.gainers);
    setVal('astMoversLosers', mv.losers);
    populateMoversIndicesUI();
    renderMoversIndicesList();
    /* NIFTY Trend Following and Top Gainers/Losers + Indices are mutually
       exclusive: while trend-following is ON the movers sub-controls are faded
       out and disabled (the engine trades the trend-filtered F&O gainers/losers
       + selected indices instead). The toggle button itself stays clickable so
       turning it ON switches the engine out of trend mode. */
    ['astMoversGainers', 'astMoversLosers', 'astMoversIndicesSelect', 'astMoversIndicesAdd'].forEach(id => {
      const el = $id(id);
      if (el) {
        el.disabled = !active;
        el.style.opacity = active ? '1' : '0.5';
      }
    });
  }

  function updateAiSlStatus(text) {
    const el = $id('astAiSlStatus');
    if (el) el.textContent = text || '';
  }
  function updateAiTpStatus(text) {
    const el = $id('astAiTpStatus');
    if (el) el.textContent = text || '';
  }
  function updateAiTPStatus(text) {
    const el = $id('astAiTPStatus');
    if (el) el.textContent = text || '';
  }
  function updateRrStatus(text) {
    const el = $id('astRrStatus');
    if (el) el.textContent = text || '';
  }
  function updateAiTradesStatus(text) {
    const el = $id('astAiTradesStatus');
    if (el) el.textContent = text || '';
  }
  function updateHftStatus(text) {
    const el = $id('astHftStatus');
    if (el) el.textContent = text || '';
  }

  /* ---------------- rendering ---------------- */
  function strategyRow(s, isActive) {
    const sideCol = s.cat === 'bearish' ? '#ef5350' : '#00d4aa';
    const sideTag = 'LONG'; // buy-only engine: every trade executes LONG
    const checked = state.selected[s.id] ? 'checked' : '';
    const grp = groupOfStrategy(s);
    const gLabel = grp === 'other' ? 'Manual' : grp;
    return '<div style="display:flex;align-items:center;gap:8px;background:#12122a;border:1px solid ' + (isActive ? '#2d6d5a' : '#2d2d50') + ';border-radius:4px;padding:4px 8px;margin:2px 0;font-size:10px">' +
      '<input type="checkbox" data-key="' + esc(s.id) + '" ' + checked + ' style="accent-color:#00d4aa">' +
      '<span style="color:' + sideCol + ';font-weight:700;min-width:38px">' + sideTag + '</span>' +
      '<span style="color:#fff;flex:1">' + esc(s.name) + (s.tf ? ' <span style="color:#666">· ' + esc(s.tf) + '</span>' : '') + '</span>' +
      '<span style="color:#888;min-width:46px;text-align:right">' + esc(gLabel) + '</span>' +
      '<span style="color:' + (isActive ? '#00d4aa' : '#555') + ';min-width:52px;text-align:right;font-weight:700">' + (isActive ? 'ACTIVE' : 'IDLE') + '</span>' +
      '<button class="btn-action" style="width:auto;padding:2px 8px;margin:0;font-size:9px;background:#ffd700;color:#0a0a18" onclick="AISmartTrading.sendToFinal(\'' + esc(s.id) + '\')" title="Save this strategy to the Final Strategy section with its settings">Final</button>' +
      '</div>';
  }

  function populateManualSelect() {
    const el = $id('astManualSelect');
    if (!el) return;
    const existing = new Set([...(state.manual || []), ...(state.imported || []), ...(state.aiPicks || [])].map(s => s.id));
    const saved = loadSaved().filter(s => !existing.has(s.id));
    el.innerHTML = '<option value="">-- pick a saved strategy --</option>' + saved.map(s => {
      const side = 'LONG'; // buy-only engine
      return '<option value="' + esc(s.id) + '">' + esc(s.name) + ' (' + side + ')</option>';
    }).join('');
  }

  function addManual() {
    const el = $id('astManualSelect');
    if (!el || !el.value) { log('Pick a saved strategy from the dropdown first', 'warn'); return; }
    const src = loadSaved().find(s => String(s.id) === String(el.value));
    if (!src) { log('Strategy not found in saved strategies', 'warn'); return; }
    if ((state.manual || []).some(s => String(s.id) === String(src.id))) { log('Strategy already added', 'warn'); return; }
    const copy = JSON.parse(JSON.stringify(src));
    copy.addedManual = true;
    state.manual.push(copy);
    state.selected[src.id] = true;
    el.value = '';
    save();
    render();
    log('Added "' + src.name + '" to Selected Strategies (enabled)', 'ok');
  }

  function removeManual(id) {
    state.manual = (state.manual || []).filter(s => String(s.id) !== String(id));
    delete state.selected[id];
    save();
    render();
  }

  function fetchAiPick() {
    if (!state.aiPick) {
      state.aiPick = true;
      const aiEl = $id('astAiPick');
      if (aiEl) aiEl.checked = true;
      log('Enabled "Smart AI trader picked strategies" for fetching', 'ok');
    }
    readModeUI();
    const n = Math.max(1, Number(state.aiPickN) || 5);
    const pool = aiPickPool();
    const picked = [];
    if (state.aiPickBull !== false) {
      const bull = pool.filter(s => s.cat !== 'bearish')
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, n);
      picked.push(...bull);
    }
    if (state.aiPickBear !== false) {
      const bear = pool.filter(s => s.cat === 'bearish')
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, n);
      picked.push(...bear);
    }
    if (!picked.length) { log('No strategies found for the AI pick settings', 'warn'); return; }
    const inAiPicks = new Set((state.aiPicks || []).map(s => s.id));
    const inManual = new Set((state.manual || []).map(s => s.id));
    const inImported = new Set((state.imported || []).map(s => s.id));
    const fresh = [];
    let reused = 0;
    picked.forEach(s => {
      if (!s) return;
      const id = s.id;
      if (inAiPicks.has(id)) return;
      if (inManual.has(id) || inImported.has(id)) {
        state.selected[id] = true;
        reused++;
        return;
      }
      const copy = JSON.parse(JSON.stringify(s));
      copy.aiPicked = true;
      state.aiPicks.push(copy);
      state.selected[id] = true;
      inAiPicks.add(id);
      fresh.push(s);
    });
    save();
    render();
    log('Fetched ' + (fresh.length + reused) + ' AI-picked strategy(s) (top ' + n + ' bullish + ' + n + ' bearish) - ' + fresh.length + ' new, ' + reused + ' already in the list', fresh.length + reused ? 'ok' : 'warn');
  }

  function removeAiPick(id) {
    state.aiPicks = (state.aiPicks || []).filter(s => String(s.id) !== String(id));
    delete state.selected[id];
    save();
    render();
  }

  function renderSelected() {
    const host = $id('astSelectedList');
    if (!host) return;
    const manual = (state.manual || []);
    const aiPicks = (state.aiPicks || []);
    const imported = state.imported || [];
    if (!manual.length && !aiPicks.length && !imported.length) {
      host.innerHTML = '<div style="color:#666;font-size:10px;padding:4px 8px">No selected strategies yet. Pick one from the dropdown above and Add it, click Fetch Strategy for AI picks, or in the AI Paper Trade tab tick strategies and click "Send selected strategies to the AI Smart Trading Engine".</div>';
      return;
    }
    const row = (s, tag, removeFn) => {
      const sideCol = s.cat === 'bearish' ? '#ef5350' : '#00d4aa';
      const sideTag = 'LONG'; // buy-only engine: every trade executes LONG
      const on = state.selected[s.id];
      const vCol = s.verdict === 'Elite' ? '#ffd700' : (s.verdict === 'Good' ? '#00d4aa' : (s.verdict === 'Moderate' ? '#ff9800' : '#888'));
      return '<div style="display:flex;align-items:center;gap:8px;background:#12122a;border:1px solid ' + (on ? '#2d6d5a' : '#2d2d50') + ';border-radius:4px;padding:4px 8px;margin:2px 0;font-size:10px">' +
        '<input type="checkbox" data-enable="' + esc(s.id) + '" ' + (on ? 'checked' : '') + ' style="accent-color:#00d4aa" title="Enable / disable">' +
        '<span style="color:' + sideCol + ';font-weight:700;min-width:38px">' + sideTag + '</span>' +
        '<span style="color:#fff;flex:1">' + esc(s.name) + (s.tf ? ' <span style="color:#666">· ' + esc(s.tf) + '</span>' : '') + '</span>' +
        '<span style="color:' + vCol + ';min-width:36px;text-align:right">' + (s.score || 0) + '</span>' +
        '<span style="color:#888;min-width:40px;text-align:right;font-size:9px">' + tag + '</span>' +
        '<button class="btn-action" style="width:auto;padding:2px 8px;margin:0;font-size:9px;background:#ffd700;color:#0a0a18" onclick="AISmartTrading.sendToFinal(\'' + esc(s.id) + '\')" title="Save this strategy to the Final Strategy section with its settings">Final</button>' +
        '<button class="btn-action" style="width:auto;padding:2px 8px;margin:0;font-size:9px" onclick="AISmartTrading.openChart(\'' + esc(s.id) + '\')">Open Chart</button>' +
        '<button class="btn-action" style="width:auto;padding:2px 8px;margin:0;font-size:9px;background:#ef5350;color:#fff" onclick="AISmartTrading.' + removeFn + '(\'' + esc(s.id) + '\')">Remove</button>' +
        '</div>';
    };
    host.innerHTML = manual.map(s => row(s, 'Manual', 'removeManual')).join('') +
      aiPicks.map(s => row(s, 'AI Pick', 'removeAiPick')).join('') +
      imported.map(s => row(s, 'AI Paper', 'removeImported')).join('');
    host.querySelectorAll('input[type="checkbox"][data-enable]').forEach(cb => {
      cb.addEventListener('change', () => api.onStrategyCheck(cb.getAttribute('data-enable'), cb.checked));
    });
  }

  function renderStrategyList() {
    const bullHost = $id('astStratBullList');
    const bearHost = $id('astStratBearList');
    const bullHead = $id('astStratBullHeader');
    const bearHead = $id('astStratBearHeader');
    const list = savedByGroup();
    if (!list.length) {
      if (bullHead) bullHead.innerHTML = 'Bullish (CE)';
      if (bearHead) bearHead.innerHTML = 'Bearish (PE)';
      if (bullHost) bullHost.innerHTML = '<div style="color:#888;font-size:10px;padding:4px 8px">No saved strategies match the enabled research groups. Create strategies in the Strategies tab or run an Auto Experiment and deploy results.</div>';      if (bearHost) bearHost.innerHTML = '';
      return;
    }
    const active = new Set(activeStrategies().map(s => s.id));
    const bull = list.filter(s => s.cat !== 'bearish').sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const bear = list.filter(s => s.cat === 'bearish').sort((a, b) => String(a.name).localeCompare(String(b.name)));

    const headerBtns = (cat) =>
      '<span style="float:right">' +
      '<button class="btn-action" style="width:auto;padding:1px 8px;margin:0 2px;font-size:9px;background:#26a69a;color:#fff" onclick="AISmartTrading.removeSavedList(\'' + cat + '\',\'selected\')">Remove Selected</button>' +
      '<button class="btn-action" style="width:auto;padding:1px 8px;margin:0;font-size:9px;background:#ef5350;color:#fff" onclick="AISmartTrading.removeSavedList(\'' + cat + '\',\'all\')">Remove All</button>' +
      '</span>';

    if (bullHead) bullHead.innerHTML = 'Bullish (CE) <span style="color:#666;font-weight:400;font-size:9px">(' + bull.length + ')</span>' + headerBtns('bull');
    if (bearHead) bearHead.innerHTML = 'Bearish (PE) <span style="color:#666;font-weight:400;font-size:9px">(' + bear.length + ')</span>' + headerBtns('bear');
    if (bullHost) bullHost.innerHTML = bull.length ? bull.map(s => strategyRow(s, active.has(s.id))).join('') : '<div class="ind-empty" style="padding:6px">No bullish strategies</div>';
    if (bearHost) bearHost.innerHTML = bear.length ? bear.map(s => strategyRow(s, active.has(s.id))).join('') : '<div class="ind-empty" style="padding:6px">No bearish strategies</div>';
    [bullHost, bearHost].forEach(host => {
      if (!host) return;
      host.querySelectorAll('input[type="checkbox"][data-key]').forEach(cb => {
        cb.addEventListener('change', () => api.onStrategyCheck(cb.getAttribute('data-key'), cb.checked));
      });
    });
  }

  /* ----- Live Data Pool -----
     Shared realtime readout: every resolved instrument's forming candle
     (open/high/low/close/volume) + live indicator values + entry-condition
     PASS/FAIL. The pool reads the SAME shared candle cache + live 5ms feed the
     strategies use, so what is shown here is exactly what they trade. It never
     re-resolves option chains (reuses the last tick's instruments) so it adds
     zero extra Dhan calls. */
  function poolIndValue(indId, settings, i, candles) {
    const r = readTwo(indId, settings, 'v0', i, candles);
    return (r && r.last != null && !isNaN(r.last)) ? r.last : null;
  }
  function poolNum(v) {
    const n = Number(v);
    return (isFinite(n)) ? n.toFixed(2) : '--';
  }
  /* Volume for a pool readout: prefer the forming candle's own volume; when
     that is 0 (option premium candles often carry no volume) fall back to the
     live quote's volume for the same instrument/strike so the pool never shows
     an empty volume column for a strike that actually has volume. */
  function poolVolume(instr, contract, bar) {
    const bv = Number(bar && bar.volume);
    if (bv > 0) return bv;
    try {
      const qm = quoteCache();
      let q = null;
      if (contract && contract.sid != null) {
        q = qm[String(contract.sid)] || null;
      } else if (instr.kind === 'option' && instr.sid != null) {
        q = qm[String(instr.sid)] || null;
      } else if (instr.symbol) {
        const sym = instr.symbol;
        q = qm[sym.exch === 'IDX_I' ? 'IDX_I:' + sym.id : String(sym.id)] || null;
      }
      const qv = (q && q.volume != null) ? Number(q.volume) : 0;
      return (isFinite(qv) && qv > 0) ? qv : bv;
    } catch (e) { return bv; }
  }
  function poolTF() {
    const acts = activeStrategies();
    for (const s of acts) { const t = pickTimeframe(s); if (t) return t; }
    return '1min';
  }
  let _poolBusy = false;
  let _poolResolveAt = 0;
  let _poolForceResolve = false;
  async function poolScan() {
    if (state.dataPool !== true) return;
    if (_poolBusy) return;
    _poolBusy = true;
    const host = $id('astDataPoolBody');
    try {
      const tf = poolTF();
      const acts = activeStrategies();
      const rows = [];
      if (!_lastInstruments.length || _poolForceResolve) {
        /* Engine idle (auto OFF): resolve the selected universe once per 15s so
           the pool still shows live data without hammering the chain surface. */
        const now = Date.now();
        if (_poolForceResolve || now - _poolResolveAt > 15000) {
          _poolResolveAt = now;
          _poolForceResolve = false;
          try { _lastInstruments = await resolveInstruments(); } catch (e) { _lastInstruments = []; }
        }
      }
      for (const instr of _lastInstruments) {
        const sources = [];
        try {
          const c = await candlesForInstrument(instr, tf);
          if (c && c.length >= 10) {
            if (instr.kind === 'option') {
              sources.push({ chart: _candleFbk[instrumentId(instr)] ? 'spot' : 'premium', candles: c });
            } else {
              sources.push({ chart: 'spot', candles: c });
            }
          }
        } catch (e) {}
        if (instr.kind === 'both') {
          const contracts = (instr.contracts || []);
          for (let ci = 0; ci < contracts.length; ci++) {
            try {
              const pc = await confirmCandlesFor(instr, tf, ci);
              if (pc && pc.length >= 10) sources.push({ chart: 'premium', contract: contracts[ci], candles: pc });
            } catch (e) {}
          }
        }
        for (const src of sources) {
          const candles = src.candles;
          const i = candles.length - 1;
          const bar = candles[i];
          if (!bar) continue;
          const contract = src.contract || ((instr.kind === 'option' && instr.strike != null) ? instr : null);
          const label = contract ? displayName(instr.symbol) + ' ' + contract.strike + ' ' + contract.optionType : displayName(instr.symbol);
          const type = (src.contract) ? 'option' : (instr.kind || '');
          const ema9 = poolIndValue('ema', { length: 9, source: 'close' }, i, candles);
          const ema21 = poolIndValue('ema', { length: 21, source: 'close' }, i, candles);
          const ema35 = poolIndValue('ema', { length: 35, source: 'close' }, i, candles);
          const st = poolIndValue('supertrend', { atrPeriod: 10, factor: 3 }, i, candles);
          const vwap = poolIndValue('vwap', { anchor: 'trend' }, i, candles);
          let cond = 'FAIL';
          for (const s of acts) {
            /* Evaluate against the working copy so the readout reflects the
               selected indicator filters (and the all-together strict mode),
               exactly as the live entry gate does. */
            try { if (entryFireAt(workingStrategy(s), candles, i)) { cond = 'PASS'; break; } } catch (e) {}
          }
          const vol = poolVolume(instr, contract, bar);
          rows.push('<tr><td>' + label + '</td><td>' + type + '</td><td>' + src.chart + '</td><td>' + tf + '</td>' +
            '<td>' + poolNum(bar.open) + '</td><td>' + poolNum(bar.high) + '</td><td>' + poolNum(bar.low) + '</td><td>' + poolNum(bar.close) + '</td><td>' + vol + '</td>' +
            '<td>' + poolNum(ema9) + '</td><td>' + poolNum(ema21) + '</td><td>' + poolNum(ema35) + '</td><td>' + poolNum(st) + '</td><td>' + poolNum(vwap) + '</td>' +
            '<td style="color:' + (cond === 'PASS' ? '#00d4aa' : '#888') + ';font-weight:700">' + cond + '</td></tr>');
        }
      }
      const info = $id('astDataPoolInfo');
      if (info) info.textContent = rows.length + ' readout(s) live · ' + _lastInstruments.length + ' instrument(s) resolved · spot + premium where run-in = both';
      if (host) host.innerHTML = '<table class="account-table"><thead><tr><th>Symbol</th><th>Type</th><th>Chart</th><th>TF</th><th>O</th><th>H</th><th>L</th><th>C</th><th>Vol</th><th>EMA9</th><th>EMA21</th><th>EMA35</th><th>SuperTrend</th><th>VWAP</th><th>Entry</th></tr></thead><tbody>' + rows.join('') + '</tbody></table>';
    } catch (e) {
    } finally {
      _poolBusy = false;
    }
  }
  function onDataPoolToggle() {
    const el = $id('astDataPool');
    state.dataPool = !!(el && el.checked);
    save();
    const host = $id('astDataPoolBody');
    const info = $id('astDataPoolInfo');
    if (host) host.style.display = state.dataPool ? 'block' : 'none';
    if (info) info.textContent = state.dataPool ? 'scanning...' : 'OFF - shared pool feeds strategies only';
    if (state.dataPool) poolScan();
  }
  /* Ultrafast live feed toggle: when ON, strategies run + trade on the browser-
     side live candle store (built tick-by-tick from the WebSocket feed) instead
     of the Data Pool REST path. When OFF, the default Data Pool path stays. */
  function onFastDataInput() {
    const el = $id('astFastData');
    state.fastData = !!(el && el.checked);
    /* Explicit user un-tick during a run: remember it so forceFastLiveForRun()
       does not flip the feed straight back on this run (respected until the
       next Run Paper Trading / Indicator-filters run start). */
    _userFastDataOff = !state.fastData;
    save();
    if (state.fastData) {
      if (window.FastLive && FastLive.reset) { try { FastLive.reset(); } catch (e) {} }
      if (window.FastLive && FastLive.setEnabled) { try { FastLive.setEnabled(true); } catch (e) {} }
      log('Ultrafast live feed ON - strategies read live in-browser candles (no REST /api/candles in the live path)', 'ok');
    } else {
      if (window.FastLive && FastLive.setEnabled) { try { FastLive.setEnabled(false); } catch (e) {} }
      log('Ultrafast live feed OFF - default Data Pool path active', '');
    }
    syncFastDataUI();
  }
  function syncFastDataUI() {
    const el = $id('astFastData');
    if (el) el.checked = state.fastData === true;
    if (window.FastLive && FastLive.setEnabled) { try { FastLive.setEnabled(state.fastData === true); } catch (e) {} }
    const info = $id('astFastDataInfo');
    if (!info) return;
    if (state.fastData) {
      let n = 0;
      if (window.FastLive) { try { n = FastLive.activeCount(); } catch (e) { n = 0; } }
      info.textContent = 'ON - ' + n + ' live series';
    } else {
      info.textContent = 'OFF - Data Pool path active';
    }
  }
  /* Manual Data Pool refresh: force the pool to re-resolve the selected
     universe right now (ignoring the 15s idle throttle) so newly added premium
     charts / symbols / strikes and changed indicator or data values show up
     immediately, then re-render the readout table. */
  async function poolRefresh() {
    if (state.dataPool !== true) return;
    _poolForceResolve = true;
    const info = $id('astDataPoolInfo');
    if (info) info.textContent = 'refreshing...';
    await poolScan();
    if (info) info.textContent = info.textContent.replace('refreshing...', 'refreshed');
  }

  /* The engine's own state.positions rows are a copy made at entry time.
     PaperTrade is the source of truth for a live position: its checkAutoTargetSl
     re-bases targetPrice (the trail level) on every new peak, and every risk
     level (stop-loss / trail TP / fixed TP) is re-derived off the entry price
     when a leg is averaged in. A stale copy makes the Running list show
     different SL / trail TP / TP values than the levels that actually close the
     trade (which land correctly in the Closed list). Refresh the engine copy
     from the live PaperTrade position every render so both lists always agree.

     A position held in this engine's own state.positions that PaperTrade has
     already closed (stop-loss / trailing TP / fixed TP / manual close) is a
     ghost: PaperTrade's checkAutoTargetSl deletes it from state.autoPositions
     but this engine's display copy survives forever. Drop it here so the
     Running list and live P&L never show a trade that no longer exists. */
   /* Record a closed AI Smart position into state.closed (the "Closed AI Smart
      Trades" list). The close itself is executed by PaperTrade, which writes the
      authoritative record (entry / exit / P&L / charges) into ITS closed list;
      we copy that record so the closed position is always priced at its REAL
      exit (never at the current live LTP of an already-closed trade). */
  function recordClosedPosition(p) {
    try {
      const pt = basePaper();
      /* Locate the authoritative close record written by PaperTrade when the
         position was squared off. Matching is symbolId + side + qty based (no
         fragile time window / symbol-name match) so a close is priced at its
         REAL exit, never at the current live LTP of an already-closed trade.
         The "not already mirrored" guard lets the same symbol be re-entered
         and closed repeatedly without picking up a stale older record. */
      let src = null;
      if (pt && pt.getState) {
        const mirrored = {};
        for (const c of state.closed) {
          if (c && c.at != null) mirrored[String(c.at)] = true;
        }
        const closed = pt.getState().closed || [];
        const sameSym = closed.filter(t => t && t.side === p.side &&
          t.symbolId != null && p.symbolId != null &&
          String(t.symbolId) === String(p.symbolId) && !mirrored[String(t.at)]);
        src = sameSym.find(t => t.qty === p.qty) || null;
        if (!src) {
          src = sameSym.find(t => t.entry === p.entryPrice) || null;
        }
        if (!src) {
          src = sameSym[0] || null;
        }
        if (!src) {
          const symFallback = closed.filter(t => t && t.side === p.side &&
            (t.symbol && t.symbol === p.symbol) && !mirrored[String(t.at)]);
          src = symFallback.find(t => t.qty === p.qty)
            || symFallback.find(t => t.entry === p.entryPrice)
            || symFallback[0]
            || null;
        }
      }
      /* Fallback when PaperTrade's close record is missing (its history was
         evicted before mirroring, or the paper ledger was reset): price the
         close at the last known price so the trade is recorded with its real
         P&L instead of a flat ₹0. */
      const fallbackCur = src ? null : positionCurrentPrice(p);
      const exit = src ? src.exit : (fallbackCur != null ? fallbackCur : p.entryPrice);
      const pnl = src ? src.pnl : (fallbackCur != null ? (p.side === 'BUY' ? (exit - p.entryPrice) * p.qty : (p.entryPrice - exit) * p.qty) : 0);
      const pnlPct = src ? src.pnlPct : (pnl && p.entryPrice && p.qty ? (pnl / (p.entryPrice * p.qty)) * 100 : 0);
      const charges = src ? (src.charges || 0) : 0;
      const entry = {
        strategyId: p.strategyId, strategyName: p.strategyName || 'Strategy',
        instrumentName: p.instrumentName || p.symbol, side: p.side,
        qty: p.qty, lotSize: p.lotSize, lots: p.lots,
        entry: p.entryPrice,
        entryAt: p.openedAt != null ? p.openedAt : null,
        exit: exit,
        pnl: pnl, pnlPct: pnlPct,
        netPnl: (src != null || fallbackCur != null) ? pnl - charges : null,
        charges: charges,
        at: src ? src.at : Date.now(), reason: src ? (src.reason || 'Closed') : 'Closed',
        symbol: p.symbol, symbolId: p.symbolId != null ? p.symbolId : null,
        symbolExch: p.symbolExch != null ? p.symbolExch : null
      };
      const dup = state.closed.some(c => c && c.at === entry.at && c.side === entry.side &&
        (c.symbol === entry.symbol || String(c.symbolId) === String(entry.symbolId)));
      if (dup) return;
      state.closed.unshift(entry);
      /* No cap: every closed trade is kept so the realized-P&L history never
         shrinks. The running totals below make the Smart summary exact even if
         the list is ever trimmed for storage elsewhere. */
      const rp = state.rpnl || (state.rpnl = { realized: 0, charges: 0, count: 0, wins: 0 });
      const net = entry.netPnl != null ? entry.netPnl : entry.pnl;
      rp.realized += net;
      rp.charges += charges;
      rp.count += 1;
      if (net > 0) rp.wins += 1;
    } catch (e) {}
  }

  /* Live auto-position bucket for an AST mirror key, but ONLY when the bucket
     is actually owned by this engine (autoKey starts with 'ast:'). Auto
     positions share a per-symbol bucket (id:exch), so another engine (Auto
     Experiment / manual auto trade) re-opening the same symbol after the AST
     leg closed leaves a live bucket that is NOT an AST trade. Returning null
     lets callers drop the stale mirror entry instead of syncing foreign data
     into it and rendering a non-AST trade in the AST running list. */
  function astOwnedLive(autoPositions, k) {
    const live = autoPositions ? autoPositions[k] : null;
    if (!live) return null;
    if (String(live.autoKey || '').indexOf('ast:') !== 0) return null;
    return live;
  }

  function underKeyOfInstr(instr) {
    const sym = instr && instr.symbol;
    if (!sym) return null;
    const id = (sym.id != null) ? sym.id : ((sym.symbolId != null) ? sym.symbolId : null);
    if (id == null) return null;
    return String(id) + ':' + (sym.exch || '');
  }
  function optTypeOfLeg(p) {
    if (!p) return null;
    if (p.optionType === 'CE' || p.optionType === 'PE') return p.optionType;
    const s = String(p.symbol || p.instrumentName || '');
    const m = s.match(/\b(CE|PE)\b/);
    return m ? m[1] : null;
  }
  /* Side-flip cleanup: when the run side / picked strike flips (e.g. NIFTY goes
     bearish->bullish so the indicator run switches from PE to CE contracts), an
     open AST-owned leg on the OLD side is no longer part of the current
     execution targets. The poll therefore stops managing its exit and, if its
     contract also stops streaming live quotes, its paper SL/trail can never
     fire - leaving the row stuck in Running Trades. This actively cuts any open
     leg whose option side is opposite to the side its owning strategy trades
     THIS pass (a strategy that has re-pinned to the opposite side no longer
     wants the old leg, whatever happened to the symbol's universe membership).
     Legs on the current side and legs whose strategy is not direction-pinned
     (both CE and PE still in play) are untouched. */
  function cutStaleSideLegs(instruments, strategies) {
    try {
      const pt2 = basePaper();
      if (!pt2 || !pt2.getState) return;
      const ap = pt2.getState().autoPositions || {};
      /* Option side the owning strategy would trade on this pass (buy-only
         engine: bullish -> CE, bearish -> PE). The indicator-filters synthetic
         strategy follows the currently active Bullish/Bearish filter set, so
         flipping the filters/NIFTY direction re-pins it to the new side. */
      const sideFor = {};
      (strategies || []).forEach(s => {
        const d = (s && s._filterBuilt)
          ? activeFilterDirection()
          : ((s && s.cat === 'bearish') ? 'bearish' : ((s && s.cat === 'bullish') ? 'bullish' : null));
        if (d === 'bullish' || d === 'bearish') sideFor[s.id] = d === 'bullish' ? 'CE' : 'PE';
      });
      const keys = Object.keys(state.positions);
      for (const k of keys) {
        const p = state.positions[k];
        if (!p) continue;
        const type = optTypeOfLeg(p);
        if (type !== 'CE' && type !== 'PE') continue;
        if (!astOwnedLive(ap, k)) continue;
        const want = sideFor[p.strategyId];
        if (!want || want === type) continue;
        try { if (pt2.autoExit) pt2.autoExit(k); } catch (e) {}
        const paper2 = (window.AutoExperiment && AutoExperiment.paper) ? AutoExperiment.paper : null;
        if (paper2) {
          try { if (paper2.dropTrailEngine) paper2.dropTrailEngine(k); } catch (e) {}
          try { if (paper2.dropAiTrailEngine) paper2.dropAiTrailEngine(k); } catch (e) {}
        }
        try { recordClosedPosition(p); } catch (e) {}
        delete state.positions[k];
        log('"' + (p.strategyName || 'Strategy') + '" stale ' + type + ' leg ' + (p.instrumentName || p.symbol || k) + ' cut (run side flipped to ' + want + ' - the old side no longer trades)', 'warn');
      }
    } catch (e) {}
  }

  /* Soft-close grace: reconcile only DROPS a mirror entry after the live
     paper bucket has been missing / foreign for a sustained number of polls.
     A page reload, WS reconnect or a paper-engine re-key can make a bucket
     vanish for 1-2 reconcile ticks while the AST trade is still genuinely open
     - deleting on that transient gap made Running Trades blink trades out and
     stamped a bogus "exited via stop-loss" closed record. */
  const _POSITION_GRACE_MS = 6000;
  let _posMissSince = {};
  /* Engine birth timestamp. Right after a page reload / engine (re)boot the
     base paper-trade engine, quote cache and resolved chains are still warming
     up, so live buckets for genuinely open AST trades can look "missing" for a
     few reconcile polls. Using a wider grace window for the first seconds of a
     fresh session stops Running Trades from being wiped moments after reload. */
  const _bootTs = Date.now();
  function _positionGraceMs() {
    return (Date.now() - _bootTs < 30000) ? 20000 : _POSITION_GRACE_MS;
  }

  function _reconcileGraceExpired(k) {
    return (_posMissSince[k] != null) && (Date.now() - _posMissSince[k]) >= _positionGraceMs();
  }

  function reconcileClosedPositions() {
    try {
      const pt = basePaper();
      if (!pt || !pt.getState) return;
      const autoPositions = (pt.getState().autoPositions) || null;
      if (!autoPositions) return;
      Object.keys(state.positions).forEach(k => {
        const live = autoPositions[k];
        if (!live) {
          const p = state.positions[k];
          if (_posMissSince[k] == null) _posMissSince[k] = Date.now();
          /* Grace window: keep the mirror row - the bucket may come back after
             a reload/reconnect. Only close when it has stayed missing. */
          if (!_reconcileGraceExpired(k)) return;
          delete state.positions[k];
          if (p && p.strategyName) {
            recordClosedPosition(p);
            log('"' + p.strategyName + '" exited via stop-loss / trail TP / take profit', 'sell');
          }
          return;
        }
        /* Ownership guard: only AST-owned buckets belong in the AST mirror.
           When another engine took over this symbol bucket, drop the stale
           mirror entry instead of syncing its data in. */
        if (!astOwnedLive(autoPositions, k)) {
          if (_posMissSince[k] == null) _posMissSince[k] = Date.now();
          if (!_reconcileGraceExpired(k)) return;
          const p = state.positions[k];
          delete state.positions[k];
          if (p) log('"' + p.strategyName + '" on ' + (live.symbol || k) + ' taken over by another engine - removed from AST running list', 'warn');
          return;
        }
        _posMissSince[k] = null;   // live & AST-owned again -> clear grace
        const p = state.positions[k];
        p.qty = live.qty;
        p.entryPrice = live.entryPrice;
        p.peakPrice = live.peakPrice;
        p.targetPct = live.targetPct;
        p.slPct = live.slPct;
        p.targetPrice = live.targetPrice;
        p.stopLoss = live.stopLoss;
        p.tpPct = live.tpPct || 0;
        p.tpPrice = live.tpPrice || 0;
      });
    } catch (e) {}
  }

  /* Margin/balance bar above the AI Smart "Running Trades (open positions)"
     table. Balance = this engine's own Margin input (universal defaults);
     locked = total cost (qty x entry) of the open running trades. */
  function renderAstMarginBar() {
    const barEl = $id('astMarginBar');
    if (!barEl) return;
    const u = state.universal || {};
    const elB = document.getElementById('astMargin');
    const budget = (Number(u.margin) > 0) ? Number(u.margin) : (elB ? (Number(elB.value) || 0) : 0);
    let locked = 0, count = 0;
    /* AE-imported strategies run on their OWN AE margin (per-origin cap inside
       the engine), so their open trades must never be shown as locking the
       AI Smart Margin input - they get their own AE readout below. */
    const bptW = basePaper();
    const wAP = (bptW && bptW.getState && bptW.getState().autoPositions) ? bptW.getState().autoPositions : {};
    let aeLocked = 0, aeCount = 0;
    Object.keys(state.positions || {}).forEach((k) => {
      const p = state.positions[k];
      if (!p || !p.qty || !p.entryPrice) return;
      const b = wAP[k];
      if (b && b.budgetCap > 0) { aeLocked += p.qty * p.entryPrice; aeCount++; return; }
      locked += p.qty * p.entryPrice; count++;
    });
    const avail = budget > 0 ? Math.max(0, budget - locked) : 0;
    if (!budget && count === 0 && aeCount === 0) {
      barEl.style.display = 'none';
      barEl.innerHTML = '';
      return;
    }
    barEl.style.display = 'flex';
    let h =
      '<b style="color:#00d4aa;white-space:nowrap">AI Smart trade margin:</b>' +
      '<b style="color:#ffd700;font-size:11px;white-space:nowrap">' + fmtMoney(budget) + '</b>' +
      '<span style="color:#888;white-space:nowrap">Locked by ' + count + ' running trade' + (count === 1 ? '' : 's') + ': <b style="color:#ffd700">' + fmtMoney(locked) + '</b></span>' +
      '<span style="color:#888;white-space:nowrap">Available now: <b style="color:' + (avail > 0 ? '#00d4aa' : '#ef5350') + '">' + fmtMoney(avail) + '</b></span>' +
      '<span style="color:#666;font-size:8px">next AI Smart/manual trade is blocked + warned when its required margin &gt; available</span>';
    if (aeCount) {
      h += '<span style="color:#b39ddb;white-space:nowrap" title="AE-imported strategies run on the Auto Experiment margin they were created under">AE trades (' + aeCount + '): <b style="color:#b39ddb">' + fmtMoney(aeLocked) + ' locked</b></span>';
    }
    if (barEl.innerHTML !== h) barEl.innerHTML = h;
  }

  function renderRunning() {
    reconcileClosedPositions();
    renderAstMarginBar();
    const host = $id('astRunningBody');
    if (!host) return;
    /* Final ownership filter (belt and suspenders on top of the reconcile
       guard): only mirror entries backed by a live AST-owned bucket render,
       EXCEPT mirror entries still inside the soft-close grace window (bucket
       temporarily missing/foreign after a reload/reconnect) - those keep
       rendering so Running Trades does not blink trades out. */
    const pt2 = basePaper();
    const openPositions = Object.keys(state.positions)
      .filter(k => {
        if (!!astOwnedLive(pt2 ? pt2.getState().autoPositions : null, k)) return true;
        return !_reconcileGraceExpired(k);
      })
      .map(k => state.positions[k]);
    if (!openPositions.length) {
      host.innerHTML = '<tr><td colspan="8" style="color:#666;font-size:10px;padding:6px 8px">No AI Smart positions open. Tick at least one saved strategy and toggle AI Smart Trading ON.</td></tr>';
      return;
    }
    /* Render each position defensively: a malformed record must not blank the
       whole running list (which is what makes P&L/LTP show as "--"). */
    const rows = [];
    for (const p of openPositions) {
      try { rows.push(runningRowHTML(p)); } catch (e) {}
    }
    host.innerHTML = rows.join('') || '<tr><td colspan="9" style="color:#666;font-size:10px;padding:6px 8px">No AI Smart positions open.</td></tr>';
  }

  function runningRowHTML(p) {
      const cur = positionCurrentPrice(p);
      const pnl = cur != null ? (p.side === 'BUY' ? (cur - p.entryPrice) * p.qty : (p.entryPrice - cur) * p.qty) : null;
      /* Running Trades shows GROSS P&L only — no broker-charge deduction while
         the trade is open. Charges (entry + exit round-trip) are applied ONCE
         when the trade CLOSES and are shown net in Closed Positions. */
      const pnlPct = pnl != null && p.entryPrice && p.qty ? (pnl / (p.entryPrice * p.qty)) * 100 : null;
      const col = pnl == null ? '#888' : (pnl >= 0 ? '#00d4aa' : '#ef5350');
      const sideCol = p.side === 'BUY' ? '#00d4aa' : '#ef5350';
      const u = state.universal || {};
      const aiSlOn = u.aiSl !== false && u.manualSL !== true && u.manualTrailSL !== true;
      const aiTpOn = u.aiTp !== false && u.manualTrailTP !== true;
      let guard = aiSlOn && aiTpOn ? 'AI-SL+TP' : (aiSlOn ? 'AI-SL' : (aiTpOn ? 'AI-TP' : '--'));
      if (p.slTrailed) guard += ' \u00B7 TRAIL';
      const qtyTxt = (p.lotSize && p.qty)
        ? p.qty + ' <span style="font-size:8px;color:#666">(' + (p.lots || Math.round(p.qty / p.lotSize)) + '\u00D7' + p.lotSize + ')</span>'
        : p.qty;
      let slTrailTxt = '';
      if (p.stopLoss != null) slTrailTxt += 'SL ' + fmt2(p.stopLoss);
      if (p.slTrailPct > 0) slTrailTxt += (slTrailTxt ? ' \u00B7 ' : '') + 'Tr ' + fmt2(p.slTrailPct) + '%';
      if (p.targetPrice != null && p.targetPrice > 0) slTrailTxt += (slTrailTxt ? ' \u00B7 ' : '') + 'TP ' + fmt2(p.targetPrice);
      return '<tr>' +
        '<td><span style="color:#fff">' + esc(p.instrumentName) + '</span><br><span style="font-size:8px;color:#666">' + esc(p.strategyName) + ' \u00B7 <span style="color:' + sideCol + '">' + (p.side === 'BUY' ? 'LONG' : 'SHORT') + '</span></span></td>' +
        '<td>' + qtyTxt + '</td>' +
        '<td>' + fmt2(p.entryPrice) + '</td>' +
        '<td>' + (cur != null ? fmt2(cur) : '--') + '</td>' +
        '<td style="color:' + col + '">' + (pnl == null ? '--' : (pnl >= 0 ? '+' : '') + fmtMoney(pnl) + '<br><span style="font-size:8px;color:#888">' + fmt2(pnlPct) + '%</span>') + '</td>' +
        '<td style="color:#888">' + (slTrailTxt || '--') + '</td>' +
        '<td style="color:#ff9800">' + guard + '</td>' +
        '<td><button class="btn-action" style="width:auto;padding:2px 8px;margin:0;font-size:9px;background:#ef5350;color:#fff" onclick="AISmartTrading.stopPosition(\'' + esc(p.strategyId) + '\')">Stop</button></td>' +
        '</tr>';
  }

  function fmtTime(ms) {
    if (ms == null) return '--';
    const d = new Date(ms);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yy = String(d.getFullYear()).slice(2);
    return dd + '-' + mm + '-' + yy + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
  }

  let _lastClosedKey = '';

  function renderClosed() {
    const host = $id('astClosedBody');
    if (!host) return;
    if (!state.closed.length) {
      _lastClosedKey = '';
      host.innerHTML = '<tr><td colspan="7" style="color:#666;font-size:10px;padding:6px 8px">No closed AI Smart trades</td></tr>';
      return;
    }
    /* Closed rows are immutable once recorded, so only rebuild the table when
       the history or the charges display setting actually changed (keeps the
       DOM light even after thousands of trades). */
    const key = state.closed.length + ':' + (!!astChargesOn());
    if (_lastClosedKey === key) return;
    _lastClosedKey = key;
    const rows = [];
    for (const t of state.closed) {
      try {
        const chargesOn = !!astChargesOn();
        const net = (chargesOn && t.netPnl != null) ? t.netPnl : t.pnl;
        const col = net >= 0 ? '#00d4aa' : '#ef5350';
        const sideCol = t.side === 'BUY' ? '#00d4aa' : '#ef5350';
        const et = fmtTime(t.entryAt);
        const ct = fmtTime(t.at);
        const qtyTxt = (t.lotSize && t.qty)
          ? t.qty + ' <span style="font-size:8px;color:#666">(' + (t.lots || Math.round(t.qty / t.lotSize)) + '\u00D7' + t.lotSize + ')</span>'
          : t.qty;
        rows.push('<tr>' +
          '<td><span style="color:#fff">' + esc(t.instrumentName) + '</span><br><span style="font-size:8px;color:#666">' + esc(t.strategyName) + ' \u00B7 <span style="color:' + sideCol + '">' + (t.side === 'BUY' ? 'LONG' : 'SHORT') + '</span></span></td>' +
          '<td>' + qtyTxt + '</td>' +
          '<td>' + fmt2(t.entry) + ' \u2192 ' + fmt2(t.exit) + '</td>' +
          '<td style="color:' + col + '">' + (net >= 0 ? '+' : '') + fmtMoney(net) + '<br><span style="font-size:8px;color:#888">' + fmt2(t.pnlPct) + '%</span>' + (chargesOn && t.netPnl != null ? ' <span style="font-size:8px;color:#888">gross ' + (t.pnl >= 0 ? '+' : '') + fmtMoney(t.pnl) + '</span>' : '') + '</td>' +
          '<td style="color:#888">' + (chargesOn && t.charges != null ? fmtMoney(t.charges) : '--') + '</td>' +
          '<td style="color:#ff9800">' + esc(t.reason || 'Closed') + '</td>' +
          '<td style="color:#888">' + et + ' \u2192 ' + ct + '</td>' +
          '</tr>');
      } catch (e) {}
    }
    host.innerHTML = rows.join('') || '<tr><td colspan="7" style="color:#666;font-size:10px;padding:6px 8px">No closed AI Smart trades</td></tr>';
  }

  function renderSummary() {
    const chargesOn = !!astChargesOn();
    /* Realized P&L / charges / trade counts are derived straight from the
       closed-trades history (the single source of truth) so the Smart Realized
       P&L card always equals the sum of every closed trade's P&L shown in the
       Closed Trades table. The closed list is never truncated, so this sum
       never shrinks as trades age out. */
    const closedList = state.closed || [];
    let realized = 0, winCount = 0, chargesTotal = 0;
    for (const t of closedList) {
      const net = (chargesOn && t.netPnl != null) ? t.netPnl : (t.pnl || 0);
      realized += net;
      chargesTotal += (t.charges || 0);
      if (net > 0) winCount++;
    }
    let unreal = 0;
    /* Live P&L is GROSS: running trades never deduct broker charges — charges
       (entry + exit round-trip) are applied once at close and show in the
       realized P&L. */
    for (const k in state.positions) {
      const p = state.positions[k];
      const cur = positionCurrentPrice(p);
      if (cur != null) {
        unreal += p.side === 'BUY' ? (cur - p.entryPrice) * p.qty : (p.entryPrice - cur) * p.qty;
      }
    }
    const live = realized + unreal;
    const total = closedList.length;
    const wr = total ? winCount / total * 100 : 0;
    const el = $id('astSummary');
    if (!el) return;
    el.innerHTML =
      '<div class="acard" style="flex:1"><div class="label">Smart Live P&L (gross)</div><div class="value" style="color:' + (live >= 0 ? '#00d4aa' : '#ef5350') + '">' + (live >= 0 ? '+' : '') + fmtMoney(live) + '</div></div>' +
      '<div class="acard" style="flex:1"><div class="label">Smart Realized P&L</div><div class="value" style="color:' + (realized >= 0 ? '#00d4aa' : '#ef5350') + '">' + (realized >= 0 ? '+' : '') + fmtMoney(realized) + '</div></div>' +
      '<div class="acard" style="flex:1"><div class="label">Smart Win Rate</div><div class="value" style="color:' + (wr >= 50 ? '#00d4aa' : '#ff9800') + '">' + fmt2(wr) + '%</div></div>' +
      '<div class="acard" style="flex:1"><div class="label">Smart Trades (W/L)</div><div class="value" style="font-size:13px">' + total + ' (' + winCount + 'W / ' + (total - winCount) + 'L)</div></div>' +
      '<div class="acard" style="flex:1"><div class="label">Smart Charges</div><div class="value" style="color:#ff9800;font-size:13px">' + (chargesOn ? '-' : '') + fmtMoney(chargesTotal) + '</div></div>' +
      '<div class="acard" style="flex:1;display:flex;align-items:center;justify-content:center;padding:6px"><button class="btn-action warn" style="width:auto;padding:5px 12px;margin:0;font-size:10px" title="Reset all Smart P&L to zero: clears every closed trade, running position and the paper-trade ledger. Next trade starts calculating from ₹0." onclick="AISmartTrading.resetPnl()">Reset</button></div>';
  }

  function render() {
    populateManualSelect();
    renderStrategyList();
    renderSelected();
    renderRunning();
    renderClosed();
    renderSummary();
    const sel = $id('astSelectAll');
    if (sel) {
      const list = savedByGroup();
      const all = list.length > 0 && list.every(s => !!state.selected[s.id]);
      sel.textContent = all ? 'Clear Selection' : 'Select All';
    }
    syncStrategyOverrideUI();
    syncRunStrategyInUI();
  }

  /* ---------------- actions ---------------- */
  function toggleAuto() {
    state.enabled = !state.enabled;
    if (state.enabled) {
      state.runIntent = { active: true, mode: state.filterMode ? 'filter' : 'normal', at: Date.now() };
      _userFastDataOff = false;
    } else {
      state.runIntent = { active: false, mode: state.filterMode ? 'filter' : 'normal', at: Date.now() };
    }
    save();
    applyUniversalToUI();
    log('AI Smart Trading engine ' + (state.enabled ? 'enabled' : 'disabled'), state.enabled ? 'ok' : 'warn');
    if (state.enabled) tick();
  }

  function toggleMovers() {
    if (!state.movers) state.movers = { enabled: false, gainers: 5, losers: 5, indices: [], picked: [] };
    state.movers.enabled = !state.movers.enabled;
    /* Mutually exclusive with NIFTY Trend Following: enabling the movers
       universe switches the engine out of trend-following mode. */
    if (state.movers.enabled && state.niftyTrend && state.niftyTrend.enabled) {
      state.niftyTrend.enabled = false;
      _resetTrendScan();
    }
    if (state.movers.enabled && state.sim) state.sim.enabled = false;
    save();
    applyMoversToUI();
    applyNiftyTrendToUI();
    applySimToUI();
    applyCommodityToUI();
    renderMoversList();
    log('Daily top gainers/losers + indices AI Smart Trading ' + (state.movers.enabled ? 'enabled' : 'disabled'), state.movers.enabled ? 'ok' : 'warn');
  }

  function onStrategyCheck(id, checked) {
    state.selected[id] = !!checked;
    save();
    render();
  }

  /* Global "Run Strategy In" control handler: updates the enable / side / auto
     fields for the Selected Strategies section and re-renders the list. */
  function onGlobalRunInInput(field, value) {
    const cur = runStrategyInConfig();
    if (field === 'enabled') cur.enabled = !!value;
    else if (field === 'side') cur.side = value === 'PE' ? 'PE' : 'CE';
    else if (field === 'auto') cur.auto = !!value;
    state.runStrategyIn = cur;
    save();
    render();
  }

  function selectAll() {
    const list = savedByGroup().concat(state.imported || []).concat(state.manual || []).concat(state.aiPicks || []);
    const all = list.length > 0 && list.every(s => !!state.selected[s.id]);
    list.forEach(s => { state.selected[s.id] = !all; });
    save();
    render();
  }

  function selectNone() {
    savedByGroup().concat(state.imported || []).concat(state.manual || []).concat(state.aiPicks || []).forEach(s => { state.selected[s.id] = false; });
    save();
    render();
  }

  function refresh() {
    _workingCache.clear();
    render();
    log('Refreshed saved strategies list', '');
  }

  function runManual() {
    render();
    tick(true);
  }

  function runPaper() {
    readUniversal();
    // "Run Paper Trading" runs the strategies the user ticked. Turn off the
    // dynamic "Smart AI trader picked" auto-picker (which re-picks top-N every
    // tick regardless of manual ticks) and make sure manual selection is on, so
    // only the ticked strategies are evaluated - nothing is auto-picked.
    state.aiPick = false;
    state.callManual = true;
    state.filterMode = false;
    applyModeToUI();
    applyRunModeUI();
    state.enabled = true;
    state.runIntent = { active: true, mode: 'normal', at: Date.now() };
    _userFastDataOff = false;
    save();
    applyUniversalToUI();
    render();
    log('Run Paper Trading started - evaluating ticked strategies in paper mode', 'ok');
    tick();
  }

  /* Start the Indicator-filters run mode: place a trade on every symbol of the
     selected universe only when ALL selected Bullish/Bearish indicator filters
     pass together on its chart (strict AND). All other engine settings (SL /
     trail TP / fixed TP / lots / margin / AI risk / time gates) apply exactly
     like the normal Run Paper Trading mode. */
  function runFilterPaper() {
    readUniversal();
    state.filterMode = true;
    state.aiPick = false;
    state.callManual = true;
    applyModeToUI();
    applyRunModeUI();
    state.enabled = true;
    state.runIntent = { active: true, mode: 'filter', at: Date.now() };
    _userFastDataOff = false;
    save();
    applyUniversalToUI();
    render();
    const f = state.filters || {};
    const bullOn = !!f.bullish && BULL_FILTER_KEYS.some(k => !!f[k]);
    const bearOn = !!f.bearish && BEAR_FILTER_KEYS.some(k => !!f[k]);
    if (!bullOn && !bearOn) {
      log('Indicator-filters mode started - NO Bullish/Bearish filter selected, no trades will be placed. Tick at least one indicator filter in the Indicator filters section.', 'warn');
    } else {
      /* List EXACTLY the ticked filters that AST now reads/monitors (the entry
         gates). Only these are evaluated on each monitored symbol - unselected
         filters are never included. */
      const names = selectedFilterNames();
      log('Indicator-filters mode started - AST monitors ONLY these ' + names.length + ' selected filter' + (names.length === 1 ? '' : 's') + ': ' + names.join(' | ') + '. A trade is placed on a symbol only when ALL of them pass together on its chart (strict AND)', 'ok');
    }
    tick();
  }

  /* Mutual-exclusion run-mode selector: exactly one run mode is active. Ticking
     a mode's checkbox activates it (the other fades/inactive); unticking one
     silently switches to the other so a run mode is always selected. */
  function onRunModeToggle(mode, checked) {
    state.filterMode = (checked) ? mode === 'filter' : mode !== 'filter';
    save();
    applyRunModeUI();
  }

  /* Reflect the active run mode on the two run buttons + their checkboxes:
     active mode fully visible, the opposite button faded + disabled. */
  function applyRunModeUI() {
    const filterMode = state.filterMode === true;
    const nCb = $id('astRunPaperModeCb');
    if (nCb) nCb.checked = !filterMode;
    const fCb = $id('astFilterModeCb');
    if (fCb) fCb.checked = filterMode;
    const runBtn = $id('astRunPaperBtn');
    if (runBtn) {
      runBtn.style.opacity = filterMode ? '0.35' : '1';
      runBtn.disabled = filterMode;
    }
    const fBtn = $id('astFilterPaperBtn');
    if (fBtn) {
      fBtn.style.opacity = filterMode ? '1' : '0.35';
      fBtn.disabled = !filterMode;
    }
  }

  function importFromPaperTrade(list) {
    if (!Array.isArray(list) || !list.length) {
      log('No strategies received to import', 'warn');
      return 0;
    }
    const now = Date.now();
    let added = 0;
    list.forEach(s => {
      if (!s || !s.key) return;
      const id = 'pt:' + s.key;
      if (state.imported.some(x => x.id === id)) return;
      state.imported.push({
        id: id,
        /* AE backtests append a strike + CE/PE suffix to the strategy name
           ("Bullish Candle 2450 CE"); strip it so the imported label never
           conflicts with the Run Strategy In CE/PE control (which decides the
           side, not the AE backtest leg). */
        name: String(s.name || 'Paper Trade strategy').replace(/\s+\d+(?:\.\d+)?\s+(CE|PE)\s*$/i, '').trim() || 'Paper Trade strategy',
        cat: s.cat || 'bullish',
        method: s.method || '',
        tf: s.tf || '5min',
        score: s.score || 0,
        verdict: s.verdict || 'Moderate',
        entry: s.entry || null,
        exit: s.exit || null,
        entryExtra: s.entryExtra || [],
        exitExtra: s.exitExtra || [],
        entryThreshold: s.entryThreshold != null ? s.entryThreshold : null,
        candlestick: s.candlestick || { enabled: false, entry: [], exit: [] },
        /* Reference-only AE risk snapshot carried for display in the Strategy
           Container (what the AE engine used). AST execution ignores these -
           it always runs on its own settings basis. */
        refSlPct: (s.refSlPct != null) ? s.refSlPct : (s.autoSlPct != null ? s.autoSlPct : null),
        refTrailSlPct: (s.refTrailSlPct != null) ? s.refTrailSlPct : null,
        /* The Auto Experiment margin this strategy was created under. When set,
           the strategy trades on that AE budget only (its own cap), never on the
           AI Smart / manual wallet margin. */
        marginCap: (s.marginCap != null && isFinite(Number(s.marginCap)) && Number(s.marginCap) > 0) ? Number(s.marginCap) : null,
        fromPaperTrade: true,
        createdAt: now
      });
      setSettingsFor(id);
      state.selected[id] = true;
      added++;
    });
    save();
    render();
    if (added) log('Imported ' + added + ' strategy(s) from AI Paper Trade into Selected Strategies', 'ok');
    else log('Strategies already in Selected Strategies', 'warn');
    return added;
  }

  function clearImported() {
    state.imported.forEach(s => { delete state.selected[s.id]; });
    state.imported = [];
    state.manual.forEach(s => { delete state.selected[s.id]; });
    state.manual = [];
    state.aiPicks.forEach(s => { delete state.selected[s.id]; });
    state.aiPicks = [];
    save();
    render();
    log('Cleared all selected strategies', 'warn');
  }

  function removeImported(id) {
    state.imported = state.imported.filter(x => x.id !== id);
    delete state.selected[id];
    save();
    render();
  }

  /* AE-origin strategy objects can carry backtest-only instrument info (the
     symbol it was measured on, its strike + CE/PE side, premium, sid, expiry,
     run basis). AST execution is universe-driven and the global "Run Strategy
     In" CE/PE control decides the side, so these fields are stripped before a
     strategy is saved into the Final Strategy section - the AE's symbol and
     CE/PE must not leak into AST. */
  function stripAeInstrumentFields(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const out = JSON.parse(JSON.stringify(obj));
    ['symbol', 'spot', 'optionStrike', 'optionType', 'optionSid', 'premium', 'delta', 'expiry', 'backtestBasis', 'runBasis'].forEach(k => { delete out[k]; });
    return out;
  }

  /* Save an AST-engine strategy (saved / imported / manual / AI-pick) into the
     Final Strategy section. Captures the strategy definition + a raw snapshot of
     the engine settings currently applied, so it can be re-run later with its
     original SL / trail SL / TP / timeframes / run-in settings - the same way
     the AE engine hands a strategy to AST. */
  function sendToFinal(id) {
    if (!window.FinalStrategy || typeof FinalStrategy.saveStrategy !== 'function') {
      log('Final Strategy module not ready', 'warn');
      return null;
    }
    let s = null;
    const saved = loadSaved().find(x => String(x.id) === String(id));
    const imported = (state.imported || []).find(x => String(x.id) === String(id));
    const manual = (state.manual || []).find(x => String(x.id) === String(id));
    const aiPick = (state.aiPicks || []).find(x => String(x.id) === String(id));
    s = saved || imported || manual || aiPick;
    if (!s) { log('Strategy not found: ' + id, 'warn'); return null; }
    setSettingsFor(id);
    const snapshot = state.settingsSnapshots ? state.settingsSnapshots[id] : null;
    const closed = (state.closed || []).filter(t => t && t.strategyId != null && String(t.strategyId) === String(id));
    let wins = 0, losses = 0, net = 0;
    closed.forEach(t => {
      const p = (t.netPnl != null) ? Number(t.netPnl) : Number(t.pnl || 0);
      net += p;
      if (p > 0) wins++; else if (p < 0) losses++;
    });
    const entry = FinalStrategy.saveStrategy({
      key: 'ast:' + id,
      /* AE-imported strategies carry a backtest strike + CE/PE suffix in their
         name (e.g. "Bullish Candle 2450 CE"); drop it so the Final Strategy
         label stays clean - the AST engine's Run Strategy In control decides
         the side, not the AE backtest leg. */
      name: String(s.name || 'Strategy').replace(/^AE:\s*/, '').replace(/\s+\d+(?:\.\d+)?\s+(CE|PE)\s*$/i, '').trim() || 'Strategy',
      cat: s.cat === 'bearish' ? 'bearish' : 'bullish',
      method: s.method || '',
      tf: s.tf || '',
      symbol: (s.symbol && s.symbol.name) || null,
      stats: {
        trades: closed.length, wins: wins, losses: losses,
        winRate: closed.length ? Math.round((wins / closed.length) * 1000) / 10 : 0,
        totalNet: Math.round(net * 100) / 100,
        avgPerTrade: closed.length ? Math.round((net / closed.length) * 100) / 100 : 0,
        daysTraded: 0, lastDay: null,
        profitFactor: null
      },
      settings: null,
      snapshot: snapshot ? JSON.parse(JSON.stringify(snapshot)) : null,
      strategy: stripAeInstrumentFields(s),
      source: 'ast'
    });
    if (entry) log('"' + entry.name + '" saved to Final Strategy', 'ok');
    return entry;
  }

  /* Remove strategies from the saved strategy library (localStorage), either all
     of one category or only the ticked ones. Also drops them from the selected
     lists, untracks them from state.selected and squares off any open position
     held by a removed strategy. */
  function removeSavedList(cat, mode) {
    const isBear = cat === 'bear';
    const inCat = s => isBear ? s.cat === 'bearish' : s.cat !== 'bearish';
    const saved = loadSaved();
    const removeIds = new Set();
    saved.forEach(s => {
      if (inCat(s) && (mode === 'all' || !!state.selected[s.id])) removeIds.add(String(s.id));
    });
    if (!removeIds.size) {
      log('No ' + (isBear ? 'bearish' : 'bullish') + ' saved strategies to remove', 'warn');
      return;
    }
    const kept = saved.filter(s => !removeIds.has(String(s.id)));
    try { localStorage.setItem(SAVED_KEY, JSON.stringify(kept)); } catch (e) {}
    state.manual = (state.manual || []).filter(s => !removeIds.has(String(s.id)));
    state.aiPicks = (state.aiPicks || []).filter(s => !removeIds.has(String(s.id)));
    state.imported = (state.imported || []).filter(s => !removeIds.has(String(s.id)));
    removeIds.forEach(id => delete state.selected[id]);
    const pt = basePaper();
    const paper = (window.AutoExperiment && AutoExperiment.paper) ? AutoExperiment.paper : null;
    Object.keys(state.positions).forEach(k => {
      if (removeIds.has(String(state.positions[k].strategyId))) {
        if (pt && pt.autoExit) pt.autoExit(k);
        if (paper) { if (paper.dropTrailEngine) paper.dropTrailEngine(k); if (paper.dropAiTrailEngine) paper.dropAiTrailEngine(k); }
        if (state.positions[k]) recordClosedPosition(state.positions[k]);
        delete state.positions[k];
      }
    });
    save();
    render();
    log('Removed ' + removeIds.size + ' ' + (isBear ? 'bearish' : 'bullish') + ' saved strategies', 'warn');
  }

  /* Open the main chart tab for a fetched/selected strategy. Uses the
     strategy's own symbol when it has one, otherwise falls back to the
     currently selected chart symbol; applies the strategy timeframe. */
  function openChart(id) {
    const list = [...(state.manual || []), ...(state.aiPicks || []), ...(state.imported || [])];
    const s = list.find(x => String(x.id) === String(id));
    if (!s) { log('Strategy not found in the selected strategies', 'warn'); return; }
    /* Running-trade chart: when a position is OPEN for this strategy, open the
       chart on the position's EXECUTION (option strike) symbol so the entry /
       SL / TP / live-P&L lines draw on the candles. Opening the strategy's own
       (underlying) symbol would show a bare chart - the open position's symbol
       never matches the displayed symbol, so syncTradeChartLines draws nothing. */
    let sym = null;
    const pos = Object.keys(state.positions || {})
      .map(k => state.positions[k])
      .find(p => p && String(p.strategyId) === String(id));
    if (pos && pos.symbolId != null) {
      const ex = pos.symbolExch || 'NSE_FNO';
      const inst = pos.inst || (ex === 'NSE_EQ' ? 'EQUITY' : (ex === 'IDX_I' ? 'INDEX' : 'OPTIDX'));
      sym = {
        id: Number(pos.symbolId),
        exch: ex,
        inst: inst,
        name: pos.symbol || pos.instrumentName || String(pos.symbolId),
        ocId: pos.ocId != null ? Number(pos.ocId) : Number(pos.symbolId),
        ocExch: pos.ocExch || ex
      };
      if (typeof setChartTf === 'function' && s.tf) setChartTf(s.tf);
      if (typeof openOptionChartBySid === 'function') {
        const p = openOptionChartBySid(sym.id, sym.exch, sym.inst, sym.name, sym.ocId, sym.ocExch);
        deployAstOverlaysAfter(p, specsForOpenChart(s));
        log('Opened running-trade chart for "' + s.name + '" on ' + (sym.name || sym.id), 'ok');
        return;
      }
    }
    if (!sym) sym = s.symbol || null;
    if (!sym && typeof selectedSymbol !== 'undefined') sym = selectedSymbol;
    if (sym && typeof selectedSymbol !== 'undefined') {
      selectedSymbol = JSON.parse(JSON.stringify(sym));
    }
    if (typeof setChartTf === 'function' && s.tf) setChartTf(s.tf);
    let _p = null;
    if (typeof onSymbolChange === 'function') { try { _p = onSymbolChange(); } catch (e) { _p = null; } }
    if (typeof activateTab === 'function') activateTab('chart');
    deployAstOverlaysAfter(_p, specsForOpenChart(s));
    log('Opened chart for "' + s.name + '"' + (sym ? ' (' + (sym.name || sym.id) + ')' : ''), 'ok');
  }

  function stopPosition(strategyId) {
    const pkey = Object.keys(state.positions).find(k => state.positions[k].strategyId === strategyId);
    const p = pkey ? state.positions[pkey] : null;
    const pt = basePaper();
    if (pt && pt.autoExit && pkey) pt.autoExit(pkey);
    const paper = (window.AutoExperiment && AutoExperiment.paper) ? AutoExperiment.paper : null;
    if (paper && pkey) { if (paper.dropTrailEngine) paper.dropTrailEngine(pkey); if (paper.dropAiTrailEngine) paper.dropAiTrailEngine(pkey); }
    if (pkey) { if (state.positions[pkey]) recordClosedPosition(state.positions[pkey]); delete state.positions[pkey]; }
    save();
    render();
    if (p) log('Manually stopped "' + p.strategyName + '" (' + p.instrumentName + ')', 'warn');
  }

  function stopAll() {
    const keys = Object.keys(state.positions);
    if (!keys.length) { log('No running AI Smart positions to stop', 'warn'); return; }
    const pt = basePaper();
    const paper = (window.AutoExperiment && AutoExperiment.paper) ? AutoExperiment.paper : null;
    keys.forEach(k => {
      if (pt && pt.autoExit) pt.autoExit(k);
      if (paper) { if (paper.dropTrailEngine) paper.dropTrailEngine(k); if (paper.dropAiTrailEngine) paper.dropAiTrailEngine(k); }
      if (state.positions[k]) recordClosedPosition(state.positions[k]);
      delete state.positions[k];
    });
    save();
    render();
    log('Stopped all ' + keys.length + ' AI Smart positions', 'warn');
  }

  /* Reset the Smart P&L completely: clears every closed AI Smart trade, the
     running-positions mirror and the realized totals, and wipes the shared
     paper-trade ledger (open positions + closed history + equity curve) so the
     next trade starts from a clean ₹0 slate. */
  function resetPnl() {
    if (!window.confirm('Reset all Smart P&L?\n\nThis clears every closed AI Smart trade, all running positions and the paper-trade ledger (open positions + closed history). This cannot be undone.')) return;
    try { const bpt = basePaper(); if (bpt && bpt.reset) bpt.reset(); } catch (e) {}
    state.closed = [];
    state.positions = {};
    state.rpnl = { realized: 0, charges: 0, count: 0, wins: 0 };
    _lastClosedKey = '';
    save();
    render();
    log('Smart P&L reset - totals cleared', 'warn');
  }

  /* Stop EVERYTHING in this engine: turn off AI-pick mode, un-tick all manual
     selections, square off all open positions and disable the engine so the
     live poll cannot re-enter any trade. Used by the unified Close All
     Strategies / Close All Trades controls. */
  function stopAllStrategies(keepEnabled) {
    state.aiPick = false;
    if (!keepEnabled) state.enabled = false;
    state.runIntent = { active: false, mode: state.filterMode ? 'filter' : 'normal', at: Date.now() };
    _stopGen++;
    applyModeToUI();
    selectNone();
    stopAll();
    save();
    applyUniversalToUI();
    log(keepEnabled
      ? 'All AI Smart trades closed - strategies unticked (re-tick to resume)'
      : 'All AI Smart strategies stopped', 'warn');
  }

  function onTabShow() {
    applyUniversalToUI();
    renderMoversList();
    render();
    /* Duplicated paper tabs only poll while visible (see onTabHide). */
    if (!_pollTimer) startPoll();
  }
  function onTabHide() {
    /* The BASE AI Smart engine is an always-on live paper algo: leaving the
       AST app tab must never pause its evaluation / entry / running-trade
       bookkeeping, so a tab switch never looks like the algo "reset". Only
       duplicated paper-tab instances (a suffix exists) idle-stop while hidden
       so clones do not hammer the Dhan feed. */
    if (suffix) stopPoll();
  }

  /* ---------------- engine settings templates ----------------
     A template captures the full engine settings (universal defaults, strike,
     run-in / trade-in modes, research groups, filters, movers, NIFTY entry /
     exit gates and NIFTY trend timeframe) under a name + market mode
     (bullish / bearish / sideways). Opening a template re-applies those
     settings to the engine UI and state immediately. */
  const AST_TPL_KEY = 'algodhan_ast_templates_v1';

  function tplLoad() {
    try {
      const l = JSON.parse(localStorage.getItem(AST_TPL_KEY) || '[]');
      return Array.isArray(l) ? l : [];
    } catch (e) { return []; }
  }
  function tplSave(list) {
    try { localStorage.setItem(AST_TPL_KEY, JSON.stringify(list)); } catch (e) {}
  }

  function renderTemplateSelect() {
    const el = $id('astTplOpen');
    if (!el) return;
    el.innerHTML = '<option value="">-- none --</option>' + tplLoad().map(t =>
      '<option value="' + esc(t.id) + '">' + esc(t.name) + ' (' + esc(t.mode) + ')</option>').join('');
    refreshQuickRunSelects();
  }

  /* Fill one "AST saved templates quick run" <select> with every saved engine
     template. Each option shows the template name, its market mode, the run
     mode it was saved under and how many ticked strategies it carries, so the
     user knows exactly what the Run button will start. Repopulation is skipped
     when the template set did not change (dataset.tplIds cache). */
  function fillQuickRunSelect(sel) {
    if (!sel) return;
    const list = tplLoad();
    const cur = sel.value;
    const modeLabel = (rm) => rm === 'filter' ? 'Indicator-filters run' : (rm === 'aipick' ? 'AI auto-pick run' : 'strategies run');
    const rows = list.map(t => {
      const st = (t.settings && typeof t.settings === 'object') ? t.settings : {};
      const rm = st.runMode || (st.filterMode === true ? 'filter' : (st.aiPick === true ? 'aipick' : 'normal'));
      const n = Array.isArray(st.selected) ? st.selected.length : 0;
      return {
        id: String(t.id),
        label: esc(String(t.name)) + ' (' + esc(t.mode || '') + ') · ' + modeLabel(rm) + (n ? ' · ' + n + ' strat' : '')
      };
    });
    const sig = rows.map(r => r.id + '~' + r.label).join('|');
    if (sel.dataset.tplIds === sig) {
      if (cur && sel.querySelector('option[value="' + cur + '"]')) sel.value = cur;
      return;
    }
    sel.dataset.tplIds = sig;
    if (!rows.length) {
      sel.innerHTML = '<option value="">-- no saved templates --</option>';
      return;
    }
    sel.innerHTML = '<option value="">-- select template --</option>' + rows.map(r =>
      '<option value="' + r.id + '">' + r.label + '</option>').join('');
    if (cur && sel.querySelector('option[value="' + cur + '"]')) sel.value = cur;
  }

  /* Fill this engine instance's own quick-run dropdown (the suffixed element
     when running inside a cloned paper tab). */
  function populateQuickRunSelect() {
    fillQuickRunSelect($id('ptAstTplRun'));
  }

  /* Templates are shared across every paper tab, so a save / delete / boot on
     any engine refreshes EVERY quick-run dropdown in the document (the base
     Paper Trade tab + all cloned paper-tab copies). */
  function refreshQuickRunSelects() {
    if (!document.querySelectorAll) { populateQuickRunSelect(); return; }
    const sels = document.querySelectorAll('select[id^="ptAstTplRun"]');
    if (!sels.length) return;
    for (let i = 0; i < sels.length; i++) fillQuickRunSelect(sels[i]);
  }

  /* Fill the "AST saved templates quick run" dropdown (this tab's own copy;
     cloned paper tabs carry their suffixed element and each engine instance
     fills its own) with every saved engine-settings template. Each option
     shows the template name, its market mode, the run mode it was saved under
     and how many ticked strategies it carries, so the user knows exactly what
     the Run button will start. */
  function populateQuickRunSelect() {
    const el = $id('ptAstTplRun');
    if (!el) return;
    const list = tplLoad();
    const cur = el.value;
    const joined = list.map(t => String(t.id)).join('|');
    if (el.dataset.tplIds === joined) {
      if (cur && el.querySelector('option[value="' + cur + '"]')) el.value = cur;
      return;
    }
    el.dataset.tplIds = joined;
    if (!list.length) {
      el.innerHTML = '<option value="">-- no saved templates --</option>';
      return;
    }
    const modeLabel = (rm) => rm === 'filter' ? 'Indicator-filters run' : (rm === 'aipick' ? 'AI auto-pick run' : 'strategies run');
    el.innerHTML = '<option value="">-- select template --</option>' + list.map(t => {
      const st = (t.settings && typeof t.settings === 'object') ? t.settings : {};
      const rm = st.runMode || (st.filterMode === true ? 'filter' : (st.aiPick === true ? 'aipick' : 'normal'));
      const n = Array.isArray(st.selected) ? st.selected.length : 0;
      return '<option value="' + esc(String(t.id)) + '">' + esc(String(t.name)) + ' (' + esc(t.mode || '') + ') · ' + modeLabel(rm) + (n ? ' · ' + n + ' strat' : '') + '</option>';
    }).join('');
    if (cur && el.querySelector('option[value="' + cur + '"]')) el.value = cur;
  }

  /* Deep copies of every strategy currently TICKED (state.selected[id] true)
     across all four engine sources (saved library / imported / manual / AI
     picks). Stored inside a saved engine-settings template so the "quick run"
     control can restore the exact ticked strategy set it was saved with - even
     when the library has changed since - before starting the engine. */
  function tickedDefsSnapshot() {
    const out = [];
    const seen = {};
    const push = (s) => {
      if (!s || s.id == null) return;
      const k = String(s.id);
      if (seen[k]) return;
      seen[k] = 1;
      try { out.push(JSON.parse(JSON.stringify(s))); } catch (e) {}
    };
    savedByGroup().forEach(s => { if (s && state.selected[s.id]) push(s); });
    (state.imported || []).forEach(s => { if (s && state.selected[s.id]) push(s); });
    (state.manual || []).forEach(s => { if (s && state.selected[s.id]) push(s); });
    (state.aiPicks || []).forEach(s => { if (s && state.selected[s.id]) push(s); });
    return out;
  }

  /* Snapshot the current live engine settings (state already mirrors the UI
     because every input change calls its read* handler). Includes the current
     instrument pick set (the symbols this engine trades under the configured
     selection rules) so saved templates carry their own symbol universe. The
     active run mode (normal / filter) plus the currently ticked strategy
     definitions are captured too, so a template can be re-run with one click:
     the quick-run control applies these settings and starts the engine exactly
     as it was when the template was saved. */
  function captureEngineSettings() {
    const ri = state.runIntent && state.runIntent.active;
    return {
      universal: JSON.parse(JSON.stringify(state.universal)),
      strike: JSON.parse(JSON.stringify(state.strike)),
      runIn: JSON.parse(JSON.stringify(state.runIn)),
      tradeIn: JSON.parse(JSON.stringify(state.tradeIn)),
      premiumOnly: !!state.premiumOnly,
      groups: (state.groups || []).slice(),
      filters: JSON.parse(JSON.stringify(state.filters)),
      movers: JSON.parse(JSON.stringify(state.movers)),
      niftyTf: _niftyTf,
      commodity: state.commodity ? JSON.parse(JSON.stringify(state.commodity)) : { enabled: false, sids: [] },
      symbols: experimentSymbols(),
      allInOne: state.allInOne === true,
      /* Which run the template was saved under: 'normal' (Run Paper Trading on
         ticked strategies), 'filter' (Indicator-filters mode) or 'aipick'
         (Smart AI trader auto-pick). */
      runMode: ri ? ri.mode : (state.filterMode === true ? 'filter' : (state.aiPick === true ? 'aipick' : 'normal')),
      aiPick: state.aiPick === true,
      aiPickN: Math.max(1, Number(state.aiPickN) || 5),
      aiPickBull: state.aiPickBull !== false,
      aiPickBear: state.aiPickBear !== false,
      selected: tickedDefsSnapshot()
    };
  }

  /* Lightweight per-strategy engine-settings snapshot (no experimentSymbols
     resolution - just the settings that determine how a strategy's trades are
     risk-managed). Stored on the strategy id so the Final Strategy section can
     show the exact SL / Trail SL / TP / AI settings applied while it ran. */
  function settingsSnapshot() {
    return {
      universal: JSON.parse(JSON.stringify(state.universal)),
      strike: JSON.parse(JSON.stringify(state.strike)),
      runIn: JSON.parse(JSON.stringify(state.runIn)),
      tradeIn: JSON.parse(JSON.stringify(state.tradeIn)),
      premiumOnly: !!state.premiumOnly,
      groups: (state.groups || []).slice(),
      filters: JSON.parse(JSON.stringify(state.filters)),
      niftyTf: _niftyTf,
      capturedAt: Date.now()
    };
  }

  /* Record the engine settings currently applied to a strategy id. The map is
     capped (oldest evicted) so the persisted state stays small no matter how
     many strategies run. */
  function setSettingsFor(id) {
    if (!id) return;
    if (!state.settingsSnapshots) state.settingsSnapshots = {};
    const snap = settingsSnapshot();
    const keys = Object.keys(state.settingsSnapshots);
    if (keys.length >= 200 && !state.settingsSnapshots[id]) {
      let oldest = keys[0];
      for (let i = 1; i < keys.length; i++) {
        if ((state.settingsSnapshots[keys[i]].capturedAt || 0) < (state.settingsSnapshots[oldest].capturedAt || 0)) oldest = keys[i];
      }
      delete state.settingsSnapshots[oldest];
    }
    state.settingsSnapshots[id] = snap;
    save();
  }

  function applyEngineSettings(s) {
    if (!s) return;
    if (s.universal) state.universal = Object.assign(state.universal || {}, JSON.parse(JSON.stringify(s.universal)));
    if (s.strike) state.strike = Object.assign(state.strike || {}, JSON.parse(JSON.stringify(s.strike)));
    if (s.runIn) state.runIn = Object.assign(state.runIn || {}, JSON.parse(JSON.stringify(s.runIn)));
    if (s.tradeIn) state.tradeIn = Object.assign(state.tradeIn || {}, JSON.parse(JSON.stringify(s.tradeIn)));
    if (typeof s.premiumOnly === 'boolean') state.premiumOnly = s.premiumOnly;
    if (Array.isArray(s.groups) && s.groups.length) state.groups = s.groups.slice();
    if (s.filters) state.filters = Object.assign(state.filters || {}, JSON.parse(JSON.stringify(s.filters)));
    if (s.movers) state.movers = Object.assign(state.movers || {}, JSON.parse(JSON.stringify(s.movers)));
    if (s.niftyTf) setNiftyTf(s.niftyTf);
    if (s.commodity) state.commodity = Object.assign({ enabled: false, sids: [] }, JSON.parse(JSON.stringify(s.commodity)));
    if (typeof s.allInOne === 'boolean') state.allInOne = s.allInOne;
    /* Restore the template's captured instrument set so the engine's symbol
       selection (experimentSymbols / pooled runner) matches the template. */
    if (Array.isArray(s.symbols) && s.symbols.length) state.symbols = s.symbols.slice();
    save();
    applyUniversalToUI();
    applyCommodityToUI();
    render();
    updateNiftyBiasStatus(null);
    log('Engine settings applied from template', 'ok');
  }

  function saveTemplate() {
    const nameEl = $id('astTplName'), modeEl = $id('astTplMode');
    const name = (nameEl && nameEl.value.trim()) || '';
    const mode = (modeEl && (modeEl.value === 'bullish' || modeEl.value === 'bearish' || modeEl.value === 'sideways')) ? modeEl.value : 'bullish';
    if (!name) { log('Template name required', 'warn'); return; }
    const list = tplLoad();
    list.push({ id: 'tpl_' + Date.now(), name, mode, settings: captureEngineSettings(), updated: Date.now() });
    tplSave(list);
    renderTemplateSelect();
    log('Engine settings template "' + name + '" (' + mode + ') saved', 'ok');
  }

  function openTemplate(id) {
    if (!id) return;
    const t = tplLoad().find(x => String(x.id) === String(id));
    if (!t) return;
    applyEngineSettings(t.settings);
    log('Template "' + t.name + '" (' + t.mode + ') applied to engine', 'ok');
  }

  function deleteTemplate() {
    const el = $id('astTplOpen');
    const id = el ? el.value : '';
    if (!id) { log('Select a template to delete', 'warn'); return; }
    tplSave(tplLoad().filter(x => String(x.id) !== String(id)));
    renderTemplateSelect();
    log('Template deleted', 'ok');
  }

  /* ---------------- quick run: saved engine template ----------------
     "AST saved templates quick run" section (above the Running Strategies list
     in the Paper Trade tab). Pick a saved engine-settings template from the
     dropdown and press Run: the engine applies that template's full settings
     (universal defaults / SL / trail SL / TP / AI risk / strikes / run-in /
     indicator filters / movers / captured symbols), restores the strategies
     that were ticked when the template was saved, then starts the exact run
     mode the template was saved under - Run Paper Trading (ticked strategies)
     or Indicator-filters mode (filter-AND trades on the captured universe). */

  /* Start the engine in the Smart AI trader auto-pick mode (the template
     variant of runPaper - keeps aiPick ON so activeStrategies() re-picks the
     top-N strategies every tick instead of only running manual ticks). */
  function startAiPickRun() {
    readUniversal();
    state.filterMode = false;
    state.aiPick = true;
    state.callManual = true;
    applyModeToUI();
    applyRunModeUI();
    state.enabled = true;
    state.runIntent = { active: true, mode: 'normal', at: Date.now() };
    _userFastDataOff = false;
    save();
    applyUniversalToUI();
    render();
    log('Smart AI trader auto-pick run started - engine picks the top strategies every tick', 'ok');
    tick();
  }

  /* Make sure every saved ticked-strategy definition is present in the engine
     so the run can evaluate it. A strategy still in the saved library keeps its
     library identity; one that no longer exists anywhere in the engine is
     re-materialized into the imported list under the same id, then ticked. */
  function ensureTickedDefs(defs) {
    if (!Array.isArray(defs) || !defs.length) return 0;
    const known = {};
    const mark = (arr) => (Array.isArray(arr) ? arr : []).forEach(s => { if (s && s.id != null) known[String(s.id)] = true; });
    mark(savedByGroup());
    mark(state.imported || []);
    mark(state.manual || []);
    mark(state.aiPicks || []);
    let restored = 0;
    defs.forEach(def => {
      if (!def || def.id == null) return;
      const idStr = String(def.id);
      if (!known[idStr]) {
        try {
          const copy = JSON.parse(JSON.stringify(def));
          copy._fromTemplate = true;
          if (copy.createdAt == null) copy.createdAt = Date.now();
          state.imported.push(copy);
          known[idStr] = true;
        } catch (e) { return; }
      }
      state.selected[idStr] = true;
      restored++;
    });
    return restored;
  }

  /* Apply a saved engine template and start the engine running it. Shared by
     the quick-run control (runTemplateById(id)) and reusable programmatically. */
  function runTemplateById(id) {
    const t = tplLoad().find(x => String(x.id) === String(id));
    if (!t) {
      log('Template not found - save it again from the AI Smart Template bar', 'warn');
      return { ok: false, name: '', mode: '', runMode: '', restored: 0 };
    }
    const st = (t.settings && typeof t.settings === 'object') ? t.settings : {};
    applyEngineSettings(st);
    let restored = 0;
    if (Array.isArray(st.selected) && st.selected.length) restored = ensureTickedDefs(st.selected);
    const runMode = st.runMode || (st.filterMode === true ? 'filter' : (st.aiPick === true ? 'aipick' : 'normal'));
    save();
    render();
    if (runMode === 'filter') {
      runFilterPaper();
    } else if (runMode === 'aipick') {
      if (st.aiPick === true) { state.aiPick = true; const aEl = $id('astAiPick'); if (aEl) aEl.checked = true; }
      startAiPickRun();
    } else {
      runPaper();
    }
    const label = runMode === 'filter' ? 'Indicator-filters mode' : (runMode === 'aipick' ? 'AI auto-pick run' : 'Run Paper Trading');
    if (runMode === 'normal' && !restored) {
      log('Template "' + t.name + '" (' + t.mode + ') applied - Run Paper Trading started with NO ticked strategy stored in it (tick a strategy and re-save the template to capture the full run)', 'warn');
    } else {
      log('Template "' + t.name + '" (' + t.mode + ') applied - ' + label + ' started' + (restored ? ' with ' + restored + ' strategy(s) restored from the template' : ''), 'ok');
    }
    return { ok: true, name: t.name, mode: t.mode, runMode: runMode, restored: restored };
  }

  /* Run button of the "AST saved templates quick run" section: reads the
     selected template from this tab's dropdown and starts the engine on it. */
  function quickRunTemplate() {
    const el = $id('ptAstTplRun');
    const id = el ? String(el.value || '') : '';
    const statusEl = $id('ptAstTplRunStatus');
    if (!id) {
      log('Select a saved template from the quick-run dropdown first', 'warn');
      if (statusEl) statusEl.innerHTML = '<span style="color:#ff9800">Please select a saved template from the dropdown first.</span>';
      return { ok: false };
    }
    const res = runTemplateById(id);
    if (statusEl) {
      statusEl.innerHTML = res.ok
        ? '<span style="color:#b39ddb;font-weight:700">RUN</span> template <b style="color:#fff">' + esc(res.name) + '</b> (' + esc(res.mode || '') + ') started in <b style="color:#00d4aa">' + (res.runMode === 'filter' ? 'Indicator-filters' : (res.runMode === 'aipick' ? 'AI auto-pick' : 'normal strategies')) + '</b> mode' + (res.restored ? ' · <span style="color:#ffd700">' + res.restored + ' strategy(s) restored</span>' : '') + ' <span style="color:#666">- engine ON, running live (details in the AST log below)</span>'
        : '<span style="color:#ef5350">Run failed - see the AI Smart log below.</span>';
    }
    return res;
  }


  /* ---------------- public API ---------------- */
  const api = {
    toggleAuto,
    onUniversalInput() { readUniversal(); },
    onDataPoolToggle() { onDataPoolToggle(); },
    onFastDataInput() { onFastDataInput(); },
    poolRefresh() { poolRefresh(); },
    toggleAutoSl,
    onStrikeInput() { readStrikeUI(); },
    onFastestRisingInput() { onFastestRisingInput(); },
    onRunInInput() { readRunInUI(); },
    onTradeInInput() { readTradeInUI(); },
    onPremiumOnlyInput() { onPremiumOnlyInput(); },
    onGroupsInput() { readGroupsUI(); },
    toggleMovers,
    onMoversInput() { readMoversUI(); applyMoversToUI(); },
    toggleNiftyTrend,
    toggleSim,
    onNiftyTrendInput() { readNiftyTrendUI(); _resetTrendScan(); applyNiftyTrendToUI(); },
    toggleCommodity,
    addCommodity,
    removeCommodity,
    onCommodityInput() { applyCommodityToUI(); },
    addNiftyTrendIndex,
    removeNiftyTrendIndex,
    renderNiftyTrendList,
    onFiltersInput() { readFiltersUI(); },
    /* "All indicators & filters together" mode: ON = the strategy's entry fires
       only when every selected indicator/filter AND its own conditions pass
       together (strict AND, no N-of-M). OFF = old default entry behavior. */
    onAllInOne() {
      const el = $id('astAllInOne');
      state.allInOne = !!(el && el.checked);
      _workingCache.clear();
      save();
      log('Entry "all indicators & filters together": ' + (state.allInOne ? 'ON (strict AND)' : 'OFF (old default)'), state.allInOne ? 'ok' : 'warn');
    },
    allInOneEnabled() { return state.allInOne === true; },
    /* Direction-matched filter conditions built for a strategy template (also
       exposed for the Auto Experiment engine). */
    filterConditionsFor(tpl) { return directionFilterConditions(tpl); },
    /* Strict all-together entry evaluation on a given candle series (used by
       the Auto Experiment engine when its "all together" checkbox is ON). */
    strictEntryOk(tpl, candles, i) { return strictEntryOkAt(tpl, candles, i); },
    /* Master Bullish/Bearish checkbox: checking it selects every sub-filter in
       that section, unchecking it clears them all (no more one-by-one). */
    onFilterMaster(side) {
      const sec = side === 'bullish' ? 'Bullish' : 'Bearish';
      const master = $id('astFilter' + sec);
      const on = !!(master && master.checked);
      const secEl = $id('astFilterSection' + sec);
      if (secEl) {
        const boxes = secEl.querySelectorAll('input[type=checkbox]');
        for (let i = 0; i < boxes.length; i++) {
          const b = boxes[i];
          if (b && b.id && b.id !== 'astFilter' + sec) b.checked = on;
        }
      }
      readFiltersUI();
    },
    setNiftyTf,
    onModeInput() { readModeUI(); },
    addMoverIndex,
    removeMoverIndex,
    addPickedMover,
    removePickedMover,
    renderMoversList,
    renderPickedStrikes,
    toggleStrikes,
    onStrategyCheck,
    onGlobalRunInInput,
    /* Current auto-selected CE/PE side for the Run Strategy In override of a
       strategy (NIFTY trend / top gainers & losers), for external displays. */
    autoRunInSide(id) {
      const s = (state.imported || []).find(x => String(x.id) === String(id));
      return autoRunInSide(s || {});
    },
    selectAll,
    selectNone,
    refresh,
    runManual,
    runPaper,
    /* Indicator-filters run mode: "Place trades based on Indicator filters: All
       together (strict AND)". runFilterPaper starts the engine in filter mode,
       onRunModeToggle handles the mutual-exclusive mode checkboxes. */
    runFilterPaper,
    onRunModeToggle,
    importFromPaperTrade,
    clearImported,
    removeImported,
    addManual,
    removeManual,
    fetchAiPick,
    removeAiPick,
    removeSavedList,
    stopPosition,
    stopAll,
    stopAllStrategies,
    resetPnl,
    openChart,
    onTabShow,
    onTabHide,
    tick,
    runningStrategies() {
      /* Indicator-filters mode has no ticked strategies - expose the synthetic
         filter strategies so the Running Strategies view lists them and their
         fetched strikes. */
      return (state.filterMode === true) ? filterModeStrategies() : activeStrategies();
    },
    /* Multi-timeframe confirmation helpers (exposed for the pooled runner and
       tests): mtfPair() resolves the {entry, trend} timeframe pair from the
       enabled checkboxes; evalEntryMtfLive() runs the confirmation check. */
    mtfPair() { return mtfPair(); },
    evalEntryMtfLive(s, entryCandles, trendCandles, key) { return evalEntryMtfLive(s, entryCandles, trendCandles, key); },
    /* Engine-settings snapshot captured while a strategy was running
       (strategyId -> { capturedAt, settings }), for the Final Strategy panel. */
    getSettingsSnapshot(id) { return (state.settingsSnapshots && id != null) ? state.settingsSnapshots[id] : null; },
    /* Re-apply a captured engine-settings snapshot (SL / trail SL / TP /
       timeframes / run-in) so a saved Final Strategy runs with its original
       settings - the same restore path the saved templates use. */
    applySnapshot(snap) { try { applyEngineSettings(snap); return true; } catch (e) { return false; } },
    sendToFinal(id) { return sendToFinal(id); },
    experimentSymbols() { return experimentSymbols(); },
    chainRateLimited(s) { return chainRateLimited(s); },
    /* Expose the engine's resolved option contracts ("picked strikes") so the
       Running Strategies list can show one chart row per picked premium
       contract - the strikes the strategy is actually running on - instead of
       resolving its own first-contract-only fallback. */
    pickedStrikes() {
      const out = [];
      _pickedStrikes.forEach((rec, key) => {
        if (rec && rec.contracts && rec.contracts.length) {
          out.push({ key: key, symbol: rec.symbol, contracts: rec.contracts, at: rec.at });
        }
      });
      return out;
    },
    pickedStrikesFor(symbol) {
      if (!symbol) return null;
      return _pickedStrikes.get(_pickedKey(symbol)) || null;
    },
    /* Resolve the tradeable instruments for a list of template symbols, exactly
       like the engine does: spot run-in symbols stay spot; index symbols
       resolve to their selected-strike option contract (trade-in is always
       premium for indices) so paper trades are placed on the realistic premium
       instrument (small notional, fits the margin) instead of the raw index.
       Falls back to the spot symbol when no contract can be resolved. */
    async resolveOptionSymbols(symbols) {
      const out = [];
      for (const sym of (symbols || [])) {
        if (!sym) continue;
        /* Already an option instrument (a previous resolution cached on the row
           / pool). Pass it through untouched - re-resolving an option would
           append strike + optionType to its name again on every tick. */
        if (sym.inst === 'OPTIDX' || sym.inst === 'OPTSTK' || (sym.strike != null && sym.premium != null && sym.optionType)) { out.push(sym); continue; }
        // Spot run-in keeps the symbol itself. Premium run-in (indices, or F&O
        // stocks when "Option premium chart" is selected) resolves to the option
        // premium contract; commodities always stay on their futures contract.
        if (runInMode(sym) === 'spot') { out.push(sym); continue; }
        const spot = spotLtpFor(sym);
        let contracts = null;
        try { contracts = await contractsFor(sym, spot); } catch (e) { contracts = null; }
        if (!contracts || !contracts.length) {
          /* contractsFor() came back empty - either the chain was filtered away
             by the engine's "+green premium" rule or it is missing. For the
             pooled runner resolve the plain ATM contract directly instead. */
          try { contracts = await poolAtmContracts(sym, spot); } catch (e) { contracts = null; }
        }
        if (contracts && contracts.length) {
          const c = contracts[0];
          out.push({
            id: Number(c.sid),
            exch: optionExch(sym),
            inst: optionInst(sym),
            name: (sym.name || sym.id) + ' ' + c.strike + ' ' + c.optionType,
            ocId: sym.ocId != null ? sym.ocId : sym.id,
            ocExch: sym.ocExch != null ? sym.ocExch : sym.exch,
            strike: c.strike, optionType: c.optionType,
            premium: c.premium, spotId: sym.id, spotExch: sym.exch
          });
        } else if (isIndex(sym)) {
          /* Index without a resolvable option contract (chain rate-limited /
             unavailable). Do NOT fall back to trading the raw index - its full
             notional never fits the paper margin. Mark it so the pooled runner
             reports the retry state instead of attempting an impossible entry. */
          out.push(Object.assign({}, sym, { _noChain: true }));
        } else {
          out.push(sym);
        }
      }
      return out;
    },
    getState() { return state; },
    saveTemplate,
    openTemplate,
    deleteTemplate,
    /* Quick run of a saved engine-settings template ("AST saved templates
       quick run" section): quickRunTemplate() reads this tab's dropdown and
       starts the engine; runTemplateById(id) is the programmatic variant. */
    quickRunTemplate,
    runTemplateById,
    startAiPickRun,
    /* Resolve the ATM option contract of an F&O STOCK (Smart NTrader). The
       engine's own run-in mode keeps stocks on their spot chart, but the
       NTrader deliberately trades stock OPTION premiums, so this forces a
       derivative resolution anyway. `side` picks the leg: 'CE' for a bullish
       call, 'PE' for a bearish put. Returns the same option instrument shape
       as resolveOptionSymbols() or null when the chain is unavailable /
       rate-limited (the shared per-surface backoff applies). */
    async resolveStockOption(symbol, side, so) {
      if (!symbol) return null;
      const sideType = side === 'PE' ? 'PE' : 'CE';
      const spot = spotLtpFor(symbol);
      let contracts = null;
      try { contracts = await contractsFor(symbol, spot, so); } catch (e) { contracts = null; }
      /* Strict green-only callers (Smart NTrader with "Only +green premium
         strikes" ON) must NOT relax into the pooled ATM fallback: poolAtmContracts
         ignores the green filter, so a minus/zero LTP or LTP-change strike would
         slip in and contradict the "skip minus strikes" rule. When the override
         pins positiveOnly, an empty green result means no qualifying strike -
         report it instead of trading a red strike. */
      if ((!contracts || !contracts.length) && !(so && so.positiveOnly === true)) {
        try { contracts = await poolAtmContracts(symbol, spot); } catch (e) { contracts = null; }
      }
      const c = (contracts || []).find(x => x.optionType === sideType) || (contracts || [])[0];
      if (!c) return null;
      return {
        id: Number(c.sid),
        exch: optionExch(symbol),
        inst: optionInst(symbol),
        name: (symbol.name || symbol.id) + ' ' + c.strike + ' ' + c.optionType,
        ocId: symbol.ocId != null ? symbol.ocId : symbol.id,
        ocExch: symbol.ocExch != null ? symbol.ocExch : symbol.exch,
        strike: c.strike, optionType: c.optionType,
        premium: c.premium, spotId: symbol.id, spotExch: symbol.exch,
        _side: sideType
      };
    },
    /* Normalized list of saved engine-setting templates for external consumers
       (Strategy Container "PT Template" dropdown / pooled runner): each AST
       template is exposed with the runner's expected trade fields
       (lots/margin/tp/sl/fno) derived from its engine-settings snapshot. */
    getTemplates() {
      return tplLoad().map(t => {
        const u = (t.settings && t.settings.universal) || {};
        const lots = u.lots != null ? Number(u.lots) : 1;
        const margin = u.margin != null ? Number(u.margin) : 0;
        const slPct = (u.manualSL ? (Number(u.manualSLPct) || 0) : (Number(u.manualSLPct) || 0)) || 0;
        const tpPct = (u.rrEnabled === true && Number(u.rrValue) > 0 && slPct > 0)
          ? Number((slPct * Number(u.rrValue)).toFixed(2))   // reward = risk x RR
          : ((u.manualTP ? (Number(u.manualTPPct) || 0) : (Number(u.tpPct) || 0)) || (slPct ? Number((slPct * 2).toFixed(2)) : 0));
        return {
          id: 'ast_' + String(t.id),
          name: String(t.name || 'AST Template') + ' [AST]',
          source: 'ast',
          mode: t.mode || '',
          astId: t.id,
          lots: lots,
          margin: margin,
          tpPct: tpPct,
          slPct: slPct,
          fnoLimit: false,
          symbol: null,
          symbols: (t.settings && Array.isArray(t.settings.symbols)) ? t.settings.symbols.slice() : []
        };
      });
    },
  };
  api.boot = boot;
  api.startPoll = startPoll;
  api.stopPoll = stopPoll;

  /* Lightweight live re-render of the Running trades + summary only (no
     strategy list / select re-render). Driven by the throttled ~250ms quote
     loop so the Running P&L uses the exact same live quote the chart shows,
     instead of lagging behind the multi-second poll tick. */
  api.refreshLiveRunning = function () {
    renderRunning();
    renderClosed();
    renderSummary();
  };

  /* P&L summary for external consumers (AI Brain chat / status). Realized is
     summed from the closed-trade ledger (net of charges) so it always matches
     the Closed Positions table; open (unrealized) P&L is priced with the exact
     same chart close the Running Trades row uses, so a still-running trade is
     never reported as a flat zero. */
  api.pnlSummary = function () {
    let realized = 0, charges = 0, count = 0, wins = 0;
    (state.closed || []).forEach((t) => {
      const v = (typeof t.netPnl === 'number') ? t.netPnl : (typeof t.pnl === 'number' ? t.pnl : 0);
      realized += v;
      if (typeof t.charges === 'number') charges += t.charges;
      count++;
      if (v > 0) wins++;
    });
    let openPnlSum = 0, open = 0;
    const openCount = Object.keys(state.positions || {}).length;
    Object.keys(state.positions || {}).forEach((k) => {
      const p = state.positions[k];
      if (!p) return;
      const cur = positionCurrentPrice(p);
      if (cur != null && p.entryPrice != null && p.qty) {
        open++;
        openPnlSum += (p.side === 'BUY' ? (cur - p.entryPrice) : (p.entryPrice - cur)) * p.qty;
      }
    });
    return { realized: realized, charges: charges, count: count, wins: wins,
             winRate: count ? (wins / count * 100) : null,
             openPnl: (openCount && !open) ? null : openPnlSum,
             open: open, openCount: openCount };
  };

  /* Per-tab instance registry + active-tab facade (same tab-id key scheme as
     the other paper engines). */
  if (!window.TabEngines) window.TabEngines = {};
  if (!window.TabEngines.aismart) window.TabEngines.aismart = {};
  const instKey = suffix.replace(/^_/, '') || 'papertrade';
  window.TabEngines.aismart[instKey] = api;

  if (!window._AISmartFacade) {
    const base = api;
    window._AISmartFacade = new Proxy(base, {
      get(t, prop) {
        const key = window._paperActiveEngine || 'papertrade';
        const eng = window.TabEngines.aismart[key] || t;
        const v = eng[prop];
        return typeof v === 'function' ? v.bind(eng) : v;
      },
      set(t, prop, val) {
        const key = window._paperActiveEngine || 'papertrade';
        const eng = window.TabEngines.aismart[key] || t;
        eng[prop] = val;
        return true;
      }
    });
    window.AISmartTrading = window._AISmartFacade;
  }

  function boot() {
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('error', (e) => {
        const msg = (e && e.message) ? e.message : String(e);
        log('JS error: ' + msg, 'warn');
      });
      window.addEventListener('unhandledrejection', (e) => {
        const r = e && e.reason;
        const msg = (r && r.message) ? r.message : String(r);
        log('Unhandled rejection: ' + msg, 'warn');
      });
    }
    populateMoversIndicesUI();
    applyUniversalToUI();
    syncNiftyTfUI();
    if (window.NiftyBbpAlert) {
      NiftyBbpAlert.attach({ pfx: 'ast', symbol: NIFTY_IDX, tfGet: function () { return _niftyTf; }, log: log });
    }
    renderTemplateSelect();
    applyCommodityToUI();
    applyAllInOneToUI();
    applyRunModeUI();
    render();
    startPoll();
    /* Full resume after a page reload. The engine remembers the exact run the
       user had active and re-arms it automatically - identical to pressing the
       Run button again - so settings / ticked strategies / indicator filters /
       picked strikes / running trades all come back without any re-click:

       - runIntent.active=true: the user had pressed Run Paper Trading (normal)
         or Indicator-filters run (filter). We replay that exact button press
         after a short warm-up so the saved settings are re-applied from the
         restored state and the engine re-enters its run loop.
       - otherwise state.enabled=true (Auto toggle was ON): re-tick the already
         enabled engine so Running Strategies / Running Trades repopulate. */
    const ri = state.runIntent && state.runIntent.active;
    if (ri) {
      const fm = state.runIntent.mode === 'filter';
      log('Auto-resuming ' + (fm ? 'Indicator-filters run mode' : 'Run Paper Trading') + ' after page reload (instance ' + (suffix || 'base') + ') - re-applying saved settings & picked strikes, trades continue automatically', 'ok');
      setTimeout(() => {
        if (!(state.runIntent && state.runIntent.active)) return;
        try {
          if (fm) runFilterPaper(); else runPaper();
        } catch (e) {
          log('Auto-resume re-run failed: ' + (e && e.message ? e.message : e), 'warn');
        }
      }, 1500);
    } else if (state.enabled === true) {
      setTimeout(() => {
        if (state.enabled === true) {
          tick();
          if (typeof api.refreshLiveRunning === 'function') api.refreshLiveRunning();
        }
      }, 800);
      log(state.filterMode === true
        ? 'Resumed from saved state - Indicator-filters mode active, trades continue automatically'
        : 'Resumed from saved state - ticked strategies keep running automatically', 'ok');
    }
    const nEl = $id('astAiPickN');
    if (nEl) {
      nEl.addEventListener('input', () => api.onModeInput());
      nEl.addEventListener('change', () => api.onModeInput());
    }
    log('AI Smart Trading engine ready - tick saved strategies to run them live with these settings (no backtest)', '');
    /* Boot-state diagnostic (mirrored to the server log): shows exactly what
       this instance restored on page load so reload-resume issues are visible. */
    const _selN = Object.keys(state.selected || {}).filter(function (k) { return state.selected[k]; }).length;
    log('BOOT ' + (suffix || 'base') + ' enabled=' + state.enabled + ' filterMode=' + state.filterMode +
      ' runIntent=' + ((state.runIntent && state.runIntent.active) ? state.runIntent.mode : 'off') +
      ' selected=' + _selN + ' positions=' + Object.keys(state.positions || {}).length, '');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
  return api;
}
