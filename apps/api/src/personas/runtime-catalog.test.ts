import { Effect } from "effect";
import { expect, test, vi } from "vitest";
import { parsePersona } from "@ren-ai/personas";
import { withPublicProfile } from "@ren-ai/personas/profile";
import { withContactDatabase } from "../discovery/contact.test-helper.ts";
import { cachedCatalog } from "./cached-catalog.ts";
import { decodeRuntimePersona } from "./runtime-catalog.ts";
import { migrate } from "../database.ts";

const markdown = vi.hoisted(() => ({ parses: 0 }));
vi.mock("mdast-util-from-markdown", async (original) => {
  const actual = await original<typeof import("mdast-util-from-markdown")>();
  return {
    ...actual,
    fromMarkdown: (...input: Parameters<typeof actual.fromMarkdown>) => {
      markdown.parses++;
      return actual.fromMarkdown(...input);
    },
  };
});

test("a replacement actor loads its persisted Catalog without parsing any Persona Markdown", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      yield* migrate;
      const personas = new Map(
        Array.from({ length: 3 }, (_, index) => {
          const persona = parsePersona(
            `persona${index}`,
            `---\nname: 페르소나${index}\ntime-zone: Asia/Seoul\nlanguage: ko\nopening-line: Hello\nmemory: Remember\n---\n${withPublicProfile(`Private description ${index}`, `소개 ${index}`)}`,
          );
          return [persona.id, persona] as const;
        }),
      );
      const load = async () => ({ revision: "stored", personas });
      yield* (yield* cachedCatalog(load, "rules")).fresh;
      markdown.parses = 0;
      const replacement = yield* cachedCatalog(load, "rules");
      expect((yield* replacement.current).personas).toEqual(personas);
      expect(markdown.parses).toBe(0);
    }),
  );
});

test("private sheet associations survive a persisted Catalog reload and reject foreign references", async () => {
  expect(() => decodeRuntimePersona({ sheets: { anime: "https://other.test/image.png" } })).toThrow(
    /RegExp/,
  );
  await withContactDatabase(
    Effect.gen(function* () {
      yield* migrate;
      const persona = {
        ...parsePersona(
          "harin",
          "---\nname: 하린\ntime-zone: Asia/Seoul\nlanguage: ko\nopening-line: Hello\nmemory: Remember\n---\nPrivate description",
        ),
        sheets: { photo: "00000000-0000-0000-0000-000000000000.jpg" },
      };
      const load = async () => ({ revision: "sheets", personas: new Map([[persona.id, persona]]) });
      const { sheets: _sheets, ...document } = persona;
      expect(decodeRuntimePersona(document)).toEqual(document);
      const first = yield* cachedCatalog(load, "rules");
      yield* first.fresh;
      const restored = yield* cachedCatalog(load, "rules");
      expect((yield* restored.current).personas.get(persona.id)).toEqual(persona);
      expect((yield* restored.fresh).personas.get(persona.id)).toEqual(persona);
    }),
  );
});
