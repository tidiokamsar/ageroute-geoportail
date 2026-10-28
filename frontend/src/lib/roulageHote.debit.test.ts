// @vitest-environment node
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EntreeJournal } from "../roulage/journal";
import { creerCoffre, stockageEnMemoire, sha256WebCrypto } from "../session/coffreSession";
import { empreinteCompte } from "../session/compteLocal";
import { fermerCompte, ouvrirCompte } from "./compteCourant";
import { OPTIONS_JOURNAL_DEFAUT, stockageIndexedDb } from "./roulageHote";

/**
 * MESURE DU DEBIT D'ECRITURE DU JOURNAL CHIFFRE (pas un test de performance : aucun seuil de temps n'est impose).
 * OPT-IN : `MESURE_DEBIT=1 npx vitest run src/lib/roulageHote.debit.test.ts` (une minute environ ; ignore sinon).
 *
 * Question : chiffrer et ecrire UNE entree a la fois (un echantillon GNSS par entree, de l'ordre de 1 Hz, quelques Hz au
 * mieux) est-il trop couteux, au point d'imposer un regroupement par lots ? Le banc mesure, sur 1 000 echantillons repetes 3
 * fois (MEDIANE des repetitions, une repetition a blanc ecartee) :
 *   - le chiffrement SEUL d'une entree, puis d'un lot de 10 et de 50 entrees ;
 *   - le temps pour vider 1 000 entrees ajoutees d'un coup, par le journal chiffre en lots de 1, 10 et 50.
 * Le second chiffre est un cas de RAFALE (1 000 entrees au meme instant), bien plus dur que le regime reel (une entree par
 * seconde) : il borne le cout, il ne le predit pas.
 *
 * LIMITES : Node 24 (WebCrypto natif) et fake-indexeddb (en memoire, sans disque), sur un poste de developpement DONT D'AUTRES
 * PROCESSUS TOURNENT en meme temps (dispersion forte). Ni un telephone, ni un vrai IndexedDB (son cout est surtout celui de la
 * transaction et du disque, que ce banc ne voit pas). Les chiffres comparent les regimes entre eux, ils ne promettent aucun
 * temps sur appareil. Le test ne verifie que l'exactitude de la relecture.
 */

const N = 1000;
const REPETITIONS = 3;
const mesure = process.env.MESURE_DEBIT === "1";

function echantillon(seq: number): EntreeJournal {
  return {
    seq, type: "ECHANTILLON", segment: 0, trou: null, alertes: [], ecartHorlogeMs: 0, sautsConsecutifs: 0, identiquesConsecutifs: 0,
    echantillon: { tMs: 1_790_000_000_000 + seq * 1000, lat: 9.64 + seq * 1e-5, lon: -13.58, precisionM: 5, vitesseMs: 12.3, capDeg: 91, altitudeM: 40 },
  } as unknown as EntreeJournal;
}
const entrees = Array.from({ length: N }, (_, i) => echantillon(i + 1));

function fauxLocalStorage() {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; }, key: (i: number) => [...m.keys()][i] ?? null, getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear(),
  };
}

const mediane = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
const fmt = (v: number) => v.toFixed(3).replace(".", ",");

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("localStorage", fauxLocalStorage());
  fermerCompte();
});
afterEach(() => { vi.restoreAllMocks(); fermerCompte(); });

describe.skipIf(!mesure)("debit du journal chiffre (mesure opt-in)", () => {
  it(`${N} echantillons : chiffrement seul, puis vidage en lots de 1, 10 et 50`, async () => {
    const coffre = await creerCoffre({
      stockage: stockageEnMemoire(), compteId: "agent-A", appareilId: "tel-1", pin: "246810", maintenantMs: Date.now(), iterations: 1000, iterationsDeTest: true,
      profil: { userId: "agent-A", nom: "A", role: "INSPECTEUR", modules: [], regions: [] },
    });
    ouvrirCompte({ compteId: "agent-A", empreinte: await empreinteCompte("agent-A", sha256WebCrypto), chiffreur: coffre });
    const lignes: string[] = [];

    for (const taille of [1, 10, 50]) {
      const par: number[] = [];
      for (let r = 0; r <= REPETITIONS; r += 1) {
        const t0 = performance.now();
        for (let i = 0; i < N; i += taille) await coffre.chiffrer(entrees.slice(i, i + taille), `agent-A|journal.${i}|1`);
        if (r > 0) par.push((performance.now() - t0) / N);
      }
      lignes.push(`chiffrement seul, blocs de ${String(taille).padStart(2)} entrees : ${fmt(mediane(par))} ms par entree (mediane de ${REPETITIONS})`);
    }

    for (const tailleLot of [1, 10, 50]) {
      const vidage: number[] = []; const lecture: number[] = [];
      for (let r = 0; r <= REPETITIONS; r += 1) {
        vi.stubGlobal("indexedDB", new IDBFactory());
        const j = stockageIndexedDb({ tailleLot, delaiLotMs: 60_000 })!;
        const debut = performance.now();
        entrees.forEach((e) => j.ajouter(e));
        const relues = await j.toutes();            // vide le tampon (ecritures) puis relit et dechiffre
        const total = performance.now() - debut;
        const t2 = performance.now();
        await j.toutes();
        const lectureSeule = performance.now() - t2;
        expect(relues).toEqual(entrees);
        expect(j.echecs()).toBe(0);
        if (r > 0) { vidage.push(Math.max(0, total - lectureSeule) / N); lecture.push(lectureSeule / N); }
      }
      lignes.push(`journal chiffre, lots de ${String(tailleLot).padStart(2)} : vidage ${fmt(mediane(vidage))} ms par entree (rafale de ${N}) ; relecture+dechiffrement ${fmt(mediane(lecture))} ms par entree`);
    }
    console.info(`DEBIT DU JOURNAL (Node 24, fake-indexeddb, ${N} echantillons, mediane de ${REPETITIONS} repetitions, defaut tailleLot=${OPTIONS_JOURNAL_DEFAUT.tailleLot}) :\n  ${lignes.join("\n  ")}`);
  }, 300_000);
});

describe("debit du journal chiffre", () => {
  it("la mesure est opt-in (MESURE_DEBIT=1) : elle ne ralentit pas la suite", () => {
    expect(typeof mesure).toBe("boolean");
  });
});
