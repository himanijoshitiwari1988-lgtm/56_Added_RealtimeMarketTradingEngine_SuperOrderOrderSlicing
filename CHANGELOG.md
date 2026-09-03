# AlgoDhan Trading System — Change Log & Continuation Guide

Backup target: `himanijoshitiwari1988-lgtm/38_Added_DirectChartTradeExecution_For_IndicaterFilterMode_And_StrategyNormalMode`
Source history: `36_fixed_SmartNTrader_AddedOiTrend` (earlier backups: `33algodhan`..`39algodhan`, `36_fixed_SmartNTrader_AddedOiTrend`, `38_Added_DirectChartTradeExecution_For_IndicaterFilterMode_And_StrategyNormalMode`)

## Latest backup (2026-09-03) — direct chart-based single-strike CE/PE execution for Indicator-Filter & Strategy Normal mode + NSE market-hours entry gate

Full diff: `7140715..939d967` (23 commits, 16 files, +7475/-779). Complete code
state is pushed to `38_Added_DirectChartTradeExecution_For_IndicaterFilterMode_And_StrategyNormalMode` `main`.

- **AST engine now trades directly on the evaluated chart.** An option premium
  chart (CE/PE) entry trades that SAME chart's leg/strike; a spot/underlying
  chart entry BUYs the single ATM option of the signal side (bullish -> CE,
  bearish -> PE) instead of a plain underlying long. Indicator-filter mode and
  strategy normal mode both route through it. Every symbol's chain collapses to
  one nearest-ATM contract per side (`firstPerSide`), so multi-strike fan-out
  entries (e.g. 2160 PE + 2180 PE together) can no longer happen.
- **NSE market-hours entry gate.** After 15:30 IST (and before 09:15, Sat/Sun)
  the candle feed stops, but frozen candles kept satisfying entry conditions and
  the engine placed losing post-close trades that corrupted the paper PnL. New
  `marketSessionOpen()` blocks every new entry while the exchange is closed -
  enforced in `allowedTradesFor()` (shared by the normal poll AND the HFT
  scanner), `hftScan()`, and the normal tickBody entry loop ('Blocked: NSE
  market closed ... - no new entries'). Open positions keep being managed to
  SL/TP/trail.
- **AI trail SL intent fix.** A typed Trail SL % above the Overall SL floor now
  auto-enables the trailing checkbox (one-time load migration), so profitable
  trades ratchet instead of handing the whole run back to zero; the Overall/TAIL
  SL % input default is blank (no phantom 1%).
- **OI Trend direction filter + OI Trend & Levels overlay.** New `static/oitrend.js`
  (CE/PE OI walls -> support/resistance, Max Pain, ATM-IV range, PCR, EMA-regime
  trend state; per-strike CE-vs-PE OI fuses into trend/consolidation with
  reversal-warning labels, OI-squeeze consolidation and OI-bias arrows; premium
  option charts get an OI-ordered CE-left/PE-right/spot-centre strip). OI Trend
  direction indicator filter wired into AI Smart Trading and Auto Experiment.
  indicators.js v50-v52.
- **Auto Experiment strict-AND runs.** 'All together (strict AND)' now really
  runs pure indicator-filter strategies (one per enabled Bullish/Bearish side),
  keeps every backtested symbol's strict result, and no longer drops strikes
  during Dhan rate-limit cooldowns (v130-v131). New `autoexperiment.v14.js`
  engine added.
- **SmartNTrader BB%b alert -> auto trade overhaul** (v52-v58): draft-vs-armed
  config with 'Set Alert & Execute Trade' lock, smooth-draggable overlay level
  bars with live value chip, dashed draft previews, fixed overlay popovers (Set
  button never clipped), negative BB%b alert levels (-3..3), NIFTY-side-gated
  CE/PE firing; 'meet-conditions' style filter keys added to AST/AE.
- **Rate-limit/persistence/live-UI**: per-surface quote cooldown (empty/429 no
  longer arms the global 30s gate), 1000ms AST poll, reload-survival chain/pick
  snapshots, AST closed-trades table repaints on the quote loop, non-blinking
  PaperRun strike rows, FastLive WS live candles, AST open-chart ENTRY/SL/TP
  price lines, NIFTY trend picker uses the CURRENT EMA9/21 layer on reversal.

## How to Run (development / preview)

```bash
pip install -r requirements.txt flask_sock websockets
python app.py          # serves Flask app on port 8081
```

The web UI is a single-window dashboard: real-time candlestick charts (14
timeframes), live option chain (WebSocket FULL-mode), paper trading, indicator
strategies and auto-experiments. Dhan API credentials (Client ID + Access
Token) are entered in the UI top bar and stored in localStorage.

## Current State (last session)

### Changes made in THIS session — NIFTY trend-following / Top-Movers auto CE-PE leg picker fix + Data Pool enhancements (backup `33_fixed_NiftyTrendFollowingLegPickerAuto`)
User report: the auto CE/PE side pick for NIFTY trend-following and Top
Gainers/Top Losers stopped working — for bearish the engine should automatically
take the PE put chart, for bullish the CE call chart, and run the strategy on
it. Root cause in `static/aismart.js` `contractsFor`: the NIFTY trend direction
(`_lastNiftyDir`) was never consulted (NIFTY trend mode has no mover direction,
and `trendDirectionFor()` analysed each stock's own 5-min candles instead of the
NIFTY index); `strategyDirectionFor()` was first in the precedence chain so a
shared strategy category overrode the mover/trend direction; and the whole
auto-side block was skipped when "+green premium" was unchecked.
- `static/aismart.js` `contractsFor`: side precedence reordered to
  NIFTY-trend-side -> mover-direction -> active filter direction -> strategy
  category -> underlying trend; guard extended so the block runs in NIFTY trend
  mode (bearish -> PE puts, bullish -> CE calls) and in Top Movers mode (gainer
  -> CE, loser -> PE).
- Data Pool (`poolScan`): 'both' run-in instruments now expand ALL resolved
  contracts into separate premium rows (`<Symbol> <strike> <CE/PE>` label),
  not just `contracts[0]`; `confirmCandlesFor(instr, tf, ci)` fetches a
  specific contract's premium candles.
- Data Pool: manual Refresh button — `AISmartTrading.poolRefresh()` forces a
  re-resolve (new `_poolForceResolve` flag bypasses the 15s idle throttle) and
  re-renders the readout immediately; HTML button beside the Data Pool toggle.
- Data Pool: `poolVolume()` — Vol column prefers the forming candle's volume,
  falls back to the live quote's volume for the same instrument/strike when the
  premium candle carries none, so strikes with real volume never show 0.
- Verified: `node --check` clean on `static/aismart.js`; server serves the new
  code. Cache-buster: `aismart.js?v=101`.

### Changes made in THIS session — Live-quote / P&L / Closed-list / square-off fixes (dash `--` P&L, non-green profit, stale Closed list, mistimed entries)
User report: running paper trades show `--` P&L/LTP instead of a price + green profit; closed
positions don't show up in the Closed list; strategies don't enter at the right time. Root cause:
option strikes stream live ONLY after `/api/candles` asks the server to WS-subscribe them
(`_ws_subscribe_extra` in `app.py`). If the shared `clientQuotes` store already had a key for the
strike (stale REST snapshot, or an entry left over from before a server restart), both engines'
subscribe step skipped the candle fetch forever — so the strike never became live, P&L stayed
`--`, and auto SL/trail-TP could not price a close.
- `static/aismart.js` `ensureOptionQuotes()` + `static/autoexperiment.v13.js` tradeTarget block:
  only skip when `q.live && q.ltp != null`; a non-live key now always re-fetches candles
  (re-subscribes) so live ticks recover without a reload. Resolved strike premium is passed to
  `PaperTrade.autoEntry` as `fallbackLtp` (entry price only) and is no longer seeded into
  `clientQuotes` as a fake non-live quote (that fake price caused frozen P&L and sudden exits).
- `static/papertrade.js`: `checkAutoTargetSl`, `checkTargetSl`, `checkPendingFill` now require
  `q.live` before closing; added `closeAllPositions(reason)` (manual chart position + every auto
  position from any engine); `autoEntry` honors `opts.fallbackLtp`.
- `static/aipt.js` / `static/paperrun.js`: entry pricing, position rows and summary read
  `q.live`-flagged quotes only; `renderTrades` renders rows defensively (per-row try/catch) so one
  malformed record can't blank the live P&L list.
- `static/aismart.js`: `recordClosedPosition(p)` copies the authoritative close (entry/exit/P&L/
  charges) from PaperTrade's recent closed record into `state.closed` (fallback: live-quote
  estimate), wired into every close path (SL/TP ghost reconcile, auto square-off, NIFTY
  trend-drop, NIFTY exit gate, remove-saved, Stop, Stop All) so the "Closed AI Smart Trades" list,
  Smart Realized P&L and Win Rate update live. `renderRunning`/`renderClosed`/`renderSummary`
  made defensive.
- Both engines' daily auto square-off now call `pt.closeAllPositions('Auto square-off')` + stop the
  AI Paper Trade ledger (`aipt.stopAll()`), so the close time cuts every engine's paper positions.
- `static/aismart.js`: `niftyGateMetSync(g)` — synchronous NIFTY entry gate for the HFT scanner
  (which can't await); scanner now honors the entry gate before placing legs.
- Verified: `node --check` clean on all 5 files; server serves the new code. Cache-busters:
  `aismart.js?v=75`, `autoexperiment.v13.js?v=107`, `papertrade.js?v=20`, `aipt.js?v=30`,
  `paperrun.js?v=14`.

### Changes made in THIS session — NIFTY BB%B session-extreme reversal gates (inc_up / inc_down)
NIFTY entry/exit gate got two new BB%B zones ("Increasing upward" / "Increasing downward") in both
the AI Smart Trading Engine (`static/aismart.js`) and the Auto Experiment engine
(`static/autoexperiment.v13.js`), plus the 4 dropdowns in `templates/index.html`.
- `niftyBbSlope(candles, lookback)`: 1-bar %B line slope with a 0.015 dead-band (was the old
  `bbSlope` gate).
- `niftyBbExtremeReversal(candles)`: the new gate. Finds today's (IST session) min/max %B across
  today's bars (trailing-20 %B, same maths as `sessionBbRange`); `inc_up` fires only while the %B
  line is >= 0.02 above the session's oversold low AND that low was touched within the last 30 min
  of candle time; `inc_down` mirrors off the session's overbought high. Epoch-seconds vs epoch-ms
  handled. A steady mid-range drift never trips the gate.
- `niftyTrendAnalysis` returns `bbSlope`/`bbIncUp`/`bbIncDown`; propagated through
  `combineNiftyTfs` and single-TF bias. `niftyZoneAllowed` maps `inc_up` -> `bbIncUp`,
  `inc_down` -> `bbIncDown` (replaces `bbSlope === 1/-1`). `_niftySummary` shows
  "Inc Up (rebound)" / "Inc Down (rollover)". Zone whitelists + `NIFTY_ZONE_LABEL` extended in
  both engines.
- Verified: `node --check` clean both files; Node harnesses (`/tmp/bbtest*.js`) confirmed
  crash->rebound fires `inc_up`, mid-range drift fires nothing, climb->top->fall fires `inc_down`,
  stale (>30-min) bounces expire. Cache-busters: `aismart.js?v=74`->`?v=75`,
  `autoexperiment.v13.js?v=106`->`?v=107`.

### Changes made in THIS session — Manual SL % is raw percent (0.05 stays 0.05%)
Fix for: save a template with manual stop-loss 0.05% then open it — the engine showed 5%.
`readUniversal()`/`readUniversal` (both the Auto Experiment engine `autoexperiment.v13.js` and the
AI Smart Trading Engine `aismart.js`) fed the Manual SL % input through `slPercentFromInput()`,
which treats values < 1 as decimal fractions (`0.05` => 5%). The saved template therefore stored 5
and reopening showed 5%. Now the input is a direct percent: `0.05` is stored and restored verbatim
as 0.05%. The old load-time migration that rescaled <1 values (`s.universal.manualSLPct < 1` =>
`*100`) was removed from both engines so a saved 0.05 also survives a page reload. Input tooltips
updated ("Stop-loss percent, entered directly (e.g. 0.05 = 0.05%)"). Cache-busters bumped
`autoexperiment.v13.js` ?v=101->?v=102 and `aismart.js` ?v=69->?v=70. Verified in-browser
(`/tmp/opencode/test_sl_pct.js`): type 0.05 -> state 0.05 -> template 0.05 -> reopened input "0.05"
-> reload keeps 0.05. Regressions: `test_ae_tpl.js` 24/24, `test_open_v2.js` 12/12,
`test_app_trace.js` 31/31.

### Changes made in THIS session — Auto Experiment template Open is now robust + auto-opens on select
Follow-up to the template-save fix: the AE "Open" template flow had two failure modes that made it
look like a saved template was not opening. `static/autoexperiment.v13.js`:
- `openTemplate()` silently returned when the id was unknown or the template had no `settings`
  (old/corrupt entries) — it now logs a clear warning ("Template not found" / "no saved settings to
  apply") instead of doing nothing.
- The "Open saved" dropdown previously only synced the Default checkbox (`syncSelectedTpl`). It now
  auto-opens the chosen template on change (`onTplSelect()` → the same apply path as the Open
  button), restoring the original select-to-open UX; the Open button still works too.
- `syncSelectedTpl` was converted from an api-object method into a closure function so
  `onTplSelect()`/`openSelectedTemplate()` can call it (it was previously not reachable by name).
- Cache-buster bumped `autoexperiment.v13.js?v=100` → `?v=101` so browsers fetch the new engine.
Verified in-browser (`/tmp/opencode/test_open_v2.js`, 12/12): dropdown auto-open restores
lots/margin/strike-count/runManual + UI sync; Open button same; no-settings template logs a warning
with no crash. Regressions: `test_ae_tpl.js` 24/24, `test_app_trace.js` 31/31.

### Changes made in THIS session — Auto Experiment "Save Template" now captures ALL engine settings
Fix for "Auto Experiment not saving all settings" when saving/opening an engine template.
`static/autoexperiment.v13.js` `captureEngineSettings()` snapshot the whole live state, but four
`state` settings were missing from the snapshot (and from `applyEngineSettings()`, so opening a
template never restored them):
- `runManual` — the "Run auto experiment on manually saved strategies" toggle
- `symbols` — the selected symbol/instrument universe used for the experiment + paper trading
- `showPickedStrikes` — the "Picked Strikes" list visibility toggle
- `autoSend` — the auto strategy sender mode (`{enabled, tpls[]}`, incl. the linked template list)

Also: `applyEngineSettings()` now re-renders the auto-send template list (`renderAutoSendTplList()`)
after applying a template, and the research-groups list applies even when a template saved an empty
selection (previously `groups` only applied when non-empty). Verified in-browser with a 24-check
round-trip harness: set distinctive values → Save Template → mutate state to junk → Open Template →
all settings (incl. the four above) are restored, and the UI (strike count, lots, Run Manual toggle,
Picked Strikes button) re-syncs. No regressions: `test_rl.py` / `test_rl2.py` / `test_rl3.py` PASS,
browser suite `test_app_trace.js` 31/31.

### Changes made in THIS session — Dhan rate-limit mitigations (batch / spacing / backoff / caching)
Follow-up to the cooldown-gate fix above. The user's chart was still stuck at 503 because the
account was genuinely DH-904 rate-limited and every recurring `code=None` empty-body failure
**re-armed (slid) the 30s global cooldown** — the gate never cleared. Applied the user's four
suggestions on top of the existing architecture:
- **Cache static/frequent data (suggestion 4):** already extensive (candle cache + realtime
  patching, per-key candle park, expiry RAM cache, stale option-chain serve, `_DAILY_PL_CACHE`,
  quote cache). Kept, and now the cooldown-gated paths lean on it instead of Dhan.
- **Batch requests (suggestion 1):** already done where Dhan allows — quotes are fetched in one
  call per exchange segment (`_fetch_split_quotes`), the option chain and expiry list are single
  calls, candles cannot be batched (Dhan is per-instrument/timeframe). No per-symbol loops remain
  in the quote path.
- **Space out sequential calls (suggestion 2):** raised the historical (candles) throttle from
  0.25s to 0.4s per call.
- **Exponential backoff on rate-limit errors (suggestion 3):**
  - `data_fetcher.py` `_mark_rate_limited()` is now **idempotent within the active window** — a
    repeated empty-body/DH-904 failure no longer slides the cooldown forward, so the gate always
    clears ~30s after the FIRST rejection. This is the root-cause fix for the permanent 503.
  - `fetch_intraday_candles()` / `fetch_daily_candles()` now short-circuit (raise
    "Rate limited - Dhan chart API temporarily unavailable") when the cooldown is already active,
    and retry rate-limit/empty-body failures with 1s/2s backoff (breaking out as soon as the
    cooldown arms) instead of raising into the storm.
  - `app.py` gates every remaining background Dhan caller on the cooldown: `_fetch_option_chain_data`
    (background chain refresh — previously its 2s/4s/6s retry loop re-armed the gate on every
    failure), `_fetch_and_cache_expiries`, `api_expiries` cold-start, and the direct
    `fetch_expiry_list` calls in `api_option_chain_all` / `api_auto_strikes`.
- **Result:** the death spiral is broken — `/api/candles` 503s lift after one 30s window, the
  frontend `fetchCandlesRetry` (6x5s) then succeeds, and no background loop can keep the gate
  alive. Verified: `/tmp/opencode/test_rl.py` PASS + new `/tmp/opencode/test_rl2.py` PASS
  (idempotent cooldown, intraday/daily short-circuit with zero Dhan calls during cooldown,
  rate-limited fetch arms cooldown once and raises). Browser suite: 31/31 PASS (traced run).
- **Follow-up fix (storm source):** instrumented `_unwrap_sdk_response` with `[caller=...]`
  diagnostics and traced the recurring `code=None` empty-body storm to
  `fetch_expiry_list <- api_expiries` — the browser polls `/api/expiries` every ~2s and each
  empty-body response re-armed the GLOBAL 30s cooldown, blocking `/api/candles` at 503 even when
  candles themselves were fine.
  - `data_fetcher.py`: `fetch_expiry_list()` / `fetch_option_chain()` now short-circuit when
    `rate_limit_cooldown_active()` (raise fast, zero Dhan calls) and **break** out of their
    3-attempt retry loops the moment the cooldown arms instead of retrying into the storm.
  - `app.py`: new per-underlying negative failure cache (`_EXPIRY_FAIL_CACHE`, 120s TTL) — both
    the `/api/expiries` cold-start path and `_fetch_and_cache_expiries` (background refresh)
    serve the soft 503 from memory for a failed underlying, so every-2s polls never re-hit Dhan
    and never re-arm the global gate. Success clears the negative entry.
  - **Result:** since restart, 0 `code=None` responses and 0 "Rate limited" 503s (was dozens per
    minute); candles serve 200 continuously. Verified `test_rl.py` + `test_rl2.py` still PASS.
    The `[caller=...]` diagnostics are kept (harmless, aids future tracing).
- **Follow-up fix (server thread explosion -> "Failed to fetch" / stuck "Connecting..."):**
  the preview tunnel holds ~900 pooled keep-alive connections to port 8081; Werkzeug's
  `app.run(threaded=True)` spawned a thread per open connection (**941 threads, 90%+ CPU,
  570MB RSS**), stalling request handling so browser fetches timed out ("Connection failed:
  TypeError: Failed to fetch", "network error while reloading", Reconnect stuck on
  "Connecting...").
  - `app.py`: `_BoundedThreadWSGIServer` serves connections from a bounded daemon
    `ThreadPoolExecutor` (128 cap) instead of one thread per connection.
  - `app.py`: `_OneShotRequestHandler` serves exactly one HTTP request per connection then
    closes. http.server keeps HTTP/1.1 sockets alive and Werkzeug only sends a "Connection:
    close" header without setting `close_connection`, so every pooled thread was parked in
    readline() on an idle tunnel connection and new requests starved. WebSocket (/ws, handled
    by flask_sock which hijacks the socket for its lifetime) is unaffected.
  - A `Connection: close` after_request hook was tried first but 500'd every tunnel request
    (`'NoneType' object is not callable`); removed — the header was already sent, the actual
    bug was the socket never closing.
  - **Result:** threads 50 (was 941), tunnel 15/15 requests all 200 (~0.3s), local 200 (~3ms),
    feed up with 2429 subscribed, 0 5xx after restart.
- **Follow-up fix (chart hangs / "not loading" when switching to an equity symbol):**
  verified live against Dhan: index `/charts/intraday` returns in <1s but equity intraday
  legitimately takes ~8-28s (1455 rows / ~133KB for 30 days of 5-min bars), and the recurring
  `code=None` empty-body failures from `fetch_expiry_list <- api_expiries` kept re-arming the
  **global** 30s cooldown every ~2-3 min (the 120s negative-cache TTL let one poll slip through),
  blacking out `/api/candles` at 503 during every such window — so the chart appeared to "never
  load" on symbol switches. Per the Dhan docs the Option Chain surface is rate-limited at
  **1 request per 3 seconds** independently of the chart/data surface (5 req/s), so an
  option-chain 429 must never gate the candle endpoints.
  - `data_fetcher.py`: new **per-surface option-chain cooldown** (`_OC_COOLDOWN_UNTIL` /
    `oc_rate_limited()` / `_mark_oc_rate_limited()`, idempotent like the global gate).
    `_unwrap_sdk_response(result, surface=...)` routes rate-limit arms — `DH-904/805`,
    `Rate_Limit`, `DH-906`, and empty-body `code=None` — to the OC gate when called with
    `surface="oc"`, leaving the global candle gate untouched.
  - `data_fetcher.py`: `fetch_expiry_list()` / `fetch_option_chain()` short-circuit on
    `oc_rate_limited()`, break their retry loops when it arms, and call
    `_unwrap_sdk_response(..., surface="oc")`.
  - `data_fetcher.py`: `expiry_list` throttle interval 2.0s → **3.0s** (Dhan docs: Option Chain
    API = 1 req/3s). This was the incorrect setting — the browser's every-~2s expiry poll at a
    2s throttle tripped Dhan's 429 constantly.
  - `app.py`: `_fetch_and_cache_expiries` and the `/api/expiries` cold-start path also check
    `oc_rate_limited()` so the expiry surface backs itself off without ever blocking candles.
  - `app.py` / `templates/index.html`: candle cache TTLs raised (server 45s → 120s, client
    15s → 60s). The realtime WS path already patches the last bar with live LTP, so a longer
    list-cache TTL makes symbol switch-backs instant (0.01s cached vs 8-28s first Dhan fetch)
    without hurting freshness.
  - **Result:** a `code=None` on the expiry surface now arms only the OC gate and never blacks
    out `/api/candles`; the global gate stays clear. Live: equity first fetch 200 in 7-28s
    (Dhan-side latency, unavoidable), repeat fetch 0.01s, index 0.02s, preview tunnel 200
    (~0.2s), feed up. Verified `test_rl.py` + `test_rl2.py` still PASS and new
    `/tmp/opencode/test_rl3.py` PASS (OC vs global gate split, idempotency, expiry short-circuit,
    3s throttle). Browser suite: 31/31 PASS (traced run).

### Changes made in THIS session — Dhan "chart API temporarily unavailable (rate limited)" fix
- **Root cause:** the `/api/candles` cooldown gate (503 "Dhan chart API temporarily unavailable
  (rate limited)") was being kept permanently armed by background loops that ignored the global
  cooldown. The index daily-candle fallback inside `_quote_poll_loop` (`app.py`) fired the Dhan
  daily endpoint every poll cycle **without** checking `rate_limit_cooldown_active()`, got real
  DH-904 "Too many requests" / empty-body responses, and each response re-armed the 30s gate —
  so the user could never load a chart after connecting.
- **Fixes:**
  - `app.py` `_quote_poll_loop`: the index daily fallback now respects the cooldown (skips while
    rate-limited), matching every other background loop.
  - `data_fetcher.py` `_fetch_daily_with_fallback`: when the daily attempt fails and the failure
    re-armed the cooldown, return empty instead of cascading into the 15-min intraday fallback
    (which fired more Dhan calls + retries into the storm and re-tripped the gate).
  - `templates/index.html`: new `fetchCandlesRetry(payload, onSuccess, onRateLimit, onFail, ...)`
    helper; `loadChart()` now auto-retries rate-limited candle loads every 5s (up to 6 tries,
    ~30s) showing "Dhan is rate-limited. Retrying (n/6)..." instead of an instant hard failure,
    so the chart appears by itself once the gate lifts. Non-rate-limit errors still fail fast.
- **Verified:** backend unit test (`/tmp/opencode/test_rl.py`) — empty-body daily failure arms the
  cooldown (existing behavior), the intraday fallback no longer fires during cooldown, cooldown
  expires normally. Full puppeteer suite **31/31 pass**, tab-bar/sidebar layout still correct.
  Live Dhan re-check needs the user to reconnect from the browser (server restarted).

### Changes made in THIS session — Tab-bar + sidebar screen-fitting fix
- **Root cause:** creating many duplicated tabs expanded the whole document (2620px at 1280px
  viewport) because the flex row never constrained its children: `#content`/`#main` lacked
  `min-width:0`, `.tab-bar` items shrank instead of overflowing (so no horizontal scrollbar
  appeared and the last tab's close button was cut off), and `#sidebar` default `flex-shrink:1`
  collapsed it to ~21px (market watch / indices list hidden).
- **Fixes (`templates/index.html`):**
  - `#sidebar` `flex-shrink:0`, `#main`/`#content` `min-width:0` — sidebar keeps its 280px and
    never gets overlapped.
  - `.tab-btn`/`.tab-item` `flex:0 0 auto` + `.tab-bar` `flex-wrap:nowrap` — tabs keep natural
    width so the bar's `overflow-x:auto` produces a real horizontal scrollbar; added thin
    scrollbar styling.
  - `body` `overflow-x:hidden` — page never expands horizontally; `#header` `flex-wrap:wrap` so
    connection status stays visible on narrow screens.
  - New `revealTabInBar(el)` helper + calls in `switchTab` and both `PaperTabs._buildTab`/
    `AeTabs._buildTab` — adding or switching to a tab auto-scrolls the bar so the tab (and its
    remove button) is fully visible.
- **Verified:** at 1280px and 1024px viewports with 15+ tabs, `docWidth == viewport`, sidebar
  stays 280px with no overlap, tab bar scrolls internally (`scrollWidth` > `clientWidth`), and
  the last tab's close button is revealed. Full puppeteer regression suite still **31/31 pass** +
  `receiveFromAE` test PASS (no engine/facade regressions).

### Changes made in THIS session — Multi-paper/AE tab engine independence (index.html integration complete)
Completes the per-tab independent engine work for duplicated Paper Trade and Auto Experiment tabs
(backend factories/facades were completed in the previous session; this session finished the
`templates/index.html` integration, HANDOFF items 3a-3e):
- **`switchTab` active-engine routing**: sets `window._paperActiveEngine` / `window._aeActiveEngine`
  on tab switch, calls `onTabHide()` on leaving a paper/AE tab and `onTabShow()` on entering.
  Facades (`window.PaperTrade`, `window.AutoExperiment`, etc.) dispatch to the active tab's engine.
- **`AeTabs`** (duplicate of `PaperTabs`): add-AE-tab modal, restore/add/remove + persistence under
  `algodhan_ae_tabs_v1`; cloned `#tab-autoexperiment` DOM with every id re-suffixed `_aeN`.
- **`ensureCloneEngines(tab, kind)` + `TabEnginesInit()`**: idempotent engine creation for cloned
  tabs (paperN gets its own papertrade/aipt/aismart/paperrun instances; aeN its own
  autoexperiment instance). Each engine creation is wrapped in try/catch so one failure can't
  abort the rest. Cloned-tab engines boot then `stopPoll` until their tab is shown (rate-limit
  protection). `TabEnginesInit` runs after all engine scripts for the localStorage-restore path.
- **papertrade.js `$id` fallback fix** (applied to all 5 factories): `$id` now falls back to the
  base (non-suffixed) element when the suffixed one is missing, because sidebar elements
  (`#paperMargin`, `#paperLots`, `#paperLotSize`, `#paperSymbol`, `#ptChart`, ...) live in the
  shared sidebar, not inside the cloned tab. Previously clone `init()` threw on `#paperMargin`
  and aborted the whole clone engine chain.
- Factories `return api` and register clones under the tab id (strip leading `_`) so facade
  dispatch keys match the switchTab routing keys.
- Cache-busters bumped: `papertrade.js?v=18`, `autoexperiment.v13.js?v=100`, `aipt.js?v=28`,
  `aismart.js?v=69`, `paperrun.js?v=12`.

**Verified:** `node --check` passes on all 5 engines; puppeteer browser suite = **31 checks,
0 failed** (boot clean, base engines + facades, independent paper1 + ae2 engines, facade routing
on switch, ae2 removal cleanup, reload/restore rebuild, no runtime JS errors); `receiveFromAE`
routing test PASS. Transient `/api/candles` 503s under load are the backend Dhan rate-limit
cooldown gate (expected).

### Changes made in THIS session (backup `71algodhan`) — Auto Experiment backtest
### runs on the selected-strike option premium chart ("Trade should be executed in")
- **Split run-in / trade-in backtest** (`static/autoexperiment.v13.js`): new
  `backtestSplit(tpl, signalSources, tradeCandles, opts)` engine. Strategy entry/
  exit signals are evaluated on the run-in chart(s) per "Strategy should be run
  in" while the simulated backtest trade (entry/exit prices, SL, trailing TP,
  ATR-based autoSL) is priced on the trade-in chart per "Trade should be
  executed in". Each signal source is aligned to the trade chart by candle
  timestamp (two-pointer walk); entry fires only when EVERY source agrees (AND),
  exit when ANY source exits (OR) — mirrors live paper-trading semantics.
- **F&O stocks**: `runIn = 'spot'` + `tradeIn = 'premium'` now resolves the
  option chain and fetches premium candles in `runExperiment` Phase 1 (previously
  the `riMode === 'spot'` shortcut returned immediately without touching the
  chain), then Phase 2 runs `runOnCandles(..., { signalCandles:[underlying],
  tradeCandles: oc })` so backtest trades land on the selected-strike premium
  chart. Missing chain falls back to spot execution (warn) instead of skipping.
- **Indices**: `runIn = 'both'` + `tradeIn = 'premium'` runs signals on the spot
  chart AND each selected-strike premium chart (AND confirmation), executing the
  trade only on the premium chart.
- `backtestCached` and `runOnCandles` accept a `splitOpts` arg; the cache key
  folds in the signal-series + trade-series identities (`|split:...`) so runs
  with different run-in/trade-in charts never collide. Split results are
  strike-scoped (`optionStrike`/`optionType`/`premium`/`delta` tags), and the AI
  auto-timeframe collapse keys them by strike.
- Verified with a Node unit-test harness: trade entry is priced on the trade
  (premium) chart, AND dual-confirmation blocks trades when a source is silent.
- **F&O no longer falls back to the spot chart**: previously, when the option
  chain could not be resolved, F&O stocks were backtested on the underlying and
  reported spot-based P&L. They are now skipped with a warning instead, so every
  F&O result's P&L comes from option-premium trades only. Only an index run with
  trade-in = spot (or the 'both' run-in degrade when the chain is missing) still
  produces spot-executed backtests.
- **Execution-basis label**: every result card and the strategy Detail modal now
  show "backtest trade executed on: option premium chart" (green) or
  "backtest trade executed on: spot chart" (orange) via `tradeBasisLabel(r)`,
  derived from `r.backtestBasis`. Old spot-based results already saved in
  localStorage will render the "spot chart" label until the experiment is re-run.
- **Cache bust**: `templates/index.html` bumped the script tag to
  `autoexperiment.v13.js?v=41` so browsers/proxies that cached the pre-fix
  `?v=40` bundle stop running the old backtest engine.

### Changes made in earlier session (backup `50algodhan`) — Auto Experiment trade
### budget (manual cap + AI auto trades) and trade-time gates
- **Manual "Max trades" per strategy** (`static/autoexperiment.v13.js` +
  `templates/index.html`): `aeTradeLimit` checkbox + `aeTradeLimitCount` number
  input. Applied at the LAST entry decision point both in `backtest` (loop gate
  `trades.length < maxTrades`) and live paper trading (`allowedTradesFor` checked
  before `evalEntryLive` in `paperTick`, per-day `_tradeCounts` reset each IST
  session). Exhausted budget blocks new entries but never interferes with SL/trail
  exits of open positions.
- **AI auto trades** (`static/aitrades.js` new engine + `aeAiTrades` checkbox):
  the AI engine analyses the chart, up to 10 indicators (EMA9/21, ATR%, RSI14,
  MACD histogram, Bollinger %B, Stochastic, Williams %R, Volume Oscillator,
  Volume Ratio, plus live OI change% when a quote exists), volatility stability
  after market open, and session phase (opening/mid/afternoon/closing/closed) to
  decide how many trades each strategy may take — instead of a fixed number.
  Opening window only counts once ATR settles near the session median
  (stabScore > 0.6); closing window +1, quiet afternoon -1. Decision cached per
  new candle. Overrides the manual cap when enabled. OI context passed from the
  live quote cache via `liveOICtx(r)`.
- **Trade-time gates** (new toolbar row "Trade times:"): "Start trading after"
  and "No trade after" `<input type="time">` IST selectors, each with an enable
  checkbox. New entries are blocked before the start time and from the no-trade
  time onward. Helpers `istMinuteOfDay`/`timeToMin`/`timeGateOk`/`liveTimeGateOk`
  in autoexperiment.v13.js; candle timestamps are IST wall-clock encoded as naive
  UTC so UTC fields read directly as IST. Wired into `backtest` (entry gate by
  candle time) and live `allowedTradesFor` (returns 0 outside the window);
  included in the backtest cache `oKey` so cached results respect gate changes.
- **Verification:** `node --check` passes for autoexperiment.v13.js and
  aitrades.js; time-gate helper tests 14/14 pass (`/tmp/opencode/timegate_test.js`);
  AI engine synthetic tests 6/6 pass (strong opening ≥5 trades, choppy afternoon
  ≤4, backtest ≥1, OI rising never reduces). Served page on port 8081 confirmed to
  contain the new UI and `?v=22`/`?v=61` cache-busters.
- **Deduplication fixes (earlier in this session):** `push` in `runExperiment`
  collapses per symbol x template x strike to the best-scoring timeframe
  (`stratKeyOf`/`stratSeen`); `deployResult` updates an existing AE strategy
  instead of appending; `strategies.js` `loadSaved()` dedups localStorage
  (`algodhan_strategies_v1`).

### Changes made in THIS session (backup `47algodhan`) — Auto Experiment:
### run/removeAll race + progress bar + <10 ms engine
- **Bug fixed: Run Experiment stopped working after "Remove All"**
  (`static/autoexperiment.v13.js`). Root cause: a stale, in-flight network run
  could commit its results after `removeAllResults()` emptied the list. Fix:
  a run-generation counter `_runGen` that is bumped by `removeResult`,
  `removeAllResults`, `removeSelectedResults` — a superseded run now silently
  exits at its `isSuperseded()` check instead of repopulating results.
- **Re-entrancy guard:** `runExperiment()` now bails with a console warning if a
  run is already in flight (`_running`), so the button can no longer start
  overlapping runs.
- **Progress bar during auto experiment** (`templates/index.html` +
  `static/autoexperiment.v13.js`): new `#aeProgressWrap` / `#aeProgressBar` /
  `#aeProgressPct` / `#aeProgressLabel` under the Run/Remove button row, driven
  by `setRunProgress(label, pct)`. Phase-1 network work sweeps 0–90 %, Phase-2
  local backtests 90–99 %, done = 100 %. Run button (`#aeRunBtn`) shows
  "Running..." and is disabled during a run via `setRunButton(running)`.
- **Speed: strategy creation + backtest now ~5–11 ms** (10 ms budget). Changes:
  - Client caches: `_contractsCache` (option chains, 15 s), `_optCandleCache`
    (option-premium candles, 30 s, opt-in via `useCache` flag in
    `candlesForOption` so live paper trading still fetches fresh), and
    `_backtestCache` (30 s, capped at 3000 entries via `_cacheSet`).
  - `backtestCached(fTpl, candles, opts, seriesKey)` keys on template +
    entry-extra JSON + candle-series identity + universal options.
  - Phase-1 fetches (underlying + strikes + option candles) run **in parallel**
    via `Promise.all`; strike-expansion pre-fetches contracts in parallel.
  - Option-chain retry backoff reduced `2000*attempt` → `400*attempt`.
- **Verified** with jsdom harnesses (`/tmp/opencode/testbed/`): second run
  ~5–11 ms internal, cached run makes 0 new fetches, removeAll mid-run leaves
  results empty, re-run after removeAll still completes correctly.
- Bumped script cache-bust `autoexperiment.v13.js?v=14` → `?v=15` in
  `templates/index.html`.

### What exists (fully working)
- Flask server (`app.py`) + REST/WebSocket API, gzip compression middleware.
- WebSocket market feed patched (`_patch_marketfeed`) with bounded backoff,
  keepalive pings, reconnect on HTTP 429 / 806, and FULL-mode quotes.
- Option chain built **instantly** from scrip master + WebSocket quote cache
  (`_build_oc_instant`) — no Dhan `/optionchain` REST on first paint.
  LTP / change / OI / Volume / Bid-Ask / IV all stream via FULL packets.
  Greeks (delta/theta/gamma/vega) filled by a slow background REST refresh.
- F&O stock resolution (`_resolve_fno_underlying`): frontend sends equity spot
  (NSE_EQ) + symbol name, backend maps to the derivative underlying (FUTSTK /
  NSE_FNO) via the Dhan scrip master CSV (`https://images.dhan.co/api-data/api-scrip-master.csv`,
  cached to `%TEMP%/algodhan_scrip_master.csv`, ~26 MB).
- Expiry lists: 24h RAM cache + background warm-up at connect for main indices;
  stale-list fallback so the UI never blocks on Dhan.
- Per-category request throttle (`_THROTTLE_STATE`): quote 1/s, option_chain 1/3s,
  expiry_list 1/2s, historical 1/4s. Rate-limit cooldown (`_RL_COOLDOWN_SEC=15`).
- Paper trading, trailing TP, market-watch keep keys, indicator strategies
  (RSI breakout, EMA crossover, MACD, Bollinger, etc.), cross-symbol detection,
  auto-experiment runner.

### Changes made in the LAST session (this backup)
- **Option chain Auto-refresh toggle** (frontend only, `templates/index.html`):
  - New `Auto` button next to the `Refresh` button (`id="ocAutoBtn"`,
    `onclick="toggleOCAutoRefresh()"`).
  - `startOCFastRefresh()` polls `fetchOC(cur, true)` every **10 ms** for
    whichever symbol is selected (works for indices and F&O stocks).
  - `ocFastBusy` guard prevents overlapping requests (only one in-flight fetch).
  - `fetchOC(expiry, force)` gained a `force` param to bypass the cache so Auto
    actually re-fetches from the server instead of serving stale cache.
  - Auto mode is reset OFF when switching tabs away from the option chain.
  - **Bug fixed:** busy flag was never cleared on the server `"loading"` response,
    which silently killed the Auto loop. Now `ocFastBusy=false` is set in the
    loading branches too.
  - **Bug fixed:** switching symbols briefly put a placeholder in the expiry
    dropdown, and the old invalid-expiry check called `stopOCFastRefresh()` and
    permanently turned Auto OFF. Now invalid ticks are skipped, not stopped, so
    Auto continues on the new symbol.

### Changes made after the last backup (this session)
- **Tick-based candle builder** (frontend, `static/indicators.js`) — makes the
  candlestick chart update from live WebSocket ticks instead of waiting on a
  1-second REST poll:
  - `IndChart.patchLastBar(ltp, tf)` is now a real tick candle BUILDER: same
    bar window → stretches the current candle's high/low/close; **new bar
    window → immediately opens a fresh candle** (open=high=low=close=ltp) from
    the first tick instead of `return`ing and waiting for the poll (this was
    the visible 1–2 s lag vs Dhan).
  - Stale ticks (older than the current window) and large gaps (market closed /
    symbol switch) are ignored so a just-closed bar never gets a fake wick.
  - Realtime REST poll interval cut from **1000 ms → 30000 ms**
    (`realtimeInterval`), so during live market the chart no longer refetches
    `/api/candles` every second (major Dhan rate-limit relief). The 30 s poll
    stays as a slow backfill/check; the WS push + `applyQuotes` →
    `patchLastBar` path now drives the live candle.
  - Bumped `indicators.js` cache-bust version to `?v=33` in
    `templates/index.html`.
  - **Note:** the effective update speed is still capped by Dhan's own feed
    latency (~1 s; the server pushes ticks to the browser every 20 ms via
    `_BCAST_INTERVAL`). The local candle maker removes the extra 1–2 s REST
    round-trip delay, not Dhan's feed latency.

### THIS session (backup `39algodhan`) — Auto Experiment: daily Top Gainers /
### Top Losers + all Indices
- **New "Top Movers" control in the Auto Experiment section** (frontend only,
  `static/autoexperiment.js` + `templates/index.html`):
  - `#aeMoversToggle` button — **manual** ON/OFF (`Top Movers: OFF` / `ON`).
    When ON, the daily top gainers/losers + (optionally) all indices are merged
    into the experiment symbol set so auto-experiments AND paper trading run on
    them automatically every poll.
  - `#aeMoversGainers` / `#aeMoversLosers` — number inputs: how many of the
    daily top gainers / top losers to include (default 5 each).
  - `#aeMoversIndices` checkbox — "Include all indices" (default checked).
  - All three inputs are **gated**: disabled + dimmed until the toggle is ON.
  - `#aeMoversList` — an **always-visible live list** showing the current Top
    Gainers (green), Top Losers (red) and Indices (gold) with their live
    `change%`, refreshed every 1.5 s poll and on every live quote push
    (`applyQuotes` → `renderMoversList`).
  - **Top Gainers / Top Losers contain ONLY F&O stocks** — indices are excluded
    from the mover lists and shown only in the dedicated "Indices" section
    (the index `inst === 'INDEX'` symbols are filtered out of `byId` in both
    `topMoverSymbols()` and `renderMoversList()`).
  - State (`movers: {enabled, gainers, losers, includeIndices}`) is persisted
    in localStorage, sanitised on load, and gated via `applyMoversToUI()`.
- **Frontend caching fix** (`app.py`): static `.js` files were served with
  `Cache-Control: public, max-age=86400` and the preview proxy ignores the
  `?v=` query string in its cache key — so users kept running stale JS for 24 h.
  Now `.js` files are served with `public, no-cache, must-revalidate` (revalidate
  via ETag/Last-Modified); non-JS static keeps the long cache. As a belt-and-
  braces measure the auto-experiment script was renamed to
  `static/autoexperiment.v13.js` (fresh URL path → fresh fetch).
- Verified with a jsdom harness: toggle ON/OFF, input gating, and the rendered
  gainers/losers/indices lists all behave correctly (indices never appear as
  gainers/losers).

## Known Issues / Important Notes for the NEXT session

1. **Dhan rate limiting is the #1 recurring problem.** The logs show heavy HTTP
   429 rejections on the WebSocket feed and empty-body failures
   (`code=None type=None msg=None`) on REST. Causes: WS reconnect loop,
   bulk FULL-mode subscription of all option strikes, and parallel REST calls
   when switching symbols. A **10 ms Auto refresh will hit this limit hard** —
   the backend throttle caps effective option_chain refresh at ~1 req/3s. If
   errors appear, raise the interval (e.g. 500–3000 ms).
2. **`/api/expiries` 500 → "Error loading expiries"** on F&O stocks happens when
   the account is rate-limited: `fetch_expiry_list` retries 3x then raises
   "Dhan API unavailable for expiry list" (data_fetcher.py). It is transient,
   not a permanent failure; the next switch usually succeeds (stale cache).
3. **Scrip master freshness**: option strike map (`oc_map`) and F&O resolution
   depend on the scrip master CSV. Symbols missing from the master
   (e.g. `TATAMOTORS` in some copies) fall back to a slow REST path or fail to
   resolve; verify the CSV downloaded correctly after a restart.
4. `TATAMOTORS` was absent from the scrip master copy used during testing — if
   the user reports it missing, re-check the CSV download.
5. Dhan credentials must be valid; expired/invalid tokens produce DH-901 /
   DH-906 and the UI shows "Not connected to Dhan" or repeated 401s.
6. **Top Gainers / Top Losers need live quotes.** The movers list and the
   top-mover experiment selection are computed purely client-side from the live
   quote cache (`clientQuotes`, populated by the REST poll + WebSocket feed).
   Without a Dhan connection the list shows indices with `--` and a
   "No live quotes yet" note — this is expected, not a bug.
7. **Quote keys**: index quotes are keyed `IDX_I:<id>` (backend `_ws_cache_key`),
   F&O/equity quotes use the bare `<id>`. The movers code follows this, so a
   symbol like `ABB` (NSE id 13) is never confused with `NIFTY 50` (IDX_I id 13).

## Testing & Verification Checklist

- Start server, connect with real Dhan credentials.
- Open option chain for an index (NIFTY 50) and an F&O stock (e.g. ABCAPITAL) —
  chain should render instantly with live LTP/OI/IV from WS.
- Enable `Auto` refresh; switch between several symbols — Auto must keep running
  (no manual Refresh needed) and reset only on tab switch / explicit click.
- Watch server log for HTTP 429; if flooding, increase Auto interval.
- **Top Movers**: toggle `Top Movers` ON in Auto Experiment — the always-visible
  list must show only F&O stocks under Top Gainers / Top Losers, and all indices
  under Indices. Set counts (e.g. gainers=3, losers=2) and uncheck "Include all
  indices" — the list must update. Click `Run Experiment` — the movers must be
  included in the experiment symbols.
- **Cache check**: after editing any `static/*.js`, reload the page — the server
  now serves JS with `no-cache, must-revalidate`, so changes appear immediately
  without a hard refresh.

## File Map (all committed)

- `app.py` — Flask API server, WS feed patch, scrip master, option chain/expiry
  endpoints, quote cache, TTL cache, auto-research.
- `broker.py` — Dhan SDK wrapper (connect, order placement, option chain access).
- `data_fetcher.py` — DataFetcher: candles, expiries, option chain, quotes,
  rate-limit handling, IV cache.
- `charts.py` — charting helpers (candlestick / option-chain charts).
- `main.py` — legacy Tkinter desktop app (not used by the web UI).
- `templates/index.html` — entire single-window web UI (HTML + inline JS).
- `static/*.js` — indicators, strategies, papertrade, crossdetect, autoexperiment.
- `static/autoexperiment.v13.js` — auto-experiment runner (renamed from
  `autoexperiment.js` to bust the preview proxy's cache; includes the daily
  top gainers/losers + indices "Top Movers" auto experiment).
- `static/vendor/` — lightweight-charts, chart.js, annotation plugin.
- `requirements.txt` — dhanhq, pandas, flask (plus `flask_sock`, `websockets`
  needed at runtime).
