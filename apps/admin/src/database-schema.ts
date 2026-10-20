import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  primaryKey,
  index,
} from "drizzle-orm/sqlite-core";

export const personas = sqliteTable(
  "personas",
  {
    id: text().primaryKey(),
    name: text().notNull(),
    gender: text({ enum: ["female", "male"] }),
    descriptionVersion: integer(),
    currentVersion: integer().notNull().default(1),
    timeZone: text().notNull(),
    language: text().notNull(),
    openingLine: text().notNull(),
    memoryInstruction: text().notNull(),
    published: integer({ mode: "boolean" }).notNull(),
    state: text().notNull(),
    memory: text().notNull(),
    revision: integer().notNull(),
    commitId: text().notNull(),
    createdAt: integer().notNull(),
    updatedAt: integer().notNull(),
  },
  (table) => [
    index("persona_created_order").on(table.createdAt, table.id),
    index("persona_updated_order").on(table.updatedAt, table.id),
  ],
);

export const personaVersions = sqliteTable(
  "persona_versions",
  {
    personaId: text()
      .notNull()
      .references(() => personas.id, { onDelete: "cascade" }),
    version: integer().notNull(),
    markdown: text().notNull(),
    createdAt: integer().notNull(),
    restoredFrom: integer(),
  },
  (table) => [primaryKey({ columns: [table.personaId, table.version] })],
);

export const personaImages = sqliteTable(
  "persona_images",
  {
    personaId: text()
      .notNull()
      .references(() => personas.id, { onDelete: "cascade" }),
    objectKey: text().notNull(),
    style: text({ enum: ["anime", "photo"] }).notNull(),
    position: integer().notNull(),
    mimeType: text().notNull(),
    size: integer().notNull(),
  },
  (table) => [
    uniqueIndex("persona_image_position").on(table.personaId, table.style, table.position),
  ],
);

// Drafts have IDs before their first Persona save, so this table has no Persona FK.
export const identitySheets = sqliteTable(
  "persona_identity_sheets",
  {
    personaId: text().notNull(),
    style: text({ enum: ["anime", "photo"] }).notNull(),
    objectKey: text().notNull(),
    operationId: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.personaId, table.style] })],
);
