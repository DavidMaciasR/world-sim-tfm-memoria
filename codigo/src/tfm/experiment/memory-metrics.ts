// memory-v1 — medidas del estudio, congeladas tras el desarrollo (24 sep).
//
// Principal: contradicciones con los años anteriores que el juez cita y que
// pasan el control mecánico de la evidencia. La nota 1–5 queda como secundaria:
// en desarrollo el 80 % de los juicios eran un 5 y la escala no discriminaba.
// Repetición: similitud media de cada titular con el más parecido del año
// anterior (Jaccard de tokens), continua. La repetición de 4-gramas dentro del
// año y el porcentaje de titulares reciclados (umbral 0,6) salían a cero en las
// dos condiciones y se conservan solo como diagnóstico.
// Elegidas por sensibilidad sobre datos de desarrollo, no por el sentido de la
// diferencia: con ninguna de ellas cambiaba qué condición quedaba por delante.

import { headlineRecycling, ngramRepetitionRate } from "../degeneration-metrics";

export interface JudgmentLike {
  status: string;
  verdict?: { score: number | null; evidence?: { conflict?: string; prior_field?: string; prior_quote?: string; current_field?: string; current_quote?: string }[] };
  evidenceProblems?: string[];
}

export interface NewsItemLike {
  headline: string;
  body?: string;
}

/** Evidencias que no tienen ningún problema en el control mecánico. */
export function validEvidenceIndexes(j: JudgmentLike): number[] {
  const evidence = j.verdict?.evidence ?? [];
  const bad = new Set<number>();
  for (const p of j.evidenceProblems ?? []) {
    const m = p.match(/^evidence\[(\d+)\]/);
    if (m) bad.add(Number(m[1]));
  }
  return evidence.map((_, i) => i).filter((i) => !bad.has(i));
}

/** Contradicciones válidas del país-año; null si no hubo juicio (primer año o fallo). */
export function validContradictions(j: JudgmentLike | undefined): number | null {
  if (!j || j.status !== "ok") return null;
  return validEvidenceIndexes(j).length;
}

/** Similitud media con el año anterior; null el primer año (no hay con qué comparar). */
export function headlineSimilarityToPreviousYear(current: NewsItemLike[], previous: NewsItemLike[] | undefined): number | null {
  if (!previous || previous.length === 0 || current.length === 0) return null;
  return headlineRecycling(current.map((n) => n.headline), previous.map((n) => n.headline), 0.6).meanMaxSimilarity;
}

export interface CountryYearMetrics {
  contradictions: number | null;
  score: number | null;
  headlineSimilarity: number | null;
  // diagnóstico
  ngram4: number;
  recycledShare: number | null;
}

export function countryYearMetrics(news: NewsItemLike[], previousNews: NewsItemLike[] | undefined, j: JudgmentLike | undefined): CountryYearMetrics {
  return {
    contradictions: validContradictions(j),
    score: j?.status === "ok" ? j.verdict?.score ?? null : null,
    headlineSimilarity: headlineSimilarityToPreviousYear(news, previousNews),
    ngram4: ngramRepetitionRate(news.map((n) => `${n.headline}. ${n.body ?? ""}`), 4),
    recycledShare: previousNews && previousNews.length
      ? headlineRecycling(news.map((n) => n.headline), previousNews.map((n) => n.headline), 0.6).recycledShare
      : null,
  };
}

/**
 * Media de un mundo con el peso igual por país (RUNBOOK §3.5, regla 2): primero
 * la media de cada país sobre sus años aplicables, luego la media de países.
 */
export function worldMean(rows: { country: string; value: number | null }[]): number | null {
  const byCountry = new Map<string, number[]>();
  for (const r of rows) {
    if (r.value == null) continue;
    byCountry.set(r.country, [...(byCountry.get(r.country) ?? []), r.value]);
  }
  const means = [...byCountry.values()].map((v) => v.reduce((a, b) => a + b, 0) / v.length);
  return means.length ? means.reduce((a, b) => a + b, 0) / means.length : null;
}
