import { randomUUID } from "node:crypto";
import { Effect, Result } from "effect";
import { expect, test } from "vitest";
import { relationshipFixture } from "../../test/relationship.test-helper.ts";
import { withContactDatabase } from "../discovery/contact.test-helper.ts";
import { conversationEndings } from "./end.ts";
import { endingNotifications } from "./notifications.ts";
import { conversationStatus } from "./status.ts";
import { fakeNotifications, messageGateway } from "@ren-ai/imsg/testing";
import { remoteMessages } from "@ren-ai/imsg/client";
import { FetchHttpClient } from "effect/http";
import { prepareMessaging } from "../application-tools.ts";

test("ending delivery uses the separate authenticated Mac notification RPC and observes later receipts", () =>
  withContactDatabase(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* relationshipFixture;
        const submitted: string[] = [];
        let delivered = false;
        const gateway = messageGateway(f.fake.messages, "test-secret", f.ui.gestures, {
          ...fakeNotifications(),
          sendText: (_handle, text) =>
            Effect.sync(() => {
              submitted.push(text);
              return { guid: "notification-guid" };
            }),
          status: () =>
            Effect.succeed({
              state: delivered ? ("delivered" as const) : ("sent" as const),
              error: 0,
              dateRead: null,
            }),
        });
        yield* Effect.addFinalizer(() => Effect.promise(gateway.dispose));
        const messages = yield* remoteMessages({
          url: "https://imsg.test/rpc",
          token: "test-secret",
        }).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.provideService(FetchHttpClient.Fetch, (input, init) =>
            gateway.handler(new Request(input, init)),
          ),
        );
        const app = yield* prepareMessaging(f.personas, messages, f.ui.gestures);
        yield* app.endings.end(f.conversation.sessionID, "bye", "rpc-end");
        yield* app.endings.tick;
        expect(f.fake.bubbles).toEqual([{ handle: f.conversation.handle, text: "bye" }]);
        expect(submitted).toHaveLength(1);
        expect(submitted[0]).toContain("#reselect=");
        delivered = true;
        yield* app.endings.observe(f.conversation.id);
        const status = yield* conversationStatus(async () => []);
        expect((yield* status.detail(f.conversation.id))?.entry.notice).toBe("delivered");
        yield* app.endings.observe(f.conversation.id);
        expect(submitted).toHaveLength(1);
      }),
    ),
  ));

test("a lost notification acknowledgement stays uncertain across replacement, without persona fallback or automatic resend", () =>
  withContactDatabase(
    Effect.gen(function* () {
      const f = yield* relationshipFixture;
      let attempts = 0;
      const messages = {
        ...f.fake.messages,
        notify: () => {
          attempts++;
          return Effect.fail(
            Object.assign(new Error("private notification payload"), { code: "UPSTREAM_DOWN" }),
          );
        },
      };
      const ending = yield* conversationEndings(
        f.app.directory,
        f.app.sends,
        messages,
        f.ui.gestures,
        f.personas,
        (event) => f.logs.push(event),
      );
      yield* ending.end(f.conversation.sessionID, "private farewell", "lost-notification");
      yield* ending.tick;
      const restarted = yield* conversationEndings(
        f.app.directory,
        f.app.sends,
        messages,
        f.ui.gestures,
        f.personas,
        (event) => f.logs.push(event),
      );
      yield* restarted.tick;
      yield* restarted.observe(f.conversation.id);
      expect(attempts).toBe(1);
      expect(f.fake.notifications).toEqual([]);
      expect(f.fake.bubbles).toEqual([{ handle: f.conversation.handle, text: "private farewell" }]);
      const status = yield* conversationStatus(async () => []);
      expect((yield* status.detail(f.conversation.id))?.entry.notice).toBe("uncertain");
      expect(
        Result.isFailure(
          yield* Effect.result(
            restarted.recover({
              id: f.conversation.id,
              action: "notice",
              requestId: randomUUID(),
            }),
          ),
        ),
      ).toBe(true);
      expect(f.logs.filter((event) => event.stage === "notification.submit")).toMatchObject([
        {
          outcome: "failed",
          level: "error",
          causeCode: "UPSTREAM_DOWN",
        },
      ]);
      expect(JSON.stringify(f.logs)).not.toMatch(
        /private notification payload|private farewell|821099999999|reselect=/,
      );
    }),
  ));

test("notification status failures remain observable and confirmed transport failure supports one explicit new attempt", () =>
  withContactDatabase(
    Effect.gen(function* () {
      const f = yield* relationshipFixture;
      let failStatus = true;
      const ending = yield* conversationEndings(
        f.app.directory,
        f.app.sends,
        {
          ...f.fake.messages,
          notificationStatus: () =>
            failStatus
              ? Effect.fail(new Error("private status payload"))
              : Effect.succeed({ state: "failed" as const, error: 22, dateRead: null }),
        },
        f.ui.gestures,
        f.personas,
        (event) => f.logs.push(event),
      );
      yield* ending.end(f.conversation.sessionID, "bye", "status-failure");
      yield* ending.tick;
      yield* ending.observe(f.conversation.id);
      expect(
        f.logs.some((event) => event.stage === "ending.notice" && event.causeName === "Error"),
      ).toBe(true);
      expect(f.logs.some((event) => event.stage === "ending.observe.notice")).toBe(true);
      failStatus = false;
      yield* ending.tick;
      expect(f.logs.find((event) => event.stage === "notification.status")).toMatchObject({
        level: "error",
        outcome: "failed",
        code: "IMSG_SEND_22",
      });
      expect(f.fake.notifications).toHaveLength(1);
      yield* f.ending.recover({ id: f.conversation.id, action: "notice", requestId: randomUUID() });
      yield* f.ending.tick;
      expect(f.fake.notifications).toHaveLength(2);
      expect(yield* f.sql`SELECT state FROM ending_notification ORDER BY call_id`).toEqual([
        { state: "failed" },
        { state: "sent" },
      ]);
      expect(JSON.stringify(f.logs)).not.toMatch(/private status payload|821099999999|reselect=/);
    }),
  ));

test("notification submission is fenced and atomically deduplicated, and a failed GUID checkpoint cannot authorize resubmission", () =>
  withContactDatabase(
    Effect.gen(function* () {
      const f = yield* relationshipFixture;
      const notifications = yield* endingNotifications(f.fake.messages, (event) =>
        f.logs.push(event),
      );
      yield* f.ending.end(f.conversation.sessionID, "bye", "checkpoint");
      const [row] = yield* f.sql<{ notice: string }>`SELECT notice FROM conversation_end`;
      yield* notifications.send(f.conversation, "wrong content", "checkpoint:notice:0");
      expect(f.fake.notifications).toEqual([]);
      yield* f.sql`CREATE TRIGGER fail_guid BEFORE UPDATE OF guid ON ending_notification BEGIN SELECT RAISE(ABORT, 'private failure'); END`;
      yield* notifications.send(f.conversation, row!.notice, "checkpoint:notice:0");
      yield* notifications.send(f.conversation, row!.notice, "checkpoint:notice:0");
      expect(f.fake.notifications).toHaveLength(1);
      expect(f.logs.at(-1)).toMatchObject({
        stage: "notification.commit",
        outcome: "failed",
      });
      expect(yield* notifications.delivery(f.conversation, "checkpoint:notice:0")).toBe(
        "uncertain",
      );
      yield* f.sql`DROP TRIGGER fail_guid`;
      yield* f.ending.tick;
      expect(f.fake.notifications).toHaveLength(1);
      expect(JSON.stringify(f.logs)).not.toMatch(/private failure|821099999999|reselect=/);
      yield* f.sql`DELETE FROM user`;
      expect(yield* f.sql`SELECT 1 FROM ending_notification`).toEqual([]);
    }),
  ));
