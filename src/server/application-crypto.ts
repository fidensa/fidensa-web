import "server-only";

import { createHmac, randomBytes } from "node:crypto";

const VERIFICATION_PURPOSE = "application_verification";

function hmac(material: string, category: string, value: string): string {
  return createHmac("sha256", material)
    .update(category)
    .update("\0")
    .update(value)
    .digest("hex");
}

export function issueVerificationCredential(): string {
  return `av1.${randomBytes(32).toString("base64url")}`;
}

export function digestVerificationCredential(
  material: string,
  credential: string,
): string {
  return hmac(material, VERIFICATION_PURPOSE, credential);
}

export function digestOperationKey(material: string, key: string): string {
  return hmac(material, "application_submission", key);
}

export function digestEmailIdentity(material: string, email: string): string {
  return hmac(material, "application_email_rate", email);
}

export function digestIpIdentity(material: string, ip: string): string {
  return hmac(material, "application_ip_rate", ip);
}

export function requestIpIdentity(request: Request): string {
  const candidate =
    request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    "unavailable";
  return candidate.slice(0, 128);
}
