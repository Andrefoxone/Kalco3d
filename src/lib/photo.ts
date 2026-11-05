// Elaborazione lato client della foto: heightmap in scala di grigi + texture JPEG.

export interface Heightmap {
  width: number;
  height: number;
  /** valori 0..1, riga 0 = bordo superiore */
  heights: number[];
}

export interface LoadedPhoto {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  previewUrl: string;
  fileName: string;
}

export async function loadPhoto(file: File): Promise<LoadedPhoto> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const maxSide = 1600;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const previewUrl = canvas.toDataURL("image/jpeg", 0.85);
  return { canvas, width: w, height: h, previewUrl, fileName: file.name };
}

/** Estrae la mappa di profondità (luminanza) alla risoluzione richiesta. */
export function extractHeightmap(
  source: HTMLCanvasElement,
  resolution: number,
  smoothPasses: number,
): Heightmap {
  const aspect = source.height / source.width;
  const w = resolution;
  const h = Math.max(16, Math.round(resolution * aspect));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(source, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  let grid: Float32Array = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    grid[i] = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }
  for (let p = 0; p < smoothPasses; p++) {
    grid = boxBlur(grid, w, h);
  }
  return { width: w, height: h, heights: Array.from(grid) };
}

/** Sagoma del soggetto ritagliato dallo sfondo. */
export interface ObjectMask {
  width: number;
  height: number;
  /** 1 = soggetto, 0 = sfondo */
  data: Uint8Array;
  /** quota di pixel del soggetto, 0..1 */
  coverage: number;
}

/**
 * Ritaglia il soggetto dallo sfondo: il colore dello sfondo viene stimato dai
 * bordi della foto e rimosso con un flood-fill tollerante. Le zone interne al
 * soggetto restano sempre piene, anche se somigliano allo sfondo.
 * Funziona bene con sfondi abbastanza uniformi (parete, cielo, studio).
 */
export function extractMask(
  source: HTMLCanvasElement,
  width: number,
  height: number,
  tolerance: number, // 0..1
): ObjectMask {
  const w = width;
  const h = height;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(source, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;

  // colore di sfondo = mediana dei pixel sul bordo esterno
  const br: number[] = [];
  const bg: number[] = [];
  const bb: number[] = [];
  const pushBorder = (i: number) => {
    br.push(px[i * 4]);
    bg.push(px[i * 4 + 1]);
    bb.push(px[i * 4 + 2]);
  };
  for (let x = 0; x < w; x++) {
    pushBorder(x);
    pushBorder((h - 1) * w + x);
  }
  for (let y = 1; y < h - 1; y++) {
    pushBorder(y * w);
    pushBorder(y * w + w - 1);
  }
  const med = (a: number[]) => a.sort((p, q) => p - q)[a.length >> 1];
  const cr = med(br);
  const cg = med(bg);
  const cb = med(bb);

  // flood-fill dai bordi: tutto ciò che somiglia allo sfondo ed è connesso al bordo
  const maxDist = 6 + tolerance * 150;
  const dist2 = maxDist * maxDist;
  const isBg = new Uint8Array(w * h);
  const stack: number[] = [];
  const tryPush = (i: number) => {
    if (isBg[i]) return;
    const dr = px[i * 4] - cr;
    const dg = px[i * 4 + 1] - cg;
    const db = px[i * 4 + 2] - cb;
    if (dr * dr + dg * dg + db * db <= dist2) {
      isBg[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    tryPush(x);
    tryPush((h - 1) * w + x);
  }
  for (let y = 1; y < h - 1; y++) {
    tryPush(y * w);
    tryPush(y * w + w - 1);
  }
  while (stack.length > 0) {
    const i = stack.pop()!;
    const x = i % w;
    const y = (i / w) | 0;
    if (x > 0) tryPush(i - 1);
    if (x < w - 1) tryPush(i + 1);
    if (y > 0) tryPush(i - w);
    if (y < h - 1) tryPush(i + w);
  }

  // soggetto = non sfondo, ripulito da granelli e buchi con un filtro 3×3
  const fg = new Uint8Array(w * h);
  for (let i = 0; i < fg.length; i++) fg[i] = isBg[i] ^ 1;
  const clean = majorityFilter(majorityFilter(fg, w, h), w, h);
  let count = 0;
  for (let i = 0; i < clean.length; i++) count += clean[i];
  return { width: w, height: h, data: clean, coverage: count / clean.length };
}

/**
 * Ricava la forma 3D del soggetto dalla sagoma: una cupola basata sulla
 * distanza dal bordo (lo "sbalzo" dell'oggetto) più il dettaglio di superficie
 * dalla luminanza ad alta frequenza. L'illuminazione globale della foto non
 * deforma la forma: le ombre scure non diventano più voragini.
 */
export function shapeHeightsFromMask(heights: number[], mask: ObjectMask): void {
  const { width: w, height: h, data: m } = mask;
  const n = w * h;
  const INF = 1e9;
  const dt = new Float32Array(n);
  for (let i = 0; i < n; i++) dt[i] = m[i] ? INF : 0;
  const D = Math.SQRT2;
  // distanza dal bordo (chamfer, due passate)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (dt[i] === 0) continue;
      let d = dt[i];
      if (x > 0) d = Math.min(d, dt[i - 1] + 1);
      if (y > 0) d = Math.min(d, dt[i - w] + 1);
      if (x > 0 && y > 0) d = Math.min(d, dt[i - w - 1] + D);
      if (x < w - 1 && y > 0) d = Math.min(d, dt[i - w + 1] + D);
      dt[i] = d;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (dt[i] === 0) continue;
      let d = dt[i];
      if (x < w - 1) d = Math.min(d, dt[i + 1] + 1);
      if (y < h - 1) d = Math.min(d, dt[i + w] + 1);
      if (x < w - 1 && y < h - 1) d = Math.min(d, dt[i + w + 1] + D);
      if (x > 0 && y < h - 1) d = Math.min(d, dt[i + w - 1] + D);
      dt[i] = d;
    }
  }
  let maxD = 1;
  for (let i = 0; i < n; i++) {
    if (dt[i] !== INF && dt[i] > maxD) maxD = dt[i];
  }

  // luminanza: resta il dettaglio fine, sparisce l'illuminazione globale
  const lum = Float32Array.from(heights);
  let low: Float32Array = Float32Array.from(lum);
  for (let p = 0; p < 3; p++) low = boxBlur(low, w, h);

  for (let i = 0; i < n; i++) {
    if (!m[i]) {
      heights[i] = 0;
      continue;
    }
    // la zona morta di ~1.4 px lascia al bordo una rampa dolce: con il volume
    // chiuso fronte/retro la cucitura sul perimetro non fa gradini di shading
    const profile = Math.pow(Math.max(0, dt[i] - 1.4) / maxD, 0.65);
    let detail = (lum[i] - low[i]) * 1.6;
    detail = Math.max(-0.35, Math.min(0.35, detail));
    heights[i] = Math.min(1, Math.max(0, profile * 0.85 + lum[i] * 0.1 + detail * 0.3));
  }
}

/** Canvas bianco/trasparente della sagoma, usato per anteprime e alpha. */
export function maskToCanvas(mask: ObjectMask): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = mask.width;
  canvas.height = mask.height;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(mask.width, mask.height);
  for (let i = 0; i < mask.data.length; i++) {
    img.data[i * 4] = 255;
    img.data[i * 4 + 1] = 255;
    img.data[i * 4 + 2] = 255;
    img.data[i * 4 + 3] = mask.data[i] ? 255 : 0;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function majorityFilter(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = mask[y * w + x];
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          sum += xx >= 0 && xx < w && yy >= 0 && yy < h ? mask[yy * w + xx] : c;
        }
      }
      out[y * w + x] = sum >= 5 ? 1 : 0;
    }
  }
  return out;
}

/** Texture per il GLB: JPEG normale, oppure PNG con alpha se c'è la sagoma. */
export function extractTextureBase64(
  source: HTMLCanvasElement,
  mask?: ObjectMask,
): string {
  const maxSide = 768;
  const scale = Math.min(1, maxSide / Math.max(source.width, source.height));
  const w = Math.max(1, Math.round(source.width * scale));
  const h = Math.max(1, Math.round(source.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(source, 0, 0, w, h);
  if (!mask) {
    return canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
  }
  // alpha dalla sagoma, ridisegnata alla risoluzione texture con bordi sfumati
  const alphaCanvas = document.createElement("canvas");
  alphaCanvas.width = w;
  alphaCanvas.height = h;
  const actx = alphaCanvas.getContext("2d", { willReadFrequently: true })!;
  actx.imageSmoothingEnabled = true;
  actx.imageSmoothingQuality = "high";
  actx.drawImage(maskToCanvas(mask), 0, 0, w, h);
  const alpha = actx.getImageData(0, 0, w, h).data;
  const img = ctx.getImageData(0, 0, w, h);
  for (let i = 0; i < w * h; i++) {
    img.data[i * 4 + 3] = alpha[i * 4];
  }
  // stendi i colori del soggetto dentro lo sfondo trasparente: evita l'alone
  // chiaro ai bordi quando la texture viene rimpicciolita (mipmap)
  const filled = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) filled[i] = alpha[i * 4] > 128 ? 1 : 0;
  let frontier = filled;
  for (let pass = 0; pass < 12; pass++) {
    const next = new Uint8Array(frontier);
    let any = false;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (frontier[i]) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        const around = [i - 1, i + 1, i - w, i + w];
        for (let a = 0; a < 4; a++) {
          const j2 = around[a];
          const jx = j2 % w;
          if (j2 < 0 || j2 >= w * h || Math.abs(jx - x) > 1 || !frontier[j2]) continue;
          r += img.data[j2 * 4];
          g += img.data[j2 * 4 + 1];
          b += img.data[j2 * 4 + 2];
          n++;
        }
        if (n > 0) {
          img.data[i * 4] = r / n;
          img.data[i * 4 + 1] = g / n;
          img.data[i * 4 + 2] = b / n;
          next[i] = 1;
          any = true;
        }
      }
    }
    frontier = next;
    if (!any) break;
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL("image/png").split(",")[1];
}

function boxBlur(grid: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(grid.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && xx < w && yy >= 0 && yy < h) {
            sum += grid[yy * w + xx];
            n++;
          }
        }
      }
      out[y * w + x] = sum / n;
    }
  }
  return out;
}

/** Disegna una foto di esempio procedurale: superficie lunare con crateri. */
export function drawSample(): HTMLCanvasElement {
  const w = 640;
  const h = 480;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;

  // cielo sfumato caldo
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, "#3b3f4a");
  sky.addColorStop(0.55, "#6e727c");
  sky.addColorStop(1, "#9a9ba0");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  // sole radiale
  const sun = ctx.createRadialGradient(w * 0.78, h * 0.24, 4, w * 0.78, h * 0.24, 190);
  sun.addColorStop(0, "rgba(255,244,214,0.95)");
  sun.addColorStop(0.25, "rgba(255,238,200,0.55)");
  sun.addColorStop(1, "rgba(255,238,200,0)");
  ctx.fillStyle = sun;
  ctx.fillRect(0, 0, w, h);

  // luna grande con crateri
  const cx = w * 0.4;
  const cy = h * 0.46;
  const r = 150;
  const moon = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.1, cx, cy, r);
  moon.addColorStop(0, "#f4f1e8");
  moon.addColorStop(0.7, "#cfccc2");
  moon.addColorStop(1, "#8f8d85");
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = moon;
  ctx.fill();

  let seed = 42;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 26; i++) {
    const cr = 4 + rand() * 26;
    const ang = rand() * Math.PI * 2;
    const dist = rand() * (r - cr - 6);
    const x = cx + Math.cos(ang) * dist;
    const y = cy + Math.sin(ang) * dist;
    const crater = ctx.createRadialGradient(x - cr * 0.3, y - cr * 0.3, cr * 0.1, x, y, cr);
    crater.addColorStop(0, "rgba(88,86,80,0.75)");
    crater.addColorStop(0.75, "rgba(120,118,110,0.45)");
    crater.addColorStop(1, "rgba(200,198,190,0.35)");
    ctx.beginPath();
    ctx.arc(x, y, cr, 0, Math.PI * 2);
    ctx.fillStyle = crater;
    ctx.fill();
  }

  // dune in primo piano
  ctx.fillStyle = "#56575e";
  ctx.beginPath();
  ctx.moveTo(0, h);
  for (let x = 0; x <= w; x += 8) {
    const y = h * 0.82 + Math.sin(x * 0.02) * 18 + Math.sin(x * 0.055 + 2) * 9;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fill();

  // grana
  const noise = ctx.getImageData(0, 0, w, h);
  for (let i = 0; i < noise.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 14;
    noise.data[i] += n;
    noise.data[i + 1] += n;
    noise.data[i + 2] += n;
  }
  ctx.putImageData(noise, 0, 0);
  return canvas;
}

/** Disegna un oggetto di esempio: vaso terracotta su sfondo chiaro uniforme. */
export function drawSampleObject(): HTMLCanvasElement {
  const w = 640;
  const h = 640;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;

  // sfondo chiaro con leggerissima vignettatura
  ctx.fillStyle = "#e9e7e3";
  ctx.fillRect(0, 0, w, h);
  const vig = ctx.createRadialGradient(w / 2, h / 2, h * 0.3, w / 2, h / 2, h * 0.75);
  vig.addColorStop(0, "rgba(255,255,255,0.35)");
  vig.addColorStop(1, "rgba(160,155,148,0.22)");
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, w, h);

  const cx = w / 2;

  // ombra morbida sotto il vaso (tenue, simile allo sfondo)
  const shadow = ctx.createRadialGradient(cx, 560, 10, cx, 560, 150);
  shadow.addColorStop(0, "rgba(70,64,58,0.10)");
  shadow.addColorStop(1, "rgba(70,64,58,0)");
  ctx.fillStyle = shadow;
  ctx.beginPath();
  ctx.ellipse(cx, 560, 150, 26, 0, 0, Math.PI * 2);
  ctx.fill();

  // corpo del vaso: silhouette a bezier, riempita con gradiente orizzontale
  const body = new Path2D();
  body.moveTo(cx - 62, 168);
  body.bezierCurveTo(cx - 150, 230, cx - 158, 380, cx - 96, 500);
  body.bezierCurveTo(cx - 80, 538, cx - 70, 548, cx - 66, 552);
  body.lineTo(cx + 66, 552);
  body.bezierCurveTo(cx + 70, 548, cx + 80, 538, cx + 96, 500);
  body.bezierCurveTo(cx + 158, 380, cx + 150, 230, cx + 62, 168);
  body.closePath();
  const clay = ctx.createLinearGradient(cx - 150, 0, cx + 150, 0);
  clay.addColorStop(0, "#e08b54");
  clay.addColorStop(0.35, "#c96f3f");
  clay.addColorStop(0.72, "#9c4f27");
  clay.addColorStop(1, "#7c3c1c");
  ctx.fillStyle = clay;
  ctx.fill(body);

  // collo e bordo
  ctx.fillStyle = "#b55f33";
  ctx.fillRect(cx - 62, 150, 124, 24);
  ctx.beginPath();
  ctx.ellipse(cx, 150, 62, 14, 0, 0, Math.PI * 2);
  ctx.fillStyle = "#8a4522";
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(cx, 152, 48, 9, 0, 0, Math.PI * 2);
  ctx.fillStyle = "#4d2412";
  ctx.fill();

  // luce radente a sinistra
  const light = ctx.createLinearGradient(cx - 140, 0, cx - 40, 0);
  light.addColorStop(0, "rgba(255,236,214,0.5)");
  light.addColorStop(1, "rgba(255,236,214,0)");
  ctx.save();
  ctx.clip(body);
  ctx.fillStyle = light;
  ctx.fillRect(cx - 160, 140, 130, 430);
  // fascia decorativa: tenue, perché il servizio AI leggerebbe una linea
  // netta come un bordo geometrico (sporgenza) invece che come decorazione
  ctx.fillStyle = "rgba(77,36,18,0.22)";
  ctx.fillRect(cx - 160, 322, 320, 12);
  ctx.restore();

  return canvas;
}
