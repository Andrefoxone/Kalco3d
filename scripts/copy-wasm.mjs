// Copia i file WASM delle librerie CAD in public/wasm a ogni build.
// Così il .wasm servito corrisponde sempre alla versione JS installata:
// un .wasm vecchio con un JS nuovo (o viceversa) rompe l'import a runtime.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve("node_modules");
const out = path.resolve("public/wasm");
mkdirSync(out, { recursive: true });
const files = [
  ["@mlightcad/libredwg-web/wasm/libredwg-web.wasm", "libredwg-web.wasm"],
  ["occt-import-js/dist/occt-import-js.wasm", "occt-import-js.wasm"],
  ["manifold-3d/manifold.wasm", "manifold.wasm"],
];
for (const [rel, name] of files) {
  const src = path.join(root, rel);
  if (!existsSync(src)) {
    console.error(`wasm mancante: ${src} (hai eseguito npm install?)`);
    process.exit(1);
  }
  copyFileSync(src, path.join(out, name));
  console.log(`wasm: ${name}`);
}
