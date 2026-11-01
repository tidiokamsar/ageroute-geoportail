import { describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";

/**
 * Reception d'un lot : le comportement face a la COURSE entre deux envois, que seul un second
 * envoi simultane reproduit, et face a la SATURATION. Le depot est une memoire ; la vraie unicite
 * est eprouvee en base par `tests-integration/import.integration.mts` (section 8).
 */
vi.mock("../utils/audit", () => ({ logAuditTransactionnelle: vi.fn(async () => undefined) }));

import { ServiceOccupe, recevoirLot, empreinteSha256, type DepotImport } from "./import.service";
import { Limiteur } from "./limiteur";

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
      findMany: vi.fn(async () => []),
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
  autorisationRef: "AUT-1", versionMapping: "v1", methodeSource: "export", auteurSource: null, dateSource: null,
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

  it("une unicite qui persiste apres huit essais devient un service OCCUPE (503), pas un 409 « valeur unique »", async () => {
    const depot = depotAvec({ transactions: Array.from({ length: 8 }, () => () => { throw violation(); }) });
    await expect(recevoirLot(depot, demande)).rejects.toBeInstanceOf(ServiceOccupe);
    expect(depot.$transaction).toHaveBeenCalledTimes(8);
  });

  it("une connexion introuvable (P2024) ou une transaction expiree (P2028) est un service OCCUPE, jamais un 500", async () => {
    for (const code of ["P2024", "P2028"]) {
      const depot = depotAvec({ transactions: [() => { throw Object.assign(new Error("pool"), { code }); }] });
      await expect(recevoirLot(depot, demande)).rejects.toBeInstanceOf(ServiceOccupe);
      expect(depot.$transaction).toHaveBeenCalledTimes(1);
    }
  });

  it("une autre erreur n'est jamais reessayee", async () => {
    const depot = depotAvec({ transactions: [() => { throw new Error("disque plein"); }] });
    await expect(recevoirLot(depot, demande)).rejects.toThrow("disque plein");
    expect(depot.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe("source avec espaces : la cle d'unicite est la valeur enregistree (rognee)", () => {
  it("cherche le lot existant avec la source rognee, comme elle est stockee", async () => {
    const depot = depotAvec({ transactions: [() => ({ id: "x", reference: "r", dejaRecu: false })] });
    await recevoirLot(depot, { ...demande, systemeSource: "  ONR  " });
    const arg = (depot.lotImport.findUnique as ReturnType<typeof vi.fn>).mock.calls[0][0] as { where: { systemeSource_empreinteFichier: { systemeSource: string } } };
    expect(arg.where.systemeSource_empreinteFichier.systemeSource).toBe("ONR");
  });
});

describe("saturation", () => {
  it("le limiteur injecte decide : une reception qui n'obtient pas de place leve ServiceOccupe sans toucher la base", async () => {
    const limiteur = new Limiteur(1, 20);
    let liberer!: () => void;
    const occupe = limiteur.executer(() => new Promise<void>((r) => { liberer = r; }));
    const depot = depotAvec({ transactions: [() => ({ id: "x", reference: "r", dejaRecu: false })] });
    await expect(recevoirLot(depot, demande, { limiteur })).rejects.toBeInstanceOf(ServiceOccupe);
    expect(depot.$transaction).not.toHaveBeenCalled();
    liberer(); await occupe;
  });
});
