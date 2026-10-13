import { randomUUID } from "node:crypto";
import { Schema } from "effect";
import { SelectContacts } from "@ren-ai/onboarding";
import { PersonaError } from "@ren-ai/personas";
import type { ManagementClient } from "./contact-client.ts";
import type { ContactView } from "./contact-page.tsx";
import { html } from "./html-response.ts";
import { renderPage } from "./page.tsx";
import { GenerationError, operation, reportFailure, requestId } from "./logging.ts";

export async function contactRoutes(request: Request, client?: ManagementClient) {
  const url = new URL(request.url);
  const view: ContactView = {
    tab: url.pathname === "/waitlist" ? "waitlist" : "first-contacts",
    requestId: randomUUID(),
    count: 1,
  };
  const render = (error = "", status = 200) =>
    html(renderPage({ personas: [], contactView: view, error }), status);
  try {
    if (!client)
      throw new GenerationError("메시징 API 연결 설정이 필요합니다.", {
        code: "management_unconfigured",
      });
    if (request.method === "POST") {
      if (url.pathname !== "/waitlist" || request.headers.get("origin") !== url.origin)
        throw new PersonaError("invalid", "이 관리 화면에서 제출한 요청만 허용됩니다.");
      const form = await request.formData();
      if (form.get("confirm") !== "yes")
        throw new PersonaError("invalid", "선정과 첫 연락 예약을 확인해 주세요.");
      let input: typeof SelectContacts.Type;
      try {
        input = Schema.decodeUnknownSync(SelectContacts)({
          requestId: form.get("requestId"),
          count: Number(form.get("count")),
        });
      } catch {
        throw new PersonaError("invalid", "선정 인원은 1~100 사이 정수여야 합니다.");
      }
      view.requestId = input.requestId;
      view.count = input.count;
      view.attempted = true;
      view.selection = await operation("management.select", {}, () => client.select(input));
    }
    view.snapshot = await operation("management.list", {}, client.list);
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
