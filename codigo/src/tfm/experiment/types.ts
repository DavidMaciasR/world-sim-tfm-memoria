// Experiment matrix types. Architecture-agnostic plumbing: the
// concrete A1/A2/A3 designs plug in behind AgentArchitecture without changing
// the runner. Judging is deliberately NOT part of the generation run — it is a
// separate second pass over the persisted records (cost control, re-judgeable).

import type { AnalysisPromptBundle, AnalysisResult, SimulatedNewsItem } from "../../country-agent";
import type { StoredAnalysis, HistoryEntry, SimNewsRow } from "../../db";

export type ArchitectureId = "A0" | "A1G" | "A1" | "A1N" | "A2" | "A3";

/**
 * The single generator every experiment call runs on.
 *
 * Pinned in code, not in env: the production agent defaults to whatever the
 * environment says (2.5-pro locally, 3.5-flash-lite on the droplet), and a
 * matrix silently run on the wrong model is unrecoverable — so it must not
 * happen. Architectures construct their
 * CountryAgent with this model and an EMPTY fallback list, so a failure errors
 * out instead of switching models mid-run.
 */
export const EXPERIMENT_GENERATOR_MODEL = "gemini-3.6-flash";

/**
 * Tope de salida del generador en el experimento (producción sigue en 4096).
 * El piloto del 23 sep lo destapó: en Gemini el razonamiento cuenta contra el
 * tope, y Francia 2015 gastó 3.507 de salida + 572 de razonamiento = 4.079,
 * así que el JSON quedó sin cerrar. Un año normal ronda 900 + 2.000.
 */
export const EXPERIMENT_MAX_OUTPUT_TOKENS = 8192;

/**
 * Tiempo máximo por llamada al generador. Una llamada normal tarda 15–70 s; el
 * 24 sep una colgada (portátil suspendido) esperó 11 min antes de cortarse.
 * Con el límite, el corte cuenta como fallo transitorio y se reintenta.
 */
export const EXPERIMENT_REQUEST_TIMEOUT_MS = 120_000;

export interface ExperimentSpec {
  runId: string; // e.g. "backtest-a0-s1-2026-07-12"
  mode: "backtest" | "prospective";
  architecture: ArchitectureId;
  seed: number; // replicate label; LLM sampling is not seedable — seeds mean independent replicates
  countries: string[];
  startYear: number;
  endYear: number; // inclusive
}

/**
 * What has to be true for someone else to re-run this, or for us to know that
 * two records are comparable.
 *
 * The spec above identifies *what* was run; this identifies *under which
 * conditions*. Without it a run is resumable but not reproducible: resuming
 * after a prompt edit, a code change or a silent provider model switch would
 * mix conditions under one runId and nothing would say so. It also means that
 * a model retired mid-study leaves a trace
 * instead of a gap.
 */
export interface RunFingerprint {
  generatorModel: string; // exact id, e.g. "gemini-3.6-flash"
  judgeModel?: string; // judging is a separate pass; absent until it runs
  repoCommit: string; // git rev-parse HEAD at run time
  promptHash: string; // hash of the system+user prompt template
  referenceDataHash?: string; // chronologies + indicators actually consumed
  startedAt: string;
  notes?: string;
  /**
   * memory-v1: everything that makes two records comparable, hashed together —
   * study/cohort, model, effective decoding, and hashes of the generation code
   * and consumed data. Provenance (commit, timestamps) is deliberately outside,
   * so an evidence-only commit does not block a legitimate resume.
   */
  conditionHash?: string;
  conditions?: Record<string, unknown>;
  /** Generation-affecting files that differed from the commit at run time. */
  uncommittedFiles?: string[];
}

// Per-(run) world state chained across years — same shape the pilot used.
export interface WorldState {
  priorYearAnalysis: Record<string, StoredAnalysis>;
  priorYearSimNews: Record<string, SimNewsRow[]>;
  historyByCountry: Record<string, HistoryEntry[]>;
  priorSimNewsByCountry: Record<string, SimulatedNewsItem[]>;
}

export interface CountryYearTask {
  spec: ExperimentSpec;
  country: string;
  simYear: number;
  state: WorldState; // read-only for the architecture; the runner owns updates
}

export interface AgentArchitecture {
  id: ArchitectureId;
  /** Generate one country-year. Must not mutate task.state. */
  analyzeCountryYear(task: CountryYearTask): Promise<AnalysisResult>;
  /** The exact prompts analyzeCountryYear would send, without calling anyone. */
  promptBundle?(task: CountryYearTask): AnalysisPromptBundle;
  /** Indicator series this country lacks; absent when the architecture uses none. */
  missingIndicators?(country: string): string[];
}

export interface CountryYearRecord {
  key: string; // `${architecture}:${seed}:${country}:${simYear}` — resume identity
  runId: string;
  architecture: ArchitectureId;
  seed: number;
  country: string;
  simYear: number;
  generatedAt: string;
  status: "ok" | "error";
  error?: string;
  analysis?: Pick<
    AnalysisResult,
    "move" | "confidence" | "prediction" | "decision" | "outcome" | "simulatedNews"
  >;
  providerStatus?: string; // "gemini" | "perplexity" | "fallback"
  /**
   * Exact model that produced this record. Per-record and not just per-run:
   * a provider can switch model mid-run (the agent has a fallback list), and
   * a run whose records came from two models is not one condition.
   */
  generatorModel?: string;
  /** memory-v1: provider attempt number for this key, counted across resumes. */
  attempt?: number;
  /** Attempt beyond the configured limit, explicitly authorized from the CLI. */
  authorizedExtraAttempt?: boolean;
  /** Set when the country operated without some indicator series. */
  missingIndicators?: string[];
}

export function recordKey(spec: ExperimentSpec, country: string, simYear: number): string {
  return `${spec.architecture}:${spec.seed}:${country}:${simYear}`;
}
