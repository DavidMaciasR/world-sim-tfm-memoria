// Wikipedia year-page ("2015 in India", ...) fetcher + parser.
// Produces the monthly reference chronology used by backtesting and the judge.
// Pure logic (no LLM); network access is plain HTTPS GET against the public
// Wikipedia raw-wikitext endpoint. Content license: CC BY-SA 4.0 (attribute).

export interface ChronologyEvent {
  month: number | null; // 1-12, null when unattributable
  day: number | null;
  text: string;
  section: string; // "Events > March" — provenance for auditing
  source?: string; // absent = "YYYY in <country>" page; "portal-current-events" = supplement
}

// A country-year is "weak" below these thresholds (used by build-chronologies
// coverage report and the supplement runner).
export const COVERAGE_THRESHOLDS = { minEvents: 12, minMonths: 6 };

// Canonical country list → Wikipedia title fragment.
// Deliberately independent from the sim's country keys ("United States of America").
export const TFM_COUNTRIES: Record<string, string> = {
  India: "India",
  Pakistan: "Pakistan",
  China: "China",
  "United States": "the United States",
  Russia: "Russia",
  Japan: "Japan",
  "South Korea": "South Korea",
  "North Korea": "North Korea",
  Taiwan: "Taiwan",
  Germany: "Germany",
  France: "France",
};

export function countrySlug(country: string): string {
  return country.toLowerCase().replace(/\s+/g, "-");
}

const MONTH_NAMES_FOR_FORMAT = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// Renders a chronology as the plain-text block the judge receives. Caps the
// event count (spread across months) to bound judge input cost.
export function formatChronologyForJudge(
  events: ChronologyEvent[],
  opts?: { maxEvents?: number }
): string {
  const maxEvents = opts?.maxEvents ?? 60;
  const byMonth = new Map<number | null, ChronologyEvent[]>();
  for (const ev of events) {
    const key = ev.month;
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key)!.push(ev);
  }
  const buckets = [...byMonth.entries()].sort((a, b) => (a[0] ?? 13) - (b[0] ?? 13));
  const perBucket = Math.max(1, Math.ceil(maxEvents / Math.max(1, buckets.length)));

  const lines: string[] = [];
  let used = 0;
  for (const [month, bucket] of buckets) {
    for (const ev of bucket.slice(0, perBucket)) {
      if (used >= maxEvents) break;
      const label = month === null ? "Undated" : MONTH_NAMES_FOR_FORMAT[month - 1];
      lines.push(`- [${label}] ${ev.text}`);
      used++;
    }
  }
  return lines.join("\n");
}

export function wikiPageTitle(country: string, year: number): string {
  const fragment = TFM_COUNTRIES[country];
  if (!fragment) throw new Error(`Country not in TFM list: ${country}`);
  return `${year} in ${fragment}`;
}

const WIKI_RAW_URL = "https://en.wikipedia.org/w/index.php";
const USER_AGENT =
  "world-sim-tfm-chronology/0.1 (academic research, Master's thesis; contact: https://github.com/DavidMaciasR/world-sim-tfm-memoria)";

export async function fetchYearPageWikitext(country: string, year: number): Promise<{
  pageTitle: string;
  wikitext: string;
}> {
  let title = wikiPageTitle(country, year);
  for (let hop = 0; hop < 2; hop++) {
    const url = `${WIKI_RAW_URL}?title=${encodeURIComponent(title.replace(/ /g, "_"))}&action=raw`;
    let res: Response | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
        if (res.ok || res.status === 404) break;
      } catch {
        res = null;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (!res) throw new Error(`Network failure fetching "${title}"`);
    if (res.status === 404) throw new Error(`Wikipedia page missing: "${title}"`);
    if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status} for "${title}"`);
    const wikitext = await res.text();
    const redirect = wikitext.match(/^#REDIRECT\s*\[\[([^\]|#]+)/i);
    if (redirect) {
      title = redirect[1].trim();
      continue;
    }
    if (wikitext.trim().length === 0) throw new Error(`Wikipedia page empty: "${title}"`);
    return { pageTitle: title, wikitext };
  }
  throw new Error(`Redirect loop resolving "${wikiPageTitle(country, year)}"`);
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTH_ALTERNATION = MONTHS.join("|");
const MONTH_INDEX = new Map(MONTHS.map((m, i) => [m.toLowerCase(), i + 1]));

// h2 sections whose bullets count as chronology events. Real pages vary:
// "Events", "Predicted and scheduled events", "Scheduled events", "Elections",
// and some (e.g. "2018 in North Korea") put month names directly as h2.
function isAllowedH2(title: string): boolean {
  if (MONTH_INDEX.has(title.trim().toLowerCase())) return true;
  return /\bevents?\b/i.test(title) || /^elections\b/i.test(title);
}

export function cleanWikitext(raw: string): string {
  let text = raw;
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/<ref[^>]*\/>/gi, "");
  text = text.replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "");
  // Innermost-first removal handles nested templates and links.
  for (let i = 0; i < 10; i++) {
    const next = text
      .replace(/\{\{[^{}]*\}\}/g, "")
      .replace(/\[\[(?:File|Image):[^[\]]*\]\]/gi, "")
      .replace(/\[\[[^[\]|]*\|([^[\]]*)\]\]/g, "$1")
      .replace(/\[\[([^[\]]*)\]\]/g, "$1");
    if (next === text) break;
    text = next;
  }
  text = text.replace(/\[https?:\/\/\S+\s+([^\]]+)\]/g, "$1"); // external links with label
  text = text.replace(/\[https?:\/\/\S+\]/g, "");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/'''''|'''|''/g, "");
  text = text
    .replace(/&ndash;|&mdash;/g, "–")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
  return text.replace(/\s+/g, " ").trim();
}

const DASH = "[–—-]";
const RE_MONTH_DAY = new RegExp(
  `^(${MONTH_ALTERNATION})\\s+(\\d{1,2})(?:\\s*${DASH}\\s*\\d{1,2})?\\b`,
  "i"
);
const RE_DAY_MONTH = new RegExp(
  `^(\\d{1,2})(?:\\s*${DASH}\\s*\\d{1,2})?\\s+(${MONTH_ALTERNATION})\\b`,
  "i"
);
const RE_MONTH_ONLY = new RegExp(`^(${MONTH_ALTERNATION})\\s*${DASH}`, "i");

export function parseLeadingDate(text: string): { month: number | null; day: number | null } {
  const monthDay = text.match(RE_MONTH_DAY);
  if (monthDay) {
    return { month: MONTH_INDEX.get(monthDay[1].toLowerCase()) ?? null, day: Number(monthDay[2]) };
  }
  const dayMonth = text.match(RE_DAY_MONTH);
  if (dayMonth) {
    return { month: MONTH_INDEX.get(dayMonth[2].toLowerCase()) ?? null, day: Number(dayMonth[1]) };
  }
  const monthOnly = text.match(RE_MONTH_ONLY);
  if (monthOnly) {
    return { month: MONTH_INDEX.get(monthOnly[1].toLowerCase()) ?? null, day: null };
  }
  return { month: null, day: null };
}

function sectionMonth(title: string): number | null {
  const normalized = title.trim().toLowerCase();
  return MONTH_INDEX.get(normalized) ?? null; // "January - March" etc. → null
}

const MIN_EVENT_CHARS = 20;

export function parseYearPage(wikitext: string): ChronologyEvent[] {
  const events: ChronologyEvent[] = [];
  let h2 = "";
  let sub = "";
  let inAllowedSection = false;

  for (const line of wikitext.split("\n")) {
    const header = line.match(/^(={2,4})\s*(.+?)\s*\1\s*$/);
    if (header) {
      const level = header[1].length;
      const title = cleanWikitext(header[2]);
      if (level === 2) {
        h2 = title;
        sub = "";
        inAllowedSection = isAllowedH2(title);
      } else {
        sub = title;
      }
      continue;
    }
    if (!inAllowedSection) continue;
    if (!/^\*+\s*\S/.test(line)) continue;

    const text = cleanWikitext(line.replace(/^\*+\s*/, ""));
    if (text.length < MIN_EVENT_CHARS) continue;

    const { month: bulletMonth, day } = parseLeadingDate(text);
    const month = bulletMonth ?? sectionMonth(sub) ?? sectionMonth(h2);
    events.push({
      month,
      day,
      text,
      section: sub ? `${h2} > ${sub}` : h2,
    });
  }
  return events;
}
