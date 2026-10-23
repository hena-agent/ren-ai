import type { OutgoingStatus, Tapback } from "@ren-ai/imsg/protocol";
import type { Effect } from "effect";
import type { MessageBubble, Persona } from "./protocol.ts";
import type { StartingRelationship } from "@ren-ai/onboarding";

interface PluginConfig {
  readonly personaDirectory: string;
  readonly personas: ReadonlyMap<string, Persona>;
  readonly handleForSession: (sessionID: string) => Effect.Effect<string | undefined, Error>;
  readonly read?: (sessionID: string) => Effect.Effect<string, Error>;
  readonly endConversation?: (
    sessionID: string,
    farewell: string,
    callID: string,
  ) => Effect.Effect<string, Error>;
  readonly react?: (
    sessionID: string,
    tapback: Tapback,
    callID: string,
  ) => Effect.Effect<string, Error>;
  readonly context?: (
    sessionID: string,
    messageIDs: readonly string[],
  ) => Effect.Effect<
    {
      readonly startingRelationship?: StartingRelationship;
      readonly status: OutgoingStatus | undefined;
      readonly sends: ReadonlyArray<{
        readonly toolCallID: string | null;
        readonly state: string;
        readonly updatedAt: number;
      }>;
    },
    Error
  >;
  readonly health: {
    readonly raise: (name: string, detail: string) => Effect.Effect<void>;
  };
}

type HostTools =
  | {
      readonly send: (
        sessionID: string,
        messages: readonly MessageBubble[],
        callID: string,
      ) => Effect.Effect<string, Error>;
      readonly wait: (sessionID: string, seconds: number) => Effect.Effect<string, Error>;
    }
  | { readonly send?: undefined; readonly wait?: undefined };

export type PersonaPluginOptions = PluginConfig & HostTools;
