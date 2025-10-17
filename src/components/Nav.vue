<script setup>
import { getAuth, onAuthStateChanged } from "firebase/auth";
import { ref } from "vue";

const isLoggedIn = ref(false);

onAuthStateChanged(getAuth(), (user) => {
  isLoggedIn.value = !!user;
});

const props = defineProps([]);
</script>

<template>
  <div class="nav-container">
    <div class="nav-item nav-item--img">
      <RouterLink to="/">
        <img src="/glnlogonav.png" id="logo" alt="GLTT logo" />
      </RouterLink>
    </div>
    <div class="nav-item">
      <RouterLink to="/standings">Standings</RouterLink>
    </div>
    <div class="nav-item">
      <RouterLink to="/schedule">Schedule</RouterLink>
    </div>
    <div class="nav-item nav-item--btn">
      <RouterLink to="/register">Register</RouterLink>
    </div>
    <div v-if="isLoggedIn" class="nav-item nav-item--img">
      <RouterLink to="/account">Account</RouterLink>
    </div>
    <div v-if="!isLoggedIn" class="nav-item">
      <RouterLink to="/authenticate">Sign Up</RouterLink>
    </div>
  </div>
</template>

<style scoped>
.nav-container {
  /* Positioning */
  position: fixed;
  top: 1em;
  left: 50%;
  transform: translateX(-50%);

  /* Flexbox */
  display: flex;
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
  gap: 2em;
  width: 80%;

  border: 1px solid #aaa;
  border-radius: 0.75em;

  /* Other */
  padding: 0.75em 1em;
  /* background-color: hsla(0, 0%, 50%, 0.15); */
  font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
}

.nav-item {
  font-size: 1.2em;
  padding: 0.75em 1.25em;
  border-radius: 0.5em;
  cursor: pointer;
  transition: background-color 100ms ease-out;
}

.nav-item > a {
  color: hsl(0, 0%, 90%);
  text-decoration: none;
  transition: color 100ms ease-out;
}

.nav-item:hover {
  background-color: hsl(var(--gator-orange), 1);
  /* background: red; */
}

.nav-item:hover > a {
  color: hsl(var(--gator-blue));
}

#logo {
  width: 15em;
}
</style>
