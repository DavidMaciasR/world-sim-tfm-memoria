#!/usr/bin/env python3
"""Figuras del capítulo 4 (diseño del estudio), en PDF para LaTeX.

    cd apps/server && npx ts-node src/tfm/experiment/memory-example.ts
    /usr/bin/python3 docs/tfm/tools/figuras-cap4.py   # el de pyenv no tiene matplotlib

1. memorias.pdf: lo que ve el agente con cada memoria para el mismo país-año
   (texto real del prompt, extraído por memory-example.ts).
2. flujo.pdf: el flujo del experimento, de la memoria a las tres medidas.

Mismo estilo que figuras-cap5.py (Latin Modern, tinta para la plana, ladrillo
para la estructurada, sin título dentro de la figura).
"""

import json
import os
import textwrap

import matplotlib

matplotlib.use("pdf")
import matplotlib.pyplot as plt
from matplotlib import font_manager
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
EXAMPLE = os.path.join(ROOT, "docs", "tfm", "results", "memory-v1", "figures", "memoria-ejemplo.json")
OUT = os.path.join(ROOT, "docs", "tfm", "memoria", "img", "desarrollo")

INK = "#1F2A36"
BRICK = "#B4532A"
RULE = "#8C9096"
PAPER = "#F7F7F5"
HILITE = "#F3DED3"
TEXTWIDTH_IN = 350 / 72.27

LM_DIR = os.path.expanduser("~/Library/TinyTeX/texmf-dist/fonts/opentype/public/lm")
for face in ("lmroman10-regular", "lmroman10-bold", "lmroman10-italic", "lmmono10-regular"):
    p = os.path.join(LM_DIR, f"{face}.otf")
    if os.path.exists(p):
        font_manager.fontManager.addfont(p)

plt.rcParams.update({
    "font.family": "serif",
    "font.serif": ["Latin Modern Roman", "cmr10"],
    "font.monospace": ["Latin Modern Mono", "DejaVu Sans Mono"],
    "font.size": 8.5,
    "savefig.bbox": "tight",
    "savefig.pad_inches": 0.02,
})


def save(fig, name):
    os.makedirs(OUT, exist_ok=True)
    fig.savefig(os.path.join(OUT, name))
    plt.close(fig)
    print("  ", name)


# --- 1. Lo que ve cada memoria ---------------------------------------------------

WRAP = 41
MARK = "\x01"  # líneas que se resaltan (la noticia que la estructurada no ve)


def wrap(line, indent="  "):
    first, *rest = textwrap.wrap(line.strip(), WRAP) or [""]
    return [first] + [indent + r for r in textwrap.wrap(" ".join(rest), WRAP - len(indent))]


def flat_lines(ex):
    out = ["STRATEGIC HISTORY:"]
    for line in ex["flat"]["history"].splitlines()[1:]:
        t = line.strip()
        if not t:
            continue
        cut = t if len(t) <= 96 else t[:94].rstrip() + "…"
        out += [("  " + w) for w in wrap(cut, "  ")]
    out += ["", "SIMULATED NEWS HISTORY (año anterior):"]
    for line in ex["flat"]["news"].splitlines()[1:]:
        t = line.strip()
        if not t.startswith("["):
            continue
        head = t.split(" | ")[0]  # titular sin el cuerpo de la noticia
        mark = MARK if "Shanghai" in head else ""
        out += [(mark + "  " + w) for w in wrap(head, "    ")]
    return out


def structured_lines(ex):
    out = []
    for line in ex["structured"].splitlines()[1:]:
        t = line.rstrip()
        if not t.strip():
            out.append("")
            continue
        lead = "  " if t.startswith("  ") else ""
        cut = t.strip() if len(t.strip()) <= 150 else t.strip()[:148].rstrip() + "…"
        out += [(lead + w) for w in wrap(cut, "  ")]
    return out


def column(ax, x0, title, color, lines, highlight=None):
    ax.text(x0, 1.0, title, color=color, fontsize=9.5, fontweight="bold", va="bottom", transform=ax.transAxes)
    ax.add_patch(FancyBboxPatch((x0, 0.0), 0.485, 0.975, boxstyle="round,pad=0,rounding_size=0.01",
                                transform=ax.transAxes, facecolor=PAPER, edgecolor=color, linewidth=0.8))
    step = 0.955 / max(len(lines), 1)
    y = 0.96
    for line in lines:
        hi = line.startswith(MARK)
        line = line.lstrip(MARK)
        if hi:
            ax.add_patch(FancyBboxPatch((x0 + 0.004, y - step * 0.82), 0.477, step * 0.98, boxstyle="square,pad=0",
                                        transform=ax.transAxes, facecolor=HILITE, edgecolor="none"))
        ax.text(x0 + 0.012, y, line, family="monospace", fontsize=5.6, color=INK, va="top", transform=ax.transAxes)
        y -= step


def fig_memorias():
    ex = json.load(open(EXAMPLE))
    fl, st = flat_lines(ex), structured_lines(ex)
    # el mismo número de filas en las dos columnas, para que la letra mida igual
    n = max(len(fl), len(st))
    fl += [""] * (n - len(fl))
    st += [""] * (n - len(st))
    fig, ax = plt.subplots(figsize=(TEXTWIDTH_IN, 0.118 * n + 0.35))
    ax.axis("off")
    column(ax, 0.0, "Memoria plana", INK, fl)
    column(ax, 0.515, "Memoria estructurada", BRICK, st)
    save(fig, "memorias.pdf")


# --- 2. Flujo del experimento ----------------------------------------------------

def box(ax, x, y, w, h, lines, edge=INK, fill="white"):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0,rounding_size=0.08",
                                facecolor=fill, edgecolor=edge, linewidth=0.8))
    gap = 0.21
    top = y + h / 2 + gap * (len(lines) - 1) / 2
    for i, t in enumerate(lines):
        ax.text(x + w / 2, top - i * gap, t, ha="center", va="center",
                fontsize=6.2 if i == 0 else 6.1, color=edge if i == 0 else INK,
                fontweight="bold" if i == 0 else "normal")


def arrow(ax, a, b, color=RULE, rad=0.0, ls="-"):
    ax.add_patch(FancyArrowPatch(a, b, arrowstyle="-|>", mutation_scale=7, color=color, linewidth=0.8,
                                 connectionstyle=f"arc3,rad={rad}", linestyle=ls, shrinkA=1, shrinkB=1))


def fig_flujo():
    fig, ax = plt.subplots(figsize=(TEXTWIDTH_IN, 2.5))
    ax.set_xlim(0, 10)
    ax.set_ylim(0.6, 4.4)
    ax.axis("off")
    h = 0.85
    box(ax, 0.0, 2.75, 2.65, h, ["Memoria plana", "historial y noticias", "del año anterior"], edge=INK)
    box(ax, 0.0, 1.55, 2.65, h, ["Memoria estructurada", "perfil y trayectoria", "recortada, sin noticias"], edge=BRICK)
    box(ax, 3.0, 2.15, 1.8, h, ["Generador", "gemini-3.6-flash", "un país-año"], edge=INK, fill=PAPER)
    box(ax, 5.15, 2.15, 2.05, h, ["Registro", "decisión, previsión", "y 12 noticias"], edge=INK)
    box(ax, 7.6, 3.3, 2.4, 1.0, ["Coherencia", "juez claude-sonnet-5", "citas comprobadas", "por código"], edge=INK, fill=PAPER)
    box(ax, 7.6, 2.15, 2.4, h, ["Repetición", "similitud de titulares", "con el año anterior"], edge=INK)
    box(ax, 7.6, 1.0, 2.4, h, ["Coste", "tokens y euros", "por llamada"], edge=INK)
    arrow(ax, (2.65, 3.15), (3.0, 2.75))
    arrow(ax, (2.65, 1.95), (3.0, 2.4))
    arrow(ax, (4.8, 2.57), (5.15, 2.57))
    arrow(ax, (7.2, 2.8), (7.6, 3.75))
    arrow(ax, (7.2, 2.57), (7.6, 2.57))
    arrow(ax, (3.9, 2.15), (7.6, 1.42), rad=0.15)
    arrow(ax, (6.2, 2.15), (1.3, 1.55), rad=-0.35, ls=(0, (3, 2)))
    save(fig, "flujo.pdf")


if __name__ == "__main__":
    print("figuras en", os.path.relpath(OUT, ROOT))
    fig_memorias()
    fig_flujo()
