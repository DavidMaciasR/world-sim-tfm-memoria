// memory-v1 — A1G, memoria plana (RUNBOOK §1, cap. 4 "Las dos condiciones").
//
// Los mismos indicadores que A1 y los canales planos que ya tenía A0: el
// historial estratégico y las noticias simuladas del año anterior. Ni perfil
// repetido ni trayectoria comprimida. Frente a A0 solo añade el bloque de
// indicadores, así que frente a A1 la única diferencia es la política de
// memoria (lo comprueba architectures.test.ts sobre el mismo estado).

import { AgentArchitecture, CountryYearTask } from "../types";
import { AgentInputs, experimentAgent, IndicatorSource, promptBundleFor, runAgent } from "./shared";

export class A1GGroundingOnlyArchitecture implements AgentArchitecture {
  readonly id = "A1G" as const;
  private agent = experimentAgent();

  constructor(private readonly indicators: IndicatorSource = new IndicatorSource()) {}

  inputs(task: CountryYearTask): AgentInputs {
    const { country, simYear, state } = task;
    return {
      history: state.historyByCountry[country] ?? [],
      priorSimNews: state.priorSimNewsByCountry[country] ?? [],
      architecture: { grounding: this.indicators.groundingFor(country, simYear) },
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
