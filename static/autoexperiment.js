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
(function () {
  'use strict';

  const AE_KEY = 'algodhan_autoexperiment_v1';
  const SAVED_KEY = 'algodhan_strategies_v1';

  const $id = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  /* Symbol id -> { symbol, contracts, at } of the last option strikes resolved
     by contractsFor(). These are the strikes the engine picked up to execute
     paper trade / backtest and are shown in the "Picked Strikes" panel. */
  const _pickedStrikes = new Map();

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
      candlePatterns: o.candlePatterns || []
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
      candlestick: { entry: ['bearish_harami'], exit: ['bullish_harami'] } }
  ];

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
  function buildTemplateSet() {
    if (_templateCache) return _templateCache;
    const out = [];
    const add = (t) => {
      t.group = groupOf(t.method);
      if (GROUP_KEYS.indexOf(t.group) >= 0) {
        if (_researchMap[t.method]) t.research = _researchMap[t.method];
        out.push(t);
      }
    };
    TEMPLATES.forEach(t => add(Object.assign({}, t)));

    const gen = (method) => 'Auto-generated parameter sweep (' + method + ')';

    [7, 9, 14, 21, 28].forEach(n => {
      if (n === 14) return; // base template already covers 14
      add({ key: 'rsi_oversold_' + n, name: 'RSI ' + n + ' Oversold Bounce', cat: 'bullish', method: 'Indicator', research: gen('Indicator'),
        entry: cmpCond(rsi(n), 'crossAbove', NUM(30)), exit: cmpCond(rsi(n), 'crossBelow', NUM(70)) });
      add({ key: 'rsi_overbought_' + n, name: 'RSI ' + n + ' Overbought Fade', cat: 'bearish', method: 'Indicator', research: gen('Indicator'),
        entry: cmpCond(rsi(n), 'crossBelow', NUM(70)), exit: cmpCond(rsi(n), 'crossAbove', NUM(30)) });
    });

    [[5, 13], [8, 21], [9, 21], [10, 30], [20, 50]].forEach(([f, s]) => {
      if (f === 9 && s === 21) return; // base already covers 9/21
      add({ key: 'ema_golden_' + f + '_' + s, name: 'EMA ' + f + '/' + s + ' Golden Cross', cat: 'bullish', method: 'Indicator', research: gen('Indicator'),
        entry: cmpCond(ema(f), 'crossAbove', IND(ema(s))), exit: cmpCond(ema(f), 'crossBelow', IND(ema(s))) });
      add({ key: 'ema_death_' + f + '_' + s, name: 'EMA ' + f + '/' + s + ' Death Cross', cat: 'bearish', method: 'Indicator', research: gen('Indicator'),
        entry: cmpCond(ema(f), 'crossBelow', IND(ema(s))), exit: cmpCond(ema(f), 'crossAbove', IND(ema(s))) });
    });

    [[7, 2], [10, 3], [14, 3], [10, 2.5]].forEach(([p, f]) => {
      if (p === 10 && f === 3) return; // base already covers 10/3
      add({ key: 'supertrend_long_' + p + '_' + f, name: 'Supertrend Long (' + p + ',' + f + ')', cat: 'bullish', method: 'Indicator', research: gen('Indicator'),
        entry: pCross(supertrend(p, f), 'above'), exit: pCross(supertrend(p, f), 'below') });
      add({ key: 'supertrend_short_' + p + '_' + f, name: 'Supertrend Short (' + p + ',' + f + ')', cat: 'bearish', method: 'Indicator', research: gen('Indicator'),
        entry: pCross(supertrend(p, f), 'below'), exit: pCross(supertrend(p, f), 'above') });
    });

    [1.5, 2, 2.5, 3].forEach(m => {
      if (m === 2) return; // base already covers 2
      add({ key: 'bb_os_' + m, name: 'Bollinger %B Oversold (' + m + 's)', cat: 'bullish', method: 'Volatility', research: gen('Volatility'),
        entry: cmpCond(bollB(20, m), 'crossAbove', NUM(0)), exit: cmpCond(bollB(20, m), 'crossBelow', NUM(1)) });
      add({ key: 'bb_ob_' + m, name: 'Bollinger %B Overbought (' + m + 's)', cat: 'bearish', method: 'Volatility', research: gen('Volatility'),
        entry: cmpCond(bollB(20, m), 'crossBelow', NUM(1)), exit: cmpCond(bollB(20, m), 'crossAbove', NUM(0)) });
    });

    [[8, 21, 5], [10, 30, 9]].forEach(([fa, sl, sg]) => {
      add({ key: 'macd_bull_' + fa + '_' + sl, name: 'MACD (' + fa + ',' + sl + ') Bull Cross', cat: 'bullish', method: 'Indicator', research: gen('Indicator'),
        entry: cond({ indId: 'macd', indSettings: { fast: fa, slow: sl, signal: sg }, valueKey: 'v0', logic: 'crossAbove', cmpType: 'smoothed' }),
        exit: cond({ indId: 'macd', indSettings: { fast: fa, slow: sl, signal: sg }, valueKey: 'v0', logic: 'crossBelow', cmpType: 'smoothed' }) });
      add({ key: 'macd_bear_' + fa + '_' + sl, name: 'MACD (' + fa + ',' + sl + ') Bear Cross', cat: 'bearish', method: 'Indicator', research: gen('Indicator'),
        entry: cond({ indId: 'macd', indSettings: { fast: fa, slow: sl, signal: sg }, valueKey: 'v0', logic: 'crossBelow', cmpType: 'smoothed' }),
        exit: cond({ indId: 'macd', indSettings: { fast: fa, slow: sl, signal: sg }, valueKey: 'v0', logic: 'crossAbove', cmpType: 'smoothed' }) });
    });

    [10, 14, 20].forEach(n => {
      if (n === 14) return; // base already covers 14
      add({ key: 'mfi_os_' + n, name: 'MFI ' + n + ' Oversold', cat: 'bullish', method: 'Supply/Demand', research: gen('Supply/Demand'),
        entry: cmpCond(mfi(n), 'crossAbove', NUM(20)), exit: cmpCond(mfi(n), 'crossBelow', NUM(80)) });
      add({ key: 'mfi_ob_' + n, name: 'MFI ' + n + ' Overbought', cat: 'bearish', method: 'Supply/Demand', research: gen('Supply/Demand'),
        entry: cmpCond(mfi(n), 'crossBelow', NUM(80)), exit: cmpCond(mfi(n), 'crossAbove', NUM(20)) });
    });

    [10, 14, 20].forEach(n => {
      if (n === 14) return; // base already covers 14
      add({ key: 'adx_brk_' + n, name: 'ADX ' + n + ' Breakout', cat: 'bullish', method: 'Volatility', research: gen('Volatility'),
        entry: cmpCond(adx(n), 'crossAbove', NUM(25)), exit: cmpCond(adx(n), 'crossBelow', NUM(20)) });
    });

    [10, 20, 30].forEach(n => {
      if (n === 20) return; // base already covers 20
      add({ key: 'pc_brk_' + n, name: 'Price Channel Breakout ' + n, cat: 'bullish', method: 'Chart Structure', research: gen('Chart Structure'),
        entry: pCross(pcUpper(n), 'above'), exit: pCross(pcMid(n), 'below') });
      add({ key: 'pc_brkd_' + n, name: 'Price Channel Breakdown ' + n, cat: 'bearish', method: 'Chart Structure', research: gen('Chart Structure'),
        entry: pCross(pcLower(n), 'below'), exit: pCross(pcMid(n), 'above') });
    });

    _templateCache = out;
    return out;
  }

  /* ---------------- fast aligned series cache ---------------- */
  const _seriesByCandles = new WeakMap();
  const _patternByCandles = new WeakMap();
  const _settingsKeyCache = new WeakMap();

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
        if (prev != null && cmpPrev != null) return prev <= cmpPrev && last > cmpLast;
        return last > cmpLast;
      case 'crossBelow':
        if (prev != null && cmpPrev != null) return prev >= cmpPrev && last < cmpLast;
        return last < cmpLast;
      default: return false;
    }
  }

  function evalCondAt(cond, i, candles) {
    if (!cond) return false;
    if (cond.cmpType === 'candlestick_pattern' || cond.cmpType === 'pattern') {
      return patternHitAt(cond.candlePatterns, i, candles);
    }
    if (!cond.indId) return false;
    const prim = readTwo(cond.indId, cond.indSettings, cond.valueKey, i, candles);
    const cmp = cmpReadAt(cond, i, candles);
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

  /* Precompute the entry/exit signal as a boolean array so the backtest
     inner loop is pure array reads. Returns null when cond has no signal. */
  function buildSignal(cond, candles) {
    if (!cond) return null;
    if (cond.cmpType === 'candlestick_pattern' || cond.cmpType === 'pattern') {
      return patternHits(cond.candlePatterns, candles);
    }
    if (!cond.indId) return null;
    const n = candles.length;
    const primArr = alignedSeries(cond.indId, cond.indSettings, cond.valueKey, candles);
    if (!primArr) return null;
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
      out[i] = applyLogicAt(cond.logic, last, i > 0 ? primArr[i - 1] : null, cmpLast, cmpPrev);
    }
    return out;
  }

  /* Combine several conditions into a single boolean array.
     buildAll = AND (all must hold), buildAny = OR (any holds). */
  function buildAll(conds, candles) {
    if (!conds || !conds.length) return null;
    const subs = conds.map(c => buildSignal(c, candles));
    const n = candles.length;
    const out = new Array(n).fill(true);
    for (let i = 0; i < n; i++) {
      for (const s of subs) { if (!s || !s[i]) { out[i] = false; break; } }
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

  /* ---------------- backtest ---------------- */
  /* Take-profit is automatic: instead of a fixed +X% target (which caps every
     winner at X%), the trade rides the move and is closed by a trailing stop
     that ratchets up behind the peak favourable price. This lets the strategy
     capture the maximum profit a move offers and only gives back `tpPct`% of
     the retracement before banking the rest. */
  function backtest(tpl, candles, opts) {
    const tpPct = (opts && opts.tpPct != null) ? opts.tpPct : 1;
    const slPct = autoSLPct(candles); // hunting-aware stop is decided by the engine
    const n = candles.length;
    if (n < 40) return null;
    const warm = 60; // let indicators warm up
    if (n <= warm + 5) return null;
    const long = tpl.cat !== 'bearish';
    let pos = null; // { entry }
    let inPos = false;
    let prevEntry = false, prevExit = false;
    let trades = [], wins = 0, losses = 0, grossWin = 0, grossLoss = 0;
    let equity = [0], tradesList = [];
    const entrySignal = buildSignal(tpl.entry, candles);
    const entryExtraSignal = buildAll(tpl.entryExtra, candles);
    const entryCS = (tpl.candlestick && tpl.candlestick.entry && tpl.candlestick.entry.length)
      ? patternHits(tpl.candlestick.entry, candles) : null;
    const exitSignal = (tpl.exit && tpl.exit.indId) ? buildSignal(tpl.exit, candles) : null;
    const exitExtraSignal = buildAny(tpl.exitExtra, candles);
    const exitCS = (tpl.candlestick && tpl.candlestick.exit && tpl.candlestick.exit.length)
      ? patternHits(tpl.candlestick.exit, candles) : null;
    for (let i = warm; i < n; i++) {
      const entryNow = (entrySignal ? entrySignal[i] : false) &&
        (entryExtraSignal ? entryExtraSignal[i] : true) &&
        (entryCS ? entryCS[i] : true);
      const entryEdge = entryNow && !prevEntry;
      prevEntry = entryNow;
      const exitNow = (exitSignal ? exitSignal[i] : false) || (exitExtraSignal ? exitExtraSignal[i] : false);
      const exitEdge = exitNow && !prevExit;
      prevExit = exitNow;
      const candleExit = exitCS ? exitCS[i] : false;

      if (!inPos) {
        if (entryEdge) {
          pos = { entry: candles[i].close, peak: candles[i].close };
          inPos = true;
        }
      } else {
        const hi = candles[i].high, lo = candles[i].low;
        let exitPrice = null, reason = null;
        if (long) {
          if (hi > pos.peak) pos.peak = hi;
          const trail = pos.peak * (1 - tpPct / 100);
          if (lo <= pos.entry * (1 - slPct / 100)) { exitPrice = pos.entry * (1 - slPct / 100); reason = 'SL'; }
          else if (tpPct > 0 && trail > pos.entry && lo <= trail) { exitPrice = trail; reason = 'Trail TP'; }
        } else {
          if (lo < pos.peak) pos.peak = lo;
          const trail = pos.peak * (1 + tpPct / 100);
          if (hi >= pos.entry * (1 + slPct / 100)) { exitPrice = pos.entry * (1 + slPct / 100); reason = 'SL'; }
          else if (tpPct > 0 && trail < pos.entry && hi >= trail) { exitPrice = trail; reason = 'Trail TP'; }
        }
        if (exitPrice == null && (exitEdge || candleExit)) { exitPrice = candles[i].close; reason = 'Signal'; }
        if (exitPrice != null) {
          const ret = long ? (exitPrice - pos.entry) / pos.entry * 100 : (pos.entry - exitPrice) / pos.entry * 100;
          trades.push(ret);
          if (ret >= 0) { wins++; grossWin += ret; } else { losses++; grossLoss += -ret; }
          equity.push(equity[equity.length - 1] + ret);
          tradesList.push({ ret: Math.round(ret * 100) / 100, reason: reason || 'Signal', entry: Math.round(pos.entry * 100) / 100, exit: Math.round(exitPrice * 100) / 100 });
          inPos = false; pos = null;
        }
      }
    }
    if (trades.length === 0) {
      return { trades: 0, wins: 0, losses: 0, winRate: 0, profitFactor: 0, totalReturn: 0, avgTrade: 0, maxDrawdown: 0, equity: [], tradesList: [] };
    }
    const total = trades.length;
    const winRate = wins / total * 100;
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 99 : 0);
    const totalReturn = trades.reduce((a, b) => a + b, 0);
    let peak = -Infinity, maxDD = 0;
    for (const v of equity) { if (v > peak) peak = v; const dd = peak - v; if (dd > maxDD) maxDD = dd; }
    return {
      trades: total, wins, losses,
      winRate: Math.round(winRate * 10) / 10,
      profitFactor: Math.round(Math.min(profitFactor, 99) * 100) / 100,
      totalReturn: Math.round(totalReturn * 100) / 100,
      avgTrade: Math.round((totalReturn / total) * 100) / 100,
      maxDrawdown: Math.round(maxDD * 100) / 100,
      equity: downsample(equity, 40),
      tradesList: tradesList.slice(-30)
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

  function scoreOf(m) {
    if (!m || m.trades < 3) return 0;
    const pfCapped = Math.min(m.profitFactor, 3);
    const retCapped = Math.min(Math.max(m.totalReturn, 0), 30);
    const s = m.winRate * 0.4 + (pfCapped / 3) * 100 * 0.35 + (retCapped / 30) * 100 * 0.25;
    return Math.round(s);
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
      candlestick,
      strike: state.strike ? JSON.parse(JSON.stringify(state.strike)) : { mode: 'both_atm', count: 3, optionType: 'both' },
      lot: { auto: false, basis: 'OI', pct: 1, manualQty: 1 },
      gate: { enabled: false, conds: [], patterns: [] },
      indexConfirmation: { enabled: false, indices: [], strategyId: null },
      createdAt: Date.now()
    };
  }

  /* ---------------- persistence ---------------- */
  function defaultState() {
    return {
      enabled: false,
      liveMarket: false,
      runManual: false,
      universal: { lotSize: null, lots: 1, margin: 100000, tpPct: 1 },
      strike: { mode: 'both_atm', count: 3, optionType: 'both' },
      groups: GROUP_KEYS.slice(), // enabled research-stream checkboxes
      symbols: [],       // selected symbol/instrument list for experiment + paper trading
      movers: { enabled: false, gainers: 5, losers: 5, includeIndices: true }, // daily top gainers/losers + indices auto experiment
      showPickedStrikes: false,
      /* All-indicators/filters-together entry: when ON a strategy's entry fires
         only when its own conditions AND every selected AST indicator filter
         pass together (strict AND). OFF = old default entry behavior. */
      allInOne: false,
      results: [],
      deployed: {},        // aeId -> { combineWith: manualStratId, enabled: true }
      lastRun: null,
      lastResearchAt: null
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
    const VALID_MODES = ['above', 'below', 'both_atm', 'above_atm', 'below_atm', 'both_atm_inc'];
    const VALID_TYPES = ['both', 'CE', 'PE'];
    if (s && s.strike) {
      if (VALID_MODES.indexOf(s.strike.mode) < 0) s.strike.mode = 'both_atm';
      if (VALID_TYPES.indexOf(s.strike.optionType) < 0) s.strike.optionType = 'both';
    }
    if (s && (!Array.isArray(s.groups) || !s.groups.length)) s.groups = GROUP_KEYS.slice();
    else if (s) s.groups = s.groups.filter(g => GROUP_KEYS.indexOf(g) >= 0);
    if (s && s.movers) {
      if (typeof s.movers.enabled !== 'boolean') s.movers.enabled = false;
      s.movers.gainers = Math.max(0, Number(s.movers.gainers) || 0);
      s.movers.losers = Math.max(0, Number(s.movers.losers) || 0);
      if (typeof s.movers.includeIndices !== 'boolean') s.movers.includeIndices = true;
    }
    return s;
  }
  function save() {
    try {
      localStorage.setItem(AE_KEY, JSON.stringify({
        enabled: state.enabled, liveMarket: state.liveMarket, runManual: state.runManual,
        universal: state.universal, strike: state.strike, groups: state.groups, symbols: state.symbols,
        movers: state.movers, results: state.results, deployed: state.deployed, lastRun: state.lastRun,
        lastResearchAt: state.lastResearchAt, allInOne: state.allInOne === true
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

  /* ---------------- experiment runner ---------------- */
  /* Daily top gainers / top losers + all indices, computed from the live
     quotes cache. The user picks how many of each with a numeric field; when
     the top-movers toggle is on these are merged into the experiment symbol
     set so auto experiments (and paper trading) run on them automatically. */
  function topMoverSymbols() {
    const mv = state.movers || {};
    if (!mv.enabled) return [];
    const qm = (typeof clientQuotes !== 'undefined' && clientQuotes) ? clientQuotes : {};
    const list = (typeof SYMBOLS !== 'undefined' && Array.isArray(SYMBOLS)) ? SYMBOLS : [];
    const gainers = [], losers = [];
    const byId = {};
    list.forEach(s => {
      const name = s[0], id = Number(s[1]), exch = s[2], inst = s[3], ocId = s[4], ocExch = s[5], grp = s[6];
      if (!id || inst === 'INDEX') return;
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
    if (mv.includeIndices) {
      list.forEach(s => {
        if (s[3] === 'INDEX') push({ name: s[0], id: Number(s[1]), exch: s[2], inst: s[3], ocId: s[4], ocExch: s[5], grp: s[6] });
      });
    }
    return out;
  }

  function experimentSymbols() {
    let base = (state.symbols && state.symbols.length) ? state.symbols.slice() : [];
    const movers = topMoverSymbols();
    if (movers.length) {
      const seen = {};
      base.forEach(s => { const k = String(s.id) + ':' + (s.exch || ''); seen[k] = 1; });
      movers.forEach(s => { const k = String(s.id) + ':' + (s.exch || ''); if (!seen[k]) { seen[k] = 1; base.push(s); } });
    }
    if (base.length) return base;
    const cur = (typeof selectedSymbol !== 'undefined') ? selectedSymbol : null;
    return cur ? [cur] : [];
  }

  async function candlesFor(symbol, tf) {
    const cur = (typeof selectedSymbol !== 'undefined') ? selectedSymbol : null;
    const isCurrent = cur && symbol && cur.id === symbol.id && cur.exch === symbol.exch;
    if (isCurrent && window.IndChart && IndChart.getCandles) {
      const c = IndChart.getCandles();
      if (c && c.length >= 60) return c;
    }
    if (window.StratEngine && StratEngine.fetchCandlesFor) {
      try { return await StratEngine.fetchCandlesFor(symbol, tf); } catch (e) { return null; }
    }
    return null;
  }

  /* Indices (and index options) vs F&O stocks are treated differently: for
     indices both the experiment AND the paper trading run on the option-premium
     chart of the selected strike, while for F&O stocks the experiment runs on
     the underlying and only the paper trading uses the strikes. */
  function isIndex(symbol) {
    return !!(symbol && (symbol.inst === 'INDEX' || symbol.ocExch === 'IDX_I'));
  }
  function optionExch(symbol) {
    return (symbol && symbol.ocExch === 'BSE_FNO') ? 'BSE_FNO' : 'NSE_FNO';
  }
  function optionInst(symbol) {
    return isIndex(symbol) ? 'OPTIDX' : 'OPTSTK';
  }
  /* Fetch the option-premium candle series for a specific option security id
     (CE/PE leg) so backtests and live paper-trade signals run on the premium
     chart instead of the underlying. */
  async function candlesForOption(sym, sid, tf) {
    if (sid == null) return null;
    const optSym = { id: Number(sid), exch: optionExch(sym), inst: optionInst(sym), name: (sym && sym.name) || '' };
    if (window.StratEngine && StratEngine.fetchCandlesFor) {
      try {
        const c = await StratEngine.fetchCandlesFor(optSym, tf);
        return (c && c.length >= 60) ? c : null;
      } catch (e) { return null; }
    }
    return null;
  }

  async function contractsFor(symbol, spot) {
    if (!symbol) return null;
    const st = state.strike || {};
    const ot = st.optionType || 'both';
    try {
      // Indices carry their derivative segment (IDX_I / BSE_FNO) in ocExch;
      // F&O stocks arrive as equity spots and are resolved server-side to the
      // FUTSTK underlying on NSE_FNO via symbol_name.
      const ocSeg = isIndex(symbol)
        ? (symbol.ocExch || 'IDX_I')
        : (symbol.ocExch === 'BSE_FNO' ? 'BSE_FNO' : 'NSE_FNO');
      const body = {
        security_id: symbol.ocId != null ? symbol.ocId : symbol.id,
        exchange_segment: ocSeg,
        symbol_name: symbol.name || '',
        mode: st.mode || 'both_atm',
        count: st.count || 3,
        option_type: ot,
        spot: spot || 0
      };
      // Retry transient Dhan failures (rate-limit / flaky gateway) once or
      // twice before giving up, so a single DH-904/805 does not collapse the
      // whole run into the spot-chart fallback.
      let j = null, res = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, 2000 * attempt));
        res = await fetch('/api/auto_strikes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        j = await res.json();
        if (j.status === 'success' && Array.isArray(j.data) && j.data.length) break;
        const msg = (j && j.message) || '';
        if (!/rate|limit|wait/i.test(msg)) break;
      }
      if (!j || j.status !== 'success' || !Array.isArray(j.data) || !j.data.length) {
        const reason = (j && j.message) ? j.message : (res && res.ok ? 'no data returned' : ('HTTP ' + (res && res.status)));
        log('Option chain unavailable for ' + (symbol.name || symbol.id) + ' (' + ocSeg + '): ' + reason, 'warn');
        return null;
      }
      const out = [];
      j.data.forEach(d => {
        if (ot === 'both' || ot === 'CE') out.push({ strike: d.strike, optionType: 'CE', premium: d.ce_ltp, delta: d.ce_delta, sid: d.ce_sid, expiry: j.expiry });
        if (ot === 'both' || ot === 'PE') out.push({ strike: d.strike, optionType: 'PE', premium: d.pe_ltp, delta: d.pe_delta, sid: d.pe_sid, expiry: j.expiry });
      });
      const final = out.filter(c => c.strike != null && c.premium != null);
      _pickedStrikes.set(String(symbol.id), { symbol: symbol, contracts: final, at: Date.now() });
      return final;
    } catch (e) { log('Option chain error for ' + (symbol && symbol.name) + ': ' + (e && e.message ? e.message : e), 'warn'); return null; }
  }

  async function runExperiment() {
    try {
    const tf = (typeof chartTf !== 'undefined') ? chartTf : '5min';
    const syms = experimentSymbols();
    if (!syms.length) { log('Select at least one symbol to experiment on', 'warn'); return; }
    const opts = state.universal;

    const all = [];
    const seen = new Set();
    const push = (r) => { if (!seen.has(r.key)) { seen.add(r.key); all.push(r); } };

    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const multi = syms.length > 1;

    const symIdOf = (s) => (s.id != null ? String(s.id) : String(s.name));

    /* Backtest every enabled template (and optional manual strategies) on a
       candle series, pushing the results. When `strikeInfo` is present the
       result is tagged as a specific CE/PE strike and its metrics come from the
       option-premium series (indices) rather than the underlying. */
    const runOnCandles = (sym, backCandles, spot, strikeInfo) => {
      const autoSl = autoSLPct(backCandles);
      const symId = symIdOf(sym);
      const runTemplates = (tpl, source, extra) => {
        const m = backtest(tpl, backCandles, opts);
        const score = scoreOf(m);
        const base = {
          key: multi ? symId + ':' + tpl.key : tpl.key,
          tplKey: tpl.key,
          name: tpl.name,
          cat: tpl.cat,
          method: tpl.method,
          research: tpl.research,
          source,
          symbol: sym ? JSON.parse(JSON.stringify(sym)) : null,
          spot: spot != null ? spot : (backCandles.length ? backCandles[backCandles.length - 1].close : null),
          entry: tpl.entry,
          exit: tpl.exit,
          entryExtra: tpl.entryExtra || null,
          exitExtra: tpl.exitExtra || null,
          candlestick: tpl.candlestick || null,
          autoSlPct: autoSl,
          metrics: m,
          score,
          verdict: verdict(score)
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
          // Only F&O stock underlyings reach here (indices always pass a
          // strikeInfo and are backtested on the option premium chart). The
          // underlying result is later expanded into per-strike contracts.
          base.backtestBasis = 'underlying';
        }
        push(Object.assign(base, extra || {}));
      };

      const enabledGroups = (state.groups && state.groups.length) ? state.groups : GROUP_KEYS.slice();
      for (const tpl of buildTemplateSet()) {
        if (enabledGroups.indexOf(tpl.group) < 0) continue;
        runTemplates(tpl, 'auto');
      }

      if (state.runManual) {
        for (const s of loadManualStrategies()) {
          if (!s || !s.entry || !s.entry.indId) continue;
          runTemplates({
            key: 'manual:' + s.id,
            name: (s.name || 'Manual strategy'),
            cat: s.cat || 'bullish',
            method: 'Manual',
            research: 'User-created strategy',
            entry: s.entry,
            exit: (s.exit && s.exit.indId) ? s.exit : null,
            candlestick: s.candlestick || null
          }, 'manual', { manualId: s.id });
        }
      }
    };

    let skipped = 0;
    for (const sym of syms) {
      const underlying = await candlesFor(sym, tf);
      if (!underlying || underlying.length < 60) {
        skipped++;
        log('Skipping ' + (sym.name || sym.id) + ': not enough candles', 'warn');
        continue;
      }
      const spot = underlying.length ? underlying[underlying.length - 1].close : null;

      if (isIndex(sym)) {
        // Indices: backtest directly on the option-premium chart of each selected
        // strike (CE/PE). Index strategies are defined on option premiums, so there
        // is NO fallback to the spot chart: without option candles the index is
        // skipped rather than tested on the underlying.
        const contracts = await contractsFor(sym, spot);
        if (!contracts || !contracts.length) {
          skipped++;
          log('No option chain for ' + (sym.name || sym.id) + ' - skipping (index experiment runs on option premiums only)', 'warn');
          continue;
        }
        let loaded = 0;
        for (const c of contracts) {
          const oc = await candlesForOption(sym, c.sid, tf);
          if (!oc || oc.length < 60) {
            log('Skipping ' + (sym.name || sym.id) + ' ' + c.strike + ' ' + c.optionType + ': no option candles', 'warn');
            continue;
          }
          loaded++;
          runOnCandles(sym, oc.slice(-300), spot, {
            strike: c.strike, optionType: c.optionType, premium: c.premium, delta: c.delta,
            sid: c.sid, expiry: c.expiry
          });
        }
        if (loaded === 0) {
          skipped++;
          log('No option candles for ' + (sym.name || sym.id) + ' - skipping (index experiment runs on option premiums only)', 'warn');
        }
      } else {
        // F&O stocks: experiment runs on the underlying chart; strikes are
        // expanded below for paper trading.
        runOnCandles(sym, underlying.slice(-300), spot, null);
      }
    }

    const ms = (typeof performance !== 'undefined' && performance.now) ? performance.now() - t0 : Date.now() - t0;

    // Rank, then drop anything that did not prove profitable in backtest.
    all.sort((a, b) => b.score - a.score);
    // A profitable strategy needs at least 2 closed trades and a positive net
    // return. Relax progressively so the engine always surfaces its best
    // candidates instead of showing an empty list.
    let profitable = all.filter(r => r.metrics && r.metrics.trades >= 2 && r.metrics.totalReturn > 0);
    if (!profitable.length) profitable = all.filter(r => r.metrics && r.metrics.totalReturn > 0);
    if (!profitable.length) profitable = all.slice(0, 10);

    // Cap the top templates per symbol so per-strike expansion stays bounded.
    const MAX_TPL_PER_SYM = 12;
    const capped = [];
    const perSymCount = {};
    profitable.forEach(r => {
      const sk = r.symbol ? (String(r.symbol.id) + ':' + String(r.symbol.exch)) : '__';
      perSymCount[sk] = perSymCount[sk] || 0;
      if (perSymCount[sk] < MAX_TPL_PER_SYM) { perSymCount[sk]++; capped.push(r); }
    });

    // Index results are already strike-scoped from their option-premium backtest
    // ('option'). Only F&O stock ('underlying') results are expanded into
    // per-option-strike contracts here so their paper trading targets the
    // selected strikes. The option chain is fetched once per symbol and shared
    // across its results.
    const contractsCache = new Map();
    const contractsForCached = async (sym, spot) => {
      if (!sym) return null;
      const k = String(sym.id) + ':' + (sym.exch || '');
      if (!contractsCache.has(k)) contractsCache.set(k, await contractsFor(sym, spot));
      return contractsCache.get(k);
    };

    const kept = [];
    for (const r of capped) {
      if (r.backtestBasis === 'option') { kept.push(r); continue; }
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

    const removed = all.length - profitable.length;
    state.results = kept;
    state.lastRun = {
      at: Date.now(), ms: Math.round(ms * 100) / 100,
      candles: kept.length ? 300 : 0,
      symbols: syms.map(s => s.name || s.id),
      kept: kept.length, total: all.length,
      autoSlPct: kept.length ? kept[0].autoSlPct : null,
      tf
    };
    // A fresh run replaces the result set, so drop any stale card selections.
    _selected.clear();
    save();
    render();
    if (!kept.length) {
      if (skipped === syms.length) {
        log('No results: every symbol was skipped for missing candle data (check Dhan connection or reload the chart)', 'warn');
      } else {
        log('Experiment complete but no profitable strategies survived - check candle data / connection', 'warn');
      }
    } else {
      log('Experiment complete: ' + kept.length + ' strategies kept across ' + syms.length + ' symbol(s)' +
        (removed ? ' (' + removed + ' unprofitable removed)' : '') + ' in ' + Math.round(ms * 100) / 100 + 'ms', 'ok');
    }
  } catch (e) {
    if (typeof console !== 'undefined' && console.error) console.error('runExperiment failed', e);
    log('Experiment failed: ' + (e && e.message ? e.message : String(e)), 'warn');
  }
  }

  /* ---------------- deploy ---------------- */
  function deployResult(key) {
    const r = state.results.find(x => x.key === key);
    if (!r) return;
    const symbol = r.symbol || ((typeof selectedSymbol !== 'undefined') ? selectedSymbol : null);
    const tf = (typeof chartTf !== 'undefined') ? chartTf : '5min';
    let strat;
    if (r.source === 'manual') {
      const m = loadManualStrategies().find(s => s.id === r.manualId);
      strat = m ? JSON.parse(JSON.stringify(m)) : null;
      if (!strat) return;
      strat.auto = true;
      if (!/^AE:/.test(strat.name || '')) strat.name = 'AE: ' + (strat.name || 'Untitled');
    } else {
      const tpl = buildTemplateSet().find(t => t.key === (r.tplKey || r.key));
      if (!tpl) return;
      strat = buildStrategy(tpl, symbol, tf);
    }
    if (r.autoSlPct != null) strat.autoSlPct = r.autoSlPct; // auto-fill the engine-decided stop loss
    if (r.optionStrike != null) {
      // Strike-scoped result: pin the deployed strategy to this specific CE/PE
      // strike and fold the strike into the name for clarity.
      strat.optionStrike = r.optionStrike;
      strat.optionType = r.optionType;
      strat.optionSid = r.optionSid || null;
      strat.premium = r.premium != null ? r.premium : null;
      strat.name = 'AE: ' + r.name;
    }
    let saved = loadManualStrategies();
    const i = saved.findIndex(s => s.id === strat.id);
    if (i >= 0) saved[i] = strat; else saved.push(strat);
    try { localStorage.setItem(SAVED_KEY, JSON.stringify(saved)); } catch (e) {}
    state.deployed[r.key] = state.deployed[r.key] || { combineWith: '', enabled: true };
    save();
    if (window.StratUI && StratUI.renderSavedList) StratUI.renderSavedList();
    if (window.StratUI && StratUI.renderSavedDropdown) StratUI.renderSavedDropdown();
    render();
    log('Deployed "' + strat.name + '" to saved strategies', 'ok');
  }

  function undeployResult(key) {
    const r = state.results.find(x => x.key === key);
    if (!r) return;
    let saved = loadManualStrategies();
    let removed = false;
    if (r.source === 'manual') {
      saved = saved.map(s => { if (s.id === r.manualId && s.auto) { removed = true; const c = JSON.parse(JSON.stringify(s)); delete c.auto; c.name = c.name.replace(/^AE:\s*/, ''); return c; } return s; });
    } else {
      const tpl = buildTemplateSet().find(t => t.key === (r.tplKey || r.key));
      if (tpl) {
        const before = saved.length;
        saved = saved.filter(s => !(s.auto && s.aeKey === tpl.key));
        removed = saved.length !== before;
      }
    }
    try { localStorage.setItem(SAVED_KEY, JSON.stringify(saved)); } catch (e) {}
    delete state.deployed[r.key];
    save();
    if (window.StratUI && StratUI.renderSavedList) StratUI.renderSavedList();
    if (window.StratUI && StratUI.renderSavedDropdown) StratUI.renderSavedDropdown();
    render();
    if (removed) log('Removed deployed auto strategy for "' + r.name + '"', 'ok');
  }

  /* Remove a single experiment result from the results list (does not touch the
     saved-strategy list; use Undeploy for that). */
  function removeResult(key) {
    const before = state.results.length;
    state.results = state.results.filter(r => r.key !== key);
    delete state.deployed[key];
    _selected.delete(key);
    if (state.results.length !== before) {
      save();
      render();
      log('Removed strategy from experiment results', '');
    }
  }

  /* Remove every experiment result at once. */
  function removeAllResults() {
    if (!state.results.length) { log('No experiment results to remove', 'warn'); return; }
    state.results = [];
    state.deployed = {};
    state.lastRun = null;
    _selected.clear();
    save();
    render();
    log('Removed all experiment strategies', 'warn');
  }

  /* ---------------- multi-select removal ---------------- */
  const _selected = new Set(); // result keys ticked via their card checkboxes

  function toggleSelect(key, checked) {
    if (checked) _selected.add(key); else _selected.delete(key);
    updateSelectionUI();
  }

  function selectAllResults() {
    const allTicked = state.results.length > 0 && _selected.size === state.results.length;
    _selected.clear();
    if (!allTicked) state.results.forEach(r => _selected.add(r.key));
    render();
  }

  function removeSelectedResults() {
    if (!_selected.size) { log('Select at least one strategy to remove', 'warn'); return; }
    const before = state.results.length;
    state.results = state.results.filter(r => !_selected.has(r.key));
    _selected.forEach(k => { delete state.deployed[k]; });
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
    if (sel) sel.textContent = (state.results.length && _selected.size === state.results.length) ? 'Clear Selection' : 'Select All';
  }

  /* ---------------- live paper-trading loop ---------------- */
  let _pollTimer = null;
  const _sig = {}; // key -> { prevEntry, prevExit }

  function signalFor(key) {
    if (!_sig[key]) _sig[key] = { prevEntry: false, prevExit: false };
    return _sig[key];
  }

  async function paperTick() {
    if (!state.enabled || !state.liveMarket) return;
    const tf = (typeof chartTf !== 'undefined') ? chartTf : '5min';
    const pt = window.PaperTrade;
    if (!pt) return;
    const ptState = pt.getState ? pt.getState() : null;
    const autoPositions = (ptState && ptState.autoPositions) || {};

    const syms = experimentSymbols();
    if (!syms.length) return;

    // Ordered by score so the best strategy takes priority for each symbol.
    const active = state.results
      .filter(r => state.deployed[r.key] && state.deployed[r.key].enabled)
      .sort((a, b) => b.score - a.score);

    const activeFor = (sym) => active.filter(r =>
      !r.symbol || (r.symbol.id === sym.id && r.symbol.exch === sym.exch));

    for (const sym of syms) {
      const underlying = await candlesFor(sym, tf);

      for (const r of activeFor(sym)) {
        // Resolve the candle series this strategy actually trades: the option
        // premium chart when the result is strike-scoped, else the underlying.
        // Indices must always trade on the option premium chart (no spot
        // fallback); F&O stock paper trading may drop back to the underlying
        // only when a strike's option candles are unavailable.
        let candles = null;
        if (r.optionSid != null) {
          candles = await candlesForOption(sym, r.optionSid, tf);
          if ((!candles || candles.length < 10) && isIndex(sym)) continue;
          if (!candles || candles.length < 10) candles = underlying;
        } else {
          candles = underlying;
        }
        if (!candles || candles.length < 10) continue;

        // The position is keyed by the traded instrument (option sid or the
        // underlying) so multiple strikes on one symbol can trade concurrently.
        const tradeSym = r.optionSid != null
          ? { id: r.optionSid, exch: optionExch(sym), inst: optionInst(sym), name: (sym.name || sym.id) + ' ' + r.optionStrike + ' ' + r.optionType }
          : sym;
        const posKey = String(tradeSym.id) + ':' + (tradeSym.exch || '');
        const openPos = autoPositions[posKey];
        if (openPos) {
          // Already holding this instrument via the auto engine: the exit is
          // managed by the auto SL / trailing-target protections in PaperTrade,
          // so just keep holding. Signal-based exits are removed.
          continue;
        }
        // Flat on this instrument: look for a firing entry signal.
        const entryOk = await evalEntryLive(r, candles, tf);
        if (!entryOk) continue;
        const side = r.cat === 'bearish' ? 'SELL' : 'BUY';
        const u = state.universal;
        // Use the underlying's real-market lot size (from the broker scrip
        // master) unless the user set a universal override.
        let lotSize = u.lotSize != null ? u.lotSize : null;
        if (lotSize == null && pt.lotSizeFor) lotSize = pt.lotSizeFor(sym);
        const ok = pt.autoEntry(side, { key: r.key, symbol: tradeSym, lotSize: lotSize, lots: u.lots, margin: u.margin, tpPct: u.tpPct, slPct: r.autoSlPct });
        if (ok) {
          log('Auto ' + side + ' paper entry from "' + r.name + '" (' + (tradeSym.name || sym.name || sym.id) + ')', 'buy');
          render();
          autoPositions[posKey] = { autoKey: r.key, side: side };
        }
        break;
      }
    }
  }

  async function evalEntryLive(r, candles, tf) {
    const sig = signalFor(r.key);
    const last = candles.length - 1;
    /* "All indicators & filters together" mode: the strategy's own conditions
       AND every selected AST indicator filter must ALL pass together on the same
       bar (strict AND, no N-of-M). Evaluated through the AST engine so both
       engines read identical chart/pool values. OFF = the old default entry. */
    const allTogether = state.allInOne === true && window.AISmartTrading &&
      typeof window.AISmartTrading.strictEntryOk === 'function';
    const entryNow = allTogether
      ? !!window.AISmartTrading.strictEntryOk(r, candles, last)
      : (evalCondAll(r.entry, last, candles) &&
        (r.entryExtra && r.entryExtra.length ? evalCondAll(r.entryExtra, last, candles) : true) &&
        (!r.candlestick || !r.candlestick.entry || !r.candlestick.entry.length ? true : patternHitAt(r.candlestick.entry, last, candles)));
    const edge = entryNow && !sig.prevEntry;
    sig.prevEntry = entryNow;
    if (!edge) return false;
    const comb = state.deployed[r.key] && state.deployed[r.key].combineWith;
    if (comb) {
      const manual = loadManualStrategies().find(s => s.id === comb);
      if (!manual || !manual.entry || !manual.entry.indId) return false;
      const msig = sig.manualEntrySig || (sig.manualEntrySig = window.CrossDetector ? CrossDetector.createSignal() : null);
      const me = window.StratEngine ? StratEngine.evalCondEdge(manual.entry, candles, msig) : false;
      if (!me) return false;
    }
    return true;
  }

  function startPoll() {
    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = setInterval(() => { paperTick(); renderMoversList(); renderPickedStrikes(); }, 1500);
  }
  function stopPoll() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  }

  /* ---------------- log ---------------- */
  function log(msg, cls) {
    const el = $id('aeLog');
    if (!el) return;
    const d = new Date();
    const ts = (window.IST12 && IST12.fmtMs) ? IST12.fmtMs(d.getTime()) : String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
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
    if (!c.indId) return 'none';
    const primary = indName(c.indId);
    const logicMap = { gt: '>', lt: '<', gte: '>=', lte: '<=', eq: '=', neq: '!=', crossAbove: 'crosses above', crossBelow: 'crosses below' };
    const lg = logicMap[c.logic] || c.logic;
    let cmp;
    if (c.cmpType === 'number') cmp = c.number;
    else if (c.cmpType === 'candle') cmp = 'candle ' + (c.candleKey || 'close');
    else if (c.cmpType === 'smoothed') cmp = 'signal (' + indName(c.indId) + ')';
    else if (c.cmpType === 'plot') cmp = 'plot (' + indName(c.indId) + ')';
    else if (c.cmpType === 'indicator') cmp = indName(c.cmpIndId);
    else cmp = '?';
    return primary + ' ' + lg + ' ' + cmp;
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
    if (!state.results.length) {
      host.innerHTML = '<div class="strat-empty">Run an experiment to generate and rank strategies.</div>';
      updateSelectionUI();
      return;
    }
    const manualOpts = loadManualStrategies().filter(s => s && s.id).map(s =>
      '<option value="' + esc(s.id) + '">' + esc(s.name || 'Untitled') + '</option>').join('');
    host.innerHTML = state.results.map(r => {
      const m = r.metrics || {};
      const dep = state.deployed[r.key];
      const deployed = !!dep;
      // Net/avg P&L shown option-geared so index AND F&O-stock results both
      // report the option's return rather than the underlying's raw move.
      const netPct = optionPct(r, m.totalReturn || 0);
      const avgPct = optionPct(r, m.avgTrade || 0);
      const mCol = netPct >= 0 ? '#00d4aa' : '#ef5350';
      const vCol = r.verdict === 'Elite' ? '#ffd700' : (r.verdict === 'Good' ? '#00d4aa' : (r.verdict === 'Moderate' ? '#ff9800' : '#888'));
      return '<div class="strat-card" data-ae="' + esc(r.key) + '">' +
        '<div class="strat-head"><input type="checkbox" class="ae-sel" data-key="' + esc(r.key) + '"' + (_selected.has(r.key) ? ' checked' : '') + ' style="width:12px;height:12px;flex:0 0 auto;accent-color:#00d4aa"> <span class="strat-name">' + esc(r.name) + (r.source === 'manual' ? ' <span style="color:#66ccff;font-size:9px">(manual)</span>' : '') + '</span>' +
        '<span style="color:' + vCol + ';font-weight:700;font-size:10px">' + esc(r.verdict) + ' ' + r.score + '</span></div>' +
        '<div class="strat-meta">' + esc(r.method) + ' &middot; ' + esc(r.cat) + (r.symbol ? ' &middot; ' + esc(r.symbol.name) : '') + (r.optionStrike != null ? ' &middot; ' + r.optionStrike + ' ' + esc(r.optionType) : '') + (r.premium != null ? ' &middot; prem ' + r.premium : '') + (r.autoSlPct ? ' &middot; auto SL ' + r.autoSlPct + '%' : '') + ' &middot; ' + (m.trades || 0) + ' trades &middot; WR ' + (m.winRate || 0) + '% &middot; PF ' + (m.profitFactor || 0) + ' &middot; MaxDD ' + (m.maxDrawdown || 0) + '%</div>' +
        '<div class="strat-meta" style="color:' + mCol + '">Net ' + (netPct >= 0 ? '+' : '') + Math.round(netPct * 100) / 100 + '% &middot; Avg ' + Math.round(avgPct * 100) / 100 + '%/trade</div>' +
        '<div class="strat-meta" style="font-size:8px;color:#666">' + esc(r.research || '') + '</div>' +
        '<div class="strat-actions" style="flex-wrap:wrap">' +
        '<select class="ae-combine" data-key="' + esc(r.key) + '" style="background:#1a1a35;border:1px solid #2d2d50;color:#d0d0d0;border-radius:3px;padding:3px 6px;font-size:9px;margin:2px 0;width:100%"><option value="">Combine manual strategy (none)</option>' + manualOpts + '</select>' +
        '<button class="sbtn run" onclick="AutoExperiment.deploy(\'' + esc(r.key) + '\')">' + (deployed ? 'Re-deploy' : 'Deploy') + '</button>' +
        '<button class="sbtn" onclick="AutoExperiment.detail(\'' + esc(r.key) + '\')">Detail</button>' +
        (deployed ? '<button class="sbtn stop" onclick="AutoExperiment.undeploy(\'' + esc(r.key) + '\')">Undeploy</button>' : '') +
        '<button class="sbtn stop" onclick="AutoExperiment.remove(\'' + esc(r.key) + '\')">Remove</button>' +
        '</div></div>';
    }).join('');

    // Wire combine dropdowns
    host.querySelectorAll('.ae-combine').forEach(sel => {
      const key = sel.dataset.key;
      const dep = state.deployed[key];
      if (dep && dep.combineWith) sel.value = dep.combineWith;
      sel.addEventListener('change', () => {
        if (!state.deployed[key]) state.deployed[key] = { enabled: true, combineWith: '' };
        state.deployed[key].combineWith = sel.value;
        save();
        log('Auto strategy "' + key + '" combine set to ' + (sel.value || 'none'), '');
      });
    });

    // Wire multi-select checkboxes
    host.querySelectorAll('.ae-sel').forEach(cb => {
      cb.addEventListener('change', () => toggleSelect(cb.dataset.key, cb.checked));
    });
    updateSelectionUI();
  }

  /* Group identity: symbol + template (or manual strategy). All strikes of the
     same group are listed together in the detail view. */
  function familyKey(x) {
    const symId = x.symbol ? (String(x.symbol.id) + ':' + (x.symbol.exch || '')) : '__';
    const base = x.source === 'manual' ? ('manual:' + (x.manualId || '')) : (x.tplKey || x.key || '');
    return symId + ':' + base;
  }

  /* Option-aware P&L percentage for a result. Index results are backtested on
     the option-premium chart, so their return is already the option's move.
     F&O stock results are backtested on the underlying, so their return is
     converted to an option return via delta gearing before being shown as a
     percentage P&L. */
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

  function detail(key) {
    const r = state.results.find(x => x.key === key);
    if (!r) return;
    const m = $id('aeDetailModal');
    if (!m) return;
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
    let rupeeTotal = 0;
    let pnlRows = '';
    if (tl.length) {
      pnlRows = tl.map((t, i) => {
        const optPct = optionPct(r, t.ret);
        const col = optPct >= 0 ? '#00d4aa' : '#ef5350';
        // Option-aware rupee P&L: premium moves ~ delta x underlying move.
        let rs;
        if (premium != null) rs = premium * (optPct / 100) * qty;
        else rs = t.ret / 100 * t.entry * qty;
        const val = premium != null ? premium * qty : t.entry * qty;
        rupeeTotal += rs;
        return '<tr><td>' + (i + 1) + '</td><td>' + t.entry + '</td><td>' + t.exit + '</td><td>' + esc(t.reason) + '</td><td>' + fmtINR(val) + '</td><td style="color:' + col + '">' + (optPct >= 0 ? '+' : '') + Math.round(optPct * 100) / 100 + '%</td><td style="color:' + col + '">' + (rs >= 0 ? '+' : '') + fmtINR(rs) + '</td></tr>';
      }).join('');
    } else {
      pnlRows = '<tr><td colspan="7" style="color:#888;text-align:center">No closed trades</td></tr>';
    }
    const rtCol = rupeeTotal >= 0 ? '#00d4aa' : '#ef5350';
    const rupeeLabel = rupeeTotal >= 0 ? 'Profit' : 'Loss';
    const priceBasis = premium != null ? 'option premium ' + fmtINR(premium) : 'underlying';
    const rupeeRow = tl.length
      ? '<tr><td colspan="4" style="text-align:right;color:#888">Total ' + rupeeLabel + ' (' + priceBasis + ' x ' + qty + ' qty)</td><td></td><td></td><td style="color:' + rtCol + ';font-weight:700">' + (rupeeTotal >= 0 ? '+' : '') + fmtINR(rupeeTotal) + '</td></tr>'
      : '';

    // Option contract line (strike x CE/PE) when the strategy is strike-scoped.
    const optionLine = (r.optionStrike != null)
      ? '<div style="margin:6px 0"><b style="color:#00d4aa">Option:</b> ' + esc((r.symbol && r.symbol.name) || '') + ' ' + r.optionStrike + ' ' + esc(r.optionType) +
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
        const chartName = esc((s.symbol && s.symbol.name) || '') + ' ' + s.optionStrike + ' ' + esc(s.optionType);
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
      '<div style="margin:6px 0"><b style="color:#00d4aa">Category:</b> ' + esc(r.cat) + (r.symbol ? ' &middot; ' + esc(r.symbol.name) : '') + '</div>' +
      optionLine +
      strikesTable +
      '<div style="margin:6px 0"><b style="color:#00d4aa">Entry:</b> ' + esc(entryStr) + '</div>' +
      (entryExtraStr && entryExtraStr !== 'none' ? '<div style="margin:6px 0"><b style="color:#00d4aa">Entry extra:</b> ' + esc(entryExtraStr) + '</div>' : '') +
      '<div style="margin:6px 0"><b style="color:#00d4aa">Exit:</b> ' + esc(exitStr) + '</div>' +
      (exitExtraStr && exitExtraStr !== 'none' ? '<div style="margin:6px 0"><b style="color:#00d4aa">Exit extra:</b> ' + esc(exitExtraStr) + '</div>' : '') +
      '<div style="margin:6px 0"><b style="color:#00d4aa">Candlestick:</b> ' + patStr + '</div>' +
      '<div style="margin:8px 0;padding:8px;background:#12122a;border:1px solid #2d2d50;border-radius:4px">' +
        '<b style="color:#ff9800">Stop-loss to use when buying:</b> ' + (r.autoSlPct != null ? r.autoSlPct + '% (engine-decided, ATR hunting-aware)' : 'n/a') + '<br>' +
        '<b style="color:#00d4aa">Take-profit:</b> automatic (trailing, exits on a ' + ((r.tpPct != null ? r.tpPct : (state.universal && state.universal.tpPct)) || 0) + '% retracement from peak to bank maximum profit)' +
      '</div>' +
      '<div style="margin:6px 0"><b style="color:#00d4aa">Backtest:</b> ' + (r.metrics.trades || 0) + ' trades, ' + (r.metrics.wins || 0) + 'W / ' + (r.metrics.losses || 0) + 'L, win rate ' + (r.metrics.winRate || 0) + '%, profit factor ' + (r.metrics.profitFactor || 0) + ', net ' + (r.metrics.totalReturn || 0) + '%</div>' +
      '<div style="margin:8px 0"><b style="color:#00d4aa">Complete P&amp;L (all ' + (r.metrics.trades || 0) + ' trades):</b>' +
        '<table style="width:100%;border-collapse:collapse;font-size:9px;margin-top:4px">' +
        '<thead><tr style="color:#888"><th>#</th><th>Entry</th><th>Exit</th><th>Reason</th><th>Lot Price (Rs)</th><th>P&amp;L %</th><th>P&amp;L (Rs)</th></tr></thead>' +
        '<tbody>' + pnlRows + rupeeRow + '</tbody></table>' +
      '</div>' +
      graph +
      '<div style="margin:6px 0;color:#888;font-size:10px">' + esc(r.research || '') + '</div>';
    m.classList.remove('hidden');
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
    state.universal.tpPct = tpEl ? (Number(tpEl.value) || 0) : 0;
    save();
  }

  function readStrikeUI() {
    const modeEl = $id('aeStrikeMode'), cntEl = $id('aeStrikeCount'), otEl = $id('aeOptionType');
    state.strike.mode = modeEl ? (modeEl.value || 'both_atm') : 'both_atm';
    state.strike.count = cntEl ? (Number(cntEl.value) || 3) : 3;
    state.strike.optionType = otEl ? (otEl.value || 'both') : 'both';
    save();
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
    const g = $id('aeMoversGainers'), l = $id('aeMoversLosers'), ind = $id('aeMoversIndices');
    if (!state.movers) state.movers = { enabled: false, gainers: 5, losers: 5, includeIndices: true };
    state.movers.gainers = g ? (Number(g.value) || 0) : 0;
    state.movers.losers = l ? (Number(l.value) || 0) : 0;
    state.movers.includeIndices = ind ? ind.checked : true;
    save();
  }

  function addSymbol() {
    const el = $id('aeSymbolSelect');
    if (!el || !el.value) { log('Select a symbol to add', 'warn'); return; }
    let it;
    try { it = JSON.parse(el.value); } catch (e) { return; }
    const exists = (state.symbols || []).some(s => s.id === it.id && s.exch === it.exch);
    if (!exists) {
      state.symbols.push(it);
      save();
      renderSymbolList();
      log('Added symbol ' + (it.name || it.id), 'ok');
    }
  }

  function removeSymbol(id, exch) {
    state.symbols = (state.symbols || []).filter(s => !(String(s.id) === String(id) && String(s.exch || '') === String(exch || '')));
    save();
    renderSymbolList();
  }

  function renderSymbolList() {
    const el = $id('aeSymbolList');
    if (!el) return;
    const syms = state.symbols || [];
    el.innerHTML = syms.map(s =>
      '<span style="background:#1a1a35;border:1px solid #2d2d50;border-radius:3px;padding:2px 6px;display:inline-flex;align-items:center;gap:4px">' +
      esc(s.name || s.id) +
      '<span onclick="AutoExperiment.removeSymbol(\'' + esc(String(s.id)) + '\',\'' + esc(s.exch || '') + '\')" style="color:#ef5350;cursor:pointer;font-weight:700">x</span>' +
      '</span>').join('');
  }

  function populateSymbolsUI() {
    const el = $id('aeSymbolSelect');
    if (!el || el.dataset.populated) return;
    const list = (typeof SYMBOLS !== 'undefined' && Array.isArray(SYMBOLS)) ? SYMBOLS : [];
    if (!list.length) return;
    const groups = {};
    list.forEach(s => {
      const name = s[0], id = s[1], exch = s[2], inst = s[3], ocId = s[4], ocExch = s[5], grp = s[6];
      const g = grp || 'F&O Stocks';
      (groups[g] = groups[g] || []).push({ name, id, exch, inst, ocId, ocExch });
    });
    for (const [grp, items] of Object.entries(groups)) {
      const og = document.createElement('optgroup');
      og.label = grp;
      items.forEach(it => {
        const o = document.createElement('option');
        o.value = JSON.stringify({ id: it.id, exch: it.exch, inst: it.inst, name: it.name, ocId: it.ocId, ocExch: it.ocExch });
        o.textContent = it.name;
        og.appendChild(o);
      });
      el.appendChild(og);
    }
    el.dataset.populated = '1';
  }

  function applyUniversalToUI() {
    const u = state.universal;
    const set = (id, v) => { const el = $id(id); if (el) el.value = v; };
    set('aeLotSize', u.lotSize != null ? u.lotSize : '');
    set('aeLots', u.lots);
    set('aeMargin', u.margin);
    set('aeTp', u.tpPct);
    const st = state.strike || {};
    set('aeStrikeMode', st.mode || 'both_atm');
    set('aeStrikeCount', st.count || 3);
    set('aeOptionType', st.optionType || 'both');
    const enabledGroups = (state.groups && state.groups.length) ? state.groups : GROUP_KEYS.slice();
    GROUPS.forEach(g => {
      const el = $id('aeGroup_' + g.key);
      if (el) el.checked = enabledGroups.indexOf(g.key) >= 0;
    });
    applyMoversToUI();
    renderSymbolList();
    const stBtn = $id('aeStrikesToggle');
    if (stBtn) {
      stBtn.textContent = 'Picked Strikes: ' + (state.showPickedStrikes ? 'ON' : 'OFF');
      stBtn.style.background = state.showPickedStrikes ? '#00d4aa' : '#e67e22';
    }
    renderPickedStrikes();
    const t = $id('aeAutoToggle');
    if (t) { t.textContent = state.enabled ? 'Auto Strategy: ON' : 'Auto Strategy: OFF'; t.style.background = state.enabled ? '#00d4aa' : '#e67e22'; }
    const lm = $id('aeLiveToggle'), rm = $id('aeRunManualToggle');
    if (lm) lm.checked = !!state.liveMarket;
    if (rm) rm.checked = !!state.runManual;
    const allInOne = $id('aeAllInOne');
    if (allInOne) allInOne.checked = state.allInOne === true;
  }

  /* Reflect the top-movers state in the toolbar and gate the count inputs on
     the master toggle: the numeric fields and index checkbox are only usable
     while the top-movers auto experiment button is enabled. */
  function applyMoversToUI() {
    const mv = state.movers || (state.movers = { enabled: false, gainers: 5, losers: 5, includeIndices: true });
    const btn = $id('aeMoversToggle');
    if (btn) {
      btn.textContent = 'Top Movers: ' + (mv.enabled ? 'ON' : 'OFF');
      btn.style.background = mv.enabled ? '#00d4aa' : '#e67e22';
    }
    const setVal = (id, v) => { const el = $id(id); if (el) el.value = v; };
    setVal('aeMoversGainers', mv.gainers);
    setVal('aeMoversLosers', mv.losers);
    const ind = $id('aeMoversIndices');
    if (ind) ind.checked = !!mv.includeIndices;
    const on = !!mv.enabled;
    [ 'aeMoversGainers', 'aeMoversLosers', 'aeMoversIndices' ].forEach(id => {
      const el = $id(id);
      if (el) {
        el.disabled = !on;
        el.style.opacity = on ? '1' : '0.5';
      }
    });
    renderMoversList();
  }

  /* Visible live list of the daily top gainers, top losers and all indices
     that will be fed into the experiment, plus the change% that picked them.
     Always shown so the user can see the movers; the master toggle only
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
      if (!id || inst === 'INDEX') return;
      byId[id] = { name, id, exch, inst, ocId, ocExch, grp };
    });
    const quoted = [];
    for (const id in byId) {
      const s = byId[id];
      const q = qm[s.exch === 'IDX_I' ? 'IDX_I:' + s.id : String(s.id)];
      if (!q || q.change_pct === undefined) continue;
      const display = (typeof SYMBOL_DISPLAY_NAMES !== 'undefined' && SYMBOL_DISPLAY_NAMES[String(s.id)]) ? SYMBOL_DISPLAY_NAMES[String(s.id)] : s.name;
      quoted.push({ name: display, pct: Number(q.change_pct), grp: s.grp, inst: s.inst });
    }
    const withPct = quoted.filter(x => !isNaN(x.pct));
    const wantG = Math.max(0, Number(mv.gainers) || 0);
    const wantL = Math.max(0, Number(mv.losers) || 0);
    const gainers = withPct.filter(x => x.pct >= 0).sort((a, b) => b.pct - a.pct).slice(0, wantG);
    const losers = withPct.filter(x => x.pct < 0).sort((a, b) => a.pct - b.pct).slice(0, wantL);
    let indices = [];
    if (mv.includeIndices) {
      indices = list.filter(s => s[3] === 'INDEX').map(s => {
        const q = qm['IDX_I:' + s[1]];
        return { name: s[0], pct: (q && q.change_pct !== undefined) ? Number(q.change_pct) : null };
      });
    }
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
      const name = (typeof SYMBOL_DISPLAY_NAMES !== 'undefined' && SYMBOL_DISPLAY_NAMES[String(sym.id)]) ? SYMBOL_DISPLAY_NAMES[String(sym.id)] : (sym.name || String(sym.id));
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

  /* ---------------- public API ---------------- */
  const api = {
    run: runExperiment,
    deploy: deployResult,
    undeploy: undeployResult,
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
    toggleLive() {
      state.liveMarket = $id('aeLiveToggle').checked;
      save();
      log('Auto paper trading on live market ' + (state.liveMarket ? 'enabled' : 'disabled'), state.liveMarket ? 'ok' : 'warn');
    },
    toggleRunManual() {
      state.runManual = $id('aeRunManualToggle').checked;
      save();
    },
    onUniversalInput() {
      readUniversal();
    },
    /* "All indicators & filters together" entry mode for the AE engine. */
    onAllInOne() {
      const el = $id('aeAllInOne');
      state.allInOne = !!(el && el.checked);
      save();
      log('Entry "all indicators & filters together": ' + (state.allInOne ? 'ON (strict AND)' : 'OFF (old default)'), state.allInOne ? 'ok' : 'warn');
    },
    onStrikeInput() {
      readStrikeUI();
    },
    onGroupsInput() {
      readGroupsUI();
    },
    toggleMovers() {
      if (!state.movers) state.movers = { enabled: false, gainers: 5, losers: 5, includeIndices: true };
      state.movers.enabled = !state.movers.enabled;
      save();
      applyMoversToUI();
      log('Daily top gainers/losers + indices auto experiment ' + (state.movers.enabled ? 'enabled' : 'disabled'), state.movers.enabled ? 'ok' : 'warn');
    },
    onMoversInput() {
      readMoversUI();
      applyMoversToUI();
    },
    addSymbol,
    removeSymbol,
    renderMoversList,
    renderPickedStrikes,
    toggleStrikes,
    onTabShow() {
      populateSymbolsUI();
      applyUniversalToUI();
      render();
    },
    getState() { return state; },
    tick: paperTick
  };
  window.AutoExperiment = api;

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
    populateSymbolsUI();
    applyUniversalToUI();
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
})();
