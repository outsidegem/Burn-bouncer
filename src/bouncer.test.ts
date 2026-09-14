import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import { BurnBouncer } from './index.js';

describe('BurnBouncer Security Tests', () => {
  let bouncer: BurnBouncer;

  beforeEach(() => {
    bouncer = new BurnBouncer({ maxOpexLimit: 10, rollingWindowMs: 60000 });
  });

  it('allows valid costs', () => {
    assert.doesNotThrow(() => bouncer.authorizeExecution(5));
    assert.strictEqual(bouncer.getCurrentBurn(), 5);
  });

  it('blocks overspend', () => {
    bouncer.authorizeExecution(5);
    assert.throws(() => bouncer.authorizeExecution(6), /CIRCUIT BROKEN/);
  });

  it('rejects negative numbers', () => {
    assert.throws(() => bouncer.authorizeExecution(-5));
  });

  it('rejects NaN', () => {
    assert.throws(() => bouncer.authorizeExecution(NaN));
  });

  it('rejects Infinity', () => {
    assert.throws(() => bouncer.authorizeExecution(Infinity));
  });
  
  it('rejects non-numbers', () => {
    assert.throws(() => bouncer.authorizeExecution("5" as any));
  });

  it('handles missing config properties safely', () => {
    assert.throws(() => {
      new BurnBouncer({ costLimit: 10 } as any);
    });
  });
});
