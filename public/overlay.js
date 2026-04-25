(function () {
  const playersDiv = document.getElementById("players");
  const headerContainer = document.getElementById("overlayHeader");

  const wsUrl =
    (location.protocol === "https:" ? "wss" : "ws") +
    "://" +
    location.host;

  const ws = new WebSocket(wsUrl);

  function render(state) {
    playersDiv.innerHTML = "";
    if (headerContainer) headerContainer.innerHTML = "";

    if (!state) return;

    const selected = Array.isArray(state.selectedParticipants)
      ? state.selectedParticipants
      : [];

    const selectedSet = new Set(selected.map(String));
    const selectedLower = new Set(selected.map((s) => String(s).toLowerCase()));

    const selectedEvent = state.selectedEvent || null;

    const normalized =
      state.normalizedEventDetails && state.selectedEvent
        ? state.normalizedEventDetails[state.selectedEvent]
        : null;

    const eventDetails =
      state.eventDetails && state.selectedEvent
        ? state.eventDetails[state.selectedEvent]
        : null;

    const participantToEntrant = buildParticipantToEntrantMap(
      state,
      normalized
    );

    renderHeader(state);

    if (normalized && Object.keys(normalized).length) {
      renderNormalizedMatches({
        normalized,
        selected,
        participantToEntrant
      });

      return;
    }

    if (eventDetails && eventDetails.sets && Array.isArray(eventDetails.sets.nodes)) {
      renderLegacySetMatches({
        sets: eventDetails.sets.nodes,
        selectedSet,
        selectedLower
      });

      return;
    }

    renderFallbackEntrants({
      state,
      selectedEvent,
      selectedSet,
      selectedLower
    });
  }

  function renderHeader(state) {
    const tournamentName =
      state?.results?.tournament?.name ||
      state?.tournamentName ||
      "";

    const eventName = resolveEventName(state);

    if (!tournamentName && !eventName) return;

    const header = document.createElement("header");
    header.className = "overlay-header";

    const left = document.createElement("div");
    left.className = "tournament-title";
    left.textContent = tournamentName;

    const right = document.createElement("div");
    right.className = "event-title";
    right.textContent = eventName;

    header.appendChild(left);
    header.appendChild(right);

    if (headerContainer) {
      headerContainer.appendChild(header);
    } else {
      // fallback: append to playersDiv if header container missing
      playersDiv.insertBefore(header, playersDiv.firstChild);
    }
  }

  function resolveEventName(state) {
    let eventName = "";

    try {
      const tournament = state?.results?.tournament || null;
      const events = tournament
        ? Array.isArray(tournament.events)
          ? tournament.events
          : tournament.events?.nodes || []
        : [];

      if (state.selectedEvent) {
        const found = events.find((event) => {
          return (
            event &&
            (
              String(event.id) === String(state.selectedEvent) ||
              event.slug === state.selectedEvent ||
              event.name === state.selectedEvent
            )
          );
        });

        if (found?.name) eventName = found.name;
      }
    } catch {
      // Ignore malformed state.
    }

    return eventName || state.eventName || "";
  }

  function buildParticipantToEntrantMap(state, normalized) {
    let participantToEntrant = {};

    if (
      state.participantToEntrant &&
      Object.keys(state.participantToEntrant).length
    ) {
      participantToEntrant = { ...state.participantToEntrant };
    } else {
      participantToEntrant = buildParticipantToEntrantFromResults(state);
    }

    if (
      Object.keys(participantToEntrant).length === 0 &&
      normalized &&
      Object.keys(normalized).length
    ) {
      Object.values(normalized).forEach((value) => {
        if (!value) return;

        if (value.participantId && value.entrantId) {
          participantToEntrant[String(value.participantId)] = String(
            value.entrantId
          );
        }

        if (!value.participantId && value.entrantId) {
          participantToEntrant[String(value.entrantId)] = String(
            value.entrantId
          );
        }
      });
    }

    return participantToEntrant;
  }

  function buildParticipantToEntrantFromResults(state) {
    const participantToEntrant = {};

    try {
      const tournament = state?.results?.tournament || null;
      const events = tournament
        ? Array.isArray(tournament.events)
          ? tournament.events
          : tournament.events?.nodes || []
        : [];

      events.forEach((event) => {
        const entrants = getNodes(event?.entrants);

        entrants.forEach((entrant) => {
          const entrantId = entrant?.id ? String(entrant.id) : null;
          if (!entrantId) return;

          const participants = getNodes(entrant?.participants);

          participants.forEach((participant) => {
            if (participant?.id) {
              participantToEntrant[String(participant.id)] = entrantId;
            }
          });
        });
      });
    } catch {
      // Ignore malformed state.
    }

    return participantToEntrant;
  }

  function renderNormalizedMatches({ normalized, selected, participantToEntrant }) {
    const matchesMap = normalized._matchesByEntrant || {};

    selected.forEach((selectedValue) => {
      const selectedString = String(selectedValue || "");

      let entrantId = selectedString;

      if (!matchesMap[entrantId] && participantToEntrant[selectedString]) {
        entrantId = String(participantToEntrant[selectedString]);
      }

      let matches = matchesMap[entrantId] || [];

      if ((!matches || matches.length === 0) && normalized[selectedString.toLowerCase()]) {
        const maybe = normalized[selectedString.toLowerCase()];
        matches = Array.isArray(maybe) ? maybe : [maybe];
      }

      if (!matches || matches.length === 0) {
        const matchingKey = Object.keys(normalized || {}).find((key) => {
          return key === selectedString || key === selectedString.toLowerCase();
        });

        if (matchingKey) {
          matches = Array.isArray(normalized[matchingKey])
            ? normalized[matchingKey]
            : [normalized[matchingKey]];
        }
      }

      if (!matches || matches.length === 0) {
        appendEmptyPlayerCard(selectedString);
        return;
      }

      matches.forEach((entry) => {
        if (!entry) return;

        const status = getNormalizedStatus(entry);
        const score = formatNormalizedScore(entry);

        appendMatchCard({
          playerName: entry.displayName || selectedString || "Unknown",
          round: entry.round || "",
          bracket: entry.bracket || "",
          pool: entry.pool || "",
          opponent: entry.opponent || "",
          status,
          score
        });
      });
    });
  }

  function renderLegacySetMatches({ sets, selectedSet, selectedLower }) {
    sets.forEach((set) => {
      const slots = Array.isArray(set.slots) ? set.slots : [];

      const involvesSelected = slots.some((slot) => {
        const candidates = getSlotCandidates(slot);

        return candidates.some((candidate) => {
          if (!candidate) return false;

          const value = String(candidate);
          return (
            selectedSet.has(value) ||
            selectedLower.has(value.toLowerCase())
          );
        });
      });

      if (!involvesSelected) return;

      const bracket =
        set.phaseGroup?.name ||
        set.phaseGroupId ||
        "";

      const pool =
        set.phaseGroup?.identifier ||
        set.phaseGroup?.displayIdentifier ||
        set.phaseGroup?.name ||
        "";

      const round =
        set.fullRoundText ||
        set.round ||
        "";

      const started = Boolean(set.startedAt);
      const completed = Boolean(set.completedAt);

      const slotEntrantIds = slots.map((slot) => {
        return slot.entrant?.id || null;
      });

      const entrant1Score =
        typeof set.entrant1Score !== "undefined"
          ? set.entrant1Score
          : null;

      const entrant2Score =
        typeof set.entrant2Score !== "undefined"
          ? set.entrant2Score
          : null;

      slots.forEach((slot) => {
        const id =
          slot.participant?.id ||
          slot.entrant?.id ||
          null;

        const gamerTag =
          slot.participant?.gamerTag ||
          slot.entrant?.name ||
          null;

        const selected = isSlotSelected(slot, selectedSet, selectedLower);

        if (!selected) return;

        const opponentSlot = slots.find((other) => other !== slot);

        const opponent =
          opponentSlot?.participant?.gamerTag ||
          opponentSlot?.entrant?.name ||
          "";

        let status = "waiting";
        let score = "—";

        if (started) {
          status = completed ? "done" : "live";

          const entrantId = slot.entrant?.id || null;

          let myScore = null;
          let opponentScore = null;

          if (entrantId && slotEntrantIds.length === 2) {
            if (String(slotEntrantIds[0]) === String(entrantId)) {
              myScore = entrant1Score;
              opponentScore = entrant2Score;
            } else if (String(slotEntrantIds[1]) === String(entrantId)) {
              myScore = entrant2Score;
              opponentScore = entrant1Score;
            }
          }

          if (myScore !== null && opponentScore !== null) {
            score = `${myScore}–${opponentScore}`;
          } else {
            score = completed ? "DONE" : "LIVE";
          }
        }

        appendMatchCard({
          playerName: gamerTag || String(id || "Unknown"),
          round,
          bracket,
          pool,
          opponent,
          status,
          score
        });
      });
    });
  }

  function renderFallbackEntrants({
    state,
    selectedEvent,
    selectedSet,
    selectedLower
  }) {
    const tournament = state?.results?.tournament || null;

    const events = tournament
      ? Array.isArray(tournament.events)
        ? tournament.events
        : tournament.events?.nodes || []
      : [];

    const eventsToShow = selectedEvent
      ? events.filter((event) => {
          return (
            String(event.id || "") === String(selectedEvent) ||
            event.slug === selectedEvent ||
            event.name === selectedEvent
          );
        })
      : events;

    eventsToShow.forEach((event) => {
      const entrants = getNodes(event?.entrants);

      entrants.forEach((entrant) => {
        const participants = getNodes(entrant?.participants);

        if (participants.length) {
          participants.forEach((participant) => {
            const candidates = [
              participant.id,
              participant.gamerTag,
              participant.player?.id,
              entrant.id,
              entrant.name
            ];

            if (!matchesSelected(candidates, selectedSet, selectedLower)) {
              return;
            }

            const displayName =
              participant.gamerTag ||
              entrant.name ||
              String(participant.id || entrant.id || "Unknown");

            appendMatchCard({
              playerName: displayName,
              round: "Waiting for bracket data",
              bracket: event.name || "",
              pool: "",
              opponent: "",
              status: "waiting",
              score: "—"
            });
          });
        } else {
          const candidates = [entrant.id, entrant.name];

          if (!matchesSelected(candidates, selectedSet, selectedLower)) {
            return;
          }

          appendMatchCard({
            playerName: entrant.name || String(entrant.id || "Unknown"),
            round: "Waiting for bracket data",
            bracket: event.name || "",
            pool: "",
            opponent: "",
            status: "waiting",
            score: "—"
          });
        }
      });
    });
  }

  function appendMatchCard({
    playerName,
    round,
    bracket,
    pool,
    opponent,
    status,
    score
  }) {
    const safeStatus = status || "waiting";
    const safeScore = score || "—";

    const card = document.createElement("article");
    card.className = `match-card match-${safeStatus}`;

    const player = document.createElement("div");
    player.className = "player-name";
    player.textContent = playerName || "Unknown";

    const roundInfo = document.createElement("div");
    roundInfo.className = "round-info";

    const roundName = document.createElement("div");
    roundName.className = "round-name";
    roundName.textContent = round || "Unknown round";

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = [bracket, pool].filter(Boolean).join(" • ");

    roundInfo.appendChild(roundName);

    if (meta.textContent) {
      roundInfo.appendChild(meta);
    }

    const statusPill = document.createElement("div");
    statusPill.className = `status-pill status-${safeStatus}`;
    statusPill.textContent = statusLabel(safeStatus);

    const opponentElement = document.createElement("div");
    opponentElement.className = "opponent";

    if (opponent) {
      const prefix = document.createTextNode("vs ");
      const strong = document.createElement("strong");
      strong.textContent = opponent;

      opponentElement.appendChild(prefix);
      opponentElement.appendChild(strong);
    } else {
      opponentElement.textContent = "Opponent TBD";
    }

    const scoreElement = document.createElement("div");
    scoreElement.className = `score ${scoreClass(safeScore)}`;
    scoreElement.textContent = safeScore;

    // Assemble columns: player | round-info (includes status + opponent) | score
    // Put status and opponent inside the roundInfo column
    const metaRow = document.createElement('div');
    metaRow.style.display = 'flex';
    metaRow.style.alignItems = 'center';
    metaRow.style.justifyContent = 'space-between';
    metaRow.style.gap = '12px';
    // left side: opponent
    const left = document.createElement('div');
    left.style.flex = '1';
    left.appendChild(opponentElement);
    metaRow.appendChild(left);

    // ensure roundInfo contains roundName, meta, then metaRow
    if (meta.textContent) {
      // meta (bracket/pool) already appended earlier; ensure order
      // append metaRow after meta
      roundInfo.appendChild(metaRow);
    } else {
      // no meta, still append metaRow so opponent/status show
      roundInfo.appendChild(metaRow);
    }

    // create score column containing score and status beneath
    const scoreCol = document.createElement('div');
    scoreCol.className = 'score-col';
    scoreCol.appendChild(scoreElement);
    // controls row under the score will be created only for the main card
    const controlsRow = document.createElement('div');
    controlsRow.className = 'score-controls';
    controlsRow.appendChild(statusPill);
    scoreCol.appendChild(controlsRow);
    // detect disqualification markers and render a DQ status when present
    const isDQ = /\b(dq|disqual|disqualified|forfeit)\b/i.test(String(safeScore)) || /\b(dq|disqual|disqualified|forfeit)\b/i.test(String(safeStatus));
    if (isDQ) {
      statusPill.textContent = 'DQ';
      statusPill.classList.add('status-dq');
      card.classList.add('match-dq');
    }

    // Assemble card content
    card.appendChild(player);
    card.appendChild(roundInfo);
    card.appendChild(scoreCol);

    // Group cards by participant so newest is the main card and older ones collapse beneath
    const key = String(playerName || "Unknown");
    const dataKey = encodeURIComponent(key);
    let group = playersDiv.querySelector(`[data-player="${dataKey}"]`);
    // helper to insert group at top (below header if present)
    function insertGroupAtTop(g) {
      // always insert at top of the players container
      playersDiv.insertBefore(g, playersDiv.firstChild);
    }

    if (!group) {
      group = document.createElement('div');
      group.className = 'player-group';
      group.dataset.player = dataKey;
      const mainSlot = document.createElement('div');
      mainSlot.className = 'main-slot';
      const collapsed = document.createElement('div');
      collapsed.className = 'collapsed-list';
    // append the main card
    mainSlot.appendChild(card);
    // create action controls only for the main card
    (function attachMainActions(c) {
      const scoreCol = c.querySelector('.score-col');
      const controlsRow = scoreCol && scoreCol.querySelector('.score-controls');
      if (!controlsRow) return;
      const cardActions = document.createElement('div');
      cardActions.className = 'card-actions';
      const collapsedCountEl = document.createElement('span');
      collapsedCountEl.className = 'collapsed-count';
      collapsedCountEl.textContent = '0';
      const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      chevron.setAttribute('viewBox', '0 0 24 24');
      chevron.setAttribute('class', 'expand-chevron');
      chevron.setAttribute('aria-hidden', 'true');
      chevron.setAttribute('width', '14');
      chevron.setAttribute('height', '14');
      chevron.innerHTML = '<polyline points="6 9 12 15 18 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>';
      cardActions.appendChild(collapsedCountEl);
      cardActions.appendChild(chevron);
      controlsRow.appendChild(cardActions);
    })(card);

      group.appendChild(mainSlot);
      group.appendChild(collapsed);
      insertGroupAtTop(group);

      // toggle expand/collapse when main slot is clicked
      mainSlot.addEventListener('click', (e) => {
        // ignore clicks on interactive elements inside the card
        if (e.target.closest('button') || e.target.closest('a')) return;
        const willExpand = !group.classList.contains('expanded');
        group.classList.toggle('expanded', willExpand);
        // update collapsed count badge (look inside main card for the element)
        const collapsedCountEl = mainSlot.querySelector('.collapsed-count');
        if (collapsedCountEl) collapsedCountEl.textContent = String(collapsed.children.length);
      });
    } else {
      // existing group: move current main into collapsed list, then set new card as main
      const mainSlot = group.querySelector('.main-slot');
      const collapsed = group.querySelector('.collapsed-list');
      if (mainSlot && mainSlot.firstElementChild) {
        const oldMain = mainSlot.firstElementChild;
        // avoid duplicating if oldMain is same as new card (unlikely)
        if (oldMain !== card) {
          // remove main-only actions from the old main so collapsed items don't show controls
          const oldScoreCol = oldMain.querySelector && oldMain.querySelector('.score-col');
          if (oldScoreCol) {
            const oldActions = oldScoreCol.querySelector('.card-actions');
            if (oldActions) oldActions.remove();
          }
          // prepend old main into collapsed list so older items are deeper
          collapsed.insertBefore(oldMain, collapsed.firstChild);
        }
      }
      // set new main
      if (mainSlot) {
        // clear and append
        mainSlot.innerHTML = '';
        mainSlot.appendChild(card);
        // attach main-only actions to the new main card
        (function attachMainActionsToNew(c) {
          const scoreCol = c.querySelector('.score-col');
          const controlsRow = scoreCol && scoreCol.querySelector('.score-controls');
          if (!controlsRow) return;
          // remove any existing actions first
          const existing = controlsRow.querySelector('.card-actions');
          if (existing) existing.remove();
          const cardActions = document.createElement('div');
          cardActions.className = 'card-actions';
          const collapsedCountEl = document.createElement('span');
          collapsedCountEl.className = 'collapsed-count';
          collapsedCountEl.textContent = String(collapsed.children.length);
          const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          chevron.setAttribute('viewBox', '0 0 24 24');
          chevron.setAttribute('class', 'expand-chevron');
          chevron.setAttribute('aria-hidden', 'true');
          chevron.setAttribute('width', '14');
          chevron.setAttribute('height', '14');
          chevron.innerHTML = '<polyline points="6 9 12 15 18 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>';
          cardActions.appendChild(collapsedCountEl);
          cardActions.appendChild(chevron);
          controlsRow.appendChild(cardActions);
        })(card);
      }
      // move group to top since it's the most recently updated for this participant
      insertGroupAtTop(group);
    }
  }

  function appendEmptyPlayerCard(playerName) {
    appendMatchCard({
      playerName,
      round: "No match data",
      bracket: "",
      pool: "",
      opponent: "",
      status: "waiting",
      score: "—"
    });
  }

  function getNormalizedStatus(entry) {
    if (!entry.started) return "waiting";

    const score = String(entry.scoreText || "").toLowerCase();

    if (
      entry.completed ||
      score.includes("completed") ||
      score.match(/\d+\s*[-–]\s*\d+/)
    ) {
      return "done";
    }

    return "live";
  }

  function formatNormalizedScore(entry) {
    if (entry.scoreText) {
      return String(entry.scoreText).replace(/\s*-\s*/g, "–");
    }

    if (entry.games && Array.isArray(entry.games) && entry.games.length) {
      return entry.games
        .map((game, index) => {
          return `G${index + 1}:${game.winnerId || game.winner || "?"}`;
        })
        .join(" ");
    }

    return "—";
  }

  function scoreClass(scoreText) {
    const score = String(scoreText || "");

    const match = score.match(/(\d+)\s*[–-]\s*(\d+)/);

    if (!match) return "score-empty";

    const mine = Number(match[1]);
    const theirs = Number(match[2]);

    if (mine > theirs) return "score-win";
    if (mine < theirs) return "score-loss";

    return "score-empty";
  }

  function statusLabel(status) {
    if (status === "live") return "LIVE";
    if (status === "done") return "DONE";
    return "WAITING";
  }

  function getSlotCandidates(slot) {
    return [
      slot?.participant?.id,
      slot?.participant?.gamerTag,
      slot?.participant?.player?.id,
      slot?.entrant?.id,
      slot?.entrant?.name
    ];
  }

  function isSlotSelected(slot, selectedSet, selectedLower) {
    const candidates = getSlotCandidates(slot);

    return candidates.some((candidate) => {
      if (!candidate) return false;

      const value = String(candidate);

      return (
        selectedSet.has(value) ||
        selectedLower.has(value.toLowerCase())
      );
    });
  }

  function matchesSelected(candidates, selectedSet, selectedLower) {
    return candidates.some((candidate) => {
      if (candidate == null) return false;

      const value = String(candidate);

      return (
        selectedSet.has(value) ||
        selectedLower.has(value.toLowerCase())
      );
    });
  }

  function getNodes(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (Array.isArray(value.nodes)) return value.nodes;
    return [value];
  }

  ws.addEventListener("open", function () {
    console.log("Overlay WebSocket open");
  });

  ws.addEventListener("message", function (event) {
    try {
      const message = JSON.parse(event.data);

      if (!message) return;

      if (message.type === "init" || message.type === "update") {
        render(message.state || {});
      } else if (message.type === "error") {
        console.warn("Server error:", message.message || message);
      }
    } catch (error) {
      console.warn("Failed to parse WebSocket message", error, event.data);
    }
  });

  ws.addEventListener("close", function () {
    console.warn("Overlay WebSocket closed");
    renderDisconnected();
  });

  ws.addEventListener("error", function (error) {
    console.warn("Overlay WebSocket error", error);
  });

  function renderDisconnected() {
    playersDiv.innerHTML = "";

    appendMatchCard({
      playerName: "Overlay",
      round: "Disconnected from server",
      bracket: "",
      pool: "",
      opponent: "",
      status: "waiting",
      score: "—"
    });
  }

  setTimeout(function () {
    if (!playersDiv.innerHTML) {
      render({});
    }
  }, 600);
})();