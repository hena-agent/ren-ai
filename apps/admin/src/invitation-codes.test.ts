import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { Schema } from "effect";
import { InvitationCreate, type InvitationTicket } from "@ren-ai/onboarding";
import { createAdmin } from "./admin.ts";
import { managementClient } from "./contact-client.ts";
import { InvitationCodes } from "./invitation-codes.tsx";
import { InvitationPanel } from "./invitation-panel.tsx";
import { fixture, request } from "../test/fixtures.ts";
import type { LogEntry } from "./logging.ts";

const setup = async () => {
  const f = await fixture();
  const receipts = new Map<string, typeof InvitationTicket.Type>();
  const inputs: (typeof InvitationCreate.Type)[] = [];
  const logs: LogEntry[] = [];
  let mode: "ok" | "disconnect" | "malformed" = "ok";
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const call = new Request(url, init);
    if (new URL(call.url).pathname.endsWith("/create")) {
      const input = Schema.decodeUnknownSync(InvitationCreate)(await call.json());
      inputs.push(input);
      const code = receipts.get(input.requestId) ?? {
        token: input.code ?? "a".repeat(64),
        maxUses: input.maxUses,
        grantCount: input.grantCount,
        usedCount: 1,
        createdAt: 1,
        redeemedAt: 2,
      };
      receipts.set(input.requestId, code);
      if (mode === "disconnect") throw new Error("connection lost");
      return Response.json(mode === "malformed" ? {} : code);
    }
    return Response.json({
      entries: [],
      eligibleCount: 0,
      invitationCodes: [...receipts.values()],
    });
  });
  return {
    admin: createAdmin(f.store, "test-password", {
      management: managementClient("https://api.test", "secret", fetcher),
      log: (event) => logs.push(event),
    }),
    inputs,
    logs,
    fetcher,
    mode: (next: typeof mode) => {
      mode = next;
    },
  };
};
const codeForm = (html: string) =>
  html
    .match(/<form\b[^>]*>[\s\S]*?<\/form>/g)!
    .find((form) => form.includes('value="invitation-create"'))!;
const id = (html: string) => /name="requestId" value="([^"]+)"/.exec(codeForm(html))![1]!;

test("Admin creates contact-free codes with two inherited settings, preserves uncertain requests, and exposes shareable history", async () => {
  const f = await setup();
  const page = await (await f.admin(request("/waitlist"))).text();
  expect(page).toContain("연락처 없이 초대 코드 만들기");
  expect(page).toContain("인원 한도는 코드마다 따로 적용");
  const fields = {
    action: "invitation-create",
    requestId: id(page),
    code: " THREAD20 ",
    maxUses: "20",
    grantCount: "2",
  };
  f.mode("disconnect");
  const failed = await f.admin(request("/waitlist", fields));
  expect(failed.status).toBe(503);
  const retry = await failed.text();
  expect(id(retry)).toBe(fields.requestId);
  expect(retry).toContain("같은 코드 생성 요청 확인");
  expect(codeForm(retry)).toContain('value="THREAD20"');
  expect(codeForm(retry)).toContain('readOnly=""');
  expect(codeForm(retry)).toContain('value="20"');
  f.mode("ok");
  const completed = await f.admin(request("/waitlist", fields));
  expect(completed.status).toBe(200);
  const history = await completed.text();
  expect(id(history)).not.toBe(fields.requestId);
  expect(history).toContain("https://renai.im/explore#invite=THREAD20");
  expect(history).toContain("1/20명 사용 · 선정자에게 2개 지급");
  expect(f.inputs[0]).toEqual(f.inputs[1]);
  expect(f.inputs[0]).not.toHaveProperty("handle");
  await f.admin(
    request("/waitlist", {
      action: fields.action,
      requestId: id(history),
      maxUses: "1",
      grantCount: "0",
    }),
  );
  expect(f.inputs[2]).not.toHaveProperty("code");
  const later = await (await f.admin(request("/waitlist"))).text();
  expect(later).toContain("https://renai.im/explore#invite=" + "a".repeat(64));
  expect(JSON.stringify(f.logs)).not.toContain("THREAD20");
  expect(JSON.stringify(f.logs)).not.toContain("secret");
});

test("code creation validates inputs and same-origin posts and reports malformed API results", async () => {
  const f = await setup();
  const fields = {
    action: "invitation-create",
    requestId: randomUUID(),
    code: "THREAD20",
    maxUses: "20",
    grantCount: "2",
  };
  for (const bad of [
    { code: "bad code" },
    { maxUses: "0" },
    { grantCount: "-1" },
    { requestId: "invalid" },
  ])
    expect((await f.admin(request("/waitlist", { ...fields, ...bad }))).status).toBe(400);
  const foreign = request("/waitlist", fields);
  foreign.headers.set("origin", "https://other.test");
  expect((await f.admin(foreign)).status).toBe(400);
  expect(f.fetcher).not.toHaveBeenCalled();
  f.mode("malformed");
  const malformed = await f.admin(request("/waitlist", fields));
  expect(malformed.status).toBe(503);
  expect(await malformed.text()).toContain("초대 코드 응답 형식이 올바르지 않습니다.");
});

test("usage-aware manual invitation history keeps partially used codes available and hides exhausted links", () => {
  expect(
    renderToStaticMarkup(createElement(InvitationCodes, { view: undefined, codes: undefined })),
  ).toBe("");
  expect(
    renderToStaticMarkup(
      createElement(InvitationCodes, {
        view: { requestId: "id", handle: "", locale: "ko", kind: "basic", attempted: false },
        codes: [],
      }),
    ),
  ).toBe("");
  const partial = {
    token: "PARTIAL",
    createdAt: 1,
    redeemedAt: 2,
    usedCount: 1,
    maxUses: 20,
    grantCount: 2,
    kind: "basic" as const,
    state: "sent" as const,
  };
  const markup = renderToStaticMarkup(
    createElement(InvitationPanel, {
      view: {
        requestId: "id",
        handle: "+821011111111",
        locale: "ko",
        kind: "basic",
        attempted: false,
        account: {
          handle: "+821011111111",
          basicGranted: true,
          extraCount: 0,
          invitations: [partial, { ...partial, token: "FULL", usedCount: 20 }],
        },
      },
    }),
  );
  expect(markup).toContain("1/20명 사용 · 선정자에게 2개 지급");
  expect(markup).toContain("https://renai.im/explore#invite=PARTIAL");
  expect(markup).not.toContain("#invite=FULL");
});
