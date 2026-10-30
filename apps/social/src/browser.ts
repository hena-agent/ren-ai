import { Schema } from "effect";
import {
  socialWrite,
  type SocialAccount,
  type SocialAction,
  type SocialResult,
  type SocialRun,
} from "@ren-ai/onboarding/social";
import { commandResult, type BrowserCommands } from "./commands.ts";
import {
  identityScript,
  publicScript,
  inboxScript,
  messagesScript,
  candidatesScript,
  sentScript,
  dmSentScript,
} from "./x-scripts.ts";

export class LoginRequired extends Error {
  readonly code = "SOCIAL_LOGIN_REQUIRED";
}
const Identity = Schema.fromJsonString(Schema.Struct({ handle: Schema.NullOr(Schema.String) }));
const Sent = Schema.fromJsonString(Schema.Struct({ empty: Schema.Boolean }));
const Posts = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ body: Schema.String, url: Schema.NullOr(Schema.String) })),
);
const normalized = (value: string) => value.replace(/\s+/g, " ").trim();
interface Page {
  navigate: (url: string) => Promise<void>;
  read: (script: string) => Promise<string>;
  command: (...args: string[]) => Promise<string>;
  send: (selector: string, text: string, button: string, script: string) => Promise<void>;
}
async function openContact(contact: string, page: Page) {
  await page.navigate("https://x.com/messages");
  const inbox = Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Array(
        Schema.Struct({
          contact: Schema.String,
          path: Schema.optionalKey(
            Schema.NullOr(Schema.String.check(Schema.isPattern(/^\/messages\/\d+-\d+$/))),
          ),
        }),
      ),
    ),
  )(await page.read(inboxScript));
  const existing = inbox.find(
    (entry) => entry.contact.toLowerCase() === `@${contact.toLowerCase()}`,
  );
  if (existing?.path) {
    await page.navigate(`https://x.com${existing.path}`);
    return;
  }
  await page.navigate("https://x.com/messages/compose");
  await page.command("fill", '[data-testid="searchPeople"]', contact);
  await page.command("wait", '[data-testid="TypeaheadUser"]');
  const candidates = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))(
    await page.read(candidatesScript),
  );
  const index = candidates.findIndex((candidate) =>
    candidate.split(/\s+/).some((word) => word.toLowerCase() === `@${contact.toLowerCase()}`),
  );
  if (index < 0) throw new Error("X contact could not be verified");
  await page.command("click", `[data-testid="TypeaheadUser"] >> nth=${index}`);
  await page.command("click", '[data-testid="nextButton"]');
}
async function publish(
  account: SocialAccount,
  action: Extract<SocialAction, { kind: "post" | "reply" }>,
  page: Page,
): Promise<SocialResult> {
  await page.navigate(`https://x.com/${account.handle}/with_replies`);
  const before = Schema.decodeUnknownSync(Posts)(await page.read(publicScript));
  await page.navigate(action.kind === "reply" ? action.url : "https://x.com/compose/post");
  if (action.kind === "reply") await page.command("click", '[data-testid="reply"] >> nth=0');
  await page.send(
    '[data-testid="tweetTextarea_0"]',
    action.text,
    '[data-testid="tweetButton"]',
    sentScript,
  );
  await page.navigate(`https://x.com/${account.handle}/with_replies`);
  const after = Schema.decodeUnknownSync(Posts)(await page.read(publicScript));
  const posted = after.find(
    (post) =>
      post.url?.toLowerCase().startsWith(`/${account.handle.toLowerCase()}/status/`) &&
      normalized(post.body) === normalized(action.text) &&
      !before.some((prior) => prior.url === post.url),
  );
  if (!posted?.url) throw new Error("Published X post could not be verified");
  return { text: "Published", url: `https://x.com${posted.url}` };
}
async function privateMessages(
  run: SocialRun,
  action: SocialAction,
  page: Page,
): Promise<SocialResult> {
  const contact = run.contact;
  if (!contact) throw new Error("A private social contact is required");
  await openContact(contact, page);
  await page.command("wait", '[data-testid="dmComposerTextInput"]');
  const before = await page.read(messagesScript);
  if (action.kind !== "dm") return { text: before };
  await page.send(
    '[data-testid="dmComposerTextInput"]',
    action.text,
    '[data-testid="dmComposerSendButton"]',
    dmSentScript,
  );
  const after = await page.read(messagesScript);
  const messages = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))(
    after,
  );
  if (before === after || normalized(messages.at(-1) ?? "") !== normalized(action.text))
    throw new Error("Sent X DM could not be verified");
  return { text: after };
}

export function xBrowser(commands: BrowserCommands) {
  const tails = new Map<string, Promise<void>>();
  const execute = async (
    run: SocialRun,
    account: SocialAccount,
    action: SocialAction,
    signal: AbortSignal,
    guard: () => Promise<void>,
  ): Promise<SocialResult> => {
    const port = await commands.open(account.id);
    const command = async (...args: string[]) => {
      signal.throwIfAborted();
      const output = await commands.command(account.id, port, args, signal);
      commandResult(output);
      return output;
    };
    const read = async (script: string) => commandResult(await command("eval", script));
    const navigate = async (url: string) => {
      await command("open", url);
      await command(
        "wait",
        '[data-testid="AppTabBar_Profile_Link"],[data-testid="loginButton"],input[autocomplete="username"]',
      );
      const identity = Schema.decodeUnknownSync(Identity)(await read(identityScript));
      if (identity.handle?.toLowerCase() !== account.handle.toLowerCase())
        throw new LoginRequired("X account login does not match");
    };
    const send = async (selector: string, text: string, button: string, script: string) => {
      await command("fill", selector, text);
      await guard();
      signal.throwIfAborted();
      await command("click", button);
      await command("wait", "300");
      if (!Schema.decodeUnknownSync(Sent)(await read(script)).empty)
        throw new Error("X submission result is uncertain");
    };
    const page = { navigate, read, command, send };
    if (socialWrite(action)) await guard();
    switch (action.kind) {
      case "search":
        await navigate(
          `https://x.com/search?${new URLSearchParams({ q: action.query, f: "live" }).toString()}`,
        );
        return { text: await read(publicScript) };
      case "profile":
        await navigate(`https://x.com/${action.handle}`);
        return { text: await read(publicScript) };
      case "notifications":
        await navigate("https://x.com/notifications");
        return { text: await read(publicScript) };
      case "inbox":
        await navigate("https://x.com/messages");
        return { text: await read(inboxScript) };
      case "read_post":
        await navigate(action.url);
        return { text: await read(publicScript), url: action.url };
      case "post":
      case "reply":
        return publish(account, action, page);
      case "messages":
      case "dm":
        return privateMessages(run, action, page);
      default:
        throw new Error("Unsupported browser action");
    }
  };
  return {
    open: commands.open,
    execute: (
      run: SocialRun,
      account: SocialAccount,
      action: SocialAction,
      signal: AbortSignal,
      guard: () => Promise<void>,
    ) => {
      const previous = tails.get(account.id) ?? Promise.resolve();
      const result = previous.then(() => execute(run, account, action, signal, guard));
      const tail = result.then(
        () => undefined,
        () => undefined,
      );
      tails.set(account.id, tail);
      void tail.then(() => {
        if (tails.get(account.id) === tail) tails.delete(account.id);
        return undefined;
      });
      return result;
    },
  };
}
