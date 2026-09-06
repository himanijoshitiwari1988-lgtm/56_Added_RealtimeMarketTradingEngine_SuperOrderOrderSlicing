# Backup: 44_Added_14NewIndicater_Added_NewIndicaterFilterBasedOnBehaviour

Complete snapshot backup of the project (working directory
`repo_preview`, full history continuing from the `43_Added_vLindicatorFilter`
backup commit `b61f17e`) pushed to
`himanijoshitiwari1988-lgtm/44_Added_14NewIndicater_Added_NewIndicaterFilterBasedOnBehaviour`
(branch `main`).

## Contents

- **Complete project files** — the full committed working tree as of the
  14-new-indicators + behaviour-based indicator filter milestone commit (HEAD),
  including:
  - `app.py`, `main.py`, `broker.py`, `charts.py`, `data_fetcher.py`, `requirements.txt`
  - `.env.example` (config template - the real `.env` with any key is never
    tracked or shipped)
  - `static/` (algosbrain.js, aismart.js, smart_ntrader.js,
    autoexperiment*.js, oitrend.js, trendconfirm.js, tradestats.js,
    niftybbp_alert.js, chart_grid.js, aipt.js, fast_live.js, indicators.js,
    vlcore.js, papertrade.js, paperrun.js, paperstrategies.js, strategies.js, ...)
  - `templates/index.html`
  - `CHANGELOG.md`, `HANDOFF.md`, `SESSION.md`
- **CHANGES_COMPLETE.patch** — the complete unified diff of every change between
  the previous backup commit `b61f17e` and the current working tree (HEAD
  `b61f17e` + the 14-new-indicators + behaviour-based filter milestone),
  generated with `git diff b61f17e`, excluding the regenerated doc files
  themselves.
- **CHANGES_SUMMARY.txt** — `git diff --stat` plus `--name-status` of the same,
  with a plain-language change description.

## Modified files (in CHANGES_COMPLETE.patch)

```
 static/aismart.js            | 152 ++++++++++++++++--
 static/autoexperiment.v13.js | 149 ++++++++++++++++--
 static/indicators.js         | 554 +++++++++++++++++++++++++++++++++++++++++-
 static/strategies.js         |   2 +
 static/vlcore.js             | 616 +++++++++++++++++++++++++++++++++++++++++++
 templates/index.html         | 225 ++++++++++++++++++----
 6 files changed, 1655 insertions(+), 43 deletions(-)
```

This backup includes (highlights of `b61f17e..HEAD`):

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
