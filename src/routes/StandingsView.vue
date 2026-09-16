<script setup>
import { ref, computed, onMounted } from "vue";
import { collection, getDocs } from "firebase/firestore";
import { db } from "../firebase";

const players = ref([]);
const loading = ref(true);
const loadError = ref("");

async function loadPlayers() {
  loading.value = true;
  loadError.value = "";
  try {
    const snaps = await getDocs(collection(db, "players"));
    players.value = snaps.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.error("loadPlayers", e);
    loadError.value = "Unable to load standings right now.";
  } finally {
    loading.value = false;
  }
}

// Ranked by season points — that's what "standings" means here. Rating
// is shown alongside as secondary context, not what the list is sorted
// by.
const ranked = computed(() =>
  [...players.value]
    .filter(
      (p) =>
        typeof p.totalPoints === "number" ||
        typeof p.currentRating === "number",
    )
    .sort((a, b) => (b.totalPoints ?? 0) - (a.totalPoints ?? 0)),
);

function initial(name) {
  return (name || "?").charAt(0).toUpperCase();
}

onMounted(loadPlayers);
</script>

<template>
  <div class="page">
    <div class="wrap">
      <h1>Standings</h1>
      <p class="subtitle">Season leaderboard, ranked by points.</p>

      <div v-if="loading" class="empty-state">Loading…</div>
      <p v-if="loadError" class="error-text">{{ loadError }}</p>

      <div
        v-if="!loading && !loadError && ranked.length === 0"
        class="empty-state"
      >
        No players yet.
      </div>

      <ol v-if="ranked.length > 0" class="leaderboard">
        <li
          v-for="(p, idx) in ranked"
          :key="p.id"
          class="row"
          :class="{ 'top-three': idx < 3 }"
        >
          <span class="rank">{{ idx + 1 }}</span>

          <img
            v-if="p.profilePhotoUrl"
            :src="p.profilePhotoUrl"
            :alt="p.fullName"
            class="avatar"
          />
          <span v-else class="avatar avatar-fallback">{{
            initial(p.fullName)
          }}</span>

          <span class="name">{{ p.fullName || "Unnamed player" }}</span>

          <span class="rating">{{
            typeof p.currentRating === "number"
              ? Math.round(p.currentRating)
              : "—"
          }}</span>

          <span class="points">{{ p.totalPoints ?? 0 }}</span>
        </li>
      </ol>

      <div v-if="ranked.length > 0" class="legend">
        <span class="legend-item"
          ><span class="legend-dot rating-dot"></span>Rating</span
        >
        <span class="legend-item"
          ><span class="legend-dot points-dot"></span>Points</span
        >
      </div>
    </div>
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  background: #0a0a0a;
  padding: 3rem 1.5rem 4rem;
  display: flex;
  justify-content: center;
}

.wrap {
  width: 100%;
  max-width: 720px;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

h1 {
  color: #f5f5f5;
  font-size: 1.9rem;
  font-weight: 800;
  margin: 0 0 0.25rem;
}

.subtitle {
  color: #9ca3ae;
  margin: 0 0 0.5rem;
}

.empty-state {
  color: #6f747c;
  font-size: 0.9rem;
  padding: 0.75rem 0;
}

.error-text {
  color: #f08383;
  font-size: 0.9rem;
}

.leaderboard {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.row {
  display: grid;
  grid-template-columns: 2rem 2.5rem 1fr auto auto;
  align-items: center;
  gap: 0.85rem;
  background: #111214;
  border: 1px solid #2a2b2f;
  border-radius: 10px;
  padding: 0.7rem 1rem;
}

.row.top-three {
  border-color: rgba(224, 85, 31, 0.4);
  background: #141517;
}

.rank {
  color: #6f747c;
  font-weight: 800;
  font-size: 1rem;
  text-align: center;
}

.row.top-three .rank {
  color: #ff8a4c;
}

.avatar {
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 50%;
  object-fit: cover;
}

.avatar-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.08);
  color: #d8d8d8;
  font-weight: 700;
}

.name {
  color: #f0f0f1;
  font-weight: 600;
  font-size: 0.95rem;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rating {
  color: #9ca3ae;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  min-width: 3ch;
  text-align: right;
}

.points {
  color: #ffffff;
  background: linear-gradient(135deg, #ffb37a 0%, #e0551f 60%, #c93f10 100%);
  border-radius: 999px;
  padding: 0.3rem 0.75rem;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  min-width: 3.5ch;
  text-align: center;
}

.legend {
  display: flex;
  justify-content: flex-end;
  gap: 1.2rem;
  color: #6f747c;
  font-size: 0.8rem;
  padding-right: 0.5rem;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.legend-dot {
  width: 0.6rem;
  height: 0.6rem;
  border-radius: 50%;
}

.rating-dot {
  background: #9ca3ae;
}

.points-dot {
  background: #e0551f;
}

@media (max-width: 480px) {
  .row {
    grid-template-columns: 1.6rem 2.2rem 1fr auto auto;
    gap: 0.6rem;
    padding: 0.6rem 0.75rem;
  }

  .rating {
    font-size: 0.85rem;
  }
}
</style>
