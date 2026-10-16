import { expect, test, vi } from "vitest";
import { durableFixture } from "../test/durable-admin.ts";
import { character, generator, newToken, request, tokenOf } from "../test/fixtures.ts";
import { loggedJob } from "./logging.ts";
import { uploadRequest } from "../test/upload-fixture.ts";

test("dismissed records stay gone after restart and replay never creates another paid image", async () => {
  const portrait = vi.fn<typeof generator.portrait>().mockImplementation(generator.portrait);
  const { open, state } = await durableFixture({ ...generator, portrait });
  let admin = open();
  const submission = request("/personas", {
    ...character,
    draft: await newToken(admin),
    intent: "generate",
  });
  const url = (await admin(submission.clone())).headers.get("location")!;
  while (admin.nextJob()) await loggedJob("test", {}, admin.runNext, () => {});
  const page = await (await admin(request(url))).text();
  const deleted = await admin(
    request(`${url}/delete`, { ...character, name: "편집한 이름", draft: tokenOf(page) }),
  );
  expect(deleted.status).toBe(200);
  const cleaned = await deleted.text();
  expect(cleaned).toContain("https://persona-images.renai.im/");
  expect(cleaned).toContain("편집한 이름");
  expect(state.saved!.queue.jobs).toHaveLength(0);
  expect(state.saved!.queue.keys).toHaveLength(1);
  admin = open();
  expect((await admin(request(url))).status).toBe(404);
  expect((await admin(submission.clone())).status).toBe(404);
  expect(portrait).toHaveBeenCalledTimes(2);
});

test("clear removes only this persona's ended records, preserves waiting work, and pending work rejects uploads or deletion", async () => {
  const { open, state } = await durableFixture();
  const admin = open();
  const submission = request("/personas", {
    ...character,
    draft: await newToken(admin),
    intent: "generate",
  });
  const url = (await admin(submission)).headers.get("location")!;
  let page = await (await admin(request(url))).text();
  expect((await admin(request(`${url}/delete`, { draft: tokenOf(page) }))).status).toBe(409);
  expect((await admin(uploadRequest(tokenOf(page)))).status).toBe(409);
  while (admin.nextJob()) await loggedJob("test", {}, admin.runNext, () => {});
  page = await (await admin(request(url))).text();
  const addition = await admin(
    request("/personas", {
      ...character,
      draft: tokenOf(page),
      intent: "subportrait",
      imageCount: "1",
    }),
  );
  // The style is part of the target URL, not an editable form field.
  expect(addition.status).toBe(400);
  const waiting = await admin(
    request("/personas?style=photo", { ...character, draft: tokenOf(page), intent: "subportrait" }),
  );
  const other = await admin(
    request("/personas", { ...character, draft: await newToken(admin), intent: "generate" }),
  );
  const waitingUrl = waiting.headers.get("location")!;
  expect(waiting.status).toBe(303);
  expect(other.status).toBe(303);
  expect((await admin(request(`${url}/clear`, { draft: tokenOf(page) }))).status).toBe(200);
  expect(state.saved!.queue.jobs).toHaveLength(2);
  expect((await admin(request(waitingUrl))).status).toBe(200);
  expect(admin.nextJob()).toBeDefined();
});

test("job mutation checks origin and persona identity and GET mutations are rejected", async () => {
  const { open } = await durableFixture();
  const admin = open();
  const url = (
    await admin(
      request("/personas", { ...character, draft: await newToken(admin), intent: "generate" }),
    )
  ).headers.get("location")!;
  const page = await (await admin(request(url))).text();
  const foreign = request(`${url}/delete`, { draft: tokenOf(page) });
  foreign.headers.set("origin", "https://foreign.example");
  expect((await admin(foreign)).status).toBe(400);
  expect((await admin(request(`${url}/delete`, { draft: await newToken(admin) }))).status).toBe(
    400,
  );
  expect((await admin(request(`${url}/clear`))).status).toBe(404);
});
