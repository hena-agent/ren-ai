# Shared-life cutover (ADR-0023)

This is the explicitly approved, data-preserving replacement of session-owned
State/Memory. Run it during a planned pause. It moves existing native sessions;
it does not replay conversations or send messages.

## Prepare and pause

1. Stage matching Worker and plugin artifacts. Save the current Worker revision,
   plugin volume, OpenCode home volume and writable sessions volume for rollback.
   Install into fresh plugin and persona/Sandbox volumes, never over those backups.
2. Set the application to `BOOTSTRAP_ONLY=true`. Leave Messages receiving.
   Record unresolved outgoing attempts; missing Messages rows never authorize
   resending an uncertain attempt. Stop model execution and drain queued work
   before exporting. An interrupted turn must remain recoverable in application
   state; do not discard an inbox merely to make the preflight pass.
3. With the **old checkout and old plugins**, export the entire managed native
   location using `ops/session-transfer.ts export OLD-SESSIONS.json`. This must
   be the ADR-0012 version-1 archive with each session's folder documents/runtime.
   Capture `/management/state/export` using the existing management credential.
   Both archives are private. Keep them owner-only, encrypt the off-host copy,
   and keep the files unchanged throughout retries.
4. Stop OpenCode and take a coherent full-home/volume backup. This preserves
   native history, fork metadata, credentials and the old Markdown files beyond
   what the cutover command consumes. Use the old checkout's backup tooling for
   the old five-volume layout. The current backup tools describe six volumes.

## Convert

1. Install the staged plugins and current `opencode.sessions.compose.yml` overlay.
   Its writable mounts are `/srv/ren-ai/personas` and `/srv/ren-ai/sandboxes`.
   The original sessions volume remains preserved offline. Keep the callback
   application bootstrap-only and confirm no session is executing automatically.
2. Use the protected OpenCode URL/authorization and Catalog URL/token environment
   from the existing operator workflow, with `OPENCODE_DIRECTORY=/srv/ren-ai`.
   Run from `apps/api`:

   ```sh
   CONFIRM_BOOTSTRAP_ONLY=yes bun ops/session-transfer.ts shared-life \
     /absolute/private/OLD-SESSIONS.json /absolute/private/APPLICATION-STATE.json
   ```

   The command validates every source binding and native session before writing.
   It refuses duplicate active owners, missing Catalog personas, missing sessions,
   queued/running work, unfinished rebuilds and unrelated source locations. Folder restoration and
   native moves are separately retryable from the **same** source archives;
   conflicting existing target documents are rejected, never overwritten.
   Ordinary `restore` accepts only version-2 persona-scoped archives; it cannot
   treat a version-1 Conversation snapshot as shared life.

3. Inspect the result before resuming:
   - Each persona has one root and every retained/ended/active session keeps its
     native ID and history while opening that root.
   - The former active Conversation contributes only the five condition axes,
     traits and language proficiency to shared State. Old reasons and private
     additions remain in the Relationship scope.
   - Old affection, additional values and both memory tiers remain private to
     their original Conversation. Retained/ended scopes preserve the complete
     former State for review and are read-only.
   - Life memory starts from Catalog initial Memory. If there was no active
     Conversation, shared State also starts from Catalog initial State.
   - Receipts are preserved with session-qualified keys. Session deletion cannot
     delete shared life or a sibling's Relationship scope.
4. Deploy the matching Worker schema while paused. Confirm existing assignments,
   pending first contacts, message GUIDs, follow-ups and uncertain sends remain.
   The new limit is five current assignments per persona and one per handle;
   failed or uncertain first contacts retain their reservation.

## Resume and verify

Enable exactly one intake, then submit an authenticated intake wake to catch up.
With test handles, verify two users reach different sessions in one persona root,
share condition/proficiency changes, and cannot search one another's facts.
Exercise stale-write rejection, reset, rebuild, fork isolation and delayed sends.
Verify exact artifact revisions and readiness for api-app, api-msg and imsg, and
the installed OpenCode plugin artifact. Publishing CI artifacts alone does not
prove installation or public `oc.renai.im` routing.

If a step fails, keep execution paused, use its structured request ID to locate
the stage/cause, and retry only the same verified archives. For rollback, restore
the matching Worker and whole OpenCode/plugin/storage backups together. Reconcile
any sends made since the snapshot before resuming; never run old and new intake
simultaneously. Keep the source backups until rollout is accepted.
