"""
Data Fetcher Module
Fetches option chain, historical data, and market quotes from Dhan API.

The Dhan SDK wraps all responses as:
  { "status": "success"|"failure", "remarks": str, "data": dict|str }
"""

import time
import logging
import inspect
import threading
from datetime import datetime, timedelta, timezone
import pandas as pd


_IST = timezone(timedelta(hours=5, minutes=30))
_MARKET_CLOSE_SECS = 15 * 3600 + 30 * 60  # 15:30 IST


def _market_open_now():
    """True during NSE/BSE trading hours (Mon-Fri 09:15-15:30 IST)."""
    now = datetime.now(_IST)
    if now.weekday() >= 5:
        return False
    t = now.hour * 3600 + now.minute * 60 + now.second
    return 9 * 3600 + 15 * 60 <= t <= _MARKET_CLOSE_SECS


def _trim_post_close_candles(df):
    """Drop the phantom 'current bucket' candle Dhan appends after market close.

    When queried after hours, Dhan's intraday endpoint still returns a candle for
    the in-progress minute bucket (flat OHLC = last traded price, volume 0). That
    bar sits 7+ hours after the last real session candle and renders as a giant
    detached / over-long last bar on the chart. Drop any candle that starts after
    the 15:30 IST close so the series ends on the last real session bar.
    """
    if df is None or df.empty:
        return df
    keep = [idx.hour * 3600 + idx.minute * 60 + idx.second <= _MARKET_CLOSE_SECS
            for idx in df.index]
    if all(keep):
        return df
    return df[keep]


TIMEFRAME_CONFIG = {
    "1min": {"api_interval": 1, "label": "1 Minute"},
    "2min": {"api_interval": 1, "resample": "2min", "label": "2 Minutes"},
    "3min": {"api_interval": 1, "resample": "3min", "label": "3 Minutes"},
    "4min": {"api_interval": 1, "resample": "4min", "label": "4 Minutes"},
    "5min": {"api_interval": 5, "label": "5 Minutes"},
    "10min": {"api_interval": 5, "resample": "10min", "label": "10 Minutes"},
    "15min": {"api_interval": 15, "label": "15 Minutes"},
    "30min": {"api_interval": 5, "resample": "30min", "label": "30 Minutes"},
    "1hour": {"api_interval": 60, "label": "1 Hour"},
    "4hour": {"api_interval": 60, "resample": "4h", "label": "4 Hours"},
    "day": {"label": "Day"},
    "week": {"resample": "W", "label": "Week"},
    "month": {"resample": "ME", "label": "Month"},
    "year": {"resample": "YE", "label": "Year"},
}

TRADING_SYMBOLS = {
    "NIFTY 50": {"security_id": 13, "exchange_segment": "IDX_I", "instrument_type": "INDEX"},
    "BANK NIFTY": {"security_id": 25, "exchange_segment": "IDX_I", "instrument_type": "INDEX"},
    "FINNIFTY": {"security_id": 27, "exchange_segment": "IDX_I", "instrument_type": "INDEX"},
    "SENSEX": {"security_id": 51, "exchange_segment": "IDX_I", "instrument_type": "INDEX"},
}

logger = logging.getLogger(__name__)

# ---- Global Dhan rate-limit cooldown ----
# Dhan enforces a per-user request rate (DH-904 / 805). Background threads
# (daily backfill, REST quote fallback, option-chain polling) hammer the API
# and trigger the limit, which then starves the foreground requests that
# actually populate the watchlist LTP / gain% and the option chain. When a rate
# limit is seen, flip into a cooldown so the background loops back off and let
# the rate window reset before retrying.
_RL_COOLDOWN_UNTIL = 0.0
_RL_COOLDOWN_SEC = 30.0
_RL_LOCK = threading.Lock()


def rate_limit_cooldown_active():
    return time.time() < _RL_COOLDOWN_UNTIL


def rate_limit_cooldown_remaining():
    """Seconds until the global rate-limit cooldown lifts (0 when inactive)."""
    remaining = _RL_COOLDOWN_UNTIL - time.time()
    return remaining if remaining > 0 else 0.0


def _mark_rate_limited():
    global _RL_COOLDOWN_UNTIL
    now = time.time()
    with _RL_LOCK:
        # Idempotent within the active window: once the cooldown is running,
        # do NOT slide it forward on every subsequent failure. Background loops
        # that keep hitting Dhan with empty-bodied (code=None) responses were
        # re-arming the gate each time, so /api/candles stayed at 503 forever
        # even though each individual failure was a 30s reset. Only a fresh
        # failure AFTER the window has expired (i.e. we genuinely tried again
        # and Dhan still rejected us) starts a new cooldown.
        if now >= _RL_COOLDOWN_UNTIL:
            _RL_COOLDOWN_UNTIL = now + _RL_COOLDOWN_SEC


# ---- Per-surface option-chain cooldown ----
# Dhan rate-limits the Option Chain surface independently of the chart/data
# surface: the docs set Option Chain at 1 request per 3 seconds while the
# historical candle endpoints allow 5/sec. A 429 on /optionchain or
# /optionchain/expirylist must NOT black out the chart - otherwise the browser's
# every-~2s expiry poll trips Dhan's option-chain limit and re-arms the global
# 30s cooldown that keeps /api/candles at 503 ("chart not loading"). Back the
# option-chain surface off on its own so candles keep flowing.
_OC_COOLDOWN_UNTIL = 0.0
_OC_COOLDOWN_SEC = 30.0
_OC_LOCK = threading.Lock()


def oc_rate_limited():
    return time.time() < _OC_COOLDOWN_UNTIL


def _mark_oc_rate_limited():
    global _OC_COOLDOWN_UNTIL
    now = time.time()
    with _OC_LOCK:
        if now >= _OC_COOLDOWN_UNTIL:
            _OC_COOLDOWN_UNTIL = now + _OC_COOLDOWN_SEC


# ---- Per-surface quote cooldown ----
# Dhan rate-limits /marketfeed/quote at ~1 req/sec independently of the chart
# and option-chain surfaces. Background quote polling (watchlist prev-close
# re-seed, REST fallback when the WS feed stalls) can trip that limit and Dhan
# answers with an empty-bodied failure (code=None). Those empty-body errors must
# NOT arm the GLOBAL 30s cooldown - otherwise a harmless quote poll ~every 20s
# freezes /api/candles for 30s each time and the chart / strikes keep flashing
# 503 even though the chart surface itself is fine. Back the quote surface off
# on its own, exactly like the option-chain cooldown above.
_QUOTE_COOLDOWN_UNTIL = 0.0
_QUOTE_COOLDOWN_SEC = 30.0
_QUOTE_LOCK = threading.Lock()


def quote_rate_limited():
    return time.time() < _QUOTE_COOLDOWN_UNTIL


def _mark_quote_rate_limited():
    global _QUOTE_COOLDOWN_UNTIL
    now = time.time()
    with _QUOTE_LOCK:
        if now >= _QUOTE_COOLDOWN_UNTIL:
            _QUOTE_COOLDOWN_UNTIL = now + _QUOTE_COOLDOWN_SEC


# ---- Daily historical endpoint cooldown ----
# Dhan's /charts/historical (daily) endpoint can start returning DH-905
# Input_Exception for every request. Retrying it every 0.5s from the daily
# backfill only re-trips the error and starves the live quote/option-chain calls
# the UI needs. Back off the daily endpoint for a window and let callers fall
# through to intraday resampling instead.
_DAILY_HIST_BROKEN_UNTIL = 0.0
_DAILY_HIST_BROKEN_SEC = 120.0
_DAILY_HIST_LOCK = threading.Lock()

# Last auth error (e.g. DH-906 Invalid Token) surfaced to /api/status so the UI
# can prompt a reconnect instead of spinning in a loading state forever.
_AUTH_ERROR = None


def daily_hist_broken():
    return time.time() < _DAILY_HIST_BROKEN_UNTIL


def _mark_daily_hist_broken():
    global _DAILY_HIST_BROKEN_UNTIL
    with _DAILY_HIST_LOCK:
        _DAILY_HIST_BROKEN_UNTIL = time.time() + _DAILY_HIST_BROKEN_SEC


# ---- Instrument-class intraday empty park ----
# Some Dhan instrument classes NEVER return intraday data (e.g. MCX OPTFUT
# options: /charts/intraday comes back empty for every strike). The paper-trade
# / experiment engines can ask for many strikes in a burst, so an empty result
# for each new sid turns into a hot failure loop that burns the historical
# surface and spams 500s. Once a (segment, instrument_type) class returns empty
# intraday data, park intraday attempts for that WHOLE class for 10 minutes so
# the class is not re-requested per sid. Daily data is unaffected - the daily
# path is a separate branch.
#
# IMPORTANT: a class that HAS produced data for some sids (e.g. MCX_COMM|FUTCOM
# where CRUDEOIL/GOLD/COPPER return rows but one stale contract is empty) must
# NOT be parked by a single empty sid - that would block every sibling symbol in
# the class for 10 minutes (the "every symbol skipped" experiment failure). Only
# classes that have NEVER returned any intraday data get parked.
_INTRADAY_EMPTY_PARK = {}
_INTRADAY_EMPTY_SEC = 600.0
_INTRADAY_EMPTY_LOCK = threading.Lock()
# Classes that have produced at least one non-empty intraday frame. Once seen,
# empty results are treated as "this sid only" and never park the class.
_INTRADAY_HAVE_DATA = set()


def _intraday_empty_parked(exchange_segment, instrument_type):
    key = "{}|{}".format(exchange_segment, instrument_type)
    with _INTRADAY_EMPTY_LOCK:
        until = _INTRADAY_EMPTY_PARK.get(key, 0.0)
        return time.time() < until


def _mark_intraday_empty(exchange_segment, instrument_type):
    """Park an instrument class that returned empty intraday data.

    Only parks when the class has never produced intraday data. A class that
    has data for most sids must stay live so one bad contract does not black out
    every sibling symbol for 10 minutes.
    """
    key = "{}|{}".format(exchange_segment, instrument_type)
    with _INTRADAY_EMPTY_LOCK:
        if key in _INTRADAY_HAVE_DATA:
            return
        _INTRADAY_EMPTY_PARK[key] = time.time() + _INTRADAY_EMPTY_SEC


def _mark_intraday_data(exchange_segment, instrument_type):
    """Record that this class produced intraday data at least once."""
    key = "{}|{}".format(exchange_segment, instrument_type)
    with _INTRADAY_EMPTY_LOCK:
        _INTRADAY_HAVE_DATA.add(key)
        _INTRADAY_EMPTY_PARK.pop(key, None)


def _no_intraday_error():
    return ValueError(
        "No candle data returned from Dhan API for this instrument"
    )


def auth_error():
    return _AUTH_ERROR


def _mark_auth_error(msg):
    global _AUTH_ERROR
    _AUTH_ERROR = msg


# ---- Per-category Dhan request throttle ----
# Dhan rate-limits each API surface independently: /marketfeed/quote allows
# ~1 req/sec, the option chain ~1 req/3s, and the historical candle endpoints
# are more lenient. A single shared 1/sec slot forced the 1600-symbol daily
# backfill (historical) and the foreground quote/option-chain requests to fight
# over the same lock, so the watchlist gain/loss stayed 0.00 and the option
# chain / chart appeared to hang. Each category now gets its own slot so the
# background backfill can never starve the requests the UI needs.
_THROTTLE_STATE = {
    "quote":        {"lock": threading.Lock(), "last": 0.0, "interval": 1.0},
    "option_chain": {"lock": threading.Lock(), "last": 0.0, "interval": 3.0},
    "expiry_list":  {"lock": threading.Lock(), "last": 0.0, "interval": 3.0},
    "historical":   {"lock": threading.Lock(), "last": 0.0, "interval": 1.0},
}


def _throttle(kind="quote"):
    state = _THROTTLE_STATE.get(kind) or _THROTTLE_STATE["quote"]
    with state["lock"]:
        now = time.time()
        wait = state["last"] + state["interval"] - now
        if wait > 0:
            time.sleep(wait)
        state["last"] = time.time()


# ---- Per-surface in-flight serialization ----
# _throttle only paces the START of a request; with the threaded Flask server
# the engine fires bursts of concurrent /api/candles (symbols x strikes x
# timeframes) whose long-running Dhan calls OVERLAP even though their start
# times are spaced. That overlap is what trips DH-904: several requests are
# in-flight to Dhan at the same instant, so the measured burst rate is far
# above the paced rate. Holding a per-surface lock for the DURATION of each
# call makes each surface strictly serial (max one request in-flight), turning
# the pacing into true 1-per-interval throughput that stays inside Dhan's
# limits no matter how many threads pile in.
_SURFACE_LOCKS = {
    "quote": threading.Lock(),
    "option_chain": threading.Lock(),
    "expiry_list": threading.Lock(),
    "historical": threading.Lock(),
}


def _serialized_call(kind, fn, *args, **kwargs):
    """Run one Dhan API call while holding that surface's lock so at most one
    request per surface is in-flight at a time. Callers' retry loops run the
    backoff sleep OUTSIDE this lock, so a sleeping retry never blocks other
    threads that have a fresh request to make."""
    lock = _SURFACE_LOCKS[kind]
    with lock:
        _throttle(kind)
        return fn(*args, **kwargs)


def _unwrap_sdk_response(result, surface="global"):
    if not isinstance(result, dict):
        return None
    status = result.get("status", "")
    if status != "success":
        remarks = result.get("remarks", "Unknown error")
        # Dhan rate-limits each surface independently. A 429 on one surface
        # (option chain 1/3s, quote 1/s) must only back that surface off -
        # never black out the candle endpoints that render the chart. Only the
        # chart/historical surface failures arm the global gate.
        if surface == "quote":
            # The quote surface is independent of charts. Empty-bodied / 429
            # quote failures only back the quote polling off - they must never
            # freeze /api/candles for the whole app (which is what re-arming
            # the global gate on every watchlist re-seed did).
            arm = _mark_quote_rate_limited
        else:
            arm = _mark_oc_rate_limited if surface == "oc" else _mark_rate_limited
        if isinstance(remarks, dict):
            code = remarks.get("error_code")
            error_type = remarks.get("error_type")
            error_message = remarks.get("error_message")
            if code in ("DH-904", "805") or error_type == "Rate_Limit":
                arm()
            if code == "DH-906" or error_message == "Invalid Token":
                # Dhan escalates sustained rate-limiting into a token-level
                # "Invalid Token" (DH-906) ban on a specific surface. Back off
                # the same way we do for DH-904 so the background loops pause
                # and the ban has a chance to lift instead of being re-triggered.
                _mark_auth_error("Invalid Token")
                arm()
            if code == "DH-905" or error_type == "Input_Exception":
                _mark_daily_hist_broken()
            # Dhan returns an HTTP error (typically 429 rate-limit) with an
            # empty body here, so error_code/type/message are all None. Treat it
            # as rate-limiting so every caller backs off instead of hammering
            # the endpoint and deepening the limit.
            if code is None and error_type is None and error_message is None:
                arm()
            caller = ""
            try:
                f = inspect.currentframe()
                if f is not None and f.f_back is not None:
                    caller = f.f_back.f_code.co_name
                    if f.f_back.f_back is not None:
                        caller = f.f_back.f_code.co_name + " <- " + f.f_back.f_back.f_code.co_name
            except Exception:
                pass
            logger.error("Dhan API error: code=%s type=%s msg=%s [caller=%s]",
                         code, error_type, error_message, caller)
        else:
            # Dhan returned a non-JSON / empty response body (the SDK surfaces
            # it as a JSON decode failure such as "Expecting value: line 1
            # column 1 (char 0)"). This is the empty-bodied rate-limit response
            # that _unwrap_sdk_response normally detects by code=None. It must
            # arm the cooldown too, otherwise callers treat it as a generic
            # error and keep hammering the endpoint - which is what made the
            # auto-strategy run report "every symbol was skipped".
            logger.error("Dhan API error: %s", str(remarks))
            arm()
        return None
    if _AUTH_ERROR:
        _mark_auth_error(None)
    return result.get("data")


class DataFetcher:
    def __init__(self, broker):
        self._broker = broker

    def fetch_expiry_list(self, under_security_id, under_exchange_segment):
        if not self._broker.is_connected:
            raise ValueError("Broker not connected")

        # Never fire the expiry endpoint into an active rate-limit window.
        # The option-chain surface is rate-limited at 1 req/3s independently of
        # the chart surface; back it off on its own so an option-chain 429 can
        # never black out /api/candles. The global gate still applies as an
        # extra guard while Dhan is rejecting the account broadly.
        if oc_rate_limited() or rate_limit_cooldown_active():
            raise ValueError("Rate limited - wait a few seconds and retry")

        # Retry transient Dhan failures (rate-limit / flaky gateway / malformed
        # empty-bodied failure responses) a few times with a short backoff so a
        # single bad response does not collapse the option-chain UI into a
        # misleading "No expiries" fallback.
        result = None
        last_remarks = None
        for attempt in range(3):
            result = _serialized_call(
                "expiry_list",
                self._broker.option_chain.expiry_list,
                int(under_security_id), str(under_exchange_segment)
            )
            outer = _unwrap_sdk_response(result, surface="oc")
            if isinstance(outer, dict):
                inner = outer.get("data")
                if isinstance(inner, list):
                    return sorted(inner)
            if isinstance(result, list):
                return sorted(result)
            if isinstance(result, dict) and result.get("status") == "failure":
                remarks = result.get("remarks", {}) if isinstance(result.get("remarks"), dict) else result.get("remarks")
                last_remarks = remarks
                err_code = last_remarks.get("error_code") if isinstance(last_remarks, dict) else None
                err_type = last_remarks.get("error_type") if isinstance(last_remarks, dict) else None
                # DH-904 / 805 (rate limit) plus empty-bodied failures where
                # every error field is None (flaky gateway) are transient - back
                # off briefly and retry. Kept short because the API route now
                # serves the stale RAM cache instantly on failure; a long retry
                # only delayed the UI for no benefit. Stop retrying as soon as
                # the surface cooldown arms so we never fire into the storm.
                if err_code is None or err_code in ("DH-904", "805") or err_type == "Rate_Limit":
                    if oc_rate_limited():
                        break
                    time.sleep(attempt + 1)
                    continue
            break

        # Give the caller a meaningful error instead of a bare "No expiries".
        if isinstance(last_remarks, dict):
            if last_remarks.get("error_code") in ("DH-904", "805") or last_remarks.get("error_type") == "Rate_Limit":
                raise ValueError("Rate limited - wait a few seconds and retry")
            if last_remarks.get("error_message"):
                raise ValueError(str(last_remarks["error_message"]))
        raise ValueError("Dhan API unavailable for expiry list")

    def fetch_option_chain(self, under_security_id, under_exchange_segment, expiry):
        if not self._broker.is_connected:
            raise ValueError("Broker not connected")

        # Never fire the /optionchain endpoint into an active rate-limit window
        # (same reasoning as fetch_expiry_list). The option-chain surface backs
        # itself off without touching the global chart gate.
        if oc_rate_limited() or rate_limit_cooldown_active():
            raise ValueError("Rate limited - wait a few seconds and retry")

        result = None
        last_remarks = None
        for attempt in range(3):
            result = _serialized_call(
                "option_chain",
                self._broker.option_chain.option_chain,
                int(under_security_id), str(under_exchange_segment), str(expiry)
            )
            if isinstance(result, dict) and result.get("status") == "failure":
                remarks = result.get("remarks", {}) if isinstance(result.get("remarks"), dict) else result.get("remarks")
                last_remarks = remarks
                err_code = last_remarks.get("error_code") if isinstance(last_remarks, dict) else None
                err_type = last_remarks.get("error_type") if isinstance(last_remarks, dict) else None
                # Retry rate limits and flaky empty-bodied failures; give up on
                # hard errors like DH-906 invalid token straight away. Stop
                # retrying once the surface cooldown arms so we never fire into
                # the storm that keeps the option chain stuck at 503.
                if err_code is None or err_code in ("DH-904", "805") or err_type == "Rate_Limit":
                    if oc_rate_limited():
                        break
                    time.sleep(2 * (attempt + 1))
                    continue
                break
            break

        outer_data = _unwrap_sdk_response(result, surface="oc")
        if outer_data is None:
            remarks = last_remarks if isinstance(last_remarks, dict) else \
                (result.get('remarks', {}) if isinstance(result, dict) else None)
            err_msg = "Dhan API unavailable"
            if isinstance(remarks, dict):
                if remarks.get("error_code") in ("DH-904", "805") or \
                        remarks.get("error_type") == "Rate_Limit":
                    err_msg = "Rate limited - wait a few seconds"
                elif remarks.get("error_message"):
                    err_msg = str(remarks["error_message"])
            raise ValueError(err_msg)
        if not isinstance(outer_data, dict):
            raise ValueError("Unexpected option chain response format")
        return outer_data

    def parse_option_chain_to_dataframe(self, api_response):
        if not isinstance(api_response, dict):
            return pd.DataFrame()

        api_status = api_response.get("status", "")
        if api_status != "success":
            return pd.DataFrame()

        inner = api_response.get("data")
        if not isinstance(inner, dict):
            return pd.DataFrame()

        oc = inner.get("oc", {})
        if not oc:
            return pd.DataFrame()

        rows = []
        for strike_str, strike_data in oc.items():
            try:
                strike = float(strike_str)
            except (ValueError, TypeError):
                continue

            ce = strike_data.get("ce") if isinstance(strike_data, dict) else {}
            pe = strike_data.get("pe") if isinstance(strike_data, dict) else {}
            ce = ce if isinstance(ce, dict) else {}
            pe = pe if isinstance(pe, dict) else {}

            ce_greeks = ce.get("greeks", {}) if isinstance(ce.get("greeks"), dict) else {}
            pe_greeks = pe.get("greeks", {}) if isinstance(pe.get("greeks"), dict) else {}

            ce_ltp = ce.get("last_price", 0) or 0
            pe_ltp = pe.get("last_price", 0) or 0
            ce_prev = ce.get("previous_close_price", 0) or 0
            pe_prev = pe.get("previous_close_price", 0) or 0
            ce_chg = round(ce_ltp - ce_prev, 2)
            pe_chg = round(pe_ltp - pe_prev, 2)
            ce_chg_pct = round((ce_chg / ce_prev * 100) if ce_prev else 0, 2)
            pe_chg_pct = round((pe_chg / pe_prev * 100) if pe_prev else 0, 2)

            rows.append({
                "CE OI": ce.get("oi", 0) or 0,
                "CE Chg OI": ((ce.get("oi") or 0) - (ce.get("previous_oi") or 0)),
                "CE Volume": ce.get("volume", 0) or 0,
                "CE IV": round(ce.get("implied_volatility", 0) or 0, 2),
                "CE LTP": ce_ltp,
                "CE Chg": ce_chg,
                "CE Chg%": ce_chg_pct,
                "CE SID": ce.get("security_id"),
                "CE Bid": ce.get("top_bid_price", 0) or 0,
                "CE Ask": ce.get("top_ask_price", 0) or 0,
                "CE Delta": round(ce_greeks.get("delta", 0) or 0, 4),
                "CE Theta": round(ce_greeks.get("theta", 0) or 0, 4),
                "CE Gamma": round(ce_greeks.get("gamma", 0) or 0, 4),
                "CE Vega": round(ce_greeks.get("vega", 0) or 0, 4),
                "Strike": strike,
                "PE Bid": pe.get("top_bid_price", 0) or 0,
                "PE Ask": pe.get("top_ask_price", 0) or 0,
                "PE LTP": pe_ltp,
                "PE Chg": pe_chg,
                "PE Chg%": pe_chg_pct,
                "PE SID": pe.get("security_id"),
                "PE IV": round(pe.get("implied_volatility", 0) or 0, 2),
                "PE Volume": pe.get("volume", 0) or 0,
                "PE Chg OI": ((pe.get("oi") or 0) - (pe.get("previous_oi") or 0)),
                "PE OI": pe.get("oi", 0) or 0,
                "PE Delta": round(pe_greeks.get("delta", 0) or 0, 4),
                "PE Theta": round(pe_greeks.get("theta", 0) or 0, 4),
                "PE Gamma": round(pe_greeks.get("gamma", 0) or 0, 4),
                "PE Vega": round(pe_greeks.get("vega", 0) or 0, 4),
            })

        df = pd.DataFrame(rows)
        if not df.empty:
            df = df.sort_values("Strike")
        return df

    def fetch_market_quotes_by_segment(self, securities):
        if not self._broker.is_connected:
            raise ValueError("Broker not connected")
        # Skip the call entirely while the quote surface is in its own cooldown.
        # Backing off here (instead of firing and getting an empty-body rejection)
        # keeps the quote-scoped cooldown from being needlessly re-armed and lets
        # it clear, exactly like the OC cooldown short-circuits expiry fetch.
        if quote_rate_limited():
            raise ValueError("Rate limited - Dhan quote API temporarily unavailable")
        result = _serialized_call("quote", self._broker.dhan.quote_data, securities)
        outer = _unwrap_sdk_response(result, surface="quote")
        out = {}
        if not isinstance(outer, dict):
            return out
        by_segment = outer.get("data", outer)
        if not isinstance(by_segment, dict):
            return out
        for seg, by_id in by_segment.items():
            if not isinstance(by_id, dict):
                continue
            seg_out = {}
            for sid, q in by_id.items():
                if not isinstance(q, dict):
                    continue
                try:
                    sid_i = int(sid)
                except (ValueError, TypeError):
                    continue
                ltp = float(q.get("last_price") or 0)
                change = float(q.get("net_change") or 0)
                # /marketfeed/quote never returns previous_close_price. Derive prev
                # close from net_change (ltp - change) only when net_change is
                # non-zero. ohlc.close is the DAY close (== ltp during market
                # hours), so it must NOT be used as prev close: it would zero out
                # change/change_pct and poison every downstream gain/loss calc.
                # When net_change is 0 we cannot distinguish "no change" from
                # "missing data", so leave close unknown (0) and let the
                # option-chain / daily-candle sources fill the authoritative value.
                pc = float(q.get("previous_close_price") or 0)
                if not pc and change:
                    pc = ltp - change
                change_pct = round((change / pc * 100) if pc else 0, 2)
                seg_out[sid_i] = {"ltp": ltp, "change": change,
                                  "close": pc, "change_pct": change_pct}
            if seg_out:
                out[seg] = seg_out
        return out

    def fetch_market_quotes(self, securities):
        """Flattened variant of fetch_market_quotes_by_segment.

        Only safe for single-segment calls (e.g. the option-chain change patch)
        where a security id cannot collide across segments.
        """
        seg_quotes = self.fetch_market_quotes_by_segment(securities)
        flat = {}
        for by_id in seg_quotes.values():
            flat.update(by_id)
        return flat

    def fetch_intraday_candles(self, security_id, exchange_segment, instrument_type,
                                 from_date, to_date, interval):
        if not self._broker.is_connected:
            raise ValueError("Broker not connected")

        # Do not hammer /charts while a rate-limit cooldown is already active:
        # every empty-body / DH-904 response would keep the gate from clearing
        # (and a retry loop here would only re-trip it). Raise immediately so
        # the caller can serve stale cache / a soft 503 and retry after the
        # cooldown window lifts (~30s).
        if rate_limit_cooldown_active():
            raise ValueError("Rate limited - Dhan chart API temporarily unavailable")

        result = None
        for attempt in range(3):
            result = _serialized_call(
                "historical",
                self._broker.historical.intraday_minute_data,
                str(security_id), str(exchange_segment), str(instrument_type),
                str(from_date), str(to_date), int(interval)
            )
            if isinstance(result, dict) and result.get("status") != "success":
                logger.warning("DBG intraday sid=%s seg=%s inst=%s iv=%s -> status=%s remarks=%s",
                               security_id, exchange_segment, instrument_type, interval,
                               result.get("status"), result.get("remarks"))
            inner = _unwrap_sdk_response(result)
            if inner is not None:
                parsed = self._parse_ohlc_dataframe(inner)
                if parsed is not None and not parsed.empty:
                    _mark_intraday_data(exchange_segment, instrument_type)
                return parsed
            remarks = result.get("remarks", "Unknown error") if isinstance(result, dict) else str(result)
            code = remarks.get("error_code") if isinstance(remarks, dict) else None
            etype = remarks.get("error_type") if isinstance(remarks, dict) else None
            # Transient rate-limit / empty-bodied failure: exponential backoff
            # (1s, 2s) then retry. The _unwrap_sdk_response call above already
            # armed the global cooldown, so break out as soon as it is active -
            # retrying into an armed cooldown only keeps the gate alive.
            if code in ("DH-904", "805") or etype == "Rate_Limit" or \
                    (code is None and etype is None):
                if rate_limit_cooldown_active():
                    break
                time.sleep(attempt + 1)
                continue
            raise ValueError(f"Intraday data API failed: {remarks}")
        raise ValueError("Rate limited - Dhan chart API temporarily unavailable")

    def fetch_daily_candles(self, security_id, exchange_segment, instrument_type,
                              from_date, to_date, expiry_code=0):
        if not self._broker.is_connected:
            raise ValueError("Broker not connected")

        # Same cooldown short-circuit as fetch_intraday_candles: never fire the
        # daily /charts endpoint into an active rate-limit window.
        if rate_limit_cooldown_active():
            raise ValueError("Rate limited - Dhan chart API temporarily unavailable")

        result = None
        for attempt in range(3):
            result = _serialized_call(
                "historical",
                self._broker.historical.historical_daily_data,
                str(security_id), str(exchange_segment), str(instrument_type),
                str(from_date), str(to_date), int(expiry_code)
            )
            if isinstance(result, dict) and result.get("status") != "success":
                logger.warning("DBG daily sid=%s seg=%s inst=%s -> status=%s remarks=%s",
                               security_id, exchange_segment, instrument_type,
                               result.get("status"), result.get("remarks"))
            inner = _unwrap_sdk_response(result)
            if inner is not None:
                return self._parse_ohlc_dataframe(inner)
            remarks = result.get("remarks", "Unknown error") if isinstance(result, dict) else str(result)
            code = remarks.get("error_code") if isinstance(remarks, dict) else None
            etype = remarks.get("error_type") if isinstance(remarks, dict) else None
            # Transient rate-limit / empty-bodied failure: exponential backoff
            # (1s, 2s) then retry, unless the global cooldown just got armed.
            if code in ("DH-904", "805") or etype == "Rate_Limit" or \
                    (code is None and etype is None):
                if rate_limit_cooldown_active():
                    break
                time.sleep(attempt + 1)
                continue
            raise ValueError(f"Daily data API failed: {remarks}")
        raise ValueError("Rate limited - Dhan chart API temporarily unavailable")

    def _parse_ohlc_dataframe(self, data):
        if not isinstance(data, dict):
            return pd.DataFrame()

        opens = data.get("open", [])
        highs = data.get("high", [])
        lows = data.get("low", [])
        closes = data.get("close", [])
        volumes = data.get("volume", [])
        timestamps = data.get("timestamp", [])
        ois = data.get("open_interest", []) or [0] * len(opens)

        if not opens or not timestamps:
            return pd.DataFrame()

        df = pd.DataFrame({
            "open": pd.to_numeric(pd.Series(opens), errors="coerce"),
            "high": pd.to_numeric(pd.Series(highs), errors="coerce"),
            "low": pd.to_numeric(pd.Series(lows), errors="coerce"),
            "close": pd.to_numeric(pd.Series(closes), errors="coerce"),
            "volume": pd.to_numeric(pd.Series(volumes), errors="coerce"),
            "oi": pd.to_numeric(pd.Series(ois), errors="coerce"),
        })
        df.index = pd.to_datetime(pd.to_numeric(timestamps), unit="s", utc=True)
        df.index = df.index.tz_convert("Asia/Kolkata")
        df = df.dropna()
        return df

    def fetch_candles_for_timeframe(self, security_id, exchange_segment, instrument_type, tf_key, period_days=None):
        config = TIMEFRAME_CONFIG.get(tf_key)
        if not config:
            raise ValueError(f"Unknown timeframe: {tf_key}")

        now = datetime.now()

        if tf_key == "day":
            lookback = int(period_days) if period_days else 300
            from_date = (now - timedelta(days=lookback)).strftime("%Y-%m-%d")
            to_date = now.strftime("%Y-%m-%d")
            df = self._fetch_daily_with_fallback(
                security_id, exchange_segment, instrument_type, from_date, to_date
            )
            if df.empty:
                raise ValueError(
                    "Dhan does not provide candle data for this instrument (no intraday or daily data available)."
                )
            return df, config["label"]

        if tf_key in ("week", "month", "year"):
            lookback = int(period_days) if period_days else (365 * 5)
            from_date = (now - timedelta(days=lookback)).strftime("%Y-%m-%d")
            to_date = now.strftime("%Y-%m-%d")
            df = self._fetch_daily_with_fallback(
                security_id, exchange_segment, instrument_type, from_date, to_date
            )
            if df.empty:
                raise ValueError(
                    "Dhan does not provide candle data for this instrument (no intraday or daily data available)."
                )
            if "resample" in config:
                rule = config["resample"]
                resampled = df.resample(rule).agg({
                    "open": "first",
                    "high": "max",
                    "low": "min",
                    "close": "last",
                    "volume": "sum",
                }).dropna()
                if resampled.empty:
                    raise ValueError(f"No data after resampling to {config['label']}")
                if not _market_open_now():
                    resampled = _trim_post_close_candles(resampled)
                return resampled, config["label"]
            return df, config["label"]

        api_interval = config["api_interval"]
        if period_days and int(period_days) > 0:
            if _intraday_empty_parked(exchange_segment, instrument_type):
                raise _no_intraday_error()
            # Long backtest window: Dhan polls at most 90 days per intraday
            # request, so walk backwards in 90-day chunks and stitch the frames
            # together (deduped + sorted) into one continuous series.
            lookback_days = int(period_days)
            frames = []
            cursor = now
            start = now - timedelta(days=lookback_days)
            step = timedelta(days=90)
            while cursor > start:
                seg_start = max(start, cursor - step)
                seg = self.fetch_intraday_candles(
                    security_id, exchange_segment, instrument_type,
                    seg_start.strftime("%Y-%m-%d %H:%M:%S"),
                    cursor.strftime("%Y-%m-%d %H:%M:%S"),
                    api_interval
                )
                if not seg.empty:
                    frames.append(seg)
                cursor = seg_start
            if frames:
                df = pd.concat(frames)
                df = df[~df.index.duplicated(keep="last")].sort_index()
            else:
                df = pd.DataFrame()
        else:
            if _intraday_empty_parked(exchange_segment, instrument_type):
                raise _no_intraday_error()
            # Dhan polls at most 90 days per intraday request; do not exceed it.
            lookback_days = min({1: 7, 5: 30, 15: 90, 60: 90}.get(api_interval, 30), 90)
            from_date = (now - timedelta(days=lookback_days)).strftime("%Y-%m-%d %H:%M:%S")
            to_date = now.strftime("%Y-%m-%d %H:%M:%S")
            df = self.fetch_intraday_candles(
                security_id, exchange_segment, instrument_type,
                from_date, to_date, api_interval
            )
            if df.empty:
                _mark_intraday_empty(exchange_segment, instrument_type)
                raise ValueError(
                    "Dhan does not provide candle data for this instrument (no intraday or daily data available)."
                )
            _mark_intraday_data(exchange_segment, instrument_type)
            return df, config["label"]

        if tf_key in ("week", "month", "year"):
            from_date = (now - timedelta(days=365 * 5)).strftime("%Y-%m-%d")
            to_date = now.strftime("%Y-%m-%d")
            df = self._fetch_daily_with_fallback(
                security_id, exchange_segment, instrument_type, from_date, to_date
            )
            if df.empty:
                raise ValueError(
                    "Dhan does not provide candle data for this instrument (no intraday or daily data available)."
                )
            if "resample" in config:
                rule = config["resample"]
                resampled = df.resample(rule).agg({
                    "open": "first",
                    "high": "max",
                    "low": "min",
                    "close": "last",
                    "volume": "sum",
                }).dropna()
                return resampled, config["label"]
            return df, config["label"]

        api_interval = config["api_interval"]
        # Dhan polls at most 90 days per intraday request; do not exceed it.
        lookback_days = min({1: 7, 5: 30, 15: 90, 60: 90}.get(api_interval, 30), 90)
        from_date = (now - timedelta(days=lookback_days)).strftime("%Y-%m-%d %H:%M:%S")
        to_date = now.strftime("%Y-%m-%d %H:%M:%S")
        df = self.fetch_intraday_candles(
            security_id, exchange_segment, instrument_type,
            from_date, to_date, api_interval
        )

        is_option = str(instrument_type).upper() in ("OPTIDX", "OPTSTK")
        if is_option and len(df) <= 2:
            # Dhan distinguishes index options (OPTIDX) from stock options (OPTSTK);
            # passing the wrong one makes /charts/intraday return an empty payload OR
            # a single junk bar (which is what produced a "single fat candle" chart).
            # Retry with the alternate type and keep whichever yields more bars.
            alt_type = "OPTSTK" if str(instrument_type).upper() == "OPTIDX" else "OPTIDX"
            try:
                df_alt = self.fetch_intraday_candles(
                    security_id, exchange_segment, alt_type,
                    from_date, to_date, api_interval
                )
            except Exception:
                df_alt = pd.DataFrame()
            if len(df_alt) > len(df):
                df = df_alt
        if is_option and df.empty:
            logger.info("Intraday candles not available for option %s (%s/%s), "
                        "falling back to daily", security_id, exchange_segment, instrument_type)
            from_date_daily = (now - timedelta(days=180)).strftime("%Y-%m-%d")
            to_date_daily = now.strftime("%Y-%m-%d")
            df = self._fetch_daily_with_fallback(
                security_id, exchange_segment, instrument_type,
                from_date_daily, to_date_daily
            )

        if df.empty:
            _mark_intraday_empty(exchange_segment, instrument_type)
            raise _no_intraday_error()

        if "resample" in config:
            rule = config["resample"]
            resampled = df.resample(rule).agg({
                "open": "first",
                "high": "max",
                "low": "min",
                "close": "last",
                "volume": "sum",
            }).dropna()
            if resampled.empty:
                raise ValueError(f"No data after resampling to {config['label']}")
            if not _market_open_now():
                resampled = _trim_post_close_candles(resampled)
            return resampled, config["label"]

        if not _market_open_now():
            df = _trim_post_close_candles(df)
        return df, config["label"]

    def _fetch_daily_with_fallback(self, security_id, exchange_segment, instrument_type,
                                   from_date, to_date):
        """Try Dhan's daily API first; if it fails (e.g. INDIA VIX, GIFT NIFTY, SENSEX),
        resample 15-minute intraday data into daily candles as a fallback."""
        if not daily_hist_broken():
            try:
                df = self.fetch_daily_candles(
                    security_id, exchange_segment, instrument_type, from_date, to_date
                )
                if not df.empty:
                    return df
            except Exception:
                pass
            # The daily attempt re-armed the global rate-limit cooldown (empty
            # body / DH-904). Falling through to the intraday endpoint now just
            # fires another Dhan call (plus its retries) into the same storm,
            # re-tripping the cooldown and starving the user's chart requests.
            # Give up quietly and let the caller retry after the cooldown lifts.
            if rate_limit_cooldown_active():
                return pd.DataFrame()

        try:
            now = datetime.now()
            frm = (now - timedelta(days=90)).strftime("%Y-%m-%d %H:%M:%S")
            to = now.strftime("%Y-%m-%d %H:%M:%S")
            intraday = self.fetch_intraday_candles(
                security_id, exchange_segment, instrument_type, frm, to, 15
            )
            if intraday.empty:
                return pd.DataFrame()
            daily = intraday.resample("D").agg({
                "open": "first",
                "high": "max",
                "low": "min",
                "close": "last",
                "volume": "sum",
            }).dropna()
            return daily
        except Exception:
            return pd.DataFrame()
