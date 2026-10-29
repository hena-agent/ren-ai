import { randomUUID } from "node:crypto";
import { Schema } from "effect";
import {
  ContactRecheck,
  ContactVisibility,
  SelectContacts,
  StartContact,
} from "@ren-ai/onboarding";
import { PersonaError } from "@ren-ai/personas";
import type { ManagementClient } from "./contact-client.ts";
import type { ContactView } from "./contact-page.tsx";
import { html } from "./html-response.ts";
import { renderPage } from "./page.tsx";
import { GenerationError, operation, reportFailure, requestId } from "./logging.ts";
import { submitInvitations } from "./invitation-form.ts";
import { contactQuery } from "./contact-query.ts";

const select = (form: FormData, view: ContactView, client: ManagementClient) => {
  let input: typeof SelectContacts.Type;
  const specific = form.get("action") === "select-specific";
  const registrationIDs = form.getAll("registrationIDs");
  const assignments = specific
    ? registrationIDs.flatMap((id) => {
        if (typeof id !== "string") return [];
        const personaID = form.get(`personaID:${id}`);
        return personaID ? [{ registrationID: id, personaID }] : [];
      })
    : [];
  try {
    input = Schema.decodeUnknownSync(SelectContacts)({
      requestId: form.get("requestId"),
      count: specific ? registrationIDs.length : Number(form.get("count")),
      ...(specific && { registrationIDs }),
      ...(assignments.length && { assignments }),
    });
  } catch {
    throw new PersonaError(
      "invalid",
      "선정 인원은 1~100 사이 정수여야 하며, 직접 선정할 대기자는 1~100명 골라 주세요.",
    );
  }
  if (input.registrationIDs) {
    view.directRequestId = input.requestId;
    view.registrationIDs = input.registrationIDs;
    view.assignments = input.assignments ?? [];
    view.directAttempted = true;
  } else {
    view.requestId = input.requestId;
    view.count = input.count;
    view.attempted = true;
  }
  return operation("management.select", {}, () => client.select(input));
};

/** Unlike a selection, a start keeps no retry key: a started handle is no longer eligible. */
const start = (form: FormData, client: ManagementClient) => {
  let input: typeof StartContact.Type;
  try {
    input = Schema.decodeUnknownSync(StartContact)({
      requestId: form.get("requestId"),
      registrationID: form.get("registrationID"),
      personaID: form.get("personaID"),
    });
  } catch {
    throw new PersonaError("invalid", "시작할 테스트 연락처와 페르소나를 다시 골라 주세요.");
  }
  return operation("management.start", {}, () => client.start(input));
};

async function recheck(form: FormData, view: ContactView, client: ManagementClient) {
  let input: typeof ContactRecheck.Type;
  try {
    input = Schema.decodeUnknownSync(ContactRecheck)({
      registrationID: form.get("registrationID"),
    });
  } catch {
    throw new PersonaError("invalid", "재확인할 연락처를 다시 선택해 주세요.");
  }
  await operation("management.imessage-recheck", {}, () => client.recheck(input));
  view.notice =
    "iMessage 지원 여부를 다시 확인했습니다. 해당 행의 결과를 확인해 주세요. 메시지는 발송하지 않았습니다.";
}

async function submit(form: FormData, view: ContactView, client: ManagementClient) {
  const action = form.get("action");
  if (action === "imessage-recheck") return recheck(form, view, client);
  if (action === "hide" || action === "restore") {
    if (view.tab === "invitations")
      throw new PersonaError("invalid", "대기자 화면에서 제출해 주세요.");
    let input: typeof ContactVisibility.Type;
    try {
      input = Schema.decodeUnknownSync(ContactVisibility)({
        registrationIDs: form.getAll("registrationIDs"),
        hidden: action === "hide",
      });
    } catch {
      throw new PersonaError("invalid", "숨기거나 복원할 기록을 1~100개 선택해 주세요.");
    }
    await operation("management.visibility", {}, () => client.visibility(input));
    view.notice = `${input.registrationIDs.length}개 기록을 ${input.hidden ? "숨겼습니다. 신규 선정에서 제외되며 기존 예약과 대화는 유지됩니다." : "복원했습니다."}`;
    return;
  }
  if (view.tab !== "invitations" && typeof action === "string" && action.startsWith("invitation"))
    throw new PersonaError("invalid", "초대장 화면에서 제출해 주세요.");
  if (
    form.get("action") === "invitation-lookup" ||
    form.get("action") === "invitation-grant" ||
    form.get("action") === "invitation-create"
  )
    return submitInvitations(form, view.invitation!, client);
  if (form.get("action") === "invitations") {
    const value = form.get("enabled");
    if (value !== "true" && value !== "false")
      throw new PersonaError("invalid", "초대장 지급 설정을 다시 선택해 주세요.");
    await operation("management.invitations", {}, () =>
      client.configureInvitations({ enabled: value === "true" }),
    );
    return;
  }
  if (
    view.tab !== "waitlist" ||
    (action !== null && action !== "select-specific" && action !== "start")
  )
    throw new PersonaError("invalid", "대기자 화면에서 선정 요청을 제출해 주세요.");
  view.selection = await (form.get("action") === "start"
    ? start(form, client)
    : select(form, view, client));
}

export async function contactRoutes(request: Request, client?: ManagementClient) {
  const url = new URL(request.url);
  const view: ContactView = {
    tab:
      url.pathname === "/invitations"
        ? "invitations"
        : url.pathname === "/waitlist"
          ? "waitlist"
          : "first-contacts",
    query: contactQuery(url.searchParams),
    action: `${url.pathname}${url.search}`,
    requestId: randomUUID(),
    startRequestId: randomUUID(),
    directRequestId: randomUUID(),
    registrationIDs: [],
    assignments: [],
    count: 1,
    invitation: {
      requestId: randomUUID(),
      handle: "",
      locale: "ko",
      kind: "basic",
      attempted: false,
      creation: { requestId: randomUUID(), maxUses: 1, grantCount: 2, attempted: false },
    },
  };
  const render = (error = "", status = 200) =>
    html(renderPage({ personas: [], contactView: view, error }), status);
  try {
    if (!client)
      throw new GenerationError("메시징 API 연결 설정이 필요합니다.", {
        code: "management_unconfigured",
      });
    if (request.method === "POST") {
      if (request.headers.get("origin") !== url.origin)
        throw new PersonaError("invalid", "이 관리 화면에서 제출한 요청만 허용됩니다.");
      await submit(await request.formData(), view, client);
    }
    if (request.method === "GET" && view.tab === "invitations" && url.searchParams.has("handle")) {
      const form = new FormData();
      form.set("action", "invitation-lookup");
      form.set("handle", url.searchParams.get("handle")!);
      view.action = "/invitations?section=phone";
      await submitInvitations(form, view.invitation!, client);
    }
    view.snapshot = await operation("management.list", {}, client.list);
    const registrationID = url.searchParams.get("languages");
    if (registrationID) {
      const id = Schema.decodeUnknownSync(SelectContacts.fields.requestId)(registrationID);
      view.languages = await operation("management.languages", {}, () => client.languages(id));
    }
    return render();
  } catch (cause) {
    const expected = cause instanceof PersonaError;
    reportFailure(cause, { stage: "management.request" }, expected ? "warn" : "error");
    return render(
      `${expected || cause instanceof GenerationError ? cause.message : "메시징 API를 확인할 수 없습니다."} 요청 ID: ${requestId()}`,
      expected ? 400 : 503,
    );
  }
}
