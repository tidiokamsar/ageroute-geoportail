/**
 * Donnees SYNTHETIQUES du suivi contractuel, pour les tests et la verification en navigateur (contrat §10 : marquees
 * synthetiques, jamais livrees dans une vue de production). Aucune ne vient d'un marche reel ; les noms sont des intitules de test.
 */
import type {
  ChantierLieVue, ControleVue, MarcheVue, MontantVue, ReponseContractuel, ReponseMarche, SyntheseVue,
} from "../../../lib/aideDecisionContractuel";

export const ID = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

export function montant(o: Partial<MontantVue> = {}): MontantVue {
  return { etat: "DISPONIBLE", valeurGnf: "1250000000", motif: null, source: "source de test", avertissement: null, ...o };
}

export const ENGAGE_NON_DISPONIBLE: MontantVue = montant({
  etat: "NON_DISPONIBLE", valeurGnf: null, motif: "SOURCE_NON_VALIDEE", source: "aucune source financiere validee (B-08, ADR-003)",
  avertissement: "Montant engagé non disponible : la source financière n'est pas validée.",
});

export function chantierLie(o: Partial<ChantierLieVue> = {}): ChantierLieVue {
  return {
    id: "c1", intitule: "Chantier Kindia nord", entreprise: "SOGEA", statut: "EN_COURS", regionId: 1, avancementDeclarePct: 40, dateFinPrevue: "2026-12-31",
    bailleurTexte: null, partageEntreMarches: false,
    lienTroncon: { qualite: "PAR_CHANTIER", troncon: null, tronconChantier: { id: "t1", code: "RN1-1", nom: "Route 1" } }, ...o,
  };
}

export function marcheVue(o: Partial<MarcheVue> = {}): MarcheVue {
  const base: MarcheVue = {
    id: ID(1), intitule: "Réhabilitation RN1 (essai)",
    reference: { etat: "DISPONIBLE", valeur: ["C-12"], source: "chantiers.numContrat", avertissement: null },
    lots: { etat: "NON_DISPONIBLE", valeur: null, source: "aucun champ lot", avertissement: "Les lots ne sont pas modélisés." },
    entreprises: { etat: "DISPONIBLE", valeur: ["SOGEA"], source: "chantiers.entreprise", avertissement: null },
    bailleur: { id: 1, nom: "BAD (essai)", type: "multilateral", source: "marches.bailleurId" },
    dates: { signature: "2025-12-01", debutPrevu: "2026-01-15", finPrevue: "2026-12-31", receptionProvisoire: null, garantieBonneExecution: null },
    delais: {
      dureePrevueJours: 350,
      avenants: { etat: "NON_DISPONIBLE", valeur: null, source: "aucune table", avertissement: "Les avenants ne sont pas modélisés." },
      suspensions: { etat: "NON_DISPONIBLE", valeur: null, source: "aucun historique", avertissement: "Aucune date de suspension." },
    },
    statut: { code: "EN_COURS", libelle: "En cours", source: "marches.statut", usageRetard: "OUVERT" },
    devise: "GNF",
    montants: {
      contractuel: montant({ valeurGnf: "1250000000", source: "marches.montantTotal" }),
      engage: ENGAGE_NON_DISPONIBLE,
      decaisse: montant({ valeurGnf: "300000000", source: "decomptes PAYE" }),
      previsionnel: montant({ etat: "NON_DISPONIBLE", valeurGnf: null, motif: "AUCUN_LIEN", avertissement: "Aucun programme retenu lié." }),
    },
    decomptes: { total: 2, parStatut: { EMIS: 1, PAYE: 1, REJETE: 0 }, payes: [{ numero: 1, type: "DECOMPTE", datePaiement: "2026-06-01" }] },
    programmes: { retenusLies: [], ambigus: 0 },
    avancement: {
      declare: { etat: "DISPONIBLE", physiqueReelPct: 55, physiquePrevuPct: 60, periode: "2026-09-01", source: "avancement_marche", avertissement: "Déclaratif, non vérifié." },
      constate: { etat: "NON_DISPONIBLE", valeurPct: null, motif: "AUCUNE_SOURCE_DE_CONSTAT", source: "aucune", avertissement: "Aucune source de constat distincte du déclaré." },
      financier: { etat: "DISPONIBLE", reelPct: 30, prevuPct: 50, periode: "2026-09-01", source: "avancement_marche", avertissement: "Distinct du physique et du décaissé." },
    },
    retard: {
      etat: "A_JOUR", regles: ["CALENDAIRE", "PHYSIQUE"], joursRetardCalendaire: null, ecartPhysiquePoints: 5, gravite: null, alertes: [],
      avertissements: ["Avenants et suspensions ignorés : le retard est calculé sur les dates prévues saisies."],
    },
    pieces: { etat: "NON_DISPONIBLE", liens: [], raison: "Aucune pièce rattachée aux marchés." },
    liens: {
      chantiers: { qualite: "DIRECT", total: 1, archivesIgnores: 0, tronque: false, autresRegionsMasquees: false, liste: [chantierLie()] },
      troncons: {
        qualite: "PAR_CHANTIER", comptes: { DIRECT: 0, PAR_CHANTIER: 1, MANQUANT: 0, AMBIGU: 0 }, total: 1, tronque: false, autresRegionsMasquees: false,
        liste: [{ id: "t1", code: "RN1-1", nom: "Route 1", regionId: 1, classe: "RN", etat: "MOYEN", via: "CHANTIER", chantierId: "c1" }],
      },
    },
    territoire: { etabli: true, regionIds: [1], multiRegions: false, incertain: false, montantsMasques: false },
    anomalies: [],
    avertissements: ["Données contractuelles partielles : source de vérité externe non intégrée (DigitalRoad)."],
    miseAJourLe: "2026-10-20T08:00:00.000Z",
  };
  return { ...base, ...o };
}

export function syntheseVue(o: Partial<SyntheseVue> = {}): SyntheseVue {
  return {
    marchesRecenses: { nombre: 3, libelle: "Marchés recensés", definition: "Lignes de marches non supprimées.", source: "marches (copie gelée)" },
    parStatut: { PLANIFIE: 1, EN_COURS: 1, SUSPENDU: 0, TERMINE: 0, SOLDE: 1 },
    retard: { enRetard: 1, aJour: 1, nonEvaluables: 1, termines: 0, regle: "PROVISOIRE. Retard calendaire et physique ; avenants et suspensions ignorés.", statutDefinition: "PROVISOIRE" },
    financier: {
      contractuel: montant({ etat: "PARTIEL", valeurGnf: "2500000000", avertissement: "Total partiel : 1 marché(s) sur 3 exclu(s).", couverture: { pris: 2, total: 3 } }),
      engage: ENGAGE_NON_DISPONIBLE,
      decaisse: montant({ etat: "PARTIEL", valeurGnf: "300000000", couverture: { pris: 1, total: 3 } }),
      previsionnel: montant({ etat: "NON_DISPONIBLE", valeurGnf: null, motif: "AUCUN_MARCHE", avertissement: null }),
    },
    totauxParBailleur: [
      { bailleurId: 1, nom: "BAD (essai)", nombreMarches: 2, contractuel: montant({ etat: "PARTIEL", valeurGnf: "2500000000", couverture: { pris: 1, total: 2 } }), autresDevises: [{ devise: "USD", montant: "2000", nombre: 1 }], sansMontant: 1, masques: 0 },
      { bailleurId: null, nom: null, nombreMarches: 1, contractuel: montant({ etat: "NON_DISPONIBLE", valeurGnf: null, motif: "MONTANT_ABSENT" }), autresDevises: [], sansMontant: 1, masques: 0 },
    ],
    ...o,
  };
}

export function controle(o: Partial<ControleVue> = {}): ControleVue {
  return {
    code: "MARCHE_SANS_CHANTIER", libelle: "Marché sans chantier lié", definition: "Marché dont aucun chantier n'est rattaché.", unite: "marches",
    nombre: 0, surTotal: 3, nonVerifiables: 0, exemples: [], statutDefinition: "PROVISOIRE", ...o,
  };
}

export const CONTROLES: ControleVue[] = [
  controle({ nombre: 1, exemples: [{ type: "marche", id: ID(2), marcheId: ID(2), intitule: "Marché sans lien (essai)", detail: "Aucun chantier lié." }] }),
  controle({ code: "CHANTIER_SANS_MARCHE", libelle: "Chantier sans marché", definition: "Chantier qu'aucun marché ne rattache.", unite: "chantiers", nombre: 7, surTotal: 40, exemples: [{ type: "chantier", id: "cx", marcheId: null, intitule: "Chantier orphelin (essai)", detail: "Aucun marché ne rattache ce chantier." }] }),
  controle({ code: "DECOMPTE_SUPERIEUR_MARCHE", libelle: "Décomptes supérieurs au montant du marché", definition: "Un décompte dépasse le montant contractuel.", nombre: 0, surTotal: 3, nonVerifiables: 1 }),
];

export function reponse(o: Partial<ReponseContractuel> = {}): ReponseContractuel {
  const marches = o.marches ?? [
    marcheVue(),
    marcheVue({
      id: ID(2), intitule: "Marché sans lien (essai)", reference: { etat: "NON_DISPONIBLE", valeur: null, source: "chantiers.numContrat", avertissement: "Aucune référence." },
      entreprises: { etat: "NON_DISPONIBLE", valeur: null, source: "chantiers", avertissement: "Aucune entreprise." }, bailleur: { id: null, nom: null, type: null, source: "marches.bailleurId" },
      statut: { code: "PLANIFIE", libelle: "Planifié", source: "marches.statut", usageRetard: "OUVERT" },
      montants: {
        contractuel: montant({ etat: "NON_DISPONIBLE", valeurGnf: null, motif: "MONTANT_ABSENT", avertissement: "Aucun montant saisi." }), engage: ENGAGE_NON_DISPONIBLE,
        decaisse: montant({ etat: "NON_DISPONIBLE", valeurGnf: null, motif: "AUCUN_DECOMPTE" }), previsionnel: montant({ etat: "NON_DISPONIBLE", valeurGnf: null, motif: "AUCUN_LIEN" }),
      },
      avancement: {
        declare: { etat: "NON_DISPONIBLE", physiqueReelPct: null, physiquePrevuPct: null, periode: null, source: "avancement_marche", avertissement: "Aucune période saisie." },
        constate: { etat: "NON_DISPONIBLE", valeurPct: null, motif: "AUCUNE_SOURCE_DE_CONSTAT", source: "aucune", avertissement: "Aucune source de constat." },
        financier: { etat: "NON_DISPONIBLE", reelPct: null, prevuPct: null, periode: null, source: "avancement_marche", avertissement: "Aucune période saisie." },
      },
      retard: { etat: "NON_EVALUABLE", regles: [], joursRetardCalendaire: null, ecartPhysiquePoints: null, gravite: null, alertes: [], avertissements: ["Avenants et suspensions ignorés."] },
      liens: {
        chantiers: { qualite: "MANQUANT", total: 0, archivesIgnores: 0, tronque: false, autresRegionsMasquees: false, liste: [] },
        troncons: { qualite: "MANQUANT", comptes: { DIRECT: 0, PAR_CHANTIER: 0, MANQUANT: 0, AMBIGU: 0 }, total: 0, tronque: false, autresRegionsMasquees: false, liste: [] },
      },
      territoire: { etabli: false, regionIds: [], multiRegions: false, incertain: false, montantsMasques: false },
      anomalies: ["MARCHE_SANS_CHANTIER"],
    }),
    marcheVue({
      id: ID(3), intitule: "Marché en retard (essai)", statut: { code: "EN_COURS", libelle: "En cours", source: "marches.statut", usageRetard: "OUVERT" },
      retard: { etat: "EN_RETARD", regles: ["CALENDAIRE", "PHYSIQUE"], joursRetardCalendaire: 40, ecartPhysiquePoints: 30, gravite: "haute", alertes: [{ code: "RETARD_CALENDAIRE", gravite: "moyenne", message: "Date de fin prévue dépassée de 40 jour(s)." }], avertissements: ["Avenants et suspensions ignorés."] },
      liens: {
        chantiers: { qualite: "AMBIGU", total: 1, archivesIgnores: 0, tronque: false, autresRegionsMasquees: false, liste: [chantierLie({ id: "c3", intitule: "Chantier partagé", partageEntreMarches: true, lienTroncon: { qualite: "AMBIGU", troncon: { id: "t2", code: "RN2-1", nom: "Route 2" }, tronconChantier: { id: "t1", code: "RN1-1", nom: "Route 1" } } })] },
        troncons: { qualite: "AMBIGU", comptes: { DIRECT: 0, PAR_CHANTIER: 0, MANQUANT: 0, AMBIGU: 1 }, total: 2, tronque: false, autresRegionsMasquees: false, liste: [] },
      },
      anomalies: ["ASSOCIATION_AMBIGUE"],
    }),
  ];
  return {
    genereLe: "2026-10-26T12:00:00.000Z",
    source: { code: "COPIE_GELEE_GEOPORTAIL", libelle: "Copie locale gelée", sourceDeVerite: "DigitalRoad", integree: false, copieGelee: true, derniereSynchronisation: null, references: ["ADR-003"] },
    droitFinancier: true,
    perimetre: { national: true, regionIds: null, libelle: "National : tous les marchés recensés", totalNationalFourni: true, filtres: {} },
    donneesPartielles: {
      partiel: true, message: "Données contractuelles partielles : source de vérité externe non intégrée (DigitalRoad).",
      raisons: ["DigitalRoad n'est pas intégré (B-11) : la copie locale est gelée (ADR-003).", "1 marché(s) sans chantier lié."],
    },
    fraicheur: { calculeLe: "2026-10-26T12:00:00.000Z", derniereMiseAJour: "2026-10-20T08:00:00.000Z", ageJours: 6, perime: false, seuilPeremptionJours: 90, statutSeuil: "PROVISOIRE", gelee: true, derniereSynchronisation: null },
    plafond: { marchesAnalyses: marches.length, plafond: 2000, tronque: false },
    synthese: syntheseVue({ marchesRecenses: { nombre: marches.length, libelle: "Marchés recensés", definition: "Lignes de marches non supprimées.", source: "marches (copie gelée)" } }),
    controles: CONTROLES,
    marches,
    page: { limite: 25, total: marches.length, curseurSuivant: null },
    definitions: [],
    ...o,
  };
}

export function ficheReponse(marche: MarcheVue, o: Partial<ReponseMarche> = {}): ReponseMarche {
  return {
    genereLe: "2026-10-26T12:00:00.000Z",
    source: { code: "COPIE_GELEE_GEOPORTAIL", libelle: "Copie locale gelée", sourceDeVerite: "DigitalRoad", integree: false, copieGelee: true, derniereSynchronisation: null, references: ["ADR-003"] },
    droitFinancier: true,
    donneesPartielles: { partiel: true, message: "Données contractuelles partielles : source de vérité externe non intégrée (DigitalRoad).", raisons: ["DigitalRoad n'est pas intégré."] },
    marche,
    decomptes: {
      liste: [
        { numero: 1, type: "DECOMPTE", statut: "PAYE", montantGnf: "300000000", dateEmission: "2026-05-01", datePaiement: "2026-06-01", compteDansDecaisse: true },
        { numero: 2, type: "AVANCE", statut: "EMIS", montantGnf: "125000000", dateEmission: "2026-07-01", datePaiement: null, compteDansDecaisse: false },
      ],
      tronque: false,
    },
    definitions: [],
    ...o,
  };
}
