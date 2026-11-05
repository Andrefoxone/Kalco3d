import {
  Hand,
  Move,
  Rotate3d,
  Scaling,
  ArrowUpFromLine,
  ArrowDownToLine,
  Waves,
  Shrink,
  Layers,
  Expand,
  FlipHorizontal2,
} from "lucide-react";
import type { Tool } from "@/types/tools";
import { TOOL_LABELS } from "@/types/tools";
import { Slider } from "@/components/ui/slider";

interface Props {
  tool: Tool;
  onTool: (tool: Tool) => void;
  hasModel: boolean;
  brushRadius: number;
  brushStrength: number;
  onBrush: (radius: number, strength: number) => void;
  symmetry: boolean;
  onSymmetry: (on: boolean) => void;
}

const GROUPS: { tools: { id: Tool; icon: React.ReactNode }[] }[] = [
  {
    tools: [
      { id: "orbit", icon: <Hand className="size-4" /> },
      { id: "translate", icon: <Move className="size-4" /> },
      { id: "rotate", icon: <Rotate3d className="size-4" /> },
      { id: "scale", icon: <Scaling className="size-4" /> },
    ],
  },
  {
    tools: [
      { id: "raise", icon: <ArrowUpFromLine className="size-4" /> },
      { id: "lower", icon: <ArrowDownToLine className="size-4" /> },
      { id: "inflate", icon: <Expand className="size-4" /> },
      { id: "smooth", icon: <Waves className="size-4" /> },
      { id: "pinch", icon: <Shrink className="size-4" /> },
      { id: "flatten", icon: <Layers className="size-4" /> },
    ],
  },
];

const SCULPT_TOOLS: Tool[] = ["raise", "lower", "inflate", "smooth", "pinch", "flatten"];

export function ViewportToolbar({
  tool,
  onTool,
  hasModel,
  brushRadius,
  brushStrength,
  onBrush,
  symmetry,
  onSymmetry,
}: Props) {
  const sculptActive = SCULPT_TOOLS.includes(tool);
  return (
    <>
      <div className="absolute left-3 top-1/2 flex -translate-y-1/2 flex-col gap-1 rounded-lg border border-[#4a4a5a54] bg-[#1e1e24f5] p-1.5 backdrop-blur-[8px]">
        {GROUPS.map((group, gi) => (
          <div key={gi} className="flex flex-col gap-1 border-b border-white/10 pb-1 last:border-0 last:pb-0">
            {group.tools.map(({ id, icon }) => (
              <button
                key={id}
                type="button"
                aria-label={TOOL_LABELS[id]}
                aria-pressed={tool === id}
                title={TOOL_LABELS[id]}
                disabled={!hasModel}
                onClick={() => onTool(id)}
                className={`flex size-10 items-center justify-center rounded-md transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff670d] active:scale-95 disabled:cursor-not-allowed disabled:opacity-35 lg:size-9 ${
                  tool === id
                    ? "bg-[#ff670d] text-white"
                    : "text-[#9a9aab] hover:bg-white/10 hover:text-[#e0e0e0]"
                }`}
              >
                {icon}
              </button>
            ))}
          </div>
        ))}
      </div>

      {/* impostazioni pennello scultura */}
      {sculptActive && (
        <div className="absolute left-[4.75rem] top-1/2 w-48 -translate-y-1/2 rounded-lg border border-[#4a4a5a54] bg-[#1e1e24f5] p-3.5 backdrop-blur-[8px]">
          <div className="mb-2.5 text-[11px] font-medium uppercase tracking-[0.2em] text-[#ff670d]">
            {TOOL_LABELS[tool]}
          </div>
          <BrushSlider
            label="Raggio"
            value={brushRadius}
            min={0.1}
            max={1}
            step={0.05}
            display={brushRadius.toFixed(2)}
            onChange={(v) => onBrush(v, brushStrength)}
          />
          <BrushSlider
            label="Intensità"
            value={brushStrength}
            min={0.1}
            max={1}
            step={0.05}
            display={`${Math.round(brushStrength * 100)}%`}
            onChange={(v) => onBrush(brushRadius, v)}
          />
          <button
            type="button"
            aria-pressed={symmetry}
            onClick={() => onSymmetry(!symmetry)}
            className={`mt-1 flex w-full items-center justify-center gap-2 rounded-md border px-2 py-1.5 text-[11px] uppercase tracking-[0.18em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#ff670d] ${
              symmetry
                ? "border-[#ff670d] bg-[#ff670d] text-white"
                : "border-white/15 text-[#9a9aab] hover:text-[#e0e0e0]"
            }`}
          >
            <FlipHorizontal2 className="size-3.5" />
            Simmetria X
          </button>
          <p className="mt-2.5 text-[11px] leading-relaxed text-[#9a9aab]">
            {tool === "flatten"
              ? "Porta la superficie sul piano del primo tocco del tratto."
              : tool === "pinch"
                ? "Stringe la superficie verso il centro del pennello."
                : tool === "inflate"
                  ? "Gonfia ogni punto lungo la propria normale."
                  : tool === "smooth"
                    ? "Leviga mediando i punti vicini, senza appiattire la forma."
                    : "Trascina sul modello per deformarlo."}
          </p>
        </div>
      )}
    </>
  );
}

function BrushSlider({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="mb-2.5 last:mb-0">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[11px] uppercase tracking-[0.18em] text-[#9a9aab]">{label}</span>
        <span className="text-[11px] text-[#e0e0e0]">{display}</span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(v) => onChange(v[0])}
        aria-label={label}
      />
    </div>
  );
}
