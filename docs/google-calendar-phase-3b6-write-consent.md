# Phase 3B.6 — explicit Google Calendar write re-consent

Phase 3B.6 adds authorization and capability state only. It does not create the EdenAtlas
secondary calendar and does not create, update, or delete Google Calendar events.

## Exact OAuth scopes

The normal Google Calendar connection continues to request only:

- `https://www.googleapis.com/auth/calendar.events.readonly`

Only the authenticated `enable_sync` action requests explicit re-consent for this exact set:

- `https://www.googleapis.com/auth/calendar.events.readonly`
- `https://www.googleapis.com/auth/calendar.app.created`

`calendar.app.created` is the narrow Google scope for creating secondary calendars and managing
events on calendars created by the app. EdenAtlas does not request `calendar`, `calendar.events`,
`calendar.events.owned`, calendar-list scopes, or any browser-supplied scope.

The existing read scope is retained so inbound Primary-calendar reads continue to work. Primary is
an inbound read source only. The server-owned outbound policy is
`edenatlas_app_created_secondary`, and the outbound calendar ID remains `null` in this phase.

## Connection capability state

The server-owned `google_calendar_connections/{verifiedUid}` record uses `capabilityStatus`:

- `readonly`: the encrypted refresh token has the exact read-only scope only and no write upgrade
  has been requested.
- `write_consent_required`: the user explicitly started sync re-consent, but the stored token still
  has read-only capability. A decline, cancellation, missing refresh token, or rejected scope does
  not replace that token.
- `write_authorized`: a successful explicit re-consent returned exactly both approved scopes and a
  new refresh token was encrypted and stored.

The browser receives only `connectionStatus`, sanitized `capabilityStatus`, and timestamps. It never
receives granted-scope arrays, refresh tokens, encrypted token fields, access tokens, client secrets,
or outbound target identifiers.

Legacy Phase 3A connection records have no `capabilityStatus`. They are interpreted without a
Firestore migration: an otherwise valid exact read-only record is `readonly`. No OAuth request is
started and no connection record is changed until the user selects **Enable EdenAtlas Calendar
Sync**.

## Authorization and failure behavior

The start endpoint accepts either an empty body for the established read-only connection or the
single server-recognized action `{ "action": "enable_sync" }`. Unknown actions and all additional
fields—including `scope`, `uid`, and calendar identifiers—are rejected. A write upgrade additionally
requires an existing usable read-only connection owned by the Firebase UID verified with revocation
checking.

The authorization intent is covered by the OAuth state's HMAC binding together with the verified
UID, environment, exact redirect URI, and timestamps. The callback consumes state transactionally,
derives the required scopes on the server, and rechecks the verified connection owner before
accepting a write-capable token. Provider cancellation or any failed upgrade leaves the existing
read-only encrypted refresh token intact.

OAuth token exchange and revocation remain fixed to Google's OAuth hosts. No Calendar API write or
calendar-creation request exists in Phase 3B.6. Calendar creation and all outbound synchronization
are deferred to Phase 3B.7.
