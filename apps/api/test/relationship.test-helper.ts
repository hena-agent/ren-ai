import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { fromPartial } from "@total-typescript/shoehorn";
import type { Persona } from "@ren-ai/personas";
import { fakeGestures, fakeMessages } from "@ren-ai/imsg/testing";
import { prepareMessaging } from "../src/application-tools.ts";
import { conversationEndings } from "../src/conversations/end.ts";
import type { ContactDiagnostic } from "../src/discovery/diagnostics.ts";

export const relationshipFixture = Effect.gen(function* () {
  const fake = fakeMessages();
  const ui = fakeGestures();
  const personas = new Map([
    ["seoyul", fromPartial<Persona>({ id: "seoyul", timeZone: "Asia/Seoul" })],
  ]);
  const app = yield* prepareMessaging(personas, fake.messages, ui.gestures);
  const sql = yield* SqlClient.SqlClient;
  const conversation = yield* app.directory.create({
    handle: "private@example.com",
    locale: "ko",
    consentLanguage: "ko",
    consentVersion: "v1",
    personaID: "seoyul",
    sessionID: "ses_seoyul",
  });
  const logs: ContactDiagnostic[] = [];
  const ending = yield* conversationEndings(
    app.directory,
    app.sends,
    fake.messages,
    ui.gestures,
    personas,
    (event) => logs.push(event),
  );
  return { fake, ui, personas, app, sql, conversation, logs, ending };
});
