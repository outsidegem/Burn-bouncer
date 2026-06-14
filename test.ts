import { BurnBouncer } from './src/index.js';

// Initialize the firewall: $1.00 max spend per 60 seconds
const firewall = new BurnBouncer({
  maxOpexLimit: 1.00,
  rollingWindowMs: 60000 
});

console.log("=============================================");
console.log("🛡️ TITAN FIREWALL: BURN-RATE BOUNCER ONLINE");
console.log("=============================================");

try {
  console.log("[AGENT]: Attempting low-cost data retrieval ($0.20)...");
  firewall.authorizeExecution(0.20);
  console.log("✅ BOUNCER: Allowed. Current Burn: $", firewall.getCurrentBurn());

  console.log("\n[AGENT]: Attempting standard API call ($0.50)...");
  firewall.authorizeExecution(0.50);
  console.log("✅ BOUNCER: Allowed. Current Burn: $", firewall.getCurrentBurn());

  console.log("\n[AGENT ROGUE]: Hallucinating... attempting massive parallel query ($0.80)...");
  firewall.authorizeExecution(0.80);
  
  console.log("\n❌ CRITICAL FAILURE: The firewall failed to block the overspend!");
} catch (error: any) {
  console.log("\n🛑 BOUNCER ENGAGED:", error.message);
  console.log("🔒 FUNDS SECURED. Final Burn: $", firewall.getCurrentBurn());
}
console.log("=============================================");
