import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildGenerateBody,
  MarbleError,
  parseExport,
  parseWorld,
  pickHqSpz,
  pickSpz,
  progressOf,
  startGeneration,
  waitOperation,
} from "./marble";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("buildGenerateBody", () => {
  it("testo: prompt pulito, modello della qualità, scena privata", () => {
    const body = buildGenerateBody({ kind: "testo", text: "  cortile   di una masseria  " }, "standard", "Masseria");
    expect(body).toMatchObject({
      model: "marble-1.1",
      display_name: "Masseria",
      permission: { public: false },
      world_prompt: { type: "text", text_prompt: "cortile di una masseria" },
    });
  });
  it("foto: immagine in base64 con estensione, testo facoltativo", () => {
    const img = Buffer.from([0xff, 0xd8, 1, 2]);
    const body = buildGenerateBody({ kind: "foto", image: img, ext: "jpg" }, "bozza", "Prova") as {
      model: string;
      world_prompt: Record<string, unknown>;
    };
    expect(body.model).toBe("marble-1.0-draft");
    expect(body.world_prompt).toEqual({
      type: "image",
      image_prompt: { source: "data_base64", data_base64: img.toString("base64"), extension: "jpg" },
      is_pano: "auto",
    });
  });
  it("grande usa marble-1.1-plus; il nome resta entro 64 caratteri", () => {
    const body = buildGenerateBody({ kind: "testo", text: "una piazza" }, "grande", "x".repeat(90)) as { model: string; display_name: string };
    expect(body.model).toBe("marble-1.1-plus");
    expect(body.display_name).toHaveLength(64);
  });
  it("testo vuoto: errore per il cliente", () => {
    expect(() => buildGenerateBody({ kind: "testo", text: "   " }, "standard", "a")).toThrow(MarbleError);
  });
});

describe("risultato", () => {
  it("pickSpz preferisce 500k, poi full_res, poi qualsiasi", () => {
    expect(pickSpz({ "100k": "a", "500k": "b", full_res: "c" })).toEqual({ key: "500k", url: "b" });
    expect(pickSpz({ "100k": "a", full_res: "c" })).toEqual({ key: "full_res", url: "c" });
    expect(pickSpz({ altro: "z" })).toEqual({ key: "altro", url: "z" });
    expect(pickSpz(null)).toBeNull();
  });
  it("parseWorld legge file, scala metrica e pavimento", () => {
    const w = parseWorld({
      world_id: "w1",
      world_marble_url: "https://marble.worldlabs.ai/world/w1",
      caption: "Una stanza luminosa",
      thumbnail_url: "https://cdn/t.jpg",
      assets: {
        splats: { spz_urls: { "500k": "https://cdn/500k.spz" }, semantics_metadata: { metric_scale_factor: 1.7, ground_plane_offset: 0.4 } },
        mesh: { collider_mesh_url: "https://cdn/c.glb" },
        imagery: { pano_url: "https://cdn/p.png" },
      },
    });
    expect(w).toMatchObject({
      worldId: "w1",
      spzUrl: "https://cdn/500k.spz",
      spzResolution: "500k",
      colliderUrl: "https://cdn/c.glb",
      panoUrl: "https://cdn/p.png",
      thumbUrl: "https://cdn/t.jpg",
      metricScale: 1.7,
      groundOffset: 0.4,
    });
  });
  it("alta qualità: full_res accanto alla versione leggera da 500k", () => {
    expect(pickHqSpz({ "500k": "a", full_res: "b" }, "500k")).toEqual({ key: "full_res", url: "b" });
    expect(pickHqSpz({ full_res: "b" }, "full_res")).toBeNull();
    const w = parseWorld({ world_id: "w", assets: { splats: { spz_urls: { "100k": "s", "500k": "m", full_res: "l" } } } });
    expect(w).toMatchObject({ spzUrl: "m", spzHqUrl: "l", spzHqResolution: "full_res", spzResolutions: ["100k", "500k", "full_res"] });
  });
  it("parseWorld senza metadati: scala 1, pavimento 0", () => {
    const w = parseWorld({ world_id: "w", assets: { splats: { spz_urls: { full_res: "u" } } } });
    expect(w.metricScale).toBe(1);
    expect(w.groundOffset).toBe(0);
    expect(w.colliderUrl).toBeNull();
  });
  it("parseWorld senza SPZ: errore", () => {
    expect(() => parseWorld({ world_id: "w", assets: {} })).toThrow(/SPZ/);
  });
  it("parseExport restituisce l'URL della mesh", () => {
    expect(parseExport({ asset_type: "mesh", format: "glb", url: "https://cdn/m.glb" })).toBe("https://cdn/m.glb");
    expect(() => parseExport({})).toThrow(MarbleError);
  });
  it("progressOf accetta frazioni e percentuali", () => {
    expect(progressOf({ metadata: { progress: 0.5 } })).toBe(50);
    expect(progressOf({ metadata: { progress: 40 } })).toBe(40);
    expect(progressOf({ metadata: {} })).toBeNull();
  });
});

describe("chiamate", () => {
  it("startGeneration manda la chiave nell'header WLT-Api-Key", async () => {
    vi.stubEnv("WORLDLABS_API_KEY", "k123");
    const fetchMock = vi.fn(async () => jsonResponse(200, { operation_id: "op_1", done: false }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(startGeneration({ model: "marble-1.1" }, new AbortController().signal)).resolves.toBe("op_1");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.worldlabs.ai/marble/v1/worlds:generate");
    expect((init.headers as Record<string, string>)["WLT-Api-Key"]).toBe("k123");
  });
  it("402: messaggio chiaro sui crediti API", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(402, { detail: "Payment Required" })));
    await expect(startGeneration({}, new AbortController().signal)).rejects.toThrow(/crediti API esauriti/);
  });
  it("waitOperation interroga finché done e riporta l'avanzamento", async () => {
    const replies = [
      { operation_id: "op", done: false, metadata: { progress: 0.3 } },
      { operation_id: "op", done: true, response: { world_id: "w" } },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, replies.shift())));
    const seen: number[] = [];
    const out = await waitOperation("op", (p) => seen.push(p), new AbortController().signal, 60_000, 1);
    expect(out).toEqual({ world_id: "w" });
    expect(seen).toEqual([30]);
  });
  it("waitOperation: rifiuto per contenuto = errore per il cliente", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { operation_id: "op", done: true, error: { code: 400, message: "Content policy violation" } })));
    const err = await waitOperation("op", () => undefined, new AbortController().signal, 60_000, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MarbleError);
    expect((err as MarbleError).userFacing).toBe(true);
  });
});
