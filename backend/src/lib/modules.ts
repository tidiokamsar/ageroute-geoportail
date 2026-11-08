// Liste canonique des modules configurables individuellement par utilisateur (en plus
// du rôle). Les clés doivent rester synchronisées avec le frontend (src/lib/modules.ts).
// "utilisateurs" et "administration" ne figurent pas ici : ils restent strictement
// réservés au rôle ADMIN, sans dérogation possible.
export const MODULE_KEYS = [
  "dashboard", "geoportail", "alertes", "rapports",
  "troncons", "ouvrages", "points-noirs", "postes",
  "chantiers", "programmation", "marches", "inspections",
  "documents", "decision", "ordres-travaux", "signalements",
  // Observation de la Terre (Lot 1 EO, contrat §2). L'attribution de cette cle a un compte est un geste d'administration :
  // aucune migration de donnees ne l'octroie (un compte non ADMIN sans la cle recoit 403).
  "teledetection",
  // Projets de voirie et reseaux (contrat docs/projets-voirie/CONTRAT.md) : tracés d'infrastructure de tiers, donnees sensibles.
  // Comme `teledetection`, aucune migration ne l'octroie et aucun profil metier ne la porte : c'est un geste d'administration.
  "projets-voirie",
] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];
