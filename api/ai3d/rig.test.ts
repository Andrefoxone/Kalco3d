import { afterEach, describe, expect, it, vi } from "vitest";
import { planRig, rigWithTripo, RIG_MODEL_BIPED, RIG_MODEL_CREATURE } from "./rig";
import { rigCreditCost, animationLabel } from "@contracts/rig";

function tinyGlb(): Buffer {
  const json = Buffer.from(JSON.stringify({ asset: { version: "2.0" } }).padEnd(32, " "));
  const b = Buffer.alloc(12 + 8 + json.length);
  b.writeUInt32LE(0x46546c67, 0); b.writeUInt32LE(2, 4); b.writeUInt32LE(b.length, 8);
  b.writeUInt32LE(json.length, 12); b.writeUInt32LE(0x4e4f534a, 16); json.copy(b, 20);
  return b;
}

describe("planRig", () => {
  it("bipede: modello v3, spec scelta, solo preset validi, max 5 senza doppioni", () => {
    const p = planRig("biped", ["preset:idle", "preset:idle", "preset:walk", "boh", "preset:run", "preset:jump", "preset:turn", "preset:fall"], "unreal");
    expect(p.rigBody).toMatchObject({ model: RIG_MODEL_BIPED, rig_type: "biped", spec: "unreal" });
    expect(p.animations).toEqual(["preset:idle", "preset:walk", "preset:run", "preset:jump", "preset:turn"]);
  });
  it("quadrupede: modello creature, niente spec, camminata da quadrupede", () => {
    const p = planRig("quadruped", ["preset:idle"], "mixamo");
    expect(p.rigBody).toMatchObject({ model: RIG_MODEL_CREATURE, rig_type: "quadruped" });
    expect(p.rigBody.spec).toBeUndefined();
    expect(p.animations).toEqual(["preset:quadruped:walk"]);
  });
  it("uccello: solo scheletro", () => {
    expect(planRig("avian", ["preset:walk"], "tripo").animations).toEqual([]);
  });
});

describe("costi e nomi", () => {
  it("FBX costa di più, e il prezzo resta sopra 2x il motore", () => {
    expect(rigCreditCost(true)).toBeGreaterThan(rigCreditCost(false));
    expect(rigCreditCost(false)).toBeGreaterThanOrEqual(7);
  });
  it("etichette italiane dai nomi delle clip", () => {
    expect(animationLabel("preset:walk")).toBe("Cammina");
    expect(animationLabel("idle")).toBe("Fermo");
    expect(animationLabel("preset:quadruped:walk")).toBe("Cammina");
  });
});

describe("rigWithTripo", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TRIPO_API_KEY;
  });

  function mockTripo(checkOutput: Record<string, unknown>) {
    process.env.TRIPO_API_KEY = "k";
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    let n = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push({ path: new URL(url).pathname, body: JSON.parse(String(init.body)) });
        n++;
        return new Response(JSON.stringify({ code: 0, data: { task_id: `t${n}` } }));
      }
      if (url.includes("/tasks/")) {
        const id = url.split("/").pop()!;
        const output = id === "t1" ? checkOutput : { model_url: `https://cdn.example/${id}.bin` };
        return new Response(JSON.stringify({ code: 0, data: { task_id: id, status: "success", output, credits_consumed: 10 } }));
      }
      return new Response(new Uint8Array(tinyGlb()));
    });
    vi.stubGlobal("fetch", fetchMock);
    return posts;
  }

  it("check → rig → retarget GLB e FBX, animazioni sul posto", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1000 });
    const posts = mockTripo({ riggable: true, rig_type: "biped" });
    const res = await rigWithTripo(
      { modelUrl: "https://x/m.glb", animations: ["preset:walk"], spec: "mixamo", fbx: true },
      () => undefined,
      new AbortController().signal,
    );
    vi.useRealTimers();
    expect(posts.map((p) => p.path)).toEqual(["/v3/animations/rig-check", "/v3/animations/rig", "/v3/animations/retarget", "/v3/animations/retarget"]);
    expect(posts[1].body).toMatchObject({ input: "https://x/m.glb", rig_type: "biped", spec: "mixamo" });
    expect(posts[2].body).toMatchObject({ input: "t2", animations: ["preset:walk"], out_format: "glb", animate_in_place: true });
    expect(posts[3].body.out_format).toBe("fbx");
    expect(res.rigType).toBe("biped");
    expect(res.fbx).toBeDefined();
    expect(res.credits).toBe(40);
  }, 30_000);

  it("modello non animabile: errore chiaro, nessun rig pagato", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1000 });
    const posts = mockTripo({ riggable: false, rig_type: "others" });
    await expect(
      rigWithTripo({ modelUrl: "https://x/m.glb", animations: [], spec: "tripo", fbx: false }, () => undefined, new AbortController().signal),
    ).rejects.toThrow(/non si può animare/);
    vi.useRealTimers();
    expect(posts).toHaveLength(1);
  }, 30_000);
});
