import { rm } from "node:fs/promises";
import {
  messagingFixture,
  quietTestHost,
  registration,
  runMessagingTest,
} from "../../test/messaging-host.test-helper.ts";
import { Session } from "@opencode/schema/session";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { fakeMessages } from "../messages/messages.fake.ts";
import { noticeCopy } from "../onboarding/onboarding.ts";
import { setupRebuilding } from "./rebuild.ts";

test("a deleted session heals on the next message and an operator rebuild replaces its Memory", async () => {
  const { root, personaDirectory } = await messagingFixture("rebuild-host-", "안녕");
  const fake = fakeMessages();
  let failReplay = false;
  let beforeReplay: (() => Effect.Effect<void, Error>) | undefined;
  const messages = {
    ...fake.messages,
    after: (cursor: number) =>
      Effect.gen(function* () {
        if (failReplay) {
          failReplay = false;
          return yield* Effect.fail(new Error("Messages unavailable"));
        }
        if (beforeReplay) {
          yield* beforeReplay();
          beforeReplay = undefined;
        }
        return yield* fake.messages.after(cursor);
      }),
  };
  try {
    await runMessagingTest(
      Effect.gen(function* () {
        const host = yield* quietTestHost(root, personaDirectory, messages);
        const old = yield* host.createSession("persona1");
        const conversation = yield* host.conversations.create(
          registration("user@example.com", old.id),
        );
        yield* host.sessions.remove(old.id);
        failReplay = true;
        const failed = yield* fake
          .text(conversation.handle, "during failure", Date.now() + 1)
          .pipe(Effect.flip);
        expect(failed.message).toContain("Messages unavailable");
        const first = yield* fake.text(conversation.handle, "recover this", Date.now() + 1);
        const healed = (yield* host.conversations.byHandle(conversation.handle))!;
        expect(healed.id).toBe(conversation.id);
        expect(healed.sessionID).not.toBe(old.id);
        yield* host.sessions
          .wait(Session.ID.make(healed.sessionID))
          .pipe(Effect.timeout("20 seconds"));
        expect(
          JSON.stringify(
            yield* host.sessions.messages({ sessionID: Session.ID.make(healed.sessionID) }),
          ),
        ).toContain(first.text);
        yield* fake.outgoing(conversation.handle, "her own", Date.now() + 2);
        beforeReplay = () => host.sessions.remove(Session.ID.make(healed.sessionID));
        expect(yield* host.operator.rebuild(conversation.handle)).toBe("rebuilt");
        const replaced = (yield* host.conversations.byHandle(conversation.handle))!;
        expect(replaced.sessionID).not.toBe(healed.sessionID);
        yield* host.sessions
          .wait(Session.ID.make(replaced.sessionID))
          .pipe(Effect.timeout("20 seconds"));
        const memory = JSON.stringify(
          yield* host.sessions.messages({ sessionID: Session.ID.make(replaced.sessionID) }),
        );
        expect(memory).toContain("recover this");
        expect(memory).toContain("during failure");
        expect(memory).toContain("<sent-by-you");
        expect(memory).toContain("her own");
        expect(fake.bubbles).toEqual([]);
        yield* host.conversations.block(conversation.handle);
        expect(yield* host.operator.rebuild(conversation.handle)).toBe("not_found");
        const missing = yield* host.createSession("persona1");
        yield* host.conversations.create(registration("restore@example.com", missing.id));
        yield* host.sessions.remove(missing.id);
        const existing = yield* fake.messages.after(0);
        yield* fake.replace([
          ...existing,
          {
            id: existing.at(-1)!.id + 1,
            guid: "missed-on-startup",
            handle: "restore@example.com",
            createdAt: Date.now() + 1,
            text: "missed during downtime",
            fromMe: false,
          },
        ]);
        const restarted = yield* setupRebuilding(
          host.conversations,
          host,
          messages,
          noticeCopy,
          () => Effect.succeed(false),
          () => Effect.void,
          () => Effect.void,
          () => Effect.void,
          () => Effect.void,
        );
        expect(restarted.recovery).toBeDefined();
        const resumed = (yield* host.conversations.byHandle("restore@example.com"))!;
        expect(resumed.sessionID).not.toBe(missing.id);
        yield* host.sessions
          .wait(Session.ID.make(resumed.sessionID))
          .pipe(Effect.timeout("20 seconds"));
        expect(
          JSON.stringify(
            yield* host.sessions.messages({ sessionID: Session.ID.make(resumed.sessionID) }),
          ),
        ).toContain("missed during downtime");
        yield* Effect.promise(host.disposeOnboarding);
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
