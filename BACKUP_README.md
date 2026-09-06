# Backup: 46_Added_SupplyDemandOverlayFilterAnd_DirectChartEntryDecision

Complete snapshot backup of the project (working directory
`repo_preview`, full history continuing from the `45_Added_PaneIndicaterRisingUpward_RisingStrikeLTPpickUp`
backup commit `872b61b`) pushed to
`himanijoshitiwari1988-lgtm/46_Added_SupplyDemandOverlayFilterAnd_DirectChartEntryDecision`
(branch `main`).

## Latest layer (2026-09-06) — Supply Demand overlay filter rows + chart-direct entry decision

Incremental layer on top of commit `872b61b` (3 files, +35/-19):

- **Supply Demand overlay filter rows** wired into AI Smart + Auto Experiment:
  `OBR_LIST` (and its autoexperiment mirror) gains
  `{ tok:'SupplyDemand', id:'supplydemand', valueKey:'v0',
  settings:{atrPeriod:14, atrMult:2, minPct:0.15, eqTol:25}, name:'Supply Demand' }`,
  and the `obr` row array in `templates/index.html` injects the new row
  ("Supply Demand line increasing upward/downward"). `OBR_BULL_KEYS` /
  `OBR_BEAR_KEYS` pick the entry up automatically in both engines; the
  Supply/Demand structure series already ships from `static/indicators.js`
  (added in the previous layer). Cache-bump:
  `autoexperiment.v13.js?v=152 -> v=153`, `aismart.js?v=164 -> v=166`.
- **AST paper-poll entry decision now runs directly on the real-time chart
  candles only.** In the normal poll (`tickBody`) the option-chain
  execution-target resolution (`executionSymbolsFor` / `contractsFor`) and the
  REST quote/candle subscription (`ensureOptionQuotes`) no longer run before
  every per-instrument condition check. Both are deferred to just after a fresh
  signal fires (immediately before the order is placed), so a condition that
  meets on the live chart places the paper entry on the next poll without
  waiting on chain resolution / quote subscription. Open-position management
  for a strategy+instrument now reads the paper engine's own positions
  (`autoKey === key`) instead of iterating chain-derived trade targets, so even
  held trades no longer trigger a chain fetch per poll. The decision path for
  entries and the "waiting for signal" state perform zero chain / REST-quote
  work.

## Modified files (latest layer `872b61b..current`, in CHANGES_COMPLETE.patch)

```
 static/aismart.js            | 45 +++++++++++++++++++++++++++++---------------
 static/autoexperiment.v13.js |  3 ++-
 templates/index.html         |  6 +++---
 3 files changed, 35 insertions(+), 19 deletions(-)
```

Patch diff for this layer: `CHANGES_COMPLETE.patch` /
`CHANGES_SUMMARY.txt` below cover `872b61b..current` (this window).

## Contents

- **Complete project files** — the full committed working tree as of the
  Supply Demand overlay filter rows + chart-direct entry decision milestone
  (HEAD), including:
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
  incremental layer between the previous backup commit `872b61b` and the
  current working tree (HEAD) — the Supply Demand overlay filter rows in both
  engines + index.html, and the chart-direct entry decision reorder in
  `static/aismart.js` (no chain fetch / no REST quote subscription before the
  entry signal) — generated with `git diff 872b61b`, excluding the regenerated
  doc files themselves.
- **CHANGES_SUMMARY.txt** — `git diff --stat` plus `--name-status` of the same,
  with a plain-language change description.

## Underlying snapshot (highlights of `a152c03..872b61b`)

- **45_Added_PaneIndicaterRisingUpward...** milestone — Pane Indicator
  Behaviour rising-upward / rising-downward filter rows, the Multi-Line
  Momentum Gap (PBG) level gates for 12 pane indicators (incl. the SMI
  OR-of-two histogram variant), the fastest positive rising strike LTP pick-up
  toggles/count, plus the connected Supply/Demand structure overlay + RSI true
  Signal EMA + chart hardening in `static/indicators.js`.

## Previous backups

- `45_Added_PaneIndicaterRisingUpward_RisingStrikeLTPpickUp` (commit `872b61b`)
- `44_Added_14NewIndicater_Added_NewIndicaterFilterBasedOnBehaviour` (commit `a152c03`)
- `43_Added_vLindicatorFilter` (commit `b61f17e`)
- `42_Added_AiBrainAlgo` (commit `ac432ec`)
- `41_added_TradeStats_NiftyTrendFollowingFixed`
- `38_Added_DirectChartTradeExecution_For_IndicaterFilterMode_And_StrategyNormalMode`
- earlier backups `33algodhan`..`39algodhan`
