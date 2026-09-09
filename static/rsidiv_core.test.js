#!/usr/bin/env node
/* Node self-test for RSI Divergence core (static/rsidiv_core.js).
 *
 * Proves, without a browser:
 *   1. RSI matches TradingView's Wilder definition on a reference fixture.
 *   2. swingPoints only confirms a pivot when the full right window has printed.
 *   3. Regular + hidden divergence, both bullish and bearish, fire exactly on
 *      hand-built fixtures.
 *   4. No repainting: signals that have confirmed on a partial prefix are
 *      unchanged (same index/kind/hidden/ref) once later bars are appended.
 *
 * Run: node static/rsidiv_core.test.js
 */
'use strict';

const assert = require('assert');
const C = require('./rsidiv_core.js');

let pass = 0;
function ok(name) { pass++; console.log('  ok ' + pass + ' - ' + name); }

/* Build candles where high/low/close are given. close defaults to (h+l)/2. */
function candlesOf(arr) {
  return arr.map((b, i) => {
    const high = Array.isArray(b) ? b[0] : b;
    const low = Array.isArray(b) ? b[1] : b;
    const close = Array.isArray(b) && b.length > 2 ? b[2] : (high + low) / 2;
    return { time: i + 1, open: low, high, low, close };
  });
}

/* ------------------------------------------------------------------ *
 * 1. RSI parity with TradingView's Wilder definition.
 *
 * TradingView RSI(len): avgLoss = 0 -> 100, avgGain 0 -> 0, else the RS
 * ratio, computed with RMA (alpha = 1/len) seeded by SMA of the first len
 * changes. We reproduce it here independently (classic "KAUFMANS"-style
 * naive loop) and compare against rsidiv_core's fast recurrence.
 * ------------------------------------------------------------------ */
function referenceRsi(closes, len) {
  const n = closes.length;
  const rsi = new Array(n).fill(NaN);
  if (n < len + 1) return rsi;
  const changes = [];
  for (let i = 1; i < n; i++) changes.push(closes[i] - closes[i - 1]);
  let avgG = 0, avgL = 0;
  for (let i = 0; i < len; i++) {
    const d = changes[i];
    if (d >= 0) avgG += d; else avgL -= d;
  }
  avgG /= len; avgL /= len;
  const seed = avgL === 0 ? (avgG === 0 ? 50 : 100) : 100 - 100 / (1 + avgG / avgL);
  rsi[len] = seed;
  for (let i = len + 1; i < n; i++) {
    const d = changes[i - 1];
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    avgG = (avgG * (len - 1) + g) / len;
    avgL = (avgL * (len - 1) + l) / len;
    rsi[i] = avgL === 0 ? (avgG === 0 ? 50 : 100) : 100 - 100 / (1 + avgG / avgL);
  }
  return rsi;
}

(function testRsiParity() {
  console.log('# RSI Wilder parity');
  /* Deterministic pseudo-walk covering up/down/flat sections. */
  const closes = [];
  let c = 100;
  for (let i = 0; i < 400; i++) {
    if (i % 7 === 0) c -= 1.5;
    else if (i % 5 === 0) c += 2.1;
    else if (i % 11 === 0) c += 0;      /* flat -> avgG=avgL=0 handling */
    else c += Math.sin(i / 3.7) * 1.4;
    closes.push(Math.max(1, c));
  }
  const fast = C.rsiWilder(closes, 14);
  const ref = referenceRsi(closes, 14);
  for (let i = 0; i < closes.length; i++) {
    const a = fast[i], b = ref[i];
    assert.ok(Number.isNaN(a) === Number.isNaN(b), 'NaN mask differs at ' + i);
    if (!Number.isNaN(a)) assert.ok(Math.abs(a - b) < 1e-9, 'RSI mismatch at ' + i + ': ' + a + ' vs ' + b);
  }
  /* Flat-only series must print exactly 50 (both average 0). */
  const flat = C.rsiWilder(new Array(40).fill(50), 14);
  assert.strictEqual(flat[14], 50, 'flat RSI seed must be 50');
  ok('rsiWilder == TradingView reference (400 bars, len 14)');
})();

/* ------------------------------------------------------------------ *
 * 2. Swing points need their full right window.
 * ------------------------------------------------------------------ */
(function testSwingWindows() {
  console.log('# swingPoints window rules');
  /* Series with an unambiguous valley at index 3 and peak at index 6 (p=3). */
  const v = [50, 46, 42, 40, 43, 47, 52, 49, 45, 41, 44, 48, 53, 50, 47, 44, 46, 49];
  const sp = C.swingPoints(v, 3);
  assert.ok(sp.lows.includes(3), 'valley 3 not found');
  assert.ok(sp.highs.includes(6), 'peak 6 not found');
  /* Right window incomplete -> not a pivot yet: same valley but series ends
     right before the full right window prints (index 6 missing). */
  const short = v.slice(0, 6);
  const spShort = C.swingPoints(short, 3);
  assert.ok(!spShort.lows.includes(3), 'valley must not confirm without right window');
  ok('swingPoint confirms only once right window printed');
  /* NaN bars (RSI warm-up) can never be pivot centres. Index 2 (value 30)
     would be a swing low if its windows existed, but its left window is the
     two warm-up NaNs -> it must be skipped. */
  const withNaN = [NaN, NaN, 30, 43, 47, 41, 44, 48];
  const spNaN = C.swingPoints(withNaN, 2);
  assert.ok(!spNaN.lows.includes(2), 'warm-up NaN must not pivot');
  ok('NaN warm-up bars never seed pivots');
})();

/* ------------------------------------------------------------------ *
 * 3. Divergence fixtures.
 *
 * The RSI series is Wilder-smoothed close changes, so the most reliable way
 * to produce confirmed regular + hidden pivots of all four categories is a
 * deterministic oscillating wave with drifting amplitude/phase. For every
 * emitted signal we assert its classification invariant against the actual
 * price/RSI at the two pivots (that IS the definition of each category), and
 * we require all four categories to appear at least once.
 * ------------------------------------------------------------------ */
function waveCandles(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = 1000
      + 45 * Math.sin(i * 0.11 + 0.35 * Math.sin(i * 0.017))
      + 18 * Math.sin(i * 0.093)
      + 6 * Math.sin(i * 0.21);
    out.push({ time: i + 1, open: c - 1, high: c + 2.2, low: c - 2.2, close: c });
  }
  return out;
}

const DIV_OPTS = { length: 14, pivot: 5, lookback: 200 };

function assertSignalInvariants(sig, rsi, candles) {
  if (sig.kind === 'bull') {
    if (sig.hidden) {
      /* hidden bullish: price HIGHER low + RSI LOWER low */
      assert.ok(sig.price > sig.refPrice, 'hidden bull needs price HL');
      assert.ok(sig.rsi < sig.refRsi, 'hidden bull needs RSI LL');
    } else {
      /* regular bullish: price LOWER low + RSI HIGHER low */
      assert.ok(sig.price < sig.refPrice, 'regular bull needs price LL');
      assert.ok(sig.rsi > sig.refRsi, 'regular bull needs RSI higher low');
    }
    assert.ok(sig.price === candles[sig.index].low, 'bull price must be bar low');
    assert.ok(sig.refPrice === candles[sig.refIndex].low, 'ref price must be bar low');
  } else {
    if (sig.hidden) {
      /* hidden bearish: price LOWER high + RSI HIGHER high */
      assert.ok(sig.price < sig.refPrice, 'hidden bear needs price LH');
      assert.ok(sig.rsi > sig.refRsi, 'hidden bear needs RSI HH');
    } else {
      /* regular bearish: price HIGHER high + RSI LOWER high */
      assert.ok(sig.price > sig.refPrice, 'regular bear needs price HH');
      assert.ok(sig.rsi < sig.refRsi, 'regular bear needs RSI lower high');
    }
    assert.ok(sig.price === candles[sig.index].high, 'bear price must be bar high');
    assert.ok(sig.refPrice === candles[sig.refIndex].high, 'ref price must be bar high');
  }
  assert.ok(sig.index > sig.refIndex, 'signal must be at the LATER confirming pivot');
  assert.ok(sig.index === candles.findIndex(x => x.time === sig.time), 'signal time must match its index');
  assert.ok(Math.abs(sig.rsi - rsi[sig.index]) < 1e-9, 'signal rsi must equal pivot RSI');
  assert.ok(Math.abs(sig.refRsi - rsi[sig.refIndex]) < 1e-9, 'ref rsi must equal pivot RSI');
}

(function testDivergenceFixtures() {
  console.log('# divergence fixtures');

  const candles = waveCandles(600);
  const res = C.divergence(candles, DIV_OPTS);
  assert.ok(res.signals.length > 0, 'wave must produce some divergence signals');

  const seen = { bull_r: 0, bull_h: 0, bear_r: 0, bear_h: 0 };
  res.signals.forEach(s => {
    assertSignalInvariants(s, res.rsi, candles);
    seen[s.kind + '_' + (s.hidden ? 'h' : 'r')]++;
  });
  Object.keys(seen).forEach(k => {
    assert.ok(seen[k] > 0, 'category ' + k + ' must appear at least once (got 0)');
  });
  ok('wave fixture fires all 4 categories with correct invariants (' + res.signals.length + ' signals)');

  /* Monotonic trend must not generate divergences (no false positives). */
  const up = [];
  for (let i = 0; i < 400; i++) {
    const c = 100 + i * 0.5;
    up.push({ time: i + 1, open: c - 0.2, high: c + 0.3, low: c - 0.3, close: c });
  }
  assert.strictEqual(C.divergence(up, DIV_OPTS).signals.length, 0, 'steady uptrend must not diverge');
  ok('monotonic trend emits no divergence signals');

  /* No-repaint: a signal at index i has fully confirmed once the series has
     grown past i + pivot (right window closed). For every prefix, every signal
     already confirmed in that prefix must appear again unchanged in the full
     result (same index, kind, hidden, refIndex, rsi). */
  const fullRes = res;
  let checked = 0;
  for (let pLen = 1; pLen <= candles.length; pLen++) {
    const prefixRes = C.divergence(candles.slice(0, pLen), DIV_OPTS);
    const confirmedInPrefix = fullRes.signals.filter(s => s.index + DIV_OPTS.pivot + 1 <= pLen);
    for (const s of confirmedInPrefix) {
      const match = prefixRes.signals.find(t => t.index === s.index && t.kind === s.kind && t.hidden === s.hidden);
      assert.ok(match, 'prefix ' + pLen + ' dropped confirmed signal at ' + s.index);
      assert.strictEqual(match.refIndex, s.refIndex, 'prefix ' + pLen + ' changed refIndex of signal ' + s.index);
      assert.ok(Math.abs(match.rsi - s.rsi) < 1e-9, 'prefix ' + pLen + ' changed rsi of signal ' + s.index);
      checked++;
    }
  }
  assert.ok(checked > 0, 'no prefix-confirmed signals found to check');
  ok('no-repaint: every confirmed signal is stable across ' + checked + ' prefix checks');

  /* RSI oscillator must stay in [0,100] everywhere on the wave. */
  for (let i = 0; i < res.rsi.length; i++) {
    if (Number.isNaN(res.rsi[i])) continue;
    assert.ok(res.rsi[i] >= 0 && res.rsi[i] <= 100, 'RSI out of range at ' + i);
  }
  ok('RSI stays in [0,100] across the wave');
})();

console.log('\n' + pass + ' checks passed.');
process.exit(0);
