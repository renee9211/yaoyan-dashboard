"use strict";

const { initializeApp } = require("firebase-admin/app");
const { logger } = require("firebase-functions");
const { onSchedule } = require("firebase-functions/v2/scheduler");

initializeApp();

const {
  CalendarSyncBusyError,
  runCalendarSync
} = require("./calendar-sync");

exports.syncYaoyanCalendar = onSchedule({
  schedule: "every 5 minutes",
  timeZone: "Asia/Taipei",
  region: "asia-east1",
  memory: "256MiB",
  timeoutSeconds: 300,
  maxInstances: 1,
  concurrency: 1
}, async event => {
  try {
    const summary = await runCalendarSync({
      owner: event?.id || "scheduler"
    });
    logger.info("Yaoyan Google Calendar synchronization completed.", summary);
  } catch (error) {
    if (error instanceof CalendarSyncBusyError) {
      logger.info("Skipped overlapping Yaoyan Google Calendar synchronization.");
      return;
    }
    logger.error("Yaoyan Google Calendar synchronization failed.", error);
    throw error;
  }
});
