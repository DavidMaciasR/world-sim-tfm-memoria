// memory-v1 — A1, memoria estructurada (RUNBOOK §1, cap. 4 "Las dos condiciones").
//
// Mismos indicadores que A1G. Lo que cambia es la política de memoria, que
// selecciona, comprime y presenta:
//
//   - perfil inicial del país (aliados, rivales, doctrina, prioridades),
//     etiquetado como punto de partida: lo simulado después manda;
//   - trayectoria: los tres años recientes con detalle y los anteriores
//     recortados a una línea. Es recorte por caracteres, no un resumen
//     semántico;
//   - los canales planos (historial estratégico y noticias previas) se
//     suprimen.
//
// No es la misma información reformateada: A1 deja de ver las noticias y
// recorta movimientos y predicciones. El efecto que se mida es el de esta
// política completa, no el del formato.

import { personaFor } from "../../../country-personas";
import { AgentArchitecture, CountryYearTask } from "../types";
import {
  formatStructuredMemory,
  episodicFromHistory,
  SemanticProfile,
} from "../../structured-memory";
import { AgentInputs, experimentAgent, IndicatorSource, promptBundleFor, runAgent } from "./shared";

export class A1GroundedArchitecture implements AgentArchitecture {
  readonly id = "A1" as const;
  private agent = experimentAgent();

  constructor(private readonly indicators: IndicatorSource = new IndicatorSource()) {}

  private initialProfile(country: string): SemanticProfile {
    const persona = personaFor(country);
    return {
      country,
      allies: persona?.allies ?? [],
      rivals: persona?.rivals ?? [],
      doctrine: persona?.style,
      priorities: persona?.priorities,
    };
  }

  inputs(task: CountryYearTask): AgentInputs {
    const { country, simYear, state } = task;
    return {
      history: [], // suprimido: lo sustituye la trayectoria
      priorSimNews: [], // suprimido
      architecture: {
        grounding: this.indicators.groundingFor(country, simYear),
        structuredMemory: formatStructuredMemory(
          this.initialProfile(country),
          episodicFromHistory(state.historyByCountry[country] ?? [])
        ),
      },
    };
  }

  promptBundle(task: CountryYearTask) {
    return promptBundleFor(this.agent, task, this.inputs(task));
  }

  analyzeCountryYear(task: CountryYearTask) {
    return runAgent(this.agent, task, this.inputs(task));
  }

  missingIndicators(country: string): string[] {
    return this.indicators.missingIndicators(country);
  }
}
