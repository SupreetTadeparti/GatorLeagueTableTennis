<script setup>
import { ref, onMounted, computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { db } from "../firebase.js";
import {
  getDocs,
  collection,
  query,
  where,
  getDoc,
  doc,
  addDoc,
  updateDoc,
  arrayUnion,
  deleteDoc,
} from "firebase/firestore";
import { updateRating } from "../util/ratings.js";

const props = defineProps([]);

const route = useRoute();
const router = useRouter();
const weekNum = route.params.weekNum;

const updateAccessCode = "GLTTWeek3!";

const enteredAccessCode = ref("");
const results = ref([]);
const currentEvent = ref(null);
const currentEventRef = ref(null);

// Centralized function to fetch and store event document
const fetchEvent = async () => {
  const eventsRef = collection(db, "events");
  const q = query(eventsRef, where("weekNum", "==", parseInt(weekNum)));
  const qSnap = await getDocs(q);

  if (qSnap.empty) {
    router.push("/schedule");
    return false;
  }

  // Store both document data and reference
  const eventDoc = qSnap.docs[0];
  currentEvent.value = eventDoc.data();
  currentEventRef.value = doc(db, "events", eventDoc.id);
  return true;
};

// Grouped results by matchType with custom ordering
const grouped = computed(() => {
  const map = {};
  for (const m of results.value) {
    const type = m.matchType || "Other";
    if (!map[type]) map[type] = [];
    map[type].push(m);
  }

  // Desired Order
  const desiredOrder = [
    "Finals",
    "Semi Finals",
    "Quarter Finals",
    "Round of 16",
    "Pre-Elimination",
    "Group Stage",
  ];

  // Start with types in desired order if they exist
  const ordered = [];
  for (const t of desiredOrder) {
    if (map[t] && map[t].length > 0) {
      ordered.push({ type: t, matches: map[t] });
      delete map[t]; // remove so remaining unknowns are handled later
    }
  }

  // Any remaining types (including 'Other') - sort them alphabetically
  const remainingTypes = Object.keys(map).filter(
    (k) => map[k] && map[k].length > 0
  );
  remainingTypes.sort();
  for (const t of remainingTypes) {
    ordered.push({ type: t, matches: map[t] });
  }

  return ordered;
});

const players = ref([]);

// form state
const showForm = ref(false);

const form = ref({
  playerA: null,
  playerB: null,
  matchType: null,
  winner: null,
});

// WARNING: Remember to only call temporarily to reset initial ratings to current player ratings
const resetInitialRatings = async () => {
  if (!currentEventRef.value && !(await fetchEvent())) return;

  // Fetch all current players and their ratings
  const playersRef = collection(db, "players");
  const playersSnap = await getDocs(playersRef);

  const initialRatings = playersSnap.docs.map((d) => ({
    id: d.id,
    rating: d.data().rating,
  }));

  // Update the event document with the initialRatings
  await updateDoc(eventDocRef, {
    initialRatings,
  });
};

const fetchPlayers = async () => {
  players.value = [];
  const playersRef = collection(db, "players");
  const snap = await getDocs(playersRef);
  players.value = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
};

const fetchResults = async () => {
  results.value = [];

  // Use stored event or fetch if needed
  if (!currentEvent.value && !(await fetchEvent())) return;

  if (
    !currentEvent.value.matchList ||
    !Array.isArray(currentEvent.value.matchList)
  )
    return;

  const matchPromises = currentEvent.value.matchList.map(async (matchRef) => {
    const matchDocSnap = await getDoc(matchRef);
    if (matchDocSnap && matchDocSnap.exists()) {
      const data = matchDocSnap.data();

      const playerRatings = currentEvent.value.initialRatings;

      let playerARating, playerBRating;

      for (const player of playerRatings) {
        if (player.id === data.playerA.id) playerARating = player.rating;
        if (player.id === data.playerB.id) playerBRating = player.rating;
      }

      return {
        id: matchDocSnap.id,
        playerA: { name: data.playerA.name, rating: playerARating },
        playerB: { name: data.playerB.name, rating: playerBRating },
        winner: data.winner,
        matchType: data.matchType,
      };
    }
    return null;
  });

  const fetched = await Promise.all(matchPromises);
  results.value = fetched.filter(Boolean);
};

const finalizeResults = async () => {
  if (!currentEvent.value && !(await fetchEvent())) {
    console.error("No event found for week", weekNum);
    return;
  }

  try {
    const matchList = currentEvent.value.matchList;
    const initialPlayerRatings = currentEvent.value.initialRatings;

    // Maps Id : Rating Change
    const playerRatingDiff = {};

    // Iterator through each match
    matchList.forEach(async (matchRef) => {
      const matchDoc = await getDoc(matchRef);
      let matchData = matchDoc.data();

      /* USED FOR REFORMATTING MATCH DATA

      // Convert match data from {id, name, rating} format to just id strings
      const updates = {};

      // Check playerA format and update if needed
      if (typeof matchData.playerA !== "object" && matchData.playerA !== null) {
        const playerDoc = doc(db, "players", matchData.playerA);
        const player = await getDoc(playerDoc);
        const playerData = player.data();
        updates.playerA = { id: matchData.playerA, name: playerData.name };
      }

      // Check playerB format and update if needed
      if (typeof matchData.playerB !== "object" && matchData.playerB !== null) {
        const playerDoc = doc(db, "players", matchData.playerB);
        const player = await getDoc(playerDoc);
        const playerData = player.data();
        updates.playerB = { id: matchData.playerB, name: playerData.name };
      }

      // Only update if we have changes
      if (Object.keys(updates).length > 0) {
        await updateDoc(matchRef, updates);
        // Re-fetch the updated match data
        const updatedMatchDoc = await getDoc(matchRef);
        matchData = updatedMatchDoc.data();
      }
      */

      // Get winner and loser ids through match data (now using updated matchData if it was changed)
      let winnerId =
        matchData.winner === 0 ? matchData.playerA.id : matchData.playerB.id;
      let loserId =
        matchData.winner === 1 ? matchData.playerA.id : matchData.playerB.id;

      // Get winner, loser data with ratings from event data
      let winner, loser;

      for (let player of initialPlayerRatings) {
        if (player.id == winnerId) winner = player;
        if (player.id == loserId) loser = player;
      }

      // TODO: Get ratinng from initialplayerratings list
      let newRating = updateRating(winner.rating, loser.rating, true);
      let ratingDiff = newRating - winner.rating;

      if (!(winner.id in playerRatingDiff)) {
        playerRatingDiff[winner.id] = 0;
      }

      if (!(loser.id in playerRatingDiff)) {
        playerRatingDiff[loser.id] = 0;
      }

      playerRatingDiff[winner.id] += ratingDiff;
      playerRatingDiff[loser.id] -= ratingDiff;
    });

    // Get all current player ratings and update them
    // TODO: Only do so if latest week
    const playersRef = collection(db, "players");
    const playersSnap = await getDocs(playersRef);

    const finalRatings = [];
    const updatePromises = [];

    for (const playerDoc of playersSnap.docs) {
      const playerId = playerDoc.id;

      // Get event initial rating
      let initialRating;

      for (const playerRating of currentEvent.value.initialRatings) {
        if (playerRating.id === playerId) initialRating = playerRating.rating;
      }

      const ratingDiff = playerRatingDiff[playerId] || 0;
      const newRating = initialRating + ratingDiff;

      // Store for finalRatings
      finalRatings.push({
        id: playerId,
        rating: newRating,
      });

      // Update player document if rating changed
      if (ratingDiff !== 0) {
        const playerRef = doc(db, "players", playerId);
        updatePromises.push(
          updateDoc(playerRef, {
            rating: newRating,
          })
        );
      }
    }

    // Wait for all updates to complete
    await Promise.all([
      ...updatePromises,
      updateDoc(currentEventRef.value, {
        finalRatings: finalRatings,
      }),
    ]);

    alert(
      "Final ratings have been saved for this event and players have been updated!"
    );
  } catch (error) {
    alert("Failed to update ratings");
  }
};

const addMatch = async () => {
  // simple validation
  if (!form.value.playerA || !form.value.playerB)
    return alert("Select both players");

  // create match doc
  const matchesRef = collection(db, "matches");
  const winner = form.value.winner;

  const playerADoc = doc(db, "players", form.value.playerA);
  const playerBDoc = doc(db, "players", form.value.playerB);

  const playerA = await getDoc(playerADoc);
  const playerB = await getDoc(playerBDoc);

  const playerAName = playerA.data().name;
  const playerBName = playerB.data().name;

  const newMatch = {
    playerA: { id: playerA.id, name: playerAName },
    playerB: { id: playerB.id, name: playerBName },
    matchType: form.value.matchType,
    winner: winner,
    weekNum: parseInt(weekNum),
  };

  const matchDocRef = await addDoc(matchesRef, newMatch);

  // Append reference to event.matchList
  if (!currentEventRef.value && !(await fetchEvent())) return;

  await updateDoc(currentEventRef.value, {
    matchList: arrayUnion(matchDocRef),
  });

  // Reset form and refresh results
  showForm.value = false;

  form.value = {
    playerA: null,
    playerB: null,
    matchType: null,
    winner: null,
  };

  await fetchResults();
};

const confirmDelete = (matchId) => {
  if (window.confirm("Are you sure you want to delete this match?")) {
    deleteMatch(matchId);
  }
};

const deleteMatch = async (matchId) => {
  if (!currentEvent.value && !(await fetchEvent())) {
    console.error("No event found for week", weekNum);
    return;
  }

  // Refresh event data to ensure we have latest
  const freshEventData = await getDoc(currentEventRef.value);
  currentEvent.value = freshEventData.data();

  // Create new matchList without the deleted match reference
  const updatedMatchList = currentEvent.value.matchList.filter(
    (ref) => ref.id !== matchId
  );

  // Update event doc with new matchList
  await updateDoc(currentEventRef.value, {
    matchList: updatedMatchList,
  });

  // Delete the match document itself
  const matchRef = doc(db, "matches", matchId);
  await deleteDoc(matchRef);

  // Refresh the results display
  await fetchResults();
};

onMounted(async () => {
  await fetchPlayers();
  await fetchResults();
});
</script>

<template>
  <div class="page-container">
    <h1>Results for Week {{ weekNum }}:</h1>

    <!-- Update Form -->
    <div class="update-form-container">
      <div v-if="showForm" class="update-form">
        <div class="update-form__questions">
          <label>
            Player A:
            <select v-model="form.playerA">
              <option :value="null">-- select player --</option>
              <option v-for="p in players" :key="p.id" :value="p.id">
                {{ p.name }}
              </option>
            </select>
          </label>

          <label>
            Player B:
            <select v-model="form.playerB">
              <option :value="null">-- select player --</option>
              <option v-for="p in players" :key="p.id" :value="p.id">
                {{ p.name }}
              </option>
            </select>
          </label>

          <label>
            Match Type:
            <select v-model="form.matchType">
              <option :value="null">-- select match type --</option>
              <option>Group Stage</option>
              <option>Pre-Elimination</option>
              <option>Round of 16</option>
              <option>Quarter Finals</option>
              <option>Semi Finals</option>
              <option>Finals</option>
            </select>
          </label>

          <label>
            Winner:
            <select v-model="form.winner">
              <option :value="null">-- select winner --</option>
              <option :value="0">Player A</option>
              <option :value="1">Player B</option>
            </select>
          </label>
        </div>
        <button class="thick-btn blue" @click="addMatch">Add Result</button>
      </div>

      <div class="access-form">
        <input
          type="text"
          v-model="enteredAccessCode"
          v-if="!showForm"
          class="access-code-input"
          placeholder="Enter Access Code"
        />
        <button
          v-if="enteredAccessCode === updateAccessCode"
          class="thick-btn access"
          :class="showForm ? 'gray' : 'blue'"
          @click="showForm = !showForm"
        >
          {{ showForm ? "Cancel Operation" : "Add Match Result" }}
        </button>
        <button
          v-if="enteredAccessCode === updateAccessCode"
          class="thick-btn green"
          @click="finalizeResults"
        >
          Compute New Ratings
        </button>
        <button class="thick-btn orange">
          <RouterLink :to="`/ratings/${weekNum}`">New Ratings</RouterLink>
        </button>
      </div>
    </div>

    <!-- Display Match Results grouped by matchType -->
    <div v-for="group in grouped" :key="group.type" class="match-group">
      <h2>{{ group.type }}</h2>
      <ul>
        <li v-for="match in group.matches" :key="match.id">
          <div class="match-row">
            <div>
              <span :class="match.winner === 0 ? 'winner' : 'loser'"
                >{{ match.playerA.name }} ({{ match.playerA.rating }})</span
              >
              <span class="vs">vs</span>
              <span :class="match.winner === 1 ? 'winner' : 'loser'"
                >{{ match.playerB.name }} ({{ match.playerB.rating }})</span
              >
              <button
                v-if="enteredAccessCode === updateAccessCode"
                class="delete-btn"
                @click="confirmDelete(match.id)"
                title="Delete match"
              >
                x
              </button>
            </div>
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.page-container {
  gap: 2em;
}

.thick-btn {
  font-size: 1.25em;
  width: max-content;
  color: #ddd;
  transition: filter 0.3s ease-out;
}

.cancel-btn {
  --btn-clr: 0, 0%, 50%;
  color: #333;
}

.compute-btn {
  --btn-clr: 0, 0%, 60%;
}

.ratings-btn {
  --btn-clr: var(--gator-orange);
}

.access-form {
  display: flex;
  gap: 1em;
}

.access-code-input {
  padding: 0.5em;
  font-size: 1em;
  border: none;
  outline: 4px solid #888;
  border-radius: 0.25em;
  max-width: 20em;
  height: 3em;
}

.delete-btn {
  color: red;
  background: none;
  border: none;
  font-size: 1.2em;
  font-weight: bold;
  cursor: pointer;
  padding: 0 0.5em;
}

.thick-btn:disabled {
  cursor: not-allowed;
  filter: opacity(60%);
}

.update-form-container {
  display: flex;
  flex-direction: column;
  gap: 2em;
}

.update-form {
  width: max-content;
  display: flex;
  flex-direction: column;
  gap: 1em;
  border: 5px solid hsl(var(--gator-orange));
  background-color: hsl(var(--gator-orange), 0.8);
  border-radius: 0.5em;
  padding: 1.5em;
}

.update-form__questions {
  display: flex;
  gap: 1em;
}

.update-form__questions label {
  display: flex;
  flex-direction: column;
  gap: 0.5em;
  font-size: 1.2em;
}

.update-form__questions select {
  font-size: 0.8em;
  border-radius: 0.25em;
  border: none;
  padding: 0.5em 0.25em;
  text-align: center;
}

.match-row {
  font-size: 1.2em;
}

span.winner {
  font-weight: bold;
  color: hsl(125, 70%, 45%); /* font-weight: bold; */
}

span.vs {
  margin: 0 10px;
  color: #bbb;
}

@media (max-width: 1200px) {
  .access-form {
    display: flex;
    flex-direction: column;
    /* align-items: center; */
  }
}

@media (max-width: 600px) {
  .update-form__questions option {
    font-size: 0.8em;
  }

  .update-form__questions label {
    font-size: 1em;
  }

  .update-form {
    width: 100%;
  }

  .update-form__questions {
    flex-direction: column;
    font-size: 1.2em;
  }

  .update-form__questions select {
    font-size: 1em;
  }

  .update-form,
  .save-btn {
    margin: auto;
  }
}
</style>
