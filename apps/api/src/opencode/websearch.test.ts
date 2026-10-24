import { TestLLM } from "@opencode/ai/testing";
import { Plugin } from "@opencode/plugin/effect";
import { personaPermissions } from "@ren-ai/plugin-session-folder/files";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { folderSession, withSessionFolders } from "../../test/session-folder.test-helper.ts";

test("personas execute native websearch with random selection and refresh persisted permissions", () =>
  withSessionFolders((host) =>
    Effect.gen(function* () {
      const queries: Array<{ provider: string; query: string }> = [];
      const providers = new Set<string>();
      yield* Effect.promise(() =>
        host.native.run(
          host.native.plugins.register(
            Plugin.define({
              id: "test.search-results",
              effect: (ctx) =>
                Effect.gen(function* () {
                  const available = yield* ctx.websearch.providers();
                  yield* ctx.websearch.transform((editor) => {
                    for (const provider of available.data) {
                      providers.add(provider.id);
                      editor.add({
                        id: provider.id,
                        name: provider.name,
                        execute: ({ query }) =>
                          Effect.sync(() => {
                            queries.push({ provider: provider.id, query });
                            return [
                              {
                                url: "https://example.com/news",
                                content: "Today's news",
                                time: {},
                              },
                            ];
                          }),
                      });
                    }
                  });
                }).pipe(Effect.orDie),
            }),
          ),
        ),
      );
      const { session } = yield* folderSession(host);
      yield* host.remote.client.session.update({
        sessionID: session.id,
        permissions: personaPermissions.filter((rule) => rule.action !== "websearch"),
      });
      yield* host.rpc.ensure({ folderID: session.id }, host.location);
      let step = 0;
      yield* host.llm.serve((request) => {
        if (!request.tools.some((tool) => tool.name === "websearch"))
          return TestLLM.text("News", "title");
        return ++step === 1
          ? TestLLM.tool("search", "websearch", { query: "today's news" })
          : TestLLM.text("Found the news", "answer");
      });
      yield* host.remote.sessions.prompt({ sessionID: session.id, text: "Check today's news" });
      yield* host.remote.sessions.wait(session.id).pipe(Effect.timeout("10 seconds"));
      expect(queries).toHaveLength(1);
      expect(queries[0]!.query).toBe("today's news");
      expect(providers.has(queries[0]!.provider)).toBe(true);
      const requests = (yield* host.llm.requests()).filter((request) => request.tools.length > 0);
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[1]!.messages)).toContain("Today's news");
      const tools = requests[0]!.tools.map((tool) => tool.name);
      expect(tools).toContain("websearch");
      for (const name of ["shell", "grep", "glob", "webfetch", "execute"])
        expect(tools).not.toContain(name);
      const current = yield* host.remote.sessions.get(session.id);
      expect(current.permissions).toEqual(personaPermissions);
      expect(current.outcome).toBe("succeeded");
      const config = yield* host.remote.client.config.get({ location: session.location });
      expect(
        config.flatMap((entry) => (entry.type === "document" ? [entry.info.websearch] : [])),
      ).toContainEqual({ provider: "random" });
      yield* host.rpc.ensure({ folderID: session.id }, host.location);
      expect((yield* host.remote.sessions.get(session.id)).permissions).toEqual(personaPermissions);
    }),
  ));
