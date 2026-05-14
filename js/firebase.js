// Firebase config. Fill these in to enable the shared leaderboard.
// Until you do, the site falls back to localStorage (per-device scores).
//
// Setup:
//   1. Go to https://console.firebase.google.com/ and create a new project
//   2. Add a Web App → copy the firebaseConfig values into the object below
//   3. In the Firebase console, open Firestore Database → Create database (start in production mode)
//   4. Replace the default rules with the ones in README.md (Firestore rules section)
//   5. Commit + push. GitHub Pages will redeploy automatically.

export const firebaseConfig = {
  apiKey: "AIzaSyAZ7Oa8PEs1nhAqCTUZ8qdPVLZJSOPe9ac",
  authDomain: "daily-trivia-9a25a.firebaseapp.com",
  projectId: "daily-trivia-9a25a",
  storageBucket: "daily-trivia-9a25a.firebasestorage.app",
  messagingSenderId: "473934597875",
  appId: "1:473934597875:web:c8793424acf39a5e357186"
};

export const FIREBASE_ENABLED = Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);

let _db = null;

export async function getDb() {
  if (!FIREBASE_ENABLED) return null;
  if (_db) return _db;
  const { initializeApp } = await import("https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js");
  const { getFirestore } = await import("https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js");
  const app = initializeApp(firebaseConfig);
  _db = getFirestore(app);
  return _db;
}
