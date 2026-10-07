import assert from "node:assert/strict";
import test from "node:test";
import fs from "fs";
import os from "os";
import path from "path";
import { runMatrix, emptyWorldState, isTransientProviderError } from "./matrix-runner";
import { RunStore } from "./run-store";
import { AgentArchitecture, CountryYearTask, ExperimentSpec, RunFingerprint } from "./types";
import type { AnalysisResult } from "../../country-agent";

function spec(runId: string): ExperimentSpec {
  return {
    runId,
    mode: "backtest",
    architecture: "A0",
    seed: 1,
    countries: ["India", "Pakistan"],
    startYear: 2015,
    endYear: 2017,
  };
}

function fakeResult(task: CountryYearTask): AnalysisResult {
  const priors = Object.keys(task.state.priorYearAnalysis).sort().join(",");
  return {
    move: `move-${task.country}-${task.simYear}`,
    confidence: "MEDIUM",
    sources: [],
    prediction: `priors=[${priors}] history=${task.state.historyByCountry[task.country].length}`,
    decision: "d",
    outcome: "o",
    notes: "",
    simulatedNews: [
      { month: 3, headline: `h-${task.country}-${task.simYear}`, body: "b", tone: "neutral", sources: [] },
    ],
    territoryEvent: null,
    countryLifecycleEvent: null,
    debugMeta: { providerStatus: "gemini" },
  };
}

interface CallSnapshot {
  country: string;
  simYear: number;
  priorCountries: string[];
  priorIndiaYear: number | null;
  historyLen: number;
}

function mockArch(overrides?: {
  failOn?: (task: CountryYearTask) => boolean;
  calls?: CallSnapshot[];
  message?: string;
}): AgentArchitecture {
  return {
    id: "A0",
    async analyzeCountryYear(task) {
      // Snapshot at call time — task.state is a live object the runner mutates.
      overrides?.calls?.push({
        country: task.country,
        simYear: task.simYear,
        priorCountries: Object.keys(task.state.priorYearAnalysis).sort(),
        priorIndiaYear: task.state.priorYearAnalysis["India"]?.sim_year ?? null,
        historyLen: task.state.historyByCountry[task.country].length,
      });
      if (overrides?.failOn?.(task)) throw new Error(overrides.message ?? "boom");
      return fakeResult(task);
    },
  };
}

function tmpBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tfm-matrix-"));
}

test("runMatrix generates the full matrix and chains world state across years", async () => {
  const base = tmpBase();
  const calls: CallSnapshot[] = [];
  const store = new RunStore(base, spec("run1"));
  const summary = await runMatrix(spec("run1"), { store, architecture: mockArch({ calls }) });

  assert.deepEqual(summary, { generated: 6, skipped: 0, errors: 0 });
  const records = store.readAll();
  assert.equal(records.length, 6);

  // Year 2015 sees no priors; 2016 sees both countries' 2015 analyses.
  const y2015 = calls.find((c) => c.simYear === 2015 && c.country === "India")!;
  assert.deepEqual(y2015.priorCountries, []);
  const y2016 = calls.find((c) => c.simYear === 2016 && c.country === "India")!;
  assert.deepEqual(y2016.priorCountries, ["India", "Pakistan"]);
  assert.equal(y2016.priorIndiaYear, 2015);
  // History accumulated
  const y2017 = calls.find((c) => c.simYear === 2017 && c.country === "India")!;
  assert.equal(y2017.historyLen, 2);
});

test("runMatrix resumes: second run skips everything and rebuilds priors", async () => {
  const base = tmpBase();
  await runMatrix(spec("run2"), { store: new RunStore(base, spec("run2")), architecture: mockArch() });

  const calls: CallSnapshot[] = [];
  const summary = await runMatrix(spec("run2"), {
    store: new RunStore(base, spec("run2")),
    architecture: mockArch({ calls }),
  });
  assert.deepEqual(summary, { generated: 0, skipped: 6, errors: 0 });
  assert.equal(calls.length, 0);
});

test("runMatrix captures per-record errors, retries them on resume", async () => {
  const base = tmpBase();
  const failPakistan2016 = (t: CountryYearTask) => t.country === "Pakistan" && t.simYear === 2016;
  const first = await runMatrix(spec("run3"), {
    store: new RunStore(base, spec("run3")),
    architecture: mockArch({ failOn: failPakistan2016 }),
  });
  assert.deepEqual(first, { generated: 5, skipped: 0, errors: 1 });

  const second = await runMatrix(spec("run3"), {
    store: new RunStore(base, spec("run3")),
    architecture: mockArch(),
  });
  assert.deepEqual(second, { generated: 1, skipped: 5, errors: 0 });
});

test("runMatrix aborts after maxConsecutiveErrors", async () => {
  const base = tmpBase();
  await assert.rejects(
    runMatrix(spec("run4"), {
      store: new RunStore(base, spec("run4")),
      architecture: mockArch({ failOn: () => true }),
      maxConsecutiveErrors: 3,
    }),
    /3 consecutive errors/
  );
});

test("stopOnError stops before the year advances and a resume completes the same year", async () => {
  const base = tmpBase();
  const failIndia2016 = (t: CountryYearTask) => t.country === "India" && t.simYear === 2016;
  await assert.rejects(
    runMatrix(spec("stop1"), {
      store: new RunStore(base, spec("stop1")),
      architecture: mockArch({ failOn: failIndia2016 }),
      stopOnError: true,
    }),
    /India 2016 before advancing the year/
  );
  // Nothing from 2016 onwards was generated after the failure.
  const afterFailure = new RunStore(base, spec("stop1")).readAll();
  assert.deepEqual(
    afterFailure.map((r) => `${r.country}:${r.simYear}:${r.status}`),
    ["India:2015:ok", "Pakistan:2015:ok", "India:2016:error"]
  );

  const calls: CallSnapshot[] = [];
  const resumed = await runMatrix(spec("stop1"), {
    store: new RunStore(base, spec("stop1")),
    architecture: mockArch({ calls }),
    stopOnError: true,
  });
  assert.deepEqual(resumed, { generated: 4, skipped: 2, errors: 0 });
  // The retried item sees the frozen 2015 world, not a partial 2016.
  const retry = calls.find((c) => c.country === "India" && c.simYear === 2016)!;
  assert.deepEqual(retry.priorCountries, ["India", "Pakistan"]);
  assert.equal(retry.priorIndiaYear, 2015);
  assert.equal(retry.historyLen, 1);
});

test("isTransientProviderError reintenta sobrecarga y red, no cuota ni autenticación", () => {
  assert.ok(isTransientProviderError('gemini:x:Gemini API 503: {"message":"This model is currently experiencing high demand"}'));
  assert.ok(isTransientProviderError("Gemini API 429: rate limit"));
  assert.ok(isTransientProviderError("fetch failed"));
  // Salida cortada por el tope de tokens (piloto del 23 sep): otra muestra puede cerrar el JSON.
  assert.ok(isTransientProviderError('Provider fell back to "fallback" — gemini:gemini-3.6-flash:No JSON object in response'));
  assert.ok(!isTransientProviderError("Gemini API 403: permission denied"));
  assert.ok(!isTransientProviderError("You exceeded your current quota, check billing (503)"));
  assert.ok(!isTransientProviderError("Provider returned invalid analysis JSON"));
});

test("maxAttempts reintenta un fallo transitorio en el mismo ítem y registra cada intento", async () => {
  const base = tmpBase();
  let failures = 2;
  const flaky = mockArch({ failOn: (t) => t.country === "Pakistan" && t.simYear === 2016 && failures-- > 0, message: "Gemini API 503 high demand" });
  const store = new RunStore(base, spec("att1"));
  const summary = await runMatrix(spec("att1"), {
    store, architecture: flaky, stopOnError: true, maxAttempts: 3, isRetryable: isTransientProviderError,
  });
  assert.deepEqual(summary, { generated: 6, skipped: 0, errors: 2 });
  const pk = store.readAll().filter((r) => r.key === "A0:1:Pakistan:2016");
  assert.deepEqual(pk.map((r) => [r.attempt, r.status]), [[1, "error"], [2, "error"], [3, "ok"]]);
});

test("un error no transitorio para en el acto, y los intentos agotados persisten entre reanudaciones", async () => {
  const base = tmpBase();
  const opts = { stopOnError: true, maxAttempts: 2, isRetryable: isTransientProviderError };
  await assert.rejects(
    runMatrix(spec("att2"), { store: new RunStore(base, spec("att2")), architecture: mockArch({ failOn: (t) => t.simYear === 2015, message: "quota exceeded" }), ...opts }),
    /attempt 1\/2, not retryable/
  );
  await assert.rejects(
    runMatrix(spec("att2"), { store: new RunStore(base, spec("att2")), architecture: mockArch({ failOn: (t) => t.simYear === 2015, message: "503 unavailable" }), ...opts }),
    /attempt 2\/2/
  );
  const calls: CallSnapshot[] = [];
  await assert.rejects(
    runMatrix(spec("att2"), { store: new RunStore(base, spec("att2")), architecture: mockArch({ calls }), ...opts }),
    /2 attempts already used/
  );
  assert.equal(calls.length, 0);

  // Un intento extra autorizado se registra como tal; el contador no se reinicia.
  const store = new RunStore(base, spec("att2"));
  await runMatrix(spec("att2"), { store, architecture: mockArch(), ...opts, extraAttempts: 1 });
  const india = store.readAll().filter((r) => r.key === "A0:1:India:2015");
  assert.deepEqual(india.map((r) => [r.attempt, r.status, r.authorizedExtraAttempt ?? false]), [
    [1, "error", false], [2, "error", false], [3, "ok", true],
  ]);
});

test("RunStore refuses a different spec under the same runId", () => {
  const base = tmpBase();
  new RunStore(base, spec("run5"));
  const conflicting = { ...spec("run5"), endYear: 2024 };
  assert.throws(() => new RunStore(base, conflicting), /different spec/);
});

function fingerprint(overrides?: Partial<RunFingerprint>): RunFingerprint {
  return {
    generatorModel: "gemini-3.6-flash",
    repoCommit: "abc1234",
    promptHash: "hash-v1",
    startedAt: "2026-08-04T00:00:00.000Z",
    ...overrides,
  };
}

test("RunStore records the conditions a run was executed under", () => {
  const base = tmpBase();
  const store = new RunStore(base, spec("fp1"), fingerprint());

  assert.equal(store.fingerprints.length, 1);
  assert.equal(store.hasMixedConditions, false);

  const manifest = JSON.parse(
    fs.readFileSync(path.join(base, "fp1", "manifest.json"), "utf8")
  );
  assert.equal(manifest.fingerprints[0].generatorModel, "gemini-3.6-flash");
});

test("RunStore flags a resume under changed conditions instead of hiding it", () => {
  const base = tmpBase();
  new RunStore(base, spec("fp2"), fingerprint());

  // Same runId, different model: legitimate to resume, fatal to do silently.
  const resumed = new RunStore(base, spec("fp2"), fingerprint({ generatorModel: "gemini-2.5-pro" }));
  assert.equal(resumed.fingerprints.length, 2);
  assert.equal(resumed.hasMixedConditions, true);

  const manifest = JSON.parse(
    fs.readFileSync(path.join(base, "fp2", "manifest.json"), "utf8")
  );
  assert.deepEqual(
    manifest.fingerprints.map((f: RunFingerprint) => f.generatorModel),
    ["gemini-3.6-flash", "gemini-2.5-pro"]
  );
});

test("RunStore does not multiply fingerprints when conditions are unchanged", () => {
  const base = tmpBase();
  new RunStore(base, spec("fp3"), fingerprint());
  const again = new RunStore(base, spec("fp3"), fingerprint({ startedAt: "2026-08-05T00:00:00.000Z" }));

  // startedAt differs on every session and must not count as a condition change.
  assert.equal(again.fingerprints.length, 1);
  assert.equal(again.hasMixedConditions, false);
});

test("strict RunStore aborts on changed conditions before writing anything", () => {
  const base = tmpBase();
  const strict = { strictConditions: true };
  new RunStore(base, spec("st1"), fingerprint({ conditionHash: "c1" }), strict);
  const manifestPath = path.join(base, "st1", "manifest.json");
  const before = fs.readFileSync(manifestPath, "utf8");

  assert.throws(
    () => new RunStore(base, spec("st1"), fingerprint({ conditionHash: "c2" }), strict),
    /different conditions \(conditionHash\)/
  );
  assert.throws(
    () => new RunStore(base, spec("st1"), fingerprint({ conditionHash: "c1", generatorModel: "x" }), strict),
    /generatorModel/
  );
  assert.equal(fs.readFileSync(manifestPath, "utf8"), before);
});

test("strict RunStore resumes across evidence-only commits and logs each session", () => {
  const base = tmpBase();
  const strict = { strictConditions: true };
  new RunStore(base, spec("st2"), fingerprint({ conditionHash: "c1" }), strict);
  const resumed = new RunStore(
    base,
    spec("st2"),
    fingerprint({ conditionHash: "c1", repoCommit: "def5678", startedAt: "2026-09-17T00:00:00.000Z" }),
    strict
  );
  assert.equal(resumed.fingerprints.length, 1);
  assert.equal(resumed.hasMixedConditions, false);
  const manifest = JSON.parse(fs.readFileSync(path.join(base, "st2", "manifest.json"), "utf8"));
  assert.deepEqual(
    manifest.sessions.map((s: { repoCommit: string }) => s.repoCommit),
    ["abc1234", "def5678"]
  );
  assert.equal(manifest.fingerprints[0].repoCommit, "abc1234");
});

test("annotateRecord stamps extra fields onto every persisted record", async () => {
  const base = tmpBase();
  const store = new RunStore(base, spec("ann1"));
  await runMatrix(spec("ann1"), {
    store,
    architecture: mockArch(),
    // Lo que el CLI real estampa: modelo clavado + huecos de indicadores (R13/R9).
    annotateRecord: ({ country }) => ({
      generatorModel: "gemini-3.6-flash",
      missingIndicators: country === "Pakistan" ? ["fossil-share"] : [],
    }),
  });

  const records = store.readAll();
  assert.equal(records.length, 6);
  for (const r of records) assert.equal(r.generatorModel, "gemini-3.6-flash");
  const pk = records.find((r) => r.country === "Pakistan" && r.simYear === 2015)!;
  assert.deepEqual(pk.missingIndicators, ["fossil-share"]);
});

test("emptyWorldState initializes per-country containers", () => {
  const state = emptyWorldState(["India"]);
  assert.deepEqual(state.historyByCountry["India"], []);
  assert.deepEqual(state.priorSimNewsByCountry["India"], []);
});
