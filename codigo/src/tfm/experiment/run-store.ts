// TFM F3a — persistent, resumable storage for experiment runs.
// Layout: <baseDir>/<runId>/manifest.json + records.jsonl (append-only).
// Resume = read existing keys and skip already-generated country-years.

import fs from "fs";
import path from "path";
import { CountryYearRecord, ExperimentSpec, RunFingerprint } from "./types";

/** Conditions that, if they change between sessions, make records incomparable. */
export function fingerprintDiffers(
  a: RunFingerprint,
  b: RunFingerprint,
  opts?: { ignoreProvenance?: boolean }
): string[] {
  const changed: string[] = [];
  if (a.generatorModel !== b.generatorModel) changed.push("generatorModel");
  if (!opts?.ignoreProvenance && a.repoCommit !== b.repoCommit) changed.push("repoCommit");
  if (a.promptHash !== b.promptHash) changed.push("promptHash");
  if (a.referenceDataHash !== b.referenceDataHash) changed.push("referenceDataHash");
  if (a.conditionHash !== b.conditionHash) changed.push("conditionHash");
  return changed;
}

export interface RunStoreOptions {
  /**
   * memory-v1 (RUNBOOK §3.2): a resume under changed conditions aborts before
   * anything is appended, instead of warning. Commit and timestamps are
   * provenance, not conditions — they are logged per session and never block.
   */
  strictConditions?: boolean;
}

interface RunSession {
  startedAt: string;
  repoCommit: string;
}

export class RunStore {
  private dir: string;
  private recordsPath: string;
  private keys = new Set<string>();
  /** Every distinct set of conditions this runId has been executed under. */
  readonly fingerprints: RunFingerprint[] = [];

  /** strictConditions only: every session that opened this run, in order. */
  readonly sessions: RunSession[] = [];

  constructor(
    baseDir: string,
    spec: ExperimentSpec,
    fingerprint?: RunFingerprint,
    private readonly options: RunStoreOptions = {}
  ) {
    this.dir = path.join(baseDir, spec.runId);
    this.recordsPath = path.join(this.dir, "records.jsonl");
    const manifestPath = path.join(this.dir, "manifest.json");

    if (options.strictConditions) {
      if (!fingerprint) throw new Error("strictConditions requires a fingerprint");
      this.openStrict(manifestPath, spec, fingerprint);
      this.loadKeys();
      return;
    }

    fs.mkdirSync(this.dir, { recursive: true });
    if (fs.existsSync(manifestPath)) {
      const existing = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const same =
        existing.spec.architecture === spec.architecture &&
        existing.spec.seed === spec.seed &&
        existing.spec.startYear === spec.startYear &&
        existing.spec.endYear === spec.endYear &&
        JSON.stringify(existing.spec.countries) === JSON.stringify(spec.countries);
      if (!same) {
        throw new Error(
          `Run "${spec.runId}" already exists with a different spec — refusing to mix (use a new runId)`
        );
      }

      this.fingerprints.push(...((existing.fingerprints ?? []) as RunFingerprint[]));
      if (fingerprint) {
        // Resuming after a code, prompt or model change is legitimate — what is
        // not legitimate is doing it silently. Record the new conditions so the
        // analysis can see that one runId spans more than one of them.
        const prev = this.fingerprints[this.fingerprints.length - 1];
        const changed = prev ? fingerprintDiffers(prev, fingerprint) : [];
        if (!prev || changed.length > 0) {
          this.fingerprints.push(fingerprint);
          if (changed.length > 0) {
            console.warn(
              `[run-store] Run "${spec.runId}" resumed under changed conditions (${changed.join(", ")}) — records in this run are NOT all from one condition`
            );
          }
          this.writeManifest(manifestPath, spec, existing.createdAt);
        }
      }
    } else {
      if (fingerprint) this.fingerprints.push(fingerprint);
      this.writeManifest(manifestPath, spec, new Date().toISOString());
    }

    this.loadKeys();
  }

  private openStrict(manifestPath: string, spec: ExperimentSpec, fingerprint: RunFingerprint): void {
    const session = { startedAt: fingerprint.startedAt, repoCommit: fingerprint.repoCommit };
    if (!fs.existsSync(manifestPath)) {
      fs.mkdirSync(this.dir, { recursive: true });
      this.fingerprints.push(fingerprint);
      this.sessions.push(session);
      this.writeManifest(manifestPath, spec, new Date().toISOString());
      return;
    }
    const existing = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (JSON.stringify(existing.spec) !== JSON.stringify(spec)) {
      throw new Error(`Run "${spec.runId}" already exists with a different spec — refusing to mix (use a new runId)`);
    }
    const prev = (existing.fingerprints ?? []) as RunFingerprint[];
    if (prev.length !== 1) {
      throw new Error(`Run "${spec.runId}" has ${prev.length} fingerprints; a strict run must have exactly one`);
    }
    const changed = fingerprintDiffers(prev[0], fingerprint, { ignoreProvenance: true });
    if (changed.length > 0) {
      throw new Error(
        `Run "${spec.runId}" was generated under different conditions (${changed.join(", ")}) — ` +
          `aborting before appending. Regenerate under a new lineage instead of resuming.`
      );
    }
    this.fingerprints.push(prev[0]);
    this.sessions.push(...((existing.sessions ?? []) as RunSession[]), session);
    this.writeManifest(manifestPath, spec, existing.createdAt);
  }

  private loadKeys(): void {
    if (fs.existsSync(this.recordsPath)) {
      for (const line of fs.readFileSync(this.recordsPath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as CountryYearRecord;
          if (record.status === "ok") this.keys.add(record.key);
        } catch {
          // tolerate a torn trailing line from a crashed run
        }
      }
    }
  }

  private writeManifest(manifestPath: string, spec: ExperimentSpec, createdAt: string): void {
    fs.writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          spec,
          createdAt,
          fingerprints: this.fingerprints,
          ...(this.options.strictConditions ? { sessions: this.sessions } : {}),
        },
        null,
        2
      )
    );
  }

  /** True when this runId spans more than one set of conditions (see R13). */
  get hasMixedConditions(): boolean {
    return this.fingerprints.length > 1;
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }

  append(record: CountryYearRecord): void {
    fs.appendFileSync(this.recordsPath, JSON.stringify(record) + "\n");
    if (record.status === "ok") this.keys.add(record.key);
  }

  /** All persisted records (ok and error), in append order. */
  readAll(): CountryYearRecord[] {
    if (!fs.existsSync(this.recordsPath)) return [];
    return fs
      .readFileSync(this.recordsPath, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as CountryYearRecord];
        } catch {
          return [];
        }
      });
  }

  get directory(): string {
    return this.dir;
  }
}
