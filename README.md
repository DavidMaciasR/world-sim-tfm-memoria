# world-sim-tfm-memoria

Datos y código del experimento de un Trabajo Fin de Máster (Máster Universitario en Ingeniería Informática, Universidad de Sevilla, 2025/2026): **la memoria de un agente-país y la coherencia de una simulación geopolítica con modelos de lenguaje**.

El estudio compara dos formas de darle a cada agente su propio pasado, una **memoria plana** y una **memoria estructurada**, sobre el simulador [world-sim](https://worldsim.live). Mide la coherencia temporal con un juez LLM cuyas citas comprueba un código, además de la repetición y el coste.

| | |
|---|---|
| Países | Estados Unidos, China, India, Pakistán |
| Años simulados | 2015–2024 |
| Mundos | 10 por memoria (800 país-año en la evaluación) |
| Generador | `gemini-3.6-flash` |
| Juez | `claude-sonnet-5` |
| Diseño congelado | 24 de septiembre de 2026, antes de generar la evaluación (`datos/resultados/freeze.json`) |

## Contenido

```
datos/
  resultados/            Tablas y resúmenes agregados (los que usa la memoria)
    eval/                  evaluación: summary.json, country-years.csv, contradictions.csv
    dev/                   desarrollo (Alemania, Francia, Rusia; un mundo por memoria)
    judge-validation/      pares de continuidad del juez (6 de 6)
    repetition-validation.json   comprobación de la medida de repetición (6 de 6)
    figures/               ejemplo real de lo que ve el agente con cada memoria
    freeze.json            reglas, modelos y huellas del diseño congelado
  tiradas/               Registros completos de cada mundo
    memory-v1-<etapa>-<memoria>-r<N>/
      records.jsonl          lo generado: un registro por país-año
      generator-usage.jsonl  tokens, latencia y errores de cada llamada al generador
      coherence-judge/       juicios del juez (judgments.jsonl) y su manifiesto
      manifest.json          condiciones y huella de código de la tirada
  indicadores/           Indicadores de Our World in Data usados por el generador
codigo/                  Copia de lectura del código del experimento
figuras/                 Scripts que regeneran las tablas y figuras de la memoria
```

**Nombres de las condiciones.** En los ficheros, `a1g` es la memoria plana y `a1` la estructurada (nombres internos del proyecto).

**Etapas.** `pilot` es el piloto de coste (2 países, 5 años); `dev`, el desarrollo con el que se fijaron las medidas; `eval`, la evaluación que se reporta.

## Sobre el código

`codigo/` es una **copia de lectura**: la carpeta del experimento (`src/tfm/experiment/`) y los ficheros del simulador de los que depende directamente (el agente-país, el contexto del mundo, la base de datos y la telemetría). Sirve para auditar qué recibe cada memoria, cómo juzga el juez y cómo se calculan las métricas. No se ejecuta tal cual: depende del resto de world-sim, que no es público. Los identificadores de commit de `freeze.json` y de los manifiestos remiten a ese repositorio privado.

Ficheros clave:
- Las dos memorias: `codigo/src/tfm/experiment/architectures/a1g-grounding-only.ts` (plana) y `a1-grounded.ts` (estructurada), con `codigo/src/tfm/structured-memory.ts`.
- El juez y el control mecánico de las citas: `codigo/src/tfm/experiment/coherence-judge.ts`.
- Las métricas: `codigo/src/tfm/experiment/memory-metrics.ts`.
- La agregación de resultados: `codigo/src/tfm/experiment/aggregate.ts`.

Las claves de API se leen de variables de entorno; no hay ninguna en el código.

## Figuras

`figuras/figuras-cap4.py` y `figuras/figuras-cap5.py` regeneran las figuras de la memoria a partir de `datos/`. Esperan la estructura de rutas del repositorio original (`docs/tfm/results/...`); para usarlas aquí, ajusta las constantes de ruta del principio de cada script.

## Licencias

- **Código** (`codigo/`, `figuras/`): MIT, ver [`LICENSE`](LICENSE).
- **Datos** (`datos/`): [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), ver [`LICENSE-DATOS.md`](LICENSE-DATOS.md).
- **Indicadores** (`datos/indicadores/`): proceden de [Our World in Data](https://ourworldindata.org), publicados con licencia CC BY 4.0; se citan como «Our World in Data».

Los textos generados (decisiones, noticias, juicios) son salidas de modelos de lenguaje dentro de una simulación ficticia: no describen hechos reales.
