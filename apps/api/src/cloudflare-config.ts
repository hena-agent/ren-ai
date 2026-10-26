import { catalogClient } from "./personas/catalog.ts";
import type { ApplicationStoreConfig } from "./application-store.ts";
import type { R2Bucket } from "@cloudflare/workers-types";

export interface CloudflareBindings {
  readonly PERSONA_CATALOG_URL: string;
  readonly TOKEN_CATALOG?: string;
  readonly TURNSTILE_SECRET?: string;
  readonly TOKEN_MANAGEMENT?: string;
  readonly API_MSG_URL: string;
  readonly PERSONA_MODEL?: string;
  readonly OPENCODE_DIRECTORY?: string;
  readonly BOOTSTRAP_ONLY?: string;
  readonly DISCORD_WEBHOOK_URL?: string;
  readonly CODEX_IMAGE_API_KEY?: string;
  readonly CONVERSATION_PHOTOS?: R2Bucket;
}

export interface CloudflareConfiguration {
  readonly applicationStore: Omit<ApplicationStoreConfig, "httpClient">;
  readonly bootstrapOnly: boolean;
  readonly execution: {
    readonly apiMsgUrl: string;
    readonly openCodeUrl: string;
    readonly imsgRpcUrl: string;
    readonly managementToken: string;
    readonly model: string;
    readonly directory: string;
  };
}

const required = (value: string, name: string) => {
  if (!value.trim()) throw new Error(`${name} is required`);
  return value;
};

const serviceBase = (value: string) => {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    !(url.protocol === "https:" || (url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("API_MSG_URL must be a credential-free HTTPS or loopback HTTP origin");
  return url;
};

const bootstrapValue = (value: string | undefined) => {
  if (value === undefined || value === "true") return true;
  if (value === "false") return false;
  throw new Error("BOOTSTRAP_ONLY must be 'true' or 'false'");
};

export const cloudflareConfiguration = (
  bindings: CloudflareBindings,
  fetcher: typeof fetch = fetch,
): CloudflareConfiguration => {
  const catalog = catalogClient(
    {
      url: required(bindings.PERSONA_CATALOG_URL, "PERSONA_CATALOG_URL"),
      token: bindings.TOKEN_CATALOG ?? "",
    },
    fetcher,
  );
  const apiMsg = serviceBase(required(bindings.API_MSG_URL, "API_MSG_URL"));
  return {
    applicationStore: {
      catalog: catalog.publicList,
      turnstileSecret: bindings.TURNSTILE_SECRET ?? "",
      managementToken: bindings.TOKEN_MANAGEMENT?.trim() ?? "",
    },
    bootstrapOnly: bootstrapValue(bindings.BOOTSTRAP_ONLY),
    execution: {
      apiMsgUrl: apiMsg.href,
      openCodeUrl: new URL("/opencode", apiMsg).href,
      imsgRpcUrl: new URL("/imsg/rpc", apiMsg).href,
      managementToken: bindings.TOKEN_MANAGEMENT?.trim() ?? "",
      model: bindings.PERSONA_MODEL?.trim() || "opencode-go/deepseek-v4.1-flash",
      directory: bindings.OPENCODE_DIRECTORY?.trim() || "/srv/ren-ai",
    },
  };
};
