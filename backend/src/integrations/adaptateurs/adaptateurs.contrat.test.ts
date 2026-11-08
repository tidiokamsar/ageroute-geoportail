import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { lireConfigIntegrations } from "../config";
import { creerAdaptateurs } from ".";
import { canonique, cleIdempotence, sha256Hex } from "../canonique";
import { fetchBoucleLocale, type Simulateur } from "../simulateurs/simulateur";
import {
  CHEMIN_DE_TEST, JETON_DE_TEST, adaptateursRapides, chargeBulletinExemple, chargeFicheExemple, chargeOuvrage, chargePortion, chargeTroncon,
  envPour, simulateursDeTest,
} from "../essais.support";
import { DESTINATIONS, ROUTES, type DemandeEmission, type Destination } from "../types";

/**
 * TESTS DE CONTRAT DES ADAPTATEURS, CONTRE UN SIMULATEUR ECRIT PAR AGEROUTE.
 *
 * Rien ici ne touche DigitalRoad, SharePoint ou la BDR / L2R : chaque adaptateur parle a un serveur
 * HTTP local (127.0.0.1) qui implemente NOTRE hypothese de contrat, et `fetchBoucleLocale` leve
 * pour tout autre hote. Un test vert prouve que notre code tient notre contrat, pas qu'un tiers
 * l'accepte.
 *
 * Pour CHAQUE destination : succes, 5xx, delai depasse, reponse en double, accuse invalide,
 * refus 4xx, redirection (non suivie), jeton refuse, charge non conforme (jamais emise).
 */
const CHARGES: Record<Destination, () => { sourceType: string; sourceId: string; charge: unknown }> = {
  DIGITALROAD: () => ({ sourceType: "FicheIntervention", sourceId: "fiche-2027-001", charge: chargeFicheExemple() }),
  SHAREPOINT: () => ({ sourceType: "BulletinRoutier", sourceId: "b-1", charge: chargeBulletinExemple() }),
  BDR_L2R: () => ({ sourceType: "Troncon", sourceId: "t-1", charge: chargeTroncon() }),
};

function demande(destination: Destination, extra: Partial<DemandeEmission> = {}): DemandeEmission {
  const { sourceType, sourceId, charge } = CHARGES[destination]();
  const empreinteCharge = sha256Hex(canonique(charge));
  const typeEvenement = ROUTES[destination].typeEvenement;
  return {
    evenementId: "e-1", destination, typeEvenement, version: 1, empreinteCharge, charge,
    cleIdempotence: cleIdempotence({ destination, typeEvenement, sourceType, sourceId, empreinteCharge }),
    ...extra,
  };
}

let simulateurs: Partial<Record<Destination, Simulateur>>;
const fetchLocal = fetchBoucleLocale();
let adaptateurs: ReturnType<typeof creerAdaptateurs>;
/** Delai court (250 ms) : seulement pour les tests qui provoquent un delai depasse. */
let rapides: ReturnType<typeof creerAdaptateurs>;

beforeAll(async () => {
  simulateurs = await simulateursDeTest();
  // Delai large (3 s) : sous la charge de la CI, un delai serre ferait echouer un appel normal.
  adaptateurs = creerAdaptateurs(lireConfigIntegrations(envPour(simulateurs)), fetchLocal);
  rapides = adaptateursRapides(simulateurs, fetchLocal);
});
afterAll(async () => { for (const s of Object.values(simulateurs)) await s?.fermer(); });
beforeEach(() => { for (const s of Object.values(simulateurs)) s?.reinitialiser(); });

describe.each(DESTINATIONS)("adaptateur %s contre son simulateur", (destination) => {
  const sim = () => simulateurs[destination]!;
  const adaptateur = () => adaptateurs[destination]!;

  it("succes : accuse de reception, une seule requete, enveloppe conforme, cle et jeton transmis", async () => {
    const r = await adaptateur().emettre(demande(destination));
    expect(r).toMatchObject({ issue: "ACCEPTE", codeHttp: 200 });
    expect((r as { accuseReference: string }).accuseReference).toMatch(/^SIM-/);
    expect(sim().requetes).toHaveLength(1);
    const q = sim().requetes[0];
    expect(q).toMatchObject({ methode: "POST", chemin: CHEMIN_DE_TEST, jetonValide: true, enveloppeConforme: true, cleCoherente: true, motifNonConforme: null });
    expect(q.entetes["content-type"]).toBe("application/json");
    expect(sim().effets.size).toBe(1);
  });

  it("le corps emis est le JSON CANONIQUE de l'enveloppe : memes octets a chaque emission", async () => {
    await adaptateur().emettre(demande(destination));
    await adaptateur().emettre(demande(destination));
    expect(sim().requetes[0].corps).toBe(sim().requetes[1].corps);
    expect(sim().requetes[0].corps).toBe(canonique(JSON.parse(sim().requetes[0].corps)));
  });

  it("5xx : echec TEMPORAIRE, sans effet chez le destinataire", async () => {
    sim().programmer({ type: "erreur5xx", statut: 503 });
    const r = await adaptateur().emettre(demande(destination));
    expect(r).toMatchObject({ issue: "ECHEC_TEMPORAIRE", codeErreur: "HTTP_503", codeHttp: 503 });
    expect(sim().effets.size).toBe(0);
  });

  it.each([408, 425, 429, 500, 502, 504])("le statut %i est temporaire", async (statut) => {
    sim().programmer(statut >= 500 ? { type: "erreur5xx", statut } : { type: "refus4xx", statut });
    expect(await adaptateur().emettre(demande(destination))).toMatchObject({ issue: "ECHEC_TEMPORAIRE", codeErreur: `HTTP_${statut}` });
  });

  it("delai depasse : echec TEMPORAIRE, code TIMEOUT, et le transport rend la main dans le delai", async () => {
    sim().programmer({ type: "timeout" });
    const t0 = Date.now();
    const r = await rapides[destination]!.emettre(demande(destination));
    expect(r).toMatchObject({ issue: "ECHEC_TEMPORAIRE", codeErreur: "TIMEOUT" });
    expect(Date.now() - t0).toBeLessThan(2_500);
  });

  it("reponse en double : DOUBLON_RECONNU, qui vaut envoi", async () => {
    sim().programmer({ type: "succes" }, { type: "doublon" });
    const r1 = await adaptateur().emettre(demande(destination));
    const r2 = await adaptateur().emettre(demande(destination));
    expect(r1.issue).toBe("ACCEPTE");
    expect(r2).toMatchObject({ issue: "DOUBLON_RECONNU", codeHttp: 200 });
    expect(sim().effets.size).toBe(1);
  });

  it("le destinataire deduplique sur la cle : re-emettre le meme evenement ne cree pas un second effet", async () => {
    await adaptateur().emettre(demande(destination));
    const r2 = await adaptateur().emettre(demande(destination));
    expect(r2.issue).toBe("DOUBLON_RECONNU");
    expect(sim().requetes).toHaveLength(2);
    expect(sim().effets.size).toBe(1);
  });

  it.each(["texte", "sans-reference", "vide", "trop-gros"] as const)("accuse invalide (%s) : ACCUSE_INVALIDE, a retenter", async (variante) => {
    sim().programmer({ type: "accuse-invalide", variante });
    const r = await adaptateur().emettre(demande(destination));
    expect(r.issue).toBe("ACCUSE_INVALIDE");
    expect(r).toMatchObject({ codeHttp: expect.any(Number) });
    // Le destinataire a traite : la retente sera reconnue comme un doublon, pas comme un second effet.
    expect(sim().effets.size).toBe(1);
    const retente = await adaptateur().emettre(demande(destination));
    expect(retente.issue).toBe("DOUBLON_RECONNU");
    expect(sim().effets.size).toBe(1);
  });

  it.each([400, 401, 403, 404, 409, 422])("refus %i : echec DEFINITIF, jamais retente", async (statut) => {
    sim().programmer({ type: "refus4xx", statut });
    expect(await adaptateur().emettre(demande(destination))).toMatchObject({ issue: "ECHEC_DEFINITIF", codeErreur: `HTTP_${statut}` });
  });

  it("redirection : NON SUIVIE, echec definitif (aucune requete ne part vers l'hote designe)", async () => {
    const avant = fetchLocal.hotesContactes.length;
    sim().programmer({ type: "redirection", vers: "https://exemple-externe.invalid/vol" });
    const r = await adaptateur().emettre(demande(destination));
    expect(r).toMatchObject({ issue: "ECHEC_DEFINITIF", codeErreur: "REDIRECTION_REFUSEE", codeHttp: 302 });
    expect(fetchLocal.hotesContactes.length - avant).toBe(1);
    expect(fetchLocal.refus).toEqual([]);
  });

  it("une charge non conforme n'atteint JAMAIS le reseau : refus local et definitif", async () => {
    const d = demande(destination, { charge: { champInconnu: true } });
    const r = await adaptateur().emettre(d);
    expect(r).toMatchObject({ issue: "ECHEC_DEFINITIF", codeErreur: "CHARGE_NON_CONFORME" });
    expect(sim().requetes).toHaveLength(0);
  });

  it("une cle interne ajoutee a une charge valide est refusee avant le reseau (schema strict)", async () => {
    const d = demande(destination, { charge: { ...(CHARGES[destination]().charge as object), creeParId: "u-1" } });
    expect(await adaptateur().emettre(d)).toMatchObject({ issue: "ECHEC_DEFINITIF", codeErreur: "CHARGE_NON_CONFORME" });
    expect(sim().requetes).toHaveLength(0);
  });

  it("le jeton est transmis dans Authorization, et n'apparait dans AUCUN message de resultat", async () => {
    sim().programmer({ type: "refus4xx", statut: 401 }, { type: "erreur5xx" }, { type: "timeout" }, { type: "accuse-invalide", variante: "texte" });
    const resultats = [];
    for (let i = 0; i < 4; i += 1) resultats.push(await rapides[destination]!.emettre(demande(destination)));
    expect(JSON.stringify(resultats)).not.toContain(JETON_DE_TEST);
    expect(JSON.stringify(resultats)).not.toContain("127.0.0.1");
    expect(sim().requetes[0].entetes.authorization).toBe(`Bearer ${JETON_DE_TEST}`);
  });

  it("un destinataire qui refuse le jeton donne un echec definitif 401, sans effet", async () => {
    const cfg = lireConfigIntegrations({ ...envPour({ [destination]: sim() }), [`OUTBOX_${destination}_JETON`]: "un-autre-jeton-0123456789" });
    const mauvais = creerAdaptateurs(cfg, fetchLocal)[destination]!;
    expect(await mauvais.emettre(demande(destination))).toMatchObject({ issue: "ECHEC_DEFINITIF", codeErreur: "HTTP_401" });
    expect(sim().effets.size).toBe(0);
    expect(sim().requetes[0].jetonValide).toBe(false);
  });

  it("serveur arrete : echec TEMPORAIRE (reseau), sans lever", async () => {
    const morte = await simulateursDeTest([destination]);
    const cfg = lireConfigIntegrations(envPour(morte));
    const adaptateurMort = creerAdaptateurs(cfg, fetchLocal)[destination]!;
    await morte[destination]!.fermer();
    const r = await adaptateurMort.emettre(demande(destination));
    expect(r.issue).toBe("ECHEC_TEMPORAIRE");
    expect(JSON.stringify(r)).not.toContain("127.0.0.1");
  });
});

describe("pivots des trois types d'objet (BDR / L2R)", () => {
  it.each([
    ["Troncon", chargeTroncon()],
    ["Ouvrage", chargeOuvrage()],
    ["Portion", chargePortion()],
  ])("le simulateur de la BDR accepte le pivot d'un(e) %s", async (sourceType, charge) => {
    const empreinteCharge = sha256Hex(canonique(charge));
    const d: DemandeEmission = {
      evenementId: "e", destination: "BDR_L2R", typeEvenement: "PIVOT_OBJET_VALIDE", version: 1, empreinteCharge, charge,
      cleIdempotence: cleIdempotence({ destination: "BDR_L2R", typeEvenement: "PIVOT_OBJET_VALIDE", sourceType, sourceId: "x", empreinteCharge }),
    };
    const r = await adaptateurs.BDR_L2R!.emettre(d);
    expect(r.issue).toBe("ACCEPTE");
  });
});

describe("aucun appel hors de la boucle locale", () => {
  it("tous les hotes contactes par ces tests sont 127.0.0.1, et aucun appel externe n'a ete refuse parce que tente", () => {
    expect(new Set(fetchLocal.hotesContactes)).toEqual(new Set(["127.0.0.1"]));
    expect(fetchLocal.refus).toEqual([]);
  });

  it("le garde-fou refuse bel et bien un hote externe (contre-epreuve)", async () => {
    const garde = fetchBoucleLocale();
    const config = lireConfigIntegrations({
      INTEGRATIONS_SORTANTES_ACTIVES: "true", OUTBOX_BDR_L2R_ACTIF: "true", OUTBOX_BDR_L2R_URL: "https://hote-externe.invalid",
      OUTBOX_BDR_L2R_CHEMIN: "/x", OUTBOX_BDR_L2R_JETON: "jeton-0123456789",
    });
    const r = await creerAdaptateurs(config, garde).BDR_L2R!.emettre(demande("BDR_L2R"));
    expect(garde.refus).toEqual(["hote-externe.invalid"]);
    expect(r.issue).toBe("ECHEC_TEMPORAIRE");
    expect(garde.hotesContactes).toEqual([]);
  });
});

describe("destination desactivee", () => {
  it("aucun adaptateur n'est cree pour une destination inactive : aucun chemin vers le reseau", () => {
    const config = lireConfigIntegrations({});
    expect(creerAdaptateurs(config, fetchLocal)).toEqual({});
  });
});
