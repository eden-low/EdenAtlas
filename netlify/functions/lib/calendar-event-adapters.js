// Authoritative server-side facade for the pure EdenAtlas source adapters.
//
// The shared projection core is also used by the buildless Calendar UI. This facade adds the
// Phase 3B.1 canonical validator and deliberately implements no Firestore, provider, OAuth,
// environment, persistence, synchronization, or identity-generation behavior.

const model = require("./calendar-event-model.js");
const core = require("../../../js/calendar-event-adapter-core.js");

if (core.CALENDAR_ADAPTER_SCHEMA_VERSION !== model.CALENDAR_EVENT_SCHEMA_VERSION
    || core.CALENDAR_ADAPTER_TITLE_LIMIT !== model.CALENDAR_EVENT_LIMITS.titleChars) {
  throw new Error("calendar_adapter_contract_mismatch");
}

function validated(project) {
  return model.normalizeCanonicalCalendarEvent(project);
}

function adaptExpenseToCalendarEvent(source, context) {
  return validated(core.projectExpenseToCalendarEvent(source, context));
}

function adaptJournalToCalendarEvent(source, context) {
  return validated(core.projectJournalToCalendarEvent(source, context));
}

function adaptJourneyToCalendarEvent(source, context) {
  return validated(core.projectJourneyToCalendarEvent(source, context));
}

module.exports = {
  CalendarEventAdapterError: core.CalendarEventAdapterError,
  adaptExpenseToCalendarEvent,
  adaptJournalToCalendarEvent,
  adaptJourneyToCalendarEvent,
  resolveJournalCalendarDate: core.resolveJournalCalendarDate,
};
