import { describe, expect, it } from "vitest";
import { getManifold } from "../print/manifold";
import { estimate, findOverhangs, fitsVolume, layerPaths, machineById, numberPieces, sliceLayers, toGcode, zigzag } from "./engine";
import { splitToPlate } from "../print/solid";

describe("Building", () => {
  it("muro in cemento: strati, doppio perimetro, zig-zag, preventivo e G-code", async () => {
    const w = await getManifold();
    // muro dritto 3 m × 30 cm × 60 cm
    const wall = w.Manifold.cube([3000, 300, 600], false);
    const m = machineById("cemento-portale");
    const { layers, total, step } = await sliceLayers(wall, m.layerMm);
    expect(total).toBe(40);
    expect(step).toBe(1);
    const paths = layers.map((l) => ({ ...l, ...layerPaths(l.section, m, l.index) }));
    // 2 perimetri chiusi per strato, zig-zag dentro
    expect(paths[0].perimeters).toHaveLength(2);
    expect(paths[0].infill.length).toBeGreaterThan(0);
    // lo zig-zag resta dentro la parete interna
    for (const s of paths[0].infill) for (const [x, y] of s) {
      expect(x).toBeGreaterThan(70);
      expect(x).toBeLessThan(2930);
      expect(y).toBeGreaterThan(70);
      expect(y).toBeLessThan(230);
    }
    const e = estimate(paths, m);
    // volume depositato vicino al volume pieno del muro (0,54 m³), mai oltre
    expect(e.volumeM3).toBeGreaterThan(0.25);
    expect(e.volumeM3).toBeLessThan(0.6);
    expect(e.kg).toBeCloseTo(e.volumeM3 * 2200, 3);
    expect(e.hours).toBeGreaterThan(0);
    const g = toGcode(paths, m, { name: "muro", origin: [0, 0, 0] });
    expect(g).toMatch(/^; Kalco3D Building/);
    expect(g).toContain("G21");
    expect(g).not.toMatch(/ E\d/); // cemento: niente asse E
    expect((g.match(/; strato /g) ?? []).length).toBe(40);
  });

  it("riconosce uno sbalzo oltre il limite della malta", async () => {
    const w = await getManifold();
    // colonna con una mensola a sbalzo a metà altezza
    const col = w.Manifold.cube([400, 400, 1000], false);
    const shelf = w.Manifold.cube([1200, 400, 200], false).translate([0, 0, 500]);
    const m = machineById("cemento-portale");
    const { layers } = await sliceLayers(col.add(shelf), m.layerMm);
    const ov = findOverhangs(layers, m);
    expect(ov.length).toBeGreaterThan(0);
    expect(Math.abs(ov[0].z - 500)).toBeLessThan(20);
    expect(ov[0].areaMm2).toBeGreaterThan(200_000);
  });

  it("serpentina continua in un rettangolo", async () => {
    const w = await getManifold();
    const rect = new w.CrossSection([[[0, 0], [100, 0], [100, 40], [0, 40]]]);
    const lines = zigzag(rect, 10, 0);
    expect(lines).toHaveLength(1); // tutte le righe unite
    expect(lines[0].length).toBe(8); // 4 righe × 2 punti
  });

  it("scultura più grande della stampante: pezzi numerati dal basso", async () => {
    const w = await getManifold();
    const big = w.Manifold.sphere(2000, 48); // Ø 4 m
    const m = machineById("pellet-robot");
    expect(fitsVolume(big, m)).toBe(false);
    const split = splitToPlate(w, big, m.volume, true);
    const pcs = numberPieces(w, split.pieces);
    expect(pcs.length).toBeGreaterThan(4);
    expect(pcs[0].index).toBe(1);
    for (const p of pcs) {
      expect(p.size[0]).toBeLessThanOrEqual(m.volume.x);
      expect(p.size[2]).toBeLessThanOrEqual(m.volume.z);
    }
    expect(pcs[0].min[2]).toBeLessThanOrEqual(pcs[pcs.length - 1].min[2]);
  });

  it("pellet: G-code con asse E volumetrico", async () => {
    const w = await getManifold();
    const m = machineById("pellet-robot");
    const { layers } = await sliceLayers(w.Manifold.cylinder(30, 100, 100, 64), m.layerMm);
    const paths = layers.map((l) => ({ ...l, ...layerPaths(l.section, m, l.index) }));
    expect(toGcode(paths, m, { name: "vaso", origin: [-100, -100, 0] })).toMatch(/G1 X[\d.]+ Y[\d.]+ E[\d.]+/);
  });
});
