// memory-v1, seguimiento — A1N: memoria estructurada con las noticias del año
// anterior (followup-prereg.json).
//
// Es A1 tal cual (perfil inicial, trayectoria recortada, sin historial plano)
// más un solo canal de A1G: las noticias simuladas del año anterior, las mismas
// y en el mismo bloque del prompt. Separa una de las diferencias entre A1 y A1G:
// si las contradicciones de A1 vienen de no ver esas noticias, A1N debería
// acercarse a la plana. Lo comprueba architectures.test.ts sobre el mismo estado.

import { AgentArchitecture, CountryYearTask } from "../types";
import { A1GroundedArchitecture } from "./a1-grounded";
import { AgentInputs, experimentAgent, IndicatorSource, promptBundleFor, runAgent } from "./shared";

export class A1NStructuredNewsArchitecture implements AgentArchitecture {
  readonly id = "A1N" as const;
  private agent = experimentAgent();
  private readonly structured: A1GroundedArchitecture;

  constructor(private readonly indicators: IndicatorSource = new IndicatorSource()) {
    this.structured = new A1GroundedArchitecture(indicators);
  }

  inputs(task: CountryYearTask): AgentInputs {
    return {
      ...this.structured.inputs(task),
      priorSimNews: task.state.priorSimNewsByCountry[task.country] ?? [],
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
