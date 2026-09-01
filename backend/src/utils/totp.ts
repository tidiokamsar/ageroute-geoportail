import { generateSecret, generateURI, verifySync } from "otplib";

export function generateTotpSecret(): string {
  return generateSecret();
}

export function buildOtpauthUrl(email: string, secret: string): string {
  return generateURI({ issuer: "BDRI AGEROUTE", label: email, secret });
}

export function verifyTotpCode(secret: string, code: string): boolean {
  try {
    return verifySync({ token: code, secret }).valid;
  } catch {
    return false;
  }
}
