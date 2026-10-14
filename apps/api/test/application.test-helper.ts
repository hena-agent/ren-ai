import { Clock, Effect, Layer } from "effect";
import { loadPersonas } from "@ren-ai/personas";
import { isolatedHost } from "./isolated-host.test-helper.ts";
import type { HostOptions, PersonaHostOptions } from "./embedded-host.test-helper.ts";
import { startMessagingApplication } from "../src/application.ts";
import type { Messages, Gestures } from "@ren-ai/imsg";
import type { FailureAlerts } from "../src/opencode/failed-turns.ts";

type MessagingOptions = Omit<
  HostOptions,
  "personas" | "send" | "wait" | "read" | "react" | "onContext" | "handleForSession"
>;

export const startPersonaHost = (root: string, options: PersonaHostOptions) =>
  Effect.flatMap(loadPersonas(options.personaDirectory), (personas) =>
    isolatedHost(root, { ...options, personas }),
  );

export const startMessagingHost = (
  root: string,
  options: MessagingOptions,
  messages: Messages,
  gestures: Gestures,
  alerts: FailureAlerts,
) =>
  Effect.flatMap(loadPersonas(options.personaDirectory), (personas) =>
    startMessagingApplication(
      personas,
      (tools) => isolatedHost(root, { ...options, ...tools }),
      messages,
      gestures,
      alerts,
    ).pipe(
      Effect.tap((host) =>
        Effect.gen(function* () {
          const stop = yield* messages.follow(0, () =>
            Effect.all([host.heartbeat.intake, host.heartbeat.followUps]),
          );
          yield* Effect.addFinalizer(() => Effect.sync(stop));
          yield* Effect.forkScoped(
            Effect.forever(
              Effect.sleep("1 second").pipe(
                Effect.andThen(Effect.all([host.heartbeat.intake, host.heartbeat.followUps])),
                Effect.catchCause(Effect.logError),
              ),
            ),
          );
          // Real cadence for the fixture; fake-clock scheduler tests invoke
          // individual beats explicitly rather than replaying every missed beat.
          const clock = Effect.runSync(Clock.Clock);
          yield* Effect.forever(
            Effect.sleep("1 second").pipe(
              Effect.provideService(Clock.Clock, clock),
              Effect.andThen(host.heartbeat.failedTurns),
              Effect.catchCause(Effect.logError),
            ),
          ).pipe(Effect.forkScoped);
        }),
      ),
    ),
  );

export const startMessagingServer = (
  root: string,
  options: MessagingOptions,
  databaseFile: string,
  messages: Messages,
  gestures: Gestures,
  alerts: FailureAlerts,
) =>
  Effect.gen(function* () {
    const { SqliteClient } = yield* Effect.promise(() => import("@effect/sql-sqlite-bun"));
    const database = yield* Layer.build(
      SqliteClient.layer({ filename: databaseFile, busyTimeout: "5 seconds" }),
    );
    return yield* startMessagingHost(root, options, messages, gestures, alerts).pipe(
      Effect.provide(database),
    );
  });
