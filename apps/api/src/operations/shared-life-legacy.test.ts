import { Effect, Schema } from "effect";
import { Session } from "@opencode/schema/session";
import { expect, test } from "vitest";
import { renderSnapshot } from "@ren-ai/plugin-session-folder/files";
import { sessionFolders } from "@ren-ai/plugin-session-folder/protocol";
import { legacySession, withTransferClient } from "../../test/operations-transfer.test-helper.ts";
import { runSharedLifeCutover } from "./shared-life-cutover.ts";
import { sharedLifePlan } from "./shared-life-plan.ts";
import { exportLocation } from "./session-transfer.ts";
import { sessionArchive } from "../opencode/transfer-format.ts";

test.each([true, false])(
  "cutover preserves unscoped operator sessions and a retired persona (explicit agent: %s)",
  (explicitAgent) =>
    withTransferClient(({ client, root, personas }) =>
      Effect.gen(function* () {
        const retired = yield* legacySession(client, root);
        const operator = yield* legacySession(client, root, "build");
        const before = yield* client.session.export({ sessionID: operator.id, sanitize: false });
        const folder = {
          ...renderSnapshot(personas.get("persona1")!, "old-rules"),
          runtime: {
            state: { affection: 73, mood: 25 },
            additional: {},
            shortTerm: "Retained private fact",
            longTerm: [],
            receipts: {},
          },
        };
        const input = {
          directory: root,
          archive: JSON.stringify({
            version: 1,
            sessions: [
              { info: Schema.encodeSync(Session.Info)(retired), pending: [], folder },
              {
                info: {
                  ...Schema.encodeSync(Session.Info)(operator),
                  agent: explicitAgent ? operator.agent : undefined,
                },
                pending: [],
              },
            ],
          }),
          application: JSON.stringify({ version: 1, tables: [] }),
          personas: new Map(),
          confirmation: "yes",
        };
        yield* runSharedLifeCutover(client, input);
        yield* runSharedLifeCutover(client, input);
        const saved = yield* client
          .rpc(sessionFolders)
          .read({ folderID: retired.id }, { location: { directory: root } });
        expect(saved.binding).toMatchObject({ writable: false, conversationKey: retired.id });
        expect(saved.relationship?.shortTerm).toBe("Retained private fact");
        expect(saved.relationship?.state).toEqual({ affection: 73, mood: 25 });
        expect(saved.runtime?.shortTerm).toBe("");
        expect(saved.runtime?.state).toBeUndefined();
        expect(saved.documents?.memory).toBe("");
        expect(saved.documents?.state).not.toContain("affection");
        expect(saved.persona).toEqual(folder.persona);
        expect(yield* client.session.export({ sessionID: operator.id, sanitize: false })).toEqual(
          before,
        );
        const exported = Schema.decodeUnknownSync(sessionArchive)(
          yield* exportLocation(client, root),
        );
        expect(exported.sessions.map((entry) => entry.info.id)).toEqual([retired.id]);
        expect(exported.personas).toHaveLength(1);
        expect(exported.personas[0]?.relationships[retired.id]?.shortTerm).toBe(
          "Retained private fact",
        );
      }),
    ),
);

test.each([true, false])(
  "missing persona folders are rejected (application binding: %s)",
  (bound) =>
    withTransferClient(({ client, root, personas }) =>
      Effect.gen(function* () {
        const session = yield* legacySession(client, root);
        const archive = JSON.stringify({
          version: 1,
          sessions: [
            {
              info: Schema.encodeSync(Session.Info)(session),
              pending: [],
            },
          ],
        });
        const application = JSON.stringify({
          version: 1,
          tables: bound
            ? [
                {
                  name: "conversation",
                  columns: ["session_id", "persona_id", "usage_key", "ended_at"],
                  rows: [[session.id, "persona1", "key", null]],
                },
              ]
            : [],
        });
        expect(() => sharedLifePlan(archive, application, personas, "rules")).toThrow(
          "missing its archived folder",
        );
      }),
    ),
);
