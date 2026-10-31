import { renderToStaticMarkup } from "react-dom/server";
import type { SeedingRun } from "./seeding-store.ts";
import type { ReviewedSeed } from "./seeding-review.ts";
import type { SeedingModels } from "./seeding-budget.ts";
import { html } from "./html-response.ts";
import { codexImageModel } from "@ren-ai/image-generation";
import { AdminLayout } from "./admin-layout.tsx";

export function seedingPage(
  runs: readonly SeedingRun[],
  models: SeedingModels,
  detail?: { run: SeedingRun; seeds: readonly ReviewedSeed[] },
) {
  return html(
    "<!doctype html>" +
      renderToStaticMarkup(
        <AdminLayout active="seeding" title="시딩 · RenAI">
          <main id="main" className="seeding-workspace">
            <div className="page-heading">
              <p className="eyebrow">PERSONAS / SEEDING</p>
              <h1>시딩</h1>
              <p className="description">
                Seed 목록에서 페르소나를 생성하고, 미공개 결과를 검토한 뒤 게시합니다.
              </p>
            </div>
            {detail && <a href="/seeding">← 시딩 목록</a>}
            <p className="notice">
              로컬 시딩 명령으로 seed 목록을 업로드하세요. 업로드만으로 유료 생성이 시작되지는
              않습니다.
            </p>
            <div lang="en">
              {detail ? (
                <>
                  <p>
                    {detail.run.dataset} · {detail.run.revision}
                  </p>
                  <p>
                    {detail.seeds.length} personas · {detail.seeds.length * 4} images (two sheets
                    and two photos per persona).
                  </p>
                  <p>
                    2–4 text calls per persona.{" "}
                    {models.image === codexImageModel
                      ? "Codex images have no incremental charge; text calls reserve the Gemini maximum."
                      : `Estimated output/text cost: $${(detail.seeds.length * 0.35).toFixed(2)}; actual costs vary.`}
                  </p>
                  <p>
                    {models.text} · {models.image}. Gemini explicitly rejected 429 requests may
                    retry twice (5s and 10s); at most 12 text dispatches and 12 Gemini image
                    dispatches per persona. Codex uses four image dispatches with no automatic
                    retries. All attempts reserve their configured cost, including failures.
                    Uncertain calls require individual confirmation.
                  </p>
                  <p>
                    Reserved maximum: ${(detail.run.reservedMicros / 1e6).toFixed(2)} / $
                    {(detail.run.budgetMicros / 1e6).toFixed(2)}. Reservations conservatively bound
                    spending, not actual bills.
                  </p>
                  {!detail.run.confirmed && (
                    <form method="post">
                      <input type="hidden" name="intent" value="confirm" />
                      <label>
                        Maximum USD budget{" "}
                        <input
                          name="budget"
                          type="number"
                          min="1"
                          max="1000"
                          step="0.01"
                          defaultValue={detail.seeds.length * 3}
                          required
                        />
                      </label>
                      <p>
                        Confirm these exact seeds, both identity sheets and one photo per style,
                        with empty optional prompts. Results remain unpublished.
                      </p>
                      <button>Confirm paid run</button>
                    </form>
                  )}
                  <form method="post">
                    <input type="hidden" name="intent" value="publish" />
                    <div className="contact-table">
                      <table>
                        <thead>
                          <tr>
                            <th>Publish</th>
                            <th>Persona</th>
                            <th>Stage</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.seeds.map((seed) => (
                            <tr key={seed.personaId}>
                              <td>
                                <input
                                  type="checkbox"
                                  name="persona"
                                  value={seed.selection}
                                  aria-label={`Publish ${seed.source.name}`}
                                  disabled={!seed.selection || seed.published}
                                />
                              </td>
                              <td>
                                {seed.selection ? (
                                  <a href={`/personas/${seed.personaId}`}>{seed.source.name}</a>
                                ) : (
                                  seed.source.name
                                )}
                                {seed.source.locale && (
                                  <p>
                                    English · Native: {seed.source.locale.native.join(", ")} ·{" "}
                                    {seed.source.locale.timeZone}
                                  </p>
                                )}
                              </td>
                              <td>
                                {seed.published ? "Published" : seed.stage}
                                {seed.imageJobs.map((job) => (
                                  <p key={job.id}>
                                    <a href={`/image-jobs/${job.id}`}>
                                      {job.state === "failed"
                                        ? "Review failed images and confirm individual retries"
                                        : "View image progress"}
                                    </a>{" "}
                                    · Request ID: {job.requestId}
                                  </p>
                                ))}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <button>Publish reviewed selections</button>
                  </form>
                  <p>
                    Refresh to see progress. Open a persona to review her documents, sheets and
                    photos, or retry an individual failed image.
                  </p>
                  {detail.seeds
                    .filter((seed) => seed.stage === "failed")
                    .map((seed) => (
                      <form method="post" key={seed.personaId}>
                        <input type="hidden" name="intent" value="retry" />
                        <input type="hidden" name="persona" value={seed.personaId} />
                        <p>
                          {seed.source.name}: failed at {seed.retryStage}. Request ID:{" "}
                          {detail.run.requestId}. An interrupted call may have been billed;
                          completed drafts are retained.
                        </p>
                        <button>Confirm retry for {seed.source.name}</button>
                      </form>
                    ))}
                </>
              ) : runs.length ? (
                <ul className="seeding-runs">
                  {runs.map((run) => (
                    <li key={run.id}>
                      <a href={`/seeding/${run.id}`}>{run.id}</a> ·{" "}
                      {run.confirmed ? "Confirmed" : "Awaiting confirmation"}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="empty" lang="ko">
                  <p>아직 시딩 기록이 없습니다.</p>
                  <p>로컬 시딩 명령으로 seed 목록을 업로드하면 이곳에 표시됩니다.</p>
                </div>
              )}
            </div>
          </main>
        </AdminLayout>,
      ),
  );
}
