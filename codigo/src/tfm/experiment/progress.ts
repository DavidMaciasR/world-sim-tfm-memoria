// TFM — progreso y gasto del estudio memory-v1, con tope de presupuesto.
//
//   npx ts-node src/tfm/experiment/progress.ts --stage dev            una foto
//   npx ts-node src/tfm/experiment/progress.ts --stage dev --watch 10 se redibuja cada 10 s
//   ... --guard 200    además, si el gasto del estudio supera 200 € mata el runner y el juez
//
// El gasto es de TODO el estudio (piloto + desarrollo + evaluación), no de la
// etapa: el techo de 200 € de la tutoría 2 es para el estudio entero.
// - Generador: telemetría local (llm_call_events), llamadas a gemini-3.6-flash
//   desde el primer piloto, incluidas las fallidas que consumieron tokens.
//   Es una cota superior: cualquier otra llamada local a ese modelo también cuenta.
// - Juez: el `usage` que guarda cada juicio en runs/memory-v1-*/coherence-judge.

import "../../load-env";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { costUsd, usdToEur } from "../pricing";
import {
  MEMORY_CONDITIONS,
  MEMORY_STAGES,
  MEMORY_STUDY,
  MemoryStage,
  generationsPerWorld,
  isMemoryStage,
  judgeableCountryYearsPerWorld,
  memoryRunId,
} from "./memory-study";
import { EXPERIMENT_GENERATOR_MODEL } from "./types";
import { validContradictions } from "./memory-metrics";

const SERVER_ROOT = path.resolve(__dirname, "..", "..", "..");
const REPO_ROOT = path.resolve(SERVER_ROOT, "..", "..");
const RUNS_DIR = path.join(REPO_ROOT, "docs", "tfm", "runs");
const DB_PATH = process.env.DB_PATH || path.join(SERVER_ROOT, "worldsim.db");
/** Primer piloto de memory-v1 (commit d0306dc). */
export const STUDY_SPEND_SINCE = "2026-09-16T00:00:00Z";
const JUDGE_MODEL = "claude-sonnet-5";

export interface RunProgress {
  runId: string;
  generated: number;
  expectedGenerations: number;
  judged: number;
  expectedJudgments: number;
  lowScores: number;
  /** Contradicciones con evidencia válida (medida principal). */
  contradictions: number;
  /** Intentos de generación, incluidos los fallidos. */
  attempts: number;
  /** Momentos (ms) de cada generación aceptada y de cada juicio: para el ritmo. */
  generatedAt: number[];
  judgedAt: number[];
}

export interface Spend {
  generatorEur: number;
  judgeEur: number;
  totalEur: number;
  /** Lo gastado solo en esta etapa (para proyectar lo que falta). */
  stageGeneratorEur: number;
  stageJudgeEur: number;
}

function readJsonl(file: string): any[] {
  if (!fs.existsSync(file)) return [];
  const out: any[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // línea a medio escribir de una tirada en marcha
    }
  }
  return out;
}

export function runProgress(runsDir: string, stage: MemoryStage): RunProgress[] {
  const out: RunProgress[] = [];
  for (let r = 1; r <= MEMORY_STAGES[stage].replicates; r++) {
    for (const arch of MEMORY_CONDITIONS) {
      const runId = memoryRunId(stage, arch, r);
      const records = readJsonl(path.join(runsDir, runId, "records.jsonl"));
      const judgments = readJsonl(path.join(runsDir, runId, "coherence-judge", "judgments.jsonl"));
      const okJ = judgments.filter((j) => j.status === "ok");
      out.push({
        runId,
        generated: new Set(records.filter((x) => x.status === "ok").map((x) => x.key)).size,
        expectedGenerations: generationsPerWorld(stage),
        judged: new Set(okJ.map((j) => j.key)).size,
        expectedJudgments: judgeableCountryYearsPerWorld(stage),
        lowScores: okJ.filter((j) => (j.verdict?.score ?? 5) <= 3).length,
        contradictions: okJ.reduce((a, j) => a + (validContradictions(j) ?? 0), 0),
        attempts: records.length,
        generatedAt: records.filter((x) => x.status === "ok" && x.generatedAt).map((x) => Date.parse(x.generatedAt)),
        judgedAt: okJ.filter((j) => j.judgedAt).map((j) => Date.parse(j.judgedAt)),
      });
    }
  }
  return out;
}

/** € del juez en todas las tiradas del estudio, sumando el `usage` de cada juicio. */
export function judgeSpendEur(runsDir: string, prefix = `${MEMORY_STUDY}-`): number {
  if (!fs.existsSync(runsDir)) return 0;
  let usd = 0;
  for (const entry of fs.readdirSync(runsDir)) {
    if (!entry.startsWith(prefix)) continue;
    // Todas las pasadas del juez cuentan: también las archivadas al rejuzgar
    // (coherence-judge-v1-…), que se pagaron igual.
    const judgeDirs = fs.readdirSync(path.join(runsDir, entry)).filter((d) => d.startsWith("coherence-judge"));
    for (const j of judgeDirs.flatMap((d) => readJsonl(path.join(runsDir, entry, d, "judgments.jsonl")))) {
      const u = j.usage;
      if (!u) continue;
      const input = (u.inputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0) + (u.cacheReadInputTokens ?? 0);
      usd += costUsd(JUDGE_MODEL, input, u.outputTokens ?? 0);
    }
  }
  return usdToEur(usd);
}

/** € del generador: salida y razonamiento se facturan ambos a precio de salida. */
export function generatorSpendEur(rows: { inputTokens: number; outputTokens: number; thoughtsTokens: number }[]): number {
  let usd = 0;
  for (const r of rows) usd += costUsd(EXPERIMENT_GENERATOR_MODEL, r.inputTokens, r.outputTokens + r.thoughtsTokens);
  return usdToEur(usd);
}

function generatorRows(since = STUDY_SPEND_SINCE): { inputTokens: number; outputTokens: number; thoughtsTokens: number }[] {
  // sqlite3 del sistema: no depende de la versión de Node como better-sqlite3.
  // Sin -readonly a propósito: la BD está en modo WAL y, si nadie la tiene
  // abierta, una conexión de solo lectura no puede crear el -shm y falla al
  // abrir (código 14). La consulta es solo SELECT; no escribe nada.
  const sql =
    `SELECT coalesce(json_extract(meta_json,'$.inputTokens'),0), coalesce(json_extract(meta_json,'$.outputTokens'),0), ` +
    `coalesce(json_extract(meta_json,'$.thoughtsTokens'),0) FROM llm_call_events ` +
    `WHERE provider='gemini' AND model='${EXPERIMENT_GENERATOR_MODEL}' AND event_ts >= '${since}';`;
  const out = execFileSync("sqlite3", ["-separator", " ", DB_PATH, sql], { encoding: "utf8" });
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [i, o, t] = l.split(" ").map(Number);
      return { inputTokens: i, outputTokens: o, thoughtsTokens: t };
    });
}

/**
 * Ritmo reciente (unidades por minuto) sobre la ventana dada, y minutos que
 * faltan para `remaining` a ese ritmo. null si no hay actividad reciente.
 */
export function eta(times: number[], remaining: number, now: number, windowMin = 15): { perMin: number; minutes: number } | null {
  if (remaining <= 0) return { perMin: 0, minutes: 0 };
  const recent = times.filter((t) => now - t <= windowMin * 60_000).sort((a, b) => a - b);
  if (recent.length < 2) return null;
  const spanMin = Math.max((now - recent[0]) / 60_000, 1);
  const perMin = recent.length / spanMin;
  return { perMin, minutes: remaining / perMin };
}

export function fmtMinutes(m: number): string {
  if (m < 1) return "<1 min";
  const h = Math.floor(m / 60), mm = Math.round(m % 60);
  return h ? `${h} h ${String(mm).padStart(2, "0")} min` : `${mm} min`;
}

export function bar(done: number, total: number, width = 28): string {
  const f = total > 0 ? Math.min(1, done / total) : 0;
  const n = Math.round(f * width);
  return `[${"█".repeat(n)}${"░".repeat(width - n)}] ${String(Math.round(f * 100)).padStart(3)}%`;
}

export function render(stage: MemoryStage, runs: RunProgress[], spend: Spend, budgetEur: number, now = new Date()): string {
  const sum = (f: (r: RunProgress) => number) => runs.reduce((a, r) => a + f(r), 0);
  const gen = sum((r) => r.generated), genT = sum((r) => r.expectedGenerations);
  const jud = sum((r) => r.judged), judT = sum((r) => r.expectedJudgments);
  const t = now.getTime();
  const genEta = eta(runs.flatMap((r) => r.generatedAt), genT - gen, t);
  const judEta = eta(runs.flatMap((r) => r.judgedAt), judT - jud, t);
  const etaTxt = (e: ReturnType<typeof eta>, unit: string) =>
    !e ? "sin actividad reciente" : e.minutes === 0 ? "completo" : `${e.perMin.toFixed(1)} ${unit}/min · faltan ~${fmtMinutes(e.minutes)}`;
  const active = (r: RunProgress) => [...r.generatedAt, ...r.judgedAt].some((x) => t - x < 3 * 60_000);
  const lines = [
    `memory-v1 · ${stage} · ${now.toLocaleTimeString("es-ES")}`,
    "",
    `Generación ${bar(gen, genT)}  ${gen}/${genT} país-año · ${etaTxt(genEta, "país-año")}`,
    `Juez       ${bar(jud, judT)}  ${jud}/${judT} juicios · ${etaTxt(judEta, "juicios")}`,
    "",
  ];
  for (const cond of ["plana", "estructurada"]) {
    const rs = runs.filter((r) => (r.runId.includes("-a1g-") ? "plana" : "estructurada") === cond);
    const c = rs.reduce((a, r) => a + r.contradictions, 0), j = rs.reduce((a, r) => a + r.judged, 0);
    lines.push(`${cond === "plana" ? "Memoria plana" : "Memoria estructurada"} · ${c} contradicciones en ${j} país-año juzgados${j ? ` (${(c / j).toFixed(2)} por país-año)` : ""}`);
    for (const r of rs) {
      const rep = r.runId.match(/-r(\d+)$/)?.[1] ?? "?";
      const state = r.generated === 0 && r.attempts === 0 ? "pendiente" : r.judged >= r.expectedJudgments ? "terminado" : active(r) ? "en marcha" : r.generated >= r.expectedGenerations ? "falta juez" : "parado";
      const fails = r.attempts - r.generated;
      lines.push(
        `  mundo ${rep.padStart(2)}  gen ${bar(r.generated, r.expectedGenerations, 10)} ${String(r.generated).padStart(3)}/${r.expectedGenerations}` +
          `  juez ${String(r.judged).padStart(3)}/${r.expectedJudgments}  ${state}${fails > 0 ? ` · ${fails} fallo${fails > 1 ? "s" : ""}` : ""}`
      );
    }
    lines.push("");
  }
  // Proyección: gasto actual + lo que falta al coste medio observado en esta etapa.
  const perGen = gen > 0 ? spend.stageGeneratorEur / gen : null;
  const perJud = jud > 0 ? spend.stageJudgeEur / jud : null;
  const projected = perGen != null && perJud != null ? spend.totalEur + (genT - gen) * perGen + (judT - jud) * perJud : null;
  lines.push(
    `Gasto del estudio ${bar(spend.totalEur, budgetEur)}  ${spend.totalEur.toFixed(2)} € de ${budgetEur} €`,
    `  generador ${spend.generatorEur.toFixed(2)} € · juez ${spend.judgeEur.toFixed(2)} €` +
      (projected != null ? ` · al terminar la etapa ~${projected.toFixed(2)} €` : "")
  );
  return lines.join("\n");
}

function stopRunners(): void {
  try {
    execFileSync("pkill", ["-f", "tfm/experiment/(run-experiment|judge-run)\\.ts"]);
  } catch {
    // pkill sale con 1 si no había nada que matar
  }
}

function snapshot(stage: MemoryStage, budgetEur: number, guard: boolean): number {
  const runs = runProgress(RUNS_DIR, stage);
  const generatorEur = generatorSpendEur(generatorRows());
  const judgeEur = judgeSpendEur(RUNS_DIR);
  // Gasto de la etapa, para proyectar: el generador desde el primer registro de
  // la etapa (menos un minuto de margen); el juez, de las tiradas de la etapa.
  const first = Math.min(...runs.flatMap((r) => r.generatedAt));
  const stageGeneratorEur = Number.isFinite(first) ? generatorSpendEur(generatorRows(new Date(first - 60_000).toISOString())) : 0;
  const stageJudgeEur = judgeSpendEur(RUNS_DIR, `${MEMORY_STUDY}-${stage}-`);
  const spend = { generatorEur, judgeEur, totalEur: generatorEur + judgeEur, stageGeneratorEur, stageJudgeEur };
  console.log(render(stage, runs, spend, budgetEur));
  if (guard && spend.totalEur > budgetEur) {
    stopRunners();
    console.log(`\n⛔ Gasto ${spend.totalEur.toFixed(2)} € por encima del techo de ${budgetEur} €: runner y juez detenidos.`);
    return 2;
  }
  return 0;
}

async function main(): Promise<void> {
  const arg = (f: string) => {
    const i = process.argv.indexOf(f);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const stage = arg("--stage") ?? "dev";
  if (!isMemoryStage(stage)) throw new Error("--stage pilot|dev|eval");
  const guardArg = arg("--guard");
  const budgetEur = Number(guardArg ?? 200);
  const watch = Number(arg("--watch") ?? 0);
  if (!watch) {
    process.exitCode = snapshot(stage, budgetEur, guardArg !== undefined);
    return;
  }
  const guard = guardArg !== undefined;
  let failures = 0;
  for (;;) {
    process.stdout.write("\x1b[2J\x1b[H");
    try {
      const code = snapshot(stage, budgetEur, guard);
      failures = 0;
      if (code) {
        process.exitCode = code;
        return;
      }
    } catch (err) {
      // Un vigilante que no puede medir el gasto no vigila nada: tras tres
      // fallos seguidos detiene el runner en vez de seguir en silencio.
      failures++;
      console.error(`No se pudo medir el gasto (${failures}/3): ${err instanceof Error ? err.message : err}`);
      if (guard && failures >= 3) {
        stopRunners();
        console.error("⛔ Sin medida de gasto: runner y juez detenidos por precaución.");
        process.exitCode = 3;
        return;
      }
    }
    await new Promise((r) => setTimeout(r, watch * 1000));
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
