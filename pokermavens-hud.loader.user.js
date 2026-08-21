// ==UserScript==
// @name         Poker Mavens HUD — Big O (PLO5 Hi-Lo)
// @namespace    pokermavens-hud
// @version      1.0.0
// @description  Loader: fetches and runs the latest Poker Mavens HUD from GitHub on every page load, so you always have the newest version with no manual update step. Stays inert until a Poker Mavens client is detected.
// @match        http://*/*
// @match        https://*/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      raw.githubusercontent.com
// ==/UserScript==

/*
 * This is a thin loader. It almost never changes. The real HUD lives at the
 * SRC url below and is fetched fresh each page load (cache-busted), so pushing
 * to the repo = instantly live on your next reload, no Tampermonkey update.
 *
 * The fetched code uses GM_getValue/GM_setValue; because it is eval'd in THIS
 * loader's scope (direct eval), it inherits the GM_* grants declared above.
 */
(function () {
  'use strict';
  var SRC = 'https://raw.githubusercontent.com/ChadKatzen/hud/main/pokermavens-hud.user.js';

  function run(code) {
    try {
      // Direct eval keeps GM_getValue/GM_setValue (loader grants) in scope for
      // the fetched HUD code.
      eval(code); // eslint-disable-line no-eval
    } catch (e) {
      console.error('[ddhud loader] error running HUD code:', e);
    }
  }

  GM_xmlhttpRequest({
    method: 'GET',
    url: SRC + '?_=' + Date.now(), // cache-bust so every reload gets latest
    onload: function (r) {
      if (r.status >= 200 && r.status < 300 && r.responseText) run(r.responseText);
      else console.error('[ddhud loader] fetch failed, status', r.status);
    },
    onerror: function (e) { console.error('[ddhud loader] network error:', e); },
  });
})();
