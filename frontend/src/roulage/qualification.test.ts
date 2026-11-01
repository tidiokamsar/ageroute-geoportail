import { describe, expect, it } from "vitest";
import { alimenter, demarrerBanc, T0 } from "./aide-test";
import { appliquerEntree, etatInitial } from "./etat";
import { construirePayload } from "./contrat";
import { SessionRoulage } from "./session";

/**
 * Qualification d'un segment saisie APRES son ouverture (a la fin du segment, ou en cours de route).
 *
 * Ce que ces tests defendent :
 *   - la qualification d'un evenement OUVERT se pose, se remplace et s'efface, et part dans la charge ;
 *   - elle survit a un redemarrage (journal rejoue) : une saisie faite a l'ecran n'est pas perdue avec la page ;
 *   - elle ne change JAMAIS un evenement clos, abandonne ou inconnu (on ne reecrit pas ce qui est decide) ;
 *   - un code de referentiel hors des bornes du serveur est refuse a la saisie, sans etre corrige.
 * Rien ici ne dit que le code saisi existe au referentiel : seul le serveur le sait (il refuse alors la portion).
 */

function ouvrir(b: ReturnType<typeof demarrerBanc>) {
  alimenter(b, 0, 10);
  const d = b.session.debutEvenement("SEGMENT");
  if (!d.ok) throw new Error("debut");
  return d.evenement.id;
}

describe("qualifierEvenement", () => {
  it("pose la qualification sur un segment ouvert sans qualification, et elle part dans la charge", () => {
    const b = demarrerBanc();
    const id = ouvrir(b);
    expect(b.session.etat.evenements[0].qualification).toBeNull();
    alimenter(b, 11, 40);
    const q = b.session.qualifierEvenement(id, { revetement: "BITUME", etat: "MAUVAIS" });
    expect(q.ok).toBe(true);
    expect(b.session.finEvenement(id).ok).toBe(true);
    b.session.arreter();
    const p = construirePayload(b.session.etat);
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.payload.evenements[0].qualification).toEqual({ revetement: "BITUME", etat: "MAUVAIS" });
  });

  it("remplace une qualification posee au debut (le dernier mot est celui de l'agent) et l'efface avec null", () => {
    const b = demarrerBanc();
    alimenter(b, 0, 5);
    const d = b.session.debutEvenement("SEGMENT", { qualification: { etat: "BON" } });
    if (!d.ok) throw new Error("debut");
    expect(b.session.qualifierEvenement(d.evenement.id, { etat: "MAUVAIS" }).ok).toBe(true);
    expect(b.session.etat.evenements[0].qualification).toEqual({ etat: "MAUVAIS" });
    expect(b.session.qualifierEvenement(d.evenement.id, null).ok).toBe(true);
    expect(b.session.etat.evenements[0].qualification).toBeNull();
  });

  it("survit a un redemarrage : le journal rejoue redonne la qualification, avec le segment encore ouvert", () => {
    const b = demarrerBanc();
    const id = ouvrir(b);
    b.session.qualifierEvenement(id, { revetement: "LATERITE", praticabilite: "DIFFICILE" });
    const r = SessionRoulage.rejouer(b.journal.entrees, { horloge: b.horloge, genererId: b.opts.genererId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ignorees).toEqual([]);
    expect(r.session.etat.evenements[0]).toMatchObject({ statut: "OUVERT", qualification: { revetement: "LATERITE", praticabilite: "DIFFICILE" } });
  });

  it("refuse de modifier un evenement clos, abandonne, inconnu, ou apres l'arret : rien ne change", () => {
    const b = demarrerBanc();
    const id = ouvrir(b);
    alimenter(b, 11, 40);
    b.session.qualifierEvenement(id, { etat: "BON" });
    b.session.finEvenement(id);
    expect(b.session.qualifierEvenement(id, { etat: "MAUVAIS" })).toMatchObject({ ok: false, refus: "EVENEMENT_NON_OUVERT" });
    expect(b.session.etat.evenements[0].qualification).toEqual({ etat: "BON" });
    expect(b.session.qualifierEvenement("00000000-0000-4000-8000-0000000000ff", { etat: "BON" })).toMatchObject({ ok: false, refus: "EVENEMENT_INCONNU" });

    const d2 = b.session.debutEvenement("SEGMENT");
    if (!d2.ok) throw new Error("debut2");
    b.session.abandonnerEvenement(d2.evenement.id);
    expect(b.session.qualifierEvenement(d2.evenement.id, { etat: "BON" })).toMatchObject({ ok: false, refus: "EVENEMENT_NON_OUVERT" });

    b.session.arreter();
    expect(b.session.qualifierEvenement(id, { etat: "BON" })).toMatchObject({ ok: false, refus: "SESSION_ARRETEE" });
  });

  it("refuse un code hors des bornes du serveur (vide, trop long, non texte) et une largeur absurde, sans rien corriger", () => {
    const b = demarrerBanc();
    const id = ouvrir(b);
    expect(b.session.qualifierEvenement(id, { etat: "" })).toMatchObject({ ok: false, refus: "QUALIFICATION_INVALIDE" });
    expect(b.session.qualifierEvenement(id, { revetement: "X".repeat(65) })).toMatchObject({ ok: false, refus: "QUALIFICATION_INVALIDE" });
    expect(b.session.qualifierEvenement(id, { praticabilite: 12 as unknown as string })).toMatchObject({ ok: false, refus: "QUALIFICATION_INVALIDE" });
    expect(b.session.qualifierEvenement(id, { largeurM: 0 })).toMatchObject({ ok: false, refus: "QUALIFICATION_INVALIDE" });
    expect(b.session.qualifierEvenement(id, { largeurM: 101 })).toMatchObject({ ok: false, refus: "QUALIFICATION_INVALIDE" });
    expect(b.session.etat.evenements[0].qualification).toBeNull();
    expect(b.session.debutEvenement("AUTRE", { qualification: { etat: "" } })).toMatchObject({ ok: false, refus: "QUALIFICATION_INVALIDE" });
  });

  it("une entree orpheline (evenement inconnu ou deja clos) est ignoree avec sa raison, sans planter", () => {
    const etat = etatInitial({ sessionId: "s", parametres: demarrerBanc().session.etat.parametres, agentRef: null, debutMs: T0 });
    expect(appliquerEntree(etat, { type: "EVT_QUALIFICATION", id: "inconnu", qualification: { etat: "BON" }, tMs: T0, seq: 2 })).toBe("EVENEMENT_INCONNU");
  });
});
