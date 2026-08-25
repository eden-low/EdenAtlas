# Phase 3B.7 — Manual Single-Event Google Create

## Authorization and destination

The OAuth scope set is unchanged from the accepted Phase 3B.6 write re-consent flow:

- `https://www.googleapis.com/auth/calendar.events.readonly`
- `https://www.googleapis.com/auth/calendar.app.created`

The browser cannot submit scopes. `calendar.app.created` is the minimum write capability used to
create a secondary calendar and events on calendars EdenAtlas created. Primary remains an inbound
read target only. The outbound policy is the server constant `edenatlas_app_created_secondary`.

On the first explicit manual create, the server creates `POST /calendar/v3/calendars` with exactly
`{"summary":"EdenAtlas"}` and persists the returned non-Primary ID in
`google_calendar_connections/{verifiedUid}`. A transaction lease makes concurrent provisioning
single-writer. A persisted ID is reused. Ambiguous provisioning failure is recorded as `failed` and
does not fall back to Primary or blindly create another calendar.

A later OAuth reconnect/re-consent retains a persisted destination only when its server-owned
policy and non-Primary ID validate. It also retains an ambiguous provisioning failure as `failed`;
OAuth cannot reset either condition and accidentally provision a second calendar.

Sanitized browser provisioning states are `not_created`, `created`, `reconnect_required`, and
`failed`. Calendar IDs, event IDs, credentials, and token scope records remain server-only.

## Manual boundary and ownership

The UI exposes one candidate only: the most recently created Expense in the viewed month. No
projection or provider operation runs until the user confirms **Create in Google Calendar**.

The preparation endpoint reloads the allowlisted source and returns only its opaque canonical
handle. The provider endpoint accepts exactly:

```json
{"canonicalEventHandle":"<opaque 52-character canonical ID>"}
```

It rejects every extra field. In particular it cannot accept a UID, source tuple, calendar ID,
Google event ID, provider payload, scope, attendee, recurrence, URL, or Meet data. The Function
verifies the Firebase ID token with revocation checking, derives the UID, reloads the canonical
record, verifies ownership, rejects tombstones, and re-checks the owned connection and persisted
destination before each Calendar API operation. Legacy Phase 3B.6 connections receive a
server-only `ownerUid` backfill only when their document key and stored `uid` already equal the
verified UID.

## Provider identity and payload

The Google event ID is the lowercase, unpadded base32hex encoding of:

```text
HMAC-SHA256(
  CALENDAR_IDENTITY_KEY,
  "ea-google:v1|ownerUid|canonicalEventId|googleCalendarId"
)
```

It is 52 characters from Google's permitted `0-9a-v` alphabet and is stable across retries. The
identity key is server-only.

The Google payload is built entirely from the validated canonical record:

- Google `summary` receives the canonical title.
- Google `description` is omitted unless the approved canonical summary is non-empty; if present,
  it receives only that canonical summary.
- `start` and `end` receive either exclusive all-day `date` boundaries or canonical `dateTime` plus
  canonical IANA `timeZone`.
- `status` is `confirmed` or `tentative`; cancelled/tombstoned records are rejected.
- `extendedProperties.private` contains exactly `edenAtlasVersion="1"`, the opaque
  `edenAtlasCanonicalId`, and `edenAtlasSourceType` (`expense`, `journal`, or `journey`).

Amounts, categories, Expense notes, Journal bodies/private fields, Journey descriptions,
locations/visibility, source document IDs, Firebase UIDs, credentials, attendees, recurrence,
URLs, and Meet data are excluded.

## Durable mapping and idempotency

`calendar_event_sync/{googleEventId}` is denied to browser clients. Its server schema is:

- `ownerUid`, `canonicalEventId`, `provider="google"`
- `googleCalendarId`, `googleEventId`, `providerOrigin="edenatlas_created"`
- `payloadHash`, `lastSyncedCanonicalVersion`
- `state` (`pending_create`, `synced`, `failed`, or `conflict`)
- `lastAttemptAt`, `lastSyncedAt`, `retryCount`, `lastErrorCode`, `createdAt`, `updatedAt`
- transient server-only operation lease fields used to reject concurrent creates

Before insert, the Function computes the deterministic ID and calls `events.get`. A matching
private marker and payload is already-created success. A 404 permits one `events.insert` with that
same ID. A timeout or 409 is reconciled with another `events.get`; no random fallback ID exists.
Marker or payload mismatch is a fail-closed conflict and is never overwritten. After provider
success, a Firestore transaction reloads the canonical document and records the hash/version only
if ownership, tombstone state, and version still match. No update/delete worker, scheduled job,
bulk sync, reconciliation loop, or source-create hook is present in this phase.
