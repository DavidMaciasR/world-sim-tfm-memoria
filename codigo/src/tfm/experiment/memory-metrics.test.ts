import assert from "node:assert/strict";
import test from "node:test";
import { countryYearMetrics, headlineSimilarityToPreviousYear, validContradictions, worldMean } from "./memory-metrics";

test("solo cuentan las contradicciones cuya evidencia pasa el control", () => {
  const j = {
    status: "ok",
    verdict: { score: 3, evidence: [{ conflict: "a" }, { conflict: "b" }, { conflict: "c" }] },
    evidenceProblems: ['evidence[1]: prior field "2019.move" is from the current year'],
  };
  assert.equal(validContradictions(j), 2);
  assert.equal(validContradictions({ status: "ok", verdict: { score: 5, evidence: [] } }), 0);
  assert.equal(validContradictions({ status: "structural_na" }), null);
  assert.equal(validContradictions(undefined), null);
});

test("la similitud con el año anterior es continua y null el primer año", () => {
  const prev = [{ headline: "France launches PESCO defence pact" }];
  assert.equal(headlineSimilarityToPreviousYear([{ headline: "x" }], undefined), null);
  const same = headlineSimilarityToPreviousYear([{ headline: "France launches PESCO defence pact" }], prev)!;
  const half = headlineSimilarityToPreviousYear([{ headline: "France launches new submarine programme" }], prev)!;
  assert.equal(same, 1);
  assert.ok(half > 0 && half < 1);
});

test("countryYearMetrics junta principal y diagnóstico", () => {
  const m = countryYearMetrics([{ headline: "a b c", body: "d e f g" }], undefined, { status: "ok", verdict: { score: 4, evidence: [{}] } });
  assert.equal(m.contradictions, 1);
  assert.equal(m.score, 4);
  assert.equal(m.headlineSimilarity, null);
  assert.equal(m.recycledShare, null);
});

test("worldMean pesa igual cada país, no cada país-año", () => {
  const rows = [
    { country: "A", value: 0 }, { country: "A", value: 0 }, { country: "A", value: 0 },
    { country: "B", value: 1 },
    { country: "B", value: null },
  ];
  assert.equal(worldMean(rows), 0.5);
  assert.equal(worldMean([]), null);
});
