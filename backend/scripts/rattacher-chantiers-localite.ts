/**
 * Rattacher les chantiers a une region par les localites citees dans leur intitule.
 *
 * SANS `--apply`, LE SCRIPT NE FAIT QUE LIRE.
 *
 * CE QUI DEBLOQUE CE SCRIPT
 *
 * BDRI-CHANTIERS-GEOLOCALISATION.md concluait : « l'appariement par nom de localite
 * est impossible aujourd'hui, non pas parce que les intitules sont pauvres, mais
 * parce que LA CIBLE N'A PAS DE NOMS. Le chainon manquant n'est pas un algorithme,
 * c'est le referentiel administratif. »
 *
 * Ce referentiel est en base depuis le 05/09/2026 : 8 regions, 34 prefectures et 340
 * sous-prefectures issues de COD-AB (OCHA), avec leurs P-codes.
 *
 * Mesure immediate sur les 487 chantiers :
 *
 *     166 ne citent aucune entite connue
 *     193 en citent UNE
 *      95 en citent DEUX — couple origine-destination
 *      33 en citent trois ou plus
 *
 * Soit 321 chantiers porteurs d'un indice geographique exploitable.
 *
 * CE QU'IL RATTACHE, ET CE QU'IL REFUSE
 *
 * Il remonte de chaque entite citee jusqu'a sa region — une sous-prefecture connait
 * sa prefecture, qui connait sa region. Si toutes les entites citees designent LA MEME
 * region, il la retient. Si elles en designent plusieurs, il ne tranche pas : un axe
 * Mamou-Faranah traverse deux regions et aucune des deux n'est plus vraie que l'autre.
 *
 * L'APPARIEMENT PORTE SUR DES MOTS ENTIERS
 *
 * « Labe » ne doit pas se declencher sur « Kolaboue ». Le texte et les noms sont
 * normalises — accents retires, ponctuation remplacee par des espaces — puis compares
 * entoures d'espaces.
 *
 * IL PEUT CONTREDIRE UNE ATTRIBUTION EXISTANTE
 *
 * Un premier rattachement a ete fait le 04/09 sur une liste de localites que j'avais
 * ecrite a la main. Ce script porte sur TOUS les chantiers, pas seulement ceux sans
 * region, precisement pour pouvoir corriger cette liste : un referentiel officiel vaut
 * mieux qu'une curation. Les desaccords sont comptes et affiches avant toute ecriture.
 *
 * Usage :
 *   tsx scripts/rattacher-chantiers-localite.ts            (lecture seule)
 *   tsx scripts/rattacher-chantiers-localite.ts --apply    (ecrit)
 */
import { PrismaClient } from "@prisma/client";
import "dotenv/config";

const prisma = new PrismaClient();

interface Ligne {
  id: string;
  intitule: string;
  region_actuelle: string | null;
  region_deduite: string | null;
  region_deduite_id: number | null;
  regions_candidates: number;
  entites: string;
}

/**
 * Une entite citee remonte a sa region par la chaine des P-codes.
 *
 * Le SQL fait tout le travail : sortir 487 intitules et 382 noms pour les croiser en
 * memoire serait plus lent et moins verifiable qu'une jointure.
 */
const REQUETE = `
  WITH c AS (
    SELECT id, intitule, "regionId",
           ' ' || regexp_replace(unaccent(lower(intitule)), '[^a-z0-9]+', ' ', 'g') || ' ' AS texte
      FROM chantiers WHERE "deletedAt" IS NULL
  ), l AS (
    SELECT pcode, niveau, nom, "parentPcode",
           ' ' || regexp_replace(unaccent(lower(nom)), '[^a-z0-9]+', ' ', 'g') || ' ' AS motif
      FROM limites_admin
  ), citees AS (
    SELECT c.id, l.pcode, l.niveau, l.nom, l."parentPcode"
      FROM c JOIN l ON c.texte LIKE '%' || l.motif || '%'
  ), remontee AS (
    -- Niveau 3 -> prefecture -> region ; niveau 2 -> region ; niveau 1 -> elle-meme.
    SELECT ct.id, ct.nom,
           COALESCE(a1.nom, p1.nom, g1.nom) AS region_nom
      FROM citees ct
      LEFT JOIN limites_admin p2 ON ct.niveau = 3 AND p2.pcode = ct."parentPcode"
      LEFT JOIN limites_admin a1 ON ct.niveau = 3 AND a1.pcode = p2."parentPcode"
      LEFT JOIN limites_admin p1 ON ct.niveau = 2 AND p1.pcode = ct."parentPcode"
      LEFT JOIN limites_admin g1 ON ct.niveau = 1 AND g1.pcode = ct.pcode
  ), agg AS (
    SELECT id,
           count(DISTINCT region_nom) FILTER (WHERE region_nom IS NOT NULL) AS n_regions,
           min(region_nom) FILTER (WHERE region_nom IS NOT NULL)            AS region_unique,
           string_agg(DISTINCT nom, ', ' ORDER BY nom)                      AS entites
      FROM remontee GROUP BY id
  )
  SELECT c.id, c.intitule,
         ra.nom  AS region_actuelle,
         CASE WHEN a.n_regions = 1 THEN a.region_unique END AS region_deduite,
         rd.id   AS region_deduite_id,
         COALESCE(a.n_regions, 0) AS regions_candidates,
         COALESCE(a.entites, '')  AS entites
    FROM c
    LEFT JOIN agg a ON a.id = c.id
    LEFT JOIN regions ra ON ra.id = c."regionId"
    LEFT JOIN regions rd ON a.n_regions = 1
         AND unaccent(lower(rd.nom)) = unaccent(lower(a.region_unique))
   ORDER BY c.intitule
`;

async function main() {
  const appliquer = process.argv.includes("--apply");

  const lignes = await prisma.$queryRawUnsafe<Ligne[]>(REQUETE);

  const sansIndice = lignes.filter((l) => l.regions_candidates === 0);
  const ambigus = lignes.filter((l) => l.regions_candidates > 1);
  const resolus = lignes.filter((l) => l.region_deduite_id != null);

  const aCombler = resolus.filter((l) => l.region_actuelle === "Non renseigné");
  const concordants = resolus.filter(
    (l) => l.region_actuelle !== "Non renseigné" && l.region_actuelle === l.region_deduite,
  );
  const desaccords = resolus.filter(
    (l) => l.region_actuelle !== "Non renseigné" && l.region_actuelle !== l.region_deduite,
  );

  console.log("=== Rattachement des chantiers par localite citee ===");
  console.log(`Mode : ${appliquer ? "ECRITURE" : "LECTURE SEULE (ajouter --apply)"}`);
  console.log("");
  console.log(`Chantiers examines            ${lignes.length}`);
  console.log(`  aucune entite citee         ${sansIndice.length}`);
  console.log(`  plusieurs regions citees    ${ambigus.length}   (non tranches)`);
  console.log(`  une region deduite          ${resolus.length}`);
  console.log("");
  console.log(`    dont a combler (« Non renseigné »)  ${aCombler.length}`);
  console.log(`    dont deja correct                   ${concordants.length}`);
  console.log(`    dont EN DESACCORD                   ${desaccords.length}`);
  console.log("");

  if (desaccords.length > 0) {
    console.log("Desaccords — la region actuelle vient d'une liste ecrite a la main le 04/09,");
    console.log("le referentiel officiel dit autre chose :");
    for (const d of desaccords.slice(0, 12)) {
      console.log(`  ${(d.region_actuelle ?? "?").padEnd(14)} -> ${(d.region_deduite ?? "?").padEnd(14)} ${d.entites.slice(0, 34).padEnd(34)} ${d.intitule.slice(0, 40)}`);
    }
    if (desaccords.length > 12) console.log(`  … et ${desaccords.length - 12} autres`);
    console.log("");
  }

  const aEcrire = [...aCombler, ...desaccords];
  if (!appliquer || aEcrire.length === 0) {
    console.log(appliquer ? "Rien a ecrire." : "LECTURE SEULE — rien n'a ete ecrit.");
    return;
  }

  const maintenant = new Date();
  for (const l of aEcrire) {
    const note =
      `Région déduite des localités citées dans l'intitulé (${l.entites}), remontées `
      + "au référentiel COD-AB (OCHA). "
      + (l.region_actuelle === "Non renseigné"
        ? "Auparavant « Non renseigné »."
        : `Valeur précédente : ${l.region_actuelle} — issue d'une liste manuelle, corrigée par le référentiel officiel.`)
      + " Déduction, pas une saisie : à confirmer sur le dossier de marché.";

    await prisma.$transaction([
      prisma.chantier.update({ where: { id: l.id }, data: { regionId: l.region_deduite_id! } }),
      prisma.valeurQualite.upsert({
        where: { entityType_entityId_champ: { entityType: "Chantier", entityId: l.id, champ: "regionId" } },
        create: {
          entityType: "Chantier", entityId: l.id, champ: "regionId",
          statut: "DERIVED", source: "INTITULE + COD-AB", methode: "REMONTEE_LOCALITE",
          observedAt: maintenant, confiance: "LOW", note,
        },
        update: {
          statut: "DERIVED", source: "INTITULE + COD-AB", methode: "REMONTEE_LOCALITE",
          observedAt: maintenant, confiance: "LOW", note,
        },
      }),
    ]);
  }

  console.log("--- Applique ---");
  console.log(`  chantiers combles        : ${aCombler.length}`);
  console.log(`  chantiers corriges       : ${desaccords.length}`);
  console.log(`  lignes valeurs_qualite   : ${aEcrire.length}`);
  console.log("");
  console.log("Les localites qui ont declenche chaque rattachement figurent dans la note.");
}

main()
  .catch((e) => { console.error("ECHEC :", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
