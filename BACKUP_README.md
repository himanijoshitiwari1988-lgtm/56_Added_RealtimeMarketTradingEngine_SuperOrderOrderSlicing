# Backup: 44_Added_14NewIndicater_Added_NewIndicaterFilterBasedOnBehaviour

Complete snapshot backup of the project (working directory
`repo_preview`, full history continuing from the `43_Added_vLindicatorFilter`
backup commit `b61f17e`) pushed to
`himanijoshitiwari1988-lgtm/44_Added_14NewIndicater_Added_NewIndicaterFilterBasedOnBehaviour`
(branch `main`).

## Latest layer (2026-09-06) — SMI Ergodic Oscillator (smiio) fix

Incremental fix on top of commit `3df65e4` (2 files, +7/-3):

- `static/indicators.js` `smiio.compute` now uses the official TradingView
  SMI Ergodic change source — close-to-close momentum
  `change = price - price[prev]`, `absChange = |close - close[prev]|` (was
  `close - (high+low)/2`, the current candle's midpoint) — before the same
  double-EMA chain (`EMA13` then `EMA25` on both change and absChange,
  `SMI = 100 * change/absChange`, `Signal = EMA9(SMI)`,
  `Histogram = SMI - Signal`). SMI/Signal crossovers and the histogram's sign
  vs the zero line now match TradingView on the same scrip/timeframe/settings.
- `templates/index.html` cache-bust bumped to `indicators.js?v=64`.

Patch diff for this layer: `CHANGES_COMPLETE.patch` /
`CHANGES_SUMMARY.txt` below cover `3df65e4..HEAD` (this fix window); the
full-project description that follows summarises the underlying `b61f17e..`
milestone snapshot the fix was layered onto.

## Contents

- **Complete project files** — the full committed working tree as of the
  14-new-indicators + behaviour-based indicator filter milestone + the SMI
  Ergodic (smiio) TradingView-formula fix (HEAD), including:
  - `app.py`, `main.py`, `broker.py`, `charts.py`, `data_fetcher.py`, `requirements.txt`
  - `.env.example` (config template - the real `.env` with any key is never
    tracked or shipped)
  - `static/` (algosbrain.js, aismart.js, smart_ntrader.js,
    autoexperiment*.js, oitrend.js, trendconfirm.js, tradestats.js,
    niftybbp_alert.js, chart_grid.js, aipt.js, fast_live.js, indicators.js,
    vlcore.js, papertrade.js, paperrun.js, paperstrategies.js, strategies.js, ...)
  - `templates/index.html`
  - `CHANGELOG.md`, `HANDOFF.md`, `SESSION.md`
- **CHANGES_COMPLETE.patch** — the complete unified diff of the latest
  incremental layer between the previous backup commit `3df65e4` and the
  current working tree (HEAD) — the SMI Ergodic `smiio` TradingView-formula fix
  (`static/indicators.js` + the `index.html` cache-bust bump), generated with
  `git diff 3df65e4`, excluding the regenerated doc files themselves.
- **CHANGES_SUMMARY.txt** — `git diff --stat` plus `--name-status` of the same,
  with a plain-language change description.

## Modified files (latest layer `3df65e4..HEAD`, in CHANGES_COMPLETE.patch)

```
 static/indicators.js | 8 ++++++--
 templates/index.html | 2 +-
 2 files changed, 7 insertions(+), 3 deletions(-)
```

## Underlying snapshot (highlights of `b61f17e..3df65e4`)

- **14 new indicator definitions added to `static/indicators.js`** — Aroon,
  Bollinger Band Width, CCI, Chandelier Exit, CMF, Donchian Channel, Elder
  Force Index, Fisher Transform, HMA, Ichimoku Cloud, Keltner Channels, Squeeze
  Momentum (TTM), Stoch RSI and TSI (plus the new Trend Core overlay engine,
  see below) registered with `IndChart.IND` / chart-deploy integration.
- **Behaviour-based indicator filter rows (AI Smart + Auto Experiment)** — new
  per-indicator filter checkboxes generated from each indicator's behaviour
  profile (Pane direction-mirror / strength / participation groups, overlay
  rising/falling + level rows) are added to BOTH engines' bullish and bearish
  filter panels in `templates/index.html`, matching each indicator's defined
  behaviour so the user can switch filters on without hand-writing conditions.
- **Trend Core (vlcore) overlay engine (`static/vlcore.js`, new)** — a separate
  `window.VLCore` trend-core engine used by the chart "Trend Core" overlay and
  by the AST/AE filter rows "Trend Core line increasing upward/downward" +
  "Close above/below Trend Core (level)", computed against the confirmed swing
  based trend core (straight-line trend with confirm window + volume
  confirmation).
- **strategies.js monitor exports** — `renderMonitorList` / `monitorTick`
  exposed for the monitor UI.

## Previous backups

- `43_Added_vLindicatorFilter` (commit `b61f17e`)
- `42_Added_AiBrainAlgo` (commit `ac432ec`)
- `41_added_TradeStats_NiftyTrendFollowingFixed`
- `38_Added_DirectChartTradeExecution_For_IndicaterFilterMode_And_StrategyNormalMode`
- earlier backups `33algodhan`..`39algodhan`
