import { allowlistCheck } from "./allowlist.js";
import { budgetCheck } from "./budget.js";
import { killSwitchCheck } from "./killSwitch.js";
import { velocityCheck } from "./velocity.js";
import type { Check } from "../types.js";

// Order is a security property: authorization, then destination, then amount, then pace —
// a payment that is over budget reports the permanent refusal, not the one that means "wait".
export const CHECKS: readonly Check[] = [killSwitchCheck, allowlistCheck, budgetCheck, velocityCheck];

export { allowlistCheck, budgetCheck, killSwitchCheck, velocityCheck };
