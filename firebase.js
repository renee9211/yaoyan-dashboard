// firebase.js（CDN 版本，適用純 HTML / GitHub Pages）

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-analytics.js";
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
  getIdTokenResult
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

try {
  getAnalytics(app);
} catch (_) {}

// ✅ 讓外部也可以用（如果你 app.js 需要）
export const provider = new GoogleAuthProvider();
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

/**
 * ✅ 確保 Firestore 有 /users/{uid}
 * - 第一次登入：建立一筆 role=viewer
 * - 之後登入：更新 lastLoginAt
 */
export async function ensureUserDoc(user) {
  if (!user) return;

  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);

  if (!snap.exists()) {
    await setDoc(ref, {
      uid: user.uid,
      email: user.email || "",
      name: user.displayName || "",
      role: "viewer",
      createdAt: serverTimestamp(),
      lastLoginAt: serverTimestamp()
    });
  } else {
    await setDoc(ref, { lastLoginAt: serverTimestamp() }, { merge: true });
  }
}

/**
 * 你的原本 getUserRole：用 token claims 讀 role
 * - 如果你目前沒有在後台設定 custom claims，會永遠是 viewer
 * - 你也可以之後改成讀 Firestore users/{uid}.role（需要我再幫你改）
 */
export async function getUserRole(user) {
  if (!user) return "viewer";
  const token = await getIdTokenResult(user, true);
  return token?.claims?.role ?? "viewer";
}
