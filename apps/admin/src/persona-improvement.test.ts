import { expect, test, vi } from "vitest";
import {
  fixture,
  generator,
  character,
  request,
  tokenOf,
  legacy,
  initialDocuments,
} from "../test/fixtures.ts";
import { preview } from "../test/sub-portraits.ts";
import { splitPersonaMarkdown, withPublicProfile } from "@ren-ai/personas/profile";
import { captureImprovement } from "./persona-improvement.ts";
import { serializePersona } from "@ren-ai/personas";
import { draftTokens } from "./draft.ts";

const profile =
  "천천히 알아가요.\n\n### 라이프스타일\n\n주말엔 늦잠을 자고 동네를 걸어요.\n\n### 관심사\n\n산책, 재즈\n\n### 문답: 완벽한 일요일은?\n\n늦잠 자고 동네 책방에 가요.";
const updated = withPublicProfile(character.description, profile);

async function setup() {
  const convert = vi.fn<typeof generator.convert>().mockResolvedValue({
    ...character,
    description: updated,
    additions: ["관심사와 문답을 보강했습니다."],
  });
  const rewrite = vi.fn<typeof generator.profile>().mockResolvedValue(profile);
  const result = await fixture({ ...generator, convert, profile: rewrite });
  await result.store.create({ ...legacy, ...character });
  await result.store.saveInitial("legacy", initialDocuments, {
    persona: serializePersona(await result.store.get("legacy")),
  });
  const page = await (await result.admin(request("/personas/legacy"))).text();
  const fields = {
    ...character,
    draft: tokenOf(page),
    improvementInstructions: "비공개 요청: 주말 생활을 보강해 줘.",
  };
  return { ...result, convert, rewrite, fields };
}

test("improvement automatically updates the draft, survives reload and saves without changing photos or initial siblings", async () => {
  const { admin, store, convert, fields } = await setup();
  const original = await store.get("legacy");
  const proposal = await admin(request("/personas/legacy", { ...fields, intent: "improve" }));
  expect(proposal.status).toBe(200);
  const page = await proposal.text();
  expect(preview(page).description).toBe(updated);
  expect(preview(page).imageUrl).toBe(original.imageUrl);
  expect(draftTokens("test-password").decode(tokenOf(page)).conversion?.source).toBe(
    character.description,
  );
  expect(page).toContain("관심사와 문답을 보강했습니다.");
  expect(convert).toHaveBeenCalledWith(
    expect.objectContaining(character),
    fields.improvementInstructions,
  );
  expect(await store.get("legacy")).toEqual(original);
  const reloaded = await (await admin(request("/personas/legacy"))).text();
  expect(reloaded).toContain("data-improvement-source");
  expect(preview(reloaded).description).toBe(updated);
  expect(
    (
      await admin(
        request("/personas/legacy", {
          ...fields,
          description: updated,
          draft: tokenOf(page),
          published: "on",
          intent: "save",
        }),
      )
    ).status,
  ).toBe(303);
  expect((await store.get("legacy")).description).toBe(updated);
  expect(await store.initial("legacy")).toEqual(initialDocuments);
  expect(JSON.stringify(await store.publicList())).not.toContain("비공개 요청");
  expect(await (await admin(request("/personas/legacy"))).text()).not.toContain(
    "data-improvement-source",
  );
});

test("profile-only improvement preserves private edits and the result remains directly editable and publishable", async () => {
  const { admin, fields, rewrite, convert, store } = await setup();
  const source = character.description.replace("짧은 검은 머리", "긴 갈색 머리");
  const response = await admin(
    request("/personas/legacy", {
      ...fields,
      description: source,
      improvementScope: "profile",
      intent: "improve",
    }),
  );
  const page = await response.text();
  expect(rewrite).toHaveBeenCalledWith(
    expect.objectContaining({ description: source }),
    fields.improvementInstructions,
  );
  expect(convert).not.toHaveBeenCalled();
  const improved = preview(page).description!;
  expect(splitPersonaMarkdown(improved).privateMarkdown).toBe(
    splitPersonaMarkdown(source).privateMarkdown,
  );
  const changed = `${improved}\n\n직접 편집한 내용`;
  const inspected = await admin(
    request("/personas/legacy", {
      ...fields,
      description: changed,
      draft: tokenOf(page),
      intent: "inspect",
    }),
  );
  expect(inspected.status).toBe(200);
  const inspectedPage = await inspected.text();
  expect(inspectedPage).toContain("직접 편집한 내용");
  const saved = await admin(
    request("/personas/legacy", {
      ...fields,
      description: changed,
      draft: tokenOf(inspectedPage),
      published: "on",
      intent: "save",
    }),
  );
  expect(saved.status).toBe(303);
  expect((await store.get("legacy")).description).toBe(changed);
});

test("obsolete proposal intents are rejected and stale saved snapshots cannot be improved", async () => {
  const { admin, fields, store } = await setup();
  for (const intent of ["convert", "apply-improvement", "discard-improvement"])
    expect((await admin(request("/personas/legacy", { ...fields, intent }))).status).toBe(400);
  const proposed = await admin(request("/personas/legacy", { ...fields, intent: "improve" }));
  const draft = tokenOf(await proposed.text());
  await store.update({ ...(await store.get("legacy")), description: updated });
  expect(
    (await admin(request("/personas/legacy", { ...fields, draft, intent: "improve" }))).status,
  ).toBe(409);
});

test("repeated improvement uses the current edited draft as its diff baseline", async () => {
  const { admin, fields, convert } = await setup();
  const first = await admin(request("/personas/legacy", { ...fields, intent: "improve" }));
  const current = `${updated}\n\n직접 추가한 내용`;
  convert.mockResolvedValueOnce({
    ...character,
    description: `${current}\n\n한 번 더 개선`,
    additions: [],
  });
  const response = await admin(
    request("/personas/legacy", {
      ...fields,
      description: current,
      draft: tokenOf(await first.text()),
      intent: "improve",
    }),
  );
  expect(response.status).toBe(200);
  const page = await response.text();
  expect(draftTokens("test-password").decode(tokenOf(page)).conversion?.source).toBe(current);
  expect(convert).toHaveBeenLastCalledWith(
    expect.objectContaining({ description: current }),
    fields.improvementInstructions,
  );
  expect(preview(page).description).toContain("한 번 더 개선");
});

test("a concurrent saved change rejects the generated result before it can replace the editing draft", async () => {
  const { admin, fields, convert, store } = await setup();
  const concurrent = withPublicProfile(character.description, "다른 탭에서 저장한 소개");
  convert.mockImplementationOnce(async () => {
    await store.update({ ...(await store.get("legacy")), description: concurrent });
    return { ...character, description: updated, additions: [] };
  });
  const response = await admin(request("/personas/legacy", { ...fields, intent: "improve" }));
  expect(response.status).toBe(409);
  const page = await response.text();
  expect(preview(page).description).toBe(character.description);
  expect(page).not.toContain("data-improvement-source");
  expect((await store.get("legacy")).description).toBe(concurrent);
});

test("failure diagnostics are correlated and exclude operator prompts and generated private text", async () => {
  const { admin, fields, rewrite, logs, store } = await setup();
  rewrite.mockRejectedValueOnce(
    Object.assign(new Error("Provider failed"), { code: "ECONNRESET" }),
  );
  const response = await admin(
    request("/personas/legacy", { ...fields, improvementScope: "profile", intent: "improve" }),
  );
  expect(response.status).toBe(503);
  const page = await response.text();
  expect(page).toContain(fields.improvementInstructions);
  expect(preview(page).description).toBe(character.description);
  const failure = logs.filter((entry) => entry.event === "operation.failed");
  expect(failure).toHaveLength(1);
  expect(failure[0]).toMatchObject({
    requestId: response.headers.get("X-Request-ID"),
    stage: "persona.improve",
    code: "ECONNRESET",
  });
  expect(JSON.stringify(logs)).not.toContain(fields.improvementInstructions);
  expect(JSON.stringify(logs)).not.toContain("비공개 설정");
  expect((await store.get("legacy")).description).toBe(character.description);
  rewrite.mockResolvedValueOnce("### 자기소개 없음");
  expect(
    (
      await admin(
        request("/personas/legacy", { ...fields, improvementScope: "profile", intent: "improve" }),
      )
    ).status,
  ).toBe(503);
});

test("improvement input is narrowed at the form boundary and bounded", () => {
  const draft = { id: "id", base: "", preview: "" };
  expect(captureImprovement(new FormData(), draft).improvementInput).toEqual({
    scope: "persona",
    instructions: "",
  });
  for (const [key, value] of [
    ["improvementScope", "invalid"],
    ["improvementInstructions", "x".repeat(4001)],
  ]) {
    const form = new FormData();
    form.set(key!, value!);
    expect(() => captureImprovement(form, draft)).toThrow("개선 범위");
  }
  const upload = new FormData();
  upload.set("improvementInstructions", new Blob(["input"]), "prompt.txt");
  expect(() => captureImprovement(upload, draft)).toThrow("개선 범위");
});

test("improvement rejects invalid results with shared document diagnostics before replacing drafts", async () => {
  const { admin, fields, convert, logs } = await setup();
  for (const result of [
    { ...character, name: "다른 이름" },
    { ...character, description: "" },
    { ...character, description: character.description.replace("## 말투", "## 잘못된 섹션") },
    {
      ...character,
      description: character.description.replace(`이름: ${character.name}`, "이름: 다른 이름"),
    },
  ]) {
    convert.mockResolvedValueOnce({ ...result, additions: [] });
    const response = await admin(request("/personas/legacy", { ...fields, intent: "improve" }));
    expect(response.status).toBe(503);
    expect(preview(await response.text()).description).toBe(character.description);
    const failure = logs.find(
      (entry) =>
        entry.requestId === response.headers.get("X-Request-ID") &&
        entry.event === "operation.failed",
    );
    expect(failure?.stage).toBe("persona.improve");
    expect(failure?.code).toBe(
      result.name !== character.name ? "improvement_identity_mismatch" : "invalid_character",
    );
    expect(JSON.stringify(failure)).not.toContain(fields.improvementInstructions);
    expect(JSON.stringify(failure)).not.toContain(character.description);
  }
});
