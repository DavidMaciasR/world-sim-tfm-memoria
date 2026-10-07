import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import os from "os";
import path from "path";
import { bar, eta, fmtMinutes, generatorSpendEur, judgeSpendEur, render, runProgress } from "./progress";

function writeJsonl(file: string, rows: object[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

test("runProgress cuenta claves aceptadas una vez y los juicios con nota ≤3", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runs-"));
  writeJsonl(path.join(dir, "memory-v1-dev-a1g-r1", "records.jsonl"), [
    { key: "Germany:2015", status: "error" },
    { key: "Germany:2015", status: "ok" },
    { key: "France:2015", status: "ok" },
  ]);
  writeJsonl(path.join(dir, "memory-v1-dev-a1g-r1", "coherence-judge", "judgments.jsonl"), [
    { key: "Germany:2015", status: "structural_na" },
    { key: "Germany:2016", status: "ok", verdict: { score: 3 } },
    { key: "France:2016", status: "ok", verdict: { score: 5 } },
  ]);
  const [plana, estructurada] = runProgress(dir, "dev");
  assert.equal(plana.generated, 2);
  assert.equal(plana.expectedGenerations, 30);
  assert.equal(plana.judged, 2);
  assert.equal(plana.expectedJudgments, 27);
  assert.equal(plana.lowScores, 1);
  assert.equal(estructurada.generated, 0);
});

test("el gasto del juez suma el usage de todas las tiradas del estudio y nada más", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runs-"));
  const usage = { inputTokens: 1_000_000, outputTokens: 0 };
  writeJsonl(path.join(dir, "memory-v1-pilot-a1-r1", "coherence-judge", "judgments.jsonl"), [{ usage }]);
  writeJsonl(path.join(dir, "memory-v1-dev-a1-r1", "coherence-judge", "judgments.jsonl"), [{ usage }]);
  writeJsonl(path.join(dir, "memory-v1-dev-a1-r1", "coherence-judge-v1-20260924", "judgments.jsonl"), [{ usage }]);
  writeJsonl(path.join(dir, "_aborted", "coherence-judge", "judgments.jsonl"), [{ usage }]);
  // 3 M tokens de entrada a 3 $/M = 9 $ (la pasada archivada también se pagó)
  assert.ok(Math.abs(judgeSpendEur(dir) - 9 * 0.86) < 1e-9);
});

test("el razonamiento del generador se factura a precio de salida", () => {
  const eur = generatorSpendEur([{ inputTokens: 0, outputTokens: 500_000, thoughtsTokens: 500_000 }]);
  assert.ok(Math.abs(eur - 7.5 * 0.86) < 1e-9);
});

test("render y bar muestran avance, gasto y techo", () => {
  assert.match(bar(5, 10, 10), /\[█████░░░░░\]  50%/);
  const out = render(
    "dev",
    [{ runId: "memory-v1-dev-a1g-r1", generated: 30, expectedGenerations: 30, judged: 0, expectedJudgments: 27, lowScores: 0, contradictions: 0, attempts: 31, generatedAt: [], judgedAt: [] }],
    { generatorEur: 1, judgeEur: 0.5, totalEur: 1.5, stageGeneratorEur: 0.6, stageJudgeEur: 0 },
    200
  );
  assert.match(out, /30\/30 país-año/);
  assert.match(out, /1\.50 € de 200 €/);
  assert.match(out, /plana/);
  assert.match(out, /mundo  1/);
  assert.match(out, /1 fallo/);
});

test("eta estima el tiempo restante con el ritmo reciente", () => {
  const now = Date.parse("2026-09-24T12:00:00Z");
  const times = Array.from({ length: 11 }, (_, i) => now - (10 - i) * 60_000); // 11 en 10 min
  const e = eta(times, 55, now)!;
  assert.ok(Math.abs(e.perMin - 1.1) < 1e-9);
  assert.equal(Math.round(e.minutes), 50);
  assert.equal(eta([now - 60 * 60_000, now - 59 * 60_000], 10, now), null); // nada reciente
  assert.deepEqual(eta([], 0, now), { perMin: 0, minutes: 0 });
  assert.equal(fmtMinutes(95), "1 h 35 min");
});
