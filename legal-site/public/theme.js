/* eslint-env browser */
'use strict';

(() => {
  const STORAGE_KEY = 'whip.theme';
  const LIGHT = 'light';
  const DARK = 'dark';
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = null;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === LIGHT || stored === DARK) preference = stored;
  } catch {
    // The system theme still works when storage is unavailable.
  }

  const apply = () => {
    const theme = preference ?? (system.matches ? DARK : LIGHT);
    document.documentElement.dataset.theme = theme;
    const button = document.querySelector('.theme-toggle');
    if (button) {
      button.hidden = false;
      const label = `Use ${theme === DARK ? LIGHT : DARK} theme`;
      button.setAttribute('aria-label', label);
      button.title = label;
    }
  };

  apply();
  system.addEventListener('change', apply);
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    document.querySelector('.theme-toggle')?.addEventListener('click', () => {
      preference =
        document.documentElement.dataset.theme === DARK ? LIGHT : DARK;
      try {
        localStorage.setItem(STORAGE_KEY, preference);
      } catch {
        // Theme selection remains usable for the current page.
      }
      apply();
    });
  });
})();
