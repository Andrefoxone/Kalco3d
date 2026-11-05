// Accesso con Supabase Auth: link via email (niente password da ricordare),
// opzionalmente Google. Finché non c'è una sessione si vede solo questa schermata.
import { useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { Loader2, Mail } from "lucide-react";
import { supabase, supabaseConfigured } from "@/lib/supabase";
import { queryClient } from "@/lib/queryClient";
import { AuthContext } from "@/lib/auth";

export function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      // cambio utente: niente dati dell'account precedente in cache
      if (!s) queryClient.clear();
    });
    return () => data.subscription.unsubscribe();
  }, []);

  if (!supabaseConfigured) {
    return (
      <Shell>
        <p className="text-sm leading-relaxed text-[#525252]">
          Supabase non è configurato: imposta <code>VITE_SUPABASE_URL</code> e{" "}
          <code>VITE_SUPABASE_PUBLISHABLE_KEY</code> nel file .env.
        </p>
      </Shell>
    );
  }
  if (session === undefined) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-[#fcfcfc]">
        <Loader2 className="size-5 animate-spin text-[#6f6f6f]" aria-label="Caricamento" />
      </div>
    );
  }
  if (!session) return <SignIn />;

  return (
    <AuthContext.Provider
      value={{
        email: session.user.email ?? null,
        signOut: async () => {
          await supabase.auth.signOut();
        },
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

function SignIn() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendLink(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin },
    });
    setBusy(false);
    if (error) {
      setError(
        /rate|limit/i.test(error.message)
          ? "Troppe richieste: aspetta qualche minuto e riprova"
          : "Non sono riuscito a inviare l'email. Controlla l'indirizzo e riprova",
      );
      return;
    }
    setSent(true);
  }

  async function google() {
    await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: window.location.origin } });
  }

  return (
    <Shell>
      {sent ? (
        <div className="flex flex-col gap-3">
          <Mail className="size-6 text-[#ff670d]" aria-hidden="true" />
          <p className="text-sm leading-relaxed text-[#171717]">
            Ti ho mandato un link a <strong>{email}</strong>. Aprilo da questo dispositivo per entrare.
          </p>
          <button
            type="button"
            onClick={() => setSent(false)}
            className="self-start text-[11px] uppercase tracking-[0.18em] text-[#525252] hover:text-[#171717]"
          >
            Usa un altro indirizzo
          </button>
        </div>
      ) : (
        <form onSubmit={sendLink} className="flex flex-col gap-3">
          <label htmlFor="email" className="text-[11px] uppercase tracking-[0.18em] text-[#525252]">
            La tua email
          </label>
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="nome@esempio.it"
            className="h-11 border border-[#d4d4d4] bg-white px-3 text-sm focus-visible:border-[#ff670d] focus-visible:outline-none"
          />
          <button
            type="submit"
            disabled={busy || !email.trim()}
            className="flex h-11 items-center justify-center gap-2 bg-[#ff670d] text-sm font-medium uppercase tracking-[0.18em] text-white transition-transform hover:bg-[#e85c0b] active:scale-[0.98] disabled:opacity-50"
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            Ricevi il link di accesso
          </button>
          {error && <p className="text-xs text-red-700">{error}</p>}
          {import.meta.env.VITE_AUTH_GOOGLE === "1" && (
            <button
              type="button"
              onClick={() => void google()}
              className="h-11 border border-[#171717] text-[11px] font-medium uppercase tracking-[0.18em] text-[#171717] hover:bg-[#171717] hover:text-white"
            >
              Accedi con Google
            </button>
          )}
          <p className="text-[11px] leading-relaxed text-[#6f6f6f]">
            Niente password: ti arriva un link, lo apri e sei dentro. Se è la prima volta, l'account si crea da solo.
          </p>
        </form>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-[#fcfcfc] px-4 font-mono text-[#171717]">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-baseline gap-2.5">
          <span className="inline-block size-2.5 rounded-full bg-[#ff670d]" aria-hidden="true" />
          <span className="font-display text-3xl leading-none tracking-tight">Kalco3D</span>
          <span className="text-[11px] uppercase tracking-[0.22em] text-[#6f6f6f]">photo to 3D</span>
        </div>
        <h1 className="mb-1 font-display text-xl tracking-tight">Accedi</h1>
        <p className="mb-6 text-xs leading-relaxed text-[#525252]">
          Dalla foto al modello 3D: per il web, l'AR, il render e la stampa.
        </p>
        {children}
      </div>
    </div>
  );
}
