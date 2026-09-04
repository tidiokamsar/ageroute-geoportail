/**
 * Requalifier l'etat et le revetement d'un lot de promotion.
 *
 * SANS `--apply`, LE SCRIPT NE FAIT QUE LIRE.
 *
 * POURQUOI CE SCRIPT EXISTE
 *
 * Une declaration d'etat s'applique a un lot entier. Quand elle se revele trop large,
 * il faut pouvoir la retirer sans defaire la promotion elle-meme : les troncons sont
 * legitimement au registre, c'est ce qu'on a AFFIRME d'eux qui ne l'est pas.
 *
 * Le cas qui l'a motive, le 04/09/2026 : « les grands axes sont en bitume et en bon
 * etat » avait ete declare pour le Grand Conakry. En l'etendant au pays entier, 2 171
 * troncons et 5 719 km ont ete annonces bons et bitumes du Fouta a la foret, sans que
 * personne ne l'ait dit. Ajoute aux 160 862 voies locales declarees MOYEN, 98 % du
 * registre affichait un etat connu et la carte etait verte partout.
 *
 * CE QU'IL FAIT, ET CE QU'IL NE FAIT PAS
 *
 * Il change `etat` et `revetement`, et met a jour les lignes de `valeurs_qualite`
 * correspondantes. Il ne touche NI la geometrie, NI le rattachement a la voirie
 * source, NI l'existence des troncons. Retirer une affirmation n'est pas supprimer un
 * actif.
 *
 * REVENIR A NON_EVALUE N'EST PAS UNE PERTE
 *
 * C'est un retour a ce qu'on sait reellement. Un troncon NON_EVALUE se lit en gris et
 * n'entre dans aucun indicateur d'etat — ce qui est exact tant qu'aucune inspection
 * n'a eu lieu. Une carte grise qui dit « on ne sait pas » vaut mieux qu'une carte
 * verte qui l'affirme a tort.
 *
 * Usage :
 *   tsx scripts/requalifier-lot-promotion.ts --lot=PROMOTION_GN_2026-09-04
 *   ... --etat=NON_EVALUE --revetement=NON_RENSEIGNE
 *   ... --apply
 */
import { PrismaClient } from "@prisma/client";
import "dotenv/config";
import { analyserEtat, analyserRevetement, estDeclaration, revetementDeclare } from "./lib/promotion";

const prisma = new PrismaClient();

function argument(nom: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${nom}=`));
  return p ? p.slice(nom.length + 3) : undefined;
}

async function main() {
  const lot = argument("lot");
  const etat = analyserEtat(argument("etat") ?? "NON_EVALUE");
  const revetement = analyserRevetement(argument("revetement") ?? "NON_RENSEIGNE");
  const appliquer = process.argv.includes("--apply");

  if (!lot) throw new Error("--lot=<marqueur> est obligatoire, par exemple PROMOTION_GN_2026-09-04.");
  if (!/^[A-Z0-9_-]+$/.test(lot)) throw new Error("--lot : lettres majuscules, chiffres, tirets et soulignes.");

  const marqueur = `%Lot ${lot}.%`;

  const avant = await prisma.$queryRawUnsafe<{ etat: string; revetement: string; n: bigint; km: number }[]>(
    `select etat::text, revetement::text, count(*) as n,
            round(sum("longueurKm")::numeric) as km
       from troncons where "deletedAt" is null and observations like $1
      group by 1,2 order by 3 desc`,
    marqueur,
  );

  const total = avant.reduce((s, l) => s + Number(l.n), 0);

  console.log("=== Requalification d'un lot de promotion ===");
  console.log(`Lot          : ${lot}`);
  console.log(`Cible        : etat ${etat}, revetement ${revetement}`);
  console.log(`Mode         : ${appliquer ? "ECRITURE" : "LECTURE SEULE (ajouter --apply)"}`);
  console.log("");

  if (total === 0) {
    console.log("Aucun troncon ne porte ce marqueur. Rien a faire.");
    return;
  }

  console.log("Etat actuel du lot :");
  for (const l of avant) {
    console.log(`  ${String(Number(l.n)).padStart(7)}  ${l.etat.padEnd(11)} ${l.revetement.padEnd(14)} ${l.km} km`);
  }
  console.log("");
  console.log(`${total} troncons passeraient a ${etat} / ${revetement}.`);
  console.log("Ni la geometrie, ni le rattachement, ni l'existence des troncons ne changent.");
  console.log("");

  if (!appliquer) {
    console.log("LECTURE SEULE — rien n'a ete ecrit.");
    return;
  }

  const maintenant = new Date();
  const declare = estDeclaration(etat);
  const revDeclare = revetementDeclare(revetement);

  const noteEtat = declare
    ? `Etat ${etat} declare le ${maintenant.toISOString().slice(0, 10)}, sans inspection.`
    : "Aucune inspection. L'etat de cette voie est inconnu. Une declaration anterieure "
      + `a ete retiree le ${maintenant.toISOString().slice(0, 10)} : elle couvrait un perimetre trop large.`;
  const noteRev = revDeclare
    ? `Revetement ${revetement} declare le ${maintenant.toISOString().slice(0, 10)}, sans releve.`
    : "La source decrit la praticabilite (NATURE), pas la couche de roulement. Une "
      + `declaration anterieure a ete retiree le ${maintenant.toISOString().slice(0, 10)}.`;

  await prisma.$transaction(async (tx) => {
    const majTroncons = await tx.$executeRawUnsafe(
      `update troncons
          set etat = $2::"EtatPatrimoine", revetement = $3::"Revetement", "updatedAt" = now()
        where "deletedAt" is null and observations like $1`,
      marqueur, etat, revetement,
    );

    const majEtat = await tx.$executeRawUnsafe(
      `update valeurs_qualite q
          set statut = $2::"StatutValeur", source = $3, methode = $4,
              "observedAt" = $5::timestamp, note = $6, "updatedAt" = now()
         from troncons t
        where q."entityType" = 'Troncon' and q."entityId" = t.id and q.champ = 'etat'
          and t."deletedAt" is null and t.observations like $1`,
      marqueur,
      declare ? "IMPORTED_UNVERIFIED" : "UNKNOWN",
      declare ? "DECLARATION_GESTIONNAIRE" : "AUCUNE",
      declare ? "DECLARATION" : "AUCUNE",
      maintenant, noteEtat,
    );

    const majRev = await tx.$executeRawUnsafe(
      `update valeurs_qualite q
          set statut = $2::"StatutValeur", source = $3, methode = $4,
              "observedAt" = $5::timestamp, note = $6, "updatedAt" = now()
         from troncons t
        where q."entityType" = 'Troncon' and q."entityId" = t.id and q.champ = 'revetement'
          and t."deletedAt" is null and t.observations like $1`,
      marqueur,
      revDeclare ? "IMPORTED_UNVERIFIED" : "UNKNOWN",
      revDeclare ? "DECLARATION_GESTIONNAIRE" : "OSM ROUTE.shp",
      revDeclare ? "DECLARATION" : "ABSENT_DE_LA_SOURCE",
      maintenant, noteRev,
    );

    console.log("--- Applique ---");
    console.log(`  troncons requalifies        : ${majTroncons}`);
    console.log(`  lignes de qualite (etat)    : ${majEtat}`);
    console.log(`  lignes de qualite (revet.)  : ${majRev}`);
  }, { timeout: 300_000, maxWait: 60_000 });

  console.log("");
  console.log("Retour arriere : rejouer ce script avec les valeurs precedentes,");
  console.log(`  --lot=${lot} --etat=<ancien> --revetement=<ancien> --apply`);
}

main()
  .catch((e) => { console.error("ECHEC :", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
