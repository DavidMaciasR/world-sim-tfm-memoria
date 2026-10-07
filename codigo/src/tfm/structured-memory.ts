// TFM A1 — memoria estructurada.
//
// A0 le pasa al modelo un bloque plano: los últimos años, todos con el mismo
// nivel de detalle, más las noticias simuladas. A1 lo reorganiza en dos capas
// con vidas distintas:
//
//   semántica — lo que cambia despacio (alianzas, rivales, doctrina y el
//               estado material del país). Se reafirma cada año.
//   episódica — lo que pasó, en orden. Los años recientes con detalle y los
//               antiguos comprimidos a una línea, en vez de tirar todo lo
//               anterior como hace A0 con su slice(-12) del historial (y su
//               slice(-8) de la memoria interna del agente).
//
// La compresión es el mecanismo, no un ahorro de tokens: un agente que ve
// veinte años resumidos y tres en detalle tiene más contexto útil que uno que
// ve ocho completos y nada antes.
//
// Todo determinista: mismo país-año, mismo texto. Si no, las tiradas dejan de
// ser comparables entre arquitecturas.

import type { HistoryEntry } from "../db";

export interface EpisodicEntry {
  simYear: number;
  move: string;
  /** Lo que el agente esperaba que ocurriera; es el campo que guarda el historial. */
  prediction?: string;
}

export interface SemanticProfile {
  country: string;
  allies: string[];
  rivals: string[];
  /** El "style" de la persona del simulador: postura y forma de decidir. */
  doctrine?: string;
  /** Prioridades estratégicas, también estables año a año. */
  priorities?: string[];
}

/** Años recientes que se conservan con detalle antes de empezar a comprimir. */
export const DETAILED_YEARS = 3;

function clean(text: string): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
  const t = clean(text);
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

export function formatSemanticMemory(profile: SemanticProfile): string {
  const lines: string[] = [];
  if (profile.allies.length > 0) lines.push(`  Allies: ${profile.allies.join(", ")}`);
  if (profile.rivals.length > 0) lines.push(`  Rivals: ${profile.rivals.join(", ")}`);
  if (profile.doctrine) lines.push(`  Doctrine: ${clean(profile.doctrine)}`);
  if (profile.priorities?.length) {
    lines.push(`  Priorities: ${profile.priorities.map(clean).join(" · ")}`);
  }
  // Perfil de partida, no hechos inmutables (RUNBOOK §2.2): si la simulación ya
  // ha cambiado una alianza, lo simulado manda y el encabezado lo dice.
  return lines.length > 0
    ? `INITIAL PROFILE (starting point; changes explicitly simulated in later years take precedence):\n${lines.join("\n")}`
    : "";
}

/**
 * Traza temporal con detalle decreciente: los `DETAILED_YEARS` más recientes
 * completos, el resto en una línea por año. El orden es siempre de antiguo a
 * reciente, para que el modelo lea una trayectoria y no una lista suelta.
 */
export function formatEpisodicMemory(
  entries: EpisodicEntry[],
  opts?: { detailedYears?: number }
): string {
  if (entries.length === 0) return "";
  const detailed = opts?.detailedYears ?? DETAILED_YEARS;
  const ordered = [...entries].sort((a, b) => a.simYear - b.simYear);
  const cutoff = ordered.length - detailed;

  const lines = ordered.map((e, i) => {
    if (i < cutoff) {
      return `  ${e.simYear}: ${truncate(e.move, 90)}`;
    }
    const expected = e.prediction ? ` → expected: ${truncate(e.prediction, 110)}` : "";
    return `  ${e.simYear}: ${truncate(e.move, 180)}${expected}`;
  });

  const header =
    cutoff > 0
      ? `TRAJECTORY (${ordered.length} years; last ${detailed} in detail, earlier ones summarized):`
      : `TRAJECTORY (${ordered.length} year${ordered.length === 1 ? "" : "s"}):`;
  return `${header}\n${lines.join("\n")}`;
}

export function formatStructuredMemory(
  profile: SemanticProfile,
  entries: EpisodicEntry[],
  opts?: { detailedYears?: number }
): string {
  const blocks = [formatSemanticMemory(profile), formatEpisodicMemory(entries, opts)].filter(Boolean);
  return blocks.length > 0 ? blocks.join("\n\n") : "(no prior memory — first simulated year)";
}

/** Convierte el historial que ya maneja el runner en entradas episódicas. */
export function episodicFromHistory(history: HistoryEntry[]): EpisodicEntry[] {
  return history
    .filter((h) => Number.isFinite(h.sim_year) && clean(h.move).length > 0)
    .map((h) => ({
      simYear: h.sim_year,
      move: h.move,
      prediction: clean(h.prediction) || undefined,
    }));
}
