import { Schema } from "effect";
import { PersonaError, type PersonaStore } from "@ren-ai/personas";
import { SocialAccount } from "@ren-ai/onboarding/social";
import type { SocialClient } from "./social-client.ts";
import { socialPage, type SocialView } from "./social-page.tsx";
import { html } from "./html-response.ts";
import { operation, protect, reportFailure, requestId } from "./logging.ts";
import { SocialAuthCommand } from "@ren-ai/onboarding/social-auth";

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
  for (const name of ["action", "username", "password", "code"]) delete fields[name];
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
async function loadAuthentication(view: SocialView, client: SocialClient) {
  if (!view.selected) return;
  try {
    view.authentication = await client.authenticate(view.selected.id, { kind: "status" });
  } catch (cause) {
    reportFailure(cause, { stage: "social.auth.read" });
  }
}
function readAuthentication(form: FormData, kind: string) {
  try {
    return Schema.decodeUnknownSync(SocialAuthCommand)({
      kind,
      ...(kind === "save" && { username: form.get("username"), password: form.get("password") }),
      ...(kind === "code" && { code: form.get("code") }),
    });
  } catch {
    throw new PersonaError("invalid", "로그인 정보·인증코드를 확인해 주세요.");
  }
}
const redirectAccount = (id: string) =>
  new Response(null, {
    status: 303,
    headers: { Location: `/social?account=${encodeURIComponent(id)}` },
  });
async function saveConnection(
  form: FormData,
  existing: SocialAccount | undefined,
  view: SocialView,
  client: SocialClient,
) {
  const account = readAccount(form, existing);
  const command =
    !existing || form.get("username") || form.get("password")
      ? readAuthentication(form, "save")
      : undefined;
  protect(account.instructions, account.invitation);
  view.snapshot = await operation("social.configure", { personaId: account.personaId }, () =>
    client.configure(account),
  );
  view.selected = account;
  if (command) {
    try {
      await operation("social.auth", { personaId: account.personaId }, () =>
        client.authenticate(account.id, command),
      );
    } catch (cause) {
      view.error =
        "계정 연결은 저장됐지만 로그인 요청을 시작하지 못했습니다. ID·비밀번호를 다시 입력하고 저장해 주세요.";
      throw cause;
    }
  }
  return redirectAccount(account.id);
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
    if (request.method === "GET") {
      await loadAuthentication(view, client);
      return html(socialPage(view));
    }
    if (request.headers.get("origin") !== url.origin)
      throw new PersonaError("invalid", "같은 Admin 화면에서 제출해 주세요.");
    const form = await request.formData();
    protect(
      ...["username", "password", "code"].flatMap((name) => {
        const value = form.get(name);
        return typeof value === "string" ? [value] : [];
      }),
    );
    const action = form.get("action");
    const existing = view.snapshot.accounts.find(
      ({ account }) => account.id === form.get("id"),
    )?.account;
    if (action === "save") return await saveConnection(form, existing, view, client);
    if (!existing) throw new PersonaError("not_found", "연결된 X 계정을 찾을 수 없습니다.");
    if (action === "auth-code" || action === "auth-login" || action === "auth-forget") {
      const command = readAuthentication(form, action.slice(5));
      await operation("social.auth", { personaId: existing.personaId }, () =>
        client.authenticate(existing.id, command),
      );
      return redirectAccount(existing.id);
    }
    if (action === "toggle")
      await operation("social.configure", { personaId: existing.personaId }, () =>
        client.configure({ ...existing, enabled: !existing.enabled }),
      );
    else if (action === "open" || action === "now")
      await operation("social.operate", { personaId: existing.personaId }, () =>
        client.operate(action, existing.id),
      );
    else throw new PersonaError("invalid", "알 수 없는 소셜 작업입니다.");
    return new Response(null, { status: 303, headers: { Location: "/social" } });
  } catch (cause) {
    reportFailure(cause, { stage: "social.request" });
    view.error = `${
      view.error ??
      "소셜 요청을 완료하지 못했습니다. 계정·초대 코드·로그인 정보·API 연결을 확인해 주세요."
    } 요청 ID: ${requestId()}`;
    return html(socialPage(view), cause instanceof PersonaError ? 400 : 503);
  }
}
