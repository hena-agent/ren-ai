import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import {
  createPersonaStore,
  renderCharacterSheet,
  initialTraits,
  serializeInitialState,
} from "@ren-ai/personas";
import { createAdmin } from "../src/admin.ts";
import type { ProfileGenerator } from "../src/generation.ts";
import type { LogEntry } from "../src/logging.ts";
import { withPublicProfile } from "@ren-ai/personas/profile";
import { sheet } from "./sheet.ts";
import type { PersonaStore } from "@ren-ai/personas";
import { draftTokens } from "../src/draft.ts";

export const authorization = `Basic ${Buffer.from("admin:test-password").toString("base64")}`;
export const character = {
  name: "하린",
  description: withPublicProfile(
    renderCharacterSheet({
      ...sheet,
      appearance:
        "독립적인 성격의 도예가. 짧은 검은 머리와 차분한 분위기. 서울에서 살며, 밤 산책과 재즈를 좋아한다. 처음에는 존댓말로 천천히 이야기한다.\n비공개 설정: 쉽게 속마음을 말하지 않는다.",
    }),
    "도자기를 만들고, 밤에는 오래 걸어요. 요즘 들은 음악 이야기부터 해볼까요?",
  ),
};
export const introduction =
  "도자기를 만들고, 밤에는 오래 걸어요. 요즘 들은 음악 이야기부터 해볼까요?";
export const femaleCharacter = { ...character, gender: "female" as const };
export const initialDocuments = {
  state: serializeInitialState({
    mood: 55,
    energy: 60,
    stress: 35,
    connection: 55,
    solitude: 60,
    affection: 18,
    traits: initialTraits(character.description),
  }),
  memory: "# 현재 생활\n\n- 사진전을 준비 중이다.\n",
};
export const authoredCharacter = { ...character, initial: initialDocuments };
export const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);
export const portraitReply = async () =>
  Response.json({
    candidates: [
      {
        content: {
          parts: [{ inlineData: { mimeType: "image/png", data: png.toString("base64") } }],
        },
      },
    ],
  });
export const generator: ProfileGenerator = {
  sheet: async () => ({ bytes: png, mimeType: "image/png" }),
  character: async () => authoredCharacter,
  introduction: async () => introduction,
  profile: async () => introduction,
  convert: async (source) => ({
    ...source,
    description: withPublicProfile(source.description, introduction),
    additions: [],
  }),
  state: async () => initialDocuments.state,
  memory: async () => initialDocuments.memory,
  portrait: async () => ({ bytes: png, mimeType: "image/png" }),
};
export const portraitImage = { bytes: png, mimeType: "image/png" as const };
// Stored images must decode: every save also writes their display thumbnail.
export const jpeg = Buffer.from(
  "/9j/4AAQSkZJRgABAgAAAQABAAD/wAARCAABAAEDAREAAhEBAxEB/9sAQwAGBAUGBQQGBgUGBwcGCAoQCgoJCQoUDg8MEBcUGBgXFBYWGh0lHxobIxwWFiAsICMmJykqKRkfLTAtKDAlKCko/9sAQwEHBwcKCAoTCgoTKBoWGigoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgo/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDQr54+wP/Z",
  "base64",
);
export const webp = Buffer.from("UklGRhwAAABXRUJQVlA4TBAAAAAvAAAAEM1VICICxStUxSMB", "base64");
export const photoPortrait = { bytes: jpeg, mimeType: "image/jpeg" as const };
export async function seedSheets(store: PersonaStore, id: string) {
  const sheets = {
    anime: await store.saveImage(portraitImage),
    photo: await store.saveImage(photoPortrait),
  };
  for (const style of ["anime", "photo"] as const) await store.saveSheet(id, style, sheets[style]);
  return sheets;
}
export const legacy = {
  version: 1,
  id: "legacy",
  name: "미라",
  bio: "파리에서 그림을 그려요.",
  imageUrl: "https://example.net/mira.png",
  published: false,
  language: "fr",
  timeZone: "Europe/Paris",
  openingLine: "Introduce yourself.",
  memory: "Remember the paintings.",
  prompt: withPublicProfile("You are Mira, a painter in Paris.", "파리에서 그림을 그려요."),
  description: withPublicProfile("You are Mira, a painter in Paris.", "파리에서 그림을 그려요."),
  publicProfile: "파리에서 그림을 그려요.",
};
const roots: string[] = [];
export const fixtureStores = new WeakMap<ReturnType<typeof createAdmin>, PersonaStore>();
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

export async function fixture(model = generator) {
  const root = await mkdtemp(join(tmpdir(), "admin-creator-"));
  roots.push(root);
  const store = await createPersonaStore(root);
  const logs: LogEntry[] = [];
  const admin = createAdmin(store, "test-password", {
    generator: model,
    log: (entry) => logs.push(entry),
  });
  fixtureStores.set(admin, store);
  return { root, store, admin, logs };
}
export const request = (path: string, fields?: Record<string, string>) => {
  const url = new URL(path, "http://localhost:3729");
  // Photo-operation fixtures target photo unless a test explicitly selects another style.
  if (fields?.["intent"] === "generate" && !url.searchParams.has("style"))
    url.searchParams.set("style", "photo");
  return new Request(url, {
    method: fields ? "POST" : "GET",
    headers: { authorization, origin: "http://localhost:3729" },
    ...(fields
      ? {
          body: new URLSearchParams({
            ...(fields["published"] === "on" && {
              stateSource: initialDocuments.state,
              memorySource: initialDocuments.memory,
            }),
            ...fields,
          }),
        }
      : {}),
  });
};
export function tokenOf(page: string) {
  const token = /name="draft" value="([^"]+)"/.exec(page)?.[1];
  if (!token) throw new Error("Expected an authoring draft");
  return token;
}
export async function newToken(admin: ReturnType<typeof createAdmin>) {
  const token = tokenOf(await (await admin(request("/new"))).text());
  const store = fixtureStores.get(admin);
  if (!store) return token;
  // Photo workflow tests start with established identities; sheet creation has its own tests.
  const tokens = draftTokens("test-password");
  const draft = tokens.decode(token);
  const sheets = await seedSheets(store, draft.id);
  return tokens.encode({ ...draft, sheets });
}
export function idOf(response: Response) {
  const id = /\/personas\/([^?]+)/.exec(response.headers.get("location") ?? "")?.[1];
  if (!id) throw new Error("Expected a created persona");
  return id;
}
