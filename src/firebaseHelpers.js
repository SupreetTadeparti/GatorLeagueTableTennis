import {
  ref as storageRef,
  uploadBytesResumable,
  getDownloadURL,
} from "firebase/storage";
import { storage, db } from "./firebase";
import { doc, updateDoc, serverTimestamp } from "firebase/firestore";
import { collection, addDoc, setDoc, getDoc } from "firebase/firestore";

// Check admins collection for an email-based whitelist entry
export async function isUserAdminByEmail(email) {
  const normalizedEmail = email?.trim().toLowerCase();
  if (!normalizedEmail) return false;
  try {
    const docRef = doc(db, "admins", normalizedEmail);
    const snap = await getDoc(docRef);
    return snap.exists();
  } catch (e) {
    console.error("isUserAdminByEmail failed", e);
    return false;
  }
}

export async function uploadPlayerPhoto(file, uid) {
  const ref = storageRef(
    storage,
    `playerPhotos/${uid}/${Date.now()}_${file.name}`,
  );
  const task = uploadBytesResumable(ref, file);
  await new Promise((res, rej) => {
    task.on("state_changed", null, rej, res);
  });
  const url = await getDownloadURL(ref);
  // Optionally save to player doc
  const playerDoc = doc(db, "players", uid);
  await updateDoc(playerDoc, {
    profilePhotoUrl: url,
    updatedAt: serverTimestamp(),
  });
  return url;
}

export async function uploadWinnerPhoto(file, tournamentId) {
  const ref = storageRef(
    storage,
    `tournamentPhotos/${tournamentId}/${Date.now()}_${file.name}`,
  );
  const task = uploadBytesResumable(ref, file);
  await new Promise((res, rej) => {
    task.on("state_changed", null, rej, res);
  });
  const url = await getDownloadURL(ref);
  // Save to tournament doc
  const tournamentDoc = doc(db, "tournaments", tournamentId);
  await updateDoc(tournamentDoc, {
    winnerPhotoUrl: url,
    winnerPhotoUploadedAt: serverTimestamp(),
  });
  return url;
}

export async function uploadFileToPath(file, path) {
  const ref = storageRef(storage, `${path}/${Date.now()}_${file.name}`);
  const task = uploadBytesResumable(ref, file);
  await new Promise((res, rej) => {
    task.on("state_changed", null, rej, res);
  });
  return await getDownloadURL(ref);
}

export async function createRegistration(
  {
    fullName,
    submittedRating,
    claimPaymentMethod,
    claimPaymentDate,
    paymentNote,
    authUid,
  },
  file,
) {
  // create registration doc with initial data
  const data = {
    fullName,
    submittedRating: submittedRating ?? null,
    claimPaymentMethod: claimPaymentMethod ?? null,
    claimPaymentDate: claimPaymentDate ?? null,
    paymentNote: paymentNote ?? null,
    authUid: authUid ?? null,
    registrationPhotoUrl: null,
    submittedAt: serverTimestamp(),
    registrationStatus: "pending",
  };

  const ref = await addDoc(collection(db, "registrations"), data);
  const regId = ref.id;

  if (file) {
    const url = await uploadFileToPath(file, `registrationPhotos/${regId}`);
    await updateDoc(doc(db, "registrations", regId), {
      registrationPhotoUrl: url,
    });
  }

  return regId;
}

export async function createPlayerFromRegistration(registrationId) {
  const regRef = doc(db, "registrations", registrationId);
  const snap = await getDoc(regRef);
  if (!snap.exists()) throw new Error("Registration not found");
  const reg = snap.data();

  const playerId = reg.authUid || registrationId;
  const playerRef = doc(db, "players", playerId);
  await setDoc(playerRef, {
    fullName: reg.fullName,
    currentRating: reg.submittedRating ?? 1000,
    totalPoints: 0,
    profilePhotoUrl: reg.registrationPhotoUrl ?? null,
    authUid: reg.authUid ?? null,
    registrationId,
    createdAt: serverTimestamp(),
  });

  // mark registration as approved
  await updateDoc(regRef, { registrationStatus: "approved" });
  return playerId;
}

// Create sample data for testing and demo
export async function createSampleTournamentData() {
  try {
    // Create sample players
    const playerNames = [
      "Alice Johnson",
      "Bob Smith",
      "Charlie Davis",
      "Diana Martinez",
      "Eve Wilson",
      "Frank Brown",
      "Grace Lee",
      "Henry Taylor",
      "Iris Anderson",
      "Jack Miller",
      "Karen Thomas",
      "Leo Jackson",
      "Maya White",
      "Noah Harris",
      "Olivia Clark",
      "Paul Rodriguez",
      "Quinn Lewis",
      "Rachel Moore",
      "Sam Young",
      "Tina Allen",
      "Ulysses Hernandez",
      "Violet King",
      "William Wright",
      "Ximena Lopez",
      "Yoshi Scott",
      "Zoe Green",
      "Aaron Adams",
      "Bella Nelson",
      "Cody Carter",
      "Daisy Mitchell",
      "Ethan Perez",
      "Fiona Roberts",
    ];

    const playerIds = [];
    for (const name of playerNames) {
      const playerId = `player-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      await setDoc(doc(db, "players", playerId), {
        fullName: name,
        currentRating: 1000 + Math.random() * 400,
        totalPoints: 0,
        email: null,
        profilePhotoUrl: null,
        createdAt: serverTimestamp(),
      });
      playerIds.push(playerId);
    }

    // Create a tournament
    const tournamentId = `tournament-${Date.now()}`;
    await setDoc(doc(db, "tournaments", tournamentId), {
      name: "Sample Tournament",
      date: new Date().toLocaleDateString(),
      status: "active",
      format: "groups_and_bracket",
      createdAt: serverTimestamp(),
      winnerPhotoUrl: null,
      liveUrl: null,
      isLive: false,
    });

    console.log(
      `✅ Created ${playerNames.length} sample players and 1 tournament`,
    );
    console.log("Tournament ID:", tournamentId);
    console.log("Player IDs:", playerIds);
    return { tournamentId, playerIds };
  } catch (e) {
    console.error("createSampleTournamentData failed:", e);
    throw e;
  }
}
