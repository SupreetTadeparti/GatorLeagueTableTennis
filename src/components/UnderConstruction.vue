<script setup>
defineProps({
  title: {
    type: String,
    default: "Page Under Construction",
  },
  message: {
    type: String,
    default: "We're still building this page. Check back soon.",
  },
});
</script>

<template>
  <div class="page">
    <div class="wrap">
      <div class="card">
        <div class="icon">🚧</div>
        <h1>{{ title }}</h1>
        <p class="message">{{ message }}</p>
        <router-link to="/weekly" class="home-link">Back to tournament</router-link>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page {
  margin-top: 10em;
  background: #0a0a0a;
  padding: 3rem 1.5rem 4rem;
  display: flex;
  justify-content: center;
  align-items: center;
}

.wrap {
  width: 100%;
  max-width: 480px;
}

.card {
  background: #111214;
  border: 1px solid #2a2b2f;
  border-radius: 10px;
  padding: 2.5rem 2rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 0.75rem;
}

.icon {
  font-size: 2.5rem;
  margin-bottom: 0.25rem;
}

h1 {
  color: #f5f5f5;
  font-size: 1.5rem;
  font-weight: 800;
  letter-spacing: 0.01em;
  margin: 0;
}

.message {
  color: #9ca3ae;
  font-size: 0.95rem;
  margin: 0;
  line-height: 1.5;
}

.home-link {
  margin-top: 1rem;
  color: #ffffff;
  background: #e0551f;
  border: none;
  border-radius: 999px;
  padding: 0.65rem 1.4rem;
  font-size: 0.9rem;
  font-weight: 700;
  text-decoration: none;
  transition: background 0.15s ease;
}

.home-link:hover {
  background: #ef632c;
}
</style>