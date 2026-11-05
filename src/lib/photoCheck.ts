// Controllo qualità della foto PRIMA di spendere crediti di generazione.
// Funzioni pure su pixel RGBA: testabili senza browser.

export type CheckLevel = "ok" | "avviso" | "problema";

export interface CheckItem {
  level: CheckLevel;
  code: "risoluzione" | "sfocata" | "scura" | "chiara" | "riflessi" | "tagliato" | "piccolo" | "vicino" | "sfondo";
  message: string;
}

export interface PhotoCheck {
  level: CheckLevel;
  items: CheckItem[];
  /** misure grezze, utili per debug e soglie */
  metrics: {
    minSide: number;
    sharpness: number;
    meanLuma: number;
    clipped: number;
    coverage: number | null;
    borderTouch: number | null;
    borderNoise: number;
  };
}

export interface Pixels {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

const luma = (d: Pixels["data"], i: number) => 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];

/** Ridimensiona (box filter) a lato massimo `max`: misure confrontabili tra foto. */
export function downscale(px: Pixels, max: number): Pixels {
  const s = Math.min(1, max / Math.max(px.width, px.height));
  if (s === 1) return px;
  const w = Math.max(1, Math.round(px.width * s));
  const h = Math.max(1, Math.round(px.height * s));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y / s), y1 = Math.min(px.height, Math.floor((y + 1) / s));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x / s), x1 = Math.min(px.width, Math.floor((x + 1) / s));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < Math.max(y1, y0 + 1); yy++) {
        for (let xx = x0; xx < Math.max(x1, x0 + 1); xx++) {
          const i = (yy * px.width + xx) * 4;
          r += px.data[i]; g += px.data[i + 1]; b += px.data[i + 2]; a += px.data[i + 3]; n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return { data: out, width: w, height: h };
}

/** Nitidezza = varianza del laplaciano sulla luminanza (alta = nitida). */
export function sharpness(px: Pixels): number {
  const { width: w, height: h, data } = px;
  if (w < 3 || h < 3) return 0;
  let sum = 0, sum2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = 4 * luma(data, i) - luma(data, i - 1) - luma(data, i + 1) - luma(data, i - w) - luma(data, i + w);
      sum += l; sum2 += l * l; n++;
    }
  }
  const mean = sum / n;
  return sum2 / n - mean * mean;
}

/**
 * Sagoma del soggetto con flood-fill dai bordi sul colore di sfondo stimato
 * (stessa logica del ritaglio del rilievo). 1 = soggetto.
 */
export function maskFromPixels(px: Pixels, tolerance: number): { mask: Uint8Array; borderNoise: number } {
  const { width: w, height: h, data } = px;
  const border: number[] = [];
  for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) border.push(y * w, y * w + w - 1);
  const ch = (c: number) => border.map((i) => data[i * 4 + c]).sort((a, b) => a - b);
  const rs = ch(0), gs = ch(1), bs = ch(2);
  const mid = border.length >> 1;
  const cr = rs[mid], cg = gs[mid], cb = bs[mid];
  // dispersione del bordo (mediana: un soggetto che tocca il bordo non la falsa)
  const devs = border
    .map((i) => Math.hypot(data[i * 4] - cr, data[i * 4 + 1] - cg, data[i * 4 + 2] - cb))
    .sort((a, b) => a - b);
  const borderNoise = devs[devs.length >> 1];

  const maxDist = 6 + tolerance * 150;
  const d2 = maxDist * maxDist;
  const isBg = new Uint8Array(w * h);
  const stack: number[] = [];
  const tryPush = (i: number) => {
    if (isBg[i]) return;
    const dr = data[i * 4] - cr, dg = data[i * 4 + 1] - cg, db = data[i * 4 + 2] - cb;
    if (dr * dr + dg * dg + db * db <= d2) {
      isBg[i] = 1;
      stack.push(i);
    }
  };
  for (const i of border) tryPush(i);
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    if (x > 0) tryPush(i - 1);
    if (x < w - 1) tryPush(i + 1);
    if (i >= w) tryPush(i - w);
    if (i < w * (h - 1)) tryPush(i + w);
  }
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = isBg[i] ^ 1;
  return { mask, borderNoise };
}

/**
 * @param original pixel della foto (anche già ridotti)
 * @param size dimensioni reali della foto, se diverse dai pixel passati
 */
export function checkPhoto(original: Pixels, size?: { width: number; height: number }): PhotoCheck {
  const items: CheckItem[] = [];
  const minSide = Math.min(size?.width ?? original.width, size?.height ?? original.height);
  if (minSide < 256) {
    items.push({ level: "problema", code: "risoluzione", message: `Foto troppo piccola (${minSide}px): servono almeno 512px sul lato corto` });
  } else if (minSide < 512) {
    items.push({ level: "avviso", code: "risoluzione", message: `Risoluzione bassa (${minSide}px): i dettagli saranno poveri` });
  }

  const px = downscale(original, 512);
  const sharp = sharpness(px);
  if (sharp < 25) {
    items.push({ level: "problema", code: "sfocata", message: "Foto molto sfocata o mossa: rifalla con più luce e la mano ferma" });
  } else if (sharp < 70) {
    items.push({ level: "avviso", code: "sfocata", message: "Foto poco nitida: i dettagli fini potrebbero perdersi" });
  }

  let sum = 0, clip = 0;
  const n = px.width * px.height;
  for (let i = 0; i < n; i++) {
    const l = luma(px.data, i);
    sum += l;
    if (l > 250) clip++;
  }
  const meanLuma = sum / n;
  const clipped = clip / n;
  if (meanLuma < 45) items.push({ level: "avviso", code: "scura", message: "Foto scura: aggiungi luce diffusa, senza flash diretto" });
  if (meanLuma > 225) items.push({ level: "avviso", code: "chiara", message: "Foto sovraesposta: i colori della texture risulteranno slavati" });

  // inquadratura: affidabile solo con sfondo abbastanza uniforme
  const { mask, borderNoise } = maskFromPixels(px, 0.3);
  let coverage: number | null = null;
  let borderTouch: number | null = null;
  if (borderNoise > 38) {
    items.push({ level: "avviso", code: "sfondo", message: "Sfondo complesso: lo scontorno lo fa l'AI, ma su sfondo neutro e uniforme il risultato è più pulito" });
  } else {
    let fg = 0;
    for (let i = 0; i < mask.length; i++) fg += mask[i];
    coverage = fg / mask.length;
    // quanta parte del perimetro della foto è occupata dal soggetto
    const { width: w, height: h } = px;
    let touch = 0, per = 0;
    for (let x = 0; x < w; x++) { touch += mask[x] + mask[(h - 1) * w + x]; per += 2; }
    for (let y = 1; y < h - 1; y++) { touch += mask[y * w] + mask[y * w + w - 1]; per += 2; }
    borderTouch = touch / per;
    if (clipped > 0.04 && clipped / Math.max(coverage, 0.01) > 0.15) {
      items.push({ level: "avviso", code: "riflessi", message: "Riflessi forti sul soggetto: evita luce diretta, le zone bruciate diventano macchie" });
    }
    if (borderTouch > 0.04) {
      items.push({ level: "problema", code: "tagliato", message: "Il soggetto tocca il bordo: inquadralo intero, con un po' di margine" });
    } else if (coverage < 0.06) {
      items.push({ level: "avviso", code: "piccolo", message: "Soggetto piccolo nell'inquadratura: avvicinati o ritaglia la foto" });
    } else if (coverage > 0.85) {
      items.push({ level: "avviso", code: "vicino", message: "Soggetto troppo vicino: lascia un po' di sfondo attorno" });
    }
  }

  const level: CheckLevel = items.some((i) => i.level === "problema")
    ? "problema"
    : items.some((i) => i.level === "avviso") ? "avviso" : "ok";
  return { level, items, metrics: { minSide, sharpness: sharp, meanLuma, clipped, coverage, borderTouch, borderNoise } };
}

/** Lettura dei pixel da un canvas (solo browser), ridotti per l'analisi. */
export function pixelsFromCanvas(canvas: HTMLCanvasElement, max = 1024): Pixels {
  const s = Math.min(1, max / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * s));
  const h = Math.max(1, Math.round(canvas.height * s));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(canvas, 0, 0, w, h);
  return { data: ctx.getImageData(0, 0, w, h).data, width: w, height: h };
}
