import { Deferred, Effect } from "effect";
import { expect, test } from "vitest";
import { gatewayFixture } from "../../test/gateway.test-helper.ts";
import type { IncomingMessage } from "../messages/messages.ts";

test.each(["love", "like", "dislike", "laugh", "emphasis", "question"])(
  "the public API preserves the %s tapback",
  async (tapback) => {
    const fixture = gatewayFixture();
    try {
      await fixture.run((remote) => remote.gestures.react("+821012345678", tapback));
      expect(fixture.gestures.reactions).toEqual([{ handle: "+821012345678", tapback }]);
    } finally {
      await fixture.server.dispose();
    }
  },
);

test.each(["sent", "delivered", "failed", "unknown"] as const)(
  "the API preserves the %s delivery outcome",
  async (state) => {
    const fixture = gatewayFixture();
    try {
      await fixture.run((remote) =>
        Effect.gen(function* () {
          const row = yield* fixture.local.outgoing(
            "+821012345678",
            "queued",
            100,
            state,
            "outgoing-guid",
          );
          expect(yield* remote.sendStatus(row.guid)).toBe(state);
          expect(yield* remote.status(row.guid)).toEqual({
            state: state === "unknown" ? "pending" : state,
            error: 0,
            dateRead: null,
          });
          expect(yield* remote.after(0)).toEqual([row]);
          fixture.local.status(row.handle, { delivered: true, readAt: 1234 });
          expect(yield* remote.lastOutgoingStatus(row.handle)).toEqual({
            delivered: true,
            readAt: 1234,
          });
        }),
      );
    } finally {
      await fixture.server.dispose();
    }
  },
);

test.each(["sent", "no_imessage", "unknown"] as const)(
  "the API preserves the %s text-send outcome",
  async (state) => {
    const fixture = gatewayFixture();
    fixture.local.statuses.set("+821012345678", state);
    try {
      await fixture.run((remote) =>
        Effect.gen(function* () {
          expect(yield* remote.textStatus("+821012345678", 100)).toBe(state);
        }),
      );
    } finally {
      await fixture.server.dispose();
    }
  },
);

test.each([
  ["after", { rowID: -1 }],
  ["after", { rowID: 0.5 }],
  ["follow", { rowID: -1, date: null }],
  ["follow", { rowID: 0.5, date: null }],
  ["typing", { handle: "handle", text: "draft", durationMillis: -1 }],
  ["typing", { handle: "handle", text: "draft", durationMillis: 15001 }],
  ["react", { handle: "handle", tapback: "unsupported" }],
  ["recent", { handle: "handle" }],
  ["recent", { handle: 1, since: 0 }],
  ["textStatus", { handle: "handle", since: "yesterday" }],
  ["status", {}],
  ["sendStatus", { guid: 1 }],
  ["sendText", { handle: "handle" }],
  ["sendText", { handle: 1, text: "text" }],
  ["follow", { rowID: 0, date: "yesterday" }],
  ["image", { reference: 1 }],
  ["read", { handle: 1 }],
  ["lastOutgoingStatus", {}],
  ["react", { handle: 1, tapback: "like" }],
])("the HTTP trust boundary rejects invalid %s payloads", async (tag, payload) => {
  const fixture = gatewayFixture();
  try {
    const response = await fixture.request(tag, payload);
    expect(await response.text()).toContain('"_tag":"Failure"');
    expect(fixture.local.bubbles).toEqual([]);
    expect(fixture.gestures.typing).toEqual([]);
    expect(fixture.gestures.reactions).toEqual([]);
  } finally {
    await fixture.server.dispose();
  }
});

test.each([0, 15000])(
  "typing accepts the documented duration boundary %i",
  async (durationMillis) => {
    const fixture = gatewayFixture();
    try {
      const response = await fixture.request("typing", {
        handle: "handle",
        text: "draft",
        durationMillis,
      });
      expect(await response.text()).toContain('"_tag":"Success","value":true');
      expect(fixture.gestures.typing).toEqual([{ handle: "handle", durationMillis }]);
    } finally {
      await fixture.server.dispose();
    }
  },
);

test("an invalid image request identifies the reference argument in its HTTP validation error", async () => {
  const fixture = gatewayFixture();
  try {
    const response = await fixture.request("image", { reference: 1 });
    const body = await response.text();
    expect(body).toContain('"_tag":"Failure"');
    expect(body).toContain("reference");
  } finally {
    await fixture.server.dispose();
  }
});

test("history and live streams preserve rich Messages metadata without revealing local attachment paths", async () => {
  const fixture = gatewayFixture();
  try {
    await fixture.run((remote) =>
      Effect.gen(function* () {
        const source = yield* fixture.local.text("+821012345678", "photo reply", 100, {
          attachments: [
            {
              path: "/private/Messages/image.heic",
              mimeType: null,
              uti: "public.heic",
              missing: false,
            },
          ],
          tapback: { emoji: "❤️", targetGuid: "prior-guid", added: false },
          replyToGuid: "reply-guid",
          payload: "location",
        });
        const expected = {
          ...source,
          attachments: [
            {
              path: JSON.stringify({ handle: source.handle, guid: source.guid, index: 0 }),
              mimeType: null,
              uti: "public.heic",
              missing: false,
            },
          ],
        };
        expect(yield* remote.after(0)).toEqual([expected]);
        expect(yield* remote.recent(source.handle, 100)).toEqual([expected]);
        const next = yield* Deferred.make<IncomingMessage>();
        const stop = yield* remote.follow(0, (row) =>
          Deferred.succeed(next, row).pipe(Effect.asVoid),
        );
        expect(yield* Deferred.await(next).pipe(Effect.timeout("2 seconds"))).toEqual(expected);
        stop();
        const app = yield* fixture.local.text(source.handle, "app", 101, { payload: "app" });
        expect(yield* remote.recent(source.handle, 101)).toEqual([app]);
      }),
    );
  } finally {
    await fixture.server.dispose();
  }
});
