// Dal modello nel viewport ai dati per la stampa: triangoli in coordinate
// mondo e colore per triangolo, campionato dalla texture (o dal colore del
// materiale/vertici). Si stampa ciò che si vede, preset di materiale inclusi.
import * as THREE from "three";
import type { PrintInput } from "./pipeline";

interface Pixels {
  data: Uint8ClampedArray;
  w: number;
  h: number;
}

const pixelCache = new WeakMap<THREE.Texture, Pixels | null>();

function texturePixels(tex: THREE.Texture): Pixels | null {
  if (pixelCache.has(tex)) return pixelCache.get(tex)!;
  let px: Pixels | null = null;
  try {
    const img = tex.image as (CanvasImageSource & { width: number; height: number }) | undefined;
    if (img && img.width > 0 && img.height > 0 && typeof document !== "undefined") {
      // 1024 px bastano per il colore medio di un triangolo
      const s = Math.min(1, 1024 / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * s));
      const h = Math.max(1, Math.round(img.height * s));
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0, w, h);
      px = { data: ctx.getImageData(0, 0, w, h).data, w, h };
    }
  } catch {
    px = null; // texture compresse o non leggibili: si usa il colore del materiale
  }
  pixelCache.set(tex, px);
  return px;
}

function sample(px: Pixels, tex: THREE.Texture, u: number, v: number): [number, number, number] {
  const uv = new THREE.Vector2(u, v);
  tex.transformUv(uv); // ripetizione, offset e flipY come nel rendering
  const x = Math.min(px.w - 1, Math.max(0, Math.floor(uv.x * px.w)));
  const y = Math.min(px.h - 1, Math.max(0, Math.floor(uv.y * px.h)));
  const i = (y * px.w + x) * 4;
  return [px.data[i] / 255, px.data[i + 1] / 255, px.data[i + 2] / 255];
}

export function extractPrintInput(root: THREE.Object3D): PrintInput | null {
  root.updateMatrixWorld(true);
  const soup: number[] = [];
  const colors: number[] = [];
  const v = new THREE.Vector3();
  const lin = new THREE.Color();
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh) || !obj.visible) return;
    const geom = obj.geometry as THREE.BufferGeometry;
    const pos = geom.getAttribute("position");
    if (!pos) return;
    const uvAttr = geom.getAttribute("uv");
    const colAttr = geom.getAttribute("color");
    const index = geom.index;
    const triCount = index ? index.count / 3 : pos.count / 3;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    const groups = geom.groups.length ? geom.groups : [{ start: 0, count: triCount * 3, materialIndex: 0 }];
    for (const g of groups) {
      const mat = mats[g.materialIndex ?? 0] as THREE.MeshStandardMaterial;
      const map = mat?.map ?? null;
      // i colori per vertice contano solo se il materiale li usa (come nel rendering)
      const vc = mat?.vertexColors ? colAttr : undefined;
      const px = map && uvAttr ? texturePixels(map) : null;
      // colore del materiale in sRGB (three lo tiene lineare)
      const base = mat?.color ? lin.copy(mat.color).convertLinearToSRGB() : lin.setRGB(0.8, 0.8, 0.8);
      const br = base.r, bg = base.g, bb = base.b;
      for (let k = g.start; k < Math.min(g.start + g.count, triCount * 3); k += 3) {
        let r = 0, gg = 0, b = 0;
        let cu = 0, cv = 0;
        for (let c = 0; c < 3; c++) {
          const vi = index ? index.getX(k + c) : k + c;
          v.fromBufferAttribute(pos, vi).applyMatrix4(obj.matrixWorld);
          soup.push(v.x, v.y, v.z);
          if (uvAttr) {
            cu += uvAttr.getX(vi) / 3;
            cv += uvAttr.getY(vi) / 3;
          }
          if (vc) {
            const c3 = new THREE.Color(vc.getX(vi), vc.getY(vi), vc.getZ(vi)).convertLinearToSRGB();
            r += c3.r / 3; gg += c3.g / 3; b += c3.b / 3;
          }
        }
        if (!vc) {
          r = 1; gg = 1; b = 1;
        }
        if (px && map) {
          const [tr, tg, tb] = sample(px, map, cu, cv);
          r *= tr; gg *= tg; b *= tb;
        }
        colors.push(r * br, gg * bg, b * bb);
      }
    }
  });
  if (soup.length === 0) return null;
  return { soup: Float32Array.from(soup), triColor: Float32Array.from(colors) };
}
