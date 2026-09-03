<script setup>
import { ref, onMounted } from "vue";
import { db } from "../firebase";
import {
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

// tabs: pending registrations + admin management + placeholders for future
const tabs = [
  { id: "pending", label: "Pending Registrations" },
  { id: "admins", label: "Manage Admins" },
  { id: "tournament", label: "Tournament Management" },
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
          <div v-if="!loadingPending && pending.length === 0" class="empty-state">
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
                  <span v-if="r.claimPaymentDate"> &middot; {{ r.claimPaymentDate }}</span>
                </div>
                <div v-if="r.paymentNote" class="meta note">{{ r.paymentNote }}</div>
              </div>

              <div class="actions">
                <button class="btn-primary" @click="approve(r.id)">Approve</button>
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
            <div class="field">
              <label for="tournamentSelect">Select tournament</label>
              <select id="tournamentSelect" v-model="selectedTournament">
                <option value="">-- select --</option>
                <option v-for="t in tournaments" :key="t.id" :value="t.id">
                  {{ t.name || t.id }}
                </option>
              </select>
            </div>

            <template v-if="selectedTournament">
              <div class="subsection">
                <h3>Upload Winner Photo</h3>
                <div class="field">
                  <label class="file-input" for="winnerPhoto">
                    <span class="file-button">Browse&hellip;</span>
                    <span class="file-name">{{ selectedFile ? selectedFile.name : "No file selected." }}</span>
                  </label>
                  <input id="winnerPhoto" class="file-native" type="file" @change="onFileChange" />
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
                  <input id="liveUrl" v-model="liveUrl" placeholder="https://..." />
                </div>
                <label class="checkbox-field">
                  <input type="checkbox" v-model="isLive" />
                  Show on homepage (live)
                </label>
                <button class="btn-primary" @click="saveLiveLink" :disabled="savingLive">
                  {{ savingLive ? "Saving…" : "Save Livestream" }}
                </button>
              </div>
            </template>
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
          <div class="card">
            <p class="placeholder-text">
              Placeholder — edit player profiles, reset ratings, or suspend accounts.
            </p>
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
  transition: background 0.15s ease, color 0.15s ease;
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
  transition: background 0.15s ease, opacity 0.15s ease, border-color 0.15s ease;
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
}
</style>