import { createRouter, createWebHistory } from "vue-router";
import Home from "./routes/Home.vue";
import Authenticate from "./routes/Authenticate.vue";
import Standings from "./routes/Standings.vue";
import Schedule from "./routes/Schedule.vue";
import Register from "./routes/Register.vue";
import Account from "./routes/Account.vue";
import Results from "./routes/Results.vue";
import Ratings from "./routes/Ratings.vue";

const routes = [
  { path: "/", component: Home },
  { path: "/standings", component: Standings },
  { path: "/schedule", component: Schedule },
  { path: "/register", component: Register },
  { path: "/account", component: Account },
  { path: "/results/:weekNum", component: Results },
  { path: "/ratings/:weekNum", component: Ratings },
  { path: "/authenticate", component: Authenticate },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

export default router;
