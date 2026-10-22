import { Rpc } from "@opencode/plugin/rpc";
import { Schema } from "effect";
import { runtimeSnapshot } from "./memory-model.ts";

export const folderID = Schema.String.check(Schema.isPattern(/^ses[a-zA-Z0-9_-]{1,97}$/));
export const personaID = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/));
export const conversationKey = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/));
export const sessionBinding = Schema.Struct({
  personaID,
  conversationKey,
  writable: Schema.Boolean,
});
export const folderSnapshot = Schema.Struct({
  persona: Schema.Struct({
    id: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)),
    version: Schema.optionalKey(
      Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
    ),
    timeZone: Schema.String,
    language: Schema.String,
    openingLine: Schema.String,
    memory: Schema.String,
    prompt: Schema.String,
  }),
  agent: Schema.String,
  rules: Schema.String,
  documents: Schema.optionalKey(Schema.Struct({ state: Schema.String, memory: Schema.String })),
  runtime: Schema.optionalKey(runtimeSnapshot),
  binding: Schema.optionalKey(sessionBinding),
  relationship: Schema.optionalKey(runtimeSnapshot),
});
export const personaFolderSnapshot = Schema.Struct({
  snapshot: folderSnapshot,
  bindings: Schema.Record(folderID, sessionBinding),
  relationships: Schema.Record(conversationKey, runtimeSnapshot),
  sandboxID: Schema.optionalKey(folderID),
});
// The compiled OpenCode CLI owns a different Effect instance.
const portable = <T>(schema: Schema.Codec<T>) => ({
  "~standard": Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema))["~standard"],
});
const failure = { failed: portable(Schema.String) };
export const sessionFolders = Rpc.define({
  id: "ren-ai.session-folders",
  methods: {
    create: {
      input: portable(
        Schema.Struct({
          folderID,
          snapshot: folderSnapshot,
          model: Schema.String,
          conversationKey: Schema.optionalKey(conversationKey),
          writable: Schema.optionalKey(Schema.Boolean),
        }),
      ),
      output: portable(Schema.String),
      errors: failure,
    },
    update: {
      input: portable(Schema.Struct({ folderID, snapshot: folderSnapshot })),
      output: portable(Schema.String),
      errors: failure,
    },
    ensure: {
      input: portable(Schema.Struct({ folderID })),
      output: portable(Schema.String),
      errors: failure,
    },
    write: {
      input: portable(Schema.Struct({ folderID, snapshot: folderSnapshot })),
      output: portable(Schema.String),
      errors: failure,
    },
    read: {
      input: portable(Schema.Struct({ folderID })),
      output: portable(folderSnapshot),
      errors: failure,
    },
    remove: {
      input: portable(Schema.Struct({ folderID })),
      output: portable(Schema.Null),
      errors: failure,
    },
    writable: {
      input: portable(Schema.Struct({ folderID, writable: Schema.Boolean })),
      output: portable(Schema.Null),
      errors: failure,
    },
    removeRelationship: {
      input: portable(Schema.Struct({ personaID, conversationKey })),
      output: portable(Schema.Null),
      errors: failure,
    },
    snapshot: {
      input: portable(Schema.Struct({ folderID })),
      output: portable(personaFolderSnapshot),
      errors: failure,
    },
    inventory: {
      input: portable(Schema.Struct({})),
      output: portable(Schema.Array(personaFolderSnapshot)),
      errors: failure,
    },
    restore: {
      input: portable(Schema.Struct({ snapshot: personaFolderSnapshot })),
      output: portable(Schema.String),
      errors: failure,
    },
  },
  events: {
    barrier: { schema: portable(Schema.Struct({ id: Schema.String })) },
  },
});
