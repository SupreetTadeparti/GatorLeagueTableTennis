<script setup>
import Nav from "./components/Nav.vue";
</script>

<template>
  <div id="app-container">
    <Nav />
    <RouterView />
  </div>
</template>

<style scoped>
#app-container {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 0 10%;
}

.logo {
  width: 25em;
  padding: 1.5em;
}
</style>
