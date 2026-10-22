import { Effect, Fiber, Layer, type Scope } from "effect";
import { afterEach, expect, test, vi } from "vitest";
import {
  fakeGestures,
  fakeMessages,
  fakeNotifications,
  messageGateway,
} from "@ren-ai/imsg/testing";
import { runApplicationWatch } from "./watch.ts";
import { TestClock } from "effect/testing";
import { FetchHttpClient } from "effect/unstable/http";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const watchServices = Layer.merge(
  TestClock.layer(),
  Layer.succeed(FetchHttpClient.Fetch, (input, init) => fetch(input, init)),
);
const captureFailures = () => {
  const logs: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    logs.push(String(chunk));
    return true;
  });
  return logs;
};
const editFixture = async () => {
  const fake = fakeMessages();
  const row = await Effect.runPromise(fake.text("private-handle", "private-text", 0));
  const gateway = messageGateway(
    fake.messages,
    "imsg-secret",
    fakeGestures().gestures,
    fakeNotifications(),
  );
  return { fake, row, gateway, requests: Array.of<string>(), logs: captureFailures() };
};
const startWatch = () =>
  runApplicationWatch("https://app", "secret", "https://imsg/rpc", "imsg-secret").pipe(
    Effect.forkScoped,
  );
const runWatchTest = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(watchServices))));

const awaitRequests = (requests: readonly string[], expected: number) =>
  Effect.gen(function* () {
    for (let attempt = 0; requests.length < expected && attempt < 100; attempt++) {
      yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
      yield* TestClock.adjust("250 millis");
    }
    expect(requests).toHaveLength(expected);
  });

test("the Mac resumes from Cloudflare's bookmark and wakes only on new messages", async () => {
  const fake = fakeMessages();
  const gateway = messageGateway(
    fake.messages,
    "imsg-secret",
    fakeGestures().gestures,
    fakeNotifications(),
  );
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).hostname === "imsg") return gateway.handler(request);
    expect(request.headers.get("authorization")).toBe("Bearer secret");
    requests.push(`${request.method} ${request.url}`);
    return request.method === "POST"
      ? new Response(null, { status: 202 })
      : Response.json({ rowID: 0, watched: [] });
  });
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const watch = yield* runApplicationWatch(
            "https://app",
            "secret",
            "https://imsg/rpc",
            "imsg-secret",
          ).pipe(Effect.forkScoped);
          yield* Effect.promise(async () => {
            await expect.poll(() => requests.length).toBe(1);
          });
          yield* fake.text("+821012345678", "hello", Date.now());
          yield* fake.outgoing("+821012345678", "reply", Date.now());
          yield* Effect.promise(async () => {
            await expect.poll(() => requests.length).toBe(2);
          });
          expect(requests).toEqual([
            "GET https://app/management/intake/watch",
            "POST https://app/management/intake/wake",
          ]);
          yield* Fiber.interrupt(watch);
        }),
      ),
    );
  } finally {
    await gateway.dispose();
  }
});

test("restored edit observations coalesce, retry failed hints, and expire without idle Worker polling", async () => {
  const { fake, row, gateway, requests, logs } = await editFixture();
  let failed = true;
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).hostname === "imsg") return gateway.handler(request);
    requests.push(request.method);
    if (request.method === "GET") return Response.json({ rowID: row.id, watched: [row] });
    if (failed) return new Response("private-upstream", { status: 503 });
    return new Response(null, { status: 202 });
  });
  const count = (expected: number) => awaitRequests(requests, expected);
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* runApplicationWatch(
            "https://app/",
            "secret",
            "https://imsg/rpc",
            "imsg-secret",
          ).pipe(Effect.forkScoped);
          yield* count(1);
          yield* fake.edit(row.guid, "private-edit");
          yield* TestClock.adjust("10 seconds");
          yield* TestClock.adjust("250 millis");
          yield* count(2);
          expect(logs.join("")).toContain('"upstreamStatus":503');
          expect(logs.join("")).toContain('"stage":"wake.delivery"');
          expect(logs.join("")).not.toMatch(/private-|secret/);
          failed = false;
          yield* TestClock.adjust("1 second");
          yield* count(3);
          yield* fake.unsend(row.guid);
          yield* TestClock.adjust("10 seconds");
          yield* TestClock.adjust("250 millis");
          yield* count(4);
          yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
          yield* TestClock.adjust("16 minutes");
          yield* fake.edit(row.guid, "an expired edit");
          yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
          yield* TestClock.adjust("10 seconds");
          expect(requests).toEqual(["GET", "POST", "POST", "POST"]);
        }).pipe(Effect.provide(watchServices)),
      ),
    );
  } finally {
    await gateway.dispose();
  }
});

test("an unavailable or malformed watch snapshot reconnects before resuming message observation", async () => {
  const fake = fakeMessages();
  const gateway = messageGateway(
    fake.messages,
    "imsg-secret",
    fakeGestures().gestures,
    fakeNotifications(),
  );
  const requests: string[] = [];
  const logs = captureFailures();
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).hostname === "imsg") return gateway.handler(request);
    requests.push(request.method);
    if (requests.length === 1) return new Response(null, { status: 503 });
    if (requests.length === 2) return Response.json({ private: "private-snapshot" });
    return request.method === "POST"
      ? new Response("accepted", { status: 202 })
      : Response.json({ rowID: 0, watched: [] });
  });
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* runApplicationWatch(
            "https://app",
            "secret",
            "https://imsg/rpc",
            "imsg-secret",
          ).pipe(Effect.forkScoped);
          yield* awaitRequests(requests, 3);
          yield* fake.text("private-handle", "private-message", 0);
          yield* awaitRequests(requests, 4);
          expect(requests).toEqual(["GET", "GET", "GET", "POST"]);
          expect(logs).toHaveLength(2);
          expect(logs.join("")).toContain('"stage":"watch.reconnect"');
          expect(logs.join("")).toContain('"upstreamStatus":503');
          expect(logs.join("")).not.toMatch(/private-|secret/);
        }).pipe(Effect.provide(watchServices)),
      ),
    );
  } finally {
    await gateway.dispose();
  }
});

test("a healthy watch resets reconnect backoff before a later edit-probe failure", async () => {
  const { fake, row, gateway, requests, logs } = await editFixture();
  let failProbe = false;
  const recent = fake.messages.recent.bind(fake.messages);
  fake.messages.recent = (...args) =>
    failProbe ? Effect.fail(new Error("private outage")) : recent(...args);
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).hostname === "imsg") return gateway.handler(request);
    requests.push(request.method);
    return requests.length <= 2
      ? new Response(null, { status: 503 })
      : Response.json({ rowID: row.id, watched: [row] });
  });
  try {
    await runWatchTest(
      Effect.gen(function* () {
        yield* startWatch();
        yield* awaitRequests(requests, 3);
        failProbe = true;
        yield* TestClock.adjust("10 seconds");
        yield* Effect.promise(async () => {
          await expect.poll(() => logs.length).toBe(3);
        });
        expect(logs[2]).toContain('"attempt":0');
        yield* TestClock.adjust("2 seconds");
        yield* awaitRequests(requests, 4);
        expect(logs.join("")).not.toMatch(/private-|secret/);
      }),
    );
  } finally {
    await gateway.dispose();
  }
});
