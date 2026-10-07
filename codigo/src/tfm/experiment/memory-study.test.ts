import assert from "node:assert/strict";
import test from "node:test";
import {
  conditionOrder,
  generationsPerWorld,
  judgeableCountryYearsPerWorld,
  MEMORY_CONDITIONS,
  MEMORY_STAGES,
  resolveMemoryRun,
} from "./memory-study";
import { DEV_COUNTRIES_OWID, TFM_COUNTRIES_OWID } from "../owid-indicators";

test("las cohortes son exactamente las del runbook", () => {
  assert.deepEqual(resolveMemoryRun({ stage: "pilot", arch: "A1G", replicate: 1 }), {
    runId: "memory-v1-pilot-a1g-r1",
    mode: "backtest",
    architecture: "A1G",
    seed: 1,
    countries: ["Germany", "France"],
    startYear: 2015,
    endYear: 2019,
  });
  const dev = resolveMemoryRun({ stage: "dev", arch: "a1", replicate: 1 });
  assert.equal(dev.runId, "memory-v1-dev-a1-r1");
  assert.deepEqual(dev.countries, ["Germany", "France", "Russia"]);
  assert.deepEqual([dev.startYear, dev.endYear], [2015, 2024]);

  const ev = resolveMemoryRun({ stage: "eval", arch: "A1", replicate: 5 });
  assert.equal(ev.runId, "memory-v1-eval-a1-r5");
  assert.deepEqual(ev.countries, ["United States", "China", "India", "Pakistan"]);
});

test("el tamaño cuadra con el runbook: 20 + 60 + 800 generaciones, 16 juicios en el piloto", () => {
  const total = (stage: "pilot" | "dev" | "eval") =>
    generationsPerWorld(stage) * MEMORY_STAGES[stage].replicates * MEMORY_CONDITIONS.length;
  assert.equal(total("pilot"), 20);
  assert.equal(total("dev"), 60);
  assert.equal(total("eval"), 800);
  assert.equal(judgeableCountryYearsPerWorld("pilot") * 2, 16);
  assert.equal(judgeableCountryYearsPerWorld("dev") * 2, 54);
});

test("A0, A2, etapas desconocidas y replicados fuera de rango se rechazan", () => {
  for (const arch of ["A0", "A2", "A3", ""]) {
    assert.throws(() => resolveMemoryRun({ stage: "pilot", arch, replicate: 1 }), /fuera del estudio/);
  }
  assert.throws(() => resolveMemoryRun({ stage: "prod", arch: "A1", replicate: 1 }), /desconocida/);
  assert.throws(() => resolveMemoryRun({ stage: "pilot", arch: "A1", replicate: 2 }), /fuera de rango/);
  assert.throws(() => resolveMemoryRun({ stage: "dev", arch: "A1", replicate: 0 }), /fuera de rango/);
  assert.throws(() => resolveMemoryRun({ stage: "eval", arch: "A1", replicate: 11 }), /fuera de rango/);
  assert.throws(() => resolveMemoryRun({ stage: "eval", arch: "A1", replicate: 1.5 }), /fuera de rango/);
});

test("el orden de condiciones alterna por replicado", () => {
  assert.deepEqual(conditionOrder(1), ["A1G", "A1"]);
  assert.deepEqual(conditionOrder(2), ["A1", "A1G"]);
  assert.deepEqual(conditionOrder(5), ["A1G", "A1"]);
});

test("todos los países del estudio tienen indicadores declarados", () => {
  const known = new Set([...Object.keys(TFM_COUNTRIES_OWID), ...Object.keys(DEV_COUNTRIES_OWID)]);
  for (const cohort of Object.values(MEMORY_STAGES)) {
    for (const country of cohort.countries) assert.ok(known.has(country), country);
  }
});
