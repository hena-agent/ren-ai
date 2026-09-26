import { Effect, Layer, Queue, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export const handle = "<iphone>";
export const at = "2026-09-25T12:02:07.447Z";
// Redacted imsg 0.15.9 probe (#2): outgoing iPhone, rejected Android, inbound text, edit, unsend.
export const raw = [
  {
    id: 2,
    guid: "BB90B25A-85FC-492D-9E58-CA0EE9FAB596",
    chat_id: 1,
    chat_identifier: handle,
    created_at: "2026-09-25T11:48:29.273Z",
    text: "[imsg probe 1] 안녕하세요 👋 imsg로 보낸 테스트 메시지예요",
    is_from_me: true,
  },
  {
    id: 3,
    guid: "09BDFB7D-3C64-40BC-B769-A0FB11B5C1CB",
    chat_id: 2,
    chat_identifier: "<android>",
    created_at: "2026-09-25T11:49:21.264Z",
    text: "[imsg probe 2] 안드로이드 번호 테스트",
    is_from_me: true,
  },
  {
    id: 6,
    guid: "90A70987-30BD-4CC5-BA10-B11C5EE76B9A",
    chat_id: 1,
    chat_identifier: handle,
    created_at: at,
    text: "1 텍스트",
    is_from_me: false,
  },
  {
    id: 9,
    guid: "2CDDBEF5-63F5-4D46-B274-C07EE7474351",
    chat_id: 1,
    chat_identifier: handle,
    created_at: "2026-09-25T12:02:46.073Z",
    text: "4 수정 전",
    is_from_me: false,
  },
  {
    id: 10,
    guid: "5BEB6BE5-CF8E-4C81-8FC4-55B5C0EF37C6",
    chat_id: 1,
    chat_identifier: handle,
    created_at: "2026-09-25T12:03:03.077Z",
    text: "5 취소할 메시지",
    is_from_me: false,
  },
];

export const decodeRequest = (bytes: Uint8Array) => {
  // oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: fake process decodes adapter stdin
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    typeof value.id !== "number" ||
    !("method" in value) ||
    typeof value.method !== "string" ||
    !("params" in value) ||
    !isParams(value.params)
  )
    throw new Error("Invalid fake request");
  return { id: value.id, method: value.method, params: value.params };
};

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: fake process validates received JSON params
export const isParams = (value: unknown): value is Record<string, string | number | boolean> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((item) => ["string", "number", "boolean"].includes(typeof item));

export const fixture = () => {
  const spawned: ChildProcess.Command[] = [];
  const commands: Array<{
    id: number;
    method: string;
    params: Record<string, string | number | boolean>;
  }> = [];
  const inputLines: string[] = [];
  const alerts: string[] = [];
  const alertDetails: string[] = [];
  const connections: Array<{
    notify: (method: string, params: object) => void;
    respond: (value: object) => void;
    close: () => void;
    running: () => boolean;
    finalized: () => boolean;
  }> = [];
  let rows = [...raw];
  let failSend = false;
  let returnGUID = true;
  let history = rows;
  let stuckPage = false;
  const outcomes = new Map<
    string,
    { send_state: string; status_fields: { error: number; date_read: string | null } | null }
  >();
  let hangMethod: string | undefined;
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      spawned.push(command);
      const output = yield* Queue.make<Uint8Array>();
      let running = true;
      let finalized = false;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          running = false;
          finalized = true;
        }),
      );
      const respond = (value: object) => {
        Queue.offerUnsafe(
          output,
          new TextEncoder().encode(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`),
        );
      };
      const notify = (method: string, params: object) => respond({ method, params });
      connections.push({
        notify,
        respond,
        close: () => {
          running = false;
          Effect.runFork(Queue.shutdown(output));
        },
        running: () => running,
        finalized: () => finalized,
      });
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(connections.length),
        exitCode: Effect.never,
        isRunning: Effect.sync(() => running),
        kill: () =>
          Effect.sync(() => {
            running = false;
          }),
        stdin: Sink.forEach((bytes: Uint8Array) =>
          Effect.sync(() => {
            inputLines.push(new TextDecoder().decode(bytes));
            const request = decodeRequest(bytes);
            commands.push(request);
            const cursor = Number(request.params["since_rowid"] ?? 0);
            const page = rows.filter((row) => row.id > cursor).slice(0, 2);
            const next = page.at(-1)?.id ?? cursor;
            let result: object;
            switch (request.method) {
              case "messages.after":
                result = stuckPage
                  ? { messages: [], next_rowid: cursor, has_more: true }
                  : {
                      messages: page,
                      next_rowid: next,
                      has_more: rows.some((row) => row.id > next),
                    };
                break;
              case "messages.history":
                result = {
                  messages: history
                    .filter((row) => row.chat_id === request.params["chat_id"])
                    .toReversed(),
                };
                break;
              case "message.send_status":
                result =
                  outcomes.get(String(request.params["guid"])) ??
                  (request.params["guid"] === raw[1]!.guid
                    ? { send_state: "failed", status_fields: { error: 22, date_read: null } }
                    : {
                        send_state: "delivered",
                        status_fields: { error: 0, date_read: "2026-09-25T12:00:08.000Z" },
                      });
                break;
              case "watch.subscribe":
                result = { subscription: 1, buffer_limit: 256 };
                break;
              default:
                result = { ok: true, ...(returnGUID ? { guid: raw[0]!.guid } : {}) };
            }
            if (request.method === hangMethod) return;
            if (request.method === "send" && failSend)
              respond({ id: request.id, error: { code: -32001, message: "uncertain" } });
            else respond({ id: request.id, result });
          }),
        ),
        getInputFd: () => Sink.drain,
        stdout: Stream.fromQueue(output),
        getOutputFd: () => Stream.empty,
        stderr: Stream.empty,
        unref: Effect.succeed(Effect.void),
        all: Stream.empty,
      });
    }),
  );
  return {
    spawner,
    spawned,
    commands,
    inputLines,
    alerts,
    alertDetails,
    connections,
    dependencies: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    alertsService: {
      raise: (name: string, detail?: string) =>
        Effect.sync(() => {
          alerts.push(`raise:${name}`);
          alertDetails.push(detail ?? name);
        }),
      clear: (name: string) =>
        Effect.sync(() => {
          alerts.push(`clear:${name}`);
        }),
    },
    replace: (next: typeof raw) => {
      rows = next;
      history = next;
    },
    edit: () => {
      history = history.map((row) =>
        row.id === 9 ? { ...row, text: "4 수정 후" } : row.id === 10 ? { ...row, text: "" } : row,
      );
    },
    fail: () => {
      failSend = true;
    },
    succeed: () => {
      failSend = false;
    },
    noGUID: () => {
      returnGUID = false;
    },
    status: (guid: string, state: string, error: number, dateRead: string | null = null) => {
      outcomes.set(guid, { send_state: state, status_fields: { error, date_read: dateRead } });
    },
    hang: (method: string) => {
      hangMethod = method;
    },
    stuck: () => {
      stuckPage = true;
    },
    inbound: (recipient: string, content: string, date: number) =>
      Effect.sync(() => {
        const row = {
          id: (rows.at(-1)?.id ?? 0) + 1,
          guid: `incoming-${rows.length}`,
          chat_id: 1,
          chat_identifier: recipient,
          created_at: new Date(date).toISOString(),
          text: content,
          is_from_me: false,
        };
        rows.push(row);
        connections.at(-1)?.notify("message", { subscription: 1, message: row });
        return {
          id: row.id,
          guid: row.guid,
          handle: recipient,
          createdAt: date,
          text: content,
          fromMe: false,
        };
      }),
  };
};
