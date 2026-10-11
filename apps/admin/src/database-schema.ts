import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const personas = sqliteTable("personas", {
  id: text().primaryKey(),
  name: text().notNull(),
  gender: text({ enum: ["female", "male"] }),
  descriptionVersion: integer(),
  markdown: text().notNull(),
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
});

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
