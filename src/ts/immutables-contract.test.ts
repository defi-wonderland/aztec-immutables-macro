import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { TestWallet } from "@aztec/test-wallet/server";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { Fr } from "@aztec/aztec.js/fields";
import { type AztecLMDBStoreV2 } from "@aztec/kv-store/lmdb-v2";
import {
  deployImmutablesContract,
  deployMixedUsageContract,
  createImmutablesCapsule,
  serializeImmutables,
  type Immutables,
  computeContractSalt,
} from "./immutables-contract/utils.js";
import { setupTestSuite } from "./utils.js";

const IMMUTABLES_1: Immutables = {
  signingKeyX: new Fr(111n),
  signingKeyY: new Fr(222n),
};
const IMMUTABLES_2: Immutables = {
  signingKeyX: new Fr(333n),
  signingKeyY: new Fr(444n),
};
const ACTUAL_SALT_1 = new Fr(12345n);
const ACTUAL_SALT_2 = new Fr(54321n);
const INITIAL_COUNTER = 42n;

describe("Immutables Contract - Initializerless Pattern", () => {
  let store: AztecLMDBStoreV2;
  let wallet: TestWallet;
  let alice: AztecAddress;

  beforeAll(async () => {
    ({
      store,
      wallet,
      accounts: [alice],
    } = await setupTestSuite("immutables"));
  });

  afterAll(async () => {
    await store.delete();
  });

  // Pure computation tests (no deployment, no published/unpublished distinction)
  it("should produce different addresses for different actualSalt", async () => {
    // Deploy two contracts with same immutables but different actualSalt
    const { contract: contract1 } = await deployImmutablesContract(
      wallet,
      IMMUTABLES_1,
      { actualSalt: ACTUAL_SALT_1 },
    );
    const { contract: contract2 } = await deployImmutablesContract(
      wallet,
      IMMUTABLES_1,
      { actualSalt: ACTUAL_SALT_2, skipClassPublication: true },
    );

    // Different actualSalt should produce different addresses
    expect(contract1.address.toString()).not.toBe(contract2.address.toString());
  });

  it("should compute correct contract salt", async () => {
    const actualSalt = new Fr(12345n);
    const salt = computeContractSalt(
      ACTUAL_SALT_1,
      serializeImmutables(IMMUTABLES_1),
    );

    // Salt should be non-zero
    expect(salt.toBigInt()).not.toBe(0n);

    // Same inputs should produce same salt
    const salt2 = computeContractSalt(
      ACTUAL_SALT_1,
      serializeImmutables(IMMUTABLES_1),
    );
    expect(salt.toBigInt()).toBe(salt2.toBigInt());

    // Different immutables should produce different salt
    const differentSalt = computeContractSalt(
      ACTUAL_SALT_1,
      serializeImmutables(IMMUTABLES_2),
    );
    expect(salt.toBigInt()).not.toBe(differentSalt.toBigInt());

    // Different actualSalt should produce different salt
    const saltWithDifferentActual = computeContractSalt(
      ACTUAL_SALT_2,
      serializeImmutables(IMMUTABLES_1),
    );
    expect(salt.toBigInt()).not.toBe(saltWithDifferentActual.toBigInt());
  });

  // Published deployment tests
  describe("Published", () => {
    it("should deploy contract with immutables and read them back", async () => {
      const { contract, actualSalt, isPublished } =
        await deployImmutablesContract(wallet, IMMUTABLES_1);

      expect(isPublished).toBe(true);
      expect(contract.address).toBeDefined();
      expect(contract.address.toString()).not.toBe(
        AztecAddress.ZERO.toString(),
      );

      // Verify instance IS published on-chain
      const metadata = await wallet.getContractMetadata(contract.address);
      expect(metadata.isContractPublished).toBe(true);

      const capsule = createImmutablesCapsule(
        contract.address,
        actualSalt,
        serializeImmutables(IMMUTABLES_1),
      );

      const result = await contract.methods
        .get_signing_key()
        .with({ capsules: [capsule] })
        .simulate({
          from: alice,
        });

      expect(result[0]).toEqual(IMMUTABLES_1.signingKeyX.toBigInt());
      expect(result[1]).toEqual(IMMUTABLES_1.signingKeyY.toBigInt());
    });

    it("should fail with wrong capsule data", async () => {
      const { contract, actualSalt } = await deployImmutablesContract(
        wallet,
        IMMUTABLES_1,
      );

      const wrongCapsule = createImmutablesCapsule(
        contract.address,
        actualSalt,
        serializeImmutables(IMMUTABLES_2),
      );

      await expect(
        contract.methods
          .get_signing_key()
          .with({ capsules: [wrongCapsule] })
          .simulate({ from: alice }),
      ).rejects.toThrow("Immutables do not match contract salt");
    });
  });

  it("should read immutables from PXE store without manual capsule", async () => {
    const { contract, actualSalt } = await deployImmutablesContract(
      wallet,
      IMMUTABLES_1,
    );

    // Persist immutables to PXE's CapsuleStore via store_immutables utility
    const capsuleData = [actualSalt, ...serializeImmutables(IMMUTABLES_1)];
    await contract.methods
      .store_immutables(capsuleData)
      .simulate({ from: alice });

    // Read immutables WITHOUT a transient capsule -- data comes from persistent store
    const result = await contract.methods
      .get_signing_key()
      .simulate({ from: alice });

    expect(result[0]).toEqual(IMMUTABLES_1.signingKeyX.toBigInt());
    expect(result[1]).toEqual(IMMUTABLES_1.signingKeyY.toBigInt());
  });

  // Unpublished (PXE-only) deployment tests
  describe("Unpublished (PXE-only)", () => {
    it("should deploy unpublished contract and read immutables back", async () => {
      const { contract, actualSalt, isPublished } =
        await deployImmutablesContract(wallet, IMMUTABLES_1, {
          skipInstancePublication: true,
        });

      expect(isPublished).toBe(false);
      expect(contract.address).toBeDefined();
      expect(contract.address.toString()).not.toBe(
        AztecAddress.ZERO.toString(),
      );

      // Verify instance is NOT published on-chain
      const metadata = await wallet.getContractMetadata(contract.address);
      expect(metadata.isContractPublished).toBe(false);

      const capsule = createImmutablesCapsule(
        contract.address,
        actualSalt,
        serializeImmutables(IMMUTABLES_1),
      );

      const result = await contract.methods
        .get_signing_key()
        .with({ capsules: [capsule] })
        .simulate({
          from: alice,
        });

      expect(result[0]).toEqual(IMMUTABLES_1.signingKeyX.toBigInt());
      expect(result[1]).toEqual(IMMUTABLES_1.signingKeyY.toBigInt());
    });
  });
});

describe("Immutables Contract - Mixed Usage (Immutables + Storage)", () => {
  let store: AztecLMDBStoreV2;
  let wallet: TestWallet;
  let alice: AztecAddress;

  beforeAll(async () => {
    ({
      store,
      wallet,
      accounts: [alice],
    } = await setupTestSuite("mixed-usage"));
  });

  afterAll(async () => {
    await store.delete();
  });

  it("should deploy contract with storage initialized", async () => {
    // Deploy using standard initializer pattern
    const { contract } = await deployMixedUsageContract(
      wallet,
      IMMUTABLES_1,
      INITIAL_COUNTER,
    );

    // Verify contract was deployed
    expect(contract.address).toBeDefined();
    expect(contract.address.toString()).not.toBe(AztecAddress.ZERO.toString());

    // Read counter via public function - should return initial value
    const counter = await contract.methods.get_counter().simulate({
      from: alice,
    });
    expect(counter).toEqual(INITIAL_COUNTER);
  });

  it("should allow storage mutation via increment", async () => {
    const { contract } = await deployMixedUsageContract(
      wallet,
      IMMUTABLES_1,
      INITIAL_COUNTER,
    );

    // Increment counter via public function
    await contract.methods.increment_counter().send({ from: alice });

    // Read counter - should be incremented
    const counter = await contract.methods.get_counter().simulate({
      from: alice,
    });
    expect(counter).toEqual(INITIAL_COUNTER + 1n);
  });

  it("should deploy mixed usage and read immutables back", async () => {
    const { contract, actualSalt } = await deployMixedUsageContract(
      wallet,
      IMMUTABLES_1,
      INITIAL_COUNTER,
    );

    // Storage works
    const counter = await contract.methods.get_counter().simulate({
      from: alice,
    });
    expect(counter).toEqual(INITIAL_COUNTER);

    // Immutables verification now succeeds because salt is derived from immutables
    const capsule = createImmutablesCapsule(
      contract.address,
      actualSalt,
      serializeImmutables(IMMUTABLES_1),
    );

    const result = await contract.methods
      .get_signing_key()
      .with({ capsules: [capsule] })
      .simulate({ from: alice });

    expect(result[0]).toEqual(IMMUTABLES_1.signingKeyX.toBigInt());
    expect(result[1]).toEqual(IMMUTABLES_1.signingKeyY.toBigInt());
  });

  it("should verify immutables and increment storage", async () => {
    const { contract, actualSalt } = await deployMixedUsageContract(
      wallet,
      IMMUTABLES_1,
      INITIAL_COUNTER,
    );

    // Create capsule for the call
    const capsule = createImmutablesCapsule(
      contract.address,
      actualSalt,
      serializeImmutables(IMMUTABLES_1),
    );

    // The combined private+public function should succeed:
    // 1. Verifies immutables in private context
    // 2. Enqueues a public call to increment storage
    await contract.methods
      .verify_immutables_and_increment()
      .with({ capsules: [capsule] })
      .send({ from: alice });

    // Counter should be incremented
    const counter = await contract.methods.get_counter().simulate({
      from: alice,
    });
    expect(counter).toEqual(INITIAL_COUNTER + 1n);
  });
});
