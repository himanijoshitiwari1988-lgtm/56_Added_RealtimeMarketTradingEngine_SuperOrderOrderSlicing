# Backup: 42_Added_AiBrainAlgo

Complete snapshot backup of the project (working directory
`repo_preview`, full history from the 31-Aug backup point) pushed to
`himanijoshitiwari1988-lgtm/42_Added_AiBrainAlgo` (branch `main`).

## Contents

- **Complete project files** — the full committed working tree as of the Algos
  AI Brain milestone commit (HEAD), including:
  - `app.py`, `main.py`, `broker.py`, `charts.py`, `data_fetcher.py`, `requirements.txt`
  - `.env.example` (config template - the real `.env` with any key is never
    tracked or shipped)
  - `static/` (algosbrain.js, aismart.js, smart_ntrader.js,
    autoexperiment*.js, oitrend.js, trendconfirm.js, tradestats.js,
    niftybbp_alert.js, chart_grid.js, aipt.js, fast_live.js, indicators.js,
    papertrade.js, paperrun.js, strategies.js, ...)
  - `templates/index.html`
  - `CHANGELOG.md`, `HANDOFF.md`, `SESSION.md`
- **CHANGES_COMPLETE.patch** — the complete unified diff of every change between
  the previous backup point `7140715` and the current working tree (HEAD
  `914d9ec` + the Algos AI Brain milestone), generated with
  `git diff 7140715`, excluding the regenerated doc files themselves.
- **CHANGES_SUMMARY.txt** — `git diff --stat` plus `--name-status` of the same,
  with a plain-language change description.

## Modified files (in CHANGES_COMPLETE.patch)

```
 .ai-ready/MEMORY.md          |  589 +++++++++++
 .env.example                 |   17 +
 app.py                       |  605 ++++++++++-
 data_fetcher.py              |   59 +-
 static/aipt.js               |   31 +
 static/aismart.js            | 2304 ++++++++++++++++++++++++++++++++++++------
 static/algosbrain.js         | 2207 ++++++++++++++++++++++++++++++++++++++++
 static/autoexperiment.js     |   29 +-
 static/autoexperiment.v13.js |  595 ++++++++---
 static/autoexperiment.v14.js | 2183 +++++++++++++++++++++++++++++++++++++++
 static/chart_grid.js         |  540 ++++++++++
 static/fast_live.js          |  210 ++++
 static/hft_pool.js           |  103 +-
 static/indicators.js         |  202 +++-
 static/niftybbp_alert.js     |  428 ++++++++
 static/oitrend.js            | 1239 +++++++++++++++++++++++
 static/paperrun.js           |  363 +++++--
 static/papertrade.js         |  114 ++-
 static/smart_ntrader.js      |  971 +++++++++++++-----
 static/strategies.js         |  293 +++---
 static/tradestats.js         |  824 +++++++++++++++
 static/trendconfirm.js       |  174 ++++
 templates/index.html         | 1097 +++++++++++++++++++++++-----
 23 files changed, 13913 insertions(+), 1264 deletions(-)
```

This backup includes (highlights of `7140715..HEAD`, cumulative):

- **Algos AI Brain (new `static/algosbrain.js`)** — an in-tab chat "brain" that
  works OFFLINE (keyword/intent engine) or connected to an OpenAI-compatible
  LLM (key kept server-side only, configured via the tab's gear UI / `.env`,
  template in `.env.example`). Each LLM round is fed a live system snapshot
  (every engine, saved strategies, per-engine Bull/Bear filter counts, quote
  state), so it reads any tab and answers like a human: read tabs, open tabs,
  set AST timeframes, run/toggle Auto-Experiment (incl. duplicated AE clones),
  run saved AST strategy templates on paper engines, build + save real
  bearish/bullish strategies programmatically into the shared
  `algodhan_strategies_v1` store, and run one-shot Auto-Experiment side
  experiments (`ae_experiment`) that auto-create the missing-side strategy,
  enable "run on manually saved strategies", lock CE/PE direction and start the
  run - no more "go create a strategy yourself" dead-ends. Multi-step action
  chaining in one reply; every trade side-effect asks confirmation unless the
  user said "auto". AE engine gained `setRunManual(on)` / `setOptionType(v)`.
  `app.py`: `_BRAIN_SYS`/`_BRAIN_ACTIONS`/`_BRAIN_UIOPS` allow-lists +
  `/api/brain/*` proxy.
- **Trade Stats tab (`static/tradestats.js`)** — strategy-wise executed-trades
  report across all paper engines + AI Smart mirror ledgers, IST timestamps.
- **NIFTY Trend-Following confirmed-direction layer (`static/trendconfirm.js`)**
  — shared 15-min regime + hysteresis so fast EMA/RSI/Boll signals cannot flip
  the trend side on noise; used across Smart NTrader / AST / AE.
- **Chart grid mirror (`static/chart_grid.js`)** + chart fixes (stale overlay
  purge, single-flight 503 auto-retry).
- **Direct chart-based trade execution (AST indicator-filter + strategy normal
  mode)** — option premium chart entries trade that same leg/strike; spot chart
  entries resolve a single ATM CE/PE of the signal side (`firstPerSide`, no
  multi-strike fan-out).
- **NSE market-hours entry gate** — `marketSessionOpen()` blocks new entries
  after hours; open positions still managed to SL/TP/trail.
- **AI trail SL intent fix** — typed Trail SL % now auto-enables trailing.
- **OI Trend direction filter + OI Trend & Levels overlay** — `static/oitrend.js`
  (OI walls, Max Pain, ATM-IV range, PCR, EMA-regime state, CE/PE fuse).
- **Auto Experiment strict-AND runs** (`autoexperiment.v13.js` v130-v131) +
  `autoexperiment.v14.js` engine.
- **SmartNTrader BB%b alert -> auto trade overhaul** (v52-v58).
- **One-trade-per-signal latch** — a condition opens exactly one trade per
  meeting; no instant re-buy after an SL/TP exit.
- **Rate-limit/persistence + live UI fixes** — per-surface quote cooldowns,
  reload-survival chain/pick snapshots, FastLive WS candle store, non-blinking
  running rows, immediate closed-trade repaint.
