/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY: string;
  /** "1" per mostrare "Accedi con Google" (va attivato anche in Supabase) */
  readonly VITE_AUTH_GOOGLE?: string;
}
