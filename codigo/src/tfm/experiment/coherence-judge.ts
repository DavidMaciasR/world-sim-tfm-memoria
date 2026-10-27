// memory-v1 — juez de coherencia temporal (cap. 4).
//
// Una sola dimensión: ¿contradice el año actual el pasado de la propia
// simulación? No compara con la historia real ni puntúa plausibilidad. Es un
// módulo aparte a propósito: judge.ts (cuatro dimensiones + pasada histórica)
// pertenece al diseño anterior y no se usa en este estudio.
//
// Ciego a la condición: la evidencia se construye siempre igual desde los
// registros persistidos (records.jsonl), nunca desde la memoria comprimida que
// vio A1, y no lleva runId, arquitectura, indicadores ni cronologías.

import { createHash } from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import { withLlmTelemetry } from "../../llm-call-telemetry";
import { buildWorldContext } from "../../world-context";
import type { SimNewsRow, StoredAnalysis } from "../../db";
import type { CountryYearRecord } from "./types";

// ---------------------------------------------------------------------------
// Configuración fija del juez

/**
 * Claude Sonnet 5 no acepta parámetros de muestreo (temperature/top_p/top_k
 * devuelven 400), así que "temperatura 0" no es posible. La configuración fija
 * documentada es: sin muestreo explícito y razonamiento desactivado, para que
 * cada llamada use el mismo modo en lugar de uno adaptativo que varía por
 * entrada. Nada de esto garantiza determinismo; el re-test lo mide.
 */
export const JUDGE_CONFIG = {
  model: "claude-sonnet-5",
  maxTokens: 8000,
  thinking: { type: "disabled" } as const,
  sampling: "not sent: claude-sonnet-5 rejects temperature/top_p/top_k",
  /** Reintentos del SDK (408/409/429/5xx y red): hasta 3 intentos por ítem. */
  maxRetries: 2,
} as const;

export const COHERENCE_SYSTEM = `You judge the temporal coherence of one simulated country-year against that simulation's own past.

The simulation is fictional and retrospective. Do NOT compare it with real history, and do not score plausibility, style, specificity or repetition. The only question is: does the CURRENT YEAR contradict what the supplied history had already established?

Evidence is given as labelled fields. Field kinds:
- move: the strategic action the country took that year.
- decision / outcome: what the country decided and what resulted, as reported that year.
- prediction: what the country EXPECTED to happen. It is not an established fact.
- news: simulated news items of that year.
- peer fields: what other countries did the previous year, as shown to this country.

Rules that prevent false contradictions:
- An explicit change is not a contradiction. If the current year says or clearly implies that a policy, alliance or situation changed, that is a transition, not an error.
- An unrealized prediction is not a contradiction. A past prediction that did not come true establishes nothing.
- A stated intention is not a completed action. "Plans to", "will seek", "announces intent" do not establish that something happened.
- Different emphasis, omissions, or new topics are not contradictions.
- If peer evidence and own history disagree, report only what the current year contradicts; do not reconcile them yourself.
- Compare the current year only against PRIOR years. Inconsistencies inside the current year itself (two current-year fields disagreeing with each other) are out of scope: do not report them and do not lower the score for them. Every evidence item pairs a prior-year or peer field with a current-year field.

A contradiction is when the current year treats as true something incompatible with an established fact of the past (a completed action, a reported outcome, a reported event) without acknowledging a change: e.g. an agreement signed earlier described as never signed, a withdrawn force described as never deployed, a lost election described as won.

Score:
5 — No supported inconsistency with the supplied history.
4 — Minor ambiguity or continuity lapse; no clear substantive contradiction.
3 — One clear local contradiction, or multiple minor lapses.
2 — A major contradiction, or several clear local contradictions.
1 — Broad reset, or multiple major contradictions to established state.
null — Only if the supplied evidence is unusable (e.g. empty or unreadable); give null_reason.

For every score below 5 list the evidence: the prior field id and an exact quote from it, the current field id and an exact quote from it, and a one-sentence explanation of the conflict. Quotes must be copied verbatim from the field text (a contiguous span, no ellipses). For a score of 5, evidence is an empty list. Keep the rationale to at most three sentences.`;

export const COHERENCE_SCHEMA = {
  type: "object",
  properties: {
    score: { anyOf: [{ type: "integer", enum: [1, 2, 3, 4, 5] }, { type: "null" }] },
    null_reason: { anyOf: [{ type: "string" }, { type: "null" }] },
    rationale: { type: "string" },
    evidence: {
      type: "array",
      items: {
        type: "object",
        properties: {
          prior_field: { type: "string" },
          prior_quote: { type: "string" },
          current_field: { type: "string" },
          current_quote: { type: "string" },
          conflict: { type: "string" },
        },
        required: ["prior_field", "prior_quote", "current_field", "current_quote", "conflict"],
        additionalProperties: false,
      },
    },
  },
  required: ["score", "null_reason", "rationale", "evidence"],
  additionalProperties: false,
} as const;

export interface CoherenceVerdict {
  score: 1 | 2 | 3 | 4 | 5 | null;
  null_reason: string | null;
  rationale: string;
  evidence: Array<{
    prior_field: string;
    prior_quote: string;
    current_field: string;
    current_quote: string;
    conflict: string;
  }>;
}

// ---------------------------------------------------------------------------
// Registros aceptados

/** Un registro aceptado por clave: el último "ok" de cada país-año. */
export function acceptedRecords(records: CountryYearRecord[]): Map<string, CountryYearRecord> {
  const out = new Map<string, CountryYearRecord>();
  for (const r of records) {
    if (r.status === "ok" && r.analysis) out.set(`${r.country}:${r.simYear}`, r);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Evidencia

export interface EvidenceField {
  id: string;
  scope: "prior" | "peer" | "current";
  label: string;
  text: string;
}

export interface CoherenceEvidence {
  country: string;
  simYear: number;
  fields: EvidenceField[];
  /** El texto exacto que recibe el juez como mensaje de usuario. */
  text: string;
}

export class MissingDependencyError extends Error {}

const pad2 = (n: number) => String(n).padStart(2, "0");
const clean = (s: unknown) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "");

function ownFields(record: CountryYearRecord, scope: "prior" | "current"): EvidenceField[] {
  const a = record.analysis!;
  const y = record.simYear;
  const fields: EvidenceField[] = [];
  const push = (id: string, label: string, text: unknown) => {
    const t = clean(text);
    if (t) fields.push({ id, scope, label, text: t });
  };
  push(`${y}.move`, "move", a.move);
  push(`${y}.decision`, "decision", a.decision);
  push(`${y}.outcome`, "outcome", a.outcome);
  push(`${y}.prediction`, "prediction — an expectation, not an established fact", a.prediction);
  const news = [...(a.simulatedNews ?? [])].sort((p, q) => p.month - q.month);
  for (const n of news) {
    const headline = clean(n.headline);
    const body = clean(n.body);
    push(`${y}.news.m${pad2(n.month)}`, "news", body ? `${headline} — ${body}` : headline);
  }
  return fields;
}

/**
 * Lo que el agente vio de otros países al generar el año actual: se reconstruye
 * con el mismo buildWorldContext que usa el runner, sobre los registros de Y-1.
 */
function peerFields(
  country: string,
  simYear: number,
  accepted: Map<string, CountryYearRecord>,
  countries: string[]
): EvidenceField[] {
  const prevYear = simYear - 1;
  const priorAnalysis: Record<string, StoredAnalysis> = {};
  const priorNews: Record<string, SimNewsRow[]> = {};
  for (const c of countries) {
    const r = accepted.get(`${c}:${prevYear}`);
    if (!r?.analysis) continue;
    priorAnalysis[c] = {
      country: c,
      sim_month: `${prevYear}-07`,
      sim_year: prevYear,
      move: r.analysis.move,
      confidence: r.analysis.confidence,
      sources: [],
      prediction: r.analysis.prediction,
    };
    priorNews[c] = (r.analysis.simulatedNews ?? []).map((n, i) => ({
      id: -(i + 1),
      country: c,
      sim_year: prevYear,
      sim_month: n.month,
      headline: n.headline,
      body: n.body,
      tone: n.tone,
      sources: [],
      created_at: "",
    }));
  }
  const ctx = buildWorldContext(country, simYear, priorAnalysis, [], priorNews, []);
  const fields: EvidenceField[] = [];
  for (const p of ctx.peerMoves) {
    const move = clean(p.move);
    if (move) fields.push({ id: `peer.${p.country}.${prevYear}.move`, scope: "peer", label: `${p.relationship} move`, text: move });
    const pred = clean(p.prediction);
    if (pred) {
      fields.push({
        id: `peer.${p.country}.${prevYear}.prediction`,
        scope: "peer",
        label: `${p.relationship} prediction — an expectation, not an established fact`,
        text: pred,
      });
    }
  }
  const perPeer = new Map<string, number>();
  for (const n of ctx.worldSimNews) {
    const i = (perPeer.get(n.country) ?? 0) + 1;
    perPeer.set(n.country, i);
    const headline = clean(n.headline);
    if (headline) {
      fields.push({ id: `peer.${n.country}.${prevYear}.headline.${i}`, scope: "peer", label: "news headline", text: headline });
    }
  }
  return fields;
}

function render(fields: EvidenceField[]): string {
  return fields.map((f) => `[${f.id}] (${f.label}) ${f.text}`).join("\n");
}

/**
 * Evidencia de un país-año, o null si es el primer año (no hay pasado: N/A
 * estructural, sin llamada). Exige todos los años propios anteriores: un hueco
 * no se rellena ni se ignora, se señala.
 */
export function buildCoherenceEvidence(input: {
  country: string;
  simYear: number;
  startYear: number;
  countries: string[];
  accepted: Map<string, CountryYearRecord>;
}): CoherenceEvidence | null {
  const { country, simYear, startYear, countries, accepted } = input;
  if (simYear <= startYear) return null;

  const current = accepted.get(`${country}:${simYear}`);
  if (!current) throw new MissingDependencyError(`No accepted record for ${country} ${simYear}`);

  const prior: EvidenceField[] = [];
  for (let y = startYear; y < simYear; y++) {
    const r = accepted.get(`${country}:${y}`);
    if (!r) throw new MissingDependencyError(`No accepted record for ${country} ${y}, needed to judge ${simYear}`);
    prior.push(...ownFields(r, "prior"));
  }
  const peers = peerFields(country, simYear, accepted, countries);
  const cur = ownFields(current, "current");

  const text = [
    `COUNTRY: ${country}`,
    `YEAR TO JUDGE: ${simYear}`,
    "",
    `=== OWN HISTORY: ${country}, ${startYear}–${simYear - 1}, oldest first ===`,
    render(prior),
    "",
    `=== PEER EVIDENCE: other countries' ${simYear - 1} moves and news, as shown to ${country} ===`,
    peers.length ? render(peers) : "(none shown)",
    "",
    `=== CURRENT YEAR TO JUDGE: ${country}, ${simYear} ===`,
    render(cur),
    "",
    `Judge the temporal coherence of ${country} ${simYear} against the history above.`,
  ].join("\n");

  return { country, simYear, fields: [...prior, ...peers, ...cur], text };
}

// ---------------------------------------------------------------------------
// Comprobación mecánica de la evidencia

const norm = (s: string) =>
  s
    .replace(/[“”«»]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/**
 * Comprueba que el veredicto es trazable: puntuación válida, evidencia cuando
 * baja de 5, campos que existen en el lado correcto y citas literales. Que una
 * cita exista no prueba que la interpretación sea correcta.
 */
export function checkVerdict(verdict: CoherenceVerdict, evidence: CoherenceEvidence): string[] {
  const problems: string[] = [];
  const byId = new Map(evidence.fields.map((f) => [f.id, f]));

  if (verdict.score === null) {
    if (!clean(verdict.null_reason)) problems.push("score null without null_reason");
  } else if (![1, 2, 3, 4, 5].includes(verdict.score)) {
    problems.push(`invalid score ${String(verdict.score)}`);
  }
  if (verdict.score !== null && verdict.score < 5 && verdict.evidence.length === 0) {
    problems.push(`score ${verdict.score} without evidence`);
  }

  verdict.evidence.forEach((e, i) => {
    const prior = byId.get(e.prior_field);
    if (!prior) problems.push(`evidence[${i}]: prior field "${e.prior_field}" does not exist`);
    else if (prior.scope === "current") problems.push(`evidence[${i}]: prior field "${e.prior_field}" is from the current year`);
    else if (!clean(e.prior_quote) || !norm(prior.text).includes(norm(e.prior_quote))) {
      problems.push(`evidence[${i}]: prior quote not found in ${e.prior_field}`);
    }

    const current = byId.get(e.current_field);
    if (!current) problems.push(`evidence[${i}]: current field "${e.current_field}" does not exist`);
    else if (current.scope !== "current") problems.push(`evidence[${i}]: current field "${e.current_field}" is not from the current year`);
    else if (!clean(e.current_quote) || !norm(current.text).includes(norm(e.current_quote))) {
      problems.push(`evidence[${i}]: current quote not found in ${e.current_field}`);
    }

    if (!clean(e.conflict)) problems.push(`evidence[${i}]: empty conflict explanation`);
  });
  return problems;
}

// ---------------------------------------------------------------------------
// Huellas y llamada

export const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

export function judgeConditions(formatterSource: string) {
  const conditions = {
    judge: "temporal-coherence-v1",
    model: JUDGE_CONFIG.model,
    maxTokens: JUDGE_CONFIG.maxTokens,
    thinking: JUDGE_CONFIG.thinking,
    sampling: JUDGE_CONFIG.sampling,
    maxRetries: JUDGE_CONFIG.maxRetries,
    rubricHash: sha(COHERENCE_SYSTEM),
    schemaHash: sha(JSON.stringify(COHERENCE_SCHEMA)),
    formatterHash: sha(formatterSource),
  };
  return { conditions, conditionHash: sha(JSON.stringify(conditions)) };
}

export interface JudgeCallResult {
  verdict: CoherenceVerdict;
  requestedModel: string;
  returnedModel: string;
  requestId: string | null;
  stopReason: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number | null;
    cacheReadInputTokens: number | null;
  };
  latencyMs: number;
}

export type JudgeCall = (
  evidence: CoherenceEvidence,
  meta: { runId: string; recordKey: string; attemptId: string }
) => Promise<JudgeCallResult>;

let client: Anthropic | null = null;

export const callCoherenceJudge: JudgeCall = async (evidence, meta) => {
  client ??= new Anthropic({ maxRetries: JUDGE_CONFIG.maxRetries });
  const started = Date.now();
  return withLlmTelemetry(
    {
      feature: "tfm_coherence_judge",
      provider: "anthropic",
      model: JUDGE_CONFIG.model,
      country: evidence.country,
      simYear: evidence.simYear,
      meta: { study: "memory-v1", ...meta },
    },
    async () => {
      const response = await client!.messages.create({
        model: JUDGE_CONFIG.model,
        max_tokens: JUDGE_CONFIG.maxTokens,
        thinking: JUDGE_CONFIG.thinking,
        system: COHERENCE_SYSTEM,
        messages: [{ role: "user", content: evidence.text }],
        output_config: { format: { type: "json_schema", schema: COHERENCE_SCHEMA as unknown as Record<string, unknown> } },
      });
      if (response.stop_reason === "refusal") throw new Error("Judge request refused");
      if (response.stop_reason === "max_tokens") throw new Error("Judge output truncated at max_tokens");
      const text = response.content.find((b) => b.type === "text");
      if (!text || text.type !== "text") throw new Error(`Judge response without text (stop_reason=${response.stop_reason})`);
      return {
        verdict: JSON.parse(text.text) as CoherenceVerdict,
        requestedModel: JUDGE_CONFIG.model,
        returnedModel: response.model,
        requestId: (response as { _request_id?: string | null })._request_id ?? null,
        stopReason: response.stop_reason,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheCreationInputTokens: response.usage.cache_creation_input_tokens,
          cacheReadInputTokens: response.usage.cache_read_input_tokens,
        },
        latencyMs: Date.now() - started,
      };
    }
  );
};
