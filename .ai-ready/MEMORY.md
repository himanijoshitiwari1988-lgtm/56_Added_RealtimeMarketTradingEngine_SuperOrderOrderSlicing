# 71algodhan — Session Memory / Resume Notes

> This file records where the project left off so a new session can resume
> quickly. Read this first, then `SESSION.md` / `CHANGELOG.md` for project
> history.

## Update (2026-09-01) — AST "Open Chart" on running trade now shows ENTRY/SL/TP/live-PnL lines

**User report:** in AST (Strategy tab), clicking "Open Chart" on a running trade
showed a bare candlestick chart — no entry/SL/PnL, even though the feature
"already existed". Root cause: `AISmartTrading.openChart(id)` opened the
STRATEGY's symbol (underlying) instead of the position's EXECUTION (strike)
symbol, so `onChart()` in `syncTradeChartLines()` never matched and drew nothing;
plus `syncTradeChartLines()` only read the ACTIVE paper engine via the
`PaperTrade` facade, while AST executes on the BASE `papertrade` engine.

**Shipped (`aismart.js?v=116`, `templates/index.html`):**
- `AISmartTrading.openChart(id)`: if a position is OPEN for the strategy, opens
  the chart on the position's execution symbol via `openOptionChartBySid(sid,
  exch, inst, name, ocId, ocExch)` (strategy TF applied first via setChartTf),
  so the strike candles load and the trade lines draw; falls back to the old
  dropdown-symbol behavior when no position is open.
- `syncTradeChartLines()` in index.html: refactored into `drawPos()` /
  `drawManual()` helpers (identical line logic: ENTRY, live-P&L cyan line with
  ₹/%, SL + OVERALL SL, TP, TRAIL TP) and now ALSO iterates the base
  `TabEngines.papertrade.papertrade` engine's open positions using the same
  `"pe:papertrade:"` key prefix — dedupes cleanly against the facade pass when
  the active engine already IS the base one.
- Existing infra reused as-is: `IndChart.setTradeLines()`/`clearTradeLines()`,
  `liveLineTitle()` (CHART <ltp> · ±₹pnl (pct) · CUT@<trail>), `trailSlDisplayLevel()`,
  `overallSlLevel()`, `trailArmed()`, `liveQuoteForSymbol()`, `tradeChartPrice()`.
- Verified: `node --check static/aismart.js` + extracted `syncTradeChartLines`
  both pass; disk MD5 == served MD5 for aismart.js and index.html; v116 live.

**Note:** user must reload the page for v116; lines only draw while the chart's
symbol (selectedSymbol.id/exch) equals the position's symbolId/symbolExch, and
they vanish automatically when the position closes (setCandles clears the
`_tradeLines` registry on symbol switch).

## Update (2026-09-01) — AST "Ultrafast Live Feed" checkbox (in-browser live candles, <5ms reads)

**User request:** a 100%-working ultrafast data function (<5ms) for the AST
engine, gated by an enable/disable checkbox. When the checkbox is ON the normal
Data Pool (REST /api/candles) path becomes inactive and strategies run + place
trades on the new live function instead.

**Shipped (`static/fast_live.js?v=1` new, `aismart.js?v=115`,
`templates/index.html`):**
- New `static/fast_live.js` → `window.FastLive`: a purely client-side per-symbol
  live candle store. Initial history seeded ONCE per (symbol, timeframe) via
  `StratEngine.fetchCandlesFor` (fallback `HftPool.getCandles` — this also
  subscribes the symbol on the server WS feed); after that every incoming /ws
  tick (`FastLive.tick` hooked in `mergeClientQuotes`) rolls/updates the forming
  bar in memory. `FastLive.candlesFor(sym, tf)` resolves synchronously from
  memory (<1ms) once seeded; `patchLive()` re-slides the array only when the
  close moved (keeps the strategy's per-array indicator caches valid). Quote-key
  mapping mirrors the server (`IDX_I:<sid>` for indices, else `<sid>`).
- index.html: new `astFastData` checkbox + `astFastDataInfo` span in the AST
  monitor toolbar (next to the Data Pool toggle); script ref added;
  `aismart.js?v=115`.
- aismart.js: `state.fastData` (default false) + migration; `onFastDataInput()`
  handler (enable → `FastLive.reset()` + `setEnabled(true)`), `syncFastDataUI()`
  restores checkbox/status + `FastLive.setEnabled(state.fastData)` on boot and
  refreshes the "ON - N live series" count each poll; fast path in
  `candlesForInstrument()` and `confirmCandlesFor()` (both/option/underlying
  kinds) — when `state.fastData` is ON the Data Pool REST path is fully bypassed
  (no `SE.fetchCandlesFor`), strategies + filter mode + Data Pool readout all
  read the in-browser live series. Exposed as `AISmartTrading.onFastDataInput`.
- Perf proof already visible in the UI: `astPerfInfo` ("Tick: Xms for N
  strategy(s)").

**Notes / limitations:** seed is one-time per symbol+tf (first evaluation waits
for it, then sub-ms reads); if a strike's history is <10 candles the fast path
returns null and skips (no underlying fallback in fast mode — premium-only
semantics); live bar updates depend on the /ws tick stream (needs market open +
symbol subscribed); OFF returns to the exact previous Data Pool behavior.

## Update (2026-09-01) — "Both (spot + premium)" run-in option for F&O stocks and commodities (AST only)

**User request:** add the "Both" option that indices already have to the
"Strategy should be run in" dropdowns for Commodities and F&O stocks, in both AE
and AST engines. During investigation it was found the AE (autoexperiment.v14.js)
run-in/trade-in dropdowns are DEAD UI (no `onRunInInput`/`onTradeInInput`, no
`state.runIn`/`state.tradeIn` — dropped in the v14 rewrite). User chose to only
add it to the AST engine.

**Shipped (`templates/index.html` only — no JS change needed):**
- `astRunInFno` (F&O stocks) and `astRunInComm` (commodities) now offer
  `<option value="both">Both (spot + premium)</option>`.
- AST engine already fully supports `'both'` for every instrument type:
  `runInMode()` passes it through (aismart.js:1458), `resolveInstruments()`
  builds `{kind:'both', symbol, contracts}` (~2934), `candlesForInstrument`
  evaluates on the spot chart with the premium series fetched separately
  (`confirmCandlesFor`, Data Pool only — entry fires on spot, no separate
  premium gate), `executionSymbolsFor` executes per trade-in (F&O → premium
  option only, commodity → its own trade-in dropdown), paperrun `runInModeFor`
  mirrors it, and `readRunInUI`/restore handle the value.
- No `?v=` bump (no JS changed).

**Behavior note for the user:** with run-in "Both" for F&O stocks the strategy
evaluates on spot candles and executes on the option premium contract (trades
only on premium, never both) — the Running Strategies list shows the spot row
plus the picked execution strikes by design. Commodities with "Both" need a
resolvable MCX option chain; otherwise the symbol is skipped with a log warning.

## Update (2026-09-01) — AST "Place trades based on Indicator filters: All together (strict AND)" run mode

**User request:** next to the Run Paper Trading button add an auto button named
"Place trades based on Indicator filters: All together (strict AND)", each with
an enable/disable checkbox that mutually excludes the other (one mode ON → the
other button fades/inactive). When enabled, the engine monitors the selected
universe (top gainers/top losers, NIFTY trend-following stocks/strikes, or chart
symbol — "jis bhi method se") and places a trade only when ALL selected
Bullish/Bearish indicator filters pass together on the symbol/instrument chart
(strict AND). All other AST settings (SL, trail TP, fixed TP, lots, margin, AI
risk, time gates) remain identical to normal mode.

**Shipped (client-only):**
- `templates/index.html` (run-button row after Selected Strategies): added
  `astRunPaperModeCb` (Normal mode checkbox, default ON) + `astRunPaperBtn`
  (existing), `astFilterModeCb` (Indicator-filters mode checkbox) +
  `astFilterPaperBtn` (new "Place trades based on Indicator filters: All
  together (strict AND)" button). Bumped `aismart.js?v=107`.
- `aismart.js` (AST):
  - `defaultState.filterMode` (bool). `applyRunModeUI()` syncs the two
    checkboxes + fades/disables the inactive button; wired into
    `applyUniversalToUI` + `boot`.
  - `onRunModeToggle(mode, checked)`: mutual exclusion — exactly one mode
    active; unticking one switches to the other.
  - `runFilterPaper()`: like `runPaper` but sets `state.filterMode = true`;
    warns when no Bullish/Bearish filter is selected.
  - `filterModeStrategies()` / `filterStrategyFor(sym, side)` /
    `filterSectionHas(side)`: one synthetic strategy per universe symbol, side
    from NIFTY trend direction (trend mode) or live daily change% (gainers →
    bullish CE, losers → bearish PE); symbols whose side has no selected filter
    section are skipped. Strategy carries `entry = ema(9) > -1e12` (always true)
    + `entryExtra` = all direction-matched filter conditions, marked
    `_filterBuilt: true` + `_bindSym: symId:exch`.
  - `tickBody`: `strategies = state.filterMode ? filterModeStrategies() :
    activeStrategies()`; filter-mode diag when none; inner loop skips
    non-bound instruments BEFORE any candle fetch, and skips option instruments
    whose CE/PE side ≠ strategy cat.
  - `workingStrategy`: `_filterBuilt` strategies are returned as-is (no
    re-append of global filters). `entryFireAt`: `_filterBuilt` strategies
    ALWAYS dispatch to `entryFireAllInOne` (strict AND), regardless of
    `state.allInOne`.
  - `executionSymbolsFor(instr, s)`: filter-built strategies pin the option
    side (`{ optionType: CE|PE }` to `contractsFor`, and filter mixed
    `instr.contracts` to the matching leg) so a bullish filter strategy always
    buys CE, bearish always PE.
  - API exports: `runFilterPaper`, `onRunModeToggle`.

**Running Strategies view (same update):** the Paper Trade tab's "Running
Strategies" heading is now "Running Strategies / Indicator filter based trades".
- `aismart.js` `runningStrategies()` returns `filterModeStrategies()` when
  `state.filterMode` is ON, so the list shows one row per monitored universe
  symbol (not empty as before).
- `paperrun.js`: strategies carry `filterBuilt` flag → rows/detail show an
  "Indicator filter" tag; `chartsForStrategy` now ALWAYS appends the fetched
  selected premium strikes for AI Smart strategies (even spot-run F&O stocks) so
  the monitored/traded strikes are visible in both filter and normal modes.
  Bumped `aismart.js?v=108`, `paperrun.js?v=21`.

**Notes:** synthetic filter strategies are never persisted/rendered; settings
snapshots use the stable `flt:<side>:<id>:<exch>` key so they do not accumulate.
Sub-5ms per-instrument eval via cached aligned series; bind guard placed before
candle fetch so the strategy×instrument cross-product stays cheap. AE engine
unchanged for this feature (its "all together" checkbox is separate).

## Update (2026-09-01) — Indicator-filters mode: ONE strategy, filters in the PRIMARY entry (strict AND), no entry-extra

**User request (latest fix):** filter mode must NOT create one strategy row per
symbol ("bahut sare running strategies"); there is exactly ONE running strategy.
ALL selected Bullish/Bearish indicator filters live in its PRIMARY `entry` as an
AND-gated array; the `entryExtra` section is removed for filter mode (it stays
only for normal strategies); entry fires only when EVERY selected filter passes
together on the symbol chart. The "none" entries in the detail view were
confusing and must not appear as filters.

**Shipped (client-only, `aismart.js?v=109`; `paperrun.js?v=21` already live):**
- `aismart.js`:
  - `filterModeStrategies()` now returns EXACTLY ONE synthetic strategy
    `id:'flt:all'` named "Indicator filter based trades (all together)" with
    `entry = conds` (array of ALL selected filter conditions), `exit:null`,
    `entryExtra:[]`, `exitExtra:[]`, `entryThreshold: conds.length`,
    `_filterBuilt:true`. Removed the per-symbol `filterStrategyFor` /
    `filterSectionHas` / `_bindSym` machinery.
  - New `allSelectedFilterConditions()`: every ticked Bullish+Bearish sub-filter
    becomes a mandatory AND gate via `buildFilterConditions(tpl, state.filters)`
    on a neutral ema(9) template — no direction-matching, no opposite-side
    zeroing, so a ticked Bullish OR Bearish filter is always enforced on every
    monitored symbol.
  - `entryFireAt` (and `entryFireAllInOne`): when `s.entry` is an ARRAY, entry =
    `evalCondAll(s.entry, i, candles)` (strict AND over the whole array; empty
    array ⇒ no entry); gap check guarded to non-array entries. `_filterBuilt`
    strategies always dispatch to `entryFireAllInOne`.
  - `tickBody`: `strategies = state.filterMode ? filterModeStrategies() :
    activeStrategies()`. The `_bindSym` guard is inert for the single strategy
    (no `_bindSym`), so EVERY instrument in the selected universe (spot, both,
    and each CE/PE premium strike) is evaluated against all filters together —
    no `_bindSym`-keyed per-instrument CE/PE skip.
  - `executionSymbolsFor(instr, s)`: removed the cat-pinned `fltSide`. Side for
    spot/both F&O contracts now flows through the EXISTING `contractsFor` logic
    (NIFTY trend → mover change% → active filter direction → strategy direction
    → user option-type selector); option instruments keep their own `optionType`.
- `paperrun.js`:
  - `condLabel` rewrite: candle-level gates (`volUp`/`volDown`/`fakeBreakout`/
    `reversal`/`incUp`/`incDown`) now render readable phrases ("Volume surging
    up", "Fake breakout", ...) instead of the old "none"; new logic phrases for
    `crossUpNow`/`crossDownNow`/`closeCrossAbove`/`closeCrossBelow`/`gapUp`/
    `gapDown`/`asrSupGapUp`/`asrResGapUp`; `indSettingsShort` appends compact
    settings (`EMA (len 9)`) so "EMA > -1e12" placeholders are gone.
  - `showStrategyDetail`: exit shows "Managed by SL / Trail TP / Fixed TP" when
    the strategy has no exit conditions; filter rows show neutral `ALL` side tag
    (purple) instead of a misleading green `LONG`.

**Notes:** `evalCondAll` over the entry array is the strict-AND gate — a single
passing filter is NOT enough, matching the button label. `condLabel` "none" was
the display bug the user saw: candle gates carry no `indId`, so they previously
rendered as "none" even though they were active filters — now they show their
real phrase. `flt:all` runs on `tf:''` → `pickTimeframe` picks the first enabled
timeframe as in normal mode.

**User clarification (same update, shipped `aismart.js?v=110`):** AST has TWO modes — (1) Strategy mode (AE-imported / ticked strategies) and (2)
Indicator-filters mode (only ticked Bullish/Bearish indicator filters are
read/monitored, trades placed only from them). The user explicitly said NO
separate section should be added for "only selected filters monitored" — that
was explained for understanding only. The requirement is exactly what the engine
does: in Indicator-filters mode AST reads/monitors ONLY the selected filters
(`allSelectedFilterConditions()` → `buildFilterConditions` builds only ticked
gates; the strategy Details "Entry" shows only those conditions via `condLabel`).
Removed a wrongly-added filter list in the Selected Strategies section (that
belongs to strategy mode). `runFilterPaper()` now logs the EXACT selected entry
filters (via new `selectedFilterNames()`, which excludes research-stream flags
like Candlestick/Elliott — those gate AI research, not entries), so pressing the
button confirms which filters are monitored. `filterSummary()` reuses
`selectedFilterNames()`.

## Update (2026-09-01) — HFT "execute on" enable/disable checkbox (Candle Close)

**User request:** the HFT (ultrafast) row's "execute on Candle Close" must be
driven by a real enable/disable checkbox that works 100% — enabling/disabling the
100ms scanner behavior, mutually exclusive with normal execution, persistent,
and UI-synced.

**Shipped (`aismart.js?v=111`, `templates/index.html`):**
- New `astHftExecOnCb` checkbox next to the "execute on" select (default checked).
  Checked = scanner forces every `cmpType:'candle'` strategy condition to be
  tested against the chosen candle value (`hftExecOn`, default `close`).
  Unchecked = override disabled; each condition uses its own `candleKey`
  (same as the normal 1500ms poll).
- `defaultState.universal.hftExecEnabled: true`; migration default added
  (`if (typeof !== 'boolean') = true`); `readUniversal()` reads the checkbox;
  `applyUniversalToUI()` restores it on boot/load.
- `hftScan()`: `_hftExecOn = (u.hftExecEnabled !== false) && valid(u.hftExecOn)
  ? u.hftExecOn : null` (prev saved/restored as before). Consumed at `cmpReadAt`
  via `const k = _hftExecOn || cond.candleKey || 'close'`.
- `syncHftUI()`: checkbox + select fade/disable when HFT master is off; the value
  select additionally fades/disable when its enable checkbox is unchecked, so the
  UI always reflects the active override.
- Mutual exclusion of run modes unchanged; timer start/stop logic untouched.

**To verify (after user reload, Dhan/WS reconnect on 8081):** toggle the checkbox
with HFT ON — checked forces close-based reads in the 100ms scan, unchecked
returns to per-condition candle keys; refresh page → state persists.

## Update (2026-09-01) — Sahi-style two-layer NIFTY trend filter (overall + current) everywhere

**User request:** like the Sahi broker app, filter the NIFTY trend into OVERALL
and CURRENT layers, and assign that filtered trend everywhere the NIFTY trend is
needed / options are connected to it. Confirmed semantics: **trade only when BOTH
layers agree** (BULL+BULL = bullish, BEAR+BEAR = bearish, anything else = NO
directional bias), applied at **every NIFTY-trend touchpoint**.

**Shipped (`aismart.js?v=112`, `smart_ntrader.js?v=49`):**
- `aismart.js`:
  - `niftyTrendAnalysis()` now also computes the Sahi-style layers (mirrors
    `smart_ntrader.detectNifty`): OVERALL = close vs EMA50 + EMA50 slope
    (BULL/BEAR/RANGE); CURRENT = EMA9/21 separation% (>0.05) + EMA9 slope
    (BULL/BEAR/FLAT). Returned as `overall`/`current`, propagated through
    `combineNiftyTfs` (5min primary) and `niftyBias` single-tf path.
  - New `niftyOperativeDir(n)` helper: `bullish` only when overall==='BULL' &&
    current==='BULL'; `bearish` only when both 'BEAR'; else null.
  - Operative dir now drives: entry/exit gates (`niftyGateMet`/`niftyGateMetSync`),
    `_lastNiftyDir` (poll + boot), trend-following drop scan, gate status paint
    in `updateNiftyBiasStatus`. `_lastNiftyDir` being operative automatically
    filters CE/PE auto side (`autoRunInSide`), option leg picker (`contractsFor`
    ntSide), NIFTY trend stock picker (`niftyTrendSymbols`/`pruneNiftyTrendSymbols`)
    and the trend list UI. `_niftySummary` now shows "overall X / current Y" (+
    "no bias" when mixed); GIFT/VIX enhancement still only adjusts the displayed
    ensemble `dir`, decisions come from the layers.
- `smart_ntrader.js`:
  - New `niftyOperative()` helper (same both-agree rule on `state.nifty`).
  - Applied at: `trendSideQualify`, `condGateEval` (mixed/FLAT → zone-only join
    branch), `computeActive` neutrals (`condFor(niftyOperative())`), `decideEntry`
    (now takes full `niftyTrend` and requires overall+current agreement),
    trend-drop scan, BB%b auto-alert targets/side, fetched-stocks display, and
    the COND/NIFTY status line. Display badges still show both layers.

**Notes:** `detectNifty` (smart_ntrader) already produced overall+current; AST's
single weighted `dir` (score/MACD/RSI/Stoch/DI/volume ensemble) is kept for the
displayed confidence/strength but no longer gates decisions on its own. Mixed
regime (overall disagrees with current) behaves like the existing FLAT path in
cond gates (zone parts still work); CE/PE auto-picking and trend stock picks are
blocked. `enhanceNiftyBias` GIFT/VIX votes preserved via Object.assign.

**To verify (after user reload):** NIFTY status shows overall/current; when they
disagree the trend list shows "unknown", auto CE/PE side falls back to universe
classification, and gates don't fire.

**Follow-up fix (`aismart.js?v=113`, `smart_ntrader.js?v=50`):** the CURRENT
(momentum) layer used a hard 0.05% EMA9/21-separation dead-band. Live NIFTY was
genuinely bullish at the EMA50 layer (OVERALL=BULL) yet CURRENT stayed FLAT
(separation ~0.016%), so the two layers NEVER agreed -> operative dir null ->
"waiting for the live feed" and NO trend-following F&O stocks picked anywhere
(AST trend list / Auto Select side / leg pick, smart_ntrader qualify + decideEntry,
AE via _lastNiftyDir). Fixed CURRENT in BOTH engines to direction + slope only
(no % band): e9>e21 && slope9>=0 -> BULL, e9<e21 && slope9<=0 -> BEAR, else FLAT.
Verified on live 5min/1min: OVERALL=BULL CURRENT=BULL OPERATIVE=bullish.
`renderNiftyTrendList` now also tells apart "no data yet (live feed)" vs
"overall X / current Y - layers disagree -> no directional bias".

**Follow-up (`aismart.js?v=114`, `smart_ntrader.js?v=51`):** user asked to DROP the
FLAT blocking - when CURRENT is FLAT, stocks must be selected from the OVERALL
trend. Changed both `niftyOperativeDir`/`niftyOperative`: direction = OVERALL
(EMA50) regime; CURRENT only VETOES on a genuine CONTRADICTION (overall BULL +
current BEAR, or overall BEAR + current BULL). CURRENT=FLAT = no vote -> follow
OVERALL. Only overall RANGE (or contradiction) -> null / no bias. So "Bullish
(overall) / Flat (current)" now picks bullish stocks. Verified all 8 combos.


## Update (2026-09-01) — "All Indicators & Filters Together" entry (AST + AE), enable/disable checkbox

**User request:** trades still open into straight loss even when all entry
conditions appear met; indicators/filters were NOT being used together for the
entry. Wanted: in BOTH the AI Smart (AST) and Auto Experiment (AE) engines a new
function (replacing the old partial-pass logic) so the entry uses ALL selected
indicators/filters together — behind an enable/disable checkbox. Enable =
strategy built on the full indicator/filter set together; disable = old default.

**Shipped (client-only):**
- `aismart.js` (AST):
  - New `entryFireAllInOne(s, candles, i)`: strict AND of primary entry (incl.
    chain/pane/gap) + EVERY `entryExtra` condition + candlestick patterns — no
    N-of-M threshold, no partial pass.
  - `entryFireAt` dispatches to it when `state.allInOne === true` (new
    `defaultState` flag); old N-of-M path kept as the OFF (default) behavior.
  - New helpers `directionFilterConditions(tpl)` (direction-matched filter
    conditions) and `strictEntryOkAt(tpl, candles, i)` (strict all-together eval
    on any candle series).
  - Public API: `onAllInOne()` (checkbox → state + cache clear + save + log),
    `allInOneEnabled()`, `filterConditionsFor(tpl)`, `strictEntryOk(tpl,
    candles, i)`; `applyAllInOneToUI()` synced in `applyUniversalToUI` + boot.
  - Engine-settings template now captures/applies `allInOne`.
  - Data Pool "Entry" column now evaluates `workingStrategy(s)` (filters
    included) so the readout matches the live gate.
  - `signalDiag` prints `extra[N] ALL` in strict mode.
- `autoexperiment.js` (AE):
  - `state.allInOne` flag (defaultState + save + sanitize).
  - `evalEntryLive`: when `state.allInOne` AND `window.AISmartTrading.
    strictEntryOk` exist, the entry = `AISmartTrading.strictEntryOk(r, candles,
    last)` (own conditions + entryExtra + candlestick + all direction-matched
    AST filters, strict AND). OFF = old entry.
  - Public API `onAllInOne()`; `applyUniversalToUI` syncs the checkbox.
- `templates/index.html`: `astAllInOne` checkbox in the Indicator filters row
  ("All together (strict AND)"), `aeAllInOne` checkbox in the AE toolbar
  ("All indicators/filters together (strict AND)").
- Version bumps: `aismart.js?v=106`, AE now served as
  `static/autoexperiment.v14.js?v=127` (copy of edited autoexperiment.js;
  v13 still on disk but unreferenced).

**How it fixes the complaint:** with the checkbox ON, a trade can only open when
the strategy's own signal AND every selected indicator filter ALL pass on the
same bar — no partial N-of-M pass, and the Data Pool readout shows the same
result. Off = previous threshold-based default.

**Notes / still-open:** AE strict mode depends on `AISmartTrading` being loaded
(runtime check, safe if absent). Live verification still needs a page reload with
saved Dhan credentials (WS was disconnected).

---

## Update (2026-09-01) — Running Trades GROSS, Closed Trades NET (charges at close only)

**User request:** broker charges should NOT be deducted while a trade is open;
they should be deducted ONCE when the trade closes and shown in Closed Positions
(entry charges + exit charges added together).

**Shipped (client-only):**
- All running/open position displays now show GROSS P&L — no charge deduction,
  no charges column, no "gross" sub-line:
  - `paperrun.js` `tradeRowHTML` (Paper Run "Running Trades")
  - `aismart.js` `runningRowHTML` (AI Smart "Running Trades") + `renderSummary`
    unrealized ("Smart Live P&L (gross)")
  - `papertrade.js` `renderOpenTable` + `renderSummary` / `renderChart` now use
    gross `unrealizedPnl()` for the Live P&L card + equity curve
  - `smart_ntrader.js` `renderPositions` running rows + `renderSummary` unrealized
- Closed positions already recorded `netPnl = gross − charges.total` at close
  (`computeChargesForTrade` = entry side + exit side = full round-trip) — kept
  as-is. Realized P&L / charges totals all derive from that.
- Headers in `templates/index.html` updated: astRunning + ntrRun now read
  "P&L (gross)", Charges column removed.
- Bumped: `papertrade.js?v=30`, `aismart.js?v=105`, `paperrun.js?v=20`,
  `smart_ntrader.js?v=48`.

**Caveats for next session:** `unrealizedPnlNet()` (papertrade.js) is now unused
dead code but harmless. `chargesTotalForOpen` still exported (API surface).
Result: with market closed, Running Trades now matches the chart's gross 0
instead of showing a −₹77 charge loss; the charges appear only after the trade
closes, summed into the Closed Trades net P&L.

---

## Update (2026-09-01) — Strategy engine reads ONLY the chart + shared Data Pool

**Symptom reported:** strategies enter late / "indicator filter wrong read" —
the engine evaluated indicators on a per-tick live-patched candle clone whose
prices differed from the chart's rendered bars, so the strategy fired at a
different moment than the chart.

**Design shipped (client-only):**
- `HftPool.getPatched(symbol, tf, days, ttl)` (hft_pool.js): one `/api/candles`
  fetch per (symbol x tf) shared by every consumer (single-flight + TTL), and a
  single shared `patchedStore[k]` copy whose last bar is live-LTP-patched ONCE
  and reused until the raw array refetches or the LTP changes — every strategy
  on that series reads the SAME array identity + content.
- `strategies.js` fetchers now go chart-first, pool-second, engine-cache-mirror:
  `fetchCandles` / `fetchOptionCandles` / `fetchCandlesFor` / `fetchIndexCandles`
  all return `IndChart.getCandles()` when the chart is on that symbol+tf (so the
  strategy reads the exact rendered bars incl. the in-place live-patched forming
  bar), else `HftPool.getPatched`. The engine's own `/api/candles` fetches,
  `_candleInflight`, `_candleBackoff`, `_markCandleBackoff`, and per-strategy
  `candleCache` writes are GONE. `candleCache` remains ONLY as a mirror of the
  exact arrays the pool/chart returned (key `sid:exch:tf:days`) so Running
  Trades P&L (`tradeChartPrice`) and HFT fast paths read the same series.
  `liveBar` kept solely for `aismart.js` consumers (3215/3229/3243) — no longer
  used by the engine fetchers.
- `IndChart.renderedLastTwo` now matches the deployed instance by id AND settings
  (`JSON.stringify`), so a strategy whose condition uses EMA21 reads the EMA21
  line (never a same-id EMA9 instance), and `addIndicator(id, settings)` +
  `IndChart.setIndicatorSettings(id, settings)` deploy/sync the strategy's EXACT
  saved settings onto the chart — chart line and engine read always agree.
  `crossdetect.js` `readLastTwo` already goes through
  `renderedLastTwo`/`computeLastTwo`, so cross detection shares the same series.
- `autoDeployIndicators` (strategies.js) now deploys each indicator WITH the
  strategy's saved settings (entry/exit/chain/pane conditions, first occurrence
  wins per id) and re-syncs on every `start()`.

**Caveats for next session:**
- The chart's `patchLastBar` mutates its `candles` array in place and
  `IndChart.getCandles()` returns that same array, so chart-first reads always
  equal the rendered series. For OFF-chart symbols the pool's shared patched
  copy is the single source — never the live-feed quote store.
- `renderedLastTwo` falls back to `computeLastTwo` when the chart is on a
  different symbol or settings differ (compute runs on the same shared candles,
  so values stay consistent).
- Dhan/WS was disconnected at the end of the session; live verification needs a
  page reload via saved credentials.
- Bumped: `indicators.js?v=49`, `crossdetect.js?v=7`, `strategies.js?v=69`,
  `hft_pool.js?v=4`.

---

## Update (2026-09-01) — Running Trades P&L disconnected from live feed

**Symptom reported:** live feed (WS tick LTP) is delayed and Running Trades kept
showing a wrong loss.

**Fix shipped (client-only, `aismart.js?v=104`, `paperrun.js?v=19`, inline
index.html):** Running Trades / Running Positions P&L no longer reads the
live-feed quote store (`clientQuotes`) at all. A single shared
`window.tradeChartPrice(pos)` (index.html, next to `liveQuoteForSymbol`) is now
the ONE source of a position's current price used by BOTH the chart's running
P&L label (`syncTradeChartLines` -> `liveLineTitle`, label prefix now "CHART"
not "LIVE") AND Running Trades (`currentPriceForPos` paperrun,
`positionCurrentPrice` aismart, both delegate to `tradeChartPrice`). Logic: if
the position's symbol is the displayed chart -> that chart's last candle close
(returns null when the chart has no candles, so an empty chart can never
disagree); else `StratEngine.candleCache` last close. The live-feed helpers
were removed (`quoteForPos`, `posQuoteKey`, `instrumentQuoteKey` paperrun;
`positionQuote`, `positionQuoteKey` aismart). Live feed is still used ONLY for
the chart's SL/TP line clamping (`liveQuoteForSymbol`), never for P&L. So chart
running P&L and Running Trades can never diverge — with market closed and no
candle data both go blank instead of showing a stale -117.

Caveat for next session: after this fix, if the user's trade's chart HAS candles
the chart line will now show the real (possibly loss) PnL consistently with the
Running Trades row — the "chart 0 vs trades -117" divergence is gone by
construction.

---

## Update (2026-09-01) — "Strikes not available" (strategy monitor + trend)

**Symptoms reported:** "Strategies running me strikes nahi dikh rahi hain aur
nifty trend following me bhi nahi dikh rahi hai. not available."

**Root causes found (this session):**

1. **Strategy monitor "Option chain unavailable" for F&O stocks.** The strategy
   Details/monitor's strike section (`loadStrikeInfo` → `fetchStrikeChain`,
   static/strategies.js) called `/api/option_chain` WITHOUT `symbol_name`. For an
   F&O stock the server could not map the equity spot → FUTSTK, so it could not
   build the instant scrip-master chain → returned 202 "loading", and the REST
   refresh for the unresolved key never succeeded → the monitor rendered "Option
   chain unavailable. Make sure you are connected to Dhan...". Additionally
   `resolveChainExpiry` returned the OC panel's live expiry select value blindly;
   a stale/foreign date (`2026-09-01`, today) reached `/api/option_chain`, whose
   cold-cache guards let it through and armed a doomed 6-attempt Dhan refresh
   loop that re-armed the global rate-limit cooldown (log:
   `option chain refresh failed for ('option_chain', 11195, 'NSE_EQ', '2026-09-01')`).

2. **The engine path (auto_strikes) was healthy all along.** `/api/auto_strikes`
   returns success when `symbol_name` is sent (verified: INDIGO/ITC/AXISBANK →
   200, expiry 2026-09-29). The browser's engine calls all 200. So picked strikes
   populate after a reload; the "not available" was the monitor path above.

**Fixes shipped (client `strategies.js?v=68`, server `app.py`):**

- `fetchStrikeChain` now sends `symbol_name` + live `spot`; the server resolves
  the FUTSTK and serves the instant scrip-master chain (verified: INDIGO NSE_EQ
  2026-09-29 → `status success`, 21+ strikes, spot 5052). `fetchChain` (index
  strategies) also sends `symbol_name`.
- `resolveChainExpiry` now trusts the server's `/api/expiries` list; the OC-panel
  selection is only used when the server confirms it belongs to the underlying.
- Server `_start_rest_refresh` refuses a provably-invalid expiry up front
  (`_prefix_for_security` + `_refuse_bad_expiry`, via new `eq_prefix` map in
  `_build_scrip_lookups`), so a stale client can never arm a doomed 6-attempt
  Dhan chain refresh again. `_prefix_for_security` is equity-segment-only
  (numeric sids collide across segments: NIFTY idx 13 == ABB equity 13).

**Server restarted** (was needed to load app.py). The browser auto-reconnects on
reload via saved credentials (`hadCreds → connect()` at index.html:5681). Give
the user the cache-busted preview link so `strategies.js?v=68` loads.

**Still-open:** verify after user reloads (a) strategy Details strike section
shows strikes, (b) NIFTY trend list + Picked Strikes populate. If any "not
available" remains it is a different element — get the exact text/location.

---

## Update (2026-09-01)

**AST regressions: trailing SL not working + running trades disappearing.**

Symptoms reported: (1) AST Trailing SL never ratchets, (2) Running Trades list
shows empty even with open trades, (3) some trades appear in the Running list
then vanish mid-session.

Root causes found and fixed:

- **Quote eviction froze exits (`trailing SL not working`).** The client quote
  store `mergeClientQuotes` (templates/index.html) evicts stale non-watchlist
  quotes once the store exceeds 1200 keys. The server persists ~2789 subscribed
  instruments, so the store grows past the cap; a traded option strike is rarely
  in a watchlist and ticks sparsely, so 120s after its last tick it was evicted.
  `checkAutoTargetSl`/`riskScan` (static/papertrade.js:1310) skip a position the
  instant `quoteFor` returns null (`cur === null -> continue`), which froze the
  SL / trailing-SL / TP line on a held trade. Fix: eviction now skips keys that
  back an OPEN auto position in any paper engine (`openPositionQuoteKeys()` /
  `quoteKeyForPosition()`, index.html) — held-trade quotes are never dropped.

- **`_paperActiveEngine` re-routed AST to a cloned paper tab (`trades
  disappear`).** AST mirrors positions into the BASE paper engine
  (`TabEngines.papertrade.papertrade`), but every AST call used the global
  `window.PaperTrade` facade, which routes by `window._paperActiveEngine`. After
  clicking any cloned paper tab (`paperN`) that global points at that tab's
  engine: new AST entries landed in the wrong ledger AND
  `reconcileClosedPositions` (aismart.js:5366) could no longer find the
  base-engine buckets, so it deleted every AST mirror entry ("taken over by
  another engine") — running list emptied, trades vanished. Fix: added
  `basePaper()` + `astChargesOn()` in aismart.js and pinned all 15 AST
  execution/reconcile/close/reset/charges `window.PaperTrade` uses to the base
  engine (`createAISmartTrading`, ~lines 42-51; call sites in HFT loop, poll
  entry, daily-change drop, recordClosedPosition, reconcileClosedPositions,
  renderRunning, runningRowHTML, renderClosed, renderSummary, removeSaved,
  stopPosition, stopAll, resetPnl).

Both fixes are client-side; Flask serves the files from disk so no server
restart was needed. Syntax verified (`node --check static/aismart.js`, `new
Function` on index.html inline scripts); `/api/feed/status` still healthy
(`feed_up`, 2789 subscribed).

Notes / still-open:
- NIFTY trend-following daily-change drop (aismart.js:3710-3733) force-exits any
  held position whose quote `change_pct` falls below `nt.pct` (default 2.5%)
  while NIFTY direction matches — by design, but option contracts' own
  `change_pct` swings fast, so trades can "disappear" this way when the feature
  is enabled. Review threshold semantics if it keeps surprising.
- Server marks REST/chain-refresh seeded quotes `live=True`
  (`_seed_chain_quotes`, chain merge app.py:3078) which the client cannot
  distinguish from real feed ticks; a stale chain snapshot could in theory
  trigger a spurious close between real ticks. Not changed (defense-in-depth
  candidate).

## Update (2026-08-30)

**Premium-chart candle fallback (all engines): strategy never skips when the
run-in option premium chart has no candles.** When a strategy runs in Premium
mode ("Run Strategy In" = option premium chart) and the premium candles are
missing/unavailable, every engine now falls back to the underlying/spot chart so
the strategy still evaluates its indicators AND still executes the trade instead
of skipping the instrument:
- `static/aismart.js` (v=97): `candlesForInstrument` no longer returns null for
  indices/premium-only when option candles are unavailable — it sets
  `_candleFbk[instrumentId]` and returns the underlying spot candles;
  `executionSymbolsFor`/`hftTargetsFor` return `[underlying]` while the fallback
  flag is set so the paper trade executes on the underlying (live-quote fill);
  flag clears automatically once the premium candles come back. Fast path
  `hftCandlesFor` mirrors the same fallback against `SE.candleCache`.
- `static/hft_runner.js` (v=8): pooled runner "no candle data" branch now falls
  back to the underlying spot chart (via `resolveOptionSymbols`' `spotId` →
  original template symbol) and executes the pooled BUY on the underlying,
  tagged `[premium chart missing]`. `_noChain` index guard unchanged (raw index
  notional can't fit margin).
- `static/strategies.js` (v=65): container `indexTick` option leg with `<3`
  premium candles falls back to `fetchCandles(st)` (underlying strategy chart)
  and still evaluates + trades the leg; entry/exit logs tagged
  `[underlying chart - premium candles missing]`.
- `static/autoexperiment.v13.js` (v=125): AE backtest no longer skips symbols /
  strikes with a missing option chain or `oc.length < 60` — premium/both run-in
  falls back to a `premiumFbk` unit that backtests on the underlying chart
  (`runBasis='underlying'`, expanded into per-strike contracts downstream).
- Invariant preserved: index raw-notional margin guard (`_noChain`) unchanged;
  premium trades still price on the option contract wherever its data exists.

## Update (2026-08-30)

**Fixed Smart NTrader parity + commodity backfill; backed up to
`29_Fixed_SmartNTrader_BulishBearishTradeAlert`.**
- `static/smart_ntrader.js` (served v=46): NIFTY trend-following parity with the
  AST/AE engines — 60s scan (was 30s), per-tick below-threshold symbol prune,
  immediate force-exit of open positions that drop below threshold, strict
  buy-only semantics (bullish = BUY CE, bearish = BUY PE; no SELL/short
  anywhere), and an always-on `statusPulse()` poller (init `setInterval(...)`)
  so the Fetched Stocks list keeps showing set-threshold stocks even while the
  market is closed / engine stopped. Also the `enterUnderlying()` spot-vs-
  futures entry path + `premiumChart` toggle.
- `app.py`: commodity daily-candle backfill segments expanded from
  `("NSE_EQ",)` to `("MCX_COMM", "NCD_FNO", "NSE_EQ")` — commodities enqueued
  FIRST with `FUTCOM` instrument so commodity change% shows after hours.
- `static/aismart.js` (v=96) / `static/autoexperiment.v13.js` (v=122): `runIn.comm`
  accepts `'futures'` (maps to 'spot' for commodities — near-month FUTCOM is the
  underlying); `isMarketOpenNow()` gate removed from live paths in aismart.
- `static/final_strategy.js` (+168) / `static/hft_runner.js` (+74) /
  `static/strategy_container.js` (+3): AST -> Final Strategy save (sendToFinal)
  + HFT runner additions.
- `templates/index.html` (+27): AI Smart P&L / Win Rate / Realized P&L summary
  cards moved to the top of the AI Smart Trading Engine section (`astSummary`,
  ~line 988).
- **Backup:** full working tree + `CHANGES_COMPLETE.patch` (all 8 modified
  files, 540 insertions / 62 deletions) + `CHANGES_SUMMARY.txt` +
  `BACKUP_README.md` pushed as complete history (4 existing commits + new backup
  commit) to the new repo
  `29_Fixed_SmartNTrader_BulishBearishTradeAlert` on GitHub (verified via
  `git ls-remote`).

## Update (2026-08-28)

**Tied the chart trail-SL line to the live running-profit line + the Trail SL %
(the user's confirmed trailing-stop model).**
- User request: the live running profit % on the chart should be based on the
  Trail SL checkbox %, the trail SL line should slide up behind the live running
  profit with the candles, and the trade should auto-cut the moment the profit
  drops back by that trail %.
- This is exactly the existing ratchet model (BUY: `stopLoss = peak *
  (1 - slTrailPct%)`, close "Trailing SL hit" when `cur <= stopLoss`); the cut
  fires precisely when the price drops trail% off the peak. No engine change
  needed.
- Chart changes (`templates/index.html`):
  - `liveLineTitle()` now appends `CUT@<stopLoss> (trail <pct>%)` to the cyan
    live line label whenever `slTrailPct > 0`, so the running profit %, the
    checkbox trail %, and the current cut level are all visible on the chart.
  - Trail SL / SL line titles now include the actual level (`TRAIL SL 1% ·
    151.57`) so it's clear the line is tracking behind the live price.
  - Applies to PaperTrade auto positions, manual position, and AIPaperTrade.
- Verified: `node --check`; simulation — entry 150, trail 1%: SL starts 148.5,
  ratchets 149.39 → 150.08 → 150.78 → 151.57 as price climbs to 153.1, and cuts
  "Trailing SL hit @151.57" (+1.05%) the tick price drops 1.05% off peak.
- **LEFT OFF:** live browser verification — hard refresh, hold a position with
  Trail SL 1%, watch the red line ride behind the cyan live line and the trade
  close "Trailing SL hit" when profit falls 1% off its high.

## Update (2026-08-28)

**Added: live running-profit line on the chart per open trade.**
- User request: show each trade's running live profit on the chart with a line
  that slides up along with the candles.
- Fix (`templates/index.html`, `syncTradeChartLines`): new `liveLineTitle(p,
  ltp)` helper builds a label with the live LTP + running P&L (₹ signed +
  toLocaleString 'en-IN' and % off entry). For every open position drawn on the
  chart (PaperTrade auto positions, manual position, AIPaperTrade positions)
  that has a LIVE feed quote, a bright-cyan dashed `LIVE <ltp> · +₹N.NN (+x%)`
  price line is added at the live LTP. It re-renders every ~250ms throttle, so
  the line rides the live price and slides up/down with the candles. Skipped
  when the quote is not live (`liveQuoteForSymbol` returns null).
- Template-only change; no JS cache buster bump needed.
- Verified: extracted inline script passes `node --check`; served page contains
  `liveLineTitle` (4 refs). **LEFT OFF:** live browser verification — hard
  refresh, hold a position, confirm a cyan LIVE line rides the price on the
  chart showing the running profit.

## Update (2026-08-28)

**Fixed: trail-only SL opened AT the entry price (looked invisible + acted like
a fixed SL); now opens trail% BELOW entry and ratchets immediately.**
- User report (after HFT fix): trail SL line "not visible" on the chart, and
  the trail SL % "acts as an overall/fixed SL" instead of trailing.
- Root cause: with trail SL ON the engines pass `slPct=0` + `slTrailPct=x`, so
  PaperTrade's `stopLoss` started AT the entry (`entry * (1 - 0%)`). That put
  the red trail line exactly under/over the green entry line (looked missing),
  and the ratchet (`peak * (1 - trail%)`) could only engage after the price
  first climbed trail% ABOVE entry — so for small moves the SL sat frozen at
  entry, behaving like a fixed breakeven stop.
- Fix:
  - `static/papertrade.js`: new `effectiveSlPct(slPctV, slTrailV)` = `slPct>0 ?
    slPct : (slTrail>0 ? slTrail : 0)`; all 4 stopLoss creation sites (manual
    `execute` new+average, `autoEntry` new+average) now use it, so a trail-only
    stop opens trail% BELOW entry (distinct visible line) and the ratchet
    engages on the first upward tick.
  - `static/aipt.js`: same via local `effSlPct` at position creation.
  - `static/autoexperiment.v13.js`: BUY backtest trail baseSl now
    `entry * (1 - trail%)` to match live.
  - `templates/index.html`: chart SL line titles append `(no live q)` when the
    position's quote is not live in `clientQuotes` (diagnostic for the
    stale-quote case where the ratchet/close correctly do not run).
  - Cache busters: papertrade v26→27, aipt v32→33, autoexperiment v113→114.
- Verified: `node --check` all files; simulation — trail 1% entry 150 opens SL
  148.5, ratchets 149.0 → 149.49 → 150.28 → 150.97 → 151.67 as price rises
  150.5→153.2, closes "Trailing SL hit" @ 151.67 on pullback. SL always below
  the live price, sliding behind the running profit.
- **LEFT OFF:** live browser verification — hard refresh (paper v27 / aipt v33 /
  ae v114), enable AST Trail SL 1%, confirm the red dashed trail line sits below
  the entry, moves up with the price, and closed trades show "Trailing SL hit"
  in profit; if a line label shows "(no live q)", the option's live feed is
  missing and that needs the subscription investigation.

## Update (2026-08-28)

**Fixed: trail-SL line rendered ABOVE the price on the chart and seemed to
"slide" with it.**
- User report: on the chart the SL is placed above the price and the trailing
  SL sits above the market sliding along with it; trades went profit→loss and
  closed as "SL hit".
- Root cause (chart side): `syncTradeChartLines()` in `templates/index.html`
  draws the stored `p.stopLoss` **verbatim** via `IndChart.setTradeLines()`
  with no BUY/SELL side logic. The engine already ratchets the BUY stop up
  behind the peak (`peak * (1 - slTrailPct%)`) on every live tick, so on a
  pullback the ratcheted level can sit ABOVE the current price and the chart
  faithfully drew it above the market.
- Fix (`templates/index.html`): added `liveQuoteForSymbol(symbolId,
  symbolExch)` (live-feed LTP from `clientQuotes`, null unless `q.live`) and
  `trailSlDisplayLevel(p, liveLtp)` — a guard applied **before the SL line is
  placed**: BUY clamps the drawn level to at-or-below the live price, SELL to
  at-or-above. Wired into all three draw sites (PaperTrade auto positions,
  manual position, AIPaperTrade positions). The engine still closes at the true
  protection level; only the drawn line is clamped. The ratcheted `p.stopLoss`
  still slides up behind the running profit per the set trail %.
- No cache buster needed (template-only change, served fresh by Flask); no JS
  files touched.
- Verified: served page contains the new functions; extracted inline script
  passes `node --check`. **LEFT OFF:** live browser verification — hard refresh
  the preview, hold an option with Trail SL on, confirm the SL line never sits
  above the live price on pullbacks.

## Update (2026-08-28)

**Fixed: AST HFT mode trailing SL never engaged — all closes showed "Stop
loss hit" even on profitable trades.**
- User report: every closed position showed "stop loss hit"; trades that were
  in profit during the run still closed at the SL; trailing SL (set via the
  AST "Trail SL" checkbox) was not working like the manual trail TP.
- Root cause: `hftScan()` in `static/aismart.js` (the 100ms HFT entry path)
  never declared `manualTrailSLOn`, never excluded trail mode from `aiSlOn`,
  never computed `slTrailPct`, and passed NO `slTrailPct` to
  `pt.autoEntry(...)`. So every HFT-placed position got a FIXED entry-based
  auto-SL (`slTrailPct: 0`) that never ratcheted — it closed at the fixed SL
  (reason "Stop loss hit") even when the peak had been well above entry. The
  main tick path (`tickBody`, line ~3184) and the AE engine (line ~5242) both
  passed `slTrailPct` correctly; only HFT mode was broken.
- Fix (`static/aismart.js` ~2681): mirror the main-tick risk block inside the
  HFT entry path — declare `manualTrailSLOn`, set `aiSlOn =
  !manualSLOn && !manualTrailSLOn && u.aiSl !== false`, compute `slTrailPct =
  manualTrailSLOn ? (Number(u.manualTrailSLPct) || 0) : 0`, add the
  `updateAiSlStatus`/`updateAiTpStatus`/`updateAiTPStatus` lines, and pass
  `slTrailPct` in the `autoEntry` call.
- `templates/index.html`: aismart cache buster → v=86.
- Verified: `node --check`; Node simulation of `checkAutoTargetSl` — with
  `slTrailPct:0` the stop stays fixed (no close), with `slTrailPct:1` the SL
  ratchets to 100.98 and exits at 100.90 with "Trailing SL hit"; curl confirms
  served aismart.js contains both `slTrailPct` computations and the fixed
  `autoEntry`. **LEFT OFF:** live browser verification (hard refresh) — enable
  AST HFT + Trail SL, watch the running SL line ratchet up and closed trades
  report "Trailing SL hit".

## Update (2026-08-28)

**Fixed: AI Smart Trading paper P&L mismatch (realized/live vs Closed list +
Running list).**
- User report: realized P&L and live P&L cards did not match the Closed
  positions table and Running trades in the Paper Trade → AST panels.
- `static/aismart.js` (v=85):
  - `recordClosedPosition()` (~4246) rewritten: matches PaperTrade's
    authoritative close record by **symbolId + side + qty** (then entry price,
    then symbol-name) instead of the old fragile 5-min recency window, with a
    "not already mirrored" guard keyed on `at` so a re-entered symbol picks the
    newest record. The live-LTP fallback was REMOVED — an unmatched close now
    records P&L 0 / reason 'Closed' rather than pricing a closed trade at the
    current LTP of an already-closed position. Stores `symbol`/`symbolId`/
    `symbolExch` on the entry.
  - `renderClosed()` (~4366): renders ALL `state.closed` (removed `slice(0,15)`)
    so the visible Closed list sums exactly to the Smart Realized P&L card.
    Closed cap raised 100 → 200.
  - `renderSummary()` unrealized loop: only adds a running position's P&L when
    the quote is `q.live && q.ltp != null`, matching `runningRowHTML` (which
    already showed `--` for stale/non-live quotes) — no frozen/backfill prices.
- `static/papertrade.js` (v=26):
  - `renderClosedTable()`: removed `state.closed.slice(0, 25)` so the PT Closed
    table sums to the PT Realized P&L card.
  - `save()`: closed persistence raised `slice(-20)` → `slice(-200)` so the
    realized card and Closed table stay in sync across reloads.
- `templates/index.html`: cache busters → aismart 85, papertrade 26.
- Verified: `node --check` both; curl confirms served JS/HTML contain the new
  logic and fresh cache busters. **LEFT OFF:** live browser verification (hard
  refresh) that closed exit/P&L equals the PT closed table and realized sum
  matches visible closed rows.

## Update (2026-08-27)

**ASR (Auto Support Resistance) gap filter added to both engines.**
- User spec: bullish = gap between candle structure and the SUPPORT line keeps
  widening (price rising away from support); bearish = gap below the RESISTANCE
  line keeps widening (price falling away below resistance).
- `static/aismart.js` (v=84) + `static/autoexperiment.v13.js` (v=112):
  FILTER_EXTRA_KEYS += `bullAsr`,`bearAsr`; new cached `autoSRGapSeries(
  settings, candles, side)` (after bbGapSeries) that replays the autosr
  indicator's ATR-scaled ZigZag per bar (no lookahead) and returns the signed
  gap close-support (side 'sup') / resistance-close (side 'res'); new logic
  keys `asrSupGapUp`/`asrResGapUp` in evalCondAt (gap must be positive AND
  widening via trendAt). Gates pushed with autosr default settings
  `{atrPeriod:14, atrMult:2.0, minPct:0.15}`. Wired into buildFilterConditions
  (enabled check + gates), activeFilterDirection, defaultState, readFiltersUI
  any-check, filterSummary.
- `templates/index.html`: checkboxes `astFilterBullAsr`/`astFilterBearAsr`
  (~1339/1369), `aeFilterBullAsr`/`aeFilterBearAsr` (~1720/1750); cache busters
  → autoexperiment 112, aismart 84.
- Perf: cold compute ~1.7 ms for 2000 candles, cached eval ~0.009 ms (single
  O(n) pass, preallocated gap array, no per-point allocation).
- Verified: `node --check` all three; Node harness on live compute — uptrend →
  sup gap widens → bull fires; downtrend → res gap widens → bear fires;
  sideways → neither; curl confirms served JS/HTML contain new content; server
  log clean. **LEFT OFF:** live browser verification (hard refresh).

## Update (2026-08-27)

**Fixed: pane chart time-axis misalignment with the main chart.**
- Root cause: `syncRanges()` (indicators.js ~1193) synced by **logical
  (bar-index) range** (`getVisibleLogicalRange`/`setVisibleLogicalRange`).
  Pane indicators drop their warmup bars (e.g. SMF/VL skip the first
  `length-1` candles), so a pane's bar 0 is NOT the chart's bar 0 — the fixed
  index offset pushed every pane's time axis out of line with the main chart.
- Fix: sync by **time range** (`getVisibleRange`/`setVisibleRange`) — all pane
  series share the exact candle timestamps, so dates/times align in a straight
  line regardless of warmup offset. Also re-sync panes after realtime
  `setData()` (both the range-preserve path and the `fitToRecent()` fallback)
  and after `followLatest()` repositions the main chart.
- Note: main-chart-internal repositioning (`fitToRecent`, `followLatest`,
  `setData` restore) still legitimately uses logical ranges since the main
  chart holds the full candle set; panes are then synced from it by time.
- Verified: `node --check`; curl confirms served indicators.js contains the new
  sync. **LEFT OFF:** live browser check (hard refresh) that panes move in a
  straight line with the chart across pan/zoom/realtime ticks.

## Update (2026-08-27)

**VL (Volume Line) overlay indicator + filter gates in both engines.**
- `static/indicators.js`: new `vl` IND def (after smf ~line 783), cat `Volume`,
  type `overlay`. Inputs `length=14, signalLen=9, volLen=20`; styles
  color/signalColor/lineWidth. Compute = VWMA of close (trend-following, like an
  EMA) with per-point `rgba` opacity mapping vol/volAvg (battery fade/dark: low
  volume → faint, high volume → dark). Two rolling passes O(n), avg ~0.94 ms for
  2000 candles (optimized: precomputed rgb prefix, no per-point regex).
  `valueOptionsFor` case → `[['v0','Volume Line'],['v1','Signal']]`.
- Filter semantics (per user): **bullish = VL increasing upward AND volume
  increasing; bearish = VL increasing downward AND volume increasing**. Both
  engine gates push 2 ANDed conds: `{indId:'vl', indSettings:{length:14,
  signalLen:9,volLen:20}, valueKey:'v0', logic:'incUp'|'incDown',
  cmpType:'number'}` + `{indId:'', logic:'volUp', cmpType:'candle'}`.
- `static/aismart.js` (v=83) + `static/autoexperiment.v13.js` (v=111):
  `FILTER_EXTRA_KEYS` += `bullVl`,`bearVl`; defaultState filters += both false;
  buildFilterConditions enabled-check + gates + activeFilterDirection + readFiltersUI
  any-check + filterSummary (`'Volume Line rising + volume increasing'` /
  `'Volume Line falling + volume increasing'`). onFilterMaster select-all picks
  them up automatically.
- `templates/index.html`: checkboxes `astFilterBullVl`,`astFilterBearVl`,
  `aeFilterBullVl`,`aeFilterBearVl`; cache busters → indicators 46,
  autoexperiment 111, aismart 83.
- Verified: `node --check` all three; Node harness on live compute (VL trends
  up in uptrend / down in downtrend, per-point color present, avg 0.94 ms);
  filter-gate harness (uptrend+vol↑ → bull on; downtrend+vol↑ → bear on;
  downtrend+vol↓ → neither); curl confirms served JS/index contain new content;
  server log clean. **LEFT OFF:** live browser verification (hard refresh).

## Update (2026-08-27)

**SMF (Smart Money Flow) pane indicator + filter gates in both engines.**
- `static/indicators.js`: new `smf` IND def (after MFI ~line 706), cat `Volume`,
  type `pane`, format `percent`. Inputs `length=14, signalLen=9, volLen=20,
  pulseCap=3`; styles color/signalColor/histUpColor/histDownColor/lineWidth.
  Compute: CLV=((C-L)-(H-C))/(H-L) weighted by volume × min(vol/volAvg, cap);
  rolling weighted CLV over `length` scaled to [-100,100] (main), EMA signal,
  histogram = main − signal. Single-pass O(n), avg ~0.71 ms for 2000 candles.
  Bullish = main > signal, bearish = main < signal. `valueOptionsFor` case →
  `[['v0','SMF'],['v1','Signal'],['v2','Histogram']]`.
- `static/aismart.js` (v=82) + `static/autoexperiment.v13.js` (v=110):
  `FILTER_EXTRA_KEYS` += `bullSmf`,`bearSmf`; defaultState filters += both
  false; `buildFilterConditions` enabled-check + `activeFilterDirection` +=
  them; gates `{indId:'smf', indSettings:{length:14,signalLen:9,volLen:20,
  pulseCap:3}, valueKey:'v0', logic:'crossAbove'|'crossBelow',
  cmpType:'smoothed'}` (main vs signal line v1); readFiltersUI any-check +
  filterSummary `'Smart Money Flow bullish'/'bearish'`. onFilterMaster select-all
  picks them up automatically (section-wide querySelectorAll).
- `templates/index.html`: checkboxes `astFilterBullSmf`,`astFilterBearSmf`,
  `aeFilterBullSmf`,`aeFilterBearSmf` ("Smart Money Flow bullish/bearish (SMF
  above/below signal)"); cache busters → indicators 45, autoexperiment 110,
  aismart 82.
- Verified: `node --check` all three; Node harness on live compute (correct
  range, bullish/bearish gates flip correctly, sustained uptrend → positive
  SMF, avg 0.71 ms); server log clean; curl confirms served JS/index contain the
  new content. **LEFT OFF:** live browser verification (hard refresh) — SMF in
  indicator search, pane renders 3 series, filter checkboxes toggle and gate
  experiments.

## Update (2026-08-25)

Working tree backed up to
`himanijoshitiwari1988-lgtm/17_Added_niftrEntryLogicINcresingUpDown` (branch `main`). Two work
streams captured: (A) NIFTY BB%B session-extreme reversal gates `inc_up`/`inc_down` in both
engines + the 4 dropdowns; (B) live-quote/P&L/Closed-list fixes (dash `--` P&L, non-green profit,
stale Closed list, mistimed entries) — subscribe-skip now requires `q.live`, PaperTrade SL/TP
require `q.live`, `recordClosedPosition()` fills the Closed list, `closeAllPositions()` + aipt
stopAll on auto square-off. Cache-busters: aismart 75, AE 107, papertrade 20, aipt 30,
paperrun 14. Server `term_1787605852562_2` (PID 1005, port 8081). **LEFT OFF:** user needs a hard
refresh (browser still on aismart v73/AE v105) + live verification; tune `W`/`eps` of the
extreme-reversal gate if needed. Full detail in `SESSION.md` / `CHANGELOG.md`.

## Repository

- Source of truth: https://github.com/himanijoshitiwari1988-lgtm/71algodhan
  (branch `main`). This is the current working backup.
- Local clone used for editing: `/tmp/opencode/71algodhan` (remote `origin`
  points at `71algodhan.git`). Older notes reference `58algodhan` — that was
  the previous source-of-truth backup; the working copy is now `71algodhan`.

## What was implemented this session (all in 71algodhan)

000. **NIFTY Trend Following mutually exclusive with Top Gainers/Losers + Indices**
    - Both engines (`autoexperiment.v13.js` v=95, `aismart.js` v=67): enabling
      NIFTY Trend Following auto-switches `state.movers.enabled = false` and
      fades+disables all movers controls (`Top Movers: OFF - Trend Follow on`,
      grey background); enabling Top Movers auto-switches trend off. Both
      `applyNiftyTrendToUI` and `applyMoversToUI` sync each other (no recursion).
    - Engine stays active in trend mode: `experimentSymbols()` still returns the
      trend-picked F&O gainers/losers + selected indices universe for paper
      trading, so the paper engine keeps running while movers toggle shows OFF.

00. **India VIX + GIFT NIFTY in NIFTY trend; 1-min rescan; auto-drop below threshold**
    - Both engines (`static/autoexperiment.v13.js` v=94, `static/aismart.js` v=66):
      - `GIFT_NIFTY_IDX` (5024 IDX_I) + `INDIA_VIX_IDX` (21 IDX_I) constants;
        `enhanceNiftyBias(bias, t)` cross-checks the NIFTY ensemble against GIFT
        NIFTY trend (weight 3) + INDIA VIX fear-gauge (weight 2, `vixTrendSignal`
        = rising VIX>1%/bar window bearish, falling bullish, flat neutral);
        NIFTY weight 5 so a strong NIFTY call wins, weak one flips; fully
        optional (any fetch failure keeps NIFTY-only bias). NIFTY status summary
        now shows `GIFT Bull/Bear` + `VIX fall/rise`.
      - 1-min rescan gate: `niftyTrendSymbols(dir)` caches the full F&O pick for
        60s (`_trendScanAt/_trendScanDir/_trendScanCache`), so the top gainer/
        loser scan + NIFTY trend re-runs once a minute inside the existing tick.
      - Immediate below-threshold removal: `pruneNiftyTrendSymbols()` filters the
        per-tick symbol set (dropped instantly, no wait for the 60s scan); AE
        `paperTick` and AST `tick()` also force-exit any OPEN position whose
        symbol is a trend-followed F&O stock that dropped below +/- threshold
        (pt.autoExit + dropAiTrailEngine + delete state.positions), keeping
        indices. Log line: "NIFTY trend-following: dropped N position(s) below X%".
      - `_resetTrendScan()` invalidates the cache on toggle/input/add/remove index.
    - `templates/index.html`: note under AE/AST Trend Follow rows ("scan re-runs
      every 1 minute; dropped immediately"), cache busters bumped to v=94/v=66.
    - Verified: `node --check` both, node unit-test harness (19 pass) for
      vixTrendSignal / enhance / prune / scan throttle; served JS confirmed via curl.

0. **Auto Experiment backtest executes on the selected-strike option premium
   chart (F&O stocks and indices)**
   - `static/autoexperiment.v13.js`: new `backtestSplit(tpl, signalSources,
     tradeCandles, opts)` engine + split-aware `backtestCached`/`runOnCandles`
     + reworked `runExperiment` Phase 1 & 2.
   - F&O stocks (`runIn=spot`, `tradeIn=premium`): Phase 1 no longer short-
     circuits on `riMode==='spot'`; it now resolves the option chain and fetches
     premium candles. Phase 2 prices the simulated backtest trade on the
     selected-strike premium chart while signals run on the underlying spot
     chart. Missing chain falls back to spot execution (warn).
   - Indices (`runIn=both`, `tradeIn=premium`): signals must confirm on BOTH the
     spot and each selected-strike premium chart (AND), trade executes only on
     the premium chart.
   - Entry = AND across run-in sources, exit = OR (mirrors live `paperTick`).
   - F&O no-chain is now SKIPPED (warn) instead of falling back to a spot
     backtest, so F&O P&L is always premium-based.
   - Result cards + Detail modal show "backtest trade executed on: option
     premium chart" / "spot chart" (`tradeBasisLabel`).
   - Cache bust: index.html script tag bumped to `?v=41`.
   - Verified with a Node unit-test harness (entry priced on trade chart, AND
     dual-confirmation, OR exits). `node --check` passes; served JS is fresh
     (`SEND_FILE_MAX_AGE_DEFAULT=0`).

## What was implemented in an earlier session (all in 58algodhan, on top of 57algodhan)

1. **"Make this default setting" checkbox for Strategy run-in (Auto Experiment
   tab)**
   - `templates/index.html`: checkbox `aeRunInDefault` ("Make this default
     setting") beside the Indices / F&O stocks run-in dropdowns, default OFF.
   - `static/autoexperiment.v13.js`: `state.runIn.default` persisted via
     localStorage; when ON, the current run-in choice becomes the default for
     all future tasks in this engine.

2. **"Trade should be executed in:" section (Auto Experiment tab)**
   - `templates/index.html`: new row below the run-in row with `aeTradeInIndex`,
     `aeTradeInFno` selects (Spot chart / Selected strike option premium chart,
     default premium) and `aeTradeInDefault` checkbox.
   - `static/autoexperiment.v13.js`: `state.tradeIn = { index, fno, default }`
     persisted via localStorage; `tradeInMode(symbol)` helper; `readTradeInUI()`
     + `applyUniversalToUI()` sync; `onTradeInInput()` public API.
   - Trade execution is now independent from strategy runs: signals are still
     evaluated on the run-in chart, but paper positions are placed on the
     trade-in chart (spot underlying vs selected-strike option).

3. **"Trade should be executed in:" section (AI Smart Trading Engine)**
   - `templates/index.html`: new row below the run-in row with `astTradeInIndex`,
     `astTradeInFno` selects (default premium) and `astTradeInDefault` checkbox.
   - `static/aismart.js`: `state.tradeIn = { index, fno, default }` persisted
   via localStorage; `tradeInMode(symbol)` helper; `executionSymbolFor(instr)`
   picks the paper-trade target (spot symbol, or the first selected-strike
   option contract); `tick()` uses it for position entries/exits while
   candles still come from the run-in instrument; `readTradeInUI()` +
   `applyUniversalToUI()` sync; `onTradeInInput()` public API.

4. **"Both" mode for Strategy run-in / Trade execution (Auto Experiment + AI
   Smart Trading)**
   - `templates/index.html`: `both` option added to all 8 dropdowns
     (`aeRunInIndex`, `aeRunInFno`, `aeTradeInIndex`, `aeTradeInFno`,
     `astRunInIndex`, `astRunInFno`, `astTradeInIndex`, `astTradeInFno`).
   - Run-in "both": the entry decision needs the deployed strategy to fire on
     BOTH the spot chart AND the selected-strike option premium chart
     (dual trend/movement confirmation). When the result is strike-scoped the
     companion chart is spot; when spot-scoped the companion is the first
     selected-strike option premium chart. Implemented via
     `entryFireState()` + `evalEntryBothLive()` in both engines; the backtest
     for "both" run-in stays on the premium path (contracts).
   - Trade-in "both": paper positions are placed on BOTH the spot underlying
     and the option contract (dual-leg execution). In aismart the run-in
     resolution gained a combined `{ kind: 'both', symbol, contracts }`
     instrument and `executionSymbolsFor()` returns an array of targets; in
     autoexperiment `paperTick()` resolves `tradeTargets` and places/ manages
     each leg independently.

5. **Indices picker replaces "Include all indices" + "Symbols:" section removed
   (Auto Experiment + AI Smart Trading)**
   - `templates/index.html`: removed the "Symbols:" toolbar row (select + Add +
     symbol chip list) in both engines; replaced the `*MoversIndices` "Include
     all indices" checkbox with an indices `<select id="{ast,ae}MoversIndicesSelect">`,
     an "Add more" button, and a `*MoversIndicesList` chip list.
   - `state.movers.includeIndices` (boolean) became `state.movers.indices`
     (array of index symbol objects `{id, exch, inst, name, ocId, ocExch, grp}`).
     One-time migration in `applyMoversToUI()`: if the old checkbox was on and no
     explicit indices were chosen, seed `indices` with every INDEX symbol so
     previous behaviour is preserved.
   - `static/aismart.js` / `static/autoexperiment.v13.js`: replaced
     `populateSymbolsUI`/`addSymbol`/`removeSymbol`/`renderSymbolList` with
     `indexSymbolsList`/`populateMoversIndicesUI`/`addMoverIndex`/
     `removeMoverIndex`/`renderMoversIndicesList`; `topMoverSymbols()` and
     `renderMoversList()` now use `state.movers.indices` instead of
     `includeIndices`; `readMoversUI()` no longer reads a checkbox; the new
     select + Add button are gated (disabled/faded) when Top Movers is OFF.
     Public API: `addMoverIndex`, `removeMoverIndex` (was `addSymbol`,
     `removeSymbol`).
   - Note: `static/aecontrols.js` and `static/autoexperiment.js` (non-v13) still
     reference the old IDs but are NOT loaded by `templates/index.html` (dead
     files).

## Server / preview state

- Flask app: `app.py`, runs on port **8081**.
- Current preview URL: https://8081-51e722efc35890b9.monkeycode-ai.live
  (preview URL may be regenerated by the platform in a new session — call
  `request_preview` on port 8081 again if needed).
- Start command: `cd <repo> && python3 app.py` (use background terminal).
- Deps installed globally: `pip install --break-system-packages -r
  requirements.txt flask-sock`.
- Live data requires Dhan broker credentials (Client ID + Access Token) set via
  the app's Settings — without them the UI loads but APIs return 401.

## Last commit

Uncommitted working-tree change: `static/autoexperiment.v13.js` — split run-in /
trade-in backtest (backtest trades execute on the selected-strike option premium
chart for F&O stocks and indices). Docs updated: `CHANGELOG.md`, `.ai-ready/
MEMORY.md`. Committed history is through `7690422` (direction-aware premium
strike pick + buy-only execution).

## Likely next steps (from the user)

- Verify the split backtest against live market data once broker credentials are
  provided: run an experiment on an F&O stock (result row should show
  `optionStrike/optionType` tags and backtest trade prices matching the
  selected-strike premium chart, not the spot chart) and on an index (spot +
  premium dual-confirm signals, premium-only execution).
- Verify the independent trade-in execution against live market data once broker
  credentials are provided.
- Any follow-up tuning of trade-in vs run-in chart handling.
