import type { OpenCode } from "@opencode/client/effect";
import { Effect, Schedule } from "effect";
import type { Persona } from "@ren-ai/personas";

type AgentClient = Pick<Effect.Success<ReturnType<typeof OpenCode.make>>["agent"], "list">;

/** Publishing files is not an acknowledgement that OpenCode has reloaded its agent cache. */
export const awaitPersonaAgent = (
  agent: AgentClient,
  directory: string,
  persona: Pick<Persona, "id" | "prompt">,
) =>
  agent.list({ location: { directory } }).pipe(
    Effect.repeat({
      while: (page) =>
        page.data.find((entry) => entry.id === persona.id)?.system?.trim() !==
        persona.prompt.trim(),
      schedule: Schedule.spaced("25 millis"),
    }),
    Effect.timeout("5 seconds"),
    Effect.asVoid,
  );
