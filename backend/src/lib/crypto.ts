import crypto from "crypto";
import { env } from "../config/env";

// Chiffrement symetrique des secrets stockes en base (ex: mot de passe SMTP) : la cle
// est derivee de JWT_ACCESS_SECRET (deja garanti >= 32 caracteres) plutot que d'exiger
// une variable d'environnement supplementaire. AES-256-GCM fournit confidentialite +
// integrite (le tag d'authentification detecte toute alteration).
const KEY = crypto.createHash("sha256").update(env.JWT_ACCESS_SECRET).digest();
const IV_LENGTH = 12;

export function encrypt(plainText: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

export function decrypt(payload: string): string {
  const buf = Buffer.from(payload, "base64");
  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + 16);
  const encrypted = buf.subarray(IV_LENGTH + 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
