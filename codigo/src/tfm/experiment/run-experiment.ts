// memory-v1 — CLI de generación: una tirada = un mundo de una condición.
//
//   cd apps/server
//   npx ts-node src/tfm/experiment/run-experiment.ts --study memory-v1 --stage pilot --arch A1G --replicate 1 --dry-run
//   npx ts-node src/tfm/experiment/run-experiment.ts --study memory-v1 --stage pilot --arch A1G --replicate 1 --yes
//
// Las cohortes salen de memory-study.ts (RUNBOOK §2). El ensayo en seco no
// llama a ningún proveedor ni escribe registros: construye los prompts reales
// del primer año y de un último año sintético a longitud máxima, para acotar
// tokens y coste. Gasta API real solo con --yes.

import "../../load-env";
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { CountryYearTask, ExperimentSpec, RunFingerprint, WorldState, EXPERIMENT_GENERATOR_MODEL } from "./types";
import { RunStore } from "./run-store";
import { emptyWorldState, isTransientProviderError, runMatrix } from "./matrix-runner";
import { architectureFor } from "./architectures";
import { FUN_FACTOR, IndicatorSource, experimentAgent, generatorUsageSink } from "./architectures/shared";
import {
  conditionOrder,
  FREEZE_MANIFEST,
  generationsPerWorld,
  MEMORY_STAGES,
  MEMORY_STUDY,
  MemoryStage,
  resolveMemoryRun,
} from "./memory-study";
import { CountryAgent } from "../../country-agent";
import { getLoreInjectionsForCountry } from "../../db";
import { countrySlug } from "../wiki-chronology";
import { latestObservationYears } from "../owid-indicators";
import { PRICES, EUR_PER_USD } from "../pricing";

const SERVER_ROOT = path.resolve(__dirname, "..", "..", "..");
const REPO_ROOT = path.resolve(SERVER_ROOT, "..", "..");
const RUNS_DIR = path.join(REPO_ROOT, "docs", "tfm", "runs");

/** Intentos de proveedor por país-año, contados entre reanudaciones (RUNBOOK §3.3). */
const MAX_ATTEMPTS = 3;

/** Todo lo que decide qué ve el generador y cómo se normaliza lo que devuelve. */
const GENERATION_CODE = [
  "src/country-agent.ts",
  "src/country-personas.ts",
  "src/world-context.ts",
  "src/intervention-prompt.ts",
  "src/tfm/structured-memory.ts",
  "src/tfm/owid-indicators.ts",
  "src/tfm/experiment/types.ts",
  "src/tfm/experiment/matrix-runner.ts",
  "src/tfm/experiment/run-store.ts",
  "src/tfm/experiment/memory-study.ts",
  "src/tfm/experiment/run-experiment.ts",
  "src/tfm/experiment/architectures/shared.ts",
  "src/tfm/experiment/architectures/a1g-grounding-only.ts",
  "src/tfm/experiment/architectures/a1-grounded.ts",
];

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (flag: string) => process.argv.includes(flag);

const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/**
 * Espera antes de reintentar. Las rachas de 503 «high demand» de Gemini duran
 * minutos (piloto del 16 y del 23 sep: tres 503 seguidos en 90 s con esperas de
 * 30 y 60 s). Esperar 2, 5 y 10 min da tiempo a que pase la racha sin gastar:
 * un 503 falla en ~1 s y no se factura. Solo cambia cuándo se reintenta, no qué
 * se genera.
 */
const RETRY_DELAYS_MS = [2 * 60_000, 5 * 60_000, 10 * 60_000];
function experimentRetryDelayMs(attempt: number): number {
  return RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length) - 1];
}

function codeHash(): string {
  const h = createHash("sha256");
  for (const f of GENERATION_CODE) {
    h.update(f);
    h.update(fs.readFileSync(path.join(SERVER_ROOT, f)));
  }
  return h.digest("hex").slice(0, 16);
}

function git(args: string[]): string {
  try {
    return execFileSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function indicatorHashes(countries: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of countries) {
    const file = path.join(REPO_ROOT, "docs", "tfm", "indicators", `${countrySlug(c)}.json`);
    out[c] = fs.existsSync(file) ? sha(fs.readFileSync(file)) : "missing";
  }
  return out;
}

/** Configuración de decodificación efectiva, leída del cuerpo que se enviaría. */
function effectiveDecoding(agent: CountryAgent): Record<string, unknown> {
  const body = (agent as any).buildGeminiRequestBody("", "") as {
    generationConfig: Record<string, unknown>;
  };
  const { responseSchema, ...rest } = body.generationConfig;
  return {
    ...rest,
    thinkingConfig: rest.thinkingConfig ?? "not set (provider default)",
    responseSchemaHash: sha(JSON.stringify(responseSchema)),
  };
}

function buildFingerprint(stage: MemoryStage, spec: ExperimentSpec, indicators: IndicatorSource): RunFingerprint {
  // La huella lee la decodificación del mismo agente que genera, no de uno
  // construido aparte que podría divergir de él.
  const decoding = effectiveDecoding(experimentAgent());
  const cutoffs: Record<string, Record<number, Record<string, number>>> = {};
  for (const c of spec.countries) {
    const data = indicators.indicatorsFor(c);
    cutoffs[c] = {};
    for (let y = spec.startYear; y <= spec.endYear; y++) {
      cutoffs[c][y] = data ? latestObservationYears(data, y) : {};
    }
  }
  const conditions = {
    study: MEMORY_STUDY,
    stage,
    architecture: spec.architecture,
    countries: spec.countries,
    years: [spec.startYear, spec.endYear],
    generatorModel: EXPERIMENT_GENERATOR_MODEL,
    fallbackModels: [],
    providers: ["gemini"],
    decoding,
    funFactor: FUN_FACTOR,
    codeHash: codeHash(),
    indicatorFiles: indicatorHashes(spec.countries),
    indicatorCutoff: "observation year <= simYear - 1",
    latestObservationYears: cutoffs,
    initialState: "empty simulated history (no production DB history)",
  };
  const dirty = git(["status", "--porcelain", "--", ...GENERATION_CODE.map((f) => `apps/server/${f}`)]);
  return {
    generatorModel: EXPERIMENT_GENERATOR_MODEL,
    repoCommit: git(["rev-parse", "--short", "HEAD"]),
    promptHash: conditions.codeHash,
    referenceDataHash: sha(JSON.stringify(conditions.indicatorFiles)),
    conditionHash: sha(JSON.stringify(conditions)),
    conditions,
    // git() recorta la salida, así que la primera línea pierde su espacio inicial.
    uncommittedFiles:
      dirty && dirty !== "unknown" ? dirty.split("\n").map((l) => l.replace(/^\s*\S{1,2}\s+/, "")) : [],
    startedAt: new Date().toISOString(),
    notes:
      `replicate ${spec.seed} is an execution label for an independent world run, not a seed: ` +
      "LLM sampling is not seedable and replicate numbers are not paired across conditions.",
  };
}

// Longitudes máximas que deja pasar la normalización (cleanText 180, titular 80,
// cuerpo 180): el último año sintético acota por arriba el prompt real.
function syntheticLastYearState(spec: ExperimentSpec): WorldState {
  const state = emptyWorldState(spec.countries);
  const text = (n: number, seed: string) => `${seed} `.repeat(Math.ceil(n / (seed.length + 1))).slice(0, n);
  const last = spec.endYear - 1;
  for (const c of spec.countries) {
    for (let y = spec.startYear; y <= last; y++) {
      state.historyByCountry[c].push({
        sim_year: y,
        sim_month: `${y}-07`,
        move: text(180, "procurement"),
        confidence: "MEDIUM",
        prediction: text(180, "escalation"),
      });
    }
    state.historyByCountry[c] = state.historyByCountry[c].slice(-10);
    state.priorSimNewsByCountry[c] = Array.from({ length: 12 }, (_, i) => ({
      month: i + 1,
      headline: text(80, "headline"),
      body: text(180, "analysis"),
      tone: "neutral",
      sources: [],
    }));
    state.priorYearAnalysis[c] = {
      country: c,
      sim_month: `${last}-07`,
      sim_year: last,
      move: text(180, "procurement"),
      confidence: "MEDIUM",
      sources: [],
      prediction: text(180, "escalation"),
    };
  }
  return state;
}

// ~4 caracteres por token: estimación, no recuento del proveedor.
const approxTokens = (chars: number) => Math.round(chars / 4);

function dryRunReport(stage: MemoryStage, spec: ExperimentSpec): void {
  const architecture = architectureFor(spec.architecture);
  const first = { spec, simYear: spec.startYear, state: emptyWorldState(spec.countries) };
  const lastState = syntheticLastYearState(spec);

  console.log("\nPrompts (tokens aprox. = caracteres / 4):");
  let firstTotal = 0;
  let lastTotal = 0;
  for (const country of spec.countries) {
    const t1: CountryYearTask = { ...first, country };
    const tN: CountryYearTask = { spec, country, simYear: spec.endYear, state: lastState };
    const size = (t: CountryYearTask) => {
      const b = architecture.promptBundle!(t);
      return approxTokens(b.systemPrompt.length + b.userPrompt.length);
    };
    const s1 = size(t1);
    const sN = size(tN);
    firstTotal += s1;
    lastTotal += sN;
    console.log(`  ${country.padEnd(14)} ${spec.startYear}: ~${s1} · ${spec.endYear} (cota sintética): ~${sN}`);
  }

  const price = PRICES[EXPERIMENT_GENERATOR_MODEL];
  const n = spec.countries.length;
  const avgInput = (firstTotal + lastTotal) / 2 / n;
  console.log(`\nCoste por país-año (${EXPERIMENT_GENERATOR_MODEL}: ${price.inputUsdPerMTok}/${price.outputUsdPerMTok} USD por M tokens, tabla de jul. 2026):`);
  for (const [label, out] of [
    ["salida visible sola (~1.2k)", 1200],
    ["+ ~3k de razonamiento", 4200],
    ["+ ~9k de razonamiento", 10200],
  ] as const) {
    const usd = (avgInput * price.inputUsdPerMTok + out * price.outputUsdPerMTok) / 1e6;
    const world = usd * generationsPerWorld(stage);
    console.log(
      `  ${label.padEnd(30)} ${(usd * EUR_PER_USD * 100).toFixed(2)} cts €/país-año · ${(world * EUR_PER_USD).toFixed(2)} €/mundo`
    );
  }
  console.log("  (el razonamiento no está fijado en la petición: el piloto mide el real)");
}

async function main(): Promise<void> {
  const study = arg("--study");
  const stageArg = arg("--stage") ?? "";
  const archArg = arg("--arch") ?? "";
  const replicate = Number(arg("--replicate"));

  if (study !== MEMORY_STUDY) {
    console.error(
      `Uso: run-experiment.ts --study ${MEMORY_STUDY} --stage pilot|dev|eval --arch A1G|A1 --replicate N [--dry-run|--yes]\n` +
        "  --dry-run  muestra spec, huella, prompts y coste estimado; no llama a nadie ni escribe nada\n" +
        "  --yes      confirma el gasto de API\n" +
        `  --extra-attempts N  autoriza N intentos más allá de ${MAX_ATTEMPTS} (quedan registrados)`
    );
    process.exit(2);
  }

  let spec: ExperimentSpec;
  try {
    spec = resolveMemoryRun({ stage: stageArg, arch: archArg, replicate });
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
  const stage = stageArg as MemoryStage;
  const indicators = new IndicatorSource();
  const fingerprint = buildFingerprint(stage, spec, indicators);

  console.log("Spec:        ", JSON.stringify(spec));
  console.log("Condición:   ", fingerprint.conditionHash, `(código ${fingerprint.promptHash}, commit ${fingerprint.repoCommit})`);
  console.log("Decodificación:", JSON.stringify(fingerprint.conditions!.decoding));
  if (fingerprint.uncommittedFiles!.length > 0) {
    console.log("Sin commitear:", fingerprint.uncommittedFiles!.join(", "));
  }
  console.log(`Tamaño:        ${spec.countries.length} países × ${spec.endYear - spec.startYear + 1} años = ${generationsPerWorld(stage)} generaciones`);
  console.log(
    `Orden:         replicado ${replicate} corre ${conditionOrder(replicate).join(" y luego ")}; ` +
      `${MEMORY_STAGES[stage].replicates} mundo(s) por condición en ${stage}`
  );

  const missing = spec.countries.filter((c) => !indicators.indicatorsFor(c));
  const lore = spec.countries.filter((c) => getLoreInjectionsForCountry(c).length > 0);
  const runDir = path.join(RUNS_DIR, spec.runId);
  const existing = fs.existsSync(path.join(runDir, "records.jsonl"))
    ? fs.readFileSync(path.join(runDir, "records.jsonl"), "utf8").split("\n").filter((l) => l.includes('"status":"ok"')).length
    : 0;
  console.log(`Indicadores:   ${missing.length ? `FALTAN para ${missing.join(", ")}` : "presentes para todos"}`);
  console.log(`Lore en BD:    ${lore.length ? `PRESENTE para ${lore.join(", ")} — contaminaría el prompt` : "ninguno"}`);
  console.log(`Tirada previa: ${existing ? `${existing} registros aceptados en ${path.relative(REPO_ROOT, runDir)} (se reanudaría)` : "no existe"}`);

  const frozen = fs.existsSync(FREEZE_MANIFEST);
  if (stage === "eval") {
    console.log(`Congelación:   eval exige ${path.relative(REPO_ROOT, FREEZE_MANIFEST)} — ${frozen ? "presente" : "NO existe"}`);
  }

  if (has("--dry-run")) {
    dryRunReport(stage, spec);
    console.log("\n(dry-run: ninguna llamada a proveedores, ningún registro escrito)");
    return;
  }
  if (!has("--yes")) {
    console.error("\nEsto gasta API real. Añade --yes para confirmar, o --dry-run para inspeccionar.");
    process.exit(1);
  }
  if (stage === "eval" && !frozen) throw new Error("Evaluación sin freeze.json: congela el diseño antes");
  if (missing.length > 0) throw new Error(`Sin indicadores para ${missing.join(", ")}`);
  if (lore.length > 0) throw new Error(`La BD local tiene lore para ${lore.join(", ")}: entraría en el prompt`);
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing — abortando antes de gastar");

  const extraAttempts = Number(arg("--extra-attempts") ?? 0);
  if (!Number.isInteger(extraAttempts) || extraAttempts < 0) throw new Error("--extra-attempts debe ser un entero >= 0");

  const architecture = architectureFor(spec.architecture);
  const store = new RunStore(RUNS_DIR, spec, fingerprint, { strictConditions: true });
  const usageFile = path.join(RUNS_DIR, spec.runId, "generator-usage.jsonl");
  generatorUsageSink.write = (event) =>
    fs.appendFileSync(usageFile, JSON.stringify({ ...event, runId: spec.runId }) + "\n");
  const summary = await runMatrix(spec, {
    store,
    architecture,
    stopOnError: true,
    maxAttempts: MAX_ATTEMPTS,
    extraAttempts,
    isRetryable: isTransientProviderError,
    retryDelayMs: experimentRetryDelayMs,
    annotateRecord: ({ country }) => ({
      generatorModel: EXPERIMENT_GENERATOR_MODEL,
      missingIndicators: architecture.missingIndicators?.(country) ?? [],
    }),
    onRecord: (r) =>
      console.log(
        `  ${r.status === "ok" ? "✓" : "✗"} ${r.country} ${r.simYear}${r.status === "error" ? ` — ${r.error?.slice(0, 120)}` : ""}`
      ),
  });

  console.log(`\nResumen: ${summary.generated} generados · ${summary.skipped} saltados · ${summary.errors} errores`);
  console.log(`Registros en ${path.relative(REPO_ROOT, store.directory)}/records.jsonl`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
