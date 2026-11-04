import { expect, test, vi } from "vitest";
import { Window } from "happy-dom";
import { Schema } from "effect";
import { socialAccount } from "../../../packages/onboarding/src/social.test-helper.ts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SocialFailureDetails } from "./social-diagnostic.tsx";
import { socialImageResponse } from "./social-image-response.ts";
import { SocialAccount, type SocialSnapshot } from "@ren-ai/onboarding/social";
import type { SocialImage } from "@ren-ai/onboarding/social-images";
import { socialPage } from "./social-page.tsx";
import { fixture, request } from "../test/fixtures.ts";
import { createAdmin } from "./admin.ts";
import { managementClient } from "./contact-client.ts";

const account = {
  ...socialAccount,
  platform: "threads" as const,
  images: { enabled: true, credits: 4, style: "photo" as const },
};
const draft: SocialImage = {
  id: "draft",
  accountId: account.id,
  personaId: account.personaId,
  generation: 1,
  kind: "self",
  style: "photo",
  state: "ready",
  probability: 6000,
  roll: 3000,
  kindRoll: 4000,
  createdAt: 1,
};
const snapshot = (images: readonly SocialImage[] = []): SocialSnapshot => ({
  accounts: [
    { account, generation: 1, state: "paused", nextAt: null, turns: 0, writes: 0, imageSpent: 1 },
  ],
  events: [],
  before: null,
  imageSupport: true,
  imageAllowance: { spent: 1, approved: 4 },
  images,
});
test("image settings are capability gated and distinguish generation allowance from a daily target", () => {
  const window = new Window();
  window.document.write(socialPage({ personas: [], selected: account, snapshot: snapshot() }));
  expect(
    window.document.querySelector('input[name="imagesEnabled"]')!.hasAttribute("checked"),
  ).toBe(true);
  expect(window.document.querySelector('input[name="imageCredits"]')!.getAttribute("value")).toBe(
    "4",
  );
  expect(window.document.body.textContent).toContain("일일 생성 목표가 아닙니다");
  expect(window.document.body.textContent).toContain("유료 생성 승인 한도 사용 1/4");
  window.document.body.innerHTML = socialPage({
    personas: [],
    selected: socialAccount,
    snapshot: { accounts: [], events: [], before: null },
  });
  expect(window.document.querySelector('input[name="imageCredits"]')).toBeNull();
});

test("new and disabled image policies have safe defaults while creation previews and diagnostic certainty remain distinct", async () => {
  const window = new Window();
  window.document.write(
    socialPage({
      personas: [],
      snapshot: { accounts: [], events: [], before: null, imageSupport: true },
    }),
  );
  expect(window.document.querySelector('input[name="imageCredits"]')!.getAttribute("value")).toBe(
    "0",
  );
  const state = {
    ...snapshot([{ ...draft, kind: "creation", state: "approved" }]),
    accounts: [
      {
        account: { ...account, images: { ...account.images, enabled: false } },
        generation: 1,
        state: "paused",
        nextAt: null,
        turns: 0,
        writes: 0,
      },
    ],
  };
  window.document.body.innerHTML = socialPage({ personas: [], snapshot: state });
  expect(
    window.document
      .querySelector('section[aria-label="소셜 이미지 작업"] img')!
      .getAttribute("alt"),
  ).toContain("페르소나의 창작");
  expect(window.document.body.textContent).toContain("새 생성 중지");
  for (const submission of ["not_attempted", "verified"] as const) {
    const html = renderToStaticMarkup(
      createElement(SocialFailureDetails, {
        diagnostic: {
          requestId: "request",
          stage: "receipt",
          submission,
          code: "FAILED",
          at: 1,
          durationMs: 0,
          postId: "123",
          revision: "development",
          upstreamRequestId: "10000000-0000-4000-8000-000000000001",
        },
      }),
    );
    expect(html).toContain("development");
    expect(html).toContain("123");
  }
  await expect(
    socialImageResponse(request("/social/images/first/draft"), undefined),
  ).rejects.toThrow("소셜 API 연결 설정이 필요합니다");
});
test("the social image panel supports older snapshots without the optional allowance summary", () => {
  const { imageAllowance: _allowance, ...older } = snapshot();
  const window = new Window();
  window.document.write(socialPage({ personas: [], snapshot: older }));
  expect(window.document.querySelector('section[aria-label="소셜 이미지 작업"]')).not.toBeNull();
});
test.each(["ready", "approved", "posted", "uncertain", "failed"] as const)(
  "Admin shows separate generation/review/publication state and private previews: %s",
  (state) => {
    const window = new Window();
    window.document.write(
      socialPage({
        personas: [],
        snapshot: snapshot([
          {
            ...draft,
            state,
            kind: state === "failed" ? "creation" : "self",
            diagnostic: {
              requestId: "request",
              stage: "generation",
              submission: "attempted",
              code: "GENERATION_FAILED",
              at: 1,
              durationMs: 123,
              causeCode: "PROVIDER_FAILED",
              upstreamStatus: 503,
              stack: "at image.ts:1:2",
            },
          },
        ]),
      }),
    );
    const panel = window.document.querySelector('section[aria-label="소셜 이미지 작업"]')!;
    expect(panel.textContent).toContain("dice 3000 / 10000");
    expect(panel.querySelector("details")!.textContent).toContain("PROVIDER_FAILED");
    expect(Boolean(panel.querySelector("img"))).toBe(
      ["ready", "approved", "posted"].includes(state),
    );
    expect(panel.textContent).not.toContain("PRIVATE_SCENE");
  },
);
test("the image workspace remains useful when no draft exists yet", () => {
  const window = new Window();
  window.document.write(socialPage({ personas: [], snapshot: snapshot() }));
  expect(
    window.document.querySelector('section[aria-label="소셜 이미지 작업"]')?.textContent,
  ).toContain("표시할 이미지 작업이 없습니다.");
});
test("operator configuration is parsed into a scoped policy and preview bytes stay behind Admin authentication", async () => {
  const f = await fixture();
  let configured: SocialAccount | undefined;
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const incoming = new Request(input, init);
    const path = new URL(incoming.url).pathname;
    if (path.endsWith("/accounts")) {
      configured = Schema.decodeUnknownSync(Schema.fromJsonString(SocialAccount))(
        await incoming.text(),
      );
      return Response.json(snapshot());
    }
    if (path.endsWith("/image-preview"))
      return Response.json({
        id: "draft",
        mime: "image/jpeg",
        data: Buffer.from([255, 216, 255, 217]).toString("base64"),
      });
    if (path.endsWith("/auth"))
      return Response.json({
        state: "authenticated",
        hasCredentials: true,
        handle: account.handle,
      });
    return Response.json(snapshot());
  });
  const admin = createAdmin(f.store, "test-password", {
    management: managementClient("https://api.test", "secret", fetcher),
    log: () => {},
  });
  const fields = Object.fromEntries(
    Object.entries(socialAccount).flatMap(([key, value]) =>
      typeof value === "object" ? [] : [[key, String(value)]],
    ),
  );
  expect(
    (
      await admin(
        request("/social?platform=threads", {
          ...fields,
          platform: "threads",
          action: "save",
          imagesEnabled: "1",
          imageCredits: "8",
          imageStyle: "anime",
        }),
      )
    ).status,
  ).toBe(303);
  expect(configured?.images).toEqual({ enabled: true, credits: 8, style: "anime" });
  const preview = await admin(request("/social/images/first/draft"));
  expect(preview.status).toBe(200);
  expect(preview.headers.get("cache-control")).toBe("no-store");
  expect(new Uint8Array(await preview.arrayBuffer())).toEqual(new Uint8Array([255, 216, 255, 217]));
  expect((await admin(new Request("https://admin.test/social/images/first/draft"))).status).toBe(
    401,
  );
  expect((await admin(request("/social/images/first/draft", {}))).status).toBe(405);
});

test("invalid preview responses are diagnosed without copying private image payloads to the page or logs", async () => {
  const f = await fixture(),
    logs: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ id: "draft", data: "PRIVATE_IMAGE_BYTES", mime: "wrong" }),
  );
  const admin = createAdmin(f.store, "test-password", {
    management: managementClient("https://api.test", "secret", fetcher),
    log: (event) => {
      logs.push(JSON.stringify(event));
    },
  });
  const response = await admin(request("/social/images/first/draft"));
  expect(response.status).toBe(503);
  expect((await response.text()) + logs.join("")).not.toContain("PRIVATE_IMAGE_BYTES");
  expect(logs.join("")).toContain("social_image_schema");
});
