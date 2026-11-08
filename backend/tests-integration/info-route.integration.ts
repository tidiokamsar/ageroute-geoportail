// Banc d'integration PostGIS : voir tests-integration/README.md. Lancer : npx tsx tests-integration/info-route.integration.ts
import "./lib/garde";
// Verification d'integration Info Route + bulletin contre `replay`, transaction ANNULEE.
import { PrismaClient } from "@prisma/client";
import { declarer, ajouterEntree } from "../src/exploitation/main-courante.service";
import { publier, infoRouteCourante, versPublic, genererEtArchiverBulletin, journalEvenement, RefusInfoRoute } from "../src/exploitation/info-route.service";
import { verifier, conclure } from "./lib/verdict";

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
      const refus = async (f: () => Promise<unknown>): Promise<string> => {
        try { await f(); return "aucun refus"; } catch (e) { return e instanceof RefusInfoRoute ? e.code : String(e); }
      };
      verifier("un evenement ouvert, non pris en compte, ne se publie pas",
        (await refus(() => publier(depot, ev, "PUBLICATION", { categorie: "COUPURE", titre: "RN1 coupee", textePublic: "Radier submerge.", localisationPublique: "RN1, PK 45" }, ctx))) === "EVENEMENT_NON_PRIS_EN_COMPTE");

      await ajouterEntree(depot, ev, { nature: "STATUT", statut: "PRIS_EN_COMPTE", texte: "Vu par le chef de veille" }, ctx);
      verifier("un niveau de praticabilite non approuve (P4) ne se publie pas",
        (await refus(() => publier(depot, ev, "PUBLICATION", { categorie: "COUPURE", praticabiliteCode: "P4", titre: "RN1 coupee", textePublic: "x", localisationPublique: "RN1" }, ctx))) === "NIVEAU_NON_APPROUVE");

      await publier(depot, ev, "PUBLICATION", { categorie: "COUPURE", titre: "RN1 coupée à Kindia", textePublic: "Radier submergé, passage impossible.", localisationPublique: "RN1, PK 45, Kindia" }, ctx);
      await publier(depot, ev, "MISE_A_JOUR", { categorie: "DEVIATION", titre: "RN1 coupée, déviation", textePublic: "Déviation balisée.", localisationPublique: "RN1, PK 45, Kindia", deviation: "par la RN6 via Friguiagbé" }, ctx);

      const mienne = (await infoRouteCourante(depot)).filter((c) => c.evenementId === ev);
      verifier("la vue courante porte UNE ligne pour l'evenement, a sa derniere categorie (DEVIATION)", mienne.length === 1 && mienne[0].categorie === "DEVIATION", mienne.map((m) => m.categorie));
      verifier("publieDepuis ne depasse pas misAJourLe", mienne.length === 1 && mienne[0].publieDepuis <= mienne[0].misAJourLe);
      const pub = JSON.stringify(mienne.map(versPublic));
      verifier("la version publique ne contient ni le texte interne, ni l'identifiant d'evenement, ni l'auteur",
        !pub.includes("texte interne") && !pub.includes(ev) && !pub.includes("u-iri"));

      const b = await genererEtArchiverBulletin(depot, ctx);
      verifier("le bulletin porte un numero BR-AAAAMMJJ-n", /^BR-[0-9]{8}-[0-9]+$/.test(b.numero), b.numero);
      verifier("l'empreinte SHA-256 du bulletin fait 64 caracteres hexadecimaux", /^[0-9a-f]{64}$/.test(b.empreinteSha256), b.empreinteSha256);
      verifier("le bulletin reprend la deviation validee et rien de l'interne",
        b.texte.includes("DÉVIATIONS (1)") && b.texte.includes("par la RN6 via Friguiagbé") && !b.texte.includes("texte interne") && !b.texte.includes(ev));

      await publier(depot, ev, "RETRAIT", {}, ctx);
      verifier("apres retrait, l'evenement n'est plus dans la vue", (await infoRouteCourante(depot)).filter((c) => c.evenementId === ev).length === 0);
      const j = await journalEvenement(depot, ev);
      verifier("le journal garde toute l'histoire : PUBLICATION > MISE_A_JOUR > RETRAIT", j.map((x) => x.action).join(" > ") === "PUBLICATION > MISE_A_JOUR > RETRAIT", j.map((x) => x.action));
      let modifie = true;
      try { await tx.$executeRawUnsafe(`UPDATE bulletins_routiers SET texte = 'x' WHERE id = '${b.id}'`); } catch { modifie = false; }
      verifier("un bulletin archive ne peut pas etre modifie (la base refuse l'UPDATE)", !modifie);
      throw new Annulation();
    }, { timeout: 60_000 });
  } catch (e) {
    if (!(e instanceof Annulation)) throw e;
    console.log("transaction annulee");
  }
  verifier("rien ne subsiste apres l'annulation (0 bulletin)", (await prisma.bulletinRoutier.count({ where: { genereParId: "u-iri" } })) === 0);
  conclure();
}
main().catch((e) => { console.error(e); process.exitCode = 2; }).finally(() => prisma.$disconnect());
