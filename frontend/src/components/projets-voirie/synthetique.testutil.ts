import type { Feature, LineString } from "geojson";
import type { Analyse, CoucheCarte, JeuProjet, ProjetFiche, ProjetResume } from "../../lib/projetsVoirieApi";

/**
 * Fixtures 100 % SYNTHETIQUES du module « Projets de voirie ». Aucune donnee d'un concessionnaire, aucun plan reel : des noms inventes,
 * des coordonnees autour d'un point arbitraire. Utilise par les tests seulement.
 */

export const O = -10.1;
export const S = 9.18;

export function jeu(over: Partial<JeuProjet> = {}): JeuProjet {
  return {
    id: "jeu-1", projetId: "p1", role: "RESEAU_TIERS",
    concessionnaire: { id: "c1", nom: "Operateur synthetique A", typeReseau: "TELECOM" }, typeReseau: "TELECOM",
    nomFichier: "reseau-synthetique.kml", format: "KML", sha256: "a".repeat(64), nbObjets: 4, longueurTotaleM: 2600, longueurTraceFusionneM: 1800,
    dateDonnees: "2026-10-24", origineFichier: null, classePrecision: "INCONNUE", precisionHorizontaleM: null, precisionVerticaleM: null, methode: null, dateConstat: null,
    natureObjet: "INCONNUE", confidentialite: "CONFIDENTIEL_CONCESSIONNAIRE", statut: "AUTORISE", nonAutorise: false, justification: null, version: 1,
    avertissements: [], createdAt: "2026-10-28T09:00:00Z", ...over,
  };
}

export const JEU_AXES = jeu({
  id: "jeu-axes", role: "AXES_TRAVAUX", concessionnaire: null, typeReseau: null, nomFichier: "axes-synthetiques.geojson", format: "GEOJSON", nbObjets: 3,
  longueurTotaleM: 1500, longueurTraceFusionneM: 1500, classePrecision: "B", natureObjet: "AXE", confidentialite: "RESTREINT_PROJET",
});
export const JEU_TEL = jeu({ id: "jeu-tel", version: 2 });
export const JEU_EAU = jeu({
  id: "jeu-eau", concessionnaire: { id: "c2", nom: "Societe des eaux synthetique", typeReseau: "EAU_POTABLE" }, typeReseau: "EAU_POTABLE",
  nomFichier: "eau-synthetique.geojson", format: "GEOJSON", classePrecision: "B", natureObjet: "ACTIF_PHYSIQUE", nbObjets: 2,
});
export const JEU_GAZ_CONTROLE = jeu({
  id: "jeu-gaz", concessionnaire: { id: "c4", nom: "Hydrocarbures synthetique", typeReseau: "GAZ_HYDROCARBURES" }, typeReseau: "GAZ_HYDROCARBURES",
  nomFichier: "gaz-synthetique.geojson", format: "GEOJSON", statut: "CONTROLE", nonAutorise: true,
});

export function projetResume(over: Partial<ProjetResume> = {}): ProjetResume {
  return {
    id: "p1", code: "VOIRIE-SYNTH-2026", nom: "Voirie synthetique", commune: "Commune test", prefecture: "Prefecture test",
    largeurEmpriseM: 15, largeurChausseeM: 7, statutParametres: "THEORIQUE", nbJeux: 3, createdAt: "2026-10-28T08:00:00Z", ...over,
  };
}

export function projetFiche(over: Partial<ProjetFiche> = {}): ProjetFiche {
  return {
    ...projetResume(), description: "Projet fictif.", jeux: [JEU_AXES, JEU_TEL, JEU_EAU, JEU_GAZ_CONTROLE],
    bbox: [O - 0.003, S - 0.003, O + 0.003, S + 0.003], ...over,
  };
}

const verif = { statut: "A_VERIFIER", versionRegle: "1.0" };

export function analyse(over: Partial<Analyse> = {}): Analyse {
  return {
    projet: { id: "p1", code: "VOIRIE-SYNTH-2026", nom: "Voirie synthetique" },
    parametres: { largeurEmpriseM: 15, largeurChausseeM: 7, statut: "THEORIQUE", projection: "EPSG:32629" },
    axes: { nb: 3, longueurM: 1500 },
    reseaux: {
      parType: [
        { typeReseau: "TELECOM", longueurTraceFusionneM: 1800, nbObjets: 4 },
        { typeReseau: "EAU_POTABLE", longueurTraceFusionneM: 600, nbObjets: 2 },
      ],
      parConcessionnaire: [
        { concessionnaireId: "c1", nom: "Operateur synthetique A", typeReseau: "TELECOM", longueurTraceFusionneM: 1800, longueurSommeM: 2600, nbObjets: 4, jeuxIds: ["jeu-tel"] },
        { concessionnaireId: "c2", nom: "Societe des eaux synthetique", typeReseau: "EAU_POTABLE", longueurTraceFusionneM: 600, longueurSommeM: 600, nbObjets: 2, jeuxIds: ["jeu-eau"] },
      ],
    },
    conflits: {
      total: { chausseeM: 600, empriseM: 1100, croisements: 6, axesTouches: 2, objetsTouches: 5, empriseHorsChausseeM: null, horsEmpriseM: null },
      parAxe: [
        { axe: "Axe B", longueurM: 500, chausseeM: 0, empriseM: 500, croisements: 2, concessionnaires: ["Societe des eaux synthetique"], objets: [{ jeuId: "jeu-eau", nom: "Conduite DN200", chausseeM: 0, empriseM: 500 }], verification: verif },
        { axe: "Axe A", longueurM: 600, chausseeM: 600, empriseM: 1200, croisements: 4, concessionnaires: ["Operateur synthetique A"], objets: [{ jeuId: "jeu-tel", nom: "Fibre FO-01", chausseeM: 600, empriseM: 600 }, { jeuId: "jeu-tel", nom: "Fibre FO-02", chausseeM: 0, empriseM: 600 }], verification: verif },
        { axe: "Axe C", longueurM: 200, chausseeM: 0, empriseM: 0, croisements: 0, concessionnaires: [], objets: [], verification: verif },
      ],
      parConcessionnaire: [
        { concessionnaireId: "c1", nom: "Operateur synthetique A", chausseeM: 600, empriseM: 1200, croisements: 4, verification: verif, qualification: null, classePrecision: null },
        { concessionnaireId: "c2", nom: "Societe des eaux synthetique", chausseeM: 0, empriseM: 500, croisements: 2, verification: verif, qualification: null, classePrecision: null },
      ],
      croisements: { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [O, S] }, properties: {} }] },
      zones: { chaussee: { type: "MultiLineString", coordinates: [[[O, S], [O + 0.001, S]]] }, emprise: null, hors: null },
    },
    hypotheses: ["Largeurs appliquees de part et d'autre de chaque axe."],
    limites: ["Precision de position inconnue.", "Profondeur inconnue."],
    versionAlgorithme: "2026.10-test",
    ...over,
  };
}

export function ligne(nom: string, x0: number, y0: number, x1: number, y1: number, attributs: Record<string, unknown> = {}): Feature<LineString> {
  return {
    type: "Feature", id: nom,
    geometry: { type: "LineString", coordinates: [[O + x0 * 1e-5, S + y0 * 1e-5], [O + x1 * 1e-5, S + y1 * 1e-5]] },
    properties: { nom, longueurM: 100, typeGeom: "LIGNE", attributs: { Name: nom, ...attributs } },
  };
}

export function couche(over: Partial<CoucheCarte> = {}): CoucheCarte {
  return {
    jeuId: "jeu-tel", role: "RESEAU_TIERS", concessionnaire: { id: "c1", nom: "Operateur synthetique A", typeReseau: "TELECOM" }, typeReseau: "TELECOM",
    features: [ligne("Fibre FO-01", -100, 2, 100, 2), ligne("Fibre FO-02", -100, 6, 100, 6)], tronque: false, nonAutorise: false, ...over,
  };
}

/** Faux resultat d'une requete React Query : suffit aux panneaux qui ne lisent que ces champs. */
export function requeteOk<T>(data: T) {
  return { data, isPending: false, isError: false, error: null, isFetching: false, refetch: () => Promise.resolve() } as never;
}
export function requeteErreur(error: unknown) {
  return { data: undefined, isPending: false, isError: true, error, isFetching: false, refetch: () => Promise.resolve() } as never;
}
export function requeteChargement() {
  return { data: undefined, isPending: true, isError: false, error: null, isFetching: true, refetch: () => Promise.resolve() } as never;
}
