// memory-v1: las dos condiciones solo pueden diferir en la política de memoria.
// Sobre el mismo estado del mundo se construyen los prompts de A0, A1G y A1 sin
// llamar a nadie, y se comprueba bloque a bloque qué cambia.

import assert from "node:assert/strict";
import test from "node:test";
import { emptyWorldState } from "./matrix-runner";
import { CountryYearTask, ExperimentSpec, WorldState } from "./types";
import {
  A0NaiveArchitecture,
  A1GGroundingOnlyArchitecture,
  A1GroundedArchitecture,
} from "./architectures";
import { IndicatorSource } from "./architectures/shared";

const COUNTRIES = ["Germany", "France", "Russia"];
const SIM_YEAR = 2019;

function fixtureState(): WorldState {
  const state = emptyWorldState(COUNTRIES);
  state.historyByCountry.Germany = [2015, 2016, 2017, 2018].map((y) => ({
    sim_year: y,
    sim_month: `${y}-07`,
    move: `Germany ${y}: Bundeswehr procurement package and Baltic air-policing rotation expanded`,
    confidence: "MEDIUM",
    prediction: `Prediction ${y}: Moscow answers with exercises near Kaliningrad`,
  }));
  state.priorSimNewsByCountry.Germany = [
    { month: 1, headline: "Berlin signs Baltic rotation deal", body: "Body one.", tone: "neutral", sources: [] },
    { month: 2, headline: "Bundestag approves drone procurement", body: "Body two.", tone: "neutral", sources: [] },
  ];
  for (const peer of ["France", "Russia"]) {
    state.priorYearAnalysis[peer] = {
      country: peer,
      sim_month: "2018-07",
      sim_year: 2018,
      move: `${peer} move of 2018`,
      confidence: "HIGH",
      sources: [],
      prediction: `${peer} prediction of 2018`,
    };
  }
  return state;
}

function task(): CountryYearTask {
  const spec: ExperimentSpec = {
    runId: "fixture",
    mode: "backtest",
    architecture: "A1G",
    seed: 1,
    countries: COUNTRIES,
    startYear: 2015,
    endYear: 2019,
  };
  return { spec, country: "Germany", simYear: SIM_YEAR, state: fixtureState() };
}

const indicators = new IndicatorSource();
const a0 = new A0NaiveArchitecture();
const a1g = new A1GGroundingOnlyArchitecture(indicators);
const a1 = new A1GroundedArchitecture(indicators);

const groundingBlock = (text: string) =>
  `\nREAL-WORLD INDICATORS (observations dated before this simulated year — do not assume later values):\n${text}\n`;

test("A1G es A0 más el bloque de indicadores, y nada más", () => {
  const t = task();
  const base = a0.promptBundle(t);
  const flat = a1g.promptBundle(t);
  const grounding = a1g.inputs(t).architecture.grounding!;

  assert.equal(flat.userPrompt, base.userPrompt);
  assert.ok(flat.systemPrompt.includes(groundingBlock(grounding)));
  assert.equal(flat.systemPrompt.replace(groundingBlock(grounding), ""), base.systemPrompt);
  // Los canales planos siguen ahí.
  assert.match(flat.systemPrompt, /STRATEGIC HISTORY/);
  assert.match(flat.systemPrompt, /SIMULATED NEWS HISTORY/);
  assert.doesNotMatch(flat.systemPrompt, /STRUCTURED MEMORY/);
});

test("A1G y A1 reciben exactamente los mismos indicadores, con corte en Y-1", () => {
  const t = task();
  const g1 = a1g.inputs(t).architecture.grounding;
  const g2 = a1.inputs(t).architecture.grounding;
  assert.equal(g1, g2);
  assert.match(g1!, /Real-world indicators for Germany, observations dated 2018 or earlier/);
  assert.doesNotMatch(g1!, /\b2019\b/);
});

test("A1 cambia solo la memoria: suprime los canales planos y añade perfil inicial y trayectoria", () => {
  const t = task();
  const structured = a1.promptBundle(t);
  const inputs = a1.inputs(t);

  assert.equal(structured.userPrompt, a0.promptBundle(t).userPrompt);
  assert.doesNotMatch(structured.systemPrompt, /STRATEGIC HISTORY/);
  assert.doesNotMatch(structured.systemPrompt, /SIMULATED NEWS HISTORY/);
  assert.doesNotMatch(structured.systemPrompt, /Berlin signs Baltic rotation deal/);
  assert.match(structured.systemPrompt, /STRUCTURED MEMORY/);
  assert.match(structured.systemPrompt, /INITIAL PROFILE/);
  assert.match(structured.systemPrompt, /TRAJECTORY \(4 years; last 3 in detail/);

  // Quitados los dos bloques de arquitectura, lo que queda es el prompt de A0
  // sin memoria: todo el contenido no-memoria coincide.
  const noMemory: CountryYearTask = { ...t, state: emptyWorldState(COUNTRIES) };
  noMemory.state.priorYearAnalysis = t.state.priorYearAnalysis;
  const stripped = structured.systemPrompt
    .replace(`\nSTRUCTURED MEMORY:\n${inputs.architecture.structuredMemory}\n`, "")
    .replace(groundingBlock(inputs.architecture.grounding!), "");
  assert.equal(stripped, a0.promptBundle(noMemory).systemPrompt);
});

test("el primer año las dos condiciones no tienen pasado que mostrar", () => {
  const t: CountryYearTask = { ...task(), simYear: 2015, state: emptyWorldState(COUNTRIES) };
  const flat = a1g.promptBundle(t).systemPrompt;
  assert.doesNotMatch(flat, /STRATEGIC HISTORY|SIMULATED NEWS HISTORY/);
  assert.doesNotMatch(a1.inputs(t).architecture.structuredMemory!, /TRAJECTORY/);
});
