# Backup: 29_Fixed_SmartNTrader_BulishBearishTradeAlert

Complete snapshot backup of the project (working directory
`28_RemovedDoubleStrategyConflict_InAST`).

## Contents

- **Complete project files** — the full working tree as it exists right now
  (committed state + all uncommitted work), including:
  - `app.py`, `main.py`, `broker.py`, `charts.py`, `data_fetcher.py`, `requirements.txt`
  - `static/` (smart_ntrader.js, aismart.js, autoexperiment.v13.js, final_strategy.js,
    hft_runner.js, strategy_container.js, papertrade.js, ...)
  - `templates/index.html`
  - `CHANGELOG.md`, `HANDOFF.md`, `SESSION.md`
- **CHANGES_COMPLETE.patch** — the complete unified diff of every uncommitted
  change (nothing missed), generated with `git diff` against the last commit.
- **CHANGES_SUMMARY.txt** — `git diff --stat` plus `--name-status` of the same.

## Modified files (in CHANGES_COMPLETE.patch)

```
 app.py                       |  15 +++-
 static/aismart.js            |  87 ++++++++++++++++---
 static/autoexperiment.v13.js |  30 ++++---
 static/final_strategy.js     | 168 ++++++++++++++++++++++++++++++++++--
 static/hft_runner.js         |  74 ++++++++++++++++
 static/smart_ntrader.js      | 198 +++++++++++++++++++++++++++++++++++++++----
 static/strategy_container.js |   3 +-
 templates/index.html         |  27 +++---
 8 files changed, 540 insertions(+), 62 deletions(-)
```

This backup includes the Smart NTrader fix set: NIFTY trend-following parity
with AST/AE (60s scan + per-tick threshold prune + below-threshold force
exit), strict buy-only semantics (bullish = BUY CE, bearish = BUY PE, no
SELL/short anywhere), the always-on stopped-state status pulse so the Fetched
Stocks list shows set-threshold stocks even with the market closed, and the
AI Smart P&L / Win Rate / Realized P&L summary cards moved to the top of the
AI Smart Trading Engine section. Also included: AST/AE commodity 'futures'
run-in support with the commodity daily-candle backfill fix in app.py,
AST -> Final Strategy save (sendToFinal), and the AE Trend confirmation
checkbox.
