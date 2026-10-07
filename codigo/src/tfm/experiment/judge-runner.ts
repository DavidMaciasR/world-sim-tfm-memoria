// memory-v1 — pasada del juez de coherencia sobre una tirada ya generada.
//
// Layout: <runDir>/coherence-judge/manifest.json + judgments.jsonl (append-only).
// Reanudable: se salta un país-año ya juzgado con la misma entrada y las mismas
// condiciones del juez. Condiciones distintas no se añaden al mismo fichero, y
// una entrada que ha cambiado bajo un juicio ya aceptado aborta: significa que
// la generación cambió debajo, y eso se resuelve con otra tirada, no aquí.
// Un fallo del juez nunca regenera nada.

import fs from "fs";
import path from "path";
import type { CountryYearRecord, ExperimentSpec } from "./types";
import {
  acceptedRecords,
  buildCoherenceEvidence,
  checkVerdict,
  CoherenceEvidence,
  CoherenceVerdict,
  JudgeCall,
  JudgeCallResult,
  judgeConditions,
  MissingDependencyError,
  sha,
} from "./coherence-judge";

export type JudgmentStatus = "ok" | "structural_na" | "error";

export interface JudgmentRecord {
  key: string; // `${country}:${simYear}`
  runId: string;
  recordKey: string | null; // clave del registro de generación juzgado
  country: string;
  simYear: number;
  status: JudgmentStatus;
  attemptId: string;
  judgedAt: string;
  judgeConditionHash: string;
  inputHash: string | null;
  recordHash: string | null;
  naReason?: string;
  verdict?: CoherenceVerdict;
  evidenceProblems?: string[];
  evidenceValid?: boolean;
  requestedModel?: string;
  returnedModel?: string;
  requestId?: string | null;
  stopReason?: string | null;
  usage?: JudgeCallResult["usage"];
  latencyMs?: number;
  error?: string;
}

export interface PlanItem {
  key: string;
  country: string;
  simYear: number;
  action: "judge" | "structural_na" | "skip_done" | "missing_generation" | "blocked";
  reason?: string;
  evidence?: CoherenceEvidence;
  record?: CountryYearRecord;
}

function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as T];
      } catch {
        return []; // línea cortada por un proceso interrumpido
      }
    });
}

export interface JudgingOptions {
  runDir: string;
  formatterSource: string;
  call: JudgeCall;
  dryRun: boolean;
  onItem?: (item: PlanItem, judgment?: JudgmentRecord) => void;
}

export interface JudgingSummary {
  runId: string;
  judgeConditionHash: string;
  plan: PlanItem[];
  judged: number;
  structuralNa: number;
  skipped: number;
  errors: number;
}

export async function runCoherenceJudging(options: JudgingOptions): Promise<JudgingSummary> {
  const { runDir, dryRun } = options;
  const runManifestPath = path.join(runDir, "manifest.json");
  if (!fs.existsSync(runManifestPath)) throw new Error(`No run manifest at ${runManifestPath}`);
  const runManifest = JSON.parse(fs.readFileSync(runManifestPath, "utf8"));
  const spec = runManifest.spec as ExperimentSpec;
  const records = readJsonl<CountryYearRecord>(path.join(runDir, "records.jsonl"));
  const accepted = acceptedRecords(records);

  const { conditions, conditionHash } = judgeConditions(options.formatterSource);
  const judgeDir = path.join(runDir, "coherence-judge");
  const manifestPath = path.join(judgeDir, "manifest.json");
  const judgmentsPath = path.join(judgeDir, "judgments.jsonl");

  if (fs.existsSync(manifestPath)) {
    const existing = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (existing.judgeConditionHash !== conditionHash) {
      throw new Error(
        `Run "${spec.runId}" was judged under different judge conditions (${existing.judgeConditionHash} ≠ ${conditionHash}) — ` +
          "refusing to append; rejudge into a new judge version instead."
      );
    }
  }

  const previous = readJsonl<JudgmentRecord>(judgmentsPath);
  const done = new Map<string, JudgmentRecord>();
  const attempts = new Map<string, number>();
  for (const j of previous) {
    attempts.set(j.key, (attempts.get(j.key) ?? 0) + 1);
    if (j.status !== "error") done.set(j.key, j);
  }

  // Plan determinista: años en orden, países en el orden fijo de la tirada.
  const plan: PlanItem[] = [];
  for (let simYear = spec.startYear; simYear <= spec.endYear; simYear++) {
    for (const country of spec.countries) {
      const key = `${country}:${simYear}`;
      const record = accepted.get(key);
      if (!record) {
        plan.push({ key, country, simYear, action: "missing_generation", reason: "no accepted generation record" });
        continue;
      }
      let evidence: CoherenceEvidence | null;
      try {
        evidence = buildCoherenceEvidence({
          country,
          simYear,
          startYear: spec.startYear,
          countries: spec.countries,
          accepted,
        });
      } catch (err) {
        if (!(err instanceof MissingDependencyError)) throw err;
        plan.push({ key, country, simYear, action: "blocked", reason: err.message, record });
        continue;
      }

      const prior = done.get(key);
      if (!evidence) {
        plan.push({ key, country, simYear, action: prior ? "skip_done" : "structural_na", record });
        continue;
      }
      if (prior) {
        if (prior.inputHash !== sha(evidence.text)) {
          throw new Error(
            `Judgment for ${key} was made on a different input (${prior.inputHash} ≠ ${sha(evidence.text)}): ` +
              "the generation changed under an accepted judgment — aborting."
          );
        }
        plan.push({ key, country, simYear, action: "skip_done", evidence, record });
        continue;
      }
      plan.push({ key, country, simYear, action: "judge", evidence, record });
    }
  }

  const summary: JudgingSummary = {
    runId: spec.runId,
    judgeConditionHash: conditionHash,
    plan,
    judged: 0,
    structuralNa: 0,
    skipped: plan.filter((p) => p.action === "skip_done").length,
    errors: 0,
  };
  if (dryRun) return summary;

  fs.mkdirSync(judgeDir, { recursive: true });
  const createdAt = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, "utf8")).createdAt
    : new Date().toISOString();
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        runId: spec.runId,
        createdAt,
        updatedAt: new Date().toISOString(),
        judgeConditionHash: conditionHash,
        judgeConditions: conditions,
        generation: {
          runManifestConditionHash: runManifest.fingerprints?.[0]?.conditionHash ?? null,
          spec,
        },
        blindness:
          "evidence built from records.jsonl only; no runId, architecture, memory block, indicators or real chronology in the request",
      },
      null,
      2
    )
  );

  const append = (j: JudgmentRecord) => fs.appendFileSync(judgmentsPath, JSON.stringify(j) + "\n");

  for (const item of plan) {
    if (item.action !== "judge" && item.action !== "structural_na") {
      options.onItem?.(item);
      continue;
    }
    const n = (attempts.get(item.key) ?? 0) + 1;
    attempts.set(item.key, n);
    const base = {
      key: item.key,
      runId: spec.runId,
      recordKey: item.record?.key ?? null,
      country: item.country,
      simYear: item.simYear,
      attemptId: `${item.key}#${n}`,
      judgedAt: new Date().toISOString(),
      judgeConditionHash: conditionHash,
      recordHash: item.record?.analysis ? sha(JSON.stringify(item.record.analysis)) : null,
    };

    if (item.action === "structural_na") {
      const j: JudgmentRecord = { ...base, status: "structural_na", inputHash: null, naReason: "first simulated year: no prior history" };
      append(j);
      summary.structuralNa++;
      options.onItem?.(item, j);
      continue;
    }

    const evidence = item.evidence!;
    try {
      const result = await options.call(evidence, {
        runId: spec.runId,
        recordKey: base.recordKey ?? item.key,
        attemptId: base.attemptId,
      });
      const problems = checkVerdict(result.verdict, evidence);
      const j: JudgmentRecord = {
        ...base,
        status: "ok",
        inputHash: sha(evidence.text),
        verdict: result.verdict,
        evidenceProblems: problems,
        evidenceValid: problems.length === 0,
        requestedModel: result.requestedModel,
        returnedModel: result.returnedModel,
        requestId: result.requestId,
        stopReason: result.stopReason,
        usage: result.usage,
        latencyMs: result.latencyMs,
      };
      append(j);
      summary.judged++;
      options.onItem?.(item, j);
    } catch (err) {
      const j: JudgmentRecord = {
        ...base,
        status: "error",
        inputHash: sha(evidence.text),
        error: err instanceof Error ? err.message.slice(0, 500) : String(err),
      };
      append(j);
      summary.errors++;
      options.onItem?.(item, j);
      throw new Error(`Judge failed on ${item.key} (${j.attemptId}): ${j.error} — stopping; resume retries it`);
    }
  }
  return summary;
}
