/**
 * Aides partagees par les tests du noyau de roulage. Support de test : jamais importe par du code de production.
 */
import { horlogeSimulee, type HorlogeSimulee } from "./horloge";
import { JournalMemoire } from "./journal";
import { deplacer } from "./geodesie";
import { SessionRoulage, type OptionsSession } from "./session";
import type { EchantillonGnss } from "./types";

export const DEPART = { lat: 9.64, lon: -13.6 };
export const T0 = 1_790_000_000_000;

/** Identifiants deterministes au format uuid v4 (le serveur exige un uuid). */
export function generateurIds(prefixe = 1): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `${String(prefixe).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
  };
}

/** Un echantillon a la seconde `s` depuis T0, a `vitesseMs` vers l'est depuis DEPART, sans bruit. */
export function echantillon(s: number, vitesseMs = 10, surcharge: Partial<EchantillonGnss> = {}): EchantillonGnss {
  const p = deplacer(DEPART, vitesseMs * s, 0);
  return { tMs: T0 + s * 1000, lat: p.lat, lon: p.lon, precisionM: 5, vitesseMs, capDeg: 90, altitudeM: null, ...surcharge };
}

export interface Banc {
  horloge: HorlogeSimulee;
  journal: JournalMemoire;
  session: SessionRoulage;
  opts: OptionsSession;
}

export function demarrerBanc(parametres: OptionsSession["parametres"] = {}, extra: Partial<OptionsSession> = {}): Banc {
  const horloge = horlogeSimulee(T0);
  const journal = new JournalMemoire();
  const opts: OptionsSession = { horloge, genererId: generateurIds(), parametres, journal: journal.sink, ...extra };
  const r = SessionRoulage.demarrer(opts);
  if (!r.ok) throw new Error(`demarrage refuse : ${r.erreurs.join(", ")}`);
  return { horloge, journal, session: r.session, opts };
}

/** Avance l'horloge jusqu'a la seconde `s` (depuis T0) et fournit l'echantillon correspondant. */
export function alimenter(b: Banc, de: number, a: number, vitesseMs = 10): void {
  for (let s = de; s <= a; s += 1) {
    b.horloge.fixer(T0 + s * 1000);
    b.session.ajouterEchantillon(echantillon(s, vitesseMs));
  }
}
