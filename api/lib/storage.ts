// Storage su Supabase (bucket privato). Solo il server lo usa, con la chiave
// segreta; il browser riceve URL firmati a scadenza.
// I file di ogni utente stanno sotto la sua cartella: <userId>/modelli/…
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env";

const SIGNED_URL_SECONDS = 60 * 60;

let client: SupabaseClient | undefined;

export function supabaseAdmin(): SupabaseClient {
  if (!client) {
    if (!env.supabaseUrl || !env.supabaseSecretKey) {
      throw new Error("Supabase non configurato: servono SUPABASE_URL e SUPABASE_SECRET_KEY");
    }
    client = createClient(env.supabaseUrl, env.supabaseSecretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

function bucket() {
  return supabaseAdmin().storage.from(env.storageBucket);
}

/** Chiave univoca: stesso percorso e nome, con un suffisso casuale prima dell'estensione. */
export function uniqueKey(fileName: string): string {
  const clean = fileName
    .normalize("NFKD")
    .replace(/[^\w./-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+/, "");
  const dot = clean.lastIndexOf(".");
  const slash = clean.lastIndexOf("/");
  const suffix = crypto.randomUUID().slice(0, 8);
  if (dot > slash + 1) return `${clean.slice(0, dot)}-${suffix}${clean.slice(dot)}`;
  return `${clean}-${suffix}`;
}

export const storage = {
  async uploadFile(input: { fileContent: Uint8Array; fileName: string; contentType: string }): Promise<{ key: string }> {
    const key = uniqueKey(input.fileName);
    const { error } = await bucket().upload(key, input.fileContent, {
      contentType: input.contentType,
      upsert: false,
    });
    if (error) throw new Error(`Upload non riuscito: ${error.message}`);
    return { key };
  },

  async getPresignedUrls(input: { keys: string[] }): Promise<{ urls: { key: string; url: string }[] }> {
    const keys = input.keys.filter(Boolean);
    if (!keys.length) return { urls: [] };
    const { data, error } = await bucket().createSignedUrls(keys, SIGNED_URL_SECONDS);
    if (error) throw new Error(`URL firmati non disponibili: ${error.message}`);
    return {
      urls: (data ?? []).flatMap((d) => (d.signedUrl && d.path ? [{ key: d.path, url: d.signedUrl }] : [])),
    };
  },

  async getPresignedUrl(input: { key: string; download?: boolean | string }): Promise<{ url: string }> {
    const { data, error } = await bucket().createSignedUrl(input.key, SIGNED_URL_SECONDS, {
      download: input.download ?? false,
    });
    if (error || !data) throw new Error(`URL firmato non disponibile: ${error?.message ?? "file mancante"}`);
    return { url: data.signedUrl };
  },

  async readFile(input: { fileKey: string }): Promise<Uint8Array> {
    const { data, error } = await bucket().download(input.fileKey);
    if (error || !data) throw new Error(`File non trovato: ${input.fileKey}`);
    return new Uint8Array(await data.arrayBuffer());
  },

  async deleteFiles(keys: string[]): Promise<void> {
    const list = keys.filter(Boolean);
    if (list.length) await bucket().remove(list);
  },
};
