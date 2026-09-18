<script setup>
import { ref, onMounted, computed, watch } from "vue";
import { db } from "../firebase";
import {
  addDoc,
  collection,
  query,
  where,
  getDocs,
  updateDoc,
  doc,
  setDoc,
  deleteDoc,
  serverTimestamp,
} from "firebase/firestore";
import { uploadWinnerPhoto } from "../firebaseHelpers";
import { createPlayerFromRegistration } from "../firebaseHelpers";
import {
  applyAvailability,
  applyTournamentRatings,
  revertAvailability,
  revertTournamentRatings,
  sortTournamentsChronologically,
  toJsDate,
} from "../ratings";
import { applyTournamentPoints } from "../points";

// tabs: pending registrations + admin management + placeholders for future
const tabs = [
  { id: "pending", label: "Pending Registrations" },
  { id: "admins", label: "Manage Admins" },
  { id: "tournament", label: "Tournament Management" },
  { id: "ratings", label: "Tournament Ratings" },
  { id: "awards", label: "Season Awards" },
  { id: "players", label: "Player Management" },
];

const active = ref("pending");

// pending registrations state
const pending = ref([]);
const loadingPending = ref(false);

async function loadPending() {
  loadingPending.value = true;
  const q = query(
    collection(db, "registrations"),
    where("registrationStatus", "==", "pending"),
  );
  const snaps = await getDocs(q);
  pending.value = snaps.docs.map((d) => ({ id: d.id, ...d.data() }));
  loadingPending.value = false;
}

async function approve(regId) {
  try {
    await createPlayerFromRegistration(regId);
    pending.value = pending.value.filter((p) => p.id !== regId);
  } catch (e) {
    console.error(e);
  }
}

async function reject(regId) {
  try {
    await updateDoc(doc(db, "registrations", regId), {
      registrationStatus: "rejected",
    });
    pending.value = pending.value.filter((p) => p.id !== regId);
  } catch (e) {
    console.error(e);
  }
}

// admins management state
const admins = ref([]);
const loadingAdmins = ref(false);
const newAdminEmail = ref("");

async function loadAdmins() {
  loadingAdmins.value = true;
  const snaps = await getDocs(collection(db, "admins"));
  admins.value = snaps.docs.map((d) => d.id);
  loadingAdmins.value = false;
}

async function addAdmin() {
  const raw = (newAdminEmail.value || "").trim().toLowerCase();
  if (!raw) return;
  try {
    await setDoc(doc(db, "admins", raw), { createdAt: serverTimestamp() });
    newAdminEmail.value = "";
    await loadAdmins();
  } catch (e) {
    console.error(e);
  }
}

async function removeAdmin(email) {
  try {
    await deleteDoc(doc(db, "admins", email));
    await loadAdmins();
  } catch (e) {
    console.error(e);
  }
}

onMounted(() => {
  loadPending();
  loadAdmins();
  loadTournaments();
  loadPlayers();
});

// tournaments state for tournament management
const tournaments = ref([]);
const loadingTournaments = ref(false);
const selectedTournament = ref("");
const selectedFile = ref(null);
const winnerUploading = ref(false);
const liveUrl = ref("");
const isLive = ref(false);
const savingLive = ref(false);

async function loadTournaments() {
  loadingTournaments.value = true;
  try {
    const snaps = await getDocs(collection(db, "tournaments"));
    tournaments.value = snaps.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.error("loadTournaments", e);
  } finally {
    loadingTournaments.value = false;
  }
}

// New tournament creation. Weeks alternate singles/doubles by whatever
// format is picked here — the rest of the app (draw, ratings) branches on
// this field.
const newTournamentName = ref("");
const newTournamentDate = ref("");
const newTournamentFormat = ref("singles");
const creatingTournament = ref(false);

async function createTournament() {
  if (!newTournamentDate.value) {
    alert("Pick a date for the new tournament.");
    return;
  }
  creatingTournament.value = true;
  try {
    const docRef = await addDoc(collection(db, "tournaments"), {
      name: newTournamentName.value || null,
      date: newTournamentDate.value,
      format: newTournamentFormat.value,
      status: "active",
      startedAt: null,
      finishedAt: null,
      ratingsAppliedAt: null,
      winnerPhotoUrl: null,
      seasonId: null,
      createdAt: serverTimestamp(),
    });
    newTournamentName.value = "";
    newTournamentDate.value = "";
    newTournamentFormat.value = "singles";
    await loadTournaments();
    selectedTournament.value = docRef.id;
    alert("Tournament created.");
  } catch (e) {
    console.error(e);
    alert("Create failed: " + (e.message || e));
  } finally {
    creatingTournament.value = false;
  }
}

const selectedTournamentFormat = ref("singles");
const savingFormat = ref(false);

// Keep the format editor in sync with whichever tournament is selected.
watch(selectedTournament, (id) => {
  const t = tournaments.value.find((tt) => tt.id === id);
  selectedTournamentFormat.value = t?.format || "singles";
});

async function saveFormat() {
  if (!selectedTournament.value) return;
  savingFormat.value = true;
  try {
    await updateDoc(doc(db, "tournaments", selectedTournament.value), {
      format: selectedTournamentFormat.value,
    });
    await loadTournaments();
    alert("Format saved.");
  } catch (e) {
    console.error(e);
    alert("Save failed: " + (e.message || e));
  } finally {
    savingFormat.value = false;
  }
}

function onFileChange(e) {
  selectedFile.value = e.target.files?.[0] ?? null;
}

async function uploadWinner() {
  if (!selectedTournament.value || !selectedFile.value) return;
  winnerUploading.value = true;
  try {
    await uploadWinnerPhoto(selectedFile.value, selectedTournament.value);
    await loadTournaments();
    selectedFile.value = null;
    alert("Winner photo uploaded successfully.");
  } catch (e) {
    console.error(e);
    alert("Upload failed: " + (e.message || e));
  } finally {
    winnerUploading.value = false;
  }
}

async function saveLiveLink() {
  if (!selectedTournament.value) return;
  savingLive.value = true;
  try {
    await updateDoc(doc(db, "tournaments", selectedTournament.value), {
      liveUrl: liveUrl.value || null,
      isLive: !!isLive.value,
      liveUpdatedAt: serverTimestamp(),
    });
    await loadTournaments();
    alert("Livestream settings saved.");
  } catch (e) {
    console.error(e);
    alert("Save failed: " + (e.message || e));
  } finally {
    savingLive.value = false;
  }
}

// ---------------------------------------------------------------------
// Tournament Ratings: revert or recompute any tournament's rating
// changes. All the logic — rating math, Firestore writes, and the
// ordering rule that keeps starting ratings correct — lives in
// src/ratings.js, shared with TournamentView.vue.
// ---------------------------------------------------------------------

function formatTournamentDate(value) {
  const d = toJsDate(value);
  if (!d) return "No date set";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// Newest tournament first, so "revert the last 3" reads top-to-bottom.
const ratingTournaments = computed(() =>
  sortTournamentsChronologically(tournaments.value).reverse(),
);

// Whether each action is legal right now, and why not when it isn't.
// Ratings must be applied oldest-first and reverted newest-first: that's
// what guarantees a player's current rating is always the rating they
// carry into the next unrated tournament. Recomputing out of order is how
// tournaments after a reverted one ended up with stale starting ratings.
function revertCheck(tournament) {
  return revertAvailability(tournament, tournaments.value);
}

function applyCheck(tournament) {
  return applyAvailability(tournament, tournaments.value);
}

// Per-tournament busy/error state, keyed by tournament ID.
const ratingActionState = ref({});

function ratingState(tournamentId) {
  return ratingActionState.value[tournamentId] || {};
}

function setRatingActionState(tournamentId, patch) {
  ratingActionState.value = {
    ...ratingActionState.value,
    [tournamentId]: {
      ...(ratingActionState.value[tournamentId] || {}),
      ...patch,
    },
  };
}

// Applies this tournament's rating changes from its submitted matches.
// Only offered when this tournament is next in line chronologically, so
// every player's starting rating is their post-previous-tournament
// rating — including right after a revert, which is the case that used to
// go wrong.
async function recomputeTournamentRatings(tournament) {
  const tournamentId = tournament.id;
  const label = tournament.name || tournamentId;

  const availability = applyCheck(tournament);
  if (!availability.allowed) {
    setRatingActionState(tournamentId, { error: availability.reason });
    return;
  }

  const confirmed = window.confirm(
    `Apply ratings for "${label}" from its submitted matches? Each participant's current rating is used as their starting rating, and the result is written to their rating history.`,
  );
  if (!confirmed) return;

  setRatingActionState(tournamentId, { recomputing: true, error: "" });
  try {
    await applyTournamentRatings(tournamentId);
    await loadTournaments();
    await loadPlayers();
  } catch (e) {
    setRatingActionState(tournamentId, {
      error: e.message || "Unable to apply ratings for this tournament.",
    });
  } finally {
    setRatingActionState(tournamentId, { recomputing: false });
  }
}

// Restores every player touched by this tournament back to the rating
// they held before it. Only offered when no later tournament still has
// ratings applied, so ratings always come off newest to oldest.
async function revertRatingsFor(tournament) {
  const tournamentId = tournament.id;
  const label = tournament.name || tournamentId;

  const availability = revertCheck(tournament);
  if (!availability.allowed) {
    setRatingActionState(tournamentId, { error: availability.reason });
    return;
  }

  const confirmed = window.confirm(
    `Revert rating changes from "${label}"? Every affected player's rating goes back to what it was before this tournament, and it drops off their rating history.`,
  );
  if (!confirmed) return;

  setRatingActionState(tournamentId, { reverting: true, error: "" });
  try {
    await revertTournamentRatings(tournamentId);
    await loadTournaments();
    await loadPlayers();
  } catch (e) {
    setRatingActionState(tournamentId, {
      error: e.message || "Unable to revert ratings for this tournament.",
    });
  } finally {
    setRatingActionState(tournamentId, { reverting: false });
  }
}

// Points have no ordering rule like ratings do -- each tournament's
// contribution is tracked independently (see src/points.js), so the only
// requirement is that the tournament is finished.
function pointsCheck(tournament) {
  if (!tournament.finishedAt) {
    return {
      allowed: false,
      reason: "Finish this tournament before applying points.",
    };
  }
  return { allowed: true, reason: "" };
}

async function applyPointsFor(tournament) {
  const tournamentId = tournament.id;
  const label = tournament.name || tournamentId;

  const availability = pointsCheck(tournament);
  if (!availability.allowed) {
    setRatingActionState(tournamentId, { pointsError: availability.reason });
    return;
  }

  const confirmed = window.confirm(
    `Apply points for "${label}" from its submitted matches? This adds to (or, if it's been applied before, corrects) each participant's season total. There's no revert button for points — fix a player's total directly in Player Management if you need to undo it.`,
  );
  if (!confirmed) return;

  setRatingActionState(tournamentId, { applyingPoints: true, pointsError: "" });
  try {
    await applyTournamentPoints(tournamentId);
    await loadTournaments();
    await loadPlayers();
  } catch (e) {
    setRatingActionState(tournamentId, {
      pointsError: e.message || "Unable to apply points for this tournament.",
    });
  } finally {
    setRatingActionState(tournamentId, { applyingPoints: false });
  }
}

// player management state
const players = ref([]);
const loadingPlayers = ref(false);
const playerSearch = ref("");
const editingPlayerId = ref(null);
const editForm = ref({
  fullName: "",
  email: "",
  currentRating: 0,
  totalPoints: 0,
});
const savingPlayer = ref(false);

async function loadPlayers() {
  loadingPlayers.value = true;
  try {
    const snaps = await getDocs(collection(db, "players"));
    players.value = snaps.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.error("loadPlayers", e);
  } finally {
    loadingPlayers.value = false;
  }
}

const filteredPlayers = computed(() => {
  const q = playerSearch.value.trim().toLowerCase();
  if (!q) return players.value;
  return players.value.filter(
    (p) =>
      (p.fullName || "").toLowerCase().includes(q) ||
      (p.email || "").toLowerCase().includes(q),
  );
});

function startEdit(player) {
  editingPlayerId.value = player.id;
  editForm.value = {
    fullName: player.fullName || "",
    email: player.email || "",
    currentRating: player.currentRating ?? 0,
    totalPoints: player.totalPoints ?? 0,
  };
}

function cancelEdit() {
  editingPlayerId.value = null;
}

async function saveEdit(playerId) {
  savingPlayer.value = true;
  try {
    await updateDoc(doc(db, "players", playerId), {
      fullName: editForm.value.fullName,
      email: editForm.value.email,
      currentRating: Number(editForm.value.currentRating),
      totalPoints: Number(editForm.value.totalPoints),
    });
    await loadPlayers();
    editingPlayerId.value = null;
  } catch (e) {
    console.error(e);
    alert("Save failed: " + (e.message || e));
  } finally {
    savingPlayer.value = false;
  }
}

async function resetRating(player) {
  if (!confirm(`Reset ${player.fullName}'s rating to 1000?`)) return;
  try {
    await updateDoc(doc(db, "players", player.id), { currentRating: 1000 });
    await loadPlayers();
  } catch (e) {
    console.error(e);
    alert("Reset failed: " + (e.message || e));
  }
}
</script>

<template>
  <div class="page">
    <div class="admin-shell">
      <aside class="admin-nav">
        <h3>Admin</h3>
        <ul>
          <li
            v-for="t in tabs"
            :key="t.id"
            :class="{ active: active === t.id }"
            @click="active = t.id"
          >
            {{ t.label }}
          </li>
        </ul>
      </aside>

      <main class="admin-content">
        <section v-if="active === 'pending'">
          <h2>Pending Registrations</h2>

          <div v-if="loadingPending" class="empty-state">Loading…</div>
          <div
            v-if="!loadingPending && pending.length === 0"
            class="empty-state"
          >
            No pending registrations.
          </div>

          <div class="list">
            <div v-for="r in pending" :key="r.id" class="reg-card">
              <img
                v-if="r.registrationPhotoUrl"
                :src="r.registrationPhotoUrl"
                alt="photo"
                class="thumb"
              />
              <div v-else class="thumb thumb-placeholder">?</div>

              <div class="body">
                <strong>{{ r.fullName }}</strong>
                <div class="meta">Rating: {{ r.submittedRating }}</div>
                <div class="meta">
                  Payment: {{ r.claimPaymentMethod }}
                  <span v-if="r.claimPaymentDate">
                    &middot; {{ r.claimPaymentDate }}</span
                  >
                </div>
                <div v-if="r.paymentNote" class="meta note">
                  {{ r.paymentNote }}
                </div>
              </div>

              <div class="actions">
                <button class="btn-primary" @click="approve(r.id)">
                  Approve
                </button>
                <button class="btn-danger" @click="reject(r.id)">Reject</button>
              </div>
            </div>
          </div>
        </section>

        <section v-if="active === 'admins'">
          <h2>Manage Admins</h2>

          <div class="admin-form">
            <input v-model="newAdminEmail" placeholder="email@example.com" />
            <button class="btn-primary" @click="addAdmin">Add Admin</button>
          </div>

          <div v-if="loadingAdmins" class="empty-state">Loading…</div>
          <div v-else class="list">
            <div v-for="e in admins" :key="e" class="admin-row">
              <span>{{ e }}</span>
              <button class="btn-danger" @click="removeAdmin(e)">Remove</button>
            </div>
          </div>
        </section>

        <section v-if="active === 'tournament'">
          <h2>Tournament Management</h2>

          <div class="card">
            <div class="subsection">
              <h3>Create Tournament</h3>
              <div class="field">
                <label for="newTournamentName">Name</label>
                <input
                  id="newTournamentName"
                  v-model="newTournamentName"
                  placeholder="Week 5 – Doubles"
                />
              </div>
              <div class="field">
                <label for="newTournamentDate">Date</label>
                <input
                  id="newTournamentDate"
                  v-model="newTournamentDate"
                  type="date"
                />
              </div>
              <div class="field">
                <label for="newTournamentFormat">Format</label>
                <select id="newTournamentFormat" v-model="newTournamentFormat">
                  <option value="singles">Singles</option>
                  <option value="doubles">Doubles</option>
                </select>
              </div>
              <button
                class="btn-primary"
                :disabled="creatingTournament"
                @click="createTournament"
              >
                {{ creatingTournament ? "Creating…" : "Create Tournament" }}
              </button>
            </div>

            <div class="subsection">
              <div class="field">
                <label for="tournamentSelect">Select tournament</label>
                <select id="tournamentSelect" v-model="selectedTournament">
                  <option value="">-- select --</option>
                  <option v-for="t in tournaments" :key="t.id" :value="t.id">
                    {{ t.name || t.id }}
                  </option>
                </select>
              </div>
            </div>

            <template v-if="selectedTournament">
              <div class="subsection">
                <h3>Format</h3>
                <div class="field">
                  <label for="selectedTournamentFormat"
                    >Singles or doubles</label
                  >
                  <select
                    id="selectedTournamentFormat"
                    v-model="selectedTournamentFormat"
                  >
                    <option value="singles">Singles</option>
                    <option value="doubles">Doubles</option>
                  </select>
                </div>
                <button
                  class="btn-primary"
                  :disabled="savingFormat"
                  @click="saveFormat"
                >
                  {{ savingFormat ? "Saving…" : "Save Format" }}
                </button>
              </div>

              <div class="subsection">
                <h3>Upload Winner Photo</h3>
                <div class="field">
                  <label class="file-input" for="winnerPhoto">
                    <span class="file-button">Browse&hellip;</span>
                    <span class="file-name">{{
                      selectedFile ? selectedFile.name : "No file selected."
                    }}</span>
                  </label>
                  <input
                    id="winnerPhoto"
                    class="file-native"
                    type="file"
                    @change="onFileChange"
                  />
                </div>
                <button
                  class="btn-primary"
                  @click="uploadWinner"
                  :disabled="winnerUploading || !selectedFile"
                >
                  {{ winnerUploading ? "Uploading…" : "Upload Winner Photo" }}
                </button>
              </div>

              <div class="subsection">
                <h3>Livestream</h3>
                <div class="field">
                  <label for="liveUrl">Livestream URL</label>
                  <input
                    id="liveUrl"
                    v-model="liveUrl"
                    placeholder="https://..."
                  />
                </div>
                <label class="checkbox-field">
                  <input type="checkbox" v-model="isLive" />
                  Show on homepage (live)
                </label>
                <button
                  class="btn-primary"
                  @click="saveLiveLink"
                  :disabled="savingLive"
                >
                  {{ savingLive ? "Saving…" : "Save Livestream" }}
                </button>
              </div>
            </template>
          </div>
        </section>

        <section v-if="active === 'ratings'">
          <h2>Tournament Ratings</h2>

          <p class="placeholder-text ratings-intro">
            Ratings come off newest first and go back on oldest first, and the
            buttons only unlock for the tournament that's next in line. To fix
            ratings from several tournaments back, revert down from the most
            recent through the one you're fixing, then apply them back up one at
            a time. Each tournament starts from the ratings the one before it
            finished with, so nothing downstream is left stale.
          </p>
          <p class="placeholder-text ratings-intro">
            Points don't have that ordering rule — any finished tournament can
            have points applied any time, and re-applying after fixing a result
            corrects each player's total rather than double-counting. There's no
            revert button for points; edit a player's total directly under
            Player Management if you need to undo one.
          </p>

          <div v-if="loadingTournaments" class="empty-state">Loading…</div>
          <div
            v-if="!loadingTournaments && ratingTournaments.length === 0"
            class="empty-state"
          >
            No tournaments found.
          </div>

          <div class="list">
            <div
              v-for="t in ratingTournaments"
              :key="t.id"
              class="reg-card rating-card"
            >
              <div class="body">
                <strong>{{ t.name || t.id }}</strong>
                <div class="meta">{{ formatTournamentDate(t.date) }}</div>
                <div class="meta status-row">
                  <span class="status-chip" :class="{ on: !!t.finishedAt }">{{
                    t.finishedAt ? "Finished" : "Not finished"
                  }}</span>
                  <span
                    class="status-chip"
                    :class="{ on: !!t.ratingsAppliedAt }"
                    >{{
                      t.ratingsAppliedAt
                        ? "Ratings applied"
                        : "Ratings not applied"
                    }}</span
                  >
                  <span
                    class="status-chip"
                    :class="{ on: !!t.pointsAppliedAt }"
                    >{{
                      t.pointsAppliedAt
                        ? "Points applied"
                        : "Points not applied"
                    }}</span
                  >
                </div>
                <p
                  v-if="!revertCheck(t).allowed && !applyCheck(t).allowed"
                  class="meta blocked-reason"
                >
                  {{
                    t.ratingsAppliedAt
                      ? revertCheck(t).reason
                      : applyCheck(t).reason
                  }}
                </p>
                <p v-if="ratingState(t.id).error" class="rating-error">
                  {{ ratingState(t.id).error }}
                </p>
                <p v-if="ratingState(t.id).pointsError" class="rating-error">
                  {{ ratingState(t.id).pointsError }}
                </p>
              </div>

              <div class="actions rating-actions">
                <span class="actions-label">Ratings</span>
                <button
                  class="btn-danger"
                  :disabled="
                    !revertCheck(t).allowed || ratingState(t.id).reverting
                  "
                  :title="revertCheck(t).reason"
                  @click="revertRatingsFor(t)"
                >
                  {{ ratingState(t.id).reverting ? "Reverting…" : "Revert" }}
                </button>
                <button
                  class="btn-primary"
                  :disabled="
                    !applyCheck(t).allowed || ratingState(t.id).recomputing
                  "
                  :title="applyCheck(t).reason"
                  @click="recomputeTournamentRatings(t)"
                >
                  {{ ratingState(t.id).recomputing ? "Applying…" : "Apply" }}
                </button>

                <span class="actions-label">Points</span>
                <button
                  class="btn-primary"
                  :disabled="
                    !pointsCheck(t).allowed || ratingState(t.id).applyingPoints
                  "
                  :title="pointsCheck(t).reason"
                  @click="applyPointsFor(t)"
                >
                  {{
                    ratingState(t.id).applyingPoints
                      ? "Applying…"
                      : t.pointsAppliedAt
                        ? "Recompute"
                        : "Apply"
                  }}
                </button>
              </div>
            </div>
          </div>
        </section>

        <section v-if="active === 'awards'">
          <h2>Season Awards</h2>
          <div class="card">
            <p class="placeholder-text">
              Placeholder — upload season awards photo and manage award winners.
            </p>
          </div>
        </section>

        <section v-if="active === 'players'">
          <h2>Player Management</h2>

          <div class="admin-form">
            <input
              v-model="playerSearch"
              placeholder="Search by name or email…"
            />
          </div>

          <div v-if="loadingPlayers" class="empty-state">Loading…</div>
          <div
            v-if="!loadingPlayers && filteredPlayers.length === 0"
            class="empty-state"
          >
            No players found.
          </div>

          <div class="list">
            <div v-for="p in filteredPlayers" :key="p.id" class="reg-card">
              <img
                v-if="p.profilePhotoUrl"
                :src="p.profilePhotoUrl"
                alt="photo"
                class="thumb"
              />
              <div v-else class="thumb thumb-placeholder">?</div>

              <template v-if="editingPlayerId === p.id">
                <div class="body edit-body">
                  <div class="field">
                    <label>Full name</label>
                    <input v-model="editForm.fullName" />
                  </div>
                  <div class="field">
                    <label>Email</label>
                    <input v-model="editForm.email" type="email" />
                  </div>
                  <div class="field">
                    <label>Rating</label>
                    <input v-model="editForm.currentRating" type="number" />
                  </div>
                  <div class="field">
                    <label>Total points</label>
                    <input v-model="editForm.totalPoints" type="number" />
                  </div>
                </div>
                <div class="actions">
                  <button
                    class="btn-primary"
                    @click="saveEdit(p.id)"
                    :disabled="savingPlayer"
                  >
                    {{ savingPlayer ? "Saving…" : "Save" }}
                  </button>
                  <button class="btn-danger" @click="cancelEdit">Cancel</button>
                </div>
              </template>

              <template v-else>
                <div class="body">
                  <strong>{{ p.fullName }}</strong>
                  <div class="meta">{{ p.email }}</div>
                  <div class="meta">
                    Rating: {{ p.currentRating }} &middot; Points:
                    {{ p.totalPoints }}
                  </div>
                </div>
                <div class="actions">
                  <button class="btn-primary" @click="startEdit(p)">
                    Edit
                  </button>
                  <button class="btn-danger" @click="resetRating(p)">
                    Reset Rating
                  </button>
                </div>
              </template>
            </div>
          </div>
        </section>
      </main>
    </div>
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  background: #0a0a0a;
  padding: 2.5rem 1.5rem 4rem;
}

.admin-shell {
  max-width: 1100px;
  margin: 0 auto;
  display: flex;
  gap: 1.5rem;
  align-items: flex-start;
}

/* Sidebar */
.admin-nav {
  width: 240px;
  flex-shrink: 0;
  background: #111214;
  border: 1px solid #2a2b2f;
  border-radius: 10px;
  padding: 1.1rem;
}

.admin-nav h3 {
  margin: 0 0 0.75rem;
  color: #f5f5f5;
  font-size: 1.1rem;
  font-weight: 800;
}

.admin-nav ul {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.admin-nav li {
  padding: 0.65rem 0.7rem;
  cursor: pointer;
  border-radius: 7px;
  color: #9ca3ae;
  font-size: 0.9rem;
  font-weight: 600;
  border-left: 3px solid transparent;
  transition:
    background 0.15s ease,
    color 0.15s ease;
}

.admin-nav li:hover {
  background: #17181b;
  color: #d7dbe0;
}

.admin-nav li.active {
  background: rgba(224, 85, 31, 0.12);
  color: #ff8a4c;
  border-left-color: #e0551f;
}

/* Content */
.admin-content {
  flex: 1 1 auto;
  min-width: 0;
}

.admin-content h2 {
  color: #f5f5f5;
  font-size: 1.4rem;
  font-weight: 800;
  margin: 0 0 1.1rem;
}

.admin-content h3 {
  color: #e5e6e8;
  font-size: 1rem;
  font-weight: 700;
  margin: 0 0 0.85rem;
}

.empty-state {
  color: #6f747c;
  font-size: 0.9rem;
  padding: 0.75rem 0;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

/* Pending registration cards */
.reg-card {
  display: flex;
  align-items: center;
  gap: 1rem;
  background: #111214;
  border: 1px solid #2a2b2f;
  border-radius: 10px;
  padding: 0.9rem 1.1rem;
}

.thumb {
  width: 64px;
  height: 64px;
  object-fit: cover;
  border-radius: 8px;
  flex-shrink: 0;
}

.thumb-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  background: #1c1d20;
  color: #5b5f66;
  font-size: 1.2rem;
  font-weight: 700;
}

.body {
  flex: 1;
  min-width: 0;
}

.body strong {
  color: #f5f5f5;
  font-size: 1rem;
}

.meta {
  color: #9ca3ae;
  font-size: 0.85rem;
  margin-top: 0.15rem;
}

.meta.note {
  color: #6f747c;
  font-style: italic;
}

.actions {
  display: flex;
  gap: 0.5rem;
  flex-shrink: 0;
}

/* Admins */
.admin-form {
  display: flex;
  gap: 0.6rem;
  margin-bottom: 1.1rem;
}

.admin-form input {
  flex: 1;
}

.admin-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #111214;
  border: 1px solid #2a2b2f;
  border-radius: 8px;
  padding: 0.65rem 1rem;
}

.admin-row span {
  color: #e5e6e8;
  font-size: 0.9rem;
}

/* Generic card used by tournament / awards / players sections */
.card {
  background: #111214;
  border: 1px solid #2a2b2f;
  border-radius: 10px;
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1.1rem;
}

.subsection {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  padding-top: 1.1rem;
  border-top: 1px solid #2a2b2f;
}

.subsection:first-of-type {
  padding-top: 0;
  border-top: none;
}

.placeholder-text {
  color: #6f747c;
  font-size: 0.9rem;
  margin: 0;
}

.ratings-intro {
  margin-bottom: 1.1rem;
  line-height: 1.5;
}

/* Tournament Ratings */
.rating-card {
  align-items: flex-start;
}

.status-row {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
  margin-top: 0.35rem;
}

.status-chip {
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  color: #6f747c;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid #2a2b2f;
  border-radius: 999px;
  padding: 0.2rem 0.6rem;
}

.status-chip.on {
  color: #6be0a3;
  background: rgba(107, 224, 163, 0.1);
  border-color: rgba(107, 224, 163, 0.3);
}

.rating-error {
  color: #f08383;
  font-size: 0.82rem;
  margin: 0.5rem 0 0;
}

.blocked-reason {
  color: #6f747c;
  font-style: italic;
  margin-top: 0.4rem;
}

.rating-actions {
  flex-direction: column;
  align-items: stretch;
  min-width: 110px;
  gap: 0.4rem;
}

.actions-label {
  color: #6f747c;
  font-size: 0.68rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  margin-top: 0.3rem;
}

.actions-label:first-child {
  margin-top: 0;
}

.rating-actions .btn-primary,
.rating-actions .btn-danger {
  width: 100%;
  text-align: center;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

label {
  color: #9ca3ae;
  font-size: 0.85rem;
  font-weight: 600;
}

.checkbox-field {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: #d7dbe0;
  font-size: 0.9rem;
  font-weight: 500;
  cursor: pointer;
}

.checkbox-field input[type="checkbox"] {
  width: 16px;
  height: 16px;
  accent-color: #e0551f;
}

/* Inputs / selects, matching the rest of the app */
input[type="text"],
input[type="email"],
input[type="url"],
input[type="number"],
input[type="date"],
input:not([type]),
select {
  background: #0d0e10;
  color: #f0f0f1;
  border: 1px solid #2f3136;
  border-radius: 7px;
  padding: 0.65rem 0.8rem;
  font-size: 0.95rem;
  width: 100%;
  box-sizing: border-box;
}

select {
  appearance: none;
  -webkit-appearance: none;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='%238a8f98'><path d='M5.25 7.5L10 12.25L14.75 7.5H5.25Z'/></svg>");
  background-repeat: no-repeat;
  background-position: right 0.7rem center;
  background-size: 1.1rem;
  padding-right: 2.25rem;
}

input:focus,
select:focus {
  outline: none;
  border-color: #e0551f;
  box-shadow: 0 0 0 3px rgba(224, 85, 31, 0.18);
}

input::placeholder {
  color: #5b5f66;
}

/* Custom file input, matching Player Registration */
.file-input {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  cursor: pointer;
  width: fit-content;
}

.file-button {
  background: #1c1d20;
  color: #e5e6e8;
  border: 1px solid #2f3136;
  border-radius: 7px;
  padding: 0.45rem 0.9rem;
  font-size: 0.85rem;
  font-weight: 600;
}

.file-name {
  color: #6f747c;
  font-size: 0.9rem;
}

.file-native {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}

/* Buttons */
.btn-primary,
.btn-danger {
  border: none;
  border-radius: 999px;
  padding: 0.55rem 1.1rem;
  font-size: 0.85rem;
  font-weight: 700;
  cursor: pointer;
  transition:
    background 0.15s ease,
    opacity 0.15s ease,
    border-color 0.15s ease;
  white-space: nowrap;
}

.btn-primary {
  background: #e0551f;
  color: #ffffff;
}

.btn-primary:hover:not(:disabled) {
  background: #ef632c;
}

.btn-primary:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.btn-danger {
  background: transparent;
  color: #f08383;
  border: 1px solid rgba(240, 131, 131, 0.4);
}

.btn-danger:hover:not(:disabled) {
  background: rgba(240, 131, 131, 0.1);
  border-color: #f08383;
}

.btn-danger:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.edit-body {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.edit-body .field {
  gap: 0.2rem;
}

@media (max-width: 720px) {
  .admin-shell {
    flex-direction: column;
  }

  .admin-nav {
    width: 100%;
  }

  .reg-card {
    flex-wrap: wrap;
  }

  .actions {
    width: 100%;
    justify-content: flex-end;
  }

  .rating-actions {
    flex-direction: row;
  }
}
</style>
