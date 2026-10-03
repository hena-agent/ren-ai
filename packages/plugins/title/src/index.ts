import { Plugin } from "@opencode/plugin/effect";
import { Effect } from "effect";
import {
  configuredPlugin,
  getPersona,
  inPersonaLocation,
  type PersonaPluginOptions,
} from "@ren-ai/plugin-application";

export const titlePlugin = (options: PersonaPluginOptions) =>
  Plugin.define({
    id: "ren-ai.title",
    effect: (ctx) =>
      Effect.gen(function* () {
        if (!inPersonaLocation(ctx.location.directory, options.personaDirectory)) return;
        yield* ctx.session.hook("title", (event) =>
          Effect.gen(function* () {
            const handle = yield* options.handleForSession(event.sessionID);
            if (!handle) return;
            const session = yield* ctx.session.get({
              sessionID: event.sessionID,
            });
            const persona = yield* getPersona(options, session.agent!, ctx.location.directory);
            const id = persona?.id ?? session.agent!;
            event.result = `${id[0]!.toUpperCase()}${id.slice(1)} · ${handle}`;
          }).pipe(Effect.orDie),
        );
      }),
  });

export default configuredPlugin("ren-ai.title", titlePlugin);
