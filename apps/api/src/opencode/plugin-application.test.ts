import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, test } from "vitest";
import {
  getPersona,
  inPersonaLocation,
  readPersona,
  isMessagingTool,
  messagingToolDefinitions,
} from "@ren-ai/plugin-application";
import { messagingFixture } from "../../test/messaging.test-helper.ts";

test("plugin scope includes only the root and direct session folders", () => {
  for (const path of ["/srv/ren-ai", "/srv/ren-ai/", "/srv/ren-ai/sessions/ses_123"]) {
    expect(inPersonaLocation(path, "/srv/ren-ai")).toBe(true);
  }
  for (const path of [
    "/srv/ren-ai-sibling",
    "/srv/ren-ai/sessions",
    "/srv/ren-ai/sessions/../..",
    "/srv/ren-ai/sessions/ses_123/nested",
    "/srv/ren-ai/other/ses_123",
    "/srv/ren-ai/sessions/.hidden",
    "/srv/ren-ai/sessions\\ses_not_a_descendant",
  ]) {
    expect(inPersonaLocation(path, "/srv/ren-ai")).toBe(false);
  }
});

test("messaging tool identity requires its complete registered description and input schema", () => {
  const read = messagingToolDefinitions.read;
  const input = read.input["~standard"].jsonSchema.input({ target: "draft-2020-12" });
  expect(isMessagingTool("read", undefined)).toBe(false);
  expect(isMessagingTool("read", { description: "Read a file", input })).toBe(false);
  expect(
    isMessagingTool("read", {
      description: read.description,
      input: { type: "object", properties: { filePath: { type: "string" } } },
    }),
  ).toBe(false);
  expect(isMessagingTool("read", { description: read.description, input })).toBe(true);
});

test("wait accepts only positive seconds up to 3300 at the tool boundary", async () => {
  const schema = messagingToolDefinitions.wait.input["~standard"];
  for (const seconds of [0.001, 5, 3300]) {
    expect(await schema.validate({ seconds })).toEqual({ value: { seconds } });
  }
  for (const seconds of [0, -1, 3300.001, 3600, NaN, Infinity, "5"]) {
    expect((await schema.validate({ seconds })).issues).toBeDefined();
  }
  for (const input of [{}, { minutes: 1 }]) {
    expect((await schema.validate(input)).issues).toBeDefined();
  }
});

test("snapshot reads refresh runtime metadata and reject malformed files at the boundary", async () => {
  const { root, personaDirectory } = await messagingFixture("snapshot-metadata-");
  const folder = join(personaDirectory, "sessions", "ses_snapshot");
  await mkdir(folder, { recursive: true });
  const persona = {
    id: "persona1",
    timeZone: "Asia/Seoul",
    language: "ko",
    openingLine: "hi",
    memory: "remember",
    prompt: "native prompt",
  };
  try {
    await writeFile(join(folder, "persona.json"), JSON.stringify({ ...persona, published: false }));
    expect(await Effect.runPromise(readPersona(folder))).toEqual(persona);
    await writeFile(
      join(folder, "persona.json"),
      JSON.stringify({ ...persona, timeZone: "Pacific/Honolulu" }),
    );
    expect((await Effect.runPromise(readPersona(folder))).timeZone).toBe("Pacific/Honolulu");
    const options = {
      personaDirectory,
      personas: new Map([[persona.id, persona]]),
      handleForSession: () => Effect.succeed(undefined),
      health: { raise: () => Effect.void },
    };
    expect(await Effect.runPromise(getPersona(options, persona.id, folder))).toEqual(persona);
    expect(
      (await Effect.runPromise(getPersona({ ...options, personas: new Map() }, persona.id, folder)))
        ?.timeZone,
    ).toBe("Pacific/Honolulu");
    await expect(Effect.runPromise(getPersona(options, "other", folder))).rejects.toThrow(
      /binding mismatch/,
    );
    await writeFile(join(folder, "persona.json"), '{"id":"persona1"}');
    await expect(Effect.runPromise(readPersona(folder))).rejects.toThrow(/Missing/);
    await writeFile(join(folder, "persona.json"), "not json");
    await expect(Effect.runPromise(readPersona(folder))).rejects.toThrow(/JSON|Unexpected/);
    await expect(Effect.runPromise(readPersona(join(root, "missing")))).rejects.toThrow(/ENOENT/);
    expect(await Effect.runPromise(getPersona(options, persona.id))).toEqual(persona);
    expect(await Effect.runPromise(getPersona(options, "missing"))).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
