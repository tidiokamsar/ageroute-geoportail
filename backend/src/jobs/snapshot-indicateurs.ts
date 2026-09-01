import { prisma } from "../lib/prisma";

// Fige l'état courant du réseau dans indicateurs_reseau_historique.
// Appelé au 1er de chaque mois à 02h00 par le scheduler, ou manuellement via l'endpoint /admin/snapshot.
export async function snapshotIndicateurs(): Promise<void> {
  const notDeleted = { deletedAt: null };

  const [longueurAgg, etatsRaw, budgetRow, chantierTerminesKm] = await Promise.all([
    prisma.troncon.aggregate({ where: notDeleted, _sum: { longueurKm: true } }),
    prisma.troncon.groupBy({ by: ["etat"], where: notDeleted, _sum: { longueurKm: true } }),
    prisma.$queryRaw<{ montant: string }[]>`
      SELECT COALESCE(SUM("montantGnf"),0)::text AS montant
      FROM chantiers WHERE "deletedAt" IS NULL`,
    prisma.troncon.aggregate({
      where: { ...notDeleted, chantiers: { some: { statut: "TERMINE" } } },
      _sum: { longueurKm: true },
    }),
  ]);

  const longueur = longueurAgg._sum.longueurKm ?? 0;
  const pct = (etat: string) => {
    const km = etatsRaw.find((e) => e.etat === etat)?._sum.longueurKm ?? 0;
    return longueur > 0 ? parseFloat(((km / longueur) * 100).toFixed(2)) : 0;
  };

  // Période = 1er du mois courant (UTC)
  const now = new Date();
  const periode = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  await prisma.indicateurReseauHistorique.upsert({
    where: { periode },
    create: {
      periode,
      pctBon: pct("BON"),
      pctMoyen: pct("MOYEN"),
      pctMauvais: pct("MAUVAIS"),
      pctCritique: pct("CRITIQUE"),
      pctNonEvalue: pct("NON_EVALUE"),
      lineaireTraiteKm: chantierTerminesKm._sum.longueurKm ?? 0,
      budgetEngageCumul: BigInt(Math.round(Number(budgetRow[0]?.montant ?? "0"))),
      budgetDecaisseCumul: BigInt(0),
    },
    update: {
      pctBon: pct("BON"),
      pctMoyen: pct("MOYEN"),
      pctMauvais: pct("MAUVAIS"),
      pctCritique: pct("CRITIQUE"),
      pctNonEvalue: pct("NON_EVALUE"),
      lineaireTraiteKm: chantierTerminesKm._sum.longueurKm ?? 0,
      budgetEngageCumul: BigInt(Math.round(Number(budgetRow[0]?.montant ?? "0"))),
    },
  });

  console.log(`[snapshot-indicateurs] Snapshot ${periode.toISOString().slice(0, 7)} enregistré.`);
}

// Lance le snapshot maintenant (pour le premier démarrage, si aucun snapshot ce mois)
// puis planifie les suivants au 1er du mois à 02h00 UTC.
export function startSnapshotScheduler(): void {
  // setTimeout ne supporte pas les délais > 2^31-1 ms (~24.8 jours).
  // On découpe donc en tranches de 24h max et on re-calcule à chaque tick.
  const MAX_DELAY_MS = 24 * 60 * 60 * 1000;

  const scheduleNext = () => {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 2, 0, 0, 0));
    const remaining = next.getTime() - now.getTime();

    if (remaining <= 0) {
      // On est passé la date — exécuter immédiatement puis re-planifier
      snapshotIndicateurs()
        .catch((err) => console.error("[snapshot-indicateurs] Erreur :", err))
        .finally(() => scheduleNext());
      return;
    }

    const delay = Math.min(remaining, MAX_DELAY_MS);
    setTimeout(() => {
      if (remaining <= MAX_DELAY_MS) {
        // C'est la dernière tranche — on exécute
        snapshotIndicateurs()
          .catch((err) => console.error("[snapshot-indicateurs] Erreur lors du snapshot mensuel :", err))
          .finally(() => scheduleNext());
      } else {
        scheduleNext();
      }
    }, delay);

    if (remaining > MAX_DELAY_MS) {
      console.log(`[snapshot-indicateurs] Prochain snapshot le ${next.toISOString().slice(0, 10)} — prochaine vérification dans 24h`);
    } else {
      console.log(`[snapshot-indicateurs] Snapshot prévu dans ${Math.round(remaining / 60000)} min`);
    }
  };

  // Premier snapshot au démarrage si aucun n'existe pour ce mois
  const currentMonth = new Date();
  const periodeActuelle = new Date(Date.UTC(currentMonth.getUTCFullYear(), currentMonth.getUTCMonth(), 1));

  prisma.indicateurReseauHistorique
    .findUnique({ where: { periode: periodeActuelle } })
    .then((existing) => {
      if (!existing) {
        snapshotIndicateurs().catch((err) =>
          console.error("[snapshot-indicateurs] Erreur snapshot initial :", err)
        );
      }
    })
    .catch(() => {/* table pas encore créée — la migration n'a pas encore tourné */});

  scheduleNext();
}
