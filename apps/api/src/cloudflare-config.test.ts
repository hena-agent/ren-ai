import { expect, test } from "vitest";
import { cloudflareConfiguration } from "./cloudflare-config.ts";
import type { CloudflareBindings } from "./cloudflare-config.ts";

const bindings: CloudflareBindings = {
  PERSONA_CATALOG_URL: "https://admin.example",
  TOKEN_CATALOG: "catalog-secret",
  TURNSTILE_SECRET: "turnstile-secret",
  TOKEN_MANAGEMENT: "management-secret",
  API_MSG_URL: "https://api-msg.example",
  TOKEN_EXECUTOR: "executor-secret",
  REN_AI_APPLICATION_TOKEN: "plugin-secret",
};

const publicPersona = {
  id: "sora",
  name: "Sora",
  bio: "A musician",
  imageUrl: "/discovery/images/01234567-89ab-cdef-0123-456789abcdef.png",
  publicProfile: "A musician",
};

test("builds catalog and executor configuration with bootstrap enabled by default", async () => {
  const requested: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = input instanceof Request ? input.url : input.toString();
    requested.push(url);
    if (url.endsWith("/api/personas")) return Response.json([publicPersona]);
    return new Response("image");
  };
  const config = cloudflareConfiguration(bindings, fetcher);

  expect(config.bootstrapOnly).toBe(true);
  expect(config.execution).toEqual({
    apiMsgUrl: "https://api-msg.example/",
    openCodeUrl: "https://api-msg.example/opencode",
    imsgRpcUrl: "https://api-msg.example/imsg/rpc",
    executorToken: "executor-secret",
    applicationToken: "plugin-secret",
    model: "opencode-go/deepseek-v4.1-flash",
    directory: "/srv/ren-ai",
  });
  expect(await config.applicationStore.catalog()).toEqual([publicPersona]);
  expect(
    await (await config.applicationStore.image("01234567-89ab-cdef-0123-456789abcdef.png")).text(),
  ).toBe("image");
  expect(requested).toEqual([
    "https://admin.example/api/personas",
    "https://admin.example/discovery/images/01234567-89ab-cdef-0123-456789abcdef.png",
  ]);
});

test("honors explicit runtime settings and validates bootstrap and executor origin configuration", () => {
  const active = cloudflareConfiguration({
    ...bindings,
    BOOTSTRAP_ONLY: "false",
    PERSONA_MODEL: "test/model",
    OPENCODE_DIRECTORY: "/srv/custom-root",
  });
  expect(active.bootstrapOnly).toBe(false);
  expect(active.execution.model).toBe("test/model");
  expect(active.execution.directory).toBe("/srv/custom-root");
  expect(() => cloudflareConfiguration({ ...bindings, BOOTSTRAP_ONLY: "no" })).toThrow(
    "BOOTSTRAP_ONLY must be 'true' or 'false'",
  );
  expect(() =>
    cloudflareConfiguration({ ...bindings, API_MSG_URL: "http://api-msg.example" }),
  ).toThrow("API_MSG_URL must be a credential-free HTTPS origin");
  expect(() => cloudflareConfiguration({ ...bindings, TOKEN_MANAGEMENT: " " })).toThrow(
    "TOKEN_MANAGEMENT is required",
  );
});
