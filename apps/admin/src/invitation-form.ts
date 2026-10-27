import { randomUUID } from "node:crypto";
import { Schema } from "effect";
import { InvitationGrant, InvitationLookup, normalizeHandle } from "@ren-ai/onboarding";
import { PersonaError } from "@ren-ai/personas";
import type { InvitationView } from "./invitation-panel.tsx";
import type { ManagementClient } from "./contact-client.ts";
import { operation } from "./logging.ts";

export async function submitInvitations(
  form: FormData,
  view: InvitationView,
  client: ManagementClient,
) {
  let input: typeof InvitationLookup.Type;
  try {
    input = Schema.decodeUnknownSync(InvitationLookup)({
      handle: normalizeHandle(form.get("handle")),
    });
  } catch {
    throw new PersonaError("invalid", "유효한 휴대전화 번호를 입력해 주세요.");
  }
  view.handle = input.handle;
  if (form.get("action") === "invitation-lookup") {
    view.account = await operation("management.invitationLookup", {}, () =>
      client.invitationAccount(input),
    );
    return;
  }
  let grant: typeof InvitationGrant.Type;
  try {
    grant = Schema.decodeUnknownSync(InvitationGrant)({
      ...input,
      requestId: form.get("requestId"),
      kind: form.get("kind"),
      locale: form.get("locale"),
    });
  } catch {
    throw new PersonaError("invalid", "초대장 지급 종류와 안내 언어를 다시 선택해 주세요.");
  }
  Object.assign(view, {
    requestId: grant.requestId,
    kind: grant.kind,
    locale: grant.locale,
    attempted: true,
  });
  view.account = await operation("management.invitationGrant", {}, () =>
    client.grantInvitations(grant),
  );
  Object.assign(view, { requestId: randomUUID(), attempted: false, queued: true });
}
