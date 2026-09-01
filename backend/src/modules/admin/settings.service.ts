import { prisma } from "../../lib/prisma";
import { encrypt, decrypt } from "../../lib/crypto";
import { logAudit } from "../../utils/audit";
import type { SmtpConfigInput } from "./settings.schema";

const SMTP_KEY = "smtp";

interface StoredSmtpConfig {
  host: string; port: number; secure: boolean; user?: string; from: string;
  passwordEncrypted?: string;
}

async function readRaw(key: string): Promise<StoredSmtpConfig | null> {
  const row = await prisma.appSetting.findUnique({ where: { key } });
  if (!row) return null;
  try {
    return JSON.parse(row.value) as StoredSmtpConfig;
  } catch {
    return null;
  }
}

// Version exposée à l'API/interface : jamais le mot de passe en clair, juste un booléen
// indiquant qu'un mot de passe est enregistré (pour afficher "•••• (enregistré)" côté UI).
export async function getSmtpConfigForApi() {
  const cfg = await readRaw(SMTP_KEY);
  if (!cfg) return null;
  return {
    host: cfg.host, port: cfg.port, secure: cfg.secure, user: cfg.user ?? "", from: cfg.from,
    hasPassword: !!cfg.passwordEncrypted,
  };
}

// Version interne utilisée par le mailer : mot de passe déchiffré, ou null si aucune
// config n'a été enregistrée en base (le mailer se rabat alors sur les variables d'env).
export async function getSmtpConfigInternal(): Promise<{ host: string; port: number; secure: boolean; user?: string; password?: string; from: string } | null> {
  const cfg = await readRaw(SMTP_KEY);
  if (!cfg) return null;
  return {
    host: cfg.host, port: cfg.port, secure: cfg.secure, user: cfg.user,
    password: cfg.passwordEncrypted ? decrypt(cfg.passwordEncrypted) : undefined,
    from: cfg.from,
  };
}

export async function setSmtpConfig(input: SmtpConfigInput, userId: string) {
  const existing = await readRaw(SMTP_KEY);
  const passwordEncrypted = input.password
    ? encrypt(input.password)
    : existing?.passwordEncrypted; // conserve l'ancien mot de passe si non ressaisi

  const toStore: StoredSmtpConfig = {
    host: input.host, port: input.port, secure: input.secure, user: input.user, from: input.from,
    passwordEncrypted,
  };

  await prisma.appSetting.upsert({
    where: { key: SMTP_KEY },
    create: { key: SMTP_KEY, value: JSON.stringify(toStore), updatedBy: userId },
    update: { value: JSON.stringify(toStore), updatedBy: userId },
  });

  await logAudit({ userId, action: "UPDATE", entityType: "AppSetting", entityId: SMTP_KEY, after: { host: input.host, port: input.port, user: input.user, from: input.from } });

  return getSmtpConfigForApi();
}
