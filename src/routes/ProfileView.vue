<script setup>
import { ref, onMounted } from "vue";
import { auth, db } from "../firebase";
import { uploadPlayerPhoto } from "../firebaseHelpers";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
} from "firebase/firestore";

const user = ref(auth.currentUser);
const player = ref(null);
const file = ref(null);
const preview = ref(null);
const uploading = ref(false);

onMounted(() => {
  auth.onAuthStateChanged(async (u) => {
    user.value = u;
    if (u) {
      const playerSnap = await getDoc(doc(db, "players", u.uid));
      if (playerSnap.exists()) {
        player.value = playerSnap.data();
        return;
      }

      const linkedPlayers = await getDocs(
        query(collection(db, "players"), where("authUid", "==", u.uid)),
      );
      player.value = linkedPlayers.empty ? null : linkedPlayers.docs[0].data();
    } else {
      player.value = null;
    }
  });
});

function onFileChange(e) {
  const f = e.target.files?.[0] || null;
  file.value = f;
  preview.value = f ? URL.createObjectURL(f) : null;
}

async function submit() {
  if (!file.value || !user.value) return;
  uploading.value = true;
  try {
    const url = await uploadPlayerPhoto(file.value, user.value.uid);
    if (!player.value) player.value = {};
    player.value.profilePhotoUrl = url;
    file.value = null;
    preview.value = null;
  } catch (e) {
    console.error("Upload failed", e);
  } finally {
    uploading.value = false;
  }
}
</script>

<template>
  <div class="profile-page">
    <h1>Profile</h1>

    <div v-if="!user">
      <p>Please sign in to edit your profile.</p>
    </div>

    <div v-else>
      <div class="profile-info">
        <img
          v-if="player?.profilePhotoUrl"
          :src="player.profilePhotoUrl"
          alt="profile"
          class="profile-photo"
        />
        <div v-else class="profile-placeholder">No photo</div>
        <div class="meta">
          <p>
            <strong>{{ player?.displayName || user.email }}</strong>
          </p>
          <p>Rating: {{ player?.currentRating ?? "—" }}</p>
          <p>Points: {{ player?.totalPoints ?? 0 }}</p>
        </div>
      </div>

      <div class="upload">
        <label>Upload profile photo</label>
        <input type="file" accept="image/*" @change="onFileChange" />
        <div v-if="preview" class="preview-wrap">
          <img :src="preview" class="preview" />
        </div>
        <button @click="submit" :disabled="uploading || !file">
          {{ uploading ? "Uploading…" : "Upload" }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.profile-page {
  max-width: 720px;
  margin: 1rem auto;
  padding: 1rem;
}
.profile-info {
  display: flex;
  gap: 1rem;
  align-items: center;
  margin-bottom: 1rem;
}
.profile-photo {
  width: 120px;
  height: 120px;
  object-fit: cover;
  border-radius: 8px;
}
.profile-placeholder {
  width: 120px;
  height: 120px;
  background: #222;
  color: #ddd;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
}
.preview {
  width: 160px;
  height: 160px;
  object-fit: cover;
  border-radius: 8px;
  margin-top: 0.5rem;
}
.meta p {
  margin: 0.15rem 0;
}
.upload {
  margin-top: 0.75rem;
}
</style>
