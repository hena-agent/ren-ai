import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigProvider, Effect, Scope } from "effect";
import { FetchHttpClient } from "effect/http";
import { afterEach, expect, test, vi } from "vitest";
import { bridgeFixture, incoming, service } from "../../test/bridge.test-helper.ts";
import { listenerUrl } from "../../test/listener.test-helper.ts";
import { captureGatewayLogs } from "../../test/gateway.test-helper.ts";
import { remoteMessages } from "./client.ts";
import { startMessagingGateway } from "./runtime.ts";

const notification = "mailto:noti@renai.im";
const handle = "+821012345678";
const them = `tel:${handle}`;
const healthResponse = (url: string) =>
  Effect.promise(() => fetch(`${url}/health`, { headers: { Authorization: "Bearer secret" } }));
const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true });
});

const fixture = (handles = [service, notification]) => {
  const directory = mkdtempSync(join(tmpdir(), "imsg-notifications-"));
  directories.push(directory);
  const bridge = bridgeFixture(handles);
  const run = <A, E>(
    story: (
      remote: Effect.Success<ReturnType<typeof remoteMessages>>,
      url: string,
    ) => Effect.Effect<A, E, Scope.Scope>,
  ) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const gateway = yield* startMessagingGateway;
          const url = listenerUrl(gateway.listener);
          const remote = yield* remoteMessages({ url: `${url}/rpc`, token: "secret" });
          yield* Effect.promise(() => vi.waitFor(() => Effect.runPromise(remote.probe())));
          return yield* story(remote, url);
        }).pipe(
          Effect.provide(bridge.layer),
          Effect.provide(FetchHttpClient.layer),
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                IMSG_TOKEN: "secret",
                IMSG_PORT: "0",
                IMSG_HOME: directory,
              }),
            ),
          ),
        ),
      ),
    );
  return { bridge, run };
};

test("Notifications use their own handle and never enter Persona history or gestures", async () => {
  const f = fixture();
  await f.run((remote) =>
    Effect.gen(function* () {
      const seen: string[] = [];
      const stop = yield* remote.follow(0, (row) =>
        Effect.sync(() => {
          seen.push(row.text);
        }),
      );
      const { guid } = yield* remote.notify(handle, "private notification");
      expect(f.bridge.requests.find((request) => request.method === "send")?.params).toEqual({
        from: notification,
        to: them,
        guid,
        text: "private notification",
      });
      expect(yield* remote.notificationStatus(guid)).toEqual({
        state: "sent",
        error: 0,
        dateRead: null,
      });
      f.bridge.deliver(
        incoming(them, "ignored reply", 100, { participants: [them, notification] }),
      );
      f.bridge.deliver(
        incoming(notification, "private notification", 101, {
          guid,
          participants: [them, notification],
        }),
      );
      const reply = incoming(them, "persona reply", 102);
      f.bridge.deliver(reply);
      yield* Effect.promise(() => vi.waitFor(() => expect(f.bridge.acknowledged).toHaveLength(3)));
      const greeting = yield* remote.sendText(handle, "persona greeting");
      expect(
        f.bridge.requests.filter((request) => request.method === "send").at(-1)?.params,
      ).toMatchObject({ from: service, guid: greeting.guid });
      yield* Effect.promise(() =>
        vi.waitFor(() => expect(seen).toEqual(["persona reply", "persona greeting"])),
      );
      expect((yield* remote.after(0)).map((row) => row.text)).toEqual(seen);
      expect((yield* remote.recent(handle, 0)).map((row) => row.text)).toEqual(seen);
      expect((yield* remote.status(guid)).state).toBe("pending");
      yield* remote.gestures.read(handle);
      expect(f.bridge.requests.find((request) => request.method === "read")?.params).toEqual({
        to: them,
        guid: reply.guid,
      });
      stop();
    }),
  );
});

test("an unregistered Notification handle is reported separately while Personas remain ready", async () => {
  const f = fixture([service]);
  await f.run((remote, url) =>
    Effect.gen(function* () {
      const health = yield* healthResponse(url);
      expect(health.status).toBe(200);
      expect(health.headers.get("cache-control")).toBe("no-store");
      expect(yield* Effect.promise(() => health.json())).toEqual({
        service: "imsg",
        revision: "development",
        status: "ready",
        dependencies: { messages: "ready", notifications: "degraded" },
      });
      f.bridge.answer("send", { stage: "input", cause: { code: "sender_not_registered" } });
      const { guid } = yield* remote.notify(handle, "not registered");
      expect((yield* remote.notificationStatus(guid)).state).toBe("failed");
      const persona = yield* remote.sendText(handle, "still available");
      expect(yield* remote.sendStatus(persona.guid!)).toBe("sent");
    }),
  );
});

test("Notification outcomes survive restart without resubmission and receipts settle only their own ledger", async () => {
  const f = fixture();
  f.bridge.answer(
    "send",
    { status: "failed", code: "no_imessage" },
    { stage: "send", cause: { code: "unconfirmed" } },
    "exit",
  );
  const guids = await f.run((remote) =>
    Effect.gen(function* () {
      const failed = (yield* remote.notify(handle, "private failure")).guid;
      const uncertain = (yield* remote.notify(handle, "private uncertainty")).guid;
      const lost = (yield* remote.notify(handle, "private disconnect")).guid;
      expect(yield* remote.notificationStatus(failed)).toMatchObject({
        state: "failed",
        error: 22,
      });
      expect((yield* remote.notificationStatus(uncertain)).state).toBe("pending");
      expect((yield* remote.notificationStatus(lost)).state).toBe("pending");
      return { failed, uncertain, lost };
    }),
  );
  await f.run((remote, url) =>
    Effect.gen(function* () {
      const health = yield* healthResponse(url);
      expect(yield* Effect.promise(() => health.json())).toMatchObject({
        dependencies: { notifications: "ready" },
      });
      expect((yield* remote.notificationStatus(guids.failed)).state).toBe("failed");
      expect((yield* remote.notificationStatus(guids.uncertain)).state).toBe("pending");
      expect((yield* remote.notificationStatus(guids.lost)).state).toBe("pending");
      f.bridge.deliver({
        ...incoming(them, "", 200),
        participants: null,
        kind: "delivered",
        guid: guids.uncertain,
      });
      yield* Effect.promise(() =>
        vi.waitFor(async () =>
          expect((await Effect.runPromise(remote.notificationStatus(guids.uncertain))).state).toBe(
            "delivered",
          ),
        ),
      );
      f.bridge.deliver({
        ...incoming(them, "", 201),
        participants: null,
        kind: "read",
        guid: guids.uncertain,
      });
      yield* Effect.promise(() =>
        vi.waitFor(async () =>
          expect(
            (await Effect.runPromise(remote.notificationStatus(guids.uncertain))).dateRead,
          ).toBe(201),
        ),
      );
      expect(yield* remote.after(0)).toEqual([]);
      expect(yield* remote.lastOutgoingStatus(handle)).toBeUndefined();
      expect(yield* remote.textStatus(handle, 0)).toBe("unknown");
      expect(f.bridge.requests.filter((request) => request.method === "send")).toHaveLength(3);
    }),
  );
});

test("failed Notifications expose correlation and log the cause without private inputs", async () => {
  const f = fixture();
  const { logs, restore } = captureGatewayLogs();
  try {
    await f.run((remote) =>
      Effect.gen(function* () {
        f.bridge.answer("send", {
          stage: "send",
          cause: { code: "unconfirmed", detail: "private-upstream-payload" },
        });
        const result = yield* remote.notify(handle, "private-notification-text");
        expect(result.requestId).toMatch(/^[0-9a-f-]{36}$/);
        expect(f.bridge.requests.find((request) => request.method === "send")?.requestId).toBe(
          result.requestId,
        );
        expect((yield* remote.notificationStatus(result.guid)).state).toBe("pending");
        const matching = logs.filter((line) => line.includes(result.requestId));
        expect(matching.join("\n")).toContain("unconfirmed");
        expect(matching.join("\n")).toContain('"causeStage":"send"');
      }),
    );
    for (const sensitive of [
      handle,
      "secret",
      "private-notification-text",
      "private-upstream-payload",
    ])
      expect(logs.join("\n")).not.toContain(sensitive);
  } finally {
    restore();
  }
});
