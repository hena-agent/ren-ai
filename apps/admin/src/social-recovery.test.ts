import { expect, test, vi } from "vitest";
import { fixture, request, legacy, initialDocuments } from "../test/fixtures.ts";
import { createAdmin } from "./admin.ts";
import { managementClient } from "./contact-client.ts";
import { socialAccount } from "../../../packages/onboarding/src/social.test-helper.ts";
import { Schema } from "effect";
import { SocialAuthInput } from "@ren-ai/onboarding/social-auth";
import { Window } from "happy-dom";
import { socialRoutes } from "./social-routes.ts";
import { loggedRequest } from "./logging.ts";

async function savedConnection() {
  const f = await fixture();
  await f.store.save({ ...legacy, id: "alice", name: "앨리스" }, initialDocuments, { persona: "" });
  const account = { ...socialAccount, platform: "threads" as const, handle: "" };
  const fetcher = vi.fn<typeof fetch>(async (input) =>
    new URL(new Request(input).url).pathname.endsWith("/social")
      ? Response.json({
          accounts: [
            { account, generation: 1, nextAt: null, state: "paused", turns: 0, writes: 0 },
          ],
          events: [],
          before: null,
        })
      : Response.json({ error: "SOCIAL_EXECUTOR_UNAVAILABLE" }, { status: 503 }),
  );
  const management = managementClient("https://api.test", "secret", fetcher);
  const admin = createAdmin(f.store, "test-password", {
    management,
    log: () => {},
  });
  return { ...f, admin, account, client: management.social! };
}

test("unexpected authentication reader errors keep the saved connection and show a safe lookup failure", async () => {
  const f = await savedConnection();
  f.client.authenticate = async () => {
    throw new Error("reader unavailable");
  };
  const incoming = request("/social?platform=threads&account=first");
  const response = await loggedRequest(
    incoming,
    () => socialRoutes(incoming, f.store, f.client),
    () => {},
  );
  const text = await response.text();
  expect(text).toContain("로그인 상태 조회에 실패했습니다");
  expect(text).toContain(f.account.invitation);
  expect(text).not.toContain("reader unavailable");
});

function storedForm(text: string, account: typeof socialAccount) {
  const window = new Window();
  window.document.write(text);
  const form = window.document.querySelector('input[name="username"]')!.closest("form")!;
  expect(form.querySelector('input[name="id"]')!.getAttribute("value")).toBe(account.id);
  expect(form.querySelector('input[name="invitation"]')!.getAttribute("value")).toBe(
    account.invitation,
  );
  return form;
}

test.each(["auth-check", "open"])(
  "failed %s preserves the existing connection and identifies the Mac executor error",
  async (action) => {
    const f = await savedConnection();
    const response = await f.admin(
      request("/social?platform=threads", {
        id: f.account.id,
        action,
        username: "PRIVATE_LOGIN",
        password: "PRIVATE_PASSWORD",
      }),
    );
    expect(response.status).toBe(503);
    const text = await response.text();
    const form = storedForm(text, f.account);
    expect(form.querySelector("select")!.value).toBe("alice");
    expect(text).toContain("Mac 소셜 실행기");
    expect(text).not.toContain("PRIVATE_");
  },
);

test("opening a sole existing connection keeps refresh separate from explicit new connection", async () => {
  const f = await savedConnection();
  const text = await (await f.admin(request("/social?platform=threads"))).text();
  const window = new Window();
  window.document.write(text);
  expect(
    window.document
      .querySelector('input[name="username"]')!
      .closest("form")!
      .querySelector('input[name="id"]')!
      .getAttribute("value"),
  ).toBe(f.account.id);
  expect(window.document.querySelector('a[href="/social?platform=threads&new=1"]')).not.toBeNull();
  expect(
    window.document.querySelector(`a[href="/social?platform=threads&account=${f.account.id}"]`),
  ).not.toBeNull();
  const fresh = new Window();
  fresh.document.write(await (await f.admin(request("/social?platform=threads&new=1"))).text());
  expect(
    fresh.document
      .querySelector('input[name="username"]')!
      .closest("form")!
      .querySelector('input[name="id"]')!
      .getAttribute("value"),
  ).toBe("");
});

test("invalid edits retain the stored connection instead of falling back to a new connection", async () => {
  const f = await savedConnection();
  const response = await f.admin(
    request("/social?platform=threads", { id: f.account.id, action: "save" }),
  );
  expect(response.status).toBe(400);
  storedForm(await response.text(), f.account);
  expect((await f.admin(request("/social?platform=threads", { id: f.account.id }))).status).toBe(
    400,
  );
});

test.each(["threads", "x"] as const)(
  "%s tab and connection form survive failed API reads without claiming the account list is empty",
  async (platform) => {
    const f = await fixture();
    const fetcher = vi.fn<typeof fetch>();
    const admin = createAdmin(f.store, "test-password", {
      management: managementClient("https://api.test", "secret", fetcher),
      log: () => {},
    });
    for (const failure of ["network", "http", "schema"]) {
      if (failure === "network") fetcher.mockRejectedValueOnce(new Error("offline"));
      else
        fetcher.mockResolvedValueOnce(
          failure === "http"
            ? new Response(null, { status: 503 })
            : Response.json({ invalid: true }),
        );
      const response = await admin(request(`/social?platform=${platform}`));
      expect(response.status).toBe(503);
      const page = await response.text();
      expect(page).toContain(`href="/social?platform=${platform}" aria-current="page"`);
      expect(page).toContain(`${platform === "x" ? "X" : "Threads"} 계정 연결`);
      expect(page).toContain("계정 목록을 불러오지 못했습니다");
      expect(page).toContain("활동 내역을 불러오지 못했습니다");
      expect(page).not.toContain("연결된 계정이 없습니다");
    }
  },
);

test("the selected X tab survives a Persona-store failure before the social API is reached", async () => {
  const f = await fixture();
  f.store.list = async () => {
    throw new Error("store unavailable");
  };
  const response = await createAdmin(f.store, "test-password", { log: () => {} })(
    request("/social?platform=x"),
  );
  expect(response.status).toBe(503);
  expect(await response.text()).toContain('href="/social?platform=x" aria-current="page"');
});

test("operators can check a manually logged-in account without saved credentials or submitting secrets", async () => {
  const f = await fixture();
  const fetcher = vi.fn<typeof fetch>(async (input) =>
    new URL(new Request(input).url).pathname.endsWith("/auth")
      ? Response.json({ state: "authenticated", hasCredentials: false })
      : Response.json({
          accounts: [
            {
              account: socialAccount,
              generation: 1,
              nextAt: null,
              state: "paused",
              turns: 0,
              writes: 0,
            },
          ],
          events: [],
          before: null,
        }),
  );
  const admin = createAdmin(f.store, "test-password", {
    management: managementClient("https://api.test", "secret", fetcher),
    log: () => {},
  });
  const page = await (await admin(request("/social?platform=x&account=first"))).text();
  expect(page).toContain("로그인됨");
  const window = new Window();
  window.document.write(page);
  expect(
    window.document.querySelector('button[value="auth-check"]')!.hasAttribute("disabled"),
  ).toBe(false);
  const response = await admin(
    request("/social?platform=x", { action: "auth-check", id: "first" }),
  );
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("/social?platform=x&account=first");
  expect(
    Schema.decodeUnknownSync(Schema.fromJsonString(SocialAuthInput))(
      fetcher.mock.calls.at(-1)![1]!.body,
    ),
  ).toEqual({ accountId: "first", command: { kind: "check" } });
});
