# api-app owns state; api-msg executes on the current Mac

Status: implementation contract approved in the operator conversation.

## Scope

- Use the current Cloudflare account and current Mac-mini, OpenCode and imsg only.
- `api-app` is the Cloudflare application. One SQLite-backed Durable Object is
  the only writer of users, registrations, Likes, assignments, conversations,
  intake bookmarks/deduplication, sends, resets, removals and follow-ups.
- The Persona Catalog stays in the existing Admin D1. New conversation
  documents use its initial State/Memory; running OpenCode documents continue
  evolving without being reset to initial documents.
- `api-msg` is a DB-free authenticated Mac execution gateway. It performs
  OpenCode/imsg operations, but owns no user/admission policy or durable journal.
- Move the existing stateful application and behavioral tests to `apps/api-app`;
  replace `packages/api-msg.hena.dev` with the executor. Do not tunnel SQL over
  HTTP, introduce a local compatibility database, or weaken quality gates.

## Execution interface

- Cloudflare calls Mac `/opencode/...` using `TOKEN_EXECUTOR`. The Mac forwards
  native OpenCode requests to its fixed configured `OPENCODE_URL`, replacing
  authorization with `OPENCODE_AUTHORIZATION`. Streaming and cancellation work.
- Cloudflare calls Mac `/imsg/rpc` using `TOKEN_EXECUTOR`. The Mac forwards the
  existing imsg protocol to fixed `IMSG_URL` using `IMSG_TOKEN`; no protocol change
  is imposed on the independently deployed imsg gateway.
- Mac `/health` returns safe disk/screen health facts to the application, never
  credentials, contact details or message contents.
- Conversation/session IDs and stable operation/tool/message IDs are recorded
  centrally before external effects. A repeated command cannot create a second
  greeting or repeat an uncertain send. The executor does not retry side effects.

## Application behavior

- Browser registration and Turnstile verification terminate at api-app.
- Admin calls api-app for listing and confirmed idempotent selection.
- New registrations wait for operator selection, including the legacy client;
  both clients continue handling every older answer they already accept.
- Preserve exclusive Persona/Handle assignment and the once-only 5–60 minute
  first-contact reservation, failed/uncertain-send fences, intake replay,
  edits/unsends, test resets, retained sessions, removals and follow-ups.
- Registration/listing must not depend on the Mac or OpenCode being available.
- Use full DurableObjectStorage with `@effect/sql-sqlite-do` for transactions.
  Preserve tested state transitions and use an alarm to wake/recover application
  work. Do not assume process memory or a stream survives deployment.

## Deployment and cutover

- All code deployment goes through PR, main quality gates and existing CI.
- Keep existing Messages/imsg endpoints and their credentials/permission setup.
- Export existing application state read-only and import explicitly into an empty
  central application store. Preserve IDs, pending work and uncertain sends;
  reject conflicts. Never assume the running Mac database is empty.
- Initial Cloudflare application deployment is bootstrap-only. The old intake
  must be paused and state verified before one new intake is enabled.
- Public default application domain: `api-app.ambivalent.dev` in Ambivalent Co.
- Runtime secrets are server-only; browser Site key remains the GitHub variable.
- Logs correlate requests/operations and record safe stage/cause/outcome metadata,
  excluding handles, conversation/Persona text, prompts and credentials.

## Verification

- Preserve/move the current behavioral tests, and test the real SQLite DO layer,
  compiled Worker and DB-free executor interface with fake external services.
- Test registration while execution is unavailable; atomic duplicate selection;
  restart/replay/uncertainty; native gateway authentication and fixed upstreams.
- Test that production api-msg has no SqlClient/SQLite database dependency.
- Run `bun run ci`, review the complete diff and open a PR. No paid generation,
  live message sending or manual deployment during implementation.
