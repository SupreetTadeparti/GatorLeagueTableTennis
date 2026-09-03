<script setup>
import { ref, computed, onMounted } from "vue";
import { auth, db } from "../firebase";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
} from "firebase/firestore";

const user = ref(auth.currentUser);
const player = ref(null);
const playerId = ref(null);
const ratingHistory = ref([]);
const loadingHistory = ref(false);

// Set once player.value is confirmed null and we've checked the registrations
// collection: 'pending', 'rejected', or null (never registered at all).
const registrationStatus = ref(null);
const registrationPhotoUrl = ref(null);

// Adjust these thresholds to match how you want ratings to be described.
const TIERS = [
  { min: 1600, label: "Elite", color: "#c084fc" },
  { min: 1400, label: "Expert", color: "#60a5fa" },
  { min: 1200, label: "Advanced", color: "#4ade80" },
  { min: 1000, label: "Intermediate", color: "#facc15" },
  { min: 0, label: "Novice", color: "#9ca3ae" },
];

function tierFor(rating) {
  if (rating === null || rating === undefined) return TIERS[TIERS.length - 1];
  return TIERS.find((t) => rating >= t.min) ?? TIERS[TIERS.length - 1];
}

function toDate(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === "function") return ts.toDate();
  return new Date(ts);
}

onMounted(() => {
  auth.onAuthStateChanged(async (u) => {
    user.value = u;
    player.value = null;
    playerId.value = null;
    ratingHistory.value = [];
    registrationStatus.value = null;
    registrationPhotoUrl.value = null;

    if (!u) return;

    const playerSnap = await getDoc(doc(db, "players", u.uid));
    if (playerSnap.exists()) {
      player.value = playerSnap.data();
      playerId.value = u.uid;
    } else {
      const linkedPlayers = await getDocs(
        query(collection(db, "players"), where("authUid", "==", u.uid)),
      );
      if (!linkedPlayers.empty) {
        player.value = linkedPlayers.docs[0].data();
        playerId.value = linkedPlayers.docs[0].id;
      }
    }

    if (playerId.value) {
      loadingHistory.value = true;
      try {
        const historySnap = await getDocs(
          query(
            collection(db, "players", playerId.value, "ratingHistory"),
            orderBy("recordedAt", "asc"),
          ),
        );
        ratingHistory.value = historySnap.docs.map((d) => {
          const data = d.data();
          return {
            id: d.id,
            rating: data.rating,
            date: toDate(data.recordedAt),
            tournamentId: data.tournamentId,
          };
        });
      } catch (e) {
        console.error("Failed to load rating history", e);
      } finally {
        loadingHistory.value = false;
      }
    } else {
      // No player doc yet — check the registration itself so we can explain
      // *why* (pending review, rejected, or never submitted).
      try {
        const regSnap = await getDocs(
          query(collection(db, "registrations"), where("authUid", "==", u.uid)),
        );
        if (!regSnap.empty) {
          const regData = regSnap.docs[0].data();
          registrationStatus.value = regData.registrationStatus ?? "pending";
          registrationPhotoUrl.value = regData.registrationPhotoUrl ?? null;
        }
      } catch (e) {
        console.error("Failed to check registration status", e);
      }
    }
  });
});

const isVerified = computed(() => player.value !== null);
const displayPhotoUrl = computed(() => player.value?.profilePhotoUrl || registrationPhotoUrl.value);

const statusMessage = computed(() => {
  if (isVerified.value) return null;
  if (registrationStatus.value === "pending") {
    return "Your registration is awaiting admin approval. Your rating and stats will appear once you're approved.";
  }
  if (registrationStatus.value === "rejected") {
    return "Your registration was not approved. Contact an admin if you think this is a mistake.";
  }
  return "You haven't completed player registration yet.";
});

const currentRating = computed(() => player.value?.currentRating ?? null);
const currentTier = computed(() => tierFor(currentRating.value));

const peakRating = computed(() => {
  if (ratingHistory.value.length === 0) return currentRating.value;
  return Math.max(...ratingHistory.value.map((h) => h.rating), currentRating.value ?? 0);
});

const tournamentsPlayed = computed(() => ratingHistory.value.length);

const ratingDelta = computed(() => {
  if (ratingHistory.value.length < 2) return null;
  const last = ratingHistory.value[ratingHistory.value.length - 1];
  const prev = ratingHistory.value[ratingHistory.value.length - 2];
  return last.rating - prev.rating;
});

// --- Chart geometry (plain SVG, no chart library needed) ---
const CHART_W = 560;
const CHART_H = 180;
const PAD = { top: 16, right: 14, bottom: 28, left: 42 };
const plotW = CHART_W - PAD.left - PAD.right;
const plotH = CHART_H - PAD.top - PAD.bottom;

const chartRange = computed(() => {
  const ratings = ratingHistory.value.map((h) => h.rating);
  if (ratings.length === 0) return { min: 0, max: 1 };
  let min = Math.min(...ratings);
  let max = Math.max(...ratings);
  if (min === max) {
    min -= 50;
    max += 50;
  } else {
    const pad = (max - min) * 0.12;
    min -= pad;
    max += pad;
  }
  return { min, max };
});

const chartPoints = computed(() => {
  const n = ratingHistory.value.length;
  const { min, max } = chartRange.value;
  return ratingHistory.value.map((h, i) => {
    const x = n <= 1 ? PAD.left + plotW / 2 : PAD.left + (i / (n - 1)) * plotW;
    const y = PAD.top + plotH - ((h.rating - min) / (max - min || 1)) * plotH;
    return { ...h, x, y };
  });
});

const linePath = computed(() => {
  if (chartPoints.value.length < 2) return "";
  return chartPoints.value.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
});

const areaPath = computed(() => {
  if (chartPoints.value.length < 2) return "";
  const first = chartPoints.value[0];
  const last = chartPoints.value[chartPoints.value.length - 1];
  const baseline = PAD.top + plotH;
  return `${linePath.value} L ${last.x.toFixed(1)},${baseline} L ${first.x.toFixed(1)},${baseline} Z`;
});

function formatMonthYear(date) {
  if (!date) return "";
  return date.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

function formatFull(date) {
  if (!date) return "";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
</script>

<template>
  <div class="page">
    <div class="wrap">
      <h1>Profile</h1>

      <div v-if="!user" class="card">
        <p class="placeholder-text">Please sign in to edit your profile.</p>
      </div>

      <template v-else>
        <div class="card hero">
          <div class="hero-top">
            <img
              v-if="displayPhotoUrl"
              :src="displayPhotoUrl"
              alt="profile"
              class="profile-photo"
            />
            <div v-else class="profile-placeholder">No photo</div>

            <div class="hero-meta">
              <div class="name-row">
                <p class="name">{{ player?.displayName || user.email }}</p>
                <span class="status-badge" :class="isVerified ? 'verified' : 'unverified'">
                  {{ isVerified ? "Verified" : "Unverified" }}
                </span>
              </div>
              <p class="email" v-if="player?.displayName">{{ user.email }}</p>
            </div>
          </div>

          <div v-if="!isVerified" class="status-notice">
            {{ statusMessage }}
          </div>

          <template v-else>
            <div class="rating-block">
              <span class="rating-kicker">Current Rating</span>
              <div class="rating-row">
                <span class="rating-number">{{ currentRating !== null ? currentRating.toLocaleString() : "—" }}</span>
                <span v-if="ratingDelta !== null" class="rating-delta" :class="ratingDelta >= 0 ? 'up' : 'down'">
                  {{ ratingDelta >= 0 ? "▲" : "▼" }} {{ Math.abs(ratingDelta) }}
                </span>
              </div>
              <span class="tier-badge" :style="{ color: currentTier.color, borderColor: currentTier.color }">
                {{ currentTier.label }}
              </span>
            </div>

            <div class="stats-row">
              <div class="stat-box">
                <span class="stat-value">{{ peakRating !== null ? peakRating.toLocaleString() : "—" }}</span>
                <span class="stat-label">Peak Rating</span>
              </div>
              <div class="stat-box">
                <span class="stat-value">{{ tournamentsPlayed }}</span>
                <span class="stat-label">Tournaments</span>
              </div>
              <div class="stat-box">
                <span class="stat-value">{{ (player?.totalPoints ?? 0).toLocaleString() }}</span>
                <span class="stat-label">Points</span>
              </div>
            </div>
          </template>
        </div>

        <div v-if="isVerified" class="card">
          <h2 class="section-title">Rating History</h2>

          <div v-if="loadingHistory" class="placeholder-text">Loading…</div>

          <div v-else-if="ratingHistory.length === 0" class="placeholder-text">
            No tournaments recorded yet — your rating history will appear here after your first confirmed tournament.
          </div>

          <div v-else class="chart-wrap">
            <svg :viewBox="`0 0 ${CHART_W} ${CHART_H}`" class="chart">
              <defs>
                <linearGradient id="ratingFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="#e0551f" stop-opacity="0.35" />
                  <stop offset="100%" stop-color="#e0551f" stop-opacity="0" />
                </linearGradient>
              </defs>

              <line
                v-for="frac in [0, 0.5, 1]"
                :key="frac"
                :x1="PAD.left"
                :x2="CHART_W - PAD.right"
                :y1="PAD.top + plotH * frac"
                :y2="PAD.top + plotH * frac"
                class="gridline"
              />

              <text :x="PAD.left - 8" :y="PAD.top + 4" class="axis-label" text-anchor="end">
                {{ Math.round(chartRange.max) }}
              </text>
              <text :x="PAD.left - 8" :y="PAD.top + plotH + 4" class="axis-label" text-anchor="end">
                {{ Math.round(chartRange.min) }}
              </text>

              <path v-if="areaPath" :d="areaPath" fill="url(#ratingFill)" stroke="none" />
              <path v-if="linePath" :d="linePath" fill="none" stroke="#e0551f" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />

              <circle
                v-for="p in chartPoints"
                :key="p.id"
                :cx="p.x"
                :cy="p.y"
                r="4"
                fill="#e0551f"
                stroke="#111214"
                stroke-width="2"
              >
                <title>{{ formatFull(p.date) }} — {{ p.rating }}</title>
              </circle>

              <text :x="chartPoints[0]?.x" :y="CHART_H - 6" class="axis-label" text-anchor="start">
                {{ formatMonthYear(chartPoints[0]?.date) }}
              </text>
              <text
                :x="chartPoints[chartPoints.length - 1]?.x"
                :y="CHART_H - 6"
                class="axis-label"
                text-anchor="end"
              >
                {{ formatMonthYear(chartPoints[chartPoints.length - 1]?.date) }}
              </text>
            </svg>
          </div>
        </div>
      </template>
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
  max-width: 620px;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

h1 {
  color: #f5f5f5;
  font-size: 1.9rem;
  font-weight: 800;
  letter-spacing: 0.01em;
  margin: 0 0 0.25rem;
}

.card {
  background: #111214;
  border: 1px solid #2a2b2f;
  border-radius: 10px;
  padding: 1.75rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.placeholder-text {
  color: #6f747c;
  font-size: 0.9rem;
  margin: 0;
}

/* Hero card */
.hero-top {
  display: flex;
  gap: 1.25rem;
  align-items: center;
}

.profile-photo {
  width: 84px;
  height: 84px;
  object-fit: cover;
  border-radius: 10px;
  border: 1px solid #2a2b2f;
  flex-shrink: 0;
}

.profile-placeholder {
  width: 84px;
  height: 84px;
  background: #0d0e10;
  border: 1px solid #2f3136;
  color: #6f747c;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  font-size: 0.8rem;
  font-weight: 600;
  flex-shrink: 0;
  text-align: center;
}

.hero-meta {
  min-width: 0;
}

.name-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
}

.name {
  margin: 0;
  color: #f5f5f5;
  font-size: 1.15rem;
  font-weight: 700;
  word-break: break-word;
}

.status-badge {
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 0.2rem 0.55rem;
  border-radius: 999px;
  border: 1px solid;
  white-space: nowrap;
}

.status-badge.verified {
  color: #4ade80;
  border-color: rgba(74, 222, 128, 0.4);
  background: rgba(74, 222, 128, 0.1);
}

.status-badge.unverified {
  color: #facc15;
  border-color: rgba(250, 204, 21, 0.4);
  background: rgba(250, 204, 21, 0.1);
}

.email {
  margin: 0.2rem 0 0;
  color: #6f747c;
  font-size: 0.85rem;
}

.status-notice {
  color: #d7dbe0;
  font-size: 0.9rem;
  line-height: 1.5;
  background: rgba(250, 204, 21, 0.08);
  border: 1px solid rgba(250, 204, 21, 0.25);
  border-radius: 8px;
  padding: 0.9rem 1rem;
}

.rating-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.35rem;
  padding: 1.25rem 0;
  border-top: 1px solid #2a2b2f;
  border-bottom: 1px solid #2a2b2f;
  text-align: center;
}

.rating-kicker {
  color: #6f747c;
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.rating-row {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
}

.rating-number {
  font-size: 3.4rem;
  font-weight: 800;
  line-height: 1;
  letter-spacing: -0.01em;
  background: linear-gradient(135deg, #ffb37a 0%, #e0551f 60%, #c93f10 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.rating-delta {
  font-size: 0.95rem;
  font-weight: 700;
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
}

.rating-delta.up {
  color: #4ade80;
  background: rgba(74, 222, 128, 0.12);
}

.rating-delta.down {
  color: #f08383;
  background: rgba(240, 131, 131, 0.12);
}

.tier-badge {
  margin-top: 0.4rem;
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 0.2rem 0.7rem;
  border: 1px solid;
  border-radius: 999px;
}

.stats-row {
  display: flex;
  justify-content: space-around;
  gap: 1rem;
}

.stat-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.2rem;
}

.stat-value {
  color: #f5f5f5;
  font-size: 1.3rem;
  font-weight: 800;
}

.stat-label {
  color: #6f747c;
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

/* Rating history chart */
.section-title {
  margin: 0;
  color: #f5f5f5;
  font-size: 1.05rem;
  font-weight: 700;
}

.chart-wrap {
  width: 100%;
}

.chart {
  width: 100%;
  height: auto;
  display: block;
}

.gridline {
  stroke: #2a2b2f;
  stroke-width: 1;
}

.axis-label {
  fill: #6f747c;
  font-size: 10px;
}
</style>