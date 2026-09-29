import { Effect } from "effect";
import { Session } from "@opencode/schema/session";
import { expect, test } from "vitest";
import { registration } from "../../test/messaging-host.test-helper.ts";
import { resetFixture, bindTestHandle } from "../../test/reset.test-helper.ts";
import { noticeCopy } from "../onboarding/onboarding.ts";
import { viewerFront } from "../opencode/viewer.ts";

test("a test handle resets Memory into a new session and keeps the old session for review", async () => {
  const { fake, handle, start, run, cleanup } = await resetFixture("reset-");
  try {
    await run(
      Effect.gen(function* () {
        const host = yield* start;
        const old = yield* bindTestHandle(host, handle);
        const at = Date.parse("2026-09-29T05:03:00.000Z");
        yield* fake.text(handle, "My secret is marmalade", at);
        yield* host.sessions.wait(old.id);
        const command = yield* fake.text(handle, " /Reset \n", at + 1);
        const fresh = (yield* host.conversations.byHandle(handle))!;
        expect(fresh.sessionID).not.toBe(old.id);
        const id = Session.ID.make(fresh.sessionID);
        yield* host.sessions.wait(id);
        expect((yield* host.sessions.get(old.id)).title).toBe(
          "Persona1 · tester@example.com · reset 2026-09-29 Tue 14:03",
        );
        const viewer = viewerFront(host.web, "test");
        const listed = yield* Effect.promise(() =>
          viewer(
            new Request("http://viewer/api/session", {
              headers: {
                authorization: `Basic ${Buffer.from("opencode:test").toString("base64")}`,
              },
            }),
          ).then((response) => response.text()),
        );
        expect(listed).toContain(old.id);
        expect(listed).toContain(id);
        expect(listed).toContain(" · reset ");
        expect(JSON.stringify(yield* host.sessions.messages({ sessionID: old.id }))).toContain(
          "marmalade",
        );
        yield* fake.text(handle, "Hello again", at + 2);
        yield* host.sessions.wait(id);
        const memory = JSON.stringify(yield* host.sessions.messages({ sessionID: id }));
        expect(memory).toContain("Hello again");
        expect(memory).toContain("<conversation-started");
        expect(memory).not.toContain("marmalade");
        expect(memory).not.toContain("/Reset");
        expect(fake.bubbles).toContainEqual({ handle, text: noticeCopy.ko });
        yield* fake.redeliver(command);
        expect((yield* host.conversations.byHandle(handle))!.sessionID).toBe(id);
        yield* host.operator.rebuild(handle);
        const rebuilt = Session.ID.make((yield* host.conversations.byHandle(handle))!.sessionID);
        yield* host.sessions.wait(rebuilt);
        const replayed = JSON.stringify(yield* host.sessions.messages({ sessionID: rebuilt }));
        expect(replayed).toContain("Hello again");
        expect(replayed).not.toContain("marmalade");
        expect(replayed).not.toContain("/Reset");
        expect((yield* host.sessions.get(old.id)).title).toContain(" · reset ");
        const history = yield* fake.messages.after(0);
        yield* fake.redeliver({ ...command, id: history.at(-1)!.id + 1 });
        expect((yield* host.conversations.byHandle(handle))!.sessionID).toBe(rebuilt);
        yield* host.sessions.wait(rebuilt);
        expect(JSON.stringify(yield* host.sessions.messages({ sessionID: rebuilt }))).not.toContain(
          "/Reset",
        );
        yield* fake.replace(history.filter((row) => row.guid !== command.guid));
        yield* fake.text(handle, "after history replacement", Date.now() + 100);
        yield* host.sessions.wait(rebuilt);
        expect(JSON.stringify(yield* host.sessions.messages({ sessionID: rebuilt }))).toContain(
          "after history replacement",
        );
      }),
    );
  } finally {
    await cleanup();
  }
});

test("only a complete command from a marked, active User resets and unrelated handles keep their Memory", async () => {
  const { fake, handle, start, run, cleanup } = await resetFixture("reset-command-");
  try {
    await run(
      Effect.gen(function* () {
        const host = yield* start;
        const old = yield* host.createSession("persona1");
        const other = yield* host.createSession("persona1");
        yield* host.conversations.create(registration(handle, old.id));
        yield* host.conversations.create(registration("other@example.com", other.id));
        yield* fake.text(handle, "/reset", Date.now());
        expect((yield* host.conversations.byHandle(handle))!.sessionID).toBe(old.id);
        yield* host.operator.testHandle("unknown@example.com", true);
        yield* fake.text("unknown@example.com", "/reset", Date.now());
        yield* host.operator.testHandle(handle, true);
        const ordinary = yield* fake.text(handle, "/reset please", Date.now());
        yield* fake.edit(ordinary.guid, "/reset");
        yield* Effect.sleep("1100 millis");
        yield* host.sessions.wait(old.id);
        expect((yield* host.conversations.byHandle(handle))!.sessionID).toBe(old.id);
        yield* fake.outgoing(handle, "/reset", Date.now());
        expect((yield* host.conversations.byHandle(handle))!.sessionID).toBe(old.id);
        const before = yield* fake.text(handle, "old target", Date.now());
        const reset = yield* fake.text(handle, "/RESET", Date.now());
        const id = Session.ID.make((yield* host.conversations.byHandle(handle))!.sessionID);
        yield* fake.text(handle, "late old row", reset.createdAt - 1);
        yield* fake.text(handle, "", Date.now(), {
          tapback: { emoji: "👍", targetGuid: "missing", added: true },
        });
        yield* fake.text(handle, "", Date.now(), {
          tapback: { emoji: "👍", targetGuid: before.guid, added: true },
        });
        const current = yield* fake.text(handle, "new target", Date.now());
        yield* fake.text(handle, "", Date.now(), {
          tapback: { emoji: "👍", targetGuid: current.guid, added: true },
        });
        yield* fake.outgoing(handle, "new manual outgoing", Date.now());
        yield* host.sessions.wait(id);
        const memory = JSON.stringify(yield* host.sessions.messages({ sessionID: id }));
        expect(memory).toContain("new manual outgoing");
        expect(memory).toContain("<tapback");
        expect(memory).not.toContain("old target");
        expect(memory).not.toContain("late old row");
        expect((yield* host.conversations.byHandle("other@example.com"))!.sessionID).toBe(other.id);
        yield* fake.text("other@example.com", "/reset", Date.now());
        yield* host.sessions.wait(other.id);
        expect(JSON.stringify(yield* host.sessions.messages({ sessionID: other.id }))).toContain(
          "/reset",
        );
        const rows = yield* fake.messages.after(0);
        yield* fake.redeliver({
          ...ordinary,
          id: rows.at(-1)!.id + 1,
          text: "/reset",
          createdAt: Date.now(),
        });
        expect((yield* host.conversations.byHandle(handle))!.sessionID).toBe(id);
        yield* fake.redeliver({
          ...reset,
          guid: "late-reset-command",
          id: rows.at(-1)!.id + 2,
          createdAt: reset.createdAt - 1,
        });
        expect((yield* host.conversations.byHandle(handle))!.sessionID).toBe(id);
        yield* host.operator.block(handle);
        yield* fake.text(handle, "/reset", Date.now());
        expect((yield* host.sessions.list()).data).toHaveLength(3);
      }),
    );
  } finally {
    await cleanup();
  }
});
