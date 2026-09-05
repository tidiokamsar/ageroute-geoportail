/**
 * Promouvoir en ouvrages les ponts reperes sur le reseau structurant.
 *
 * SANS `--apply`, LE SCRIPT NE FAIT QUE LIRE.
 *
 * LE PERIMETRE, ET POURQUOI IL EST CELUI-LA
 *
 * La source porte 3 178 franchissements. Trois exclusions, chacune mesuree :
 *
 * LES 441 GUES. Un gue est l'ABSENCE d'ouvrage — un passage amenage dans le lit du
 * cours d'eau. L'inventaire d'ouvrages d'art sert a programmer inspections et
 * rehabilitations de structures ; un gue n'a ni l'une ni l'autre.
 *
 * LES 39 TUNNELS. Longueur mediane 14 m, minimum 2 m, portes par des chemins non
 * carrossables et des voies pietonnes. Un « tunnel » de 2 metres sur un sentier est
 * une buse ou un passage couvert. La Guinee n'a pas 39 tunnels routiers.
 *
 * LES 1 731 PONTS HORS RESEAU STRUCTURANT. Portes par des routes non classifiees, des
 * chemins, des voies residentielles ou pietonnes. Ils restent consultables sur la
 * carte et promouvables un par un par le bouton existant — c'est le circuit prevu, et
 * il trace chaque ajout au journal d'audit.
 *
 * Restent 969 ponts portes par une voie rapide, primaire, secondaire ou tertiaire :
 * ceux dont la ruine couperait un axe national ou regional. Moins 6 qui passent a
 * moins de 250 m d'un ouvrage deja inventorie — des doublons.
 *
 * SOIT 963. Un inventaire qui passerait de 126 a 2 824 dont 1 700 passerelles
 * cesserait d'etre un registre d'actifs pour devenir une carte.
 *
 * CE QUE VAUT LE CHIFFRE
 *
 * 963 ponts sur environ 21 000 km de reseau classe, soit un pont tous les 22 km. Pour
 * l'hydrographie guineenne, c'est plausible et sans doute bas. AGEROUTE en a
 * inventorie 126 : son inventaire couvre donc environ 13 % des ponts de son propre
 * reseau. C'est le constat, et il ne se corrige pas par un import — seulement par des
 * visites.
 *
 * CE QUI EST INVENTE, ET COMMENT ON LE DIT
 *
 * `nom` est obligatoire et manque a 904 des 963 : il est genere depuis la voie portee
 * et l'identifiant source, et trace UNKNOWN. `etat` reste NON_EVALUE — personne ne les
 * a inspectes. `regionId` vient de l'intersection avec les limites administratives.
 *
 * Usage :
 *   tsx scripts/promouvoir-franchissements.ts <fichier.geojson>            (lecture seule)
 *   tsx scripts/promouvoir-franchissements.ts <fichier.geojson> --apply    (ecrit)
 */
import fs from "fs";
import { lire } from "./lib/franchissements";
import { PrismaClient } from "@prisma/client";
import "dotenv/config";

const prisma = new PrismaClient();

async function main() {
  const fichier = process.argv[2];
  const appliquer = process.argv.includes("--apply");
  if (!fichier || !fs.existsSync(fichier)) {
    throw new Error("Usage : tsx scripts/promouvoir-franchissements.ts <fichier.geojson> [--apply]");
  }

  const { retenus, exclus } = lire(fichier);
  const nonRenseignee = await prisma.region.findFirst({ where: { nom: "Non renseigné" } });
  if (!nonRenseignee) throw new Error("Region « Non renseigné » introuvable.");

  const deja = await prisma.ouvrage.count({ where: { deletedAt: null } });

  console.log("=== Promotion des franchissements en ouvrages ===");
  console.log(`Mode : ${appliquer ? "ECRITURE" : "LECTURE SEULE (ajouter --apply)"}`);
  console.log("");
  console.log("Ecartes :");
  for (const [motif, n] of Object.entries(exclus)) {
    if (n > 0) console.log(`  ${String(n).padStart(5)}  ${motif}`);
  }
  console.log("");
  console.log(`Retenus : ${retenus.length} ponts du reseau structurant`);
  console.log(`  portant un nom de source : ${retenus.filter((r) => r.nomSource).length}`);
  console.log(`  nom genere               : ${retenus.filter((r) => !r.nomSource).length}`);
  console.log("");
  console.log(`Inventaire : ${deja} ouvrages -> ${deja + retenus.length}`);
  console.log("");

  if (!appliquer) {
    console.log("LECTURE SEULE — rien n'a ete ecrit.");
    return;
  }

  const maintenant = new Date();
  let presentes = 0;
  let ecrites = 0;

  for (let i = 0; i < retenus.length; i += 100) {
    const lot = retenus.slice(i, i + 100);
    const effets = await prisma.$transaction(
      lot.map((r) =>
        prisma.$executeRawUnsafe(
          `INSERT INTO ouvrages
             (id, nom, type, etat, "regionId", "longueurM", remarques,
              "sourceType", "sourceReference", "sourceConfidence", "sourceDetectedAt",
              geom, "createdAt", "updatedAt")
           VALUES (gen_random_uuid()::text, $1, 'PONT'::"TypeOuvrage",
                   'NON_EVALUE'::"EtatPatrimoine",
                   -- La region vient de l'intersection avec les limites officielles ;
                   -- « Non renseigne » seulement si le point tombe hors de toutes.
                   COALESCE((
                     SELECT r.id FROM limites_admin l
                       JOIN regions r ON unaccent(lower(r.nom)) = unaccent(lower(l.nom))
                      WHERE l.niveau = 1
                        AND ST_Intersects(l.geom, ST_SetSRID(ST_MakePoint($3, $2), 4326))
                      LIMIT 1
                   ), $7::int),
                   $4::float8,
                   'Repris d''une source cartographique externe : pont sur ' || $5 ||
                   '. Aucune inspection. Region deduite par intersection.',
                   'IMPORT_DOCUMENTE'::"SourceType", $6, 'LOW'::"NiveauConfiance", $8::timestamp,
                   ST_SetSRID(ST_MakePoint($3, $2), 4326), now(), now())
           -- L'index d'unicite est PARTIEL (WHERE "sourceReference" IS NOT NULL) :
           -- PostgreSQL exige que la clause ON CONFLICT reprenne son predicat, sinon
           -- il ne sait pas quel index viser et rejette la requete (42P10).
           ON CONFLICT ("sourceReference") WHERE "sourceReference" IS NOT NULL
           DO NOTHING`,
          r.nom, r.lat, r.lon, r.longueurM, r.nature,
          `ouvrage_osm:${r.cle}`, nonRenseignee.id, maintenant,
        ),
      ),
      { timeout: 300_000 },
    );

    /**
     * COMPTER CE QUI EST ECRIT, PAS CE QUI EST PRESENTE.
     *
     * `$executeRawUnsafe` rend le nombre de lignes affectees : 1 si l'insertion a eu
     * lieu, 0 si ON CONFLICT DO NOTHING l'a ecartee. La premiere version faisait
     * `crees += lot.length` — elle comptait donc les intentions.
     *
     * Le 05/09, 963 ponts ont ete presentes et 614 ecrits. L'ecart n'est apparu qu'en
     * recomptant la table apres coup : le compteur, lui, annoncait 963. Un ON CONFLICT
     * DO NOTHING est un silence par construction ; le seul moyen de l'entendre est de
     * lire ce que la base repond.
     */
    presentes += lot.length;
    ecrites += (effets as number[]).reduce((a, b) => a + b, 0);
  }

  if (ecrites !== presentes) {
    console.log("");
    console.log(`ATTENTION : ${presentes - ecrites} ponts presentes n'ont pas ete ecrits.`);
    console.log("  Soit ils etaient deja en base (import rejoue), soit deux ponts");
    console.log("  partagent une cle — auquel cas la cle est fausse, pas la source.");
    console.log("");
  }

  // La provenance de chaque valeur inventee, comme pour les troncons promus.
  const qualite = await prisma.$executeRawUnsafe(
    `INSERT INTO valeurs_qualite (id, "entityType", "entityId", champ, statut, source, methode, "observedAt", confiance, note, "createdAt", "updatedAt")
     SELECT gen_random_uuid()::text, 'Ouvrage', o.id, q.champ, q.statut::"StatutValeur",
            q.source, q.methode, $1::timestamp, 'LOW'::"NiveauConfiance", q.note, now(), now()
       FROM ouvrages o
       CROSS JOIN LATERAL (VALUES
         ('etat', 'UNKNOWN', 'AUCUNE', 'AUCUNE',
          'Aucune inspection. L''etat de cet ouvrage est inconnu.'),
         ('regionId', 'DERIVED', 'COD-AB / OCHA', 'INTERSECTION_GEOMETRIQUE',
          'Region deduite de la position, pas d''une saisie.')
       ) AS q(champ, statut, source, methode, note)
      WHERE o."sourceDetectedAt" = $1::timestamp
     ON CONFLICT ("entityType", "entityId", champ) DO NOTHING`,
    maintenant,
  );

  const noms = await prisma.$executeRawUnsafe(
    `INSERT INTO valeurs_qualite (id, "entityType", "entityId", champ, statut, source, methode, "observedAt", confiance, note, "createdAt", "updatedAt")
     SELECT gen_random_uuid()::text, 'Ouvrage', o.id, 'nom', 'UNKNOWN'::"StatutValeur",
            'source externe', 'ABSENT_DE_LA_SOURCE', $1::timestamp, 'LOW'::"NiveauConfiance",
            'Ouvrage non nomme dans la source. Le libelle affiche est genere.', now(), now()
       FROM ouvrages o
      WHERE o."sourceDetectedAt" = $1::timestamp AND o.nom LIKE 'Pont sur %'
     ON CONFLICT ("entityType", "entityId", champ) DO NOTHING`,
    maintenant,
  );

  const total = await prisma.ouvrage.count({ where: { deletedAt: null } });

  console.log("--- Applique ---");
  console.log(`  ouvrages crees          : ${total - deja} (sur ${presentes} presentes)`);
  console.log(`  lignes ecartees         : ${presentes - ecrites}`);
  console.log(`  lignes valeurs_qualite  : ${qualite + noms}`);
  console.log(`  inventaire total        : ${total}`);
  console.log("");
  console.log("Retour arriere :");
  console.log(`  delete from valeurs_qualite where "entityType"='Ouvrage' and "entityId" in`);
  console.log(`    (select id from ouvrages where "sourceReference" like 'ouvrage_osm:%');`);
  console.log(`  delete from ouvrages where "sourceReference" like 'ouvrage_osm:%';`);
}

main()
  .catch((e) => { console.error("ECHEC :", e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
