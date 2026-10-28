import { compter, empreinte, empreinteSensible, requete } from "../lib/base";
import { expect, test } from "../lib/fixtures";

/**
 * Parcours 8 : INTEGRITE, apres tous les parcours precedents (decisions, mission, verification de source, depots) :
 *   - le referentiel officiel (troncons, portions, ouvrages) n'a pas bouge d'un bit (empreinte SHA-256 de chaque table, avant / apres) ;
 *   - la sonde est sensible (temoin : modifier une ligne dans une transaction annulee change l'empreinte) ;
 *   - aucune suppression physique, journal coherent avec les statuts, verdicts signes et cites, vue de coherence vide.
 */
test.describe("integrite du referentiel et des donnees apres le scenario", () => {
  test("empreinte SHA-256 des troncons, portions et ouvrages : identique avant et apres tout le scenario", async ({ run }) => {
    expect(run.empreinteAvant, "empreinte prise apres le semis").toBeTruthy();
    const apres = await empreinte();
    console.log(`[empreintes] avant ${JSON.stringify(run.empreinteAvant)}\n             apres ${JSON.stringify(apres)}`);
    for (const t of ["troncons", "portions", "ouvrages"]) expect(apres[t], t).toBe(run.empreinteAvant![t]);
    // Les tables ne sont pas vides : l'empreinte porte sur quelque chose.
    expect(await compter(`SELECT count(*) FROM troncons`)).toBe(4);
    expect(await compter(`SELECT count(*) FROM portions`)).toBe(2);
    expect(await compter(`SELECT count(*) FROM ouvrages`)).toBe(1);
  });

  test("temoin : la sonde detecte une modification (transaction annulee)", async () => {
    const { avant, pendant, apres } = await empreinteSensible();
    for (const t of ["troncons", "portions", "ouvrages"]) {
      expect(pendant[t], `${t} : une ligne modifiee doit changer l'empreinte`).not.toBe(avant[t]);
      expect(apres[t], `${t} : apres annulation, l'empreinte revient`).toBe(avant[t]);
    }
  });

  test("aucune suppression physique ; journal et statuts coherents ; verdicts signes et cites", async ({ run }) => {
    expect(await compter(`SELECT count(*) FROM propositions_teledetection`)).toBe(run.depot!.total);
    expect(await compter(`SELECT count(*) FROM earth_observation_products`)).toBeGreaterThanOrEqual(run.produits.length);
    // Chaque proposition dont le journal n'est pas vide a pour statut la destination de sa derniere ligne.
    const incoherentes = await requete<{ id: string; statut: string; vers: string }>(
      `SELECT pt.id, pt.statut, (SELECT vers FROM propositions_teledetection_transitions t WHERE t."propositionId" = pt.id ORDER BY t."creeLe" DESC, t.id DESC LIMIT 1) AS vers
         FROM propositions_teledetection pt WHERE EXISTS (SELECT 1 FROM propositions_teledetection_transitions t WHERE t."propositionId" = pt.id)`);
    for (const l of incoherentes) expect(l.vers, `proposition ${l.id}`).toBe(l.statut);
    // Une proposition qui a change de statut a au moins une ligne de journal ; une proposition « A_VERIFIER » jamais touchee n'en a aucune.
    const sansJournal = await compter(`SELECT count(*) FROM propositions_teledetection pt WHERE pt.statut <> 'A_VERIFIER' AND NOT EXISTS (SELECT 1 FROM propositions_teledetection_transitions t WHERE t."propositionId" = pt.id)`);
    expect(sansJournal).toBe(0);
    // Verdicts : signes, dates, motif et constat.
    const verdicts = await requete<{ id: string; verifieeParId: string | null; verifieeLe: Date | null; motifVerdict: string | null; constatRef: string | null }>(
      `SELECT id, "verifieeParId", "verifieeLe", "motifVerdict", "constatRef" FROM propositions_teledetection WHERE statut IN ('CONFIRMEE', 'INFIRMEE')`);
    expect(verdicts.length).toBeGreaterThanOrEqual(2);
    for (const v of verdicts) {
      expect(v.verifieeParId).toBeTruthy();
      expect(v.verifieeLe).toBeTruthy();
      expect(v.motifVerdict).toBeTruthy();
      expect(v.constatRef).toBeTruthy();
    }
    // Vue de coherence (detection hors emprise, reference non anterieure, troncon supprime...) : vide.
    expect(await compter(`SELECT count(*) FROM coherence_teledetection`)).toBe(0);
    // Aucune ecriture d'audit sur le referentiel officiel pendant ce scenario.
    const surReferentiel = await compter(`SELECT count(*) FROM audit_logs WHERE "entityType" IN ('Troncon', 'Portion', 'Ouvrage') AND "createdAt" >= (SELECT min("createdAt") FROM propositions_teledetection)`);
    expect(surReferentiel).toBe(0);
    // Les donnees de test ne sont pas des donnees synthetiques : le drapeau reste faux (consigne), et le message le dit dans chaque proposition.
    expect(await compter(`SELECT count(*) FROM propositions_teledetection WHERE synthetique`)).toBe(0);
    expect(await compter(`SELECT count(*) FROM propositions_teledetection WHERE "methodeNom" <> 'fixture-e2e-eo'`)).toBe(0);
  });

  test("ecritures auditees : decisions, mission, verification de source, depots", async ({ run }) => {
    const l = await requete<{ entityType: string; action: string; n: string }>(
      `SELECT "entityType", action::text AS action, count(*)::text AS n FROM audit_logs GROUP BY 1, 2 ORDER BY 1, 2`);
    const table = l.map((x) => `${x.entityType}/${x.action}=${x.n}`);
    console.log(`[audit complet] ${table.join(", ")}`);
    const par = (t: string, a: string) => Number(l.find((x) => x.entityType === t && x.action === a)?.n ?? 0);
    expect(par("PropositionTeledetection", "CREATE")).toBeGreaterThan(0);
    expect(par("Mission", "CREATE")).toBe(1);
    expect(par("EarthObservationProduct", "CREATE")).toBe(run.synchro!.nouveaux);
    expect(await compter(`SELECT count(*) FROM audit_logs WHERE "userId" IS NULL AND "entityType" IN ('PropositionTeledetection', 'Mission', 'SourceObservation')`)).toBe(0);
  });
});
