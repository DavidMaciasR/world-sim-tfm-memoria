import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import os from "os";
import path from "path";

// BD temporal: la telemetría de producción escribe al importar db.ts.
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "usage-")), "t.db");
process.env.GEMINI_API_KEY = "test";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { CountryAgent } = require("../../country-agent");

function fakeGemini(text: string) {
  return async () =>
    new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 25, totalTokenCount: 175 },
    }), { status: 200 });
}

test("onUsage recibe el consumo de cada respuesta, también la que no se puede parsear", async () => {
  const events: any[] = [];
  const agent: any = new CountryAgent(undefined, { geminiModel: "test-model", onUsage: (e: any) => events.push(e) });
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = fakeGemini('{"move":"x"}') as any;
    await agent.fetchGeminiAnalysis("s", "u", "test-model", { country: "Russia", simYear: 2015 });
    globalThis.fetch = fakeGemini('{"move":"x","newTerritoryZone":{"zoneKey":"Area-3541235412354123') as any; // cortada por el tope
    await assert.rejects(agent.fetchGeminiAnalysis("s", "u", "test-model", { country: "Russia", simYear: 2016 }), /No JSON/);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(events.length, 2);
  assert.equal(events[0].status, "success");
  assert.equal(events[0].inputTokens, 100);
  assert.equal(events[0].thoughtsTokens, 25);
  assert.equal(events[1].status, "error");
  assert.equal(events[1].outputTokens, 50); // se pagó aunque fallara
  assert.match(events[1].error, /No JSON/);
});

test("el límite de tiempo corta una llamada colgada", async () => {
  const agent: any = new CountryAgent(undefined, { geminiModel: "test-model", requestTimeoutMs: 50 });
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((_u: string, init: any) =>
    new Promise((_r, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)))) as any;
  // En una llamada real la conexión mantiene vivo el proceso; aquí lo hace este temporizador.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(agent.fetchGeminiAnalysis("s", "u", "test-model", { country: "Germany", simYear: 2017 }), /timeout|aborted/i);
  } finally {
    clearTimeout(keepAlive);
    globalThis.fetch = realFetch;
  }
});
