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
        <div v-if="loadingPending">Loading…</div>
        <div v-if="!loadingPending && pending.length === 0">
          No pending registrations.
        </div>
        <ul>
          <li v-for="r in pending" :key="r.id" class="reg">
            <div class="left">
              <img
                v-if="r.registrationPhotoUrl"
                :src="r.registrationPhotoUrl"
                alt="photo"
                class="thumb"
              />
            </div>
            <div class="body">
              <strong>{{ r.fullName }}</strong>
              <div>Rating: {{ r.submittedRating }}</div>
              <div>
                Payment: {{ r.claimPaymentMethod }}
                {{ r.claimPaymentDate || "" }}
              </div>
              <div>{{ r.paymentNote }}</div>
            </div>
            <div class="actions">
              <button @click="approve(r.id)">Approve</button>
              <button @click="reject(r.id)">Reject</button>
            </div>
          </li>
        </ul>
      </section>

      <section v-if="active === 'admins'">
        <h2>Manage Admins</h2>
        <div class="admin-form">
          <input v-model="newAdminEmail" placeholder="email@example.com" />
          <button @click="addAdmin">Add Admin</button>
        </div>

        <div v-if="loadingAdmins">Loading…</div>
        <ul v-if="!loadingAdmins">
          <li v-for="e in admins" :key="e" class="admin-row">
            <span>{{ e }}</span>
            <button @click="removeAdmin(e)">Remove</button>
          </li>
        </ul>
      </section>

      <section v-if="active === 'tournament'">
        <h2>Tournament Management</h2>

        <div class="tournament-form">
          <label>Select tournament</label>
          <select v-model="selectedTournament">
            <option value="">-- select --</option>
            <option v-for="t in tournaments" :key="t.id" :value="t.id">
              {{ t.name || t.id }}
            </option>
          </select>
        </div>

        <div v-if="selectedTournament">
          <h3>Upload Winner Photo</h3>
          <input type="file" @change="onFileChange" />
          <button
            @click="uploadWinner"
            :disabled="winnerUploading || !selectedFile"
          >
            Upload Winner Photo
          </button>

          <h3 style="margin-top: 1rem">Livestream</h3>
          <label>Livestream URL</label>
          <input v-model="liveUrl" placeholder="https://..." />
          <label
            style="
              display: flex;
              align-items: center;
              gap: 0.5rem;
              margin-top: 0.5rem;
            "
          >
            <input type="checkbox" v-model="isLive" /> Show on homepage (live)
          </label>
          <div style="margin-top: 0.5rem">
            <button @click="saveLiveLink" :disabled="savingLive">
              Save Livestream
            </button>
          </div>
        </div>
      </section>

      <section v-if="active === 'awards'">
        <h2>Season Awards</h2>
        <p>
          Placeholder — upload season awards photo and manage award winners.
        </p>
      </section>

      <section v-if="active === 'players'">
        <h2>Player Management</h2>
        <p>
          Placeholder — edit player profiles, reset ratings, or suspend
          accounts.
        </p>
      </section>
    </main>
  </div>
</template>

<style scoped>
.admin-shell {
  display: flex;
  gap: 1rem;
}
.admin-nav {
  width: 220px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.04);
  padding: 1rem;
  border-radius: 8px;
}
.admin-nav h3 {
  margin: 0 0 0.5rem 0;
}
.admin-nav ul {
  list-style: none;
  padding: 0;
  margin: 0;
}
.admin-nav li {
  padding: 0.6rem 0.5rem;
  cursor: pointer;
  border-radius: 6px;
}
.admin-nav li.active {
  background: rgba(255, 255, 255, 0.04);
  font-weight: 700;
}
.admin-content {
  flex: 1 1 auto;
  background: transparent;
  padding: 0.25rem 1rem;
}
.reg {
  display: flex;
  gap: 1rem;
  padding: 0.5rem 0;
  border-bottom: 1px solid #222;
  align-items: center;
}
.thumb {
  width: 80px;
  height: 80px;
  object-fit: cover;
  border-radius: 6px;
}
.actions {
  margin-left: auto;
  display: flex;
  gap: 0.5rem;
}
.admin-form {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}
.admin-row {
  display: flex;
  justify-content: space-between;
  padding: 0.4rem 0.2rem;
  border-bottom: 1px dashed rgba(255, 255, 255, 0.02);
}
</style>
