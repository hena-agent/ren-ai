import { ConfigProvider, Effect, Layer, Logger } from "effect";
import { TestClock } from "effect/testing";
import { HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { expect, test } from "vitest";
import { makeHealth } from "./health.ts";

const fixture = () => {
  const messages: string[] = [];
  const requests: string[] = [];
  const commands: string[] = [];
  const logs: string[] = [];
  let discordStatus = 204;
  let discordNetworkFails = false;
  let disk =
    "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk 100 50 50 50% /\n";
  let screen = '"IOConsoleUsers" = ({"CGSSessionScreenIsLocked"=No})';
  let processFails = false;
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      if (discordNetworkFails && url.pathname === "/discord") throw Error("Network unavailable");
      requests.push(url.toString());
      if (request.body instanceof HttpBody.Uint8Array) {
        messages.push(new TextDecoder().decode(request.body.body));
      }
      return HttpClientResponse.fromWeb(
        request,
        discordStatus === 0 ? Response.error() : new Response(null, { status: discordStatus }),
      );
    }),
  );
  const base = ChildProcessSpawner.make(() => Effect.die("Unexpected spawn"));
  const processes = ChildProcessSpawner.ChildProcessSpawner.of({
    ...base,
    string: (command) =>
      Effect.sync(() => {
        if (!ChildProcess.isStandardCommand(command)) throw Error("Unexpected piped command");
        commands.push([command.command, ...command.args].join(" "));
        if (processFails) throw Error("Process failed");
        return command.command === "/bin/df" ? disk : screen;
      }),
  });
  const dependencies = Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, client),
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, processes),
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        DISCORD_WEBHOOK_URL: "https://test/discord",
      }),
    ),
  );
  return {
    messages,
    requests,
    commands,
    logs,
    logger: Logger.make<ReadonlyArray<string>, void>(({ message }) => {
      logs.push(...message);
    }),
    dependencies,
    setDiscordStatus: (status: number) => {
      discordStatus = status;
    },
    setDiscordNetworkFails: (fails: boolean) => {
      discordNetworkFails = fails;
    },
    setDisk: (output: string) => {
      disk = output;
    },
    setScreen: (output: string) => {
      screen = output;
    },
    setProcessFails: (fails: boolean) => {
      processFails = fails;
    },
  };
};

test("alerts post once per problem and once when cleared, even when Discord fails", async () => {
  const f = fixture();
  await Effect.runPromise(
    Effect.gen(function* () {
      const health = yield* makeHealth;
      yield* health.raise("watch", "Watch stalled");
      yield* health.raise("watch", "Watch stalled");
      yield* health.clear("not-open");
      f.setDiscordNetworkFails(true);
      yield* health.raise("webhook-offline");
      f.setDiscordNetworkFails(false);
      yield* health.clear("webhook-offline");
      f.setDiscordStatus(500);
      yield* health.clear("watch");
      yield* health.clear("watch");
      f.setDiscordStatus(204);
      yield* health.raise("watch");
    }).pipe(Effect.withLogger(f.logger), Effect.provide(f.dependencies)),
  );
  expect(f.messages).toEqual([
    '{"content":"Alert: Watch stalled"}',
    '{"content":"Cleared: webhook-offline"}',
    '{"content":"Cleared: watch"}',
    '{"content":"Alert: watch"}',
  ]);
  expect(f.logs).toEqual(["Discord webhook failed", "Discord returned 500"]);
});

test("Discord accepts only successful HTTP statuses", async () => {
  const f = fixture();
  await Effect.runPromise(
    Effect.gen(function* () {
      const health = yield* makeHealth;
      for (const status of [0, 200, 300]) {
        f.setDiscordStatus(status);
        yield* health.raise(`status-${status}`);
      }
    }).pipe(Effect.withLogger(f.logger), Effect.provide(f.dependencies)),
  );
  expect(f.logs).toEqual(["Discord returned 0", "Discord returned 300"]);
});

test("Mac checks raise and clear on scheduled ticks without external requests", async () => {
  const f = fixture();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const health = yield* makeHealth;
        yield* Effect.forkScoped(health.monitor);
        yield* TestClock.adjust("1 millis");
        expect(f.requests).toEqual([]);
        f.setDisk(
          "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk 100 90 10 90% /\n",
        );
        f.setScreen('"IOConsoleUsers" = ({"CGSSessionScreenIsLocked"=Yes})');
        yield* TestClock.adjust("1 minute");
        expect(f.messages).toEqual([
          '{"content":"Alert: disk-nearly-full"}',
          '{"content":"Alert: screen-locked"}',
        ]);
        yield* TestClock.adjust("1 minute");
        expect(f.messages).toHaveLength(2);
        f.setDisk(
          "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk 100 40 60 40% /\n",
        );
        f.setScreen('"IOConsoleUsers" = ({"CGSSessionScreenIsLocked"=No})');
        yield* TestClock.adjust("1 minute");
        expect(f.messages.slice(2)).toEqual([
          '{"content":"Cleared: disk-nearly-full"}',
          '{"content":"Cleared: screen-locked"}',
        ]);
        expect(f.requests).toEqual(Array(4).fill("https://test/discord"));
        expect(f.commands.slice(0, 2)).toEqual(["/bin/df -Pk /", "/usr/sbin/ioreg -n Root -d1"]);
      }),
    ).pipe(
      Effect.withLogger(f.logger),
      Effect.provide(f.dependencies),
      Effect.provide(TestClock.layer()),
    ),
  );
});

test("failed Mac checks report their failure without stopping future ticks", async () => {
  const f = fixture();
  await Effect.runPromise(
    Effect.gen(function* () {
      const health = yield* makeHealth;
      f.setProcessFails(true);
      yield* health.tick;
      expect(f.messages).toHaveLength(2);
      f.setProcessFails(false);
      f.setDisk("invalid");
      yield* health.tick;
      expect(f.messages).toContain('{"content":"Cleared: screen-locked-check"}');
      expect(f.messages).toContain('{"content":"Cleared: disk-nearly-full-check"}');
      expect(f.messages.some((message) => message.includes("disk-nearly-full check failed"))).toBe(
        true,
      );
      yield* health.tick;
      expect(f.messages).toContain('{"content":"Alert: disk-nearly-full"}');
    }).pipe(Effect.withLogger(f.logger), Effect.provide(f.dependencies)),
  );
});
