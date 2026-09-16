// Read-only tournament loading for the Archive page.
//
// This is deliberately separate from TournamentView's live/editable state:
// Archive never joins, submits, or admin-edits anything, so it doesn't
// need that machinery. It reuses the pure draw-building functions from
// tournamentStructure.js so a finished tournament renders identically
// here and on the live page.

import { collection, doc, getDoc, getDocs } from "firebase/firestore";
import { db } from "./firebase";
import {
  buildBracketRounds,
  computeGroupStandings,
  deserializeStructure,
  groupMatchDefs,
  reconcileStructure,
} from "./tournamentStructure";

// All tournaments that have ever finished, newest first. A tournament
// counts as archived once it has a finishedAt — regardless of its status
// field, which may be stale on older records (see TournamentView's
// active-tournament query for the matching self-heal).
export async function fetchArchivedTournaments() {
  const snaps = await getDocs(collection(db, "tournaments"));
  return snaps.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((t) => !!t.finishedAt)
    .sort((a, b) => {
      const at = a.finishedAt?.toMillis?.() ?? 0;
      const bt = b.finishedAt?.toMillis?.() ?? 0;
      return bt - at;
    });
}

// Everything needed to render one archived tournament's groups + bracket,
// read-only: hydrated group rosters/matches, hydrated bracket rounds, and
// the raw match docs (for score lookups).
export async function loadArchivedTournament(tournamentId) {
  const tournamentSnap = await getDoc(doc(db, "tournaments", tournamentId));
  if (!tournamentSnap.exists()) return null;
  const tournament = { id: tournamentId, ...tournamentSnap.data() };
  const isDoubles = tournament.format === "doubles";

  const [participantSnaps, matchSnaps, structureSnap, teamSnaps] =
    await Promise.all([
      getDocs(collection(db, "tournaments", tournamentId, "participants")),
      getDocs(collection(db, "tournaments", tournamentId, "matches")),
      getDoc(doc(db, "tournaments", tournamentId, "structure", "main")),
      isDoubles
        ? getDocs(collection(db, "teams"))
        : Promise.resolve({ docs: [] }),
    ]);

  const participants = participantSnaps.docs.map((d) => ({
    id: d.id,
    ...d.data(),
  }));
  const matchDocs = {};
  matchSnaps.docs.forEach((d) => {
    matchDocs[d.id] = { id: d.id, ...d.data() };
  });
  const lockedStructure = structureSnap.exists()
    ? deserializeStructure(structureSnap.data())
    : null;

  // Build the entity directory: players for singles, teams for doubles.
  // Ratings always come from the participant doc's frozen initialRating —
  // an archive page showing live ratings that have since moved on would
  // misrepresent what the tournament actually looked like.
  const directory = {};
  let entryIds = [];

  if (isDoubles) {
    const teamsById = {};
    teamSnaps.docs.forEach((d) => {
      teamsById[d.id] = { id: d.id, ...d.data() };
    });
    const byTeam = {};
    participants.forEach((p) => {
      if (!p.teamId) return;
      (byTeam[p.teamId] ??= []).push(p);
    });
    Object.entries(byTeam).forEach(([teamId, pair]) => {
      const team = teamsById[teamId];
      directory[teamId] = {
        id: teamId,
        fullName:
          team?.teamName ||
          pair.map((p) => p.playerName || "Unknown").join(" & ") ||
          "Unknown team",
        currentRating:
          typeof pair[0]?.initialRating === "number"
            ? pair[0].initialRating
            : (team?.teamRating ?? null),
      };
    });
    entryIds = Object.keys(byTeam);
  } else {
    participants.forEach((p) => {
      directory[p.id] = {
        id: p.id,
        fullName: p.playerName || "Unknown player",
        currentRating:
          typeof p.initialRating === "number" ? p.initialRating : null,
      };
    });
    entryIds = participants.map((p) => p.id);
  }

  const entryFor = (id) =>
    id
      ? (directory[id] ?? {
          id,
          fullName: isDoubles ? "Unknown team" : "Unknown player",
          currentRating: null,
        })
      : null;

  const hydrate = (matchDef) => ({
    ...matchDef,
    ...matchDocs[matchDef.id],
    id: matchDef.id,
    player1: entryFor(matchDef.player1Id),
    player2: entryFor(matchDef.player2Id),
  });

  // Only exercised for a legacy/edge tournament with no locked structure
  // — the normal case (finishTournament always locks the draw first)
  // never reaches this. Same ratingsById convention as TournamentView.vue:
  // each entity's frozen initialRating, used only to seed the bracket.
  const ratingsById = {};
  participants.forEach((p) => {
    if (typeof p.initialRating !== "number") return;
    const entityId = isDoubles ? p.teamId : p.id;
    if (entityId) ratingsById[entityId] = p.initialRating;
  });

  const structure =
    lockedStructure ??
    reconcileStructure(Object.values(matchDocs), entryIds, ratingsById);

  const seededIds = new Set((structure.bracketSeeds ?? []).filter(Boolean));
  const groups = (structure.groups ?? []).map((groupDef) => {
    const standingsById = {};
    computeGroupStandings(groupDef, Object.values(matchDocs)).forEach((row) => {
      standingsById[row.playerId] = row;
    });
    return {
      id: groupDef.id,
      players: groupDef.playerIds
        .map(entryFor)
        .filter(Boolean)
        .map((p) => ({
          ...p,
          wins: standingsById[p.id]?.wins ?? 0,
          losses: standingsById[p.id]?.losses ?? 0,
          advanced: seededIds.has(p.id),
        })),
      matches: groupMatchDefs(groupDef).map(hydrate),
    };
  });

  const bracket = buildBracketRounds(
    structure.bracketSeeds ?? [],
    (matchId) => matchDocs[matchId]?.winnerPlayerId ?? null,
  ).map((round) => ({
    name: round.name,
    matches: round.matches.map(hydrate),
  }));

  return { tournament, groups, bracket, participantCount: entryIds.length };
}
