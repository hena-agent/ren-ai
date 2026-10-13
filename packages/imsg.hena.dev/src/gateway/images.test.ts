import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, test } from "vitest";
import { gatewayFixture } from "../../test/gateway.test-helper.ts";

test("attachments cross the Mac boundary as image bytes, never filesystem paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-images-"));
  const path = join(root, "image.png");
  await writeFile(path, Buffer.from([137, 80, 78, 71]));
  const fixture = gatewayFixture();
  try {
    await fixture.run((remote) =>
      Effect.gen(function* () {
        const row = yield* fixture.local.text("+821012345678", "photo", 100, {
          attachments: [{ path, mimeType: "image/png", uti: "public.png", missing: false }],
        });
        const [received] = yield* remote.recent(row.handle, 0);
        expect(JSON.stringify(received)).not.toContain(root);
        expect(yield* remote.image(received!.attachments![0]!)).toEqual({
          uri: "data:image/png;base64,iVBORw==",
        });
        const invalid = { ...received!.attachments![0]!, path: "/etc/passwd" };
        expect(yield* remote.image(invalid).pipe(Effect.flip)).toBeInstanceOf(Error);
        const unavailable = yield* fixture.local.text(row.handle, "unavailable", 200, {
          attachments: [
            { path: "/missing.png", mimeType: "image/png", uti: null, missing: true },
            { path: "/not-an-image", mimeType: "application/pdf", uti: null, missing: false },
          ],
        });
        const exported = (yield* remote.recent(row.handle, 200))[0]!;
        for (const attachment of exported.attachments!)
          expect((yield* remote.image(attachment).pipe(Effect.flip)).message).toBe(
            "Error: Image unavailable",
          );
        const plain = yield* fixture.local.text(row.handle, "text only", 300);
        for (const guid of ["deleted-message", plain.guid, unavailable.guid]) {
          const reference = JSON.stringify({ handle: row.handle, guid, index: 999 });
          expect(
            (yield* remote.image({ ...invalid, path: reference }).pipe(Effect.flip)).message,
          ).toBe("Error: Image unavailable");
        }
      }),
    );
  } finally {
    await fixture.server.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test.each([-1, 0.5])(
  "malformed attachment index %s is rejected as an invalid reference",
  async (index) => {
    const fixture = gatewayFixture();
    try {
      const response = await fixture.request("image", {
        reference: JSON.stringify({ handle: "handle", guid: "guid", index }),
      });
      const body = await response.text();
      expect(body).toContain("SchemaError");
      expect(body).toContain("index");
      expect(body).not.toContain("Image unavailable");
    } finally {
      await fixture.server.dispose();
    }
  },
);
