import type { SocialPlatform } from "@ren-ai/onboarding/social";
import { identityScript, publicScript, sentScript } from "./x-scripts.ts";
import {
  threadsIdentityScript,
  threadsPostsScript,
  threadsComposer,
  threadsSentScript,
  threadsSubmitButtons,
  threadsSubmitIndex,
} from "./threads-scripts.ts";
const locationScript = "JSON.stringify({url:location.href})";

export function browserSite(platform: SocialPlatform) {
  if (platform === "threads")
    return {
      home: "https://www.threads.com/",
      location: locationScript,
      profile: (handle: string, replies: boolean) =>
        `https://www.threads.com/@${handle}${replies ? "/replies" : ""}`,
      search: (query: string) =>
        `https://www.threads.com/search?${new URLSearchParams({ q: query }).toString()}`,
      identity: threadsIdentityScript,
      posts: threadsPostsScript,
      ready: '[role="navigation"],input[autocomplete="username"]',
      compose: "https://www.threads.com/",
      create: ':is(button,[role="button"]):has(svg[aria-label="New thread"])',
      reply:
        ':is(button,[role="button"]):has(svg[title="Comment"],svg[aria-label="Reply"],svg[aria-label="Comment"])',
      input: threadsComposer,
      fileInput: '[role="dialog"] input[type="file"][accept*="image"]',
      attachmentReady: '[role="dialog"] img[src^="blob:"]',
      submitIndex: threadsSubmitIndex,
      submit: threadsSubmitButtons,
      sent: threadsSentScript,
      prefix: (handle: string) => `/@${handle.toLowerCase()}/post/`,
    };
  return {
    home: "https://x.com/home",
    location: locationScript,
    profile: (handle: string, _replies: boolean) => `https://x.com/${handle}/with_replies`,
    search: (query: string) =>
      `https://x.com/search?${new URLSearchParams({ q: query, f: "live" }).toString()}`,
    identity: identityScript,
    posts: publicScript,
    ready:
      '[data-testid="AppTabBar_Profile_Link"],[data-testid="loginButton"],input[autocomplete="username"],[data-testid="tweetTextarea_0"],[data-testid="searchPeople"],[data-testid="dmComposerTextInput"]',
    compose: "https://x.com/compose/post",
    create: undefined,
    reply: '[data-testid="reply"]',
    input: '[data-testid="tweetTextarea_0"]',
    fileInput: 'input[data-testid="fileInput"]',
    attachmentReady: '[data-testid="attachments"] img',
    submitIndex: undefined,
    submit: '[data-testid="tweetButton"]',
    sent: sentScript,
    prefix: (handle: string) => `/${handle.toLowerCase()}/status/`,
  };
}
