import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { dataDir, type DB } from "./client";
import { secrets } from "./schema";

let cachedKey: Buffer | undefined;

function key(): Buffer {
  if (cachedKey) return cachedKey;
  let material = process.env.ELEVATE_SECRET;
  if (!material) {
    const file = path.join(dataDir(), "secret.key");
    if (existsSync(file)) {
      material = readFileSync(file, "utf8").trim();
    } else {
      mkdirSync(path.dirname(file), { recursive: true });
      material = randomBytes(32).toString("base64url");
      writeFileSync(file, material, { mode: 0o600 });
    }
  }
  cachedKey = createHash("sha256").update(material).digest();
  return cachedKey;
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function decrypt(token: string): string {
  const [version, iv, tag, body] = token.split(".");
  if (version !== "v1" || !iv || !tag || !body) throw new Error("Unsupported secret format");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}

export async function setSecret(db: DB, name: string, value: string, tenantId = "local") {
  const ciphertext = encrypt(value);
  await db
    .insert(secrets)
    .values({ tenantId, name, ciphertext })
    .onConflictDoUpdate({ target: [secrets.tenantId, secrets.name], set: { ciphertext, updatedAt: new Date() } });
}

export async function getSecret(db: DB, name: string, tenantId = "local"): Promise<string | undefined> {
  const [row] = await db
    .select()
    .from(secrets)
    .where(and(eq(secrets.tenantId, tenantId), eq(secrets.name, name)));
  return row ? decrypt(row.ciphertext) : undefined;
}

export async function deleteSecret(db: DB, name: string, tenantId = "local") {
  await db.delete(secrets).where(and(eq(secrets.tenantId, tenantId), eq(secrets.name, name)));
}
