# Future AI architecture (design doc — nothing here is implemented yet)

This document describes the intended shape of a future Agentic AI assistant for EdenAtlas. It
is **documentation only**: no AI provider has been chosen or installed, no API key exists
anywhere in this repo or in Netlify's environment configuration, and no chat/agent endpoint
exists yet. The only Netlify Function that currently exists is the unauthenticated,
no-dependency `netlify/functions/health.js` health check — see `netlify.toml` and the
completion report for this pass.

This repo previously had an AI assistant (`ai.html`/`ai-agent.js`, Gemini via `@google/genai`,
client-side function calling straight into Firestore) — see CLAUDE.md's "EdenAtlas v2.6"
history entry, "AI removed entirely." That earlier design ran **in the browser**, trusted a
client-supplied `uid`, and wrote directly to `expenses` with no server-side review. The
architecture below is a deliberate replacement for that pattern, not a resurrection of it: the
whole point of routing through a server-side Netlify Function is that a browser client must
never again be the thing deciding "this write is authorized."

## Intended request flow

```
Browser (signed in via Firebase Auth)
  -> gets a fresh Firebase ID token (auth.currentUser.getIdToken())
  -> calls an authenticated Netlify Function, e.g. POST /.netlify/functions/ai-assistant
     with the ID token in an Authorization: Bearer header (never in the request body,
     never in a query string, never logged)
  -> Function verifies the ID token server-side (Firebase Admin SDK's
     admin.auth().verifyIdToken(token)) — this is the ONLY source of truth for who the
     caller is
  -> (optional, recommended before general availability) Firebase App Check token verified
     alongside the ID token, to reject requests that didn't originate from the real
     EdenAtlas web app
  -> Function selects from a small, explicit allowlist of Agent tools (see below) based on
     the verified uid's role (owner/friend/viewer, re-derived server-side from
     users/{uid}.role — never trusted from the request)
  -> Function calls the AI provider (model/provider TBD — see .env.example's
     AI_PROVIDER/AI_MODEL/AI_PROVIDER_API_KEY placeholders) with the tool definitions and the
     user's message
  -> Any tool the model wants to call runs server-side, using Firebase Admin SDK, scoped
     explicitly to the verified uid
  -> Response (and any proposed write) goes back to the browser for the user to review
```

The browser never talks to the AI provider directly, and never holds the AI provider's API
key — that key only ever lives in Netlify's environment configuration and is read via
`process.env` inside the Function's server-side execution, never sent to the client.

## Why this differs from every other write path in the app today

Every other collection in this app enforces ownership via `firestore.rules` — see CLAUDE.md's
"Roles and the multi-tenant data model" section (`isMineOrPublic()`, `canParticipate()`,
`isOwner()`, etc.). The client can attempt any write it wants; Firestore's own rules engine is
the actual gate.

**Firebase Admin SDK does not go through Security Rules at all** — it's a trusted server
credential that can read or write anything in the project, by design. That means once a
Netlify Function uses Admin credentials, `firestore.rules` provides **zero** protection for
that Function's writes — the Function's own code is the only thing standing between "verified
uid" and "arbitrary Firestore mutation." Every future AI-backed Function must therefore
re-implement, in application code, the same per-document ownership checks the rules file
already expresses declaratively (e.g. "only write an `expenses` doc whose `uid` equals the
verified caller's uid" — the same invariant `firestore.rules`' `expenses` rule enforces today,
just re-checked in JS because Admin SDK bypasses the enforcement that would otherwise catch a
bug here).

## Security requirements for the future implementation

- **Never trust a UID supplied by the browser.** Any `uid` in a request body/query string is
  a hint at best; the only UID a Function may act as is the one decoded from a
  server-verified Firebase ID token.
- **Firebase Admin bypasses Security Rules — enforce ownership explicitly**, per collection,
  in the Function's own code, mirroring `firestore.rules`' existing per-collection shape
  (`isMineOrPublic`, always-private collections like `expenses`/`goals`/`time_capsules`/
  `daily_reflections`, Owner-only collections like Career). Getting this wrong is a
  privilege-escalation bug with no rules-layer backstop, unlike every other write path in
  this app.
- **Read-only tools first.** The first Agent tools this app exposes to a model should be
  read-only (e.g. "summarize my spending this month," "find my journal entries about X") —
  no tool that mutates Firestore ships until the read-only surface has been exercised and
  reviewed.
- **All writes require a user-visible proposal and confirmation.** An Agent tool may draft a
  write (e.g. "add an expense: RM45, Food, today"), but the Function must return that draft to
  the browser for an explicit user confirmation click before anything is persisted — never an
  autonomous `addDoc`/`updateDoc` in the same turn the model decided to call the tool. This
  mirrors the human-in-the-loop pattern this app already uses for destructive actions
  elsewhere (e.g. Memories' Trash confirm-modals, CLAUDE.md's "Memory Trash" history entry).
- **No autonomous permanent deletion, visibility-publication, Finance deletion, or friend
  removal.** These four action classes are irreversible or trust-affecting enough (per this
  app's existing conventions — Trash-before-delete for Memories, Finance being Owner-only,
  the mutual-consent friend graph) that they must stay outside any Agent tool's reach
  entirely, not just gated behind confirmation. If a future pass wants to relax this, that's
  a deliberate, separately-reviewed decision — not a default any tool should assume.
- **Rate limits, token budgets, and structured audit events.** Every AI-backed Function call
  should be cheap to reason about after the fact: a per-uid rate limit (prevents runaway cost
  and abuse), a token/cost budget per request or per period, and a structured log entry per
  call (uid, tool(s) invoked, outcome — not the AI provider's raw response text) so usage is
  auditable without needing to replay conversations.
- **Avoid logging private Journal/Memory content.** Audit events should record *that* a tool
  read/wrote a `journals`/`photos`/`life_events` doc and its id, not the private body text,
  caption, or message content itself — the same instinct behind this repo's existing rule
  that `t()` (the i18n helper) is never used to render user-generated content, only UI chrome.
- **Treat uploaded/user content as data, not system instructions.** Anything a user typed
  (a journal entry, a photo caption, a chat message) that ends up in a prompt to the AI
  provider must be clearly delimited as untrusted data, never concatenated into the system
  prompt in a way that lets it redefine the assistant's instructions or tool permissions —
  the same class of concern as prompt injection in any LLM-backed tool.

## What already exists vs. what's still to build

**Exists today (this pass):**
- `netlify.toml` — declares `functions = "netlify/functions"`, no secrets, no AI wiring.
- `netlify/functions/health.js` — unauthenticated, dependency-free liveness check. Does not
  touch Firestore, Firebase Admin, or any environment variable.
- `.env.example` — documents the *names* a future AI Function will read from
  `process.env` (`AI_PROVIDER`, `AI_PROVIDER_API_KEY`, `AI_MODEL`,
  `FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT`, `ALLOWED_ORIGIN`) — no values.

**Not yet built (future passes, in rough order):**
1. Firebase Admin SDK initialization inside a Netlify Function, reading
   `FIREBASE_SERVICE_ACCOUNT`/`FIREBASE_PROJECT_ID` from Netlify's environment
   configuration (never a committed file — see `.gitignore`'s
   `service-account*.json`/`firebase-adminsdk-*.json` rules).
2. ID-token verification middleware shared across every future authenticated Function.
3. The first read-only Agent tool + its allowlist wiring.
4. The proposal/confirmation round-trip in the browser UI.
5. Rate limiting, token budgeting, and structured audit logging.
6. App Check enforcement.
7. Only after all of the above: a real write-capable tool, starting with the narrowest,
   most reviewable case.

## Manual setup this will eventually require (not needed for this pass)

- Choosing an AI provider and creating a real API key for it — **not done in this pass**.
- Generating a Firebase Admin service-account key from the Firebase Console (Project
  Settings → Service Accounts) for project `lfj-profolio` and pasting its contents into
  Netlify's `FIREBASE_SERVICE_ACCOUNT` environment variable — **not done in this pass**.
- Enabling Firebase App Check for the web app, if the App Check step above is adopted.

None of the above was performed as part of this pass — see the completion report's "manual
actions" section for what remains for the user to decide and do later.
