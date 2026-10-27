// Deterministic degeneration/coherence metrics (no LLM).
// Pure functions over simulated-news-like records; used by the evaluation
// harness alongside the LLM judge, and by the analysis.
// Conceptual grounding: Holtzman et al. 2020 (degeneration), Welleck et al.
// 2020 (n-gram repetition rates).

export interface NewsLike {
  month: number | null;
  headline: string;
  body?: string;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function ngrams(tokens: string[], n: number): string[] {
  const grams: string[] = [];
  for (let i = 0; i + n <= tokens.length; i++) {
    grams.push(tokens.slice(i, i + n).join(" "));
  }
  return grams;
}

/**
 * Intra-corpus n-gram repetition: 1 - (distinct n-grams / total n-grams) over
 * the concatenation of all texts. 0 = no repetition; humans sit near 0 for
 * n>=3 (Welleck et al. 2020), degenerate output climbs sharply.
 */
export function ngramRepetitionRate(texts: string[], n = 3): number {
  const tokens = tokenize(texts.join("   "));
  const grams = ngrams(tokens, n);
  if (grams.length === 0) return 0;
  return 1 - new Set(grams).size / grams.length;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export interface RecyclingResult {
  recycledShare: number; // share of current headlines with max-similarity >= threshold
  meanMaxSimilarity: number; // mean over current headlines of max Jaccard vs prior
}

/**
 * Cross-year headline recycling: for each current headline, max token-Jaccard
 * similarity against all prior-year headlines. High values = the agent is
 * re-emitting last year's news (a degeneration mode we observed in the app).
 */
export function headlineRecycling(
  currentHeadlines: string[],
  priorHeadlines: string[],
  threshold = 0.6
): RecyclingResult {
  if (currentHeadlines.length === 0 || priorHeadlines.length === 0) {
    return { recycledShare: 0, meanMaxSimilarity: 0 };
  }
  const priorSets = priorHeadlines.map((h) => new Set(tokenize(h)));
  let recycled = 0;
  let simSum = 0;
  for (const headline of currentHeadlines) {
    const set = new Set(tokenize(headline));
    let maxSim = 0;
    for (const prior of priorSets) {
      const sim = jaccard(set, prior);
      if (sim > maxSim) maxSim = sim;
    }
    simSum += maxSim;
    if (maxSim >= threshold) recycled++;
  }
  return {
    recycledShare: recycled / currentHeadlines.length,
    meanMaxSimilarity: simSum / currentHeadlines.length,
  };
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length >= 25); // ignore fragments too short to be templates
}

/**
 * Template phrasing: share of sentences (across all items of a year) that
 * appear verbatim in more than one item. Catches boilerplate like "leadership
 * maintains calibrated diplomatic pressure" copied across months.
 */
export function templateSentenceShare(texts: string[]): number {
  const perItem = texts.map((t) => new Set(splitSentences(t)));
  const counts = new Map<string, number>();
  for (const sentences of perItem) {
    for (const s of sentences) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  let repeated = 0;
  for (const c of counts.values()) if (c > 1) repeated += c;
  return repeated / total;
}

/** Distinct months with at least one news item, out of 12. */
export function monthCoverage(news: NewsLike[]): number {
  const months = new Set(
    news.map((n) => n.month).filter((m): m is number => m !== null && m >= 1 && m <= 12)
  );
  return months.size / 12;
}

export interface DegenerationReport {
  ngramRepetition3: number;
  ngramRepetition4: number;
  headlineRecycledShare: number;
  headlineMeanMaxSimilarity: number;
  templateSentenceShare: number;
  monthCoverage: number;
}

/** One country-year's deterministic metrics vs its own prior years. */
export function degenerationReport(
  currentYear: NewsLike[],
  priorYearsHeadlines: string[]
): DegenerationReport {
  const bodies = currentYear.map((n) => `${n.headline}. ${n.body ?? ""}`);
  const recycling = headlineRecycling(
    currentYear.map((n) => n.headline),
    priorYearsHeadlines
  );
  return {
    ngramRepetition3: ngramRepetitionRate(bodies, 3),
    ngramRepetition4: ngramRepetitionRate(bodies, 4),
    headlineRecycledShare: recycling.recycledShare,
    headlineMeanMaxSimilarity: recycling.meanMaxSimilarity,
    templateSentenceShare: templateSentenceShare(bodies),
    monthCoverage: monthCoverage(currentYear),
  };
}
