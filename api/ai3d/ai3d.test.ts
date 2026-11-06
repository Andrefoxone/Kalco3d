import { afterEach, describe, expect, it, vi } from "vitest";
import {
  falHunyuanInput,
  meshyRequest,
  planProviders,
  rodinFields,
  tripoRequest,
  TRIPO_H,
  TRIPO_P2,
} from "./plan";
import { findGlbUrl } from "./net";
import { generateWithFallback } from "./index";
import { tripoProvider } from "./providers/tripo";
import { meshyProvider } from "./providers/meshy";
import { ProviderError, type Provider, type ProviderId } from "./types";

const ALL = new Set<ProviderId>(["tripo", "meshy", "rodin", "fal-hunyuan", "fal-trellis"]);

/** GLB minimo valido (header + JSON vuoto) */
function tinyGlb(): Buffer {
  const json = Buffer.from(JSON.stringify({ asset: { version: "2.0" } }).padEnd(32, " "));
  const b = Buffer.alloc(12 + 8 + json.length);
  b.writeUInt32LE(0x46546c67, 0); b.writeUInt32LE(2, 4); b.writeUInt32LE(b.length, 8);
  b.writeUInt32LE(json.length, 12); b.writeUInt32LE(0x4e4f534a, 16); json.copy(b, 20);
  return b;
}

const img = (view: "front" | "left" | "back" | "right") => ({ view, data: Buffer.from([0xff, 0xd8, 0, 0]), mime: "image/jpeg" as const });

describe("planProviders", () => {
  it("bozza preferisce il motore economico, pro il migliore", () => {
    expect(planProviders("bozza", "ecommerce", 1, ALL)[0]).toBe("fal-trellis");
    expect(planProviders("pro", "ecommerce", 1, ALL)[0]).toBe("rodin");
    expect(planProviders("pro", "stampa", 1, ALL)[0]).toBe("tripo");
    expect(planProviders("standard", "gioco", 1, ALL)[0]).toBe("tripo");
  });
  it("con più foto esclude i motori a foto singola", () => {
    const order = planProviders("bozza", "ecommerce", 3, ALL);
    expect(order).not.toContain("fal-trellis");
    expect(order[0]).toBe("tripo");
  });
  it("salta i motori senza chiave", () => {
    const order = planProviders("pro", "render", 1, new Set<ProviderId>(["meshy", "tripo"]));
    expect(order).toEqual(["meshy", "tripo"]);
  });
});

describe("tripoRequest", () => {
  it("stampa: colori della foto (senza PBR), misure reali, geometria dettagliata in pro", () => {
    const { path, body } = tripoRequest("pro", "stampa", { front: "file_a" });
    expect(path).toBe("/generation/image-to-model");
    expect(body).toMatchObject({ model: TRIPO_H, texture: true, pbr: false, texture_alignment: "original_image", auto_size: true, geometry_quality: "detailed", input: "file_a" });
  });
  it("e-commerce: PBR, leggero per AR, in scala reale", () => {
    const { body } = tripoRequest("standard", "ecommerce", { front: "f" });
    expect(body).toMatchObject({ pbr: true, auto_size: true, texture_quality: "detailed", face_limit: 80_000 });
  });
  it("gioco: modello P2 low-poly entro i limiti API (≤ 50.000 facce)", () => {
    for (const q of ["bozza", "standard", "pro"] as const) {
      const { body } = tripoRequest(q, "gioco", { front: "f" });
      expect(body.model).toBe(TRIPO_P2);
      expect(body.face_limit as number).toBeLessThanOrEqual(50_000);
      expect(body).not.toHaveProperty("geometry_quality"); // non supportato da P
    }
  });
  it("più viste: endpoint multiview con chiavi per vista", () => {
    const { path, body } = tripoRequest("standard", "render", { front: "a", back: "b", left: "c" });
    expect(path).toBe("/generation/multiview-to-model");
    expect(body.inputs).toEqual([{ front: "a" }, { back: "b" }, { left: "c" }]);
    expect(body).not.toHaveProperty("input");
  });
});

describe("altri motori", () => {
  it("Rodin: fonde più foto e usa quad solo per il gioco", () => {
    expect(rodinFields("pro", "render", 3)).toMatchObject({ tier: "Gen-2", quality: "high", condition_mode: "concat", mesh_mode: "Raw" });
    expect(rodinFields("bozza", "gioco", 1)).not.toHaveProperty("condition_mode");
    expect(rodinFields("bozza", "gioco", 1).mesh_mode).toBe("Quad");
  });
  it("Hunyuan: stampa con colori (senza PBR), viste extra passate", () => {
    const i = falHunyuanInput("pro", "stampa", { front: "F", back: "B" });
    expect(i).toMatchObject({ input_image_url: "F", back_image_url: "B", generate_type: "Normal", enable_pbr: false });
    expect(i.face_count as number).toBeLessThanOrEqual(1_500_000);
  });
});

describe("findGlbUrl", () => {
  it("trova il GLB nelle forme di risposta note", () => {
    expect(findGlbUrl({ model_glb: { url: "https://x/a.glb" } })).toBe("https://x/a.glb");
    expect(findGlbUrl({ model_mesh: { url: "https://x/file", content_type: "model/gltf-binary" } })).toBe("https://x/file");
    expect(findGlbUrl({ a: [{ b: "https://cdn/x.glb?sig=1" }] })).toBe("https://cdn/x.glb?sig=1");
    expect(findGlbUrl({ image: "https://x/a.png" })).toBeNull();
  });
});

describe("generateWithFallback", () => {
  const fake = (id: ProviderId, ok: boolean, calls: string[]): Provider => ({
    id, label: id, maxViews: 4, available: () => true,
    async generate() {
      calls.push(id);
      if (!ok) throw new ProviderError(id, "crediti esauriti");
      return { glb: tinyGlb(), provider: id, providerModel: "m" };
    },
  });

  it("se il primo motore fallisce passa al successivo", async () => {
    const calls: string[] = [];
    const reg = {
      tripo: fake("tripo", false, calls), meshy: fake("meshy", true, calls), rodin: fake("rodin", true, calls),
      "fal-hunyuan": fake("fal-hunyuan", true, calls), "fal-trellis": fake("fal-trellis", true, calls)
    };
    const r = await generateWithFallback({ images: [img("front")], quality: "standard", target: "render" }, () => {}, new AbortController().signal, reg);
    expect(calls).toEqual(["tripo", "meshy"]);
    expect(r.provider).toBe("meshy");
    expect(r.attempts).toEqual([{ provider: "tripo", error: "crediti esauriti" }]);
  });

  it("se falliscono tutti, l'errore elenca ogni tentativo", async () => {
    const calls: string[] = [];
    const reg = {
      tripo: fake("tripo", false, calls), meshy: fake("meshy", false, calls), rodin: fake("rodin", false, calls),
      "fal-hunyuan": fake("fal-hunyuan", false, calls), "fal-trellis": fake("fal-trellis", false, calls)
    };
    await expect(
      generateWithFallback({ images: [img("front")], quality: "pro", target: "stampa" }, () => {}, new AbortController().signal, reg),
    ).rejects.toThrow(/tripo: crediti esauriti · fal-hunyuan: crediti esauriti · meshy: crediti esauriti · rodin/);
  });
});

describe("tripoProvider (server finto)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("upload → task multiview → polling → download", async () => {
    vi.stubEnv("TRIPO_API_KEY", "tsk_test");
    const glb = tinyGlb();
    const seen: { url: string; body?: unknown }[] = [];
    let polls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      seen.push({ url, body });
      expect((init?.headers as Record<string, string> | undefined)?.Authorization ?? "Bearer tsk_test").toBe("Bearer tsk_test");
      if (url.endsWith("/files")) return Response.json({ code: 0, data: { file_token: `tok${seen.length}` } });
      if (url.endsWith("/generation/multiview-to-model")) return Response.json({ code: 0, data: { task_id: "T1" } });
      if (url.endsWith("/tasks/T1")) {
        polls++;
        return polls < 2
          ? Response.json({ code: 0, data: { status: "running", progress: 40 } })
          : Response.json({ code: 0, data: { status: "success", progress: 100, credits_consumed: 30, output: { model_url: "https://cdn/m.glb" } } });
      }
      if (url === "https://cdn/m.glb") return new Response(new Uint8Array(glb));
      throw new Error(`url inattesa ${url}`);
    }));
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 500 });
    const progress: number[] = [];
    const p = tripoProvider.generate(
      { images: [img("front"), img("back")], quality: "standard", target: "ecommerce" },
      (pct) => progress.push(pct),
      new AbortController().signal,
    );
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.provider).toBe("tripo");
    expect(r.providerCredits).toBe(30);
    expect(r.glb.equals(glb)).toBe(true);
    const task = seen.find((s) => s.url.endsWith("multiview-to-model"))!;
    expect((task.body as { inputs: unknown[] }).inputs).toHaveLength(2);
    expect(progress.some((x) => x > 5 && x < 90)).toBe(true);
  });

  it("codice di errore Tripo → ProviderError leggibile", async () => {
    vi.stubEnv("TRIPO_API_KEY", "k");
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url.endsWith("/files")
        ? Response.json({ code: 2010, message: "insufficient credits" })
        : Response.json({}),
    ));
    await expect(
      tripoProvider.generate({ images: [img("front")], quality: "bozza", target: "gioco" }, () => {}, new AbortController().signal),
    ).rejects.toThrow(/2010: insufficient credits/);
  });
});

describe("Meshy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("parametri: stampa con colori senza PBR, gioco low-poly, più foto sull'endpoint multi", () => {
    expect(meshyRequest("pro", "stampa", ["a"]).body).toMatchObject({ should_texture: true, enable_pbr: false, ai_model: "latest", should_remesh: false, image_url: "a" });
    expect(meshyRequest("bozza", "gioco", ["a"]).body).toMatchObject({ ai_model: "meshy-6-lite", should_remesh: true, target_polycount: 5000 });
    const m = meshyRequest("standard", "ecommerce", ["f", "b", "l"]);
    expect(m.path).toBe("/openapi/v1/multi-image-to-3d");
    expect(m.body).toMatchObject({ image_urls: ["f", "b", "l"], enable_pbr: true, target_polycount: 80_000 });
    expect((meshyRequest("pro", "gioco", ["a"]).body.target_polycount as number)).toBeLessThanOrEqual(300_000);
  });

  it("giro completo con server finto", async () => {
    vi.stubEnv("MESHY_API_KEY", "msy_test");
    const glb = tinyGlb();
    let polls = 0;
    let sentBody: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/openapi/v1/image-to-3d") && init?.method === "POST") {
        sentBody = JSON.parse(String(init.body));
        return Response.json({ result: "M1" });
      }
      if (url.endsWith("/openapi/v1/image-to-3d/M1")) {
        polls++;
        return polls < 2
          ? Response.json({ status: "IN_PROGRESS", progress: 50 })
          : Response.json({ status: "SUCCEEDED", progress: 100, consumed_credits: 20, model_urls: { glb: "https://assets.meshy/m.glb" } });
      }
      if (url === "https://assets.meshy/m.glb") return new Response(new Uint8Array(glb));
      throw new Error(`url inattesa ${url}`);
    }));
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 500 });
    const p = meshyProvider.generate({ images: [img("front")], quality: "standard", target: "render" }, () => {}, new AbortController().signal);
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.provider).toBe("meshy");
    expect(r.providerCredits).toBe(20);
    expect(String(sentBody.image_url)).toMatch(/^data:image\/jpeg;base64,/);
  });
});
