import { randomUUID } from "node:crypto";
import { Schema } from "effect";
import {
  InvitationGrant,
  InvitationLookup,
  InvitationCreate,
  normalizeHandle,
} from "@ren-ai/onboarding";
import { PersonaError } from "@ren-ai/personas";
import type { InvitationView } from "./invitation-panel.tsx";
import type { ManagementClient } from "./contact-client.ts";
import { operation } from "./logging.ts";

export async function submitInvitations(
  form: FormData,
  view: InvitationView,
  client: ManagementClient,
) {
  if (form.get("action") === "invitation-create") {
    let input: typeof InvitationCreate.Type;
    try {
      const code =
        Schema.decodeUnknownSync(Schema.NullOr(Schema.String))(form.get("code"))?.trim() ?? "";
      input = Schema.decodeUnknownSync(InvitationCreate)({
        requestId: form.get("requestId"),
        ...(code && { code }),
        maxUses: Number(form.get("maxUses")),
        grantCount: Number(form.get("grantCount")),
      });
    } catch {
      throw new PersonaError(
        "invalid",
        "코드(영문·숫자·밑줄·하이픈 1~64자), 최대 사용 인원(1~10000), 지급 수(0~100)를 확인해 주세요.",
      );
    }
    view.creation = { ...input, attempted: true };
    await operation("management.invitationCreate", {}, () => client.createInvitation(input));
    view.creation = { requestId: randomUUID(), maxUses: 1, grantCount: 2, attempted: false };
    return;
  }
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
      ...(form.has("maxUses") && { maxUses: Number(form.get("maxUses")) }),
      ...(form.has("grantCount") && { grantCount: Number(form.get("grantCount")) }),
    });
  } catch {
    throw new PersonaError(
      "invalid",
      "초대장 지급 종류·안내 언어·최대 사용 인원(1~10000)·지급 수(0~100)를 확인해 주세요.",
    );
  }
  Object.assign(view, {
    requestId: grant.requestId,
    kind: grant.kind,
    locale: grant.locale,
    attempted: true,
    maxUses: grant.maxUses,
    grantCount: grant.grantCount,
  });
  view.account = await operation("management.invitationGrant", {}, () =>
    client.grantInvitations(grant),
  );
  Object.assign(view, { requestId: randomUUID(), attempted: false, queued: true });
}
