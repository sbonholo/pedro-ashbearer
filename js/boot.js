/* ASHBEARER :: boot.js (classic script, the only one index.html loads directly)
   1. Friendly error toast for uncaught errors / unhandled promise rejections ("Something went wrong - tap to reload").
   2. Real loading progress: download phase (each file's completion, weighted by its size) then the engine init steps
      (js/main.js reports them through ABBoot.step).
   3. Loads vendor/three.bundle.js and the game files in order (parallel download, ordered execution).
   Works from a web server and from file:// (classic scripts only, no ES modules / import maps). */
(function () {
  'use strict';
  var root = document.getElementById('ab-loading');
  var bar = root && root.querySelector('.ab-loading-bar');
  var fill = bar && bar.firstElementChild;
  var text = root && root.querySelector('.ab-loading-text');

  // ------------------------------------------------------------------ error toast
  var toast = null;
  function showToast() {
    if (toast) return;
    toast = document.createElement('button');
    toast.type = 'button';
    toast.className = 'ab-crash';
    toast.setAttribute('role', 'alert');
    toast.textContent = 'Something went wrong - tap to reload';
    toast.style.cssText = 'position:fixed;left:50%;bottom:max(16px,env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:9999;' +
      'min-height:44px;max-width:calc(100% - 32px);padding:10px 18px;border:1px solid rgba(232,226,207,.35);border-radius:6px;' +
      'background:rgba(14,19,26,.94);color:#e8e2cf;font:15px/1.3 Alegreya,Georgia,serif;cursor:pointer;box-shadow:0 4px 18px rgba(0,0,0,.5)';
    toast.addEventListener('click', function () { location.reload(); });
    (document.body || document.documentElement).appendChild(toast);
  }
  function isNoise(msg) {
    // benign browser noise that does not break the game
    return /ResizeObserver loop|Script error\.?$/i.test(String(msg || ''));
  }
  window.onerror = function (msg) { if (!isNoise(msg)) showToast(); return false; };
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    if (r && (r.name === 'AbortError' || r.name === 'NotAllowedError')) return; // audio autoplay / aborted fetches
    showToast();
  });

  // ------------------------------------------------------------------ progress
  var DL = 0.65;            // share of the bar for downloading; the rest is engine init
  var shown = 0;
  function set(p) {
    p = Math.max(shown, Math.min(1, p));
    shown = p;
    if (fill) fill.style.transform = 'scaleX(' + p.toFixed(3) + ')';
    if (bar) bar.setAttribute('aria-valuenow', String(Math.round(p * 100)));
  }
  window.ABBoot = {
    // called by js/main.js for each init step (i of n done)
    step: function (i, n) { set(DL + (1 - DL) * (i / n)); },
    done: function () { set(1); if (root) root.removeAttribute('data-boot'); },
    progress: function () { return shown; },
    toast: showToast
  };

  // ------------------------------------------------------------------ load files (weights ~ size in KB; only shape the bar)
  var FILES = [
    ['vendor/three.bundle.js', 775],
    ['js/content.js', 100],
    ['js/core.js', 50],
    ['js/textures.js', 45],
    ['js/world.js', 250],
    ['js/actors.js', 235],
    ['js/vfx.js', 75],
    ['js/combat.js', 120],
    ['js/ui.js', 90],
    ['js/audio.js', 40],
    ['js/game.js', 80],
    ['js/main.js', 5]
  ];
  var total = 0, got = 0, failed = false;
  for (var i = 0; i < FILES.length; i++) total += FILES[i][1];
  set(0.02);
  FILES.forEach(function (f) {
    var s = document.createElement('script');
    s.src = f[0];
    s.async = false;      // ordered execution, parallel download
    s.onload = function () { got += f[1]; set(DL * (got / total)); };
    s.onerror = function () {
      if (failed) return;
      failed = true;
      if (text) text.textContent = 'Part of the road failed to load (' + f[0] + '). Check your connection and reload.';
      showToast();
    };
    document.body.appendChild(s);
  });

  // watchdog: never leave a silent loading screen
  setTimeout(function () {
    if (window.AB && window.AB.core && window.AB.core.ready) return;
    if (text && !failed) text.textContent = 'The road is slow to open. If this persists, check your connection and reload.';
  }, 20000);
})();
