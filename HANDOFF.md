# HANDOFF - Task Continuation Document

> This document records exactly where the current task was left **in the middle** so the
> next task/session can pick up from this exact point without re-reading the whole codebase.
> Read this FIRST, then read the Next Steps section and continue from there.

- **Repo (this backup):** `https://github.com/himanijoshitiwari1988-lgtm/12_added_multi_paper_tab_link_templet.git`
- **Handoff date:** 2026-08-23
- **Branch:** `main` (this backup pushed the whole history + the current in-progress state)

---

## 0. Latest update (2026-08-31, backup `33_fixed_NiftyTrendFollowingLegPickerAuto`)

Work done this session on top of `32_Added8IndicaterFilters_FixedOptionChainIssue`:

1. **NIFTY trend-following / Top Movers auto CE-PE leg picker FIX**
   (`static/aismart.js` `contractsFor`). The user's auto side-selection stopped
   working: for bearish the engine should pick the PE put chart, for bullish the
   CE call chart, and send it to the strategy. Three bugs:
   - NIFTY trend direction (`_lastNiftyDir`) was never consulted in NIFTY trend
     mode (`moverDirectionFor` only works in movers mode; `trendDirectionFor`
     read each stock's own candles, not NIFTY).
   - `strategyDirectionFor()` came first in precedence, so a shared strategy
     category overrode the mover/trend direction.
   - The auto-side block was skipped entirely when "+green premium" was off.
   Fix: side precedence reordered to NIFTY-trend-side -> mover-direction ->
   active-filter-direction -> strategy-category -> underlying-trend; guard
   extended to run in NIFTY trend mode (bearish -> PE, bullish -> CE) and in
   Top Movers mode (gainer -> CE, loser -> PE).
2. **Data Pool — every selected strike as its own premium row** (`poolScan`):
   'both' run-in instruments now expand ALL resolved contracts into separate
   premium readouts (`<Symbol> <strike> <CE/PE>`), not just `contracts[0]`;
   `confirmCandlesFor(instr, tf, ci)` added.
3. **Data Pool — manual Refresh button**: `AISmartTrading.poolRefresh()` +
   `_poolForceResolve` flag force a re-resolve (bypassing the 15s idle throttle)
   so newly added premium charts/symbols/strikes and changed indicator/data
   values appear immediately.
4. **Data Pool — live volume fallback** (`poolVolume`): Vol column uses the
   forming candle's volume, falling back to the live quote volume when the
   option premium candle carries none.

Verified: `node --check` clean on `static/aismart.js`; server serves the new
code. Cache-buster: `aismart.js?v=101`.

**Next steps:** browser verification on the live preview — (1) with NIFTY
trend-following ON, confirm bearish picks PE puts / bullish picks CE calls for
every picked symbol; (2) with Top Movers ON, gainer -> CE / loser -> PE; (3)
Data Pool shows one premium row per selected strike with real volume, and the
Refresh button surfaces newly added premium charts immediately.

---

## 1. Task Goal (what the user asked for)

1. **Duplicate Auto Experiment tabs** exactly like the existing Paper Trade tab duplication
   (the `PaperTabs` feature), so the user can run separate experiments in separate tabs.
2. **Make the paper-trade and auto-experiment engines FULLY INDEPENDENT per tab** (user-mandated):
   each duplicated tab gets its own state, config, results, timers, and localStorage so separate
   paper trades and separate auto experiments can run per tab (NOT shared singletons).
3. **In the AE engine**: add an explicit **Open** button for saved engine templates, and add an
   **enable/disable checkbox** to make the selected saved template the **default setting** for the
   Auto Experiment engine.

Prior context (already shipped in earlier sessions, DO NOT regress):
- AE strategies are categorized/tagged by saved engine templates and auto-routed to linked paper
  trade tabs via `PaperTabs.receiveFromAE`.
- Dhan broker charge simulation, AI Smart / AI Paper / paper trading engines, NIFTY ensemble trend,
  top movers, etc. all work.

---

## 2. Current State (what is DONE and committed here)

### 2a. Rate-limit storm fixes (completed, previous session)
The Auto Experiment used to fail with "every symbol was skipped" due to Dhan rate limits (DH-904).
Fixed by:
- Global rate-limit cooldown gate on `/api/candles` (`app.py` ~line 2673).
- `_RL_COOLDOWN_SEC = 30.0` in `data_fetcher.py` (was 15).
- 503 retry with 5s-20s backoff in `static/strategies.js` (~line 737-765).
- OPTIDX candle history capped at 45 days (`autoexperiment.v13.js` ~line 3310).
- Option-candle fetch pools reduced 3x2 -> 2x2.

### 2b. Engine factory conversion (completed for ALL 5 engines)
Each engine IIFE `(function(){...})()` was converted into a suffix-aware factory
`window.create*Engine(suffix)` (suffix defaults to `''` for the base tab). Inside each factory:
- `const $id = id => document.getElementById(id + suffix)` - every DOM read is now per-tab.
- Per-tab localStorage keys get `+ suffix` (engine state keys; shared template/strategy keys stay
  shared - templates are a shared library).
- All closures, state, and timers are now per-instance (fully independent).
- Each factory registers its instance in a per-tab registry and installs an active-tab facade
  on `window.*` so existing inline `onclick` handlers keep working and route to the active tab.

Factory functions + their registries + facade globals:

| File | Factory | Registry | Facade global |
|------|---------|----------|---------------|
| `static/autoexperiment.v13.js` | `window.createAutoExperiment(suffix)` | `window.TabEngines.ae[key]` | `window.AutoExperiment` |
| `static/papertrade.js` | `window.createPaperTrade(suffix)` | `window.TabEngines.papertrade[key]` | `window.PaperTrade` |
| `static/aipt.js` | `window.createAIPaperTrade(suffix)` | `window.TabEngines.aipt[key]` | `window.AIPaperTrade` |
| `static/aismart.js` | `window.createAISmartTrading(suffix)` | `window.TabEngines.aismart[key]` | `window.AISmartTrading` |
| `static/paperrun.js` | `window.createPaperRun(suffix)` | `window.TabEngines.paperrun[key]` | `window.PaperRun` |

Registry key scheme: **tab id**. Paper engines all key by the same tab id
(`"papertrade"` for the base tab, `"paperN"` for clones) because papertrade/aipt/aismart/paperrun
all live inside the SAME tab. AE keys by `"autoexperiment"` (base) / `"aeN"` (clones).

Facade dispatch keys (set by switchTab, see Next Steps):
- `window._paperActiveEngine` (default `"papertrade"`)
- `window._aeActiveEngine` (default `"autoexperiment"`)

**Backward compatibility is intact:** base instances are created automatically when the scripts load
(suffix `''`) and boot via DOMContentLoaded as before, so the base app still works. The base AE tab
also got the new **Open** button + **Default** checkbox support (see 2c).

Polling gate (anti-storm): cloned-tab engines poll only while visible.
- AE api: `startPoll`/`stopPoll`/`startResearchPoll`/`stopResearchPoll` exposed; `onTabShow`
  starts them if not running, `onTabHide` stops them.
- aismart api: `onTabShow` starts poll if not running, `onTabHide` stops.
- aipt/papertrade expose `startPoll`/`stopPoll` (and aipt `startMiniPoll`/`stopMiniPoll`).

### 2c. AE engine: Open button + Default template (completed in engine)
In `static/autoexperiment.v13.js`:
- New per-tab key `AE_DEFAULT_KEY = 'algodhan_ae_default_tpl' + suffix`.
- api methods added: `openSelectedTemplate()`, `toggleDefaultTemplate()`, `syncSelectedTpl()`.
- Helpers: `defaultTemplateId()`, `setDefaultTemplateId()`, `syncDefaultTplUI()`,
  `applyDefaultTemplate()`.
- `boot()` now calls `syncDefaultTplUI()` then `applyDefaultTemplate()` so the default template's
  settings are re-applied on every boot.

### 2d. index.html partial edits (already applied)
- Tab bar (line ~551-556): paper `+` button tagged `data-add-paper`; new AE `+` button tagged
  `data-add-ae` calling `AeTabs.openDialog()`.
- AE template toolbar row (line ~1337-1342): added explicit **Open** button
  (`AutoExperiment.openSelectedTemplate()`) and **Default** checkbox
  (`AutoExperiment.toggleDefaultTemplate()`); select onchange changed to
  `AutoExperiment.syncSelectedTpl()`.

---

## 3. What was completed in THIS session (index.html integration - all items 3a-3e DONE)

### 3a. `switchTab` active-engine routing (templates/index.html ~line 2317) - DONE
`switchTab` now:
- On leaving a paper tab (`paperN` or `papertrade`): sets `window._paperActiveEngine = prevTab`,
  calls `onTabHide()` on the PaperTrade / AIPaperTrade / AISmartTrading facades.
- On leaving an AE tab (`aeN` or `autoexperiment`): sets `window._aeActiveEngine = prevTab`,
  calls `AutoExperiment.onTabHide()`.
- On entering a paper tab: sets `window._paperActiveEngine = t`, calls `onTabShow()` on the
  PaperTrade / AIPaperTrade / AISmartTrading facades + `PaperRun.render(true)`.
- On entering an AE tab: sets `window._aeActiveEngine = t`, calls `AutoExperiment.onTabShow()`.
- Matchers `isPaperTab(x)` / `isAeTab(x)`.

### 3b. `AeTabs` object (duplicate of `PaperTabs`, index.html) - DONE
- New `AeTabs` const: `SAVE_KEY = "algodhan_ae_tabs_v1"`, `_list`, `restore()`, `nextNum()`,
  `openDialog()`, `closeDialog()`, `preview()`, `addTabs()`, `_buildTab()`, `_persist()`,
  `removeTab()`. `AeTabs.restore()` runs right after `PaperTabs.restore()`.
- `_buildTab(tab, label)` clones `#tab-autoexperiment`, re-suffixes every `[id]` with `_aeN`,
  creates tab button + close button, inserts before `.tab-btn[data-add-ae]`, then calls
  `ensureCloneEngines(tab, "ae")`.
- `addAeTabModal` HTML added next to `addPaperTabModal` (ids `aeAddCount`/`aeAddName`/`aeAddPreview`).
- `nextNum()` scans BOTH paper and AE tab buttons (`/^(?:paper|ae)(\d+)$/`) so ids never collide.
- Base AE tab (`autoexperiment`) is a static tab-bar button and is never removable (like `papertrade`).

### 3c. Engine instantiation for cloned tabs - DONE
- Global `ensureCloneEngines(tab, kind)` defined before `const PaperTabs`; idempotent; each engine
  creation wrapped in a `guard()` try/catch so one failure cannot abort the others.
- Final-body inline `<script>` `TabEnginesInit()` after all engine script tags creates base engines
  (suffix `""`) idempotently and iterates `.tab-bar .tab-btn[data-tab]` wiring every restored
  `paperN`/`aeN` clone to its own engine instances; clones boot then `stopPoll` until shown.
- `ensureCloneEngines` is also called from both `_buildTab`s for runtime-added tabs.

### 3d. `PaperTabs._buildTab` insertion target - DONE
Now inserts before `.tab-btn[data-add-paper]` (was generic `.tab-btn.tab-add`), keeping the AE
`+` button at the far end.

### 3e. `PaperTabs.receiveFromAE` routing - VERIFIED
Still routes incoming AE strategies to the linked paper tab by engine-template id (unchanged;
independent of engine instances). Verified with a dedicated browser test: matching template routes
(returns 1, renders into `#ptAeTplReceived_<tab>`), non-matching routes nothing.

### Extra fixes made this session
- **papertrade.js `$id` fallback** (was the blocker): `$id` now falls back to the base
  (non-suffixed) element when the suffixed one is missing
  (`document.getElementById(id + suffix) || document.getElementById(id)`). Applied to ALL 5
  factories. Sidebar/shared elements (`#paperMargin`, `#paperLots`, `#paperLotSize`,
  `#paperSymbol`, `#ptChart`, etc.) live in the shared sidebar, NOT inside the cloned tab, so
  without the fallback clone `init()` threw (`$id('paperMargin')` = null) and aborted the whole
  `ensureCloneEngines` chain. With the fallback, clones write to the shared sidebar which the
  facade routing syncs per active tab.
- Factories now `return api` (all 5) and register clones under the tab id (strip leading `_`
  from suffix) so facade dispatch keys match `window._paperActiveEngine`/`_aeActiveEngine`.
- Cache-busters bumped: `papertrade.js?v=18`, `autoexperiment.v13.js?v=100`, `aipt.js?v=28`,
  `aismart.js?v=69`, `paperrun.js?v=12`.

## 4. Key Design Decisions (keep these)

- **Per-tab independent engines** (user-mandated): factories + per-tab localStorage + per-tab DOM
  via `$id` suffixing + active-tab facade dispatch. No shared singleton state.
- Shared keys stay shared (template libraries): `algodhan_ae_templates_v1`,
  `algodhan_ast_templates_v1`, `algodhan_strategies_v1`.
- Per-tab keys: `algodhan_autoexperiment_v1`, `algodhan_ae_nifty_tf`,
  `algodhan_ae_default_tpl`, `algodhan_papertrade_v1`, `algodhan_buy_only_v1`,
  `algodhan_broker_charges_v1`, `algodhan_aipt_v1`, `algodhan_aismart_v1`,
  `algodhan_ast_nifty_tf` - all get `+ suffix`.
- Cloned-tab engines poll ONLY while their tab is visible (anti rate-limit storm). Base tabs keep
  current always-on behavior.
- AE `sendToPaper`/paper engine cross-calls route to the active tab via the facades.
- Server-side global cooldown gate on `/api/candles` prevents DH-904 storms from self-sustaining.
- `data_fetcher._mark_rate_limited()` is idempotent within the active window: a repeated
  empty-body/DH-904 failure does NOT extend the cooldown, so the 30s gate always clears and
  `/api/candles` recovers (root-cause fix for the permanent 503). All background Dhan callers
  (`_fetch_option_chain_data`, `_fetch_and_cache_expiries`, `api_expiries`, `api_option_chain_all`,
  `api_auto_strikes`, `fetch_intraday_candles`, `fetch_daily_candles`) are gated on the cooldown and
  short-circuit instead of firing into the storm. Historical throttle is 0.4s/call.

## 5. How to run / verify (results as of handoff)

- Flask app, port 8081. Preview: `https://8081-328c5c8602115fa6.monkeycode-ai.live`
  (monkeycode platform). Local: `python app.py`.
- `node --check` passes for all 5 edited engine files.
- Browser integration suite (`/tmp/opencode/test_app.js`, puppeteer): **31 checks, 0 failed** —
  boots clean, base engines + facades exist, paper clone (paper1) gets independent
  papertrade/aipt/aismart/paperrun instances, AE clone (ae2) gets an independent AE instance,
  facades route to the active tab on switch (base papertrade / ae2 / paper1), AE facade
  `getState() === clone instance`, ae2 removal cleans tab/button/engine/persist, reload/restore
  rebuilds the AE clone engine, no runtime JS errors.
- `receiveFromAE` routing test (`/tmp/opencode/test_receive.js`): PASS.
- Backend rate-limit unit tests (`/tmp/opencode/test_rl.py`, `/tmp/opencode/test_rl2.py`): PASS —
  empty-body failure arms the cooldown once; repeat failures do NOT extend it; intraday/daily fetch
  short-circuits with zero Dhan calls during cooldown; `_fetch_daily_with_fallback` skips the
  intraday cascade during cooldown.
- NOTE: transient `/api/candles` 503s appear in the console under load - that is the backend
  Dhan rate-limit cooldown gate (expected), NOT a JS error. With the idempotent cooldown they now
  lift after one ~30s window instead of persisting.
- The plain `test_app.js` run can occasionally hit a pre-existing reload-vs-evaluate race in the
  harness around the restore test ("Execution context was destroyed"); the traced run passes 31/31.
- Dhan broker must be CONNECTED (Connect button) before testing real trades.

## 6. Files touched since the previous backup commit

- `templates/index.html` - switchTab routing, AeTabs, addAeTabModal, ensureCloneEngines +
  guard(), TabEnginesInit, _buildTab insert target, cache-buster bumps
- `static/papertrade.js` - $id fallback + `return api` + registry key fix
- `static/aipt.js` - $id fallback + `return api` + registry key fix
- `static/aismart.js` - $id fallback + `return api` + registry key fix
- `static/paperrun.js` - $id fallback + `return api` + registry key fix
- `static/autoexperiment.v13.js` - $id fallback + `return api` + registry key fix
- `app.py` - cooldown gating for option-chain/expiry background refreshes + cold-start endpoints
  (this session's rate-limit mitigations)
- `data_fetcher.py` - idempotent `_mark_rate_limited`, intraday/daily cooldown short-circuit +
  1s/2s backoff retry, historical throttle 0.4s
- `HANDOFF.md`, `SESSION.md`, `CHANGELOG.md` - this session's docs

## 7. Next task quick-start checklist

1. Read this HANDOFF.md (you are reading it).
2. Re-add `.git` and commit/push the completed state (workspace currently has no `.git`; original
   history is in `/tmp/opencode/repo_src`).
3. Manual browser verification with Dhan CONNECTED: run an AE experiment in `ae2`, run paper
   trades in `paper1`, switch tabs, confirm each tab keeps its own state/results/timers. Then
   load a chart while the account is rate-limited and confirm it recovers by itself after ~30s
   (the idempotent cooldown lifts the gate; `fetchCandlesRetry` retries 6x5s).
4. If further edits continue, keep bumping the `?v=` cache-busters on the edited files.
