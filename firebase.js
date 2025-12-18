// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyDBF3pBxsjJx_VJF4_GHDvY6OQe7U4SCIc",
  authDomain: "yaoyan-fb9cb.firebaseapp.com",
  projectId: "yaoyan-fb9cb",
  storageBucket: "yaoyan-fb9cb.firebasestorage.app",
  messagingSenderId: "288682348042",
  appId: "1:288682348042:web:1fe4657eaf7fa9c5ba59f3",
  measurementId: "G-XYYM91DRLX"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
