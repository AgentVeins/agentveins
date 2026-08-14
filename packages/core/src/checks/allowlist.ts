import type { Check } from "../types.js";

export const allowlistCheck: Check = (ctx, policy) => {
  if (policy.vendors.entries.includes(ctx.vendorNormalized)) {
    return null;
  }
  // The vendor is untrusted input, so it travels in `detail` and never in the message.
  return {
    code: "vendor_not_allowed",
    message: "the vendor is not on the allowlist",
    detail: { vendor: ctx.vendorNormalized },
  };
};
