// Client Supabase del browser: solo login. Database e file passano dal
// nostro server (tRPC), che verifica il token di ogni richiesta.
import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

export const supabaseConfigured = Boolean(url && key);

export const supabase = createClient(url || "http://localhost", key || "missing", {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

/** Token della sessione corrente (rinnovato da supabase-js quando scade). */
export async function accessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
