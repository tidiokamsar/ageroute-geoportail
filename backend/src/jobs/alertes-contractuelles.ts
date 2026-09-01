import { prisma } from "../lib/prisma";
import { sendMail } from "../lib/mailer";
import { computeAlertesContractuelles, type AlerteContractuelle } from "../modules/marches/alertes.service";

// Job quotidien : recalcule les alertes contractuelles et met à jour l'avancement prévu
// via interpolation linéaire pour les marchés sans saisie manuelle.
export async function calculAlertes(): Promise<void> {
  const now = new Date();

  const marches = await prisma.marche.findMany({
    where: { statut: { in: ["EN_COURS", "PLANIFIE"] } },
    include: { avancements: { orderBy: { periode: "desc" }, take: 1 } },
  });

  let updated = 0;
  for (const m of marches) {
    if (!m.dateDebutPrevue || !m.dateFinPrevue) continue;

    const debut   = m.dateDebutPrevue.getTime();
    const fin     = m.dateFinPrevue.getTime();
    const elapsed = now.getTime() - debut;
    const total   = fin - debut;
    if (total <= 0) continue;

    const prevuPct = Math.max(0, Math.min(100, parseFloat(((elapsed / total) * 100).toFixed(1))));
    const periodeActuelle = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    const dernier = m.avancements[0];
    // Ne crée/met à jour que si on n'a pas de saisie manuelle pour ce mois
    const periodeStr = periodeActuelle.toISOString();
    if (!dernier || dernier.periode.toISOString() !== periodeStr) {
      await prisma.avancementMarche.upsert({
        where: { marcheId_periode: { marcheId: m.id, periode: periodeActuelle } },
        create: {
          marcheId: m.id, periode: periodeActuelle,
          avancementPhysiquePrevu: prevuPct,
          avancementFinancierPrevu: parseFloat((prevuPct * 0.9).toFixed(1)),
        },
        update: { avancementPhysiquePrevu: prevuPct },
      });
      updated++;
    }
  }

  console.log(`[alertes-contractuelles] ${marches.length} marchés analysés, ${updated} avancements interpolés.`);
}

function renderAlertesEmail(alertes: AlerteContractuelle[]): string {
  const rows = alertes.map((a) => `
    <tr>
      <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;font-weight:600;color:#1a2942">${a.intitule}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;color:#64748b">${a.bailleur ?? "—"}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">${a.message}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:center">
        <span style="background:${a.gravite === "haute" ? "#fee2e2" : "#fef3c7"};color:${a.gravite === "haute" ? "#dc2626" : "#b45309"};padding:2px 8px;border-radius:9999px;font-size:11px;font-weight:600">
          ${a.gravite === "haute" ? "Urgent" : "À surveiller"}
        </span>
      </td>
    </tr>`).join("");

  return `
    <div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto">
      <div style="background:#1a2942;color:white;padding:16px 20px;border-radius:8px 8px 0 0">
        <h2 style="margin:0;font-size:16px">BDRI — Alertes contractuelles du jour</h2>
        <p style="margin:4px 0 0;color:#94a3b8;font-size:12px">${alertes.length} alerte(s) détectée(s) — ${new Date().toLocaleDateString("fr-FR")}</p>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="background:#f8fafc">
            <th style="padding:6px 10px;text-align:left;color:#64748b;font-size:11px;text-transform:uppercase">Marché</th>
            <th style="padding:6px 10px;text-align:left;color:#64748b;font-size:11px;text-transform:uppercase">Bailleur</th>
            <th style="padding:6px 10px;text-align:left;color:#64748b;font-size:11px;text-transform:uppercase">Détail</th>
            <th style="padding:6px 10px;text-align:center;color:#64748b;font-size:11px;text-transform:uppercase">Gravité</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="color:#94a3b8;font-size:11px;padding:12px 10px">
        Notification automatique BDRI AGEROUTE Guinée — consultez le module Marchés pour le détail complet.
      </p>
    </div>`;
}

// Envoie le récapitulatif quotidien aux comptes ADMIN/GESTIONNAIRE actifs, uniquement
// s'il y a au moins une alerte (pas de bruit inutile les jours calmes).
export async function sendAlertesEmail(): Promise<void> {
  const alertes = await computeAlertesContractuelles();
  if (alertes.length === 0) {
    console.log("[alertes-contractuelles] Aucune alerte — pas d'email envoyé.");
    return;
  }

  const destinataires = await prisma.user.findMany({
    where: { actif: true, role: { in: ["ADMIN", "GESTIONNAIRE"] } },
    select: { email: true },
  });

  await sendMail({
    to: destinataires.map((d) => d.email),
    subject: `BDRI — ${alertes.length} alerte(s) contractuelle(s) — ${new Date().toLocaleDateString("fr-FR")}`,
    html: renderAlertesEmail(alertes),
  });
}

// Scheduler : 1× par jour à 01h00 UTC
export function startAlertesScheduler(): void {
  const MAX_DELAY_MS = 24 * 60 * 60 * 1000;

  const scheduleNext = () => {
    const now  = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 1, 0, 0, 0));
    const remaining = next.getTime() - now.getTime();
    const delay = Math.min(remaining, MAX_DELAY_MS);

    setTimeout(() => {
      if (remaining <= MAX_DELAY_MS) {
        // Tick quotidien reel : interpolation + email. A la difference de l'appel
        // "immediat" au demarrage (ci-dessous), qui se declenche a chaque redeploiement
        // et ne doit donc jamais envoyer de mail.
        calculAlertes()
          .then(sendAlertesEmail)
          .catch((err) => console.error("[alertes-contractuelles] Erreur :", err))
          .finally(scheduleNext);
      } else {
        scheduleNext();
      }
    }, delay);
  };

  // Exécuter immédiatement au démarrage (interpolation seule, sans email — voir commentaire ci-dessus)
  calculAlertes().catch((err) => console.error("[alertes-contractuelles] Erreur init :", err));
  scheduleNext();
  console.log("[alertes-contractuelles] Scheduler démarré (quotidien 01h00 UTC).");
}
