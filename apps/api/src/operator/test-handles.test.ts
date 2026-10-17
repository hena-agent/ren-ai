import { Effect } from "effect";
import { expect, test } from "vitest";
import { Session } from "@opencode/schema/session";
import { registration } from "../../test/messaging.test-helper.ts";
import { resetFixture, startTestHandle } from "../../test/reset.test-helper.ts";
import { operatorHandler } from "./api.ts";
import { runOperatorCli } from "./cli.ts";
import { serveTestOperator } from "../../test/operator-http.test-helper.ts";

test("operator commands mark test handles and preserve their sessions on removal until unmarked", async () => {
  const { start, run, fake, handle, cleanup } = await resetFixture("test-handles-");
  try {
    await run(
      Effect.gen(function* () {
        const host = yield* start;
        const api = operatorHandler(host.operator);
        yield* Effect.addFinalizer(() => Effect.promise(api.dispose));
        const connection = yield* serveTestOperator(api.handler);
        expect(yield* runOperatorCli(["test-handle", " 010-1234-5678 "], connection)).toContain(
          "Test handle",
        );
        const old = yield* host.createSession("persona1");
        yield* host.conversations.create(registration(handle, old.id));
        yield* fake.text(handle, "/reset", Date.now());
        yield* startTestHandle(host, fake.messages, handle);
        const fresh = Session.ID.make((yield* host.conversations.byHandle(handle))!.sessionID);
        yield* host.sessions.wait(fresh);
        expect(yield* runOperatorCli(["remove", handle], connection)).toContain("Removed");
        expect(yield* host.conversations.byHandle(handle)).toBeUndefined();
        expect((yield* host.sessions.get(old.id)).title).toContain(" · reset ");
        expect((yield* host.sessions.get(fresh)).title).toMatch(
          /^Persona1 · \+821012345678 · removed \d{4}-\d{2}-\d{2} \w{3} \d{2}:\d{2}$/,
        );
        expect(yield* runOperatorCli(["remove", handle], connection)).toBe(`No User for ${handle}`);
        expect(yield* runOperatorCli(["untest-handle", handle], connection)).toContain("Unmarked");
        expect(yield* runOperatorCli(["remove", handle], connection)).toContain("Removed");
        expect((yield* host.sessions.list()).data).toEqual([]);
        expect(yield* runOperatorCli(["remove", handle], connection)).toBe(`No User for ${handle}`);
      }),
    );
  } finally {
    await cleanup();
  }
});
