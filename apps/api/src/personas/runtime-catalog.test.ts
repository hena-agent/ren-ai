import { Effect } from "effect";
import { expect, test } from "vitest";
import { parsePersona } from "@ren-ai/personas";
import { withContactDatabase } from "../discovery/contact.test-helper.ts";
import { cachedCatalog } from "./cached-catalog.ts";
import { decodeRuntimePersona } from "./runtime-catalog.ts";
import { migrate } from "../database.ts";

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
