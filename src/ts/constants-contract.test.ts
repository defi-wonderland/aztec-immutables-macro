import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { TestWallet } from "@aztec/test-wallet/server";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { Fr } from "@aztec/aztec.js/fields";
import { type AztecLMDBStoreV2 } from "@aztec/kv-store/lmdb-v2";
import {
  deployConstantsContract,
  deployMixedUsageContract,
  createConstantsCapsule,
  type Constants,
  computeContractSalt,
} from "./constants-contract/utils.js";
import { setupTestSuite } from "./utils.js";

describe("Constants Contract - Initializerless Pattern", () => {
  let store: AztecLMDBStoreV2;
  let wallet: TestWallet;
  let alice: AztecAddress;

  beforeAll(async () => {
    ({
      store,
      wallet,
      accounts: [alice],
    } = await setupTestSuite("constants"));
  });

  afterAll(async () => {
    await store.delete();
  });

  // These tests demonstrate the full initializerless pattern for pure constant contracts.
  // The pattern works via publishInstance (no initializer tx needed) combined with:
  // - #[noinitcheck] attribute on functions that read constants
  // - Constants verification against salt provides equivalent security
  it("should deploy contract with constants and read them back", async () => {
    // Define test constants
    const constants: Constants = {
      signingKeyX: new Fr(0x1234567890abcdefn),
      signingKeyY: new Fr(0xfedcba0987654321n),
    };

    // Deploy the contract with constants
    const { contract, actualSalt } = await deployConstantsContract(
      wallet,
      constants,
    );

    // Verify contract was deployed
    expect(contract.address).toBeDefined();
    expect(contract.address.toString()).not.toBe(AztecAddress.ZERO.toString());

    // Create capsule for the call (capsules must be passed with each call that reads them)
    const capsule = createConstantsCapsule(
      contract.address,
      actualSalt,
      constants,
    );

    // Call the private function that reads constants
    const result = await contract.methods
      .get_signing_key()
      .with({ capsules: [capsule] })
      .simulate({
        from: alice,
      });

    // Verify the returned values match what we deployed with
    expect(result[0]).toEqual(constants.signingKeyX.toBigInt());
    expect(result[1]).toEqual(constants.signingKeyY.toBigInt());
  });

  it("should deploy with different constants values", async () => {
    // Use different values to ensure it's not cached/static
    const constants: Constants = {
      signingKeyX: new Fr(42n),
      signingKeyY: new Fr(1337n),
    };

    const { contract, actualSalt } = await deployConstantsContract(
      wallet,
      constants,
    );

    // Create capsule for the call
    const capsule = createConstantsCapsule(
      contract.address,
      actualSalt,
      constants,
    );

    const result = await contract.methods
      .get_signing_key()
      .with({ capsules: [capsule] })
      .simulate({
        from: alice,
      });

    expect(result[0]).toEqual(42n);
    expect(result[1]).toEqual(1337n);
  });

  it("should produce different addresses for different actualSalt", async () => {
    const constants: Constants = {
      signingKeyX: new Fr(111n),
      signingKeyY: new Fr(222n),
    };

    // Deploy two contracts with same constants but different actualSalt
    const { contract: contract1 } = await deployConstantsContract(
      wallet,
      constants,
      { actualSalt: new Fr(12345n) },
    );
    const { contract: contract2 } = await deployConstantsContract(
      wallet,
      constants,
      { actualSalt: new Fr(54321n), skipClassPublication: true },
    );

    // Different actualSalt should produce different addresses
    expect(contract1.address.toString()).not.toBe(contract2.address.toString());
  });

  it("should compute correct contract salt", async () => {
    const constants: Constants = {
      signingKeyX: new Fr(1n),
      signingKeyY: new Fr(2n),
    };
    const actualSalt = new Fr(12345n);

    const salt = await computeContractSalt(actualSalt, constants);

    // Salt should be non-zero
    expect(salt.toBigInt()).not.toBe(0n);

    // Same inputs should produce same salt
    const salt2 = await computeContractSalt(actualSalt, constants);
    expect(salt.toBigInt()).toBe(salt2.toBigInt());

    // Different constants should produce different salt
    const differentConstants: Constants = {
      signingKeyX: new Fr(3n),
      signingKeyY: new Fr(4n),
    };
    const differentSalt = await computeContractSalt(
      actualSalt,
      differentConstants,
    );
    expect(salt.toBigInt()).not.toBe(differentSalt.toBigInt());

    // Different actualSalt should produce different salt
    const differentActualSalt = new Fr(54321n);
    const saltWithDifferentActual = await computeContractSalt(
      differentActualSalt,
      constants,
    );
    expect(salt.toBigInt()).not.toBe(saltWithDifferentActual.toBigInt());
  });
});

describe("Constants Contract - Mixed Usage (Constants + Storage)", () => {
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
    const constants: Constants = {
      signingKeyX: new Fr(111n),
      signingKeyY: new Fr(222n),
    };
    const initialCounter = 42n;

    // Deploy using standard initializer pattern
    const { contract } = await deployMixedUsageContract(
      wallet,
      constants,
      initialCounter,
    );

    // Verify contract was deployed
    expect(contract.address).toBeDefined();
    expect(contract.address.toString()).not.toBe(AztecAddress.ZERO.toString());

    // Read counter via public function - should return initial value
    const counter = await contract.methods.get_counter().simulate({
      from: alice,
    });
    expect(counter).toEqual(initialCounter);
  });

  it("should allow storage mutation via increment", async () => {
    const constants: Constants = {
      signingKeyX: new Fr(333n),
      signingKeyY: new Fr(444n),
    };
    const initialCounter = 10n;

    const { contract } = await deployMixedUsageContract(
      wallet,
      constants,
      initialCounter,
    );

    // Increment counter via public function
    await contract.methods.increment_counter().send({ from: alice });

    // Read counter - should be incremented
    const counter = await contract.methods.get_counter().simulate({
      from: alice,
    });
    expect(counter).toEqual(initialCounter + 1n);
  });

  it("should fail constants verification in mixed usage (expected behavior)", async () => {
    // This test documents that in mixed usage with standard deployment,
    // constants verification will fail because the contract's salt is
    // computed from deployer-chosen values, not including the constants.
    const constants: Constants = {
      signingKeyX: new Fr(555n),
      signingKeyY: new Fr(666n),
    };
    const initialCounter = 100n;

    const { contract, actualSalt } = await deployMixedUsageContract(
      wallet,
      constants,
      initialCounter,
    );

    // Storage still works
    const counter = await contract.methods.get_counter().simulate({
      from: alice,
    });
    expect(counter).toEqual(initialCounter);

    // Create capsule for the call
    const capsule = createConstantsCapsule(
      contract.address,
      actualSalt,
      constants,
    );

    // But constants verification fails because:
    // - The standard deploy method computes salt from deployer-chosen values
    // - Constants::init computes poseidon2_hash([actualSalt, 555, 666])
    // - These don't match the instance.salt
    await expect(
      contract.methods
        .get_signing_key()
        .with({ capsules: [capsule] })
        .simulate({ from: alice }),
    ).rejects.toThrow("Constants do not match contract salt");
  });

  it("should fail verify_constants_and_increment due to salt mismatch (expected behavior)", async () => {
    // This tests the combined private+public function that:
    // 1. Verifies constants in private context
    // 2. Enqueues a public call to increment storage
    // Due to mixed usage, the constants verification step fails.
    const constants: Constants = {
      signingKeyX: new Fr(777n),
      signingKeyY: new Fr(888n),
    };
    const initialCounter = 50n;

    const { contract, actualSalt } = await deployMixedUsageContract(
      wallet,
      constants,
      initialCounter,
    );

    // Create capsule for the call
    const capsule = createConstantsCapsule(
      contract.address,
      actualSalt,
      constants,
    );

    // The private function fails at Constants::init
    // because salt doesn't include constants
    await expect(
      contract.methods
        .verify_constants_and_increment()
        .with({ capsules: [capsule] })
        .simulate({ from: alice }),
    ).rejects.toThrow("Constants do not match contract salt");

    // Storage should remain unchanged since the call failed
    const counter = await contract.methods.get_counter().simulate({
      from: alice,
    });
    expect(counter).toEqual(initialCounter);
  });
});
