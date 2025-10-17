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
} from "firebase/firestore";
import { updateRating } from "../util/ratings.js";

const props = defineProps([]);

const route = useRoute();
const router = useRouter();
const weekNum = route.params.weekNum;

const updateAccessCode = "GLTTWeek3!";

const enteredAccessCode = ref("");
const results = ref([]);

// grouped results by matchType
const grouped = computed(() => {
  const map = {};
  for (const m of results.value) {
    const type = m.matchType || "Other";
    if (!map[type]) map[type] = [];
    map[type].push(m);
  }
  // convert to array of { type, matches } sorted by type name
  return Object.keys(map)
    .sort()
    .map((type) => ({ type, matches: map[type] }));
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

// Fetch players collection
const fetchPlayers = async () => {
  players.value = [];
  const playersRef = collection(db, "players");
  const snap = await getDocs(playersRef);
  players.value = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
};

// Fetch results for this week
const fetchResults = async () => {
  results.value = [];
  const eventsRef = collection(db, "events");
  const q = query(eventsRef, where("weekNum", "==", parseInt(weekNum)));
  const qSnap = await getDocs(q);

  if (qSnap.empty) return router.push("/schedule");

  // Assume only one event doc per week
  const eventDoc = qSnap.docs[0];
  const eventData = eventDoc.data();

  if (!eventData.matchList || !Array.isArray(eventData.matchList)) return;

  const matchPromises = eventData.matchList.map(async (matchRef) => {
    const matchDocSnap = await getDoc(matchRef);
    if (matchDocSnap && matchDocSnap.exists()) {
      const data = matchDocSnap.data();
      return {
        id: matchDocSnap.id,
        playerA: { name: data.playerA.name, rating: data.playerA.rating },
        playerB: { name: data.playerB.name, rating: data.playerB.rating },
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
  // Get current event document
  const eventsRef = collection(db, "events");
  const q = query(eventsRef, where("weekNum", "==", parseInt(weekNum)));
  const qSnap = await getDocs(q);

  if (qSnap.empty) {
    console.error("No event found for week", weekNum);
    return;
  }

  // Get all current player ratings
  const playersRef = collection(db, "players");
  const playersSnap = await getDocs(playersRef);
  const currentRatings = playersSnap.docs.map((doc) => ({
    id: doc.id,
    rating: doc.data().rating,
  }));

  // Update the event's finalRatings
  const eventDoc = qSnap.docs[0];
  const eventRef = doc(db, "events", eventDoc.id);
  await updateDoc(eventRef, {
    finalRatings: currentRatings,
  });

  alert("Final ratings have been saved for this event!");
};

const addMatch = async () => {
  // simple validation
  if (!form.value.playerA || !form.value.playerB)
    return alert("Select both players");

  // create match doc
  const matchesRef = collection(db, "matches");

  const playerA = players.value.find((p) => p.id === form.value.playerA);
  const playerB = players.value.find((p) => p.id === form.value.playerB);
  const winner = form.value.winner;

  const newMatch = {
    playerA: {
      id: playerA.id,
      name: playerA.name,
      rating: playerA.rating,
    },
    playerB: {
      id: playerB.id,
      name: playerB.name,
      rating: playerB.rating,
    },
    matchType: form.value.matchType,
    winner: winner,
    weekNum: parseInt(weekNum),
  };

  const matchDocRef = await addDoc(matchesRef, newMatch);

  // Append reference to event.matchList
  const eventsRef = collection(db, "events");
  const q = query(eventsRef, where("weekNum", "==", parseInt(weekNum)));
  const qSnap = await getDocs(q);

  const eventDoc = qSnap.docs[0];
  const eventDocRef = doc(db, "events", eventDoc.id);
  await updateDoc(eventDocRef, { matchList: arrayUnion(matchDocRef) });

  // TODO: Update ratings and points for players
  const newRatingA = updateRating(playerA.rating, playerB.rating, winner === 0);
  const newRatingB = playerB.rating - (newRatingA - playerA.rating);

  // Update player ratings in Firestore
  const playerARef = doc(db, "players", playerA.id);
  const playerBRef = doc(db, "players", playerB.id);

  await Promise.all([
    updateDoc(playerARef, { rating: newRatingA }),
    updateDoc(playerBRef, { rating: newRatingB }),
  ]);

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
        <button class="save-btn thick-btn" @click="addMatch">Add Result</button>
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
          class="thick-btn access-btn"
          :class="showForm ? 'cancel-btn' : 'add-btn'"
          :disabled="enteredAccessCode !== updateAccessCode"
          @click="showForm = !showForm"
        >
          {{ showForm ? "Cancel Operation" : "Add Match Result" }}
        </button>
        <button
          class="thick-btn compute-btn"
          :disabled="enteredAccessCode !== updateAccessCode"
          @click="finalizeResults"
        >
          Compute New Ratings
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
  --btn-clr: var(--gator-orange);
}

.access-form {
  display: flex;
  gap: 1em;
}

.access-code-input {
  padding: 0.5em;
  font-size: 1em;
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
  font-size: 0.85em;
  border-radius: 0;
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

@media (max-width: 600px) {
  .update-form-container {
    align-items: center;
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
