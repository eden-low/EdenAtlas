# Phase 3A.1 — Google Calendar OAuth setup

This checkpoint establishes a separate, read-only Google Calendar connection. It does not read,
display, create, update, or delete events and it does not alter Firebase Google sign-in.

## Google Cloud manual setup

Use separate Google Cloud projects and Web OAuth clients for Staging and Production. Keeping the
Calendar clients separate from the Firebase Authentication Google client limits the effect of a
Calendar-token revocation to the Calendar OAuth project.

For each environment:

1. Enable **Google Calendar API**.
2. Configure Google Auth Platform branding and audience.
3. Add only this Calendar data scope:
   `https://www.googleapis.com/auth/calendar.events.readonly`
4. Create an OAuth 2.0 Client ID of type **Web application**.
5. Register exactly one environment callback for that client:
   - Production: `https://edenatlas.netlify.app/.netlify/functions/google-calendar-oauth-callback`
   - Staging: `https://staging--edenatlas.netlify.app/.netlify/functions/google-calendar-oauth-callback`
6. Confirm the actual stable Staging hostname in Netlify before saving the Staging redirect URI.
   Do not register generic Branch deploy or Deploy Preview URLs.
7. Keep the Staging OAuth audience in **Testing** and add the intended EdenAtlas Staging account
   as a test user. Google Calendar grants and offline refresh tokens in Testing normally expire
   after seven days, so reconnect testing is expected.
8. Before a future Production deploy, choose the appropriate Production publishing/verification
   state for the actual audience. Calendar event access is sensitive Google user data.

This server authorization-code flow does not use a browser Google API client, so authorized
JavaScript origins are not required by the implementation. If Google Cloud requires an origin for
administrative client setup, enter only the matching stable site origin; it does not replace the
exact redirect URI.

## Netlify manual setup

Create these variables with **Functions** runtime scope. Values must be separate for the stable
`staging` branch and Production; do not give the variables values in generic Branch deploys or
Deploy Previews.

| Variable | Staging value | Production value |
| --- | --- | --- |
| `GOOGLE_CALENDAR_CLIENT_ID` | Staging Web OAuth client ID | Production Web OAuth client ID |
| `GOOGLE_CALENDAR_CLIENT_SECRET` | Staging client secret | Production client secret |
| `GOOGLE_CALENDAR_REDIRECT_URI` | Exact Staging callback above | Exact Production callback above |
| `GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY` | Staging-only random key | Different Production-only random key |

Generate each encryption key locally without saving it to a file:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Copy the output directly into the matching Netlify environment variable. Never place the value in
`.env.example`, a committed `.env` file, application JavaScript, logs, or Google Cloud metadata.

The existing variables `FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT`, and `ALLOWED_ORIGIN`
remain required. Existing deploy-context validation continues to reject Production Firebase
credentials in Staging and unknown deploy contexts.

Netlify applies environment-variable changes to a new deploy, so all four Staging values must be
saved before creating the Phase 3A.1 Staging deploy. Production values are not needed for the
Staging checkpoint and must not be used on Staging.

## Firestore manual setup

Deploy the updated `firestore.rules` to the isolated Staging Firebase project before Staging QA.
Both OAuth collections explicitly deny all browser reads and writes; only Firebase Admin Functions
can access them.

The state documents include a `deleteAfter` timestamp. An optional Firestore TTL policy can delete
expired records using that field. Expiry and replay rejection are enforced by the Function and do
not rely on TTL cleanup.

## Staging verification

1. Deploy only to the stable `staging` branch context.
2. Confirm ordinary Firebase Google login still works and does not show Calendar consent.
3. Open Calendar and confirm the disconnected state.
4. Start connection and confirm the consent screen requests only read-only Calendar event access.
5. Complete consent and confirm the UI reports connected without displaying any events.
6. Inspect browser network responses and storage: no access token, refresh token, authorization
   code, client secret, or encrypted token envelope may be present.
7. Confirm direct browser reads/writes to both OAuth collections are denied.
8. Retry the same callback URL and confirm it is rejected as replayed.
9. Test denial, expiry, and reconnect UI paths.

Do not configure or deploy Production during this checkpoint.
