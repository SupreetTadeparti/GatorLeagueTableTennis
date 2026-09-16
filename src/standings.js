// Shared season-standings ordering, so the Standings leaderboard and any
// other place that needs a player's rank (e.g. the Profile page) can't
// drift apart. Ranked by points first, then by rating as the tiebreak
// when two players are level on points.
export function rankPlayers(players) {
  return [...players]
    .filter(
      (p) =>
        typeof p.totalPoints === "number" ||
        typeof p.currentRating === "number",
    )
    .sort((a, b) => {
      const byPoints = (b.totalPoints ?? 0) - (a.totalPoints ?? 0);
      if (byPoints !== 0) return byPoints;
      return (b.currentRating ?? 0) - (a.currentRating ?? 0);
    });
}
