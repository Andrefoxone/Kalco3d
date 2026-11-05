import { describe, expect, it } from "vitest";
import { checkPhoto, sharpness, type Pixels } from "./photoCheck";

/** Foto sintetica: sfondo grigio chiaro, soggetto a scacchi (nitido) in un riquadro. */
function scene(opts: { w?: number; h?: number; box?: [number, number, number, number]; blur?: number; bg?: (x: number, y: number) => number } = {}): Pixels {
  const w = opts.w ?? 800, h = opts.h ?? 800;
  const [bx0, by0, bx1, by1] = opts.box ?? [0.3, 0.3, 0.7, 0.7];
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inBox = x >= bx0 * w && x < bx1 * w && y >= by0 * h && y < by1 * h;
      const v = opts.bg ? opts.bg(x, y) : 225;
      let r = v, g = v, b = v;
      if (inBox) {
        const chk = ((x >> 3) + (y >> 3)) % 2;
        r = chk ? 180 : 60; g = chk ? 90 : 30; b = chk ? 40 : 20;
      }
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  let px: Pixels = { data, width: w, height: h };
  for (let k = 0; k < (opts.blur ?? 0); k++) px = boxBlur(px);
  return px;
}

function boxBlur(px: Pixels): Pixels {
  const { width: w, height: h, data } = px;
  const out = new Uint8ClampedArray(data.length);
  const R = 4;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) {
    let s = 0, n = 0;
    for (let d = -R; d <= R; d++) { const xx = Math.min(w - 1, Math.max(0, x + d)); s += data[(y * w + xx) * 4 + c]; n++; }
    out[(y * w + x) * 4 + c] = s / n;
  }
  const out2 = new Uint8ClampedArray(data.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) {
    let s = 0, n = 0;
    for (let d = -R; d <= R; d++) { const yy = Math.min(h - 1, Math.max(0, y + d)); s += out[(yy * w + x) * 4 + c]; n++; }
    out2[(y * w + x) * 4 + c] = s / n;
  }
  return { data: out2, width: w, height: h };
}

describe("checkPhoto", () => {
  it("foto buona: nessun problema", () => {
    const r = checkPhoto(scene());
    expect(r.level).toBe("ok");
    expect(r.items).toEqual([]);
    expect(r.metrics.coverage!).toBeGreaterThan(0.1);
  });
  it("sfocata: la nitidezza crolla e scatta l'avviso", () => {
    const sharp = sharpness(scene({ w: 400, h: 400 }));
    const blurred = sharpness(scene({ w: 400, h: 400, blur: 3 }));
    expect(blurred).toBeLessThan(sharp / 5);
    const r = checkPhoto(scene({ w: 400, h: 400, blur: 3 }));
    expect(r.items.map((i) => i.code)).toContain("sfocata");
  });
  it("soggetto tagliato dal bordo → problema", () => {
    const r = checkPhoto(scene({ box: [0.4, 0.2, 1.0, 0.8] }));
    expect(r.level).toBe("problema");
    expect(r.items.map((i) => i.code)).toContain("tagliato");
  });
  it("soggetto minuscolo → avviso", () => {
    const r = checkPhoto(scene({ box: [0.45, 0.45, 0.55, 0.55] }));
    expect(r.items.map((i) => i.code)).toContain("piccolo");
  });
  it("risoluzione troppo bassa → problema", () => {
    const r = checkPhoto(scene({ w: 200, h: 180 }));
    expect(r.items.find((i) => i.code === "risoluzione")?.level).toBe("problema");
  });
  it("usa le dimensioni reali se i pixel sono ridotti", () => {
    const r = checkPhoto(scene({ w: 400, h: 400 }), { width: 3000, height: 2000 });
    expect(r.metrics.minSide).toBe(2000);
    expect(r.items.find((i) => i.code === "risoluzione")).toBeUndefined();
  });
  it("sfondo complesso: niente falsi allarmi sull'inquadratura, solo un consiglio", () => {
    const r = checkPhoto(scene({ bg: (x, y) => ((x * 7 + y * 13) % 97) * 2.5 }));
    const codes = r.items.map((i) => i.code);
    expect(codes).toContain("sfondo");
    expect(codes).not.toContain("tagliato");
  });
});
