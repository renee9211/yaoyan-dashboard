// firebase.js（CDN 版本，適用於純 HTML / GitHub Pages）

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-analytics.js";

import {
  getFirestore
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  getIdTokenResult
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

// 🔐 Firebase 設定
const firebaseConfig = {
  apiKey: "AIzaSyDBF3pBxsjJx_VJF4_GHDvY6OQe7U4SCIc",
  authDomain: "yaoyan-fb9cb.firebaseapp.com",
  projectId: "yaoyan-fb9cb",
  storageBucket: "yaoyan-fb9cb.firebasestorage.app",
  messagingSenderId: "288682348042",
  appId: "1:288682348042:web:1fe4657eaf7fa9c5ba59f3",
  measurementId: "G-XYYM91DRLX"
};

// 🔧 初始化
export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);

try {
  getAnalytics(app);
} catch (_) {}

// 🔑 Google 登入
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

export function watchAuth(cb) {
  return
