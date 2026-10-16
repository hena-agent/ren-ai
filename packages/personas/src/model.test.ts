import { expect, test } from "vitest";
import { decodePersona, parsePersona, serializePersona } from "./model.ts";
import { withPublicProfile } from "./profile.ts";

const persona = decodePersona({
  id: "mira",
  name: "미라",
  bio: "공개 소개",
  imageUrl: "https://example.net/mira.jpg",
  published: false,
  language: "ko",
  timeZone: "Asia/Seoul",
  openingLine: "인사해",
  memory: "기억해",
  prompt: withPublicProfile("가상 인물의 내부 프롬프트", "공개 소개"),
});

test("one Markdown source survives storage and derives public values without duplicate frontmatter", () => {
  const record = decodePersona({
    ...persona,
    descriptionVersion: 2,
    description: withPublicProfile(
      persona.description!,
      "안녕하세요.\n\n### 내가 편해지는 순간\n말없이 걷는 시간.",
    ),
  });
  expect(parsePersona(record.id, serializePersona(record))).toEqual(record);
  expect(record.bio).toBe("안녕하세요.");
  const { description: _description, ...runtime } = record;
  expect(parsePersona(record.id, serializePersona(runtime)).bio).toBe(record.bio);
  const metadata = serializePersona(record).split("---")[1]!;
  for (const duplicate of ["bio:", "description:", "profile-details:"])
    expect(metadata).not.toContain(duplicate);
  expect(() => decodePersona({ ...record, profileDetails: { memory: "private" } })).toThrow(
    "profileDetails",
  );
});

test("frontmatter rejects unknown keys and incorrect types before producing a persona", () => {
  const source = serializePersona(persona);
  expect(parsePersona(persona.id, source)).toEqual(persona);
  for (const replacement of [
    "language: ko\nunsafe: yes",
    "language: 12",
    "language: ko\ndescription: 12",
  ]) {
    let failure: Error | undefined;
    try {
      parsePersona(persona.id, source.replace("language: ko", replacement));
    } catch (error) {
      if (error instanceof Error) failure = error;
    }
    expect(failure?.message).toMatch(/Persona mira: invalid frontmatter:/);
    expect(failure?.cause).toBeInstanceOf(Error);
  }
});

test("portrait pairs require two complete safe URLs and survive serialization", () => {
  const portraits = {
    anime: "/images/01234567-89ab-cdef-0123-456789abcdef.png",
    photo: "https://example.net/photo.jpg",
  };
  expect(parsePersona(persona.id, serializePersona({ ...persona, portraits })).portraits).toEqual(
    portraits,
  );
  for (const incomplete of [
    {},
    { anime: "", photo: portraits.photo },
    { anime: portraits.anime, photo: "" },
    { anime: portraits.anime, photo: 12 },
  ])
    expect(() => decodePersona({ ...persona, portraits: incomplete })).toThrow(/portraits/);
  for (const bad of [
    "http://example.net/image.jpg",
    "javascript:alert(1)",
    `/prefix${portraits.anime}`,
    `${portraits.anime}/extra`,
  ])
    for (const style of ["anime", "photo"])
      expect(() =>
        decodePersona({ ...persona, portraits: { ...portraits, [style]: bad } }),
      ).toThrow(/Invalid URL|HTTPS/);
  expect(decodePersona({ ...persona, portraits: { anime: portraits.anime } }).portraits).toEqual({
    anime: portraits.anime,
  });
  expect(decodePersona({ ...persona, portraits: { photo: portraits.photo } }).portraits).toEqual({
    photo: portraits.photo,
  });
});

test("malformed files retain actionable parse errors and cannot hide frontmatter after a prefix", () => {
  expect(() => parsePersona(persona.id, "not a persona")).toThrow(
    "Persona mira: expected YAML frontmatter and prompt",
  );
  expect(() => parsePersona(persona.id, `prefix\n${serializePersona(persona)}`)).toThrow(
    "Persona mira: expected YAML frontmatter and prompt",
  );
  expect(() => parsePersona(persona.id, "---\nlanguage: [\n---\nPrompt")).toThrow(
    /Persona mira: Flow sequence/,
  );
});

test("owned portrait URLs must match the complete service path while legacy descriptions remain optional", () => {
  const path = "/images/01234567-89ab-cdef-0123-456789abcdef.png";
  expect(decodePersona({ ...persona, imageUrl: path }).imageUrl).toBe(path);
  for (const imageUrl of [
    `/prefix${path}`,
    `${path}/extra`,
    `http://evil.example${path}`,
    `javascript:${path}`,
  ])
    expect(() => decodePersona({ ...persona, imageUrl })).toThrow(/Invalid URL|HTTPS/);
  expect(serializePersona(persona)).not.toContain("description:");
  expect(
    parsePersona(
      persona.id,
      serializePersona({ ...persona, description: "아주 긴 캐릭터 원본 설명" }),
    ).description,
  ).toBe("아주 긴 캐릭터 원본 설명");
});
