import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import os from "os";
import path from "path";
import {
  acceptedRecords,
  buildCoherenceEvidence,
  checkVerdict,
  CoherenceVerdict,
  COHERENCE_SCHEMA,
  JUDGE_CONFIG,
  JudgeCall,
  MissingDependencyError,
} from "./coherence-judge";
import { runCoherenceJudging } from "./judge-runner";
import type { CountryYearRecord, ExperimentSpec } from "./types";

const COUNTRIES = ["Germany", "France"];

function record(arch: "A1G" | "A1", country: string, simYear: number, over?: Partial<CountryYearRecord>): CountryYearRecord {
  return {
    key: `${arch}:1:${country}:${simYear}`,
    runId: `memory-v1-pilot-${arch.toLowerCase()}-r1`,
    architecture: arch,
    seed: 1,
    country,
    simYear,
    generatedAt: "2026-09-16T00:00:00.000Z",
    status: "ok",
    analysis: {
      move: `${country} signs the Baltic Shield pact in ${simYear}`,
      confidence: "MEDIUM",
      prediction: `${country} expects Moscow to hold exercises in ${simYear + 1}`,
      decision: `${country} commits two brigades`,
      outcome: `${country} deployment completed`,
      simulatedNews: [
        { month: 2, headline: `${country} headline ${simYear} feb`, body: "Troops   arrive in Lithuania.", tone: "neutral", sources: [] },
        { month: 1, headline: `${country} headline ${simYear} jan`, body: "Parliament votes.", tone: "neutral", sources: [] },
      ],
    },
    ...over,
  };
}

function worldRecords(arch: "A1G" | "A1"): CountryYearRecord[] {
  return [2015, 2016, 2017].flatMap((y) => COUNTRIES.map((c) => record(arch, c, y)));
}

const evidenceFor = (arch: "A1G" | "A1", simYear = 2017) =>
  buildCoherenceEvidence({
    country: "Germany",
    simYear,
    startYear: 2015,
    countries: COUNTRIES,
    accepted: acceptedRecords(worldRecords(arch)),
  });

test("la evidencia es idéntica en las dos condiciones y no revela cuál es", () => {
  const a = evidenceFor("A1G")!;
  const b = evidenceFor("A1")!;
  assert.equal(a.text, b.text);
  for (const leak of ["A1G", "A1", "memory-v1", "r1", "INDICATORS", "STRUCTURED MEMORY", "TRAJECTORY"]) {
    assert.ok(!a.text.includes(leak), `la evidencia no debe contener "${leak}"`);
  }
});

test("la evidencia lleva todo el pasado propio, los pares de Y-1 y el año actual, con ids", () => {
  const e = evidenceFor("A1G")!;
  const ids = e.fields.map((f) => f.id);
  for (const id of ["2015.move", "2016.prediction", "2016.news.m01", "2016.news.m02", "2017.move", "2017.outcome"]) {
    assert.ok(ids.includes(id), id);
  }
  assert.ok(ids.includes("peer.France.2016.move"), "Francia es aliada de Alemania: su jugada de 2016 es evidencia de par");
  assert.ok(!ids.some((id) => id.startsWith("peer.France.2015")), "solo el año anterior de los pares");
  // Etiquetas: la predicción no se presenta como hecho.
  assert.match(e.text, /\[2015\.prediction\] \(prediction — an expectation, not an established fact\)/);
  // Orden de meses y espacios normalizados.
  assert.ok(e.text.indexOf("[2015.news.m01]") < e.text.indexOf("[2015.news.m02]"));
  assert.match(e.text, /Troops arrive in Lithuania/);
  assert.equal(e.fields.find((f) => f.id === "2017.move")!.scope, "current");
});

test("primer año: N/A estructural; hueco en el pasado: se señala, no se rellena", () => {
  assert.equal(evidenceFor("A1G", 2015), null);
  const gap = worldRecords("A1G").filter((r) => !(r.country === "Germany" && r.simYear === 2016));
  assert.throws(
    () =>
      buildCoherenceEvidence({ country: "Germany", simYear: 2017, startYear: 2015, countries: COUNTRIES, accepted: acceptedRecords(gap) }),
    MissingDependencyError
  );
});

function verdict(over: Partial<CoherenceVerdict>): CoherenceVerdict {
  return { score: 5, null_reason: null, rationale: "ok", evidence: [], ...over };
}

test("checkVerdict acepta evidencia literal y trazable", () => {
  const e = evidenceFor("A1G")!;
  const v = verdict({
    score: 3,
    evidence: [
      {
        prior_field: "2016.news.m02",
        prior_quote: "troops arrive in lithuania",
        current_field: "2017.move",
        current_quote: "signs the Baltic Shield pact",
        conflict: "x",
      },
    ],
  });
  assert.deepEqual(checkVerdict(v, e), []);
  assert.deepEqual(checkVerdict(verdict({}), e), []);
});

test("checkVerdict señala citas inventadas, campos en el lado equivocado y puntuaciones sin evidencia", () => {
  const e = evidenceFor("A1G")!;
  const item = {
    prior_field: "2016.move",
    prior_quote: "signs the Baltic Shield pact",
    current_field: "2017.move",
    current_quote: "signs the Baltic Shield pact",
    conflict: "c",
  };
  const problems = (over: Partial<CoherenceVerdict>) => checkVerdict(verdict(over), e);

  assert.match(problems({ score: 2 }).join(), /without evidence/);
  assert.match(problems({ score: null }).join(), /without null_reason/);
  assert.match(problems({ score: 3, evidence: [{ ...item, prior_quote: "never said this" }] }).join(), /prior quote not found/);
  assert.match(problems({ score: 3, evidence: [{ ...item, prior_field: "2017.move" }] }).join(), /is from the current year/);
  assert.match(problems({ score: 3, evidence: [{ ...item, current_field: "2016.move" }] }).join(), /not from the current year/);
  assert.match(problems({ score: 3, evidence: [{ ...item, prior_field: "2014.move" }] }).join(), /does not exist/);
});

test("el juez no manda temperatura y deja fijado el razonamiento; el esquema es estricto", () => {
  assert.equal(JUDGE_CONFIG.model, "claude-sonnet-5");
  assert.deepEqual(JUDGE_CONFIG.thinking, { type: "disabled" });
  assert.equal("temperature" in JUDGE_CONFIG, false);
  assert.equal(COHERENCE_SCHEMA.additionalProperties, false);
});

// --- Pasada del juez sobre una tirada ------------------------------------

function writeRun(records: CountryYearRecord[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tfm-judge-"));
  const spec: ExperimentSpec = {
    runId: "memory-v1-pilot-a1g-r1",
    mode: "backtest",
    architecture: "A1G",
    seed: 1,
    countries: COUNTRIES,
    startYear: 2015,
    endYear: 2017,
  };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ spec, fingerprints: [{ conditionHash: "gen1" }] }));
  fs.writeFileSync(path.join(dir, "records.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return dir;
}

function fakeCall(calls: string[], failOn?: string): JudgeCall {
  return async (evidence, meta) => {
    calls.push(meta.attemptId);
    if (failOn && meta.attemptId.startsWith(failOn)) throw new Error("529 overloaded");
    return {
      verdict: verdict({}),
      requestedModel: "claude-sonnet-5",
      returnedModel: "claude-sonnet-5",
      requestId: "req_1",
      stopReason: "end_turn",
      usage: { inputTokens: evidence.text.length, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      latencyMs: 1,
    };
  };
}

const readJudgments = (dir: string) =>
  fs
    .readFileSync(path.join(dir, "coherence-judge", "judgments.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

test("dry-run no llama a nadie ni escribe nada; --yes juzga los no iniciales y marca los iniciales", async () => {
  const dir = writeRun(worldRecords("A1G"));
  const calls: string[] = [];
  const dry = await runCoherenceJudging({ runDir: dir, formatterSource: "f", call: fakeCall(calls), dryRun: true });
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(path.join(dir, "coherence-judge")), false);
  assert.equal(dry.plan.filter((p) => p.action === "judge").length, 4);
  assert.equal(dry.plan.filter((p) => p.action === "structural_na").length, 2);

  const real = await runCoherenceJudging({ runDir: dir, formatterSource: "f", call: fakeCall(calls), dryRun: false });
  assert.deepEqual([real.judged, real.structuralNa, real.errors], [4, 2, 0]);
  assert.equal(calls.length, 4);
  const judgments = readJudgments(dir);
  assert.equal(judgments.length, 6);
  assert.ok(judgments.filter((j) => j.status === "ok").every((j) => j.evidenceValid && j.usage && j.inputHash));

  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "coherence-judge", "manifest.json"), "utf8"));
  assert.equal(manifest.judgeConditions.model, "claude-sonnet-5");
  assert.ok(manifest.judgeConditions.rubricHash);
  assert.equal(manifest.generation.runManifestConditionHash, "gen1");
});

test("reanudar no repite juicios; un fallo se registra, para, y se reintenta con otro attemptId", async () => {
  const dir = writeRun(worldRecords("A1G"));
  const calls: string[] = [];
  await assert.rejects(
    runCoherenceJudging({ runDir: dir, formatterSource: "f", call: fakeCall(calls, "France:2016"), dryRun: false }),
    /Judge failed on France:2016/
  );
  const resumed = await runCoherenceJudging({ runDir: dir, formatterSource: "f", call: fakeCall(calls), dryRun: false });
  assert.equal(resumed.judged, 3); // France:2016 de nuevo + los dos de 2017
  assert.deepEqual(calls, ["Germany:2016#1", "France:2016#1", "France:2016#2", "Germany:2017#1", "France:2017#1"]);

  const again = await runCoherenceJudging({ runDir: dir, formatterSource: "f", call: fakeCall(calls), dryRun: false });
  assert.equal(again.judged, 0);
  assert.equal(calls.length, 5);
  assert.equal(readJudgments(dir).filter((j) => j.status === "error").length, 1);
});

test("otras condiciones del juez o una entrada cambiada no se añaden a los juicios existentes", async () => {
  const dir = writeRun(worldRecords("A1G"));
  await runCoherenceJudging({ runDir: dir, formatterSource: "f", call: fakeCall([]), dryRun: false });

  await assert.rejects(
    runCoherenceJudging({ runDir: dir, formatterSource: "otro formateador", call: fakeCall([]), dryRun: true }),
    /different judge conditions/
  );

  const changed = worldRecords("A1G").map((r) =>
    r.country === "Germany" && r.simYear === 2015 ? record("A1G", "Germany", 2015, { analysis: { ...r.analysis!, move: "regenerated" } }) : r
  );
  fs.writeFileSync(path.join(dir, "records.jsonl"), changed.map((r) => JSON.stringify(r)).join("\n") + "\n");
  await assert.rejects(
    runCoherenceJudging({ runDir: dir, formatterSource: "f", call: fakeCall([]), dryRun: true }),
    /different input/
  );
});
