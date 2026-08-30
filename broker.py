"""
Dhan Broker Integration Module
Handles authentication, connection and provides API access objects.
"""

from dhanhq import DhanContext, dhanhq
from dhanhq._option_chain import OptionChain
from dhanhq._historical_data import HistoricalData


class DhanBroker:
    def __init__(self):
        self._context = None
        self._dhan = None
        self._option_chain = None
        self._historical_data = None
        self._client_id = None
        self._access_token = None

    def connect(self, client_id, access_token):
        self._client_id = str(client_id)
        self._access_token = str(access_token)
        self._context = DhanContext(self._client_id, self._access_token)
        # Bound every Dhan API call so a slow/hung endpoint fails fast instead of
        # blocking a request thread for the SDK's 60s default (pre-market the
        # option chain and quote endpoints can stall and make the UI look hung).
        try:
            self._context.dhan_http.timeout = 6
        except Exception:
            pass
        self._dhan = dhanhq(self._context)
        self._option_chain = OptionChain(self._context)
        self._historical_data = HistoricalData(self._context)
        return True

    @property
    def is_connected(self):
        return self._context is not None

    def place_order(self, security_id, exchange_segment, transaction_type,
                    quantity, order_type="MARKET", product_type="INTRA", price=0.0,
                    trigger_price=0.0, tag=None):
        if not self.is_connected:
            raise ValueError("Broker not connected")
        if transaction_type not in ("BUY", "SELL"):
            raise ValueError("transaction_type must be BUY or SELL")
        quantity = int(quantity)
        if quantity <= 0:
            raise ValueError("quantity must be a positive integer")
        return self._dhan.place_order(
            security_id=str(security_id),
            exchange_segment=str(exchange_segment),
            transaction_type=transaction_type,
            quantity=quantity,
            order_type=str(order_type),
            product_type=str(product_type),
            price=float(price),
            trigger_price=float(trigger_price),
            tag=tag,
        )


    @property
    def client_id(self):
        return self._client_id

    @property
    def dhan(self):
        return self._dhan

    @property
    def option_chain(self):
        return self._option_chain

    @property
    def historical(self):
        return self._historical_data

    @property
    def context(self):
        return self._context
