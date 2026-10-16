import { Effect } from "effect";
import { ChildProcess } from "effect/unstable/process";

// imsg emits NDJSON for chats and one object with the same identity fields for group.
const identities = (output: string) => {
  const lines = output.split("\n").filter((line) => line.trim());
  const chats = new Map<string, number>();
  for (const line of lines) {
    // oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: validate native chat identities before UI routing
    const row: unknown = JSON.parse(line);
    if (typeof row !== "object" || row === null) continue;
    if (!("identifier" in row) || typeof row.identifier !== "string") continue;
    if (!("service" in row) || row.service !== "iMessage") continue;
    if (!("is_group" in row) || row.is_group !== false) continue;
    if (!("id" in row) || !Number.isSafeInteger(row.id) || Number(row.id) <= 0) continue;
    chats.set(row.identifier, Number(row.id));
  }
  return { chats, count: lines.length };
};

/** Cache discovery, never authorization: verify cached ROWIDs against fresh chat metadata. */
export const chatLookup = (
  capture: (command: ChildProcess.Command) => Effect.Effect<string, Error>,
) => {
  const cached = new Map<string, number>();
  const query = (args: string[]) =>
    capture(ChildProcess.make("imsg", args, { forceKillAfter: "1 second" })).pipe(
      Effect.flatMap((output) => Effect.try(() => identities(output))),
    );
  return (handle: string) =>
    Effect.gen(function* () {
      const prior = cached.get(handle);
      if (prior !== undefined) {
        const fresh = yield* query(["group", "--chat-id", String(prior), "--json"]);
        if (fresh.chats.get(handle) === prior) return prior;
        cached.clear();
      }
      for (let limit = 100; ; limit *= 2) {
        const page = yield* query(["chats", "--limit", String(limit), "--json"]);
        for (const [identifier, id] of page.chats) cached.set(identifier, id);
        const found = page.chats.get(handle);
        if (found !== undefined) return found;
        if (page.count < limit)
          return yield* Effect.fail(
            new Error("No direct iMessage Conversation for requested Handle"),
          );
      }
    }).pipe(
      Effect.timeout("15 seconds"),
      Effect.tapError(() =>
        Effect.sync(() => {
          cached.clear();
        }),
      ),
      Effect.mapError(
        (error) => new Error(`Cannot find Conversation: ${String(error)}`, { cause: error }),
      ),
    );
};
