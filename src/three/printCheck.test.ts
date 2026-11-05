import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { analyzePrintability, stlToPrintSpace, suggestedLongestMm } from "./printCheck";

describe("analyzePrintability", () => {
  it("una sfera (con cucitura UV) è chiusa", () => {
    const r = analyzePrintability(new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16)));
    expect(r.openEdges).toBe(0);
    expect(r.watertight).toBe(true);
  });
  it("un cubo con facce separate (vertici duplicati) è chiuso", () => {
    const r = analyzePrintability(new THREE.Mesh(new THREE.BoxGeometry(1, 2, 3)));
    expect(r.watertight).toBe(true);
    expect(r.size.z).toBeCloseTo(3);
  });
  it("un piano o un cilindro aperto hanno buchi", () => {
    expect(analyzePrintability(new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 4, 4))).openEdges).toBe(16);
    const tube = analyzePrintability(new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 2, 24, 1, true)));
    expect(tube.watertight).toBe(false);
    expect(tube.openEdges).toBe(48);
  });
});

describe("stlToPrintSpace", () => {
  it("Z in alto, in millimetri, appoggiato sul piano", () => {
    // colonna alta 4 (asse Y di three), larga 1
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 4, 1));
    const stl = new STLExporter().parse(mesh, { binary: true }) as DataView;
    const out = new DataView(stlToPrintSpace(stl.buffer as ArrayBuffer, 120));
    const n = out.getUint32(80, true);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let t = 0; t < n; t++) {
      for (let k = 0; k < 3; k++) {
        for (let a = 0; a < 3; a++) {
          const val = out.getFloat32(84 + t * 50 + 12 + k * 12 + a * 4, true);
          min[a] = Math.min(min[a], val);
          max[a] = Math.max(max[a], val);
        }
      }
    }
    expect(max[2] - min[2]).toBeCloseTo(120, 3); // l'altezza ora è su Z
    expect(min[2]).toBeCloseTo(0, 4); // appoggiato sul piano
    expect(max[0] - min[0]).toBeCloseTo(30, 3);
    expect((min[0] + max[0]) / 2).toBeCloseTo(0, 4); // centrato
    expect(new TextDecoder().decode(new Uint8Array(out.buffer, 0, 22))).toBe("Kalco3D - mm, Z-up, la");
  });
  it("le normali restano coerenti con l'orientamento delle facce", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
    const stl = new STLExporter().parse(mesh, { binary: true }) as DataView;
    const out = new DataView(stlToPrintSpace(stl.buffer as ArrayBuffer, 50));
    const n = out.getUint32(80, true);
    for (let t = 0; t < n; t++) {
      const b = 84 + t * 50;
      const nrm = new THREE.Vector3(out.getFloat32(b, true), out.getFloat32(b + 4, true), out.getFloat32(b + 8, true));
      const p = [0, 1, 2].map((k) => new THREE.Vector3(
        out.getFloat32(b + 12 + k * 12, true), out.getFloat32(b + 16 + k * 12, true), out.getFloat32(b + 20 + k * 12, true),
      ));
      const geo = new THREE.Vector3().crossVectors(p[1].clone().sub(p[0]), p[2].clone().sub(p[0])).normalize();
      expect(geo.dot(nrm)).toBeGreaterThan(0.99);
    }
  });
});

describe("suggestedLongestMm", () => {
  it("usa le misure reali solo se plausibili", () => {
    expect(suggestedLongestMm(0.25)).toBe(250);
    expect(suggestedLongestMm(2)).toBe(2000);
    expect(suggestedLongestMm(40)).toBe(100);
    expect(suggestedLongestMm(null)).toBe(100);
  });
});
