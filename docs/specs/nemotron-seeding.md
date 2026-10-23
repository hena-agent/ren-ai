# Nemotron seeding runs

Status: Korean seeding and English-speaking US previews supported. See [ADR-0021](../adr/0021-nemotron-derived-personas-carry-attribution-and-private-provenance.md).

## Scope and sequence

1. Korean seed selection → authenticated Admin upload → one run confirmation →
   Persona, initial State and Memory → two identity sheets → one photo per style →
   unpublished saves → operator review and selected publication.
2. Operator-reviewed Korean pilot of 20.
3. Japanese and English authoring with separate Japanese/US pilots. Keep fixed
   headings and private descriptions in Korean; speech examples and public writing
   use the Persona's primary language. Preserve evidenced native languages.
4. Before the 200 stage, page Discovery results in visitor-specific random order
   and preserve per-handle relationship-ending exclusions in the token-aware
   Reselection listing. Keep personas at capacity publicly listed without a badge;
   Selection enforces five current assignments per persona. Keep language/style choices.
5. Runs of up to 200, then pause to decide budget, capacity and further scaling.

Implementation does not itself confirm a paid run or publish its results. The
existing idea form remains Korean. No speculative global concurrency or provider
batch integration is part of the pilot.

## Seeds

Use official `nvidia/Nemotron-Personas-Korea`, then Japan and USA, pinned to source
commit hashes. One source record is one seed, not seven independent personas.
Female, age 20–39 inclusive at selection, never married; preserve source facts,
including unemployment, household, occupation, region, hobbies and goals. Reject
contradictory or ambiguous identities instead of changing their facts. Infer a
fictional birth date consistent with age on the selection date, then age normally.
Revalidate eligibility before paid generation if a run has waited.

Select equally across 20–24, 25–29, 30–34 and 35–39, randomly within each band.
A single-person preview (`--count 1`) may use any eligible age band; larger runs
remain balanced in multiples of four. Preview runs use the same source receipts,
paid confirmation, budget and unpublished-save workflow.
Retain names in their original script; skip duplicate full names already reserved
or in the Catalog. Preserve the complete source record privately. Never infer a
Persona's primary/native language merely from the dataset's prose language.
Korean pilot personas use Korean and Asia/Seoul. Later sources need language and
timezone mapping; do not default foreign personas to Seoul.

Records already consumed never become available through deletion or nonpublication.
Retain private source identity independently of Persona deletion. Store dataset,
revision and UUID outside Persona documents, versions and public/private Catalogs.

Verified Korea counts at revision `ada0f5b53a38bb5a30cce09358adde883c1ab63a`:
135,296 female records aged 20–39; 79,955 also never married. Age bands contain
27,135 / 27,941 / 16,690 / 8,189 never-married women. Equal bands limit this source
to 32,756 before duplicate names and other exclusions.

## Execution and review

### Image providers and US preview selection (2026-10-23)

- `ADMIN_IMAGE_PROVIDER` selects `gemini` or `arena`; text stays on Gemini.
  Arena uses the operator's `https://gpt-image.renai.im` API and server-only key,
  canonical `gpt-image-2.5-sunburst`, one output per call, base64 PNG responses,
  and inline same-style references for edits. Sheets are 1536×1024; photos are
  1024×1280. The shared FIFO, prompts, confirmation and storage are unchanged.
- The operator confirms no incremental Arena image charge: reserve $0 per image,
  retaining bounded text reservations. Arena failures require individual retry
  confirmation, including 429 and 5xx; no automatic cross-provider fallback.
  Switch providers only with idle image/seeding work.
- The approved next previews are two Korean and two English-speaking US women,
  unmarried and aged 20–35, saved unpublished with two sheets and one photo per
  style, empty optional prompts, and a $3/persona maximum. The planned 100+100
  is a later run, not part of this preview authorization.
- US seeds require individually reviewed native languages and IANA timezone
  in private seed `locale`. English is the selected primary language; source
  prose language never establishes native language. Preserve evidenced additional
  native languages, source facts and original names. US name extraction rejects
  ambiguous openings rather than inventing a name. Existing four-band balancing
  remains for larger manifests; single-person previews can use any eligible band.

### Confirmed execution

The local command selects source data; Admin owns generation, queueing and saves.
Upload alone never pays. Confirmation displays the exact seed/image counts,
generation/review/repair call bounds, estimated cost and selected models. A run
persists confirmation and deduplication before paid calls. Use the existing
character authoring/review and publication validators, not the legacy local-import
validation bypass. Preserve source name, gender and assigned birth date at the
generation boundary. Normal authoring takes two text calls, or four with repair.

The image dependency is always:

`Persona.md → anime/photo identity sheet → same-style profile photo`

Two independent sheets and one photo per style, four image outputs per complete
Persona. Sheets are not public gallery images. Default optional prompts are empty;
the run confirmation authorizes these specified images. Existing per-image prompts,
confirmation and retry remain available for later operator changes. All images use
the global durable FIFO. Completed siblings survive failures and restarts.

Persist progress before calls. Never automatically repeat an uncertain paid call.
Explicit rate-limit rejection can use bounded backoff; generic timeouts and 5xx
responses are not proof of an unbilled rejection. Failed drafts are reported before
images; failed images retain partial results and link to normal per-image recovery.
Do not draw replacement seeds silently. Save unpublished; operator-selected bulk
publication uses the normal validation and stale-edit checks.

The Korean command scans the pinned official Parquet source with DuckDB and
fetches Catalog/consumed exclusions in pages of at most 500 rows. It writes a
private mode-0600 manifest before upload. Reuploading the same manifest returns
the existing run; source receipts survive Persona deletion.

Confirmation displays the configured models and rejects unpriced overrides.
Before each dispatch, reserve a conservative maximum input/output cost against
the confirmed budget (default $3/persona). Failed and rejected attempts retain
their reservations. Only explicit `429 RESOURCE_EXHAUSTED` receives at most two
automatic retries, after 5s and 10s; every retry reserves again. The maximum is
12 text dispatches and 12 image dispatches per persona. The budget is immutable
after confirmation; the ~$0.35 estimate below is not a reservation or actual bill.

Interrupted text work requires individual confirmation unless a completed draft
was already persisted. Partial image results are saved unpublished with a
`partial` status and links to per-image progress and confirmed retry. Existing
queued retries retain their original run budget. Later separately confirmed image
actions use the ordinary authoring flow. Bulk publication fingerprints Persona and
initial State/Memory, prevalidates selected rows and holds their shared editor locks.
Saving a recovered Persona updates `partial` to `done` when both styles are present;
removing a style returns it to `partial`. A save conflict can be resolved by opening
the current Catalog editor, reviewing the saved documents and confirming the seed's
save retry. Recovery retains those operator edits without regeneration.

Estimates, not measured costs or service guarantees: four 1K outputs using
`gemini-3.1-flash-image` cost about $0.268 excluding inputs; roughly $0.35 per
complete Persona including estimated text work. Real timings, token usage, retries
and model overrides change totals. A run must be bounded, with no unbounded retries.

## Attribution

Keep source attribution in a GitHub comment only; Discovery does not display it.
Public persona writing remains self-presentation without source metadata.

## Approved test boundaries

- Seed command output: filtering, balanced selection, stable identities, rejection.
- Authenticated Admin upload/confirm/progress/review/publish requests.
- Real durable queue/storage recovery with scripted Gemini responses, including
  repeated submissions, actor replacement, partial failure and bounded idle work.

## Sources

- https://huggingface.co/datasets/nvidia/Nemotron-Personas-Korea
- https://huggingface.co/datasets/nvidia/Nemotron-Personas-Japan
- https://huggingface.co/datasets/nvidia/Nemotron-Personas-USA
- https://creativecommons.org/licenses/by/4.0/
- https://ai.google.dev/gemini-api/docs/pricing#gemini-3.1-flash-image
- Current image workflow: commit `434625b` and `persona-discovery-admin.md`.
