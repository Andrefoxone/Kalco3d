import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value && process.env.NODE_ENV === "production") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value ?? "";
}

export const env = {
  isProduction: process.env.NODE_ENV === "production",
  /** connessione Postgres di Supabase (pooler, porta 6543) */
  databaseUrl: required("DATABASE_URL"),
  /** https://<progetto>.supabase.co */
  supabaseUrl: required("SUPABASE_URL"),
  /** chiave segreta (sb_secret_… o service_role): solo server, mai nel browser */
  supabaseSecretKey: required("SUPABASE_SECRET_KEY"),
  /** bucket privato dei file (GLB, foto, anteprime) */
  storageBucket: process.env.SUPABASE_BUCKET || "kalco3d",
};
