// Test del pipeline DXF → geometria three.js (Node, senza browser).
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { cadFormatFromName, parseDxfText } from "./cadImport";

const FIXTURE = `0
SECTION
2
TABLES
0
TABLE
2
LAYER
70
2
0
LAYER
2
Muri
70
0
62
1
6
CONTINUOUS
0
LAYER
2
Arredi
70
0
62
3
6
CONTINUOUS
0
ENDTAB
0
ENDSEC
0
SECTION
2
BLOCKS
0
BLOCK
8
0
2
Sedia
70
0
10
0.0
20
0.0
30
0.0
0
CIRCLE
8
0
10
5.0
20
5.0
40
2.0
0
ENDBLK
0
ENDSEC
0
SECTION
2
ENTITIES
0
LINE
8
Muri
10
0.0
20
0.0
11
100.0
21
0.0
0
LWPOLYLINE
8
Arredi
70
1
90
3
10
10.0
20
10.0
10
20.0
20
10.0
42
0.5
10
20.0
20
20.0
0
ARC
8
Muri
10
50.0
20
50.0
40
10.0
50
0.0
51
90.0
0
3DFACE
8
Arredi
10
0.0
20
0.0
30
0.0
11
10.0
21
0.0
31
5.0
12
10.0
22
10.0
32
5.0
13
0.0
23
10.0
33
0.0
0
INSERT
8
0
2
Sedia
10
30.0
20
30.0
50
45.0
0
TEXT
8
0
10
1.0
20
1.0
1
Ciao
0
ENDSEC
0
EOF
`;

describe("cadFormatFromName", () => {
  it("riconosce le estensioni supportate", () => {
    expect(cadFormatFromName("disegno.DWG")).toBe("dwg");
    expect(cadFormatFromName("parte.stp")).toBe("step");
    expect(cadFormatFromName("parte.STEP")).toBe("step");
    expect(cadFormatFromName("assy.igs")).toBe("iges");
    expect(cadFormatFromName("scan.stl")).toBe("stl");
    expect(cadFormatFromName("foto.png")).toBeNull();
  });
});

describe("parseDxfText", () => {
  it("converte entità 2D e 3D in linee e mesh", () => {
    const { object, stats, skipped } = parseDxfText(FIXTURE);
    expect(stats).toContain("entità");
    // testo ignorato e conteggiato
    expect(skipped.join(" ")).toContain("1 testi");

    let lines: THREE.LineSegments | null = null;
    let mesh: THREE.Mesh | null = null;
    for (const child of object.children) {
      if (child instanceof THREE.LineSegments) lines = child;
      if (child instanceof THREE.Mesh) mesh = child;
    }
    expect(lines).not.toBeNull();
    expect(mesh).not.toBeNull();

    // LINE(1) + LWPOLYLINE chiusa con bulge + ARC + CIRCLE nel blocco INSERT
    const segCount = lines!.geometry.getAttribute("position").count / 2;
    expect(segCount).toBeGreaterThan(20);
    // colori per vertice dai layer ACI (Muri=rosso, Arredi=verde)
    expect(lines!.geometry.getAttribute("color").count).toBe(
      lines!.geometry.getAttribute("position").count,
    );
    // 3DFACE → 2 triangoli = 6 vertici
    expect(mesh!.geometry.getAttribute("position").count).toBe(6);
    // rotazione Z-up → Y-up applicata al gruppo
    expect(object.rotation.x).toBeCloseTo(-Math.PI / 2);
  });

  it("il bulge della polilinea diventa un arco dal lato giusto", () => {
    const { object } = parseDxfText(FIXTURE);
    let lines: THREE.LineSegments | null = null;
    object.traverse((o) => {
      if (o instanceof THREE.LineSegments) lines = o as THREE.LineSegments;
    });
    const pos = lines!.geometry.getAttribute("position");
    // tratto (20,10)→(20,20) con bulge 0.5: arco antiorario, sporge a destra
    // della marcia (x > 20) di bulge·corda/2 = 2.5 → fino a x = 22.5
    let maxX = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      if (y > 10.01 && y < 19.99) maxX = Math.max(maxX, pos.getX(i));
    }
    expect(maxX).toBeGreaterThan(22.4);
    expect(maxX).toBeLessThan(22.6);
  });

  it("rifiuta un DXF senza geometrie", () => {
    expect(() => parseDxfText("0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n")).toThrow(
      /spazio modello/,
    );
  });
});

function dxf(entities: string): string {
  return `0\nSECTION\n2\nENTITIES\n${entities.trim()}\n0\nENDSEC\n0\nEOF\n`;
}

function allPoints(object: THREE.Object3D): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  object.traverse((o) => {
    if (o instanceof THREE.LineSegments || o instanceof THREE.Mesh) {
      const pos = o.geometry.getAttribute("position");
      for (let i = 0; i < pos.count; i++) pts.push(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)));
    }
  });
  return pts;
}

describe("geometrie DXF corrette", () => {
  it("ARC: gli angoli (già in radianti dal parser) danno l'arco giusto", () => {
    // arco centro (50,50) r=10 da 0° a 90°: deve arrivare a (50,60)
    const { object } = parseDxfText(dxf("0\nARC\n8\n0\n10\n50\n20\n50\n40\n10\n50\n0\n51\n90"));
    const pts = allPoints(object);
    const reachesTop = pts.some((p) => Math.abs(p.x - 50) < 0.01 && Math.abs(p.y - 60) < 0.01);
    const startsRight = pts.some((p) => Math.abs(p.x - 60) < 0.01 && Math.abs(p.y - 50) < 0.01);
    expect(startsRight).toBe(true);
    expect(reachesTop).toBe(true);
    // un quarto di cerchio: nessun punto nel semipiano sinistro
    expect(pts.every((p) => p.x >= 49.99)).toBe(true);
  });

  it("SOLID: le aree piene diventano triangoli", () => {
    const solid = "0\nSOLID\n8\n0\n10\n0\n20\n0\n11\n10\n21\n0\n12\n0\n22\n10\n13\n10\n23\n10";
    const { object } = parseDxfText(dxf(solid));
    let tris = 0;
    object.traverse((o) => {
      if (o instanceof THREE.Mesh) tris += o.geometry.getAttribute("position").count / 3;
    });
    expect(tris).toBe(2);
  });

  it("polilinea chiusa: anche l'ultimo tratto con bulge è un arco", () => {
    // quadrato 10×10 con l'ultimo lato (0,10)→(0,0) curvo (bulge 1 = semicerchio)
    const poly = "0\nLWPOLYLINE\n8\n0\n90\n4\n70\n1\n10\n0\n20\n0\n10\n10\n20\n0\n10\n10\n20\n10\n10\n0\n20\n10\n42\n1";
    const { object } = parseDxfText(dxf(poly));
    const minX = Math.min(...allPoints(object).map((p) => p.x));
    expect(minX).toBeLessThan(-4); // il semicerchio sporge a sinistra di ~5
  });
});
