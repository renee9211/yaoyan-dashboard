"use strict";

const { createHash } = require("node:crypto");

function projectDocumentId(calendarId, eventId) {
  const digest = createHash("sha256")
    .update(`${calendarId}\n${eventId}`)
    .digest("hex");
  return `gcal_${digest}`;
}

function formatDateInTimeZone(value, timeZone = "Asia/Taipei") {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addIsoDays(isoDate, amount) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(isoDate || ""))) return "";
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function eventDateRange(event, timeZone = "Asia/Taipei") {
  const startDateOnly = event?.start?.date;
  if (startDateOnly) {
    const exclusiveEnd = event?.end?.date || addIsoDays(startDateOnly, 1);
    const inclusiveEnd = addIsoDays(exclusiveEnd, -1) || startDateOnly;
    return {
      startDate: startDateOnly,
      endDate: inclusiveEnd < startDateOnly ? startDateOnly : inclusiveEnd,
      isAllDay: true
    };
  }

  const startDateTime = event?.start?.dateTime;
  if (!startDateTime) return null;
  const endDateTime = event?.end?.dateTime || startDateTime;
  const startDate = formatDateInTimeZone(startDateTime, timeZone);
  const endDate = formatDateInTimeZone(endDateTime, timeZone) || startDate;
  if (!startDate) return null;

  return {
    startDate,
    endDate: endDate < startDate ? startDate : endDate,
    isAllDay: false
  };
}

function calendarEventToProject(event, options = {}) {
  const calendarId = options.calendarId || "";
  const timeZone = options.timeZone || "Asia/Taipei";
  const range = eventDateRange(event, timeZone);
  if (!range) return null;

  return {
    name: String(event.summary || "未命名活動").trim() || "未命名活動",
    location: String(event.location || "").trim(),
    startDate: range.startDate,
    endDate: range.endDate,
    calendarSource: "google_calendar",
    calendarId,
    calendarEventId: String(event.id || ""),
    calendarEventLink: String(event.htmlLink || ""),
    calendarEventUpdatedAt: event.updated ? new Date(event.updated) : null,
    calendarSyncStatus: "active",
    calendarAllDay: range.isAllDay
  };
}

module.exports = {
  addIsoDays,
  calendarEventToProject,
  eventDateRange,
  formatDateInTimeZone,
  projectDocumentId
};
