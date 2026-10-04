/* global marked, DOMPurify, ResizeObserver */
(function () {
  'use strict';
  const root = document.getElementById('markdown');
  let requestId = 0;
  let scrollTimer;
  let imagesFinished = false;
  let layoutTimer;
  let previousContent;
  let diagrams = Promise.resolve();
  let mermaidLoader;
  const post = message => window.ReactNativeWebView?.postMessage(JSON.stringify({ ...message, requestId }));
  const isWebImage = target => /^(https?:)?\/\//i.test(target);
  const isRemoteImage = target => target && !/^[a-z][a-z\d+.-]*:/i.test(target) && !target.startsWith('//') && !target.startsWith('#');
  const dimensions = () => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight });
  const reportSize = () => {
    if (imagesFinished) post({ type: 'size', ...dimensions() });
  };

  window.herdrRenderMarkdown = (content, theme, id) => {
    requestId = id;
    imagesFinished = false;
    clearTimeout(layoutTimer);
    const previousY = previousContent === content ? window.scrollY : 0;
    previousContent = content;
    document.documentElement.style.colorScheme = theme.scheme;
    for (const [name, value] of Object.entries(theme.colors)) {
      document.documentElement.style.setProperty(`--${name}`, value);
    }
    // Sanitize before insertion. Remote/local image sources are supplied only by the native cache.
    const fragment = DOMPurify.sanitize(marked.parse(content, { gfm: true, breaks: false }), {
      RETURN_DOM_FRAGMENT: true,
      ALLOWED_TAGS: ['p', 'br', 'hr', 'div', 'span', 'strong', 'b', 'em', 'i', 'del', 's', 'a', 'img', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'details', 'summary', 'input'],
      ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'width', 'height', 'align', 'colspan', 'rowspan', 'start', 'type', 'checked', 'disabled', 'class'],
      ALLOW_DATA_ATTR: false,
    });
    const targets = new Set();
    for (const image of fragment.querySelectorAll('img')) {
      const target = image.getAttribute('src') || '';
      image.removeAttribute('src');
      image.addEventListener('load', reportSize);
      image.addEventListener('error', reportSize);
      if (isWebImage(target)) image.src = target.startsWith('//') ? `https:${target}` : target;
      else if (isRemoteImage(target)) {
        image.dataset.remoteImage = target;
        targets.add(target);
      }
      // A height attribute must not stretch an image constrained by a narrow viewport.
      image.removeAttribute('height');
    }
    for (const table of fragment.querySelectorAll('table')) {
      if (table.querySelector('img')) table.classList.add('image-table');
      const wrapper = document.createElement('div');
      wrapper.className = 'table-scroll';
      table.replaceWith(wrapper);
      wrapper.append(table);
    }
    const headingIds = new Set();
    for (const heading of fragment.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
      const slug = heading.textContent.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-');
      let anchorId = slug;
      let suffix = 0;
      while (headingIds.has(anchorId)) anchorId = `${slug}-${++suffix}`;
      headingIds.add(anchorId);
      heading.id = anchorId;
    }
    root.replaceChildren(fragment);
    diagrams = renderDiagrams(id, theme.scheme);
    window.scrollTo(0, previousY);
    reportSize();
    post({ type: 'images', targets: [...targets] });
  };

  // Restore reading position only after cached images and web images establish page height.
  window.herdrFinishMarkdownImages = async id => {
    await diagrams;
    if (id !== requestId) return;
    const finish = () => {
      if (id !== requestId) return;
      imagesFinished = true;
      reportSize();
    };
    const pending = [...root.querySelectorAll('img[src]')].filter(image => !image.complete);
    if (!pending.length) { finish(); return; }
    let remaining = pending.length;
    const settled = () => { if (--remaining === 0) { clearTimeout(layoutTimer); finish(); } };
    for (const image of pending) {
      image.addEventListener('load', settled, { once: true });
      image.addEventListener('error', settled, { once: true });
    }
    layoutTimer = setTimeout(finish, 10_000);
  };

  function loadMermaid() {
    if (window.mermaid) return Promise.resolve(window.mermaid);
    if (!mermaidLoader) mermaidLoader = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'mermaid.min.js';
      script.onload = () => resolve(window.mermaid);
      script.onerror = () => reject(new Error('Mermaid could not load'));
      document.body.append(script);
    });
    return mermaidLoader;
  }

  async function renderDiagrams(id, appearance) {
    let sequence = 0;
    for (const code of root.querySelectorAll('pre > code.language-mermaid, pre > code.language-svg')) {
      try {
        let svg;
        if (code.classList.contains('language-mermaid')) {
          const renderer = await loadMermaid();
          const fontFamily = window.getComputedStyle(document.body).fontFamily;
          await document.fonts?.load(`16px ${fontFamily}`, code.textContent);
          renderer.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
            maxEdges: 500, maxTextSize: 512 * 1024, theme: appearance === 'light' ? 'default' : 'dark', fontFamily });
          svg = (await renderer.render(`markdown-diagram-${id}-${++sequence}`, code.textContent)).svg;
        } else {
          svg = DOMPurify.sanitize(code.textContent, { USE_PROFILES: { svg: true, svgFilters: true },
            FORBID_TAGS: ['foreignObject', 'image', 'style'] });
        }
        if (id !== requestId || !code.isConnected) return;
        const diagram = document.createElement('div');
        diagram.className = 'diagram';
        diagram.innerHTML = svg;
        if (diagram.querySelector('svg')) code.parentElement.replaceWith(diagram);
      } catch {
        // Invalid diagrams remain readable as fenced source.
      }
    }
  }

  window.herdrSetMarkdownImage = (id, target, uri) => {
    if (id !== requestId || !/^data:image\/(png|jpeg|gif|webp|bmp);base64,[a-z\d+/=]+$/i.test(uri)) return;
    for (const image of root.querySelectorAll('img[data-remote-image]')) {
      if (image.dataset.remoteImage === target) image.src = uri;
    }
  };
  root.addEventListener('click', event => {
    const link = event.target.closest('a');
    if (!link) return;
    event.preventDefault();
    const target = link.getAttribute('href');
    if (!target) return;
    if (target.startsWith('#')) {
      try { document.getElementById(decodeURIComponent(target.slice(1)))?.scrollIntoView(); } catch { /* malformed fragment */ }
    } else post({ type: 'link', target });
  });
  window.addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => post({ type: 'position', x: window.scrollX, y: window.scrollY, ...dimensions() }), 250);
  });
  new ResizeObserver(reportSize).observe(root);
  post({ type: 'ready' });
}());
