import type { Check } from "../types.js";

export const killSwitchCheck: Check = (_ctx, _policy, state) => {
  if (!state.frozen) {
    return null;
  }
  return { code: "kill_switch", message: "the agent is frozen; every payment is blocked" };
};
