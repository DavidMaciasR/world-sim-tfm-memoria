// Selección de arquitectura por id, para que un runner pueda recibirla como
// argumento sin conocer las clases. La inyección sigue siendo la vía normal en
// los tests; esto solo cubre el caso "elige A1 desde la línea de comandos".

import { AgentArchitecture, ArchitectureId } from "../types";
import { A0NaiveArchitecture } from "./a0-naive";
import { A1GroundedArchitecture } from "./a1-grounded";
import { A1GGroundingOnlyArchitecture } from "./a1g-grounding-only";
import { A1NStructuredNewsArchitecture } from "./a1n-structured-news";

export function architectureFor(id: ArchitectureId): AgentArchitecture {
  switch (id) {
    case "A0":
      return new A0NaiveArchitecture();
    case "A1G":
      return new A1GGroundingOnlyArchitecture();
    case "A1":
      return new A1GroundedArchitecture();
    case "A1N":
      return new A1NStructuredNewsArchitecture();
    default:
      // A2 (negociación) y A3 (árbitro) salieron del alcance. Fallar aquí
      // evita registros etiquetados con una arquitectura que nunca se ejecutó.
      throw new Error(`Arquitectura "${id}" no implementada`);
  }
}

export { A0NaiveArchitecture, A1GroundedArchitecture, A1GGroundingOnlyArchitecture, A1NStructuredNewsArchitecture };
