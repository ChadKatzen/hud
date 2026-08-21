// ==UserScript==
// @name         Poker Mavens HUD — Big O (PLO5 Hi-Lo)
// @namespace    pokermavens-hud
// @version      0.6.0
// @description  Heads-up display for Poker Mavens 5-card PL Omaha Hi-Lo: a clean per-table HUD panel with per-villain stats, header tooltips, and click-to-edit notes/tags. Durable Tampermonkey storage with JSON backup/restore, plus a ground-truth recorder to calibrate the action parser against live hands.
// @match        http://*/*
// @match        https://*/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @updateURL    https://raw.githubusercontent.com/ChadKatzen/hud/main/pokermavens-hud.user.js
// @downloadURL  https://raw.githubusercontent.com/ChadKatzen/hud/main/pokermavens-hud.user.js
// ==/UserScript==
//
// The @match is intentionally broad so this public file contains no server
// address. The script stays completely inert on ordinary pages: it only
// initializes once a Poker Mavens client is detected in the page DOM (see
// boot()). Point it at your own table simply by having this installed and
// opening the site — nothing to configure, and no host is stored here.

/*
 * STATUS: v0.2. Presentation is a draggable HUD panel (one per open table).
 * Stats show "–" until the action parser is calibrated against live hands via
 * the built-in recorder (see DESIGN.md). Notes + tags are fully working.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------
  const LS = {
    STATS: 'ddhud.stats.v1',
    NOTES: 'ddhud.notes.v1',
    TAGS:  'ddhud.tagvocab.v1',
    REC:   'ddhud.recorder.v1',
    CFG:   'ddhud.config.v1',
  };
  // Durable storage: prefer Tampermonkey's GM store (survives site-data clears,
  // rides TM cloud sync), fall back to page localStorage. On first run under GM,
  // migrate any existing localStorage data across so nothing is lost.
  const hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
  const lsGet = (k) => { try { const v = localStorage.getItem(k); return v == null ? undefined : JSON.parse(v); } catch { return undefined; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  function migrateFromLS() {
    if (!hasGM) return;
    for (const k of Object.values(LS)) {
      if (GM_getValue(k, undefined) === undefined) { const v = lsGet(k); if (v !== undefined) GM_setValue(k, v); }
    }
  }
  const load = (k, d) => { const v = hasGM ? GM_getValue(k, undefined) : lsGet(k); return v === undefined ? d : v; };
  const save = (k, v) => { if (hasGM) GM_setValue(k, v); else lsSet(k, v); };
  const storageMode = () => (hasGM ? 'Tampermonkey (durable)' : 'browser localStorage');
  migrateFromLS();

  const DEFAULT_TAGS = [
    'half-pot bluff', 'overbets for value', 'limp-reraises', 'never folds flop',
    'donks weak', 'check-raise bluffs', 'nit pre', 'station',
    'bets big = strong', 'bets small = strong', 'hi-lo unaware',
  ];

  const store = {
    stats: load(LS.STATS, {}),
    notes: load(LS.NOTES, {}),
    tags:  load(LS.TAGS, DEFAULT_TAGS.slice()),
    rec:   load(LS.REC, []),
    cfg:   load(LS.CFG, { recording: true, showHud: true }),
  };

  // ---------------------------------------------------------------------------
  // Stat model
  // ---------------------------------------------------------------------------
  function newStat() {
    return {
      hands: 0,
      vpip: c(), pfr: c(), limp: c(), limpReraise: c(),
      threeBet: c(), foldTo3Bet: c(), call3Bet: c(), fourBet: c(),
      coldCall: c(), squeeze: c(), steal: c(), foldToSteal: c(),
      rfi: {},
      cbet: c(), foldToCbet: c(), lead: c(), checkFlop: c(), checkRaise: c(),
      aggBet: 0, aggCall: 0,
      wtsd: c(), wsd: c(), wwsf: c(),
      lastSeen: 0,
    };
  }
  function c() { return { n: 0, k: 0 }; }
  function pct(cc) { return cc && cc.n ? Math.round((100 * cc.k) / cc.n) : null; }
  function statFor(name) { if (!store.stats[name]) store.stats[name] = newStat(); return store.stats[name]; }

  // Columns shown on the always-on grid: [key, header, tooltip, accessor]
  const COLUMNS = [
    ['hnd',  'HND',  'Hands — number of hands observed for this player (the sample size behind every stat).', (s) => s.hands || 0],
    ['vpip', 'VPIP', 'Voluntarily Put $ In Pot — % of hands the player limps, calls, or raises preflop (blinds checked for free don’t count). High = loose.', (s) => pct(s.vpip)],
    ['pfr',  'PFR',  'Preflop Raise — % of hands the player raises preflop. Gap between VPIP and PFR shows how passive they are.', (s) => pct(s.pfr)],
    ['limp', 'LIMP', 'Limp — % of hands the player open-limps: just calls the big blind as the first player in the pot instead of raising.', (s) => pct(s.limp)],
    ['l3b',  'L3B',  'Limp-Reraise (limp-3bet) — % of the time that, after open-limping, the player re-raises when someone behind raises. Almost always a strong trap.', (s) => pct(s.limpReraise)],
    ['3b',   '3B',   '3-Bet — % of the time the player re-raises a preflop open (the first re-raise).', (s) => pct(s.threeBet)],
    ['cb',   'CB',   'Continuation Bet — % of the time the player bets the flop as the preflop raiser.', (s) => pct(s.cbet)],
    ['f3b',  'F3B',  'Fold to 3-Bet — % of the time the player folds after their open is 3-bet.', (s) => pct(s.foldTo3Bet)],
    ['chk',  'CHK',  'Check — % of the time the player checks the flop when given the option (first-to-act, no bet facing).', (s) => pct(s.checkFlop)],
  ];

  // ---------------------------------------------------------------------------
  // Table / seat reading (confirmed DOM model — see DESIGN.md)
  // ---------------------------------------------------------------------------
  function tableRoots() {
    return [...document.querySelectorAll('div.dialog')].filter(
      (d) => d.id && d.id[0] === 'R' && d.querySelector('.sp_seat')
    );
  }
  function tableName(root) {
    const t = root.querySelector('.header .title');
    return t ? (t.innerText || '').split(' - ')[0] : root.id;
  }
  function heroName(root) {
    const t = root.querySelector('.header .title');
    const m = t && /Logged in as\s+(\S+)/i.exec(t.innerText || '');
    return m ? m[1] : null;
  }
  function handNo(root) {
    const bar = root.querySelector('.infobar');
    const m = bar && /Hand\s*#\s*([\d-]+)/.exec(bar.innerText || '');
    return m ? m[1] : null;
  }
  function potOf(root) {
    const p = root.querySelector('.totalplate');
    const m = p && /([\d,]+)/.exec((p.innerText || '').replace(/Total/i, ''));
    return m ? num(m[1]) : 0;
  }
  function num(s) { return parseInt(String(s).replace(/[^\d]/g, ''), 10) || 0; }
  function txt(el) { return el ? (el.innerText || '').trim() : ''; }
  function isVisible(el) { return !!(el && el.offsetParent !== null && !el.classList.contains('hide')); }

  function readSeats(root) {
    return [...root.querySelectorAll('.sp_seat')].map((el, idx) => {
      const glow = el.querySelector('.sp_glow');
      return {
        idx, el,
        name: txt(el.querySelector('.sp_name')),
        info: txt(el.querySelector('.sp_info')),
        active: glow ? isVisible(glow) : false,
        committed: chipsInFront(el),
        stack: num(txt(el.querySelector('.sp_info'))),
        button: hasButton(el),
      };
    });
  }
  function hasButton(seatEl) { return !!seatEl.querySelector('.button, .dealerbutton, .sp_button'); }
  function chipsInFront(seatEl) { const cs = seatEl.querySelector('.chipstack'); return cs ? num(cs.innerText) : 0; }
  function boardCount(root) { return [...root.querySelectorAll('.card')].filter((cc) => isVisible(cc) && txt(cc)).length; }
  function streetName(n) { return n >= 5 ? 'river' : n === 4 ? 'turn' : n === 3 ? 'flop' : 'preflop'; }

  // ---------------------------------------------------------------------------
  // Ground-truth recorder
  // ---------------------------------------------------------------------------
  const recorder = {
    cur: null,
    start(root, hand) { this.cur = { hand, table: tableName(root), t0: new Date().toISOString(), frames: [] }; },
    frame(seats, pot, street) {
      if (!store.cfg.recording || !this.cur) return;
      this.cur.frames.push({
        pot, street,
        seats: seats.filter((s) => s.name).map((s) => ({
          i: s.idx, name: s.name, info: s.info, stack: s.stack,
          committed: s.committed, active: s.active, button: s.button,
        })),
      });
    },
    end() {
      if (this.cur && this.cur.frames.length) {
        store.rec.push(this.cur);
        if (store.rec.length > 400) store.rec = store.rec.slice(-400);
        save(LS.REC, store.rec);
      }
      this.cur = null;
    },
  };

  // ---------------------------------------------------------------------------
  // Per-table engine (hand detection + recorder feed). Action inference is
  // isolated in inferActions() so it can be rewritten after calibration.
  // ---------------------------------------------------------------------------
  const engines = new Map();
  function engineFor(root) {
    if (engines.has(root)) return engines.get(root);
    const eng = {
      root, hand: null, lastSig: '',
      onMutation() {
        const hand = handNo(root);
        if (hand && hand !== this.hand) { this.endHand(); this.startHand(hand); }
        if (!this.hand) return;
        const seats = readSeats(root);
        const pot = potOf(root);
        const street = streetName(boardCount(root));
        const sig = seats.map((s) => `${s.name}:${s.info}:${s.committed}:${s.active}`).join('|') + '#' + pot + '#' + street;
        if (sig === this.lastSig) return;
        this.lastSig = sig;
        recorder.frame(seats, pot, street);
      },
      startHand(hand) { this.hand = hand; this.lastSig = ''; recorder.start(root, hand); },
      endHand() { if (!this.hand) return; recorder.end(); this.hand = null; },
    };
    engines.set(root, eng);
    return eng;
  }
  function inferActions(/* handRecord */) { /* TODO: lock against recorder data */ }

  // ---------------------------------------------------------------------------
  // HUD panel (one per open table). Draggable; header tooltips; click-to-note.
  // ---------------------------------------------------------------------------
  const panels = new WeakMap();
  let panelOffset = 0;

  function renderPanels() {
    const roots = tableRoots();
    if (!store.cfg.showHud) { document.querySelectorAll('.ddhud-panel').forEach((p) => (p.style.display = 'none')); return; }
    for (const root of roots) {
      let p = panels.get(root);
      if (!p || !p.isConnected) { p = buildPanel(root); panels.set(root, p); }
      p.style.display = 'block';
      paintPanel(p, root);
    }
  }

  function buildPanel(root) {
    const p = document.createElement('div');
    p.className = 'ddhud-panel';
    p.style.top = (70 + panelOffset) + 'px';
    p.style.right = (16 + panelOffset) + 'px';
    panelOffset = (panelOffset + 30) % 120;
    p.innerHTML =
      `<div class="ddhud-hd"><span class="sp">HUD <span class="sub"></span></span>` +
      `<span class="ddhud-min" title="Collapse/expand">–</span></div>` +
      `<div class="ddhud-body"><table class="ddhud-tbl"><thead><tr>` +
      `<th class="l" data-tip="Player name. Click a row to add notes and behavior tags.">Player</th>` +
      COLUMNS.map(([k, h, tip]) => `<th data-tip="${esc(tip)}">${h}</th>`).join('') +
      `</tr></thead><tbody></tbody></table>` +
      `<div class="ddhud-cap"></div></div>`;
    document.body.appendChild(p);
    makeDraggable(p, p.querySelector('.ddhud-hd'));
    p.querySelector('.ddhud-min').addEventListener('click', (e) => {
      e.stopPropagation();
      p.classList.toggle('ddhud-collapsed');
      p.querySelector('.ddhud-min').textContent = p.classList.contains('ddhud-collapsed') ? '+' : '–';
    });
    attachTooltips(p);
    return p;
  }

  function paintPanel(p, root) {
    p.querySelector('.ddhud-hd .sub').textContent = '— ' + tableName(root);
    const hero = heroName(root);
    const seated = readSeats(root).filter((s) => s.name);
    const tbody = p.querySelector('tbody');
    tbody.innerHTML = seated.map((s) => {
      const st = store.stats[s.name] || newStat();
      const note = store.notes[s.name];
      const cells = COLUMNS.map(([k, h, tip, get]) => {
        const v = get(st);
        return `<td>${v == null ? '<span class="dash">–</span>' : v}</td>`;
      }).join('');
      const tag = note && note.tags && note.tags.length ? ` <span class="ddhud-tag">${esc(note.tags[0])}${note.tags.length > 1 ? '+' + (note.tags.length - 1) : ''}</span>` : '';
      const dot = note && ((note.tags && note.tags.length) || (note.text || '').trim()) ? '<span class="ddhud-note-dot" title="has notes">●</span>' : '';
      return `<tr class="${s.name === hero ? 'hero' : ''}" data-player="${esc(s.name)}">` +
        `<td class="l"><span class="ddhud-nm">${esc(s.name)}</span>${dot}${tag}</td>${cells}</tr>`;
    }).join('') || `<tr><td class="l ddhud-empty" colspan="${COLUMNS.length + 1}">no players seated</td></tr>`;
    tbody.querySelectorAll('tr[data-player]').forEach((tr) => {
      tr.addEventListener('click', () => openNotes(tr.dataset.player));
    });
    const capBits = [];
    if (seated.every((s) => !(store.stats[s.name] && store.stats[s.name].hands))) capBits.push('Stats show “–” until calibrated.');
    if (store.cfg.recording) capBits.push('Recording ●');
    p.querySelector('.ddhud-cap').textContent = capBits.join('   ');
  }

  // ---------------------------------------------------------------------------
  // Tooltip (custom, follows header hover) — expands the stat acronyms.
  // ---------------------------------------------------------------------------
  let tipEl = null;
  function attachTooltips(scope) {
    scope.querySelectorAll('[data-tip]').forEach((el) => {
      el.addEventListener('mouseenter', () => showTip(el));
      el.addEventListener('mousemove', moveTip);
      el.addEventListener('mouseleave', hideTip);
    });
  }
  function showTip(el) {
    hideTip();
    tipEl = document.createElement('div');
    tipEl.className = 'ddhud-tip';
    tipEl.textContent = el.getAttribute('data-tip');
    document.body.appendChild(tipEl);
  }
  function moveTip(e) {
    if (!tipEl) return;
    const pad = 14, w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    let x = e.clientX + pad, y = e.clientY + pad;
    if (x + w > innerWidth - 8) x = e.clientX - w - pad;
    if (y + h > innerHeight - 8) y = e.clientY - h - pad;
    tipEl.style.left = x + 'px';
    tipEl.style.top = y + 'px';
  }
  function hideTip() { if (tipEl) { tipEl.remove(); tipEl = null; } }

  // ---------------------------------------------------------------------------
  // Notes popup: preset tags (extensible) + freeform text, per player.
  // ---------------------------------------------------------------------------
  let notesEl = null;
  function openNotes(name) {
    if (!name) return;
    closeNotes();
    const note = store.notes[name] || { tags: [], text: '' };
    if (!note.tags) note.tags = [];
    const el = document.createElement('div');
    el.className = 'ddhud-notes';
    el.innerHTML = `
      <div class="ddhud-notes-hd">Notes — <b>${esc(name)}</b><span class="ddhud-x">×</span></div>
      <div class="ddhud-notes-tags"></div>
      <div class="ddhud-addtag">
        <select class="ddhud-tagsel"></select>
        <input class="ddhud-newtag" placeholder="new tag…" />
        <button class="ddhud-addbtn">Add</button>
      </div>
      <textarea class="ddhud-text" placeholder="freeform read…">${esc(note.text || '')}</textarea>`;
    document.body.appendChild(el);
    notesEl = el;
    makeDraggable(el, el.querySelector('.ddhud-notes-hd'));

    const tagsWrap = el.querySelector('.ddhud-notes-tags');
    const sel = el.querySelector('.ddhud-tagsel');
    const persist = () => { store.notes[name] = note; save(LS.NOTES, store.notes); renderPanels(); };
    const redraw = () => {
      tagsWrap.innerHTML = note.tags.map((t, i) => `<span class="ddhud-chip" data-i="${i}">${esc(t)} <b>×</b></span>`).join('') || '<i class="ddhud-none">no tags yet</i>';
      tagsWrap.querySelectorAll('.ddhud-chip').forEach((chip) => chip.addEventListener('click', () => { note.tags.splice(+chip.dataset.i, 1); persist(); redraw(); }));
      sel.innerHTML = '<option value="">+ preset tag…</option>' + store.tags.filter((t) => !note.tags.includes(t)).map((t) => `<option>${esc(t)}</option>`).join('');
    };
    sel.addEventListener('change', () => { if (sel.value) { note.tags.push(sel.value); persist(); redraw(); } });
    el.querySelector('.ddhud-addbtn').addEventListener('click', () => {
      const v = el.querySelector('.ddhud-newtag').value.trim();
      if (!v) return;
      if (!store.tags.includes(v)) { store.tags.push(v); save(LS.TAGS, store.tags); }
      if (!note.tags.includes(v)) note.tags.push(v);
      el.querySelector('.ddhud-newtag').value = ''; persist(); redraw();
    });
    el.querySelector('.ddhud-newtag').addEventListener('keydown', (e) => { if (e.key === 'Enter') el.querySelector('.ddhud-addbtn').click(); });
    el.querySelector('.ddhud-text').addEventListener('input', (e) => { note.text = e.target.value; persist(); });
    el.querySelector('.ddhud-x').addEventListener('click', closeNotes);
    redraw();
    el.querySelector('.ddhud-newtag').focus();
  }
  function closeNotes() { if (notesEl) { notesEl.remove(); notesEl = null; } }

  // ---------------------------------------------------------------------------
  // Control panel (top-left "HUD" button)
  // ---------------------------------------------------------------------------
  function mountControl() {
    if (document.querySelector('.ddhud-ctrl')) return;
    const cd = document.createElement('div');
    cd.className = 'ddhud-ctrl';
    cd.innerHTML = `
      <button class="ddhud-tog" title="HUD options">HUD</button>
      <div class="ddhud-menu">
        <label><input type="checkbox" class="ddhud-cb-hud"> Show HUD panel</label>
        <label><input type="checkbox" class="ddhud-cb-rec"> Record hands (calibration)</label>
        <div class="ddhud-count"></div>
        <div class="ddhud-sec">Backup</div>
        <button class="ddhud-backup">Export all HUD data (save file)</button>
        <label class="ddhud-importbtn">Import backup…<input type="file" accept="application/json,.json" hidden></label>
        <div class="ddhud-msg"></div>
        <div class="ddhud-sec">Calibration</div>
        <button class="ddhud-export">Copy capture to clipboard</button>
        <button class="ddhud-clearrec">Clear capture</button>
        <div class="ddhud-storage"></div>
      </div>`;
    document.body.appendChild(cd);
    const menu = cd.querySelector('.ddhud-menu');
    cd.querySelector('.ddhud-tog').addEventListener('click', () => { menu.classList.toggle('open'); syncControl(cd); });
    cd.querySelector('.ddhud-cb-hud').addEventListener('change', (e) => { store.cfg.showHud = e.target.checked; save(LS.CFG, store.cfg); renderPanels(); });
    cd.querySelector('.ddhud-cb-rec').addEventListener('change', (e) => { store.cfg.recording = e.target.checked; save(LS.CFG, store.cfg); });
    cd.querySelector('.ddhud-export').addEventListener('click', () => exportRec());
    cd.querySelector('.ddhud-clearrec').addEventListener('click', () => { store.rec = []; save(LS.REC, store.rec); syncControl(cd); });
    cd.querySelector('.ddhud-backup').addEventListener('click', () => exportAll(cd));
    cd.querySelector('.ddhud-importbtn input').addEventListener('change', (e) => importAll(e.target.files[0], cd));
    syncControl(cd);
  }
  function syncControl(cd) {
    cd.querySelector('.ddhud-cb-hud').checked = store.cfg.showHud;
    cd.querySelector('.ddhud-cb-rec').checked = store.cfg.recording;
    cd.querySelector('.ddhud-count').textContent = `${store.rec.length} hands captured`;
    const players = Object.keys(store.stats).length, notes = Object.keys(store.notes).length;
    cd.querySelector('.ddhud-storage').textContent = `Storage: ${storageMode()} · ${players} players, ${notes} noted`;
  }

  // Full backup/restore of every ddhud key as one JSON file.
  function saveAll() { save(LS.STATS, store.stats); save(LS.NOTES, store.notes); save(LS.TAGS, store.tags); save(LS.REC, store.rec); save(LS.CFG, store.cfg); }
  function exportAll(cd) {
    const data = { _app: 'ddhud', _v: 1, _exported: new Date().toISOString(), stats: store.stats, notes: store.notes, tags: store.tags, rec: store.rec, cfg: store.cfg };
    const json = JSON.stringify(data);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'ddhud-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    msg(cd, `Backed up ${Object.keys(store.stats).length} players + ${Object.keys(store.notes).length} notes.`);
  }
  function importAll(file, cd) {
    if (!file) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const d = JSON.parse(r.result);
        if (d._app !== 'ddhud') throw new Error('not a HUD backup file');
        if (d.stats) store.stats = d.stats;
        if (d.notes) store.notes = d.notes;
        if (d.tags) store.tags = d.tags;
        if (d.rec) store.rec = d.rec;
        if (d.cfg) store.cfg = Object.assign(store.cfg, d.cfg);
        saveAll(); renderPanels(); syncControl(cd);
        msg(cd, `Restored ${Object.keys(store.stats).length} players + ${Object.keys(store.notes).length} notes.`);
      } catch (e) { msg(cd, 'Import failed: ' + e.message, true); }
    };
    r.readAsText(file);
  }
  function msg(cd, text, err) { const m = cd.querySelector('.ddhud-msg'); m.textContent = text; m.style.color = err ? '#e08a8a' : '#8fd3a0'; }
  function exportRec() {
    const json = JSON.stringify(store.rec);
    window.__ddhudExport = json;
    try { navigator.clipboard.writeText(json); } catch {}
    console.log('[ddhud] capture copied to clipboard and window.__ddhudExport (' + store.rec.length + ' hands)');
  }

  // ---------------------------------------------------------------------------
  // Shared: dragging
  // ---------------------------------------------------------------------------
  function makeDraggable(el, handle) {
    let dx, dy, drag = false;
    handle.style.cursor = 'move';
    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('.ddhud-x, .ddhud-min')) return;
      drag = true; dx = e.clientX - el.offsetLeft; dy = e.clientY - el.offsetTop; e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => { if (drag) { el.style.left = (e.clientX - dx) + 'px'; el.style.right = 'auto'; el.style.top = (e.clientY - dy) + 'px'; } });
    window.addEventListener('mouseup', () => (drag = false));
  }

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------
  const CSS = `
  .ddhud-panel{position:fixed;z-index:100000;width:404px;background:rgba(14,17,26,.96);color:#e8eefc;
    font:12px/1.3 system-ui,-apple-system,sans-serif;border:1px solid #33415f;border-radius:10px;
    box-shadow:0 10px 40px rgba(0,0,0,.6);overflow:hidden}
  .ddhud-hd{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#1a2135;font-weight:600;user-select:none}
  .ddhud-hd .sp{flex:1}
  .ddhud-hd .sub{opacity:.55;font-weight:400;font-size:11px}
  .ddhud-min{cursor:pointer;opacity:.6;padding:0 4px;font-weight:700}
  .ddhud-collapsed .ddhud-body{display:none}
  .ddhud-tbl{width:100%;border-collapse:collapse}
  .ddhud-tbl th{font-size:9px;text-transform:uppercase;letter-spacing:.02em;color:#7f8db0;font-weight:600;padding:5px 3px;text-align:right;border-bottom:1px solid #2a3350;cursor:help}
  .ddhud-tbl th.l,.ddhud-tbl td.l{text-align:left;padding-left:10px}
  .ddhud-tbl td{padding:5px 3px;text-align:right;border-bottom:1px solid #1c2436;white-space:nowrap}
  .ddhud-tbl th:last-child,.ddhud-tbl td:last-child{padding-right:10px}
  .ddhud-tbl tbody tr{cursor:pointer}
  .ddhud-tbl tbody tr:hover td{background:#1a2135}
  .ddhud-tbl tr.hero td{background:#122a1e}
  .ddhud-tbl .dash{opacity:.35}
  .ddhud-nm{font-weight:600;max-width:96px;overflow:hidden;text-overflow:ellipsis;display:inline-block;vertical-align:bottom}
  .ddhud-note-dot{color:#e0b64a;font-size:9px;margin-left:3px;vertical-align:middle}
  .ddhud-tag{display:inline-block;background:#2a3350;border-radius:3px;padding:0 4px;font-size:9px;margin-left:4px;vertical-align:middle}
  .ddhud-empty{opacity:.5;text-align:center;padding:10px}
  .ddhud-cap{padding:5px 10px;font-size:10px;color:#7f8db0;background:#141a29}
  .ddhud-tip{position:fixed;z-index:100002;max-width:250px;background:#0b0e16;color:#e8eefc;border:1px solid #3a4a6a;
    border-radius:6px;padding:6px 8px;font:11px/1.35 system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.6);pointer-events:none}
  .ddhud-notes{position:fixed;top:90px;left:90px;width:250px;background:#141824;color:#e8eefc;border:1px solid #3a4a6a;
    border-radius:8px;z-index:100001;font:12px system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.6)}
  .ddhud-notes-hd{padding:8px 10px;border-bottom:1px solid #2a3350;font-weight:600;user-select:none}
  .ddhud-x{float:right;cursor:pointer;opacity:.6}
  .ddhud-notes-tags{display:flex;flex-wrap:wrap;gap:4px;padding:8px 10px}
  .ddhud-chip{background:#2a3350;border-radius:4px;padding:1px 6px;cursor:pointer;font-size:11px}
  .ddhud-chip b{opacity:.6}
  .ddhud-none{opacity:.4}
  .ddhud-addtag{display:flex;gap:4px;padding:0 10px 8px}
  .ddhud-addtag select,.ddhud-addtag input{flex:1;min-width:0;background:#0d1018;color:#e8eefc;border:1px solid #2a3350;border-radius:4px;padding:2px 4px}
  .ddhud-addbtn{background:#35507f;color:#fff;border:0;border-radius:4px;padding:2px 8px;cursor:pointer}
  .ddhud-text{width:calc(100% - 20px);margin:0 10px 10px;height:60px;background:#0d1018;color:#e8eefc;border:1px solid #2a3350;border-radius:4px;padding:4px;resize:vertical}
  .ddhud-ctrl{position:fixed;top:6px;left:6px;z-index:100000;font:12px system-ui,sans-serif}
  .ddhud-tog{background:#35507f;color:#fff;border:0;border-radius:5px;padding:4px 10px;cursor:pointer;font-weight:600}
  .ddhud-menu{display:none;margin-top:4px;background:#141824;color:#e8eefc;border:1px solid #3a4a6a;border-radius:8px;padding:8px;width:230px}
  .ddhud-menu.open{display:block}
  .ddhud-menu label{display:block;margin:4px 0}
  .ddhud-count{opacity:.6;font-size:11px;margin:6px 0}
  .ddhud-menu button{width:100%;margin-top:4px;background:#2a3350;color:#e8eefc;border:0;border-radius:5px;padding:4px;cursor:pointer}
  .ddhud-sec{margin:8px 0 2px;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#7f8db0}
  .ddhud-importbtn{display:block;margin-top:4px;background:#2a3350;color:#e8eefc;border-radius:5px;padding:4px;text-align:center;cursor:pointer}
  .ddhud-msg{font-size:11px;margin-top:5px;min-height:14px}
  .ddhud-storage{margin-top:8px;font-size:10px;color:#7f8db0}
  `;
  function esc(s) { return String(s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m])); }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  // Detect a Poker Mavens client by its DOM signature (no host/URL needed).
  function looksLikePokerMavens() {
    return !!(document.getElementById('client_div') || document.querySelector('.sp_seat, .totalplate, .tablecontent'));
  }

  let started = false;
  function start() {
    if (started) return;
    started = true;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    mountControl();
    const obs = new MutationObserver(() => { for (const root of tableRoots()) engineFor(root).onMutation(); });
    obs.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    setInterval(renderPanels, 800);
    console.log('[ddhud] Poker Mavens HUD loaded. Recording=' + store.cfg.recording);
    window.__ddhud = { store, tableRoots, readSeats, recorder, engines, renderPanels };
  }

  function boot() {
    // Broad @match loads this on every page, but we stay fully inert until a
    // Poker Mavens client is actually present — nothing renders elsewhere.
    if (looksLikePokerMavens()) return start();
    const probe = setInterval(() => { if (looksLikePokerMavens()) { clearInterval(probe); start(); } }, 1500);
  }
  boot();
})();
