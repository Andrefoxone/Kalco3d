import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { components, edt2, inkMask, maskToSection, wallMask, wallsSoup, type Mask } from "./plan";
import { getManifold } from "../print/manifold";

function rect(m: Mask, x0: number, y0: number, x1: number, y1: number) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m.data[y * m.w + x] = 1;
}

describe("pianta → muri", () => {
  it("distanza euclidea esatta", () => {
    const m: Mask = { w: 5, h: 1, data: new Uint8Array([1, 0, 0, 0, 0]) };
    expect([...edt2(m, 1)]).toEqual([0, 1, 4, 9, 16]);
  });

  it("tiene i muri spessi, cancella linee sottili e lascia il varco della porta", async () => {
    const m: Mask = { w: 200, h: 120, data: new Uint8Array(200 * 120) };
    rect(m, 10, 10, 190, 22); // muro in alto, 12 px
    rect(m, 10, 98, 80, 110); // muro in basso, sinistra
    rect(m, 110, 98, 190, 110); // muro in basso, destra (varco 80–110 = porta)
    rect(m, 10, 10, 22, 110); // muro a sinistra
    rect(m, 178, 10, 190, 110); // muro a destra
    rect(m, 40, 50, 160, 51); // linea sottile (mobile) da togliere
    rect(m, 80, 100, 110, 101); // anta della porta, sottile
    const walls = wallMask(m, 4);
    expect(walls.data[50 * 200 + 100]).toBe(0);
    expect(walls.data[104 * 200 + 95]).toBe(0); // varco aperto
    expect(walls.data[15 * 200 + 100]).toBe(1);
    const { labels, list } = components(walls);
    expect(list).toHaveLength(1); // un solo muro a C
    const w = await getManifold();
    const cs = maskToSection(w, labels, 200, 120, new Set([1]), 50); // 1 px = 5 cm
    const b = cs.bounds();
    expect(b.max[0] - b.min[0]).toBeCloseTo(180 * 50, -2);
    expect(cs.area()).toBeGreaterThan(0);
    const soup = wallsSoup(cs, 2700);
    let maxY = -Infinity;
    for (let i = 1; i < soup.length; i += 3) maxY = Math.max(maxY, soup[i]);
    expect(maxY).toBeCloseTo(2700, 3);
  });

  const real = "/tmp/claude-0/-home-claude/c0b33a88-238d-58ed-b3ed-efd4fe0a9107/scratchpad/pianta/pianta.rgba";
  it.skipIf(!existsSync(real))("pianta vera: muri principali trovati", async () => {
    const rgba = new Uint8ClampedArray(readFileSync(real));
    const ink = inkMask(rgba, 1276, 1642);
    const walls = wallMask(ink, 5);
    const { list } = components(walls);
    const big = list.filter((c) => c.area > 1276 * 1642 * 0.002).sort((a, b) => b.area - a.area);
    const share = walls.data.reduce((s, v) => s + v, 0) / walls.data.length;
    expect(share).toBeGreaterThan(0.09);
    expect(share).toBeLessThan(0.16);
    expect(big.length).toBeGreaterThanOrEqual(5);
    // i muri grandi coprono quasi tutta la larghezza della pianta
    expect(Math.max(...big.map((c) => c.x1)) - Math.min(...big.map((c) => c.x0))).toBeGreaterThan(1000);
    if (process.env.DUMP_PLAN) (await import("node:fs")).writeFileSync(process.env.DUMP_PLAN, walls.data);
  });
});
