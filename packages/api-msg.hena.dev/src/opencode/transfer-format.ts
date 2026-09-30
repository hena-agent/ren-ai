import { Session } from "@opencode/schema/session";
import { SessionMessage } from "@opencode/schema/session-message";
import { SessionInbox } from "@opencode/schema/session-inbox";
import { Schema } from "effect";

export const sessionArchive = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    sessions: Schema.Array(
      Schema.Struct({
        info: Session.Info,
        messages: Schema.Array(SessionMessage.Info),
        pending: Schema.Array(SessionInbox.Info),
        recovery: Schema.optionalKey(
          Schema.Struct({
            id: SessionMessage.ID,
            tools: Schema.Array(
              Schema.Struct({
                callID: Schema.String,
                tool: Schema.String,
                state: SessionMessage.ToolState,
              }),
            ),
          }),
        ),
      }),
    ),
  }),
);
