import { describe, expect, it } from "vitest";
import { Window } from "happy-dom";
// SVGLoader usa DOMParser, che in Node non c'è: lo si simula con happy-dom
// (che legge l'SVG come HTML), il resto del test resta in Node
const win = new Window();
class SvgParser {
  parseFromString(text: string) {
    const doc = new win.DOMParser().parseFromString(text, "text/html");
    return { documentElement: doc.body.firstElementChild, querySelectorAll: (q: string) => doc.querySelectorAll(q) };
  }
}
(globalThis as { DOMParser?: unknown }).DOMParser = SvgParser;
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as THREE from "three";
import { getManifold } from "./manifold";
import { decorSection, loadFont, textRings } from "./decor";
import { preparePrint } from "./pipeline";
import { analyzePrintability } from "../three/printCheck";

const require = createRequire(import.meta.url);
const woff = (p: string) => {
  const b = readFileSync(require.resolve(p));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 10 H90 V90 H10 Z M30 30 V70 H70 V30 Z" fill="#000"/><circle cx="50" cy="50" r="8" fill="red"/><path d="M0 0 L100 100" stroke="#000" fill="none"/></svg>`;

describe("testo e logo", () => {
  it("il testo diventa contorni chiusi con i buchi delle lettere", async () => {
    const font = await loadFont("moderno", woff("@fontsource/montserrat/files/montserrat-latin-800-normal.woff"));
    const rings = textRings(font, "Bobò", 10);
    expect(rings.length).toBeGreaterThanOrEqual(6); // B ha 3 contorni, o 2, b 2, ò 3
    const w = await getManifold();
    const cs = decorSection(w, font, { text: "Bobò", font: "moderno", mode: "rilievo" })!;
    const b = cs.bounds();
    expect(b.max[0] - b.min[0]).toBeGreaterThan(20); // ~ 4 lettere da 10 mm
    expect(cs.area()).toBeGreaterThan(30);
  });

  it("il logo SVG: forme piene sì, linee senza riempimento no", async () => {
    const w = await getManifold();
    const cs = decorSection(w, null, { text: "", font: "moderno", logoSvg: LOGO, mode: "rilievo" })!;
    expect(cs).not.toBeNull();
    // cornice (6400-1600) + cerchio ≈ 5000 unità², alto 10 mm dopo la scala
    const b = cs.bounds();
    expect(b.max[1] - b.min[1]).toBeCloseTo(10, 0);
  });

  it("logo in rilievo e colore a contrasto sulla base, solido chiuso", async () => {
    const geom = new THREE.SphereGeometry(1, 32, 24).toNonIndexed();
    const pos = geom.getAttribute("position");
    const soup = new Float32Array(pos.array as Float32Array);
    void pos;
    const out = await preparePrint(
      { soup },
      {
        longestMm: 60,
        colors: 1,
        base: { shape: "quadrata", heightMm: 5 },
        plate: { x: 256, y: 256, z: 256 },
        name: "Logo",
        decor: { text: "", font: "moderno", logoSvg: LOGO, mode: "rilievo", color: "contrasto" },
      },
    );
    expect(out.report.warnings.join(" ")).not.toMatch(/spazio|forme piene/);
    expect(out.palette).toHaveLength(2); // modello+base (monocolore), logo a contrasto
    const labels = new Set(out.placed[0].mesh.label);
    expect(labels.has(1)).toBe(true);
    const g = new THREE.BufferGeometry();
    const m = out.placed[0].mesh;
    g.setAttribute("position", new THREE.BufferAttribute(m.vert, 3));
    g.setIndex(new THREE.BufferAttribute(m.tri, 1));
    expect(analyzePrintability(new THREE.Mesh(g)).watertight).toBe(true);
  });

  it("incisione: il volume della base diminuisce", async () => {
    const geom = new THREE.SphereGeometry(1, 32, 24).toNonIndexed();
    const soup = new Float32Array(geom.getAttribute("position").array as Float32Array);
    const base = { shape: "tonda" as const, heightMm: 5 };
    const opts = { longestMm: 60, colors: 1, base, plate: { x: 256, y: 256, z: 256 }, name: "x" };
    const plain = await preparePrint({ soup }, opts);
    const cut = await preparePrint({ soup }, { ...opts, decor: { text: "", font: "moderno", logoSvg: LOGO, mode: "incisione" } });
    expect(cut.report.warnings.join(" ")).not.toMatch(/spazio/);
    // la base tonda si allarga per far posto al logo, ma l'incisione toglie materiale: volumi diversi
    expect(cut.report.volumeCm3).not.toBeCloseTo(plain.report.volumeCm3, 3);
  });
});
