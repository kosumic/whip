/* eslint-env browser */
/* global mermaid */

(() => {
  'use strict';

  const MAX_SOURCE_CHARACTERS = 100_000;
  const MAX_EDGES = 500;
  let renderSequence = 0;

  const send = message => {
    window.ReactNativeWebView?.postMessage(JSON.stringify(message));
  };

  const errorMessage = reason => {
    if (reason instanceof Error) return reason.message;
    if (typeof reason === 'string') return reason;
    return 'Unable to render this Mermaid diagram';
  };

  window.herdrRenderMermaid = async (source, appearance, requestId) => {
    const diagram = document.getElementById('diagram');
    if (!diagram) {
      send({ type: 'error', message: 'The Mermaid preview document is incomplete', requestId });
      return;
    }

    diagram.replaceChildren();
    document.documentElement.dataset.appearance = appearance === 'light' ? 'light' : 'dark';

    if (typeof source !== 'string' || source.length === 0) {
      send({ type: 'error', message: 'The Mermaid document is empty', requestId });
      return;
    }
    if (source.length > MAX_SOURCE_CHARACTERS) {
      send({ type: 'error', message: 'The Mermaid document is too large to preview', requestId });
      return;
    }
    if (!window.mermaid?.render) {
      send({ type: 'error', message: 'The bundled Mermaid renderer did not load', requestId });
      return;
    }

    try {
      const fontFamily = getComputedStyle(document.body).fontFamily;
      // Mermaid measures labels during rendering, so load fonts before layout.
      await document.fonts?.load(`16px ${fontFamily}`, source);
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        suppressErrorRendering: true,
        maxEdges: MAX_EDGES,
        maxTextSize: MAX_SOURCE_CHARACTERS,
        htmlLabels: true,
        flowchart: { htmlLabels: true },
        theme: appearance === 'light' ? 'default' : 'dark',
        fontFamily,
      });
      const id = `whip-mermaid-${++renderSequence}`;
      const result = await mermaid.render(id, source);
      diagram.innerHTML = result.svg;
      const svg = diagram.querySelector('svg');
      if (!svg) throw new Error('Mermaid returned no SVG document');
      svg.setAttribute('role', 'img');
      svg.removeAttribute('height');
      send({ type: 'rendered', requestId });
    } catch (reason) {
      diagram.replaceChildren();
      send({ type: 'error', message: errorMessage(reason), requestId });
    }
  };

  send({ type: 'ready' });
})();
