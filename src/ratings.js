// Shared rating engine.
//
// Everything that reads or writes rating data lives here so TournamentView
// (the active tournament) and AdminView (any tournament, after the fact)
// can't drift apart. Firestore shape this module owns:
//
//   /tournaments/{tid}                      ratingsAppliedAt, format
//   /tournaments/{tid}/participants/{pid}   initialRating   (rating carried in)
//   /tournaments/{tid}/ratingChanges/{pid}  previousRating, newRating, delta
//   /players/{pid}                          currentRating   (format: "singles")
//   /players/{pid}/ratingHistory/{tid}      rating, recordedAt, confirmedAt
//   /teams/{tid}                            teamRating      (format: "doubles")
//   /teams/{tid}/ratingHistory/{tid}        rating, recordedAt, confirmedAt
//
// A tournament's `format` field selects which entity gets rated: "singles"
// (the default) rates /players by playerId, "doubles" rates /teams by
// teamId. Everything else — the math, the ordering rule, match shape — is
// identical; only the collection and field name change. See src/teams.js
// for how a doubles tournament's participant docs (still one per player,
// per notes.txt) map to team IDs.
//
// ORDERING RULE — the reason this module exists:
// ratings are applied oldest tournament first and reverted newest first.
// Holding that invariant means an entity's *current* rating is always the
// rating it carries into the next unrated tournament, so a revert
// automatically feeds the correct starting rating into the recompute that
// follows it. `applyAvailability` / `revertAvailability` enforce the rule;
// callers must consult them before offering the action.

import {
  collection,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  writeBatch,
} from "firebase/firestore";
import { db } from "./firebase";
import { toJsDate } from "./dates";

// Re-exported for existing callers (AdminView) that import it from here.
export { toJsDate };

// --- Rating math -----------------------------------------------------

const inverseLogCurve = (x, a, b) => {
  return 1 / Math.log10(Math.pow(10, 1 / a) + x * b);
};

export const updateRating = (initialRating, opponentRating, won) => {
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

// Net rating delta per player across every submitted match, each evaluated
// against the ratings the players carried *into* the tournament (never a
// running total), so the result doesn't depend on match order and doesn't
// accumulate match-over-match.
export function computeTournamentRatingDeltas(matches, initialRatingsById) {
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

// --- Tournament ordering ---------------------------------------------

export function tournamentLabel(tournament) {
  return tournament?.name || tournament?.id || "this tournament";
}

function tournamentTime(tournament) {
  return toJsDate(tournament?.date)?.getTime() ?? 0;
}

// Oldest first — the order ratings must be applied in.
export function sortTournamentsChronologically(tournaments) {
  return [...tournaments].sort((a, b) => {
    const byDate = tournamentTime(a) - tournamentTime(b);
    if (byDate !== 0) return byDate;
    return String(a.id).localeCompare(String(b.id));
  });
}

function positionOf(tournament, tournaments) {
  const ordered = sortTournamentsChronologically(tournaments);
  return { ordered, index: ordered.findIndex((t) => t.id === tournament.id) };
}

// The newest tournament that still has ratings applied and therefore has to
// be reverted before `tournament` can be. Null when nothing is in the way.
export function revertBlocker(tournament, tournaments) {
  const { ordered, index } = positionOf(tournament, tournaments);
  if (index === -1) return null;
  const later = ordered.slice(index + 1).filter((t) => t.ratingsAppliedAt);
  return later.length > 0 ? later[later.length - 1] : null;
}

// A tournament is due a rating pass once it's finished — or once it has
// been reverted, which covers older tournaments that were rated before the
// finish flag existed and would otherwise be impossible to re-apply.
function awaitsRatings(tournament) {
  return !!(tournament?.finishedAt || tournament?.ratingsRevertedAt);
}

// The oldest due-but-unrated tournament sitting before `tournament`, which
// must be applied first. Null when `tournament` is next in line.
export function applyBlocker(tournament, tournaments) {
  const { ordered, index } = positionOf(tournament, tournaments);
  if (index === -1) return null;
  return (
    ordered
      .slice(0, index)
      .find((t) => awaitsRatings(t) && !t.ratingsAppliedAt) ?? null
  );
}

export function revertAvailability(tournament, tournaments) {
  if (!tournament?.ratingsAppliedAt) {
    return {
      allowed: false,
      reason: "This tournament has no rating changes on record.",
    };
  }
  const blocker = revertBlocker(tournament, tournaments);
  if (blocker) {
    return {
      allowed: false,
      reason: `Revert "${tournamentLabel(blocker)}" first — ratings come off newest to oldest.`,
    };
  }
  return { allowed: true, reason: "" };
}

export function applyAvailability(tournament, tournaments) {
  if (tournament?.ratingsAppliedAt) {
    return {
      allowed: false,
      reason: "Ratings are already applied. Revert them first to recompute.",
    };
  }
  if (!awaitsRatings(tournament)) {
    return {
      allowed: false,
      reason: "Finish this tournament before applying its ratings.",
    };
  }
  const blocker = applyBlocker(tournament, tournaments);
  if (blocker) {
    return {
      allowed: false,
      reason: `Apply "${tournamentLabel(blocker)}" first — ratings go on oldest to newest.`,
    };
  }
  return { allowed: true, reason: "" };
}

export async function fetchTournaments() {
  const snaps = await getDocs(collection(db, "tournaments"));
  return snaps.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// --- Entity resolution (singles vs. doubles) --------------------------

export function isDoublesTournament(tournament) {
  return tournament?.format === "doubles";
}

// Which top-level collection and field actually holds the rating for
// whatever this tournament rates — a player, or a team.
function ratingTarget(tournament) {
  return isDoublesTournament(tournament)
    ? { collection: "teams", field: "teamRating" }
    : { collection: "players", field: "currentRating" };
}

// The IDs of the things being rated. Singles participant docs are keyed
// by playerId directly. Doubles participant docs are still one per
// player (per the schema), each carrying a `teamId` — so the rated
// entities are the distinct team IDs among them.
function entityIdsFromParticipants(tournament, participantDocs) {
  if (!isDoublesTournament(tournament)) {
    return participantDocs.map((p) => p.id);
  }
  return [...new Set(participantDocs.map((p) => p.teamId).filter(Boolean))];
}

// The participant doc(s) that snapshot a given entity's rating: the
// entity itself for singles, or every player on the team for doubles
// (both players carry the same initialRating).
function participantDocsForEntity(tournament, participantDocs, entityId) {
  if (!isDoublesTournament(tournament)) {
    return participantDocs.filter((p) => p.id === entityId);
  }
  return participantDocs.filter((p) => p.teamId === entityId);
}

// --- Firestore writes -------------------------------------------------

// writeBatch caps at 500 operations; commit in chunks below that.
const MAX_BATCH_OPS = 400;

function batchWriter() {
  let batch = writeBatch(db);
  let ops = 0;

  async function rollIfFull() {
    if (ops < MAX_BATCH_OPS) return;
    await batch.commit();
    batch = writeBatch(db);
    ops = 0;
  }

  return {
    async set(ref, data, options) {
      if (options) batch.set(ref, data, options);
      else batch.set(ref, data);
      ops += 1;
      await rollIfFull();
    },
    async delete(ref) {
      batch.delete(ref);
      ops += 1;
      await rollIfFull();
    },
    async commit() {
      if (ops > 0) await batch.commit();
      ops = 0;
    },
  };
}

// Applies (or re-applies) this tournament's rating changes.
//
// The rating an entity (a player, or — for doubles — a team) carries into
// the tournament is its *live* rating at the moment this runs. Because
// the ordering rule at the top of this file guarantees every earlier
// tournament is already applied and every later one is reverted, that
// live value is exactly the entity's post-previous-tournament rating —
// which is what fixes the stale initialRating frozen at join time. The
// value used is written back onto the participant doc(s) so the record
// matches what was actually computed.
export async function applyTournamentRatings(tournamentId) {
  const tournamentRef = doc(db, "tournaments", tournamentId);
  const tournamentSnap = await getDoc(tournamentRef);
  if (!tournamentSnap.exists()) throw new Error("Tournament not found.");
  const tournament = { id: tournamentId, ...tournamentSnap.data() };
  const { collection: entityCollection, field: ratingField } =
    ratingTarget(tournament);

  const participantSnaps = await getDocs(
    collection(db, "tournaments", tournamentId, "participants"),
  );
  const participants = participantSnaps.docs.map((d) => ({
    id: d.id,
    ...d.data(),
  }));

  const entityIds = entityIdsFromParticipants(tournament, participants);
  const entitySnaps = await Promise.all(
    entityIds.map((id) => getDoc(doc(db, entityCollection, id))),
  );

  const initialRatingsById = {};
  entityIds.forEach((entityId, i) => {
    const snap = entitySnaps[i];
    const liveRating = snap.exists() ? snap.data()[ratingField] : undefined;
    // Fall back to the join-time snapshot only when the entity doc is gone
    // or has no rating at all.
    const fallback = participantDocsForEntity(
      tournament,
      participants,
      entityId,
    )[0]?.initialRating;
    const rating = typeof liveRating === "number" ? liveRating : fallback;
    if (typeof rating === "number") initialRatingsById[entityId] = rating;
  });

  const matchSnaps = await getDocs(
    collection(db, "tournaments", tournamentId, "matches"),
  );
  const matches = matchSnaps.docs
    .map((d) => d.data())
    .filter((m) => m.status === "submitted");

  const deltas = computeTournamentRatingDeltas(matches, initialRatingsById);
  const ratedEntityIds = Object.keys(deltas);
  if (ratedEntityIds.length === 0) {
    throw new Error(
      "No submitted matches with rating data were found for this tournament.",
    );
  }

  // Timestamp the history entry with the tournament's own date so a
  // rating chart reads chronologically, not by when an admin happened to
  // press the button.
  const recordedAt = toJsDate(tournament.date) ?? new Date();
  const writer = batchWriter();

  for (const entityId of entityIds) {
    const rating = initialRatingsById[entityId];
    if (typeof rating !== "number") continue;
    for (const participant of participantDocsForEntity(
      tournament,
      participants,
      entityId,
    )) {
      await writer.set(
        doc(db, "tournaments", tournamentId, "participants", participant.id),
        { initialRating: rating },
        { merge: true },
      );
    }
  }

  for (const entityId of ratedEntityIds) {
    const previousRating = initialRatingsById[entityId];
    const newRating = Math.round(previousRating + deltas[entityId]);
    const delta = newRating - previousRating;

    await writer.set(
      doc(db, entityCollection, entityId),
      { [ratingField]: newRating },
      { merge: true },
    );

    // Record exactly what changed so a revert can restore it precisely.
    // The field is still named `playerId` for historical reasons — it
    // holds a teamId for doubles tournaments.
    await writer.set(
      doc(db, "tournaments", tournamentId, "ratingChanges", entityId),
      {
        playerId: entityId,
        previousRating,
        newRating,
        delta,
        appliedAt: serverTimestamp(),
      },
    );

    // Keyed by tournament so re-applying overwrites rather than duplicating.
    await writer.set(
      doc(db, entityCollection, entityId, "ratingHistory", tournamentId),
      {
        rating: newRating,
        previousRating,
        delta,
        tournamentId,
        tournamentName: tournament.name ?? null,
        recordedAt,
        confirmedAt: serverTimestamp(),
      },
    );
  }

  await writer.set(
    tournamentRef,
    { ratingsAppliedAt: serverTimestamp() },
    { merge: true },
  );
  await writer.commit();

  return { entitiesUpdated: ratedEntityIds.length };
}

// Restores every entity touched by this tournament back to the rating it
// held before it, removes the tournament from its rating history, and
// clears the applied flag.
export async function revertTournamentRatings(tournamentId) {
  const tournamentSnap = await getDoc(doc(db, "tournaments", tournamentId));
  const tournament = tournamentSnap.exists()
    ? { id: tournamentId, ...tournamentSnap.data() }
    : { id: tournamentId };
  const { collection: entityCollection, field: ratingField } =
    ratingTarget(tournament);

  const snaps = await getDocs(
    collection(db, "tournaments", tournamentId, "ratingChanges"),
  );

  const writer = batchWriter();
  let restored = 0;

  for (const d of snaps.docs) {
    const { playerId: entityId, previousRating } = d.data();
    if (!entityId || typeof previousRating !== "number") continue;
    await writer.set(
      doc(db, entityCollection, entityId),
      { [ratingField]: previousRating },
      { merge: true },
    );
    await writer.delete(
      doc(db, entityCollection, entityId, "ratingHistory", tournamentId),
    );
    await writer.delete(d.ref);
    restored += 1;
  }

  await writer.set(
    doc(db, "tournaments", tournamentId),
    { ratingsAppliedAt: null, ratingsRevertedAt: serverTimestamp() },
    { merge: true },
  );
  await writer.commit();

  return { entitiesRestored: restored };
}
