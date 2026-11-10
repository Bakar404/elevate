import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle as drizzlePglite, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "./schema";

export type DB = PgliteDatabase<typeof schema>;

type Handle = { db: DB; close: () => Promise<void>; ready: Promise<void> };

const GLOBAL_KEY = Symbol.for("elevate.db");
type GlobalWithDb = typeof globalThis & { [GLOBAL_KEY]?: Handle };

/** Find packages/db/migrations by walking up from cwd (works from apps/*, scripts and bundles). */
export function migrationsDir(): string {
  if (process.env.ELEVATE_MIGRATIONS_DIR) return process.env.ELEVATE_MIGRATIONS_DIR;
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    for (const candidate of [path.join(dir, "packages", "db", "migrations"), path.join(dir, "migrations")]) {
      if (existsSync(path.join(candidate, "meta", "_journal.json"))) return candidate;
    }
    dir = path.dirname(dir);
  }
  throw new Error("Could not locate packages/db/migrations; set ELEVATE_MIGRATIONS_DIR");
}

export function dataDir(): string {
  const configured = process.env.ELEVATE_DATA_DIR || ".data";
  if (path.isAbsolute(configured)) return configured;
  // Anchor relative data dirs at the repo root so the web app and scripts share one database.
  return path.join(path.dirname(path.dirname(migrationsDir())), "..", configured);
}

/** Create a database handle. `memory: true` gives an isolated in-memory PGlite (tests). */
export function createDb(opts: { url?: string; memory?: boolean } = {}): Handle {
  const url = opts.memory ? undefined : (opts.url ?? process.env.DATABASE_URL);
  if (url) {
    const client = postgres(url, { max: 10, onnotice: () => {} });
    const db = drizzlePostgres(client, { schema }) as unknown as DB;
    const ready = migratePostgres(db as never, { migrationsFolder: migrationsDir() });
    return { db, ready, close: () => client.end() };
  }
  let pgDir: string | undefined;
  if (!opts.memory) {
    pgDir = path.join(dataDir(), "pg");
    mkdirSync(pgDir, { recursive: true });
  }
  const client = new PGlite({ dataDir: pgDir, extensions: { vector } });
  const db = drizzlePglite(client, { schema });
  const ready = migratePglite(db, { migrationsFolder: migrationsDir() });
  return { db, ready, close: () => client.close() };
}

/** Process-wide singleton (survives Next.js dev HMR and multiple server bundles). */
export async function getDb(): Promise<DB> {
  const g = globalThis as GlobalWithDb;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = createDb();
  await g[GLOBAL_KEY].ready;
  return g[GLOBAL_KEY].db;
}

export async function closeDb(): Promise<void> {
  const g = globalThis as GlobalWithDb;
  const h = g[GLOBAL_KEY];
  if (h) {
    delete g[GLOBAL_KEY];
    await h.close();
  }
}
