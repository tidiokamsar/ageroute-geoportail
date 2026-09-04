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
 * Il prend une emprise, une liste de categories, et rend compte de chaque valeur
 * qu'il n'a pas trouvee.
 *
 * A L'ECHELLE DU PAYS : `--tuiles`
 *
 * Le plafond ordinaire de 0,25 deg² protege une promotion ponctuelle d'un derapage.
 * Une execution nationale assumee passe par `--tuiles=0.5`, qui decoupe l'emprise et
 * traite chaque tuile dans SA PROPRE TRANSACTION. Un seul bloc sur 262 306 lignes
 * tiendrait un verrou long sur `troncons` pendant que l'application sert la carte, et
 * un echec tardif annulerait tout. Ici, ce qui est pose reste pose.
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
 *     revetement   selon --revetement, meme regle que --etat
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
 * `--etat` ET `--revetement` : LES DEUX DECISIONS METIER
 *
 * Par defaut NON_EVALUE et NON_RENSEIGNE, qui sont la verite : personne n'a inspecte
 * ces voies, et la source ne porte pas la couche de roulement.
 *
 * Toute autre valeur est traitee comme une DECLARATION. Elle est acceptee — un
 * gestionnaire peut connaitre son reseau sans l'avoir formellement inspecte — mais
 * elle est enregistree comme IMPORTED_UNVERIFIED, avec sa date, pour que les tableaux
 * de bord puissent l'exclure. Une declaration n'est pas une mesure.
 *
 * C'est ce qui permet d'appliquer une regle metier par lot sans mentir : « les grands
 * axes du Grand Conakry sont bitumes et en bon etat » devient un passage avec
 * --categories=VOIE_RAPIDE,PRINCIPALE,SECONDAIRE,TERTIAIRE --etat=BON
 * --revetement=BITUME, et chaque troncon cree porte la trace que ces deux valeurs
 * sont declarees.
 *
 * Contexte a garder en tete : au 03/09/2026 le pays compte 121 troncons BON sur
 * 1 690. Une declaration large deplace cet indicateur sans qu'aucune route ne se soit
 * amelioree — d'ou la trace, qui permet de le recalculer sans elles.
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
 *   ... --revetement=BITUME   (declaration ; defaut NON_RENSEIGNE)
 *   ... --tuiles=0.5          (decoupe une emprise a l'echelle du pays)
 *   ... --apply               (ecrit ; sans lui, lecture seule)
 */
import { PrismaClient } from "@prisma/client";
import "dotenv/config";
import {
  analyserEmprise, analyserEmpriseEtendue, decouperEnTuiles, analyserCategories,
  analyserPrefixe, analyserEtat, analyserClasse, analyserRevetement,
  estDeclaration, revetementDeclare, casLibelleSql,
  type Emprise,
} from "./lib/promotion";

const prisma = new PrismaClient();

function argument(nom: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${nom}=`));
  return p ? p.slice(nom.length + 3) : undefined;
}

async function main() {
  // `--tuiles` accepte une emprise a l'echelle du pays et la decoupe ; sans lui, le
  // plafond ordinaire de 0,25 deg² s'applique.
  const cote = Number(argument("tuiles") ?? 0);
  const tuile = Number.isFinite(cote) && cote > 0;
  const emprise: Emprise = tuile
    ? analyserEmpriseEtendue(argument("bbox"))
    : analyserEmprise(argument("bbox"));
  const emprises: Emprise[] = tuile ? decouperEnTuiles(emprise, cote) : [emprise];
  const [ouest, sud, est, nord] = emprise;
  const categories = analyserCategories(argument("categories"));
  const prefixe = analyserPrefixe(argument("prefixe"));
  const classe = analyserClasse(argument("classe"));
  const etat = analyserEtat(argument("etat"));
  const revetement = analyserRevetement(argument("revetement"));
  const regionId = Number(argument("region") ?? 1);
  const appliquer = process.argv.includes("--apply");
  /**
   * Ecarte les voies qui doublent le reseau de reference.
   *
   * Mesure du 04/09/2026 : sur les 5 097 grands axes OSM restants, 2 926 passent a
   * moins de 25 m d'un troncon deja en base, et representent 15 493 des 21 211 km —
   * 73 %. Les voies rapides sont a 98 % les memes routes physiques. Les promouvoir
   * compterait le reseau national deux fois.
   *
   * 25 m, et non zero : deux relevés du meme axe ne se superposent jamais au metre
   * pres. C'est le seuil retenu par la comparaison BDRI/OSM de la phase 4.
   *
   * Le test porte sur `geometry` et non `geography` : ST_DWithin n'utilise l'index
   * GIST que sur la premiere, et le plan devient quadratique sur la seconde.
   * 0,000225 degre vaut environ 25 m a la latitude de la Guinee.
   */
  const sansDoublons = process.argv.includes("--sans-doublons");
  const clauseDoublon = sansDoublons
    ? `and not exists (
         select 1 from troncons t
          where t."deletedAt" is null and t.geom is not null
            and (t."sourceReference" is null or t."sourceReference" not like 'voirie_locale:%')
            and ST_DWithin(v.geom, t.geom, 0.000225)
       )`
    : "";
  if (!Number.isInteger(regionId)) throw new Error("--region attend un entier.");

  const region = await prisma.region.findUnique({ where: { id: regionId } });
  if (!region) throw new Error(`--region ${regionId} : region inexistante.`);

  const declare = estDeclaration(etat);
  const revDeclare = revetementDeclare(revetement);

  console.log("=== Promotion de voirie locale en troncons ===");
  console.log(`Emprise      : ${ouest},${sud},${est},${nord}`
    + (tuile ? `   decoupee en ${emprises.length} tuiles de ${cote}°` : ""));
  console.log(`Categories   : ${categories.join(", ")}`);
  console.log(`Classe       : ${classe}   Region : ${region.nom} (${regionId})   Prefixe : ${prefixe}`);
  console.log(`Etat         : ${etat}${declare ? "   << DECLARATION, enregistree comme non verifiee" : "   (aucune inspection : c'est la verite)"}`);
  console.log(`Revetement   : ${revetement}${revDeclare ? "   << DECLARATION, enregistree comme non verifiee" : "   (absent de la source)"}`);
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
        ${clauseDoublon}
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
  console.log(`  revetement  ${revDeclare ? "IMPORTED_UNVERIFIED" : "UNKNOWN  "}   ${total} lignes${revDeclare ? ` — ${revetement} declare le ` + new Date().toISOString().slice(0, 10) : " — OSM porte NATURE, pas la couche de roulement"}`);
  console.log(`  etat        ${declare ? "IMPORTED_UNVERIFIED" : "UNKNOWN  "}   ${total} lignes${declare ? " — declaration du " + new Date().toISOString().slice(0, 10) : ""}`);
  console.log(`  longueurKm  DERIVED   ${total} lignes — calcul geometrique`);
  console.log(`  pkDebut/Fin DERIVED   ${total * 2} lignes — kilometrage local 0 -> longueur`);
  console.log(`  regionId    ${regionId === 9 ? "UNKNOWN" : "DERIVED"}   ${total} lignes — ${regionId === 9 ? "aucun decoupage administratif en base" : "deduction, l'emprise est un rectangle"}`);
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

  let cumulTroncons = 0, cumulLiees = 0, cumulQualite = 0, tuilesVides = 0;

  /**
   * Une tuile, une transaction.
   *
   * Un seul bloc sur 262 306 lignes tiendrait un verrou long sur `troncons` pendant
   * que l'application sert la carte, et un echec a la 250 000e ligne annulerait tout.
   * Ici ce qui est pose reste pose, et la reprise est gratuite : le script est
   * idempotent.
   */
  async function promouvoirTuile([ouest, sud, est, nord]: Emprise) {
    return prisma.$transaction(async (tx) => {
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
                $12::"Revetement",
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
            ${clauseDoublon}
         on conflict (code) do nothing`,
        ouest, sud, est, nord, categories, prefixe,
        classe, regionId, etat, lot, maintenant, revetement,
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
             ('revetement', $7::text, $8::text, $9::text, 'LOW', $10::text),
             ('etat', $3::text, $4::text, $5::text, 'LOW', $6::text),
             ('longueurKm', 'DERIVED', 'ST_Length(geom::geography)', 'CALCUL_GEOMETRIQUE', 'MEDIUM',
              'Longueur du trace. Aucune longueur metier n''existait pour cette voie.'),
             ('pkDebut', 'DERIVED', 'convention', 'CALCUL_GEOMETRIQUE', 'LOW',
              'Kilometrage local : 0 au debut du trace. Non raccorde au PK de la route.'),
             ('pkFin', 'DERIVED', 'ST_Length(geom::geography)', 'CALCUL_GEOMETRIQUE', 'LOW',
              'Kilometrage local : longueur du trace. Non raccorde au PK de la route.'),
             ('regionId', $11::text, 'emprise geographique', 'DEDUCTION_ADMINISTRATIVE', 'LOW', $12::text)
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
        revDeclare ? "IMPORTED_UNVERIFIED" : "UNKNOWN",
        revDeclare ? "DECLARATION_GESTIONNAIRE" : "OSM ROUTE.shp",
        revDeclare ? "DECLARATION" : "ABSENT_DE_LA_SOURCE",
        revDeclare
          ? `Revetement ${revetement} declare le ${maintenant.toISOString().slice(0, 10)}, sans releve. La source ne porte pas la couche de roulement.`
          : "La source decrit la praticabilite (NATURE), pas la couche de roulement.",
        // Rattacher a « Non renseigne » n'est pas une deduction, c'est un aveu : aucun
        // decoupage administratif n'existe en base, donc rien ne permet de trancher.
        regionId === 9 ? "UNKNOWN" : "DERIVED",
        regionId === 9
          ? "Aucun decoupage administratif n'est en base ; la region reste indeterminee. Voir docs/phase5/P5-REFERENTIEL-EXTERNE-2026.md."
          : "Deduit de l'emprise, qui est un rectangle et non une limite administrative. Aucun decoupage officiel n'est en base.",
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

      return { crees: Number(crees), liees: Number(liees), qualite: Number(qualite) + Number(noms) };
    });
  }

  for (const [i, t] of emprises.entries()) {
    const r = await promouvoirTuile(t);
    cumulTroncons += r.crees;
    cumulLiees += r.liees;
    cumulQualite += r.qualite;
    if (r.crees === 0) tuilesVides++;
    // Une ligne par tuile productive seulement : sur deux cents tuiles, journaliser
    // les vides noierait ce qui compte.
    if (r.crees > 0 || !tuile) {
      console.log(
        `  tuile ${String(i + 1).padStart(3)}/${emprises.length}  ` +
        `${t.map((v) => v.toFixed(2)).join(",")}  ` +
        `${String(r.crees).padStart(6)} troncons, ${String(r.qualite).padStart(7)} lignes de qualite`,
      );
    }
  }

  console.log("");
  console.log("--- Applique ---");
  console.log(`  troncons crees            : ${cumulTroncons}`);
  console.log(`  voies rattachees          : ${cumulLiees}`);
  console.log(`  lignes valeurs_qualite    : ${cumulQualite}`);
  if (tuile) console.log(`  tuiles sans aucune voie   : ${tuilesVides} sur ${emprises.length}`);
  console.log("");

  const cible = `(select id from troncons where observations like '%Lot ${lot}.%')`;
  console.log("Retour arriere :");
  console.log(`  delete from valeurs_qualite where "entityType"='Troncon' and "entityId" in ${cible};`);
  console.log(`  update voirie_locale set "tronconId"=null, statut='SOURCE_EXTERNE' where "tronconId" in ${cible};`);
  console.log(`  delete from troncons where observations like '%Lot ${lot}.%';`);
}

main()
  .catch((e) => { console.error("ECHEC :", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
