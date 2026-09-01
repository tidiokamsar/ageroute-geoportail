// Configurations de champs partagees entre les pages module (EntityListPage) et la fiche
// tronçon consolidee (TronconFicheModal). Isolees ici pour eviter une dependance circulaire
// (TronconFicheModal a besoin des champs de chaque module, et les pages module importent
// TronconFicheModal pour le bouton "Fiche").
import type { FieldConfig } from "../components/EntityForm";

export const tronconFields: FieldConfig[] = [
  { name: "code", label: "Code", type: "text", required: true },
  { name: "nom", label: "Nom", type: "text", required: true },
  {
    name: "classe",
    label: "Classe",
    type: "select",
    required: true,
    options: [
      { value: "RN", label: "Route Nationale" },
      { value: "RR", label: "Route Préfectorale" },
      { value: "RU", label: "Voirie Urbaine" },
      { value: "PISTE", label: "Piste Rurale" },
    ],
  },
  { name: "regionId", label: "Région", type: "region", required: true },
  { name: "longueurKm", label: "Longueur (km)", type: "number", required: true },
  {
    name: "revetement",
    label: "Revêtement",
    type: "select",
    required: true,
    options: [
      { value: "BITUME", label: "Bitume" },
      { value: "TERRE", label: "Terre" },
      { value: "LATERITE", label: "Latérite" },
      { value: "PAVE", label: "Pavé" },
    ],
  },
  {
    name: "etat",
    label: "État",
    type: "select",
    options: [
      { value: "BON", label: "Bon" },
      { value: "MOYEN", label: "Moyen" },
      { value: "MAUVAIS", label: "Mauvais" },
      { value: "CRITIQUE", label: "Critique" },
      { value: "NON_EVALUE", label: "Non évalué" },
    ],
  },
  { name: "pkDebut", label: "PK début", type: "number", required: true },
  { name: "pkFin", label: "PK fin", type: "number", required: true },
  { name: "traficMoyenJma", label: "Trafic moyen (j/ma)", type: "number" },
];

export const ouvrageTypeOptions = [
  { value: "PONT", label: "Pont" },
  { value: "DALOT", label: "Dalot" },
  { value: "BUSE", label: "Buse" },
  { value: "RADIER", label: "Radier" },
  { value: "PONCEAU", label: "Ponceau" },
  { value: "MUR_SOUTENEMENT", label: "Mur de soutènement" },
  { value: "TUNNEL", label: "Tunnel" },
  { value: "PASSERELLE", label: "Passerelle" },
  { value: "VIADUC", label: "Viaduc" },
];

export const ouvrageFields: FieldConfig[] = [
  { name: "nom", label: "Nom", type: "text", required: true },
  { name: "type", label: "Type", type: "select", required: true, options: ouvrageTypeOptions },
  { name: "regionId", label: "Région", type: "region", required: true },
  { name: "tronconId", label: "Tronçon rattaché", type: "troncon" },
  {
    name: "etat",
    label: "État",
    type: "select",
    options: [
      { value: "BON", label: "Bon" },
      { value: "MOYEN", label: "Moyen" },
      { value: "MAUVAIS", label: "Mauvais" },
      { value: "CRITIQUE", label: "Critique" },
      { value: "NON_EVALUE", label: "Non évalué" },
    ],
  },
  { name: "pk", label: "PK", type: "number" },
  { name: "ficheNumero", label: "N° fiche (mission terrain)", type: "text" },
  { name: "code", label: "Code", type: "text" },
  { name: "longueurM", label: "Longueur L (m)", type: "number" },
  { name: "largeurM", label: "Largeur B (m)", type: "number" },
  { name: "hauteurM", label: "Hauteur H (m)", type: "number" },
  { name: "nbTravees", label: "Nombre de travées", type: "number" },
  { name: "longueurTravee", label: "Longueur travée (m)", type: "number" },
  { name: "gabaritT", label: "Gabarit (t)", type: "number" },
  { name: "anneeConstruction", label: "Année de construction", type: "number" },
  { name: "materiau", label: "Matériau (général)", type: "text" },
  { name: "materiauAppuis", label: "Matériau appuis/murs", type: "text" },
  { name: "materiauTablier", label: "Matériau tablier", type: "text" },
  { name: "materiauPiles", label: "Matériau piles", type: "text" },
  { name: "materiauAutre", label: "Matériau autre", type: "text" },
  { name: "remarques", label: "Remarques particulières", type: "text" },
  { name: "travauxAPrevoir", label: "Travaux / réparations à prévoir", type: "text" },
  { name: "derniereInspectionDate", label: "Date de dernière inspection", type: "date" },
  { name: "position", label: "Position sur la carte", type: "point" },
];

export const pointNoirFields: FieldConfig[] = [
  { name: "description", label: "Description", type: "text", required: true },
  { name: "regionId", label: "Région", type: "region", required: true },
  { name: "tronconId", label: "Tronçon rattaché", type: "troncon" },
  { name: "pk", label: "PK", type: "number" },
  {
    name: "gravite",
    label: "Gravité",
    type: "select",
    required: true,
    options: [
      { value: "FAIBLE", label: "Faible" },
      { value: "MOYENNE", label: "Moyenne" },
      { value: "FORTE", label: "Forte" },
    ],
  },
  { name: "nbAccidents", label: "Nombre d'accidents", type: "number" },
  { name: "causes", label: "Causes", type: "text" },
  { name: "mesuresCorrectives", label: "Mesures correctives", type: "text" },
  { name: "position", label: "Position sur la carte", type: "point" },
];

export const posteFields: FieldConfig[] = [
  { name: "nom", label: "Nom", type: "text", required: true },
  {
    name: "type",
    label: "Type",
    type: "select",
    required: true,
    options: [
      { value: "PEAGE", label: "Péage" },
      { value: "PESAGE", label: "Pesage" },
    ],
  },
  { name: "regionId", label: "Région", type: "region", required: true },
  { name: "tronconId", label: "Tronçon rattaché", type: "troncon" },
  { name: "pk", label: "PK", type: "number" },
  {
    name: "statut",
    label: "Statut",
    type: "select",
    options: [
      { value: "EN_SERVICE", label: "En service" },
      { value: "HORS_SERVICE", label: "Hors service" },
      { value: "EN_CONSTRUCTION", label: "En construction" },
    ],
  },
  { name: "traficJma", label: "Trafic moyen (j/ma)", type: "number" },
  { name: "recettesMensuellesGnf", label: "Recettes mensuelles (GNF)", type: "number" },
  { name: "position", label: "Position sur la carte", type: "point" },
];

export const chantierFields: FieldConfig[] = [
  { name: "intitule", label: "Intitulé", type: "text", required: true },
  { name: "entreprise", label: "Entreprise", type: "text", required: true },
  { name: "bailleur", label: "Bailleur", type: "text" },
  { name: "regionId", label: "Région", type: "region", required: true },
  {
    name: "statut",
    label: "Statut",
    type: "select",
    options: [
      { value: "PLANIFIE", label: "Planifié" },
      { value: "EN_COURS", label: "En cours" },
      { value: "SUSPENDU", label: "Suspendu" },
      { value: "TERMINE", label: "Terminé" },
    ],
  },
  { name: "avancementPct", label: "Avancement (%)", type: "number" },
  { name: "dateDebutPrevue", label: "Date de début prévue", type: "date" },
  { name: "dateFinPrevue", label: "Date de fin prévue", type: "date" },
  { name: "dateDebutReelle", label: "Date de début réelle", type: "date" },
  { name: "dateFinReelle", label: "Date de fin réelle", type: "date" },
  { name: "montantGnf", label: "Montant (GNF)", type: "number" },
  { name: "tronconId", label: "Tronçon concerné (le tracé suivra la route)", type: "troncon" },
  { name: "pkDebut", label: "PK début", type: "number" },
  { name: "pkFin", label: "PK fin", type: "number" },
  { name: "numContrat", label: "N° contrat", type: "text" },
  { name: "observations", label: "Observations", type: "text" },
];

export const marcheFields: FieldConfig[] = [
  { name: "intitule", label: "Intitulé du marché", type: "text", required: true },
  { name: "bailleurId", label: "Bailleur", type: "bailleur" },
  { name: "montantTotal", label: "Montant total", type: "number" },
  {
    name: "devise",
    label: "Devise",
    type: "select",
    options: [
      { value: "GNF", label: "GNF" },
      { value: "USD", label: "USD" },
      { value: "EUR", label: "EUR" },
    ],
  },
  {
    name: "statut",
    label: "Statut",
    type: "select",
    options: [
      { value: "PLANIFIE", label: "Planifié" },
      { value: "EN_COURS", label: "En cours" },
      { value: "SUSPENDU", label: "Suspendu" },
      { value: "TERMINE", label: "Terminé" },
      { value: "SOLDE", label: "Soldé" },
    ],
  },
  { name: "dateSignature", label: "Date de signature", type: "date" },
  { name: "dateDebutPrevue", label: "Date de début prévue", type: "date" },
  { name: "dateFinPrevue", label: "Date de fin prévue", type: "date" },
  { name: "dateReceptionProvisoire", label: "Date de réception provisoire", type: "date" },
  { name: "garantieBonneExecutionExp", label: "Expiration garantie de bonne exécution", type: "date" },
  { name: "tauxPenaliteRetardPct", label: "Taux de pénalité de retard (%/jour)", type: "number" },
];

export const inspectionFields: FieldConfig[] = [
  { name: "tronconId", label: "Tronçon inspecté", type: "troncon" },
  { name: "ouvrageId", label: "Ouvrage inspecté (optionnel)", type: "ouvrage" },
  { name: "dateInspection", label: "Date d'inspection", type: "date", required: true },
  {
    name: "etatObserve",
    label: "État observé",
    type: "select",
    required: true,
    options: [
      { value: "BON", label: "Bon" },
      { value: "MOYEN", label: "Moyen" },
      { value: "MAUVAIS", label: "Mauvais" },
      { value: "CRITIQUE", label: "Critique" },
      { value: "NON_EVALUE", label: "Non évalué" },
    ],
  },
  { name: "defautsConstates", label: "Défauts constatés", type: "text" },
  { name: "recommandations", label: "Recommandations", type: "text" },
];

export const otFields: FieldConfig[] = [
  { name: "titre", label: "Titre", type: "text", required: true },
  {
    name: "typeIntervention",
    label: "Type d'intervention",
    type: "select",
    required: true,
    options: [
      { value: "REPARATION_CHAUSSEE", label: "Réparation chaussée" },
      { value: "CURAGE_ASSAINISSEMENT", label: "Curage assainissement" },
      { value: "SIGNALISATION", label: "Signalisation" },
      { value: "DEBROUSSAILLAGE", label: "Débroussaillage" },
      { value: "OUVRAGE_ART_MINEUR", label: "Ouvrage d'art mineur" },
      { value: "URGENCE_SECURITE", label: "Urgence sécurité" },
      { value: "AUTRE", label: "Autre" },
    ],
  },
  {
    name: "priorite",
    label: "Priorité",
    type: "select",
    options: [
      { value: "URGENTE", label: "Urgente" },
      { value: "HAUTE", label: "Haute" },
      { value: "NORMALE", label: "Normale" },
      { value: "BASSE", label: "Basse" },
    ],
  },
  { name: "regionId", label: "Région", type: "region" },
  { name: "tronconId", label: "Tronçon concerné", type: "troncon" },
  { name: "ouvrageId", label: "Ouvrage concerné (optionnel)", type: "ouvrage" },
  { name: "coutEstimeGnf", label: "Coût estimé (GNF)", type: "number" },
  { name: "entreprise", label: "Entreprise sous-traitante (optionnel)", type: "text" },
  { name: "dateEcheance", label: "Date d'échéance", type: "date" },
  { name: "description", label: "Description", type: "text" },
];
