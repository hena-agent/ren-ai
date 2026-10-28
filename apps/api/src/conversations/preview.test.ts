import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { remoteMessages } from "@ren-ai/imsg/client";
import { expect, test, vi } from "vitest";
import { relationshipFixture } from "../../test/relationship.test-helper.ts";
import { withContactDatabase } from "../discovery/contact.test-helper.ts";
import { conversationImageRequest } from "./preview.ts";

test("previews authorize a confirmed send by Conversation, row, guid and attachment before reading bytes", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const f = yield* relationshipFixture;
      const id = f.conversation.id;
      yield* f.sql`UPDATE conversation SET started_at = 1 WHERE id = ${id}`;
      const context = yield* Effect.context<SqlClient.SqlClient>();
      const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
        Effect.runPromise(Effect.provideContext(effect, context));
      const row = {
        id: 10,
        guid: "photo-guid",
        handle: f.conversation.handle,
        createdAt: 10,
        text: "",
        fromMe: true,
        status: { state: "sent" as const, error: 0, dateRead: null },
        attachments: [
          { path: "/private/image.png", mimeType: "image/png", uti: null, missing: false },
        ],
      };
      const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
      const uri = `data:image/png;base64,${bytes.toString("base64")}`;
      const history = vi.fn<Effect.Success<ReturnType<typeof remoteMessages>>["history"]>(() =>
        Effect.succeed([row]),
      );
      const image = vi.fn<Effect.Success<ReturnType<typeof remoteMessages>>["image"]>(() =>
        Effect.succeed({ uri }),
      );
      const call = (query = `id=${id}&message=10&guid=photo-guid&attachment=0`, method = "GET") =>
        Effect.promise(() =>
          conversationImageRequest(
            new Request(`https://api.test/operator/message-image?${query}`, { method }),
            { history, image },
            run,
          ),
        );
      for (const query of [
        "",
        "id=1&message=1&guid=x",
        "id=-1&message=1&guid=x&attachment=0",
        "id=1.1&message=1&guid=x&attachment=0",
        "id=1&message=0&guid=x&attachment=0",
        "id=1&message=1.2&guid=x&attachment=0",
        "id=1&message=9007199254740991&guid=x&attachment=0",
        "id=1&message=1&guid=x&attachment=-1",
        "id=1&message=1&guid=x&attachment=1.1",
        "id=1&message=1&attachment=0",
      ])
        expect((yield* call(query)).status).toBe(400);
      expect((yield* call(undefined, "POST")).status).toBe(405);
      for (const query of [
        `id=999&message=10&guid=photo-guid&attachment=0`,
        `id=${id}&message=10&guid=other&attachment=0`,
        `id=${id}&message=9&guid=photo-guid&attachment=0`,
        `id=${id}&message=10&guid=photo-guid&attachment=1`,
      ])
        expect((yield* call(query)).status).toBe(404);
      for (const state of ["pending", "failed"] as const) {
        history.mockImplementationOnce(() =>
          Effect.succeed([{ ...row, status: { ...row.status, state } }]),
        );
        expect((yield* call()).status).toBe(404);
      }
      history.mockImplementationOnce(() => Effect.succeed([{ ...row, fromMe: false }]));
      expect((yield* call()).status).toBe(404);
      history.mockImplementationOnce(() => Effect.succeed([{ ...row, status: null }]));
      expect((yield* call()).status).toBe(404);
      for (const attachment of [
        { ...row.attachments[0]!, missing: true },
        { ...row.attachments[0]!, mimeType: "text/plain" },
        { ...row.attachments[0]!, mimeType: null },
      ]) {
        history.mockImplementationOnce(() =>
          Effect.succeed([{ ...row, attachments: [attachment] }]),
        );
        expect((yield* call()).status).toBe(404);
      }
      const { attachments: _attachments, ...textRow } = row;
      history.mockImplementationOnce(() => Effect.succeed([textRow]));
      expect((yield* call()).status).toBe(404);
      expect(image).not.toHaveBeenCalled();
      const result = yield* call();
      expect(result.status).toBe(200);
      expect(result.headers.get("cache-control")).toBe("no-store");
      expect(result.headers.get("content-type")).toBe("image/png");
      expect(yield* Effect.promise(() => result.arrayBuffer())).toEqual(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      );
      expect(history).toHaveBeenLastCalledWith({
        handle: f.conversation.handle,
        since: 1,
        until: null,
        before: 11,
      });
      expect(image).toHaveBeenCalledWith(row.attachments[0]);
      yield* f.sql`INSERT INTO send (handle, conversation_id, kind, content, state, guid, recorded_at, updated_at) VALUES (${f.conversation.handle}, NULL, 'text', '', 'sent', 'photo-guid', 1, 1)`;
      expect((yield* call()).status).toBe(404);
      expect(image).toHaveBeenCalledTimes(1);
      yield* f.sql`DELETE FROM send WHERE guid = 'photo-guid'`;
      history.mockImplementationOnce(() =>
        Effect.succeed([{ ...row, status: { ...row.status, state: "delivered" } }]),
      );
      expect((yield* call()).status).toBe(200);
      for (const [mimeType, signature] of [
        ["image/jpeg", "ffd8ff"],
        ["image/webp", "524946460000000057454250"],
      ] as const) {
        image.mockImplementationOnce(() =>
          Effect.succeed({
            uri: `data:${mimeType};base64,${Buffer.from(signature, "hex").toString("base64")}`,
          }),
        );
        expect((yield* call()).headers.get("content-type")).toBe(mimeType);
      }
      for (const invalid of [
        "https://external.test/image.png",
        "data:text/html;base64,YQ==",
        "data:image/png;base64,YQ==",
        `data:image/jpeg;base64,${"A".repeat(26_666_672)}`,
      ]) {
        image.mockImplementationOnce(() => Effect.succeed({ uri: invalid }));
        expect((yield* call()).status).toBe(503);
      }
    }),
  );
});
