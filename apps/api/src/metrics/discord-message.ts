/** The part of Discord's Components V2 layout that Alerts and Reports use. */
type Text = { readonly type: 10; readonly content: string };
type Divider = { readonly type: 14; readonly divider: true; readonly spacing: 1 };
type Link = { readonly type: 2; readonly style: 5; readonly label: string; readonly url: string };
type Section = { readonly type: 9; readonly components: readonly Text[]; readonly accessory: Link };
type Links = { readonly type: 1; readonly components: readonly Link[] };
type Part = Text | Divider | Section | Links;

export type DiscordMessage = {
  readonly flags: number;
  readonly components: readonly [
    { readonly type: 17; readonly accent_color: number; readonly components: readonly Part[] },
  ];
};

export const accents = { report: 0xc72c52, raised: 0xed4245, cleared: 0x57f287 } as const;

export const text = (content: string): Text => ({ type: 10, content });
export const divider: Divider = { type: 14, divider: true, spacing: 1 };
const link = (label: string, url: string): Link => ({ type: 2, style: 5, label, url });
export const section = (content: string, label: string, url: string): Section => ({
  type: 9,
  components: [text(content)],
  accessory: link(label, url),
});
export const linkRow = (label: string, url: string): Links => ({
  type: 1,
  components: [link(label, url)],
});

/** A Components V2 message carries only components: Discord rejects content or embeds beside them. */
export const card = (accent: number, parts: readonly Part[]): DiscordMessage => ({
  flags: 1 << 15,
  components: [{ type: 17, accent_color: accent, components: parts }],
});

const senders = { alerts: "Ren AI 알림", reports: "Ren AI 지표" } as const;
/** The complete webhook request body: the card, its channel's sender and no mentions. */
export const requestBody = (channel: keyof typeof senders, message: DiscordMessage) =>
  JSON.stringify({
    ...message,
    username: senders[channel],
    avatar_url: "https://renai.im/apple-touch-icon.png",
    allowed_mentions: { parse: [] },
  });

/** Escapes Discord formatting in values that originate outside Ren AI, such as campaign tags. */
export const escapeMarkdown = (value: string) => value.replace(/[\\*_~`|<>#[\]()-]/g, "\\$&");
