// Banc d'integration PostGIS : voir tests-integration/README.md. Lancer : npx tsx tests-integration/info-route.integration.ts
import "./lib/garde";
// Verification d'integration Info Route + bulletin contre `replay`, transaction ANNULEE.
import { PrismaClient } from "@prisma/client";
import { declarer, ajouterEntree } from "../src/exploitation/main-courante.service";
import { publier, infoRouteCourante, versPublic, genererEtArchiverBulletin, journalEvenement, RefusInfoRoute } from "../src/exploitation/info-route.service";

const prisma = new PrismaClient();
class Annulation extends Error {}

async function main() {
  try {
    await prisma.$transaction(async (tx) => {
      const depot = new Proxy(tx as unknown as Record<string, unknown>, {
        get: (t, k) => (k === "$transaction" ? (fn: (x: unknown) => unknown) => fn(tx) : t[k as string]),
      }) as never;
      await tx.$executeRawUnsafe(`INSERT INTO users (id, email, "nomComplet", "passwordHash", role, "updatedAt") VALUES ('u-iri','iri@local.invalid','Integ','x','GESTIONNAIRE',now())`);
      const ctx = { auteurId: "u-iri" };

      const d = await declarer(depot, { typeCode: "COUPURE", sourceCode: "PATROUILLE", texte: "Radier submerge (texte interne)", point: [-13.6, 9.64] }, ctx);
      const ev = d.evenementId;
      try { await publier(depot, ev, "PUBLICATION", { categorie: "COUPURE", titre: "RN1 coupee", textePublic: "Radier submerge.", localisationPublique: "RN1, PK 45" }, ctx); console.log("ERREUR : OUVERT publie"); }
      catch (e) { console.log("OUVERT :", e instanceof RefusInfoRoute ? e.code : e); }

      await ajouterEntree(depot, ev, { nature: "STATUT", statut: "PRIS_EN_COMPTE", texte: "Vu par le chef de veille" }, ctx);
      try { await publier(depot, ev, "PUBLICATION", { categorie: "COUPURE", praticabiliteCode: "P4", titre: "RN1 coupee", textePublic: "x", localisationPublique: "RN1" }, ctx); console.log("ERREUR : P4 publie"); }
      catch (e) { console.log("P4 non approuve :", e instanceof RefusInfoRoute ? e.code : e); }

      await publier(depot, ev, "PUBLICATION", { categorie: "COUPURE", titre: "RN1 coupée à Kindia", textePublic: "Radier submergé, passage impossible.", localisationPublique: "RN1, PK 45, Kindia" }, ctx);
      await publier(depot, ev, "MISE_A_JOUR", { categorie: "DEVIATION", titre: "RN1 coupée, déviation", textePublic: "Déviation balisée.", localisationPublique: "RN1, PK 45, Kindia", deviation: "par la RN6 via Friguiagbé" }, ctx);

      const courantes = await infoRouteCourante(depot);
      const mienne = courantes.filter((c) => c.evenementId === ev);
      console.log("vue : lignes", mienne.length, "categorie", mienne[0]?.categorie, "publieDepuis<=misAJourLe", mienne[0] && mienne[0].publieDepuis <= mienne[0].misAJourLe);
      const pub = JSON.stringify(mienne.map(versPublic));
      console.log("public sans texte interne ni evenement :", !pub.includes("texte interne") && !pub.includes(ev) && !pub.includes("u-iri"));

      const b = await genererEtArchiverBulletin(depot, ctx);
      console.log("bulletin :", b.numero, "empreinte verifiee en base (insert accepte)", b.empreinteSha256.length === 64);
      console.log("---\n" + b.texte + "\n---");

      await publier(depot, ev, "RETRAIT", {}, ctx);
      console.log("apres retrait, dans la vue :", (await infoRouteCourante(depot)).filter((c) => c.evenementId === ev).length);
      const j = await journalEvenement(depot, ev);
      console.log("journal :", j.map((x) => x.action).join(" > "));
      try { await tx.$executeRawUnsafe(`UPDATE bulletins_routiers SET texte = 'x' WHERE id = '${b.id}'`); console.log("ERREUR : bulletin modifie"); }
      catch { console.log("bulletin : UPDATE refuse par la base"); }
      throw new Annulation();
    }, { timeout: 60_000 });
  } catch (e) {
    if (!(e instanceof Annulation)) throw e;
    console.log("transaction annulee");
  }
  console.log("bulletins restants de l'essai :", await prisma.bulletinRoutier.count({ where: { genereParId: "u-iri" } }));
}
main().finally(() => prisma.$disconnect());
