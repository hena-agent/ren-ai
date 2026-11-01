import { Window } from "happy-dom";
import { expect, test } from "vitest";
import { Schema } from "effect";
import { loginPage } from "../../social/src/login-page.ts";
import type { BrowserCommands } from "../../social/src/commands.ts";
import { socialPage } from "./social-page.tsx";
import { socialAccount } from "../../../packages/onboarding/src/social.test-helper.ts";
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
  const form = window.document.querySelector('input[name="handle"]')!.closest("form")!;
  for (const name of ["username", "password"]) {
    const input = form.querySelector(`input[name="${name}"]`)!;
    expect(input.hasAttribute("required")).toBe(true);
    expect(input.closest("form")).toBe(form);
  }
  expect(form.textContent).toContain("연결하고 로그인");
  expect(window.document.querySelectorAll('input[name="password"]')).toHaveLength(1);
  window.document.body.innerHTML = socialPage({ personas: [], selected: socialAccount });
  expect(window.document.querySelector('input[name="password"]')!.hasAttribute("required")).toBe(
    false,
  );
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
