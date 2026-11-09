import { useId, useState } from "react";
import { PenLine, ServerCog, Settings } from "lucide-react";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Input";
import { CadreDialogue, CHAMP_TEXTE, Compteur, LIBELLE_CHAMP, useEnvoiDialogue } from "../CadreDialogue";
import { EtatChargement, EtatErreur } from "../EtatsPv";
import { useConfiguration, useEcrireConfiguration } from "../../../lib/projetsVoirieTerritoiresHooks";
import { formaterDate } from "../../../lib/projetsVoirie";
import { justificationValide } from "../../../lib/projetsVoirieConflits";
import {
  AIDE_CLE, AIDE_SOURCE, LIBELLE_CLE, LIBELLE_PROTECTION, LIBELLE_SOURCE, classerErreurTerritoires, enveloppeEnv, resumeValeurConfiguration, saisieDepuisValeur, valeurDepuisSaisie,
  type EntreeConfiguration, type SaisieConfiguration, type SourceConfiguration,
} from "../../../lib/projetsVoirieTerritoires";

/**
 * Configuration nationale du module (lot T1) : LECTURE pour tout compte du module, ECRITURE pour l'ADMIN seul, avec justification.
 * Chaque valeur dit sa SOURCE effective : variable d'environnement (ENV, elle l'emporte toujours), base (BASE) ou defaut du code (DEFAUT).
 * Le serveur reste la reference (schema, liste blanche, CRS connus de PostGIS).
 */
export function OngletConfiguration({ estAdmin, enLigne }: { estAdmin: boolean; enLigne: boolean }) {
  const config = useConfiguration(true);
  const [edition, setEdition] = useState<EntreeConfiguration | null>(null);
  const [annonce, setAnnonce] = useState<string | null>(null);
  return (
    <section aria-labelledby="pv-titre-configuration" className="space-y-3">
      <div>
        <h2 id="pv-titre-configuration" className="flex items-center gap-1 text-base font-semibold text-navy"><Settings aria-hidden="true" className="h-4 w-4" />Configuration nationale</h2>
        <p className="text-xs text-gray-700">Ordre de priorité : une variable d&apos;environnement du serveur l&apos;emporte toujours, puis la valeur enregistrée ici, puis la valeur par défaut du code.{estAdmin ? "" : " Seul un administrateur peut modifier ces valeurs."}</p>
      </div>
      {annonce && <p role="status" className="rounded border border-green-300 bg-green-50 p-2 text-xs text-green-950">{annonce}</p>}
      {config.isPending && <EtatChargement libelle="Chargement de la configuration…" />}
      {config.isError && <EtatErreur erreur={classerErreurTerritoires(config.error)} sujet="Configuration" onReessayer={() => void config.refetch()} enCours={config.isFetching} />}
      {config.data?.configuration.map((e) => (
        <article key={e.cle} aria-labelledby={`pv-cfg-${e.cle}`} className="space-y-1 rounded-md border border-gray-200 p-3 text-xs text-gray-900">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h3 id={`pv-cfg-${e.cle}`} className="text-sm font-semibold text-gray-900">{LIBELLE_CLE[e.cle] ?? e.cle}</h3>
            {estAdmin && (
              <Button type="button" size="sm" variant="outline" className="min-h-[44px] xl:min-h-8" disabled={!enLigne} onClick={() => setEdition(e)}>
                <PenLine aria-hidden="true" /> Modifier<span className="sr-only"> {LIBELLE_CLE[e.cle] ?? e.cle}</span>
              </Button>
            )}
          </div>
          {AIDE_CLE[e.cle] && <p className="text-gray-700">{AIDE_CLE[e.cle]}</p>}
          <p><span className="font-semibold">Valeur en vigueur : </span>{resumeValeurConfiguration(e.cle, e.valeur)}</p>
          <Sources e={e} />
          <p className="text-gray-700">
            {e.version > 0 ? `Version ${e.version}${e.approuvePar ? `, enregistrée par ${e.approuvePar.nomComplet}` : ""}${e.approuveLe ? ` le ${formaterDate(e.approuveLe)}` : ""}${e.justification ? ` : « ${e.justification} »` : ""}.` : "Jamais enregistrée en base."}
          </p>
        </article>
      ))}
      {config.data && config.data.ignores > 0 && <p className="text-xs text-amber-900">{config.data.ignores} clé(s) illisible(s) écartée(s) de l&apos;affichage.</p>}
      {edition && <DialogueConfiguration entree={edition} enLigne={enLigne} onFermer={() => setEdition(null)} onFait={() => setAnnonce(`« ${LIBELLE_CLE[edition.cle] ?? edition.cle} » enregistrée.`)} />}
    </section>
  );
}

function BadgeSource({ s }: { s: SourceConfiguration }) {
  const c = s === "ENV" ? "border-navy bg-blue-50 text-blue-950" : s === "BASE" ? "border-green-700 bg-green-50 text-green-950" : "border-gray-500 bg-gray-50 text-gray-900";
  return <span data-source={s} className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-semibold ${c}`}>{s === "ENV" && <ServerCog aria-hidden="true" className="h-3 w-3" />}{LIBELLE_SOURCE[s]}</span>;
}

function Sources({ e }: { e: EntreeConfiguration }) {
  const env = Array.isArray(e.variableEnvironnement) ? e.variableEnvironnement.join(", ") : e.variableEnvironnement;
  if (typeof e.source === "string") {
    return (
      <div className="space-y-0.5">
        <p className="flex flex-wrap items-center gap-1"><span className="font-semibold">Source :</span><BadgeSource s={e.source} /></p>
        <p className="text-gray-700">{AIDE_SOURCE[e.source]}{e.source === "ENV" && env ? ` Variable : ${env}.` : ""}</p>
        {e.source !== "ENV" && env && <p className="text-gray-700">Si la variable {env} est définie sur le serveur, elle l&apos;emportera.</p>}
      </div>
    );
  }
  return (
    <div className="space-y-0.5">
      <p className="font-semibold">Source de chaque valeur :</p>
      <ul className="space-y-0.5">
        {Object.entries(e.source).map(([k, s]) => <li key={k} className="flex flex-wrap items-center gap-1">{LIBELLE_PROTECTION[k] ?? k} : <BadgeSource s={s} /></li>)}
      </ul>
      {enveloppeEnv(e) && <p className="text-gray-700">{AIDE_SOURCE.ENV}</p>}
    </div>
  );
}

function DialogueConfiguration({ entree, enLigne, onFermer, onFait }: { entree: EntreeConfiguration; enLigne: boolean; onFermer: () => void; onFait: () => void }) {
  const id = useId();
  const ecrire = useEcrireConfiguration();
  // On part de la valeur EN BASE si elle existe, sinon de la valeur en vigueur (une variable d'environnement n'est pas recopiee en base a l'insu de l'administrateur).
  // Protections : seules les valeurs deja en base sont reprises (une case vide = defaut du serveur).
  const [s, setS] = useState<SaisieConfiguration>(() => saisieDepuisValeur(entree.cle, entree.cle === "PROTECTIONS"
    ? entree.valeurBase ?? {}
    : entree.valeurBase ?? (enveloppeEnv(entree) ? entree.valeurDefaut : entree.valeur)));
  const [j, setJ] = useState("");
  const { enCours, erreur, envoyer } = useEnvoiDialogue(onFermer, classerErreurTerritoires);
  const r = valeurDepuisSaisie(entree.cle, s);
  const erreurs = [...r.erreurs, ...(!justificationValide(j) ? ["Une justification de 10 caractères au moins est obligatoire."] : [])];
  const maj = (p: Partial<SaisieConfiguration>) => setS((x) => ({ ...x, ...p }));
  const champ = (cle: "nom" | "ouest" | "sud" | "est" | "nord" | "epsgDefaut" | "epsg", libelle: string, mode?: "decimal" | "numeric") => (
    <div>
      <label htmlFor={`${id}-${cle}`} className={LIBELLE_CHAMP}>{libelle}</label>
      <Input id={`${id}-${cle}`} value={s[cle]} onChange={(e) => maj({ [cle]: e.target.value } as Partial<SaisieConfiguration>)} inputMode={mode} autoComplete="off" disabled={enCours} className="mt-1 border-gray-300" />
    </div>
  );
  return (
    <CadreDialogue
      titre={`Modifier : ${LIBELLE_CLE[entree.cle] ?? entree.cle}`}
      description={<>
        {AIDE_CLE[entree.cle] && <p>{AIDE_CLE[entree.cle]}</p>}
        {enveloppeEnv(entree) && <p className="font-semibold text-amber-900">{AIDE_SOURCE.ENV}</p>}
        <p>L&apos;enregistrement vaut approbation : nouvelle version, historisée et auditée, prise en compte par le serveur au plus tard après sa fenêtre de rafraîchissement.</p>
      </>}
      enCours={enCours} erreur={erreur} peutValider={erreurs.length === 0 && r.valeur !== null} aide={erreurs} libelleValider="Enregistrer" libelleEnCours="Enregistrement…"
      onFermer={onFermer} onValider={() => { if (r.valeur) { const valeur = r.valeur; void envoyer(async () => { await ecrire.mutateAsync({ cle: entree.cle, valeur, justification: j.trim() }); onFait(); }); } }}
      enLigne={enLigne} large
    >
      {entree.cle === "EMPRISE_PLAUSIBILITE" && (
        <>
          {champ("nom", "Nom de l'emprise")}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{champ("ouest", "Ouest", "decimal")}{champ("sud", "Sud", "decimal")}{champ("est", "Est", "decimal")}{champ("nord", "Nord", "decimal")}</div>
        </>
      )}
      {entree.cle === "CRS_METRIQUE_BANDES" && (
        <>
          <div>
            <label htmlFor={`${id}-bandes`} className={LIBELLE_CHAMP}>Bandes, une par ligne : « longitude ; code EPSG »</label>
            <textarea id={`${id}-bandes`} value={s.bandes} onChange={(e) => maj({ bandes: e.target.value })} rows={4} spellCheck={false} disabled={enCours} aria-describedby={`${id}-bandes-aide`} className={`${CHAMP_TEXTE} font-mono text-xs`} />
            <p id={`${id}-bandes-aide`} className="text-xs text-gray-700">Un projet dont la longitude est inférieure à la longitude d&apos;une bande prend son code ; les bandes sont triées par longitude croissante.</p>
          </div>
          {champ("epsgDefaut", "Code EPSG au-delà de la dernière bande", "numeric")}
        </>
      )}
      {entree.cle === "CRS_IMPORT_LISTE_BLANCHE" && champ("epsg", "Codes EPSG admis, séparés par des virgules (4326 obligatoire)")}
      {entree.cle === "PROTECTIONS" && (
        <div className="grid gap-2 sm:grid-cols-2">
          {Object.keys(LIBELLE_PROTECTION).map((k) => (
            <div key={k}>
              <label htmlFor={`${id}-p-${k}`} className={LIBELLE_CHAMP}>{LIBELLE_PROTECTION[k]}</label>
              <Input id={`${id}-p-${k}`} inputMode="numeric" value={s.protections[k] ?? ""} onChange={(e) => maj({ protections: { ...s.protections, [k]: e.target.value } })} autoComplete="off" disabled={enCours} className="mt-1 border-gray-300" />
            </div>
          ))}
          <p className="text-xs text-gray-700 sm:col-span-2">Une case vide n&apos;est pas enregistrée : la valeur par défaut du serveur s&apos;applique.</p>
        </div>
      )}
      {!["EMPRISE_PLAUSIBILITE", "CRS_METRIQUE_BANDES", "CRS_IMPORT_LISTE_BLANCHE", "PROTECTIONS"].includes(entree.cle) && (
        <div>
          <label htmlFor={`${id}-json`} className={LIBELLE_CHAMP}>Valeur (JSON)</label>
          <textarea id={`${id}-json`} value={s.json} onChange={(e) => maj({ json: e.target.value })} rows={6} spellCheck={false} disabled={enCours} className={`${CHAMP_TEXTE} font-mono text-xs`} />
        </div>
      )}
      <div>
        <label htmlFor={`${id}-j`} className={LIBELLE_CHAMP}>Justification (10 caractères minimum)</label>
        <textarea id={`${id}-j`} value={j} onChange={(e) => setJ(e.target.value)} rows={2} maxLength={2000} disabled={enCours} aria-describedby={`${id}-jn`} className={CHAMP_TEXTE} />
        <Compteur id={`${id}-jn`} texte={j} />
      </div>
    </CadreDialogue>
  );
}
