import pg from "pg";
const { Pool } = pg;

let pool: pg.Pool | null = null;

/** Single pool (pixwriter_ro) for all queries including article/citation writes. */
function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      host: "localhost",
      database: "pixdata",
      user: "pixwriter_ro",
      // password via ~/.pgpass
    });
  }
  return pool;
}

export async function query<T extends pg.QueryResultRow>(
  sql: string,
  params?: unknown[]
): Promise<T[]> {
  const result = await getPool().query<T>(sql, params);
  return result.rows;
}

export async function end(): Promise<void> {
  if (pool) { await pool.end(); pool = null; }
}
