// A0 "naive": the production CountryAgent as-is. Legacy baseline of
// the old architecture ladder; memory-v1 does not run it, but it
// stays as the reference the A1G prompt test compares against.

import { AgentArchitecture, CountryYearTask } from "../types";
import { AgentInputs, experimentAgent, promptBundleFor, runAgent } from "./shared";

export class A0NaiveArchitecture implements AgentArchitecture {
  readonly id = "A0" as const;
  private agent = experimentAgent();

  inputs(task: CountryYearTask): AgentInputs {
    const { country, state } = task;
    return {
      history: state.historyByCountry[country] ?? [],
      priorSimNews: state.priorSimNewsByCountry[country] ?? [],
      architecture: {},
    };
  }

  promptBundle(task: CountryYearTask) {
    return promptBundleFor(this.agent, task, this.inputs(task));
  }

  analyzeCountryYear(task: CountryYearTask) {
    return runAgent(this.agent, task, this.inputs(task));
  }
}
