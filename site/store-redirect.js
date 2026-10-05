/* eslint-env browser */
'use strict';

(() => {
  const { userAgent, platform, maxTouchPoints } = navigator;
  const isAppleMobile =
    /iPhone|iPad|iPod/i.test(userAgent) ||
    ((platform === 'MacIntel' || /Macintosh/i.test(userAgent)) &&
      maxTouchPoints > 1);
  const storeId = /Android/i.test(userAgent)
    ? 'play-store'
    : isAppleMobile
      ? 'app-store'
      : null;

  if (storeId) {
    const storeLink = document.getElementById(storeId);
    document.getElementById('status').textContent =
      'Opening your store… If it stays here, tap the link below.';
    window.location.replace(storeLink.href);
  }
})();
