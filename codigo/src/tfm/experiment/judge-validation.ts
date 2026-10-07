// memory-v1 — pares de continuidad para comprobar el juez (RUNBOOK §4.2).
//
//   npx ts-node src/tfm/experiment/judge-validation.ts --dry-run | --yes
//
// Seis país-año de desarrollo (tres por memoria) que el juez dio por coherentes
// en sus dos pasadas. En cada uno se sustituye la MISMA noticia por dos textos
// de longitud parecida: uno que reafirma un hecho explícito del año anterior y
// otro que lo niega directamente. El resto del año, el pasado y el contexto de
// los demás países quedan idénticos. Son textos sintéticos, escritos a mano; no
// se presentan como fallos naturales del generador.
//
// Criterio (control de ingeniería, no una precisión validada): un par se supera
// si la versión contradictoria recibe más contradicciones válidas que la
// coherente y al menos una cita la noticia introducida. Umbral: 5 de 6.
// Resultados en docs/tfm/results/memory-v1/judge-validation/.

import "../../load-env";
import fs from "fs";
import path from "path";
import { acceptedRecords, buildCoherenceEvidence, callCoherenceJudge, checkVerdict } from "./coherence-judge";
import { validContradictions } from "./memory-metrics";
import { CountryYearRecord } from "./types";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const RUNS = path.join(REPO_ROOT, "docs", "tfm", "runs");
const OUT = path.join(REPO_ROOT, "docs", "tfm", "results", "memory-v1", "judge-validation");
const COUNTRIES = ["Germany", "France", "Russia"];
const NEWS_INDEX = 5; // la noticia de junio: el mismo hueco en las dos versiones

export interface Fixture {
  id: string;
  runId: string;
  country: string;
  year: number;
  priorFact: string; // el hecho explícito del año anterior, citado del registro
  consistent: { headline: string; body: string };
  contradiction: { headline: string; body: string };
}

export const FIXTURES: Fixture[] = [
  {
    id: "plana-DE-2018-lituania", runId: "memory-v1-dev-a1g-r1", country: "Germany", year: 2018,
    priorFact: "2017.move: stationing additional Bundeswehr mechanized units in Lithuania",
    consistent: { headline: "Bundeswehr units in Lithuania complete first year of rotation", body: "German mechanized units stationed in Lithuania last year hold readiness drills with NATO allies. Berlin keeps the deployment unchanged." },
    contradiction: { headline: "Berlin says Germany has never stationed troops in Lithuania", body: "Government spokespeople state that no Bundeswehr units have ever been deployed to Lithuania. Berlin rules out any Baltic presence." },
  },
  {
    id: "plana-FR-2020-grecia", runId: "memory-v1-dev-a1g-r1", country: "France", year: 2020,
    priorFact: "2019.move: France signs a bilateral defense pact with Greece",
    consistent: { headline: "France and Greece hold first review of their defense pact", body: "Officials meet in Athens to review the bilateral defense pact signed last year. Both sides confirm its commitments remain in force." },
    contradiction: { headline: "Paris says France has never signed a defense pact with Greece", body: "The foreign ministry states that France has no defense agreement of any kind with Greece. Officials deny any commitment to Athens." },
  },
  {
    id: "plana-RU-2020-inf", runId: "memory-v1-dev-a1g-r1", country: "Russia", year: 2020,
    priorFact: "2019.move: Russia suspends participation in the INF Treaty",
    consistent: { headline: "Moscow keeps INF Treaty suspension in place", body: "Russian officials confirm the suspension of the INF Treaty announced last year remains in effect. Missile deployments continue." },
    contradiction: { headline: "Moscow says Russia remains a full party to the INF Treaty", body: "The foreign ministry states that Russia has never suspended its participation in the INF Treaty. Officials insist Moscow is fully bound." },
  },
  {
    id: "estructurada-DE-2020-aquisgran", runId: "memory-v1-dev-a1-r1", country: "Germany", year: 2020,
    priorFact: "2019.move: Germany signs the Treaty of Aachen with France",
    consistent: { headline: "Germany and France hold first council under Treaty of Aachen", body: "The Franco-German security council created by last year's Treaty of Aachen meets in Berlin. Both governments reaffirm the treaty." },
    contradiction: { headline: "Berlin says Germany has never signed a treaty with France at Aachen", body: "Government spokespeople state that no Treaty of Aachen was ever signed. Berlin denies any new Franco-German security council." },
  },
  {
    id: "estructurada-FR-2019-eii", runId: "memory-v1-dev-a1-r1", country: "France", year: 2019,
    priorFact: "2018.move: France signs a defense protocol establishing the European Intervention Initiative",
    consistent: { headline: "European Intervention Initiative holds its first planning session", body: "Staff from the founding states meet in Paris a year after France signed the initiative's protocol. The framework remains active." },
    contradiction: { headline: "Paris says France never joined the European Intervention Initiative", body: "Officials state that France has never signed any protocol creating a European Intervention Initiative. Paris denies taking part." },
  },
  {
    id: "estructurada-RU-2020-china", runId: "memory-v1-dev-a1-r1", country: "Russia", year: 2020,
    priorFact: "2019.move: Moscow signs a joint air-defense coordination agreement with Beijing",
    consistent: { headline: "Russia and China activate air-defense coordination agreed last year", body: "Radar data sharing begins under the air-defense agreement signed with Beijing in 2019. Moscow calls the arrangement operational." },
    contradiction: { headline: "Moscow says Russia has no air-defense agreement with China", body: "Officials state that Russia has never signed any air-defense coordination agreement with Beijing. Moscow denies any such arrangement." },
  },
];

function loadAccepted(runId: string): Map<string, CountryYearRecord> {
  const lines = fs.readFileSync(path.join(RUNS, runId, "records.jsonl"), "utf8").split("\n").filter(Boolean);
  return acceptedRecords(lines.map((l) => JSON.parse(l)));
}

/** Copia del registro del año con la noticia sustituida; todo lo demás igual. */
export function withEditedNews(record: CountryYearRecord, edit: { headline: string; body: string }): CountryYearRecord {
  const copy: CountryYearRecord = JSON.parse(JSON.stringify(record));
  const news = copy.analysis!.simulatedNews;
  news[NEWS_INDEX] = { ...news[NEWS_INDEX], headline: edit.headline, body: edit.body };
  return copy;
}

function evidenceFor(f: Fixture, variant: "consistent" | "contradiction") {
  const accepted = loadAccepted(f.runId);
  const key = `${f.country}:${f.year}`;
  const base = accepted.get(key)!;
  const edited = new Map(accepted);
  edited.set(key, withEditedNews(base, f[variant]));
  const evidence = buildCoherenceEvidence({ country: f.country, simYear: f.year, startYear: 2015, countries: COUNTRIES, accepted: edited })!;
  const month = base.analysis!.simulatedNews[NEWS_INDEX].month;
  return { evidence, injectedField: `${f.year}.news.m${String(month).padStart(2, "0")}` };
}

async function main() {
  const yes = process.argv.includes("--yes");
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "fixtures.json"), JSON.stringify(FIXTURES, null, 2) + "\n");
  const results: any[] = [];
  let passed = 0;
  for (const f of FIXTURES) {
    const row: any = { id: f.id, runId: f.runId, key: `${f.country}:${f.year}`, priorFact: f.priorFact };
    for (const variant of ["consistent", "contradiction"] as const) {
      const { evidence, injectedField } = evidenceFor(f, variant);
      row.injectedField = injectedField;
      if (!yes) { row[variant] = { inputChars: evidence.text.length }; continue; }
      const r = await callCoherenceJudge(evidence, { runId: `judge-validation:${f.id}`, recordKey: row.key, attemptId: variant });
      const problems = checkVerdict(r.verdict, evidence);
      const judgment = { status: "ok", verdict: r.verdict, evidenceProblems: problems };
      const valid = validContradictions(judgment) ?? 0;
      const citesInjected = (r.verdict.evidence ?? []).some((e, i) => e.current_field === injectedField && !problems.some((p) => p.startsWith(`evidence[${i}]`)));
      row[variant] = { score: r.verdict.score, validContradictions: valid, citesInjected, evidence: r.verdict.evidence, problems, rationale: r.verdict.rationale, usage: r.usage, returnedModel: r.returnedModel };
    }
    if (yes) {
      row.passed = row.contradiction.validContradictions > row.consistent.validContradictions && row.contradiction.citesInjected;
      if (row.passed) passed++;
      console.log(`${row.passed ? "✓" : "✗"} ${f.id}: coherente ${row.consistent.score} (${row.consistent.validContradictions}) · contradicción ${row.contradiction.score} (${row.contradiction.validContradictions}, cita la noticia: ${row.contradiction.citesInjected ? "sí" : "no"})`);
    } else {
      console.log(`${f.id}: ${row.key}, noticia sustituida ${row.injectedField}`);
    }
    results.push(row);
  }
  if (!yes) { console.log("\n(dry-run: ninguna llamada; --yes lanza 12 juicios)"); return; }
  const summary = { passed, total: FIXTURES.length, gate: passed >= 5 ? "superado" : "NO superado", threshold: 5, runAt: new Date().toISOString() };
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ summary, results }, null, 2) + "\n");
  console.log(`\n${passed}/${FIXTURES.length} pares superados · umbral 5 · ${summary.gate}`);
}

if (require.main === module) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
