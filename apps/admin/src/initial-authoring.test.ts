import { expect, test, vi } from "vitest";
import { createProfileGenerator } from "./generation.ts";
import { draftTokens, documentsOf } from "./draft.ts";
import { initialDocs, initialFixture, scores } from "../test/initial.ts";
import { generator, request, tokenOf } from "../test/fixtures.ts";
import { modelReply } from "../test/sub-portraits.ts";
import { deferred, queuedRequest, jobUrl, finishedJob } from "../test/queue.ts";
import { checkInitialPersona } from "@ren-ai/personas";

const path = "/personas/harin";
const token = async (admin: Awaited<ReturnType<typeof initialFixture>>["admin"]) =>
  tokenOf(await (await admin(request(path))).text());
async function fields(setup: Awaited<ReturnType<typeof initialFixture>>) {
  const persona = await setup.store.get("harin");
  return {
    name: persona.name,
    description: persona.prompt,
    draft: await token(setup.admin),
    stateSource: initialDocs.state,
    memorySource: initialDocs.memory,
  };
}

test("three documents save together and both initial downloads require authentication", async () => {
  const setup = await initialFixture();
  const before = await setup.store.get("harin");
  const page = await (await setup.admin(request(path))).text();
  expect(page).toContain('role="tablist"');
  expect(page).not.toContain("data-document-mode");
  expect(page).not.toContain("/initial");
  expect((await setup.admin(request(`${path}/state.md`))).status).toBe(404);
  const saved = await setup.admin(
    request(path, { ...(await fields(setup)), intent: "save", tab: "memory" }),
  );
  expect(saved.status).toBe(303);
  expect(saved.headers.get("location")).toContain("tab=memory");
  const restored = await (await setup.admin(request(saved.headers.get("location")!))).text();
  expect(restored).toContain('id="pane-memory" aria-labelledby="tab-memory"');
  expect(restored).not.toContain('id="pane-memory" aria-labelledby="tab-memory" hidden');
  for (const tab of ["persona", "state", "memory", "invalid"]) {
    const selected = tab === "invalid" ? "persona" : tab;
    const markup = await (await setup.admin(request(`${path}?tab=${tab}`))).text();
    expect(markup).not.toContain(`id="pane-${selected}" aria-labelledby="tab-${selected}" hidden`);
  }
  expect(await setup.store.initial("harin")).toEqual(initialDocs);
  expect((await setup.store.get("harin")).portraits).toEqual(before.portraits);
  for (const key of ["state", "memory"] as const) {
    const download = await setup.admin(request(`${path}/${key}.md`));
    expect(download.status).toBe(200);
    expect(await download.text()).toBe(initialDocs[key]);
    expect((await setup.admin(new Request(`http://localhost:3729${path}/${key}.md`))).status).toBe(
      401,
    );
  }
  expect((await setup.admin(request(`${path}/initial`))).status).toBe(404);
});

test("each regeneration returns only its document, uses private Persona only, and preserves siblings and photos", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(modelReply(JSON.stringify(scores)))
    .mockResolvedValueOnce(modelReply("# 현재 생활\n\n- 새 사진전 준비 중이다."));
  const setup = await initialFixture(createProfileGenerator({ key: "private-key", fetcher }));
  const submitted = await fields(setup);
  const first = await setup.admin(
    request(path, {
      ...submitted,
      memorySource: "# 현재 생활\n\n- 직접 쓴 생활.",
      intent: "state",
    }),
  );
  expect(first.status).toBe(200);
  const draft = draftTokens("test-password").decode(tokenOf(await first.text()));
  expect(documentsOf(draft).memory).toContain("직접 쓴 생활");
  expect(checkInitialPersona(documentsOf(draft), submitted.description)).toBeDefined();
  expect(draft.tab).toBe("state");
  const second = await setup.admin(
    request(path, {
      ...submitted,
      draft: draftTokens("test-password").encode(draft),
      stateSource: documentsOf(draft).state,
      intent: "memory",
    }),
  );
  const next = draftTokens("test-password").decode(tokenOf(await second.text()));
  expect(next.tab).toBe("memory");
  expect(documentsOf(next).state).toBe(documentsOf(draft).state);
  expect(documentsOf(next).memory).toContain("새 사진전");
  expect(await setup.store.initial("harin")).toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(2);
  for (const call of fetcher.mock.calls) {
    const payload = await new Request(...call).text();
    expect(payload).not.toContain("천천히 알아가요.");
    expect(payload).not.toContain("직접 쓴 생활");
  }
});

test("future public saves require actual Persona, State and nonempty Memory while existing exposure remains", async () => {
  const setup = await initialFixture();
  expect(await setup.store.publicList()).toHaveLength(1);
  const complete = await fields(setup);
  for (const changes of [
    { description: "잘못된 Persona" },
    { name: "다른 이름" },
    { stateSource: "" },
    { stateSource: initialDocs.state.replace("mood: 55", "mood: 101") },
    { stateSource: initialDocs.state.replace("strength: 80", "strength: 40") },
    { memorySource: "" },
    { memorySource: "# 현재 생활\n" },
  ]) {
    const response = await setup.admin(request(path, { ...complete, ...changes, published: "on" }));
    expect(response.status).toBe(400);
    expect(await setup.store.publicList()).toHaveLength(1);
    expect(await setup.store.initial("harin")).toBeUndefined();
  }
  expect((await setup.admin(request(path, { ...complete, published: "on" }))).status).toBe(303);
  expect(JSON.stringify(await setup.store.publicList())).not.toContain("traits");
  expect(
    (
      await setup.admin(
        request(path, {
          ...(await fields(setup)),
          stateSource: "작업 중인 State",
          memorySource: "작성 중",
          description: "작성 중인 Persona",
        }),
      )
    ).status,
  ).toBe(303);
  expect(await setup.store.publicList()).toEqual([]);
});

test("stale State/Memory, malformed input and unauthorized old publication requests cannot bypass the gate", async () => {
  const setup = await initialFixture();
  const submitted = await fields(setup);
  await setup.store.saveInitial("harin", initialDocs, {
    persona: await setup.store.source("harin"),
  });
  expect((await setup.admin(request(path, { ...submitted, intent: "memory" }))).status).toBe(409);
  const fresh = await fields(setup);
  expect(
    (await setup.admin(request(path, { ...fresh, stateSource: "x".repeat(16001) }))).status,
  ).toBe(400);
  expect((await setup.admin(request(path, { ...fresh, tab: "bad" }))).status).toBe(400);
  const crossOrigin = request(path, fresh);
  crossOrigin.headers.set("origin", "https://evil.example");
  expect((await setup.admin(crossOrigin)).status).toBe(400);
});

test("generation and persistence errors keep all edited inputs and emit one payload-safe correlated diagnostic", async () => {
  const state = vi
    .fn<typeof generator.state>()
    .mockRejectedValueOnce(
      Object.assign(new Error("provider failed private memory"), { code: "E_PROVIDER" }),
    );
  const setup = await initialFixture({ ...generator, state });
  const submitted = { ...(await fields(setup)), memorySource: "# 현재 생활\n\nprivate memory" };
  const failure = await setup.admin(request(path, { ...submitted, intent: "state" }));
  expect(failure.status).toBe(503);
  expect(await failure.text()).toContain("private memory");
  const logs = setup.logs.filter(
    (entry) =>
      entry.requestId === failure.headers.get("x-request-id") && entry.event === "operation.failed",
  );
  expect(logs).toHaveLength(1);
  expect(logs[0]).toMatchObject({
    stage: "state.generate",
    code: "E_PROVIDER",
    personaId: "harin",
  });
  expect(JSON.stringify(setup.logs)).not.toContain("private memory");
  const write = vi
    .spyOn(setup.store, "save")
    .mockRejectedValueOnce(Object.assign(new Error("disk offline"), { code: "EIO" }));
  const response = await setup.admin(request(path, submitted));
  write.mockRestore();
  expect(response.status).toBe(503);
  expect(await setup.store.initial("harin")).toBeUndefined();
});

test("invalid model output fails safely without overwriting any document", async () => {
  for (const [intent, text] of [
    ["state", '{"mood":101}'],
    ["memory", "# 상대와의 기억\nprivate payload"],
    ["memory", "# 현재 생활"],
  ] as const) {
    const setup = await initialFixture(
      createProfileGenerator({ key: "key", fetcher: async () => modelReply(text) }),
    );
    const response = await setup.admin(request(path, { ...(await fields(setup)), intent }));
    expect(response.status).toBe(503);
    expect(await setup.store.initial("harin")).toBeUndefined();
    expect(JSON.stringify(setup.logs)).not.toContain("private payload");
  }
});

test("queued image work locks all three document operations until it completes", async () => {
  const gate = deferred<void>();
  const state = vi.fn<typeof generator.state>().mockImplementation(generator.state);
  const setup = await initialFixture({
    ...generator,
    state,
    portrait: async (...args) => {
      await gate.promise;
      return generator.portrait(...args);
    },
  });
  const submitted = await fields(setup);
  const queued = await setup.admin(queuedRequest(path, { ...submitted, intent: "generate" }));
  expect(queued.status).toBe(303);
  const response = await setup.admin(request(path, { ...submitted, intent: "state" }));
  expect(response.status).toBe(409);
  expect(state).not.toHaveBeenCalled();
  expect(
    (
      await setup.admin(
        request(path, { ...submitted, memorySource: "changed during work", intent: "subportrait" }),
      )
    ).status,
  ).toBe(409);
  gate.resolve();
  await finishedJob(setup.admin, jobUrl(queued));
});

test("invalid Persona blocks regeneration before provider calls and a changed source during a provider request rejects its result", async () => {
  const state = vi.fn<typeof generator.state>().mockImplementation(generator.state);
  const setup = await initialFixture({ ...generator, state });
  const submitted = await fields(setup);
  expect(
    (await setup.admin(request(path, { ...submitted, description: "incomplete", intent: "state" })))
      .status,
  ).toBe(400);
  expect(state).not.toHaveBeenCalled();
  state.mockImplementationOnce(async () => {
    await setup.store.update({ ...(await setup.store.get("harin")), name: "External edit" });
    return initialDocs.state;
  });
  expect((await setup.admin(request(path, { ...submitted, intent: "state" }))).status).toBe(409);
});
