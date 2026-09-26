import { Cause, Config, Effect, Ref } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const interval = "1 minute";

export const makeHealth = Effect.gen(function* () {
  const webhook = yield* Config.string("DISCORD_WEBHOOK_URL");
  const heartbeat = yield* Config.string("HEARTBEAT_URL");
  const client = yield* HttpClient.HttpClient;
  const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
  const open = yield* Ref.make(new Set<string>());

  const notify = (content: string) =>
    HttpClientRequest.post(webhook).pipe(
      HttpClientRequest.bodyJsonUnsafe({ content }),
      client.execute,
      Effect.flatMap((response) =>
        response.status >= 200 && response.status < 300
          ? Effect.void
          : Effect.logWarning(`Discord returned ${response.status}`),
      ),
      Effect.catchCause(() => Effect.logWarning("Discord webhook failed")),
    );

  const raise = (name: string, detail = name) =>
    Ref.modify(open, (current) => {
      if (current.has(name)) return [false, current] as const;
      return [true, new Set(current).add(name)] as const;
    }).pipe(Effect.flatMap((first) => (first ? notify(`Alert: ${detail}`) : Effect.void)));

  const clear = (name: string) =>
    Ref.modify(open, (current) => {
      if (!current.has(name)) return [false, current] as const;
      const next = new Set(current);
      next.delete(name);
      return [true, next] as const;
    }).pipe(Effect.flatMap((wasOpen) => (wasOpen ? notify(`Cleared: ${name}`) : Effect.void)));

  const check = (
    name: string,
    command: ChildProcess.Command,
    isProblem: (output: string) => boolean,
  ) =>
    processes.string(command).pipe(
      Effect.flatMap((output) => (isProblem(output) ? raise(name) : clear(name))),
      Effect.andThen(clear(`${name}-check`)),
      Effect.catchCause((cause) =>
        raise(`${name}-check`, `${name} check failed: ${Cause.pretty(cause)}`),
      ),
    );

  const tick = Effect.gen(function* () {
    yield* client.get(heartbeat).pipe(
      Effect.flatMap((response) =>
        response.status >= 200 && response.status < 300
          ? clear("heartbeat")
          : raise("heartbeat", `Heartbeat returned ${response.status}`),
      ),
      Effect.catchCause(() => raise("heartbeat", "Heartbeat ping failed")),
    );
    yield* check("disk-nearly-full", ChildProcess.make("/bin/df", ["-Pk", "/"]), (output) => {
      const usage = /\s(\d+)%\s/.exec(output);
      return usage === null || Number(usage[1]) >= 90;
    });
    yield* check(
      "screen-locked",
      ChildProcess.make("/usr/sbin/ioreg", ["-n", "Root", "-d1"]),
      (output) => output.includes('"CGSSessionScreenIsLocked"=Yes'),
    );
  });

  const monitor = Effect.forever(tick.pipe(Effect.andThen(Effect.sleep(interval))));
  return { raise, clear, tick, monitor };
});
