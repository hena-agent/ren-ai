import { randomUUID } from "node:crypto";
import { Schema } from "effect";
import { expect, test, vi } from "vitest";
import { InvitationGrant, InvitationLookup } from "@ren-ai/onboarding";
import type { InvitationAccount } from "@ren-ai/onboarding";
import { createAdmin } from "./admin.ts";
import { managementClient } from "./contact-client.ts";
import { fixture, request } from "../test/fixtures.ts";
import type { LogEntry } from "./logging.ts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InvitationPanel } from "./invitation-panel.tsx";

const phone = "+821011111111";
test("the invitation history distinguishes settled sends, uncertain sends and used links without exposing a used link", () => {
  expect(renderToStaticMarkup(createElement(InvitationPanel, { view: undefined }))).toBe("");
  const used = "e".repeat(64);
  const html = renderToStaticMarkup(
    createElement(InvitationPanel, {
      view: {
        requestId: randomUUID(),
        handle: phone,
        kind: "basic",
        locale: "ko",
        attempted: false,
        account: {
          handle: phone,
          basicGranted: true,
          extraCount: 2,
          invitations: [
            { token: used, kind: "basic", createdAt: 1, redeemedAt: 2, state: "sent" },
            {
              token: "f".repeat(64),
              kind: "basic",
              createdAt: 1,
              redeemedAt: null,
              state: "uncertain",
            },
            {
              token: "a".repeat(64),
              kind: "extra",
              createdAt: 1,
              redeemedAt: null,
              state: "failed",
            },
            {
              token: "b".repeat(64),
              kind: "extra",
              createdAt: 1,
              redeemedAt: null,
              state: "skipped",
            },
          ],
        },
      },
    }),
  );
  expect(html).toContain("기본 · 사용 완료 · 발송 완료");
  expect(html).toContain("발송 결과 불확실");
  expect(html).toContain("발송 실패");
  expect(html).toContain("한도 초과·발송 생략");
  expect(html).not.toContain(used);
  expect(html).toContain(`https://renai.im/explore#invite=${"f".repeat(64)}`);
});
const formID = (html: string) => {
  const form = html
    .match(/<form\b[^>]*>[\s\S]*?<\/form>/g)!
    .find((item) => item.includes('value="invitation-grant"'))!;
  return /name="requestId" value="([^"]+)"/.exec(form)![1]!;
};
const setup = async () => {
  const f = await fixture();
  let account: typeof InvitationAccount.Type = {
    handle: phone,
    basicGranted: false,
    extraCount: 0,
    invitations: [],
  };
  let interrupted = false;
  let badReply = false;
  const receipts = new Set<string>();
  const submissions: (typeof InvitationGrant.Type)[] = [];
  const logs: LogEntry[] = [];
  const grantAccount = async (call: Request) => {
    const grant = Schema.decodeUnknownSync(InvitationGrant)(await call.json());
    submissions.push(grant);
    if (!receipts.has(grant.requestId)) {
      if (grant.kind === "basic" && account.basicGranted)
        return new Response(null, { status: 409 });
      const count = grant.kind === "basic" ? 2 : 1;
      account = {
        ...account,
        basicGranted: account.basicGranted || grant.kind === "basic",
        extraCount: account.extraCount + (grant.kind === "extra" ? 1 : 0),
        invitations: [
          ...account.invitations,
          ...Array.from({ length: count }, (_, index) => ({
            token: String(account.invitations.length + index).padStart(64, "0"),
            createdAt: 1,
            redeemedAt: null,
            kind: grant.kind,
            state: "queued" as const,
          })),
        ],
      };
      receipts.add(grant.requestId);
    }
    if (interrupted) {
      interrupted = false;
      throw new Error("connection closed");
    }
    return Response.json(badReply ? {} : account);
  };
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const call = new Request(input, init);
    const path = new URL(call.url).pathname;
    if (path.endsWith("/lookup")) {
      expect(Schema.decodeUnknownSync(InvitationLookup)(await call.json()).handle).toBe(phone);
      return Response.json(account);
    }
    if (path.endsWith("/grant")) return grantAccount(call);
    return Response.json({ entries: [], eligibleCount: 0, invitationSettings: { enabled: false } });
  });
  const admin = createAdmin(f.store, "test-password", {
    management: managementClient("https://api.test", "secret-token", fetcher),
    log: (event) => logs.push(event),
  });
  return {
    admin,
    submissions,
    logs,
    fetcher,
    interrupt: () => {
      interrupted = true;
    },
    invalidReply: () => {
      badReply = true;
    },
    account: () => account,
  };
};

test("Admin normalizes a phone, grants fixed basics and individual extras with automatic issuance OFF, and preserves uncertain submissions", async () => {
  const f = await setup();
  const initial = await f.admin(request("/waitlist"));
  expect(await initial.text()).toContain("전화번호로 초대장 지급");
  const lookup = await f.admin(
    request("/waitlist", { action: "invitation-lookup", handle: "010-1111-1111" }),
  );
  const page = await lookup.text();
  expect(page).toContain("미등록 번호도 가능");
  expect(page).toContain("기본 지급: 미지급");
  const id = formID(page);
  const fields = {
    action: "invitation-grant",
    handle: phone,
    requestId: id,
    kind: "basic",
    locale: "en",
    maxUses: "20",
    grantCount: "2",
  };
  f.interrupt();
  const failed = await f.admin(request("/waitlist", fields));
  expect(failed.status).toBe(503);
  const retryPage = await failed.text();
  expect(retryPage).toContain("같은 지급 요청 확인");
  expect(formID(retryPage)).toBe(id);
  expect(retryPage).toContain('name="kind" value="basic"');
  expect(retryPage).toContain('name="locale" value="en"');
  const retried = await f.admin(request("/waitlist", fields));
  expect(retried.status).toBe(200);
  const after = await retried.text();
  expect(after).toContain("iMessage 발송을 예약했습니다");
  expect(after).toContain("기본 지급: 지급 완료");
  expect(formID(after)).not.toBe(id);
  expect(f.account().invitations).toHaveLength(2);
  expect(f.submissions[0]).toEqual(f.submissions[1]);
  const extra = await f.admin(
    request("/waitlist", { ...fields, kind: "extra", requestId: formID(after) }),
  );
  expect(extra.status).toBe(200);
  expect(await extra.text()).toContain("추가 지급: 1장");
  expect(f.account().invitations).toHaveLength(3);
  const conflict = await f.admin(request("/waitlist", { ...fields, requestId: randomUUID() }));
  expect(conflict.status).toBe(400);
  expect(await conflict.text()).toContain("이미 기본 2장을 지급했거나");
  const log = f.logs.find((event) => event.code === "management_transport");
  expect(log?.requestId).toBe(failed.headers.get("x-request-id"));
  expect(JSON.stringify(f.logs)).not.toContain(phone);
  expect(JSON.stringify(f.logs)).not.toContain("secret-token");
});

test("manual invitation forms reject invalid inputs and foreign-origin posts and safely explain malformed upstream replies", async () => {
  const f = await setup();
  for (const fields of [
    { action: "invitation-lookup", handle: "not a phone" },
    {
      action: "invitation-grant",
      handle: phone,
      requestId: randomUUID(),
      kind: "ten",
      locale: "ko",
    },
  ])
    expect((await f.admin(request("/waitlist", fields))).status).toBe(400);
  expect(f.fetcher).not.toHaveBeenCalled();
  const foreign = request("/waitlist", { action: "invitation-grant", handle: phone });
  foreign.headers.set("origin", "https://other.test");
  expect((await f.admin(foreign)).status).toBe(400);
  f.invalidReply();
  const invalid = await f.admin(
    request("/waitlist", {
      action: "invitation-grant",
      handle: phone,
      requestId: randomUUID(),
      kind: "extra",
      locale: "ko",
    }),
  );
  expect(invalid.status).toBe(503);
  expect(await invalid.text()).toContain("초대장 응답 형식이 올바르지 않습니다");
  expect(JSON.stringify(f.logs)).not.toContain(phone);
});
