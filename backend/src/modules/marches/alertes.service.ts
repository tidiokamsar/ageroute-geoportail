import { prisma } from "../../lib/prisma";

export interface AlerteContractuelle {
  marcheId: string; intitule: string; bailleur: string | null;
  type: "retard" | "garantie" | "penalite"; message: string; gravite: "haute" | "moyenne";
  montantPenalite?: number;
}

// Calcule les alertes contractuelles courantes (retard physique, garantie de bonne
// exécution proche de l'expiration, pénalité de retard). Partagé entre l'endpoint API
// (/marches/alertes) et le job cron quotidien qui envoie l'email de synthèse.
export async function computeAlertesContractuelles(): Promise<AlerteContractuelle[]> {
  const now = new Date();
  const seuil60j = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);

  const marches = await prisma.marche.findMany({
    where: { statut: { in: ["EN_COURS", "PLANIFIE", "SUSPENDU"] } },
    include: {
      bailleur: true,
      avancements: { orderBy: { periode: "desc" }, take: 1 },
    },
  });

  const alertes: AlerteContractuelle[] = [];

  for (const m of marches) {
    const lastAv = m.avancements[0];

    if (lastAv) {
      const ecart = lastAv.avancementPhysiquePrevu - lastAv.avancementPhysiqueReel;
      if (ecart > 10) {
        alertes.push({
          marcheId: m.id, intitule: m.intitule, bailleur: m.bailleur?.nom ?? null,
          type: "retard",
          message: `Retard physique de ${ecart.toFixed(0)} points (prévu: ${lastAv.avancementPhysiquePrevu}%, réel: ${lastAv.avancementPhysiqueReel}%)`,
          gravite: ecart > 25 ? "haute" : "moyenne",
        });
      }
    }

    if (m.garantieBonneExecutionExp && m.garantieBonneExecutionExp < seuil60j && m.garantieBonneExecutionExp > now) {
      const jours = Math.round((m.garantieBonneExecutionExp.getTime() - now.getTime()) / 86400000);
      alertes.push({
        marcheId: m.id, intitule: m.intitule, bailleur: m.bailleur?.nom ?? null,
        type: "garantie",
        message: `Garantie de bonne exécution expire dans ${jours} jour(s)`,
        gravite: jours < 30 ? "haute" : "moyenne",
      });
    }

    if (m.dateReceptionProvisoire && m.dateReceptionProvisoire < now && m.statut !== "TERMINE" && m.statut !== "SOLDE") {
      const joursRetard = Math.round((now.getTime() - m.dateReceptionProvisoire.getTime()) / 86400000);
      const montantPenalite = m.montantTotal && m.tauxPenaliteRetardPct
        ? Number(m.montantTotal) * (m.tauxPenaliteRetardPct / 100) * joursRetard
        : undefined;
      alertes.push({
        marcheId: m.id, intitule: m.intitule, bailleur: m.bailleur?.nom ?? null,
        type: "penalite",
        message: `Réception provisoire dépassée de ${joursRetard} jour(s)${montantPenalite ? ` — pénalité estimée: ${(montantPenalite / 1e9).toFixed(1)} Md GNF` : ""}`,
        gravite: "haute",
        montantPenalite,
      });
    }
  }

  return alertes.sort((a, b) => (a.gravite === "haute" ? -1 : 1) - (b.gravite === "haute" ? -1 : 1));
}
