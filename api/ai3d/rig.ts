// Auto-rigging con Tripo API v3:
//   rig-check  → il modello si può animare? che scheletro serve?
//   rig        → scheletro + pesi (v3 per i bipedi, v2.5 per le creature)
//   retarget   → applica fino a 5 animazioni, in GLB (e FBX se richiesto)
// Documentazione: https://developers.tripo3d.com/en/docs/animations-rig
import { download, fetchWithTimeout, isGlb, readJson, sleep, type ExternalJson } from "./net";
import { ProviderError, type ProgressFn } from "./types";
import {
  BIPED_ANIMATIONS,
  CREATURE_ANIMATION,
  MAX_ANIMATIONS,
  RIG_TYPES,
  RIG_TYPE_LABEL,
  type RigSpec,
  type RigType,
} from "@contracts/rig";

const BASE = process.env.TRIPO_API_BASE ?? "https://openapi.tripo3d.ai/v3";
const POLL_MS = 3000;
const MAX_WAIT_MS = 15 * 60 * 1000;

export const RIG_MODEL_BIPED = "v3.0-20260909";
export const RIG_MODEL_CREATURE = "v2.5-20260210";

export interface RigRequest {
  /** URL pubblico (firmato) del GLB da animare */
  modelUrl: string;
  /** preset scelti dal cliente (valgono per i bipedi) */
  animations: string[];
  spec: RigSpec;
  /** anche una copia FBX per Blender, Unreal, Unity */
  fbx: boolean;
}

export interface RigResult {
  glb: Buffer;
  fbx?: Buffer;
  rigType: RigType;
  animations: string[];
  credits: number;
}

export function rigAvailable(): boolean {
  return Boolean(process.env.TRIPO_API_KEY);
}

/** Corpo della richiesta di rig e animazioni da applicare, dato il tipo riconosciuto. */
export function planRig(
  rigType: RigType,
  requested: string[],
  spec: RigSpec,
): { rigBody: Record<string, unknown>; animations: string[] } {
  if (rigType === "biped") {
    const allowed = new Set<string>(BIPED_ANIMATIONS.map((a) => a.id));
    const animations = [...new Set(requested.filter((a) => allowed.has(a)))].slice(0, MAX_ANIMATIONS);
    return {
      rigBody: { model: RIG_MODEL_BIPED, rig_type: "biped", spec, out_format: "glb" },
      animations,
    };
  }
  const walk = CREATURE_ANIMATION[rigType];
  return {
    // `spec` vale solo per i bipedi: per le creature il motore lo ignora
    rigBody: { model: RIG_MODEL_CREATURE, rig_type: rigType, out_format: "glb" },
    animations: walk ? [walk] : [],
  };
}

function key(): string {
  return process.env.TRIPO_API_KEY ?? "";
}

function checkCode(json: ExternalJson) {
  if (json?.code !== undefined && json.code !== 0) {
    throw new ProviderError("tripo", `codice ${json.code}: ${json.message ?? "errore"}`);
  }
}

/** Crea un task Tripo e attende la fine; restituisce il task completato. */
async function runTask(
  path: string,
  body: Record<string, unknown>,
  onProgress: (p: number) => void,
  signal: AbortSignal,
): Promise<ExternalJson> {
  const created = await readJson("tripo", await fetchWithTimeout(`${BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, 60_000, signal));
  checkCode(created);
  const taskId: string | undefined = created?.data?.task_id;
  if (!taskId) throw new ProviderError("tripo", "task senza task_id");
  const start = Date.now();
  for (;;) {
    if (Date.now() - start > MAX_WAIT_MS) throw new ProviderError("tripo", "tempo massimo superato");
    await sleep(POLL_MS, signal);
    const json = await readJson("tripo", await fetchWithTimeout(`${BASE}/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${key()}` },
    }, 30_000, signal));
    checkCode(json);
    const task = json.data ?? {};
    const status: string = task.status ?? "unknown";
    if (status === "success") return { ...task, task_id: task.task_id ?? taskId };
    if (["failed", "cancelled", "banned", "expired"].includes(status)) {
      throw new ProviderError("tripo", `${path.split("/").pop()} ${status}${task.error_msg ? `: ${task.error_msg}` : ""}`);
    }
    onProgress(typeof task.progress === "number" ? task.progress : 0);
  }
}

function credits(task: ExternalJson): number {
  return typeof task?.credits_consumed === "number" ? task.credits_consumed : Number(task?.credits_consumed) || 0;
}

async function fetchOutput(task: ExternalJson, signal: AbortSignal): Promise<Buffer> {
  const url: string | undefined = task.output?.model_url ?? task.output?.model;
  if (!url) throw new ProviderError("tripo", "task riuscito ma senza file");
  return download("tripo", url, signal);
}

export async function rigWithTripo(req: RigRequest, onProgress: ProgressFn, signal: AbortSignal): Promise<RigResult> {
  let spent = 0;

  onProgress(3, "Controllo del modello");
  const check = await runTask("/animations/rig-check", { input: req.modelUrl }, (p) => onProgress(3 + p * 0.07, "Controllo del modello"), signal);
  spent += credits(check);
  const riggable = check.output?.riggable;
  const found = String(check.output?.rig_type ?? "biped");
  const rigType: RigType = (RIG_TYPES as readonly string[]).includes(found) ? (found as RigType) : "others";
  if (riggable === false) {
    throw new ProviderError(
      "tripo",
      "questo modello non si può animare: serve un personaggio o un animale con testa e arti ben separati",
    );
  }

  const plan = planRig(rigType, req.animations, req.spec);
  onProgress(12, `Scheletro: ${RIG_TYPE_LABEL[rigType]}`);
  const rig = await runTask("/animations/rig", { input: req.modelUrl, ...plan.rigBody }, (p) => onProgress(12 + p * 0.43, "Creazione dello scheletro"), signal);
  spent += credits(rig);
  const rigTaskId: string = rig.task_id;

  let glb: Buffer;
  let fbx: Buffer | undefined;
  if (plan.animations.length === 0) {
    // nessuna animazione disponibile: consegniamo il modello con lo scheletro
    onProgress(80, "Download del modello");
    glb = await fetchOutput(rig, signal);
    if (req.fbx) {
      const f = await runTask("/animations/retarget", { input: rigTaskId, animations: [], out_format: "fbx" }, () => undefined, signal).catch(() => null);
      if (f) {
        spent += credits(f);
        fbx = await fetchOutput(f, signal).catch(() => undefined);
      }
    }
  } else {
    // sul posto: il personaggio cammina senza spostarsi (anteprima, loop, motori di gioco)
    const base = { input: rigTaskId, animations: plan.animations, export_with_geometry: true, animate_in_place: true };
    const anim = await runTask("/animations/retarget", { ...base, out_format: "glb" }, (p) => onProgress(55 + p * 0.25, "Applicazione delle animazioni"), signal);
    spent += credits(anim);
    onProgress(82, "Download del modello animato");
    glb = await fetchOutput(anim, signal);
    if (req.fbx) {
      const f = await runTask("/animations/retarget", { ...base, out_format: "fbx" }, (p) => onProgress(84 + p * 0.1, "Copia FBX"), signal);
      spent += credits(f);
      fbx = await fetchOutput(f, signal);
    }
  }
  if (!isGlb(glb)) throw new ProviderError("tripo", "il file animato non è un GLB");
  return { glb, fbx, rigType, animations: plan.animations, credits: spent };
}
