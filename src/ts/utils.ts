import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { rmSync } from "fs";
import { join } from "path";

import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { Fr } from "@aztec/aztec.js/fields";
import type { Account } from "@aztec/aztec.js/account";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { getContractInstanceFromInstantiationParams } from "@aztec/aztec.js/contracts";
import { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee/testing";
import { SponsoredFPCContract } from "@aztec/noir-contracts.js/SponsoredFPC";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import type { Wallet } from "@aztec/aztec.js/wallet";
import { registerInitialLocalNetworkAccountsInWallet } from "@aztec/wallets/testing";

const { NODE_URL = "http://localhost:8080" } = process.env;

/**
 * EmbeddedWallet subclass that supports custom account types.
 *
 * EmbeddedWallet only knows how to sign for built-in account types (schnorr,
 * ecdsasecp256k1, ecdsasecp256r1) stored in its WalletDB. Custom accounts like
 * SchnorrInitializerlessAccount aren't registered through that path.
 *
 * This subclass overrides the protected `getAccountFromAddress` method to first
 * check a custom accounts map, then fall back to the default WalletDB lookup.
 * Since `NodeEmbeddedWallet.create()` uses `new this(...)`, calling
 * `CustomEmbeddedWallet.create()` returns a `CustomEmbeddedWallet` instance.
 */
export class CustomEmbeddedWallet extends EmbeddedWallet {
  private customAccounts = new Map<string, Account>();

  /**
   * Register a custom account for signing.
   *
   * When the wallet needs to sign a transaction `from` the given address,
   * it will use this Account object to create auth witnesses.
   */
  registerCustomAccount(address: AztecAddress, account: Account) {
    this.customAccounts.set(address.toString(), account);
  }

  protected override async getAccountFromAddress(
    address: AztecAddress,
  ): Promise<Account> {
    const custom = this.customAccounts.get(address.toString());
    if (custom) return custom;
    return super.getAccountFromAddress(address);
  }
}

/**
 * Setup the node, wallet and accounts for tests.
 * @param proverEnabled - optional - Whether to enable the prover.
 * @returns The wallet, accounts and a cleanup function. Call `cleanup()` in afterAll to teardown.
 */
export async function setupTestSuite(proverEnabled: boolean = false) {
  const node = createAztecNodeClient(NODE_URL);
  await waitForNode(node);

  const dataDirectory = join(
    tmpdir(),
    `immutables-macro-${randomBytes(8).toString("hex")}`,
  );

  const wallet: CustomEmbeddedWallet = await CustomEmbeddedWallet.create(node, {
    pxeConfig: { dataDirectory, proverEnabled },
  });

  const accounts: AztecAddress[] =
    await registerInitialLocalNetworkAccountsInWallet(wallet);

  const cleanup = async () => {
    await wallet.stop();
    try {
      rmSync(dataDirectory, { recursive: true, force: true });
    } catch {}
  };

  // Register the canonical SponsoredFPC for fee sponsorship
  const sponsoredFPCAddress = await registerSponsoredFPC(wallet);
  const sponsoredPaymentMethod = new SponsoredFeePaymentMethod(
    sponsoredFPCAddress,
  );

  return {
    node,
    wallet,
    accounts,
    sponsoredPaymentMethod,
    cleanup,
  };
}

/**
 * Register the canonical SponsoredFPC contract and return its address.
 * The SponsoredFPC is deployed at a well-known address using salt = 0.
 */
export async function registerSponsoredFPC(
  wallet: Wallet,
): Promise<AztecAddress> {
  const SPONSORED_FPC_SALT = 0n;
  const instance = await getContractInstanceFromInstantiationParams(
    SponsoredFPCContract.artifact,
    { salt: new Fr(SPONSORED_FPC_SALT) },
  );
  await wallet.registerContract(instance, SponsoredFPCContract.artifact);
  return instance.address;
}
