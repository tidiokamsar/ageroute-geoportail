// Banc d'integration : DELAI DE PUBLICATION DE L'INFO ROUTE (A24, « Info Route en moins d'une minute »).
// Voir tests-integration/README.md et docs/scenarios/A23-A24.md. Lancer (DATABASE_URL pointe sur `replay`) :
//   npx tsx tests-integration/info-route-delai.integration.mts
//
// CE QUE LE BANC MESURE : le temps ecoule entre l'instant ou l'exploitant VALIDE la publication (requete
// POST /api/v2/exploitation/info-route/evenements/:id/publications, route reelle, jeton signe) et celui ou la
// publication est LISIBLE par le public (GET du flux public, handler reel `infoRoutePubliqueHandler`, vue
// `info_route_courante`), contre un clone PostGIS jetable. 30 publications, avec 8 lecteurs publics qui
// interrogent le flux en continu pendant toute la mesure. Il releve aussi le delai de DISPARITION apres retrait.
// Seuil : 60 000 ms (le cahier). La mesure est reportee avec sa distribution (min, p50, p95, max), jamais
// resumee en « OK ».
//
// LE CACHE DECLARE FAIT PARTIE DU DELAI. Le flux public repond `Cache-Control: public, max-age=30` : un
// navigateur ou un relais qui respecte l'en-tete peut montrer l'etat precedent jusqu'a 30 s de plus. Le banc
// releve l'en-tete reel et verifie la BORNE : delai serveur maximal mesure + max-age declare < 60 s. C'est une
// borne calculee a partir de l'en-tete, pas une mesure faite a travers un relais.
//
// CE QU'IL NE MESURE PAS : un navigateur, un reverse proxy (Traefik) ou un CDN reels, le reseau mobile, la
// frequence d'interrogation du consommateur du flux (aucun consommateur public n'est dans ce depot : le geoportail
// ne lit pas `/api/public/info-route`), ni la charge de la production. Le limiteur de debit du routeur public
// (60 requetes par minute et par IP) n'est pas monte : le banc appelle le handler reel directement, sans quoi ses
// propres sondes seraient refusees (429) ; un lecteur normal (une requete toutes les 30 s) n'en approche pas.
// Le delai de PRISE EN COMPTE humaine (de l'incident a la validation) n'est pas technique : il n'est pas mesure.
import { performance } from "node:perf_hooks";
import { ouvrirBancClone } from "./lib/banc-clone.mts";
import { verifier, conclure } from "./lib/verdict.ts";

const banc = await ouvrirBancClone("essai_inforoute");
const { prisma } = await banc.imp("lib/prisma");
const { errorHandler } = await banc.imp("middleware/error.middleware");
const { signAccessToken } = await banc.imp("utils/jwt");
const { exploitationV2Router } = await banc.imp("api-v2/exploitation.routes");
const { infoRouteV2Router } = await banc.imp("api-v2/info-route.routes");
const { infoRoutePubliqueHandler } = await banc.imp("modules/public/info-route.public");
// Comme src/server.ts : les colonnes BigInt (rang des entrees) se serialisent en texte.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function (this: bigint) { return this.toString(); };
const express = (await import("express")).default;
const request = (await import("supertest")).default;

const app = express();
app.use(express.json());
app.use("/api/v2/exploitation", exploitationV2Router);
app.use("/api/v2/exploitation/info-route", infoRouteV2Router);
app.get("/api/public/info-route", infoRoutePubliqueHandler);
app.use(errorHandler);

// BANC_SEUIL_MS ne sert qu'a la contre-epreuve du verdict (un seuil de 100 ms doit faire echouer le banc).
const SEUIL_MS = Number(process.env.BANC_SEUIL_MS ?? 60_000);
const N = 30;
const LECTEURS = 8;

const centile = (valeurs: number[], p: number) => {
  const t = [...valeurs].sort((a, b) => a - b);
  return t[Math.min(t.length - 1, Math.ceil((p / 100) * t.length) - 1)];
};
const arrondi = (x: number) => Math.round(x * 10) / 10;

async function main() {
  const gestionnaire = await prisma.user.create({ data: { email: "exploitant@inforoute.invalid", nomComplet: "Exploitant banc", passwordHash: "x", role: "GESTIONNAIRE" } });
  const jeton = signAccessToken({ sub: gestionnaire.id, role: gestionnaire.role, email: gestionnaire.email });
  const auth = { Authorization: `Bearer ${jeton}` };
  const lirePublic = () => request(app).get("/api/public/info-route");
  const ids = (r: { body: { publications?: { id: string }[] } }) => new Set((r.body.publications ?? []).map((p) => p.id));

  // Prerequis : le vocabulaire d'evenement de la main courante existe dans le clone.
  const ref = await request(app).get("/api/v2/exploitation/referentiels").set(auth);
  verifier("prerequis : les referentiels de la main courante repondent (le clone est utilisable)", ref.status === 200, ref.body);

  async function nouvelEvenementPrisEnCompte(i: number): Promise<string> {
    const d = await request(app).post("/api/v2/exploitation/main-courante").set(auth)
      .send({ typeCode: "COUPURE", sourceCode: "PATROUILLE", texte: `Incident ${i} (texte interne du banc)`, point: [-13.6, 9.64] });
    if (d.status !== 201) throw new Error(`declaration refusee : ${d.status} ${JSON.stringify(d.body)}`);
    const evenementId = (d.body.evenementId ?? d.body.entree?.evenementId) as string;
    const e = await request(app).post(`/api/v2/exploitation/main-courante/${evenementId}/entrees`).set(auth)
      .send({ nature: "STATUT", statut: "PRIS_EN_COMPTE", texte: "Vu par le chef de veille" });
    if (e.status !== 201) throw new Error(`prise en compte refusee : ${e.status} ${JSON.stringify(e.body)}`);
    return evenementId;
  }
  const publier = (evenementId: string, action: string, extra: Record<string, unknown> = {}) =>
    request(app).post(`/api/v2/exploitation/info-route/evenements/${evenementId}/publications`).set(auth).send({ action, ...extra });

  // ------------------------------------------------------------ Contre-epreuves : le public ne voit RIEN avant validation
  const evAvant = await nouvelEvenementPrisEnCompte(0);
  const avantValidation = await lirePublic();
  verifier("CONTRE-EPREUVE : un evenement declare et pris en compte, mais NON valide, n'est pas lisible par le public (le flux ne fuit pas avant la validation)",
    avantValidation.status === 200 && (avantValidation.body.publications ?? []).length === 0, avantValidation.body);
  const evNonPris = (await request(app).post("/api/v2/exploitation/main-courante").set(auth).send({ typeCode: "COUPURE", sourceCode: "PATROUILLE", texte: "Non pris en compte", point: [-13.6, 9.64] })).body.evenementId as string;
  const refus = await publier(evNonPris, "PUBLICATION", { categorie: "COUPURE", titre: "x", textePublic: "x", localisationPublique: "x" });
  verifier("CONTRE-EPREUVE : publier un evenement non pris en compte est refuse (409) et n'apparait pas au public", refus.status === 409 && (await lirePublic()).body.publications.length === 0, refus.body);

  // ------------------------------------------------------------ Charge : lecteurs publics en continu
  let arret = false;
  let lectures = 0;
  const lecteurs = Array.from({ length: LECTEURS }, async () => {
    while (!arret) { await lirePublic(); lectures++; }
  });

  // ------------------------------------------------------------ Mesure
  const delais: number[] = [];
  const tentatives: number[] = [];
  const delaisRetrait: number[] = [];
  let enteteCache = "";
  const evenements: string[] = [evAvant];
  for (let i = 1; i <= N; i++) evenements.push(await nouvelEvenementPrisEnCompte(i));
  const horsPublication = evenements.slice(0, 1); // evAvant : jamais publie dans la boucle, sert de temoin

  for (let i = 1; i <= N; i++) {
    const evenementId = evenements[i];
    const t0 = performance.now();
    const p = await publier(evenementId, "PUBLICATION", {
      categorie: "COUPURE", titre: `RN1 coupee (${i})`, textePublic: "Radier submerge, passage impossible.", localisationPublique: `RN1, PK ${40 + i}`,
    });
    if (p.status !== 201) throw new Error(`publication refusee : ${p.status} ${JSON.stringify(p.body)}`);
    const publicationId = p.body.publication.id as string;
    let essais = 0;
    for (;;) {
      essais++;
      const r = await lirePublic();
      enteteCache = String(r.headers["cache-control"] ?? "");
      if (ids(r).has(publicationId)) break;
      if (performance.now() - t0 > SEUIL_MS) throw new Error(`publication ${i} toujours invisible apres ${SEUIL_MS} ms`);
    }
    delais.push(performance.now() - t0);
    tentatives.push(essais);
  }
  verifier(`${N} publications : chacune est lisible par le public APRES validation`, delais.length === N);

  for (let i = 1; i <= N; i++) {
    const t0 = performance.now();
    const r = await publier(evenements[i], "RETRAIT", {});
    if (r.status !== 201) throw new Error(`retrait refuse : ${r.status} ${JSON.stringify(r.body)}`);
    for (;;) {
      const lu = await lirePublic();
      if (!(lu.body.publications ?? []).some((x: { titre: string }) => x.titre === `RN1 coupee (${i})`)) break;
      if (performance.now() - t0 > SEUIL_MS) throw new Error(`retrait ${i} toujours visible apres ${SEUIL_MS} ms`);
    }
    delaisRetrait.push(performance.now() - t0);
  }
  arret = true;
  await Promise.all(lecteurs);

  // ------------------------------------------------------------ Verdicts
  const resume = (nom: string, v: number[]) => `${nom} : min ${arrondi(Math.min(...v))} ms, p50 ${arrondi(centile(v, 50))} ms, p95 ${arrondi(centile(v, 95))} ms, max ${arrondi(Math.max(...v))} ms`;
  console.log(`\n${resume("validation -> lisible", delais)}`);
  console.log(`${resume("retrait -> disparu", delaisRetrait)}`);
  console.log(`lectures publiques concurrentes pendant la mesure : ${lectures}`);
  console.log(`en-tete Cache-Control du flux public : ${enteteCache}`);

  const maxDelai = Math.max(...delais), maxRetrait = Math.max(...delaisRetrait);
  verifier(`delai serveur validation -> lisible : maximum ${arrondi(maxDelai)} ms, sous le seuil de ${SEUIL_MS} ms`, maxDelai < SEUIL_MS, delais);
  verifier("la publication est lisible des la PREMIERE lecture suivant la validation : aucun delai de propagation (vue lue a l'instant de l'appel)", tentatives.every((t) => t === 1), tentatives);
  verifier(`delai de retrait -> disparu : maximum ${arrondi(maxRetrait)} ms, sous le seuil de ${SEUIL_MS} ms`, maxRetrait < SEUIL_MS, delaisRetrait);
  verifier(`les lecteurs publics concurrents ont bien tourne pendant la mesure (${lectures} lectures) : la mesure n'est pas faite a vide`, lectures >= LECTEURS * 3, lectures);

  const maxAge = Number(/max-age=(\d+)/.exec(enteteCache)?.[1] ?? NaN);
  verifier(`l'en-tete du flux declare un cache de ${maxAge} s : borne de bout en bout = delai serveur maximal (${arrondi(maxDelai)} ms) + ${maxAge} s, sous 60 s`,
    Number.isFinite(maxAge) && maxDelai + maxAge * 1000 < SEUIL_MS, enteteCache);
  verifier("le flux public est declare cacheable en public (relais compris) : la borne ci-dessus vaut aussi pour un relais qui respecte l'en-tete", /public/.test(enteteCache));

  // L'evenement temoin n'a jamais ete publie : il reste absent, apres 30 publications et 30 retraits.
  const finale = await lirePublic();
  verifier("CONTRE-EPREUVE : apres 30 publications et 30 retraits, le flux public est vide (rien ne reste, l'evenement temoin n'a jamais fuite)", (finale.body.publications ?? []).length === 0 && horsPublication.length === 1, finale.body);
  const journal = Number((await prisma.$queryRawUnsafe(`SELECT count(*) AS n FROM publications_info_route`))[0].n);
  verifier("le journal (ajout seul) garde toute l'histoire : 30 publications + 30 retraits = 60 lignes", journal === 2 * N, journal);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 2; })
  .finally(async () => { conclure(); await prisma.$disconnect(); await banc.fermer(); });
