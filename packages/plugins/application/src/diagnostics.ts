import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Tool } from "@opencode/schema/tool";

export const conversationOperation = <A>(
  operation: string,
  sessionID: string,
  run: () => Promise<A>,
  callID?: string,
) => {
  const started = performance.now();
  const requestID = randomUUID();
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      cause instanceof Error ? cause : new Error("Non-Error Conversation failure"),
  }).pipe(
    // Filesystem promises cannot be cancelled; finish them before releasing the native scope.
    Effect.uninterruptible,
    Effect.catch((error) => {
      const root = error.cause instanceof Error ? error.cause : error;
      const code =
        "code" in root && typeof root.code === "string" && /^[A-Z0-9_-]{1,80}$/.test(root.code)
          ? root.code
          : "conversation_operation_failed";
      const log = code === "ADJUSTMENT_REVIEW_CONFLICT" ? Effect.logWarning : Effect.logError;
      return log("Conversation operation failed").pipe(
        Effect.annotateLogs({
          operation,
          sessionID,
          ...(callID && { callID }),
          code,
          requestID,
          outcome: "failed",
          causeName: root.constructor.name,
          stack:
            (Schema.isSchemaError(root) ? error.stack : root.stack)
              ?.split("\n")
              .filter((line) => /^\s+at .*(?:\.(?:ts|js|mjs):\d+:\d+|node:.*:\d+:\d+)/.test(line))
              .join("\n")
              .slice(0, 4000) ?? "",
          durationMs: performance.now() - started,
        }),
        Effect.andThen(
          Effect.fail(
            new Error(`Conversation ${operation} failed (${code}; request ID: ${requestID})`, {
              cause: error,
            }),
          ),
        ),
      );
    }),
  );
};

export const conversationTool = (
  operation: string,
  sessionID: string,
  callID: string,
  run: () => Promise<string>,
) =>
  conversationOperation(operation, sessionID, run, callID).pipe(
    Effect.map((output) => ({ output, content: output })),
    Effect.mapError((error) => new Tool.Error({ message: error.message })),
  );
