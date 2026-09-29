import { Clock, Effect } from "effect";

type SendStatus = "sent" | "delivered" | "failed" | "unknown";
const log = (data: object) => Effect.logInfo(`[DEBUG-ren-ai-send] ${JSON.stringify(data)}`);

/** TEMPORARY: remove after capturing one natural persona send. Never log payload values. */
export const sendDiagnostic = () => {
  let claimed = false;
  let attempt:
    | {
        readonly id: number;
        readonly handle: string;
        readonly text: string;
        readonly started: number;
        result: boolean;
        seen: boolean;
        settled: boolean;
      }
    | undefined;
  const matches = (handle: string, text: string) =>
    attempt?.handle === handle && attempt.text === text;
  const finish = (current: NonNullable<typeof attempt>) => {
    if (current.result && current.settled) attempt = undefined;
  };
  return {
    claim: (id: number, handle: string, text: string) =>
      Effect.gen(function* () {
        if (claimed) return false;
        claimed = true;
        attempt = {
          id,
          handle,
          text,
          started: yield* Clock.currentTimeMillis,
          result: false,
          seen: false,
          settled: false,
        };
        yield* log({ event: "attempt", id });
        return true;
      }),
    ack: (handle: string, text: string, response: object) =>
      Effect.gen(function* () {
        if (!matches(handle, text)) return;
        const fields = [
          "ok",
          "id",
          "guid",
          "message_id",
          "transport",
          "status",
          "service",
          "chat_guid",
        ].filter((key) => key in response);
        const ok = "ok" in response && typeof response.ok === "boolean" ? response.ok : null;
        const transport =
          "transport" in response &&
          (response.transport === "bridge" || response.transport === "applescript")
            ? response.transport
            : null;
        const status =
          "status" in response &&
          (response.status === "pending" ||
            response.status === "sent" ||
            response.status === "delivered" ||
            response.status === "failed")
            ? response.status
            : null;
        yield* log({
          event: "rpc-ack",
          id: attempt!.id,
          fields,
          ok,
          transport,
          status,
          guidPresent: "guid" in response && typeof response.guid === "string",
        });
      }),
    rpcError: (handle: string, text: string, code: number | null) =>
      matches(handle, text) ? log({ event: "rpc-error", id: attempt!.id, code }) : Effect.void,
    decodeError: (handle: string, text: string) =>
      matches(handle, text) ? log({ event: "ack-rejected", id: attempt!.id }) : Effect.void,
    result: (id: number, outcome: "success" | "failure") =>
      Effect.gen(function* () {
        if (attempt?.id !== id) return;
        yield* log({
          event: "outbox-result",
          id,
          outcome,
          elapsedMs: (yield* Clock.currentTimeMillis) - attempt.started,
        });
        attempt.result = true;
        finish(attempt);
      }),
    row: (id: number, status: SendStatus) =>
      Effect.gen(function* () {
        if (attempt?.id !== id || attempt.settled) return;
        const elapsedMs = (yield* Clock.currentTimeMillis) - attempt.started;
        if (!attempt.seen) {
          attempt.seen = true;
          yield* log({ event: "row-observed", id, elapsedMs });
        }
        if (status === "unknown") return;
        attempt.settled = true;
        yield* log({ event: "row-confirmed", id, status, elapsedMs });
        finish(attempt);
      }),
    missing: (id: number) =>
      Effect.gen(function* () {
        if (attempt?.id !== id || attempt.settled) return;
        attempt.settled = true;
        yield* log({
          event: "settled-without-row",
          id,
          elapsedMs: (yield* Clock.currentTimeMillis) - attempt.started,
        });
        finish(attempt);
      }),
  };
};

export type SendDiagnostic = ReturnType<typeof sendDiagnostic>;
