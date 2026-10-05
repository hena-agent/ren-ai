import { isDeepStrictEqual } from "node:util";
import { Schema, type JsonSchema } from "effect";
import { tapbacks } from "./protocol.ts";

const definition = <A>(description: string, schema: Schema.Codec<A>) => {
  // Every input is portable across the compiled CLI's separate Effect instance.
  const standard = Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema))["~standard"];
  return { description, input: { "~standard": standard } };
};

export const messagingToolDefinitions = {
  send: definition(
    "Send one iMessage bubble to this Conversation's User",
    Schema.Struct({ text: Schema.String }),
  ),
  wait: definition(
    "Pause for up to 55 minutes, or until something new arrives. Call wait again if you still need to sleep or remain busy.",
    Schema.Struct({
      minutes: Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(55)),
    }),
  ),
  read: definition(
    "Mark this Conversation's messages read now",
    Schema.Record(Schema.String, Schema.Never),
  ),
  react: definition(
    "React to his latest message with a standard tapback",
    Schema.Struct({ tapback: Schema.Literals(tapbacks) }),
  ),
};

export const isMessagingTool = (
  name: keyof typeof messagingToolDefinitions,
  tool: { readonly description: string; readonly input: JsonSchema.JsonSchema } | undefined,
) =>
  tool?.description === messagingToolDefinitions[name].description &&
  isDeepStrictEqual(
    tool.input,
    messagingToolDefinitions[name].input["~standard"].jsonSchema.input({ target: "draft-2020-12" }),
  );
