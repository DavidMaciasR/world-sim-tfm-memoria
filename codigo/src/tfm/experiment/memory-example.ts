// memory-v1 — ejemplo real de lo que ve el agente con cada memoria (figura del
// cap. 4, «Las dos condiciones»).
//
//   npx ts-node src/tfm/experiment/memory-example.ts
//
// Toma un país-año de la evaluación, reconstruye su pasado desde los registros
// de esa tirada y pide a las dos memorias el prompt que enviarían, sin llamar a
// ningún modelo. Así las dos ven exactamente el mismo pasado y solo cambia la
// política de memoria. Escribe el JSON que lee docs/tfm/tools/figuras-cap4.py.

import fs from "fs";
import path from "path";
import { acceptedRecords } from "./coherence-judge";
import { A1GroundedArchitecture } from "./architectures/a1-grounded";
import { A1GGroundingOnlyArchitecture } from "./architectures/a1g-grounding-only";
import type { CountryYearTask, WorldState } from "./types";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
// Pakistán 2017, mundo 1 de la memoria estructurada: en 2016 la simulación ya
// había hecho a Pakistán miembro de pleno derecho de la Organización de
// Cooperación de Shanghái, y en 2017 vuelve a ingresar (contradicción válida).
const RUN_ID = "memory-v1-eval-a1-r1";
const COUNTRY = "Pakistan";
const YEAR = 2017;
const OUT = path.join(REPO_ROOT, "docs", "tfm", "results", "memory-v1", "figures", "memoria-ejemplo.json");

function section(prompt: string, start: string, end: string): string {
  const i = prompt.indexOf(start);
  const j = prompt.indexOf(end, i + start.length);
  return i < 0 ? "" : prompt.slice(i, j < 0 ? undefined : j).trim();
}

function main() {
  const lines = fs.readFileSync(path.join(REPO_ROOT, "docs", "tfm", "runs", RUN_ID, "records.jsonl"), "utf8").split("\n").filter(Boolean);
  const accepted = acceptedRecords(lines.map((l) => JSON.parse(l)));
  const history = [];
  for (let y = 2015; y < YEAR; y++) {
    const a = accepted.get(`${COUNTRY}:${y}`)!.analysis!;
    history.push({ sim_year: y, sim_month: `${y}-07`, move: a.move, confidence: a.confidence, prediction: a.prediction });
  }
  const state = {
    priorYearAnalysis: {},
    priorYearSimNews: {},
    historyByCountry: { [COUNTRY]: history },
    priorSimNewsByCountry: { [COUNTRY]: accepted.get(`${COUNTRY}:${YEAR - 1}`)!.analysis!.simulatedNews },
  } as unknown as WorldState;
  const task = { spec: { countries: [COUNTRY], startYear: 2015, endYear: 2024 }, country: COUNTRY, simYear: YEAR, state } as unknown as CountryYearTask;
  const flat = new A1GGroundingOnlyArchitecture().promptBundle(task).systemPrompt;
  const structured = new A1GroundedArchitecture().promptBundle(task).systemPrompt;
  const out = {
    runId: RUN_ID,
    country: COUNTRY,
    year: YEAR,
    flat: {
      history: section(flat, "STRATEGIC HISTORY:", "REAL-WORLD INDICATORS"),
      news: section(flat, "SIMULATED NEWS HISTORY", "TONE DIRECTIVE"),
    },
    structured: section(structured, "STRUCTURED MEMORY:", "REAL-WORLD INDICATORS"),
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(`escrito ${path.relative(REPO_ROOT, OUT)}`);
}

if (require.main === module) main();
