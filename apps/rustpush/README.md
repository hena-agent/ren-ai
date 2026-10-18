# Rustpush messaging bridge

Native macOS IDS/APNs transport for `apps/imsg`. One long-running JSON-lines bridge
serves the gateway's texts, read receipts, typing and tapbacks, and emits durable
incoming notifications. Every Persona uses `hi@renai.im`. Installation and recovery
are documented in the [gateway runbook](../imsg/ops/README.md).

## Feasibility experiment: verified live

On 2026-10-16, on the local Apple Silicon Mac:

| Check                                                          | Result                                                                                    |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Native hardware validation                                     | Passed; generated a nonempty Apple validation response                                    |
| APNs activation/connect                                        | Passed using the upstream legacy activation certificate                                   |
| Apple Account sign-in                                          | Passed with locally entered password and verification code                                |
| IDS registration                                               | Initially failed with `6001`; passed after the operator disabled Contact Key Verification |
| Bot-first send from the custom-domain alias                    | Passed; delivery receipt received and sender confirmed by the operator                    |
| Alternate local sender to the same recipient, then switch back | Passed; both delivery receipts received and both sender identities confirmed              |
| Incoming reply                                                 | Received and saved with the expected local/remote participants                            |
| Read receipt                                                   | Operator confirmed                                                                        |
| Thumbs-up reaction                                             | Operator confirmed                                                                        |
| Typing start/stop                                              | Operator confirmed during the 20-second test                                              |
| Incoming image                                                 | Received; downloaded successfully in a fresh process; detected as HEIC                    |
| Session restoration                                            | Each subsequent command restored persisted keys and registration without another sign-in  |

This table records the original standalone experiment, not an end-to-end test of
the new gateway. Runtime diagnostics exclude handles and content.
The second-alias incoming-reply check was skipped by the operator; its listener
timed out without a matching reply, so that check remains unverified.

## Gateway: verified live

On 2026-10-17 (local Mac time), the packaged Bun gateway and native bridge were
tested in an isolated home with fresh SQLite history and the existing private
Apple session. The operator supplied the test handle in chat.

| Check                                      | Result                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| Authenticated readiness                    | HTTP 200, service `imsg`, revision `development`                       |
| First text through the existing RPC client | Delivered; operator confirmed `hi@renai.im`                            |
| Incoming text and photo                    | Stored; image fetched through RPC and converted to JPEG                |
| Read receipt and thumbs-up                 | Accepted by bridge; operator confirmed both                            |
| Typing                                     | Operator confirmed the 15-second indicator                             |
| Outgoing status                            | Delivery and the recipient's read timestamp recorded                   |
| Restart/catch-up                           | 22 existing rows preserved; offline reply received; no duplicate GUIDs |
| Cleanup                                    | Isolated gateway stopped; production services were not changed         |

The same photo exposed a separate failure in the deployed OpenCode context plugin:
reconstructing a message through the plugin's SDK rejected the core-created
`Media.Asset` instance before provider dispatch. The model advertises image input.
A synthetic-image compiled-plugin regression reproduced the failure. PR #97's fix
preserves core-created media while updating send results; it has been deployed and
verified independently of the Rustpush transport cutover.

## Run

Requirements: macOS, Xcode command-line tools, Rustup, and `protoc`.

```sh
cd apps/rustpush
bash prepare.sh
cargo build --locked
export RUSTPUSH_STATE_DIR=/absolute/private/apple-state
./target/debug/ren-rustpush preflight
./target/debug/ren-rustpush login
```

`login` asks for the Apple Account, hidden password and verification code in the
local terminal. It reuses an existing identity on subsequent runs. Passwords are
not written to disk. Contact Key Verification is incompatible with this tested
registration path; enabling/disabling it is an operator account-setting decision.

```sh
./target/debug/ren-rustpush rpc mailto:hi@renai.im
```

The gateway owns bridge stdin/stdout. Requests have `{id, requestId, method, params}`;
`requestId` is a gateway-generated UUID shared by gateway/native diagnostics and
returned on errors. Replies
have the same `id` and either `result` or a sanitized `error`. Methods are `handles`,
`send`, `typing`, `read`, `react` and `ack`. The selected local handle is immutable
for the process and must already be registered. Incoming events are emitted as
`{event:"message", spool, message}` and repeated until acknowledged by spool ID.
Only the gateway acknowledges after its history commit. Do not acknowledge manually.

Definitive recipient acceptance yields `sent`; unanimous device rejection yields
`failed`. Missing, lagged or timed-out results stay uncertain. Requests are bounded
to 120 seconds; lost outcomes must not be retried automatically. The supervisor
restarts a bridge that does not answer within 125 seconds. Native diagnostics go
to stderr because stdout belongs to the protocol.

`RUSTPUSH_STATE_DIR` is required; the gateway sets it to `$IMSG_HOME/rustpush`.
The directory is mode `0700`, our files are `0600`, and a process lock prevents
concurrent writers. Keys, registration, message bodies, raw incoming notifications
and downloaded images are private state and are Git-ignored. File writes use
atomic replacement and fsync. Upstream diagnostic logging is not enabled because
it can contain account details and message payloads.

Readiness requires generated APNs and IDS resources plus a bounded live APNs ping;
cached registration handles alone do not establish readiness.

## Build provenance

Development and test builds retain line-table debug information for backtraces and
disable incremental compilation to limit disk usage. Cargo shares intermediate
artifacts across worktrees in `$CARGO_HOME/build/ren-ai-rustpush` (normally
`~/.cargo/build/ren-ai-rustpush`). Run Cargo from `apps/rustpush` so it loads the
local `.cargo/config.toml`. Final executables remain in each checkout's `target/`.
Cargo reuses compatible dependencies; checkout-local path dependencies can still
require rebuilding.

Coverage intermediates use the shared build directory's `llvm-cov-target/`.
`bash check.sh` locks the complete coverage operation across worktrees, including
cleanup and report validation. Use that command for coverage; concurrent direct
`cargo llvm-cov` invocations bypass the lock. Reports remain checkout-local.
Avoid `cargo clean` while another worktree is building: it also clears shared
intermediates. Old checkout-local `target/` directories from before this setup can
be removed once builds and executables using them have stopped.

`prepare.sh` checks out pinned dependencies into the repository's ignored dependency
cache, `node_modules/.cache/ren-rustpush`, and applies `native.patch`:

- [OpenBubbles/rustpush](https://github.com/OpenBubbles/rustpush/tree/b3c96c23e1aae78d1229ebaccb12027624f1eaff)
  at `b3c96c23e1aae78d1229ebaccb12027624f1eaff`, including pinned submodules.
- [jasonlaguidice/imessage](https://github.com/jasonlaguidice/imessage/tree/595ce7e9bb588fbcf7cbe9906a0b79b7b0869c41)
  at `595ce7e9bb588fbcf7cbe9906a0b79b7b0869c41`: its native NAC library,
  hardware-info reader and local macOS configuration builder. See its `LICENSE`
  for the AGPL-3.0 terms and the Rustpush repository for its license/exceptions.

The patch replaces the nonfunctional public hardware-validation stub with native
NAC, selects the included legacy activation certificate explicitly, exposes send
acknowledgement outcomes, tolerates a closed topic queue during shutdown, and
adds an incoming-notification persistence callback before the APNs acknowledgement.
It also disables automatic retries of unconfirmed submissions, makes send tasks
abort on owner cancellation, and subscribes before sending while matching APNs
acknowledgements to their exact notification ID. A closed result channel counts as
unanimous rejection only after the submission task completes successfully; numeric
provider rejection codes remain available in diagnostics.
No generated placeholder activation keys are used.

Rust 1.95 is pinned because this Rustpush revision uses atomic APIs unavailable in
the previously installed 1.93 toolchain. `Cargo.lock` is retained because a fresh
dependency resolution rejects upstream's now-yanked `zip` 2.x dependency.

## Remaining verification before production

- Verify the application/executor path against the replacement gateway at the
  separately approved cutover; the live matrix above covers the gateway RPC client.
- Historical backfill/synchronization with existing Messages conversations. The
  files here retain experiment events; they are not a Messages history import.
- Long-running registration renewal, APNs reconnect, crash/replay, interruption of
  uncertain sends, sustained load and malformed incoming message testing.
- Production-grade handling of upstream task panics and failures. The callback
  fails the process if persistence fails, and pending files survive restart, but
  end-to-end crash/replay behavior still needs verification.
- Native transport, delivery classification, command validation, state restoration,
  persistence and diagnostics have 100% LLVM line/function/region coverage.
  `check.sh` still fails on the live Apple adapters and process bootstrap. Narrow
  exceptions for these three integration files have been proposed for the human-owned
  `quality-exceptions.json`; the checker uses that same registry and never silently
  excludes owned files.
- Native complexity and file length use `rust-code-analysis-cli`; Clippy also
  enforces cognitive complexity and dead-code warnings. The shared duplication gate
  includes Rust. Native code has no TypeScript `any` escape hatch.

## Checks

```sh
bash -n prepare.sh
bash prepare.sh # also checks that setup can be repeated
cargo install cargo-llvm-cov --version 0.8.5 --locked
cargo install rust-code-analysis-cli --version 0.0.25 --locked
cargo test --locked
bash check.sh
```

Tests cover explicit sender selection/fail-closed behavior, private atomic state
restoration and exclusive access, durable queue replay order, and correlated
failure diagnostics excluding private inputs. Injected filesystem failures verify
that incomplete state and images are not published. RPC tests cover unresponsive
sends, invalid requests, closed gateway output and retained failed notifications.
Live Apple behavior is recorded above separately from these automated checks.

CI requires the native check job before publishing a Mac artifact. Its coverage
failure is a merge blocker, even if the TypeScript checks pass. Production cutover
remains separate from implementation and local testing.
