# Workers re-platform research: api-msg

Platform facts for moving `packages/api-msg.hena.dev` from a long-lived Bun process onto Cloudflare Workers, Durable Objects (DOs) and/or D1. Sections 1–8 contain only what the cited source says. The analysis is kept to the second-to-last section.

- **Checked:** 2026-10-13. The Cloudflare pages are quoted as they appeared on that day; each page shows its own "Last updated" date.
- **Repo versions:** `effect` 4.0.0-rc.112, `@opencode/client` 2.0.19, `wrangler` 4.149.0 (`apps/admin/package.json`) and 4.141.0 (`packages/discovery.hena.dev/package.json`), `@cloudflare/workers-types` 5.20261011.1 (`apps/admin/package.json`).
- **npm on the same day:** `effect` `latest` = 4.0.4 and `rc` = 4.0.0-rc.118 ([registry](https://registry.npmjs.org/effect)); `wrangler` `latest` = 4.149.0 ([registry](https://registry.npmjs.org/wrangler)).
- **Path shorthand:** `<client>` = `node_modules/.bun/@opencode+client@2.0.19+11eac7cfbf53fc55/node_modules/@opencode/client`. `<effect>` = `node_modules/.bun/effect@4.0.0-rc.112/node_modules/effect`.

## 1. Durable Objects

### Plans and storage

- DOs are available on both Workers Free and Workers Paid. Free accounts can use only SQLite-backed DOs. On Paid, the key-value backend is offered only to accounts that already have a key-value-backed namespace ([pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [limits](https://developers.cloudflare.com/durable-objects/platform/limits/)). Since 2026-07-09, other accounts can create only SQLite-backed namespaces ([changelog](https://developers.cloudflare.com/changelog/post/2026-07-09-restrict-new-kv-backed-namespaces/)).
- SQLite-backed DOs became GA on 2025-04-07 with 10 GB per object ([changelog](https://developers.cloudflare.com/changelog/post/2025-04-07-sqlite-in-durable-objects-ga/)). DOs became available on the Free plan the same day ([changelog](https://developers.cloudflare.com/changelog/post/2025-04-07-durable-objects-free-tier/)).
- SQLite-backed limits ([limits](https://developers.cloudflare.com/durable-objects/platform/limits/)):
  - 10 GB per object, unlimited per class.
  - Per account: unlimited on Paid, 5 GB total on Free.
  - 500 classes per account on Paid, 100 on Free.
  - Key plus value ≤ 2 MB; any string, `BLOB` or row ≤ 2 MB.
  - SQL statement ≤ 100 KB, ≤ 100 bound parameters, ≤ 100 columns per table.
- A full object rejects writes with `SQLITE_FULL`; reads and `DELETE` still work. The same FAQ gives the per-object limit as "10 GB on Workers Paid, or 1 GB on the Free plan", which does not match the limits table above ([limits FAQ](https://developers.cloudflare.com/durable-objects/platform/limits/#what-happens-when-a-durable-object-exceeds-its-storage-limit)).
- SQLite storage billing ([pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/#sqlite-storage-backend)):

  | Plan | Rows read                              | Rows written                          | Stored data                              |
  | ---- | -------------------------------------- | ------------------------------------- | ---------------------------------------- |
  | Free | 5 M/day                                | 100 k/day                             | 5 GB total                               |
  | Paid | 25 B/month included, then $0.001 per M | 50 M/month included, then $1.00 per M | 5 GB-month included, then $0.20/GB-month |

  Each `setAlarm()` counts as one row written. The page still says SQLite storage billing "will be enabled in January 2026, with a target date of January 7, 2026 (no earlier)".

- Storage belongs to a single object instance and other objects cannot read it ([SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)).
- Transactions ([SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)):
  - `sql.exec()` cannot run `BEGIN TRANSACTION` or `SAVEPOINT`. Use `ctx.storage.transactionSync()` (synchronous callback) or `ctx.storage.transaction()`.
  - "Any series of write operations with no intervening `await` will automatically be submitted atomically."
- `PRAGMA user_version` is not supported. Cloudflare recommends running schema migrations in the constructor under `blockConcurrencyWhile()` ([rules of DOs](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/#initialize-storage-and-run-migrations-in-the-constructor)).
- Point-in-time recovery restores the object's whole SQLite database (SQL and KV data) to any point in the past **30 days**. It uses bookmarks: call `getBookmarkForTime()`, then `onNextSessionRestoreBookmark()`, then `ctx.abort()`. It is not supported in local development ([PITR API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api)). The docs give no separate Free-plan window.

### CPU, wall time and compute billing

- **CPU per invocation** (HTTP request, WebSocket message or alarm): default **30 s**, configurable up to **5 min** with `limits.cpu_ms: 300000` for every DO of a class. Waiting on I/O does not count ([limits FAQ](https://developers.cloudflare.com/durable-objects/platform/limits/#can-i-increase-durable-objects-cpu-limit)).
- Each incoming HTTP request or WebSocket message resets the remaining CPU budget to 30 s. Using more than 30 s of compute between incoming network requests gives "a heightened chance" that the object is evicted and reset ([limits, footnote 4](https://developers.cloudflare.com/durable-objects/platform/limits/)).
- **Wall time:**
  - DO RPC and HTTP calls are unlimited while the caller stays connected. "Durable Objects remain active while a request, RPC call, response stream, WebSocket, or pending I/O is in flight" ([limits](https://developers.cloudflare.com/durable-objects/platform/limits/#wall-time-limits-by-invocation-type)).
  - Alarm handlers are limited to 15 min.
- One object has a soft limit of about 1,000 requests/s and returns an overloaded error once its queue fills ([limits FAQ](https://developers.cloudflare.com/durable-objects/platform/limits/#how-much-work-can-a-single-durable-object-do)). Cloudflare advises against using a single DO as a global singleton ([rules of DOs](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/#do-not-use-a-single-durable-object-as-a-global-singleton)).
- Compute billing ([pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/#compute-billing)):
  - **Free:** 100,000 requests/day and 13,000 GB-s/day.
  - **Paid:** 1 M requests/month, then $0.15/M; 400,000 GB-s/month, then $12.50 per M GB-s.
  - Duration is billed at 128 MB while the object is running, or idle in memory but not eligible to hibernate.

### Alarms

([alarms](https://developers.cloudflare.com/durable-objects/api/alarms/) unless noted)

- An object has at most one alarm. `setAlarm(ms since epoch)` replaces any existing alarm. Many schedules are handled by storing them and re-arming the alarm for the next one (the documented pattern).
- Execution is at least once. After an uncaught exception, the alarm is retried with exponential backoff that starts at 2 s, for up to 6 retries. Only the most recent `setAlarm()` is retried.
- `alarm(alarmInfo)` exposes `retryCount` and `isRetry`. Cloudflare recommends catching errors and re-arming the alarm, because retries can run out during a long outage.
- Only one `alarm()` runs at a time per object, but alarms can run at the same time as other requests to the same object. `ctx.abort(reason, { retryAlarm: false })` prevents the retry ([changelog 2026-08-25](https://developers.cloudflare.com/changelog/post/2026-08-25-durable-object-alarm-abort-no-retry/)).
- When an inactive object wakes for an alarm, its constructor runs before `alarm()`.
- Alarm handlers get 15 min of wall time ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/#duration)) and the same per-invocation CPU limit as requests ([limits FAQ](https://developers.cloudflare.com/durable-objects/platform/limits/#can-i-increase-durable-objects-cpu-limit)).
- Scheduling precision is not documented beyond the millisecond timestamp argument.

### Hibernation and eviction

([lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/) unless noted)

- An idle object that can hibernate is hibernated after 10 s with no incoming request or event. An idle object that cannot hibernate is evicted after **70–140 s** of inactivity.
- Hibernation requires all of the following:
  - No `setTimeout` or `setInterval` callbacks are pending.
  - No unfinished I/O or `waitUntil` promise, and no open outbound connection.
  - The standard WebSocket API is not in use.
  - No request or event is still being processed.
- Hibernation discards in-memory state. Hibernated WebSocket clients stay connected.
- Pending I/O and open outbound connections prevent eviction. This covers outbound `fetch()`, RPC calls, service-binding requests, TCP sockets, outbound WebSockets, `waitUntil` promises and timers. **Each operation protects the object for at most 15 minutes from its start.** Operations started together do not extend each other; one started later does. Duration charges continue throughout.
- For compatibility dates on or after `2026-10-01`, or with the `durable_object_io_tasks_prevent_eviction` flag, the 15-minute protection also covers service bindings, RPC and `fetch` calls to other DOs, `waitUntil` and timers. Outbound `fetch()` to external services, TCP sockets and outbound WebSockets were already covered ([changelog 2026-10-01](https://developers.cloudflare.com/changelog/post/2026-10-01-pending-io-keep-alive/)).

### Deploys and other restarts

- Objects restart on code deploys, after inactivity, on Workers runtime updates, and when Cloudflare decides to move them ([lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/#shutdown-behavior)). During a shutdown:
  - In-flight HTTP and RPC requests may finish if they do not touch storage. Storage access fails immediately with an error.
  - During runtime updates, in-flight requests get up to **30 s**.
  - WebSocket requests are terminated.
  - No shutdown hooks are provided.
- "Code updates disconnect all WebSockets. Deploying a new version restarts every Durable Object" ([WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)). The resulting error is "Durable Object reset because its code was updated." Durable state that was already persisted is unaffected ([troubleshooting](https://developers.cloudflare.com/durable-objects/observability/troubleshooting/)).
- Releases roll out eventually consistently. A new Worker version can call an object that still runs old code, "typically seconds to minutes" ([known issues](https://developers.cloudflare.com/durable-objects/platform/known-issues/#code-updates)).
- **Code update strategy in Wrangler ≥ 4.141.0** ([CHANGELOG 4.141.0](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/CHANGELOG.md)):
  - `wrangler deploy`, `wrangler versions deploy` and `wrangler rollback` accept `--durable-objects-code-update-mode immediate` or `deferred <duration>`. The config equivalent is `durable_objects.code_update_strategy`.
  - Without a setting, the strategy is `deferred` with a 300 s maximum delay. The maximum allowed is 86,400 s. The config schema describes `max_delay` as the "Maximum time, in seconds, to wait for Durable Objects to hibernate" (`node_modules/.bun/wrangler@4.149.0+7b7856fc5a750e12/node_modules/wrangler/config-schema.json:3652`).
  - The default is in that package's `wrangler-dist/cli.js:219958-219961`.
  - The flag also appears in the [`versions deploy` reference](https://developers.cloudflare.com/workers/wrangler/commands/workers/#versions-deploy).
- For Workers in general (not DO-specific), a runtime update gives existing requests and connections, including streaming responses and WebSockets, up to **20 min** to finish ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/#runtime-updates)).

## 2. Long-lived connections in and out of a DO

### Outbound (DO as client)

- A Worker or DO can open an outbound WebSocket with `new WebSocket(url)` or with `fetch()` plus `Upgrade: websocket` ([WebSockets API](https://developers.cloudflare.com/workers/runtime-apis/websockets/), [example](https://developers.cloudflare.com/workers/examples/websockets/)). Outbound `fetch()` requests fall under the pending-I/O rule in §1.
- Since 2026-06-19, every active outbound connection made with `connect()` (TCP) or as an outbound WebSocket prevents eviction. **The limit is 15 minutes per connection. After that, "the connection stops preventing eviction (the connection itself continues operating)" and the normal eviction rules apply again** ([changelog](https://developers.cloudflare.com/changelog/post/2026-06-19-outbound-connections-keep-dos-alive/)).
- The lifecycle page applies the same 15-minute-per-operation cap to outbound `fetch()` requests ([lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)).
- "Hibernation is only supported when a Durable Object acts as a WebSocket server. Outgoing WebSockets do not hibernate." An open outbound WebSocket prevents eviction for up to 15 minutes, and "The connection itself may remain open after that." Alarms, incoming requests and `setTimeout`/`setInterval` all prevent hibernation ([WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)).
- Connection limits ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections)):
  - At most 6 connections per invocation may be waiting for response headers at once. Outbound WebSockets count toward this.
  - Since 2026-04-09, a connection stops counting once its headers arrive ([changelog](https://developers.cloudflare.com/changelog/post/2026-04-09-relaxed-connection-limiting/)).
- Subrequests per invocation ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/#subrequests), [changelog 2026-02-11](https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/)):
  - **Paid:** 10,000 by default, configurable up to 10 M with `limits.subrequests`.
  - **Free:** 50 external and 1,000 to Cloudflare services.
  - Each redirect hop counts.
  - The changelog cites long-running requests "such as open websockets on Durable Objects" as cases that used to hit the old limit of 1,000.
- For a stateless Worker (not a DO), work is tied to the inbound request. When the client disconnects or the response completes, tasks may be cancelled. `ctx.waitUntil()` adds at most 30 s ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/#duration)).
- Cloudflare-to-origin limits for proxied traffic: Proxy Read Timeout **125 s** (error 524, configurable only on Enterprise), Proxy Idle Timeout 900 s. Tunnel connection settings are documented separately as "origin configuration" ([connection limits](https://developers.cloudflare.com/fundamentals/reference/connection-limits/)).

### Inbound WebSockets (DO as server, Hibernation API)

- The DO calls `ctx.acceptWebSocket(ws, tags?)` and handles `webSocketMessage`, `webSocketClose` and `webSocketError`. The object can leave memory while clients stay connected. The next event runs the constructor again ([WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), [base API](https://developers.cloudflare.com/durable-objects/api/base/)).
- Limits ([state API](https://developers.cloudflare.com/durable-objects/api/state/), [WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)):
  - At most 32,768 hibernatable WebSockets per object.
  - At most 10 tags per socket, each ≤ 256 characters.
  - `serializeAttachment` holds ≤ 16,384 bytes.
  - `setHibernatableWebSocketEventTimeout` can be set to at most 7 days.
  - Received messages are limited to 32 MiB.
- The runtime answers protocol pings without waking the object. Auto-response messages do not add wall-clock time ([WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), [pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).
- Cost ([pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)):
  - Opening a socket counts as one request.
  - Incoming messages are billed at 20 messages per request.
  - Outgoing messages and incoming pings are free.
  - A hibernatable socket incurs no duration while idle. A socket accepted with standard `accept()` incurs duration for the whole time it is connected.
- Code updates disconnect all WebSockets (see §1).
- An inbound streaming HTTP response, such as SSE or NDJSON, keeps the object active and not hibernatable while the response is open. Wall time stays unlimited while the caller is connected ([limits](https://developers.cloudflare.com/durable-objects/platform/limits/#wall-time-limits-by-invocation-type), [lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)).

## 3. Workers limits

([Workers limits](https://developers.cloudflare.com/workers/platform/limits/) unless noted)

| Item                       | Free                 | Paid                                                     |
| -------------------------- | -------------------- | -------------------------------------------------------- |
| CPU per HTTP request       | 10 ms                | 30 s default, up to 5 min (`limits.cpu_ms`)              |
| CPU per Cron Trigger       | 10 ms                | 30 s if the interval is under 1 h; 15 min if 1 h or more |
| Subrequests per invocation | 50 (+1,000 internal) | 10,000 default, up to 10 M                               |
| Memory per isolate         | 128 MB               | 128 MB                                                   |
| Cron Triggers per account  | 5                    | 250                                                      |
| Requests                   | 100,000/day          | no limit                                                 |

- **Duration:**
  - HTTP requests have no limit while the client stays connected. "A Worker that is still streaming a response body remains active."
  - Cron Triggers, DO alarms and Queue consumers: 15 min each.
  - Runtime updates leave existing requests and connections, including streaming responses, up to 20 min.
- **Cron:**
  - Expressions have five fields with Quartz-like extensions, so the finest step is one minute (`* * * * *`), in UTC.
  - Trigger changes take up to 15 min to propagate ([Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)).
  - The alarms page also says "A Worker can have up to three Cron Triggers configured at once" ([alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)), which conflicts with the limits table.
- **Queues:**
  - Available on Workers Free since 2026-02-04 ([changelog](https://developers.cloudflare.com/changelog/post/2026-02-04-queues-free-plan/)).
  - Free: 10,000 operations/day with fixed 24 h retention. Paid: 1 M operations/month, then $0.40/M, with retention of 4 days by default and up to 14 days ([pricing](https://developers.cloudflare.com/queues/platform/pricing/)).
  - Messages ≤ 128 KB, `delaySeconds` ≤ 24 h, 5,000 messages/s per queue, at most 100 retries ([limits](https://developers.cloudflare.com/queues/platform/limits/)).
- **Pricing:** Paid has a $5/month minimum and includes 10 M requests and 30 M CPU-ms per month ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)).
- **Runtime features:**
  - `nodejs_compat` is on by default for compatibility dates from `2026-08-04` ([changelog](https://developers.cloudflare.com/changelog/post/2026-08-04-nodejs-compat-default/)).
  - Every `node:crypto` API, including `createHash` and `timingSafeEqual`, is supported. The exceptions are DSA/DH key generation, argon2, ed448/x448 and FIPS toggling ([node:crypto](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/)).
  - `net.Server` is not supported ([node:net](https://developers.cloudflare.com/workers/runtime-apis/nodejs/net/)).
  - `eval` and `new Function` are blocked. `Date.now()` does not advance during code execution. Timers work only inside the request context ([web standards](https://developers.cloudflare.com/workers/runtime-apis/web-standards/)).

## 4. D1 vs Durable Object SQLite

| Item                   | D1                                                                                  | DO SQLite                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Size per database      | 10 GB Paid (cannot be raised) / 500 MB Free                                         | 10 GB per object (see §1 for the Free-plan conflict)                       |
| Size per account       | 1 TB Paid (raisable) / 5 GB Free                                                    | unlimited Paid / 5 GB Free                                                 |
| Point-in-time recovery | Time Travel: any minute within 30 days (Paid) / 7 days (Free), always on, no charge | PITR API: 30 days, called from code                                        |
| Transactions           | auto-commit; `batch()` runs as one transaction; no interactive transaction API      | `transactionSync()` / `transaction()`; no `BEGIN` in `exec()`              |
| Who can access         | Workers that bind its `database_id` in `d1_databases` (see note below)              | only the owning object; other code goes through the DO binding (RPC/fetch) |
| Stored data price      | 5 GB included, then $0.75/GB-month                                                  | 5 GB-month included, then $0.20/GB-month                                   |

Sources: [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/), [D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/), [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

- D1 limits ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/)):
  - Queries ≤ 30 s, including a whole batch.
  - 1,000 queries per invocation on Paid, 50 on Free.
  - 10 Time Travel restores per 10 minutes.
  - Each database is single-threaded and runs on a single Durable Object.
- D1 is auto-commit. "Batched statements are SQL transactions": if one statement fails, the whole sequence rolls back ([D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)). The binding methods are `prepare`, `batch`, `exec`, `withSession` and the alpha-only `dump`. Imported dumps must have `BEGIN TRANSACTION`/`COMMIT` removed, or the import fails with "cannot start a transaction within a transaction" ([import/export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)).
- Time Travel ([Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)):
  - `wrangler d1 time-travel restore` overwrites the database in place and cancels in-flight queries.
  - A restore can be undone by restoring to the bookmark it returns.
  - For retention beyond 30 days, the docs point to a Workflows-based export to R2.
- **Sharing one D1 database between two Workers:** each Worker binds by `database_id` in `d1_databases`. The Wrangler docs describe `migrations_dir` as useful "if you have a mono-repo setup, and want to use a single D1 instance across your apps/packages" ([Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/#d1-databases)). No more direct statement was found.
- A DO namespace can be bound from another Worker with `script_name` ([class exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)).

## 5. Effect 4 packages

- **Matching npm versions** ([sql-d1](https://registry.npmjs.org/@effect/sql-d1), [sql-sqlite-do](https://registry.npmjs.org/@effect/sql-sqlite-do), [effect](https://registry.npmjs.org/effect)):
  - `@effect/sql-d1@4.0.0-rc.112` was published 2026-08-25T00:01:13Z. Its peer dependency is `effect: ^4.0.0-rc.112`, and it depends on `@cloudflare/workers-types: ^5.20260822.1`.
  - `@effect/sql-sqlite-do@4.0.0-rc.112` was published 2026-08-25T00:01:14Z, also with peer `effect: ^4.0.0-rc.112`.
  - `effect@4.0.0-rc.112` was published 2026-08-25T00:41:14Z.
  - All three packages list the same release candidates, 4.0.0-rc.108 through 4.0.0-rc.118 (11 versions), plus 4.0.0–4.0.4.
- **No Workers platform package exists.** The registry returns 404 for `@effect/platform-cloudflare`, `@effect/platform-workerd`, `@effect/platform-workers` and `@effect/cloudflare`. [`Effect-TS/effect/packages/platform`](https://github.com/Effect-TS/effect/tree/main/packages/platform) contains only `browser`, `bun`, `deno`, `node` and `node-shared`; [`packages/sql`](https://github.com/Effect-TS/effect/tree/main/packages/sql) includes `d1` and `sqlite-do`.
  - `effect/unstable/workers` exists, but it is for Web and Node worker threads: "shared by browser, Node, and Bun adapters" (`<effect>/dist/unstable/workers/Worker.js:2`).
  - Core `effect` already includes `HttpRouter.toWebHandler` (`<effect>/dist/unstable/http/HttpRouter.js:644`) and `FetchHttpClient`, which defaults to `globalThis.fetch` (`<effect>/dist/unstable/http/FetchHttpClient.js:29`).
- **Driver behaviour at rc.112**, read from the npm tarballs ([sql-sqlite-do tgz](https://registry.npmjs.org/@effect/sql-sqlite-do/-/sql-sqlite-do-4.0.0-rc.112.tgz), [sql-d1 tgz](https://registry.npmjs.org/@effect/sql-d1/-/sql-d1-4.0.0-rc.112.tgz)):
  - **`@effect/sql-sqlite-do`** (`src/SqliteClient.ts`):
    - Configured as `SqliteClient.layer({ db: ctx.storage.sql, storage: ctx.storage })`. Access is serialized through one connection.
    - `withTransaction` uses `storage.transaction()`. It fails with "Nested transactions are not supported by Cloudflare Durable Object SQLite storage", and without `storage` it fails with "Transactions require Durable Object storage; pass ctx.storage as the storage option".
    - `src/SqliteMigrator.ts` records migrations in `effect_sql_migrations`.
  - **`@effect/sql-d1`** (`src/D1Client.ts`):
    - The header says: "Transactions, streaming queries, and `updateValues` are not supported by this driver". Attempting a transaction calls `Effect.die("transactions are not supported in D1")`.
    - Atomic `batch` is exposed.
    - There is no migrator module.
- **Packages at 4.0.0-rc.112 in this repo's `node_modules/.bun`:** `effect`, `@effect/platform-node` (two peer-resolution copies), `@effect/platform-node-shared`, `@effect/sql-sqlite-bun`, `@effect/sql-sqlite-node` and `@effect/opentelemetry`. Neither `@effect/sql-d1` nor `@effect/sql-sqlite-do` is installed. `apps/admin` is already a Worker that depends on `effect` 4.0.0-rc.112 (`apps/admin/package.json`, `apps/admin/src/generation.ts:1`).

## 6. `@opencode/client` 2.0.19

- **What api-msg uses:**
  - It imports `@opencode/client/effect`, plus types from `@opencode/client/effect/api` (`<client>/dist/effect/api.js` is empty), for example in `packages/api-msg.hena.dev/src/opencode/remote.ts:1-8`.
  - Its production `HttpClient` is `FetchHttpClient.layer` (`packages/api-msg.hena.dev/src/server-entry.ts:22`).
  - The client depends on `@opencode/schema` and `@opencode/protocol` 2.0.19. `effect` 4.0.0-rc.112 and `solid-js` are optional peers (`<client>/package.json`).
- **No Node-only APIs on the `./effect` path.** The static import graph of `<client>/dist/effect/index.js` reaches nine chunks (`7f0py9js`, `vmytr4q8`, `0fn08bwv`, `6mptkzbc`, `frbwqjmf`, `t1xa31vm`, `mnyft54j`, `qnqb2tyr`, `9rqn6x4v`).
  - Their only bare imports are `effect`, `effect/unstable/{http,httpapi,encoding}`, `@opencode/protocol/*` and `@opencode/schema/*`.
  - They contain no `node:` imports and no use of `process`, `Bun`, `EventSource` or `WebSocket`.
  - The dist folders of `@opencode/protocol` and `@opencode/schema` import only `effect`, `effect/unstable/{httpapi,rpc}`, `@standard-schema/spec` and each other.
  - There is no `eval` or `new Function` in this path. In `effect` they appear only inside the embedded Swagger and Scalar UI assets (`<effect>/dist/unstable/httpapi/internal/httpApi{Swagger,Scalar}.js`).
- **Node-only code exists, but only behind the `./service` and `./effect/service` exports**, which api-msg does not import:

  ```js
  // <client>/dist/effect/service.js:22-24
  import { Effect, FileSystem, Option, Schedule, Schema } from "effect";
  import { homedir } from "node:os";
  import { join } from "node:path";
  // <client>/dist/chunks/rpc-runtime-txckps9j.js:2 (service contender)
  import { spawn } from "node:child_process";
  // <client>/dist/chunks/rpc-runtime-mhqqf36r.js:14
  import { readFile, rename, rm, writeFile } from "node:fs/promises";
  ```

- **How events are consumed: SSE over `fetch` streaming, not `EventSource`.** The endpoint is an `HttpApi` GET that returns `StreamSse`, and its description says events are volatile:

  ```js
  // node_modules/.bun/@opencode+protocol@2.0.19/node_modules/@opencode/protocol/dist/groups/event.js:37-42
  .add(HttpApiEndpoint.get("event.subscribe", "/api/event", {
      success: HttpApiSchema.StreamSse({ data: EventSchema }),
  // description: "... Volatile by contract: a slow consumer overflows and fails the stream,
  //               and events during disconnection are missed."
  ```

  ```js
  // <client>/dist/chunks/rpc-runtime-0fn08bwv.js:413, 598
  var EndpointEventSubscribe = (raw) => () => preserveStream()(Stream.unwrap(raw["event.subscribe"]({})...
  var make6 = (options) => HttpApiClient.make(ClientApi2, options).pipe(Effect.map(adaptClient));
  // <client>/dist/chunks/rpc-runtime-qnqb2tyr.js:31-35, 43
  var make4 = Effect.fn("OpenCode.make")(function* (options) {
    const httpClient = yield* HttpClient.HttpClient;
    const raw = yield* make6(options).pipe(Effect.provideService(HttpClient.HttpClient, HttpClient.mapRequestEffect(httpClient, ...)));
    const native = raw.event.subscribe();
    const shared = make7((signal) => Stream.toAsyncIterableWith(native.pipe(...), context));
  ```

  ```js
  // <effect>/dist/unstable/httpapi/HttpApiClient.js:420 (SSE decoded from the response body stream)
  const toStream = response => ... decodeSseStream(response.stream, sse.declaration, sse.decoder) ...
  // <effect>/dist/unstable/http/HttpClientResponse.js:184-186
  get stream() { return this.source.body ? Stream.fromReadableStream({ evaluate: () => this.source.body, ...
  // <effect>/dist/unstable/http/FetchHttpClient.js:55-62
  try: () => fetch(url, { ...options, method: request.method, headers, body, duplex: ..., signal })
  ```

- The shared subscription (`<client>/dist/chunks/rpc-runtime-frbwqjmf.js`) uses `AbortController` and `Promise.withResolvers`, and fails a subscriber after 4,096 queued events. The promise client, which api-msg does not use, reads SSE with `response.body.getReader()` and `TextDecoder` (`<client>/dist/chunks/rpc-runtime-h9cy5hnk.js:77-85`). A browser `WebSocket` appears only in the Solid PTY client (`<client>/dist/chunks/rpc-runtime-gne7h7mq.js:20`).
- The Workers runtime is updated at least weekly to at least the V8 version in stable Chrome, and supports the standard built-ins except `eval` and `new Function` ([web standards](https://developers.cloudflare.com/workers/runtime-apis/web-standards/)).
- **Inference:** from the source alone, the code api-msg reaches uses only `fetch`, web streams, `AbortController` and `effect`, so it plausibly runs on workerd with or without `nodejs_compat`. **This was not run on workerd or Miniflare.**

## 7. Reaching tunnel hostnames on the same zone

- **Same-zone `fetch`** ([compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public)):
  - Without `global_fetch_strictly_public`, requests to the Worker's own zone "are routed to the zone's origin server, ignoring any Workers mapped to the URL and also bypassing Cloudflare security settings".
  - With the flag, they loop back to Cloudflare's "front door" and are treated like Internet requests.
  - The flag has no default-on date listed (opt-out flag: `global_fetch_private_origin`).
- **Worker to Worker on the same zone:**
  - A global `fetch` to another Worker on the same zone, running on a route or on `workers.dev`, fails. Use a service binding instead.
  - Workers on Custom Domains can be reached with `fetch` ([limits](https://developers.cloudflare.com/workers/platform/limits/#worker-to-worker-subrequests), [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/#worker-to-worker-communication)).
- **Tunnel public hostnames** ([tunnel routing](https://developers.cloudflare.com/tunnel/concepts/routing/)):
  - Each hostname is a CNAME to `<UUID>.cfargotunnel.com`, which proxies only for DNS records in the same account.
  - Published applications inherit the hostname's Cloudflare settings: cache, WAF and Rules.
  - No page was found that explicitly covers a Worker fetching a same-zone hostname served by a Tunnel.
- **Workers VPC, tunnel bindings** ([overview](https://developers.cloudflare.com/workers-vpc/)):
  - **Status:** beta. VPC Services entered beta on 2025-11-05 ([changelog](https://developers.cloudflare.com/changelog/post/2025-09-25-workers-vpc/)); VPC Networks and Cloudflare Mesh entered public beta on 2026-04-14 ([changelog](https://developers.cloudflare.com/changelog/post/2026-04-14-vpc-networks/)). "While in beta, Workers VPC is available for free to all Workers plans", and normal Workers pricing applies ([pricing](https://developers.cloudflare.com/workers-vpc/platform/pricing/)).
  - **Limits:** 1,000 VPC Services per account. "Standard Workers limits apply for request size, timeout, and subrequests" ([limits](https://developers.cloudflare.com/workers-vpc/platform/limits/)).
  - **VPC Services** ([VPC Services](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/)):
    - Each service is `http` or `tcp` and targets a tunnel ID plus a host or IP and ports.
    - Workers bind it with `vpc_services: [{ binding, service_id, remote }]` and call `env.BINDING.fetch()`.
    - Requests always go to the configured host and port. The URL's host only sets `Host` and SNI.
    - Certificates from public CAs and Cloudflare Origin CA are trusted. Verification can be `verify_full`, `verify_ca` or `disabled`.
    - Creating a service needs the Connectivity Directory Admin role. Binding needs Connectivity Directory Bind. An API token must belong to a user with those roles.
  - **VPC Networks** use `vpc_networks: [{ binding, tunnel_id | network_id: "cf1:network" }]` to reach any host behind a tunnel through `fetch()` or `connect()` ([VPC Networks](https://developers.cloudflare.com/workers-vpc/configuration/vpc-networks/)).
  - **Tunnel requirements** ([tunnel setup](https://developers.cloudflare.com/workers-vpc/configuration/tunnel/)):
    - `cloudflared` 2025.7.0 or later, using the QUIC transport (outbound UDP 7844).
    - One `cloudflared` can serve Zero Trust published hostnames and Workers VPC at the same time.
    - Ingress rules are not needed for VPC traffic.

## 8. Deploying from GitHub Actions

- **Authentication** ([GitHub Actions guide](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)):
  - CI needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The suggested token template is "Edit Cloudflare Workers", and the official action is `cloudflare/wrangler-action@v4`.
  - That template grants Workers Routes, Scripts, KV Storage and R2 Storage write; Workers Tail read; Account Settings read; and User Details/Memberships read. **It has no D1 permission** ([token templates](https://developers.cloudflare.com/fundamentals/api/reference/template/)).
  - Since 2025-05-02, "`D1:Edit` permission is required for any database writes via HTTP API" ([D1 release notes](https://developers.cloudflare.com/d1/platform/release-notes/)).
  - This repo's `deploy` job already passes both secrets to `bun run --cwd packages/discovery.hena.dev deploy` (`.github/workflows/ci.yml`).
- **D1 migrations in CI:** `wrangler d1 migrations apply <DATABASE> --remote`. In CI or other non-interactive runs, the confirmation step is skipped and a backup is still captured. A migration that errors is rolled back, and earlier successful migrations stay applied ([Wrangler D1 commands](https://developers.cloudflare.com/workers/wrangler/commands/d1/#d1-migrations-apply)). Applied migrations are recorded in `d1_migrations`. `migrations_dir`, `migrations_table` and `migrations_pattern` are configurable ([D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)).
- **Durable Object class lifecycle:**
  - The declarative `exports` field (Wrangler ≥ 4.107.0 per the [CHANGELOG](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/CHANGELOG.md); announced 2026-07-04 in the [changelog](https://developers.cloudflare.com/changelog/post/2026-06-30-declarative-do-class-exports/)) replaces the legacy `migrations` array. Example: `"exports": { "MyDO": { "type": "durable-object", "storage": "sqlite" } }`.
  - The two forms are mutually exclusive. Once a Worker deploys with `exports`, it must keep using it.
  - Lifecycle changes are applied only by `wrangler deploy`. They cannot be rolled out gradually, and rollbacks cannot cross one.
  - A namespace's storage backend cannot be changed once provisioned ([class exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)).
  - `apps/admin/wrangler.jsonc` still uses the legacy form: `"migrations": [{ "tag": "v1", "new_sqlite_classes": ["PersonaAdmin"] }]`.
- **Versions and deployments** ([versions](https://developers.cloudflare.com/workers/versions-and-deployments/), [Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/)):
  - `wrangler deploy` uploads a version and sends it 100% of traffic.
  - `wrangler versions upload` uploads without deploying.
  - `wrangler versions deploy <id>@<pct> ...` deploys one version, or two for a gradual rollout.
  - `wrangler deployments list|status` shows deployments.
  - `wrangler rollback [VERSION_ID] --message ...` rolls back.
  - Rollbacks and gradual deployments can use only the last 100 versions. A rollback leaves bound resources such as D1 and DO data unchanged. It is refused across a DO lifecycle change, or when the target version binds an R2 bucket, KV namespace or queue that no longer exists ([rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/), [gradual deployments](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/)).
- **Gradual deployments with DOs:** each object is pinned to one version for the life of a deployment and resets only when it is assigned a different version. Changes between the Worker and the DO must stay forward- and backward-compatible ([with Durable Objects](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/with-durable-objects/)). The code update strategy flags are covered in §1.

## Implications for api-msg (analysis, not sourced fact)

- **An always-open `follow` stream or OpenCode SSE in a DO is not guaranteed by any documented rule.** Each outbound connection keeps the object alive for at most 15 minutes. After that, the object survives only while requests or events, such as alarms, keep arriving. Deploys, runtime updates and placement moves restart it anyway. Both streams therefore need to resume from a persisted cursor; the existing inbox bookmark fits this. OpenCode events missed during a gap are lost by contract, so the current reconciliation must stay.
- **One always-resident object at 128 MB costs about 0.128 GB × 2,592,000 s = 331,776 GB-s per month.** That fits inside the Paid allowance of 400,000 GB-s/month and the Free allowance of 13,000 GB-s/day (11,059 GB-s/day). A second always-resident object would exceed both.
- **The 55-minute `wait` stream and the 20 s heartbeat are within documented wall-time rules.** However, every deploy restarts the object and cuts the stream, so the plugin must treat reconnecting as normal. Hibernatable inbound WebSockets would remove idle duration cost, but only if the plugin protocol changed.
- **Timers map to one alarm per object plus a schedule table.** Handlers must be idempotent because alarms run at least once with limited retries.
- **api-msg calls `sql.withTransaction` in eight places.** They are in `onboarding/onboarding.ts`, `operator/operator.ts`, `conversations/reset.ts` (two, run one after the other), `conversations/conversations.ts`, `discovery/discovery.ts`, `follow-ups/follow-ups.ts` and `intake/intake.ts`.
  - `@effect/sql-sqlite-do` supports them only if none are nested. The two in `reset.ts` were checked and are not; the others were not audited.
  - `@effect/sql-d1` would need each one rewritten as a `batch`.
  - This favours DO SQLite over D1 for the core state.
- **The operator CLI and backups need new forms.** The Unix-socket operator CLI (`node:http` `createServer` in `src/operator/socket.ts`) has no Workers equivalent, so it would become an authenticated HTTP or RPC surface. Nightly file backups would become DO PITR (30 days) or a D1 export.
- **Reaching `imsg.hena.dev` and `oc.hena.dev`:**
  - Same-zone `fetch` most likely reaches the tunnel as the zone origin, but this is undocumented. Without the strictly-public flag it also bypasses "Cloudflare security settings".
  - Workers VPC is the documented private path, but it is beta and needs `cloudflared` running over QUIC.
- **CI changes:** the token needs D1 Edit if D1 is used. New DO classes should use `exports`, deployed with `wrangler deploy`.

## Unverified or unclear

- Alarm scheduling precision and firing latency are not documented.
- Whether DOs on Workers Free get the 30 s per-invocation CPU limit or the Workers Free 10 ms limit is not stated.
- The per-object DO storage limit on Free: the limits table says 10 GB per object with a 5 GB account total, while the FAQ says 1 GB per object.
- Cron Trigger count: the Workers limits page gives 5 (Free) or 250 (Paid) per account; the alarms page says three per Worker.
- The D1 limit of 1,000 queries per invocation on Paid (50 on Free) conflicts with the newer Workers subrequest limits: 10,000 by default on Paid, and 1,000 to internal services on Free.
- The runtime-update grace period for DO requests is 30 s on the DO lifecycle page and 20 min for Workers requests and connections on the limits page. It is unclear which applies to a stream served by a DO.
- `code_update_strategy: deferred` (the default since Wrangler 4.141.0) is described only by Wrangler's schema and CHANGELOG as waiting for DOs to hibernate. The platform behaviour is not documented on developers.cloudflare.com, and it conflicts with the statement that "Deploying a new version restarts every Durable Object".
- `wrangler versions upload` with `exports`: the DO docs say it "fails fast" if `exports` entries are present. The Wrangler 4.107.0 CHANGELOG says `versions upload` forwards `exports`. Wrangler 4.149.0's `cli.js:181263` throws only for a pending legacy migration.
- A Worker fetching a same-zone hostname served by a Cloudflare Tunnel (for example `imsg.hena.dev`) is not explicitly documented. It is also unclear whether Cloudflare Access on such a hostname is enforced or bypassed by a same-zone subrequest without `global_fetch_strictly_public`.
- Whether long-lived streaming responses work through a Workers VPC Service binding (beta) is not documented beyond "standard Workers limits".
- Whether the 125 s Proxy Read Timeout applies to gaps inside a streamed response body, or only to the wait for response headers, is not specified.
- Binding one D1 database from two Workers has no explicit statement; only the indirect `migrations_dir` remark above.
- The CPU accounting of a DO that processes an outbound stream with no incoming requests is documented only as a "heightened chance" of eviction after 30 s of compute.
- `@opencode/client/effect` on workerd was checked by static inspection only, not by running it.
