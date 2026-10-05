import type { Effect } from "effect";
import type { Persona, Tapback, OutgoingStatus } from "./protocol.ts";

interface PluginConfig {
  readonly personaDirectory: string;
  readonly personas: ReadonlyMap<string, Persona>;
  readonly handleForSession: (sessionID: string) => Effect.Effect<string | undefined, Error>;
  readonly read?: (sessionID: string) => Effect.Effect<string, Error>;
  readonly react?: (
    sessionID: string,
    tapback: Tapback,
    callID: string,
  ) => Effect.Effect<string, Error>;
  readonly onContext?: (sessionID: string) => Effect.Effect<void, Error>;
  readonly lastMessageStatus?: (
    sessionID: string,
  ) => Effect.Effect<OutgoingStatus | undefined, Error>;
  readonly health: {
    readonly raise: (name: string, detail: string) => Effect.Effect<void>;
  };
  readonly settledSends?: (sessionID: string) => Effect.Effect<
    ReadonlyArray<{
      readonly toolCallID: string | null;
      readonly state: string;
      readonly updatedAt: number;
    }>,
    Error
  >;
}

type HostTools =
  | {
      readonly send: (
        sessionID: string,
        text: string,
        callID: string,
      ) => Effect.Effect<string, Error>;
      readonly wait: (sessionID: string, seconds: number) => Effect.Effect<string, Error>;
    }
  | { readonly send?: undefined; readonly wait?: undefined };

export type PersonaPluginOptions = PluginConfig & HostTools;
