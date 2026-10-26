import { useId, useState } from "react";
import { formaterDate, libelleDate } from "../../lib/teledetectionCarte";
import type { ComparaisonProps, CoteComparaison } from "./types";

/**
 * Comparaison « avant / après » à curseur de deux vignettes satellite.
 *
 * CE QUE CE COMPOSANT S'INTERDIT
 *
 * - Montrer une image qui n'existe pas. Une vignette absente (`url: null`) ou impossible à charger est REMPLACÉE PAR
 *   UN MESSAGE qui le dit (« Image avant non disponible »), jamais par une image de substitution, un dégradé ou
 *   l'autre image dupliquée : un agent déciderait sur une preuve qui n'en est pas une (contrat §1, règle 7).
 * - Laisser croire à une comparaison quand il n'y en a pas : si une des deux images manque, le curseur est désactivé
 *   et les deux volets sont montrés côte à côte, l'image disponible restant visible.
 * - Dire ce que l'image montre. Le texte alternatif nomme la vignette et sa date, pas le changement détecté : la
 *   vignette est une aide au jugement, pas le verdict. À 10 m de résolution native (Sentinel-2), elle ne montre ni
 *   nid-de-poule ni fissure fine.
 *
 * CLAVIER : le curseur est un `<input type="range">` natif (flèches, Début, Fin, Page précédente/suivante), donc
 * focalisable et annoncé par les lecteurs d'écran, avec une valeur lisible (`aria-valuetext`).
 */

type Cote = "avant" | "apres";

const NOM: Record<Cote, string> = { avant: "avant", apres: "après" };
const MAJ: Record<Cote, string> = { avant: "Avant", apres: "Après" };

export function ComparaisonAvantApres({ avant, apres, libelleZone }: ComparaisonProps) {
  const id = useId();
  // Position du curseur : part (en %) de la largeur montrant l'image « avant », comptée depuis la gauche.
  const [position, setPosition] = useState(50);
  // On retient l'URL qui a échoué ou chargé, pas un booléen : quand l'URL change, l'état ancien ne s'applique plus.
  const [echecs, setEchecs] = useState<Record<Cote, string | null>>({ avant: null, apres: null });
  const [chargees, setChargees] = useState<Record<Cote, string | null>>({ avant: null, apres: null });

  const sources: Record<Cote, CoteComparaison> = { avant, apres };
  const etat = (c: Cote): "absente" | "indisponible" | "echec" | "ok" => {
    const { url, panne } = sources[c];
    // Pas d'URL mais une panne connue : le cote est dit en panne (et non « non disponible »), l'autre image reste montree.
    if (!url) return panne === "indisponible" ? "indisponible" : panne === "echec" ? "echec" : "absente";
    return echecs[c] === url ? "echec" : "ok";
  };
  const etats = { avant: etat("avant"), apres: etat("apres") };
  const comparable = etats.avant === "ok" && etats.apres === "ok";
  const enChargement = comparable && (chargees.avant !== avant.url || chargees.apres !== apres.url);

  const raisonBlocage = (() => {
    const manquantes = (["avant", "apres"] as const).filter((c) => etats[c] !== "ok");
    if (manquantes.length === 0) return null;
    const noms = manquantes.map((c) => NOM[c]).join(" et ");
    const absente = manquantes.some((c) => etats[c] === "absente");
    const sujet = manquantes.length > 1 ? `les images ${noms}` : `l'image ${noms}`;
    // Un cote « indisponible » (404 APERCU_INDISPONIBLE) le dit ; seul, il ne devient pas « n'a pas pu etre chargee ».
    const tousIndisponibles = manquantes.every((c) => etats[c] === "indisponible");
    if (tousIndisponibles) return `Comparaison impossible : ${sujet} ${manquantes.length > 1 ? "sont indisponibles" : "est indisponible"} chez le fournisseur.`;
    const verbe = manquantes.length > 1 ? (absente ? "ne sont pas disponibles" : "n'ont pas pu être chargées") : absente ? "n'est pas disponible" : "n'a pas pu être chargée";
    return `Comparaison impossible : ${sujet} ${verbe}.`;
  })();

  const zone = libelleZone ? `${libelleZone} : ` : "";
  const alt = (c: Cote) => `${zone}vignette satellite ${NOM[c]}, ${formaterDate(sources[c].date) ? `acquise le ${formaterDate(sources[c].date)}` : "date d'acquisition inconnue"}`;

  const image = (c: Cote, classe: string) => (
    <img
      src={sources[c].url ?? undefined}
      alt={alt(c)}
      className={classe}
      draggable={false}
      onLoad={() => setChargees((p) => ({ ...p, [c]: sources[c].url }))}
      onError={() => setEchecs((p) => ({ ...p, [c]: sources[c].url }))}
    />
  );

  /** Ce qui tient la place d'une image qu'on ne peut pas montrer. Toujours un texte, jamais une image. */
  const substitut = (c: Cote) =>
    etats[c] === "indisponible" ? (
      <p role="status" className="px-3 text-center text-sm font-medium text-gray-700">Image {NOM[c]} indisponible chez le fournisseur</p>
    ) : etats[c] === "echec" ? (
      <p role="alert" className="px-3 text-center text-sm font-medium text-red-700">
        Image {NOM[c]} impossible à charger
      </p>
    ) : (
      <p className="px-3 text-center text-sm font-medium text-gray-700">Image {NOM[c]} non disponible</p>
    );

  const valeurTexte = `Image avant visible sur ${position} % de la largeur, image après sur ${100 - position} %`;

  return (
    <figure
      className="space-y-2"
      aria-label={libelleZone ? `Comparaison avant et après : ${libelleZone}` : "Comparaison avant et après"}
    >
      {comparable ? (
        <div className="relative aspect-[4/3] w-full select-none overflow-hidden rounded-lg border border-gray-200 bg-gray-100">
          {image("apres", "absolute inset-0 h-full w-full object-cover")}
          <div className="absolute inset-0" style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}>
            {image("avant", "h-full w-full object-cover")}
          </div>
          <div className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white shadow" style={{ left: `${position}%` }} aria-hidden="true" />
          <span className="pointer-events-none absolute left-2 top-2 rounded bg-black/75 px-2 py-0.5 text-xs font-semibold text-white">
            {libelleDate("Avant", avant.date)}
          </span>
          <span className="pointer-events-none absolute right-2 top-2 rounded bg-black/75 px-2 py-0.5 text-xs font-semibold text-white">
            {libelleDate("Après", apres.date)}
          </span>
          {enChargement && (
            <p role="status" className="absolute inset-x-0 bottom-2 mx-auto w-fit rounded bg-white/90 px-2 py-1 text-xs font-medium text-gray-800">
              Chargement des images…
            </p>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {(["avant", "apres"] as const).map((c) => (
            <div key={c} className="relative aspect-[4/3] overflow-hidden rounded-lg border border-gray-200 bg-gray-100">
              {etats[c] === "ok" ? image(c, "h-full w-full object-cover") : (
                <div className="flex h-full w-full items-center justify-center border-2 border-dashed border-gray-300 bg-white">{substitut(c)}</div>
              )}
              <span className="pointer-events-none absolute left-2 top-2 rounded bg-black/75 px-2 py-0.5 text-xs font-semibold text-white">
                {libelleDate(MAJ[c], sources[c].date)}
              </span>
            </div>
          ))}
        </div>
      )}

      <div>
        <label htmlFor={`${id}-curseur`} className="block text-xs font-medium text-gray-700">
          Curseur de comparaison (avant à gauche, après à droite)
        </label>
        <input
          id={`${id}-curseur`}
          type="range"
          min={0}
          max={100}
          step={1}
          value={position}
          disabled={!comparable}
          onChange={(e) => setPosition(Number(e.target.value))}
          aria-valuetext={comparable ? valeurTexte : "Curseur désactivé"}
          aria-describedby={raisonBlocage ? `${id}-raison` : undefined}
          className="h-11 w-full cursor-pointer accent-navy disabled:cursor-not-allowed disabled:opacity-50"
        />
        {raisonBlocage && <p id={`${id}-raison`} className="text-xs text-gray-700">{raisonBlocage}</p>}
      </div>

      <figcaption className="grid grid-cols-2 gap-2 text-xs text-gray-700">
        {(["avant", "apres"] as const).map((c) => {
          const date = formaterDate(sources[c].date);
          return (
            <p key={c}>
              <span className="font-semibold">{MAJ[c]}</span>{" : "}
              {date ? <time dateTime={sources[c].date!.trim().slice(0, 10)}>{date}</time> : "date inconnue"}
            </p>
          );
        })}
      </figcaption>
    </figure>
  );
}
