import { Rpc } from "@opencode/plugin/rpc";
import { Schema } from "effect";

export const folderID = Schema.String.check(Schema.isPattern(/^ses[a-zA-Z0-9_-]{1,97}$/));
export const folderSnapshot = Schema.Struct({
  persona: Schema.Struct({
    id: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)),
    timeZone: Schema.String,
    language: Schema.String,
    openingLine: Schema.String,
    memory: Schema.String,
    prompt: Schema.String,
  }),
  agent: Schema.String,
  rules: Schema.String,
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
      input: portable(Schema.Struct({ folderID, snapshot: folderSnapshot, model: Schema.String })),
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
  },
  events: {
    barrier: { schema: portable(Schema.Struct({ id: Schema.String })) },
  },
});
