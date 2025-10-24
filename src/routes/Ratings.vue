<script setup>
import { ref, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { db } from "../firebase.js";
import { getDocs, collection, query, where } from "firebase/firestore";

const props = defineProps([]);
const route = useRoute();
const router = useRouter();
const weekNum = route.params.weekNum;

const ratingData = ref([]);
const loading = ref(true);

// Searches event for initial and final player ratings. Displays a list of player names and their initial and final ratings after
// the event
const fetchRatingData = async () => {
  loading.value = true;

  try {
    // Get event document for this week
    const eventsRef = collection(db, "events");
    const q = query(eventsRef, where("weekNum", "==", parseInt(weekNum)));
    const qSnap = await getDocs(q);

    if (qSnap.empty) {
      router.push("/schedule");
      return;
    }

    const eventDoc = qSnap.docs[0];
    const eventData = eventDoc.data();

    // Get initial and final ratings
    const initialRatings = eventData.initialRatings || [];
    const finalRatings = eventData.finalRatings || [];

    // Get player names
    const playersRef = collection(db, "players");
    const playersSnap = await getDocs(playersRef);
    const playerMap = {};
    playersSnap.docs.forEach((doc) => {
      playerMap[doc.id] = doc.data().name;
    });

    // Combine data
    const combined = initialRatings.map((initial) => {
      const final = finalRatings.find((f) => f.id === initial.id);
      return {
        id: initial.id,
        name: playerMap[initial.id] || "Unknown Player",
        initialRating: initial.rating,
        finalRating: final?.rating || initial.rating,
        change: (final?.rating || initial.rating) - initial.rating,
      };
    });

    // Sort by rating change (highest to lowest)
    combined.sort((a, b) => b.change - a.change);

    ratingData.value = combined;
  } catch (error) {
    console.error("Error fetching rating data:", error);
  } finally {
    loading.value = false;
  }
};

onMounted(() => {
  fetchRatingData();
});
</script>

<template>
  <div class="page-container">
    <h1>Ratings Update - Week {{ weekNum }}</h1>

    <button class="thick-btn results-btn">
      <RouterLink :to="`/results/${weekNum}`"> Results </RouterLink>
    </button>

    <div v-if="loading" class="loading">Loading ratings data...</div>

    <div v-else-if="ratingData.length === 0" class="no-data">
      No ratings data available for this week.
    </div>

    <div v-else class="ratings-table">
      <div class="table-header">
        <div class="col name-col">Player</div>
        <div class="col">Initial Rating</div>
        <div class="col">Final Rating</div>
        <div class="col">Change</div>
      </div>

      <div v-for="player in ratingData" :key="player.id" class="table-row">
        <div class="col name-col">{{ player.name }}</div>
        <div class="col">{{ Math.round(player.initialRating) }}</div>
        <div class="col">{{ Math.round(player.finalRating) }}</div>
        <div
          class="col"
          :class="{
            positive: player.change > 0,
            negative: player.change < 0,
          }"
        >
          {{ player.change > 0 ? "+" : "" }}{{ Math.round(player.change) }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page-container {
  gap: 2em;
}

.loading,
.no-data {
  text-align: center;
  padding: 2em;
  font-size: 1.2em;
  color: #666;
}

.ratings-table {
  display: flex;
  flex-direction: column;
  gap: 0.5em;
  max-width: 800px;
  /* margin: 0 auto; */
}

.table-header {
  display: flex;
  background: hsl(var(--gator-orange));
  color: white;
  font-weight: bold;
  padding: 1em;
  border-radius: 0.5em;
}

.table-row {
  display: flex;
  padding: 1em;
  border-bottom: 1px solid #ddd;
  transition: background-color 0.2s ease;
}

.col {
  flex: 1;
  text-align: center;
}

.name-col {
  flex: 2;
  text-align: left;
}

.positive {
  color: hsl(125, 70%, 45%);
  font-weight: bold;
}

.negative {
  color: hsl(0, 70%, 45%);
  font-weight: bold;
}

.results-btn {
  color: #ccc;
  font-size: 1.1em;
  width: max-content;
}

@media (max-width: 600px) {
  .ratings-table {
    font-size: 0.9em;
  }

  .table-header,
  .table-row {
    padding: 0.75em;
  }
}
</style>
