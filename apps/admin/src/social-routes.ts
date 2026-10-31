import { Schema } from "effect";
import { PersonaError, type PersonaStore } from "@ren-ai/personas";
import { SocialAccount } from "@ren-ai/onboarding/social";
import type { SocialClient } from "./social-client.ts";
import { socialPage, type SocialView } from "./social-page.tsx";
import { html } from "./html-response.ts";
import { operation, protect, reportFailure, requestId } from "./logging.ts";

const numberFields = [
  "startHour",
  "endHour",
  "intervalMinutes",
  "runMinutes",
  "dailyTurns",
  "dailyWrites",
] as const;
function readAccount(form: FormData, existing: SocialAccount | undefined) {
  const handle = form.get("handle");
  if (typeof handle !== "string") throw new PersonaError("invalid", "X 계정명을 입력해 주세요.");
  const fields = Object.fromEntries(form);
  delete fields["action"];
  try {
    return Schema.decodeUnknownSync(SocialAccount)({
      ...fields,
      ...Object.fromEntries(numberFields.map((field) => [field, Number(form.get(field))])),
      id: existing?.id ?? `x_${handle.toLowerCase()}`,
      handle,
      enabled: form.get("enabled") === "1",
    });
  } catch {
    throw new PersonaError("invalid", "X 계정명·페르소나·활동 설정을 확인해 주세요.");
  }
}
export async function socialRoutes(request: Request, store: PersonaStore, client?: SocialClient) {
  const url = new URL(request.url);
  const view: SocialView = {
    personas: [],
    ...(url.searchParams.get("persona") && { personaId: url.searchParams.get("persona")! }),
  };
  try {
    view.personas = await operation("social.personas", {}, store.list);
    if (!client) throw new PersonaError("invalid", "소셜 API 연결 설정이 필요합니다.");
    const before = url.searchParams.get("before");
    view.snapshot = await operation("social.read", {}, () =>
      client.list(before === null ? undefined : Number(before)),
    );
    const selected = view.snapshot.accounts.find(
      ({ account }) => account.id === url.searchParams.get("account"),
    )?.account;
    if (selected) view.selected = selected;
    if (request.method === "GET") return html(socialPage(view));
    if (request.headers.get("origin") !== url.origin)
      throw new PersonaError("invalid", "같은 Admin 화면에서 제출해 주세요.");
    const form = await request.formData();
    const action = form.get("action");
    const existing = view.snapshot.accounts.find(
      ({ account }) => account.id === form.get("id"),
    )?.account;
    if (action === "save") {
      const account = readAccount(form, existing);
      protect(account.instructions, account.invitation);
      await operation("social.configure", { personaId: account.personaId }, () =>
        client.configure(account),
      );
    } else {
      if (!existing) throw new PersonaError("not_found", "연결된 X 계정을 찾을 수 없습니다.");
      if (action === "toggle")
        await operation("social.configure", { personaId: existing.personaId }, () =>
          client.configure({ ...existing, enabled: !existing.enabled }),
        );
      else if (action === "open" || action === "now")
        await operation("social.operate", { personaId: existing.personaId }, () =>
          client.operate(action, existing.id),
        );
      else throw new PersonaError("invalid", "알 수 없는 소셜 작업입니다.");
    }
    return new Response(null, { status: 303, headers: { Location: "/social" } });
  } catch (cause) {
    reportFailure(cause, { stage: "social.request" });
    view.error = `소셜 요청을 완료하지 못했습니다. 계정·초대 코드·API 연결을 확인해 주세요. 요청 ID: ${requestId()}`;
    return html(socialPage(view), cause instanceof PersonaError ? 400 : 503);
  }
}
