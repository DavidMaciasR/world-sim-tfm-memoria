// memory-v1 — el estudio de memoria plana (A1G) frente a estructurada (A1), y el
// seguimiento con la estructurada más las noticias del año anterior (A1N).
// Cohortes, ventanas y nombres de tirada, en un solo sitio y sin
// efectos: el CLI y los tests leen de aquí, así que una cohorte no puede
// cambiar en uno sin cambiar en el otro.

import path from "path";
import type { ArchitectureId, ExperimentSpec } from "./types";

export const MEMORY_STUDY = "memory-v1";

export type MemoryStage = "pilot" | "dev" | "eval" | "followup";
export type MemoryCondition = "A1G" | "A1" | "A1N";

export const MEMORY_CONDITIONS: readonly MemoryCondition[] = ["A1G", "A1"];

/** Nombre de cada condición en tablas y figuras. */
export const CONDITION_LABEL: Record<MemoryCondition, string> = {
  A1G: "plana",
  A1: "estructurada",
  A1N: "estructurada+noticias",
};

export interface StageCohort {
  /** Orden fijo dentro del mundo: es el orden de generación de cada año. */
  countries: readonly string[];
  startYear: number;
  endYear: number; // inclusive
  /** Mundos por condición: los replicados válidos son 1..replicates. */
  replicates: number;
}

export const MEMORY_STAGES: Record<MemoryStage, StageCohort> = {
  pilot: { countries: ["Germany", "France"], startYear: 2015, endYear: 2019, replicates: 1 },
  dev: { countries: ["Germany", "France", "Russia"], startYear: 2015, endYear: 2024, replicates: 1 },
  eval: {
    countries: ["United States", "China", "India", "Pakistan"],
    startYear: 2015,
    endYear: 2024,
    // 10 mundos por condición (24 sep): con 5, las contradicciones son tan raras
    // (0,1–0,2 por país-año en desarrollo) que la diferencia mínima detectable
    // (~0,08) superaba la observada en desarrollo (0,07); con 10 baja a ~0,055.
    replicates: 10,
  },
  // Seguimiento posterior a la congelación (8 oct, tras una revisión externa):
  // la estructurada con las mismas noticias del año anterior que la plana (A1N),
  // misma cohorte que eval. Solo corre A1N: plana y estructurada se comparan
  // con las tiradas ya hechas de eval. Prerregistro en
  // docs/tfm/results/memory-v1/followup-prereg.json.
  followup: {
    countries: ["United States", "China", "India", "Pakistan"],
    startYear: 2015,
    endYear: 2024,
    replicates: 10,
  },
};

/** Condiciones de cada etapa: el seguimiento solo corre la condición nueva. */
export function conditionsFor(stage: MemoryStage): readonly MemoryCondition[] {
  return stage === "followup" ? ["A1N"] : MEMORY_CONDITIONS;
}

/** Mundos de una condición en una etapa. */
export function replicatesFor(stage: MemoryStage, _arch: MemoryCondition): number {
  return MEMORY_STAGES[stage].replicates;
}

/** Todas las tiradas de una etapa, en orden de mundo. */
export function stageRuns(stage: MemoryStage): { arch: MemoryCondition; replicate: number }[] {
  const out: { arch: MemoryCondition; replicate: number }[] = [];
  for (let r = 1; r <= MEMORY_STAGES[stage].replicates; r++) {
    for (const arch of conditionsFor(stage)) if (r <= replicatesFor(stage, arch)) out.push({ arch, replicate: r });
  }
  return out;
}

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");

/** La evaluación no se lanza sin el diseño congelado. */
export const FREEZE_MANIFEST = path.join(REPO_ROOT, "docs", "tfm", "results", MEMORY_STUDY, "freeze.json");

/** El seguimiento no se lanza sin su prerregistro (hipótesis y regla de lectura). */
export const FOLLOWUP_PREREG = path.join(REPO_ROOT, "docs", "tfm", "results", MEMORY_STUDY, "followup-prereg.json");

export function isMemoryStage(value: string): value is MemoryStage {
  return value === "pilot" || value === "dev" || value === "eval" || value === "followup";
}

export function memoryRunId(stage: MemoryStage, arch: MemoryCondition, replicate: number): string {
  return `${MEMORY_STUDY}-${stage}-${arch.toLowerCase()}-r${replicate}`;
}

/**
 * Traduce etapa + condición + replicado a la spec del runner, o falla con un
 * mensaje que dice qué está fuera del estudio. El replicado va al campo `seed`
 * del runner, pero no es una semilla: el muestreo del LLM no se puede fijar, y
 * r1 de A1G no está emparejado con r1 de A1. Es solo la etiqueta del mundo.
 */
export function resolveMemoryRun(input: {
  stage: string;
  arch: string;
  replicate: number;
}): ExperimentSpec {
  if (!isMemoryStage(input.stage)) {
    throw new Error(`Etapa "${input.stage}" desconocida: usa pilot, dev, eval o followup`);
  }
  const arch = input.arch.toUpperCase() as MemoryCondition;
  const allowed = conditionsFor(input.stage);
  if (!allowed.includes(arch)) {
    throw new Error(`${MEMORY_STUDY}/${input.stage} solo admite ${allowed.join(" y ")}; "${input.arch}" queda fuera del estudio`);
  }
  const cohort = MEMORY_STAGES[input.stage];
  const max = replicatesFor(input.stage, arch);
  if (!Number.isInteger(input.replicate) || input.replicate < 1 || input.replicate > max) {
    throw new Error(`Replicado ${input.replicate} fuera de rango para ${input.stage}/${arch}: válidos 1..${max}`);
  }
  return {
    runId: memoryRunId(input.stage, arch, input.replicate),
    mode: "backtest",
    architecture: arch,
    seed: input.replicate,
    countries: [...cohort.countries],
    startYear: cohort.startYear,
    endYear: cohort.endYear,
  };
}

/** Replicados impares: A1G y luego A1; pares: A1 y luego A1G. */
export function conditionOrder(replicate: number): MemoryCondition[] {
  return replicate % 2 === 1 ? ["A1G", "A1"] : ["A1", "A1G"];
}

export function generationsPerWorld(stage: MemoryStage): number {
  const c = MEMORY_STAGES[stage];
  return c.countries.length * (c.endYear - c.startYear + 1);
}

/** País-años con pasado propio: los que el juez de coherencia puede puntuar. */
export function judgeableCountryYearsPerWorld(stage: MemoryStage): number {
  const c = MEMORY_STAGES[stage];
  return c.countries.length * (c.endYear - c.startYear);
}
