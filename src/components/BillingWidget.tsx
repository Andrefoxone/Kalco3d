// Saldo crediti nell'intestazione + finestra con piani e ricarica (Stripe).
import { useEffect, useState } from "react";
import { Check, Loader2, Zap } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { trpc } from "@/providers/trpc";
import { onOpenPlans } from "@/lib/plansDialog";

export function BillingWidget() {
  const account = trpc.billing.account.useQuery(undefined, { staleTime: 15_000 });
  const plans = trpc.billing.plans.useQuery(undefined, { staleTime: 300_000 });
  const checkout = trpc.billing.checkout.useMutation();
  const portal = trpc.billing.portal.useMutation();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [going, setGoing] = useState<string | null>(null);

  useEffect(() => onOpenPlans((r) => { setReason(r); setOpen(true); }), []);

  // ritorno da Stripe: i crediti li accredita il webhook, pochi secondi dopo
  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get("pagamento");
    if (!p) return;
    window.history.replaceState(null, "", window.location.pathname);
    if (p === "ok") {
      toast.success("Pagamento ricevuto: i crediti arrivano in pochi secondi");
      let n = 0;
      const t = window.setInterval(() => {
        void account.refetch();
        if (++n >= 6) window.clearInterval(t);
      }, 2500);
      return () => window.clearInterval(t);
    }
    if (p === "annullato") toast("Pagamento annullato: nessun addebito");
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function buy(item: "maker" | "pro" | "studio" | "pack") {
    setGoing(item);
    try {
      const { url } = await checkout.mutateAsync({ item });
      window.location.href = url;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Pagamento non disponibile");
      setGoing(null);
    }
  }

  async function manage() {
    try {
      const { url } = await portal.mutateAsync();
      window.location.href = url;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Gestione non disponibile");
    }
  }

  const acc = account.data;
  const subscribed = acc?.planStatus === "active";
  const enabled = plans.data?.enabled;

  return (
    <>
      <button
        type="button"
        onClick={() => { setReason(null); setOpen(true); }}
        className="flex items-center gap-1.5 border border-[#d4d4d4] px-2 py-1 normal-case tracking-normal text-[#171717] transition-colors hover:bg-[#171717] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff670d]"
        aria-label="Crediti e piani"
      >
        <Zap className="size-3.5 text-[#ff670d]" aria-hidden="true" />
        <span className="font-medium tabular-nums">{acc ? (acc.admin ? "∞" : acc.balance) : "…"}</span>
        <span className="hidden sm:inline">{acc?.admin ? "admin" : "crediti"}</span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl rounded-none font-mono">
          <DialogHeader>
            <DialogTitle className="font-display text-3xl font-normal tracking-tight">Crediti e piani</DialogTitle>
            <DialogDescription className="text-sm text-[#525252]">
              {acc?.admin && !reason ? (
                <>Account amministratore: le generazioni non scalano crediti (il costo dei motori AI resta a tuo carico).</>
              ) : reason ?? (
                <>
                  Hai <strong className="text-[#171717]">{acc?.balance ?? 0} crediti</strong>
                  {acc && acc.planBalance > 0 && ` (${acc.planBalance} del piano, ${acc.extraBalance} extra)`}. Un modello
                  standard costa 8 crediti, una bozza 5, il Pro 15. La preparazione per la stampa è gratis.
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          {!enabled && (
            <p className="border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              I pagamenti non sono ancora attivi su questo server.
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-3">
            {plans.data?.plans.map((p) => {
              const current = subscribed && acc?.plan === p.id;
              return (
                <div key={p.id} className={`flex flex-col gap-3 border p-4 ${p.id === "pro" ? "border-[#ff670d]" : "border-[#d4d4d4]"}`}>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{p.name}</span>
                    {p.id === "pro" && <span className="bg-[#ff670d] px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-[#171717]">Consigliato</span>}
                  </div>
                  <div className="flex items-baseline gap-1">
                    <span className="font-display text-4xl">{p.priceEur} €</span>
                    <span className="text-xs text-[#525252]">/ mese</span>
                  </div>
                  <div className="text-xs text-[#171717]">{p.credits} crediti al mese</div>
                  <ul className="flex flex-col gap-1.5 text-xs text-[#3f3f3c]">
                    {p.perks.map((k) => (
                      <li key={k} className="flex gap-1.5"><Check className="mt-px size-3.5 shrink-0 text-[#ff670d]" aria-hidden="true" />{k}</li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    disabled={!enabled || !p.available || current || Boolean(going) || subscribed}
                    onClick={() => void buy(p.id)}
                    className="mt-auto flex h-10 items-center justify-center gap-2 bg-[#171717] text-xs uppercase tracking-[0.16em] text-white transition-colors hover:bg-[#ff670d] hover:text-[#171717] disabled:bg-[#ececea] disabled:text-[#525252]"
                  >
                    {going === p.id && <Loader2 className="size-3.5 animate-spin" />}
                    {current ? "Il tuo piano" : "Scegli"}
                  </button>
                </div>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#e4e4e4] pt-4">
            <div className="text-xs text-[#3f3f3c]">
              <strong className="text-[#171717]">Ricarica:</strong> {plans.data?.pack.credits ?? 100} crediti a {plans.data?.pack.priceEur ?? 15} € · non scadono
            </div>
            <div className="flex gap-2">
              {subscribed && (
                <button type="button" onClick={() => void manage()} className="h-10 border border-[#171717] px-4 text-xs uppercase tracking-[0.16em] hover:bg-[#171717] hover:text-white">
                  Gestisci abbonamento
                </button>
              )}
              <button
                type="button"
                disabled={!enabled || !plans.data?.pack.available || Boolean(going)}
                onClick={() => void buy("pack")}
                className="flex h-10 items-center gap-2 bg-[#ff670d] px-4 text-xs font-medium uppercase tracking-[0.16em] text-[#171717] hover:bg-[#e85c0b] disabled:bg-[#ececea] disabled:text-[#525252]"
              >
                {going === "pack" && <Loader2 className="size-3.5 animate-spin" />}
                Compra la ricarica
              </button>
            </div>
          </div>
          {subscribed && (
            <p className="text-[11px] text-[#525252]">
              Per cambiare piano o disdire usa "Gestisci abbonamento". I crediti del piano si rinnovano ogni mese; quelli extra restano.
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
