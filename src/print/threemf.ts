// Scrittura 3MF per gli slicer, con colori per triangolo.
// I colori vengono scritti in tre modi insieme, così ogni slicer trova il suo:
//  - standard 3MF: <basematerials> + pid/p1 sui triangoli (colore di anteprima);
//  - paint_color: pittura multi-filamento di Bambu Studio e OrcaSlicer;
//  - slic3rpe:mmu_segmentation: lo stesso per PrusaSlicer.
// Il valore della pittura codifica il numero di filamento (1 = "4", 2 = "8",
// 3 = "0C", 4 = "1C", …), formato del TriangleSelector di PrusaSlicer.
import { strToU8, zipSync } from "three/examples/jsm/libs/fflate.module.js";
import { plateOrigin, type Placed, type Plate } from "./solid";

/** Codice pittura per un triangolo intero assegnato al filamento n (1-based). */
export function paintCode(extruder: number): string {
  if (extruder < 1 || extruder > 18) throw new Error("filamento fuori intervallo (1–18)");
  if (extruder < 3) return (extruder << 2).toString(16).toUpperCase();
  return `${(extruder - 3).toString(16).toUpperCase()}C`;
}

function fmt(n: number) {
  // 4 decimali in mm (0,1 µm): abbastanza per qualunque stampante
  return Number.isFinite(n) ? (Math.round(n * 10000) / 10000).toString() : "0";
}

export interface ThreeMfOptions {
  /** colori dei filamenti (#rrggbb), indice = etichetta del triangolo */
  palette: string[];
  name: string;
  /** piatto di stampa: con più piatti i pezzi vengono disposti in griglia come in Bambu Studio */
  plate?: Plate;
}

export function build3mf(pieces: Placed[], opts: ThreeMfOptions): Uint8Array {
  const multi = opts.palette.length > 1;
  const parts: string[] = [];
  parts.push(`<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="it-IT" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">
 <metadata name="Application">Kalco3D</metadata>
 <metadata name="Title">${escapeXml(opts.name)}</metadata>
 <resources>`);
  parts.push(`  <basematerials id="1">`);
  opts.palette.forEach((hex, i) => {
    parts.push(`   <base name="Filamento ${i + 1}" displaycolor="${hex.toUpperCase()}FF"/>`);
  });
  parts.push(`  </basematerials>`);

  let piece = 0, pin = 0;
  const names = pieces.map((p) =>
    p.pin ? `Perno ${++pin}` : pieces.length > 1 ? `${opts.name} – pezzo ${++piece}` : opts.name,
  );
  pieces.forEach((p, idx) => {
    const id = idx + 2;
    const { vert, tri, label } = p.mesh;
    parts.push(`  <object id="${id}" name="${escapeXml(names[idx])}" type="model" pid="1" pindex="0">
   <mesh>
    <vertices>`);
    const vlines: string[] = [];
    for (let i = 0; i < vert.length; i += 3) {
      vlines.push(`     <vertex x="${fmt(vert[i])}" y="${fmt(vert[i + 1])}" z="${fmt(vert[i + 2])}"/>`);
    }
    parts.push(vlines.join("\n"));
    parts.push(`    </vertices>
    <triangles>`);
    const tlines: string[] = [];
    for (let t = 0; t < tri.length / 3; t++) {
      const l = label ? label[t] : 0;
      let attrs = "";
      if (multi) {
        const code = paintCode(l + 1);
        attrs = ` pid="1" p1="${l}" paint_color="${code}" slic3rpe:mmu_segmentation="${code}"`;
      }
      tlines.push(`     <triangle v1="${tri[t * 3]}" v2="${tri[t * 3 + 1]}" v3="${tri[t * 3 + 2]}"${attrs}/>`);
    }
    parts.push(tlines.join("\n"));
    parts.push(`    </triangles>
   </mesh>
  </object>`);
  });
  parts.push(` </resources>
 <build>`);
  const plates = Math.max(1, ...pieces.map((p) => (p.plate ?? 0) + 1));
  pieces.forEach((p, idx) => {
    const [ox, oy] = opts.plate && plates > 1 ? plateOrigin(p.plate ?? 0, plates, opts.plate) : [0, 0];
    const [x, y, z] = [p.offset[0] + ox, p.offset[1] + oy, p.offset[2]];
    parts.push(`  <item objectid="${idx + 2}" transform="1 0 0 0 1 0 0 0 1 ${fmt(x)} ${fmt(y)} ${fmt(z)}" printable="1"/>`);
  });
  parts.push(` </build>
</model>
`);

  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>
`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`;
  return zipSync(
    {
      "[Content_Types].xml": strToU8(contentTypes),
      "_rels/.rels": strToU8(rels),
      "3D/3dmodel.model": strToU8(parts.join("\n")),
    },
    { level: 6 },
  );
}

/** Un 3MF per piatto, raccolti in uno zip: funziona con qualunque slicer. */
export function build3mfPerPlate(pieces: Placed[], opts: ThreeMfOptions): Uint8Array {
  const plates = Math.max(1, ...pieces.map((p) => (p.plate ?? 0) + 1));
  const safe = opts.name.replace(/[^\p{L}\p{N} _-]/gu, "") || "modello";
  const files: Record<string, Uint8Array> = {};
  for (let k = 0; k < plates; k++) {
    const mine = pieces.filter((p) => (p.plate ?? 0) === k).map((p) => ({ ...p, plate: 0 }));
    files[`${safe} - piatto ${k + 1}.3mf`] = build3mf(mine, { ...opts, name: `${opts.name} – piatto ${k + 1}` });
  }
  // i 3MF sono già compressi: nello zip si archiviano e basta
  return zipSync(files, { level: 0 });
}

function escapeXml(s: string) {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
}
