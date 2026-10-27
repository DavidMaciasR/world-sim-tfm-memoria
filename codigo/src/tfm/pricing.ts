// Price table for cost measurement.
// Prices in USD per million tokens. Gemini 2.5 Pro rates are the <=200k-token
// prompt tier (pilot prompts are far below that; the >200k tier is 2.50/15).
// Gemini bills thinking ("thoughts") tokens at the output rate.

export interface ModelPrice {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

export const PRICES: Record<string, ModelPrice> = {
  "gemini-2.5-pro": { inputUsdPerMTok: 1.25, outputUsdPerMTok: 10 },
  // Fallback model of the country agent — priced so a mid-run model switch
  // still yields a (flagged) cost figure instead of crashing the pilot.
  "gemini-2.5-flash": { inputUsdPerMTok: 0.3, outputUsdPerMTok: 2.5 },
  // Gemini 3.x (lanzados tras el plan v4). Ojo al contraintuitivo: "flash" ya
  // no significa barato — 3.6-flash cuesta más por entrada que 2.5-pro, y
  // cinco veces más que 2.5-flash. Sale a cuenta frente a 2.5-pro solo porque
  // su salida es más barata, y la salida domina (el razonamiento se factura
  // como salida). Precios de julio 2026.
  "gemini-3.6-flash": { inputUsdPerMTok: 1.5, outputUsdPerMTok: 7.5 },
  // Mismo precio que 2.5-flash, pero sin su fecha de apagado. Usado en
  // producción: en pruebas resuelve bien un prompt-país realista y no emite
  // tokens de razonamiento, así que su coste real es aún menor que el nominal.
  // No se usa como generador del TFM justamente por eso: sin razonamiento,
  // medir la calidad del análisis geopolítico mediría otra cosa.
  "gemini-3.5-flash-lite": { inputUsdPerMTok: 0.3, outputUsdPerMTok: 2.5 },
  "claude-sonnet-5": { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
  // Introductory pricing valid through 2026-08-31 — reported for reference,
  // the budget verdict always uses the standard rate above.
  "claude-sonnet-5:intro": { inputUsdPerMTok: 2, outputUsdPerMTok: 10 },
};

export const EUR_PER_USD = Number(process.env.TFM_EUR_PER_USD ?? "0.86");

export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const price = PRICES[model];
  if (!price) throw new Error(`No price entry for model: ${model}`);
  return (
    (inputTokens / 1_000_000) * price.inputUsdPerMTok +
    (outputTokens / 1_000_000) * price.outputUsdPerMTok
  );
}

export function usdToEur(usd: number): number {
  return usd * EUR_PER_USD;
}
