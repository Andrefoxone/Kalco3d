import { afterEach, describe, expect, it, vi } from "vitest";
import { buildImagePrompt, generateImages } from "./imageGen";
import { imageCreditCost } from "@contracts/billing";

describe("immagini da testo", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("il prompt chiede un oggetto unico, intero, su fondo neutro", () => {
    const p = buildImagePrompt("  un   gatto rosso che dorme ", "statuina", true);
    expect(p.startsWith("un gatto rosso che dorme.")).toBe(true);
    expect(p).toMatch(/one single object/);
    expect(p).toMatch(/seamless studio background/);
    expect(p).toMatch(/no thin fragile parts/);
    expect(buildImagePrompt("vaso", "realistico", false)).not.toMatch(/fragile/);
  });

  it("costo: 1 credito ogni 2 immagini", () => {
    expect([1, 2, 3, 4].map(imageCreditCost)).toEqual([1, 1, 2, 2]);
  });

  it("conta le immagini fallite senza perdere quelle riuscite", async () => {
    process.env.FAL_KEY = "test";
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      n++;
      if (n === 2) return new Response(JSON.stringify({ detail: "boom" }), { status: 500 });
      return new Response(JSON.stringify({ images: [{ url: "data:image/jpeg;base64,AAAA" }] }), { status: 200 });
    }));
    const out = await generateImages("lampada", "realistico", false, 3);
    expect(out.images).toHaveLength(2);
    expect(out.failed).toBe(1);
    expect(out.lastError).toMatch(/500/);
  });
});
