import { expect, test } from "vitest";
import { socialTask } from "../../../packages/onboarding/src/social.test-helper.ts";
import { socialBrowser, LoginRequired } from "./browser.ts";
import type { BrowserCommands } from "./commands.ts";
import { commandResult } from "./commands.ts";
import { accountQueue } from "./account-queue.ts";
import type { SocialAuthentication } from "./authentication.ts";
import { AuthenticationError } from "./auth-store.ts";
import type { SocialPlatform } from "@ren-ai/onboarding/social";
import { browserSite } from "./browser-site.ts";
import { threadsIdentityScript, threadsPostsScript, threadsSentScript } from "./threads-scripts.ts";
import {
  identityScript,
  publicScript,
  messagesScript,
  inboxScript,
  candidatesScript,
  sentScript,
  dmSentScript,
} from "./x-scripts.ts";

function fixture(platform: SocialPlatform = "x") {
  const original = socialTask();
  const task = { ...original, account: { ...original.account, platform } };
  const commands: string[][] = [];
  const observations = new Map<string, string>([
    [identityScript, JSON.stringify({ handle: task.account.handle })],
    [publicScript, "[]"],
    [inboxScript, '[{"contact":"@reader"}]'],
    [messagesScript, '["previous"]'],
    [candidatesScript, '["Someone @another", "Reader @reader"]'],
    [sentScript, '{"empty":true}'],
    [dmSentScript, '{"empty":true}'],
    [threadsIdentityScript, JSON.stringify({ handle: task.account.handle })],
    [threadsPostsScript, "[]"],
    [threadsSentScript, '{"empty":true}'],
  ]);
  const adapter: BrowserCommands = {
    open: async () => 1234,
    command: async (_account, _port, args) => {
      commands.push([...args]);
      if (args[0] === "eval")
        return JSON.stringify({ success: true, data: { result: observations.get(args[1]!) } });
      if (args[0] === "click" && args[1] === '[data-testid="tweetButton"]') {
        observations.set(publicScript, '[{"body":"Hello X","url":"/persona_x/status/123"}]');
      }
      if (args[0] === "click" && args[1] === '[data-testid="dmComposerSendButton"]')
        observations.set(messagesScript, '["previous","Hello DM"]');
      if (args[0] === "click" && args[1] === browserSite("threads").submit)
        observations.set(
          threadsPostsScript,
          '[{"body":"Hello Threads","url":"/@persona_x/post/ABC123"}]',
        );
      return JSON.stringify({ success: true });
    },
  };
  const authentication = { ensure: async () => {} } satisfies Pick<SocialAuthentication, "ensure">;
  const browser = socialBrowser(adapter, authentication, accountQueue());
  let guards = 0;
  const execute = (
    action: Parameters<typeof browser.execute>[2],
    contact: string | null = null,
    signal = new AbortController().signal,
  ) =>
    browser.execute({ ...task.run, contact }, task.account, action, signal, async () => {
      guards++;
    });
  return {
    task,
    browser,
    adapter,
    authentication,
    observations,
    commands,
    execute,
    guards: () => guards,
  };
}

test("public discovery navigates only fixed X routes and checks the logged-in account", async () => {
  const f = fixture();
  expect(await f.execute({ kind: "search", query: "character.ai memory" })).toEqual({ text: "[]" });
  expect(f.commands).toContainEqual(["open", "https://x.com/search?q=character.ai+memory&f=live"]);
  await f.execute({ kind: "profile", handle: "reader" });
  await f.execute({ kind: "notifications" });
  expect(await f.execute({ kind: "inbox" })).toEqual({ text: '[{"contact":"@reader"}]' });
  expect(
    await f.execute({ kind: "read_post", url: "https://x.com/reader/status/123" }),
  ).toMatchObject({ url: "https://x.com/reader/status/123" });
  f.observations.set(identityScript, '{"handle":null}');
  await expect(f.execute({ kind: "notifications" })).rejects.toBeInstanceOf(LoginRequired);
  f.observations.set(identityScript, '{"handle":"wrong"}');
  await expect(f.execute({ kind: "notifications" })).rejects.toBeInstanceOf(LoginRequired);
});

test("Threads uses isolated browser ownership, public discovery routes and same-platform links", async () => {
  const f = fixture("threads");
  const opened: string[] = [];
  f.adapter.open = async (account, url) => {
    opened.push(`${account} ${url}`);
    return 1234;
  };
  await f.browser.open(f.task.account.id, "threads");
  expect(await f.execute({ kind: "search", query: "AI friends" })).toEqual({ text: "[]" });
  await f.execute({ kind: "profile", handle: "reader.name" });
  await f.execute({ kind: "read_post", url: "https://www.threads.com/@reader.name/post/AB12" });
  expect(opened.every((value) => value === "threads:first https://www.threads.com/")).toBe(true);
  expect(f.commands).toContainEqual(["open", "https://www.threads.com/search?q=AI+friends"]);
  expect(f.commands).toContainEqual(["open", "https://www.threads.com/@reader.name"]);
  await expect(f.execute({ kind: "inbox" })).rejects.toThrow("Unsupported platform action");
  await expect(
    f.execute({ kind: "read_post", url: "https://x.com/reader/status/123" }),
  ).rejects.toThrow("Unsupported platform action");
});

test.each(["post", "reply"] as const)(
  "Threads %s requires a new owned post receipt and never confirms an old post",
  async (kind) => {
    const f = fixture("threads");
    const action =
      kind === "post"
        ? { kind, text: "Hello Threads" }
        : { kind, text: "Hello Threads", url: "https://www.threads.com/@reader/post/DEF" };
    expect(await f.execute(action)).toEqual({
      text: "Published",
      url: "https://www.threads.com/@persona_x/post/ABC123",
    });
    expect(f.guards()).toBe(2);
    await expect(f.execute(action)).rejects.toThrow("could not be verified");
  },
);

test.each(["post", "reply"] as const)(
  "%s verifies a newly published status and guards immediately before clicking send",
  async (kind) => {
    const f = fixture();
    const action =
      kind === "post"
        ? { kind, text: "Hello X" }
        : { kind, text: "Hello X", url: "https://x.com/reader/status/456" };
    expect(await f.execute(action)).toEqual({
      text: "Published",
      url: "https://x.com/persona_x/status/123",
    });
    expect(f.guards()).toBe(2);
    // The same old status cannot be mistaken for a newly sent one.
    await expect(f.execute(action)).rejects.toThrow("could not be verified");
  },
);

test("private reads verify the exact recipient and DM writes require visible delivery evidence", async () => {
  const f = fixture();
  expect(await f.execute({ kind: "messages" }, "reader")).toEqual({ text: '["previous"]' });
  expect(f.commands).toContainEqual(["click", '[data-testid="TypeaheadUser"] >> nth=1']);
  expect(await f.execute({ kind: "dm", text: "Hello DM" }, "reader")).toEqual({
    text: '["previous","Hello DM"]',
  });
  await expect(f.execute({ kind: "dm", text: "Hello DM" }, "reader")).rejects.toThrow(
    "could not be verified",
  );
  f.observations.set(messagesScript, "[]");
  await expect(f.execute({ kind: "dm", text: "different" }, "reader")).rejects.toThrow(
    "could not be verified",
  );
  f.observations.set(candidatesScript, '["Someone @another"]');
  await expect(f.execute({ kind: "messages" }, "reader")).rejects.toThrow("could not be verified");
  await expect(f.execute({ kind: "messages" })).rejects.toThrow("private social contact");
});

test("a DM cannot be confirmed from an empty post-send message list", async () => {
  const f = fixture();
  const original = f.adapter.command;
  f.adapter.command = async (...args) => {
    const output = await original(...args);
    if (args[2][0] === "click" && args[2][1] === '[data-testid="dmComposerSendButton"]')
      f.observations.set(messagesScript, "[]");
    return output;
  };
  await expect(f.execute({ kind: "dm", text: "Hello DM" }, "reader")).rejects.toThrow(
    "could not be verified",
  );
});

test("existing DM threads open directly without entering a new-recipient composer", async () => {
  const f = fixture();
  f.observations.set(
    inboxScript,
    '[{"contact":"@other","path":"/messages/1-2"},{"contact":"@reader","path":"/messages/1-3"}]',
  );
  expect(await f.execute({ kind: "messages" }, "reader")).toEqual({ text: '["previous"]' });
  expect(f.commands).toContainEqual(["open", "https://x.com/messages/1-3"]);
  expect(f.commands.some(([, selector]) => selector === '[data-testid="searchPeople"]')).toBe(
    false,
  );
});

test("expired sessions restore login before the original navigation without repeating the social action", async () => {
  const f = fixture();
  f.observations.set(identityScript, '{"handle":null}');
  let logins = 0;
  f.authentication.ensure = async () => {
    logins++;
    f.observations.set(identityScript, JSON.stringify({ handle: f.task.account.handle }));
  };
  expect(await f.execute({ kind: "read_post", url: "https://x.com/reader/status/123" })).toEqual({
    text: "[]",
    url: "https://x.com/reader/status/123",
  });
  expect(logins).toBe(1);
  expect(f.commands.filter(([kind]) => kind === "click")).toEqual([]);
});

test("authentication blockers are classified as unsent only before a submit command", async () => {
  const f = fixture();
  f.observations.set(identityScript, '{"handle":null}');
  f.authentication.ensure = async () => {
    throw new AuthenticationError({ state: "code_required", hasCredentials: true });
  };
  await expect(f.execute({ kind: "post", text: "Hello X" })).rejects.toBeInstanceOf(
    AuthenticationError,
  );
  expect(f.commands.filter(([kind]) => kind === "click")).toEqual([]);
  f.observations.set(identityScript, JSON.stringify({ handle: f.task.account.handle }));
  const original = f.adapter.command;
  f.adapter.command = async (...args) => {
    const output = await original(...args);
    if (args[2][0] === "click" && args[2][1] === '[data-testid="tweetButton"]')
      f.observations.set(identityScript, '{"handle":null}');
    return output;
  };
  const pending = f.execute({ kind: "post", text: "Hello X" });
  await expect(pending).rejects.toThrow("uncertain");
  await expect(pending).rejects.not.toBeInstanceOf(AuthenticationError);
});

test("failed composer submissions and aborted work never silently report success", async () => {
  const f = fixture();
  f.observations.set(sentScript, '{"empty":false}');
  await expect(f.execute({ kind: "post", text: "Hello X" })).rejects.toThrow("uncertain");
  await expect(f.execute({ kind: "finish" })).rejects.toThrow("Unsupported");
  const controller = new AbortController();
  controller.abort();
  await expect(f.execute({ kind: "search", query: "a" }, null, controller.signal)).rejects.toThrow(
    "aborted",
  );
  expect(commandResult('{"success":true}')).toBe("");
  expect(() => commandResult('{"success":false}')).toThrow("agent-browser result");
  expect(() => commandResult("invalid")).toThrow("agent-browser result");
});

test("account operations serialize without blocking another account and recover their queue after failure", async () => {
  const f = fixture();
  const first = f.execute({ kind: "search", query: "first" });
  const second = f.execute({ kind: "profile", handle: "reader" });
  await Promise.all([first, second]);
  const opens = f.commands.filter(([command]) => command === "open");
  expect(opens).toEqual([
    ["open", "https://x.com/search?q=first&f=live"],
    ["open", "https://x.com/reader"],
  ]);
  await expect(f.execute({ kind: "contact", handle: null })).rejects.toThrow("Unsupported");
  await expect(f.execute({ kind: "notifications" })).resolves.toEqual({ text: "[]" });
});
