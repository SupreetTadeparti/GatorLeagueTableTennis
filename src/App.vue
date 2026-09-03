<script setup>
import NavBar from "./components/NavBar.vue";
</script>

<template>
  <NavBar />
  <div id="main-app">
    <RouterView />
  </div>
</template>

<style>
#main-app {
  padding: 0.5em 0;
}
</style>
