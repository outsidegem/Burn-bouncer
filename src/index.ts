export interface BouncerConfig {
  maxOpexLimit: number;      // Maximum allowed spend in USD
  rollingWindowMs: number;   // Timeframe to track (e.g., 3600000 for 1 hour)
}

export interface CostRecord {
  timestamp: number;
  cost: number;
}

export class BurnBouncer {
  private config: BouncerConfig;
  private executionLog: CostRecord[] = [];
  private currentBurn: number = 0;

  constructor(config: BouncerConfig) {
    this.config = config;
  }

  private pruneWindow(): void {
    const now = Date.now();
    const cutoff = now - this.config.rollingWindowMs;
    
    while (this.executionLog.length > 0 && this.executionLog[0].timestamp < cutoff) {
      const removed = this.executionLog.shift();
      if (removed) {
        this.currentBurn -= removed.cost;
      }
    }
  }

  public authorizeExecution(projectedCost: number): boolean {
    this.pruneWindow();

    if (this.currentBurn + projectedCost > this.config.maxOpexLimit) {
      throw new Error(`[BURN-BOUNCER] CIRCUIT BROKEN: Projected OPEX (${this.currentBurn + projectedCost}) exceeds limit (${this.config.maxOpexLimit}). Connection Hard-Killed.`);
    }

    this.executionLog.push({ timestamp: Date.now(), cost: projectedCost });
    this.currentBurn += projectedCost;
    
    return true;
  }

  public getCurrentBurn(): number {
    this.pruneWindow();
    return this.currentBurn;
  }
}
