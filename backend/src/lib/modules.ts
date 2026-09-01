// Liste canonique des modules configurables individuellement par utilisateur (en plus
// du rôle). Les clés doivent rester synchronisées avec le frontend (src/lib/modules.ts).
// "utilisateurs" et "administration" ne figurent pas ici : ils restent strictement
// réservés au rôle ADMIN, sans dérogation possible.
export const MODULE_KEYS = [
  "dashboard", "geoportail", "alertes", "rapports",
  "troncons", "ouvrages", "points-noirs", "postes",
  "chantiers", "programmation", "marches", "inspections",
  "documents", "decision", "ordres-travaux", "signalements",
] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];
