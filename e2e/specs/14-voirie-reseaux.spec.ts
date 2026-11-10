import { requete } from "../lib/base";
import { expect, test } from "../lib/fixtures";
import { ApiVoirie, BASE, codeProjet, creerCompte, type CompteVoirie, type ReponseApi } from "../lib/voirie";
import { CABLE_PHYSIQUE, CIRCUITS_SUPERPOSES, geojson } from "../lib/voirie-geo";

/**
 * KIS-LOGIC-01 (cahier 22.3, API) : trois circuits logiques superposes et un cable physique.
 *
 *   - le comptage distingue trois nombres differents : la longueur de trace fusionnee, la somme des longueurs des circuits et le nombre
 *     d'infrastructures declarees ; les circuits ne sont jamais comptes comme des cables ;
 *   - une association PROPOSEE (superposition geometrique) n'est jamais appliquee sans validation humaine justifiee ; une proposition refusee ne
 *     revient pas, et ne se contourne pas par une declaration manuelle.
 * Toutes les geometries sont synthetiques (e2e/lib/voirie-geo.ts).
 */

test.describe.configure({ mode: "serial" });

let gestionnaire: CompteVoirie;
let lecteur: CompteVoirie;
test.beforeAll(async () => {
  gestionnaire = await creerCompte("e2e-res-gest", "Gestionnaire Reseaux E2E", "GESTIONNAIRE");
  lecteur = await creerCompte("e2e-res-lect", "Lecteur Reseaux E2E", "LECTEUR");
});

const etat: { projetId: string; jeuCircuits: string; jeuCables: string; circuits: string[]; fourreaux: string[] } = { projetId: "", jeuCircuits: "", jeuCables: "", circuits: [], fourreaux: [] };

const proche = (v: number, attendu: number, tolerance = 0.6) => Math.abs(v - attendu) <= tolerance;

async function proposer(api: ApiVoirie, corps: unknown = {}): Promise<ReponseApi> {
  for (let i = 0; i < 8; i++) {
    const r = await api.post(`${BASE}/${etat.projetId}/reseau/associations/proposer`, corps);
    if (r.statut !== 429) return r;
    await new Promise((ok) => setTimeout(ok, ((r.corps?.retryAfterS ?? 3) + 0.3) * 1000));
  }
  throw new Error("proposition : 429 persistant");
}

test("KIS-LOGIC-01 : trois circuits superposés + des câbles physiques : trois nombres distincts, aucun câble inventé", async ({ marqueur }) => {
  const api = await ApiVoirie.connecter(gestionnaire);
  etat.projetId = await api.creerProjet(codeProjet(marqueur, "LOGIC"));
  const opCircuits = await api.creerConcessionnaire(`Operateur circuits ${marqueur}`, "TELECOM");
  const opCables = await api.creerConcessionnaire(`Operateur fourreaux ${marqueur}`, "TELECOM");
  etat.jeuCircuits = await api.deposerEtAutoriser(etat.projetId, { name: "circuits.geojson", buffer: geojson(CIRCUITS_SUPERPOSES) },
    { role: "RESEAU_TIERS", concessionnaireId: opCircuits, natureObjets: "CIRCUIT_LOGIQUE" });
  etat.jeuCables = await api.deposerEtAutoriser(etat.projetId, { name: "fourreaux.geojson", buffer: geojson(CABLE_PHYSIQUE) },
    { role: "RESEAU_TIERS", concessionnaireId: opCables, natureObjets: "ACTIF_PHYSIQUE" });

  const r = await api.get(`${BASE}/${etat.projetId}/reseau/comptage`);
  expect(r.statut, r.texte.slice(0, 300)).toBe(200);
  const c = r.corps;
  // Un circuit fait environ 100 m ; trois circuits sur la meme trace : somme = 3 x 100 m, trace fusionnee = 100 m.
  expect(c.circuitsLogiques.nombreDeclare, "nombre de circuits declares (pas un nombre de cables)").toBe(3);
  expect(proche(c.circuitsLogiques.sommeLongueursCircuitsM, 300, 1.5), `somme des longueurs de circuits : ${c.circuitsLogiques.sommeLongueursCircuitsM}`).toBe(true);
  expect(proche(c.circuitsLogiques.longueurTraceFusionneM, 100, 0.6), `trace fusionnee : ${c.circuitsLogiques.longueurTraceFusionneM}`).toBe(true);
  expect(c.circuitsLogiques.tracesPartagees).toMatchObject({ groupes: 1, circuitsConcernes: 3 });
  expect(c.circuitsLogiques.supportPhysique).toEqual({ avecSupportValide: 0, avecPropositionSeulement: 0, sansSupportConnu: 3 });
  expect(c.infrastructuresPhysiques.nombreDeclare, "nombre d'infrastructures declarees").toBe(2);
  expect(proche(c.infrastructuresPhysiques.longueurTraceFusionneM, 200, 1.2), `trace des infrastructures : ${c.infrastructuresPhysiques.longueurTraceFusionneM}`).toBe(true);
  // Les trois nombres sont DIFFERENTS : 3 circuits, 2 infrastructures, 300 m cumules, 100 m de trace.
  const nombres = new Set([c.circuitsLogiques.nombreDeclare, c.infrastructuresPhysiques.nombreDeclare, Math.round(c.circuitsLogiques.sommeLongueursCircuitsM), Math.round(c.circuitsLogiques.longueurTraceFusionneM)]);
  expect(nombres.size, "quatre valeurs distinctes").toBe(4);
  expect(c.avertissements.join(" ")).toMatch(/n'est pas un nombre de câbles physiques/);
  expect(c.avertissements.join(" ")).toMatch(/Ce ne sont pas 3 câbles physiques/);
  // Aucun total ne melange les natures : pas de cle de total global.
  expect(Object.keys(c)).not.toContain("total");

  // Les circuits restent des objets separes (3 fiches), chacun signale comme partageant sa trace avec les deux autres.
  const objets = await api.get(`${BASE}/${etat.projetId}/reseau/objets?limite=50`);
  const circuits = objets.corps.objets.filter((o: { nature: string }) => o.nature === "CIRCUIT_LOGIQUE");
  const fourreaux = objets.corps.objets.filter((o: { nature: string }) => o.nature === "ACTIF_PHYSIQUE");
  expect(circuits).toHaveLength(3);
  expect(fourreaux).toHaveLength(2);
  etat.circuits = circuits.map((o: { id: string }) => o.id);
  etat.fourreaux = fourreaux.map((o: { id: string }) => o.id);
  const fiche = await api.get(`${BASE}/${etat.projetId}/reseau/objets/${etat.circuits[0]}`);
  expect(fiche.corps.tracePartagee.nbAutresObjets, "deux autres circuits ont la meme trace").toBe(2);
  expect(fiche.corps.objet.vertical.evaluable, "aucune conclusion 3D").toBe(false);
  expect(fiche.corps.objet.vertical.conclusion3D).toBeNull();
  await api.fermer();
});

test("KIS-LOGIC-01 : une association proposée n'est jamais appliquée sans validation humaine justifiée", async () => {
  test.skip(!etat.projetId, "depend du comptage");
  const api = await ApiVoirie.connecter(gestionnaire);
  const l = await ApiVoirie.connecter(lecteur);
  const comptage = async () => (await api.get(`${BASE}/${etat.projetId}/reseau/comptage`)).corps.circuitsLogiques.supportPhysique;
  const relationsValidees = async () => Number((await requete<{ n: string }>(`SELECT count(*)::text AS n FROM reseau_relations WHERE "projetId" = $1 AND statut = 'VALIDEE'`, [etat.projetId]))[0].n);

  const p = await proposer(api);
  expect(p.statut, p.texte.slice(0, 300)).toBe(201);
  expect(p.corps.statut).toBe("PROPOSITIONS_A_VALIDER");
  expect(p.corps.bilan.creees, "chaque circuit superpose au fourreau 1 est propose").toBe(3);
  expect(p.corps.avertissements.join(" ")).toMatch(/aucune association n'est appliquée tant qu'une personne ne l'a pas validée/);
  const liste = await api.get(`${BASE}/${etat.projetId}/reseau/relations?limite=50`);
  expect(liste.corps.relations).toHaveLength(3);
  for (const rel of liste.corps.relations) {
    expect(rel).toMatchObject({ statut: "PROPOSEE", origine: "AUTOMATIQUE", typeRelation: "PORTE_PAR" });
    expect(rel.proposition.statutParametres, "valeurs de tolerance provisoires, a valider").toBe("PROVISOIRE_A_VALIDER");
  }
  // Rien n'est applique : aucune relation validee en base, le support reste « proposition seulement ».
  expect(await relationsValidees()).toBe(0);
  expect(await comptage()).toEqual({ avecSupportValide: 0, avecPropositionSeulement: 3, sansSupportConnu: 0 });

  // Validation humaine : justification obligatoire (10 caracteres), role habilite.
  const [premiere, deuxieme] = liste.corps.relations as Array<{ id: string }>;
  expect((await l.post(`${BASE}/${etat.projetId}/reseau/relations/${premiere.id}/valider`, { justification: "Je ne devrais pas pouvoir" })).statut, "un lecteur ne valide pas").toBe(403);
  const courte = await api.post(`${BASE}/${etat.projetId}/reseau/relations/${premiere.id}/valider`, { justification: "ok" });
  expect(courte.statut).toBe(400);
  expect(courte.corps.code).toBe("JUSTIFICATION_INVALIDE");
  expect(await relationsValidees(), "une validation refusee n'applique rien").toBe(0);
  const v = await api.post(`${BASE}/${etat.projetId}/reseau/relations/${premiere.id}/valider`, { justification: "Trace identique constatee sur le plan de recolement" });
  expect(v.statut, v.texte.slice(0, 300)).toBe(200);
  expect(v.corps.relation.statut).toBe("VALIDEE");
  expect(v.corps.relation.decision.par).toBe(gestionnaire.nomComplet);
  expect(await relationsValidees()).toBe(1);
  expect(await comptage(), "un seul support valide ; les deux autres restent des propositions").toEqual({ avecSupportValide: 1, avecPropositionSeulement: 2, sansSupportConnu: 0 });

  // Refus : la proposition refusee ne revient pas, et ne se contourne pas par une declaration manuelle.
  const refus = await api.post(`${BASE}/${etat.projetId}/reseau/relations/${deuxieme.id}/refuser`, { justification: "Fourreau different : trace seulement voisine" });
  expect(refus.corps.relation.statut).toBe("REFUSEE");
  const encore = await proposer(api);
  expect(encore.corps.bilan.creees, "rien de nouveau : tout est deja connu").toBe(0);
  expect(encore.corps.bilan.dejaConnues).toBeGreaterThanOrEqual(3);
  const apres = await api.get(`${BASE}/${etat.projetId}/reseau/relations?statut=REFUSEE`);
  expect(apres.corps.relations, "la proposition refusee n'est pas revenue").toHaveLength(1);
  const rel = (await api.get(`${BASE}/${etat.projetId}/reseau/relations?limite=50`)).corps.relations.find((x: { id: string }) => x.id === deuxieme.id);
  const manuelle = await api.post(`${BASE}/${etat.projetId}/reseau/relations`, {
    type: "PORTE_PAR", sourceObjetId: rel.source.objetId, cibleObjetId: rel.cible.objetId, justification: "Je contourne le refus par une declaration manuelle",
  });
  expect(manuelle.statut, "une proposition refusee ne se contourne pas").toBe(409);
  expect(manuelle.corps.code).toBe("RELATION_DEJA_CONNUE");
  expect(await relationsValidees()).toBe(1);
  await Promise.all([api.fermer(), l.fermer()]);
});
