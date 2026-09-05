/**
 * Nouveau decoupage administratif : deux regions, onze prefectures.
 *
 * SANS `--apply`, LE SCRIPT NE FAIT QUE LIRE.
 *
 * CE QU'ANNONCE LA REFORME
 *
 * Les regions de Siguiri et de Beyla sont creees. Onze sous-prefectures deviennent
 * prefectures : Kamsar (Boke), Timbo (Mamou), Tokounou et Sabadou-Baranama (Kankan),
 * Doko, Siguirini et Kintinian (Siguiri), Sinko, Kouankan et Karala (Beyla), et
 * Dialakoro — dont le rattachement est litigieux, voir plus bas.
 *
 * AUCUNE FRONTIERE N'EST DESSINEE
 *
 * Toutes les emprises se deduisent des polygones officiels deja charges (COD-AB,
 * OCHA), par union et par difference. Verifie avant d'ecrire cette regle : chaque
 * prefecture EST exactement l'union de ses sous-prefectures, a 100,0 % de surface
 * pres, sur les trois prefectures concernees par un transfert. Il n'y a donc ni trou
 * ni recouvrement a redouter.
 *
 *     Region Siguiri     = prefecture Siguiri
 *     Region Beyla       = prefecture Beyla + sous-prefecture Kouankan (contigues)
 *     Region Kankan      = ancienne Kankan    - prefecture Siguiri
 *     Region Nzerekore   = ancienne Nzerekore - prefecture Beyla - Kouankan
 *     Prefecture X residuelle = ancienne X - les sous-prefectures qui la quittent
 *
 * LA COMPOSITION, CONFIRMEE LE 05/09/2026
 *
 * Elle etait deduite au moment d'ecrire ce script, et l'en-tete disait alors qu'elle
 * n'etait pas demontree. Des sources concordantes rapportant le decret du 20 aout 2026
 * l'ont depuis etablie, et elle correspond exactement a ce qui avait ete calcule :
 *
 *     Region Siguiri : Siguiri (chef-lieu), Doko, Siguirini, Kintinian
 *     Region Beyla   : Beyla (chef-lieu), Sinko, Kouankan, Karala
 *
 * Quatre prefectures chacune, et aucune autre. Les emprises derivees ici sont donc
 * completes, non plus seulement plausibles.
 *
 * LE CHEF-LIEU EST UNE PREFECTURE COMME LES AUTRES
 *
 * Un premier jet promouvait les onze et retaillait les regions, mais laissait les
 * prefectures d'ORIGINE — Siguiri et Beyla — rattachees a leur ancienne region. Chaque
 * nouvelle region ne comptait donc que 3 prefectures au lieu de 4, et il manquait
 * 12 249 km2 a Siguiri, 10 022 a Beyla : le polygone de la region etait juste, mais sa
 * composition declaree ne le couvrait pas.
 *
 * L'oubli ne s'est vu qu'en confrontant la base a la composition publiee. Aucun des
 * trois controles d'integrite ne pouvait l'attraper : il n'y avait ni geometrie
 * invalide, ni parent orphelin, ni recouvrement — seulement une hierarchie qui ne
 * decrivait plus le terrain.
 *
 * DIALAKORO — TRANCHE
 *
 * Le texte de presse le placait en region de Kankan ; le referentiel en fait une
 * sous-prefecture de Dinguiraye, region de Faranah. Un seul enregistrement, aucun
 * homonyme, donc pas de confusion possible entre deux lieux du meme nom.
 *
 * L'agence a tranche le 05/09/2026 : Dialakoro releve de Dinguiraye. Le texte etait
 * donc en erreur, et le referentiel avait raison. Dialakoro devient prefecture DANS
 * sa region actuelle, Faranah, comme Kamsar reste en Boke et Timbo en Mamou.
 *
 * La divergence est notee ici plutot qu'effacee : c'est la trace de ce qui a ete
 * verifie, et elle evite qu'on la redecouvre au prochain article de presse.
 *
 * DEUX NIVEAUX DE PREUVE, DEUX PORTES SEPAREES
 *
 * Cinq promotions ne reposent que sur le texte de la reforme : Kamsar, Timbo,
 * Tokounou, Sabadou-Baranama et Dialakoro restent dans leur region actuelle, qui
 * existe deja. Rien n'y est deduit.
 *
 * Les cinq autres exigent en plus que les regions de Siguiri et de Beyla existent, donc
 * que l'hypothese de composition tienne. Elles restent derriere `--regions-deduites`,
 * pour qu'on ne puisse pas les appliquer sans l'avoir voulu.
 *
 * Usage :
 *   tsx scripts/appliquer-decoupage-2026.ts                           (lecture seule)
 *   tsx scripts/appliquer-decoupage-2026.ts --apply                   (les 5 sures)
 *   tsx scripts/appliquer-decoupage-2026.ts --regions-deduites --apply
 */
import { PrismaClient } from "@prisma/client";
import "dotenv/config";

const prisma = new PrismaClient();

/** Provenance de tout ce que ce script ecrit. Distincte de COD-AB seul. */
/**
 * Provenance de tout ce que ce script ecrit.
 *
 * Elle disait « composition deduite » tant que la composition des deux regions
 * relevait d'une inference. Des sources concordantes rapportant le decret du
 * 20 aout 2026 l'ont confirmee le 05/09 : la mention change, parce qu'un auditeur qui
 * lit « deduite » ecarte a juste titre la donnee, et qu'elle ne l'est plus.
 *
 * Le trace, lui, reste derive de COD-AB par union et difference : aucune frontiere
 * n'a ete dessinee, et la source le dit toujours.
 */
const SOURCE = "Decret du 20/08/2026 (composition confirmee) + COD-AB / OCHA";

interface Promotion {
  /** Nom de la sous-prefecture, tel qu'il figure dans limites_admin. */
  nom: string;
  /** Region d'accueil : pcode existant, ou clef d'une region creee ici. */
  region: string;
}

/** Les onze promotions du decret. */
const PROMOTIONS: Promotion[] = [
  { nom: "Kamsar", region: "GN001" },            // Boke, inchangee
  { nom: "Timbo", region: "GN007" },             // Mamou, inchangee
  { nom: "Tokounou", region: "GN004" },          // Kankan, inchangee
  { nom: "Sabadou Baranama", region: "GN004" },  // Kankan, inchangee
  // Faranah et non Kankan : arbitrage de l'agence du 05/09/2026, conforme au
  // referentiel (sous-prefecture de Dinguiraye) et contraire au texte de presse.
  { nom: "Dialakoro", region: "GN003" },
  { nom: "Doko", region: "GN013" },              // nouvelle region Siguiri
  { nom: "Siguirini", region: "GN013" },
  { nom: "Kintinian", region: "GN013" },
  { nom: "Sinko", region: "GN014" },             // nouvelle region Beyla
  { nom: "Karala", region: "GN014" },
  { nom: "Kouankan", region: "GN014" },          // quitte Macenta
];

/** Regions creees, et la formule qui donne leur emprise. */
const REGIONS_NOUVELLES = [
  {
    pcode: "GN013",
    nom: "Siguiri",
    // L'ancienne prefecture, telle quelle.
    formule: `SELECT geom FROM limites_admin WHERE niveau = 2 AND unaccent(lower(nom)) = 'siguiri'`,
    detache: [{ de: "GN004", quoi: "prefecture Siguiri" }],
  },
  {
    pcode: "GN014",
    nom: "Beyla",
    // L'ancienne prefecture, plus Kouankan qui quitte Macenta. Contiguite verifiee.
    formule: `SELECT ST_Multi(ST_Union(geom)) AS geom FROM limites_admin
               WHERE (niveau = 2 AND unaccent(lower(nom)) = 'beyla')
                  OR (niveau = 3 AND unaccent(lower(nom)) = 'kouankan')`,
    detache: [{ de: "GN008", quoi: "prefecture Beyla et Kouankan" }],
  },
];

function normaliser(n: string): string {
  return n.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
}

async function main() {
  const appliquer = process.argv.includes("--apply");
  const regionsDeduites = process.argv.includes("--regions-deduites");
  // Sans `--regions-deduites`, on s'en tient a ce qui ne suppose rien : les
  // promotions dont la region d'accueil existe deja au referentiel.
  const promotions = regionsDeduites
    ? [...PROMOTIONS]
    : PROMOTIONS.filter((p) => !REGIONS_NOUVELLES.some((r) => r.pcode === p.region));
  const retenues = PROMOTIONS.length - promotions.length;

  // ---- Etat de depart, mesure et non suppose ----
  const avant = await prisma.$queryRawUnsafe<{ niveau: number; entites: bigint }[]>(
    `SELECT niveau, count(*) AS entites FROM limites_admin GROUP BY niveau ORDER BY niveau`
  );

  const cibles = await prisma.$queryRawUnsafe<
    { nom: string; pcode: string; niveau: number; parent: string | null }[]
  >(
    `SELECT sp.nom, sp.pcode, sp.niveau, p.nom AS parent
       FROM limites_admin sp LEFT JOIN limites_admin p ON p.pcode = sp."parentPcode"
      WHERE sp.niveau = 3 AND unaccent(lower(sp.nom)) = ANY($1::text[])`,
    promotions.map((p) => normaliser(p.nom))
  );

  console.log("=== Nouveau decoupage administratif ===");
  console.log(`Mode : ${appliquer ? "ECRITURE" : "LECTURE SEULE (ajouter --apply)"}`);
  console.log("");
  console.log("Etat actuel du referentiel :");
  for (const n of avant) {
    const nom = { 1: "regions", 2: "prefectures", 3: "sous-prefectures" }[n.niveau] ?? `niveau ${n.niveau}`;
    console.log(`  ${String(n.entites).padStart(4)}  ${nom}`);
  }
  console.log("");

  // Une promotion dont on ne trouve pas la cible doit ARRETER le script : la
  // reforme est un tout, et l'appliquer a moitie laisserait un referentiel
  // incoherent que personne ne saurait relire.
  const introuvables = promotions.filter(
    (p) => !cibles.some((c) => normaliser(c.nom) === normaliser(p.nom))
  );
  if (introuvables.length > 0) {
    throw new Error(
      `Introuvables au niveau 3 : ${introuvables.map((p) => p.nom).join(", ")}. ` +
      "Le referentiel a change depuis la redaction de ce script."
    );
  }

  console.log(`Promotions : ${promotions.length} sous-prefectures -> prefectures`);
  for (const p of promotions) {
    const c = cibles.find((x) => normaliser(x.nom) === normaliser(p.nom))!;
    const nouvelle = REGIONS_NOUVELLES.find((r) => r.pcode === p.region);
    const dest = nouvelle ? `${nouvelle.nom} (NOUVELLE region)` : p.region;
    console.log(`  ${c.nom.padEnd(18)} ${String(c.parent ?? "?").padEnd(12)} -> ${dest}`);
  }
  console.log("");

  console.log("Dialakoro : Faranah, et non Kankan comme l'annoncait le texte de presse.");
  console.log("  Arbitrage de l'agence, conforme au referentiel (sous-prefecture de");
  console.log("  Dinguiraye). Un seul enregistrement, aucun homonyme.");
  console.log("");

  if (regionsDeduites) {
    console.log("Regions creees, par derivation des polygones officiels :");
    for (const r of REGIONS_NOUVELLES) {
      console.log(`  ${r.pcode} ${r.nom.padEnd(10)} detache de ${r.detache.map((d) => `${d.quoi} (${d.de})`).join(", ")}`);
    }
  } else if (retenues > 0) {
    console.log(`${retenues} promotions RETENUES : elles supposent les regions de Siguiri`);
    console.log("et de Beyla, dont la composition est deduite et non documentee.");
    console.log("  Doko, Siguirini, Kintinian, Sinko, Karala, Kouankan");
    console.log("  Ajouter --regions-deduites pour les appliquer aussi.");
  }
  console.log("");

  if (!appliquer) {
    console.log("LECTURE SEULE — rien n'a ete ecrit.");
    console.log("");
    console.log("Composition confirmee le 05/09/2026 par sources concordantes :");
    console.log("  Siguiri : Siguiri (chef-lieu), Doko, Siguirini, Kintinian");
    console.log("  Beyla   : Beyla (chef-lieu), Sinko, Kouankan, Karala");
    console.log("Quatre prefectures chacune, et aucune autre.");
    return;
  }

  await prisma.$transaction(
    async (tx) => {
      /**
       * 0. Archiver ce qui va etre modifie.
       *
       * Les etapes suivantes retaillent des polygones par difference : rien ne les
       * reconstitue en place. Sans archive, le retour arriere exigerait une
       * restauration complete de la base — disproportionne pour annuler une dizaine
       * de lignes, et donc une operation qu'on hesiterait a lancer.
       */
      await tx.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS limites_admin_archive AS
           SELECT *, NULL::timestamp AS "archiveA" FROM limites_admin WHERE false`
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO limites_admin_archive
         SELECT l.*, now() FROM limites_admin l
          WHERE l.pcode IN ('GN004','GN008')
             OR (l.niveau = 3 AND unaccent(lower(l.nom)) = ANY($1::text[]))
             OR l.pcode IN (SELECT DISTINCT sp."parentPcode" FROM limites_admin sp
                             WHERE sp.niveau = 3 AND unaccent(lower(sp.nom)) = ANY($1::text[]))`,
        promotions.map((p) => normaliser(p.nom))
      );

      // 1 et 2. Les regions : creation, puis retrait de leur ancienne region.
      //
      // Conditionnels a `--regions-deduites`, et EUX SEULS. Les etapes 3 et 4 valent
      // pour toute promotion, y compris les quatre qui ne supposent rien — un premier
      // jet placait le garde avant elles, ce qui archivait puis ne faisait rien.
      if (regionsDeduites) {
      for (const r of REGIONS_NOUVELLES) {
        await tx.$executeRawUnsafe(
          `INSERT INTO limites_admin (pcode, niveau, nom, "parentPcode", source, "sourceDate", "validOn", geom)
           SELECT $1, 1, $2, NULL, $3, CURRENT_DATE, CURRENT_DATE, ST_Multi(g.geom)
             FROM (${r.formule}) g
           ON CONFLICT (pcode) DO NOTHING`,
          r.pcode, r.nom, SOURCE
        );
      }

      // 2. Les regions d'origine retrecissent d'autant. ST_Difference et non un
      //    redessin : le trace des frontieres restantes est celui de COD-AB, au
      //    point pres.
      await tx.$executeRawUnsafe(
        `UPDATE limites_admin r
            SET geom = ST_Multi(ST_Difference(r.geom, n.geom)), source = $1, "validOn" = CURRENT_DATE
           FROM limites_admin n
          WHERE n.pcode = 'GN013' AND r.pcode = 'GN004'`,
        SOURCE
      );
      await tx.$executeRawUnsafe(
        `UPDATE limites_admin r
            SET geom = ST_Multi(ST_Difference(r.geom, n.geom)), source = $1, "validOn" = CURRENT_DATE
           FROM limites_admin n
          WHERE n.pcode = 'GN014' AND r.pcode = 'GN008'`,
        SOURCE
      );
      }

      // 3. Les prefectures d'origine perdent les sous-prefectures promues.
      await tx.$executeRawUnsafe(
        `UPDATE limites_admin p
            SET geom = ST_Multi(ST_Difference(p.geom, partis.geom)), source = $2, "validOn" = CURRENT_DATE
           FROM (SELECT sp."parentPcode" AS pcode, ST_Union(sp.geom) AS geom
                   FROM limites_admin sp
                  WHERE sp.niveau = 3 AND unaccent(lower(sp.nom)) = ANY($1::text[])
                  GROUP BY sp."parentPcode") partis
          WHERE p.pcode = partis.pcode`,
        promotions.map((p) => normaliser(p.nom)), SOURCE
      );

      // 3 bis. Le chef-lieu suit sa region.
      //
      // La prefecture d'origine devient une prefecture de la NOUVELLE region. Sans
      // cette etape, elle reste declaree dans l'ancienne, et la region ne contient
      // que les sous-prefectures promues — soit 3 des 4 prefectures annoncees.
      for (const [prefecture, region] of [["siguiri", "GN013"], ["beyla", "GN014"]]) {
        await tx.$executeRawUnsafe(
          `UPDATE limites_admin SET "parentPcode" = $2, source = $3, "validOn" = CURRENT_DATE
            WHERE niveau = 2 AND unaccent(lower(nom)) = $1`,
          prefecture, region, SOURCE
        );
      }

      // 4. La promotion elle-meme. La geometrie ne bouge pas : l'emprise d'une
      //    prefecture nouvelle vaut AU MOINS celle de l'ancienne sous-prefecture.
      for (const p of promotions) {
        await tx.$executeRawUnsafe(
          `UPDATE limites_admin
              SET niveau = 2, "parentPcode" = $2, source = $3, "validOn" = CURRENT_DATE
            WHERE niveau = 3 AND unaccent(lower(nom)) = $1`,
          normaliser(p.nom), p.region, SOURCE
        );
      }
    },
    { timeout: 300_000, maxWait: 60_000 }
  );

  // ---- Controles APRES ecriture, sur la base et non sur les intentions ----
  const apres = await prisma.$queryRawUnsafe<{ niveau: number; entites: bigint }[]>(
    `SELECT niveau, count(*) AS entites FROM limites_admin GROUP BY niveau ORDER BY niveau`
  );
  const invalides = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*) AS n FROM limites_admin WHERE geom IS NULL OR NOT ST_IsValid(geom)`
  );
  const orphelines = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*) AS n FROM limites_admin c
      WHERE c."parentPcode" IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM limites_admin p WHERE p.pcode = c."parentPcode")`
  );
  const recouvrements = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*) AS n FROM limites_admin a JOIN limites_admin b
        ON a.niveau = 1 AND b.niveau = 1 AND a.pcode < b.pcode
      WHERE ST_Overlaps(a.geom, b.geom)`
  );

  console.log("--- Applique ---");
  for (const n of apres) {
    const nom = { 1: "regions", 2: "prefectures", 3: "sous-prefectures" }[n.niveau] ?? `niveau ${n.niveau}`;
    console.log(`  ${String(n.entites).padStart(4)}  ${nom}`);
  }
  console.log("");
  console.log("Controles d'integrite (0 attendu partout) :");
  console.log(`  geometries nulles ou invalides : ${invalides[0].n}`);
  console.log(`  references de parent orphelines : ${orphelines[0].n}`);
  console.log(`  regions qui se recouvrent       : ${recouvrements[0].n}`);
  console.log("");
  console.log("Retour arriere — les lignes touchees sont archivees :");
  console.log(`  delete from limites_admin where pcode in ('GN013','GN014');`);
  console.log(`  update limites_admin l set niveau = a.niveau, "parentPcode" = a."parentPcode",`);
  console.log(`         geom = a.geom, source = a.source, "validOn" = a."validOn"`);
  console.log(`    from limites_admin_archive a where a.pcode = l.pcode;`);
  console.log(`  delete from limites_admin_archive;`);
}

main()
  .catch((e) => { console.error("ECHEC :", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
