import { Chain } from "compose";

// ============ Chain Configuration ============

export const MEGAETH_TESTNET_V2: Chain = {
  id: 6343,
  name: "MegaETH Testnet v2",
  testnet: true,
  nativeCurrency: {
    name: "Ether",
    symbol: "ETH",
    decimals: 18,
  },
  rpcUrls: {
    public: { http: ["https://timothy.megaeth.com/rpc"] },
    default: { http: ["https://timothy.megaeth.com/rpc"] },
  },
  blockExplorers: {
    default: { name: "MegaETH Explorer", url: "https://www.megaexplorer.xyz" },
  },
};

// ============ Contract Configuration ============

export const CONTRACT_ADDRESS =
  "0x4Dae8809a210415Fb985A63F385886a1A513Ee77" as const;

// ============ Wallet Names ============

export const WALLET_NAMES = {
  REQUESTER: "randomness-requester",
  FULFILLER: "randomness-fulfiller",
} as const;

// ============ Contract Functions ============

export const CONTRACT_FUNCTIONS = {
  REQUEST_RANDOMNESS: "requestRandomness()",
  NEXT_REQUEST_ID: "nextRequestId() returns (uint256)",
  FULFILL_RANDOMNESS: "fulfillRandomness(uint256,bytes32,uint64,bytes)",
} as const;
