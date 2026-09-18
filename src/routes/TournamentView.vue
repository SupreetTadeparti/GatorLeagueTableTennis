<script setup>
import { ref, computed, onMounted, onUnmounted } from "vue";
import { auth, db } from "../firebase";
import { isUserAdminByEmail } from "../firebaseHelpers";
import {
  collection,
  query,
  where,
  getDoc,
  getDocs,
  doc,
  setDoc,
  deleteDoc,
  serverTimestamp,
} from "firebase/firestore";
import {
  applyAvailability,
  applyTournamentRatings,
  fetchTournaments,
  revertAvailability,
  revertTournamentRatings,
} from "../ratings";
import {
  buildBracketRounds,
  computeGroupStandings,
  deserializeStructure,
  groupMatchDefs,
  reconcileStructure,
  serializeStructure,
} from "../tournamentStructure";
import {
  acceptTeamInvite,
  cancelTeamInvite,
  declineTeamInvite,
  disbandTeam,
  eligiblePartners,
  fetchTeamInvites,
  fetchTeamsForTournament,
  sendTeamInvite,
} from "../teams";
import { toJsDate } from "../dates";

const tournament = ref(null);
const loading = ref(false);
const activeTab = ref("groups");
// Players who are registered for this tournament (used for groups/bracket).
const players = ref([]);
// Every player in the system, used to resolve the logged-in user's own
// profile even before they've joined the tournament.
const allPlayers = ref([]);

// Match documents from Firestore, keyed by match ID. These are the source of
// truth for what was actually played — including which players a match was
// created for, which is how a finished draw survives participant changes.
const matchDocs = ref({});
const scores = ref({});
const savingMatch = ref(null);
const matchError = ref("");

// Group-stage UI state
const expandedGroups = ref({});
const editingMatch = ref({});

// Participants
const participants = ref([]);
const joiningTournament = ref(false);
const leavingTournament = ref(false);
const removingParticipantId = ref(null);
const participantError = ref("");

// Frozen draw from /tournaments/{id}/structure/main, when one exists.
const lockedStructure = ref(null);
const savingDraw = ref(false);

// Doubles: teams for this tournament + open partner invites. Only loaded
// when the tournament's format is "doubles".
const teams = ref([]);
const teamInvites = ref([]);
const selectedPartnerId = ref("");
const sendingInvite = ref(false);
const respondingInviteId = ref(null);
const leavingTeam = ref(false);
const removingTeamId = ref(null);
const teamError = ref("");

// Bracket reveal timing
const now = ref(new Date());
let nowIntervalId = null;

// Permissions
const isAdmin = ref(false);
const currentUser = computed(() => auth.currentUser);

function isMatchPlayer(match) {
  const uid = currentUser.value?.uid;
  if (!uid) return false;
  return [match.player1, match.player2].some((entity) => {
    if (!entity) return false;
    // Doubles entities are teams — check both players on the team rather
    // than the team's own (non-auth) ID.
    if (Array.isArray(entity.players)) {
      return entity.players.some((p) => p.id === uid);
    }
    return entity.id === uid || entity.authUid === uid;
  });
}

function canEditMatch(match) {
  // Nobody — not even an admin — logs a result before the roster is
  // finalized and the tournament is explicitly started. See
  // hasTournamentStarted.
  if (!hasTournamentStarted.value) return false;
  // Once the tournament is finished, only admins may still submit/edit
  // results — the players themselves lose edit access.
  if (isTournamentFinished.value) return isAdmin.value;
  return isAdmin.value || isMatchPlayer(match);
}

function pendingResultLabel() {
  return isTournamentFinished.value ? "No result recorded" : "Awaiting result";
}

// The logged-in user's own player profile, matched the same way as
// isMatchPlayer: either the player doc's ID or its authUid field equals
// the Firebase Auth uid. Looked up against allPlayers (not the
// tournament-filtered players list) so this resolves even before the
// user has joined the tournament.
const currentPlayer = computed(() => {
  const uid = currentUser.value?.uid;
  if (!uid) return null;
  return (
    allPlayers.value.find((p) => p.id === uid || p.authUid === uid) || null
  );
});

const isParticipant = computed(() => {
  if (!currentPlayer.value) return false;
  return participants.value.some((p) => p.id === currentPlayer.value.id);
});

// The bracket unlocks at 6:00 PM (local time) on the tournament's date.
const bracketUnlockAt = computed(() => {
  const d = toJsDate(tournament.value?.date);
  if (!d) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 18, 0, 0, 0);
});

const bracketUnlockLabel = computed(() => {
  if (!bracketUnlockAt.value) return "";
  return bracketUnlockAt.value.toLocaleString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
});

// Admins can preview the bracket early; everyone else waits for the
// reveal time.
const isBracketUnlocked = computed(() => {
  if (isAdmin.value) return true;
  if (!bracketUnlockAt.value) return false;
  return now.value.getTime() >= bracketUnlockAt.value.getTime();
});

// Tournament finish + rating update state
const finishingTournament = ref(false);
const updatingRatings = ref(false);
const revertingRatings = ref(false);
const ratingsError = ref("");

const isTournamentFinished = computed(() => !!tournament.value?.finishedAt);
const ratingsApplied = computed(() => !!tournament.value?.ratingsAppliedAt);
const isDoublesFormat = computed(() => tournament.value?.format === "doubles");

// --- The draw (groups + bracket) --------------------------------------
//
// The draw is never derived from the live participant list once there's
// any match evidence to rebuild it from. In priority order:
//   1. An explicitly locked draw, saved at /tournaments/{id}/structure/main.
//   2. Reconstructed from the match documents themselves — those record
//      the player IDs they were created for, so a late approval, a join,
//      a removal, or even reopening the tournament can't reshuffle groups
//      that were already played. Anyone who's joined but hasn't played a
//      recorded match yet is appended as a trailing group rather than
//      forcing a reshuffle of everyone else.
//   3. Only when there's no match evidence at all (a brand-new tournament)
//      does the draw follow the live participant list.
const drawLocked = computed(() => !!lockedStructure.value);

// Doubles participant docs are still one per player (per the schema) —
// the entities the draw actually seats are the distinct teams among them.
const doublesTeamIds = computed(() => {
  const ids = new Set();
  participants.value.forEach((p) => {
    if (p.teamId) ids.add(p.teamId);
  });
  return [...ids];
});

const drawEntryIds = computed(() =>
  isDoublesFormat.value ? doublesTeamIds.value : players.value.map((p) => p.id),
);

// Frozen (initialRating) rating per draw entity — used only to seed the
// bracket once group stage is complete (group winners/runners-up are
// ranked by this within their tier). Doubles: a team's rating is whatever
// was recorded on either of its two participant docs (both carry the
// same value).
const entityRatingsById = computed(() => {
  const ratings = {};
  participants.value.forEach((p) => {
    if (typeof p.initialRating !== "number") return;
    const entityId = isDoublesFormat.value ? p.teamId : p.id;
    if (entityId) ratings[entityId] = p.initialRating;
  });
  return ratings;
});

const structure = computed(() => {
  if (lockedStructure.value) return lockedStructure.value;
  return reconcileStructure(
    Object.values(matchDocs.value),
    drawEntryIds.value,
    entityRatingsById.value,
  );
});

// Name/photo/rating lookup for any player ID in the draw. Name and photo
// come from the live player doc (people update those); rating is the
// player's *initialRating* snapshot — the rating they carried into this
// tournament — not their live current rating, so groups and the bracket
// read as a record of what the tournament actually looked like rather
// than shifting every time a later tournament's ratings are applied.
// Falls back to the denormalized fields on the participant doc, then to a
// placeholder, so a deleted player doc still leaves a readable bracket.
const playerDirectory = computed(() => {
  const directory = {};
  participants.value.forEach((p) => {
    directory[p.id] = {
      id: p.id,
      fullName: p.playerName || "Unknown player",
      profilePhotoUrl: p.playerPhotoUrl || null,
      currentRating:
        typeof p.initialRating === "number" ? p.initialRating : null,
    };
  });
  allPlayers.value.forEach((p) => {
    const historicalRating = directory[p.id]?.currentRating;
    directory[p.id] = {
      ...directory[p.id],
      ...p,
      fullName: p.fullName || directory[p.id]?.fullName || "Unknown player",
      profilePhotoUrl:
        p.profilePhotoUrl || directory[p.id]?.profilePhotoUrl || null,
      // Prefer the tournament-time snapshot over the live rating whenever
      // one was recorded; only a player with no snapshot at all (shouldn't
      // normally happen) falls through to their current rating.
      currentRating:
        typeof historicalRating === "number"
          ? historicalRating
          : p.currentRating,
    };
  });
  return directory;
});

// Doubles equivalent of playerDirectory: name/rating for each team, built
// from the live /teams doc (name, live teamRating) merged with the
// participants' frozen initialRating snapshot, same historical-rating
// preference as playerDirectory. `players` carries the two participant
// docs so isMatchPlayer can check either player's uid against a match.
const teamDirectory = computed(() => {
  const directory = {};
  const byTeam = {};
  participants.value.forEach((p) => {
    if (!p.teamId) return;
    (byTeam[p.teamId] ??= []).push(p);
  });

  teams.value.forEach((t) => {
    const pair = byTeam[t.id] ?? [];
    const historicalRating =
      typeof pair[0]?.initialRating === "number" ? pair[0].initialRating : null;
    directory[t.id] = {
      id: t.id,
      fullName:
        t.teamName ||
        pair.map((p) => p.playerName || "Unknown").join(" & ") ||
        "Unknown team",
      currentRating:
        typeof historicalRating === "number" ? historicalRating : t.teamRating,
      players: pair,
    };
  });

  // A team referenced by participants/matches whose /teams doc is missing
  // for some reason still gets a readable entry instead of a blank one.
  Object.entries(byTeam).forEach(([teamId, pair]) => {
    if (directory[teamId]) return;
    directory[teamId] = {
      id: teamId,
      fullName:
        pair.map((p) => p.playerName || "Unknown").join(" & ") ||
        "Unknown team",
      currentRating:
        typeof pair[0]?.initialRating === "number"
          ? pair[0].initialRating
          : null,
      players: pair,
    };
  });

  return directory;
});

function playerFor(entityId) {
  if (!entityId) return null;
  const directory = isDoublesFormat.value
    ? teamDirectory.value
    : playerDirectory.value;
  return (
    directory[entityId] ?? {
      id: entityId,
      fullName: isDoublesFormat.value ? "Unknown team" : "Unknown player",
      currentRating: null,
    }
  );
}

function hydrateMatch(matchDef) {
  return {
    ...matchDef,
    player1: playerFor(matchDef.player1Id),
    player2: playerFor(matchDef.player2Id),
  };
}

function ratingLabel(player) {
  return typeof player?.currentRating === "number"
    ? Math.round(player.currentRating)
    : "—";
}

// Prefers the player's live photo (so a later profile-photo change shows
// up here too), falling back to whatever was denormalized onto the
// participant doc at join time.
function participantPhoto(participant) {
  return (
    playerFor(participant.id)?.profilePhotoUrl ||
    participant.playerPhotoUrl ||
    null
  );
}

// Each group member's win/loss record (live, updates as group matches
// come in) and whether they've actually been seeded into the bracket —
// that only turns on once the *whole* group stage is done and seeding
// has run (see deriveBracketSeedsFromGroups), not just "currently
// leading," since a still-in-progress group's top 2 isn't locked in yet.
const groups = computed(() => {
  const allMatches = Object.values(matchDocs.value);
  const seededIds = new Set(
    (structure.value.bracketSeeds ?? []).filter(Boolean),
  );
  return (structure.value.groups ?? []).map((groupDef) => {
    const standingsById = {};
    computeGroupStandings(groupDef, allMatches).forEach((row) => {
      standingsById[row.playerId] = row;
    });
    return {
      id: groupDef.id,
      players: groupDef.playerIds
        .map(playerFor)
        .filter(Boolean)
        .map((p) => ({
          ...p,
          wins: standingsById[p.id]?.wins ?? 0,
          losses: standingsById[p.id]?.losses ?? 0,
          advanced: seededIds.has(p.id),
        })),
      matches: groupMatchDefs(groupDef).map(hydrateMatch),
    };
  });
});

// Winners are carried forward, so rounds past the first show real names
// once their feeder matches are reported instead of a permanent "TBD".
const bracket = computed(() =>
  buildBracketRounds(
    structure.value.bracketSeeds ?? [],
    (matchId) => matchDocs.value[matchId]?.winnerPlayerId ?? null,
  ).map((round) => ({
    name: round.name,
    matches: round.matches.map(hydrateMatch),
  })),
);

const drawPlayerIds = computed(() => {
  const ids = new Set();
  (structure.value.groups ?? []).forEach((g) =>
    g.playerIds.forEach((id) => id && ids.add(id)),
  );
  (structure.value.bracketSeeds ?? []).forEach((id) => id && ids.add(id));
  return [...ids];
});

// A tournament that already shows signs of being underway — a locked
// draw, or a recorded match — from before this explicit start step
// existed. Treating those as "started" means nothing already in progress
// gets retroactively locked out by this gate.
const hasLegacyStartSignal = computed(
  () =>
    drawLocked.value ||
    Object.keys(matchDocs.value).length > 0 ||
    isTournamentFinished.value,
);

// Group play and the bracket — and match entry — only open up once an
// admin explicitly starts the tournament (see startTournament). Before
// that, participants can still join/leave freely, but nobody can log a
// result against a roster that isn't finalized yet.
const hasTournamentStarted = computed(
  () => !!tournament.value?.startedAt || hasLegacyStartSignal.value,
);

// A match counts as reported once it has both scores on record.
const savedMatches = computed(() => {
  const reported = {};
  Object.entries(matchDocs.value).forEach(([matchId, data]) => {
    if (
      typeof data.player1Score === "number" &&
      typeof data.player2Score === "number"
    ) {
      reported[matchId] = true;
    }
  });
  return reported;
});

async function loadUserAuthorization() {
  const user = auth.currentUser;
  if (!user) {
    isAdmin.value = false;
    return;
  }
  isAdmin.value = await isUserAdminByEmail(user.email);
}

async function loadActiveTournament() {
  loading.value = true;
  try {
    const q = query(
      collection(db, "tournaments"),
      where("status", "==", "active"),
    );
    const snaps = await getDocs(q);
    // A finished tournament is never "the" active one, even if its status
    // field never got flipped (true for anything finished before that
    // became part of finishing a tournament) — otherwise a newly-approved
    // player can land on a tournament that's supposed to be long closed.
    // If more than one somehow qualifies, prefer the most recent by date.
    const candidates = snaps.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((t) => !t.finishedAt)
      .sort(
        (a, b) =>
          (toJsDate(b.date)?.getTime() ?? 0) -
          (toJsDate(a.date)?.getTime() ?? 0),
      );

    if (candidates.length > 0) {
      tournament.value = candidates[0];
      await loadParticipants(tournament.value.id);
      await loadTournamentPlayers(tournament.value.id);
      await loadTournamentMatches(tournament.value.id);
      await loadDraw(tournament.value.id);
      await loadTeamsAndInvites(tournament.value.id);
    }
  } catch (e) {
    console.error("loadActiveTournament", e);
  } finally {
    loading.value = false;
  }
}

async function loadTournamentPlayers(tournamentId) {
  try {
    // Only include players who have actually joined this tournament
    // (see loadParticipants) — pull their full profile (rating, photo,
    // etc.) from the top-level players collection.
    const snaps = await getDocs(collection(db, "players"));
    allPlayers.value = snaps.docs.map((d) => ({ id: d.id, ...d.data() }));
    refreshRegisteredPlayers();
  } catch (e) {
    console.error("loadTournamentPlayers", e);
  }
}

// Recomputes `players` (registered-only) from the already-fetched
// allPlayers + participants lists, without another network round trip.
function refreshRegisteredPlayers() {
  const participantIds = new Set(participants.value.map((p) => p.id));
  players.value = allPlayers.value.filter((p) => participantIds.has(p.id));
}

async function loadTournamentMatches(tournamentId) {
  try {
    const snaps = await getDocs(
      collection(db, "tournaments", tournamentId, "matches"),
    );
    const loadedDocs = {};
    const loadedScores = {};
    snaps.docs.forEach((d) => {
      const data = { id: d.id, ...d.data() };
      loadedDocs[d.id] = data;
      if (
        typeof data.player1Score === "number" &&
        typeof data.player2Score === "number"
      ) {
        loadedScores[d.id] = { 1: data.player1Score, 2: data.player2Score };
      }
    });
    matchDocs.value = loadedDocs;
    scores.value = loadedScores;
  } catch (e) {
    console.error("loadTournamentMatches", e);
  }
}

async function loadDraw(tournamentId) {
  try {
    const snap = await getDoc(
      doc(db, "tournaments", tournamentId, "structure", "main"),
    );
    lockedStructure.value = snap.exists()
      ? deserializeStructure(snap.data())
      : null;
  } catch (e) {
    console.error("loadDraw", e);
    lockedStructure.value = null;
  }
}

// Loaded unconditionally — cheap (a single equality query each, empty for
// a singles tournament) and avoids threading format checks through the
// loading chain.
async function loadTeamsAndInvites(tournamentId) {
  try {
    const [teamDocs, invites] = await Promise.all([
      fetchTeamsForTournament(tournamentId),
      fetchTeamInvites(tournamentId),
    ]);
    teams.value = teamDocs;
    teamInvites.value = invites;
  } catch (e) {
    console.error("loadTeamsAndInvites", e);
  }
}

async function loadParticipants(tournamentId) {
  try {
    const snaps = await getDocs(
      collection(db, "tournaments", tournamentId, "participants"),
    );
    participants.value = snaps.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.error("loadParticipants", e);
  }
}

async function joinTournament() {
  if (!tournament.value) return;
  if (!currentPlayer.value) {
    participantError.value =
      "We couldn't find a player profile for your account.";
    return;
  }
  // Joining after the fact would land a player in a draw that has already
  // been played — which is exactly how groups used to get reshuffled
  // underneath reported results.
  if (isTournamentFinished.value) {
    participantError.value =
      "This tournament is finished — sign-ups are closed.";
    return;
  }
  if (hasTournamentStarted.value) {
    participantError.value =
      "This tournament has already started — registration is closed.";
    return;
  }
  joiningTournament.value = true;
  participantError.value = "";
  try {
    await setDoc(
      doc(
        db,
        "tournaments",
        tournament.value.id,
        "participants",
        currentPlayer.value.id,
      ),
      {
        playerId: currentPlayer.value.id,
        playerName: currentPlayer.value.fullName || "",
        playerPhotoUrl: currentPlayer.value.profilePhotoUrl || null,
        teamId: null,
        joinedAt: serverTimestamp(),
        // Snapshot of the rating carried in. Re-written by the rating
        // engine when ratings are applied, so it always reflects what was
        // actually computed against.
        initialRating:
          typeof currentPlayer.value.currentRating === "number"
            ? currentPlayer.value.currentRating
            : null,
      },
    );
    await loadParticipants(tournament.value.id);
    refreshRegisteredPlayers();
  } catch (e) {
    participantError.value = e.message || "Unable to join the tournament.";
  } finally {
    joiningTournament.value = false;
  }
}

async function leaveTournament() {
  if (!tournament.value || !currentPlayer.value) return;
  if (isTournamentFinished.value) {
    participantError.value =
      "This tournament is finished — ask an admin if you need to be removed.";
    return;
  }
  if (hasTournamentStarted.value) {
    participantError.value =
      "This tournament has already started — ask an admin if you need to be removed.";
    return;
  }
  leavingTournament.value = true;
  participantError.value = "";
  try {
    await deleteDoc(
      doc(
        db,
        "tournaments",
        tournament.value.id,
        "participants",
        currentPlayer.value.id,
      ),
    );
    await loadParticipants(tournament.value.id);
    refreshRegisteredPlayers();
  } catch (e) {
    participantError.value = e.message || "Unable to leave the tournament.";
  } finally {
    leavingTournament.value = false;
  }
}

// Admin cleanup for people who ended up on a tournament they didn't play.
async function removeParticipant(participant) {
  if (!tournament.value || !isAdmin.value) return;
  const label = participant.playerName || participant.id;
  if (!window.confirm(`Remove ${label} from this tournament?`)) return;

  removingParticipantId.value = participant.id;
  participantError.value = "";
  try {
    await deleteDoc(
      doc(
        db,
        "tournaments",
        tournament.value.id,
        "participants",
        participant.id,
      ),
    );
    await loadParticipants(tournament.value.id);
    refreshRegisteredPlayers();
  } catch (e) {
    participantError.value = e.message || "Unable to remove this participant.";
  } finally {
    removingParticipantId.value = null;
  }
}

// --- Doubles: partnering -----------------------------------------------

const myParticipantRecord = computed(() => {
  if (!currentPlayer.value) return null;
  return (
    participants.value.find((p) => p.id === currentPlayer.value.id) ?? null
  );
});

const myTeamId = computed(() => myParticipantRecord.value?.teamId ?? null);

// Raw /teams doc — used for actions (has player1Id/player2Id directly).
const myRawTeam = computed(
  () => teams.value.find((t) => t.id === myTeamId.value) ?? null,
);

// Hydrated version — used for display (name, historical rating).
const myTeam = computed(() =>
  myTeamId.value ? teamDirectory.value[myTeamId.value] : null,
);

const myPartnerName = computed(() => {
  if (!myTeam.value || !currentPlayer.value) return "your partner";
  const other = (myTeam.value.players || []).find(
    (p) => p.id !== currentPlayer.value.id,
  );
  return other?.playerName || "your partner";
});

const outgoingInvite = computed(() => {
  if (!currentPlayer.value) return null;
  return (
    teamInvites.value.find(
      (inv) =>
        inv.status === "pending" && inv.fromPlayerId === currentPlayer.value.id,
    ) ?? null
  );
});

const incomingInvites = computed(() => {
  if (!currentPlayer.value) return [];
  return teamInvites.value.filter(
    (inv) =>
      inv.status === "pending" && inv.toPlayerId === currentPlayer.value.id,
  );
});

const eligiblePartnersList = computed(() => {
  if (!currentPlayer.value) return [];
  return eligiblePartners(
    allPlayers.value,
    participants.value,
    teamInvites.value,
    currentPlayer.value.id,
  );
});

async function sendPartnerInvite() {
  if (!tournament.value || !currentPlayer.value || !selectedPartnerId.value)
    return;
  const partner = allPlayers.value.find(
    (p) => p.id === selectedPartnerId.value,
  );
  if (!partner) return;

  sendingInvite.value = true;
  teamError.value = "";
  try {
    await sendTeamInvite(tournament.value.id, currentPlayer.value, partner);
    selectedPartnerId.value = "";
    await loadTeamsAndInvites(tournament.value.id);
  } catch (e) {
    teamError.value = e.message || "Unable to send invite.";
  } finally {
    sendingInvite.value = false;
  }
}

async function respondToInvite(invite, accept) {
  if (!tournament.value) return;
  respondingInviteId.value = invite.id;
  teamError.value = "";
  try {
    if (accept) {
      await acceptTeamInvite(invite);
    } else {
      await declineTeamInvite(invite);
    }
    await Promise.all([
      loadParticipants(tournament.value.id),
      loadTeamsAndInvites(tournament.value.id),
    ]);
    refreshRegisteredPlayers();
  } catch (e) {
    teamError.value = e.message || "Unable to respond to this invite.";
  } finally {
    respondingInviteId.value = null;
  }
}

async function cancelMyInvite() {
  if (!outgoingInvite.value) return;
  respondingInviteId.value = outgoingInvite.value.id;
  teamError.value = "";
  try {
    await cancelTeamInvite(outgoingInvite.value);
    await loadTeamsAndInvites(tournament.value.id);
  } catch (e) {
    teamError.value = e.message || "Unable to cancel this invite.";
  } finally {
    respondingInviteId.value = null;
  }
}

async function leaveMyTeam() {
  if (!tournament.value || !myRawTeam.value) return;
  if (isTournamentFinished.value) {
    teamError.value =
      "This tournament is finished — ask an admin if you need changes.";
    return;
  }
  if (hasTournamentStarted.value) {
    teamError.value =
      "This tournament has already started — ask an admin if you need changes.";
    return;
  }
  if (
    !window.confirm(
      "Disband your team? This removes both of you from the tournament.",
    )
  )
    return;

  leavingTeam.value = true;
  teamError.value = "";
  try {
    const playerIds = [
      myRawTeam.value.player1Id,
      myRawTeam.value.player2Id,
    ].filter(Boolean);
    await disbandTeam(tournament.value.id, myRawTeam.value.id, playerIds);
    await Promise.all([
      loadParticipants(tournament.value.id),
      loadTeamsAndInvites(tournament.value.id),
    ]);
    refreshRegisteredPlayers();
  } catch (e) {
    teamError.value = e.message || "Unable to leave the team.";
  } finally {
    leavingTeam.value = false;
  }
}

// Admin cleanup, parallel to removeParticipant for singles.
async function removeTeam(team) {
  if (!tournament.value || !isAdmin.value) return;
  const label = team.teamName || team.id;
  if (!window.confirm(`Remove team "${label}" from this tournament?`)) return;

  removingTeamId.value = team.id;
  participantError.value = "";
  try {
    const playerIds = [team.player1Id, team.player2Id].filter(Boolean);
    await disbandTeam(tournament.value.id, team.id, playerIds);
    await Promise.all([
      loadParticipants(tournament.value.id),
      loadTeamsAndInvites(tournament.value.id),
    ]);
    refreshRegisteredPlayers();
  } catch (e) {
    participantError.value = e.message || "Unable to remove this team.";
  } finally {
    removingTeamId.value = null;
  }
}

function matchScore(matchId, playerNumber) {
  return scores.value[matchId]?.[playerNumber] ?? "";
}

function setMatchScore(matchId, playerNumber, value) {
  if (!scores.value[matchId]) scores.value[matchId] = {};
  scores.value[matchId][playerNumber] = value;
}

// --- Group card expand/collapse ---
function toggleGroupExpanded(groupId) {
  expandedGroups.value[groupId] = !isGroupExpanded(groupId);
}

// Defaults the first group open and the rest collapsed, without writing
// state until the user actually toggles something.
function isGroupExpanded(groupId) {
  if (groupId in expandedGroups.value) return !!expandedGroups.value[groupId];
  return groups.value[0]?.id === groupId;
}

function groupProgress(group) {
  const total = group.matches.length;
  const completed = group.matches.filter(
    (m) => savedMatches.value[m.id],
  ).length;
  return { completed, total };
}

// --- Per-match read-only vs. edit-form state ---
function isEditingMatch(matchId) {
  return !!editingMatch.value[matchId] || !savedMatches.value[matchId];
}

function startEditMatch(matchId) {
  editingMatch.value[matchId] = true;
}

function cancelEditMatch(matchId) {
  editingMatch.value[matchId] = false;
}

async function submitMatch(match) {
  const player1Score = Number(matchScore(match.id, 1));
  const player2Score = Number(matchScore(match.id, 2));
  if (
    !Number.isInteger(player1Score) ||
    !Number.isInteger(player2Score) ||
    player1Score < 0 ||
    player2Score < 0 ||
    player1Score === player2Score
  ) {
    matchError.value = "Enter two different non-negative whole-number scores.";
    return;
  }

  savingMatch.value = match.id;
  matchError.value = "";
  const winner = player1Score > player2Score ? match.player1 : match.player2;
  const loser = player1Score > player2Score ? match.player2 : match.player1;
  const payload = {
    stage: match.stage || "bracket",
    groupId: match.groupId || null,
    roundIndex: match.roundIndex ?? null,
    matchNumber: match.matchNumber ?? null,
    // player1Id/player2Id/winnerPlayerId/loserPlayerId hold team IDs for a
    // doubles tournament (kept generic so the draw/rating code doesn't
    // need to branch on format). winnerTeamId/loserTeamId mirror the same
    // value for doubles, matching the schema in notes.txt.
    player1Id: match.player1.id,
    player2Id: match.player2.id,
    player1Score,
    player2Score,
    winnerPlayerId: winner.id,
    loserPlayerId: loser.id,
    winnerTeamId: isDoublesFormat.value ? winner.id : null,
    loserTeamId: isDoublesFormat.value ? loser.id : null,
    status: "submitted",
    submittedBy: auth.currentUser?.uid || null,
    isVerified: false,
  };
  try {
    await setDoc(
      doc(db, "tournaments", tournament.value.id, "matches", match.id),
      { ...payload, updatedAt: serverTimestamp() },
      { merge: true },
    );
    // Mirror locally so the bracket advances the winner immediately.
    matchDocs.value = {
      ...matchDocs.value,
      [match.id]: { id: match.id, ...matchDocs.value[match.id], ...payload },
    };
    editingMatch.value[match.id] = false;
  } catch (error) {
    matchError.value = error.message || "Unable to save this result.";
  } finally {
    savingMatch.value = null;
  }
}

const isActive = computed(() => tournament.value !== null);

// --- Admin: start the tournament / reopen registration ---
//
// Starting is the "roster is finalized" moment: it locks the current
// draw (same snapshot lockDraw writes) so joins/removals can't reshuffle
// it, and flips startedAt, which is what actually gates match entry (see
// canEditMatch) and the groups/bracket tabs (see hasTournamentStarted).
const startingTournament = ref(false);

async function startTournament() {
  if (!tournament.value || !isAdmin.value || hasTournamentStarted.value) return;
  const confirmed = window.confirm(
    "Start the tournament? This locks in the current participants — the draw stops following joins or removals — and opens match results for entry.",
  );
  if (!confirmed) return;

  startingTournament.value = true;
  ratingsError.value = "";
  try {
    await persistDraw(structure.value);
    await setDoc(
      doc(db, "tournaments", tournament.value.id),
      { startedAt: serverTimestamp() },
      { merge: true },
    );
    tournament.value = { ...tournament.value, startedAt: new Date() };
  } catch (e) {
    ratingsError.value = e.message || "Unable to start the tournament.";
  } finally {
    startingTournament.value = false;
  }
}

async function reopenRegistration() {
  if (!tournament.value || !isAdmin.value) return;
  const confirmed = window.confirm(
    "Reopen registration? This clears the start flag and unlocks the draw so it goes back to following the participant list. Only do this if match play hasn't begun.",
  );
  if (!confirmed) return;

  startingTournament.value = true;
  ratingsError.value = "";
  try {
    await deleteDoc(
      doc(db, "tournaments", tournament.value.id, "structure", "main"),
    );
    lockedStructure.value = null;
    await setDoc(
      doc(db, "tournaments", tournament.value.id),
      { startedAt: null },
      { merge: true },
    );
    tournament.value = { ...tournament.value, startedAt: null };
  } catch (e) {
    ratingsError.value = e.message || "Unable to reopen registration.";
  } finally {
    startingTournament.value = false;
  }
}

// --- Admin: lock / unlock the draw ---
async function persistDraw(draw) {
  const payload = serializeStructure(draw);
  await setDoc(
    doc(db, "tournaments", tournament.value.id, "structure", "main"),
    {
      ...payload,
      lockedAt: serverTimestamp(),
      lockedBy: auth.currentUser?.uid || null,
    },
  );
  lockedStructure.value = deserializeStructure(payload);
}

async function lockDraw() {
  if (!tournament.value || !isAdmin.value) return;
  const confirmed = window.confirm(
    "Lock the current groups and bracket? The draw stops following the participant list, so joins or removals won't reshuffle it.",
  );
  if (!confirmed) return;

  savingDraw.value = true;
  ratingsError.value = "";
  try {
    await persistDraw(structure.value);
  } catch (e) {
    ratingsError.value = e.message || "Unable to lock the draw.";
  } finally {
    savingDraw.value = false;
  }
}

async function unlockDraw() {
  if (!tournament.value || !isAdmin.value) return;
  const confirmed = window.confirm(
    "Unlock the draw? It will go back to being reconstructed from recorded matches (or, if nothing's been played yet, from the current participant list) instead of the saved snapshot.",
  );
  if (!confirmed) return;

  savingDraw.value = true;
  ratingsError.value = "";
  try {
    await deleteDoc(
      doc(db, "tournaments", tournament.value.id, "structure", "main"),
    );
    lockedStructure.value = null;
  } catch (e) {
    ratingsError.value = e.message || "Unable to unlock the draw.";
  } finally {
    savingDraw.value = false;
  }
}

// --- Admin: finish / reopen the tournament ---
async function finishTournament() {
  if (!tournament.value || !isAdmin.value) return;
  const confirmed = window.confirm(
    "Finish this tournament? Players won't be able to submit results or sign up anymore, and the current groups and bracket will be locked in. You can still edit results as an admin.",
  );
  if (!confirmed) return;

  finishingTournament.value = true;
  ratingsError.value = "";
  try {
    // Freeze the draw as it stands *before* flipping the flag, so what gets
    // saved is the draw people actually played.
    await persistDraw(structure.value);
    await setDoc(
      doc(db, "tournaments", tournament.value.id),
      { finishedAt: serverTimestamp(), status: "completed" },
      { merge: true },
    );
    tournament.value = {
      ...tournament.value,
      finishedAt: new Date(),
      status: "completed",
    };
  } catch (e) {
    ratingsError.value = e.message || "Unable to finish the tournament.";
  } finally {
    finishingTournament.value = false;
  }
}

async function reopenTournament() {
  if (!tournament.value || !isAdmin.value) return;
  const confirmed = window.confirm(
    "Reopen this tournament? Players will be able to submit results again.",
  );
  if (!confirmed) return;

  finishingTournament.value = true;
  ratingsError.value = "";
  try {
    await setDoc(
      doc(db, "tournaments", tournament.value.id),
      { finishedAt: null, status: "active" },
      { merge: true },
    );
    tournament.value = {
      ...tournament.value,
      finishedAt: null,
      status: "active",
    };
  } catch (e) {
    ratingsError.value = e.message || "Unable to reopen the tournament.";
  } finally {
    finishingTournament.value = false;
  }
}

// --- Admin: apply / revert rating changes ---
//
// Both delegate to src/ratings.js, which also owns the ordering rule:
// ratings go on oldest tournament first and come off newest first. The
// availability check is what keeps this button from applying ratings out
// of order and poisoning the starting ratings of later tournaments.
async function updatePlayerRatings() {
  if (!tournament.value || !isAdmin.value) return;

  updatingRatings.value = true;
  ratingsError.value = "";
  try {
    const all = await fetchTournaments();
    const current =
      all.find((t) => t.id === tournament.value.id) ?? tournament.value;
    const availability = applyAvailability(current, all);
    if (!availability.allowed) {
      ratingsError.value = availability.reason;
      return;
    }

    const confirmed = window.confirm(
      "Apply rating changes for every submitted match in this tournament? Each participant's current rating is used as their starting rating.",
    );
    if (!confirmed) return;

    await applyTournamentRatings(tournament.value.id);
    tournament.value = { ...tournament.value, ratingsAppliedAt: new Date() };

    // Refresh so the new ratings show up immediately in the Group Stage.
    await loadTournamentPlayers(tournament.value.id);
  } catch (e) {
    ratingsError.value = e.message || "Unable to update player ratings.";
  } finally {
    updatingRatings.value = false;
  }
}

async function revertPlayerRatings() {
  if (!tournament.value || !isAdmin.value) return;

  revertingRatings.value = true;
  ratingsError.value = "";
  try {
    const all = await fetchTournaments();
    const current =
      all.find((t) => t.id === tournament.value.id) ?? tournament.value;
    const availability = revertAvailability(current, all);
    if (!availability.allowed) {
      ratingsError.value = availability.reason;
      return;
    }

    const confirmed = window.confirm(
      "Revert the rating changes from this tournament? Every affected player's rating will be restored to what it was before this tournament, and it will drop off their rating history.",
    );
    if (!confirmed) return;

    await revertTournamentRatings(tournament.value.id);
    tournament.value = { ...tournament.value, ratingsAppliedAt: null };

    await loadTournamentPlayers(tournament.value.id);
  } catch (e) {
    ratingsError.value = e.message || "Unable to revert rating changes.";
  } finally {
    revertingRatings.value = false;
  }
}

onMounted(() => {
  loadActiveTournament();
  auth.onAuthStateChanged(loadUserAuthorization);
  loadUserAuthorization();
  // Re-check the current time periodically so the bracket unlocks on its
  // own once 6 PM passes, without requiring a page refresh.
  nowIntervalId = setInterval(() => {
    now.value = new Date();
  }, 30000);
});

onUnmounted(() => {
  if (nowIntervalId) clearInterval(nowIntervalId);
});
</script>

<template>
  <div class="tournament-view">
    <div v-if="loading" class="loading">Loading tournament...</div>

    <!-- No Tournament Active Overlay -->
    <div v-if="!loading && !isActive" class="no-tournament">
      <div class="overlay-content">
        <h2>No Tournament Active</h2>
        <p>Check back soon for the next tournament!</p>
      </div>
    </div>

    <!-- Active Tournament -->
    <div v-if="isActive" class="tournament-container">
      <div class="tournament-header">
        <h1>{{ tournament.name || "Current Tournament" }}</h1>
        <p v-if="tournament.date" class="date">{{ tournament.date }}</p>
        <p class="player-count">
          {{ drawPlayerIds.length }} {{ isDoublesFormat ? "Teams" : "Players" }}
        </p>

        <div v-if="isAdmin" class="tournament-admin-actions">
          <span v-if="isTournamentFinished" class="status-pill finished"
            >Finished</span
          >
          <span
            v-else-if="!hasTournamentStarted"
            class="status-pill not-started"
            >Not started</span
          >
          <span v-if="drawLocked" class="status-pill locked">Draw locked</span>

          <button
            v-if="!hasTournamentStarted && !isTournamentFinished"
            type="button"
            class="admin-action-btn start-btn"
            :disabled="startingTournament"
            @click="startTournament"
          >
            {{ startingTournament ? "Starting..." : "Start Tournament" }}
          </button>
          <button
            v-if="hasTournamentStarted && !isTournamentFinished"
            type="button"
            class="admin-action-btn reopen-btn"
            :disabled="startingTournament"
            @click="reopenRegistration"
          >
            {{ startingTournament ? "Reopening..." : "Reopen Registration" }}
          </button>

          <button
            v-if="isTournamentFinished"
            type="button"
            class="admin-action-btn reopen-btn"
            :disabled="finishingTournament"
            @click="reopenTournament"
          >
            {{ finishingTournament ? "Reopening..." : "Reopen Tournament" }}
          </button>
          <button
            v-else-if="hasTournamentStarted"
            type="button"
            class="admin-action-btn finish-btn"
            :disabled="finishingTournament"
            @click="finishTournament"
          >
            {{ finishingTournament ? "Finishing..." : "Finish Tournament" }}
          </button>

          <button
            v-if="isTournamentFinished && !ratingsApplied"
            type="button"
            class="admin-action-btn ratings-btn"
            :disabled="updatingRatings"
            @click="updatePlayerRatings"
          >
            {{ updatingRatings ? "Updating Ratings..." : "Update Ratings" }}
          </button>
          <button
            v-if="ratingsApplied"
            type="button"
            class="admin-action-btn revert-btn"
            :disabled="revertingRatings"
            @click="revertPlayerRatings"
          >
            {{ revertingRatings ? "Reverting..." : "Revert Ratings" }}
          </button>

          <template v-if="hasTournamentStarted">
            <button
              v-if="!drawLocked"
              type="button"
              class="admin-action-btn draw-btn"
              :disabled="savingDraw"
              @click="lockDraw"
            >
              {{ savingDraw ? "Locking..." : "Lock Draw" }}
            </button>
            <button
              v-else
              type="button"
              class="admin-action-btn draw-btn"
              :disabled="savingDraw"
              @click="unlockDraw"
            >
              {{ savingDraw ? "Unlocking..." : "Unlock Draw" }}
            </button>
          </template>
        </div>

        <p v-if="ratingsError" class="match-error admin-error">
          {{ ratingsError }}
        </p>
      </div>

      <!-- Tabs -->
      <div class="tabs">
        <button
          :class="{ active: activeTab === 'participants' }"
          @click="activeTab = 'participants'"
        >
          Participants
        </button>
        <button
          :class="{ active: activeTab === 'groups' }"
          @click="activeTab = 'groups'"
        >
          Group Stage
        </button>
        <button
          :class="{ active: activeTab === 'bracket' }"
          @click="activeTab = 'bracket'"
        >
          Elimination Bracket
        </button>
      </div>

      <!-- Group Stage Tab -->
      <div v-if="activeTab === 'groups'" class="tab-content">
        <h2>Group Stage</h2>

        <div v-if="!hasTournamentStarted" class="not-started">
          <h3>Tournament hasn't started</h3>
          <p>
            Group play will appear here once an admin starts the tournament.
            Head to the Participants tab to sign up in the meantime.
          </p>
        </div>

        <div v-else class="groups-container">
          <div v-for="group in groups" :key="group.id" class="group-card">
            <button
              type="button"
              class="group-header"
              :aria-expanded="isGroupExpanded(group.id)"
              @click="toggleGroupExpanded(group.id)"
            >
              <span class="group-header-left">
                <span
                  class="chevron"
                  :class="{ expanded: isGroupExpanded(group.id) }"
                  aria-hidden="true"
                  >▸</span
                >
                <span class="group-title">Group {{ group.id }}</span>
                <span class="group-subtitle"
                  >{{ group.players.length }} players</span
                >
              </span>
              <span
                class="progress-badge"
                :class="{
                  complete:
                    groupProgress(group).completed ===
                    groupProgress(group).total,
                }"
              >
                {{ groupProgress(group).completed }}/{{
                  groupProgress(group).total
                }}
                reported
              </span>
            </button>

            <div v-show="isGroupExpanded(group.id)" class="group-body">
              <ul class="group-players">
                <li v-for="player in group.players" :key="player.id">
                  <span class="player-name">
                    {{ player.fullName }}
                    <span v-if="player.advanced" class="advanced-badge"
                      >Advanced</span
                    >
                  </span>
                  <span class="standing"
                    >{{ player.wins }}-{{ player.losses }}</span
                  >
                  <span class="rating">{{ ratingLabel(player) }}</span>
                </li>
              </ul>

              <div class="group-matches">
                <h4>Matches</h4>

                <div
                  v-for="match in group.matches"
                  :key="match.id"
                  class="match-row"
                >
                  <!-- Completed match: compact read-only result -->
                  <div
                    v-if="savedMatches[match.id] && !isEditingMatch(match.id)"
                    class="match-result"
                  >
                    <span class="result-players">
                      <span
                        class="result-name"
                        :class="{
                          winner:
                            Number(matchScore(match.id, 1)) >
                            Number(matchScore(match.id, 2)),
                        }"
                        >{{ match.player1.fullName }}</span
                      >
                      <span class="result-score"
                        >{{ matchScore(match.id, 1) }} –
                        {{ matchScore(match.id, 2) }}</span
                      >
                      <span
                        class="result-name"
                        :class="{
                          winner:
                            Number(matchScore(match.id, 2)) >
                            Number(matchScore(match.id, 1)),
                        }"
                        >{{ match.player2.fullName }}</span
                      >
                    </span>
                    <button
                      v-if="canEditMatch(match)"
                      type="button"
                      class="edit-btn"
                      @click="startEditMatch(match.id)"
                    >
                      Edit
                    </button>
                  </div>

                  <!-- Entry / edit form: only for match participants or admins -->
                  <div v-else-if="canEditMatch(match)" class="match-form">
                    <div class="score-player">
                      <span class="score-player-name">{{
                        match.player1.fullName
                      }}</span>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        :value="matchScore(match.id, 1)"
                        aria-label="Player 1 score"
                        @input="setMatchScore(match.id, 1, $event.target.value)"
                      />
                    </div>
                    <div class="score-player">
                      <span class="score-player-name">{{
                        match.player2.fullName
                      }}</span>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        :value="matchScore(match.id, 2)"
                        aria-label="Player 2 score"
                        @input="setMatchScore(match.id, 2, $event.target.value)"
                      />
                    </div>
                    <div class="match-form-actions">
                      <button
                        type="button"
                        class="submit-btn"
                        :disabled="savingMatch === match.id"
                        @click="submitMatch(match)"
                      >
                        {{
                          savingMatch === match.id
                            ? "Saving..."
                            : savedMatches[match.id]
                              ? "Update Result"
                              : "Submit Result"
                        }}
                      </button>
                      <button
                        v-if="savedMatches[match.id]"
                        type="button"
                        class="cancel-btn"
                        @click="cancelEditMatch(match.id)"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>

                  <!-- Read-only placeholder for spectators before a result exists -->
                  <div v-else class="match-pending">
                    <span class="pending-players">
                      {{ match.player1.fullName }} vs
                      {{ match.player2.fullName }}
                    </span>
                    <span class="pending-label">{{
                      pendingResultLabel()
                    }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <p v-if="matchError" class="match-error">{{ matchError }}</p>
      </div>

      <!-- Participants Tab -->
      <div v-if="activeTab === 'participants'" class="tab-content">
        <h2>Participants</h2>

        <div class="participants-actions">
          <p v-if="isDoublesFormat" class="participants-count">
            {{ teams.length }} {{ teams.length === 1 ? "team" : "teams" }}
            formed
          </p>
          <p v-else class="participants-count">
            {{ participants.length }}
            {{ participants.length === 1 ? "player" : "players" }} joined
          </p>

          <template v-if="!isDoublesFormat">
            <p v-if="isTournamentFinished" class="participants-hint">
              This tournament is finished — sign-ups are closed.
            </p>
            <p
              v-else-if="hasTournamentStarted && currentPlayer && isParticipant"
              class="participants-hint"
            >
              You're locked in for this tournament.
            </p>
            <p v-else-if="hasTournamentStarted" class="participants-hint">
              This tournament has started — registration is closed.
            </p>
            <button
              v-else-if="currentPlayer && !isParticipant"
              type="button"
              class="join-btn"
              :disabled="joiningTournament"
              @click="joinTournament"
            >
              {{ joiningTournament ? "Joining..." : "Join Tournament" }}
            </button>
            <button
              v-else-if="currentPlayer && isParticipant"
              type="button"
              class="leave-btn"
              :disabled="leavingTournament"
              @click="leaveTournament"
            >
              {{ leavingTournament ? "Leaving..." : "Leave Tournament" }}
            </button>
            <p v-else class="participants-hint">
              Sign in with a player profile to join this tournament.
            </p>
          </template>
        </div>

        <p v-if="participantError" class="match-error">
          {{ participantError }}
        </p>

        <!-- Doubles: partner up -->
        <div v-if="isDoublesFormat" class="team-up-card">
          <p v-if="!currentPlayer" class="participants-hint">
            Sign in with a player profile to team up for this tournament.
          </p>
          <p v-else-if="isTournamentFinished" class="participants-hint">
            This tournament is finished — sign-ups are closed.
          </p>

          <template v-else-if="myTeam">
            <p class="team-status">
              You're teamed up with <strong>{{ myPartnerName }}</strong> — team
              rating {{ ratingLabel(myTeam) }}.
            </p>
            <button
              v-if="!hasTournamentStarted"
              type="button"
              class="leave-btn"
              :disabled="leavingTeam"
              @click="leaveMyTeam"
            >
              {{ leavingTeam ? "Leaving..." : "Leave Team" }}
            </button>
          </template>

          <p v-else-if="hasTournamentStarted" class="participants-hint">
            This tournament has started — registration is closed.
          </p>

          <template v-else-if="outgoingInvite">
            <p class="team-status">
              Invite sent to
              <strong>{{ outgoingInvite.toPlayerName }}</strong> — waiting for a
              response.
            </p>
            <button
              type="button"
              class="leave-btn"
              :disabled="respondingInviteId === outgoingInvite.id"
              @click="cancelMyInvite"
            >
              {{
                respondingInviteId === outgoingInvite.id
                  ? "Cancelling..."
                  : "Cancel Invite"
              }}
            </button>
          </template>

          <template v-else>
            <div v-if="incomingInvites.length > 0" class="incoming-invites">
              <div
                v-for="inv in incomingInvites"
                :key="inv.id"
                class="invite-row"
              >
                <span
                  ><strong>{{ inv.fromPlayerName }}</strong> wants to team up
                  with you</span
                >
                <div class="invite-actions">
                  <button
                    type="button"
                    class="join-btn"
                    :disabled="respondingInviteId === inv.id"
                    @click="respondToInvite(inv, true)"
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    class="leave-btn"
                    :disabled="respondingInviteId === inv.id"
                    @click="respondToInvite(inv, false)"
                  >
                    Decline
                  </button>
                </div>
              </div>
            </div>

            <div class="partner-picker">
              <select v-model="selectedPartnerId">
                <option value="">Choose a partner…</option>
                <option
                  v-for="p in eligiblePartnersList"
                  :key="p.id"
                  :value="p.id"
                >
                  {{ p.fullName }}
                </option>
              </select>
              <button
                type="button"
                class="join-btn"
                :disabled="!selectedPartnerId || sendingInvite"
                @click="sendPartnerInvite"
              >
                {{ sendingInvite ? "Sending..." : "Send Invite" }}
              </button>
            </div>
            <p
              v-if="eligiblePartnersList.length === 0"
              class="participants-hint"
            >
              No available partners right now.
            </p>
          </template>

          <p v-if="teamError" class="match-error">{{ teamError }}</p>
        </div>

        <!-- Doubles: team list -->
        <ul
          v-if="isDoublesFormat && teams.length > 0"
          class="participants-list"
        >
          <li
            v-for="team in teams"
            :key="team.id"
            class="participant-row"
            :class="{ 'is-you': myTeamId === team.id }"
          >
            <span class="participant-avatar participant-avatar-fallback">
              {{ (team.teamName || "?").charAt(0).toUpperCase() }}
            </span>
            <span class="participant-name"
              >{{ team.teamName }}
              <span class="rating">{{ Math.round(team.teamRating) }}</span>
            </span>
            <span v-if="myTeamId === team.id" class="you-badge">You</span>
            <button
              v-if="isAdmin"
              type="button"
              class="remove-participant-btn"
              :disabled="removingTeamId === team.id"
              @click="removeTeam(team)"
            >
              {{ removingTeamId === team.id ? "Removing..." : "Remove" }}
            </button>
          </li>
        </ul>
        <p v-else-if="isDoublesFormat" class="participants-empty">
          No teams formed yet.
        </p>

        <!-- Singles: participant list -->
        <ul
          v-if="!isDoublesFormat && participants.length > 0"
          class="participants-list"
        >
          <li
            v-for="participant in participants"
            :key="participant.id"
            class="participant-row"
            :class="{
              'is-you': currentPlayer && participant.id === currentPlayer.id,
            }"
          >
            <img
              v-if="participantPhoto(participant)"
              :src="participantPhoto(participant)"
              :alt="participant.playerName"
              class="participant-avatar"
            />
            <span v-else class="participant-avatar participant-avatar-fallback">
              {{ (participant.playerName || "?").charAt(0).toUpperCase() }}
            </span>
            <span class="participant-name">{{ participant.playerName }}</span>
            <span
              v-if="currentPlayer && participant.id === currentPlayer.id"
              class="you-badge"
              >You</span
            >
            <button
              v-if="isAdmin"
              type="button"
              class="remove-participant-btn"
              :disabled="removingParticipantId === participant.id"
              @click="removeParticipant(participant)"
            >
              {{
                removingParticipantId === participant.id
                  ? "Removing..."
                  : "Remove"
              }}
            </button>
          </li>
        </ul>
        <p v-else-if="!isDoublesFormat" class="participants-empty">
          No one has joined yet. Be the first!
        </p>
      </div>

      <!-- Elimination Bracket Tab -->
      <div v-if="activeTab === 'bracket'" class="tab-content">
        <h2>Elimination Bracket</h2>

        <div v-if="!hasTournamentStarted" class="not-started">
          <h3>Tournament hasn't started</h3>
          <p>
            The bracket will appear here once an admin starts the tournament.
            Head to the Participants tab to sign up in the meantime.
          </p>
        </div>

        <div v-else-if="!isBracketUnlocked" class="bracket-locked">
          <h3>Bracket not revealed yet</h3>
          <p v-if="bracketUnlockLabel">
            The bracket unlocks on {{ bracketUnlockLabel }}.
          </p>
          <p v-else>The bracket unlocks once the tournament date is set.</p>
        </div>

        <template v-else>
          <div class="bracket-container">
            <div
              v-for="(round, idx) in bracket"
              :key="idx"
              class="bracket-round"
            >
              <h3>{{ round.name }}</h3>
              <div class="matches">
                <template v-for="m in round.matches" :key="m.id">
                  <div
                    v-if="!m.player1 || !m.player2"
                    class="match-row bracket-match-row"
                  >
                    <div class="matchup">
                      <div class="player">
                        {{ m.player1?.fullName || "TBD" }}
                      </div>
                      <div class="vs">vs</div>
                      <div class="player">
                        {{ m.player2?.fullName || "TBD" }}
                      </div>
                    </div>
                  </div>

                  <div v-else class="match-row bracket-match-row">
                    <!-- Completed match: compact read-only result -->
                    <div
                      v-if="savedMatches[m.id] && !isEditingMatch(m.id)"
                      class="match-result bracket-match-result"
                    >
                      <span class="result-players">
                        <span
                          class="result-name"
                          :class="{
                            winner:
                              Number(matchScore(m.id, 1)) >
                              Number(matchScore(m.id, 2)),
                          }"
                          >{{ m.player1.fullName }}</span
                        >
                        <span class="result-score"
                          >{{ matchScore(m.id, 1) }} –
                          {{ matchScore(m.id, 2) }}</span
                        >
                        <span
                          class="result-name"
                          :class="{
                            winner:
                              Number(matchScore(m.id, 2)) >
                              Number(matchScore(m.id, 1)),
                          }"
                          >{{ m.player2.fullName }}</span
                        >
                      </span>
                      <button
                        v-if="canEditMatch(m)"
                        type="button"
                        class="edit-btn"
                        @click="startEditMatch(m.id)"
                      >
                        Edit
                      </button>
                    </div>

                    <!-- Entry / edit form: only for match participants or admins -->
                    <div v-else-if="canEditMatch(m)" class="match-form">
                      <div class="score-player">
                        <span class="score-player-name">{{
                          m.player1.fullName
                        }}</span>
                        <input
                          type="number"
                          min="0"
                          step="1"
                          :value="matchScore(m.id, 1)"
                          aria-label="Player 1 score"
                          @input="setMatchScore(m.id, 1, $event.target.value)"
                        />
                      </div>
                      <div class="score-player">
                        <span class="score-player-name">{{
                          m.player2.fullName
                        }}</span>
                        <input
                          type="number"
                          min="0"
                          step="1"
                          :value="matchScore(m.id, 2)"
                          aria-label="Player 2 score"
                          @input="setMatchScore(m.id, 2, $event.target.value)"
                        />
                      </div>
                      <div class="match-form-actions">
                        <button
                          type="button"
                          class="submit-btn"
                          :disabled="savingMatch === m.id"
                          @click="submitMatch(m)"
                        >
                          {{
                            savingMatch === m.id
                              ? "Saving..."
                              : savedMatches[m.id]
                                ? "Update Result"
                                : "Submit Result"
                          }}
                        </button>
                        <button
                          v-if="savedMatches[m.id]"
                          type="button"
                          class="cancel-btn"
                          @click="cancelEditMatch(m.id)"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>

                    <!-- Read-only placeholder for spectators before a result exists -->
                    <div v-else class="match-pending">
                      <span class="pending-players">
                        {{ m.player1.fullName }} vs {{ m.player2.fullName }}
                      </span>
                      <span class="pending-label">{{
                        pendingResultLabel()
                      }}</span>
                    </div>
                  </div>
                </template>
              </div>
            </div>
          </div>
          <p v-if="matchError" class="match-error">{{ matchError }}</p>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tournament-view {
  position: relative;
  min-height: 100vh;
  background: linear-gradient(135deg, #1a1a1a 0%, #0f0f0f 100%);
}

.loading {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 60vh;
  font-size: 1.2rem;
  color: #999;
}

.no-tournament {
  position: relative;
  min-height: 100vh;
  background: linear-gradient(
    135deg,
    rgba(20, 20, 20, 0.8) 0%,
    rgba(10, 10, 10, 0.8) 100%
  );
  display: flex;
  align-items: center;
  justify-content: center;
}

.overlay-content {
  text-align: center;
  z-index: 10;
}

.overlay-content h2 {
  font-size: 2.5rem;
  margin-bottom: 0.5rem;
  color: #e8e8e8;
}

.overlay-content p {
  font-size: 1.1rem;
  color: #999;
}

.tournament-container {
  padding: 2rem;
  max-width: 1400px;
  margin: 0 auto;
}

.tournament-header {
  position: relative;
  text-align: center;
  margin-bottom: 2rem;
}

.tournament-header h1 {
  font-size: 2.5rem;
  margin-bottom: 0.5rem;
  color: #f4f7fb;
}

.tournament-header .date {
  color: #b8b8b8;
  margin-bottom: 0.25rem;
}

.tournament-header .player-count {
  color: hsl(var(--primary-color));
  font-weight: 600;
}

.tournament-admin-actions {
  position: absolute;
  top: 0;
  right: 0;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.5rem;
  max-width: 260px;
}

@media (max-width: 700px) {
  .tournament-admin-actions {
    position: static;
    justify-content: center;
    max-width: none;
    margin-top: 1rem;
  }
}

.status-pill {
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  border-radius: 999px;
  padding: 0.3rem 0.7rem;
}

.status-pill.finished {
  color: #999;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.12);
}

.status-pill.locked {
  color: #6be0a3;
  background: rgba(107, 224, 163, 0.1);
  border: 1px solid rgba(107, 224, 163, 0.3);
}

.status-pill.not-started {
  color: #e0b355;
  background: rgba(224, 179, 85, 0.1);
  border: 1px solid rgba(224, 179, 85, 0.3);
}

.admin-action-btn {
  flex-shrink: 0;
  border-radius: 6px;
  padding: 0.5rem 0.9rem;
  font-size: 0.8rem;
  font-weight: 700;
  cursor: pointer;
  transition: opacity 0.15s ease;
  border: 1px solid transparent;
}

.admin-action-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.admin-action-btn:not(:disabled):hover {
  opacity: 0.85;
}

.finish-btn {
  background: #d9534f;
  color: #fff;
}

.start-btn {
  background: hsl(var(--primary-color));
  color: #0f0f0f;
}

.reopen-btn {
  background: transparent;
  border-color: rgba(255, 255, 255, 0.15);
  color: #d8d8d8;
}

.ratings-btn {
  background: hsl(var(--primary-color));
  color: #0f0f0f;
}

.revert-btn {
  background: transparent;
  border-color: #d9534f;
  color: #ff8585;
}

.draw-btn {
  background: transparent;
  border-color: rgba(255, 255, 255, 0.15);
  color: #b8b8b8;
}

.admin-error {
  margin-top: 0.75rem;
}

.tabs {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 2rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  padding-bottom: 1rem;
}

.tabs button {
  background: transparent;
  border: none;
  color: #a8a8a8;
  font-weight: 600;
  padding: 0.6rem 1.2rem;
  cursor: pointer;
  transition: all 0.2s ease;
  position: relative;
}

.tabs button:hover {
  color: #e8e8e8;
}

.tabs button.active {
  color: hsl(var(--primary-color));
}

.tabs button.active::after {
  content: "";
  position: absolute;
  bottom: -1rem;
  left: 0;
  right: 0;
  height: 2px;
  background: hsl(var(--primary-color));
}

.tab-content {
  animation: fadeIn 0.2s ease;
}

.tab-content h2 {
  margin-bottom: 1.5rem;
  font-size: 1.5rem;
}

@keyframes fadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

/* Group Stage Styles */
.groups-container {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 1rem;
  align-items: start;
}

.group-card {
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  overflow: hidden;
}

.group-header {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  background: transparent;
  border: none;
  padding: 1rem 1.2rem;
  cursor: pointer;
  text-align: left;
  color: inherit;
  font: inherit;
}

.group-header:hover {
  background: rgba(255, 255, 255, 0.03);
}

.group-header-left {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
  min-width: 0;
}

.chevron {
  display: inline-block;
  color: hsl(var(--primary-color));
  font-size: 0.85rem;
  transition: transform 0.15s ease;
  flex-shrink: 0;
}

.chevron.expanded {
  transform: rotate(90deg);
}

.group-title {
  color: hsl(var(--primary-color));
  font-size: 1.1rem;
  font-weight: 700;
  white-space: nowrap;
}

.group-subtitle {
  color: #888;
  font-size: 0.8rem;
  white-space: nowrap;
}

.progress-badge {
  flex-shrink: 0;
  font-size: 0.75rem;
  font-weight: 600;
  color: #b8b8b8;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 999px;
  padding: 0.25rem 0.65rem;
  white-space: nowrap;
}

.progress-badge.complete {
  color: #6be0a3;
  background: rgba(107, 224, 163, 0.1);
  border-color: rgba(107, 224, 163, 0.3);
}

.group-body {
  padding: 0 1.2rem 1.2rem;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

.group-players {
  list-style: none;
  padding: 0;
  margin: 1rem 0;
}

.group-players li {
  display: flex;
  justify-content: space-between;
  padding: 0.5rem 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  font-size: 0.9rem;
}

.group-players li:last-child {
  border-bottom: none;
}

.player-name {
  color: #e8e8e8;
  flex: 1;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.advanced-badge {
  flex-shrink: 0;
  font-size: 0.65rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  color: #6be0a3;
  background: rgba(107, 224, 163, 0.12);
  border: 1px solid rgba(107, 224, 163, 0.3);
  border-radius: 999px;
  padding: 0.1rem 0.5rem;
}

.standing {
  color: #777;
  font-size: 0.8rem;
  font-variant-numeric: tabular-nums;
  margin-left: 0.5rem;
  flex-shrink: 0;
}

.rating {
  color: #999;
  margin-left: 0.5rem;
  font-weight: 600;
}

.group-matches h4 {
  margin: 1.2rem 0 0.6rem;
  font-size: 0.8rem;
  color: #888;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.match-row {
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
  margin-bottom: 0.6rem;
  overflow: hidden;
}

.match-row:last-child {
  margin-bottom: 0;
}

/* Completed match: compact readout */
.match-result {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.7rem 0.9rem;
  background: rgba(255, 255, 255, 0.015);
}

.result-players {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  font-size: 0.85rem;
  color: #ccc;
  flex-wrap: wrap;
}

.result-name {
  white-space: nowrap;
}

.result-name.winner {
  color: #f4f7fb;
  font-weight: 700;
}

.result-score {
  color: hsl(var(--primary-color));
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.edit-btn {
  flex-shrink: 0;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #b8b8b8;
  border-radius: 6px;
  padding: 0.3rem 0.7rem;
  font-size: 0.75rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}

.edit-btn:hover {
  color: #e8e8e8;
  border-color: rgba(255, 255, 255, 0.25);
}

/* Entry / edit form */
.match-form {
  padding: 0.8rem 0.9rem;
  background: rgba(255, 255, 255, 0.015);
}

/* Read-only placeholder shown to spectators before a result exists */
.match-pending {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.7rem 0.9rem;
  background: rgba(255, 255, 255, 0.015);
}

.pending-players {
  color: #999;
  font-size: 0.85rem;
}

.pending-label {
  flex-shrink: 0;
  font-size: 0.7rem;
  font-weight: 600;
  color: #777;
  text-transform: uppercase;
  letter-spacing: 0.4px;
}

.score-player {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.3rem 0;
}

.score-player-name {
  color: #d8d8d8;
  font-size: 0.85rem;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.score-player input {
  width: 3.5rem;
  flex-shrink: 0;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  color: #f4f7fb;
  padding: 0.3rem 0.4rem;
  text-align: center;
  font-size: 0.9rem;
}

.score-player input:focus {
  outline: none;
  border-color: hsl(var(--primary-color));
}

.match-form-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.6rem;
}

.submit-btn {
  flex: 1;
  background: hsl(var(--primary-color));
  border: none;
  color: #0f0f0f;
  font-weight: 700;
  font-size: 0.8rem;
  border-radius: 6px;
  padding: 0.5rem 0.8rem;
  cursor: pointer;
  transition: opacity 0.15s ease;
}

.submit-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.submit-btn:not(:disabled):hover {
  opacity: 0.9;
}

.cancel-btn {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #b8b8b8;
  font-size: 0.8rem;
  font-weight: 600;
  border-radius: 6px;
  padding: 0.5rem 0.8rem;
  cursor: pointer;
}

.cancel-btn:hover {
  color: #e8e8e8;
  border-color: rgba(255, 255, 255, 0.25);
}

.match-error {
  color: #ff8585;
  margin-top: 1rem;
  font-size: 0.9rem;
}

/* Participants Tab */
.participants-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-bottom: 1.2rem;
}

.participants-count {
  color: #b8b8b8;
  font-size: 0.9rem;
  margin: 0;
}

.participants-hint {
  color: #888;
  font-size: 0.85rem;
  margin: 0;
}

.join-btn,
.leave-btn {
  flex-shrink: 0;
  border-radius: 6px;
  padding: 0.55rem 1.1rem;
  font-size: 0.85rem;
  font-weight: 700;
  cursor: pointer;
  transition: opacity 0.15s ease;
}

.join-btn {
  background: hsl(var(--primary-color));
  border: none;
  color: #0f0f0f;
}

.join-btn:disabled,
.leave-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.join-btn:not(:disabled):hover,
.leave-btn:not(:disabled):hover {
  opacity: 0.85;
}

.leave-btn {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: #d8d8d8;
}

.participants-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  max-width: 480px;
}

.participant-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.6rem 0.9rem;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
}

.participant-row.is-you {
  border-color: hsl(var(--primary-color));
  background: rgba(255, 255, 255, 0.04);
}

.participant-avatar {
  width: 2rem;
  height: 2rem;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}

.participant-avatar-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.08);
  color: #d8d8d8;
  font-weight: 700;
  font-size: 0.85rem;
}

.participant-name {
  color: #e8e8e8;
  font-size: 0.9rem;
  flex: 1;
}

.you-badge {
  flex-shrink: 0;
  font-size: 0.7rem;
  font-weight: 700;
  color: hsl(var(--primary-color));
  border: 1px solid hsl(var(--primary-color));
  border-radius: 999px;
  padding: 0.15rem 0.5rem;
}

.remove-participant-btn {
  flex-shrink: 0;
  background: transparent;
  border: 1px solid rgba(240, 131, 131, 0.4);
  color: #f08383;
  border-radius: 999px;
  padding: 0.2rem 0.65rem;
  font-size: 0.7rem;
  font-weight: 700;
  cursor: pointer;
  transition: all 0.15s ease;
}

.remove-participant-btn:not(:disabled):hover {
  background: rgba(240, 131, 131, 0.1);
  border-color: #f08383;
}

.remove-participant-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.participants-empty {
  color: #888;
  font-size: 0.9rem;
}

/* Doubles: partner up */
.team-up-card {
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  padding: 1.2rem;
  margin-bottom: 1.2rem;
  max-width: 480px;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.team-status {
  color: #d8d8d8;
  font-size: 0.9rem;
  margin: 0;
}

.team-status strong {
  color: #f4f7fb;
}

.incoming-invites {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.invite-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  padding: 0.6rem 0.8rem;
}

.invite-row span {
  color: #d8d8d8;
  font-size: 0.85rem;
}

.invite-row strong {
  color: #f4f7fb;
}

.invite-actions {
  display: flex;
  gap: 0.5rem;
  flex-shrink: 0;
}

.partner-picker {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.partner-picker select {
  flex: 1;
  min-width: 180px;
  background: #0d0e10;
  color: #f0f0f1;
  border: 1px solid #2f3136;
  border-radius: 7px;
  padding: 0.5rem 0.7rem;
  font-size: 0.9rem;
}

/* Bracket lock state, shown until 6 PM on the tournament date */
.bracket-locked,
.not-started {
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  padding: 2rem 1.5rem;
  text-align: center;
  max-width: 480px;
}

.bracket-locked h3,
.not-started h3 {
  color: #e8e8e8;
  font-size: 1.1rem;
  margin: 0 0 0.5rem;
}

.bracket-locked p,
.not-started p {
  color: #999;
  font-size: 0.9rem;
  margin: 0;
}

/* Elimination Bracket Styles */
.bracket-container {
  display: flex;
  gap: 2rem;
  overflow-x: auto;
  padding: 1rem 0;
}

.bracket-round {
  flex-shrink: 0;
  min-width: 260px;
}

.bracket-round h3 {
  font-size: 0.9rem;
  color: #999;
  margin-bottom: 1rem;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.matches {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

/* Reuses .match-row / .match-result / .match-form from the group stage;
   these add bracket-specific spacing on top of those shared styles. */
.bracket-match-row {
  background: rgba(255, 255, 255, 0.02);
  min-height: 70px;
}

.bracket-match-row .match-result,
.bracket-match-row .match-form {
  background: transparent;
}

.bracket-match-result {
  flex-wrap: wrap;
}

/* TBD placeholder matchup (no players assigned yet) */
.matchup {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.75rem 0.9rem;
}

.player {
  padding: 0.3rem 0;
  color: #d8d8d8;
  font-size: 0.85rem;
  word-break: break-word;
}

.player:first-child {
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  padding-bottom: 0.3rem;
}

.vs {
  text-align: center;
  color: #666;
  font-size: 0.7rem;
  padding: 0.2rem 0;
}
</style>
