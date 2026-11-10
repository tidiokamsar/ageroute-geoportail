import { useId, useState } from "react";
import { FilePlus2, ShieldCheck } from "lucide-react";
import { Button } from "../../ui/Button";
import { Input, Select } from "../../ui/Input";
import { CadreDialogue, CHAMP_TEXTE, Compteur, LIBELLE_CHAMP, useEnvoiDialogue } from "../CadreDialogue";
import { EtatChargement, EtatErreur } from "../EtatsPv";
import { useApprouverRegleRapprochement, useCreerRegleRapprochement, useReglesRapprochement } from "../../../lib/projetsVoirieSourcesHooks";
import { STYLE_RESEAU, formaterDate, formaterNombre, type TypeReseau } from "../../../lib/projetsVoirie";
import { justificationValide } from "../../../lib/projetsVoirieConflits";
import { LIBELLE_STATUT_REGLE, classerErreurSources, corpsRegle, raisonNonApprobation, type RegleRapprochement, type SaisieRegle } from "../../../lib/projetsVoirieSources";
import { FAMILLES_TECHNIQUES } from "../../../lib/projetsVoirieTerritoires";
import type { CorpsRegleRapprochement } from "../../../lib/projetsVoirieSourcesApi";

/**
 * Regles de rapprochement des sources (lot S1) : versionnees, approuvees, immuables une fois approuvees.
 * - creation d'un brouillon : ADMIN et GESTIONNAIRE (un brouillon n'agit sur aucune comparaison) ;
 * - approbation : ADMIN, par une AUTRE personne que l'auteur ; l'auteur voit pourquoi il ne peut pas approuver (aucune derogation proposee).
 * La famille est une famille TECHNIQUE (constante du contrat), pas un type de reseau configurable.
 */

const libelleFamille = (f: string | null) => (f ? (f in STYLE_RESEAU ? STYLE_RESEAU[f as TypeReseau].libelle : f) : "Toutes les familles");
const metres = (x: number | null) => (x === null ? "n/d" : `${formaterNombre(x, 2)} m`);

export function ReglesRapprochement({ projetId, actif, peutEcrire, estAdmin, compteId, enLigne }: {
  projetId: string; actif: boolean; peutEcrire: boolean; estAdmin: boolean; compteId: string | undefined; enLigne: boolean;
}) {
  const regles = useReglesRapprochement(projetId, actif);
  const creer = useCreerRegleRapprochement(projetId);
  const approuver = useApprouverRegleRapprochement(projetId);
  const [creation, setCreation] = useState(false);
  const [aApprouver, setAApprouver] = useState<RegleRapprochement | null>(null);
  const role = estAdmin ? "ADMIN" : peutEcrire ? "GESTIONNAIRE" : "LECTEUR";

  return (
    <section aria-labelledby="pv-titre-regles-rapprochement" className="space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 id="pv-titre-regles-rapprochement" className="text-sm font-semibold text-navy">Règles de rapprochement des sources</h3>
        {peutEcrire && (
          <Button type="button" variant="outline" className="min-h-[44px] xl:min-h-9" disabled={!enLigne} onClick={() => setCreation(true)}>
            <FilePlus2 aria-hidden="true" /> Créer un brouillon de règle
          </Button>
        )}
      </div>
      <p className="text-xs text-gray-700">Une règle fixe la marge ajoutée à la plus grande des deux précisions, le rayon d&apos;appariement et la part hors corridor tolérée. Un brouillon n&apos;agit sur aucune comparaison ; une règle approuvée ne change plus.</p>
      {regles.isPending && <EtatChargement libelle="Chargement des règles…" />}
      {regles.isError && <EtatErreur erreur={classerErreurSources(regles.error)} sujet="Règles de rapprochement" onReessayer={() => void regles.refetch()} enCours={regles.isFetching} />}
      {regles.data && (
        <>
          {regles.data.avertissements.map((a) => <p key={a} className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-950">{a}</p>)}
          <ul className="space-y-1">
            {regles.data.regles.map((r) => {
              const raison = raisonNonApprobation(r, { id: compteId, role });
              return (
                <li key={r.id} className="space-y-1 rounded border border-gray-200 p-2 text-xs text-gray-900">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{r.code} v{r.version}</span>
                    <span className="rounded bg-gray-100 px-1">{LIBELLE_STATUT_REGLE[r.statut]}</span>
                    <span>{libelleFamille(r.famille)}</span>
                    <span>{r.portee === "PROJET" ? "propre au projet" : "générale"}{r.systeme ? ", règle du système" : ""}</span>
                  </p>
                  <p>Marge {metres(r.margeM)}, rayon d&apos;appariement {metres(r.rayonAppariementM)}, part hors corridor tolérée {r.partHorsCorridorMax === null ? "n/d" : `${formaterNombre(r.partHorsCorridorMax * 100, 1)} %`}.</p>
                  <p>{r.precisionParClasseM ? `Barème par classe : ${Object.entries(r.precisionParClasseM).map(([k, v]) => `${k} ${metres(v)}`).join(", ")}.${r.statut === "BROUILLON" ? " Il ne s'applique qu'après approbation par un administrateur autre que l'auteur." : r.systeme ? " Barème provisoire du système, jamais approuvé par une personne." : ""}` : "Sans barème par classe : une classe A à E n'est pas convertie en mètres."}</p>
                  <p className="text-gray-700">
                    {r.creePar ? `Créée par ${r.creePar.nomComplet}` : "Créée par le système"}{r.createdAt ? ` le ${formaterDate(r.createdAt)}` : ""}
                    {r.approuvePar ? `, approuvée par ${r.approuvePar.nomComplet}${r.approuveLe ? ` le ${formaterDate(r.approuveLe)}` : ""}` : ""}.
                  </p>
                  {r.statut === "BROUILLON" && (raison === null ? (
                    <Button type="button" size="sm" variant="outline" className="min-h-[44px] xl:min-h-8" disabled={!enLigne} onClick={() => setAApprouver(r)}>
                      <ShieldCheck aria-hidden="true" /> Approuver<span className="sr-only"> la règle {r.code} v{r.version}</span>
                    </Button>
                  ) : peutEcrire && <p data-testid="raison-non-approbation" className="text-amber-900">{raison}</p>)}
                </li>
              );
            })}
          </ul>
          {regles.data.effectives.length > 0 && (
            <details className="text-xs text-gray-900">
              <summary className="min-h-[44px] cursor-pointer py-2 font-semibold text-navy xl:min-h-0 xl:py-0">Règle en vigueur par famille</summary>
              <ul className="mt-1 space-y-0.5">
                {regles.data.effectives.map((e) => <li key={e.famille}>{libelleFamille(e.famille)} : {e.code ? `${e.code} v${e.version ?? "?"}` : "aucune"} ({e.portee === "PROJET" ? "propre au projet" : "générale"}), marge {metres(e.margeM)}</li>)}
              </ul>
            </details>
          )}
        </>
      )}
      {creation && <DialogueRegle enLigne={enLigne} onFermer={() => setCreation(false)} onValider={(c) => creer.mutateAsync(c)} />}
      {aApprouver && <DialogueApprobation regle={aApprouver} enLigne={enLigne} onFermer={() => setAApprouver(null)} onValider={(j) => approuver.mutateAsync({ regleId: aApprouver.id, justification: j })} />}
    </section>
  );
}

function DialogueRegle({ enLigne, onFermer, onValider }: { enLigne: boolean; onFermer: () => void; onValider: (c: CorpsRegleRapprochement) => Promise<unknown> }) {
  const id = useId();
  const [s, setS] = useState<SaisieRegle>({ famille: "", code: "", margeM: "", rayonAppariementM: "", partHorsCorridorPct: "", A: "", B: "", C: "", D: "", justification: "" });
  const { enCours, erreur, envoyer } = useEnvoiDialogue(onFermer, classerErreurSources);
  const r = corpsRegle(s);
  const maj = (p: Partial<SaisieRegle>) => setS((x) => ({ ...x, ...p }));
  const champ = (cle: keyof SaisieRegle, libelle: string, mode?: "decimal") => (
    <div>
      <label htmlFor={`${id}-${cle}`} className={LIBELLE_CHAMP}>{libelle}</label>
      <Input id={`${id}-${cle}`} value={s[cle]} onChange={(e) => maj({ [cle]: e.target.value } as Partial<SaisieRegle>)} inputMode={mode} autoComplete="off" disabled={enCours} className="mt-1 border-gray-300" />
    </div>
  );
  return (
    <CadreDialogue
      titre="Créer un brouillon de règle de rapprochement"
      description={<>
        <p>Un brouillon n&apos;agit sur aucune comparaison tant qu&apos;un administrateur, autre que vous, ne l&apos;a pas approuvé. Un champ laissé vide prend la valeur par défaut du serveur (provisoire, à valider par la DSI).</p>
        <p>Le barème par classe attribue une précision en mètres à un objet qui ne déclare qu&apos;une classe. Laissé vide, le barème est celui que le serveur enregistre : il est affiché dans la liste après la création. Un barème ne s&apos;applique qu&apos;après approbation par un administrateur autre que l&apos;auteur ; sans barème appliqué, un objet qui ne déclare qu&apos;une classe donne un rapprochement incertain.</p>
      </>}
      enCours={enCours} erreur={erreur} peutValider={r.corps !== null} aide={r.erreurs} libelleValider="Créer le brouillon" libelleEnCours="Enregistrement…"
      onFermer={onFermer} onValider={() => { if (r.corps) void envoyer(() => onValider(r.corps as CorpsRegleRapprochement)); }} enLigne={enLigne} large
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${id}-famille`} className={LIBELLE_CHAMP}>Famille technique de réseau</label>
          <Select id={`${id}-famille`} value={s.famille} onChange={(e) => maj({ famille: e.target.value })} disabled={enCours} className="mt-1 border-gray-300">
            <option value="">Toutes les familles</option>
            {FAMILLES_TECHNIQUES.map((f) => <option key={f} value={f}>{libelleFamille(f)}</option>)}
          </Select>
        </div>
        {champ("code", "Code de la règle")}
        {champ("margeM", "Marge (m)", "decimal")}
        {champ("rayonAppariementM", "Rayon d'appariement (m)", "decimal")}
        {champ("partHorsCorridorPct", "Part hors corridor tolérée (%)", "decimal")}
      </div>
      <fieldset className="rounded border border-gray-200 p-2">
        <legend className="px-1 text-xs font-semibold text-gray-900">Barème par classe, en mètres (facultatif, les quatre ou aucune)</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{champ("A", "Classe A", "decimal")}{champ("B", "Classe B", "decimal")}{champ("C", "Classe C", "decimal")}{champ("D", "Classe D", "decimal")}</div>
      </fieldset>
      <div>
        <label htmlFor={`${id}-j`} className={LIBELLE_CHAMP}>Justification (10 caractères minimum)</label>
        <textarea id={`${id}-j`} value={s.justification} onChange={(e) => maj({ justification: e.target.value })} rows={3} maxLength={2000} disabled={enCours} aria-describedby={`${id}-jn`} className={CHAMP_TEXTE} />
        <Compteur id={`${id}-jn`} texte={s.justification} />
      </div>
    </CadreDialogue>
  );
}

function DialogueApprobation({ regle, enLigne, onFermer, onValider }: { regle: RegleRapprochement; enLigne: boolean; onFermer: () => void; onValider: (j: string) => Promise<unknown> }) {
  const id = useId();
  const [j, setJ] = useState("");
  const { enCours, erreur, envoyer } = useEnvoiDialogue(onFermer, classerErreurSources);
  return (
    <CadreDialogue
      titre={`Approuver la règle ${regle.code} v${regle.version}`}
      description={<>
        <p>Une fois approuvée, la règle est immuable et s&apos;applique aux comparaisons lancées ensuite. Elle ne modifie aucune comparaison déjà calculée.</p>
        <p>L&apos;auteur d&apos;un brouillon ne l&apos;approuve jamais lui-même : une autre personne, administrateur, le fait.</p>
      </>}
      enCours={enCours} erreur={erreur} peutValider={justificationValide(j)} aide={["Une justification de 10 caractères au moins est obligatoire."]}
      libelleValider="Approuver" libelleEnCours="Approbation…" onFermer={onFermer} onValider={() => void envoyer(() => onValider(j.trim()))} enLigne={enLigne}
    >
      <div>
        <label htmlFor={`${id}-j`} className={LIBELLE_CHAMP}>Justification (10 caractères minimum)</label>
        <textarea id={`${id}-j`} value={j} onChange={(e) => setJ(e.target.value)} rows={3} maxLength={2000} disabled={enCours} aria-describedby={`${id}-jn`} className={CHAMP_TEXTE} />
        <Compteur id={`${id}-jn`} texte={j} />
      </div>
    </CadreDialogue>
  );
}
