# api-app owns state; api-msg executes on the current Mac

Status: implementation contract approved in the operator conversation.

## Scope

- Use the current Cloudflare account and current Mac-mini, OpenCode and imsg only.
- `api-app` is the Cloudflare application. One SQLite-backed Durable Object is
  the only writer of users, registrations, Likes, assignments, conversations,
  intake bookmarks/deduplication, sends, resets, removals and follow-ups.
- The Persona Catalog stays in the existing Admin D1. The first Conversation
  initializes a persona's shared State and Life memory once. Later Conversations
  use that shared life and create private Relationship scopes; later initial-value
  edits affect only future starting affection and public initial proficiency.
  See [ADR-0023](../adr/0023-personas-share-one-life-across-up-to-five-conversations.md).
- `api-msg` is a DB-free authenticated execution gateway in Docker on the Mac. It performs
  OpenCode/imsg operations, but owns no user/admission policy or durable journal.
- The current `main` has moved the application to `apps/api` and the native
  gateway to `apps/imsg`, and Discovery is now the only onboarding site.
  Keep `apps/api` as the central application workspace, name it `@ren-ai/api-app`,
  and add the DB-free executor in `apps/api-msg`. Preserve the behavioral tests.
  Do not tunnel SQL over
  HTTP, introduce a local compatibility database, or weaken quality gates.

## Execution interface

- Cloudflare calls Mac `/opencode/...` using the existing `TOKEN_MANAGEMENT`. The Mac forwards
  native OpenCode requests to its fixed configured `OPENCODE_URL`, replacing
  authorization with `OPENCODE_AUTHORIZATION`. Streaming and cancellation work.
- Cloudflare calls Mac `/imsg/rpc` using `TOKEN_MANAGEMENT`. The Mac forwards the
  existing imsg protocol to fixed `IMSG_URL` using `IMSG_TOKEN`; no protocol change
  is imposed on the independently deployed imsg gateway.
- Executor `/health` returns its filesystem disk usage and a nullable screen-lock
  observation, never credentials, contact details or message contents. Docker
  reports `screenLocked: null` because it cannot inspect the Mac GUI; an unavailable
  observation must not clear an existing screen-lock alert.
- Conversation/session IDs and stable operation/tool/message IDs are recorded
  centrally before external effects. A repeated command cannot create a second
  greeting or repeat an uncertain send. The executor does not retry side effects.

## Application behavior

- Browser registration and Turnstile verification terminate at api-app.
- Admin calls api-app for listing and confirmed idempotent selection.
- New registrations wait for operator selection. Preserve Discovery and Admin
  handling of every answer the running API can give, including the current
  confirmed immediate-start operation for a waiting test handle.
- Enforce at most one current assignment per handle and five per persona in the
  reservation transaction, including pending/uncertain first contacts and test
  handles. Relationship endings exclude a persona only for that handle. Preserve the once-only 5–60 minute
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
- Public default application domain: `api.renai.im` on Cloudflare in Ambivalent Co.
  The DB-free executor runs in Docker on the Mac at `api-msg.renai.im`; current upstreams
  remain `oc.renai.im` and `imsg.renai.im`. Do not restore retired hostnames.
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
