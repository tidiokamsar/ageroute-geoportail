import type { ControleLot, LotListe } from "./types";

/**
 * Formatage commun de la liste et du détail d'un lot, plus le tableau des compteurs du contrôle.
 *
 * Tout ce qui est ici est PUR (ni horloge, ni DOM) et ne produit jamais un chiffre que le serveur
 * n'a pas donné : un compteur absent ou non fini est dit « non calculable », jamais ramené à 0.
 */

/** Nombre entier lisible en français (espace fine pour les milliers). Valeur non finie : texte neutre. */
export function nombre(n: number | null | undefined): string {
  return typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("fr-FR") : "non calculable";
}

const UNITES = ["Ko", "Mo", "Go", "To"] as const;

/**
 * Taille d'un fichier à partir de la CHAÎNE du serveur (un BigInt sérialisé).
 *
 * POURQUOI BIGINT : au-delà de 2^53 octets, `Number("9007199254740993")` rend `9007199254740992` sans
 * rien dire. La division se fait donc en BigInt ; seul le résultat déjà réduit (en dixièmes d'unité)
 * repasse en nombre. L'exact (en octets, avec séparateurs) est rendu à part pour l'infobulle, sans
 * aucun passage par `Number`. Une chaîne qui n'est pas un entier décimal rend `null` : on ne devine pas.
 */
export function formatTaille(brut: string | null | undefined): { lisible: string; exact: string } | null {
  if (typeof brut !== "string" || !/^\d{1,40}$/.test(brut.trim())) return null;
  const octets = BigInt(brut.trim());
  const exact = `${octets.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")} octets`;
  if (octets < 1024n) return { lisible: `${octets.toString()} ${octets === 1n ? "octet" : "octets"}`, exact };
  let unite = 0;
  let diviseur = 1024n;
  while (unite < UNITES.length - 1 && octets >= diviseur * 1024n) { diviseur *= 1024n; unite++; }
  const dixiemes = Number((octets * 10n) / diviseur) / 10;
  const texte = dixiemes.toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return { lisible: `${texte} ${UNITES[unite]}`, exact };
}

/** Date lisible ; une valeur illisible est rendue telle quelle (texte), jamais « Invalid Date ». */
export function formaterDate(iso: string | null | undefined, avecHeure = true): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("fr-FR", avecHeure ? { dateStyle: "short", timeStyle: "short" } : { dateStyle: "short" });
}

/**
 * Rend VISIBLES les caractères de contrôle et ceux qui trompent l'oeil.
 *
 * POURQUOI : une valeur importée ou un nom de fichier est une donnée d'un tiers. React l'échappe (aucune
 * balise n'est interprétée), mais un saut de ligne, un NUL ou un « RLO » (U+202E, qui inverse l'ordre
 * d'affichage : `gpj.exe` lu « exe.jpg ») restent invisibles ou trompeurs dans une cellule. On les
 * remplace par leur symbole (U+2400 et suivants pour les codes C0, ⟨U+XXXX⟩ pour les autres) : l'agent voit
 * qu'il y en a, et ne les exécute ni ne les subit.
 */
export function rendreVisible(valeur: unknown): string {
  const texte = typeof valeur === "string" ? valeur : valeur == null ? "" : String(valeur);
  let sortie = "";
  for (const car of texte) {
    const c = car.codePointAt(0) ?? 0;
    if (c <= 0x1f) sortie += String.fromCodePoint(0x2400 + c);
    else if (c === 0x7f) sortie += "␡";
    else if (
      (c >= 0x80 && c <= 0x9f) || c === 0xad || c === 0x61c || (c >= 0x200b && c <= 0x200f)
      || c === 0x2028 || c === 0x2029 || (c >= 0x202a && c <= 0x202e) || (c >= 0x2060 && c <= 0x206f)
      || c === 0xfeff || (c >= 0xd800 && c <= 0xdfff)
    ) sortie += `⟨U+${c.toString(16).toUpperCase().padStart(4, "0")}⟩`;
    else sortie += car;
  }
  return sortie;
}

const plurielAccord = (n: number, un: string, plusieurs: string) => `${nombre(n)} ${n > 1 ? plusieurs : un}`;

type CompteursListe = Pick<LotListe, "lignesLues" | "lignesValidees" | "lignesRejetees" | "lignesIgnorees" | "lignesEnConflit">;

/**
 * Résumé lisible du contrôle du schéma : « 8 conformes, 2 rejetées ».
 *
 * Il ne dit que ce que le serveur a compté. `lignesImportees` n'y figure PAS : ce n'est pas un résultat
 * du contrôle, et le présenter à côté des conformes ferait lire une réussite d'application qui n'existe
 * pas (aucun code ne produit IMPORTE_TEST ni IMPORTE).
 */
export function resumeControle(lot: CompteursListe): string {
  const valeurs = [lot.lignesLues, lot.lignesValidees, lot.lignesRejetees, lot.lignesIgnorees, lot.lignesEnConflit];
  if (!valeurs.every((v) => typeof v === "number" && Number.isFinite(v))) return "Compteurs non calculables";
  if (lot.lignesLues === 0) return "Aucune ligne lue";
  const parties = [plurielAccord(lot.lignesValidees, "conforme", "conformes")];
  if (lot.lignesRejetees > 0) parties.push(plurielAccord(lot.lignesRejetees, "rejetée", "rejetées"));
  if (lot.lignesIgnorees > 0) parties.push(plurielAccord(lot.lignesIgnorees, "ignorée", "ignorées"));
  if (lot.lignesEnConflit > 0) parties.push(`${nombre(lot.lignesEnConflit)} en conflit`);
  return parties.join(", ");
}

/** Libellés des statuts de ligne (ceux du contrat : le client ne les invente pas). */
export const LIBELLE_STATUT_LIGNE: Record<string, string> = {
  VALIDEE: "Conforme",
  IMPORTEE: "Importée",
  REJETEE: "Rejetée",
  EN_CONFLIT: "En conflit",
  IGNOREE: "Ignorée",
};

/** Classes d'une pastille de statut de ligne. Aucun vert : « conforme » n'est pas « appliqué ». */
export function classePastilleLigne(statut: string): string {
  switch (statut) {
    case "REJETEE": return "border-red-300 bg-red-50 text-red-900";
    case "EN_CONFLIT": return "border-amber-300 bg-amber-50 text-amber-900";
    case "IGNOREE": return "border-slate-300 bg-slate-100 text-slate-800";
    default: return "border-sky-300 bg-sky-50 text-sky-900";
  }
}

/**
 * Tableau des compteurs du contrôle (lues, conformes, rejetées, ignorées, en conflit).
 *
 * Les `importees` ne sont pas une colonne : elles ne sont pas un résultat du contrôle. Si le serveur en
 * déclare pourtant (non nul), une note neutre le dit, au lieu de le taire.
 */
export function CompteursLot({ compteurs }: { compteurs: ControleLot["compteurs"] }) {
  const colonnes: [string, number][] = [
    ["Lues", compteurs.lues],
    ["Conformes", compteurs.validees],
    ["Rejetées", compteurs.rejetees],
    ["Ignorées", compteurs.ignorees],
    ["En conflit", compteurs.enConflit],
  ];
  return (
    <div>
      <div className="relative overflow-x-auto">
        <table className="w-full min-w-[18rem] border-collapse text-center text-sm">
          <caption className="mb-1 text-left text-xs text-slate-700">
            Compteurs du contrôle du schéma, calculés par le serveur
          </caption>
          <thead>
            <tr className="border-b border-slate-300 text-slate-700">
              {colonnes.map(([titre]) => <th key={titre} scope="col" className="px-2 py-1 text-xs font-medium">{titre}</th>)}
            </tr>
          </thead>
          <tbody>
            <tr className="font-semibold text-slate-900">
              {colonnes.map(([titre, valeur]) => (
                <td key={titre} className={`px-2 py-1 ${titre === "Rejetées" && valeur > 0 ? "text-red-800" : ""}`}>{nombre(valeur)}</td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      {typeof compteurs.importees === "number" && compteurs.importees > 0 && (
        <p className="mt-1 text-xs text-slate-700">
          Le serveur déclare {nombre(compteurs.importees)} ligne(s) écrite(s) au référentiel pour ce lot. Cette valeur n'est pas un résultat du contrôle.
        </p>
      )}
    </div>
  );
}
