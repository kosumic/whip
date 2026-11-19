/* eslint-env browser */
'use strict';

(() => {
  const count = document.querySelector('[data-star-count]');
  if (!count) return;

  const CACHE_KEY = 'whip.github-stars';
  const CACHE_TTL_MS = 60 * 60 * 1000;
  const render = stars => {
    count.textContent = new Intl.NumberFormat('en').format(stars);
    count
      .closest('a')
      .setAttribute('aria-label', `Whip on GitHub — ${stars} stars`);
  };
  const useFallback = () => {
    count.title = 'Last known GitHub star count';
  };

  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null');
    if (
      Number.isSafeInteger(cached?.stars) &&
      cached.stars >= 0 &&
      Number.isFinite(cached.updatedAt) &&
      Date.now() - cached.updatedAt < CACHE_TTL_MS
    ) {
      render(cached.stars);
      return;
    }
  } catch {
    // Storage is optional; the visible count remains available without it.
  }

  fetch('https://api.github.com/repos/kosumic/whip')
    .then(response => {
      if (!response.ok) throw new Error('GitHub star count unavailable');
      return response.json();
    })
    .then(({ stargazers_count: stars }) => {
      if (!Number.isSafeInteger(stars) || stars < 0) return;
      render(stars);
      try {
        localStorage.setItem(
          CACHE_KEY,
          JSON.stringify({ stars, updatedAt: Date.now() }),
        );
      } catch {
        // Browsers may disable storage while still allowing the public API.
      }
    })
    .catch(useFallback);
})();
