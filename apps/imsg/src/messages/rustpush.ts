import { randomUUID } from "node:crypto";
import { Clock, Effect, Fiber, Queue, Scope } from "effect";
import type { Gestures } from "../gestures/gestures.ts";
import type { Messages } from "./messages.ts";
import type { BridgeResult } from "./bridge-protocol.ts";
import {
  BridgeRejected,
  BridgeUnavailable,
  startBridge,
  type Alerts,
  type BridgeError,
} from "./bridge.ts";
import { noIMessage, openHistory, uriOf } from "./history.ts";
import { imageData } from "./images.ts";

export interface RustpushOptions {
  /** The native bridge executable. */
  readonly command: string;
  /** The bridge's private Apple session directory. */
  readonly state: string;
  /** The gateway's message history database. */
  readonly history: string;
  /** The service handle every message and gesture is sent from. */
  readonly handle: string;
  /** How long a send waits for Apple's answer before reporting the row as in doubt. */
  readonly settleMillis?: number;
  readonly restartMillis?: number;
}

const accepted = (result: BridgeResult) => "status" in result && result.status === "sent";

/** A request the bridge never accepted was not sent; any other failure leaves it in doubt. */
const unsent = (error: BridgeError) =>
  error instanceof BridgeUnavailable ||
  (error instanceof BridgeRejected && error.stage === "input");

const query = <A>(read: () => A) => Effect.try(read);

/** Scoped adapter: keep its scope alive for as long as Messages is in use. */
export const makeRustpushMessages = (options: RustpushOptions, alerts: Alerts) =>
  Effect.gen(function* () {
    const lifetime = yield* Scope.Scope;
    const history = openHistory(options.history, options.handle);
    yield* Effect.addFinalizer(() => Effect.sync(() => history.close()));
    const service = uriOf(options.handle);
    // Followers re-read the history on each signal, so concurrent writers cannot reorder rows.
    const followers = new Set<Queue.Queue<void>>();
    const changed = Effect.forEach(followers, (signal) => Queue.offer(signal, undefined), {
      discard: true,
    });
    const bridge = yield* startBridge(
      {
        command: options.command,
        args: ["rpc", service],
        env: { RUSTPUSH_STATE_DIR: options.state },
        ...(options.restartMillis === undefined ? {} : { restartMillis: options.restartMillis }),
      },
      (message) => Effect.try(() => history.apply(message)).pipe(Effect.andThen(changed)),
      alerts,
    );
    let uncertain = 0;
    const settle = (guid: string, outcome: BridgeResult | BridgeError) =>
      Effect.gen(function* () {
        if (outcome instanceof Error || !("status" in outcome)) {
          if (outcome instanceof Error && unsent(outcome)) history.settle(guid, "failed", 1);
          else if (++uncertain >= 3)
            yield* alerts.raise("rustpush-sends", "Repeated sends in doubt");
          return;
        }
        const code = outcome.status === "failed" ? outcome.code : undefined;
        history.settle(
          guid,
          outcome.status,
          code === "no_imessage" ? noIMessage : outcome.status === "failed" ? 1 : 0,
        );
        uncertain = 0;
        yield* alerts.clear("rustpush-sends");
      });
    const gesture = (method: string, params: object) =>
      bridge.call(method, params).pipe(
        Effect.mapError((error) => new Error(error.message, { cause: error })),
        Effect.flatMap((result) =>
          accepted(result)
            ? Effect.void
            : Effect.fail(new Error(`Apple did not accept the ${method}`)),
        ),
      );
    const messages: Messages = {
      image: imageData,
      sendText: (handle, text) =>
        Effect.gen(function* () {
          const guid = randomUUID().toUpperCase();
          const now = yield* Clock.currentTimeMillis;
          yield* query(() => history.outgoing(guid, handle, text, now));
          yield* changed;
          const submit = bridge.call("send", { guid, to: uriOf(handle), text }).pipe(
            Effect.match({ onSuccess: (result) => result, onFailure: (error) => error }),
            Effect.flatMap((outcome) => settle(guid, outcome)),
          );
          const fiber = yield* Effect.forkIn(submit, lifetime);
          // The row is the authority: a slow answer leaves it pending and settles it later.
          yield* Fiber.join(fiber).pipe(Effect.timeoutOption(options.settleMillis ?? 20_000));
          return { guid };
        }),
      lastOutgoingStatus: (handle) =>
        query(() => {
          const last = history.lastOutgoing(handle);
          return last && { delivered: last.state === "delivered", readAt: last.readAt };
        }),
      after: (rowID, limit) => query(() => history.after(rowID, limit)),
      recent: (handle, since) => query(() => history.recent(handle, since)),
      status: (guid) => query(() => history.status(guid)),
      sendStatus: (guid) =>
        query(() => {
          const { state } = history.status(guid);
          return state === "pending" ? "unknown" : state;
        }),
      textStatus: (handle, since) =>
        query(() => {
          const last = history.lastOutgoing(handle, since);
          if (last?.state === "failed" && last.error === noIMessage) return "no_imessage";
          return last?.state === "sent" || last?.state === "delivered" ? "sent" : "unknown";
        }),
      follow: (rowID, receive) =>
        Effect.gen(function* () {
          const signal = yield* Queue.sliding<void>(1);
          let cursor = rowID;
          const drain = Effect.gen(function* () {
            for (const row of yield* query(() => history.after(cursor))) {
              yield* receive(row);
              cursor = row.id;
            }
          });
          followers.add(signal);
          yield* drain;
          const live = Effect.forever(
            Queue.take(signal).pipe(Effect.andThen(drain), Effect.ignore),
          );
          const fiber = yield* Effect.forkIn(live, lifetime);
          return () => {
            followers.delete(signal);
            Effect.runFork(Fiber.interrupt(fiber));
          };
        }),
    };
    const gestures: Gestures = {
      probe: () =>
        bridge.call("handles", {}).pipe(
          Effect.mapError((error) => new Error(error.message, { cause: error })),
          Effect.flatMap((result) =>
            "handles" in result && result.handles.includes(service)
              ? Effect.void
              : Effect.fail(new Error("The service handle is not registered")),
          ),
        ),
      typing: (handle, _text, durationMillis) =>
        Effect.gen(function* () {
          const before = yield* query(() => history.lastID());
          const to = uriOf(handle);
          yield* gesture("typing", { to, active: true });
          const deadline = (yield* Clock.currentTimeMillis) + durationMillis;
          for (;;) {
            if (yield* query(() => history.lastIncoming(handle, before))) {
              yield* gesture("typing", { to, active: false }).pipe(Effect.ignore);
              return false;
            }
            const remaining = deadline - (yield* Clock.currentTimeMillis);
            if (remaining <= 0) return true;
            yield* Effect.sleep(Math.min(200, remaining));
          }
        }),
      read: (handle) =>
        Effect.gen(function* () {
          const latest = yield* query(() => history.lastIncoming(handle));
          if (latest) yield* gesture("read", { to: uriOf(handle), guid: latest.guid });
        }),
      react: (handle, tapback) =>
        Effect.gen(function* () {
          const latest = yield* query(() => history.lastIncoming(handle));
          if (!latest) return yield* Effect.fail(new Error("No message to react to"));
          return yield* gesture("react", {
            to: uriOf(handle),
            guid: latest.guid,
            tapback,
            text: latest.text,
          });
        }),
    };
    return { messages, gestures };
  });
