// memory-v1 — la medida de repetición detecta copias (RUNBOOK §4.2), sin API.
//
//   npx ts-node src/tfm/experiment/repetition-validation.ts
//
// En seis registros de desarrollo (tres por memoria):
// - Similitud con el año anterior (medida principal): se sustituyen 0, 3, 6 y 12
//   titulares del año por titulares del año anterior. Debe subir con cada paso.
// - 4-gramas del año (diagnóstico): se duplica una noticia completa en otros tres
//   meses, conservando la etiqueta de mes. Debe subir respecto al original.
// Resultados en docs/tfm/results/memory-v1/repetition-validation.json.

import fs from "fs";
import path from "path";
import { headlineSimilarityToPreviousYear } from "./memory-metrics";
import { ngramRepetitionRate } from "../degeneration-metrics";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const RUNS = path.join(REPO_ROOT, "docs", "tfm", "runs");
const CASES = [
  ["memory-v1-dev-a1g-r1", "Germany", 2019], ["memory-v1-dev-a1g-r1", "France", 2021], ["memory-v1-dev-a1g-r1", "Russia", 2023],
  ["memory-v1-dev-a1-r1", "Germany", 2021], ["memory-v1-dev-a1-r1", "France", 2023], ["memory-v1-dev-a1-r1", "Russia", 2019],
] as const;

const texts = (news: any[]) => news.map((n) => `${n.headline}. ${n.body}`);

const results = CASES.map(([runId, country, year]) => {
  const recs = fs.readFileSync(path.join(RUNS, runId, "records.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.status === "ok");
  const get = (y: number) => recs.find((r) => r.country === country && r.simYear === y).analysis.simulatedNews as any[];
  const cur = get(year), prev = get(year - 1);
  const similarity = [0, 3, 6, 12].map((k) => {
    const edited = cur.map((n, i) => (i < k ? { ...n, headline: prev[i].headline } : n));
    return { replaced: k, value: headlineSimilarityToPreviousYear(edited, prev)! };
  });
  const dup = cur.map((n, i) => (i >= 1 && i <= 3 ? { ...cur[0], month: n.month } : n));
  const ngram = { original: ngramRepetitionRate(texts(cur), 4), duplicated: ngramRepetitionRate(texts(dup), 4) };
  const monotonic = similarity.every((s, i) => i === 0 || s.value > similarity[i - 1].value);
  return { runId, country, year, similarity, ngram4: ngram, passed: monotonic && ngram.duplicated > ngram.original };
});

const out = path.join(REPO_ROOT, "docs", "tfm", "results", "memory-v1", "repetition-validation.json");
fs.writeFileSync(out, JSON.stringify({ runAt: new Date().toISOString(), passed: results.filter((r) => r.passed).length, total: results.length, results }, null, 2) + "\n");
for (const r of results) {
  console.log(`${r.passed ? "✓" : "✗"} ${r.runId.includes("-a1g-") ? "plana" : "estructurada"} ${r.country} ${r.year}: similitud ${r.similarity.map((s) => s.value.toFixed(2)).join(" → ")} · 4-gramas ${r.ngram4.original.toFixed(3)} → ${r.ngram4.duplicated.toFixed(3)}`);
}
console.log(`\n${results.filter((r) => r.passed).length}/${results.length} casos: la medida sube con las copias`);
