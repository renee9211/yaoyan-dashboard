{
  "name": "yaoyan-dashboard-functions",
  "version": "1.0.0",
  "private": true,
  "description": "Google Calendar to Firestore project synchronization for Yaoyan Dashboard",
  "main": "index.js",
  "engines": {
    "node": "22"
  },
  "scripts": {
    "test": "node --test",
    "check": "node --check index.js && node --check calendar-sync.js && node --check calendar-utils.js"
  },
  "dependencies": {
    "firebase-admin": "14.2.0",
    "firebase-functions": "7.3.2",
    "googleapis": "174.0.1"
  }
}
