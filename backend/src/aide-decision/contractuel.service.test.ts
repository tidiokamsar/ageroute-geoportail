import { describe, expect, it } from "vitest";
import { lireContractuel, lireMarche, type DepsContractuel } from "./contractuel.service";
import type { DepotContractuel } from "./contractuel.depot";
import { T0, chantier, decompte, jours, lien, marche, troncon } from "./contractuel.testutil";
import type { MarcheEntree } from "./contractuel.noyau";

/**
 * Service du suivi contractuel avec un depot FAUX injecte : le depot rend tout, le service (via le noyau) filtre.
 * Les routes et le banc PostGIS couvrent le cablage reel ; ici on prouve la logique propre au service.
 */

const ID = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

function deps(marches: MarcheEntree[], o: Partial<DepsContractuel> & { tronque?: boolean } = {}): DepsContractuel & { demandes: unknown[] } {
  const demandes: unknown[] = [];
  const depot: DepotContractuel = {
    async chargerMarches(d) { demandes.push(d); return { marches: marches.slice(0, d.plafond), tronque: o.tronque ?? false, programmes: [], marchesParTroncon: new Map() }; },
    async chargerRegions() { return [{ id: 1, nom: "Conakry" }]; },
    async chantiersSansMarche() { return { nombre: 0, surTotal: 5, exemples: [] }; },
  };
  return { demandes, depot, perimetreDe: async () => ({ national: true }), droitFinancierDe: async () => true, maintenant: () => T0, ...o } as DepsContractuel & { demandes: unknown[] };
}
const compte = { id: "u", role: "ADMIN" };
const requete = { filtres: {}, limite: 25, curseur: null };
const m = (id: number, extra: Partial<MarcheEntree> = {}) => marche({
  id: ID(id), intitule: `M${id}`, montantTotal: BigInt(1_000_000 + id),
  decomptes: [decompte({ statut: "PAYE", montantGnf: BigInt(424_242) })],
  liens: [lien({ chantier: chantier({ id: `c${id}`, tronconId: `t${id}`, troncon: troncon({ id: `t${id}` }) }) })], ...extra,
});

describe("droit financier", () => {
  it("sans droit financier : AUCUN montant, ni dans les marches, ni dans la synthese, ni dans les totaux par bailleur", async () => {
    const r = await lireContractuel(compte, requete, deps([m(1), m(2)], { droitFinancierDe: async () => false }));
    expect(r.droitFinancier).toBe(false);
    const corps = JSON.stringify(r);
    expect(corps).not.toMatch(/1000001|1000002|424242|848484|2000003/);
    for (const x of r.marches) for (const k of ["contractuel", "engage", "decaisse", "previsionnel"] as const) expect(x.montants[k]).toMatchObject({ valeurGnf: null, motif: "DROIT_FINANCIER" });
    expect(r.synthese.financier.contractuel).toMatchObject({ valeurGnf: null, motif: "DROIT_FINANCIER" });
    expect(r.synthese.marchesRecenses.nombre).toBe(2); // le NOMBRE de marches n'est pas un montant
  });

  it("sans droit financier, la fiche masque aussi les montants des décomptes", async () => {
    const f = await lireMarche(compte, ID(1), deps([m(1)], { droitFinancierDe: async () => false }));
    expect(f?.decomptes.liste[0].montantGnf).toBeNull();
    expect(JSON.stringify(f)).not.toMatch(/424242|1000001/);
  });
});

describe("pre-selection et perimetre", () => {
  it("le depot recoit les regions DU PERIMETRE du compte, reduites par le filtre regionId ; la fiche aussi", async () => {
    const d = deps([m(1)], { perimetreDe: async () => ({ national: false, regions: new Set([1, 3]) }) });
    await lireContractuel({ id: "u", role: "GESTIONNAIRE" }, requete, d);
    await lireMarche({ id: "u", role: "GESTIONNAIRE" }, ID(1), d);
    await lireContractuel({ id: "u", role: "GESTIONNAIRE" }, { ...requete, filtres: { regionId: 3 } }, d);
    expect((d.demandes[0] as { regions: number[] }).regions).toEqual([1, 3]);
    expect((d.demandes[1] as { regions: number[]; marcheId: string }).marcheId).toBe(ID(1));
    expect((d.demandes[2] as { regions: number[] }).regions).toEqual([3]);
  });

  it("un compte national sans filtre : aucune pré-sélection (null) ; plafond de 2000 marchés demandé", async () => {
    const d = deps([m(1)]);
    await lireContractuel(compte, requete, d);
    expect(d.demandes[0]).toMatchObject({ regions: null, plafond: 2000 });
  });
});

describe("periode et donnees partielles", () => {
  it("les marches sans aucune date exclus par une fenetre sont comptes dans exclusParFiltre, pas ranges", async () => {
    const avecDate = m(1, { dateDebutPrevue: new Date("2026-02-01"), dateFinPrevue: new Date("2026-03-01") });
    const r = await lireContractuel(compte, { ...requete, filtres: { depuis: "2026-01-01", jusqua: "2026-12-31" } }, deps([avecDate, m(2), m(3)]));
    expect(r.marches.map((x) => x.intitule)).toEqual(["M1"]);
    expect(r.perimetre.exclusParFiltre).toEqual({ sansDate: 2 });
  });

  it("sans fenêtre de période, `exclusParFiltre` n'est pas présent", async () => {
    const r = await lireContractuel(compte, requete, deps([m(1)]));
    expect(r.perimetre.exclusParFiltre).toBeUndefined();
  });

  it("troncature : le plafond atteint est dit dans la réponse et dans les données partielles", async () => {
    const r = await lireContractuel(compte, requete, deps([m(1)], { tronque: true }));
    expect(r.plafond).toMatchObject({ tronque: true, plafond: 2000 });
    expect(r.donneesPartielles.raisons.join(" ")).toMatch(/2000 plus récents/);
  });

  it("la copie ancienne est dite PERIMEE dans la fraicheur", async () => {
    const vieux = m(1, { updatedAt: jours(-300), decomptes: [decompte({ updatedAt: jours(-300) })], createdAt: jours(-400) });
    const r = await lireContractuel(compte, requete, deps([vieux]));
    expect(r.fraicheur.perime).toBe(true);
    expect(r.fraicheur.ageJours).toBe(300);
  });
});

describe("fiche", () => {
  it("marche absent du depot : null (404 en route)", async () => {
    expect(await lireMarche(compte, ID(404), deps([m(1)]))).toBeNull();
  });

  it("marche hors perimetre : null, comme un marche absent", async () => {
    const d = deps([m(1)], { perimetreDe: async () => ({ national: false, regions: new Set([7]) }) });
    expect(await lireMarche({ id: "u", role: "GESTIONNAIRE" }, ID(1), d)).toBeNull();
  });
});
