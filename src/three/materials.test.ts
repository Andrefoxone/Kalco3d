import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { applyStyleToMaterials, DEFAULT_MATERIAL, type MaterialOriginal } from "./scene";
import { MATERIAL_PRESETS } from "@/lib/materialPresets";

/** materiale come lo produce GLTFLoader per un modello AI con PBR e ritaglio */
function aiMaterial() {
  const tex = () => new THREE.Texture();
  const m = new THREE.MeshStandardMaterial({
    map: tex(),
    normalMap: tex(),
    roughnessMap: tex(),
    metalnessMap: tex(),
    aoMap: tex(),
    metalness: 1,
    roughness: 1,
    alphaTest: 0.35,
    side: THREE.DoubleSide,
    color: new THREE.Color("#ffeedd"),
  });
  m.normalScale.set(0.8, 0.8);
  return m;
}

describe("applyStyleToMaterials", () => {
  it("il preset Foto conserva mappe PBR, ritaglio e valori originali", () => {
    const src = aiMaterial();
    const maps = { map: src.map, normalMap: src.normalMap, roughnessMap: src.roughnessMap, metalnessMap: src.metalnessMap, aoMap: src.aoMap };
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), src);
    const originals = new WeakMap<THREE.Material, MaterialOriginal>();
    applyStyleToMaterials(mesh, DEFAULT_MATERIAL, originals);
    const m = mesh.material as THREE.MeshPhysicalMaterial;
    expect(m).toBeInstanceOf(THREE.MeshPhysicalMaterial);
    expect(m.map).toBe(maps.map);
    expect(m.normalMap).toBe(maps.normalMap);
    expect(m.roughnessMap).toBe(maps.roughnessMap);
    expect(m.metalnessMap).toBe(maps.metalnessMap);
    expect(m.aoMap).toBe(maps.aoMap);
    expect(m.normalScale.x).toBeCloseTo(0.8);
    expect(m.alphaTest).toBeCloseTo(0.35); // il ritaglio dello sfondo resta
    expect(m.side).toBe(THREE.DoubleSide);
    expect(m.metalness).toBe(1); // non forzato a 0.02: la mappa conta davvero
    expect(m.roughness).toBe(1);
    expect(m.color.getHexString()).toBe("ffeedd");
    expect(m.defines).toMatchObject({ PHYSICAL: "" }); // clearcoat/transmission attivi
  });

  it("dopo un preset colorato, tornare a Foto ripristina tutto", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), aiMaterial());
    const originals = new WeakMap<THREE.Material, MaterialOriginal>();
    const oro = MATERIAL_PRESETS.find((p) => p.id === "oro")!.style;
    const foto = MATERIAL_PRESETS.find((p) => p.id === "foto")!.style;
    applyStyleToMaterials(mesh, oro, originals);
    let m = mesh.material as THREE.MeshPhysicalMaterial;
    expect(m.map).toBeNull();
    expect(m.roughness).toBeCloseTo(0.32);
    applyStyleToMaterials(mesh, foto, originals);
    m = mesh.material as THREE.MeshPhysicalMaterial;
    expect(m.map).not.toBeNull();
    expect(m.roughness).toBe(1);
    expect(m.color.getHexString()).toBe("ffeedd");
    expect(m.roughnessMap).not.toBeNull();
  });

  it("vetro attiva la trasmissione", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), aiMaterial());
    applyStyleToMaterials(mesh, MATERIAL_PRESETS.find((p) => p.id === "vetro")!.style, new WeakMap());
    expect((mesh.material as THREE.MeshPhysicalMaterial).transmission).toBe(1);
  });
});
