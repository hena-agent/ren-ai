import { Clock, Effect } from "effect";
import { SqlClient } from "effect/sql";
import { randomUUID } from "node:crypto";
import { queueDiscord } from "./discord.ts";
import { accents, card, section, text } from "./discord-message.ts";

const adminPage = (label: string, path: string) => ({
  label,
  url: `https://admin.renai.im/${path}`,
});
const conversations = adminPage("대화 상태", "conversations");
const firstContacts = adminPage("첫 연락", "first-contacts");
const waitlist = adminPage("대기자", "waitlist");

/** How one kind of Alert reads in Discord and Admin. */
type AlertKind = {
  readonly title: string;
  readonly detail: string;
  readonly page: typeof waitlist;
};

/** Keys ending in ":" cover every Alert raised for one record, such as `greeting:<registration>`. */
const alertKinds = new Map<string, AlertKind>([
  [
    "executor-unavailable",
    {
      title: "대화 실행 서버 응답 없음",
      detail: "대화 실행 서버(api-msg) 상태 확인에 실패했습니다.",
      page: conversations,
    },
  ],
  [
    "messaging-unavailable",
    {
      title: "iMessage 연결 끊김",
      detail: "iMessage 연결 상태를 확인해 주세요.",
      page: conversations,
    },
  ],
  [
    "screen-locked",
    {
      title: "Messages Mac 화면 잠김",
      detail: "메시징 화면이 잠겨 있습니다.",
      page: conversations,
    },
  ],
  [
    "disk-nearly-full",
    {
      title: "실행 서버 디스크 부족",
      detail: "실행 서버의 디스크 여유 공간이 부족합니다.",
      page: conversations,
    },
  ],
  [
    "provider-failing",
    {
      title: "AI 응답 실패 지속",
      detail: "모델 제공자 오류로 대화 응답이 10분 넘게 실패하고 있습니다.",
      page: conversations,
    },
  ],
  [
    "go-cap",
    {
      title: "OpenCode Go 사용 한도 도달",
      detail: "사용 한도에 도달해 대화 응답을 보류했습니다. 15분마다 다시 확인합니다.",
      page: conversations,
    },
  ],
  [
    "conversation-turn-failing:",
    {
      title: "대화 응답 실패",
      detail: "한 대화의 응답이 반복해서 실패했거나, 메시지를 보낸 뒤 실패해 확인이 필요합니다.",
      page: conversations,
    },
  ],
  [
    "unexpected-tool",
    {
      title: "허용되지 않은 도구 감지",
      detail: "OpenCode가 페르소나에게 허용되지 않은 도구를 제공했습니다.",
      page: conversations,
    },
  ],
  [
    "greeting:",
    {
      title: "첫 인사 실패",
      detail: "첫 인사에 실패했거나 전송 결과가 불확실합니다.",
      page: firstContacts,
    },
  ],
  [
    "joins-failing",
    {
      title: "대기자 등록 실패 반복",
      detail: "최근 한 시간 동안 시스템 원인으로 등록이 3회 이상 실패했습니다.",
      page: waitlist,
    },
  ],
  [
    "notification-cap",
    {
      title: "등록 안내 한도 도달",
      detail: "시간당 30건 한도로 등록 안내를 생략했습니다.",
      page: waitlist,
    },
  ],
]);
const unlisted: AlertKind = {
  title: "운영 확인 필요",
  detail: "대화 실행에 문제가 발생했습니다. 관리 화면에서 확인해 주세요.",
  page: conversations,
};
const describe = (name: string) =>
  alertKinds.get(name) ?? alertKinds.get(name.replace(/:.*/, ":")) ?? unlisted;
export const alertTitle = (name: string) => describe(name).title;

const timestamp = (at: number) => `<t:${Math.floor(at / 1000)}:f>`;
const duration = (milliseconds: number) => {
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.round(seconds / 60);
  return (
    [
      [Math.floor(minutes / 1440), "일"],
      [Math.floor(minutes / 60) % 24, "시간"],
      [minutes % 60, "분"],
    ] as const
  )
    .filter(([value]) => value > 0)
    .map(([value, unit]) => `${value}${unit}`)
    .join(" ");
};

const raisedMessage = (name: string, at: number) => {
  const { title, detail, page } = describe(name);
  return card(accents.raised, [
    section(
      `### 🔴 ${title}\n${detail}\n-# \`${name}\` · ${timestamp(at)} 발생`,
      page.label,
      page.url,
    ),
  ]);
};

/** Alerts raised before Metrics shipped have no recorded start (`raisedAt` 0). */
const clearedMessage = (name: string, at: number, raisedAt: number) =>
  card(accents.cleared, [
    text(
      [
        `### ✅ 해제 · ${describe(name).title}`,
        ...(raisedAt ? [`${duration(at - raisedAt)} 만에 해제되었습니다.`] : []),
        `-# \`${name}\` · ${raisedAt ? `${timestamp(raisedAt)} 발생 · ` : ""}${timestamp(at)} 해제`,
      ].join("\n"),
    ),
  ]);

/** The caller owns the transaction so the state change and its message commit together. */
export const changeAlert = (name: string, raised: boolean) =>
  Effect.gen(function* () {
    if (!/^[a-zA-Z0-9:_-]{1,160}$/.test(name)) return;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* Clock.currentTimeMillis;
    if (raised) {
      const { detail, page } = describe(name);
      const inserted =
        yield* sql`INSERT OR IGNORE INTO application_alert(name, raised_at, detail, url) VALUES (${name}, ${now}, ${detail}, ${page.url}) RETURNING name`;
      if (inserted.length) yield* queueDiscord(randomUUID(), "alerts", raisedMessage(name, now));
      return;
    }
    const [cleared] = yield* sql<{
      raisedAt: number;
    }>`DELETE FROM application_alert WHERE name = ${name} RETURNING raised_at AS raisedAt`;
    if (cleared)
      yield* queueDiscord(randomUUID(), "alerts", clearedMessage(name, now, cleared.raisedAt));
  });
