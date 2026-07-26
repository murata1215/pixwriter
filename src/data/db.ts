import pg from "pg";
const { Pool } = pg;

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      host: "localhost",
      database: "pixdata",
      user: "pixwriter_ro",
      // password is not set here — node-postgres will fall back to ~/.pgpass
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
  if (pool) {
    await pool.end();
    pool = null;
  }
}
