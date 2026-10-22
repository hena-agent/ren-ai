import worker, { ApiApplication } from "../worker/entry.ts";
import type { CloudflareBindings } from "../src/cloudflare-config.ts";
import { executionSnapshot } from "./execution-catalog.ts";

const network = globalThis.fetch;
let upstream = "";
let catalogRevision = "initial";
let catalogReads = 0;

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (url.hostname === "api-msg.example") {
    const request = new Request(input instanceof Request ? input : input.toString(), init);
    return network(new Request(`${upstream}${url.pathname}${url.search}`, request));
  }
  if (url.hostname === "admin.example") {
    if (url.pathname === "/api/catalog") {
      catalogReads++;
      if (new Headers(init?.headers).get("authorization") !== "Bearer catalog-secret")
        return new Response(null, { status: 401 });
      return Response.json(executionSnapshot(catalogRevision));
    }
    if (url.pathname === "/api/personas")
      return Response.json([
        {
          id: "persona1",
          name: "Sora",
          bio: "A musician",
          imageUrl: "https://admin.example/sora.jpg",
          publicProfile: "A musician",
        },
      ]);
  }
  if (url.hostname === "challenges.cloudflare.com") return Response.json({ success: true });
  throw new Error("Unexpected test upstream");
};

export class ExecutionApplication extends ApiApplication {
  override async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/__fixture/")) return super.fetch(request);
    await super.fetch(new Request("https://app/health"));
    if (path === "/__fixture/verify-imessage") {
      this.ctx.storage.sql.exec(
        "UPDATE discovery_registration SET imessage_status = 'available', imessage_checked_at = ?",
        Date.now(),
      );
    } else if (path === "/__fixture/due") {
      this.ctx.storage.sql.exec("UPDATE application_work SET due = 0 WHERE name GLOB 'lane:*'");
      this.ctx.storage.sql.exec(
        "UPDATE discovery_contact SET scheduled_at = 0 WHERE state = 'scheduled'",
      );
    } else if (path === "/__fixture/alarm") {
      await super.alarm();
    } else if (path === "/__fixture/catalog") {
      catalogRevision = "changed";
    }
    return Response.json({
      catalogReads,
      alarm: await this.ctx.storage.getAlarm(),
      contacts: this.ctx.storage.sql
        .exec("SELECT state, session_id FROM discovery_contact")
        .toArray(),
      conversations: this.ctx.storage.sql
        .exec("SELECT session_id, persona_id FROM conversation")
        .toArray(),
      sends: this.ctx.storage.sql.exec("SELECT state, tool_call_id FROM send").toArray(),
    });
  }
}

export default {
  fetch(
    request: Request,
    env: Parameters<typeof worker.fetch>[1] & CloudflareBindings & { TEST_EXECUTOR_URL: string },
  ) {
    upstream = env.TEST_EXECUTOR_URL;
    return worker.fetch(request, env);
  },
};
