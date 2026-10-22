import { fromPartial } from "@total-typescript/shoehorn";
import { Session } from "@opencode/schema/session";
import { DateTime, Effect } from "effect";
import { expect, test, vi } from "vitest";
import { failedTurns } from "./failed-turns.ts";
import type { PersonaRuntime } from "./runtime.ts";
import { conversations } from "../conversations/conversations.ts";
import { migrate } from "../database.ts";
import { registration, runMessagingTest, silentAlerts } from "../../test/messaging.test-helper.ts";

test("recovery has a bounded fair inspection budget that survives runtime replacement", async () => {
  await runMessagingTest(
    Effect.gen(function* () {
      yield* migrate;
      const directory = yield* conversations;
      const all = vi.spyOn(directory, "all");
      for (let i = 0; i < 1000; i++)
        yield* directory.create(
          registration(`user-${i}@example.com`, `ses_${i}`, `persona${Math.floor(i / 5) + 1}`),
        );
      const inspected: string[] = [];
      const host = fromPartial<PersonaRuntime>({
        sessions: {
          get: (id: Session.ID) =>
            Effect.sync(() => {
              inspected.push(id);
              return fromPartial<Session.Info>({
                outcome: "succeeded",
                time: { idle: DateTime.makeUnsafe(1) },
              });
            }),
          inbox: () => Effect.succeed([]),
          messages: () => Effect.succeed([]),
        },
      });
      const first = yield* failedTurns(host, directory, silentAlerts, false);
      expect(inspected).toHaveLength(0);
      yield* first.tick;
      expect(inspected).toHaveLength(20);
      yield* first.tick;
      expect(new Set(inspected).size).toBe(40);
      const replacement = yield* failedTurns(host, directory, silentAlerts);
      expect(new Set(inspected).size).toBe(60);
      for (let i = 0; i < 47; i++) yield* replacement.tick;
      expect(new Set(inspected).size).toBe(1000);
      yield* replacement.tick;
      expect(inspected.slice(-20)).toEqual(inspected.slice(0, 20));
      expect(all).not.toHaveBeenCalled();
      yield* replacement.check(["ses_999"]);
      expect(inspected.at(-1)).toBe("ses_999");
    }),
  );
});
