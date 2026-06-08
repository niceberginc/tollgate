import {
  ToolGate,
  X402RailAdapter,
  createMcpAdapter,
} from "../../dist/index.js";

export const callerId = "x402-testnet-caller";
export const publisherKey = "tg_x402_testnet";
export const toolName = "partner_api_lookup";
export const defaultAmount = 0.3;

export function printSummary(summary) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

export function parseJsonEnv(name) {
  const raw = process.env[name];
  return raw ? JSON.parse(raw) : null;
}

export function getNetworkFromEnv({ requireValue = false } = {}) {
  const caip2 = process.env.X402_NETWORK_CAIP2;
  if (requireValue && !caip2) {
    throw new Error("X402_NETWORK_CAIP2 is required");
  }

  return {
    kind: "evm",
    caip2: caip2 ?? "eip155:84532",
  };
}

export function createAdapter({ facilitatorUrl, payTo, network }) {
  return new X402RailAdapter({
    payTo,
    network,
    facilitatorUrl,
    x402Version: 2,
    maxTimeoutSeconds: 60,
  });
}

export function createRegistration(gate, duplicateKeys) {
  const mcp = createMcpAdapter(gate, {
    includeMeta: true,
    getCallerId: () => callerId,
  });

  return mcp.paidTool(toolName, {
    description: "x402 testnet acceptance scenario",
    inputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string" },
        query: { type: "string" },
      },
      required: ["requestId", "query"],
    },
    price: defaultAmount,
    onPaymentFailed: "fallback",
    idempotencyKey: (args, currentCallerId) =>
      `${toolName}:${currentCallerId}:${String(args.requestId)}`,
    onDuplicateDetected: async (_input, record) => {
      duplicateKeys.push(record.key);
    },
    handler: async (args) => ({
      mode: "premium",
      requestId: args.requestId,
      payload: {
        provider: "partner-api",
        answer: `premium:${args.query}`,
      },
    }),
    fallback: async (args) => ({
      mode: "fallback",
      requestId: args.requestId,
      preview: {
        answer: `fallback:${args.query}`,
      },
    }),
  });
}

export function createBlockingRegistration(gate) {
  const mcp = createMcpAdapter(gate, {
    includeMeta: true,
    getCallerId: () => callerId,
  });

  return mcp.paidTool(`${toolName}_blocking`, {
    description: "x402 testnet Toolgate challenge scenario",
    inputSchema: {
      type: "object",
      properties: {
        requestId: { type: "string" },
        query: { type: "string" },
      },
      required: ["requestId", "query"],
    },
    price: defaultAmount,
    onPaymentFailed: "block",
    idempotencyKey: (args, currentCallerId) =>
      `${toolName}_blocking:${currentCallerId}:${String(args.requestId)}`,
    handler: async (args) => ({
      mode: "premium",
      requestId: args.requestId,
      payload: {
        provider: "partner-api",
        answer: `premium:${args.query}`,
      },
    }),
  });
}

export function createRuntime(options = {}) {
  const network = options.network ?? getNetworkFromEnv();
  const duplicateKeys = options.duplicateKeys ?? [];
  const adapter = createAdapter({
    facilitatorUrl: options.facilitatorUrl ?? process.env.X402_FACILITATOR_URL,
    payTo: options.payTo ?? process.env.X402_PAY_TO,
    network,
  });
  const gate = new ToolGate({
    publisherKey,
    paymentRails: ["x402"],
    railAdapters: [adapter],
  });

  return {
    adapter,
    gate,
    network,
    duplicateKeys,
    registration: createRegistration(gate, duplicateKeys),
    blockingRegistration: createBlockingRegistration(gate),
  };
}

export function buildProofMeta(proof, facilitatorUrl) {
  const accepted = proof?.payload?.accepted;

  return {
    toolgate: {
      x402ActionId: proof.actionId,
      x402Payment: proof.payload,
      x402PaymentRequirements: accepted,
      providerId: facilitatorUrl,
    },
  };
}

export function extractPaymentRequiredDetails(result) {
  const toolgateMeta = result?._meta?.toolgate;
  const x402Challenge = result?._meta?.x402;
  if (
    !toolgateMeta?.paymentRequired ||
    !toolgateMeta?.x402ActionId ||
    !x402Challenge
  ) {
    return null;
  }

  return {
    error: "payment_required",
    paymentRequired: {
      error: "payment_required",
      settlements: [
        {
          rail: "x402",
          actionId: toolgateMeta.x402ActionId,
          x402PaymentRequired: x402Challenge,
        },
      ],
      x402Challenge,
    },
  };
}
