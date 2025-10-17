<script setup>
import { ref } from "vue";
import { getAuth, signInWithEmailAndPassword } from "firebase/auth";

const props = defineProps([]);

const adminEmail = "glttadmin@gmail.com";

const password = ref("");

const authenticate = async (e) => {
  e.preventDefault();
  const auth = getAuth();
  try {
    signInWithEmailAndPassword(auth, adminEmail, password.value).then(
      (userCredential) => {
        const user = userCredential.user;
        console.log(user);
        alert(
          "Authentication successful! You now have tournament edit access."
        );
        password.value = "";
      }
    );
  } catch (error) {
    console.log("Authentication failed: " + error.message);
  }
};
</script>

<template>
  <div class="page-container">
    <div class="auth-form-container">
      <h1>Authenticate</h1>
      <p>Please enter the admin password to access the admin panel.</p>
      <form class="auth-form">
        <label for="password-input">Password:</label>
        <input
          id="password-input"
          type="password"
          v-model="password"
          placeholder="Enter admin password"
        />
        <button type="submit" class="thick-btn auth-btn" @click="authenticate">
          Authenticate
        </button>
      </form>
    </div>
  </div>
</template>

<style scoped></style>
