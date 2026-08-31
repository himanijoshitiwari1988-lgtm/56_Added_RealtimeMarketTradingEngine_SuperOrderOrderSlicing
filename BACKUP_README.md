# Backup: 33_fixed_NiftyTrendFollowingLegPickerAuto

Complete snapshot backup of the project (working directory
`32_Added8IndicaterFilters_FixedOptionChainIssue`).

## Contents

- **Complete project files** — the full working tree as it exists right now
  (committed state + all uncommitted work), including:
  - `app.py`, `main.py`, `broker.py`, `charts.py`, `data_fetcher.py`, `requirements.txt`
  - `static/` (aismart.js, smart_ntrader.js, autoexperiment.v13.js, final_strategy.js,
    hft_runner.js, strategy_container.js, papertrade.js, ...)
  - `templates/index.html`
  - `CHANGELOG.md`, `HANDOFF.md`, `SESSION.md`
- **CHANGES_COMPLETE.patch** — the complete unified diff of every uncommitted
  change (nothing missed), generated with `git diff` against the last commit.
- **CHANGES_SUMMARY.txt** — `git diff --stat` plus `--name-status` of the same.

## Modified files (in CHANGES_COMPLETE.patch)

```
 static/aismart.js    |  95 +++++++++++++++++++++++++++++++++++++++-------------
 templates/index.html |   3 +-
 2 files changed, 74 insertions(+), 24 deletions(-)
```

This backup includes the NIFTY trend-following / Top-Movers auto CE-PE leg
picker fix plus the Live Data Pool enhancements:

- **Auto CE-PE leg picker fix** (`contractsFor`): when NIFTY trend-following is
  enabled the option side is pinned to the LIVE NIFTY direction for every picked
  symbol (bearish -> PE puts, bullish -> CE calls); in Top Movers mode it is
  pinned to the stock's own daily move (gainer -> CE, loser -> PE). The NIFTY
  trend direction was previously never used, the running strategies' shared
  category overrode the mover direction, and the auto-side block was skipped
  when the "+green premium" filter was off.
- **Data Pool — all selected strikes as separate premium readouts**: 'both'
  run-in instruments now expand every resolved contract into its own premium
  row (labelled `<Symbol> <strike> <CE/PE>`), instead of only the first strike.
- **Data Pool — manual Refresh button**: `AISmartTrading.poolRefresh()` forces a
  re-resolve of the selected universe (ignoring the 15s idle throttle) so newly
  added premium charts / symbols / strikes and changed indicator/data values
  appear immediately.
- **Data Pool — live volume fallback**: the Vol column uses the forming candle's
  volume, falling back to the live quote volume when the premium candle carries
  none (option candles often have volume 0), so strikes with real volume never
  show an empty column.
