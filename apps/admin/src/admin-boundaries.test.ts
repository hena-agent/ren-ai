import { rm } from "node:fs/promises";
import { expect, test, vi } from "vitest";
import { createAdmin } from "./admin.ts";
import {
  authorization,
  character,
  fixture,
  generator,
  legacy,
  introduction,
  request,
  newToken,
  tokenOf,
} from "../test/fixtures.ts";
import copy from "./copy.json";

test("authentication and same-origin submission protect all management and draft image routes", async () => {
  const { admin, store } = await fixture();
  expect(() => createAdmin(store, " ", "")).toThrow("ADMIN_PASSWORD is required");
  for (const path of [
    "/",
    "/new",
    "/style.css",
    "/pending.js",
    "/images/file.png",
    "/personas/legacy",
  ]) {
    const denied = await admin(new Request(`http://localhost:3729${path}`));
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toBe(
      'Basic realm="Persona Admin", charset="UTF-8"',
    );
    expect(denied.headers.get("cache-control")).toBe("no-store");
  }
  expect(
    (
      await admin(
        new Request("http://localhost:3729/", { headers: { authorization: "Basic wrong" } }),
      )
    ).status,
  ).toBe(401);
  expect(
    (
      await admin(
        new Request("http://localhost:3729/personas", {
          method: "POST",
          body: new URLSearchParams(character),
        }),
      )
    ).status,
  ).toBe(401);
  expect(
    (await admin(new Request("http://localhost:3729/api/personas", { method: "POST" }))).status,
  ).toBe(401);
  for (const origin of ["https://evil.example", "null", ""]) {
    const response = await admin(
      new Request("http://localhost:3729/personas", {
        method: "POST",
        headers: { authorization, origin },
        body: new URLSearchParams(character),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(copy.originError);
  }
  const method = await admin(
    new Request("http://localhost:3729/", { method: "DELETE", headers: { authorization } }),
  );
  expect(method.status).toBe(405);
  expect(method.headers.get("allow")).toBe("GET, POST");
  expect(await store.list()).toEqual([]);
});

test("invalid publication keeps the description, while malformed forms and tampered draft tokens are rejected", async () => {
  const { admin, store } = await fixture();
  const draft = await newToken(admin);
  const invalid = await admin(request("/personas", { ...character, draft, published: "on" }));
  expect(invalid.status).toBe(400);
  const page = await invalid.text();
  expect(page).toContain("소개와 프로필 이미지");
  expect(page).toContain("독립적인 성격의 도예가");
  expect(page).toContain('id="published"');
  expect(page).toContain("checked");
  expect(page).toContain(copy.noImage);
  for (const broken of [
    "",
    "abc",
    "abc.",
    `${draft}.extra`,
    `${draft.slice(0, -2)}00`,
    "abc.YWJj",
  ]) {
    const response = await admin(request("/personas", { ...character, draft: broken }));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(copy.formError);
  }
  for (const changed of [{ name: "" }, { description: " " }]) {
    const response = await admin(request("/personas", { ...character, draft, ...changed }));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(copy.characterRequired);
  }
  const whitespaceName = await admin(request("/personas", { ...character, draft, name: "   " }));
  const retained = await whitespaceName.text();
  expect(whitespaceName.status).toBe(400);
  expect(retained).toContain("독립적인 성격의 도예가");
  expect(retained).toContain('name="description"');
  const malformed = await admin(
    new Request("http://localhost:3729/personas", {
      method: "POST",
      headers: {
        authorization,
        origin: "http://localhost:3729",
        "Content-Type": "application/json",
      },
      body: "{}",
    }),
  );
  expect(malformed.status).toBe(400);
  expect(await malformed.text()).toContain(copy.formError);
  for (const key of ["name", "description", "draft", "intent"]) {
    const form = new FormData();
    for (const [field, value] of Object.entries({ ...character, draft })) form.set(field, value);
    form.set(key, new File(["not text"], "field.txt"));
    expect(
      (
        await admin(
          new Request("http://localhost:3729/personas", {
            method: "POST",
            headers: { authorization, origin: "http://localhost:3729" },
            body: form,
          }),
        )
      ).status,
    ).toBe(400);
  }
  expect((await admin(request("/personas", { ...character, intent: "save" }))).status).toBe(400);
  expect((await admin(request("/personas", { draft }))).status).toBe(400);
  expect(
    (await admin(request("/personas", { ...character, draft, intent: "unsupported" }))).status,
  ).toBe(400);
  expect(
    (await admin(request("/personas", { ...character, draft, intent: "portrait" }))).status,
  ).toBe(400);
  expect(await store.list()).toEqual([]);
});

test("changed source must regenerate before saving or replacing an image, and invalid routes cannot change identity", async () => {
  const intro = vi.fn<typeof generator.introduction>().mockResolvedValue(introduction);
  const { admin, store } = await fixture({ ...generator, introduction: intro });
  await store.create(legacy);
  const page = await (await admin(request("/personas/legacy"))).text();
  const fields = { name: legacy.name, description: legacy.prompt, draft: tokenOf(page) };
  for (const intent of ["save", "portrait"]) {
    for (const changed of [{ name: "새 이름" }, { description: "새로운 캐릭터 설명" }]) {
      const response = await admin(request("/personas/legacy", { ...fields, ...changed, intent }));
      expect(response.status).toBe(400);
      expect(await response.text()).toContain(copy.regenerateRequired);
    }
  }
  for (const path of ["/personas", "/personas/another"]) {
    const response = await admin(request(path, fields));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(copy.identityError);
  }
  expect(
    (await admin(request("/personas/legacy", { ...character, draft: await newToken(admin) })))
      .status,
  ).toBe(400);
  for (const path of [
    "/unknown",
    "/personas",
    "/personas/missing",
    "/personas/legacy/extra",
    "/prefix/personas/legacy",
  ]) {
    const missing = await admin(request(path));
    expect(missing.status).toBe(404);
    const body = await missing.text();
    expect(body).toContain('role="alert"');
    expect(body).not.toContain("persona-card");
  }
  for (const path of ["/wrong", "/style.css", "/pending.js", "/images/file.png"]) {
    const unsupported = await admin(request(path, fields));
    expect(unsupported.status).toBe(404);
    expect(await unsupported.text()).not.toContain("persona-card");
  }
  expect((await admin(request("/images/not-a-portrait.png"))).status).toBe(404);
  expect(await store.get("legacy")).toEqual(legacy);
  expect(intro).not.toHaveBeenCalled();
});

test("incomplete legacy profiles cannot reuse stale generated content or offer image-only regeneration", async () => {
  const { store, admin } = await fixture();
  for (const profile of [
    { bio: "", imageUrl: legacy.imageUrl },
    { bio: legacy.bio, imageUrl: "" },
  ]) {
    const record = { ...legacy, ...profile };
    if ((await store.list()).length) await store.update(record);
    else await store.create(record);
    const page = await (await admin(request("/personas/legacy"))).text();
    expect(page).not.toContain('value="portrait"');
    const response = await admin(
      request("/personas/legacy", {
        name: "새 이름",
        description: legacy.prompt,
        draft: tokenOf(page),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(copy.regenerateRequired);
  }
});

test("simultaneous generation and stale editors cannot duplicate or overwrite a character", async () => {
  let release: () => void = vi.fn<() => void>();
  const delayedIntroduction = vi.fn<typeof generator.introduction>().mockImplementation(
    () =>
      new Promise((resolve) => {
        release = () => resolve("공개용 소개");
      }),
  );
  const { admin, store } = await fixture({ ...generator, introduction: delayedIntroduction });
  const draft = await newToken(admin);
  const running = admin(request("/personas", { ...character, draft, intent: "generate" }));
  await vi.waitFor(() => expect(delayedIntroduction).toHaveBeenCalledTimes(1));
  expect((await admin(request("/personas", { ...character, draft, intent: "save" }))).status).toBe(
    409,
  );
  const duplicate = request("/personas", { ...character, draft, intent: "generate" });
  duplicate.headers.set("X-Image-Queue", "1");
  expect((await admin(duplicate)).status).toBe(303);
  expect(delayedIntroduction).toHaveBeenCalledTimes(1);
  release();
  const generated = await (await running).text();
  expect(
    (await admin(request("/personas", { ...character, draft: tokenOf(generated) }))).status,
  ).toBe(303);
  await store.create(legacy);
  const stale = tokenOf(await (await admin(request("/personas/legacy"))).text());
  await store.update({ ...legacy, name: "변경된 이름" });
  const rejected = await admin(
    request("/personas/legacy", {
      name: legacy.name,
      description: legacy.prompt,
      draft: stale,
      intent: "generate",
    }),
  );
  expect(rejected.status).toBe(409);
  expect(await rejected.text()).toContain(copy.stale);
  expect((await store.get("legacy")).name).toBe("변경된 이름");
  expect(delayedIntroduction).toHaveBeenCalledTimes(1);
});

test("storage outages and missing generation credentials preserve the author's work without exposing private details", async () => {
  const { store, root, admin } = await fixture();
  const draft = await newToken(admin);
  const unconfigured = createAdmin(store, "test-password", "");
  const generationFailure = await unconfigured(
    request("/personas", { ...character, draft, intent: "generate" }),
  );
  expect(generationFailure.status).toBe(503);
  const unconfiguredPage = await generationFailure.text();
  expect(unconfiguredPage).toContain(character.name);
  expect(unconfiguredPage).toContain(copy.generationUnavailable);
  await rm(root, { recursive: true });
  for (const path of ["/", "/api/personas"]) {
    const failure = await admin(request(path));
    expect(failure.status).toBe(503);
    const page = await failure.text();
    expect(page).toContain(copy.failure);
    expect(page).not.toContain(root);
    expect(page).not.toContain("ENOENT");
  }
  const failedSave = await admin(request("/personas", { ...character, draft }));
  expect(failedSave.status).toBe(503);
  expect(await failedSave.text()).toContain("독립적인 성격의 도예가");
});

test("posting to an existing private image cannot read it or trigger a management operation", async () => {
  const { admin, store } = await fixture();
  const path = await store.saveImage({
    bytes: Buffer.from("89504e470d0a1a0a", "hex"),
    mimeType: "image/png",
  });
  const response = await admin(
    request(path.replace("/discovery", ""), { ...character, draft: await newToken(admin) }),
  );
  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
});
