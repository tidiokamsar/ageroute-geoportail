import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, Download, Upload } from "lucide-react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { Button } from "../components/ui/Button";
import { CarteReleve } from "../components/CarteReleve";
import { messageErreur } from "../lib/exploitation";
import {
  detecterFormat, libelleDuree, libelleKm, libellePourcent, lireTexte, nomFichierResultat, TAILLE_MAX_OCTETS,
  type AnalyseTrace, type FormatTrace,
} from "../lib/releve";

/**
 * Releve en vehicule (paragraphe 7.13) : analyse d'une trace GPS enregistree par un telephone.
 *
 * CE QUE CET ECRAN FAIT, ET CE QU'IL NE FAIT PAS
 *
 * Il lit un fichier GPX ou CSV, le rattache au reseau et montre le resultat. Il N'ENREGISTRE RIEN :
 * ni portion, ni troncon, ni observation. Les passages et les suites hors referentiel sont des
 * propositions que l'agent complete ensuite par les ecrans de saisie.
 *
 * L'enregistrement continu en roulage (service Android, capteurs, photos cadencees) n'existe pas
 * encore : l'ecran le dit en tete, pour que personne n'attende de lui ce qu'il ne fait pas.
 */

const ETAPES: { titre: string; texte: React.ReactNode }[] = [
  {
    titre: "Préparer la sortie",
    texte: (
      <>Si la sortie est une patrouille, ouvrir ou créer sa mission dans <Link className="underline" to="/exploitation/patrouilles">Patrouilles</Link>. Sinon, noter la date, le véhicule et l'itinéraire prévu.</>
    ),
  },
  {
    titre: "Enregistrer la trace pendant le trajet",
    texte: "Fixer le téléphone, activer le GPS en haute précision et lancer, avant de démarrer, une application d'enregistrement de trace qui exporte du GPX ou du CSV. Un point par seconde convient. Le conducteur ne manipule pas le téléphone en roulant : un passager s'en charge, ou l'enregistrement est lancé avant le départ. Désactiver l'économie d'énergie de l'application, sinon le téléphone interrompt l'enregistrement écran éteint.",
  },
  {
    titre: "Récupérer le fichier",
    texte: "À l'arrivée, arrêter l'enregistrement et exporter le fichier en GPX (ou CSV avec les colonnes latitude et longitude, plus l'heure si possible). Le copier sur l'ordinateur ou l'ouvrir depuis ce téléphone.",
  },
  {
    titre: "Analyser ici",
    texte: "Choisir le fichier ci-dessous et lancer l'analyse. Le résultat montre les tronçons parcourus, les parties de trajet que le réseau n'explique pas, et des indicateurs de qualité.",
  },
  {
    titre: "Compléter et valider",
    texte: (
      <>Pour consigner un défaut, utiliser <Link className="underline" to="/inspections/terrain/defauts">Défauts terrain</Link> ; pour qualifier une portion, <Link className="underline" to="/inspections/terrain/portions">Portions terrain</Link>. Une suite hors référentiel est une route absente de la base : à signaler au gestionnaire du référentiel.</>
    ),
  },
];

function Indicateur({ libelle, valeur, note }: { libelle: string; valeur: string; note?: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3">
      <dt className="text-xs text-gray-600">{libelle}</dt>
      <dd className="mt-0.5">
        <span className="block text-lg font-semibold">{valeur}</span>
        {note && <span className="mt-0.5 block text-xs text-gray-600">{note}</span>}
      </dd>
    </div>
  );
}

function telecharger(analyse: AnalyseTrace) {
  const blob = new Blob([JSON.stringify(analyse, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nomFichierResultat();
  a.click();
  URL.revokeObjectURL(url);
}

export function ReleveVehiculePage() {
  const champFichier = useRef<HTMLInputElement>(null);
  const [fichier, setFichier] = useState<File | null>(null);
  const [format, setFormat] = useState<"" | FormatTrace>("");
  const [reseau, setReseau] = useState<"reference" | "tout">("reference");
  const [distanceMax, setDistanceMax] = useState("50");
  const [pasMin, setPasMin] = useState("15");
  const [tolerance, setTolerance] = useState("");
  const [erreurLocale, setErreurLocale] = useState<string | null>(null);

  const analyser = useMutation({
    mutationFn: async (): Promise<AnalyseTrace> => {
      const fmt = format || (fichier ? detecterFormat(fichier.name) : null);
      if (!fichier || !fmt) throw new Error("local");
      const contenu = await lireTexte(fichier);
      return (await api.post("/v2/geo/trace", {
        format: fmt,
        contenu,
        reseau,
        distanceMaxM: Number(distanceMax),
        pasMinM: Number(pasMin),
        // Vide : pas de verification sur le reseau, et AUCUNE valeur n'est envoyee a la place.
        ...(tolerance.trim() !== "" ? { toleranceFusionM: Number(tolerance.replace(",", ".")) } : {}),
      })).data;
    },
    onError: (e) => { if ((e as Error).message !== "local") toast.error(messageErreur(e, "L'analyse a échoué.")); },
  });

  const lancer = () => {
    setErreurLocale(null);
    if (!fichier) return setErreurLocale("Choisir d'abord un fichier de trace.");
    if (fichier.size > TAILLE_MAX_OCTETS) return setErreurLocale(`Le fichier dépasse ${Math.round(TAILLE_MAX_OCTETS / 1_000_000)} Mo : le découper en plusieurs trajets.`);
    if (!format && !detecterFormat(fichier.name)) return setErreurLocale("Format non reconnu : choisir GPX ou CSV dans la liste.");
    const d = Number(distanceMax), p = Number(pasMin);
    if (!Number.isFinite(d) || d < 1 || d > 200) return setErreurLocale("La distance maximale doit être comprise entre 1 et 200 m.");
    if (!Number.isFinite(p) || p < 5 || p > 500) return setErreurLocale("Le pas minimal doit être compris entre 5 et 500 m.");
    if (tolerance.trim() !== "") {
      const t = Number(tolerance.replace(",", "."));
      if (!Number.isFinite(t) || t <= 0 || t > 50) return setErreurLocale("La tolérance de fusion doit être comprise entre 0 (exclu) et 50 m, ou laissée vide.");
    }
    analyser.mutate();
  };

  const a = analyser.data;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Relevé en véhicule</h1>
        <p className="mt-1 max-w-3xl text-sm text-gray-700">
          Cet écran analyse une trace GPS enregistrée par un téléphone pendant un trajet et la rattache au réseau routier.
        </p>
      </header>

      <section aria-labelledby="etat" className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
        <h2 id="etat" className="flex items-center gap-2 font-semibold"><AlertTriangle className="h-4 w-4" aria-hidden="true" />État de la fonction</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>Disponible : l'analyse d'un fichier GPX ou CSV déjà enregistré.</li>
          <li>Pas encore disponible : l'enregistrement continu en roulage depuis une application AGEROUTE (position en arrière-plan, capteurs, photos tous les 20 à 50 m). Il demande une application Android native, qui n'est pas encore développée.</li>
          <li>Cet écran n'enregistre rien dans la base : il montre une analyse. Il ne mesure ni l'IRI ni l'état de la chaussée, qu'un fichier de position ne contient pas.</li>
        </ul>
      </section>

      <section aria-labelledby="guide">
        <h2 id="guide" className="text-lg font-semibold">Comment faire un relevé</h2>
        <ol className="mt-2 max-w-3xl list-decimal space-y-2 pl-5 text-sm">
          {ETAPES.map((e) => (
            <li key={e.titre}><strong>{e.titre}.</strong> {e.texte}</li>
          ))}
        </ol>
      </section>

      <form
        aria-labelledby="analyse-titre"
        className="space-y-3 rounded-lg border border-gray-200 bg-white p-4"
        onSubmit={(ev) => { ev.preventDefault(); lancer(); }}
      >
        <h2 id="analyse-titre" className="font-semibold">Analyser une trace</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block text-sm md:col-span-2">Fichier de trace (GPX ou CSV)
            <input
              ref={champFichier}
              type="file"
              accept=".gpx,.csv,.txt"
              className="mt-1 block w-full text-sm"
              onChange={(e) => { setFichier(e.target.files?.[0] ?? null); setErreurLocale(null); analyser.reset(); }}
            />
          </label>
          <label className="block text-sm">Format
            <select className="mt-1 w-full rounded border px-2 py-1" value={format} onChange={(e) => setFormat(e.target.value as "" | FormatTrace)}>
              <option value="">Détecter d'après l'extension</option>
              <option value="gpx">GPX</option>
              <option value="csv">CSV</option>
            </select>
          </label>
          <label className="block text-sm">Réseau de référence
            <select className="mt-1 w-full rounded border px-2 py-1" value={reseau} onChange={(e) => setReseau(e.target.value as "reference" | "tout")}>
              <option value="reference">Réseau classé (recommandé)</option>
              <option value="tout">Tout le référentiel (plus lent, plus ambigu)</option>
            </select>
          </label>
        </div>
        <details className="text-sm">
          <summary className="cursor-pointer">Réglages</summary>
          <div className="mt-2 grid gap-3 md:grid-cols-2">
            <label className="block">Distance maximale au tronçon (m, 1 à 200)
              <input className="mt-1 w-full rounded border px-2 py-1" inputMode="numeric" value={distanceMax} onChange={(e) => setDistanceMax(e.target.value)} />
            </label>
            <label className="block">Pas minimal entre deux points (m, 5 à 500)
              <input className="mt-1 w-full rounded border px-2 py-1" inputMode="numeric" value={pasMin} onChange={(e) => setPasMin(e.target.value)} />
            </label>
            <label className="block md:col-span-2">Vérifier les changements de tronçon sur le réseau : tolérance de fusion des extrémités (m, facultatif)
              <input
                className="mt-1 w-full rounded border px-2 py-1" inputMode="decimal" value={tolerance}
                placeholder="vide : pas de vérification" onChange={(e) => setTolerance(e.target.value)}
              />
              <span className="mt-0.5 block text-xs text-gray-600">
                Distance en dessous de laquelle deux extrémités de tronçons sont tenues pour le même carrefour. Aucune valeur
                n'est proposée : elle dépend de la qualité de saisie du référentiel et n'a pas été mesurée. Laissée vide, les
                changements de tronçon sont comptés « non vérifiés ».
              </span>
            </label>
          </div>
          <p className="mt-1 text-xs text-gray-600">Ces valeurs sont des choix provisoires, non calibrés sur des traces réelles d'AGEROUTE.</p>
        </details>
        {erreurLocale && <p role="alert" className="text-sm text-red-700">{erreurLocale}</p>}
        <Button type="submit" disabled={analyser.isPending}>
          <Upload aria-hidden="true" />{analyser.isPending ? "Analyse en cours..." : "Analyser la trace"}
        </Button>
      </form>

      {a && (
        <section aria-labelledby="resultat" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="resultat" className="text-lg font-semibold">Résultat de l'analyse</h2>
            <Button type="button" variant="outline" size="sm" onClick={() => telecharger(a)}>
              <Download aria-hidden="true" />Télécharger le résultat (JSON)
            </Button>
          </div>

          {a.avertissements.length > 0 && (
            <div role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
              <p className="font-semibold">À lire avant de se fier au résultat</p>
              <ul className="mt-1 list-disc space-y-1 pl-5">{a.avertissements.map((m) => <li key={m}>{m}</li>)}</ul>
            </div>
          )}

          <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Indicateur libelle="Points rattachés au réseau" valeur={libellePourcent(a.indicateurs.tauxRattachement)} note={`${a.indicateurs.pointsRattaches} sur ${a.indicateurs.pointsRetenus} points retenus`} />
            <Indicateur libelle="Distance parcourue" valeur={libelleKm(a.indicateurs.distanceParcourueM)} />
            <Indicateur libelle="Durée" valeur={libelleDuree(a.indicateurs.dureeS)} note={a.indicateurs.vitesseMoyenneKmH !== null ? `vitesse moyenne ${String(a.indicateurs.vitesseMoyenneKmH).replace(".", ",")} km/h` : undefined} />
            <Indicateur libelle="Longueur sur le réseau" valeur={libelleKm(a.indicateurs.longueurSurReseauM)} />
            <Indicateur libelle="Changements de tronçon non vérifiés" valeur={String(a.indicateurs.transitionsNonVerifiees)} note={a.parametres.graphe ? `graphe : ${a.parametres.graphe.nbTroncons} tronçons, tolérance ${String(a.parametres.graphe.toleranceFusionM).replace(".", ",")} m` : "graphe non utilisé : à lire avec le taux de rattachement"} />
            <Indicateur libelle="Points lus / retenus" valeur={`${a.indicateurs.pointsLus} / ${a.indicateurs.pointsRetenus}`} note={`${a.indicateurs.retiresParPas} retirés par le pas, ${a.indicateurs.pointsIgnores} ignorés`} />
          </dl>

          <CarteReleve analyse={a} />

          <div>
            <h3 className="font-semibold">Tronçons parcourus</h3>
            {a.passages.length === 0 ? (
              <p className="mt-1 text-sm text-gray-700">Aucun tronçon du réseau choisi n'explique cette trace.</p>
            ) : (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">Tronçons parcourus, dans l'ordre du trajet</caption>
                  <thead><tr className="border-b text-xs text-gray-600">
                    <th scope="col" className="py-1 pr-3">Tronçon</th><th scope="col" className="pr-3">De (m)</th><th scope="col" className="pr-3">À (m)</th>
                    <th scope="col" className="pr-3">Longueur</th><th scope="col" className="pr-3">Sens</th><th scope="col" className="pr-3">Points</th><th scope="col">Remarque</th>
                  </tr></thead>
                  <tbody>
                    {a.passages.map((p) => (
                      <tr key={`${p.tronconId}-${p.indexDebut}`} className="border-b last:border-0">
                        <th scope="row" className="py-1 pr-3 font-medium">{p.code}{p.nom ? <span className="block text-xs font-normal text-gray-600">{p.nom}</span> : null}</th>
                        <td className="pr-3">{p.deM !== null ? Math.round(p.deM) : "-"}</td>
                        <td className="pr-3">{p.aM !== null ? Math.round(p.aM) : "-"}</td>
                        <td className="pr-3">{p.longueurM !== null ? libelleKm(p.longueurM) : "-"}</td>
                        <td className="pr-3">{p.sens === "CROISSANT" ? "croissant" : p.sens === "DECROISSANT" ? "décroissant" : "indéterminé"}</td>
                        <td className="pr-3">{p.nombrePoints}</td>
                        <td>{p.court ? <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900">Passage très court, à vérifier</span> : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div>
            <h3 className="font-semibold">Parties du trajet hors référentiel</h3>
            {a.horsReferentiel.length === 0 ? (
              <p className="mt-1 text-sm text-gray-700">Tout le trajet est expliqué par le réseau choisi.</p>
            ) : (
              <>
                <p className="mt-1 text-sm text-gray-700">Aucun tronçon du réseau choisi n'explique ces parties : route absente de la base, piste non cartographiée, ou mauvais signal GPS. Rien n'a été créé.</p>
                <ul className="mt-2 space-y-1 text-sm">
                  {a.horsReferentiel.map((s) => (
                    <li key={s.indexDebut} className="rounded border border-red-200 bg-red-50 px-3 py-2">
                      {libelleKm(s.longueurM)}, {s.nombrePoints} points, du point {s.indexDebut + 1} au point {s.indexFin + 1}
                      {s.coordonnees[0] ? ` (départ vers ${s.coordonnees[0][1].toFixed(5)} N, ${s.coordonnees[0][0].toFixed(5)} E)` : ""}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
