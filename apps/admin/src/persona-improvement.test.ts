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

const profile =
  "천천히 알아가요.\n\n### 관심사\n\n- 산책\n- 재즈\n\n### 문답: 완벽한 일요일은?\n\n늦잠 자고 동네 책방에 가요.";
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

test("improvement proposes, survives reload, applies then saves without changing photos or initial siblings", async () => {
  const { admin, store, convert, fields } = await setup();
  const original = await store.get("legacy");
  const proposal = await admin(request("/personas/legacy", { ...fields, intent: "improve" }));
  expect(proposal.status).toBe(200);
  const page = await proposal.text();
  expect(preview(page).description).toBe(character.description);
  expect(page).toContain("관심사와 문답을 보강했습니다.");
  expect(convert).toHaveBeenCalledWith(
    expect.objectContaining(character),
    fields.improvementInstructions,
  );
  expect(await store.get("legacy")).toEqual(original);
  expect(await (await admin(request("/personas/legacy"))).text()).toContain("개선 결과 비교");
  const applied = await admin(
    request("/personas/legacy", { ...fields, draft: tokenOf(page), intent: "apply-improvement" }),
  );
  expect(applied.status).toBe(200);
  const appliedPage = await applied.text();
  expect(preview(appliedPage).description).toBe(updated);
  expect(preview(appliedPage).imageUrl).toBe(original.imageUrl);
  expect(await store.get("legacy")).toEqual(original);
  expect(
    (
      await admin(
        request("/personas/legacy", {
          ...fields,
          description: updated,
          draft: tokenOf(appliedPage),
          intent: "save",
        }),
      )
    ).status,
  ).toBe(303);
  expect((await store.get("legacy")).description).toBe(updated);
  expect(await store.initial("legacy")).toEqual(initialDocuments);
  expect(JSON.stringify(await store.publicList())).not.toContain("비공개 요청");
});

test("profile-only improvement preserves the private source and cancelling retains current edits", async () => {
  const { admin, fields, rewrite, convert } = await setup();
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
  const applied = await admin(
    request("/personas/legacy", {
      ...fields,
      description: source,
      draft: tokenOf(page),
      intent: "apply-improvement",
    }),
  );
  expect(splitPersonaMarkdown(preview(await applied.text()).description!).privateMarkdown).toBe(
    splitPersonaMarkdown(source).privateMarkdown,
  );
  const changed = `${source}\n\n직접 편집한 내용`;
  const cancelled = await admin(
    request("/personas/legacy", {
      ...fields,
      description: changed,
      draft: tokenOf(page),
      intent: "discard-improvement",
    }),
  );
  expect(preview(await cancelled.text()).description).toBe(changed);
});

test("stale proposals, changed identities, missing results and obsolete intents are rejected", async () => {
  const { admin, fields, store } = await setup();
  expect(
    (await admin(request("/personas/legacy", { ...fields, intent: "apply-improvement" }))).status,
  ).toBe(409);
  expect((await admin(request("/personas/legacy", { ...fields, intent: "convert" }))).status).toBe(
    400,
  );
  const proposed = await admin(request("/personas/legacy", { ...fields, intent: "improve" }));
  const draft = tokenOf(await proposed.text());
  for (const change of [{ description: `${character.description}\n수정` }, { name: "다른 이름" }])
    expect(
      (
        await admin(
          request("/personas/legacy", { ...fields, ...change, draft, intent: "apply-improvement" }),
        )
      ).status,
    ).toBe(change.name ? 400 : 409);
  await store.update({ ...(await store.get("legacy")), description: updated });
  expect(
    (await admin(request("/personas/legacy", { ...fields, draft, intent: "apply-improvement" })))
      .status,
  ).toBe(409);
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
