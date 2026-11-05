// Scelta dei motori e dei parametri per qualità × destinazione.
// Funzioni pure: tutta la "ricetta" di qualità del servizio sta qui ed è testata.
import type { ProviderId, Quality, Target, View } from "./types";

// ---------------------------------------------------------------------------
// Ordine dei motori: il primo disponibile vince, gli altri sono ripiego
// automatico se il primo fallisce (crediti finiti, errore, timeout).
// ---------------------------------------------------------------------------

const ORDER: Record<Quality, Record<Target, ProviderId[]>> = {
  bozza: {
    // bozza = veloce ed economica: TRELLIS.2 se c'è, poi Tripo, poi Meshy lite
    ecommerce: ["fal-trellis", "tripo", "meshy", "fal-hunyuan"],
    stampa: ["fal-trellis", "tripo", "meshy", "fal-hunyuan"],
    render: ["fal-trellis", "tripo", "meshy", "fal-hunyuan"],
    gioco: ["tripo", "meshy", "fal-trellis", "fal-hunyuan"],
  },
  standard: {
    ecommerce: ["tripo", "meshy", "fal-hunyuan", "rodin"],
    stampa: ["tripo", "fal-hunyuan", "meshy", "rodin"],
    render: ["tripo", "meshy", "rodin", "fal-hunyuan"],
    gioco: ["tripo", "meshy", "rodin", "fal-hunyuan"],
  },
  pro: {
    // Rodin e Meshy hanno le texture migliori; per la stampa conta la
    // geometria: Tripo "detailed"
    ecommerce: ["rodin", "meshy", "tripo", "fal-hunyuan"],
    stampa: ["tripo", "fal-hunyuan", "meshy", "rodin"],
    render: ["rodin", "meshy", "tripo", "fal-hunyuan"],
    gioco: ["tripo", "meshy", "rodin", "fal-hunyuan"],
  },
};

const MAX_VIEWS: Record<ProviderId, number> = {
  tripo: 4,
  meshy: 4,
  rodin: 4,
  "fal-hunyuan": 4,
  "fal-trellis": 1,
};

/**
 * Motori da tentare, in ordine. Con più foto si escludono i motori a foto
 * singola: buttare via le viste extra che il cliente ha scattato sarebbe peggio.
 */
export function planProviders(
  quality: Quality,
  target: Target,
  viewCount: number,
  available: ReadonlySet<ProviderId>,
): ProviderId[] {
  return ORDER[quality][target].filter((p) => available.has(p) && MAX_VIEWS[p] >= viewCount);
}

// ---------------------------------------------------------------------------
// Tripo (API v3)
// ---------------------------------------------------------------------------

export const TRIPO_H = "v3.1-20260211";
export const TRIPO_P2 = "P2-20260801";

export interface TripoBody {
  path: "/generation/image-to-model" | "/generation/multiview-to-model";
  body: Record<string, unknown>;
}

/** inputs: token/URL per vista (front obbligatoria). */
export function tripoRequest(
  quality: Quality,
  target: Target,
  inputs: Partial<Record<View, string>>,
): TripoBody {
  const views = Object.entries(inputs).filter(([, v]) => Boolean(v)) as [View, string][];
  const multi = views.length > 1;
  const isGame = target === "gioco";
  const body: Record<string, unknown> = {
    model: isGame ? TRIPO_P2 : TRIPO_H,
    export_uv: true,
  };

  if (target === "stampa") {
    // per la stampa serve solo la forma: niente texture (costa meno) e dimensioni reali
    body.texture = false;
    body.pbr = false;
    body.auto_size = true;
    if (quality === "pro") body.geometry_quality = "detailed";
  } else {
    body.texture = true;
    body.pbr = true;
    body.texture_alignment = "original_image";
  }

  if (target === "ecommerce") {
    // leggero per web e AR, in scala reale (in AR l'oggetto appare alle sue misure)
    body.auto_size = true;
    body.texture_quality = quality === "bozza" ? "standard" : "detailed";
    body.face_limit = { bozza: 40_000, standard: 80_000, pro: 150_000 }[quality];
  } else if (target === "render") {
    body.texture_quality = { bozza: "standard", standard: "detailed", pro: "extreme" }[quality];
    if (quality === "pro") body.geometry_quality = "detailed";
  } else if (isGame) {
    // P2: topologia pulita e pochi poligoni, pronta per i motori di gioco
    body.texture_quality = quality === "pro" ? "detailed" : "standard";
    body.face_limit = { bozza: 5_000, standard: 12_000, pro: 30_000 }[quality];
  }

  if (multi) {
    return {
      path: "/generation/multiview-to-model",
      body: { ...body, inputs: views.map(([view, value]) => ({ [view]: value })) },
    };
  }
  return { path: "/generation/image-to-model", body: { ...body, input: inputs.front } };
}

// ---------------------------------------------------------------------------
// Rodin (Hyper3D, API v2) — campi multipart
// ---------------------------------------------------------------------------

export function rodinFields(quality: Quality, target: Target, viewCount: number): Record<string, string> {
  const fields: Record<string, string> = {
    tier: "Gen-2",
    geometry_file_format: "glb",
    quality: { bozza: "low", standard: "medium", pro: "high" }[quality],
    material: target === "stampa" ? "Shaded" : "PBR",
    mesh_mode: target === "gioco" ? "Quad" : "Raw",
  };
  // più foto dello stesso oggetto: vanno fuse in un unico modello
  if (viewCount > 1) fields.condition_mode = "concat";
  return fields;
}

// ---------------------------------------------------------------------------
// fal.ai — Hunyuan3D 3.1 Pro e TRELLIS.2
// ---------------------------------------------------------------------------

export const FAL_HUNYUAN = "fal-ai/hunyuan-3d/v3.1/pro/image-to-3d";
export const FAL_TRELLIS = "fal-ai/trellis-2";

export function falHunyuanInput(
  quality: Quality,
  target: Target,
  urls: Partial<Record<View, string>>,
): Record<string, unknown> {
  const faceCount: Record<Target, Record<Quality, number>> = {
    ecommerce: { bozza: 60_000, standard: 120_000, pro: 200_000 },
    stampa: { bozza: 300_000, standard: 600_000, pro: 1_200_000 },
    render: { bozza: 200_000, standard: 500_000, pro: 1_000_000 },
    gioco: { bozza: 40_000, standard: 40_000, pro: 60_000 },
  };
  const input: Record<string, unknown> = {
    input_image_url: urls.front,
    generate_type: target === "stampa" ? "Geometry" : "Normal",
    face_count: faceCount[target][quality],
    enable_pbr: target !== "stampa",
  };
  if (urls.back) input.back_image_url = urls.back;
  if (urls.left) input.left_image_url = urls.left;
  if (urls.right) input.right_image_url = urls.right;
  return input;
}

export function falTrellisInput(urls: Partial<Record<View, string>>): Record<string, unknown> {
  return { image_url: urls.front };
}


// ---------------------------------------------------------------------------
// Meshy (API v1) — https://docs.meshy.ai
// ---------------------------------------------------------------------------

export interface MeshyRequest {
  path: "/openapi/v1/image-to-3d" | "/openapi/v1/multi-image-to-3d";
  body: Record<string, unknown>;
}

/** urls: data URI o URL pubblici, la frontale per prima. */
export function meshyRequest(quality: Quality, target: Target, urls: string[]): MeshyRequest {
  const multi = urls.length > 1;
  const body: Record<string, unknown> = {
    // bozza: modello "lite" (più rapido ed economico); altrimenti il più recente
    ai_model: quality === "bozza" ? "meshy-6-lite" : "latest",
    topology: "triangle",
  };
  if (target === "stampa") {
    body.should_texture = false;
  } else {
    body.should_texture = true;
    body.enable_pbr = true;
  }
  const polys: Record<Target, Record<Quality, number | null>> = {
    ecommerce: { bozza: 40_000, standard: 80_000, pro: 150_000 },
    stampa: { bozza: null, standard: null, pro: null },
    render: { bozza: null, standard: null, pro: null },
    gioco: { bozza: 5_000, standard: 12_000, pro: 30_000 },
  };
  const p = polys[target][quality];
  if (p !== null) {
    body.should_remesh = true;
    body.target_polycount = p;
  } else if (quality !== "bozza") {
    // senza rimesh la qualità è massima (consiglio della documentazione Meshy)
    body.should_remesh = false;
  }
  if (multi) {
    return { path: "/openapi/v1/multi-image-to-3d", body: { ...body, image_urls: urls.slice(0, 4) } };
  }
  return { path: "/openapi/v1/image-to-3d", body: { ...body, image_url: urls[0] } };
}
