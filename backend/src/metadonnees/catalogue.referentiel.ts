import type { FicheJeu } from "./iso19115.noyau";

/**
 * Les jeux de donnees que le service PUBLIC sert reellement, decrits pour ISO 19115.
 *
 * Chaque phrase de genealogie reprend un fait etabli ailleurs dans le depot (commentaires et
 * decisions cites en regard). Rien n'est ajoute pour « faire propre » : un jeu dont on ne sait pas
 * tout le dit, et `conditions: null` signifie que personne n'a arrete les conditions de
 * reutilisation (aucune licence n'est choisie dans les decisions du depot : elle reste a decider).
 *
 * N'y figurent PAS : les couches authentifiees (inspections, marches, etc.), qui ne sont pas
 * publiees ; l'Info Route publique, dont la forme n'est pas un jeu geographique.
 */

export const ACCES_CARTE_PUBLIQUE = "/api/public/carte/geo";

const GENEALOGIE_COMMUNE_CARTE =
  "Servi par la carte publique, qui n'expose qu'un apercu reduit (aucun montant, contrat, entreprise ni observation interne). " +
  "Le detail complet reste derriere l'authentification.";

export const CATALOGUE: readonly FicheJeu[] = [
  {
    id: "troncons",
    titre: "Reseau routier classe - troncons",
    resume:
      "Troncons du reseau routier classe de Guinee (identifiant, code, nom, classe, etat, region, longueur, trace). " +
      "Les traces sont des lignes en WGS 84.",
    motsCles: ["reseau routier", "troncons", "routes nationales", "Guinee", "AGEROUTE"],
    categorie: "transportation",
    acces: { chemin: ACCES_CARTE_PUBLIQUE, format: "JSON (geometries GeoJSON)", nom: "Carte publique du reseau" },
    genealogie:
      `${GENEALOGIE_COMMUNE_CARTE} ` +
      "Le trace servi est SIMPLIFIE selon le niveau de zoom demande (parametre zoom) : ce n'est pas la geometrie exacte en base en dessous du zoom 16. " +
      "La longueur du reseau annoncee est calculee sur la geometrie ; le champ longueurKm est la longueur contractuelle saisie et peut etre absent. " +
      "Quand l'etat d'un troncon provient d'une declaration et non d'un releve terrain, le champ etatDeclare le signale.",
    conditions: null,
    attribution: null,
  },
  {
    id: "ouvrages",
    titre: "Ouvrages d'art - inventaire AGEROUTE",
    resume: "Ouvrages d'art de l'inventaire d'AGEROUTE (identite, type, etat, position et rattachement au reseau : route, point kilometrique, region).",
    motsCles: ["ouvrages d'art", "ponts", "inventaire", "Guinee", "AGEROUTE"],
    categorie: "structure",
    acces: { chemin: ACCES_CARTE_PUBLIQUE, format: "JSON", nom: "Carte publique du reseau" },
    genealogie:
      `${GENEALOGIE_COMMUNE_CARTE} ` +
      "Les positions sont HERITEES (releve de 2016) et non verifiees sur le terrain ; certaines proviennent de documents de la DOA&A et sont marquees aValider. " +
      "Les franchissements repris d'une source cartographique externe (OpenStreetMap) sont des propositions : ils sont EXCLUS de ce jeu tant qu'ils ne sont pas valides.",
    conditions: null,
    attribution: null,
  },
  {
    id: "points-noirs",
    titre: "Points noirs de securite routiere",
    resume: "Localisation et gravite des points noirs identifies sur le reseau routier, par region.",
    motsCles: ["points noirs", "securite routiere", "Guinee", "AGEROUTE"],
    categorie: "transportation",
    acces: { chemin: ACCES_CARTE_PUBLIQUE, format: "JSON", nom: "Carte publique du reseau" },
    genealogie:
      `${GENEALOGIE_COMMUNE_CARTE} ` +
      "Seuls l'identifiant, la gravite, la region et la position sont publies.",
    conditions: null,
    attribution: null,
  },
  {
    id: "chantiers",
    titre: "Chantiers routiers",
    resume: "Chantiers sur le reseau routier (statut, avancement, region, trace ou position).",
    motsCles: ["chantiers", "travaux routiers", "avancement", "Guinee", "AGEROUTE"],
    categorie: "transportation",
    acces: { chemin: ACCES_CARTE_PUBLIQUE, format: "JSON (geometries GeoJSON)", nom: "Carte publique du reseau" },
    genealogie:
      `${GENEALOGIE_COMMUNE_CARTE} ` +
      "Le champ approximate signale un chantier dont la geometrie n'est qu'une localisation approchee. Aucun montant, entreprise ni bailleur n'est publie.",
    conditions: null,
    attribution: null,
  },
  {
    id: "voirie-locale",
    titre: "Voirie locale (OpenStreetMap)",
    resume: "Voirie locale hors reseau classe, issue d'OpenStreetMap, avec categorie, nature, statut et rattachement eventuel a un troncon du reseau classe.",
    motsCles: ["voirie locale", "OpenStreetMap", "routes", "Guinee"],
    categorie: "transportation",
    acces: {
      chemin: "/api/public/voirie-locale/geo",
      format: "JSON (geometries GeoJSON)",
      nom: "Voirie locale cadree par emprise (parametre bbox obligatoire)",
    },
    genealogie:
      "Donnee reprise d'OpenStreetMap, deja publique. Elle n'est jamais servie en entier : une emprise (bbox) est obligatoire et bornee, " +
      "le trace est simplifie selon la taille de l'emprise, et la reponse est tronquee au-dela d'un plafond d'objets en le signalant. " +
      "Ce n'est pas une donnee verifiee par AGEROUTE.",
    conditions: null,
    attribution: "Donnees OpenStreetMap, contributeurs OpenStreetMap, licence ODbL 1.0 (obligation d'attribution et de partage a l'identique).",
  },
];

export function trouverFiche(id: string): FicheJeu | undefined {
  return CATALOGUE.find((f) => f.id === id);
}
