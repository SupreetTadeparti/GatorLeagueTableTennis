<script setup>
import { ref, computed, onMounted } from "vue";
import { doc, updateDoc } from "firebase/firestore";
import { auth, db } from "../firebase";
import { isUserAdminByEmail } from "../firebaseHelpers";
import {
  fetchArchivedTournaments,
  loadArchivedTournament,
} from "../archiveData";
import { formatDate } from "../dates";

const loading = ref(true);
const loadError = ref("");
const tournaments = ref([]);

const selectedId = ref(null);
const loadingDetail = ref(false);
const detail = ref(null);
const detailTab = ref("groups");

const isAdmin = ref(false);
const reopeningTournament = ref(false);
const reopenError = ref("");

async function loadAdminStatus() {
  const user = auth.currentUser;
  isAdmin.value = user ? await isUserAdminByEmail(user.email) : false;
}

function winnerLabel(t) {
  return t.winnerTeamName || t.winnerPlayerName || null;
}

async function loadList() {
  loading.value = true;
  loadError.value = "";
  try {
    tournaments.value = await fetchArchivedTournaments();
  } catch (e) {
    console.error("loadList", e);
    loadError.value = "Unable to load the archive right now.";
  } finally {
    loading.value = false;
  }
}

async function openTournament(tournamentId) {
  selectedId.value = tournamentId;
  detailTab.value = "groups";
  loadingDetail.value = true;
  detail.value = null;
  try {
    detail.value = await loadArchivedTournament(tournamentId);
  } catch (e) {
    console.error("openTournament", e);
  } finally {
    loadingDetail.value = false;
  }
}

function closeTournament() {
  selectedId.value = null;
  detail.value = null;
}

// Archived tournaments are read-only here on purpose (see TournamentDraw
// styling below) — draw locking, finish/reopen, and ratings all live on
// the live tournament page. Reopening hands a tournament back to that
// page (it becomes the "active" one again, per TournamentView's own
// active-tournament query) so an admin can use Unlock Draw, fix results,
// then Finish it again to re-archive.
async function reopenFromArchive(tournamentId) {
  if (!isAdmin.value) return;
  const confirmed = window.confirm(
    "Reopen this tournament? It will leave the archive and become the active tournament on the Tournament page, where you can unlock the draw or fix results. Finish it again from there when you're done.",
  );
  if (!confirmed) return;

  reopeningTournament.value = true;
  reopenError.value = "";
  try {
    await updateDoc(doc(db, "tournaments", tournamentId), {
      finishedAt: null,
      status: "active",
    });
    tournaments.value = tournaments.value.filter((t) => t.id !== tournamentId);
    closeTournament();
  } catch (e) {
    reopenError.value = e.message || "Unable to reopen this tournament.";
  } finally {
    reopeningTournament.value = false;
  }
}

function matchScore(match, playerNumber) {
  const v = playerNumber === 1 ? match.player1Score : match.player2Score;
  return typeof v === "number" ? v : "";
}

function isReported(match) {
  return (
    typeof match.player1Score === "number" &&
    typeof match.player2Score === "number"
  );
}

const expandedGroups = ref({});
function isGroupExpanded(groupId) {
  if (groupId in expandedGroups.value) return !!expandedGroups.value[groupId];
  return detail.value?.groups?.[0]?.id === groupId;
}
function toggleGroup(groupId) {
  expandedGroups.value[groupId] = !isGroupExpanded(groupId);
}

const isDoubles = computed(
  () => detail.value?.tournament?.format === "doubles",
);

onMounted(() => {
  loadList();
  loadAdminStatus();
  auth.onAuthStateChanged(loadAdminStatus);
});
</script>

<template>
  <div class="page">
    <div class="wrap">
      <!-- List view -->
      <template v-if="!selectedId">
        <h1>Archive</h1>
        <p class="subtitle">Past tournaments, groups, and brackets.</p>

        <div v-if="loading" class="empty-state">Loading…</div>
        <p v-if="loadError" class="error-text">{{ loadError }}</p>

        <div
          v-if="!loading && !loadError && tournaments.length === 0"
          class="empty-state"
        >
          No finished tournaments yet — they'll show up here once one wraps up.
        </div>

        <div class="archive-list">
          <button
            v-for="t in tournaments"
            :key="t.id"
            type="button"
            class="archive-card"
            @click="openTournament(t.id)"
          >
            <img
              v-if="t.winnerPhotoUrl"
              :src="t.winnerPhotoUrl"
              alt=""
              class="archive-thumb"
            />
            <div v-else class="archive-thumb archive-thumb-placeholder">🏆</div>

            <div class="archive-info">
              <span class="archive-name">{{ t.name || t.id }}</span>
              <span class="archive-meta">
                {{ formatDate(t.date) }}
                <span v-if="t.format === 'doubles'" class="format-pill"
                  >Doubles</span
                >
              </span>
              <span v-if="winnerLabel(t)" class="archive-winner"
                >🏆 {{ winnerLabel(t) }}</span
              >
            </div>
          </button>
        </div>
      </template>

      <!-- Detail view -->
      <template v-else>
        <button type="button" class="back-link" @click="closeTournament">
          ← Back to Archive
        </button>

        <div v-if="loadingDetail" class="empty-state">Loading…</div>

        <template v-else-if="detail">
          <div class="detail-header">
            <h1>{{ detail.tournament.name || detail.tournament.id }}</h1>
            <p class="date">{{ formatDate(detail.tournament.date) }}</p>
            <p class="player-count">
              {{ detail.participantCount }}
              {{ isDoubles ? "Teams" : "Players" }}
            </p>
            <p v-if="winnerLabel(detail.tournament)" class="winner-line">
              🏆 {{ winnerLabel(detail.tournament) }}
            </p>

            <div v-if="isAdmin" class="admin-actions">
              <button
                type="button"
                class="reopen-btn"
                :disabled="reopeningTournament"
                @click="reopenFromArchive(detail.tournament.id)"
              >
                {{ reopeningTournament ? "Reopening…" : "Reopen Tournament" }}
              </button>
              <p v-if="reopenError" class="error-text">{{ reopenError }}</p>
            </div>
          </div>

          <div class="tabs">
            <button
              :class="{ active: detailTab === 'groups' }"
              @click="detailTab = 'groups'"
            >
              Group Stage
            </button>
            <button
              :class="{ active: detailTab === 'bracket' }"
              @click="detailTab = 'bracket'"
            >
              Elimination Bracket
            </button>
          </div>

          <div v-if="detailTab === 'groups'" class="tab-content">
            <div class="groups-container">
              <div
                v-for="group in detail.groups"
                :key="group.id"
                class="group-card"
              >
                <button
                  type="button"
                  class="group-header"
                  @click="toggleGroup(group.id)"
                >
                  <span class="group-header-left">
                    <span
                      class="chevron"
                      :class="{ expanded: isGroupExpanded(group.id) }"
                      >▸</span
                    >
                    <span class="group-title">Group {{ group.id }}</span>
                    <span class="group-subtitle"
                      >{{ group.players.length }}
                      {{ isDoubles ? "teams" : "players" }}</span
                    >
                  </span>
                </button>

                <div v-show="isGroupExpanded(group.id)" class="group-body">
                  <ul class="group-players">
                    <li v-for="p in group.players" :key="p.id">
                      <span class="player-name">
                        {{ p.fullName }}
                        <span v-if="p.advanced" class="advanced-badge"
                          >Advanced</span
                        >
                      </span>
                      <span class="standing">{{ p.wins }}-{{ p.losses }}</span>
                      <span class="rating">{{
                        typeof p.currentRating === "number"
                          ? Math.round(p.currentRating)
                          : "—"
                      }}</span>
                    </li>
                  </ul>

                  <div class="group-matches">
                    <div
                      v-for="m in group.matches"
                      :key="m.id"
                      class="match-row"
                    >
                      <div v-if="isReported(m)" class="match-result">
                        <span class="result-players">
                          <span
                            class="result-name"
                            :class="{
                              winner: matchScore(m, 1) > matchScore(m, 2),
                            }"
                            >{{ m.player1?.fullName }}</span
                          >
                          <span class="result-score"
                            >{{ matchScore(m, 1) }} –
                            {{ matchScore(m, 2) }}</span
                          >
                          <span
                            class="result-name"
                            :class="{
                              winner: matchScore(m, 2) > matchScore(m, 1),
                            }"
                            >{{ m.player2?.fullName }}</span
                          >
                        </span>
                      </div>
                      <div v-else class="match-pending">
                        <span class="pending-players"
                          >{{ m.player1?.fullName }} vs
                          {{ m.player2?.fullName }}</span
                        >
                        <span class="pending-label">No result recorded</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div v-else class="tab-content">
            <div class="bracket-container">
              <div
                v-for="(round, idx) in detail.bracket"
                :key="idx"
                class="bracket-round"
              >
                <h3>{{ round.name }}</h3>
                <div class="matches">
                  <div
                    v-for="m in round.matches"
                    :key="m.id"
                    class="match-row bracket-match-row"
                  >
                    <div v-if="!m.player1 || !m.player2" class="matchup">
                      <div class="player">
                        {{ m.player1?.fullName || "TBD" }}
                      </div>
                      <div class="vs">vs</div>
                      <div class="player">
                        {{ m.player2?.fullName || "TBD" }}
                      </div>
                    </div>
                    <div v-else-if="isReported(m)" class="match-result">
                      <span class="result-players">
                        <span
                          class="result-name"
                          :class="{
                            winner: matchScore(m, 1) > matchScore(m, 2),
                          }"
                          >{{ m.player1.fullName }}</span
                        >
                        <span class="result-score"
                          >{{ matchScore(m, 1) }} – {{ matchScore(m, 2) }}</span
                        >
                        <span
                          class="result-name"
                          :class="{
                            winner: matchScore(m, 2) > matchScore(m, 1),
                          }"
                          >{{ m.player2.fullName }}</span
                        >
                      </span>
                    </div>
                    <div v-else class="match-pending">
                      <span class="pending-players"
                        >{{ m.player1.fullName }} vs
                        {{ m.player2.fullName }}</span
                      >
                      <span class="pending-label">No result recorded</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </template>
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
  max-width: 900px;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
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

/* List */
.archive-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.archive-card {
  display: flex;
  align-items: center;
  gap: 1rem;
  background: #111214;
  border: 1px solid #2a2b2f;
  border-radius: 10px;
  padding: 0.9rem 1.1rem;
  cursor: pointer;
  text-align: left;
  color: inherit;
  font: inherit;
  transition:
    border-color 0.15s ease,
    background 0.15s ease;
}

.archive-card:hover {
  border-color: #e0551f;
  background: #15161a;
}

.archive-thumb {
  width: 56px;
  height: 56px;
  object-fit: cover;
  border-radius: 8px;
  flex-shrink: 0;
}

.archive-thumb-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  background: #1c1d20;
  font-size: 1.4rem;
}

.archive-info {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
}

.archive-name {
  color: #f5f5f5;
  font-weight: 700;
  font-size: 1rem;
}

.archive-meta {
  color: #9ca3ae;
  font-size: 0.85rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.format-pill {
  font-size: 0.65rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  color: #ff8a4c;
  border: 1px solid rgba(224, 85, 31, 0.4);
  background: rgba(224, 85, 31, 0.1);
  border-radius: 999px;
  padding: 0.1rem 0.5rem;
}

.archive-winner {
  color: #facc15;
  font-size: 0.85rem;
  font-weight: 600;
}

/* Detail */
.back-link {
  align-self: flex-start;
  background: transparent;
  border: none;
  color: #9ca3ae;
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
  padding: 0.4rem 0;
}

.back-link:hover {
  color: #e0551f;
}

.detail-header {
  text-align: center;
}

.detail-header .date {
  color: #b8b8b8;
  margin: 0.25rem 0;
}

.detail-header .player-count {
  color: hsl(var(--primary-color));
  font-weight: 600;
  margin: 0;
}

.winner-line {
  color: #facc15;
  font-weight: 600;
  margin-top: 0.5rem;
}

.admin-actions {
  margin-top: 1rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
}

.reopen-btn {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: #d8d8d8;
  border-radius: 6px;
  padding: 0.5rem 1rem;
  font-size: 0.8rem;
  font-weight: 700;
  cursor: pointer;
  transition: opacity 0.15s ease;
}

.reopen-btn:hover:not(:disabled) {
  opacity: 0.85;
  border-color: #e0551f;
  color: #ff8a4c;
}

.reopen-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.tabs {
  display: flex;
  gap: 0.5rem;
  justify-content: center;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  padding-bottom: 1rem;
}

.tabs button {
  background: transparent;
  border: none;
  color: #a8a8a8;
  font-weight: 600;
  padding: 0.6rem 1.2rem;
  cursor: pointer;
}

.tabs button.active {
  color: hsl(var(--primary-color));
}

.tab-content {
  padding-top: 1rem;
}

/* Groups (mirrors TournamentView's read-only styling) */
.groups-container {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 1rem;
  align-items: start;
}

.group-card {
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  overflow: hidden;
}

.group-header {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 0.6rem;
  background: transparent;
  border: none;
  padding: 1rem 1.2rem;
  cursor: pointer;
  text-align: left;
  color: inherit;
  font: inherit;
}

.group-header-left {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
  min-width: 0;
}

.chevron {
  display: inline-block;
  color: hsl(var(--primary-color));
  font-size: 0.85rem;
  transition: transform 0.15s ease;
}

.chevron.expanded {
  transform: rotate(90deg);
}

.group-title {
  color: hsl(var(--primary-color));
  font-size: 1.1rem;
  font-weight: 700;
}

.group-subtitle {
  color: #888;
  font-size: 0.8rem;
}

.group-body {
  padding: 0 1.2rem 1.2rem;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}

.group-players {
  list-style: none;
  padding: 0;
  margin: 1rem 0;
}

.group-players li {
  display: flex;
  justify-content: space-between;
  padding: 0.5rem 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  font-size: 0.9rem;
}

.group-players li:last-child {
  border-bottom: none;
}

.player-name {
  color: #e8e8e8;
  flex: 1;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.advanced-badge {
  flex-shrink: 0;
  font-size: 0.65rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  color: #6be0a3;
  background: rgba(107, 224, 163, 0.12);
  border: 1px solid rgba(107, 224, 163, 0.3);
  border-radius: 999px;
  padding: 0.1rem 0.5rem;
}

.standing {
  color: #777;
  font-size: 0.8rem;
  font-variant-numeric: tabular-nums;
  margin-left: 0.5rem;
  flex-shrink: 0;
}

.rating {
  color: #999;
  margin-left: 0.5rem;
  font-weight: 600;
}

.match-row {
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
  margin-bottom: 0.6rem;
  overflow: hidden;
}

.match-row:last-child {
  margin-bottom: 0;
}

.match-result {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.7rem 0.9rem;
  background: rgba(255, 255, 255, 0.015);
  flex-wrap: wrap;
}

.result-players {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  font-size: 0.85rem;
  color: #ccc;
  flex-wrap: wrap;
}

.result-name.winner {
  color: #f4f7fb;
  font-weight: 700;
}

.result-score {
  color: hsl(var(--primary-color));
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.match-pending {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.7rem 0.9rem;
  background: rgba(255, 255, 255, 0.015);
}

.pending-players {
  color: #999;
  font-size: 0.85rem;
}

.pending-label {
  flex-shrink: 0;
  font-size: 0.7rem;
  font-weight: 600;
  color: #777;
  text-transform: uppercase;
  letter-spacing: 0.4px;
}

/* Bracket */
.bracket-container {
  display: flex;
  gap: 2rem;
  overflow-x: auto;
  padding: 1rem 0;
}

.bracket-round {
  flex-shrink: 0;
  min-width: 260px;
}

.bracket-round h3 {
  font-size: 0.9rem;
  color: #999;
  margin-bottom: 1rem;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.matches {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.bracket-match-row {
  background: rgba(255, 255, 255, 0.02);
  min-height: 70px;
}

.matchup {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.75rem 0.9rem;
}

.player {
  padding: 0.3rem 0;
  color: #d8d8d8;
  font-size: 0.85rem;
  word-break: break-word;
}

.player:first-child {
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  padding-bottom: 0.3rem;
}

.vs {
  text-align: center;
  color: #666;
  font-size: 0.7rem;
  padding: 0.2rem 0;
}
</style>
