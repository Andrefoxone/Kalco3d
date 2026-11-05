// Caricamento pigro di Manifold (WASM, Apache-2.0): booleane e tagli garantiti
// "a tenuta" per la stampa. Nel browser il .wasm è servito da /wasm/.
import type { ManifoldToplevel } from "manifold-3d";

let modulePromise: Promise<ManifoldToplevel> | null = null;

export function getManifold(): Promise<ManifoldToplevel> {
  if (!modulePromise) {
    modulePromise = import("manifold-3d").then(async (m) => {
      const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";
      const wasm = await m.default(isBrowser ? { locateFile: () => "/wasm/manifold.wasm" } : undefined);
      wasm.setup();
      return wasm;
    });
    modulePromise.catch(() => {
      modulePromise = null; // permette un nuovo tentativo
    });
  }
  return modulePromise;
}
