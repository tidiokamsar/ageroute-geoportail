/**
 * Declarer un revetement a partir de l'etat de chaussee.
 *
 * SANS `--apply`, LE SCRIPT NE FAIT QUE LIRE.
 *
 * LA REGLE, ET CE QUI LA JUSTIFIE
 *
 * « Tout troncon en bon ou moyen etat est bitume. » C'est une regle metier enoncee
 * par le gestionnaire, pas une loi : une piste en laterite bien entretenue peut etre
 * en bon etat sans etre bitumee.
 *
 * Mais la base la corrobore. Mesure du 04/09/2026 sur les 2 040 troncons :
 *
 *     BON      + BITUME          122        BON      + autre chose      0
 *     MOYEN    + BITUME          297        MOYEN    + autre chose      0
 *     MAUVAIS  + BITUME          134
 *     CRITIQUE + BITUME           95
 *
 * 419 troncons sur 419 en bon ou moyen etat portent BITUME, sans une exception. La
 * regle decrit donc un motif reellement present, et l'appliquer aux valeurs inconnues
 * prolonge ce motif au lieu d'en inventer un.
 *
 * CE QU'IL NE FAIT PAS : ECRASER
 *
 * Il ne touche QUE les troncons dont le revetement vaut NON_RENSEIGNE. Combler un
 * inconnu et remplacer une valeur affirmee sont deux actes differents : le second
 * effacerait le travail de quelqu'un. Les troncons portant TERRE, LATERITE ou PAVE
 * sont comptes et laisses tels quels, meme si leur etat est bon.
 *
 * CE QU'IL ECRIT DANS valeurs_qualite
 *
 * La ligne `revetement` de ces troncons dit aujourd'hui UNKNOWN / ABSENT_DE_LA_SOURCE.
 * Elle passe a IMPORTED_UNVERIFIED / DECLARATION, avec la date et la regle appliquee.
 * Une declaration n'est pas un releve, et la base doit continuer a le dire — sinon
 * cette operation ressemblerait a un constat de terrain qu'elle n'est pas.
 *
 * Usage :
 *   tsx scripts/declarer-revetement-par-etat.ts                      (lecture seule)
 *   tsx scripts/declarer-revetement-par-etat.ts --apply              (ecrit)
 *   ... --etats=BON,MOYEN         (defaut)
 *   ... --revetement=BITUME       (defaut)
 */
import { PrismaClient } from "@prisma/client";
import "dotenv/config";
import { analyserRevetement, ETATS_VALIDES } from "./lib/promotion";

const prisma = new PrismaClient();

function argument(nom: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${nom}=`));
  return p ? p.slice(nom.length + 3) : undefined;
}

async function main() {
  const etats = (argument("etats") ?? "BON,MOYEN")
    .split(",").map((e) => e.trim().toUpperCase())
    .filter((e) => (ETATS_VALIDES as readonly string[]).includes(e));
  const revetement = analyserRevetement(argument("revetement") ?? "BITUME");
  const appliquer = process.argv.includes("--apply");

  if (etats.length === 0) throw new Error("--etats : aucun etat valide.");
  if (revetement === "NON_RENSEIGNE") {
    throw new Error("--revetement=NON_RENSEIGNE n'a pas de sens ici : ce script comble des inconnus.");
  }

  console.log("=== Declaration de revetement a partir de l'etat ===");
  console.log(`Regle        : etat ∈ {${etats.join(", ")}}  =>  revetement = ${revetement}`);
  console.log(`Mode         : ${appliquer ? "ECRITURE" : "LECTURE SEULE (ajouter --apply pour ecrire)"}`);
  console.log("");

  const bilan = await prisma.$queryRawUnsafe<{ effet: string; n: bigint }[]>(
    `select case
              when revetement::text = $2 then 'deja ' || $2 || ' — aucun changement'
              when revetement = 'NON_RENSEIGNE' then 'inconnu a combler'
              else 'valeur EXISTANTE, laissee intacte : ' || revetement::text
            end as effet,
            count(*) as n
       from troncons
      where "deletedAt" is null and etat::text = any($1::text[])
      group by 1 order by 2 desc`,
    etats, revetement,
  );

  let aCombler = 0;
  for (const b of bilan) {
    console.log(`  ${String(Number(b.n)).padStart(6)}  ${b.effet}`);
    if (b.effet === "inconnu a combler") aCombler = Number(b.n);
  }
  console.log("");

  if (aCombler === 0) {
    console.log("Rien a combler. Aucune ecriture ne serait faite.");
    return;
  }

  console.log(`${aCombler} troncons recevraient ${revetement}, et autant de lignes de`);
  console.log("qualite passeraient de UNKNOWN a IMPORTED_UNVERIFIED (declaration).");
  console.log("");

  if (!appliquer) {
    console.log("LECTURE SEULE — rien n'a ete ecrit. Ajouter --apply pour appliquer.");
    return;
  }

  const maintenant = new Date();
  const note =
    `Revetement ${revetement} declare le ${maintenant.toISOString().slice(0, 10)} ` +
    `par application de la regle « etat ∈ {${etats.join(", ")}} => ${revetement} ». ` +
    "Aucun releve de terrain. A exclure de tout indicateur de revetement tant qu'une " +
    "inspection ne le confirme pas.";

  await prisma.$transaction(async (tx) => {
    // Les identifiants sont figes AVANT l'ecriture : apres, le predicat
    // « revetement = NON_RENSEIGNE » ne les designerait plus.
    const cibles = await tx.$queryRawUnsafe<{ id: string }[]>(
      `select id from troncons
        where "deletedAt" is null and etat::text = any($1::text[])
          and revetement = 'NON_RENSEIGNE'`,
      etats,
    );
    const ids = cibles.map((c) => c.id);

    const majTroncons = await tx.$executeRawUnsafe(
      `update troncons set revetement = $2::"Revetement", "updatedAt" = now()
        where id = any($1::text[])`,
      ids, revetement,
    );

    // La ligne de qualite existe deja (UNKNOWN) : on la requalifie, sans en creer une
    // seconde — la contrainte d'unicite l'interdit, et deux verites sur le meme champ
    // n'auraient pas de sens.
    const majQualite = await tx.$executeRawUnsafe(
      `update valeurs_qualite
          set statut = 'IMPORTED_UNVERIFIED'::"StatutValeur",
              source = 'DECLARATION_GESTIONNAIRE', methode = 'DECLARATION',
              "observedAt" = $2::timestamp, confiance = 'LOW'::"NiveauConfiance",
              note = $3, "updatedAt" = now()
        where "entityType" = 'Troncon' and champ = 'revetement'
          and "entityId" = any($1::text[])`,
      ids, maintenant, note,
    );

    // Un troncon sans ligne de qualite pour ce champ en recoit une : sans elle, la
    // valeur declaree serait indiscernable d'une valeur relevee.
    const creees = await tx.$executeRawUnsafe(
      `insert into valeurs_qualite (id, "entityType", "entityId", champ, statut, source, methode, "observedAt", confiance, note, "createdAt", "updatedAt")
       select gen_random_uuid()::text, 'Troncon', t.id, 'revetement',
              'IMPORTED_UNVERIFIED'::"StatutValeur", 'DECLARATION_GESTIONNAIRE',
              'DECLARATION', $2::timestamp, 'LOW'::"NiveauConfiance", $3, now(), now()
         from troncons t where t.id = any($1::text[])
       on conflict ("entityType", "entityId", champ) do nothing`,
      ids, maintenant, note,
    );

    console.log("--- Applique ---");
    console.log(`  troncons mis a jour        : ${majTroncons}`);
    console.log(`  lignes de qualite requalifiees : ${majQualite}`);
    console.log(`  lignes de qualite creees       : ${creees}`);
    console.log("");
    console.log("Retour arriere :");
    console.log(`  update troncons set revetement='NON_RENSEIGNE' where id in (${ids.length} identifiants ci-dessous);`);
    console.log(`  update valeurs_qualite set statut='UNKNOWN', source='OSM ROUTE.shp',`);
    console.log(`    methode='ABSENT_DE_LA_SOURCE', note='La source decrit la praticabilite (NATURE), pas la couche de roulement.'`);
    console.log(`   where "entityType"='Troncon' and champ='revetement' and "entityId" in (...);`);
    console.log("");
    console.log("Identifiants concernes :");
    console.log(ids.map((i) => `'${i}'`).join(","));
  });
}

main()
  .catch((e) => { console.error("ECHEC :", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
