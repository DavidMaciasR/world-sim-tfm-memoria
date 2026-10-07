// memory-v1 — agregación de una etapa (RUNBOOK §3.5).
//
//   npx ts-node src/tfm/experiment/aggregate.ts --stage dev|eval|pilot
//
// Escribe en docs/tfm/results/memory-v1/<etapa>/:
//   country-years.csv   una fila por país-año y tirada: medidas y consumo
//   contradictions.csv  una fila por contradicción citada, con columnas vacías
//                       para codificar a mano si repite un hecho en su fecha real
//   summary.json        tabla de fallos primero; luego, por condición, el valor
//                       de cada mundo (media por país y países con igual peso),
//                       su media y su rango. Sin puntuación combinada.

import fs from "fs";
import path from "path";
import { costUsd, usdToEur } from "../pricing";
import { MEMORY_CONDITIONS, MEMORY_STAGES, MemoryStage, generationsPerWorld, isMemoryStage, memoryRunId } from "./memory-study";
import { EXPERIMENT_GENERATOR_MODEL } from "./types";
import { countryYearMetrics, validEvidenceIndexes, worldMean } from "./memory-metrics";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const RUNS_DIR = path.join(REPO_ROOT, "docs", "tfm", "runs");
const JUDGE_MODEL = "claude-sonnet-5";
const LABEL: Record<string, string> = { A1G: "plana", A1: "estructurada" };

const readJsonl = (f: string): any[] =>
  fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

function csv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    if (v == null) return "";
    const s = typeof v === "number" ? String(Math.round(v * 10000) / 10000) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
}

const stats = (v: (number | null)[]) => {
  const x = v.filter((n): n is number => n != null);
  if (x.length === 0) return { values: v, mean: null, min: null, max: null };
  return { values: v, mean: x.reduce((a, b) => a + b, 0) / x.length, min: Math.min(...x), max: Math.max(...x) };
};

export function aggregateStage(stage: MemoryStage, runsDir = RUNS_DIR) {
  const cy: Record<string, unknown>[] = [];
  const contradictions: Record<string, unknown>[] = [];
  const failures: Record<string, unknown>[] = [];
  const worlds: Record<string, Record<string, unknown>[]> = {};

  for (let r = 1; r <= MEMORY_STAGES[stage].replicates; r++) {
    for (const arch of MEMORY_CONDITIONS) {
      const runId = memoryRunId(stage, arch, r);
      const dir = path.join(runsDir, runId);
      if (!fs.existsSync(dir)) continue;
      const records = readJsonl(path.join(dir, "records.jsonl"));
      const ok = records.filter((x) => x.status === "ok");
      const judgments = readJsonl(path.join(dir, "coherence-judge", "judgments.jsonl"));
      const judgeByKey = new Map(judgments.map((j) => [j.key, j]));
      const usage = readJsonl(path.join(dir, "generator-usage.jsonl"));
      const byKey = new Map(ok.map((x) => [`${x.country}:${x.simYear}`, x]));
      const condition = LABEL[arch];

      failures.push({
        runId, condition, replicate: r,
        planned: generationsPerWorld(stage), accepted: ok.length,
        attempts: records.length, generationErrors: records.length - ok.length,
        judged: judgments.filter((j) => j.status === "ok").length,
        judgeNA: judgments.filter((j) => j.status === "structural_na").length,
        judgeErrors: judgments.filter((j) => j.status !== "ok" && j.status !== "structural_na").length,
        judgmentsWithInvalidEvidence: judgments.filter((j) => j.status === "ok" && j.evidenceValid === false).length,
        complete: ok.length === generationsPerWorld(stage),
      });

      const rows: { country: string; m: ReturnType<typeof countryYearMetrics>; eur: number | null }[] = [];
      for (const rec of ok) {
        const key = `${rec.country}:${rec.simYear}`;
        const prev = byKey.get(`${rec.country}:${rec.simYear - 1}`);
        const j = judgeByKey.get(key);
        const m = countryYearMetrics(rec.analysis.simulatedNews ?? [], prev?.analysis.simulatedNews, j);
        const u = usage.find((x) => x.status === "success" && x.country === rec.country && x.simYear === rec.simYear);
        const genEur = u ? usdToEur(costUsd(EXPERIMENT_GENERATOR_MODEL, u.inputTokens ?? 0, (u.outputTokens ?? 0) + (u.thoughtsTokens ?? 0))) : null;
        rows.push({ country: rec.country, m, eur: genEur });
        cy.push({
          runId, condition, replicate: r, country: rec.country, year: rec.simYear,
          contradictions: m.contradictions, score: m.score, headlineSimilarity: m.headlineSimilarity,
          ngram4: m.ngram4, recycledShare: m.recycledShare,
          genInputTokens: u?.inputTokens ?? null, genOutputTokens: u?.outputTokens ?? null, genThoughtsTokens: u?.thoughtsTokens ?? null,
          genEurCents: genEur != null ? genEur * 100 : null,
          judgeInputTokens: j?.usage?.inputTokens ?? null, judgeOutputTokens: j?.usage?.outputTokens ?? null,
        });
        if (j?.status === "ok") {
          const valid = new Set(validEvidenceIndexes(j));
          (j.verdict.evidence ?? []).forEach((e: any, i: number) =>
            contradictions.push({
              condition, replicate: r, country: rec.country, year: rec.simYear, score: j.verdict.score, valid: valid.has(i),
              prior_field: e.prior_field, prior_quote: e.prior_quote, current_field: e.current_field, current_quote: e.current_quote, conflict: e.conflict,
              repite_hecho_en_fecha_real: "", nota: "",
            })
          );
        }
      }
      const pick = (f: (x: (typeof rows)[number]) => number | null) => worldMean(rows.map((x) => ({ country: x.country, value: f(x) })));
      (worlds[condition] ??= []).push({
        runId, replicate: r, complete: ok.length === generationsPerWorld(stage),
        contradictionsPerCountryYear: pick((x) => x.m.contradictions),
        shareOfYearsWithContradiction: pick((x) => (x.m.contradictions == null ? null : x.m.contradictions > 0 ? 1 : 0)),
        headlineSimilarity: pick((x) => x.m.headlineSimilarity),
        score: pick((x) => x.m.score),
        ngram4: pick((x) => x.m.ngram4),
        genEurCentsPerCountryYear: pick((x) => (x.eur == null ? null : x.eur * 100)),
      });
    }
  }

  const byCondition: Record<string, Record<string, unknown>> = {};
  for (const [cond, ws] of Object.entries(worlds)) {
    const complete = ws.filter((w) => w.complete);
    byCondition[cond] = {
      worlds: ws.length, completeWorlds: complete.length,
      ...Object.fromEntries(
        ["contradictionsPerCountryYear", "shareOfYearsWithContradiction", "headlineSimilarity", "score", "ngram4", "genEurCentsPerCountryYear"].map(
          (k) => [k, stats(complete.map((w) => w[k] as number | null))]
        )
      ),
    };
  }
  const diff = (k: string) => {
    const a = (byCondition.estructurada?.[k] as any)?.mean, b = (byCondition.plana?.[k] as any)?.mean;
    return a != null && b != null ? a - b : null;
  };
  const summary = {
    stage, generatedAt: new Date().toISOString(),
    failures,
    byCondition,
    differenceStructuredMinusFlat: Object.fromEntries(
      ["contradictionsPerCountryYear", "shareOfYearsWithContradiction", "headlineSimilarity", "score", "genEurCentsPerCountryYear"].map((k) => [k, diff(k)])
    ),
    worlds,
    judgeModel: JUDGE_MODEL,
  };
  return { cy, contradictions, summary };
}

if (require.main === module) {
  const i = process.argv.indexOf("--stage");
  const stage = i >= 0 ? process.argv[i + 1] : "dev";
  if (!isMemoryStage(stage)) throw new Error("--stage pilot|dev|eval");
  const { cy, contradictions, summary } = aggregateStage(stage);
  const out = path.join(REPO_ROOT, "docs", "tfm", "results", "memory-v1", stage);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "country-years.csv"), csv(cy));
  fs.writeFileSync(path.join(out, "contradictions.csv"), csv(contradictions));
  fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(`${cy.length} país-año · ${contradictions.length} contradicciones → ${path.relative(REPO_ROOT, out)}`);
}
