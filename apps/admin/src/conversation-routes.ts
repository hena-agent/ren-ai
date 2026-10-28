import { randomUUID } from "node:crypto";
import { Schema } from "effect";
import {
  parseConversationQuery,
  ConversationRecovery,
  ConversationEnding,
} from "@ren-ai/onboarding";
import { PersonaError } from "@ren-ai/personas";
import type { ConversationClient } from "./contact-client.ts";
import type { ConversationView } from "./conversation-page.tsx";
import { renderPage } from "./page.tsx";
import { html } from "./html-response.ts";
import { GenerationError, operation, reportFailure, requestId } from "./logging.ts";

async function recoverRequest(
  request: Request,
  url: URL,
  match: RegExpExecArray | null,
  client: ConversationClient,
) {
  if (!match || request.headers.get("origin") !== url.origin)
    throw new PersonaError("invalid", "이 대화 관리 화면에서 제출해 주세요.");
  const form = await request.formData();
  if (form.get("action") === "end") {
    if (form.get("confirmEnding") !== "yes")
      throw new PersonaError("invalid", "대상 사용자와 페르소나의 관계 종료를 확인해 주세요.");
    let ending: typeof ConversationEnding.Type;
    try {
      ending = Schema.decodeUnknownSync(ConversationEnding)({
        id: Number(match[1]),
        key: form.get("key"),
        requestId: form.get("requestId"),
      });
    } catch {
      throw new PersonaError("invalid", "관계 종료 요청을 확인해 주세요.");
    }
    await operation("conversation.end", {}, () => client.end(ending));
    return new Response(null, {
      status: 303,
      headers: { Location: `/conversations/${ending.id}?ended=1`, "Cache-Control": "no-store" },
    });
  }
  let input: typeof ConversationRecovery.Type;
  try {
    input = Schema.decodeUnknownSync(ConversationRecovery)({
      id: Number(match[1]),
      requestId: form.get("requestId"),
      action: form.get("action"),
    });
  } catch {
    throw new PersonaError("invalid", "복구 요청을 확인해 주세요.");
  }
  await operation("conversation.recover", {}, () => client.recover(input));
  return new Response(null, {
    status: 303,
    headers: { Location: `/conversations/${input.id}?queued=1`, "Cache-Control": "no-store" },
  });
}

function readQuery(url: URL) {
  try {
    return parseConversationQuery(url.searchParams);
  } catch {
    throw new PersonaError("invalid", "대화 검색 조건을 확인해 주세요.");
  }
}

async function loadDetail(client: ConversationClient, id: number, view: ConversationView) {
  try {
    view.runtime = await operation("conversation.runtime", {}, () => client.runtime(id));
  } catch (cause) {
    reportFailure(cause, { stage: "conversation.runtime" });
    view.runtime = { state: "unavailable", pending: null, nextWakeAt: null };
  }
  view.detail = await operation("conversation.detail", {}, () =>
    client.detail(id, view.registrationsBefore),
  );
  try {
    view.messages = await operation("conversation.messages", {}, () =>
      client.messages(id, view.messagesBefore),
    );
  } catch (cause) {
    reportFailure(cause, { stage: "conversation.messages" });
    view.messagesError = `송수신 내역을 불러오지 못했습니다. 다시 시도해 주세요. 요청 ID: ${requestId()}`;
  }
}

function registrationCursor(url: URL) {
  try {
    return Schema.decodeUnknownSync(Schema.UndefinedOr(ConversationRecovery.fields.requestId))(
      url.searchParams.get("registrationsBefore") ?? undefined,
    );
  } catch {
    throw new PersonaError("invalid", "등록 이력 검색 위치를 확인해 주세요.");
  }
}

function messageCursor(url: URL) {
  const value = url.searchParams.get("messagesBefore");
  if (value === null) return undefined;
  const before = Number(value);
  if (!Number.isSafeInteger(before) || before <= 0)
    throw new PersonaError("invalid", "메시지 검색 위치를 확인해 주세요.");
  return before;
}

async function imageResponse(client: ConversationClient, url: URL, image: RegExpExecArray) {
  const response = await operation("conversation.image", {}, () =>
    client.image(
      Number(image[1]),
      Number(image[2]),
      url.searchParams.get("guid") ?? "",
      Number(image[3]),
    ),
  );
  return new Response(response.body, {
    headers: {
      "Content-Type": response.headers.get("content-type") ?? "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function conversationRoutes(request: Request, client?: ConversationClient) {
  const url = new URL(request.url);
  const view: ConversationView = {
    query: { filter: "active", search: "" },
    requestId: randomUUID(),
  };
  const render = (error = "", status = 200) =>
    html(renderPage({ personas: [], conversationView: view, error }), status);
  try {
    if (!client)
      throw new GenerationError("메시징 API 연결 설정이 필요합니다.", {
        code: "management_unconfigured",
      });
    const match = /^\/conversations\/(\d+)$/.exec(url.pathname);
    if (request.method === "POST") return await recoverRequest(request, url, match, client);
    const image = /^\/conversations\/(\d+)\/images\/(\d+)\/(\d+)$/.exec(url.pathname);
    if (image) return await imageResponse(client, url, image);
    if (match) {
      const id = Number(match[1]);
      const cursor = registrationCursor(url);
      if (cursor) view.registrationsBefore = cursor;
      const before = messageCursor(url);
      if (before !== undefined) view.messagesBefore = before;
      await loadDetail(client, id, view);
      view.queued = url.searchParams.has("queued");
      view.ended = url.searchParams.has("ended");
    } else {
      if (url.pathname !== "/conversations") return render("대화를 찾을 수 없습니다.", 404);
      view.query = readQuery(url);
      view.list = await operation("conversation.list", {}, () => client.list(view.query));
    }
    return render();
  } catch (cause) {
    reportFailure(
      cause,
      { stage: "conversation.request" },
      cause instanceof PersonaError ? "warn" : "error",
    );
    return render(
      `${cause instanceof PersonaError || cause instanceof GenerationError ? cause.message : "대화 상태를 확인할 수 없습니다."} 요청 ID: ${requestId()}`,
      cause instanceof PersonaError
        ? { invalid: 400, not_found: 404, conflict: 409 }[cause.kind]
        : 503,
    );
  }
}
