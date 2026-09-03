<script setup>
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { createRegistration } from "../firebaseHelpers";
import { auth } from "../firebase";
import { createUserWithEmailAndPassword, onAuthStateChanged } from "firebase/auth";

const router = useRouter();

const fullName = ref("");
const email = ref("");
const password = ref("");
const submittedRating = ref(null);
const claimPaymentMethod = ref("zelle");
const claimPaymentDate = ref("");
const paymentNote = ref("");
const file = ref(null);
const uploading = ref(false);
const success = ref(null);
const error = ref(null);

const ZELLE_NUMBER = "352-756-2685";

// Track auth state so we can skip email/password if the person is already signed in
const currentUser = ref(null);
let unsubscribe = null;

onMounted(() => {
  unsubscribe = onAuthStateChanged(auth, (user) => {
    currentUser.value = user;
  });
});

onUnmounted(() => {
  if (unsubscribe) unsubscribe();
});

const isFormValid = computed(() => {
  const baseValid =
    fullName.value.trim() !== "" &&
    submittedRating.value !== null &&
    submittedRating.value !== "" &&
    claimPaymentMethod.value !== "" &&
    file.value !== null;

  if (currentUser.value) return baseValid;

  return baseValid && email.value.trim() !== "" && password.value.length >= 6;
});

function onFileChange(e) {
  file.value = e.target.files?.[0] || null;
}

async function submit() {
  if (!isFormValid.value) return;
  error.value = null;
  success.value = null;
  uploading.value = true;
  try {
    let authUid = currentUser.value?.uid ?? null;

    // Create the account first if this person isn't signed in yet —
    // player registration doubles as account creation.
    if (!authUid) {
      const credential = await createUserWithEmailAndPassword(auth, email.value, password.value);
      authUid = credential.user.uid;
    }

    const regId = await createRegistration(
      {
        fullName: fullName.value,
        submittedRating: Number(submittedRating.value) || null,
        claimPaymentMethod: claimPaymentMethod.value,
        claimPaymentDate: claimPaymentDate.value || null,
        paymentNote: paymentNote.value || null,
        authUid,
      },
      file.value,
    );

    success.value = `Submitted registration ${regId}`;
    fullName.value = "";
    email.value = "";
    password.value = "";
    submittedRating.value = null;
    claimPaymentDate.value = "";
    paymentNote.value = "";
    file.value = null;

    router.push("/profile");
  } catch (e) {
    console.error(e);
    error.value = e.message || "Submission failed";
  } finally {
    uploading.value = false;
  }
}
</script>

<template>
  <div class="page">
    <div class="wrap">
      <h2>Player Registration</h2>
      <p class="subtitle">Sign up for the Gator League and we'll add you to the next available session.</p>

      <div class="card">
        <div v-if="currentUser" class="banner">
          Registering as <strong>{{ currentUser.email }}</strong>
        </div>

        <template v-else>
          <div class="field">
            <label for="email">Email <span class="required">*</span></label>
            <input id="email" v-model="email" type="email" placeholder="you@example.com" autocomplete="email" />
          </div>

          <div class="field">
            <label for="password">Password <span class="required">*</span></label>
            <input
              id="password"
              v-model="password"
              type="password"
              placeholder="At least 6 characters"
              autocomplete="new-password"
            />
          </div>
        </template>

        <div class="field">
          <label for="fullName">Full name <span class="required">*</span></label>
          <input id="fullName" v-model="fullName" type="text" placeholder="Jane Doe" />
        </div>

        <div class="field">
          <label for="rating">Submitted rating <span class="required">*</span></label>
          <input
            id="rating"
            v-model="submittedRating"
            type="number"
            placeholder="e.g. 1200"
            @wheel="$event.target.blur()"
          />
        </div>

        <div class="row">
          <div class="field">
            <label for="paymentMethod">Payment method <span class="required">*</span></label>
            <select id="paymentMethod" v-model="claimPaymentMethod">
              <option value="zelle">Zelle</option>
              <option value="cash">Cash</option>
            </select>
          </div>

          <div class="field">
            <label for="paymentDate">Payment date</label>
            <input id="paymentDate" v-model="claimPaymentDate" type="date" />
          </div>
        </div>

        <p v-if="claimPaymentMethod === 'zelle'" class="payment-hint">
          Entry fee is <strong>$20</strong>. Send Zelle payment to <strong>{{ ZELLE_NUMBER }}</strong>
        </p>
        <p v-else class="payment-hint">
          Entry fee is <strong>$20</strong>.
        </p>

        <div class="field">
          <label for="paymentNote">Payment note</label>
          <input id="paymentNote" v-model="paymentNote" type="text" placeholder="Confirmation #, sender name, etc." />
        </div>

        <div class="field">
          <label for="photo">Upload profile photo <span class="required">*</span></label>
          <label class="file-input" for="photo">
            <span class="file-button">Browse&hellip;</span>
            <span class="file-name">{{ file ? file.name : "No file selected." }}</span>
          </label>
          <input id="photo" class="file-native" type="file" accept="image/*" @change="onFileChange" />
        </div>

        <button class="submit-btn" @click="submit" :disabled="uploading || !isFormValid">
          {{ uploading ? "Submitting…" : "Submit Registration" }}
        </button>

        <p v-if="success" class="status success">{{ success }}</p>
        <p v-if="error" class="status error">{{ error }}</p>

        <p v-if="!currentUser" class="switch-link">
          Already have an account?
          <router-link to="/signin">Sign in</router-link>
        </p>
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
  max-width: 620px;
}

h2 {
  color: #f5f5f5;
  font-size: 1.9rem;
  font-weight: 800;
  letter-spacing: 0.01em;
  margin: 0 0 0.4rem;
  text-align: center;
}

.subtitle {
  color: #8a8f98;
  font-size: 0.95rem;
  text-align: center;
  margin: 0 0 2rem;
}

.card {
  background: #111214;
  border: 1px solid #2a2b2f;
  border-radius: 10px;
  padding: 1.75rem;
  display: flex;
  flex-direction: column;
  gap: 1.15rem;
}

.banner {
  background: rgba(59, 111, 214, 0.12);
  border: 1px solid rgba(59, 111, 214, 0.35);
  color: #cfe0ff;
  border-radius: 7px;
  padding: 0.65rem 0.85rem;
  font-size: 0.9rem;
}

.banner strong {
  color: #ffffff;
}

.row {
  display: flex;
  gap: 1.15rem;
}

.row .field {
  flex: 1;
  min-width: 0;
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

.required {
  color: #e0551f;
}

.payment-hint {
  margin: -0.6rem 0 0;
  color: #d7dbe0;
  font-size: 0.85rem;
  background: rgba(224, 85, 31, 0.1);
  border: 1px solid rgba(224, 85, 31, 0.3);
  border-radius: 7px;
  padding: 0.55rem 0.75rem;
}

.payment-hint strong {
  color: #ff8a4c;
  letter-spacing: 0.02em;
}

input[type="text"],
input[type="number"],
input[type="date"],
input[type="email"],
input[type="password"],
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

/* Custom file input styled to match the rest of the form */
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

.submit-btn {
  margin-top: 0.25rem;
  width: 100%;
  background: #e0551f;
  color: #ffffff;
  border: none;
  border-radius: 999px;
  padding: 0.85rem 1rem;
  font-size: 1rem;
  font-weight: 700;
  cursor: pointer;
  transition: background 0.15s ease, opacity 0.15s ease;
}

.submit-btn:hover:not(:disabled) {
  background: #ef632c;
}

.submit-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.status {
  margin: 0;
  font-size: 0.9rem;
  text-align: center;
}

.status.success {
  color: #6fcf97;
}

.status.error {
  color: #f08383;
}

.switch-link {
  margin: 0;
  text-align: center;
  font-size: 0.85rem;
  color: #8a8f98;
}

.switch-link a {
  color: #6fa8ff;
  text-decoration: none;
  font-weight: 600;
}

.switch-link a:hover {
  text-decoration: underline;
}
</style>