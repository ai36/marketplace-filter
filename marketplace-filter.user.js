// ==UserScript==
// @name         Marketplace Filter
// @namespace    https://github.com/ai36/marketplace-filter
// @version      2.4.1
// @description  Filter + status markers for Facebook Marketplace listings
// @author       local
// @match        https://www.facebook.com/marketplace/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ── Card helpers ─────────────────────────────────────────────────────────────

  function getCards() {
    return Array.from(
      document.querySelectorAll('a[href*="/marketplace/item/"]')
    ).filter(card => !card.closest('[role="dialog"]'));
  }

  // Price: "$4,995" or "4 995 $" or bare "4,995"
  const PRICE_SEGMENT_RE = /^\$?[\d,.\s]+\$?$/;
  // Listing ID: any segment containing 8+ consecutive digits (e.g. "объявление 2048088512449409")
  const LISTING_ID_RE = /\d{8,}/;

  function isNoiseSegment(part) {
    const t = part.trim();
    return PRICE_SEGMENT_RE.test(t) || LISTING_ID_RE.test(t);
  }

  function getCardTitle(card) {
    const label = card.getAttribute('aria-label');
    if (label) {
      // aria-label: "Title, 4 995 $, Portland, OR, объявление 2048088512449409"
      return label
        .split(/,\s*/)
        .filter(part => !isNoiseSegment(part))
        .join(' ')
        .toLowerCase();
    }
    // Fallback: collect non-noise spans (title + city)
    const parts = [];
    card.querySelectorAll('span').forEach((span) => {
      const text = span.textContent.trim();
      if (text && text.length > 2 && !isNoiseSegment(text)) {
        parts.push(text);
      }
    });
    return parts.join(' ').toLowerCase();
  }

  // Item ID extracted from the listing URL — stable unique identifier
  function getItemId(card) {
    const href = card.getAttribute('href') || '';
    const m = href.match(/\/marketplace\/item\/(\d+)/);
    return m ? m[1] : null;
  }

  // ── Status storage ───────────────────────────────────────────────────────────

  const LS_PREFIX = 'fmp_status_';

  function loadStatus(id) {
    return GM_getValue(LS_PREFIX + id, null);
  }

  function saveStatus(id, status) {
    if (status) {
      GM_setValue(LS_PREFIX + id, status);
    } else {
      GM_deleteValue(LS_PREFIX + id);
    }
  }

  // ── Search history ────────────────────────────────────────────────────────────

  const HISTORY_KEY = 'fmp_history';
  const HISTORY_MAX = 10;

  function loadHistory() {
    return GM_getValue(HISTORY_KEY, []);
  }

  function pushHistory(query) {
    const q = query.trim();
    if (!q) return;
    const hist = loadHistory().filter(h => h !== q);
    hist.unshift(q);
    GM_setValue(HISTORY_KEY, hist.slice(0, HISTORY_MAX));
  }

  // ── Note storage ─────────────────────────────────────────────────────────────

  const LS_NOTE_PREFIX = 'fmp_note_';

  function loadNote(id) {
    return GM_getValue(LS_NOTE_PREFIX + id, '');
  }

  function saveNote(id, text) {
    const trimmed = text.trim().slice(0, 50);
    if (trimmed) {
      GM_setValue(LS_NOTE_PREFIX + id, trimmed);
    } else {
      GM_deleteValue(LS_NOTE_PREFIX + id);
    }
  }

  // ── Status definitions — Lucide-style inline SVG ──────────────────────────────

  function makeSvg(inner) {
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" ' +
      'viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
      inner +
      '</svg>'
    );
  }

  // circle-check  /  ban  /  star  (Lucide icon paths)
  const STATUSES = [
    {
      id: 'good',
      title: 'Подходит — можно рассмотреть',
      color: '#22c55e',
      icon: makeSvg(
        '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>'
      ),
    },
    {
      id: 'bad',
      title: 'Не подходит',
      color: '#ef4444',
      icon: makeSvg(
        '<circle cx="12" cy="12" r="10"/>' +
        '<line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>'
      ),
    },
    {
      id: 'later',
      title: 'Рассмотреть позже',
      color: '#f59e0b',
      icon: makeSvg(
        '<path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88' +
        'L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>'
      ),
    },
  ];

  // ── Query parser ─────────────────────────────────────────────────────────────
  //
  // Grammar:
  //   query = and
  //   and   = or ( '+' or )*
  //   or    = atom ( '|' atom )*
  //   atom  = '(' and ')' | word

  function parseQuery(raw) {
    const input = raw.trim().toLowerCase();
    if (!input) return () => true;

    let pos = 0;

    function peek() { return input[pos]; }
    function consume() { return input[pos++]; }

    function parseAtom() {
      if (peek() === '(') {
        consume();
        const pred = parseAnd();
        if (peek() === ')') consume();
        return pred;
      }
      let word = '';
      while (pos < input.length && !/[+|()\s]/.test(input[pos])) {
        word += consume();
      }
      while (pos < input.length && input[pos] === ' ') consume();
      if (!word) return () => true;
      return (title) => title.includes(word);
    }

    function parseOr() {
      const parts = [parseAtom()];
      while (peek() === '|') {
        consume();
        parts.push(parseAtom());
      }
      return parts.length === 1
        ? parts[0]
        : (title) => parts.some((p) => p(title));
    }

    function parseAnd() {
      const parts = [parseOr()];
      while (peek() === '+') {
        consume();
        parts.push(parseOr());
      }
      return parts.length === 1
        ? parts[0]
        : (title) => parts.every((p) => p(title));
    }

    return parseAnd();
  }

  // ── Filtering ────────────────────────────────────────────────────────────────

  let currentPredicate = () => true;
  const selectedStatuses = new Set(); // status ids chosen in the filter panel

  function cardMatchesFilters(card) {
    const textMatch = currentPredicate(getCardTitle(card));
    if (!textMatch) return false;
    if (selectedStatuses.size === 0) return true;
    const id = getItemId(card);
    const cardStatus = id ? loadStatus(id) : null;
    return selectedStatuses.has(cardStatus);
  }

  function refreshAllOverlays() {
    getCards().forEach((card) => {
      const id = getItemId(card);
      if (!id) return;
      const overlay = card.querySelector(`[${OVERLAY_MARKER}]`);
      if (!overlay) return;
      refreshButtons(overlay, id);
      const noteDisplay = overlay.querySelector('[data-fmp-note]');
      if (noteDisplay) {
        const note = loadNote(id);
        noteDisplay.textContent = note || '+ заметка';
        noteDisplay.style.color = note ? 'rgba(255,255,255,0.88)' : 'rgba(255,255,255,0.22)';
      }
    });
  }

  function clearAllData() {
    if (!confirm('Удалить все сохранённые статусы и заметки? Это действие нельзя отменить.')) return;
    GM_listValues().forEach((key) => {
      if (key.startsWith(LS_PREFIX) || key.startsWith(LS_NOTE_PREFIX)) {
        GM_deleteValue(key);
      }
    });
    applyFilter();
    refreshAllOverlays();
  }

  function injectStyle() {
    if (document.getElementById('fmp-style')) return;
    const style = document.createElement('style');
    style.id = 'fmp-style';
    style.textContent =
      'a[href*="/marketplace/item/"][data-fmp-bad]{opacity:0.4;transition:opacity 0.2s}\n' +
      'a[href*="/marketplace/item/"][data-fmp-bad]:hover{opacity:1}';
    document.head.appendChild(style);
  }

  function applyFilter() {
    getCards().forEach((card) => {
      const id = getItemId(card);
      const isBad = id && loadStatus(id) === 'bad';
      const matches = cardMatchesFilters(card);

      if (isBad && selectedStatuses.size === 0) {
        // no filter active: CSS handles 0.4 dim + hover restore
        card.dataset.fmpBad = '1';
        card.style.opacity = '';
        card.style.transition = '';
      } else if (isBad && !matches) {
        // other status filter active, bad card doesn't match: 0.1, no hover
        delete card.dataset.fmpBad;
        card.style.opacity = '0.1';
        card.style.transition = 'opacity 0.2s';
      } else {
        // matching cards (including bad when "bad" filter active): full opacity
        delete card.dataset.fmpBad;
        card.style.opacity = matches ? '' : '0.1';
        card.style.transition = matches ? '' : 'opacity 0.2s';
      }
    });
  }

  // ── Status overlay ───────────────────────────────────────────────────────────

  // Marker on the overlay element itself — survives React re-renders better
  // than an attribute on the <a> tag.
  const OVERLAY_MARKER = 'data-fmp-el';

  function refreshButtons(overlay, id) {
    const current = loadStatus(id);
    overlay.querySelectorAll('button[data-sid]').forEach((btn) => {
      const s = STATUSES.find((x) => x.id === btn.dataset.sid);
      if (!s) return;
      const active = current === s.id;
      btn.style.background = active ? s.color : 'rgba(255,255,255,0.12)';
      btn.style.color = active ? '#fff' : 'rgba(255,255,255,0.8)';
      btn.style.boxShadow = active ? `0 0 0 2px ${s.color}99` : 'none';
    });
  }

  function addStatusOverlay(card) {
    const id = getItemId(card);
    if (!id) return;

    // If overlay was removed (e.g. by FB re-render) re-inject it
    if (card.querySelector(`[${OVERLAY_MARKER}]`)) return;

    if (getComputedStyle(card).position === 'static') {
      card.style.position = 'relative';
    }

    // Outer wrapper — horizontal flex, two independent blocks
    const overlay = document.createElement('div');
    overlay.setAttribute(OVERLAY_MARKER, '1');
    Object.assign(overlay.style, {
      position: 'absolute',
      top: '6px',
      left: '6px',
      zIndex: '20',
      display: 'flex',
      flexDirection: 'row',
      alignItems: 'stretch',
      gap: '5px',
    });

    // ── Status block ────────────────────────────────────────────────────────────
    const statusBlock = document.createElement('div');
    Object.assign(statusBlock.style, {
      display: 'flex',
      gap: '3px',
      padding: '3px',
      borderRadius: '8px',
      background: 'rgba(0,0,0,0.45)',
      backdropFilter: 'blur(6px)',
      WebkitBackdropFilter: 'blur(6px)',
      alignItems: 'center',
    });

    STATUSES.forEach((s) => {
      const btn = document.createElement('button');
      btn.dataset.sid = s.id;
      btn.title = s.title;
      btn.innerHTML = s.icon;
      Object.assign(btn.style, {
        width: '28px',
        height: '28px',
        border: 'none',
        borderRadius: '6px',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0',
        flexShrink: '0',
        transition: 'background 0.15s, transform 0.12s, box-shadow 0.15s',
      });

      btn.addEventListener('mouseenter', () => {
        btn.style.transform = 'scale(1.2)';
        if (loadStatus(id) !== s.id) {
          btn.style.background = 'rgba(255,255,255,0.28)';
        }
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.transform = '';
        refreshButtons(overlay, id);
      });
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        saveStatus(id, loadStatus(id) === s.id ? null : s.id);
        refreshButtons(overlay, id);
        applyFilter();
      });

      statusBlock.appendChild(btn);
    });

    overlay.appendChild(statusBlock);

    // ── Note block ──────────────────────────────────────────────────────────────
    const noteBlock = document.createElement('div');
    Object.assign(noteBlock.style, {
      width: '130px',
      boxSizing: 'border-box',
      padding: '3px 6px',
      borderRadius: '8px',
      background: 'rgba(0,0,0,0.45)',
      backdropFilter: 'blur(6px)',
      WebkitBackdropFilter: 'blur(6px)',
      display: 'flex',
      alignItems: 'center',
      cursor: 'text',
    });

    const noteDisplay = document.createElement('div');
    noteDisplay.setAttribute('data-fmp-note', '1');
    const initialNote = loadNote(id);
    Object.assign(noteDisplay.style, {
      fontSize: '11px',
      lineHeight: '1',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      width: '100%',
      userSelect: 'none',
      color: initialNote ? 'rgba(255,255,255,0.88)' : 'rgba(255,255,255,0.22)',
    });
    noteDisplay.textContent = initialNote || '+ заметка';

    const noteInput = document.createElement('input');
    noteInput.type = 'text';
    noteInput.maxLength = 50;
    noteInput.placeholder = 'Заметка...';
    Object.assign(noteInput.style, {
      display: 'none',
      width: '100%',
      boxSizing: 'border-box',
      background: 'transparent',
      border: 'none',
      borderBottom: '1px solid rgba(255,255,255,0.4)',
      borderRadius: '0',
      color: '#fff',
      fontSize: '11px',
      padding: '0',
      outline: 'none',
      caretColor: '#4da6ff',
    });

    function enterEdit() {
      if (noteInput.style.display !== 'none') return;
      noteInput.value = loadNote(id);
      noteDisplay.style.display = 'none';
      noteInput.style.display = '';
      noteInput.focus();
      noteInput.select();
    }

    function exitEdit(save) {
      if (noteInput.style.display === 'none') return;
      noteInput.style.display = 'none';
      noteDisplay.style.display = '';
      if (save) {
        saveNote(id, noteInput.value);
        const saved = loadNote(id);
        noteDisplay.textContent = saved || '+ заметка';
        noteDisplay.style.color = saved ? 'rgba(255,255,255,0.88)' : 'rgba(255,255,255,0.22)';
      }
    }

    noteBlock.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); enterEdit(); });
    noteInput.addEventListener('click', (e) => e.stopPropagation());
    noteInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); exitEdit(true); }
      if (e.key === 'Escape') { e.preventDefault(); exitEdit(false); }
    });
    noteInput.addEventListener('blur', () => exitEdit(true));

    noteBlock.appendChild(noteDisplay);
    noteBlock.appendChild(noteInput);
    overlay.appendChild(noteBlock);

    refreshButtons(overlay, id);
    card.appendChild(overlay);
  }

  function applyOverlays() {
    getCards().forEach(addStatusOverlay);
  }

  // ── Filter UI panel ──────────────────────────────────────────────────────────

  function createUI() {
    const wrapper = document.createElement('div');
    wrapper.id = 'fmp-filter-box';
    Object.assign(wrapper.style, {
      position: 'fixed',
      bottom: '20px',
      left: '20px',
      zIndex: '99999',
      background: 'rgba(30, 30, 30, 0.92)',
      backdropFilter: 'blur(8px)',
      WebkitBackdropFilter: 'blur(8px)',
      borderRadius: '12px',
      padding: '10px 14px',
      boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
      minWidth: '260px',
      fontFamily: 'system-ui, sans-serif',
      userSelect: 'none',
    });

    // Header row
    const labelRow = document.createElement('div');
    Object.assign(labelRow.style, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '8px',
    });

    const label = document.createElement('span');
    label.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" ' +
      'fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" ' +
      'style="vertical-align:-1px">' +
      '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>' +
      '</svg> Фильтр объявлений';
    Object.assign(label.style, {
      color: '#e0e0e0',
      fontSize: '12px',
      fontWeight: '600',
      letterSpacing: '0.02em',
    });

    const toggleBtn = document.createElement('button');
    toggleBtn.textContent = '–';
    Object.assign(toggleBtn.style, {
      background: 'none',
      border: 'none',
      color: '#aaa',
      cursor: 'pointer',
      fontSize: '16px',
      lineHeight: '1',
      padding: '0 2px',
    });

    labelRow.appendChild(label);
    labelRow.appendChild(toggleBtn);

    // Search input wrapper
    const inputWrapper = document.createElement('div');
    Object.assign(inputWrapper.style, { position: 'relative', width: '100%' });

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'prius+prime | (prius|camry)+2017';
    Object.assign(input.style, {
      width: '100%',
      boxSizing: 'border-box',
      background: 'rgba(255,255,255,0.1)',
      border: '1px solid rgba(255,255,255,0.2)',
      borderRadius: '8px',
      color: '#fff',
      fontSize: '13px',
      padding: '7px 30px 7px 10px',
      outline: 'none',
      caretColor: '#4da6ff',
    });

    // Clear button
    const clearInputBtn = document.createElement('button');
    clearInputBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" ' +
      'fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
    Object.assign(clearInputBtn.style, {
      position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)',
      background: 'none', border: 'none', color: 'rgba(255,255,255,0.35)',
      cursor: 'pointer', display: 'none', padding: '2px',
      lineHeight: '1', alignItems: 'center', justifyContent: 'center',
    });
    clearInputBtn.addEventListener('mousedown', (e) => { e.preventDefault(); });
    clearInputBtn.addEventListener('mouseenter', () => { clearInputBtn.style.color = 'rgba(255,255,255,0.8)'; });
    clearInputBtn.addEventListener('mouseleave', () => { clearInputBtn.style.color = 'rgba(255,255,255,0.35)'; });

    // History dropdown
    const dropdown = document.createElement('div');
    Object.assign(dropdown.style, {
      position: 'absolute', top: 'calc(100% + 4px)', left: '0', right: '0',
      background: 'rgba(28,28,28,0.98)',
      border: '1px solid rgba(255,255,255,0.15)',
      borderRadius: '8px',
      boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
      zIndex: '10', display: 'none',
      overflow: 'hidden', maxHeight: '200px', overflowY: 'auto',
    });

    function renderDropdown() {
      const hist = loadHistory();
      const q = input.value.trim().toLowerCase();
      const items = q ? hist.filter(h => h.toLowerCase().includes(q)) : hist;
      dropdown.innerHTML = '';
      if (!items.length) { dropdown.style.display = 'none'; return; }
      items.forEach((h, i) => {
        const row = document.createElement('div');
        row.textContent = h;
        Object.assign(row.style, {
          padding: '7px 10px',
          fontSize: '13px',
          color: 'rgba(255,255,255,0.75)',
          cursor: 'pointer',
          borderBottom: i < items.length - 1 ? '1px solid rgba(255,255,255,0.06)' : 'none',
        });
        row.addEventListener('mouseenter', () => { row.style.background = 'rgba(255,255,255,0.08)'; row.style.color = '#fff'; });
        row.addEventListener('mouseleave', () => { row.style.background = ''; row.style.color = 'rgba(255,255,255,0.75)'; });
        row.addEventListener('mousedown', (e) => {
          e.preventDefault();
          input.value = h;
          updateClearBtn();
          currentPredicate = parseQuery(h);
          applyFilter();
          updateCounter(counter);
          pushHistory(h);
          dropdown.style.display = 'none';
        });
        dropdown.appendChild(row);
      });
      // Measure dropdown height while hidden, then flip if needed
      dropdown.style.visibility = 'hidden';
      dropdown.style.display = '';
      const dropHeight = Math.min(dropdown.scrollHeight, 200) + 8;
      dropdown.style.display = 'none';
      dropdown.style.visibility = '';

      const wrapperRect = inputWrapper.getBoundingClientRect();
      const spaceBelow = window.innerHeight - wrapperRect.bottom;
      if (spaceBelow < dropHeight && wrapperRect.top > spaceBelow) {
        dropdown.style.top = 'auto';
        dropdown.style.bottom = 'calc(100% + 4px)';
      } else {
        dropdown.style.top = 'calc(100% + 4px)';
        dropdown.style.bottom = 'auto';
      }
      dropdown.style.display = '';
    }

    function updateClearBtn() {
      clearInputBtn.style.display = input.value ? 'flex' : 'none';
    }

    clearInputBtn.addEventListener('click', () => {
      input.value = '';
      updateClearBtn();
      currentPredicate = () => true;
      applyFilter();
      updateCounter(counter);
      input.focus();
      renderDropdown();
    });

    input.addEventListener('focus', () => {
      input.style.borderColor = 'rgba(77,166,255,0.7)';
      renderDropdown();
    });
    input.addEventListener('blur', () => {
      input.style.borderColor = 'rgba(255,255,255,0.2)';
      setTimeout(() => { dropdown.style.display = 'none'; }, 150);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input.value.trim()) {
        pushHistory(input.value);
        dropdown.style.display = 'none';
      }
      if (e.key === 'Escape') dropdown.style.display = 'none';
    });

    inputWrapper.appendChild(input);
    inputWrapper.appendChild(clearInputBtn);
    inputWrapper.appendChild(dropdown);

    // Match counter — declared before legend so toggle buttons can call updateCounter
    const counter = document.createElement('div');
    Object.assign(counter.style, {
      color: '#aaa',
      fontSize: '11px',
      textAlign: 'right',
    });

    // Status filter toggles
    const legend = document.createElement('div');
    Object.assign(legend.style, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingTop: '2px',
    });

    const statusGroup = document.createElement('div');
    Object.assign(statusGroup.style, { display: 'flex', gap: '4px' });

    const toggleBtnStyle = {
      width: '36px',
      height: '26px',
      border: '1px solid transparent',
      borderRadius: '6px',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '0',
      transition: 'background 0.15s, border-color 0.15s, color 0.15s',
    };

    STATUSES.forEach((s) => {
      const btn = document.createElement('button');
      btn.title = s.title;
      btn.innerHTML = s.icon;
      Object.assign(btn.style, toggleBtnStyle);

      function syncStyle() {
        const active = selectedStatuses.has(s.id);
        btn.style.background = active ? `${s.color}33` : 'rgba(255,255,255,0.08)';
        btn.style.borderColor = active ? s.color : 'transparent';
        btn.style.color = active ? s.color : 'rgba(255,255,255,0.45)';
      }
      syncStyle();

      btn.addEventListener('mouseenter', () => {
        if (!selectedStatuses.has(s.id)) btn.style.background = 'rgba(255,255,255,0.16)';
      });
      btn.addEventListener('mouseleave', syncStyle);
      btn.addEventListener('click', () => {
        if (selectedStatuses.has(s.id)) selectedStatuses.delete(s.id);
        else selectedStatuses.add(s.id);
        syncStyle();
        applyFilter();
        updateCounter(counter);
      });

      statusGroup.appendChild(btn);
    });

    const clearBtn = document.createElement('button');
    clearBtn.title = 'Очистить все статусы и заметки';
    clearBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" ' +
      'fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>' +
      '<path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>';
    Object.assign(clearBtn.style, {
      ...toggleBtnStyle,
      width: '36px',
      background: 'rgba(239,68,68,0.15)',
      borderColor: 'rgba(239,68,68,0.35)',
      color: '#ef4444',
    });
    clearBtn.addEventListener('mouseenter', () => {
      clearBtn.style.background = 'rgba(239,68,68,0.28)';
      clearBtn.style.borderColor = 'rgba(239,68,68,0.6)';
    });
    clearBtn.addEventListener('mouseleave', () => {
      clearBtn.style.background = 'rgba(239,68,68,0.15)';
      clearBtn.style.borderColor = 'rgba(239,68,68,0.35)';
    });
    clearBtn.addEventListener('click', clearAllData);

    legend.appendChild(statusGroup);
    legend.appendChild(clearBtn);

    wrapper.appendChild(labelRow);
    wrapper.appendChild(inputWrapper);
    wrapper.appendChild(legend);
    wrapper.appendChild(counter);

    // Collapse toggle
    let collapsed = false;
    toggleBtn.addEventListener('click', () => {
      collapsed = !collapsed;
      inputWrapper.style.display = collapsed ? 'none' : '';
      legend.style.display = collapsed ? 'none' : 'flex';
      counter.style.display = collapsed ? 'none' : '';
      toggleBtn.textContent = collapsed ? '+' : '–';
      wrapper.style.padding = collapsed ? '8px 14px' : '10px 14px';
    });

    // Debounced filter on input
    let debounceTimer;
    input.addEventListener('input', () => {
      updateClearBtn();
      renderDropdown();
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        currentPredicate = parseQuery(input.value);
        applyFilter();
        updateCounter(counter);
      }, 200);
    });

    document.body.appendChild(wrapper);
    return { input, counter };
  }

  function updateCounter(counter) {
    const cards = getCards();
    let visible = 0;
    cards.forEach((card) => { if (cardMatchesFilters(card)) visible++; });
    const total = cards.length;
    counter.textContent = total > 0 ? `Совпадений: ${visible} / ${total}` : '';
  }

  // ── MutationObserver for dynamic cards ──────────────────────────────────────

  function watchDynamicCards(counter) {
    let rafPending = false;

    const observer = new MutationObserver(() => {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        applyFilter();
        applyOverlays();
        updateCounter(counter);
      });
    });

    const root =
      document.querySelector('[role="main"]') ||
      document.querySelector('main') ||
      document.body;

    observer.observe(root, { childList: true, subtree: true });
  }

  // ── Init ─────────────────────────────────────────────────────────────────────

  function init() {
    if (document.getElementById('fmp-filter-box')) return;
    injectStyle();
    const { counter } = createUI();
    applyOverlays();
    watchDynamicCards(counter);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Re-init after FB SPA navigation
  const _pushState = history.pushState.bind(history);
  history.pushState = function (...args) {
    _pushState(...args);
    setTimeout(init, 800);
  };
  window.addEventListener('popstate', () => setTimeout(init, 800));
})();
