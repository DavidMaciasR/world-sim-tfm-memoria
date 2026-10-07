// TFM F3a — Our World in Data indicator fetcher + parser.
// Supplies the numeric grounding A1 consumes (plan §05), requested by the
// cotutor in tutoría 1: feeding agents only with generalist news is "a finger
// in the air". Pure logic (no LLM); network access is a plain HTTPS GET
// against OWID's public grapher CSV endpoint. Licence: CC BY 4.0 (attribute).
//
// Deliberately a *probe* first: which indicators actually cover the 8 TFM
// countries is an open question — the World Bank publishes neither Taiwan nor
// North Korea — and building the ingestion before answering it would mean
// building on a false assumption.

export interface IndicatorSpec {
  id: string; // internal key, used for filenames
  slug: string; // OWID grapher slug
  label: string; // etiqueta para los informes (español)
  labelEn: string; // etiqueta para el prompt del agente — el resto del prompt es inglés,
  // y un cambio de idioma a mitad de prompt sería un confusor atribuido a A1
  unit: string; // junto a cada valor en informes: un "7.65" pelado es ambiguo
  unitEn: string; // ídem para el prompt
  valueColumn: string; // CSV column holding the value
  note?: string; // caveat worth carrying into the memoria
}

// Candidates for the series named in plan §05. Two rival options are
// probed for energy on purpose: "fossil fuels share" is the closer match to
// the cotutor's own example (a country 40 % dependent on oil cannot drop it
// overnight), but consumption per capita may have wider coverage.
export const INDICATOR_CANDIDATES: IndicatorSpec[] = [
  {
    id: "gdp-per-capita",
    slug: "gdp-per-capita-maddison",
    label: "PIB per cápita (Maddison)",
    labelEn: "GDP per capita (Maddison)",
    unit: "$ internacionales",
    unitEn: "int'l $",
    valueColumn: "GDP per capita",
    note: "Maddison en vez del Banco Mundial: el del BM no publica ni Taiwán ni Corea del Norte.",
  },
  {
    id: "unemployment",
    slug: "unemployment-rate",
    label: "Tasa de paro",
    labelEn: "Unemployment rate",
    unit: "%",
    unitEn: "%",
    valueColumn: "Unemployment rate",
  },
  {
    id: "military-spending",
    slug: "military-expenditure-share-gdp",
    label: "Gasto militar",
    labelEn: "Military spending",
    unit: "% del PIB",
    unitEn: "% of GDP",
    valueColumn: "Military expenditure (% of GDP)",
    note: "Fuente SIPRI.",
  },
  {
    id: "democracy-index",
    slug: "electoral-democracy-index",
    label: "Índice de democracia electoral",
    labelEn: "Electoral democracy index",
    unit: "sobre 1",
    unitEn: "of 1",
    valueColumn: "Electoral democracy index",
    note: "Fuente V-Dem.",
  },
  {
    id: "energy-per-capita",
    slug: "energy-use-per-capita",
    label: "Consumo de energía per cápita",
    labelEn: "Energy use per capita",
    unit: "kWh/persona",
    unitEn: "kWh/person",
    valueColumn: "Per capita energy consumption",
  },
  {
    id: "fossil-share",
    slug: "fossil-fuels-share-energy",
    label: "Peso de los combustibles fósiles en la energía",
    labelEn: "Fossil fuel share of energy",
    unit: "% de la energía",
    unitEn: "% of energy",
    valueColumn: "Fossil fuels",
    note: "El match semántico más cercano a «dependencia energética» del §04.",
  },
];

// Plan §06 country list (v5.1: 8 countries) → the Entity name OWID uses.
// Kept separate from TFM_COUNTRIES in wiki-chronology.ts: the two sources
// disagree on naming, and coupling them would break one of them silently.
export const TFM_COUNTRIES_OWID: Record<string, string> = {
  India: "India",
  Pakistan: "Pakistan",
  China: "China",
  "United States": "United States",
  Russia: "Russia",
  "South Korea": "South Korea",
  "North Korea": "North Korea",
  Taiwan: "Taiwan",
};

// Development set (plan §06, v5.3): the rubric, prompts and A1's design are
// iterated on these three countries so the eval 8 stay untouched until the
// design freezes. They need indicators too — without them A1 cannot even run
// on the dev set, which would silently force iterating on the eval countries.
export const DEV_COUNTRIES_OWID: Record<string, string> = {
  Germany: "Germany",
  France: "France",
  // Rusia en vez de Japon: Alemania y Francia la tienen como rival, asi que el
  // mundo de desarrollo reproduce la estructura del de evaluacion (aliados mas
  // un rival presente). Con Japon nadie veia a un rival y Japon no veia a
  // nadie, porque sus aliados y rivales no estaban en ese mundo.
  Russia: "Russia",
};

export const ALL_COUNTRIES_OWID: Record<string, string> = {
  ...TFM_COUNTRIES_OWID,
  ...DEV_COUNTRIES_OWID,
};

// The backtesting window (plan §06). An indicator is only useful to A1 if it
// covers these years — a series that stops in 2019 grounds nothing for 2023.
export const BACKTEST_YEARS = Array.from({ length: 10 }, (_, i) => 2015 + i);

// An indicator-country pair is "usable" when it covers at least this share of
// the window. Below it, A1 has to operate without the series and say so (R9).
export const MIN_YEAR_COVERAGE = 0.8;

export function indicatorCsvUrl(slug: string): string {
  return `https://ourworldindata.org/grapher/${slug}.csv?v=1&csvType=full`;
}

export interface IndicatorPoint {
  country: string; // TFM canonical name, not the OWID entity
  year: number;
  value: number;
}

/**
 * Parse an OWID grapher CSV down to the TFM countries and numeric values.
 * Only the requested value column is kept; other columns vary per dataset.
 */
export function parseOwidCsv(csv: string, valueColumn: string): IndicatorPoint[] {
  const lines = csv.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  const header = splitCsvLine(lines[0]);
  const entityIdx = header.indexOf("Entity");
  const yearIdx = header.indexOf("Year");
  const valueIdx = header.indexOf(valueColumn);
  if (entityIdx === -1 || yearIdx === -1 || valueIdx === -1) {
    throw new Error(
      `CSV sin las columnas esperadas (Entity/Year/${valueColumn}); tiene: ${header.join(", ")}`
    );
  }

  // OWID entity name -> TFM canonical name (eval 8 + dev 3).
  const byEntity = new Map<string, string>();
  for (const [canonical, entity] of Object.entries(ALL_COUNTRIES_OWID)) {
    byEntity.set(entity, canonical);
  }

  const points: IndicatorPoint[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const canonical = byEntity.get(cols[entityIdx]);
    if (!canonical) continue;

    const year = Number.parseInt(cols[yearIdx], 10);
    const value = Number.parseFloat(cols[valueIdx]);
    if (!Number.isFinite(year) || !Number.isFinite(value)) continue;

    points.push({ country: canonical, year, value });
  }
  return points;
}

/** Minimal RFC-4180 split: OWID quotes fields containing commas. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(field);
      field = "";
    } else field += ch;
  }
  out.push(field);
  return out.map((f) => f.trim().replace(/\r$/, ""));
}

export interface CountryCoverage {
  country: string;
  yearsCovered: number;
  firstYear: number | null;
  lastYear: number | null;
  missingYears: number[];
  usable: boolean;
}

/** Coverage of one indicator over the backtest window, per country. */
export function coverageByCountry(points: IndicatorPoint[]): CountryCoverage[] {
  return Object.keys(TFM_COUNTRIES_OWID).map((country) => {
    const years = points
      .filter((p) => p.country === country && BACKTEST_YEARS.includes(p.year))
      .map((p) => p.year)
      .sort((a, b) => a - b);
    const unique = [...new Set(years)];

    return {
      country,
      yearsCovered: unique.length,
      firstYear: unique.length > 0 ? unique[0] : null,
      lastYear: unique.length > 0 ? unique[unique.length - 1] : null,
      missingYears: BACKTEST_YEARS.filter((y) => !unique.includes(y)),
      usable: unique.length >= BACKTEST_YEARS.length * MIN_YEAR_COVERAGE,
    };
  });
}

// Series are stored with a lead-in before the 2015 seed so an agent standing
// at the first simulated year still sees a trend behind it, not a single point.
export const SERIES_START_YEAR = 2005;

export interface CountryIndicators {
  country: string;
  generatedAt: string;
  source: string;
  /** indicator id -> year -> value. Absent indicators are simply not present. */
  series: Record<string, Record<string, number>>;
  /** Indicator ids with no data at all for this country — declared, not hidden (R9). */
  unavailable: string[];
}

export function buildCountryIndicators(
  country: string,
  byIndicator: Record<string, IndicatorPoint[]>
): CountryIndicators {
  const series: Record<string, Record<string, number>> = {};
  const unavailable: string[] = [];

  for (const spec of INDICATOR_CANDIDATES) {
    const points = (byIndicator[spec.id] ?? []).filter(
      (p) => p.country === country && p.year >= SERIES_START_YEAR
    );
    if (points.length === 0) {
      unavailable.push(spec.id);
      continue;
    }
    const years: Record<string, number> = {};
    for (const p of points.sort((a, b) => a.year - b.year)) years[String(p.year)] = p.value;
    series[spec.id] = years;
  }

  return {
    country,
    generatedAt: new Date().toISOString(),
    source: "Our World in Data (CC BY 4.0)",
    series,
    unavailable,
  };
}

/**
 * Slice a country's series to what was knowable at `year`.
 *
 * This is the whole point of storing full series rather than pre-rendered
 * text: in a backtest the agent standing at 2018 must not see 2019 figures.
 * The model's parametric memory of those years is a separate confound we
 * cannot remove (plan §06), but the *inputs* we hand it must at least be
 * honest, or the backtest measures nothing.
 */
export function indicatorsAsOf(
  data: CountryIndicators,
  year: number
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [id, years] of Object.entries(data.series)) {
    const kept: Record<string, number> = {};
    for (const [y, v] of Object.entries(years)) {
      if (Number.parseInt(y, 10) <= year) kept[y] = v;
    }
    if (Object.keys(kept).length > 0) out[id] = kept;
  }
  return out;
}

function fmtNumber(n: number): string {
  const rounded = Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 100) / 100;
  return String(rounded);
}

/**
 * Compact, deterministic rendering of a country's indicators for the A1 prompt.
 * Deterministic on purpose: the same country-year must always produce the same
 * text, or runs stop being comparable across architectures.
 */
export function formatIndicatorsForPrompt(
  data: CountryIndicators,
  year: number,
  opts?: { trendYears?: number }
): string {
  return renderIndicators(data, year, {
    header: `Real-world indicators for ${data.country}, as known in ${year}:`,
    empty: `No indicators available for ${data.country} as of ${year}.`,
    trendYears: opts?.trendYears,
  });
}

/**
 * The memory-v1 rendering (RUNBOOK §2.2): simulating year Y the agent sees only
 * observations dated Y-1 or earlier, and the text states that cutoff instead of
 * claiming the values were "known" in Y. Downloaded series include revisions and
 * late releases, so lagging the observation year does not prove the figure was
 * available at the time — the header says what was done, nothing more.
 */
export function formatLaggedIndicatorsForPrompt(data: CountryIndicators, simYear: number): string {
  const cutoff = simYear - 1;
  return renderIndicators(data, cutoff, {
    header: `Real-world indicators for ${data.country}, observations dated ${cutoff} or earlier:`,
    empty: `No indicators available for ${data.country} with observations dated ${cutoff} or earlier.`,
  });
}

/** Latest observation year per series under the lagged cutoff, for manifests. */
export function latestObservationYears(data: CountryIndicators, simYear: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, years] of Object.entries(indicatorsAsOf(data, simYear - 1))) {
    out[id] = Math.max(...Object.keys(years).map((y) => Number.parseInt(y, 10)));
  }
  return out;
}

function renderIndicators(
  data: CountryIndicators,
  year: number,
  text: { header: string; empty: string; trendYears?: number }
): string {
  const trendYears = text.trendYears ?? 5;
  const asOf = indicatorsAsOf(data, year);
  const lines: string[] = [];

  for (const spec of INDICATOR_CANDIDATES) {
    const years = asOf[spec.id];
    if (!years) continue;

    const sorted = Object.keys(years)
      .map((y) => Number.parseInt(y, 10))
      .sort((a, b) => a - b);
    const last = sorted[sorted.length - 1];
    const latest = years[String(last)];

    // Stale series are labelled: "latest available" is not the same as "current".
    const staleness = last < year ? ` (latest available: ${last})` : ` (${last})`;
    let line = `- ${spec.labelEn}: ${fmtNumber(latest)} ${spec.unitEn}${staleness}`;

    const baseYear = sorted.filter((y) => y <= last - trendYears).pop();
    if (baseYear !== undefined) {
      const base = years[String(baseYear)];
      const pct = base !== 0 ? ((latest - base) / Math.abs(base)) * 100 : null;
      line += ` · ${baseYear}: ${fmtNumber(base)}`;
      if (pct !== null) line += ` (${pct >= 0 ? "+" : ""}${fmtNumber(pct)} %)`;
    }
    lines.push(line);
  }

  if (lines.length === 0) return text.empty;

  const missing = INDICATOR_CANDIDATES.filter(
    (s) => !asOf[s.id]
  ).map((s) => s.labelEn);
  const footer = missing.length ? `\nNo data for this country: ${missing.join("; ")}.` : "";
  return `${text.header}\n${lines.join("\n")}${footer}`;
}

export async function fetchIndicatorCsv(slug: string): Promise<string> {
  const res = await fetch(indicatorCsvUrl(slug), {
    headers: { "User-Agent": "world-sim TFM research (contact via repo)" },
  });
  if (!res.ok) throw new Error(`OWID ${slug}: HTTP ${res.status}`);
  return res.text();
}
