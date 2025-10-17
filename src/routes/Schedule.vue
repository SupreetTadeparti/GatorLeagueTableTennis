<script setup>
import { db } from "../firebase.js";
import { getAuth, onAuthStateChanged } from "firebase/auth";
import {
  getDocs,
  collection,
  deleteDoc,
  doc,
  addDoc,
} from "firebase/firestore";
import { onMounted, ref, computed } from "vue";

const auth = getAuth();
const user = ref(null);

const isAdmin = computed(() => user.value?.email === "glttadmin@gmail.com"); // Replace with your admin email

onAuthStateChanged(auth, (u) => {
  user.value = u;
});

// form state
const showAddForm = ref(false);
const newEventDate = ref("");

const calculateNextWeek = () => {
  if (!eventList.value.length) return 1;
  const maxWeek = Math.max(...eventList.value.map((e) => e.weekNum));
  return maxWeek + 1;
};

const deleteEvent = async (eventId) => {
  if (!isAdmin.value) return;

  try {
    await deleteDoc(doc(db, "events", eventId));
    // Remove from local lists
    const removeFromList = (list) => {
      const idx = list.value.findIndex((e) => e.id === eventId);
      if (idx !== -1) list.value.splice(idx, 1);
    };
    removeFromList(eventList);
    removeFromList(upcomingEvents);
    removeFromList(pastEvents);
  } catch (error) {
    console.error("Error deleting event:", error);
    alert("Failed to delete event");
  }
};

const addNewEvent = async () => {
  if (!newEventDate.value) {
    alert("Please select a date");
    return;
  }

  const [year, month, day] = newEventDate.value.split("-");
  const mm = month.padStart(2, "0");
  const dd = day.padStart(2, "0");
  const yy = (parseInt(year) % 100).toString().padStart(2, "0");
  const dateNum = parseInt(mm + dd + yy);

  // Get player list and create object with id: rating pairs and
  // assign to initial and final player rating list

  try {
    const nextWeek = calculateNextWeek();
    const newEvent = {
      date: dateNum,
      weekNum: nextWeek,
      matchList: [],
      initialRatings: [],
      finalRatings: [],
    };

    await addDoc(collection(db, "events"), newEvent);

    // Reset form
    newEventDate.value = "";
    showAddForm.value = false;

    // Refresh events
    await fetchEvents();
  } catch (error) {
    console.error("Error adding event:", error);
    alert("Failed to add event");
  }
};

// Date in format MMDDYY to "Month Day, Year"
const stringifyDate = (date) => {
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];

  const year = date % 100;
  date = Math.floor(date / 100);
  const day = date % 100;
  date = Math.floor(date / 100);
  const month = date - 1;

  return months[month] + " " + day + ", 20" + year;
};

// parse date number with format MMDDYY into a JS Date at 7:00 PM local time
const parseDateNumberToDate = (dateNum) => {
  const n = Number(dateNum);
  if (!Number.isFinite(n)) return null;

  let tmp = Math.floor(n);
  const yearTwo = tmp % 100;
  tmp = Math.floor(tmp / 100);
  const day = tmp % 100;
  tmp = Math.floor(tmp / 100);
  const month = tmp - 1;

  const year = 2000 + yearTwo;
  const monthClamped = Math.max(0, Math.min(11, month));

  return new Date(year, monthClamped, day, 19, 0, 0);
};

const fetchEvents = async () => {
  const events = [];
  const querySnapshot = await getDocs(collection(db, "events"));
  querySnapshot.forEach((doc) => {
    const data = doc.data();
    const eventDate = parseDateNumberToDate(data.date);
    events.push({ id: doc.id, ...data, eventDate });
  });

  // sort by date ascending
  events.sort((a, b) => {
    if (!a.eventDate) return 1;
    if (!b.eventDate) return -1;
    return a.eventDate - b.eventDate;
  });

  const now = new Date();
  upcomingEvents.value = events.filter(
    (e) => e.eventDate && e.eventDate >= now
  );
  // past: events strictly before now, show most recent first
  pastEvents.value = events
    .filter((e) => e.eventDate && e.eventDate < now)
    .sort((a, b) => b.eventDate - a.eventDate);

  // keep a full list as well if needed elsewhere
  eventList.value = events.slice().reverse();
};

onAuthStateChanged(getAuth(), (user) => {
  isAdmin.value = !!user;
});

onMounted(() => {
  fetchEvents();
});

const eventList = ref([]);
const upcomingEvents = ref([]);
const pastEvents = ref([]);

const props = defineProps([]);
</script>

<template>
  <div class="page-container">
    <div class="events-container">
      <section class="upcoming">
        <h2>Upcoming Events</h2>
        <div v-if="upcomingEvents.length === 0">No upcoming events</div>
        <div v-for="event in upcomingEvents" :key="event.id" class="event">
          <div class="event__left">
            <h3>Week {{ event.weekNum }}</h3>
            <p>{{ stringifyDate(event.date) }} at 7 PM</p>
          </div>
          <div class="event__right">
            <button class="event__btn thick-btn event__btn--update">
              <RouterLink :to="`/ratings/${event.weekNum}`"
                >Updated Ratings</RouterLink
              >
            </button>
            <button class="event__btn thick-btn event__btn--results">
              <RouterLink :to="`/results/${event.weekNum}`">
                Results
              </RouterLink>
            </button>
            <button
              v-if="isAdmin"
              @click="deleteEvent(event.id)"
              class="event__btn thick-btn event__btn--delete"
              title="Delete Event"
            >
              X
            </button>
          </div>
        </div>
      </section>

      <section class="past" v-if="pastEvents.length">
        <h2>Past Events</h2>
        <div v-for="event in pastEvents" :key="event.id" class="event">
          <div class="event__left">
            <h3>Week {{ event.weekNum }}</h3>
            <p>{{ stringifyDate(event.date) }} at 7 PM</p>
          </div>
          <div class="event__right">
            <button class="event__btn thick-btn event__btn--update">
              <RouterLink :to="`/ratings/${event.weekNum}`"
                >Updated Ratings</RouterLink
              >
            </button>
            <button class="event__btn thick-btn event__btn--results">
              <RouterLink :to="`/results/${event.weekNum}`">
                Results
              </RouterLink>
            </button>
            <button
              v-if="isAdmin"
              @click="deleteEvent(event.id)"
              class="event__btn thick-btn event__btn--delete"
              title="Delete Event"
            >
              X
            </button>
          </div>
        </div>
      </section>

      <section>
        <!-- Add Event Form -->
        <div v-if="isAdmin" class="add-event">
          <button
            v-if="!showAddForm"
            @click="showAddForm = true"
            class="thick-btn add-btn"
          >
            Add New Event
          </button>
          <div v-else class="add-form">
            <input
              class="event-date-input"
              type="date"
              v-model="newEventDate"
            />
            <button @click="addNewEvent" class="thick-btn save-btn">
              Save
            </button>
            <button @click="showAddForm = false" class="thick-btn cancel-btn">
              Cancel
            </button>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.events-container {
  display: flex;
  flex-direction: column;
  gap: 3em;
}

.events-container > section {
  display: flex;
  flex-direction: column;
  gap: 2em;
}

.event {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border: 3px solid hsl(var(--gator-orange));
  border-radius: 0.5em;
  padding: 1em;
}

.event__left {
  display: flex;
  flex-direction: column;
  gap: 0.5em;
}

.event__right {
  display: flex;
  gap: 1em;
}

.event__btn {
  /* padding: 0.5em 1em;
  cursor: pointer;
  border: none; */
  font-size: 1.2em;
  /* border-radius: 0.25em;
  background-color: hsl(var(--gator-blue)); */
  color: #ccc;
}

.event__btn--update {
  --btn-clr: 0, 0%, 70%;
  color: #333;
}

.event__btn--delete {
  --btn-clr: hsl(0, 83%, 50%);
  --btn-clr: 0, 83%, 50%;
}

.add-event .thick-btn {
  font-size: 1.2em;
  color: #ccc;
}

.add-form {
  display: flex;
  gap: 1.5em;
}

.event-date-input {
  font-size: 0.9em;
  border-radius: 0.25em;
  border: none;
}

.cancel-btn {
  --btn-clr: 0, 0%, 50%;
}
</style>
