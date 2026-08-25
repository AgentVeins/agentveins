/**
 * Prints the x402 handshake as it happens.
 *
 * x402 is an HTTP protocol, so none of it is visible on-chain: an explorer shows an ordinary SPL
 * transfer and can never label it x402. The negotiation — the 402 quote, the signed payload in
 * `X-PAYMENT`, the settlement in `X-PAYMENT-RESPONSE` — happens here and nowhere else, so the
 * demo shows it rather than asserting it happened.
 *
 * Everything the vendor sends is untrusted: it names the price, the recipient, and the fee payer,
 * and a hijacked endpoint would name its own. It is truncated and quoted on the way to the
 * terminal, exactly as violation messages are.
 */
type Logger = (line: string) => void;

const FIELD_MAX = 44;
const HEADER_PREVIEW = 32;

function safe(value: string, max = FIELD_MAX): string {
  return JSON.stringify(value.length > max ? `${value.slice(0, max - 1)}…` : value);
}

/** Middles-out an address so both ends stay checkable against an explorer. */
function abbreviate(value: string, keep = 6): string {
  return value.length <= keep * 2 + 1 ? value : `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

function formatUsdc(minor: string): string {
  const parsed = /^\d+$/.test(minor) ? BigInt(minor) : null;
  if (parsed === null) {
    return safe(minor);
  }
  const whole = parsed / 1_000_000n;
  const fraction = (parsed % 1_000_000n).toString().padStart(6, "0");
  return `${whole.toString()}.${fraction}`;
}

interface Quote {
  scheme?: unknown;
  network?: unknown;
  maxAmountRequired?: unknown;
  payTo?: unknown;
  asset?: unknown;
  extra?: { feePayer?: unknown };
}

function logQuote(log: Logger, quote: Quote): void {
  const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
  const price = str(quote.maxAmountRequired);
  const payTo = str(quote.payTo);
  const asset = str(quote.asset);
  const feePayer = str(quote.extra?.feePayer);

  log(`       scheme    ${safe(str(quote.scheme) ?? "(absent)")}`);
  log(`       network   ${safe(str(quote.network) ?? "(absent)")}`);
  if (price !== null) {
    log(`       price     ${formatUsdc(price)} USDC  (maxAmountRequired ${safe(price, 20)})`);
  }
  if (payTo !== null) {
    log(`       payTo     ${abbreviate(payTo)}`);
  }
  if (asset !== null) {
    log(`       asset     ${abbreviate(asset)}`);
  }
  if (feePayer !== null) {
    log(`       feePayer  ${abbreviate(feePayer)}   ← pays the fee and broadcasts; not the agent`);
  }
}

function logSettlement(log: Logger, header: string): void {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    // The stub vendor answers with a placeholder rather than a settlement. Say so plainly instead
    // of implying a payment cleared.
    log(`  ←  X-PAYMENT-RESPONSE  ${safe(header, HEADER_PREVIEW)}  (not a settlement)`);
    return;
  }

  const settled = decoded as { success?: unknown; transaction?: unknown; network?: unknown };
  const txSig = typeof settled.transaction === "string" ? settled.transaction : null;
  log(`  ←  X-PAYMENT-RESPONSE  success=${String(settled.success)}`);
  if (txSig !== null && txSig !== "") {
    log(`       tx  ${txSig}`);
  }
}

/**
 * Wraps a fetch so the demo can narrate the exchange. Read-only: bodies are cloned before they
 * are read, so the adapter still receives an unconsumed response.
 */
export function tracingFetch(inner: typeof fetch, log: Logger): typeof fetch {
  return async (input, init) => {
    const payment = new Headers(init?.headers).get("X-PAYMENT");
    if (payment === null) {
      log("  →  GET /forecast   (no payment attached)");
    } else {
      log(`  →  GET /forecast   X-PAYMENT ${safe(payment, HEADER_PREVIEW)}`);
      log(`       ${payment.length} bytes of base64: the transfer the agent signed but cannot broadcast`);
    }

    const response = await inner(input, init);

    if (response.status === 402) {
      log("  ←  402 Payment Required");
      try {
        const body = (await response.clone().json()) as { accepts?: Quote[] };
        const quote = body.accepts?.[0];
        if (quote !== undefined) {
          logQuote(log, quote);
        }
      } catch {
        log("       (the endpoint returned a body this demo could not read as a quote)");
      }
      return response;
    }

    log(`  ←  ${response.status} ${response.statusText}`);
    const settlement =
      response.headers.get("x-payment-response") ?? response.headers.get("payment-response");
    if (settlement !== null) {
      logSettlement(log, settlement);
    }
    return response;
  };
}
