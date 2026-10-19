import { Context, Effect } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { vi } from "vitest";
import { discoveryNotice, type DiscoveryRequest } from "@ren-ai/onboarding";
import type { remoteMessages } from "@ren-ai/imsg/client";
import { contactFixture } from "./contact.test-helper.ts";
import { makeDiscoveryWeb } from "./discovery.ts";
import { contactManagement } from "./management.ts";
import { waitlistNotifications } from "./notifications.ts";
import type { ContactDiagnostic } from "./diagnostics.ts";

export const notificationFixture = Effect.gen(function* () {
  const f = yield* contactFixture;
  const web = yield* makeDiscoveryWeb({
    catalog: async () => f.profiles,
    turnstileSecret: "secret",
  });
  yield* Effect.addFinalizer(() => Effect.promise(web.dispose));
  const verified = HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ success: true }))),
  );
  type Transport = Effect.Success<ReturnType<typeof remoteMessages>>;
  const notify = vi.fn<Transport["notify"]>((_handle, _text) =>
    Effect.succeed({ guid: "notification-guid", requestId: "mac-request" }),
  );
  const notificationStatus = vi.fn<Transport["notificationStatus"]>(() =>
    Effect.succeed({ state: "delivered", error: 0, dateRead: null }),
  );
  const logs: ContactDiagnostic[] = [];
  const reopen = () =>
    waitlistNotifications({ notify, notificationStatus }, (event) => logs.push(event));
  const worker = yield* reopen();
  const management = contactManagement(f.store, "management", () => {});
  const join = (overrides: Partial<DiscoveryRequest> = {}) =>
    Effect.promise(() =>
      web.handler(
        new Request("https://api.test/discovery/waitlist", {
          method: "POST",
          headers: { "Content-Type": "application/json", "cf-connecting-ip": crypto.randomUUID() },
          body: JSON.stringify({
            handle: "+821012345678",
            locale: "en",
            conversationLanguage: "ja",
            privacyNoticeVersion: discoveryNotice.version,
            turnstileToken: "human",
            likedPersonaIDs: ["luna"],
            ...overrides,
          }),
        }),
        Context.make(HttpClient.HttpClient, verified),
      ),
    );
  const snapshot = Effect.promise(async () =>
    (
      await management(
        new Request("https://api.test/management/discovery", {
          headers: { Authorization: "Bearer management" },
        }),
      )
    ).json(),
  );
  return { ...f, ...worker, join, snapshot, notify, notificationStatus, reopen, logs };
});
