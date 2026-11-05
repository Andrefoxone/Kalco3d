// Tipi condivisi per gli strumenti di editing del viewport.
import type { SculptMode, TransformMode } from "@/three/scene";

export type Tool = "orbit" | TransformMode | SculptMode;

export const TOOL_LABELS: Record<Tool, string> = {
  orbit: "Vista libera",
  translate: "Sposta",
  rotate: "Ruota",
  scale: "Scala",
  raise: "Scultura: alza",
  lower: "Scultura: abbassa",
  inflate: "Scultura: gonfia",
  smooth: "Scultura: leviga",
  pinch: "Scultura: pizzica",
  flatten: "Scultura: appiattisci",
};
