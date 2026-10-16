export function ProfileFactFields({
  body,
  onChange,
}: {
  body: string;
  onChange: (body: string) => void;
}) {
  const rows = body ? body.split("\n") : [];
  if (rows.some((row) => !/^- [^:\n]*:.*$/.test(row)))
    return (
      <label>
        내용 · 기존 Markdown
        <textarea rows={3} value={body} onInput={(event) => onChange(event.currentTarget.value)} />
      </label>
    );
  const replace = (index: number, label: string, value: string) =>
    onChange(
      rows.map((row, ordinal) => (ordinal === index ? `- ${label}: ${value}` : row)).join("\n"),
    );
  return (
    <div className="profile-fact-fields">
      {rows.map((row, index) => {
        const colon = row.indexOf(":");
        const label = row.slice(2, colon);
        const value = row.slice(colon + 1).trimStart();
        return (
          <div className="profile-item-actions" key={index}>
            <label>
              정보 이름
              <input
                value={label}
                required
                placeholder="직업"
                onInput={(event) => replace(index, event.currentTarget.value, value)}
              />
            </label>
            <label>
              정보 내용
              <input
                value={value}
                required
                placeholder="도예가"
                onInput={(event) => replace(index, label, event.currentTarget.value)}
              />
            </label>
            <button
              type="button"
              onClick={() => onChange(rows.filter((_, ordinal) => ordinal !== index).join("\n"))}
            >
              정보 삭제
            </button>
          </div>
        );
      })}
      <button type="button" onClick={() => onChange([...rows, "- : "].join("\n"))}>
        정보 추가
      </button>
    </div>
  );
}
