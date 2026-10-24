/**
 * Inscrit en base la regle de calcul du RCI version 1.
 *
 * ETAT DES ARBITRAGES AU 13/10/2026
 *
 *   ponderations          du cahier, NON CALIBREES, non approuvees
 *   correspondance        DONNEE par AGEROUTE : BON 90, MOYEN 65, MAUVAIS 35, CRITIQUE 10
 *   classes               DONNEES par AGEROUTE : six, de 0 a 100
 *   couverture minimale   ARBITREE par AGEROUTE a 0,5, apres mesure
 *   fraicheur             365 jours, proposee, NON arbitree
 *   approbation           NON : la regle sort avec approuveeLe nul
 *
 * La regle reste donc NON APPROUVEE, et tout score qu'elle produit sort avec
 * `publiable: false`. L'approbation est un geste separe, qui appartient a AGEROUTE.
 *
 * CE QUE CE SCRIPT FAIT, ET CE QU'IL NE FAIT SURTOUT PAS
 *
 * Le paragraphe 13 enonce ses ponderations — chaussee 30 %, drainage 15 %, ouvrages 15 %,
 * signalisation 10 %, securite 10 %, trafic 10 %, historique 5 %, incidents 5 % — en les
 * qualifiant explicitement de « base indicative A CALIBRER ».
 *
 * Ce script les rend donc LISIBLES et CALCULABLES, sans les rendre officielles :
 * `approuveeLe` reste nul, et tout score produit sous cette regle sort avec
 * `publiable: false`. C'est l'unique interrupteur, et il appartient a AGEROUTE.
 *
 * Il n'approuve rien. Il ne calcule aucun score. Il n'ecrit qu'une ligne.
 *
 * POURQUOI UN SCRIPT ET NON LA MIGRATION
 *
 * Une regle a un AUTEUR, et toute ecriture est auditee (regle 3 d'AGENTS.md). Une
 * migration SQL ne sait ni qui l'execute ni ecrire dans `audit_logs` au nom de quelqu'un ;
 * elle aurait fait apparaitre une regle de gouvernance sans auteur et sans trace.
 *
 * UNE COMPOSANTE SUR HUIT N'A AUCUNE DONNEE
 *
 * Mesure du 13/10/2026 : `traficMoyenJma` est renseigne sur 0 des 1 690 troncons
 * anterieurs a la promotion de la voirie. Le TRAFIC (10 %) sera donc exclu de chaque
 * score, et avec lui un dixieme du modele.
 *
 * C'est pour cela que `couvertureMinimale` vaut 0,5 et non 1 : exiger la totalite
 * refuserait tout score aujourd'hui, et exiger trop peu rendrait un nombre entre 0 et 100
 * qui ne dirait presque rien. La moitie du modele est une PROPOSITION DE DEPART, au meme
 * titre que les ponderations, et elle attend le meme arbitrage.
 *
 * `fraicheurMaxJours` a 365 suit le meme raisonnement : une annee est la periodicite
 * d'inspection courante, pas une norme ecrite dans le cahier.
 *
 * IDEMPOTENT
 *
 * La version est unique en base. Rejouer ce script ne touche pas la ligne existante : si
 * AGEROUTE a amende ou approuve la version 1, son geste reste en place.
 *
 * RETOUR ARRIERE
 *
 *     delete from regles_condition where version = 'rci-2026.1'
 *       and id not in (select "regleId" from evaluations_condition);
 *
 * La garde est necessaire : une evaluation sans sa regle ne serait plus explicable.
 */
import { AuditAction, Role } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { logAuditTransactionnelle } from "../src/utils/audit";

const VERSION = "rci-2026.1";

/**
 * Correspondance etat-vers-score, DONNEE PAR AGEROUTE le 13/10/2026.
 *
 * Ces quatre nombres etaient mes valeurs d'essai, reprises telles quelles par la DSI : ce
 * sont donc desormais sa decision, et non une proposition de ma part. La difference compte
 * pour qui relira ce fichier.
 *
 * `NON_EVALUE` EST DELIBEREMENT ABSENT, et c'est le point le plus important de cette table.
 *
 * `EtatPatrimoine` porte cinq valeurs ; quatre sont ici. `NON_EVALUE` n'est pas un etat,
 * c'est son ABSENCE : lui donner un nombre ferait entrer 254 547 troncons dans le calcul
 * avec une valeur que personne n'a constatee. Son omission rend la composante CHAUSSEE
 * absente, le moteur renormalise sans elle, et le score dit honnetement qu'il porte sur
 * moins que le modele.
 */
const NORMALISATION = {
  CHAUSSEE: { BON: 90, MOYEN: 65, MAUVAIS: 35, CRITIQUE: 10 },
  OUVRAGES: { BON: 90, MOYEN: 65, MAUVAIS: 35, CRITIQUE: 10 },
} as const;

/**
 * Classes de score, DONNEES PAR AGEROUTE dans l'addendum V4.1.
 *
 * Bornes INCLUSIVES des deux cotes, comme l'addendum les enonce : « 90-100 », « 75-89 ».
 * Les traduire en intervalles semi-ouverts aurait decale chaque frontiere d'un point sans
 * que personne le voie.
 */
const CLASSES = [
  { min: 90, max: 100, code: "EXCELLENT", libelle: "Excellent" },
  { min: 75, max: 89, code: "BON", libelle: "Bon" },
  { min: 60, max: 74, code: "ACCEPTABLE", libelle: "Acceptable" },
  { min: 40, max: 59, code: "DEGRADE", libelle: "Dégradé" },
  { min: 20, max: 39, code: "MAUVAIS", libelle: "Mauvais" },
  { min: 0, max: 19, code: "CRITIQUE", libelle: "Critique" },
] as const;

/** Les huit composantes du paragraphe 13, dans son ordre et avec ses pourcentages. */
const POIDS_INDICATIFS = {
  CHAUSSEE: 30,
  DRAINAGE: 15,
  OUVRAGES: 15,
  SIGNALISATION: 10,
  SECURITE: 10,
  TRAFIC: 10,
  HISTORIQUE: 5,
  INCIDENTS: 5,
} as const;

async function main() {
  const existante = await prisma.regleCondition.findUnique({ where: { version: VERSION } });
  if (existante) {
    const etat = existante.approuveeLe
      ? `APPROUVEE le ${existante.approuveeLe.toISOString().slice(0, 10)}`
      : "non approuvée";
    console.log(`Règle ${VERSION} déjà présente (${etat}) — inchangée.`);
    return;
  }

  // L'auteur doit etre une personne : une regle de gouvernance sans auteur ne serait
  // imputable a personne. Le plus ancien ADMIN actif est le choix le moins arbitraire
  // qu'un script puisse faire — et le geste qui compte, l'approbation, restera explicite.
  const auteur = await prisma.user.findFirst({
    where: { role: Role.ADMIN, actif: true },
    orderBy: { createdAt: "asc" },
    select: { id: true, email: true },
  });
  if (!auteur) {
    throw new Error(
      "Aucun compte ADMIN actif : impossible d'attribuer un auteur à la règle. "
      + "Créez d'abord un administrateur.",
    );
  }

  const regle = await prisma.$transaction(async (tx) => {
    const creee = await tx.regleCondition.create({
      data: {
        version: VERSION,
        poids: POIDS_INDICATIFS,
        normalisation: NORMALISATION,
        classes: CLASSES,
        fraicheurMaxJours: 365,
        confiancesAcceptees: ["HIGH", "MEDIUM"],
        // ARBITRE PAR AGEROUTE le 13/10/2026, apres mesure de ce que le seuil produit.
        //
        // Je l'avais propose a 0,5 sans arbitrage. La mesure montrait que la couverture
        // maximale atteignable est 0,45, donc que ce seuil rend AUCUN score aujourd'hui.
        // Les trois options ont ete posees : 0,5 et zero score, 0,45 et six scores, 0,30 et
        // 6 840 scores calcules sur la chaussee seule.
        //
        // AGEROUTE a retenu 0,5 en connaissance de cause. Un indicateur qui refuse de se
        // prononcer est plus utile qu'un indicateur qui se prononce sur un tiers du modele,
        // surtout pour un premier chiffre, qui fera reference.
        couvertureMinimale: 0.5,
        sensCroissant: true,
        motif:
          "Pondérations indicatives du paragraphe 13 du cahier RAI V3.1, reprises telles "
          + "quelles et NON CALIBRÉES. Correspondance état-vers-score et classes données "
          + "par AGEROUTE le 13/10/2026. Seuil de couverture 0,5 arbitré le 13/10/2026 "
          + "après mesure : il rend zéro score tant que la collecte n'a pas tourné, et "
          + "c'est le comportement voulu. Fraîcheur 365 jours encore non arbitrée. "
          + "À approuver, amender ou remplacer par AGEROUTE.",
        creeParId: auteur.id,
      },
    });
    await logAuditTransactionnelle(tx, {
      userId: auteur.id,
      action: AuditAction.CREATE,
      entityType: "RegleCondition",
      entityId: creee.id,
      after: creee,
    });
    return creee;
  });

  console.log(`Règle ${regle.version} créée, NON APPROUVÉE — auteur ${auteur.email}.`);
  console.log("  Tout score calculé sous cette règle sort avec publiable = false.");
  console.log(
    "  TRAFIC (10 %) sera exclu de chaque score : aucun tronçon ne porte de donnée de trafic.",
  );
  console.log("  Correspondance état vers score : BON 90, MOYEN 65, MAUVAIS 35, CRITIQUE 10.");
  console.log("  NON_EVALUE est volontairement ABSENT : c'est une absence d'état, pas un état.");
  console.log("  Six classes de 0 à 100, bornes inclusives.");
  console.log("");
  console.log("  CE QUE CETTE RÈGLE PRODUIRA AUJOURD'HUI : AUCUN SCORE.");
  console.log("  Mesure du 13/10/2026 : la couverture maximale atteignable est 0,45, sur SIX");
  console.log("  tronçons (chaussée 30 + ouvrage 15). 6 834 autres n'atteignent que 0,30.");
  console.log("  Avec couvertureMinimale à 0,5, le moteur refuse donc tout score — ce qui est");
  console.log("  le comportement correct, et dit que le verrou est la COLLECTE, pas la règle.");
}

main()
  .catch((e) => { console.error("ECHEC :", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
