import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: "AIzaSyBx4B-VTMdjNVZAzls56ed4457mFoa_4Ac",

  authDomain: "gltt-v2.firebaseapp.com",

  projectId: "gltt-v2",

  storageBucket: "gltt-v2.firebasestorage.app",

  messagingSenderId: "303164256039",

  appId: "1:303164256039:web:6ccc909eff60c2a09a8302",
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
