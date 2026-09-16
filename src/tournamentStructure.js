// Tournament draw: groups + elimination bracket.
//
// The draw used to be recomputed from the live participant list on every
// page load, so a single late join renumbered every group and every match
// ID. Saved results then lined up against the wrong players and whole
// groups appeared unreported. The draw is now an explicit thing that can be
// frozen (see `serializeStructure`, stored at
// /tournaments/{tid}/structure/main) and, for tournaments played before
// freezing existed, rebuilt from the match documents themselves.
//
// A "structure" is { groups: [{ id, playerIds }], bracketSeeds: [playerId] }.
// Match IDs derived from it are stable: `group-{A}-m{n}` and
// `bracket-r{round}-m{match}`, matching the IDs already in Firestore.

// Only used now for the one narrow case where a fresh draw isn't being
// generated: a late joiner appended as a trailing group after the real
// draw already exists (see `reconcileStructure`). The primary draw always
// goes through `selectGroupCount`/`groupDefsForGroupCount` below.
export const GROUP_SIZE = 4;

// The primary group-count policy: always aim for GROUP_COUNT_OPTIONS[0] (4)
// groups, dropping to the next option only when there genuinely aren't
// enough entrants for every group to average MIN_ENTRANTS_PER_GROUP. Every
// option here is deliberately a power of two divided by 2 -- with
// QUALIFIERS_PER_GROUP (2) advancing from each, the bracket is always
// exactly groupCount*2 entrants (8, 4, or 2), which is why byes can never
// happen: the qualifier count is a clean power of two every time.
export const GROUP_COUNT_OPTIONS = [4, 2, 1];
export const MIN_ENTRANTS_PER_GROUP = 3;
export const QUALIFIERS_PER_GROUP = 2;

export function groupIdForIndex(index) {
  return String.fromCharCode(65 + index);
}

// Round-robin pairings for a group of `size`, in the order match numbers
// were assigned: (0,1), (0,2), (0,3), (1,2), (1,3), (2,3)...
export function groupPairs(size) {
  const pairs = [];
  for (let first = 0; first < size; first += 1) {
    for (let second = first + 1; second < size; second += 1) {
      pairs.push([first, second]);
    }
  }
  return pairs;
}

export function groupDefsFromPlayerIds(
  playerIds,
  groupSize = GROUP_SIZE,
  startIndex = 0,
) {
  const defs = [];
  for (let i = 0; i < playerIds.length; i += groupSize) {
    defs.push({
      id: groupIdForIndex(startIndex + defs.length),
      playerIds: playerIds.slice(i, i + groupSize),
    });
  }
  return defs;
}

// Largest option from GROUP_COUNT_OPTIONS for which every group can
// average at least MIN_ENTRANTS_PER_GROUP entrants. The last option (1) is
// the floor for a tiny turnout -- one round-robin "group" of everyone,
// whose top 2 go straight to a final. That's not a special case, it's the
// same algorithm collapsing naturally, which is what makes a small doubles
// turnout work without any doubles-specific logic.
export function selectGroupCount(entrantCount) {
  for (const groupCount of GROUP_COUNT_OPTIONS) {
    if (entrantCount >= groupCount * MIN_ENTRANTS_PER_GROUP) return groupCount;
  }
  return GROUP_COUNT_OPTIONS[GROUP_COUNT_OPTIONS.length - 1];
}

// Splits `playerIds` into exactly `groupCount` contiguous, balanced
// groups (sizes differ by at most 1 -- e.g. 14 entrants / 4 groups ->
// sizes 4,4,3,3), replacing fixed-size-4 chunking so the group *count*
// stays fixed while group *size* grows with the entrant pool.
export function groupDefsForGroupCount(playerIds, groupCount, startIndex = 0) {
  if (playerIds.length === 0 || groupCount <= 0) return [];

  const base = Math.floor(playerIds.length / groupCount);
  const remainder = playerIds.length % groupCount;
  const groups = [];
  let cursor = 0;
  for (let g = 0; g < groupCount; g += 1) {
    const size = base + (g < remainder ? 1 : 0);
    groups.push({
      id: groupIdForIndex(startIndex + g),
      playerIds: playerIds.slice(cursor, cursor + size),
    });
    cursor += size;
  }
  return groups;
}

// The primary draw-generation entry point: always aims for
// GROUP_COUNT_OPTIONS[0] groups (collapsing lower per selectGroupCount),
// then seeds the bracket from group standings rather than the raw
// entrant list. `matches`/`ratingsById` are only needed to derive
// bracket seeding -- with none yet (a brand-new tournament), every group
// is trivially "incomplete" and the bracket comes back all-TBD.
export function structureFromPlayerIds(
  playerIds,
  matches = [],
  ratingsById = {},
) {
  const groups = groupDefsForGroupCount(
    playerIds,
    selectGroupCount(playerIds.length),
  );
  return {
    groups,
    bracketSeeds: deriveBracketSeedsFromGroups(groups, matches, ratingsById),
  };
}

export function groupMatchDefs(groupDef) {
  return groupPairs(groupDef.playerIds.length).map(([a, b], index) => ({
    id: `group-${groupDef.id}-m${index + 1}`,
    stage: "group",
    groupId: groupDef.id,
    matchNumber: index + 1,
    player1Id: groupDef.playerIds[a] ?? null,
    player2Id: groupDef.playerIds[b] ?? null,
  }));
}

// --- Group standings ----------------------------------------------------

function isGroupComplete(groupDef, matches) {
  const expected = groupPairs(groupDef.playerIds.length).length;
  if (expected === 0) return true; // a group of 0 or 1 has nothing to play
  const submitted = matches.filter(
    (m) =>
      m.stage === "group" &&
      m.groupId === groupDef.id &&
      m.status === "submitted",
  ).length;
  return submitted >= expected;
}

// Ranks one group's entrants from its submitted round-robin matches.
// Tiebreak order, chosen to always produce a deterministic result:
//   1. match wins (desc)
//   2. head-to-head result -- but ONLY within a clean 2-entrant tie.
//      Feeding head-to-head into a general sort comparator would be
//      unsound for a 3+-way cyclic tie (A beat B, B beat C, C beat A has
//      no consistent order), so ties are bucketed by win count first and
//      head-to-head only applied to a bucket of exactly two.
//   3. game/score differential across that entrant's group matches
//      (player1Score/player2Score, already on each match doc)
//   4. original seat position in groupDef.playerIds -- always distinct,
//      so this step is always sufficient and never flaky.
export function computeGroupStandings(groupDef, matches) {
  const rowsById = {};
  const ensureRow = (id, fallbackIndex) => {
    if (!rowsById[id]) {
      rowsById[id] = {
        playerId: id,
        wins: 0,
        losses: 0,
        gameDiff: 0,
        originalIndex: fallbackIndex,
      };
    }
    return rowsById[id];
  };
  groupDef.playerIds.forEach((id, index) => ensureRow(id, index));

  const headToHead = new Map(); // `${winnerId}|${loserId}` marker via winner lookup

  matches
    .filter(
      (m) =>
        m.stage === "group" &&
        m.groupId === groupDef.id &&
        m.status === "submitted",
    )
    .forEach((m) => {
      const {
        player1Id,
        player2Id,
        winnerPlayerId,
        player1Score,
        player2Score,
      } = m;
      if (!player1Id || !player2Id || !winnerPlayerId) return;

      const row1 = ensureRow(player1Id, groupDef.playerIds.length);
      const row2 = ensureRow(player2Id, groupDef.playerIds.length);
      const loserPlayerId =
        winnerPlayerId === player1Id ? player2Id : player1Id;
      rowsById[winnerPlayerId].wins += 1;
      rowsById[loserPlayerId].losses += 1;

      const diff =
        typeof player1Score === "number" && typeof player2Score === "number"
          ? player1Score - player2Score
          : 0;
      row1.gameDiff += diff;
      row2.gameDiff -= diff;

      headToHead.set(`${player1Id}|${player2Id}`, winnerPlayerId);
      headToHead.set(`${player2Id}|${player1Id}`, winnerPlayerId);
    });

  const byWins = new Map();
  Object.values(rowsById).forEach((row) => {
    if (!byWins.has(row.wins)) byWins.set(row.wins, []);
    byWins.get(row.wins).push(row);
  });

  const byGameDiffThenSeat = (a, b) =>
    b.gameDiff - a.gameDiff || a.originalIndex - b.originalIndex;

  const ordered = [];
  [...byWins.keys()]
    .sort((a, b) => b - a)
    .forEach((wins) => {
      const bucket = byWins.get(wins);
      if (bucket.length === 2) {
        const [a, b] = bucket;
        const h2h = headToHead.get(`${a.playerId}|${b.playerId}`);
        if (h2h === a.playerId) return ordered.push(a, b);
        if (h2h === b.playerId) return ordered.push(b, a);
        // never played each other -- fall through to the shared tiebreak
      }
      bucket
        .slice()
        .sort(byGameDiffThenSeat)
        .forEach((row) => ordered.push(row));
    });

  return ordered;
}

// Top `qualifiersPerGroup` from every group, tagged with which group and
// placement (1st, 2nd, ...) they earned. Rating-independent -- this is
// all points.js needs to know who reached the bracket.
export function qualifiersFromGroups(
  groups,
  matches,
  qualifiersPerGroup = QUALIFIERS_PER_GROUP,
) {
  const qualifiers = [];
  groups.forEach((groupDef) => {
    const standings = computeGroupStandings(groupDef, matches);
    standings.slice(0, qualifiersPerGroup).forEach((row, index) => {
      qualifiers.push({
        entityId: row.playerId,
        groupId: groupDef.id,
        placement: index + 1,
      });
    });
  });
  return qualifiers;
}

// --- Bracket ----------------------------------------------------------

function roundName(matchCount) {
  if (matchCount <= 1) return "Finals";
  if (matchCount === 2) return "Semifinals";
  if (matchCount === 4) return "Quarterfinals";
  return `Round of ${matchCount * 2}`;
}

// Who moves on out of `match`: the recorded winner, or the lone player when
// the slot is a bye. Null while the match is undecided.
function advanceFrom(match, winnerOf) {
  if (!match) return null;
  const { player1Id, player2Id } = match;
  if (player1Id && !player2Id) return player1Id;
  if (!player1Id && player2Id) return player2Id;
  if (!player1Id && !player2Id) return null;
  return winnerOf(match.id) ?? null;
}

// Builds every round, carrying winners forward so later rounds show real
// names instead of a permanent "TBD". `winnerOf(matchId)` returns the
// winnerPlayerId recorded for a match, or null/undefined if unplayed.
export function buildBracketRounds(bracketSeeds, winnerOf = () => null) {
  const seeds = bracketSeeds ?? [];
  if (seeds.length === 0) return [];

  const rounds = [];
  let current = [];
  for (let i = 0; i < seeds.length; i += 2) {
    current.push({
      id: `bracket-r0-m${i / 2}`,
      stage: "bracket",
      roundIndex: 0,
      match: i / 2,
      player1Id: seeds[i] ?? null,
      player2Id: seeds[i + 1] ?? null,
    });
  }
  rounds.push({ name: roundName(current.length), matches: current });

  while (current.length > 1) {
    const roundIndex = rounds.length;
    const next = [];
    for (let i = 0; i < current.length; i += 2) {
      next.push({
        id: `bracket-r${roundIndex}-m${i / 2}`,
        stage: "bracket",
        roundIndex,
        match: i / 2,
        player1Id: advanceFrom(current[i], winnerOf),
        player2Id: advanceFrom(current[i + 1], winnerOf),
      });
    }
    rounds.push({ name: roundName(next.length), matches: next });
    current = next;
  }

  return rounds;
}

// Standard recursive tournament seeding: the bracket-slot order for seed
// numbers 1..n such that seed 1 and seed 2 can only meet in the final,
// seeds 1-4 can only meet by the semifinal, and so on. Verified by hand:
//   standardSeedOrder(2) = [1, 2]
//   standardSeedOrder(4) = [1, 4, 2, 3]
//   standardSeedOrder(8) = [1, 8, 4, 5, 2, 7, 3, 6]
export function standardSeedOrder(n) {
  if (n <= 1) return [1];
  const half = standardSeedOrder(n / 2);
  const order = [];
  half.forEach((seed) => order.push(seed, n + 1 - seed));
  return order;
}

// Derives the bracket's seed list from group standings instead of just
// being handed the full entrant list. Qualifiers are ranked group
// placement first (every 1st-place finisher outranks every runner-up),
// then by rating within a tier, then placed into the bracket via
// standardSeedOrder. `ratingsById` should hold each entity's *frozen*
// rating carried into this tournament (the same convention used
// everywhere else in this app), not a live rating.
//
// Seeding compares every group's outcome against every other's, so it
// can't be partially resolved -- this returns an all-null placeholder of
// the right length until every group's round robin is fully submitted.
// The existing bracket UI already renders null seeds as "TBD vs TBD."
export function deriveBracketSeedsFromGroups(
  groups,
  matches,
  ratingsById = {},
) {
  const totalSlots = groups.length * QUALIFIERS_PER_GROUP;
  if (totalSlots === 0) return [];

  if (!groups.every((g) => isGroupComplete(g, matches))) {
    return new Array(totalSlots).fill(null);
  }

  const qualifiers = qualifiersFromGroups(
    groups,
    matches,
    QUALIFIERS_PER_GROUP,
  );
  if (qualifiers.length === 0) return new Array(totalSlots).fill(null);

  const byPlacement = new Map();
  qualifiers.forEach((q) => {
    if (!byPlacement.has(q.placement)) byPlacement.set(q.placement, []);
    byPlacement.get(q.placement).push(q);
  });

  const rankedIds = [];
  [...byPlacement.keys()]
    .sort((a, b) => a - b)
    .forEach((placement) => {
      byPlacement
        .get(placement)
        .slice()
        .sort((a, b) => {
          const ratingA = ratingsById[a.entityId] ?? -Infinity;
          const ratingB = ratingsById[b.entityId] ?? -Infinity;
          if (ratingA !== ratingB) return ratingB - ratingA; // higher first
          return String(a.entityId).localeCompare(String(b.entityId));
        })
        .forEach((q) => rankedIds.push(q.entityId));
    });

  const seeds = new Array(rankedIds.length).fill(null);
  standardSeedOrder(rankedIds.length).forEach((seedNumber, slotIndex) => {
    seeds[slotIndex] = rankedIds[seedNumber - 1] ?? null;
  });
  while (seeds.length < totalSlots) seeds.push(null);

  return seeds;
}

// --- Rebuilding a draw from saved matches -----------------------------

const GROUP_MATCH_ID = /^group-(.+)-m(\d+)$/;
const BRACKET_MATCH_ID = /^bracket-r(\d+)-m(\d+)$/;

// Recovers a group's roster, in its original seat order, from the matches
// recorded for it. Each match number maps to a fixed pair of seats, so the
// saved player1Id/player2Id pin those seats down. Tries the smallest group
// size consistent with the evidence.
function solveGroupOrder(entries) {
  const distinct = [];
  entries.forEach((e) => {
    [e.player1Id, e.player2Id].forEach((id) => {
      if (id && !distinct.includes(id)) distinct.push(id);
    });
  });

  const highestMatchNumber = entries.reduce(
    (max, e) => Math.max(max, e.matchNumber || 0),
    0,
  );

  for (let size = 2; size <= 12; size += 1) {
    const pairs = groupPairs(size);
    if (pairs.length < highestMatchNumber) continue;
    if (size < distinct.length) continue;

    const seats = new Array(size).fill(null);
    let consistent = true;

    for (const entry of entries) {
      const pair = pairs[entry.matchNumber - 1];
      if (!pair) {
        consistent = false;
        break;
      }
      const assignments = [
        [pair[0], entry.player1Id],
        [pair[1], entry.player2Id],
      ];
      for (const [seat, playerId] of assignments) {
        if (!playerId) continue;
        if (seats[seat] && seats[seat] !== playerId) {
          consistent = false;
          break;
        }
        seats[seat] = playerId;
      }
      if (!consistent) break;
    }
    if (!consistent) continue;

    // Players seen in the group but not pinned to a seat (possible when
    // some matches were never reported) fill the empty seats in order.
    const leftover = distinct.filter((id) => !seats.includes(id));
    const emptySeats = seats.filter((s) => !s).length;
    if (leftover.length > emptySeats) continue;

    let next = 0;
    for (let seat = 0; seat < size; seat += 1) {
      if (!seats[seat]) seats[seat] = leftover[next++] ?? null;
    }
    return seats.filter(Boolean);
  }

  return distinct;
}

// Rebuilds the draw from the match documents already in Firestore. Those
// docs store the player IDs they were created with, so this reproduces the
// original draw even if the participant list has changed since. Returns
// null when there's nothing to go on.
export function reconstructStructureFromMatches(matchDocs, ratingsById = {}) {
  const byGroup = new Map();
  const firstRound = new Map();

  for (const match of matchDocs) {
    if (!match?.id) continue;

    const asGroup = GROUP_MATCH_ID.exec(match.id);
    if (asGroup) {
      const groupId = match.groupId || asGroup[1];
      const matchNumber = Number(match.matchNumber ?? asGroup[2]);
      if (!byGroup.has(groupId)) byGroup.set(groupId, []);
      byGroup.get(groupId).push({
        matchNumber,
        player1Id: match.player1Id ?? null,
        player2Id: match.player2Id ?? null,
      });
      continue;
    }

    const asBracket = BRACKET_MATCH_ID.exec(match.id);
    if (asBracket && Number(asBracket[1]) === 0) {
      firstRound.set(Number(asBracket[2]), {
        player1Id: match.player1Id ?? null,
        player2Id: match.player2Id ?? null,
      });
    }
  }

  const groups = [...byGroup.keys()]
    .sort()
    .map((id) => ({ id, playerIds: solveGroupOrder(byGroup.get(id)) }))
    .filter((group) => group.playerIds.length > 0);

  let bracketSeeds;
  if (firstRound.size > 0) {
    const highest = Math.max(...firstRound.keys());
    bracketSeeds = new Array((highest + 1) * 2).fill(null);
    firstRound.forEach((pair, matchIndex) => {
      bracketSeeds[matchIndex * 2] = pair.player1Id;
      bracketSeeds[matchIndex * 2 + 1] = pair.player2Id;
    });
  } else {
    // No bracket-stage matches recorded yet — derive provisional seeding
    // from group standings instead of assuming everyone advances (the old
    // behavior here, before groups had a qualification concept at all).
    bracketSeeds = deriveBracketSeedsFromGroups(groups, matchDocs, ratingsById);
  }

  if (groups.length === 0 && bracketSeeds.length === 0) return null;
  return { groups, bracketSeeds };
}

// The draw used to only rebuild from matches while the tournament was
// flagged "finished" — anything else (a fresh reopen, a still-in-progress
// week) fell back to the naive live-participant rebuild and reshuffled
// every group out from under already-reported results. Reconstruction
// should apply whenever there's match evidence, full stop; the only real
// question is what to do with participants who joined but haven't played
// a single recorded match yet (a brand-new group, or a tournament that's
// only just starting). Those get appended as trailing groups rather than
// forcing a fall-back to the naive rebuild for everyone.
export function reconcileStructure(
  matchDocs,
  participantIds,
  ratingsById = {},
) {
  const rebuilt = reconstructStructureFromMatches(matchDocs, ratingsById);
  if (!rebuilt)
    return structureFromPlayerIds(participantIds, matchDocs, ratingsById);

  const known = new Set();
  rebuilt.groups.forEach((g) => g.playerIds.forEach((id) => known.add(id)));
  rebuilt.bracketSeeds.forEach((id) => id && known.add(id));

  const unrepresented = participantIds.filter((id) => !known.has(id));
  if (unrepresented.length === 0) return rebuilt;

  const extraGroups = groupDefsFromPlayerIds(
    unrepresented,
    GROUP_SIZE,
    rebuilt.groups.length,
  );
  return {
    // A late joiner plays for participation only — they don't
    // retroactively earn a bracket seed once the real draw is underway,
    // so they're appended to `groups` but never to `bracketSeeds`.
    groups: [...rebuilt.groups, ...extraGroups],
    bracketSeeds: rebuilt.bracketSeeds,
  };
}

// --- Firestore serialization -----------------------------------------

// Groups go in as a map (not an array of maps) purely to keep the document
// easy to read and edit by hand in the Firebase console.
export function serializeStructure(structure) {
  const groups = {};
  (structure?.groups ?? []).forEach((group) => {
    groups[group.id] = group.playerIds.filter(Boolean);
  });
  return {
    groups,
    bracketSeeds: (structure?.bracketSeeds ?? []).map((id) => id ?? ""),
  };
}

export function deserializeStructure(data) {
  if (!data) return null;
  const groupMap = data.groups ?? {};
  const groups = Object.keys(groupMap)
    .sort()
    .map((id) => ({ id, playerIds: groupMap[id] ?? [] }));
  const bracketSeeds = (data.bracketSeeds ?? []).map((id) => id || null);
  if (groups.length === 0 && bracketSeeds.length === 0) return null;
  return { groups, bracketSeeds };
}
