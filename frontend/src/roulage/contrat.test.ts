import { describe, expect, it } from "vitest";
import { alimenter, demarrerBanc, T0 } from "./aide-test";
import { construirePayload, interpreterReponse, operationPourSynchronisation, TYPE_ENTITE, VERSION_CONTRAT } from "./contrat";
import { PROVENANCE_PARAMETRES } from "./parametres";

describe("construirePayload", () => {
  it("refuse tant que la session n'est pas arretee, et avec moins de deux points", () => {
    const b = demarrerBanc();
    alimenter(b, 0, 10);
    expect(construirePayload(b.session.etat)).toEqual({ ok: false, refus: "SESSION_NON_ARRETEE" });
    const vide = demarrerBanc();
    vide.session.arreter();
    expect(construirePayload(vide.session.etat)).toEqual({ ok: false, refus: "TROP_PEU_DE_POINTS" });
  });

  it("produit une charge compacte, ordonnee, sans doublon, qui nomme la provenance PROVISOIRE des seuils", () => {
    const b = demarrerBanc();
    alimenter(b, 0, 30);
    b.session.poserMarqueur("NID_DE_POULE", { note: "x" });
    const d = b.session.debutEvenement("ETAT_CHAUSSEE", { qualification: { etat: "MAUVAIS" } });
    alimenter(b, 31, 60);
    if (d.ok) b.session.finEvenement(d.evenement.id);
    b.session.arreter();
    const r = construirePayload(b.session.etat, { missionId: "00000000-0000-4000-8000-0000000000aa" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.payload;
    expect(p.versionContrat).toBe(VERSION_CONTRAT);
    expect(p.provenanceParametres).toBe(PROVENANCE_PARAMETRES);
    expect(p.missionId).toBe("00000000-0000-4000-8000-0000000000aa");
    expect(p.points).toHaveLength(61);
    expect(p.points[0]).toHaveLength(6);
    const temps = p.points.map((x) => x[0]);
    expect(temps).toEqual([...temps].sort((a, c) => a - c));
    expect(new Set(temps).size).toBe(temps.length);
    expect(p.debutMs).toBe(T0);
    expect(p.finMs).toBe(T0 + 60_000);
    expect(p.marqueurs[0]).toMatchObject({ code: "NID_DE_POULE", note: "x" });
    expect(p.evenements[0]).toMatchObject({ code: "ETAT_CHAUSSEE", statut: "CLOS", qualification: { etat: "MAUVAIS" } });
    expect(Object.keys(p)).not.toContain("iri");
  });

  it("deux heures a 1 Hz tiennent dans une charge de moins de 1 Mo (le serveur plafonne a 5 Mo par requete)", () => {
    const b = demarrerBanc();
    alimenter(b, 0, 7199);
    b.session.arreter();
    const r = construirePayload(b.session.etat);
    if (!r.ok) throw new Error("payload");
    const octets = JSON.stringify(r.payload).length;
    expect(r.payload.points).toHaveLength(7200);
    expect(octets).toBeLessThan(1_000_000);
  });

  it("l'operation de synchronisation reprend la convention des portions et des defauts : operationId = entityId = sessionId", () => {
    const b = demarrerBanc();
    alimenter(b, 0, 5);
    b.session.arreter();
    const r = construirePayload(b.session.etat);
    if (!r.ok) throw new Error("payload");
    const op = operationPourSynchronisation(r.payload);
    expect(op).toMatchObject({
      operationId: b.session.etat.sessionId, entityId: b.session.etat.sessionId, entityType: TYPE_ENTITE, operation: "CREATE", baseVersion: null,
    });
  });
});

describe("interpreterReponse (meme regle que les portions)", () => {
  it("SYNCHRONISE et REJOUEE sortent de la file ; REJOUEE le dit", () => {
    expect(interpreterReponse({ statut: "SYNCHRONISE" })).toEqual({ action: "RETIRER_DE_LA_FILE", rejeu: false });
    expect(interpreterReponse({ statut: "REJOUEE" })).toEqual({ action: "RETIRER_DE_LA_FILE", rejeu: true });
  });
  it("un REJETE sans delai est definitif : la session est conservee, marquee abandonnee, jamais retentee en boucle", () => {
    expect(interpreterReponse({ statut: "REJETE", motif: "PAYLOAD_INVALIDE" })).toEqual({ action: "ABANDONNER", motif: "PAYLOAD_INVALIDE" });
  });
  it("un REJETE avec delai, un CONFLIT, une reponse absente ou inconnue se reessaient", () => {
    expect(interpreterReponse({ statut: "REJETE", motif: "X", reessayerDansMs: 60_000 })).toEqual({ action: "REESSAYER", apresMs: 60_000, motif: "X" });
    expect(interpreterReponse({ statut: "CONFLIT", motif: "DEJA_EXISTANTE" })).toMatchObject({ action: "REESSAYER" });
    expect(interpreterReponse(undefined)).toEqual({ action: "REESSAYER", apresMs: null, motif: "REPONSE_ABSENTE" });
  });
});
