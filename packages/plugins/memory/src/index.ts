import { Plugin } from "@opencode/plugin/effect";
import { Effect } from "effect";
import {
  configuredPlugin,
  getPersona,
  inPersonaLocation,
  type PersonaPluginOptions,
} from "@ren-ai/plugin-application";

export const memoryPlugin = (options: PersonaPluginOptions) =>
  Plugin.define({
    id: "ren-ai.memory",
    effect: (ctx) =>
      Effect.gen(function* () {
        if (!inPersonaLocation(ctx.location.directory, options.personaDirectory)) return;
        yield* ctx.session.hook("compaction", (event) =>
          Effect.gen(function* () {
            const persona = yield* getPersona(options, event.agent, ctx.location.directory);
            if (!persona) return;
            const { text: summary } = yield* ctx.session.generate({
              sessionID: event.sessionID,
              prompt: `${persona.memory}\nWrite her Memory in ${persona.language}, from her point of view. Use four parts: about him, the two of them, plans and promises, and lately. Preserve his name once learned, even through later summaries. Describe photos worth remembering. Update any previous Memory with what happened since; never discard lasting facts just because they are old. Return only the four-part Memory, not a conversation checkpoint wrapper. Do not call tools.`,
            });
            if (!summary.trim()) yield* Effect.fail(new Error());
            event.result = { summary };
          }).pipe(Effect.orDie),
        );
      }),
  });

export default configuredPlugin("ren-ai.memory", memoryPlugin);
