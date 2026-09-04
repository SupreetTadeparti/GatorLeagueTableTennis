<script setup>
import { ref } from "vue";
import { auth } from "../firebase";
import { signInWithEmailAndPassword, GoogleAuthProvider, signInWithPopup } from "firebase/auth";
import { useRouter } from "vue-router";

const router = useRouter();
const email = ref("");
const password = ref("");
const loading = ref(false);
const error = ref(null);

async function signInEmail() {
  error.value = null;
  loading.value = true;
  try {
    await signInWithEmailAndPassword(auth, email.value, password.value);
    router.push("/tournament");
  } catch (e) {
    error.value = e.message || String(e);
  } finally {
    loading.value = false;
  }
}

async function signInGoogle() {
  error.value = null;
  loading.value = true;
  try {
    const provider = new GoogleAuthProvider();
    await signInWithPopup(auth, provider);
    router.push("/tournament");
  } catch (e) {
    error.value = e.message || String(e);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="page">
    <div class="wrap">
      <h2>Sign In</h2>
      <p class="subtitle">Welcome back to the Gator League.</p>

      <div class="card">
        <div class="field">
          <label for="email">Email</label>
          <input id="email" v-model="email" type="email" placeholder="you@example.com" autocomplete="email" />
        </div>

        <div class="field">
          <label for="password">Password</label>
          <input
            id="password"
            v-model="password"
            type="password"
            placeholder="Your password"
            autocomplete="current-password"
          />
        </div>

        <button class="submit-btn" @click="signInEmail" :disabled="loading || !email || !password">
          {{ loading ? "Signing in…" : "Sign In" }}
        </button>

        <div class="divider"><span>or</span></div>

        <button class="google-btn" @click="signInGoogle" :disabled="loading">
          <svg class="google-icon" viewBox="0 0 18 18" width="18" height="18">
            <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.57 2.7-3.88 2.7-6.62z"/>
            <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.98v2.33A9 9 0 0 0 9 18z"/>
            <path fill="#FBBC05" d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.17.28-1.7V4.97H.98A9 9 0 0 0 0 9c0 1.45.35 2.83.98 4.03l2.97-2.33z"/>
            <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .98 4.97l2.97 2.33C4.66 5.17 6.65 3.58 9 3.58z"/>
          </svg>
          Sign in with Google
        </button>

        <p v-if="error" class="status error">{{ error }}</p>

        <p class="switch-link">
          New to the league?
          <router-link to="/register">Register here</router-link>
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
  max-width: 420px;
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

input[type="email"],
input[type="password"] {
  background: #0d0e10;
  color: #f0f0f1;
  border: 1px solid #2f3136;
  border-radius: 7px;
  padding: 0.65rem 0.8rem;
  font-size: 0.95rem;
  width: 100%;
  box-sizing: border-box;
}

input:focus {
  outline: none;
  border-color: #e0551f;
  box-shadow: 0 0 0 3px rgba(224, 85, 31, 0.18);
}

input::placeholder {
  color: #5b5f66;
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

.divider {
  display: flex;
  align-items: center;
  color: #5b5f66;
  font-size: 0.8rem;
  gap: 0.75rem;
}

.divider::before,
.divider::after {
  content: "";
  flex: 1;
  height: 1px;
  background: #2a2b2f;
}

.google-btn {
  width: 100%;
  background: #f5f5f5;
  color: #1c1d20;
  border: 1px solid #2f3136;
  border-radius: 999px;
  padding: 0.75rem 1rem;
  font-size: 0.95rem;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.6rem;
  transition: background 0.15s ease, opacity 0.15s ease;
}

.google-btn:hover:not(:disabled) {
  background: #ffffff;
}

.google-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.status {
  margin: 0;
  font-size: 0.9rem;
  text-align: center;
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