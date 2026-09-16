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
import { uploadPlayerPhoto } from "../firebaseHelpers";
import { toJsDate } from "../dates";
import { rankPlayers } from "../standings";

const user = ref(auth.currentUser);
const player = ref(null);
const playerId = ref(null);
const ratingHistory = ref([]);
const loadingHistory = ref(false);
const playerRank = ref(null);

// Set once player.value is confirmed null and we've checked the registrations
// collection: 'pending', 'rejected', or null (never registered at all).
const registrationStatus = ref(null);
const registrationPhotoUrl = ref(null);

// Adjust these thresholds to match how you want ratings to be described.
const TIERS = [
  { min: 2200, label: "God", color: "#c084fc" },
  { min: 1900, label: "Hacker", color: "#60a5fa" },
  { min: 1600, label: "Pro", color: "#4ade80" },
  { min: 1300, label: "Intermediate", color: "#facc15" },
  { min: 0, label: "Novice", color: "#9ca3ae" },
];

function tierFor(rating) {
  if (rating === null || rating === undefined) return TIERS[TIERS.length - 1];
  return TIERS.find((t) => rating >= t.min) ?? TIERS[TIERS.length - 1];
}

onMounted(() => {
  auth.onAuthStateChanged(async (u) => {
    user.value = u;
    player.value = null;
    playerId.value = null;
    ratingHistory.value = [];
    playerRank.value = null;
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
        const [historySnap, tournamentSnaps, playersSnap] = await Promise.all([
          getDocs(
            query(
              collection(db, "players", playerId.value, "ratingHistory"),
              orderBy("recordedAt", "asc"),
            ),
          ),
          getDocs(collection(db, "tournaments")),
          getDocs(collection(db, "players")),
        ]);

        const tournamentDateById = {};
        tournamentSnaps.docs.forEach((d) => {
          tournamentDateById[d.id] = d.data().date;
        });

        ratingHistory.value = historySnap.docs.map((d) => {
          const data = d.data();
          const tournamentId = data.tournamentId ?? d.id;
          // Prefer the tournament's own date, re-parsed with the
          // day-first-aware rule in dates.js, over the frozen `recordedAt`
          // snapshot — entries recorded before that rule existed have the
          // wrong instant baked into recordedAt, and re-deriving from the
          // source date self-heals the display without needing ratings to
          // be recomputed.
          const date =
            toJsDate(tournamentDateById[tournamentId]) ??
            toJsDate(data.recordedAt);
          return {
            id: d.id,
            rating: data.rating,
            previousRating: data.previousRating ?? null,
            delta: typeof data.delta === "number" ? data.delta : null,
            date,
            tournamentId,
            tournamentName: data.tournamentName || null,
          };
        });

        const allPlayers = playersSnap.docs.map((pd) => ({
          id: pd.id,
          ...pd.data(),
        }));
        const idx = rankPlayers(allPlayers).findIndex(
          (p) => p.id === playerId.value,
        );
        playerRank.value = idx === -1 ? null : idx + 1;
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
const displayPhotoUrl = computed(
  () => player.value?.profilePhotoUrl || registrationPhotoUrl.value,
);

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

// Only worth calling out on the profile card when it's actually a
// leaderboard-worthy rank — anything past top 3 is just noise here (the
// full leaderboard is what Standings is for).
const rankBadge = computed(() =>
  playerRank.value !== null && playerRank.value <= 3
    ? `#${playerRank.value}`
    : null,
);

const peakRating = computed(() => {
  if (ratingHistory.value.length === 0) return currentRating.value;
  return Math.max(
    ...ratingHistory.value.map((h) => h.rating),
    currentRating.value ?? 0,
  );
});

const tournamentsPlayed = computed(() => ratingHistory.value.length);

// The change from the most recent tournament. Prefers the delta recorded
// with the entry so a player's very first tournament still shows one.
const ratingDelta = computed(() => {
  const history = ratingHistory.value;
  if (history.length === 0) return null;
  const last = history[history.length - 1];
  if (typeof last.delta === "number") return last.delta;
  if (history.length < 2) return null;
  return last.rating - history[history.length - 2].rating;
});

// Newest first for the list under the chart.
const recentTournaments = computed(() => [...ratingHistory.value].reverse());

// --- Chart geometry (plain SVG, no chart library needed) ---
const CHART_W = 560;
const CHART_H = 180;
const PAD = { top: 16, right: 14, bottom: 28, left: 42 };
const plotW = CHART_W - PAD.left - PAD.right;
const plotH = CHART_H - PAD.top - PAD.bottom;

// The chart's own data series: the recorded history, plus a synthetic
// leading point for the rating the player carried in *before* their first
// tournament (every entry's own previousRating is otherwise redundant —
// it's just the prior entry's rating — except for the very first one,
// which is the only place that starting point exists).
const chartSeries = computed(() => {
  const history = ratingHistory.value;
  if (history.length === 0) return [];
  const first = history[0];
  if (typeof first.previousRating !== "number") return history;
  return [
    {
      id: "start",
      rating: first.previousRating,
      date: null,
      isStart: true,
    },
    ...history,
  ];
});

const chartRange = computed(() => {
  const ratings = chartSeries.value.map((h) => h.rating);
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
  const series = chartSeries.value;
  const n = series.length;
  const { min, max } = chartRange.value;
  return series.map((h, i) => {
    const x = n <= 1 ? PAD.left + plotW / 2 : PAD.left + (i / (n - 1)) * plotW;
    const y = PAD.top + plotH - ((h.rating - min) / (max - min || 1)) * plotH;
    return { ...h, x, y };
  });
});

const linePath = computed(() => {
  if (chartPoints.value.length < 2) return "";
  return chartPoints.value
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(" ");
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
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// --- Profile photo upload ---
const photoInput = ref(null);
const uploadingPhoto = ref(false);
const photoError = ref("");

function pickPhoto() {
  photoInput.value?.click();
}

async function onPhotoSelected(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file || !playerId.value) return;

  uploadingPhoto.value = true;
  photoError.value = "";
  try {
    const url = await uploadPlayerPhoto(file, playerId.value);
    // Reflect immediately rather than waiting on a reload.
    player.value = { ...player.value, profilePhotoUrl: url };
  } catch (e) {
    photoError.value = e.message || "Unable to upload photo.";
  } finally {
    uploadingPhoto.value = false;
  }
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
            <div class="photo-wrap">
              <img
                v-if="displayPhotoUrl"
                :src="displayPhotoUrl"
                alt="profile"
                class="profile-photo"
              />
              <div v-else class="profile-placeholder">No photo</div>

              <button
                v-if="isVerified"
                type="button"
                class="photo-edit-btn"
                :disabled="uploadingPhoto"
                @click="pickPhoto"
              >
                {{ uploadingPhoto ? "Uploading…" : "Edit" }}
              </button>
              <input
                ref="photoInput"
                type="file"
                accept="image/*"
                class="photo-input-native"
                @change="onPhotoSelected"
              />
            </div>

            <div class="hero-meta">
              <div class="name-row">
                <p class="name">{{ player?.fullName || user.email }}</p>
                <span
                  class="status-badge"
                  :class="isVerified ? 'verified' : 'unverified'"
                >
                  {{ isVerified ? "Verified" : "Unverified" }}
                </span>
              </div>
              <p class="email" v-if="player?.fullName">{{ user.email }}</p>
              <p v-if="photoError" class="photo-error">{{ photoError }}</p>
            </div>
          </div>

          <div v-if="!isVerified" class="status-notice">
            {{ statusMessage }}
          </div>

          <template v-else>
            <div class="rating-block">
              <span class="rating-kicker">Current Rating</span>
              <div class="rating-row">
                <span class="rating-number">{{
                  currentRating !== null ? currentRating.toLocaleString() : "—"
                }}</span>
                <span
                  v-if="ratingDelta !== null"
                  class="rating-delta"
                  :class="ratingDelta >= 0 ? 'up' : 'down'"
                >
                  {{ ratingDelta >= 0 ? "▲" : "▼" }} {{ Math.abs(ratingDelta) }}
                </span>
              </div>
              <span
                class="tier-badge"
                :style="{
                  color: currentTier.color,
                  borderColor: currentTier.color,
                }"
              >
                {{ currentTier.label }}
              </span>
            </div>

            <div class="stats-row">
              <div class="stat-box">
                <span class="stat-value">{{
                  peakRating !== null ? peakRating.toLocaleString() : "—"
                }}</span>
                <span class="stat-label">Peak Rating</span>
              </div>
              <div class="stat-box">
                <span class="stat-value">{{ tournamentsPlayed }}</span>
                <span class="stat-label">Tournaments</span>
              </div>
              <div class="stat-box">
                <span class="stat-value points-value">
                  {{ (player?.totalPoints ?? 0).toLocaleString() }}
                  <span v-if="rankBadge" class="rank-badge">{{
                    rankBadge
                  }}</span>
                </span>
                <span class="stat-label">Points</span>
              </div>
            </div>
          </template>
        </div>

        <div v-if="isVerified" class="card">
          <h2 class="section-title">Rating History</h2>

          <div v-if="loadingHistory" class="placeholder-text">Loading…</div>

          <div v-else-if="ratingHistory.length === 0" class="placeholder-text">
            No tournaments recorded yet — your rating history will appear here
            after your first confirmed tournament.
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

              <text
                :x="PAD.left - 8"
                :y="PAD.top + 4"
                class="axis-label"
                text-anchor="end"
              >
                {{ Math.round(chartRange.max) }}
              </text>
              <text
                :x="PAD.left - 8"
                :y="PAD.top + plotH + 4"
                class="axis-label"
                text-anchor="end"
              >
                {{ Math.round(chartRange.min) }}
              </text>

              <path
                v-if="areaPath"
                :d="areaPath"
                fill="url(#ratingFill)"
                stroke="none"
              />
              <path
                v-if="linePath"
                :d="linePath"
                fill="none"
                stroke="#e0551f"
                stroke-width="2.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              />

              <circle
                v-for="p in chartPoints"
                :key="p.id"
                :cx="p.x"
                :cy="p.y"
                :r="p.isStart ? 3 : 4"
                :fill="p.isStart ? '#6f747c' : '#e0551f'"
                stroke="#111214"
                stroke-width="2"
              >
                <title>
                  {{ p.isStart ? "Starting rating" : formatFull(p.date) }} —
                  {{ p.rating }}
                </title>
              </circle>

              <text
                :x="chartPoints[0]?.x"
                :y="CHART_H - 6"
                class="axis-label"
                text-anchor="start"
              >
                {{
                  chartPoints[0]?.isStart
                    ? "Start"
                    : formatMonthYear(chartPoints[0]?.date)
                }}
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

          <ul v-if="ratingHistory.length > 0" class="history-list">
            <li v-for="entry in recentTournaments" :key="entry.id">
              <span class="history-name">{{
                entry.tournamentName || "Tournament"
              }}</span>
              <span class="history-date">{{ formatFull(entry.date) }}</span>
              <span
                v-if="entry.delta !== null"
                class="history-delta"
                :class="entry.delta >= 0 ? 'up' : 'down'"
              >
                {{ entry.delta >= 0 ? "+" : "−" }}{{ Math.abs(entry.delta) }}
              </span>
              <span class="history-rating">{{ entry.rating }}</span>
            </li>
          </ul>
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

.photo-wrap {
  position: relative;
  flex-shrink: 0;
}

.profile-photo {
  width: 84px;
  height: 84px;
  object-fit: cover;
  border-radius: 10px;
  border: 1px solid #2a2b2f;
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
  text-align: center;
}

.photo-edit-btn {
  position: absolute;
  bottom: -0.5rem;
  right: -0.5rem;
  background: #e0551f;
  color: #fff;
  border: 2px solid #111214;
  border-radius: 999px;
  padding: 0.25rem 0.6rem;
  font-size: 0.7rem;
  font-weight: 700;
  cursor: pointer;
  transition: background 0.15s ease;
}

.photo-edit-btn:hover:not(:disabled) {
  background: #ef632c;
}

.photo-edit-btn:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.photo-input-native {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}

.photo-error {
  margin: 0.3rem 0 0;
  color: #f08383;
  font-size: 0.8rem;
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

.points-value {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}

.rank-badge {
  background: linear-gradient(135deg, #ffb37a 0%, #e0551f 60%, #c93f10 100%);
  color: #fff;
  border-radius: 999px;
  padding: 0.1rem 0.5rem;
  font-size: 0.7rem;
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

/* Tournament-by-tournament breakdown under the chart */
.history-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
}

.history-list li {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
  padding: 0.6rem 0;
  border-top: 1px solid #2a2b2f;
  font-size: 0.875rem;
}

.history-name {
  color: #e5e6e8;
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-date {
  color: #6f747c;
  font-size: 0.8rem;
  flex: 1;
  white-space: nowrap;
}

.history-delta {
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.history-delta.up {
  color: #4ade80;
}

.history-delta.down {
  color: #f08383;
}

.history-rating {
  color: #f5f5f5;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  min-width: 3ch;
  text-align: right;
}
</style>
