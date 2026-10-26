import { expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConversationMessages } from "@ren-ai/onboarding";
import { MessageHistory } from "./conversation-messages.tsx";
import type { ConversationView } from "./conversation-page.tsx";
import { createAdmin } from "./admin.ts";
import { managementClient } from "./contact-client.ts";
import { fixture, request } from "../test/fixtures.ts";
import { loggedRequest } from "./logging.ts";

type Message = (typeof ConversationMessages.Type)["entries"][number];
const message = (id: number, fields: Partial<Message> = {}): Message => ({
  id,
  guid: `guid-${id}`,
  createdAt: 1000 * id,
  text: `message ${id}`,
  fromMe: false,
  status: null,
  attachments: [],
  ...fields,
});
const detail = {
  entry: {
    id: 1,
    handle: "private@example.com",
    personaID: "seoyul",
    personaName: "강서율",
    sessionID: "ses_test",
    startedAt: 0,
    endedAt: null,
    stoppedAt: null,
    lastReceivedAt: null,
    lastSentAt: null,
    canNotify: false,
    farewell: "cancelled" as const,
    notice: "cancelled" as const,
  },
  history: [],
  registrations: [],
};
const view = (messages: typeof ConversationMessages.Type): ConversationView => ({
  query: { filter: "active", search: "" },
  requestId: "test",
  detail,
  messages,
});

test("chat renders real transport content, delivery, attachments and reply context accessibly", () => {
  const entries = [
    message(1, { text: "<script>private\nmessage</script>" }),
    message(2, {
      fromMe: true,
      replyToGuid: "guid-1",
      status: { state: "delivered", error: 0, dateRead: 3000 },
    }),
    message(3, {
      fromMe: true,
      status: { state: "failed", error: 22, dateRead: null },
      attachments: [
        { mimeType: "image/png", missing: false },
        { mimeType: null, missing: true },
      ],
    }),
    message(4, {
      tapback: { emoji: "❤️", targetGuid: "guid-1", added: true },
      replyToGuid: "old-guid",
      payload: "location",
    }),
    message(5, {
      text: "",
      tapback: { emoji: "👍", targetGuid: "guid-1", added: false },
      payload: "app",
    }),
    message(6, { text: "" }),
    message(7, { text: "", replyToGuid: "guid-6" }),
    ...(["pending", "sent", "delivered"] as const).map((state, index) =>
      message(index + 8, { fromMe: true, status: { state, error: 0, dateRead: null } }),
    ),
    message(11, { attachments: [{ mimeType: "text/plain", missing: false }] }),
    message(12, { fromMe: true }),
  ];
  const markup = renderToStaticMarkup(
    <MessageHistory view={{ ...view({ entries, nextBefore: 1 }), messagesBefore: 20 }} />,
  );
  for (const text of [
    "송수신 내역",
    "수신 메시지",
    "발신 메시지",
    "강서율",
    "사용자",
    "&lt;script&gt;",
    "읽음",
    "전송 실패",
    "오류 22",
    "전송 대기",
    "발송 확인",
    "전달 확인",
    "사진",
    "파일 없음",
    "위치 공유",
    "iMessage 앱 콘텐츠",
    "리액션 추가",
    "리액션 취소",
    "이전 메시지에 답장",
    "답장: 첨부 메시지",
    "본문 없음",
    "이전 대화 보기",
    "최신 대화로 돌아가기",
    "messagesBefore=1#messages",
    'href="#message-guid-1"',
  ])
    expect(markup).toContain(text);
  expect(markup).not.toContain("<script>");
  expect(markup).not.toContain("private@example.com");
  const empty = renderToStaticMarkup(
    <MessageHistory view={view({ entries: [], nextBefore: null })} />,
  );
  expect(empty).toContain("저장된 송수신 내역이 없습니다");
  expect(empty).not.toContain("이전 대화 보기");
  const missingView = view({ entries: [], nextBefore: null });
  delete missingView.messages;
  const missing = renderToStaticMarkup(<MessageHistory view={missingView} />);
  expect(missing).toContain("저장된 송수신 내역이 없습니다");
});

test("Admin fetches history through authenticated client, pages and keeps failure visible with retry", async () => {
  const f = await fixture();
  const calls: Request[] = [];
  let failure = false;
  const management = managementClient("https://api.test", "secret-token", async (input, init) => {
    const incoming = new Request(input, init);
    calls.push(incoming);
    const path = new URL(incoming.url).pathname;
    if (path === "/operator/messages")
      return failure
        ? new Response(null, { status: 503 })
        : Response.json({ entries: [message(1)], nextBefore: 1 });
    if (path === "/operator/conversations")
      return Response.json({ state: "idle", pending: 0, nextWakeAt: null });
    return Response.json(detail);
  });
  const admin = createAdmin(f.store, "test-password", "styles", { management });
  const first = await (await admin(request("/conversations/1"))).text();
  expect(first).toContain("message 1");
  await admin(request("/conversations/1?messagesBefore=2"));
  expect(calls.at(-1)?.url).toBe("https://api.test/operator/messages?id=1&before=2");
  expect(calls.at(-1)?.headers.get("authorization")).toBe("Bearer secret-token");
  expect((await admin(request("/conversations/1?messagesBefore=bad"))).status).toBe(400);
  const logs: string[] = [];
  const error = vi.spyOn(process.stderr, "write").mockImplementation((line) => {
    logs.push(String(line));
    return true;
  });
  try {
    failure = true;
    const response = await admin(request("/conversations/1?messagesBefore=2"));
    const page = await response.text();
    expect(response.status).toBe(200);
    expect(page).toContain("송수신 내역을 불러오지 못했습니다");
    expect(page).toContain("?messagesBefore=2#messages");
    expect(page).not.toContain("저장된 송수신 내역이 없습니다");
    expect(logs.join("")).toContain("conversation.messages");
    expect(logs.join("")).not.toContain("secret-token");
    expect(logs.join("")).not.toContain("message 1");
  } finally {
    error.mockRestore();
  }
  await loggedRequest(
    request("/conversations/1"),
    async () => {
      await expect(management.conversations!.messages(1)).rejects.toThrow("메시징 API 요청이 실패");
      return new Response(null);
    },
    () => {},
  );
});

test("only confirmed outgoing photos render authenticated previews and Admin proxies with its service token", async () => {
  const entries = (["sent", "delivered", "pending", "failed"] as const).map((state, index) =>
    message(index + 1, {
      fromMe: true,
      status: { state, error: 0, dateRead: null },
      attachments: [{ mimeType: "image/png", missing: false }],
    }),
  );
  entries.push(message(5, { attachments: [{ mimeType: "image/png", missing: false }] }));
  entries.push(
    message(6, {
      fromMe: true,
      status: { state: "sent", error: 0, dateRead: null },
      attachments: [{ mimeType: "image/png", missing: true }],
    }),
  );
  const markup = renderToStaticMarkup(
    <MessageHistory view={view({ entries, nextBefore: null })} />,
  );
  expect(markup).toContain("/conversations/1/images/1/0?guid=guid-1");
  expect(markup).toContain("/conversations/1/images/2/0?guid=guid-2");
  for (const id of [3, 4, 5, 6]) expect(markup).not.toContain(`/images/${id}/`);
  const f = await fixture();
  const fetcher = vi.fn<typeof fetch>(
    async () => new Response(new Uint8Array([1, 2]), { headers: { "content-type": "image/png" } }),
  );
  const management = managementClient("https://api.test", "secret-token", fetcher);
  const admin = createAdmin(f.store, "test-password", "styles", { management });
  const path = "/conversations/1/images/1/0?guid=guid-1";
  expect((await admin(new Request(`https://admin.test${path}`))).status).toBe(401);
  expect(fetcher).not.toHaveBeenCalled();
  const response = await admin(request(path));
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2]));
  const [url, init] = fetcher.mock.calls[0]!;
  expect(new Request(url).url).toBe(
    "https://api.test/operator/message-image?id=1&message=1&guid=guid-1&attachment=0",
  );
  expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-token");
  fetcher.mockResolvedValueOnce(new Response(null));
  const missing = await admin(request("/conversations/1/images/1/0"));
  expect(missing.headers.get("content-type")).toBe("application/octet-stream");
  fetcher.mockResolvedValueOnce(new Response(null, { status: 404 }));
  expect((await admin(request(path))).status).toBe(404);
});
