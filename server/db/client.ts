import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { Pool, type PoolConfig, type QueryResult } from 'pg';
import { translateSqliteToPostgres } from './dialect';
import {
  buildTenantSchemaProvisionSql,
  getTenantSchemaName,
  parsePostgresConfig,
  validateTenantQuerySql,
  type PostgresPoolConfig,
} from './postgres';

export type DbDialect = 'sqlite' | 'postgres';

export interface DbRunResult {
  changes: number;
  lastInsertRowid?: number | bigint;
}

export interface DbExecutor {
  readonly dialect: DbDialect;
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | undefined>;
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
  run(sql: string, ...params: unknown[]): Promise<DbRunResult>;
  exec(sql: string): Promise<void>;
}

export interface AsyncDbClient extends DbExecutor {
  transaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T>;
  healthCheck(): Promise<{ ok: boolean; dialect: DbDialect; detail: string; latencyMs?: number }>;
  close(): Promise<void>;
}

export interface PgPoolLike {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ): Promise<Pick<QueryResult<R>, 'rows' | 'rowCount'>>;
  connect(): Promise<PgPoolClientLike>;
  end(): Promise<void>;
}

export interface PgPoolClientLike {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ): Promise<Pick<QueryResult<R>, 'rows' | 'rowCount'>>;
  release(err?: Error | boolean): void;
}

function toSqliteParam(val: unknown): SQLInputValue {
  if (val === undefined || val === null) return null;
  if (typeof val === 'boolean') return val ? 1 : 0;
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'object' && !Buffer.isBuffer(val) && !(val instanceof Uint8Array)) {
    return JSON.stringify(val);
  }
  return val as SQLInputValue;
}

function toPostgresParam(val: unknown): unknown {
  if (val === undefined) return null;
  return val;
}

export class SqliteAsyncDbClient implements AsyncDbClient {
  readonly dialect: DbDialect = 'sqlite';
  private txQueue: Promise<void> = Promise.resolve();

  constructor(private readonly database: DatabaseSync) {}

  async get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    const normalized = params.map(toSqliteParam);
    return this.database.prepare(sql).get(...normalized) as T | undefined;
  }

  async all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
    const normalized = params.map(toSqliteParam);
    return this.database.prepare(sql).all(...normalized) as T[];
  }

  async run(sql: string, ...params: unknown[]): Promise<DbRunResult> {
    const normalized = params.map(toSqliteParam);
    const info = this.database.prepare(sql).run(...normalized);
    return {
      changes: Number(info.changes || 0),
      lastInsertRowid: info.lastInsertRowid,
    };
  }

  async exec(sql: string): Promise<void> {
    this.database.exec(sql);
  }

  async transaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
    const prev = this.txQueue;
    let releaseQueue!: () => void;
    this.txQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });

    await prev;
    try {
      this.database.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(this);
        this.database.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          this.database.exec('ROLLBACK');
        } catch {
          // Ignore secondary rollback error
        }
        throw err;
      }
    } finally {
      releaseQueue();
    }
  }

  async healthCheck(): Promise<{ ok: boolean; dialect: DbDialect; detail: string; latencyMs?: number }> {
    const start = Date.now();
    try {
      const row = this.database.prepare('PRAGMA integrity_check(1)').get() as
        | { integrity_check?: string }
        | undefined;
      const detail = row?.integrity_check || 'unknown';
      return {
        ok: detail === 'ok',
        dialect: 'sqlite',
        detail,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return {
        ok: false,
        dialect: 'sqlite',
        detail: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - start,
      };
    }
  }

  async close(): Promise<void> {
    this.database.close();
  }
}

export function buildPgPoolConfig(cfg: PostgresPoolConfig): PoolConfig {
  const ssl: PoolConfig['ssl'] =
    cfg.sslMode === 'disable'
      ? false
      : cfg.sslMode === 'verify-full'
        ? { rejectUnauthorized: true }
        : { rejectUnauthorized: false };

  return {
    connectionString: cfg.connectionString,
    max: cfg.maxConnections,
    idleTimeoutMillis: cfg.idleTimeoutMs,
    connectionTimeoutMillis: cfg.connectionTimeoutMs,
    ssl,
  };
}

class PostgresTxExecutor implements DbExecutor {
  readonly dialect: DbDialect = 'postgres';

  constructor(private readonly client: PgPoolClientLike) {}

  async get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    const pgSql = translateSqliteToPostgres(sql);
    const res = await this.client.query<Record<string, unknown>>(pgSql, params.map(toPostgresParam));
    return res.rows[0] as T | undefined;
  }

  async all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
    const pgSql = translateSqliteToPostgres(sql);
    const res = await this.client.query<Record<string, unknown>>(pgSql, params.map(toPostgresParam));
    return res.rows as T[];
  }

  async run(sql: string, ...params: unknown[]): Promise<DbRunResult> {
    const pgSql = translateSqliteToPostgres(sql);
    const res = await this.client.query(pgSql, params.map(toPostgresParam));
    return { changes: Number(res.rowCount || 0) };
  }

  async exec(sql: string): Promise<void> {
    await this.client.query(sql);
  }
}

export class PostgresAsyncDbClient implements AsyncDbClient {
  readonly dialect: DbDialect = 'postgres';
  readonly pool: PgPoolLike;
  readonly config: PostgresPoolConfig;

  constructor(
    config: PostgresPoolConfig,
    options?: { poolFactory?: (poolCfg: PoolConfig) => PgPoolLike }
  ) {
    this.config = config;
    const poolCfg = buildPgPoolConfig(config);
    this.pool = options?.poolFactory
      ? options.poolFactory(poolCfg)
      : (new Pool(poolCfg) as unknown as PgPoolLike);
  }

  async get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    const pgSql = translateSqliteToPostgres(sql);
    const res = await this.pool.query<Record<string, unknown>>(pgSql, params.map(toPostgresParam));
    return res.rows[0] as T | undefined;
  }

  async all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
    const pgSql = translateSqliteToPostgres(sql);
    const res = await this.pool.query<Record<string, unknown>>(pgSql, params.map(toPostgresParam));
    return res.rows as T[];
  }

  async run(sql: string, ...params: unknown[]): Promise<DbRunResult> {
    const pgSql = translateSqliteToPostgres(sql);
    const res = await this.pool.query(pgSql, params.map(toPostgresParam));
    return { changes: Number(res.rowCount || 0) };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let txError = false;
    try {
      await client.query('BEGIN');
      const result = await fn(new PostgresTxExecutor(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      txError = true;
      try {
        await client.query('ROLLBACK');
      } catch {
        // Ignore secondary rollback error
      }
      throw err;
    } finally {
      client.release(txError);
    }
  }

  /**
   * Provisions an isolated per-project PostgreSQL schema (`tenant_<project>`) separate from core platform tables.
   */
  async ensureTenantSchema(projectId: string): Promise<string> {
    const schema = getTenantSchemaName(projectId);
    const ddl = buildTenantSchemaProvisionSql(projectId);
    await this.transaction(async (tx) => {
      await tx.exec(ddl);
    });
    return schema;
  }

  /**
   * Executes validated SQL strictly scoped to a project's `tenant_<project>` schema using `SET LOCAL search_path`
   * (safe under PgBouncer transaction pooling).
   */
  async queryTenant<T = Record<string, unknown>>(
    projectId: string,
    sql: string,
    params: unknown[] = []
  ): Promise<{ rows: T[]; rowCount: number; tenantSchema: string }> {
    const check = validateTenantQuerySql(sql, projectId);
    if (!check.safe) {
      throw new Error(check.reason || 'Query tenant ditolak oleh kebijakan isolasi skema.');
    }
    const pgSql = translateSqliteToPostgres(sql);
    return await this.transaction(async (tx) => {
      await tx.exec(`SET LOCAL search_path TO "${check.tenantSchema}"`);
      const rows = await tx.all<T>(pgSql, ...params);
      return { rows, rowCount: rows.length, tenantSchema: check.tenantSchema };
    });
  }

  async healthCheck(): Promise<{ ok: boolean; dialect: DbDialect; detail: string; latencyMs?: number }> {
    const start = Date.now();
    try {
      await this.pool.query('SELECT 1 AS ok');
      return {
        ok: true,
        dialect: 'postgres',
        detail: `PostgreSQL connected (${this.config.pgBouncer ? 'PgBouncer' : 'direct'}, max=${this.config.maxConnections})`,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return {
        ok: false,
        dialect: 'postgres',
        detail: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - start,
      };
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function createAsyncDbClient(options: {
  sqliteDb?: DatabaseSync;
  env?: NodeJS.ProcessEnv;
  poolFactory?: (poolCfg: PoolConfig) => PgPoolLike;
}): AsyncDbClient {
  const env = options.env || process.env;
  const requested = (env.CARMEN_DB_DRIVER || 'sqlite').trim().toLowerCase();
  if (requested === 'postgres') {
    const pgCfg = parsePostgresConfig(env);
    if (!pgCfg) {
      throw new Error('CARMEN_DB_DRIVER=postgres diatur tetapi DATABASE_URL belum dikonfigurasi.');
    }
    return new PostgresAsyncDbClient(pgCfg, { poolFactory: options.poolFactory });
  }
  if (requested && requested !== 'sqlite') {
    throw new Error(`Driver database CARMEN_DB_DRIVER="${requested}" tidak didukung. Gunakan "sqlite" atau "postgres".`);
  }
  if (!options.sqliteDb) {
    throw new Error('sqliteDb wajib diberikan ketika driver SQLite aktif.');
  }
  return new SqliteAsyncDbClient(options.sqliteDb);
}

export async function testPostgresConnection(
  env: NodeJS.ProcessEnv = process.env,
  options?: { poolFactory?: (poolCfg: PoolConfig) => PgPoolLike }
): Promise<{ ok: boolean; configured: boolean; latencyMs?: number; detail: string }> {
  let cfg: PostgresPoolConfig | null;
  try {
    cfg = parsePostgresConfig(env);
  } catch (err) {
    return {
      ok: false,
      configured: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (!cfg) {
    return {
      ok: false,
      configured: false,
      detail: 'DATABASE_URL tidak dikonfigurasi.',
    };
  }
  const client = new PostgresAsyncDbClient(cfg, { poolFactory: options?.poolFactory });
  try {
    const res = await client.healthCheck();
    return {
      ok: res.ok,
      configured: true,
      latencyMs: res.latencyMs,
      detail: res.detail,
    };
  } finally {
    await client.close().catch(() => {});
  }
}
