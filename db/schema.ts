// Schema Postgres (Supabase). La migrazione SQL corrispondente è in
// supabase/migrations/0001_init.sql: tieni i due file allineati.
import { bigint, integer, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

export const models = pgTable("models", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  /** proprietario (auth.users.id di Supabase) */
  userId: uuid("user_id").notNull(),
  name: varchar("name", { length: 120 }).notNull(),
  mode: varchar("mode", { length: 16 }).notNull(),
  glbKey: varchar("glb_key", { length: 255 }).notNull().default(""),
  photoKey: varchar("photo_key", { length: 255 }).notNull().default(""),
  vertices: integer("vertices").notNull().default(0),
  triangles: integer("triangles").notNull().default(0),
  sizeBytes: integer("size_bytes").notNull().default(0),
  /** ready | processing | failed — la generazione AI è asincrona */
  status: varchar("status", { length: 16 }).notNull().default("ready"),
  /** messaggio di errore quando status = failed */
  error: varchar("error", { length: 255 }),
  /** pipeline AI: motore usato (tripo, meshy, rodin, fal-hunyuan, fal-trellis) */
  provider: varchar("provider", { length: 32 }),
  providerModel: varchar("provider_model", { length: 64 }),
  /** bozza | standard | pro */
  quality: varchar("quality", { length: 16 }),
  /** ecommerce | stampa | render | gioco */
  target: varchar("target", { length: 16 }),
  /** numero di foto usate (1–4) */
  views: integer("views").notNull().default(1),
  /** avanzamento 0–100 e fase leggibile, aggiornati durante la generazione */
  progress: integer("progress").notNull().default(0),
  stage: varchar("stage", { length: 96 }),
  /** anteprima renderizzata dal motore (miniatura galleria) */
  previewKey: varchar("preview_key", { length: 255 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ModelRow = typeof models.$inferSelect;

/** Galleria Foto (supabase/migrations/0003_images.sql): immagini da testo e foto dei modelli. */
export const images = pgTable("images", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  userId: uuid("user_id").notNull(),
  /** ai = creata dal testo · foto = caricata per generare un modello */
  source: varchar("source", { length: 8 }).notNull().default("ai"),
  name: varchar("name", { length: 120 }).notNull().default(""),
  prompt: varchar("prompt", { length: 600 }),
  style: varchar("style", { length: 16 }),
  path: varchar("path", { length: 255 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ImageRow = typeof images.$inferSelect;
