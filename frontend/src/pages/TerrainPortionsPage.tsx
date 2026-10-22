import { useCallback, useEffect, useRef, useState } from "react";
import { aujourdhui } from "../lib/curseur";
import { AlertTriangle, Crosshair, MapPin, Scissors, TrendingDown, TrendingUp } from "lucide-react";
import { api } from "../lib/api";
import { toast } from "../lib/toast";
import { Button } from "../components/ui/Button";
import { usePositionGps } from "../hooks/usePositionGps";
import { useAuth } from "../lib/auth";
import { addPendingPortion } from "../lib/offlineDb";
import { refreshPendingCount, syncPendingOfflineData } from "../lib/offlineSync";
import { useOfflineSync } from "../hooks/useOfflineSync";

/**
 * Mode terrain : qualifier la portion où je me trouve.
 *
 * CE QUE CET ÉCRAN REFUSE D'AFFICHER
 *
 * Il ne montre jamais une certitude que le serveur n'a pas donnée. Quatre absences
 * possibles, et chacune appelle un geste différent :
 *
 *   le GPS ne tranche pas        attendre une meilleure précision
 *   tronçon jamais inventorié    commencer l'inventaire
 *   trou dans l'inventaire       le compléter, à l'abscisse nommée
 *   ambiguïté signalée           choisir, au lieu de subir un choix
 *
 * Les confondre enverrait l'agent faire le mauvais geste, et c'est le seul vrai risque de
 * cet écran : une page qui affiche « RN1, bitume, bon état » alors que rien n'est sûr fait
 * qualifier une route sur laquelle l'agent n'est peut-être pas.
 *
 * TOUT CE QUI EST SAISI ICI EST UNE PROPOSITION
 *
 * Le bandeau le dit, et le serveur l'impose : une portion sort en `A_VALIDER` et un
 * `statutValidation` envoyé d'ici serait ignoré. L'écran ne prétend donc pas écrire dans
 * le référentiel officiel.
 *
 * LA SAISIE SE FAIT À L'ARRÊT
 *
 * Aucun geste n'est chronométré, aucune action ne se déclenche au défilement de la carte,
 * et le relevé se confirme par un bouton. Le §6 du cahier l'exige : on ne demande jamais
 * au conducteur de manipuler le téléphone en roulant.
 */

interface Portion {
  id: string;
  debutM: number;
  finM: number;
  revetement: string | null;
  etat: string | null;
  praticabilite: string | null;
  statutValidation: string;
  observeeLe: string | null;
  source: string | null;
}

interface Trou { debutM: number; finM: number; longueurM: number }

interface Contexte {
  troncon: {
    tronconId: string; code: string; nom: string | null; classe: string;
    abscisseM: number; pk: number | null; pkMotif: string;
    confiance: number; distanceM: number;
  } | null;
  motifSansTroncon: string | null;
  portion: Portion | null;
  motifSansPortion: string | null;
  couverture: { longueurTronconM: number; qualifieM: number; part: number; trous: Trou[] } | null;
  actifsProches: { id: string; type: string; nom: string | null; distanceM: number; etat: string | null }[];
  ambigu: boolean;
}

interface ValeurRef { code: string; libelle: string; actif: boolean }
interface Referentiels {
  revetements: ValeurRef[];
  etats: ValeurRef[];
  praticabilites: ValeurRef[];
  praticabiliteNonDefinie: boolean;
}

/**
 * Délai avant d'interroger le serveur après un déplacement, en millisecondes.
 *
 * Le GPS rend un point par seconde ; appeler le contexte à chaque point ferait une requête
 * par seconde pour un agent immobile dont la position oscille de trois mètres. Deux
 * secondes suffisent à ce que l'écran suive l'agent sans harceler la base.
 */
const DELAI_CONTEXTE_MS = 2_000;

/** Déplacement sous lequel on ne redemande pas le contexte. */
const DEPLACEMENT_MINIMAL_M = 15;

function metres(v: number): string {
  return v >= 1_000 ? `${(v / 1_000).toFixed(2)} km` : `${Math.round(v)} m`;
}

/** Distance approximative en mètres, suffisante pour décider s'il faut réinterroger. */
function ecartM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = (a.lat - b.lat) * 111_320;
  const dLon = (a.lon - b.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

export function TerrainPortionsPage() {
  const gps = usePositionGps();
  const { user } = useAuth();
  const { pendingCount, syncing } = useOfflineSync();
  const [contexte, setContexte] = useState<Contexte | null>(null);
  const [chargement, setChargement] = useState(false);
  const [refs, setRefs] = useState<Referentiels | null>(null);
  const [revetement, setRevetement] = useState("");
  const [etat, setEtat] = useState("");
  const [praticabilite, setPraticabilite] = useState("");
  const [longueurM, setLongueurM] = useState("1000");
  const [valideDu, setValideDu] = useState("");
  const [envoi, setEnvoi] = useState(false);
  const derniereInterrogee = useRef<{ lat: number; lon: number } | null>(null);

  useEffect(() => {
    api.get("/v2/referentiels")
      .then((r) => setRefs(r.data))
      .catch(() => toast.error("Vocabulaires indisponibles : impossible de qualifier hors ligne pour l'instant."));
  }, []);

  const interroger = useCallback(async (lat: number, lon: number, precisionM: number) => {
    setChargement(true);
    try {
      const r = await api.get("/v2/field/current-context", { params: { lat, lon, precisionM } });
      setContexte(r.data);
      derniereInterrogee.current = { lat, lon };
    } catch {
      toast.error("Contexte indisponible. La position brute reste conservée.");
    } finally {
      setChargement(false);
    }
  }, []);

  // Réinterroge quand l'agent s'est réellement déplacé, pas à chaque oscillation du GPS.
  useEffect(() => {
    const p = gps.position;
    if (!p) return;
    const precedente = derniereInterrogee.current;
    if (precedente && ecartM(precedente, p) < DEPLACEMENT_MINIMAL_M) return;
    const t = setTimeout(() => void interroger(p.lat, p.lon, p.precisionM), DELAI_CONTEXTE_MS);
    return () => clearTimeout(t);
  }, [gps.position, interroger]);

  async function qualifier() {
    const p = gps.position;
    const t = contexte?.troncon;
    if (!p || !t) return;
    const longueur = Number(longueurM);
    if (!Number.isFinite(longueur) || longueur < 10) {
      toast.error("Longueur invalide : au moins dix mètres.");
      return;
    }
    setEnvoi(true);
    /**
     * La CLÉ D'IDEMPOTENCE est forgée une seule fois, avant de savoir si l'on est en ligne.
     *
     * C'est ce qui permet au même relevé de partir maintenant ou plus tard sans jamais
     * produire deux portions. La forger après avoir constaté la coupure aurait créé une clé
     * différente par chemin, et un envoi en ligne qui échoue au dernier moment puis se
     * rejoue hors ligne aurait abouti à un doublon.
     */
    const localId = `portion-${t.tronconId}-${Math.round(t.abscisseM)}-${Date.now()}`;
    const payload = {
      tronconId: t.tronconId,
      debutM: t.abscisseM,
      finM: t.abscisseM + longueur,
      revetement: revetement || null,
      etat: etat || null,
      praticabilite: praticabilite || null,
      source: `terrain:${t.code}`,
      observeeLe: new Date().toISOString(),
      // Date d'effet : saisie par l'agent, JAMAIS deduite de la date du releve (`observeeLe`) :
      // une piste relevee aujourd'hui peut etre en laterite depuis l'an dernier. Vide = inconnue.
      valideDu: valideDu || null,
      // La confiance de la PORTION suit celle du rattachement : qualifier depuis un
      // appariement douteux ne produit pas une observation sûre.
      confiance: (t.confiance >= 0.8 ? "HIGH" : t.confiance >= 0.5 ? "MEDIUM" : "LOW") as
        "HIGH" | "MEDIUM" | "LOW",
    };

    async function mettreEnFile(raison: string) {
      await addPendingPortion({
        localId,
        ownerUserId: user?.id,
        payload,
        createdAt: new Date().toISOString(),
        status: "pending",
      });
      await refreshPendingCount();
      toast.success(`${raison} Relevé conservé sur l'appareil, il partira au retour du réseau.`);
    }

    try {
      if (!navigator.onLine) {
        // Hors ligne : on ne tente même pas. Une requête qui expire ferait attendre l'agent
        // dix secondes pour rien, et il est en bord de route.
        await mettreEnFile("Hors ligne.");
        return;
      }
      await api.post("/v2/portions", { ...payload, clientOperationId: localId });
      toast.success("Portion proposée. Elle attend la validation d'un tiers.");
      await interroger(p.lat, p.lon, p.precisionM);
    } catch (e) {
      const r = (e as { response?: { status?: number; data?: { message?: string } } }).response;
      /**
       * UN REFUS DU SERVEUR N'EST PAS UNE PANNE DE RÉSEAU.
       *
       * 409 ou 400 : le serveur a jugé, et le relever à nouveau donnerait le même verdict.
       * Le mettre en file le ferait revenir à chaque retour de réseau sans jamais passer.
       * L'agent doit lire le motif et corriger.
       *
       * Pas de réponse du tout : la requête n'a pas abouti, le relevé est conservé.
       */
      if (r?.status !== undefined) {
        toast.error(r.data?.message ?? "Proposition refusée.");
      } else {
        await mettreEnFile("Réseau indisponible.");
      }
    } finally {
      setEnvoi(false);
    }
  }

  const t = contexte?.troncon;
  const peutQualifier = Boolean(t) && !chargement;

  return (
    <div className="space-y-4 pb-24">
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        <strong>Tout ce qui est saisi ici est une proposition.</strong> Une portion n'entre
        dans le référentiel officiel qu'après validation par un tiers habilité.
      </div>

      {pendingCount > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-lg border bg-slate-50 p-3 text-sm">
          <span>
            <strong>{pendingCount}</strong> relevé(s) en attente sur cet appareil.
            {syncing && " Envoi en cours…"}
          </span>
          <Button variant="outline" onClick={() => void syncPendingOfflineData()} disabled={syncing || !navigator.onLine}>
            Envoyer maintenant
          </Button>
        </div>
      )}

      {/* ── Position ─────────────────────────────────────────────── */}
      <section className="rounded-lg border bg-white p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 font-semibold"><Crosshair className="h-4 w-4" /> Position</h2>
          {gps.actif
            ? <Button variant="outline" onClick={gps.arreter}>Arrêter le suivi</Button>
            : <Button onClick={gps.demarrer}>Me localiser</Button>}
        </div>

        {gps.erreur === "INDISPONIBLE" && (
          <p className="mt-2 text-sm text-red-700">
            Cet appareil n'a pas de géolocalisation. Choisissez un tronçon et une abscisse à la main.
          </p>
        )}
        {gps.erreur === "REFUSEE" && (
          <p className="mt-2 text-sm text-red-700">
            Autorisation refusée. Rouvrez-la dans les réglages du navigateur, puis relancez le suivi.
          </p>
        )}
        {gps.erreur === "INDETERMINEE" && (
          <p className="mt-2 text-sm text-red-700">
            Signal introuvable. Sortez à découvert et attendez quelques secondes.
          </p>
        )}
        {gps.enAttente && <p className="mt-2 text-sm text-slate-600">Recherche du signal…</p>}

        {gps.position && (
          <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
            <dt className="text-slate-500">Latitude</dt>
            <dd>{gps.position.lat.toFixed(6)}</dd>
            <dt className="text-slate-500">Longitude</dt>
            <dd>{gps.position.lon.toFixed(6)}</dd>
            <dt className="text-slate-500">Précision</dt>
            <dd className="flex items-center gap-1">
              {gps.position.precisionM} m
              {gps.tendance === "AMELIORE" && <><TrendingDown className="h-3 w-3 text-green-600" /><span className="text-green-700">s'améliore</span></>}
              {gps.tendance === "DEGRADE" && <><TrendingUp className="h-3 w-3 text-amber-600" /><span className="text-amber-700">se dégrade</span></>}
            </dd>
          </dl>
        )}
      </section>

      {/* ── Tronçon actif ────────────────────────────────────────── */}
      <section className="rounded-lg border bg-white p-4">
        <h2 className="flex items-center gap-2 font-semibold"><MapPin className="h-4 w-4" /> Tronçon actif</h2>

        {contexte?.motifSansTroncon === "AUCUN_CANDIDAT_SUR" && (
          <p className="mt-2 text-sm text-amber-800">
            Aucun tronçon ne peut être désigné avec assez de certitude. Attendez une meilleure
            précision, ou enregistrez une observation sans rattachement : la position brute est conservée.
          </p>
        )}

        {contexte?.ambigu && (
          <p className="mt-2 flex items-start gap-2 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Plusieurs tronçons sont à portée de l'incertitude GPS. Le choix affiché n'est pas sûr :
              vérifiez avant de qualifier.
            </span>
          </p>
        )}

        {t && (
          <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
            <dt className="text-slate-500">Code</dt><dd className="font-mono">{t.code}</dd>
            <dt className="text-slate-500">Nom</dt><dd>{t.nom ?? "—"}</dd>
            <dt className="text-slate-500">Abscisse</dt><dd>{metres(t.abscisseM)}</dd>
            <dt className="text-slate-500">PK</dt>
            <dd>{t.pk !== null ? t.pk.toFixed(3) : <span className="text-slate-500">non calculable sur ce tronçon</span>}</dd>
            <dt className="text-slate-500">Écart au tracé</dt><dd>{Math.round(t.distanceM)} m</dd>
            <dt className="text-slate-500">Confiance</dt><dd>{Math.round(t.confiance * 100)} %</dd>
          </dl>
        )}

        {contexte?.couverture && (
          <p className="mt-3 text-sm text-slate-700">
            Qualifié : {metres(contexte.couverture.qualifieM)} sur {metres(contexte.couverture.longueurTronconM)}
            {" "}({Math.round(contexte.couverture.part * 100)} %).
            {contexte.couverture.trous.length > 0 && (
              <> Non qualifié : {contexte.couverture.trous.map((x) => `${metres(x.debutM)} à ${metres(x.finM)}`).join(", ")}.</>
            )}
          </p>
        )}
      </section>

      {/* ── Portion active ──────────────────────────────────────── */}
      {t && (
        <section className="rounded-lg border bg-white p-4">
          <h2 className="font-semibold">Portion à cet endroit</h2>

          {contexte?.motifSansPortion === "TRONCON_NON_QUALIFIE" && (
            <p className="mt-2 text-sm text-slate-700">
              Ce tronçon n'a <strong>aucune portion</strong>. Rien n'a jamais été inventorié ici :
              votre relevé sera le premier.
            </p>
          )}
          {contexte?.motifSansPortion === "TROU_DE_QUALIFICATION" && (
            <p className="mt-2 text-sm text-slate-700">
              Des portions existent sur ce tronçon, mais <strong>pas à cette abscisse</strong>.
              Vous comblez un trou.
            </p>
          )}
          {contexte?.motifSansPortion === "LONGUEUR_TRONCON_INCONNUE" && (
            <p className="mt-2 text-sm text-amber-800">
              Ce tronçon n'a pas de tracé mesurable : aucune portion ne peut y être bornée.
            </p>
          )}

          {contexte?.portion && (
            <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
              <dt className="text-slate-500">Emprise</dt>
              <dd>{metres(contexte.portion.debutM)} à {metres(contexte.portion.finM)}</dd>
              <dt className="text-slate-500">Revêtement</dt><dd>{contexte.portion.revetement ?? "—"}</dd>
              <dt className="text-slate-500">État</dt><dd>{contexte.portion.etat ?? "—"}</dd>
              <dt className="text-slate-500">Praticabilité</dt><dd>{contexte.portion.praticabilite ?? "—"}</dd>
              <dt className="text-slate-500">Statut</dt>
              <dd>
                {contexte.portion.statutValidation === "VALIDE"
                  ? <span className="text-green-700">Validée, officielle</span>
                  : <span className="text-amber-700">Proposition, non officielle</span>}
              </dd>
            </dl>
          )}
        </section>
      )}

      {/* ── Qualifier ───────────────────────────────────────────── */}
      <section className="rounded-lg border bg-white p-4">
        <h2 className="flex items-center gap-2 font-semibold"><Scissors className="h-4 w-4" /> Qualifier à partir d'ici</h2>

        {!t && <p className="mt-2 text-sm text-slate-600">Localisez-vous pour qualifier une portion.</p>}

        {t && (
          <div className="mt-3 space-y-3">
            <label className="block text-sm">
              <span className="text-slate-600">Longueur de la portion (m)</span>
              <input
                type="number" min={10} step={10} value={longueurM}
                onChange={(e) => setLongueurM(e.target.value)}
                className="mt-1 w-full rounded border px-2 py-1"
                aria-label="Longueur de la portion en mètres"
              />
              <span className="text-xs text-slate-500">
                De {metres(t.abscisseM)} à {metres(t.abscisseM + (Number(longueurM) || 0))}.
              </span>
            </label>

            <label className="block text-sm">
              <span className="text-slate-600">Revêtement</span>
              <select value={revetement} onChange={(e) => setRevetement(e.target.value)}
                className="mt-1 w-full rounded border px-2 py-1" aria-label="Revêtement">
                <option value="">Non relevé</option>
                {(refs?.revetements ?? []).filter((r) => r.actif).map((r) => (
                  <option key={r.code} value={r.code}>{r.libelle}</option>
                ))}
              </select>
            </label>

            <label className="block text-sm">
              <span className="text-slate-600">État de chaussée</span>
              <select value={etat} onChange={(e) => setEtat(e.target.value)}
                className="mt-1 w-full rounded border px-2 py-1" aria-label="État de chaussée">
                <option value="">Non relevé</option>
                {(refs?.etats ?? []).filter((r) => r.actif).map((r) => (
                  <option key={r.code} value={r.code}>{r.libelle}</option>
                ))}
              </select>
            </label>

            <label className="block text-sm">
              <span className="text-slate-600">Praticabilité</span>
              <select value={praticabilite} onChange={(e) => setPraticabilite(e.target.value)}
                disabled={refs?.praticabiliteNonDefinie ?? true}
                className="mt-1 w-full rounded border px-2 py-1 disabled:bg-slate-100" aria-label="Praticabilité">
                <option value="">Non relevé</option>
                {(refs?.praticabilites ?? []).filter((r) => r.actif).map((r) => (
                  <option key={r.code} value={r.code}>{r.libelle}</option>
                ))}
              </select>
              {refs?.praticabiliteNonDefinie && (
                <span className="text-xs text-amber-700">
                  Vocabulaire non défini par AGEROUTE : ce champ reste indisponible, et aucune
                  valeur n'a été inventée.
                </span>
              )}
            </label>

            <label className="block text-sm" htmlFor="portion-valide-du">
              <span className="text-slate-600">Vrai depuis le (date d'effet)</span>
              <input
                id="portion-valide-du" type="date" max={aujourdhui()} value={valideDu}
                onChange={(e) => setValideDu(e.target.value)}
                className="mt-1 w-full rounded border px-2 py-1"
              />
              <span className="text-xs text-slate-500">
                Depuis quand c'est vrai sur le terrain, pas la date de ce relevé. Laissée vide, elle
                reste inconnue : la portion n'apparaîtra à aucune date du curseur temporel du
                géoportail.
              </span>
            </label>

            <Button onClick={qualifier} disabled={!peutQualifier || envoi} className="w-full">
              {envoi ? "Envoi…" : "Proposer cette portion"}
            </Button>
          </div>
        )}
      </section>

      {/* ── Actifs à proximité ──────────────────────────────────── */}
      <section className="rounded-lg border bg-white p-4">
        <h2 className="font-semibold">Ouvrages à proximité</h2>
        {!contexte && <p className="mt-2 text-sm text-slate-600">—</p>}
        {contexte && contexte.actifsProches.length === 0 && (
          <p className="mt-2 text-sm text-slate-600">Aucun ouvrage recensé dans les 150 mètres.</p>
        )}
        <ul className="mt-2 space-y-1 text-sm">
          {(contexte?.actifsProches ?? []).map((a) => (
            <li key={a.id} className="flex justify-between gap-2">
              <span>{a.nom ?? a.type} <span className="text-slate-500">({a.type})</span></span>
              <span className="text-slate-500">{Math.round(a.distanceM)} m</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
