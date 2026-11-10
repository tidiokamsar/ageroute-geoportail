/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- zone de defilement focusable au clavier (WCAG 2.1.1, regle axe scrollable-region-focusable) */
import { useId, useState } from "react";
import { ListChecks, PenLine, Plus, Power, Trash2 } from "lucide-react";
import { Button } from "../../ui/Button";
import { Input, Select } from "../../ui/Input";
import { CadreDialogue, CHAMP_TEXTE, LIBELLE_CHAMP, useEnvoiDialogue } from "../CadreDialogue";
import { EtatChargement, EtatErreur, EtatVide } from "../EtatsPv";
import { useCreerValeur, useModifierValeur, useReferentiel, useRetirerValeur } from "../../../lib/projetsVoirieTerritoiresHooks";
import { STYLE_RESEAU, formaterDate, type TypeReseau } from "../../../lib/projetsVoirie";
import {
  AIDE_DOMAINE, DOMAINES_REFERENTIEL, FAMILLES_TECHNIQUES, FONCTIONS_DEBLOQUABLES, LIBELLE_DOMAINE, LIBELLE_FONCTION, MOTIF_CODE, SAISIE_PARAMETRES_VIDE,
  classerErreurTerritoires, construireParametres, resumeParametres, saisieDepuisParametres,
  type DomaineReferentiel, type SaisieParametres, type ValeurReferentiel,
} from "../../../lib/projetsVoirieTerritoires";

/**
 * Administration des referentiels (ADMIN) : par domaine, liste (valeurs actives ET desactivees), creation, modification, desactivation,
 * retrait LOGIQUE. Les parametres suivent le schema du domaine (CONTRAT-TERRITOIRES.md section 5) ; le serveur reste la reference
 * (400 PARAMETRES_INVALIDES avec le detail ; 409 VALEUR_UTILISEE : desactiver plutot que retirer). Chaque ecriture vaut approbation (version +1).
 */
const libelleFamille = (f: string) => (f in STYLE_RESEAU ? STYLE_RESEAU[f as TypeReseau].libelle : f);

export function OngletReferentiels({ enLigne }: { enLigne: boolean }) {
  const id = useId();
  const [domaine, setDomaine] = useState<DomaineReferentiel>("TYPE_RESEAU");
  const valeurs = useReferentiel(domaine, true, true);
  const modifier = useModifierValeur(domaine);
  const [creation, setCreation] = useState(false);
  const [edition, setEdition] = useState<ValeurReferentiel | null>(null);
  const [retrait, setRetrait] = useState<ValeurReferentiel | null>(null);
  const [bascule, setBascule] = useState<ValeurReferentiel | null>(null);
  const [annonce, setAnnonce] = useState<string | null>(null);

  return (
    <section aria-labelledby="pv-titre-referentiels" className="space-y-3">
      <div>
        <h2 id="pv-titre-referentiels" className="flex items-center gap-1 text-base font-semibold text-navy"><ListChecks aria-hidden="true" className="h-4 w-4" />Référentiels</h2>
        <p className="text-xs text-gray-700">Les listes de choix du module se chargent d&apos;ici. Une valeur désactivée reste lisible sur les objets qui la portent, mais n&apos;est plus proposée ; une valeur portée par un objet ne se retire pas.</p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[16rem]">
          <label htmlFor={`${id}-domaine`} className={LIBELLE_CHAMP}>Domaine</label>
          <Select id={`${id}-domaine`} value={domaine} onChange={(e) => { setDomaine(e.target.value as DomaineReferentiel); setAnnonce(null); }} className="mt-1 border-gray-300">
            {DOMAINES_REFERENTIEL.map((d) => <option key={d} value={d}>{LIBELLE_DOMAINE[d]}</option>)}
          </Select>
        </div>
        <Button type="button" className="min-h-[44px] xl:min-h-9" disabled={!enLigne} onClick={() => setCreation(true)}><Plus aria-hidden="true" /> Nouvelle valeur</Button>
      </div>
      <p className="text-xs text-gray-700">{AIDE_DOMAINE[domaine]}</p>
      {annonce && <p role="status" className="rounded border border-green-300 bg-green-50 p-2 text-xs text-green-950">{annonce}</p>}
      {valeurs.isPending && <EtatChargement libelle="Chargement des valeurs…" />}
      {valeurs.isError && <EtatErreur erreur={classerErreurTerritoires(valeurs.error)} sujet={LIBELLE_DOMAINE[domaine]} onReessayer={() => void valeurs.refetch()} enCours={valeurs.isFetching} />}
      {valeurs.isSuccess && valeurs.data.valeurs.length === 0 && <EtatVide titre="Aucune valeur dans ce domaine"><p>Créez la première avec « Nouvelle valeur ».</p></EtatVide>}
      {valeurs.isSuccess && valeurs.data.ignores > 0 && <p className="text-xs text-amber-900">{valeurs.data.ignores} valeur(s) illisible(s) écartée(s) de l&apos;affichage.</p>}
      {valeurs.isSuccess && valeurs.data.valeurs.length > 0 && (
        <div role="region" aria-label={`${LIBELLE_DOMAINE[domaine]}, tableau défilant`} tabIndex={0} className="overflow-x-auto rounded border border-gray-200">
          <table className="w-full min-w-[720px] border-collapse text-left text-xs">
            <caption className="sr-only">{LIBELLE_DOMAINE[domaine]}</caption>
            <thead className="bg-gray-100 text-gray-800">
              <tr>
                <th scope="col" className="px-2 py-1 font-semibold">Libellé</th>
                <th scope="col" className="px-2 py-1 font-semibold">Paramètres</th>
                <th scope="col" className="px-2 py-1 font-semibold">État</th>
                <th scope="col" className="px-2 py-1 font-semibold">Version</th>
                <th scope="col" className="px-2 py-1 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {valeurs.data.valeurs.map((v) => (
                <tr key={v.id} className="border-t border-gray-200 align-top">
                  <th scope="row" className="px-2 py-1 text-left font-normal"><span className="font-semibold text-gray-900">{v.libelle}</span><span className="block text-gray-700">{v.code} · ordre {v.ordre}</span></th>
                  <td className="px-2 py-1">{resumeParametres(domaine, v.parametres, libelleFamille)}</td>
                  <td className="px-2 py-1">{v.actif ? <span className="font-semibold text-green-900">Active</span> : <span className="font-semibold text-amber-900">Désactivée</span>}</td>
                  <td className="px-2 py-1">v{v.version}{v.systeme ? " (système)" : v.approuvePar ? ` par ${v.approuvePar.nomComplet}` : ""}{v.approuveLe ? `, ${formaterDate(v.approuveLe)}` : ""}</td>
                  <td className="px-2 py-1">
                    <div className="flex flex-wrap gap-1">
                      <Button type="button" size="sm" variant="outline" className="min-h-[44px] xl:min-h-8" disabled={!enLigne} onClick={() => setEdition(v)}><PenLine aria-hidden="true" /> Modifier<span className="sr-only"> {v.libelle}</span></Button>
                      <Button type="button" size="sm" variant="outline" className="min-h-[44px] xl:min-h-8" disabled={!enLigne} onClick={() => setBascule(v)}><Power aria-hidden="true" /> {v.actif ? "Désactiver" : "Réactiver"}<span className="sr-only"> {v.libelle}</span></Button>
                      <Button type="button" size="sm" variant="ghost" className="min-h-[44px] text-red-800 xl:min-h-8" disabled={!enLigne} onClick={() => setRetrait(v)}><Trash2 aria-hidden="true" /> Retirer<span className="sr-only"> {v.libelle}</span></Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creation && <DialogueValeur domaine={domaine} valeur={null} enLigne={enLigne} onFermer={() => setCreation(false)} onFait={(l) => setAnnonce(`Valeur « ${l} » créée.`)} />}
      {edition && <DialogueValeur domaine={domaine} valeur={edition} enLigne={enLigne} onFermer={() => setEdition(null)} onFait={(l) => setAnnonce(`Valeur « ${l} » modifiée.`)} />}
      {bascule && (
        <DialogueSimple
          titre={bascule.actif ? `Désactiver « ${bascule.libelle} » ?` : `Réactiver « ${bascule.libelle} » ?`}
          texte={bascule.actif ? "Elle restera lisible sur les objets qui la portent, mais ne sera plus proposée pour une nouvelle saisie." : "Elle sera de nouveau proposée dans les listes de choix."}
          libelle={bascule.actif ? "Désactiver" : "Réactiver"} enLigne={enLigne} onFermer={() => setBascule(null)}
          action={async () => { await modifier.mutateAsync({ code: bascule.code, corps: { actif: !bascule.actif } }); setAnnonce(`Valeur « ${bascule.libelle} » ${bascule.actif ? "désactivée" : "réactivée"}.`); }}
        />
      )}
      {retrait && <DialogueRetraitValeur domaine={domaine} valeur={retrait} enLigne={enLigne} onFermer={() => setRetrait(null)} onFait={(l) => setAnnonce(`Valeur « ${l} » retirée (retrait logique).`)} />}
    </section>
  );
}

function DialogueSimple({ titre, texte, libelle, enLigne, onFermer, action }: { titre: string; texte: string; libelle: string; enLigne: boolean; onFermer: () => void; action: () => Promise<void> }) {
  const { enCours, erreur, envoyer } = useEnvoiDialogue(onFermer, classerErreurTerritoires);
  return (
    <CadreDialogue titre={titre} description={<p>{texte}</p>} enCours={enCours} erreur={erreur} peutValider libelleValider={libelle} libelleEnCours="Enregistrement…" onFermer={onFermer} onValider={() => void envoyer(action)} enLigne={enLigne}>
      <span className="sr-only">Confirmation</span>
    </CadreDialogue>
  );
}

function DialogueRetraitValeur({ domaine, valeur, enLigne, onFermer, onFait }: { domaine: DomaineReferentiel; valeur: ValeurReferentiel; enLigne: boolean; onFermer: () => void; onFait: (l: string) => void }) {
  const retirer = useRetirerValeur(domaine);
  const modifier = useModifierValeur(domaine);
  const { enCours, erreur, envoyer } = useEnvoiDialogue(onFermer, classerErreurTerritoires);
  const utilisee = erreur?.code === "VALEUR_UTILISEE";
  return (
    <CadreDialogue
      titre={utilisee ? `Désactiver « ${valeur.libelle} » plutôt ?` : `Retirer « ${valeur.libelle} » ?`}
      description={<p>Retrait logique : la valeur reste dans l&apos;historique. Une valeur portée par un jeu, un concessionnaire ou un projet ne se retire pas : désactivez-la.</p>}
      enCours={enCours} erreur={erreur} peutValider libelleValider={utilisee ? "Désactiver la valeur" : "Retirer la valeur"} libelleEnCours="Enregistrement…"
      onFermer={onFermer} enLigne={enLigne}
      onValider={() => void envoyer(async () => {
        if (utilisee) { await modifier.mutateAsync({ code: valeur.code, corps: { actif: false } }); onFait(valeur.libelle); return; }
        await retirer.mutateAsync(valeur.code); onFait(valeur.libelle);
      })}
    >
      <span className="sr-only">Confirmation</span>
    </CadreDialogue>
  );
}

function ChampsParametres({ id, domaine, p, maj, desactive }: { id: string; domaine: DomaineReferentiel; p: SaisieParametres; maj: (x: Partial<SaisieParametres>) => void; desactive: boolean }) {
  if (domaine === "TYPE_RESEAU") return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div>
        <label htmlFor={`${id}-famille`} className={LIBELLE_CHAMP}>Famille technique</label>
        <Select id={`${id}-famille`} value={p.famille} onChange={(e) => maj({ famille: e.target.value })} disabled={desactive} className="mt-1 border-gray-300">
          <option value="">Choisir une famille</option>
          {FAMILLES_TECHNIQUES.map((f) => <option key={f} value={f}>{libelleFamille(f)}</option>)}
        </Select>
        <p className="mt-0.5 text-xs text-gray-700">La famille porte les règles de conflit et le motif de trait sur la carte.</p>
      </div>
      <div>
        <label htmlFor={`${id}-couleur`} className={LIBELLE_CHAMP}>Couleur (facultatif, #rrggbb)</label>
        <Input id={`${id}-couleur`} value={p.couleur} onChange={(e) => maj({ couleur: e.target.value })} maxLength={7} autoComplete="off" disabled={desactive} className="mt-1 border-gray-300" />
      </div>
    </div>
  );
  if (domaine === "CATEGORIE_PROJET") return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div>
        <label htmlFor={`${id}-emp`} className={LIBELLE_CHAMP}>Largeur d&apos;emprise (m)</label>
        <Input id={`${id}-emp`} inputMode="decimal" value={p.largeurEmpriseM} onChange={(e) => maj({ largeurEmpriseM: e.target.value })} autoComplete="off" disabled={desactive} className="mt-1 border-gray-300" />
      </div>
      <div>
        <label htmlFor={`${id}-ch`} className={LIBELLE_CHAMP}>Largeur de chaussée (m)</label>
        <Input id={`${id}-ch`} inputMode="decimal" value={p.largeurChausseeM} onChange={(e) => maj({ largeurChausseeM: e.target.value })} autoComplete="off" disabled={desactive} className="mt-1 border-gray-300" />
      </div>
    </div>
  );
  if (domaine === "TYPE_DOCUMENT") return (
    <fieldset className="space-y-1 rounded border border-gray-200 p-2">
      <legend className="px-1 text-sm font-medium text-gray-900">Document</legend>
      <label className="flex min-h-[44px] items-center gap-2 text-sm text-gray-900 xl:min-h-0"><input type="checkbox" className="h-4 w-4" checked={p.obligatoire} disabled={desactive} onChange={(e) => maj({ obligatoire: e.target.checked })} />Pièce obligatoire du dossier</label>
      <p className="text-xs text-gray-800">Fonctions qu&apos;il débloque :</p>
      {FONCTIONS_DEBLOQUABLES.map((f) => (
        <label key={f} className="flex min-h-[44px] items-center gap-2 text-sm text-gray-900 xl:min-h-0">
          <input type="checkbox" className="h-4 w-4" checked={p.fonctionsDebloquees.includes(f)} disabled={desactive}
            onChange={(e) => maj({ fonctionsDebloquees: e.target.checked ? [...p.fonctionsDebloquees, f] : p.fonctionsDebloquees.filter((x) => x !== f) })} />{LIBELLE_FONCTION[f]}
        </label>
      ))}
    </fieldset>
  );
  if (domaine === "METHODE_ACQUISITION") return (
    <div>
      <label htmlFor={`${id}-prec`} className={LIBELLE_CHAMP}>Précision typique (m, facultatif)</label>
      <Input id={`${id}-prec`} inputMode="decimal" value={p.precisionTypiqueM} onChange={(e) => maj({ precisionTypiqueM: e.target.value })} autoComplete="off" disabled={desactive} className="mt-1 border-gray-300" />
      <p className="mt-0.5 text-xs text-gray-700">Laissez vide si elle n&apos;est pas établie : aucune précision n&apos;est inventée.</p>
    </div>
  );
  return (
    <div>
      <label htmlFor={`${id}-desc`} className={LIBELLE_CHAMP}>Description (facultatif)</label>
      <textarea id={`${id}-desc`} value={p.description} onChange={(e) => maj({ description: e.target.value })} rows={2} maxLength={500} disabled={desactive} className={CHAMP_TEXTE} />
    </div>
  );
}

function DialogueValeur({ domaine, valeur, enLigne, onFermer, onFait }: { domaine: DomaineReferentiel; valeur: ValeurReferentiel | null; enLigne: boolean; onFermer: () => void; onFait: (l: string) => void }) {
  const id = useId();
  const creer = useCreerValeur(domaine);
  const modifier = useModifierValeur(domaine);
  const [v, setV] = useState({ code: valeur?.code ?? "", libelle: valeur?.libelle ?? "", ordre: String(valeur?.ordre ?? ""), actif: valeur?.actif ?? true });
  const [p, setP] = useState<SaisieParametres>(() => (valeur ? saisieDepuisParametres(domaine, valeur.parametres) : { ...SAISIE_PARAMETRES_VIDE }));
  const { enCours, erreur, envoyer } = useEnvoiDialogue(onFermer, classerErreurTerritoires);
  const params = construireParametres(domaine, p);
  const ordre = v.ordre.trim() === "" ? undefined : Number(v.ordre);
  const code = v.code.trim().toUpperCase();
  const erreurs = [
    ...(!valeur && !MOTIF_CODE.test(code) ? ["Code : 2 à 64 caractères, majuscules, chiffres, tiret ou souligné (il ne changera plus)."] : []),
    ...(!v.libelle.trim() ? ["Saisissez le libellé."] : []),
    ...(ordre !== undefined && (!Number.isInteger(ordre) || ordre < 0 || ordre > 100_000) ? ["L'ordre d'affichage est un entier de 0 à 100 000."] : []),
    ...params.erreurs,
  ];
  function valider() {
    if (!params.parametres) return;
    const parametres = params.parametres;
    void envoyer(async () => {
      if (valeur) await modifier.mutateAsync({ code: valeur.code, corps: { libelle: v.libelle.trim(), ...(ordre !== undefined ? { ordre } : {}), actif: v.actif, parametres } });
      else await creer.mutateAsync({ code, libelle: v.libelle.trim(), ...(ordre !== undefined ? { ordre } : {}), actif: v.actif, parametres });
      onFait(v.libelle.trim());
    });
  }
  return (
    <CadreDialogue
      titre={valeur ? `Modifier « ${valeur.libelle} »` : `Nouvelle valeur : ${LIBELLE_DOMAINE[domaine]}`}
      description={<p>{valeur ? `Code ${valeur.code} (définitif). ` : ""}L&apos;enregistrement vaut approbation : nouvelle version, historisée et auditée.</p>}
      enCours={enCours} erreur={erreur} peutValider={erreurs.length === 0} aide={erreurs} libelleValider="Enregistrer" libelleEnCours="Enregistrement…"
      onFermer={onFermer} onValider={valider} enLigne={enLigne} large
    >
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem]">
        {!valeur && (
          <div className="sm:col-span-2">
            <label htmlFor={`${id}-code`} className={LIBELLE_CHAMP}>Code</label>
            <Input id={`${id}-code`} value={v.code} onChange={(e) => setV({ ...v, code: e.target.value })} maxLength={64} autoComplete="off" disabled={enCours} className="mt-1 border-gray-300 uppercase" />
          </div>
        )}
        <div>
          <label htmlFor={`${id}-lib`} className={LIBELLE_CHAMP}>Libellé</label>
          <Input id={`${id}-lib`} value={v.libelle} onChange={(e) => setV({ ...v, libelle: e.target.value })} maxLength={200} autoComplete="off" disabled={enCours} className="mt-1 border-gray-300" />
        </div>
        <div>
          <label htmlFor={`${id}-ordre`} className={LIBELLE_CHAMP}>Ordre</label>
          <Input id={`${id}-ordre`} inputMode="numeric" value={v.ordre} onChange={(e) => setV({ ...v, ordre: e.target.value })} maxLength={6} autoComplete="off" disabled={enCours} className="mt-1 border-gray-300" />
        </div>
      </div>
      <label className="flex min-h-[44px] items-center gap-2 text-sm text-gray-900 xl:min-h-0"><input type="checkbox" className="h-4 w-4" checked={v.actif} disabled={enCours} onChange={(e) => setV({ ...v, actif: e.target.checked })} />Active (proposée dans les listes de choix)</label>
      <ChampsParametres id={id} domaine={domaine} p={p} maj={(x) => setP((y) => ({ ...y, ...x }))} desactive={enCours} />
    </CadreDialogue>
  );
}
