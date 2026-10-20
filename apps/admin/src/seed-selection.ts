import { Schema } from "effect";
import { PersonaError } from "@ren-ai/personas";
import { ageOn, BirthDate } from "@ren-ai/personas/birth-date";

const validBirthDate = (value: string): boolean => Schema.is(BirthDate)(value);

const sourceSchema = Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number]));
const Seed = Schema.Struct({
  uuid: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
  name: Schema.String.check(Schema.isPattern(/^[가-힣]{2,6}$/)),
  age: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 20, maximum: 39 })),
  birthDate: Schema.String,
  source: sourceSchema,
});
const Manifest = Schema.Struct({
  dataset: Schema.Literal("nvidia/Nemotron-Personas-Korea"),
  revision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
  date: Schema.String,
  seeds: Schema.Array(Seed).check(Schema.isMinLength(4), Schema.isMaxLength(200)),
});
export type SeedManifest = typeof Manifest.Type;
export type PersonaSeed = typeof Seed.Type;
export const seedSecrets = (seed: PersonaSeed) => [
  JSON.stringify(seed),
  seed.name,
  ...Object.values(seed.source).filter(
    (value): value is string => typeof value === "string" && value.length >= 4,
  ),
];
export const decodeSeed = Schema.decodeUnknownSync(Seed);
export const seedNameKey = (name: string) =>
  name.normalize("NFKC").replace(/\s/g, "").toLowerCase();
export const seedError = () =>
  new PersonaError("invalid", "Invalid or conflicting seeding manifest");

// oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: validate an uploaded dataset manifest before persistence or paid generation
export function readSeedManifest(input: unknown): SeedManifest {
  let manifest: SeedManifest;
  try {
    manifest = Schema.decodeUnknownSync(Manifest)(input, { onExcessProperty: "error" });
  } catch {
    throw seedError();
  }
  if (!validBirthDate(manifest.date) || manifest.seeds.length % 4) throw seedError();
  const names = new Set<string>();
  const ids = new Set<string>();
  const bands = [0, 0, 0, 0];
  for (const seed of manifest.seeds) {
    const { source } = seed;
    if (
      source["uuid"] !== seed.uuid ||
      source["sex"] !== "여자" ||
      source["age"] !== seed.age ||
      source["marital_status"] !== "미혼" ||
      source["country"] !== "대한민국" ||
      nameOf(source) !== seed.name ||
      !validBirthDate(seed.birthDate) ||
      ageOn(seed.birthDate, new Date(`${manifest.date}T00:00:00Z`)) !== seed.age ||
      JSON.stringify(source).length > 24000 ||
      names.has(seedNameKey(seed.name)) ||
      ids.has(seed.uuid)
    )
      throw seedError();
    names.add(seedNameKey(seed.name));
    ids.add(seed.uuid);
    bands[Math.floor((seed.age - 20) / 5)]!++;
  }
  if (bands.some((count) => count !== manifest.seeds.length / 4)) throw seedError();
  return manifest;
}

const nameOf = (source: typeof sourceSchema.Type) =>
  typeof source["persona"] === "string"
    ? /^([가-힣]{2,6})\s*씨는\s/.exec(source["persona"])?.[1]
    : undefined;

/** Input rows are randomized within age bands by the local DuckDB scan. */
export function selectSeeds(
  // oxlint-disable-next-line typescript/no-restricted-types -- trust boundary: narrow rows parsed from the dataset or a local JSON export
  input: unknown,
  options: {
    count: number;
    revision: string;
    date: string;
    names: readonly string[];
    records: readonly string[];
  },
): SeedManifest {
  if (
    !Number.isInteger(options.count) ||
    options.count < 4 ||
    options.count > 200 ||
    options.count % 4
  )
    throw seedError();
  const rows = Schema.decodeUnknownSync(Schema.Array(sourceSchema))(input);
  const names = new Set(options.names.map(seedNameKey));
  const records = new Set(options.records);
  const bands: PersonaSeed[][] = [[], [], [], []];
  for (const source of rows) {
    const age = source["age"];
    const uuid = source["uuid"];
    const name = nameOf(source);
    if (
      typeof age !== "number" ||
      !Number.isInteger(age) ||
      age < 20 ||
      age > 39 ||
      source["sex"] !== "여자" ||
      source["marital_status"] !== "미혼" ||
      !name ||
      typeof uuid !== "string" ||
      names.has(seedNameKey(name)) ||
      records.has(uuid)
    )
      continue;
    const band = bands[Math.floor((age - 20) / 5)]!;
    if (band.length >= options.count / 4) continue;
    let birthDate = `${Number(options.date.slice(0, 4)) - age}${options.date.slice(4)}`;
    if (birthDate.endsWith("02-29") && !validBirthDate(birthDate))
      birthDate = `${birthDate.slice(0, 8)}28`;
    band.push({ uuid, name, age, birthDate, source });
    names.add(seedNameKey(name));
    records.add(uuid);
  }
  const seeds = bands.flat();
  if (seeds.length !== options.count)
    throw new PersonaError("invalid", "Not enough distinct eligible seeds in every age band");
  return readSeedManifest({
    dataset: "nvidia/Nemotron-Personas-Korea",
    revision: options.revision,
    date: options.date,
    seeds,
  });
}
