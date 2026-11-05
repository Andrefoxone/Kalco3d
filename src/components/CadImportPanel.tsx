// Pannello "Importa file CAD": trascini un DWG/DXF/STEP/IGES/STL/OBJ/PLY,
// il browser lo converte in geometria 3D (WASM, tutto in locale) e il modello
// entra nel flusso dello studio: materiali, varianti, viste, export e galleria.
import { useCallback, useRef, useState } from "react";
import { FileUp, Loader2, TriangleAlert } from "lucide-react";
import { CAD_ACCEPT, cadFormatFromName } from "@/lib/cadImport";

interface Props {
  busy: boolean;
  onFile: (file: File) => Promise<void>;
}

const FORMATS = [
  { id: "DWG", note: "disegni AutoCAD (conversione automatica)" },
  { id: "DXF", note: "disegni 2D e facce 3D" },
  { id: "STEP / IGES", note: "solidi da SolidWorks, Fusion 360, Rhino…" },
  { id: "STL / OBJ / PLY", note: "mesh e scansioni" },
];

export function CadImportPanel({ busy, onFile }: Props) {
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handle = useCallback(
    async (file: File | undefined) => {
      if (!file || busy) return;
      if (!cadFormatFromName(file.name)) {
        setError("Formato non supportato. Accetto: DWG, DXF, STEP, IGES, STL, OBJ, PLY.");
        return;
      }
      setError(null);
      try {
        await onFile(file);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Import non riuscito");
      }
    },
    [busy, onFile],
  );

  return (
    <div className="flex flex-col gap-4 p-5">
      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void handle(e.dataTransfer.files?.[0]);
        }}
        className={`flex flex-col items-center justify-center gap-2 border-2 border-dashed px-4 py-8 text-center transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff670d] disabled:cursor-wait ${
          dragOver ? "border-[#ff670d] bg-[#fff3ec]" : "border-[#d4d4d4] hover:border-[#9a9a9a]"
        }`}
      >
        {busy ? (
          <Loader2 className="size-6 animate-spin text-[#ff670d]" />
        ) : (
          <FileUp className="size-6 text-[#525252]" />
        )}
        <span className="text-xs uppercase tracking-[0.18em] text-[#171717]">
          {busy ? "Conversione in corso…" : "Trascina un file CAD o tocca qui"}
        </span>
        <span className="text-[11px] text-[#6f6f6f]">fino a 64 MB, tutto elaborato in locale</span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={CAD_ACCEPT}
        className="hidden"
        onChange={(e) => {
          void handle(e.target.files?.[0]);
          e.target.value = "";
        }}
      />

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-snug text-amber-900"
        >
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        {FORMATS.map((f) => (
          <div key={f.id} className="flex items-baseline justify-between gap-3 text-[11px]">
            <span className="shrink-0 uppercase tracking-widest text-[#171717]">{f.id}</span>
            <span className="text-right text-[#6f6f6f]">{f.note}</span>
          </div>
        ))}
      </div>

      <p className="text-[11px] leading-relaxed text-[#6f6f6f]">
        I disegni DWG/DXF mostrano linee e facce con i colori dei layer; testi, quote e campiture
        non vengono importati. I DWG con solidi 3D ACIS non sono convertibili: per quelli esporta
        STEP o STL dal tuo CAD.
      </p>
    </div>
  );
}
