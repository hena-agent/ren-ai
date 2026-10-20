import { personaImages } from "@ren-ai/personas";
import type { PersonaRecord, IdentitySheets } from "@ren-ai/personas";
import { IdentitySheetPanel } from "./identity-sheet-panel.tsx";
import { PublicPersonaPreview } from "./public-persona-preview.tsx";
import { Comparison } from "./profile-preview.tsx";
import { isSheetIntent } from "./image-slots.ts";
import type { ImageJob } from "./image-queue.ts";

export function PortraitManager({
  persona,
  action,
  locked,
  sheets = {},
  reservations,
  jobs,
}: {
  persona: PersonaRecord;
  action: string;
  locked: boolean;
  sheets?: IdentitySheets | undefined;
  reservations?: { anime: number; photo: number } | undefined;
  jobs: readonly { job: ImageJob | undefined }[];
}) {
  const sheetBusy = jobs.some(
    ({ job }) =>
      job && (job.state === "queued" || job.state === "running") && isSheetIntent(job.batch.intent),
  );
  return (
    <aside className="portrait-manager" aria-labelledby="preview-title">
      <IdentitySheetPanel sheets={sheets} action={action} locked={locked} />
      <div
        data-public-preview
        data-images={JSON.stringify(
          personaImages(persona).map(({ style, imageUrl }) => ({ style, imageUrl })),
        )}
      >
        <PublicPersonaPreview
          name={persona.name}
          source={persona.description ?? persona.prompt}
          images={personaImages(persona)}
        />
      </div>
      <div className="portrait-manager-heading">
        <h2 id="preview-title">프로필 사진</h2>
      </div>
      <p className="hint">스타일별 최대 6장 · 변경한 사진은 저장 후 공개됩니다.</p>
      <Comparison
        persona={persona}
        action={action}
        locked={locked}
        reservations={reservations}
        sheets={sheets}
        sheetBusy={sheetBusy}
      />
    </aside>
  );
}
