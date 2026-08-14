import { allowlistCheck } from "./allowlist.js";
import { budgetCheck } from "./budget.js";
import { killSwitchCheck } from "./killSwitch.js";
import type { Check } from "../types.js";

// Order is a security property: authorization, then destination, then amount.
export const CHECKS: readonly Check[] = [killSwitchCheck, allowlistCheck, budgetCheck];

export { allowlistCheck, budgetCheck, killSwitchCheck };
