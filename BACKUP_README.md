# Backup: 38_Added_DirectChartTradeExecution_For_IndicaterFilterMode_And_StrategyNormalMode

Complete snapshot backup of the project (working directory
`36_fixed_SmartNTrader_AddedOiTrend`) pushed to
`himanijoshitiwari1988-lgtm/38_Added_DirectChartTradeExecution_For_IndicaterFilterMode_And_StrategyNormalMode` (branch `main`).

## Contents

- **Complete project files** — the full committed working tree as of `612d16a`
  (HEAD), including:
  - `app.py`, `main.py`, `broker.py`, `charts.py`, `data_fetcher.py`, `requirements.txt`
  - `static/` (aismart.js, smart_ntrader.js, autoexperiment*.js, oitrend.js,
    indicators.js, papertrade.js, paperrun.js, strategies.js, fast_live.js, ...)
  - `templates/index.html`
  - `CHANGELOG.md`, `HANDOFF.md`, `SESSION.md`
- **CHANGES_COMPLETE.patch** — the complete unified diff of every change between
  the previous backup point `7140715` and HEAD `612d16a` (nothing missed),
  generated with `git diff 7140715 HEAD`, excluding the regenerated doc files
  themselves.
- **CHANGES_SUMMARY.txt** — `git diff --stat` plus `--name-status` of the same,
  with a plain-language change description.

## Modified files (in CHANGES_COMPLETE.patch)

```
 static/aismart.js            | 1261 +++++++++++++++++++++---
 app.py                       |  156 ++-
 data_fetcher.py              |   59 +-
 static/autoexperiment.js     |   29 +-
 static/autoexperiment.v13.js |  336 ++++++-
 static/autoexperiment.v14.js | 2183 ++++++++++++++++++++++++++++++++++++++++++
 static/fast_live.js          |  210 ++++
 static/hft_pool.js           |  103 +-
 static/indicators.js         |  176 +++-
 static/oitrend.js            | 1239 ++++++++++++++++++++++++
 static/paperrun.js           |  234 +++--
 static/papertrade.js         |   70 +-
 static/smart_ntrader.js      |  910 +++++++++++++-----
 static/strategies.js         |  255 +++--
 templates/index.html         |  444 +++++++--
 .ai-ready/MEMORY.md          |  589 ++++++++++++
  16 files changed, 7519 insertions(+), 783 deletions(-)
```

This backup includes (highlights of `7140715..612d16a`, 25 commits):

- **Direct chart-based trade execution (AST indicator-filter + strategy normal
  mode)** — an option premium chart entry trades that same leg/strike; a spot
  chart entry resolves a single ATM option of the signal side (bullish -> CE,
  bearish -> PE) instead of a plain underlying long. Every symbol's chain
  collapses to one nearest-ATM CE + one PE (`firstPerSide`), so no multi-strike
  fan-out entries (e.g. 2160 PE + 2180 PE together).
- **NSE market-hours entry gate** — `marketSessionOpen()` (Mon-Fri IST
  09:15-15:30) blocks every new paper entry while the exchange is closed, so
  frozen post-close candles can no longer place losing "after-market" trades
  that corrupt the paper PnL. Enforced in `allowedTradesFor()` (normal poll +
  HFT scanner), `hftScan()`, and the normal entry loop. Open positions are still
  managed to their SL/TP/trail.
- **AI trail SL intent fix** — a typed Trail SL % on the Overall SL floor now
  auto-enables trailing (one-time migration) so green trades lock profit; UI
  Trail SL % default is blank (no phantom 1%).
- **OI Trend direction filter + OI Trend & Levels overlay** — new `static/oitrend.js`
  (OI walls, Max Pain, ATM-IV range, PCR, EMA-regime trend state, per-strike
  CE/PE OI fuse, premium-chain OI strip); new OI Trend filter wired into AI
  Smart Trading and Auto Experiment.
- **Auto Experiment strict-AND indicator-filter runs** (`autoexperiment.v13.js`
  v130-v131) plus the new `autoexperiment.v14.js` engine; strict results kept for
  every backtested symbol.
- **SmartNTrader BB%b alert -> auto trade overhaul** (v52-v58) — draft vs armed
  config, Set Alert & Execute Trade lock, draggable overlay bars, dashed
  previews, fixed popovers, negative level support, NIFTY-side-gated CE/PE fire.
- **Rate-limit/persistence + live UI fixes** — per-surface quote cooldowns,
  1000ms poll, reload-survival chain/pick snapshots, immediate closed-trade
  repaint, non-blinking running-strategy rows, FastLive WS candle store.
- **One-trade-per-signal latch** — a strategy+instrument condition opens exactly
  one trade per meeting; after an SL/TP exit the still-true condition cannot
  instantly re-buy (APLAPOLLO 2140 PE was churned 24x in one session), it must
  reset FALSE and meet again fresh.
