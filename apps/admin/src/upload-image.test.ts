import { expect, test, vi } from "vitest";
import {
  fixture,
  newToken,
  request,
  tokenOf,
  character,
  png,
  idOf,
  authorization,
} from "../test/fixtures.ts";
import { croppedPng, uploadRequest } from "../test/upload-fixture.ts";
import { draftTokens, previewOf } from "./draft.ts";
import { emptyPersona } from "./authoring.ts";
import { personaImages } from "@ren-ai/personas";

const tokens = draftTokens("test-password");
const photos = (markup: string) =>
  personaImages(previewOf(tokens.decode(tokenOf(markup)), emptyPersona));

test("upload adds and replaces independent photos privately, preserving documents and publication until save", async () => {
  const { admin, store, logs } = await fixture();
  const first = await admin(uploadRequest(await newToken(admin)));
  expect(first.status).toBe(200);
  let markup = await first.text();
  const original = photos(markup)[0]!.imageUrl;
  expect(await store.publicList()).toEqual([]);
  markup = await (await admin(uploadRequest(tokenOf(markup), "style=anime"))).text();
  expect(photos(markup)).toHaveLength(2);
  markup = await (await admin(uploadRequest(tokenOf(markup), "style=photo"))).text();
  const before = photos(markup);
  markup = await (
    await admin(uploadRequest(tokenOf(markup), `style=photo&image=${encodeURIComponent(original)}`))
  ).text();
  expect(photos(markup).filter((image) => image.imageUrl === original)).toHaveLength(0);
  expect(photos(markup).filter((image) => image.style === "anime")).toEqual(
    before.filter((image) => image.style === "anime"),
  );
  expect(photos(markup)).toHaveLength(3);
  const saved = await admin(
    request("/personas", { ...character, draft: tokenOf(markup), intent: "save" }),
  );
  expect(saved.status).toBe(303);
  expect(personaImages(await store.get(idOf(saved)))).toHaveLength(3);
  const diagnostic = JSON.stringify(logs);
  expect(diagnostic).toContain("image.upload.save");
  expect(diagnostic).not.toContain(character.description);
  expect(diagnostic).not.toContain(tokenOf(markup));
});

test("uploads enforce type, file signatures, size and a real 4:5 cropped image at the request boundary", async () => {
  const { admin } = await fixture();
  const token = await newToken(admin);
  const bad = [
    "no file",
    new Blob([croppedPng()], { type: "image/gif" }),
    new Blob(["not png"], { type: "image/png" }),
    new Blob([png], { type: "image/png" }),
    new Blob([new Uint8Array(20_000_001)], { type: "image/png" }),
    new Blob([Buffer.from("89504e470d0a1a0a", "hex")], { type: "image/png" }),
  ];
  for (const image of bad)
    expect((await admin(uploadRequest(token, "style=photo", image))).status).toBe(400);
  const missing = uploadRequest(token);
  const data = await missing.formData();
  data.delete("image");
  missing.headers.delete("content-type");
  expect(
    (
      await admin(
        new Request(missing.url, { method: "POST", headers: missing.headers, body: data }),
      )
    ).status,
  ).toBe(400);
  expect((await admin(uploadRequest(token, "style=invalid"))).status).toBe(400);
  expect((await admin(uploadRequest(token, "style=photo&image=missing"))).status).toBe(400);
  expect(
    (
      await admin(
        new Request("http://localhost:3729/upload-image", {
          method: "POST",
          headers: {
            authorization,
            origin: "http://localhost:3729",
            "content-type": "multipart/form-data",
          },
          body: "broken multipart",
        }),
      )
    ).status,
  ).toBe(400);
});

test("an anime-only upload becomes the main photo without requiring an AI call", async () => {
  const { admin } = await fixture();
  const response = await admin(uploadRequest(await newToken(admin), "style=anime"));
  expect(response.status).toBe(200);
  expect(photos(await response.text())).toMatchObject([{ style: "anime" }]);
});

test("uploads reject stale previews, full styles, cross-origin, unauthenticated and non-POST requests", async () => {
  const { admin } = await fixture();
  const token = await newToken(admin);
  let markup = await (await admin(uploadRequest(token))).text();
  expect((await admin(uploadRequest(token))).status).toBe(409);
  for (let index = 1; index < 6; index++)
    markup = await (await admin(uploadRequest(tokenOf(markup)))).text();
  expect((await admin(uploadRequest(tokenOf(markup)))).status).toBe(400);
  const foreign = uploadRequest(tokenOf(markup));
  foreign.headers.set("origin", "https://foreign.example");
  expect((await admin(foreign)).status).toBe(400);
  const anonymous = uploadRequest(tokenOf(markup));
  anonymous.headers.delete("authorization");
  expect((await admin(anonymous)).status).toBe(401);
  expect(
    (await admin(new Request("http://localhost:3729/upload-image", { headers: { authorization } })))
      .status,
  ).toBe(404);
});

test("storage failures are correlated and uploads cannot change photos while generation is pending", async () => {
  const { admin, store, logs } = await fixture();
  const token = await newToken(admin);
  vi.spyOn(store, "saveImage").mockRejectedValueOnce(new Error("storage unavailable"));
  const response = await admin(uploadRequest(token));
  expect(response.status).toBe(503);
  expect(await response.text()).toContain(response.headers.get("x-request-id")!);
  expect(
    logs.some((entry) => entry.stage === "image.upload.save" && entry.event === "operation.failed"),
  ).toBe(true);
});
