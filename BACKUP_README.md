# Backup: 45_Added_PaneIndicaterRisingUpward_RisingStrikeLTPpickUp

Complete snapshot backup of the project (working directory
`repo_preview`, full history continuing from the `44_Added_14NewIndicater_Added_NewIndicaterFilterBasedOnBehaviour`
backup commit `a152c03`) pushed to
`himanijoshitiwari1988-lgtm/45_Added_PaneIndicaterRisingUpward_RisingStrikeLTPpickUp`
(branch `main`).

## Latest layer (2026-09-06) — rising-upward pane-indicator filters + Multi-Line Momentum Gap level gates + Rising Strike LTP pick-up

Incremental layer on top of commit `a152c03` (5 files, +860/-59):

- **Pane Indicator Behaviour rising-upward / rising-downward rows** wired into
  AI Smart + Auto Experiment bullish/bearish filter panels and both engines'
  filter key sets/summaries.
- **Multi-Line Momentum Gap (PBG) level gates** — 12 pane indicators (MACD,
  PPO, SMI, TSI, Stoch RSI, SMF, RSI, OBV, Fisher, Aroon, Vortex,
  ADX +DI/-DI pair) evaluated as a main-line vs signal-line level-hold gate
  (`cmpType:'self'`), plus the SMI (smiio) special case where the filter is the
  OR of two bullish variants the user specified, expressed against the
  Histogram series (`cond.pair='v2'`): base = SMI & Signal both above the
  Histogram line, variant-1 = both rising and pulling away from the histogram,
  variant-2 = both rising and the histogram rising (bearish = exact mirror).
- **Fastest positive rising strike LTP pick-up** — `astFastestRising` /
  `aeFastestRising` toggles + `astFastestCount` / `aeFastestCount` (default 3)
  in both panels; AE persistence lists updated in `static/aecontrols.js`.
- **`static/indicators.js`** — new connected Supply/Demand structure overlay
  (continuous dense polyline + live edge + equal-length forecast), RSI Signal
  EMA (default len 9, fixed 2-slot output), chart renderer hardening
  (error-surfacing badge, guarded per-series creation, dashed lineStyle
  passthrough).
- **`templates/index.html`** — cache-bust bumps `indicators.js?v=64 -> v=70`,
  `autoexperiment.v13.js?v=146 -> v=152`, `aismart.js?v=158 -> v=164`.

Patch diff for this layer: `CHANGES_COMPLETE.patch` /
`CHANGES_SUMMARY.txt` below cover `a152c03..current` (this window); the
full-project description that follows summarises the underlying milestone
snapshot the layer was added onto.

## Contents

- **Complete project files** — the full committed working tree as of the
  Pane-Indicator rising-upward + Multi-Line Momentum Gap level gates + Rising
  Strike LTP pick-up milestone (HEAD), including:
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
  incremental layer between the previous backup commit `a152c03` and the
  current working tree (HEAD) — pane-indicator rising filters, the PBG
  multi-line momentum-gap level gates (incl. the SMI OR-of-two histogram
  variant), the fastest-rising strike LTP pick-up, the indicators.js
  Supply/Demand overlay + RSI signal EMA + chart hardening, and the
  index.html cache-bust bumps — generated with `git diff a152c03`, excluding
  the regenerated doc files themselves.
- **CHANGES_SUMMARY.txt** — `git diff --stat` plus `--name-status` of the same,
  with a plain-language change description.

## Modified files (latest layer `a152c03..current`, in CHANGES_COMPLETE.patch)

```
 static/aecontrols.js         |   4 +-
 static/aismart.js            | 320 +++++++++++++++++++++++++++++++++++++++---
 static/autoexperiment.v13.js | 321 ++++++++++++++++++++++++++++++++++++++++---
 static/indicators.js         | 246 ++++++++++++++++++++++++++++++---
 templates/index.html         |  28 +++-
 5 files changed, 860 insertions(+), 59 deletions(-)
```

## Underlying snapshot (highlights of `b61f17e..a152c03`)

- **44_Added_14NewIndicater...** milestone — 14 new indicator definitions
  (Aroon, BBW, CCI, Chandelier Exit, CMF, Donchian, Elder Force Index, Fisher
  Transform, HMA, Ichimoku, Keltner, Squeeze Momentum, Stoch RSI, TSI) plus
  the Trend Core (vlcore) overlay engine and behaviour-based indicator filter
  rows in both engines, then the SMI Ergodic (smiio) TradingView-formula fix
  (close-to-close momentum change source).

## Previous backups

- `44_Added_14NewIndicater_Added_NewIndicaterFilterBasedOnBehaviour` (commit `a152c03`)
- `43_Added_vLindicatorFilter` (commit `b61f17e`)
- `42_Added_AiBrainAlgo` (commit `ac432ec`)
- `41_added_TradeStats_NiftyTrendFollowingFixed`
- `38_Added_DirectChartTradeExecution_For_IndicaterFilterMode_And_StrategyNormalMode`
- earlier backups `33algodhan`..`39algodhan`
