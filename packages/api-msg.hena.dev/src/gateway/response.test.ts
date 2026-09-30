import { Effect, Schema } from "effect";
import { expect, test } from "vitest";
import { gatewayFixture } from "../../test/gateway.test-helper.ts";

const row = { id: 1, guid: "guid", handle: "handle", createdAt: 100, text: "text", fromMe: false };

test.each([
  { tag: "after", value: [{ id: 1 }] },
  {
    tag: "after",
    value: [
      { ...row, attachments: [{ path: "opaque", mimeType: null, uti: null, missing: "false" }] },
    ],
  },
  { tag: "after", value: [{ ...row, tapback: { emoji: 1, targetGuid: "guid", added: true } }] },
  { tag: "image", value: { uri: 1 } },
  { tag: "sendText", value: { guid: 1 } },
  { tag: "status", value: { state: "sent", error: "0", dateRead: null } },
  { tag: "lastOutgoingStatus", value: { delivered: "true", readAt: null } },
] as const)(
  "the client rejects malformed $tag results received over HTTP",
  async ({ tag, value }) => {
    const fixture = gatewayFixture();
    fixture.transport.fetch = async (request) => {
      const { id } = Schema.decodeUnknownSync(
        Schema.fromJsonString(Schema.Struct({ id: Schema.Number })),
      )(await request.text());
      return new Response(
        `${JSON.stringify({ _tag: "Exit", requestId: id, exit: { _tag: "Success", value } })}\n`,
      );
    };
    try {
      await expect(
        fixture.run((remote) => {
          const requests = {
            after: remote.after(0).pipe(Effect.asVoid),
            image: remote
              .image({ path: "opaque", mimeType: null, uti: null, missing: false })
              .pipe(Effect.asVoid),
            sendText: remote.sendText("handle", "text").pipe(Effect.asVoid),
            status: remote.status("guid").pipe(Effect.asVoid),
            lastOutgoingStatus: remote.lastOutgoingStatus("handle").pipe(Effect.asVoid),
          };
          return requests[tag];
        }),
      ).rejects.toThrow(/Expected|Missing/);
    } finally {
      await fixture.server.dispose();
    }
  },
);
