import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../lib/env";
import * as schema from "@db/schema";

let instance: ReturnType<typeof drizzle<typeof schema>> | undefined;

export function getDb() {
  if (!instance) {
    // Supabase consiglia il pooler (porta 6543, modalità transaction): lì le
    // prepared statement non sono supportate, quindi prepare: false
    const client = postgres(env.databaseUrl, { prepare: false, max: 10 });
    instance = drizzle(client, { schema });
  }
  return instance;
}
