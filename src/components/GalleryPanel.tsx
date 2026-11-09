import { Download, Box, Loader2, TriangleAlert } from "lucide-react";
import { MODE_LABELS, type ModelMode } from "@contracts/types";
import type { ModelItemDTO } from "@/types/model";

const QUALITY_LABEL: Record<string, string> = { bozza: "Bozza", standard: "Standard", pro: "Pro" };
const TARGET_LABEL: Record<string, string> = {
  ecommerce: "E-commerce",
  stampa: "Stampa 3D",
  render: "Render",
  gioco: "Gioco",
};

function modeLabel(item: ModelItemDTO): string {
  if (item.mode === "cad") return "CAD";
  if (item.mode === "rig") return "Animato";
  if (item.mode === "ai") {
    const parts = [item.quality && QUALITY_LABEL[item.quality], item.target && TARGET_LABEL[item.target]].filter(Boolean);
    return parts.length ? `AI ${parts.join(" · ")}` : "AI realistica";
  }
  return MODE_LABELS[item.mode as ModelMode] ?? item.mode;
}

interface Props {
  items: ModelItemDTO[];
  loading: boolean;
  activeId: number | null;
  onSelect: (item: ModelItemDTO) => void;
  onDownload: (item: ModelItemDTO) => void;
}

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function fmtDate(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d);
  return date.toLocaleDateString("it-IT", { day: "2-digit", month: "short" });
}

export function GalleryPanel({ items, loading, activeId, onSelect, onDownload }: Props) {
  if (loading) {
    return (
      <div className="flex flex-col gap-3 p-5" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-20 animate-pulse bg-[#ededed]" />
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 px-5 py-14 text-center">
        <Box className="size-7 text-[#c4c4c4]" />
        <p className="text-sm text-[#6f6f6f]">
          Nessun modello ancora.
          <br />
          Genera il tuo primo 3D dalla scheda «Crea».
        </p>
      </div>
    );
  }

  return (
    <ul className="flex flex-col divide-y divide-[#e8e8e8]">
      {items.map((item) => {
        const active = item.id === activeId;
        const processing = item.status === "processing";
        const failed = item.status === "failed";
        return (
          <li key={item.id}>
            <div
              role="button"
              tabIndex={processing ? -1 : 0}
              aria-disabled={processing || failed}
              onClick={() => {
                if (!processing) onSelect(item);
              }}
              onKeyDown={(e) => {
                if (processing) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(item);
                }
              }}
              className={`group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#ff670d] ${
                processing || failed
                  ? "cursor-default"
                  : "cursor-pointer"
              } ${active ? "bg-[#fff3ec]" : processing || failed ? "" : "hover:bg-[#f6f6f6]"}`}
            >
              <div className="relative size-14 shrink-0 overflow-hidden bg-[#171717]">
                {item.previewUrl || item.photoUrl ? (
                  <img
                    src={(processing ? item.photoUrl : item.previewUrl) ?? item.photoUrl ?? undefined}
                    alt=""
                    className={`size-full object-cover ${processing ? "opacity-40" : ""}`}
                    loading="lazy"
                  />
                ) : (
                  <Box className="absolute inset-0 m-auto size-5 text-[#6f6f6f]" />
                )}
                {processing && (
                  <Loader2 className="absolute inset-0 m-auto size-5 animate-spin text-[#ff670d]" />
                )}
                {failed && (
                  <TriangleAlert className="absolute inset-0 m-auto size-5 text-red-400" />
                )}
                {active && (
                  <span className="absolute right-1 top-1 size-1.5 animate-pulse rounded-full bg-[#ff670d]" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-[#171717]">{item.name}</div>
                {processing ? (
                  <div className="mt-1">
                    <div className="flex items-baseline justify-between gap-2 text-[11px] text-[#ff670d]">
                      <span className="truncate">{item.stage ?? "Generazione AI in corso…"}</span>
                      <span className="shrink-0 tabular-nums">{item.progress}%</span>
                    </div>
                    <div
                      className="mt-1 h-1 w-full bg-[#ffe3d1]"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={item.progress}
                      aria-label={`Avanzamento di ${item.name}`}
                    >
                      <div className="h-full bg-[#ff670d] transition-[width] duration-700" style={{ width: `${Math.max(3, item.progress)}%` }} />
                    </div>
                  </div>
                ) : failed ? (
                  <div
                    className="mt-0.5 truncate text-[11px] text-red-600"
                    title={item.error ?? undefined}
                  >
                    Fallita: {item.error ?? "errore sconosciuto"}
                  </div>
                ) : (
                  <div className="mt-0.5 flex items-center gap-2 text-[11px] uppercase tracking-widest text-[#525252]">
                    <span className={`truncate ${active ? "text-[#ff670d]" : ""}`} title={item.providerLabel ?? undefined}>
                      {modeLabel(item)}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{(item.triangles / 1000).toFixed(1)}k tri</span>
                    <span aria-hidden="true">·</span>
                    <span>{fmtSize(item.sizeBytes)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{fmtDate(item.createdAt)}</span>
                  </div>
                )}
              </div>
              {!processing && !failed && (
                <button
                  type="button"
                  aria-label={`Scarica ${item.name} in formato GLB`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDownload(item);
                  }}
                  className="flex size-9 shrink-0 items-center justify-center text-[#6f6f6f] transition-all duration-150 hover:bg-[#171717] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff670d] active:scale-95"
                >
                  <Download className="size-4" />
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
