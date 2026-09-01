import nodemailer from "nodemailer";
import { env } from "../config/env";
import { getSmtpConfigInternal } from "../modules/admin/settings.service";

interface ResolvedSmtpConfig {
  host: string; port: number; secure: boolean; user?: string; password?: string; from: string;
}

// Résout la config SMTP effective : priorité à ce qui est enregistré dans l'interface
// d'administration (base de données), repli sur les variables d'environnement si rien
// n'a encore été configuré via l'UI. Relu à chaque envoi (fréquence faible — pas besoin
// de cache) pour refléter immédiatement un changement fait dans /administration.
async function resolveConfig(): Promise<ResolvedSmtpConfig | null> {
  const dbConfig = await getSmtpConfigInternal();
  if (dbConfig) return dbConfig;

  if (env.SMTP_HOST) {
    return {
      host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_PORT === 465,
      user: env.SMTP_USER, password: env.SMTP_PASSWORD, from: env.SMTP_FROM,
    };
  }
  return null;
}

async function buildTransporter(config: ResolvedSmtpConfig) {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user ? { user: config.user, pass: config.password } : undefined,
  });
}

export async function sendMail(opts: { to: string[]; subject: string; html: string }): Promise<void> {
  if (opts.to.length === 0) return;

  const config = await resolveConfig();
  if (!config) {
    console.log(`[mailer] SMTP non configuré — email non envoyé (destinataires: ${opts.to.join(", ")}, sujet: "${opts.subject}")`);
    return;
  }

  try {
    const transporter = await buildTransporter(config);
    await transporter.sendMail({ from: config.from, to: opts.to.join(", "), subject: opts.subject, html: opts.html });
    console.log(`[mailer] Email envoyé à ${opts.to.length} destinataire(s) : "${opts.subject}"`);
  } catch (err) {
    console.error("[mailer] Échec d'envoi :", err);
    throw err;
  }
}

// Utilisé par le bouton "Envoyer un test" de la page Administration : propage l'erreur
// pour que l'utilisateur voie immédiatement pourquoi ça échoue (mauvais mot de passe,
// hôte injoignable...), contrairement à sendMail() qui avale les erreurs des jobs cron.
export async function sendTestMail(to: string): Promise<void> {
  const config = await resolveConfig();
  if (!config) throw new Error("Aucune configuration SMTP enregistrée.");
  const transporter = await buildTransporter(config);
  await transporter.sendMail({
    from: config.from, to,
    subject: "BDRI — Test de configuration SMTP",
    html: `<p>Ceci est un email de test envoyé depuis le module Administration du BDRI AGEROUTE Guinée.</p><p>Si vous recevez ce message, la configuration SMTP est fonctionnelle.</p>`,
  });
}
