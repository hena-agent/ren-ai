import {
  normalizeHandle,
  OnboardingRequest,
  WaitlistRequest,
  notice as localeNotice,
} from "@ren-ai/onboarding";
import { Clock, Effect, Layer, Option, Schedule, Semaphore } from "effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
} from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { onboardingApi } from "./api.ts";
import { SqlClient } from "effect/unstable/sql";
import type { Messages } from "../messages/messages.ts";
import type { Persona } from "../personas/personas.ts";
import { conversationStarted } from "../transcript/transcript.ts";
import { submissionLimit } from "./rate-limit.ts";
import { withLifecycle } from "../conversations/lifecycle.ts";

export const noticeCopy = { ko: localeNotice.ko.text };

interface UserRow {
  readonly joined_at: number | null;
  readonly persona_id: string | null;
}

interface NoticeRow {
  readonly id: number;
  readonly recorded_at: number;
  readonly state: string;
}

interface CountRow {
  readonly count: number;
}

interface GreetingRow {
  readonly persona_id: string;
  readonly session_id: string;
  readonly started_at: number;
}

export const verifyTurnstile = (token: string, secret: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* HttpClientRequest.post(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    ).pipe(HttpClientRequest.bodyUrlParams({ secret, response: token }), client.execute);
    if (response.status !== 200) return false;
    const body = yield* response.json;
    return (
      typeof body === "object" && body !== null && "success" in body && body["success"] === true
    );
  });

export const onboarding = <SessionError, PromptError, NoticeError>({
  messages,
  notice,
  personas,
  defaultPersonaID = "Persona1",
  createSession,
  prompt,
  sendNotice,
  turnstileSecret,
  deadlineMillis = 10_000,
  userCap = 10,
  noticeVersion = localeNotice.ko.version,
}: {
  messages: Messages;
  notice: Readonly<Record<"ko", string>>;
  personas: ReadonlyMap<string, Persona>;
  defaultPersonaID?: string;
  createSession: (personaID: string) => Effect.Effect<{ readonly id: string }, SessionError>;
  prompt: (sessionID: string, text: string) => Effect.Effect<void, PromptError>;
  sendNotice: (handle: string, text: string) => Effect.Effect<void, NoticeError>;
  turnstileSecret: string;
  deadlineMillis?: number;
  userCap?: number | undefined;
  noticeVersion?: string | undefined;
}) => {
  const greet = (sessionID: string, started: number, persona: Persona) =>
    prompt(
      sessionID,
      conversationStarted(started, persona.openingLine, notice.ko, persona.timeZone),
    ).pipe(Effect.retry(Schedule.spaced("250 millis")));
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const admission = Semaphore.makeUnsafe(1);
    const limitIP = submissionLimit();

    const waitlist = (input: typeof WaitlistRequest.Type) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* sql`INSERT INTO waitlist (email, locale, answer, created_at)
          VALUES (${input.email}, ${input.locale}, ${input.answer}, ${now})`;
      });

    const user = (handle: string) =>
      sql<UserRow>`SELECT joined_at, persona_id FROM user WHERE handle = ${handle}`;
    const unavailable = (handle: string) =>
      Effect.map(
        sql`SELECT handle FROM blocked WHERE handle = ${handle}
          UNION SELECT handle FROM removal WHERE handle = ${handle}
          UNION SELECT handle FROM reset WHERE handle = ${handle} AND complete = 0`,
        (rows) => rows.length > 0,
      );
    const currentNotice = sql`send.id > COALESCE((SELECT MAX(notice_id) FROM reset WHERE reset.handle = send.handle), 0)`;
    const latest = (handle: string) => sql<NoticeRow>`SELECT id, recorded_at, state FROM send
    WHERE handle = ${handle} AND kind = 'notice' AND ${currentNotice} ORDER BY id DESC LIMIT 1`;

    const settle = (handle: string, row: NoticeRow) =>
      Effect.gen(function* () {
        const status = yield* messages.textStatus(handle, row.recorded_at);
        if (status === "unknown") return undefined;
        if (status === "no_imessage") {
          yield* withLifecycle(
            Effect.gen(function* () {
              yield* sql`UPDATE send SET state = 'failed', updated_at = ${yield* Clock.currentTimeMillis} WHERE id = ${row.id}`;
              yield* sql`DELETE FROM user WHERE handle = ${handle} AND joined_at IS NULL`;
            }),
          );
          return undefined;
        }
        const prepared = yield* withLifecycle(
          Effect.gen(function* () {
            if (yield* unavailable(handle)) return undefined;
            const [pending] = yield* user(handle);
            if (!pending || pending.joined_at !== null) return undefined;
            const persona = personas.get(pending.persona_id ?? defaultPersonaID);
            if (!persona) return yield* Effect.fail(new Error("Selected persona is missing"));
            const started = yield* Clock.currentTimeMillis;
            const session = yield* createSession(persona.id);
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`UPDATE user SET joined_at = ${started} WHERE handle = ${handle} AND joined_at IS NULL`;
                yield* sql`INSERT INTO conversation (user_id, persona_id, session_id, started_at)
        VALUES ((SELECT id FROM user WHERE handle = ${handle}), ${persona.id}, ${session.id}, ${started})`;
                yield* sql`UPDATE send SET state = 'sent', updated_at = ${started} WHERE id = ${row.id}`;
              }),
            );
            return { sessionID: session.id, started, persona };
          }),
        );
        if (prepared) yield* greet(prepared.sessionID, prepared.started, prepared.persona);
        return undefined;
      });

    const watch = (handle: string) =>
      Effect.gen(function* () {
        while (true) {
          const [row] = yield* latest(handle);
          yield* settle(handle, row!).pipe(Effect.catch(() => Effect.void));
          const [pending] = yield* user(handle);
          if (!pending || pending.joined_at !== null || (yield* unavailable(handle))) return;
          yield* Effect.sleep("250 millis");
        }
      });

    const result = (handle: string) =>
      Effect.gen(function* () {
        const [row] = yield* latest(handle);
        if (row?.state === "sent") return "sent" as const;
        if (row?.state === "failed") return "no_imessage" as const;
        return "unknown" as const;
      });

    const oldNotice = (
      handle: string,
      existing: UserRow | undefined,
      previous: NoticeRow,
      now: number,
    ) =>
      Effect.gen(function* () {
        if (previous.state === "sent" || previous.state === "delivered") return "sent" as const;
        if (previous.recorded_at > now - 7 * 86_400_000) return yield* result(handle);
        const status = yield* messages.textStatus(handle, previous.recorded_at);
        if (status === "sent") {
          if (existing) yield* settle(handle, previous);
          return "sent" as const;
        }
        if (status === "unknown") return "unknown" as const;
        return undefined;
      });

    const submit = (input: typeof OnboardingRequest.Type, ip = "missing") =>
      Effect.gen(function* () {
        if (noticeVersion === "pending" || input.privacyNoticeVersion !== noticeVersion)
          return yield* Effect.fail("Privacy notice unavailable");
        if (normalizeHandle(input.handle) !== input.handle)
          return yield* Effect.fail("Invalid Handle");
        if (!(yield* verifyTurnstile(input.turnstileToken, turnstileSecret)))
          return yield* Effect.fail("Turnstile failed");
        const now = yield* Clock.currentTimeMillis;
        if (limitIP(ip, now)) return "try_later" as const;
        const admitted = yield* admission.withPermits(1)(
          Effect.gen(function* () {
            const [hourly] = yield* sql<CountRow>`SELECT COUNT(*) AS count FROM send
          WHERE kind = 'notice' AND recorded_at > ${now - 3_600_000}`;
            if (hourly!.count >= 30) return "try_later" as const;
            const [active] = yield* sql<CountRow>`SELECT COUNT(*) AS count FROM user
          WHERE replied_at IS NOT NULL`;
            if (active!.count >= userCap) return "full" as const;
            if (yield* unavailable(input.handle)) return "unknown" as const;
            const [existing] = yield* user(input.handle);
            if (existing?.joined_at != null) return "sent" as const;
            const selected = personas.get(
              existing
                ? (existing.persona_id ?? defaultPersonaID)
                : (input.personaID ?? defaultPersonaID),
            );
            if (
              !selected ||
              (!existing &&
                (selected.published === false ||
                  (input.personaID !== undefined && !selected.published)))
            )
              return "persona_unavailable" as const;
            const [previous] = yield* latest(input.handle);
            if (previous) {
              const answer = yield* oldNotice(input.handle, existing, previous, now);
              if (answer) return answer;
            }
            yield* sql`DELETE FROM user WHERE handle = ${input.handle} AND joined_at IS NULL`;
            const inserted =
              yield* sql`INSERT OR IGNORE INTO user (handle, locale, consent_version, consent_language, consent_at, persona_id)
      VALUES (${input.handle}, ${input.locale}, ${input.privacyNoticeVersion}, ${input.locale}, ${now}, ${selected.id}) RETURNING id`;
            if (inserted.length) {
              yield* sendNotice(input.handle, notice[input.locale]).pipe(
                Effect.catchCause(Effect.logError),
              );
              yield* Effect.forkDetach(watch(input.handle));
            }
            return undefined;
          }),
        );
        if (admitted !== undefined) return admitted;
        const wait = Effect.gen(function* () {
          while (true) {
            const answer = yield* result(input.handle);
            if (answer !== "unknown") return answer;
            yield* Effect.sleep("250 millis");
          }
        });
        const answer = yield* Effect.timeoutOption(wait, deadlineMillis);
        return Option.getOrElse(answer, () => "unknown" as const);
      });

    const resume = Effect.gen(function* () {
      const greetings =
        yield* sql<GreetingRow>`SELECT conversation.session_id, conversation.started_at, conversation.persona_id
      FROM conversation JOIN user ON user.id = conversation.user_id
      JOIN send ON send.handle = user.handle AND send.kind = 'notice' AND send.state IN ('sent', 'delivered')
      WHERE ${currentNotice}`;
      for (const row of greetings)
        yield* Effect.forkDetach(
          greet(row.session_id, row.started_at, personas.get(row.persona_id)!),
        );
      const pending = yield* sql<{ handle: string }>`SELECT user.handle FROM user
      JOIN send ON send.handle = user.handle AND send.kind = 'notice'
       WHERE user.joined_at IS NULL AND send.state IN ('recorded', 'uncertain') AND ${currentNotice}`;
      for (const row of pending) {
        yield* Effect.forkDetach(watch(row.handle));
      }
    });

    const handlers = HttpApiBuilder.group(onboardingApi, "public", (group) =>
      group
        .handle("personas", () =>
          Effect.succeed(
            [...personas.values()]
              .filter((persona) => persona.published)
              .map((persona) => ({
                id: persona.id,
                name: persona.name!,
                bio: persona.bio!,
                imageUrl: persona.imageUrl!,
              })),
          ),
        )
        .handle("submit", ({ payload }) =>
          Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
            submit(payload, request.headers["cf-connecting-ip"] ?? "missing"),
          ).pipe(Effect.mapError((error) => String(error))),
        )
        .handle("waitlist", ({ payload }) =>
          waitlist(payload).pipe(Effect.mapError((error) => String(error))),
        ),
    );
    const routes = HttpApiBuilder.layer(onboardingApi).pipe(
      Layer.provide(handlers),
      Layer.provideMerge(HttpRouter.layer),
      Layer.provideMerge(HttpRouter.cors({ allowedOrigins: ["https://discovery.hena.dev"] })),
      Layer.provide(HttpServer.layerServices),
    );
    return { submit, waitlist, resume, routes };
  });
};
