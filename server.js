require('dotenv').config();
const path = require('path');
const express = require('express');
const fetch = require('node-fetch');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;

// Helpful startup log to confirm whether STARTGG_API_KEY was loaded
console.log('STARTGG_API_KEY present:', !!process.env.STARTGG_API_KEY);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const server = app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

const wss = new WebSocket.Server({ server });

// Simple in-memory state for the overlay
const state = {
  query: null,
  results: null,
  selectedParticipants: [],
  selectedEvent: null,
};

// Cache for fetched event details (sets, phaseGroups)
state.eventDetails = {};

function broadcast(message) {
  const data = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  });
}

function buildParticipantToEntrant() {
  state.participantToEntrant = state.participantToEntrant || {};
  try {
    state.participantToEntrant = {};
    if (state.results && state.results.tournament && state.results.tournament.events) {
      const evs = Array.isArray(state.results.tournament.events) ? state.results.tournament.events : ((state.results.tournament.events && state.results.tournament.events.nodes) || []);
      evs.forEach(e => {
        const entrants = e && e.entrants ? (Array.isArray(e.entrants) ? e.entrants : (e.entrants.nodes || [])) : [];
        entrants.forEach(ent => {
          const entId = ent && ent.id ? String(ent.id) : null;
          const parts = ent && ent.participants ? (Array.isArray(ent.participants) ? ent.participants : (ent.participants.nodes || [])) : [];
          parts.forEach(p => {
            if (p && p.id && entId) state.participantToEntrant[String(p.id)] = entId;
          });
        });
      });
    }
  } catch (e) {
    console.warn('buildParticipantToEntrant error', e && e.stack || e);
  }
}

wss.on('connection', (ws, req) => {
  ws.send(JSON.stringify({ type: 'init', state }));
  ws.on('message', (msg) => {
    try {
      const obj = JSON.parse(msg);
      console.log('WS incoming:', obj && obj.type, 'payload:', obj && obj.payload);
      if (obj.type === 'search') {
        handleSearch(obj.payload).then((res) => {
          console.log('Search result (summary):', Object.keys(res || {}));
          state.query = obj.payload;
          state.results = res;
          buildParticipantToEntrant();
          broadcast({ type: 'update', state });
        }).catch((err) => {
          console.error('Search error:', err && err.stack || err);
          const message = err && err.message ? err.message : String(err);
          ws.send(JSON.stringify({ type: 'error', message }));
        });
      } else if (obj.type === 'select') {
        // payload: { selected: ['id1','id2'], event: 'eventId' }
        const sel = (obj.payload && obj.payload.selected) || [];
        const ev = (obj.payload && obj.payload.event) || null;
        state.selectedParticipants = Array.isArray(sel) ? sel : [];
        state.selectedEvent = ev;
        broadcast({ type: 'update', state });
        // fetch event details (sets/phaseGroups) asynchronously so overlay can render match info
        if (ev) {
            fetchEventDetails(ev).then((details) => {
              if (details) {
                state.eventDetails = state.eventDetails || {};
                state.eventDetails[ev] = details;

                // Normalize sets into per-participant quick lookup for client simplicity
                try {
                  state.normalizedEventDetails = state.normalizedEventDetails || {};
                  const norm = {};
                  // build an entrant -> participant/gamerTag map from state.results when available
                  const entrantLookup = {};
                  try {
                    if (state.results && state.results.tournament && state.results.tournament.events) {
                      const evs = Array.isArray(state.results.tournament.events) ? state.results.tournament.events : ((state.results.tournament.events && state.results.tournament.events.nodes) || []);
                      evs.forEach(e => {
                        const entrants = e && e.entrants ? (Array.isArray(e.entrants) ? e.entrants : (e.entrants.nodes || [])) : [];
                        entrants.forEach(ent => {
                          const entId = ent && ent.id ? String(ent.id) : null;
                          if (!entId) return;
                          entrantLookup[entId] = entrantLookup[entId] || { entrantName: ent.name || null, participantIds: [], gamerTags: [] };
                          const parts = ent.participants ? (Array.isArray(ent.participants) ? ent.participants : (ent.participants.nodes || [])) : [];
                          parts.forEach(p => {
                            if (p && p.id) entrantLookup[entId].participantIds.push(String(p.id));
                            if (p && p.gamerTag) entrantLookup[entId].gamerTags.push(String(p.gamerTag));
                          });
                        });
                      });
                    }
                  } catch (err) {
                    console.warn('entrantLookup build failed', err && err.stack || err);
                  }

                  // ensure participantToEntrant exists
                  state.participantToEntrant = state.participantToEntrant || {};
                  const sets = (details.sets && Array.isArray(details.sets.nodes)) ? details.sets.nodes.slice().reverse() : [];
                  sets.forEach((set) => {
                    const bracket = (set.phaseGroup && set.phaseGroup.name) || set.phaseGroupId || '';
                    const pool = (set.phaseGroup && (set.phaseGroup.identifier || set.phaseGroup.displayIdentifier || set.phaseGroup.name)) || '';
                    const round = set.fullRoundText || set.round || '';
                    const started = !!set.startedAt;
                    const completed = !!set.completedAt;
                    const s1 = (typeof set.entrant1Score !== 'undefined') ? set.entrant1Score : null;
                    const s2 = (typeof set.entrant2Score !== 'undefined') ? set.entrant2Score : null;
                    // try to derive per-game win counts if games and winnerId are available
                    let gameWinCounts = null;
                    try {
                      const gamesList = set.games && (Array.isArray(set.games) ? set.games : (set.games.nodes || []));
                      if (gamesList && Array.isArray(gamesList) && gamesList.length) {
                        gameWinCounts = {};
                        gamesList.forEach(g => {
                          if (!g) return;
                          const winner = g.winnerId || g.winner || null;
                          if (!winner) return;
                          let mapped = null;
                          // if winner matches an entrant id directly
                          if (entrantLookup && entrantLookup[String(winner)]) mapped = String(winner);
                          else {
                            // try to find entrant by participantId or gamerTag
                            for (const entId in entrantLookup) {
                              const info = entrantLookup[entId];
                              if (!info) continue;
                              if (info.participantIds && info.participantIds.indexOf(String(winner)) !== -1) { mapped = entId; break; }
                              if (info.gamerTags && info.gamerTags.indexOf(String(winner)) !== -1) { mapped = entId; break; }
                            }
                          }
                          if (!mapped) mapped = String(winner);
                          gameWinCounts[mapped] = (gameWinCounts[mapped] || 0) + 1;
                        });
                      }
                    } catch (e) { /* ignore games parsing errors */ }
                    const slots = set.slots || [];
                    const entrantIds = slots.map(s => (s.entrant && s.entrant.id) || null);

                    slots.forEach((slot, idx) => {
                      const entrantId = (slot.entrant && slot.entrant.id) || null;
                      // the conservative event query may not include participant info; try to enrich from entrantLookup
                      let participantId = null;
                      let gamerTag = null;
                      const entrantName = (slot.entrant && slot.entrant.name) || null;
                      if (slot.participant) {
                        participantId = (slot.participant && slot.participant.id) || null;
                        gamerTag = (slot.participant && slot.participant.gamerTag) || null;
                      } else if (entrantId && entrantLookup[entrantId]) {
                        // prefer first participantId and gamerTag if present
                        participantId = entrantLookup[entrantId].participantIds.length ? entrantLookup[entrantId].participantIds[0] : null;
                        gamerTag = entrantLookup[entrantId].gamerTags.length ? entrantLookup[entrantId].gamerTags[0] : null;
                      }

                      // determine opponent
                      const oppSlot = slots.find(s => s !== slot) || null;
                      const opponentName = oppSlot ? ((oppSlot.participant && (oppSlot.participant.gamerTag || String(oppSlot.participant.id))) || (oppSlot.entrant && oppSlot.entrant.name) || '') : '';

                      // map scores to this entrant if possible
                      let myScore = null, oppScore = null;
                      if (gameWinCounts && entrantId) {
                        const other = entrantIds.find(id => String(id) !== String(entrantId));
                        myScore = gameWinCounts[String(entrantId)] || 0;
                        oppScore = other ? (gameWinCounts[String(other)] || 0) : null;
                      } else if (entrantId && entrantIds.length === 2 && (s1 !== null || s2 !== null)) {
                        if (String(entrantIds[0]) === String(entrantId)) { myScore = s1; oppScore = s2; }
                        else if (String(entrantIds[1]) === String(entrantId)) { myScore = s2; oppScore = s1; }
                      }

                      const scoreText = (myScore !== null && oppScore !== null) ? (String(myScore) + ' - ' + String(oppScore)) : (started ? (completed ? 'COMPLETED' : 'IN PROGRESS') : null);

                      const displayName = gamerTag || entrantName || (participantId ? String(participantId) : null);
                        const entry = {
                        displayName,
                        bracket,
                        pool,
                        round,
                        started,
                        completed,
                        scoreText,
                          games: set.games || null,
                        opponent: opponentName,
                        setId: set.id,
                        entrantId: entrantId || null,
                        participantId: participantId || null,
                      };

                      // record participant->entrant mapping for client use when possible
                      if (participantId && entrantId) {
                        try { state.participantToEntrant[String(participantId)] = String(entrantId); } catch(e) { /* ignore */ }
                      }

                      // store under multiple keys for flexible lookup
                      // store arrays of entries per key so we can render all matches for a participant
                      [[participantId], [gamerTag], [entrantId], [entrantName], [displayName]].forEach(arr => {
                        const k = (arr[0] == null) ? null : String(arr[0]).toLowerCase();
                        if (!k) return;
                        if (!norm[k]) norm[k] = [];
                        // avoid duplicate set entries for same setId
                        if (!norm[k].some(x => x && x.setId === entry.setId)) {
                          norm[k].push(entry);
                        }
                      });
                    });
                  });
                  state.normalizedEventDetails[ev] = norm;
                  // Build a map of matches keyed by entrantId (and participantId) for easy client-side rendering
                  try {
                    const matchesByEntrant = {};
                    Object.keys(norm || {}).forEach(k => {
                      const arr = Array.isArray(norm[k]) ? norm[k] : [norm[k]];
                      arr.forEach(entry => {
                        if (!entry) return;
                        // prefer entrantId key
                        if (entry.entrantId) {
                          matchesByEntrant[entry.entrantId] = matchesByEntrant[entry.entrantId] || [];
                          if (!matchesByEntrant[entry.entrantId].some(x => x && x.setId === entry.setId)) matchesByEntrant[entry.entrantId].push(entry);
                        }
                        // also index by participantId if available
                        if (entry.participantId) {
                          matchesByEntrant[entry.participantId] = matchesByEntrant[entry.participantId] || [];
                          if (!matchesByEntrant[entry.participantId].some(x => x && x.setId === entry.setId)) matchesByEntrant[entry.participantId].push(entry);
                        }
                      });
                    });
                    // attach map to normalized event details
                    state.normalizedEventDetails[ev]._matchesByEntrant = matchesByEntrant;
                    if (Object.keys(matchesByEntrant).length) console.log('matchesByEntrant sample for', ev, Object.keys(matchesByEntrant).slice(0,5));
                  } catch (e) { console.warn('could not build matchesByEntrant', e && e.stack || e); }
                  // build a participant->entrant map for this event from entrantLookup
                  try {
                    const participantMap = {};
                    Object.keys(entrantLookup || {}).forEach(entId => {
                      const info = entrantLookup[entId];
                      if (!info) return;
                      const primaryKey = String(entId).toLowerCase();
                      (info.participantIds || []).forEach(pid => {
                        if (!pid) return;
                        participantMap[String(pid)] = primaryKey;
                      });
                    });
                    // attach the map to the normalized event details for easy client lookup
                    state.normalizedEventDetails[ev]._participantMap = participantMap;
                    if (Object.keys(participantMap).length) console.log('normalized participantMap sample for', ev, Object.keys(participantMap).slice(0,5));
                  } catch (e) { console.warn('could not build participantMap', e && e.stack || e); }
                  try {
                    const mapSampleKeys = Object.keys(state.participantToEntrant).slice(0,5);
                    if (mapSampleKeys.length) console.log('participantToEntrant sample:', mapSampleKeys.reduce((acc,k)=>{ acc[k]=state.participantToEntrant[k]; return acc; },{}));
                  } catch(e) {}
                  // Log a small sample for inspection (up to 5 participant keys)
                  try {
                    const sampleKeys = Object.keys(norm).slice(0,5);
                    const sample = {};
                    sampleKeys.forEach(k => { sample[k] = norm[k]; });
                    console.log('normalizedEventDetails sample for', ev, '(entries:', Object.keys(norm).length, '):', JSON.stringify(sample, null, 2));
                  } catch (err) {
                    console.warn('Could not log normalizedEventDetails sample', err && err.stack || err);
                  }
                } catch (err) {
                  console.error('normalize eventDetails error', err && err.stack || err);
                }

                broadcast({ type: 'update', state });
              }
            }).catch(err => {
              console.error('fetchEventDetails error', err && err.stack || err);
            });
        }
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
    }
  });
});

async function handleSearch(payload) {
  // Proxies GraphQL queries to start.gg. Supports player search or tournament slug.
  const apiKey = process.env.STARTGG_API_KEY;
  if (!apiKey) throw new Error('STARTGG_API_KEY not set in environment');

  let query = '';
  let variables = {};

  if (payload && payload.tournament) {
    // Accept either a slug or a full start.gg tournament URL or a path like /tournament/slug/details.
    let raw = String(payload.tournament || '').trim();
    // Try to extract slug from several possible forms
    // full URL: https://www.start.gg/tournament/<slug>/...
    let m = raw.match(/start\.gg\/tournament\/([^\/\?#]+)/i);
    if (m && m[1]) raw = m[1];
    // path form: /tournament/<slug>/details or tournament/<slug>
    m = raw.match(/(?:\/?|.*)tournament\/([^\/\?#]+)/i);
    if (m && m[1]) raw = m[1];
    const slug = raw;
    // Query a tournament by slug and return its basic info + events.
    // Entrants shape varies across API versions; request a conservative shape that avoids invalid args.
    query = `query Tournament($slug: String!) {
    tournament(slug: $slug) {
        id
        name
        events {
        id
        name
        entrants {
            nodes {
            id
            name
            participants {
                id
                gamerTag
                player { id }
            }
            }
        }
        }
    }
    }`;
    variables = { slug };
  } else {
    // Fallback: players search by query string
    query = `query Players($search: String!) {\n  players(query: $search) {\n    nodes {\n      id\n      name\n      gamerTag\n      national(isoCode: true)\n    }\n  }\n}`;
    variables = { search: (payload && payload.search) || '' };
  }

  const resp = await fetch('https://api.start.gg/gql/alpha', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  try {
    if (!resp.ok) {
      const text = await resp.text();
      console.error('start.gg response not ok:', resp.status, text);
      throw new Error(`start.gg API error: ${resp.status} ${text}`);
    }
    const body = await resp.json();
    console.log('start.gg response keys:', Object.keys(body || {}));
    if (body.errors && body.errors.length) {
      console.error('start.gg GraphQL errors:', JSON.stringify(body.errors, null, 2));
      throw new Error('GraphQL errors: ' + JSON.stringify(body.errors));
    }
    return body.data;
  } catch (err) {
    console.error('handleSearch fetch error:', err && err.stack || err);
    throw err;
  }
}

async function fetchEventDetails(eventId) {
  const apiKey = process.env.STARTGG_API_KEY;
  if (!apiKey) throw new Error('STARTGG_API_KEY not set in environment');
  // Conservative event-level query requesting sets and phaseGroups where available.
  const query = `query EventSets($eventId: ID!) {
    event(id: $eventId) {
      id
      name
      phaseGroups { id }
      sets(perPage: 500) {
        nodes {
          id
          fullRoundText
          round
          startedAt
          completedAt
          state
          slots {
            entrant { id name }
          }
        }
      }
    }
  }`;
  const variables = { eventId };
  try {
    const resp = await fetch('https://api.start.gg/gql/alpha', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      console.error('start.gg event response not ok:', resp.status, text);
      return null;
    }
    const body = await resp.json();
    if (body.errors && body.errors.length) {
      console.warn('start.gg event query errors:', body.errors);
      // continue to try an augmented query below
    }
    let details = body.data && body.data.event ? body.data.event : null;

    // Try an augmented query that includes games with winnerId (some API variants expose this)
    const augmentedQuery = `query EventSetsWithGames($eventId: ID!) {
      event(id: $eventId) {
        id
        name
        sets(perPage: 500) {
          nodes {
            id
            fullRoundText
            round
            startedAt
            completedAt
            state
            slots { entrant { id name } }
            games { id winnerId }
          }
        }
      }
    }`;
    try {
      const aresp = await fetch('https://api.start.gg/gql/alpha', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ query: augmentedQuery, variables }),
      });
      if (aresp.ok) {
        const abody = await aresp.json();
        if (!(abody.errors && abody.errors.length) && abody.data && abody.data.event) {
          const augmented = abody.data.event;
          // merge games into details.sets.nodes by set id when possible
          if (details && details.sets && Array.isArray(details.sets.nodes) && augmented.sets && Array.isArray(augmented.sets.nodes)) {
            const byId = {};
            augmented.sets.nodes.forEach(s => { if (s && s.id) byId[String(s.id)] = s; });
            details.sets.nodes.forEach(s => {
              const a = byId[String(s.id)];
              if (a && a.games) {
                // normalize possible shapes: a.games may be array or object
                s.games = a.games;
              }
            });
          }
        }
      }
    } catch (e) {
      console.warn('augmented event query failed', e && e.stack || e);
    }

    return details;
  } catch (err) {
    console.error('fetchEventDetails fetch error:', err && err.stack || err);
    return null;
  }
}

// Simple API to trigger search via HTTP (optional)
app.post('/api/search', async (req, res) => {
  try {
    const result = await handleSearch(req.body);
    state.query = req.body;
    state.results = result;
    buildParticipantToEntrant();
    broadcast({ type: 'update', state });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Convenience route: accept a tournament path after /api/search/tournament/
app.post('/api/search/tournament/*', async (req, res) => {
  try {
    // req.params[0] contains the wildcard path (may include extra segments like /details)
    const raw = req.params[0] || '';
    const tournamentInput = raw.replace(/^\/+|\/+$/g, '');
    const payload = { tournament: tournamentInput };
    const result = await handleSearch(payload);
    state.query = payload;
    state.results = result;
    buildParticipantToEntrant();
    broadcast({ type: 'update', state });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
