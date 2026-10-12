/**
 * Peuple le catalogue des types de defaut avec les treize types du cahier des charges
 * RAI V3.1 (section 7.2). Idempotent : crée les types absents sans modifier les
 * lignes déjà administrées.
 *
 * POURQUOI CE SCRIPT ET PAS UN SEED PRISMA
 *
 * Le catalogue est une DONNEE METIER ADMINISTRABLE, pas une donnee d'infrastructure :
 * le cahier des charges exige qu'il soit administrable, et le champ `source` de chaque
 * ligne dit d'ou elle vient. Un seed Prisma se rejoue a chaque `prisma migrate reset`
 * et reconstruirait le catalogue en ecrasant ce que l'administration a retenu ; ce
 * script, lui, NE MODIFIE JAMAIS une ligne existante : si un gestionnaire a retire la
 * profondeur des mesures obligatoires du NID_POULE, rejouer ce script doit laisser sa
 * decision en place.
 *
 * CE QUE « MESURES POSSIBLES » DEVIENT ICI
 *
 * Le cahier des charges liste, par type, les mesures POSSIBLES. La table porte les
 * mesures REQUISES : c'est la premiere des quatre corrections retenues pour le modele
 * de defauts — un releve incomplet doit etre refuse en nommant ce qui manque, pendant
 * que l'agent est encore sur place. Le passage de « possible » a « requis » est une
 * decision de premier remplissage, pas une norme : chaque ligne reste modifiable dans
 * l'administration, et c'est precisement pour cela que ce script ne corrige jamais
 * une ligne existante.
 *
 * Deux choix de remplissage meritent d'etre dits :
 *
 *   - ORNIERAGE exige la PROFONDEUR bien que son metre reste lineaire : la profondeur
 *     qualifie la gravite, elle n'entre pas dans le metreur. L'exemple vient du cahier
 *     des charges lui-meme (mesures possibles : longueur, profondeur).
 *   - SIGNALISATION ne se gradue pas (graviteMax nul) : un panneau manquant est absent
 *     ou present. Le graduer remplirait un champ sans rien mesurer.
 *
 * LA FAMILLE DE RAVINEMENT EST PROVISOIRE
 *
 * Le ravinement erode les accotements et les talus ; il est classe ACCOTEMENT ici,
 * d'autres referentiels le mettent en ASSAINISSEMENT ou ENVIRONNEMENT. La ligne est
 * modifiable, et aucun defaut existant ne casse : la famille n'entre dans aucun
 * calcul, elle sert au regroupement dans l'administration.
 *
 * RETOUR ARRIERE
 *
 *     delete from catalogue_defaut where source = 'cahier_des_charges_rai_v3_1_7_2'
 *       and id not in (select "catalogueId" from defauts);
 *
 * La garde sur les defauts existants est necessaire : supprimer une ligne referencee
 * par un defaut violerait la cle etrangere, et un defaut sans ligne de catalogue
 * n'a plus ni unite ni mesures requises.
 */
import { FamilleDefaut, MesureDefaut, UniteDefaut } from "@prisma/client";
import { prisma } from "../src/lib/prisma";

interface TypeCatalogue {
  code: string;
  libelle: string;
  famille: FamilleDefaut;
  unite: UniteDefaut;
  mesuresRequises: MesureDefaut[];
  graviteMax: number | null;
  description: string;
}

const SOURCE = "cahier_des_charges_rai_v3_1_7_2";

const TYPES: TypeCatalogue[] = [
  {
    code: "NID_POULE",
    libelle: "Nid-de-poule",
    famille: FamilleDefaut.CHAUSSEE,
    unite: UniteDefaut.METRE_CARRE,
    mesuresRequises: [MesureDefaut.LONGUEUR, MesureDefaut.LARGEUR, MesureDefaut.PROFONDEUR],
    graviteMax: 4,
    description: "Trou dans la chaussee. Metre surfacique (longueur x largeur) ; la profondeur qualifie la gravite.",
  },
  {
    code: "FISS_LONG",
    libelle: "Fissure longitudinale",
    famille: FamilleDefaut.CHAUSSEE,
    unite: UniteDefaut.METRE,
    mesuresRequises: [MesureDefaut.LONGUEUR],
    graviteMax: 4,
    description: "Fissure parallele a l'axe de la chaussee. Metre lineaire.",
  },
  {
    code: "FISS_TRANS",
    libelle: "Fissure transversale",
    famille: FamilleDefaut.CHAUSSEE,
    unite: UniteDefaut.METRE,
    mesuresRequises: [MesureDefaut.LONGUEUR],
    graviteMax: 4,
    description: "Fissure perpendiculaire a l'axe de la chaussee. Metre lineaire.",
  },
  {
    code: "FAIENCAGE",
    libelle: "Faïençage",
    famille: FamilleDefaut.CHAUSSEE,
    unite: UniteDefaut.METRE_CARRE,
    mesuresRequises: [MesureDefaut.LONGUEUR, MesureDefaut.LARGEUR],
    graviteMax: 4,
    description: "Reseau de fissures superficielles en peau de crocodile. Metre surfacique.",
  },
  {
    code: "ORNIERAGE",
    libelle: "Orniérage",
    famille: FamilleDefaut.CHAUSSEE,
    unite: UniteDefaut.METRE,
    mesuresRequises: [MesureDefaut.LONGUEUR, MesureDefaut.PROFONDEUR],
    graviteMax: 4,
    description:
      "Deformation de la chaussee en rigoles de roulement. Metre lineaire ; la profondeur, exigee au releve, qualifie la gravite sans entrer dans le metre.",
  },
  {
    code: "AFFAISSEMENT",
    libelle: "Affaissement",
    famille: FamilleDefaut.CHAUSSEE,
    unite: UniteDefaut.METRE_CUBE,
    mesuresRequises: [MesureDefaut.LONGUEUR, MesureDefaut.LARGEUR, MesureDefaut.PROFONDEUR],
    graviteMax: 4,
    description: "Tassement localise de la structure. Metre volumique.",
  },
  {
    code: "RAVINEMENT",
    libelle: "Ravinement",
    famille: FamilleDefaut.ACCOTEMENT,
    unite: UniteDefaut.METRE_CUBE,
    mesuresRequises: [MesureDefaut.LONGUEUR, MesureDefaut.LARGEUR, MesureDefaut.PROFONDEUR],
    graviteMax: 4,
    description:
      "Erosion hydrique creusant accotements et talus. Metre volumique. Famille provisoire (ACCOTEMENT), a trancher par l'administration.",
  },
  {
    code: "ARRACHEMENT",
    libelle: "Arrachement",
    famille: FamilleDefaut.CHAUSSEE,
    unite: UniteDefaut.METRE_CARRE,
    mesuresRequises: [MesureDefaut.LONGUEUR, MesureDefaut.LARGEUR],
    graviteMax: 4,
    description: "Perte de revetement par plaques. Metre surfacique.",
  },
  {
    code: "DEFORMATION",
    libelle: "Déformation",
    famille: FamilleDefaut.CHAUSSEE,
    unite: UniteDefaut.METRE_CARRE,
    mesuresRequises: [MesureDefaut.LONGUEUR, MesureDefaut.LARGEUR],
    graviteMax: 4,
    description: "Ondulation ou bourrelet sans perte de matiere. Metre surfacique.",
  },
  {
    code: "DRAINAGE",
    libelle: "Dégradation drainage",
    famille: FamilleDefaut.ASSAINISSEMENT,
    unite: UniteDefaut.METRE,
    mesuresRequises: [MesureDefaut.LONGUEUR],
    graviteMax: 4,
    description: "Fosse, caniveau ou exutoire degrades ou obstrues. Metre lineaire ; le cahier des charges admet aussi un releve en quantite.",
  },
  {
    code: "ACCOTEMENT",
    libelle: "Dégradation accotement",
    famille: FamilleDefaut.ACCOTEMENT,
    unite: UniteDefaut.METRE_CARRE,
    mesuresRequises: [MesureDefaut.LONGUEUR, MesureDefaut.LARGEUR],
    graviteMax: 4,
    description: "Degradation de la bande laterale non roulee. Metre surfacique.",
  },
  {
    code: "SIGNALISATION",
    libelle: "Signalisation dégradée",
    famille: FamilleDefaut.SIGNALISATION,
    unite: UniteDefaut.UNITE,
    mesuresRequises: [MesureDefaut.NOMBRE],
    graviteMax: null,
    description: "Panneau, balise ou marquage degrade, illisible ou manquant. Comptage ; ne se gradue pas.",
  },
  {
    code: "AUTRE",
    libelle: "Autre",
    famille: FamilleDefaut.ENVIRONNEMENT,
    unite: UniteDefaut.UNITE,
    mesuresRequises: [],
    graviteMax: 4,
    description:
      "Type ouvert : aucune mesure exigee, la quantite reste nulle tant qu'un releve n'a pas ete saisi. A requalifier des que le type reel est connu.",
  },
];

async function main() {
  let crees = 0;
  let dejaPresents = 0;

  for (const t of TYPES) {
    const existante = await prisma.catalogueDefaut.findUnique({ where: { code: t.code } });
    if (!existante) {
      await prisma.catalogueDefaut.create({
        data: { ...t, source: SOURCE },
      });
      crees++;
      continue;
    }
    // Une ligne existante est une donnée administrée, même si son libellé diffère
    // encore de la valeur proposée par ce script.
    dejaPresents++;
  }

  const total = await prisma.catalogueDefaut.count();
  console.log(`Catalogue des défauts : ${crees} créés, ${dejaPresents} déjà présents et inchangés, ${total} lignes au total.`);
}

main()
  .catch((e) => { console.error("ECHEC :", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
