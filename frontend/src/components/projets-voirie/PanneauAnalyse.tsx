/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- zone de defilement focusable au clavier (WCAG 2.1.1, regle axe scrollable-region-focusable) */
import { useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { Button } from "../ui/Button";
import type { Analyse, JeuProjet, ProjetFiche } from "../../lib/projetsVoirieApi";
import {
  LIBELLE_NB_OBJETS, LIBELLE_TRACE_FUSIONNE, STYLE_RESEAU, TYPES_RESEAU, classeIncertaine, classerErreur, libelleVerification, formaterLongueur, formaterMetres, formaterNombre, formaterPourcent,
  type Largeurs, type TypeReseau,
} from "../../lib/projetsVoirie";
import { EchantillonAxes, EchantillonReseau, fondSegment } from "./Motifs";
import { EditionLargeurs } from "./EditionLargeurs";
import { TableauAxes } from "./TableauAxes";
import { EtatChargement, EtatErreur } from "./EtatsPv";

/**
 * Onglet « Analyse » : longueurs par type de reseau (barre coloree ET trame ET tableau), objets, proprietaires, conflits, tableau par axe,
 * hypotheses et limites TOUJOURS visibles. Tant que les largeurs ne sont pas validees, tout chiffre de conflit est dit « theorique ».
 */

export interface PropsPanneauAnalyse {
  projet: ProjetFiche;
  jeux: JeuProjet[];
  requete: UseQueryResult<Analyse, unknown>;
  apercu: Largeurs | null;
  onApercu: (l: Largeurs | null) => void;
  nomJeu: (jeuId: string | null) => string;
  peutEcrire: boolean;
  estAdmin: boolean;
  enLigne: boolean;
  enregistrer: (corps: Largeurs & { statutParametres?: "VALIDE" }) => Promise<unknown>;
  exporter: () => Promise<void>;
}

function BarreRepartition({ lignes, total }: { lignes: Analyse["reseaux"]["parType"]; total: number }) {
  const utiles = lignes.filter((l) => l.longueurTraceFusionneM > 0);
  const resume = utiles.map((l) => `${STYLE_RESEAU[l.typeReseau].libelle} ${formaterLongueur(l.longueurTraceFusionneM)}, ${formaterPourcent(l.longueurTraceFusionneM / total)}`).join(" ; ");
  if (utiles.length === 0 || total <= 0) return <p className="text-xs text-gray-600">Aucune longueur de réseau à répartir.</p>;
  return (
    <div role="img" aria-label={`Répartition de la longueur physique par type de réseau : ${resume}`} className="flex h-5 w-full overflow-hidden rounded border border-gray-400">
      {utiles.map((l) => (
        <div key={l.typeReseau} data-type={l.typeReseau} style={{ width: `${(l.longueurTraceFusionneM / total) * 100}%`, minWidth: 3, background: fondSegment(l.typeReseau) }} />
      ))}
    </div>
  );
}

function Chiffre({ valeur, libelle, theorique = false }: { valeur: string; libelle: string; theorique?: boolean }) {
  return (
    <div className="rounded border border-gray-200 bg-white p-2">
      <dt className="text-[11px] text-gray-600">{libelle}{theorique && <> <span className="font-semibold text-amber-900">(théorique)</span></>}</dt>
      <dd className="text-sm font-semibold text-navy tabular-nums">{valeur}</dd>
    </div>
  );
}

export function PanneauAnalyse({ projet, jeux, requete, apercu, onApercu, nomJeu, peutEcrire, estAdmin, enLigne, enregistrer, exporter }: PropsPanneauAnalyse) {
  const [export_, setExport] = useState<"repos" | "cours" | "erreur">("repos");
  const a = requete.data;
  const theorique = apercu !== null || (a?.parametres.statut ?? projet.statutParametres) !== "VALIDE";

  async function surExport() {
    setExport("cours");
    try { await exporter(); setExport("repos"); } catch { setExport("erreur"); }
  }

  const totalPhysique = a ? a.reseaux.parType.reduce((s, l) => s + l.longueurTraceFusionneM, 0) : 0;
  const totalObjets = a ? a.reseaux.parType.reduce((s, l) => s + l.nbObjets, 0) : 0;
  const parType = a ? TYPES_RESEAU.flatMap((t) => a.reseaux.parType.filter((l) => l.typeReseau === t)) : [];

  return (
    <div className="space-y-4">
      <section aria-labelledby="pv-titre-params" className="space-y-2">
        <h3 id="pv-titre-params" className="text-sm font-semibold text-navy">Largeurs de calcul</h3>
        <p className="text-xs text-gray-800">
          Chaussée <strong>{formaterMetres(apercu?.largeurChausseeM ?? a?.parametres.largeurChausseeM ?? projet.largeurChausseeM)}</strong>, emprise{" "}
          <strong>{formaterMetres(apercu?.largeurEmpriseM ?? a?.parametres.largeurEmpriseM ?? projet.largeurEmpriseM)}</strong>
          {" "}
          {apercu ? <span className="font-semibold text-amber-900">(aperçu non enregistré, théorique)</span>
            : theorique ? <span className="font-semibold text-amber-900">(théoriques, non validées)</span>
            : <span className="font-semibold text-green-800">(validées)</span>}
          {a?.parametres.projection && <> · projection {a.parametres.projection}</>}
        </p>
        <EditionLargeurs
          key={`${projet.largeurEmpriseM}-${projet.largeurChausseeM}-${projet.statutParametres}`}
          enregistrees={{ largeurEmpriseM: projet.largeurEmpriseM, largeurChausseeM: projet.largeurChausseeM }}
          statut={projet.statutParametres} apercu={apercu} onApercu={onApercu}
          peutEcrire={peutEcrire} estAdmin={estAdmin} enLigne={enLigne} enregistrer={enregistrer}
        />
      </section>

      {requete.isPending && <EtatChargement libelle="Calcul de l'analyse…" />}
      {requete.isError && <EtatErreur erreur={classerErreur(requete.error)} sujet="Analyse" onReessayer={() => void requete.refetch()} enCours={requete.isFetching} />}

      {a && (
        <>
          {!requete.isError && requete.isFetching && <p role="status" className="text-xs text-gray-600">Mise à jour de l&apos;analyse…</p>}
          {theorique && (
            <p role="note" data-testid="mention-theorique" className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
              <strong>Résultat théorique.</strong> Les largeurs d&apos;emprise et de chaussée ne sont pas validées : ce calcul est une aide à la décision, jamais un verdict.
            </p>
          )}

          <section aria-labelledby="pv-titre-reseau" className="space-y-2">
            <h3 id="pv-titre-reseau" className="text-sm font-semibold text-navy">Réseaux par type</h3>
            <dl className="grid grid-cols-2 gap-2">
              <Chiffre libelle="Axes de travaux" valeur={`${formaterNombre(a.axes.nb, 0)} · ${formaterLongueur(a.axes.longueurM)}`} />
              <Chiffre libelle="Tracé fusionné des réseaux (circuits superposés comptés une fois)" valeur={formaterLongueur(totalPhysique)} />
              <Chiffre libelle={LIBELLE_NB_OBJETS} valeur={formaterNombre(totalObjets, 0)} />
              <Chiffre libelle="Concessionnaires" valeur={formaterNombre(a.reseaux.parConcessionnaire.length, 0)} />
            </dl>
            <BarreRepartition lignes={parType} total={totalPhysique} />
            {parType.length > 0 && (
              <table className="w-full border-collapse text-left text-xs">
                <caption className="sr-only">Longueur du tracé fusionné et nombre de circuits ou objets du fichier par type de réseau</caption>
                <thead>
                  <tr className="text-gray-700">
                    <th scope="col" className="py-1 pr-2 font-semibold">Type</th>
                    <th scope="col" className="py-1 pr-2 text-right font-semibold">Tracé fusionné</th>
                    <th scope="col" className="py-1 pr-2 text-right font-semibold">Part</th>
                    <th scope="col" className="py-1 text-right font-semibold">Circuits ou objets</th>
                  </tr>
                </thead>
                <tbody>
                  {parType.map((l) => (
                    <tr key={l.typeReseau} className="border-t border-gray-200">
                      <th scope="row" className="py-1 pr-2 text-left font-medium text-gray-900">
                        <EchantillonReseau type={l.typeReseau} /> {STYLE_RESEAU[l.typeReseau].libelle}
                        <span className="block pl-9 text-[11px] font-normal text-gray-600">{STYLE_RESEAU[l.typeReseau].nomMotif}</span>
                      </th>
                      <td className="whitespace-nowrap py-1 pr-2 text-right tabular-nums">{formaterLongueur(l.longueurTraceFusionneM)}</td>
                      <td className="whitespace-nowrap py-1 pr-2 text-right tabular-nums">{totalPhysique > 0 ? formaterPourcent(l.longueurTraceFusionneM / totalPhysique) : "n/d"}</td>
                      <td className="whitespace-nowrap py-1 text-right tabular-nums">{formaterNombre(l.nbObjets, 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="text-xs text-gray-600">
              <EchantillonAxes /> Les axes de travaux sont tracés en bleu marine, trait plein épais. {LIBELLE_TRACE_FUSIONNE} : un même tracé repris par plusieurs circuits compte une seule fois.
            </p>
          </section>

          <section aria-labelledby="pv-titre-prop" className="space-y-2">
            <h3 id="pv-titre-prop" className="text-sm font-semibold text-navy">Propriétaires des réseaux</h3>
            {a.reseaux.parConcessionnaire.length === 0 ? (
              <p className="text-xs text-gray-600">Aucun réseau de concessionnaire n&apos;est chargé.</p>
            ) : (
              <div role="region" aria-label="Propriétaires des réseaux, tableau défilant" tabIndex={0} className="overflow-x-auto">
                <table className="w-full min-w-[420px] border-collapse text-left text-xs">
                  <caption className="sr-only">Longueur du tracé fusionné, somme des objets et nombre de circuits ou objets du fichier par concessionnaire</caption>
                  <thead>
                    <tr className="text-gray-700">
                      <th scope="col" className="py-1 pr-2 font-semibold">Concessionnaire</th>
                      <th scope="col" className="py-1 pr-2 text-right font-semibold">Tracé fusionné</th>
                      <th scope="col" className="py-1 pr-2 text-right font-semibold">Somme des objets</th>
                      <th scope="col" className="py-1 text-right font-semibold">Circuits ou objets</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.reseaux.parConcessionnaire.map((l, i) => {
                      const doublon = l.longueurSommeM - l.longueurTraceFusionneM;
                      return (
                        <tr key={`${l.concessionnaireId ?? l.nom}-${i}`} className="border-t border-gray-200 align-top">
                          <th scope="row" className="py-1 pr-2 text-left font-medium text-gray-900 break-words">
                            {l.typeReseau && <><EchantillonReseau type={l.typeReseau} />{" "}</>}{l.nom}
                            {l.typeReseau && <span className="block text-[11px] font-normal text-gray-600">{STYLE_RESEAU[l.typeReseau].libelle}</span>}
                          </th>
                          <td className="whitespace-nowrap py-1 pr-2 text-right tabular-nums">{formaterMetres(l.longueurTraceFusionneM)}</td>
                          <td className="whitespace-nowrap py-1 pr-2 text-right tabular-nums">
                            {formaterMetres(l.longueurSommeM)}
                            {doublon > 0.5 && <span className="block text-[11px] text-gray-600">dont {formaterMetres(doublon)} de circuits superposés</span>}
                          </td>
                          <td className="whitespace-nowrap py-1 text-right tabular-nums">{formaterNombre(l.nbObjets, 0)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section aria-labelledby="pv-titre-conflits" className="space-y-2">
            <h3 id="pv-titre-conflits" className="text-sm font-semibold text-navy">Conflits avec les travaux{theorique ? " (théoriques)" : ""}</h3>
            <dl className="grid grid-cols-2 gap-2">
              <Chiffre libelle="Réseau dans la chaussée" valeur={formaterLongueur(a.conflits.total.chausseeM)} theorique={theorique} />
              <Chiffre libelle="Réseau dans l'emprise (chaussée comprise)" valeur={formaterLongueur(a.conflits.total.empriseM)} theorique={theorique} />
              {a.conflits.total.horsEmpriseM !== null && <Chiffre libelle="Réseau hors emprise" valeur={formaterLongueur(a.conflits.total.horsEmpriseM)} theorique={theorique} />}
              <Chiffre libelle="Croisements" valeur={formaterNombre(a.conflits.total.croisements, 0)} theorique={theorique} />
              <Chiffre libelle="Axes touchés" valeur={formaterNombre(a.conflits.total.axesTouches, 0)} theorique={theorique} />
              <Chiffre libelle="Objets touchés" valeur={formaterNombre(a.conflits.total.objetsTouches, 0)} theorique={theorique} />
            </dl>
            {a.conflits.parConcessionnaire.length > 0 && (
              <table className="w-full border-collapse text-left text-xs">
                <caption className="sr-only">Conflits par concessionnaire</caption>
                <thead>
                  <tr className="text-gray-700">
                    <th scope="col" className="py-1 pr-2 font-semibold">Concessionnaire</th>
                    <th scope="col" className="py-1 pr-2 font-semibold">Nature du résultat</th>
                    <th scope="col" className="py-1 pr-2 text-right font-semibold">Chaussée</th>
                    <th scope="col" className="py-1 pr-2 text-right font-semibold">Emprise</th>
                    <th scope="col" className="py-1 text-right font-semibold">Croisements</th>
                  </tr>
                </thead>
                <tbody>
                  {a.conflits.parConcessionnaire.map((l, i) => (
                    <tr key={`${l.concessionnaireId ?? l.nom}-${i}`} className="border-t border-gray-200">
                      <th scope="row" className="py-1 pr-2 text-left font-medium text-gray-900 break-words">{l.nom}</th>
                      <td className="py-1 pr-2 text-[11px]">{natureResultat(l, a, jeux)} <span className="text-gray-600">{libelleVerification(l.verification)}</span></td>
                      <td className="whitespace-nowrap py-1 pr-2 text-right tabular-nums">{formaterMetres(l.chausseeM)}</td>
                      <td className="whitespace-nowrap py-1 pr-2 text-right tabular-nums">{formaterMetres(l.empriseM)}</td>
                      <td className="whitespace-nowrap py-1 text-right tabular-nums">{formaterNombre(l.croisements, 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section aria-labelledby="pv-titre-axes" className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 id="pv-titre-axes" className="text-sm font-semibold text-navy">Conflits par axe</h3>
              {peutEcrire && (
                <Button type="button" size="sm" variant="outline" className="min-h-[44px] xl:min-h-8" disabled={!enLigne || export_ === "cours"} onClick={() => void surExport()}>
                  <Download aria-hidden="true" /> {export_ === "cours" ? "Export en cours…" : "Exporter en CSV"}
                </Button>
              )}
            </div>
            {export_ === "erreur" && <p role="alert" className="text-xs text-red-700">L&apos;export CSV a échoué. Réessayez ; l&apos;export est consigné dans le journal d&apos;audit.</p>}
            <TableauAxes lignes={a.conflits.parAxe} nomJeu={nomJeu} versionAlgorithme={a.versionAlgorithme} />
          </section>

          {aProximite(a, jeux) && (
            <p role="note" data-testid="note-proximite" className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
              <strong>Proximité à vérifier.</strong> Au moins un réseau est de classe de précision D, E ou inconnue : ses résultats sont une proximité à vérifier, pas un conflit établi.
            </p>
          )}

          <section aria-labelledby="pv-titre-hyp" className="space-y-2 rounded border border-gray-300 bg-gray-50 p-3">
            <h3 id="pv-titre-hyp" className="text-sm font-semibold text-navy">Hypothèses{theorique ? " (théoriques)" : ""} et limites</h3>
            <div>
              <h4 className="text-xs font-semibold text-gray-800">Hypothèses</h4>
              {a.hypotheses.length > 0 ? (
                <ul className="list-disc space-y-0.5 pl-5 text-xs text-gray-800">{a.hypotheses.map((h, i) => <li key={i}>{h}</li>)}</ul>
              ) : <p className="text-xs text-gray-600">Le serveur n&apos;a communiqué aucune hypothèse.</p>}
            </div>
            <div>
              <h4 className="text-xs font-semibold text-gray-800">Limites du module (toujours valables)</h4>
              <ul data-testid="limites-constantes" className="list-disc space-y-0.5 pl-5 text-xs text-gray-800">
                {LIMITES_CONSTANTES.map((t) => <li key={t}>{t}</li>)}
              </ul>
            </div>
            <div>
              <h4 className="text-xs font-semibold text-gray-800">Limites propres à ce calcul</h4>
              {a.limites.length > 0 ? (
                <ul className="list-disc space-y-0.5 pl-5 text-xs text-gray-800">{a.limites.map((h, i) => <li key={i}>{h}</li>)}</ul>
              ) : <p className="text-xs text-gray-600">Le serveur n&apos;a communiqué aucune limite.</p>}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

/** Limites qui valent pour TOUT resultat du module (cahier des charges v2) : toujours affichees, quel que soit le contenu de la reponse. */
export const LIMITES_CONSTANTES = [
  "Le conflit vertical (profondeur, altitude) n'est pas évalué : seule la position en plan est comparée.",
  "Aucun conflit détecté ne prouve l'absence de réseau : un tracé absent, incomplet ou imprécis ne produit aucun conflit.",
  "Résultat indicatif : il ne vaut pas décision de déplacement. Chaque ligne reste « à vérifier » auprès du concessionnaire et sur le terrain.",
];

/**
 * « Proximite a verifier » pour un jeu de classe D, E ou inconnue, « conflit a verifier » sinon. La qualification du SERVEUR fait foi
 * quand elle est fournie (contrat v2, section 5) ; a defaut, on la deduit de la classe des jeux du concessionnaire.
 */
export function natureResultat(l: { concessionnaireId: string | null; qualification?: string | null }, a: Analyse, jeux: JeuProjet[]): string {
  if (l.qualification === "PROXIMITE_A_VERIFIER") return "Proximité à vérifier";
  if (l.qualification === "CONFLIT_POTENTIEL") return "Conflit à vérifier";
  const ids = a.reseaux.parConcessionnaire.find((c) => c.concessionnaireId === l.concessionnaireId)?.jeuxIds ?? [];
  const js = jeux.filter((j) => ids.includes(j.id));
  return js.length > 0 && js.some((j) => classeIncertaine(j.classePrecision)) ? "Proximité à vérifier" : "Conflit à vérifier";
}

function aProximite(a: Analyse, jeux: JeuProjet[]): boolean {
  return a.conflits.parConcessionnaire.some((c) => natureResultat(c, a, jeux) === "Proximité à vérifier");
}

/** Type de reseau lisible, pour les autres composants. */
export const libelleType = (t: TypeReseau | null | undefined) => (t ? STYLE_RESEAU[t].libelle : "Type non précisé");
