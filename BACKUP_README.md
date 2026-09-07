# Backup: 49_Fixed_bb-b_TradeEntry_Active_Inactive

Complete snapshot backup of the project (working directory
`repo_preview`, full history continuing from the
`48_Added_TradeEntryPossibilityArmGate_FixedIndicatorFilterDirection` backup
commit `f0a3feb`) pushed to
`himanijoshitiwari1988-lgtm/49_Fixed_bb-b_TradeEntry_Active_Inactive`
(branch `main`).

## Latest layer (2026-09-07) — 15-min NIFTY TF for the BB%b feed + BB%b engine run window ACTIVE/INACTIVE

Incremental layer on top of commit `f0a3feb` (4 files, +307/-28):

- **15-min NIFTY timeframe option** added symmetrically to both engines' NIFTY
  TF dropdowns (`astNiftyTf` in AI Smart + `aeNiftyTf` in Auto-Experiment) and
  accepted everywhere the NIFTY ensemble trend / BB%b feed reads the timeframe:
  `niftybbp_alert.js` treats `15min` as a valid pane timeframe (feed
  chart-update + pane depth `1min:1 / 5min:3 / 15min:7` days), and both
  `aismart.js` and `autoexperiment.v13.js` whitelist `15min` in the TF init /
  `niftyBias(tf)` / `enhanceNiftyBias(et)` / `setNiftyTf` validation with a new
  `niftyTfLabel()` human-label helper and `niftyCandleDays(tf)` (7 days for
  15min, 3 otherwise) applied to the NIFTY / GIFT NIFTY / INDIA VIX candle
  fetches so 15-min indicators warm up at the same depth the HTF regime uses.
- **BB%b engine run window** (AST only): a new BB%b control that auto-starts /
  auto-stops the engine run between two BB%b lines, using the same two-line
  alert UI the BULL CE / BEAR PE rows use (ACTIVE default crossed above 0.8,
  INACTIVE default crossed below 0.2). The engine allows NEW entries only
  inside the window — it starts from the first BB%b ACTIVE crossing and stops at
  the BB%b INACTIVE crossing; open trades keep running to their SL/TP/trail. A
  fresh run always begins dormant/INACTIVE and waits for the ACTIVE line
  crossing. Implemented as a crossing latch in `static/niftybbp_alert.js`
  (`stepWindowState` from the same prev/last samples the BB%b alerts use,
  persisted under `astBbpWinCfg`, exported `windowStatus` / `windowReset` /
  `setWindowEnabled` / `editWinDraft`), layered above the existing BB%b alert
  gate in `static/aismart.js` via a new `bbpWindowBlock()` helper called at both
  AST entry seams (HFT scanner + normal poll / Indicator-filters path) plus
  `bbpWindowArmRun()` re-arming dormant on every run start, with the RUN WINDOW
  editor box (`astBbpWinBox`) in the AST BB%b section of `templates/index.html`.
  Cache-bumps: `aismart.js?v=190 -> v=191`, `niftybbp_alert.js?v=7 -> v=9`.

## Modified files (latest layer `f0a3feb..current`, in CHANGES_COMPLETE.patch)

```
 static/aismart.js            |  72 +++++++++++++---
 static/autoexperiment.v13.js |  30 ++++---
 static/niftybbp_alert.js     | 191 ++++++++++++++++++++++++++++++++++++++++++-
 templates/index.html         |  42 +++++++++-
 4 files changed, 307 insertions(+), 28 deletions(-)
```

Patch diff for this layer: `CHANGES_COMPLETE.patch` /
`CHANGES_SUMMARY.txt` below cover `f0a3feb..current` (this window).

## Contents

- **Complete project files** — the full committed working tree as of the
  15-min NIFTY TF + BB%b engine run window milestone (HEAD), including:
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
  incremental layer between the previous backup commit `f0a3feb` and the
  current working tree (HEAD) — the 15-min NIFTY TF option + the BB%b engine
  run window (ACTIVE/INACTIVE) across `aismart.js`, `autoexperiment.v13.js`,
  `niftybbp_alert.js` and `templates/index.html` — generated with
  `git diff f0a3feb`, excluding the regenerated doc files themselves.
- **CHANGES_SUMMARY.txt** — `git diff --stat` plus `--name-status` of the same,
  with a plain-language change description.

## Underlying snapshot (highlights of `95666ad..f0a3feb`)

- **48_Added_TradeEntryPossibilityArmGate_FixedIndicatorFilterDirection**
  milestone — the Trade-Entry-Possibility arm gate + Indicator-filter-direction
  fixes plus the ADX filter rebuild in Multi-Line Momentum Gap and the shared
  pane crosshair/timeframe sync that closed out the 48 chain.

## Previous backups

- `48_Added_TradeEntryPossibilityArmGate_FixedIndicatorFilterDirection` (commit `f0a3feb`)
- `46_Added_SupplyDemandOverlayFilterAnd_DirectChartEntryDecision` (commit `95666ad`)
- `45_Added_PaneIndicaterRisingUpward_RisingStrikeLTPpickUp` (commit `872b61b`)
- `44_Added_14NewIndicater_Added_NewIndicaterFilterBasedOnBehaviour` (commit `a152c03`)
- `43_Added_vLindicatorFilter` (commit `b61f17e`)
- `42_Added_AiBrainAlgo` (commit `ac432ec`)
- `41_added_TradeStats_NiftyTrendFollowingFixed`
- `38_Added_DirectChartTradeExecution_For_IndicaterFilterMode_And_StrategyNormalMode`
- earlier backups `33algodhan`..`39algodhan`
