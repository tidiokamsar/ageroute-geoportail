import type { ControleLot, Etape, LigneApercu, LotDetail, LotListe, ReponseApercu } from "./types";

/**
 * Fabriques de lots pour les tests de la liste, du détail et de l'aperçu (pas de code de production).
 * Chaque fabrique accepte un correctif partiel : un test ne nomme que ce qui le concerne.
 */

export function lotListe(over: Partial<LotListe> = {}): LotListe {
  return {
    id: "lot-1",
    reference: "IMP-2026-00001",
    systemeSource: "ONR_BDR",
    format: "csv",
    nomFichier: "rn1.csv",
    tailleOctets: "1572864",
    statut: "VALIDE_SCHEMA",
    importeLe: "2026-10-14T20:00:00.000Z",
    importePar: { id: "u-1", nomComplet: "Tidiane Diallo" },
    versionMapping: "v0",
    autorisationRef: "AUT-2026-01",
    lignesLues: 10,
    lignesValidees: 8,
    lignesImportees: 0,
    lignesRejetees: 2,
    lignesEnConflit: 0,
    lignesIgnorees: 0,
    motifRejetLot: null,
    ...over,
  };
}

export const ETAPES_SANS_CIRCUIT: Etape[] = [
  { id: "reception", titre: "Réception du fichier", etat: "TERMINEE", raison: "Fichier reçu et empreinte calculée." },
  { id: "controle_schema", titre: "Contrôle du schéma", etat: "TERMINEE_AVEC_RESERVES", raison: "2 lignes rejetées." },
  { id: "echantillon", titre: "Échantillon à valider", etat: "NON_DISPONIBLE", raison: "Aucun circuit d'approbation n'existe encore." },
  { id: "import_autorise", titre: "Import autorisé", etat: "NON_DISPONIBLE", raison: "L'écriture au référentiel n'a pas de circuit." },
];

export function controle(over: Partial<ControleLot> = {}): ControleLot {
  return {
    motifRejetLot: null,
    compteurs: { lues: 10, validees: 8, rejetees: 2, enConflit: 0, ignorees: 0, importees: 0 },
    premiersRejets: [
      { numeroLigne: 3, statut: "REJETEE", motif: "identifiant_source manquant" },
      { numeroLigne: 7, statut: "REJETEE", motif: "coordonnees hors du domaine attendu" },
    ],
    colonnes: { reconnues: ["systeme_source", "type_objet", "identifiant_source"], inconnues: ["commentaire_libre"] },
    avertissements: [],
    ...over,
  };
}

export function lotDetail(over: Partial<LotDetail> = {}): LotDetail {
  const { motifRejetLot: _motif, ...base } = lotListe();
  return {
    ...base,
    methodeSource: "export L2R Mesure",
    auteurSource: null,
    dateSource: null,
    empreinte: { algorithme: "sha256", valeur: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08" },
    controle: controle(),
    etapes: ETAPES_SANS_CIRCUIT,
    actionsPermises: [
      { code: "TELECHARGER_ERREURS", permise: true, raison: null },
      { code: "VOIR_APERCU", permise: true, raison: null },
    ],
    historique: [
      { date: "2026-10-14T20:00:00.000Z", action: "CREATE", acteur: "Tidiane Diallo", details: null },
    ],
    ...over,
  };
}

export function ligne(over: Partial<LigneApercu> = {}): LigneApercu {
  return {
    numeroLigne: 1,
    statut: "VALIDEE",
    motifRejet: null,
    identifiantSource: "RN1-001",
    charge: { type_objet: "TRONCON", nom: "RN1 Conakry - Coyah" },
    ...over,
  };
}

export function reponseApercu(over: Partial<ReponseApercu> = {}): ReponseApercu {
  return { lignes: [ligne()], suivant: null, tronque: false, ...over };
}
