import { insertLlmCallEvent, type LlmCallEventInput } from "./db";

interface LlmTelemetryBase {
  feature: string;
  provider: string;
  model?: string;
  simYear?: number | null;
  country?: string;
  meta?: Record<string, unknown>;
}

function summarizeError(err: unknown): string {
  if (err instanceof Error) return err.message.trim().slice(0, 280);
  return String(err ?? "").trim().slice(0, 280);
}

export function classifyLlmError(err: unknown): string {
  const message = summarizeError(err).toLowerCase();
  if (!message) return "unknown";
  if (
    message.includes("quota") ||
    message.includes("billing") ||
    message.includes("resource exhausted") ||
    message.includes("check your plan")
  ) {
    return "quota";
  }
  if (message.includes("429") || message.includes("rate limit")) return "rate_limit";
  if (message.includes("401") || message.includes("unauthorized") || message.includes("missing gemini_api_key") || message.includes("missing perplexity_api_key")) {
    return "auth";
  }
  if (message.includes("403") || message.includes("permission")) return "permission";
  if (message.includes("timeout") || message.includes("timed out")) return "timeout";
  if (message.includes("unavailable") || message.includes("service unavailable")) return "service_unavailable";
  if (message.includes("invalid image") || message.includes("invalid payload")) return "invalid_payload";
  if (message.includes("missing content") || message.includes("unreadable") || message.includes("invalid response")) {
    return "invalid_response";
  }
  if (message.includes("request failed") || message.includes("fetch failed")) return "request_failed";
  return "unknown";
}

export function recordLlmOutcome(
  input: LlmTelemetryBase & {
    status: LlmCallEventInput["status"];
    startedAtMs?: number;
    errorCategory?: string;
    errorMessage?: string;
    meta?: Record<string, unknown>;
  }
): void {
  const latencyMs = typeof input.startedAtMs === "number" ? Math.max(0, Date.now() - input.startedAtMs) : 0;
  insertLlmCallEvent({
    ts: Date.now(),
    simYear: input.simYear,
    feature: input.feature,
    provider: input.provider,
    model: input.model,
    country: input.country,
    status: input.status,
    latencyMs,
    errorCategory: input.errorCategory,
    errorMessage: input.errorMessage,
    meta: input.meta,
  });
}

export async function withLlmTelemetry<T>(
  input: LlmTelemetryBase,
  run: () => Promise<T>
): Promise<T> {
  const startedAtMs = Date.now();
  try {
    const result = await run();
    recordLlmOutcome({
      ...input,
      status: "success",
      startedAtMs,
    });
    return result;
  } catch (err) {
    recordLlmOutcome({
      ...input,
      status: "error",
      startedAtMs,
      errorCategory: classifyLlmError(err),
      errorMessage: summarizeError(err),
    });
    throw err;
  }
}
