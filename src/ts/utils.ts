import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { rmSync } from "fs";
import { join } from "path";

import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import {
  registerInitialLocalNetworkAccountsInWallet,
  TestWallet,
} from "@aztec/test-wallet/server";
import { getPXEConfig } from "@aztec/pxe/server";

const { NODE_URL = "http://localhost:8080" } = process.env;

/**
 * Setup the node, wallet and accounts for tests.
 * @param proverEnabled - optional - Whether to enable the prover.
 * @returns The wallet, accounts and a cleanup function. Call `cleanup()` in afterAll to teardown.
 */
export async function setupTestSuite(proverEnabled: boolean = false) {
  const node = createAztecNodeClient(NODE_URL);
  await waitForNode(node);

  const l1Contracts = await node.getL1ContractAddresses();
  const config = getPXEConfig();
  const dataDirectory = join(
    tmpdir(),
    `immutables-macro-${randomBytes(8).toString("hex")}`,
  );

  const pxeConfig = {
    ...config,
    l1Contracts,
    dataDirectory,
    dataStoreMapSizeKb: 1e6,
    proverEnabled,
  };

  const wallet: TestWallet = await TestWallet.create(node, pxeConfig);

  const accounts: AztecAddress[] =
    await registerInitialLocalNetworkAccountsInWallet(wallet);

  const cleanup = async () => {
    await wallet.stop();
    try {
      rmSync(dataDirectory, { recursive: true, force: true });
    } catch {}
  };

  return {
    node,
    wallet,
    accounts,
    cleanup,
  };
}
