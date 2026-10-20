/* eslint-env browser */
/* global DOMPurify */

(() => {
  'use strict';

  let currentRequest;

  const send = message => {
    window.ReactNativeWebView?.postMessage(JSON.stringify(message));
  };

  const errorMessage = reason => {
    if (reason instanceof Error) return reason.message;
    if (typeof reason === 'string') return reason;
    return 'Unable to render this Mermaid diagram';
  };

  // Layout and SVG generation happen in Rust. This document only displays the result.
  window.herdrShowMermaid = async (source, appearance, requestId) => {
    currentRequest = requestId;
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
    try {
      const fontFamily = getComputedStyle(document.body).fontFamily;
      await document.fonts?.load(`16px ${fontFamily}`, source);
      if (currentRequest !== requestId) return;
      diagram.innerHTML = DOMPurify.sanitize(source, {
        USE_PROFILES: { svg: true, svgFilters: true },
        FORBID_TAGS: ['foreignObject', 'image'],
      });
      const svg = diagram.querySelector('svg');
      if (!svg) throw new Error('Merman returned no SVG document');
      svg.setAttribute('role', 'img');
      svg.removeAttribute('height');
      send({ type: 'rendered', requestId });
    } catch (reason) {
      if (currentRequest !== requestId) return;
      diagram.replaceChildren();
      send({ type: 'error', message: errorMessage(reason), requestId });
    }
  };

  send({ type: 'ready' });
})();
