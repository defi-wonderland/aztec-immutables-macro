/**
 * E2E Tests for SchnorrInitializerlessAccount
 *
 * These tests verify the initializerless immutables pattern for an account contract
 * that stores a signing public key committed via salt.
 *
 * Unlike Noir TXE tests, these E2E tests have full control over deployment and
 * properly verify the immutables pattern works end-to-end.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { TestWallet } from "@aztec/test-wallet/server";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { Fr } from "@aztec/aztec.js/fields";
import { type AztecLMDBStoreV2 } from "@aztec/kv-store/lmdb-v2";
import {
  createSigningKeyCapsule,
  computeContractSalt,
  computeSchnorrAccountAddress,
  type SigningPublicKey,
} from "./schnorr-initializerless-account/index.js";
import { registerInitializerlessAccount } from "./schnorr-initializerless-account/utils.js";
import { setupTestSuite } from "./utils.js";

const SIGNING_KEY_1 = {
  x: new Fr(111n),
  y: new Fr(222n),
};
const SIGNING_KEY_2 = {
  x: new Fr(333n),
  y: new Fr(444n),
};
const ACTUAL_SALT_1 = new Fr(12345n);
const ACTUAL_SALT_2 = new Fr(54321n);

describe("SchnorrInitializerlessAccount - Initializerless Immutables Pattern", () => {
  let store: AztecLMDBStoreV2;
  let wallet: TestWallet;
  let alice: AztecAddress;

  beforeAll(async () => {
    ({
      store,
      wallet,
      accounts: [alice],
    } = await setupTestSuite("schnorr-immutables"));
  });

  afterAll(async () => {
    await store.delete();
  });

  // Pure computation tests (no deployment, no published/unpublished distinction)
  it("should produce different addresses for different signing keys", async () => {
    // Compute addresses with fixed actualSalt for determinism
    const result1 = await computeSchnorrAccountAddress(SIGNING_KEY_1, {
      actualSalt: ACTUAL_SALT_1,
    });
    const result2 = await computeSchnorrAccountAddress(SIGNING_KEY_2, {
      actualSalt: ACTUAL_SALT_1,
    });

    // Different signing keys should produce different addresses
    expect(result1.address.toString()).not.toBe(result2.address.toString());
  });

  it("should produce different addresses for different actualSalt", async () => {
    // Compute addresses with same signing key but different actualSalt
    const result1 = await computeSchnorrAccountAddress(SIGNING_KEY_1, {
      actualSalt: ACTUAL_SALT_1,
    });
    const result2 = await computeSchnorrAccountAddress(SIGNING_KEY_1, {
      actualSalt: ACTUAL_SALT_2,
    });

    // Different actualSalt should produce different addresses
    expect(result1.address.toString()).not.toBe(result2.address.toString());
  });

  it("should produce consistent addresses for same signing key and actualSalt", async () => {
    const result1 = await computeSchnorrAccountAddress(SIGNING_KEY_1, {
      actualSalt: ACTUAL_SALT_1,
    });
    const result2 = await computeSchnorrAccountAddress(SIGNING_KEY_1, {
      actualSalt: ACTUAL_SALT_1,
    });

    // Same key and actualSalt should produce same address
    expect(result1.address.toString()).toBe(result2.address.toString());
  });

  it("should compute correct contract salt", async () => {
    const actualSalt = new Fr(12345n);

    const salt = computeContractSalt(ACTUAL_SALT_1, SIGNING_KEY_1);

    // Salt should be non-zero
    expect(salt.toBigInt()).not.toBe(0n);

    // Same inputs should produce same salt
    const salt2 = computeContractSalt(ACTUAL_SALT_1, SIGNING_KEY_1);
    expect(salt.toBigInt()).toBe(salt2.toBigInt());

    // Different key should produce different salt
    const differentSalt = computeContractSalt(actualSalt, SIGNING_KEY_2);
    expect(salt.toBigInt()).not.toBe(differentSalt.toBigInt());

    // Different actualSalt should produce different salt
    const saltWithDifferentActual = computeContractSalt(
      ACTUAL_SALT_2,
      SIGNING_KEY_1,
    );
    expect(salt.toBigInt()).not.toBe(saltWithDifferentActual.toBigInt());
  });

  // Published deployment tests
  describe("Published", () => {
    it("should deploy account with signing key and read it back", async () => {
      const { contract, actualSalt, signingPublicKey, isPublished, instance } =
        await registerInitializerlessAccount(wallet);

      expect(isPublished).toBe(true);
      expect(contract.address).toBeDefined();
      expect(contract.address.toString()).not.toBe(
        AztecAddress.ZERO.toString(),
      );

      const capsule = createSigningKeyCapsule(
        contract.address,
        actualSalt,
        signingPublicKey,
      );

      const result = await contract.methods
        .get_signing_public_key()
        .with({ capsules: [capsule] })
        .simulate({
          from: alice,
        });

      expect(result[0]).toEqual(signingPublicKey.x.toBigInt());
      expect(result[1]).toEqual(signingPublicKey.y.toBigInt());

      // Verify pre-computed address matches deployed address (TS-Noir agreement)
      const { address: preComputedAddress } =
        await computeSchnorrAccountAddress(signingPublicKey, {
          actualSalt,
          publicKeys: instance.publicKeys,
        });
      expect(preComputedAddress.toString()).toBe(contract.address.toString());
    });

    it("should deploy with different secret keys and get different addresses", async () => {
      const account1 = await registerInitializerlessAccount(wallet, {
        secretKey: Fr.random(),
      });
      const account2 = await registerInitializerlessAccount(wallet, {
        secretKey: Fr.random(),
      });

      // Different secrets should produce different addresses
      expect(account1.address.toString()).not.toBe(account2.address.toString());

      // Verify each contract returns its correct key
      const capsule1 = createSigningKeyCapsule(
        account1.address,
        account1.actualSalt,
        account1.signingPublicKey,
      );
      const result1 = await account1.contract.methods
        .get_signing_public_key()
        .with({ capsules: [capsule1] })
        .simulate({ from: alice });

      expect(result1[0]).toEqual(account1.signingPublicKey.x.toBigInt());
      expect(result1[1]).toEqual(account1.signingPublicKey.y.toBigInt());

      const capsule2 = createSigningKeyCapsule(
        account2.address,
        account2.actualSalt,
        account2.signingPublicKey,
      );
      const result2 = await account2.contract.methods
        .get_signing_public_key()
        .with({ capsules: [capsule2] })
        .simulate({ from: alice });

      expect(result2[0]).toEqual(account2.signingPublicKey.x.toBigInt());
      expect(result2[1]).toEqual(account2.signingPublicKey.y.toBigInt());
    });

    it("should fail with wrong capsule data", async () => {
      const { contract, actualSalt, signingPublicKey } =
        await registerInitializerlessAccount(wallet);

      // Try to call with a different (wrong) signing key in capsule
      const wrongKey: SigningPublicKey = {
        x: new Fr(signingPublicKey.x.toBigInt() + 1n),
        y: new Fr(signingPublicKey.y.toBigInt() + 1n),
      };
      const wrongCapsule = createSigningKeyCapsule(
        contract.address,
        actualSalt,
        wrongKey,
      );

      // This should fail because the capsule data doesn't match salt
      await expect(
        contract.methods
          .get_signing_public_key()
          .with({ capsules: [wrongCapsule] })
          .simulate({ from: alice }),
      ).rejects.toThrow("Immutables do not match contract salt");
    });

    it("should fail with wrong actualSalt in capsule", async () => {
      const { contract, actualSalt, signingPublicKey } =
        await registerInitializerlessAccount(wallet);

      // Correct key but wrong actualSalt
      const wrongActualSalt = new Fr(actualSalt.toBigInt() + 1n);
      const wrongCapsule = createSigningKeyCapsule(
        contract.address,
        wrongActualSalt,
        signingPublicKey,
      );

      // This should fail because the hash([wrongActualSalt, key]) won't match salt
      await expect(
        contract.methods
          .get_signing_public_key()
          .with({ capsules: [wrongCapsule] })
          .simulate({ from: alice }),
      ).rejects.toThrow("Immutables do not match contract salt");
    });

    it("should deploy multiple accounts with different keys", async () => {
      const deployments = await Promise.all([
        registerInitializerlessAccount(wallet, { secretKey: Fr.random() }),
        registerInitializerlessAccount(wallet, { secretKey: Fr.random() }),
        registerInitializerlessAccount(wallet, { secretKey: Fr.random() }),
      ]);

      // Verify all addresses are unique
      const addresses = deployments.map((d) => d.address.toString());
      const uniqueAddresses = new Set(addresses);
      expect(uniqueAddresses.size).toBe(deployments.length);

      // Verify each contract returns its correct key
      for (const { contract, actualSalt, signingPublicKey } of deployments) {
        const capsule = createSigningKeyCapsule(
          contract.address,
          actualSalt,
          signingPublicKey,
        );
        const result = await contract.methods
          .get_signing_public_key()
          .with({ capsules: [capsule] })
          .simulate({ from: alice });

        expect(result[0]).toEqual(signingPublicKey.x.toBigInt());
        expect(result[1]).toEqual(signingPublicKey.y.toBigInt());
      }
    });
  });

  // Unpublished (PXE-only) deployment tests
  describe("Unpublished (PXE-only)", () => {
    it("should deploy unpublished account and read signing key back", async () => {
      const { contract, actualSalt, signingPublicKey, isPublished } =
        await registerInitializerlessAccount(wallet, {
          skipInstancePublication: true,
        });

      expect(isPublished).toBe(false);
      expect(contract.address).toBeDefined();
      expect(contract.address.toString()).not.toBe(
        AztecAddress.ZERO.toString(),
      );

      const capsule = createSigningKeyCapsule(
        contract.address,
        actualSalt,
        signingPublicKey,
      );

      const result = await contract.methods
        .get_signing_public_key()
        .with({ capsules: [capsule] })
        .simulate({
          from: alice,
        });

      expect(result[0]).toEqual(signingPublicKey.x.toBigInt());
      expect(result[1]).toEqual(signingPublicKey.y.toBigInt());
    });

    it("should deploy unpublished with different secret keys and get different addresses", async () => {
      const account1 = await registerInitializerlessAccount(wallet, {
        secretKey: Fr.random(),
        skipInstancePublication: true,
      });
      const account2 = await registerInitializerlessAccount(wallet, {
        secretKey: Fr.random(),
        skipInstancePublication: true,
      });

      // Different secrets should produce different addresses
      expect(account1.address.toString()).not.toBe(account2.address.toString());

      // Verify each contract returns its correct key
      const capsule1 = createSigningKeyCapsule(
        account1.address,
        account1.actualSalt,
        account1.signingPublicKey,
      );
      const result1 = await account1.contract.methods
        .get_signing_public_key()
        .with({ capsules: [capsule1] })
        .simulate({ from: alice });

      expect(result1[0]).toEqual(account1.signingPublicKey.x.toBigInt());
      expect(result1[1]).toEqual(account1.signingPublicKey.y.toBigInt());

      const capsule2 = createSigningKeyCapsule(
        account2.address,
        account2.actualSalt,
        account2.signingPublicKey,
      );
      const result2 = await account2.contract.methods
        .get_signing_public_key()
        .with({ capsules: [capsule2] })
        .simulate({ from: alice });

      expect(result2[0]).toEqual(account2.signingPublicKey.x.toBigInt());
      expect(result2[1]).toEqual(account2.signingPublicKey.y.toBigInt());
    });

    it("should fail with wrong capsule data on unpublished account", async () => {
      const { contract, actualSalt, signingPublicKey } =
        await registerInitializerlessAccount(wallet, {
          skipInstancePublication: true,
        });

      // Try to call with a different (wrong) signing key in capsule
      const wrongKey: SigningPublicKey = {
        x: new Fr(signingPublicKey.x.toBigInt() + 1n),
        y: new Fr(signingPublicKey.y.toBigInt() + 1n),
      };
      const wrongCapsule = createSigningKeyCapsule(
        contract.address,
        actualSalt,
        wrongKey,
      );

      // This should fail because the capsule data doesn't match salt
      await expect(
        contract.methods
          .get_signing_public_key()
          .with({ capsules: [wrongCapsule] })
          .simulate({ from: alice }),
      ).rejects.toThrow("Immutables do not match contract salt");
    });

    it("should deploy multiple unpublished accounts with different keys", async () => {
      const deployments = await Promise.all([
        registerInitializerlessAccount(wallet, {
          secretKey: Fr.random(),
          skipInstancePublication: true,
        }),
        registerInitializerlessAccount(wallet, {
          secretKey: Fr.random(),
          skipInstancePublication: true,
        }),
        registerInitializerlessAccount(wallet, {
          secretKey: Fr.random(),
          skipInstancePublication: true,
        }),
      ]);

      // Verify all addresses are unique
      const addresses = deployments.map((d) => d.address.toString());
      const uniqueAddresses = new Set(addresses);
      expect(uniqueAddresses.size).toBe(deployments.length);

      // Verify each contract returns its correct key
      for (const { contract, actualSalt, signingPublicKey } of deployments) {
        const capsule = createSigningKeyCapsule(
          contract.address,
          actualSalt,
          signingPublicKey,
        );
        const result = await contract.methods
          .get_signing_public_key()
          .with({ capsules: [capsule] })
          .simulate({ from: alice });

        expect(result[0]).toEqual(signingPublicKey.x.toBigInt());
        expect(result[1]).toEqual(signingPublicKey.y.toBigInt());
      }
    });
  });
});
