// Banc d'integration PostGIS : voir tests-integration/README.md. Lancer : npx tsx tests-integration/metadonnees.integration.ts
import "./lib/garde";
// Integration : metadonnees ISO 19115 contre PostGIS reel (base de rejeu locale), transaction ANNULEE.
import { PrismaClient } from "@prisma/client";
import { CATALOGUE } from "../src/metadonnees/catalogue.referentiel";
import { contexteDe, xmlDe } from "../src/metadonnees/metadonnees.service";
import { verifier, conclure } from "./lib/verdict";

const prisma = new PrismaClient();
const ROLLBACK = new Error("ROLLBACK_VOULU");
const OPT = { organisme: "AGEROUTE Guinee", courriel: null, baseUrl: null, aujourdhui: "2026-10-22" };
const ok: Record<string, boolean> = {};

async function main() {
  try {
    await prisma.$transaction(async (tx) => {
      // Fuseau de session volontairement eloigne de l'UTC : la date de revision ne doit pas bouger.
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'Pacific/Auckland'`);
      await tx.$executeRawUnsafe(`INSERT INTO regions (nom) VALUES ('Region de test metadonnees')`);
      const reg = `(SELECT id FROM regions WHERE nom='Region de test metadonnees')`;
      await tx.$executeRawUnsafe(
        `INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", geom, "updatedAt")
         VALUES ('t-md-1', 'MD-1', 'Troncon 1', 'RN', ${reg}, 1, 'BITUME', 0, 1, ST_GeomFromText('LINESTRING(-13.9 9.4, -13.6 9.8)', 4326), '2026-10-20 23:30:00'),
                ('t-md-2', 'MD-2', 'Troncon 2', 'RN', ${reg}, 1, 'BITUME', 0, 1, ST_GeomFromText('LINESTRING(-9.0 10.5, -8.5 11.0)', 4326), '2026-10-18 08:00:00')`);
      // Un troncon supprime logiquement, tres loin : il ne doit pas elargir l'etendue.
      await tx.$executeRawUnsafe(
        `INSERT INTO troncons (id, code, nom, classe, "regionId", "longueurKm", revetement, "pkDebut", "pkFin", geom, "updatedAt", "deletedAt")
         VALUES ('t-md-3', 'MD-3', 'Troncon supprime', 'RN', ${reg}, 1, 'BITUME', 0, 1, ST_GeomFromText('LINESTRING(-15.0 7.3, -14.9 7.4)', 4326), '2026-10-25 00:00:00', '2026-10-21 00:00:00')`);
      const type = (await tx.$queryRawUnsafe<{ enumlabel: string }[]>(
        `SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='TypeOuvrage' LIMIT 1`))[0].enumlabel;
      await tx.$executeRawUnsafe(
        `INSERT INTO ouvrages (id, nom, type, "regionId", geom, "sourceReference", "updatedAt")
         VALUES ('o-md-1', 'Pont inventorie', '${type}', ${reg}, ST_SetSRID(ST_MakePoint(-13.7, 9.5), 4326), NULL, '2026-10-19 10:00:00'),
                ('o-md-2', 'Pont OSM', '${type}', ${reg}, ST_SetSRID(ST_MakePoint(-8.0, 12.5), 4326), 'ouvrage_osm:123', '2026-10-24 10:00:00')`);

      // Chaque requete est executee SANS que le catch de contexteDe puisse masquer une erreur SQL.
      const erreurs: string[] = [];
      const espion = new Proxy(tx, {
        get(cible, prop, recepteur) {
          if (prop !== "$queryRaw") return Reflect.get(cible, prop, recepteur);
          return async (...a: unknown[]) => {
            try { return await (cible as any).$queryRaw(...a); } catch (e) { erreurs.push(String((e as Error).message).split("\n").pop() ?? ""); throw e; }
          };
        },
      });
      const ctx: Record<string, Awaited<ReturnType<typeof contexteDe>>> = {};
      for (const f of CATALOGUE) ctx[f.id] = await contexteDe(f, espion as never, OPT);
      ok["aucune des 5 requetes ne plante"] = erreurs.length === 0;
      if (erreurs.length) console.log("ERREURS SQL :", erreurs);

      const t = ctx.troncons;
      console.log("troncons", JSON.stringify(t.emprise), t.derniereRevision);
      ok["troncons : etendue = celle des 2 troncons actifs (le supprime est exclu)"] =
        !!t.emprise && Math.abs(t.emprise.ouest + 13.9) < 1e-6 && Math.abs(t.emprise.est + 8.5) < 1e-6 && Math.abs(t.emprise.sud - 9.4) < 1e-6 && Math.abs(t.emprise.nord - 11.0) < 1e-6;
      ok["troncons : revision = jour UTC du dernier updatedAt actif (20/10), fuseau de session NZ sans effet"] = t.derniereRevision === "2026-10-20";

      const o = ctx.ouvrages;
      console.log("ouvrages", JSON.stringify(o.emprise), o.derniereRevision);
      ok["ouvrages : l'ouvrage OSM n'etend ni l'etendue ni la revision"] =
        !!o.emprise && Math.abs(o.emprise.est + 13.7) < 1e-6 && Math.abs(o.emprise.nord - 9.5) < 1e-6 && o.derniereRevision === "2026-10-19";

      for (const id of ["points-noirs", "chantiers", "voirie-locale"]) {
        // Tables vides dans cette base : l'etendue est ABSENTE (NULL), pas une etendue de zeros.
        ok[`${id} : table vide -> etendue et revision absentes, sans erreur`] = ctx[id].emprise === null && ctx[id].derniereRevision === null;
      }
      const xml = await xmlDe("troncons", espion as never, OPT);
      ok["xml des troncons : etendue reelle, pas de nilReason sur l'etendue"] = !!xml && xml.includes("<gco:Decimal>-13.9</gco:Decimal>") && !xml.includes('<gmd:extent gco:nilReason');
      throw ROLLBACK;
    }, { timeout: 120000 });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  const [{ n }] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM troncons WHERE id LIKE 't-md-%'`);
  ok["fixtures restantes apres annulation : 0"] = String(n) === "0";
  for (const [nom, vrai] of Object.entries(ok)) verifier(nom, vrai);
  conclure();
}
main().catch((e) => { console.error(e); process.exitCode = 2; }).finally(() => prisma.$disconnect());
