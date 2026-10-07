import assert from "node:assert/strict";
import test from "node:test";
import { experimentAgent } from "./architectures/shared";
import { CountryAgent } from "../../country-agent";

const ctx: any = { peerMoves: [], territoryEvents: [], recentConquests: [], worldSimNews: [], diplomaticEvents: [], activeCivilWars: [], activeInterventions: [], activeLore: [], conflictPressure: [] };
const MAP = /territoryEvent|newTerritoryZone|countryLifecycleEvent/;

// Dev, Rusia 2015 (24 sep): newTerritoryZone.zoneKey, texto libre sin límite, entraba
// en un bucle de dígitos hasta el tope de tokens. El estudio no usa esos campos.
test("el agente del experimento no pide los campos del juego de mapas", () => {
  const agent: any = experimentAgent();
  assert.doesNotMatch(agent.buildPromptBundle("Russia", ctx, "2015-07-01", 2015).systemPrompt, MAP);
  const schema = agent.buildGeminiRequestBody("s", "u").generationConfig.responseSchema;
  assert.doesNotMatch(JSON.stringify(schema), MAP);
  assert.ok(schema.properties.simulatedNews);
});

test("producción conserva los campos del juego de mapas", () => {
  const agent: any = new CountryAgent();
  assert.match(agent.buildPromptBundle("Russia", ctx, "2015-07-01", 2015).systemPrompt, MAP);
  assert.ok(agent.buildGeminiRequestBody("s", "u").generationConfig.responseSchema.properties.newTerritoryZone);
});
