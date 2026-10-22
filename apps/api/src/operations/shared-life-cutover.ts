import { Effect } from "effect";
import { AbsolutePath } from "@opencode/schema";
import type { OpenCode } from "@opencode/client/effect";
import { sessionFolders } from "@ren-ai/plugin-session-folder/protocol";
import { loadGroundRules } from "@ren-ai/plugin-session-folder/files";
import { personaDirectory } from "@ren-ai/plugin-session-folder/paths";
import type { Persona } from "@ren-ai/personas";
import { sharedLifePlan, type SharedLifePlan } from "./shared-life-plan.ts";
import { randomUUID } from "node:crypto";
import { contactCause, contactLog, type ContactLog } from "../discovery/diagnostics.ts";
import { join } from "node:path";

type Client = Effect.Success<ReturnType<typeof OpenCode.make>>;

// Validate the complete native inventory before restoring any scope.
const preflight = (client: Client, plan: SharedLifePlan, directory: string) =>
  Effect.gen(function* () {
    const active = yield* client.session.active();
    for (const entry of plan.sessions) {
      const sources = entry.personaID
        ? [directory, join(directory, "sessions", entry.id)]
        : [directory];
      if (!sources.includes(entry.source))
        return yield* Effect.fail(
          new Error("Cutover source is outside the legacy persona location"),
        );
      const session = yield* client.session.get({ sessionID: entry.id });
      const target = entry.personaID ? personaDirectory(directory, entry.personaID) : entry.source;
      if (
        (entry.personaID !== undefined && session.agent !== entry.personaID) ||
        ![entry.source, target].includes(session.location.directory)
      )
        return yield* Effect.fail(new Error("Native session does not match the cutover archive"));
      if (
        Object.hasOwn(active, entry.id) ||
        (yield* client.session.inbox.list({ sessionID: entry.id })).length
      )
        return yield* Effect.fail(
          new Error("Interrupt running sessions and drain queued work before cutover"),
        );
    }
    return undefined;
  });

export const runSharedLifeCutover = (
  client: Client,
  input: {
    readonly directory: string;
    readonly archive: string;
    readonly application: string;
    readonly personas: ReadonlyMap<string, Persona>;
    readonly confirmation: string | undefined;
    readonly log?: ContactLog;
  },
) =>
  Effect.gen(function* () {
    const requestId = randomUUID();
    const started = Date.now();
    const log = input.log ?? contactLog;
    let stage = "preflight";
    const diagnostic = { requestId, operation: "shared-life.cutover" };
    log({ ...diagnostic, stage, outcome: "started", durationMs: 0, level: "info" });
    return yield* Effect.gen(function* () {
      if (input.confirmation !== "yes")
        return yield* Effect.fail(new Error("Cutover requires CONFIRM_BOOTSTRAP_ONLY=yes"));
      const rules = yield* Effect.tryPromise(loadGroundRules);
      const plan = yield* Effect.try(() =>
        sharedLifePlan(input.archive, input.application, input.personas, rules),
      );
      yield* preflight(client, plan, input.directory);
      stage = "restore-scopes";
      for (const snapshot of plan.folders)
        yield* client
          .rpc(sessionFolders)
          .restore({ snapshot }, { location: { directory: input.directory } });
      stage = "move-sessions";
      for (const entry of plan.sessions) {
        if (!entry.personaID) continue;
        const target = personaDirectory(input.directory, entry.personaID);
        if ((yield* client.session.get({ sessionID: entry.id })).location.directory === target)
          continue;
        yield* client.session.move({ sessionID: entry.id, directory: AbsolutePath.make(target) });
        yield* client.session.wait({ sessionID: entry.id });
        if ((yield* client.session.get({ sessionID: entry.id })).location.directory !== target)
          return yield* Effect.fail(new Error("Native session did not move during cutover"));
      }
      return yield* Effect.void;
    }).pipe(
      Effect.tapError((cause) =>
        Effect.sync(() =>
          log({
            ...diagnostic,
            ...contactCause(cause),
            stage,
            outcome: "failed",
            durationMs: Date.now() - started,
            level: "error",
            code: "SHARED_LIFE_CUTOVER_FAILED",
          }),
        ),
      ),
      Effect.mapError(
        () =>
          new Error(
            `Shared-life cutover failed (request ${requestId}); see structured diagnostics`,
          ),
      ),
      Effect.tap(() =>
        Effect.sync(() =>
          log({
            ...diagnostic,
            stage: "complete",
            outcome: "completed",
            durationMs: Date.now() - started,
            level: "info",
          }),
        ),
      ),
    );
  });
