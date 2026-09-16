// Doubles partnering: invite a player, they accept, a team is born.
//
// Firestore shape this module owns:
//
//   /teamInvites/{inviteId}
//     tournamentId, fromPlayerId, fromPlayerName, toPlayerId, toPlayerName,
//     status: "pending" | "accepted" | "declined" | "cancelled",
//     createdAt, respondedAt, teamId (set once accepted)
//
//   /teams/{teamId}   (per notes.txt, plus a tournamentId this module adds)
//     teamName, teamRating,
//     player1Id, player1Name, player1PhotoUrl,
//     player2Id, player2Name, player2PhotoUrl,
//     tournamentId, createdAt
//
//   /tournaments/{tid}/participants/{playerId}   (one doc per player, per
//     notes.txt — doubles doesn't change the doc's key, just adds teamId)
//     ...same shape as singles, plus teamId pointing at the team above.
//
// A team is scoped to the tournament it was formed for — partnering again
// next week (even with the same person) forms a new team with its own
// rating, seeded fresh as the sum of both players' ratings at the time.

import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import { db } from "./firebase";

export async function fetchTeamInvites(tournamentId) {
  const snaps = await getDocs(
    query(
      collection(db, "teamInvites"),
      where("tournamentId", "==", tournamentId),
    ),
  );
  return snaps.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function fetchTeamsForTournament(tournamentId) {
  const snaps = await getDocs(
    query(collection(db, "teams"), where("tournamentId", "==", tournamentId)),
  );
  return snaps.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// A player is unavailable to invite (or be invited) once they're on a
// team, or already have a pending invite in either direction — avoids
// double-booking someone while their existing invite is still open.
export function isPlayerAvailable(playerId, participants, invites) {
  const onATeam = participants.some((p) => p.id === playerId && p.teamId);
  if (onATeam) return false;
  return !invites.some(
    (inv) =>
      inv.status === "pending" &&
      (inv.fromPlayerId === playerId || inv.toPlayerId === playerId),
  );
}

export function eligiblePartners(allPlayers, participants, invites, selfId) {
  return allPlayers.filter(
    (p) => p.id !== selfId && isPlayerAvailable(p.id, participants, invites),
  );
}

export async function sendTeamInvite(tournamentId, fromPlayer, toPlayer) {
  if (fromPlayer.id === toPlayer.id) {
    throw new Error("You can't partner with yourself.");
  }
  const ref = await addDoc(collection(db, "teamInvites"), {
    tournamentId,
    fromPlayerId: fromPlayer.id,
    fromPlayerName: fromPlayer.fullName || "",
    toPlayerId: toPlayer.id,
    toPlayerName: toPlayer.fullName || "",
    status: "pending",
    createdAt: serverTimestamp(),
    respondedAt: null,
  });
  return ref.id;
}

export async function cancelTeamInvite(invite) {
  await updateDoc(doc(db, "teamInvites", invite.id), {
    status: "cancelled",
    respondedAt: serverTimestamp(),
  });
}

export async function declineTeamInvite(invite) {
  await updateDoc(doc(db, "teamInvites", invite.id), {
    status: "declined",
    respondedAt: serverTimestamp(),
  });
}

// Stable per-tournament ID so accepting the same invite twice (e.g. a
// double click) forms the same team rather than two.
function teamIdFor(tournamentId, playerAId, playerBId) {
  return `${tournamentId}__${[playerAId, playerBId].sort().join("_")}`;
}

// Accepting an invite forms the team, seeds its rating as the sum of both
// players' current ratings, and joins both players to the tournament in
// one batch.
export async function acceptTeamInvite(invite) {
  const [fromSnap, toSnap] = await Promise.all([
    getDoc(doc(db, "players", invite.fromPlayerId)),
    getDoc(doc(db, "players", invite.toPlayerId)),
  ]);
  if (!fromSnap.exists() || !toSnap.exists()) {
    throw new Error("One of the players in this invite no longer exists.");
  }
  const fromPlayer = { id: invite.fromPlayerId, ...fromSnap.data() };
  const toPlayer = { id: invite.toPlayerId, ...toSnap.data() };

  const teamRating = Math.round(
    (fromPlayer.currentRating ?? 1000) + (toPlayer.currentRating ?? 1000),
  );
  const teamId = teamIdFor(invite.tournamentId, fromPlayer.id, toPlayer.id);
  const teamName = `${fromPlayer.fullName || "Player"} & ${toPlayer.fullName || "Player"}`;

  const batch = writeBatch(db);
  batch.set(doc(db, "teams", teamId), {
    teamName,
    teamRating,
    player1Id: fromPlayer.id,
    player1Name: fromPlayer.fullName || "",
    player1PhotoUrl: fromPlayer.profilePhotoUrl ?? null,
    player2Id: toPlayer.id,
    player2Name: toPlayer.fullName || "",
    player2PhotoUrl: toPlayer.profilePhotoUrl ?? null,
    tournamentId: invite.tournamentId,
    createdAt: serverTimestamp(),
  });

  [fromPlayer, toPlayer].forEach((player) => {
    batch.set(
      doc(db, "tournaments", invite.tournamentId, "participants", player.id),
      {
        playerId: player.id,
        playerName: player.fullName || "",
        playerPhotoUrl: player.profilePhotoUrl ?? null,
        teamId,
        initialRating: teamRating,
        joinedAt: serverTimestamp(),
      },
    );
  });

  batch.update(doc(db, "teamInvites", invite.id), {
    status: "accepted",
    respondedAt: serverTimestamp(),
    teamId,
  });

  await batch.commit();
  return teamId;
}

// Disbands a team: removes both players' participant docs and the team
// doc itself. Only sensible before the tournament has been played on.
export async function disbandTeam(tournamentId, teamId, playerIds) {
  const batch = writeBatch(db);
  playerIds.forEach((playerId) => {
    batch.delete(
      doc(db, "tournaments", tournamentId, "participants", playerId),
    );
  });
  batch.delete(doc(db, "teams", teamId));
  await batch.commit();
}
