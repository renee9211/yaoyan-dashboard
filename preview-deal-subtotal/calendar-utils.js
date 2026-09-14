"use strict";

const { google } = require("googleapis");
const {
  FieldValue,
  Timestamp,
  getFirestore
} = require("firebase-admin/firestore");
const {
  addIsoDays,
  calendarEventToProject,
  formatDateInTimeZone,
  projectDocumentId
} = require("./calendar-utils");

const CALENDAR_ID = "yaoyanfx@gmail.com";
const CALENDAR_TIME_ZONE = "Asia/Taipei";
const INITIAL_IMPORT_DAYS_PAST = 30;
const LEASE_MILLISECONDS = 4 * 60 * 1000;
const WRITE_CHUNK_SIZE = 300;
const STATE_DOCUMENT = "systemIntegrations/googleCalendar_yaoyanfx";

class CalendarSyncBusyError extends Error {
  constructor() {
    super("Calendar synchronization is already running.");
    this.name = "CalendarSyncBusyError";
  }
}

function errorStatusCode(error) {
  return Number(error?.code || error?.response?.status || error?.response?.statusCode || 0);
}

function emptySummary() {
  return { created: 0, updated: 0, cancelled: 0, restored: 0, ignored: 0 };
}

function addSummary(target, source) {
  Object.keys(target).forEach(key => { target[key] += Number(source?.[key] || 0); });
  return target;
}

async function acquireLease(stateRef, owner) {
  const db = getFirestore();
  const now = Date.now();
  return db.runTransaction(async transaction => {
    const snapshot = await transaction.get(stateRef);
    const data = snapshot.exists ? snapshot.data() : {};
    const leaseUntil = data.leaseUntil?.toMillis?.() || 0;
    if (leaseUntil > now) return false;

    transaction.set(stateRef, {
      calendarId: CALENDAR_ID,
      timeZone: CALENDAR_TIME_ZONE,
      leaseOwner: owner,
      leaseUntil: Timestamp.fromMillis(now + LEASE_MILLISECONDS),
      lastAttemptAt: FieldValue.serverTimestamp()
    }, { merge: true });
    return true;
  });
}

async function releaseLeaseWithError(stateRef, error) {
  await stateRef.set({
    leaseOwner: FieldValue.delete(),
    leaseUntil: FieldValue.delete(),
    lastErrorAt: FieldValue.serverTimestamp(),
    lastError: String(error?.message || error).slice(0, 1000)
  }, { merge: true });
}

async function writeEventPage(events, seenProjectIds) {
  const db = getFirestore();
  const summary = emptySummary();

  for (let offset = 0; offset < events.length; offset += WRITE_CHUNK_SIZE) {
    const chunk = events.slice(offset, offset + WRITE_CHUNK_SIZE)
      .filter(event => event?.id);
    if (!chunk.length) continue;

    const refs = chunk.map(event => db.collection("projects").doc(projectDocumentId(CALENDAR_ID, event.id)));
    const snapshots = await db.getAll(...refs);
    const batch = db.batch();
    let writes = 0;

    chunk.forEach((event, index) => {
      const ref = refs[index];
      const snapshot = snapshots[index];
      const existing = snapshot.exists ? snapshot.data() : null;

      if (event.status === "cancelled") {
        if (!existing) {
          summary.ignored += 1;
          return;
        }
        seenProjectIds?.add(ref.id);
        if (existing.calendarSyncStatus === "cancelled") {
          summary.ignored += 1;
          return;
        }
        batch.set(ref, {
          calendarSyncStatus: "cancelled",
          calendarDeletedAt: FieldValue.serverTimestamp(),
          calendarDeleteReason: "event_cancelled",
          calendarLastSyncedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        summary.cancelled += 1;
        writes += 1;
        return;
      }

      const mapped = calendarEventToProject(event, {
        calendarId: CALENDAR_ID,
        timeZone: CALENDAR_TIME_ZONE
      });
      if (!mapped) {
        summary.ignored += 1;
        return;
      }

      seenProjectIds?.add(ref.id);
      const common = {
        ...mapped,
        calendarLastSyncedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      };

      if (!snapshot.exists) {
        batch.set(ref, {
          ...common,
          client: "",
          status: "planning",
          quote: 0,
          quoteTaxMode: "taxed",
          revenue: 0,
          cost: 0,
          equipmentsUsed: [],
          note: "",
          createdAt: FieldValue.serverTimestamp()
        });
        summary.created += 1;
      } else {
        batch.set(ref, {
          ...common,
          calendarDeletedAt: FieldValue.delete(),
          calendarDeleteReason: FieldValue.delete()
        }, { merge: true });
        if (existing?.calendarSyncStatus === "cancelled") summary.restored += 1;
        else summary.updated += 1;
      }
      writes += 1;
    });

    if (writes) await batch.commit();
  }

  return summary;
}

async function reconcileMissingProjects(seenProjectIds, cutoffIso) {
  const db = getFirestore();
  const snapshot = await db.collection("projects")
    .where("calendarId", "==", CALENDAR_ID)
    .get();
  const candidates = snapshot.docs.filter(docSnapshot => {
    const data = docSnapshot.data();
    return data.calendarSyncStatus !== "cancelled" &&
      String(data.startDate || "") >= cutoffIso &&
      !seenProjectIds.has(docSnapshot.id);
  });

  let cancelled = 0;
  for (let offset = 0; offset < candidates.length; offset += WRITE_CHUNK_SIZE) {
    const batch = db.batch();
    candidates.slice(offset, offset + WRITE_CHUNK_SIZE).forEach(docSnapshot => {
      batch.set(docSnapshot.ref, {
        calendarSyncStatus: "cancelled",
        calendarDeletedAt: FieldValue.serverTimestamp(),
        calendarDeleteReason: "missing_after_full_sync",
        calendarLastSyncedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      cancelled += 1;
    });
    await batch.commit();
  }
  return cancelled;
}

async function performCalendarRequests(calendar, options) {
  const { syncToken, cutoffIso, reconcileAfterFullSync } = options;
  const summary = emptySummary();
  const seenProjectIds = new Set();
  let nextPageToken;
  let nextSyncToken;

  do {
    const params = {
      calendarId: CALENDAR_ID,
      maxResults: 2500,
      pageToken: nextPageToken,
      showDeleted: true,
      singleEvents: true,
      timeZone: CALENDAR_TIME_ZONE,
      eventTypes: ["default"]
    };
    if (syncToken) params.syncToken = syncToken;
    else params.timeMin = `${cutoffIso}T00:00:00+08:00`;

    const response = await calendar.events.list(params);
    addSummary(summary, await writeEventPage(response.data.items || [], seenProjectIds));
    nextPageToken = response.data.nextPageToken || undefined;
    nextSyncToken = response.data.nextSyncToken || nextSyncToken;
  } while (nextPageToken);

  if (!syncToken && reconcileAfterFullSync) {
    summary.cancelled += await reconcileMissingProjects(seenProjectIds, cutoffIso);
  }

  return { summary, nextSyncToken };
}

async function writeAuditLog(summary) {
  const changed = summary.created + summary.updated + summary.cancelled + summary.restored;
  if (!changed) return;
  const db = getFirestore();
  await db.collection("auditLogs").add({
    actorUid: "system",
    actorEmail: CALENDAR_ID,
    action: "sync",
    module: "projects",
    targetType: "calendar",
    targetId: CALENDAR_ID,
    targetName: "Google Calendar",
    summary: `行事曆同步｜新增 ${summary.created}、更新 ${summary.updated}、刪除標示 ${summary.cancelled}、恢復 ${summary.restored}`,
    createdAt: FieldValue.serverTimestamp()
  });
}

async function runCalendarSync({ owner = "scheduler" } = {}) {
  const db = getFirestore();
  const stateRef = db.doc(STATE_DOCUMENT);
  if (!await acquireLease(stateRef, owner)) throw new CalendarSyncBusyError();

  try {
    const stateSnapshot = await stateRef.get();
    const state = stateSnapshot.exists ? stateSnapshot.data() : {};
    const wasInitialized = Boolean(state.initializedAt);
    const todayIso = formatDateInTimeZone(new Date(), CALENDAR_TIME_ZONE);
    const cutoffIso = addIsoDays(todayIso, -INITIAL_IMPORT_DAYS_PAST);
    const auth = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/calendar.readonly"]
    });
    const calendar = google.calendar({ version: "v3", auth });

    let result;
    try {
      result = await performCalendarRequests(calendar, {
        syncToken: state.syncToken || "",
        cutoffIso,
        reconcileAfterFullSync: wasInitialized
      });
    } catch (error) {
      if (!state.syncToken || errorStatusCode(error) !== 410) throw error;
      result = await performCalendarRequests(calendar, {
        syncToken: "",
        cutoffIso,
        reconcileAfterFullSync: true
      });
    }

    await writeAuditLog(result.summary);
    await stateRef.set({
      calendarId: CALENDAR_ID,
      timeZone: CALENDAR_TIME_ZONE,
      syncToken: result.nextSyncToken || FieldValue.delete(),
      initializedAt: state.initializedAt || FieldValue.serverTimestamp(),
      lastSuccessAt: FieldValue.serverTimestamp(),
      lastSummary: result.summary,
      lastError: FieldValue.delete(),
      lastErrorAt: FieldValue.delete(),
      leaseOwner: FieldValue.delete(),
      leaseUntil: FieldValue.delete()
    }, { merge: true });

    return result.summary;
  } catch (error) {
    await releaseLeaseWithError(stateRef, error);
    throw error;
  }
}

module.exports = {
  CALENDAR_ID,
  CalendarSyncBusyError,
  runCalendarSync
};
