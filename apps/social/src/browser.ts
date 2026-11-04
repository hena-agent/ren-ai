import { Schema } from "effect";
import {
  socialWrite,
  supportsSocialAction,
  type SocialPlatform,
  type SocialAccount,
  type SocialAction,
  type SocialResult,
  type SocialRun,
} from "@ren-ai/onboarding/social";
import { browserAccount, commandResult, type BrowserCommands } from "./commands.ts";
import { browserSite } from "./browser-site.ts";
import type { SocialAuthentication } from "./authentication.ts";
import { AuthenticationError } from "./auth-store.ts";
import type { AccountQueue } from "./account-queue.ts";
import {
  publicScript,
  inboxScript,
  messagesScript,
  candidatesScript,
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
  site: ReturnType<typeof browserSite>;
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
  await page.command("find", "nth", String(index), '[data-testid="TypeaheadUser"]', "click");
  await page.command("click", '[data-testid="nextButton"]');
}
async function publish(
  account: SocialAccount,
  action: Extract<SocialAction, { kind: "post" | "reply" }>,
  page: Page,
): Promise<SocialResult> {
  const site = page.site;
  const profile = site.profile(account.handle, action.kind === "reply");
  await page.navigate(profile);
  // Profile data must finish loading before an old permalink can be ruled out.
  // A busy/unavailable profile fails before submission, rather than assuming it is empty.
  await page.command("wait", "--load", "networkidle");
  const before = Schema.decodeUnknownSync(Posts)(await page.read(site.posts));
  await page.navigate(action.kind === "reply" ? action.url : site.compose);
  if (action.kind === "reply") await page.command("click", site.reply);
  else if (site.create) await page.command("click", site.create);
  await page.command("wait", site.input);
  await page.send(site.input, action.text, site.submit, site.sent);
  await page.navigate(profile);
  // The list can arrive late or remain cached before publication. Only re-read
  // and refresh the profile; never resubmit while waiting for its receipt.
  for (let attempt = 0; attempt < 40; attempt++) {
    if (attempt > 0 && attempt % 8 === 0) await page.navigate(profile);
    const after = Schema.decodeUnknownSync(Posts)(await page.read(site.posts));
    const posted = after.find(
      (post) =>
        post.url?.toLowerCase().startsWith(site.prefix(account.handle)) &&
        normalized(post.body) === normalized(action.text) &&
        !before.some((prior) => prior.url === post.url),
    );
    if (posted?.url) return { text: "Published", url: `${new URL(site.home).origin}${posted.url}` };
    await page.command("wait", "250");
  }
  throw new Error("Published social post could not be verified");
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

export function socialBrowser(
  commands: BrowserCommands,
  authentication: Pick<SocialAuthentication, "ensure">,
  exclusive: AccountQueue,
) {
  const execute = async (
    run: SocialRun,
    account: SocialAccount,
    action: SocialAction,
    signal: AbortSignal,
    guard: () => Promise<void>,
  ): Promise<SocialResult> => {
    if (!supportsSocialAction(account.platform, action))
      throw new Error("Unsupported platform action");
    const site = browserSite(account.platform);
    const key = browserAccount(account);
    const port = await commands.open(key, site.home);
    let submitted = false;
    const command = async (...args: string[]) => {
      signal.throwIfAborted();
      const output = await commands.command(key, port, args, signal);
      commandResult(output);
      return output;
    };
    const read = async (script: string) => commandResult(await command("eval", script));
    const ready = () =>
      command(
        "wait",
        "--fn",
        `Array.from(document.querySelectorAll(${JSON.stringify(site.ready)})).some(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'&&e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})?'ready':''`,
      );
    const navigate = async (url: string) => {
      await command("open", url);
      await ready();
      let identity = Schema.decodeUnknownSync(Identity)(await read(site.identity));
      if (identity.handle?.toLowerCase() !== account.handle.toLowerCase()) {
        await authentication.ensure(
          {
            id: account.id,
            platform: account.platform,
            handle: account.handle,
            personaId: account.personaId,
            generation: run.generation,
          },
          port,
          signal,
        );
        await command("open", url);
        await ready();
        identity = Schema.decodeUnknownSync(Identity)(await read(site.identity));
      }
      if (identity.handle?.toLowerCase() !== account.handle.toLowerCase())
        throw new LoginRequired("X account login does not match");
    };
    const send = async (selector: string, text: string, button: string, script: string) => {
      await command("fill", selector, text);
      const submit = site.submitIndex
        ? ["find", "nth", await read(site.submitIndex), button, "click"]
        : ["click", button];
      await guard();
      signal.throwIfAborted();
      submitted = true;
      await command(...submit);
      await command("wait", "300");
      if (!Schema.decodeUnknownSync(Sent)(await read(script)).empty)
        throw new Error("X submission result is uncertain");
    };
    const page = { site, navigate, read, command, send };
    if (socialWrite(action)) await guard();
    try {
      switch (action.kind) {
        case "search":
          await navigate(site.search(action.query));
          return { text: await read(site.posts) };
        case "profile":
          await navigate(
            account.platform === "threads"
              ? site.profile(action.handle, false)
              : `https://x.com/${action.handle}`,
          );
          return { text: await read(site.posts) };
        case "notifications":
          await navigate("https://x.com/notifications");
          return { text: await read(publicScript) };
        case "inbox":
          await navigate("https://x.com/messages");
          return { text: await read(inboxScript) };
        case "read_post":
          await navigate(action.url);
          return { text: await read(site.posts), url: action.url };
        case "post":
        case "reply":
          return await publish(account, action, page);
        case "messages":
        case "dm":
          return await privateMessages(run, action, page);
        default:
          throw new Error("Unsupported browser action");
      }
    } catch (cause) {
      if (submitted && cause instanceof AuthenticationError)
        throw new Error("X write outcome is uncertain after authentication interruption", {
          cause,
        });
      throw cause;
    }
  };
  return {
    open: (id: string, platform: SocialPlatform = "x") =>
      commands.open(browserAccount({ id, platform }), browserSite(platform).home),
    execute: (
      run: SocialRun,
      account: SocialAccount,
      action: SocialAction,
      signal: AbortSignal,
      guard: () => Promise<void>,
    ) => {
      return exclusive(account.id, () => execute(run, account, action, signal, guard));
    },
  };
}
