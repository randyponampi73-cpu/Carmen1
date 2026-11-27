/**
 * SQL dialect compatibility helpers shared between SQLite (`node:sqlite`) and PostgreSQL (`pg`).
 */

/**
 * Translates parameterized SQLite queries (`?`, `datetime('now', ...)`, `archived = 0/1`, `, rowid ASC/DESC`)
 * into PostgreSQL-compatible SQL (`$1..$n`, `NOW()`, `FALSE/TRUE`), while strictly ignoring string literals,
 * quoted identifiers, and SQL comments.
 */
export function translateSqliteToPostgres(sql: string): string {
  const input = String(sql || '');
  let out = '';
  let paramIdx = 0;
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    // 1) Single-quoted string literal ('...' with '' escapes)
    if (ch === "'") {
      let end = i + 1;
      while (end < input.length) {
        if (input[end] === "'" && input[end + 1] === "'") {
          end += 2;
          continue;
        }
        if (input[end] === "'") {
          end += 1;
          break;
        }
        end += 1;
      }
      out += input.slice(i, end);
      i = end;
      continue;
    }

    // 2) Double-quoted identifier ("..." with "" escapes)
    if (ch === '"') {
      let end = i + 1;
      while (end < input.length) {
        if (input[end] === '"' && input[end + 1] === '"') {
          end += 2;
          continue;
        }
        if (input[end] === '"') {
          end += 1;
          break;
        }
        end += 1;
      }
      out += input.slice(i, end);
      i = end;
      continue;
    }

    // 3) Line comment (-- ...)
    if (ch === '-' && input[i + 1] === '-') {
      const nl = input.indexOf('\n', i + 2);
      if (nl === -1) {
        out += input.slice(i);
        i = input.length;
      } else {
        out += input.slice(i, nl + 1);
        i = nl + 1;
      }
      continue;
    }

    // 4) Block comment (/* ... */)
    if (ch === '/' && input[i + 1] === '*') {
      const close = input.indexOf('*/', i + 2);
      if (close === -1) {
        out += input.slice(i);
        i = input.length;
      } else {
        out += input.slice(i, close + 2);
        i = close + 2;
      }
      continue;
    }

    // 5) Positional placeholder ? -> $1, $2, ...
    if (ch === '?') {
      paramIdx += 1;
      out += `$${paramIdx}`;
      i += 1;
      continue;
    }

    // 6) SQLite datetime('now') and datetime('now', '+/-N unit')
    if (
      (ch === 'd' || ch === 'D') &&
      /^datetime\s*\(\s*'now'\s*(?:,\s*'([+-]?\d+\s+(?:second|seconds|minute|minutes|hour|hours|day|days))'\s*)?\)/i.test(
        input.slice(i)
      )
    ) {
      const m = input
        .slice(i)
        .match(
          /^datetime\s*\(\s*'now'\s*(?:,\s*'([+-]?\d+\s+(?:second|seconds|minute|minutes|hour|hours|day|days))'\s*)?\)/i
        )!;
      if (m[1]) {
        const offset = m[1].trim();
        if (offset.startsWith('-')) {
          out += `(NOW() - INTERVAL '${offset.slice(1).trim()}')`;
        } else {
          out += `(NOW() + INTERVAL '${offset.replace(/^\+/, '').trim()}')`;
        }
      } else {
        out += 'NOW()';
      }
      i += m[0].length;
      continue;
    }

    out += ch;
    i += 1;
  }

  // Normalize known SQLite idioms and integer-boolean comparisons outside quotes
  out = rewriteOutsideLiterals(out, (segment) =>
    segment
      .replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, 'INSERT INTO')
      .replace(/\b(archived|is_server_env)\s*=\s*0\b/gi, '$1 = FALSE')
      .replace(/\b(archived|is_server_env)\s*=\s*1\b/gi, '$1 = TRUE')
      .replace(/,\s*(?:[a-zA-Z_][a-zA-Z0-9_]*\.)?rowid\s+(?:ASC|DESC)\b/gi, '')
      .replace(/\bORDER\s+BY\s+([a-zA-Z_][a-zA-Z0-9_]*\.)?rowid\s+(ASC|DESC)\b/gi, 'ORDER BY $1created_at $2')
  );

  if (/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i.test(input) && !/\bON\s+CONFLICT\b/i.test(out)) {
    const trailingSemi = out.trimEnd().endsWith(';');
    out = out.trimEnd().replace(/;$/, '') + ' ON CONFLICT DO NOTHING' + (trailingSemi ? ';' : '');
  }

  return out;
}

export function dbBool(dialect: 'sqlite' | 'postgres', value: unknown): boolean | number {
  const b = Boolean(value);
  return dialect === 'postgres' ? b : b ? 1 : 0;
}

function rewriteOutsideLiterals(sql: string, transform: (chunk: string) => string): string {
  let result = '';
  let i = 0;
  let plainStart = 0;

  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      if (i > plainStart) {
        result += transform(sql.slice(plainStart, i));
      }
      const quote = ch;
      let end = i + 1;
      while (end < sql.length) {
        if (sql[end] === quote && sql[end + 1] === quote) {
          end += 2;
          continue;
        }
        if (sql[end] === quote) {
          end += 1;
          break;
        }
        end += 1;
      }
      result += sql.slice(i, end);
      i = end;
      plainStart = end;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      if (i > plainStart) result += transform(sql.slice(plainStart, i));
      const nl = sql.indexOf('\n', i + 2);
      const end = nl === -1 ? sql.length : nl + 1;
      result += sql.slice(i, end);
      i = end;
      plainStart = end;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      if (i > plainStart) result += transform(sql.slice(plainStart, i));
      const close = sql.indexOf('*/', i + 2);
      const end = close === -1 ? sql.length : close + 2;
      result += sql.slice(i, end);
      i = end;
      plainStart = end;
      continue;
    }
    i += 1;
  }

  if (plainStart < sql.length) {
    result += transform(sql.slice(plainStart));
  }
  return result;
}

/**
 * Parses a column that may be a JSON string (SQLite TEXT) OR an already-parsed object/array (PostgreSQL JSONB).
 */
export function parseJsonColumn<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined || raw === '') return fallback;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed === null || parsed === undefined ? fallback : (parsed as T);
    } catch {
      return fallback;
    }
  }
  if (typeof raw === 'object') {
    return raw as T;
  }
  return fallback;
}

/**
 * Normalizes boolean fields across SQLite (0/1 integer) and PostgreSQL (boolean).
 */
export function toBooleanFlag(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw === 1;
  if (typeof raw === 'string') {
    const clean = raw.trim().toLowerCase();
    return clean === '1' || clean === 'true' || clean === 't';
  }
  return false;
}

/**
 * Normalizes timestamp values across SQLite (`YYYY-MM-DD HH:MM:SS` or ISO) and PostgreSQL (`Date` or ISO).
 */
export function toIsoTimestamp(raw: unknown): string {
  if (raw instanceof Date) return raw.toISOString();
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return new Date(0).toISOString();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)) {
      return `${trimmed.replace(' ', 'T')}Z`;
    }
    return trimmed;
  }
  return String(raw ?? '');
}

/**
 * Detects unique constraint violation across `node:sqlite` and `pg`.
 */
export function isUniqueConstraintError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const rec = err as { code?: string; message?: string };
  if (rec.code === '23505' || rec.code === 'ERR_SQLITE_CONSTRAINT_UNIQUE') return true;
  return /unique constraint failed|duplicate key value violates unique constraint/i.test(String(rec.message || ''));
}

/**
 * Detects foreign-key constraint violation across `node:sqlite` and `pg`.
 */
export function isForeignKeyError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const rec = err as { code?: string; message?: string };
  if (rec.code === '23503' || rec.code === 'ERR_SQLITE_CONSTRAINT_FOREIGNKEY') return true;
  return /foreign key constraint/i.test(String(rec.message || ''));
}
