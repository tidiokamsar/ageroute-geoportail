/**
 * LE CATALOGUE DES TYPES DE DEFAUT, comme donnee de reference. AUCUN IMPORT.
 *
 * Deux sources, et chacune est dite :
 *
 *   `cahier_des_charges_rai_v3_1_7_2`   les treize types d'origine, semes en production
 *   `mandat_v10_7_4`                    les types que le paragraphe 7.4 du prompt maitre V10
 *                                       ajoute, « adapte par type de revetement »
 *
 * Le paragraphe 7.16 fixe le plancher : « catalogue configurable (>= 21 types, revetu /
 * non revetu) ». Ce fichier en porte trente et un. Rien n'y est invente : chaque type du
 * second lot est nomme par le paragraphe 7.4, et seule sa METRIQUE (unite, mesures requises)
 * est un choix de premier remplissage -- modifiable dans l'administration, comme pour les treize
 * premiers, et pour la meme raison : le script de peuplement ne corrige jamais une ligne
 * existante.
 *
 * POURQUOI CE N'EST PAS UNE MIGRATION
 *
 * La base de developpement, construite depuis les 58 migrations, a ZERO ligne dans
 * `catalogue_defauts` : les treize types de production viennent du script
 * `peupler-catalogue-defauts.ts`, idempotent, qui cree les absents et ne touche pas aux
 * presents. Le catalogue est une donnee metier administrable, pas une donnee d'infrastructure ;
 * semer par migration reconstruirait a chaque `migrate reset` ce que l'administration a retenu.
 * Les dix-huit nouveaux types suivent donc le meme chemin.
 *
 * APPLICABILITE : REVETU, NON_REVETU ou TOUS. C'est l'etoile du paragraphe 7.16 -- en Guinee la
 * majorite du reseau n'est pas revetue, et une tole ondulee sur une chaussee bitumee est une
 * erreur de saisie que le catalogue doit permettre de refuser.
 */

export type FamilleDefaut = "CHAUSSEE" | "ACCOTEMENT" | "ASSAINISSEMENT" | "OUVRAGE" | "SIGNALISATION" | "SECURITE" | "ENVIRONNEMENT";
export type UniteDefaut = "UNITE" | "METRE" | "METRE_CARRE" | "METRE_CUBE";
export type MesureDefaut = "NOMBRE" | "LONGUEUR" | "LARGEUR" | "PROFONDEUR";
export type Applicabilite = "REVETU" | "NON_REVETU" | "TOUS";

export interface TypeDefautReference {
  code: string;
  libelle: string;
  famille: FamilleDefaut;
  unite: UniteDefaut;
  mesuresRequises: MesureDefaut[];
  graviteMax: number | null;
  applicabilite: Applicabilite;
  description: string;
  source: string;
  /** Code du type parent, pour les declinaisons (drainage : obstruction, stagnation...). */
  parentCode?: string;
}

export const SOURCE_RAI = "cahier_des_charges_rai_v3_1_7_2";
export const SOURCE_V10 = "mandat_v10_7_4";

/** Les treize types d'origine, repris tels quels. Ne pas modifier : ils sont en production. */
const TYPES_RAI: TypeDefautReference[] = [
  { code: "NID_POULE", libelle: "Nid-de-poule", famille: "CHAUSSEE", unite: "METRE_CARRE", mesuresRequises: ["LONGUEUR", "LARGEUR", "PROFONDEUR"], graviteMax: 4, applicabilite: "TOUS", source: SOURCE_RAI,
    description: "Trou dans la chaussee. Metre surfacique (longueur x largeur) ; la profondeur qualifie la gravite." },
  { code: "FISS_LONG", libelle: "Fissure longitudinale", famille: "CHAUSSEE", unite: "METRE", mesuresRequises: ["LONGUEUR"], graviteMax: 4, applicabilite: "REVETU", source: SOURCE_RAI,
    description: "Fissure parallele a l'axe de la chaussee. Metre lineaire." },
  { code: "FISS_TRANS", libelle: "Fissure transversale", famille: "CHAUSSEE", unite: "METRE", mesuresRequises: ["LONGUEUR"], graviteMax: 4, applicabilite: "REVETU", source: SOURCE_RAI,
    description: "Fissure perpendiculaire a l'axe de la chaussee. Metre lineaire." },
  { code: "FAIENCAGE", libelle: "Faïençage", famille: "CHAUSSEE", unite: "METRE_CARRE", mesuresRequises: ["LONGUEUR", "LARGEUR"], graviteMax: 4, applicabilite: "REVETU", source: SOURCE_RAI,
    description: "Reseau de fissures superficielles en peau de crocodile. Metre surfacique." },
  { code: "ORNIERAGE", libelle: "Orniérage", famille: "CHAUSSEE", unite: "METRE", mesuresRequises: ["LONGUEUR", "PROFONDEUR"], graviteMax: 4, applicabilite: "TOUS", source: SOURCE_RAI,
    description: "Deformation de la chaussee en rigoles de roulement. Metre lineaire ; la profondeur, exigee au releve, qualifie la gravite sans entrer dans le metre." },
  { code: "AFFAISSEMENT", libelle: "Affaissement", famille: "CHAUSSEE", unite: "METRE_CUBE", mesuresRequises: ["LONGUEUR", "LARGEUR", "PROFONDEUR"], graviteMax: 4, applicabilite: "TOUS", source: SOURCE_RAI,
    description: "Tassement localise de la structure. Metre volumique." },
  { code: "RAVINEMENT", libelle: "Ravinement", famille: "ACCOTEMENT", unite: "METRE_CUBE", mesuresRequises: ["LONGUEUR", "LARGEUR", "PROFONDEUR"], graviteMax: 4, applicabilite: "TOUS", source: SOURCE_RAI,
    description: "Erosion hydrique creusant accotements et talus. Metre volumique. Famille provisoire (ACCOTEMENT), a trancher par l'administration." },
  { code: "ARRACHEMENT", libelle: "Arrachement", famille: "CHAUSSEE", unite: "METRE_CARRE", mesuresRequises: ["LONGUEUR", "LARGEUR"], graviteMax: 4, applicabilite: "REVETU", source: SOURCE_RAI,
    description: "Perte de revetement par plaques. Metre surfacique." },
  { code: "DEFORMATION", libelle: "Déformation", famille: "CHAUSSEE", unite: "METRE_CARRE", mesuresRequises: ["LONGUEUR", "LARGEUR"], graviteMax: 4, applicabilite: "TOUS", source: SOURCE_RAI,
    description: "Ondulation ou bourrelet sans perte de matiere. Metre surfacique." },
  { code: "DRAINAGE", libelle: "Dégradation drainage", famille: "ASSAINISSEMENT", unite: "METRE", mesuresRequises: ["LONGUEUR"], graviteMax: 4, applicabilite: "TOUS", source: SOURCE_RAI,
    description: "Fosse, caniveau ou exutoire degrades ou obstrues. Metre lineaire ; le cahier des charges admet aussi un releve en quantite." },
  { code: "ACCOTEMENT", libelle: "Dégradation accotement", famille: "ACCOTEMENT", unite: "METRE_CARRE", mesuresRequises: ["LONGUEUR", "LARGEUR"], graviteMax: 4, applicabilite: "TOUS", source: SOURCE_RAI,
    description: "Degradation de la bande laterale non roulee. Metre surfacique." },
  { code: "SIGNALISATION", libelle: "Signalisation dégradée", famille: "SIGNALISATION", unite: "UNITE", mesuresRequises: ["NOMBRE"], graviteMax: null, applicabilite: "TOUS", source: SOURCE_RAI,
    description: "Panneau, balise ou marquage degrade, illisible ou manquant. Comptage ; ne se gradue pas." },
  { code: "AUTRE", libelle: "Autre", famille: "ENVIRONNEMENT", unite: "UNITE", mesuresRequises: [], graviteMax: 4, applicabilite: "TOUS", source: SOURCE_RAI,
    description: "Type ouvert : aucune mesure exigee, la quantite reste nulle tant qu'un releve n'a pas ete saisi. A requalifier des que le type reel est connu." },
];

/** Les types que le paragraphe 7.4 du mandat V10 nomme, et que les treize ne couvraient pas. */
const TYPES_V10: TypeDefautReference[] = [
  // --- chaussee revetue ---
  { code: "RESSUAGE", libelle: "Ressuage", famille: "CHAUSSEE", unite: "METRE_CARRE", mesuresRequises: ["LONGUEUR", "LARGEUR"], graviteMax: 4, applicabilite: "REVETU", source: SOURCE_V10,
    description: "Remontee du liant en surface, chaussee luisante et glissante. Metre surfacique. (§ 7.4, chaussee revetue)" },
  { code: "DESENROBAGE", libelle: "Désenrobage", famille: "CHAUSSEE", unite: "METRE_CARRE", mesuresRequises: ["LONGUEUR", "LARGEUR"], graviteMax: 4, applicabilite: "REVETU", source: SOURCE_V10,
    description: "Perte du liant laissant les granulats a nu, distincte de l'arrachement par plaques. Metre surfacique. (§ 7.4)" },
  { code: "NID_RIVE", libelle: "Nids-de-poule sur rives", famille: "CHAUSSEE", unite: "METRE_CARRE", mesuresRequises: ["LONGUEUR", "LARGEUR", "PROFONDEUR"], graviteMax: 4, applicabilite: "REVETU", source: SOURCE_V10,
    description: "Nids-de-poule en bord de chaussee, signe d'un epaulement defaillant. Metre surfacique ; la profondeur qualifie la gravite. (§ 7.4)" },
  // --- route en terre / laterite ---
  { code: "TOLE_ONDULEE", libelle: "Tôle ondulée", famille: "CHAUSSEE", unite: "METRE", mesuresRequises: ["LONGUEUR"], graviteMax: 4, applicabilite: "NON_REVETU", source: SOURCE_V10,
    description: "Ondulations transversales rapprochees d'une route en terre. Metre lineaire. (§ 7.4, route en terre/laterite)" },
  { code: "PERTE_MATERIAUX", libelle: "Perte de matériaux", famille: "CHAUSSEE", unite: "METRE_CUBE", mesuresRequises: ["LONGUEUR", "LARGEUR", "PROFONDEUR"], graviteMax: 4, applicabilite: "NON_REVETU", source: SOURCE_V10,
    description: "Amincissement de la couche de roulement par depart de materiaux. Metre volumique. (§ 7.4)" },
  { code: "BOURBIER", libelle: "Bourbier", famille: "CHAUSSEE", unite: "METRE_CARRE", mesuresRequises: ["LONGUEUR", "LARGEUR"], graviteMax: 4, applicabilite: "NON_REVETU", source: SOURCE_V10,
    description: "Zone de chaussee detrempee ou la circulation s'enlise. Metre surfacique. (§ 7.4)" },
  { code: "EROSION", libelle: "Érosion", famille: "CHAUSSEE", unite: "METRE_CUBE", mesuresRequises: ["LONGUEUR", "LARGEUR", "PROFONDEUR"], graviteMax: 4, applicabilite: "NON_REVETU", source: SOURCE_V10,
    description: "Erosion de la plateforme par les eaux de ruissellement, distincte du ravinement des accotements. Metre volumique. (§ 7.4)" },
  { code: "POUSSIERE", libelle: "Poussière excessive", famille: "ENVIRONNEMENT", unite: "METRE", mesuresRequises: ["LONGUEUR"], graviteMax: 3, applicabilite: "NON_REVETU", source: SOURCE_V10,
    description: "Emission de poussiere genant la visibilite et les riverains. Metre lineaire. (§ 7.4)" },
  { code: "TETES_DE_CHAT", libelle: "Têtes de chat", famille: "CHAUSSEE", unite: "METRE_CARRE", mesuresRequises: ["LONGUEUR", "LARGEUR"], graviteMax: 4, applicabilite: "NON_REVETU", source: SOURCE_V10,
    description: "Gros elements affleurant par depart des fines. Metre surfacique. (§ 7.4)" },
  // --- drainage, declinaisons du type DRAINAGE existant ---
  { code: "DRAINAGE_OBSTRUCTION", libelle: "Drainage obstrué", famille: "ASSAINISSEMENT", unite: "METRE", mesuresRequises: ["LONGUEUR"], graviteMax: 4, applicabilite: "TOUS", source: SOURCE_V10, parentCode: "DRAINAGE",
    description: "Fosse, caniveau ou ouvrage de drainage obstrue. Metre lineaire. (§ 7.4, drainage)" },
  { code: "DRAINAGE_STAGNATION", libelle: "Stagnation d'eau", famille: "ASSAINISSEMENT", unite: "METRE_CARRE", mesuresRequises: ["LONGUEUR", "LARGEUR"], graviteMax: 4, applicabilite: "TOUS", source: SOURCE_V10, parentCode: "DRAINAGE",
    description: "Eau stagnante sur ou le long de la chaussee. Metre surfacique. (§ 7.4)" },
  { code: "DRAINAGE_INONDATION", libelle: "Inondation", famille: "ASSAINISSEMENT", unite: "METRE", mesuresRequises: ["LONGUEUR"], graviteMax: 4, applicabilite: "TOUS", source: SOURCE_V10, parentCode: "DRAINAGE",
    description: "Submersion de la chaussee. Metre lineaire. (§ 7.4)" },
  { code: "DRAINAGE_AFFOUILLEMENT", libelle: "Affouillement", famille: "ASSAINISSEMENT", unite: "METRE_CUBE", mesuresRequises: ["LONGUEUR", "LARGEUR", "PROFONDEUR"], graviteMax: 4, applicabilite: "TOUS", source: SOURCE_V10, parentCode: "DRAINAGE",
    description: "Creusement par l'eau au pied d'un remblai ou d'un ouvrage. Metre volumique. (§ 7.4)" },
  // --- ouvrages ---
  { code: "OUVRAGE_DEGRADE", libelle: "Dégradation d'ouvrage", famille: "OUVRAGE", unite: "UNITE", mesuresRequises: ["NOMBRE"], graviteMax: 4, applicabilite: "TOUS", source: SOURCE_V10,
    description: "Degradation constatee sur un ouvrage d'art ou hydraulique, a rattacher a l'ouvrage. Comptage. (§ 7.4, ouvrages)" },
  // --- equipements ---
  { code: "GLISSIERE", libelle: "Glissière dégradée", famille: "SECURITE", unite: "METRE", mesuresRequises: ["LONGUEUR"], graviteMax: null, applicabilite: "TOUS", source: SOURCE_V10,
    description: "Glissiere de securite deformee, manquante ou arrachee. Metre lineaire ; ne se gradue pas. (§ 7.4, equipements)" },
  { code: "MARQUAGE", libelle: "Marquage effacé", famille: "SIGNALISATION", unite: "METRE", mesuresRequises: ["LONGUEUR"], graviteMax: null, applicabilite: "REVETU", source: SOURCE_V10,
    description: "Marquage au sol efface ou illisible. Metre lineaire ; ne se gradue pas. (§ 7.4)" },
  { code: "ECLAIRAGE", libelle: "Éclairage défaillant", famille: "SECURITE", unite: "UNITE", mesuresRequises: ["NOMBRE"], graviteMax: null, applicabilite: "TOUS", source: SOURCE_V10,
    description: "Point lumineux hors service ou absent. Comptage ; ne se gradue pas. (§ 7.4)" },
  { code: "BORNE", libelle: "Borne manquante ou dégradée", famille: "SIGNALISATION", unite: "UNITE", mesuresRequises: ["NOMBRE"], graviteMax: null, applicabilite: "TOUS", source: SOURCE_V10,
    description: "Borne kilometrique ou de reperage manquante, deplacee ou illisible. Comptage ; ne se gradue pas. (§ 7.4)" },
];

export const TYPES_DEFAUT: readonly TypeDefautReference[] = [...TYPES_RAI, ...TYPES_V10];

/** Mesures qu'une unite impose au minimum. Un metre surfacique sans largeur n'en est pas un. */
export const MESURES_PAR_UNITE: Record<UniteDefaut, readonly MesureDefaut[]> = {
  UNITE: [],
  METRE: ["LONGUEUR"],
  METRE_CARRE: ["LONGUEUR", "LARGEUR"],
  METRE_CUBE: ["LONGUEUR", "LARGEUR", "PROFONDEUR"],
};
