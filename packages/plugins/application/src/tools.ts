import { isDeepStrictEqual } from "node:util";
import { Schema, type JsonSchema } from "effect";
import { tapbacks } from "@ren-ai/imsg/protocol";

const definition = <A>(description: string, schema: Schema.Codec<A>) => {
  // Every input is portable across the compiled CLI's separate Effect instance.
  const standard = Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema))["~standard"];
  return { description, input: { "~standard": standard } };
};

export const messagingToolDefinitions = {
  end_conversation: definition(
    "Permanently end only this Conversation when you no longer want a relationship. Records the ending and sends your farewell plus Ren AI's reselection notice. The User can choose another persona. Do not send the farewell separately or use this for a temporary break or a declined suggestion.",
    Schema.Struct({
      farewell: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
    }),
  ),
  send: definition(
    "Send one iMessage bubble to this Conversation's User",
    Schema.Struct({ text: Schema.String }),
  ),
  wait: definition(
    "Pause for the requested seconds (up to 3300 seconds / 55 minutes), or until something new arrives. Call wait again if you still need to sleep or remain busy.",
    Schema.Struct({
      seconds: Schema.Number.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(3300)),
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
