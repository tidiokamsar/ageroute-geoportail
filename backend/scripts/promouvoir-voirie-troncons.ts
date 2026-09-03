/**
 * P4 — Promotion de voies `voirie_locale` en troncons du reseau AGEROUTE.
 *
 * SANS `--apply`, LE SCRIPT NE FAIT QUE LIRE.
 *
 * CE QUE CE SCRIPT REPRESENTE
 *
 * C'est l'acte que toute la conception de la phase 4 avait deliberement differe.
 * L'import OSM du 02/09/2026 a charge 262 656 voies avec `statut = SOURCE_EXTERNE`
 * et `tronconId = NULL` : de la donnee cartographique, consultable, sans aucune
 * portee institutionnelle. Ce script franchit la frontiere. Une voie promue devient
 * un actif du patrimoine : elle compte dans les indicateurs, apparait dans les
 * exports, et peut porter des chantiers.
 *
 * Il ne s'execute donc jamais sur tout le pays. Il prend une emprise, une liste de
 * categories, et rend compte de chaque valeur qu'il n'a pas trouvee.
 *
 * LES SIX CHAMPS OBLIGATOIRES, ET CE QU'ON EN SAIT
 *
 * `Troncon` exige regionId, longueurKm, revetement, etat, pkDebut et pkFin, tous non
 * nuls. La source n'en porte aucun. C'est precisement le mecanisme qui a produit
 * `revetement = BITUME` sur les 1 690 troncons existants — une colonne obligatoire,
 * une valeur par defaut, et une contrevérité durable.
 *
 * Ce script refuse de rejouer cela. Chaque champ sans source donne une ligne dans
 * `valeurs_qualite` qui dit ce qu'on ignore :
 *
 *     revetement   UNKNOWN     absent de la source (OSM porte NATURE, pas la couche
 *                              de roulement)
 *     etat         selon --etat, voir plus bas
 *     longueurKm   DERIVED     calcul geometrique, seule valeur disponible
 *     pkDebut/Fin  DERIVED     0 -> longueur, kilometrage local
 *     regionId     DERIVED     deduction administrative, pas une donnee source
 *     nom          UNKNOWN     pour les voies anonymes dans OSM
 *
 * La regle « ne jamais ecraser longueurKm par ST_Length » ne s'applique pas ici :
 * ces troncons n'existent pas encore, il n'y a aucune longueur metier a preserver.
 * La longueur calculee est la seule disponible, et elle est marquee comme telle.
 *
 * `--etat` : LA SEULE DECISION METIER
 *
 * Par defaut NON_EVALUE, qui est la verite : personne n'a inspecte ces voies.
 *
 * Toute autre valeur est traitee comme une DECLARATION. Elle est acceptee — un
 * gestionnaire peut connaitre son reseau sans l'avoir formellement inspecte — mais
 * elle est enregistree comme IMPORTED_UNVERIFIED, avec sa date et son auteur, pour
 * que les tableaux de bord puissent l'exclure. Une declaration n'est pas une mesure.
 *
 * Contexte a garder en tete : au 03/09/2026 le pays compte 121 troncons BON sur
 * 1 690. Promouvoir 315 rues en BON ferait passer ce chiffre a 436, dont 72 % de
 * voies jamais inspectees.
 *
 * IDEMPOTENCE
 *
 * Le code du troncon est derive de l'identifiant source — `<PREFIXE>-OSM-<sourceId>`
 * — et `code` est unique. Les voies deja promues (`tronconId` non nul) sont ignorees.
 * Rejouer le script n'ajoute rien et ne duplique rien.
 *
 * REVERSIBILITE
 *
 * Le script affiche, apres application, la requete exacte qui annule son effet.
 *
 * Usage :
 *   tsx scripts/promouvoir-voirie-troncons.ts --bbox=-13.725,9.495,-13.680,9.540
 *   ... --categories=VOIE_LOCALE,RESIDENTIELLE,ACCES,CHEMIN
 *   ... --prefixe=KALOUM --classe=RU --region=1
 *   ... --etat=BON            (declaration ; defaut NON_EVALUE)
 *   ... --apply               (ecrit ; sans lui, lecture seule)
 */
import { PrismaClient } from "@prisma/client";
import "dotenv/config";
import {
  analyserEmprise, analyserCategories, analyserPrefixe,
  analyserEtat, analyserClasse, estDeclaration, casLibelleSql,
} from "./lib/promotion";

const prisma = new PrismaClient();

function argument(nom: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${nom}=`));
  return p ? p.slice(nom.length + 3) : undefined;
}

async function main() {
  const [ouest, sud, est, nord] = analyserEmprise(argument("bbox"));
  const categories = analyserCategories(argument("categories"));
  const prefixe = analyserPrefixe(argument("prefixe"));
  const classe = analyserClasse(argument("classe"));
  const etat = analyserEtat(argument("etat"));
  const regionId = Number(argument("region") ?? 1);
  const appliquer = process.argv.includes("--apply");
  if (!Number.isInteger(regionId)) throw new Error("--region attend un entier.");

  const region = await prisma.region.findUnique({ where: { id: regionId } });
  if (!region) throw new Error(`--region ${regionId} : region inexistante.`);

  const declare = estDeclaration(etat);

  console.log("=== Promotion de voirie locale en troncons ===");
  console.log(`Emprise      : ${ouest},${sud},${est},${nord}`);
  console.log(`Categories   : ${categories.join(", ")}`);
  console.log(`Classe       : ${classe}   Region : ${region.nom} (${regionId})   Prefixe : ${prefixe}`);
  console.log(`Etat         : ${etat}${declare ? "   << DECLARATION, enregistree comme non verifiee" : "   (aucune inspection : c'est la verite)"}`);
  console.log(`Mode         : ${appliquer ? "ECRITURE" : "LECTURE SEULE (ajouter --apply pour ecrire)"}`);
  console.log("");

  // --- Ce qui serait promu ---------------------------------------------------
  const candidats = await prisma.$queryRawUnsafe<
    { categorie: string; voies: bigint; km: number; nommees: bigint }[]
  >(
    `select v.categorie::text as categorie,
            count(*)                                as voies,
            round(sum(v."longueurCalculeeKm")::numeric, 1)::float8 as km,
            count(v.nom)                            as nommees
       from voirie_locale v
      where v.geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
        and v.categorie::text = any($5::text[])
        and v."tronconId" is null
      group by 1 order by 2 desc`,
    ouest, sud, est, nord, categories,
  );

  if (candidats.length === 0) {
    console.log("Aucune voie a promouvoir sur cette emprise (deja promues, ou aucune correspondance).");
    return;
  }

  let total = 0, totalKm = 0, totalNommees = 0;
  console.log("Categorie          Voies      km   Nommees");
  for (const c of candidats) {
    const n = Number(c.voies), nom = Number(c.nommees);
    total += n; totalKm += c.km; totalNommees += nom;
    console.log(`${c.categorie.padEnd(16)} ${String(n).padStart(6)} ${c.km.toFixed(1).padStart(7)} ${String(nom).padStart(9)}`);
  }
  console.log(`${"TOTAL".padEnd(16)} ${String(total).padStart(6)} ${totalKm.toFixed(1).padStart(7)} ${String(totalNommees).padStart(9)}`);
  console.log("");

  const anonymes = total - totalNommees;
  const avant = await prisma.troncon.count({ where: { deletedAt: null } });
  const bonAvant = await prisma.troncon.count({ where: { deletedAt: null, etat: "BON" } });

  console.log("--- Ce que cela change ---");
  console.log(`Troncons du reseau      : ${avant} -> ${avant + total}  (+${((total / avant) * 100).toFixed(0)} %)`);
  if (declare) {
    const apres = etat === "BON" ? bonAvant + total : bonAvant;
    console.log(`Troncons en etat BON    : ${bonAvant} -> ${apres}`);
    if (etat === "BON" && apres > 0) {
      console.log(`  dont jamais inspectes : ${total} (${((total / apres) * 100).toFixed(0)} % du total national)`);
    }
  }
  console.log(`Troncons sans nom reel  : ${anonymes} des ${total} promus`);
  console.log("");
  console.log("--- Valeurs sans source, tracees dans valeurs_qualite ---");
  console.log(`  revetement  UNKNOWN   ${total} lignes — OSM porte NATURE, pas la couche de roulement`);
  console.log(`  etat        ${declare ? "IMPORTED_UNVERIFIED" : "UNKNOWN  "}   ${total} lignes${declare ? " — declaration du " + new Date().toISOString().slice(0, 10) : ""}`);
  console.log(`  longueurKm  DERIVED   ${total} lignes — calcul geometrique`);
  console.log(`  pkDebut/Fin DERIVED   ${total * 2} lignes — kilometrage local 0 -> longueur`);
  console.log(`  regionId    DERIVED   ${total} lignes — deduction, l'emprise est un rectangle`);
  if (anonymes > 0) console.log(`  nom         UNKNOWN   ${anonymes} lignes — non nomme dans la source`);
  console.log("");

  if (!appliquer) {
    console.log("LECTURE SEULE — rien n'a ete ecrit. Ajouter --apply pour appliquer.");
    return;
  }

  // --- Application, en une transaction ---------------------------------------
  const lot = `PROMOTION_${prefixe}_${new Date().toISOString().slice(0, 10)}`;
  const maintenant = new Date();

  const caseLibelle = casLibelleSql();

  await prisma.$transaction(async (tx) => {
    // 1. Les troncons. La geometrie est copiee telle quelle : aucune retouche du
    //    trace, c'est la meme ligne, sous un autre statut institutionnel.
    const crees = await tx.$executeRawUnsafe(
      `insert into troncons (
         id, code, nom, classe, "regionId", "longueurKm", revetement, etat,
         "pkDebut", "pkFin", observations,
         "sourceType", "sourceReference", "sourceConfidence", "sourceDetectedAt",
         geom, "createdAt", "updatedAt")
       select gen_random_uuid()::text,
              $6 || '-OSM-' || v."sourceId",
              -- Le libelle de repli suit la categorie DE LA LIGNE : une desserte
              -- anonyme ne doit pas s'annoncer comme une voie residentielle.
              coalesce(v.nom, ${caseLibelle} || ' · ' || v."sourceId"),
              $7::"ClasseRoute",
              $8::int,
              v."longueurCalculeeKm",
              'NON_RENSEIGNE'::"Revetement",
              $9::"EtatPatrimoine",
              0, v."longueurCalculeeKm",
              'Promu depuis la voirie locale OpenStreetMap (' || v.nature || '). '
                || 'Lot ' || $10 || '. Revetement et etat sans releve terrain.',
              'IMPORT_DOCUMENTE'::"SourceType",
              'voirie_locale:' || v.id,
              'LOW'::"NiveauConfiance",
              $11::timestamp,
              v.geom, now(), now()
         from voirie_locale v
        where v.geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
          and v.categorie::text = any($5::text[])
          and v."tronconId" is null
       on conflict (code) do nothing`,
      ouest, sud, est, nord, categories, prefixe,
      classe, regionId, etat, lot, maintenant,
    );

    // 2. Le lien retour. La voie reste dans voirie_locale — on ne deplace rien, on
    //    dit d'ou vient le troncon. VALIDEE porte le trace, pas le classement.
    const liees = await tx.$executeRawUnsafe(
      `update voirie_locale v
          set "tronconId" = t.id, statut = 'VALIDEE'::"StatutVoirie", "updatedAt" = now()
         from troncons t
        where t.code = $6 || '-OSM-' || v."sourceId"
          and v.geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
          and v.categorie::text = any($5::text[])
          and v."tronconId" is null`,
      ouest, sud, est, nord, categories, prefixe,
    );

    // 3. Ce qu'on ignore, champ par champ. Sans ces lignes, les valeurs ci-dessus
    //    seraient indiscernables de valeurs relevees — la faute exacte du BITUME.
    const qualite = await tx.$executeRawUnsafe(
      `insert into valeurs_qualite (id, "entityType", "entityId", champ, statut, source, methode, "observedAt", confiance, note, "createdAt", "updatedAt")
       select gen_random_uuid()::text, 'Troncon', t.id, q.champ, q.statut::"StatutValeur",
              q.source, q.methode, $2::timestamp, q.confiance::"NiveauConfiance", q.note, now(), now()
         from troncons t
         join voirie_locale v on v."tronconId" = t.id
         cross join lateral (values
           ('revetement', 'UNKNOWN', 'OSM ROUTE.shp', 'ABSENT_DE_LA_SOURCE', 'LOW',
            'La source decrit la praticabilite (NATURE), pas la couche de roulement.'),
           ('etat', $3::text, $4::text, $5::text, 'LOW', $6::text),
           ('longueurKm', 'DERIVED', 'ST_Length(geom::geography)', 'CALCUL_GEOMETRIQUE', 'MEDIUM',
            'Longueur du trace. Aucune longueur metier n''existait pour cette voie.'),
           ('pkDebut', 'DERIVED', 'convention', 'CALCUL_GEOMETRIQUE', 'LOW',
            'Kilometrage local : 0 au debut du trace. Non raccorde au PK de la route.'),
           ('pkFin', 'DERIVED', 'ST_Length(geom::geography)', 'CALCUL_GEOMETRIQUE', 'LOW',
            'Kilometrage local : longueur du trace. Non raccorde au PK de la route.'),
           ('regionId', 'DERIVED', 'emprise geographique', 'DEDUCTION_ADMINISTRATIVE', 'LOW',
            'Deduit de l''emprise, qui est un rectangle et non une limite administrative. Aucun decoupage officiel n''est en base.')
         ) as q(champ, statut, source, methode, confiance, note)
        where t.observations like '%Lot ' || $1 || '.%'
       on conflict ("entityType", "entityId", champ) do nothing`,
      lot, maintenant,
      declare ? "IMPORTED_UNVERIFIED" : "UNKNOWN",
      declare ? "DECLARATION_GESTIONNAIRE" : "AUCUNE",
      declare ? "DECLARATION" : "AUCUNE",
      declare
        ? `Etat ${etat} declare le ${maintenant.toISOString().slice(0, 10)}, sans inspection. A exclure de tout indicateur d'etat du reseau tant qu'aucun releve terrain ne le confirme.`
        : "Aucune inspection. L'etat de cette voie est inconnu.",
    );

    // Le nom, seulement pour celles qu'OSM ne nomme pas.
    const noms = await tx.$executeRawUnsafe(
      `insert into valeurs_qualite (id, "entityType", "entityId", champ, statut, source, methode, "observedAt", confiance, note, "createdAt", "updatedAt")
       select gen_random_uuid()::text, 'Troncon', t.id, 'nom', 'UNKNOWN'::"StatutValeur",
              'OSM ROUTE.shp', 'ABSENT_DE_LA_SOURCE', $1::timestamp, 'LOW'::"NiveauConfiance",
              'Voie non nommee dans la source. Le libelle affiche est genere.', now(), now()
         from troncons t
         join voirie_locale v on v."tronconId" = t.id
        where t.observations like '%Lot ' || $2 || '.%' and v.nom is null
       on conflict ("entityType", "entityId", champ) do nothing`,
      maintenant, lot,
    );

    console.log("--- Applique ---");
    console.log(`  troncons crees            : ${crees}`);
    console.log(`  voies rattachees          : ${liees}`);
    console.log(`  lignes valeurs_qualite    : ${qualite + noms}`);
    console.log("");
    const cible = `(select id from troncons where observations like '%Lot ${lot}.%')`;
    console.log("Retour arriere :");
    console.log(`  delete from valeurs_qualite where "entityType"='Troncon' and "entityId" in ${cible};`);
    console.log(`  update voirie_locale set "tronconId"=null, statut='SOURCE_EXTERNE' where "tronconId" in ${cible};`);
    console.log(`  delete from troncons where observations like '%Lot ${lot}.%';`);
  });
}

main()
  .catch((e) => { console.error("ECHEC :", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
