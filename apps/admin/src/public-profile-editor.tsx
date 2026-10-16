import { useState } from "react";
import { splitPersonaMarkdown, withPublicProfile } from "@ren-ai/personas/profile";
import {
  profileSectionTitles,
  readProfileSections,
  writeProfileSections,
  profileSectionKind,
} from "@ren-ai/personas/profile-sections";
import type { ProfileSection } from "@ren-ai/personas/profile-sections";
import { ProfileFactFields } from "./profile-fact-fields.tsx";

function editableProfile(source: string) {
  try {
    return readProfileSections(splitPersonaMarkdown(source).publicMarkdown);
  } catch {
    return undefined;
  }
}

function SectionFields({
  section,
  onChange,
}: {
  section: ProfileSection;
  onChange: (section: ProfileSection) => void;
}) {
  const kind = profileSectionKind(section.title);
  return (
    <>
      <label>
        {kind === "answer" ? "질문" : "제목"}
        <input
          value={kind === "answer" ? section.title.slice(4) : section.title}
          required
          pattern="[^\r\n]+"
          onInput={(event) =>
            onChange({
              ...section,
              title:
                kind === "answer"
                  ? `문답: ${event.currentTarget.value}`
                  : event.currentTarget.value,
            })
          }
        />
      </label>
      {kind === "facts" ? (
        <ProfileFactFields
          body={section.body}
          onChange={(body) => onChange({ ...section, body })}
        />
      ) : kind === "interests" ? (
        <label>
          관심사 · 쉼표로 구분
          <input
            value={section.body.replace(/^- /gm, "").split("\n").join(", ")}
            onInput={(event) =>
              onChange({
                ...section,
                body: event.currentTarget.value
                  .split(",")
                  .map((tag) => `- ${tag.trim()}`)
                  .join("\n"),
              })
            }
          />
        </label>
      ) : (
        <label>
          {kind === "answer" ? "답변" : "내용"}
          <textarea
            rows={3}
            value={section.body}
            placeholder="이 인물의 말투로 작성하세요."
            onInput={(event) => onChange({ ...section, body: event.currentTarget.value })}
          />
        </label>
      )}
    </>
  );
}

export function PublicProfileEditor({
  source,
  locked,
  onChange,
}: {
  source: string;
  locked: boolean;
  onChange: (source: string) => void;
}) {
  const [type, setType] = useState<string>(profileSectionTitles[0]);
  const [editing, setEditing] = useState(() => ({ source, profile: editableProfile(source) }));
  if (editing.source !== source) {
    setEditing({ source, profile: editableProfile(source) });
    return null;
  }
  const profile = editing.profile;
  if (!profile) {
    return <output>공개 프로필 경계를 수정한 뒤 항목을 편집하세요.</output>;
  }
  const update = (next: typeof profile) => {
    const value = withPublicProfile(source, writeProfileSections(next));
    setEditing({ source: value, profile: next });
    onChange(value);
  };
  const change = (index: number, section: ProfileSection) =>
    update({
      ...profile,
      sections: profile.sections.map((current, ordinal) => (ordinal === index ? section : current)),
    });
  const move = (index: number, offset: number) => {
    const sections = [...profile.sections];
    [sections[index], sections[index + offset]] = [sections[index + offset]!, sections[index]!];
    update({ ...profile, sections });
  };
  return (
    <fieldset className="public-profile-editor" disabled={locked}>
      <legend>공개 프로필</legend>
      <p className="hint">
        사용자가 이 인물의 취향·생활·관계 스타일을 알 수 있게 작성하세요. 자기소개 외 항목은 선택
        사항입니다.
      </p>
      <label>
        자기소개
        <textarea
          rows={3}
          value={profile.introduction}
          onInput={(event) => update({ ...profile, introduction: event.currentTarget.value })}
        />
      </label>
      {profile.sections.map((section, index) => (
        <section className="profile-edit-section" key={index} aria-label={`공개 항목 ${index + 1}`}>
          <SectionFields section={section} onChange={(next) => change(index, next)} />
          <div className="profile-item-actions">
            <button
              type="button"
              disabled={index === 0}
              onClick={() => move(index, -1)}
              aria-label={`${section.title} 위로`}
            >
              ↑
            </button>
            <button
              type="button"
              disabled={index === profile.sections.length - 1}
              onClick={() => move(index, 1)}
              aria-label={`${section.title} 아래로`}
            >
              ↓
            </button>
            <button
              type="button"
              onClick={() =>
                update({
                  ...profile,
                  sections: profile.sections.filter((_, ordinal) => ordinal !== index),
                })
              }
            >
              항목 삭제
            </button>
          </div>
        </section>
      ))}
      <div className="profile-item-actions">
        <label>
          추가할 항목
          <select value={type} onChange={(event) => setType(event.target.value)}>
            {profileSectionTitles.map((title) => (
              <option key={title}>{title}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() =>
            update({
              ...profile,
              sections: [
                ...profile.sections,
                {
                  title:
                    type === "문답"
                      ? "문답: 완벽한 일요일은?"
                      : type === "자유 항목"
                        ? "나에 대해"
                        : type,
                  body: "",
                },
              ],
            })
          }
        >
          항목 추가
        </button>
      </div>
    </fieldset>
  );
}
