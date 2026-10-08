#!/usr/bin/env python3
"""Figuras del capítulo 5 (resultados de memory-v1), en PDF para LaTeX.

    /usr/bin/python3 docs/tfm/tools/figuras-cap5.py   # el de pyenv no tiene matplotlib

Lee docs/tfm/results/memory-v1/eval/ (y followup/ para el seguimiento) y escribe en
docs/tfm/memoria/img/resultados/. Se vuelve a ejecutar si cambian los datos;
las figuras no se retocan a mano.

Estilo: Latin Modern (el Computer Modern del cuerpo de la memoria), ancho de caja (350 pt),
tinta oscura para la memoria plana y ladrillo para la estructurada (se
distinguen también en escala de grises), etiquetas sobre los datos en vez de
leyenda, sin marco superior ni derecho y sin título dentro de la figura: el
título es el \\caption.
"""

import csv
import json
import os
import statistics as st
from collections import Counter, defaultdict

import matplotlib

matplotlib.use("pdf")
import matplotlib.pyplot as plt
from matplotlib import font_manager
from matplotlib.ticker import FuncFormatter, MultipleLocator

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
EVAL = os.path.join(ROOT, "docs", "tfm", "results", "memory-v1", "eval")
FOLLOWUP = os.path.join(ROOT, "docs", "tfm", "results", "memory-v1", "followup")
OUT = os.path.join(ROOT, "docs", "tfm", "memoria", "img", "resultados")

INK = "#1F2A36"  # memoria plana
BRICK = "#B4532A"  # memoria estructurada (con las noticias del año anterior)
SAND = "#D9A47E"  # estructurada sin noticias: el paso extra de ahorro
RULE = "#8C9096"  # ejes y referencias
HAIR = "#D9DBDE"  # líneas de ayuda
# Comparación principal: plana frente a estructurada, las dos con las noticias del
# año anterior. La estructurada sin noticias es el paso extra para ahorrar entrada.
# Las claves son las de los CSV: "estructurada+noticias" es la estructurada (A1N,
# fase del 8 oct) y "estructurada" la que no ve noticias (A1, fase del 24 sep).
COND = [("plana", "Plana", INK), ("estructurada+noticias", "Estructurada", BRICK), ("estructurada", "Sin noticias", SAND)]
YEARS = list(range(2015, 2025))
COUNTRIES = [("United States", "EE. UU."), ("China", "China"), ("India", "India"), ("Pakistan", "Pakistán")]

TEXTWIDTH_IN = 350 / 72.27

# Latin Modern: el Computer Modern del cuerpo, con tildes y €. Viene con TinyTeX.
LM_DIR = os.path.expanduser("~/Library/TinyTeX/texmf-dist/fonts/opentype/public/lm")
for face in ("regular", "bold", "italic"):
    path = os.path.join(LM_DIR, f"lmroman10-{face}.otf")
    if os.path.exists(path):
        font_manager.fontManager.addfont(path)

plt.rcParams.update({
    "font.family": "serif",
    "font.serif": ["Latin Modern Roman", "cmr10"],
    "mathtext.fontset": "cm",
    "axes.formatter.use_mathtext": True,
    "axes.unicode_minus": False,
    "font.size": 9,
    "axes.labelsize": 9,
    "xtick.labelsize": 8,
    "ytick.labelsize": 8,
    "axes.edgecolor": RULE,
    "axes.linewidth": 0.6,
    "axes.labelcolor": INK,
    "xtick.color": RULE,
    "ytick.color": RULE,
    "xtick.labelcolor": INK,
    "ytick.labelcolor": INK,
    "xtick.direction": "out",
    "ytick.direction": "out",
    "xtick.major.size": 3,
    "ytick.major.size": 3,
    "xtick.major.width": 0.6,
    "ytick.major.width": 0.6,
    "axes.spines.top": False,
    "axes.spines.right": False,
    "savefig.bbox": "tight",
    "savefig.pad_inches": 0.02,
})


def coma(dec):
    """Formato con coma decimal y punto de millares, como el texto."""
    def f(x, _pos=None):
        s = f"{x:,.{dec}f}"
        return s.replace(",", "·").replace(".", ",").replace("·", ".")
    return FuncFormatter(f)


def num(x, dec):
    return coma(dec)(x)


def load():
    """Las tres memorias juntas, y aparte las filas de eval para el modelo de coste."""
    rows, contra, by_cond = [], [], {}
    for d in (EVAL, FOLLOWUP):
        rows += list(csv.DictReader(open(os.path.join(d, "country-years.csv"))))
        contra += [r for r in csv.DictReader(open(os.path.join(d, "contradictions.csv"))) if r["valid"] == "true"]
        by_cond.update(json.load(open(os.path.join(d, "summary.json")))["byCondition"])
    eval_rows = list(csv.DictReader(open(os.path.join(EVAL, "country-years.csv"))))
    return rows, contra, {"byCondition": by_cond}, eval_rows


def save(fig, name):
    os.makedirs(OUT, exist_ok=True)
    fig.savefig(os.path.join(OUT, name))
    plt.close(fig)
    print("  ", name)


def strip(ax, summary, key, lo, hi, step, dec, conds=COND):
    """Un punto por mundo, una fila por memoria, raya en la media."""
    top = len(conds) - 1
    for row, (cond, label, color) in enumerate(conds):
        y0 = top - row
        vals = summary["byCondition"][cond][key]["values"]
        mean = summary["byCondition"][cond][key]["mean"]
        seen = Counter()
        n = Counter(round(v, 4) for v in vals)
        for v in vals:
            k = round(v, 4)
            off = (seen[k] - (n[k] - 1) / 2) * 0.09
            seen[k] += 1
            ax.plot(v, y0 + off, "o", ms=4.6, mfc=color, mec="white", mew=0.7, zorder=3)
        ax.plot([mean, mean], [y0 - 0.3, y0 + 0.3], color=color, lw=1.4, solid_capstyle="butt", zorder=2)
        ax.annotate(f"media {num(mean, 3)}", (mean, y0 + 0.3), xytext=(3, 1), textcoords="offset points",
                    fontsize=7.5, color=color, va="bottom")
    ax.set_yticks(list(range(top, -1, -1)), [c[1] for c in conds])
    for t, (_, _, color) in zip(ax.get_yticklabels(), conds):
        t.set_color(color)
    ax.tick_params(axis="y", length=0, pad=6)
    ax.spines["left"].set_visible(False)
    ax.set_ylim(-0.55, top + 0.6)
    ax.set_xlim(lo, hi)
    ax.xaxis.set_major_locator(MultipleLocator(step))
    ax.xaxis.set_major_formatter(coma(dec))
    ax.grid(axis="x", color=HAIR, lw=0.5)
    ax.set_axisbelow(True)


def fig_coherencia_mundos(summary):
    fig, ax = plt.subplots(figsize=(TEXTWIDTH_IN, 2.3))
    strip(ax, summary, "contradictionsPerCountryYear", -0.005, 0.25, 0.05, 2)
    ax.set_xlabel("Contradicciones válidas por país-año")
    save(fig, "coherencia-mundos.pdf")


def fig_coherencia_anios(contra):
    by = Counter((r["condition"], int(r["year"])) for r in contra)
    ys = YEARS[1:]
    fig, ax = plt.subplots(figsize=(TEXTWIDTH_IN, 2.2))
    w = 0.26
    for i, (cond, label, color) in enumerate(COND):
        xs = [y + (i - 1) * (w + 0.03) for y in ys]
        vals = [by[(cond, y)] for y in ys]
        ax.bar(xs, vals, width=w, color=color, edgecolor="white", linewidth=0.4, zorder=2)
    ax.set_xticks(ys, [str(y) for y in ys])
    ax.tick_params(axis="x", length=0)
    ax.set_ylabel("Contradicciones")
    ax.yaxis.set_major_locator(MultipleLocator(2))
    ax.grid(axis="y", color=HAIR, lw=0.5)
    ax.set_axisbelow(True)
    ax.set_ylim(0, 8.4)
    # leyenda en línea, arriba a la derecha: las barras de 2016 son demasiado estrechas para rotularlas
    for i, (_, label, color) in enumerate(COND):
        ax.annotate(label, (0.99, 0.97 - i * 0.1), xycoords="axes fraction", ha="right", va="top",
                    fontsize=7.5, color=color)
    save(fig, "coherencia-anios.pdf")


def fig_repeticion(summary, rows):
    fig, (a, b) = plt.subplots(1, 2, figsize=(TEXTWIDTH_IN, 2.3), gridspec_kw={"width_ratios": [1.25, 1], "wspace": 0.32})
    strip(a, summary, "headlineSimilarity", 0.135, 0.182, 0.01, 2)
    a.set_xlabel("Similitud media por mundo")
    for cond, label, color in COND:
        ys = YEARS[1:]
        vals = [st.mean(float(r["headlineSimilarity"]) for r in rows
                        if r["condition"] == cond and int(r["year"]) == y and r["headlineSimilarity"]) for y in ys]
        b.plot(ys, vals, color=color, lw=1.3, marker="o", ms=2.8, mec="white", mew=0.5)
        b.annotate(label, (ys[-1], vals[-1]), xytext=(4, 0), textcoords="offset points", va="center",
                   fontsize=7.5, color=color)
    b.set_ylim(0.12, 0.2)
    b.yaxis.set_major_locator(MultipleLocator(0.02))
    b.yaxis.set_major_formatter(coma(2))
    b.set_xticks([2016, 2020, 2024])
    b.set_xlim(2015.6, 2024.4)
    b.set_xlabel("Año simulado")
    b.grid(axis="y", color=HAIR, lw=0.5)
    b.set_axisbelow(True)
    save(fig, "repeticion.pdf")


def fig_coste(rows):
    fig, (a, b) = plt.subplots(1, 2, figsize=(TEXTWIDTH_IN, 2.3), gridspec_kw={"width_ratios": [1, 1.15], "wspace": 0.45})
    for cond, label, color in COND:
        vals = [st.mean(int(r["genInputTokens"]) for r in rows if r["condition"] == cond and int(r["year"]) == y) for y in YEARS]
        a.plot(YEARS, vals, color=color, lw=1.3, marker="o", ms=2.8, mec="white", mew=0.5)
        # plana y estructurada casi coinciden: una etiqueta encima y otra debajo
        a.annotate(label, (YEARS[-1], vals[-1]), xytext=(0, {"plana": 6, "estructurada+noticias": -11}.get(cond, -11)), textcoords="offset points",
                   ha="right", fontsize=7.5, color=color)
    a.set_ylim(0, 3000)
    a.yaxis.set_major_locator(MultipleLocator(1000))
    a.yaxis.set_major_formatter(coma(0))
    a.set_xticks([2015, 2020, 2024])
    a.set_ylabel("Tokens de entrada")
    a.set_xlabel("Año simulado")
    a.grid(axis="y", color=HAIR, lw=0.5)
    a.set_axisbelow(True)

    # coste por país-año desglosado; 1,5 y 7,5 $/M, 0,86 €/$, en céntimos
    k = 0.86e-6 * 100
    parts = [("Entrada", "genInputTokens", 1.5, 0.35), ("Salida", "genOutputTokens", 7.5, 0.62), ("Razonamiento", "genThoughtsTokens", 7.5, 1.0)]
    for i, (cond, label, color) in enumerate(COND):
        rs = [r for r in rows if r["condition"] == cond]
        left = 0
        for name, col, price, alpha in parts:
            v = sum(int(r[col]) for r in rs) * price * k / len(rs)
            b.barh(2 - i, v, left=left, height=0.52, color=color, alpha=alpha, edgecolor="white", linewidth=0.6)
            if i == 0 and name == "Entrada":
                b.annotate("entrada", (left + v / 2, 2.26), xytext=(0, 7), textcoords="offset points", ha="center",
                           fontsize=7, color=RULE, arrowprops={"arrowstyle": "-", "color": RULE, "lw": 0.5})
            elif i == 0:
                b.annotate(name.lower(), (left + v / 2, 2), ha="center", va="center", fontsize=7,
                           color="white" if name == "Razonamiento" else INK)
            left += v
        b.annotate(num(left, 2), (left, 2 - i), xytext=(3, 0), textcoords="offset points", va="center", fontsize=7.5, color=color)
    b.set_yticks([2, 1, 0], [c[1] for c in COND])
    for t, (_, _, color) in zip(b.get_yticklabels(), COND):
        t.set_color(color)
    b.tick_params(axis="y", length=0)
    b.spines["left"].set_visible(False)
    b.set_xlim(0, 2.75)
    b.set_ylim(-0.45, 2.75)
    b.xaxis.set_major_locator(MultipleLocator(0.5))
    b.xaxis.set_major_formatter(coma(1))
    b.set_xlabel("Céntimos por país-año")
    save(fig, "coste.pdf")


def judge_fit(rows):
    """Recta de la entrada del juez frente a los años de historia (k = año − 2015)."""
    pts = [(int(r["year"]) - 2015, int(r["judgeInputTokens"])) for r in rows if r["judgeInputTokens"]]
    xs, ys = zip(*pts)
    mx, my = st.mean(xs), st.mean(ys)
    slope = sum((x - mx) * (y - my) for x, y in pts) / sum((x - mx) ** 2 for x in xs)
    return my - slope * mx, slope


def fig_juez(rows):
    a0, b1 = judge_fit(rows)
    ys = YEARS[1:]
    vals = [st.mean(int(r["judgeInputTokens"]) for r in rows if int(r["year"]) == y and r["judgeInputTokens"]) for y in ys]
    fig, ax = plt.subplots(figsize=(TEXTWIDTH_IN, 1.9))
    ax.plot([2016, 2024], [a0 + b1, a0 + 9 * b1], color=RULE, lw=0.8, ls=(0, (3, 3)), zorder=1)
    ax.plot(ys, vals, "o", ms=4, mfc=INK, mec="white", mew=0.6, zorder=2)
    ax.annotate(f"unos {num(b1, 0)} tokens más por año de historia", (2019, a0 + 4 * b1), xytext=(10, -12),
                textcoords="offset points", ha="left", fontsize=7.5, color=RULE)
    ax.set_ylim(0, 17000)
    ax.yaxis.set_major_locator(MultipleLocator(4000))
    ax.yaxis.set_major_formatter(coma(0))
    ax.set_xticks(ys)
    ax.set_ylabel("Tokens de entrada")
    ax.set_xlabel("Año juzgado")
    ax.grid(axis="y", color=HAIR, lw=0.5)
    ax.set_axisbelow(True)
    save(fig, "juez-entrada.pdf")
    return a0, b1


# Modelo de escalabilidad (cap. 5, «Escalabilidad analítica»).
PEER_TOKENS = 165  # medido en la entrada del juez: bloque de cada otro país
JUDGE_OUT = 193  # tokens de salida medios por juicio en la evaluación
GEN_CENTS = 2.40  # céntimos por país-año del generador con 4 países


def model(a0, b1):
    fixed = a0 - PEER_TOKENS * 3  # parte fija sin los tres otros países de la evaluación
    E = 0.86e-6

    def cost(P, Y=10, W=10, C=2):
        gen = C * W * P * Y * (GEN_CENTS / 100 + PEER_TOKENS * 1.5 * E * (P - 4))
        judge = C * W * P * sum(E * (3 * (fixed + PEER_TOKENS * (P - 1) + b1 * k) + 15 * JUDGE_OUT) for k in range(1, Y))
        return gen, judge

    return fixed, cost


def fig_escala(cost):
    Ps = list(range(4, 51, 2))
    tot = [sum(cost(p)) for p in Ps]
    lin = [tot[0] * p / 4 for p in Ps]
    fig, ax = plt.subplots(figsize=(TEXTWIDTH_IN * 0.84, 2.2))
    ax.axhline(200, color=BRICK, lw=0.8, ls=(0, (1, 2)))
    ax.annotate("techo de 200 €", (50, 200), xytext=(4, 0), textcoords="offset points", va="center",
                fontsize=7.5, color=BRICK, annotation_clip=False)
    ax.plot(Ps, lin, color=RULE, lw=0.9, ls=(0, (4, 3)))
    ax.annotate("coste por país fijo", (Ps[-1], lin[-1]), xytext=(4, 0), textcoords="offset points",
                va="center", fontsize=7.5, color=RULE, annotation_clip=False)
    ax.plot(Ps, tot, color=INK, lw=1.5)
    ax.annotate("modelo", (Ps[-1], tot[-1]), xytext=(4, 0), textcoords="offset points", va="center",
                fontsize=7.5, color=INK, annotation_clip=False)
    ax.plot([4], [tot[0]], "o", ms=4, mfc=INK, mec="white", mew=0.6)
    # el punto es la evaluación medida: lo dice el pie de figura
    ax.set_xlim(2, 50)
    ax.set_ylim(0, 800)
    ax.xaxis.set_major_locator(MultipleLocator(8))
    ax.yaxis.set_major_locator(MultipleLocator(200))
    ax.yaxis.set_major_formatter(FuncFormatter(lambda x, _p: f"{x:.0f} €"))
    ax.set_xlabel("Países")
    ax.grid(axis="y", color=HAIR, lw=0.5)
    ax.set_axisbelow(True)
    save(fig, "escalabilidad.pdf")


def main():
    rows, contra, summary, eval_rows = load()
    print("figuras en", os.path.relpath(OUT, ROOT))
    fig_coherencia_mundos(summary)
    fig_coherencia_anios(contra)
    fig_repeticion(summary, rows)
    fig_coste(rows)
    a0, b1 = fig_juez(eval_rows)  # el modelo de coste se ajustó con la evaluación del 24 sep
    fixed, cost = model(a0, b1)
    fig_escala(cost)
    g, j = cost(4)
    print(f"   modelo: parte fija {fixed:.0f} tokens, {b1:.0f} por año; evaluación {g:.2f} + {j:.2f} = {g + j:.2f} €")
    for label, args in [("20 países", (20,)), ("4 países, 30 años", (4, 30)), ("50 países", (50,)), ("195 países, 1 mundo, 1 memoria", (195, 10, 1, 1))]:
        g, j = cost(*args)
        print(f"   {label}: {g:.0f} + {j:.0f} = {g + j:.0f} €")


if __name__ == "__main__":
    main()
