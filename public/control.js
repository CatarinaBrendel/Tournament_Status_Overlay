(function(){
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host);
  // result/debug UI removed; keep status and participant UI

  const statusEl = document.getElementById('status');
  const errorEl = document.getElementById('error');
  ws.addEventListener('open', () => {
    console.log('WS open');
    statusEl.textContent = 'Status: connected';
    statusEl.style.color = 'green';
  });
  ws.addEventListener('close', () => {
    console.log('WS closed');
    statusEl.textContent = 'Status: disconnected';
    statusEl.style.color = 'gray';
  });
  ws.addEventListener('error', (e) => {
    console.error('WS error', e);
    statusEl.textContent = 'Status: error';
    statusEl.style.color = 'orange';
  });

  let lastResults = null;
  let lastSelected = [];
  let lastEvent = null;
  // restore from localStorage if available
  try {
    const rs = localStorage.getItem('sgg_results');
    if (rs) lastResults = JSON.parse(rs);
    const ss = localStorage.getItem('sgg_selected');
    if (ss) lastSelected = JSON.parse(ss);
  } catch (e) {
    console.warn('localStorage parse error', e);
  }

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'init' || msg.type === 'update') {
      if (msg.state && msg.state.results) {
        lastResults = msg.state.results;
        try { localStorage.setItem('sgg_results', JSON.stringify(lastResults)); } catch (e) {}
      }
      if (msg.state && Array.isArray(msg.state.selectedParticipants)) {
        lastSelected = msg.state.selectedParticipants;
        try { localStorage.setItem('sgg_selected', JSON.stringify(lastSelected)); } catch (e) {}
      }
      if (msg.state && msg.state.selectedEvent) {
        lastEvent = msg.state.selectedEvent;
        try { localStorage.setItem('sgg_event', String(lastEvent)); } catch (e) {}
      }
      renderParticipants({ results: lastResults, selectedParticipants: lastSelected, selectedEvent: lastEvent });
    } else if (msg.type === 'error') console.error('Server error', msg.message);
    else console.log('WS message', msg);
  });

  // restore lastEvent from localStorage as well
  try { const ev = localStorage.getItem('sgg_event'); if (ev) lastEvent = ev; } catch(e){}
  // if we had stored results on load, render them immediately
  if (lastResults) renderParticipants({ results: lastResults, selectedParticipants: lastSelected, selectedEvent: lastEvent });

  function updateSelectionDisplay(selIds) {
    const countEl = document.getElementById('selectedCount');
    const curEl = document.getElementById('currentSelection');
    const participantsSelect = document.getElementById('participantsSelect');
    let options = [];
    if (participantsSelect) {
      if (participantsSelect.options) {
        options = Array.from(participantsSelect.options);
      } else {
        const menu = participantsSelect.querySelector && participantsSelect.querySelector('.multiselect-menu');
        if (menu) {
          options = Array.from(menu.querySelectorAll('.ms-item')).map(item => {
            const cb = item.querySelector('.ms-checkbox');
            const span = item.querySelector('span');
            return { value: cb ? cb.dataset.id : (span ? span.textContent : ''), textContent: span ? span.textContent : '' };
          });
        }
      }
    }
    const labels = (selIds || []).map(id => {
      const opt = options.find(o => o.value === id);
      return opt ? opt.textContent : id;
    }).filter(Boolean);
    // update count pill
    const count = (selIds && selIds.length) ? selIds.length : 0;
    if (countEl) countEl.textContent = count + ' selected';
    // restore currentSelection behavior showing labels or 'none'
    if (!curEl) return;
    if (!labels || labels.length === 0) {
      curEl.textContent = 'Current: none';
      curEl.removeAttribute('title');
      return;
    }
    curEl.textContent = 'Current: ' + labels.join(', ');
    curEl.title = labels.join(', ');
  }

  function renderParticipants(state) {
    const eventsSelect = document.getElementById('eventsSelect');
    const participantsSelect = document.getElementById('participantsSelect');
    const participantsMenu = participantsSelect && participantsSelect.querySelector('.multiselect-menu');
    const selected = (state.selectedParticipants || []);
    // If we don't have results yet, keep the current UI intact.
    if (!state.results || !state.results.tournament) return;
    // Only rebuild the events list when new results arrive
    const t = state.results.tournament;
    const events = Array.isArray(t.events) ? t.events : (t.events && t.events.nodes) || [];
    // support both native <select> and our single-select dropdown
    if (eventsSelect && eventsSelect.options) {
      // native select path (backwards compat)
      const curEvent = eventsSelect.value || state.selectedEvent || null;
      eventsSelect.innerHTML = '<option value="">-- choose event --</option>';
      events.forEach(ev => {
        const opt = document.createElement('option');
        opt.value = ev.id || ev.slug || ev.name;
        opt.textContent = ev.name || opt.value;
        eventsSelect.appendChild(opt);
      });
      if (curEvent) {
        const exists = Array.from(eventsSelect.options).some(o => o.value === curEvent);
        if (exists) eventsSelect.value = curEvent;
      }
      eventsSelect.onchange = () => {
        const evId = eventsSelect.value;
        lastEvent = evId;
        try { localStorage.setItem('sgg_event', String(lastEvent)); } catch(e){}
        populateParticipantsForEvent(evId, events, participantsSelect, selected);
      };
      const useEvent = eventsSelect.value || state.selectedEvent || lastEvent;
      if (useEvent) {
        eventsSelect.value = useEvent;
        populateParticipantsForEvent(useEvent, events, participantsSelect, selected);
      }
    } else if (eventsSelect) {
      // custom single-select dropdown path
      const toggle = eventsSelect.querySelector('.multiselect-toggle');
      const menu = eventsSelect.querySelector('.multiselect-menu');
      // build menu items
      menu.innerHTML = '';
      events.forEach(ev => {
        const id = ev.id || ev.slug || ev.name;
        const label = ev.name || id;
        const item = document.createElement('div');
        item.className = 'ms-item';
        item.dataset.id = id;
        item.textContent = label;
        item.addEventListener('click', () => {
          lastEvent = id;
          try { localStorage.setItem('sgg_event', String(lastEvent)); } catch(e){}
          // update toggle label
          const labelEl = toggle.querySelector('.multiselect-label');
          if (labelEl) labelEl.textContent = label;
          // mark selected item
          Array.from(menu.querySelectorAll('.ms-item')).forEach(i => i.classList.toggle('selected', i === item));
          // close menu
          menu.hidden = true;
          toggle.classList.remove('open');
          // populate participants for the chosen event
          populateParticipantsForEvent(id, events, participantsSelect, selected);
        });
        menu.appendChild(item);
      });
      // restore previously selected event
      const useEvent = state.selectedEvent || lastEvent || null;
      if (useEvent) {
        const match = Array.from(menu.querySelectorAll('.ms-item')).find(i => i.dataset.id == useEvent);
        if (match) {
          match.classList.add('selected');
          const labelEl = toggle.querySelector('.multiselect-label');
          if (labelEl) labelEl.textContent = match.textContent;
          populateParticipantsForEvent(useEvent, events, participantsSelect, selected);
        }
      }
    }
    // show current selection
    updateSelectionDisplay(selected);
  }

  function populateParticipantsForEvent(evId, events, participantsSelect, selected) {
    const menu = participantsSelect && participantsSelect.querySelector('.multiselect-menu');
    if (!menu) return;
    menu.innerHTML = '';
    // add search input at top
    const searchRow = document.createElement('div');
    searchRow.className = 'ms-search-row';
    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'ms-search';
    searchInput.placeholder = 'Search participants…';
    searchRow.appendChild(searchInput);
    menu.appendChild(searchRow);
    if (!evId) return;
    const ev = events.find(e => (e.id || e.slug || e.name) == evId);
    if (!ev) return;
    const entrants = (ev.entrants && (Array.isArray(ev.entrants) ? ev.entrants : ev.entrants.nodes)) || [];
    const seen = new Map();
    entrants.forEach(ent => {
      const parts = (ent.participants && (Array.isArray(ent.participants) ? ent.participants : ent.participants.nodes)) || [];
      if (parts.length) {
        parts.forEach(p => {
          const id = ent.id || p.id || p.gamerTag || ent.name;
          const label = (p.gamerTag || (p.player && p.player.id) || ent.name || id);
          if (!seen.has(id)) seen.set(id, label);
        });
      } else {
        const id = ent.id || ent.name;
        const label = ent.name || id;
        if (!seen.has(id)) seen.set(id, label);
      }
    });
    seen.forEach((label, id) => {
      const item = document.createElement('label');
      item.className = 'ms-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'ms-checkbox';
      cb.dataset.id = id;
      cb.checked = selected.includes(id);
      cb.addEventListener('change', () => {
        // update lastSelected when checkbox toggles
        const checked = Array.from(menu.querySelectorAll('.ms-checkbox:checked')).map(i => i.dataset.id);
        lastSelected = checked;
        updateSelectionDisplay(lastSelected);
      });
      const span = document.createElement('span');
      span.textContent = label + ' (' + id + ')';
      item.appendChild(cb);
      item.appendChild(span);
      menu.appendChild(item);
    });
    // filter logic: hide items that don't match the search
    function filterItems() {
      const q = (searchInput.value || '').trim().toLowerCase();
      const items = Array.from(menu.querySelectorAll('.ms-item'));
      items.forEach(it => {
        const text = (it.textContent || '').toLowerCase();
        const visible = q === '' || text.indexOf(q) !== -1;
        it.style.display = visible ? '' : 'none';
      });
    }
    searchInput.addEventListener('input', filterItems);
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const firstVisible = menu.querySelector('.ms-item:not([style*="display: none"]) .ms-checkbox');
        if (firstVisible) firstVisible.focus();
      }
    });
    // after building participant options, refresh selection display so labels show
    updateSelectionDisplay(selected);
  }

  document.getElementById('applySelection').addEventListener('click', () => {
    const menu = document.getElementById('participantsSelect').querySelector('.multiselect-menu');
    const sel = menu ? Array.from(menu.querySelectorAll('.ms-checkbox:checked')).map(i => i.dataset.id) : [];
    const eventsEl = document.getElementById('eventsSelect');
    const ev = (eventsEl && eventsEl.options) ? (eventsEl.value || lastEvent || null) : (lastEvent || null);
    ws.send(JSON.stringify({ type: 'select', payload: { selected: sel, event: ev } }));
    lastSelected = sel;
    lastEvent = ev;
    try { localStorage.setItem('sgg_selected', JSON.stringify(lastSelected)); } catch (e) {}
    try { localStorage.setItem('sgg_event', String(lastEvent)); } catch (e) {}
    updateSelectionDisplay(sel);
    // close the menu
    const menuContainer = document.getElementById('participantsSelect');
    const menuEl = menuContainer && menuContainer.querySelector('.multiselect-menu');
    if (menuEl) {
      menuEl.hidden = true;
      menuEl.setAttribute('aria-hidden', 'true');
    }
  });

  document.getElementById('clearSelection').addEventListener('click', () => {
    const eventsEl = document.getElementById('eventsSelect');
    const ev = (eventsEl && eventsEl.options) ? (eventsEl.value || lastEvent || null) : (lastEvent || null);
    ws.send(JSON.stringify({ type: 'select', payload: { selected: [], event: ev } }));
    lastSelected = [];
    try { localStorage.setItem('sgg_selected', JSON.stringify(lastSelected)); } catch (e) {}
    // uncheck all checkboxes
    const menu = document.getElementById('participantsSelect').querySelector('.multiselect-menu');
    if (menu) Array.from(menu.querySelectorAll('.ms-checkbox')).forEach(cb => cb.checked = false);
    updateSelectionDisplay([]);
  });

  // removed player search input — tournament-only workflow

  document.getElementById('btnTournament').addEventListener('click', () => {
    const tournament = (document.getElementById('tournament').value || '').trim();
    if (!tournament) {
      // clear event and participants UI
      const eventsSelect = document.getElementById('eventsSelect');
      const participantsSelect = document.getElementById('participantsSelect');
      if (eventsSelect) {
        if (eventsSelect.options) eventsSelect.innerHTML = '<option value="">-- choose event --</option>';
        else {
          const toggle = eventsSelect.querySelector('.multiselect-toggle');
          const menu = eventsSelect.querySelector('.multiselect-menu');
          if (toggle) {
            const lbl = toggle.querySelector('.multiselect-label');
            if (lbl) lbl.textContent = '-- choose event --';
            toggle.classList.remove('open');
          }
          if (menu) menu.innerHTML = '';
        }
      }
      if (participantsSelect) {
        const menu = participantsSelect.querySelector('.multiselect-menu');
        if (menu) menu.innerHTML = '';
      }
      // clear in-memory state
      lastResults = null;
      lastSelected = [];
      lastEvent = null;
      updateSelectionDisplay([]);
      // clear localStorage keys used by the control
      try {
        localStorage.removeItem('sgg_results');
        localStorage.removeItem('sgg_selected');
        localStorage.removeItem('sgg_event');
      } catch (e) {}
      // notify server that selection is cleared
      try { ws.send(JSON.stringify({ type: 'select', payload: { selected: [], event: null } })); } catch(e){}
      return;
    }
    ws.send(JSON.stringify({ type: 'search', payload: { tournament } }));
  });

  // multiselect toggle behavior and outside click close
  (function setupMultiselectToggle(){
    const container = document.getElementById('participantsSelect');
    if (!container) return;
    const toggle = container.querySelector('.multiselect-toggle');
    const menu = container.querySelector('.multiselect-menu');
    toggle.addEventListener('click', () => {
      const isHidden = menu.hidden;
      menu.hidden = !isHidden;
      menu.setAttribute('aria-hidden', String(menu.hidden));
      // reflect open state on the toggle so the chevron can rotate
      toggle.classList.toggle('open', !menu.hidden);
      if (!menu.hidden) {
        const search = menu.querySelector('.ms-search');
        if (search) search.focus();
        else menu.querySelector('.ms-checkbox')?.focus();
      }
    });
    document.addEventListener('click', (ev) => {
      if (!container.contains(ev.target)) {
        menu.hidden = true;
        menu.setAttribute('aria-hidden', 'true');
      }
    });
    // also wire the events single-select toggle if present
    const eventsContainer = document.getElementById('eventsSelect');
    if (eventsContainer) {
      const evToggle = eventsContainer.querySelector('.multiselect-toggle');
      const evMenu = eventsContainer.querySelector('.multiselect-menu');
      if (evToggle && evMenu) {
        evToggle.addEventListener('click', (e) => {
          e.stopPropagation();
          const hidden = evMenu.hidden;
          evMenu.hidden = !hidden;
          evMenu.setAttribute('aria-hidden', String(evMenu.hidden));
          evToggle.classList.toggle('open', !evMenu.hidden);
        });
        document.addEventListener('click', (ev) => {
          if (!eventsContainer.contains(ev.target)) {
            evMenu.hidden = true;
            evMenu.setAttribute('aria-hidden', 'true');
            evToggle.classList.remove('open');
          }
        });
      }
    }
  })();

})();
