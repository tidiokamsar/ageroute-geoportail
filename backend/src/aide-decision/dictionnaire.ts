/**
 * DICTIONNAIRE DES INDICATEURS de l'Aide a la decision (cahier paragraphe 9.1) : code, definition, formule exacte,
 * unite, perimetre, source, conditions, limites, regles d'exclusion, responsable metier, statut de la definition.
 *
 * C'EST LE CODE QUI FAIT FOI, ET CE FICHIER LE DECRIT. `docs/aide-decision/DICTIONNAIRE-KPI.md` est ecrit A PARTIR de
 * ces entrees (et des fichiers `kpi.noyau.ts`, `kpi.depot.ts`), jamais l'inverse. Un test exige que chaque indicateur
 * rendu par la synthese ait son entree ici, et que chaque entree dise ce qui reste a decider.
 *
 * AUCUNE DEFINITION N'EST VALIDEE. Toutes portent `statutDefinition: "PROVISOIRE"`. Le responsable metier n'est
 * jamais nomme : « a confirmer par la Direction technique » (ou financiere) tant qu'AGEROUTE n'a pas tranche.
 */
import { PERIMETRES } from "../tableau-de-bord/indicateurs.registre";
import { PARAMETRES_KPI, LIBELLE_EXIGENCE } from "./kpi.noyau";

export interface PerimetreDictionnaire { code: string; libelle: string; definition: string }

export interface EntreeDictionnaire {
  code: string;
  libelle: string;
  definition: string;
  /** Formule exacte, en clair. */
  formule: string;
  /** Colonnes lues (table.colonne). */
  colonnes: string[];
  /** Conditions de selection exactes (WHERE). */
  filtres: string[];
  unite: "%" | "km" | "GNF" | "nombre" | "part" | "elements";
  perimetre: PerimetreDictionnaire;
  source: string;
  tablesSources: string[];
  /** Date de la derniere revision de la definition (AAAA-MM-JJ). */
  dateDefinition: string;
  /** Quand la valeur est mise a jour. */
  miseAJour: string;
  conditionsCalcul: string[];
  limites: string[];
  reglesExclusion: string[];
  responsableMetier: string;
  statutDefinition: "PROVISOIRE" | "VALIDEE";
  /** Ce que le metier n'a pas tranche : jamais devine ici. */
  decisionsOuvertes: string[];
}

const DATE = "2026-10-26";
const DT = "À confirmer par la Direction technique";
const DF = "À confirmer par la Direction financière";
const RECALCUL = "À chaque requête (instantané au moment du calcul, aucune mise en cache) ; la date de calcul accompagne chaque valeur.";

const RESEAU: PerimetreDictionnaire = { ...PERIMETRES.RESEAU_CLASSE_SAISI };
const CHANTIERS: PerimetreDictionnaire = { ...PERIMETRES.CHANTIERS_REGISTRE };

const FILTRES_RESEAU = [
  "troncons.deletedAt IS NULL",
  "troncons.sourceReference IS NULL OU ne commence ni par « voirie_locale: » ni par « hors_territoire: » (lib/reseau.ts, fragmentPerimetre « reference »)",
  "troncons.regionId dans les régions du périmètre du compte (et du filtre de région demandé)",
  "troncons.classe dans le filtre « classe » s'il est demandé",
];

const COLONNES_ETAT = [
  "troncons.etat", "troncons.longueurKm", "troncons.regionId", "troncons.classe", "troncons.statutValidation", "troncons.dateDerniereEvaluation",
  "valeurs_qualite.statut et valeurs_qualite.observedAt (entityType « Troncon », champ « etat »)",
  "valeurs_qualite.statut (entityType « Troncon », champ « longueurKm », pour écarter les longueurs dérivées)",
];

const REGLE_ETAT_VALIDE =
  "État valide = le tronçon a un état BON, MOYEN, MAUVAIS ou CRITIQUE, son statut de validation n'est ni REJETE ni A_CORRIGER, la ligne de qualité de son état n'est ni CONFLICTING ni UNKNOWN, "
  + `et, selon l'exigence « ${PARAMETRES_KPI.exigenceEtat} » (PROVISOIRE) : ${LIBELLE_EXIGENCE[PARAMETRES_KPI.exigenceEtat]}.`;

const LONGUEUR_CONNUE =
  "Longueur métier connue = troncons.longueurKm finie et > 0 ET non marquée DERIVED dans valeurs_qualite (une longueur calculée sur la géométrie n'est pas la longueur métier). Sinon elle est inconnue : le tronçon est compté, sa longueur n'est jamais additionnée.";

const DECISION_D06 = "Périmètre et source de la longueur du réseau de référence (D-06) : la base ne porte qu'une fraction du réseau annoncé.";
const DECISION_DEGRADE = "Définition officielle des classes « dégradées » (paramètre PROVISOIRE : MAUVAIS et CRITIQUE).";
const DECISION_ETAT_VALIDE = "Règle d'« état valide » (paramètre PROVISOIRE : état constaté et daté) et seuil de fraîcheur d'un constat.";
const DECISION_B08 = "Source financière de référence et définition du budget engagé (B-08, ADR-003).";

/** Les entrees, dans l'ordre d'affichage. */
export const DICTIONNAIRE: readonly EntreeDictionnaire[] = [
  {
    code: "reseau_degrade_pct",
    libelle: "Réseau dégradé",
    definition: "Part de la longueur métier du réseau classé saisi dont l'état est valide et appartient aux classes dites dégradées, rapportée à la longueur métier des tronçons à état valide. Numérateur et dénominateur sont calculés sur les mêmes tronçons.",
    formule: "100 × Σ longueurKm (tronçons du périmètre, longueur connue, état valide, état ∈ classesDegradees) ÷ Σ longueurKm (tronçons du périmètre, longueur connue, état valide) ; arrondi à 0,1 ; classesDegradees = MAUVAIS + CRITIQUE (PROVISOIRE).",
    colonnes: COLONNES_ETAT,
    filtres: FILTRES_RESEAU,
    unite: "%",
    perimetre: RESEAU,
    source: "Base BDRI : tronçons du réseau classé saisi, état et provenance de l'état (valeurs_qualite), longueur métier saisie.",
    tablesSources: ["troncons", "valeurs_qualite"],
    dateDefinition: DATE,
    miseAJour: RECALCUL,
    conditionsCalcul: [
      "Le dénominateur (longueur des tronçons à état valide et longueur connue) doit être > 0 ; sinon la valeur est null et l'état « NON_DISPONIBLE » (jamais 0).",
      REGLE_ETAT_VALIDE,
      LONGUEUR_CONNUE,
      "L'état de l'indicateur est « PARTIEL » dès que des tronçons du périmètre sont non évalués, à état non valide ou sans longueur métier ; la couverture est rendue avec la valeur.",
    ],
    limites: [
      "Les tronçons non évalués ne sont pas au dénominateur : le taux ne dit rien d'eux, qui peuvent être pires ou meilleurs. La part non évaluée est rendue à côté.",
      "Un état modifié à la main après un constat garde sa ligne de qualité OBSERVED : seule l'audit permet de le voir (limite connue, non détectée).",
      "La longueur métier n'est saisie que pour une partie des tronçons : les tronçons sans longueur sont exclus des deux termes et comptés dans les avertissements.",
      "Le réseau classé saisi n'est pas le réseau officiel annoncé : le taux décrit la base, pas le pays.",
    ],
    reglesExclusion: [
      "Tronçons supprimés (deletedAt).",
      "Voirie promue (« voirie_locale: ») et tronçons hors territoire (« hors_territoire: ») : jamais au numérateur ni au dénominateur.",
      "Tronçons NON_EVALUE ou sans état : comptés à part.",
      "Tronçons à état renseigné mais non valide : comptés à part.",
      "Tronçons sans longueur métier connue : comptés, non additionnés.",
    ],
    responsableMetier: DT,
    statutDefinition: "PROVISOIRE",
    decisionsOuvertes: [DECISION_DEGRADE, DECISION_ETAT_VALIDE, DECISION_D06],
  },
  {
    code: "reseau_critique_km",
    libelle: "Réseau critique (longueur)",
    definition: "Longueur métier des tronçons du réseau classé saisi dont l'état est valide et critique.",
    formule: "Σ longueurKm (tronçons du périmètre, longueur connue, état valide, état ∈ classesCritiques) ; arrondi à 0,01 km ; classesCritiques = CRITIQUE (PROVISOIRE).",
    colonnes: COLONNES_ETAT,
    filtres: FILTRES_RESEAU,
    unite: "km",
    perimetre: RESEAU,
    source: "Base BDRI : tronçons du réseau classé saisi, état et provenance de l'état, longueur métier saisie.",
    tablesSources: ["troncons", "valeurs_qualite"],
    dateDefinition: DATE,
    miseAJour: RECALCUL,
    conditionsCalcul: [
      "Valeur null et état « NON_DISPONIBLE » quand aucun tronçon n'a un état valide et une longueur connue (la longueur critique d'un réseau non évalué est inconnue, pas nulle).",
      REGLE_ETAT_VALIDE,
      LONGUEUR_CONNUE,
    ],
    limites: [
      "Sous-estime la longueur critique réelle : les tronçons non évalués, à état non valide ou sans longueur métier n'y figurent pas.",
      "La définition de « critique » est un paramètre PROVISOIRE versionné (PARAMETRES_KPI).",
    ],
    reglesExclusion: ["Mêmes exclusions que « reseau_degrade_pct »."],
    responsableMetier: DT,
    statutDefinition: "PROVISOIRE",
    decisionsOuvertes: ["Définition officielle de « critique » et de sa version.", DECISION_ETAT_VALIDE, DECISION_D06],
  },
  {
    code: "reseau_critique_pct",
    libelle: "Réseau critique (part)",
    definition: "Part de la longueur métier des tronçons à état valide qui est critique.",
    formule: "100 × Σ longueurKm (état valide, état ∈ classesCritiques) ÷ Σ longueurKm (état valide) ; mêmes tronçons au numérateur et au dénominateur ; arrondi à 0,1.",
    colonnes: COLONNES_ETAT,
    filtres: FILTRES_RESEAU,
    unite: "%",
    perimetre: RESEAU,
    source: "Base BDRI : tronçons du réseau classé saisi, état et provenance de l'état, longueur métier saisie.",
    tablesSources: ["troncons", "valeurs_qualite"],
    dateDefinition: DATE,
    miseAJour: RECALCUL,
    conditionsCalcul: ["Dénominateur > 0, sinon null et « NON_DISPONIBLE ».", REGLE_ETAT_VALIDE, LONGUEUR_CONNUE],
    limites: ["Mêmes limites que « reseau_degrade_pct » : le taux ne couvre que la part évaluée du réseau."],
    reglesExclusion: ["Mêmes exclusions que « reseau_degrade_pct »."],
    responsableMetier: DT,
    statutDefinition: "PROVISOIRE",
    decisionsOuvertes: ["Définition officielle de « critique » et de sa version.", DECISION_ETAT_VALIDE, DECISION_D06],
  },
  {
    code: "longueur_reseau_reference_km",
    libelle: "Longueur du réseau de référence (longueur métier)",
    definition: "Somme des longueurs métier saisies des tronçons du réseau classé saisi. Ce n'est pas la longueur du réseau national annoncé par les TDR de la BDR.",
    formule: "Σ longueurKm (tronçons du périmètre, longueur connue, tous états) ; arrondi à 0,01 km.",
    colonnes: ["troncons.longueurKm", "troncons.regionId", "troncons.classe", "valeurs_qualite.statut (champ « longueurKm »)"],
    filtres: FILTRES_RESEAU,
    unite: "km",
    perimetre: RESEAU,
    source: "Base BDRI : troncons.longueurKm saisie ; même valeur que l'indicateur « longueur_metier_km » du registre du tableau de bord.",
    tablesSources: ["troncons", "valeurs_qualite"],
    dateDefinition: DATE,
    miseAJour: RECALCUL,
    conditionsCalcul: [LONGUEUR_CONNUE, "Valeur null et « NON_DISPONIBLE » quand aucun tronçon n'a de longueur métier connue."],
    limites: [
      "La longueur n'est saisie que pour une partie des tronçons : la somme est une borne basse, pas la longueur du réseau. Le nombre de tronçons sans longueur est rendu.",
      "Jamais complétée par la longueur géométrique (voir « longueur_geometrique_km », séparée).",
    ],
    reglesExclusion: ["Tronçons supprimés, voirie promue, hors territoire ; longueurs absentes, nulles, non finies ou dérivées de la géométrie."],
    responsableMetier: DT,
    statutDefinition: "PROVISOIRE",
    decisionsOuvertes: [DECISION_D06],
  },
  {
    code: "longueur_geometrique_km",
    libelle: "Longueur géométrique du réseau classé saisi",
    definition: "Somme des longueurs mesurées sur le tracé des tronçons (géodésique). Conservée séparément de la longueur métier, qu'elle ne remplace jamais.",
    formule: "Σ ST_Length(troncons.geom::geography) ÷ 1000 (tronçons du périmètre ayant une géométrie) ; arrondi à 0,01 km.",
    colonnes: ["troncons.geom", "troncons.regionId"],
    filtres: ["troncons.deletedAt IS NULL", "troncons.geom IS NOT NULL", "réseau classé saisi (lib/reseau.ts)", "troncons.regionId dans le périmètre"],
    unite: "km",
    perimetre: RESEAU,
    source: "Registre d'indicateurs du tableau de bord (indicateur « longueur_geometrique_km »), repris tel quel.",
    tablesSources: ["troncons"],
    dateDefinition: DATE,
    miseAJour: RECALCUL,
    conditionsCalcul: [
      "Non ventilée par classe : avec un filtre « classe », l'indicateur est « NON_DISPONIBLE ».",
      "Une divergence avec la longueur métier au-dessus du seuil provisoire du détecteur LONGUEUR_ECART_GEOMETRIE est signalée, jamais corrigée.",
    ],
    limites: ["Les tracés des routes régionales sont plus grossiers que ceux des nationales : la valeur est une borne basse (lib/reseau.ts)."],
    reglesExclusion: ["Tronçons sans géométrie ; tronçons supprimés, voirie promue, hors territoire."],
    responsableMetier: DT,
    statutDefinition: "PROVISOIRE",
    decisionsOuvertes: [DECISION_D06],
  },
  {
    code: "couverture_etat_part",
    libelle: "Couverture de l'état (part du réseau à état valide)",
    definition: "Part de la longueur métier connue du réseau classé saisi dont l'état est valide, c'est-à-dire la part que les taux de dégradation « voient ».",
    formule: "Σ longueurKm (état valide) ÷ Σ longueurKm (tous états, longueur connue) ; fraction de 0 à 1, arrondie à 0,0001.",
    colonnes: COLONNES_ETAT,
    filtres: FILTRES_RESEAU,
    unite: "part",
    perimetre: RESEAU,
    source: "Base BDRI : mêmes lignes que « reseau_degrade_pct ».",
    tablesSources: ["troncons", "valeurs_qualite"],
    dateDefinition: DATE,
    miseAJour: RECALCUL,
    conditionsCalcul: ["Valeur null et « NON_DISPONIBLE » quand le périmètre n'a aucune longueur métier connue.", REGLE_ETAT_VALIDE],
    limites: ["Mesurée en longueur métier connue : un tronçon sans longueur n'y pèse pas, son nombre est rendu à part."],
    reglesExclusion: ["Mêmes exclusions que « reseau_degrade_pct »."],
    responsableMetier: DT,
    statutDefinition: "PROVISOIRE",
    decisionsOuvertes: [DECISION_ETAT_VALIDE],
  },
  {
    code: "chantiers_en_cours",
    libelle: "Chantiers en cours",
    definition: "Nombre de chantiers au statut EN_COURS dans le périmètre. Aucun plafond : tous les chantiers sont comptés (la chaîne héritée en lisait 50).",
    formule: "COUNT(chantiers) WHERE deletedAt IS NULL AND statut = 'EN_COURS' AND regionId dans le périmètre.",
    colonnes: ["chantiers.statut", "chantiers.regionId", "chantiers.deletedAt"],
    filtres: ["chantiers.deletedAt IS NULL", "chantiers.statut = 'EN_COURS'", "chantiers.regionId dans le périmètre"],
    unite: "nombre",
    perimetre: CHANTIERS,
    source: "Registre d'indicateurs du tableau de bord (indicateur « chantiers_en_cours »), repris tel quel.",
    tablesSources: ["chantiers"],
    dateDefinition: DATE,
    miseAJour: RECALCUL,
    conditionsCalcul: ["Aucun chantier au registre dans le périmètre : valeur null et « NON_DISPONIBLE » (rien à compter, pas un zéro)."],
    limites: [
      "Le statut est celui saisi dans l'application, pas celui d'un système contractuel de référence.",
      "Les filtres « statutChantier », « classe » et la période ne s'appliquent pas à ce comptage.",
    ],
    reglesExclusion: ["Chantiers supprimés ; statuts PLANIFIE, SUSPENDU, TERMINE."],
    responsableMetier: DT,
    statutDefinition: "PROVISOIRE",
    decisionsOuvertes: ["Règle de statut « actif » et date de mise à jour du statut selon la source métier."],
  },
  {
    code: "chantiers_en_retard",
    libelle: "Chantiers en retard",
    definition: "Nombre de chantiers EN_COURS dont la date de fin prévue est dépassée au moment du calcul.",
    formule: "COUNT(chantiers) WHERE deletedAt IS NULL AND statut = 'EN_COURS' AND dateFinPrevue < maintenant AND regionId dans le périmètre.",
    colonnes: ["chantiers.statut", "chantiers.dateFinPrevue", "chantiers.regionId", "chantiers.deletedAt"],
    filtres: ["chantiers.deletedAt IS NULL", "chantiers.statut = 'EN_COURS'", "chantiers.dateFinPrevue < instant de calcul", "chantiers.regionId dans le périmètre"],
    unite: "nombre",
    perimetre: CHANTIERS,
    source: "Registre d'indicateurs du tableau de bord (indicateur « chantiers_en_retard »), repris tel quel.",
    tablesSources: ["chantiers"],
    dateDefinition: DATE,
    miseAJour: RECALCUL,
    conditionsCalcul: [
      "État « PARTIEL » quand des chantiers EN_COURS n'ont pas de date de fin prévue : leur retard ne peut pas être jugé, leur nombre est rendu.",
    ],
    limites: [
      "La règle ignore les suspensions (un chantier SUSPENDU n'est pas EN_COURS) et les avenants (la date de fin prévue n'est pas prolongée par un avenant) : dit dans les avertissements.",
      "Aucun calendrier de référence applicable n'est défini.",
    ],
    reglesExclusion: ["Chantiers supprimés ; chantiers non EN_COURS ; chantiers sans date de fin prévue (comptés à part)."],
    responsableMetier: DT,
    statutDefinition: "PROVISOIRE",
    decisionsOuvertes: ["Échéance de référence applicable, traitement des suspensions et des avenants (cahier 9.1)."],
  },
  {
    code: "budget_engage_gnf",
    libelle: "Budget engagé",
    definition: "Montant engagé validé par la source financière de référence. NON DISPONIBLE : cette source n'est pas validée. La somme des montants des chantiers n'est PAS un budget engagé et n'est jamais présentée comme tel.",
    formule: "Aucune : l'indicateur n'est pas calculé tant que la source financière de référence et sa définition ne sont pas validées (B-08, ADR-003).",
    colonnes: [],
    filtres: [],
    unite: "GNF",
    perimetre: { code: "SOURCE_FINANCIERE_NON_VALIDEE", libelle: "Source financière de référence non validée", definition: "Aucun périmètre : la source n'existe pas encore dans l'application." },
    source: "Aucune (source financière de référence non validée, B-08, ADR-003).",
    tablesSources: [],
    dateDefinition: DATE,
    miseAJour: "Sans objet : non calculé.",
    conditionsCalcul: ["Toujours « NON_DISPONIBLE », valeur null, avec la raison."],
    limites: [
      "À ne pas confondre avec le budget contractuel (montant des marchés), le décaissé (paiements) ni le prévisionnel (programmes budgétaires).",
      "La chaîne héritée appelait « budget engagé » la somme de tous les chantiers, tous statuts : c'est la confusion que le cahier (8.2) interdit.",
    ],
    reglesExclusion: ["Rien n'est substitué : ni la somme des chantiers, ni celle des marchés."],
    responsableMetier: DF,
    statutDefinition: "PROVISOIRE",
    decisionsOuvertes: [DECISION_B08],
  },
  {
    code: "budget_contractuel_gnf",
    libelle: "Budget contractuel",
    definition: "Somme des montants contractuels saisis des marchés (en GNF) du périmètre. Montant de contrat, pas un engagement, pas un paiement.",
    formule: "Σ marches.montantTotal WHERE deletedAt IS NULL AND devise = 'GNF' AND dans le périmètre ; en chaîne (BigInt).",
    colonnes: ["marches.montantTotal", "marches.devise", "marches.deletedAt", "marches_chantiers.chantierId", "chantiers.regionId", "chantiers.deletedAt"],
    filtres: [
      "marches.deletedAt IS NULL",
      "marches.devise = 'GNF' (les autres devises sont exclues et comptées)",
      "compte national : tous les marchés ; compte régional : marchés rattachés à au moins un chantier non supprimé dont TOUS les chantiers sont dans le périmètre",
    ],
    unite: "GNF",
    perimetre: { code: "MARCHES_SAISIS", libelle: "Marchés saisis", definition: "Lignes de la table marches non supprimées. Les marchés recensés ne sont pas les marchés actifs." },
    source: "Table marches (saisie applicative). La source de vérité DigitalRoad n'est pas intégrée (ADR-003).",
    tablesSources: ["marches", "marches_chantiers", "chantiers"],
    dateDefinition: DATE,
    miseAJour: RECALCUL,
    conditionsCalcul: [
      "Aucun marché dans le périmètre : valeur null et « NON_DISPONIBLE ».",
      "État « PARTIEL » si des marchés n'ont pas de montant saisi (jamais comptés comme 0) ou sont en devise étrangère (exclus, aucun taux de change validé), et pour tout compte régional.",
      "Réservé aux comptes ayant le module « marches » : sinon « NON_DISPONIBLE » avec la raison.",
    ],
    limites: [
      "Un marché n'a pas de région propre : un compte régional ne reçoit pas les marchés sans chantier rattaché ni ceux à cheval sur une région hors périmètre.",
      "Les montants ne sont pas rapprochés d'une source contractuelle externe.",
    ],
    reglesExclusion: ["Marchés supprimés ; montants absents ; marchés en USD ou EUR (comptés à part)."],
    responsableMetier: DF,
    statutDefinition: "PROVISOIRE",
    decisionsOuvertes: [DECISION_B08, "Unité du bailleur et traitement des devises étrangères.", "Confidentialité financière des comptes de lecture (D-C1-1)."],
  },
  {
    code: "budget_decaisse_gnf",
    libelle: "Budget décaissé",
    definition: "Somme des décomptes au statut PAYE des marchés du périmètre. Les décomptes EMIS (émis, non payés) et REJETE ne sont pas des paiements.",
    formule: "Σ decomptes.montantGnf WHERE deletedAt IS NULL AND statut = 'PAYE' AND marché dans le périmètre ; en chaîne (BigInt).",
    colonnes: ["decomptes.montantGnf", "decomptes.statut", "decomptes.type", "decomptes.datePaiement", "decomptes.deletedAt", "decomptes.marcheId"],
    filtres: ["decomptes.deletedAt IS NULL", "decomptes.statut = 'PAYE'", "marché dans le périmètre (mêmes règles que « budget_contractuel_gnf »)"],
    unite: "GNF",
    perimetre: { code: "DECOMPTES_SAISIS", libelle: "Décomptes saisis", definition: "Lignes de la table decomptes non supprimées, rattachées à un marché du périmètre." },
    source: "Table decomptes (saisie applicative). Même règle que /api/decaissements.",
    tablesSources: ["decomptes", "marches", "marches_chantiers", "chantiers"],
    dateDefinition: DATE,
    miseAJour: RECALCUL,
    conditionsCalcul: [
      "Aucun décompte PAYE dans le périmètre : valeur null et « NON_DISPONIBLE » (l'absence de paiement saisi n'est pas un décaissé nul).",
      "Avertissements : décomptes PAYE sans date de paiement, décomptes de retenue de garantie inclus, décomptes EMIS non comptés.",
    ],
    limites: ["Les paiements ne sont pas rapprochés d'une source financière externe."],
    reglesExclusion: ["Décomptes supprimés, EMIS, REJETE ; marchés hors périmètre."],
    responsableMetier: DF,
    statutDefinition: "PROVISOIRE",
    decisionsOuvertes: [DECISION_B08, "Inclusion des retenues de garantie dans le décaissé."],
  },
  {
    code: "budget_previsionnel_gnf",
    libelle: "Budget prévisionnel (prévisions retenues)",
    definition: "Somme des montants prévus des lignes de programme budgétaire au statut RETENU. Une intention de programmation, pas un engagement.",
    formule: "Σ programmes_budgetaires.montantPrevuGnf WHERE deletedAt IS NULL AND statut = 'RETENU' AND région du tronçon dans le périmètre ; en chaîne (BigInt).",
    colonnes: ["programmes_budgetaires.montantPrevuGnf", "programmes_budgetaires.statut", "programmes_budgetaires.tronconId", "troncons.regionId"],
    filtres: ["programmes_budgetaires.deletedAt IS NULL", "programmes_budgetaires.statut = 'RETENU'", "région du tronçon rattaché dans le périmètre (une ligne sans tronçon n'est pas communiquée à un compte régional)"],
    unite: "GNF",
    perimetre: { ...PERIMETRES.PREVISIONS_BUDGETAIRES },
    source: "Registre d'indicateurs du tableau de bord (« previsions_retenues_gnf » et « previsions_retenues_nb »), repris tels quels.",
    tablesSources: ["programmes_budgetaires", "troncons"],
    dateDefinition: DATE,
    miseAJour: RECALCUL,
    conditionsCalcul: ["Aucune prévision retenue : valeur null et « NON_DISPONIBLE ».", "Réservé aux comptes ayant le module « programmation »."],
    limites: ["Toutes années confondues : le registre ne filtre pas par année."],
    reglesExclusion: ["Lignes supprimées ; statuts PROPOSE, REPORTE, ANNULE, REALISE."],
    responsableMetier: DF,
    statutDefinition: "PROVISOIRE",
    decisionsOuvertes: ["Année ou horizon de programmation à présenter.", DECISION_B08],
  },
  {
    code: "budget_contractuel_par_bailleur_gnf",
    libelle: "Budget contractuel par bailleur",
    definition: "Montant contractuel des marchés par bailleur, selon la clé étrangère marches.bailleurId vers bailleurs. Jamais par le texte libre de chantiers.bailleur.",
    formule: "Pour chaque bailleur : Σ marches.montantTotal (devise GNF) et nombre de marchés ; décaissé = Σ decomptes PAYE du même groupe ; limité aux N plus gros contractuels (N = limiteBailleurs), le reste agrégé et dit.",
    colonnes: ["marches.bailleurId", "marches.montantTotal", "marches.devise", "bailleurs.nom", "decomptes.montantGnf", "decomptes.statut"],
    filtres: ["mêmes que « budget_contractuel_gnf »"],
    unite: "GNF",
    perimetre: { code: "MARCHES_SAISIS", libelle: "Marchés saisis", definition: "Lignes de la table marches non supprimées." },
    source: "Tables marches, bailleurs, decomptes (saisie applicative).",
    tablesSources: ["marches", "bailleurs", "decomptes"],
    dateDefinition: DATE,
    miseAJour: RECALCUL,
    conditionsCalcul: ["Si le nombre de bailleurs dépasse la limite, la réponse dit « tronqué », le total et les montants agrégés des autres bailleurs."],
    limites: ["Le bailleur n'existe sous forme structurée que sur les marchés ; les chantiers et les programmes budgétaires le portent en texte libre et ne sont pas ventilés ici."],
    reglesExclusion: ["Marchés sans bailleur : groupe « bailleur non renseigné » ; marchés en devise étrangère exclus de la somme GNF."],
    responsableMetier: DF,
    statutDefinition: "PROVISOIRE",
    decisionsOuvertes: ["Unité du bailleur (texte libre sur les chantiers, clé étrangère sur les marchés)."],
  },
  {
    code: "marches_recenses",
    libelle: "Marchés recensés",
    definition: "Nombre de lignes de la table marches non supprimées dans le périmètre. Un marché recensé n'est ni actif ni validé.",
    formule: "COUNT(marches) WHERE deletedAt IS NULL AND dans le périmètre (mêmes règles que « budget_contractuel_gnf »).",
    colonnes: ["marches.deletedAt", "marches_chantiers.chantierId", "chantiers.regionId"],
    filtres: ["marches.deletedAt IS NULL", "compte régional : marchés dont tous les chantiers non supprimés sont dans le périmètre (au moins un)"],
    unite: "nombre",
    perimetre: { code: "MARCHES_SAISIS", libelle: "Marchés saisis", definition: "Lignes de la table marches non supprimées. Les marchés recensés ne sont pas les marchés actifs." },
    source: "Table marches (saisie applicative). La chaîne héritée comptait des chantiers sous ce nom.",
    tablesSources: ["marches", "marches_chantiers", "chantiers"],
    dateDefinition: DATE,
    miseAJour: RECALCUL,
    conditionsCalcul: ["Aucun marché dans le périmètre : valeur null et « NON_DISPONIBLE » (la base locale n'est pas la source de référence)."],
    limites: ["Compte régional : valeur « PARTIEL » (marchés sans chantier ou à cheval sur plusieurs régions non communiqués)."],
    reglesExclusion: ["Marchés supprimés."],
    responsableMetier: DF,
    statutDefinition: "PROVISOIRE",
    decisionsOuvertes: ["Définition d'un marché actif (statut, dates, source contractuelle)."],
  },
  {
    code: "donnees_a_confirmer",
    libelle: "Données à confirmer",
    definition: "Nombre d'éléments de qualité à confirmer dans le périmètre : tronçons non évalués plus anomalies relevées par les détecteurs de qualité, sans compter deux fois celles qui disent « non évalué ».",
    formule: "(tronçons du périmètre au NON_EVALUE ou sans état) + Σ nombre d'anomalies par code, hors ETAT_NON_EVALUE, ETAT_ABSENT et ETAT_INCONNU ; un tronçon portant plusieurs anomalies compte plusieurs fois.",
    colonnes: ["troncons.etat", "résultats des détecteurs de qualité (backend/src/qualite, lecture seule)"],
    filtres: [...FILTRES_RESEAU, "détecteurs exécutés avec reseau « reference »"],
    unite: "elements",
    perimetre: RESEAU,
    source: "Détecteurs de qualité (26 codes, seuils provisoires) et bilan d'état du réseau.",
    tablesSources: ["troncons", "valeurs_qualite", "limites_admin"],
    dateDefinition: DATE,
    miseAJour: RECALCUL,
    conditionsCalcul: [
      "Aucun tronçon dans le périmètre : « NON_DISPONIBLE ».",
      "Dans la SYNTHESE, seules les familles PK, LONGUEUR, GEOMETRIE et ETAT des détecteurs sont exécutées (un seul passage borné) : REGION (intersection avec les limites administratives) et DOUBLON (auto-jointure spatiale) coûtent un balayage entier, réservées à GET /qualite qui exécute les six familles. Le nombre de la synthèse est donc une borne basse, état « PARTIEL », et peut être inférieur à `donneesAConfirmer.valeur` de /qualite.",
      "État « PARTIEL » aussi quand une famille demandée n'a pas pu être exécutée (par exemple REGION sans limite administrative en base).",
    ],
    limites: [
      "Nombre d'éléments, pas de tronçons distincts.",
      "Les détecteurs ne couvrent pas les contradictions inter-sources, la source ou la date de mesure absentes, les associations marché-chantier ambiguës : voir la liste « nonCouvert » de la qualité.",
    ],
    reglesExclusion: ["Tronçons supprimés, voirie promue, hors territoire ; codes ETAT_NON_EVALUE, ETAT_ABSENT, ETAT_INCONNU (déjà comptés comme non évalués)."],
    responsableMetier: DT,
    statutDefinition: "PROVISOIRE",
    decisionsOuvertes: ["Ce qui doit compter comme « à confirmer » (cahier 9.2) et les seuils des détecteurs (provisoires)."],
  },
];

const INDEX = new Map(DICTIONNAIRE.map((e) => [e.code, e]));

/** L'entree d'un indicateur ; lève si elle manque (un indicateur rendu sans définition est un défaut de code, pas un cas d'usage). */
export function entree(code: string): EntreeDictionnaire {
  const e = INDEX.get(code);
  if (!e) throw new Error(`indicateur sans entree de dictionnaire : ${code}`);
  return e;
}

export interface ReponseDictionnaire {
  version: string;
  genereLe: string;
  statutDefinition: "PROVISOIRE";
  mention: string;
  parametres: {
    version: string;
    statutDefinition: "PROVISOIRE" | "VALIDEE";
    classesDegradees: readonly string[];
    classesCritiques: readonly string[];
    exigenceEtat: string;
    regleEtatValide: string;
    limiteBailleurs: number;
    origine: string;
  };
  indicateurs: readonly EntreeDictionnaire[];
}

export function reponseDictionnaire(maintenant: Date): ReponseDictionnaire {
  return {
    version: PARAMETRES_KPI.version,
    genereLe: maintenant.toISOString(),
    statutDefinition: "PROVISOIRE",
    mention: "Définitions PROVISOIRES, non validées par AGEROUTE : à confirmer par la Direction technique et la Direction financière. Indicateurs consultatifs, non engageants.",
    parametres: {
      version: PARAMETRES_KPI.version,
      statutDefinition: PARAMETRES_KPI.statutDefinition,
      classesDegradees: PARAMETRES_KPI.classesDegradees,
      classesCritiques: PARAMETRES_KPI.classesCritiques,
      exigenceEtat: PARAMETRES_KPI.exigenceEtat,
      regleEtatValide: REGLE_ETAT_VALIDE,
      limiteBailleurs: PARAMETRES_KPI.limiteBailleurs,
      origine: PARAMETRES_KPI.origine,
    },
    indicateurs: DICTIONNAIRE,
  };
}
