import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { createPersonaStore } from "@ren-ai/personas";
import { createAdmin } from "../src/admin.ts";
import type { ProfileGenerator } from "../src/generation.ts";
import type { LogEntry } from "../src/logging.ts";

export const authorization = `Basic ${Buffer.from("admin:test-password").toString("base64")}`;
export const character = {
  name: "하린",
  description:
    "독립적인 성격의 도예가. 짧은 검은 머리와 차분한 분위기. 서울에서 살며, 밤 산책과 재즈를 좋아한다. 처음에는 존댓말로 천천히 이야기한다.\n비공개 설정: 쉽게 속마음을 말하지 않는다.",
};
export const introduction =
  "도자기를 만들고, 밤에는 오래 걸어요. 요즘 들은 음악 이야기부터 해볼까요?";
export const femaleCharacter = { ...character, gender: "female" as const };
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
  character: async () => character,
  introduction: async () => introduction,
  portrait: async () => ({ bytes: png, mimeType: "image/png" }),
};
export const portraitImage = { bytes: png, mimeType: "image/png" as const };
export const legacy = {
  id: "legacy",
  name: "미라",
  bio: "파리에서 그림을 그려요.",
  imageUrl: "https://example.net/mira.png",
  published: false,
  language: "fr",
  timeZone: "Europe/Paris",
  openingLine: "Introduce yourself.",
  memory: "Remember the paintings.",
  prompt: "You are Mira, a painter in Paris.",
};
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

export async function fixture(model = generator) {
  const root = await mkdtemp(join(tmpdir(), "admin-creator-"));
  roots.push(root);
  const store = await createPersonaStore(root);
  const logs: LogEntry[] = [];
  const admin = createAdmin(store, "test-password", "test styles", {
    generator: model,
    script: "test script",
    log: (entry) => logs.push(entry),
  });
  return { root, store, admin, logs };
}
export const request = (path: string, fields?: Record<string, string>) =>
  new Request(`http://localhost:3729${path}`, {
    method: fields ? "POST" : "GET",
    headers: { authorization, origin: "http://localhost:3729" },
    ...(fields ? { body: new URLSearchParams(fields) } : {}),
  });
export function tokenOf(page: string) {
  const token = /name="draft" value="([^"]+)"/.exec(page)?.[1];
  if (!token) throw new Error("Expected an authoring draft");
  return token;
}
export async function newToken(admin: ReturnType<typeof createAdmin>) {
  return tokenOf(await (await admin(request("/new"))).text());
}
export function idOf(response: Response) {
  const id = /\/personas\/([^?]+)/.exec(response.headers.get("location") ?? "")?.[1];
  if (!id) throw new Error("Expected a created persona");
  return id;
}
