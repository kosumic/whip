/* eslint-env browser */
/* global pele */
(() => {
  'use strict';
  const MAX_SOURCE_CHARACTERS = 100_000;
  const MAX_EDGES = 500;
  window.whipRenderDiagram = (source, container, id) => {
    if (!window.pele?.render) throw new Error('The bundled Pele renderer did not load');
    if (typeof source !== 'string' || !source.trim()) throw new Error('The Mermaid document is empty');
    const fontFamily = getComputedStyle(container).fontFamily;
    return pele.render(source, {
      fontFamily,
      fontFamilyMono: 'WhipChatCJK, "JetBrains Mono", monospace',
      idPrefix: `whip-diagram-${id}`,
      maxWidth: container.clientWidth || window.innerWidth,
      limit: MAX_SOURCE_CHARACTERS,
      maxEdges: MAX_EDGES,
      links: false,
      images: false,
    }).svg;
  };
})();
