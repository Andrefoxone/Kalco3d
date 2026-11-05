// Conversione heightmap → mesh 3D → GLB binario (glTF 2.0).
// TypeScript puro: nessuna dipendenza nativa, tutto il calcolo avviene qui.

export type GenerationMode = "rilievo" | "sfera" | "cilindro" | "torno";

export interface MeshInput {
  mode: GenerationMode;
  /** colonne della heightmap */
  width: number;
  /** righe della heightmap */
  height: number;
  /** valori 0..1, lunghezza width*height; riga 0 = bordo superiore della foto */
  heights: Float32Array;
  /** ampiezza del rilievo, 0..1 */
  depth: number;
  invert: boolean;
  /** sagoma opzionale: 1 = soggetto, 0 = sfondo (stesse dimensioni di heights) */
  mask?: Uint8Array;
  /** rilievo+maschera: aggiunge il guscio posteriore speculare (volume chiuso) */
  solid?: boolean;
}

export interface BuiltMesh {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
}

/** mezzo spessore minimo del volume chiuso (unità scena: la larghezza è 2,4) */
const MIN_HALF_THICKNESS = 0.012;

export function buildMesh(input: MeshInput): BuiltMesh {
  // il tornio segue un percorso dedicato: rivoluzione del profilo, cavo dentro
  if (input.mode === "torno") return buildLatheMesh(input);
  const { mode, width: W, height: H, depth, invert, mask } = input;
  const count = W * H;
  const h = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let v = input.heights[i];
    if (invert) v = 1 - v;
    if (mask && !mask[i]) v = 0; // lo sfondo resta piatto alla base
    h[i] = v;
  }

  const isReliefCut = Boolean(mask) && mode === "rilievo";
  const solid = isReliefCut && input.solid === true;
  if (isReliefCut && mask && !solid) {
    // guscio aperto: i vertici sul bordo della sagoma vanno a quota zero, così il
    // rilievo "affonda" nel piano invece di finire con uno scalino.
    // Un vertice è sul perimetro della mesh se almeno uno dei 4 quad che lo
    // toccano viene scartato (quad non interamente nella sagoma). Guardare solo i
    // 4 vicini non basta: negli angoli a scaletta restavano punti sollevati e il
    // volume chiuso aveva buchi (bordi aperti) proprio dove si stampa.
    const quadKept = (qi: number, qj: number) => {
      if (qi < 0 || qj < 0 || qi >= W - 1 || qj >= H - 1) return false;
      const a = qj * W + qi;
      return Boolean(mask[a] & mask[a + 1] & mask[a + W] & mask[a + W + 1]);
    };
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const k = j * W + i;
        if (!mask[k]) continue;
        const onBorder =
          !quadKept(i - 1, j - 1) || !quadKept(i, j - 1) ||
          !quadKept(i - 1, j) || !quadKept(i, j);
        if (onBorder) h[k] = 0;
      }
    }
  }

  const positions = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const amp = 0.12 + depth * 1.3;

  for (let j = 0; j < H; j++) {
    const v = j / (H - 1);
    for (let i = 0; i < W; i++) {
      const u = i / (W - 1);
      const k = j * W + i;
      uvs[k * 2] = u;
      uvs[k * 2 + 1] = v; // glTF: v=0 è il bordo superiore della texture
      // volume chiuso: spessore minimo ovunque (un bordo a spessore zero non si
      // stampa); fronte e retro vengono poi cuciti da una parete laterale
      const z = solid ? Math.max(h[k] * amp, MIN_HALF_THICKNESS) : h[k] * amp;
      if (mode === "rilievo") {
        const spanX = 2.4;
        const spanY = 2.4 * (H / W);
        positions[k * 3] = (u - 0.5) * spanX;
        positions[k * 3 + 1] = (0.5 - v) * spanY;
        positions[k * 3 + 2] = z;
      } else if (mode === "sfera") {
        const r = 1.05 + z * 0.5;
        const theta = u * Math.PI * 2;
        const phi = v * Math.PI;
        const sp = Math.sin(phi);
        positions[k * 3] = r * sp * Math.cos(theta);
        positions[k * 3 + 1] = r * Math.cos(phi);
        positions[k * 3 + 2] = r * sp * Math.sin(theta);
      } else {
        const theta = u * Math.PI * 2;
        const r = 1.0 + z * 0.42;
        const halfH = 1.45 * (H / W) + 0.35;
        positions[k * 3] = r * Math.cos(theta);
        positions[k * 3 + 1] = (0.5 - v) * 2 * halfH;
        positions[k * 3 + 2] = r * Math.sin(theta);
      }
    }
  }

  // con la sagoma attiva (modalità rilievo) restano solo i quad interamente
  // del soggetto: il bordo della mesh segue il bordo opaco della texture
  const cutToMask = mask && mode === "rilievo";
  const indexList: number[] = [];
  for (let j = 0; j < H - 1; j++) {
    for (let i = 0; i < W - 1; i++) {
      const a = j * W + i;
      const b = a + 1;
      const c = a + W;
      const d = c + 1;
      if (cutToMask && !(mask[a] & mask[b] & mask[c] & mask[d])) continue;
      if (mode === "rilievo") {
        // faccia frontale verso +Z
        indexList.push(a, c, b, b, c, d);
      } else {
        // normali rivolte verso l'esterno
        indexList.push(a, b, c, b, d, c);
      }
    }
  }

  let allPositions = positions;
  let allUvs = uvs;
  let vertexCount = count;

  if (solid) {
    // guscio posteriore speculare: stesse x/y, z invertita, UV identiche.
    // I vertici di bordo sono a z=0 su entrambi i lati, quindi il volume
    // risulta chiuso lungo tutto il perimetro della sagoma.
    const backPositions = new Float32Array(count * 3);
    const backUvs = new Float32Array(count * 2);
    for (let k = 0; k < count; k++) {
      backPositions[k * 3] = positions[k * 3];
      backPositions[k * 3 + 1] = positions[k * 3 + 1];
      backPositions[k * 3 + 2] = -positions[k * 3 + 2];
      backUvs[k * 2] = uvs[k * 2];
      backUvs[k * 2 + 1] = uvs[k * 2 + 1];
    }
    // stessa lista di quad del fronte, con avvolgimento invertito (verso -Z)
    const frontTris = indexList.length;
    for (let t = 0; t < frontTris; t += 3) {
      indexList.push(
        indexList[t] + count,
        indexList[t + 2] + count,
        indexList[t + 1] + count,
      );
    }
    // parete laterale: ogni spigolo di bordo del fronte (usato da un solo
    // triangolo) viene unito al suo gemello sul retro con due triangoli.
    // Se il fronte ha lo spigolo p→q, la parete percorre q→p e p'→q':
    // ogni spigolo compare una volta per verso, la superficie è chiusa.
    const edgeUse = new Map<number, number>();
    const ekey = (x: number, y: number) => Math.min(x, y) * count + Math.max(x, y);
    for (let t = 0; t < frontTris; t += 3) {
      for (let e = 0; e < 3; e++) {
        const k = ekey(indexList[t + e], indexList[t + ((e + 1) % 3)]);
        edgeUse.set(k, (edgeUse.get(k) ?? 0) + 1);
      }
    }
    for (let t = 0; t < frontTris; t += 3) {
      for (let e = 0; e < 3; e++) {
        const p = indexList[t + e];
        const q = indexList[t + ((e + 1) % 3)];
        if (edgeUse.get(ekey(p, q)) !== 1) continue;
        const pb = p + count;
        const qb = q + count;
        indexList.push(q, p, pb, pb, qb, q);
      }
    }
    const mergedPos = new Float32Array(count * 6);
    mergedPos.set(positions, 0);
    mergedPos.set(backPositions, count * 3);
    const mergedUv = new Float32Array(count * 4);
    mergedUv.set(uvs, 0);
    mergedUv.set(backUvs, count * 2);
    allPositions = mergedPos;
    allUvs = mergedUv;
    vertexCount = count * 2;
  }

  const indices = Uint32Array.from(indexList);
  const normals = computeNormals(allPositions, indices);
  return {
    positions: allPositions,
    normals,
    uvs: allUvs,
    indices,
    vertexCount,
    triangleCount: indices.length / 3,
  };
}

/**
 * Torno: rivoluziona il profilo della silhouette attorno all'asse verticale.
 * Il risultato è un oggetto cavo e aperto sopra (vasi, bottiglie, coppe):
 * superficie esterna, parete interna con spessore, anello di bordo sulla bocca,
 * fondo esterno chiuso e fondo interno. La texture della foto viene campionata
 * lungo la direttrice (centro → bordo della sagoma) e specchiata sul retro.
 */
function buildLatheMesh(input: MeshInput): BuiltMesh {
  const { width: W, height: H, mask, heights, depth, invert } = input;
  const empty: BuiltMesh = {
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    uvs: new Float32Array(0),
    indices: new Uint32Array(0),
    vertexCount: 0,
    triangleCount: 0,
  };
  if (!mask) return empty;

  // profilo: per ogni riga della griglia, centro e semi-larghezza della sagoma
  interface Row { j: number; cx: number; r: number }
  const rows: Row[] = [];
  for (let j = 0; j < H; j++) {
    let minI = -1;
    let maxI = -1;
    for (let i = 0; i < W; i++) {
      if (mask[j * W + i]) {
        if (minI < 0) minI = i;
        maxI = i;
      }
    }
    if (minI >= 0 && maxI - minI >= 2) {
      rows.push({ j, cx: (minI + maxI) / 2, r: (maxI - minI) / 2 });
    }
  }
  if (rows.length < 6) return empty;

  // leviga asse e raggio lungo il profilo: la sagoma ha bordi interi al pixel
  // (min/max per riga) e i gradini diventerebbero anelli visibili sulla
  // superficie. Gaussiana sigma 2 su ±5 righe: spalma ogni gradino su ~10 righe.
  {
    const kern: number[] = [];
    for (let o = -5; o <= 5; o++) kern.push(Math.exp(-(o * o) / 8));
    const src = rows.map((rw) => ({ ...rw }));
    for (let k = 0; k < rows.length; k++) {
      let r = 0;
      let cx = 0;
      let wsum = 0;
      for (let o = -5; o <= 5; o++) {
        const kk = k + o;
        if (kk < 0 || kk >= rows.length) continue;
        const wgt = kern[o + 5];
        r += src[kk].r * wgt;
        cx += src[kk].cx * wgt;
        wsum += wgt;
      }
      rows[k].r = r / wsum;
      rows[k].cx = cx / wsum;
    }
  }

  const R = rows.length;
  const scale = 2.6 / R;
  let maxR = 1;
  for (const rw of rows) if (rw.r > maxR) maxR = rw.r;
  // spessore della parete in px di griglia
  const wall = Math.min(Math.max(maxR * 0.07, 1.2), 6);
  // segmenti angolari proporzionati alla larghezza dell'oggetto
  const S = Math.min(160, Math.max(48, Math.round(maxR * 2.4)));

  const yOf = (k: number) => ((R - 1) / 2 - k) * scale;
  const axisX = (k: number) => (rows[k].cx - (W - 1) / 2) * scale;

  // baseline orizzontale ampia per riga: il dettaglio radiale è solo l'alta
  // frequenza (fasce, scanalature); il gradiente di illuminazione della foto
  // non deve deformare il profilo. La finestra resta dentro la sagoma.
  const rb = Math.max(4, Math.round(W / 14));
  const rowSpan: [number, number][] = rows.map((rw) => [
    Math.max(0, Math.round(rw.cx - rw.r)),
    Math.min(W - 1, Math.round(rw.cx + rw.r)),
  ]);
  const rowBase: Float32Array[] = [];
  for (let k = 0; k < R; k++) {
    const j = rows[k].j;
    const [i0, i1] = rowSpan[k];
    const pref = new Float64Array(i1 - i0 + 2);
    for (let i = i0; i <= i1; i++) pref[i - i0 + 1] = pref[i - i0] + heights[j * W + i];
    const base = new Float32Array(W);
    for (let i = i0; i <= i1; i++) {
      const a = Math.max(i0, i - rb);
      const b = Math.min(i1, i + rb);
      base[i] = (pref[b - i0 + 1] - pref[a - i0]) / (b - a + 1);
    }
    rowBase.push(base);
  }
  const detailAmp = (0.1 + depth * 0.45) * (invert ? -1 : 1);

  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const pushVert = (x: number, y: number, z: number, u: number, v: number) => {
    pos.push(x, y, z);
    uv.push(Math.min(1, Math.max(0, u)), Math.min(1, Math.max(0, v)));
    return pos.length / 3 - 1;
  };
  const uOf = (k: number, sin: number, r: number) =>
    (rows[k].cx + sin * r) / (W - 1);
  const vOf = (k: number) => rows[k].j / (H - 1);

  // --- superficie esterna: R anelli × S segmenti, con dettaglio radiale ---
  const outerStart = pos.length / 3;
  const outerPts = new Float32Array(R * S * 3);
  for (let k = 0; k < R; k++) {
    const { j, cx, r } = rows[k];
    for (let s = 0; s < S; s++) {
      const th = (s / S) * Math.PI * 2;
      const sn = Math.sin(th);
      const cs = Math.cos(th);
      const iPx = Math.min(W - 1, Math.max(0, Math.round(cx + sn * r)));
      let d = heights[j * W + iPx] - rowBase[k][iPx];
      d = Math.max(-0.3, Math.min(0.3, d));
      const rr = r * (1 + d * detailAmp) * scale;
      const x = axisX(k) + rr * sn;
      const y = yOf(k);
      const z = rr * cs;
      const vi = pushVert(x, y, z, uOf(k, sn, r), vOf(k));
      outerPts[vi * 3] = x;
      outerPts[vi * 3 + 1] = y;
      outerPts[vi * 3 + 2] = z;
    }
  }
  for (let k = 0; k < R - 1; k++) {
    for (let s = 0; s < S; s++) {
      const a = outerStart + k * S + s;
      const b = outerStart + k * S + ((s + 1) % S);
      const c = outerStart + (k + 1) * S + s;
      const d = outerStart + (k + 1) * S + ((s + 1) % S);
      idx.push(a, c, b, b, c, d); // normali verso l'esterno
    }
  }

  // ventaglio chiuso su un anello duplicato (bordo vivo, normali nette)
  const capFan = (ringK: number, up: boolean) => {
    const ringStart = pos.length / 3;
    for (let s = 0; s < S; s++) {
      const src = (ringK * S + s) * 3;
      const th = (s / S) * Math.PI * 2;
      pushVert(
        outerPts[src],
        outerPts[src + 1],
        outerPts[src + 2],
        uOf(ringK, Math.sin(th), rows[ringK].r),
        vOf(ringK),
      );
    }
    const center = pushVert(
      axisX(ringK),
      yOf(ringK),
      0,
      rows[ringK].cx / (W - 1),
      vOf(ringK),
    );
    for (let s = 0; s < S; s++) {
      const a = ringStart + s;
      const b = ringStart + ((s + 1) % S);
      if (up) idx.push(center, a, b);
      else idx.push(center, b, a);
    }
  };

  // --- fondo esterno (normale verso il basso) ---
  capFan(R - 1, false);

  // righe abbastanza larghe da ospitare una parete interna
  const innerOk = rows.map((rw) => rw.r > wall * 1.4);
  let mouthIdx = -1;
  for (let k = 0; k < R; k++) {
    if (innerOk[k]) {
      mouthIdx = k;
      break;
    }
  }
  let innerLast = -1;
  for (let k = R - 1; k >= 0; k--) {
    if (innerOk[k]) {
      innerLast = k;
      break;
    }
  }
  // il fondo interno si ferma qualche riga sopra il fondo esterno
  const floorRows = Math.max(2, Math.round(R * 0.03));
  innerLast = Math.min(innerLast, R - 1 - floorRows);
  const hollow = mouthIdx >= 0 && innerLast > mouthIdx + 2;

  if (mouthIdx > 0) {
    // punta stretta sopra la bocca (tappo, collo chiuso): si chiude a disco
    capFan(0, true);
  }

  // bocca aperta solo se la parete interna parte dalla prima riga; con un collo
  // troppo stretto (bottiglia) il collo resta pieno e la cavità viene chiusa da
  // un soffitto: agganciare il bordo a metà della superficie esterna creava
  // spigoli condivisi da 3 facce (mesh non stampabile)
  const openMouth = hollow && mouthIdx === 0;
  if (hollow && !openMouth) {
    // --- soffitto della cavità (normale verso il basso, dentro la cavità) ---
    const ceilRing = pos.length / 3;
    const rInTop = Math.max(rows[mouthIdx].r - wall, 0.4);
    for (let s = 0; s < S; s++) {
      const th = (s / S) * Math.PI * 2;
      const sn = Math.sin(th);
      pushVert(
        axisX(mouthIdx) + rInTop * scale * sn,
        yOf(mouthIdx),
        rInTop * scale * Math.cos(th),
        uOf(mouthIdx, sn, rInTop),
        vOf(mouthIdx),
      );
    }
    const ceilCenter = pushVert(axisX(mouthIdx), yOf(mouthIdx), 0, rows[mouthIdx].cx / (W - 1), vOf(mouthIdx));
    for (let s = 0; s < S; s++) {
      const a = ceilRing + s;
      const b = ceilRing + ((s + 1) % S);
      idx.push(ceilCenter, b, a);
    }
  }

  if (hollow) {
    if (openMouth) {
    // --- anello del bordo: collega esterno e interno sulla bocca ---
    const rimOut = pos.length / 3;
    for (let s = 0; s < S; s++) {
      const src = (mouthIdx * S + s) * 3;
      const th = (s / S) * Math.PI * 2;
      pushVert(
        outerPts[src],
        outerPts[src + 1],
        outerPts[src + 2],
        uOf(mouthIdx, Math.sin(th), rows[mouthIdx].r),
        vOf(mouthIdx),
      );
    }
    const rimIn = pos.length / 3;
    const rInMouth = Math.max(rows[mouthIdx].r - wall, 0.4);
    for (let s = 0; s < S; s++) {
      const th = (s / S) * Math.PI * 2;
      const sn = Math.sin(th);
      pushVert(
        axisX(mouthIdx) + rInMouth * scale * sn,
        yOf(mouthIdx),
        rInMouth * scale * Math.cos(th),
        uOf(mouthIdx, sn, rInMouth),
        vOf(mouthIdx),
      );
    }
    for (let s = 0; s < S; s++) {
      const a = rimOut + s;
      const b = rimOut + ((s + 1) % S);
      const c = rimIn + s;
      const d = rimIn + ((s + 1) % S);
      idx.push(a, b, c, b, d, c); // normale verso l'alto
    }
    }

    // --- parete interna: liscia, dalla bocca al fondo interno ---
    const innerStart = pos.length / 3;
    const innerCount = innerLast - mouthIdx + 1;
    for (let k = mouthIdx; k <= innerLast; k++) {
      const rIn = Math.max(rows[k].r - wall, 0.4);
      for (let s = 0; s < S; s++) {
        const th = (s / S) * Math.PI * 2;
        const sn = Math.sin(th);
        pushVert(
          axisX(k) + rIn * scale * sn,
          yOf(k),
          rIn * scale * Math.cos(th),
          uOf(k, sn, rIn),
          vOf(k),
        );
      }
    }
    for (let k = 0; k < innerCount - 1; k++) {
      for (let s = 0; s < S; s++) {
        const a = innerStart + k * S + s;
        const b = innerStart + k * S + ((s + 1) % S);
        const c = innerStart + (k + 1) * S + s;
        const d = innerStart + (k + 1) * S + ((s + 1) % S);
        idx.push(a, b, c, b, d, c); // normali verso la cavità
      }
    }

    // --- fondo interno (normale verso l'alto, dentro la cavità) ---
    const floorRing = pos.length / 3;
    const rInFloor = Math.max(rows[innerLast].r - wall, 0.4);
    for (let s = 0; s < S; s++) {
      const th = (s / S) * Math.PI * 2;
      const sn = Math.sin(th);
      pushVert(
        axisX(innerLast) + rInFloor * scale * sn,
        yOf(innerLast),
        rInFloor * scale * Math.cos(th),
        uOf(innerLast, sn, rInFloor),
        vOf(innerLast),
      );
    }
    const floorCenter = pushVert(
      axisX(innerLast),
      yOf(innerLast),
      0,
      rows[innerLast].cx / (W - 1),
      vOf(innerLast),
    );
    for (let s = 0; s < S; s++) {
      const a = floorRing + s;
      const b = floorRing + ((s + 1) % S);
      idx.push(floorCenter, a, b);
    }
  }

  const positions = Float32Array.from(pos);
  const indices = Uint32Array.from(idx);
  const normals = computeNormals(positions, indices);
  return {
    positions,
    normals,
    uvs: Float32Array.from(uv),
    indices,
    vertexCount: positions.length / 3,
    triangleCount: indices.length / 3,
  };
}

function computeNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const ia = indices[t] * 3;
    const ib = indices[t + 1] * 3;
    const ic = indices[t + 2] * 3;
    const abx = positions[ib] - positions[ia];
    const aby = positions[ib + 1] - positions[ia + 1];
    const abz = positions[ib + 2] - positions[ia + 2];
    const acx = positions[ic] - positions[ia];
    const acy = positions[ic + 1] - positions[ia + 1];
    const acz = positions[ic + 2] - positions[ia + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    normals[ia] += nx; normals[ia + 1] += ny; normals[ia + 2] += nz;
    normals[ib] += nx; normals[ib + 1] += ny; normals[ib + 2] += nz;
    normals[ic] += nx; normals[ic + 1] += ny; normals[ic + 2] += nz;
  }
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= len;
    normals[i + 1] /= len;
    normals[i + 2] /= len;
  }
  return normals;
}

export interface GlbTextureOptions {
  mimeType?: "image/jpeg" | "image/png";
  /** attiva l'alpha cutout (texture PNG con trasparenza della sagoma) */
  alphaMask?: boolean;
}

/** Serializza la mesh + texture in un GLB (glTF 2.0 binario). */
export function buildGlb(
  mesh: BuiltMesh,
  texture: Buffer,
  opts: GlbTextureOptions = {},
): Buffer {
  const mimeType = opts.mimeType ?? "image/jpeg";
  const posBuf = toBuffer(mesh.positions);
  const norBuf = toBuffer(mesh.normals);
  const uvBuf = toBuffer(mesh.uvs);
  const idxBuf = toBuffer(mesh.indices);

  // layout del chunk BIN: ogni sezione allineata a 4 byte
  const sections = [posBuf, norBuf, uvBuf, idxBuf, texture];
  const offsets: number[] = [];
  let cursor = 0;
  for (const s of sections) {
    offsets.push(cursor);
    cursor += s.length + pad4(s.length);
  }
  const binLength = cursor;
  const bin = Buffer.alloc(binLength);
  for (let s = 0; s < sections.length; s++) {
    sections[s].copy(bin, offsets[s]);
  }

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const val = mesh.positions[i + axis];
      if (val < min[axis]) min[axis] = val;
      if (val > max[axis]) max[axis] = val;
    }
  }

  const json = {
    asset: { version: "2.0", generator: "Kalco3D" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: "Modello" }],
    meshes: [
      {
        name: "Rilievo",
        primitives: [
          {
            attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 },
            indices: 3,
            material: 0,
          },
        ],
      },
    ],
    materials: [
      {
        name: "MaterialeFoto",
        pbrMetallicRoughness: {
          baseColorTexture: { index: 0 },
          metallicFactor: 0.02,
          roughnessFactor: 0.85,
        },
        doubleSided: true,
        ...(opts.alphaMask ? { alphaMode: "MASK", alphaCutoff: 0.35 } : {}),
      },
    ],
    textures: [{ source: 0, sampler: 0 }],
    samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
    images: [{ bufferView: 4, mimeType, name: "foto" }],
    accessors: [
      {
        bufferView: 0, componentType: 5126, count: mesh.vertexCount, type: "VEC3",
        min, max,
      },
      { bufferView: 1, componentType: 5126, count: mesh.vertexCount, type: "VEC3" },
      { bufferView: 2, componentType: 5126, count: mesh.vertexCount, type: "VEC2" },
      { bufferView: 3, componentType: 5125, count: mesh.indices.length, type: "SCALAR" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: offsets[0], byteLength: posBuf.length, target: 34962 },
      { buffer: 0, byteOffset: offsets[1], byteLength: norBuf.length, target: 34962 },
      { buffer: 0, byteOffset: offsets[2], byteLength: uvBuf.length, target: 34962 },
      { buffer: 0, byteOffset: offsets[3], byteLength: idxBuf.length, target: 34963 },
      { buffer: 0, byteOffset: offsets[4], byteLength: texture.length },
    ],
    buffers: [{ byteLength: binLength }],
  };

  let jsonBuf = Buffer.from(JSON.stringify(json), "utf8");
  const jsonPad = pad4(jsonBuf.length);
  if (jsonPad > 0) {
    jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);
  }

  const totalLength = 12 + 8 + jsonBuf.length + 8 + bin.length;
  const glb = Buffer.alloc(totalLength);
  let o = 0;
  glb.writeUInt32LE(0x46546c67, o); o += 4; // "glTF"
  glb.writeUInt32LE(2, o); o += 4;
  glb.writeUInt32LE(totalLength, o); o += 4;
  glb.writeUInt32LE(jsonBuf.length, o); o += 4;
  glb.writeUInt32LE(0x4e4f534a, o); o += 4; // "JSON"
  jsonBuf.copy(glb, o); o += jsonBuf.length;
  glb.writeUInt32LE(bin.length, o); o += 4;
  glb.writeUInt32LE(0x004e4942, o); o += 4; // "BIN\0"
  bin.copy(glb, o);
  return glb;
}

function toBuffer(arr: Float32Array | Uint32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

function pad4(n: number): number {
  return (4 - (n % 4)) % 4;
}
