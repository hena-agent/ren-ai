import { notSent } from "../transcript/transcript.ts";
import { Effect, Option } from "effect";
import { HttpServerRequest } from "effect/unstable/http";
import { contactLog } from "../discovery/diagnostics.ts";

/** Return a corrective tool result without changing the installed plugin's input schema. */
export const bubbleRejection = (text: string, personaId: string) =>
  Effect.gen(function* () {
    const started = performance.now();
    if (text.trim() && Array.from(text).length <= 120 && !/\n\s*\n/.test(text)) return undefined;
    const request = yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest);
    const requestId =
      Option.getOrUndefined(request)?.headers["x-operation-id"] ?? crypto.randomUUID();
    contactLog({
      requestId,
      operation: "send",
      stage: "bubble.validate",
      outcome: "failed",
      level: "warn",
      code: "invalid_bubble",
      personaId,
      durationMs: performance.now() - started,
    });
    return notSent(
      `one bubble must contain 1–120 Unicode characters and no blank lines. Nothing was sent. Rewrite into short, natural bubbles and call send({ text }) sequentially for each. Use wait between sends only when a pause fits your texting style. Do not repeat any previously successful sends. Request ${requestId}.`,
    );
  });
