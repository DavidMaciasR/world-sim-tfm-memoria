// memory-v1 — el estudio de memoria plana (A1G) frente a estructurada (A1).
// Cohortes, ventanas y nombres de tirada del RUNBOOK §2, en un solo sitio y sin
// efectos: el CLI y los tests leen de aquí, así que una cohorte no puede
// cambiar en uno sin cambiar en el otro.

import path from "path";
import type { ArchitectureId, ExperimentSpec } from "./types";

export const MEMORY_STUDY = "memory-v1";

export type MemoryStage = "pilot" | "dev" | "eval";
export type MemoryCondition = "A1G" | "A1";

export const MEMORY_CONDITIONS: readonly MemoryCondition[] = ["A1G", "A1"];

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
};

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");

/** La evaluación no se lanza sin el diseño congelado (RUNBOOK §4.3). */
export const FREEZE_MANIFEST = path.join(REPO_ROOT, "docs", "tfm", "results", MEMORY_STUDY, "freeze.json");

export function isMemoryStage(value: string): value is MemoryStage {
  return value === "pilot" || value === "dev" || value === "eval";
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
    throw new Error(`Etapa "${input.stage}" desconocida: usa pilot, dev o eval`);
  }
  const arch = input.arch.toUpperCase() as ArchitectureId;
  if (arch !== "A1G" && arch !== "A1") {
    throw new Error(`${MEMORY_STUDY} solo compara A1G y A1; "${input.arch}" queda fuera del estudio`);
  }
  const cohort = MEMORY_STAGES[input.stage];
  if (!Number.isInteger(input.replicate) || input.replicate < 1 || input.replicate > cohort.replicates) {
    throw new Error(
      `Replicado ${input.replicate} fuera de rango para ${input.stage}: válidos 1..${cohort.replicates}`
    );
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

/** Replicados impares: A1G y luego A1; pares: A1 y luego A1G (RUNBOOK §2.3). */
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
