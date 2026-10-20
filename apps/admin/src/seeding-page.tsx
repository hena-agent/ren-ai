import { renderToStaticMarkup } from "react-dom/server";
import type { SeedingRun } from "./seeding-store.ts";
import type { ReviewedSeed } from "./seeding-review.ts";
import type { SeedingModels } from "./seeding-budget.ts";
import { html } from "./html-response.ts";

export function seedingPage(
  runs: readonly SeedingRun[],
  models: SeedingModels,
  detail?: { run: SeedingRun; seeds: readonly ReviewedSeed[] },
) {
  return html(
    "<!doctype html>" +
      renderToStaticMarkup(
        <html lang="en">
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <title>Seeding runs · Ren AI</title>
            <style>
              {
                "body{max-width:960px;margin:2rem auto;padding:1rem;font:16px system-ui;background:#fafafa;color:#222}button,input{font:inherit;min-height:44px}td,th{padding:.6rem;text-align:left}table{width:100%}img{width:80px}fieldset{margin:1rem 0}"
              }
            </style>
          </head>
          <body>
            <a href="/">Personas</a> · <a href="/seeding">Seeding runs</a>
            <h1>Seeding runs</h1>
            <p>
              Upload a seed manifest using the local seeding command. Uploading never starts paid
              generation.
            </p>
            {detail ? (
              <>
                <p>
                  {detail.run.dataset} · {detail.run.revision}
                </p>
                <p>
                  {detail.seeds.length} personas · {detail.seeds.length * 4} images (two sheets and
                  two photos per persona).
                </p>
                <p>
                  2–4 text calls per persona. Estimated output/text cost: $
                  {(detail.seeds.length * 0.35).toFixed(2)}; actual costs vary.
                </p>
                <p>
                  {models.text} · {models.image} · 1K. Up to two retries per explicitly rejected 429
                  request (5s and 10s): at most 12 text dispatches and 12 image dispatches per
                  persona. All attempts reserve budget, including failures.
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
                      Confirm these exact seeds, both identity sheets and one photo per style, with
                      empty optional prompts. Results remain unpublished.
                    </p>
                    <button>Confirm paid run</button>
                  </form>
                )}
                <form method="post">
                  <input type="hidden" name="intent" value="publish" />
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
                        {detail.run.requestId}. An interrupted call may have been billed; completed
                        drafts are retained.
                      </p>
                      <button>Confirm retry for {seed.source.name}</button>
                    </form>
                  ))}
              </>
            ) : (
              <ul>
                {runs.map((run) => (
                  <li key={run.id}>
                    <a href={`/seeding/${run.id}`}>{run.id}</a> ·{" "}
                    {run.confirmed ? "Confirmed" : "Awaiting confirmation"}
                  </li>
                ))}
              </ul>
            )}
          </body>
        </html>,
      ),
  );
}
