import { expect, test, vi } from "vitest";
import {
  fixture,
  generator,
  character,
  legacy,
  request,
  newToken,
  tokenOf,
} from "../test/fixtures.ts";
import { createProfileGenerator } from "./generation.ts";
import copy from "./copy.json";

test("a brief idea creates an editable private character draft without saving or publishing it", async () => {
  const drafting = vi.fn<typeof generator.character>().mockResolvedValue(character);
  const { admin, store } = await fixture({ ...generator, character: drafting });
  const response = await admin(
    request("/personas", {
      draft: await newToken(admin),
      seed: "  차분한 도예가, 친해지면 장난기가 많은 사람  ",
      intent: "character",
    }),
  );
  expect(response.status).toBe(200);
  const page = await response.text();
  expect(page).toContain(`value="${character.name}"`);
  expect(page).toContain("독립적인 성격의 도예가");
  expect(page).toContain("차분한 도예가, 친해지면 장난기가 많은 사람");
  expect(page).not.toContain('class="notice success"');
  expect(drafting).toHaveBeenCalledWith("차분한 도예가, 친해지면 장난기가 많은 사람", "female");
  expect(await store.list()).toEqual([]);
  const saved = await admin(request("/personas", { ...character, draft: tokenOf(page) }));
  expect(saved.status).toBe(303);
  const record = (await store.list())[0]!;
  expect(record.description).toBe(character.description);
  expect(record.bio).toBe("");
  expect(record.imageUrl).toBe("");
  expect(record.portraits).toBeUndefined();
  expect(record.published).toBe(false);
});

test("a draft generation failure preserves the brief idea and the existing character and can be retried", async () => {
  const drafting = vi
    .fn<typeof generator.character>()
    .mockRejectedValueOnce(new Error("provider outage"))
    .mockResolvedValue(character);
  const { admin, store } = await fixture({ ...generator, character: drafting });
  await store.create({ ...legacy, published: true });
  const initial = await (await admin(request("/personas/legacy"))).text();
  const response = await admin(
    request("/personas/legacy", {
      seed: "공방을 운영하는 도예가",
      draft: tokenOf(initial),
      intent: "character",
    }),
  );
  expect(response.status).toBe(503);
  const page = await response.text();
  expect(page).toContain(copy.failure);
  expect(page).toContain("공방을 운영하는 도예가");
  expect(page).toContain(legacy.prompt);
  const retried = await admin(
    request("/personas/legacy", {
      seed: "공방을 운영하는 도예가",
      draft: tokenOf(page),
      intent: "character",
    }),
  );
  expect(retried.status).toBe(200);
  expect(await retried.text()).toContain(character.name);
  expect(await store.get("legacy")).toEqual({ ...legacy, published: true });
  for (const seed of ["", " "])
    expect(
      (
        await admin(
          request("/personas/legacy", { seed, draft: tokenOf(initial), intent: "character" }),
        )
      ).status,
    ).toBe(400);
  const invalidSeed = new FormData();
  invalidSeed.set("draft", tokenOf(initial));
  invalidSeed.set("intent", "character");
  invalidSeed.set("seed", new File(["bad"], "seed.txt"));
  expect(
    (
      await admin(
        new Request("http://localhost:3729/personas/legacy", {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from("admin:test-password").toString("base64")}`,
            Origin: "http://localhost:3729",
          },
          body: invalidSeed,
        }),
      )
    ).status,
  ).toBe(400);
});

test("the AI draft adapter requests structured character JSON and validates it before returning a definition", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      candidates: [{ content: { parts: [{ text: JSON.stringify(character) }] } }],
    }),
  );
  const model = createProfileGenerator({ key: "key", fetcher });
  expect(await model.character("차분한 도예가")).toEqual(character);
  const outgoing = new Request(...fetcher.mock.calls[0]!);
  const body = await outgoing.text();
  expect(body).toContain("차분한 도예가");
  expect(JSON.parse(body)).toMatchObject({
    generationConfig: { responseMimeType: "application/json", maxOutputTokens: 4096 },
  });
  for (const text of [
    "invalid JSON",
    "{}",
    '{"name":" ","description":"설명"}',
    '{"name":"이름","description":" "}',
  ]) {
    fetcher.mockResolvedValueOnce(
      Response.json({ candidates: [{ content: { parts: [{ text }] } }] }),
    );
    await expect(model.character("아이디어")).rejects.toThrow("Invalid character draft");
  }
});
