import { useState } from "react";
import { PublicProfileView } from "@ren-ai/personas/public-profile-view";
import { projectPublicProfile } from "@ren-ai/personas/profile-projection";
import { splitPersonaMarkdown } from "@ren-ai/personas/profile";
import { ageOn, birthDateOf } from "@ren-ai/personas/birth-date";
import { thumbnailUrl } from "@ren-ai/personas/image-url";
import type { PersonaImage } from "@ren-ai/personas";

export function PublicPersonaPreview({
  name,
  source,
  images,
}: {
  name: string;
  source: string;
  images: readonly PersonaImage[];
}) {
  const [style, setStyle] = useState<"photo" | "anime">(
    images.some((image) => image.style === "photo") ? "photo" : "anime",
  );
  const [index, setIndex] = useState(0);
  const photos = images.filter((image) => image.style === style);
  const selected = Math.min(index, Math.max(0, photos.length - 1));
  let profile;
  let age: number | undefined;
  let invalid = false;
  try {
    const markdown = splitPersonaMarkdown(source).publicMarkdown;
    if (markdown) profile = projectPublicProfile(markdown);
  } catch {
    invalid = true;
  }
  try {
    const birthDate = birthDateOf(source);
    if (birthDate) age = ageOn(birthDate);
  } catch {
    age = undefined;
  }
  return (
    <section className="public-persona-preview" aria-label="사용자에게 보이는 프로필">
      <div className="preview-style-controls">
        {(["photo", "anime"] as const).map((key) => (
          <button
            key={key}
            type="button"
            className="secondary"
            aria-pressed={style === key}
            onClick={() => {
              setStyle(key);
              setIndex(0);
            }}
          >
            {key === "photo" ? "실사" : "애니메"}
          </button>
        ))}
      </div>
      {photos[selected] ? (
        <img
          src={thumbnailUrl(photos[selected].imageUrl)}
          alt={`${name} 프로필 사진 ${selected + 1}`}
          width={800}
          height={1000}
        />
      ) : (
        <div className="profile-photo-empty">아직 이 스타일의 사진이 없습니다.</div>
      )}
      {photos.length > 1 && (
        <div className="preview-photo-controls">
          <button
            type="button"
            className="secondary"
            disabled={selected === 0}
            onClick={() => setIndex(selected - 1)}
            aria-label="이전 프로필 사진"
          >
            ←
          </button>
          <span>
            {selected + 1} / {photos.length}
          </span>
          <button
            type="button"
            className="secondary"
            disabled={selected === photos.length - 1}
            onClick={() => setIndex(selected + 1)}
            aria-label="다음 프로필 사진"
          >
            →
          </button>
        </div>
      )}
      <div className="public-profile-body">
        <h2>
          {name || "새 페르소나"}
          {age !== undefined && `, ${age}`}
        </h2>
        {invalid ? (
          <p>공개 프로필의 형식을 확인해 주세요.</p>
        ) : profile ? (
          <PublicProfileView profile={profile} />
        ) : (
          <p>Persona의 공개 프로필을 작성하세요.</p>
        )}
      </div>
    </section>
  );
}
