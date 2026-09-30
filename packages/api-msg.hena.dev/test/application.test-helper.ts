import { Effect, Layer } from "effect";
import { loadPersonas } from "../src/personas/personas.ts";
import { isolatedHost } from "./isolated-host.test-helper.ts";
import type { HostOptions, PersonaHostOptions } from "./embedded-host.test-helper.ts";
import { startMessagingApplication, type OnboardingConfig } from "../src/application.ts";
import type { Messages } from "../src/messages/messages.ts";
import type { Gestures } from "../src/gestures/gestures.ts";
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
  onboarding: OnboardingConfig,
  alerts: FailureAlerts,
) =>
  Effect.flatMap(loadPersonas(options.personaDirectory), (personas) =>
    startMessagingApplication(
      personas,
      (tools) => isolatedHost(root, { ...options, ...tools }),
      messages,
      gestures,
      onboarding,
      alerts,
    ),
  );

export const startMessagingServer = (
  root: string,
  options: MessagingOptions,
  databaseFile: string,
  messages: Messages,
  gestures: Gestures,
  onboarding: OnboardingConfig,
  alerts: FailureAlerts,
) =>
  Effect.gen(function* () {
    const { SqliteClient } = yield* Effect.promise(() => import("@effect/sql-sqlite-bun"));
    const database = yield* Layer.build(
      SqliteClient.layer({ filename: databaseFile, busyTimeout: "5 seconds" }),
    );
    return yield* startMessagingHost(root, options, messages, gestures, onboarding, alerts).pipe(
      Effect.provide(database),
    );
  });
