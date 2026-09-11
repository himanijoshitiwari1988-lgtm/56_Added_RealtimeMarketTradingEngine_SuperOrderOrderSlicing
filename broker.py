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

    def _validate_basic(self, security_id, exchange_segment, transaction_type,
                        quantity):
        if not self.is_connected:
            raise ValueError("Broker not connected")
        if transaction_type not in ("BUY", "SELL"):
            raise ValueError("transaction_type must be BUY or SELL")
        quantity = int(quantity)
        if quantity <= 0:
            raise ValueError("quantity must be a positive integer")
        if not security_id:
            raise ValueError("security_id required")
        if not exchange_segment:
            raise ValueError("exchange_segment required")
        return quantity

    def place_order(self, security_id, exchange_segment, transaction_type,
                    quantity, order_type="MARKET", product_type="INTRA", price=0.0,
                    trigger_price=0.0, disclosed_quantity=0, tag=None):
        quantity = self._validate_basic(security_id, exchange_segment,
                                        transaction_type, quantity)
        return self._dhan.place_order(
            security_id=str(security_id),
            exchange_segment=str(exchange_segment),
            transaction_type=transaction_type,
            quantity=quantity,
            order_type=str(order_type),
            product_type=str(product_type),
            price=float(price),
            trigger_price=float(trigger_price),
            disclosed_quantity=int(disclosed_quantity or 0),
            tag=tag,
        )

    def place_slice_order(self, security_id, exchange_segment, transaction_type,
                          quantity, order_type="MARKET", product_type="INTRA",
                          price=0.0, trigger_price=0.0, disclosed_quantity=0,
                          tag=None):
        quantity = self._validate_basic(security_id, exchange_segment,
                                        transaction_type, quantity)
        disclosed_quantity = int(disclosed_quantity or 0)
        if disclosed_quantity < 0 or disclosed_quantity > quantity:
            raise ValueError("disclosed_quantity must be between 0 and quantity")
        return self._dhan.place_slice_order(
            security_id=str(security_id),
            exchange_segment=str(exchange_segment),
            transaction_type=transaction_type,
            quantity=quantity,
            order_type=str(order_type),
            product_type=str(product_type),
            price=float(price),
            trigger_price=float(trigger_price),
            disclosed_quantity=disclosed_quantity,
            tag=tag,
        )

    def place_super_order(self, security_id, exchange_segment, transaction_type,
                          quantity, order_type="LIMIT", product_type="INTRA",
                          price=0.0, target_price=0.0, stop_loss_price=0.0,
                          trailing_jump=0.0, tag=None):
        quantity = self._validate_basic(security_id, exchange_segment,
                                        transaction_type, quantity)
        if float(price) <= 0:
            raise ValueError("Super order entry price must be > 0")
        if float(target_price) <= 0 and float(stop_loss_price) <= 0:
            raise ValueError("Super order needs a target and/or stop-loss price")
        return self._dhan.place_super_order(
            security_id=str(security_id),
            exchange_segment=str(exchange_segment),
            transaction_type=transaction_type,
            quantity=quantity,
            order_type=str(order_type),
            product_type=str(product_type),
            price=float(price),
            targetPrice=float(target_price),
            stopLossPrice=float(stop_loss_price),
            trailingJump=float(trailing_jump),
            tag=tag,
        )

    def get_super_orders(self):
        """Return the live/updated Super Order book from Dhan.

        Each entry carries the nested legDetails array (ENTRY_LEG / TARGET_LEG /
        STOP_LOSS_LEG) with the CURRENT stopLossPrice and trailingJump - the
        broker-side trailing stop that our app mirrors back as a percent.
        """
        if not self.is_connected:
            raise ValueError("Broker not connected")
        return self._dhan.get_super_order_list()

    def place_forever(self, security_id, exchange_segment, transaction_type,
                      quantity, order_type="LIMIT", product_type="CNC",
                      price=0.0, trigger_price=0.0, order_flag="SINGLE",
                      disclosed_quantity=0, validity="DAY", price1=0.0,
                      trigger_price1=0.0, quantity1=0, tag=None, symbol=""):
        quantity = self._validate_basic(security_id, exchange_segment,
                                        transaction_type, quantity)
        if str(order_flag).upper() == "OCO":
            if int(quantity1 or 0) <= 0:
                raise ValueError("OCO forever order requires quantity1 > 0")
        return self._dhan.place_forever(
            security_id=str(security_id),
            exchange_segment=str(exchange_segment),
            transaction_type=transaction_type,
            product_type=str(product_type),
            order_type=str(order_type),
            quantity=quantity,
            price=float(price),
            trigger_Price=float(trigger_price),
            order_flag=str(order_flag).upper(),
            disclosed_quantity=int(disclosed_quantity or 0),
            validity=str(validity).upper(),
            price1=float(price1),
            trigger_Price1=float(trigger_price1),
            quantity1=int(quantity1 or 0),
            tag=tag,
            symbol=str(symbol or ""),
        )

    def margin_calculator(self, security_id, exchange_segment, transaction_type,
                          quantity, product_type="INTRA", price=0.0,
                          trigger_price=0.0):
        if not self.is_connected:
            raise ValueError("Broker not connected")
        if transaction_type not in ("BUY", "SELL"):
            raise ValueError("transaction_type must be BUY or SELL")
        return self._dhan.margin_calculator(
            security_id=str(security_id),
            exchange_segment=str(exchange_segment),
            transaction_type=transaction_type,
            quantity=int(quantity),
            product_type=str(product_type),
            price=float(price),
            trigger_price=float(trigger_price),
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
