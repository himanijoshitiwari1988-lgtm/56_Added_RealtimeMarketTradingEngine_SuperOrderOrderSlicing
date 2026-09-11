/* Dhan Algo - Realtime Market Trade Stats
 *
 * Duplicate of the Trade Stats tab that reports the Realtime Trading Engine's
 * executed trades instead of the paper ledgers. The whole Trade Stats UI is
 * cloned from #tab-tradestats at runtime with every element id suffixed
 * "_rtstats", and a second, isolated createTradeStats instance is created
 * against that clone. Its registries() reads ONLY the realtime engines:
 *
 *     TabEngines.aismart.realtime   - the realtime AST mirror (richer records)
 *     TabEngines.realtime.realtime  - the realtime broker adapter ledger
 *
 * The paper Trade Stats tab keeps reading the paper engines (its default
 * registries() excludes the realtime instance), so the two reports never mix.
 */
(function () {
  'use strict';
  window.RealtimeStatsTab = {
    TAB: 'rtstats',
    _built: false,
    build() {
      if (this._built) return;
      const src = document.getElementById('tab-tradestats');
      const placeholder = document.getElementById('tab-' + this.TAB);
      if (!src || !placeholder || !window.createTradeStats) return;
      const clone = src.cloneNode(true);
      clone.id = 'tab-' + this.TAB;
      clone.classList.remove('active');
      const sfx = '_' + this.TAB;
      clone.querySelectorAll('[id]').forEach(el => { el.id = el.id + sfx; });
      /* switchTab activates the placeholder before build() runs, so keep the
         .active class on the clone that replaces it (otherwise the tab renders
         blank until the user switches away and back). */
      const wasActive = placeholder.classList.contains('active');
      placeholder.replaceWith(clone);
      if (wasActive) clone.classList.add('active');
      this._built = true;
      this._api = window.createTradeStats({
        suffix: sfx,
        tabId: 'tab-' + this.TAB,
        globalName: 'RealtimeStats',
        exportName: 'realtime-executed-trades',
        registries: function () {
          return [
            { reg: window.TabEngines && window.TabEngines.aismart, src: 'ast', only: { realtime: 1 } },
            { reg: window.TabEngines && window.TabEngines.realtime, src: 'rt', only: { realtime: 1 } }
          ];
        }
      });
    }
  };
})();
