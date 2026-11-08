import { useEffect, useRef, type ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { X } from "lucide-react";
import {
  LIBELLES, AIDE_QUALITE_LIEN, classerErreur, formaterDate, formaterGnf, formaterPourcent, libelleCodeControle, libelleQualiteLien, libelleRetard,
  type MarcheVue, type ReponseMarche,
} from "../../../lib/aideDecisionContractuel";
import { Button } from "../../ui/Button";
import { EtatChargement, EtatErreur } from "./EtatsContractuel";
import { MontantEtiquete } from "./MontantEtiquete";

/**
 * Fiche d'un marche (panneau lateral). Meme separation que le tableau, avec ce que le tableau ne peut pas porter : la source et
 * l'avertissement de chaque montant, la liste des decomptes (lue par la route de fiche), les chantiers et troncons lies avec la
 * qualite de leur lien, la regle de retard et ses limites. Le titre prend le focus a l'ouverture ; Echap ferme.
 */

function Section({ id, titre, children }: { id: string; titre: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="border-t border-gray-200 pt-3">
      <h4 id={id} className="text-sm font-semibold text-navy">{titre}</h4>
      <div className="mt-1 space-y-1 text-sm">{children}</div>
    </section>
  );
}

function Ligne({ libelle, children }: { libelle: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-2">
      <dt className="text-xs font-medium text-gray-700">{libelle}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

const NON_DISPO = <span className="text-gray-600">Non disponible</span>;

export function FicheMarche({ marche: m, detail, onFermer }: { marche: MarcheVue; detail: UseQueryResult<ReponseMarche, unknown>; onFermer: () => void }) {
  const titre = useRef<HTMLHeadingElement>(null);
  const racine = useRef<HTMLElement>(null);
  useEffect(() => {
    titre.current?.focus();
    titre.current?.scrollIntoView?.({ block: "nearest" });
  }, [m.id]);

  // Echap ferme la fiche : ecouteur pose sur l'element (un <aside> n'est pas interactif, JSX ne doit pas porter onKeyDown).
  useEffect(() => {
    const el = racine.current;
    if (!el) return;
    const surTouche = (e: KeyboardEvent) => { if (e.key === "Escape") onFermer(); };
    el.addEventListener("keydown", surTouche);
    return () => el.removeEventListener("keydown", surTouche);
  }, [onFermer]);

  return (
    <aside ref={racine} id="panneau-marche" aria-labelledby="titre-fiche-marche" data-testid="fiche-marche"
      className="space-y-3 rounded-lg border border-gray-300 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <h3 id="titre-fiche-marche" ref={titre} tabIndex={-1} className="min-w-0 break-words text-base font-bold text-navy focus:outline-none">
          {m.intitule}
        </h3>
        <Button type="button" size="sm" variant="outline" className="min-h-[44px] shrink-0 xl:min-h-0" onClick={onFermer} aria-label={`Fermer la fiche du marché ${m.intitule}`}>
          <X aria-hidden="true" /> Fermer
        </Button>
      </div>
      <p className="text-xs text-gray-700">Copie gelée : DigitalRoad fait foi. Mise à jour de la copie : {formaterDate(m.miseAJourLe)}.</p>

      <Section id="fm-identite" titre="Identification">
        <dl className="space-y-1">
          <Ligne libelle="Référence">{m.reference.valeur ? m.reference.valeur.join(", ") : NON_DISPO}{m.reference.avertissement && <span className="block text-xs text-gray-700">{m.reference.avertissement}</span>}</Ligne>
          <Ligne libelle="Lots">{NON_DISPO}<span className="block text-xs text-gray-700">{m.lots.avertissement}</span></Ligne>
          <Ligne libelle="Entreprise">{m.entreprises.valeur ? m.entreprises.valeur.join(", ") : NON_DISPO}<span className="block text-xs text-gray-700">{m.entreprises.source}</span></Ligne>
          <Ligne libelle="Bailleur">{m.bailleur.nom ?? <span className="text-gray-600">Non renseigné</span>}{m.bailleur.type && <span className="text-xs text-gray-700"> ({m.bailleur.type})</span>}</Ligne>
          <Ligne libelle="Statut saisi">{m.statut.libelle}<span className="block text-xs text-gray-700">{m.statut.source}</span></Ligne>
        </dl>
      </Section>

      <Section id="fm-dates" titre="Dates contractuelles, délais et avenants">
        <dl className="space-y-1">
          <Ligne libelle="Signature">{formaterDate(m.dates.signature)}</Ligne>
          <Ligne libelle="Début prévu">{formaterDate(m.dates.debutPrevu)}</Ligne>
          <Ligne libelle="Fin prévue">{formaterDate(m.dates.finPrevue)}</Ligne>
          <Ligne libelle="Durée prévue">{m.delais.dureePrevueJours !== null ? `${m.delais.dureePrevueJours} jours` : NON_DISPO}</Ligne>
          <Ligne libelle="Réception provisoire">{formaterDate(m.dates.receptionProvisoire)}</Ligne>
          <Ligne libelle="Garantie de bonne exécution">{formaterDate(m.dates.garantieBonneExecution)}</Ligne>
          <Ligne libelle="Avenants">{NON_DISPO}<span className="block text-xs text-gray-700">{m.delais.avenants.avertissement}</span></Ligne>
          <Ligne libelle="Suspensions">{NON_DISPO}<span className="block text-xs text-gray-700">{m.delais.suspensions.avertissement}</span></Ligne>
        </dl>
      </Section>

      <Section id="fm-montants" titre="Montants (quatre grandeurs distinctes)">
        <dl className="space-y-2">
          {([["Contractuel", m.montants.contractuel], ["Engagé", m.montants.engage], ["Décaissé", m.montants.decaisse], ["Prévisionnel", m.montants.previsionnel]] as const).map(([lib, mt]) => (
            <div key={lib} className="rounded border border-gray-100 bg-gray-50 p-2">
              <dt className="text-xs font-semibold text-gray-800">{lib}</dt>
              <dd><MontantEtiquete montant={mt} /></dd>
              <dd className="text-xs text-gray-700">Source : {mt.source}</dd>
              {mt.avertissement && <dd className="text-xs text-gray-700">{mt.avertissement}</dd>}
            </div>
          ))}
        </dl>
        {m.programmes.retenusLies.length > 0 && (
          <ul className="list-disc pl-5 text-xs">
            {m.programmes.retenusLies.map((p) => <li key={p.id}>Programme retenu {p.annee} : {p.intitule}, {formaterGnf(p.montantPrevuGnf)} (lien indirect par tronçon commun)</li>)}
          </ul>
        )}
        {m.programmes.ambigus > 0 && <p className="text-xs text-amber-900">{m.programmes.ambigus} programme(s) retenu(s) au rattachement ambigu : aucun montant imputé.</p>}
      </Section>

      <Section id="fm-decomptes" titre="Décomptes saisis">
        {detail.isPending && <EtatChargement libelle="Chargement des décomptes…" />}
        {detail.isError && <EtatErreur panneau="Décomptes" erreur={classerErreur(detail.error)} onReessayer={() => void detail.refetch()} reessaiEnCours={detail.isFetching} />}
        {detail.data && (
          detail.data.decomptes.liste.length === 0
            ? <p className="text-gray-700">Aucun décompte saisi : ce n&apos;est pas un paiement nul.</p>
            : (
              // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
              <div className="overflow-x-auto" role="region" aria-label="Décomptes du marché, défilement horizontal" tabIndex={0}>
                <table className="w-full min-w-[520px] border-collapse text-xs">
                  <caption className="pb-1 text-left text-gray-700">Seuls les décomptes de statut saisi « PAYE » forment le décaissé. {detail.data.decomptes.tronque && "Liste tronquée."}</caption>
                  <thead><tr className="border-b border-gray-300 text-left text-gray-800">
                    {["N°", "Type", "Statut saisi", "Montant", "Émis le", "Payé le", "Dans le décaissé"].map((h) => <th key={h} scope="col" className="py-1 pr-2 font-semibold">{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {detail.data.decomptes.liste.map((d) => (
                      <tr key={d.numero} className="border-b border-gray-100">
                        <th scope="row" className="py-1 pr-2 text-left font-medium">{d.numero}</th>
                        <td className="py-1 pr-2">{d.type}</td>
                        <td className="py-1 pr-2">{d.statut}</td>
                        <td className="py-1 pr-2 tabular-nums">{d.montantGnf !== null ? formaterGnf(d.montantGnf) : "Masqué"}</td>
                        <td className="py-1 pr-2">{formaterDate(d.dateEmission)}</td>
                        <td className="py-1 pr-2">{formaterDate(d.datePaiement)}</td>
                        <td className="py-1">{d.compteDansDecaisse ? "Oui" : "Non"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        )}
      </Section>

      <Section id="fm-avancement" titre="Avancement (déclaré, constaté, financier : trois choses distinctes)">
        <dl className="space-y-1">
          <Ligne libelle={LIBELLES.declare}>
            {m.avancement.declare.etat === "DISPONIBLE" ? <>{formaterPourcent(m.avancement.declare.physiqueReelPct)} <span className="text-xs text-gray-700">(prévu {formaterPourcent(m.avancement.declare.physiquePrevuPct)}, période du {formaterDate(m.avancement.declare.periode)})</span></> : NON_DISPO}
            {m.avancement.declare.avertissement && <span className="block text-xs text-gray-700">{m.avancement.declare.avertissement}</span>}
          </Ligne>
          <Ligne libelle={LIBELLES.constate}>{NON_DISPO}<span className="block text-xs text-gray-700">{m.avancement.constate.avertissement}</span></Ligne>
          <Ligne libelle={LIBELLES.financier}>
            {m.avancement.financier.etat === "DISPONIBLE" ? <>{formaterPourcent(m.avancement.financier.reelPct)} <span className="text-xs text-gray-700">(prévu {formaterPourcent(m.avancement.financier.prevuPct)})</span></> : NON_DISPO}
            <span className="block text-xs text-gray-700">{m.avancement.financier.avertissement}</span>
          </Ligne>
        </dl>
      </Section>

      <Section id="fm-retard" titre="Retard et alertes">
        <p className={m.retard.etat === "EN_RETARD" ? "font-semibold text-red-800" : "font-medium"}>{libelleRetard(m.retard.etat)}</p>
        {m.retard.alertes.length > 0 && <ul className="list-disc pl-5 text-xs">{m.retard.alertes.map((a) => <li key={a.code}>{a.message}</li>)}</ul>}
        <ul className="list-disc pl-5 text-xs text-gray-700">{m.retard.avertissements.map((a) => <li key={a}>{a}</li>)}</ul>
      </Section>

      <Section id="fm-liens" titre="Chantiers et tronçons liés">
        <p className="text-xs text-gray-700">
          Qualité du lien aux chantiers : <strong>{libelleQualiteLien(m.liens.chantiers.qualite)}</strong> ({AIDE_QUALITE_LIEN[m.liens.chantiers.qualite]}) Tronçons : <strong>{libelleQualiteLien(m.liens.troncons.qualite)}</strong> ({AIDE_QUALITE_LIEN[m.liens.troncons.qualite]})
        </p>
        {m.liens.chantiers.autresRegionsMasquees && <p className="text-xs text-amber-900">Des chantiers d&apos;autres régions sont liés à ce marché et ne sont pas affichés.</p>}
        {m.liens.chantiers.liste.length === 0 ? <p className="text-gray-700">Aucun chantier lié visible.</p> : (
          <ul className="space-y-1.5">
            {m.liens.chantiers.liste.map((c) => (
              <li key={c.id} className="rounded border border-gray-100 p-2 text-xs">
                <strong>{c.intitule}</strong> ({c.entreprise}, {c.statut}). Avancement déclaré : {formaterPourcent(c.avancementDeclarePct)}. Lien au tronçon : {libelleQualiteLien(c.lienTroncon.qualite)}
                {c.lienTroncon.troncon && ` (${c.lienTroncon.troncon.code})`}{!c.lienTroncon.troncon && c.lienTroncon.tronconChantier && ` (${c.lienTroncon.tronconChantier.code})`}.
                {c.partageEntreMarches && <span className="block text-amber-900">Ce chantier est rattaché à plusieurs marchés.</span>}
              </li>
            ))}
          </ul>
        )}
        {m.liens.chantiers.tronque && <p className="text-xs text-gray-700">Liste tronquée : {m.liens.chantiers.total} chantiers au total.</p>}
        {m.liens.troncons.liste.length > 0 && (
          <p className="text-xs">Tronçons : {m.liens.troncons.liste.map((t) => `${t.code} (${t.via === "LIEN" ? "lien direct" : "par le chantier"})`).join(", ")}</p>
        )}
      </Section>

      <Section id="fm-anomalies" titre="Anomalies, pièces et avertissements">
        {m.anomalies.length === 0 ? <p className="text-gray-700">Aucune anomalie détectée par les contrôles provisoires.</p> : (
          <ul className="list-disc pl-5 text-xs">{m.anomalies.map((a) => <li key={a}>{libelleCodeControle(a)}</li>)}</ul>
        )}
        <p className="text-xs text-gray-700">Pièces et liens source : non disponibles. {m.pieces.raison}</p>
        <ul className="list-disc pl-5 text-xs text-gray-700">{m.avertissements.map((a) => <li key={a}>{a}</li>)}</ul>
      </Section>
    </aside>
  );
}
