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
    const el = document.getElementById('currentSelection');
    if (!el) return;
    if (!selIds || selIds.length === 0) { el.textContent = 'Current: none'; return; }
    const participantsSelect = document.getElementById('participantsSelect');
    const options = participantsSelect ? Array.from(participantsSelect.options) : [];
    const labels = selIds.map(id => {
      const opt = options.find(o => o.value === id);
      return opt ? opt.textContent : id;
    });
    el.textContent = 'Current: ' + labels.join(', ');
  }

  function renderParticipants(state) {
    const eventsSelect = document.getElementById('eventsSelect');
    const participantsSelect = document.getElementById('participantsSelect');
    const selected = (state.selectedParticipants || []);
    // If we don't have results yet, keep the current UI intact.
    if (!state.results || !state.results.tournament) return;
    // Only rebuild the events list when new results arrive
    const t = state.results.tournament;
    const events = Array.isArray(t.events) ? t.events : (t.events && t.events.nodes) || [];
    // preserve current selection value if any
    const curEvent = eventsSelect.value || state.selectedEvent || null;
    eventsSelect.innerHTML = '<option value="">-- choose event --</option>';
    events.forEach(ev => {
      const opt = document.createElement('option');
      opt.value = ev.id || ev.slug || ev.name;
      opt.textContent = ev.name || opt.value;
      eventsSelect.appendChild(opt);
    });
    // restore previous event selection if it still exists
    if (curEvent) {
      const exists = Array.from(eventsSelect.options).some(o => o.value === curEvent);
      if (exists) eventsSelect.value = curEvent;
    }
    // when event changes, populate participants
    eventsSelect.onchange = () => {
      const evId = eventsSelect.value;
      lastEvent = evId;
      try { localStorage.setItem('sgg_event', String(lastEvent)); } catch(e){}
      populateParticipantsForEvent(evId, events, participantsSelect, selected);
    };
    // if an event is selected (or stored), (re)populate participants
    const useEvent = eventsSelect.value || state.selectedEvent || lastEvent;
    if (useEvent) {
      eventsSelect.value = useEvent;
      populateParticipantsForEvent(useEvent, events, participantsSelect, selected);
    }
    // show current selection
    updateSelectionDisplay(selected);
  }

  function populateParticipantsForEvent(evId, events, participantsSelect, selected) {
    participantsSelect.innerHTML = '';
    if (!evId) return;
    const ev = events.find(e => (e.id || e.slug || e.name) == evId);
    if (!ev) return;
    const entrants = (ev.entrants && (Array.isArray(ev.entrants) ? ev.entrants : ev.entrants.nodes)) || [];
    const seen = new Map();
    entrants.forEach(ent => {
      const parts = (ent.participants && (Array.isArray(ent.participants) ? ent.participants : ent.participants.nodes)) || [];
      if (parts.length) {
        parts.forEach(p => {
          // prefer entrant id as the option value because normalized data uses entrant ids
          // use explicit entrant id when available to align control -> server mapping
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
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = label + ' (' + id + ')';
      if (selected.includes(id)) opt.selected = true;
      participantsSelect.appendChild(opt);
    });
    // after building participant options, refresh selection display so labels show
    updateSelectionDisplay(selected);
  }

  document.getElementById('applySelection').addEventListener('click', () => {
    const participantsSelect = document.getElementById('participantsSelect');
    const sel = Array.from(participantsSelect.selectedOptions).map(o => o.value);
    const ev = document.getElementById('eventsSelect').value || lastEvent || null;
    ws.send(JSON.stringify({ type: 'select', payload: { selected: sel, event: ev } }));
    lastSelected = sel;
    lastEvent = ev;
    try { localStorage.setItem('sgg_selected', JSON.stringify(lastSelected)); } catch (e) {}
    try { localStorage.setItem('sgg_event', String(lastEvent)); } catch (e) {}
    updateSelectionDisplay(sel);
  });

  document.getElementById('clearSelection').addEventListener('click', () => {
    const ev = document.getElementById('eventsSelect').value || lastEvent || null;
    ws.send(JSON.stringify({ type: 'select', payload: { selected: [], event: ev } }));
    lastSelected = [];
    try { localStorage.setItem('sgg_selected', JSON.stringify(lastSelected)); } catch (e) {}
    updateSelectionDisplay([]);
  });

  // removed player search input — tournament-only workflow

  document.getElementById('btnTournament').addEventListener('click', () => {
    const tournament = document.getElementById('tournament').value;
    ws.send(JSON.stringify({ type: 'search', payload: { tournament } }));
  });

})();
