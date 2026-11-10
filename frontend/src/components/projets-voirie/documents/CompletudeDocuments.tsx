import { useState } from "react";
import { Check, ListChecks, X } from "lucide-react";
import { Button } from "../../ui/Button";
import { EtatChargement, EtatErreur } from "../EtatsPv";
import { BadgeEtatFonction, BadgeStatutDocument } from "./commun";
import { useCompletude } from "../../../lib/projetsVoirieDocumentsHooks";
import { formaterDate, formaterNombre } from "../../../lib/projetsVoirie";
import {
  LIBELLE_STATUT_DOCUMENT, MENTION_INDEPENDANCE, PIECES_AFFICHEES, STATUTS_DOCUMENT, classerErreurDocuments, libelleFonction,
  type PieceManquante,
} from "../../../lib/projetsVoirieDocuments";

/**
 * Encadre « Ce que les documents disponibles permettent » (GET /:id/completude). Pour chaque fonction : son etat (disponible, indisponible, non livree)
 * et SES conditions ; puis les pieces manquantes, chacune avec la ou les fonctions qu'elle debloquerait. Une piece manquante n'est JAMAIS presentee comme
 * bloquant une fonction qui n'en depend pas : la phrase d'independance est dite, et une piece sans fonction bloquee le dit en clair.
 */
export function CompletudeDocuments({ projetId, actif }: { projetId: string; actif: boolean }) {
  const q = useCompletude(projetId, actif);
  const [toutes, setToutes] = useState(false);

  return (
    <section aria-labelledby="pv-titre-completude" className="space-y-3 rounded-md border border-gray-300 bg-gray-50 p-3">
      <h3 id="pv-titre-completude" className="flex items-center gap-1 text-sm font-semibold text-navy"><ListChecks aria-hidden="true" className="h-4 w-4" />Ce que les documents disponibles permettent</h3>
      <p className="text-xs text-gray-700">{MENTION_INDEPENDANCE} Seuls les jeux de données autorisés comptent.</p>
      {q.isPending && <EtatChargement libelle="Calcul de ce que les documents permettent…" />}
      {q.isError && <EtatErreur erreur={classerErreurDocuments(q.error)} sujet="Complétude du dossier" onReessayer={() => void q.refetch()} enCours={q.isFetching} />}
      {q.isSuccess && (() => {
        const c = q.data;
        const pieces = toutes ? c.piecesManquantes : c.piecesManquantes.slice(0, PIECES_AFFICHEES);
        return (
          <>
            <ul aria-label="Fonctions du module" className="space-y-2">
              {c.fonctions.map((f) => (
                <li key={f.code} data-fonction={f.code} className="rounded border border-gray-200 bg-white p-2 text-xs">
                  <p className="flex flex-wrap items-center gap-2"><span className="font-semibold text-gray-900">{f.libelle}</span><BadgeEtatFonction etat={f.etat} /></p>
                  {f.etat === "NON_LIVREE" && <p className="text-gray-700">Fonction non livrée dans cette version du module : aucune pièce ne la rend disponible.</p>}
                  {f.conditions.length === 0 && f.etat !== "NON_LIVREE" && <p className="text-gray-700">Ne dépend d&apos;aucune pièce.</p>}
                  {f.conditions.length > 0 && (
                    <ul className="mt-1 space-y-0.5">
                      {f.conditions.map((x) => (
                        <li key={x.code} className="flex items-start gap-1 text-gray-800">
                          {x.remplie ? <Check aria-hidden="true" className="mt-0.5 h-3 w-3 shrink-0 text-green-800" /> : <X aria-hidden="true" className="mt-0.5 h-3 w-3 shrink-0 text-amber-900" />}
                          <span>{x.libelle} : <strong>{x.remplie ? "remplie" : "non remplie"}</strong>{x.nb !== null && x.remplie ? ` (${formaterNombre(x.nb, 0)})` : ""}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>

            <div className="space-y-1">
              <h4 className="text-xs font-semibold text-gray-900">Pièces manquantes</h4>
              {c.piecesManquantes.length === 0 ? <p className="text-xs text-gray-700">Aucune pièce ne manque au dossier.</p> : (
                <ul aria-label="Pièces manquantes" className="space-y-1.5">
                  {pieces.map((p, i) => <ElementPiece key={`${p.nature}-${i}`} p={p} />)}
                </ul>
              )}
              {c.piecesManquantes.length > PIECES_AFFICHEES && (
                <Button type="button" size="sm" variant="outline" className="min-h-[44px] xl:min-h-8" aria-expanded={toutes} onClick={() => setToutes((t) => !t)}>
                  {toutes ? "N'afficher que les premières" : `Afficher les ${c.piecesManquantes.length - PIECES_AFFICHEES} autres pièces manquantes`}
                </Button>
              )}
              {c.piecesIgnorees > 0 && <p className="text-xs text-amber-900">{c.piecesIgnorees} pièce(s) manquante(s) de forme illisible n&apos;ont pas pu être affichées.</p>}
            </div>

            <p className="text-xs text-gray-700">
              Documents du dossier : {c.documents.total === null ? "nombre non communiqué" : formaterNombre(c.documents.total, 0)}
              {STATUTS_DOCUMENT.filter((s) => (c.documents.parStatut[s] ?? 0) > 0).map((s) => ` · ${LIBELLE_STATUT_DOCUMENT[s]} ${c.documents.parStatut[s]}`).join("")}
              {c.calculeLe ? ` (calculé le ${formaterDate(c.calculeLe)})` : ""}
            </p>
            {c.documents.tronque && (
              <p role="status" data-testid="completude-tronquee" className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
                Liste tronquée : le dossier compte plus de 5 000 documents, seuls les plus récents ont été lus pour ce calcul.
              </p>
            )}
          </>
        );
      })()}
    </section>
  );
}

const listeFonctions = (fs: readonly string[]) => fs.map((f) => libelleFonction(f)).join(", ");

function ElementPiece({ p }: { p: PieceManquante }) {
  if (p.nature === "DOCUMENT") {
    return (
      <li className="rounded border border-gray-200 bg-white p-2 text-xs text-gray-800">
        <p className="flex flex-wrap items-center gap-1"><span className="font-medium text-gray-900">Document « {p.document.titre} »</span>{p.document.statut && <BadgeStatutDocument statut={p.document.statut} />}<span>version {p.document.version ?? "?"}</span></p>
        <TexteFonctions fonctions={p.fonctions} suffiraitPour={[]} />
      </li>
    );
  }
  const titre = p.nature === "CONDITION" ? p.libelle : `Type obligatoire : ${p.typeDocument.libelle}`;
  return (
    <li className="rounded border border-gray-200 bg-white p-2 text-xs text-gray-800">
      <p className="font-medium text-gray-900">{titre}</p>
      {p.nature === "CONDITION" && p.reseau && <p>Réseau : {p.reseau.concessionnaire ?? "concessionnaire non communiqué"}{p.reseau.typeReseau ? ` · ${p.reseau.typeReseau}` : ""}</p>}
      <TexteFonctions fonctions={p.fonctions} suffiraitPour={p.suffiraitPour} />
      {p.nature === "CONDITION" && p.typesDocument.length > 0 && <p>Pièces qui la fournissent : {p.typesDocument.map((t) => t.libelle).join(", ")}.</p>}
      {p.nature === "CONDITION" && p.code === "DECISION_DEPLACEMENT" && <p>Ce n&apos;est pas une pièce à déposer : une décision de déplacement approuvée sur un dossier de conflit (onglet Conflits).</p>}
      {p.documents && p.documents.length > 0 && (
        <p>Déjà au dossier : {p.documents.map((d) => `« ${d.titre} » (${d.statut ? LIBELLE_STATUT_DOCUMENT[d.statut].toLowerCase() : "statut inconnu"})`).join(", ")}.</p>
      )}
    </li>
  );
}

function TexteFonctions({ fonctions, suffiraitPour }: { fonctions: readonly string[]; suffiraitPour: readonly string[] }) {
  if (fonctions.length === 0) return <p className="text-gray-700">Manque au dossier sans bloquer aucune fonction.</p>;
  return (
    <>
      <p>Nécessaire pour : {listeFonctions(fonctions)}.</p>
      {suffiraitPour.length > 0 && <p className="text-green-800">À elle seule, débloquerait : {listeFonctions(suffiraitPour)}.</p>}
      {suffiraitPour.length === 0 && <p className="text-gray-700">Ne suffirait pas seule : d&apos;autres conditions de ces fonctions manquent aussi.</p>}
    </>
  );
}
