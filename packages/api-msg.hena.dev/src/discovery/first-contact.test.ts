import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { Session } from "@opencode/schema/session";
import { SessionInbox } from "@opencode/schema/session-inbox";
import { fromPartial } from "@total-typescript/shoehorn";
import { expect, test, vi } from "vitest";
import type { PersonaRuntime } from "../opencode/runtime.ts";
import type { Messages } from "@ren-ai/imsg.hena.dev";
import { conversations } from "../conversations/conversations.ts";
import { firstContacts } from "./first-contact.ts";
import type { ContactDiagnostic } from "./diagnostics.ts";
import { contactFixture, withContactDatabase } from "./contact.test-helper.ts";

const setup = Effect.gen(function* () {
  const fixture = yield* contactFixture;
  const id = yield* fixture.register("private@example.net");
  yield* fixture.store.select({ requestId: randomUUID(), count: 1 }, "selection-request");
  const session = fromPartial<Session.Info>({ id: Session.ID.make("ses_contact") });
  const created = vi.fn<PersonaRuntime["createSession"]>(() => Effect.succeed(session));
  const prompt = vi.fn<PersonaRuntime["sessions"]["prompt"]>(() =>
    Effect.succeed(fromPartial<SessionInbox.User>({})),
  );
  const removed = vi.fn<PersonaRuntime["sessions"]["remove"]>(() => Effect.void);
  const get = vi.fn<PersonaRuntime["sessions"]["get"]>(() => Effect.succeed(session));
  const personas = new Map([
    [
      "luna",
      {
        id: "luna",
        published: true,
        language: "ko",
        timeZone: "Asia/Seoul",
        openingLine: "Say hello in your own voice",
        memory: "private memory",
        prompt: "private character",
      },
    ],
  ]);
  const host = fromPartial<PersonaRuntime>({
    personas,
    createSession: created,
    sessions: { prompt, get, remove: removed },
  });
  const logs: ContactDiagnostic[] = [];
  const directory = yield* conversations;
  const status = vi.fn<Messages["textStatus"]>(() => Effect.succeed("unknown"));
  const worker = yield* firstContacts(
    host,
    { textStatus: status },
    directory,
    "test/probe",
    (entry) => logs.push(entry),
  );
  const due = fixture.sql`UPDATE discovery_contact SET scheduled_at = 0`;
  return {
    ...fixture,
    id,
    host,
    personas,
    created,
    prompt,
    removed,
    get,
    status,
    logs,
    directory,
    worker,
    due,
  };
});

test("a persisted reservation starts only when due and records web consent without a service notice", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const f = yield* setup;
      yield* f.worker.tick;
      expect(f.created).not.toHaveBeenCalled();
      yield* f.due;
      yield* Effect.all([f.worker.tick, f.worker.tick], { concurrency: "unbounded" });
      expect(f.created).toHaveBeenCalledOnce();
      expect(f.prompt).toHaveBeenCalledOnce();
      const [user] = yield* f.sql<{
        consent_at: number;
        consent_version: string;
      }>`SELECT consent_at, consent_version FROM user`;
      expect(user).toEqual({ consent_at: 123, consent_version: "web-consent" });
      expect(yield* f.sql`SELECT * FROM send WHERE kind = 'notice'`).toEqual([]);
      const queued = f.prompt.mock.calls[0]!;
      expect(JSON.stringify(queued)).toContain("msg_discovery_");
      expect(JSON.stringify(queued)).not.toContain("private memory");
      const restarted = yield* firstContacts(
        f.host,
        { textStatus: f.status },
        f.directory,
        "test/probe",
        (entry) => f.logs.push(entry),
      );
      yield* restarted.tick;
      expect(f.prompt).toHaveBeenCalledOnce();
      yield* f.sql`INSERT INTO send (handle, conversation_id, kind, content, state, recorded_at, updated_at)
      SELECT 'private@example.net', id, 'text', 'greeting', 'sent', 1, 1 FROM conversation`;
      yield* restarted.tick;
      expect((yield* f.store.list).entries[0]?.state).toBe("active");
    }),
  );
});

test("uncertain sends are observed after restart, never submitted again", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const f = yield* setup;
      yield* f.due;
      yield* f.worker.tick;
      yield* f.sql`INSERT INTO send (handle, conversation_id, kind, content, state, recorded_at, updated_at)
      SELECT 'private@example.net', id, 'text', 'greeting', 'recorded', 1, 1 FROM conversation`;
      yield* f.worker.tick;
      expect((yield* f.store.list).entries[0]?.state).toBe("review");
      yield* f.sql`UPDATE send SET state = 'delivered'`;
      yield* f.worker.tick;
      expect((yield* f.store.list).entries[0]?.state).toBe("active");
      expect(f.prompt).toHaveBeenCalledOnce();
    }),
  );
});

test("missing/unpublished/blocked sources cannot start a session", async () => {
  for (const condition of ["unpublished", "missing", "blocked"]) {
    await withContactDatabase(
      Effect.gen(function* () {
        const f = yield* setup;
        if (condition === "unpublished") f.personas.get("luna")!.published = false;
        if (condition === "missing") f.personas.delete("luna");
        if (condition === "blocked")
          yield* f.sql`INSERT INTO blocked VALUES ('private@example.net', 1)`;
        yield* f.due;
        yield* f.worker.tick;
        expect(f.created).not.toHaveBeenCalled();
        expect((yield* f.store.list).entries[0]?.state).toBe("blocked");
      }),
    );
  }
});

test("a block or removal during session creation fences admission and cleans up the orphan", async () => {
  for (const condition of ["block", "remove"]) {
    await withContactDatabase(
      Effect.gen(function* () {
        const f = yield* setup;
        f.created.mockImplementation(() =>
          Effect.gen(function* () {
            if (condition === "block")
              yield* f.sql`INSERT INTO blocked VALUES ('private@example.net', 1)`;
            else yield* f.sql`DELETE FROM discovery_registration`;
            return fromPartial<Session.Info>({ id: Session.ID.make("ses_orphan") });
          }),
        );
        yield* f.due;
        yield* f.worker.tick;
        expect(f.removed).toHaveBeenCalledOnce();
        expect(f.prompt).not.toHaveBeenCalled();
        expect(yield* f.sql`SELECT * FROM user`).toEqual([]);
      }),
    );
  }
});

test("session/enqueue failures preserve reservation, correlation and exclude private errors", async () => {
  for (const stage of ["create", "enqueue"]) {
    await withContactDatabase(
      Effect.gen(function* () {
        const f = yield* setup;
        const failure = new Error("secret-token private@example.net private character", {
          cause: Object.assign(new Error("provider echoed private memory"), {
            code: "UPSTREAM_DOWN",
          }),
        });
        if (stage === "create") f.created.mockImplementation(() => Effect.fail(failure));
        else f.prompt.mockImplementation(() => Effect.fail(failure));
        yield* f.due;
        yield* f.worker.tick;
        yield* f.worker.tick;
        expect(f.created).toHaveBeenCalledOnce();
        expect((yield* f.store.list).entries[0]?.state).toBe("review");
        const errors = f.logs.filter(
          (entry) => entry.outcome === "failed" && entry.stage !== "task",
        );
        expect(errors[0]).toMatchObject({
          requestId: "selection-request",
          model: "test/probe",
          causeCode: "UPSTREAM_DOWN",
          causeName: "Error",
          stage: stage === "create" ? "session.create" : "greeting.enqueue",
        });
        const output = JSON.stringify(f.logs);
        for (const privateValue of [
          "secret-token",
          "private@example.net",
          "private character",
          "private memory",
        ])
          expect(output).not.toContain(privateValue);
      }),
    );
  }
});

test("completed/failed executions with no first message stop and failed sends distinguish iMessage absence", async () => {
  for (const scenario of ["succeeded", "failed", "send_failed", "no_imessage"]) {
    await withContactDatabase(
      Effect.gen(function* () {
        const f = yield* setup;
        yield* f.due;
        yield* f.worker.tick;
        if (scenario === "succeeded" || scenario === "failed")
          f.get.mockImplementation(() =>
            Effect.succeed(
              fromPartial<Session.Info>({ id: Session.ID.make("ses_contact"), outcome: scenario }),
            ),
          );
        else {
          yield* f.sql`INSERT INTO send (handle, conversation_id, kind, content, state, recorded_at, updated_at)
          SELECT 'private@example.net', id, 'text', 'greeting', 'failed', 1, 1 FROM conversation`;
          if (scenario === "no_imessage")
            f.status.mockImplementation(() => Effect.succeed("no_imessage"));
        }
        yield* f.worker.tick;
        expect((yield* f.store.list).entries[0]?.state).toBe(
          scenario === "no_imessage" ? "unreachable" : "failed",
        );
      }),
    );
  }
});

test("recovering an interrupted preparation retains its assignment without a new paid call", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const f = yield* setup;
      yield* f.sql`UPDATE discovery_contact SET state = 'preparing'`;
      yield* f.worker.tick;
      expect((yield* f.store.list).entries[0]?.state).toBe("review");
      expect(f.created).not.toHaveBeenCalled();
      expect(yield* f.sql`SELECT * FROM persona_assignment`).toHaveLength(1);
      yield* f.sql`INSERT INTO blocked VALUES ('private@example.net', 1)`;
      yield* f.worker.tick;
      expect((yield* f.store.list).entries[0]?.state).toBe("blocked");
    }),
  );
});

test("binding failure cleans an unreferenced session and retains the primary diagnostic", async () => {
  for (const failedCleanup of [false, true]) {
    await withContactDatabase(
      Effect.gen(function* () {
        const f = yield* setup;
        yield* f.sql`CREATE TRIGGER reject_admission BEFORE INSERT ON user BEGIN SELECT RAISE(ABORT, 'commit failed'); END`;
        if (failedCleanup)
          f.removed.mockImplementation(() => Effect.fail(new Error("cleanup failed")));
        yield* f.due;
        yield* f.worker.tick;
        expect(f.removed).toHaveBeenCalledOnce();
        expect(f.prompt).not.toHaveBeenCalled();
        expect((yield* f.store.list).entries[0]?.state).toBe("review");
        expect(
          f.logs.some(
            (event) => event.stage === "conversation.commit" && event.outcome === "failed",
          ),
        ).toBe(true);
        expect(f.logs.some((event) => event.stage === "session.cleanup")).toBe(failedCleanup);
      }),
    );
  }
});

test("cleanup never deletes a session already bound to a Conversation", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const f = yield* setup;
      f.created.mockImplementation(() =>
        Effect.gen(function* () {
          yield* f.sql`INSERT INTO user (handle, locale, consent_version, consent_language, consent_at, joined_at) VALUES ('private@example.net', 'ko', 'v', 'ko', 1, 1)`;
          yield* f.sql`INSERT INTO conversation (user_id, persona_id, session_id, started_at) SELECT id, 'luna', 'ses_contact', 1 FROM user`;
          return fromPartial<Session.Info>({ id: Session.ID.make("ses_contact") });
        }),
      );
      yield* f.due;
      yield* f.worker.tick;
      expect(f.removed).not.toHaveBeenCalled();
      expect(f.prompt).not.toHaveBeenCalled();
      expect((yield* f.store.list).entries[0]?.state).toBe("review");
    }),
  );
});

test("observational and queue-read failures are diagnosed while the monitor remains interruptible", async () => {
  await withContactDatabase(
    Effect.gen(function* () {
      const f = yield* setup;
      yield* f.due;
      yield* f.worker.tick;
      f.get.mockImplementation(() => Effect.fail(new Error("private session")));
      yield* f.worker.tick;
      expect(f.logs.at(-1)?.stage).toBe("task.observe");
      yield* f.worker.tick;
      expect(f.logs.filter((entry) => entry.stage === "task.observe")).toHaveLength(1);
      yield* f.worker.monitor.pipe(Effect.timeoutOption("20 millis"));
      yield* f.sql`DROP TABLE discovery_contact`;
      yield* f.worker.monitor.pipe(Effect.timeoutOption("20 millis"));
      expect(f.logs.at(-1)?.stage).toBe("queue.read");
    }),
  );
});
