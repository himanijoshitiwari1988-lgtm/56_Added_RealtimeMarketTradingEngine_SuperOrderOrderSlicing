# Backup: 28_RemovedDoubleStrategyConflict_InAST

Complete snapshot backup of the project (taken from the working directory
`27_Added_Comodities`).

## Contents

- **Complete project files** — the full working tree as it exists right now
  (committed state + all uncommitted work), including:
  - `app.py`, `main.py`, `broker.py`, `charts.py`, `data_fetcher.py`, `requirements.txt`
  - `static/` (aismart.js, autoexperiment.v13.js, hft_runner.js, paperstrategies.js, papertrade.js, ...)
  - `templates/index.html`
  - `CHANGELOG.md`, `HANDOFF.md`, `SESSION.md`
- **CHANGES_COMPLETE.patch** — the complete unified diff of every uncommitted
  change (nothing missed), generated with `git diff` against the last commit.
- **CHANGES_SUMMARY.txt** — `git diff --stat` plus `--name-status` of the same.

## Modified files (in CHANGES_COMPLETE.patch)

```
 app.py                       | 293 +++++++++++++++++++++---
 static/aismart.js            | 534 ++++++++++++++++++++++++++++++++++++++-----
 static/autoexperiment.v13.js | 339 +++++++++++++++++++++++----
 static/hft_runner.js         |  33 ++-
 templates/index.html         | 233 +++++++++++++++----
 5 files changed, 1253 insertions(+), 179 deletions(-)
```

This backup includes the strategy double-setting conflict fix (strategy-owned
TF / filters / SL / trail-SL in AST + pooled runner) together with all earlier
commodity / rate-limit / premium-chart work.
