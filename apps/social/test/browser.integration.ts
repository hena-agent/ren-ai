import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { socialTask } from "../../../packages/onboarding/src/social.test-helper.ts";
import { socialBrowser } from "../src/browser.ts";
import { accountQueue } from "../src/account-queue.ts";
import { withImageUpload } from "../src/image-upload.ts";
import { generatedImage } from "./image.test-helper.ts";
import { commandResult } from "../src/commands.ts";
import { browserSite } from "../src/browser-site.ts";
import { Schema } from "effect";

const exec = promisify(execFile);
const executable = process.env["SOCIAL_TEST_AGENT_BROWSER"]!;
const chrome = process.env["SOCIAL_TEST_CHROME"]!;
if (!executable || !chrome) throw new Error("Set SOCIAL_TEST_AGENT_BROWSER and SOCIAL_TEST_CHROME");
const home = await mkdtemp(join(tmpdir(), "social-browser-test-"));
// The macOS Unix socket limit is 103 bytes, shorter than the usual temporary directory.
const sockets = await mkdtemp("/tmp/renai-browser-test-");
const html = await readFile(new URL("./browser-fixture.html", import.meta.url), "utf8");
const server = createServer((request, response) => {
  if (request.url === "/history") {
    setTimeout(() => response.end("ready"), 900);
    return;
  }
  response.setHeader("Content-Type", "text/html");
  response.end(html);
});
let origin: string;
const command = async (args: readonly string[]) => {
  const result = await exec(executable, ["--session", "regression", "--json", ...args], {
    env: {
      ...process.env,
      HOME: home,
      AGENT_BROWSER_SOCKET_DIR: sockets,
      AGENT_BROWSER_EXECUTABLE_PATH: chrome,
      AGENT_BROWSER_DEFAULT_TIMEOUT: "2000",
      AGENT_BROWSER_ARGS: "--no-sandbox",
    },
    timeout: 15000,
  });
  return result.stdout;
};
beforeAll(async () => {
  if ((await command(["--version"])).trim() !== "agent-browser 0.41.0")
    throw new Error("The browser regression requires agent-browser 0.41.0");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  origin = `http://127.0.0.1:${address.port}`;
  await command(["open", origin]);
});
afterAll(async () => {
  await command(["close"]).catch(() => undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.all([home, sockets].map((path) => rm(path, { recursive: true, force: true })));
});
beforeEach(async () => {
  await command(["open", origin]);
  await command(["eval", "sessionStorage.clear()"]);
});
let requestedOrigin = "https://www.threads.com";
const browser = socialBrowser(
  {
    open: async () => 0,
    withImage: (image, operation) => withImageUpload(home, image, operation),
    command: async (_account, _port, args) => {
      // Only platform navigation is substituted; every selector and DOM reader runs in Chrome.
      if (args[0] === "open") {
        const url = new URL(args[1]!);
        requestedOrigin = url.origin;
        return command(["open", `${origin}${url.pathname}${url.search}`]);
      }
      if (args[0] === "eval" && args[1] === browserSite("threads").location) {
        const observed = new URL(
          Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ url: Schema.String })))(
            commandResult(await command(args)),
          ).url,
        );
        return JSON.stringify({
          success: true,
          data: {
            result: JSON.stringify({
              url:
                observed.origin === origin
                  ? new URL(
                      `${observed.pathname}${observed.search}${observed.hash}`,
                      requestedOrigin,
                    ).href
                  : observed.href,
            }),
          },
        });
      }
      return command(args);
    },
  },
  {
    ensure: async () => {
      throw new Error("Unexpected login attempt");
    },
  },
  accountQueue(),
);
const task = socialTask();
const execute = (action: Parameters<typeof browser.execute>[2]) =>
  browser.execute(
    task.run,
    { ...task.account, platform: "threads" },
    action,
    AbortSignal.timeout(20000),
    async () => {},
  );

test("Threads discovers public posts when hidden mobile navigation precedes the desktop sidebar", async () => {
  const result = await execute({ kind: "search", query: "AI friends" });
  expect(JSON.parse(result.text)).toContainEqual({
    hasImage: false,
    text: "A public conversation",
    body: "A public conversation",
    url: "/@reader/post/ABC123",
  });
});

test("Threads publishes through New thread and returns a new owned permalink", async () => {
  expect(await execute({ kind: "post", text: "Browser regression post" })).toEqual({
    text: "Published",
    url: "https://www.threads.com/@persona_x/post/TEST0",
  });
});

test("a generated JPEG is attached through the real CLI before its owned image permalink is confirmed", async () => {
  const result = await browser.execute(
    task.run,
    { ...task.account, platform: "threads" },
    { kind: "post", text: "AI-created scene", imageId: "draft" },
    AbortSignal.timeout(20000),
    async () => {},
    undefined,
    generatedImage,
  );
  expect(result).toEqual({
    text: "Published",
    url: "https://www.threads.com/@persona_x/post/TEST0",
  });
});

test("a profile-only optimistic entry with an unavailable permalink is never declared published", async () => {
  await command(["eval", "sessionStorage.setItem('invalidPermalink','true')"]);
  await expect(execute({ kind: "post", text: "Optimistic receipt" })).rejects.toThrow(
    "permalink could not be verified",
  );
});

test("Threads replies to a public post and verifies its owned permalink in Replies", async () => {
  expect(
    await execute({
      kind: "reply",
      url: "https://www.threads.com/@reader/post/ABC123",
      text: "Browser regression reply",
    }),
  ).toEqual({
    text: "Published",
    url: "https://www.threads.com/@persona_x/post/TEST0",
  });
});

test("X selects the verified DM recipient rather than the first search candidate", async () => {
  expect(
    await browser.execute(
      { ...task.run, contact: "reader" },
      task.account,
      { kind: "messages" },
      AbortSignal.timeout(20000),
      async () => {},
    ),
  ).toEqual({ text: '["Reader @reader"]' });
});

test("X can publish while the composer modal covers the profile navigation", async () => {
  expect(
    await browser.execute(
      task.run,
      task.account,
      { kind: "post", text: "X browser regression post" },
      AbortSignal.timeout(20000),
      async () => {},
    ),
  ).toEqual({ text: "Published", url: "https://x.com/persona_x/status/1" });
});

test("delayed old Threads history cannot confirm an unverified submission", async () => {
  await command([
    "eval",
    `sessionStorage.setItem('posts', '[{"text":"Old post","reply":false}]');sessionStorage.setItem('noPublication','true');sessionStorage.setItem('delayHistory','true')`,
  ]);
  await expect(execute({ kind: "post", text: "Old post" })).rejects.toThrow(
    "could not be verified",
  );
});

test("ambiguous Threads submit buttons fail before sending", async () => {
  await command(["eval", "sessionStorage.setItem('ambiguousSubmit','true')"]);
  await expect(execute({ kind: "post", text: "Do not send" })).rejects.toThrow("Command failed:");
  const result = await execute({ kind: "profile", handle: "persona_x" });
  expect(result.text).not.toContain("Do not send");
});
