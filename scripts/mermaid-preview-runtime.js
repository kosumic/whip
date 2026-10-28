/* eslint-env browser */
(() => {
  'use strict';
  let renderSequence = 0;
  const send = message => window.ReactNativeWebView?.postMessage(JSON.stringify(message));
  window.herdrRenderMermaid = async (source, appearance, requestId) => {
    const sequence = ++renderSequence;
    const diagram = document.getElementById('diagram');
    if (!diagram) { send({ type: 'error', message: 'The diagram preview document is incomplete', requestId }); return; }
    diagram.replaceChildren();
    document.documentElement.dataset.appearance = appearance === 'light' ? 'light' : 'dark';
    try {
      const fontFamily = getComputedStyle(diagram).fontFamily;
      await document.fonts?.load(`16px ${fontFamily}`, source);
      if (sequence !== renderSequence) return;
      diagram.innerHTML = window.whipRenderDiagram(source, diagram, sequence);
      const svg = diagram.querySelector('svg');
      if (!svg) throw new Error('Pele returned no SVG document');
      svg.setAttribute('role', 'img');
      send({ type: 'rendered', requestId });
    } catch (reason) {
      if (sequence !== renderSequence) return;
      diagram.replaceChildren();
      send({ type: 'error', message: reason instanceof Error ? reason.message : String(reason), requestId });
    }
  };
  send({ type: 'ready' });
})();
