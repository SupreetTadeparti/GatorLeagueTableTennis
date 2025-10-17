<script setup>
import { getAuth, onAuthStateChanged } from "firebase/auth";
import { ref } from "vue";

const isLoggedIn = ref(false);

onAuthStateChanged(getAuth(), (user) => {
  isLoggedIn.value = !!user;
});

// local state for mobile menu
const menuOpen = ref(false);

function toggleMenu() {
  menuOpen.value = !menuOpen.value;
}

function closeMenu() {
  menuOpen.value = false;
}

const props = defineProps([]);
</script>

<template>
  <div class="nav-container">
    <div class="nav-left">
      <div class="nav-item nav-item--img">
        <RouterLink to="/">
          <img src="/glnlogonav.png" id="logo" alt="GLTT logo" />
        </RouterLink>
      </div>
    </div>

    <!-- hamburger button shown on small screens -->
    <button
      class="hamburger"
      :aria-expanded="menuOpen"
      aria-label="Toggle navigation"
      @click="toggleMenu"
    >
      <span class="bar"></span>
      <span class="bar"></span>
      <span class="bar"></span>
    </button>

    <div :class="['nav-items', { 'nav-items--open': menuOpen }]">
      <div class="nav-item" @click="closeMenu">
        <RouterLink to="/standings">Standings</RouterLink>
      </div>
      <div class="nav-item" @click="closeMenu">
        <RouterLink to="/schedule">Schedule</RouterLink>
      </div>
      <div class="nav-item nav-item--btn" @click="closeMenu">
        <RouterLink to="/register">Register</RouterLink>
      </div>
      <div v-if="isLoggedIn" class="nav-item nav-item--img" @click="closeMenu">
        <RouterLink to="/account">Account</RouterLink>
      </div>
      <div v-if="!isLoggedIn" class="nav-item" @click="closeMenu">
        <RouterLink to="/authenticate">Sign Up</RouterLink>
      </div>
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
  background-color: hsla(0, 0%, 50%, 0.2);
  backdrop-filter: blur(10px);

  z-index: 100;
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

/* hamburger button styles */
.hamburger {
  display: none; /* shown via media query */
  background: transparent;
  border: none;
  padding: 0.5em;
  margin-left: 1em;
  cursor: pointer;
}
.hamburger:focus {
  outline: 2px solid hsl(var(--gator-blue));
}
.hamburger .bar {
  display: block;
  width: 1.6em;
  height: 3px;
  margin: 4px 0;
  background: hsl(0, 0%, 90%);
  transition: transform 200ms ease, opacity 200ms ease;
}

/* nav-items container adjustments for responsiveness */
.nav-items {
  display: flex;
  gap: 2em;
  align-items: center;
}

/* Small screen: hide nav items and show hamburger */
@media (max-width: 1200px) {
  .nav-container {
    width: calc(100% - 2em);
    padding-right: 0.5em;
    gap: 0.5em;
  }

  #logo {
    width: 10em;
  }

  .hamburger {
    display: block;
  }

  /* hide nav items by default on small screens */
  .nav-items {
    position: absolute;
    top: 4.6em; /* below the nav bar */
    right: 1em;
    flex-direction: column;
    background: rgba(20, 20, 20, 0.9);
    padding: 0.75em 1em;
    border-radius: 0.5em;
    width: calc(100% - 2em);
    max-width: 480px;
    display: none;
    z-index: 60;
  }

  .nav-items--open {
    display: flex;
  }

  .nav-item {
    width: 100%;
    text-align: center;
    padding: 0.6em 0.75em;
  }
}
</style>
