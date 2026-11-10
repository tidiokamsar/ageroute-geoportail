/**
 * CONTENUS TEXTUELS DU DOSSIER TECHNIQUE (noyau pur, lot X1 ; contrat CONTRAT-EXPORTS.md, section 4.2) : fiche projet (JSON), lignes du PDF, LISEZMOI,
 * agregats d'analyse SANS geometrie ni liste d'objets. Aucune E/S : le service lit la base et passe les vues.
 */

import type { LignePdf } from "./pdf.noyau";

/** Vue d'un jeu telle que la rend le socle (`vueJeu`) ; seuls les champs utiles sont nommes. */
export interface JeuVu {
  id: string; role: string; concessionnaire: { id: string; nom: string } | null; typeReseau: string | null; typeReseauCode: string | null;
  nomFichier: string; format: string; sha256: string; tailleOctets: number; nbObjets: number; longueurTotaleM: number; longueurTraceFusionneM: number;
  dateDonnees: string | null; origineFichier: string | null; classePrecision: string | null; precisionHorizontaleM: number | null; precisionVerticaleM: number | null;
  methode: string | null; methodeAcquisition: string | null; dateConstat: string | null; natureObjets: string; confidentialite: string; statut: string;
  version: number; remplaceId: string | null; createdAt: Date | string; creePar: { id: string; nomComplet: string } | null;
  decision: { par: { id: string; nomComplet: string } | null; le: Date | string; justification: string | null } | null;
}

/** Jeu de la fiche : tout ce que le decideur lit deja, SANS `resume` ni avertissements du depot (contenu interne du fichier). */
export function jeuDeFiche(j: JeuVu) {
  return {
    id: j.id, role: j.role, statut: j.statut, version: j.version, remplaceId: j.remplaceId,
    concessionnaire: j.concessionnaire ? { id: j.concessionnaire.id, nom: j.concessionnaire.nom } : null, typeReseau: j.typeReseau, typeReseauCode: j.typeReseauCode,
    nomFichier: j.nomFichier, format: j.format, sha256: j.sha256, tailleOctets: j.tailleOctets, confidentialite: j.confidentialite, natureObjets: j.natureObjets,
    nbObjets: j.nbObjets, longueurTotaleM: j.longueurTotaleM, longueurTraceFusionneM: j.longueurTraceFusionneM,
    classePrecision: j.classePrecision, precisionHorizontaleM: j.precisionHorizontaleM, precisionVerticaleM: j.precisionVerticaleM,
    methode: j.methode, methodeAcquisition: j.methodeAcquisition, dateDonnees: j.dateDonnees, dateConstat: j.dateConstat, origineFichier: j.origineFichier,
    depot: { par: j.creePar, le: j.createdAt },
    decision: j.decision ? { par: j.decision.par, le: j.decision.le, justification: j.decision.justification } : null,
  };
}

/** Revue du lot X1 (M3, mesure de la memoire) : axes listes au plus, et longueur de leur nom, dans les agregats de l'archive. */
export const AXES_AGREGATS_MAX = 1_000;
export const NOM_AXE_MAX = 500;

const CLES_ANALYSE = ["projet", "statut", "versionAlgorithme", "regle", "inclureNonAutorises", "parametres", "libelles", "natures", "axes", "jeux", "reseaux", "hypotheses", "limites"] as const;

/**
 * Agregats de l'analyse 2D : la reponse du socle SANS geometrie (ni `croisements` ni `zones`) et SANS liste d'objets par axe. Toute cle inconnue est
 * ignoree (liste blanche) : une evolution de l'analyse n'ajoute rien a l'export sans decision.
 */
export function agregatsAnalyse(reponse: Record<string, unknown>): Record<string, unknown> {
  const sortie: Record<string, unknown> = {};
  for (const k of CLES_ANALYSE) if (k in reponse) sortie[k] = reponse[k];
  const conflits = (reponse.conflits ?? {}) as Record<string, unknown>;
  const parAxe = Array.isArray(conflits.parAxe) ? (conflits.parAxe as Record<string, unknown>[]) : [];
  sortie.conflits = {
    total: conflits.total ?? null,
    parConcessionnaire: conflits.parConcessionnaire ?? [],
    parAxe: parAxe.slice(0, AXES_AGREGATS_MAX).map((a) => {
      const { objets: _o, objetsTronques: _t, ...reste } = a;
      void _o; void _t;
      const axe = typeof reste.axe === "string" && reste.axe.length > NOM_AXE_MAX ? reste.axe.slice(0, NOM_AXE_MAX) : reste.axe;
      return { ...reste, axe, nbObjetsListes: Array.isArray(a.objets) ? a.objets.length : 0 };
    }),
    parAxeTronque: parAxe.length > AXES_AGREGATS_MAX,
    nbAxes: parAxe.length,
    croisements: { nbTotal: (conflits.croisements as { nbTotal?: unknown } | undefined)?.nbTotal ?? null, geometries: "non exportees" },
  };
  return sortie;
}

const m = (x: unknown): string => (typeof x === "number" && Number.isFinite(x) ? `${Math.round(x * 100) / 100} m` : "inconnue");

export interface EntreePdf {
  projet: { code: string; nom: string; commune: string | null; prefecture: string | null; region: string | null; categorieCode: string | null; description: string | null };
  territoire: { nom: string; niveau: string; ancetres: { nom: string; niveau: string }[] } | null;
  parametres: { largeurEmpriseM: number; largeurChausseeM: number; statut: string };
  jeux: ReturnType<typeof jeuDeFiche>[];
  analyse: { disponible: true; agregats: Record<string, unknown> } | { disponible: false; code: string; message: string };
  conflitsParStatut: Record<string, number>;
  completude: { fonctions: { code: string; libelle: string; etat: string }[]; piecesManquantes: { nature: string }[] } | null;
  geojson: { inclus: { jeuId: string; derogation: boolean }[]; ecartes: { jeuId: string; raison: string }[]; demande: boolean };
  exportId: string; genereLe: Date; acteur: string;
}

export const AVERTISSEMENT = "Aide a la decision : aucun element de ce dossier ne vaut ordre, decision ni deplacement de reseau. L'absence de conflit detecte ne prouve pas l'absence de reseau.";

/** Lignes du PDF de la fiche projet (texte simple). */
export function lignesFichePdf(e: EntreePdf): LignePdf[] {
  const L: LignePdf[] = [];
  const titre = (t: string) => { L.push({ texte: "" }); L.push({ texte: t, taille: 12, gras: true }); };
  L.push({ texte: `Dossier technique du projet ${e.projet.code}`, taille: 16, gras: true });
  L.push({ texte: e.projet.nom, taille: 12 });
  L.push({ texte: `Export ${e.exportId}, genere le ${e.genereLe.toISOString().replace("T", " ").slice(0, 19)} UTC par ${e.acteur}.`, taille: 9 });
  L.push({ texte: AVERTISSEMENT, taille: 9 });

  titre("Projet");
  if (e.territoire) {
    const chaine = [...e.territoire.ancetres, { nom: e.territoire.nom, niveau: e.territoire.niveau }].map((t) => `${t.nom} (${t.niveau})`).join(" > ");
    L.push({ texte: `Territoire : ${chaine}` });
  } else L.push({ texte: "Territoire : non renseigne" });
  L.push({ texte: `Commune : ${e.projet.commune ?? "non renseignee"} ; prefecture : ${e.projet.prefecture ?? "non renseignee"} ; region : ${e.projet.region ?? "non renseignee"}` });
  L.push({ texte: `Categorie : ${e.projet.categorieCode ?? "non renseignee"}` });
  L.push({ texte: `Largeurs : emprise ${e.parametres.largeurEmpriseM} m, chaussee ${e.parametres.largeurChausseeM} m (parametres ${e.parametres.statut})` });
  if (e.projet.description) L.push({ texte: `Description : ${e.projet.description}` });

  titre(`Jeux de donnees (${e.jeux.length})`);
  if (e.jeux.length === 0) L.push({ texte: "Aucun jeu." });
  for (const j of e.jeux) {
    L.push({ texte: `[${j.statut}] ${j.role} v${j.version} : ${j.nomFichier} (${j.format})`, gras: true, taille: 10 });
    L.push({ texte: `   ${j.concessionnaire ? `${j.concessionnaire.nom}, ` : ""}${j.typeReseau ?? "sans type"} ; confidentialite ${j.confidentialite} ; ${j.nbObjets} objet(s) ; longueur ${m(j.longueurTotaleM)} ; classe ${j.classePrecision ?? "inconnue"} ; empreinte ${j.sha256.slice(0, 16)}...`, taille: 9 });
  }

  titre("Analyse 2D indicative (jeux AUTORISE seulement)");
  if (!e.analyse.disponible) L.push({ texte: `Indisponible : ${e.analyse.code} (${e.analyse.message})` });
  else {
    const a = e.analyse.agregats as { axes?: { nb?: number; longueurM?: number }; conflits?: { total?: Record<string, unknown> }; reseaux?: { parType?: { typeReseau: string; longueurTraceFusionneM: number; nbObjets: number }[] } };
    L.push({ texte: `Axes : ${a.axes?.nb ?? 0}, longueur ${m(a.axes?.longueurM)}` });
    for (const t of a.reseaux?.parType ?? []) L.push({ texte: `Reseau ${t.typeReseau} : trace fusionne ${m(t.longueurTraceFusionneM)}, ${t.nbObjets} objet(s)` });
    const tot = a.conflits?.total ?? {};
    L.push({ texte: `Longueur de reseau dans la chaussee : ${m(tot.chausseeM)} ; dans l'emprise : ${m(tot.empriseM)} ; croisements : ${typeof tot.croisements === "number" ? tot.croisements : 0}` });
  }

  titre("Dossiers de conflit (par statut)");
  const statuts = Object.entries(e.conflitsParStatut).filter(([, n]) => n > 0);
  if (statuts.length === 0) L.push({ texte: "Aucun dossier." });
  for (const [s, n] of statuts) L.push({ texte: `${s} : ${n}` });

  titre("Ce que les documents permettent");
  if (!e.completude) L.push({ texte: "Non calcule." });
  else {
    for (const f of e.completude.fonctions) L.push({ texte: `${f.libelle} : ${f.etat}` });
    const parNature: Record<string, number> = {};
    for (const p of e.completude.piecesManquantes) parNature[p.nature] = (parNature[p.nature] ?? 0) + 1;
    L.push({ texte: `Pieces manquantes : ${Object.entries(parNature).map(([k, v]) => `${k} ${v}`).join(", ") || "aucune"}` });
  }

  titre("Geometries exportees (GeoJSON)");
  if (!e.geojson.demande) L.push({ texte: "Non demandees pour cet export." });
  L.push({ texte: `Jeux exportes : ${e.geojson.inclus.length}${e.geojson.inclus.some((i) => i.derogation) ? ` (dont ${e.geojson.inclus.filter((i) => i.derogation).length} par derogation ADMIN a usage unique)` : ""}` });
  const raisons: Record<string, number> = {};
  for (const x of e.geojson.ecartes) raisons[x.raison] = (raisons[x.raison] ?? 0) + 1;
  L.push({ texte: `Jeux ecartes : ${e.geojson.ecartes.length}${Object.keys(raisons).length ? ` (${Object.entries(raisons).map(([k, v]) => `${k} ${v}`).join(", ")})` : ""}` });
  L.push({ texte: "" });
  L.push({ texte: "Les empreintes SHA-256 de chaque fichier de l'archive sont dans manifeste.json et manifeste.sha256.", taille: 9 });
  return L;
}

export function lisezMoi(e: { code: string; exportId: string; genereLe: Date }): string {
  return [
    `DOSSIER TECHNIQUE DU PROJET ${e.code}`,
    `Export ${e.exportId}, genere le ${e.genereLe.toISOString()} par la Console BDRI (module Projets de voirie et reseaux).`,
    "",
    AVERTISSEMENT,
    "",
    "Contenu :",
    "  fiche-projet.json, fiche-projet.pdf   le projet et ses jeux de donnees (hors jeux retires)",
    "  analyse/agregats.json                 analyse 2D indicative sur les jeux AUTORISE, sans geometrie",
    "  conflits/dossiers.csv                 un dossier de conflit par ligne (separateur ;, UTF-8)",
    "  documents/journal.json, journal.csv   documents du dossier, versions et historique",
    "  documents/completude.json             ce que les documents disponibles permettent",
    "  geojson/                              geometries (WGS 84) des seuls jeux AUTORISE dont la confidentialite le permet",
    "  manifeste.json                        liste des fichiers, tailles et empreintes SHA-256 ; jeux exportes et ecartes",
    "  manifeste.sha256                      empreintes au format sha256sum",
    "",
    "Verifier l'integrite (depuis ce dossier) :  sha256sum -c manifeste.sha256",
    "Les cellules du CSV qui commencent par = + - @ sont precedees d'une apostrophe (protection contre l'injection de formules).",
    "",
  ].join("\r\n");
}
