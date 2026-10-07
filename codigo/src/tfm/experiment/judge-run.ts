// memory-v1 — CLI del juez de coherencia sobre una tirada generada.
//
//   cd apps/server
//   npx ts-node src/tfm/experiment/judge-run.ts --run memory-v1-pilot-a1g-r1 --dry-run
//   npx ts-node src/tfm/experiment/judge-run.ts --run memory-v1-pilot-a1g-r1 --yes
//
// --runs-dir <dir> apunta a otro directorio de tiradas (p. ej. un fixture para
// ensayar tamaños). El ensayo en seco no llama a nadie ni escribe nada.

import "../../load-env";
import fs from "fs";
import path from "path";
import { callCoherenceJudge, COHERENCE_SYSTEM, JUDGE_CONFIG } from "./coherence-judge";
import { runCoherenceJudging } from "./judge-runner";
import { PRICES, EUR_PER_USD } from "../pricing";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const DEFAULT_RUNS_DIR = path.join(REPO_ROOT, "docs", "tfm", "runs");

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (flag: string) => process.argv.includes(flag);

// ~4 caracteres por token: estimación; el recuento real queda en judgments.jsonl.
const approxTokens = (chars: number) => Math.round(chars / 4);

async function main(): Promise<void> {
  const runId = arg("--run");
  const dryRun = has("--dry-run");
  if (!runId || (!dryRun && !has("--yes"))) {
    console.error("Uso: judge-run.ts --run <runId> [--runs-dir <dir>] --dry-run|--yes");
    process.exit(2);
  }
  const runDir = path.join(path.resolve(arg("--runs-dir") ?? DEFAULT_RUNS_DIR), runId);
  if (!fs.existsSync(runDir)) throw new Error(`No existe la tirada ${runDir}`);

  // El formateador de evidencia y el runner forman parte de las condiciones del juez.
  const formatterSource = ["coherence-judge.ts", "judge-runner.ts", "../../world-context.ts"]
    .map((f) => fs.readFileSync(path.join(__dirname, f), "utf8"))
    .join("\n");

  if (!dryRun && !process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY missing — abortando antes de gastar");
  }

  const summary = await runCoherenceJudging({
    runDir,
    formatterSource,
    call: callCoherenceJudge,
    dryRun,
    onItem: (item, j) => {
      if (dryRun) return;
      if (!j) return;
      const detail =
        j.status === "ok"
          ? `score ${j.verdict?.score ?? "null"}${j.evidenceValid ? "" : ` · evidencia inválida (${j.evidenceProblems?.length})`}`
          : j.status === "structural_na"
            ? "N/A (primer año)"
            : `ERROR ${j.error?.slice(0, 100)}`;
      console.log(`  ${item.key.padEnd(20)} ${detail}`);
    },
  });

  const count = (a: string) => summary.plan.filter((p) => p.action === a).length;
  console.log(`Tirada:      ${summary.runId}`);
  console.log(`Juez:        ${JUDGE_CONFIG.model} · thinking ${JUDGE_CONFIG.thinking.type} · ${JUDGE_CONFIG.sampling}`);
  console.log(`Condiciones: ${summary.judgeConditionHash}`);
  console.log(
    `Plan:        ${count("judge")} por juzgar · ${count("structural_na")} N/A estructurales · ` +
      `${count("skip_done")} ya juzgados · ${count("missing_generation")} sin generación · ${count("blocked")} bloqueados`
  );
  for (const p of summary.plan.filter((x) => x.action === "blocked" || x.action === "missing_generation")) {
    console.log(`  ${p.key}: ${p.reason}`);
  }

  if (dryRun) {
    const toJudge = summary.plan.filter((p) => p.action === "judge");
    const systemTokens = approxTokens(COHERENCE_SYSTEM.length);
    const sizes = toJudge.map((p) => ({ key: p.key, tokens: systemTokens + approxTokens(p.evidence!.text.length) }));
    if (sizes.length > 0) {
      const byYear = new Map<number, number[]>();
      for (const p of toJudge) {
        const list = byYear.get(p.simYear) ?? [];
        list.push(systemTokens + approxTokens(p.evidence!.text.length));
        byYear.set(p.simYear, list);
      }
      console.log("\nEntrada por año (tokens aprox., sistema incluido):");
      for (const [year, list] of [...byYear.entries()].sort((a, b) => a[0] - b[0])) {
        console.log(`  ${year}: ${list.map((n) => `~${n}`).join(" · ")}`);
      }
      const price = PRICES[JUDGE_CONFIG.model];
      const input = sizes.reduce((s, x) => s + x.tokens, 0);
      const output = 400 * sizes.length; // veredicto + evidencia, sin razonamiento
      const usd = (input * price.inputUsdPerMTok + output * price.outputUsdPerMTok) / 1e6;
      console.log(
        `\nCoste estimado (${price.inputUsdPerMTok}/${price.outputUsdPerMTok} USD por M, ~400 tokens de salida por juicio): ` +
          `${(usd * EUR_PER_USD).toFixed(3)} € en total · ${((usd * EUR_PER_USD * 100) / sizes.length).toFixed(2)} cts €/juicio`
      );
    }
    console.log("\n(dry-run: ninguna llamada a proveedores, ningún juicio escrito)");
    return;
  }

  console.log(`\nResumen: ${summary.judged} juzgados · ${summary.structuralNa} N/A · ${summary.skipped} saltados · ${summary.errors} errores`);
  console.log(`Juicios en ${path.relative(REPO_ROOT, path.join(runDir, "coherence-judge"))}/judgments.jsonl`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
