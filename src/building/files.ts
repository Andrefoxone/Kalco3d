// File in uscita di Building: STL binario dei pezzi e istruzioni di montaggio.
import type { Manifold } from "manifold-3d";
import type { Estimate, Machine, Piece } from "./engine";

/** STL binario di un pezzo, spostato all'origine (appoggiato sul piano). */
export function pieceStl(solid: Manifold): Uint8Array {
  const mesh = solid.getMesh();
  const np = mesh.numProp, vp = mesh.vertProperties, tv = mesh.triVerts;
  const b = solid.boundingBox();
  const T = tv.length / 3;
  const buf = new ArrayBuffer(84 + T * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, T, true);
  let o = 84;
  const P = (i: number, k: number) => vp[tv[i] * np + k] - b.min[k];
  for (let t = 0; t < T; t++) {
    const a = t * 3;
    const ux = P(a + 1, 0) - P(a, 0), uy = P(a + 1, 1) - P(a, 1), uz = P(a + 1, 2) - P(a, 2);
    const vx = P(a + 2, 0) - P(a, 0), vy = P(a + 2, 1) - P(a, 1), vz = P(a + 2, 2) - P(a, 2);
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    dv.setFloat32(o, nx, true); dv.setFloat32(o + 4, ny, true); dv.setFloat32(o + 8, nz, true);
    o += 12;
    for (let k = 0; k < 3; k++) {
      dv.setFloat32(o, P(a + k, 0), true); dv.setFloat32(o + 4, P(a + k, 1), true); dv.setFloat32(o + 8, P(a + k, 2), true);
      o += 12;
    }
    o += 2;
  }
  return new Uint8Array(buf);
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const m2 = (mm: number) => (mm / 1000).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const eur = (n: number) => n.toLocaleString("it-IT", { style: "currency", currency: "EUR" });

/** Pagina HTML stampabile: preventivo, pezzi numerati e ordine di montaggio. */
export function assemblyHtml(opts: {
  name: string;
  machine: Machine;
  sizeMm: [number, number, number];
  pieces: Piece[];
  estimate: Estimate;
  overhangLayers: number;
  pins: number;
}): string {
  const { name, machine: m, sizeMm, pieces, estimate: e } = opts;
  const rows = pieces
    .map(
      (p) => `<tr><td><b>${p.index}</b></td><td>${m2(p.min[0])} · ${m2(p.min[1])} · ${m2(p.min[2])}</td><td>${m2(p.size[0])} × ${m2(p.size[1])} × ${m2(p.size[2])}</td></tr>`,
    )
    .join("");
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>${esc(name)} — montaggio</title>
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:820px;margin:32px auto;padding:0 16px;color:#171717}h1{font-size:24px;margin:0}h2{font-size:16px;margin-top:28px;border-bottom:1px solid #ddd;padding-bottom:4px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:6px 8px;text-align:left}th{background:#f4f4f2}.k{color:#666}ol li{margin:4px 0}</style></head><body>
<p class="k">Kalco3D Building</p><h1>${esc(name)}</h1>
<p>Ingombro montato: <b>${m2(sizeMm[0])} × ${m2(sizeMm[1])} × ${m2(sizeMm[2])} m</b> · Macchina: ${esc(m.label)} (ugello ${m.nozzleMm} mm, strato ${m.layerMm} mm)</p>
<h2>Preventivo</h2><table>
<tr><th>Strati</th><td>${e.layers.toLocaleString("it-IT")}</td></tr>
<tr><th>Materiale</th><td>${esc(m.material.label)} · ${e.volumeM3.toLocaleString("it-IT", { maximumFractionDigits: 3 })} m³ · ${Math.round(e.kg).toLocaleString("it-IT")} kg</td></tr>
<tr><th>Tempo di stampa</th><td>${e.hours.toLocaleString("it-IT", { maximumFractionDigits: 1 })} ore</td></tr>
<tr><th>Costo materiale</th><td>${eur(e.materialCost)}</td></tr>
<tr><th>Costo macchina</th><td>${eur(e.machineCost)}</td></tr>
<tr><th>Totale stimato</th><td><b>${eur(e.total)}</b></td></tr></table>
<p class="k">Stima dai percorsi di stampa con i parametri indicati; non include trasporto, posa, armature e finiture.</p>
${opts.overhangLayers > 0 ? `<p><b>Attenzione:</b> ${opts.overhangLayers} strati hanno sbalzi oltre ${m.maxOverhangDeg}°: servono supporti, casseri o un cambio di orientamento.</p>` : ""}
${
    pieces.length === 1
      ? `<h2>Stampa</h2><p>Il modello entra nella macchina: si stampa in un unico pezzo, partendo dall'angolo indicato nel G-code (X e Y da zero, Z dal piano).</p></body></html>`
      : `<h2>Pezzi (${pieces.length})</h2>
<p class="k">Posizione = angolo del pezzo nel modello montato (X · Y · Z, metri, dall'angolo in basso a sinistra davanti). Ogni file del pezzo parte da zero.</p>
<table><tr><th>N.</th><th>Posizione (m)</th><th>Dimensioni (m)</th></tr>${rows}</table>
<h2>Montaggio</h2><ol>
<li>Stampa i pezzi nell'ordine dei numeri: si monta dal basso verso l'alto.</li>
${opts.pins > 0 ? `<li>Inserisci i ${opts.pins} perni nei fori delle facce di taglio prima di accostare i pezzi.</li>` : ""}
<li>Posa ogni pezzo nella sua posizione e controlla in bolla prima di procedere allo strato di pezzi successivo.</li>
<li>${m.kind === "cemento" ? "Unisci i blocchi con malta di allettamento compatibile e, dove serve, armature di collegamento." : "Incolla le facce di taglio (colla strutturale adatta al materiale) e stucca le giunture."}</li>
</ol></body></html>`
  }`;
}
