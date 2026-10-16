import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BurnBouncer, MAX_SAFE_USD } from './index.js';

describe('BurnBouncer Security & Integer Micro-USD Accounting Suite', () => {
  let bouncer: BurnBouncer;
  let tempDir: string | null = null;

  beforeEach(() => {
    bouncer = new BurnBouncer({ maxOpexLimit: 10, rollingWindowMs: 60000 });
  });

  afterEach(() => {
    bouncer.close();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('1. allows zero-cost execution without increasing spend', () => {
    assert.strictEqual(bouncer.authorizeExecution(0), true);
    assert.strictEqual(bouncer.getCurrentBurn(), 0);
    assert.strictEqual(bouncer.getCurrentBurnMicro(), 0);
  });

  it('2. allows normal positive costs and tracks spend accurately', () => {
    assert.doesNotThrow(() => bouncer.authorizeExecution(5));
    assert.strictEqual(bouncer.getCurrentBurn(), 5);
    assert.strictEqual(bouncer.getCurrentBurnMicro(), 5_000_000);
  });

  it('3. handles fractional micro-USD rounding and eliminates IEEE-754 drift', () => {
    const fb = new BurnBouncer({ maxOpexLimit: 0.3, rollingWindowMs: 60000 });
    // In IEEE-754 float: 0.1 + 0.2 = 0.30000000000000004 > 0.3!
    // With integer micro-USD: 100,000 + 200,000 = 300,000 <= 300,000.
    assert.strictEqual(fb.authorizeExecution(0.1), true);
    assert.strictEqual(fb.authorizeExecution(0.2), true);
    assert.strictEqual(fb.getCurrentBurn(), 0.3);
    assert.strictEqual(fb.getCurrentBurnMicro(), 300_000);

    // Sub-micro-USD rounding: 0.0000014 rounds to 1 micro-USD; 0.0000016 rounds to 2 micro-USD
    const subBouncer = new BurnBouncer({ maxOpexLimit: 1, rollingWindowMs: 60000 });
    subBouncer.authorizeExecution(0.0000014);
    assert.strictEqual(subBouncer.getCurrentBurnMicro(), 1);
    subBouncer.authorizeExecution(0.0000016);
    assert.strictEqual(subBouncer.getCurrentBurnMicro(), 3);

    fb.close();
    subBouncer.close();
  });

  it('4. allows spend up to the exact budget boundary', () => {
    assert.strictEqual(bouncer.authorizeExecution(4.25), true);
    assert.strictEqual(bouncer.authorizeExecution(5.75), true);
    assert.strictEqual(bouncer.getCurrentBurn(), 10);
    assert.strictEqual(bouncer.getCurrentBurnMicro(), 10_000_000);
  });

  it('5. rejects exceeding the budget by exactly one micro-USD (0.000001)', () => {
    bouncer.authorizeExecution(10);
    assert.throws(() => bouncer.authorizeExecution(0.000001), /CIRCUIT BROKEN/);
    assert.strictEqual(bouncer.getCurrentBurn(), 10);
  });

  it('6. handles repeated authorizations and rolling-window pruning', async () => {
    const shortWindow = new BurnBouncer({ maxOpexLimit: 2, rollingWindowMs: 50 });
    assert.strictEqual(shortWindow.authorizeExecution(1), true);
    assert.strictEqual(shortWindow.authorizeExecution(1), true);
    assert.throws(() => shortWindow.authorizeExecution(1), /CIRCUIT BROKEN/);

    await new Promise((r) => setTimeout(r, 70));
    assert.strictEqual(shortWindow.getCurrentBurn(), 0);
    assert.strictEqual(shortWindow.authorizeExecution(2), true);
    shortWindow.close();
  });

  it('7. enforces strict budget ceiling under concurrent authorizations across connections', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'bouncer-concurrent-'));
    const dbPath = join(tempDir, 'burn.db');

    const b1 = new BurnBouncer({ maxOpexLimit: 10, rollingWindowMs: 60000, storagePath: dbPath });
    const b2 = new BurnBouncer({ maxOpexLimit: 10, rollingWindowMs: 60000, storagePath: dbPath });

    let successes = 0;
    const tasks = Array.from({ length: 100 }, (_, idx) =>
      Promise.resolve().then(() => {
        const instance = idx % 2 === 0 ? b1 : b2;
        try {
          if (instance.authorizeExecution(1)) {
            successes++;
          }
        } catch {
          // Expected circuit breaker rejection once limit (10) is reached
        }
      })
    );

    await Promise.all(tasks);
    assert.strictEqual(successes, 10);
    assert.strictEqual(b1.getCurrentBurn(), 10);
    assert.strictEqual(b2.getCurrentBurn(), 10);

    b1.close();
    b2.close();
  });

  it('8. persists accumulated spend across process/instance restarts', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'bouncer-persist-'));
    const dbPath = join(tempDir, 'burn.db');

    const first = new BurnBouncer({ maxOpexLimit: 10, rollingWindowMs: 60000, storagePath: dbPath });
    first.authorizeExecution(6.5);
    assert.strictEqual(first.getCurrentBurn(), 6.5);
    first.close();

    // Reopen against the same file
    const reopened = new BurnBouncer({ maxOpexLimit: 10, rollingWindowMs: 60000, storagePath: dbPath });
    assert.strictEqual(reopened.getCurrentBurn(), 6.5);
    // Attempting 4.0 must fail because 6.5 + 4.0 > 10.0
    assert.throws(() => reopened.authorizeExecution(4.0), /CIRCUIT BROKEN/);
    // Attempting 3.5 succeeds
    assert.strictEqual(reopened.authorizeExecution(3.5), true);
    assert.strictEqual(reopened.getCurrentBurn(), 10);
    reopened.close();
  });

  it('9. rejects invalid and extreme numeric inputs', () => {
    assert.throws(() => bouncer.authorizeExecution(-5), /CIRCUIT BROKEN/);
    assert.throws(() => bouncer.authorizeExecution(-0.000001), /CIRCUIT BROKEN/);
    assert.throws(() => bouncer.authorizeExecution(NaN), /CIRCUIT BROKEN/);
    assert.throws(() => bouncer.authorizeExecution(Infinity), /CIRCUIT BROKEN/);
    assert.throws(() => bouncer.authorizeExecution(-Infinity), /CIRCUIT BROKEN/);
    assert.throws(() => bouncer.authorizeExecution('5' as any), /CIRCUIT BROKEN/);
    assert.throws(() => bouncer.authorizeExecution(MAX_SAFE_USD + 1), /CIRCUIT BROKEN/);

    assert.throws(() => new BurnBouncer({ costLimit: 10 } as any), /Invalid configuration/);
    assert.throws(() => new BurnBouncer({ maxOpexLimit: -1, rollingWindowMs: 1000 }), /Invalid configuration/);
    assert.throws(() => new BurnBouncer({ maxOpexLimit: 10, rollingWindowMs: 0 }), /Invalid configuration/);
  });

  it('10. rolls back transaction cleanly when authorization fails', () => {
    bouncer.authorizeExecution(8);
    assert.throws(() => bouncer.authorizeExecution(5), /CIRCUIT BROKEN/);
    // Balance must remain 8 and subsequent valid transaction must succeed (no dangling transaction)
    assert.strictEqual(bouncer.getCurrentBurn(), 8);
    assert.strictEqual(bouncer.authorizeExecution(2), true);
    assert.strictEqual(bouncer.getCurrentBurn(), 10);
  });

  it('11. handles closed database connections predictably', () => {
    const tempBouncer = new BurnBouncer({ maxOpexLimit: 10, rollingWindowMs: 60000 });
    tempBouncer.close();
    // Second close is idempotent
    assert.doesNotThrow(() => tempBouncer.close());
    assert.throws(() => tempBouncer.authorizeExecution(1), /Database connection is closed/);
    assert.throws(() => tempBouncer.getCurrentBurn(), /Database connection is closed/);
  });

  it('12. isolates ephemeral in-memory instances', () => {
    const memA = new BurnBouncer({ maxOpexLimit: 10, rollingWindowMs: 60000, storagePath: ':memory:' });
    const memB = new BurnBouncer({ maxOpexLimit: 10, rollingWindowMs: 60000, storagePath: ':memory:' });
    memA.authorizeExecution(7);
    assert.strictEqual(memA.getCurrentBurn(), 7);
    assert.strictEqual(memB.getCurrentBurn(), 0);
    memA.close();
    memB.close();
  });

  it('13. supports reservation, commit, and release on downstream failure', () => {
    const r1 = bouncer.reserveExecution(6);
    assert.strictEqual(bouncer.getCurrentBurn(), 6);
    // Competing authorization sees the reservation and blocks overspend
    assert.throws(() => bouncer.authorizeExecution(5), /CIRCUIT BROKEN/);

    // Downstream failure releases the reservation
    assert.strictEqual(bouncer.releaseReservation(r1.reservationId), true);
    assert.strictEqual(bouncer.getCurrentBurn(), 0);

    // Subsequent reservation and commit
    const r2 = bouncer.reserveExecution(5);
    assert.strictEqual(bouncer.commitReservation(r2.reservationId), true);
    // Committed reservation cannot be released
    assert.strictEqual(bouncer.releaseReservation(r2.reservationId), false);
    assert.strictEqual(bouncer.getCurrentBurn(), 5);
  });
});
