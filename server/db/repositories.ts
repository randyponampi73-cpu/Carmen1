import crypto from 'node:crypto';
import type { BuildLogEntry, DeploymentRecord, DeploymentTarget, ProjectType, UserProfile } from '../../src/types';
import { sha256 } from '../security';
import type { AsyncDbClient } from './client';
import { isUniqueConstraintError, parseJsonColumn, toBooleanFlag, toIsoTimestamp } from './dialect';

export interface ProjectRecord {
  id: string;
  userId: string;
  name: string;
  type: ProjectType;
  stack: string;
  rules: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PaginationOptions {
  limit?: number;
  offset?: number;
}

function mapUser(row: Record<string, unknown>): UserProfile {
  return {
    id: String(row.id),
    email: String(row.email),
    name: String(row.name),
    locale: row.locale === 'en' ? 'en' : 'id',
    theme: row.theme === 'light' ? 'light' : 'dark',
    defaultProviderKeyId: (row.default_provider_key_id as string | null) ?? null,
    defaultModelId: (row.default_model_id as string | null) ?? null,
    fallbackProviderKeyId: (row.fallback_provider_key_id as string | null) ?? null,
    fallbackModelId: (row.fallback_model_id as string | null) ?? null,
    createdAt: toIsoTimestamp(row.created_at),
  };
}

function mapProject(row: Record<string, unknown>): ProjectRecord {
  const name = String(row.name || 'CARMEN App');

  return {
    id: String(row.id),
    userId: String(row.user_id),
    name,
    type: 'web',
    stack: String(row.stack || ''),
    rules: String(row.rules || ''),
    archived: toBooleanFlag(row.archived),
    createdAt: toIsoTimestamp(row.created_at),
    updatedAt: toIsoTimestamp(row.updated_at),
  };
}

/**
 * Unified async repository layer guaranteeing identical SQLite & PostgreSQL behavior
 * for transactions, foreign keys, pagination, JSON/JSONB columns, boolean flags, timestamps, and error mapping.
 */
export function createRepositories(client: AsyncDbClient) {
  return {
    users: {
      async findById(id: string): Promise<UserProfile | null> {
        const row = await client.get<Record<string, unknown>>('SELECT * FROM users WHERE id = ?', id);
        return row ? mapUser(row) : null;
      },

      async findByEmail(email: string): Promise<UserProfile | null> {
        const clean = email.trim().toLowerCase();
        const row = await client.get<Record<string, unknown>>(
          'SELECT * FROM users WHERE lower(trim(email)) = ?',
          clean
        );
        return row ? mapUser(row) : null;
      },

      async create(input: {
        id?: string;
        email: string;
        passwordHash: string;
        name: string;
      }): Promise<{ user?: UserProfile; duplicate?: boolean }> {
        const id = input.id || `usr_${crypto.randomUUID().slice(0, 12)}`;
        const cleanEmail = input.email.trim().toLowerCase();
        try {
          await client.run(
            `INSERT INTO users (id, email, password_hash, name, locale, theme) VALUES (?, ?, ?, ?, 'id', 'dark')`,
            id,
            cleanEmail,
            input.passwordHash,
            input.name.trim().slice(0, 80) || cleanEmail.split('@')[0]
          );
          const created = await client.get<Record<string, unknown>>('SELECT * FROM users WHERE id = ?', id);
          return { user: created ? mapUser(created) : undefined };
        } catch (err) {
          if (isUniqueConstraintError(err)) {
            return { duplicate: true };
          }
          throw err;
        }
      },

      async deleteById(userId: string): Promise<boolean> {
        const res = await client.run('DELETE FROM users WHERE id = ?', userId);
        return res.changes > 0;
      },
    },

    sessions: {
      async createHashed(userId: string, ttlDays = 30): Promise<string> {
        const rawToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = sha256(rawToken);
        const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
        await client.run(
          'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)',
          tokenHash,
          userId,
          expiresAt
        );
        return rawToken;
      },

      async findUserByRawToken(rawToken: string): Promise<UserProfile | null> {
        const tokenHash = sha256(rawToken);
        const sess = await client.get<{ user_id: string; expires_at: unknown }>(
          'SELECT user_id, expires_at FROM sessions WHERE token = ?',
          tokenHash
        );
        if (!sess) return null;
        if (new Date(toIsoTimestamp(sess.expires_at)).getTime() < Date.now()) return null;
        const userRow = await client.get<Record<string, unknown>>('SELECT * FROM users WHERE id = ?', sess.user_id);
        return userRow ? mapUser(userRow) : null;
      },

      async deleteByRawToken(rawToken: string): Promise<number> {
        const res = await client.run('DELETE FROM sessions WHERE token = ?', sha256(rawToken));
        return res.changes;
      },

      async cleanupExpired(): Promise<number> {
        const res = await client.run('DELETE FROM sessions WHERE expires_at < ?', new Date().toISOString());
        return res.changes;
      },
    },

    projects: {
      async listByUser(
        userId: string,
        opts: PaginationOptions & { includeArchived?: boolean } = {}
      ): Promise<ProjectRecord[]> {
        const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)));
        const offset = Math.max(0, Math.floor(opts.offset ?? 0));
        const sql = opts.includeArchived
          ? `SELECT * FROM projects WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`
          : `SELECT * FROM projects WHERE user_id = ? AND archived = 0 ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`;
        const rows = await client.all<Record<string, unknown>>(sql, userId, limit, offset);
        return rows.map(mapProject);
      },

      async getOwned(projectId: string, userId: string): Promise<ProjectRecord | null> {
        const row = await client.get<Record<string, unknown>>(
          'SELECT * FROM projects WHERE id = ? AND user_id = ?',
          projectId,
          userId
        );
        return row ? mapProject(row) : null;
      },

      async createWithFiles(input: {
        id: string;
        userId: string;
        name: string;
        type?: ProjectType;
        stack: string;
        rules: string;
        files: Record<string, string>;
      }): Promise<ProjectRecord> {
        return await client.transaction(async (tx) => {
          await tx.run(
            `INSERT INTO projects (id, user_id, name, type, stack, rules, apk_config_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            input.id,
            input.userId,
            input.name,
            input.type ?? 'web',
            input.stack,
            input.rules,
            '{}'
          );
          for (const [filePath, content] of Object.entries(input.files)) {
            await tx.run(
              `INSERT INTO project_files (id, project_id, path, content, hash) VALUES (?, ?, ?, ?, ?)`,
              crypto.randomUUID(),
              input.id,
              filePath,
              content,
              sha256(content)
            );
          }
          const created = await tx.get<Record<string, unknown>>('SELECT * FROM projects WHERE id = ?', input.id);
          return mapProject(created!);
        });
      },

      async setArchived(projectId: string, userId: string, archived: boolean): Promise<boolean> {
        const archivedParam = client.dialect === 'postgres' ? archived : archived ? 1 : 0;
        const res = await client.run(
          `UPDATE projects SET archived = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?`,
          archivedParam,
          projectId,
          userId
        );
        return res.changes > 0;
      },
    },

    projectFiles: {
      async listPaths(projectId: string): Promise<string[]> {
        const rows = await client.all<{ path: string }>(
          'SELECT path FROM project_files WHERE project_id = ? ORDER BY path ASC',
          projectId
        );
        return rows.map((r) => r.path);
      },

      async listAll(projectId: string): Promise<Array<{ path: string; content: string; hash: string }>> {
        return await client.all<{ path: string; content: string; hash: string }>(
          'SELECT path, content, hash FROM project_files WHERE project_id = ? ORDER BY path ASC',
          projectId
        );
      },

      async getByPath(projectId: string, filePath: string): Promise<{ id: string; content: string; hash: string } | null> {
        const row = await client.get<{ id: string; content: string; hash: string }>(
          'SELECT id, content, hash FROM project_files WHERE project_id = ? AND path = ?',
          projectId,
          filePath
        );
        return row ?? null;
      },

      async upsert(projectId: string, filePath: string, content: string): Promise<void> {
        const hash = sha256(content);
        await client.transaction(async (tx) => {
          await tx.run(
            `INSERT INTO project_files (id, project_id, path, content, hash, updated_at)
             VALUES (?, ?, ?, ?, ?, datetime('now'))
             ON CONFLICT(project_id, path) DO UPDATE
             SET content = excluded.content, hash = excluded.hash, updated_at = datetime('now')`,
            crypto.randomUUID(),
            projectId,
            filePath,
            content,
            hash
          );
          await tx.run(`UPDATE projects SET updated_at = datetime('now') WHERE id = ?`, projectId);
        });
      },
    },

    memory: {
      async getProjectMemory(projectId: string): Promise<string> {
        const row = await client.get<{ content: string }>(
          'SELECT content FROM project_memory WHERE project_id = ?',
          projectId
        );
        return row?.content ?? '';
      },

      async setProjectMemory(projectId: string, content: string): Promise<void> {
        if (!content) {
          await client.run('DELETE FROM project_memory WHERE project_id = ?', projectId);
          return;
        }
        await client.run(
          `INSERT INTO project_memory (project_id, content, updated_at) VALUES (?, ?, datetime('now'))
           ON CONFLICT(project_id) DO UPDATE SET content = excluded.content, updated_at = datetime('now')`,
          projectId,
          content
        );
      },

      async getHandoff(projectId: string): Promise<string> {
        const row = await client.get<{ content: string }>(
          'SELECT content FROM project_handoff WHERE project_id = ?',
          projectId
        );
        return row?.content ?? '';
      },

      async setHandoff(projectId: string, content: string): Promise<void> {
        await client.run(
          `INSERT INTO project_handoff (project_id, content, updated_at) VALUES (?, ?, datetime('now'))
           ON CONFLICT(project_id) DO UPDATE SET content = excluded.content, updated_at = datetime('now')`,
          projectId,
          content
        );
      },
    },

    deployments: {
      async create(record: DeploymentRecord): Promise<void> {
        await client.run(
          `INSERT INTO deployments (id, project_id, target, status, deployment_url, external_id, project_name, logs_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          record.id,
          record.projectId,
          record.target,
          record.status,
          record.deploymentUrl,
          record.externalId,
          record.projectName,
          JSON.stringify(record.logs),
          record.createdAt
        );
      },

      async getById(deployId: string): Promise<DeploymentRecord | null> {
        const r = await client.get<Record<string, unknown>>(
          `SELECT id, project_id, target, status, deployment_url, external_id, project_name, logs_json, created_at
           FROM deployments WHERE id = ?`,
          deployId
        );
        if (!r) return null;
        return {
          id: String(r.id),
          projectId: String(r.project_id),
          target: String(r.target) as DeploymentTarget,
          status: String(r.status) as DeploymentRecord['status'],
          deploymentUrl: (r.deployment_url as string | null) ?? null,
          externalId: (r.external_id as string | null) ?? null,
          projectName: String(r.project_name),
          logs: parseJsonColumn<BuildLogEntry[]>(r.logs_json, []),
          createdAt: toIsoTimestamp(r.created_at),
        };
      },

      async listByProject(projectId: string, limit = 30): Promise<DeploymentRecord[]> {
        const rows = await client.all<Record<string, unknown>>(
          `SELECT id, project_id, target, status, deployment_url, external_id, project_name, logs_json, created_at
           FROM deployments
           WHERE project_id = ?
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
          projectId,
          Math.max(1, Math.min(100, limit))
        );
        return rows.map((r) => ({
          id: String(r.id),
          projectId: String(r.project_id),
          target: String(r.target) as DeploymentTarget,
          status: String(r.status) as DeploymentRecord['status'],
          deploymentUrl: (r.deployment_url as string | null) ?? null,
          externalId: (r.external_id as string | null) ?? null,
          projectName: String(r.project_name),
          logs: parseJsonColumn<BuildLogEntry[]>(r.logs_json, []),
          createdAt: toIsoTimestamp(r.created_at),
        }));
      },
    },

    sharedKeyUsage: {
      async getDailyUsage(
        userId: string,
        usageDate: string
      ): Promise<{ requestCount: number; tokensUsed: number; estimatedCostUsd: number }> {
        const row = await client.get<{
          request_count?: number | string;
          tokens_used?: number | string;
          estimated_cost_usd?: number | string;
        }>(
          'SELECT request_count, tokens_used, estimated_cost_usd FROM shared_key_usage WHERE user_id = ? AND usage_date = ?',
          userId,
          usageDate
        );
        return {
          requestCount: Number(row?.request_count ?? 0),
          tokensUsed: Number(row?.tokens_used ?? 0),
          estimatedCostUsd: Number(row?.estimated_cost_usd ?? 0),
        };
      },

      async recordUsage(
        userId: string,
        usageDate: string,
        delta: { requests?: number; tokens?: number; costUsd?: number }
      ): Promise<{ requestCount: number; tokensUsed: number; estimatedCostUsd: number }> {
        const reqDelta = Math.max(0, Math.floor(delta.requests ?? 0));
        const tokDelta = Math.max(0, Math.floor(delta.tokens ?? 0));
        const costDelta = Math.max(0, Number.isFinite(delta.costUsd ?? 0) ? delta.costUsd ?? 0 : 0);
        await client.run(
          `INSERT INTO shared_key_usage (user_id, usage_date, request_count, tokens_used, estimated_cost_usd)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id, usage_date) DO UPDATE SET
             request_count = shared_key_usage.request_count + excluded.request_count,
             tokens_used = shared_key_usage.tokens_used + excluded.tokens_used,
             estimated_cost_usd = shared_key_usage.estimated_cost_usd + excluded.estimated_cost_usd`,
          userId,
          usageDate,
          reqDelta,
          tokDelta,
          costDelta
        );
        return await this.getDailyUsage(userId, usageDate);
      },

      async getDailyCount(userId: string, usageDate: string): Promise<number> {
        const usage = await this.getDailyUsage(userId, usageDate);
        return usage.requestCount;
      },

      async incrementDailyCount(userId: string, usageDate: string, delta = 1): Promise<number> {
        const updated = await this.recordUsage(userId, usageDate, {
          requests: Math.max(1, Math.floor(delta)),
        });
        return updated.requestCount;
      },
    },
  };
}
