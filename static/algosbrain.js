/* ============================================================================
   Algos AI Brain - an offline intent "brain" for the whole algo system.
   ----------------------------------------------------------------------------
   * Reads the live state of every engine (AI Smart Trading on every paper tab,
     Pooled Runner, Auto Experiment, Simulator, strategy libraries, P&L ledgers)
     and the shared quote store.
   * Understands Hinglish / English commands typed in chat and either answers
     with data or ACTS on the system by driving the same engines the UI drives
     (run / stop strategies, switch timeframes, send experiments to paper, ...).
   * Chat window lives in the "Algos AI Brain" tab and can become a floating
     overlay (checkbox in its header) so you can chat while working in any tab.
   * Offline - no API key, no external model. A small deterministic intent
     engine + knowledge of every control/engine.
   ==========================================================================*/
(function () {
  'use strict';

  var PREFS_KEY = 'algodhan_aibrain_prefs_v1';
  var CHAT_KEY = 'algodhan_aibrain_chat_v1';
  var TAB_ID = 'algosbrain';
  var SAVED_STRATS_KEY = 'algodhan_strategies_v1';

  function store() {
    try { return JSON.parse(localStorage.getItem(CHAT_KEY) || '[]'); } catch (e) { return []; }
  }
  function saveStore(list) {
    try { list = (list || []).slice(-200); localStorage.setItem(CHAT_KEY, JSON.stringify(list)); } catch (e) {}
  }
  function prefs() {
    try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); } catch (e) { return {}; }
  }
  function setPref(k, v) {
    var p = prefs(); p[k] = v;
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (e) {}
  }

  /* ------------------------------------------------------------------ utils */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function inr(n) {
    n = Number(n) || 0;
    var sign = n < 0 ? '-' : '';
    return sign + '\u20B9' + Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  }
  function pct(n) { return (Number(n) || 0).toFixed(1) + '%'; }
  function now() { return new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }); }
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  /* Which AST engine instance a chat command should target. The chat usually
     acts on the engine the user last worked in (paper active engine); a clone
     can be addressed by name ("paper2"). */
  function astKeyFor(msg) {
    var m = /(?:paper|pt)[\s-]*(\d+)/i.exec(msg || '');
    if (m && window.TabEngines && window.TabEngines.aismart) {
      var want = 'paper' + m[1];
      if (window.TabEngines.aismart[want]) return want;
    }
    var active = window._paperActiveEngine || 'papertrade';
    if (window.TabEngines && window.TabEngines.aismart && window.TabEngines.aismart[active]) return active;
    return 'papertrade';
  }
  function suffixFor(key) {
    if (!key || key === 'papertrade') return '';
    return '_' + key;
  }
  function astEng(key) {
    if (window.TabEngines && window.TabEngines.aismart) {
      var e = window.TabEngines.aismart[key || 'papertrade'];
      if (e) return e;
    }
    return window.AISmartTrading || null;
  }
  function astEl(key, id) {
    var s = suffixFor(key);
    return $(id + s) || $(id) || null;
  }
  function astKeys() {
    if (!window.TabEngines || !window.TabEngines.aismart) return [];
    var keys = Object.keys(window.TabEngines.aismart);
    var order = ['papertrade', 'pool', 'ntrader'];
    keys.sort(function (a, b) {
      var ia = order.indexOf(a), ib = order.indexOf(b);
      if (ia >= 0 && ib >= 0) return ia - ib;
      if (ia >= 0) return -1;
      if (ib >= 0) return 1;
      return a < b ? -1 : (a > b ? 1 : 0);
    });
    return keys;
  }
  function astLabel(key) {
    if (key === 'papertrade') return 'Paper Trade (AI Smart)';
    if (key === 'pool') return 'Pooled Runner';
    if (key === 'ntrader') return 'Smart NTrader';
    if (/^paper\d+$/.test(key)) return 'Paper Tab ' + key.replace('paper', '');
    return key;
  }
  function modeText(st) {
    if (!st) return 'off';
    if (st.enabled && st.runIntent && st.runIntent.active) {
      var m = st.runIntent.mode === 'filter' ? 'Indicator-filters'
        : (st.aiPick ? 'AI auto-pick' : 'normal strategies');
      return m + ' (ON)';
    }
    if (st.enabled) return 'enabled, idle';
    return 'OFF';
  }
  function runCount(eng) {
    try {
      if (eng && typeof eng.runningStrategies === 'function') {
        var r = eng.runningStrategies();
        return r && r.length ? r.length : 0;
      }
    } catch (e) {}
    return 0;
  }
  function astSummary(key, st, eng) {
    var closed = (st && st.closed) || [];
    var realized = 0, charges = 0, count = 0, wins = 0;
    for (var i = 0; i < closed.length; i++) {
      var t = closed[i];
      var v = (typeof t.netPnl === 'number') ? t.netPnl : (typeof t.pnl === 'number' ? t.pnl : 0);
      realized += v;
      if (typeof t.charges === 'number') charges += t.charges;
      count++;
      if (v > 0) wins++;
    }
    var positions = (st && st.positions) ? st.positions : {};
    var posKeys = Object.keys(positions);
    var openPnl = null;
    /* Prefer the engine's own open-P&L (priced with the same chart close the
       Running Trades row uses) so a live open position is never reported as a
       flat zero. Fall back to a stored pnl on the position when unavailable. */
    try {
      if (eng && typeof eng.pnlSummary === 'function') {
        var ps = eng.pnlSummary();
        if (ps && typeof ps.openPnl === 'number') openPnl = ps.openPnl;
      }
    } catch (e) {}
    if (openPnl == null) {
      var sum = 0, ok = false;
      for (var j = 0; j < posKeys.length; j++) {
        var p = positions[posKeys[j]] || {};
        var pv = (typeof p.netPnl === 'number') ? p.netPnl : (typeof p.pnl === 'number' ? p.pnl : null);
        if (typeof pv === 'number') { sum += pv; ok = true; }
      }
      if (ok) openPnl = sum;
    }
    return {
      key: key, label: astLabel(key), enabled: !!(st && st.enabled),
      mode: modeText(st), running: runCount(eng),
      realized: realized, charges: charges, count: count, wins: wins,
      winRate: count ? (wins / count * 100) : null,
      open: posKeys.length, openPnl: openPnl
    };
  }
  function engineState(key) {
    var eng = astEng(key);
    try {
      if (eng && typeof eng.getState === 'function') return eng.getState() || null;
    } catch (e) {}
    return null;
  }
  function astStateLine(key) {
    var st = engineState(key);
    if (!st) return astLabel(key) + ': (no state)';
    var s = astSummary(key, st, astEng(key));
    var tf = '5min';
    var tfEl = astEl(key, 'astNiftyTf');
    if (tfEl) tf = tfEl.value || tf;
    var parts = [s.label + ' -> ' + s.mode];
    parts.push('  running: ' + s.running + ' strategy(s), open positions: ' + s.open);
    parts.push('  realized P&L: ' + inr(s.realized) + '  |  win rate: ' + (s.winRate == null ? 'n/a' : pct(s.winRate)));
    parts.push('  nifty trend tf: ' + tf);
    return parts.join('\n');
  }

  function loadSavedStrats() {
    try {
      var arr = JSON.parse(localStorage.getItem(SAVED_STRATS_KEY) || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function stratLabel(s) {
    if (!s) return '';
    var nm = s.name || s.title || s.key || '';
    var sym = (s.symbol && s.symbol.name) ? (' on ' + s.symbol.name) : '';
    var side = s.cat === 'bearish' ? 'BEAR(PE)' : 'BULL(CE)';
    return (nm ? nm + ' ' : '') + side + sym;
  }

  /* ------------------------------------------------------------------- chat */
  var els = {};
  var pending = null; /* {type, params, text} awaiting yes/no */
  var booted = false;
  /* Optional LLM backend (server-side key). When llm.enabled is true the chat
     goes through the model for real conversation; otherwise the offline intent
     brain answers. */
  var llm = { enabled: false, model: '', busy: false, rounds: 0, msgs: [] };

  function addMsg(role, text) {
    var list = store();
    list.push({ r: role, t: text, ts: Date.now() });
    saveStore(list);
    renderMsgs();
  }
  function renderMsgs() {
    var host = els.msgs;
    if (!host) return;
    host.innerHTML = '';
    var list = store();
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      var wrap = document.createElement('div');
      wrap.className = 'aib-msg aib-' + (m.r === 'user' ? 'user' : 'ai');
      var bubble = document.createElement('div');
      bubble.className = 'aib-bubble';
      bubble.textContent = m.t;
      wrap.appendChild(bubble);
      host.appendChild(wrap);
    }
    host.scrollTop = host.scrollHeight;
    if (pending) attachPendingButtons(host);
  }
  function attachPendingButtons(host) {
    if (!host) return;
    var msgs = host.querySelectorAll ? host.querySelectorAll('.aib-msg.aib-ai') : [];
    var last = msgs && msgs.length ? msgs[msgs.length - 1] : null;
    if (!last) return;
    var bubble = last.querySelector && last.querySelector('.aib-bubble');
    var row = document.createElement('div');
    row.className = 'aib-confirm-row';
    var yes = document.createElement('button');
    yes.className = 'btn-action';
    yes.style.cssText = 'width:auto;padding:3px 12px;margin:0 6px 0 0;font-size:10px;background:#00d4aa;color:#042';
    yes.textContent = 'Haan, kar do';
    yes.onclick = function () { confirmAction(true); };
    var no = document.createElement('button');
    no.className = 'btn-action';
    no.style.cssText = 'width:auto;padding:3px 12px;margin:0;font-size:10px;background:#555';
    no.textContent = 'Nahi, cancel';
    no.onclick = function () { confirmAction(false); };
    row.appendChild(yes); row.appendChild(no);
    (bubble || last).appendChild(row);
    host.scrollTop = host.scrollHeight;
  }
  function ask(text, type, params) {
    pending = { type: type, params: params || {} };
    addMsg('ai', text);
  }
  function confirmAction(go) {
    if (!pending) return;
    var p = pending;
    pending = null;
    renderMsgs();
    if (!go) { addMsg('ai', 'OK - cancel kar diya. Kuch aur batao?'); return; }
    if (p.type === 'llmAction') {
      execLlmAction(p.params.type, p.params.params);
      if (llm.enabled) {
        llm.msgs.push({ role: 'user', content: '[User confirmed action] ' + p.params.type });
        trimMsgs();
      }
      return;
    }
    runAction(p.type, p.params);
  }
  function clearChat() {
    saveStore([]);
    pending = null;
    llm.msgs = [];
    renderMsgs();
  }

  /* Actions that can change trading state; executed here (after confirm). */
  function runAction(type, params) {
    if (type === 'stopAll') {
      var eng = astEng(params.key || 'papertrade');
      if (!eng) { addMsg('ai', 'Engine instance nahi mila.'); return; }
      try {
        if (typeof eng.stopAll === 'function') eng.stopAll();
        if (typeof eng.stopAllStrategies === 'function') eng.stopAllStrategies(true);
        addMsg('ai', 'AI Smart Trading (' + astLabel(params.key || 'papertrade') + ') band kar diya. Saare running strategies/trades stop, engine ab OFF hai.');
      } catch (e) { addMsg('ai', 'Stop karne me dikkat aayi: ' + e.message); }
    } else if (type === 'resetPnl') {
      var e2 = astEng(params.key || 'papertrade');
      if (!e2) { addMsg('ai', 'Engine nahi mila.'); return; }
      try { e2.resetPnl(); addMsg('ai', 'P&L reset ho gaya (' + astLabel(params.key || 'papertrade') + ').'); }
      catch (e) { addMsg('ai', 'Reset fail: ' + e.message); }
    } else if (type === 'runStrategy') {
      execRunStrategy(params);
    } else if (type === 'aeToPaper') {
      execAeToPaper(params);
    }
  }

  /* ------------------------------------------------------------------- help */
  function helpText() {
    return [
      'Main Algos AI Brain hoon - is poore algo system ki har tab, har setting, har data ki knowledge rakhta hoon.',
      '',
      'Mujhse aise baat karo (Hinglish ya English):',
      '  • "Sab kya chal raha hai?" / "overview"',
      '      -> har engine ka live status: running strategies, mode, nifty trend tf.',
      '  • "Aaj ka P&L batao" / "win rate kya hai" / "performance batao"',
      '      -> realized P&L, charges, wins, win rate, open positions.',
      '  • "NIFTY ka price kya hai?" / "market data do"',
      '      -> live quote (agar live feed hai).',
      '  • "1 minute me trading karo" / "5 minute timeframe set karo"',
      '      -> engine ab us timeframe par trades decide karega.',
      '  • "X strategy ko run karo" / "top 3 bullish run karo" / "...paper me bhejo"',
      '      -> strategy ko tick karke AI Smart paper engine me chala deta hoon.',
      '  • "Sab band kar do" / "stop all" / "P&L reset karo"',
      '      -> trading actions; agar "auto" bologe to bina puche chalunga, warna pehle confirm karunga.',
      '  • "Help" / "kya kar sakte ho"',
      '',
      'Koi bhi run/stop/close karne se pehle confirm poochhta hoon, jab tak aap khud "auto kar lo" na bolo.'
    ].join('\n');
  }

  /* ----------------------------------------------------------- data readers */
  function idxQuote(name, id) {
    try {
      if (typeof window.liveQuoteForSymbol === 'function') {
        var v = window.liveQuoteForSymbol(id, 'IDX_I');
        if (v != null) return v;
      }
      var q = (typeof clientQuotes !== 'undefined') ? (clientQuotes['IDX_I:' + id] || null) : null;
      if (q && q.ltp != null) return Number(q.ltp);
    } catch (e) {}
    return null;
  }
  function quoteLine(name, id) {
    var v = idxQuote(name, id);
    if (v == null) return name + ': no live tick yet';
    return name + ': ' + v.toLocaleString('en-IN');
  }

  /* ------------------------------------------------------------- the brain */
  function think(text) {
    var t = ' ' + String(text || '').toLowerCase() + ' ';
    var auto = /(auto|bina puche|direct|seedha|without ask|turant|just do)/.test(t);
    var haveName = /(run|chalao|chalana|execute|start|bhej|paper)\b/.test(t);

    /* greetings */
    if (/(^|\s)(hi|hello|hey|namaste|namaskar|naman)(\s|[!.,]|$)/.test(t) || /^hi$/.test(String(text||'').trim().toLowerCase())) {
      return 'Namaste! Main Algos AI Brain hoon. Poore algo system ko control kar sakta hoon - status, P&L, market data, timeframe, strategy run, sab kuch.\n\n"help" likho to pura list milega.';
    }
    if (/(help|kya kar sakte|capabilit|commands|kaise use|how to|options)/.test(t)) return helpText();
    if (/(thank|dhanyavad|shukriya|thanks|thx)/.test(t)) return 'Koi baat nahi! Kuch aur chahiye to batao.';
    if (/(who are you|kaun ho|tum kaun|about you)/.test(t)) return 'Main Algos AI Brain hoon - aapke algos system ka offline assistant. Har engine, setting aur data tak meri pahunch hai, aur main aapke liye algo ko manage kar sakta hoon.';
    /* LLM-mode explainer (only shown while offline) */
    if (!llm.enabled && /(\bllm\b|gpt|chat ?gpt|openai|deep ?seek|gemini|claude|ai model|\bmodel\b|api ?key|connect.*key|insaan jaisi|natural|language model)/.test(t)) {
      return llmHowToText();
    }

    /* overview / status */
    if (/(sab (kya )?chal|status|overview|kya chalu|running kya|summar|kya chal rah|chal raha h|chal rahi h)/.test(t) ||
        (/\bdata\b/.test(t) && /(sab|poora|system|engine|report)/.test(t))) {
      return overviewText();
    }

    /* market data / quotes / indices (note: no bare 'rate' token so that
       "win rate" is never mistaken for a quote request; 'data' alone routes
       to the overview above unless it is about a quote/index) */
    if (/(price|quote|ltp|nifty|bank ?nifty|sensex|gift|bhav|khula)/i.test(t) || /\bmarket\b/.test(t)) {
      return marketText(text);
    }

    /* simulator control (test feed, not live trading) */
    if (/simulator/.test(t)) {
      if (/(start|on|run|chalao|chalana|shuru)/.test(t)) {
        try {
          if (window.Simulator && typeof window.Simulator.start === 'function') { window.Simulator.start(); return 'Simulator start kar diya - ab live-looking candles feed ho rahi hain, engines is par test kar sakte hain.'; }
          return 'Simulator available nahi hai.' + (window.Simulator ? ' isRunning=' + window.Simulator.isRunning() : '');
        } catch (e) { return 'Simulator start me dikkat: ' + e.message; }
      }
      if (/(stop|band|off|bnd|rok)/.test(t)) {
        try {
          if (window.Simulator && typeof window.Simulator.stop === 'function') { window.Simulator.stop(); return 'Simulator band kar diya.'; }
          return 'Simulator available nahi hai.';
        } catch (e) { return 'Simulator stop me dikkat: ' + e.message; }
      }
      var simOn = (window.Simulator && typeof window.Simulator.isRunning === 'function') ? window.Simulator.isRunning() : false;
      return 'Simulator abhi ' + (simOn ? 'RUNNING' : 'OFF') + ' hai. "simulator on" / "simulator off" bol sakte ho.';
    }

    /* stop everything / stop engine / close trades */
    if (/(sab (band|stop)|stop all|band kar|rok do|close all|kill|engine (band|off|stop))/.test(t)) {
      var sk = astKeyFor(text);
      if (auto) { runAction('stopAll', { key: sk }); return null; }
      ask('AI Smart Trading (' + astLabel(sk) + ') ko band karke saare running strategies/trades stop kar doon?', 'stopAll', { key: sk });
      return null;
    }

    /* reset P&L */
    if (/(reset|clear|wipe|saaf).*(pnl|p&l|profit|trade)|pnl.*(reset|clear)/.test(t)) {
      var rk = astKeyFor(text);
      if (auto) { runAction('resetPnl', { key: rk }); return null; }
      ask('P&L reset karna hai (' + astLabel(rk) + ')? Ye saare closed trades / running positions ka pura record mita dega.', 'resetPnl', { key: rk });
      return null;
    }

    /* timeframe trading OR a question about the current timeframe */
    if (/(timeframe|time frame|tf\b|minute|min\b|hour\b|\bhr\b|\b1m\b|\b5m\b)/.test(t) || /(trade|trading|chalana|chalao|execute|karna).*(timeframe|minute|m pe|m me)/.test(t)) {
      var tfIsSet = parseTf(text) != null;
      if (!tfIsSet && /(kya|kaunsa|kaun ?sa|abhi|current|state|status|hai|hain)/.test(t)) {
        return timeframeStatusText(astKeyFor(text));
      }
      return timeframeText(text, auto, astKeyFor(text));
    }

    /* saved AST templates - list/count question OR run command. This must come
       BEFORE the generic strategy-run block, otherwise "template X chalao"
       would be searched for as a saved strategy name. */
    if (/(template|tpl)s?\b/.test(t)) {
      if (/(chalao|run|apply|start|use|execute|open)/.test(t)) return templateRunText(text);
      return templateListText(text);
    }

    /* send Auto Experiment results / strategies to paper */
    if (/(auto ?experiment|ae).*(paper|bhej|send)|(paper|bhej|send).*(auto ?experiment|ae)/.test(t)) {
      if (auto) { runAction('aeToPaper', { key: aeKeyFor() }); return null; }
      ask('Auto Experiment ke results abhi paper engine me bhej doon?', 'aeToPaper', { key: aeKeyFor() });
      return null;
    }

    /* P&L / performance / win rate (reset/stop/timeframe already handled above;
       this also skips when the message asks to RUN - so "run karke performance
       batao" first starts the run, then you ask for performance). When no
       specific engine is named we aggregate across ALL AI Smart paper engines -
       the engine the user thinks of may not be the currently-active one. */
    if (!/(run|chalao|start|execute|bhej)/.test(t) &&
        /(pnl|p&l|profit|loss|win rate|winrate|performance|kitna (bana|bnaya)|earn|today|aaj ka|fayda|close.*trade|result)/.test(t)) {
      if (/(overall|sab|total|poora|all)/.test(t) || !/(paper ?(trade|\d)|papertrade|pool|ntrader)/.test(t)) {
        return pnlAllText();
      }
      return pnlOneText(astKeyFor(text));
    }

    /* run strategy by name / category / top N */
    if (/(run|chalao|chalana|execute|start|paper me|paper trade me|bhejo|run kar)/.test(t) && haveName) {
      if (auto) { return execRunStrategyAsk(text); }
      var plan = planRunStrategy(text);
      if (plan.error) return plan.error;
      if (plan.ask) {
        ask('Ye karna hai:\n' + plan.ask + '\n\nConfirm karo?', 'runStrategy', plan.params);
        return null;
      }
      execRunStrategy(plan.params);
      return null;
    }

    /* what data / about feature - generic explanations */
    if (/(samjha|explain|batao.*(setting|option|feature)|ye (kya|kaise))/i.test(text)) {
      return helpText();
    }

    var libStats = savedStatsLine();
    return 'Mujhe ye command clear nahi hui. Kuch examples:\n' +
      '  • "Sab kya chal raha hai?"\n  • "Aaj ka P&L aur win rate batao"\n  • "NIFTY price kya hai?"\n  • "5 minute me trading karo"\n  • "Top 2 bullish strategy run karo"\n  • "Auto experiment results paper me bhejo"\n  • "Help"\n' +
      (libStats ? '\n' + libStats + '\n\nAgar P&L/data ki baat kar rahe the to "sab ka P&L batao" ya "sab kya chal raha hai" bolo - 0 dikhna matlab abhi us engine me koi closed trade nahi hai.' : '');
  }

  /* ------------------------------------------------------------ overview */
  function overviewText() {
    var out = ['Poore algo system ka live overview:', ''];
    var ast = astKeys();
    for (var i = 0; i < ast.length; i++) out.push(astStateLine(ast[i]));
    out.push('');
    var sim = (window.Simulator && typeof window.Simulator.isRunning === 'function') ? window.Simulator.isRunning() : false;
    out.push('Simulator: ' + (sim ? 'RUNNING' : 'OFF'));
    var aeKeys = (window.TabEngines && window.TabEngines.ae) ? Object.keys(window.TabEngines.ae) : [];
    if (aeKeys.length) out.push('Auto Experiment tabs: ' + aeKeys.length + ' (' + aeKeys.join(', ') + ')');
    var con = 'checking\u2026';
    try {
      fetch('/api/status').then(function (r) { return r.json(); }).then(function (d) {
        if (d) addMsg('ai', 'Dhan connection: ' + (d.connected ? 'connected (client ' + (d.client_id || '?') + ')' : 'NOT connected') + (d.auth_error ? ' | auth error: ' + d.auth_error : ''));
      }).catch(function () {});
    } catch (e) {}
    out.push('Dhan connection: ' + con + ' (update aane par batata hoon)');
    out.push('');
    out.push('Kisi engine ko control karna hai to bolo - jaise "Paper Trade ka P&L", "sab band kar do" (pehle confirm karunga), "5 minute me trading karo".');
    return out.join('\n');
  }

  /* ------------------------------------------------------------------- P&L */
  function pnlOneText(key) {
    var st = engineState(key);
    var eng = astEng(key);
    if (!st) return 'Engine state read nahi ho paya.';
    var s = astSummary(key, st, eng);
    var out = [];
    out.push('AI Smart Trading — ' + s.label);
    out.push('  Mode: ' + s.mode);
    out.push('  Running strategies: ' + s.running + '   Open positions: ' + s.open);
    out.push('  Realized P&L (after charges): ' + inr(s.realized));
    out.push('  Charges paid: ' + inr(s.charges));
    out.push('  Closed trades: ' + s.count + '   Wins: ' + s.wins);
    out.push('  Win rate: ' + (s.winRate == null ? 'n/a (koi closed trade nahi)' : pct(s.winRate)));
    if (s.open && s.openPnl != null) out.push('  Open (unrealized) P&L: ' + inr(s.openPnl));
    out.push('');
    if (!s.count && !s.open && !s.running) {
      out.push('Note: is engine me abhi koi closed trade ya open position nahi hai, isliye P&L ₹0 dikh raha hai. Pehle strategy run karo, phir kuch der baad "performance batao" poochho.');
    } else {
      out.push('Note: P&L per engine hai. Koi engine naam nahi diya to main saare engines ka aggregate dikhata hoon - "sab ka P&L" bolo.');
    }
    return out.join('\n');
  }
  function pnlAllText() {
    var out = ['Saare AI Smart paper engines ka P&L:', ''];
    var keys = astKeys();
    var totReal = 0, totWins = 0, totCount = 0, any = false;
    keys.forEach(function (k) {
      var st = engineState(k);
      if (!st) return;
      var s = astSummary(k, st, astEng(k));
      var openTxt = (s.open && s.openPnl != null) ? (', open P&L ' + inr(s.openPnl)) : (s.open ? ', open P&L n/a' : '');
      out.push(s.label + ': realized ' + inr(s.realized) +
        ' | closed ' + s.count + ', wins ' + s.wins +
        ' | Win rate: ' + (s.winRate == null ? 'n/a' : pct(s.winRate)) +
        ' | open ' + s.open + openTxt);
      totReal += s.realized; totWins += s.wins; totCount += s.count; any = true;
    });
    if (!any) out.push('Koi state nahi mili.');
    out.push('');
    out.push('Total realized (saare paper engines): ' + inr(totReal) + ' across ' + totCount + ' closed trades, ' + totWins + ' wins.');
    if (!totCount) {
      out.push('');
      out.push('Abhi kisi bhi engine me koi closed trade record nahi hai - isliye total ₹0. Koi strategy run karke kuch der baad dobara poochho, ya "kya chal raha hai" bolo.');
    }
    return out.join('\n');
  }

  /* ---------------------------------------------------------------- market */
  function marketText(text) {
    var out = [];
    var m = /(nifty|bank ?nifty|sensex|gift ?nifty|nifty 50)/i.exec(text);
    if (/market (khula|open|closed|band)/.test(text.toLowerCase()) || /khula hai/.test(text.toLowerCase())) {
      var d = new Date();
      var day = d.getDay();
      var hh = d.getHours() + d.getMinutes() / 60;
      var week = day >= 1 && day <= 5;
      var open = week && hh >= 9.25 && hh <= 15.4;
      out.push('Aaj: ' + d.toDateString() + ' | time ' + d.toLocaleTimeString('en-IN'));
      out.push(week ? 'Weekday (Mon-Fri).' : 'Weekend - market band.');
      out.push(open ? 'Market KHULA hai (9:15-15:30 IST).' : (week ? 'Market abhi band hai (trading hours 9:15-15:30).' : ''));
      out.push('Agar live feed nahi hai to Simulator chala kar engines test kar sakte ho.');
      return out.join('\n');
    }
    if (/(nifty|banknifty|sensex|gift|index|price|ltp|quote)/i.test(text)) {
      out.push('Live index quotes (agar live feed hai):');
      out.push('  ' + quoteLine('NIFTY 50', 13));
      out.push('  ' + quoteLine('GIFT NIFTY', 5024));
      out.push('');
      out.push('Kisi option/stock ka price sirf symbol se nikalna is build me seedha supported nahi - option chain / chart tab me dekh sakte ho, ya mujhse engine status/P&L puchho.');
      return out.join('\n');
    }
    return 'Market data ke liye batao - jaise "NIFTY ka price kya hai?" ya "market khula hai?"';
  }

  /* ------------------------------------------------------------- timeframe */
  function timeframeText(text, auto, key) {
    var tf = parseTf(text);
    var eng = astEng(key);
    if (!eng) return 'AI Smart engine instance nahi mila (' + key + ').';
    if (!tf) {
      return 'Engine ke trading timeframe options: 1 minute, 5 minute, ya dono (1min+5min, "both").\n' +
        'Jaise bolo: "5 minute me trading karo", "1 min only", "dono timeframes chalao".\n' +
        'Strategies apna khud ka saved timeframe bhi use kar sakti hain agar "Use AST settings" band hai.';
    }
    /* 1) force AST universal timeframe checkboxes (drives every strategy entry eval) */
    var c1 = astEl(key, 'astTf1min'), c5 = astEl(key, 'astTf5min');
    var useOwn = astEl(key, 'astUseOwnSettings');
    try {
      if (tf === 'both') {
        if (c1) c1.checked = true;
        if (c5) c5.checked = true;
      } else if (tf === '1min') {
        if (c1) c1.checked = true;
        if (c5) c5.checked = false;
      } else {
        if (c1) c1.checked = false;
        if (c5) c5.checked = true;
      }
      if (useOwn) useOwn.checked = true;
      if (typeof eng.onUniversalInput === 'function') eng.onUniversalInput();
      if (typeof eng.setNiftyTf === 'function') eng.setNiftyTf(tf);
    } catch (e) {
      return 'Timeframe set karte waqt dikkat: ' + e.message;
    }
    return 'OK - ' + astLabel(key) + ' engine ab ' +
      (tf === 'both' ? 'DONO (1min + 5min)' : tf) +
      ' par trade decisions karega.\n' +
      '(1) Universal timeframe checkboxes -> ' + (tf === 'both' ? '1min + 5min both ON' : tf + ' only') +
      '\n(2) NIFTY ensemble trend timeframe -> ' + tf + '\n(3) "Use AST settings" ON kar diya taaki sab strategies isi timeframe par chale.\n\n' +
      'Ab strategy run karni hai to bolo - jaise "top 3 bullish run karo".';
  }
  function parseTf(text) {
    var t = ' ' + String(text).toLowerCase() + ' ';
    var has = function (re) { return re.test(t); };
    var oneMin = has(/1[ ]*min|1m[^a-z]|\b1 min\b|1 minute/);
    var fiveMin = has(/5[ ]*min|5m[^a-z]|\b5 min\b|5 minute/);
    if (has(/both|dono|combine|1 and 5|1 aur 5|1min.{0,8}5min|5min.{0,8}1min/)) return 'both';
    if (oneMin && fiveMin) return 'both';
    if (oneMin) return '1min';
    if (fiveMin) return '5min';
    if (has(/15[ ]*min|30[ ]*min|hour|\b1h\b|1 hour/)) return null;
    return null;
  }
  function timeframeStatusText(key) {
    var eng = astEng(key);
    if (!eng) return 'AI Smart engine instance nahi mila (' + key + ').';
    var st = engineState(key) || {};
    var tfEl = astEl(key, 'astNiftyTf');
    var ntf = tfEl ? (tfEl.value || '5min') : '5min';
    var c1 = astEl(key, 'astTf1min'), c5 = astEl(key, 'astTf5min');
    var u1 = !!(c1 && c1.checked), u5 = !!(c5 && c5.checked);
    var own = !!(astEl(key, 'astUseOwnSettings') && astEl(key, 'astUseOwnSettings').checked);
    var label = ntf === 'both' ? 'dono (1min + 5min)' : (ntf === '1min' ? '1 min' : '5 min');
    var universal = (u1 && u5) ? '1min + 5min both ON'
      : (u1 ? 'sirf 1min ON' : (u5 ? 'sirf 5min ON' : 'dono OFF'));
    return astLabel(key) + ' ka current trading setup:\n' +
      '  NIFTY ensemble trend timeframe: ' + label + '\n' +
      '  Universal timeframe checkboxes: ' + universal + '\n' +
      '  "Use AST settings" (sab strategies isi tf par): ' + (own ? 'ON' : 'OFF') +
      '\n\nBadalna ho to bolo - jaise "5 minute me trading karo", "1 min only", "dono timeframes chalao".';
  }

  /* -------------------------------------------------- run strategies (AST) */
  function pickMatches(text) {
    var saved = loadSavedStrats();
    var t = String(text);
    var matches = saved.slice();
    /* category */
    var bull = /bull|ce\b|long/.test(t);
    var bear = /bear|pe\b|short/.test(t);
    if (bull !== bear) {
      matches = matches.filter(function (s) { return bull ? s.cat !== 'bearish' : s.cat === 'bearish'; });
    }
    /* top N */
    var nm = /top[ ]*(\d+)|best[ ]*(\d+)|(\d+) (best|top)/i.exec(t);
    var N = nm ? clamp(parseInt(nm[1] || nm[2] || nm[3], 10) || 1, 1, 20) : null;
    if (N) {
      matches = matches.slice().sort(function (a, b) { return (b.score || 0) - (a.score || 0); }).slice(0, N);
    }
    /* explicit name tokens: split on non-alphanumerics and drop Hinglish/English
       "meta" words so "top 2 bullish" never tries to find a strategy literally
       named "bullish" (longest-word safe - no partial consumption) */
    var STOP = /^(run|runs|chalao|chalana|chalau|execute|start|paper|trade|trading|strategies|strategy|me|ko|karo|kar|karke|karne|karu|karta|karte|aur|please|bhej|bhejo|send|best|top|auto|bull|bear|bullish|bearish|long|short|ce|pe|on|abhi|aaj|se|ka|ki|ke|the|to|and|with|ye|wo|is|us|hai|hain|batao|do|dijiye|please|kya|ab|samay|paper2|paper3|paper4|paper5)$/;
    var tokens = String(text).toLowerCase().split(/[^a-z0-9]+/)
      .filter(function (w) { return w.length > 1 && !STOP.test(w); });
    var hadFilter = (bull !== bear) || !!N || tokens.length > 0;
    if (tokens.length) {
      var scored = matches.map(function (s) {
        var label = stratLabel(s).toLowerCase();
        var hay = ' ' + label + ' ' + String(s.key || '').toLowerCase() + ' ' + String(s.name || '').toLowerCase() + ' ';
        var score = 0;
        tokens.forEach(function (tk) {
          if (hay.indexOf(tk.toLowerCase()) >= 0) score += 1;
        });
        return { s: s, score: score };
      }).filter(function (x) { return x.score > 0; }).sort(function (a, b) { return b.score - a.score; });
      matches = scored.length ? scored.map(function (x) { return x.s; }) : [];
    } else if (!hadFilter) {
      matches = [];
    }
    return { list: matches.slice(0, 8), N: N };
  }

  function planRunStrategy(text) {
    var key = astKeyFor(text);
    var eng = astEng(key);
    if (!eng) return { error: 'Engine instance nahi mila.' };
    var m = pickMatches(text);
    var list = m.list;
    if (!list.length) {
      return { error: 'Mujhe is naav se koi saved strategy nahi mili. Main khud bana sakta hoon - bolo "pehle ek bearish strategy bana ke chalao" (ya bullish), ya Strategies tab me bana lo.\n\nAbhi saved hain:\n' + savedCountText() };
    }
    var params = { key: key, ids: list.map(function (s) { return String(s.id); }), names: list.map(stratLabel) };
    var preview = params.names.map(function (n) { return '  - ' + n; }).join('\n');
    return { params: params, ask: 'AI Smart (' + astLabel(key) + ') me ye ' + params.names.length + ' strategy(s) tick karke RUN (paper) kar doon?\n' + preview };
  }
  function execRunStrategyAsk(text) {
    var p = planRunStrategy(text);
    if (p.error) return p.error;
    execRunStrategy(p.params);
    return null;
  }
  function execRunStrategy(params) {
    var key = params.key || 'papertrade';
    var eng = astEng(key);
    if (!eng) { addMsg('ai', 'Engine nahi mila.'); return; }
    try {
      revealTabFor(key);
      var ticked = 0;
      (params.ids || []).forEach(function (id) {
        if (typeof eng.onStrategyCheck === 'function') {
          eng.onStrategyCheck(id, true);
          ticked++;
        }
      });
      if (typeof eng.onUniversalInput === 'function') eng.onUniversalInput();
      if (typeof eng.runPaper === 'function') eng.runPaper();
      addMsg('ai', 'Done! ' + astLabel(key) + ' engine par ' + ticked + ' strategy(s) tick ki aur Run Paper Trading start kar diya.\n\n' +
        'Running rows Paper Trade tab me dikhengi. Kuch der baad bolna - "ab performance batao" - to closed P&L/win rate report kar doon.');
    } catch (e) {
      addMsg('ai', 'Run karne me dikkat: ' + e.message);
    }
  }
  function savedCountText() {
    var saved = loadSavedStrats();
    if (!saved.length) return '  (koi saved strategy nahi)';
    var bull = saved.filter(function (s) { return s.cat !== 'bearish'; }).length;
    return '  Bullish: ' + bull + ', Bearish: ' + (saved.length - bull) + '.';
  }
  function savedStatsLine() {
    var out = [];
    try {
      var saved = loadSavedStrats();
      var bull = saved.filter(function (s) { return s.cat !== 'bearish'; }).length;
      out.push('Saved strategies: ' + saved.length + ' (' + bull + ' bull / ' + (saved.length - bull) + ' bear)');
    } catch (e) {}
    try {
      var keys = astKeys();
      var total = 0;
      keys.forEach(function (k) {
        var eng = astEng(k);
        if (eng && typeof eng.getTemplates === 'function') {
          try { total += (eng.getTemplates() || []).length; } catch (e2) {}
        }
      });
      out.push('AST saved templates: ' + total);
    } catch (e) {}
    return out.length ? out.join('  |  ') : '';
  }

  /* ---------------------------------------------------- AE results to paper */
  function aeKeyFor() {
    var active = window._aeActiveEngine || 'autoexperiment';
    if (window.TabEngines && window.TabEngines.ae && window.TabEngines.ae[active]) return active;
    return 'autoexperiment';
  }
  function execAeToPaper(params) {
    try {
      var ae = null;
      if (window.TabEngines && window.TabEngines.ae && window.TabEngines.ae[params.key || 'autoexperiment']) {
        ae = window.TabEngines.ae[params.key || 'autoexperiment'];
      } else ae = window.AutoExperiment;
      if (!ae || typeof ae.sendToPaper !== 'function') {
        addMsg('ai', 'AutoExperiment.sendToPaper available nahi hai - Auto Experiment tab me jake results ko Paper me send kar sakte ho.');
        return;
      }
      var res = ae.sendToPaper();
      addMsg('ai', 'Auto Experiment results Paper engine me bhej diye.\n' + (res ? String(typeof res === 'string' ? res : (res.message || '')) : '') + '\n\nAb "performance batao" bolna to dekhte hain results.');
    } catch (e) {
      addMsg('ai', 'AE -> Paper bhejte waqt dikkat: ' + e.message);
    }
  }

  /* ----------------------------------------------------- AST template quick */
  function templateListText(text) {
    var out = [];
    var keys = astKeys();
    var any = false, total = 0;
    keys.forEach(function (k) {
      var eng = astEng(k);
      if (!eng || typeof eng.getTemplates !== 'function') return;
      var tpls;
      try { tpls = eng.getTemplates() || []; } catch (e) { tpls = []; }
      if (!tpls.length) return;
      any = true;
      total += tpls.length;
      out.push(astLabel(k) + ' (' + tpls.length + '):');
      tpls.forEach(function (x) {
        out.push('  - ' + (x.name || x.id) + ((x.mode) ? '  [' + x.mode + ']' : ''));
      });
    });
    if (!any) {
      return 'Koi saved AST template nahi mila. AI Smart Template bar me apni settings "Save" karke naam do,\n' +
        'phir yahan bolo - "template <naam> chalao".\n\n' +
        'Ya fir seedha strategies ke saath kaam karo - "top 2 bullish run karo" bol kar dekho.';
    }
    var first = 'AST me total ' + total + ' saved template(s) hain:';
    out.unshift(first);
    out.push('');
    out.push('Kisi ko apply/run karna hai to bolo - "template <naam> chalao".');
    return out.join('\n');
  }
  function templateRunText(text) {
    var eng = astEng(astKeyFor(text));
    if (!eng || typeof eng.getTemplates !== 'function') return 'Is engine par template support nahi hai.';
    var tpls;
    try { tpls = eng.getTemplates() || []; } catch (e) { tpls = []; }
    if (!tpls.length) return 'Koi saved AST template nahi. AI Smart Template bar me settings save karke phir bolna - "template X chalao".';
    var want = String(text).toLowerCase().replace(/template|tpl|chalao|run|apply|start|use/gi, '').trim();
    var hit = null;
    if (want) {
      tpls.forEach(function (x) {
        if (!hit && (x.name || '').toLowerCase().indexOf(want) >= 0) hit = x;
      });
    }
    if (!hit) {
      return 'Saved AST templates:\n' + tpls.map(function (x) { return '  - ' + (x.name || x.id) + ' (' + (x.mode || '') + ')'; }).join('\n') +
        '\n\nBolo - "template <naam> chalao".';
    }
    try {
      var res = eng.runTemplateById(hit.id) || eng.runTemplateById(hit.sourceId) || null;
      return 'Template "' + hit.name + '" ' + (hit.mode || '') + ' apply kar diya aur run start kar diya.\n' +
        (res && res.restored ? res.restored + ' strategy(s) template se restore hui.\n' : '') +
        'Ab "performance batao" bolna.';
    } catch (e) {
      return 'Template run me dikkat: ' + e.message;
    }
  }

  /* ------------------------------------------------------------ chat input */
  function send(text) {
    if (!text) return;
    addMsg('user', text);
    if (pending) {
      /* pending confirmation is open: honour a typed yes/no answer first */
      if (/\b(haan|hann|haa?|yes|ya|yeah|yep|karo|kar do|ok|okay|theek|confirm|go ahead|sure|ji haan)\b/i.test(text)) {
        var p = pending; pending = null; renderMsgs();
        if (p.type === 'llmAction') { execLlmAction(p.params.type, p.params.params); if (llm.enabled) { llm.msgs.push({ role: 'user', content: '[User confirmed action] ' + p.params.type }); trimMsgs(); } }
        else runAction(p.type, p.params);
        return;
      }
      if (/\b(nahi|naheen|no|nope|cancel|band karo|mat karo|ruko|rhet|nahi karna)\b/i.test(text)) {
        pending = null;
        renderMsgs();
        addMsg('ai', 'OK - cancel kar diya.');
        return;
      }
      pending = null;
    }
    if (llm.enabled) { llmChat(text); return; }
    var reply;
    try {
      reply = think(text);
    } catch (e) {
      reply = 'Brain me error aaya: ' + e.message;
    }
    if (reply) addMsg('ai', reply);
  }
  function sendFromInput() {
    var inp = els.input;
    var v = (inp && inp.value || '').trim();
    if (!v) return;
    inp.value = '';
    send(v);
    syncHeight();
  }

  /* -------------------------------------------------------- LLM backend */
  function setModePill(state, model) {
    var pill = $('aibModePill');
    if (!pill) return;
    if (state === 'llm') {
      pill.textContent = 'GPT ON \u00B7 ' + (model || 'llm');
      pill.className = 'aib-pill on';
      pill.title = 'AI chat LLM se connected hai (server-side key).';
    } else if (state === 'busy') {
      pill.textContent = 'soch raha hain\u2026';
      pill.className = 'aib-pill';
      pill.title = '';
    } else if (state === 'offline') {
      pill.textContent = 'offline brain';
      pill.className = 'aib-pill';
      pill.title = 'LLM key configured nahi hai - offline intent brain active.';
    } else {
      pill.textContent = '\u2026';
      pill.className = 'aib-pill';
    }
  }
  function setBusy(on) {
    llm.busy = on;
    if (!els.send || !els.input) return;
    els.send.disabled = on;
    els.send.textContent = on ? '...' : 'Send';
    if (on) els.input.setAttribute('placeholder', 'Brain soch raha hai\u2026');
    else els.input.setAttribute('placeholder', 'Yahan likho... jaise: aaj ka P&L batao / 5 minute me trading karo / top 3 bullish run karo');
    if (on) setModePill('busy'); else updatePillFromCfg();
  }
  function updatePillFromCfg() {
    setModePill(llm.enabled ? 'llm' : 'offline', llm.model);
  }
  function fetchBrainConfig() {
    try {
      fetch('/api/brain/config', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d && d.enabled) {
            llm.enabled = true;
            llm.model = d.model || '';
            llm.msgs = [];
            seedLlmHistory();
          } else {
            llm.enabled = false;
            llm.model = '';
            llm.msgs = [];
          }
          updatePillFromCfg();
        })
        .catch(function () { updatePillFromCfg(); });
    } catch (e) { updatePillFromCfg(); }
  }
  function seedLlmHistory() {
    var list = store();
    var out = [];
    for (var i = Math.max(0, list.length - 12); i < list.length; i++) {
      var m = list[i];
      if (!m) continue;
      if (m.r === 'user') out.push({ role: 'user', content: m.t });
      else if (m.r === 'ai') out.push({ role: 'assistant', content: m.t });
    }
    llm.msgs = out.slice(-20);
  }
  function chartStateText() {
    var out = 'Chart: ';
    try {
      var name = (typeof selectedSymbol !== 'undefined' && selectedSymbol && selectedSymbol.name) ? selectedSymbol.name : 'none';
      var tf = (typeof chartTf !== 'undefined') ? chartTf : '?';
      var has = (window.IndChart && typeof window.IndChart.hasChart === 'function') ? window.IndChart.hasChart() : false;
      out += 'symbol=' + name + ', tf=' + tf + ', hasChart=' + (has ? 'yes' : 'no');
      if (window.IndChart && typeof window.IndChart.getIndicators === 'function') {
        var inds = [];
        try { inds = window.IndChart.getIndicators() || []; } catch (e) {}
        var parts = inds.map(function (i) {
          var s = i.settings || {};
          var len = s.length != null ? ' len=' + s.length : '';
          return i.id + '(' + (s.source || 'close') + len + ')';
        });
        out += ', indicators=[' + parts.join(', ') + ']';
      }
    } catch (e) { out += 'error'; }
    return out;
  }
  /* -------- chart UI tools (what the LLM's kind=ui can drive) -------- */
  var UI_IND_ALIAS = {
    ema: 'ema', ema9: 'ema', exponential: 'ema',
    ma: 'ma', sma: 'ma', moving: 'ma', simple: 'ma',
    smma: 'smma', smoothed: 'smma',
    bollinger: 'bb', bb: 'bb', bollingerband: 'bb', bollingerbands: 'bb',
    supertrend: 'supertrend',
    vwap: 'vwap',
    rsi: 'rsi',
    macd: 'macd',
    atr: 'atr',
    adx: 'adx',
    obv: 'obv',
    ao: 'ao', awesome: 'ao'
  };
  function clampInt(v, lo, hi) {
    v = parseInt(v, 10);
    if (isNaN(v)) return lo;
    return Math.max(lo, Math.min(hi, v));
  }
  function uiFindSymbol(name) {
    var q = String(name || '').toLowerCase().trim();
    if (!q) return null;
    var sel = document.getElementById('symbolSelect');
    if (!sel) return null;
    var best = null, bestScore = -1;
    for (var i = 0; i < sel.options.length; i++) {
      var o = sel.options[i];
      var nm = ((o.getAttribute && o.getAttribute('data-symbol-name')) || o.textContent || '');
      nm = String(nm).split('  ')[0].trim();
      var hay = nm.toLowerCase();
      var score = -1;
      if (hay === q) score = 3;
      else if (hay.indexOf(q) === 0) score = 2;
      else if (hay.indexOf(q) > 0) score = 1;
      if (score > bestScore) { bestScore = score; best = { name: nm, value: o.value }; }
    }
    return bestScore >= 1 ? best : null;
  }
  function uiTfValid(tf) {
    if (typeof TF_LIST === 'undefined') return true;
    return TF_LIST.some(function (t) { return t[0] === tf; });
  }
  function execUiOpenChart(params) {
    var name = String(params.symbol || params.name || '').trim();
    var tf = String(params.tf || '').trim();
    if (!name) return 'Konsa symbol kholna hai? Jaise "NIFTY 50", "BANK NIFTY", "RELIANCE", "TCS".';
    var match = uiFindSymbol(name);
    if (!match) {
      return '"' + name + '" left sidebar list me nahi mila. Try karo: NIFTY 50, BANK NIFTY, SENSEX, FINNIFTY, ya koi stock (RELIANCE, TCS, HDFCBANK).';
    }
    try {
      var sel = document.getElementById('symbolSelect');
      if (!sel) return 'Chart symbol list ready nahi hai - thoda wait karke phir bolo.';
      sel.value = match.value;
      var tfOk = tf && uiTfValid(tf);
      if (tfOk && typeof setChartTf === 'function') setChartTf(tf);
      if (typeof onSymbolChange === 'function') onSymbolChange();
      if (typeof switchTab === 'function') { try { switchTab('chart'); } catch (e) {} }
      return '"' + match.name + '" ka chart khol diya' + (tfOk ? ' (' + tf + ')' : '') + '.';
    } catch (e) { return 'Chart kholne me dikkat aayi: ' + e.message; }
  }
  function execUiAddIndicator(params) {
    var IC = window.IndChart;
    if (!IC || typeof IC.addIndicator !== 'function' || !IC.IND) {
      return 'Chart engine abhi ready nahi hai. Pehle koi symbol kholo, phir indicator laga sakta hoon.';
    }
    var raw = String(params.ind || params.id || '').toLowerCase().trim();
    var key = UI_IND_ALIAS[raw] || raw;
    if (!IC.IND[key]) {
      return 'Indicator "' + raw + '" support nahi karta. Allowed: ema, ma, smma, bb, supertrend, vwap, rsi, macd, atr, adx, obv, ao.';
    }
    var want = {};
    ['length', 'source', 'color', 'lineWidth'].forEach(function (k) {
      if (params[k] !== undefined && params[k] !== null) want[k] = params[k];
    });
    if (want.length !== undefined) want.length = clampInt(want.length, 1, 500);
    var label = IC.IND[key].name;
    if (key === 'ema') label = 'EMA';
    if (want.length !== undefined) label += '-' + want.length;
    try {
      var existing = [];
      if (typeof IC.getIndicators === 'function') existing = IC.getIndicators() || [];
      var same = existing.filter(function (i) {
        if (i.id !== key) return false;
        if (want.length === undefined) return true;
        var sl = (i.settings && i.settings.length);
        return sl === undefined || sl === want.length;
      });
      if (same.length) {
        return label + ' chart par pehle se laga hua hai - dubara add nahi kiya.';
      }
      IC.addIndicator(key, want);
      return label + ' laga diya.';
    } catch (e) { return label + ' lagane me dikkat: ' + e.message; }
  }
  function execUiRemoveIndicator(params) {
    var IC = window.IndChart;
    if (!IC || typeof IC.removeIndicator !== 'function') {
      return 'Chart engine ready nahi hai.';
    }
    try {
      if (params.all) { if (typeof IC.removeAll === 'function') IC.removeAll(); return 'Chart ke saare indicators hata diye.'; }
      var raw = String(params.ind || params.id || '').toLowerCase().trim();
      var key = UI_IND_ALIAS[raw] || raw;
      if (typeof IC.removeAllOf === 'function') {
        var n = IC.removeAllOf(key);
        if (!n) {
          var hasKey = key === 'ema' || key === 'ma' || key === 'bb' || key === 'rsi' || key === 'macd' || key === 'atr' || key === 'adx' || key === 'obv' || key === 'ao' || key === 'vwap' || key === 'supertrend' || key === 'smma';
          return hasKey ? 'Chart par "' + raw + '" ka koi indicator laga hi nahi tha.' : 'Indicator "' + raw + '" support nahi karta.';
        }
        return (key === 'ema' ? 'EMA' : raw) + ' ke ' + n + ' instance hata diye.';
      }
      return 'Remove support is version me nahi hai - "saare indicators hata do" bolo.';
    } catch (e) { return 'Indicator hatane me dikkat: ' + e.message; }
  }
  /* ------------------------------------------------- tab / engine tools */
  function aeEng(key) {
    if (!key) key = aeKeyFor('');
    if (window.TabEngines && window.TabEngines.ae && window.TabEngines.ae[key]) return window.TabEngines.ae[key];
    return window.AutoExperiment || null;
  }
  function astTemplates(eng) {
    try { return (eng && typeof eng.getTemplates === 'function') ? (eng.getTemplates() || []) : []; }
    catch (e) { return []; }
  }
  function astTplLabel(t) { return String((t && t.name) || '').replace(/\s*\[AST\]\s*$/i, '').trim(); }
  function filterCounts(key) {
    var s = suffixFor(key);
    var bull = 0, bear = 0;
    try {
      var all = document.querySelectorAll('input[type=checkbox]');
      for (var i = 0; i < all.length; i++) {
        var id = all[i].id || '';
        if (id.indexOf('astFilter') !== 0) continue;
        if (s && id.slice(-s.length) !== s) continue;
        if (!all[i].checked) continue;
        if (/Bull/i.test(id)) bull++;
        else if (/Bear/i.test(id)) bear++;
      }
    } catch (e) {}
    return { bull: bull, bear: bear };
  }
  function runningNames(eng) {
    try {
      var r = (typeof eng.runningStrategies === 'function') ? (eng.runningStrategies() || []) : [];
      return r.slice(0, 20).map(function (s2) {
        var nm = s2.name || s2.title || s2.key || '';
        var cat = s2.cat === 'bearish' ? 'BEAR' : 'BULL';
        var sym = (s2.symbol && s2.symbol.name) ? (' on ' + s2.symbol.name) : '';
        return nm + ' ' + cat + sym;
      });
    } catch (e) { return []; }
  }
  function astEngineText(key) {
    var eng = astEng(key);
    var out = [astStateLine(key)];
    var st = engineState(key);
    var f = filterCounts(key);
    out.push('  indicator-filters selected: bullish ' + f.bull + ', bearish ' + f.bear);
    try {
      if (st) out.push('  aiPick=' + (st.aiPick ? 'ON' : 'off') + ', filterMode=' + (st.filterMode === true ? 'ON' : 'off') +
        ', runIntent=' + ((st.runIntent && st.runIntent.active) ? 'active' : 'idle') + ', enabled=' + (st.enabled ? 'ON' : 'OFF'));
    } catch (e) {}
    var rn = runningNames(eng);
    if (rn.length) out.push('  running: ' + rn.join(' | '));
    else out.push('  running: (koi strategy running nahi)');
    var tl = astTemplates(eng).map(astTplLabel);
    if (tl.length) out.push('  saved templates: ' + tl.slice(0, 10).join(', ') + (tl.length > 10 ? ' (+' + (tl.length - 10) + ' more)' : ''));
    else out.push('  saved templates: (koi nahi)');
    return out.join('\n');
  }
  function astEngineBrief(key) {
    var eng = astEng(key);
    var st = engineState(key);
    var f = filterCounts(key);
    var tpls = astTemplates(eng).map(astTplLabel);
    var tf = '5min';
    var tfEl = astEl(key, 'astNiftyTf');
    if (tfEl) tf = tfEl.value || tf;
    return astLabel(key) + ': ' + ((st && st.enabled) ? 'enabled' : 'OFF') +
      ', tf=' + tf + ', filterBull=' + f.bull + ', filterBear=' + f.bear +
      ', templates=' + (tpls.length ? '[' + tpls.slice(0, 6).join(', ') + (tpls.length > 6 ? ', ...' : '') + ']' : 'none');
  }
  function aeFlags(key) {
    var eng = aeEng(key);
    var out = [];
    try {
      if (eng && typeof eng.getState === 'function') {
        var st = eng.getState() || {};
        out.push('enabled=' + (st.enabled ? 'ON' : 'off'));
        if (st.liveMarket !== undefined) out.push('liveMarket=' + (st.liveMarket ? 'ON' : 'off'));
        if (st.allInOne !== undefined) out.push('allInOne=' + (st.allInOne ? 'ON' : 'off'));
        if (st.runManual !== undefined) out.push('runManual=' + (st.runManual ? 'ON' : 'off'));
        var res = st.results;
        if (Array.isArray(res)) out.push('results=' + res.length);
        var syms = st.symbols;
        if (Array.isArray(syms)) out.push('symbols=' + syms.length);
        if (Array.isArray(st.groups)) out.push('groups=' + st.groups.length);
      }
    } catch (e) {}
    ['aeLiveToggle', 'aeRunManualToggle', 'aeAllInOne'].forEach(function (id) {
      var el = $(id);
      if (el) out.push(id + '=' + (el.checked ? 'ON' : 'off'));
    });
    return out.join(', ');
  }
  function aeEngineText(key) {
    var panel = document.getElementById('tab-' + key);
    var lines = ['Auto Experiment engine "' + key + '": ' + (aeFlags(key) || '(no state)')];
    if (panel) {
      var txt = (panel.innerText || '').replace(/\u00a0/g, ' ').split('\n').map(function (l) { return l.replace(/\s+/g, ' ').trim(); }).filter(function (l) { return l; });
      if (txt.length) lines.push('Panel content:' + '\n' + txt.join('\n').slice(0, 3000));
    }
    return lines.join('\n');
  }
  function panelTextOf(id) {
    var el = document.getElementById('tab-' + id);
    if (!el) return null;
    var txt = (el.innerText || '');
    txt = txt.replace(/\u00a0/g, ' ').split('\n').map(function (l) { return l.replace(/\s+/g, ' ').trim(); }).filter(function (l) { return l; }).join('\n');
    if (txt.length > 3500) txt = txt.slice(0, 3500) + '\n...(content truncated, itna hi readable hai)';
    return txt;
  }
  function execUiOpenTab(params) {
    var raw = String(params.tab || params.id || params.engine || '').trim();
    var map = {
      'chart': 'chart', 'candlestick chart': 'chart', 'candlestick': 'chart', 'charts': 'chart',
      'optionchain': 'optionchain', 'option chain': 'optionchain',
      'strategies': 'strategies', 'monitor': 'monitor', 'strategy monitor': 'monitor',
      'papertrade': 'papertrade', 'paper trade': 'papertrade',
      'tradestats': 'tradestats', 'trade stats': 'tradestats',
      'account': 'account', 'autoexperiment': 'autoexperiment', 'auto experiment': 'autoexperiment',
      'indextrend': 'indextrend', 'index trend': 'indextrend',
      'smartntrader': 'smartntrader', 'ntrader': 'smartntrader',
      'simulator': 'simulator', 'backup': 'backup', 'backup & restore': 'backup'
    };
    var target = map[String(raw).toLowerCase()] || raw;
    var exists = document.querySelector('.tab-btn[data-tab="' + target + '"]') || document.getElementById('tab-' + target);
    if (!exists && window.TabEngines) {
      var inAst = (window.TabEngines.aismart && window.TabEngines.aismart[target]);
      var inAe = (window.TabEngines.ae && window.TabEngines.ae[target]);
      if (!inAst && !inAe) {
        return 'Tab "' + raw + '" nahi mila. Available: chart, optionchain, strategies, monitor, papertrade, tradestats, account, autoexperiment, indextrend, smartntrader, simulator, backup (ya koi paper/ae tab key jaise paper2).';
      }
    }
    try {
      if (typeof switchTab === 'function') switchTab(target);
      return 'Tab "' + target + '" khol diya - ab wahan ka state dekh sakta hoon.';
    } catch (e) { return 'Tab open karne me dikkat: ' + e.message; }
  }
  function execUiReadTab(params) {
    var raw = String(params.tab || params.id || params.engine || '').trim().toLowerCase();
    if (!raw) return 'Konsi tab/engine read karni hai? engine: papertrade/paper2/autoexperiment, ya tab: backup/account/tradestats/autoexperiment/simulator etc.';
    var body = [];
    if (window.TabEngines) {
      if (window.TabEngines.aismart && window.TabEngines.aismart[raw]) body.push(astEngineText(raw));
      if (window.TabEngines.ae && window.TabEngines.ae[raw]) body.push(aeEngineText(raw));
    }
    if (raw === 'chart' || raw === 'candlestick') body.push(chartStateText());
    if (raw === 'papertrade' || raw === 'paper trade' || raw === 'all' || raw === 'overview') {
      var ks = astKeys();
      for (var i = 0; i < ks.length; i++) body.push(astEngineText(ks[i]));
      var aeKs = (window.TabEngines && window.TabEngines.ae) ? Object.keys(window.TabEngines.ae) : [];
      for (var j = 0; j < aeKs.length; j++) body.push(aeEngineText(aeKs[j]));
    }
    var map = {
      'option chain': 'optionchain', 'strategy monitor': 'monitor', 'trade stats': 'tradestats',
      'auto experiment': 'autoexperiment', 'index trend': 'indextrend'
    };
    if (map[raw]) raw = map[raw];
    if (raw === 'simulator') {
      var simOn = (window.Simulator && typeof window.Simulator.isRunning === 'function') ? window.Simulator.isRunning() : false;
      body.push('Simulator: ' + (simOn ? 'RUNNING' : 'OFF'));
    }
    var panel = panelTextOf(raw);
    if (panel) body.push(panel);
    if (!body.length) return '"' + raw + '" ka koi readable state nahi mila. Engine keys (papertrade/paper2/autoexperiment) ya tab ids (backup, account, tradestats, autoexperiment, simulator, chart) bhejo.';
    return body.join('\n\n');
  }
  function execLlmUi(op, params) {
    try {
      if (op === 'open_chart') return execUiOpenChart(params || {});
      if (op === 'add_indicator') return execUiAddIndicator(params || {});
      if (op === 'remove_indicator') return execUiRemoveIndicator(params || {});
      if (op === 'open_tab') return execUiOpenTab(params || {});
      if (op === 'read_tab') return execUiReadTab(params || {});
    } catch (e) { return 'UI kaam me error: ' + e.message; }
    return 'Unknown ui op: ' + op;
  }
  function buildSnapshot() {
    var L = [];
    L.push('Active engine: ' + (window._paperActiveEngine || 'papertrade'));
    L.push('Brain overlay: ' + (prefs().overlay ? 'ON' : 'OFF'));
    L.push(chartStateText());
    var sim = (window.Simulator && typeof window.Simulator.isRunning === 'function') ? window.Simulator.isRunning() : false;
    L.push('Simulator: ' + (sim ? 'RUNNING' : 'OFF'));
    var keys = astKeys();
    L.push('AI Smart engines (' + keys.length + ') - engine key par hi action target karo:');
    keys.forEach(function (k) {
      try {
        var st = engineState(k);
        var s = astSummary(k, st, astEng(k));
        var eng = astEng(k);
        var tpls = astTemplates(eng).map(astTplLabel);
        var f = filterCounts(k);
        L.push('  - ' + s.label + ' (key=' + k + '): ' + s.mode + ', tf=' + astEngineTf(k) + ', running=' + s.running +
          ', open=' + s.open + ', realized P&L=' + s.realized + ', winRate=' + (s.winRate == null ? 'n/a' : s.winRate.toFixed(1) + '%') +
          ', filters bull=' + f.bull + ' bear=' + f.bear +
          ', templates=' + (tpls.length ? '[' + tpls.slice(0, 8).join(', ') + (tpls.length > 8 ? ', ...' : '') + ']' : 'none'));
      } catch (e) {}
    });
    var aeKeys = (window.TabEngines && window.TabEngines.ae) ? Object.keys(window.TabEngines.ae) : [];
    L.push('Auto Experiment tabs: ' + aeKeys.length + (aeKeys.length ? ' - key par hi target karo (' + aeKeys.join(', ') + ')' : ''));
    aeKeys.forEach(function (k) {
      L.push('  - ' + k + ': ' + (aeFlags(k) || '(no state)'));
    });
    try {
      var n = idxQuote('NIFTY 50', 13);
      var g = idxQuote('GIFT NIFTY', 5024);
      L.push('Quotes: NIFTY 50=' + (n == null ? 'no-tick' : n) + ', GIFT NIFTY=' + (g == null ? 'no-tick' : g));
    } catch (e) {}
    var saved = loadSavedStrats();
    L.push('Saved strategies: ' + saved.length);
    if (saved.length) {
      saved.slice(0, 60).forEach(function (s2) {
        L.push('  - ' + stratLabel(s2));
      });
      if (saved.length > 60) L.push('  ... and ' + (saved.length - 60) + ' more');
    }
    return L.join('\n');
  }
  function astEngineTf(k) {
    var tf = '5min';
    var tfEl = astEl(k, 'astNiftyTf');
    if (tfEl) tf = tfEl.value || tf;
    return tf;
  }
  function llmDataFor(topic) {
    try {
      if (topic === 'overview') return overviewText();
      if (topic === 'pnl_all') return pnlAllText();
      if (topic === 'pnl') return pnlOneText(astKeyFor(''));
      if (topic === 'templates_list') return templateListText('list');
      if (topic === 'strategies_list') {
        var out = ['Saved strategies:'];
        var saved = loadSavedStrats();
        if (!saved.length) out.push('  (koi nahi)');
        saved.slice(0, 60).forEach(function (s) { out.push('  - ' + stratLabel(s)); });
        return out.join('\n');
      }
      if (topic === 'tf_status') return timeframeStatusText(astKeyFor(''));
      if (topic === 'indices') return marketText('nifty gift indices');
    } catch (e) { return 'Data fetch me dikkat: ' + e.message; }
    return '';
  }
  function trimMsgs() {
    if (llm.msgs.length > 24) llm.msgs = llm.msgs.slice(-24);
  }
  function llmCall(messages) {
    return fetch('/api/brain/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: messages, snapshot: buildSnapshot() })
    }).then(function (r) { return r.json(); });
  }
  /* Handle a single model turn result. Returns nothing; side effects only. */
  function llmApplyTurn(d, round) {
    if (!d) { setBusy(false); return false; }
    if (d.enabled === false) {
      llm.enabled = false;
      llm.model = '';
      setBusy(false);
      updatePillFromCfg();
      addMsg('ai', 'LLM key ab configured nahi hai - main offline brain mode me aagaya. Jawab dene ke liye ek aur baar likho.');
      return false;
    }
    if (d.kind === 'reply') {
      var txt = String(d.text || '');
      if (txt) {
        llm.msgs.push({ role: 'assistant', content: txt });
        trimMsgs();
        addMsg('ai', txt);
      }
      setBusy(false);
      return true;
    }
    if (d.kind === 'ui') {
      var op = d.op;
      var uparams = d.params || {};
      if (!op) {
        setBusy(false);
        if (d.text) { llm.msgs.push({ role: 'assistant', content: d.text }); trimMsgs(); addMsg('ai', d.text); }
        return true;
      }
      if (round >= 5) {
        setBusy(false);
        if (d.text) { llm.msgs.push({ role: 'assistant', content: d.text }); trimMsgs(); addMsg('ai', d.text); }
        return true;
      }
      var res = execLlmUi(op, uparams);
      if (op === 'read_tab') {
        llm.msgs.push({ role: 'user', content: '[read_tab ' + (uparams.tab || uparams.id || uparams.engine || '') + ']\n' + res });
        trimMsgs();
      } else {
        llm.msgs.push({ role: 'assistant', content: res });
        trimMsgs();
        addMsg('ai', res);
      }
      var msgs2 = llm.msgs.slice();
      return llmCall(msgs2).then(function (d2) {
        llm.msgs.length = 0;
        llm.msgs.push.apply(llm.msgs, msgs2);
        return llmApplyTurn(d2, round + 1);
      }).catch(function (e) {
        setBusy(false);
        addMsg('ai', 'UI step ke baad LLM round-trip fail: ' + e.message);
        return true;
      });
    }
    if (d.kind === 'data') {
      var topic = d.topic;
      if (!topic || round >= 3) {
        setBusy(false);
        if (d.text) { llm.msgs.push({ role: 'assistant', content: d.text }); trimMsgs(); addMsg('ai', d.text); }
        return true;
      }
      var dataText = llmDataFor(topic);
      if (!dataText) dataText = '(no data)';
      llm.msgs.push({ role: 'assistant', content: 'Let me look that up (' + topic + ').' });
      llm.msgs.push({ role: 'user', content: 'Live data from the app:\n' + dataText + '\n\nNow answer the user naturally in their language using this data.' });
      trimMsgs();
      var msgs2 = llm.msgs.slice();
      return llmCall(msgs2).then(function (d2) {
        llm.msgs.length = 0;
        llm.msgs.push.apply(llm.msgs, msgs2.slice(0, -2));
        llm.msgs.push({ role: 'user', content: 'Live data from the app:\n' + dataText });
        return llmApplyTurn(d2, round + 1);
      }).catch(function (e) {
        setBusy(false);
        addMsg('ai', 'LLM round-trip fail: ' + e.message);
        return true;
      });
    }
    if (d.kind === 'action') {
      var a = d.action || {};
      var type = a.type;
      var params = a.params || {};
      if (!type) {
        setBusy(false);
        if (d.text) { llm.msgs.push({ role: 'assistant', content: d.text }); trimMsgs(); addMsg('ai', d.text); }
        return true;
      }
      if (llmIsSensitive(type) && !userSaidAuto(llm.lastUserText)) {
        var note = String(d.text || '') + '\n\nConfirm karo?';
        llm.msgs.push({ role: 'assistant', content: 'User ne action confirm karna hai.' });
        setBusy(false);
        pending = { type: 'llmAction', params: { type: type, params: params } };
        addMsg('ai', note);
        return true;
      }
      llmRunActionNow(type, params, d.text || '');
      if (round >= 5) return true;
      var msgs2 = llm.msgs.slice();
      setBusy(true);
      return llmCall(msgs2).then(function (d2) {
        llm.msgs.length = 0;
        llm.msgs.push.apply(llm.msgs, msgs2);
        return llmApplyTurn(d2, round + 1);
      }).catch(function (e) {
        setBusy(false);
        addMsg('ai', 'Action ke baad LLM round-trip fail: ' + e.message);
        return true;
      });
    }
    setBusy(false);
    if (d.text) { llm.msgs.push({ role: 'assistant', content: d.text }); trimMsgs(); addMsg('ai', d.text); }
    return true;
  }
  function llmIsSensitive(type) {
    return /^(stop_all|reset_pnl|run_strategies|ae_to_paper|run_ast_template|ae_run|ae_toggle|ae_experiment)$/.test(type || '');
  }
  function userSaidAuto(text) {
    return /(auto|bina puche|direct|seedha|without ask|turant|just do)/.test(String(text || '').toLowerCase());
  }
  function llmRunActionNow(type, params, note) {
    if (note) { llm.msgs.push({ role: 'assistant', content: note }); trimMsgs(); addMsg('ai', note); }
    execLlmAction(type, params);
    llm.msgs.push({ role: 'user', content: '[Action executed] ' + type + ' ' + JSON.stringify(params || {}) });
    trimMsgs();
    setBusy(false);
    return true;
  }
  function isAstKey(key) {
    if (!key) return false;
    if (/^(papertrade|pool|ntrader)$/.test(key)) return true;
    if (/^paper\d+$/.test(key)) return true;
    return !!(window.TabEngines && window.TabEngines.aismart && window.TabEngines.aismart[key]);
  }
  function execLlmAction(type, params) {
    params = params || {};
    var key = String(params.engine || params.key || '').replace(/^ast_|^paper_/, '');
    if (key && !isAstKey(key)) key = astKeyFor('');
    if (!key) key = astKeyFor('');
    if (type === 'stop_all') {
      if (userSaidAuto(llm.lastUserText)) { runAction('stopAll', { key: key }); }
      else { /* already confirmed */ runAction('stopAll', { key: key }); }
      return true;
    }
    if (type === 'reset_pnl') { runAction('resetPnl', { key: key }); return true; }
    if (type === 'ae_to_paper') { runAction('aeToPaper', { key: aeKeyFor() }); return true; }
    if (type === 'set_timeframe') {
      var tf = String(params.tf || '').toLowerCase();
      if (tf === '1min' || tf === '5min') setTfDirect(key, tf);
      else if (tf === 'both' || tf === 'dono') setTfDirect(key, 'both');
      else {
        var t2 = String(params.tf || '').toLowerCase();
        if (/1/.test(t2)) setTfDirect(key, '1min');
        else if (/5/.test(t2)) setTfDirect(key, '5min');
        else setTfDirect(key, '5min');
      }
      return true;
    }
    if (type === 'simulator') {
      try {
        var on = !!params.on;
        if (on && window.Simulator && typeof window.Simulator.start === 'function') { window.Simulator.start(); addMsg('ai', 'Simulator start kar diya.'); }
        else if (!on && window.Simulator && typeof window.Simulator.stop === 'function') { window.Simulator.stop(); addMsg('ai', 'Simulator band kar diya.'); }
        else addMsg('ai', 'Simulator available nahi hai.');
      } catch (e) { addMsg('ai', 'Simulator error: ' + e.message); }
      return true;
    }
    if (type === 'run_strategies') {
      var phrase = '';
      if (params.phrase) phrase = String(params.phrase);
      else if (Array.isArray(params.names) && params.names.length) phrase = params.names.join(' ');
      else if (params.top) {
        var topN = (params.top && typeof params.top === 'object') ? params.top : { n: params.top };
        phrase = 'top ' + (topN.n || 2);
        if (topN.side || topN.cat) phrase += ' ' + (topN.side || topN.cat);
      }
      phrase = String(phrase).trim();
      if (!phrase) {
        addMsg('ai', 'Run karne ke liye model ne koi exact strategy nahi di. Aisa bolo - "EMAswing aur TrendRider paper me chalao" ya "top 2 bullish run karo".');
        return true;
      }
      if (key && /^paper\d+$/.test(key)) phrase += ' ' + key;
      var first = planRunStrategy(phrase);
      var healedStrat = null;
      if (first && first.error) {
        var wantSide = pickBrainSide(String(llm.lastUserText || '') + ' ' + String(params.phrase || ''));
        if (wantSide) {
          var hb = brainBuildStrategy(wantSide, {});
          if (hb && !hb.error) { healedStrat = brainSaveStrategy(hb); addMsg('ai', '(Saved ' + (wantSide === 'bearish' ? 'bearish' : 'bullish') + ' strategy nahi thi, isliye default "' + healedStrat.name + '" bana li.)'); }
        }
      }
      if (userSaidAuto(llm.lastUserText)) { var r1 = execRunStrategyAsk(phrase); if (r1) addMsg('ai', r1); }
      else {
        var p = (first && !first.error) ? first : (healedStrat ? planRunStrategy(phrase) : first);
        if (!p || p.error) {
          if (healedStrat) execRunStrategy({ key: key, ids: [healedStrat.id], names: [stratLabel(healedStrat)] });
          else addMsg('ai', p && p.error ? p.error : 'Run nahi ho paya.');
        } else execRunStrategy(p.params);
      }
      return true;
    }
    if (type === 'run_ast_template') { astRunTemplateNow(params.template, key); return true; }
    if (type === 'ae_run') { aeRunNow(resolveAeKey(params)); return true; }
    if (type === 'ae_toggle') { aeToggleNow(resolveAeKey(params), params.on); return true; }
    if (type === 'build_saved_strategy') { brainBuildNow(params); return true; }
    if (type === 'ae_experiment') { aeExperimentStrategy(params); return true; }
    addMsg('ai', 'Action type unknown: ' + type);
    return true;
  }
  function revealTabFor(key) {
    if (!key || typeof switchTab !== 'function') return false;
    try {
      var btn = document.querySelector('.tab-btn[data-tab="' + key + '"]');
      var panel = document.getElementById('tab-' + key);
      if (btn && panel) { switchTab(key); return true; }
    } catch (e) {}
    return false;
  }
  function astRunTemplateNow(template, key) {
    var eng = astEng(key);
    if (!eng || typeof eng.runTemplateById !== 'function') { addMsg('ai', 'AST engine nahi mila (' + key + ').'); return; }
    var list = astTemplates(eng);
    var q = String(template || '').replace(/\s*\[ast\]\s*$/i, '').trim().toLowerCase();
    var hit = null;
    for (var i = 0; i < list.length; i++) {
      var nm = astTplLabel(list[i]).toLowerCase();
      if (!nm) continue;
      if (nm === q || (q.length > 2 && nm.indexOf(q) === 0)) { hit = list[i]; break; }
    }
    if (!hit) {
      var names = list.map(astTplLabel).slice(0, 10);
      addMsg('ai', 'Template "' + template + '" ' + astLabel(key) + ' me nahi mila.' + (names.length ? ' Saved templates: ' + names.join(', ') + '.' : ' Usme abhi koi template saved nahi hai - pehle AST template save karna hoga.'));
      return;
    }
    try {
      revealTabFor(key);
      var r = eng.runTemplateById(hit.astId != null ? hit.astId : hit.id);
      var rm = astTplLabel(r && r.name ? r : hit);
      addMsg('ai', 'AST template "' + rm + '" ' + astLabel(key) + ' par apply karke run chalu kar diya' +
        (r && r.restored ? ' (' + r.restored + ' ticked strategy restore hui)' : '') + '.');
    } catch (e) { addMsg('ai', 'Template run me dikkat: ' + e.message); }
  }
  function resolveAeKey(params) {
    var k = String(params.engine || params.key || '').trim();
    if (k && aeEng(k)) return k;
    return aeKeyFor('');
  }
  function aeRunNow(key) {
    var e = aeEng(key);
    if (!e) { addMsg('ai', 'AE engine nahi mila.'); return; }
    try {
      revealTabFor(key);
      if (typeof e.run === 'function') { e.run(); addMsg('ai', 'Auto Experiment run ' + key + ' par chalu kar diya. Results table me refresh hote hi main dekh lunga.'); }
      else addMsg('ai', 'AE engine ka run method available nahi hai.');
    } catch (err) { addMsg('ai', 'AE run me dikkat: ' + err.message); }
  }
  function aeToggleNow(key, on) {
    var e = aeEng(key);
    if (!e) { addMsg('ai', 'AE engine nahi mila.'); return; }
    var want = !!on;
    var cur = false;
    try { if (e.getState) cur = !!(e.getState() && e.getState().enabled); } catch (err) {}
    if (cur === want) { addMsg('ai', 'AE auto engine ' + key + ' pehle se ' + (want ? 'ON' : 'OFF') + ' hai.'); return; }
    try {
      revealTabFor(key);
      if (typeof e.toggleAuto === 'function') { e.toggleAuto(); addMsg('ai', 'AE auto engine ' + key + ' ab ' + (want ? 'ON' : 'OFF') + ' kar diya.'); }
      else addMsg('ai', 'AE toggle method available nahi hai.');
    } catch (err) { addMsg('ai', 'AE toggle me dikkat: ' + err.message); }
  }

  /* ------------------------------------------- saved-strategy builder (Brain)
     Lets the Brain create a real saved strategy (same shape the Strategies tab
     builder writes) so "ek bearish strategy bana ke chalao" no longer needs the
     user to build it by hand. The setups mirror the engine-native research
     templates the AST and AE engines evaluate, so a Brain-created strategy is
     structurally identical to a builder-saved one. */
  function brainCond(o) {
    return {
      indId: o.indId || '', indSettings: o.indSettings || {}, valueKey: o.valueKey || 'v0',
      logic: o.logic || 'gt', cmpType: o.cmpType || 'number',
      cmpIndId: o.cmpIndId || '', cmpSettings: o.cmpSettings || {}, cmpValueKey: o.cmpValueKey || 'v0',
      candleKey: o.candleKey || 'close', number: (o.number != null) ? o.number : 0,
      candlePatterns: o.candlePatterns || [], dir: (o.dir != null) ? o.dir : 0
    };
  }
  function brainSrc(indId, settings, valueKey) { return { indId: indId, indSettings: settings || {}, valueKey: valueKey || 'v0' }; }
  function brainNumCond(prim, logic, value) {
    return brainCond({ indId: prim.indId, indSettings: prim.indSettings, valueKey: prim.valueKey, logic: logic, cmpType: 'number', number: value });
  }
  function brainIndCond(prim, logic, cmp) {
    return brainCond({ indId: prim.indId, indSettings: prim.indSettings, valueKey: prim.valueKey, logic: logic, cmpType: 'indicator', cmpIndId: cmp.indId, cmpSettings: cmp.indSettings, cmpValueKey: cmp.valueKey });
  }
  function brainSmoothCond(indId, settings, logic) {
    return brainCond({ indId: indId, indSettings: settings, valueKey: 'v0', logic: logic, cmpType: 'smoothed' });
  }
  function brainPxCross(prim, above) {
    return brainCond({ indId: prim.indId, indSettings: prim.indSettings, valueKey: prim.valueKey, logic: above ? 'crossBelow' : 'crossAbove', cmpType: 'candle', candleKey: 'close' });
  }
  function brainEma(n) { return brainSrc('ema', { length: n, source: 'close' }, 'v0'); }
  function brainRsi(n) { return brainSrc('rsi', { length: n }, 'v0'); }
  function brainSt(p, f) { return brainSrc('supertrend', { atrPeriod: p, factor: f }, 'v0'); }
  function brainBb(n, m) { return brainSrc('bollingerB', { length: n, mult: m }, 'v0'); }
  function brainSetup(side, key) {
    var bear = side === 'bearish';
    var id = String(key || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
    var MACD = { fast: 12, slow: 26, signal: 9 };
    if (id.indexOf('rsi') === 0 || id.indexOf('overbought') === 0 || id.indexOf('oversold') === 0) {
      return bear
        ? { key: 'rsi_reversal', name: 'RSI-14 Overbought Fade', cat: 'bearish', entry: brainNumCond(brainRsi(14), 'crossBelow', 70), exit: brainNumCond(brainRsi(14), 'crossAbove', 30) }
        : { key: 'rsi_reversal', name: 'RSI-14 Oversold Bounce', cat: 'bullish', entry: brainNumCond(brainRsi(14), 'crossAbove', 30), exit: brainNumCond(brainRsi(14), 'crossBelow', 70) };
    }
    if (id.indexOf('supertrend') === 0 || id.indexOf('st') === 0) {
      return bear
        ? { key: 'supertrend', name: 'Supertrend(10,3) Short', cat: 'bearish', entry: brainPxCross(brainSt(10, 3), false), exit: brainPxCross(brainSt(10, 3), true) }
        : { key: 'supertrend', name: 'Supertrend(10,3) Long', cat: 'bullish', entry: brainPxCross(brainSt(10, 3), true), exit: brainPxCross(brainSt(10, 3), false) };
    }
    if (id.indexOf('macd') === 0) {
      return bear
        ? { key: 'macd_cross', name: 'MACD(12,26,9) Bear Cross', cat: 'bearish', entry: brainSmoothCond('macd', MACD, 'crossBelow'), exit: brainSmoothCond('macd', MACD, 'crossAbove') }
        : { key: 'macd_cross', name: 'MACD(12,26,9) Bull Cross', cat: 'bullish', entry: brainSmoothCond('macd', MACD, 'crossAbove'), exit: brainSmoothCond('macd', MACD, 'crossBelow') };
    }
    if (id.indexOf('bb') === 0 || id.indexOf('bollinger') === 0 || id.indexOf('reversion') === 0) {
      return bear
        ? { key: 'bb_reversion', name: 'Bollinger %B Overbought (20,2)', cat: 'bearish', entry: brainNumCond(brainBb(20, 2), 'crossBelow', 1), exit: brainNumCond(brainBb(20, 2), 'crossAbove', 0) }
        : { key: 'bb_reversion', name: 'Bollinger %B Oversold (20,2)', cat: 'bullish', entry: brainNumCond(brainBb(20, 2), 'crossAbove', 0), exit: brainNumCond(brainBb(20, 2), 'crossBelow', 1) };
    }
    return bear
      ? { key: 'ema_cross', name: 'EMA-9/21 Death Cross', cat: 'bearish', entry: brainIndCond(brainEma(9), 'crossBelow', brainEma(21)), exit: brainIndCond(brainEma(9), 'crossAbove', brainEma(21)) }
      : { key: 'ema_cross', name: 'EMA-9/21 Golden Cross', cat: 'bullish', entry: brainIndCond(brainEma(9), 'crossAbove', brainEma(21)), exit: brainIndCond(brainEma(9), 'crossBelow', brainEma(21)) };
  }
  function brainSideOf(s) { return (s && s.cat === 'bearish') ? 'bearish' : 'bullish'; }
  function pickBrainSide(text) {
    var t = ' ' + String(text || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ') + ' ';
    var bear = /\bbear\b|bearish|pe\b|short|fade|death|overbought|\brsi\b|\bput\b/.test(t);
    var bull = /\bbull\b|bullish|ce\b|long|bounce|oversold|\bcall\b|\bbreakout\b/.test(t);
    if (bear && !bull) return 'bearish';
    if (bull && !bear) return 'bullish';
    return null;
  }
  function brainSavedOfSide(side) {
    var saved = loadSavedStrats();
    for (var i = 0; i < saved.length; i++) { if (brainSideOf(saved[i]) === side) return saved[i]; }
    return null;
  }
  function brainResolveSymbol(name) {
    if (!name) return null;
    var m = null;
    try { m = uiFindSymbol(String(name)); } catch (e) {}
    return m ? { name: m.name } : null;
  }
  function brainBuildStrategy(side, opts) {
    opts = opts || {};
    var isBear = side === 'bearish';
    var set = brainSetup(isBear ? 'bearish' : 'bullish', opts.setup);
    if (!set) return { error: 'Setup nahi mila - setup: ema_cross, rsi_reversal, supertrend, macd_cross, bb_reversion.' };
    var symbol = null;
    try { symbol = brainResolveSymbol(opts.symbol) || null; } catch (e) {}
    var strat = {
      id: 'brain-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      name: String(opts.name || '').trim() || ('Brain: ' + set.name),
      cat: set.cat,
      symbol: symbol,
      tf: (opts.tf && uiTfValid(String(opts.tf))) ? String(opts.tf) : '5min',
      entry: set.entry, exit: set.exit,
      exitReverse: false,
      strike: { mode: 'both_atm', count: 3, includeAtm: true, optionType: 'both' },
      lot: { auto: true, basis: 'pct', pct: 0, manualQty: 1 },
      candlestick: { enabled: false, entry: [], exit: [] },
      gate: { enabled: false },
      createdAt: Date.now(),
      _brain: true
    };
    return strat;
  }
  function brainSaveStrategy(strat) {
    if (!strat) return null;
    var saved = loadSavedStrats();
    var name = strat.name || 'Brain Strategy';
    var base = name, n = 2;
    while (saved.some(function (s) { return s && String(s.name || '') === name; })) { name = base + ' ' + n; n++; }
    strat.name = name;
    saved.push(strat);
    try { localStorage.setItem(SAVED_STRATS_KEY, JSON.stringify(saved)); } catch (e) {}
    try { if (window.StratUI && StratUI.renderSavedList) StratUI.renderSavedList(); } catch (e) {}
    try { if (window.StratUI && StratUI.renderSavedDropdown) StratUI.renderSavedDropdown(); } catch (e) {}
    return strat;
  }
  function brainBuildNow(params) {
    var side = String(params.side || params.cat || '').toLowerCase();
    if (side !== 'bearish' && side !== 'bullish') {
      var hint = String((params.name || '') + ' ' + (params.setup || '')).toLowerCase();
      side = /bear|short|fade|death|overbought|ob\b|pe\b/.test(hint) ? 'bearish' : 'bullish';
    }
    var strat = brainBuildStrategy(side, params);
    if (strat.error) { addMsg('ai', strat.error); return null; }
    var saved = brainSaveStrategy(strat);
    addMsg('ai', 'Strategies me ek nayi saved strategy bana di: "' + saved.name + '" (' + (saved.cat === 'bearish' ? 'Bearish / PE' : 'Bullish / CE') +
      (saved.symbol && saved.symbol.name ? ' on ' + saved.symbol.name : '') + ', ' + saved.tf + ').\n\n' +
      'Ab usko chala sakte hain - "ae me is par experiment karo" (auto experiment) ya "ast me chalao" (paper run).');
    return saved;
  }
  function aeSetRunManual(e, on) {
    if (!e) return false;
    if (typeof e.setRunManual === 'function') { e.setRunManual(!!on); return true; }
    var st = null;
    try { if (e.getState) st = e.getState(); } catch (err) {}
    if (st) { try { st.runManual = !!on; } catch (err) {} }
    return !!st;
  }
  function aeSetOptionDir(e, side) {
    if (!e || side === 'both') return null;
    var want = side === 'bearish' ? 'PE' : 'CE';
    if (typeof e.setOptionType === 'function') { e.setOptionType(want); return want; }
    var st = null;
    try { if (e.getState) st = e.getState(); } catch (err) {}
    if (st && st.strike) { try { st.strike.optionType = want; } catch (err) {} return want; }
    return null;
  }
  function aeExperimentStrategy(params) {
    var key = resolveAeKey(params);
    var e = aeEng(key);
    if (!e) { addMsg('ai', 'AE engine nahi mila (' + key + ').'); return; }
    revealTabFor(key);
    var side = String(params.side || params.cat || '').toLowerCase();
    if (side !== 'bearish' && side !== 'bullish') side = 'both';
    var parts = [];
    var usedStrat = null;
    if (side !== 'both') {
      usedStrat = brainSavedOfSide(side);
      if (!usedStrat) {
        usedStrat = brainBuildStrategy(side, params);
        if (usedStrat && !usedStrat.error) {
          usedStrat = brainSaveStrategy(usedStrat);
          parts.push('saved strategy nahi thi, isliye "' + usedStrat.name + '" bana kar use kiya');
        } else usedStrat = null;
      }
    }
    if (aeSetRunManual(e, true)) parts.push('"run on manually saved strategies" ON');
    var setDir = aeSetOptionDir(e, side);
    if (setDir) parts.push('option type ' + setDir + ' set kiya (direction lock)');
    if (!parts.length) parts.push('experiment settings ready');
    try {
      if (typeof e.run === 'function') e.run();
      addMsg('ai', 'Auto Experiment (' + key + ') me bearish/bullish run chalu kar diya. ' + parts.join(', ') +
        (usedStrat ? '. Use "' + usedStrat.name + '" saved strategy se experiment hoga' : '') +
        '. Results table me aate hi main summary de dunga.');
    } catch (err) { addMsg('ai', 'AE experiment run me dikkat: ' + err.message); }
  }
  function setTfDirect(key, tf) {
    var eng = astEng(key);
    if (!eng) { addMsg('ai', 'Engine instance nahi mila (' + key + ').'); return; }
    try {
      var c1 = astEl(key, 'astTf1min'), c5 = astEl(key, 'astTf5min');
      if (tf === 'both') { if (c1) c1.checked = true; if (c5) c5.checked = true; }
      else if (tf === '1min') { if (c1) c1.checked = true; if (c5) c5.checked = false; }
      else { if (c1) c1.checked = false; if (c5) c5.checked = true; }
      var useOwn = astEl(key, 'astUseOwnSettings');
      if (useOwn) useOwn.checked = true;
      if (typeof eng.onUniversalInput === 'function') eng.onUniversalInput();
      if (typeof eng.setNiftyTf === 'function') eng.setNiftyTf(tf);
      addMsg('ai', astLabel(key) + ' engine ab ' + (tf === 'both' ? 'dono (1min+5min)' : tf) + ' par trade karega.');
    } catch (e) { addMsg('ai', 'Timeframe set karne me dikkat: ' + e.message); }
  }
  /* Entry point used by send() when llm.enabled. */
  function llmChat(text) {
    if (llm.busy) return;
    llm.lastUserText = text;
    llm.msgs.push({ role: 'user', content: text });
    trimMsgs();
    setBusy(true);
    var msgs = llm.msgs.slice();
    llmCall(msgs).then(function (d) {
      if (d && d.kind === 'data') {
        llm.msgs.length = 0;
        llm.msgs.push.apply(llm.msgs, msgs);
      }
      return llmApplyTurn(d, 1);
    }).catch(function (e) {
      setBusy(false);
      updatePillFromCfg();
      var fb;
      try { fb = think(text); } catch (e2) { fb = ''; }
      if (fb) addMsg('ai', fb + '\n\n(LLM network issue aayi thi - ye offline brain ka jawab hai.)');
    });
  }
  function llmHowToText() {
    return 'Abhi main OFFLINE brain mode me hoon - keywords se samajhta hoon, isliye language thodi robotic lagti hai.\n\n' +
      'Mujhe insaan jaisi baat karne ke liye ek LLM se jodna padega. Iske liye server par apni API key chahiye (OpenAI/DeepSeek/kuch bhi OpenAI-compatible):\n' +
      '  1. /workspace/repo_preview/.env me daalo:  USER_LLM_API_KEY=sk-...\n' +
      '  2. (optional) USER_LLM_BASE_URL aur USER_LLM_MODEL bhi set kar sakte ho.\n' +
      '  3. Server restart karo, phir ye pill header me "GPT ON" dikhayega.\n\n' +
      'Tum key bhejo to main .env me daal ke restart kar dunga. Tab tak offline brain se kaam chala lo - "Help" likho to commands milenge.';
  }

  /* -------------------------------------------------------------- overlay */
  function isBrainTab() {
    var tabs = document.querySelectorAll('.tab-content.active');
    var on = false;
    for (var i = 0; i < tabs.length; i++) if (tabs[i] && tabs[i].id === 'tab-' + TAB_ID) on = true;
    return on || (window.activeTab === TAB_ID);
  }
  function syncMount() {
    var chat = els.chat;
    if (!chat) return;
    var p = prefs();
    var onBrain = isBrainTab();
    var overlayOn = !!p.overlay;
    if (!onBrain && overlayOn) {
      /* float over everything */
      if (chat.parentNode !== document.body) document.body.appendChild(chat);
      chat.classList.add('aib-float');
      chat.style.display = 'flex';
      if (p.min) chat.classList.add('aib-min');
      else chat.classList.remove('aib-min');
    } else {
      /* inside the tab */
      if (els.embed && chat.parentNode !== els.embed) els.embed.appendChild(chat);
      chat.classList.remove('aib-float', 'aib-min');
      chat.style.display = '';
    }
    syncFloatBtn();
  }
  function syncFloatBtn() {
    var p = prefs();
    var show = !isBrainTab() && p.overlay && p.min && els.fbtn;
    if (els.fbtn) els.fbtn.style.display = show ? 'flex' : 'none';
    var ov = $('aibOverlayCb');
    if (ov) ov.checked = !!p.overlay;
  }
  function toggleOverlay(on) {
    setPref('overlay', !!on);
    if (!on) { setPref('min', false); }
    syncMount();
    addMsg('ai', on ? 'Chat overlay ON - ab main chat window har tab ke upar tairta rahega, tum alag-alag tabs use karte raho.' : 'Chat overlay OFF - chat ab sirf Algos AI Brain tab me dikhegi.');
  }
  function setMin(m) {
    setPref('min', !!m);
    syncMount();
    syncFloatBtn();
  }

  /* --------------------------------------------------------------- build UI */
  function injectStyles() {
    if ($('aibrainCss')) return;
    var st = document.createElement('style');
    st.id = 'aibrainCss';
    st.textContent = [
      '.aib-tabwrap{flex:1;display:flex;flex-direction:column;min-height:0;padding:10px 12px;gap:8px}',
      '.aib-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.aib-title{font-size:14px;font-weight:800;color:#e0b3ff;text-transform:uppercase;letter-spacing:1px}',
      '.aib-sub{font-size:10px;color:#888}',
      '.aib-switch{display:flex;align-items:center;gap:4px;font-size:10px;color:#b39ddb;background:#12122a;border:1px solid #3d3d7e;border-radius:3px;padding:4px 8px;cursor:pointer}',
      '.aib-pill{font-size:9px;font-weight:700;padding:3px 8px;border-radius:10px;border:1px solid #3d3d7e;color:#888;background:#12122a;white-space:nowrap}',
      '.aib-pill.on{color:#042;background:#00d4aa;border-color:#00d4aa}',
      '.aib-settings{display:flex;flex-wrap:wrap;gap:10px;background:#0e0e24;border:1px solid #1e1e40;border-radius:6px;padding:10px 12px;align-items:flex-end}',
      '.aib-setcol{display:flex;flex-direction:column;gap:4px;min-width:150px}',
      '.aib-setcol label{font-size:9px;color:#888;text-transform:uppercase;letter-spacing:.5px}',
      '.aib-setrow{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.aib-settings input{background:#12122a;border:1px solid #2d2d50;color:#e2e2f0;border-radius:4px;padding:5px 7px;font-size:11px;outline:none;font-family:inherit}',
      '.aib-settings input:focus{border-color:#00d4aa}',
      '.aib-card{flex:1;display:flex;flex-direction:column;min-height:0;background:#0e0e24;border:1px solid #1e1e40;border-radius:6px;overflow:hidden}',
      '.aib-card.aib-float{position:fixed;top:10px;right:10px;width:min(430px,96vw);height:min(78vh,760px);z-index:2147483000;box-shadow:0 8px 40px rgba(0,0,0,.6);border-color:#4a2d7e}',
      '.aib-card.aib-min .aib-body,.aib-card.aib-min .aib-composer{display:none}',
      '.aib-head{display:flex;align-items:center;gap:6px;padding:8px 10px;background:#12122a;border-bottom:1px solid #1e1e40}',
      '.aib-head .h-title{flex:1;font-size:11px;font-weight:800;color:#e0b3ff;display:flex;align-items:center;gap:6px}',
      '.aib-dot{width:8px;height:8px;border-radius:50%;background:#00d4aa;display:inline-block}',
      '.aib-head button{width:auto;margin:0;padding:2px 8px;font-size:10px}',
      '.aib-body{flex:1;min-height:0;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:8px}',
      '.aib-msg{display:flex;flex-direction:column}',
      '.aib-user{align-items:flex-end}',
      '.aib-user .aib-bubble{background:#2a2a55;border:1px solid #44447e;border-top-right-radius:2px}',
      '.aib-bubble{max-width:92%;background:#14142e;border:1px solid #22224a;border-radius:8px;padding:7px 10px;font-size:11px;line-height:1.55;color:#e2e2f0;white-space:pre-wrap;word-break:break-word;font-family:inherit}',
      '.aib-confirm{border-color:#b39ddb}',
      '.aib-confirm-row{display:flex;gap:6px;margin-top:8px;align-items:center}',
      '.aib-chips{display:flex;gap:5px;flex-wrap:wrap;padding:6px 10px;border-top:1px solid #12122a;background:#0b0b1c}',
      '.aib-chip{font-size:9px;color:#b39ddb;background:#12122a;border:1px solid #3d3d7e;border-radius:12px;padding:3px 9px;cursor:pointer;white-space:nowrap}',
      '.aib-chip:hover{border-color:#00d4aa;color:#00d4aa}',
      '.aib-composer{display:flex;gap:6px;padding:8px;border-top:1px solid #12122a;background:#0b0b1c}',
      '.aib-composer textarea{flex:1;resize:none;background:#12122a;border:1px solid #2d2d50;color:#e2e2f0;border-radius:4px;padding:7px 9px;font-size:11px;min-height:34px;max-height:110px;outline:none;font-family:inherit}',
      '.aib-composer textarea:focus{border-color:#00d4aa}',
      '#aibFloatBtn{position:fixed;right:14px;bottom:14px;z-index:2147483001;align-items:center;gap:6px;background:#4a2d7e;color:#fff;border:none;border-radius:20px;padding:8px 14px;font-size:11px;font-weight:700;cursor:pointer;box-shadow:0 4px 18px rgba(0,0,0,.5);display:none}',
      '#aibFloatBtn:hover{background:#6a3da0}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(st);
  }
  function injectTab() {
    if ($('tab-' + TAB_ID)) return;
    /* nav button before the "+" tab-add buttons */
    var addBtn = document.querySelector('.tab-btn[data-add-paper]');
    var bar = document.querySelector('.tab-bar');
    if (!bar) return;
    var btn = document.createElement('button');
    btn.className = 'tab-btn';
    btn.setAttribute('data-tab', TAB_ID);
    btn.style.color = '#e0b3ff';
    btn.textContent = 'Algos AI Brain';
    btn.onclick = function () { window.switchTab(TAB_ID, btn); };
    if (addBtn) bar.insertBefore(btn, addBtn);
    else bar.appendChild(btn);
    /* panel */
    var content = $('content') || document.querySelector('#content') || document.body;
    var panel = document.createElement('div');
    panel.className = 'tab-content';
    panel.id = 'tab-' + TAB_ID;
    panel.innerHTML =
      '<div class="aib-tabwrap">' +
      '  <div class="aib-top">' +
      '    <div style="flex:1;min-width:220px">' +
      '      <div class="aib-title">Algos AI Brain</div>' +
      '      <div class="aib-sub">Poora algo system mere control me hai - har tab, har setting, har data. Chat me likho aur main answer dunga ya kaam kar dunga.</div>' +
      '    </div>' +
      '    <button id="aibClearBtn" class="btn-action" style="width:auto;padding:4px 10px;margin:0;font-size:10px">Clear chat</button>' +
      '  </div>' +
      '  <div id="aibSettings" class="aib-settings" style="display:none">' +
      '    <div style="flex:1">' +
      '      <div class="aib-title" style="font-size:12px">LLM connect (optional)</div>' +
      '      <div class="aib-sub">Apni API key yahan daalo (Groq / OpenAI / DeepSeek - sab OpenAI-compatible). Key sirf <b>is server par</b> save hoti hai, chat/browser me kabhi nahi dikhti. Key ke bina brain offline mode me chalta hai.</div>' +
      '    </div>' +
      '    <div class="aib-setcol">' +
      '      <label>Preset</label>' +
      '      <div class="aib-setrow" style="gap:6px">' +
      '        <button data-preset="groq" class="btn-action" style="width:auto;margin:0;padding:2px 10px;font-size:10px">Groq</button>' +
      '        <button data-preset="openai" class="btn-action" style="width:auto;margin:0;padding:2px 10px;font-size:10px">OpenAI</button>' +
      '        <button data-preset="deepseek" class="btn-action" style="width:auto;margin:0;padding:2px 10px;font-size:10px">DeepSeek</button>' +
      '      </div>' +
      '    </div>' +
      '    <div class="aib-setcol">' +
      '      <label for="aibSetKey">API key</label>' +
      '      <input id="aibSetKey" type="password" autocomplete="off" spellcheck="false" placeholder="gsk_... / sk-..." style="width:100%">' +
      '    </div>' +
      '    <div class="aib-setrow">' +
      '      <div class="aib-setcol" style="flex:1.3">' +
      '        <label for="aibSetBase">Base URL</label>' +
      '        <input id="aibSetBase" type="text" spellcheck="false" value="https://api.groq.com/openai/v1" style="width:100%">' +
      '      </div>' +
      '      <div class="aib-setcol" style="flex:1">' +
      '        <label for="aibSetModel">Model</label>' +
      '        <input id="aibSetModel" type="text" spellcheck="false" value="openai/gpt-oss-120b" style="width:100%">' +
      '        <div class="aib-setrow" style="gap:4px;margin-top:2px">' +
      '          <button id="aibModelFetch" class="btn-action" style="width:auto;margin:0;padding:1px 6px;font-size:9px">Fetch available models</button>' +
      '          <select id="aibModelPick" style="flex:1;min-width:0"><option value="">- list -</option></select>' +
      '        </div>' +
      '      </div>' +
      '    </div>' +
      '    <div class="aib-setrow" style="justify-content:flex-end">' +
      '      <button id="aibSetDisconnect" class="btn-action" style="width:auto;margin:0;background:#ef5350;color:#fff;font-size:10px">Disconnect / clear key</button>' +
      '      <button id="aibSetSave" class="btn-action" style="width:auto;margin:0;background:#00d4aa;color:#042;font-weight:800">Save &amp; connect</button>' +
      '    </div>' +
      '    <div id="aibSetStatus" class="aib-sub" style="min-height:14px"></div>' +
      '  </div>' +
      '  <div id="aibEmbed" style="flex:1;display:flex;flex-direction:column;min-height:0">' +
      '  <div id="aibChat" class="aib-card">' +
      '    <div class="aib-head">' +
      '      <span class="h-title"><span class="aib-dot"></span> Algos AI Brain</span>' +
      '      <label class="aib-switch" title="ON: chat window hamesha screen par overlay ki tarah tairta rahega, dusre tabs me bhi"><input type="checkbox" id="aibOverlayCb" style="accent-color:#b39ddb"> Chat overlay</label>' +
      '      <span id="aibModePill" class="aib-pill">...</span>' +
      '      <button id="aibSetBtn" class="btn-action" style="width:auto;margin:0;padding:2px 8px;background:#333;color:#ccc" title="LLM settings - apni API key yahan connect karo">&#9881;</button>' +
      '      <button id="aibMinBtn" class="btn-action" style="background:#333;color:#aaa" title="Minimize (overlay mode me)">&#8211;</button>' +
      '    </div>' +
      '    <div id="aibMsgs" class="aib-body"></div>' +
      '    <div class="aib-chips" id="aibChips"></div>' +
      '    <div class="aib-composer">' +
      '      <textarea id="aibInput" placeholder="Yahan likho... jaise: aaj ka P&L batao / 5 minute me trading karo / top 3 bullish run karo"></textarea>' +
      '      <button id="aibSend" class="btn-action" style="width:auto;margin:0;background:#b39ddb;color:#0a0a18;font-weight:800">Send</button>' +
      '    </div>' +
      '  </div>' +
      '  </div>' +
      '</div>';
    content.appendChild(panel);
    /* floating reopen button when minimized overlay */
    var fbtn = document.createElement('button');
    fbtn.id = 'aibFloatBtn';
    fbtn.innerHTML = '<span style="font-size:13px">&#129504;</span> AI Brain';
    fbtn.onclick = function () { setMin(false); if (!isBrainTab()) window.switchTab(TAB_ID, document.querySelector('.tab-btn[data-tab="' + TAB_ID + '"]')); };
    document.body.appendChild(fbtn);
  }
  function chips() {
    var list = [
      'Help',
      'Sab kya chal raha hai?',
      'Aaj ka P&L aur win rate batao',
      'NIFTY ka price kya hai?',
      'Market khula hai?',
      '5 minute me trading karo',
      'Top 2 bullish strategy run karo',
      'Auto experiment results paper me bhejo'
    ];
    var host = els.chips;
    if (!host) return;
    host.innerHTML = '';
    list.forEach(function (c) {
      var b = document.createElement('button');
      b.className = 'aib-chip';
      b.textContent = c;
      b.onclick = function () { els.input.value = c; els.input.focus(); syncHeight(); };
      host.appendChild(b);
    });
  }
  function syncHeight() {
    var ta = els.input;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = clamp(ta.scrollHeight, 34, 110) + 'px';
  }
  function hookSwitchTab() {
    if (window.__aibTabHooked) return;
    var orig = window.switchTab;
    if (typeof orig !== 'function') return;
    window.switchTab = function (t, el) {
      var r = orig.apply(this, arguments);
      try {
        setTimeout(function () {
          syncMount();
          if (isBrainTab() && booted && !store().length) {
            setTimeout(function () {
              if (booted && !store().length) addMsg('ai', introText());
            }, 250);
          }
        }, 30);
      } catch (e) {}
      return r;
    };
    window.__aibTabHooked = true;
  }
  function introText() {
    if (llm.enabled) {
      return 'Namaste! Main Algos AI Brain hoon - ab GPT mode me connected hoon.\n\nMujhse bilkul natural baat karo (Hinglish/Hindi/English), jaise kisi expert se baat kar rahe ho:\n' +
        '  • "Sab kya chal raha hai?"\n  • "Aaj ka P&L aur win rate batao"\n  • "NIFTY ka price batao"\n' +
        '  • "NIFTY 50 ka chart kholo aur EMA-9 laga do"\n  • "chart se RSI hata do"\n' +
        '  • "5 minute me trading karo"\n  • "Top 2 bullish run karo"\n  • "sab band kar do"\n\n' +
        'Main data nikalta hoon, chart/indicators handle karta hoon aur settings par kaam bhi kar deta hoon. Trading action se pehle confirm karunga (jab tak "auto" na kaho).';
    }
    return 'Namaste! Main Algos AI Brain hoon.\n\nMujhse Hinglish me baat karo aur main is algo system ko manage karunga:\n' +
      '  • Data: "NIFTY price kya hai?", "market khula hai?"\n' +
      '  • P&L: "aaj ka P&L aur win rate batao", "sab engines ka performance"\n' +
      '  • Timeframe: "1 minute me trading karo" / "5 min"\n' +
      '  • Strategies: "top 3 bullish run karo paper me", phir "performance batao"\n' +
      '  • Control: "sab band kar do", "P&L reset karo" (pehle confirm karunga, jab tak "auto" na bolo)\n\n' +
      '"Help" likho to poora list. Header ka "Chat overlay" checkbox ON karo to chat window har tab ke upar tairti rahegi.' +
      '\n\nHeader me "GPT ON" nahi dikh raha? Tumhe insaan jaisi baat-chit chahiye to "LLM kaise connect kare" likho - main bata dunga.';
  }

  function bind() {
    var sendBtn = els.send, inp = els.input;
    if (!sendBtn || !inp) return;
    sendBtn.onclick = function () { sendFromInput(); };
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendFromInput(); }
    });
    inp.addEventListener('input', syncHeight);
    $('aibOverlayCb').addEventListener('change', function (e) { toggleOverlay(e.target.checked); });
    $('aibMinBtn').addEventListener('click', function () { setMin(!prefs().min); });
    $('aibClearBtn').addEventListener('click', function () { clearChat(); addMsg('ai', 'Chat clear ho gaya. Kuch batao?'); });
    /* LLM settings panel (gear) */
    var gear = $('aibSetBtn');
    if (gear) gear.addEventListener('click', toggleSettings);
    var saveBtn = $('aibSetSave');
    if (saveBtn) saveBtn.addEventListener('click', function () { saveLlmSettings(false); });
    var discBtn = $('aibSetDisconnect');
    if (discBtn) discBtn.addEventListener('click', function () { saveLlmSettings(true); });
    var modelFetchBtn = $('aibModelFetch');
    if (modelFetchBtn) modelFetchBtn.addEventListener('click', loadBrainModels);
    var modelPick = $('aibModelPick');
    if (modelPick) modelPick.addEventListener('change', function () {
      var mEl = $('aibSetModel');
      if (modelPick.value && mEl) {
        mEl.value = modelPick.value;
        setSetStatus('Model "' + modelPick.value + '" set. Save & connect dabao.', '#00d4aa');
      }
    });
    var presetBtns = document.querySelectorAll('[data-preset]');
    for (var pi = 0; pi < presetBtns.length; pi++) {
      (function (b) {
        b.addEventListener('click', function () { applyLlmPreset(b.getAttribute('data-preset')); });
      })(presetBtns[pi]);
    }
  }
  /* ------------------------------------------------- LLM settings panel UI */
  function setSetStatus(msg, color) {
    var el = $('aibSetStatus');
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = color || '';
  }
  function toggleSettings() {
    var s = $('aibSettings');
    if (!s) return;
    var show = s.style.display === 'none';
    s.style.display = show ? 'flex' : 'none';
    if (show) setSetStatus('');
  }
  function applyLlmPreset(p) {
    var b = $('aibSetBase'), m = $('aibSetModel');
    if (!b || !m) return;
    if (p === 'groq') { b.value = 'https://api.groq.com/openai/v1'; m.value = 'openai/gpt-oss-120b'; }
    else if (p === 'openai') { b.value = 'https://api.openai.com/v1'; m.value = 'gpt-4o-mini'; }
    else if (p === 'deepseek') { b.value = 'https://api.deepseek.com/v1'; m.value = 'deepseek-chat'; }
    setSetStatus('Preset "' + p + '" select kiya. Ab key daalo aur Save & connect dabao.', '#b39ddb');
  }
  function saveLlmSettings(disconnect) {
    var keyEl = $('aibSetKey'), baseEl = $('aibSetBase'), modelEl = $('aibSetModel');
    if (!baseEl || !modelEl) return;
    var body = { base: baseEl.value.trim(), model: modelEl.value.trim() };
    if (disconnect) {
      body.disconnect = true;
    } else {
      var k = (keyEl ? keyEl.value.trim() : '');
      if (!k) { setSetStatus('Pehle API key daalo - Groq console (console.groq.com > API Keys) se gsk_... key copy karo.', '#ffb74d'); return; }
      body.key = k;
    }
    setSetStatus('Save ho raha hai...', '');
    try {
      fetch('/api/brain/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }).then(function (r) { return r.json(); }).then(function (d) {
        var on = !!(d && d.enabled);
        llm.enabled = on;
        llm.model = on ? (d.model || '') : '';
        llm.msgs = [];
        updatePillFromCfg();
        setSetStatus((d && d.message) || (on ? 'Connected' : 'Disconnected'), on ? '#00d4aa' : '#ef9a9a');
        if (keyEl) keyEl.value = '';
        if (d && d.message) addMsg('ai', d.message + (on ? ' Ab natural baat karke dekho.' : ''));
      }).catch(function (e) {
        setSetStatus('Save fail: ' + e.message, '#ef5350');
      });
    } catch (e) {
      setSetStatus('Save fail: ' + e.message, '#ef5350');
    }
  }

  function loadBrainModels() {
    var sel = $('aibModelPick');
    setSetStatus('Available models server se laa raha hoon (saved key/base se)...', '');
    fetch('/api/brain/models').then(function (r) { return r.json(); }).then(function (d) {
      if (!sel) return;
      sel.innerHTML = '';
      if (d && d.models && d.models.length) {
        var o = document.createElement('option');
        o.value = '';
        o.textContent = '-- choose model --';
        sel.appendChild(o);
        d.models.forEach(function (m) {
          var op = document.createElement('option');
          op.value = m;
          op.textContent = m;
          sel.appendChild(op);
        });
        if (d.current) sel.value = d.current;
        setSetStatus(d.models.length + ' models mile. Koi choose karke Save & connect dabao.', '#00d4aa');
      } else {
        var o2 = document.createElement('option');
        o2.value = '';
        o2.textContent = '- no models -';
        sel.appendChild(o2);
        setSetStatus((d && d.error) ? ('Models nahi mile: ' + d.error) : 'Models nahi mile.', '#ef9a9a');
      }
    }).catch(function (e) {
      setSetStatus('Fetch fail: ' + e.message, '#ef5350');
    });
  }

  function boot() {
    if (booted) return;
    booted = true;
    injectStyles();
    injectTab();
    els.chat = $('aibChat');
    els.embed = $('aibEmbed');
    els.msgs = $('aibMsgs');
    els.chips = $('aibChips');
    els.input = $('aibInput');
    els.send = $('aibSend');
    els.fbtn = $('aibFloatBtn');
    bind();
    chips();
    hookSwitchTab();
    syncMount();
    renderMsgs();
    /* intro when opened first time */
    if (!store().length) setTimeout(function () { addMsg('ai', introText()); }, 400);
    window.AiBrain = {
      send: send,
      confirm: confirmAction,
      clear: clearChat,
      open: function () { toggleOverlay(true); setMin(false); },
      setOverlay: toggleOverlay,
      onTab: syncMount,
      llmReload: fetchBrainConfig,
      llmMode: function () { return llm.enabled ? { enabled: true, model: llm.model } : { enabled: false }; },
      _debug: { pick: pickMatches, plan: planRunStrategy, astKeys: astKeys, state: function (k) { return engineState(k || 'papertrade'); } }
    };
    setModePill('busy', '');
    setTimeout(fetchBrainConfig, 60);
    console.log('[AiBrain] booted - Algos AI Brain ready (llm=' + (llm.enabled ? 'on' : 'off') + ').');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
