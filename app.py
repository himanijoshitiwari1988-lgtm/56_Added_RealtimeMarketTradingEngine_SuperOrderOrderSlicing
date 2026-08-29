"""
Dhan Algo Trading System - Flask API Server
Serves REST API endpoints and the web-based single-window UI.
"""

from flask import Flask, request, jsonify, send_from_directory
from flask_sock import Sock
from datetime import datetime, timedelta, timezone
import json
import math
import os
import random
import time
import threading
import tempfile
import logging
import gzip as _gzip
from io import BytesIO
from concurrent.futures import ThreadPoolExecutor

from broker import DhanBroker
from data_fetcher import DataFetcher, TIMEFRAME_CONFIG, _unwrap_sdk_response, rate_limit_cooldown_active, _throttle, auth_error, _market_open_now, oc_rate_limited
from dhanhq.marketfeed import MarketFeed
from werkzeug.serving import ThreadedWSGIServer, WSGIRequestHandler

app = Flask(__name__, static_folder="static", static_url_path="/static")
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0
# Keep browser WebSocket connections alive: protocol-level Ping every 15s so
# proxies/Android never consider the link idle, and dead peers are detected and
# cleaned up within ~30s instead of lingering.
app.config["SOCK_SERVER_OPTIONS"] = {"ping_interval": 15}
broker = DhanBroker()
fetcher = None
sock = Sock(app)


# ---------------------------------------------------------------------------
# Market-Off Candle Simulator
# ---------------------------------------------------------------------------
# A synthetic candlestick stream that keeps forming new 1min / 5min candles in
# realtime when the real market is closed (evenings, weekends, holidays). It is
# wired to a synthetic symbol (SIM / id 900001) and served through the regular
# /api/candles path, so every existing engine (AI Smart Trading, experiments,
# strategies) can run against a live-looking chart and produce paper trades
# while there is no Dhan feed.
#
# The generator uses a regime-switching model: a hidden "trend" state (bull /
# bear / range) is chosen from the configured direction and switches every so
# often, and each simulated second adds drift + momentum + mean-reversion +
# noise. This produces realistic bull/bear candle streams with pullbacks, not a
# flat random walk.
# ---------------------------------------------------------------------------
SIM_SECURITY_ID = 900001
SIM_EXCH = "SIM"
SIM_NAME = "SIM CHART"


class CandleSimulator:
    def __init__(self):
        self._lock = threading.Lock()
        self._thread = None
        self._running = False
        self._stop = threading.Event()
        self._config = {
            "trend": "bullish",      # bullish | bearish | range
            "timeframe": "1min",     # 1min | 5min
            "base": 24000.0,         # starting price
            "volatility": 0.0008,    # per-second std of returns
            "speed": 20,             # simulated seconds per real second
        }
        self._price = self._config["base"]
        self._anchor = self._price       # slow mean-reversion target
        self._momentum = 0.0             # trending autocorrelation
        self._prev_ret = 0.0             # previous simulated return
        self._vol_state = self._config["volatility"]  # vol clustering
        self._regime = "trend"           # trend | pullback | pause
        self._regime_left = 0            # sim-seconds until regime switch        self._sim_now = 0.0              # simulated epoch (unix seconds)
        self._candles = []               # closed 1min candles
        self._forming = None             # forming 1min candle
        self._prev_close = self._config["base"]

    # ----- lifecycle -----
    def start(self, cfg):
        with self._lock:
            self._stop.set()
            if self._thread:
                self._thread.join(timeout=3)
            self._config.update({
                "trend": cfg.get("trend", "bullish") or "bullish",
                "timeframe": cfg.get("timeframe", "1min") or "1min",
                "base": float(cfg.get("base", 24000.0) or 24000.0),
                "volatility": float(cfg.get("volatility", 0.0008) or 0.0008),
                "speed": float(cfg.get("speed", 20) or 20),
            })
            self._price = self._config["base"]
            self._anchor = self._price
            self._momentum = 0.0
            self._prev_ret = 0.0
            self._vol_state = self._config["volatility"]
            self._regime = "trend"
            self._regime_left = 0
            self._sim_now = time.time()
            self._candles = []
            self._forming = None
            # Backfill history so indicators / engines have context immediately.
            self._seed(self._config["timeframe"])
            self._running = True
            self._stop = threading.Event()
            self._thread = threading.Thread(target=self._run, daemon=True)
            self._thread.start()

    def stop(self):
        with self._lock:
            self._running = False
            self._stop.set()

    def status(self):
        with self._lock:
            return {
                "running": self._running,
                "config": dict(self._config),
                "ltp": round(self._price, 2),
                "candles": len(self._candles),
            }

    # ----- candle data -----
    def candles_for(self, timeframe):
        """Closed candles + the still-forming candle, optionally aggregated to
        a coarser timeframe. Returned in the same shape as /api/candles data."""
        with self._lock:
            closed = list(self._candles)
            forming = dict(self._forming) if self._forming else None
        series = closed + ([forming] if forming else [])
        if timeframe == "5min":
            series = self._aggregate(series, 300)
        elif timeframe != "1min":
            secs = {"1min": 60, "5min": 300, "15min": 900, "30min": 1800, "60min": 3600}.get(timeframe, 60)
            series = self._aggregate(series, secs)
        return series, self._prev_close

    def _aggregate(self, series, secs):
        out = []
        for c in series:
            bucket = int(c["time"] // secs) * secs
            if out and out[-1]["time"] == bucket:
                last = out[-1]
                last["high"] = max(last["high"], c["high"])
                last["low"] = min(last["low"], c["low"])
                last["close"] = c["close"]
                last["volume"] += c.get("volume", 0)
            else:
                out.append(dict(c))
                out[-1]["time"] = bucket
        return out

    def _seed(self, timeframe):
        """Fast-generate ~300 closed candles aligned to the current wall-clock
        bar boundaries so the chart already has a realistic history when it
        starts. The forming candle resumes from the last seeded price."""
        secs = 60
        n = 300
        start = (self._sim_now // secs) * secs - (n - 1) * secs
        price = self._price
        for i in range(n):
            ts = int(start + i * secs)
            open_px = price
            # One candle's worth of movement (the same generator the live
            # thread uses). The generator already scales to the candle length.
            ret, _ = self._gen_ret(secs)
            close_px = max(0.01, open_px * (1 + ret))
            wick = abs(random.gauss(0, self._vol_state * math.sqrt(secs / 60.0)) * 0.7)
            high = max(open_px, close_px) * (1 + wick)
            low = min(open_px, close_px) * (1 - wick * 0.8)
            vol = int((random.uniform(0.5, 1.6)) * 100000 * (1 + abs(ret) / (self._vol_state * 2)))
            self._candles.append({"time": ts, "open": round(open_px, 2), "high": round(high, 2), "low": round(low, 2), "close": round(close_px, 2), "volume": vol})
            price = close_px
        self._price = price
        self._prev_close = self._candles[0]["open"] if self._candles else self._config["base"]

    # ----- background thread -----
    def _run(self):
        last = time.time()
        while not self._stop.is_set():
            now = time.time()
            dt = now - last
            last = now
            try:
                with self._lock:
                    if self._running:
                        self._advance(dt)
            except Exception:
                pass
            self._stop.wait(0.05)

    def _advance(self, real_dt):
        speed = max(0.001, self._config["speed"])
        sim_secs = speed * real_dt
        self._sim_now += sim_secs
        ts = int(self._sim_now // 60) * 60
        if self._forming is None or self._forming["time"] != ts:
            self._close_forming(ts)
        bar = self._forming
        steps = max(1, int(sim_secs * 10))
        for _ in range(steps):
            ret, _ = self._gen_ret(sim_secs / steps)
            self._price = max(0.01, self._price * (1 + ret))
            bar["high"] = max(bar["high"], self._price)
            bar["low"] = min(bar["low"], self._price)
            bar["volume"] += int(abs(ret) * 400000)
        bar["close"] = round(self._price, 2)
        bar["high"] = round(bar["high"], 2)
        bar["low"] = round(bar["low"], 2)

    def _close_forming(self, ts):
        if self._forming is not None:
            self._candles.append(self._forming)
            if len(self._candles) > 2000:
                self._candles = self._candles[-2000:]
        self._forming = {
            "time": ts, "open": round(self._price, 2),
            "high": round(self._price, 2), "low": round(self._price, 2),
            "close": round(self._price, 2), "volume": 0,
        }

    def _gen_ret(self, secs):
        """One simulated return for `secs` seconds. Returns (return, volume).
        Regime-switching + return autocorrelation + mean-reversion + noise =>
        realistic trending candles with pullbacks.

        All state is kept in per-minute terms and scaled by ``secs/60`` so the
        generator behaves identically for the live thread (tiny steps) and the
        seed backfill (full 60-second candles). No state integrates unbounded
        noise: autocorrelation is just a fixed fraction of the previous return,
        and vol clustering tracks standardized noise only."""
        self._regime_left -= secs
        if self._regime_left <= 0:
            # Regimes last 120-600 simulated seconds (2-10 one-minute candles),
            # consistent for both the live thread (tiny secs) and the seed.
            self._regime_left = random.randint(120, 600)
            r = random.random()
            trend = self._config["trend"]
            if trend == "bullish":
                self._regime = "trend" if r < 0.62 else ("pullback" if r < 0.85 else "pause")
            elif trend == "bearish":
                self._regime = "trend" if r < 0.62 else ("pullback" if r < 0.85 else "pause")
            else:
                self._regime = "trend" if r < 0.5 else ("pullback" if r < 0.75 else "pause")
        vol = self._vol_state
        drift = 0.0
        if self._regime == "trend":
            drift = vol * (0.5 if self._config["trend"] in ("bullish", "range") else -0.5)
        elif self._regime == "pullback":
            drift = -vol * (0.2 if self._config["trend"] in ("bullish", "range") else 0.2)
        # Mean reversion to a slowly-following anchor. Clamped so a degenerate
        # price (e.g. the 0.01 floor) can never produce an astronomically
        # large pull back up in one step.
        mrv_raw = (self._anchor - self._price) / self._price
        mrv_raw = max(-1.0, min(1.0, mrv_raw))
        mrv = mrv_raw * 0.02
        noise = random.gauss(0, vol * math.sqrt(secs / 60))
        # Bounded return autocorrelation: a fixed fraction of the previous
        # return. This gives trend persistence without an unbounded state.
        autocorr = self._prev_ret * 0.25
        ret = (drift + mrv + autocorr) * secs / 60 + noise
        # Record the driving return (drift + mrv + noise, NOT ret itself, so the
        # autocorrelation can never feed back into itself).
        self._prev_ret = (drift + mrv) * secs / 60 + noise
        # Vol clustering on the STANDARDIZED noise (std ~ vol), not on `ret`,
        # otherwise trending returns inflate the vol state and feed back into
        # ever-larger returns. Clamp to keep the process bounded.
        std_noise = noise / math.sqrt(max(secs / 60, 1e-9))
        self._vol_state = math.sqrt(0.94 * self._vol_state ** 2 + 0.06 * std_noise ** 2)
        self._vol_state = max(0.00005, min(0.01, self._vol_state))
        self._anchor += (self._price - self._anchor) * 0.0005
        return ret, 0


_simulator = CandleSimulator()


_COMPRESSIBLE = (
    "text/", "application/json", "application/javascript", "application/xml",
    "application/x-javascript", "image/svg+xml",
)


@app.after_request
def _compress_response(resp):
    """Gzip-compress text responses to shrink payloads over the preview proxy."""
    if resp.status_code != 200:
        return resp
    ctype = resp.content_type or ""
    if not ctype.startswith(_COMPRESSIBLE):
        return resp
    if "gzip" not in (request.headers.get("Accept-Encoding") or ""):
        return resp
    data = b"".join(resp.iter_encoded()) if resp.direct_passthrough else resp.get_data()
    if len(data) < 512:
        return resp
    buf = BytesIO()
    with _gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=6) as gz:
        gz.write(data)
    resp.set_data(buf.getvalue())
    resp.headers["Content-Encoding"] = "gzip"
    resp.headers["Content-Length"] = str(len(buf.getvalue()))
    resp.headers.setdefault("Vary", "Accept-Encoding")
    return resp


def _patch_marketfeed():
    """Fix the Dhan SDK MarketFeed reconnect loop + keepalive.

    Upstream retries every 1s with no backoff (Dhan returns HTTP 429 / 805 when
    the 5-connection limit is hit, so hammering makes it worse), double-logs each
    error, and runs the first connect() OUTSIDE the try/except so a transient
    rejection kills the worker thread silently. Reconnect here with bounded
    backoff, reset on a successful connect, and explicit keepalive pings so a
    dropped feed resumes in ~2s instead of silently freezing for minutes."""
    import asyncio
    import websockets

    async def _connect(self):
        if self.version == 'v1':
            self.ws = await websockets.connect(MarketFeed.market_feed_wss)
            await self.authorize()
        elif self.version == 'v2':
            url = f"{MarketFeed.market_feed_wss}?version=2&token={self.access_token}&clientId={self.client_id}&authType=2"
            # Dhan pings the client every 10s and closes the socket after ~40s
            # of silence. websockets auto-answers pings inside recv(); the extra
            # ping_interval/ping_timeout here lets us detect a dead socket and
            # reconnect quickly instead of waiting on a half-open connection.
            self.ws = await websockets.connect(
                url,
                ping_interval=20,
                ping_timeout=20,
                close_timeout=5,
            )
        else:
            raise ValueError(f"Unsupported version: {self.version}")
        logger.info("ws feed: connecting and subscribing %d instruments", len(self.instruments))
        await self.subscribe_instruments()
        if self.on_connect:
            self.on_connect(self)

    async def _run_async(self):
        backoff = 2
        while self._running:
            try:
                if not self.ws or self._is_ws_closed():
                    try:
                        if self.ws is not None:
                            await self.ws.close()
                    except Exception:
                        pass
                    self.ws = None
                    # A server "too many connections" (805) disconnect parks us
                    # for a window before retrying, otherwise we just re-trip it.
                    with _WS_RL_LOCK:
                        rl_remain = _WS_RL_UNTIL - time.time()
                    if rl_remain > 0:
                        await asyncio.sleep(min(rl_remain, 60))
                    await _connect(self)
                    backoff = 2
                data = await self.get_instrument_data()
                if self.on_message:
                    self.on_message(self, data)
                backoff = 2
            except Exception as e:
                if self.on_error:
                    self.on_error(self, e)
                self.ws = None
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 15)

    MarketFeed.connect = _connect
    MarketFeed._run_async = _run_async


_patch_marketfeed()

# ---- Realtime last-candle patch guard ----
_IST = timezone(timedelta(hours=5, minutes=30))
_TF_SECS = {
    "1min": 60, "2min": 120, "3min": 180, "4min": 240, "5min": 300,
    "10min": 600, "15min": 900, "30min": 1800, "1hour": 3600, "4hour": 14400,
}

def _last_bar_is_current(timeframe, last_ts):
    """True when last_ts is the candle currently being formed for this timeframe.

    Candle timestamps are stored as IST wall-clock encoded as naive UTC, so the
    whole comparison runs in that same fake-UTC frame.
    """
    now_epoch = int(datetime.now(_IST).timestamp()) + int(_IST.utcoffset(None).total_seconds())
    now_wall = datetime.fromtimestamp(now_epoch, tz=timezone.utc)
    last_wall = datetime.fromtimestamp(last_ts, tz=timezone.utc)
    if timeframe == "day":
        return last_wall.date() == now_wall.date()
    if timeframe in ("week", "month", "year"):
        return True
    secs = _TF_SECS.get(timeframe)
    if not secs:
        return False
    bar_start = now_epoch - (now_epoch % secs)
    return last_ts >= bar_start

def _market_open_now(exchange_segment=None):
    """True during exchange trading hours (Mon-Fri, IST).

    NSE/BSE cash & F&O: 09:15-15:30. MCX commodity futures/options trade in
    two sessions: 09:00-15:30 and 17:00-23:30 (17:00-23:55 for options) - so
    charts, prev-close seeding and the REST quote fallback must stay live
    through the evening session for MCX symbols.

    Used by the realtime candle path to decide whether a closed bar is simply
    being replaced by a freshly forming one (refetch) or the market is shut and
    the cached bars are all we have (return them as-is)."""
    now = datetime.now(_IST)
    if now.weekday() >= 5:
        return False
    t = now.hour * 3600 + now.minute * 60 + now.second
    seg = str(exchange_segment or "").upper()
    if "MCX" in seg:
        return (9 * 3600 <= t <= 15 * 3600 + 30 * 60) or (17 * 3600 <= t <= 23 * 3600 + 30 * 60)
    return 9 * 3600 + 15 * 60 <= t <= 15 * 3600 + 30 * 60


def _any_market_open_now():
    """True when EITHER the NSE/BSE session or the MCX session is open. Used by
    the quote polling / prev-close seeding paths so MCX symbols keep receiving
    REST seeds and WS backfill during the evening commodity session."""
    return _market_open_now() or _market_open_now("MCX_COMM")

# Cooldown between forced realtime candle refetches (per cache key). The 1s
# frontend poll would otherwise refetch every tick while a closed bar waits for
# its replacement; 3s is quick enough that a new bar surfaces within seconds yet
# bounded enough that an idle chart never hammers the historical API.
_RT_REFETCH = {}
_RT_REFETCH_LOCK = threading.Lock()
_RT_REFETCH_COOLDOWN = 3

def _refetch_recent(cache_key):
    with _RT_REFETCH_LOCK:
        last = _RT_REFETCH.get(cache_key, 0)
        return time.time() - last < _RT_REFETCH_COOLDOWN

def _mark_refetch(cache_key):
    with _RT_REFETCH_LOCK:
        _RT_REFETCH[cache_key] = time.time()

# ---- Real-time quote cache (background thread updates, API reads microsecond-fast) ----
_QUOTE_CACHE = {}
_QUOTE_CACHE_LOCK = threading.Lock()
_QUOTE_SECURITIES = None
_QUOTE_RUNNING = False
_QUOTE_THREAD = None
# Cache for daily-candle-derived P&L (60s), used when live quote API returns no close
_DAILY_PL_CACHE = {}
_DAILY_PL_LOCK = threading.Lock()
# Throttle direct quote-API calls from /api/candles for options (1/sec limit)
_LIVE_PATCH = {}
_LIVE_PATCH_LOCK = threading.Lock()

# ---- Candle-fetch failure backoff ----
# When Dhan rate-limits /charts (it escalates from DH-904 rate-limit to a
# token-level DH-906 "Invalid Token" ban after sustained hammering), a failing
# candle fetch must not be retried every 2-3s: the chart cache never populates
# so the frontend keeps re-requesting and the ban never lifts. Park each cache
# key for a short window so the request returns immediately (no Dhan call) and
# the rate window has time to reset.
_CANDLE_FAIL = {}
_CANDLE_FAIL_LOCK = threading.Lock()
_CANDLE_FAIL_SEC = 30.0


def _candle_fail_active(cache_key):
    with _CANDLE_FAIL_LOCK:
        t = _CANDLE_FAIL.get(cache_key, 0)
        return time.time() - t < _CANDLE_FAIL_SEC


def _mark_candle_fail(cache_key):
    with _CANDLE_FAIL_LOCK:
        _CANDLE_FAIL[cache_key] = time.time()

# ---- Historical fetch concurrency cap ----
# The paper-trade / experiment engines can request many DISTINCT candle keys
# in a burst (symbols x strikes x timeframes). The data_fetcher surface lock
# serializes the actual Dhan calls (max 1 in-flight), but dozens of Flask
# request threads can still pile up waiting their turn. Cap how many threads
# may be waiting/fetching the historical surface at once: excess requests get
# an instant 503 ("busy") that the frontend retries with backoff, instead of
# unbounded thread buildup that starves every other request in the app.
_HIST_FETCHING = 0
_HIST_FETCH_LOCK = threading.Lock()
_HIST_MAX = 10


def _hist_try_acquire():
    global _HIST_FETCHING
    with _HIST_FETCH_LOCK:
        if _HIST_FETCHING >= _HIST_MAX:
            return False
        _HIST_FETCHING += 1
        return True


def _hist_release():
    global _HIST_FETCHING
    with _HIST_FETCH_LOCK:
        if _HIST_FETCHING > 0:
            _HIST_FETCHING -= 1

# ---- /api/account response cache ----
# funds + positions + holdings are three throttled Dhan calls; the paper-trade
# panel polls this every few seconds, so short-circuit to a cached payload to
# avoid hammering Dhan's account surface (which also gets DH-906 banned).
_ACCOUNT_CACHE = {}
_ACCOUNT_CACHE_LOCK = threading.Lock()
_ACCOUNT_CACHE_SEC = 8.0

def _last_two_daily(security_id, exchange_segment, instrument_type):
    """Return (last_close, prev_close) from the daily candles (cached 60s).

    last_close is the most recent daily close (fallback LTP when there is no live
    quote). prev_close is the previous trading day's close - the most recent daily
    candle whose date is before today - so a live LTP can be diffed against the
    correct prior close even when today's daily candle has not been published yet
    (the normal state right after market close)."""
    key = (security_id, exchange_segment)
    now = time.time()
    with _DAILY_PL_LOCK:
        hit = _DAILY_PL_CACHE.get(key)
        if hit and now - hit["at"] < 60:
            return hit["ltp"], hit["close"]
    try:
        today = datetime.now(_IST).date()
        from_date = (today - timedelta(days=45)).strftime("%Y-%m-%d")
        to_date = today.strftime("%Y-%m-%d")
        df = fetcher._fetch_daily_with_fallback(
            security_id, exchange_segment, instrument_type, from_date, to_date
        )
        if len(df) >= 2:
            # prev_close is the SECOND-to-last candle. During a trading day the
            # last candle is today (prev = yesterday); on a weekend / holiday the
            # last candle is the last session's close, so prev must be the session
            # BEFORE that. Taking "last candle before today" would pick the same
            # Friday candle twice and zero the change on Saturdays.
            last_close = float(df.iloc[-1]["close"])
            prev_close = float(df.iloc[-2]["close"])
            if last_close and prev_close:
                with _DAILY_PL_LOCK:
                    _DAILY_PL_CACHE[key] = {"at": now, "ltp": last_close, "close": prev_close}
                return last_close, prev_close
    except Exception:
        pass
    with _DAILY_PL_LOCK:
        _DAILY_PL_CACHE[key] = {"at": now, "ltp": 0, "close": 0}
    return 0, 0

def _fill_from_daily_candles(security_id, exchange_segment, instrument_type):
    """Return {ltp, change, close, change_pct} from the last two daily candles (cached 10 min)."""
    ltp, pc = _last_two_daily(security_id, exchange_segment, instrument_type)
    if pc:
        chg = ltp - pc
        return {"ltp": ltp, "change": round(chg, 2), "close": pc,
                "change_pct": round(chg/pc*100, 2) if pc else 0}
    return None

# Daily-candle backfill runs in a dedicated thread so the whole watchlist gets
# gain/loss data within seconds instead of the minutes a 2s poll cycle needs.
_DAILY_FILL_QUEUE = []       # list of (seg, sid) to fill
_DAILY_FILL_IDX = 0          # current position
_DAILY_FILL_LOCK = threading.Lock()
_DAILY_FILL_SLEEP = 0.5      # seconds between daily-candle fetches (throttle paces it)

def _rebuild_daily_queue():
    global _DAILY_FILL_QUEUE, _DAILY_FILL_IDX
    _DAILY_FILL_QUEUE = []
    if not _QUOTE_SECURITIES:
        return
    for seg in ("NSE_EQ",):
        for sid in _QUOTE_SECURITIES.get(seg, []):
            _DAILY_FILL_QUEUE.append((seg, sid))
    _DAILY_FILL_IDX = 0

def _fetch_split_quotes():
    """Fetch market quotes in a SINGLE combined request, grouped per exchange
    segment ({seg: {security_id: quote}}).

    The Dhan quote API allows 1 request/second, so batching all segments into
    one call per poll cycle keeps us well under that limit (previously two calls
    per cycle plus the candles refresh exceeded it and every request failed).
    Grouping by segment is required because security ids are NOT unique across
    segments (e.g. NIFTY 50 and ABB both have id 13); a flat {id: quote} dict
    would silently show one symbol's data under another's key."""
    if not _QUOTE_SECURITIES:
        return {}
    try:
        return fetcher.fetch_market_quotes_by_segment(_QUOTE_SECURITIES)
    except Exception:
        return {}

def _seed_quote_cache(grouped):
    """Populate _QUOTE_CACHE once at startup (runs in a background thread)."""
    try:
        seg_quotes = _fetch_split_quotes()
        for seg, by_id in seg_quotes.items():
            for sid, q in by_id.items():
                key = _quote_key_for_segment(seg, sid)
                _quote_write(key, {"ltp": q.get("ltp", 0), "change": q.get("change", 0),
                                   "close": q.get("close", 0),
                                   "change_pct": q.get("change_pct", 0)},
                             live=True)
    except Exception:
        pass


# The Dhan MarketFeed delivers no Previous Close packet for watchlist symbols
# (observed in Ticker/Quote/Full modes), and the Full/Quote packet's "close"
# field equals the current LTP - NOT the previous day's close. So change /
# change_pct cannot be derived from the feed alone; the authoritative prev
# close comes from the REST /marketfeed/quote API (previous_close_price).
# The option chain re-seeds change from REST on every chain fetch
# (_apply_live_quotes) which is why its change column is live while the
# watchlist stayed 0.00. We re-seed the watchlist the same way: periodically
# fetch REST quotes and feed previous_close_price into _WS_PREV_CLOSE so every
# subsequent LTP tick computes a real change / change_pct.
_SEED_LAST = 0.0
_SEED_INTERVAL = 20.0

def _seed_watchlist_prev_close():
    """Refresh _WS_PREV_CLOSE from REST quotes so watchlist ticks show real
    change / change_pct. Rate-limited (1/sec quote API), so at most one call
    per _SEED_INTERVAL; skipped while rate-limited or outside market hours."""
    global _SEED_LAST
    now = time.time()
    if now - _SEED_LAST < _SEED_INTERVAL:
        return
    if not (_QUOTE_SECURITIES and broker.is_connected and fetcher):
        return
    if rate_limit_cooldown_active() or not _any_market_open_now():
        _SEED_LAST = now
        return
    try:
        seg_quotes = _fetch_split_quotes()
    except Exception:
        return
    _SEED_LAST = time.time()
    if not seg_quotes:
        return
    for seg, by_id in seg_quotes.items():
        for sid, q in by_id.items():
            key = _quote_key_for_segment(seg, sid)
            pc = float(q.get("close", 0) or 0)
            ltp = float(q.get("ltp", 0) or 0)
            chg = float(q.get("change", 0) or 0)
            if not pc and chg:
                pc = ltp - chg
            if pc and pc > 0:
                with _WS_PREV_CLOSE_LOCK:
                    _WS_PREV_CLOSE[key] = pc
            # Also refresh the cached entry so the change/change_pct reach the
            # browser immediately even before the next tick.
            if pc > 0 or chg:
                _quote_write(key, {"ltp": ltp, "change": chg,
                                   "close": pc,
                                   "change_pct": round(chg / pc * 100, 2) if pc else 0},
                             live=True)


def _quote_key_for_segment(seg, sid):
    """Map a quote-API exchange segment + security id to the shared cache key.

    Indices (requested under NSE/BSE/IDX_I) live under the IDX_I: prefix so they
    can never collide with an equity/fut-opt of the same numeric id."""
    if str(seg).upper() in ("NSE", "BSE", "IDX_I"):
        return "IDX_I:%s" % sid
    return str(sid)

def _quote_write(key, entry, live=False):
    """Persist a quote entry to the shared cache AND to the browser push buffer
    atomically.

    Every reader updates the UI from one of two paths: the REST /api/quotes poll
    (returns _QUOTE_CACHE) and the WebSocket /ws push (returns _BCAST). If a
    writer touches only one of them the two paths disagree and the UI flickers
    between the two values, so every cache write must be broadcast as well."""
    entry = dict(entry)
    entry["at"] = time.time()
    if live:
        entry["live"] = 1
    with _QUOTE_CACHE_LOCK:
        _QUOTE_CACHE[key] = entry
        with _BCAST_LOCK:
            _BCAST[key] = dict(entry)

def _daily_fill_loop():
    """Continuously backfill equities from daily candles so every watchlist
    entry gets non-zero change / change_pct even when the live quote API
    returns no close. Runs independently of the 2s live-quote poll."""
    global _DAILY_FILL_QUEUE, _DAILY_FILL_IDX
    # Let the quote API seed the cache (with derived prev close) for a few
    # seconds before the daily-candle backfill starts. The quote API alone
    # covers gain/loss for most symbols, so the backfill only needs to fill the
    # handful the quote API could not (e.g. net_change == 0). Starting it after
    # a delay avoids a reconnect burst of 200+ daily calls tripping DH-904/805.
    time.sleep(12)
    while _QUOTE_RUNNING:
        if not (broker.is_connected and fetcher and _QUOTE_SECURITIES):
            time.sleep(1)
            continue
        # Back off while Dhan is rate-limiting us, so the daily-candle flood
        # stops competing with the quote / option-chain requests the UI needs.
        if rate_limit_cooldown_active():
            time.sleep(1)
            continue
        with _DAILY_FILL_LOCK:
            if not _DAILY_FILL_QUEUE:
                _rebuild_daily_queue()
            if not _DAILY_FILL_QUEUE:
                time.sleep(1)
                continue
            idx = _DAILY_FILL_IDX
            pending = list(_DAILY_FILL_QUEUE)
        if idx >= len(pending):
            with _DAILY_FILL_LOCK:
                _DAILY_FILL_QUEUE = []
                _DAILY_FILL_IDX = 0
            time.sleep(1)
            continue
        seg, sid = pending[idx]
        try:
            sk = str(sid)
            with _QUOTE_CACHE_LOCK:
                entry = _QUOTE_CACHE.get(sk)
            # A live feed entry with a close is authoritative - never overwrite
            # it with the daily-candle backfill. Overwriting it (or leaving the
            # backfill out of the broadcast buffer) is what made LTP / gain / %
            # flicker between two values on the watchlist and chart header.
            if entry and entry.get("live"):
                if entry.get("close"):
                    continue
            else:
                if entry and entry.get("close") and entry.get("ltp") and \
                        entry["close"] != entry["ltp"] and \
                        (time.time() - entry.get("at", 0)) <= 30:
                    continue
            ltp_d, pc = _last_two_daily(sid, seg, "EQUITY")
            if pc:
                ltp = (entry or {}).get("ltp") or ltp_d
                chg = ltp - pc
                # Mark live so the authoritative close/change reaches the browser:
                # the client merge otherwise discards backfill entries in favour of
                # a live-but-close-less seed, leaving gain/loss stuck at 0.00.
                _quote_write(sk, {"ltp": ltp, "change": round(chg, 2), "close": pc,
                                  "change_pct": round(chg / pc * 100, 2) if pc else 0},
                             live=True)
        except Exception:
            pass
        with _DAILY_FILL_LOCK:
            _DAILY_FILL_IDX = idx + 1
        time.sleep(_DAILY_FILL_SLEEP)

def _quote_poll_loop():
    global _QUOTE_SECURITIES
    rest_backoff = 0.2
    while _QUOTE_RUNNING:
        if _QUOTE_SECURITIES and broker.is_connected and fetcher:
            # The WebSocket feed is the primary quote source. Only fall back to
            # the REST quote API once the feed has gone quiet (dropped, or
            # after-hours with no ticks). Previously the REST poll ran every
            # 0.2s regardless, hammering Dhan's 1/sec /marketfeed/quote limit
            # and logging the recurring code=None type=None msg=None errors.
            ws_stale = (time.time() - _WS_LAST_TICK) > _WS_REST_FALLBACK_SEC
            # After market close the WS feed sends no ticks (so ws_stale is always
            # true) and the REST quote API returns an empty-bodied failure
            # (code=None) that _unwrap_sdk_response treats as rate-limiting. Polling
            # it every cycle then re-trips the cooldown and starves the option-chain
            # / expiry fetches, which show "Dhan API unavailable". There is no live
            # data to fetch after close anyway - the WS feed + daily-candle backfill
            # already hold the last-known prices - so only poll REST during hours.
            market_open = _any_market_open_now()
            if ws_stale and market_open and not rate_limit_cooldown_active():
                try:
                    seg_quotes = _fetch_split_quotes()
                except Exception:
                    seg_quotes = {}
                if seg_quotes:
                    for seg, by_id in seg_quotes.items():
                        for sid, q in by_id.items():
                            key = _quote_key_for_segment(seg, sid)
                            close = q.get("close", 0)
                            ltp = q.get("ltp", 0)
                            if close > 0 and close != ltp:
                                _quote_write(key, {"ltp": ltp, "change": q.get("change", 0),
                                                  "close": close, "change_pct": q.get("change_pct", 0)},
                                             live=True)
                    rest_backoff = 0.2
                else:
                    # Empty result means the quote API failed (rate limit /
                    # after-hours); back off so we never hammer it at 1/sec.
                    rest_backoff = min(rest_backoff * 2, 10)
            else:
                # No REST polling after close (market_open False) or while the WS
                # feed is healthy / Dhan is rate-limiting. Sleep longer after close
                # to avoid a busy 0.2s loop; the index daily fallback still runs.
                rest_backoff = 5.0 if not market_open else 0.2
            # Re-seed the watchlist prev-close from REST quotes (the feed sends
            # no Previous Close packet), so change / change_pct stay live even
            # while the WebSocket feed is healthy. Throttled to ~1/20s.
            try:
                _seed_watchlist_prev_close()
            except Exception:
                pass
            # Index daily-candle fallback (only a handful of indices): fills the
            # prev-close/gain-loss when the quote API has no close for an index,
            # e.g. while the account is recovering from a rate limit. Never marked
            # live, so a realtime quote always wins in the frontend merge.
            # Respect the global cooldown like every other background loop: firing
            # the daily endpoint while rate-limited only re-trips DH-904 (each
            # empty-body/DH-904 response re-arms the 30s gate and keeps the user's
            # chart requests blocked). Off-hours there is no new data anyway.
            if not rate_limit_cooldown_active():
                try:
                    for sid in _QUOTE_SECURITIES.get("IDX_I", []):
                        ik = "IDX_I:%s" % sid
                        with _QUOTE_CACHE_LOCK:
                            cur = _QUOTE_CACHE.get(ik)
                        if cur and cur.get("close"):
                            continue
                        data = _fill_from_daily_candles(sid, "IDX_I", "INDEX")
                        if data:
                            _quote_write(ik, data, live=False)
                except Exception:
                    pass
        time.sleep(rest_backoff)

def _start_quote_thread():
    global _QUOTE_RUNNING, _QUOTE_THREAD
    # Restart the supervisor even if _QUOTE_RUNNING stayed True but the thread
    # itself died (uncaught exception): otherwise the flag lies and nothing ever
    # resumes, forcing the user to press Connect manually.
    alive = _QUOTE_THREAD is not None and _QUOTE_THREAD.is_alive()
    if _QUOTE_RUNNING and alive:
        return
    _QUOTE_RUNNING = True
    _QUOTE_THREAD = threading.Thread(target=_quote_poll_loop, daemon=True)
    _QUOTE_THREAD.start()
    # The daily-candle backfill for NSE_EQ equities (F&O stocks + market watch)
    # runs in its own thread so every watchlist entry gets non-zero change /
    # change_pct from daily candles even when the live quote API returns no
    # close. Indices get this via an inline fallback in _quote_poll_loop, but
    # without this thread the equity watchlist stays at "--" / 0.00.
    _DAILY_FILL_THREAD = threading.Thread(target=_daily_fill_loop, daemon=True)
    _DAILY_FILL_THREAD.start()

# ---- Dhan Live Market Feed (WebSocket) ----
# The fastest way to get market data. Dhan pushes tick-by-tick binary packets
# over a persistent WebSocket instead of us polling the 1/sec REST quote API.
# The background thread below runs the SDK's MarketFeed and writes every tick
# straight into _QUOTE_CACHE, so /api/quotes, /api/candles and the watchlist all
# read instant, sub-second data with no Dhan REST call. The REST poll loop is
# kept only as a fallback that resumes if the feed goes stale.
_WS_RUNNING = False
_WS_FEED = None
_WS_THREAD = None
_WS_LOCK = threading.Lock()
_WS_SUBSCRIBED = set()          # (exchange_code, sid, mode) tuples currently subscribed
_WS_PERSIST = set()             # option-strike subscriptions that must survive feed (re)connects
_WS_PREV_CLOSE = {}             # cache key -> previous-day close (from prev-close packet)
_WS_PREV_CLOSE_LOCK = threading.Lock()
_WS_LAST_TICK = 0.0             # timestamp of the last tick received (0 = never)
_WS_REST_FALLBACK_SEC = 2       # resume REST polling quickly when feed drops
_WS_RL_UNTIL = 0.0              # park reconnects after a server 805 disconnect
_WS_RL_LOCK = threading.Lock()
# Manual "reset feed" cooldown: how long the frontend waits after a reset
# before offering to reconnect, so Dhan's stale connection slots expire.
_WS_MANUAL_COOLDOWN = 90
_WS_TICK_TYPES = {}             # packet type -> count (diagnostic)
_WS_TICK_TYPES_LOCK = threading.Lock()
_FEED_LAT_LAST = 0.0
_NIFTY_TICKS = 0

# ---- Browser push (WebSocket bridge) ----
# Ticks from the Dhan feed are batched and pushed to every connected browser
# over /ws, so the UI updates tick-by-tick instead of on a REST poll cadence.
_BCAST = {}                     # cache key -> latest quote entry
_BCAST_LOCK = threading.Lock()
_BCAST_RUNNING = False
_BCAST_THREAD = None
_BCAST_INTERVAL = 0.005          # flush push messages every 5ms (low-latency UI)
_BCAST_CLIENTS = set()          # connected browser WebSocket handles
_BCAST_CLIENTS_LOCK = threading.Lock()

def _broadcast_loop():
    global _BCAST
    while _BCAST_RUNNING:
        time.sleep(_BCAST_INTERVAL)
        with _BCAST_LOCK:
            payload = _BCAST
            _BCAST = {}
        if not payload:
            continue
        msg = json.dumps({"type": "quotes", "data": payload})
        with _BCAST_CLIENTS_LOCK:
            clients = list(_BCAST_CLIENTS)
        for ws in clients:
            try:
                ws.send(msg)
            except Exception:
                with _BCAST_CLIENTS_LOCK:
                    _BCAST_CLIENTS.discard(ws)

@sock.route("/ws")
def ws_bridge(ws):
    with _BCAST_CLIENTS_LOCK:
        _BCAST_CLIENTS.add(ws)
    try:
        # Server only pushes; we block on receive to detect disconnects.
        while True:
            msg = ws.receive()
            if msg is None:
                break
    except Exception:
        pass
    finally:
        with _BCAST_CLIENTS_LOCK:
            _BCAST_CLIENTS.discard(ws)

def _ws_cache_key(seg_code, sid):
    """Map a feed exchange-segment code + security id to a _QUOTE_CACHE key."""
    if seg_code == MarketFeed.IDX:
        return "IDX_I:%s" % sid
    return str(sid)

def _ws_instrument_list():
    """Build the (exchange_code, sid, mode) subscription list from _QUOTE_SECURITIES.

    Indices are grouped under NSE/BSE in the REST cache but stream on the
    IDX_I feed segment. Equities/F&O map to their own feed segments."""
    insts = []
    if not _QUOTE_SECURITIES:
        return insts
    for seg, sids in _QUOTE_SECURITIES.items():
        if seg == "NSE_EQ":
            code = MarketFeed.NSE
        elif seg == "NSE_FNO":
            code = MarketFeed.NSE_FNO
        elif seg == "BSE_FNO":
            code = MarketFeed.BSE_FNO
        elif seg == "MCX_COMM":
            code = MarketFeed.MCX
        elif seg in ("NSE", "BSE", "IDX_I"):
            code = MarketFeed.IDX
        else:
            logger.warning("ws: skipping unknown segment %s", seg)
            continue
        for sid in sids:
            # Ticker mode (LTP only). Dhan's feed does NOT deliver a Previous
            # Close packet for these symbols in any mode, so change / change_pct
            # are seeded from the REST quote API (previous_close_price) in
            # _seed_watchlist_quotes() and diffed here per tick.
            insts.append((code, str(sid), MarketFeed.Ticker))
    return insts

# ---- Live option IV (Black-Scholes inversion) ----
# Dhan's WebSocket feed does not carry IV, so for option strikes we infer it
# from the live premium on every LTP tick. This keeps the chain's IV column
# updating at feed speed instead of waiting for the slow REST refresh.
_OPT_META = {}                  # security_id -> {prefix, expiry, strike, type}
# Option buckets learned at runtime from successful Dhan option-chain REST
# fetches (commodity expiries whose OPTFUT strikes the scrip master does not
# cover). Merged into oc_map on every scrip-master load so those chains use the
# instant scrip-master + WebSocket path on every later build instead of re-hitting
# the slow 1-req/3s /optionchain endpoint.
_OC_PERSISTED = {}
_OPT_SPOT = {}                  # F&O prefix -> underlying spot (live)
_OPT_SPOT_LOCK = threading.Lock()
_OPT_IV_AT = {}                 # quote key -> last IV recompute time (throttle)
_IDX_PREFIX_BY_SID = {13: "NIFTY", 25: "BANKNIFTY", 27: "FINNIFTY", 51: "SENSEX"}
_BS_RATE = 0.06                 # risk-free rate used for IV inversion


def _bs_norm_cdf(x):
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _bs_price(S, K, T, r, sigma, is_call):
    """Black-Scholes option price."""
    if T <= 0 or sigma <= 0 or S <= 0 or K <= 0:
        return 0.0
    root = sigma * math.sqrt(T)
    d1 = (math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / root
    d2 = d1 - root
    if is_call:
        return S * _bs_norm_cdf(d1) - K * math.exp(-r * T) * _bs_norm_cdf(d2)
    return K * math.exp(-r * T) * _bs_norm_cdf(-d2) - S * _bs_norm_cdf(-d1)


def _implied_vol(S, K, T, r, market_price, is_call):
    """Infer IV from a live option premium via bisection. Returns None for
    impossible prices (below intrinsic) or when the grid never crosses."""
    if not (S > 0 and K > 0 and T > 0 and market_price > 0):
        return None
    intrinsic = (S - K) if is_call else (K - S)
    if market_price < intrinsic:
        return None
    lo, hi = 0.001, 4.0
    if _bs_price(S, K, T, r, lo, is_call) > market_price:
        return None
    try:
        for _ in range(50):
            mid = 0.5 * (lo + hi)
            if _bs_price(S, K, T, r, mid, is_call) < market_price:
                lo = mid
            else:
                hi = mid
    except Exception:
        return None
    return round(0.5 * (lo + hi), 4)


def _ttm_ist(expiry_date):
    """Years to expiry (expiry-day 15:30 IST) from IST now."""
    try:
        exp = datetime.strptime(str(expiry_date)[:10], "%Y-%m-%d").replace(hour=15, minute=30)
        now = datetime.utcnow() + timedelta(hours=5, minutes=30)
        t = (exp - now).total_seconds() / (365.25 * 24 * 3600)
        return max(t, 0.001)
    except Exception:
        return None


def _opt_iv(key, ltp):
    """Live IV for an option strike quote key, or None when not resolvable."""
    if ":" in key:
        return None
    try:
        sid = int(key)
    except (TypeError, ValueError):
        return None
    meta = _OPT_META.get(sid)
    if not meta:
        return None
    with _OPT_SPOT_LOCK:
        spot = _OPT_SPOT.get(meta.get("prefix"))
    if not spot or spot <= 0:
        return None
    ttm = _ttm_ist(meta.get("expiry"))
    if not ttm:
        return None
    return _implied_vol(spot, meta.get("strike"), ttm, _BS_RATE,
                        float(ltp), meta.get("type") == "CE")


def _ws_apply_ltp(key, ltp):
    """Write a live LTP into _QUOTE_CACHE with change vs the previous close."""
    with _WS_PREV_CLOSE_LOCK:
        pc = _WS_PREV_CLOSE.get(key)
    with _QUOTE_CACHE_LOCK:
        existing = _QUOTE_CACHE.get(key) or {}
        eclose = existing.get("close") or 0
        eltp = existing.get("ltp") or 0
        if pc:
            # Feed prev-close packet is authoritative unless it equals the current
            # ltp (a degenerate "no change" packet); then prefer a known real close.
            if pc == ltp and eclose and eclose != ltp:
                pc = eclose
            elif pc == ltp:
                pc = 0
        elif eclose and eclose != eltp:
            # Only trust the cached close as prev close when it is a genuine
            # previous-day value (differs from the cached ltp). A close that equals
            # ltp is a fabricated "no change" placeholder and must not be used.
            pc = eclose
        if pc:
            chg = ltp - pc
            entry = {"ltp": ltp, "change": round(chg, 2), "close": pc,
                     "change_pct": round(chg / pc * 100, 2) if pc else 0}
        else:
            # No previous close known (e.g. option strikes before the first
            # REST quote arrives). Preserve any authoritative change seeded by
            # the option-chain fetch instead of zeroing the display to 0.00.
            entry = {"ltp": ltp}
            if existing.get("change") is not None:
                entry["change"] = existing["change"]
                entry["close"] = existing.get("close") or 0
                entry["change_pct"] = existing.get("change_pct") or 0
            else:
                entry["change"] = 0
                entry["close"] = 0
                entry["change_pct"] = 0
        # Preserve OI / Volume / Bid-Ask / IV so quote pushes keep the full row.
        for field in ("oi", "volume", "bid", "ask", "iv"):
            if field in existing:
                entry[field] = existing[field]
        # Keep the underlying spot fresh for index options so per-tick IV uses
        # a live spot instead of the chain-load value.
        if key.startswith("IDX_I:"):
            try:
                pfx = _IDX_PREFIX_BY_SID.get(int(key.split(":", 1)[1]))
                if pfx:
                    with _OPT_SPOT_LOCK:
                        _OPT_SPOT[pfx] = ltp
            except (TypeError, ValueError, IndexError):
                pass
        # Infer IV from the fresh premium for option strikes (skip non-options).
        # Throttled to ~4/sec per strike: IV moves slowly and the inversion is
        # heavier than a plain cache write, so the tick path stays light.
        now_t = time.time()
        if not key.startswith("IDX_I:") and now_t - _OPT_IV_AT.get(key, 0.0) >= 0.25:
            _OPT_IV_AT[key] = now_t
            iv = _opt_iv(key, ltp)
            if iv is not None:
                entry["iv"] = iv
        entry["at"] = now_t
        entry["live"] = 1
        _QUOTE_CACHE[key] = entry
        with _BCAST_LOCK:
            _BCAST[key] = dict(entry)

def _ws_apply_oi(key, oi):
    """Write an OI packet into the quote cache and push it to browsers."""
    with _QUOTE_CACHE_LOCK:
        entry = dict(_QUOTE_CACHE.get(key) or {})
        entry["oi"] = int(oi or 0)
        entry.setdefault("at", time.time())
        _QUOTE_CACHE[key] = entry
        with _BCAST_LOCK:
            _BCAST[key] = dict(entry)

def _ws_apply_fields(key, fields):
    """Merge extra market-feed fields (Volume / Bid / Ask / OI) into the quote
    cache and push them to browsers, preserving the live LTP entry."""
    if not fields:
        return
    with _QUOTE_CACHE_LOCK:
        entry = dict(_QUOTE_CACHE.get(key) or {})
        changed = False
        for k, v in fields.items():
            if v is not None and entry.get(k) != v:
                entry[k] = v
                changed = True
        if changed:
            entry["at"] = time.time()
            entry["live"] = 1
            _QUOTE_CACHE[key] = entry
            with _BCAST_LOCK:
                _BCAST[key] = dict(entry)

def _ws_on_tick(feed, data):
    """SDK on_ticks callback: every pushed packet updates the quote cache.

    Robust to every packet shape the SDK parser can return: dicts for ticker /
    quote / OI / prev-close, a list for the server-disconnect packet (reason code
    at [0][4]), and a bare string for the market-status packet. A crash here used
    to be swallowed by the reconnect loop and silently dropped the feed, so the
    handler must never raise."""
    global _WS_LAST_TICK, _WS_RL_UNTIL, _FEED_LAT_LAST, _NIFTY_TICKS
    if isinstance(data, list):
        # Server-initiated disconnect packet (feed response code 50).
        try:
            reason = int(data[0][4])
        except Exception:
            reason = None
        if reason == 805:
            # Park for a full minute so Dhan's stale connection slots expire,
            # instead of re-tripping the 805 in a tight loop.
            with _WS_RL_LOCK:
                _WS_RL_UNTIL = time.time() + 60
            logger.warning("ws feed: server disconnected (805 too many connections)")
        elif reason in (807, 808, 809):
            logger.warning("ws feed: server disconnected (auth error %s)", reason)
        elif reason == 806:
            logger.warning("ws feed: server disconnected (806 subscribe to data APIs)")
        else:
            logger.warning("ws feed: server disconnected (reason %s)", reason)
        return
    if not isinstance(data, dict):
        return  # market-status / heartbeat / unknown packet
    t = data
    typ = t.get("type", "")
    with _WS_TICK_TYPES_LOCK:
        _WS_TICK_TYPES[typ] = _WS_TICK_TYPES.get(typ, 0) + 1
    sid = t.get("security_id")
    if sid is None:
        return
    try:
        sid_int = int(sid)
    except (TypeError, ValueError):
        return
    key = _ws_cache_key(t.get("exchange_segment"), sid_int)
    if typ == "Previous Close":
        try:
            pc = float(t.get("prev_close"))
        except (TypeError, ValueError):
            pc = 0
        if pc and pc > 0:
            with _WS_PREV_CLOSE_LOCK:
                _WS_PREV_CLOSE[key] = pc
            with _QUOTE_CACHE_LOCK:
                entry = _QUOTE_CACHE.get(key)
            if entry and entry.get("ltp"):
                _ws_apply_ltp(key, float(entry["ltp"]))
        return
    if typ == "OI Data":
        # Quote-mode subscriptions deliver OI as a separate packet.
        _ws_apply_oi(key, t.get("OI"))
        return
    if typ in ("Ticker Data", "Quote Data", "Full Data"):
        try:
            ltp = float(t.get("LTP") or 0)
        except (TypeError, ValueError):
            return
        if ltp <= 0:
            return
        _WS_LAST_TICK = time.time()
        if key == "IDX_I:13":
            _NIFTY_TICKS += 1
        if typ == "Ticker Data" and key.startswith("IDX_I:") and time.time() - _FEED_LAT_LAST > 30:
            _FEED_LAT_LAST = time.time()
            logger.info("ws feed latency sample: LTT=%s now=%s nifty_ticks/30s=%d", t.get("LTT"), datetime.utcnow().strftime("%H:%M:%S"), _NIFTY_TICKS)
            _NIFTY_TICKS = 0
        _ws_apply_ltp(key, ltp)
        # Quote/Full packets also carry Volume; Full adds top-of-book Bid/Ask
        # and OI. Merging these keeps the whole chain row live from the feed.
        if typ in ("Quote Data", "Full Data"):
            fields = {"volume": t.get("volume")}
            if typ == "Full Data":
                fields["oi"] = t.get("OI")
                depth = t.get("depth") or []
                if depth:
                    top = depth[0]
                    try:
                        fields["bid"] = float(top.get("bid_price") or 0)
                    except (TypeError, ValueError):
                        pass
                    try:
                        fields["ask"] = float(top.get("ask_price") or 0)
                    except (TypeError, ValueError):
                        pass
            _ws_apply_fields(key, fields)

def _ws_on_connect(feed):
    logger.info("ws feed connected")
    global _WS_LAST_TICK
    _WS_LAST_TICK = time.time()
    # Re-subscribe persisted option strikes after a (re)connect. The server drops
    # every subscription when the socket closes, and subscribe_instruments() only
    # re-sends feed.instruments - a strike queued while the feed object was down
    # (or queued after feed.instruments was last read) can otherwise be lost until
    # a manual page reload. Force the persist set here so option chains recover
    # automatically. Idempotent: subscribe_symbols() dedupes via a set.
    with _WS_LOCK:
        persist = list(_WS_PERSIST)
    if persist:
        try:
            feed.subscribe_symbols(persist)
        except Exception as e:
            logger.warning("ws feed: persist re-subscribe failed: %s", e)

def _ws_on_error(feed, err):
    # Dhan's WS endpoint rejects the HTTP upgrade with 429 once the per-account
    # connection limit (5) is exhausted. The binary 805 "too many connections"
    # packet is handled in _ws_on_tick, but 429 arrives here as an exception
    # from websockets.connect and previously only hit the generic exponential
    # backoff (2->15s). That keeps re-tripping the limit. Park reconnects the
    # same way as 805 so the feed backs off and recovers when a slot frees up.
    global _WS_RL_UNTIL
    try:
        status = getattr(err, "status_code", None)
    except Exception:
        status = None
    if status == 429 or "429" in str(err):
        # Same parking as the 805 packet: wait out the connection-slot limit so
        # the feed recovers without flooding Dhan with new WebSockets.
        with _WS_RL_LOCK:
            _WS_RL_UNTIL = time.time() + 60
        logger.warning("ws feed: 429 too many connections, parking reconnect")
        return
    logger.warning("ws feed error: %s", err)

def _ws_on_close(feed):
    logger.info("ws feed closed (server initiated)")

def _ws_quote_loop():
    """Supervisor: keep one MarketFeed connection alive, recreating it on failure
    or when the credentials change."""
    global _WS_FEED, _WS_SUBSCRIBED, _WS_LAST_TICK
    while _WS_RUNNING:
        feed = _WS_FEED
        if feed is not None:
            try:
                cur_tok = broker.context.get_access_token() if (broker.is_connected and broker.context) else None
            except Exception:
                cur_tok = None
            if cur_tok and cur_tok != getattr(feed, "_token", None):
                logger.info("ws feed: credentials changed, restarting connection")
                try:
                    feed.close_connection()
                except Exception:
                    pass
                with _WS_LOCK:
                    _WS_FEED = None
                    _WS_SUBSCRIBED = set()
                time.sleep(1)
                continue
            time.sleep(2)
            continue
        # The WebSocket feed is a separate surface from the 1/sec REST quote API.
        # Gating feed startup on rate_limit_cooldown_active() deadlocked: with no
        # feed up, _WS_LAST_TICK stays 0 so the REST fallback keeps polling,
        # tripping the quote rate limit and refreshing the cooldown forever, which
        # then blocked the feed from ever starting. The feed's own reconnect loop
        # (bounded backoff + 805 parking) is what actually protects the WS limit.
        if broker.is_connected and fetcher and _QUOTE_SECURITIES:
            insts = _ws_instrument_list()
            if insts:
                try:
                    feed = MarketFeed(broker.context, insts, version='v2',
                                      on_ticks=_ws_on_tick, on_connect=_ws_on_connect,
                                      on_close=_ws_on_close, on_error=_ws_on_error)
                    feed._token = broker.context.get_access_token()
                    with _WS_LOCK:
                        _WS_FEED = feed
                        _WS_SUBSCRIBED = set(insts)
                    _ws_drain_pending()
                    _WS_LAST_TICK = time.time()
                    logger.info("ws feed starting with %d instruments", len(insts))
                    t = feed.start()
                    t.join()
                except Exception as e:
                    logger.warning("ws feed start error: %s", e)
                with _WS_LOCK:
                    _WS_FEED = None
                    _WS_SUBSCRIBED = set()
        time.sleep(3)

def _start_ws_thread():
    global _WS_RUNNING, _WS_THREAD, _BCAST_RUNNING, _BCAST_THREAD
    if not _BCAST_RUNNING:
        _BCAST_RUNNING = True
        _BCAST_THREAD = threading.Thread(target=_broadcast_loop, daemon=True)
        _BCAST_THREAD.start()
    # Same liveness check as _start_quote_thread: if the supervisor thread died
    # while _WS_RUNNING stayed True, a later connect()/restart must actually
    # respawn it instead of returning early on the stale flag.
    alive = _WS_THREAD is not None and _WS_THREAD.is_alive()
    if _WS_RUNNING and alive:
        return
    _WS_RUNNING = True
    _WS_THREAD = threading.Thread(target=_ws_quote_loop, daemon=True)
    _WS_THREAD.start()


def _stop_feed_threads():
    """Manually stop the live feed + quote/daily threads so Dhan's connection
    slot budget can drain.

    The 429 "too many connections" reconnect loop keeps opening new WebSockets
    faster than Dhan expires the stale ones, so even with a single session the
    account saturates its 5-connection limit and the feed never stays up. This
    cleanly stops every background loop and closes the current feed so the slots
    are released; the user waits out the cooldown, then reconnects."""
    global _WS_RUNNING, _QUOTE_RUNNING, _WS_FEED, _WS_SUBSCRIBED, _WS_PERSIST, \
        _WS_RL_UNTIL, _QUOTE_SECURITIES, _QUOTE_CACHE, _BCAST
    _WS_RUNNING = False
    _QUOTE_RUNNING = False
    with _WS_LOCK:
        feed = _WS_FEED
        _WS_FEED = None
        _WS_SUBSCRIBED = set()
        _WS_PERSIST = set()
    if feed is not None:
        try:
            feed.close_connection()
        except Exception:
            pass
    _WS_RL_UNTIL = 0.0
    with _QUOTE_CACHE_LOCK:
        _QUOTE_CACHE.clear()
        with _BCAST_LOCK:
            _BCAST.clear()
    _QUOTE_SECURITIES = None

def _ws_sync_instruments():
    """Subscribe feed symbols added to the watchlist, then re-drain any pending
    option-strike subscriptions.

    Only ever adds: the dropdown watchlist is static and extra one-off
    subscriptions (option strikes opened from the option chain) must never be
    removed by a watchlist sync."""
    global _WS_SUBSCRIBED
    feed = _WS_FEED
    with _WS_LOCK:
        if feed:
            target = set(_ws_instrument_list())
            if target:
                add = target - _WS_SUBSCRIBED
                if add:
                    try:
                        feed.subscribe_symbols(list(add))
                        _WS_SUBSCRIBED = _WS_SUBSCRIBED | add
                    except Exception:
                        pass
    _ws_drain_pending()

def _ws_drain_pending():
    """(Re)subscribe option strikes queued in _WS_PERSIST.

    Option-chain subscriptions are queued whenever the feed is not up yet. Unlike
    watchlist symbols (re-synced by the /api/quotes poll), a dropped option
    subscription used to be lost forever - the table only came alive after a
    manual reload re-ran _ws_subscribe_oc_strikes. Called from every watchlist
    sync and right after the feed (re)connects, this re-subscribes any persisted
    strikes so LTP / change / OI stream without a reload."""
    global _WS_SUBSCRIBED
    with _WS_LOCK:
        feed = _WS_FEED
        if feed is None or not _WS_PERSIST:
            return
        sub_keys = {(x[0], x[1]) for x in _WS_SUBSCRIBED}
        need = [t for t in _WS_PERSIST if (t[0], t[1]) not in sub_keys]
        if not need:
            return
        try:
            feed.subscribe_symbols(need)
            _WS_SUBSCRIBED = _WS_SUBSCRIBED | set(need)
        except Exception:
            pass

def _ws_subscribe_extra(security_id, exchange_segment):
    """Subscribe an instrument that is not in the watchlist (e.g. an option
    strike opened from the option chain) so its candle patches get live ticks.
    Options use FULL mode so OI, Volume and Bid/Ask packets are delivered too.

    Queued into _WS_PERSIST so the subscription is not lost if the feed is
    momentarily down when this is called."""
    if exchange_segment not in ("NSE_FNO", "BSE_FNO", "MCX_COMM"):
        return
    global _WS_SUBSCRIBED
    seg = _option_segment(exchange_segment)
    code = MarketFeed.NSE_FNO if seg == "NSE_FNO" else (MarketFeed.BSE_FNO if seg == "BSE_FNO" else MarketFeed.MCX)
    tup = (code, str(security_id), MarketFeed.Full)
    with _WS_LOCK:
        if any(t[0] == code and t[1] == str(security_id) for t in _WS_SUBSCRIBED):
            return
        _WS_PERSIST.add(tup)
        feed = _WS_FEED
        if feed is None:
            return
        try:
            feed.subscribe_symbols([tup])
            _WS_SUBSCRIBED = _WS_SUBSCRIBED | {tup}
        except Exception:
            pass

def _ws_subscribe_options(security_ids, exchange_segment):
    """Bulk-subscribe every strike of an option chain (FULL mode).

    FULL mode delivers a single stream with LTP, Volume, Bid/Ask (top of book),
    OI and change all live - the whole option-chain row updates from the feed
    instead of waiting on the slow REST /optionchain refresh.

    Every strike is queued into _WS_PERSIST; if the feed is not connected yet
    the queued set is drained automatically once it (re)connects."""
    if not security_ids:
        return
    global _WS_SUBSCRIBED
    seg = _option_segment(exchange_segment)
    if seg == "NSE_FNO":
        code = MarketFeed.NSE_FNO
    elif seg == "BSE_FNO":
        code = MarketFeed.BSE_FNO
    else:
        code = MarketFeed.MCX
    tuples = [(code, str(sid), MarketFeed.Full) for sid in security_ids]
    with _WS_LOCK:
        for t in tuples:
            _WS_PERSIST.add(t)
        sub_keys = {(x[0], x[1]) for x in _WS_SUBSCRIBED}
        need = [t for t in tuples if (t[0], t[1]) not in sub_keys]
        if not need:
            return
        feed = _WS_FEED
        if feed is None:
            return
        try:
            feed.subscribe_symbols(need)
            _WS_SUBSCRIBED = _WS_SUBSCRIBED | set(need)
        except Exception:
            pass

def _ws_subscribe_oc_strikes(records, exchange_segment):
    """Collect the CE/PE security ids of an option chain and subscribe them."""
    if not records:
        return
    ids = set()
    for r in records:
        if r.get("CE SID"):
            ids.add(int(r["CE SID"]))
        if r.get("PE SID"):
            ids.add(int(r["PE SID"]))
    if ids:
        _ws_subscribe_options(sorted(ids), exchange_segment)

STATIC_DIR = os.path.join(os.path.dirname(__file__), "templates")

# ---- Scrip master cache (for resolving option security ids) ----
_SCRIP_CACHE = {"df": None, "at": 0.0}
_SCRIP_LOCK = threading.Lock()
_SCRIP_URL = "https://images.dhan.co/api-data/api-scrip-master.csv"
logger = logging.getLogger(__name__)

# ---- TTL response cache (candles / expiries / option chain) ----
_DATA_CACHE = {}
_DATA_CACHE_LOCK = threading.Lock()
_DATA_TTL = {
    "candles": 120,         # seconds; the realtime path patches the last bar with live LTP,
                            # so a longer TTL makes symbol switch-backs instant instead of
                            # re-running Dhan's slow (~8-20s) equity intraday fetch. Freshness
                            # is preserved by the WS patch, not by re-fetching the list.
    "expiries": 86400,      # expiry lists change only ~weekly; 24h cache avoids
                            # a slow Dhan call on every symbol switch / app start
    "option_chain": 120,    # Dhan /optionchain takes ~20s for a full chain; the WS feed keeps
                            # LTP/change/OI live, so a 120s REST refresh is enough for greeks and
                            # makes repeat experiment runs fast instead of re-paying the ~20s fetch.
}
_DATA_CACHE_MAX = 256

# In-flight guards so a slow Dhan fetch is never duplicated by overlapping
# requests. Key -> True while a refresh is running; other requests for the same
# key serve the stale snapshot immediately instead of piling on more API calls.
_DATA_INFLIGHT = set()
_DATA_INFLIGHT_LOCK = threading.Lock()

# ---- Serialized option-chain REST refresh pipeline ----
# Dhan /optionchain is throttled to 1 req/3s and an empty response arms a 30s
# surface cooldown. When a commodity's strikes are NOT in the scrip master the
# first load of every expiry needs a REST fetch; firing them all at once (as
# the all-expiries endpoint used to) queued a dozen ~20s background threads that
# tripped the cooldown and left the whole surface at "Rate limited". Instead
# every OC REST refresh is enqueued here and drained ONE at a time, and each
# success is persisted into the scrip-master bucket so the next load of that
# expiry is instant. `_DATA_INFLIGHT` still dedupes per-chain refreshes.
_OC_REFRESH_QUEUE = []
_OC_REFRESH_LOCK = threading.Lock()
_OC_WORKER_STARTED = False

# Negative expiry-cache: cache_key -> last-failure timestamp. The browser polls
# /api/expiries every ~2s; without this a single empty-body failure from the
# expiry endpoint would re-arm the GLOBAL rate-limit cooldown (and block
# /api/candles at 503) on every single poll. Serving the soft error from this
# short-lived failure cache means Dhan is only re-hit for a given underlying
# once per window, keeping the global gate clear for the rest of the time.
_EXPIRY_FAIL_CACHE = {}
_EXPIRY_FAIL_CACHE_SEC = 120.0
_EXPIRY_FAIL_LOCK = threading.Lock()


def _cache_get(key):
    with _DATA_CACHE_LOCK:
        hit = _DATA_CACHE.get(key)
        if hit and time.time() - hit["at"] < hit["ttl"]:
            return hit["value"]
        return None


def _cache_get_raw(key):
    """Read a cache entry ignoring its TTL. Returns (value, age_seconds) or (None, None)."""
    with _DATA_CACHE_LOCK:
        hit = _DATA_CACHE.get(key)
        if hit:
            return hit["value"], time.time() - hit["at"]
        return None, None


def _get_live_quote(security_id, exchange_segment, instrument_type):
    """Return the freshest live quote for a security, or None.

    Preferred source is the _QUOTE_CACHE, which is now fed tick-by-tick by the
    WebSocket market feed (indices/equities/options) and only fallback-fed by
    REST polling. Options that are not yet subscribed fall back to a direct but
    throttled REST quote call (once per 5s per security).
    """
    with _QUOTE_CACHE_LOCK:
        # Segment-aware lookup: security_id values are NOT unique across segments
        # (e.g. NSE stock #13 and NIFTY IDX_I #13 both exist), so str(sid) must
        # never be used for an index. Otherwise the chart patches an index candle
        # with an unrelated stock's LTP and draws a huge fake wick.
        if exchange_segment == "IDX_I":
            hit = _QUOTE_CACHE.get(f"IDX_I:{security_id}")
        else:
            hit = _QUOTE_CACHE.get(str(security_id))
        if hit and hit.get("ltp") and hit.get("live") and (time.time() - hit.get("at", 0)) < 30:
            return hit
    if instrument_type not in ("OPTIDX", "OPTSTK", "FUTCOM", "OPTFUT"):
        return None
    with _LIVE_PATCH_LOCK:
        do_fetch = time.time() - _LIVE_PATCH.get(security_id, 0) >= 5
        if do_fetch:
            _LIVE_PATCH[security_id] = time.time()
    if not do_fetch:
        return None
    try:
        seg = exchange_segment if exchange_segment in ("NSE_FNO", "BSE_FNO", "MCX_COMM") else "NSE_FNO"
        quotes = fetcher.fetch_market_quotes({seg: [security_id]})
        return quotes.get(int(security_id))
    except Exception:
        return None


def _patch_last_candle(candles, live, timeframe):
    """Patch the last candle's high/low/close with a live LTP.

    Only stretches the bar when it is still the currently-forming one, so a
    closed/stale bar is never given an abnormally long wick. Returns the live
    quote's previous close (for gain/loss) or None.
    """
    if not candles or not live:
        return None
    ltp = live.get("ltp", 0)
    if not ltp or ltp <= 0:
        return None
    last = candles[-1]
    if _last_bar_is_current(timeframe, last["time"]):
        if ltp > last["high"]:
            last["high"] = ltp
        if ltp < last["low"]:
            last["low"] = ltp
        last["close"] = ltp
    qclose = live.get("close")
    qltp = live.get("ltp", 0)
    if qclose and qclose > 0 and qclose != qltp:
        return qclose
    return None


def _cache_set(key, value, kind):
    with _DATA_CACHE_LOCK:
        _DATA_CACHE[key] = {"at": time.time(), "value": value, "ttl": _DATA_TTL.get(kind, 60)}
        if len(_DATA_CACHE) > _DATA_CACHE_MAX:
            now = time.time()
            stale = [k for k, v in _DATA_CACHE.items() if now - v["at"] >= v["ttl"]]
            for k in stale:
                _DATA_CACHE.pop(k, None)


def _build_scrip_lookups(df):
    """Precompute O(1) lookup structures for lot-size resolution.

    The scrip master has ~200k rows; re-filtering the DataFrame on every HTTP
    request is wasteful. Built once per scrip-master load:
      - sid_rows:   {security_id_str: [row, ...]} - ids collide across segments
      - fo_by_type: {(underlying_prefix, instrument): [row, ...]} - F&O rows
      - oc_map:     {(exch, prefix, expiry_date): {strike: {"CE": sid, "PE": sid,
                     "lot": lot}}} - option strikes for instant chain building
    Each row is a ready-to-serialize dict with lot_size / trading_symbol /
    instrument_type / exchange_segment.
    """
    sid_rows = {}
    fo_by_type = {}
    oc_map = {}
    fno_types = ("FUTIDX", "FUTSTK", "OPTIDX", "OPTSTK", "FUTCOM", "OPTFUT")
    opt_types = ("OPTIDX", "OPTSTK", "OPTFUT")
    for row in df.itertuples():
        sid = str(getattr(row, "SEM_SMST_SECURITY_ID")).strip()
        inst = str(getattr(row, "SEM_INSTRUMENT_NAME")).strip()
        symbol = str(getattr(row, "SEM_TRADING_SYMBOL") or "")
        exch = str(getattr(row, "SEM_EXM_EXCH_ID")).strip()
        lot = float(getattr(row, "SEM_LOT_UNITS") or 0)
        if not sid:
            continue
        entry = {
            "lot_size": lot,
            "security_id": int(sid),
            "trading_symbol": symbol,
            "instrument_type": inst,
            "exchange_segment": exch,
            "expiry_date": str(getattr(row, "SEM_EXPIRY_DATE") or "")[:10],
            "tick_size": float(getattr(row, "SEM_TICK_SIZE") or 0),
        }
        # Only F&O ids are ever looked up by security id; keeping the whole
        # master (incl. every equity + currency pair) just wastes time/ram.
        if inst in fno_types:
            sid_rows.setdefault(sid, []).append(entry)
            if symbol and "-" in symbol:
                prefix = symbol.split("-")[0]
                if prefix:
                    fo_by_type.setdefault((prefix, inst), []).append(entry)
        # Index option strikes into oc_map for the instant (WebSocket-first)
        # option chain: strike -> CE/PE security id + lot size.
        if inst in opt_types and symbol and "-" in symbol:
            prefix = symbol.split("-")[0]
            expiry_date = str(getattr(row, "SEM_EXPIRY_DATE") or "")[:10]
            strike = float(getattr(row, "SEM_STRIKE_PRICE") or 0)
            otype = str(getattr(row, "SEM_OPTION_TYPE") or "").strip().upper()
            if prefix and expiry_date and strike and otype in ("CE", "PE"):
                bucket = oc_map.setdefault((exch, prefix.upper(), expiry_date), {})
                strike_entry = bucket.setdefault(strike, {"lot": lot})
                strike_entry[otype] = int(sid)
    # Re-merge any buckets learned at runtime (REST-discovered commodity
    # expiries the scrip master never covered) so the hourly scrip-master
    # refresh does not lose them.
    for key, bucket in _OC_PERSISTED.items():
        merged = oc_map.setdefault(key, {})
        for strike, ent in bucket.items():
            merged.setdefault(strike, {}).update(ent)
    _SCRIP_CACHE["sid_rows"] = sid_rows
    _SCRIP_CACHE["fo_by_type"] = fo_by_type
    _SCRIP_CACHE["oc_map"] = oc_map
    # Inverse map for per-tick IV: option security id -> strike/expiry/type.
    # Built from oc_map so live IV works without touching Dhan's slow chain API.
    global _OPT_META
    opt_meta = {}
    for (exch, prefix, expiry_date), bucket in oc_map.items():
        for strike, ent in bucket.items():
            for otype in ("CE", "PE"):
                sid = ent.get(otype)
                if sid:
                    opt_meta[sid] = {
                        "prefix": prefix, "expiry": expiry_date,
                        "strike": strike, "type": otype, "exch": exch,
                    }
    _OPT_META = opt_meta


def _get_scrip_master():
    with _SCRIP_LOCK:
        now = time.time()
        if _SCRIP_CACHE["df"] is None or now - _SCRIP_CACHE["at"] > 3600:
            import pandas as pd
            import requests
            path = os.path.join(tempfile.gettempdir(), "algodhan_scrip_master.csv")
            df = None
            # Prefer the on-disk CSV when it is fresh enough - avoids a slow
            # ~26 MB download on every server restart.
            try:
                if os.path.exists(path) and now - os.path.getmtime(path) < 3600:
                    df = pd.read_csv(path, low_memory=False)
            except Exception:
                df = None
            if df is None:
                try:
                    r = requests.get(_SCRIP_URL, timeout=60)
                    r.raise_for_status()
                    with open(path, "wb") as f:
                        f.write(r.content)
                    df = pd.read_csv(path, low_memory=False)
                except Exception as e:
                    logger.warning("Scrip master download failed: %s", e)
                    if os.path.exists(path):
                        try:
                            df = pd.read_csv(path, low_memory=False)
                        except Exception:
                            df = None
            if df is not None:
                _SCRIP_CACHE["df"] = df
                _SCRIP_CACHE["at"] = now
                _build_scrip_lookups(df)
        return _SCRIP_CACHE["df"]


def _fno_underlying(symbol_name):
    """Map a UI symbol name to its F&O trading-symbol prefix."""
    name = (symbol_name or "").strip().upper()
    mapping = {
        "NIFTY 50": "NIFTY", "BANK NIFTY": "BANKNIFTY", "FINNIFTY": "FINNIFTY",
        "SENSEX": "SENSEX", "MIDCPNIFTY": "MIDCPNIFTY", "GIFT NIFTY": "GIFTNIFTY",
        # NSE F&O uses shorter codes than the equity ticker for these stocks.
        "BAJAJ-AUTO": "BAJAJ", "NAM-INDIA": "NAM", "TATACOMM": "TATACOMM",
    }
    if name in mapping:
        return mapping[name]
    return name.replace(" ", "")


def _resolve_fno_underlying(symbol_name, security_id, exchange_segment):
    """Resolve the F&O underlying (security id + exchange segment) used by the
    option-chain / strike APIs.

    The UI hands us equity spots for F&O stocks (segment NSE_EQ/BSE_EQ) whose
    option chain lives on the derivative segment (NSE_FNO/BSE_FNO) under the
    FUTSTK/FUTIDX security id. Indices already carry their derivative segment
    (IDX_I / BSE_FNO). Resolve the correct underlying via the scrip master.
    """
    seg = str(exchange_segment or "").upper()
    if seg == "IDX_I":
        # Indices whose derivatives trade on BSE (e.g. SENSEX) must resolve to
        # their BSE_FNO FUTIDX underlying. Dhan's option-chain API returns no
        # volume and the market feed needs the BSE_FNO segment, but the UI sends
        # SENSEX as IDX_I. NSE indices (NIFTY etc.) keep working with IDX_I, so
        # only remap when the scrip master shows a BSE FUTIDX for this prefix.
        try:
            _get_scrip_master()
            prefix = _fno_underlying(symbol_name)
            rows = _SCRIP_CACHE.get("fo_by_type", {}).get((prefix, "FUTIDX"), [])
            bse_rows = [r for r in rows if r["exchange_segment"] == "BSE"]
            if bse_rows:
                return int(bse_rows[0]["security_id"]), "BSE_FNO"
        except Exception:
            pass
        return int(security_id), seg
    if seg in ("NSE_FNO", "BSE_FNO", "MCX_COMM", "NCD_FNO"):
        return int(security_id), seg
    # Equity segment: map to the derivative underlying via the scrip master.
    try:
        _get_scrip_master()
        prefix = _fno_underlying(symbol_name)
        fo_by_type = _SCRIP_CACHE.get("fo_by_type", {})
        exch = _scrip_exch_for(seg)
        for instr in ("FUTSTK", "FUTIDX"):
            rows = fo_by_type.get((prefix, instr), [])
            if not rows:
                continue
            if exch:
                seg_rows = [r for r in rows if r["exchange_segment"] == exch]
                if seg_rows:
                    rows = seg_rows
            row = rows[0]
            fno_seg = "BSE_FNO" if exch == "BSE" else "NSE_FNO"
            return int(row["security_id"]), fno_seg
    except Exception:
        pass
    return int(security_id), seg


def _scrip_exch_for(api_segment):
    """Map an API exchange segment to the scrip-master SEM_EXM_EXCH_ID.

    The Dhan scrip master stores the actual exchange (NSE/BSE/MCX), while the
    API uses segments like NSE_EQ / NSE_FNO / BSE_FNO / IDX_I."""
    seg = str(api_segment or "").upper()
    if "BSE" in seg:
        return "BSE"
    if "MCX" in seg:
        return "MCX"
    if "NCD" in seg:
        # NCDEX commodity derivatives (segment NCD_FNO). The scrip master
        # currently carries no NCDEX rows, so chains still fall back to the
        # REST path, but the bucket key is resolved correctly either way.
        return "NCDEX"
    if "NSE" in seg or seg == "IDX_I":
        return "NSE"
    return ""


# Authoritative MCX commodity-futures contract lot sizes (contract quantity in
# the same unit the MCX price is quoted in). Dhan's scrip master carries
# SEM_LOT_UNITS = 1.0 for every MCX contract, so it cannot be used for
# commodity position sizing; these are the standard MCX contract specs and are
# stable across expiries. Applied only to MCX (FUTCOM/OPTFUT) resolutions.
_MCX_LOT_BY_PREFIX = {
    "GOLD": 100, "GOLDM": 10, "GOLDGUINEA": 0.8, "GOLDPETAL": 0.1, "GOLDTEN": 1,
    "SILVER": 30, "SILVERM": 5, "SILVERMIC": 1, "SILVER100": 100,
    "CRUDEOIL": 100, "CRUDEOILM": 10,
    "NATURALGAS": 250, "NATGASMINI": 125,
    "COPPER": 2500, "ALUMINIUM": 5000, "ALUMINI": 1000,
    "LEAD": 5000, "LEADMINI": 1000, "ZINC": 5000, "ZINCMINI": 1000, "NICKEL": 250,
    "MENTHAOIL": 960, "COTTON": 25, "COTTONOIL": 10000, "KAPAS": 1,
    "CARDAMOM": 120, "STEELREBAR": 10000, "ELECDMBL": 10000,
}


def _mcx_lot_override(trading_symbol):
    """Best-effort authoritative MCX lot size for a FUTCOM/OPTFUT trading
    symbol like 'GOLD-05Oct2026-FUT' or 'GOLD-27Nov2026-166000-CE'. Returns the
    curated contract lot or 0 when the prefix is unknown."""
    sym = str(trading_symbol or "").upper()
    if "-" not in sym:
        return 0
    prefix = sym.split("-")[0]
    return float(_MCX_LOT_BY_PREFIX.get(prefix, 0) or 0)


def _resolve_lot_size(symbol_name, security_id, instrument_type, exchange_segment):
    """Resolve the realtime exchange lot size (SEM_LOT_UNITS) for a symbol.

    Source is the Dhan scrip master - the same instrument feed the broker
    account is built on - so every F&O underlying, index and option gets its
    current exchange lot size. Lookup priority:
      1. Exact SEM_SMST_SECURITY_ID match (options / futures), disambiguated by
         exchange segment and instrument type because security ids are NOT
         unique across segments (e.g. NIFTY index id 13 == ABB equity id 13).
      2. Underlying prefix match on F&O rows (FUTIDX/FUTSTK, then
         OPTIDX/OPTSTK) for index & equity spots via their derivative lot.
    Returns a dict or None.
    """
    if _get_scrip_master() is None:
        return None
    sid = security_id
    if sid is not None:
        try:
            sid_str = str(int(sid))
        except (TypeError, ValueError):
            sid_str = ""
        if sid_str:
            rows = _SCRIP_CACHE.get("sid_rows", {}).get(sid_str)
            inst = str(instrument_type or "").upper()
            if rows and inst in ("OPTIDX", "OPTSTK", "FUTIDX", "FUTSTK", "FUTCOM", "OPTFUT"):
                matched = [r for r in rows if r["instrument_type"] == inst]
                if matched:
                    rows = matched
                exch = _scrip_exch_for(exchange_segment)
                if exch:
                    seg_matched = [r for r in rows if r["exchange_segment"] == exch]
                    if seg_matched:
                        rows = seg_matched
                row = rows[0]
                if row["lot_size"]:
                    row = dict(row)
                    row["source"] = "security_id"
                    mcx_lot = _mcx_lot_override(row.get("trading_symbol"))
                    if mcx_lot > 0:
                        row["lot_size"] = mcx_lot
                    return row
            # INDEX / EQUITY spots fall through: their security ids collide
            # with other segments, so resolve via the derivative lot below.
    prefix = _fno_underlying(symbol_name)
    if not prefix:
        return None
    inst = str(instrument_type or "").upper()
    if inst in ("", "INDEX", "EQUITY", "IDX_I", "NSE_EQ"):
        fo_by_type = _SCRIP_CACHE.get("fo_by_type", {})
        exch = _scrip_exch_for(exchange_segment)
        for instr in ("FUTIDX", "FUTSTK", "OPTIDX", "OPTSTK", "FUTCOM", "OPTFUT"):
            rows = fo_by_type.get((prefix, instr), [])
            if not rows:
                continue
            if exch:
                seg_rows = [r for r in rows if r["exchange_segment"] == exch]
                if seg_rows:
                    rows = seg_rows
            row = rows[0]
            if not row["lot_size"]:
                continue
            out = dict(row)
            out["source"] = "underlying"
            mcx_lot = _mcx_lot_override(out.get("trading_symbol"))
            if mcx_lot > 0:
                out["lot_size"] = mcx_lot
            return out
    return None


_LOT_MAP_CACHE = {"data": None, "at": 0.0}
_LOT_MAP_LOCK = threading.Lock()


def _oc_instrument_meta(symbol_name, security_id, exchange_segment):
    """Resolve the instrument trading symbol + contract lot size for the option
    chain header. Prefers the FUT* contract row (e.g. 'GOLD-05Oct2026-FUT') via
    the underlying-prefix lookup so index / stock / commodity chains all get a
    clean instrument name and the exchange lot size from the scrip master.
    Returns {"symbol_name", "trading_symbol", "lot_size"} with None fallbacks -
    never raises, so the chain UI always has something to show."""
    out = {"symbol_name": symbol_name or "", "trading_symbol": None, "lot_size": None}
    fno_seg = exchange_segment
    try:
        _, fno_seg = _resolve_fno_underlying(symbol_name, security_id, exchange_segment)
    except Exception:
        pass
    try:
        row = _resolve_lot_size(symbol_name, security_id, "", fno_seg)
    except Exception:
        row = None
    if row:
        out["lot_size"] = row.get("lot_size") or None
        out["trading_symbol"] = row.get("trading_symbol") or None
    if not out["trading_symbol"]:
        out["trading_symbol"] = (symbol_name or "").upper()
    if out["lot_size"] is not None:
        try:
            out["lot_size"] = float(out["lot_size"])
        except (TypeError, ValueError):
            out["lot_size"] = None
    return out


def _build_lot_size_map():
    """Lot size lookup for every F&O underlying and index in the UI.

    Returns {"by_prefix": {underlying_prefix: lot_size},
             "by_name":  {ui_symbol_name: lot_size}} built from the Dhan scrip
    master so the paper-trading section can show realtime exchange lot sizes
    for every index and every F&O stock instead of hard-coded guesses.
    """
    with _LOT_MAP_LOCK:
        now = time.time()
        if _LOT_MAP_CACHE["data"] is not None and now - _LOT_MAP_CACHE["at"] < 3600:
            return _LOT_MAP_CACHE["data"]
        by_prefix = {}
        if _get_scrip_master() is not None:
            fo_by_type = _SCRIP_CACHE.get("fo_by_type", {})
            # Futures are the canonical lot size; options only fill gaps.
            for instr in ("FUTIDX", "FUTSTK", "FUTCOM"):
                for (prefix, i), rows in fo_by_type.items():
                    if i != instr:
                        continue
                    for row in rows:
                        if row["lot_size"] and prefix not in by_prefix:
                            lot = _mcx_lot_override(row["trading_symbol"])
                            by_prefix[prefix] = lot if lot > 0 else row["lot_size"]
            for instr in ("OPTIDX", "OPTSTK", "OPTFUT"):
                for (prefix, i), rows in fo_by_type.items():
                    if i != instr:
                        continue
                    for row in rows:
                        if row["lot_size"] and prefix not in by_prefix:
                            lot = _mcx_lot_override(row["trading_symbol"])
                            by_prefix[prefix] = lot if lot > 0 else row["lot_size"]
        by_name = {}
        for ui_name, prefix in {
            "NIFTY 50": "NIFTY", "BANK NIFTY": "BANKNIFTY", "FINNIFTY": "FINNIFTY",
            "SENSEX": "SENSEX", "MIDCPNIFTY": "MIDCPNIFTY", "GIFT NIFTY": "GIFTNIFTY",
        }.items():
            if prefix in by_prefix:
                by_name[ui_name] = by_prefix[prefix]
        result = {"by_prefix": by_prefix, "by_name": by_name}
        _LOT_MAP_CACHE["data"] = result
        _LOT_MAP_CACHE["at"] = now
        return result


def _warm_scrip_master():
    """Preload the scrip master + lot-size lookups in the background so the
    first paper-trading request does not block on the download."""
    try:
        _get_scrip_master()
        _build_lot_size_map()
    except Exception:
        logger.exception("Scrip master warmup failed")


threading.Thread(target=_warm_scrip_master, daemon=True, name="scrip-warmup").start()


def _resolve_option_security(symbol_name, expiry, strike, option_type, exchange_segment):
    df = _get_scrip_master()
    if df is None:
        raise ValueError("Scrip master unavailable. Cannot resolve option security id.")
    underlying = _fno_underlying(symbol_name)
    seg = _option_segment(exchange_segment)
    if seg == "BSE_FNO":
        exch = "BSE"
        insts = ["OPTIDX", "OPTSTK"]
    elif seg == "MCX_COMM":
        exch = "MCX"
        insts = ["OPTFUT", "OPTIDX"]
    else:
        exch = "NSE"
        insts = ["OPTIDX", "OPTSTK"]
    expiry_str = str(expiry)
    expiry_date = expiry_str[:10]
    strike_val = float(strike)
    option_type = str(option_type).upper()
    if option_type not in ("CE", "PE"):
        raise ValueError("option_type must be CE or PE")

    col_expiry = "SEM_EXPIRY_DATE"
    prefix = underlying.upper() + "-"

    # ---- Step 1: exact date match ----
    mask = (
        (df["SEM_EXM_EXCH_ID"] == exch)
        & (df["SEM_INSTRUMENT_NAME"].isin(insts))
        & (df["SEM_STRIKE_PRICE"].astype(float) == strike_val)
        & (df["SEM_OPTION_TYPE"].astype(str).str.upper() == option_type)
        & (df[col_expiry].astype(str).str[:10] == expiry_date)
        & (df["SEM_TRADING_SYMBOL"].astype(str).str.upper().str.startswith(prefix))
    )
    rows = df[mask]

    # ---- Step 2: constructed trading symbol ----
    if rows.empty:
        try:
            month = datetime.strptime(expiry_date, "%Y-%m-%d")
        except ValueError:
            month = None
        if month:
            if seg == "MCX_COMM":
                sym = f"{underlying}-{month.strftime('%b')}{expiry_date[:4]}-{int(strike_val)}-{option_type}"
            else:
                sym = f"{underlying}-{month.strftime('%b')}{expiry_date[:4]}-{int(strike_val)}-{option_type}"
            rows = df[df["SEM_TRADING_SYMBOL"].astype(str).str.upper() == sym.upper()]

    # ---- Step 3: relaxed match, prefer closest expiry ----
    if rows.empty:
        base = (
            (df["SEM_EXM_EXCH_ID"] == exch)
            & (df["SEM_INSTRUMENT_NAME"].isin(insts))
            & (df["SEM_STRIKE_PRICE"].astype(float) == strike_val)
            & (df["SEM_OPTION_TYPE"].astype(str).str.upper() == option_type)
            & (df["SEM_TRADING_SYMBOL"].astype(str).str.upper().str.startswith(prefix))
        )
        candidates = df[base].copy()
        if not candidates.empty:
            try:
                req_date = datetime.strptime(expiry_date, "%Y-%m-%d")
            except ValueError:
                req_date = None
            if req_date:
                def _parse_date(d):
                    try:
                        return datetime.strptime(str(d)[:19], "%Y-%m-%d %H:%M:%S")
                    except ValueError:
                        return None
                candidates["_parsed"] = candidates[col_expiry].apply(_parse_date)
                candidates["_diff"] = candidates["_parsed"].apply(
                    lambda d: abs((d - req_date).days) if d is not None else 9999
                )
                candidates = candidates.sort_values("_diff")
            rows = candidates

    if rows.empty:
        raise ValueError(
            f"No option security found for {underlying} {expiry_date} {int(strike_val)} {option_type} ({seg})"
        )
    row = rows.iloc[0]
    return {
        "security_id": int(row["SEM_SMST_SECURITY_ID"]),
        "exchange_segment": seg,
        "instrument_type": str(row["SEM_INSTRUMENT_NAME"]),
        "trading_symbol": str(row["SEM_TRADING_SYMBOL"]),
        "lot_size": float(row.get("SEM_LOT_UNITS", 0) or 0),
    }


def _option_segment(exchange_segment):
    """Map an underlying exchange segment to the F&O segment where its options trade."""
    seg = str(exchange_segment or "").upper()
    if "BSE" in seg:
        return "BSE_FNO"
    if "MCX" in seg:
        return "MCX_COMM"
    return "NSE_FNO"


def _apply_live_quotes(records, exchange_segment):
    """Overwrite the option-chain CE/PE change columns with authoritative
    market-quote net_change (exactly what the broker app displays)."""
    if not records:
        return records
    seg = _option_segment(exchange_segment)
    ce_ids = sorted({int(r["CE SID"]) for r in records if r.get("CE SID")})
    pe_ids = sorted({int(r["PE SID"]) for r in records if r.get("PE SID")})
    if not ce_ids and not pe_ids:
        return records
    securities = {}
    if ce_ids:
        securities[seg] = ce_ids
    if pe_ids:
        securities.setdefault(seg, []).extend(pe_ids)
    # Skip the extra quote call while Dhan is rate-limiting us; the option-chain
    # computed change is already a good fallback and this avoids deepening the
    # limit (which would starve the watchlist LTP too). Also skip it after market
    # close, where the quote API returns empty (code=None) and re-trips the
    # cooldown that makes the option-chain/expiry fetches fail.
    if rate_limit_cooldown_active() or not _any_market_open_now():
        return records
    try:
        quotes = fetcher.fetch_market_quotes(securities)
    except Exception as e:
        logger.warning("Market quote fetch failed (falling back to option chain change): %s", e)
        return records
    if not quotes:
        logger.warning("Market quote fetch returned empty (falling back to option chain change)")
        return records
    by_side = {}
    if ce_ids:
        by_side["CE"] = {r["Strike"]: r["CE SID"] for r in records}
    if pe_ids:
        by_side["PE"] = {r["Strike"]: r["PE SID"] for r in records}
    for r in records:
        for side in ("CE", "PE"):
            sid = by_side.get(side, {}).get(r["Strike"])
            q = quotes.get(int(sid)) if sid is not None else None
            if not q:
                continue
            # Only overwrite if we got a valid non-zero change from market quotes.
            # Dhan often returns net_change=0 for options, in which case the
            # option-chain computed value (ltp - prev_close) is the correct fallback.
            chg = q.get("change", 0)
            if chg != 0:
                r[f"{side} Chg"] = round(chg, 2)
                r[f"{side} Chg%"] = round(q.get("change_pct", 0), 2)
    # Seed the shared quote cache so the option-chain rows keep showing real
    # change/gain even though the WebSocket feed has no previous close for
    # these strikes (it would otherwise write change 0 and the UI shows 0.00).
    for side in ("CE", "PE"):
        for r in records:
            sid = r.get(f"{side} SID")
            if not sid:
                continue
            q = quotes.get(int(sid))
            if not q:
                continue
            mq_change = q.get("change", 0)
            # Prefer option-chain computed change when market quote returns 0
            use_chg = mq_change if mq_change != 0 else r.get(f"{side} Chg", 0)
            use_chg_pct = q.get("change_pct", 0) if mq_change != 0 else r.get(f"{side} Chg%", 0)
            ltp_q = q.get("ltp", 0)
            # Derive prev close from the authoritative change so close never equals
            # ltp. A close==ltp entry would be misread by the WebSocket tick path as
            # "no change" and reset the strike's gain/loss to a tick-to-tick drift.
            close = round(ltp_q - use_chg, 2) if use_chg else q.get("close", 0)
            _quote_write(str(int(sid)), {
                "ltp": ltp_q,
                "change": round(use_chg, 2),
                "close": close,
                "change_pct": round(use_chg_pct, 2),
            }, live=True)
    return records



@app.after_request
def add_no_cache(resp):
    # Keep API responses fresh, but allow the browser to cache versioned static
    # assets. Without this, every page load re-downloads ~260KB of JS over the
    # preview proxy, which is the dominant cause of slow loads.
    if request.path.startswith("/static/"):
        if request.path.endswith(".js"):
            # JS is actively iterated on during development and the preview
            # proxy ignores the ?v= query string in its cache key, so a 24h
            # max-age makes browsers serve stale code. Always revalidate with
            # the ETag / Last-Modified so updated files are picked up.
            resp.headers["Cache-Control"] = "public, no-cache, must-revalidate"
        else:
            resp.headers["Cache-Control"] = "public, max-age=86400"
        resp.headers.pop("Pragma", None)
        resp.headers.pop("Expires", None)
        return resp
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    resp.headers["Pragma"] = "no-cache"
    resp.headers["Expires"] = "0"
    return resp


@app.route("/")
def index():
    response = send_from_directory(STATIC_DIR, "index.html")
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return response


@app.route("/api/connect", methods=["POST"])
def api_connect():
    data = request.get_json()
    client_id = data.get("client_id", "").strip()
    access_token = data.get("access_token", "").strip()
    if not client_id or not access_token:
        return jsonify({"status": "error", "message": "Client ID and Access Token required"}), 400
    try:
        broker.connect(client_id, access_token)
        global fetcher
        fetcher = DataFetcher(broker)
        _start_quote_thread()
        _start_ws_thread()
        # Pre-load all main symbols' expiry lists into RAM so switching symbols
        # is a ~1ms cache hit instead of a slow Dhan call. Runs in the background
        # so connect returns instantly.
        threading.Thread(target=_warmup_expiries, daemon=True).start()
        return jsonify({"status": "success", "message": "Connected successfully"})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/api/status", methods=["GET"])
def api_status():
    return jsonify({"connected": broker.is_connected, "client_id": broker.client_id,
                    "auth_error": auth_error()})


@app.route("/api/feed/reset", methods=["POST"])
def api_feed_reset():
    """Manually stop the Dhan feed reconnect storm and release connection slots.

    When the account hits Dhan's 5-connection limit the feed loops
    connect -> killed -> 429 -> park -> retry, freezing candles / option chain /
    watchlist together. This stops every background thread and closes the feed
    cleanly so the slots drain; the frontend then shows a cooldown timer and
    reconnects once the sockets have expired."""
    _stop_feed_threads()
    return jsonify({
        "status": "success",
        "message": "Feed stopped. Connection slots are being released by Dhan.",
        "cooldown": _WS_MANUAL_COOLDOWN,
    })


@app.route("/api/feed/status", methods=["GET"])
def api_feed_status():
    """Diagnostics: is the live feed up, how stale is the last tick, how many
    symbols are subscribed. Lets the user see at a glance whether the feed is
    actually connected before blaming candles / chain / watchlist."""
    with _WS_LOCK:
        subscribed = len(_WS_SUBSCRIBED)
        persist = len(_WS_PERSIST)
        has_feed = _WS_FEED is not None
    age = round(time.time() - _WS_LAST_TICK, 1) if _WS_LAST_TICK else None
    with _WS_RL_LOCK:
        parked = round(max(0.0, _WS_RL_UNTIL - time.time()), 1)
    # Report the *actual* supervisor liveness, not just the flag: a dead thread
    # with _WS_RUNNING=True must surface as ws_running=false so the UI restarts
    # it automatically.
    ws_alive = _WS_THREAD is not None and _WS_THREAD.is_alive()
    return jsonify({
        "status": "success",
        "ws_running": ws_alive and _WS_RUNNING,
        "feed_up": has_feed,
        "subscribed": subscribed,
        "persist": persist,
        "last_tick_age_sec": age,
        "reconnect_parked_sec": parked,
    })


@app.route("/api/feed/restart", methods=["POST"])
def api_feed_restart():
    """Restart the background quote/feed supervisor threads without
    re-authenticating. Idempotent: if the threads are already alive this is a
    no-op. The frontend calls this when /api/feed/status reports the feed is not
    running while the broker is connected, so pending data self-heals without
    the user pressing Connect/Reconnect."""
    if not broker.is_connected:
        return jsonify({"status": "error", "message": "Not connected"}), 409
    _start_quote_thread()
    _start_ws_thread()
    return jsonify({"status": "success", "message": "Feed threads restarted"})


@app.route("/api/debug_ws", methods=["GET"])
def api_debug_ws():
    with _WS_TICK_TYPES_LOCK:
        types = dict(_WS_TICK_TYPES)
    with _WS_LOCK:
        subscribed = list(_WS_SUBSCRIBED)
        persist = list(_WS_PERSIST)
    ticker = [t for t in subscribed if t[2] == MarketFeed.Ticker]
    full = [t for t in subscribed if t[2] == MarketFeed.Full]
    quote = [t for t in subscribed if t[2] == MarketFeed.Quote]
    import collections
    segs = collections.Counter(t[0] for t in full)
    return jsonify({
        "subscribed": len(subscribed),
        "ticker": len(ticker),
        "quote": len(quote),
        "full": len(full),
        "full_segments": dict(segs),
        "persist": len(persist),
        "last_tick": _WS_LAST_TICK,
        "last_tick_age": round(time.time() - _WS_LAST_TICK, 2) if _WS_LAST_TICK else None,
        "tick_types": types,
        "bcast_clients": len(_BCAST_CLIENTS),
    })


@app.route("/api/client_time", methods=["POST"])
def api_client_time():
    """Diagnostic: log browser-vs-server clock skew and quote delivery age."""
    data = request.get_json(silent=True) or {}
    try:
        browser_ms = float(data.get("browser_ms", 0))
    except (TypeError, ValueError):
        browser_ms = 0
    try:
        quote_age = float(data.get("quote_age", -1))
    except (TypeError, ValueError):
        quote_age = -1
    try:
        min_age = float(data.get("min_age", -1))
    except (TypeError, ValueError):
        min_age = -1
    n = data.get("n", 0)
    if browser_ms > 0:
        skew = browser_ms / 1000.0 - time.time()
        logger.warning("client_time: skew=%.2fs min-age=%.2fs max-age=%.2fs n=%s", skew, min_age, quote_age, n)
    return jsonify({"status": "ok"})


_WARMUP_SYMBOLS = [
    (13, "IDX_I", "NIFTY 50"),
    (25, "IDX_I", "BANK NIFTY"),
    (27, "IDX_I", "FINNIFTY"),
    (51, "IDX_I", "SENSEX"),
]


def _expiries_still_valid(expiries):
    """Expiries are stale once every listed date is in the past. Dhan's weekly
    rolls happen on Thursdays; a 24h TTL plus this check keeps the RAM cache
    honest on expiry day without hammering Dhan on every symbol switch."""
    if not expiries:
        return False
    today = (datetime.utcnow() + timedelta(hours=5, minutes=30)).date().isoformat()
    return any(str(e)[:10] >= today for e in expiries)


def _fetch_and_cache_expiries(security_id, exchange_segment):
    """Fetch one underlying's expiry list and store it in the RAM cache."""
    # Never fire the expiry endpoint into an active rate-limit window: the
    # retry loop inside fetch_expiry_list re-trips DH-904 and, with the
    # background expiries refresh, used to keep the global cooldown alive.
    # The option-chain surface has its own gate now - a 429 there backs off the
    # option chain only and never black out /api/candles.
    if oc_rate_limited() or rate_limit_cooldown_active():
        return None
    cache_key = ("expiries", security_id, exchange_segment)
    # Negative-cache guard: a recent failed attempt means the endpoint (or the
    # Dhan gateway) is flaky right now - back off rather than re-hitting it on
    # every background refresh cycle and re-arming the global cooldown.
    with _EXPIRY_FAIL_LOCK:
        last_fail = _EXPIRY_FAIL_CACHE.get(cache_key)
    if last_fail and time.time() - last_fail < _EXPIRY_FAIL_CACHE_SEC:
        return None
    try:
        expiries = fetcher.fetch_expiry_list(security_id, exchange_segment)
        if expiries:
            _cache_set(cache_key, expiries, "expiries")
            with _EXPIRY_FAIL_LOCK:
                _EXPIRY_FAIL_CACHE.pop(cache_key, None)
            return expiries
    except Exception as e:
        logger.warning("expiry fetch failed %s/%s: %s", security_id, exchange_segment, e)
        with _EXPIRY_FAIL_LOCK:
            _EXPIRY_FAIL_CACHE[cache_key] = time.time()
    return None


def _refresh_expiries_bg(cache_key, security_id, exchange_segment):
    """Background refresh so the UI is never blocked waiting on Dhan."""
    try:
        _fetch_and_cache_expiries(security_id, exchange_segment)
    except Exception:
        pass
    finally:
        with _DATA_INFLIGHT_LOCK:
            _DATA_INFLIGHT.discard(cache_key)


def _warmup_expiries():
    """Pre-load every main symbol's expiry list into RAM once at connect, so
    symbol switches serve from memory (~1ms) instead of a slow Dhan call."""
    try:
        _get_scrip_master()          # also warms the option-strike map used by IV
        for sid, seg, name in _WARMUP_SYMBOLS:
            try:
                fno_sid, fno_seg = _resolve_fno_underlying(name, sid, seg)
            except Exception:
                fno_sid, fno_seg = sid, seg
            _fetch_and_cache_expiries(fno_sid, fno_seg)
    except Exception as e:
        logger.warning("expiry warm-up aborted: %s", e)


@app.route("/api/expiries", methods=["POST"])
def api_expiries():
    if not broker.is_connected:
        return jsonify({"status": "error", "message": "Not connected to Dhan"}), 401
    data = request.get_json()
    security_id = int(data.get("security_id", 13))
    exchange_segment = data.get("exchange_segment", "IDX_I")
    symbol_name = data.get("symbol_name", "")
    # F&O stocks arrive as equity spots (NSE_EQ); resolve to the derivative
    # underlying so Dhan returns the correct expiry list (weekly + monthly).
    try:
        security_id, exchange_segment = _resolve_fno_underlying(symbol_name, security_id, exchange_segment)
    except Exception:
        pass
    # Commodities with NO listed options (only ~10 of 28 MCX futures have
    # OPTFUT rows in the scrip master) must never be sent to Dhan's expiry
    # endpoint - the empty response would arm the 30s OC cooldown and surface
    # as "Rate limited" for a symbol that simply has no options.
    comm_exch = _scrip_exch_for(exchange_segment)
    if comm_exch in ("MCX", "NCDEX") and symbol_name and not _oc_prefix_has_options(_fno_underlying(symbol_name), comm_exch):
        return jsonify({"status": "error",
                        "message": "No options listed for " + str(symbol_name).upper(),
                        "instrument": _oc_instrument_meta(symbol_name, security_id, exchange_segment)}), 404
    cache_key = ("expiries", security_id, exchange_segment)
    cached = _cache_get(cache_key)
    if cached is not None and _expiries_still_valid(cached):
        return jsonify({"status": "success", "data": cached})
    # Serve the last known list instantly (zero UI wait) and refresh in the
    # background instead of blocking on Dhan - rate-limits / slow gateways no
    # longer stall the option-chain UI.
    stale, _ = _cache_get_raw(cache_key)
    if stale is not None:
        with _DATA_INFLIGHT_LOCK:
            inflight = cache_key in _DATA_INFLIGHT
            _DATA_INFLIGHT.add(cache_key)
        if not inflight:
            threading.Thread(target=_refresh_expiries_bg,
                             args=(cache_key, security_id, exchange_segment),
                             daemon=True).start()
        return jsonify({"status": "success", "data": stale, "stale": True})
    # Truly cold start (no cache at all): fetch synchronously with retries.
    # If a rate-limit cooldown is active, fail fast instead of hammering Dhan
    # (the frontend retries after the window lifts). A recent failure for this
    # same underlying is served from the negative cache so the every-~2s poll
    # does not re-hit Dhan and re-arm the global cooldown.
    with _EXPIRY_FAIL_LOCK:
        last_fail = _EXPIRY_FAIL_CACHE.get(cache_key)
    if last_fail and time.time() - last_fail < _EXPIRY_FAIL_CACHE_SEC:
        return jsonify({"status": "error",
                        "message": "Rate limited - wait a few seconds and retry"}), 503
    if oc_rate_limited() or rate_limit_cooldown_active():
        return jsonify({"status": "error",
                        "message": "Rate limited - wait a few seconds and retry"}), 503
    try:
        expiries = fetcher.fetch_expiry_list(security_id, exchange_segment)
        _cache_set(cache_key, expiries, "expiries")
        with _EXPIRY_FAIL_LOCK:
            _EXPIRY_FAIL_CACHE.pop(cache_key, None)
        return jsonify({"status": "success", "data": expiries})
    except Exception as e:
        with _EXPIRY_FAIL_LOCK:
            _EXPIRY_FAIL_CACHE[cache_key] = time.time()
        return jsonify({"status": "error", "message": str(e)}), 500


def _get_oc_spot(security_id, exchange_segment):
    """Best-effort underlying spot from the live quote cache for ATM selection.

    The frontend normally passes the spot it already has (from the watchlist
    feed), so this fallback only matters for direct API callers."""
    seg = str(exchange_segment or "").upper()
    with _QUOTE_CACHE_LOCK:
        if seg == "IDX_I":
            hit = _QUOTE_CACHE.get("IDX_I:%s" % security_id)
        else:
            hit = _QUOTE_CACHE.get(str(security_id))
        if hit and hit.get("ltp"):
            return float(hit["ltp"])
    return 0


def _oc_prefix_has_options(prefix, exch=None):
    """True when the scrip master (incl. REST-persisted buckets) carries ANY
    option strikes for this underlying prefix.

    Only ~10 of the 28 MCX commodity futures have listed options (the rest,
    e.g. ALUMINIUM / LEAD / NICKEL, have FUTCOM but no OPTFUT rows at all).
    For those, every expiry-list / option-chain call is a doomed Dhan
    /optionchain request whose empty body arms the 30s surface cooldown and
    surfaces as "Rate limited". Short-circuiting them avoids firing Dhan at all."""
    if not prefix:
        return True  # unknown prefix: let the REST path try
    _get_scrip_master()
    oc_map = _SCRIP_CACHE.get("oc_map")
    if not isinstance(oc_map, dict) or not oc_map:
        return True  # scrip master unavailable/empty: let the REST path try
    up = str(prefix).upper()
    if exch:
        return any(k[0] == exch and str(k[1]).upper() == up for k in oc_map)
    return any(str(k[1]).upper() == up for k in oc_map)


def _oc_bucket(symbol_name, fno_seg, expiry):
    """Resolve the scrip-master option bucket (strike -> {CE, PE}) for a symbol +
    expiry. Returns None when the scrip master has no strikes for it.

    The scrip master stores the REAL exchange (NSE/BSE/MCX), not the API
    segment (NSE_FNO/BSE_FNO/MCX_COMM). Resolving the exchange via
    `_scrip_exch_for` instead of hard-coding NSE/BSE lets MCX commodity options
    (OPTFUT strikes) hit the fast scrip-master + WebSocket instant chain path
    just like indices and F&O stocks - otherwise every commodity chain falls
    through to Dhan's slow (and rate-limited 1-req/3s) /optionchain REST call."""
    prefix = _fno_underlying(symbol_name)
    exch = _scrip_exch_for(fno_seg)
    if not exch:
        exch = "BSE" if str(fno_seg).upper() == "BSE_FNO" else "NSE"
    expiry_date = str(expiry)[:10]
    _get_scrip_master()
    oc_map = _SCRIP_CACHE.get("oc_map", {})
    key = (exch, prefix.upper(), expiry_date)
    if key in oc_map:
        return oc_map[key]
    # The scrip-master exchange id and the API segment mapping can disagree
    # (e.g. a segment resolved to the wrong exchange, or NCDEX rows stored under
    # a different id). Fall back to any other exchange that has strikes for this
    # prefix+expiry so a name mismatch never forces a slow REST chain fetch.
    for cand in ("MCX", "NSE", "BSE", "NCDEX"):
        if cand == exch:
            continue
        hit = oc_map.get((cand, prefix.upper(), expiry_date))
        if hit:
            return hit
    return None


def _oc_view_and_ids(bucket, fno_seg, spot, subscribe_window):
    """Return (view, ids, view_ids) for an option bucket:
      - view: the ATM window (or every strike) to render,
      - ids:  the CE/PE security ids to subscribe to the feed,
      - view_ids: the ids within `view` (what the first render actually shows).
    Subscribes ids so volume / LTP / OI stream in live.

    subscribe_window=True limits the feed to the ATM window so the all-expiries
    view stays within Dhan's feed cap when building every expiry at once."""
    strikes = sorted(bucket.keys())
    if not strikes:
        return [], set(), set()
    atm_strike = None
    if spot and spot > 0:
        atm_strike = min(strikes, key=lambda s: abs(s - spot))
    if atm_strike is None:
        atm_strike = strikes[len(strikes) // 2]
    atm_idx = strikes.index(atm_strike)
    window = 10
    lo = max(0, atm_idx - window)
    hi = min(len(strikes), atm_idx + window + 1)
    view = strikes[lo:hi]
    view_set = set(view)
    ids = set()
    view_ids = set()
    for st in (view if subscribe_window else strikes):
        ent = bucket[st]
        if ent.get("CE"):
            ids.add(int(ent["CE"]))
            if st in view_set:
                view_ids.add(int(ent["CE"]))
        if ent.get("PE"):
            ids.add(int(ent["PE"]))
            if st in view_set:
                view_ids.add(int(ent["PE"]))
    if ids:
        _ws_subscribe_options(sorted(ids), fno_seg)
    return view, ids, view_ids


def _wait_feed_warm(ids, max_wait=0.6):
    """Block until the live feed has delivered at least one live Full packet for
    the given option strikes (or max_wait elapses).

    Called right after subscribing so the instant chain render shows real
    volume / LTP / OI instead of zeros on the very first load. The WS feed is the
    fast path; the REST /optionchain refresh is slow and throttled to 1 per 3s,
    so without this the volume column would stay at 0 for a long time. Returns
    immediately when the cache is already warm (subsequent builds)."""
    deadline = time.time() + max_wait
    while time.time() < deadline:
        with _QUOTE_CACHE_LOCK:
            qc = _QUOTE_CACHE
            warm = any((qc.get(str(sid)) or {}).get("ltp")
                       or (qc.get(str(sid)) or {}).get("volume")
                       for sid in ids)
        if warm:
            return
        time.sleep(0.05)


def _persist_chain_to_oc_map(fno_seg, prefix, expiry_date, records):
    """Persist a successful Dhan option-chain fetch into the in-memory scrip
    master bucket ({(exch, prefix, expiry): {strike: {"CE": sid, "PE": sid}}})
    so the NEXT build of this chain uses the instant scrip-master + WebSocket
    path instead of hitting the slow, rate-limited /optionchain endpoint again.

    This is what permanently fixes commodity chains whose OPTFUT strikes the
    scrip master never carried (e.g. ALUMINIUM / LEAD / NICKEL expiries): the
    first load pays one REST call per expiry, every later load is instant. The
    buckets are stored in `_OC_PERSISTED` and re-merged on every scrip-master
    reload, and `_OPT_META` is extended so live IV works for the new strikes."""
    if not records or not prefix or not expiry_date:
        return
    _get_scrip_master()
    exch = _scrip_exch_for(fno_seg) or "MCX"
    key = (exch, str(prefix).upper(), str(expiry_date)[:10])
    with _SCRIP_LOCK:
        oc_map = _SCRIP_CACHE.get("oc_map")
        if not isinstance(oc_map, dict):
            _SCRIP_CACHE["oc_map"] = {}
            oc_map = _SCRIP_CACHE["oc_map"]
        persisted = _OC_PERSISTED.setdefault(key, {})
        target = oc_map.setdefault(key, {})
        for r in records:
            try:
                strike = float(r.get("Strike") or 0)
            except (TypeError, ValueError):
                continue
            if not strike or (not r.get("CE SID") and not r.get("PE SID")):
                continue
            ent = persisted.setdefault(strike, {"lot": _MCX_LOT_BY_PREFIX.get(str(prefix).upper(), 0)})
            for otype in ("CE", "PE"):
                sid = r.get(f"{otype} SID")
                if not sid:
                    continue
                sid_i = int(sid)
                ent[otype] = sid_i
                _OPT_META[sid_i] = {
                    "prefix": str(prefix).upper(), "expiry": key[2],
                    "strike": strike, "type": otype, "exch": exch,
                }
            if "lot" not in ent or not ent["lot"]:
                ent["lot"] = _MCX_LOT_BY_PREFIX.get(str(prefix).upper(), 0)
            target.setdefault(strike, {}).update(ent)


def _build_oc_instant(symbol_name, security_id, exchange_segment, expiry, spot=None,
                      subscribe_window=False, feed_wait=True):
    """Build the option-chain table instantly from the scrip master + live
    WebSocket quote cache - no Dhan /optionchain REST call, so it returns in
    milliseconds. Strikes and CE/PE security ids come from the scrip master;
    LTP / change / OI / Volume / Bid-Ask / IV all come from _QUOTE_CACHE (already
    streaming via the FULL-mode feed). Greeks (delta/theta/gamma/vega) are
    absent and filled later by the REST refresh.

    The strikes are subscribed BEFORE the cache snapshot and, on first load,
    `feed_wait` gives the feed a short window to land real volume / LTP / OI so
    the volume column is not stuck at 0 until the slow REST refresh runs.

    subscribe_window=True subscribes only the strikes shown in the ATM window
    (instead of every strike of the expiry). Used by the all-expiries endpoint so
    building every expiry at once does not flood the WebSocket feed with
    thousands of instruments.

    Returns {"records": [...], "spot": float} or None when the scrip master has
    no strikes for this symbol+expiry (caller falls back to the REST path)."""
    prefix = _fno_underlying(symbol_name)
    try:
        _, fno_seg = _resolve_fno_underlying(symbol_name, security_id, exchange_segment)
    except Exception:
        fno_seg = exchange_segment
    bucket = _oc_bucket(symbol_name, fno_seg, expiry)
    if not bucket:
        return None

    if not spot:
        spot = _get_oc_spot(security_id, exchange_segment)
    if spot and spot > 0:
        with _OPT_SPOT_LOCK:
            _OPT_SPOT[prefix.upper()] = float(spot)

    # Subscribe FIRST so the feed starts streaming volume / LTP / OI into the
    # quote cache, then give it a short window to land before we snapshot the
    # cache. Without this the very first render of a never-loaded chain shows
    # volume=0 until the throttled REST refresh finally fills it.
    view, ids, view_ids = _oc_view_and_ids(bucket, fno_seg, spot, subscribe_window)
    if ids and feed_wait:
        _wait_feed_warm(view_ids or ids, 0.25 if subscribe_window else 0.6)

    with _QUOTE_CACHE_LOCK:
        qc = dict(_QUOTE_CACHE)
    records = []
    for st in view:
        ent = bucket[st]
        ce_sid = ent.get("CE")
        pe_sid = ent.get("PE")
        ce_q = qc.get(str(ce_sid)) or {}
        pe_q = qc.get(str(pe_sid)) or {}
        records.append({
            "Strike": st,
            "CE SID": ce_sid,
            "PE SID": pe_sid,
            "CE LTP": ce_q.get("ltp") or 0,
            "CE Chg": ce_q.get("change") or 0,
            "CE Chg%": ce_q.get("change_pct") or 0,
            "CE OI": ce_q.get("oi") or 0,
            "CE Volume": ce_q.get("volume") or 0,
            "CE IV": ce_q.get("iv") or 0,
            "CE Bid": ce_q.get("bid") or 0, "CE Ask": ce_q.get("ask") or 0,
            "CE Delta": None, "CE Theta": None, "CE Gamma": None, "CE Vega": None,
            "PE LTP": pe_q.get("ltp") or 0,
            "PE Chg": pe_q.get("change") or 0,
            "PE Chg%": pe_q.get("change_pct") or 0,
            "PE OI": pe_q.get("oi") or 0,
            "PE Volume": pe_q.get("volume") or 0,
            "PE IV": pe_q.get("iv") or 0,
            "PE Bid": pe_q.get("bid") or 0, "PE Ask": pe_q.get("ask") or 0,
            "PE Delta": None, "PE Theta": None, "PE Gamma": None, "PE Vega": None,
        })
    return {"records": records, "spot": spot}


def _seed_chain_quotes(records):
    """Seed the shared quote cache from the option-chain records themselves.

    Every chain serve (instant partial OR full REST) writes each CE/PE strike's
    LTP / change / change_pct / prev-close / OI / Volume / Bid / Ask / IV into
    _QUOTE_CACHE. Without this, option strikes fall back to the WebSocket tick
    path which knows no prev close and writes change=0 close=0 (the seed from
    _apply_live_quotes is market-hours-only), so the UI overlays zeros over the
    real chain values and flickers between 0 and data. The WS tick path then
    PRESERVES this authoritative change (see _ws_apply_ltp) instead of zeroing it."""
    if not records:
        return
    for r in records:
        for side in ("CE", "PE"):
            sid = r.get(f"{side} SID")
            if not sid:
                continue
            ltp = float(r.get(f"{side} LTP") or 0)
            chg = float(r.get(f"{side} Chg") or 0)
            chg_pct = float(r.get(f"{side} Chg%") or 0)
            close = round(ltp - chg, 2) if (ltp and chg) else 0
            entry = {
                "ltp": ltp,
                "change": round(chg, 2),
                "change_pct": round(chg_pct, 2),
                "close": close,
                "oi": int(r.get(f"{side} OI") or 0),
                "volume": int(r.get(f"{side} Volume") or 0),
            }
            iv = r.get(f"{side} IV")
            if iv not in (None, ""):
                entry["iv"] = float(iv or 0)
            try:
                bid = float(r.get(f"{side} Bid") or 0)
                ask = float(r.get(f"{side} Ask") or 0)
            except (TypeError, ValueError):
                bid = ask = 0
            if bid > 0:
                entry["bid"] = bid
            if ask > 0:
                entry["ask"] = ask
            _quote_write(str(int(sid)), entry, live=True)


def _fetch_option_chain_data(security_id, exchange_segment, expiry, prefix=None):
    # Never fire the /optionchain endpoint into an active rate-limit window.
    # The background chain refresh was a main source of the recurring code=None
    # empty-body errors that kept /api/candles stuck at 503: its 2s/4s/6s retry
    # loop re-armed the global cooldown on every failure. Serving the stale
    # chain (or the scrip-master instant view) is far better than blocking the
    # whole candle surface for another 30s.
    if rate_limit_cooldown_active():
        raise ValueError("Rate limited - option chain temporarily unavailable")
    raw = fetcher.fetch_option_chain(security_id, exchange_segment, expiry)
    spot_price = float(raw.get("data", {}).get("last_price", 0) or 0)
    df = fetcher.parse_option_chain_to_dataframe(raw)
    if df.empty:
        raise ValueError("No data returned")
    records = df.to_dict(orient="records")
    records = [{k: (None if isinstance(v, float) and (v != v) else v) for k, v in r.items()} for r in records]
    _seed_chain_quotes(records)
    _ws_subscribe_oc_strikes(records, exchange_segment)
    # This chain was built from Dhan's REST endpoint, which means the scrip
    # master probably had no strikes for it (e.g. a commodity expiry it does not
    # cover). Persist the strikes/security-ids into the scrip-master bucket so
    # every later load of this expiry is instant instead of paying the slow,
    # rate-limited /optionchain call again.
    if prefix:
        _persist_chain_to_oc_map(exchange_segment, prefix, expiry, records)
    # Enrich change/gain with market quotes in the background. The option-chain
    # response must not be delayed by a second Dhan quote call (pre-market it can
    # hang); the computed change from the chain is a good fallback and the WS
    # broadcast applies the authoritative quote a moment later.
    threading.Thread(target=_apply_live_quotes, args=(records, exchange_segment), daemon=True).start()
    return {"records": records, "spot": spot_price, "count": len(records)}


def _oc_refresh_worker():
    """Drain the option-chain REST refresh queue ONE job at a time.

    Each successful fetch is persisted into the scrip-master bucket (inside
    `_fetch_option_chain_data`), so a commodity chain that needed the slow REST
    path once becomes instant on every later load. When Dhan rate-limits the OC
    surface mid-queue the remaining jobs fail fast (the surface gate raises
    immediately) instead of piling up, and the per-chain `_DATA_INFLIGHT` guard
    is released so a later request can retry after the cooldown clears."""
    while True:
        job = None
        with _OC_REFRESH_LOCK:
            if _OC_REFRESH_QUEUE:
                job = _OC_REFRESH_QUEUE.pop(0)
        if job is None:
            time.sleep(0.5)
            continue
        cache_key, security_id, exchange_segment, expiry, prefix = job
        try:
            payload = _fetch_option_chain_data(security_id, exchange_segment, expiry, prefix)
            _cache_set(cache_key, payload, "option_chain")
        except Exception as e:
            logger.warning("option chain refresh failed for %s: %s", str(cache_key), e)
        finally:
            with _DATA_INFLIGHT_LOCK:
                _DATA_INFLIGHT.discard(cache_key)


def _start_rest_refresh(cache_key, security_id, exchange_segment, expiry, prefix=None):
    """Enqueue a background Dhan /optionchain refresh (fills greeks/IV AND
    persists the chain into the scrip master) unless one is already in flight
    for this key. Callers serve the instant partial chain right away; the worker
    drains refreshes one at a time so a burst of missing commodity expiries can
    never trip Dhan's 1-req/3s option-chain rate limit all at once."""
    with _DATA_INFLIGHT_LOCK:
        if cache_key in _DATA_INFLIGHT:
            return
        _DATA_INFLIGHT.add(cache_key)
    global _OC_WORKER_STARTED
    with _OC_REFRESH_LOCK:
        _OC_REFRESH_QUEUE.append((cache_key, security_id, exchange_segment, expiry, prefix))
        if not _OC_WORKER_STARTED:
            _OC_WORKER_STARTED = True
            threading.Thread(target=_oc_refresh_worker, daemon=True).start()


@app.route("/api/option_chain", methods=["POST"])
def api_option_chain():
    if not broker.is_connected:
        return jsonify({"status": "error", "message": "Not connected to Dhan"}), 401
    data = request.get_json()
    security_id = int(data.get("security_id", 13))
    exchange_segment = data.get("exchange_segment", "IDX_I")
    expiry = data.get("expiry", "")
    symbol_name = data.get("symbol_name", "")
    prefix = _fno_underlying(symbol_name) if symbol_name else None
    try:
        spot = float(data.get("spot") or 0)
    except (TypeError, ValueError):
        spot = 0
    if not expiry:
        return jsonify({"status": "error", "message": "Expiry date required"}), 400
    # Guard against the frontend passing a non-date placeholder (e.g. the
    # "Error loading expiries" option text after an expiry-list fetch failure).
    # A bogus expiry would otherwise trigger a doomed ~20s Dhan chain call.
    try:
        datetime.strptime(expiry, "%Y-%m-%d")
    except ValueError:
        return jsonify({"status": "error", "message": "Invalid expiry date"}), 400
    # Resolve the F&O underlying for the (slow) Dhan /optionchain REST call.
    # The frontend sends the equity spot (segment NSE_EQ) for F&O stocks, but
    # Dhan's option-chain endpoint only returns the full chain with greeks when
    # given the derivative underlying (FUTSTK security id + NSE_FNO segment).
    # Without this, stock chains stuck at the instant partial view (greeks/IV/
    # volume all zero) while index chains filled in.
    try:
        fno_sid, fno_seg = _resolve_fno_underlying(symbol_name, security_id, exchange_segment)
    except Exception:
        fno_sid, fno_seg = security_id, exchange_segment

    instrument = _oc_instrument_meta(symbol_name, security_id, exchange_segment)

    # Commodity with no listed options: never fire the doomed /optionchain call
    # (its empty body arms the 30s OC cooldown -> "Rate limited").
    comm_exch = _scrip_exch_for(fno_seg)
    if comm_exch in ("MCX", "NCDEX") and prefix and not _oc_prefix_has_options(prefix, comm_exch):
        return jsonify({"status": "error",
                        "message": "No options listed for " + str(prefix) + " (commodity futures only)",
                        "instrument": instrument}), 404

    # Defensive: if we already have this symbol's expiry list cached, reject an
    # expiry that is not in it (e.g. a stale NIFTY Tuesday expiry sent for a
    # BSE SENSEX chain). This avoids a doomed ~20s Dhan call + rate-limit error.
    exp_cache_key = ("expiries", fno_sid, fno_seg)
    known_expiries = _cache_get(exp_cache_key)
    if known_expiries is not None and expiry not in known_expiries:
        return jsonify({"status": "error",
                        "message": "Invalid expiry for this symbol"}), 400
    cache_key = ("option_chain", security_id, exchange_segment, expiry)
    cached = _cache_get(cache_key)
    if cached is not None:
        _seed_chain_quotes(cached["records"])
        _ws_subscribe_oc_strikes(cached["records"], fno_seg)
        return jsonify({"status": "success", "data": cached["records"],
                        "spot_price": cached["spot"], "count": cached["count"],
                        "partial": bool(cached.get("partial")), "instrument": instrument})
    stale, _ = _cache_get_raw(cache_key)

    # A chain already exists (even stale): serve it immediately and refresh
    # greeks/IV in the background. Never regress a full (greeks-ready) chain
    # back to the partial scrip-master view.
    if stale is not None:
        _start_rest_refresh(cache_key, fno_sid, fno_seg, expiry, prefix)
        _seed_chain_quotes(stale["records"])
        _ws_subscribe_oc_strikes(stale["records"], fno_seg)
        return jsonify({"status": "success", "data": stale["records"],
                        "spot_price": stale["spot"], "count": stale["count"],
                        "stale": True, "partial": bool(stale.get("partial")),
                        "instrument": instrument})

    # True first-ever load for this chain: launch the (slow) REST refresh for
    # greeks and serve an instant scrip-master + WebSocket chain right away so
    # the table renders in milliseconds instead of waiting ~20s on Dhan. The
    # refresh persists the chain into the scrip master, so a commodity expiry
    # that needed the slow path once is instant on every later load.
    _start_rest_refresh(cache_key, fno_sid, fno_seg, expiry, prefix)
    try:
        inst = _build_oc_instant(symbol_name, security_id, exchange_segment, expiry, spot)
    except Exception as e:
        logger.warning("instant option chain build failed: %s", e)
        inst = None
    if inst is not None:
        _seed_chain_quotes(inst["records"])
        _cache_set(cache_key, {"records": inst["records"], "spot": inst["spot"],
                               "count": len(inst["records"]), "partial": True},
                   "option_chain")
        return jsonify({"status": "success", "data": inst["records"],
                        "spot_price": inst["spot"], "count": len(inst["records"]),
                        "partial": True, "instrument": instrument})

    # Fallback: scrip master unavailable or no strikes for this symbol/expiry.
    return jsonify({"status": "loading", "message": "Option chain loading",
                    "instrument": instrument}), 202


@app.route("/api/option_chain_all", methods=["POST"])
def api_option_chain_all():
    """Serve every expiry's option chain at once so the UI can show all expiries
    stacked in a single scrollable view without one-request-per-expiry switching.

    Each expiry is built instantly from the scrip master + WebSocket quote cache
    (`_build_oc_instant`), so a whole index/stock's expiries return in one shot
    with live LTP / change / OI / Volume / Bid-Ask / IV. Only the ATM window of
    each expiry is subscribed (subscribe_window=True) so the aggregate feed does
    not explode with thousands of instruments. The slow Dhan /optionchain REST
    refresh (greeks/IV precision) is launched in the background per expiry."""
    if not broker.is_connected:
        return jsonify({"status": "error", "message": "Not connected to Dhan"}), 401
    data = request.get_json()
    security_id = int(data.get("security_id", 13))
    exchange_segment = data.get("exchange_segment", "IDX_I")
    symbol_name = data.get("symbol_name", "")
    prefix = _fno_underlying(symbol_name) if symbol_name else None
    try:
        spot = float(data.get("spot") or 0)
    except (TypeError, ValueError):
        spot = 0

    try:
        fno_sid, fno_seg = _resolve_fno_underlying(symbol_name, security_id, exchange_segment)
    except Exception:
        fno_sid, fno_seg = security_id, exchange_segment

    instrument = _oc_instrument_meta(symbol_name, security_id, exchange_segment)

    # Commodity with no listed options: never fire the doomed /optionchain /
    # expiry-list calls (their empty bodies arm the 30s OC cooldown).
    comm_exch = _scrip_exch_for(fno_seg)
    if comm_exch in ("MCX", "NCDEX") and prefix and not _oc_prefix_has_options(prefix, comm_exch):
        return jsonify({"status": "error",
                        "message": "No options listed for " + str(prefix) + " (commodity futures only)",
                        "instrument": instrument}), 404

    exp_cache_key = ("expiries", fno_sid, fno_seg)
    expiries = _cache_get(exp_cache_key)
    if expiries is None:
        if rate_limit_cooldown_active():
            return jsonify({"status": "error",
                            "message": "Rate limited - wait a few seconds and retry"}), 503
        try:
            expiries = fetcher.fetch_expiry_list(fno_sid, fno_seg)
            _cache_set(exp_cache_key, expiries, "expiries")
        except Exception as e:
            logger.warning("expiry fetch failed in option_chain_all: %s", e)
            return jsonify({"status": "error", "message": str(e)}), 500
    if not expiries:
        return jsonify({"status": "error", "message": "No expiries available"}), 404

    if not spot:
        spot = _get_oc_spot(security_id, exchange_segment)

    # Pre-subscribe every expiry's ATM window and let the feed stream into the
    # quote cache for one short window BEFORE building. Without this the very
    # first all-expiries render shows volume=0 for every expiry - the per-expiry
    # REST /optionchain refresh is throttled to 1 per 3s and would otherwise
    # leave the volume column at 0 for a long time. The builds below then use
    # feed_wait=False (the wait was done once here) so we don't add ~0.25s per
    # expiry on top.
    try:
        pre_ids = set()
        for expiry in expiries:
            bucket = _oc_bucket(symbol_name, fno_seg, expiry)
            if not bucket:
                continue
            _, _, vids = _oc_view_and_ids(bucket, fno_seg, spot, True)
            pre_ids |= vids
        if pre_ids:
            _wait_feed_warm(pre_ids, 0.6)
    except Exception as e:
        logger.warning("all-expiries pre-subscribe failed: %s", e)

    chains = []
    errors = []
    for expiry in expiries:
        cache_key = ("option_chain", fno_sid, fno_seg, expiry)
        try:
            inst = _build_oc_instant(symbol_name, fno_sid, fno_seg, expiry, spot,
                                     subscribe_window=True, feed_wait=False)
        except Exception as e:
            logger.warning("instant chain build failed %s %s: %s", symbol_name, expiry, e)
            inst = None
        if inst is not None:
            _seed_chain_quotes(inst["records"])
            _cache_set(cache_key, {"records": inst["records"], "spot": inst["spot"],
                                   "count": len(inst["records"]), "partial": True},
                       "option_chain")
            _start_rest_refresh(cache_key, fno_sid, fno_seg, expiry, prefix)
            chains.append({
                "expiry": expiry, "records": inst["records"],
                "spot_price": inst["spot"], "count": len(inst["records"]),
                "partial": True, "instrument": instrument,
            })
            continue
        # No scrip-master strikes: serve a cached REST chain if one exists,
        # otherwise report a transient loading state for this expiry only.
        cached = _cache_get(cache_key)
        if cached is not None:
            _seed_chain_quotes(cached["records"])
            chains.append({
                "expiry": expiry, "records": cached["records"],
                "spot_price": cached["spot"], "count": cached["count"],
                "partial": bool(cached.get("partial")), "instrument": instrument,
            })
            continue
        _start_rest_refresh(cache_key, fno_sid, fno_seg, expiry, prefix)
        errors.append(expiry)

    if not chains:
        # No expiry built yet, but REST refreshes for the missing ones are
        # queued (one at a time) and will persist them into the scrip master.
        # Report loading (202) so the browser keeps polling with its gentle
        # backoff instead of treating it as a hard failure.
        if errors:
            return jsonify({"status": "loading", "message": "Option chain loading",
                            "expiries": expiries, "pending": errors,
                            "instrument": instrument}), 202
        return jsonify({"status": "error", "message": "Option chain unavailable"}), 503
    return jsonify({"status": "success", "expiries": expiries, "chains": chains,
                    "errors": errors})


@app.route("/api/auto_strikes", methods=["POST"])
def api_auto_strikes():
    """Resolve the option contracts (strike x CE/PE) the auto-experiment engine
    should paper-trade for a symbol, honouring the strike-mode / count / option
    type settings. Returns per-strike premiums and deltas so the client can
    price lots from option premium instead of the underlying."""
    if not broker.is_connected:
        return jsonify({"status": "error", "message": "Not connected to Dhan"}), 401
    data = request.get_json()
    security_id = int(data.get("security_id", 13))
    exchange_segment = data.get("exchange_segment", "IDX_I")
    symbol_name = data.get("symbol_name", "")
    mode = data.get("mode", "both_atm")
    count = max(1, int(data.get("count", 3)))
    option_type = data.get("option_type", "both")
    spot = float(data.get("spot", 0) or 0)

    # F&O stocks arrive as equity spots (NSE_EQ) - resolve to the derivative
    # underlying (FUTSTK + NSE_FNO) so the option chain is fetched correctly.
    security_id, exchange_segment = _resolve_fno_underlying(symbol_name, security_id, exchange_segment)

    exp_cache_key = ("expiries", security_id, exchange_segment)
    expiries = _cache_get(exp_cache_key)
    if expiries is None:
        if rate_limit_cooldown_active():
            return jsonify({"status": "error",
                            "message": "Rate limited - wait a few seconds and retry"}), 503
        try:
            expiries = fetcher.fetch_expiry_list(security_id, exchange_segment)
            _cache_set(exp_cache_key, expiries, "expiries")
        except Exception:
            return jsonify({"status": "error", "message": "No expiries"}), 500
    if not expiries:
        return jsonify({"status": "error", "message": "No expiries"}), 500
    expiry = expiries[0]

    oc_cache_key = ("option_chain", security_id, exchange_segment, expiry)
    cached = _cache_get(oc_cache_key)
    if cached is None:
        try:
            cached = _fetch_option_chain_data(security_id, exchange_segment, expiry,
                                              _fno_underlying(symbol_name) if symbol_name else None)
            _cache_set(oc_cache_key, cached, "option_chain")
        except Exception as e:
            return jsonify({"status": "error", "message": str(e)}), 500
    records = cached.get("records") or []
    if not records:
        return jsonify({"status": "error", "message": "No option chain data"}), 500
    if not spot:
        spot = float(cached.get("spot", 0) or 0)

    ordered = sorted(records, key=lambda r: float(r.get("Strike") or 0))
    atm_idx = 0
    if spot > 0:
        atm_idx = min(range(len(ordered)),
                      key=lambda i: abs(float(ordered[i].get("Strike") or 0) - spot))

    if mode == "above":
        chosen = ordered[atm_idx + 1: atm_idx + 1 + count]
    elif mode == "below":
        chosen = ordered[max(0, atm_idx - count): atm_idx]
    elif mode == "above_atm":
        chosen = ordered[atm_idx: atm_idx + 1 + count]
    elif mode == "below_atm":
        chosen = ordered[max(0, atm_idx - count): atm_idx + 1]
    elif mode == "both_atm_inc":
        chosen = ordered[max(0, atm_idx - count): atm_idx + 1 + count]
    elif mode == "atm":
        chosen = [ordered[atm_idx]]
    else:  # both_atm (default): above and below, excluding ATM
        chosen = ordered[max(0, atm_idx - count): atm_idx] + ordered[atm_idx + 1: atm_idx + 1 + count]

    def _f(v):
        return None if v is None else v

    contracts = []
    for r in chosen:
        contracts.append({
            "strike": _f(r.get("Strike")),
            "ce_ltp": _f(r.get("CE LTP")),
            "pe_ltp": _f(r.get("PE LTP")),
            "ce_chg": _f(r.get("CE Chg")),
            "pe_chg": _f(r.get("PE Chg")),
            "ce_chg_pct": _f(r.get("CE Chg%")),
            "pe_chg_pct": _f(r.get("PE Chg%")),
            "ce_delta": _f(r.get("CE Delta")),
            "pe_delta": _f(r.get("PE Delta")),
            "ce_sid": _f(r.get("CE SID")),
            "pe_sid": _f(r.get("PE SID")),
        })
    return jsonify({"status": "success", "spot": spot, "expiry": expiry,
                    "mode": mode, "count": count, "option_type": option_type,
                    "data": contracts})


@app.route("/api/sim/start", methods=["POST"])
def api_sim_start():
    """Start (or restart) the market-off candle simulator. Works whether or not
    Dhan is connected, so engines can keep testing on the synthetic chart even
    when the real market is closed."""
    data = request.get_json() or {}
    _simulator.start(data)
    st = _simulator.status()
    return jsonify({"status": "success", "running": st["running"], "config": st["config"], "ltp": st["ltp"]})


@app.route("/api/sim/stop", methods=["POST"])
def api_sim_stop():
    _simulator.stop()
    return jsonify({"status": "success", "running": False})


@app.route("/api/sim/status", methods=["GET"])
def api_sim_status():
    st = _simulator.status()
    return jsonify({"status": "success", "running": st["running"], "config": st["config"], "ltp": st["ltp"], "candles": st["candles"]})


@app.route("/api/sim/candles", methods=["POST"])
def api_sim_candles():
    data = request.get_json() or {}
    timeframe = data.get("timeframe", "1min")
    if not _simulator.status()["running"]:
        return jsonify({"status": "error", "message": "Simulator not running - start it from the Simulator tab"}), 503
    candles, prev_close = _simulator.candles_for(timeframe)
    return jsonify({
        "status": "success",
        "data": candles,
        "label": "SIM CHART " + timeframe,
        "count": len(candles),
        "prev_close": prev_close,
    })


@app.route("/api/candles", methods=["POST"])
def api_candles():
    data = request.get_json()
    security_id = int(data.get("security_id", 13))
    timeframe = data.get("timeframe", "5min")

    # Market-off simulator: when the synthetic symbol is requested, serve the
    # simulator's candle stream regardless of Dhan connection state so the
    # engines can keep testing when the market is closed.
    if security_id == SIM_SECURITY_ID:
        if not _simulator.status()["running"]:
            return jsonify({"status": "error", "message": "Simulator not running - start it from the Simulator tab"}), 503
        candles, prev_close = _simulator.candles_for(timeframe)
        return jsonify({
            "status": "success",
            "data": candles,
            "label": "SIM CHART " + timeframe,
            "count": len(candles),
            "prev_close": prev_close,
        })

    if not broker.is_connected:
        return jsonify({"status": "error", "message": "Not connected to Dhan"}), 401
    exchange_segment = data.get("exchange_segment", "IDX_I")
    instrument_type = data.get("instrument_type", "INDEX")
    force_realtime = data.get("force", 0)
    period_days = data.get("period_days", None)
    try:
        period_days = int(period_days) if period_days else None
    except (TypeError, ValueError):
        period_days = None

    if timeframe not in TIMEFRAME_CONFIG:
        return jsonify({"status": "error", "message": f"Invalid timeframe: {timeframe}"}), 400

    cache_key = ("candles", security_id, exchange_segment, instrument_type, timeframe, period_days or 0)

    # ---- Realtime fast path ----
    # The frontend realtime tick fires every 2s. A full Dhan historical fetch on
    # every tick trips the API rate limit and the chart silently freezes until a
    # manual reload. Instead, while the last cached bar is still the currently
    # forming bar, reuse the cached candle list and only patch its last candle
    # with the live LTP from the quote cache. A full refetch happens only when a
    # new bar has begun or the cache has gone stale.
    if force_realtime:
        cached, age = _cache_get_raw(cache_key)
        if cached is not None and cached.get("data"):
            candles = cached["data"]
            bar_current = bool(candles) and _last_bar_is_current(timeframe, candles[-1]["time"])
            reuse = bar_current
            if timeframe in ("week", "month", "year"):
                # These timeframes always report "current", so force a periodic
                # refetch to surface newly formed weekly/monthly bars.
                reuse = reuse and (age is None or age < _DATA_TTL["candles"])
            if reuse:
                prev_close = None
                if instrument_type in ("OPTIDX", "OPTSTK", "INDEX", "EQUITY", "FUTCOM", "OPTFUT"):
                    if instrument_type in ("OPTIDX", "OPTSTK", "FUTCOM", "OPTFUT"):
                        _ws_subscribe_extra(security_id, exchange_segment)
                    live = _get_live_quote(security_id, exchange_segment, instrument_type)
                    prev_close = _patch_last_candle(candles, live, timeframe)
                if prev_close is None:
                    prev_close = cached.get("prev_close")
                return jsonify({
                    "status": "success",
                    "data": candles,
                    "label": cached.get("label"),
                    "count": len(candles),
                    "prev_close": prev_close,
                })
            if age is not None and age < _DATA_TTL["candles"]:
                # The last cached bar is closed and its replacement has not been
                # fetched yet. During trading hours a new bar is forming right
                # now - fall through to a refetch (rate-limited by a short
                # cooldown) so the chart keeps forming bars in realtime. Only
                # return the cache as-is when the market is shut (evening,
                # weekend, holiday) or we refetched very recently.
                if not _market_open_now(exchange_segment) or _refetch_recent(cache_key):
                    return jsonify({
                        "status": "success",
                        "data": candles,
                        "label": cached.get("label"),
                        "count": len(candles),
                        "prev_close": cached.get("prev_close"),
                    })
                _mark_refetch(cache_key)
                # fall through to a full refetch below
        # Cache missing or stale: fall through to a full refetch below.

    cached = _cache_get(cache_key)
    if cached is not None and not force_realtime:
        return jsonify({
            "status": "success",
            "data": cached["data"],
            "label": cached["label"],
            "count": cached["count"],
            "prev_close": cached.get("prev_close"),
        })

    # Do not hammer Dhan while it is rejecting /charts (DH-904 rate limit /
    # DH-906 Invalid Token). Serve stale cache if present, otherwise return a
    # soft 503 so the frontend pauses instead of triggering an endless
    # fail->retry->fail loop that keeps the Dhan ban alive.
    # The global rate-limit cooldown matters as much as the per-key park: an
    # experiment fires many distinct OPTIDX candle keys (contract x timeframe),
    # each of which is a *different* cache key. Without the global gate, every
    # new key slips past the per-key park and re-trips DH-904, so the storm
    # never lifts and all option candles fail. Gate on BOTH: once the account
    # is rate-limited, back the whole candle surface off for the cooldown
    # window instead of letting new keys keep hitting Dhan.
    if _candle_fail_active(cache_key) or rate_limit_cooldown_active():
        if cached is not None:
            return jsonify({
                "status": "success",
                "data": cached["data"],
                "label": cached["label"],
                "count": cached["count"],
                "prev_close": cached.get("prev_close"),
            })
        return jsonify({
            "status": "error",
            "message": "Dhan chart API temporarily unavailable (rate limited)",
        }), 503

    # Single-flight guard: only one request per cache key may hit Dhan's
    # historical endpoint at a time. The experiment / paper-trade engines fire
    # bursts of concurrent /api/candles requests (symbols x timeframes); without
    # this every request in a burst raced through the _refetch_recent cooldown
    # together and each issued a full Dhan fetch, hammering the chart surface
    # into DH-904 rate-limit. Once rate-limited the realtime fast-path above
    # serves stale cached candles - the "old chart" the user saw. Concurrent
    # requests now get the last snapshot instantly while the single in-flight
    # refetch fills the cache.
    with _DATA_INFLIGHT_LOCK:
        inflight = cache_key in _DATA_INFLIGHT
        _DATA_INFLIGHT.add(cache_key)
    if inflight:
        snap, _ = _cache_get_raw(cache_key)
        if snap is not None and snap.get("data"):
            return jsonify({
                "status": "success",
                "data": snap["data"],
                "label": snap.get("label"),
                "count": snap.get("count"),
                "prev_close": snap.get("prev_close"),
            })
        return jsonify({
            "status": "error",
            "message": "Chart data still loading - retry in a moment",
        }), 503

    if not _hist_try_acquire():
        if cached is not None:
            return jsonify({
                "status": "success",
                "data": cached["data"],
                "label": cached["label"],
                "count": cached["count"],
                "prev_close": cached.get("prev_close"),
            })
        return jsonify({
            "status": "error",
            "message": "Chart data queue is busy - retry in a moment",
        }), 503

    try:
        df, label = fetcher.fetch_candles_for_timeframe(
            security_id, exchange_segment, instrument_type, timeframe, period_days
        )
        logger.warning("candles sid=%s seg=%s inst=%s tf=%s -> %d rows", 
                       security_id, exchange_segment, instrument_type, timeframe, len(df))
        if df.empty:
            return jsonify({"status": "error", "message": "No data returned"}), 404

        if df.index.tz is not None:
            df.index = df.index.tz_localize(None)

        candles = []
        for idx, row in df.iterrows():
            ts = int(idx.value / 1e9) if hasattr(idx, "value") else int(idx.timestamp())
            candles.append({
                "time": ts,
                "open": float(row["open"]),
                "high": float(row["high"]),
                "low": float(row["low"]),
                "close": float(row["close"]),
                "volume": int(row.get("volume", 0)) if "volume" in row else 0,
            })

        # ---- patch last candle with live LTP for realtime accuracy ----
        prev_close = None
        if candles and instrument_type in ("OPTIDX", "OPTSTK", "INDEX", "EQUITY"):
            if force_realtime:
                if instrument_type in ("OPTIDX", "OPTSTK"):
                    _ws_subscribe_extra(security_id, exchange_segment)
                live = _get_live_quote(security_id, exchange_segment, instrument_type)
                prev_close = _patch_last_candle(candles, live, timeframe)
            # prev_close from the daily candles so the chart header always has
            # gain/loss points + % (live quote may be unavailable). Skip on the
            # one-shot chart-open path (no `force`): it would add a blocking
            # daily API call and delay the chart by seconds.
            if prev_close is None and force_realtime:
                _, pc = _last_two_daily(security_id, exchange_segment, instrument_type)
                if pc:
                    prev_close = pc

        _cache_set(cache_key, {"data": candles, "label": label, "count": len(candles), "prev_close": prev_close}, "candles")
        return jsonify({
            "status": "success",
            "data": candles,
            "label": label,
            "count": len(candles),
            "prev_close": prev_close,
        })
    except Exception as e:
        _mark_candle_fail(cache_key)
        return jsonify({"status": "error", "message": str(e)}), 500
    finally:
        _hist_release()
        with _DATA_INFLIGHT_LOCK:
            _DATA_INFLIGHT.discard(cache_key)


@app.route("/api/quotes", methods=["POST"])
def api_quotes():
    if not broker.is_connected:
        return jsonify({"status": "error", "message": "Not connected to Dhan"}), 401
    data = request.get_json() or {}
    items = data.get("securities", [])
    if not items:
        return jsonify({"status": "error", "message": "securities list required"}), 400
    # Configure background polling securities list
    grouped = {}
    for it in items:
        seg = it.get("exchange_segment", "IDX_I")
        sid = int(it.get("security_id", 0))
        if seg not in grouped:
            grouped[seg] = []
        grouped[seg].append(sid)
    global _QUOTE_SECURITIES
    _QUOTE_SECURITIES = grouped
    _ws_sync_instruments()
    # Seed the cache on first call in a background thread so the request returns
    # immediately. The blocking Dhan quote API (throttled 1/sec, up to 60s per
    # call) used to run inline here, which made every /api/quotes poll block for
    # seconds and left the watchlist stale until a manual page reload.
    with _QUOTE_CACHE_LOCK:
        cache_empty = not _QUOTE_CACHE
    if cache_empty and not rate_limit_cooldown_active():
        threading.Thread(target=_seed_quote_cache, args=(grouped,), daemon=True).start()
    return jsonify({"status": "success", "data": dict(_QUOTE_CACHE), "auth_error": auth_error()})


@app.route("/api/account", methods=["GET"])
def api_account():
    if not broker.is_connected:
        return jsonify({"status": "error", "message": "Not connected to Dhan"}), 401
    with _ACCOUNT_CACHE_LOCK:
        acc = _ACCOUNT_CACHE.get("payload")
        if acc and time.time() - acc[0] < _ACCOUNT_CACHE_SEC:
            return jsonify(acc[1])
    try:
        _throttle()
        funds_raw = broker.dhan.get_fund_limits()
        _throttle()
        positions_raw = broker.dhan.get_positions()
        _throttle()
        holdings_raw = broker.dhan.get_holdings()

        funds_data = _unwrap_sdk_response(funds_raw) or {}
        positions_data = _unwrap_sdk_response(positions_raw) or []
        holdings_data = _unwrap_sdk_response(holdings_raw) or []

        positions_list = positions_data if isinstance(positions_data, list) else positions_data.get("data", [])
        if not isinstance(positions_list, list):
            positions_list = []

        holding_list = holdings_data if isinstance(holdings_data, list) else holdings_data.get("data", [])
        if not isinstance(holding_list, list):
            holding_list = []

        total_pnl = 0.0
        positions_parsed = []
        for p in positions_list:
            buy_avg = float(p.get("averagePrice", 0) or 0)
            ltp = float(p.get("lastPrice", 0) or 0)
            qty = int(p.get("netQty", 0) or 0)
            pos_type = p.get("positionType", "")
            mult = 1 if pos_type == "LONG" else -1
            pnl_val = (ltp - buy_avg) * qty * mult
            total_pnl += pnl_val
            positions_parsed.append({
                "symbol": p.get("tradingSymbol", ""),
                "security_id": p.get("securityId", ""),
                "exchange": p.get("exchangeSegment", ""),
                "qty": qty,
                "buy_avg": round(buy_avg, 2),
                "ltp": round(ltp, 2),
                "pnl": round(pnl_val, 2),
                "pnl_pct": round((pnl_val / (buy_avg * qty) * 100) if buy_avg and qty else 0, 2),
                "type": pos_type,
                "product": p.get("productType", ""),
            })

        holdings_parsed = []
        for h in holding_list:
            buy_avg = float(h.get("averagePrice", 0) or 0)
            ltp = float(h.get("lastPrice", 0) or 0)
            qty = int(h.get("totalQty", 0) or 0)
            pnl_val = (ltp - buy_avg) * qty
            holdings_parsed.append({
                "symbol": h.get("tradingSymbol", ""),
                "exchange": h.get("exchangeSegment", ""),
                "qty": qty,
                "buy_avg": round(buy_avg, 2),
                "ltp": round(ltp, 2),
                "pnl": round(pnl_val, 2),
                "pnl_pct": round((pnl_val / (buy_avg * qty) * 100) if buy_avg and qty else 0, 2),
                "isin": h.get("isin", ""),
            })

        avail_balance = funds_data.get("availabelBalance", 0) or 0
        used_margin = funds_data.get("utilizedAmount", 0) or 0
        total_balance = avail_balance + used_margin

        payload = {
            "status": "success",
            "data": {
                "balance": {
                    "total": round(total_balance, 2),
                    "available": round(float(avail_balance), 2),
                    "used_margin": round(float(used_margin), 2),
                    "collateral": round(float(funds_data.get("collateralAmount", 0) or 0), 2),
                    "opening_balance": round(float(funds_data.get("openingBalance", 0) or 0), 2),
                    "payin": round(float(funds_data.get("payinAmount", 0) or 0), 2),
                    "payout": round(float(funds_data.get("payoutAmount", 0) or 0), 2),
                },
                "pnl": round(total_pnl, 2),
                "positions": positions_parsed,
                "holdings": holdings_parsed,
            }
        }
        with _ACCOUNT_CACHE_LOCK:
            _ACCOUNT_CACHE["payload"] = (time.time(), payload)
        return jsonify(payload)
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/api/option_security", methods=["POST"])
def api_option_security():
    data = request.get_json() or {}
    symbol_name = data.get("symbol_name", "")
    expiry = data.get("expiry", "")
    strike = data.get("strike")
    option_type = data.get("option_type", "")
    exchange_segment = data.get("exchange_segment", "NSE_FNO")
    if not symbol_name or not expiry or strike is None or not option_type:
        return jsonify({"status": "error", "message": "symbol_name, expiry, strike and option_type required"}), 400
    try:
        resolved = _resolve_option_security(
            symbol_name, expiry, strike, option_type, exchange_segment
        )
        return jsonify({"status": "success", "data": resolved})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/api/lot_size", methods=["POST"])
def api_lot_size():
    """Realtime lot size for the currently selected symbol.

    Accepts symbol_name / security_id / instrument_type / exchange_segment and
    returns the live SEM_LOT_UNITS from the Dhan scrip master plus the source
    instrument it was read from. Paper trading uses it to auto-fill the lot
    size and derive quantity, margin and total price of lot.
    """
    data = request.get_json() or {}
    try:
        resolved = _resolve_lot_size(
            data.get("symbol_name", ""),
            data.get("security_id"),
            data.get("instrument_type", ""),
            data.get("exchange_segment", ""),
        )
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500
    if not resolved or not resolved.get("lot_size"):
        return jsonify({
            "status": "error",
            "message": "Lot size not found for symbol",
        }), 404
    return jsonify({"status": "success", "data": resolved})


@app.route("/api/lot_sizes", methods=["GET", "POST"])
def api_lot_sizes():
    """Realtime lot sizes for all F&O underlyings and all indices.

    Returns {by_prefix, by_name} maps built from the Dhan scrip master so the
    paper-trading section instantly knows the exchange lot size for every index
    and every F&O stock it lists.
    """
    try:
        data = _build_lot_size_map()
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500
    return jsonify({"status": "success", "data": data})


_COMMODITY_CACHE = {"data": None, "at": 0.0}
_COMMODITY_LOCK = threading.Lock()


@app.route("/api/commodities", methods=["GET"])
def api_commodities():
    """Near-month MCX commodity futures for the symbol picker / market watch.

    Returns the nearest unexpired FUTCOM contract per underlying with its
    authoritative lot size, tick size and expiry, so the frontend can induct
    commodities into SYMBOLS + the watchlist dynamically (MCX contract ids roll
    over every expiry, so they cannot be hard-coded)."""
    with _COMMODITY_LOCK:
        now = time.time()
        if _COMMODITY_CACHE["data"] is not None and now - _COMMODITY_CACHE["at"] < 900:
            return jsonify({"status": "success", "data": _COMMODITY_CACHE["data"]})
        if _get_scrip_master() is None:
            return jsonify({"status": "error", "message": "Scrip master unavailable"}), 503
        from datetime import datetime as _dt
        today = _dt.now()
        all_rows = []
        for (prefix, inst), rs in _SCRIP_CACHE.get("fo_by_type", {}).items():
            if inst == "FUTCOM":
                all_rows.extend(rs)
        def _exp_dt(r):
            try:
                return _dt.strptime(str(r.get("expiry_date") or "")[:10], "%Y-%m-%d")
            except Exception:
                return _dt.max
        def _trading_symbol(r):
            return r.get("trading_symbol") or ""
        near = {}
        for r in all_rows:
            if r.get("exchange_segment") != "MCX":
                continue
            sym = _trading_symbol(r)
            if "-" not in sym:
                continue
            exp_dt = _exp_dt(r)
            if exp_dt < today:
                continue
            prefix = sym.split("-")[0]
            if prefix not in near or exp_dt < _exp_dt(near[prefix]):
                near[prefix] = r
        out = []
        for prefix in sorted(near.keys()):
            r = near[prefix]
            sym = _trading_symbol(r)
            mcx_lot = _mcx_lot_override(sym)
            out.append({
                "name": prefix,
                "symbol": sym,
                "security_id": int(r["security_id"]),
                "lot_size": mcx_lot if mcx_lot > 0 else float(r.get("lot_size") or 0),
                "tick_size": float(r.get("tick_size") or 0),
                "expiry": str(r.get("expiry_date") or "")[:10],
                # Only ~10 of the 28 MCX futures have listed options. The engine
                # dropdowns show only option-bearing commodities, so flag each one.
                "has_options": _oc_prefix_has_options(prefix, "MCX"),
            })
        payload = {"commodities": out}
        _COMMODITY_CACHE["data"] = payload
        _COMMODITY_CACHE["at"] = now
        return jsonify({"status": "success", "data": payload})


# ---------------------------------------------------------------------------
# Backup & Restore system for the complete algo suite
#
# The whole algo system (all tabs, all engine settings, saved templates,
# saved strategies, P&L records, monitor lists, HFT jobs) persists in the
# browser's localStorage. The backup system therefore:
#   * gathers every localStorage key on the client (one snapshot object),
#   * writes timestamped snapshot files to a user-configured path on the
#     machine running this server (works on Windows PC paths too),
#   * supports manual export (save-to-path / download) and import/restore,
#   * runs an auto incremental backup on a daily/weekly clock schedule with
#     an enable/disable toggle, keeping the last N snapshots (auto-pruned).
# The schedule config is stored server-side in backup_config.json so it
# survives even if the browser profile is cleared.
# ---------------------------------------------------------------------------

_BACKUP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "backup_config.json")
_BACKUP_LOCK = threading.Lock()
_BACKUP_MAX_PAYLOAD = 50 * 1024 * 1024  # 50 MB safety cap
_BACKUP_MAX_FILES = 300                 # hard cap on files kept on disk

_BACKUP_DEFAULT_CONFIG = {
    "path": "",                       # e.g. "C:\\AlgoBackups" on Windows
    "enabled": False,                 # auto incremental backup toggle
    "schedule": {
        "type": "minute",             # 'minute' | 'hour' | 'daily' | 'weekly'
        "interval": 5,                # minutes/hours for minute|hour schedules
        "time": "18:00",              # HH:MM local time (daily/weekly)
        "weekday": 0,                 # 0=Monday..6=Sunday (weekly)
        "keep": 30,                   # scheduled snapshots retained (pruned)
    },
    "lastBackup": None,               # ISO timestamp of last snapshot
    "nextDue": None,                  # ISO timestamp of next scheduled backup
    "lastResult": {"ok": True, "message": "ready", "at": None, "file": None},
}


def _backup_load_config():
    cfg = dict(_BACKUP_DEFAULT_CONFIG)
    cfg["schedule"] = dict(_BACKUP_DEFAULT_CONFIG["schedule"])
    cfg["lastResult"] = dict(_BACKUP_DEFAULT_CONFIG["lastResult"])
    try:
        with open(_BACKUP_DIR, "r", encoding="utf-8") as f:
            saved = json.load(f)
        if isinstance(saved, dict):
            for k in ("path", "enabled", "lastBackup", "nextDue"):
                if k in saved:
                    cfg[k] = saved[k]
            if isinstance(saved.get("schedule"), dict):
                for k in ("type", "time", "weekday", "keep", "interval"):
                    if k in saved["schedule"]:
                        cfg["schedule"][k] = saved["schedule"][k]
            if isinstance(saved.get("lastResult"), dict):
                cfg["lastResult"].update(saved["lastResult"])
    except Exception:
        pass
    return cfg


def _backup_save_config(cfg):
    try:
        with open(_BACKUP_DIR, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2)
        return True
    except Exception:
        return False


def _backup_path(cfg, create=True):
    """Resolve the configured backup path, creating it when asked to."""
    p = str(cfg.get("path") or "").strip()
    if not p:
        return None
    if os.name == "nt":
        p = p.replace("/", "\\")
    p = os.path.expanduser(p)
    p = os.path.normpath(p)
    if create:
        try:
            os.makedirs(p, exist_ok=True)
        except Exception:
            pass
    return p


def _backup_next_due(cfg, now_ts):
    """Next scheduled backup time strictly after now_ts.

    Schedule types:
      minute -> every N minutes (interval)
      hour   -> every N hours (interval)
      daily  -> every day at HH:MM
      weekly -> every weekday at HH:MM
    """
    sch = cfg.get("schedule") or {}
    sched_type = sch.get("type")
    if sched_type not in ("minute", "hour", "daily", "weekly"):
        sched_type = "daily"
    try:
        interval = max(1, int(sch.get("interval") or 5))
    except Exception:
        interval = 5
    try:
        hh, mm = (sch.get("time") or "18:00").split(":")
        hh, mm = int(hh), int(mm)
    except Exception:
        hh, mm = 18, 0
    now = datetime.fromtimestamp(now_ts)
    if sched_type == "minute":
        return (now + timedelta(minutes=interval)).isoformat()
    if sched_type == "hour":
        return (now + timedelta(hours=interval)).isoformat()
    if sched_type == "weekly":
        target_wd = int(sch.get("weekday", 0))
        delta = (target_wd - now.weekday()) % 7
        candidate = now.replace(hour=hh, minute=mm, second=0, microsecond=0) + timedelta(days=delta)
        if candidate <= now:
            candidate += timedelta(days=7)
    else:
        candidate = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
        if candidate <= now:
            candidate += timedelta(days=1)
    return candidate.isoformat()


def _backup_last_scheduled(cfg, now_ts):
    """Most recent scheduled occurrence at-or-before now_ts (or None)."""
    sch = cfg.get("schedule") or {}
    sched_type = sch.get("type")
    if sched_type not in ("minute", "hour", "daily", "weekly"):
        sched_type = "daily"
    try:
        interval = max(1, int(sch.get("interval") or 5))
    except Exception:
        interval = 5
    try:
        hh, mm = (sch.get("time") or "18:00").split(":")
        hh, mm = int(hh), int(mm)
    except Exception:
        hh, mm = 18, 0
    now = datetime.fromtimestamp(now_ts)
    if sched_type == "minute":
        return (now - timedelta(minutes=interval)).isoformat()
    if sched_type == "hour":
        return (now - timedelta(hours=interval)).isoformat()
    if sched_type == "weekly":
        target_wd = int(sch.get("weekday", 0))
        delta = (now.weekday() - target_wd) % 7
        candidate = now.replace(hour=hh, minute=mm, second=0, microsecond=0) - timedelta(days=delta)
        if candidate > now:
            candidate -= timedelta(days=7)
        return candidate.isoformat()
    candidate = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
    if candidate > now:
        candidate -= timedelta(days=1)
    return candidate.isoformat()


def _backup_due_next(cfg, now_ts):
    """Effective next-due used by reads: if a scheduled time has passed since
    the last backup (or there has never been one) the backup is due NOW so the
    open page fires an immediate catch-up; otherwise the next future
    occurrence."""
    if not cfg.get("enabled"):
        return _backup_next_due(cfg, now_ts)
    last_sched = _backup_last_scheduled(cfg, now_ts)
    last_bk = None
    if cfg.get("lastBackup"):
        try:
            last_bk = datetime.fromisoformat(cfg["lastBackup"]).timestamp()
        except Exception:
            last_bk = None
    try:
        ls_ts = datetime.fromisoformat(last_sched).timestamp()
    except Exception:
        ls_ts = None
    if ls_ts is not None and (last_bk is None or ls_ts > last_bk):
        return datetime.fromtimestamp(now_ts).isoformat()
    return _backup_next_due(cfg, now_ts)


_BACKUP_SEQ = [0]

def _backup_file_name(kind):
    _BACKUP_SEQ[0] += 1
    # %f = microseconds; take ms part + per-process sequence to guarantee
    # unique names even for rapid successive snapshots in the same second.
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S%f")[:17]
    return "backup_%s_%s_%03d.json" % (kind, stamp, _BACKUP_SEQ[0] % 1000)


def _backup_list_files(cfg):
    p = _backup_path(cfg, create=False)
    if not p or not os.path.isdir(p):
        return []
    out = []
    try:
        for name in os.listdir(p):
            if not name.endswith(".json"):
                continue
            fp = os.path.join(p, name)
            try:
                st = os.stat(fp)
                out.append({
                    "name": name,
                    "size": st.st_size,
                    "mtime": datetime.fromtimestamp(st.st_mtime).isoformat(),
                })
            except Exception:
                continue
    except Exception:
        pass
    out.sort(key=lambda x: x["mtime"], reverse=True)
    return out


def _backup_prune(cfg):
    """Keep only the newest `keep` auto snapshots, drop the oldest, and hard-cap
    total files. Manual/import/pre-restore snapshots are kept unless the hard
    cap is hit."""
    p = _backup_path(cfg, create=False)
    if not p or not os.path.isdir(p):
        return
    keep = int(cfg.get("schedule", {}).get("keep", 30) or 30)
    try:
        auto_files = sorted(
            [f for f in os.listdir(p) if f.startswith("backup_auto_") and f.endswith(".json")],
            key=lambda n: os.path.getmtime(os.path.join(p, n)),
        )
        for f in auto_files[:-keep] if keep > 0 else auto_files:
            try:
                os.remove(os.path.join(p, f))
            except Exception:
                pass
        # Hard cap on total files (safety), oldest removed first.
        all_files = sorted(
            [f for f in os.listdir(p) if f.endswith(".json")],
            key=lambda n: os.path.getmtime(os.path.join(p, n)),
        )
        for f in all_files[:max(0, len(all_files) - _BACKUP_MAX_FILES)]:
            try:
                os.remove(os.path.join(p, f))
            except Exception:
                pass
    except Exception:
        pass


def _backup_write_snapshot(cfg, payload, kind):
    """Write one snapshot JSON to the configured path. Returns (file, created_at)
    or raises."""
    if not payload.get("data") or not isinstance(payload.get("data"), dict):
        raise ValueError("snapshot payload missing 'data'")
    raw = json.dumps(payload, ensure_ascii=False)
    if len(raw) > _BACKUP_MAX_PAYLOAD:
        raise ValueError("snapshot too large (%d bytes > %d limit)" % (len(raw), _BACKUP_MAX_PAYLOAD))
    p = _backup_path(cfg, create=True)
    if not p:
        raise ValueError("no backup path configured")
    if not os.path.isdir(p):
        raise ValueError("backup path is not a directory: %s" % p)
    name = _backup_file_name(kind)
    fp = os.path.join(p, name)
    with open(fp, "w", encoding="utf-8") as f:
        f.write(raw)
    # Keep a stable "latest.json" copy for quick restore.
    try:
        with open(os.path.join(p, "latest.json"), "w", encoding="utf-8") as f:
            f.write(raw)
    except Exception:
        pass
    return name, datetime.now().isoformat()


@app.route("/api/backup/config", methods=["GET", "POST"])
def api_backup_config():
    with _BACKUP_LOCK:
        cfg = _backup_load_config()
        if request.method == "POST":
            body = request.get_json(silent=True) or {}
            if "path" in body:
                cfg["path"] = str(body.get("path") or "").strip()
            if "enabled" in body:
                cfg["enabled"] = bool(body.get("enabled"))
            if isinstance(body.get("schedule"), dict):
                sch = body["schedule"]
                if sch.get("type") in ("minute", "hour", "daily", "weekly"):
                    cfg["schedule"]["type"] = sch["type"]
                if sch.get("interval") is not None:
                    try:
                        cfg["schedule"]["interval"] = max(1, min(100000, int(sch["interval"])))
                    except Exception:
                        pass
                if isinstance(sch.get("time"), str) and ":" in sch["time"]:
                    cfg["schedule"]["time"] = sch["time"]
                if "weekday" in sch:
                    try:
                        cfg["schedule"]["weekday"] = int(sch["weekday"]) % 7
                    except Exception:
                        pass
                if "keep" in sch:
                    try:
                        cfg["schedule"]["keep"] = max(1, int(sch["keep"]))
                    except Exception:
                        pass
        cfg["nextDue"] = _backup_due_next(cfg, time.time())
        _backup_save_config(cfg)
        return jsonify({"ok": True, "config": cfg})


@app.route("/api/backup/path_test", methods=["POST"])
def api_backup_path_test():
    body = request.get_json(silent=True) or {}
    p = str(body.get("path") or "").strip()
    if not p:
        return jsonify({"ok": False, "message": "No path given"}), 400
    if os.name == "nt":
        p = p.replace("/", "\\")
    p = os.path.expanduser(os.path.normpath(p))
    try:
        os.makedirs(p, exist_ok=True)
        probe = os.path.join(p, ".backup_probe.tmp")
        with open(probe, "w", encoding="utf-8") as f:
            f.write("ok")
        os.remove(probe)
        return jsonify({"ok": True, "message": "Path writable: %s" % p, "resolved": p})
    except Exception as e:
        return jsonify({"ok": False, "message": "Path not writable: %s" % e, "resolved": p})


@app.route("/api/backup/snapshot", methods=["POST"])
def api_backup_snapshot():
    body = request.get_json(silent=True) or {}
    data = body.get("data")
    kind = body.get("kind")
    if kind not in ("auto", "manual", "import", "pre_restore"):
        kind = "manual"
    if not isinstance(data, dict):
        return jsonify({"ok": False, "message": "Missing snapshot data"}), 400
    with _BACKUP_LOCK:
        cfg = _backup_load_config()
        created = {"format": "algodhan_backup", "version": 1,
                   "created_at": datetime.now().isoformat(), "kind": kind,
                   "app": "Smart NTrader + Algo Suite",
                   "count": {"keys": len(data.get("localStorage") or {})},
                   "data": data, "config": cfg}
        try:
            if body.get("pc_only"):
                # Backup file was already written to the browser's chosen PC
                # folder; just record the schedule/server state (no server file).
                name = None
                at = datetime.now().isoformat()
            else:
                name, at = _backup_write_snapshot(cfg, created, kind)
        except ValueError as e:
            return jsonify({"ok": False, "message": str(e)}), 400
        except Exception as e:
            return jsonify({"ok": False, "message": "Failed to write backup: %s" % e}), 500
        if kind == "auto":
            cfg["lastBackup"] = at
            cfg["nextDue"] = _backup_next_due(cfg, time.time())
            cfg["lastResult"] = {"ok": True, "message": "auto backup saved to PC" if body.get("pc_only") else "auto backup saved", "at": at, "file": name}
            _backup_save_config(cfg)
            if not body.get("pc_only"):
                _backup_prune(cfg)
        return jsonify({"ok": True, "file": name, "created_at": at,
                        "list": _backup_list_files(cfg), "config": cfg})


@app.route("/api/backup/list", methods=["GET"])
def api_backup_list():
    with _BACKUP_LOCK:
        cfg = _backup_load_config()
        cfg["nextDue"] = _backup_due_next(cfg, time.time())
        return jsonify({"ok": True, "list": _backup_list_files(cfg), "config": cfg})


@app.route("/api/backup/read", methods=["GET"])
def api_backup_read():
    name = request.args.get("file", "")
    name = os.path.basename(name or "")  # strip any path components
    if not name.endswith(".json") or ".." in name:
        return jsonify({"ok": False, "message": "Invalid file name"}), 400
    with _BACKUP_LOCK:
        cfg = _backup_load_config()
        p = _backup_path(cfg, create=False)
        if not p:
            return jsonify({"ok": False, "message": "No backup path configured"}), 400
        fp = os.path.join(p, name)
        if not os.path.isfile(fp):
            return jsonify({"ok": False, "message": "Backup file not found"}), 404
        try:
            with open(fp, "r", encoding="utf-8") as f:
                content = json.load(f)
            return jsonify({"ok": True, "file": name, "backup": content})
        except Exception as e:
            return jsonify({"ok": False, "message": "Failed to read backup: %s" % e}), 500


@app.route("/api/backup/import", methods=["POST"])
def api_backup_import():
    body = request.get_json(silent=True) or {}
    data = body.get("data")
    if not isinstance(data, dict) or not isinstance(data.get("localStorage"), dict):
        return jsonify({"ok": False, "message": "Import payload must contain data.localStorage"}), 400
    with _BACKUP_LOCK:
        cfg = _backup_load_config()
        created = {"format": "algodhan_backup", "version": 1,
                   "created_at": datetime.now().isoformat(), "kind": "import",
                   "app": "Smart NTrader + Algo Suite",
                   "count": {"keys": len(data["localStorage"])},
                   "data": data, "config": cfg}
        name = None
        at = None
        msg = None
        try:
            name, at = _backup_write_snapshot(cfg, created, "import")
        except ValueError as e:
            # Path may not be configured; that is fine, import can still proceed
            # client-side without a server copy.
            msg = str(e)
        except Exception as e:
            return jsonify({"ok": False, "message": "Failed to store import copy: %s" % e}), 500
        return jsonify({"ok": True, "file": name, "created_at": at, "message": msg,
                        "list": _backup_list_files(cfg), "config": cfg})


@app.route("/api/trade", methods=["POST"])
def api_trade():
    if not broker.is_connected:
        return jsonify({"status": "error", "message": "Not connected to Dhan"}), 401
    data = request.get_json() or {}
    security_id = data.get("security_id")
    exchange_segment = data.get("exchange_segment", "NSE_FNO")
    side = data.get("side", "")
    quantity = data.get("quantity")
    order_type = data.get("order_type", "MARKET")
    product_type = data.get("product_type", "INTRA")
    price = data.get("price", 0)
    if not security_id or side not in ("BUY", "SELL") or not quantity:
        return jsonify({"status": "error", "message": "security_id, side (BUY/SELL) and quantity required"}), 400
    try:
        result = broker.place_order(
            security_id=security_id,
            exchange_segment=exchange_segment,
            transaction_type=side,
            quantity=int(quantity),
            order_type=order_type,
            product_type=product_type,
            price=price,
        )
        payload = _unwrap_sdk_response(result)
        if payload is None:
            remarks = result.get("remarks", "Order rejected") if isinstance(result, dict) else str(result)
            return jsonify({"status": "error", "message": f"Dhan rejected order: {remarks}"}), 502
        return jsonify({"status": "success", "data": payload})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/api/square_off", methods=["POST"])
def api_square_off():
    if not broker.is_connected:
        return jsonify({"status": "error", "message": "Not connected to Dhan"}), 401
    data = request.get_json() or {}
    security_id = data.get("security_id")
    exchange_segment = data.get("exchange_segment", "NSE_FNO")
    quantity = data.get("quantity")
    if not security_id or not quantity:
        return jsonify({"status": "error", "message": "security_id and quantity required"}), 400
    try:
        result = broker.place_order(
            security_id=security_id,
            exchange_segment=exchange_segment,
            transaction_type="SELL",
            quantity=int(quantity),
            order_type="MARKET",
            product_type="INTRA",
            price=0.0,
        )
        payload = _unwrap_sdk_response(result)
        if payload is None:
            remarks = result.get("remarks", "Square-off rejected") if isinstance(result, dict) else str(result)
            return jsonify({"status": "error", "message": f"Dhan rejected square-off: {remarks}"}), 502
        return jsonify({"status": "success", "data": payload})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


# ---- Continuous research library ----
# The auto-experiment engine draws its "researched from" trail from this
# library. A background thread refreshes it periodically from an optional,
# operator-configured feed of research sources (RESEARCH_FEED_URLS, a
# comma-separated list of JSON endpoints returning {"entries": [{"method",
# "source"}, ...]}). Without a feed the curated baseline stays authoritative,
# so signal evaluation remains deterministic and offline-safe.
_RESEARCH_BASE = [
    {"method": "Candlestick", "source": "S. Nison, Japanese Candlestick Charting Techniques (1991)"},
    {"method": "Indicator", "source": "J. Murphy, Technical Analysis of the Financial Markets (1999)"},
    {"method": "Chart Structure", "source": "P. Edwards & J. Magee, Technical Analysis of Stock Trends (1948)"},
    {"method": "Symmetry", "source": "L. Raschke, Street Smarts: High Probability Short-Term Strategies (1996)"},
    {"method": "Supply/Demand", "source": "S. Weinstein, Secrets for Profiting in Bull and Bear Markets (1988)"},
    {"method": "Elliott Wave", "source": "R.N. Elliott, The Wave Principle (1938) / R. Prechter, Elliott Wave Principle (1978)"},
    {"method": "Volatility", "source": "J. Bollinger, Bollinger on Bollinger Bands (2001)"},
    {"method": "Volume", "source": "R. Arms, Volume Analysis / J. Granville OBV (1963)"},
    {"method": "Momentum", "source": "J. Murphy, Technical Analysis of the Financial Markets (1999)"},
    {"method": "Mean Reversion", "source": "A. Lo & A.C. MacKinlay, A Non-Random Walk Down Wall Street (1999)"},
]
_RESEARCH_LOCK = threading.Lock()
_RESEARCH_STATE = {
    "entries": list(_RESEARCH_BASE),
    "updated_at": time.time(),
    "attempts": 0,
    "last_error": None,
}
_RESEARCH_INTERVAL = 6 * 3600  # seconds between background refreshes
_RESEARCH_FEED = [u.strip() for u in os.environ.get("RESEARCH_FEED_URLS", "").split(",") if u.strip()]


def _research_snapshot():
    with _RESEARCH_LOCK:
        return dict(_RESEARCH_STATE)


def _refresh_research_once():
    """Merge entries from every configured research feed into the library.

    Each feed is a JSON endpoint returning {"entries": [{"method", "source"}]}.
    Duplicate methods are de-duplicated keeping the freshest source. Failures
    are recorded but never poison the curated baseline."""
    if not _RESEARCH_FEED:
        return
    import requests
    merged = list(_RESEARCH_BASE)
    errors = []
    for url in _RESEARCH_FEED:
        try:
            r = requests.get(url, timeout=15)
            r.raise_for_status()
            data = r.json()
            entries = data.get("entries") if isinstance(data, dict) else None
            if not isinstance(entries, list):
                continue
            for e in entries:
                if isinstance(e, dict) and e.get("method"):
                    merged.append({
                        "method": str(e["method"]),
                        "source": str(e.get("source", url)),
                        "url": url,
                    })
        except Exception as exc:  # noqa: BLE001 - best-effort background refresh
            errors.append(str(exc))
    by_method = {}
    for e in merged:
        by_method[e["method"]] = e
    with _RESEARCH_LOCK:
        _RESEARCH_STATE["entries"] = list(by_method.values())
        _RESEARCH_STATE["updated_at"] = time.time()
        _RESEARCH_STATE["attempts"] += 1
        _RESEARCH_STATE["last_error"] = ("; ".join(errors) or None)


def _research_loop():
    while True:
        time.sleep(_RESEARCH_INTERVAL)
        try:
            _refresh_research_once()
        except Exception:
            pass


threading.Thread(target=_research_loop, daemon=True, name="research-refresh").start()


@app.route("/api/auto_research", methods=["GET"])
def api_auto_research():
    """Return the research knowledge base the auto-experiment engine draws from.

    The client polls this on a long cadence; the server keeps the library fresh
    in the background from operator-configured research feeds. Each entry
    documents the analysis method and its canonical source, so the client can
    render an auditable "researched from" trail without any live network calls
    in the signal hot path (keeps signal evaluation deterministic)."""
    snap = _research_snapshot()
    return jsonify({
        "status": "success",
        "data": snap["entries"],
        "updated_at": snap["updated_at"],
        "attempts": snap["attempts"],
        "last_error": snap["last_error"],
        "auto_refresh": bool(_RESEARCH_FEED),
        "refresh_interval_sec": _RESEARCH_INTERVAL,
    })


class _OneShotRequestHandler(WSGIRequestHandler):
    """Serves exactly ONE HTTP request per connection.

    http.server's base class keeps HTTP/1.1 connections alive (loops back to
    read the next request line), and Werkzeug only *sends* a "Connection:
    close" header without setting close_connection. With the preview tunnel
    holding ~900 pooled connections open, every server thread that had served a
    request was then parked in readline() waiting for a next request that never
    comes - so the bounded pool filled up with idle connections and new
    requests starved (browser "Failed to fetch", Reconnect stuck on
    "Connecting..."). Serving one request per connection and closing frees the
    pool slot immediately; WebSocket (/ws) connections are unaffected because
    flask_sock hijacks the socket inside the handler for their full lifetime."""

    def handle(self):
        self.close_connection = True
        self.handle_one_request()


class _BoundedThreadWSGIServer(ThreadedWSGIServer):
    """Like Werkzeug's ThreadedWSGIServer but serves connections from a bounded
    daemon thread pool instead of spawning one thread per connection.

    The preview tunnel keeps hundreds of idle HTTP keep-alive connections open
    to this port. The stock threaded server parked a thread on every one of
    them (measured ~940 threads, 90%+ CPU, 570MB RSS) which stalled requests and
    made the browser throw "Failed to fetch" / leave the Reconnect button stuck
    on "Connecting...". A fixed pool caps the thread count no matter how many
    connections the tunnel holds open; excess connections simply queue. Combined
    with _OneShotRequestHandler (one request per connection) no pool slot is ever
    pinned on an idle keep-alive socket. The executor threads are daemon so
    shutdown is not blocked."""

    daemon_threads = True
    block_on_close = True

    def __init__(self, host, port, app, request_handler=None, passthrough_errors=False,
                 ssl_context=None, fd=None, max_threads=128):
        if request_handler is None:
            request_handler = _OneShotRequestHandler
        super().__init__(host, port, app, request_handler, passthrough_errors,
                         ssl_context, fd=fd)
        self._pool = ThreadPoolExecutor(max_workers=max_threads,
                                        thread_name_prefix="wsgi-pool")

    def process_request(self, request, client_address):
        self._pool.submit(self.process_request_thread, request, client_address)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    app.config["TEMPLATES_AUTO_RELOAD"] = True
    server = _BoundedThreadWSGIServer("0.0.0.0", 8081, app)
    server.serve_forever()
