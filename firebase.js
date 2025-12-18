// firebase.js
import { initializeApp } from "firebase/app";
import { getAnalytics, isSupported as analyticsSupported } from "firebase/analytics";

import { getFirestore } from "firebase/firestore";
import { getAuth, signInAnonymously, onAuthStateChanged } from "firebase/auth";

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

// Analytics（有些環境不支援，避免報錯）
try {
  if (await analyticsSupported()) getAnalytics(app);
} catch (_) { /* ignore */ }

export const db = getFirestore(app);
export const auth = getAuth(app);

// 自動匿名登入（不同電腦也能讀寫同一份 Firestore 資料）
export function ensureSignedIn() {
  return new Promise((resolve, reject) => {
    const unsub = onAuthStateChanged(auth, async (user) => {
      try {
        if (user) {
          unsub();
          resolve(user);
          return;
        }
        await signInAnonymously(auth);
      } catch (e) {
        unsub();
        reject(e);
      }
    });
  });
}
