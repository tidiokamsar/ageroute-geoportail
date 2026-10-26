import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "../ui/Button";
import { Select } from "../ui/Input";
import { LIBELLE_STATUT_LIGNE, classePastilleLigne, nombre, rendreVisible } from "./CompteursLot";
import type { ActionPermise, LigneApercu, ReponseApercu } from "./types";

/**
 * Aperçu des lignes d'un lot : un tableau BORNÉ, en lecture seule.
 *
 * CE QUE C'EST, ET CE QUE CE N'EST PAS
 *
 * Ce sont les premières lignes du lot telles que le serveur les a lues, pour que l'agent voie la forme des
 * données. Ce n'est PAS un échantillon approuvé : aucune approbation n'existe, et l'aperçu ne l'implique pas.
 *
 * LES VALEURS SONT DU TEXTE, JAMAIS DU HTML
 *
 * Chaque valeur vient d'un fichier d'un tiers. Elle est rendue comme nœud texte React (aucun
 * `dangerouslySetInnerHTML`, aucune interprétation : `<script>` s'affiche tel quel) et ses caractères de
 * contrôle sont rendus visibles (`rendreVisible`). Le serveur tronque à 200 caractères : `tronque` le dit.
 *
 * BORNES : 20 lignes par page (le serveur en admet 50), 200 lignes au plus en mémoire d'affichage, et un
 * défilement horizontal confiné au conteneur du tableau, jamais à la page.
 */

export type FiltreLigne = "VALIDEE" | "REJETEE" | "IGNOREE" | "EN_CONFLIT";

/** Paramètres de `GET /v2/imports/:id/apercu` (limite 1 à 50, `apres` = numéro de ligne). */
export interface ParamsApercu {
  limite?: number;
  statut?: FiltreLigne;
  apres?: number;
}

const LIMITE_PAGE = 20;
export const MAX_LIGNES_AFFICHEES = 200;

const OPTIONS_FILTRE: { valeur: FiltreLigne | ""; libelle: string }[] = [
  { valeur: "", libelle: "Toutes les lignes" },
  { valeur: "VALIDEE", libelle: "Conformes" },
  { valeur: "REJETEE", libelle: "Rejetées" },
  { valeur: "IGNOREE", libelle: "Ignorées" },
  { valeur: "EN_CONFLIT", libelle: "En conflit" },
];

export interface ApercuEchantillonProps {
  /** Identifiant du lot : un autre lot repart de zéro (filtre, lignes, erreurs). */
  lotId: string;
  chargerApercu: (params: ParamsApercu) => Promise<ReponseApercu>;
  /** Action `VOIR_APERCU` du serveur. Absente : l'aperçu est proposé. `permise: false` : la raison du serveur est affichée. */
  action?: Pick<ActionPermise, "permise" | "raison"> | null;
}

type Etat = "chargement" | "pret" | "erreur";
type EtatPlus = "repos" | "chargement" | "erreur";

function Valeur({ valeur, absente }: { valeur: string | null | undefined; absente: string }) {
  if (valeur === null || valeur === undefined) return <span className="italic text-slate-700">{absente}</span>;
  if (valeur === "") return <span className="italic text-slate-700">(vide)</span>;
  return <>{rendreVisible(valeur)}</>;
}

export function ApercuEchantillon({ lotId, chargerApercu, action }: ApercuEchantillonProps) {
  const id = useId();
  const permise = action?.permise !== false;
  const [filtre, setFiltre] = useState<FiltreLigne | "">("");
  const [etat, setEtat] = useState<Etat>("chargement");
  const [plus, setPlus] = useState<EtatPlus>("repos");
  const [lignes, setLignes] = useState<LigneApercu[]>([]);
  const [suivant, setSuivant] = useState<number | null>(null);
  const [tronque, setTronque] = useState(false);
  const [essai, setEssai] = useState(0);

  // `chargerApercu` est souvent une fonction recréée à chaque rendu du parent : elle ne doit pas relancer
  // le chargement. Seuls le lot, le filtre et « Réessayer » le font.
  const charger = useRef(chargerApercu);
  charger.current = chargerApercu;
  // Numéro de génération : une réponse qui arrive après un changement de lot ou de filtre est jetée.
  const generation = useRef(0);

  // Un autre lot repart de zéro, filtre compris : le filtre d'un lot ne doit pas rester sur le suivant.
  // Ajustement pendant le rendu (et non dans un effet) : un effet lancerait d'abord une requête avec
  // l'ancien filtre sur le nouveau lot, aussitôt jetée.
  const [lotAffiche, setLotAffiche] = useState(lotId);
  if (lotAffiche !== lotId) { setLotAffiche(lotId); setFiltre(""); }

  useEffect(() => {
    const g = ++generation.current;
    setLignes([]); setSuivant(null); setTronque(false); setPlus("repos");
    if (!permise) return;
    setEtat("chargement");
    (async () => {
      try {
        const r = await charger.current({ limite: LIMITE_PAGE, ...(filtre ? { statut: filtre } : {}) });
        if (g !== generation.current) return;
        setLignes(r.lignes); setSuivant(r.suivant); setTronque(Boolean(r.tronque)); setEtat("pret");
      } catch {
        if (g !== generation.current) return;
        setEtat("erreur");
      }
    })();
    return () => { generation.current += 1; };
  }, [lotId, filtre, essai, permise]);

  async function chargerPlus() {
    if (suivant === null) return;
    const g = generation.current;
    setPlus("chargement");
    try {
      const r = await charger.current({ limite: LIMITE_PAGE, ...(filtre ? { statut: filtre } : {}), apres: suivant });
      if (g !== generation.current) return;
      setLignes((avant) => [...avant, ...r.lignes]);
      setSuivant(r.suivant);
      setTronque((avant) => avant || Boolean(r.tronque));
      setPlus("repos");
    } catch {
      if (g !== generation.current) return;
      setPlus("erreur");
    }
  }

  // Colonnes de la charge : union dans l'ordre d'apparition. Le serveur plafonne leur nombre.
  const colonnes = useMemo(() => {
    const vues: string[] = [];
    const deja = new Set<string>();
    for (const l of lignes) for (const k of Object.keys(l.charge ?? {})) if (!deja.has(k)) { deja.add(k); vues.push(k); }
    return vues;
  }, [lignes]);
  const avecMotif = lignes.some((l) => l.motifRejet);
  const limiteAtteinte = lignes.length >= MAX_LIGNES_AFFICHEES;
  const peutPlus = suivant !== null && !limiteAtteinte;

  return (
    <div>
      <h3 id={`${id}-titre`} className="mb-1 text-sm font-semibold text-slate-900">Aperçu des lignes du lot</h3>
      <p className="text-sm text-slate-700">
        Lecture seule. Cet aperçu montre les lignes telles que le serveur les a lues : il ne vaut pas approbation d'un échantillon.
      </p>
      <p className="mt-1 text-xs text-slate-700">
        Toutes les valeurs sont affichées comme du texte brut, sans être interprétées. Les caractères de contrôle sont rendus visibles (par exemple ␊ pour un saut de ligne).
      </p>

      {!permise ? (
        <p className="mt-3 rounded border border-slate-300 bg-slate-50 p-3 text-sm text-slate-800">
          L'aperçu n'est pas disponible pour ce lot.{" "}
          {action?.raison ? rendreVisible(action.raison) : "Le serveur n'a pas donné de raison."}
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          <div className="max-w-xs">
            <label htmlFor={`${id}-filtre`} className="mb-1 block text-sm font-medium text-slate-800">Filtrer par statut de ligne</label>
            <Select
              id={`${id}-filtre`}
              className="min-h-[44px]"
              value={filtre}
              onChange={(e) => setFiltre(e.target.value as FiltreLigne | "")}
            >
              {OPTIONS_FILTRE.map((o) => <option key={o.valeur} value={o.valeur}>{o.libelle}</option>)}
            </Select>
          </div>

          {etat === "chargement" && (
            <div role="status" aria-live="polite">
              <span className="sr-only">Chargement de l'aperçu…</span>
              <div aria-hidden="true" className="space-y-2">
                {[0, 1, 2].map((i) => <div key={i} className="h-8 animate-pulse rounded bg-slate-200" />)}
              </div>
            </div>
          )}

          {etat === "erreur" && (
            <div role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900">
              <p className="font-medium">L'aperçu n'a pas pu être chargé.</p>
              <p>Aucune donnée n'a été modifiée.</p>
              <Button type="button" variant="outline" className="mt-2 min-h-[44px]" onClick={() => setEssai((n) => n + 1)}>Réessayer</Button>
            </div>
          )}

          {etat === "pret" && lignes.length === 0 && (
            <p className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-800">
              {filtre ? "Aucune ligne ne correspond à ce statut." : "Ce lot ne contient aucune ligne à afficher."}
            </p>
          )}

          {etat === "pret" && lignes.length > 0 && (
            <>
              {tronque && (
                <p role="note" className="rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
                  <strong>Valeurs tronquées :</strong> l'aperçu n'est pas le contenu complet.
                </p>
              )}
              {/* Le défilement horizontal reste DANS ce conteneur ; il est focalisable pour le clavier (WCAG 2.1.1). */}
              {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
              <div role="region" aria-label="Lignes de l'aperçu" tabIndex={0} className="relative max-h-96 max-w-full overflow-auto rounded border border-slate-200">
                <table className="w-full min-w-max border-collapse text-left text-xs">
                  <caption className="sr-only">Aperçu des lignes du lot, en lecture seule</caption>
                  <thead className="sticky top-0 bg-slate-100 text-slate-800">
                    <tr>
                      <th scope="col" className="px-2 py-1.5 font-semibold">Statut</th>
                      <th scope="col" className="px-2 py-1.5 font-semibold">Ligne</th>
                      <th scope="col" className="px-2 py-1.5 font-semibold">Identifiant source</th>
                      {avecMotif && <th scope="col" className="px-2 py-1.5 font-semibold">Motif</th>}
                      {colonnes.map((c) => <th key={c} scope="col" className="px-2 py-1.5 font-mono font-semibold">{rendreVisible(c)}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {lignes.map((l, i) => (
                      <tr key={`${l.numeroLigne}-${i}`} className="border-t border-slate-100 align-top">
                        <td className="px-2 py-1">
                          <span className={`inline-block whitespace-nowrap rounded border px-1.5 py-0.5 font-medium ${classePastilleLigne(l.statut)}`}>
                            {LIBELLE_STATUT_LIGNE[l.statut] ?? rendreVisible(l.statut)}
                          </span>
                        </td>
                        <th scope="row" className="px-2 py-1 font-mono font-normal">{l.numeroLigne}</th>
                        <td className="max-w-[14rem] break-words px-2 py-1 font-mono"><Valeur valeur={l.identifiantSource} absente="(absent)" /></td>
                        {avecMotif && <td className="max-w-[16rem] break-words px-2 py-1"><Valeur valeur={l.motifRejet} absente="" /></td>}
                        {colonnes.map((c) => (
                          <td key={c} className="max-w-[14rem] break-words px-2 py-1 font-mono">
                            <Valeur valeur={l.charge?.[c]} absente="(absente)" />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <p role="status" aria-live="polite" className="text-sm text-slate-700">
                {nombre(lignes.length)} {lignes.length > 1 ? "lignes affichées" : "ligne affichée"}
                {peutPlus ? ", d'autres lignes sont disponibles." : "."}
                {limiteAtteinte && suivant !== null && ` Limite d'affichage atteinte (${nombre(MAX_LIGNES_AFFICHEES)} lignes) : affinez avec le filtre de statut pour voir d'autres lignes.`}
              </p>

              {plus === "erreur" && (
                <p role="alert" className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-900">
                  Les lignes suivantes n'ont pas pu être chargées. Les lignes déjà affichées restent valables.
                </p>
              )}

              {peutPlus && (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-[44px]"
                  disabled={plus === "chargement"}
                  aria-busy={plus === "chargement"}
                  onClick={() => { void chargerPlus(); }}
                >
                  {plus === "chargement" ? "Chargement…" : plus === "erreur" ? "Réessayer de charger plus" : "Charger plus"}
                </Button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
