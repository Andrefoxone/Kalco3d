// Pannello Anima: auto-rigging (scheletro + pesi) e animazioni pronte.
// Sul modello originale si sceglie cosa fare; sul modello animato si provano
// le animazioni nel visualizzatore e si scarica GLB o FBX.
import { useState } from "react";
import { toast } from "sonner";
import { Download, Loader2, PersonStanding, Play, Square } from "lucide-react";
import { trpc } from "@/providers/trpc";
import { handleNoCredits } from "@/lib/plansDialog";
import {
  BIPED_ANIMATIONS,
  MAX_ANIMATIONS,
  RIG_SPECS,
  animationLabel,
  rigCreditCost,
  type RigSpec,
} from "@contracts/rig";
import type { ModelItemDTO } from "@/types/model";

interface Props {
  active: ModelItemDTO | null;
  hasModel: boolean;
  /** clip del modello caricato nel visualizzatore */
  clips: string[];
  playing: string | null;
  onPlay: (name: string | null) => void;
  onQueued: () => void;
  onDownload: (item: ModelItemDTO, format: "glb" | "fbx") => void;
}

const DEFAULT_ANIMS = ["preset:idle", "preset:walk", "preset:run"];

export function AnimatePanel({ active, hasModel, clips, playing, onPlay, onQueued, onDownload }: Props) {
  const [anims, setAnims] = useState<string[]>(DEFAULT_ANIMS);
  const [spec, setSpec] = useState<RigSpec>("tripo");
  const [fbx, setFbx] = useState(true);
  const status = trpc.models.aiStatus.useQuery(undefined, { staleTime: 60_000 });
  const account = trpc.billing.account.useQuery(undefined, { staleTime: 30_000 });
  const rig = trpc.models.rig.useMutation();
  const admin = Boolean((account.data as { admin?: boolean } | undefined)?.admin);
  const cost = rigCreditCost(fbx);

  function toggle(id: string) {
    setAnims((cur) => {
      if (cur.includes(id)) return cur.filter((a) => a !== id);
      if (cur.length >= MAX_ANIMATIONS) {
        toast.info(`Al massimo ${MAX_ANIMATIONS} animazioni per modello`);
        return cur;
      }
      return [...cur, id];
    });
  }

  async function start() {
    if (!active) return;
    try {
      const item = await rig.mutateAsync({ id: active.id, animations: anims, spec, fbx });
      toast.success(`"${item.name}" in lavorazione: di solito servono 3–6 minuti`, { duration: 6000 });
      onQueued();
    } catch (err) {
      if (handleNoCredits(err)) return;
      toast.error(err instanceof Error ? err.message : "Animazione non avviata");
    }
  }

  if (!active || !hasModel) {
    return (
      <div className="flex flex-col gap-3 p-5 text-sm leading-relaxed text-[#525252]">
        <p>
          Apri un modello da Modelli: qui gli aggiungi lo scheletro e le animazioni (cammina, corre,
          salta…), pronte per Blender, Unreal, Unity e il web.
        </p>
        <p className="text-xs text-[#6f6f6f]">
          Funziona con personaggi e animali che hanno testa e arti ben separati. I risultati
          migliori arrivano da figure in piedi, con braccia staccate dal corpo.
        </p>
      </div>
    );
  }

  // modello già animato: prova e scarica
  if (active.mode === "rig" || clips.length > 0) {
    return (
      <div className="flex flex-col gap-6 p-5">
        <section>
          <SectionTitle>Animazioni</SectionTitle>
          {clips.length === 0 ? (
            <p className="text-xs leading-relaxed text-[#6f6f6f]">
              Questo modello ha lo scheletro ma nessuna animazione: puoi animarlo in Blender o nel
              motore di gioco.
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {clips.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => onPlay(playing === c ? null : c)}
                  aria-pressed={playing === c}
                  className={`flex h-10 items-center justify-between border px-3 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff670d] ${
                    playing === c ? "border-[#ff670d] bg-[#fff3ec] text-[#171717]" : "border-[#d4d4d4] text-[#525252] hover:border-[#9a9a9a]"
                  }`}
                >
                  <span>{animationLabel(c)}</span>
                  {playing === c ? <Square className="size-3.5" /> : <Play className="size-3.5" />}
                </button>
              ))}
            </div>
          )}
        </section>
        <section>
          <SectionTitle>Scarica</SectionTitle>
          <div className="grid grid-cols-2 gap-2">
            <DownloadButton onClick={() => onDownload(active, "glb")} label="GLB" hint="web, Blender, AR" />
            <DownloadButton
              onClick={() => onDownload(active, "fbx")}
              label="FBX"
              hint={active.fbxKey ? "Unreal, Unity, Maya" : "non richiesto"}
              disabled={!active.fbxKey}
            />
          </div>
        </section>
        {active.mode !== "rig" && (
          <p className="text-[11px] text-[#6f6f6f]">Il modello ha già delle animazioni proprie.</p>
        )}
      </div>
    );
  }

  const canRig = Boolean(status.data && (status.data as { canRig?: boolean }).canRig);

  return (
    <div className="flex flex-col gap-6 p-5">
      <p className="text-[11px] leading-relaxed text-[#6f6f6f]">
        Kalco3D riconosce da solo se «{active.name}» è un personaggio a due gambe o un animale, gli
        aggiunge lo scheletro e applica le animazioni. L'originale resta com'è: il modello animato
        appare in Modelli.
      </p>

      <section>
        <SectionTitle>Animazioni · fino a {MAX_ANIMATIONS}</SectionTitle>
        <div className="grid grid-cols-2 gap-1.5">
          {BIPED_ANIMATIONS.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => toggle(a.id)}
              aria-pressed={anims.includes(a.id)}
              className={`h-9 border px-2 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff670d] ${
                anims.includes(a.id) ? "border-[#ff670d] bg-[#fff3ec] text-[#171717]" : "border-[#d4d4d4] text-[#525252] hover:border-[#9a9a9a]"
              }`}
            >
              {a.label}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-[#6f6f6f]">
          Per gli animali e le creature il motore applica la camminata adatta alla loro forma.
          Nessuna scelta = solo scheletro.
        </p>
      </section>

      <section>
        <SectionTitle>Scheletro compatibile con</SectionTitle>
        <div className="grid grid-cols-4 border border-[#d4d4d4]">
          {RIG_SPECS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSpec(s.id)}
              aria-pressed={spec === s.id}
              className={`px-1 py-2.5 text-[10px] uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#ff670d] ${
                spec === s.id ? "bg-[#171717] text-[#fcfcfc]" : "text-[#6f6f6f] hover:bg-[#ededed]"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-[#525252]">{RIG_SPECS.find((s) => s.id === spec)!.hint}</p>
        <label className="mt-3 flex items-center gap-2 text-xs text-[#525252]">
          <input type="checkbox" checked={fbx} onChange={(e) => setFbx(e.target.checked)} className="accent-[#ff670d]" />
          Anche in FBX (per Unreal, Unity, Maya)
        </label>
      </section>

      <div>
        <button
          type="button"
          disabled={!canRig || rig.isPending}
          onClick={() => void start()}
          className="flex h-11 w-full items-center justify-center gap-2 bg-[#ff670d] text-[11px] font-medium uppercase tracking-[0.18em] text-white transition-all duration-150 hover:bg-[#e85c0b] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {rig.isPending ? <Loader2 className="size-4 animate-spin" /> : <PersonStanding className="size-4" />}
          {rig.isPending ? "Avvio…" : `Anima · ${admin ? "gratis" : `${cost} crediti`}`}
        </button>
        <p className="mt-1.5 text-[11px] leading-relaxed text-[#6f6f6f]">
          {canRig
            ? "Durata tipica 3–6 minuti. Se il modello non si può animare, i crediti tornano indietro."
            : "Animazione non disponibile: sul server manca la chiave Tripo."}
        </p>
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2.5 border-b border-[#e4e4e4] pb-1.5 text-[11px] uppercase tracking-[0.22em] text-[#171717]">
      {children}
    </div>
  );
}

function DownloadButton({ onClick, label, hint, disabled }: { onClick: () => void; label: string; hint: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex flex-col items-start gap-0.5 border border-[#d4d4d4] px-3 py-2.5 text-left transition-colors hover:border-[#ff670d] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff670d] disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span className="flex items-center gap-1.5 text-xs font-medium text-[#171717]">
        <Download className="size-3.5" /> {label}
      </span>
      <span className="text-[10px] text-[#6f6f6f]">{hint}</span>
    </button>
  );
}
