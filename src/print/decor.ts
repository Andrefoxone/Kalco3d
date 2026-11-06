// Testo e loghi come geometria vera: l'AI disegna male le scritte, quindi le
// costruiamo noi da font e SVG e le mettiamo sulla base, davanti al modello,
// in rilievo o incise. Contorni 2D → CrossSection di Manifold → estrusione.
import { parse as parseFont, type Font } from "opentype.js";
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader.js";
import type { CrossSection, ManifoldToplevel } from "manifold-3d";

export type FontId = "moderno" | "classico" | "corsivo";
export type DecorMode = "rilievo" | "incisione";

export interface DecorOptions {
  text: string;
  font: FontId;
  /** SVG del logo (solo forme piene) */
  logoSvg?: string | null;
  mode: DecorMode;
  /** altezza del rilievo o profondità dell'incisione, mm */
  depthMm?: number;
  /** colore: "base" = come la base, "contrasto" = filamento in più */
  color?: "base" | "contrasto";
}

type Ring = [number, number][];

// ---------------------------------------------------------------------------
// Font
// ---------------------------------------------------------------------------

const fontCache = new Map<FontId, Promise<Font>>();

async function fontUrl(id: FontId): Promise<string> {
  if (id === "classico") return (await import("@fontsource/playfair-display/files/playfair-display-latin-700-normal.woff?url")).default;
  if (id === "corsivo") return (await import("@fontsource/pacifico/files/pacifico-latin-400-normal.woff?url")).default;
  return (await import("@fontsource/montserrat/files/montserrat-latin-800-normal.woff?url")).default;
}

/** Carica il font; in test si può passare il file direttamente. */
export function loadFont(id: FontId, data?: ArrayBuffer): Promise<Font> {
  if (data) return Promise.resolve(parseFont(data));
  let p = fontCache.get(id);
  if (!p) {
    p = fontUrl(id).then(async (url) => parseFont(await (await fetch(url)).arrayBuffer()));
    p.catch(() => fontCache.delete(id));
    fontCache.set(id, p);
  }
  return p;
}

/** Curve di Bézier → spezzate, con y verso l'alto. */
export function textRings(font: Font, text: string, sizeMm = 10): Ring[] {
  const path = font.getPath(text, 0, 0, sizeMm);
  const rings: Ring[] = [];
  let cur: Ring = [];
  let x = 0, y = 0;
  const STEPS = 8;
  const push = (px: number, py: number) => cur.push([px, -py]);
  for (const c of path.commands) {
    if (c.type === "M") {
      if (cur.length > 2) rings.push(cur);
      cur = [];
      x = c.x; y = c.y;
      push(x, y);
    } else if (c.type === "L") {
      x = c.x; y = c.y;
      push(x, y);
    } else if (c.type === "Q") {
      for (let i = 1; i <= STEPS; i++) {
        const t = i / STEPS, u = 1 - t;
        push(u * u * x + 2 * u * t * c.x1 + t * t * c.x, u * u * y + 2 * u * t * c.y1 + t * t * c.y);
      }
      x = c.x; y = c.y;
    } else if (c.type === "C") {
      for (let i = 1; i <= STEPS; i++) {
        const t = i / STEPS, u = 1 - t;
        push(
          u * u * u * x + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x,
          u * u * u * y + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y,
        );
      }
      x = c.x; y = c.y;
    } else if (c.type === "Z") {
      if (cur.length > 2) rings.push(cur);
      cur = [];
    }
  }
  if (cur.length > 2) rings.push(cur);
  return rings;
}

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

/** Forme piene di un SVG → sezioni (y verso l'alto). Le linee senza riempimento si ignorano. */
export function svgSection(w: ManifoldToplevel, svg: string): CrossSection | null {
  const data = new SVGLoader().parse(svg);
  const parts: CrossSection[] = [];
  for (const p of data.paths) {
    const fill = (p.userData?.style as { fill?: string } | undefined)?.fill;
    if (fill === "none" || fill === "transparent") continue;
    for (const shape of SVGLoader.createShapes(p)) {
      const { shape: outer, holes } = shape.extractPoints(12);
      if (outer.length < 3) continue;
      const rings: Ring[] = [outer.map((v) => [v.x, -v.y] as [number, number]), ...holes.map((h) => h.map((v) => [v.x, -v.y] as [number, number]))];
      parts.push(new w.CrossSection(rings, "EvenOdd"));
    }
  }
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0] : w.CrossSection.union(parts);
}

// ---------------------------------------------------------------------------
// Composizione: logo sopra, testo sotto, centrati sull'origine
// ---------------------------------------------------------------------------

export function decorSection(w: ManifoldToplevel, font: Font | null, opts: DecorOptions): CrossSection | null {
  const pieces: CrossSection[] = [];
  const text = opts.text.trim();
  let textCs: CrossSection | null = null;
  if (text && font) {
    textCs = new w.CrossSection(textRings(font, text, 10), "NonZero");
    if (textCs.isEmpty()) textCs = null;
  }
  let logoCs = opts.logoSvg ? svgSection(w, opts.logoSvg) : null;
  if (logoCs?.isEmpty()) logoCs = null;
  if (!textCs && !logoCs) return null;

  const center = (cs: CrossSection) => {
    const b = cs.bounds();
    return cs.translate([-(b.min[0] + b.max[0]) / 2, -(b.min[1] + b.max[1]) / 2]);
  };
  if (textCs) textCs = center(textCs);
  if (logoCs) {
    logoCs = center(logoCs);
    // il logo alto quanto 1,6 volte il testo (o 10 mm da solo)
    const lb = logoCs.bounds();
    const target = textCs ? (textCs.bounds().max[1] - textCs.bounds().min[1]) * 1.6 : 10;
    const lh = lb.max[1] - lb.min[1] || 1;
    logoCs = logoCs.scale(target / lh);
  }
  if (textCs && logoCs) {
    const th = textCs.bounds().max[1] - textCs.bounds().min[1];
    const lh = logoCs.bounds().max[1] - logoCs.bounds().min[1];
    const gap = th * 0.35;
    pieces.push(logoCs.translate([0, (th + gap) / 2]), textCs.translate([0, -(lh + gap) / 2]));
    return center(w.CrossSection.union(pieces));
  }
  return textCs ?? logoCs;
}

/** Scala la sezione per stare in un rettangolo largo maxW e alto maxH. */
export function fitSection(cs: CrossSection, maxW: number, maxH: number): CrossSection {
  const b = cs.bounds();
  const wdt = b.max[0] - b.min[0] || 1, hgt = b.max[1] - b.min[1] || 1;
  return cs.scale(Math.min(maxW / wdt, maxH / hgt));
}
