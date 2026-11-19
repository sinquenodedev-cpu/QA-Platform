import mysql from "mysql2/promise";
import { config } from "./config.js";

// Dates are read and written as UTC, like the backend.
const makePool = db => mysql.createPool({ ...db, timezone: "Z", connectionLimit: 5 });
// `let`: importers see the new pool after the Settings page changes the database.
export let pool = makePool(config.db);

/** Switch to the database now in config (after Settings saved). The old pool closes once idle. */
export const resetPool = () => {
  const old = pool;
  pool = makePool(config.db);
  old.end().catch(() => {});
};

/** Can we sign in to this database, and does it look like Sinque? Used before saving. */
export const testDatabase = async db => {
  const conn = await mysql.createConnection({ ...db, timezone: "Z", connectTimeout: 10000 });
  try {
    const [[{ users }]] = await conn.query("SELECT COUNT(*) AS users FROM users");
    return { users: Number(users) };
  } finally {
    conn.end().catch(() => {});
  }
};

export const query = async (sql, params = []) => {
  const [rows] = await pool.query(sql, params);
  return rows;
};

/** Run `fn(conn)` in a transaction. */
export const transaction = async fn => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
};

/** An error caused by the request (bad input, missing record): answered with 400, not logged as a crash. */
export const badRequest = message => Object.assign(new Error(message), { status: 400 });
