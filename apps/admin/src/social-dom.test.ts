import { Window } from "happy-dom";
import { expect, test } from "vitest";
import { Schema } from "effect";
import { loginPage } from "../../social/src/login-page.ts";
import type { BrowserCommands } from "../../social/src/commands.ts";
import { socialPage } from "./social-page.tsx";
import { socialAccount } from "../../../packages/onboarding/src/social.test-helper.ts";
import { threadsIdentityScript, threadsPostsScript } from "../../social/src/threads-scripts.ts";
import {
  identityScript,
  publicScript,
  inboxScript,
  messagesScript,
  candidatesScript,
  sentScript,
  dmSentScript,
} from "../../social/src/x-scripts.ts";

test("connection fields and credentials share one visible form before an account exists", () => {
  const window = new Window();
  window.document.write(
    socialPage({ personas: [], snapshot: { accounts: [], events: [], before: null } }),
  );
  const form = window.document.querySelector('input[name="username"]')!.closest("form")!;
  expect(form.querySelector('input[name="handle"]')).toBeNull();
  expect(form.textContent).toContain("로그인 후 자동 확인");
  for (const name of ["username", "password"]) {
    const input = form.querySelector(`input[name="${name}"]`)!;
    expect(input.hasAttribute("required")).toBe(false);
    expect(input.closest("form")).toBe(form);
  }
  expect(form.textContent).toContain("연결하고 로그인");
  expect(form.querySelector('button[value="save-check"]')).not.toBeNull();
  expect(form.querySelector('select[name="platform"]')).toBeNull();
  expect(form.querySelector('input[name="platform"]')!.getAttribute("value")).toBe("threads");
  expect(
    window.document.querySelector('nav[aria-label="소셜 플랫폼"] a[aria-current="page"]')!
      .textContent,
  ).toBe("Threads");
  expect(window.document.querySelectorAll('input[name="password"]')).toHaveLength(1);
  window.document.body.innerHTML = socialPage({ personas: [], selected: socialAccount });
  expect(window.document.querySelector('input[name="password"]')!.hasAttribute("required")).toBe(
    false,
  );
});

test("platform tabs isolate accounts, activity and form behavior while keeping platform-scoped links", () => {
  const window = new Window();
  const threads = {
    ...socialAccount,
    id: "threads-account",
    platform: "threads" as const,
    handle: "threads_persona",
  };
  const accounts = [socialAccount, threads].map((account) => ({
    account,
    generation: 1,
    nextAt: null,
    state: "paused",
    turns: 0,
    writes: 0,
  }));
  const events = [socialAccount, threads].map((account, id) => ({
    id,
    runId: "run",
    accountId: account.id,
    personaId: account.personaId,
    at: 1000,
    kind: "post",
    state: "completed" as const,
    reason: `${account.platform}-only-history`,
    text: "Public text",
    url: null,
  }));
  for (const platform of ["threads", "x"] as const) {
    window.document.body.innerHTML = socialPage({
      platform,
      personas: [],
      snapshot: { accounts, events, before: 50 },
    });
    const active = window.document.querySelector(
      'nav[aria-label="소셜 플랫폼"] a[aria-current="page"]',
    )!;
    expect(active.textContent).toBe(platform === "x" ? "X" : "Threads");
    expect(window.document.body.textContent).toContain(`${platform}-only-history`);
    expect(window.document.body.textContent).not.toContain(
      `${platform === "x" ? "threads" : "x"}-only-history`,
    );
    const form = window.document.querySelector('input[name="username"]')!.closest("form")!;
    expect(form.getAttribute("action")).toBe(`/social?platform=${platform}&new=1`);
    expect(form.querySelector('input[name="platform"]')!.getAttribute("value")).toBe(platform);
    expect(form.querySelector('input[name="handle"]')).toBeNull();
    expect(form.querySelector('input[name="username"]')!.getAttribute("placeholder")).not.toContain(
      "/",
    );
    expect(window.document.querySelector('a[href*="before="]')!.getAttribute("href")).toBe(
      `/social?platform=${platform}&before=50`,
    );
  }
});

test("live-check controls distinguish checking and check failure, including accounts with no stored credentials", () => {
  const window = new Window();
  for (const state of ["checking", "failed"] as const) {
    window.document.body.innerHTML = socialPage({
      personas: [],
      selected: socialAccount,
      authentication: {
        state,
        hasCredentials: false,
        ...(state === "failed" && { reason: "check_unavailable" as const }),
      },
    });
    expect(window.document.body.textContent).toContain(
      state === "checking" ? "로그인 상태 확인 중" : "로그인 상태 확인 실패",
    );
    expect(
      window.document.querySelector('button[value="auth-check"]')!.hasAttribute("disabled"),
    ).toBe(state === "checking");
  }
});

test("Threads login detects its simultaneous Instagram fields and sends both only through origin-bound stdin", async () => {
  const window = new Window({ url: "https://www.threads.com/login" });
  window.HTMLElement.prototype.getBoundingClientRect = () => new window.DOMRect(0, 0, 100, 20);
  window.document.body.innerHTML =
    '<input autocomplete="username" placeholder="Username, phone or email"><input type="password" autocomplete="current-password"><div role="button">Log in</div>';
  const args: string[][] = [];
  const commands: BrowserCommands = {
    open: async () => 1234,
    command: async (_id, _port, command, _signal, input) => {
      args.push([...command]);
      if (input) {
        const batch = Schema.decodeUnknownSync(
          Schema.fromJsonString(Schema.Array(Schema.Array(Schema.String))),
        )(input);
        try {
          return JSON.stringify([{ success: window.eval(batch[0]![1]!) === "filled" }]);
        } catch {
          return '[{"success":false}]';
        }
      }
      if (command[0] === "eval")
        return JSON.stringify({
          success: true,
          data: { result: Schema.decodeUnknownSync(Schema.String)(window.eval(command[1]!)) },
        });
      return '{"success":true}';
    },
  };
  const page = loginPage(commands, "threads:first", 1234, new AbortController().signal, "threads");
  expect((await page.screen()).stage).toBe("credentials");
  await page.enter("PRIVATE_ID", "PRIVATE_PASSWORD");
  expect(Array.from(window.document.querySelectorAll("input"), (input) => input.value)).toEqual([
    "PRIVATE_ID",
    "PRIVATE_PASSWORD",
  ]);
  expect(JSON.stringify(args)).not.toContain("PRIVATE");
  window.happyDOM.setURL("https://www.instagram.com/accounts/login/");
  await expect(page.enter("DO_NOT_FILL", "DO_NOT_FILL")).rejects.toThrow(
    "Private login input failed",
  );
  window.happyDOM.setURL("https://www.threads.com/");
  window.document.body.innerHTML =
    '<div role="navigation"><a href="/login?show_choice_screen=false">Log in</a></div>';
  expect((await page.screen()).stage).toBe("logged_out");
});

test("Threads readers verify navigation ownership and extract public post text from semantic markup", () => {
  const window = new Window();
  window.document.body.innerHTML =
    '<div role="navigation"><a href="/@persona.name"><svg title="Profile"></svg></a></div><article><a href="/@reader/post/ABC123"><time>2d</time></a><span dir="auto"><span>Public thought</span></span><div role="button"><svg title="Comment"></svg></div></article>';
  expect(window.eval(threadsIdentityScript)).toBe('{"handle":"persona.name"}');
  expect(window.eval(threadsPostsScript)).toContain('"body":"Public thought"');
  expect(window.eval(threadsPostsScript)).toContain('"url":"/@reader/post/ABC123"');
  window.document.body.innerHTML = '<a href="/@someone/post/ABC">Other profile</a>';
  expect(window.eval(threadsIdentityScript)).toBe('{"handle":null}');
});

test("fixed X readers extract post/message text and stable links without copying private inbox previews", () => {
  const window = new Window();
  window.document.body.innerHTML = `
    <a data-testid="AppTabBar_Profile_Link" href="/persona_x">Profile</a>
    <article>Alice <a href="/alice">Alice</a><a href="/alice/status/123">12:00</a><div data-testid="tweetText">A public thought</div></article>
    <div data-testid="conversation"><span data-testid="User-Name">Reader @reader</span><a href="/messages/1-2">Open</a><p>PRIVATE_INBOX_PREVIEW</p></div>
    <div data-testid="conversation"><span>No contact handle</span><p>ANOTHER_PRIVATE_PREVIEW</p></div>
    <div data-testid="messageEntry"><div data-testid="tweetText">Hello there</div><time>12:01 PM</time></div>
    <div data-testid="TypeaheadUser">Reader @reader</div>
    <div data-testid="tweetTextarea_0" contenteditable="true">Draft</div>
    <div data-testid="dmComposerTextInput" contenteditable="true">Draft</div>`;
  expect(window.eval(identityScript)).toBe('{"handle":"persona_x"}');
  expect(window.eval(publicScript)).toContain('"body":"A public thought"');
  expect(window.eval(publicScript)).toContain('"url":"/alice/status/123"');
  expect(window.eval(inboxScript)).toBe('[{"contact":"@reader","path":"/messages/1-2"}]');
  expect(window.eval(inboxScript)).not.toContain("PRIVATE");
  expect(window.eval(messagesScript)).toBe('["Hello there"]');
  expect(window.eval(candidatesScript)).toBe('["Reader @reader"]');
  expect(window.eval(sentScript)).toContain('"empty":false');
  expect(window.eval(dmSentScript)).toBe('{"empty":false}');
  window.document.body.innerHTML = "";
  expect(window.eval(identityScript)).toBe('{"handle":null}');
  expect(window.eval(dmSentScript)).toBe('{"empty":true}');
});

test("login stage probes expose no field values and distinguish username, identity, password, verification and manual steps", async () => {
  const window = new Window({ url: "https://x.com/i/flow/login" });
  window.HTMLElement.prototype.getBoundingClientRect = () => new window.DOMRect(0, 0, 100, 20);
  let script = "";
  const commands: BrowserCommands = {
    open: async () => 1234,
    command: async (_id, _port, args) => {
      script = args[1]!;
      return JSON.stringify({
        success: true,
        data: { result: Schema.decodeUnknownSync(Schema.String)(window.eval(script)) },
      });
    },
  };
  await loginPage(commands, "first", 1234, new AbortController().signal).screen();
  const probe = (markup: string) => {
    window.document.body.innerHTML = markup;
    return Schema.decodeUnknownSync(Schema.String)(window.eval(script));
  };
  expect(
    probe('<input autocomplete="username" value="PRIVATE_ID"><button>Next</button>'),
  ).toContain('"stage":"username"');
  expect(
    probe('<h1>Enter your phone number or username</h1><input name="text"><button>Next</button>'),
  ).toContain('"stage":"identity"');
  const password = probe('<input type="password" value="PRIVATE_PASSWORD"><button>Log in</button>');
  expect(password).toContain('"stage":"password"');
  expect(password).not.toContain("PRIVATE_PASSWORD");
  expect(
    probe('<input autocomplete="one-time-code" value="123456"><button>Verify</button>'),
  ).toContain('"stage":"code"');
  expect(
    probe('<h1>Enter your authentication code</h1><input name="text"><button>Next</button>'),
  ).toContain('"stage":"code"');
  expect(probe('<div data-testid="captcha"></div>')).toContain('"stage":"manual"');
  expect(probe('<p role="alert">Incorrect password</p>')).toContain('"stage":"rejected"');
  expect(probe('<a data-testid="AppTabBar_Profile_Link" href="/persona_x">Profile</a>')).toContain(
    '"stage":"authenticated"',
  );
  expect(probe("")).toContain('"stage":"loading"');
  expect(probe('<a data-testid="loginButton">Log in</a>')).toContain('"stage":"logged_out"');
});

test("private stdin fills a connected X login input atomically and refuses origin changes without echoing the password", async () => {
  const window = new Window({ url: "https://x.com/i/flow/login" });
  window.document.body.innerHTML =
    '<input type="password" data-renai-auth-input="true"><button data-renai-auth-submit="true">Log in</button>';
  let events = 0;
  window.document.querySelector("input")!.addEventListener("input", () => {
    events++;
  });
  const outputs: string[] = [];
  const commandArgs: string[][] = [];
  const commands: BrowserCommands = {
    open: async () => 1234,
    command: async (_id, _port, args, _signal, input) => {
      commandArgs.push([...args]);
      if (input !== undefined) {
        const batch = Schema.decodeUnknownSync(
          Schema.fromJsonString(Schema.Array(Schema.Array(Schema.String))),
        )(input);
        try {
          const filled = Schema.decodeUnknownSync(Schema.String)(window.eval(batch[0]![1]!));
          const output = JSON.stringify([{ success: true, result: { data: { result: filled } } }]);
          outputs.push(output);
          return output;
        } catch {
          return '[{"success":false}]';
        }
      }
      return '{"success":true}';
    },
  };
  const page = loginPage(commands, "first", 1234, new AbortController().signal);
  await page.enter('PRIVATE_PASSWORD_"한글');
  expect(window.document.querySelector("input")!.value).toBe('PRIVATE_PASSWORD_"한글');
  expect(events).toBe(1);
  expect(JSON.stringify(outputs)).not.toContain("PRIVATE_PASSWORD");
  expect(commandArgs).toContainEqual(["click", '[data-renai-auth-submit="true"]']);
  expect(JSON.stringify(commandArgs)).not.toContain("PRIVATE_PASSWORD");
  window.happyDOM.setURL("https://evil.test/i/flow/login");
  await expect(page.enter("DO_NOT_FILL")).rejects.toThrow("Private login input failed");
  expect(window.document.querySelector("input")!.value).toBe('PRIVATE_PASSWORD_"한글');
});
