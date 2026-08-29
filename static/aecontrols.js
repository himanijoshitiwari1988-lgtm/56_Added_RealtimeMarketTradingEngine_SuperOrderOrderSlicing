/* Dhan Algo - Auto Experiment controls mirror for the Paper Trade tab.
 *
 * Duplicates the Auto Experiment Engine settings into the Paper Trade tab
 * (above Open Positions) with `ptae_*` prefixed IDs. Every `ptae_*` control
 * two-way mirrors its `ae_*` counterpart so both tabs always edit the same
 * `AutoExperiment` state - there is only ONE engine state, two views of it.
 */
(function () {
  'use strict';

  const $id = id => document.getElementById(id);
  const pt = id => id.replace(/^ae/, 'ptae');

  const VALUE = [
    'aeLotSize', 'aeLots', 'aeMargin', 'aeTp',
    'aeTradeLimitCount', 'aeStartTradeAfter', 'aeNoTradeAfter', 'aeAutoSquareOffTime',
    'aeOptionType', 'aeStrikeMode', 'aeStrikeCount',
    'aeMoversGainers', 'aeMoversLosers'
  ];
  const CHECK = [
    'aeRunManualToggle', 'aeManualTrail', 'aeSignalExit',
    'aeAutoTrail', 'aeAiTrail', 'aeTf1min', 'aeTf5min', 'aeAiTimeframe',
    'aeTradeLimit', 'aeAiTrades', 'aeStartTradeAfterEnabled', 'aeNoTradeAfterEnabled',
    'aeAutoSquareOffEnabled',
    'aeOnlyPositive',
    'aeGroup_candlestick', 'aeGroup_elliott', 'aeGroup_indicator', 'aeGroup_pane',
    'aeGroup_symmetry', 'aeGroup_structure', 'aeGroup_atr',
    'aeMoversIndices',
    'aeFilterBullish', 'aeFilterIncUp', 'aeFilterCrossUp',
    'aeFilterBearish', 'aeFilterIncDown', 'aeFilterCrossDown'
  ];
  const BTN = ['aeAutoToggle', 'aeMoversToggle'];
  const TEXT = ['aeAutoTrailStatus', 'aeAiTrailStatus', 'aeAiTradesStatus'];
  const HTML = ['aeMoversList', 'aeSymbolList'];
  const SECT = ['aeFilterSectionBullish', 'aeFilterSectionBearish'];

  const STYLE_PROPS = ['opacity', 'pointerEvents', 'background', 'color', 'cursor'];

  function copyStyle(a, b) {
    STYLE_PROPS.forEach(p => { if (a.style && a.style[p] !== undefined) b.style[p] = a.style[p]; });
  }

  function mirrorSymbolSelect() {
    const a = $id('aeSymbolSelect'), b = $id('ptaeSymbolSelect');
    if (a && b) {
      b.innerHTML = a.innerHTML;
      b.value = a.value;
      b.disabled = a.disabled;
      b.dataset.populated = '1';
    }
  }

  function aeToPt() {
    VALUE.forEach(id => { const a = $id(id), b = $id(pt(id)); if (a && b) b.value = a.value; });
    CHECK.forEach(id => { const a = $id(id), b = $id(pt(id)); if (a && b) b.checked = a.checked; });
    VALUE.concat(CHECK).forEach(id => {
      const a = $id(id), b = $id(pt(id));
      if (a && b) { b.disabled = a.disabled; copyStyle(a, b); }
    });
    BTN.forEach(id => {
      const a = $id(id), b = $id(pt(id));
      if (a && b) { b.textContent = a.textContent; b.style.background = a.style.background; }
    });
    TEXT.forEach(id => { const a = $id(id), b = $id(pt(id)); if (a && b) b.textContent = a.textContent; });
    HTML.forEach(id => {
      const a = $id(id), b = $id(pt(id));
      if (a && b) { b.innerHTML = a.innerHTML; b.style.display = a.style.display; }
    });
    SECT.forEach(id => { const a = $id(id), b = $id(pt(id)); if (a && b) b.style.opacity = a.style.opacity; });
    mirrorSymbolSelect();
  }

  function ptToAe() {
    VALUE.forEach(id => { const a = $id(id), b = $id(pt(id)); if (a && b) a.value = b.value; });
    CHECK.forEach(id => { const a = $id(id), b = $id(pt(id)); if (a && b) a.checked = b.checked; });
  }

  function wrap(fn) {
    return function () {
      ptToAe();
      fn();
      aeToPt();
    };
  }

  const AE = () => (window.AutoExperiment || {});

  const api = {
    sync: aeToPt,
    toggleAuto: wrap(function () { AE().toggleAuto(); }),
    toggleRunManual: wrap(function () { AE().toggleRunManual(); }),
    onUniversalInput: wrap(function () { AE().onUniversalInput(); }),
    onStrikeInput: wrap(function () { AE().onStrikeInput(); }),
    onGroupsInput: wrap(function () { AE().onGroupsInput(); }),
    toggleMovers: wrap(function () { AE().toggleMovers(); }),
    onMoversInput: wrap(function () { AE().onMoversInput(); }),
    onFiltersInput: wrap(function () { AE().onFiltersInput(); }),
    addSymbol: function () {
      const a = $id('aeSymbolSelect'), b = $id('ptaeSymbolSelect');
      if (a && b) a.value = b.value;
      AE().addSymbol();
      aeToPt();
    },
    onPaperTradeShow: aeToPt
  };
  window.AEControls = api;

  /* Keep the mirror fresh when the engine updates its own controls in the
     background (movers list, symbol list, status spans, toggle labels). */
  let _timer = null;
  function observe() {
    const root = document.querySelector('#tab-autoexperiment .monitor-toolbar');
    if (!root || !window.MutationObserver) return;
    const mo = new MutationObserver(() => {
      if (_timer) clearTimeout(_timer);
      _timer = setTimeout(aeToPt, 50);
    });
    mo.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
  }

  function init() {
    aeToPt();
    observe();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
