// Phase 3 v8: one Firestore realtime listener per query, shared by all UI modules.
import { db } from "./firebase.js";
import {
  collection, onSnapshot, query, orderBy, limit
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const registry = new Map();

function queryKey(name, options) {
  return `${name}|${options.orderBy || "updatedAt"}|${options.direction || "desc"}|${options.limit || "all"}`;
}

function buildQuery(name, options) {
  const clauses = [orderBy(options.orderBy || "updatedAt", options.direction || "desc")];
  if (options.limit) clauses.push(limit(options.limit));
  return query(collection(db, name), ...clauses);
}

export function subscribeCollection(name, onData, { onError = null, ...options } = {}) {
  const key = queryKey(name, options);
  let entry = registry.get(key);
  if (!entry) {
    entry = { value: null, subscribers: new Set(), stop: null };
    registry.set(key, entry);
    entry.stop = onSnapshot(buildQuery(name, options), snapshot => {
      entry.value = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
      entry.subscribers.forEach(subscriber => subscriber.onData(entry.value));
    }, error => {
      console.error(`讀取 ${name} 失敗`, error);
      entry.value = [];
      entry.subscribers.forEach(subscriber => {
        subscriber.onData(entry.value);
        subscriber.onError?.(error);
      });
    });
  }

  const subscriber = { onData, onError };
  entry.subscribers.add(subscriber);
  if (entry.value !== null) queueMicrotask(() => {
    if (entry.subscribers.has(subscriber)) onData(entry.value);
  });

  return () => {
    entry.subscribers.delete(subscriber);
    if (entry.subscribers.size) return;
    entry.stop?.();
    registry.delete(key);
  };
}

export function createRenderScheduler(render) {
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      render();
    });
  };
}

export function activeListenerCount() {
  return registry.size;
}
