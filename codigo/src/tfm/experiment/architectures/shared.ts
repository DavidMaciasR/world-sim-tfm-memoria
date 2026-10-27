// Piezas comunes a las arquitecturas del experimento. Existen para que las
// condiciones solo puedan diferir en lo que declaran: el generador, la llamada
// al agente y los indicadores salen de aquí, y cada arquitectura aporta
// únicamente sus canales de memoria (AgentInputs).

import fs from "fs";
import path from "path";
import {
  CountryAgent, GeneratorUsageEvent,
  type AnalysisPromptBundle,
  type AnalysisResult,
  type ArchitectureContext,
  type SimulatedNewsItem,
} from "../../../country-agent";
import type { HistoryEntry } from "../../../db";
import { CountryYearTask, EXPERIMENT_GENERATOR_MODEL, EXPERIMENT_MAX_OUTPUT_TOKENS, EXPERIMENT_REQUEST_TIMEOUT_MS } from "../types";
import { buildTaskWorldContext } from "../matrix-runner";
import { countrySlug } from "../../wiki-chronology";
import {
  CountryIndicators,
  formatLaggedIndicatorsForPrompt,
  INDICATOR_CANDIDATES,
} from "../../owid-indicators";

export const FUN_FACTOR = 0.35;

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..", "..");
export const INDICATORS_DIR = path.join(REPO_ROOT, "docs", "tfm", "indicators");

/** Lo que una arquitectura decide darle al agente sobre su propio pasado. */
export interface AgentInputs {
  history: HistoryEntry[];
  priorSimNews: SimulatedNewsItem[];
  architecture: ArchitectureContext;
}

/**
 * Modelo clavado, sin modelos de reserva y solo Gemini como proveedor: si
 * falla, el registro falla; nunca pasa a otro modelo ni a Perplexity.
 */
export function experimentAgent(): CountryAgent {
  return new CountryAgent(undefined, {
    geminiModel: EXPERIMENT_GENERATOR_MODEL,
    geminiFallbackModels: [],
    analysisProviders: ["gemini"],
    maxOutputTokens: EXPERIMENT_MAX_OUTPUT_TOKENS,
    // Sin los campos del juego de mapas: el estudio no los usa y newTerritoryZone.zoneKey
    // entraba en bucle (dev, Rusia 2015, 24 sep).
    mapFeatures: false,
    requestTimeoutMs: EXPERIMENT_REQUEST_TIMEOUT_MS,
    onUsage: (event) => generatorUsageSink.write?.(event),
  });
}

/**
 * Destino del consumo por llamada del generador. run-experiment lo apunta al
 * generator-usage.jsonl de su tirada: así el coste se puede recalcular sin la
 * BD local y cada llamada queda atribuida a su tirada aunque haya varias a la vez.
 */
export const generatorUsageSink: { write: ((event: GeneratorUsageEvent) => void) | null } = { write: null };

// Fecha dentro del año simulado: en un backtest el agente no debe anclarse a
// la fecha real de hoy.
const analysisDate = (simYear: number) => `${simYear}-07-01`;

export function promptBundleFor(
  agent: CountryAgent,
  task: CountryYearTask,
  inputs: AgentInputs
): AnalysisPromptBundle {
  const { country, simYear, state } = task;
  return agent.buildPromptBundle(
    country,
    buildTaskWorldContext(country, simYear, state),
    analysisDate(simYear),
    simYear,
    inputs.history,
    inputs.priorSimNews,
    [], // memoria interna del simulador: fuera del experimento
    FUN_FACTOR,
    [], // pistas de zonas territoriales: fuera del experimento
    [], // pistas de ciclo de vida
    [], // intervenciones divinas
    country,
    inputs.architecture
  );
}

/** Misma llamada que promptBundleFor, pero contra el proveedor. */
export async function runAgent(
  agent: CountryAgent,
  task: CountryYearTask,
  inputs: AgentInputs
): Promise<AnalysisResult> {
  const { country, simYear, state } = task;
  const result = await agent.analyze(
    country,
    buildTaskWorldContext(country, simYear, state),
    analysisDate(simYear),
    simYear,
    inputs.history,
    inputs.priorSimNews,
    [],
    FUN_FACTOR,
    [],
    [],
    { bypassCache: true, architecture: inputs.architecture },
    [],
    country
  );
  if (result.debugMeta?.providerStatus !== "gemini") {
    throw new Error(
      `Provider fell back to "${result.debugMeta?.providerStatus}" — experiment records must come from the real generator` +
        (result.debugMeta?.error ? `: ${result.debugMeta.error}` : "")
    );
  }
  return result;
}

/**
 * Indicadores del país con el corte del estudio (observaciones de Y-1 o antes).
 * Una sola implementación para A1G y A1: por país-año, el bloque es idéntico
 * en las dos condiciones, que es lo que permite no tratarlo como variable.
 */
export class IndicatorSource {
  private cache = new Map<string, CountryIndicators | null>();

  constructor(private readonly dir: string = INDICATORS_DIR) {}

  indicatorsFor(country: string): CountryIndicators | null {
    if (!this.cache.has(country)) {
      const file = path.join(this.dir, `${countrySlug(country)}.json`);
      this.cache.set(
        country,
        fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as CountryIndicators) : null
      );
    }
    return this.cache.get(country) ?? null;
  }

  groundingFor(country: string, simYear: number): string {
    const data = this.indicatorsFor(country);
    return data
      ? formatLaggedIndicatorsForPrompt(data, simYear)
      : `No indicators available for ${country}.`;
  }

  /** Series que este país no tiene, para registrarlas por país-año. */
  missingIndicators(country: string): string[] {
    const data = this.indicatorsFor(country);
    return data ? data.unavailable : INDICATOR_CANDIDATES.map((s) => s.id);
  }
}
