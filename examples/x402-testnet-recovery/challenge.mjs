import assert from "node:assert/strict";
import {
  callerId,
  createRuntime,
  defaultAmount,
  extractPaymentRequiredDetails,
  getNetworkFromEnv,
  printSummary,
  publisherKey,
  toolName,
} from "./_shared.mjs";

const requiredEnv = [
  "X402_FACILITATOR_URL",
  "X402_PAY_TO",
  "X402_NETWORK_CAIP2",
];

function readRequestId(argv) {
  const index = argv.indexOf("--request-id");
  if (index === -1) {
    return "x402-required-001";
  }

  const value = argv[index + 1];
  if (!value) {
    throw new Error("--request-id requires a value");
  }

  return value;
}

async function run() {
  const missing = requiredEnv.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    printSummary({
      blocked: true,
      blocker: {
        reason: "missing_env",
        required: requiredEnv,
        missing,
      },
    });
    return;
  }

  const network = getNetworkFromEnv({ requireValue: true });
  const requestId = readRequestId(process.argv.slice(2));
  const { blockingRegistration } = createRuntime({ network });
  const paymentRequiredResult = await blockingRegistration.handler(
    {
      requestId,
      query: "vector cache",
    },
    {
      sessionId: callerId,
    },
  );

  assert.equal(paymentRequiredResult.isError, true);

  const paymentRequiredContent = extractPaymentRequiredDetails(
    paymentRequiredResult,
  );
  assert.ok(paymentRequiredContent);
  const x402Settlement =
    paymentRequiredContent.paymentRequired?.settlements?.find(
      (entry) => entry.rail === "x402",
    ) ?? null;

  assert.ok(x402Settlement);
  assert.ok(x402Settlement.actionId);
  assert.ok(x402Settlement.x402PaymentRequired);
  assert.ok(x402Settlement.x402PaymentRequired.accepts?.[0]);

  printSummary({
    actionId: x402Settlement.actionId,
    callerId,
    publisherKey,
    toolName: `${toolName}_blocking`,
    requestId,
    x402PaymentRequired: x402Settlement.x402PaymentRequired,
    paymentRequirements: x402Settlement.x402PaymentRequired.accepts[0],
    network,
    payTo: process.env.X402_PAY_TO,
    amount: defaultAmount,
  });
}

await run();
