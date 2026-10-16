import { basicProfileFields } from "@ren-ai/personas/public-profile";
import { ProfileFactFields } from "./profile-fact-fields.tsx";
import type { ProfileFactProps } from "./profile-fact-fields.tsx";

const labelOf = (row: string) => row.slice(2, row.indexOf(":")).trim();
const labels: readonly string[] = basicProfileFields.map((field) => field.label);
const isBasic = (row: string) => labels.includes(labelOf(row));

export function BasicProfileFields({ body, onChange }: ProfileFactProps) {
  const rows = body ? body.split("\n") : [];
  if (rows.some((row) => !/^- [^:\n]+:.*$/.test(row)))
    return <ProfileFactFields body={body} onChange={onChange} />;
  return (
    <div className="basic-profile-fields">
      {labels.map((label) => {
        const row = rows.find((item) => labelOf(item) === label);
        return (
          <label key={label}>
            {label} · 공개할 때만 입력
            <input
              value={row ? row.slice(row.indexOf(":") + 1).trimStart() : ""}
              onInput={(event) => {
                const value = event.currentTarget.value;
                const next = rows.filter((item) => labelOf(item) !== label);
                if (value.trim()) next.push(`- ${label}: ${value}`);
                onChange(next.join("\n"));
              }}
            />
          </label>
        );
      })}
      <ProfileFactFields
        body={rows.filter((row) => !isBasic(row)).join("\n")}
        onChange={(extra) => onChange([...rows.filter(isBasic), extra].filter(Boolean).join("\n"))}
      />
    </div>
  );
}
