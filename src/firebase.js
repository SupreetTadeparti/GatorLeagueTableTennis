// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyCbs73wR3L5gXoyJP1xxKNDbwzC78BKg1o",
  authDomain: "gator-league-table-tennis.firebaseapp.com",
  projectId: "gator-league-table-tennis",
  storageBucket: "gator-league-table-tennis.firebasestorage.app",
  messagingSenderId: "660958759539",
  appId: "1:660958759539:web:7ad81dcd620e979b423806",
  measurementId: "G-CEVLSSPW3J",
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

export { app, db, auth };
