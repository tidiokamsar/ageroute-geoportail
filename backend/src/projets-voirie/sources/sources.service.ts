/**
 * VUE « SOURCES D UN RESEAU » (lot S1 ; contrat CONTRAT-SOURCES.md, sections 1 et 5).
 *
 * Les groupes d un projet sont : chaque reseau de concessionnaire (concessionnaire, type de reseau) de ses jeux AUTORISE de role RESEAU_TIERS,
 * et le plan d axes (role AXES_TRAVAUX). Un groupe d une seule source est dans l etat NORMAL `SOURCE_UNIQUE_COMPARAISON_INDISPONIBLE` : rien n est
 * calcule, aucun avertissement d erreur. Un groupe de deux sources ou plus est `COMPARABLE`.
 *
 * VERSION CANDIDATE : un jeu en controle qui remplacera une source autorisee (nouvelle version d un plan d axes, d un reseau) se compare a elle
 * avant son autorisation. La quarantaine n est montree QU AUX ROLES QUI DECIDENT (ADMIN, GESTIONNAIRE) : un lecteur ne recoit ni le jeu en attente
 * ni sa presence (revue RC-3 : aucune fuite de metadonnees de jeux non AUTORISE). La vue ne rend que des metadonnees de jeux, jamais d objet ni de
 * geometrie.
 */

import { prisma } from "../../lib/prisma";
import { exigerProjetActif } from "../conflits/dossiers.service";
import { estDecideur } from "../conflits/types.noyau";
import type { Acteur } from "../projets.service";
import type { StatutReseauSources } from "./types.noyau";

const jour = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);

type LigneJeu = Awaited<ReturnType<typeof lireJeux>>[number];
const lireJeux = (projetId: string, statuts: string[]) => prisma.jeuDonneesProjet.findMany({
  where: { projetId, statut: { in: statuts as never[] }, role: { in: ["RESEAU_TIERS", "AXES_TRAVAUX"] } },
  include: { concessionnaire: { select: { id: true, nom: true } } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
});

const vueSource = (s: LigneJeu) => ({
  jeuId: s.id, role: s.role, version: s.version, methodeAcquisition: s.methodeAcquisition, dateDonnees: jour(s.dateDonnees), dateDepot: s.createdAt, nomFichier: s.nomFichier,
  classePrecision: s.classePrecision, precisionHorizontaleM: s.precisionHorizontaleM === null ? null : Number(s.precisionHorizontaleM), nbObjets: s.nbObjets, confidentialite: s.confidentialite,
});

export async function vueSources(acteur: Acteur, projetId: string) {
  await exigerProjetActif(projetId);
  const decide = estDecideur(acteur.role);
  const jeux = await lireJeux(projetId, ["AUTORISE"]);
  // Versions candidates (en controle, remplacant une source autorisee) : lues SEULEMENT pour un compte qui decide.
  const candidats = decide ? (await lireJeux(projetId, ["RECU", "CONTROLE"])).filter((j) => j.remplaceId !== null) : [];
  const ids = jeux.map((j) => j.id);
  const comparaisons = ids.length
    ? await prisma.comparaisonSources.findMany({
      where: { projetId, statut: "TERMINEE", mode: "SOURCES", jeuAId: { in: ids }, jeuBId: { in: ids } },
      select: { id: true, numero: true, jeuAId: true, jeuBId: true, createdAt: true, resume: true }, orderBy: { numero: "desc" },
    })
    : [];
  const groupes = new Map<string, LigneJeu[]>();
  for (const j of jeux) {
    const k = j.role === "AXES_TRAVAUX" ? "AXES" : `${j.concessionnaireId ?? ""}|${j.typeReseau ?? ""}`;
    groupes.set(k, [...(groupes.get(k) ?? []), j]);
  }
  const reseaux = [...groupes.values()].map((sources) => {
    const idsGroupe = new Set(sources.map((s) => s.id));
    const derniere = comparaisons.find((c) => idsGroupe.has(c.jeuAId) && idsGroupe.has(c.jeuBId)) ?? null;
    const statut: StatutReseauSources = sources.length >= 2 ? "COMPARABLE" : "SOURCE_UNIQUE_COMPARAISON_INDISPONIBLE";
    const totaux = (derniere?.resume as { totaux?: Record<string, number> } | null)?.totaux ?? null;
    const enAttente = candidats.filter((c) => c.remplaceId !== null && idsGroupe.has(c.remplaceId));
    return {
      role: sources[0].role,
      concessionnaire: sources[0].concessionnaire ? { id: sources[0].concessionnaire.id, nom: sources[0].concessionnaire.nom } : null,
      typeReseau: sources[0].typeReseau, statut, nbSources: sources.length,
      sources: sources.map(vueSource),
      derniereComparaison: derniere ? { id: derniere.id, numero: derniere.numero, createdAt: derniere.createdAt, totaux } : null,
      // Absent pour un compte qui ne decide pas (la quarantaine ne lui est pas montree, ni son existence).
      ...(decide ? { versionsCandidates: enAttente.map((c) => ({ ...vueSource(c), statut: c.statut, remplace: c.remplaceId })) } : {}),
      mention: statut === "COMPARABLE"
        ? "Deux sources ou plus décrivent ce réseau : une comparaison peut être lancée ; son résultat est une synthèse, jamais une décision."
        : "Une seule source décrit ce réseau : c'est l'état normal, aucune divergence n'est calculée (la comparaison exige une seconde source autorisée, ou une version candidate en contrôle).",
    };
  });
  return {
    reseaux,
    totaux: { reseaux: reseaux.length, comparables: reseaux.filter((r) => r.statut === "COMPARABLE").length, sourcesUniques: reseaux.filter((r) => r.statut !== "COMPARABLE").length },
    limites: [
      "Une source est un jeu autorisé ; pour un réseau de concessionnaire, deux méthodes d'acquisition différentes font deux sources, une nouvelle version d'une même source la remplace.",
      "Un plan d'axes n'a qu'une source autorisée à la fois : une nouvelle version (par exemple le DXF du bureau d'études après un tracé numérisé depuis un PDF) se compare à la version autorisée avant son autorisation.",
    ],
  };
}
