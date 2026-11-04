import type { SocialAccount, SocialSnapshot } from "@ren-ai/onboarding/social";
import { SocialFailureDetails } from "./social-diagnostic.tsx";

export function SocialImageOptions({
  account,
  snapshot,
}: {
  account: SocialAccount | undefined;
  snapshot: SocialSnapshot | undefined;
}) {
  if (!snapshot?.imageSupport) return null;
  return (
    <fieldset>
      <legend>자율 이미지 창작</legend>
      <label>
        <input
          type="checkbox"
          name="imagesEnabled"
          value="1"
          defaultChecked={account?.images?.enabled ?? false}
        />
        승인 한도 안에서 자율 유료 생성 허용
      </label>
      <label>
        누적 유료 생성 승인 한도
        <input
          type="number"
          name="imageCredits"
          min="0"
          max="10000"
          required
          defaultValue={account?.images?.credits ?? 0}
        />
      </label>
      <label>
        이미지 스타일
        <select name="imageStyle" defaultValue={account?.images?.style ?? "photo"}>
          <option value="photo">실사</option>
          <option value="anime">애니메</option>
        </select>
      </label>
      <p className="hint">
        일일 생성 목표가 아닙니다. 이 계정의 승인 한도는 모든 소셜 계정에 표시되는 누적 총한도에
        합산됩니다. 맥락에 따른 dice로 생성 여부를 정하고, 본인 모습 75%·취향 창작 25%의 가중치를
        적용합니다. 이미지는 검수 후 별도로 게시를 선택합니다. 승인 한도를 늘리면 추가 유료 호출을
        허용합니다. 중단된 유료 호출은 자동 재시도하지 않습니다.
      </p>
    </fieldset>
  );
}
const stateNames = {
  skipped: "dice 미선택",
  queued: "대기",
  generating: "생성 중",
  ready: "검수 대기",
  approved: "검수 통과 · 미게시",
  rejected: "검수 제외",
  publishing: "게시 시도 중",
  posted: "게시 확인됨",
  failed: "생성 실패",
  uncertain: "결과 미확인",
  expired: "초안 만료",
};
export function SocialImageUsage({
  account,
  spent,
}: {
  account: SocialAccount;
  spent: number | undefined;
}) {
  if (!account.images) return null;
  return (
    <p className="hint">
      유료 생성 승인 한도 사용 {spent ?? 0}/{account.images.credits} ·{" "}
      {account.images.enabled ? "자율 생성 허용" : "새 생성 중지"}
    </p>
  );
}
export function SocialImagesPanel({
  snapshot,
  accountIds,
}: {
  snapshot: SocialSnapshot | undefined;
  accountIds: ReadonlySet<string>;
}) {
  if (!snapshot?.imageSupport) return null;
  const images = snapshot.images?.filter((image) => accountIds.has(image.accountId)) ?? [];
  return (
    <section className="contact-panel" aria-label="소셜 이미지 작업">
      <h2>이미지 창작·검수·게시</h2>
      {snapshot.imageAllowance && (
        <p className="hint">
          모든 소셜 계정 합산 유료 생성 승인 한도 {snapshot.imageAllowance.spent}/
          {snapshot.imageAllowance.approved}
        </p>
      )}
      {!images.length && <p>표시할 이미지 작업이 없습니다.</p>}
      {images.map((image) => (
        <article key={image.id}>
          <h3>
            {image.kind === "self" ? "본인 모습" : "취향 창작"} · {stateNames[image.state]}
          </h3>
          <p className="hint">
            생성 확률 {image.probability / 100}% · dice {image.roll} / 10000 · 종류 dice{" "}
            {image.kindRoll} / 10000
          </p>
          {["ready", "approved", "rejected", "publishing", "posted"].includes(image.state) && (
            <img
              src={`/social/images/${encodeURIComponent(image.accountId)}/${encodeURIComponent(image.id)}`}
              alt={`${image.kind === "self" ? "페르소나 본인 모습" : "페르소나의 창작"} 이미지 초안`}
              loading="lazy"
              width="240"
              height="320"
            />
          )}
          <SocialFailureDetails diagnostic={image.diagnostic} />
        </article>
      ))}
    </section>
  );
}
