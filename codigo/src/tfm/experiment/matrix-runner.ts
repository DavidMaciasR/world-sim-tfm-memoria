// TFM F3a — matrix runner: executes one ExperimentSpec (one architecture ×
// one seed × N countries × M chained years) with resumability and per-record
// error capture. World state chains across years exactly like the F0a pilot.
//
// Judging is a separate pass over records.jsonl — not done here.

import { buildWorldContext } from "../../world-context";
import type { StoredAnalysis, SimNewsRow } from "../../db";
import type { AnalysisResult, SimulatedNewsItem } from "../../country-agent";
import {
  AgentArchitecture,
  CountryYearRecord,
  CountryYearTask,
  ExperimentSpec,
  WorldState,
  recordKey,
} from "./types";
import { RunStore } from "./run-store";

export interface MatrixRunOptions {
  store: RunStore;
  architecture: AgentArchitecture;
  /** Initial per-country history (e.g. from DB for prospective, empty for backtest). */
  initialState?: Partial<WorldState>;
  onRecord?: (record: CountryYearRecord) => void;
  /**
   * Extra fields stamped onto every record before it is persisted — e.g. the
   * pinned generator model (R13) or the indicator series a country lacked (R9).
   * A hook rather than fixed options so the runner stays architecture-agnostic.
   */
  annotateRecord?: (task: CountryYearTask) => Partial<CountryYearRecord>;
  /** Stop the whole run after this many consecutive errors (circuit breaker). */
  maxConsecutiveErrors?: number;
  /**
   * Stop at the first failed country-year, before the year advances. Without
   * it the run carries on and later years are generated without the failed
   * item; a resume would then fill the gap while keeping descendants that never
   * saw it. memory-v1 sets this until the full recovery of RUNBOOK §3.3 exists.
   */
  stopOnError?: boolean;
  /**
   * Provider attempts per country-year, counted across resumes from the
   * persisted error records (RUNBOOK §3.3). Unset keeps the legacy behaviour:
   * one attempt per session, no memory of earlier failures.
   */
  maxAttempts?: number;
  /** Extra attempts explicitly authorized for this session; they are logged, counters are not reset. */
  extraAttempts?: number;
  /** Whether a failure may be retried at the same item (transient vs billing/auth/config). */
  isRetryable?: (message: string) => boolean;
  /** Wait before retry number `attempt` (1-based count of failures so far). */
  retryDelayMs?: (attempt: number) => number;
}

/** Billing, auth and configuration errors stop at once; overload, rate limit and network are retried. */
export function isTransientProviderError(message: string): boolean {
  const m = message.toLowerCase();
  if (/quota|billing|insufficient|401|403|unauthori[sz]ed|permission|invalid api key|api key|400|not found|404/.test(m)) {
    return false;
  }
  // «No JSON object in response»: la salida se cortó (tope de tokens) o vino
  // malformada; otra muestra puede salir bien, así que se reintenta.
  return /\b(429|500|502|503|504|529)\b|unavailable|overloaded|high demand|rate limit|timeout|timed out|fetch failed|econnreset|socket hang up|no json object in response/.test(m);
}

export function emptyWorldState(countries: string[]): WorldState {
  const state: WorldState = {
    priorYearAnalysis: {},
    priorYearSimNews: {},
    historyByCountry: {},
    priorSimNewsByCountry: {},
  };
  for (const country of countries) {
    state.historyByCountry[country] = [];
    state.priorSimNewsByCountry[country] = [];
  }
  return state;
}

export function buildTaskWorldContext(
  country: string,
  simYear: number,
  state: WorldState
): ReturnType<typeof buildWorldContext> {
  return buildWorldContext(country, simYear, state.priorYearAnalysis, [], state.priorYearSimNews, []);
}

function toSimNewsRows(country: string, simYear: number, news: SimulatedNewsItem[]): SimNewsRow[] {
  return news.map((n, i) => ({
    id: -(i + 1),
    country,
    sim_year: simYear,
    sim_month: n.month,
    headline: n.headline,
    body: n.body,
    tone: n.tone,
    sources: n.sources ?? [],
    created_at: new Date().toISOString(),
  }));
}

function chainState(
  state: WorldState,
  country: string,
  simYear: number,
  result: AnalysisResult,
  nextPriorAnalysis: Record<string, StoredAnalysis>,
  nextPriorSimNews: Record<string, SimNewsRow[]>
): void {
  nextPriorAnalysis[country] = {
    country,
    sim_month: `${simYear}-07`,
    sim_year: simYear,
    move: result.move,
    confidence: result.confidence,
    sources: result.sources,
    prediction: result.prediction,
  };
  nextPriorSimNews[country] = toSimNewsRows(country, simYear, result.simulatedNews);
  state.priorSimNewsByCountry[country] = result.simulatedNews;
  state.historyByCountry[country] = [
    ...state.historyByCountry[country],
    {
      sim_year: simYear,
      sim_month: `${simYear}-07`,
      move: result.move,
      confidence: result.confidence,
      prediction: result.prediction,
    },
  ].slice(-10);
}

export async function runMatrix(spec: ExperimentSpec, options: MatrixRunOptions): Promise<{
  generated: number;
  skipped: number;
  errors: number;
}> {
  const { store, architecture } = options;
  if (architecture.id !== spec.architecture) {
    throw new Error(`Spec wants ${spec.architecture} but got architecture ${architecture.id}`);
  }
  const maxConsecutiveErrors = options.maxConsecutiveErrors ?? 3;

  const state: WorldState = {
    ...emptyWorldState(spec.countries),
    ...options.initialState,
  };

  let generated = 0;
  let skipped = 0;
  let errors = 0;
  let consecutiveErrors = 0;

  // Prefetch persisted ok-records once for resume-time state rebuilding.
  const persisted = new Map<string, CountryYearRecord>();
  const failedAttempts = new Map<string, number>();
  for (const r of store.readAll()) {
    if (r.status === "ok" && r.analysis) persisted.set(r.key, r);
    if (r.status === "error") failedAttempts.set(r.key, (failedAttempts.get(r.key) ?? 0) + 1);
  }
  const countAttempts = options.maxAttempts !== undefined;
  const attemptLimit = (options.maxAttempts ?? 1) + (options.extraAttempts ?? 0);
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  for (let simYear = spec.startYear; simYear <= spec.endYear; simYear++) {
    const nextPriorAnalysis: Record<string, StoredAnalysis> = {};
    const nextPriorSimNews: Record<string, SimNewsRow[]> = {};

    for (const country of spec.countries) {
      const key = recordKey(spec, country, simYear);
      if (store.has(key)) {
        skipped++;
        // NOTE(resume): chained world state for skipped records is rebuilt from
        // the persisted analysis so the next year sees consistent priors.
        const prior = persisted.get(key);
        if (prior?.analysis) {
          chainState(
            state,
            country,
            simYear,
            { ...prior.analysis, sources: [], notes: "", territoryEvent: null, countryLifecycleEvent: null } as AnalysisResult,
            nextPriorAnalysis,
            nextPriorSimNews
          );
        }
        continue;
      }

      let previousFailures = countAttempts ? failedAttempts.get(key) ?? 0 : 0;
      if (previousFailures >= attemptLimit) {
        throw new Error(
          `Stopping run "${spec.runId}" at ${country} ${simYear}: ${previousFailures} attempts already used ` +
            `(limit ${attemptLimit}); an extra attempt needs explicit authorization`
        );
      }

      for (;;) {
        const attempt = previousFailures + 1;
        const record: CountryYearRecord = {
          key,
          runId: spec.runId,
          architecture: spec.architecture,
          seed: spec.seed,
          country,
          simYear,
          generatedAt: new Date().toISOString(),
          status: "ok",
          ...(countAttempts ? { attempt } : {}),
          ...(countAttempts && attempt > (options.maxAttempts ?? 1) ? { authorizedExtraAttempt: true } : {}),
        };

        try {
          const result = await architecture.analyzeCountryYear({ spec, country, simYear, state });
          record.analysis = {
            move: result.move,
            confidence: result.confidence,
            prediction: result.prediction,
            decision: result.decision,
            outcome: result.outcome,
            simulatedNews: result.simulatedNews,
          };
          record.providerStatus = result.debugMeta?.providerStatus;
          chainState(state, country, simYear, result, nextPriorAnalysis, nextPriorSimNews);
          generated++;
          consecutiveErrors = 0;
        } catch (err) {
          record.status = "error";
          record.error = err instanceof Error ? err.message.slice(0, 500) : String(err);
          errors++;
          consecutiveErrors++;
        }

        if (options.annotateRecord) {
          Object.assign(record, options.annotateRecord({ spec, country, simYear, state }));
        }
        store.append(record);
        options.onRecord?.(record);
        if (record.status === "ok") break;

        previousFailures = attempt;
        const retryable = countAttempts && (options.isRetryable?.(record.error ?? "") ?? false);
        if (retryable && attempt < attemptLimit) {
          await sleep(options.retryDelayMs?.(attempt) ?? 0);
          continue;
        }
        if (options.stopOnError) {
          throw new Error(
            `Stopping run "${spec.runId}" at ${country} ${simYear} before advancing the year` +
              (countAttempts ? ` (attempt ${attempt}/${attemptLimit}${retryable ? "" : ", not retryable"})` : "") +
              `: ${record.error}`
          );
        }
        if (consecutiveErrors >= maxConsecutiveErrors) {
          throw new Error(
            `Aborting run "${spec.runId}": ${consecutiveErrors} consecutive errors (last: ${record.error})`
          );
        }
        break;
      }
    }

    state.priorYearAnalysis = nextPriorAnalysis;
    state.priorYearSimNews = nextPriorSimNews;
  }

  return { generated, skipped, errors };
}
