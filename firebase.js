// firebase.js (Google Login + Custom Claims role)

import { initializeApp } from "firebase/app";
import { getAnalytics, isSupported as analyticsSupported } from "firebase/analytics";

import { getFirestore } from "firebase/firestore";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  getIdTokenResult
} from "firebase/auth";

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

// Analytics（避免某些環境報錯）
try {
  if (await analyticsSupported()) getAnalytics(app);
} catch (_) {}

export const db = getFirestore(app);
export const auth = getAuth(app);

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

/**
 * 從 custom claims 取得 role（admin/editor/viewer）
 * 你的 Firestore rules 使用 request.auth.token.role，所以這裡也用同一把來源。
 */
export async function getUserRole(user) {
  if (!user) return null;
  const tokenResult = await getIdTokenResult(user, true);
  return tokenResult?.claims?.role ?? null;
}
