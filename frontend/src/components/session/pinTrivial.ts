import { LONGUEUR_PIN_MAX, LONGUEUR_PIN_MIN } from "../../session/coffreSession";

/**
 * Regles de choix du code PIN a la creation et au changement (conception : SESSION-HORS-LIGNE.md, section 3).
 *
 * Le coffre n'exige que la longueur (6 a 128 caracteres). Un PIN de six chiffres n'offre deja que 10^6 possibilites ;
 * en plus, les codes que tout le monde essaie en premier (123456, 000000) reduiraient encore ce que le delai entre essais
 * protege. On refuse donc, et on dit pourquoi, en francais clair :
 *
 *   - UNE SEULE REPETITION du meme caractere (111111) ;
 *   - une SUITE reguliere montante ou descendante (123456, 654321, abcdef), avec bouclage 9 -> 0 pour les chiffres (890123) ;
 *   - un motif de 1 a 3 caracteres REPETE (121212, 123123), ou chaque caractere DOUBLE (112233) ;
 *   - la LISTE COURTE ci-dessous : les codes de clavier et de date les plus courants. Liste volontairement petite et
 *     figee par le test : elle ne remplace pas une phrase de passe, qu'il faut encourager.
 *
 * Ces regles ne rendent pas un PIN a six chiffres fort. Elles evitent les pires choix, pas plus.
 */

/** Codes les plus courants non couverts par les regles de suite et de repetition. */
export const PIN_LISTE_COURTE: readonly string[] = [
  "147258", "258369", "369258", "159753", "357951", "741852", "852963", "963852", "789456", "456123",
  "123654", "321654", "654123", "111222", "222333", "101010", "202020", "100000", "123000", "121314",
  "520520", "201314", "112211", "123321", "696969",
];

export type MotifPinRefuse = "VIDE" | "TROP_COURT" | "TROP_LONG" | "UN_SEUL_CARACTERE" | "SUITE" | "MOTIF_REPETE" | "LISTE_COURTE";

export type AnalysePin =
  | { readonly acceptable: true }
  | { readonly acceptable: false; readonly motif: MotifPinRefuse; readonly message: string };

const refus = (motif: MotifPinRefuse, message: string): AnalysePin => ({ acceptable: false, motif, message });

function estSuite(c: readonly number[], pas: 1 | -1, modulo: number | null): boolean {
  const norme = (n: number) => (modulo === null ? n : ((n % modulo) + modulo) % modulo);
  for (let i = 1; i < c.length; i += 1) {
    if (norme(c[i] - c[i - 1]) !== norme(pas)) return false;
  }
  return true;
}

function estMotifRepete(s: string): boolean {
  const car = Array.from(s);
  for (let taille = 1; taille <= 3; taille += 1) {
    if (car.length % taille !== 0 || car.length / taille < 2) continue;
    const motif = car.slice(0, taille).join("");
    if (motif.repeat(car.length / taille) === s) return true;
  }
  // Chaque caractere double : 112233, 998877.
  if (car.length % 2 === 0 && car.every((c, i) => i % 2 === 0 || c === car[i - 1])) return true;
  return false;
}

export function analyserPin(pin: string): AnalysePin {
  if (typeof pin !== "string" || pin.length === 0) return refus("VIDE", "Saisissez un code.");
  const s = pin.normalize("NFKC");
  const car = Array.from(s);
  if (car.length < LONGUEUR_PIN_MIN) return refus("TROP_COURT", `Le code doit compter au moins ${LONGUEUR_PIN_MIN} caractères.`);
  if (car.length > LONGUEUR_PIN_MAX) return refus("TROP_LONG", `Le code ne peut pas dépasser ${LONGUEUR_PIN_MAX} caractères.`);

  if (new Set(car).size === 1) return refus("UN_SEUL_CARACTERE", "Ce code répète le même caractère : n'importe qui l'essaierait en premier.");

  const codes = car.map((c) => c.toLowerCase().codePointAt(0) as number);
  const chiffres = car.every((c) => c >= "0" && c <= "9");
  const valeurs = chiffres ? car.map(Number) : codes;
  if (estSuite(valeurs, 1, chiffres ? 10 : null) || estSuite(valeurs, -1, chiffres ? 10 : null)) {
    return refus("SUITE", "Ce code est une suite (123456, 654321, abcdef) : choisissez un code moins prévisible.");
  }
  if (estMotifRepete(s)) return refus("MOTIF_REPETE", "Ce code répète un motif court (121212, 123123, 112233) : choisissez un code moins prévisible.");
  if (PIN_LISTE_COURTE.includes(s.toLowerCase())) return refus("LISTE_COURTE", "Ce code figure parmi les plus utilisés : choisissez-en un autre.");
  return { acceptable: true };
}
