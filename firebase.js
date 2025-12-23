// firebase.js（CDN 版本，適用純 HTML / GitHub Pages）

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAnalytics, isSupported } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-analytics.js";

import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  getRedirectResult
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyDBF3pBxsjJx_VJF4_GHDvY6OQe7U4SCIc",
  authDomain: "yaoyan-fb9cb.firebaseapp.com",
  projectId: "yaoyan-fb9cb",
  storageBucket: "yaoyan-fb9cb.firebasestorage.app",
  messagingSenderId: "288682348042",
  appId: "1:288682348042:web:1fe4657eaf7fa9c5ba59f3",
  measurementId: "G-XYYM91DRLX"
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);

(async () => {
  try {
    const ok = await isSupported();
    if (ok) getAnalytics(app);
  } catch (_) {}
})();

const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

export function watchAuth(cb) {
  return onAuthStateChanged(auth, cb);
}

export async function loginWithGoogle() {
  return await signInWithPopup(auth, provider);
}

export async function logout() {
  return await signOut(auth);
}

export async function handleRedirectResult() {
  try {
    return await getRedirectResult(auth);
  } catch (_) {
    return null;
  }
}

export async function ensureUserDoc(user) {
  if (!user) return;

  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);

  if (!snap.exists()) {
    await setDoc(
      ref,
      {
        email: user.email || "",
        displayName: user.displayName || "",
        role: "viewer",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      },
      { merge: true }
    );
  } else {
    await setDoc(ref, { updatedAt: serverTimestamp() }, { merge: true });
  }
}

export async function getUserRole(user) {
  if (!user) return "viewer";
  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  return snap.exists() ? (snap.data().role || "viewer") : "viewer";
}
