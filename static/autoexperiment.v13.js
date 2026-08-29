/* Dhan Algo - Auto Strategy Experiment Engine
 *
 * Automatically researches, generates, backtests and (optionally) paper-trades
 * strategies built from a curated knowledge base of chart-analysis methods:
 *   - candlestick patterns (reversal / continuation / liquidity)
 *   - indicators (momentum, trend, volatility, volume / supply-demand)
 *   - chart structures (price-channel breakout, support / resistance)
 *   - symmetry (doji / tweezer / inside-bar ranges)
 *   - supply & demand (volume-oscillator, MFI, OBV money-flow)
 *   - Elliott Wave approximations (impulse + retracement via MA envelope)
 *
 * Every candidate is backtested against the live chart's candle history with a
 * flat O(n) indicator precompute + O(1)-per-bar condition read, keeping a full
 * experiment pass well under 10ms. Winners are ranked, can be deployed into the
 * saved-strategy list with an "AE:" prefix, and can be paper-traded on the live
 * feed using universal lot / margin / take-profit settings, optionally combined
 * (AND logic) with a manually created strategy.
 */
window.createAutoExperiment = function (suffix) {
  'use strict';
  suffix = suffix || '';

  const AE_KEY = 'algodhan_autoexperiment_v1' + suffix;
  const SAVED_KEY = 'algodhan_strategies_v1';
  const AE_DEFAULT_KEY = 'algodhan_ae_default_tpl' + suffix;

  /* The only candlestick timeframes the engine can run test trades on: 1 min
     and 5 min. When the AI auto-timeframe toggle is on, each (strategy x
     strike) pair is backtested across the selected of these two and the best
     one is kept for maximum profit. */
  const ALL_TIMEFRAMES = ['1min', '5min'];

  /* Client-side experiment caches: option chains and option-premium candles are
     reused across runs so a repeat experiment on the same symbols is near-
     instant instead of re-hitting the network (the slow part of a run).
     Backtest outcomes are cached per (template, candle-series, universal opts)
     too, so a repeat run on unchanged inputs is pure map lookups (sub-10ms)
     rather than ~1000 indicator passes. */
  const _contractsCache = new Map();   // 'id:mode:count:type' -> { at, contracts }
  const _optCandleCache = new Map();   // 'sid:exch:tf' -> { at, candles }
  const _backtestCache = new Map();    // 'tpl|filters|series|opts' -> { at, m }
  const _candleCache = new Map();      // 'id:exch:tf:btDays' -> { at, candles } (underlying)
  const _CONTRACTS_CACHE_MS = 120 * 1000;
  const _OPT_CANDLE_CACHE_MS = 120 * 1000;
  const _BACKTEST_CACHE_MS = 120 * 1000;
  const _CANDLE_CACHE_MS = 120 * 1000;
  const _CACHE_MAX = 3000;

  function _cacheSet(map, key, value) {
    if (map.size > _CACHE_MAX) map.clear();
    map.set(key, value);
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

  /* ---------------- indicator / pattern name lookups ---------------- */
  const IND_NAMES = {};
  function indName(id) {
    if (IND_NAMES[id]) return IND_NAMES[id];
    const def = (window.IndChart && IndChart.IND) ? IndChart.IND[id] : null;
    IND_NAMES[id] = def ? (def.name || id) : id;
    return IND_NAMES[id];
  }
  function patternName(key) {
    const CP = window.CandlePatterns;
    return (CP && CP.PATTERNS && CP.PATTERNS[key]) ? CP.PATTERNS[key].name : key;
  }

  /* Friendly display name for a symbol (or raw id/name). The movers panel and
     experiment chips should show the common company name (e.g. "NALCO") while
     the backend F&O resolution keeps using the NSE ticker (e.g. "NATIONALUM"),
     so this lookup is display-only and keyed by the stable security id. */
  function displayName(s) {
    if (s == null) return '';
    const id = s.id != null ? String(s.id) : null;
    if (id && typeof SYMBOL_DISPLAY_NAMES !== 'undefined' && SYMBOL_DISPLAY_NAMES[id]) return SYMBOL_DISPLAY_NAMES[id];
    return s.name || id || '';
  }

  /* ---------------- condition builders ---------------- */
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
      dir: o.dir != null ? o.dir : 0
    };
  }
  const ema = n => ({ indId: 'ema', indSettings: { length: n, source: 'close' }, valueKey: 'v0' });
  const ma = n => ({ indId: 'ma', indSettings: { length: n, source: 'close' }, valueKey: 'v0' });
  const rsi = n => ({ indId: 'rsi', indSettings: { length: n }, valueKey: 'v0' });
  const macd = () => ({ indId: 'macd', indSettings: { fast: 12, slow: 26, signal: 9 }, valueKey: 'v0' });
  const atr = n => ({ indId: 'atr', indSettings: { length: n }, valueKey: 'v0' });
  const adx = n => ({ indId: 'adx', indSettings: { length: n }, valueKey: 'v0' });
  const mfi = n => ({ indId: 'mfi', indSettings: { length: n }, valueKey: 'v0' });
  const obv = n => ({ indId: 'obv', indSettings: { maLength: n, maType: 'sma' }, valueKey: 'v0' });
  const supertrend = (p, f) => ({ indId: 'supertrend', indSettings: { atrPeriod: p, factor: f }, valueKey: 'v0' });
  const bollB = (n, m) => ({ indId: 'bollingerB', indSettings: { length: n, mult: m }, valueKey: 'v0' });
  const bb = (n, m) => ({ indId: 'bb', indSettings: { length: n, mult: m }, valueKey: 'v0' });
  const pcUpper = n => ({ indId: 'pc', indSettings: { length: n, midType: 'midpoint', midLength: n }, valueKey: 'v0' });
  const pcMid = n => ({ indId: 'pc', indSettings: { length: n, midType: 'midpoint', midLength: n }, valueKey: 'v1' });
  const pcLower = n => ({ indId: 'pc', indSettings: { length: n, midType: 'midpoint', midLength: n }, valueKey: 'v2' });
  const volosc = (f, s) => ({ indId: 'volosc', indSettings: { fast: f, slow: s }, valueKey: 'v0' });
  const bbw = n => ({ indId: 'bbw', indSettings: { length: n, mult: 2, source: 'close', midType: 'sma', midLength: n }, valueKey: 'v0' });
  const williamsR = n => ({ indId: 'williamsR', indSettings: { length: n }, valueKey: 'v0' });
  const uo = (f, m, s) => ({ indId: 'uo', indSettings: { fast: f, medium: m, slow: s }, valueKey: 'v0' });
  const dpo = n => ({ indId: 'dpo', indSettings: { length: n }, valueKey: 'v0' });
  const ppo = (f, s) => ({ indId: 'ppo', indSettings: { fast: f, slow: s }, valueKey: 'v0' });
  const ao = (f, s) => ({ indId: 'ao', indSettings: { fast: f, slow: s }, valueKey: 'v0' });
  const smma = n => ({ indId: 'smma', indSettings: { length: n, source: 'close' }, valueKey: 'v0' });

  /* Price crossing an indicator line. The engine's condition model keeps the
     PRIMARY as an indicator and the comparator as a candle, so "price crossed
     above the line" is expressed as the line crossing BELOW price (and the
     mirror for "below"). */
  function pCross(indSrc, dir) {
    return cmpCond(indSrc, dir === 'above' ? 'crossBelow' : 'crossAbove', CANDLE('close'));
  }

  /* Build a full strategy condition from a primary source + logic + comparator. */
  function cmpCond(primary, logic, cmp) {
    return cond({
      indId: primary.indId, indSettings: primary.indSettings, valueKey: primary.valueKey,
      logic: logic,
      cmpType: cmp.type,
      cmpIndId: cmp.type === 'indicator' ? cmp.indId : '',
      cmpSettings: cmp.type === 'indicator' ? cmp.indSettings : {},
      cmpValueKey: cmp.type === 'indicator' ? cmp.valueKey : 'v0',
      candleKey: cmp.type === 'candle' ? cmp.key : 'close',
      number: cmp.type === 'number' ? cmp.value : 0,
      candlePatterns: cmp.type === 'pattern' ? cmp.patterns : []
    });
  }
  const NUM = v => ({ type: 'number', value: v });
  const CANDLE = k => ({ type: 'candle', key: k });
  const PAT = keys => ({ type: 'pattern', patterns: keys });
  const IND = (src) => ({ type: 'indicator', indId: src.indId, indSettings: src.indSettings, valueKey: src.valueKey });
  const SELF = key => ({ type: 'self', key: key }); // compare primary v0 vs its own v1

  /* ---------------- research knowledge base ---------------- */
  const RESEARCH = [
    { method: 'Candlestick', source: 'S. Nison, Japanese Candlestick Charting Techniques (1991)' },
    { method: 'Indicator', source: 'J. Murphy, Technical Analysis of the Financial Markets (1999)' },
    { method: 'Chart Structure', source: 'P. Edwards & J. Magee, Technical Analysis of Stock Trends (1948)' },
    { method: 'Symmetry', source: 'L. Raschke, Street Smarts: High Probability Short-Term Strategies (1996)' },
    { method: 'Supply/Demand', source: 'S. Weinstein, Secrets for Profiting in Bull and Bear Markets (1988)' },
    { method: 'Elliott Wave', source: 'R.N. Elliott, The Wave Principle (1938) / R. Prechter, Elliott Wave Principle (1978)' },
    { method: 'Volatility', source: 'J. Bollinger, Bollinger on Bollinger Bands (2001)' },
    { method: 'Volume', source: 'R. Arms, Volume Analysis / J. Granville OBV (1963)' }
  ];

  /* Template: { key, name, cat ('bullish'|'bearish'), method, research, entry, exit, candlestick? } */
  const TEMPLATES = [
    /* ---- candlestick patterns ---- */
    { key: 'bullish_engulfing', name: 'Bullish Engulfing Reversal', cat: 'bullish', method: 'Candlestick', research: RESEARCH[0].source,
      entry: pCross(ma(5), 'above'), exit: pCross(ma(5), 'below'),
      candlestick: { entry: ['bullish_engulfing'], exit: ['bearish_engulfing', 'shooting_star'] } },
    { key: 'bearish_engulfing', name: 'Bearish Engulfing Reversal', cat: 'bearish', method: 'Candlestick', research: RESEARCH[0].source,
      entry: pCross(ma(5), 'below'), exit: pCross(ma(5), 'above'),
      candlestick: { entry: ['bearish_engulfing'], exit: ['bullish_engulfing', 'hammer'] } },
    { key: 'morning_star', name: 'Morning Star Reversal', cat: 'bullish', method: 'Candlestick', research: RESEARCH[0].source,
      entry: cmpCond(rsi(14), 'crossAbove', NUM(40)), exit: cmpCond(rsi(14), 'crossBelow', NUM(70)),
      candlestick: { entry: ['morning_star'], exit: ['evening_star'] } },
    { key: 'evening_star', name: 'Evening Star Reversal', cat: 'bearish', method: 'Candlestick', research: RESEARCH[0].source,
      entry: cmpCond(rsi(14), 'crossBelow', NUM(60)), exit: cmpCond(rsi(14), 'crossAbove', NUM(30)),
      candlestick: { entry: ['evening_star'], exit: ['morning_star'] } },
    { key: 'three_white_soldiers', name: 'Three White Soldiers', cat: 'bullish', method: 'Candlestick', research: RESEARCH[0].source,
      entry: pCross(ma(20), 'above'), exit: pCross(ma(20), 'below'),
      candlestick: { entry: ['three_white_soldiers'], exit: ['three_black_crows'] } },
    { key: 'three_black_crows', name: 'Three Black Crows', cat: 'bearish', method: 'Candlestick', research: RESEARCH[0].source,
      entry: pCross(ma(20), 'below'), exit: pCross(ma(20), 'above'),
      candlestick: { entry: ['three_black_crows'], exit: ['three_white_soldiers'] } },
    { key: 'hammer', name: 'Hammer Bottom', cat: 'bullish', method: 'Candlestick', research: RESEARCH[0].source,
      entry: cmpCond(rsi(14), 'crossAbove', NUM(30)), exit: cmpCond(rsi(14), 'gt', NUM(60)),
      candlestick: { entry: ['hammer'], exit: ['shooting_star'] } },
    { key: 'shooting_star', name: 'Shooting Star Top', cat: 'bearish', method: 'Candlestick', research: RESEARCH[0].source,
      entry: cmpCond(rsi(14), 'crossBelow', NUM(70)), exit: cmpCond(rsi(14), 'lt', NUM(40)),
      candlestick: { entry: ['shooting_star'], exit: ['hammer'] } },
    { key: 'piercing_line', name: 'Piercing Line Reversal', cat: 'bullish', method: 'Candlestick', research: RESEARCH[0].source,
      entry: pCross(ma(5), 'above'), exit: pCross(ma(5), 'below'),
      candlestick: { entry: ['piercing_line'], exit: ['dark_cloud_cover'] } },
    { key: 'dark_cloud_cover', name: 'Dark Cloud Cover', cat: 'bearish', method: 'Candlestick', research: RESEARCH[0].source,
      entry: pCross(ma(5), 'below'), exit: pCross(ma(5), 'above'),
      candlestick: { entry: ['dark_cloud_cover'], exit: ['piercing_line'] } },

    /* ---- indicator momentum / mean-reversion ---- */
    { key: 'rsi_oversold', name: 'RSI Oversold Bounce', cat: 'bullish', method: 'Indicator', research: RESEARCH[1].source,
      entry: cmpCond(rsi(14), 'crossAbove', NUM(30)), exit: cmpCond(rsi(14), 'crossBelow', NUM(70)) },
    { key: 'rsi_overbought', name: 'RSI Overbought Fade', cat: 'bearish', method: 'Indicator', research: RESEARCH[1].source,
      entry: cmpCond(rsi(14), 'crossBelow', NUM(70)), exit: cmpCond(rsi(14), 'crossAbove', NUM(30)) },
    { key: 'macd_bull_cross', name: 'MACD Bullish Crossover', cat: 'bullish', method: 'Indicator', research: RESEARCH[1].source,
      entry: cond({ indId: 'macd', indSettings: { fast: 12, slow: 26, signal: 9 }, valueKey: 'v0', logic: 'crossAbove', cmpType: 'smoothed' }),
      exit: cond({ indId: 'macd', indSettings: { fast: 12, slow: 26, signal: 9 }, valueKey: 'v0', logic: 'crossBelow', cmpType: 'smoothed' }) },
    { key: 'macd_bear_cross', name: 'MACD Bearish Crossunder', cat: 'bearish', method: 'Indicator', research: RESEARCH[1].source,
      entry: cond({ indId: 'macd', indSettings: { fast: 12, slow: 26, signal: 9 }, valueKey: 'v0', logic: 'crossBelow', cmpType: 'smoothed' }),
      exit: cond({ indId: 'macd', indSettings: { fast: 12, slow: 26, signal: 9 }, valueKey: 'v0', logic: 'crossAbove', cmpType: 'smoothed' }) },
    { key: 'macd_zero_up', name: 'MACD Zero-Line Breakout', cat: 'bullish', method: 'Indicator', research: RESEARCH[1].source,
      entry: cmpCond(macd(), 'crossAbove', NUM(0)), exit: cmpCond(macd(), 'crossBelow', NUM(0)) },
    { key: 'rsi_50_trend', name: 'RSI 50 Momentum', cat: 'bullish', method: 'Indicator', research: RESEARCH[1].source,
      entry: cmpCond(rsi(14), 'crossAbove', NUM(50)), exit: cmpCond(rsi(14), 'crossBelow', NUM(45)) },
    { key: 'rsi_50_trend_bear', name: 'RSI 50 Bear Momentum', cat: 'bearish', method: 'Indicator', research: RESEARCH[1].source,
      entry: cmpCond(rsi(14), 'crossBelow', NUM(50)), exit: cmpCond(rsi(14), 'crossAbove', NUM(55)) },

    /* ---- trend following (moving average crosses) ---- */
    { key: 'ema_golden_cross', name: 'EMA 9/21 Golden Cross', cat: 'bullish', method: 'Indicator', research: RESEARCH[1].source,
      entry: cmpCond(ema(9), 'crossAbove', IND(ema(21))), exit: cmpCond(ema(9), 'crossBelow', IND(ema(21))) },
    { key: 'ema_death_cross', name: 'EMA 9/21 Death Cross', cat: 'bearish', method: 'Indicator', research: RESEARCH[1].source,
      entry: cmpCond(ema(9), 'crossBelow', IND(ema(21))), exit: cmpCond(ema(9), 'crossAbove', IND(ema(21))) },
    { key: 'ema_50_200', name: 'EMA 50/200 Golden Cross', cat: 'bullish', method: 'Indicator', research: RESEARCH[1].source,
      entry: cmpCond(ema(50), 'crossAbove', IND(ema(200))), exit: cmpCond(ema(50), 'crossBelow', IND(ema(200))) },
    { key: 'supertrend_long', name: 'Supertrend Long', cat: 'bullish', method: 'Indicator', research: RESEARCH[1].source,
      entry: pCross(supertrend(10, 3), 'above'), exit: pCross(supertrend(10, 3), 'below') },
    { key: 'supertrend_short', name: 'Supertrend Short', cat: 'bearish', method: 'Indicator', research: RESEARCH[1].source,
      entry: pCross(supertrend(10, 3), 'below'), exit: pCross(supertrend(10, 3), 'above') },

    /* ---- volatility ---- */
    { key: 'bb_percent_b_oversold', name: 'Bollinger %B Oversold', cat: 'bullish', method: 'Volatility', research: RESEARCH[6].source,
      entry: cmpCond(bollB(20, 2), 'crossAbove', NUM(0)), exit: cmpCond(bollB(20, 2), 'crossBelow', NUM(1)) },
    { key: 'bb_percent_b_overbought', name: 'Bollinger %B Overbought', cat: 'bearish', method: 'Volatility', research: RESEARCH[6].source,
      entry: cmpCond(bollB(20, 2), 'crossBelow', NUM(1)), exit: cmpCond(bollB(20, 2), 'crossAbove', NUM(0)) },
    { key: 'adx_breakout', name: 'ADX Trend Breakout', cat: 'bullish', method: 'Volatility', research: RESEARCH[6].source,
      entry: cmpCond(adx(14), 'crossAbove', NUM(25)), exit: cmpCond(adx(14), 'crossBelow', NUM(20)) },

    /* ---- supply & demand / volume ---- */
    { key: 'mfi_oversold', name: 'MFI Oversold (Money Flow)', cat: 'bullish', method: 'Supply/Demand', research: RESEARCH[4].source,
      entry: cmpCond(mfi(14), 'crossAbove', NUM(20)), exit: cmpCond(mfi(14), 'crossBelow', NUM(80)) },
    { key: 'mfi_overbought', name: 'MFI Overbought (Distribution)', cat: 'bearish', method: 'Supply/Demand', research: RESEARCH[4].source,
      entry: cmpCond(mfi(14), 'crossBelow', NUM(80)), exit: cmpCond(mfi(14), 'crossAbove', NUM(20)) },
    { key: 'obv_signal', name: 'OBV Signal Cross', cat: 'bullish', method: 'Volume', research: RESEARCH[7].source,
      entry: cond({ indId: 'obv', indSettings: { maLength: 30, maType: 'sma' }, valueKey: 'v0', logic: 'crossAbove', cmpType: 'smoothed' }),
      exit: cond({ indId: 'obv', indSettings: { maLength: 30, maType: 'sma' }, valueKey: 'v0', logic: 'crossBelow', cmpType: 'smoothed' }) },
    { key: 'volosc_up', name: 'Volume Oscillator Surge', cat: 'bullish', method: 'Volume', research: RESEARCH[7].source,
      entry: cmpCond(volosc(5, 20), 'crossAbove', NUM(0)), exit: cmpCond(volosc(5, 20), 'crossBelow', NUM(0)) },

    /* ---- chart structure (price channel breakout) ---- */
    { key: 'channel_breakout', name: 'Price Channel Breakout', cat: 'bullish', method: 'Chart Structure', research: RESEARCH[2].source,
      entry: pCross(pcUpper(20), 'above'), exit: pCross(pcMid(20), 'below') },
    { key: 'channel_breakdown', name: 'Price Channel Breakdown', cat: 'bearish', method: 'Chart Structure', research: RESEARCH[2].source,
      entry: pCross(pcLower(20), 'below'), exit: pCross(pcMid(20), 'above') },

    /* ---- symmetry ---- */
    { key: 'inside_bar_breakout', name: 'Inside Bar Breakout', cat: 'bullish', method: 'Symmetry', research: RESEARCH[3].source,
      entry: pCross(ma(5), 'above'), exit: pCross(ma(5), 'below'),
      candlestick: { entry: ['inside_bar'], exit: ['tweezers_top'] } },
    { key: 'tweezer_bottom', name: 'Tweezer Bottom', cat: 'bullish', method: 'Symmetry', research: RESEARCH[3].source,
      entry: cmpCond(rsi(14), 'crossAbove', NUM(35)), exit: cmpCond(rsi(14), 'crossBelow', NUM(65)),
      candlestick: { entry: ['tweezers_bottom'], exit: ['tweezers_top'] } },

    /* ---- Elliott Wave approximation ---- */
    { key: 'elliott_impulse', name: 'Elliott Wave Impulse', cat: 'bullish', method: 'Elliott Wave', research: RESEARCH[5].source,
      entry: cmpCond(ema(20), 'crossAbove', IND(ema(50))), exit: cmpCond(ema(20), 'crossBelow', IND(ema(50))) },
    { key: 'elliott_correction', name: 'Elliott Wave Correction', cat: 'bearish', method: 'Elliott Wave', research: RESEARCH[5].source,
      entry: cmpCond(ema(20), 'crossBelow', IND(ema(50))), exit: cmpCond(ema(20), 'crossAbove', IND(ema(50))) },
    { key: 'elliott_wave_3', name: 'Elliott Wave 3 Extension', cat: 'bullish', method: 'Elliott Wave', research: RESEARCH[5].source,
      entry: cmpCond(ema(20), 'crossAbove', IND(ema(50))),
      entryExtra: [cmpCond(adx(14), 'gt', NUM(25))],
      exit: cmpCond(ema(20), 'crossBelow', IND(ema(50))) },
    { key: 'elliott_wave_c', name: 'Elliott Wave C Decline', cat: 'bearish', method: 'Elliott Wave', research: RESEARCH[5].source,
      entry: cmpCond(ema(20), 'crossBelow', IND(ema(50))),
      entryExtra: [cmpCond(adx(14), 'gt', NUM(25))],
      exit: cmpCond(ema(20), 'crossAbove', IND(ema(50))) },

    /* ---- multi-indicator confirmation (entryExtra = AND, exitExtra = OR) ---- */
    { key: 'rsi_macd_confirm', name: 'RSI + MACD Double Confirm', cat: 'bullish', method: 'Indicator', research: RESEARCH[1].source,
      entry: cmpCond(rsi(14), 'crossAbove', NUM(40)),
      entryExtra: [cond({ indId: 'macd', indSettings: { fast: 12, slow: 26, signal: 9 }, valueKey: 'v0', logic: 'crossAbove', cmpType: 'smoothed' })],
      exit: cmpCond(rsi(14), 'crossBelow', NUM(70)),
      exitExtra: [cond({ indId: 'macd', indSettings: { fast: 12, slow: 26, signal: 9 }, valueKey: 'v0', logic: 'crossBelow', cmpType: 'smoothed' })] },
    { key: 'rsi_macd_confirm_bear', name: 'RSI + MACD Double Confirm (Bear)', cat: 'bearish', method: 'Indicator', research: RESEARCH[1].source,
      entry: cmpCond(rsi(14), 'crossBelow', NUM(60)),
      entryExtra: [cond({ indId: 'macd', indSettings: { fast: 12, slow: 26, signal: 9 }, valueKey: 'v0', logic: 'crossBelow', cmpType: 'smoothed' })],
      exit: cmpCond(rsi(14), 'crossAbove', NUM(30)),
      exitExtra: [cond({ indId: 'macd', indSettings: { fast: 12, slow: 26, signal: 9 }, valueKey: 'v0', logic: 'crossAbove', cmpType: 'smoothed' })] },
    { key: 'trend_volume_confirm', name: 'Trend + Volume Confirmation', cat: 'bullish', method: 'Volume', research: RESEARCH[7].source,
      entry: cmpCond(ema(9), 'crossAbove', IND(ema(21))),
      entryExtra: [cmpCond(volosc(5, 20), 'gt', NUM(0))],
      exit: cmpCond(ema(9), 'crossBelow', IND(ema(21))),
      exitExtra: [cmpCond(volosc(5, 20), 'lt', NUM(0))] },
    { key: 'trend_volume_confirm_bear', name: 'Trend + Volume Confirmation (Bear)', cat: 'bearish', method: 'Volume', research: RESEARCH[7].source,
      entry: cmpCond(ema(9), 'crossBelow', IND(ema(21))),
      entryExtra: [cmpCond(volosc(5, 20), 'gt', NUM(0))],
      exit: cmpCond(ema(9), 'crossAbove', IND(ema(21))) },
    { key: 'supertrend_adx', name: 'Supertrend + ADX Filter', cat: 'bullish', method: 'Indicator', research: RESEARCH[1].source,
      entry: pCross(supertrend(10, 3), 'above'),
      entryExtra: [cmpCond(adx(14), 'gt', NUM(20))],
      exit: pCross(supertrend(10, 3), 'below') },
    { key: 'supertrend_adx_short', name: 'Supertrend + ADX Filter (Short)', cat: 'bearish', method: 'Indicator', research: RESEARCH[1].source,
      entry: pCross(supertrend(10, 3), 'below'),
      entryExtra: [cmpCond(adx(14), 'gt', NUM(20))],
      exit: pCross(supertrend(10, 3), 'above') },
    { key: 'mfi_rsi_confluence', name: 'MFI + RSI Oversold Confluence', cat: 'bullish', method: 'Supply/Demand', research: RESEARCH[4].source,
      entry: cmpCond(rsi(14), 'crossAbove', NUM(30)),
      entryExtra: [cmpCond(mfi(14), 'gt', NUM(30))],
      exit: cmpCond(rsi(14), 'crossBelow', NUM(70)),
      exitExtra: [cmpCond(mfi(14), 'gt', NUM(75))] },
    { key: 'mfi_rsi_confluence_bear', name: 'MFI + RSI Overbought Confluence (Bear)', cat: 'bearish', method: 'Supply/Demand', research: RESEARCH[4].source,
      entry: cmpCond(rsi(14), 'crossBelow', NUM(70)),
      entryExtra: [cmpCond(mfi(14), 'lt', NUM(70))],
      exit: cmpCond(rsi(14), 'crossAbove', NUM(30)),
      exitExtra: [cmpCond(mfi(14), 'lt', NUM(25))] },

    /* ---- more candlestick / symmetry / supply-demand patterns ---- */
    { key: 'doji_reversal', name: 'Doji Reversal', cat: 'bullish', method: 'Candlestick', research: RESEARCH[0].source,
      entry: pCross(ma(10), 'above'), exit: pCross(ma(10), 'below'),
      candlestick: { entry: ['doji_bullish', 'long_legged_doji'], exit: ['doji_bearish'] } },
    { key: 'doji_reversal_bear', name: 'Doji Top Reversal', cat: 'bearish', method: 'Candlestick', research: RESEARCH[0].source,
      entry: pCross(ma(10), 'below'), exit: pCross(ma(10), 'above'),
      candlestick: { entry: ['doji_bearish', 'long_legged_doji'], exit: ['doji_bullish'] } },
    { key: 'tweezers_top', name: 'Tweezers Top Reversal', cat: 'bearish', method: 'Symmetry', research: RESEARCH[3].source,
      entry: cmpCond(rsi(14), 'crossBelow', NUM(65)), exit: cmpCond(rsi(14), 'crossAbove', NUM(35)),
      candlestick: { entry: ['tweezers_top'], exit: ['tweezers_bottom'] } },
    { key: 'narrow_range_breakout', name: 'Narrow Range Breakout', cat: 'bullish', method: 'Symmetry', research: RESEARCH[3].source,
      entry: pCross(ma(10), 'above'), exit: pCross(ma(10), 'below'),
      candlestick: { entry: ['narrow_range'], exit: ['inside_bar'] } },
    { key: 'narrow_range_breakdown', name: 'Narrow Range Breakdown', cat: 'bearish', method: 'Symmetry', research: RESEARCH[3].source,
      entry: pCross(ma(10), 'below'), exit: pCross(ma(10), 'above'),
      candlestick: { entry: ['narrow_range'], exit: ['inside_bar'] } },
    { key: 'stop_hunt_reversal', name: 'Stop Hunt Reversal Long', cat: 'bullish', method: 'Supply/Demand', research: RESEARCH[4].source,
      entry: cmpCond(rsi(14), 'crossAbove', NUM(30)), exit: cmpCond(rsi(14), 'crossBelow', NUM(65)),
      candlestick: { entry: ['stop_hunt_below', 'hammer'], exit: ['stop_hunt_above'] } },
    { key: 'stop_hunt_short', name: 'Stop Hunt Rejection Short', cat: 'bearish', method: 'Supply/Demand', research: RESEARCH[4].source,
      entry: cmpCond(rsi(14), 'crossBelow', NUM(70)), exit: cmpCond(rsi(14), 'crossAbove', NUM(35)),
      candlestick: { entry: ['stop_hunt_above', 'shooting_star'], exit: ['stop_hunt_below'] } },
    { key: 'false_breakout_fade', name: 'False Breakout Fade', cat: 'bearish', method: 'Supply/Demand', research: RESEARCH[4].source,
      entry: cmpCond(rsi(14), 'crossBelow', NUM(60)), exit: cmpCond(rsi(14), 'crossAbove', NUM(40)),
      candlestick: { entry: ['false_breakout'], exit: ['hammer'] } },
    { key: 'harami_reversal', name: 'Bullish Harami Reversal', cat: 'bullish', method: 'Candlestick', research: RESEARCH[0].source,
      entry: cmpCond(rsi(14), 'crossAbove', NUM(35)), exit: cmpCond(rsi(14), 'crossBelow', NUM(65)),
      candlestick: { entry: ['bullish_harami'], exit: ['bearish_harami'] } },
    { key: 'harami_reversal_bear', name: 'Bearish Harami Reversal', cat: 'bearish', method: 'Candlestick', research: RESEARCH[0].source,
      entry: cmpCond(rsi(14), 'crossBelow', NUM(65)), exit: cmpCond(rsi(14), 'crossAbove', NUM(35)),
      candlestick: { entry: ['bearish_harami'], exit: ['bullish_harami'] } },

    /* ---- multi-indicator confluence (3+ indicators combined) ---- */
    { key: 'triple_trend_momentum_volume', name: 'Triple Trend + Momentum + Volume', cat: 'bullish', method: 'Indicator', research: RESEARCH[1].source,
      entry: cmpCond(ema(9), 'crossAbove', IND(ema(21))),
      entryExtra: [cmpCond(rsi(14), 'gt', NUM(50)), cmpCond(volosc(5, 20), 'gt', NUM(0))],
      exit: cmpCond(ema(9), 'crossBelow', IND(ema(21))),
      exitExtra: [cmpCond(rsi(14), 'lt', NUM(45)), cmpCond(volosc(5, 20), 'lt', NUM(0))] },
    { key: 'triple_trend_momentum_volume_bear', name: 'Triple Trend + Momentum + Volume (Bear)', cat: 'bearish', method: 'Indicator', research: RESEARCH[1].source,
      entry: cmpCond(ema(9), 'crossBelow', IND(ema(21))),
      entryExtra: [cmpCond(rsi(14), 'lt', NUM(50)), cmpCond(volosc(5, 20), 'gt', NUM(0))],
      exit: cmpCond(ema(9), 'crossAbove', IND(ema(21))),
      exitExtra: [cmpCond(rsi(14), 'gt', NUM(55)), cmpCond(volosc(5, 20), 'lt', NUM(0))] },
    { key: 'macd_adx_rsi', name: 'MACD + ADX + RSI Confluence', cat: 'bullish', method: 'Indicator', research: RESEARCH[1].source,
      entry: cond({ indId: 'macd', indSettings: { fast: 12, slow: 26, signal: 9 }, valueKey: 'v0', logic: 'crossAbove', cmpType: 'smoothed' }),
      entryExtra: [cmpCond(adx(14), 'gt', NUM(20)), cmpCond(rsi(14), 'gt', NUM(50))],
      exit: cond({ indId: 'macd', indSettings: { fast: 12, slow: 26, signal: 9 }, valueKey: 'v0', logic: 'crossBelow', cmpType: 'smoothed' }),
      exitExtra: [cmpCond(adx(14), 'lt', NUM(20)), cmpCond(rsi(14), 'lt', NUM(45))] },
    { key: 'macd_adx_rsi_bear', name: 'MACD + ADX + RSI Confluence (Bear)', cat: 'bearish', method: 'Indicator', research: RESEARCH[1].source,
      entry: cond({ indId: 'macd', indSettings: { fast: 12, slow: 26, signal: 9 }, valueKey: 'v0', logic: 'crossBelow', cmpType: 'smoothed' }),
      entryExtra: [cmpCond(adx(14), 'gt', NUM(20)), cmpCond(rsi(14), 'lt', NUM(50))],
      exit: cond({ indId: 'macd', indSettings: { fast: 12, slow: 26, signal: 9 }, valueKey: 'v0', logic: 'crossAbove', cmpType: 'smoothed' }),
      exitExtra: [cmpCond(adx(14), 'lt', NUM(20)), cmpCond(rsi(14), 'gt', NUM(55))] },
    { key: 'supertrend_adx_volume', name: 'Supertrend + ADX + Volume', cat: 'bullish', method: 'Indicator', research: RESEARCH[1].source,
      entry: pCross(supertrend(10, 3), 'above'),
      entryExtra: [cmpCond(adx(14), 'gt', NUM(20)), cmpCond(volosc(5, 20), 'gt', NUM(0))],
      exit: pCross(supertrend(10, 3), 'below'),
      exitExtra: [cmpCond(adx(14), 'lt', NUM(20)), cmpCond(volosc(5, 20), 'lt', NUM(0))] },
    { key: 'supertrend_adx_volume_short', name: 'Supertrend + ADX + Volume (Short)', cat: 'bearish', method: 'Indicator', research: RESEARCH[1].source,
      entry: pCross(supertrend(10, 3), 'below'),
      entryExtra: [cmpCond(adx(14), 'gt', NUM(20)), cmpCond(volosc(5, 20), 'gt', NUM(0))],
      exit: pCross(supertrend(10, 3), 'above'),
      exitExtra: [cmpCond(adx(14), 'lt', NUM(20)), cmpCond(volosc(5, 20), 'lt', NUM(0))] },
    { key: 'bb_rsi_mfi_os', name: 'Bollinger %B + RSI + MFI Oversold', cat: 'bullish', method: 'Volatility', research: RESEARCH[6].source,
      entry: cmpCond(bollB(20, 2), 'crossAbove', NUM(0)),
      entryExtra: [cmpCond(rsi(14), 'crossAbove', NUM(30)), cmpCond(mfi(14), 'gt', NUM(30))],
      exit: cmpCond(bollB(20, 2), 'crossBelow', NUM(1)),
      exitExtra: [cmpCond(rsi(14), 'crossBelow', NUM(70)), cmpCond(mfi(14), 'lt', NUM(70))] },
    { key: 'bb_rsi_mfi_ob', name: 'Bollinger %B + RSI + MFI Overbought (Bear)', cat: 'bearish', method: 'Volatility', research: RESEARCH[6].source,
      entry: cmpCond(bollB(20, 2), 'crossBelow', NUM(1)),
      entryExtra: [cmpCond(rsi(14), 'crossBelow', NUM(70)), cmpCond(mfi(14), 'lt', NUM(70))],
      exit: cmpCond(bollB(20, 2), 'crossAbove', NUM(0)),
      exitExtra: [cmpCond(rsi(14), 'crossAbove', NUM(30)), cmpCond(mfi(14), 'gt', NUM(30))] },
    { key: 'wr_macd_ppo', name: 'Williams %R + MACD + PPO', cat: 'bullish', method: 'Indicator', research: RESEARCH[1].source,
      entry: cmpCond(williamsR(14), 'crossAbove', NUM(-80)),
      entryExtra: [cond({ indId: 'macd', indSettings: { fast: 12, slow: 26, signal: 9 }, valueKey: 'v0', logic: 'crossAbove', cmpType: 'smoothed' }), cmpCond(ppo(12, 26), 'gt', NUM(0))],
      exit: cmpCond(williamsR(14), 'crossBelow', NUM(-20)),
      exitExtra: [cond({ indId: 'macd', indSettings: { fast: 12, slow: 26, signal: 9 }, valueKey: 'v0', logic: 'crossBelow', cmpType: 'smoothed' }), cmpCond(ppo(12, 26), 'lt', NUM(0))] },
    { key: 'wr_macd_ppo_bear', name: 'Williams %R + MACD + PPO (Bear)', cat: 'bearish', method: 'Indicator', research: RESEARCH[1].source,
      entry: cmpCond(williamsR(14), 'crossBelow', NUM(-20)),
      entryExtra: [cond({ indId: 'macd', indSettings: { fast: 12, slow: 26, signal: 9 }, valueKey: 'v0', logic: 'crossBelow', cmpType: 'smoothed' }), cmpCond(ppo(12, 26), 'lt', NUM(0))],
      exit: cmpCond(williamsR(14), 'crossAbove', NUM(-80)),
      exitExtra: [cond({ indId: 'macd', indSettings: { fast: 12, slow: 26, signal: 9 }, valueKey: 'v0', logic: 'crossAbove', cmpType: 'smoothed' }), cmpCond(ppo(12, 26), 'gt', NUM(0))] },
    { key: 'ao_adx_obv', name: 'Awesome Oscillator + ADX + OBV', cat: 'bullish', method: 'Indicator', research: RESEARCH[1].source,
      entry: cmpCond(ao(5, 34), 'crossAbove', NUM(0)),
      entryExtra: [cmpCond(adx(14), 'gt', NUM(20)), cond({ indId: 'obv', indSettings: { maLength: 30, maType: 'sma' }, valueKey: 'v0', logic: 'gt', cmpType: 'smoothed' })],
      exit: cmpCond(ao(5, 34), 'crossBelow', NUM(0)),
      exitExtra: [cmpCond(adx(14), 'lt', NUM(20)), cond({ indId: 'obv', indSettings: { maLength: 30, maType: 'sma' }, valueKey: 'v0', logic: 'lt', cmpType: 'smoothed' })] },
    { key: 'ao_adx_obv_bear', name: 'Awesome Oscillator + ADX + OBV (Bear)', cat: 'bearish', method: 'Indicator', research: RESEARCH[1].source,
      entry: cmpCond(ao(5, 34), 'crossBelow', NUM(0)),
      entryExtra: [cmpCond(adx(14), 'gt', NUM(20)), cond({ indId: 'obv', indSettings: { maLength: 30, maType: 'sma' }, valueKey: 'v0', logic: 'lt', cmpType: 'smoothed' })],
      exit: cmpCond(ao(5, 34), 'crossAbove', NUM(0)),
      exitExtra: [cmpCond(adx(14), 'lt', NUM(20)), cond({ indId: 'obv', indSettings: { maLength: 30, maType: 'sma' }, valueKey: 'v0', logic: 'gt', cmpType: 'smoothed' })] },
    { key: 'uo_rsi_mfi', name: 'UO + RSI + MFI Oscillator Confluence', cat: 'bullish', method: 'Indicator', research: RESEARCH[1].source,
      entry: cmpCond(uo(7, 14, 28), 'crossAbove', NUM(50)),
      entryExtra: [cmpCond(rsi(14), 'gt', NUM(50)), cmpCond(mfi(14), 'gt', NUM(50))],
      exit: cmpCond(uo(7, 14, 28), 'crossBelow', NUM(50)),
      exitExtra: [cmpCond(rsi(14), 'lt', NUM(45)), cmpCond(mfi(14), 'lt', NUM(45))] },
    { key: 'uo_rsi_mfi_bear', name: 'UO + RSI + MFI Oscillator Confluence (Bear)', cat: 'bearish', method: 'Indicator', research: RESEARCH[1].source,
      entry: cmpCond(uo(7, 14, 28), 'crossBelow', NUM(50)),
      entryExtra: [cmpCond(rsi(14), 'lt', NUM(50)), cmpCond(mfi(14), 'lt', NUM(50))],
      exit: cmpCond(uo(7, 14, 28), 'crossAbove', NUM(50)),
      exitExtra: [cmpCond(rsi(14), 'gt', NUM(55)), cmpCond(mfi(14), 'gt', NUM(55))] },
    { key: 'ema_dpo_volume', name: 'EMA + DPO + Volume Pullback', cat: 'bullish', method: 'Indicator', research: RESEARCH[1].source,
      entry: cmpCond(ema(20), 'crossAbove', IND(ema(50))),
      entryExtra: [cmpCond(dpo(20), 'crossAbove', NUM(0)), cmpCond(volosc(5, 20), 'gt', NUM(0))],
      exit: cmpCond(ema(20), 'crossBelow', IND(ema(50))),
      exitExtra: [cmpCond(dpo(20), 'crossBelow', NUM(0)), cmpCond(volosc(5, 20), 'lt', NUM(0))] },
    { key: 'ema_dpo_volume_bear', name: 'EMA + DPO + Volume Pullback (Bear)', cat: 'bearish', method: 'Indicator', research: RESEARCH[1].source,
      entry: cmpCond(ema(20), 'crossBelow', IND(ema(50))),
      entryExtra: [cmpCond(dpo(20), 'crossBelow', NUM(0)), cmpCond(volosc(5, 20), 'gt', NUM(0))],
      exit: cmpCond(ema(20), 'crossAbove', IND(ema(50))),
      exitExtra: [cmpCond(dpo(20), 'crossAbove', NUM(0)), cmpCond(volosc(5, 20), 'lt', NUM(0))] },
    { key: 'ppo_adx_rsi', name: 'PPO + ADX + RSI Trend', cat: 'bullish', method: 'Indicator', research: RESEARCH[1].source,
      entry: cond({ indId: 'ppo', indSettings: { fast: 12, slow: 26, signal: 9 }, valueKey: 'v0', logic: 'crossAbove', cmpType: 'smoothed' }),
      entryExtra: [cmpCond(adx(14), 'gt', NUM(20)), cmpCond(rsi(14), 'gt', NUM(50))],
      exit: cond({ indId: 'ppo', indSettings: { fast: 12, slow: 26, signal: 9 }, valueKey: 'v0', logic: 'crossBelow', cmpType: 'smoothed' }),
      exitExtra: [cmpCond(adx(14), 'lt', NUM(20)), cmpCond(rsi(14), 'lt', NUM(45))] },
    { key: 'ppo_adx_rsi_bear', name: 'PPO + ADX + RSI Trend (Bear)', cat: 'bearish', method: 'Indicator', research: RESEARCH[1].source,
      entry: cond({ indId: 'ppo', indSettings: { fast: 12, slow: 26, signal: 9 }, valueKey: 'v0', logic: 'crossBelow', cmpType: 'smoothed' }),
      entryExtra: [cmpCond(adx(14), 'gt', NUM(20)), cmpCond(rsi(14), 'lt', NUM(50))],
      exit: cond({ indId: 'ppo', indSettings: { fast: 12, slow: 26, signal: 9 }, valueKey: 'v0', logic: 'crossAbove', cmpType: 'smoothed' }),
      exitExtra: [cmpCond(adx(14), 'lt', NUM(20)), cmpCond(rsi(14), 'gt', NUM(55))] },
    { key: 'supertrend_ao_rsi', name: 'Supertrend + AO + RSI', cat: 'bullish', method: 'Indicator', research: RESEARCH[1].source,
      entry: pCross(supertrend(10, 3), 'above'),
      entryExtra: [cmpCond(ao(5, 34), 'gt', NUM(0)), cmpCond(rsi(14), 'gt', NUM(50))],
      exit: pCross(supertrend(10, 3), 'below'),
      exitExtra: [cmpCond(ao(5, 34), 'lt', NUM(0)), cmpCond(rsi(14), 'lt', NUM(45))] },
    { key: 'supertrend_ao_rsi_short', name: 'Supertrend + AO + RSI (Short)', cat: 'bearish', method: 'Indicator', research: RESEARCH[1].source,
      entry: pCross(supertrend(10, 3), 'below'),
      entryExtra: [cmpCond(ao(5, 34), 'lt', NUM(0)), cmpCond(rsi(14), 'lt', NUM(50))],
      exit: pCross(supertrend(10, 3), 'above'),
      exitExtra: [cmpCond(ao(5, 34), 'gt', NUM(0)), cmpCond(rsi(14), 'gt', NUM(55))] },
    { key: 'smma_adx_obv', name: 'SMMA + ADX + OBV Trend', cat: 'bullish', method: 'Indicator', research: RESEARCH[1].source,
      entry: cmpCond(smma(20), 'crossAbove', IND(smma(50))),
      entryExtra: [cmpCond(adx(14), 'gt', NUM(20)), cond({ indId: 'obv', indSettings: { maLength: 30, maType: 'sma' }, valueKey: 'v0', logic: 'gt', cmpType: 'smoothed' })],
      exit: cmpCond(smma(20), 'crossBelow', IND(smma(50))),
      exitExtra: [cmpCond(adx(14), 'lt', NUM(20)), cond({ indId: 'obv', indSettings: { maLength: 30, maType: 'sma' }, valueKey: 'v0', logic: 'lt', cmpType: 'smoothed' })] },
    { key: 'smma_adx_obv_bear', name: 'SMMA + ADX + OBV Trend (Bear)', cat: 'bearish', method: 'Indicator', research: RESEARCH[1].source,
      entry: cmpCond(smma(20), 'crossBelow', IND(smma(50))),
      entryExtra: [cmpCond(adx(14), 'gt', NUM(20)), cond({ indId: 'obv', indSettings: { maLength: 30, maType: 'sma' }, valueKey: 'v0', logic: 'lt', cmpType: 'smoothed' })],
      exit: cmpCond(smma(20), 'crossAbove', IND(smma(50))),
      exitExtra: [cmpCond(adx(14), 'lt', NUM(20)), cond({ indId: 'obv', indSettings: { maLength: 30, maType: 'sma' }, valueKey: 'v0', logic: 'gt', cmpType: 'smoothed' })] }
  ];

  /* Fixed curated templates are always present, so their keys identify the
     stable base set vs the per-run randomized parameter-sweep templates. Used
     by the kept-results cap to guarantee a share of slots for fresh sweep
     variants (otherwise the same base winners fill every slot each run and
     consecutive runs look identical). */
  const BASE_TPL_KEYS = new Set(TEMPLATES.map(t => t.key));

  /* ---------------- research method groups ---------------- */
  /* These are the checkable "research streams" the user can toggle on/off in
     the Auto Experiment UI. Every generated template belongs to exactly one
     group so the experiment can be scoped to only the selected streams. */
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
     filter sections. Each key maps to the research group the experiment is
     restricted to for that side when ticked (bullCandle = "Bullish section +
     Candlestick patterns" runs only candlestick templates on the bullish side). */
  const STREAM_FLAG_GROUPS = {
    bullCandle: 'candlestick', bullElliott: 'elliott', bullIndicator: 'indicator',
    bullPane: 'pane', bullSymmetry: 'symmetry', bullStructure: 'structure', bullAtr: 'atr',
    bearCandle: 'candlestick', bearElliott: 'elliott', bearIndicator: 'indicator',
    bearPane: 'pane', bearSymmetry: 'symmetry', bearStructure: 'structure', bearAtr: 'atr'
  };
  const STREAM_FLAG_KEYS = Object.keys(STREAM_FLAG_GROUPS);

  /* Candle-level entry gates added to the Bullish/Bearish filter sections:
     volume trend, fake breakout / fake breakdown, reversal bars, and the
     pane-indicator gates (main line vs signal line crossover, and every line
     of every pane indicator trending the same way). */
  const FILTER_EXTRA_KEYS = ['bullVolUp', 'bullVolDown', 'bullFakeBreakout', 'bullReversal', 'bearVolUp', 'bearVolDown', 'bearFakeBreakout', 'bearReversal', 'paneCrossUp', 'paneCrossDown', 'paneIncUpAll', 'paneIncDownAll', 'bullBbwInc', 'bearBbwInc', 'bullBbCrossBelow', 'bullBbCrossAbove', 'bullPcCrossBelow', 'bullPcCrossAbove', 'bearBbCrossBelow', 'bearBbCrossAbove', 'bearPcCrossBelow', 'bearPcCrossAbove', 'bullSmf', 'bearSmf', 'bullVl', 'bearVl', 'bullAsr', 'bearAsr'];

  /* HTML element ids for the filter checkboxes are PascalCase
     ('aeFilterPaneCrossUp'), while the state keys are camelCase
     ('paneCrossUp'). Capitalize the first letter when composing an id. */
  const capId = k => k.charAt(0).toUpperCase() + k.slice(1);

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

  /* Expand the curated base templates into a large (effectively unlimited)
     parameter-swept set so the engine continuously surfaces fresh, most
     profitable variants. Each variant inherits its method's research source
     and group. The set is memoized; it only grows when research refreshes. */
  let _templateCache = null;
  let _researchMap = {}; // method -> source, refreshed from the server feed
  /* Per-run variation: every "Run Experiment" press re-randomizes the
     parameter-swept template set so the engine surfaces fresh indicators and
     parameter combos instead of replaying the same deterministic sweep. The
     seed is set at the start of each run; buildTemplateSet() consumes it via a
     seeded PRNG so a single run stays internally reproducible (progress count,
     template loop and backtests all see the same set). */
  let _runSeed = 0;
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function buildTemplateSet() {
    if (_templateCache) return _templateCache;
    const out = [];
    const rng = mulberry32(_runSeed || 1);
    const randInt = (min, max) => min + Math.floor(rng() * (max - min + 1));
    const shuffle = (arr) => {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const t = a[i]; a[i] = a[j]; a[j] = t;
      }
      return a;
    };
    const uniqueInts = (count, min, max, skip) => {
      const res = [];
      while (res.length < count) {
        const n = randInt(min, max);
        if (n === skip || res.indexOf(n) >= 0) continue;
        res.push(n);
      }
      return res;
    };
    const uniqPairs = (count, genFn) => {
      const res = [];
      while (res.length < count) {
        const p = genFn();
        if (res.some(q => q[0] === p[0] && q[1] === p[1])) continue;
        res.push(p);
      }
      return res;
    };
    const add = (t) => {
      t.group = groupOf(t.method);
      if (GROUP_KEYS.indexOf(t.group) >= 0) {
        if (_researchMap[t.method]) t.research = _researchMap[t.method];
        out.push(t);
      }
    };
    /* Every run reseeds the PRNG, so the curated base template set is
       seed-rotated here: the candlestick core is always included (they are the
       curated patterns the experiment is built around) while the other methods'
       base templates rotate through a seeded ~70% sample each run. Combined
       with the randomized parameter sweep below this guarantees consecutive
       "Run Experiment" presses surface visibly different strategy sets instead
       of replaying the same base winners every time. */
    const _rotatedBase = shuffle(TEMPLATES.filter(t => t.method !== 'Candlestick'));
    const _coreBase = TEMPLATES.filter(t => t.method === 'Candlestick');
    _coreBase.forEach(t => add(Object.assign({}, t)));
    _rotatedBase.slice(0, Math.round(_rotatedBase.length * 0.7)).forEach(t => add(Object.assign({}, t)));

    const gen = (method) => 'Auto-generated parameter sweep (' + method + ')';

    uniqueInts(5, 5, 30, 14).forEach(n => {
      add({ key: 'rsi_oversold_' + n, name: 'RSI ' + n + ' Oversold Bounce', cat: 'bullish', method: 'Indicator', research: gen('Indicator'),
        entry: cmpCond(rsi(n), 'crossAbove', NUM(30)), exit: cmpCond(rsi(n), 'crossBelow', NUM(70)) });
      add({ key: 'rsi_overbought_' + n, name: 'RSI ' + n + ' Overbought Fade', cat: 'bearish', method: 'Indicator', research: gen('Indicator'),
        entry: cmpCond(rsi(n), 'crossBelow', NUM(70)), exit: cmpCond(rsi(n), 'crossAbove', NUM(30)) });
    });

    uniqPairs(5, () => {
      const f = randInt(3, 15);
      return [f, f + randInt(3, 45)];
    }).forEach(([f, s]) => {
      if (f === 9 && s === 21) return; // base already covers 9/21
      add({ key: 'ema_golden_' + f + '_' + s, name: 'EMA ' + f + '/' + s + ' Golden Cross', cat: 'bullish', method: 'Indicator', research: gen('Indicator'),
        entry: cmpCond(ema(f), 'crossAbove', IND(ema(s))), exit: cmpCond(ema(f), 'crossBelow', IND(ema(s))) });
      add({ key: 'ema_death_' + f + '_' + s, name: 'EMA ' + f + '/' + s + ' Death Cross', cat: 'bearish', method: 'Indicator', research: gen('Indicator'),
        entry: cmpCond(ema(f), 'crossBelow', IND(ema(s))), exit: cmpCond(ema(f), 'crossAbove', IND(ema(s))) });
    });

    uniqPairs(4, () => [randInt(7, 20), Math.round((randInt(15, 40) / 10)) * 10 / 10]).forEach(([p, f]) => {
      if (p === 10 && f === 3) return; // base already covers 10/3
      add({ key: 'supertrend_long_' + p + '_' + f, name: 'Supertrend Long (' + p + ',' + f + ')', cat: 'bullish', method: 'Indicator', research: gen('Indicator'),
        entry: pCross(supertrend(p, f), 'above'), exit: pCross(supertrend(p, f), 'below') });
      add({ key: 'supertrend_short_' + p + '_' + f, name: 'Supertrend Short (' + p + ',' + f + ')', cat: 'bearish', method: 'Indicator', research: gen('Indicator'),
        entry: pCross(supertrend(p, f), 'below'), exit: pCross(supertrend(p, f), 'above') });
    });

    const bbMultPool = shuffle([1.5, 2, 2.5, 3, 3.5]);
    const bbMults = [];
    while (bbMults.length < 3) {
      const m = bbMultPool.shift();
      if (m === 2) continue; // base already covers 2
      bbMults.push(m);
    }
    bbMults.forEach(m => {
      add({ key: 'bb_os_' + m, name: 'Bollinger %B Oversold (' + m + 's)', cat: 'bullish', method: 'Volatility', research: gen('Volatility'),
        entry: cmpCond(bollB(20, m), 'crossAbove', NUM(0)), exit: cmpCond(bollB(20, m), 'crossBelow', NUM(1)) });
      add({ key: 'bb_ob_' + m, name: 'Bollinger %B Overbought (' + m + 's)', cat: 'bearish', method: 'Volatility', research: gen('Volatility'),
        entry: cmpCond(bollB(20, m), 'crossBelow', NUM(1)), exit: cmpCond(bollB(20, m), 'crossAbove', NUM(0)) });
    });

    uniqPairs(2, () => {
      const fa = randInt(6, 16);
      return [fa, fa + randInt(10, 30), randInt(5, 12)];
    }).forEach(([fa, sl, sg]) => {
      add({ key: 'macd_bull_' + fa + '_' + sl, name: 'MACD (' + fa + ',' + sl + ') Bull Cross', cat: 'bullish', method: 'Indicator', research: gen('Indicator'),
        entry: cond({ indId: 'macd', indSettings: { fast: fa, slow: sl, signal: sg }, valueKey: 'v0', logic: 'crossAbove', cmpType: 'smoothed' }),
        exit: cond({ indId: 'macd', indSettings: { fast: fa, slow: sl, signal: sg }, valueKey: 'v0', logic: 'crossBelow', cmpType: 'smoothed' }) });
      add({ key: 'macd_bear_' + fa + '_' + sl, name: 'MACD (' + fa + ',' + sl + ') Bear Cross', cat: 'bearish', method: 'Indicator', research: gen('Indicator'),
        entry: cond({ indId: 'macd', indSettings: { fast: fa, slow: sl, signal: sg }, valueKey: 'v0', logic: 'crossBelow', cmpType: 'smoothed' }),
        exit: cond({ indId: 'macd', indSettings: { fast: fa, slow: sl, signal: sg }, valueKey: 'v0', logic: 'crossAbove', cmpType: 'smoothed' }) });
    });

    uniqueInts(3, 8, 30, 14).forEach(n => {
      add({ key: 'mfi_os_' + n, name: 'MFI ' + n + ' Oversold', cat: 'bullish', method: 'Supply/Demand', research: gen('Supply/Demand'),
        entry: cmpCond(mfi(n), 'crossAbove', NUM(20)), exit: cmpCond(mfi(n), 'crossBelow', NUM(80)) });
      add({ key: 'mfi_ob_' + n, name: 'MFI ' + n + ' Overbought', cat: 'bearish', method: 'Supply/Demand', research: gen('Supply/Demand'),
        entry: cmpCond(mfi(n), 'crossBelow', NUM(80)), exit: cmpCond(mfi(n), 'crossAbove', NUM(20)) });
    });

    /* ---- Bollinger Band Width (pane) parameter-swept variants ----
       Band-width expansion = volatility breakout (squeeze release). Entry when
       BBW crosses above a modest band, exit when it narrows back below. */
    uniqueInts(3, 10, 40, 0).forEach(n => {
      add({ key: 'bbw_exp_' + n, name: 'BBW ' + n + ' Expansion (Bullish)', cat: 'bullish', method: 'Volume', research: gen('Volume'),
        entry: cmpCond(bbw(n), 'crossAbove', NUM(2)), exit: cmpCond(bbw(n), 'crossBelow', NUM(1)) });
      add({ key: 'bbw_exp_bear_' + n, name: 'BBW ' + n + ' Expansion (Bearish)', cat: 'bearish', method: 'Volume', research: gen('Volume'),
        entry: cmpCond(bbw(n), 'crossAbove', NUM(2)), exit: cmpCond(bbw(n), 'crossBelow', NUM(1)) });
    });

    uniqueInts(3, 8, 30, 14).forEach(n => {
      add({ key: 'adx_brk_' + n, name: 'ADX ' + n + ' Breakout', cat: 'bullish', method: 'Volatility', research: gen('Volatility'),
        entry: cmpCond(adx(n), 'crossAbove', NUM(25)), exit: cmpCond(adx(n), 'crossBelow', NUM(20)) });
    });

    uniqueInts(3, 10, 40, 20).forEach(n => {
      add({ key: 'pc_brk_' + n, name: 'Price Channel Breakout ' + n, cat: 'bullish', method: 'Chart Structure', research: gen('Chart Structure'),
        entry: pCross(pcUpper(n), 'above'), exit: pCross(pcMid(n), 'below') });
      add({ key: 'pc_brkd_' + n, name: 'Price Channel Breakdown ' + n, cat: 'bearish', method: 'Chart Structure', research: gen('Chart Structure'),
        entry: pCross(pcLower(n), 'below'), exit: pCross(pcMid(n), 'above') });
    });

    /* ---- multi-indicator (3+) parameter-swept confluence variants ----
       Combine trend + momentum + volume / volatility across a range of
       parameter sets so the engine tests genuinely multi-indicator strategies
       rather than single or dual indicator rules. */
    uniqPairs(3, () => {
      const f = randInt(3, 15);
      return [f, f + randInt(3, 45), randInt(45, 60)];
    }).forEach(([f, s, rsiLvl]) => {
      add({ key: 'triple_ema_rsi_vol_' + f + '_' + s, name: 'EMA ' + f + '/' + s + ' + RSI + Volume', cat: 'bullish', method: 'Indicator', research: gen('Indicator'),
        entry: cmpCond(ema(f), 'crossAbove', IND(ema(s))),
        entryExtra: [cmpCond(rsi(14), 'gt', NUM(rsiLvl)), cmpCond(volosc(5, 20), 'gt', NUM(0))],
        exit: cmpCond(ema(f), 'crossBelow', IND(ema(s))),
        exitExtra: [cmpCond(rsi(14), 'lt', NUM(rsiLvl - 5)), cmpCond(volosc(5, 20), 'lt', NUM(0))] });
      add({ key: 'triple_ema_rsi_vol_bear_' + f + '_' + s, name: 'EMA ' + f + '/' + s + ' + RSI + Volume (Bear)', cat: 'bearish', method: 'Indicator', research: gen('Indicator'),
        entry: cmpCond(ema(f), 'crossBelow', IND(ema(s))),
        entryExtra: [cmpCond(rsi(14), 'lt', NUM(100 - rsiLvl)), cmpCond(volosc(5, 20), 'gt', NUM(0))],
        exit: cmpCond(ema(f), 'crossAbove', IND(ema(s))),
        exitExtra: [cmpCond(rsi(14), 'gt', NUM(105 - rsiLvl)), cmpCond(volosc(5, 20), 'lt', NUM(0))] });
    });

    uniqPairs(2, () => {
      const fa = randInt(6, 16);
      return [fa, fa + randInt(10, 30)];
    }).forEach(([fa, sl]) => {
      add({ key: 'macd_rsi_adx_' + fa + '_' + sl, name: 'MACD (' + fa + ',' + sl + ') + RSI + ADX', cat: 'bullish', method: 'Indicator', research: gen('Indicator'),
        entry: cond({ indId: 'macd', indSettings: { fast: fa, slow: sl, signal: 9 }, valueKey: 'v0', logic: 'crossAbove', cmpType: 'smoothed' }),
        entryExtra: [cmpCond(rsi(14), 'gt', NUM(50)), cmpCond(adx(14), 'gt', NUM(20))],
        exit: cond({ indId: 'macd', indSettings: { fast: fa, slow: sl, signal: 9 }, valueKey: 'v0', logic: 'crossBelow', cmpType: 'smoothed' }),
        exitExtra: [cmpCond(rsi(14), 'lt', NUM(45)), cmpCond(adx(14), 'lt', NUM(20))] });
      add({ key: 'macd_rsi_adx_bear_' + fa + '_' + sl, name: 'MACD (' + fa + ',' + sl + ') + RSI + ADX (Bear)', cat: 'bearish', method: 'Indicator', research: gen('Indicator'),
        entry: cond({ indId: 'macd', indSettings: { fast: fa, slow: sl, signal: 9 }, valueKey: 'v0', logic: 'crossBelow', cmpType: 'smoothed' }),
        entryExtra: [cmpCond(rsi(14), 'lt', NUM(50)), cmpCond(adx(14), 'gt', NUM(20))],
        exit: cond({ indId: 'macd', indSettings: { fast: fa, slow: sl, signal: 9 }, valueKey: 'v0', logic: 'crossAbove', cmpType: 'smoothed' }),
        exitExtra: [cmpCond(rsi(14), 'gt', NUM(55)), cmpCond(adx(14), 'lt', NUM(20))] });
    });

    uniqPairs(3, () => {
      const p = randInt(7, 20);
      return [p, Math.round(randInt(15, 40) / 10) * 10 / 10, randInt(18, 28)];
    }).forEach(([p, fct, adxLvl]) => {
      add({ key: 'st_adx_mfi_' + p + '_' + fct, name: 'Supertrend (' + p + ',' + fct + ') + ADX + MFI', cat: 'bullish', method: 'Indicator', research: gen('Indicator'),
        entry: pCross(supertrend(p, fct), 'above'),
        entryExtra: [cmpCond(adx(14), 'gt', NUM(adxLvl)), cmpCond(mfi(14), 'gt', NUM(50))],
        exit: pCross(supertrend(p, fct), 'below'),
        exitExtra: [cmpCond(adx(14), 'lt', NUM(adxLvl)), cmpCond(mfi(14), 'lt', NUM(45))] });
      add({ key: 'st_adx_mfi_short_' + p + '_' + fct, name: 'Supertrend (' + p + ',' + fct + ') + ADX + MFI (Short)', cat: 'bearish', method: 'Indicator', research: gen('Indicator'),
        entry: pCross(supertrend(p, fct), 'below'),
        entryExtra: [cmpCond(adx(14), 'gt', NUM(adxLvl)), cmpCond(mfi(14), 'lt', NUM(50))],
        exit: pCross(supertrend(p, fct), 'above'),
        exitExtra: [cmpCond(adx(14), 'lt', NUM(adxLvl)), cmpCond(mfi(14), 'gt', NUM(55))] });
    });

    uniqPairs(2, () => {
      const ln = randInt(15, 25);
      return [ln, Math.round(randInt(15, 35) / 10) * 10 / 10, randInt(25, 40)];
    }).forEach(([ln, m, rsiLvl]) => {
      add({ key: 'bb_mfi_uo_' + ln + '_' + m, name: 'Bollinger %B (' + ln + ',' + m + ') + MFI + UO', cat: 'bullish', method: 'Volatility', research: gen('Volatility'),
        entry: cmpCond(bollB(ln, m), 'crossAbove', NUM(0)),
        entryExtra: [cmpCond(mfi(14), 'gt', NUM(30)), cmpCond(uo(7, 14, 28), 'gt', NUM(50))],
        exit: cmpCond(bollB(ln, m), 'crossBelow', NUM(1)),
        exitExtra: [cmpCond(mfi(14), 'lt', NUM(70)), cmpCond(uo(7, 14, 28), 'lt', NUM(50))] });
      add({ key: 'bb_mfi_uo_bear_' + ln + '_' + m, name: 'Bollinger %B (' + ln + ',' + m + ') + MFI + UO (Bear)', cat: 'bearish', method: 'Volatility', research: gen('Volatility'),
        entry: cmpCond(bollB(ln, m), 'crossBelow', NUM(1)),
        entryExtra: [cmpCond(mfi(14), 'lt', NUM(70)), cmpCond(uo(7, 14, 28), 'lt', NUM(50))],
        exit: cmpCond(bollB(ln, m), 'crossAbove', NUM(0)),
        exitExtra: [cmpCond(mfi(14), 'gt', NUM(30)), cmpCond(uo(7, 14, 28), 'gt', NUM(50))] });
    });

    uniqPairs(2, () => {
      const fst = randInt(3, 8);
      return [fst, fst + randInt(15, 40)];
    }).forEach(([fst, slw]) => {
      add({ key: 'ao_ppo_vol_' + fst + '_' + slw, name: 'AO (' + fst + ',' + slw + ') + PPO + Volume', cat: 'bullish', method: 'Indicator', research: gen('Indicator'),
        entry: cmpCond(ao(fst, slw), 'crossAbove', NUM(0)),
        entryExtra: [cond({ indId: 'ppo', indSettings: { fast: 12, slow: 26, signal: 9 }, valueKey: 'v0', logic: 'gt', cmpType: 'smoothed' }), cmpCond(volosc(5, 20), 'gt', NUM(0))],
        exit: cmpCond(ao(fst, slw), 'crossBelow', NUM(0)),
        exitExtra: [cond({ indId: 'ppo', indSettings: { fast: 12, slow: 26, signal: 9 }, valueKey: 'v0', logic: 'lt', cmpType: 'smoothed' }), cmpCond(volosc(5, 20), 'lt', NUM(0))] });
      add({ key: 'ao_ppo_vol_bear_' + fst + '_' + slw, name: 'AO (' + fst + ',' + slw + ') + PPO + Volume (Bear)', cat: 'bearish', method: 'Indicator', research: gen('Indicator'),
        entry: cmpCond(ao(fst, slw), 'crossBelow', NUM(0)),
        entryExtra: [cond({ indId: 'ppo', indSettings: { fast: 12, slow: 26, signal: 9 }, valueKey: 'v0', logic: 'lt', cmpType: 'smoothed' }), cmpCond(volosc(5, 20), 'gt', NUM(0))],
        exit: cmpCond(ao(fst, slw), 'crossAbove', NUM(0)),
        exitExtra: [cond({ indId: 'ppo', indSettings: { fast: 12, slow: 26, signal: 9 }, valueKey: 'v0', logic: 'gt', cmpType: 'smoothed' }), cmpCond(volosc(5, 20), 'lt', NUM(0))] });
    });

    uniqueInts(2, 10, 30, 0).forEach(wn => {
      const os = -randInt(90, 75);
      const ob = -randInt(25, 5);
      add({ key: 'wr_macd_vol_' + wn, name: 'Williams %R (' + wn + ') + MACD + Volume', cat: 'bullish', method: 'Indicator', research: gen('Indicator'),
        entry: cmpCond(williamsR(wn), 'crossAbove', NUM(os)),
        entryExtra: [cond({ indId: 'macd', indSettings: { fast: 12, slow: 26, signal: 9 }, valueKey: 'v0', logic: 'crossAbove', cmpType: 'smoothed' }), cmpCond(volosc(5, 20), 'gt', NUM(0))],
        exit: cmpCond(williamsR(wn), 'crossBelow', NUM(ob)),
        exitExtra: [cond({ indId: 'macd', indSettings: { fast: 12, slow: 26, signal: 9 }, valueKey: 'v0', logic: 'crossBelow', cmpType: 'smoothed' }), cmpCond(volosc(5, 20), 'lt', NUM(0))] });
      add({ key: 'wr_macd_vol_bear_' + wn, name: 'Williams %R (' + wn + ') + MACD + Volume (Bear)', cat: 'bearish', method: 'Indicator', research: gen('Indicator'),
        entry: cmpCond(williamsR(wn), 'crossBelow', NUM(ob)),
        entryExtra: [cond({ indId: 'macd', indSettings: { fast: 12, slow: 26, signal: 9 }, valueKey: 'v0', logic: 'crossBelow', cmpType: 'smoothed' }), cmpCond(volosc(5, 20), 'gt', NUM(0))],
        exit: cmpCond(williamsR(wn), 'crossAbove', NUM(os)),
        exitExtra: [cond({ indId: 'macd', indSettings: { fast: 12, slow: 26, signal: 9 }, valueKey: 'v0', logic: 'crossAbove', cmpType: 'smoothed' }), cmpCond(volosc(5, 20), 'lt', NUM(0))] });
    });

    /* ---- deep multi-indicator confluence (4 to 8 indicators) ----
       Bounded combinatorial generator: every strategy pairs one trend
       trigger with 3..7 confirmation indicators (momentum / volume / money
       flow / volatility), so each template evaluates 4..8 indicators.
       Indicator series are computed ONCE per candle array and shared across
       all templates via the aligned-series cache, and every condition is
       pre-rendered to a boolean array before the O(n) bar loop - so each
       4-8 indicator test stays O(n) (~0.15ms/template) and a repeat
       experiment pass is a pure backtestCached hit well under 10ms. */
    const DEEP_CONFIRM = [
      { k: 'rsi50', bull: () => cmpCond(rsi(14), 'gt', NUM(50)), bear: () => cmpCond(rsi(14), 'lt', NUM(50)) },
      { k: 'adx20', bull: () => cmpCond(adx(14), 'gt', NUM(20)), bear: () => cmpCond(adx(14), 'gt', NUM(20)) },
      { k: 'mfi50', bull: () => cmpCond(mfi(14), 'gt', NUM(50)), bear: () => cmpCond(mfi(14), 'lt', NUM(50)) },
      { k: 'macdSig', bull: () => cond({ indId: 'macd', indSettings: { fast: 12, slow: 26, signal: 9 }, valueKey: 'v0', logic: 'gt', cmpType: 'smoothed' }),
                      bear: () => cond({ indId: 'macd', indSettings: { fast: 12, slow: 26, signal: 9 }, valueKey: 'v0', logic: 'lt', cmpType: 'smoothed' }) },
      { k: 'ppoSig', bull: () => cond({ indId: 'ppo', indSettings: { fast: 12, slow: 26, signal: 9 }, valueKey: 'v0', logic: 'gt', cmpType: 'smoothed' }),
                     bear: () => cond({ indId: 'ppo', indSettings: { fast: 12, slow: 26, signal: 9 }, valueKey: 'v0', logic: 'lt', cmpType: 'smoothed' }) },
      { k: 'aoPos', bull: () => cmpCond(ao(5, 34), 'gt', NUM(0)), bear: () => cmpCond(ao(5, 34), 'lt', NUM(0)) },
      { k: 'uo50', bull: () => cmpCond(uo(7, 14, 28), 'gt', NUM(50)), bear: () => cmpCond(uo(7, 14, 28), 'lt', NUM(50)) },
      { k: 'wrM50', bull: () => cmpCond(williamsR(14), 'gt', NUM(-50)), bear: () => cmpCond(williamsR(14), 'lt', NUM(-50)) },
      { k: 'dpoPos', bull: () => cmpCond(dpo(20), 'gt', NUM(0)), bear: () => cmpCond(dpo(20), 'lt', NUM(0)) },
      { k: 'volPos', bull: () => cmpCond(volosc(5, 20), 'gt', NUM(0)), bear: () => cmpCond(volosc(5, 20), 'gt', NUM(0)) },
      { k: 'obvSig', bull: () => cond({ indId: 'obv', indSettings: { maLength: 30, maType: 'sma' }, valueKey: 'v0', logic: 'gt', cmpType: 'smoothed' }),
                     bear: () => cond({ indId: 'obv', indSettings: { maLength: 30, maType: 'sma' }, valueKey: 'v0', logic: 'lt', cmpType: 'smoothed' }) },
      { k: 'emaFvS', bull: () => cmpCond(ema(21), 'gt', IND(ema(55))), bear: () => cmpCond(ema(21), 'lt', IND(ema(55))) }
    ];
    const DEEP_TRIGGERS = [
      { k: 'emaX', name: 'EMA 9/21 Cross', bull: () => cmpCond(ema(9), 'crossAbove', IND(ema(21))), bear: () => cmpCond(ema(9), 'crossBelow', IND(ema(21))) },
      { k: 'stFlip', name: 'Supertrend Flip', bull: () => pCross(supertrend(10, 3), 'above'), bear: () => pCross(supertrend(10, 3), 'below') },
      { k: 'macdX', name: 'MACD Cross', bull: () => cond({ indId: 'macd', indSettings: { fast: 12, slow: 26, signal: 9 }, valueKey: 'v0', logic: 'crossAbove', cmpType: 'smoothed' }),
                      bear: () => cond({ indId: 'macd', indSettings: { fast: 12, slow: 26, signal: 9 }, valueKey: 'v0', logic: 'crossBelow', cmpType: 'smoothed' }) },
      { k: 'chnBO', name: 'Channel Breakout', bull: () => pCross(pcUpper(20), 'above'), bear: () => pCross(pcLower(20), 'below') },
      { k: 'rsiRet', name: 'RSI Retrace', bull: () => cmpCond(rsi(14), 'crossAbove', NUM(45)), bear: () => cmpCond(rsi(14), 'crossBelow', NUM(55)) }
    ];
    /* Randomly pick which confirm combinations and how many sizes each run
       tests, so consecutive runs explore different 4-8 indicator bundles
       instead of the same rotated grid every time. */
    const deepSizes = shuffle([3, 4, 5, 6, 7]).slice(0, 3);
    DEEP_TRIGGERS.forEach(tr => {
      deepSizes.forEach(k => {
        const idx = shuffle(DEEP_CONFIRM.map((c, i) => i)).slice(0, k).sort((a, b) => a - b);
        ['bull', 'bear'].forEach(side => {
          const entryExtra = idx.map(i => DEEP_CONFIRM[i][side]());
          const exitExtra = idx.slice(0, 2).map(i => DEEP_CONFIRM[i][side === 'bull' ? 'bear' : 'bull']());
          add({
            key: 'deep_' + tr.k + '_' + side + '_' + k + '_' + idx.join('-'),
            name: tr.name + ' + ' + k + ' indicator confirms (' + side + ')',
            cat: side === 'bull' ? 'bullish' : 'bearish',
            method: 'Indicator',
            research: gen('Indicator'),
            entry: tr[side](),
            entryExtra: entryExtra,
            // Majority of confirmations must join the trigger so the full
            // 4-8 indicator bundle is evaluated but a single laggard
            // indicator cannot starve the strategy of entries.
            entryThreshold: Math.ceil(k / 2),
            exit: tr[side === 'bull' ? 'bear' : 'bull'](),
            exitExtra: exitExtra
          });
        });
      });
    });

    _templateCache = out;
    /* Optional "limit indicators per strategy" gate: when enabled the
       experiment only tests templates that reference at most the configured
       number of indicator series (e.g. 4 = trigger + up to 3 confirmations).
       Applied on every read so a changed limit takes effect immediately even
       though the full set stays cached. */
    const u = state.universal || {};
    if (u.indLimitEnabled) {
      const n = Number(u.indLimit);
      if (Number.isFinite(n) && n > 0) {
        return out.filter(t => templateIndicators(t).length <= n);
      }
    }
    return out;
  }

  /* ---------------- fast aligned series cache ---------------- */
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

  /* Resolve the comparator of a condition into {last, prev} at bar i. */
  function cmpReadAt(cond, i, candles) {
    switch (cond.cmpType) {
      case 'number': { const v = Number(cond.number) || 0; return { last: v, prev: v }; }
      case 'candle': { const k = cond.candleKey || 'close'; return { last: candles[i] ? candles[i][k] : null, prev: i > 0 ? candles[i - 1][k] : null }; }
      case 'self': {
        const key = cond.cmpValueKey || 'v1';
        return readTwo(cond.indId, cond.indSettings, key, i, candles);
      }
      case 'plot': return readTwo(cond.indId, cond.indSettings, 'v0', i, candles);
      case 'smoothed': return readTwo(cond.indId, cond.indSettings, 'v1', i, candles);
      case 'indicator': return readTwo(cond.cmpIndId, cond.cmpSettings, cond.cmpValueKey || 'v0', i, candles);
      default: return { last: null, prev: null };
    }
  }

  /* ---------------- trend / cross filter engine ---------------- */
  /* Fast monotonic-direction check over a trailing window of an aligned series.
     Reuses CrossDetector.seriesDirection (linear-regression slope + net move +
     majority agreement) when available; falls back to first-vs-last otherwise. */
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

  /* Produce a "different values" twin of an indicator so cross filters can
     compare the primary line against a sibling configuration (e.g. EMA 9 vs
     EMA 20, Supertrend 10,3 vs Supertrend 10,2). Returns null when the
     indicator has no tunable parameter (cross filter is then skipped). */
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

  /* Build the entry filter conditions from the enabled checkboxes for a given
     template. Each filter gates the strategy's own primary indicator line:
       - increasing upward / increasing downward  (trend direction)
       - increasing upward (all) / increasing downward (all) - every pane and
         overlay indicator the strategy references must trend the same way
       - gap increasing / gap decreasing  (gap between the primary line and the
         candle close, and between the primary line and a same-indicator twin
         with different values, e.g. EMA 9 vs EMA 20)
       - crossed above / crossed below the same indicator with different values */
  function buildFilterConditions(tpl) {
    const f = state.filters || {};
    const enabled = (f.bullish && (f.incUp || f.crossUp || f.gapUp || f.incUpAll || f.gtUp || f.ltUp || f.bullVolUp || f.bullVolDown || f.bullFakeBreakout || f.bullReversal || f.paneCrossUp || f.paneIncUpAll || f.bullBbwInc || f.bullBbCrossBelow || f.bullBbCrossAbove || f.bullPcCrossBelow || f.bullPcCrossAbove || f.bullSmf || f.bullVl || f.bullAsr)) || (f.bearish && (f.incDown || f.crossDown || f.gapDown || f.incDownAll || f.gtDown || f.ltDown || f.bearVolUp || f.bearVolDown || f.bearFakeBreakout || f.bearReversal || f.paneCrossDown || f.paneIncDownAll || f.bearBbwInc || f.bearBbCrossBelow || f.bearBbCrossAbove || f.bearPcCrossBelow || f.bearPcCrossAbove || f.bearSmf || f.bearVl || f.bearAsr));
    if (!enabled) return [];
    const out = [];
    /* Candle-level gates (volume trend, fake breakout, reversal) apply to the
       strategy's candle chart directly and do not need a primary indicator. */
    if (f.bullish && f.bullVolUp) out.push(cond({ indId: '', logic: 'volUp', cmpType: 'candle' }));
    if (f.bullish && f.bullVolDown) out.push(cond({ indId: '', logic: 'volDown', cmpType: 'candle' }));
    if (f.bullish && f.bullFakeBreakout) out.push(cond({ indId: '', logic: 'fakeBreakout', cmpType: 'candle', dir: 1 }));
    if (f.bullish && f.bullReversal) out.push(cond({ indId: '', logic: 'reversal', cmpType: 'candle', dir: 1 }));
    if (f.bearish && f.bearVolUp) out.push(cond({ indId: '', logic: 'volUp', cmpType: 'candle' }));
    if (f.bearish && f.bearVolDown) out.push(cond({ indId: '', logic: 'volDown', cmpType: 'candle' }));
    if (f.bearish && f.bearFakeBreakout) out.push(cond({ indId: '', logic: 'fakeBreakout', cmpType: 'candle', dir: -1 }));
    if (f.bearish && f.bearReversal) out.push(cond({ indId: '', logic: 'reversal', cmpType: 'candle', dir: -1 }));
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
       BB gates additionally require band expansion (upper band moving away
       from lower band = rising volatility). */
    const bbMid = { length: 20, mult: 2, source: 'close', midType: 'sma', midLength: 20 };
    const pcMid = { length: 20, midType: 'midpoint', midLength: 20 };
    if (f.bullBbCrossAbove || f.bearBbCrossAbove) out.push(cond({ indId: 'bb', indSettings: bbMid, valueKey: 'v1', logic: 'closeCrossAbove', expand: true }));
    if (f.bullBbCrossBelow || f.bearBbCrossBelow) out.push(cond({ indId: 'bb', indSettings: bbMid, valueKey: 'v1', logic: 'closeCrossBelow', expand: true }));
    if (f.bullPcCrossAbove || f.bearPcCrossAbove) out.push(cond({ indId: 'pc', indSettings: pcMid, valueKey: 'v1', logic: 'closeCrossAbove' }));
    if (f.bullPcCrossBelow || f.bearPcCrossBelow) out.push(cond({ indId: 'pc', indSettings: pcMid, valueKey: 'v1', logic: 'closeCrossBelow' }));
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
    }
    return out;
  }

  /* Deep-copy a template with the enabled trend/cross filters appended to its
     entryExtra (AND logic). Used both at backtest time and at deploy time so the
     deployed strategy carries the same gates the experiment measured. */
  function applyFilters(tpl) {
    const conds = buildFilterConditions(tpl);
    if (!conds.length) return tpl;
    const c = JSON.parse(JSON.stringify(tpl));
    c.entryExtra = (c.entryExtra || []).concat(JSON.parse(JSON.stringify(conds)));
    return c;
  }

  /* Which directional indicator filter (if any) is active for the backtest:
     'bullish' when the Bullish section master + any sub-option is on, 'bearish'
     for the Bearish section, or null. When a directional filter is selected the
     backtest engine only runs symbols whose own trend matches that side -
     a bearish filter backtests bearish stocks/indices only and a bullish filter
     backtests the bullish side only. */
  function hasStreamFlags(f, side) {
    return STREAM_FLAG_KEYS.some(k => f[k] && k.indexOf(side) === 0);
  }

  function activeFilterDirection() {
    const f = state.filters || {};
    const bull = f.bullish && (f.incUp || f.crossUp || f.gapUp || f.incUpAll || f.gtUp || f.ltUp || f.bullVolUp || f.bullVolDown || f.bullFakeBreakout || f.bullReversal || f.paneCrossUp || f.paneIncUpAll || f.bullBbwInc || f.bullBbCrossBelow || f.bullBbCrossAbove || f.bullPcCrossBelow || f.bullPcCrossAbove || f.bullSmf || f.bullVl || f.bullAsr || hasStreamFlags(f, 'bull'));
    const bear = f.bearish && (f.incDown || f.crossDown || f.gapDown || f.incDownAll || f.gtDown || f.ltDown || f.bearVolUp || f.bearVolDown || f.bearFakeBreakout || f.bearReversal || f.paneCrossDown || f.paneIncDownAll || f.bearBbwInc || f.bearBbCrossBelow || f.bearBbCrossAbove || f.bearPcCrossBelow || f.bearPcCrossAbove || f.bearSmf || f.bearVl || f.bearAsr || hasStreamFlags(f, 'bear'));
    if (bull && !bear) return 'bullish';
    if (bear && !bull) return 'bearish';
    return null;
  }

  /* Research-stream scoping inside the Bullish/Bearish filter sections: when a
     stream checkbox is ticked, the experiment only runs templates whose research
     group is in the ticked list for that side. Returns null when no stream
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

  /* The single strategy side the experiment may create, derived from the strike
     option type first (CE call = bullish, PE put = bearish) and falling back to
     the directional indicator filter when the strike selector is "both". A
     bullish gate means only bullish templates are backtested/created and a
     bearish gate only bearish ones, so selecting CE + a bullish filter never
     experiments with bearish strategies (and PE + a bearish filter never
     experiments with bullish ones). Returns null when both sides are allowed. */
  function effectiveStrategyDirection() {
    const ot = (state.strike && state.strike.optionType) || 'both';
    if (ot === 'CE') return 'bullish';
    if (ot === 'PE') return 'bearish';
    return activeFilterDirection();
  }

  /* Human-readable labels of the enabled trend/cross filters for a template. */
  function activeFilterLabels(tpl) {
    return buildFilterConditions(tpl).map(c => condLabel(c, true));
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
      default: return false;
    }
  }

  function evalCondAt(cond, i, candles) {
    if (!cond) return false;
    if (cond.cmpType === 'candlestick_pattern' || cond.cmpType === 'pattern') {
      return patternHitAt(cond.candlePatterns, i, candles);
    }
    if (cond.logic === 'volUp' || cond.logic === 'volDown') {
      return trendAt(volumeSeries(candles), i, cond.logic === 'volUp' ? 'up' : 'down');
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
    if (cond.logic === 'closeCrossAbove' || cond.logic === 'closeCrossBelow') {
      const bar = candles[i];
      const band = readTwo(cond.indId, cond.indSettings, cond.valueKey || 'v1', i, candles).last;
      if (!bar || band == null) return false;
      const crossed = cond.logic === 'closeCrossAbove' ? bar.close > band : bar.close < band;
      if (!crossed) return false;
      if (cond.expand && cond.indId === 'bb') {
        const width = bbGapSeries(cond.indSettings, candles);
        if (!trendAt(width, i, 'up')) return false;
      }
      return true;
    }
    if (!cond.indId) return false;
    if (cond.logic === 'incUp' || cond.logic === 'incDown') {
      const arr = alignedSeries(cond.indId, cond.indSettings, cond.valueKey, candles);
      return trendAt(arr, i, cond.logic === 'incUp' ? 'up' : 'down');
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

  /* Multi-indicator combinators. A condition may be a single object or an
     array of objects. ALL of them must be true for an entry (confirmation),
     ANY of them may fire an exit (fail-fast). */
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

  /* N-of-M for live paper evaluation: at least `need` of the conds must hold
     at bar i (mirror of buildNof used by the backtest). */
  function evalCondNof(conds, need, i, candles) {
    if (!conds || !conds.length) return need <= 0;
    const k = Math.max(1, Math.min(need, conds.length));
    let hit = 0;
    for (const c of conds) { if (evalCondAt(c, i, candles) && ++hit >= k) break; }
    return hit >= k;
  }

  /* Precompute the entry/exit signal as a boolean array so the backtest
     inner loop is pure array reads. Returns null when cond has no signal. */
  function buildSignal(cond, candles) {
    if (!cond) return null;
    if (cond.cmpType === 'candlestick_pattern' || cond.cmpType === 'pattern') {
      return patternHits(cond.candlePatterns, candles);
    }
    const n = candles.length;
    if (cond.logic === 'volUp' || cond.logic === 'volDown') {
      const want = cond.logic === 'volUp' ? 'up' : 'down';
      const vol = volumeSeries(candles);
      const out = new Array(n).fill(false);
      for (let i = 0; i < n; i++) out[i] = trendAt(vol, i, want);
      return out;
    }
    if (cond.logic === 'fakeBreakout') {
      const dir = cond.dir === -1 ? 'bearish' : 'bullish';
      const out = new Array(n).fill(false);
      for (let i = 0; i < n; i++) out[i] = fakeBreakoutAt(candles, i, dir);
      return out;
    }
    if (cond.logic === 'reversal') {
      const dir = cond.dir === -1 ? 'bearish' : 'bullish';
      const out = new Array(n).fill(false);
      for (let i = 0; i < n; i++) out[i] = reversalAt(candles, i, dir);
      return out;
    }
    if (!cond.indId) return null;
    const primArr = alignedSeries(cond.indId, cond.indSettings, cond.valueKey, candles);
    if (!primArr) return null;
    if (cond.logic === 'incUp' || cond.logic === 'incDown') {
      const want = cond.logic === 'incUp' ? 'up' : 'down';
      const out = new Array(n).fill(false);
      for (let i = 0; i < n; i++) out[i] = trendAt(primArr, i, want);
      return out;
    }
    let cmpArr = null, cmpNum = null, cmpKey = null;
    switch (cond.cmpType) {
      case 'number': cmpNum = Number(cond.number) || 0; break;
      case 'candle': cmpKey = cond.candleKey || 'close'; break;
      case 'self': cmpArr = alignedSeries(cond.indId, cond.indSettings, cond.cmpValueKey || 'v1', candles); break;
      case 'plot': cmpArr = alignedSeries(cond.indId, cond.indSettings, 'v0', candles); break;
      case 'smoothed': cmpArr = alignedSeries(cond.indId, cond.indSettings, 'v1', candles); break;
      case 'indicator': cmpArr = alignedSeries(cond.cmpIndId, cond.cmpSettings, cond.cmpValueKey || 'v0', candles); break;
      default: break;
    }
    const out = new Array(n).fill(false);
    for (let i = 0; i < n; i++) {
      const last = primArr[i];
      if (last == null) continue;
      let cmpLast = null, cmpPrev = null;
      if (cmpNum != null) { cmpLast = cmpNum; cmpPrev = cmpNum; }
      else if (cmpKey != null) { cmpLast = candles[i] ? candles[i][cmpKey] : null; cmpPrev = i > 0 ? candles[i - 1][cmpKey] : null; }
      else if (cmpArr) { cmpLast = cmpArr[i]; cmpPrev = i > 0 ? cmpArr[i - 1] : null; }
      else continue;
      if (cond.logic === 'gapUp' || cond.logic === 'gapDown') {
        const prev = i > 0 ? primArr[i - 1] : null;
        if (prev == null || cmpPrev == null) continue;
        const gap = Math.abs(last - cmpLast);
        const prevGap = Math.abs(prev - cmpPrev);
        out[i] = cond.logic === 'gapUp' ? gap > prevGap : gap < prevGap;
        continue;
      }
      out[i] = applyLogicAt(cond.logic, last, i > 0 ? primArr[i - 1] : null, cmpLast, cmpPrev);
    }
    return out;
  }

  /* Combine several conditions into a single boolean array.
     buildAll = AND (all must hold), buildAny = OR (any holds). */
  function buildAll(conds, candles) {
    return buildNof(conds, conds ? conds.length : 0, candles);
  }

  /* N-of-M conjunction: a bar qualifies when AT LEAST `need` of the `conds`
     are true. `need === conds.length` is plain AND (the historic entryExtra
     behaviour), while a lower threshold turns a bundle of confirmations into a
     majority-vote confluence - used by the 4-8 indicator templates so they
     genuinely combine many indicators without being strangled by requiring
     every single one at the same bar. O(n * M) with shared signal arrays. */
  function buildNof(conds, need, candles) {
    if (!conds || !conds.length) return null;
    const k = Math.max(1, Math.min(need, conds.length));
    const subs = conds.map(c => buildSignal(c, candles));
    const n = candles.length;
    const out = new Array(n).fill(false);
    for (let i = 0; i < n; i++) {
      let hit = 0;
      for (const s of subs) { if (s && s[i] && ++hit >= k) break; }
      out[i] = hit >= k;
    }
    return out;
  }

  function buildAny(conds, candles) {
    if (!conds || !conds.length) return null;
    const subs = conds.map(c => buildSignal(c, candles));
    const n = candles.length;
    const out = new Array(n).fill(false);
    for (let i = 0; i < n; i++) {
      for (const s of subs) { if (s && s[i]) { out[i] = true; break; } }
    }
    return out;
  }

  /* ---------------- auto stop-loss (hunting-aware) ---------------- */
  /* Place the stop beyond the instrument's average true range so it sits past
     the typical noise band and cannot be trivially hunted by a single wick. */
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
    // 1.6x ATR clears most stop-hunts while staying within a sane band.
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

  /* ---------------- auto trailing take-profit (AI trail %) ---------------- */
  /* When AI Trail TP is enabled the engine replaces the fixed "Trail %" with a
     dynamic, per-bar trail decided by the profit-maximizing AiTrailEngine (see
     aitrail.js): it simulates trailing stops over the recent bars and picks
     the trail % that captures maximum profit, fused with a volatility /
     trend-regime adjustment. The result is cached per candle series so every
     template backtest on the same series reuses it. */
  /* AI Trail TP series: backed by the profit-maximizing AiTrailEngine
     (aitrail.js). It simulates trailing stops over the recent bars and picks
     the trail % that captures maximum profit, fused with a volatility /
     trend-regime adjustment. */
  function aiTrailSeries(candles, side, baseTp) {
    if (!candles || candles.length < 40) return null;
    if (!window.AiTrailEngine) return null;
    const m = seriesMap(candles);
    const key = 'AITRAIL|' + (side === 'short' ? 'S' : 'L') + '|' + (Number(baseTp) || 1);
    if (m.has(key)) return m.get(key);
    const arr = window.AiTrailEngine.batch(candles, side, Number(baseTp) || 1);
    m.set(key, arr);
    return arr;
  }

  /* ---------------- backtest ---------------- */
  /* Take-profit is automatic: instead of a fixed +X% target (which caps every
     winner at X%), the trade rides the move and is closed by a trailing stop
     that ratchets up behind the peak favourable price. This lets the strategy
     capture the maximum profit a move offers and only gives back `tpPct`% of
     the retracement before banking the rest. */
  function backtest(tpl, candles, opts) {
    /* Mirror the live paper-trade risk settings (activeExitMode / autoEntry):
       manual SL / TP / Trail TP override their AI counterparts, defaulting to
       AI Stop-Loss + AI Trail TP. The backtest now also closes trades on the
       stop-loss level, so win rate / P&L reflect the user's configured risk
       instead of a best-case 100% that only ever closed winners. */
    const u = opts || {};
    const manualSLOn = u.manualSL === true;
    const manualTrailSLOn = u.manualTrailSL === true;
    const manualTrailTPOn = u.manualTrailTP === true;
    const manualTPOn = u.manualTP === true;
    const aiSlOn = !manualSLOn && !manualTrailSLOn && u.aiSl !== false;
    const aiTpOn = !manualTrailTPOn && u.aiTp !== false;
    const aiTPOn = !manualTPOn && u.aiTP !== false;
    const slPct = manualSLOn ? (Number(u.manualSLPct) || 0) : (aiSlOn ? autoSLPct(candles) : 0);
    const slTrailPct = manualTrailSLOn ? (Number(u.manualTrailSLPct) || 0) : 0;
    const trailTpPct = manualTrailTPOn
      ? (Number(u.manualTrailTPPct) || 0)
      : (aiTpOn ? ((u.manualTrail === false) ? 1 : ((Number(u.tpPct) > 0) ? Number(u.tpPct) : 1)) : 0);
    const fixedTpPct = (u.rrEnabled === true && Number(u.rrValue) > 0 && slPct > 0)
      ? slPct * Number(u.rrValue)   // reward = risk x RR (overrides manual + AI TP)
      : (manualTPOn
          ? (Number(u.manualTPPct) || 0)
          : (aiTPOn ? aiTPPct(candles) : 0));
    const aiTrail = aiTpOn && !manualTrailTPOn; // AI Trail TP master (per-bar trail)
    /* Broker charges: when enabled, a rupee cost per closed trade is deducted
       from the trade's return. Dhan-auto mode computes the real brokerage +
       STT + GST + exchange + SEBI + stamp from the trade's premium and qty;
       custom mode uses a flat rupee amount. The charge is converted to a % of
       the trade's notional (entry premium x qty) so net % matches net rupees;
       `btQty` is resolved per symbol by the runner (opts.btQty) or falls back
       to lots x universal lot size. */
    const brokerOn = u.deductBrokerCharges === true;
    const btQty = (Number(u.btQty) > 0) ? Number(u.btQty) : Math.max(1, Math.round((Number(u.lots) || 1) * (Number(u.lotSize) > 0 ? Number(u.lotSize) : 1)));
    /* The open/close time gates restrict when new trades may be opened. When
       either gate is on, each candidate entry's candle time is checked against
       the "start trading after" / "no trade after" window before entry. */
    const timeGated = !!(opts && (opts.startTradeAfterEnabled || opts.noTradeAfterEnabled));
    /* Max number of trades this strategy may take on this series. A manual cap
       comes from the "Max trades" input; the AI auto-trades engine analyses
       the chart + indicators + volatility + market-open-time phase of the tape
       and decides a smart per-strategy budget instead of a fixed number. When
       "daily" mode is enabled the cap applies PER DAY (it resets at each IST
       day boundary) instead of across the whole series. */
    let maxTrades = null;
    let perDayLimit = null;
    if (opts && opts.aiTrades && window.AITradesEngine) {
      /* AI auto trades: unlimited whenever a trade is possible; the AI engine
         only decides whether the tape offers a chance to trade. */
      window.AITradesEngine.decide(candles, false);
      maxTrades = null;
    } else if (opts && opts.tradeLimitEnabled && Number(opts.tradeLimitCount) > 0) {
      if (opts.dailyBacktest === true && opts.tradeLimitDaily === true) perDayLimit = Number(opts.tradeLimitCount);
      else maxTrades = Number(opts.tradeLimitCount);
    }
    const n = candles.length;
    if (n < 40) return null;
    const warm = 60; // let indicators warm up
    if (n <= warm + 5) return null;
    const long = true; // buy-only: bearish strategies still analyze the bearish trend, but trades always execute long
    const aiTrailArr = aiTrail ? aiTrailSeries(candles, long ? 'long' : 'short', trailTpPct > 0 ? trailTpPct : 1) : null;
    let pos = null; // { entry }
    let inPos = false;
    let prevEntry = false;
    let curDay = null, dayCount = 0;
    let trades = [], wins = 0, losses = 0, grossWin = 0, grossLoss = 0;
    let equity = [0], tradesList = [];
    const entrySignal = buildSignal(tpl.entry, candles);
    const etConds = tpl.entryExtra || [];
    const need = (tpl.entryThreshold != null && tpl.entryThreshold >= 1)
      ? Math.min(tpl.entryThreshold, etConds.length) : etConds.length;
    const entryExtraSignal = etConds.length ? buildNof(etConds, need, candles) : null;
    const entryCS = (tpl.candlestick && tpl.candlestick.entry && tpl.candlestick.entry.length)
      ? patternHits(tpl.candlestick.entry, candles) : null;
    for (let i = warm; i < n; i++) {
      const entryNow = (entrySignal ? entrySignal[i] : false) &&
        (entryExtraSignal ? entryExtraSignal[i] : true) &&
        (entryCS ? entryCS[i] : true);
      /* When a "backtest trades per strategy" limit is set, a flat position is
         allowed to re-enter as long as the entry condition still holds, so the
         run fills up to the configured trade count instead of only firing on a
         fresh signal edge. Unlimited backtests keep the strict edge gating. */
      const forceFill = maxTrades != null || perDayLimit != null;
      const entryEdge = forceFill ? entryNow : (entryNow && !prevEntry);
      prevEntry = entryNow;
      /* Per-day trade cap: the counter resets at each IST day boundary so a
         "limit backtest trades" count of N means up to N trades EACH day. */
      const cDay = istDayKey(candles[i].time);
      if (perDayLimit != null && cDay !== curDay) { curDay = cDay; dayCount = 0; }

      if (!inPos) {
        if (entryEdge &&
            (perDayLimit != null ? (dayCount < perDayLimit) : (maxTrades == null || trades.length < maxTrades)) &&
            (!timeGated || timeGateOk(istMinuteOfDay(candles[i].time), opts))) {
          pos = { entry: candles[i].close, peak: candles[i].close, day: cDay };
          inPos = true;
          if (perDayLimit != null) dayCount++;
        }
      } else {
        const hi = candles[i].high, lo = candles[i].low;
        let exitPrice = null, reason = null;
        const t = (aiTrailArr != null && aiTrailArr[i] != null) ? aiTrailArr[i] : trailTpPct;
        if (long) {
          if (hi > pos.peak) pos.peak = hi;
          // Close reasons mirror the live engine (papertrade.js
          // checkAutoTargetSl): stop-loss first, then fixed TP, then the
          // trailing TP (a % of the running profit off peak). SL is only active
          // when the user's SL setting is on (manual SL % or AI SL). A trailing
          // SL ratchets the stop up behind the peak, mirroring live ticks.
          const peakProfit = pos.peak - pos.entry;
          const baseSl = slPct > 0 ? pos.entry * (1 - slPct / 100) : (slTrailPct > 0 ? pos.entry * (1 - slTrailPct / 100) : null);
          /* Trail SL only ratchets once the trade is IN PROFIT (peak above
             entry) - mirroring live: while at/below entry the stop stays at the
             fixed entry-based level and is never pulled up against a loss. Once
             green it rides the RUNNING PROFIT (peak - entry): it keeps
             (100 - trail%)% of the peak profit and gives back only trail% of
             it, so the stop hugs the profit and slides up behind it. */
          const ratchetSl = (slTrailPct > 0 && baseSl != null && pos.peak > pos.entry) ? Math.max(baseSl, pos.entry + (pos.peak - pos.entry) * (1 - slTrailPct / 100)) : baseSl;
          const trail = Math.max(pos.entry + peakProfit * (1 - t / 100), pos.entry);
          const tpPrice = fixedTpPct > 0 ? pos.entry * (1 + fixedTpPct / 100) : null;
          if (ratchetSl != null && lo <= ratchetSl) { exitPrice = ratchetSl; reason = (slTrailPct > 0 && ratchetSl > baseSl) ? 'Trail SL' : 'SL'; }
          else if (tpPrice != null && hi >= tpPrice) { exitPrice = tpPrice; reason = 'TP'; }
          else if (t > 0 && peakProfit > 0 && lo <= trail) { exitPrice = trail; reason = 'Trail TP'; }
        } else {
          if (lo < pos.peak) pos.peak = lo;
          const peakProfit = pos.entry - pos.peak;
          const baseSl = slPct > 0 ? pos.entry * (1 + slPct / 100) : (slTrailPct > 0 ? pos.entry : null);
          /* Trail SL only ratchets once the trade is IN PROFIT (peak below
             entry for a SELL) - mirroring live: while at/above entry the stop
             stays at the fixed entry-based level. Once green it rides the
             RUNNING PROFIT (entry - peak). */
          const ratchetSl = (slTrailPct > 0 && baseSl != null && pos.peak < pos.entry) ? Math.min(baseSl, pos.entry - (pos.entry - pos.peak) * (1 - slTrailPct / 100)) : baseSl;
          const trail = Math.min(pos.entry - peakProfit * (1 - t / 100), pos.entry);
          const tpPrice = fixedTpPct > 0 ? pos.entry * (1 - fixedTpPct / 100) : null;
          if (ratchetSl != null && hi >= ratchetSl) { exitPrice = ratchetSl; reason = (slTrailPct > 0 && ratchetSl < baseSl) ? 'Trail SL' : 'SL'; }
          else if (tpPrice != null && lo <= tpPrice) { exitPrice = tpPrice; reason = 'TP'; }
          else if (t > 0 && peakProfit > 0 && hi >= trail) { exitPrice = trail; reason = 'Trail TP'; }
        }
        if (exitPrice != null) {
          const ret = long ? (exitPrice - pos.entry) / pos.entry * 100 : (pos.entry - exitPrice) / pos.entry * 100;
          /* Broker charge: convert the rupee charges (entry leg at buy, exit
             leg at sell - brokerage + statutory charges on both sides) to a %
             of this trade's notional and deduct them, so a winning trade can
             become a small loser exactly like in live trading. Both gross and
             net are kept so the detail table can show the two legs and the
             net per trade. */
          let entryChargesRs = 0;
          let exitChargesRs = 0;
          let brokerRs = 0;
          let broker = 0;
          let netRet = ret;
          if (brokerOn && pos.entry > 0) {
            const split = brokerChargeSplit(u, pos.entry, exitPrice, btQty);
            entryChargesRs = split.entryRs;
            exitChargesRs = split.exitRs;
            brokerRs = split.totalRs;
            broker = brokerRs / (pos.entry * btQty) * 100;
            netRet = ret - broker;
          }
          trades.push(netRet);
          if (netRet >= 0) { wins++; grossWin += netRet; } else { losses++; grossLoss += -netRet; }
          equity.push(equity[equity.length - 1] + netRet);
          tradesList.push({ ret: Math.round(netRet * 100) / 100, grossRet: Math.round(ret * 100) / 100, entryChargesRs: Math.round(entryChargesRs * 100) / 100, exitChargesRs: Math.round(exitChargesRs * 100) / 100, brokerRs: Math.round(brokerRs * 100) / 100, brokerPct: Math.round(broker * 100) / 100, reason: reason || 'Signal', entry: Math.round(pos.entry * 100) / 100, exit: Math.round(exitPrice * 100) / 100, slPct: slPct, trailPct: t, day: pos.day || istDayKey(candles[i].time) });
          inPos = false; pos = null;
        }
      }
    }
    if (trades.length === 0) {
      return { trades: 0, wins: 0, losses: 0, winRate: 0, profitFactor: 0, totalReturn: 0, avgTrade: 0, maxDrawdown: 0, equity: [], tradesList: [], daily: [], dailyOverall: { trades: 0, wins: 0, losses: 0, winRate: 0, ret: 0, rr: 0 } };
    }
    const total = trades.length;
    const winRate = wins / total * 100;
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 99 : 0);
    const totalReturn = trades.reduce((a, b) => a + b, 0);
    let peak = -Infinity, maxDD = 0;
    for (const v of equity) { if (v > peak) peak = v; const dd = peak - v; if (dd > maxDD) maxDD = dd; }
    const dm = dailyMetrics(tradesList);
    return {
      trades: total, wins, losses,
      winRate: Math.round(winRate * 10) / 10,
      profitFactor: Math.round(Math.min(profitFactor, 99) * 100) / 100,
      totalReturn: Math.round(totalReturn * 100) / 100,
      avgTrade: Math.round((totalReturn / total) * 100) / 100,
      maxDrawdown: Math.round(maxDD * 100) / 100,
      equity: downsample(equity, 40),
      tradesList: tradesList.slice(-1000),
      daily: dm.daily,
      dailyOverall: dm.overall
    };
  }

  /* Backtest where the strategy signals are evaluated on one or more run-in
     chart series ("Strategy should be run in") while the simulated trade is
     executed on the trade-in chart series ("Trade should be executed in").
     Each signal source is aligned to the trade chart by candle timestamp; an
     entry fires only when EVERY source agrees (AND) and an exit fires when ANY
     source exits (OR), mirroring the live paper-trading semantics. This keeps
     the auto-generated backtest trades priced on the selected-strike option
     premium chart even when the strategy itself runs on the underlying spot
     chart (F&O stocks) or on both charts (indices). */
  function backtestSplit(tpl, signalSources, tradeCandles, opts) {
    /* Same risk-settings resolution as `backtest`: manual SL / TP / Trail TP
       override their AI counterparts (defaults AI Stop-Loss + AI Trail TP),
       and the split backtest also closes on the stop-loss level so results
       mirror the live paper-trade engine instead of a 100% win-rate. */
    const u = opts || {};
    const manualSLOn = u.manualSL === true;
    const manualTrailSLOn = u.manualTrailSL === true;
    const manualTrailTPOn = u.manualTrailTP === true;
    const manualTPOn = u.manualTP === true;
    const aiSlOn = !manualSLOn && !manualTrailSLOn && u.aiSl !== false;
    const aiTpOn = !manualTrailTPOn && u.aiTp !== false;
    const aiTPOn = !manualTPOn && u.aiTP !== false;
    const slPct = manualSLOn ? (Number(u.manualSLPct) || 0) : (aiSlOn ? autoSLPct(tradeCandles) : 0);
    const slTrailPct = manualTrailSLOn ? (Number(u.manualTrailSLPct) || 0) : 0;
    const trailTpPct = manualTrailTPOn
      ? (Number(u.manualTrailTPPct) || 0)
      : (aiTpOn ? ((u.manualTrail === false) ? 1 : ((Number(u.tpPct) > 0) ? Number(u.tpPct) : 1)) : 0);
    const fixedTpPct = (u.rrEnabled === true && Number(u.rrValue) > 0 && slPct > 0)
      ? slPct * Number(u.rrValue)   // reward = risk x RR (overrides manual + AI TP)
      : (manualTPOn
          ? (Number(u.manualTPPct) || 0)
          : (aiTPOn ? aiTPPct(tradeCandles) : 0));
    const aiTrail = aiTpOn && !manualTrailTPOn; // AI Trail TP master (per-bar trail)
    /* Broker charges: same as `backtest` - resolved per trade via
       brokerChargeForTrade (Dhan auto or flat custom), converted to a % of the
       trade's notional (entry premium x qty). */
    const brokerOn = u.deductBrokerCharges === true;
    const btQty = (Number(u.btQty) > 0) ? Number(u.btQty) : Math.max(1, Math.round((Number(u.lots) || 1) * (Number(u.lotSize) > 0 ? Number(u.lotSize) : 1)));
    const timeGated = !!(opts && (opts.startTradeAfterEnabled || opts.noTradeAfterEnabled));
    let maxTrades = null;
    let perDayLimit = null;
    if (opts && opts.aiTrades && window.AITradesEngine) {
      /* AI auto trades: unlimited whenever a trade is possible; the AI engine
         only decides whether the tape offers a chance to trade. */
      window.AITradesEngine.decide(tradeCandles, false);
      maxTrades = null;
    } else if (opts && opts.tradeLimitEnabled && Number(opts.tradeLimitCount) > 0) {
      if (opts.dailyBacktest === true && opts.tradeLimitDaily === true) perDayLimit = Number(opts.tradeLimitCount);
      else maxTrades = Number(opts.tradeLimitCount);
    }
    const n = tradeCandles.length;
    if (n < 40) return null;
    const warm = 60; // let indicators warm up
    if (n <= warm + 5) return null;
    const long = true; // buy-only: bearish strategies still analyze the bearish trend, but trades always execute long
    const aiTrailArr = aiTrail ? aiTrailSeries(tradeCandles, long ? 'long' : 'short', trailTpPct > 0 ? trailTpPct : 1) : null;

    /* Precompute the entry/exit booleans on every run-in source, then align
       them to the trade chart by candle time (two-pointer walk, O(n)). */
    const srcs = (Array.isArray(signalSources) && signalSources.length) ? signalSources.filter(c => c && c.length) : [tradeCandles];
    if (!srcs.length) return null;
    const tradeTimes = tradeCandles.map(c => c.time);
    const aligned = srcs.map(sc => {
      const entrySignal = buildSignal(tpl.entry, sc);
      const etConds = tpl.entryExtra || [];
      const need = (tpl.entryThreshold != null && tpl.entryThreshold >= 1)
        ? Math.min(tpl.entryThreshold, etConds.length) : etConds.length;
      const entryExtraSignal = etConds.length ? buildNof(etConds, need, sc) : null;
      const entryCS = (tpl.candlestick && tpl.candlestick.entry && tpl.candlestick.entry.length)
        ? patternHits(tpl.candlestick.entry, sc) : null;
      const srcTimes = sc.map(c => c.time);
      const idx = new Array(n);
      let s = 0;
      for (let i = 0; i < n; i++) {
        while (s + 1 < srcTimes.length && srcTimes[s + 1] <= tradeTimes[i]) s++;
        idx[i] = s;
      }
      const entryArr = new Array(n);
      for (let i = 0; i < n; i++) {
        const j = idx[i];
        entryArr[i] = (entrySignal ? entrySignal[j] : false) &&
          (entryExtraSignal ? entryExtraSignal[j] : true) &&
          (entryCS ? entryCS[j] : true);
      }
      return { entryArr };
    });

    let pos = null; // { entry }
    let inPos = false;
    let prevEntry = false;
    let curDay = null, dayCount = 0;
    let trades = [], wins = 0, losses = 0, grossWin = 0, grossLoss = 0;
    let equity = [0], tradesList = [];
    for (let i = warm; i < n; i++) {
      const entryNow = aligned.every(a => a.entryArr[i]);
      /* Same re-entry fill logic as the single-chart backtest: a configured
         trade limit lets a flat position re-enter on a still-true condition so
         the run reaches the set number of trades instead of stalling on edges. */
      const forceFill = maxTrades != null || perDayLimit != null;
      const entryEdge = forceFill ? entryNow : (entryNow && !prevEntry);
      prevEntry = entryNow;
      /* Per-day trade cap: the counter resets at each IST day boundary so a
         "limit backtest trades" count of N means up to N trades EACH day. */
      const cDay = istDayKey(tradeCandles[i].time);
      if (perDayLimit != null && cDay !== curDay) { curDay = cDay; dayCount = 0; }

      if (!inPos) {
        if (entryEdge &&
            (perDayLimit != null ? (dayCount < perDayLimit) : (maxTrades == null || trades.length < maxTrades)) &&
            (!timeGated || timeGateOk(istMinuteOfDay(tradeCandles[i].time), opts))) {
          pos = { entry: tradeCandles[i].close, peak: tradeCandles[i].close, day: cDay };
          inPos = true;
          if (perDayLimit != null) dayCount++;
        }
      } else {
        const hi = tradeCandles[i].high, lo = tradeCandles[i].low;
        let exitPrice = null, reason = null;
        const t = (aiTrailArr != null && aiTrailArr[i] != null) ? aiTrailArr[i] : trailTpPct;
        if (long) {
          if (hi > pos.peak) pos.peak = hi;
          // Close reasons mirror the live engine (papertrade.js
          // checkAutoTargetSl): stop-loss first, then fixed TP, then the
          // trailing TP (a % of the running profit off peak). SL is only active
          // when the user's SL setting is on (manual SL % or AI SL). A trailing
          // SL ratchets the stop up behind the peak, mirroring live ticks.
          const peakProfit = pos.peak - pos.entry;
          const baseSl = slPct > 0 ? pos.entry * (1 - slPct / 100) : (slTrailPct > 0 ? pos.entry * (1 - slTrailPct / 100) : null);
          /* Trail SL only ratchets once the trade is IN PROFIT (peak above
             entry) - mirroring live: while at/below entry the stop stays at the
             fixed entry-based level and is never pulled up against a loss. Once
             green it rides the RUNNING PROFIT (peak - entry): it keeps
             (100 - trail%)% of the peak profit and gives back only trail% of
             it, so the stop hugs the profit and slides up behind it. */
          const ratchetSl = (slTrailPct > 0 && baseSl != null && pos.peak > pos.entry) ? Math.max(baseSl, pos.entry + (pos.peak - pos.entry) * (1 - slTrailPct / 100)) : baseSl;
          const trail = Math.max(pos.entry + peakProfit * (1 - t / 100), pos.entry);
          const tpPrice = fixedTpPct > 0 ? pos.entry * (1 + fixedTpPct / 100) : null;
          if (ratchetSl != null && lo <= ratchetSl) { exitPrice = ratchetSl; reason = (slTrailPct > 0 && ratchetSl > baseSl) ? 'Trail SL' : 'SL'; }
          else if (tpPrice != null && hi >= tpPrice) { exitPrice = tpPrice; reason = 'TP'; }
          else if (t > 0 && peakProfit > 0 && lo <= trail) { exitPrice = trail; reason = 'Trail TP'; }
        } else {
          if (lo < pos.peak) pos.peak = lo;
          const peakProfit = pos.entry - pos.peak;
          const baseSl = slPct > 0 ? pos.entry * (1 + slPct / 100) : (slTrailPct > 0 ? pos.entry : null);
          /* Trail SL only ratchets once the trade is IN PROFIT (peak below
             entry for a SELL) - mirroring live: while at/above entry the stop
             stays at the fixed entry-based level. Once green it rides the
             RUNNING PROFIT (entry - peak). */
          const ratchetSl = (slTrailPct > 0 && baseSl != null && pos.peak < pos.entry) ? Math.min(baseSl, pos.entry - (pos.entry - pos.peak) * (1 - slTrailPct / 100)) : baseSl;
          const trail = Math.min(pos.entry - peakProfit * (1 - t / 100), pos.entry);
          const tpPrice = fixedTpPct > 0 ? pos.entry * (1 - fixedTpPct / 100) : null;
          if (ratchetSl != null && hi >= ratchetSl) { exitPrice = ratchetSl; reason = (slTrailPct > 0 && ratchetSl < baseSl) ? 'Trail SL' : 'SL'; }
          else if (tpPrice != null && lo <= tpPrice) { exitPrice = tpPrice; reason = 'TP'; }
          else if (t > 0 && peakProfit > 0 && hi >= trail) { exitPrice = trail; reason = 'Trail TP'; }
        }
        if (exitPrice != null) {
          const ret = long ? (exitPrice - pos.entry) / pos.entry * 100 : (pos.entry - exitPrice) / pos.entry * 100;
          /* Broker charge: convert the rupee charges (entry leg at buy, exit
             leg at sell - brokerage + statutory charges on both sides) to a %
             of this trade's notional and deduct them, so a winning trade can
             become a small loser exactly like in live trading. Both gross and
             net are kept so the detail table can show the two legs and the
             net per trade. */
          let entryChargesRs = 0;
          let exitChargesRs = 0;
          let brokerRs = 0;
          let broker = 0;
          let netRet = ret;
          if (brokerOn && pos.entry > 0) {
            const split = brokerChargeSplit(u, pos.entry, exitPrice, btQty);
            entryChargesRs = split.entryRs;
            exitChargesRs = split.exitRs;
            brokerRs = split.totalRs;
            broker = brokerRs / (pos.entry * btQty) * 100;
            netRet = ret - broker;
          }
          trades.push(netRet);
          if (netRet >= 0) { wins++; grossWin += netRet; } else { losses++; grossLoss += -netRet; }
          equity.push(equity[equity.length - 1] + netRet);
          tradesList.push({ ret: Math.round(netRet * 100) / 100, grossRet: Math.round(ret * 100) / 100, entryChargesRs: Math.round(entryChargesRs * 100) / 100, exitChargesRs: Math.round(exitChargesRs * 100) / 100, brokerRs: Math.round(brokerRs * 100) / 100, brokerPct: Math.round(broker * 100) / 100, reason: reason || 'Signal', entry: Math.round(pos.entry * 100) / 100, exit: Math.round(exitPrice * 100) / 100, slPct: slPct, trailPct: t, day: pos.day || istDayKey(tradeCandles[i].time) });
          inPos = false; pos = null;
        }
      }
    }
    if (trades.length === 0) {
      return { trades: 0, wins: 0, losses: 0, winRate: 0, profitFactor: 0, totalReturn: 0, avgTrade: 0, maxDrawdown: 0, equity: [], tradesList: [], daily: [], dailyOverall: { trades: 0, wins: 0, losses: 0, winRate: 0, ret: 0, rr: 0 } };
    }
    const total = trades.length;
    const winRate = wins / total * 100;
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 99 : 0);
    const totalReturn = trades.reduce((a, b) => a + b, 0);
    let peak = -Infinity, maxDD = 0;
    for (const v of equity) { if (v > peak) peak = v; const dd = peak - v; if (dd > maxDD) maxDD = dd; }
    const dm = dailyMetrics(tradesList);
    return {
      trades: total, wins, losses,
      winRate: Math.round(winRate * 10) / 10,
      profitFactor: Math.round(Math.min(profitFactor, 99) * 100) / 100,
      totalReturn: Math.round(totalReturn * 100) / 100,
      avgTrade: Math.round((totalReturn / total) * 100) / 100,
      maxDrawdown: Math.round(maxDD * 100) / 100,
      equity: downsample(equity, 40),
      tradesList: tradesList.slice(-1000),
      daily: dm.daily,
      dailyOverall: dm.overall
    };
  }

  function downsample(arr, k) {
    if (!arr || !arr.length) return [];
    if (arr.length <= k) return arr.slice();
    const out = [];
    for (let i = 0; i < k; i++) out.push(arr[Math.floor(i * (arr.length - 1) / (k - 1))]);
    return out;
  }

  /* Format a rupee amount in Indian notation (1,23,456.78) with ₹ symbol. */
  function fmtINR(v) {
    const n = Number(v) || 0;
    const sign = n < 0 ? '-' : '';
    const abs = Math.abs(n);
    const fixed = abs.toFixed(2);
    const parts = fixed.split('.');
    let intPart = parts[0];
    let last3 = intPart.slice(-3);
    let rest = intPart.slice(0, -3);
    if (rest) last3 = ',' + last3;
    while (rest.length > 2) { last3 = ',' + rest.slice(-2) + last3; rest = rest.slice(0, -2); }
    if (rest) last3 = rest + last3;
    return 'Rs ' + sign + last3 + '.' + parts[1];
  }

  /* Dhan charges for one executed option order (leg) at the given premium and
     qty. Source: dhan.co/pricing (₹20 per executed order for options/futures) +
     statutory NSE charges. Buy (entry) leg carries stamp duty but NO STT; sell
     (exit) leg carries STT but NO stamp duty:
       - Brokerage            : ₹20 per executed order
       - STT (sell only)      : 0.1% of the sell-side premium
       - Exchange txn charge  : 0.03503% of the leg premium value (NSE options)
       - SEBI turnover fee    : 0.0001% of the leg value
       - Stamp duty (buy only): 0.003% of the buy-side value
       - IPFT contribution    : 0.0000001% of the leg value
       - GST                  : 18% on (brokerage + exchange + SEBI + IPFT) */
  function dhanEntryCharges(entry, qty) {
    const q = Math.max(1, Number(qty) || 1);
    const val = (Number(entry) || 0) * q;
    const brokerage = 20;
    const exchange = val * 0.0003503;
    const sebi = val * 0.000001;
    const stamp = val * 0.00003;
    const ipft = val * 0.000000001;
    const gst = 0.18 * (brokerage + exchange + sebi + ipft);
    return brokerage + exchange + sebi + stamp + ipft + gst;
  }
  function dhanExitCharges(exit, qty) {
    const q = Math.max(1, Number(qty) || 1);
    const val = (Number(exit) || 0) * q;
    const brokerage = 20;
    const stt = val * 0.001;
    const exchange = val * 0.0003503;
    const sebi = val * 0.000001;
    const ipft = val * 0.000000001;
    const gst = 0.18 * (brokerage + exchange + sebi + ipft);
    return brokerage + stt + exchange + sebi + ipft + gst;
  }
  function dhanTradeCharges(entry, exit, qty) {
    return dhanEntryCharges(entry, qty) + dhanExitCharges(exit, qty);
  }

  /* Per-trade broker charge split resolved from the universal settings: 'dhan'
     mode computes the real Dhan entry-leg and exit-leg charges from the trade's
     premiums and qty; 'custom' (or anything else) splits the flat rupee amount
     evenly across the two legs so the detail table can show both. */
  function brokerChargeSplit(opts, entry, exit, qty) {
    const u = opts || {};
    if (u.deductBrokerCharges !== true) return { entryRs: 0, exitRs: 0, totalRs: 0 };
    if (u.brokerChargeMode === 'dhan') {
      const entryRs = dhanEntryCharges(entry, qty);
      const exitRs = dhanExitCharges(exit, qty);
      return { entryRs: entryRs, exitRs: exitRs, totalRs: entryRs + exitRs };
    }
    const totalRs = Math.max(0, Number(u.brokerChargePerTrade) || 0);
    return { entryRs: totalRs / 2, exitRs: totalRs / 2, totalRs: totalRs };
  }

  /* Per-trade broker charge total (sum of entry + exit leg charges). */
  function brokerChargeForTrade(opts, entry, exit, qty) {
    return brokerChargeSplit(opts, entry, exit, qty).totalRs;
  }

  function scoreOf(m) {
    if (!m || m.trades < 3) return 0;
    const pfCapped = Math.min(m.profitFactor, 3);
    const retCapped = Math.min(Math.max(m.totalReturn, 0), 30);
    const s = m.winRate * 0.4 + (pfCapped / 3) * 100 * 0.35 + (retCapped / 30) * 100 * 0.25;
    return Math.round(s);
  }

  /* AI auto-timeframe decision. Scores a backtest outcome as a candidate
     timeframe for a (strategy x strike) pair, rewarding reliable positive
     returns (enough trades, high win rate, high profit factor) and penalising
     deep drawdowns. The engine backtests every timeframe, keeps the highest
     scoring one per strategy + strike, and tags the result with that timeframe
     so the same candidate is deployed + paper-traded on its best chart. */
  function aiTimeframeScore(m) {
    if (!m || m.trades < 2) return -Infinity;
    const ret = m.totalReturn || 0;
    const wr = m.winRate || 0;
    const pf = m.profitFactor || 0;
    const dd = m.maxDrawdown || 0;
    const trades = m.trades;
    const retTerm = ret > 0 ? Math.min(ret, 40) : Math.max(ret, -40);
    const wrTerm = wr * 0.4;
    const pfTerm = Math.min(pf, 4) * 8;
    const tradeTerm = Math.min(trades, 30) * 0.8;
    const ddPenalty = dd > 0 ? Math.min(dd, 60) * 0.6 : 0;
    return retTerm + wrTerm + pfTerm + tradeTerm - ddPenalty;
  }

  function verdict(score) {
    if (score >= 75) return 'Elite';
    if (score >= 60) return 'Good';
    if (score >= 45) return 'Moderate';
    return 'Weak';
  }

  /* ---------------- strategy construction ---------------- */
  function buildStrategy(tpl, symbol, tf) {
    const entry = JSON.parse(JSON.stringify(tpl.entry));
    const exit = JSON.parse(JSON.stringify(tpl.exit));
    const entryExtra = (tpl.entryExtra || []).map(c => JSON.parse(JSON.stringify(c)));
    const exitExtra = (tpl.exitExtra || []).map(c => JSON.parse(JSON.stringify(c)));
    const candlestick = tpl.candlestick
      ? { enabled: true, entry: (tpl.candlestick.entry || []).slice(), exit: (tpl.candlestick.exit || []).slice() }
      : { enabled: false, entry: [], exit: [] };
    return {
      id: 'ae-' + tpl.key + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: 'AE: ' + tpl.name,
      auto: true,
      aeKey: tpl.key,
      method: tpl.method,
      research: tpl.research,
      cat: tpl.cat || 'bullish',
      symbol: symbol ? JSON.parse(JSON.stringify(symbol)) : null,
      tf: tf || '5min',
      entry, exit,
      entryExtra, exitExtra,
      entryThreshold: (tpl.entryThreshold != null && tpl.entryThreshold >= 1) ? tpl.entryThreshold : null,
      candlestick,
      strike: state.strike ? JSON.parse(JSON.stringify(state.strike)) : { mode: 'both_atm', count: 3, optionType: 'both' },
      lot: { auto: false, basis: 'OI', pct: 1, manualQty: 1 },
      gate: { enabled: false, conds: [], patterns: [] },
      indexConfirmation: { enabled: false, indices: [], strategyId: null },
      createdAt: Date.now()
    };
  }

  /* Guarantee an auto-experimented strategy is 100% paper-engine-ready before
     it is deployed. The paper trading engine (and the AST engine it feeds) only
     runs strategies whose conditions are fully shaped and whose indicators are
     computable: every condition is normalized through cond() so all fields the
     engine reads exist (indId, indSettings, valueKey, logic, cmpType, cmpIndId,
     cmpSettings, cmpValueKey, candleKey, number, candlePatterns), every
     referenced indicator is verified against
     IndChart.IND, the candlestick block is normalized to {enabled, entry[],
     exit[]}, the timeframe pinned to a supported value and the strategy's side
     (cat) forced to match its option type (CE=bullish, PE=bearish) so the
     engine resolves and executes the same direction the backtest measured.
     Returns the normalized strategy, or null with a logged reason when a
     blocking problem is found. */
  function ensurePaperCompatible(strat) {
    if (!strat || typeof strat !== 'object') return null;
    const IND = (window.IndChart && window.IndChart.IND) || {};
    const known = (id) => !!(id && IND[id]);
    const normCond = (c) => {
      if (!c || typeof c !== 'object') return null;
      if (Array.isArray(c)) {
        const out = c.map(normCond).filter(Boolean);
        return out.length ? out : null;
      }
      const n = cond({
        indId: c.indId || '',
        indSettings: c.indSettings || {},
        valueKey: c.valueKey || 'v0',
        logic: c.logic || 'gt',
        cmpType: c.cmpType || 'number',
        cmpIndId: c.cmpType === 'indicator' ? (c.cmpIndId || '') : '',
        cmpSettings: c.cmpType === 'indicator' ? (c.cmpSettings || {}) : {},
        cmpValueKey: c.cmpType === 'indicator' ? (c.cmpValueKey || 'v0') : 'v0',
        candleKey: c.cmpType === 'candle' ? (c.candleKey || 'close') : 'close',
        number: c.cmpType === 'number' ? (c.number != null ? c.number : 0) : 0,
        candlePatterns: (c.cmpType === 'pattern' || c.cmpType === 'candlestick_pattern') ? (c.candlePatterns || []) : []
      });
      /* Preserve any builder/advanced fields (chain/gap/pane) a condition may
         carry so complex conditions survive the normalization untouched. */
      Object.keys(c).forEach(k => { if (n[k] === undefined && c[k] !== undefined) n[k] = c[k]; });
      return n;
    };
    /* A condition whose indicator is unknown to IndChart.IND can never compute
       a value, so the engine would silently block the strategy on "no signal".
       Return false so the deploy is refused with a clear log instead. */
    const checkCond = (c) => {
      if (!c) return true;
      if (Array.isArray(c)) return c.every(checkCond);
      if (c.cmpType === 'pattern' || c.cmpType === 'candlestick_pattern') return true;
      if (c.indId && !known(c.indId)) return false;
      if (c.cmpType === 'indicator' && c.cmpIndId && !known(c.cmpIndId)) return false;
      return true;
    };
    const entry = Array.isArray(strat.entry) ? strat.entry : [strat.entry];
    if (!entry.length || !entry[0] || !entry[0].indId || !known(entry[0].indId)) {
      log('Deploy blocked: strategy "' + (strat.name || '?') + '" entry indicator "' +
        ((entry[0] && entry[0].indId) || 'none') + '" is not computable by the paper engine', 'warn');
      return null;
    }
    for (const c of [strat.exit, strat.entryExtra, strat.exitExtra]) {
      if (c && !checkCond(c)) {
        log('Deploy blocked: strategy "' + (strat.name || '?') + '" references an unknown indicator - not paper-engine compatible', 'warn');
        return null;
      }
    }
    strat.entry = normCond(strat.entry);
    if (strat.exit) strat.exit = normCond(strat.exit);
    strat.entryExtra = normCond(strat.entryExtra) || [];
    strat.exitExtra = normCond(strat.exitExtra) || [];
    strat.candlestick = (strat.candlestick && typeof strat.candlestick === 'object')
      ? { enabled: !!strat.candlestick.enabled, entry: Array.isArray(strat.candlestick.entry) ? strat.candlestick.entry.slice() : [], exit: Array.isArray(strat.candlestick.exit) ? strat.candlestick.exit.slice() : [] }
      : { enabled: false, entry: [], exit: [] };
    if (strat.entryThreshold != null && !(Number(strat.entryThreshold) >= 1)) strat.entryThreshold = null;
    if (ALL_TIMEFRAMES.indexOf(strat.tf) < 0 && strat.tf !== 'hourly' && strat.tf !== 'daily') strat.tf = '5min';
    if (strat.autoSlPct == null || !(Number(strat.autoSlPct) > 0)) strat.autoSlPct = autoSLPct([]);
    if (strat.optionType === 'CE') strat.cat = 'bullish';
    else if (strat.optionType === 'PE') strat.cat = 'bearish';
    if (strat.optionStrike != null) {
      strat.strike = strat.strike && typeof strat.strike === 'object' ? strat.strike : {};
      strat.strike.optionType = strat.optionType || strat.strike.optionType || 'both';
    }
    return strat;
  }

  /* ---------------- persistence ---------------- */
  function defaultState() {
    return {
      enabled: false,
      runManual: false,
      universal: { lotSize: null, lots: 1, margin: 100000, tpPct: 1, manualTrail: true, aiSl: true, aiTp: true, manualSL: false, manualSLPct: 1, manualTrailTP: false, manualTrailTPPct: 20, manualTP: false, manualTPPct: 5, aiTP: false, fnoLimit: true, tfs: { '1min': true, '5min': true }, aiTimeframe: false, backtestDays: 180, tradeLimitEnabled: false, tradeLimitCount: 5, tradeLimitDaily: false, aiTrades: false, deductBrokerCharges: false, brokerChargeMode: 'dhan', brokerChargePerTrade: 20, dailyBacktest: false, dailyBacktestDays: 30, rrEnabled: false, rrValue: 2, startTradeAfterEnabled: false, startTradeAfter: '09:15', noTradeAfterEnabled: false, noTradeAfter: '15:30', autoSquareOffEnabled: false, autoSquareOffTime: '15:20', indLimitEnabled: false, indLimit: 4 },
      strike: { mode: 'both_atm', count: 3, optionType: 'both', positiveOnly: true },
      runIn: { index: 'both', fno: 'spot', comm: 'spot', default: false }, // chart the strategy run + trade execution runs on: 'spot', 'premium' or 'both'
      tradeIn: { index: 'premium', fno: 'premium', comm: 'spot', default: false }, // chart the trade execution is done on: 'spot' or 'premium'
      premiumOnly: false, // when ON the strategy run AND trade execution both lock to the option premium chart for every instrument type
      groups: GROUP_KEYS.slice(), // enabled research-stream checkboxes
      symbols: [],       // selected symbol/instrument list for experiment + paper trading
      movers: { enabled: false, gainers: 5, losers: 5, indices: [] }, // daily top gainers/losers + selected indices auto experiment
      niftyTrend: { enabled: false, pct: 2.5, includeIndices: false, indices: [] }, // NIFTY trend-following F&O picker (directional gainers/losers above a daily change% threshold + optional indices)
      commodity: { enabled: false, sids: [] }, // MCX commodity futures backtest: runs on each +Add-ed FUTCOM contract directly (spot mode), alongside stocks/F&O
      autoSend: { enabled: false, tpls: [] }, // auto strategy sender: experiment runs only the user-selected saved templates and auto-sends the created strategies to the paper trade engine
      showPickedStrikes: false,
      groupByStrategy: true, // group results by strategy (one card per strategy across all backtested symbols)
      filters: { bullish: false, bearish: false, incUp: false, incDown: false, gapUp: false, gapDown: false, incUpAll: false, incDownAll: false, crossUp: false, crossDown: false, gtUp: false, ltUp: false, gtDown: false, ltDown: false, paneCrossUp: false, paneCrossDown: false, paneIncUpAll: false, paneIncDownAll: false, bullVolUp: false, bullVolDown: false, bullFakeBreakout: false, bullReversal: false, bearVolUp: false, bearVolDown: false, bearFakeBreakout: false, bearReversal: false, bullBbwInc: false, bearBbwInc: false, bullBbCrossBelow: false, bullBbCrossAbove: false, bullPcCrossBelow: false, bullPcCrossAbove: false, bearBbCrossBelow: false, bearBbCrossAbove: false, bearPcCrossBelow: false, bearPcCrossAbove: false, bullSmf: false, bearSmf: false, bullVl: false, bearVl: false, bullAsr: false, bearAsr: false, bullCandle: false, bullElliott: false, bullIndicator: false, bullPane: false, bullSymmetry: false, bullStructure: false, bullAtr: false, bearCandle: false, bearElliott: false, bearIndicator: false, bearPane: false, bearSymmetry: false, bearStructure: false, bearAtr: false }, // Bullish/Bearish section masters + trend/cross/volume/fake-breakout/reversal/pane gates + per-side research-stream scopes
      niftyEntry: { enabled: false, dir: 'bullish', zone: 'above_upper' }, // trade-entry NIFTY condition (execute only when NIFTY matches)
      niftyExit: { enabled: false, dir: 'bearish', zone: 'below_lower' }, // trade-exit NIFTY condition (cut the trade when NIFTY matches)
      results: [],
      lastRun: null,
      lastResearchAt: null,
      runProgress: {}       // aeId -> { pct, status, updated } live per-tick pipeline progress
    };
  }

  let state = load();

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(AE_KEY) || 'null');
      if (s) return sanitizeState(Object.assign(defaultState(), s));
    } catch (e) {}
    return defaultState();
  }
  function sanitizeState(s) {
    const VALID_MODES = ['above', 'below', 'both_atm', 'above_atm', 'below_atm', 'both_atm_inc', 'atm'];
    const VALID_TYPES = ['both', 'CE', 'PE'];
    if (s && s.strike) {
      if (VALID_MODES.indexOf(s.strike.mode) < 0) s.strike.mode = 'both_atm';
      if (VALID_TYPES.indexOf(s.strike.optionType) < 0) s.strike.optionType = 'both';
      if (typeof s.strike.positiveOnly !== 'boolean') s.strike.positiveOnly = true;
    }
    if (s && s.runIn) {
      // Both dropdowns accept 'spot' (underlying chart), 'premium' (option
      // premium chart) or 'both' (spot + premium). Indices default to 'both',
      // F&O stocks default to 'spot'. Commodities default to the futures
      // contract ('spot') but honour their own dropdown.
      const OK = ['spot', 'premium', 'both'];
      if (OK.indexOf(s.runIn.index) < 0) s.runIn.index = 'both';
      if (OK.indexOf(s.runIn.fno) < 0) s.runIn.fno = 'spot';
      if (OK.indexOf(s.runIn.comm) < 0) s.runIn.comm = 'spot';
      if (typeof s.runIn.default !== 'boolean') s.runIn.default = false;
    } else if (s) {
      s.runIn = { index: 'both', fno: 'spot', comm: 'spot', default: false };
    }
    if (s && s.tradeIn) {
      // Backtest trades always execute on the selected-strike option premium
      // chart for both indices and F&O stocks - never on the spot chart.
      // Commodities default to the futures contract ('spot') but honour their
      // own dropdown.
      s.tradeIn.index = 'premium';
      s.tradeIn.fno = 'premium';
      if (['spot', 'premium', 'both'].indexOf(s.tradeIn.comm) < 0) s.tradeIn.comm = 'spot';
      if (typeof s.tradeIn.default !== 'boolean') s.tradeIn.default = false;
    } else if (s) {
      s.tradeIn = { index: 'premium', fno: 'premium', comm: 'spot', default: false };
    }
    if (s && typeof s.premiumOnly !== 'boolean') s.premiumOnly = false;
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
      if (typeof s.universal.manualTrailTP !== 'boolean') s.universal.manualTrailTP = false;
      if (!Number.isFinite(Number(s.universal.manualTrailTPPct)) || Number(s.universal.manualTrailTPPct) <= 0) s.universal.manualTrailTPPct = 20;
      if (typeof s.universal.manualTP !== 'boolean') s.universal.manualTP = false;
      if (!Number.isFinite(Number(s.universal.manualTPPct)) || Number(s.universal.manualTPPct) <= 0) s.universal.manualTPPct = 5;
      if (typeof s.universal.aiTP !== 'boolean') s.universal.aiTP = false;
      if (typeof s.universal.fnoLimit !== 'boolean') s.universal.fnoLimit = true;
      if (typeof s.universal.indLimitEnabled !== 'boolean') s.universal.indLimitEnabled = false;
      if (!Number.isFinite(Number(s.universal.indLimit)) || Number(s.universal.indLimit) <= 0) s.universal.indLimit = 4;
      if (!s.universal.tfs || typeof s.universal.tfs !== 'object') s.universal.tfs = { '1min': true, '5min': true };
      if (s.universal.backtestDays == null) s.universal.backtestDays = 180;
      if (!Number.isFinite(Number(s.universal.backtestDays)) || Number(s.universal.backtestDays) <= 0) s.universal.backtestDays = 180;
      if (typeof s.universal.tfs['1min'] !== 'boolean') s.universal.tfs['1min'] = true;
      if (typeof s.universal.tfs['5min'] !== 'boolean') s.universal.tfs['5min'] = true;
      if (typeof s.universal.aiTimeframe !== 'boolean') s.universal.aiTimeframe = false;
      if (typeof s.universal.tradeLimitEnabled !== 'boolean') s.universal.tradeLimitEnabled = false;
      if (!Number.isFinite(Number(s.universal.tradeLimitCount)) || Number(s.universal.tradeLimitCount) <= 0) s.universal.tradeLimitCount = 5;
      if (typeof s.universal.tradeLimitDaily !== 'boolean') s.universal.tradeLimitDaily = false;
      if (typeof s.universal.dailyBacktest !== 'boolean') s.universal.dailyBacktest = false;
      if (!Number.isFinite(Number(s.universal.dailyBacktestDays)) || Number(s.universal.dailyBacktestDays) <= 0) s.universal.dailyBacktestDays = 30;
      if (typeof s.universal.rrEnabled !== 'boolean') s.universal.rrEnabled = false;
      if (!Number.isFinite(Number(s.universal.rrValue)) || Number(s.universal.rrValue) <= 0) s.universal.rrValue = 2;
      if (typeof s.universal.aiTrades !== 'boolean') s.universal.aiTrades = false;
      if (typeof s.universal.deductBrokerCharges !== 'boolean') s.universal.deductBrokerCharges = false;
      if (s.universal.brokerChargeMode !== 'dhan' && s.universal.brokerChargeMode !== 'custom') s.universal.brokerChargeMode = 'dhan';
      if (!Number.isFinite(Number(s.universal.brokerChargePerTrade)) || Number(s.universal.brokerChargePerTrade) < 0) s.universal.brokerChargePerTrade = 20;
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
    if (s && s.autoSend) {
      if (typeof s.autoSend.enabled !== 'boolean') s.autoSend.enabled = false;
      if (!Array.isArray(s.autoSend.tpls)) s.autoSend.tpls = [];
    } else if (s) {
      s.autoSend = { enabled: false, tpls: [] };
    }
    if (s && s.filters) {
      ['bullish', 'bearish', 'incUp', 'incDown', 'gapUp', 'gapDown', 'incUpAll', 'incDownAll', 'crossUp', 'crossDown', 'gtUp', 'ltUp', 'gtDown', 'ltDown'].concat(FILTER_EXTRA_KEYS, STREAM_FLAG_KEYS).forEach(k => {
        if (typeof s.filters[k] !== 'boolean') s.filters[k] = false;
      });
    }
    if (s) {
      const normGate = (g, dDir, dZone) => {
        const out = { enabled: false, dir: dDir, zone: dZone };
        if (g && typeof g === 'object') {
          if (typeof g.enabled === 'boolean') out.enabled = g.enabled;
          out.dir = (g.dir === 'bearish' || g.dir === 'bullish') ? g.dir : dDir;
          if (['overbought', 'oversold', 'above_upper', 'upper_half', 'lower_half', 'below_lower', 'inc_up', 'inc_down'].indexOf(g.zone) >= 0) out.zone = g.zone;
        }
        return out;
      };
      s.niftyEntry = normGate(s.niftyEntry || s.niftyBias, 'bullish', 'above_upper');
      s.niftyExit = normGate(s.niftyExit, 'bearish', 'below_lower');
      delete s.niftyBias;
    }
    /* Drop duplicate result cards persisted from earlier versions / runs so the
       created-strategies list never shows the same strategy twice. */
    if (s && Array.isArray(s.results) && s.results.length) {
      s.results = dedupeResults(s.results);
    }
    return s;
  }
  function save() {
    try {
      localStorage.setItem(AE_KEY, JSON.stringify({
        enabled: state.enabled, runManual: state.runManual,
        universal: state.universal, strike: state.strike, runIn: state.runIn, tradeIn: state.tradeIn, premiumOnly: state.premiumOnly, groups: state.groups, symbols: state.symbols,
        movers: state.movers, filters: state.filters, results: state.results, lastRun: state.lastRun,
        lastResearchAt: state.lastResearchAt, niftyEntry: state.niftyEntry, niftyExit: state.niftyExit, niftyTrend: state.niftyTrend, showPickedStrikes: state.showPickedStrikes,
        autoSend: state.autoSend, groupByStrategy: !!state.groupByStrategy
      }));
    } catch (e) {}
  }

  function loadManualStrategies() {
    try { return JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'); } catch (e) { return []; }
  }

  /* Refresh the research knowledge base from the server so the "researched
     from" trail stays auditable and centralized. The hardcoded RESEARCH list
     remains the deterministic fallback when the endpoint is unreachable.
     When the server surfaces new research sources, the template set is
     regenerated and (if the auto engine is enabled) the experiment re-runs to
     fold the fresh research into newly tested strategies. */
  let _researchTimer = null;
  async function loadResearch() {
    try {
      const res = await fetch('/api/auto_research', { cache: 'no-store' });
      const j = await res.json();
      if (j && j.status === 'success' && Array.isArray(j.data) && j.data.length) {
        let changed = false;
        j.data.forEach(x => { if (x && x.method && _researchMap[x.method] !== x.source) { _researchMap[x.method] = x.source; changed = true; } });
        for (const r of state.results) {
          if (_researchMap[r.method] && _researchMap[r.method] !== r.research) { r.research = _researchMap[r.method]; changed = true; }
        }
        if (changed) {
          _templateCache = null;
          save();
          render();
          if (state.enabled) { runExperiment(); }
          else { log('Research updated — press Run Experiment to rescan', 'ok'); }
        }
        if (j.updated_at && j.updated_at !== state.lastResearchAt) {
          state.lastResearchAt = j.updated_at;
          save();
          log('Research knowledge base refreshed (' + j.data.length + ' methods)', '');
        }
      }
    } catch (e) { /* offline / endpoint unavailable: keep defaults */ }
  }

  /* Keep the research trail continuously fresh: poll the server on a long
     cadence so operator-configured research feeds flow in without any manual
     reload. Signal evaluation stays deterministic between refreshes. */
  function startResearchPoll() {
    if (_researchTimer) clearInterval(_researchTimer);
    _researchTimer = setInterval(() => { loadResearch(); }, 30 * 60 * 1000);
  }
  function stopResearchPoll() {
    if (_researchTimer) { clearInterval(_researchTimer); _researchTimer = null; }
  }

  /* ---------------- experiment runner ---------------- */
  /* Daily top gainers / top losers + the selected indices, computed from the
     live quotes cache. The user picks how many of each with a numeric field
     and chooses which indices to include; when the top-movers toggle is on
     these are merged into the experiment symbol set so auto experiments (and
     paper trading) run on them automatically. */
  function topMoverSymbols() {
    const mv = state.movers || {};
    if (!mv.enabled) return [];
    const qm = (typeof clientQuotes !== 'undefined' && clientQuotes) ? clientQuotes : {};
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
    const cmp = (a, b) => b.pct - a.pct;
    gainers.sort(cmp);
    losers.sort(cmp);
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
    gainers.slice(0, wantG).forEach(x => push(x.s));
    /* Biggest losers first: ascending by % change (most negative on top). */
    losers.sort((a, b) => a.pct - b.pct).slice(0, wantL).forEach(x => push(x.s));
    const wantIdx = Array.isArray(mv.indices) ? mv.indices : [];
    wantIdx.forEach(s => push(s));
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
    const qm = (typeof clientQuotes !== 'undefined' && clientQuotes) ? clientQuotes : {};
    const q = qm[symbol.exch === 'IDX_I' ? 'IDX_I:' + symbol.id : String(symbol.id)];
    if (!q || q.change_pct === undefined) return null;
    const pct = Number(q.change_pct);
    if (isNaN(pct)) return null;
    return pct >= 0 ? 'bullish' : 'bearish';
  }

  function experimentSymbols(niftyDir) {
    const mv = state.movers || {};
    const nt = state.niftyTrend || {};
    /* MCX commodity futures are NOT exclusive with the stock/F&O universes: the
       +Add-ed commodities (backtested directly on the FUTCOM contract in spot
       mode) are ADDED to whatever the movers / NIFTY trend-following / manual
       symbol selection produces, so commodities can be traded alongside stocks
       and F&O at the same time. */
    const out = [];
    if (state.commodity && state.commodity.enabled) out.push.apply(out, commoditySymbols());
    if (nt.enabled) {
      // NIFTY trend-following mode: the universe is rebuilt from the live
      // NIFTY trend - bullish NIFTY -> top-gainer F&O stocks above the daily
      // change% threshold, bearish NIFTY -> top-loser F&O stocks below the
      // negative threshold (plus the user-selected indices when enabled).
      out.push.apply(out, pruneNiftyTrendSymbols(niftyTrendSymbols(niftyDir || _lastNiftyDir), niftyDir || _lastNiftyDir));
    } else if (mv.enabled) {
      // Top Movers mode: the experiment (and paper trading) runs on EVERY
      // fetched top gainer + top loser F&O stock plus the selected indices -
      // never on the manual symbol list or a random chart fallback. No CE/PE
      // direction drop here: the leg is picked by the option-type selector and
      // applied at the chart level (CE = call charts only, PE = put charts
      // only), so all top gainers/losers are analysed regardless of direction.
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
     `[name, sid, "MCX_COMM", "FUTCOM", sid, "MCX_COMM", "Commodities (MCX)"]`. */
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

  /* The commodities the experiment runs on when commodity mode is ON: one symbol
     per sid in state.commodity.sids (the user's +Add-ed list). Contract ids roll
     over every expiry, so an expired id is dropped silently instead of breaking
     the run. */
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

  /* ---- NIFTY trend-following F&O picker ----
     "Trade following NIFTY movement & trend": when enabled, the engine only
     paper-trades F&O stocks whose DAILY % change is ABOVE the configured
     threshold, taken from the side the live NIFTY trend points at:
       - NIFTY bullish -> top-gainer F&O stocks with daily change_pct >= pct
       - NIFTY bearish -> top-loser F&O stocks with daily change_pct <= -pct
       - NIFTY unknown/consolidation -> nothing picked (no directional bias)
     The "Include indices for trading" flag appends the chosen indices (NIFTY,
     SENSEX, MIDCPNIFTY, BANKNIFTY, FINNIFTY) alongside the F&O stocks so they
     are traded regardless of the change% threshold. Change% comes straight
     from the live client quote cache (clientQuotes[*].change_pct). */
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
    const el = $id('aeNiftyTrendIndicesSelect');
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
    const el = $id('aeNiftyTrendIndicesSelect');
    if (!el || !el.value) { log('Select an index to add', 'warn'); return; }
    let it;
    try { it = JSON.parse(el.value); } catch (e) { return; }
    if (!state.niftyTrend) state.niftyTrend = { enabled: false, pct: 2.5, includeIndices: false, indices: [] };
    if (!Array.isArray(state.niftyTrend.indices)) state.niftyTrend.indices = [];
    const exists = state.niftyTrend.indices.some(s => String(s.id) === String(it.id) && String(s.exch || '') === String(it.exch || ''));
    if (!exists) {
      state.niftyTrend.indices.push(it);
      save();
      _resetTrendScan();
      renderNiftyTrendIndicesList();
      log('Added index ' + displayName(it) + ' to NIFTY trend-following trading', 'ok');
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
    const el = $id('aeNiftyTrendIndicesList');
    if (!el) return;
    const nt = state.niftyTrend || {};
    const idx = Array.isArray(nt.indices) ? nt.indices : [];
    el.innerHTML = idx.map(s =>
      '<span style="background:#1a1a35;border:1px solid #2d2d50;border-radius:3px;padding:2px 6px;display:inline-flex;align-items:center;gap:4px">' + displayName(s) +
      ' <a href="javascript:void(0)" style="color:#ef5350;text-decoration:none;font-weight:700" onclick="AutoExperiment.removeNiftyTrendIndex(' + Number(s.id) + ', \'' + (s.exch || 'IDX_I') + '\')">&times;</a></span>'
    ).join('');
  }

  function readNiftyTrendUI() {
    const onEl = $id('aeNiftyTrendEnabled'), pctEl = $id('aeNiftyTrendPct'), incEl = $id('aeNiftyTrendIndices');
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
    ck('aeNiftyTrendEnabled', nt.enabled);
    ck('aeNiftyTrendIndices', nt.includeIndices);
    set('aeNiftyTrendPct', nt.pct);
    const btn = $id('aeNiftyTrendToggle');
    if (btn) {
      btn.textContent = 'Trend Follow: ' + (nt.enabled ? 'ON' : 'OFF');
      btn.style.background = nt.enabled ? '#00d4aa' : '#e67e22';
    }
    populateNiftyTrendIndicesUI();
    renderNiftyTrendIndicesList();
    const on = !!nt.enabled;
    const active = on;
    ['aeNiftyTrendPct', 'aeNiftyTrendIndices', 'aeNiftyTrendIndicesSelect', 'aeNiftyTrendIndicesAdd'].forEach(id => {
      const el = $id(id);
      if (el) { el.disabled = !active; el.style.opacity = active ? '1' : '0.5'; }
    });
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
    save();
    _resetTrendScan();
    applyNiftyTrendToUI();
    applyMoversToUI();
    applyCommodityToUI();
    log('NIFTY trend-following trading ' + (state.niftyTrend.enabled ? 'enabled' : 'disabled'), state.niftyTrend.enabled ? 'ok' : 'warn');
  }

  /* Live preview of the symbols the NIFTY trend-following mode would pick right
     now (trend + qualifying F&O stocks above the threshold + included indices),
     refreshed every poll tick alongside the movers list. */
  function renderNiftyTrendList() {
    const host = $id('aeNiftyTrendList');
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
      host.innerHTML = '<div style="color:#888;font-size:9px;margin-bottom:2px">NIFTY trend unknown yet (waiting for the live feed) - no directional F&O stocks picked.</div>';
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

  /* ---------------- Auto strategy sender to paper trade engine ----------------
     Master checkbox: when ON the Auto Experiment runs ONLY the user-selected
     saved engine templates (picked from the dropdown, one chip per added
     template with a remove button) and automatically sends every strategy it
     creates to the Paper Trade engine once the run completes. Each selected
     engine template applies its own saved settings (mode / strike / groups /
     filters / universal) while the research-template sweep runs, so the union
     of every selected template's sweep becomes the experiment results. */
  function readAutoSendUI() {
    const onEl = $id('aeAutoSend');
    if (!state.autoSend) state.autoSend = { enabled: false, tpls: [] };
    state.autoSend.enabled = onEl ? onEl.checked : false;
    save();
  }

  function applyAutoSendToUI() {
    const as = state.autoSend || (state.autoSend = { enabled: false, tpls: [] });
    if (!Array.isArray(as.tpls)) as.tpls = [];
    const ck = $id('aeAutoSend');
    if (ck) ck.checked = !!as.enabled;
    const on = !!as.enabled;
    ['aeAutoSendTplSelect', 'aeAutoSendTplAdd'].forEach(id => {
      const el = $id(id);
      if (el) { el.disabled = !on; el.style.opacity = on ? '1' : '0.5'; }
    });
    populateAutoSendTplUI();
    renderAutoSendTplList();
  }

  function toggleAutoSend() {
    if (!state.autoSend) state.autoSend = { enabled: false, tpls: [] };
    state.autoSend.enabled = !state.autoSend.enabled;
    save();
    applyAutoSendToUI();
    log('Auto strategy sender to paper trade engine ' + (state.autoSend.enabled ? 'enabled' : 'disabled'), state.autoSend.enabled ? 'ok' : 'warn');
  }

  /* Saved engine templates (the AE "Save Template" presets) are what this mode
     runs: each template carries a full engine-settings snapshot, so running it
     applies those settings and sweeps the research templates under that
     configuration. The dropdown lists them so the user can add any number; each
     added template gets a remove chip. */
  function autoSendTplOptions() {
    const list = tplLoad();
    const have = {};
    (state.autoSend && Array.isArray(state.autoSend.tpls) ? state.autoSend.tpls : []).forEach(t => { have[String(t.id)] = true; });
    return list.filter(t => t && t.id && t.settings && !have[String(t.id)]);
  }

  function populateAutoSendTplUI() {
    const el = $id('aeAutoSendTplSelect');
    if (!el) return;
    const opts = autoSendTplOptions();
    const sel = el.value;
    const html = '<option value="">-- choose a saved engine template --</option>' + opts.map(t =>
      '<option value="' + esc(String(t.id)) + '" data-cat="' + esc(t.mode || 'bullish') + '">' + esc(t.name || 'Untitled') +
      ' (' + esc(t.mode || 'bullish') + ')</option>').join('');
    /* Only rewrite when the option set changed so a poll tick never disturbs
       the selection the user is about to add. */
    if (el.innerHTML !== html) {
      el.innerHTML = html;
      if (sel) el.value = sel;
    }
  }

  function addAutoSendTpl() {
    const el = $id('aeAutoSendTplSelect');
    if (!el || !el.value) { log('Select a saved engine template to add', 'warn'); return; }
    const id = el.value;
    const opt = el.options[el.selectedIndex];
    const mode = opt ? (opt.dataset.cat || 'bullish') : 'bullish';
    const name = opt ? opt.textContent.replace(/\s*\((bullish|bearish|sideways)\)\s*$/, '') : id;
    if (!state.autoSend) state.autoSend = { enabled: false, tpls: [] };
    if (!Array.isArray(state.autoSend.tpls)) state.autoSend.tpls = [];
    const exists = state.autoSend.tpls.some(t => String(t.id) === String(id));
    if (!exists) {
      state.autoSend.tpls.push({ id: String(id), name: String(name), cat: String(mode) });
      save();
      applyAutoSendToUI();
      log('Added engine template "' + name + '" to auto strategy sender', 'ok');
      if (state.autoSend.enabled) runExperiment();
    }
  }

  function removeAutoSendTpl(id) {
    if (!state.autoSend) return;
    state.autoSend.tpls = (state.autoSend.tpls || []).filter(t => String(t.id) !== String(id));
    save();
    applyAutoSendToUI();
    if (state.autoSend.enabled && selectedEngineTemplates().length) runExperiment();
  }

  function renderAutoSendTplList() {
    const el = $id('aeAutoSendTplList');
    if (!el) return;
    const tpls = (state.autoSend && Array.isArray(state.autoSend.tpls)) ? state.autoSend.tpls : [];
    el.style.display = tpls.length ? '' : 'none';
    el.innerHTML = tpls.map(t =>
      '<span style="background:#1a1a35;border:1px solid #2d2d50;border-radius:3px;padding:2px 6px;display:inline-flex;align-items:center;gap:4px">' +
      '<span style="color:' + (t.cat === 'bullish' ? '#00d4aa' : (t.cat === 'bearish' ? '#ef5350' : '#b39ddb')) + '">' + esc(t.name || t.id) + '</span>' +
      ' <a href="javascript:void(0)" style="color:#ef5350;text-decoration:none;font-weight:700" onclick="AutoExperiment.removeAutoSendTpl(\'' + esc(String(t.id)) + '\')">&times;</a></span>'
    ).join('');
  }

  /* The engine templates behind the selected template chips, in the order they
     were added. Templates without a settings snapshot are skipped. */
  function selectedEngineTemplates() {
    const as = state.autoSend || {};
    const want = [];
    (Array.isArray(as.tpls) ? as.tpls : []).forEach(t => { if (t && t.id) want.push(String(t.id)); });
    const all = tplLoad();
    return want.map(id => all.find(t => t && String(t.id) === id)).filter(t => !!t && !!t.settings);
  }

  /* Apply an engine-settings snapshot to state WITHOUT the save()/render()/log()
     side effects applyEngineSettings() triggers - used to scope an experiment
     run per selected template. Mutates the shared state.universal object
     in-place (Object.assign), so the captured `opts` reference used by the
     backtest helpers sees each template's universal settings too. */
  function applyEngineSettingsSilent(s) {
    if (!s) return;
    if (s.universal) state.universal = Object.assign(state.universal || {}, JSON.parse(JSON.stringify(s.universal)));
    if (s.strike) state.strike = Object.assign(state.strike || {}, JSON.parse(JSON.stringify(s.strike)));
    if (s.runIn) state.runIn = Object.assign(state.runIn || {}, JSON.parse(JSON.stringify(s.runIn)));
    if (s.tradeIn) state.tradeIn = Object.assign(state.tradeIn || {}, JSON.parse(JSON.stringify(s.tradeIn)));
    if (typeof s.premiumOnly === 'boolean') state.premiumOnly = s.premiumOnly;
    if (Array.isArray(s.groups) && s.groups.length) state.groups = s.groups.slice();
    if (s.filters) state.filters = Object.assign(state.filters || {}, JSON.parse(JSON.stringify(s.filters)));
    if (s.movers) state.movers = Object.assign(state.movers || {}, JSON.parse(JSON.stringify(s.movers)));
    if (s.niftyTrend) state.niftyTrend = Object.assign(state.niftyTrend || {}, JSON.parse(JSON.stringify(s.niftyTrend)));
    if (s.niftyEntry) state.niftyEntry = Object.assign(state.niftyEntry || {}, JSON.parse(JSON.stringify(s.niftyEntry)));
    if (s.niftyExit) state.niftyExit = Object.assign(state.niftyExit || {}, JSON.parse(JSON.stringify(s.niftyExit)));
    if (s.niftyTf && (s.niftyTf === '1min' || s.niftyTf === '5min' || s.niftyTf === 'both')) _niftyTf = s.niftyTf;
  }

  /* ---- NIFTY market-bias gate (F&O stocks only) ----
     Optional execution condition: when enabled, F&O stock trades only execute
     when the NIFTY 50 5min trend direction AND its Bollinger %B zone match the
     user's selection. When NIFTY is bullish only top-gainer F&O stocks trade;
     when bearish only top-loser F&O stocks trade. Indices are never restricted
     by this gate. NIFTY candles are cached for 60s to stay within rate limits. */
  const NIFTY_IDX = { id: 13, exch: 'IDX_I', inst: 'INDEX', name: 'NIFTY 50' };
  /* Extra trend-confirmation indices used by the NIFTY ensemble: GIFT NIFTY
     (overnight/global NIFTY lead, voted like NIFTY itself) and INDIA VIX (fear
     gauge - a rising VIX adds bearish pressure, a falling VIX adds bullish
     pressure). Both are optional: if their candles are unavailable the trend
     falls back to NIFTY 50 alone. */
  const GIFT_NIFTY_IDX = { id: 5024, exch: 'IDX_I', inst: 'INDEX', name: 'GIFT NIFTY' };
  const INDIA_VIX_IDX = { id: 21, exch: 'IDX_I', inst: 'INDEX', name: 'INDIA VIX' };
  const NIFTY_ZONE_LABEL = { overbought: 'Overbought', oversold: 'Oversold', above_upper: 'Above upper band', upper_half: 'Upper half', lower_half: 'Lower half', below_lower: 'Below lower band', inc_up: 'Increasing upward', inc_down: 'Increasing downward' };
  const _NIFTY_TF_KEY = 'algodhan_ae_nifty_tf' + suffix;
  const _NIFTY_TF = (function () { const v = localStorage.getItem(_NIFTY_TF_KEY); return (v === '1min' || v === '5min' || v === 'both') ? v : '5min'; })();
  let _niftyTf = _NIFTY_TF;
  const _niftyBiasCache = {};
  /* Most recent NIFTY trend direction observed by this engine (updated by
     the poll tick / runExperiment). Drives the NIFTY trend-following symbol picker
     without re-fetching candles inside the synchronous symbol-selection path. */
  let _lastNiftyDir = null;
  /* NIFTY trend-following scan throttle: the full F&O universe scan (picking
     top gainers/losers above the daily change% threshold) runs at most once a
     minute; in between, the per-tick prune removes any stock that drops below
     the threshold immediately so it stops being traded without waiting for the
     next full scan. */
  let _trendScanAt = 0;
  let _trendScanDir = null;
  let _trendScanCache = null;

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

  /* BB%B extreme-reversal state for the inc_up / inc_down NIFTY gates.
     inc_up fires when the %B line has touched the SESSION's (today's) oversold
     low and has since turned upward - a rebound off the day's oversold extreme.
     inc_down is the mirror image off the session's overbought high. Unlike the
     plain 1-bar slope, this only holds while the move genuinely started at a
     daily extreme and is still within a fresh bounce window, so a %B line
     drifting up in the middle of its day range never trips the gate. */
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
     session low) state. The returned low/high are the support/resistance lines
     the trade-entry / trade-exit gates compare against. */
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
    return { dir, confidence, strength, reversal, reversalDir, zone: bb.zone, pctb: bb.pctb, close: bb.close, bbSlope: niftyBbSlope(candles), bbIncUp: er.inc_up, bbIncDown: er.inc_down };
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
        bias = { dir: ta.dir, confidence: ta.confidence, strength: ta.strength, reversal: ta.reversal, reversalDir: ta.reversalDir, zone: ta.zone, pctb: ta.pctb, close: ta.close, bbSlope: ta.bbSlope, bbIncUp: ta.bbIncUp, bbIncDown: ta.bbIncDown, sessLow: range.low, sessHigh: range.high, overbought: over.overbought, oversold: over.oversold, mixed: false, tf: t, at: now };
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

  /* BB%B gate matching. Overbought / Oversold compare %B against the session
     support/resistance range (session BB%B high/low); the classic band zones
     map to the standard %B thresholds. */
  function niftyZoneAllowed(nifty, zone) {
    if (!nifty || !zone) return true;
    if (zone === 'overbought') return !!nifty.overbought;
    if (zone === 'oversold') return !!nifty.oversold;
    if (zone === 'inc_up') return !!nifty.bbIncUp;
    if (zone === 'inc_down') return !!nifty.bbIncDown;
    return nifty.zone === zone;
  }

  /* NIFTY gate decision: shared by the trade-entry and trade-exit gates. The
     NIFTY ensemble trend is always evaluated on the engine's single timeframe
     (_niftyTf). A gate only fires when it is enabled AND the trend matches the
     chosen direction AND its BB%B state. */
  async function niftyGateMet(g) {
    const gate = g || {};
    if (!gate.enabled) return false;
    const nifty = await niftyBias(_niftyTf);
    return !!(nifty && nifty.dir && nifty.dir === gate.dir && niftyZoneAllowed(nifty, gate.zone));
  }

  /* Beyond the NIFTY exit gate above, signal exits are disabled: open legs are
     only closed by the trailing take-profit / take-profit protections in
     checkAutoTargetSl (or by the NIFTY exit gate / a manual Stop/Close). */

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
    return '<span style="color:' + (bias.dir === 'bullish' ? '#00d4aa' : '#ef5350') + '">NIFTY ' + (bias.dir === 'bullish' ? 'Bullish' : 'Bearish') +
      ' &middot; conf ' + conf + '% (' + (bias.strength || '') + ')' + rev + mix + gvTxt +
      ' &middot; %B ' + (bias.pctb != null ? bias.pctb.toFixed(2) : '?') + ' (' + (NIFTY_ZONE_LABEL[bias.zone] || bias.zone) + ')' + ob + inc + sr + '</span>';
  }

  async function updateNiftyBiasStatus(bias) {
    const sum = _niftySummary(bias);
    const sumEl = $id('aeNiftyStatus');
    if (sumEl) sumEl.innerHTML = sum || '<span style="color:#666">waiting for NIFTY ' + _niftyTf + ' data&hellip;</span>';
    const tfTxt = (t) => (t === 'both' ? '1m+5m' : t);
    const paint = async (id, gate, label, action) => {
      const el = $id(id);
      if (!el) return;
      let html = '';
      if (gate.enabled) {
        const gb = await niftyBias(_niftyTf);
        if (!gb) html = '<span style="color:#ff9800">' + label + ': no data</span>';
        else {
          const ok = gb.dir === gate.dir && niftyZoneAllowed(gb, gate.zone);
          html = '<span style="color:' + (ok ? '#00d4aa' : '#888') + '">' + label + ' [' + tfTxt(_niftyTf) + ' ' + (gate.dir === 'bullish' ? 'Bullish' : 'Bearish') + ' + ' + (NIFTY_ZONE_LABEL[gate.zone] || gate.zone) + '] ' + (ok ? '&rarr; ' + action : '&rarr; waiting') + '</span>';
        }
      }
      el.innerHTML = html;
    };
    await paint('aeNiftyEntryStatus', state.niftyEntry || {}, 'Entry', 'allow entry');
    await paint('aeNiftyExitStatus', state.niftyExit || {}, 'Exit', 'cut trade');
  }

  /* NIFTY ensemble-trend timeframe (1 min / 5 min). Switching invalidates the
     cached bias so the trend is recomputed on the newly chosen timeframe, the
     static helper text is updated and the choice persists across reloads. */
  function syncNiftyTfUI() {
    const selEl = $id('aeNiftyTf');
    if (selEl) selEl.value = _niftyTf;
    const labEl = $id('aeNiftyTfLabel');
    if (labEl) labEl.textContent = (_niftyTf === 'both' ? '1min+5min' : _niftyTf) + ' ensemble trend, refreshed at most once a minute.';
  }

  function setNiftyTf(tf) {
    if (tf !== '1min' && tf !== '5min' && tf !== 'both') tf = '5min';
    _niftyTf = tf;
    localStorage.setItem(_NIFTY_TF_KEY, tf);
    delete _niftyBiasCache[tf];
    syncNiftyTfUI();
    updateNiftyBiasStatus(null);
    niftyBias().then(b => { if (b) updateNiftyBiasStatus(b); });
    log('NIFTY ensemble trend timeframe set to ' + (_niftyTf === 'both' ? '1 min + 5 min' : _niftyTf), 'ok');
  }

  async function candlesFor(symbol, tf, useCache) {
    const cur = (typeof selectedSymbol !== 'undefined') ? selectedSymbol : null;
    const isCurrent = cur && symbol && cur.id === symbol.id && cur.exch === symbol.exch;
    /* Daily chart basis: the window is the user's "daily history days" input
       (default 30) instead of the months-scale backtest-period select. */
    const dailyOn = state.universal && state.universal.dailyBacktest === true;
    const btDays = dailyOn
      ? ((state.universal && Number(state.universal.dailyBacktestDays) > 0) ? Number(state.universal.dailyBacktestDays) : 30)
      : (state.universal && state.universal.backtestDays ? Number(state.universal.backtestDays) : null);
    // Reuse a recently-fetched series so a repeat experiment run is a pure cache
    // hit instead of a network round-trip. The live paper-trading path calls
    // without `useCache` so its signal inputs stay fresh.
    const ck = String(symbol.id) + ':' + (symbol.exch || '') + ':' + (tf || '') + ':' + (btDays || 0);
    if (useCache) {
      const hit = _candleCache.get(ck);
      if (hit && (Date.now() - hit.at) < _CANDLE_CACHE_MS && hit.candles) return hit.candles;
    }
    // Only reuse the in-browser chart series when it is the requested timeframe -
    // an all-timeframes run must not silently substitute the 5min chart for
    // every other bar interval. `chartTf` is the chart's global timeframe. A
    // long backtest window is never satisfied by the chart's short series, so a
    // custom period always fetches fresh history from the backend.
    if (!btDays && isCurrent && (!tf || tf === (typeof chartTf !== 'undefined' ? chartTf : null)) && window.IndChart && IndChart.getCandles) {
      const c = IndChart.getCandles();
      if (c && c.length >= 60) { if (useCache) _cacheSet(_candleCache, ck, { at: Date.now(), candles: c }); return c; }
    }
    if (window.StratEngine && StratEngine.fetchCandlesFor) {
      try {
        const c = await StratEngine.fetchCandlesFor(symbol, tf, btDays || undefined);
        if (useCache && c && c.length >= 60) _cacheSet(_candleCache, ck, { at: Date.now(), candles: c });
        return c;
      } catch (e) { return null; }
    }
    return null;
  }

  /* Indices (and index options) vs F&O stocks share the same run-in chart
     semantics: 'spot' runs on the underlying chart, 'premium' runs on the
     selected-strike option premium chart (skipping when the chain/candles are
     unavailable), and 'both' runs on both. The "Strategy should be run in"
     section lets the user force either instrument type onto the spot chart
     (runInMode() === 'spot') so the strategy run and trade execution use the
     underlying/spot chart instead of the selected-strike premium chart. */
  function isIndex(symbol) {
    return !!(symbol && (symbol.inst === 'INDEX' || symbol.ocExch === 'IDX_I'));
  }
  /* MCX commodity futures / options: no index/equity spot and no standard
     option-premium execution path here - they trade the FUTCOM futures
     contract directly (spot mode). */
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
    if (state.premiumOnly) return 'premium';
    const ri = state.runIn || {};
    if (isCommodity(symbol)) return (ri && ri.comm) || 'spot';
    if (!isIndex(symbol)) return ri.fno || 'spot';
    return ri.index || 'both';
  }
  /* Chart the paper-trade execution should use for an instrument type. Backtest
     trades for BOTH indices and F&O stocks always execute on the selected-strike
     option premium chart ('premium') - never on the underlying/spot chart.
     Commodities execute per their own "Trade should be executed in" dropdown -
     default the FUTCOM futures contract itself ('spot'). */
  function tradeInMode(symbol) {
    if (state.premiumOnly) return 'premium';
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
  /* Fetch the option-premium candle series for a specific option security id
     (CE/PE leg) so backtests and live paper-trade signals run on the premium
     chart instead of the underlying. When `useCache` is true the series is
     cached client-side (30s) so a repeat experiment does not re-hit the network
     for the same option; the live paper-trading path calls without the flag so
     its signal inputs stay fresh. */
  async function candlesForOption(sym, sid, tf, useCache) {
    if (sid == null) return null;
    const optSym = { id: Number(sid), exch: optionExch(sym), inst: optionInst(sym), name: (sym && sym.name) || '' };
    /* An option premium chart only has history back to the current contract's
       listing (~5 days weekly / ~21 days monthly), so a full backtest window
       (e.g. 180d) makes the server walk multiple 90-day Dhan chunks that are
       mostly empty, doubling or tripling the number of slow /charts calls per
       strike and tripping the rate limiter. Cap the window at 45 days so each
       option fetch is a single request that still returns every bar the
       contract ever traded. */
    const btDays = Math.min(state.universal && state.universal.backtestDays ? Number(state.universal.backtestDays) : 0, 45);
    const key = String(sid) + ':' + optionExch(sym) + ':' + tf + ':' + btDays;
    if (useCache) {
      const hit = _optCandleCache.get(key);
      if (hit && (Date.now() - hit.at) < _OPT_CANDLE_CACHE_MS && hit.candles) return hit.candles;
    }
    if (window.StratEngine && StratEngine.fetchCandlesFor) {
      try {
        const c = await StratEngine.fetchCandlesFor(optSym, tf, btDays > 0 ? btDays : undefined);
        const ok = (c && c.length >= 60) ? c : null;
        if (ok && useCache) _cacheSet(_optCandleCache, key, { at: Date.now(), candles: ok });
        return ok;
      } catch (e) { return null; }
    }
    return null;
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
    try {
      const candles = await candlesFor(symbol, '5min', true);
      if (!candles || candles.length < 30) return null;
      const ta = niftyTrendAnalysis(candles);
      const dir = (ta && (ta.dir === 'bullish' || ta.dir === 'bearish')) ? ta.dir : null;
      if (dir) _trendDirCache.set(key, { at: Date.now(), dir });
      return dir;
    } catch (e) { return null; }
  }

  async function contractsFor(symbol, spot) {
    if (!symbol) return null;
    const st = state.strike || {};
    let ot = st.optionType || 'both';
    const onlyPos = st.positiveOnly !== false;
    /* Direction-aware leg pick for the "Only +green premium strikes" filter:
       the selected bullish/bearish indicator filter decides the side first -
       bullish filter -> only CE calls (bought), bearish filter -> only PE puts
       (bought). When no directional filter is active the underlying's own
       trend decides, and if that too is unclassifiable the user's option-type
       selector decides the legs (the green filter still applies). An explicit
       user selection of CE/PE always wins, keeping the strategy side aligned
       with the strike type (CE=bullish, PE=bearish). */
    if ((onlyPos || moverDirectionFor(symbol) != null) && (ot === 'both')) {
      /* Movers mode pins the leg to the stock's own move first (top gainer ->
         CE only, top loser -> PE only), then the selected bullish/bearish
         indicator filter, then the underlying's own trend. */
      const dir = moverDirectionFor(symbol) || activeFilterDirection() || await trendDirectionFor(symbol);
      if (dir === 'bullish') ot = 'CE';
      else if (dir === 'bearish') ot = 'PE';
    }
    const mode = st.mode || 'both_atm';
    const count = mode === 'atm' ? 1 : (st.count || 3); // Only ATM is a single strike
    const cacheKey = String(symbol.id) + ':' + (symbol.ocExch || '') + ':' + mode + ':' + count + ':' + ot + ':' + (onlyPos ? 'pos' : 'all');
    const hit = _contractsCache.get(cacheKey);
    if (hit && (Date.now() - hit.at) < _CONTRACTS_CACHE_MS && hit.contracts) return hit.contracts;
    try {
      // Indices carry their derivative segment (IDX_I / BSE_FNO) in ocExch;
      // F&O stocks arrive as equity spots and are resolved server-side to the
      // FUTSTK underlying on NSE_FNO via symbol_name. Send the EQUITY segment
      // (symbol.exch) so the server actually performs that resolution.
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
      // Retry transient Dhan failures (rate-limit / flaky gateway) once or
      // twice before giving up, so a single DH-904/805 does not collapse the
      // whole run into the spot-chart fallback. Backoff is short so the UI
      // does not stall for seconds on a throttled chain.
      let j = null, res = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, 400 * attempt));
        res = await fetch('/api/auto_strikes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        j = await res.json();
        if (j.status === 'success' && Array.isArray(j.data) && j.data.length) break;
        const msg = (j && j.message) || '';
        if (!/rate|limit|wait/i.test(msg)) break;
      }
      if (!j || j.status !== 'success' || !Array.isArray(j.data) || !j.data.length) {
        const reason = (j && j.message) ? j.message : (res && res.ok ? 'no data returned' : ('HTTP ' + (res && res.status)));
        log('Option chain unavailable for ' + displayName(symbol) + ' (' + ocSeg + '): ' + reason, 'warn');
        return null;
      }
      const all = [], out = [];
      j.data.forEach(d => {
        const mk = (otype, ltp, chg, chgPct, delta, sid) => {
          if (ltp == null || chg == null || sid == null) return null;
          return { strike: d.strike, optionType: otype, premium: ltp, chg: chg, chgPct: chgPct, delta: delta, sid: sid, expiry: j.expiry };
        };
        if (ot === 'both' || ot === 'CE') {
          const c = mk('CE', d.ce_ltp, d.ce_chg, d.ce_chg_pct, d.ce_delta, d.ce_sid);
          if (c) { all.push(c); if (!onlyPos || (c.premium > 0 && c.chg > 0)) out.push(c); }
        }
        if (ot === 'both' || ot === 'PE') {
          const p = mk('PE', d.pe_ltp, d.pe_chg, d.pe_chg_pct, d.pe_delta, d.pe_sid);
          if (p) { all.push(p); if (!onlyPos || (p.premium > 0 && p.chg > 0)) out.push(p); }
        }
      });
      let filtered = out.filter(c => c.strike != null && c.premium != null);
      if (onlyPos && !filtered.length && all.length) {
        // The whole chain is red today, so the "+green premium" filter would
        // leave zero contracts and every symbol would be skipped. Relax to all
        // strikes so the experiment still runs and surfaces strategies.
        filtered = all.filter(c => c.strike != null && c.premium != null);
        log('No green/positive premium strikes for ' + displayName(symbol) + ' - using all strikes so the experiment still runs', 'warn');
      } else if (onlyPos && out.length !== filtered.length) {
        log('Only positive/green premium strikes kept for ' + displayName(symbol) + ': ' + filtered.length + '/' + out.length + ' (negative/zero LTP or LTP change strikes skipped)', 'warn');
      }
      _cacheSet(_contractsCache, cacheKey, { at: Date.now(), contracts: filtered });
      _pickedStrikes.set(_pickedKey(symbol), { symbol: symbol, contracts: filtered, at: Date.now() });
      return filtered;
    } catch (e) { log('Option chain error for ' + displayName(symbol) + ': ' + (e && e.message ? e.message : e), 'warn'); return null; }
  }

  /* ---------------- run progress / state ---------------- */
  /* A run-generation counter makes stale results safe: removeAll / remove /
     removeSelected bump it so an in-flight (slow, network-bound) experiment can
     never re-populate results the user just cleared, and only the most recent
     run may commit its outcome. */
  let _running = false;
  let _runGen = 0;

  function setRunProgress(label, pct) {
    const wrap = $id('aeProgressWrap'), bar = $id('aeProgressBar'), pctEl = $id('aeProgressPct'), lbl = $id('aeProgressLabel');
    if (!wrap || !bar) return;
    if (pct == null) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    bar.style.width = p + '%';
    if (pctEl) pctEl.textContent = p + '%';
    if (lbl && label != null) lbl.textContent = label;
  }

  function setRunButton(running) {
    const btn = $id('aeRunBtn');
    if (!btn) return;
    btn.textContent = running ? 'Running...' : 'Run Experiment';
    btn.disabled = !!running;
    btn.style.opacity = running ? '0.65' : '1';
    btn.style.cursor = running ? 'wait' : 'pointer';
  }

  /* Yield to the browser's event loop so the progress bar / UI repaints between
     synchronous chunks of the backtest phase. Phase 2 is heavy local work and
     without these pauses the bar visually freezes at the last painted % (90%)
     for the whole backtest. */
  function yieldToUI() {
    return new Promise(r => setTimeout(r, 0));
  }

  async function runExperiment() {
    if (_running) { log('Experiment already running - wait for it to finish', 'warn'); return; }
    const gen = ++_runGen;
    _running = true;
    /* Fresh run: reseed the randomized template sweep and drop the memoized
       template set so every press explores a different indicator / parameter
       universe (and thus different results) instead of the same cached set. */
    _runSeed = (Date.now() ^ (Math.random() * 0xFFFFFFFF)) >>> 0;
    _templateCache = null;
    setRunButton(true);
    setRunProgress('Preparing experiment...', 0);
    try {
    const tf = (typeof chartTf !== 'undefined') ? chartTf : '5min';
    let niftyDir = null;
    if (state.niftyTrend && state.niftyTrend.enabled) {
      const nb = await niftyBias();
      if (nb) { _lastNiftyDir = nb.dir; niftyDir = nb.dir; }
    }
    const syms = experimentSymbols(niftyDir);
    if (!syms.length) {
      if (state.niftyTrend && state.niftyTrend.enabled) {
        log('NIFTY trend-following picked no symbols (NIFTY ' + (niftyDir || 'unknown') + ' / no F&O stocks above ' + (state.niftyTrend.pct || 2.5) + '% daily change) - nothing to experiment on', 'warn');
      } else {
        log('Select at least one symbol to experiment on', 'warn');
      }
      return;
    }
    /* Auto strategy sender scope: when enabled, the experiment universe is the
       user-selected saved engine templates ONLY (their settings scope the
       research-template sweep). Nothing runs until at least one template with a
       settings snapshot is selected. */
    const autoSendOn = !!(state.autoSend && state.autoSend.enabled);
    const scopedTpls = autoSendOn ? selectedEngineTemplates() : [];
    if (autoSendOn && !scopedTpls.length) {
      log('Auto strategy sender is ON but no saved engine templates are selected - add templates from the dropdown below the checkbox', 'warn');
      return;
    }
    log('Running experiment on ' + syms.length + ' symbol(s): ' + syms.map(s => displayName(s)).join(', '), '');
    const opts = state.universal;
    const useAiTf = !!(opts && opts.aiTimeframe);
    /* Daily chart basis: the history window is the "daily history days" input
       so the daily backtest runs over exactly that many days (default 30). */
    const dailyOn = !!(opts && opts.dailyBacktest === true);
    const btDays = dailyOn
      ? ((opts && Number(opts.dailyBacktestDays) > 0) ? Number(opts.dailyBacktestDays) : 30)
      : ((opts && opts.backtestDays) ? Number(opts.backtestDays) : null);
    /* Slice a candle series down to the selected backtest window. When a custom
       backtest period is set the series is cut by timestamp (end is the newest
       candle); otherwise the default "recent" window of the last 300 bars is
       used so a fresh experiment stays fast. */
    const btSlice = (candles) => {
      if (!candles || !candles.length) return candles;
      if (!btDays) return candles.slice(-300);
      const end = candles[candles.length - 1].time;
      const cutoff = end - btDays * 86400;
      let idx = 0;
      while (idx < candles.length && candles[idx].time < cutoff) idx++;
      const sliced = candles.slice(idx);
      return sliced.length >= 60 ? sliced : candles.slice(-300);
    };
    const selectedTfs = (opts && opts.tfs)
      ? ALL_TIMEFRAMES.filter(t => opts.tfs[t] !== false)
      : ALL_TIMEFRAMES.slice();
    const activeTfs = selectedTfs.length ? selectedTfs : ALL_TIMEFRAMES.slice();

    const all = [];
    const seen = new Set();
    /* Canonical identity of a result that ignores the timeframe dimension:
       symbol x template (or manual strategy) x strike. With 1 min + 5 min both
       enabled (or the all-timeframes sweep) the SAME strategy is backtested on
       every timeframe, and keying the dedup on r.key (which carries the
       timeframe suffix) made the results list show the same strategy once per
       timeframe. Each strategy is collapsed to its best-scoring timeframe so
       the list never repeats a strategy. The AI auto-timeframe mode performs
       its own collapse below (by aiTimeframeScore), so it is left untouched. */
    const stratKeyOf = (r) => {
      const symId = r.symbol ? (String(r.symbol.id) + ':' + (r.symbol.exch || '')) : '__';
      const base = r.source === 'manual' ? ('manual:' + (r.manualId || '')) : (r.tplKey || r.key || '');
      const stk = (r.optionStrike != null) ? (r.optionStrike + ':' + r.optionType) : 'u';
      return symId + '|' + base + '|' + stk;
    };
    const stratSeen = new Map(); // canonical strategy key -> best result so far
    const push = (r) => {
      if (!r || !r.key || seen.has(r.key)) return;
      if (!useAiTf) {
        const sk = stratKeyOf(r);
        const cur = stratSeen.get(sk);
        if (cur) {
          if ((cur.score || 0) >= (r.score || 0)) return; // keep the better timeframe
          const i = all.indexOf(cur);
          if (i >= 0) all.splice(i, 1);
        }
        stratSeen.set(sk, r);
      }
      seen.add(r.key);
      all.push(r);
    };

    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const multi = syms.length > 1;

    const symIdOf = (s) => (s.id != null ? String(s.id) : String(s.name));

    /* Stable identity for a candle series: two fetches of the same option in
       the cache window produce the same length + first/last timestamp AND the
       same closes, so the backtest cache can safely key on it. The content
       hash is essential: different option strikes of the same symbol fetched
       over the same window share identical length + timestamps, and without
       the close hash the backtest cache would return ONE shared metrics object
       for every strike, making every strategy's Detail modal show the same
       trades / equity / P&L. */
    const seriesKey = (c) => {
      if (!c || !c.length) return 'empty';
      let h = 2166136261;
      for (let i = 0; i < c.length; i++) {
        const d = c[i] || {};
        const v = (Math.round((d.open || 0) * 1000) * 31 + Math.round((d.high || 0) * 1000) * 37 +
          Math.round((d.low || 0) * 1000) * 41 + Math.round((d.close || 0) * 1000) * 43 +
          ((d.time || 0) >>> 0)) >>> 0;
        h = Math.imul(h ^ v, 16777619) >>> 0;
      }
      return c.length + ':' + (c[0] && c[0].time) + ':' + (c[c.length - 1] && c[c.length - 1].time) + ':' + h.toString(36);
    };

    /* Memoized backtest. The universal options (manualTrail / tpPct / aiTp)
       and any applied entry filters are part of the key,
       so a repeat run on unchanged inputs is a pure cache hit - the whole pass
       then completes in well under 10ms of CPU. */
    const backtestCached = (fTpl, candles, opts, series, splitOpts) => {
      const o = opts || {};
      const oKey = [o.manualTrail === false, o.tpPct, o.aiTp === false, !!o.manualTP, o.manualTPPct, !!o.aiTP, !!o.aiSl, !!o.manualSL, o.manualSLPct, !!o.manualTrailTP, o.manualTrailTPPct, !!o.tradeLimitEnabled, o.tradeLimitCount, !!o.tradeLimitDaily, !!o.aiTrades, !!o.deductBrokerCharges, o.brokerChargeMode, o.brokerChargePerTrade, o.btQty, !!o.dailyBacktest, o.dailyBacktestDays, !!o.rrEnabled, o.rrValue, !!o.startTradeAfterEnabled, o.startTradeAfter, !!o.noTradeAfterEnabled, o.noTradeAfter].map(String).join(',');
      /* When the strategy runs on a different chart than the one trades are
         executed on (F&O stocks: run spot / execute premium; indices: run
         spot+premium / execute premium), the run-in signal series is folded into
         the cache key so two experiments with different signal charts never
         share one metrics object. */
      let splitKey = '';
      if (splitOpts) {
        splitKey = '|split:' + (splitOpts.signalCandles || []).map(seriesKey).join('+') + '>' + seriesKey(splitOpts.tradeCandles || candles);
      }
      const key = fTpl.key + '|' + (fTpl.entryExtra ? JSON.stringify(fTpl.entryExtra) : '') + '|' + series + '|' + oKey + splitKey;
      const hit = _backtestCache.get(key);
      if (hit && (Date.now() - hit.at) < _BACKTEST_CACHE_MS) return hit.m;
      const m = splitOpts
        ? backtestSplit(fTpl, splitOpts.signalCandles, splitOpts.tradeCandles, opts)
        : backtest(fTpl, candles, opts);
      _cacheSet(_backtestCache, key, { at: Date.now(), m });
      return m;
    };

    /* Backtest every enabled template (and optional manual strategies) on a
       candle series, pushing the results. When `strikeInfo` is present the
       result is tagged as a specific CE/PE strike and its metrics come from the
       option-premium series rather than the underlying. `tf` tags which
       candlestick timeframe the series came from (needed for the all-timeframes
       and AI auto-timeframe modes). `splitOpts` decouples the run-in chart
       (where signals are evaluated) from the trade-in chart (where the
       simulated trades are executed) so auto-generated backtest trades land on
       the selected-strike option premium chart even when the strategy runs on
       the underlying spot chart. */
    const runOnCandles = async (sym, backCandles, spot, strikeInfo, tf, runBasis, splitOpts, tick) => {
      const tradeCandles = (splitOpts && splitOpts.tradeCandles) ? splitOpts.tradeCandles : backCandles;
      const autoSl = autoSLPct(tradeCandles);
      const symId = symIdOf(sym);
        const runTemplates = async (tpl, source, extra) => {
        const fTpl = applyFilters(tpl);
        /* Resolve the trade quantity for broker-charge deduction the same way
           paper trading does: the underlying's real lot size (from the broker
           scrip master) unless the user set a universal override. */
        const bOpts = Object.assign({}, opts, { btQty: (function () {
          let ls = (opts && opts.lotSize != null) ? opts.lotSize : null;
          if (ls == null && window.PaperTrade && PaperTrade.lotSizeFor) ls = PaperTrade.lotSizeFor(sym);
          return Math.max(1, Math.round((Number(opts && opts.lots) || 1) * (Number(ls) > 0 ? Number(ls) : 1)));
        })() });
        const m = splitOpts
          ? backtestCached(fTpl, tradeCandles, bOpts, seriesKey(tradeCandles), splitOpts)
          : backtestCached(fTpl, backCandles, bOpts, seriesKey(backCandles));
        const score = scoreOf(m);
        const filterNames = fTpl !== tpl ? activeFilterLabels(tpl) : [];
        const uu = state.universal || {};
        const refManualSLOn = uu.manualSL === true;
        const refTrailOn = uu.manualTrailSL === true;
        const refAiSlOn = !refManualSLOn && !refTrailOn && uu.aiSl !== false;
        /* Reference-only risk snapshot (displayed in the Paper Trade lists and
           the Strategy Container): the overall SL % and trail SL % the AE engine
           used when backtesting this strategy. Purely informational - the AST
           engine always runs on its own settings basis. */
        const refSlPct = refManualSLOn ? (Number(uu.manualSLPct) || 0) : (refAiSlOn ? autoSl : 0);
        const refTrailSlPct = refTrailOn ? (Number(uu.manualTrailSLPct) || 0) : 0;
        const base = {
          key: multi ? symId + ':' + fTpl.key : fTpl.key,
          tplKey: fTpl.key,
          name: fTpl.name,
          cat: fTpl.cat,
          method: fTpl.method,
          research: fTpl.research,
          source,
          tf: tf || '5min',
          symbol: sym ? JSON.parse(JSON.stringify(sym)) : null,
          spot: spot != null ? spot : (backCandles.length ? backCandles[backCandles.length - 1].close : null),
          entry: fTpl.entry,
          exit: fTpl.exit,
          entryExtra: fTpl.entryExtra || null,
          exitExtra: fTpl.exitExtra || null,
          entryThreshold: (fTpl.entryThreshold != null && fTpl.entryThreshold >= 1) ? fTpl.entryThreshold : null,
          candlestick: fTpl.candlestick || null,
          autoSlPct: autoSl,
          refSlPct: refSlPct,
          refTrailSlPct: refTrailSlPct,
          filters: filterNames,
          metrics: m,
          score,
          verdict: verdict(score),
          runBasis: runBasis || (strikeInfo ? 'premium' : 'underlying')
        };
        if (strikeInfo) {
          base.key = base.key + ':' + strikeInfo.strike + ':' + strikeInfo.optionType;
          base.name = base.name + ' ' + strikeInfo.strike + ' ' + strikeInfo.optionType;
          base.optionStrike = strikeInfo.strike;
          base.optionType = strikeInfo.optionType;
          base.premium = strikeInfo.premium;
          base.delta = strikeInfo.delta;
          base.optionSid = strikeInfo.sid;
          base.expiry = strikeInfo.expiry;
          base.backtestBasis = 'option';
        } else {
          // Only reached when a symbol had no option chain / option candles:
          // the fallback underlying result is later expanded into per-strike
          // contracts.
          base.backtestBasis = 'underlying';
        }
        if (useAiTf || activeTfs.length > 1) base.key = base.key + ':' + (tf || '5min');
        push(Object.assign(base, extra || {}));
      };

      const enabledGroups = (state.groups && state.groups.length) ? state.groups : GROUP_KEYS.slice();
      const dirGate = effectiveStrategyDirection();
      const streamGroups = activeFilterGroups();
      /* Number of templates (incl. manual strategies) this unit will actually
         run after the group / direction / stream gates - used to advance the
         progress bar smoothly per template instead of one coarse step per unit. */
      const totalRun = (() => {
        let c = 0;
        /* Auto strategy sender scope: each selected engine template applies its
           saved settings and the research-template sweep runs under that
           configuration, so the count is the union of every template's sweep. */
        if (scopedTpls.length) {
          const orig = captureEngineSettings();
          try {
            for (const t of scopedTpls) {
              applyEngineSettingsSilent(t.settings);
              const eg = (state.groups && state.groups.length) ? state.groups : GROUP_KEYS.slice();
              const dg = effectiveStrategyDirection();
              const sg = activeFilterGroups();
              for (const tpl of buildTemplateSet()) {
                if (eg.indexOf(tpl.group) < 0) continue;
                if (dg && tpl.cat !== dg) continue;
                if (sg) { const want = sg[tpl.cat] || []; if (want.indexOf(tpl.group) < 0) continue; }
                c++;
              }
            }
          } finally {
            applyEngineSettingsSilent(orig);
          }
          return c;
        }
        for (const tpl of buildTemplateSet()) {
          if (enabledGroups.indexOf(tpl.group) < 0) continue;
          if (dirGate && tpl.cat !== dirGate) continue;
          if (streamGroups) {
            const want = streamGroups[tpl.cat] || [];
            if (want.indexOf(tpl.group) < 0) continue;
          }
          c++;
        }
        if (state.runManual) {
          for (const s of loadManualStrategies()) {
            if (!s || !s.entry || !s.entry.indId) continue;
            if (dirGate && (s.cat || 'bullish') !== dirGate) continue;
            c++;
          }
        }
        return c;
      })();
      let ran = 0;
      /* Yield to the event loop at most every ~16ms instead of once per
         template. setTimeout(0) inside a tight backtest loop can clamp to ~1-4ms
         each, so 250 templates x N units of pure timer delay added up to seconds
         of wasted time - while the progress-bar DOM writes still batch/repaint
         every frame, so the bar stays smooth at a fraction of the overhead. */
      let lastYield = 0;
      const maybeYield = async () => {
        const now = Date.now();
        if (now - lastYield >= 16) { lastYield = now; await yieldToUI(); }
      };
      /* Auto strategy sender scope: each selected engine template's saved
         settings are applied (silently) and the full research-template sweep
         runs under that configuration; settings are restored after each so the
         next template starts from the experiment's own state. The union of all
         sweeps becomes the results and is auto-sent to Paper Trade. */
      if (scopedTpls.length) {
        const origScope = captureEngineSettings();
        for (const t of scopedTpls) {
          applyEngineSettingsSilent(t.settings);
          try {
            const eg = (state.groups && state.groups.length) ? state.groups : GROUP_KEYS.slice();
            const dg = effectiveStrategyDirection();
            const sg = activeFilterGroups();
            for (const tpl of buildTemplateSet()) {
              if (eg.indexOf(tpl.group) < 0) continue;
              if (dg && tpl.cat !== dg) continue;
              if (sg) {
                const want = sg[tpl.cat] || [];
                if (want.indexOf(tpl.group) < 0) continue;
              }
              /* Tag every strategy created under this saved engine template so
                 it can be categorised by - and routed to - that template. */
              await runTemplates(tpl, 'auto', { engineTpl: { id: t.id, name: t.name || 'Untitled', mode: t.mode || 'bullish' } });
              ran++;
              if (tick) tick(ran, totalRun);
              await maybeYield();
            }
          } finally {
            applyEngineSettingsSilent(origScope);
          }
        }
        return;
      }
      for (const tpl of buildTemplateSet()) {
        if (enabledGroups.indexOf(tpl.group) < 0) continue;
        /* Direction gate: a bullish strike (CE) or bullish indicator filter
           creates only bullish strategies, a bearish strike (PE) or bearish
           filter only bearish ones - the opposing side's templates are skipped
           entirely so the results list never mixes sides. */
        if (dirGate && tpl.cat !== dirGate) continue;
        /* Research-stream scoping: a ticked stream checkbox inside the section
           limits that side to templates of the matching research group only. */
        if (streamGroups) {
          const want = streamGroups[tpl.cat] || [];
          if (want.indexOf(tpl.group) < 0) continue;
        }
        await runTemplates(tpl, 'auto');
        ran++;
        if (tick) tick(ran, totalRun);
        await maybeYield();
      }

      if (state.runManual) {
        for (const s of loadManualStrategies()) {
          if (!s || !s.entry || !s.entry.indId) continue;
          if (dirGate && (s.cat || 'bullish') !== dirGate) continue;
          await runTemplates({
            key: 'manual:' + s.id,
            name: (s.name || 'Manual strategy'),
            cat: s.cat || 'bullish',
            method: 'Manual',
            research: 'User-created strategy',
            entry: s.entry,
            exit: (s.exit && s.exit.indId) ? s.exit : null,
            candlestick: s.candlestick || null
          }, 'manual', { manualId: s.id });
          ran++;
          if (tick) tick(ran, totalRun);
          await maybeYield();
        }
      }
    };

    const isSuperseded = () => gen !== _runGen;

    /* Phase 1 - fetch. Underlying candles, option chains and option-premium
       candles are fetched in parallel (bounded to one symbol's contracts at a
       time so Dhan's throttle is never flooded) and cached client-side, so the
       dominant network latency is paid once, not once per template. When the
       all-timeframes / AI-timeframe modes are on, every candlestick timeframe
       is fetched (per underlying symbol and per option contract) and stored in
       a per-timeframe map so Phase 2 can test each one. */
    let skipped = 0;
    const units = { done: 0, total: syms.length * activeTfs.length, symDone: 0, shown: -1 }; // underlying per symbol per tf
    let curSymName = '';
    const bump = (n) => { units.done = Math.min(units.done + n, Math.max(1, units.total)); };
    const elapsed = () => {
      const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      return Math.round((now - t0) / 1000) + 's';
    };
    const progressFetch = () => {
      const pct = Math.max(0, Math.min(40, Math.round((units.done / Math.max(1, units.total)) * 40)));
      /* `units.total` grows as option chains are discovered mid-run (each
         symbol's contracts add their candle units), so a later symbol inflating
         the denominator while `done` lags would otherwise make the percentage
         drop and the bar appear to stall/regress. Clamp to the highest value
         seen so the fetch phase only ever moves forward. */
      units.shown = Math.max(units.shown, pct);
      const where = (units.symDone > 0 || curSymName)
        ? ' (' + Math.min(units.symDone + 1, syms.length) + '/' + syms.length + (curSymName ? ' ' + curSymName : '') + ')'
        : '';
      setRunProgress('Fetching candles & option chains' + where + ' (' + activeTfs.length + ' timeframe' + (activeTfs.length > 1 ? 's' : '') + ')... ' + elapsed(), units.shown);
    };

    /* Bound parallel candle fetches across timeframes so a full all-timeframe
       pass never slams Dhan's rate limiter - a few in flight at a time. Two
       symbols x two timeframes (max ~4 concurrent /api/candles) keeps a run
       under Dhan's historical budget; firing more tripped DH-904 rate-limits
       that skipped every symbol and produced no strategies. */
    const tfPool = async (items, limit, fn) => {
      const out = new Array(items.length);
      let i = 0;
      const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (i < items.length) {
          const idx = i++;
          out[idx] = await fn(items[idx]);
        }
      });
      await Promise.all(workers);
      return out;
    };

    progressFetch();
    // Process the symbol set through a bounded pool rather than Promise.all.
    // In Top Movers mode the set can be 5 gainers + 5 losers + all indices, and
    // firing every symbol's candle + option-chain fetches at once floods Dhan's
    // rate limiter: most symbols then come back "not enough candles" and only 1-2
    // actually run. A small concurrency window lets every mover fetch reliably.
    const batch = await tfPool(syms, 2, async (sym) => {
      curSymName = displayName(sym);
      progressFetch();
      const underlyingByTf = {};
      const uRes = await tfPool(activeTfs, 2, async (t) => {
        const u = await candlesFor(sym, t, true);
        bump(1); progressFetch();
        return { t, u };
      });
      uRes.forEach(({ t, u }) => { if (u && u.length >= 60) underlyingByTf[t] = u; });
      units.symDone++;
      progressFetch();
      if (!Object.keys(underlyingByTf).length) {
        log('Skipping ' + displayName(sym) + ': not enough candles', 'warn');
        return { sym, underlyingByTf: null };
      }
      // Spot taken from the chart's active timeframe when available, else any.
      const spotTf = underlyingByTf[tf] ? tf : Object.keys(underlyingByTf)[0];
      const spot = underlyingByTf[spotTf].length ? underlyingByTf[spotTf][underlyingByTf[spotTf].length - 1].close : null;

      /* Direction-aware backtest: when a directional indicator filter (bullish
         or bearish) is selected the backtest engine only runs symbols whose own
         trend/movement matches that side - a bearish filter backtests bearish
         stocks/indices only and a bullish filter backtests the bullish side
         only. Symbols trending the opposite way are skipped from the run. */
      const btFilterDir = activeFilterDirection();
      if (btFilterDir) {
        const dirCandles = underlyingByTf[spotTf];
        let symDir = null;
        if (dirCandles && dirCandles.length >= 30) {
          const ta = niftyTrendAnalysis(dirCandles);
          symDir = (ta && (ta.dir === 'bullish' || ta.dir === 'bearish')) ? ta.dir : null;
        }
        if (symDir && symDir !== btFilterDir) {
          log('Skipping ' + displayName(sym) + ': ' + btFilterDir + ' indicator filter selected but trend is ' + symDir, 'warn');
          return { sym, underlyingByTf: null };
        }
      }

      // Backtest trades for indices and F&O stocks ALWAYS execute on the
      // selected-strike option premium chart ("Trade should be executed in"),
      // so every symbol resolves the option chain and premium candles for trade
      // execution - even F&O stocks whose strategy signals run on the spot
      // chart. There is no spot-executed backtest path for these instruments.
      const riMode = runInMode(sym);
      const tiMode = tradeInMode(sym);

      // 'premium' and 'both' run-in, and spot-run symbols that execute on the
      // premium chart, all resolve the selected-strike option chain (indices
      // and F&O stocks behave identically here). MCX commodities trade the
      // FUTCOM futures contract directly (spot mode) - no option chain needed.
      const contracts = (tiMode === 'spot') ? [] : await contractsFor(sym, spot);
      if (contracts && contracts.length) units.total += contracts.length * activeTfs.length;
      progressFetch();

      // "Strategy should be run in" = Both: the strategy runs on the underlying
      // spot chart AND each selected-strike premium chart, but the backtest
      // trade is still executed only on the premium chart. When the option
      // chain is unavailable the symbol is skipped - it is never downgraded to
      // a spot-only backtest (that would price the simulated trades on the
      // underlying and report spot-based P&L).
      if (riMode === 'both') {
        if (!contracts || !contracts.length) {
          log('No option chain for ' + displayName(sym) + ' - skipping (both run needs spot + premium, trade executes on the premium chart)', 'warn');
          return { sym, underlyingByTf, spot, contracts: [] };
        }
        const ocList = await tfPool(contracts, 2, async (c) => {
          const ocByTf = {};
          const cres = await tfPool(activeTfs, 2, async (t) => {
            const oc = await candlesForOption(sym, c.sid, t, true);
            bump(1); progressFetch();
            return { t, oc };
          });
          cres.forEach(({ t, oc }) => { if (oc) ocByTf[t] = oc; });
          return { c, ocByTf };
        });
        return { sym, underlyingByTf, spot, contracts, ocList, runBoth: true };
      }

      // Symbols whose trades execute on the premium chart backtest ONLY on the
      // selected-strike premium charts. There is NO fallback to the spot chart:
      // without an option chain (or option candles) the symbol is skipped rather
      // than tested on the underlying - a spot backtest would price the simulated
      // trades on the underlying and report spot-based P&L, which is never wanted
      // when "Trade should be executed in" is the option premium chart (the
      // default for both F&O stocks and indices).
      if (!contracts || !contracts.length) {
        log('No option chain for ' + displayName(sym) + ' - skipping (backtest trades must execute on the option premium chart)', 'warn');
        return { sym, underlyingByTf, spot, contracts: [] };
      }
      const ocList = await tfPool(contracts, 2, async (c) => {
        const ocByTf = {};
        const cres = await tfPool(activeTfs, 2, async (t) => {
          const oc = await candlesForOption(sym, c.sid, t, true);
          bump(1); progressFetch();
          return { t, oc };
        });
        cres.forEach(({ t, oc }) => { if (oc) ocByTf[t] = oc; });
        return { c, ocByTf };
      });
      return { sym, underlyingByTf, spot, contracts, ocList };
    });
    if (isSuperseded()) return;

    /* Phase 2 - backtest. Pure local O(n) work: a full pass over every template
       is sub-10ms of CPU per candle series. The bar gets the 40->99% range here
       (the fetch phase takes 0->40%) and advances per TEMPLATE inside each unit
       so it visibly sweeps instead of hanging at a coarse per-unit step. */
    const totalWork = batch.reduce((a, it) => {
      if (!it.underlyingByTf) return a;
      const tfs = Object.keys(it.underlyingByTf);
      if (dailyOn) {
        for (const t of tfs) if (it.underlyingByTf[t] && it.underlyingByTf[t].length >= 60) a++;
        return a;
      }
      if (it.spotRun || tradeInMode(it.sym) === 'spot') {
        /* Spot-trade symbols (MCX commodities): the backtest executes directly
           on the underlying futures/spot chart - one unit per timeframe. */
        for (const t of tfs) if (it.underlyingByTf[t] && it.underlyingByTf[t].length >= 60) a++;
        return a;
      }
      if (!it.contracts || !it.contracts.length || !it.ocList || !it.ocList.length) return a;
      const riMode = runInMode(it.sym);
      for (const { ocByTf } of it.ocList) {
        for (const t of tfs) {
          const oc = ocByTf[t];
          if (!oc || oc.length < 60) continue;
          if (riMode === 'spot') {
            const underlying = it.underlyingByTf[t];
            if (!underlying || underlying.length < 60) continue;
          }
          a++;
        }
      }
      return a;
    }, 0);
    let workDone = 0;
    let curLabel = '';
    let unitStart = 40;
    let unitSpan = 0;
    const progressBacktest = (label) => {
      curLabel = label;
      workDone++;
      /* Each unit owns a slice of the 40->99% band; the per-template tick below
         sweeps through it so the bar never sits frozen between units. */
      unitStart = 40 + ((workDone - 1) / Math.max(1, totalWork)) * 59;
      unitSpan = (40 + (workDone / Math.max(1, totalWork)) * 59) - unitStart;
      setRunProgress(label + ' ' + elapsed(), Math.round(Math.min(99, unitStart + (unitSpan > 0 ? unitSpan : 0.5))));
    };
    const unitTick = (ran, totalRun) => {
      if (!totalRun) return;
      const pct = Math.min(99, unitStart + unitSpan * (ran / totalRun));
      setRunProgress(curLabel + ' ' + elapsed(), Math.round(pct));
    };

    for (const it of batch) {
      if (!it.underlyingByTf) { skipped++; continue; }
      const { sym, underlyingByTf, spot } = it;
      const nTpl = buildTemplateSet().length;
      const tfs = Object.keys(underlyingByTf);
      const riMode = runInMode(sym);
      const tiMode = tradeInMode(sym);

      // Daily chart basis: the backtest runs on the UNDERLYING spot chart over
      // the full "History days" window (e.g. 20 or 180 days), because the
      // option premium chart only has history back to the current contract's
      // listing (~5 days weekly / ~21 days monthly) and can never satisfy a
      // longer window. Per-day trade limits and the daily P&L / win-rate / RR
      // breakdown still apply exactly as in the premium path.
      if (dailyOn) {
        let loaded = 0;
        for (const t of tfs) {
          const u = underlyingByTf[t];
          if (!u || u.length < 60) continue;
          const tradeCandles = btSlice(u);
          progressBacktest('Testing ' + nTpl + ' templates on ' + displayName(sym) + ' daily (underlying spot, ' + t + ')...');
          loaded++;
          await runOnCandles(sym, tradeCandles, spot, null, t, 'underlying', null, unitTick);
        }
        if (loaded === 0) {
          skipped++;
          log('No candles for ' + displayName(sym) + ' - skipping (daily basis)', 'warn');
        }
        continue;
      }

      // Backtest trades for indices and F&O stocks ALWAYS execute on the
      // selected-strike option premium chart. If the option chain or premium
      // candles could not be resolved the symbol is SKIPPED - never backtested
      // on the underlying spot chart (a spot backtest would price the simulated
      // trades on the underlying and report spot-based P&L, which is never
      // wanted when "Trade should be executed in" is the option premium chart).
      // MCX commodities are the exception: they trade the FUTCOM futures
      // contract directly (spot mode), so the backtest runs on the underlying
      // futures chart itself - no option chain / premium chart involved.
      if (it.spotRun || tiMode === 'spot') {
        let loaded = 0;
        for (const t of tfs) {
          const u = underlyingByTf[t];
          if (!u || u.length < 60) continue;
          const tradeCandles = btSlice(u);
          progressBacktest('Testing ' + nTpl + ' templates on ' + displayName(sym) + ' (spot, ' + t + ')...');
          loaded++;
          await runOnCandles(sym, tradeCandles, spot, null, t, 'underlying', null, unitTick);
        }
        if (loaded === 0) {
          skipped++;
          log('No candles for ' + displayName(sym) + ' - skipping (spot run)', 'warn');
        }
        continue;
      }
      if (!it.contracts || !it.contracts.length || !it.ocList || !it.ocList.length) {
        skipped++;
        log('Skipping ' + displayName(sym) + ': no option chain/premium candles (backtest trades must execute on the option premium chart)', 'warn');
        continue;
      }

      // Premium trade execution: the simulated backtest trade is priced on the
      // selected-strike option premium chart while the strategy signals run on
      // the run-in chart per "Strategy should be run in":
      //  - 'spot'    -> signals on the underlying spot chart only (F&O stocks)
      //  - 'both'    -> signals must confirm on BOTH the spot and premium charts
      //  - 'premium' -> signals on the premium chart only
      let loaded = 0;
      for (const { c, ocByTf } of it.ocList) {
        let tfLoaded = 0;
        for (const t of tfs) {
          const oc = ocByTf[t];
          if (!oc || oc.length < 60) continue;
          const underlying = underlyingByTf[t];
          const tradeCandles = btSlice(oc);
          let signalCandles = null;
          if (riMode === 'spot') {
            signalCandles = (underlying && underlying.length >= 60) ? [btSlice(underlying)] : null;
          } else if (riMode === 'both') {
            signalCandles = (underlying && underlying.length >= 60) ? [btSlice(underlying), tradeCandles] : [tradeCandles];
          } else {
            signalCandles = [tradeCandles];
          }
          if (!signalCandles) continue;
          const signalLabel = riMode === 'both' ? 'spot+premium signals / premium trade'
            : (riMode === 'spot' ? 'spot signals / premium trade' : 'premium signals / premium trade');
          progressBacktest('Testing ' + nTpl + ' templates on ' + displayName(sym) + ' ' + c.strike + ' ' + c.optionType + ' (' + t + ', ' + signalLabel + ')...');
          tfLoaded++;
          loaded++;
          await runOnCandles(sym, tradeCandles, spot, {
            strike: c.strike, optionType: c.optionType, premium: c.premium, delta: c.delta,
            sid: c.sid, expiry: c.expiry
          }, t, riMode, { signalCandles, tradeCandles }, unitTick);
        }
        if (tfLoaded === 0) log('Skipping ' + displayName(sym) + ' ' + c.strike + ' ' + c.optionType + ': no option candles', 'warn');
      }
      if (loaded === 0) {
        skipped++;
        log('No option candles for ' + displayName(sym) + ' - skipping (premium run)', 'warn');
      }
    }
    if (isSuperseded()) return;

    /* AI auto-timeframe: after the full all-timeframe sweep, collapse every
       (strategy x strike x symbol) group down to its single best timeframe. */
    if (useAiTf) {
      const best = new Map();
      for (const r of all) {
        const symPart = r.symbol ? (String(r.symbol.id) + ':' + (r.symbol.exch || '')) : '__';
        const key = symPart + '|' + (r.tplKey || r.key) + '|' + (r.optionStrike != null ? r.optionStrike + ':' + r.optionType : 'u');
        const cur = best.get(key);
        if (!cur || aiTimeframeScore(r.metrics) > aiTimeframeScore(cur.metrics)) best.set(key, r);
      }
      all.length = 0;
      best.forEach(r => { r.aiTf = true; all.push(r); });
    }

    const ms = (typeof performance !== 'undefined' && performance.now) ? performance.now() - t0 : Date.now() - t0;

    // Rank, then drop anything that did not prove profitable in backtest.
    all.sort((a, b) => b.score - a.score);
    // A profitable strategy needs at least 2 closed trades and a positive net
    // return. Relax progressively so the engine always surfaces its best
    // candidates instead of showing an empty list.
    let profitable = all.filter(r => r.metrics && r.metrics.trades >= 2 && r.metrics.totalReturn > 0);
    if (!profitable.length) profitable = all.filter(r => r.metrics && r.metrics.totalReturn > 0);
    let degenerate = false;
    if (!profitable.length) { profitable = all; degenerate = true; }

    // Cap the top TEMPLATES per symbol (not the top results) so per-strike
    // backtests keep EVERY selected strike of every kept strategy. The old cap
    // counted results, so with strike-scoped backtests a single best-performing
    // strike could consume the whole per-symbol budget and every strategy
    // collapsed onto that one strike. In all-timeframe mode each timeframe can
    // hold its own winners, so the cap scales with the number of timeframes
    // tested.
    const MAX_TPL_PER_SYM = activeTfs.length > 1 ? 12 * activeTfs.length : 12;
    /* The fixed curated templates (BASE_TPL_KEYS) always score among the best,
       so without a quota they would fill every kept slot and every run would
       surface the same base winners while the per-run randomized sweep never
       reached the results list. Reserve a share of each symbol's slots for the
       auto-generated parameter-sweep templates so every run actually shows
       fresh indicator / filter variants. */
    const SWEEP_SLOTS = Math.max(2, Math.round(MAX_TPL_PER_SYM * 0.4));
    const BASE_SLOTS = MAX_TPL_PER_SYM - SWEEP_SLOTS;
    const capped = [];
    const perSymTpl = new Map();
    const perSymBaseCount = new Map();
    const keptTplTotal = new Set();
    for (const r of profitable) {
      const sk = r.symbol ? (String(r.symbol.id) + ':' + String(r.symbol.exch)) : '__';
      const tplK = (r.source === 'manual') ? ('manual:' + (r.manualId || '')) : (r.tplKey || r.key || '');
      const isBase = BASE_TPL_KEYS.has(tplK);
      const symSet = perSymTpl.get(sk);
      if (symSet && symSet.has(tplK)) { capped.push(r); continue; } // template already kept -> keep every strike variant
      if (symSet && symSet.size >= MAX_TPL_PER_SYM) continue;
      const baseCount = perSymBaseCount.get(sk) || 0;
      if (isBase && baseCount >= BASE_SLOTS) continue; // leave room for the sweep quota
      if (!isBase && symSet && (symSet.size - baseCount) >= SWEEP_SLOTS) continue;
      // Degenerate no-profit fallback stays globally bounded (was all.slice(0,10)).
      if (degenerate && !keptTplTotal.has(tplK) && keptTplTotal.size >= 10) continue;
      if (symSet) symSet.add(tplK); else perSymTpl.set(sk, new Set([tplK]));
      if (isBase) perSymBaseCount.set(sk, baseCount + 1);
      keptTplTotal.add(tplK);
      capped.push(r);
    }

    // Strike-scoped ('option') results - indices and F&O stocks backtested on
    // their option-premium chart - are already per-strike and go straight
    // through. Only 'underlying' fallback results are expanded into per-strike
    // contracts here so their paper trading targets the selected strikes. The
    // option chain is fetched once per symbol and shared across its results.
    const contractsForCached = async (sym, spot) => {
      if (!sym) return null;
      return contractsFor(sym, spot); // module-level cached from the fetch phase
    };

    // Pre-fetch contracts for all strike-scope expansion symbols in parallel so
    // the per-result loop below is pure cache hits (no serialised network waits).
    const needContracts = [];
    const seenNeed = new Set();
    for (const r of capped) {
      if (r.backtestBasis === 'option' || !r.symbol) continue;
      const k = String(r.symbol.id) + ':' + (r.symbol.exch || '');
      if (!seenNeed.has(k)) { seenNeed.add(k); needContracts.push(r); }
    }
    await Promise.all(needContracts.map(r => contractsForCached(r.symbol, r.spot)));
    if (isSuperseded()) return;

    const kept = [];
    for (const r of capped) {
      if (r.backtestBasis === 'option' || r.runBasis === 'spot') { kept.push(r); continue; }
      const contracts = await contractsForCached(r.symbol, r.spot);
      if (contracts && contracts.length) {
        for (const c of contracts) {
          kept.push(Object.assign({}, r, {
            key: r.key + ':' + c.strike + ':' + c.optionType,
            name: r.name + ' ' + c.strike + ' ' + c.optionType,
            optionStrike: c.strike,
            optionType: c.optionType,
            premium: c.premium,
            delta: c.delta,
            optionSid: c.sid,
            expiry: c.expiry,
            backtestBasis: 'underlying'
          }));
        }
      } else {
        kept.push(r);
      }
    }
    if (isSuperseded()) return;

    const removed = all.length - profitable.length;
    const deduped = dedupeResults(kept);
    setRunProgress('Ranking ' + deduped.length + ' strategies...', 99);
    state.results = deduped;
    state.lastRun = {
      at: Date.now(), ms: Math.round(ms * 100) / 100,
      candles: deduped.length ? 300 : 0,
      symbols: syms.map(s => displayName(s)),
      kept: deduped.length, total: all.length,
      autoSlPct: deduped.length ? deduped[0].autoSlPct : null,
      aiTrail: !(state.universal && state.universal.aiTp === false),
      tf: useAiTf ? 'AI-picked' : (activeTfs.length > 1 ? activeTfs.join('+') : activeTfs[0])
    };
    // A fresh run replaces the result set, so drop any stale card selections
    // and re-select every kept result: "Send to Paper Trade" then sends exactly
    // the ticked cards (default all), and the user can un-tick the strategies
    // they do not want (e.g. the bearish ones) before sending.
    _selected.clear();
    if (state.groupByStrategy) {
      groupedResults().forEach(g => _selected.add(g.groupKey));
    } else {
      deduped.forEach(r => _selected.add(r.key));
    }
    save();
    render();
    if (!deduped.length) {
      if (skipped === syms.length) {
        log('No results: every symbol was skipped (missing candle data, unavailable option chain, or no green premium strikes) - check the warnings above, the Dhan connection, or reload the chart', 'warn');
      } else {
        log('Experiment complete but no profitable strategies survived - check candle data / connection', 'warn');
      }
    } else {
      const em = activeExitMode();
      const exitNote = em.anyManual
        ? ' - ' + em.label + ' applied to all ' + deduped.length + ' strategies (AI auto risk inactive)'
        : ((state.universal && state.universal.aiTp !== false)
          ? ' - auto SL + AI Trail TP applied to all ' + deduped.length + ' strategies'
          : ' - auto SL applied to all ' + deduped.length + ' strategies');
      const budgetNote = (state.universal && state.universal.aiTrades)
        ? ' - AI auto trades enabled: unlimited trades whenever a strategy confirms'
        : ((state.universal && state.universal.tradeLimitEnabled) ? ' - up to ' + state.universal.tradeLimitCount + ' backtest trades per strategy' : '');
      log('Experiment complete: ' + deduped.length + ' strategies kept across ' + syms.length + ' symbol(s)' +
        (removed ? ' (' + removed + ' unprofitable removed)' : '') + ' in ' + Math.round(ms * 100) / 100 + 'ms' + exitNote + budgetNote, 'ok');
    }
    /* Auto strategy sender: automatically send every created strategy to the
       AI Smart Trading Engine (paper trading) so it starts trading them without
       a manual "Send to Paper Trade" click. Strategies tagged with the saved
       engine template they were created under are also routed to every paper
       trade tab linked to that template. */
    const astPayload = resultsToAstPayload(deduped);
    if (autoSendOn && astPayload.length && window.AISmartTrading && AISmartTrading.importFromPaperTrade) {
      try {
        const sent = AISmartTrading.importFromPaperTrade(astPayload);
        log('Auto strategy sender: sent ' + sent + ' created strategy(s) to AI Smart (paper trade)', 'ok');
      } catch (e) {
        if (typeof console !== 'undefined' && console.error) console.error('autoSend failed', e);
        log('Auto strategy sender: failed to send strategies to AI Smart (paper trade) - ' + (e && e.message ? e.message : String(e)), 'warn');
      }
    }
    /* Also land the created strategies in the Paper Trade tab's Bullish /
       Bearish strategy lists so they are always visible there. The lists
       de-duplicate by template key, so re-runs never pile up duplicates. */
    if (autoSendOn && deduped.length && window.PaperStrategies && PaperStrategies.addFromAE) {
      try {
        const staged = PaperStrategies.addFromAE(deduped);
        if (staged) log('Auto strategy sender: added ' + staged + ' strategy(s) to the Paper Trade strategy lists', 'ok');
      } catch (e) {
        if (typeof console !== 'undefined' && console.error) console.error('autoSend staging failed', e);
      }
    }
    if (autoSendOn && deduped.length && typeof PaperTabs !== 'undefined' && PaperTabs.receiveFromAE) {
      try {
        const routed = PaperTabs.receiveFromAE(deduped);
        if (routed) log('Auto strategy sender: routed strategies to ' + routed + ' linked paper trade tab(s)', 'ok');
      } catch (e) {
        if (typeof console !== 'undefined' && console.error) console.error('autoSend tab routing failed', e);
      }
    }
    if (window.StrategyContainer && StrategyContainer.refresh) {
      try { StrategyContainer.refresh(); } catch (e) {}
    }
  } catch (e) {
    if (typeof console !== 'undefined' && console.error) console.error('runExperiment failed', e);
    if (gen === _runGen) log('Experiment failed: ' + (e && e.message ? e.message : String(e)), 'warn');
  } finally {
    // Only the newest run owns the run-state; superseded runs stay silent so
    // removeAll / a newer run are never overridden by a stale completion.
    if (gen === _runGen) {
      _running = false;
      setRunButton(false);
      setRunProgress(null);
    }
  }
  }

  /* Remove a single experiment result from the results list (does not touch the
     saved-strategy list). In grouped mode the key is a group key and removing it
     removes every per-symbol result of that strategy. */
  function removeResult(key) {
    _runGen++; // invalidate any in-flight run so stale results cannot reappear
    const before = state.results.length;
    if (key && key.indexOf('grp:') === 0) {
      const g = groupedResults().find(x => x.groupKey === key);
      if (g) {
        const drop = new Set(g.members.map(m => m.key));
        state.results = state.results.filter(r => !drop.has(r.key));
      }
    } else {
      state.results = state.results.filter(r => r.key !== key);
    }
    _selected.delete(key);
    if (state.results.length !== before) {
      save();
      render();
      log('Removed strategy from experiment results', '');
    }
  }

  /* Remove every experiment result at once. Also invalidates any in-flight
     experiment so a slow (network-bound) run that was started earlier can never
     re-populate results after the user cleared them. */
  function removeAllResults() {
    const hadResults = state.results.length > 0;
    _runGen++;
    _running = false; // allow an immediate fresh run even if a stale one lingers
    setRunButton(false);
    setRunProgress(null);
    state.results = [];
    state.lastRun = null;
    _selected.clear();
    // Invalidate the experiment data caches so the next "Run Experiment" fetches
    // fresh candles / option chains and re-backtests from scratch instead of
    // reusing the 2-minute cache and reproducing the very results just removed.
    _candleCache.clear();
    _optCandleCache.clear();
    _contractsCache.clear();
    _backtestCache.clear();
    save();
    render();
    log(hadResults ? 'Removed all experiment strategies' : 'No experiment results to remove', hadResults ? 'warn' : '');
  }

  /* ---------------- multi-select removal ---------------- */
  const _selected = new Set(); // result keys ticked via their card checkboxes

  function toggleSelect(key, checked) {
    if (checked) _selected.add(key); else _selected.delete(key);
    updateSelectionUI();
  }

  function selectAllResults() {
    const viewList = (state.groupByStrategy && state.results.length) ? groupedResults() : state.results;
    const allTicked = viewList.length > 0 && _selected.size === viewList.length;
    _selected.clear();
    if (!allTicked) viewList.forEach(r => _selected.add(r.__group ? r.groupKey : r.key));
    render();
  }

  function removeSelectedResults() {
    if (!_selected.size) { log('Select at least one strategy to remove', 'warn'); return; }
    _runGen++; // invalidate any in-flight run so stale results cannot reappear
    const before = state.results.length;
    if (state.groupByStrategy && _selected.size) {
      /* Grouped mode: removing a ticked group removes every per-symbol result
         of that strategy. */
      const gs = groupedResults().filter(g => _selected.has(g.groupKey));
      const drop = new Set();
      gs.forEach(g => g.members.forEach(m => drop.add(m.key)));
      state.results = state.results.filter(r => !drop.has(r.key));
    } else {
      state.results = state.results.filter(r => !_selected.has(r.key));
    }
    _selected.clear();
    if (state.results.length !== before) {
      save();
      render();
      log('Removed ' + (before - state.results.length) + ' selected strategy(s)', 'warn');
    }
  }

  function updateSelectionUI() {
    const btn = $id('aeRemoveSelected');
    if (btn) btn.textContent = 'Remove Selected' + (_selected.size ? ' (' + _selected.size + ')' : '');
    const sel = $id('aeSelectAll');
    const viewCount = (state.groupByStrategy && state.results.length) ? groupedResults().length : state.results.length;
    if (sel) sel.textContent = (viewCount && _selected.size === viewCount) ? 'Clear Selection' : 'Select All';
  }

  /* ---------------- live paper-trading loop ---------------- */
  let _pollTimer = null;


  /* Per-position incremental AI Trail TP engines (aitrail.js). Same
     replay-over-new-bars pattern: O(1)-amortized per tick, well under 10ms
     even with many open positions. */
  const _aiTrailEngines = {};
  function aiTrailEngineFor(posKey, side, baseTp, candles) {
    const c = candles || [];
    const n = c.length;
    if (n < 2 || !window.AiTrailEngine) return null;
    let e = _aiTrailEngines[posKey];
    if (!e || e.side !== side || e.count > n) {
      e = _aiTrailEngines[posKey] = { eng: window.AiTrailEngine.create(side, baseTp), count: 0, side: side };
    }
    const eng = e.eng;
    for (let i = e.count; i < n; i++) eng.update(c[i]);
    e.count = n;
    eng.setBase(baseTp);
    return eng;
  }
  function dropAiTrailEngine(posKey) {
    delete _aiTrailEngines[posKey];
  }

  /* ---------------- per-day trade budget (Max trades / AI auto trades) ---- */
  /* Live paper trades taken per strategy (result key) for the current market
     day. Counters reset automatically at the start of each new IST day so a
     fresh budget applies every session. */
  const _tradeCounts = {};
  let _tradeCountDay = '';
  const _aiTradesCache = { sig: '', dec: null };

  function istDay() {
    const d = new Date(Date.now() + 5.5 * 3600 * 1000);
    return d.getUTCFullYear() + '-' + (d.getUTCMonth() + 1) + '-' + d.getUTCDate();
  }

  function isMarketOpenNow() {
    try {
      const now = Math.floor(Date.now() / 1000);
      if (typeof isMarketOpen === 'function') return !!isMarketOpen(now);
    } catch (e) {}
    return true;
  }

  /* ---- open/close time gates ----
     The "start trading after" and "no trade after" selectors restrict when a
     strategy may open new trades. Candle timestamps are stored as IST wall-clock
     encoded as naive UTC (see app.py), so the UTC fields of a candle's Date
     already read as IST and can be compared directly against the chosen window
     without any timezone offset. */
  function istMinuteOfDay(ts) {
    const d = new Date(ts * 1000);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }
  /* Day key (YYYY-MM-DD, IST wall-clock) for a candle timestamp. Candle times
     are IST encoded as naive UTC (see app.py), so the UTC date fields read as
     the IST date. Used to group backtest trades into daily buckets. */
  function istDayKey(ts) {
    const d = new Date(Number(ts) * 1000);
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return d.getUTCFullYear() + '-' + m + '-' + day;
  }
  /* Human label for a day key: "22 Aug 2026". */
  function istDayLabel(key) {
    const mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const p = String(key || '').split('-');
    if (p.length !== 3) return key || '';
    return Number(p[2]) + ' ' + (mons[Number(p[1]) - 1] || p[1]) + ' ' + p[0];
  }

  /* Aggregate a trades list into per-day buckets plus overall totals and the
     reward:risk ratio. Each bucket carries trades / wins / losses / win rate /
     net return % / RR (avg win % / avg loss %). RR of 99 means no losing trade
     (win side only); 0 means no winning trade. */
  function dailyMetrics(tradesList) {
    const days = {};
    let allTrades = 0, allWins = 0, allLosses = 0, allWinSum = 0, allLossSum = 0, allRet = 0;
    for (const t of tradesList || []) {
      const d = t.day || '?';
      if (!days[d]) days[d] = { day: d, trades: 0, wins: 0, losses: 0, ret: 0, winSum: 0, lossSum: 0 };
      const b = days[d];
      b.trades++;
      b.ret += (t.ret || 0);
      const g = (t.grossRet != null ? t.grossRet : t.ret) || 0;
      if (g >= 0) { b.wins++; b.winSum += g; } else { b.losses++; b.lossSum += -g; }
      allTrades++;
      allRet += (t.ret || 0);
      if (g >= 0) { allWins++; allWinSum += g; } else { allLosses++; allLossSum += -g; }
    }
    const fmtD = (b) => {
      b.winRate = b.trades ? Math.round(b.wins / b.trades * 1000) / 10 : 0;
      b.ret = Math.round(b.ret * 100) / 100;
      b.rr = b.losses > 0
        ? Math.round((b.winSum / b.wins) / (b.lossSum / b.losses) * 100) / 100
        : (b.wins > 0 ? 99 : 0);
      return b;
    };
    const daily = Object.keys(days).map(k => fmtD(days[k])).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    let rr = 0;
    if (allLosses > 0) rr = Math.round((allWinSum / Math.max(1, allWins)) / (allLossSum / allLosses) * 100) / 100;
    else if (allWins > 0) rr = 99;
    const overall = {
      trades: allTrades,
      wins: allWins,
      losses: allLosses,
      winRate: allTrades ? Math.round(allWins / allTrades * 1000) / 10 : 0,
      ret: Math.round(allRet * 100) / 100,
      rr: rr
    };
    return { daily, overall };
  }
  function timeToMin(str) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }
  /* True when an IST minute-of-day falls inside the allowed trading window.
     A disabled gate imposes no restriction; a gate with no parseable time
     (sanitizeState keeps defaults) also imposes none. */
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

  /* One-shot "auto square off" gate: true only the first time the live IST clock
     reaches the configured square-off time on any given session day. The engine
     cuts every open deployed position once, so a browser reload / long-running
     session never re-triggers the exit repeatedly for the same day. */
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
    if (day !== _tradeCountDay) {
      _tradeCountDay = day;
      Object.keys(_tradeCounts).forEach(k => delete _tradeCounts[k]);
    }
  }

  /* AI auto-trades decision, cached against the newest candle so the O(90-bar)
     analysis runs once per new bar instead of every 1.5 s tick. `ctx` may carry
     live Open Interest ({oi, oiPrev}) which the engine blends into its score. */
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

  /* Effective trade budget for a result on the current tick. null = unlimited. */
  function allowedTradesFor(r, candles) {
    const u = state.universal;
    if (!liveTimeGateOk()) return 0; // open/close time gate blocks new entries
    if (u && u.aiTrades) {
      if (!isMarketOpenNow()) return 0; // market open time condition
      aiTradesDecisionFor(candles, liveOICtx(r));
      return null;
    }
    if (u && u.tradeLimitEnabled && Number(u.tradeLimitCount) > 0) return Number(u.tradeLimitCount);
    return null;
  }

  /* Live Open Interest context for the AI engine: the option's current OI from
     the WebSocket-fed quote cache, plus the previously seen OI so the engine can
     score OI change%. Falls back to the underlying symbol's quote when the
     result is not strike-scoped. `oiPrev` is tracked per instrument. */
  const _oiPrev = {};
  function liveOICtx(r) {
    let q = null;
    if (r && r.optionSid != null && typeof clientQuotes !== 'undefined' && clientQuotes) {
      q = clientQuotes[String(r.optionSid)];
    } else if (r && r.symbol && typeof clientQuotes !== 'undefined' && clientQuotes) {
      const s = r.symbol;
      q = clientQuotes[s.exch === 'IDX_I' ? 'IDX_I:' + s.id : String(s.id)];
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

  /* Live pipeline progress for a running strategy, surfaced on its row in the
     Running Strategies view. `pct` is the furthest stage reached in the last
     tick's entry pipeline and `status` the human-readable reason it stopped
     there (waiting signal, blocked by a gate, entry rejected, entry placed). */
  const _aeProg = state.runProgress || (state.runProgress = {});
  function prog(key, pct, status) {
    if (!key) return;
    _aeProg[key] = { pct: Math.max(0, Math.min(100, Math.round(pct))), status: String(status || ''), updated: Date.now() };
  }



  /* Whether the strategy's entry conditions currently fire on the given candle
     series, without edge detection or signal mutation. Used both by the normal
     live entry path and by the "both" run-in dual-confirmation path. */
  function entryFireState(r, candles) {
    const last = candles.length - 1;
    return evalCondAll(r.entry, last, candles) &&
      (r.entryExtra && r.entryExtra.length
        ? evalCondNof(r.entryExtra, (r.entryThreshold != null && r.entryThreshold >= 1) ? r.entryThreshold : r.entryExtra.length, last, candles)
        : true) &&
      (!r.candlestick || !r.candlestick.entry || !r.candlestick.entry.length ? true : patternHitAt(r.candlestick.entry, last, candles));
  }

  function startPoll() {
    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = setInterval(() => { refreshNiftyStatus(); renderMoversList(); renderNiftyTrendList(); renderPickedStrikes(); populateAutoSendTplUI(); }, 1500);
  }
  function stopPoll() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  }
  /* Keep the NIFTY ensemble-trend status and the BB%B live values on screen
     even when no strategies are being ticked. niftyBias() is rate-limited by
     its own 60s cache, so this only re-fetches candles at most once a minute
     while the displayed reading refreshes on every poll. */
  function refreshNiftyStatus() {
    niftyBias().then(b => { if (b) { updateNiftyBiasStatus(b); _lastNiftyDir = b.dir; } });
  }

  /* ---------------- log ---------------- */
  function log(msg, cls) {
    const el = $id('aeLog');
    if (!el) return;
    const d = new Date();
    const ts = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
    const col = cls === 'buy' ? '#00d4aa' : (cls === 'sell' ? '#ef5350' : (cls === 'warn' ? '#ff9800' : (cls === 'ok' ? '#00d4aa' : '#888')));
    const div = document.createElement('div');
    div.innerHTML = '<span style="color:#555">' + ts + '</span> <span style="color:' + col + '">' + esc(msg) + '</span>';
    el.appendChild(div);
    while (el.children.length > 60) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
  }

  /* ---------------- UI rendering ---------------- */
  function condLabel(c, isEntry) {
    if (Array.isArray(c)) return c.map(x => condLabel(x, isEntry)).join(' AND ');
    if (!c) return 'none';
    if (c.cmpType === 'candlestick_pattern' || c.cmpType === 'pattern') {
      return (c.candlePatterns || []).map(patternName).join(', ');
    }
    if (c.logic === 'volUp') return 'Volume increasing';
    if (c.logic === 'volDown') return 'Volume decreasing';
    if (c.logic === 'fakeBreakout') return c.dir === -1 ? 'Fake breakout (bearish)' : 'Fake breakout (bullish)';
    if (c.logic === 'reversal') return c.dir === -1 ? 'Reversal (bearish)' : 'Reversal (bullish)';
    if (c.logic === 'closeCrossAbove' || c.logic === 'closeCrossBelow') {
      const band = indName(c.indId) + (c.valueKey === 'v1' ? ' middle band' : '');
      const expand = (c.expand && c.indId === 'bb') ? ' with upper and lower band expansion' : '';
      return 'Candle close ' + (c.logic === 'closeCrossAbove' ? 'crossed above' : 'crossed below') + ' ' + band + expand;
    }
    if (!c.indId) return 'none';
    const primary = indName(c.indId);
    const logicMap = { gt: '>', lt: '<', gte: '>=', lte: '<=', eq: '=', neq: '!=', crossAbove: 'crosses above', crossBelow: 'crosses below', incUp: 'increasing upward', incDown: 'increasing downward', gapUp: 'gap increasing vs', gapDown: 'gap decreasing vs', incUpAll: 'increasing upward (all)', incDownAll: 'increasing downward (all)' };
    const lg = logicMap[c.logic] || c.logic;
    if (c.logic === 'incUp' || c.logic === 'incDown' || c.logic === 'incUpAll' || c.logic === 'incDownAll') return primary + ' ' + lg;
    let cmp;
    if (c.cmpType === 'number') cmp = c.number;
    else if (c.cmpType === 'candle') cmp = 'candle ' + (c.candleKey || 'close');
    else if (c.cmpType === 'smoothed') cmp = 'signal (' + indName(c.indId) + ')';
    else if (c.cmpType === 'plot') cmp = 'plot (' + indName(c.indId) + ')';
    else if (c.cmpType === 'indicator') cmp = indName(c.cmpIndId) + indSettingsLabel(c.cmpSettings);
    else cmp = '?';
    return primary + indSettingsLabel(c.indSettings) + ' ' + lg + ' ' + cmp;
  }

  /* Compact "(k, v)" label for the numeric settings of an indicator, so a cross
     filter reads like "EMA (9) crosses above EMA (18)". */
  function indSettingsLabel(settings) {
    if (!settings) return '';
    const keys = ['length', 'fast', 'slow', 'signal', 'atrPeriod', 'factor', 'maLength', 'smooth', 'signalLength', 'mult'];
    const parts = [];
    keys.forEach(k => {
      if (settings[k] != null && settings[k] !== '') parts.push(k + '=' + settings[k]);
    });
    if (!parts.length) return '';
    return ' (' + parts.join(', ') + ')';
  }

  function render() {
    const host = $id('aeResults');
    if (!host) return;
    const rEl = $id('aeRunInfo');
    if (rEl && state.lastRun) {
      const symTxt = state.lastRun.symbols && state.lastRun.symbols.length
        ? state.lastRun.symbols.join(', ')
        : (state.lastRun.symbol || 'chart symbol');
      rEl.textContent = 'Last run: ' + state.lastRun.candles + ' candles on ' + symTxt + ' ' + state.lastRun.tf + ' in ' + state.lastRun.ms + 'ms (kept ' + (state.lastRun.kept != null ? state.lastRun.kept : '?') + '/' + (state.lastRun.total != null ? state.lastRun.total : '?') + ' profitable)';
    } else if (rEl) {
      rEl.textContent = 'No experiment run yet';
    }
    const autoBtn = $id('aeAutoToggle');
    if (autoBtn) { autoBtn.textContent = state.enabled ? 'Auto Strategy: ON' : 'Auto Strategy: OFF'; autoBtn.style.background = state.enabled ? '#00d4aa' : '#e67e22'; }
    const sendBtn = $id('aeSendToPaper');
    if (sendBtn) sendBtn.textContent = 'Send to Paper Trade' + (_selected.size ? ' (' + _selected.size + ')' : '');
    const gbEl = $id('aeGroupByToggle');
    if (gbEl) gbEl.checked = !!state.groupByStrategy;
    if (!state.results.length) {
      host.innerHTML = '<div class="strat-empty">Run an experiment to generate and rank strategies.</div>';
      updateSelectionUI();
      return;
    }
    const em = activeExitMode();
    const emU = state.universal || {};
    /* Grouped view: when "Group by strategy" is ON, one card per strategy
       (aggregating every backtested symbol) instead of one card per symbol. */
    const viewList = (state.groupByStrategy && state.results.length) ? groupedResults() : state.results;
    host.innerHTML = viewList.map(r => {
      const m = r.metrics || {};
      // Net/avg P&L shown option-geared so index AND F&O-stock results both
      // report the option's return rather than the underlying's raw move.
      // Grouped cards already carry the averaged, option-adjusted values.
      const netPct = r.__group ? (m.totalReturn || 0) : optionPct(r, m.totalReturn || 0);
      const avgPct = r.__group ? (m.avgTrade || 0) : optionPct(r, m.avgTrade || 0);
      const mCol = netPct >= 0 ? '#00d4aa' : '#ef5350';
      const vCol = r.verdict === 'Elite' ? '#ffd700' : (r.verdict === 'Good' ? '#00d4aa' : (r.verdict === 'Moderate' ? '#ff9800' : '#888'));
      const cardKey = r.__group ? r.groupKey : r.key;
      const symTxt = r.__group
        ? ' &middot; ' + r.symbolCount + ' symbol' + (r.symbolCount === 1 ? '' : 's') + ' (' + r.symbols.slice(0, 3).join(', ') + (r.symbolCount > 3 ? '...' : '') + ')'
        : (r.symbol ? ' &middot; ' + esc(displayName(r.symbol)) : '');
      return '<div class="strat-card" data-ae="' + esc(cardKey) + '">' +
        '<div class="strat-head"><input type="checkbox" class="ae-sel" data-key="' + esc(cardKey) + '"' + (_selected.has(cardKey) ? ' checked' : '') + ' style="width:12px;height:12px;flex:0 0 auto;accent-color:#00d4aa"> <span class="strat-name">' + esc(r.name) + (r.source === 'manual' ? ' <span style="color:#66ccff;font-size:9px">(manual)</span>' : '') + (r.__group ? ' <span style="color:#66ccff;font-size:9px">(all symbols)</span>' : '') + '</span>' +
        '<span style="color:' + vCol + ';font-weight:700;font-size:10px">' + esc(r.verdict) + ' ' + r.score + '</span></div>' +
        '<div class="strat-meta">' + esc(r.method) + ' &middot; ' + esc(r.cat) + symTxt + (r.optionStrike != null && !r.__group ? ' &middot; ' + r.optionStrike + ' ' + esc(r.optionType) : '') + (r.premium != null && !r.__group ? ' &middot; prem ' + r.premium : '') + (em.manualSLOn ? ' &middot; manual SL ' + (Number(emU.manualSLPct) || 0) + '%' : (r.autoSlPct ? ' &middot; auto SL ' + r.autoSlPct + '%' : '')) + ' &middot; TF ' + esc(r.tf || (typeof chartTf !== 'undefined' ? chartTf : '5min')) + (r.aiTf ? ' &middot; <span style="color:#b39ddb">AI-picked</span>' : '') + ' &middot; ' + (m.trades || 0) + ' trades &middot; WR ' + (m.winRate || 0) + '% &middot; PF ' + (m.profitFactor || 0) + ' &middot; MaxDD ' + (m.maxDrawdown || 0) + '%' + (m.dailyOverall && m.dailyOverall.rr ? ' &middot; RR ' + m.dailyOverall.rr + ' : 1' : '') + (r.engineTpl && r.engineTpl.name ? ' <span style="color:#b39ddb;border:1px solid #2d2d50;border-radius:3px;padding:0 4px;font-weight:700">[' + esc(r.engineTpl.name) + ']</span>' : '') + '</div>' +
        (r.filters && r.filters.length ? '<div class="strat-meta" style="color:#ffd700;font-size:8px">Filters: ' + esc(r.filters.join(' AND ')) + '</div>' : '') +
        '<div class="strat-meta" style="font-size:8px;color:#888">' + tradeBasisLabel(r) + '</div>' +
        (em.anyManual
          ? '<div class="strat-meta" style="color:#ffd700;font-size:8px">Exit: ' + esc(em.label) + ' (manual - AI auto risk inactive)</div>'
          : ((state.universal && state.universal.aiTp !== false) ? '<div class="strat-meta" style="color:#b39ddb;font-size:8px">Exit: auto SL + AI Trail TP (combined)</div>' : '')) +
        '<div class="strat-meta" style="color:' + mCol + '">Net ' + (netPct >= 0 ? '+' : '') + Math.round(netPct * 100) / 100 + '% &middot; Avg ' + Math.round(avgPct * 100) / 100 + '%/trade' + ((state.universal && state.universal.deductBrokerCharges === true) ? ' <span style="color:#ffd700">&middot; after broker charges (' + ((state.universal.brokerChargeMode === 'dhan') ? 'Dhan auto' : fmtINR(Number(state.universal.brokerChargePerTrade) || 0) + '/trade') + ')</span>' : '') + '</div>' +
        '<div class="strat-meta" style="font-size:8px;color:#666">' + esc(r.research || '') + '</div>' +
        '<div class="strat-actions" style="flex-wrap:wrap">' +
        '<button class="sbtn" onclick="AutoExperiment.detail(\'' + esc(cardKey) + '\')">Detail</button>' +
        '<button class="sbtn stop" onclick="AutoExperiment.remove(\'' + esc(cardKey) + '\')">Remove</button>' +
        '</div></div>';
    }).join('');

    // Wire multi-select checkboxes
    host.querySelectorAll('.ae-sel').forEach(cb => {
      cb.addEventListener('change', () => toggleSelect(cb.dataset.key, cb.checked));
    });
    updateSelectionUI();
  }

  /* Collapse a results list to one entry per distinct strategy: symbol x
     template (or manual strategy) x strike x option-type x execution basis,
     ignoring the timeframe dimension, keeping the highest-scoring variant.
     Guards against duplicate cards from stale saved state or any residual
     multi-timeframe overlap in the backtest pipeline. */
  function dedupeResults(list) {
    if (!Array.isArray(list) || !list.length) return list || [];
    const best = new Map();
    for (const r of list) {
      if (!r || !r.key) continue;
      const symId = r.symbol ? (String(r.symbol.id) + ':' + (r.symbol.exch || '')) : '__';
      const base = r.source === 'manual' ? ('manual:' + (r.manualId || '')) : (r.tplKey || r.key || '');
      const leg = (r.optionStrike != null) ? (r.optionStrike + ':' + r.optionType) : 'u';
      const k = symId + '|' + base + '|' + leg + '|' + (r.backtestBasis || r.runBasis || '');
      const cur = best.get(k);
      if (!cur || (r.score || 0) > (cur.score || 0)) best.set(k, r);
    }
    return Array.from(best.values());
  }

  /* Group identity: symbol + template (or manual strategy). All strikes of the
     same group are listed together in the detail view. */
  function familyKey(x) {
    const symId = x.symbol ? (String(x.symbol.id) + ':' + (x.symbol.exch || '')) : '__';
    const base = x.source === 'manual' ? ('manual:' + (x.manualId || '')) : (x.tplKey || x.key || '');
    return symId + ':' + base;
  }

  /* Strategy-level identity of a result that ignores BOTH the symbol and the
     strike: the template (or manual strategy) alone. Used by the "Group by
     strategy" view to collapse every result of the same strategy across all
     backtested symbols into a single card. */
  function strategyKeyOf(x) {
    if (!x) return '';
    return x.source === 'manual' ? ('manual:' + (x.manualId || '')) : (x.tplKey || x.key || '');
  }

  /* Build the grouped view: one entry per strategy, aggregating its per-symbol
     results. Each group keeps the best-scoring member as the representative
     (for the entry/exit/indicator definition) and averages the per-symbol
     metrics so the card + detail show the whole-universe performance. */
  function groupedResults() {
    const groups = new Map();
    (state.results || []).forEach(r => {
      if (!r || !r.key) return;
      const gk = strategyKeyOf(r);
      if (!gk) return;
      if (!groups.has(gk)) groups.set(gk, []);
      groups.get(gk).push(r);
    });
    const out = [];
    groups.forEach((members, gk) => {
      const rep = members.slice().sort((a, b) => (b.score || 0) - (a.score || 0))[0] || members[0];
      const netPcts = members.map(m => optionPct(m, (m.metrics && m.metrics.totalReturn) || 0));
      const avgPcts = members.map(m => optionPct(m, (m.metrics && m.metrics.avgTrade) || 0));
      const winRates = members.map(m => (m.metrics && m.metrics.winRate) || 0);
      const pfs = members.map(m => (m.metrics && m.metrics.profitFactor) || 0);
      const trades = members.reduce((s, m) => s + ((m.metrics && m.metrics.trades) || 0), 0);
      const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
      const agg = {
        trades: trades,
        winRate: avg(winRates),
        profitFactor: avg(pfs),
        totalReturn: avg(netPcts),
        avgTrade: avg(avgPcts),
        maxDrawdown: Math.max.apply(null, members.map(m => (m.metrics && m.metrics.maxDrawdown) || 0))
      };
      const score = scoreOf(agg);
      out.push(Object.assign({}, rep, {
        __group: true,
        groupKey: 'grp:' + gk,
        members: members,
        metrics: agg,
        score: score,
        verdict: verdict(score),
        symbolCount: members.length,
        symbols: members.map(m => displayName(m.symbol))
      }));
    });
    out.sort((a, b) => (b.score || 0) - (a.score || 0));
    return out;
  }

  /* Human-readable "where the backtest trade was executed" label for a result.
     backtestBasis === 'option' means the simulated trades were priced on the
     selected-strike option premium chart; 'underlying' means they were priced
     on the underlying/spot chart. */
  function tradeBasisLabel(r) {
    return (r && r.backtestBasis === 'option')
      ? '<span style="color:#00d4aa">backtest trade executed on: option premium chart</span>'
      : '<span style="color:#ff9800">backtest trade executed on: spot chart</span>';
  }

  /* Option-aware P&L percentage for a result. Index results are backtested on
     the option-premium chart, so their return is already the option's move.
     F&O stock results are also always backtested on the selected-strike option
     premium chart (signals run on the spot chart, trades execute on the premium
     chart); if the option chain cannot be resolved the F&O symbol is skipped,
     never backtested on the underlying. Only an index run with trade-in = spot
     (or the documented 'both' run-in degrade) produces underlying-backtested
     results, and those are converted to an option return via delta gearing
     before being shown as a percentage P&L. */
  function optionPct(x, rawRet) {
    if (x && x.backtestBasis === 'underlying') {
      const premium = (x.premium != null) ? Number(x.premium) : null;
      const delta = (x.delta != null) ? Number(x.delta) : null;
      const spot = (x.spot != null) ? Number(x.spot) : null;
      // Only gear when we have a real premium, a non-zero delta and a real spot;
      // otherwise fall back to the underlying's raw return (a zero/missing delta
      // means greeks are unavailable and gearing would wrongly zero the P&L).
      if (premium > 0 && delta && spot > 0) return delta * spot * rawRet / premium;
    }
    return rawRet;
  }

  /* Best available option premium for a strike: the live WebSocket-fed quote
     for its option security id when available, else the option-chain snapshot
     premium captured at experiment time. The live premium keeps each strike's
     lot price / rupee P&L accurate even for illiquid strikes whose last traded
     price on the chain snapshot is stale. */
  function livePremium(x) {
    if (x && x.optionSid != null && typeof clientQuotes !== 'undefined' && clientQuotes) {
      const q = clientQuotes[String(x.optionSid)];
      if (q && q.ltp) return Number(q.ltp);
    }
    return (x.premium != null) ? Number(x.premium) : null;
  }

  /* Rupee summary for a result: total lot price and estimated P&L in rupees,
     priced from the live option premium (with delta gearing) when available. */
  function rupeeMetricsFor(x) {
    const lotSize = state.universal && state.universal.lotSize != null
      ? state.universal.lotSize
      : ((window.PaperTrade && PaperTrade.lotSizeFor) ? PaperTrade.lotSizeFor(x.symbol || null) : 1);
    const lots = (state.universal && state.universal.lots) || 1;
    const qty = Math.max(1, Math.round(lots * (Number(lotSize) || 1)));
    const premium = livePremium(x);
    const retPct = (x.metrics && x.metrics.totalReturn != null) ? Number(x.metrics.totalReturn) : 0;
    const optPct = optionPct(x, retPct);
    let lotPrice, pnlRs;
    if (x.optionStrike != null) {
      // Strike-scoped: price from the option premium (per unit x qty). A missing
      // premium means an illiquid/stale strike, so report 0 rather than wrongly
      // substituting the underlying spot.
      const p = (premium != null && premium > 0) ? premium : 0;
      lotPrice = p * qty;
      pnlRs = p * (optPct / 100) * qty;
    } else {
      const ref = (premium != null && premium > 0) ? premium : ((x.spot != null) ? Number(x.spot) : 0);
      lotPrice = ref * qty;
      pnlRs = (optPct / 100) * ref * qty;
    }
    return { lotPrice, pnlRs, qty, premium, optPct };
  }

  /* Effective risk-management mode for display, mirroring the engine gate:
     Manual Stop-Loss / Manual Trail TP / Manual TP % override the
     AI when ticked, so the UI must never describe auto-decided SL / TP while a
     manual rule is enabled. */
  function activeExitMode() {
    const u = state.universal || {};
    const manualSLOn = u.manualSL === true;
    const manualTrailTPOn = u.manualTrailTP === true;
    const manualTPOn = u.manualTP === true;
    const aiSlOn = !manualSLOn && u.aiSl !== false;
    const aiTpOn = !manualTrailTPOn && u.aiTp !== false;
    const aiTPOn = !manualTPOn && u.aiTP !== false;
    const parts = [];
    if (manualSLOn) parts.push('Manual SL ' + (Number(u.manualSLPct) || 0) + '%');
    else if (aiSlOn) parts.push('Auto SL (engine-decided)');
    if (manualTrailTPOn) parts.push('Manual Trail TP ' + (Number(u.manualTrailTPPct) || 0) + '%');
    else if (manualTPOn) parts.push('Manual TP ' + (Number(u.manualTPPct) || 0) + '%');
    else if (aiTPOn) parts.push('AI TP %');
    else if (aiTpOn) parts.push('AI Trail TP');
    return {
      manualSLOn, manualTrailTPOn, manualTPOn, aiSlOn, aiTpOn, aiTPOn,
      label: parts.length ? parts.join(' + ') : 'Disabled',
      anyManual: manualSLOn || manualTrailTPOn || manualTPOn,
      autoActive: aiSlOn || aiTpOn || aiTPOn
    };
  }

  function detail(key) {
    /* Grouped-mode detail: show the strategy definition once and a per-symbol
       summary table (each symbol's own P&L, net, avg per trade, WR, PF, MaxDD)
       plus an overall average row at the end - instead of one big trade list. */
    if (key && key.indexOf('grp:') === 0) {
      const g = groupedResults().find(x => x.groupKey === key);
      if (!g) return;
      const mEl = $id('aeDetailModal');
      if (!mEl) return;
      $id('aeDetailTitle').textContent = g.name + ' (all ' + g.symbolCount + ' symbols)';
      const entryStr = condLabel(g.entry, true);
      const entryExtraStr = condLabel(g.entryExtra, true);
      const exitStr = condLabel(g.exit, false);
      const exitExtraStr = condLabel(g.exitExtra, false);
      let patStr = 'none';
      if (g.candlestick) {
        const pe = (g.candlestick.entry || []).map(patternName).join(', ') || 'none';
        const px = (g.candlestick.exit || []).map(patternName).join(', ') || 'none';
        patStr = 'Entry: ' + pe + ' &middot; Exit: ' + px;
      }
      const em = activeExitMode();
      const u = state.universal || {};
      const symRows = g.members.map(m => {
        const mm = m.metrics || {};
        const netPct = optionPct(m, mm.totalReturn || 0);
        const avgPct = optionPct(m, mm.avgTrade || 0);
        const col = netPct >= 0 ? '#00d4aa' : '#ef5350';
        return '<tr>' +
          '<td>' + esc(displayName(m.symbol)) + '</td>' +
          '<td>' + (mm.trades || 0) + '</td>' +
          '<td style="color:' + ((mm.winRate || 0) >= 50 ? '#00d4aa' : '#ef5350') + '">' + (mm.winRate || 0) + '%</td>' +
          '<td>' + (mm.profitFactor || 0) + '</td>' +
          '<td style="color:' + col + '">' + (netPct >= 0 ? '+' : '') + Math.round(netPct * 100) / 100 + '%</td>' +
          '<td style="color:' + col + '">' + (avgPct >= 0 ? '+' : '') + Math.round(avgPct * 100) / 100 + '%</td>' +
          '<td>' + (mm.maxDrawdown || 0) + '%</td>' +
          '<td>' + esc(m.verdict || '') + ' ' + (m.score || 0) + '</td>' +
          '</tr>';
      }).join('');
      const agg = g.metrics || {};
      const avgCol = (agg.totalReturn || 0) >= 0 ? '#00d4aa' : '#ef5350';
      const avgRow = '<tr style="border-top:1px solid #2d2d50;font-weight:700">' +
        '<td style="color:#ffd700">Overall average (' + g.symbolCount + ' symbol' + (g.symbolCount === 1 ? '' : 's') + ')</td>' +
        '<td style="color:#ffd700">' + (agg.trades || 0) + '</td>' +
        '<td style="color:#ffd700">' + (agg.winRate || 0) + '%</td>' +
        '<td style="color:#ffd700">' + (agg.profitFactor || 0) + '</td>' +
        '<td style="color:' + avgCol + '">' + ((agg.totalReturn || 0) >= 0 ? '+' : '') + Math.round((agg.totalReturn || 0) * 100) / 100 + '%</td>' +
        '<td style="color:' + avgCol + '">' + ((agg.avgTrade || 0) >= 0 ? '+' : '') + Math.round((agg.avgTrade || 0) * 100) / 100 + '%</td>' +
        '<td>' + (agg.maxDrawdown || 0) + '%</td>' +
        '<td style="color:#ffd700">' + esc(g.verdict || '') + ' ' + (g.score || 0) + '</td>' +
        '</tr>';
      $id('aeDetailBody').innerHTML =
        '<div style="margin:6px 0"><b style="color:#00d4aa">Method:</b> ' + esc(g.method) + '</div>' +
        '<div style="margin:6px 0"><b style="color:#00d4aa">Category:</b> ' + esc(g.cat) + ' &middot; <b style="color:#00d4aa">Timeframe:</b> ' + esc(g.tf || (typeof chartTf !== 'undefined' ? chartTf : '5min')) + '</div>' +
        (g.filters && g.filters.length ? '<div style="margin:6px 0"><b style="color:#ffd700">Entry filters:</b> ' + esc(g.filters.join(' AND ')) + '</div>' : '') +
        '<div style="margin:6px 0"><b style="color:#00d4aa">Entry:</b> ' + esc(entryStr) + '</div>' +
        (entryExtraStr && entryExtraStr !== 'none' ? '<div style="margin:6px 0"><b style="color:#00d4aa">Entry extra:</b> ' + esc(entryExtraStr) + '</div>' : '') +
        '<div style="margin:6px 0"><b style="color:#00d4aa">Exit:</b> ' + esc(exitStr) + '</div>' +
        (exitExtraStr && exitExtraStr !== 'none' ? '<div style="margin:6px 0"><b style="color:#00d4aa">Exit extra:</b> ' + esc(exitExtraStr) + '</div>' : '') +
        '<div style="margin:6px 0"><b style="color:#00d4aa">Candlestick:</b> ' + patStr + '</div>' +
        '<div style="margin:8px 0"><b style="color:#00d4aa">Per-symbol backtest summary (' + g.symbolCount + ' symbol' + (g.symbolCount === 1 ? '' : 's') + '):</b>' +
          '<table style="width:100%;border-collapse:collapse;font-size:9px;margin-top:4px">' +
          '<thead><tr style="color:#888"><th>Symbol</th><th>Trades</th><th>Win %</th><th>PF</th><th>Net P&amp;L</th><th>Avg/Trade</th><th>MaxDD</th><th>Verdict</th></tr></thead>' +
          '<tbody>' + symRows + avgRow + '</tbody></table>' +
        '</div>' +
        '<div style="margin:6px 0;color:#888;font-size:10px">' + esc(g.research || '') + '</div>';
      mEl.classList.remove('hidden');
      return;
    }

    const r = state.results.find(x => x.key === key);
    if (!r) return;
    const m = $id('aeDetailModal');
    if (!m) return;
    const u = state.universal || {};
    const em = activeExitMode();
    $id('aeDetailTitle').textContent = r.name;
    const entryStr = condLabel(r.entry, true);
    const entryExtraStr = condLabel(r.entryExtra, true);
    const exitStr = condLabel(r.exit, false);
    const exitExtraStr = condLabel(r.exitExtra, false);
    let patStr = 'none';
    if (r.candlestick) {
      const pe = (r.candlestick.entry || []).map(patternName).join(', ') || 'none';
      const px = (r.candlestick.exit || []).map(patternName).join(', ') || 'none';
      patStr = 'Entry: ' + pe + ' &middot; Exit: ' + px;
    }

    // Complete P&L table: every closed trade from the backtest, in % and ₹.
    const tl = (r.metrics.tradesList || []);
    const lotSize = state.universal && state.universal.lotSize != null
      ? state.universal.lotSize
      : ((window.PaperTrade && PaperTrade.lotSizeFor) ? PaperTrade.lotSizeFor(r.symbol || null) : 1);
    const lots = (state.universal && state.universal.lots) || 1;
    const qty = Math.max(1, Math.round(lots * (Number(lotSize) || 1)));
    const premium = livePremium(r);
    const delta = (r.delta != null) ? Number(r.delta) : null;
    /* Premium-chart backtests have trade entries/exits priced on the option
       premium chart itself, so every trade's lot price and rupee P&L are
       computed off THAT trade's own entry/exit premium x qty - never a shared
       constant premium. Underlying-basis fallback results keep the live-premium
       reference pricing. */
    const optBasis = r.backtestBasis === 'option' || r.optionStrike != null;
    /* Broker charges enabled: every trade row shows Gross %, the per-trade
       broker charge and Net % (Net ₹ = Gross ₹ - charge). Disabled keeps the
       plain single P&L columns. */
    const brkOn = !!(state.universal && state.universal.deductBrokerCharges === true);
    let rupeeTotal = 0;
    let brokerTotal = 0;
    let entryBrokerTotal = 0;
    let exitBrokerTotal = 0;
    let pnlRows = '';
    if (tl.length) {
      pnlRows = tl.map((t, i) => {
        const netOptPct = optionPct(r, t.ret);
        const grossOptPct = optionPct(r, (t.grossRet != null ? t.grossRet : t.ret));
        const grossCol = grossOptPct >= 0 ? '#00d4aa' : '#ef5350';
        const netCol = netOptPct >= 0 ? '#00d4aa' : '#ef5350';
        const brk = (t.brokerRs != null && t.brokerRs > 0) ? t.brokerRs : 0;
        const brkIn = (t.entryChargesRs != null && t.entryChargesRs > 0) ? t.entryChargesRs : 0;
        const brkOut = (t.exitChargesRs != null && t.exitChargesRs > 0) ? t.exitChargesRs : 0;
        // Option-aware rupee P&L: premium moves ~ delta x underlying move.
        let rsGross, rsNet, val;
        if (optBasis) {
          val = t.entry * qty;
          rsGross = (t.exit - t.entry) * qty;
          rsNet = rsGross - brk;
        } else if (premium != null) {
          rsGross = premium * (grossOptPct / 100) * qty;
          rsNet = rsGross - brk;
          val = premium * qty;
        } else {
          rsGross = (t.grossRet != null ? t.grossRet : t.ret) / 100 * t.entry * qty;
          rsNet = rsGross - brk;
          val = t.entry * qty;
        }
        rupeeTotal += rsNet;
        brokerTotal += brk;
        entryBrokerTotal += brkIn;
        exitBrokerTotal += brkOut;
        if (!brkOn) {
          return '<tr><td>' + (i + 1) + '</td><td>' + t.entry + '</td><td>' + t.exit + '</td><td>' + esc(t.reason) + '</td><td>SL ' + (t.slPct != null ? t.slPct : '?') + '%<br>Trail ' + (t.trailPct != null ? t.trailPct : '?') + '%</td><td>' + fmtINR(val) + '</td><td style="color:' + netCol + '">' + (netOptPct >= 0 ? '+' : '') + Math.round(netOptPct * 100) / 100 + '%</td><td style="color:' + netCol + '">' + (rsNet >= 0 ? '+' : '') + fmtINR(rsNet) + '</td></tr>';
        }
        return '<tr><td>' + (i + 1) + '</td><td>' + t.entry + '</td><td>' + t.exit + '</td><td>' + esc(t.reason) + '</td><td>SL ' + (t.slPct != null ? t.slPct : '?') + '%<br>Trail ' + (t.trailPct != null ? t.trailPct : '?') + '%</td><td>' + fmtINR(val) + '</td><td style="color:' + grossCol + '">' + (grossOptPct >= 0 ? '+' : '') + Math.round(grossOptPct * 100) / 100 + '%</td><td style="color:#ffd700">' + fmtINR(brkIn) + '</td><td style="color:#ffd700">' + fmtINR(brkOut) + '</td><td style="color:' + netCol + '">' + (netOptPct >= 0 ? '+' : '') + Math.round(netOptPct * 100) / 100 + '%</td><td style="color:' + netCol + '">' + (rsNet >= 0 ? '+' : '') + fmtINR(rsNet) + '</td></tr>';
      }).join('');
    } else {
      pnlRows = '<tr><td colspan="' + (brkOn ? 11 : 8) + '" style="color:#888;text-align:center">No closed trades</td></tr>';
    }
    const rtCol = rupeeTotal >= 0 ? '#00d4aa' : '#ef5350';
    const rupeeLabel = rupeeTotal >= 0 ? 'Profit' : 'Loss';
    const priceBasis = optBasis ? 'per-trade entry/exit premium' : (premium != null ? 'option premium ' + fmtINR(premium) : 'underlying');
    const rupeeRow = tl.length
      ? (brkOn
          ? '<tr><td colspan="5" style="text-align:right;color:#888">Total (after broker charges)</td><td></td><td></td><td style="color:#ffd700">' + fmtINR(entryBrokerTotal) + '</td><td style="color:#ffd700">' + fmtINR(exitBrokerTotal) + '</td><td></td><td style="color:' + rtCol + ';font-weight:700">' + (rupeeTotal >= 0 ? '+' : '') + fmtINR(rupeeTotal) + '</td></tr>' +
            '<tr><td colspan="11" style="text-align:right;color:#888">Gross P&amp;L ' + '(' + priceBasis + ' x ' + qty + ' qty) = ' + (rupeeTotal + brokerTotal >= 0 ? '+' : '') + fmtINR(rupeeTotal + brokerTotal) + ' &minus; charges (entry + exit legs) ' + fmtINR(brokerTotal) + '</td></tr>'
          : '<tr><td colspan="5" style="text-align:right;color:#888">Total ' + rupeeLabel + ' (' + priceBasis + ' x ' + qty + ' qty)</td><td></td><td></td><td style="color:' + rtCol + ';font-weight:700">' + (rupeeTotal >= 0 ? '+' : '') + fmtINR(rupeeTotal) + '</td></tr>')
      : '';

    // Option contract line (strike x CE/PE) when the strategy is strike-scoped.
    const optionLine = (r.optionStrike != null)
      ? '<div style="margin:6px 0"><b style="color:#00d4aa">Option:</b> ' + esc(displayName(r.symbol)) + ' ' + r.optionStrike + ' ' + esc(r.optionType) +
        (premium != null ? ' &middot; Premium ' + fmtINR(premium) : '') +
        (delta != null ? ' &middot; Delta ' + delta : '') +
        (r.expiry ? ' &middot; Expiry ' + esc(r.expiry) : '') + '</div>'
      : '';

    // Equity / drawdown graph.
    const graph = equityGraph(r.metrics.equity, r.metrics.maxDrawdown);

    // All strikes of this strategy family, each with its P&L %, P&L in rupees,
    // total lot price and an "open strike chart" button.
    const siblings = state.results
      .filter(x => familyKey(x) === familyKey(r) && x.optionStrike != null)
      .sort((a, b) => (Number(a.optionStrike) - Number(b.optionStrike)) || (a.optionType === 'CE' ? -1 : 1));
    let strikesTable = '';
    if (siblings.length) {
      const rows = siblings.map(s => {
        const rm = rupeeMetricsFor(s);
        const ret = Math.round(rm.optPct * 100) / 100;
        const col = ret >= 0 ? '#00d4aa' : '#ef5350';
        const chartName = esc(displayName(s.symbol)) + ' ' + s.optionStrike + ' ' + esc(s.optionType);
        const onChart = 'openOptionChartBySid(' + s.optionSid + ',\'' + esc(optionExch(s.symbol)) + '\',\'' + esc(optionInst(s.symbol)) + '\',\'' + chartName + '\')';
        return '<tr>' +
          '<td style="color:#ffd700">' + s.optionStrike + ' ' + esc(s.optionType) + '</td>' +
          '<td style="color:' + col + '">' + (ret >= 0 ? '+' : '') + ret + '%</td>' +
          '<td style="color:' + col + '">' + (rm.pnlRs >= 0 ? '+' : '') + fmtINR(rm.pnlRs) + '</td>' +
          '<td>' + fmtINR(rm.lotPrice) + '</td>' +
          '<td><button class="sbtn run" style="padding:2px 6px;font-size:8px" onclick="' + onChart + '">Open strike chart</button></td>' +
          '</tr>';
      }).join('');
      strikesTable =
        '<div style="margin:8px 0"><b style="color:#00d4aa">All strikes (' + siblings.length + '):</b>' +
        '<table style="width:100%;border-collapse:collapse;font-size:9px;margin-top:4px">' +
        '<thead><tr style="color:#888"><th>Strike</th><th>P&amp;L %</th><th>P&amp;L (Rs)</th><th>Total Lot Price (Rs)</th><th></th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table></div>';
    }

    $id('aeDetailBody').innerHTML =
      '<div style="margin:6px 0"><b style="color:#00d4aa">Method:</b> ' + esc(r.method) + '</div>' +
      '<div style="margin:6px 0"><b style="color:#00d4aa">Category:</b> ' + esc(r.cat) + (r.symbol ? ' &middot; ' + esc(displayName(r.symbol)) : '') + '</div>' +
      '<div style="margin:6px 0"><b style="color:#00d4aa">Timeframe:</b> ' + esc(r.tf || (typeof chartTf !== 'undefined' ? chartTf : '5min')) + (r.aiTf ? ' &middot; <span style="color:#b39ddb">AI auto-picked (best of 1 min / 5 min)</span>' : '') + '</div>' +
      optionLine +
      strikesTable +
      '<div style="margin:6px 0"><b style="color:#00d4aa">Backtest execution:</b> ' + tradeBasisLabel(r) + '</div>' +
      '<div style="margin:6px 0"><b style="color:#00d4aa">Entry:</b> ' + esc(entryStr) + '</div>' +
      (entryExtraStr && entryExtraStr !== 'none' ? '<div style="margin:6px 0"><b style="color:#00d4aa">Entry extra:</b> ' + esc(entryExtraStr) + '</div>' : '') +
      (r.filters && r.filters.length ? '<div style="margin:6px 0"><b style="color:#ffd700">Entry filters (enabled):</b> ' + esc(r.filters.join(' AND ')) + '</div>' : '') +
      '<div style="margin:6px 0"><b style="color:#00d4aa">Exit:</b> ' + esc(exitStr) + '</div>' +
      (exitExtraStr && exitExtraStr !== 'none' ? '<div style="margin:6px 0"><b style="color:#00d4aa">Exit extra:</b> ' + esc(exitExtraStr) + '</div>' : '') +
      '<div style="margin:6px 0"><b style="color:#00d4aa">Candlestick:</b> ' + patStr + '</div>' +
      '<div style="margin:8px 0;padding:8px;background:#12122a;border:1px solid #2d2d50;border-radius:4px">' +
        '<b style="color:#ff9800">Stop-loss (protects capital):</b> ' + (function() {
          if (em.manualSLOn) return 'Manual Stop-Loss ' + (Number(u.manualSLPct) || 0) + '% from entry (manual - auto-decided SL inactive)';
          if (em.aiSlOn) return (r.autoSlPct != null ? r.autoSlPct + '% from entry (engine-decided, ATR hunting-aware), ratchets to breakeven once in profit' : 'n/a');
          return 'Auto Stop-Loss disabled';
        })() + '<br>' +
        '<b style="color:#00d4aa">Take-profit (banks profit):</b> ' + (function() {
          const rrTp = (u.rrEnabled === true && Number(u.rrValue) > 0 && (em.manualSLOn ? (Number(u.manualSLPct) || 0) : (em.aiSlOn ? (r.autoSlPct != null ? r.autoSlPct : 0) : 0)) > 0)
            ? ((em.manualSLOn ? (Number(u.manualSLPct) || 0) : (r.autoSlPct != null ? r.autoSlPct : 0)) * Number(u.rrValue)).toFixed(2)
            : null;
          if (rrTp != null) return 'Fixed by Risk:Reward = SL ' + (em.manualSLOn ? (Number(u.manualSLPct) || 0) : (r.autoSlPct != null ? r.autoSlPct : 0)) + '% x RR ' + Number(u.rrValue) + ' = <b style="color:#ffd700">' + rrTp + '%</b> target (overrides manual/AI TP)';
          if (em.manualTrailTPOn) return 'Manual Trail TP ' + (Number(u.manualTrailTPPct) || 0) + '% of the running profit (peak - entry) - AI Trail TP inactive';
          if (em.manualTPOn) return 'Manual TP ' + (Number(u.manualTPPct) || 0) + '% profit off entry - AI TP inactive';
          if (em.aiTpOn) return 'trailing, calculated on the running profit (peak - entry): it keeps ' + (100 - ((r.tpPct != null ? r.tpPct : (u.tpPct)) || 0)) + '% of the peak profit and moves up automatically as the profit grows. Both SL + trail TP are applied to every executed trade.' + ((u.aiTp !== false) ? ' &middot; <b style="color:#b39ddb">AI Trail TP active</b> (adaptive profit-maximizing trail)' : '');
          if (em.aiTPOn) return 'AI TP % (engine-decided profit target)';
          return 'Take-profit disabled';
        })() +
        (em.anyManual ? ' &middot; <b style="color:#ffd700">Manual mode active - AI auto risk management off</b>' : '') +
      '</div>' +
      '<div style="margin:6px 0"><b style="color:#00d4aa">Backtest:</b> ' + (r.metrics.trades || 0) + ' trades, ' + (r.metrics.wins || 0) + 'W / ' + (r.metrics.losses || 0) + 'L, win rate ' + (r.metrics.winRate || 0) + '%, profit factor ' + (r.metrics.profitFactor || 0) + ', net ' + (r.metrics.totalReturn || 0) + '%' + (brkOn ? ' <span style="color:#ffd700">(after broker charges)</span>' : '') + '</div>' +
      '<div style="margin:8px 0"><b style="color:#00d4aa">Complete P&amp;L (all ' + (r.metrics.trades || 0) + ' trades' + (brkOn ? ', broker ' + ((state.universal && state.universal.brokerChargeMode === 'dhan') ? 'Dhan auto deducted' : fmtINR((state.universal && state.universal.brokerChargePerTrade) || 0) + '/trade deducted') : '') + '):</b>' +
        '<table style="width:100%;border-collapse:collapse;font-size:9px;margin-top:4px">' +
        (brkOn
          ? '<thead><tr style="color:#888"><th>#</th><th>Entry</th><th>Exit</th><th>Reason</th><th>SL / Trail %</th><th>Lot Price (Rs)</th><th>Gross %</th><th>Entry Chg (Rs)</th><th>Exit Chg (Rs)</th><th>Net %</th><th>Net P&amp;L (Rs)</th></tr></thead>'
          : '<thead><tr style="color:#888"><th>#</th><th>Entry</th><th>Exit</th><th>Reason</th><th>SL / Trail %</th><th>Lot Price (Rs)</th><th>P&amp;L %</th><th>P&amp;L (Rs)</th></tr></thead>') +
        '<tbody>' + pnlRows + rupeeRow + '</tbody></table>' +
      '</div>' +
      dailyBreakdownHTML(r) +
      graph +
      '<div style="margin:6px 0;color:#888;font-size:10px">' + esc(r.research || '') + '</div>';
    m.classList.remove('hidden');
  }

  /* Daily breakdown table: each IST day's trades, wins/losses, win rate, net
     return % and reward:risk ratio, plus an Overall row (total win rate and
     overall RR). Shown whenever the backtest recorded any day buckets. */
  function dailyBreakdownHTML(r) {
    const m = r && r.metrics;
    const daily = (m && m.daily) || [];
    if (!daily.length) return '';
    const rrEnabled = !!(state.universal && state.universal.rrEnabled === true);
    const rrTarget = rrEnabled ? (Number(state.universal.rrValue) || 0) : 0;
    const pctCol = (v) => (v >= 0 ? '#00d4aa' : '#ef5350');
    const rrCol = (v) => {
      if (!rrEnabled) return '#b39ddb';
      return (rrTarget > 0 && v >= rrTarget) ? '#00d4aa' : '#ff9800';
    };
    const rows = daily.map(d => {
      const ret = d.ret || 0;
      const rr = d.rr || 0;
      return '<tr><td>' + esc(istDayLabel(d.day)) + '</td><td>' + d.trades + '</td><td style="color:#00d4aa">' + d.wins + '</td><td style="color:#ef5350">' + d.losses + '</td><td style="color:' + pctCol(d.winRate) + '">' + d.winRate + '%</td><td style="color:' + pctCol(ret) + '">' + (ret >= 0 ? '+' : '') + ret + '%</td><td style="color:' + rrCol(rr) + '">' + rr + ' : 1</td></tr>';
    }).join('');
    const ov = (m.dailyOverall) || {};
    const ovRet = ov.ret || 0;
    const ovRr = ov.rr || 0;
    const rrNote = rrEnabled
      ? ' &middot; target RR ' + rrTarget + ' : 1 <span style="color:#888">(green = met, orange = missed)</span>'
      : '';
    return '<div style="margin:8px 0"><b style="color:#00d4aa">Daily breakdown ' + (daily.length + ' day' + (daily.length === 1 ? '' : 's')) + ':</b>' + rrNote +
      '<table style="width:100%;border-collapse:collapse;font-size:9px;margin-top:4px">' +
      '<thead><tr style="color:#888"><th>Date</th><th>Trades</th><th>Wins</th><th>Losses</th><th>Win %</th><th>Net %</th><th>RR</th></tr></thead>' +
      '<tbody>' + rows +
      '<tr style="border-top:1px solid #2d2d50"><td style="color:#ffd700;font-weight:700">Overall (' + ov.trades + ' trades)</td><td style="color:#ffd700;font-weight:700">' + ov.trades + '</td><td style="color:#00d4aa">' + ov.wins + '</td><td style="color:#ef5350">' + ov.losses + '</td><td style="color:#ffd700;font-weight:700">' + (ov.winRate || 0) + '%</td><td style="color:' + pctCol(ovRet) + ';font-weight:700">' + (ovRet >= 0 ? '+' : '') + ovRet + '%</td><td style="color:' + rrCol(ovRr) + ';font-weight:700">' + ovRr + ' : 1</td></tr>' +
      '</tbody></table></div>';
  }

  /* Render a lightweight SVG equity curve with the max-drawdown region
     highlighted. Returns an HTML string; keeps the detail modal dependency-free. */
  function equityGraph(equity, maxDD) {
    const w = 340, h = 120, pad = 8;
    const eq = (Array.isArray(equity) && equity.length) ? equity : [0];
    const min = Math.min(0, Math.min.apply(null, eq));
    const max = Math.max(0, Math.max.apply(null, eq));
    const range = (max - min) || 1;
    const x = i => pad + i * (w - 2 * pad) / (eq.length - 1 || 1);
    const y = v => pad + (max - v) / range * (h - 2 * pad);
    const pts = eq.map((v, i) => x(i).toFixed(1) + ',' + y(v).toFixed(1)).join(' ');
    const zeroY = y(0).toFixed(1);
    // Running peak line: the gap between the equity curve and this line is the
    // drawdown at each point, making the max-drawdown visually explicit.
    let peak = -Infinity;
    const peakPts = eq.map(v => { if (v > peak) peak = v; return peak; })
      .map((v, i) => x(i).toFixed(1) + ',' + y(v).toFixed(1)).join(' ');
    return '<div style="margin:8px 0"><b style="color:#00d4aa">Equity curve &amp; max drawdown (' + (maxDD != null ? maxDD : 0) + '%):</b>' +
      '<svg width="100%" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" style="background:#0b0b1a;border:1px solid #2d2d50;border-radius:4px;margin-top:4px">' +
      '<line x1="' + pad + '" y1="' + zeroY + '" x2="' + (w - pad) + '" y2="' + zeroY + '" stroke="#2d2d50" stroke-width="1" stroke-dasharray="3,3"/>' +
      '<polyline points="' + peakPts + '" fill="none" stroke="#ef5350" stroke-width="1" stroke-dasharray="4,3" opacity="0.7"/>' +
      '<polyline points="' + pts + '" fill="none" stroke="#00d4aa" stroke-width="1.5"/>' +
      '<text x="' + (w - pad) + '" y="' + (pad + 6) + '" fill="#888" font-size="8" text-anchor="end">peak +' + max.toFixed(2) + '% (red) / equity (green)</text>' +
      '<text x="' + (w - pad) + '" y="' + (h - 3) + '" fill="#888" font-size="8" text-anchor="end">min ' + min.toFixed(2) + '%</text>' +
      '</svg></div>';
  }

  function closeDetail() {
    const m = $id('aeDetailModal');
    if (m) m.classList.add('hidden');
  }

  /* ---------------- settings persistence from inputs ---------------- */
  function readUniversal() {
    const lotSizeEl = $id('aeLotSize'), lotsEl = $id('aeLots'), marginEl = $id('aeMargin'), tpEl = $id('aeTp');
    state.universal.lotSize = lotSizeEl && lotSizeEl.value ? Number(lotSizeEl.value) : null;
    state.universal.lots = lotsEl ? (Number(lotsEl.value) || 1) : 1;
    state.universal.margin = marginEl ? (Number(marginEl.value) || 0) : 0;
    state.universal.tpPct = tpEl ? (Number(tpEl.value) || 0) : (Number(state.universal.tpPct) > 0 ? state.universal.tpPct : 1);
    const mtEl = $id('aeManualTrail'), aiTfEl = $id('aeAiTimeframe'), tf1El = $id('aeTf1min'), tf5El = $id('aeTf5min');
    state.universal.manualTrail = mtEl ? mtEl.checked : true;
    const aiSlEl = $id('aeAiSl'), aiTpEl = $id('aeAiTp');
    state.universal.aiSl = aiSlEl ? aiSlEl.checked : true;
    state.universal.aiTp = aiTpEl ? aiTpEl.checked : true;
    const mslEl = $id('aeManualSL'), mslPctEl = $id('aeManualSLPct'), mtslEl = $id('aeManualTrailSL'), mtslPctEl = $id('aeManualTrailSLPct'), mttEl = $id('aeManualTrailTP'), mttPctEl = $id('aeManualTrailTPPct'), mtpEl = $id('aeManualTP'), mtpPctEl = $id('aeManualTPPct'), aitpEl = $id('aeAiTP');
    state.universal.manualSL = mslEl ? mslEl.checked : false;
    state.universal.manualSLPct = mslPctEl ? (Number(mslPctEl.value) || 0) : 0;
    state.universal.manualTrailSL = mtslEl ? mtslEl.checked : false;
    state.universal.manualTrailSLPct = mtslPctEl ? (Number(mtslPctEl.value) || 0) : 0;
    state.universal.manualTrailTP = mttEl ? mttEl.checked : false;
    state.universal.manualTrailTPPct = mttPctEl ? (Number(mttPctEl.value) || 0) : 0;
    state.universal.manualTP = mtpEl ? mtpEl.checked : false;
    state.universal.manualTPPct = mtpPctEl ? (Number(mtpPctEl.value) || 0) : 0;
    state.universal.aiTP = aitpEl ? aitpEl.checked : false;
    state.universal.aiTimeframe = aiTfEl ? aiTfEl.checked : false;
    state.universal.tfs = {
      '1min': tf1El ? tf1El.checked : true,
      '5min': tf5El ? tf5El.checked : true
    };
    const btEl = $id('aeBacktestDays');
    state.universal.backtestDays = btEl ? (Number(btEl.value) || 180) : 180;
    const ilEl = $id('aeIndLimit'), ilCntEl = $id('aeIndLimitCount');
    state.universal.indLimitEnabled = ilEl ? ilEl.checked : false;
    state.universal.indLimit = ilCntEl ? (Number(ilCntEl.value) || 4) : 4;
    const tlEl = $id('aeTradeLimit'), tlCntEl = $id('aeTradeLimitCount'), aiTrEl = $id('aeAiTrades'), tlDayEl = $id('aeTradeLimitDaily');
    state.universal.tradeLimitEnabled = tlEl ? tlEl.checked : false;
    state.universal.tradeLimitCount = tlCntEl ? (Number(tlCntEl.value) || 5) : 5;
    state.universal.tradeLimitDaily = tlDayEl ? tlDayEl.checked : false;
    state.universal.aiTrades = aiTrEl ? aiTrEl.checked : false;
    const dbEl = $id('aeDailyBacktest'), dbDaysEl = $id('aeDailyBacktestDays'), rrEl = $id('aeRrEnabled'), rrValEl = $id('aeRrValue');
    state.universal.dailyBacktest = dbEl ? dbEl.checked : false;
    state.universal.dailyBacktestDays = dbDaysEl ? (Number(dbDaysEl.value) || 30) : 30;
    state.universal.rrEnabled = rrEl ? rrEl.checked : false;
    state.universal.rrValue = rrValEl ? (Math.max(0, Number(rrValEl.value)) || 0) : 0;
    const brkEl = $id('aeDeductBroker'), brkModeEl = $id('aeBrokerChargeMode'), brkAmtEl = $id('aeBrokerChargePerTrade');
    state.universal.deductBrokerCharges = brkEl ? brkEl.checked : false;
    state.universal.brokerChargeMode = brkModeEl ? brkModeEl.value : 'dhan';
    state.universal.brokerChargePerTrade = brkAmtEl ? (Math.max(0, Number(brkAmtEl.value) || 0)) : 0;
    const flEl = $id('aeFnoLimit');
    state.universal.fnoLimit = flEl ? flEl.checked : true;
    const staEl = $id('aeStartTradeAfter'), staOnEl = $id('aeStartTradeAfterEnabled');
    state.universal.startTradeAfter = staEl ? staEl.value : '09:15';
    state.universal.startTradeAfterEnabled = staOnEl ? staOnEl.checked : false;
    const ntaEl = $id('aeNoTradeAfter'), ntaOnEl = $id('aeNoTradeAfterEnabled');
    state.universal.noTradeAfter = ntaEl ? ntaEl.value : '15:30';
    state.universal.noTradeAfterEnabled = ntaOnEl ? ntaOnEl.checked : false;
    const asoEl = $id('aeAutoSquareOffTime'), asoOnEl = $id('aeAutoSquareOffEnabled');
    state.universal.autoSquareOffTime = asoEl ? asoEl.value : '15:20';
    state.universal.autoSquareOffEnabled = asoOnEl ? asoOnEl.checked : false;
    syncManualTrailUI();
    syncManualSlTpUI();
    syncTimeframeUI();
    syncTradesUI();
    syncTimeGateUI();
    syncDailyUI();
    save();
  }

  function toggleAutoSl(on) {
    const aiSlEl = $id('aeAiSl');
    if (aiSlEl) aiSlEl.checked = !!on;
    readUniversal();
  }

  function readStrikeUI() {
    const modeEl = $id('aeStrikeMode'), cntEl = $id('aeStrikeCount'), otEl = $id('aeOptionType'), posEl = $id('aeOnlyPositive');
    const mode = modeEl ? (modeEl.value || 'both_atm') : 'both_atm';
    state.strike.mode = mode;
    // "Only ATM" resolves to exactly one strike; the count field is irrelevant.
    state.strike.count = mode === 'atm' ? 1 : (cntEl ? (Number(cntEl.value) || 3) : 3);
    state.strike.optionType = otEl ? (otEl.value || 'both') : 'both';
    state.strike.positiveOnly = posEl ? posEl.checked : true;
    syncStrikeUI();
    save();
  }

  function readRunInUI() {
    const idxEl = $id('aeRunInIndex'), fnoEl = $id('aeRunInFno'), commEl = $id('aeRunInComm'), defEl = $id('aeRunInDefault');
    const idx = idxEl ? idxEl.value : 'both';
    const fno = fnoEl ? fnoEl.value : 'spot';
    const comm = commEl ? commEl.value : 'spot';
    const def = defEl ? defEl.checked : false;
    state.runIn = state.runIn || { index: 'both', fno: 'spot', comm: 'spot', default: false };
    // "Strategy should be run in" now reads ALL dropdowns: indices, F&O stocks
    // and commodities can each run on the spot chart, the option premium chart,
    // or both.
    state.runIn.index = idx;
    state.runIn.fno = fno;
    state.runIn.comm = comm;
    state.runIn.default = def;
    save();
    log('Strategy run in: indices = ' + modeLabel(idx) + ', F&O stocks = ' + modeLabel(fno) + ', Commodities = ' + modeLabel(comm) + (def ? ' (saved as default for all future tasks)' : ''), def ? 'ok' : '');
  }

  function readTradeInUI() {
    const defEl = $id('aeTradeInDefault');
    const commEl = $id('aeTradeInComm');
    const def = defEl ? defEl.checked : false;
    const comm = commEl ? commEl.value : 'spot';
    state.tradeIn = state.tradeIn || { index: 'premium', fno: 'premium', comm: 'spot', default: false };
    // Backtest trades for indices and F&O stocks always execute on the
    // selected-strike option premium chart - never on the spot chart.
    // Commodities honour their own dropdown (default futures contract).
    state.tradeIn.index = 'premium';
    state.tradeIn.fno = 'premium';
    state.tradeIn.comm = comm;
    state.tradeIn.default = def;
    save();
    log('Trade execution in: indices = ' + modeLabel('premium') + ', F&O stocks = ' + modeLabel('premium') + ', Commodities = ' + modeLabel(comm) + (def ? ' (saved as default for all future tasks)' : ''), def ? 'ok' : '');
  }

  function modeLabel(m) {
    return m === 'spot' ? 'spot chart' : (m === 'both' ? 'both spot + option premium charts (dual confirmation)' : 'option premium chart');
  }

  /* Premium-only mode: a single master toggle that locks the strategy run
     chart AND the trade execution chart to the selected-strike option premium
     chart for every instrument type (indices and F&O stocks alike). The
     per-instrument "Strategy should be run in" / "Trade should be executed in"
     dropdowns are faded out and disabled while this is ON. */
  function onPremiumOnlyInput() {
    const el = $id('aePremiumOnly');
    state.premiumOnly = el ? el.checked : false;
    save();
    syncPremiumOnlyUI();
    log('Premium-only mode: strategies run AND trades execute on the option premium chart ' + (state.premiumOnly ? 'ON' : 'OFF'), state.premiumOnly ? 'ok' : '');
  }
  function syncPremiumOnlyUI() {
    const el = $id('aePremiumOnly');
    if (el) el.checked = state.premiumOnly === true;
    const on = state.premiumOnly === true;
    ['aeRunInRow', 'aeTradeInRow'].forEach(id => {
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
      const el = $id('aeGroup_' + g.key);
      if (el && el.checked) enabled.push(g.key);
    });
    state.groups = enabled.length ? enabled : GROUP_KEYS.slice();
    save();
  }

  function readMoversUI() {
    const g = $id('aeMoversGainers'), l = $id('aeMoversLosers');
    if (!state.movers) state.movers = { enabled: false, gainers: 5, losers: 5, indices: [] };
    state.movers.gainers = g ? (Number(g.value) || 0) : 0;
    state.movers.losers = l ? (Number(l.value) || 0) : 0;
    save();
  }

  function readFiltersUI() {
    if (!state.filters) state.filters = Object.assign({}, defaultState().filters);
    const prevMaster = { bullish: !!state.filters.bullish, bearish: !!state.filters.bearish };
    state.filters.bullish = !!($id('aeFilterBullish') && $id('aeFilterBullish').checked);
    state.filters.bearish = !!($id('aeFilterBearish') && $id('aeFilterBearish').checked);
    state.filters.incUp = !!($id('aeFilterIncUp') && $id('aeFilterIncUp').checked);
    state.filters.incDown = !!($id('aeFilterIncDown') && $id('aeFilterIncDown').checked);
    state.filters.gapUp = !!($id('aeFilterGapUp') && $id('aeFilterGapUp').checked);
    state.filters.gapDown = !!($id('aeFilterGapDown') && $id('aeFilterGapDown').checked);
    state.filters.incUpAll = !!($id('aeFilterIncUpAll') && $id('aeFilterIncUpAll').checked);
    state.filters.incDownAll = !!($id('aeFilterIncDownAll') && $id('aeFilterIncDownAll').checked);
    state.filters.crossUp = !!($id('aeFilterCrossUp') && $id('aeFilterCrossUp').checked);
    state.filters.crossDown = !!($id('aeFilterCrossDown') && $id('aeFilterCrossDown').checked);
    state.filters.gtUp = !!($id('aeFilterGtUp') && $id('aeFilterGtUp').checked);
    state.filters.ltUp = !!($id('aeFilterLtUp') && $id('aeFilterLtUp').checked);
    state.filters.gtDown = !!($id('aeFilterGtDown') && $id('aeFilterGtDown').checked);
    state.filters.ltDown = !!($id('aeFilterLtDown') && $id('aeFilterLtDown').checked);
    FILTER_EXTRA_KEYS.forEach(k => {
      state.filters[k] = !!($id('aeFilter' + capId(k)) && $id('aeFilter' + capId(k)).checked);
    });
    STREAM_FLAG_KEYS.forEach(k => {
      state.filters[k] = !!($id('aeFilter' + capId(k)) && $id('aeFilter' + capId(k)).checked);
    });
    syncFilterSections({ bullish: prevMaster.bullish && !state.filters.bullish, bearish: prevMaster.bearish && !state.filters.bearish });
    save();
    const any = (state.filters.bullish && (state.filters.incUp || state.filters.crossUp || state.filters.gapUp || state.filters.incUpAll || state.filters.gtUp || state.filters.ltUp || state.filters.bullVolUp || state.filters.bullVolDown || state.filters.bullFakeBreakout || state.filters.bullReversal || state.filters.paneCrossUp || state.filters.paneIncUpAll || state.filters.bullBbwInc || state.filters.bullBbCrossBelow || state.filters.bullBbCrossAbove || state.filters.bullPcCrossBelow || state.filters.bullPcCrossAbove || state.filters.bullSmf || state.filters.bullVl || state.filters.bullAsr || hasStreamFlags(state.filters, 'bull'))) ||
                (state.filters.bearish && (state.filters.incDown || state.filters.crossDown || state.filters.gapDown || state.filters.incDownAll || state.filters.gtDown || state.filters.ltDown || state.filters.bearVolUp || state.filters.bearVolDown || state.filters.bearFakeBreakout || state.filters.bearReversal || state.filters.paneCrossDown || state.filters.paneIncDownAll || state.filters.bearBbwInc || state.filters.bearBbCrossBelow || state.filters.bearBbCrossAbove || state.filters.bearPcCrossBelow || state.filters.bearPcCrossAbove || state.filters.bearSmf || state.filters.bearVl || state.filters.bearAsr || hasStreamFlags(state.filters, 'bear')));
    log('Entry filters ' + (any ? 'enabled: ' + filterSummary() : 'disabled'), any ? 'ok' : 'warn');
  }

  /* Fade out a section whose master toggle is off (sub-options stay checkable). */
  function syncFilterSections(masterOff) {
    if (!state.filters) return;
    const masters = { bullish: 'aeFilterBullish', bearish: 'aeFilterBearish' };
    const subs = {
      bullish: [['aeFilterIncUp', 'incUp'], ['aeFilterGapUp', 'gapUp'], ['aeFilterIncUpAll', 'incUpAll'], ['aeFilterCrossUp', 'crossUp'], ['aeFilterGtUp', 'gtUp'], ['aeFilterLtUp', 'ltUp'], ['aeFilterPaneCrossUp', 'paneCrossUp'], ['aeFilterPaneIncUpAll', 'paneIncUpAll']].concat(FILTER_EXTRA_KEYS.filter(k => k.indexOf('bull') === 0).map(k => ['aeFilter' + capId(k), k]), STREAM_FLAG_KEYS.filter(k => k.indexOf('bull') === 0).map(k => ['aeFilter' + capId(k), k])),
      bearish: [['aeFilterIncDown', 'incDown'], ['aeFilterGapDown', 'gapDown'], ['aeFilterIncDownAll', 'incDownAll'], ['aeFilterCrossDown', 'crossDown'], ['aeFilterGtDown', 'gtDown'], ['aeFilterLtDown', 'ltDown'], ['aeFilterPaneCrossDown', 'paneCrossDown'], ['aeFilterPaneIncDownAll', 'paneIncDownAll']].concat(FILTER_EXTRA_KEYS.filter(k => k.indexOf('bear') === 0).map(k => ['aeFilter' + capId(k), k]), STREAM_FLAG_KEYS.filter(k => k.indexOf('bear') === 0).map(k => ['aeFilter' + capId(k), k]))
    };
    Object.keys(masters).forEach(sec => {
      let on = !!state.filters[sec];
      if (!(masterOff && masterOff[sec])) (subs[sec] || []).forEach(p => { if (state.filters[p[1]]) on = true; });
      state.filters[sec] = on;
      const box = $id(masters[sec]);
      if (box) box.checked = on;
      const secEl = $id('aeFilterSection' + (sec === 'bullish' ? 'Bullish' : 'Bearish'));
      if (secEl) secEl.style.opacity = on ? '1' : '0.45';
      (subs[sec] || []).forEach(p => {
        const el = $id(p[0]);
        if (!el) return;
        el.checked = !!state.filters[p[1]];
      });
    });
  }

  function filterSummary() {
    const f = state.filters || {};
    const parts = [];
    const add = (sec, items) => {
      if (!f[sec]) return;
      if (items.length) parts.push((sec === 'bullish' ? 'Bullish' : 'Bearish') + ': ' + items.join(', '));
    };
    add('bullish', [f.incUp ? 'Increasing upward' : null, f.gapUp ? 'Gap increasing' : null, f.incUpAll ? 'Increasing upward (all)' : null, f.gtUp ? 'Greater than' : null, f.ltUp ? 'Less than' : null, f.crossUp ? 'Crossed above' : null, f.paneCrossUp ? 'Pane crossover' : null, f.paneIncUpAll ? 'Pane all lines increasing upward' : null, f.bullBbwInc ? 'BBW increasing' : null, f.bullBbCrossAbove ? 'Close crossed above BB middle band (upper+lower expanding)' : null, f.bullPcCrossAbove ? 'Close crossed above price channel middle line' : null, f.bullSmf ? 'Smart Money Flow bullish' : null, f.bullVl ? 'Volume Line rising + volume increasing' : null, f.bullAsr ? 'Support gap widening (price rising away from support)' : null, f.bullVolUp ? 'Volume increasing' : null, f.bullVolDown ? 'Volume decreasing' : null, f.bullFakeBreakout ? 'Fake breakout' : null, f.bullReversal ? 'Reversal' : null, f.bullCandle ? 'Candlestick patterns' : null, f.bullElliott ? 'Elliott Wave' : null, f.bullIndicator ? 'Indicators' : null, f.bullPane ? 'Pane indicators' : null, f.bullSymmetry ? 'Symmetry' : null, f.bullStructure ? 'Chart structure' : null, f.bullAtr ? 'ATR / Volatility' : null].filter(Boolean));
    add('bearish', [f.incDown ? 'Increasing downward' : null, f.gapDown ? 'Gap decreasing' : null, f.incDownAll ? 'Increasing downward (all)' : null, f.gtDown ? 'Greater than' : null, f.ltDown ? 'Less than' : null, f.crossDown ? 'Crossed below' : null, f.paneCrossDown ? 'Pane crossover' : null, f.paneIncDownAll ? 'Pane all lines increasing downward' : null, f.bearBbwInc ? 'BBW increasing' : null, f.bearBbCrossBelow ? 'Close crossed below BB middle band (upper+lower expanding)' : null, f.bearPcCrossBelow ? 'Close crossed below price channel middle line' : null, f.bearSmf ? 'Smart Money Flow bearish' : null, f.bearVl ? 'Volume Line falling + volume increasing' : null, f.bearAsr ? 'Resistance gap widening (price falling away below resistance)' : null, f.bearVolUp ? 'Volume increasing' : null, f.bearVolDown ? 'Volume decreasing' : null, f.bearFakeBreakout ? 'Fake breakout' : null, f.bearReversal ? 'Reversal' : null, f.bearCandle ? 'Candlestick patterns' : null, f.bearElliott ? 'Elliott Wave' : null, f.bearIndicator ? 'Indicators' : null, f.bearPane ? 'Pane indicators' : null, f.bearSymmetry ? 'Symmetry' : null, f.bearStructure ? 'Chart structure' : null, f.bearAtr ? 'ATR / Volatility' : null].filter(Boolean));
    return parts.join(' | ');
  }

  /* ---------------- index selection UI ---------------- */
  function indexSymbolsList() {
    const list = (typeof SYMBOLS !== 'undefined' && Array.isArray(SYMBOLS)) ? SYMBOLS : [];
    return list.filter(s => s[3] === 'INDEX')
      .map(s => ({ id: Number(s[1]), exch: s[2], inst: s[3], name: s[0], ocId: s[4], ocExch: s[5], grp: s[6] }));
  }

  function populateMoversIndicesUI() {
    const el = $id('aeMoversIndicesSelect');
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
    const el = $id('aeMoversIndicesSelect');
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
    }
  }

  function removeMoverIndex(id, exch) {
    if (!state.movers) state.movers = { enabled: false, gainers: 5, losers: 5, indices: [] };
    state.movers.indices = (state.movers.indices || []).filter(s => !(String(s.id) === String(id) && String(s.exch || '') === String(exch || '')));
    save();
    renderMoversIndicesList();
  }

  function renderMoversIndicesList() {
    const el = $id('aeMoversIndicesList');
    if (!el) return;
    const mv = state.movers || {};
    const idx = Array.isArray(mv.indices) ? mv.indices : [];
    el.innerHTML = idx.map(s =>
      '<span style="background:#1a1a35;border:1px solid #2d2d50;border-radius:3px;padding:2px 6px;display:inline-flex;align-items:center;gap:4px">' +
      esc(displayName(s)) +
      '<span onclick="AutoExperiment.removeMoverIndex(\'' + esc(String(s.id)) + '\',\'' + esc(s.exch || '') + '\')" style="color:#ef5350;cursor:pointer;font-weight:700">x</span>' +
      '</span>').join('');
  }

  function syncNiftyBiasUI() {
    [['aeNiftyEntryEnabled', 'aeNiftyEntryDir', 'aeNiftyEntryZone'], ['aeNiftyExitEnabled', 'aeNiftyExitDir', 'aeNiftyExitZone']].forEach(g => {
      const enEl = $id(g[0]), dirEl = $id(g[1]), zoneEl = $id(g[2]);
      const on = !!(enEl && enEl.checked);
      [dirEl, zoneEl].forEach(el => { if (el) { el.disabled = !on; el.style.opacity = on ? '1' : '0.5'; } });
    });
  }

  function readNiftyBiasUI() {
    const readGate = (enId, dirId, zoneId) => {
      const enEl = $id(enId), dirEl = $id(dirId), zoneEl = $id(zoneId);
      const zone = zoneEl ? zoneEl.value : 'above_upper';
      return {
        enabled: !!(enEl && enEl.checked),
        dir: (dirEl && dirEl.value === 'bearish') ? 'bearish' : 'bullish',
        zone: NIFTY_ZONE_LABEL[zone] ? zone : 'above_upper'
      };
    };
    state.niftyEntry = readGate('aeNiftyEntryEnabled', 'aeNiftyEntryDir', 'aeNiftyEntryZone');
    state.niftyExit = readGate('aeNiftyExitEnabled', 'aeNiftyExitDir', 'aeNiftyExitZone');
    syncNiftyBiasUI();
    save();
    const ge = state.niftyEntry, gx = state.niftyExit;
    log('NIFTY entry gate ' + (ge.enabled ? (ge.dir + ' + ' + (NIFTY_ZONE_LABEL[ge.zone] || ge.zone)) : 'off') +
      ' \u00b7 exit gate ' + (gx.enabled ? (gx.dir + ' + ' + (NIFTY_ZONE_LABEL[gx.zone] || gx.zone)) : 'off'), 'ok');
  }

  function applyNiftyBiasToUI() {
    const applyGate = (enId, dirId, zoneId, g) => {
      const enEl = $id(enId); if (enEl) enEl.checked = !!g.enabled;
      const dirEl = $id(dirId); if (dirEl) dirEl.value = (g.dir === 'bearish') ? 'bearish' : 'bullish';
      const zoneEl = $id(zoneId); if (zoneEl) zoneEl.value = NIFTY_ZONE_LABEL[g.zone] ? g.zone : 'above_upper';
    };
    applyGate('aeNiftyEntryEnabled', 'aeNiftyEntryDir', 'aeNiftyEntryZone', state.niftyEntry || (state.niftyEntry = { enabled: false, dir: 'bullish', zone: 'above_upper' }));
    applyGate('aeNiftyExitEnabled', 'aeNiftyExitDir', 'aeNiftyExitZone', state.niftyExit || (state.niftyExit = { enabled: false, dir: 'bearish', zone: 'below_lower' }));
    syncNiftyBiasUI();
  }

  function applyUniversalToUI() {
    const u = state.universal;
    const set = (id, v) => { const el = $id(id); if (el) el.value = v; };
    set('aeLotSize', u.lotSize != null ? u.lotSize : '');
    set('aeLots', u.lots);
    set('aeMargin', u.margin);
    set('aeTp', u.tpPct);
    const mtEl = $id('aeManualTrail'); if (mtEl) mtEl.checked = u.manualTrail !== false;
    const aiSlEl = $id('aeAiSl'); if (aiSlEl) aiSlEl.checked = u.aiSl !== false;
    const slAutoEl = $id('aeSlAuto'); if (slAutoEl) slAutoEl.checked = u.aiSl !== false;
    const aiTpEl = $id('aeAiTp'); if (aiTpEl) aiTpEl.checked = u.aiTp !== false;
    const mslEl = $id('aeManualSL'); if (mslEl) mslEl.checked = u.manualSL === true;
    const mslPctEl = $id('aeManualSLPct'); if (mslPctEl) mslPctEl.value = (Number(u.manualSLPct) > 0 ? u.manualSLPct : 1);
    const mtslEl = $id('aeManualTrailSL'); if (mtslEl) mtslEl.checked = u.manualTrailSL === true;
    const mtslPctEl = $id('aeManualTrailSLPct'); if (mtslPctEl) mtslPctEl.value = (Number(u.manualTrailSLPct) > 0 ? u.manualTrailSLPct : 1);
    const mttEl = $id('aeManualTrailTP'); if (mttEl) mttEl.checked = u.manualTrailTP === true;
    const mttPctEl = $id('aeManualTrailTPPct'); if (mttPctEl) mttPctEl.value = (Number(u.manualTrailTPPct) > 0 ? u.manualTrailTPPct : 20);
    const mtpEl = $id('aeManualTP'); if (mtpEl) mtpEl.checked = u.manualTP === true;
    const mtpPctEl = $id('aeManualTPPct'); if (mtpPctEl) mtpPctEl.value = (Number(u.manualTPPct) > 0 ? u.manualTPPct : 5);
    const aitpEl = $id('aeAiTP'); if (aitpEl) aitpEl.checked = !!u.aiTP;
    const aiTfEl = $id('aeAiTimeframe'); if (aiTfEl) aiTfEl.checked = !!u.aiTimeframe;
    const tf1El = $id('aeTf1min'); if (tf1El) tf1El.checked = (u.tfs ? u.tfs['1min'] !== false : true);
    const tf5El = $id('aeTf5min'); if (tf5El) tf5El.checked = (u.tfs ? u.tfs['5min'] !== false : true);
    const tlEl = $id('aeTradeLimit'); if (tlEl) tlEl.checked = !!u.tradeLimitEnabled;
    const tlCntEl = $id('aeTradeLimitCount'); if (tlCntEl) tlCntEl.value = (Number(u.tradeLimitCount) > 0 ? u.tradeLimitCount : 5);
    const tlDayEl = $id('aeTradeLimitDaily'); if (tlDayEl) tlDayEl.checked = !!u.tradeLimitDaily;
    const aiTrEl = $id('aeAiTrades'); if (aiTrEl) aiTrEl.checked = !!u.aiTrades;
    const dbEl = $id('aeDailyBacktest'); if (dbEl) dbEl.checked = !!u.dailyBacktest;
    const dbDaysEl = $id('aeDailyBacktestDays'); if (dbDaysEl) dbDaysEl.value = (Number(u.dailyBacktestDays) > 0 ? u.dailyBacktestDays : 30);
    const rrEl = $id('aeRrEnabled'); if (rrEl) rrEl.checked = !!u.rrEnabled;
    const rrValEl = $id('aeRrValue'); if (rrValEl) rrValEl.value = (Number(u.rrValue) > 0 ? u.rrValue : 2);
    const brkEl = $id('aeDeductBroker'); if (brkEl) brkEl.checked = !!u.deductBrokerCharges;
    const brkModeEl = $id('aeBrokerChargeMode'); if (brkModeEl) brkModeEl.value = (u.brokerChargeMode === 'custom') ? 'custom' : 'dhan';
    const brkAmtEl = $id('aeBrokerChargePerTrade'); if (brkAmtEl) brkAmtEl.value = (Number(u.brokerChargePerTrade) >= 0 ? u.brokerChargePerTrade : 20);
    syncBrokerUI();
    const flEl = $id('aeFnoLimit'); if (flEl) flEl.checked = u.fnoLimit !== false;
    const ilEl = $id('aeIndLimit'); if (ilEl) ilEl.checked = !!u.indLimitEnabled;
    const ilCntEl = $id('aeIndLimitCount'); if (ilCntEl) ilCntEl.value = (Number(u.indLimit) > 0 ? u.indLimit : 4);
    const staEl = $id('aeStartTradeAfter'); if (staEl) staEl.value = u.startTradeAfter || '09:15';
    const staOnEl = $id('aeStartTradeAfterEnabled'); if (staOnEl) staOnEl.checked = !!u.startTradeAfterEnabled;
    const ntaEl = $id('aeNoTradeAfter'); if (ntaEl) ntaEl.value = u.noTradeAfter || '15:30';
    const ntaOnEl = $id('aeNoTradeAfterEnabled'); if (ntaOnEl) ntaOnEl.checked = !!u.noTradeAfterEnabled;
    const asoEl = $id('aeAutoSquareOffTime'); if (asoEl) asoEl.value = u.autoSquareOffTime || '15:20';
    const asoOnEl = $id('aeAutoSquareOffEnabled'); if (asoOnEl) asoOnEl.checked = !!u.autoSquareOffEnabled;
    syncManualTrailUI();
    syncManualSlTpUI();
    syncTimeframeUI();
    syncTradesUI();
    syncTimeGateUI();
    syncDailyUI();
    const st = state.strike || {};
    set('aeStrikeMode', st.mode || 'both_atm');
    set('aeStrikeCount', st.count || 3);
    set('aeOptionType', st.optionType || 'both');
    const posEl = $id('aeOnlyPositive'); if (posEl) posEl.checked = st.positiveOnly !== false;
    syncStrikeUI();
    const ri = state.runIn || (state.runIn = { index: 'both', fno: 'spot', comm: 'spot', default: false });
    set('aeRunInIndex', ri.index || 'both');
    set('aeRunInFno', ri.fno || 'spot');
    set('aeRunInComm', ri.comm || 'spot');
    const runInDefEl = $id('aeRunInDefault'); if (runInDefEl) runInDefEl.checked = ri.default === true;
    const ti = state.tradeIn || (state.tradeIn = { index: 'premium', fno: 'premium', comm: 'spot', default: false });
    set('aeTradeInIndex', ti.index || 'premium');
    set('aeTradeInFno', ti.fno || 'premium');
    set('aeTradeInComm', ti.comm || 'spot');
    const tradeInDefEl = $id('aeTradeInDefault'); if (tradeInDefEl) tradeInDefEl.checked = ti.default === true;
    syncPremiumOnlyUI();
    const btEl = $id('aeBacktestDays'); if (btEl) btEl.value = String(state.universal && state.universal.backtestDays ? state.universal.backtestDays : 180);
    const enabledGroups = (state.groups && state.groups.length) ? state.groups : GROUP_KEYS.slice();
    GROUPS.forEach(g => {
      const el = $id('aeGroup_' + g.key);
      if (el) el.checked = enabledGroups.indexOf(g.key) >= 0;
    });
    const f = state.filters || (state.filters = Object.assign({}, defaultState().filters));
    [['aeFilterBullish', 'bullish'], ['aeFilterBearish', 'bearish'], ['aeFilterIncUp', 'incUp'], ['aeFilterIncDown', 'incDown'], ['aeFilterGapUp', 'gapUp'], ['aeFilterGapDown', 'gapDown'], ['aeFilterIncUpAll', 'incUpAll'], ['aeFilterIncDownAll', 'incDownAll'], ['aeFilterCrossUp', 'crossUp'], ['aeFilterCrossDown', 'crossDown'], ['aeFilterGtUp', 'gtUp'], ['aeFilterLtUp', 'ltUp'], ['aeFilterGtDown', 'gtDown'], ['aeFilterLtDown', 'ltDown']].concat(FILTER_EXTRA_KEYS.map(k => ['aeFilter' + capId(k), k]), STREAM_FLAG_KEYS.map(k => ['aeFilter' + capId(k), k])).forEach(p => {
      const el = $id(p[0]);
      if (el) el.checked = !!f[p[1]];
      else f[p[1]] = false;
    });
    syncFilterSections();
    applyMoversToUI();
    applyNiftyTrendToUI();
    applyAutoSendToUI();
    applyNiftyBiasToUI();
    const stBtn = $id('aeStrikesToggle');
    if (stBtn) {
      stBtn.textContent = 'Picked Strikes: ' + (state.showPickedStrikes ? 'ON' : 'OFF');
      stBtn.style.background = state.showPickedStrikes ? '#00d4aa' : '#e67e22';
    }
    renderPickedStrikes();
    const t = $id('aeAutoToggle');
    if (t) { t.textContent = state.enabled ? 'Auto Strategy: ON' : 'Auto Strategy: OFF'; t.style.background = state.enabled ? '#00d4aa' : '#e67e22'; }
    const rm = $id('aeRunManualToggle');
    if (rm) rm.checked = !!state.runManual;
  }

  /* The Manual Trail % checkbox gates the manual Trail % input: when it is
     off (or an AI/rule engine is deciding the trail) the numeric field is
     greyed out and the trail base falls back to a neutral 1%. */
  function syncManualTrailUI() {
    const mtEl = $id('aeManualTrail'), tpEl = $id('aeTp');
    if (tpEl && mtEl) tpEl.disabled = !mtEl.checked;
  }

  /* Manual Stop-Loss / Manual Trail TP / Manual TP override the AI risk
     management. Manual/AI are mutually exclusive per rule: when one is ticked
     its counterpart is faded out and unclickable, and the matching manual %
     input only enables while its checkbox is on. */
  function syncManualSlTpUI() {
    const u = state.universal || {};
    const mslEl = $id('aeManualSL'), mslPctEl = $id('aeManualSLPct');
    const mtslEl = $id('aeManualTrailSL'), mtslPctEl = $id('aeManualTrailSLPct');
    const mttEl = $id('aeManualTrailTP'), mttPctEl = $id('aeManualTrailTPPct');
    const mtpEl = $id('aeManualTP'), mtpPctEl = $id('aeManualTPPct');
    const aiSlEl = $id('aeAiSl'), aiTpEl = $id('aeAiTp'), aitpEl = $id('aeAiTP');
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

  /* "Only ATM" means exactly one strike (the ATM strike), so the "Number of
     Strikes" input is meaningless while it is selected: disable and fade it
     out. Any other mode re-enables it. */
  function syncStrikeUI() {
    const modeEl = $id('aeStrikeMode'), cntEl = $id('aeStrikeCount');
    if (!modeEl || !cntEl) return;
    const atm = modeEl.value === 'atm';
    cntEl.disabled = atm;
    cntEl.style.opacity = atm ? '0.35' : '1';
    cntEl.style.pointerEvents = atm ? 'none' : '';
    cntEl.style.background = atm ? '#0b0b1a' : '';
    cntEl.style.color = atm ? '#666' : '';
    cntEl.style.cursor = atm ? 'not-allowed' : '';
  }

  /* AI auto-timeframe implies evaluating both 1 min and 5 min to pick the best
     one per strategy + strike, so while it is on both timeframe checkboxes are
     forced on (and greyed out) - the engine always runs 1 min and 5 min, it
     just keeps only the winning timeframe per strategy + strike instead of
     keeping every timeframe's result. */
  function syncTimeframeUI() {
    const tf1El = $id('aeTf1min'), tf5El = $id('aeTf5min'), aiTfEl = $id('aeAiTimeframe');
    const aiOn = !!(state.universal && state.universal.aiTimeframe);
    if (tf1El && tf5El && aiTfEl) {
      if (aiOn) {
        tf1El.checked = true;
        tf1El.disabled = true;
        tf1El.style.opacity = '0.55';
        tf5El.checked = true;
        tf5El.disabled = true;
        tf5El.style.opacity = '0.55';
      } else {
        tf1El.disabled = false;
        tf1El.style.opacity = '1';
        tf5El.disabled = false;
        tf5El.style.opacity = '1';
      }
    }
  }

  /* Render the live AI Trail TP decision in the toolbar so the current
     trail % and the simulated profit that picked it stay auditable. */
  function updateAiSlStatus(text) {
    const el = $id('aeAiSlStatus');
    if (el) el.textContent = text || '';
  }
  function updateAiTpStatus(text) {
    const el = $id('aeAiTpStatus');
    if (el) el.textContent = text || '';
  }
  function updateAiTPStatus(text) {
    const el = $id('aeAiTPStatus');
    if (el) el.textContent = text || '';
  }

  /* The manual "Max trades" count input is only usable while its checkbox is
     on AND the AI auto-trades engine is not overriding it. While AI auto
     trades is enabled the manual cap is greyed out (the AI owns the budget). */
  function syncTradesUI() {
    const tlEl = $id('aeTradeLimit'), tlCntEl = $id('aeTradeLimitCount'), tlDayEl = $id('aeTradeLimitDaily');
    const aiOn = !!(state.universal && state.universal.aiTrades);
    if (tlEl && tlCntEl) {
      const on = tlEl.checked && !aiOn;
      tlCntEl.disabled = !on;
      tlCntEl.style.opacity = on ? '1' : '0.5';
    }
    if (tlDayEl) {
      const on = tlEl && tlEl.checked && !aiOn;
      tlDayEl.disabled = !on;
      tlDayEl.style.opacity = on ? '1' : '0.5';
    }
    syncBrokerUI();
  }

  /* The daily-history-days input only matters while "daily chart basis" is on,
     and the RR value input only matters while the RR checkbox is on. */
  function syncDailyUI() {
    const dbEl = $id('aeDailyBacktest'), dbDaysEl = $id('aeDailyBacktestDays');
    if (dbDaysEl) {
      const on = !!(dbEl && dbEl.checked);
      dbDaysEl.disabled = !on;
      dbDaysEl.style.opacity = on ? '1' : '0.5';
    }
    /* The per-day cap needs daily chart basis on, so it is greyed out until
       the daily-basis checkbox is ticked (plus the trade-limit checkbox). */
    const tlEl = $id('aeTradeLimit'), tlDayEl = $id('aeTradeLimitDaily');
    if (tlDayEl) {
      const on = !!(dbEl && dbEl.checked) && !!(tlEl && tlEl.checked) && !!(state.universal && !state.universal.aiTrades);
      tlDayEl.disabled = !on;
      tlDayEl.style.opacity = on ? '1' : '0.5';
    }
    const rrEl = $id('aeRrEnabled'), rrValEl = $id('aeRrValue');
    if (rrValEl) {
      const on = !!(rrEl && rrEl.checked);
      rrValEl.disabled = !on;
      rrValEl.style.opacity = on ? '1' : '0.5';
    }
  }

  /* The broker charge mode select + flat ₹/trade input only matter while the
     "Deduct broker charges" checkbox is on. In Dhan-auto mode the flat input is
     unused (cost is computed per trade), so it is faded out. */
  function syncBrokerUI() {
    const u = state.universal || {};
    const on = u.deductBrokerCharges === true;
    const modeEl = $id('aeBrokerChargeMode'), amtWrap = $id('aeBrokerAmtWrap'), amtEl = $id('aeBrokerChargePerTrade');
    if (modeEl) { modeEl.disabled = !on; modeEl.style.opacity = on ? '1' : '0.5'; }
    const custom = on && u.brokerChargeMode === 'custom';
    if (amtEl) { amtEl.disabled = !custom; amtEl.style.opacity = custom ? '1' : '0.5'; }
    if (amtWrap) amtWrap.style.opacity = custom ? '1' : '0.5';
  }

  /* Render the live AI auto-trades decision (how many trades to take) in the
     toolbar so the current budget + the reasons that picked it stay auditable. */
  function updateAiTradesStatus(text) {
    const el = $id('aeAiTradesStatus');
    if (el) el.textContent = text || '';
  }

  /* The "start trading after" / "no trade after" time selects are only usable
     while their enable checkbox is on. A time gate that is disabled imposes no
     restriction on entry times. */
  function syncTimeGateUI() {
    const u = state.universal || {};
    [['aeStartTradeAfter', 'aeStartTradeAfterEnabled'], ['aeNoTradeAfter', 'aeNoTradeAfterEnabled'], ['aeAutoSquareOffTime', 'aeAutoSquareOffEnabled']].forEach(([selId, chkId]) => {
      const sel = $id(selId), chk = $id(chkId);
      if (sel && chk) {
        const on = !!chk.checked;
        sel.disabled = !on;
        sel.style.opacity = on ? '1' : '0.5';
      }
    });
  }

  /* Reflect the top-movers state in the toolbar and gate the count inputs on
     the master toggle: the numeric fields, the index picker and its Add button
     are only usable while the top-movers auto experiment button is enabled. */
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
    const btn = $id('aeMoversToggle');
    const trendOn = !!(state.niftyTrend && state.niftyTrend.enabled);
    const blocked = trendOn;
    const active = !!mv.enabled && !blocked;
    if (btn) {
      btn.textContent = trendOn ? 'Top Movers: OFF - Trend Follow on' : ('Top Movers: ' + (mv.enabled ? 'ON' : 'OFF'));
      btn.style.background = active ? '#00d4aa' : (blocked ? '#666' : '#e67e22');
      btn.style.opacity = blocked ? '0.6' : '1';
      btn.disabled = false;
    }
    const setVal = (id, v) => { const el = $id(id); if (el) el.value = v; };
    setVal('aeMoversGainers', mv.gainers);
    setVal('aeMoversLosers', mv.losers);
    populateMoversIndicesUI();
    renderMoversIndicesList();
    /* NIFTY Trend Following and Top Gainers/Losers + Indices are mutually
       exclusive: while trend-following is ON the movers sub-controls are faded
       out and disabled (the engine trades the trend-filtered F&O gainers/losers
       + selected indices instead). The toggle button itself stays clickable so
       turning it ON switches the engine out of trend mode. */
    ['aeMoversGainers', 'aeMoversLosers', 'aeMoversIndicesSelect', 'aeMoversIndicesAdd'].forEach(id => {
      const el = $id(id);
      if (el) {
        el.disabled = !active;
        el.style.opacity = active ? '1' : '0.5';
      }
    });
    renderMoversList();
  }

  /* Fill the commodity dropdown from SYMBOLS (MCX_COMM/FUTCOM rows inducted by
     loadCommodities()). Because that induction is async, retry a few times so
     the dropdown catches the contracts whenever they arrive. */
  let _commodityUiTries = 0;
  function populateCommoditiesUI() {
    const sel = $id('aeCommoditySelect');
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
    const btn = $id('aeCommodityToggle');
    if (btn) {
      btn.textContent = 'Commodities: ' + (comm.enabled ? 'ON' : 'OFF');
      btn.style.background = comm.enabled ? '#00d4aa' : '#e67e22';
      btn.style.opacity = '1';
      btn.disabled = false;
    }
    const sel = $id('aeCommoditySelect');
    const addBtn = $id('aeCommodityAdd');
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
    const listEl = $id('aeCommodityList');
    if (listEl) {
      const names = {};
      commoditySymbolsList().forEach(c => { names[Number(c.id)] = c.name; });
      listEl.innerHTML = (comm.sids || []).map(sid => {
        const nm = names[Number(sid)] || ('(expired ' + sid + ')');
        return '<span style="display:inline-flex;align-items:center;gap:4px;background:#1a1a35;border:1px solid #2d2d50;color:#ffd700;border-radius:3px;padding:2px 6px;font-size:9px;margin:1px">' + esc(nm) +
          ' <a href="javascript:void(0)" style="color:#ef5350;font-weight:700;text-decoration:none;font-size:11px" title="Remove" onclick="AutoExperiment.removeCommodity(' + Number(sid) + ')">&times;</a></span>';
      }).join('');
    }
    const st = $id('aeCommodityStatus');
    if (st) {
      const chosen = commoditySymbols();
      if (comm.enabled) {
        st.innerHTML = chosen.length
          ? 'Backtesting ' + chosen.length + ' MCX commodity' + (chosen.length > 1 ? 's' : '') + ': <b style="color:#ffd700">' + chosen.map(c => esc(c.name)).join(', ') + '</b> - alongside your stock / F&O universe.'
          : 'No commodity selected - use + Add to pick contracts.';
      } else {
        st.innerHTML = 'Add MCX commodity futures to backtest them directly (spot mode), alongside stocks / F&O.';
      }
    }
  }

  /* Visible live list of the daily top gainers, top losers and the selected
     indices that will be fed into the experiment, plus the change% that picked
     them. Always shown so the user can see the movers; the master toggle only
     controls whether the experiment/paper-trading actually run on them. */
  function renderMoversList() {
    const host = $id('aeMoversList');
    if (!host) return;
    const mv = state.movers || {};
    host.style.display = '';
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
      const display = displayName(s);
      quoted.push({ name: display, pct: Number(q.change_pct), grp: s.grp, inst: s.inst });
    }
    const withPct = quoted.filter(x => !isNaN(x.pct));
    const wantG = Math.max(0, Number(mv.gainers) || 0);
    const wantL = Math.max(0, Number(mv.losers) || 0);
    const gainers = withPct.filter(x => x.pct >= 0).sort((a, b) => b.pct - a.pct).slice(0, wantG);
    const losers = withPct.filter(x => x.pct < 0).sort((a, b) => a.pct - b.pct).slice(0, wantL);
    let indices = [];
    const wantIdx = Array.isArray(mv.indices) ? mv.indices : [];
    indices = wantIdx.map(s => {
      const q = qm[s.exch === 'IDX_I' ? 'IDX_I:' + s.id : String(s.id)];
      return { name: displayName(s), pct: (q && q.change_pct !== undefined) ? Number(q.change_pct) : null };
    });
    const row = (name, pct) => {
      const p = (pct === null || pct === undefined)
        ? '<span style="color:#888">--</span>'
        : '<span style="color:' + (pct >= 0 ? '#00d4aa' : '#ef5350') + '">' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%</span>';
      return '<div style="display:inline-block;min-width:170px;margin:0 12px 2px 0">' + esc(name) + ' <span style="color:#666">::</span> ' + p + '</div>';
    };
    let html = '';
    if (gainers.length) html += '<div style="color:#00d4aa;font-weight:700;margin:2px 0">Top Gainers:</div>' + gainers.map(g => row(g.name, g.pct)).join('') + '<br>';
    if (losers.length) html += '<div style="color:#ef5350;font-weight:700;margin:2px 0">Top Losers:</div>' + losers.map(l => row(l.name, l.pct)).join('') + '<br>';
    if (indices.length) html += '<div style="color:#ffd700;font-weight:700;margin:2px 0">Indices:</div>' + indices.map(i => row(i.name, i.pct)).join('');
    if (!html) html = '<span style="color:#888">No live quotes yet - connect to Dhan to see daily top gainers / losers.</span>';
    if (!mv.enabled) html = '<div style="color:#888;font-size:9px;margin-bottom:2px">Top Movers Auto is <b style="color:#e67e22">OFF</b> - toggle it ON to run auto experiment on these.</div>' + html;
    host.innerHTML = html;
  }

  /* Live list of the option strikes the engine picked up to execute paper trade
     / backtest. Each symbol shows its resolved CE / PE strikes with the live
     premium, exactly as contractsFor() resolved them for the current run. */
  function renderPickedStrikes() {
    const host = $id('aeStrikesList');
    if (!host) return;
    if (!state.showPickedStrikes) { host.style.display = 'none'; return; }
    host.style.display = '';
    if (!_pickedStrikes.size) {
      host.innerHTML = '<span style="color:#888">No strikes picked up yet - run an experiment / paper trade to resolve the option strikes.</span>';
      return;
    }
    const qm = (typeof clientQuotes !== 'undefined' && clientQuotes) ? clientQuotes : {};
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
          ' <span style="color:#888">' + (prem === null || prem === undefined || isNaN(prem) ? '--' : Number(prem).toFixed(2)) + '</span></span>';
      }).join('');
      if (chips) html += '<div style="margin:2px 0">' + chips + '</div>';
    });
    if (!html) html = '<span style="color:#888">No strikes picked up yet - run an experiment / paper trade to resolve the option strikes.</span>';
    host.innerHTML = html;
  }

  function toggleStrikes() {
    state.showPickedStrikes = !state.showPickedStrikes;
    save();
    const btn = $id('aeStrikesToggle');
    if (btn) {
      btn.textContent = 'Picked Strikes: ' + (state.showPickedStrikes ? 'ON' : 'OFF');
      btn.style.background = state.showPickedStrikes ? '#00d4aa' : '#e67e22';
    }
    renderPickedStrikes();
    log('Picked strikes list ' + (state.showPickedStrikes ? 'enabled' : 'disabled'), state.showPickedStrikes ? 'ok' : 'warn');
  }

  /* ---------------- engine settings templates ----------------
     A template captures the full engine settings (universal defaults, strike,
     run-in / trade-in modes, research groups, filters, movers, NIFTY entry /
     exit gates and NIFTY trend timeframe) under a name + market mode
     (bullish / bearish / sideways). Opening a template re-applies those
     settings to the engine UI and state immediately. */
  const AE_TPL_KEY = 'algodhan_ae_templates_v1';

  function tplLoad() {
    try {
      const l = JSON.parse(localStorage.getItem(AE_TPL_KEY) || '[]');
      return Array.isArray(l) ? l : [];
    } catch (e) { return []; }
  }
  function tplSave(list) {
    try { localStorage.setItem(AE_TPL_KEY, JSON.stringify(list)); } catch (e) {}
  }

  function renderTemplateSelect() {
    const el = $id('aeTplOpen');
    if (!el) return;
    el.innerHTML = '<option value="">-- none --</option>' + tplLoad().map(t =>
      '<option value="' + esc(t.id) + '">' + esc(t.name) + ' (' + esc(t.mode) + ')</option>').join('');
  }

  /* Snapshot the current live engine settings (state already mirrors the UI
     because every input change calls its read* handler). */
  function captureEngineSettings() {
    return {
      universal: JSON.parse(JSON.stringify(state.universal)),
      strike: JSON.parse(JSON.stringify(state.strike)),
      runIn: JSON.parse(JSON.stringify(state.runIn)),
      tradeIn: JSON.parse(JSON.stringify(state.tradeIn)),
      premiumOnly: !!state.premiumOnly,
      groups: (state.groups || []).slice(),
      filters: JSON.parse(JSON.stringify(state.filters)),
      movers: JSON.parse(JSON.stringify(state.movers)),
      niftyTrend: JSON.parse(JSON.stringify(state.niftyTrend)),
      niftyEntry: JSON.parse(JSON.stringify(state.niftyEntry)),
      niftyExit: JSON.parse(JSON.stringify(state.niftyExit)),
      niftyTf: _niftyTf,
      commodity: state.commodity ? JSON.parse(JSON.stringify(state.commodity)) : { enabled: false, sids: [] },
      symbols: (state.symbols || []).slice(),
      runManual: !!state.runManual,
      showPickedStrikes: !!state.showPickedStrikes,
      autoSend: state.autoSend ? JSON.parse(JSON.stringify(state.autoSend)) : { enabled: false, tpls: [] }
    };
  }

  function applyEngineSettings(s) {
    if (!s) return;
    if (s.universal) state.universal = Object.assign(state.universal || {}, JSON.parse(JSON.stringify(s.universal)));
    if (s.strike) state.strike = Object.assign(state.strike || {}, JSON.parse(JSON.stringify(s.strike)));
    if (s.runIn) state.runIn = Object.assign(state.runIn || {}, JSON.parse(JSON.stringify(s.runIn)));
    if (s.tradeIn) state.tradeIn = Object.assign(state.tradeIn || {}, JSON.parse(JSON.stringify(s.tradeIn)));
    if (typeof s.premiumOnly === 'boolean') state.premiumOnly = s.premiumOnly;
    if (Array.isArray(s.groups)) state.groups = s.groups.slice();
    if (s.filters) state.filters = Object.assign(state.filters || {}, JSON.parse(JSON.stringify(s.filters)));
    if (s.movers) state.movers = Object.assign(state.movers || {}, JSON.parse(JSON.stringify(s.movers)));
    if (s.niftyTrend) state.niftyTrend = Object.assign(state.niftyTrend || {}, JSON.parse(JSON.stringify(s.niftyTrend)));
    if (s.niftyEntry) state.niftyEntry = Object.assign(state.niftyEntry || {}, JSON.parse(JSON.stringify(s.niftyEntry)));
    if (s.niftyExit) state.niftyExit = Object.assign(state.niftyExit || {}, JSON.parse(JSON.stringify(s.niftyExit)));
    if (s.niftyTf) setNiftyTf(s.niftyTf);
    if (s.commodity) state.commodity = Object.assign({ enabled: false, sids: [] }, JSON.parse(JSON.stringify(s.commodity)));
    if (Array.isArray(s.symbols)) state.symbols = s.symbols.slice();
    if (typeof s.runManual === 'boolean') state.runManual = s.runManual;
    if (typeof s.showPickedStrikes === 'boolean') state.showPickedStrikes = s.showPickedStrikes;
    if (s.autoSend && typeof s.autoSend === 'object' && !Array.isArray(s.autoSend)) state.autoSend = JSON.parse(JSON.stringify(s.autoSend));
    save();
    applyUniversalToUI();
    applyCommodityToUI();
    renderAutoSendTplList();
    render();
    updateNiftyBiasStatus(null);
    log('Engine settings applied from template', 'ok');
  }

  function saveTemplate() {
    const nameEl = $id('aeTplName'), modeEl = $id('aeTplMode');
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
    if (!t) { log('Template not found', 'warn'); return; }
    if (!t.settings) { log('Template "' + t.name + '" has no saved settings to apply', 'warn'); return; }
    applyEngineSettings(t.settings);
    log('Template "' + t.name + '" (' + t.mode + ') applied to engine', 'ok');
  }

  function deleteTemplate() {
    const el = $id('aeTplOpen');
    const id = el ? el.value : '';
    if (!id) { log('Select a template to delete', 'warn'); return; }
    tplSave(tplLoad().filter(x => String(x.id) !== String(id)));
    renderTemplateSelect();
    log('Template deleted', 'ok');
  }

  /* A saved engine template can be flagged as the tab's DEFAULT settings: when
     the "Default" checkbox is enabled the selected template is re-applied on
     every engine boot, so reloads and duplicated AE tabs start from that
     template's settings instead of whatever the engine last saved. */
  function defaultTemplateId() {
    const v = localStorage.getItem(AE_DEFAULT_KEY);
    return v ? String(v) : '';
  }
  function setDefaultTemplateId(id) {
    try { localStorage.setItem(AE_DEFAULT_KEY, id || ''); } catch (e) {}
  }
  function syncDefaultTplUI() {
    const cb = $id('aeTplDefault');
    if (!cb) return;
    const id = defaultTemplateId();
    cb.checked = !!id;
    const sel = $id('aeTplOpen');
    if (sel && id && !sel.value) sel.value = id;
  }
  function syncSelectedTpl() {
    const cb = $id('aeTplDefault');
    const sel = $id('aeTplOpen');
    if (cb && sel) {
      const def = defaultTemplateId();
      cb.checked = !!def && !!sel.value && String(def) === String(sel.value);
    }
  }
  function applyDefaultTemplate() {
    const id = defaultTemplateId();
    if (!id) return;
    const t = tplLoad().find(x => String(x.id) === String(id));
    if (t) applyEngineSettings(t.settings);
  }

  /* Map Auto Experiment result objects onto the strategy shape the AI Smart
     Trading engine's importFromPaperTrade accepts (same symbol-agnostic logic
     the removed AI Paper Trade engine carried). */
  function resultsToAstPayload(list) {
    const out = [];
    (Array.isArray(list) ? list : []).forEach(r => {
      if (!r) return;
      out.push({
        key: r.tplKey || r.name,
        name: r.name,
        cat: r.cat || 'bullish',
        method: r.method || '',
        tf: r.tf || '5min',
        score: r.score || 0,
        verdict: r.verdict || 'Moderate',
        entry: r.entry || null,
        exit: r.exit || null,
        entryExtra: r.entryExtra || null,
        exitExtra: r.exitExtra || null,
        entryThreshold: r.entryThreshold != null ? r.entryThreshold : null,
        candlestick: r.candlestick || { enabled: false, entry: [], exit: [] },
        /* Reference-only risk snapshot from the AE engine (overall SL % + trail
           SL %) carried for display in the Paper Trade lists / Strategy
           Container. AST ignores these for execution - it runs on its own
           settings basis. */
        refSlPct: (r.refSlPct != null) ? r.refSlPct : (r.autoSlPct != null ? r.autoSlPct : null),
        refTrailSlPct: (r.refTrailSlPct != null) ? r.refTrailSlPct : null
      });
    });
    return out;
  }

  /* ---------------- public API ---------------- */
  const api = {
    run: runExperiment,
    remove: removeResult,
    removeAll: removeAllResults,
    toggleSelect,
    selectAll: selectAllResults,
    removeSelected: removeSelectedResults,
    detail,
    closeDetail,
    render,
    toggleAuto() {
      state.enabled = !state.enabled;
      save();
      applyUniversalToUI();
      log('Auto strategy engine ' + (state.enabled ? 'enabled' : 'disabled'), state.enabled ? 'ok' : 'warn');
    },
    toggleRunManual() {
      state.runManual = $id('aeRunManualToggle').checked;
      save();
    },
    toggleGroupBy() {
      const el = $id('aeGroupByToggle');
      const next = el ? el.checked : !state.groupByStrategy;
      if (next === state.groupByStrategy) return;
      /* Preserve the ticked strategies across the view switch: remember which
         strategy template keys are ticked, then re-apply them to the new view
         (grouped -> tick that strategy's group; ungrouped -> tick every
         symbol/result of that strategy). */
      const before = state.groupByStrategy;
      const tickedTpl = new Set();
      if (before) {
        groupedResults().forEach(g => { if (_selected.has(g.groupKey)) tickedTpl.add(strategyKeyOf(g)); });
      } else {
        (state.results || []).forEach(r => { if (r && _selected.has(r.key)) tickedTpl.add(strategyKeyOf(r)); });
      }
      state.groupByStrategy = next;
      _selected.clear();
      if (next) {
        groupedResults().forEach(g => { if (tickedTpl.has(strategyKeyOf(g))) _selected.add(g.groupKey); });
      } else {
        (state.results || []).forEach(r => { if (r && tickedTpl.has(strategyKeyOf(r))) _selected.add(r.key); });
      }
      save();
      render();
      log('Group by strategy ' + (state.groupByStrategy ? 'ON' : 'OFF') + ' - view updated', state.groupByStrategy ? 'ok' : 'warn');
    },
    onUniversalInput() {
      readUniversal();
    },
    toggleAutoSl,
    onStrikeInput() {
      readStrikeUI();
    },
    onRunInInput() {
      readRunInUI();
    },
    onTradeInInput() {
      readTradeInUI();
    },
    onPremiumOnlyInput() {
      onPremiumOnlyInput();
    },
    onGroupsInput() {
      readGroupsUI();
    },
    toggleMovers() {
      if (!state.movers) state.movers = { enabled: false, gainers: 5, losers: 5, indices: [] };
      state.movers.enabled = !state.movers.enabled;
      /* Mutually exclusive with NIFTY Trend Following: enabling the movers
         universe switches the engine out of trend-following mode. */
      if (state.movers.enabled && state.niftyTrend && state.niftyTrend.enabled) {
        state.niftyTrend.enabled = false;
        _resetTrendScan();
      }
      save();
      applyMoversToUI();
      applyNiftyTrendToUI();
      applyCommodityToUI();
      log('Daily top gainers/losers + indices auto experiment ' + (state.movers.enabled ? 'enabled' : 'disabled'), state.movers.enabled ? 'ok' : 'warn');
    },
    onMoversInput() {
      readMoversUI();
      applyMoversToUI();
    },
    toggleNiftyTrend,
    onNiftyTrendInput() {
      readNiftyTrendUI();
      _resetTrendScan();
      applyNiftyTrendToUI();
    },
    toggleCommodity() {
      _migrateCommodityState();
      state.commodity.enabled = !state.commodity.enabled;
      /* MCX commodities are NOT exclusive with movers / NIFTY trend following:
         the +Add-ed contracts run alongside those universes. */
      if (state.commodity.enabled && !state.commodity.sids.length) {
        const first = optionCommodities()[0];
        if (first) state.commodity.sids.push(first.id);
      }
      save();
      applyCommodityToUI();
      applyMoversToUI();
      applyNiftyTrendToUI();
      log('MCX commodity futures backtest ' + (state.commodity.enabled ? 'enabled' : 'disabled'), state.commodity.enabled ? 'ok' : 'warn');
    },
    addCommodity() {
      _migrateCommodityState();
      const sel = $id('aeCommoditySelect');
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
    },
    removeCommodity(sid) {
      _migrateCommodityState();
      const v = Number(sid);
      state.commodity.sids = state.commodity.sids.filter(s => Number(s) !== v);
      save();
      applyCommodityToUI();
    },
    onCommodityInput() {
      applyCommodityToUI();
    },
    addNiftyTrendIndex,
    removeNiftyTrendIndex,
    renderNiftyTrendList,
    toggleAutoSend,
    onAutoSendInput() {
      readAutoSendUI();
      applyAutoSendToUI();
      /* Auto strategy sender is a hands-free mode: flipping it ON (with at
         least one template added) immediately creates strategies from the
         selected templates' settings and sends them to Paper Trade. */
      if (state.autoSend && state.autoSend.enabled && selectedEngineTemplates().length) runExperiment();
    },
    addAutoSendTpl,
    removeAutoSendTpl,
    renderAutoSendTplList,
    onFiltersInput() {
      readFiltersUI();
    },
    /* Master Bullish/Bearish checkbox: checking it selects every sub-filter in
       that section, unchecking it clears them all (no more one-by-one). */
    onFilterMaster(side) {
      const sec = side === 'bullish' ? 'Bullish' : 'Bearish';
      const master = $id('aeFilter' + sec);
      const on = !!(master && master.checked);
      const secEl = $id('aeFilterSection' + sec);
      if (secEl) {
        const boxes = secEl.querySelectorAll('input[type=checkbox]');
        for (let i = 0; i < boxes.length; i++) {
          const b = boxes[i];
          if (b && b.id && b.id !== 'aeFilter' + sec) b.checked = on;
        }
      }
      readFiltersUI();
    },
    onNiftyBiasInput() {
      readNiftyBiasUI();
    },
    setNiftyTf,
    addMoverIndex,
    removeMoverIndex,
    renderMoversList,
    renderPickedStrikes,
    toggleStrikes,
    onTabShow() {
      applyUniversalToUI();
      render();
      /* Tab-backed instances (duplicated AE tabs) only poll while visible:
         this keeps one experiment running per tab without every duplicated
         tab hammering the Dhan data feed and tripping the rate limiter. */
      if (!_pollTimer) { startPoll(); loadResearch(); startResearchPoll(); }
    },
    onTabHide() {
      stopPoll();
      stopResearchPoll();
    },
    getState() { return state; },
    /* Reusable paper-trading primitives exposed so the AI Smart Trader Engine
       can run its selected strategies per strike, on the option
       premium charts, using the exact same resolution + settings machinery as
       the Auto Experiment paper trader. */
    paper: {
      contractsFor,
      candlesFor,
      candlesForOption,
      experimentSymbols,
      displayName,
      isIndex,
      optionExch,
      optionInst,
      allowedTradesFor,
      liveTimeGateOk,
      isMarketOpenNow,
      aiTrailEngineFor,
      dropAiTrailEngine,
      applyFilters,
      niftyBias,
      niftyGateMet
    },
    sendToPaper() {
      if (!window.AISmartTrading || !AISmartTrading.importFromPaperTrade) {
        log('AI Smart Trading engine not ready', 'warn');
        return;
      }
      if (!_selected.size) {
        log('Tick at least one strategy card to send it to Paper Trade (results are ticked by default after a run)', 'warn');
        return;
      }
      const selected = (state.results || []).filter(r => r && _selected.has(r.key));
      /* Grouped mode: a ticked group sends ONE strategy definition (the
         representative member) - not a duplicate per symbol - because the AST
         key is the template key and every member shares it. */
      const toSend = state.groupByStrategy
        ? groupedResults().filter(g => _selected.has(g.groupKey)).map(g => g.members[0] || g)
        : selected;
      const payload = resultsToAstPayload(toSend);
      if (!payload.length) {
        log('No auto experiment results to send. Run an experiment first.', 'warn');
        return;
      }
      /* Stage the selected strategies into the Paper Trade tab's Bullish /
         Bearish strategy lists first. From there they are handed to the AI
         Smart Trading engine - automatically when the "Auto send to AST"
         switch is on, or manually via the list's "Send selected to AST"
         button. */
      let n = 0;
      if (window.PaperStrategies && PaperStrategies.addFromAE) {
        n = PaperStrategies.addFromAE(toSend);
        log('Sent ' + n + ' selected strategy(s) to the Paper Trade strategy lists', 'ok');
      } else if (window.AISmartTrading && AISmartTrading.importFromPaperTrade) {
        n = AISmartTrading.importFromPaperTrade(payload);
        log('Sent ' + n + ' selected strategy(s) to Paper Trade', 'ok');
      }
      if (n <= 0) {
        log('No auto experiment results to send. Run an experiment first.', 'warn');
      }
      if (window.StrategyContainer && StrategyContainer.refresh) {
        try { StrategyContainer.refresh(); } catch (e) {}
      }
      if (typeof switchTab === 'function') {
        switchTab('papertrade', document.querySelector('[data-tab="papertrade"]'));
      }
    },
    saveTemplate,
    openTemplate,
    openSelectedTemplate() {
      const el = $id('aeTplOpen');
      const id = el ? el.value : '';
      if (!id) { log('Select a saved template to open', 'warn'); return; }
      openTemplate(id);
      syncSelectedTpl();
    },
    /* Choosing a template from the dropdown opens it immediately (same apply
       path as the Open button) and keeps the Default checkbox in sync. */
    onTplSelect() {
      const el = $id('aeTplOpen');
      const id = el ? el.value : '';
      if (id) openTemplate(id);
      syncSelectedTpl();
    },
    syncSelectedTpl,
    toggleDefaultTemplate() {
      const cb = $id('aeTplDefault');
      const on = cb ? cb.checked : false;
      const sel = $id('aeTplOpen');
      const id = sel ? sel.value : '';
      if (on && !id) {
        log('Select a saved template to set as the default engine settings', 'warn');
        if (cb) cb.checked = false;
        return;
      }
      setDefaultTemplateId(on ? id : '');
      if (on) {
        const t = tplLoad().find(x => String(x.id) === String(id));
        applyEngineSettings(t ? t.settings : null);
        log('Template "' + (t ? t.name : id) + '" set as default engine settings', 'ok');
      } else {
        log('Default template disabled - engine uses the last applied settings', 'warn');
      }
      syncDefaultTplUI();
    },
    deleteTemplate
  };
  api.boot = boot;
  api.startPoll = startPoll;
  api.stopPoll = stopPoll;
  api.startResearchPoll = startResearchPoll;
  api.stopResearchPoll = stopResearchPoll;

  /* Register this instance in the per-tab engine registry. The base tab uses
     the key "autoexperiment" and keeps full backward compatibility; duplicated
     AE tabs register under their own suffixed ids. window.AutoExperiment is a
     thin facade that forwards every call to whichever AE tab is active, so the
     inline onclick handlers in each duplicated tab always hit that tab's own
     engine instance. */
  if (!window.TabEngines) window.TabEngines = {};
  if (!window.TabEngines.ae) window.TabEngines.ae = {};
  const instId = suffix.replace(/^_/, '') || 'autoexperiment';
  window.TabEngines.ae[instId] = api;

  if (!window._AeFacade) {
    const base = api;
    window._AeFacade = new Proxy(base, {
      get(t, prop) {
        const key = window._aeActiveEngine || 'autoexperiment';
        const eng = window.TabEngines.ae[key] || t;
        const v = eng[prop];
        return typeof v === 'function' ? v.bind(eng) : v;
      },
      set(t, prop, val) {
        const key = window._aeActiveEngine || 'autoexperiment';
        const eng = window.TabEngines.ae[key] || t;
        eng[prop] = val;
        return true;
      }
    });
    window.AutoExperiment = window._AeFacade;
  }

  /* Static strategy-evaluation exports shared by the HFT data-pool runner (and
     any other engine). entryFireState + the condition/indicator primitives are
     pure functions of (strategy, candles), so they are safe to reuse outside
     this closure. Guarded so only the first (base) instance installs them; the
     base instance's indicator series cache (_seriesByCandles) is a WeakMap
     keyed by candle-array identity, so every consumer passing the SAME pooled
     candle array reuses the exact same computed indicator series. */
  if (typeof window !== 'undefined' && !window.AEval) {
    window.AEval = {
      evalCondAll,
      evalCondAny,
      evalCondNof,
      entryFireState,
      patternHitAt,
      alignedSeries,
      computeAligned,
      settingsKey
    };
  }

  function boot() {
    // Surface any uncaught error in the log panel so a failing experiment or a
    // broken candlestick/chart path is visible instead of silently vanishing.
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
    renderTemplateSelect();
    applyAutoSendToUI();
    syncDefaultTplUI();
    applyCommodityToUI();
    /* If a default engine-settings template is enabled, re-apply it so the
       tab always boots from that template's configuration. */
    applyDefaultTemplate();
    // Persisted results from a previous session: tick them all so the "Send to
    // Paper Trade" button keeps working after a reload (the user can un-tick
    // the category they do not want before sending).
    if (state.results.length && _selected.size === 0) {
      state.results.forEach(r => _selected.add(r.key));
    }
    render();
    startPoll();
    loadResearch();
    startResearchPoll();
    log('Auto experiment engine ready (' + buildTemplateSet().length + ' research templates)', '');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
  return api;
}
