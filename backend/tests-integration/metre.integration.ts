// Banc d'integration PostGIS : voir tests-integration/README.md. Lancer : npx tsx tests-integration/metre.integration.ts
import "./lib/garde";
// Metre en UTM 28N/29N (paragraphe 7.1, A5) contre PostGIS reel. LECTURE SEULE : aucune ecriture.
//
// L'ORACLE : chaque geometrie de reference est DEFINIE en UTM (surface et longueur exactes) ; le noyau
// TypeScript `geo/utm.noyau.ts` ne partage aucun code avec PostGIS (`metre_utm`). Les trois doivent
// se rejoindre : PostGIS = definition au millionieme (meme fuseau), PostGIS = TypeScript au millionieme.
// Le metre d'un defaut par son contour est eprouve par le banc `metre-defaut`.
import { PrismaClient } from "@prisma/client";
import { mesurerGeometrie } from "../src/geo/metre.service";
import { metreUtm, type GeometrieMetrable } from "../src/geo/utm.noyau";
import { GEOMETRIES_REFERENCE } from "../src/geo/geometries-reference";
import { verifier, conclure } from "./lib/verdict";

const prisma = new PrismaClient();
const relatif = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

async function main() {
  for (const ref of GEOMETRIES_REFERENCE) {
    const r = await mesurerGeometrie(prisma, ref.geometrie);
    if (!r.ok) { verifier(`${ref.code} : PostGIS mesure la geometrie`, false, r); continue; }
    const ts = metreUtm(ref.geometrie as unknown as GeometrieMetrable);
    const m = r.mesure;
    const memeFuseau = m.epsg === ref.epsgDefinition;
    const valeur = ref.geometrie.type === "Polygon" ? m.surfaceM2 : m.longueurM;
    const definition = ref.geometrie.type === "Polygon" ? ref.surfaceDefinitionM2 : ref.longueurDefinitionM;
    verifier(`${ref.code} : fuseau ${m.epsg}, le meme que le noyau TypeScript`, !("refus" in ts) && ts.epsg === m.epsg, { postgis: m.epsg, ts });
    verifier(`${ref.code} : PostGIS = valeur de definition ${memeFuseau ? "au millionieme" : "a 1 % (fuseau voisin de celui de definition)"}`,
      relatif(valeur, definition) < (memeFuseau ? 1e-6 : 0.01), { valeur, definition });
    if (!("refus" in ts)) {
      const valeurTs = ref.geometrie.type === "Polygon" ? ts.surfaceM2 : ts.longueurM;
      verifier(`${ref.code} : PostGIS = noyau TypeScript au millionieme`, relatif(valeur, valeurTs) < 1e-6, { valeur, valeurTs });
    }
  }

  const papillon = await mesurerGeometrie(prisma, { type: "Polygon", coordinates: [[[-13.7, 9.5], [-13.69, 9.51], [-13.69, 9.5], [-13.7, 9.51], [-13.7, 9.5]]] });
  verifier("un polygone en papillon est refuse avec la raison de PostGIS, jamais repare", !papillon.ok && papillon.code === "GEOMETRIE_INVALIDE" && /Self-intersection/.test(papillon.raison), papillon);
  const illisible = await mesurerGeometrie(prisma, { type: "Polygon", coordinates: [["x"]] });
  verifier("des coordonnees illisibles sont refusees comme telles", !illisible.ok && illisible.code === "GEOMETRIE_ILLISIBLE", illisible);

  conclure();
}

main().catch((e) => { console.error(e); process.exitCode = 2; }).finally(() => prisma.$disconnect());
