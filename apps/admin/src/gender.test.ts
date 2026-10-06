import { expect, test, vi } from "vitest";
import { parsePersona, serializePersona, decodePersona } from "@ren-ai/personas";
import { createProfileGenerator } from "./generation.ts";
import {
  character,
  femaleCharacter,
  fixture,
  generator,
  legacy,
  portraitReply,
  portraitImage,
  request,
  tokenOf,
} from "../test/fixtures.ts";
import { preview, modelReply, photoPortrait } from "../test/sub-portraits.ts";
import policy from "./policy.json";
import { useBrowser } from "../test/browser.ts";
import { bindPending } from "./pending.ts";

useBrowser();

test("new personas default to female and the native disabled male option cannot be bypassed through an API form", async () => {
  const drafting = vi.fn<typeof generator.character>().mockImplementation(generator.character);
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(generator.portrait);
  const { admin, store } = await fixture({ ...generator, character: drafting, portrait });
  const page = await (await admin(request("/new"))).text();
  document.body.innerHTML = page;
  const select = document.querySelector<HTMLSelectElement>("#gender")!;
  expect(select.value).toBe("female");
  expect(select.querySelector<HTMLOptionElement>('[value="male"]')?.disabled).toBe(true);
  for (const gender of ["male", "other"]) {
    expect(
      (
        await admin(
          request("/personas", { ...character, draft: tokenOf(page), intent: "generate", gender }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await admin(
          request("/personas", { seed: "idea", draft: tokenOf(page), intent: "character", gender }),
        )
      ).status,
    ).toBe(400);
  }
  expect(drafting).not.toHaveBeenCalled();
  expect(portrait).not.toHaveBeenCalled();
  const generated = await (
    await admin(
      request("/personas", {
        ...character,
        draft: tokenOf(page),
        intent: "generate",
        gender: "female",
      }),
    )
  ).text();
  expect(preview(generated).gender).toBe("female");
  expect(portrait).toHaveBeenCalledWith(femaleCharacter, "anime");
  const saved = await admin(
    request("/personas", { ...character, draft: tokenOf(generated), published: "on" }),
  );
  expect(saved.status).toBe(303);
  expect((await store.publicList())[0]).not.toHaveProperty("gender");
});

test("gender selection is shared by both native forms and persisted gender is optional for legacy records", async () => {
  const { admin, store } = await fixture();
  document.body.innerHTML = await (await admin(request("/new"))).text();
  const select = document.querySelector<HTMLSelectElement>("#gender")!;
  select.value = "male";
  for (const form of document.querySelectorAll("form")) {
    bindPending(form);
    form.dispatchEvent(new SubmitEvent("submit", { cancelable: true }));
    expect(new FormData(form).get("gender")).toBe("male");
  }
  for (const gender of ["female", "male"] as const) {
    const record = { ...legacy, gender };
    expect(parsePersona(record.id, serializePersona(record))).toEqual(record);
  }
  expect(() => decodePersona({ ...legacy, gender: "other" })).toThrow(/gender/);
  await store.create(legacy);
  const editing = await (await admin(request(`/personas/${legacy.id}`))).text();
  document.body.innerHTML = editing;
  expect(document.querySelector("#gender")).toBeNull();
  expect(
    (
      await admin(
        request(`/personas/${legacy.id}`, {
          name: legacy.name,
          description: legacy.prompt,
          draft: tokenOf(editing),
        }),
      )
    ).status,
  ).toBe(303);
  expect((await store.get(legacy.id)).gender).toBeUndefined();
});

test("Gemini character, biography, portrait and sub-scene prompts consider male as well as female characters", async () => {
  const fetcher = vi.fn<typeof fetch>();
  const model = createProfileGenerator({ key: "key", fetcher });
  for (const gender of ["female", "male"] as const) {
    fetcher.mockClear();
    fetcher.mockResolvedValueOnce(modelReply(JSON.stringify(character)));
    await model.character("romantic lead idea", gender);
    const seed = await new Request(...fetcher.mock.calls.at(-1)!).text();
    expect(seed).toContain("Support both female and male");
    fetcher.mockResolvedValueOnce(modelReply("Public intro"));
    await model.introduction({ ...character, gender });
    expect(await new Request(...fetcher.mock.calls.at(-1)!).text()).toContain(policy.introduction);
    fetcher.mockImplementationOnce(portraitReply);
    await model.portrait({ ...character, gender }, "photo");
    const image = await new Request(...fetcher.mock.calls.at(-1)!).text();
    expect(image).toContain("male facial styling");
    fetcher.mockImplementationOnce(portraitReply);
    await model.portrait(
      { ...character, gender },
      "photo",
      "one-image direction",
      portraitImage,
      photoPortrait,
    );
    expect(await new Request(...fetcher.mock.calls.at(-1)!).json()).toMatchObject({
      contents: [
        {
          parts: [
            {
              text: `${policy.portraits.photo}\n\n${policy.regeneratePortraitDirection}\n\n${policy.profilePhotoDirection}\n\n${policy.genderDirection}\n\n${character.name}\n${character.description}\n\nSELECTED GENDER: ${gender}\n\nADDITIONAL PORTRAIT INSTRUCTIONS:\none-image direction`,
            },
            {
              inlineData: {
                mimeType: portraitImage.mimeType,
                data: Buffer.from(portraitImage.bytes).toString("base64"),
              },
            },
            {
              inlineData: {
                mimeType: photoPortrait.mimeType,
                data: Buffer.from(photoPortrait.bytes).toString("base64"),
              },
            },
          ],
        },
      ],
    });
    for (const call of fetcher.mock.calls)
      expect(await new Request(...call).text()).toContain(`SELECTED GENDER: ${gender}`);
  }
});

test("existing male records retain their selected gender but an identity change cannot reuse the old profile", async () => {
  const drafting = vi.fn<typeof generator.character>().mockImplementation(generator.character);
  const introduction = vi
    .fn<typeof generator.introduction>()
    .mockImplementation(generator.introduction);
  const { admin, store } = await fixture({ ...generator, character: drafting, introduction });
  await store.create({ ...legacy, gender: "male" });
  const route = `/personas/${legacy.id}`;
  const page = await (await admin(request(route))).text();
  const fields = {
    name: legacy.name,
    description: legacy.prompt,
    draft: tokenOf(page),
    gender: "male",
  };
  expect((await admin(request(route, fields))).status).toBe(303);
  expect((await store.get(legacy.id)).gender).toBe("male");
  const current = await (await admin(request(route))).text();
  expect(
    (await admin(request(route, { ...fields, draft: tokenOf(current), gender: "female" }))).status,
  ).toBe(400);
  expect(
    (
      await admin(
        request(route, {
          draft: tokenOf(current),
          seed: "a thoughtful man",
          intent: "character",
          gender: "male",
        }),
      )
    ).status,
  ).toBe(200);
  expect(drafting).toHaveBeenCalledWith("a thoughtful man", "male");
  expect(
    (
      await admin(
        request(route, {
          draft: tokenOf(current),
          seed: "idea",
          intent: "character",
          gender: "other",
        }),
      )
    ).status,
  ).toBe(400);
  expect(drafting).toHaveBeenCalledTimes(1);
  const switched = await (
    await admin(
      request(route, { ...fields, draft: tokenOf(current), gender: "female", intent: "generate" }),
    )
  ).text();
  expect(preview(switched).gender).toBe("female");
  expect(preview(switched).prompt).toContain("성별: female");
  expect(introduction).toHaveBeenCalledWith({
    name: legacy.name,
    description: legacy.prompt,
    gender: "female",
  });
  const femaleDraft = await (
    await admin(
      request(route, {
        draft: tokenOf(current),
        seed: "new female character",
        intent: "character",
        gender: "female",
      }),
    )
  ).text();
  expect(preview(femaleDraft).gender).toBe("female");
  expect(drafting).toHaveBeenLastCalledWith("new female character", "female");
});

test("unspecified legacy gender keeps the seed and runtime instructions free of gender overrides", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(modelReply(JSON.stringify(character)));
  const model = createProfileGenerator({ key: "key", fetcher });
  await model.character("legacy seed");
  expect(await new Request(...fetcher.mock.calls[0]!).json()).toMatchObject({
    contents: [
      { parts: [{ text: `${policy.characterDraft}\n\n${policy.genderDirection}\n\nlegacy seed` }] },
    ],
  });
  const { admin, store } = await fixture();
  await store.create({ ...legacy, bio: "", imageUrl: "" });
  const page = await (await admin(request(`/personas/${legacy.id}`))).text();
  const response = await admin(
    request(`/personas/${legacy.id}`, {
      name: "New name",
      description: "New source",
      draft: tokenOf(page),
    }),
  );
  expect(response.status).toBe(303);
  expect((await store.get(legacy.id)).prompt).toBe(
    `${policy.conversation}\n\n이름: New name\n언어: ${legacy.language}\n\nNew source`,
  );
});
