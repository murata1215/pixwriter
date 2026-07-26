import pg from "pg";
const { Pool } = pg;

let readPool: pg.Pool | null = null;
let writePool: pg.Pool | null = null;

/** Read-only pool (pixwriter_ro) for data queries. */
function getReadPool(): pg.Pool {
  if (!readPool) {
    readPool = new Pool({
      host: "localhost",
      database: "pixdata",
      user: "pixwriter_ro",
      // password via ~/.pgpass
    });
  }
  return readPool;
}

/** Write pool (pixwriter_user) for article/citation inserts. */
function getWritePool(): pg.Pool {
  if (!writePool) {
    writePool = new Pool({
      host: "localhost",
      database: "pixdata",
      user: "pixwriter_user",
      // password via ~/.pgpass
    });
  }
  return writePool;
}

/** Read query (pixwriter_ro). */
export async function query<T extends pg.QueryResultRow>(
  sql: string,
  params?: unknown[]
): Promise<T[]> {
  const result = await getReadPool().query<T>(sql, params);
  return result.rows;
}

/** Write query (pixwriter_user) for article/citation inserts. */
export async function writeQuery<T extends pg.QueryResultRow>(
  sql: string,
  params?: unknown[]
): Promise<T[]> {
  const result = await getWritePool().query<T>(sql, params);
  return result.rows;
}

export async function end(): Promise<void> {
  if (readPool) { await readPool.end(); readPool = null; }
  if (writePool) { await writePool.end(); writePool = null; }
}
