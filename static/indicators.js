/* Dhan Algo - TradingView-style indicators engine (lightweight-charts v5) */
(function () {
  'use strict';

  /* ---------------- math helpers ---------------- */
  function smaArr(vals, p) {
    const out = new Array(vals.length).fill(null);
    if (p <= 0) return out;
    let sum = 0;
    for (let i = 0; i < vals.length; i++) {
      sum += vals[i];
      if (i >= p) sum -= vals[i - p];
      if (i >= p - 1) out[i] = sum / p;
    }
    return out;
  }

  function emaArr(vals, p) {
    const out = new Array(vals.length).fill(null);
    if (vals.length < p || p <= 0) return out;
    const k = 2 / (p + 1);
    let prev = smaArr(vals, p)[p - 1];
    out[p - 1] = prev;
    for (let i = p; i < vals.length; i++) {
      prev = vals[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  function highestArr(vals, p) {
    const out = new Array(vals.length).fill(null);
    for (let i = p - 1; i < vals.length; i++) {
      let m = -Infinity;
      for (let j = i - p + 1; j <= i; j++) if (vals[j] > m) m = vals[j];
      out[i] = m;
    }
    return out;
  }

  function lowestArr(vals, p) {
    const out = new Array(vals.length).fill(null);
    for (let i = p - 1; i < vals.length; i++) {
      let m = Infinity;
      for (let j = i - p + 1; j <= i; j++) if (vals[j] < m) m = vals[j];
      out[i] = m;
    }
    return out;
  }

  function stdevArr(vals, p) {
    const out = new Array(vals.length).fill(null);
    const mean = smaArr(vals, p);
    for (let i = p - 1; i < vals.length; i++) {
      let s = 0;
      for (let j = i - p + 1; j <= i; j++) s += (vals[j] - mean[i]) * (vals[j] - mean[i]);
      out[i] = Math.sqrt(s / p);
    }
    return out;
  }

  function wilderArr(vals, p) {
    const out = new Array(vals.length).fill(null);
    if (vals.length < p || p <= 0) return out;
    let sum = 0;
    for (let i = 0; i < p; i++) sum += vals[i];
    let prev = sum / p;
    out[p - 1] = prev;
    for (let i = p; i < vals.length; i++) {
      prev = (prev * (p - 1) + vals[i]) / p;
      out[i] = prev;
    }
    return out;
  }

  function trArr(c) {
    const out = new Array(c.length).fill(0);
    if (!c.length) return out;
    out[0] = c[0].high - c[0].low;
    for (let i = 1; i < c.length; i++) {
      out[i] = Math.max(
        c[i].high - c[i].low,
        Math.abs(c[i].high - c[i - 1].close),
        Math.abs(c[i].low - c[i - 1].close)
      );
    }
    return out;
  }

  function srcArr(c, key) {
    if (key === 'hl2') return c.map(x => (x.high + x.low) / 2);
    if (key === 'hlc3') return c.map(x => (x.high + x.low + x.close) / 3);
    if (key === 'hlcc4') return c.map(x => (x.high + x.low + 2 * x.close) / 4);
    return c.map(x => x[key]);
  }

  /* EMA that tolerates warmup gaps: only the p-th valid reading (and later)
     produces output, so a nested EMA over an array that itself starts late
     (e.g. TSI/Fisher second-stage smoothing) never sees NaN in its seed. */
  function emaSkip(src, p) {
    const out = new Array(src.length).fill(null);
    if (p <= 0) return out;
    const k = 2 / (p + 1);
    let cnt = 0, prev = null, seed = 0;
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      if (v == null || isNaN(v)) continue;
      if (prev == null) {
        seed += v; cnt++;
        if (cnt === p) { prev = seed / p; out[i] = prev; }
      } else {
        prev = v * k + prev * (1 - k);
        out[i] = prev;
      }
    }
    return out;
  }

  function buildSeries(c, arr, color, type, lineWidth) {
    const data = [];
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] == null || isNaN(arr[i])) continue;
      data.push({ time: c[i].time, value: arr[i] });
    }
    return { type: type || 'line', color, lineWidth: lineWidth || 1, data };
  }

  /* ---------------- Bollinger %B ---------------- */
  /* Population standard deviation via rolling sum/sum-of-squares: O(n) over the
     whole series (the naive per-bar deviation loop is O(n*L)), so BB%b stays
     cheap even with thousands of candles loaded. Mathematically identical to
     TradingView's %B = (source - lower) / (upper - lower) with
     lower = SMA - mult*STD and upper = SMA + mult*STD. */
  function bbpctRawSeriesTail(c, o, tailCount) {
    const n = c.length;
    const L = Math.max(1, Math.round(o.length) || 20);
    if (n < L || tailCount < 1) return null;
    const start = n - tailCount;
    const w0 = start - L + 1;
    if (w0 < 0) return null;
    const src = srcArr(c, o.source || 'close');
    const mult = Number(o.mult) > 0 ? Number(o.mult) : 2;
    let sum = 0, sumsq = 0;
    for (let i = w0; i < w0 + L; i++) { const v = src[i]; sum += v; sumsq += v * v; }
    const out = new Array(tailCount);
    for (let k = 0; k < tailCount; k++) {
      const i = start + k;
      if (k > 0) {
        const old = src[i - L]; sum -= old; sumsq -= old * old;
        const nw = src[i]; sum += nw; sumsq += nw * nw;
      }
      const mean = sum / L;
      const var0 = Math.max(0, sumsq / L - mean * mean);
      const sd = Math.sqrt(var0);
      const up = mean + mult * sd, lo = mean - mult * sd;
      const range = up - lo;
      out[k] = range > 0 ? (src[i] - lo) / range : 0.5;
    }
    return out;
  }

  /* {prev, last} BB%b readings for the last two bars. Cost is O((smooth+1)*L)
     — independent of the total candle count — so the strategy engine and the
     per-tick alert/realtime path stay well under 1 ms on any chart size. */
  function bbpctLastTwo(c, o) {
    const s = Math.max(1, Math.round(o.smooth || 1));
    const tail = s + 1;
    const raw = bbpctRawSeriesTail(c, o, tail);
    if (!raw) return { last: null, prev: null };
    let last = raw[tail - 1], prev = raw[tail - 2];
    if (s > 1) {
      let sl = 0, sp = 0;
      for (let k = tail - s; k < tail; k++) sl += raw[k];
      for (let k = tail - s - 1; k < tail - 1; k++) sp += raw[k];
      last = sl / s; prev = sp / s;
    }
    return { last, prev };
  }

  /* ---------------- indicator definitions ---------------- */
  const IND = {
    ema: {
      id: 'ema', name: 'EMA', fullName: 'Exponential Moving Average', cat: 'Overlay', type: 'overlay',
      inputs: [
        { key: 'length', label: 'Length', def: 9, min: 1, max: 500, step: 1 },
        { key: 'source', label: 'Source', def: 'close', options: [['close', 'Close'], ['open', 'Open'], ['high', 'High'], ['low', 'Low'], ['hl2', 'HL2'], ['hlc3', 'HLC3'], ['hlcc4', 'HLCC4']] }
      ],
      style: [
        { key: 'color', label: 'Color', def: '#2962ff' },
        { key: 'lineWidth', label: 'Line width', def: 1, min: 1, max: 5, step: 1 }
      ],
      compute(c, o) {
        return [buildSeries(c, emaArr(srcArr(c, o.source), o.length), o.color, 'line', o.lineWidth)];
      }
    },

    ma: {
      id: 'ma', name: 'MA', fullName: 'Moving Average', cat: 'Overlay', type: 'overlay',
      inputs: [
        { key: 'length', label: 'Length', def: 20, min: 1, max: 500, step: 1 },
        { key: 'source', label: 'Source', def: 'close', options: [['close', 'Close'], ['open', 'Open'], ['high', 'High'], ['low', 'Low'], ['hl2', 'HL2'], ['hlc3', 'HLC3'], ['hlcc4', 'HLCC4']] }
      ],
      style: [
        { key: 'color', label: 'Color', def: '#ff6d00' },
        { key: 'lineWidth', label: 'Line width', def: 1, min: 1, max: 5, step: 1 }
      ],
      compute(c, o) {
        return [buildSeries(c, smaArr(srcArr(c, o.source), o.length), o.color, 'line', o.lineWidth)];
      }
    },

    smma: {
      id: 'smma', name: 'Smoothed MA', fullName: 'Smoothed Moving Average', cat: 'Overlay', type: 'overlay',
      inputs: [
        { key: 'length', label: 'Length', def: 20, min: 1, max: 500, step: 1 },
        { key: 'source', label: 'Source', def: 'close', options: [['close', 'Close'], ['open', 'Open'], ['high', 'High'], ['low', 'Low'], ['hl2', 'HL2'], ['hlc3', 'HLC3'], ['hlcc4', 'HLCC4']] }
      ],
      style: [
        { key: 'color', label: 'Color', def: '#ffca28' },
        { key: 'lineWidth', label: 'Line width', def: 1, min: 1, max: 5, step: 1 }
      ],
      compute(c, o) {
        return [buildSeries(c, wilderArr(srcArr(c, o.source), o.length), o.color, 'line', o.lineWidth)];
      }
    },

    ao: {
      id: 'ao', name: 'Awesome Oscillator', fullName: 'Awesome Oscillator', cat: 'Momentum', type: 'pane',
      inputs: [
        { key: 'fast', label: 'Fast length', def: 5, min: 1, max: 200, step: 1 },
        { key: 'slow', label: 'Slow length', def: 34, min: 2, max: 500, step: 1 }
      ],
      style: [
        { key: 'upColor', label: 'Up color', def: '#26a69a' },
        { key: 'downColor', label: 'Down color', def: '#ef5350' }
      ],
      compute(c, o) {
        const med = c.map(x => (x.high + x.low) / 2);
        const f = smaArr(med, o.fast), s = smaArr(med, o.slow);
        const data = [];
        let prev = null;
        for (let i = 0; i < c.length; i++) {
          if (f[i] == null || s[i] == null) continue;
          const v = f[i] - s[i];
          const up = prev == null ? true : v >= prev;
          data.push({ time: c[i].time, value: v, color: up ? o.upColor : o.downColor });
          prev = v;
        }
        return [{ type: 'histogram', color: o.upColor, data }];
      }
    },

    atr: {
      id: 'atr', name: 'ATR', fullName: 'Average True Range', cat: 'Volatility', type: 'pane',
      inputs: [{ key: 'length', label: 'Length', def: 14, min: 1, max: 200, step: 1 }],
      style: [
        { key: 'color', label: 'Color', def: '#7e57c2' },
        { key: 'lineWidth', label: 'Line width', def: 1, min: 1, max: 5, step: 1 }
      ],
      compute(c, o) {
        return [buildSeries(c, wilderArr(trArr(c), o.length), o.color, 'line', o.lineWidth)];
      }
    },

    adx: {
      id: 'adx', name: 'ADX', fullName: 'Average Directional Index', cat: 'Volatility', type: 'pane', format: 'percent',
      inputs: [{ key: 'length', label: 'Length', def: 14, min: 1, max: 200, step: 1 }],
      style: [
        { key: 'adxColor', label: 'ADX color', def: '#e040fb' },
        { key: 'diPlusColor', label: '+DI color', def: '#26a69a' },
        { key: 'diMinusColor', label: '-DI color', def: '#ef5350' },
        { key: 'lineWidth', label: 'Line width', def: 1, min: 1, max: 5, step: 1 }
      ],
      compute(c, o) {
        const n = o.length;
        const up = new Array(c.length).fill(0), dn = new Array(c.length).fill(0), tr = trArr(c);
        for (let i = 1; i < c.length; i++) {
          const um = c[i].high - c[i - 1].high;
          const dm = c[i - 1].low - c[i].low;
          up[i] = (um > dm && um > 0) ? um : 0;
          dn[i] = (dm > um && dm > 0) ? dm : 0;
        }
        const sutr = wilderArr(tr, n), sup = wilderArr(up, n), sdn = wilderArr(dn, n);
        const diP = new Array(c.length).fill(null), diM = new Array(c.length).fill(null), dx = new Array(c.length).fill(null);
        for (let i = n - 1; i < c.length; i++) {
          if (!sutr[i]) continue;
          diP[i] = 100 * sup[i] / sutr[i];
          diM[i] = 100 * sdn[i] / sutr[i];
          const sum = diP[i] + diM[i];
          dx[i] = sum ? 100 * Math.abs(diP[i] - diM[i]) / sum : 0;
        }
        const adxArr = wilderArr(dx.map((v, i) => (i >= n - 1 && v != null) ? v : 0), n);
        const s1 = buildSeries(c, adxArr, o.adxColor, 'line', o.lineWidth);
        const s2 = buildSeries(c, diP, o.diPlusColor, 'line', o.lineWidth);
        const s3 = buildSeries(c, diM, o.diMinusColor, 'line', o.lineWidth);
        return [s1, s2, s3];
      }
    },

    bollingerB: {
      id: 'bollingerB', name: 'Bollinger Bands %B', fullName: 'Bollinger Bands %B', cat: 'Volatility', type: 'pane', format: 'decimal',
      inputs: [
        { key: 'length', label: 'Length', def: 20, min: 1, max: 200, step: 1 },
        { key: 'mult', label: 'Mult', def: 2.0, min: 0.1, max: 10, step: 0.1 }
      ],
      style: [
        { key: 'color', label: 'Color', def: '#42a5f5' },
        { key: 'lineWidth', label: 'Line width', def: 1, min: 1, max: 5, step: 1 }
      ],
      compute(c, o) {
        const cl = srcArr(c, 'close');
        const mid = smaArr(cl, o.length), sd = stdevArr(cl, o.length);
        const data = [];
        for (let i = o.length - 1; i < c.length; i++) {
          const up = mid[i] + o.mult * sd[i], lo = mid[i] - o.mult * sd[i];
          const range = up - lo;
          data.push({ time: c[i].time, value: range ? (cl[i] - lo) / range : 0 });
        }
        return [{ type: 'line', color: o.color, lineWidth: o.lineWidth, data }];
      }
    },

    bbpct: {
      id: 'bbpct', name: 'BB%b', fullName: 'Bollinger %B', cat: 'Trend', type: 'pane',
      format: 'decimal',
      inputs: [
        { key: 'length', label: 'Length', def: 20, min: 2, max: 200, step: 1 },
        { key: 'mult', label: 'Std.dev mult', def: 2, min: 0.1, max: 5, step: 0.1 }
      ],
      style: [
        { key: 'color', label: 'Color', def: '#ffb300' },
        { key: 'lineWidth', label: 'Line width', def: 1, min: 1, max: 5, step: 1 }
      ],
      compute(c, o) {
        const L = Math.max(1, Math.round(o.length) || 20);
        const mult = Number(o.mult) > 0 ? Number(o.mult) : 2;
        const s = Math.max(1, Math.round(o.smooth || 1));
        const src = srcArr(c, o.source || 'close');
        const n = c.length;
        const b = new Array(n).fill(null);
        if (n >= L) {
          let sum = 0, sumsq = 0;
          for (let i = 0; i < n; i++) {
            const v = src[i]; sum += v; sumsq += v * v;
            if (i >= L) { const old = src[i - L]; sum -= old; sumsq -= old * old; }
            if (i >= L - 1) {
              const mean = sum / L;
              const var0 = Math.max(0, sumsq / L - mean * mean);
              const sd = Math.sqrt(var0);
              const up = mean + mult * sd, lo = mean - mult * sd;
              const range = up - lo;
              b[i] = range > 0 ? (v - lo) / range : 0.5;
            }
          }
        }
        const validB = [], validT = [];
        for (let i = L - 1; i < n; i++) { validB.push(b[i]); validT.push(c[i].time); }
        const sm = smaArr(validB, s);
        const data = [];
        for (let i = 0; i < validB.length; i++) if (sm[i] != null) data.push({ time: validT[i], value: sm[i] });
        return [{ type: 'line', color: o.color, lineWidth: o.lineWidth || 1, data }];
      }
    },

    macd: {
      id: 'macd', name: 'MACD', fullName: 'MACD', cat: 'Momentum', type: 'pane',
      inputs: [
        { key: 'fast', label: 'Fast length', def: 12, min: 1, max: 200, step: 1 },
        { key: 'slow', label: 'Slow length', def: 26, min: 2, max: 500, step: 1 },
        { key: 'signal', label: 'Signal length', def: 9, min: 1, max: 200, step: 1 }
      ],
      style: [
        { key: 'macdColor', label: 'MACD line', def: '#2962ff' },
        { key: 'signalColor', label: 'Signal line', def: '#ff6d00' },
        { key: 'histUpColor', label: 'Histogram up', def: '#26a69a' },
        { key: 'histDownColor', label: 'Histogram down', def: '#ef5350' }
      ],
      compute(c, o) {
        const cl = srcArr(c, 'close');
        const f = emaArr(cl, o.fast), s = emaArr(cl, o.slow);
        const macd = new Array(c.length).fill(null), histArr = new Array(c.length).fill(null);
        for (let i = 0; i < c.length; i++) if (f[i] != null && s[i] != null) macd[i] = f[i] - s[i];
        const signal = emaArr(macd.map((v, i) => v != null ? v : 0), o.signal);
        const hist = [];
        let prevH = null;
        for (let i = 0; i < c.length; i++) {
          if (macd[i] == null || signal[i] == null) continue;
          const h = macd[i] - signal[i];
          const up = prevH == null ? true : h >= prevH;
          hist.push({ time: c[i].time, value: h, color: up ? o.histUpColor : o.histDownColor });
          prevH = h;
        }
        return [
          buildSeries(c, macd, o.macdColor, 'line'),
          buildSeries(c, signal, o.signalColor, 'line'),
          { type: 'histogram', color: o.histUpColor, data: hist }
        ];
      }
    },

    supertrend: {
      id: 'supertrend', name: 'Supertrend', fullName: 'Supertrend', cat: 'Overlay', type: 'overlay',
      inputs: [
        { key: 'atrPeriod', label: 'ATR period', def: 10, min: 1, max: 200, step: 1 },
        { key: 'factor', label: 'Factor', def: 3.0, min: 0.1, max: 10, step: 0.1 }
      ],
      style: [
        { key: 'upColor', label: 'Up color', def: '#26a69a' },
        { key: 'downColor', label: 'Down color', def: '#ef5350' },
        { key: 'lineWidth', label: 'Line width', def: 1, min: 1, max: 5, step: 1 }
      ],
      compute(c, o) {
        const atr = wilderArr(trArr(c), o.atrPeriod);
        const data = [];
        let fu = null, fl = null, trend = 1;
        for (let i = 0; i < c.length; i++) {
          if (atr[i] == null) continue;
          const hl2 = (c[i].high + c[i].low) / 2;
          const bu = hl2 + o.factor * atr[i];
          const bl = hl2 - o.factor * atr[i];
          if (i === 0) { fu = bu; fl = bl; }
          else {
            fu = (bu < fu || c[i - 1].close > fu) ? bu : fu;
            fl = (bl > fl || c[i - 1].close < fl) ? bl : fl;
            if (trend === 1 && c[i].close < fl) trend = -1;
            else if (trend === -1 && c[i].close > fu) trend = 1;
          }
          data.push({ time: c[i].time, value: trend === 1 ? fl : fu, color: trend === 1 ? o.upColor : o.downColor });
        }
        return [{ type: 'line', color: o.upColor, lineWidth: o.lineWidth, data }];
      }
    },

    obv: {
      id: 'obv', name: 'OBV', fullName: 'On-Balance Volume', cat: 'Volume', type: 'pane',
      inputs: [
        { key: 'maLength', label: 'Smoothing length', def: 30, min: 1, max: 500, step: 1 },
        { key: 'maType', label: 'Smoothing type', def: 'sma', options: [['sma', 'SMA'], ['ema', 'EMA']] }
      ],
      style: [
        { key: 'color', label: 'OBV color', def: '#2962ff' },
        { key: 'maColor', label: 'Signal color', def: '#ff9800' },
        { key: 'lineWidth', label: 'Line width', def: 1, min: 1, max: 5, step: 1 }
      ],
      compute(c, o) {
        const out = new Array(c.length).fill(0);
        for (let i = 1; i < c.length; i++) {
          if (c[i].close > c[i - 1].close) out[i] = out[i - 1] + c[i].volume;
          else if (c[i].close < c[i - 1].close) out[i] = out[i - 1] - c[i].volume;
          else out[i] = out[i - 1];
        }
        const len = o.maLength || 30;
        const ma = o.maType === 'ema' ? emaArr(out, len) : smaArr(out, len);
        return [
          buildSeries(c, out, o.color, 'line', o.lineWidth),
          buildSeries(c, ma, o.maColor, 'line', o.lineWidth)
        ];
      }
    },

    smiio: {
      id: 'smiio', name: 'SMI Ergodic Oscillator', fullName: 'SMI Ergodic Oscillator', cat: 'Momentum', type: 'pane', format: 'percent',
      inputs: [
        { key: 'shortlen', label: 'Short length', def: 13, min: 1, max: 100, step: 1 },
        { key: 'longlen', label: 'Long length', def: 25, min: 2, max: 200, step: 1 },
        { key: 'siglen', label: 'Signal length', def: 9, min: 1, max: 100, step: 1 }
      ],
      style: [
        { key: 'color', label: 'SMI line', def: '#7e57c2' },
        { key: 'signalColor', label: 'Signal line', def: '#ff6d00' },
        { key: 'histColor', label: 'Histogram line', def: '#42a5f5' },
        { key: 'lineWidth', label: 'Line width', def: 1, min: 1, max: 5, step: 1 }
      ],
      compute(c, o) {
        const shortlen = Math.max(1, Math.round(o.shortlen != null ? o.shortlen : (o.smooth || 13)));
        const longlen = Math.max(2, Math.round(o.longlen != null ? o.longlen : (o.smooth || 25)));
        const siglen = Math.max(1, Math.round(o.siglen != null ? o.siglen : (o.signalLength || 9)));
        const pc = c.map(x => x.close - (x.high + x.low) / 2);
        const ap = c.map(x => Math.abs(x.close - (x.high + x.low) / 2));
        const p1 = emaArr(pc, shortlen), p2 = emaArr(p1, longlen);
        const a1 = emaArr(ap, shortlen), a2 = emaArr(a1, longlen);
        const smi = new Array(c.length).fill(null);
        for (let i = 0; i < c.length; i++) if (a2[i]) smi[i] = 100 * p2[i] / a2[i];
        const signal = emaArr(smi.map((v, i) => v != null ? v : 0), siglen);
        const hist = new Array(c.length).fill(null);
        for (let i = 0; i < c.length; i++) if (smi[i] != null && signal[i] != null) hist[i] = smi[i] - signal[i];
        return [
          buildSeries(c, smi, o.color, 'line', o.lineWidth),
          buildSeries(c, signal, o.signalColor, 'line', o.lineWidth),
          buildSeries(c, hist, o.histColor, 'line', o.lineWidth)
        ];
      }
    },

    bb: {
      id: 'bb', name: 'Bollinger Bands', fullName: 'Bollinger Bands', cat: 'Volatility', type: 'overlay',
      inputs: [
        { key: 'length', label: 'Length', def: 20, min: 1, max: 200, step: 1 },
        { key: 'mult', label: 'Mult', def: 2.0, min: 0.1, max: 10, step: 0.1 },
        { key: 'source', label: 'Source', def: 'close', options: [['close', 'Close'], ['open', 'Open'], ['high', 'High'], ['low', 'Low'], ['hl2', 'HL2'], ['hlc3', 'HLC3'], ['hlcc4', 'HLCC4']] },
        { key: 'midType', label: 'Middle Band', def: 'sma', options: [['sma', 'SMA'], ['ema', 'EMA']] },
        { key: 'midLength', label: 'Mid Band Period', def: 20, min: 1, max: 500, step: 1 }
      ],
      style: [
        { key: 'upColor', label: 'Upper band', def: '#42a5f5' },
        { key: 'midColor', label: 'Middle band', def: '#ffca28' },
        { key: 'dnColor', label: 'Lower band', def: '#42a5f5' },
        { key: 'lineWidth', label: 'Line width', def: 1, min: 1, max: 5, step: 1 }
      ],
      compute(c, o) {
        const cl = srcArr(c, o.source);
        const midLen = o.midLength || o.length || 20;
        const mid = o.midType === 'ema' ? emaArr(cl, midLen) : smaArr(cl, midLen);
        const sd = stdevArr(cl, o.length);
        const up = [], dn = [], m = [];
        for (let i = o.length - 1; i < c.length; i++) {
          up.push({ time: c[i].time, value: mid[i] + o.mult * sd[i] });
          m.push({ time: c[i].time, value: mid[i] });
          dn.push({ time: c[i].time, value: mid[i] - o.mult * sd[i] });
        }
        return [
          { type: 'line', color: o.upColor, lineWidth: o.lineWidth, data: up },
          { type: 'line', color: o.midColor, lineWidth: o.lineWidth, data: m },
          { type: 'line', color: o.dnColor, lineWidth: o.lineWidth, data: dn }
        ];
      }
    },

    /* Auto Support Resistance
     * Candlestick-structure indicator. Detects the swing structure of the candles
     * AUTOMATICALLY with an ATR-scaled ZigZag (no manual pivot tuning - the
     * reversal threshold adapts to the instrument's volatility), then draws two
     * FULL-WIDTH price lines on the chart:
     *   - Resistance line at the LAST HIGH of the current up-leg
     *     (the running max high since the last confirmed swing low).
     *   - Support line at the LAST LOW of the current down-leg
     *     (the running min low since the last confirmed swing high).
     * Because the two levels come from different legs (separated by at least one
     * ATR-mult threshold), they never sit on top of each other. The active leg's
     * line is drawn solid; the opposite level is dashed. When a new bullish /
     * bearish structure confirms (a new ZigZag reversal), the stale lines are
     * replaced in-place by the new trend's levels.
     * Works on any timeframe; auto-updates every tick from the forming bar. */
    autosr: {
      id: 'autosr', name: 'Auto Support Resistance', fullName: 'Auto Support Resistance (structure high/low lines)', cat: 'Overlay', type: 'overlay',
      inputs: [
        { key: 'atrPeriod', label: 'ATR period', def: 14, min: 2, max: 100, step: 1 },
        { key: 'atrMult', label: 'ATR mult', def: 2.0, min: 0.1, max: 10, step: 0.1 },
        { key: 'minPct', label: 'Min move %', def: 0.15, min: 0.01, max: 5, step: 0.05 }
      ],
      style: [
        { key: 'resColor', label: 'Resistance (last high)', def: '#26a69a' },
        { key: 'supColor', label: 'Support (last low)', def: '#ef5350' },
        { key: 'lineWidth', label: 'Line width', def: 1, min: 1, max: 5, step: 1 }
      ],
      compute(c, o) {
        const n = c ? c.length : 0;
        const lw = Math.max(1, Math.round(o.lineWidth) || 1);
        const resColor = o.resColor || '#26a69a';
        const supColor = o.supColor || '#ef5350';
        const atrPer = Math.max(2, Math.round(o.atrPeriod) || 14);
        const atrMult = Number(o.atrMult) > 0 ? Number(o.atrMult) : 2;
        const minPct = Number(o.minPct) >= 0 ? Number(o.minPct) : 0.15;
        const fmt = v => Number(v).toFixed(Number(v) < 100 ? 3 : 2);
        if (!n) return [];
        /* 1) Volatility-scaled reversal threshold via Wilder ATR. */
        const atr = wilderArr(trArr(c), atrPer);
        const th = (i, ref) => {
          const a = atr[i] != null && isFinite(atr[i]) ? atr[i] * atrMult : 0;
          const p = Math.abs(ref) * (minPct / 100);
          return Math.max(a, p);
        };
        /* 2) ZigZag: track the current leg extreme, confirm a pivot only on a
              reversal >= the ATR threshold, and remember the last confirmed
              pivot (the swing that started the current leg). */
        let dir = 1;                 // +1 up-leg, -1 down-leg
        let ext = c[0].high, extIdx = 0;
        let lastPivot = null;        // {type:'high'|'low', price, idx}
        for (let i = 1; i < n; i++) {
          const t = th(i, c[i].close);
          if (dir >= 0) {
            if (c[i].high > ext) { ext = c[i].high; extIdx = i; }
            if (c[i].low <= ext - t) {
              lastPivot = { type: 'high', price: ext, idx: extIdx };
              dir = -1; ext = c[i].low; extIdx = i;
            }
          } else {
            if (c[i].low < ext) { ext = c[i].low; extIdx = i; }
            if (c[i].high >= ext + t) {
              lastPivot = { type: 'low', price: ext, idx: extIdx };
              dir = 1; ext = c[i].high; extIdx = i;
            }
          }
        }
        /* 3) Levels: current leg extreme is the "last high / last low" the user
              sees; the last confirmed pivot is the opposing support/resistance. */
        let res = null, sup = null, trend = 'flat';
        if (dir >= 0) {
          res = ext;
          sup = lastPivot ? lastPivot.price : null;
          trend = 'up';
        } else {
          sup = ext;
          res = lastPivot ? lastPivot.price : null;
          trend = 'down';
        }
        if (sup == null || !isFinite(sup)) { let ml = Infinity; for (let i = 0; i < n; i++) if (c[i].low < ml) ml = c[i].low; sup = ml; }
        if (res == null || !isFinite(res)) { let mh = -Infinity; for (let i = 0; i < n; i++) if (c[i].high > mh) mh = c[i].high; res = mh; }
        const out = [];
        const mkOut = (price, color, active, tag) => ({
          type: 'line', color, lineWidth: active ? lw + 1 : lw,
          data: c.map(x => ({ time: x.time, value: price })),
          priceLine: {
            price, color,
            lineWidth: active ? lw + 1 : lw,
            lineStyle: active ? 0 : 2,
            axisLabelVisible: true,
            title: tag + ' ' + fmt(price)
          }
        });
        out.push(mkOut(res, resColor, trend === 'up', 'RES'));
        out.push(mkOut(sup, supColor, trend === 'down', 'SUP'));
        return out;
      }
    },

    bbw: {
      id: 'bbw', name: 'BBW', fullName: 'Bollinger Band Width', cat: 'Volume', type: 'pane', format: 'decimal',
      inputs: [
        { key: 'length', label: 'Length', def: 20, min: 1, max: 200, step: 1 },
        { key: 'mult', label: 'Mult', def: 2.0, min: 0.1, max: 10, step: 0.1 },
        { key: 'source', label: 'Source', def: 'close', options: [['close', 'Close'], ['open', 'Open'], ['high', 'High'], ['low', 'Low'], ['hl2', 'HL2'], ['hlc3', 'HLC3'], ['hlcc4', 'HLCC4']] }
      ],
      style: [
        { key: 'color', label: 'Line color', def: '#26a69a' },
        { key: 'lineWidth', label: 'Line width', def: 1, min: 1, max: 5, step: 1 }
      ],
      compute(c, o) {
        /* Pure band-EXPANSION width: Upper band minus Lower band
           (= 2 * mult * StdDev of the source). The line only answers "how much are
           the two bands stretched apart right now":
             - bands expanding together  -> width grows  -> line rises,
             - bands contracting         -> width shrinks -> line falls to a low,
               flat (neutral) zone.
           There is deliberately NO division by the middle band and no use of
           candle direction, so a bull or bear trend by itself moves nothing —
           only the expansion amount matters. */
        const cl = srcArr(c, o.source || 'close');
        const sd = stdevArr(cl, o.length || 20);
        const data = [];
        for (let i = (o.length || 20) - 1; i < c.length; i++) {
          const v = 2 * (o.mult || 2) * sd[i];
          if (v == null || !isFinite(v)) continue;
          data.push({ time: c[i].time, value: v });
        }
        return [{
          type: 'line', color: o.color, lineWidth: o.lineWidth, data
        }];
      }
    },

    volosc: {
      id: 'volosc', name: 'Volume Oscillator', fullName: 'Volume Oscillator', cat: 'Volume', type: 'pane', format: 'percent',
      inputs: [
        { key: 'fast', label: 'Fast length', def: 5, min: 1, max: 200, step: 1 },
        { key: 'slow', label: 'Slow length', def: 14, min: 2, max: 500, step: 1 },
        { key: 'center', label: 'Center line', def: 0, min: -100, max: 100, step: 0.1 }
      ],
      style: [
        { key: 'color', label: 'Line color', def: '#26a69a' },
        { key: 'centerColor', label: 'Center line color', def: '#9e9e9e' },
        { key: 'lineWidth', label: 'Line width', def: 1, min: 1, max: 5, step: 1 }
      ],
      compute(c, o) {
        const vol = c.map(x => x.volume);
        const f = smaArr(vol, o.fast), s = smaArr(vol, o.slow);
        const data = [];
        for (let i = 0; i < c.length; i++) {
          if (f[i] == null || s[i] == null || !s[i]) continue;
          data.push({ time: c[i].time, value: (f[i] - s[i]) / s[i] * 100 });
        }
        return [{
          type: 'line', color: o.color, lineWidth: o.lineWidth, data,
          priceLine: {
            price: o.center, color: o.centerColor, lineWidth: 1,
            lineStyle: 2, axisLabelVisible: false, title: 'Center'
          }
        }];
      }
    },

    ad: {
      id: 'ad', name: 'Accumulation/Distribution', fullName: 'Accumulation/Distribution Index', cat: 'Volume', type: 'pane',
      inputs: [],
      style: [
        { key: 'color', label: 'Color', def: '#ff7043' },
        { key: 'lineWidth', label: 'Line width', def: 1, min: 1, max: 5, step: 1 }
      ],
      compute(c, o) {
        const out = new Array(c.length).fill(0);
        for (let i = 0; i < c.length; i++) {
          const hl = c[i].high - c[i].low;
          const mfm = hl ? ((c[i].close - c[i].low) - (c[i].high - c[i].close)) / hl : 0;
          out[i] = (i ? out[i - 1] : 0) + mfm * c[i].volume;
        }
        return [buildSeries(c, out, o.color, 'line', o.lineWidth)];
      }
    },

    mfi: {
      id: 'mfi', name: 'MFI', fullName: 'Money Flow Index', cat: 'Volume', type: 'pane', format: 'percent',
      inputs: [{ key: 'length', label: 'Length', def: 14, min: 1, max: 200, step: 1 }],
      style: [
        { key: 'color', label: 'Color', def: '#ab47bc' },
        { key: 'lineWidth', label: 'Line width', def: 1, min: 1, max: 5, step: 1 }
      ],
      compute(c, o) {
        const tp = c.map(x => (x.high + x.low + x.close) / 3);
        const data = [];
        for (let i = o.length - 1; i < c.length; i++) {
          let pos = 0, neg = 0;
          for (let j = i - o.length + 1; j <= i; j++) {
            const mf = tp[j] * c[j].volume;
            if (tp[j] > tp[j - 1]) pos += mf; else if (tp[j] < tp[j - 1]) neg += mf;
          }
          data.push({ time: c[i].time, value: neg ? 100 - 100 / (1 + pos / neg) : 100 });
        }
        return [{ type: 'line', color: o.color, lineWidth: o.lineWidth, data }];
      }
    },

    smf: {
      id: 'smf', name: 'SMF', fullName: 'Smart Money Flow (volume-pulse accumulation/distribution)', cat: 'Volume', type: 'pane', format: 'percent',
      inputs: [
        { key: 'length', label: 'Lookback length', def: 14, min: 1, max: 200, step: 1 },
        { key: 'signalLen', label: 'Signal length', def: 9, min: 1, max: 100, step: 1 },
        { key: 'volLen', label: 'Volume avg length', def: 20, min: 1, max: 200, step: 1 },
        { key: 'pulseCap', label: 'Volume pulse cap', def: 3, min: 1, max: 10, step: 0.5 }
      ],
      style: [
        { key: 'color', label: 'SMF line', def: '#26c6da' },
        { key: 'signalColor', label: 'Signal line', def: '#ff6d00' },
        { key: 'histUpColor', label: 'Histogram up', def: '#26a69a' },
        { key: 'histDownColor', label: 'Histogram down', def: '#ef5350' },
        { key: 'lineWidth', label: 'Line width', def: 1, min: 1, max: 5, step: 1 }
      ],
      /* Smart-money footprint: a volume-pulse-weighted close-location oscillator.
         Each bar contributes CLV = ((C-L)-(H-C))/(H-L) in [-1,1] weighted by
         volume * min(vol/volAvg, cap) so big-player volume spikes dominate the
         flow. The main line is the rolling weighted CLV over `length` bars
         scaled to [-100,100] (+ = accumulation/buying, - = distribution/selling);
         the signal line is an EMA of it. Single-pass O(n) — comfortably <1 ms on
         a full chart. Bullish when main line > signal line, bearish when below. */
      compute(c, o) {
        const n = c.length;
        const look = Math.max(1, Math.round(o.length) || 14);
        const sig = Math.max(1, Math.round(o.signalLen) || 9);
        const volLen = Math.max(1, Math.round(o.volLen) || 20);
        const cap = Number(o.pulseCap) > 0 ? Number(o.pulseCap) : 3;
        /* Pass 1: rolling volume average + per-bar CLV & volume-pulse weight.
           Zero-copy: volSum is a single sliding total, no SMA array needed. */
        const clv = new Array(n);
        const wgt = new Array(n);
        let volSum = 0;
        for (let i = 0; i < n; i++) {
          const b = c[i];
          const vol = b.volume || 0;
          volSum += vol;
          if (i >= volLen) volSum -= c[i - volLen].volume || 0;
          const range = b.high - b.low;
          const cl = range > 0 ? ((b.close - b.low) - (b.high - b.close)) / range : 0;
          clv[i] = cl;
          const avg = i >= volLen - 1 ? volSum / volLen : volSum / (i + 1);
          const pulse = avg > 0 ? Math.min(vol / avg, cap) : 1;
          wgt[i] = vol * pulse;
        }
        /* Pass 2: rolling weighted CLV (main line) + build signal EMA inline. */
        const smfArr = new Array(n).fill(0);
        let sn = 0, sd = 0;
        for (let i = 0; i < n; i++) {
          sn += clv[i] * wgt[i];
          sd += wgt[i];
          if (i >= look) { sn -= clv[i - look] * wgt[i - look]; sd -= wgt[i - look]; }
          if (i >= look - 1) smfArr[i] = sd > 0 ? 100 * sn / sd : 0;
        }
        const signal = emaArr(smfArr, sig);
        const mainData = [], sigData = [], histData = [];
        let prevH = null;
        for (let i = look - 1; i < n; i++) {
          const t = c[i].time;
          const v = smfArr[i];
          if (v == null || isNaN(v)) continue;
          mainData.push({ time: t, value: v });
          if (signal[i] == null || isNaN(signal[i])) continue;
          sigData.push({ time: t, value: signal[i] });
          const h = v - signal[i];
          const up = prevH == null ? h >= 0 : h >= prevH;
          histData.push({ time: t, value: h, color: up ? o.histUpColor : o.histDownColor });
          prevH = h;
        }
        return [
          { type: 'line', color: o.color, lineWidth: o.lineWidth, data: mainData },
          { type: 'line', color: o.signalColor, lineWidth: o.lineWidth, data: sigData },
          { type: 'histogram', color: o.histUpColor, data: histData }
        ];
      }
    },

    vl: {
      id: 'vl', name: 'VL', fullName: 'Volume Line (volume-weighted trend, battery fade)', cat: 'Volume', type: 'overlay',
      inputs: [
        { key: 'length', label: 'VWMA length', def: 14, min: 1, max: 200, step: 1 },
        { key: 'signalLen', label: 'Signal length', def: 9, min: 1, max: 100, step: 1 },
        { key: 'volLen', label: 'Volume avg length', def: 20, min: 1, max: 200, step: 1 }
      ],
      style: [
        { key: 'color', label: 'Volume line', def: '#26c6da' },
        { key: 'signalColor', label: 'Signal line', def: '#ff6d00' },
        { key: 'lineWidth', label: 'Line width', def: 1, min: 1, max: 5, step: 1 }
      ],
      /* Volume Line: a volume-weighted moving average of close (trend-following,
         like an EMA) whose per-point opacity mirrors volume strength — the line
         fades when volume is low and darkens when volume is high (battery-style
         pipe). Two rolling passes, O(n) total — ~0.6 ms on a full chart.
         Bullish filter: VL trending up + volume increasing. Bearish filter: VL
         trending down + volume increasing. */
      compute(c, o) {
        const n = c.length;
        const L = Math.max(1, Math.round(o.length) || 14);
        const sig = Math.max(1, Math.round(o.signalLen) || 9);
        const volLen = Math.max(1, Math.round(o.volLen) || 20);
        /* Pass 1: rolling volume average (for the opacity mapping). */
        const volAvg = new Array(n).fill(0);
        let vSum = 0;
        for (let i = 0; i < n; i++) {
          const vol = c[i].volume || 0;
          vSum += vol;
          if (i >= volLen) vSum -= c[i - volLen].volume || 0;
          if (i >= volLen - 1) volAvg[i] = vSum / volLen;
        }
        /* Pass 2: rolling VWMA of close (main volume line). */
        const vw = new Array(n).fill(0);
        let pv = 0, vsum = 0;
        for (let i = 0; i < n; i++) {
          const vol = c[i].volume || 0;
          pv += c[i].close * vol;
          vsum += vol;
          if (i >= L) { const oo = c[i - L]; const ov = oo.volume || 0; pv -= oo.close * ov; vsum -= ov; }
          if (i >= L - 1 && vsum > 0) vw[i] = pv / vsum;
        }
        /* Signal EMA + data arrays. Precompute the rgba() prefix once so the
           per-point battery fade is just a cheap string concat, not a regex. */
        const signal = emaArr(vw, sig);
        let hx = String(o.color || '#26c6da').replace('#', '');
        if (hx.length === 3) hx = hx.split('').map(x => x + x).join('');
        const cn = parseInt(hx, 16);
        const rgb = ((cn >> 16) & 255) + ',' + ((cn >> 8) & 255) + ',' + (cn & 255);
        const mainData = [], sigData = [];
        for (let i = L - 1; i < n; i++) {
          const v = vw[i];
          if (v == null || isNaN(v)) continue;
          const t = c[i].time;
          const vol = c[i].volume || 0;
          const avg = volAvg[i] > 0 ? volAvg[i] : vol;
          const ratio = avg > 0 ? vol / avg : 1;
          let alpha = 0.18 + ratio * 0.82;
          if (alpha < 0.15) alpha = 0.15; else if (alpha > 1) alpha = 1;
          mainData.push({ time: t, value: v, color: 'rgba(' + rgb + ',' + alpha + ')' });
          const sv = signal[i];
          if (sv != null && !isNaN(sv)) sigData.push({ time: t, value: sv });
        }
        return [
          { type: 'line', color: o.color, lineWidth: o.lineWidth, data: mainData },
          { type: 'line', color: o.signalColor, lineWidth: o.lineWidth, data: sigData }
        ];
      }
    },

    pvt: {
      id: 'pvt', name: 'PVT', fullName: 'Price Volume Trend', cat: 'Volume', type: 'pane',
      inputs: [],
      style: [
        { key: 'color', label: 'Color', def: '#ec407a' },
        { key: 'lineWidth', label: 'Line width', def: 1, min: 1, max: 5, step: 1 }
      ],
      compute(c, o) {
        const out = new Array(c.length).fill(0);
        for (let i = 1; i < c.length; i++) {
          if (c[i - 1].close) out[i] = out[i - 1] + c[i].volume * (c[i].close - c[i - 1].close) / c[i - 1].close;
          else out[i] = out[i - 1];
        }
        return [buildSeries(c, out, o.color, 'line', o.lineWidth)];
      }
    },

    dpo: {
      id: 'dpo', name: 'DPO', fullName: 'Detrended Price Oscillator', cat: 'Momentum', type: 'pane',
      inputs: [{ key: 'length', label: 'Length', def: 20, min: 2, max: 200, step: 1 }],
      style: [
        { key: 'color', label: 'Color', def: '#5c6bc0' },
        { key: 'lineWidth', label: 'Line width', def: 1, min: 1, max: 5, step: 1 }
      ],
      compute(c, o) {
        const cl = srcArr(c, 'close');
        const sma = smaArr(cl, o.length);
        const shift = Math.floor(o.length / 2) + 1;
        const data = [];
        for (let i = o.length - 1; i < c.length; i++) {
          const j = i - shift;
          if (j >= 0 && sma[j] != null) data.push({ time: c[i].time, value: cl[i] - sma[j] });
        }
        return [{ type: 'line', color: o.color, lineWidth: o.lineWidth, data }];
      }
    },

    ppo: {
      id: 'ppo', name: 'PPO', fullName: 'Percentage Price Oscillator', cat: 'Momentum', type: 'pane', format: 'percent',
      inputs: [
        { key: 'fast', label: 'Fast length', def: 12, min: 1, max: 200, step: 1 },
        { key: 'slow', label: 'Slow length', def: 26, min: 2, max: 500, step: 1 },
        { key: 'signal', label: 'Signal length', def: 9, min: 1, max: 200, step: 1 }
      ],
      style: [
        { key: 'ppoColor', label: 'PPO line', def: '#2962ff' },
        { key: 'signalColor', label: 'Signal line', def: '#ff6d00' },
        { key: 'histUpColor', label: 'Histogram up', def: '#26a69a' },
        { key: 'histDownColor', label: 'Histogram down', def: '#ef5350' }
      ],
      compute(c, o) {
        const cl = srcArr(c, 'close');
        const f = emaArr(cl, o.fast), s = emaArr(cl, o.slow);
        const ppo = new Array(c.length).fill(null);
        for (let i = 0; i < c.length; i++) if (f[i] != null && s[i] != null) ppo[i] = s[i] ? (f[i] - s[i]) / s[i] * 100 : 0;
        const signal = emaArr(ppo.map((v, i) => v != null ? v : 0), o.signal);
        const hist = [];
        let prevH = null;
        for (let i = 0; i < c.length; i++) {
          if (ppo[i] == null || signal[i] == null) continue;
          const h = ppo[i] - signal[i];
          const up = prevH == null ? true : h >= prevH;
          hist.push({ time: c[i].time, value: h, color: up ? o.histUpColor : o.histDownColor });
          prevH = h;
        }
        return [
          buildSeries(c, ppo, o.ppoColor, 'line'),
          buildSeries(c, signal, o.signalColor, 'line'),
          { type: 'histogram', color: o.histUpColor, data: hist }
        ];
      }
    },

    williamsR: {
      id: 'williamsR', name: 'Williams %R', fullName: 'Williams Percent Range', cat: 'Momentum', type: 'pane', format: 'percent',
      inputs: [{ key: 'length', label: 'Length', def: 14, min: 1, max: 200, step: 1 }],
      style: [
        { key: 'color', label: 'Color', def: '#ef5350' },
        { key: 'lineWidth', label: 'Line width', def: 1, min: 1, max: 5, step: 1 }
      ],
      compute(c, o) {
        const hh = highestArr(srcArr(c, 'high'), o.length);
        const ll = lowestArr(srcArr(c, 'low'), o.length);
        const cl = srcArr(c, 'close');
        const data = [];
        for (let i = o.length - 1; i < c.length; i++) {
          const r = hh[i] - ll[i];
          data.push({ time: c[i].time, value: r ? (hh[i] - cl[i]) / r * -100 : 0 });
        }
        return [{ type: 'line', color: o.color, lineWidth: o.lineWidth, data }];
      }
    },

    rsi: {
      id: 'rsi', name: 'RSI', fullName: 'Relative Strength Index', cat: 'Momentum', type: 'pane', format: 'percent',
      inputs: [
        { key: 'length', label: 'Length', def: 14, min: 1, max: 200, step: 1 },
        { key: 'smoothLength', label: 'Smoothed MA length', def: 0, min: 0, max: 200, step: 1 }
      ],
      style: [
        { key: 'color', label: 'Color', def: '#e040fb' },
        { key: 'smoothColor', label: 'Smoothed MA color', def: '#ffca28' },
        { key: 'lineWidth', label: 'Line width', def: 1, min: 1, max: 5, step: 1 }
      ],
      compute(c, o) {
        const n = o.length;
        const gains = new Array(c.length).fill(0), losses = new Array(c.length).fill(0);
        for (let i = 1; i < c.length; i++) {
          const diff = c[i].close - c[i - 1].close;
          if (diff >= 0) gains[i] = diff; else losses[i] = -diff;
        }
        const avgG = wilderArr(gains, n), avgL = wilderArr(losses, n);
        const rsiData = [], vals = [], times = [];
        for (let i = n - 1; i < c.length; i++) {
          let v;
          if (avgL[i] === 0) v = avgG[i] === 0 ? 50 : 100;
          else v = 100 - 100 / (1 + avgG[i] / avgL[i]);
          vals.push(v);
          times.push(c[i].time);
          rsiData.push({ time: c[i].time, value: v });
        }
        const out = [{ type: 'line', color: o.color, lineWidth: o.lineWidth, data: rsiData }];
        if (o.smoothLength > 0) {
          const sm = wilderArr(vals, o.smoothLength);
          const sData = [];
          for (let i = 0; i < sm.length; i++) {
            if (sm[i] == null || isNaN(sm[i])) continue;
            sData.push({ time: times[i], value: sm[i] });
          }
          out.push({ type: 'line', color: o.smoothColor, lineWidth: o.lineWidth, data: sData });
        }
        return out;
      }
    },

    uo: {
      id: 'uo', name: 'UO', fullName: 'Ultimate Oscillator', cat: 'Momentum', type: 'pane', format: 'percent',
      inputs: [
        { key: 'fast', label: 'Fast length', def: 7, min: 1, max: 50, step: 1 },
        { key: 'medium', label: 'Medium length', def: 14, min: 2, max: 100, step: 1 },
        { key: 'slow', label: 'Slow length', def: 28, min: 3, max: 200, step: 1 }
      ],
      style: [
        { key: 'color', label: 'Color', def: '#26c6da' },
        { key: 'lineWidth', label: 'Line width', def: 1, min: 1, max: 5, step: 1 }
      ],
      compute(c, o) {
        const bp = new Array(c.length).fill(0), tr = new Array(c.length).fill(0);
        for (let i = 1; i < c.length; i++) {
          const pc = c[i - 1].close;
          bp[i] = c[i].close - Math.min(c[i].low, pc);
          tr[i] = Math.max(c[i].high, pc) - Math.min(c[i].low, pc);
        }
        const data = [];
        for (let i = o.slow - 1; i < c.length; i++) {
          const sum = (a, n) => { let s = 0; for (let j = i - n + 1; j <= i; j++) s += a[j]; return s; };
          const av = (a, n) => sum(a, n) / n;
          const num = 4 * av(bp, o.fast) + 2 * av(bp, o.medium) + av(bp, o.slow);
          const den = 4 * av(tr, o.fast) + 2 * av(tr, o.medium) + av(tr, o.slow);
          data.push({ time: c[i].time, value: den ? 100 * num / den : 0 });
        }
        return [{ type: 'line', color: o.color, lineWidth: o.lineWidth, data }];
      }
    },

    vwap: {
      id: 'vwap', name: 'VWAP', fullName: 'Volume Weighted Average Price', cat: 'Overlay', type: 'overlay',
      inputs: [
        { key: 'anchor', label: 'Anchor', def: 'trend', options: [['trend', 'Trend leg'], ['session', 'Session'], ['all', 'All data']] },
        { key: 'pivotLen', label: 'Pivot bars', def: 5, min: 1, max: 200, step: 1 }
      ],
      style: [
        { key: 'color', label: 'Color', def: '#ff9800' },
        { key: 'lineWidth', label: 'Line width', def: 2, min: 1, max: 5, step: 1 }
      ],
      compute(c, o) {
        const mode = o.anchor || 'trend';
        /* Feed one bar into a running cumulative accumulator: volume-weighted
           typical price when volume exists, plain typical-price average as a
           fallback so the line still tracks price on volume-less feeds. */
        const feed = (i, st) => {
          const tp = (c[i].high + c[i].low + c[i].close) / 3;
          const v = c[i].volume || 0;
          if (v > 0) { st.cumPV += tp * v; st.cumV += v; }
          st.sumTP += tp; st.nTP++;
          return st.cumV > 0 ? st.cumPV / st.cumV : st.sumTP / st.nTP;
        };
        if (mode !== 'trend') {
          const sessionMode = mode === 'session';
          const groups = [];
          let cur = null;
          for (let i = 0; i < c.length; i++) {
            const key = sessionMode
              ? new Date(c[i].time * 1000 + 5.5 * 3600 * 1000).toISOString().slice(0, 10)
              : 'all';
            if (!cur || cur.key !== key) {
              cur = { key, rows: [], cumPV: 0, cumV: 0, sumTP: 0, nTP: 0 };
              groups.push(cur);
            }
            cur.rows.push(i);
          }
          const out = [];
          groups.forEach((sess, si) => {
            const isCurrent = si === groups.length - 1;
            const col = isCurrent ? o.color : fadeColor(o.color, 0.35);
            const data = [];
            sess.rows.forEach(i => data.push({ time: c[i].time, value: feed(i, sess) }));
            const series = { type: 'line', color: col, lineWidth: o.lineWidth, data };
            if (!isCurrent) series.noRead = true;
            out.push(series);
          });
          /* Project the current session's VWAP forward to the present time, like TradingView */
          const lastSeries = out[out.length - 1];
          if (lastSeries && lastSeries.data.length) {
            const lastPt = lastSeries.data[lastSeries.data.length - 1];
            const now = Math.floor(Date.now() / 1000);
            const nowIst = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
            const lastIst = new Date(lastPt.time * 1000 + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
            if (now > lastPt.time && nowIst === lastIst) {
              lastSeries.data.push({ time: now, value: lastPt.value });
            }
          }
          return out;
        }
        /* Trend-leg anchor: ONE continuous VWAP line (never faded, never split
           per session) that re-anchors every time a new swing leg confirms. A
           bar is a pivot when it is a strict fractal high/low over pivotLen bars
           on EACH side. Confirmation needs the pivotLen bars AFTER the bar, so
           bar i only adopts pivots with j + pivotLen <= i: the series is causal,
           does not repaint, and never anchors on a leg that has not actually
           turned yet. Each confirmed pivot starts a fresh cumulative VWAP, which
           makes the line hug the current move - a close cross above/below it
           happens near the START of the new leg instead of half-way through. */
        const n = c.length;
        const W = Math.max(1, Math.min(200, Math.round(o.pivotLen || 5)));
        const pivotAt = new Array(n).fill(0);
        if (n >= 2 * W + 1) {
          for (let j = 0; j < n; j++) {
            const a = Math.max(0, j - W), b = Math.min(n - 1, j + W);
            let hi = true, lo = true;
            const hv = c[j].high, lv = c[j].low;
            for (let k = a; k <= b && (hi || lo); k++) {
              if (k === j) continue;
              if (c[k].high >= hv) hi = false;
              if (c[k].low <= lv) lo = false;
            }
            if (hi !== lo) pivotAt[j] = hi ? 1 : -1;
          }
        }
        /* Zig-zag the raw fractals into an alternating high/low pivot chain:
           a later pivot of the same type replaces the earlier one only when it
           is more extreme, and an opposite pivot only counts once price actually
           broke the previous extreme (so minor wiggles never restart the line). */
        const piv = [];
        for (let j = 0; j < n; j++) {
          const t = pivotAt[j];
          if (!t) continue;
          const last = piv[piv.length - 1];
          if (!last) { piv.push({ i: j, t }); continue; }
          if (t === last.t) {
            const better = t === 1 ? c[j].high >= c[last.i].high : c[j].low <= c[last.i].low;
            if (better) last.i = j;
            continue;
          }
          const broke = t === 1 ? c[j].high > c[last.i].high : c[j].low < c[last.i].low;
          if (broke) piv.push({ i: j, t });
        }
        const data = [];
        if (n) {
          const st = { cumPV: 0, cumV: 0, sumTP: 0, nTP: 0 };
          let pi = -1;
          for (let i = 0; i < n; i++) {
            while (pi + 1 < piv.length && piv[pi + 1].i + W <= i) {
              pi++;
              st.cumPV = 0; st.cumV = 0; st.sumTP = 0; st.nTP = 0;
              for (let k = piv[pi].i; k < i; k++) feed(k, st);
            }
            data.push({ time: c[i].time, value: feed(i, st) });
          }
        }
        return [{ type: 'line', color: o.color, lineWidth: o.lineWidth, data }];
      }
    },

    pc: {
      id: 'pc', name: 'Price Channel', fullName: 'Price Channel', cat: 'Overlay', type: 'overlay',
      inputs: [
        { key: 'length', label: 'Length', def: 20, min: 1, max: 200, step: 1 },
        { key: 'midType', label: 'Middle Band', def: 'midpoint', options: [['midpoint', 'Midpoint (H+L)/2'], ['sma', 'SMA'], ['ema', 'EMA']] },
        { key: 'midLength', label: 'Mid Band Period', def: 20, min: 1, max: 500, step: 1 }
      ],
      style: [
        { key: 'upperColor', label: 'Upper color', def: '#26a69a' },
        { key: 'midColor', label: 'Middle color', def: '#ffa726' },
        { key: 'lowerColor', label: 'Lower color', def: '#ef5350' },
        { key: 'lineWidth', label: 'Line width', def: 1, min: 1, max: 5, step: 1 }
      ],
      compute(c, o) {
        const hh = highestArr(srcArr(c, 'high'), o.length);
        const ll = lowestArr(srcArr(c, 'low'), o.length);
        const midLen = o.midLength || o.length || 20;
        let midSrc = null;
        /* Midpoint middle: the rolling midpoint of the high/low extremes over
           the Mid Band Period (midLength) window - NOT the outer length window -
           so the Mid Band Period setting actually moves the middle line. When
           midLength equals length this reduces to the classic (upper+lower)/2
           channel centre. */
        let midExt = null;
        if (o.midType === 'sma') midSrc = smaArr(srcArr(c, 'close'), midLen);
        else if (o.midType === 'ema') midSrc = emaArr(srcArr(c, 'close'), midLen);
        else {
          const mh = highestArr(srcArr(c, 'high'), midLen);
          const ml = lowestArr(srcArr(c, 'low'), midLen);
          midExt = new Array(c.length).fill(null);
          for (let i = midLen - 1; i < c.length; i++) midExt[i] = (mh[i] + ml[i]) / 2;
        }
        const up = [], mid = [], dn = [];
        for (let i = o.length - 1; i < c.length; i++) {
          up.push({ time: c[i].time, value: hh[i] });
          dn.push({ time: c[i].time, value: ll[i] });
          mid.push({ time: c[i].time, value: (midSrc && midSrc[i] != null) ? midSrc[i] : ((midExt && midExt[i] != null) ? midExt[i] : (hh[i] + ll[i]) / 2) });
        }
        return [
          { type: 'line', color: o.upperColor, lineWidth: o.lineWidth, data: up },
          { type: 'line', color: o.midColor, lineWidth: o.lineWidth, data: mid },
          { type: 'line', color: o.lowerColor, lineWidth: o.lineWidth, data: dn }
        ];
      }
    },

    vlcore: {
      id: 'vlcore', name: 'Trend Core', fullName: 'Trend Core (liquidity-grab / fake-breakout filtered, non-lagging)', cat: 'Overlay', type: 'overlay',
      inputs: [
        { key: 'length', label: 'Trend length', def: 21, min: 5, max: 200, step: 1 },
        { key: 'atrLength', label: 'ATR length', def: 14, min: 2, max: 100, step: 1 },
        { key: 'gap', label: 'Line gap (x ATR)', def: 1.0, min: 0, max: 5, step: 0.05 },
        { key: 'confirm', label: 'Confirmation bars', def: 2, min: 1, max: 6, step: 1 },
        { key: 'wickLen', label: 'Pivot window', def: 3, min: 1, max: 6, step: 1 },
        { key: 'straightLine', label: 'Straight line (angled segments)', type: 'checkbox', def: true },
        { key: 'useVolume', label: 'Volume confirmation', type: 'checkbox', def: true }
      ],
      style: [
        { key: 'upColor', label: 'Up color', def: '#00e676' },
        { key: 'downColor', label: 'Down color', def: '#ff5252' },
        { key: 'flatColor', label: 'Flat color', def: '#6b6b88' },
        { key: 'lineWidth', label: 'Line width', def: 2, min: 1, max: 5, step: 1 }
      ],
      compute(c, o) {
        if (!window.VLCore || !window.VLCore.series) return [];
        try { return window.VLCore.series(c, o).out; }
        catch (e) { return []; }
      }
    },

    hma: {
      id: 'hma', name: 'HMA', fullName: 'Hull Moving Average', cat: 'Overlay', type: 'overlay',
      inputs: [
        { key: 'length', label: 'Length', def: 9, min: 1, max: 200, step: 1 },
        { key: 'source', label: 'Source', def: 'close', options: [['close', 'Close'], ['high', 'High'], ['low', 'Low'], ['hl2', 'HL2'], ['hlc3', 'HLC3'], ['hlcc4', 'HLCC4']] }
      ],
      style: [
        { key: 'color', label: 'Color', def: '#29b6f6' },
        { key: 'lineWidth', label: 'Line width', def: 2, min: 1, max: 5, step: 1 }
      ],
      compute(c, o) {
        const src = srcArr(c, o.source);
        const n = Math.max(2, Math.round(o.length));
        const half = Math.max(1, Math.floor(n / 2));
        const sq = Math.max(1, Math.round(Math.sqrt(n)));
        const wma = (a, p) => {
          const out = new Array(a.length).fill(null);
          if (a.length < p) return out;
          const den = p * (p + 1) / 2;
          for (let i = p - 1; i < a.length; i++) {
            let w = 0;
            for (let j = 0; j < p; j++) w += (j + 1) * a[i - p + 1 + j];
            out[i] = w / den;
          }
          return out;
        };
        const w1 = wma(src, half);
        const w2 = wma(src, n);
        const s0 = Math.max(half - 1, n - 1);
        const out = new Array(c.length).fill(null);
        if (s0 < c.length && c.length - s0 >= sq) {
          const df = new Array(c.length - s0);
          for (let i = s0; i < c.length; i++) df[i - s0] = 2 * w1[i] - w2[i];
          const hh = wma(df, sq);
          for (let i = 0; i < hh.length; i++) if (hh[i] != null) out[s0 + i] = hh[i];
        }
        return [buildSeries(c, out, o.color, 'line', o.lineWidth)];
      }
    },

    ichimoku: {
      id: 'ichimoku', name: 'Ichimoku', fullName: 'Ichimoku Cloud', cat: 'Trend', type: 'overlay',
      inputs: [
        { key: 'tenkan', label: 'Tenkan (conversion)', def: 9, min: 1, max: 120, step: 1 },
        { key: 'kijun', label: 'Kijun (base)', def: 26, min: 1, max: 200, step: 1 },
        { key: 'senkou', label: 'Senkou (span B)', def: 52, min: 1, max: 300, step: 1 }
      ],
      style: [
        { key: 'tenkanColor', label: 'Tenkan color', def: '#26a69a' },
        { key: 'kijunColor', label: 'Kijun color', def: '#ef5350' },
        { key: 'cloudUpColor', label: 'Senkou A color', def: '#4fc3f7' },
        { key: 'cloudDownColor', label: 'Senkou B color', def: '#ffca28' },
        { key: 'lineWidth', label: 'Line width', def: 1, min: 1, max: 5, step: 1 }
      ],
      compute(c, o) {
        const hi = srcArr(c, 'high'), lo = srcArr(c, 'low');
        const T = Math.max(1, Math.round(o.tenkan)), K = Math.max(1, Math.round(o.kijun)), S = Math.max(1, Math.round(o.senkou));
        const hT = highestArr(hi, T), lT = lowestArr(lo, T);
        const hK = highestArr(hi, K), lK = lowestArr(lo, K);
        const hS = highestArr(hi, S), lS = lowestArr(lo, S);
        const tenkan = new Array(c.length).fill(null), kijun = new Array(c.length).fill(null);
        const sA = new Array(c.length).fill(null), sB = new Array(c.length).fill(null);
        for (let i = 0; i < c.length; i++) {
          if (hT[i] != null && lT[i] != null) tenkan[i] = (hT[i] + lT[i]) / 2;
          if (hK[i] != null && lK[i] != null) kijun[i] = (hK[i] + lK[i]) / 2;
          if (tenkan[i] != null && kijun[i] != null) sA[i] = (tenkan[i] + kijun[i]) / 2;
          if (hS[i] != null && lS[i] != null) sB[i] = (hS[i] + lS[i]) / 2;
        }
        const lw = o.lineWidth || 1;
        return [
          buildSeries(c, tenkan, o.tenkanColor, 'line', lw),
          buildSeries(c, kijun, o.kijunColor, 'line', lw),
          buildSeries(c, sA, o.cloudUpColor, 'line', lw),
          buildSeries(c, sB, o.cloudDownColor, 'line', lw)
        ];
      }
    },

    cmf: {
      id: 'cmf', name: 'CMF', fullName: 'Chaikin Money Flow', cat: 'Volume', type: 'pane',
      inputs: [{ key: 'length', label: 'Length', def: 20, min: 1, max: 200, step: 1 }],
      style: [
        { key: 'color', label: 'Color', def: '#00bcd4' },
        { key: 'lineWidth', label: 'Line width', def: 1, min: 1, max: 5, step: 1 }
      ],
      compute(c, o) {
        const n = c.length, L = Math.max(1, Math.round(o.length));
        const pm = new Array(n + 1).fill(0), pv = new Array(n + 1).fill(0);
        for (let i = 0; i < n; i++) {
          const bar = c[i], vol = Number(bar.volume) || 0;
          const hl = bar.high - bar.low;
          const mf = hl > 0 ? ((bar.close - bar.low) - (bar.high - bar.close)) / hl * vol : 0;
          pm[i + 1] = pm[i] + mf;
          pv[i + 1] = pv[i] + vol;
        }
        const out = new Array(n).fill(null);
        for (let i = L - 1; i < n; i++) {
          const dv = pv[i + 1] - pv[i + 1 - L];
          out[i] = dv ? (pm[i + 1] - pm[i + 1 - L]) / dv : 0;
        }
        return [buildSeries(c, out, o.color, 'line', o.lineWidth)];
      }
    },

    sqzmom: {
      id: 'sqzmom', name: 'Squeeze Momentum', fullName: 'TTM Squeeze Momentum', cat: 'Volatility', type: 'pane',
      inputs: [
        { key: 'bbLen', label: 'Bollinger length', def: 20, min: 2, max: 200, step: 1 },
        { key: 'bbMult', label: 'Bollinger mult', def: 2, min: 0.1, max: 10, step: 0.1 },
        { key: 'kcLen', label: 'Keltner length', def: 20, min: 2, max: 200, step: 1 },
        { key: 'kcMult', label: 'Keltner mult', def: 1.5, min: 0.1, max: 10, step: 0.1 }
      ],
      style: [
        { key: 'upColor', label: 'Up color', def: '#26a69a' },
        { key: 'downColor', label: 'Down color', def: '#ef5350' }
      ],
      compute(c, o) {
        const close = srcArr(c, 'close');
        const bl = Math.max(2, Math.round(o.bbLen)), kl = Math.max(2, Math.round(o.kcLen));
        const bm = Number(o.bbMult) > 0 ? Number(o.bbMult) : 2, km = Number(o.kcMult) > 0 ? Number(o.kcMult) : 1.5;
        const basis = smaArr(close, bl), sd = stdevArr(close, bl);
        const ma = smaArr(close, kl), atr = wilderArr(trArr(c), kl);
        const start = Math.max(bl - 1, kl - 1);
        const rocStart = 2 * bl - 1;
        const data = [];
        for (let i = start; i < c.length; i++) {
          if (basis[i] == null || sd[i] == null || ma[i] == null || atr[i] == null) continue;
          const bbTop = basis[i] + bm * sd[i], bbBot = basis[i] - bm * sd[i];
          const kcTop = ma[i] + km * atr[i], kcBot = ma[i] - km * atr[i];
          const squeeze = bbBot > kcBot && bbTop < kcTop;
          let val = 0;
          if (!squeeze && i >= rocStart && basis[i - bl] != null) val = basis[i] - basis[i - bl];
          data.push({ time: c[i].time, value: val, color: val >= 0 ? o.upColor : o.downColor });
        }
        return [{ type: 'histogram', color: o.upColor, data }];
      }
    },

    fisher: {
      id: 'fisher', name: 'Fisher Transform', fullName: 'Fisher Transform (MESA)', cat: 'Momentum', type: 'pane',
      inputs: [{ key: 'length', label: 'Length', def: 9, min: 1, max: 100, step: 1 }],
      style: [
        { key: 'fisherColor', label: 'Fisher color', def: '#ab47bc' },
        { key: 'signalColor', label: 'Signal color', def: '#26a69a' },
        { key: 'lineWidth', label: 'Line width', def: 1, min: 1, max: 5, step: 1 }
      ],
      compute(c, o) {
        const n = Math.max(1, Math.round(o.length));
        const src = srcArr(c, 'hl2');
        const hi = highestArr(src, n), lo = lowestArr(src, n);
        const fish = new Array(c.length).fill(null);
        let pv = 0, pf = 0;
        for (let i = n - 1; i < c.length; i++) {
          const rng = hi[i] - lo[i];
          if (!(rng > 0)) { fish[i] = pf; continue; }
          let v = 0.33 * 2 * ((src[i] - lo[i]) / rng - 0.5) + 0.67 * pv;
          v = Math.max(-0.999, Math.min(0.999, v));
          pv = v;
          pf = 0.5 * Math.log((1 + v) / (1 - v)) + 0.5 * pf;
          fish[i] = pf;
        }
        const sig = emaSkip(fish, 3);
        return [
          buildSeries(c, fish, o.fisherColor, 'line', o.lineWidth),
          buildSeries(c, sig, o.signalColor, 'line', o.lineWidth)
        ];
      }
    },

    keltner: {
      id: 'keltner', name: 'Keltner Channels', fullName: 'Keltner Channels (EMA + ATR)', cat: 'Volatility', type: 'overlay',
      inputs: [
        { key: 'length', label: 'Length', def: 20, min: 1, max: 200, step: 1 },
        { key: 'mult', label: 'Mult', def: 2.0, min: 0.1, max: 10, step: 0.1 }
      ],
      style: [
        { key: 'upperColor', label: 'Upper color', def: '#ffa726' },
        { key: 'midColor', label: 'Middle color', def: '#b0bec5' },
        { key: 'lowerColor', label: 'Lower color', def: '#ffa726' },
        { key: 'lineWidth', label: 'Line width', def: 1, min: 1, max: 5, step: 1 }
      ],
      compute(c, o) {
        const n = Math.max(1, Math.round(o.length));
        const mult = Number(o.mult) > 0 ? Number(o.mult) : 2;
        const tp = c.map(x => (x.high + x.low + x.close) / 3);
        const mid = emaArr(tp, n), atr = wilderArr(trArr(c), n);
        const up = new Array(c.length).fill(null), dn = new Array(c.length).fill(null);
        const lw = o.lineWidth || 1;
        for (let i = n - 1; i < c.length; i++) {
          if (mid[i] == null || atr[i] == null) continue;
          up[i] = mid[i] + mult * atr[i];
          dn[i] = mid[i] - mult * atr[i];
        }
        return [
          buildSeries(c, up, o.upperColor, 'line', lw),
          buildSeries(c, mid, o.midColor, 'line', lw),
          buildSeries(c, dn, o.lowerColor, 'line', lw)
        ];
      }
    },

    cci: {
      id: 'cci', name: 'CCI', fullName: 'Commodity Channel Index', cat: 'Momentum', type: 'pane',
      inputs: [{ key: 'length', label: 'Length', def: 20, min: 2, max: 200, step: 1 }],
      style: [
        { key: 'color', label: 'Color', def: '#ffd740' },
        { key: 'lineWidth', label: 'Line width', def: 1, min: 1, max: 5, step: 1 }
      ],
      compute(c, o) {
        const n = Math.max(2, Math.round(o.length));
        const tp = c.map(x => (x.high + x.low + x.close) / 3);
        const sma = smaArr(tp, n);
        const out = new Array(c.length).fill(null);
        for (let i = n - 1; i < c.length; i++) {
          let md = 0;
          for (let j = i - n + 1; j <= i; j++) md += Math.abs(tp[j] - sma[i]);
          md /= n;
          out[i] = md > 0 ? (tp[i] - sma[i]) / (0.015 * md) : 0;
        }
        return [buildSeries(c, out, o.color, 'line', o.lineWidth)];
      }
    },

    chandelier: {
      id: 'chandelier', name: 'Chandelier Exit', fullName: 'Chandelier Exit (ATR trailing)', cat: 'Volatility', type: 'overlay',
      inputs: [
        { key: 'length', label: 'Length', def: 22, min: 1, max: 200, step: 1 },
        { key: 'mult', label: 'Mult', def: 3.0, min: 0.1, max: 10, step: 0.1 }
      ],
      style: [
        { key: 'longColor', label: 'Long exit color', def: '#26a69a' },
        { key: 'shortColor', label: 'Short exit color', def: '#ef5350' },
        { key: 'lineWidth', label: 'Line width', def: 1, min: 1, max: 5, step: 1 }
      ],
      compute(c, o) {
        const n = Math.max(1, Math.round(o.length));
        const mult = Number(o.mult) > 0 ? Number(o.mult) : 3;
        const hi = srcArr(c, 'high'), lo = srcArr(c, 'low');
        const hh = highestArr(hi, n), ll = lowestArr(lo, n);
        const atr = wilderArr(trArr(c), n);
        const lg = new Array(c.length).fill(null), sh = new Array(c.length).fill(null);
        const lw = o.lineWidth || 1;
        for (let i = n - 1; i < c.length; i++) {
          if (hh[i] == null || ll[i] == null || atr[i] == null) continue;
          lg[i] = hh[i] - mult * atr[i];
          sh[i] = ll[i] + mult * atr[i];
        }
        return [
          buildSeries(c, lg, o.longColor, 'line', lw),
          buildSeries(c, sh, o.shortColor, 'line', lw)
        ];
      }
    },

    aroon: {
      id: 'aroon', name: 'Aroon', fullName: 'Aroon Up/Down', cat: 'Trend', type: 'pane', format: 'percent',
      inputs: [{ key: 'length', label: 'Length', def: 25, min: 1, max: 200, step: 1 }],
      style: [
        { key: 'upColor', label: 'Aroon Up color', def: '#26a69a' },
        { key: 'downColor', label: 'Aroon Down color', def: '#ef5350' },
        { key: 'lineWidth', label: 'Line width', def: 1, min: 1, max: 5, step: 1 }
      ],
      compute(c, o) {
        const n = Math.max(1, Math.round(o.length));
        const hi = srcArr(c, 'high'), lo = srcArr(c, 'low');
        const up = new Array(c.length).fill(null), dn = new Array(c.length).fill(null);
        for (let i = n - 1; i < c.length; i++) {
          let ih = i, il = i;
          for (let j = i - n + 1; j <= i; j++) {
            if (hi[j] > hi[ih]) ih = j;
            if (lo[j] < lo[il]) il = j;
          }
          up[i] = 100 * (n - (i - ih)) / n;
          dn[i] = 100 * (n - (i - il)) / n;
        }
        const lw = o.lineWidth || 1;
        return [
          buildSeries(c, up, o.upColor, 'line', lw),
          buildSeries(c, dn, o.downColor, 'line', lw)
        ];
      }
    },

    vortex: {
      id: 'vortex', name: 'Vortex', fullName: 'Vortex Indicator (VI+ / VI-)', cat: 'Trend', type: 'pane',
      inputs: [{ key: 'length', label: 'Length', def: 14, min: 2, max: 200, step: 1 }],
      style: [
        { key: 'viPlusColor', label: 'VI+ color', def: '#26a69a' },
        { key: 'viMinusColor', label: 'VI- color', def: '#ef5350' },
        { key: 'lineWidth', label: 'Line width', def: 1, min: 1, max: 5, step: 1 }
      ],
      compute(c, o) {
        const n = Math.max(2, Math.round(o.length));
        const len = c.length;
        const tr = trArr(c);
        const vp = new Array(len).fill(0), vm = new Array(len).fill(0);
        for (let i = 1; i < len; i++) {
          vp[i] = Math.abs(c[i].high - c[i - 1].low);
          vm[i] = Math.abs(c[i].low - c[i - 1].high);
        }
        const pTr = new Array(len + 1).fill(0), pVp = new Array(len + 1).fill(0), pVm = new Array(len + 1).fill(0);
        for (let i = 0; i < len; i++) {
          pTr[i + 1] = pTr[i] + tr[i];
          pVp[i + 1] = pVp[i] + vp[i];
          pVm[i + 1] = pVm[i] + vm[i];
        }
        const vip = new Array(len).fill(null), vim = new Array(len).fill(null);
        const lw = o.lineWidth || 1;
        for (let i = n - 1; i < len; i++) {
          const sTr = pTr[i + 1] - pTr[i + 1 - n];
          if (!sTr) continue;
          vip[i] = (pVp[i + 1] - pVp[i + 1 - n]) / sTr;
          vim[i] = (pVm[i + 1] - pVm[i + 1 - n]) / sTr;
        }
        return [
          buildSeries(c, vip, o.viPlusColor, 'line', lw),
          buildSeries(c, vim, o.viMinusColor, 'line', lw)
        ];
      }
    },

    tsi: {
      id: 'tsi', name: 'TSI', fullName: 'True Strength Index', cat: 'Momentum', type: 'pane', format: 'percent',
      inputs: [
        { key: 'long', label: 'Long length', def: 25, min: 2, max: 300, step: 1 },
        { key: 'short', label: 'Short length', def: 13, min: 1, max: 100, step: 1 },
        { key: 'signal', label: 'Signal length', def: 13, min: 1, max: 100, step: 1 }
      ],
      style: [
        { key: 'tsiColor', label: 'TSI color', def: '#42a5f5' },
        { key: 'signalColor', label: 'Signal color', def: '#ef5350' },
        { key: 'lineWidth', label: 'Line width', def: 1, min: 1, max: 5, step: 1 }
      ],
      compute(c, o) {
        const len = c.length, L = Math.max(2, Math.round(o.long)), S = Math.max(1, Math.round(o.short)), Sig = Math.max(1, Math.round(o.signal));
        const close = srcArr(c, 'close');
        const chg = new Array(len).fill(null), ab = new Array(len).fill(null);
        for (let i = 1; i < len; i++) { chg[i] = close[i] - close[i - 1]; ab[i] = Math.abs(chg[i]); }
        const e1 = emaSkip(chg, L), a1 = emaSkip(ab, L);
        const e2 = emaSkip(e1, S), a2 = emaSkip(a1, S);
        const t = new Array(len).fill(null);
        for (let i = 0; i < len; i++) {
          if (e2[i] == null || a2[i] == null || a2[i] === 0) continue;
          t[i] = 100 * e2[i] / a2[i];
        }
        const sig = emaSkip(t, Sig);
        const lw = o.lineWidth || 1;
        return [
          buildSeries(c, t, o.tsiColor, 'line', lw),
          buildSeries(c, sig, o.signalColor, 'line', lw)
        ];
      }
    },

    donchian: {
      id: 'donchian', name: 'Donchian Channel', fullName: 'Donchian Channel', cat: 'Trend', type: 'overlay',
      inputs: [{ key: 'length', label: 'Length', def: 20, min: 2, max: 300, step: 1 }],
      style: [
        { key: 'upperColor', label: 'Upper color', def: '#26a69a' },
        { key: 'midColor', label: 'Middle color', def: '#78909c' },
        { key: 'lowerColor', label: 'Lower color', def: '#ef5350' },
        { key: 'lineWidth', label: 'Line width', def: 1, min: 1, max: 5, step: 1 }
      ],
      compute(c, o) {
        const n = Math.max(2, Math.round(o.length));
        const hi = srcArr(c, 'high'), lo = srcArr(c, 'low');
        const hh = highestArr(hi, n), ll = lowestArr(lo, n);
        const up = new Array(c.length).fill(null), dn = new Array(c.length).fill(null), md = new Array(c.length).fill(null);
        const lw = o.lineWidth || 1;
        for (let i = n - 1; i < c.length; i++) {
          if (hh[i] == null || ll[i] == null) continue;
          up[i] = hh[i]; dn[i] = ll[i]; md[i] = (hh[i] + ll[i]) / 2;
        }
        return [
          buildSeries(c, up, o.upperColor, 'line', lw),
          buildSeries(c, md, o.midColor, 'line', lw),
          buildSeries(c, dn, o.lowerColor, 'line', lw)
        ];
      }
    },

    stochrsi: {
      id: 'stochrsi', name: 'Stoch RSI', fullName: 'Stochastic RSI (K/D)', cat: 'Momentum', type: 'pane', format: 'percent',
      inputs: [
        { key: 'rsiLen', label: 'RSI length', def: 14, min: 1, max: 100, step: 1 },
        { key: 'stochLen', label: 'Stoch length', def: 14, min: 1, max: 100, step: 1 },
        { key: 'k', label: '%K smooth', def: 3, min: 1, max: 20, step: 1 },
        { key: 'd', label: '%D smooth', def: 3, min: 1, max: 20, step: 1 }
      ],
      style: [
        { key: 'kColor', label: '%K color', def: '#26a69a' },
        { key: 'dColor', label: '%D color', def: '#ef5350' },
        { key: 'lineWidth', label: 'Line width', def: 1, min: 1, max: 5, step: 1 }
      ],
      compute(c, o) {
        const len = c.length, RL = Math.max(1, Math.round(o.rsiLen));
        const SL = Math.max(1, Math.round(o.stochLen));
        const K = Math.max(1, Math.round(o.k)), D = Math.max(1, Math.round(o.d));
        const close = srcArr(c, 'close');
        const g = new Array(len).fill(0), l = new Array(len).fill(0);
        for (let i = 1; i < len; i++) {
          const d = close[i] - close[i - 1];
          if (d > 0) g[i] = d; else if (d < 0) l[i] = -d;
        }
        const ag = wilderArr(g, RL), al = wilderArr(l, RL);
        const rsi = new Array(len).fill(null);
        for (let i = RL - 1; i < len; i++) {
          const s = ag[i] + al[i];
          rsi[i] = s > 0 ? 100 * ag[i] / s : 50;
        }
        const start = RL + SL - 2;
        const raw = new Array(len).fill(null), kS = new Array(len).fill(null), dS = new Array(len).fill(null);
        for (let i = start; i < len; i++) {
          let hi = -Infinity, lo = Infinity;
          for (let j = i - SL + 1; j <= i; j++) {
            if (rsi[j] == null) continue;
            if (rsi[j] > hi) hi = rsi[j];
            if (rsi[j] < lo) lo = rsi[j];
          }
          const rng = hi - lo;
          if (!(rng > 0)) continue;
          raw[i] = (rsi[i] - lo) / rng * 100;
        }
        for (let i = start; i < len; i++) {
          if (raw[i] == null) continue;
          let s = 0, cnt = 0;
          for (let j = Math.max(start, i - K + 1); j <= i; j++) {
            if (raw[j] == null) { s = 0; cnt = 0; break; }
            s += raw[j]; cnt++;
          }
          if (cnt === K) kS[i] = s / K;
        }
        for (let i = start; i < len; i++) {
          if (kS[i] == null) continue;
          let s = 0, cnt = 0;
          for (let j = Math.max(start, i - D + 1); j <= i; j++) {
            if (kS[j] == null) { s = 0; cnt = 0; break; }
            s += kS[j]; cnt++;
          }
          if (cnt === D) dS[i] = s / D;
        }
        const lw = o.lineWidth || 1;
        return [
          buildSeries(c, kS, o.kColor, 'line', lw),
          buildSeries(c, dS, o.dColor, 'line', lw)
        ];
      }
    },

    elderforce: {
      id: 'elderforce', name: 'Force Index', fullName: 'Elder Force Index', cat: 'Momentum', type: 'pane',
      inputs: [{ key: 'smooth', label: 'Smooth (EMA)', def: 13, min: 1, max: 200, step: 1 }],
      style: [
        { key: 'upColor', label: 'Up color', def: '#26a69a' },
        { key: 'downColor', label: 'Down color', def: '#ef5350' },
        { key: 'lineColor', label: 'Smooth line color', def: '#42a5f5' },
        { key: 'lineWidth', label: 'Line width', def: 1, min: 1, max: 5, step: 1 }
      ],
      compute(c, o) {
        const len = c.length, S = Math.max(1, Math.round(o.smooth));
        const raw = new Array(len).fill(null);
        for (let i = 1; i < len; i++) raw[i] = (Number(c[i].volume) || 0) * (c[i].close - c[i - 1].close);
        raw[0] = null;
        const hist = [];
        for (let i = 1; i < len; i++) {
          if (raw[i] == null) continue;
          hist.push({ time: c[i].time, value: raw[i], color: raw[i] >= 0 ? o.upColor : o.downColor });
        }
        const sm = emaArr(raw.map(v => (v == null ? 0 : v)), S);
        const line = new Array(len).fill(null);
        for (let i = Math.max(1, S - 1); i < len; i++) if (raw[i] != null) line[i] = sm[i];
        return [
          { type: 'histogram', color: o.upColor, data: hist },
          buildSeries(c, line, o.lineColor, 'line', o.lineWidth)
        ];
      }
    }
  };
  const IND_LIST = Object.keys(IND).map(k => IND[k]);

  /* ---------------- engine state ---------------- */
  let chart = null, candleSeries = null, volSeries = null, cw, ck;
  let paneCharts = []; /* {uid, def, chart, container} */
  let candles = [];
  let indicators = []; /* {uid, def, settings} */
  let uidCounter = 1;
  let realtimeTimer = null, realtimeInterval = 30000, realtimeOn = false;
  let fetchFn = null;
  let currentReadingIndex = -1;
  let userPanning = false; /* true while the user is dragging/panning the chart */
  /* Dedicated overlay series owned by the OI Trend / Levels overlay
     (oitrend.js). Kept separate from the user-added IND indicators and from
     the trading-level lines so neither engine disturbs them and it self-heals
     after every rebuild / symbol switch. */
   let dirSeries = null;    /* the EMA-like trend-state line series on main chart */

  const trimNum = (n, d) => {
    if (n == null || isNaN(n)) return '--';
    const f = Number(n).toFixed(d == null ? 2 : d);
    return String(+f);
  };

  /* Compact magnitude formatting: K (thousand), L (lakh), M (million), B (billion) */
  const fmtCompact = (v, d) => {
    if (v == null || isNaN(v)) return '--';
    const a = Math.abs(v);
    const dec = d == null ? 2 : d;
    if (a >= 1e9) return trimNum(v / 1e9, dec) + 'B';
    if (a >= 1e6) return trimNum(v / 1e6, dec) + 'M';
    if (a >= 1e5) return trimNum(v / 1e5, dec) + 'L';
    if (a >= 1e3) return trimNum(v / 1e3, dec) + 'K';
    return trimNum(v, dec);
  };

  /* Indicator-specific reading format: % for oscillators, compact units for the rest */
  const fmtReading = (v, kind) => {
    if (v == null || isNaN(v)) return '--';
    if (kind === 'percent') return trimNum(v, 2) + '%';
    if (kind === 'decimal') return Number(v).toFixed(2);
    return fmtCompact(v, 2);
  };

  /* Convert a #hex color into an rgba() with the given alpha (used to fade prior VWAP sessions) */
  function fadeColor(hex, alpha) {
    let h = String(hex || '#ff9800').replace('#', '');
    if (h.length === 3) h = h.split('').map(x => x + x).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return 'rgba(255,152,0,' + alpha + ')';
    const n = parseInt(h, 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }
  const svgGear = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>';

  const svgX = '<svg width="10" height="10" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" fill="none"><path d="M18 6L6 18M6 6l12 12"/></svg>';

  const svgPlus = '<svg width="10" height="10" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" fill="none"><path d="M12 5v14M5 12h14"/></svg>';

  let alertSeq = 0;

  function defaultsFor(def) {
    const d = {};
    def.inputs.forEach(i => d[i.key] = i.def);
    def.style.forEach(s => d[s.key] = s.def);
    return d;
  }

  function firstColor(def, settings) {
    for (const s of def.style) if (s.type === 'color') return settings[s.key];
    return '#888';
  }

  /* ---------------- chart lifecycle ---------------- */
  function computeFor(ind) {
    try {
      return ind.def.compute(candles, ind.settings);
    } catch (e) {
      return [];
    }
  }

  /* Keep main chart visible range in sync with pane charts and vice versa.
     A `syncing` guard suppresses the echo: setting a range on the targets
     fires THEIR change callbacks, which would otherwise call setVisibleRange
     back on the source in a tight loop on every drag frame — stalling the
     realtime updates and corrupting the zoom. */
  let rangeSyncing = false;
  let rangeSyncTimer = null;
  function syncRanges(fromChart) {
    if (rangeSyncing) return;
    const from = fromChart || chart;
    if (!from) return;
    /* Sync by TIME range, not logical (bar-index) range. Logical ranges count
       bars from each chart's own data start; pane indicators drop their warmup
       bars (e.g. SMF/VL skip the first `length-1` candles), so the pane's bar 0
       is NOT the chart's bar 0 — a fixed index offset that pushes every pane's
       time axis out of line with the main chart. Because all pane series share
       the exact candle timestamps, a time-range sync keeps every chart's dates
       and times perfectly aligned with the main chart. */
    let r = null;
    try { r = from.timeScale().getVisibleRange(); } catch (e) { return; }
    if (!r) return;
    rangeSyncing = true;
    if (rangeSyncTimer) clearTimeout(rangeSyncTimer);
    rangeSyncTimer = setTimeout(() => { rangeSyncing = false; }, 80);
    const targets = [chart].concat(paneCharts.map(p => p.chart)).filter(c => c && c !== from);
    targets.forEach(t => {
      try { t.timeScale().setVisibleRange(r); } catch (e) {}
    });
  }

  function hookRangeSync(c) {
    try { c.timeScale().subscribeVisibleLogicalRangeChange(() => syncRanges(c)); } catch (e) {}
  }

  function makeChart(opts) {
    return LightweightCharts.createChart(opts.container, {
      layout: { background: { color: '#0b0b1a' }, textColor: '#d0d0d0' },
      grid: { vertLines: { color: '#1a1a30' }, horzLines: { color: '#1a1a30' } },
      crosshair: { mode: 1 },
      rightPriceScale: { borderColor: '#2d2d50' },
      timeScale: { borderColor: '#2d2d50', timeVisible: true, secondsVisible: false },
      localization: {
        timeFormatter: function(ts) {
          const d = new Date(ts * 1000);
          const h = d.getUTCHours();
          const m = String(d.getUTCMinutes()).padStart(2, '0');
          const ampm = h >= 12 ? 'PM' : 'AM';
          const h12 = h % 12 || 12;
          return h12 + ':' + m + ' ' + ampm;
        }
      },
      width: opts.width,
      height: opts.height
    });
  }

  /* Explicitly size main chart + all pane charts from their containers */
  function resizeAll() {    if (chart) {
      const w = cw.clientWidth, h = cw.clientHeight;
      if (w && h) chart.applyOptions({ width: w, height: h });
    }
    paneCharts.forEach(p => {
      const w = p.paneEl ? p.paneEl.clientWidth : 0;
      const h = p.paneEl ? p.paneEl.clientHeight : 0;
      if (w && h) p.chart.applyOptions({ width: w, height: h });
    });
  }

  /* Anchor to the most recent bars at a comfortable candle width instead of
     fitContent(), which zooms all the way out to show every loaded candle
     (thousands on intraday charts) and makes each candle a thin sliver. */
  function fitToRecent() {
    if (!chart || !candles.length) return;
    const last = candles.length - 1;
    const n = Math.min(200, candles.length);
    try {
      chart.timeScale().applyOptions({ barSpacing: 8, rightOffset: 2 });
      chart.timeScale().setVisibleLogicalRange({ from: last - n + 1, to: last });
    } catch (e) {}
  }

  /* During realtime ticks new bars are appended at the right edge. Keep the
     view anchored on the newest candle, but only when the user is already at or
     near the right edge so they can freely scroll back without being yanked.
     Skipped entirely while the user is dragging so a pan can never be fought.
     Also skipped when the user has deliberately panned blank space on the right
     (r.to beyond the data) to examine the forming candle — that view is kept.
     The width is capped so a corrupted (fit-all) range snaps back to a sane
     recent view instead of staying zoomed all the way out. */
  function followLatest() {
    if (!chart || !candles.length || userPanning) return;
    const last = candles.length - 1;
    try {
      const r = chart.timeScale().getVisibleLogicalRange();
      if (!r) return;
      if (r.to < last - 3 || r.to > last + 5) return;
      let width = Math.max(r.to - r.from, 10);
      if (width > 300) width = 200;
      chart.timeScale().setVisibleLogicalRange({ from: last - width, to: last });
      syncRanges(chart);
    } catch (e) {}
  }

  /* Scroll the containing tab so a given pane box is fully visible */
  function scrollToPane(uid) {
    const box = document.querySelector('.pane-box[data-uid="' + uid + '"]');
    if (box && box.scrollIntoView) box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  window.addEventListener('resize', () => resizeAll());
  document.addEventListener('click', (e) => {
    const m = document.getElementById('indMenu');
    if (m && !m.classList.contains('hidden') && !e.target.closest('.menu-wrap')) {
      m.classList.add('hidden');
    }
  });

  /* Sync a series' price lines to the compute output (replace existing) */
  function applyPriceLine(s, o) {
    if (!s || !o) return;
    try {
      if (s.priceLines) s.priceLines().forEach(pl => { try { s.removePriceLine(pl); } catch (e) {} });
    } catch (e) {}
    if (o.priceLine && s.createPriceLine) {
      try { s.createPriceLine(o.priceLine); } catch (e) {}
    }
  }

  /* Create a series from a compute output, applying data + optional price line.
     When fmtKind is provided, the price axis labels use the indicator's reading format. */
  function applySeries(host, o, fmtKind) {
    const s = host.addSeries(o.type === 'histogram' ? LightweightCharts.HistogramSeries : LightweightCharts.LineSeries, {
      color: o.color || '#888', lineWidth: o.lineWidth || 1,
      ...(o.type === 'histogram' ? { base: 0 } : {}),
      ...(fmtKind ? { priceFormat: { type: 'custom', formatter: v => fmtReading(v, fmtKind) } } : {})
    });
    s.setData(o.data);
    applyPriceLine(s, o);
    return s;
  }

  /* Full rebuild: recreate main chart + all pane charts (used on add/remove/settings) */
  function render() {
    const vr = chart ? chart.timeScale().getVisibleRange() : null;
    if (chart) { chart.remove(); chart = null; }
    /* Any overlay trade lines point at the destroyed series; drop them so the
       next syncTradeChartLines cycle redraws on the fresh candle series. */
    if (window.IndChart) window.IndChart._tradeLines = {};
    if (window.IndChart) window.IndChart._ocLines = {};
    dirSeries = null;
    cw.innerHTML = '';
    const host = document.getElementById('ind-panes');
    if (host) host.innerHTML = '';
    paneCharts.forEach(p => { try { p.chart.remove(); } catch (e) {} });
    paneCharts = [];

    chart = makeChart({ container: cw, width: cw.clientWidth || 800, height: cw.clientHeight || 480 });
    candleSeries = chart.addSeries(LightweightCharts.CandlestickSeries, {
      upColor: '#00d4aa', downColor: '#ff5252',
      borderUpColor: '#00d4aa', borderDownColor: '#ff5252',
      wickUpColor: '#00d4aa', wickDownColor: '#ff5252'
    });
    volSeries = chart.addSeries(LightweightCharts.HistogramSeries, {
      priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false
    });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    chart.subscribeCrosshairMove(onCrosshair);
    hookRangeSync(chart);

    indicators.forEach(ind => {
      const out = computeFor(ind);
      if (ind.def.type === 'pane') {
        ind._series = createPaneChart(ind, out);
        return;
      }
      ind._series = out.map(o => applySeries(chart, o));
    });

    const saneC = candles.filter(x => x && isFinite(x.open) && isFinite(x.high) && isFinite(x.low) && isFinite(x.close) && isFinite(x.time));
    candleSeries.setData(saneC.map(x => ({ time: x.time, open: x.open, high: x.high, low: x.low, close: x.close })));
    volSeries.setData(saneC.map(x => ({ time: x.time, value: x.volume, color: x.close >= x.open ? '#00d4aa40' : '#ff525240' })));
    if (vr) chart.timeScale().setVisibleRange(vr); else fitToRecent();
    updateLegend();
    syncRanges(chart);
    requestAnimationFrame(resizeAll);
  }

  /* Create a separate lightweight-charts instance below the main chart for a pane indicator */
  function createPaneChart(ind, out) {
    const host = document.getElementById('ind-panes');
    if (!host) return [];
    const box = document.createElement('div');
    box.className = 'pane-box';
    box.dataset.uid = ind.uid;
    const head = document.createElement('div');
    head.className = 'pane-head';
    const nm = document.createElement('span');
    nm.className = 'pane-name';
    nm.textContent = displayName(ind);
    nm.title = ind.def.fullName;
    nm.onclick = () => openSettings(ind.uid);
    const gear = document.createElement('span');
    gear.className = 'pane-gear';
    gear.innerHTML = svgGear;
    gear.title = 'Settings';
    gear.onclick = () => openSettings(ind.uid);
    const close = document.createElement('span');
    close.className = 'pane-close';
    close.innerHTML = svgX;
    close.title = 'Remove';
    close.onclick = () => removeIndicator(ind.uid);
    const read = document.createElement('span');
    read.className = 'pane-read';
    read.title = 'Realtime reading';
    read.textContent = '--';
    const plus = document.createElement('span');
    plus.className = 'pane-plus';
    plus.innerHTML = svgPlus;
    plus.title = 'Add alert line';
    plus.onclick = () => toggleAlertBox(ind.uid);
    if (ind.def.id !== 'bbpct') plus.style.display = 'none';
    head.appendChild(nm); head.appendChild(read); head.appendChild(plus); head.appendChild(gear); head.appendChild(close);
    const pc = document.createElement('div');
    pc.className = 'pane-chart';
    const ab = document.createElement('div');
    ab.className = 'pane-alertbox hidden';
    box.appendChild(head); box.appendChild(pc); box.appendChild(ab);
    host.appendChild(box);

    const sub = makeChart({ container: pc, width: pc.clientWidth || 800, height: pc.clientHeight || 130 });
    paneCharts.push({ uid: ind.uid, def: ind.def, chart: sub, box, head, paneEl: pc });
    hookRangeSync(sub);
    const series = out.map(o => applySeries(sub, o, ind.def.format));
    if (ind._alertLines && ind._alertLines.length) applyAlertLines(series[0], ind);
    return series;
  }

  /* Realtime: update data in place without rebuilding panes.
     setData() in lightweight-charts v5 resets the time scale to fit ALL data,
     which on the 2s realtime poll collapses a 5-min chart into ~50k slivers.
     Preserve the current visible range so the zoom never jumps. */
  function setData() {
    if (!chart) { render(); return; }
    let r = null;
    try { r = chart.timeScale().getVisibleLogicalRange(); } catch (e) {}
    const saneC = candles.filter(x => x && isFinite(x.open) && isFinite(x.high) && isFinite(x.low) && isFinite(x.close) && isFinite(x.time));
    candleSeries.setData(saneC.map(x => ({ time: x.time, open: x.open, high: x.high, low: x.low, close: x.close })));
    volSeries.setData(saneC.map(x => ({ time: x.time, value: x.volume, color: x.close >= x.open ? '#00d4aa40' : '#ff525240' })));
    indicators.forEach(ind => {
      if (!ind._series) return;
      const out = computeFor(ind);
      ind._series.forEach((s, i) => {
        if (!s || !out[i]) return;
        s.setData(out[i].data);
        applyPriceLine(s, out[i]);
      });
      if (ind._alertLines && ind._alertLines.length && ind._series[0]) applyAlertLines(ind._series[0], ind);
    });
    if (r && candleSeries && candles.length && isFinite(r.from) && isFinite(r.to) && r.to >= r.from) {
      const width = r.to - r.from;
      /* Preserve the user's EXACT view (including blank space they panned for
         so the forming candle stays put). Only a fit-all reset — which spans
         the whole history, width >> 600 — falls back to the recent window. */
      if (width > 0 && width <= 600) {
        try { chart.timeScale().setVisibleLogicalRange({ from: r.from, to: r.to }); } catch (e) {}
        syncRanges(chart);
        updateLegend();
        return;
      }
    }
    /* Range missing, or the captured range was a fit-all reset (huge width) ->
       snap back to a sane recent window instead of staying zoomed out. */
    fitToRecent();
    syncRanges(chart);
    updateLegend();
  }

  function rebuild() { render(); }

  function onCrosshair(param) {
    if (!param.time) {
      if (currentReadingIndex !== -1) { currentReadingIndex = -1; updateLegend(); }
      return;
    }
    const idx = candles.findIndex(c => c.time === param.time);
    currentReadingIndex = idx;
    updateLegend();
  }

  function computeReadings(ind) {
    const out = computeFor(ind);
    const reads = [];
    out.forEach(o => {
      if (o.noRead) return;
      let val = null;
      if (currentReadingIndex >= 0) {
        const d = o.data.find(dd => dd.time === candles[currentReadingIndex].time);
        if (d) val = d.value;
      } else {
        const last = o.data[o.data.length - 1];
        if (last) val = last.value;
      }
      reads.push({ color: o.color || '#888', value: val });
    });
    return reads;
  }

  /* Selectable value options for an indicator (multi-series indicators expose each line) */
  function valueOptionsFor(id) {
    switch (id) {
      case 'adx': return [['v0', 'ADX'], ['v1', '+DI'], ['v2', '-DI']];
      case 'macd': return [['v0', 'MACD'], ['v1', 'Signal'], ['v2', 'Histogram']];
      case 'rsi': return [['v0', 'RSI'], ['v1', 'Smoothed']];
      case 'smiio': return [['v0', 'SMI'], ['v1', 'Signal'], ['v2', 'Histogram']];
      case 'bb': return [['v0', 'Upper'], ['v1', 'Middle'], ['v2', 'Lower']];
      case 'bbpct': return [['v0', 'BB%b']];
      case 'ppo': return [['v0', 'PPO'], ['v1', 'Signal'], ['v2', 'Histogram']];
      case 'pc': return [['v0', 'Upper'], ['v1', 'Middle'], ['v2', 'Lower']];
      case 'autosr': return [['v0', 'Resistance'], ['v1', 'Support']];
      case 'obv': return [['v0', 'OBV'], ['v1', 'Smoothed MA']];
      case 'smf': return [['v0', 'SMF'], ['v1', 'Signal'], ['v2', 'Histogram']];
      case 'vl': return [['v0', 'Volume Line'], ['v1', 'Signal']];
      default: return [['v0', 'Value']];
    }
  }

  /* Evaluate a deployed indicator's realtime reading (last bar value) for a series key.
     Used by the indicator-based strategy engine. */
  function computeValue(defId, settings, key, candlesArr) {
    return computeLastTwo(defId, settings, key, candlesArr).last;
  }

  /* ---------------- fast last-two readings (cross detection) ----------------
   * The strategy engine only needs {prev, last} of each series to detect
   * crosses. Computing the whole indicator series every tick is wasteful, so
   * we memoize on the candle signature and provide an O(1) incremental path
   * for EMA so realtime cross conditions evaluate in a few nanoseconds of
   * arithmetic when only one bar changed.
   * ---------------- */
  const LT_CACHE = new Map();
  const LT_MAX = 512;

  function candlesSig(candles) {
    const n = candles.length;
    if (!n) return '0';
    const c = candles[n - 1];
    const p = candles[n - 2];
    let sig = n + ':' + c.time + ':' + c.close + ':' + c.open + ':' + c.high + ':' + c.low;
    if (p) sig += ':' + p.time + ':' + p.close;
    return sig;
  }

  /* O(1) incremental EMA update when exactly one bar changed since last read.
     Returns null when the change cannot be applied incrementally (caller falls
     back to a full recompute, which is still memoized). */
  function ltIncremental(defId, settings, key, candles, hit) {
    if (defId !== 'ema' || key !== 'v0') return null;
    if (!hit || hit.last == null || hit.prev == null) return null;
    const n = candles.length;
    const c = candles[n - 1];
    const p0 = candles[n - 2];
    const len = (settings && settings.length) || 9;
    const src = (settings && settings.source) || 'close';
    const k = 2 / (len + 1);
    /* Pure append: old length + 1 and the old last bar is unchanged. */
    if (n === hit.n + 1 && p0 && hit.lastTime === p0.time && hit.lastClose === p0.close) {
      const s = srcArr([c], src)[0];
      const last = s * k + hit.last * (1 - k);
      return { last, prev: hit.last, n, lastTime: c.time, lastClose: c.close };
    }
    /* In-place update of the last bar (realtime tick): same length/time. */
    if (n === hit.n && c.time === hit.lastTime && c.close !== hit.lastClose) {
      const s = srcArr([c], src)[0];
      const last = s * k + hit.prev * (1 - k);
      return { last, prev: hit.prev, n, lastTime: c.time, lastClose: c.close };
    }
    return null;
  }

  /* Return {prev, last} readings of a series for cross-detection (strategy engine).
     Memoized + incremental EMA so repeated evaluations are O(1). */
  function computeLastTwo(defId, settings, key, candlesArr) {
    const def = IND[defId];
    if (!def || !def.compute || !candlesArr || !candlesArr.length) return { last: null, prev: null };
    const settingsObj = settings || defaultsFor(def);
    if (defId === 'bbpct') {
      /* O((smooth+1)*length), independent of candle count — recomputed live so
         the strategy engine sees tick-accurate %B every evaluation. */
      return bbpctLastTwo(candlesArr, settingsObj);
    }
    const ckey = defId + '|' + JSON.stringify(settingsObj) + '|' + String(key || 'v0');
    const sig = candlesSig(candlesArr);
    const hit = LT_CACHE.get(ckey);
    if (hit && hit.sig === sig) return { last: hit.last, prev: hit.prev };
    if (hit) {
      const inc = ltIncremental(defId, settingsObj, key, candlesArr, hit);
      if (inc) { inc.sig = sig; LT_CACHE.set(ckey, inc); return { last: inc.last, prev: inc.prev }; }
    }
    let out;
    try {
      out = def.compute(candlesArr, settingsObj);
    } catch (e) { return { last: null, prev: null }; }
    if (!Array.isArray(out) || !out.length) return { last: null, prev: null };
    const idx = parseInt(String(key || 'v0').replace(/^v/, ''), 10) || 0;
    const s = out[idx];
    if (!s || !s.data || !s.data.length) return { last: null, prev: null };
    const arr = s.data;
    const last = arr[arr.length - 1];
    const prev = arr.length > 1 ? arr[arr.length - 2] : null;
    const ok = v => v && v.value != null && !isNaN(v.value);
    const r = {
      last: ok(last) ? last.value : null,
      prev: ok(prev) ? prev.value : null,
      n: candlesArr.length,
      lastTime: candlesArr[candlesArr.length - 1].time,
      lastClose: candlesArr[candlesArr.length - 1].close,
      sig
    };
    LT_CACHE.set(ckey, r);
    if (LT_CACHE.size > LT_MAX) { const fk = LT_CACHE.keys().next().value; LT_CACHE.delete(fk); }
    return { last: r.last, prev: r.prev };
  }

  /* Fastest path: when the requested indicator is deployed on the chart with
     EXACTLY matching settings and the candle data matches the chart's own
     candles, read {prev, last} directly from the already-rendered series (no
     recompute). The instance is matched by id AND settings so a strategy whose
     condition uses EMA21 reads the EMA21 line, not a same-id EMA9 instance. */
  function renderedLastTwo(indId, settings, key, candlesArr) {
    if (!indicators || !indicators.length) return null;
    const want = JSON.stringify(settings || {});
    const dep = indicators.find(i => i.def.id === indId && JSON.stringify(i.settings || {}) === want);
    if (!dep || !dep._series || !dep._series.length) return null;
    const ch = getCandles();
    if (!ch || !ch.length || !candlesArr || !candlesArr.length) return null;
    const c0 = ch[ch.length - 1], c1 = candlesArr[candlesArr.length - 1];
    if (c0.time !== c1.time || c0.close !== c1.close) return null;
    const idx = parseInt(String(key || 'v0').replace(/^v/, ''), 10) || 0;
    const s = dep._series[idx];
    if (!s || typeof s.data !== 'function') return null;
    let arr;
    try { arr = s.data(); } catch (e) { return null; }
    const last = arr[arr.length - 1];
    const prev = arr.length > 1 ? arr[arr.length - 2] : null;
    const ok = v => v && v.value != null && !isNaN(v.value);
    return { last: ok(last) ? last.value : null, prev: ok(prev) ? prev.value : null };
  }

  /* ---------------- UI: legend ---------------- */
  function updatePaneSection() {
    const host = document.getElementById('ind-panes');
    const countEl = document.getElementById('indSectionCount');
    const count = indicators.filter(i => i.def.type === 'pane').length;
    if (countEl) countEl.textContent = count;
    if (host && count === 0 && !host.querySelector('.ind-empty')) {
      host.innerHTML = '<div class="ind-empty">No pane indicators added. Use the Indicators menu to add one.</div>';
    }
  }

  /* Update the realtime reading badge shown in each pane header */
  function updatePaneReadings() {
    indicators.forEach(ind => {
      const el = document.querySelector('.pane-box[data-uid="' + ind.uid + '"] .pane-read');
      if (!el) return;
      /* BB%b: tick-accurate realtime reading. Computed from the rolling tail
         (O((smooth+1)*length), <1 ms regardless of chart size) so the badge,
         the in-place price line update and the draw-line alerts all track the
         live patched bar instead of waiting for the 2s server poll. */
      if (ind.def.id === 'bbpct') {
        const r = bbpctLastTwo(candles, ind.settings);
        if (r.last == null || isNaN(r.last)) {
          el.textContent = '--';
          el.style.color = '#666';
          return;
        }
        el.textContent = fmtReading(r.last, ind.def.format);
        el.style.color = ind.settings.color || '#bbb';
        const s = ind._series && ind._series[0];
        if (s && s.update) {
          try { s.update({ time: candles[candles.length - 1].time, value: r.last }); } catch (e) {}
        }
        checkAlertLines(ind, r.prev, r.last);
        return;
      }
      const reads = computeReadings(ind);
      const shown = reads.filter(r => r.value != null && !isNaN(r.value));
      if (!shown.length) {
        el.textContent = '--';
        el.style.color = '#666';
        return;
      }
      el.textContent = shown.map(r => fmtReading(r.value, ind.def.format)).join(' / ');
      el.style.color = shown[0].color || '#bbb';
    });
  }

  /* ---------------- BB%b draw-line alerts (multi-line) ---------------- */
  const ALERT_COLORS = ['#ff5252', '#26a69a', '#7ad7ff', '#ff9800', '#b39ddb', '#ff6b6b', '#ffb300', '#66ccff'];

  function alertLineColor(ind) {
    return ALERT_COLORS[(ind._alertLines ? ind._alertLines.length : 0) % ALERT_COLORS.length];
  }

  function toastAlert(msg) {
    let box = document.getElementById('indToastBox');
    if (!box) {
      box = document.createElement('div');
      box.id = 'indToastBox';
      box.style.cssText = 'position:fixed;top:12px;right:12px;z-index:99999;display:flex;flex-direction:column;gap:6px;max-width:340px';
      document.body.appendChild(box);
    }
    const t = document.createElement('div');
    t.style.cssText = 'background:#1a1a35;border:1px solid #ffb300;border-left:3px solid #ffb300;color:#d0d0d0;padding:8px 12px;border-radius:4px;font-size:11px;box-shadow:0 4px 16px rgba(0,0,0,.5);opacity:0;transform:translateX(12px);transition:all .18s ease';
    t.textContent = msg;
    box.appendChild(t);
    requestAnimationFrame(() => { t.style.opacity = '1'; t.style.transform = 'none'; });
    setTimeout(() => {
      t.style.opacity = '0'; t.style.transform = 'translateX(12px)';
      setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, 200);
    }, 3500);
  }

  /* Every alert line drawn by the user's "+" button. Each line fires a toast
     (and an ind-alert CustomEvent) when the live BB%b crosses its value.
     Rate-limited per line to one alert per 2s. */
  function checkAlertLines(ind, prev, last) {
    const lines = ind._alertLines || [];
    if (!lines.length || prev == null || last == null || isNaN(prev) || isNaN(last)) return;
    const now = Date.now();
    ind._alertAt = ind._alertAt || {};
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const price = Number(ln.price);
      if (!isFinite(price)) continue;
      const up = prev < price && last >= price;
      const dn = prev > price && last <= price;
      if (!up && !dn) continue;
      if (ind._alertAt[ln.id] && now - ind._alertAt[ln.id] < 2000) continue;
      ind._alertAt[ln.id] = now;
      const dir = up ? 'CROSSED ABOVE' : 'CROSSED BELOW';
      toastAlert('BB%b ' + dir + ' ' + fmtReading(price, ind.def.format) + '  ->  ' + fmtReading(last, ind.def.format));
      try {
        document.dispatchEvent(new CustomEvent('ind-alert', {
          detail: { id: 'bbpct', dir: up ? 'up' : 'down', level: price, value: last, uid: ind.uid, line: ln.id }
        }));
      } catch (e) {}
    }
  }

  /* Draw all user alert lines on a pane series (removes stale ones first). */
  function applyAlertLines(s, ind) {
    if (!s || !ind) return;
    try {
      if (s.priceLines) s.priceLines().forEach(pl => { try { s.removePriceLine(pl); } catch (e) {} });
    } catch (e) {}
    (ind._alertLines || []).forEach(ln => {
      if (!s.createPriceLine) return;
      try {
        s.createPriceLine({
          price: Number(ln.price) || 0,
          color: ln.color,
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: 'BB%b ' + ln.price
        });
      } catch (e) {}
    });
  }

  /* "+" button: open a small popover listing the pane's alert lines (with a
     remove ✕ per row) and a number input to add a new line at any value. */
  function toggleAlertBox(uid) {
    const box = document.querySelector('.pane-box[data-uid="' + uid + '"] .pane-alertbox');
    if (!box) return;
    const opening = box.classList.contains('hidden');
    document.querySelectorAll('.pane-alertbox').forEach(b => b.classList.add('hidden'));
    if (opening) { box.classList.remove('hidden'); renderAlertBox(uid); }
  }

  function renderAlertBox(uid) {
    const ind = indicators.find(i => i.uid === uid);
    if (!ind) return;
    const box = document.querySelector('.pane-box[data-uid="' + uid + '"] .pane-alertbox');
    if (!box) return;
    box.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'pane-alertbox-title';
    title.textContent = 'BB%b alert lines (draw-line crosses)';
    box.appendChild(title);
    const list = document.createElement('div');
    list.className = 'pane-alertbox-list';
    (ind._alertLines || []).forEach(ln => {
      const row = document.createElement('div');
      row.className = 'pane-alertbox-row';
      const dot = document.createElement('span');
      dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:' + ln.color + ';display:inline-block';
      const val = document.createElement('span');
      val.textContent = fmtReading(ln.price, ind.def.format);
      val.style.color = '#ddd';
      const rm = document.createElement('button');
      rm.className = 'pane-alertbox-rm';
      rm.innerHTML = svgX;
      rm.title = 'Remove line ' + ln.price;
      rm.onclick = () => removeAlertLine(uid, ln.id);
      row.appendChild(dot); row.appendChild(val); row.appendChild(rm);
      list.appendChild(row);
    });
    box.appendChild(list);
    const addRow = document.createElement('div');
    addRow.className = 'pane-alertbox-add';
    const inp = document.createElement('input');
    inp.type = 'number'; inp.step = '0.05';
    const last = bbpctLastTwo(candles, ind.settings);
    inp.value = (last.last != null && !isNaN(last.last)) ? fmtReading(last.last, ind.def.format) : '0.5';
    inp.placeholder = 'Value (e.g. 0.5, 1.0)';
    const btn = document.createElement('button');
    btn.textContent = '+ Add';
    btn.onclick = () => {
      const v = parseFloat(inp.value);
      if (isNaN(v)) { inp.focus(); return; }
      addAlertLine(uid, v);
    };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') btn.onclick(); });
    addRow.appendChild(inp); addRow.appendChild(btn);
    box.appendChild(addRow);
  }

  function addAlertLine(uid, price) {
    const ind = indicators.find(i => i.uid === uid);
    if (!ind) return;
    if (!ind._alertLines) ind._alertLines = [];
    if (ind._alertLines.some(l => Math.abs(Number(l.price) - price) < 1e-9)) return;
    ind._alertLines.push({ id: 'al' + (alertSeq++), price, color: alertLineColor(ind) });
    const s = ind._series && ind._series[0];
    if (s) applyAlertLines(s, ind);
    const box = document.querySelector('.pane-box[data-uid="' + uid + '"] .pane-alertbox');
    if (box && !box.classList.contains('hidden')) renderAlertBox(uid);
    stateChange();
  }

  function removeAlertLine(uid, id) {
    const ind = indicators.find(i => i.uid === uid);
    if (!ind || !ind._alertLines) return;
    ind._alertLines = ind._alertLines.filter(l => l.id !== id);
    const s = ind._series && ind._series[0];
    if (s) applyAlertLines(s, ind);
    const box = document.querySelector('.pane-box[data-uid="' + uid + '"] .pane-alertbox');
    if (box && !box.classList.contains('hidden')) renderAlertBox(uid);
    stateChange();
  }

  function updateLegend() {
    const leg = document.getElementById('indLegend');
    if (!leg) return;
    updatePaneSection();
    leg.innerHTML = '';
    updatePaneReadings();
    if (!indicators.length) { leg.classList.add('hidden'); return; }
    leg.classList.remove('hidden');
    indicators.forEach(ind => {
      const row = document.createElement('div');
      row.className = 'leg-row';
      const dot = document.createElement('span');
      dot.className = 'leg-dot';
      dot.style.background = firstColor(ind.def, ind.settings);
      const name = document.createElement('span');
      name.className = 'leg-name';
      name.textContent = displayName(ind);
      name.title = ind.def.fullName;
      name.onclick = () => openSettings(ind.uid);
      row.appendChild(dot); row.appendChild(name);
      computeReadings(ind).forEach(r => {
        const v = document.createElement('span');
        v.className = 'leg-val';
        v.style.color = r.color;
        v.textContent = fmtReading(r.value, ind.def.format);
        row.appendChild(v);
      });
      const g = document.createElement('button');
      g.className = 'leg-btn';
      g.innerHTML = svgGear;
      g.title = 'Settings';
      g.onclick = () => openSettings(ind.uid);
      const x = document.createElement('button');
      x.className = 'leg-btn';
      x.innerHTML = svgX;
      x.title = 'Remove';
      x.onclick = () => removeIndicator(ind.uid);
      row.appendChild(g); row.appendChild(x);
      leg.appendChild(row);
    });
  }

  /* ---------------- UI: dropdown ---------------- */
  function renderMenu(q) {
    const list = document.getElementById('indList');
    list.innerHTML = '';
    const query = (q || '').toLowerCase();
    IND_LIST.forEach(def => {
      const hay = (def.name + ' ' + def.fullName + ' ' + def.cat).toLowerCase();
      if (query && !hay.includes(query)) return;
      const item = document.createElement('div');
      const count = countDeployed(def.id);
      item.className = 'ind-item' + (count ? ' deployed' : '');
      const nm = document.createElement('div');
      nm.className = 'ind-item-name';
      nm.textContent = def.name;
      const fl = document.createElement('div');
      fl.className = 'ind-item-full';
      fl.textContent = def.fullName + ' · ' + (def.type === 'pane' ? 'Pane' : 'Overlay');
      item.appendChild(nm); item.appendChild(fl);
      const tag = document.createElement('div');
      tag.className = 'ind-item-tag';
      tag.textContent = count ? 'Add #' + (count + 1) : '+';
      tag.title = count ? 'Already ' + count + ' instance(s) deployed. Click to add another with different settings.' : 'Add indicator';
      item.appendChild(tag);
      item.onclick = () => {
        addIndicator(def.id);
        document.getElementById('indMenu').classList.add('hidden');
      };
      list.appendChild(item);
    });
  }

  function isDeployed(id) { return indicators.some(i => i.def.id === id); }

  /* Number of deployed instances of an indicator id */
  function countDeployed(id) {
    let n = 0;
    indicators.forEach(i => { if (i.def.id === id) n++; });
    return n;
  }

  /* Display name with an instance suffix (#2, #3...) when the same indicator
     is deployed more than once, so multiple instances can be told apart. */
  function displayName(ind) {
    if (countDeployed(ind.def.id) < 2) return ind.def.name;
    let idx = 1;
    for (let i = 0; i < indicators.length; i++) {
      if (indicators[i].def.id !== ind.def.id) continue;
      if (indicators[i] === ind) break;
      idx++;
    }
    return ind.def.name + ' #' + idx;
  }

  /* ---------------- indicator management ---------------- */
  const stateChange = () => {
    try { document.dispatchEvent(new CustomEvent('statechange')); } catch (e) {}
  };

  function addIndicator(id, settings) {
    const def = IND[id];
    if (!def) return;
    const base = defaultsFor(def) || {};
    const merged = Object.assign({}, base, settings || {});
    indicators.push({ uid: uidCounter++, def, settings: merged, _series: null });
    if (chart) {
      rebuild();
      requestAnimationFrame(() => scrollToPane(indicators[indicators.length - 1].uid));
    } else updateLegend();
    stateChange();
  }

  function removeIndicator(uid) {
    indicators = indicators.filter(i => i.uid !== uid);
    if (chart) rebuild(); else updateLegend();
    stateChange();
  }

  function removeAll() {
    indicators = [];
    if (chart) rebuild(); else updateLegend();
    stateChange();
  }

  /* ---------------- UI: settings modal ---------------- */
  let editUid = null;
  let editDef = null;

  function openSettings(uid) {
    const ind = indicators.find(i => i.uid === uid);
    if (!ind) return;
    editUid = uid; editDef = ind.def;
    (editDef.inputs || []).forEach(inp => {
      if (ind.settings[inp.key] === undefined) ind.settings[inp.key] = inp.def;
    });
    document.getElementById('indModalTitle').textContent = displayName(ind);
    renderSettingsForm(ind.settings);
    document.getElementById('indModal').classList.remove('hidden');
  }

  function closeModal() {
    document.getElementById('indModal').classList.add('hidden');
    editUid = null; editDef = null;
  }

  function renderSettingsForm(settings) {
    const body = document.getElementById('indModalBody');
    body.innerHTML = '';
    body.setAttribute('data-uid', editUid);
    const mkRow = (f) => {
      const row = document.createElement('div');
      row.className = 'sf-row';
      const label = document.createElement('label');
      label.textContent = f.label;
      let ctl;
      if (f.type === 'color') {
        ctl = document.createElement('input');
        ctl.type = 'color';
        ctl.value = settings[f.key];
      } else if (f.type === 'checkbox') {
        ctl = document.createElement('input');
        ctl.type = 'checkbox';
        ctl.checked = !!settings[f.key];
        ctl.addEventListener('change', () => liveApplyInput(ctl));
      } else if (f.options) {
        ctl = document.createElement('select');
        f.options.forEach(o => {
          const op = document.createElement('option');
          op.value = o[0]; op.textContent = o[1];
          if (o[0] === settings[f.key]) op.selected = true;
          ctl.appendChild(op);
        });
        ctl.addEventListener('change', () => liveApplyInput(ctl));
      } else {
        ctl = document.createElement('input');
        ctl.type = 'number';
        ctl.min = f.min; ctl.max = f.max; ctl.step = f.step;
        ctl.value = settings[f.key];
        ctl.addEventListener('input', () => liveApplyInput(ctl));
        ctl.addEventListener('change', () => liveApplyInput(ctl));
      }
      ctl.dataset.key = f.key;
      row.appendChild(label); row.appendChild(ctl);
      return row;
    };
    const inputsSec = document.createElement('div');
    const h1 = document.createElement('div'); h1.className = 'sf-sec-title'; h1.textContent = 'Inputs';
    inputsSec.appendChild(h1);
    if (editDef.inputs.length) {
      editDef.inputs.forEach(f => { f.type = f.type || 'number'; inputsSec.appendChild(mkRow(f)); });
    } else {
      const empty = document.createElement('div'); empty.className = 'sf-empty'; empty.textContent = 'No input parameters';
      inputsSec.appendChild(empty);
    }
    const styleSec = document.createElement('div');
    const h2 = document.createElement('div'); h2.className = 'sf-sec-title'; h2.textContent = 'Style';
    styleSec.appendChild(h2);
    editDef.style.forEach(f => {
      if (f.type !== 'checkbox' && f.type !== 'select') {
        f.type = (typeof f.def === 'number') ? 'number' : 'color';
      }
      styleSec.appendChild(mkRow(f));
    });
    body.appendChild(inputsSec); body.appendChild(styleSec);
  }

  /* Apply a setting value live (as the user types) without closing the modal */
  function liveApplyInput(ctl) {
    const body = document.getElementById('indModalBody');
    const uid = parseInt(body.getAttribute('data-uid'), 10);
    const ind = indicators.find(i => i.uid === uid);
    if (!ind) return;
    const key = ctl.dataset.key;
    if (ctl.type === 'number') {
      const v = parseFloat(ctl.value);
      ind.settings[key] = isNaN(v) ? 0 : v;
    } else if (ctl.type === 'checkbox') {
      ind.settings[key] = ctl.checked;
    } else {
      ind.settings[key] = ctl.value;
    }
    if (chart) setData();
    stateChange();
  }

  function applySettings() {
    const body = document.getElementById('indModalBody');
    const uid = parseInt(body.getAttribute('data-uid'), 10);
    const ind = indicators.find(i => i.uid === uid);
    if (!ind) return;
    body.querySelectorAll('[data-key]').forEach(ctl => {
      const key = ctl.dataset.key;
      if (ctl.type === 'number') {
        const v = parseFloat(ctl.value);
        ind.settings[key] = isNaN(v) ? 0 : v;
      } else if (ctl.type === 'checkbox') {
        ind.settings[key] = ctl.checked;
      } else if (ctl.type === 'color') {
        ind.settings[key] = ctl.value;
      } else {
        ind.settings[key] = ctl.value;
      }
    });
    if (chart) rebuild(); else updateLegend();
    closeModal();
    stateChange();
  }

  function resetSettings() {
    const body = document.getElementById('indModalBody');
    const uid = parseInt(body.getAttribute('data-uid'), 10);
    const ind = indicators.find(i => i.uid === uid);
    if (!ind) return;
    ind.settings = defaultsFor(ind.def);
    renderSettingsForm(ind.settings);
    if (chart) setData();
    stateChange();
  }

  /* ---------------- realtime ---------------- */
  function startRealtime() {
    if (!realtimeOn || !fetchFn) return;
    stopRealtime();
    realtimeTimer = setInterval(async () => {
      try {
        /* Capture which chart symbol this poll is fetching for and drop the
           result if the user switched symbols/timeframe while it was in flight
           - otherwise a slow poll response could overwrite a freshly opened
           premium/sidebar chart with the previous symbol's candles. */
        const k = (typeof window.currentChartSymKey === 'function') ? window.currentChartSymKey() : '';
        const d = await fetchFn();
        if (!d || d.status !== 'success' || !d.data || !d.data.length) return;
        if (k !== ((typeof window.currentChartSymKey === 'function') ? window.currentChartSymKey() : '')) return;
        const last = candles[candles.length - 1];
        const nlast = d.data[d.data.length - 1];
        const changed = !last || !nlast ||
          last.time !== nlast.time ||
          last.open !== nlast.open ||
          last.high !== nlast.high ||
          last.low !== nlast.low ||
          last.close !== nlast.close ||
          last.volume !== nlast.volume;
        if (changed) {
          candles = d.data;
          Ind.curSymKey = k;
          setData();
          followLatest();
        }
      } catch (e) {}
    }, realtimeInterval);
  }
  function stopRealtime() { if (realtimeTimer) { clearInterval(realtimeTimer); realtimeTimer = null; } }
  function setRealtimeOn(on) { realtimeOn = on; on ? startRealtime() : stopRealtime(); }
  function setRealtimeInterval(ms) { realtimeInterval = ms; if (realtimeOn) startRealtime(); }

  /* ---------------- public API ---------------- */
  const Ind = window.IndChart = {
    /* Identity of the symbol + timeframe whose candles are CURRENTLY in the
       chart. Written on every setCandles(); the tick-patch callers compare this
       to the selected chart symbol so a live quote can never stretch the candle
       data of a DIFFERENT instrument (opening a premium option chart or a new
       sidebar symbol reused the same chart instance - while the new history is
       still loading the old symbol's candles stayed on screen and got patched
       with the new symbol's price, drawing one giant "long forming bar" that
       only a page reload cleared). */
    curSymKey: '',
    setSymbolKey(key) { this.curSymKey = key || ''; },
    init(container, fetchCandles) {
      cw = container; fetchFn = fetchCandles;
      /* Track active dragging/panning so the realtime poll never yanks the view */
      cw.addEventListener('pointerdown', () => { userPanning = true; });
      window.addEventListener('pointerup', () => { userPanning = false; });
      window.addEventListener('pointercancel', () => { userPanning = false; });
      cw.addEventListener('pointerleave', () => { userPanning = false; });
      document.getElementById('rtToggle').checked = true;
      setRealtimeOn(true);
    },
    setLoading(text) {
      const cont = cw || document.getElementById('chart-container');
      if (chart) return; /* don't wipe a live chart */
      if (cont) cont.innerHTML = '<div id="loading">' + (text || 'Loading...') + '</div>';
    },
    setCandles(data, fit) {
      candles = data || [];
      try { this.curSymKey = (typeof window.currentChartSymKey === 'function') ? window.currentChartSymKey() : ''; } catch (e) { this.curSymKey = ''; }
      /* The chart instance is reused across symbol changes (premium option
         chart opens via the OC chain icons, symbol switches, refresh) - only
         the candle DATA is swapped, the series persist. Purge every overlay the
         PREVIOUS symbol left behind on the main/volume series (trade-level price
         lines whose titles carry the old option's name, indicator price lines,
         markers) and drop the trade-line registry, so no earlier closed premium
         chart's labels survive on the newly opened one. setData() re-applies the
         current symbol's indicator lines and syncTradeChartLines re-adds its
         open-position levels on the next tick. */
      try {
        if (candleSeries && candleSeries.priceLines) {
          candleSeries.priceLines().forEach(pl => { try { candleSeries.removePriceLine(pl); } catch (e) {} });
        }
        if (candleSeries && candleSeries.setMarkers) candleSeries.setMarkers([]);
        if (volSeries && volSeries.priceLines) {
          volSeries.priceLines().forEach(pl => { try { volSeries.removePriceLine(pl); } catch (e) {} });
        }
      } catch (e) {}
      this._tradeLines = {};
      this._ocLines = {};
      this.clearDirOverlay();
      setData();
      if (fit && chart) fitToRecent();
      if (realtimeOn) startRealtime();
    },
    resize() { resizeAll(); },
    hasChart() { return !!chart; },
    getLastBarTime() { return candles.length ? candles[candles.length - 1].time : 0; },
    /* Tick-by-tick in-place candle BUILDER. Called from the WebSocket push
       with the live LTP. Two jobs:
         1. Same bar window  -> stretch the current candle's high/low/close.
         2. New bar window   -> immediately OPEN a fresh candle from this tick
            (open=high=low=close=ltp) instead of waiting for the 1s REST poll,
            which is what caused the visible 1-2s chart lag vs Dhan.
       Only ticks in the current IST wall-clock window are applied, so a just-
       closed bar never gets a fake wick and stale ticks are ignored. */
    patchLastBar(ltp, tf, serverAt) {
      if (!chart || !candles.length || !(ltp > 0)) return;
      /* Candle times are IST wall-clock encoded as naive UTC, so compare
         against IST "now" regardless of the browser's timezone. Prefer the
         server's timestamp (the quote's `at` field, Unix epoch) so a drifted
         browser clock can never delay the opening of a new bar; fall back to
         the browser clock only when the server time is unavailable. */
      const IST_OFF = 5.5 * 3600 * 1000;
      const now = (typeof serverAt === 'number' && serverAt > 0)
        ? Math.floor(serverAt + IST_OFF / 1000)
        : Math.floor((Date.now() + IST_OFF) / 1000);
      const TF_SECS = { '1min':60,'2min':120,'3min':180,'4min':240,'5min':300,
        '10min':600,'15min':900,'30min':1800,'1hour':3600,'4hour':14400 };
      const secs = TF_SECS[tf];
      let barStart = null;
      if (secs) {
        barStart = now - (now % secs);
      } else if (tf === 'day') {
        const d = new Date(Date.now() + IST_OFF);
        barStart = Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);
      } else {
        return; /* week/month/year handled by the slow sync poll */
      }
      if (barStart == null) return;
      const last = candles[candles.length - 1];
      /* Price-sanity guard: a single out-of-range live tick (decimal/scale
         glitch, wrong-instrument price) used to stretch the forming candle's
         high/low, blowing out the shared right price scale's autoscale — every
         normal candle + overlay line got compressed into an invisible sliver
         while the volume series (own 'vol' scale) stayed visible, and only a
         page reload recovered. Reject ticks that are not within a generous
         multiple of the last closed bar's price. */
      const refClose = candles.length >= 2 ? candles[candles.length - 2].close : (last && last.open > 0 ? last.open : 0);
      if (!(refClose > 0) || !(ltp > refClose / 50) || !(ltp < refClose * 50)) return;
      if (last.time === barStart) {
        /* Same bar: stretch high/low/close from the live tick. */
        if (ltp > last.high) last.high = ltp;
        if (ltp < last.low) last.low = ltp;
        last.close = ltp;
        try {
          candleSeries.update({ time: last.time, open: last.open, high: last.high, low: last.low, close: last.close });
          updateLegend();
        } catch (e) {}
      } else if (last.time < barStart) {
        /* New bar window started: build a fresh candle instantly from this tick.
           Only build the immediate next window so a large gap (market closed /
           symbol switch) is not faked into a wick; the slow poll backfills. */
        if (secs && barStart - last.time > secs) return;
        candles.push({ time: barStart, open: ltp, high: ltp, low: ltp, close: ltp, volume: 0 });
        try {
          candleSeries.update({ time: barStart, open: ltp, high: ltp, low: ltp, close: ltp });
          if (volSeries) volSeries.update({ time: barStart, value: 0, color: ltp >= last.close ? '#00d4aa40' : '#ff525240' });
          followLatest();
          updateLegend();
        } catch (e) {}
      }
      /* last.time > barStart: stale tick, ignore. */
    },
    getCandlePnL(prevClose) {
      if(!candles.length) return null;
      const last = candles[candles.length - 1];
      const ltp = last.close;
      const pc = prevClose || (candles.length > 1 ? candles[candles.length - 2].close : ltp);
      const change = ltp - pc;
      const pct = pc ? (change / pc * 100) : 0;
      return { ltp, change, close: pc, change_pct: pct };
    },
    getIndicators() { return indicators.map(i => ({ id: i.def.id, settings: i.settings })); },
    restoreIndicators(list) {
      indicators = [];
      (list || []).forEach(it => {
        const def = IND[it.id];
        if (!def) return;
        indicators.push({ uid: uidCounter++, def, settings: Object.assign(defaultsFor(def), it.settings || {}), _series: null });
      });
      if (chart) rebuild(); else updateLegend();
      stateChange();
    },
    addIndicator,
    /* Programmatically set the settings of a deployed indicator instance by its
       indicator id (first instance). Used by the strategy engine so the chart
       renders EXACTLY the settings the strategy's conditions evaluate with —
       chart line and engine read then always agree (renderedLastTwo matches). */
    setIndicatorSettings(id, settings) {
      const ind = indicators.find(i => i.def.id === id);
      if (!ind) return;
      const next = Object.assign({}, ind.settings, settings || {});
      if (JSON.stringify(next) !== JSON.stringify(ind.settings)) {
        ind.settings = next;
        ind._series = null;
        if (chart) rebuild(); else updateLegend();
        stateChange();
      }
    },
    removeIndicator,
    removeAll,
    /* Remove every deployed instance whose def id matches (used by the AI Brain
       ui tool so it can drop e.g. all EMA overlays without knowing uids). */
    removeAllOf(id) {
      const ids = indicators.filter(i => i.def.id === id).map(i => i.uid);
      ids.forEach(u => removeIndicator(u));
      return ids.length;
    },
    openSettings,
    closeModal,
    applySettings,
    resetSettings,
    toggleMenu() {
      const m = document.getElementById('indMenu');
      m.classList.toggle('hidden');
      if (!m.classList.contains('hidden')) renderMenu(document.getElementById('indSearch').value);
    },
    closeMenu() {
      document.getElementById('indMenu').classList.add('hidden');
    },
    search(q) { renderMenu(q); },
    setRealtimeOn,
    setRealtimeInterval,
    isDeployed,
    renderMenu,
    fmtCompact,
    fmtReading,
    IND,
    IND_LIST,
    getCandles() { return candles; },
    /* Trading-level overlay price lines (entry / SL / trailing-SL / TP /
       trailing-TP) drawn directly on the candle series. The caller (dashboard
       render loop) supplies the current levels for every open auto/manual
       position each throttle cycle; we diff against the previous set so only
       changed levels are re-drawn and closed positions' lines disappear. */
    _tradeLines: {},
    setTradeLines(lines) {
      const next = {};
      for (const id in lines) {
        const lvl = lines[id];
        if (!lvl || !(lvl.price > 0)) continue;
        const same = this._tradeLines[id];
        if (same && Math.abs(same.price - lvl.price) < 0.0000001 && same.color === lvl.color && same.title === lvl.title) {
          next[id] = same;
          continue;
        }
        try {
          if (same) candleSeries.removePriceLine(same.line);
        } catch (e) {}
        try {
          const line = candleSeries.createPriceLine({
            price: lvl.price,
            color: lvl.color || '#f0c000',
            lineWidth: 1,
            lineStyle: lvl.style != null ? lvl.style : 2,
            axisLabelVisible: true,
            title: lvl.title || ''
          });
          next[id] = { price: lvl.price, color: lvl.color || '#f0c000', title: lvl.title || '', line };
        } catch (e) {}
      }
      for (const id in this._tradeLines) {
        if (!(id in next)) {
          try { candleSeries.removePriceLine(this._tradeLines[id].line); } catch (e) {}
        }
      }
      this._tradeLines = next;
    },
    clearTradeLines() {
      for (const id in this._tradeLines) {
        try { candleSeries.removePriceLine(this._tradeLines[id].line); } catch (e) {}
      }
      this._tradeLines = {};
    },
    /* ---- OI Trend / Levels overlay support (owned by static/oitrend.js) ----
       Same price-line diffing pattern as setTradeLines but on its own registry
       so the trading-level lines and the option-chain level lines never wipe
       each other on the shared candle series. */
    _ocLines: {},
    setOcLevelLines(lines) {
      if (!candleSeries) return;
      const next = {};
      for (const id in lines) {
        const lvl = lines[id];
        if (!lvl || !(lvl.price > 0)) continue;
        const same = this._ocLines[id];
        if (same && Math.abs(same.price - lvl.price) < 0.0000001 && same.color === lvl.color && same.title === lvl.title && same.style === lvl.style) {
          next[id] = same;
          continue;
        }
        try {
          if (same) candleSeries.removePriceLine(same.line);
        } catch (e) {}
        try {
          const line = candleSeries.createPriceLine({
            price: lvl.price,
            color: lvl.color || '#f0c000',
            lineWidth: lvl.lineWidth != null ? lvl.lineWidth : 1,
            lineStyle: lvl.style != null ? lvl.style : 2,
            axisLabelVisible: true,
            title: lvl.title || ''
          });
          next[id] = { price: lvl.price, color: lvl.color || '#f0c000', title: lvl.title || '', style: lvl.style != null ? lvl.style : 2, line };
        } catch (e) {}
      }
      for (const id in this._ocLines) {
        if (!(id in next)) {
          try { candleSeries.removePriceLine(this._ocLines[id].line); } catch (e) {}
        }
      }
      this._ocLines = next;
    },
    clearOcLevelLines() {
      for (const id in this._ocLines) {
        try { candleSeries.removePriceLine(this._ocLines[id].line); } catch (e) {}
      }
      this._ocLines = {};
    },
    /* Dedicated EMA-like direction-state line series (created lazily on the
       main chart). It is recreated whenever a rebuild nulls dirSeries, so the
       caller just re-pushes data each cycle and it self-heals. */
    setDirSeries(data, opts) {
      if (!chart || !candleSeries) return;
      if (!data || !data.length) { this.clearDirOverlay(); return; }
      try {
        if (!dirSeries) {
          dirSeries = chart.addSeries(LightweightCharts.LineSeries, {
            color: (opts && opts.color) || '#22e08a',
            lineWidth: (opts && opts.lineWidth) || 2,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false
          });
        }
        if (opts && opts.color) dirSeries.applyOptions({ color: opts.color });
        if (opts && opts.lineWidth) dirSeries.applyOptions({ lineWidth: opts.lineWidth });
        dirSeries.setData(data);
      } catch (e) {}
    },
    setDirMarkers(mk) {
      if (!dirSeries) return;
      try { dirSeries.setMarkers(mk || []); } catch (e) {}
    },
    /* Trend arrows + labels anchored to the ACTUAL candle bars (the main
       candle series) so they are always visible next to the candles instead of
       being drawn on the thin EMA state line where they were easy to miss /
       clipped at the right edge. Nothing else sets markers on the candle
       series, so this owns them and rebuilds clear them via clearDirOverlay. */
    setCandleMarkers(mk) {
      try { if (candleSeries && candleSeries.setMarkers) candleSeries.setMarkers(mk || []); } catch (e) {}
    },
    clearDirOverlay() {
      try { if (candleSeries && candleSeries.setMarkers) candleSeries.setMarkers([]); } catch (e) {}
      try {
        if (dirSeries) {
          if (chart && chart.removeSeries) chart.removeSeries(dirSeries);
          else if (dirSeries.remove) dirSeries.remove();
        }
      } catch (e) {}
      dirSeries = null;
    },
    getDeployedIndicators() {
      return indicators.map(i => ({
        uid: i.uid,
        id: i.def.id,
        name: i.def.name,
        format: i.def.format,
        settings: JSON.parse(JSON.stringify(i.settings || {})),
        valueOptions: valueOptionsFor(i.def.id)
      }));
    },
    valueOptionsFor,
    computeValue,
    computeLastTwo,
    renderedLastTwo
  };

  /* ---------------- candlestick pattern detection engine ---------------- */
  window.CandlePatterns = (function () {
    function body(c) { return Math.abs(c.close - c.open); }
    function upperWick(c) { return c.high - Math.max(c.close, c.open); }
    function lowerWick(c) { return Math.min(c.close, c.open) - c.low; }
    function totalRange(c) { return c.high - c.low; }
    function isGreen(c) { return c.close > c.open; }
    function isRed(c) { return c.close < c.open; }
    function isDoji(c, ratio) { const b = body(c); return b <= totalRange(c) * (ratio || 0.1); }
    function mid(c) { return (c.open + c.close) / 2; }

    const PATTERNS = {
      bullish_engulfing: {
        name: 'Bullish Engulfing', bars: 2, direction: 'bullish', type: 'reversal', winRate: 63,
        detect: c => {
          if (c.length < 2) return false;
          const p = c[c.length - 2], cur = c[c.length - 1];
          if (!isRed(p) || !isGreen(cur)) return false;
          return cur.open <= p.close && cur.close >= p.open && body(cur) > body(p);
        }
      },
      hammer: {
        name: 'Hammer', bars: 1, direction: 'bullish', type: 'reversal', winRate: 60,
        detect: c => {
          if (c.length < 1) return false;
          const cur = c[c.length - 1];
          const b = body(cur), lw = lowerWick(cur), uw = upperWick(cur);
          if (b <= 0 || totalRange(cur) <= 0) return false;
          return lw >= b * 2 && uw <= b * 0.5;
        }
      },
      inverted_hammer: {
        name: 'Inverted Hammer', bars: 1, direction: 'bullish', type: 'reversal', winRate: 57,
        detect: c => {
          if (c.length < 1) return false;
          const cur = c[c.length - 1];
          const b = body(cur), uw = upperWick(cur), lw = lowerWick(cur);
          if (b <= 0 || totalRange(cur) <= 0) return false;
          return uw >= b * 2 && lw <= b * 0.5;
        }
      },
      morning_star: {
        name: 'Morning Star', bars: 3, direction: 'bullish', type: 'reversal', winRate: 78,
        detect: c => {
          if (c.length < 3) return false;
          const a = c[c.length - 3], b = c[c.length - 2], cur = c[c.length - 1];
          if (!isRed(a) || !isGreen(cur)) return false;
          const bBody = body(b);
          if (bBody > body(a) * 0.5) return false;
          return b.high < a.close && b.high < cur.open && cur.close > mid(a);
        }
      },
      piercing_line: {
        name: 'Piercing Line', bars: 2, direction: 'bullish', type: 'reversal', winRate: 64,
        detect: c => {
          if (c.length < 2) return false;
          const p = c[c.length - 2], cur = c[c.length - 1];
          if (!isRed(p) || !isGreen(cur)) return false;
          return cur.open < p.low && cur.close > mid(p) && cur.close < p.open;
        }
      },
      three_white_soldiers: {
        name: 'Three White Soldiers', bars: 3, direction: 'bullish', type: 'continuation', winRate: 72,
        detect: c => {
          if (c.length < 3) return false;
          const a = c[c.length - 3], b = c[c.length - 2], cur = c[c.length - 1];
          if (!isGreen(a) || !isGreen(b) || !isGreen(cur)) return false;
          if (a.close <= a.open || b.close <= b.open || cur.close <= cur.open) return false;
          if (cur.close <= b.close || b.close <= a.close) return false;
          if (upperWick(cur) > body(cur) * 0.3) return false;
          if (upperWick(b) > body(b) * 0.3) return false;
          return cur.open >= b.open && cur.open <= b.close && b.open >= a.open && b.open <= a.close;
        }
      },
      bullish_harami: {
        name: 'Bullish Harami', bars: 2, direction: 'bullish', type: 'reversal', winRate: 57,
        detect: c => {
          if (c.length < 2) return false;
          const p = c[c.length - 2], cur = c[c.length - 1];
          if (!isRed(p) || !isGreen(cur)) return false;
          if (body(p) <= 0) return false;
          return cur.open > p.close && cur.close < p.open && body(cur) < body(p) * 0.6;
        }
      },
      rising_three_methods: {
        name: 'Rising Three Methods', bars: 5, direction: 'bullish', type: 'continuation', winRate: 77,
        detect: c => {
          if (c.length < 5) return false;
          const first = c[c.length - 5], last = c[c.length - 1];
          if (!isGreen(first) || !isGreen(last)) return false;
          if (last.close <= first.close) return false;
          for (let i = 3; i >= 1; i--) {
            if (!isRed(c[c.length - 1 - i])) return false;
            if (c[c.length - 1 - i].high > first.high || c[c.length - 1 - i].low < first.low) return false;
          }
          return last.close > first.high;
        }
      },

      bearish_engulfing: {
        name: 'Bearish Engulfing', bars: 2, direction: 'bearish', type: 'reversal', winRate: 61,
        detect: c => {
          if (c.length < 2) return false;
          const p = c[c.length - 2], cur = c[c.length - 1];
          if (!isGreen(p) || !isRed(cur)) return false;
          return cur.open >= p.close && cur.close <= p.open && body(cur) > body(p);
        }
      },
      shooting_star: {
        name: 'Shooting Star', bars: 1, direction: 'bearish', type: 'reversal', winRate: 59,
        detect: c => {
          if (c.length < 1) return false;
          const cur = c[c.length - 1];
          const b = body(cur), uw = upperWick(cur), lw = lowerWick(cur);
          if (b <= 0 || totalRange(cur) <= 0) return false;
          return uw >= b * 2 && lw <= b * 0.5;
        }
      },
      hanging_man: {
        name: 'Hanging Man', bars: 1, direction: 'bearish', type: 'reversal', winRate: 51,
        detect: c => {
          if (c.length < 1) return false;
          const cur = c[c.length - 1];
          const b = body(cur), lw = lowerWick(cur), uw = upperWick(cur);
          if (b <= 0 || totalRange(cur) <= 0) return false;
          return lw >= b * 2 && uw <= b * 0.5 && isGreen(cur);
        }
      },
      evening_star: {
        name: 'Evening Star', bars: 3, direction: 'bearish', type: 'reversal', winRate: 72,
        detect: c => {
          if (c.length < 3) return false;
          const a = c[c.length - 3], b = c[c.length - 2], cur = c[c.length - 1];
          if (!isGreen(a) || !isRed(cur)) return false;
          const bBody = body(b);
          if (bBody > body(a) * 0.5) return false;
          return b.low > a.close && b.low > cur.open && cur.close < mid(a);
        }
      },
      dark_cloud_cover: {
        name: 'Dark Cloud Cover', bars: 2, direction: 'bearish', type: 'reversal', winRate: 60,
        detect: c => {
          if (c.length < 2) return false;
          const p = c[c.length - 2], cur = c[c.length - 1];
          if (!isGreen(p) || !isRed(cur)) return false;
          return cur.open > p.high && cur.close < mid(p) && cur.close > p.open;
        }
      },
      three_black_crows: {
        name: 'Three Black Crows', bars: 3, direction: 'bearish', type: 'continuation', winRate: 68,
        detect: c => {
          if (c.length < 3) return false;
          const a = c[c.length - 3], b = c[c.length - 2], cur = c[c.length - 1];
          if (!isRed(a) || !isRed(b) || !isRed(cur)) return false;
          if (a.close >= a.open || b.close >= b.open || cur.close >= cur.open) return false;
          if (cur.close >= b.close || b.close >= a.close) return false;
          if (lowerWick(cur) > body(cur) * 0.3) return false;
          if (lowerWick(b) > body(b) * 0.3) return false;
          return cur.open <= b.open && cur.open >= b.close && b.open <= a.open && b.open >= a.close;
        }
      },
      bearish_harami: {
        name: 'Bearish Harami', bars: 2, direction: 'bearish', type: 'reversal', winRate: 53,
        detect: c => {
          if (c.length < 2) return false;
          const p = c[c.length - 2], cur = c[c.length - 1];
          if (!isGreen(p) || !isRed(cur)) return false;
          if (body(p) <= 0) return false;
          return cur.open < p.close && cur.close > p.open && body(cur) < body(p) * 0.6;
        }
      },
      falling_three_methods: {
        name: 'Falling Three Methods', bars: 5, direction: 'bearish', type: 'continuation', winRate: 74,
        detect: c => {
          if (c.length < 5) return false;
          const first = c[c.length - 5], last = c[c.length - 1];
          if (!isRed(first) || !isRed(last)) return false;
          if (last.close >= first.close) return false;
          for (let i = 3; i >= 1; i--) {
            if (!isGreen(c[c.length - 1 - i])) return false;
            if (c[c.length - 1 - i].high > first.high || c[c.length - 1 - i].low < first.low) return false;
          }
          return last.close < first.low;
        }
      },
      doji_bullish: {
        name: 'Doji (Bullish Confirm)', bars: 1, direction: 'bullish', type: 'continuation', winRate: 65,
        detect: c => {
          if (c.length < 2) return false;
          const cur = c[c.length - 1], p = c[c.length - 2];
          if (!isDoji(cur, 0.1)) return false;
          return isGreen(p) && cur.close >= p.close;
        }
      },
      doji_bearish: {
        name: 'Doji (Bearish Confirm)', bars: 1, direction: 'bearish', type: 'continuation', winRate: 65,
        detect: c => {
          if (c.length < 2) return false;
          const cur = c[c.length - 1], p = c[c.length - 2];
          if (!isDoji(cur, 0.1)) return false;
          return isRed(p) && cur.close <= p.close;
        }
      },
      tweezers_top: {
        name: 'Tweezer Top', bars: 2, direction: 'bearish', type: 'reversal', winRate: 58,
        detect: c => {
          if (c.length < 2) return false;
          const p = c[c.length - 2], cur = c[c.length - 1];
          const topDiff = Math.abs(p.high - cur.high);
          const avgRange = (totalRange(p) + totalRange(cur)) / 2;
          return topDiff <= avgRange * 0.05 && isGreen(p) && isRed(cur);
        }
      },
      tweezers_bottom: {
        name: 'Tweezer Bottom', bars: 2, direction: 'bullish', type: 'reversal', winRate: 58,
        detect: c => {
          if (c.length < 2) return false;
          const p = c[c.length - 2], cur = c[c.length - 1];
          const botDiff = Math.abs(p.low - cur.low);
          const avgRange = (totalRange(p) + totalRange(cur)) / 2;
          return botDiff <= avgRange * 0.05 && isRed(p) && isGreen(cur);
        }
      },
      long_legged_doji: {
        name: 'Long-legged Doji', bars: 1, direction: 'neutral', type: 'consolidation', winRate: 55,
        detect: c => {
          if (c.length < 1) return false;
          const cur = c[c.length - 1];
          const b = body(cur), uw = upperWick(cur), lw = lowerWick(cur);
          if (totalRange(cur) <= 0) return false;
          return isDoji(cur, 0.1) && uw >= b * 1.5 && lw >= b * 1.5;
        }
      },
      spinning_top: {
        name: 'Spinning Top', bars: 1, direction: 'neutral', type: 'consolidation', winRate: 52,
        detect: c => {
          if (c.length < 1) return false;
          const cur = c[c.length - 1];
          const b = body(cur), uw = upperWick(cur), lw = lowerWick(cur), tr = totalRange(cur);
          if (tr <= 0) return false;
          return b <= tr * 0.3 && uw >= b * 0.8 && lw >= b * 0.8;
        }
      },
      inside_bar: {
        name: 'Inside Bar (Harami)', bars: 2, direction: 'neutral', type: 'consolidation', winRate: 53,
        detect: c => {
          if (c.length < 2) return false;
          const p = c[c.length - 2], cur = c[c.length - 1];
          return cur.high <= p.high && cur.low >= p.low;
        }
      },
      narrow_range: {
        name: 'Narrow Range (NR4/NR7)', bars: 3, direction: 'neutral', type: 'consolidation', winRate: 57,
        detect: c => {
          if (c.length < 3) return false;
          const cur = c[c.length - 1];
          const cr = totalRange(cur);
          if (cr <= 0) return false;
          let isNarrowest = true;
          for (let i = 2; i <= Math.min(4, c.length - 1); i++) {
            if (totalRange(c[c.length - i]) < cr) { isNarrowest = false; break; }
          }
          return isNarrowest;
        }
      },
      stop_hunt_below: {
        name: 'Stop Hunt (Liquidity Grab Below)', bars: 1, direction: 'bullish', type: 'liquidity', winRate: 60,
        detect: c => {
          if (c.length < 2) return false;
          const cur = c[c.length - 1], p = c[c.length - 2];
          const lw = lowerWick(cur), b = body(cur);
          if (b <= 0 || totalRange(cur) <= 0) return false;
          return cur.low < p.low && lw >= b * 2 && cur.close > cur.open;
        }
      },
      stop_hunt_above: {
        name: 'Stop Hunt (Liquidity Grab Above)', bars: 1, direction: 'bearish', type: 'liquidity', winRate: 60,
        detect: c => {
          if (c.length < 2) return false;
          const cur = c[c.length - 1], p = c[c.length - 2];
          const uw = upperWick(cur), b = body(cur);
          if (b <= 0 || totalRange(cur) <= 0) return false;
          return cur.high > p.high && uw >= b * 2 && cur.close < cur.open;
        }
      },
      false_breakout: {
        name: 'False Breakout', bars: 2, direction: 'neutral', type: 'liquidity', winRate: 55,
        detect: c => {
          if (c.length < 2) return false;
          const p = c[c.length - 2], cur = c[c.length - 1];
          const pRange = totalRange(p);
          if (pRange <= 0) return false;
          const brokeUp = cur.high > p.high && cur.close < p.high;
          const brokeDown = cur.low < p.low && cur.close > p.low;
          return brokeUp || brokeDown;
        }
      }
    };

    function detect(key, candles) {
      const p = PATTERNS[key];
      if (!p || !candles || candles.length < p.bars) return false;
      try { return p.detect(candles); } catch (e) { return false; }
    }

    function detectAny(keys, candles) {
      for (const k of keys) if (detect(k, candles)) return k;
      return null;
    }

    return { PATTERNS, detect, detectAny };
  })();
})();
