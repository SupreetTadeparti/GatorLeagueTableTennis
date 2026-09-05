<script setup>
import { ref, computed, onMounted, onUnmounted } from "vue";
import { auth, db } from "../firebase";
import { isUserAdminByEmail } from "../firebaseHelpers";
import {
  collection,
  query,
  where,
  getDocs,
  doc,
  setDoc,
  deleteDoc,
  serverTimestamp,
} from "firebase/firestore";

const tournament = ref(null);
const loading = ref(false);
const activeTab = ref("groups");
// Players who are registered for this tournament (used for groups/bracket).
const players = ref([]);
// Every player in the system, used to resolve the logged-in user's own
// profile even before they've joined the tournament.
const allPlayers = ref([]);

// Tournament structure
const groups = ref([]);
const bracket = ref([]);
const scores = ref({});
const savingMatch = ref(null);
const savedMatches = ref({});
const matchError = ref("");

// Group-stage UI state
const expandedGroups = ref({});
const editingMatch = ref({});

// Participants
const participants = ref([]);
const joiningTournament = ref(false);
const leavingTournament = ref(false);
const participantError = ref("");

// Bracket reveal timing
const now = ref(new Date());
let nowIntervalId = null;

// Permissions
const isAdmin = ref(false);
const currentUser = computed(() => auth.currentUser);

function isMatchPlayer(match) {
  const uid = currentUser.value?.uid;
  if (!uid) return false;
  return [match.player1, match.player2].some(
    (player) => player?.id === uid || player?.authUid === uid,
  );
}

function canEditMatch(match) {
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

// Accepts a Firestore Timestamp, JS Date, epoch number, or date string.
function toJsDate(value) {
  if (!value) return null;
  if (typeof value?.toDate === "function") return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value);
  if (typeof value === "string") return new Date(value);
  return null;
}

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

// Group play and the bracket only make sense once someone has actually
// joined. Until then, show a "hasn't started" message instead of empty
// groups/matches.
const hasParticipants = computed(() => participants.value.length > 0);

// Tournament start + finish + rating update state
const startingTournament = ref(false);
const finishingTournament = ref(false);
const updatingRatings = ref(false);
const revertingRatings = ref(false);
const ratingsError = ref("");

// "Started" locks the participant list (no more joining/leaving).
// "Finished" locks match editing to admins only. These are independent
// so an admin can lock registration while matches are still being
// played, without having to also stop editing results.
const isTournamentStarted = computed(() => !!tournament.value?.startedAt);
const isTournamentFinished = computed(() => !!tournament.value?.finishedAt);
const ratingsApplied = computed(() => !!tournament.value?.ratingsAppliedAt);

// --- Rating math (as provided) ---
const inverseLogCurve = (x, a, b) => {
  return 1 / Math.log10(Math.pow(10, 1 / a) + x * b);
};

const updateRating = (initialRating, opponentRating, won) => {
  let newRating = initialRating;

  let ratingDiff = opponentRating - initialRating;
  let handicapDiff = ratingDiff / 100;

  // Cap the handicap difference to a maximum of 8
  if (handicapDiff > 8) handicapDiff = 8;
  else if (handicapDiff < -8) handicapDiff = -8;

  // Calculate ERC and URC based on handicap difference
  let ercDepConst = 0.05; // Suggested constant for ERC calculation
  let upsetDepConst = 1.1 * 0.01; // Suggested constant for URC calculation
  let initialErc = 9.0; // Suggested initial ERC value

  let erc = inverseLogCurve(Math.abs(handicapDiff), initialErc, ercDepConst);
  let upsetProbability =
    inverseLogCurve(Math.abs(handicapDiff), 50.0, upsetDepConst) / 100.0;

  let urc = Math.round((erc * (1 - upsetProbability)) / upsetProbability);

  // Adjust rating based on match outcome
  if (won) {
    if (handicapDiff > 0) {
      // Player beat higher rated player
      newRating += urc;
    } // Player beat lower rated player
    else {
      newRating += erc;
    }
  } else {
    if (handicapDiff > 0) {
      // Player lost to higher rated player
      newRating -= erc;
    } // Player lost to lower rated player
    else {
      newRating -= urc;
    }
  }

  return Math.round(newRating);
};

// Computes each player's NET rating delta across every submitted match in
// the tournament. Every match is evaluated against each player's frozen
// pre-tournament rating (initialRatingsById), never against a
// running/updated rating, so results don't depend on match order and
// don't accumulate match-over-match.
function computeTournamentRatingDeltas(matches, initialRatingsById) {
  const deltas = {};
  matches.forEach((match) => {
    const { player1Id, player2Id, winnerPlayerId } = match;
    if (!player1Id || !player2Id) return;

    const r1 = initialRatingsById[player1Id];
    const r2 = initialRatingsById[player2Id];
    if (typeof r1 !== "number" || typeof r2 !== "number") return;

    const player1Won = winnerPlayerId === player1Id;
    const player1New = updateRating(r1, r2, player1Won);
    const player2New = updateRating(r2, r1, !player1Won);

    deltas[player1Id] = (deltas[player1Id] || 0) + (player1New - r1);
    deltas[player2Id] = (deltas[player2Id] || 0) + (player2New - r2);
  });
  return deltas;
}

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
    // Query for active tournament (where status === "active" or similar)
    const q = query(
      collection(db, "tournaments"),
      where("status", "==", "active"),
    );
    const snaps = await getDocs(q);
    if (snaps.docs.length > 0) {
      const t = snaps.docs[0];
      tournament.value = { id: t.id, ...t.data() };
      await loadParticipants(tournament.value.id);
      await loadTournamentPlayers(tournament.value.id);
      generateGroups();
      await loadTournamentMatches(tournament.value.id);
      generateBracket();
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
    snaps.docs.forEach((d) => {
      const data = d.data();
      if (
        typeof data.player1Score === "number" &&
        typeof data.player2Score === "number"
      ) {
        scores.value[d.id] = { 1: data.player1Score, 2: data.player2Score };
        savedMatches.value[d.id] = true;
      }
    });
  } catch (e) {
    console.error("loadTournamentMatches", e);
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
  if (isTournamentStarted.value) {
    participantError.value =
      "Registration is closed — the tournament has started.";
    return;
  }
  if (!currentPlayer.value) {
    participantError.value =
      "We couldn't find a player profile for your account.";
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
        playerPhotoUrl: currentPlayer.value.photoUrl || null,
        teamId: null,
        // Frozen at join time so rating math always uses the rating the
        // player had before this tournament, regardless of when ratings
        // are actually applied.
        initialRating:
          typeof currentPlayer.value.currentRating === "number"
            ? currentPlayer.value.currentRating
            : null,
      },
    );
    await loadParticipants(tournament.value.id);
    refreshRegisteredPlayers();
    generateGroups();
    generateBracket();
  } catch (e) {
    participantError.value = e.message || "Unable to join the tournament.";
  } finally {
    joiningTournament.value = false;
  }
}

async function leaveTournament() {
  if (!tournament.value || !currentPlayer.value) return;
  if (isTournamentStarted.value) {
    participantError.value =
      "Registration is closed — the tournament has started.";
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
    generateGroups();
    generateBracket();
  } catch (e) {
    participantError.value = e.message || "Unable to leave the tournament.";
  } finally {
    leavingTournament.value = false;
  }
}

function generateGroups() {
  const groupSize = 4;
  const numGroups = Math.ceil(players.value.length / groupSize);

  if (numGroups === 0) {
    groups.value = [];
    return;
  }

  // Snake-seed by rating: sort strongest to weakest, then deal players
  // into groups in a serpentine pattern (A,B,C,D, D,C,B,A, A,B,C,D, ...)
  // so the strongest players are spread evenly across groups instead of
  // all landing in group A.
  const seeded = [...players.value].sort(
    (a, b) => (b.currentRating || 0) - (a.currentRating || 0),
  );

  const groupsArray = Array.from({ length: numGroups }, (_, i) => ({
    id: String.fromCharCode(65 + i), // A, B, C, ...
    players: [],
  }));

  let groupIndex = 0;
  let direction = 1;
  seeded.forEach((player) => {
    groupsArray[groupIndex].players.push(player);
    groupIndex += direction;
    if (groupIndex === numGroups) {
      groupIndex = numGroups - 1;
      direction = -1;
    } else if (groupIndex === -1) {
      groupIndex = 0;
      direction = 1;
    }
  });

  groupsArray.forEach((g) => {
    g.matches = createGroupMatches(g.players, g.id);
  });

  groups.value = groupsArray;

  // Default the first group open, leave the rest collapsed. Preserve any
  // expanded/collapsed state a user already toggled if this runs again.
  groupsArray.forEach((g, idx) => {
    if (!(g.id in expandedGroups.value)) {
      expandedGroups.value[g.id] = idx === 0;
    }
  });
}

// True once every match in every group has a submitted result. The
// bracket can't be meaningfully seeded before this, since it depends on
// final group standings.
const groupStageComplete = computed(() => {
  if (groups.value.length === 0) return false;
  return groups.value.every((g) => {
    const { completed, total } = groupProgress(g);
    return total > 0 && completed === total;
  });
});

// Ranks a group's players by submitted match results: wins first, then
// point differential, then rating as a final tiebreaker.
function groupStandings(group) {
  const tally = {};
  group.players.forEach((p) => {
    tally[p.id] = {
      player: p,
      wins: 0,
      losses: 0,
      pointsFor: 0,
      pointsAgainst: 0,
    };
  });

  group.matches.forEach((match) => {
    if (!savedMatches.value[match.id]) return;
    const s1 = Number(matchScore(match.id, 1));
    const s2 = Number(matchScore(match.id, 2));
    const t1 = tally[match.player1.id];
    const t2 = tally[match.player2.id];
    if (!t1 || !t2) return;

    t1.pointsFor += s1;
    t1.pointsAgainst += s2;
    t2.pointsFor += s2;
    t2.pointsAgainst += s1;

    if (s1 > s2) {
      t1.wins += 1;
      t2.losses += 1;
    } else {
      t2.wins += 1;
      t1.losses += 1;
    }
  });

  return Object.values(tally).sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    const diffA = a.pointsFor - a.pointsAgainst;
    const diffB = b.pointsFor - b.pointsAgainst;
    if (diffB !== diffA) return diffB - diffA;
    return (b.player.currentRating || 0) - (a.player.currentRating || 0);
  });
}

// Standard single-elimination seeding order (e.g. for 8 slots:
// 1,8,4,5,2,7,3,6) so seed 1 and seed 2 can only meet in the final,
// seeds 1-4 can't meet before the semis, etc.
function standardSeedOrder(size) {
  let seeds = [1];
  while (seeds.length < size) {
    const roundSize = seeds.length * 2;
    const next = [];
    seeds.forEach((s) => {
      next.push(s);
      next.push(roundSize + 1 - s);
    });
    seeds = next;
  }
  return seeds;
}

// Builds the round-1 bracket slots from each group's top 2 finishers:
// group winners seeded 1..N (strongest first), then runners-up seeded
// N+1..2N, placed into a standard-seeded bracket (padded with byes to
// the next power of two if needed). Includes a best-effort pass to avoid
// pairing two players from the same group in round 1.
function qualifiedBracketSlots() {
  const winners = [];
  const runnersUp = [];

  groups.value.forEach((group) => {
    const standings = groupStandings(group);
    if (standings[0]) {
      winners.push({ ...standings[0].player, __groupId: group.id });
    }
    if (standings[1]) {
      runnersUp.push({ ...standings[1].player, __groupId: group.id });
    }
  });

  const byStrength = (a, b) => (b.currentRating || 0) - (a.currentRating || 0);
  winners.sort(byStrength);
  runnersUp.sort(byStrength);

  const overallSeeds = [...winners, ...runnersUp];
  if (overallSeeds.length === 0) return [];

  let bracketSize = 1;
  while (bracketSize < overallSeeds.length) bracketSize *= 2;

  const order = standardSeedOrder(bracketSize);
  const slots = new Array(bracketSize).fill(null);
  overallSeeds.forEach((player, idx) => {
    const seedNumber = idx + 1;
    slots[order.indexOf(seedNumber)] = player;
  });

  // Best-effort same-group avoidance for round 1 pairings.
  for (let i = 0; i < slots.length; i += 2) {
    const a = slots[i];
    const b = slots[i + 1];
    if (a && b && a.__groupId === b.__groupId) {
      for (let j = i + 2; j < slots.length; j += 2) {
        const c = slots[j];
        if (c && c.__groupId !== a.__groupId) {
          slots[i + 1] = c;
          slots[j] = b;
          break;
        }
      }
    }
  }

  return slots;
}

function generateBracket() {
  if (!groupStageComplete.value) {
    bracket.value = [];
    return;
  }
  const slots = qualifiedBracketSlots();
  bracket.value = slots.length > 0 ? generateBracketRounds(slots) : [];
}

function generateBracketRounds(playersList) {
  // Generate rounds for single-elimination bracket
  const rounds = [];
  let currentRound = [];

  // Initialize with players
  for (let i = 0; i < playersList.length; i += 2) {
    currentRound.push({
      match: Math.floor(i / 2),
      matchNumber: Math.floor(i / 2) + 1,
      id: `bracket-r0-m${Math.floor(i / 2)}`,
      stage: "bracket",
      round: `Round of ${playersList.length}`,
      player1: playersList[i] || null,
      player2: playersList[i + 1] || null,
      winner: null,
    });
  }
  rounds.push({
    name: `Round of ${playersList.length}`,
    matches: currentRound,
  });

  // Generate subsequent rounds
  while (currentRound.length > 1) {
    const nextRound = [];
    for (let i = 0; i < currentRound.length; i += 2) {
      nextRound.push({
        match: Math.floor(i / 2),
        matchNumber: Math.floor(i / 2) + 1,
        id: `bracket-r${rounds.length}-m${Math.floor(i / 2)}`,
        stage: "bracket",
        round:
          nextRound.length === 0
            ? "Finals"
            : `Round of ${nextRound.length * 2}`,
        player1: null,
        player2: null,
        winner: null,
      });
    }
    rounds.push({
      name:
        nextRound.length === 1 ? "Finals" : `Round of ${nextRound.length * 2}`,
      matches: nextRound,
    });
    currentRound = nextRound;
  }

  return rounds;
}

function createGroupMatches(groupPlayers, groupId) {
  const matches = [];
  for (let first = 0; first < groupPlayers.length; first += 1) {
    for (let second = first + 1; second < groupPlayers.length; second += 1) {
      const matchNumber = matches.length + 1;
      matches.push({
        id: `group-${groupId}-m${matchNumber}`,
        stage: "group",
        groupId,
        matchNumber,
        player1: groupPlayers[first],
        player2: groupPlayers[second],
      });
    }
  }
  return matches;
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
  expandedGroups.value[groupId] = !expandedGroups.value[groupId];
}

function isGroupExpanded(groupId) {
  return !!expandedGroups.value[groupId];
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
  try {
    await setDoc(
      doc(db, "tournaments", tournament.value.id, "matches", match.id),
      {
        stage: match.stage || "bracket",
        groupId: match.groupId || null,
        round: match.round || null,
        matchNumber: match.matchNumber ?? null,
        player1Id: match.player1.id,
        player2Id: match.player2.id,
        player1Score,
        player2Score,
        winnerPlayerId: winner.id,
        loserPlayerId: loser.id,
        status: "submitted",
        submittedBy: auth.currentUser?.uid || null,
        isVerified: false,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
    savedMatches.value[match.id] = true;
    editingMatch.value[match.id] = false;
    // A group-stage result can complete the group stage (or change a
    // group's standings before it's complete); re-derive the bracket so
    // it reflects the latest qualifiers.
    generateBracket();
  } catch (error) {
    matchError.value = error.message || "Unable to save this result.";
  } finally {
    savingMatch.value = null;
  }
}

const isActive = computed(() => tournament.value !== null);

// --- Admin: start / reopen registration ---
async function startTournament() {
  if (!tournament.value || !isAdmin.value) return;
  if (participants.value.length === 0) {
    ratingsError.value =
      "Add at least one participant before starting the tournament.";
    return;
  }
  const confirmed = window.confirm(
    "Start this tournament? Participants won't be able to join or leave anymore.",
  );
  if (!confirmed) return;

  startingTournament.value = true;
  ratingsError.value = "";
  try {
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
    "Reopen registration? Participants will be able to join or leave again.",
  );
  if (!confirmed) return;

  startingTournament.value = true;
  ratingsError.value = "";
  try {
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

// --- Admin: finish / reopen the tournament ---
async function finishTournament() {
  if (!tournament.value || !isAdmin.value) return;
  const confirmed = window.confirm(
    "Finish this tournament? Players won't be able to submit or edit match results anymore. You can still edit results as an admin.",
  );
  if (!confirmed) return;

  finishingTournament.value = true;
  ratingsError.value = "";
  try {
    await setDoc(
      doc(db, "tournaments", tournament.value.id),
      { finishedAt: serverTimestamp() },
      { merge: true },
    );
    tournament.value = { ...tournament.value, finishedAt: new Date() };
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
      { finishedAt: null },
      { merge: true },
    );
    tournament.value = { ...tournament.value, finishedAt: null };
  } catch (e) {
    ratingsError.value = e.message || "Unable to reopen the tournament.";
  } finally {
    finishingTournament.value = false;
  }
}

// --- Admin: apply / revert rating changes ---
async function updatePlayerRatings() {
  if (!tournament.value || !isAdmin.value) return;
  const confirmed = window.confirm(
    "Apply rating changes for every submitted match in this tournament? This updates each participant's rating.",
  );
  if (!confirmed) return;

  updatingRatings.value = true;
  ratingsError.value = "";
  try {
    const initialRatingsById = {};
    participants.value.forEach((p) => {
      if (typeof p.initialRating === "number") {
        initialRatingsById[p.id] = p.initialRating;
      }
    });

    const matchSnaps = await getDocs(
      collection(db, "tournaments", tournament.value.id, "matches"),
    );
    const matches = matchSnaps.docs
      .map((d) => d.data())
      .filter((m) => m.status === "submitted");

    const deltas = computeTournamentRatingDeltas(matches, initialRatingsById);
    const playerIds = Object.keys(deltas);

    if (playerIds.length === 0) {
      ratingsError.value =
        "No submitted matches with rating data were found.";
      return;
    }

    for (const playerId of playerIds) {
      const previousRating = initialRatingsById[playerId];
      const newRating = Math.round(previousRating + deltas[playerId]);

      await setDoc(
        doc(db, "players", playerId),
        { currentRating: newRating },
        { merge: true },
      );

      // Record exactly what changed so this can be reverted later.
      await setDoc(
        doc(
          db,
          "tournaments",
          tournament.value.id,
          "ratingChanges",
          playerId,
        ),
        {
          playerId,
          previousRating,
          newRating,
          delta: newRating - previousRating,
          appliedAt: serverTimestamp(),
        },
      );
    }

    await setDoc(
      doc(db, "tournaments", tournament.value.id),
      { ratingsAppliedAt: serverTimestamp() },
      { merge: true },
    );
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
  const confirmed = window.confirm(
    "Revert the rating changes from this tournament? Every affected player's rating will be restored to what it was before this tournament. Only do this if no later tournament has already used these ratings.",
  );
  if (!confirmed) return;

  revertingRatings.value = true;
  ratingsError.value = "";
  try {
    const snaps = await getDocs(
      collection(db, "tournaments", tournament.value.id, "ratingChanges"),
    );

    for (const d of snaps.docs) {
      const { playerId, previousRating } = d.data();
      if (!playerId || typeof previousRating !== "number") continue;
      await setDoc(
        doc(db, "players", playerId),
        { currentRating: previousRating },
        { merge: true },
      );
      await deleteDoc(d.ref);
    }

    await setDoc(
      doc(db, "tournaments", tournament.value.id),
      { ratingsAppliedAt: null },
      { merge: true },
    );
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
        <p class="player-count">{{ players.length }} Players</p>

        <div v-if="isAdmin" class="tournament-admin-actions">
          <span v-if="isTournamentFinished" class="status-pill finished"
            >Finished</span
          >
          <span
            v-else-if="isTournamentStarted"
            class="status-pill started"
            >In Progress</span
          >

          <button
            v-if="!isTournamentStarted"
            type="button"
            class="admin-action-btn start-btn"
            :disabled="startingTournament"
            @click="startTournament"
          >
            {{ startingTournament ? "Starting..." : "Start Tournament" }}
          </button>
          <button
            v-else-if="!isTournamentFinished"
            type="button"
            class="admin-action-btn reopen-btn"
            :disabled="startingTournament"
            @click="reopenRegistration"
          >
            {{
              startingTournament ? "Reopening..." : "Reopen Registration"
            }}
          </button>

          <button
            v-if="!isTournamentFinished"
            type="button"
            class="admin-action-btn finish-btn"
            :disabled="finishingTournament"
            @click="finishTournament"
          >
            {{ finishingTournament ? "Finishing..." : "Finish Tournament" }}
          </button>
          <button
            v-else
            type="button"
            class="admin-action-btn reopen-btn"
            :disabled="finishingTournament"
            @click="reopenTournament"
          >
            {{ finishingTournament ? "Reopening..." : "Reopen Tournament" }}
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
        </div>

        <p v-if="ratingsError" class="match-error admin-error">
          {{ ratingsError }}
        </p>
      </div>

      <!-- Tabs -->
      <div class="tabs">
        <button
          :class="{ active: activeTab === 'groups' }"
          @click="activeTab = 'groups'"
        >
          Group Stage
        </button>
        <button
          :class="{ active: activeTab === 'participants' }"
          @click="activeTab = 'participants'"
        >
          Participants
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

        <div v-if="!hasParticipants" class="not-started">
          <h3>Tournament hasn't started</h3>
          <p>
            Group play will appear here once players have joined. Head to
            the Participants tab to sign up.
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
                  <span class="player-name">{{ player.fullName }}</span>
                  <span class="rating">{{
                    Math.round(player.currentRating)
                  }}</span>
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
                  <div
                    v-else-if="canEditMatch(match)"
                    class="match-form"
                  >
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
                    <span class="pending-label">{{ pendingResultLabel() }}</span>
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
          <p class="participants-count">
            {{ participants.length }}
            {{ participants.length === 1 ? "player" : "players" }} joined
          </p>

          <button
            v-if="currentPlayer && !isParticipant && !isTournamentStarted"
            type="button"
            class="join-btn"
            :disabled="joiningTournament"
            @click="joinTournament"
          >
            {{ joiningTournament ? "Joining..." : "Join Tournament" }}
          </button>

          <button
            v-else-if="currentPlayer && isParticipant && !isTournamentStarted"
            type="button"
            class="leave-btn"
            :disabled="leavingTournament"
            @click="leaveTournament"
          >
            {{ leavingTournament ? "Leaving..." : "Leave Tournament" }}
          </button>

          <p
            v-else-if="currentPlayer && isTournamentStarted"
            class="participants-hint"
          >
            Registration is closed — the tournament has started.
          </p>

          <p v-else class="participants-hint">
            Sign in with a player profile to join this tournament.
          </p>
        </div>

        <p v-if="participantError" class="match-error">
          {{ participantError }}
        </p>

        <ul v-if="participants.length > 0" class="participants-list">
          <li
            v-for="participant in participants"
            :key="participant.id"
            class="participant-row"
            :class="{
              'is-you': currentPlayer && participant.id === currentPlayer.id,
            }"
          >
            <img
              v-if="participant.playerPhotoUrl"
              :src="participant.playerPhotoUrl"
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
          </li>
        </ul>

        <p v-else class="participants-empty">
          No one has joined yet. Be the first!
        </p>
      </div>

      <!-- Elimination Bracket Tab -->
      <div v-if="activeTab === 'bracket'" class="tab-content">
        <h2>Elimination Bracket</h2>

        <div v-if="!hasParticipants" class="not-started">
          <h3>Tournament hasn't started</h3>
          <p>
            The bracket will appear here once players have joined. Head to
            the Participants tab to sign up.
          </p>
        </div>

        <div v-else-if="!groupStageComplete" class="bracket-locked">
          <h3>Group stage still in progress</h3>
          <p>
            The bracket is seeded from each group's top 2 finishers once
            every group match has been reported.
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
          <div v-for="(round, idx) in bracket" :key="idx" class="bracket-round">
            <h3>{{ round.name }}</h3>
            <div class="matches">
              <template v-for="m in round.matches" :key="m.match">
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
                  <span class="pending-label">{{ pendingResultLabel() }}</span>
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
  max-width: 320px;
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

.status-pill.started {
  color: #6be0a3;
  background: rgba(107, 224, 163, 0.1);
  border: 1px solid rgba(107, 224, 163, 0.3);
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

.start-btn {
  background: hsl(var(--primary-color));
  color: #0f0f0f;
}

.finish-btn {
  background: #d9534f;
  color: #fff;
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

.participants-empty {
  color: #888;
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

