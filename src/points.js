// Season points.
//
// Unlike ratings, points only ever accumulate over a season and there's
// no "revert" button — an admin who needs to undo a mistake edits a
// player's totalPoints directly (Player Management already supports
// that). Recomputing a tournament's points is still safe to run more
// than once, though: /tournaments/{tid}/pointsChanges/{entityId} records
// exactly what this tournament last contributed, so recomputing
// subtracts the old contribution before adding the new one instead of
// stacking on top of it.
//
// Firestore shape this module owns:
//   /tournaments/{tid}                       pointsAppliedAt
//   /tournaments/{tid}/pointsChanges/{eid}    pointsAwarded, appliedAt
//   /players/{pid}                            totalPoints
//
// Scoring, in order of how much they're worth:
//   - Just participating earns a little (points for playing at all).
//   - Reaching the elimination bracket (finishing top 2 in your group)
//     earns a flat bonus, regardless of group size. Group-stage wins are
//     NOT counted individually — group sizes vary (a leftover group can
//     have fewer round-robin matches than a full one), so counting wins
//     there would reward players for landing in a bigger group rather
//     than for anything they actually did.
//   - A bracket win earns more the deeper the round — each round is
//     worth double the previous one, so a Finals win dwarfs a first-round
//     bracket win. This is what makes "how far you got" show up in the
//     total: the deeper you go, the faster points pile up.
//
// Doubles: the entity scored is the team (matching src/ratings.js), and
// both players on the team are credited the team's full points — a
// tournament win is a win for both partners, not split between them.
//
// Who "qualified" for the bracket is derived from group standings (see
// src/tournamentStructure.js's `qualifiersFromGroups`), not from ratings —
// qualification only needs win/loss records, so this module never needs
// to build a ratings lookup.

import {
  collection,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import { db } from "./firebase";
import {
  deserializeStructure,
  qualifiersFromGroups,
  reconstructStructureFromMatches,
} from "./tournamentStructure";

export const PARTICIPATION_POINTS = 5;
export const BRACKET_QUALIFIED_POINTS = 8;
export const BRACKET_BASE_WIN_POINTS = 10;

// Round 0 (the first bracket round) wins BRACKET_BASE_WIN_POINTS; each
// round after that doubles it.
export function bracketWinPoints(roundIndex) {
  return BRACKET_BASE_WIN_POINTS * Math.pow(2, Math.max(roundIndex, 0));
}

const BRACKET_MATCH_ID = /^bracket-r(\d+)-m\d+$/;

// Matches recorded before `roundIndex` existed on the doc (or reconciled
// from an old draw) don't have the field, but the match ID itself always
// encodes the round — bracket-r{round}-m{match} — so fall back to that.
function roundIndexOf(match) {
  if (typeof match.roundIndex === "number") return match.roundIndex;
  const parsed = BRACKET_MATCH_ID.exec(match.id || "");
  return parsed ? Number(parsed[1]) : 0;
}

// Points earned by one entity (player or team ID): a flat participation
// bonus for being in the tournament at all, plus a flat bonus if they
// reached the bracket (qualifiedEntityIds — see qualifiersFromGroups),
// plus escalating credit for every bracket round actually won. No
// group-stage win, by itself, ever contributes anything.
export function computeEntityPoints(entityId, matches, qualifiedEntityIds) {
  let points = PARTICIPATION_POINTS;
  if (qualifiedEntityIds.has(entityId)) points += BRACKET_QUALIFIED_POINTS;
  for (const match of matches) {
    if (match.stage === "group") continue;
    if (match.winnerPlayerId !== entityId) continue;
    points += bracketWinPoints(roundIndexOf(match));
  }
  return points;
}

export function computeTournamentPoints(
  entityIds,
  matches,
  qualifiedEntityIds,
) {
  const points = {};
  entityIds.forEach((id) => {
    points[id] = computeEntityPoints(id, matches, qualifiedEntityIds);
  });
  return points;
}

// Applies (or re-applies) this tournament's points to every participating
// player's totalPoints. Doesn't depend on other tournaments' state at
// all — no ordering rule like ratings has — since each tournament's
// contribution is tracked independently via pointsChanges.
export async function applyTournamentPoints(tournamentId) {
  const tournamentRef = doc(db, "tournaments", tournamentId);
  const tournamentSnap = await getDoc(tournamentRef);
  if (!tournamentSnap.exists()) throw new Error("Tournament not found.");
  const tournament = { id: tournamentId, ...tournamentSnap.data() };
  const isDoubles = tournament.format === "doubles";

  const participantSnaps = await getDocs(
    collection(db, "tournaments", tournamentId, "participants"),
  );
  const participants = participantSnaps.docs.map((d) => ({
    id: d.id,
    ...d.data(),
  }));

  // Entities scored are teams for doubles, players for singles — same
  // split as src/ratings.js.
  const entityIds = isDoubles
    ? [...new Set(participants.map((p) => p.teamId).filter(Boolean))]
    : participants.map((p) => p.id);

  if (entityIds.length === 0) {
    throw new Error("No participants were found for this tournament.");
  }

  const matchSnaps = await getDocs(
    collection(db, "tournaments", tournamentId, "matches"),
  );
  const matches = matchSnaps.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((m) => m.status === "submitted");

  // Who reached the bracket, from the same locked draw the app already
  // shows (persistDraw writes this whenever a tournament is finished).
  // Qualification only needs group win/loss records — no rating lookup
  // needed here, unlike the bracket's actual seed *order*.
  const structureSnap = await getDoc(
    doc(db, "tournaments", tournamentId, "structure", "main"),
  );
  const groups = structureSnap.exists()
    ? (deserializeStructure(structureSnap.data())?.groups ?? [])
    : (reconstructStructureFromMatches(matches)?.groups ?? []);
  const qualifiedEntityIds = new Set(
    qualifiersFromGroups(groups, matches).map((q) => q.entityId),
  );

  const pointsByEntity = computeTournamentPoints(
    entityIds,
    matches,
    qualifiedEntityIds,
  );

  // What this tournament awarded last time, if it's been applied before —
  // subtracted out below so recomputing doesn't double-count.
  const previousSnaps = await getDocs(
    collection(db, "tournaments", tournamentId, "pointsChanges"),
  );
  const previousByEntity = {};
  previousSnaps.docs.forEach((d) => {
    previousByEntity[d.id] = d.data().pointsAwarded ?? 0;
  });

  // Map each entity's point delta onto the actual player doc(s) that earn
  // it — for doubles, both players on the team get full credit.
  const playerDeltas = {};
  entityIds.forEach((entityId) => {
    const delta =
      (pointsByEntity[entityId] ?? 0) - (previousByEntity[entityId] ?? 0);
    const playerIds = isDoubles
      ? participants.filter((p) => p.teamId === entityId).map((p) => p.id)
      : [entityId];
    playerIds.forEach((pid) => {
      playerDeltas[pid] = (playerDeltas[pid] || 0) + delta;
    });
  });

  for (const [playerId, delta] of Object.entries(playerDeltas)) {
    if (!delta) continue;
    const playerSnap = await getDoc(doc(db, "players", playerId));
    const currentTotal = playerSnap.exists()
      ? (playerSnap.data().totalPoints ?? 0)
      : 0;
    await setDoc(
      doc(db, "players", playerId),
      { totalPoints: currentTotal + delta },
      { merge: true },
    );
  }

  for (const entityId of entityIds) {
    await setDoc(
      doc(db, "tournaments", tournamentId, "pointsChanges", entityId),
      {
        pointsAwarded: pointsByEntity[entityId] ?? 0,
        appliedAt: serverTimestamp(),
      },
    );
  }

  await setDoc(
    tournamentRef,
    { pointsAppliedAt: serverTimestamp() },
    { merge: true },
  );

  return { entitiesScored: entityIds.length };
}
