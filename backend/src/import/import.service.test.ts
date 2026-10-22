import { describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";

/**
 * Reception d'un lot : le comportement face a la COURSE entre deux envois, que seul un second
 * envoi simultane reproduit. Le depot est une memoire ; la vraie unicite est eprouvee en base par
 * `tests-integration/import.integration.mts` (section 8).
 */
vi.mock("../utils/audit", () => ({ logAuditTransactionnelle: vi.fn(async () => undefined) }));

import { recevoirLot, empreinteSha256, type DepotImport } from "./import.service";

const fichier = Buffer.from("systeme_source;type_objet;identifiant_source\nONR;comptage;A\n");
const demande = {
  fichier, nomFichier: "a.csv", format: "csv" as const, systemeSource: "ONR", methodeSource: "export",
  versionMapping: "v1", autorisationRef: "AUT-1", importeParId: "u1",
};
const violation = () => Object.assign(new Error("Unique constraint failed"), { code: "P2002" });

function depotAvec(opts: { transactions: Array<() => unknown>; apresEchec?: unknown }) {
  const file = [...opts.transactions];
  let lecture = 0;
  const depot = {
    lotImport: {
      findUnique: vi.fn(async () => {
        lecture += 1;
        // 1re lecture : pas encore recu ; ensuite : ce que la gagnante de la course a enregistre.
        return lecture === 1 ? null : (opts.apresEchec ?? null);
      }),
    },
    ligneImport: {},
    $transaction: vi.fn(async () => { const f = file.shift(); if (!f) throw new Error("plus de transaction prevue"); return f(); }),
  };
  return depot as unknown as DepotImport & { $transaction: ReturnType<typeof vi.fn> };
}

const lotExistant = {
  id: "lot-1", reference: "IMP-2026-00001", statut: "VALIDE_SCHEMA", rapport: null,
  lignesLues: 1, lignesValidees: 1, lignesImportees: 0, lignesRejetees: 0, lignesEnConflit: 0, lignesIgnorees: 0,
  empreinteFichier: empreinteSha256(fichier),
};

describe("course entre deux envois du meme fichier", () => {
  it("la perdante rend le lot de la gagnante, sans erreur, et sans rien ecrire de plus", async () => {
    const depot = depotAvec({ transactions: [() => { throw violation(); }], apresEchec: lotExistant });
    const r = await recevoirLot(depot, demande);
    expect(r).toMatchObject({ id: "lot-1", dejaRecu: true, compteurs: { lues: 1, validees: 1 } });
    expect(depot.$transaction).toHaveBeenCalledTimes(1);
  });

  it("une collision de REFERENCE (autre fichier en meme temps) est reessayee avec un numero a jour", async () => {
    const depot = depotAvec({ transactions: [() => { throw violation(); }, () => ({ id: "lot-2", reference: "IMP-2026-00002", dejaRecu: false })] });
    const r = await recevoirLot(depot, demande);
    expect(r).toMatchObject({ id: "lot-2", dejaRecu: false });
    expect(depot.$transaction).toHaveBeenCalledTimes(2);
  });

  it("une unicite qui persiste est signalee apres huit essais, pas avalee", async () => {
    const depot = depotAvec({ transactions: Array.from({ length: 8 }, () => () => { throw violation(); }) });
    await expect(recevoirLot(depot, demande)).rejects.toMatchObject({ code: "P2002" });
    expect(depot.$transaction).toHaveBeenCalledTimes(8);
  });

  it("une autre erreur n'est jamais reessayee", async () => {
    const depot = depotAvec({ transactions: [() => { throw new Error("disque plein"); }] });
    await expect(recevoirLot(depot, demande)).rejects.toThrow("disque plein");
    expect(depot.$transaction).toHaveBeenCalledTimes(1);
  });
});
