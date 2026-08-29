"""
Dhan Algo Trading System
Single-window UI integrating Dhan HQ SDK and Dhan Broker API.

Features:
- Broker settings (Client ID & Access Token)
- Option chain data with OI analysis charts
- Candlestick charts with 14 timeframes (1m to yearly)
- Real-time data from Dhan API (no mock/simulated data)
"""

import tkinter as tk
from tkinter import ttk, messagebox, scrolledtext
import threading
from datetime import datetime, timedelta

from broker import DhanBroker
from data_fetcher import DataFetcher, TIMEFRAME_CONFIG, TRADING_SYMBOLS
from charts import CandlestickChart, OptionChainChart


THEME = {
    "bg": "#0f0f23",
    "fg": "#ffffff",
    "accent": "#1a1a3e",
    "button": "#2d2d5e",
    "button_hover": "#3d3d7e",
    "entry_bg": "#1a1a3e",
    "text": "#e0e0e0",
    "green": "#26a69a",
    "red": "#ef5350",
    "warning": "#ff9800",
    "border": "#2d2d44",
}

SYMBOL_NAMES = {
    13: ("NIFTY 50", "IDX_I", "INDEX"),
    25: ("BANK NIFTY", "IDX_I", "INDEX"),
    27: ("FINNIFTY", "IDX_I", "INDEX"),
    51: ("SENSEX", "IDX_I", "INDEX"),
}

MANUAL_SYMBOLS = [
    ("NIFTY 50", 13, "IDX_I", "INDEX"),
    ("BANK NIFTY", 25, "IDX_I", "INDEX"),
    ("FINNIFTY", 27, "IDX_I", "INDEX"),
    ("SENSEX", 51, "IDX_I", "INDEX"),
]

TIMEFRAME_KEYS = list(TIMEFRAME_CONFIG.keys())

DEFAULT_TIMEFRAME = "5min"


class DhanAlgoApp:
    def __init__(self, root):
        self.root = root
        self.root.title("Dhan Algo Trading System")
        self.root.geometry("1400x900")
        self.root.configure(bg=THEME["bg"])
        self.root.minsize(1200, 700)

        self._broker = DhanBroker()
        self._fetcher = None
        self._current_option_df = None
        self._current_chart_df = None
        self._selected_symbol = MANUAL_SYMBOLS[0]
        self._selected_timeframe = DEFAULT_TIMEFRAME
        self._expiry_list = []
        self._selected_expiry = None

        self._build_ui()
        self._update_status("Disconnected")

    def _build_ui(self):
        self._build_top_bar()
        self._build_main_panel()
        self._build_status_bar()

    def _build_top_bar(self):
        top = tk.Frame(self.root, bg=THEME["accent"], height=50)
        top.pack(fill="x", padx=5, pady=(5, 1))
        top.pack_propagate(False)

        tk.Label(top, text="Dhan Algo Trading System", font=("Arial", 14, "bold"),
                 bg=THEME["accent"], fg=THEME["green"]).pack(side="left", padx=15, pady=10)

        conn_frame = tk.Frame(top, bg=THEME["accent"])
        conn_frame.pack(side="right", padx=10, pady=8)

        tk.Label(conn_frame, text="Client ID:", bg=THEME["accent"], fg=THEME["text"],
                 font=("Arial", 9)).pack(side="left", padx=(0, 3))
        self._client_id_var = tk.StringVar()
        self._client_id_entry = tk.Entry(
            conn_frame, textvariable=self._client_id_var, width=18,
            bg=THEME["entry_bg"], fg=THEME["text"], insertbackground="white",
            font=("Arial", 9), relief="flat", bd=2
        )
        self._client_id_entry.pack(side="left", padx=(0, 8))

        tk.Label(conn_frame, text="Token:", bg=THEME["accent"], fg=THEME["text"],
                 font=("Arial", 9)).pack(side="left", padx=(0, 3))
        self._token_var = tk.StringVar()
        self._token_entry = tk.Entry(
            conn_frame, textvariable=self._token_var, width=35, show="*",
            bg=THEME["entry_bg"], fg=THEME["text"], insertbackground="white",
            font=("Arial", 9), relief="flat", bd=2
        )
        self._token_entry.pack(side="left", padx=(0, 8))

        self._login_btn = tk.Button(
            conn_frame, text="Connect", command=self._on_connect,
            bg=THEME["green"], fg="white", font=("Arial", 9, "bold"),
            relief="flat", padx=15, cursor="hand2", activebackground="#1b8a7a"
        )
        self._login_btn.pack(side="left")

    def _build_main_panel(self):
        pw = ttk.PanedWindow(self.root, orient="horizontal")
        pw.pack(fill="both", expand=True, padx=5, pady=1)

        left = tk.Frame(pw, bg=THEME["bg"], width=280)
        right = tk.Frame(pw, bg=THEME["bg"])
        pw.add(left, weight=0)
        pw.add(right, weight=1)

        self._build_left_panel(left)
        self._build_right_panel(right)

    def _build_left_panel(self, parent):
        header = tk.Label(parent, text="Controls", font=("Arial", 11, "bold"),
                          bg=THEME["bg"], fg=THEME["text"])
        header.pack(anchor="w", padx=10, pady=(10, 5))

        sym_frame = tk.LabelFrame(parent, text=" Instrument Selection ",
                                  bg=THEME["bg"], fg=THEME["text"],
                                  font=("Arial", 9), relief="groove", bd=1,
                                  foreground=THEME["text"])
        sym_frame.pack(fill="x", padx=8, pady=5)

        tk.Label(sym_frame, text="Symbol:", bg=THEME["bg"], fg=THEME["text"],
                 font=("Arial", 9)).pack(anchor="w", padx=10, pady=(5, 0))
        self._symbol_var = tk.StringVar(value=MANUAL_SYMBOLS[0][0])
        self._symbol_combo = ttk.Combobox(
            sym_frame, textvariable=self._symbol_var,
            values=[s[0] for s in MANUAL_SYMBOLS], state="readonly",
            font=("Arial", 9)
        )
        self._symbol_combo.pack(fill="x", padx=10, pady=(2, 8))
        self._symbol_combo.bind("<<ComboboxSelected>>", self._on_symbol_change)

        self._manual_frame = tk.Frame(sym_frame, bg=THEME["bg"])
        self._manual_frame.pack(fill="x", padx=10, pady=(0, 8))
        tk.Label(self._manual_frame, text="Custom Security ID:",
                 bg=THEME["bg"], fg=THEME["text"], font=("Arial", 8)).pack(anchor="w")
        self._custom_sid_var = tk.StringVar()
        custom_entry = tk.Entry(
            self._manual_frame, textvariable=self._custom_sid_var, width=15,
            bg=THEME["entry_bg"], fg=THEME["text"], insertbackground="white",
            font=("Arial", 9), relief="flat", bd=2
        )
        custom_entry.pack(fill="x", pady=(2, 0))
        custom_entry.bind("<Return>", lambda e: self._on_custom_symbol())

        self._exchange_var = tk.StringVar(value="IDX_I")
        exch_values = ["IDX_I", "NSE_EQ", "NSE_FNO", "BSE_EQ", "MCX_COMM", "BSE_FNO"]
        tk.Label(self._manual_frame, text="Exchange Segment:",
                 bg=THEME["bg"], fg=THEME["text"], font=("Arial", 8)).pack(anchor="w", pady=(4, 0))
        exch_combo = ttk.Combobox(
            self._manual_frame, textvariable=self._exchange_var,
            values=exch_values, state="readonly", font=("Arial", 8), width=14
        )
        exch_combo.pack(fill="x", pady=(1, 0))

        self._inst_type_var = tk.StringVar(value="INDEX")
        inst_values = ["INDEX", "EQUITY", "FUTIDX", "OPTIDX", "FUTSTK", "OPTSTK"]
        tk.Label(self._manual_frame, text="Instrument Type:",
                 bg=THEME["bg"], fg=THEME["text"], font=("Arial", 8)).pack(anchor="w", pady=(4, 0))
        inst_combo = ttk.Combobox(
            self._manual_frame, textvariable=self._inst_type_var,
            values=inst_values, state="readonly", font=("Arial", 8), width=14
        )
        inst_combo.pack(fill="x", pady=(1, 0))

        self._apply_custom_btn = tk.Button(
            self._manual_frame, text="Apply Custom", command=self._on_custom_symbol,
            bg=THEME["button"], fg=THEME["text"], font=("Arial", 8),
            relief="flat", padx=5, cursor="hand2"
        )
        self._apply_custom_btn.pack(anchor="w", pady=(5, 2))

        tf_frame = tk.LabelFrame(parent, text=" Timeframe ",
                                 bg=THEME["bg"], fg=THEME["text"],
                                 font=("Arial", 9), relief="groove", bd=1,
                                 foreground=THEME["text"])
        tf_frame.pack(fill="x", padx=8, pady=5)

        self._tf_var = tk.StringVar(value=DEFAULT_TIMEFRAME)
        tf_list = tk.Listbox(
            tf_frame, listvariable=tk.StringVar(value=TIMEFRAME_KEYS),
            height=8, bg=THEME["entry_bg"], fg=THEME["text"],
            font=("Arial", 9), selectbackground=THEME["green"],
            selectforeground="white", relief="flat", bd=1,
            exportselection=False
        )
        tf_list.pack(fill="x", padx=10, pady=5)
        tf_list.bind("<<ListboxSelect>>", self._on_timeframe_change)
        idx = TIMEFRAME_KEYS.index(DEFAULT_TIMEFRAME)
        tf_list.selection_set(idx)
        tf_list.activate(idx)
        self._tf_listbox = tf_list

        self._chart_btn = tk.Button(
            parent, text="Load Chart", command=self._on_load_chart,
            bg=THEME["green"], fg="white", font=("Arial", 10, "bold"),
            relief="flat", padx=20, pady=8, cursor="hand2",
            activebackground="#1b8a7a"
        )
        self._chart_btn.pack(fill="x", padx=8, pady=10)

        oc_frame = tk.LabelFrame(parent, text=" Option Chain ",
                                 bg=THEME["bg"], fg=THEME["text"],
                                 font=("Arial", 9), relief="groove", bd=1,
                                 foreground=THEME["text"])
        oc_frame.pack(fill="x", padx=8, pady=5)

        tk.Label(oc_frame, text="Expiry Date:", bg=THEME["bg"], fg=THEME["text"],
                 font=("Arial", 8)).pack(anchor="w", padx=10, pady=(5, 0))
        self._expiry_var = tk.StringVar()
        self._expiry_combo = ttk.Combobox(
            oc_frame, textvariable=self._expiry_var, state="readonly",
            font=("Arial", 8), values=[]
        )
        self._expiry_combo.pack(fill="x", padx=10, pady=(2, 0))

        self._load_expiry_btn = tk.Button(
            oc_frame, text="Load Expiries", command=self._on_load_expiries,
            bg=THEME["button"], fg=THEME["text"], font=("Arial", 8),
            relief="flat", cursor="hand2"
        )
        self._load_expiry_btn.pack(fill="x", padx=10, pady=(3, 0))

        self._oc_btn = tk.Button(
            oc_frame, text="Fetch Option Chain", command=self._on_fetch_option_chain,
            bg=THEME["warning"], fg="black", font=("Arial", 9, "bold"),
            relief="flat", padx=10, pady=5, cursor="hand2"
        )
        self._oc_btn.pack(fill="x", padx=10, pady=(5, 8))

    def _build_right_panel(self, parent):
        notebook = ttk.Notebook(parent)
        notebook.pack(fill="both", expand=True, padx=0, pady=0)

        chart_tab = tk.Frame(notebook, bg=THEME["bg"])
        oc_tab = tk.Frame(notebook, bg=THEME["bg"])

        notebook.add(chart_tab, text="  Candlestick Chart  ")
        notebook.add(oc_tab, text="  Option Chain  ")
        self._notebook = notebook

        chart_container = tk.Frame(chart_tab, bg=THEME["bg"])
        chart_container.pack(fill="both", expand=True, padx=2, pady=2)
        self._chart = CandlestickChart(chart_container)
        self._chart.clear()

        oc_pane = tk.PanedWindow(oc_tab, orient="vertical", bg=THEME["bg"])
        oc_pane.pack(fill="both", expand=True)

        oc_chart_frame = tk.Frame(oc_pane, bg=THEME["bg"], height=250)
        oc_table_frame = tk.Frame(oc_pane, bg=THEME["bg"])
        oc_pane.add(oc_chart_frame, height=250)
        oc_pane.add(oc_table_frame)

        self._oc_chart = OptionChainChart(oc_chart_frame)
        self._oc_chart.clear()

        self._oc_tree = self._build_option_chain_tree(oc_table_frame)

    def _build_option_chain_tree(self, parent):
        columns = ("Strike", "CE LTP", "CE IV", "CE OI", "CE Vol",
                   "CE Delta", "PE LTP", "PE IV", "PE OI", "PE Vol", "PE Delta")

        tree_frame = tk.Frame(parent, bg=THEME["bg"])
        tree_frame.pack(fill="both", expand=True)

        tree = ttk.Treeview(tree_frame, columns=columns, show="headings",
                            height=15, selectmode="browse")
        tree.pack(side="left", fill="both", expand=True)

        scroll_y = ttk.Scrollbar(tree_frame, orient="vertical", command=tree.yview)
        scroll_y.pack(side="right", fill="y")
        tree.configure(yscrollcommand=scroll_y.set)

        for col in columns:
            tree.heading(col, text=col, anchor="center")
            tree.column(col, width=85, anchor="center", minwidth=60)

        style = ttk.Style()
        style.theme_use("clam")
        style.configure("Treeview",
                        background=THEME["entry_bg"],
                        foreground=THEME["text"],
                        fieldbackground=THEME["entry_bg"],
                        rowheight=22, font=("Arial", 8))
        style.configure("Treeview.Heading",
                        background=THEME["accent"],
                        foreground=THEME["text"], font=("Arial", 8, "bold"))
        style.map("Treeview", background=[("selected", THEME["green"])])

        tree.tag_configure("green_tag", foreground=THEME["green"])
        tree.tag_configure("red_tag", foreground=THEME["red"])

        return tree

    def _build_status_bar(self):
        status = tk.Frame(self.root, bg=THEME["accent"], height=25)
        status.pack(fill="x", side="bottom", padx=5, pady=(1, 5))
        status.pack_propagate(False)

        self._status_label = tk.Label(
            status, text="Status: Disconnected", font=("Arial", 9),
            bg=THEME["accent"], fg=THEME["red"], anchor="w"
        )
        self._status_label.pack(side="left", padx=10)

        self._progress = ttk.Progressbar(status, mode="indeterminate", length=150)
        self._progress.pack(side="right", padx=10)

    def _update_status(self, text, color=None):
        if color is None:
            color = THEME["green"] if self._broker.is_connected else THEME["red"]
        conn = "Connected" if self._broker.is_connected else "Disconnected"
        self._status_label.config(text=f"Status: {conn} | {text}", fg=color)

    def _on_connect(self):
        client_id = self._client_id_var.get().strip()
        token = self._token_var.get().strip()

        if not client_id or not token:
            messagebox.showerror("Error", "Please enter Client ID and Access Token")
            return

        try:
            self._broker.connect(client_id, token)
            self._fetcher = DataFetcher(self._broker)
            self._update_status("Connected successfully", THEME["green"])
            self._login_btn.config(bg="#1b8a7a", text="Connected")
            self._oc_btn.config(state="normal")
            self._chart_btn.config(state="normal")
            self._load_expiry_btn.config(state="normal")
            messagebox.showinfo("Success", "Connected to Dhan API successfully")
        except Exception as e:
            messagebox.showerror("Connection Error", f"Failed to connect: {e}")
            self._update_status("Connection failed", THEME["red"])

    def _on_symbol_change(self, event=None):
        name = self._symbol_var.get()
        for sym_name, sid, exch, inst in MANUAL_SYMBOLS:
            if sym_name == name:
                self._selected_symbol = (sym_name, sid, exch, inst)
                self._custom_sid_var.set(str(sid))
                self._exchange_var.set(exch)
                self._inst_type_var.set(inst)
                return

    def _on_custom_symbol(self):
        try:
            sid = int(self._custom_sid_var.get().strip())
        except ValueError:
            messagebox.showerror("Error", "Invalid Security ID")
            return
        exch = self._exchange_var.get()
        inst = self._inst_type_var.get()
        name = f"Custom ({sid})"
        self._selected_symbol = (name, sid, exch, inst)
        self._symbol_var.set(name)

    def _on_timeframe_change(self, event=None):
        sel = self._tf_listbox.curselection()
        if sel:
            self._selected_timeframe = TIMEFRAME_KEYS[sel[0]]

    def _on_load_chart(self):
        if not self._broker.is_connected:
            messagebox.showerror("Error", "Please connect to Dhan API first")
            return
        self._notebook.select(0)
        threading.Thread(target=self._fetch_chart_data, daemon=True).start()

    def _fetch_chart_data(self):
        self.root.after(0, self._progress.start)
        self.root.after(0, lambda: self._update_status("Fetching chart data..."))
        self.root.after(0, lambda: self._chart_btn.config(state="disabled"))

        try:
            _, sid, exch, inst = self._selected_symbol
            tf = self._selected_timeframe
            label = TIMEFRAME_CONFIG[tf]["label"]
            df, _ = self._fetcher.fetch_candles_for_timeframe(sid, exch, inst, tf)
            self._current_chart_df = df
            title = f"{self._selected_symbol[0]} - {label}"
            self.root.after(0, lambda: self._chart.plot(df, title))
            self.root.after(0, lambda: self._update_status(
                f"Loaded {len(df)} candles"))
        except Exception as e:
            self.root.after(0, lambda: messagebox.showerror("Error", str(e)))
            self.root.after(0, lambda: self._update_status("Chart load failed", THEME["red"]))
        finally:
            self.root.after(0, self._progress.stop)
            self.root.after(0, lambda: self._chart_btn.config(state="normal"))

    def _on_load_expiries(self):
        if not self._broker.is_connected:
            messagebox.showerror("Error", "Please connect to Dhan API first")
            return
        threading.Thread(target=self._fetch_expiries, daemon=True).start()

    def _fetch_expiries(self):
        self.root.after(0, self._progress.start)
        self.root.after(0, lambda: self._update_status("Loading expiries..."))

        try:
            _, sid, exch, _ = self._selected_symbol
            expiries = self._fetcher.fetch_expiry_list(sid, exch)
            self._expiry_list = expiries
            if expiries:
                self.root.after(0, lambda: self._expiry_combo.config(values=expiries))
                self.root.after(0, lambda: self._expiry_combo.set(expiries[0]))
                self._selected_expiry = expiries[0]
                self.root.after(0, lambda: self._update_status(
                    f"Loaded {len(expiries)} expiries"))
            else:
                self.root.after(0, lambda: messagebox.showwarning(
                    "No Data", "No expiries found for this symbol"))
        except Exception as e:
            self.root.after(0, lambda: messagebox.showerror("Error", str(e)))
        finally:
            self.root.after(0, self._progress.stop)

    def _on_fetch_option_chain(self):
        if not self._broker.is_connected:
            messagebox.showerror("Error", "Please connect to Dhan API first")
            return

        expiry = self._expiry_var.get().strip()
        if not expiry:
            messagebox.showerror("Error", "Please load and select an expiry date")
            return

        self._selected_expiry = expiry
        self._notebook.select(1)
        threading.Thread(target=self._fetch_option_chain_data, args=(expiry,), daemon=True).start()

    def _fetch_option_chain_data(self, expiry):
        self.root.after(0, self._progress.start)
        self.root.after(0, lambda: self._update_status("Fetching option chain..."))
        self.root.after(0, lambda: self._oc_btn.config(state="disabled"))

        try:
            _, sid, exch, _ = self._selected_symbol
            raw = self._fetcher.fetch_option_chain(sid, exch, expiry)
            df = self._fetcher.parse_option_chain_to_dataframe(raw)
            self._current_option_df = df

            self.root.after(0, lambda: self._populate_option_chain_tree(df))
            self.root.after(0, lambda: self._oc_chart.plot(
                df, f"Option Chain - {self._selected_symbol[0]} Exp: {expiry}"))
            self.root.after(0, lambda: self._update_status(
                f"Loaded option chain: {len(df)} strikes"))
        except Exception as e:
            self.root.after(0, lambda: messagebox.showerror("Error", str(e)))
            self.root.after(0, lambda: self._update_status("Option chain fetch failed", THEME["red"]))
        finally:
            self.root.after(0, self._progress.stop)
            self.root.after(0, lambda: self._oc_btn.config(state="normal"))

    def _populate_option_chain_tree(self, df):
        tree = self._oc_tree
        for item in tree.get_children():
            tree.delete(item)

        if df is None or df.empty:
            return

        atm_strike = None
        if "CE LTP" in df.columns and "PE LTP" in df.columns and "Strike" in df.columns:
            df["diff"] = abs(df["CE LTP"].fillna(0) - df["PE LTP"].fillna(0))
            atm_strike = df.loc[df["diff"].idxmin(), "Strike"] if not df.empty else None

        for _, row in df.iterrows():
            strike = row.get("Strike", 0)
            values = (
                f"{strike:.0f}",
                f"{row.get('CE LTP', 0):.2f}",
                f"{row.get('CE IV', 0):.1f}",
                f"{int(row.get('CE OI', 0)):,}",
                f"{int(row.get('CE Volume', 0)):,}",
                f"{row.get('CE Delta', 0):.4f}",
                f"{row.get('PE LTP', 0):.2f}",
                f"{row.get('PE IV', 0):.1f}",
                f"{int(row.get('PE OI', 0)):,}",
                f"{int(row.get('PE Volume', 0)):,}",
                f"{row.get('PE Delta', 0):.4f}",
            )
            tags = ()
            if atm_strike is not None and abs(strike - atm_strike) < 0.01:
                tags = ("green_tag",)
            tree.insert("", "end", values=values, tags=tags)


def main():
    root = tk.Tk()
    app = DhanAlgoApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
