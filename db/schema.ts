// Schema Postgres (Supabase). La migrazione SQL corrispondente è in
// supabase/migrations/0001_init.sql: tieni i due file allineati.
import { bigint, doublePrecision, integer, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

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
  /** modello animato: da quale modello nasce (supabase/migrations/0004_rig.sql) */
  parentId: bigint("parent_id", { mode: "number" }),
  /** copia FBX del modello animato */
  fbxKey: varchar("fbx_key", { length: 255 }),
  /** animazioni nel file, separate da virgola */
  animations: varchar("animations", { length: 255 }),
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

/**
 * Scene (ambienti 3D) generate con World Labs Marble
 * (supabase/migrations/0005_worlds.sql). Separate dalla galleria Modelli.
 */
export const worlds = pgTable("worlds", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  userId: uuid("user_id").notNull(),
  name: varchar("name", { length: 120 }).notNull(),
  /** testo | foto */
  source: varchar("source", { length: 8 }).notNull(),
  prompt: varchar("prompt", { length: 2000 }),
  photoKey: varchar("photo_key", { length: 255 }),
  /** bozza | standard | grande */
  quality: varchar("quality", { length: 16 }).notNull(),
  /** ready | processing | failed */
  status: varchar("status", { length: 16 }).notNull().default("processing"),
  error: varchar("error", { length: 255 }),
  progress: integer("progress").notNull().default(0),
  stage: varchar("stage", { length: 96 }),
  /** crediti pagati per la scena (per il rimborso se il server si riavvia) */
  creditsPaid: integer("credits_paid").notNull().default(0),
  /** risultato del motore */
  worldId: varchar("world_id", { length: 96 }),
  marbleUrl: varchar("marble_url", { length: 255 }),
  caption: varchar("caption", { length: 600 }),
  spzKey: varchar("spz_key", { length: 255 }),
  spzResolution: varchar("spz_resolution", { length: 16 }),
  /** splat a piena risoluzione (più nitido), facoltativo */
  spzHqKey: varchar("spz_hq_key", { length: 255 }),
  spzHqResolution: varchar("spz_hq_resolution", { length: 16 }),
  spzHqBytes: integer("spz_hq_bytes").notNull().default(0),
  colliderKey: varchar("collider_key", { length: 255 }),
  panoKey: varchar("pano_key", { length: 255 }),
  thumbKey: varchar("thumb_key", { length: 255 }),
  /** unità del motore → metri, e quota del pavimento */
  metricScale: doublePrecision("metric_scale").notNull().default(1),
  groundOffset: doublePrecision("ground_offset").notNull().default(0),
  sizeBytes: integer("size_bytes").notNull().default(0),
  /** mesh GLB texturizzata, su richiesta: null | processing | ready | failed */
  meshStatus: varchar("mesh_status", { length: 16 }),
  meshKey: varchar("mesh_key", { length: 255 }),
  meshError: varchar("mesh_error", { length: 255 }),
  meshCreditsPaid: integer("mesh_credits_paid").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type WorldRow = typeof worlds.$inferSelect;
