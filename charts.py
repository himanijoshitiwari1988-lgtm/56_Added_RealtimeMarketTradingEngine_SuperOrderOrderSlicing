"""
Candlestick Chart Module
Renders candlestick charts with mplfinance, supporting all timeframes.
"""

import matplotlib
matplotlib.use("TkAgg")

import mplfinance as mpf
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
import matplotlib.pyplot as plt


class CandlestickChart:
    def __init__(self, parent_frame):
        self._parent = parent_frame
        self._figure = None
        self._canvas = None
        self._ax = None
        self._setup_figure()

    def _setup_figure(self):
        plt.style.use("dark_background")
        self._figure, self._ax = plt.subplots(figsize=(10, 5), dpi=100)
        self._figure.patch.set_facecolor("#1a1a2e")
        self._ax.set_facecolor("#1a1a2e")
        self._canvas = FigureCanvasTkAgg(self._figure, master=self._parent)
        self._canvas.get_tk_widget().pack(fill="both", expand=True)

    def plot(self, df, title="Candlestick Chart"):
        self._ax.clear()

        if df is None or df.empty:
            self._ax.text(0.5, 0.5, "No data to display",
                          transform=self._ax.transAxes, ha="center", va="center",
                          color="white", fontsize=14)
            self._canvas.draw()
            return

        df = df.copy()
        if df.index.tz is not None:
            df.index = df.index.tz_convert(None)

        required_cols = ["open", "high", "low", "close", "volume"]
        plot_df = df[required_cols].copy()

        mc = mpf.make_marketcolors(
            up="#26a69a", down="#ef5350",
            edge="inherit", wick="inherit", volume={"up": "#26a69a", "down": "#ef5350"},
        )
        style = mpf.make_mpf_style(
            marketcolors=mc,
            facecolor="#1a1a2e",
            figcolor="#1a1a2e",
            gridcolor="#2d2d44",
            gridstyle="--",
            y_on_right=False,
        )

        plot_kwargs = dict(
            type="candle",
            style=style,
            title=title,
            ylabel="Price",
            volume=True,
            figsize=(10, 5),
            warn_too_much_data=len(df),
            tight_layout=True,
        )

        mpf.plot(plot_df, ax=self._ax, **plot_kwargs)
        self._canvas.draw()

    def clear(self):
        self._ax.clear()
        self._ax.text(0.5, 0.5, "Select an instrument and timeframe",
                      transform=self._ax.transAxes, ha="center", va="center",
                      color="gray", fontsize=12)
        self._canvas.draw()


class OptionChainChart:
    def __init__(self, parent_frame):
        self._parent = parent_frame
        self._figure = None
        self._canvas = None
        self._ax_oi = None
        self._ax_iv = None
        self._setup_figure()

    def _setup_figure(self):
        plt.style.use("dark_background")
        self._figure, (self._ax_oi, self._ax_iv) = plt.subplots(
            2, 1, figsize=(10, 6), dpi=100, gridspec_kw={"height_ratios": [2, 1]}
        )
        self._figure.patch.set_facecolor("#1a1a2e")
        for ax in [self._ax_oi, self._ax_iv]:
            ax.set_facecolor("#1a1a2e")
        self._canvas = FigureCanvasTkAgg(self._figure, master=self._parent)
        self._canvas.get_tk_widget().pack(fill="both", expand=True)

    def plot(self, df, title="Option Chain OI Analysis"):
        self._ax_oi.clear()
        self._ax_iv.clear()

        if df is None or df.empty:
            for ax, msg in [(self._ax_oi, "No option chain data"), (self._ax_iv, "")]:
                ax.text(0.5, 0.5, msg, transform=ax.transAxes,
                        ha="center", va="center", color="gray", fontsize=12)
            self._canvas.draw()
            return

        strikes = df["Strike"]
        width = max(1, (max(strikes) - min(strikes)) / len(strikes) * 0.6)

        self._ax_oi.bar(strikes - width / 2, df["PE OI"], width=width,
                        color="#ef5350", alpha=0.8, label="Put OI")
        self._ax_oi.bar(strikes + width / 2, df["CE OI"], width=width,
                        color="#26a69a", alpha=0.8, label="Call OI")
        self._ax_oi.set_title(title, color="white", fontsize=10)
        self._ax_oi.legend(loc="upper left", fontsize=7)
        self._ax_oi.tick_params(colors="white", labelsize=7)
        self._ax_oi.grid(True, alpha=0.2, linestyle="--")
        self._ax_oi.set_ylabel("Open Interest", color="white", fontsize=8)
        self._ax_oi.spines["bottom"].set_color("#2d2d44")
        self._ax_oi.spines["top"].set_color("#2d2d44")
        self._ax_oi.spines["left"].set_color("#2d2d44")
        self._ax_oi.spines["right"].set_color("#2d2d44")

        self._ax_iv.plot(strikes, df["CE IV"], color="#26a69a", marker=".",
                         markersize=3, linewidth=1, label="Call IV")
        self._ax_iv.plot(strikes, df["PE IV"], color="#ef5350", marker=".",
                         markersize=3, linewidth=1, label="Put IV")
        self._ax_iv.legend(loc="upper left", fontsize=7)
        self._ax_iv.tick_params(colors="white", labelsize=7)
        self._ax_iv.grid(True, alpha=0.2, linestyle="--")
        self._ax_iv.set_ylabel("IV %", color="white", fontsize=8)
        self._ax_iv.set_xlabel("Strike Price", color="white", fontsize=8)
        self._ax_iv.spines["bottom"].set_color("#2d2d44")
        self._ax_iv.spines["top"].set_color("#2d2d44")
        self._ax_iv.spines["left"].set_color("#2d2d44")
        self._ax_iv.spines["right"].set_color("#2d2d44")

        self._figure.tight_layout()
        self._canvas.draw()

    def clear(self):
        for ax in [self._ax_oi, self._ax_iv]:
            ax.clear()
            ax.text(0.5, 0.5, "Select an instrument and expiry",
                    transform=ax.transAxes, ha="center", va="center",
                    color="gray", fontsize=10)
        self._canvas.draw()
