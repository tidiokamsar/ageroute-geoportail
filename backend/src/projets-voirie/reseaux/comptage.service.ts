/**
 * COMPTAGE DES RESEAUX PAR NATURE (lot B1 ; cahier v2, 20.1 et 22.2 point 5) : infrastructures physiques, circuits logiques, equipements.
 *
 * LES TOTAUX NE MELANGENT JAMAIS LES NATURES (voir comptage.noyau.ts) : N circuits logiques superposes sur une meme trace ne sont jamais N
 * cables ; la longueur de trace fusionnee, la somme des longueurs de circuits et le nombre d'infrastructures declarees sont des grandeurs
 * distinctes, chacune nommee et libellee. Un objet de nature inconnue n'est compte ni comme infrastructure ni comme circuit.
 *
 * ENTREES : par defaut les jeux AUTORISE ; `inclureNonAutorises` (ADMIN et GESTIONNAIRE, 403 QUARANTAINE_RESERVEE sinon : decide par la route)
 * y ajoute les jeux en attente, qui REMPLACENT pour ce comptage le jeu autorise de meme cle (jamais deux fois le meme reseau).
 * Lecture seule (`READ ONLY`), delai cote base (504 COMPTAGE_TROP_LONG), 3 calculs simultanes au plus (503 SERVICE_OCCUPE). Aucune geometrie.
 */

import { prisma } from "../../lib/prisma";
import { Budget, avecErreurDelai, poserDelais } from "../bd";
import { delaiAnalyseMs, delaiVerrouMs } from "../config";
import { jeuLisible } from "../conflits/visibilite.noyau";
import { tracerConsultation } from "../consultation";
import { ErreurMetier } from "../erreurs";
import { limiteurAnalyses } from "../limiteurs";
import type { Acteur } from "../projets.service";
import { JEU_INTROUVABLE, exigerProjetActif, jour, statutsLisibles } from "./commun";
import { LIMITE_SOURCES_MULTIPLES, assemblerComptage, retenirJeux, sourcesMultiples } from "./comptage.noyau";
import * as depot from "./reseaux.depot";
import { volumes } from "../analyse.depot";
import { exigerCapacite } from "../capacite";

export interface DemandeComptage { jeuId?: string; inclureNonAutorises: boolean }

export const LIMITES_COMPTAGE = [
  "Ces comptes sont ceux des objets DÉCLARÉS dans les fichiers retenus : un objet n'est pas un équipement physique tant que sa nature n'est pas établie.",
  "Une proposition d'association n'est pas un support physique validé : seul un support validé par une personne compte comme tel.",
  "Conflit vertical non évalué : profondeur et altitude absentes ou non évaluées ; aucune conclusion 3D n'est produite.",
  "La connectivité du réseau (nœuds, continuité, traces amont et aval) n'est pas évaluée : le cahier la reporte.",
] as const;

export async function comptageProjet(acteur: Acteur, projetId: string, d: DemandeComptage) {
  const projet = await exigerProjetActif(projetId);
  const tous = await prisma.jeuDonneesProjet.findMany({
    where: { projetId, role: { in: ["RESEAU_TIERS", "AUTRE"] }, statut: { in: statutsLisibles(acteur.role) as never[] } },
    include: { concessionnaire: { select: { id: true, nom: true } } },
    orderBy: [{ role: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
  let retenus;
  if (d.jeuId) {
    // Un jeu d'un autre projet, inconnu, retire ou illisible : le meme 404.
    const j = tous.find((x) => x.id === d.jeuId);
    if (!j || !jeuLisible(acteur.role, j.statut)) throw JEU_INTROUVABLE();
    retenus = [j];
  } else {
    retenus = retenirJeux(tous, d.inclureNonAutorises);
  }
  const jeuxIds = retenus.map((j) => j.id);
  const demande: depot.DemandeComptage = { projetId, jeuxIds };

  const delai = delaiAnalyseMs();
  const trop = () => new ErreurMetier(504, "COMPTAGE_TROP_LONG", `Le comptage a dépassé ${Math.round(delai / 1000)} s et a été interrompu : restreignez-le à un jeu (jeuId).`);
  const mesures = await limiteurAnalyses.executer(() => avecErreurDelai("COMPTAGE_TROP_LONG", trop().message, () => prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    await poserDelais(tx, delai, delaiVerrouMs());
    const budget = new Budget(tx, delai, delaiVerrouMs(), trop);
    // Correctif D4 : comptage prealable des jeux retenus (sans calcul geometrique), refus immediat au-dela des plafonds mesures (capacite.ts).
    if (jeuxIds.length > 0) exigerCapacite(await budget.etape(() => volumes(tx, [], jeuxIds), "volumes"), "COMPTAGE");
    const m = await budget.etape(() => depot.mesurerComptage(tx, demande), "comptage");
    const q = await budget.etape(() => depot.mesurerQualite(tx, demande), "qualite");
    return { m, q };
  }, { timeout: delai + 15_000, maxWait: 10_000 })));

  const circuits = mesures.m.parNature.CIRCUIT_LOGIQUE.nb;
  const comptage = assemblerComptage({
    infrastructures: mesures.m.parNature.ACTIF_PHYSIQUE,
    circuits: mesures.m.parNature.CIRCUIT_LOGIQUE,
    equipements: mesures.m.parNature.EQUIPEMENT,
    inconnue: mesures.m.parNature.INCONNUE,
    supportPhysique: {
      avecSupportValide: mesures.m.supports.avecSupportValide,
      avecPropositionSeulement: mesures.m.supports.avecPropositionSeulement,
      sansSupportConnu: Math.max(0, circuits - mesures.m.supports.avecSupportValide - mesures.m.supports.avecPropositionSeulement),
    },
  });
  const qualite = mesures.q;
  // m4 : le comptage rend, par jeu, le nom du fichier, le concessionnaire et les longueurs : lecture tracee pour les jeux sensibles, AVANT la remise des donnees.
  await tracerConsultation(acteur, retenus.map((j) => ({ id: j.id, confidentialite: j.confidentialite, nbObjets: j.nbObjets })), { route: "reseau", bbox: null, zoom: null });
  return {
    projet,
    inclureNonAutorises: d.inclureNonAutorises,
    // Faits de chaque jeu, tels qu'enregistres au depot : jamais additionnes entre eux.
    jeux: retenus.map((j) => ({
      jeuId: j.id, role: j.role, statut: j.statut, nonAutorise: j.statut !== "AUTORISE", version: j.version, nomFichier: j.nomFichier,
      concessionnaire: j.concessionnaire ? { id: j.concessionnaire.id, nom: j.concessionnaire.nom } : null, typeReseau: j.typeReseau,
      natureObjets: j.natureObjets, confidentialite: j.confidentialite, dateDonnees: jour(j.dateDonnees),
      nbObjets: j.nbObjets, libelleNbObjets: "circuits ou objets du fichier", longueurTotaleM: Math.round(j.longueurTotaleM * 100) / 100,
      longueurTraceFusionneM: Math.round(j.longueurTraceFusionneM * 100) / 100,
    })),
    ...comptage,
    qualite: {
      objets: qualite.objets, parClasse: qualite.parClasse,
      libelleClasse: "classe de precision declaree par la source ou par une personne ; « inconnue » tant qu'elle n'est pas declaree, jamais deduite",
      donneesVerticales: {
        objetsAvecProfondeurOuAltitude: qualite.avecDonneesVerticales, sansProfondeur: qualite.sansProfondeur, sansAltitude: qualite.sansAltitude,
        evaluables: 0, mention: "Aucune évaluation verticale n'est implémentée : aucune conclusion 3D, même quand des données sont fournies.",
      },
    },
    // Correctifs T1+S1 (M4) : memes jeux que l'analyse 2D et RC-3 ; plusieurs sources d'un meme reseau s'additionnent, et c'est dit.
    sourcesMultiples: sourcesMultiples(retenus),
    limites: [...LIMITES_COMPTAGE, ...(sourcesMultiples(retenus).length > 0 ? [LIMITE_SOURCES_MULTIPLES] : [])],
  };
}
