import { expect, test } from "vitest";
import { parseInitialState, serializeInitialState, serializePersona } from "@ren-ai/personas";
import { cloudflareFixture, databasePersona } from "../test/cloudflare-fixture.ts";
import { initialDocuments, portraitImage, fixture } from "../test/fixtures.ts";

test("D1 and file Catalogs expose only approved initial language proficiency and fixed language labels", async () => {
  const cloud = await cloudflareFixture();
  const local = await fixture();
  const description = databasePersona.description!.replace(
    "성별: 여성",
    "성별: 여성\n주 사용 언어: ko\n모국어: ko",
  );
  const documents = {
    ...initialDocuments,
    state: serializeInitialState({
      ...parseInitialState(initialDocuments.state),
      languageProficiency: { ko: "fluent", en: "beginner" },
    }),
  };
  for (const store of [cloud.store, local.store]) {
    const imageUrl = await store.saveImage(portraitImage);
    await store.save(
      {
        ...databasePersona,
        description,
        published: true,
        imageUrl,
        portraits: { photo: imageUrl },
      },
      documents,
      { persona: "" },
    );
    const [profile] = await store.publicList();
    expect(profile?.languages).toEqual({
      proficiency: { ko: "fluent", en: "beginner" },
      primary: "ko",
      native: ["ko"],
    });
    const json = JSON.stringify(profile);
    for (const privateKey of ["affection", "traits", "state", "memory"])
      expect(profile).not.toHaveProperty(privateKey);
    expect(json).not.toContain("비공개");
    const saved = await store.get(databasePersona.id);
    await store.save(
      saved,
      {
        ...documents,
        state: serializeInitialState({
          ...parseInitialState(documents.state),
          languageProficiency: { ko: "fluent", en: "proficient" },
        }),
      },
      { persona: serializePersona(saved), initial: documents },
    );
    expect((await store.publicList())[0]?.languages?.proficiency["en"]).toBe("proficient");
  }
  await cloud.db
    .prepare("UPDATE personas SET state = '' WHERE id = ?")
    .bind(databasePersona.id)
    .run();
  expect((await cloud.store.publicList())[0]?.languages).toBeUndefined();
});
