// Shared immutable audit trail helper. Business writes must not fail when logging is unavailable.
import { auth, db } from "./firebase.js";
import {
  addDoc, collection, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const auditLogs = collection(db, "auditLogs");

export async function logAction({ action, module, targetType, targetId = "", targetName = "", summary = "" }) {
  const user = auth.currentUser;
  if (!user) return;
  try {
    await addDoc(auditLogs, {
      action: String(action || "update"),
      module: String(module || "system"),
      targetType: String(targetType || "record"),
      targetId: String(targetId || ""),
      targetName: String(targetName || ""),
      summary: String(summary || ""),
      actorUid: user.uid,
      actorEmail: user.email || "",
      actorName: user.displayName || "",
      createdAt: serverTimestamp()
    });
  } catch (error) {
    console.warn("操作紀錄寫入失敗", error);
  }
}
