# Backup: 43_Added_vLindicatorFilter

Complete snapshot backup of the project (working directory
`repo_preview`, full history continuing from the `42_Added_AiBrainAlgo`
backup commit `ac432ec`) pushed to
`himanijoshitiwari1988-lgtm/43_Added_vLindicatorFilter` (branch `main`).

## Contents

- **Complete project files** — the full committed working tree as of the Volume
  Line indicator filter milestone commit (HEAD), including:
  - `app.py`, `main.py`, `broker.py`, `charts.py`, `data_fetcher.py`, `requirements.txt`
  - `.env.example` (config template - the real `.env` with any key is never
    tracked or shipped)
  - `static/` (algosbrain.js, aismart.js, smart_ntrader.js,
    autoexperiment*.js, oitrend.js, trendconfirm.js, tradestats.js,
    niftybbp_alert.js, chart_grid.js, aipt.js, fast_live.js, indicators.js,
    papertrade.js, paperrun.js, paperstrategies.js, strategies.js, ...)
  - `templates/index.html`
  - `CHANGELOG.md`, `HANDOFF.md`, `SESSION.md`
- **CHANGES_COMPLETE.patch** — the complete unified diff of every change between
  the previous backup commit `ac432ec` and the current working tree (HEAD
  `ac432ec` + the Volume Line indicator filter milestone), generated with
  `git diff ac432ec`, excluding the regenerated doc files themselves.
- **CHANGES_SUMMARY.txt** — `git diff --stat` plus `--name-status` of the same,
  with a plain-language change description.

## Modified files (in CHANGES_COMPLETE.patch)

```
 app.py                       |  23 ++--
 static/aismart.js            | 239 ++++++++++++++++++++++++++++++-----
 static/autoexperiment.v13.js |  99 ++++++++++++---
 static/indicators.js         | 162 +++++++++++++++++-------
 static/paperrun.js           |  76 ++++++++++-
 static/paperstrategies.js    |   6 +-
 static/papertrade.js         | 170 +++++++++++++++++++++++--
 static/smart_ntrader.js      | 294 ++++++++++++++++++++++++++++++++++---------
 templates/index.html         |  41 +++---
 9 files changed, 921 insertions(+), 189 deletions(-)
```

This backup includes (highlights of `ac432ec..HEAD`):

- **Volume Line (vl) indicator level filter** — "Volume Line above/below Signal
  (level)" Meet filters added to AI Smart Trading AND Auto Experiment; vl v0
  vs its own vl v1 Signal holds as a level (`cmpType: smoothed`), and the chart
  overlay deploys the vl line whenever the MeetVl gate is on.
- **Green/red candle entry gates** — AST + AE "Strategy entry on green/red
  candle" filters; entry only while the forming decision-bar candle is
  green/red.
- **BB & Price-Channel (level) middle gates reworked** — MeetCloseBb/Pc now mean
  "close on side + middle band rising/falling" over a 10-period middle; the
  cross gates keep band-expansion semantics; Price Channel midpoint middle now
  follows its own Mid Band Period window.
- **Per-engine margin wallet** — every paper engine runs only on its own Margin
  input; global `PaperMarginModal` insufficient-margin warning; margin bars
  above Running Trades (Paper Trade / AI Smart / Smart NTrader); AE-created
  strategies carry their `marginCap` through import and autoEntry.
- **NIFTY trend-following indices fix** — +Add-ed index turns on
  "Include indices for trading"; added indices keep trading without a NIFTY
  bias; option chain pre-warmed at add-time and re-armed from resolve when a
  pass resolves no strikes.
- **VWAP trend-leg anchored line** — one continuous VWAP (default `trend`
  anchor) re-anchoring on confirmed swing legs for early, causal, no-repaint
  close crosses; AST/AE/Live-pool reads switched to the trend anchor.
- **app.py daily-fill CPU-spin fix** — `_daily_fill_loop` skip path advances the
  index under lock and sleeps instead of spinning one core.
