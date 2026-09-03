<script setup>
import { ref, computed } from "vue";
import { auth } from "../firebase";
import { signOut } from "firebase/auth";
import { useRouter } from "vue-router";
import { isUserAdminByEmail } from "../firebaseHelpers";

const user = ref(auth.currentUser);
const isAdmin = ref(false);

auth.onAuthStateChanged(async (u) => {
  user.value = u;
  isAdmin.value = false;
  if (!u) return;
  try {
    isAdmin.value = await isUserAdminByEmail(u.email);
  } catch (e) {
    isAdmin.value = false;
  }
});

const showRegister = computed(
  () => !user.value /* or check players collection */,
);

const isMenuOpen = ref(false);
const router = useRouter();

async function signOutUser() {
  try {
    await signOut(auth);
    router.push("/");
  } catch (e) {
    console.error("Sign out failed", e);
  }
}

const navItems = [
  { label: "Weekly", to: "/weekly" },
  { label: "Standings", to: "/standings" },
  { label: "Archive", to: "/archive" },
  { label: "Profile", to: "/profile" },
];

const visibleNavItems = computed(() => {
  return navItems.filter((item) => {
    if (item.label === "Profile") return !!user.value;
    return true;
  });
});

function closeMenu() {
  isMenuOpen.value = false;
}
</script>

<template>
  <header class="nav-shell">
    <div class="nav-bar">
      <RouterLink to="/" class="brand" @click="closeMenu">
        <img src="/glnlogonav.png" alt="Logo" class="logo" />
      </RouterLink>

      <button
        class="menu-toggle"
        :class="{ active: isMenuOpen }"
        :aria-expanded="isMenuOpen"
        aria-label="Toggle navigation"
        @click="isMenuOpen = !isMenuOpen"
      >
        <span></span>
        <span></span>
        <span></span>
      </button>

      <!-- Everything below collapses into the burger menu together on mobile -->
      <div class="nav-menu" :class="{ open: isMenuOpen }">
        <nav class="nav-links">
          <RouterLink
            v-for="item in visibleNavItems"
            :key="item.to"
            :to="item.to"
            class="nav-link"
            active-class="active"
            @click="closeMenu"
          >
            {{ item.label }}
          </RouterLink>
        </nav>

        <div class="auth-actions">
          <template v-if="!user">
            <RouterLink to="/signin" class="nav-link" @click="closeMenu"
              >Sign In</RouterLink
            >
            <RouterLink
              to="/register"
              class="register-button"
              @click="closeMenu"
              >Register</RouterLink
            >
          </template>

          <template v-else>
            <RouterLink v-if="isAdmin" to="/admin" class="admin-pill"
              >Admin</RouterLink
            >
            <button class="signout-btn" @click="signOutUser">Sign Out</button>
          </template>
        </div>
      </div>
    </div>
  </header>
</template>

<style scoped>
.nav-shell {
  padding: 1rem 0;
}

.nav-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.9rem 1rem;
  background: rgba(15, 15, 15, 0.88);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 0.5em;
  box-shadow: 0 10px 35px rgba(0, 0, 0, 0.35);
  backdrop-filter: blur(16px);
}

.brand {
  display: flex;
  align-items: center;
}

.logo {
  width: 180px;
  height: auto;
}

.menu-toggle {
  display: none;
  flex-direction: column;
  justify-content: center;
  gap: 0.32rem;
  width: 46px;
  height: 46px;
  border: 0;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.05);
  cursor: pointer;
  transition:
    transform 0.2s ease,
    background 0.2s ease;
}

.menu-toggle:hover {
  background: rgba(255, 255, 255, 0.1);
  transform: translateY(-1px);
}

.menu-toggle span {
  display: block;
  width: 22px;
  height: 2px;
  margin: 0 auto;
  background: hsl(var(--primary-color));
  border-radius: 999px;
  transition: all 0.25s ease;
}

.menu-toggle.active span:nth-child(1) {
  transform: translateY(6px) rotate(45deg);
}

.menu-toggle.active span:nth-child(2) {
  opacity: 0;
}

.menu-toggle.active span:nth-child(3) {
  transform: translateY(-6px) rotate(-45deg);
}

/* Desktop: nav links + auth actions sit side by side in one row */
.nav-menu {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.nav-links {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.nav-link {
  text-decoration: none;
  color: #e8e8e8;
  font-weight: 600;
  padding: 0.7rem 0.95rem;
  border-radius: 100vh;
  transition:
    background 0.2s ease,
    color 0.2s ease,
    transform 0.2s ease;
}

.nav-link:hover,
.nav-link.active {
  color: hsl(var(--primary-color));
  background: rgba(255, 255, 255, 0.08);
  transform: translateY(-1px);
}

.auth-actions {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

/* Flat, no gradient, no glow — Register is the one accent-colored action */
.register-button {
  text-decoration: none;
  background: #2c5480;
  color: #f4f7fb;
  font-weight: 700;
  padding: 0.6rem 1rem;
  border-radius: 999px;
  border: 0;
  transition:
    background 0.2s ease,
    transform 0.2s ease;
}

.register-button:hover {
  background: #35638f;
  transform: translateY(-1px);
}

/* Flat, muted, outlined — deliberately quieter than Register since it's not a primary action */
.admin-pill {
  text-decoration: none;
  background: transparent;
  color: #a3a3a3;
  font-weight: 600;
  padding: 0.55rem 0.9rem;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.15);
  transition:
    color 0.2s ease,
    border-color 0.2s ease,
    transform 0.2s ease;
}

.admin-pill:hover {
  color: #e8e8e8;
  border-color: rgba(255, 255, 255, 0.3);
  transform: translateY(-1px);
}

.signout-btn {
  background: transparent;
  color: #a3a3a3;
  font-weight: 600;
  padding: 0.55rem 0.9rem;
  border: 1px solid rgba(217, 48, 42, 0.4);
  border-radius: 999px;
  cursor: pointer;
  transition:
    background 0.2s ease,
    border-color 0.2s ease,
    transform 0.2s ease;
}

.signout-btn:hover {
  color: #e8e8e8;
  background: rgba(217, 48, 42, 0.08);
  border-color: rgba(217, 48, 42, 0.7);
  transform: translateY(-1px);
}

@media (max-width: 800px) {
  .nav-shell {
    padding: 0.75rem 0.75rem 1rem;
  }

  .nav-bar {
    border-radius: 1.2rem;
    padding: 0.8rem 0.9rem;
    position: relative;
    flex-wrap: wrap;
  }

  .menu-toggle {
    display: flex;
  }

  /* nav links AND auth actions collapse into the same dropdown now */
  .nav-menu {
    position: absolute;
    top: calc(100% + 0.6rem);
    left: 0;
    right: 0;
    flex-direction: column;
    align-items: stretch;
    gap: 0.35rem;
    padding: 0.75rem;
    background: rgba(12, 12, 12, 0.95);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.5em;
    box-shadow: 0 14px 35px rgba(0, 0, 0, 0.4);
    display: none;
  }

  .nav-menu.open {
    display: flex;
  }

  .nav-links,
  .auth-actions {
    flex-direction: column;
    align-items: stretch;
    gap: 0.35rem;
  }

  .nav-link,
  .register-button,
  .admin-pill,
  .signout-btn {
    text-align: center;
    padding: 0.9rem 1rem;
  }
}
</style>
