import type { HardhatUserConfig } from 'hardhat/config';
import hardhatToolboxViem from '@nomicfoundation/hardhat-toolbox-viem';
import 'dotenv/config';

const operatorKey = process.env.OPERATOR_PRIVATE_KEY;

/**
 * Contract tests run on the in-process EDR network; deploys target Hedera
 * testnet over the JSON-RPC relay.
 *
 * Solidity tests live under test/contracts so that `hardhat test` does not
 * collide with the gateway's own node:test suite in test/.
 */
const config: HardhatUserConfig = {
  plugins: [hardhatToolboxViem],

  paths: {
    sources: 'contracts',
    tests: 'test/contracts',
  },

  solidity: {
    version: '0.8.28',
    settings: {
      // The money paths are called once per read, so favour runtime gas over
      // deploy size.
      optimizer: { enabled: true, runs: 400 },
    },
  },

  networks: {
    hardhat: {
      type: 'edr-simulated',
      chainType: 'l1',
    },

    hederaTestnet: {
      type: 'http',
      chainType: 'l1',
      url: process.env.HEDERA_JSON_RPC ?? 'https://testnet.hashio.io/api',
      chainId: 296,
      accounts: operatorKey ? [operatorKey] : [],
      // Do not pin a gas price here. Hedera's relay quotes a floor via
      // eth_gasPrice (~1.11e12 weibar at time of writing) and silently
      // rejects anything under it with an opaque non-200 response, so a
      // hardcoded value is a deploy failure waiting to happen.
      gas: 6_000_000,
    },
  },
};

export default config;
