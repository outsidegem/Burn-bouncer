import { DatabaseSync } from 'node:sqlite';

export interface BouncerConfig {
  /** Maximum allowed spend in USD within rollingWindowMs. */
  maxOpexLimit: number;
  /** Rolling window duration in milliseconds (e.g. 3600000 for 1 hour). */
  rollingWindowMs: number;
  /**
   * SQLite database path. Defaults to `':memory:'` when omitted.
   * Pass a file path (e.g. `'.burn-bouncer.db'`) to persist spend across restarts.
   */
  storagePath?: string;
  /** SQLite busy timeout in milliseconds for competing writers. Default 5000. */
  busyTimeoutMs?: number;
}

export interface CostRecord {
  timestamp: number;
  cost: number;
}

export interface BurnReservation {
  reservationId: number;
  costMicroUsd: number;
  costUsd: number;
  timestamp: number;
}

export const MICRO_USD = 1_000_000;
export const MAX_SAFE_USD = Math.floor(Number.MAX_SAFE_INTEGER / MICRO_USD);

/**
 * Rolling OPEX circuit breaker backed by `node:sqlite` (`DatabaseSync`).
 *
 * Accounting Model & Rounding Semantics:
 * - All USD inputs are converted to integer micro-USD (`1 USD = 1,000,000 micro-USD`)
 *   via `Math.round(usd * 1_000_000)`.
 * - Budget comparisons and storage use exact 64-bit safe integers in SQLite,
 *   eliminating IEEE-754 floating-point accumulation drift.
 * - Each authorization or reservation runs inside a `BEGIN IMMEDIATE` transaction so
 *   concurrent writers cannot authorize against a stale balance.
 */
export class BurnBouncer {
  private config: BouncerConfig;
  private db: DatabaseSync;
  private maxOpexLimitMicro: number;
  private closed = false;
  public readonly storagePath: string;

  constructor(config: BouncerConfig) {
    if (
      !config ||
      typeof config.maxOpexLimit !== 'number' ||
      !Number.isFinite(config.maxOpexLimit) ||
      config.maxOpexLimit < 0 ||
      config.maxOpexLimit > MAX_SAFE_USD ||
      typeof config.rollingWindowMs !== 'number' ||
      !Number.isFinite(config.rollingWindowMs) ||
      config.rollingWindowMs <= 0
    ) {
      throw new Error(`[BURN-BOUNCER] Invalid configuration: maxOpexLimit and rollingWindowMs are required valid numbers.`);
    }
    this.config = config;
    this.maxOpexLimitMicro = Math.round(config.maxOpexLimit * MICRO_USD);
    this.storagePath = config.storagePath || ':memory:';
    this.db = new DatabaseSync(this.storagePath);
    const busyTimeout = Math.max(0, Math.floor(config.busyTimeoutMs ?? 5000));
    this.db.exec(`PRAGMA busy_timeout = ${busyTimeout};`);
    if (this.storagePath !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL;');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cost_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        costMicro INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'COMMITTED'
      );
      CREATE INDEX IF NOT EXISTS idx_cost_timestamp ON cost_records(timestamp);
    `);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('[BURN-BOUNCER] Database connection is closed.');
    }
  }

  private validateCostInput(projectedCost: number): number {
    if (
      typeof projectedCost !== 'number' ||
      Number.isNaN(projectedCost) ||
      !Number.isFinite(projectedCost) ||
      projectedCost < 0 ||
      projectedCost > MAX_SAFE_USD
    ) {
      throw new Error(`[BURN-BOUNCER] CIRCUIT BROKEN: Invalid projected cost. Connection Hard-Killed.`);
    }
    const projectedMicroUsd = Math.round(projectedCost * MICRO_USD);
    if (!Number.isSafeInteger(projectedMicroUsd) || projectedMicroUsd < 0) {
      throw new Error(`[BURN-BOUNCER] CIRCUIT BROKEN: Invalid projected cost. Connection Hard-Killed.`);
    }
    return projectedMicroUsd;
  }

  private pruneWindow(now: number = Date.now()): void {
    const cutoff = now - this.config.rollingWindowMs;
    const stmt = this.db.prepare('DELETE FROM cost_records WHERE timestamp < ?');
    stmt.run(cutoff);
  }

  public getCurrentBurnMicro(): number {
    this.assertOpen();
    this.pruneWindow();
    const stmt = this.db.prepare(
      "SELECT COALESCE(SUM(costMicro), 0) as total FROM cost_records WHERE status IN ('RESERVED', 'COMMITTED')"
    );
    const row = stmt.get() as { total: number | bigint };
    return Number(row.total);
  }

  /**
   * Authorizes and immediately records `projectedCost` (in USD) against the rolling budget.
   * Uses `BEGIN IMMEDIATE` to serialize competing writers.
   */
  public authorizeExecution(projectedCost: number): boolean {
    this.assertOpen();
    const projectedMicroUsd = this.validateCostInput(projectedCost);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const now = Date.now();
      this.pruneWindow(now);

      const stmt = this.db.prepare(
        "SELECT COALESCE(SUM(costMicro), 0) as total FROM cost_records WHERE status IN ('RESERVED', 'COMMITTED')"
      );
      const row = stmt.get() as { total: number | bigint };
      const currentBurnMicro = Number(row.total);

      if (!Number.isSafeInteger(currentBurnMicro + projectedMicroUsd)) {
        throw new Error(`[BURN-BOUNCER] CIRCUIT BROKEN: Integer overflow in burn calculation. Connection Hard-Killed.`);
      }

      if (currentBurnMicro + projectedMicroUsd > this.maxOpexLimitMicro) {
        const projectedTotal = (currentBurnMicro + projectedMicroUsd) / MICRO_USD;
        throw new Error(
          `[BURN-BOUNCER] CIRCUIT BROKEN: Projected OPEX (${projectedTotal}) exceeds limit (${this.config.maxOpexLimit}). Connection Hard-Killed.`
        );
      }

      const insertStmt = this.db.prepare(
        "INSERT INTO cost_records (timestamp, costMicro, status) VALUES (?, ?, 'COMMITTED')"
      );
      insertStmt.run(now, projectedMicroUsd);

      this.db.exec('COMMIT');
      return true;
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Ignore rollback error if transaction already aborted
      }
      throw e;
    }
  }

  /**
   * Atomically reserves `projectedCost` (in USD) before a downstream execution runs.
   * Call {@link commitReservation} on success or {@link releaseReservation} on failure.
   */
  public reserveExecution(projectedCost: number): BurnReservation {
    this.assertOpen();
    const projectedMicroUsd = this.validateCostInput(projectedCost);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const now = Date.now();
      this.pruneWindow(now);

      const stmt = this.db.prepare(
        "SELECT COALESCE(SUM(costMicro), 0) as total FROM cost_records WHERE status IN ('RESERVED', 'COMMITTED')"
      );
      const row = stmt.get() as { total: number | bigint };
      const currentBurnMicro = Number(row.total);

      if (currentBurnMicro + projectedMicroUsd > this.maxOpexLimitMicro) {
        const projectedTotal = (currentBurnMicro + projectedMicroUsd) / MICRO_USD;
        throw new Error(
          `[BURN-BOUNCER] CIRCUIT BROKEN: Projected OPEX (${projectedTotal}) exceeds limit (${this.config.maxOpexLimit}). Connection Hard-Killed.`
        );
      }

      const insertStmt = this.db.prepare(
        "INSERT INTO cost_records (timestamp, costMicro, status) VALUES (?, ?, 'RESERVED')"
      );
      const res = insertStmt.run(now, projectedMicroUsd);
      const reservationId = Number(res.lastInsertRowid);

      this.db.exec('COMMIT');
      return {
        reservationId,
        costMicroUsd: projectedMicroUsd,
        costUsd: projectedMicroUsd / MICRO_USD,
        timestamp: now
      };
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Ignore rollback error
      }
      throw e;
    }
  }

  /** Commits a previously created reservation after downstream execution succeeds. */
  public commitReservation(reservationId: number): boolean {
    this.assertOpen();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const stmt = this.db.prepare(
        "UPDATE cost_records SET status = 'COMMITTED' WHERE id = ? AND status = 'RESERVED'"
      );
      const info = stmt.run(reservationId);
      this.db.exec('COMMIT');
      return Number(info.changes) > 0;
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Ignore
      }
      throw e;
    }
  }

  /** Releases a previously created reservation when downstream execution fails. */
  public releaseReservation(reservationId: number): boolean {
    this.assertOpen();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const stmt = this.db.prepare("DELETE FROM cost_records WHERE id = ? AND status = 'RESERVED'");
      const info = stmt.run(reservationId);
      this.db.exec('COMMIT');
      return Number(info.changes) > 0;
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Ignore
      }
      throw e;
    }
  }

  public getCurrentBurn(): number {
    return this.getCurrentBurnMicro() / MICRO_USD;
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
