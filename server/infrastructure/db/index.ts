import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { attachDatabasePool } from '@vercel/functions';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { env } from '../../config/env.ts';

export interface QueryResult<T extends QueryResultRow = any> {
  rows: T[];
  rowCount: number;
}

export interface DbSession {
  query<T extends QueryResultRow = any>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface DbClient extends DbSession {
  isExternalPostgres: boolean;
  engineLabel: string;
  transaction<T>(fn: (tx: DbSession) => Promise<T>): Promise<T>;
  execScript(sql: string): Promise<void>;
  close(): Promise<void>;
}

class PgPoolClient implements DbClient {
  public readonly isExternalPostgres = true;
  public readonly engineLabel = 'PostgreSQL (DATABASE_URL)';
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: env.isVercel ? 5 : 15,
      idleTimeoutMillis: env.isVercel ? 10000 : 30000,
      connectionTimeoutMillis: 15000,
    });
    if (env.isVercel) {
      attachDatabasePool(this.pool);
    }
    this.pool.on('error', (err) => {
      console.error('[DB Pool Error]', err.message);
    });
  }

  async query<T extends QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const res = await this.pool.query<T>(sql, params);
    return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length };
  }

  async transaction<T>(fn: (tx: DbSession) => Promise<T>): Promise<T> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const txSession: DbSession = {
        query: async <R extends QueryResultRow = any>(sql: string, params: unknown[] = []) => {
          const res = await client.query<R>(sql, params);
          return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length };
        },
      };
      const out = await fn(txSession);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async execScript(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

class PGliteDbClient implements DbClient {
  public readonly isExternalPostgres = false;
  public readonly engineLabel = 'PostgreSQL 18 (Local Persisted Data Dir)';
  private db: PGlite;
  private mutex: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new PGlite(dataDir, {
      extensions: { pg_trgm },
    });
  }

  private runSerialized<T>(task: () => Promise<T>): Promise<T> {
    const next = this.mutex.then(task, task);
    this.mutex = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  async query<T extends QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    return this.runSerialized(async () => {
      const res = await this.db.query<T>(sql, params);
      return {
        rows: res.rows,
        rowCount: res.affectedRows ?? res.rows.length,
      };
    });
  }

  async transaction<T>(fn: (tx: DbSession) => Promise<T>): Promise<T> {
    return this.runSerialized(async () => {
      await this.db.exec('BEGIN');
      const txSession: DbSession = {
        query: async <R extends QueryResultRow = any>(sql: string, params: unknown[] = []) => {
          const res = await this.db.query<R>(sql, params);
          return {
            rows: res.rows,
            rowCount: res.affectedRows ?? res.rows.length,
          };
        },
      };
      try {
        const out = await fn(txSession);
        await this.db.exec('COMMIT');
        return out;
      } catch (err) {
        await this.db.exec('ROLLBACK');
        throw err;
      }
    });
  }

  async execScript(sql: string): Promise<void> {
    return this.runSerialized(async () => {
      await this.db.exec(sql);
    });
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

let singletonDb: DbClient | null = null;

export function getDb(): DbClient {
  if (!singletonDb) {
    if (env.databaseUrl) {
      singletonDb = new PgPoolClient(env.databaseUrl);
    } else {
      const pgDataDir = env.isVercel
        ? path.join(os.tmpdir(), 'marsforce', 'pgdata')
        : path.resolve(process.cwd(), '.data', 'pgdata');
      if (env.isVercel) {
        console.warn('[MARSFORCE] DATABASE_URL/POSTGRES_URL is not set on Vercel; using ephemeral /tmp PGlite fallback.');
      }
      singletonDb = new PGliteDbClient(pgDataDir);
    }
  }
  return singletonDb;
}

export async function runMigrations(): Promise<void> {
  const db = getDb();
  await db.execScript(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const migrationsDir = path.resolve(process.cwd(), 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    return;
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const appliedRes = await db.query<{ version: string }>('SELECT version FROM schema_migrations');
  const applied = new Set(appliedRes.rows.map((r) => r.version));

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    console.log(`[Migrations] Applying ${file}...`);
    await db.execScript(sql);
    await db.query('INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
    console.log(`[Migrations] Applied ${file}`);
  }
}
