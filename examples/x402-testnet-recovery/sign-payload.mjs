import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stdin } from "node:process";
import { printSummary } from "./_shared.mjs";

const requiredEnv = ["X402_SIGNER_PRIVATE_KEY", "X402_RPC_URL"];

const defaultEip712Domains = {
  "eip155:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": {
    name: "USD Coin",
    version: "2",
  },
  "eip155:84532:0x036cbd53842c5426634e7929541ec2318f3dcf7e": {
    name: "USDC",
    version: "2",
  },
};

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk) => chunks.push(chunk));
    stdin.on("end", () => resolve(chunks.join("")));
    stdin.on("error", reject);
  });
}

async function readChallengeJson() {
  const inputPath = process.argv[2];
  if (inputPath) {
    return await readFile(inputPath, "utf8");
  }

  if (process.stdin.isTTY) {
    throw new Error(
      "Pass a challenge JSON file path as the first argument or pipe the challenge JSON to stdin.",
    );
  }

  return await readStdin();
}

async function loadSignerModules() {
  try {
    const [coreClient, evmClient, viem, viemAccounts] = await Promise.all([
      import("@x402/core/client"),
      import("@x402/evm"),
      import("viem"),
      import("viem/accounts"),
    ]);

    return {
      x402Client: coreClient.x402Client,
      ExactEvmScheme: evmClient.ExactEvmScheme,
      toClientEvmSigner: evmClient.toClientEvmSigner,
      createPublicClient: viem.createPublicClient,
      http: viem.http,
      privateKeyToAccount: viemAccounts.privateKeyToAccount,
    };
  } catch {
    throw new Error(
      "x402 SDK import failed. Check installed @x402/* package versions and exports.",
    );
  }
}

function normalizePaymentRequirements(paymentRequirements) {
  const domainKey = `${paymentRequirements.network}:${String(paymentRequirements.asset).toLowerCase()}`;
  const defaultDomain = defaultEip712Domains[domainKey] ?? null;
  return {
    scheme: paymentRequirements.scheme,
    network: paymentRequirements.network,
    asset: paymentRequirements.asset,
    amount: paymentRequirements.amount ?? paymentRequirements.maxAmountRequired,
    payTo: paymentRequirements.payTo,
    maxTimeoutSeconds: paymentRequirements.maxTimeoutSeconds,
    extra: {
      ...(defaultDomain ?? {}),
      ...(paymentRequirements.extra ?? {}),
    },
  };
}

function buildPaymentRequired(challenge) {
  return {
    x402Version: challenge.x402PaymentRequired?.x402Version ?? 2,
    resource: {
      url: challenge.paymentRequirements.resource,
      description: challenge.paymentRequirements.description,
    },
    accepts: [normalizePaymentRequirements(challenge.paymentRequirements)],
  };
}

function formatSigningError(error) {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("x402 SDK import failed")) {
    return message;
  }

  if (/EIP-712 domain parameters|missing.*name.*version/i.test(message)) {
    return "x402 signing failed. Likely reason: token EIP-712 domain metadata is missing or incomplete for this asset.";
  }

  if (/insufficient.*balance|exceeds.*balance/i.test(message)) {
    return "x402 signing failed. Likely reason: the signing wallet does not have enough testnet balance for the requested asset amount.";
  }

  if (/allowance|required|permit2_allowance_required/i.test(message)) {
    return "x402 signing failed. Likely reason: the wallet needs token allowance or Permit2 approval before the facilitator can settle.";
  }

  if (/network|chain/i.test(message) && /unsupported|mismatch/i.test(message)) {
    return "x402 signing failed. Likely reason: the challenge network does not match the configured RPC network.";
  }

  return `x402 signing failed. ${message}`;
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

  const raw = await readChallengeJson();
  const challenge = JSON.parse(raw);
  const signerModules = await loadSignerModules();

  assert.ok(challenge.actionId, "challenge.actionId is required");
  assert.ok(
    challenge.paymentRequirements,
    "challenge.paymentRequirements is required",
  );
  assert.ok(
    challenge.network?.caip2?.startsWith("eip155:"),
    "Only EVM CAIP-2 networks are supported by this helper",
  );

  const account = signerModules.privateKeyToAccount(
    process.env.X402_SIGNER_PRIVATE_KEY,
  );
  const publicClient = signerModules.createPublicClient({
    transport: signerModules.http(process.env.X402_RPC_URL),
  });
  const signer = signerModules.toClientEvmSigner(account, publicClient);
  const client = new signerModules.x402Client().register(
    challenge.network.caip2,
    new signerModules.ExactEvmScheme(signer),
  );
  const payload = await client.createPaymentPayload(
    buildPaymentRequired(challenge),
  );

  printSummary({
    actionId: challenge.actionId,
    payload,
  });
}

try {
  await run();
} catch (error) {
  console.error(formatSigningError(error));
  process.exitCode = 1;
}
