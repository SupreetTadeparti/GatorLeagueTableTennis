import { createWebHistory, createRouter } from "vue-router";

import HomeView from "./routes/HomeView.vue";
import TournamentView from "./routes/TournamentView.vue";
import StandingsView from "./routes/StandingsView.vue";
import ProfileView from "./routes/ProfileView.vue";
import ArchiveView from "./routes/ArchiveView.vue";
import AdminView from "./routes/AdminView.vue";
import RegisterView from "./routes/RegisterView.vue";
import SignInView from "./routes/SignInView.vue";
import { auth } from "./firebase";
import { isUserAdminByEmail } from "./firebaseHelpers";

const routes = [
  { path: "/", component: HomeView },
  { path: "/tournament", component: TournamentView },
  { path: "/standings", component: StandingsView },
  { path: "/profile", component: ProfileView },
  { path: "/archive", component: ArchiveView },
  { path: "/admin", component: AdminView },
  { path: "/register", component: RegisterView },
  { path: "/signin", component: SignInView },
  { path: "/signin/", component: SignInView },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

// Simple route guard for /admin using the email whitelist.
router.beforeEach(async (to, from, next) => {
  if (to.path !== "/admin") return next();

  const u = auth.currentUser;
  if (!u) return next({ path: "/signin" });

  try {
    const allowed = await isUserAdminByEmail(u.email);
    if (allowed) return next();
  } catch (e) {
    console.error("admin guard check failed", e);
  }

  return next({ path: "/" });
});
