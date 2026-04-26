export type ChainKey = "baseSepolia" | "arbitrumSepolia";
export type CampaignStatus = "pending" | "in-progress" | "complete";
export type Hex = `0x${string}`;

export interface DeclareParams {
  campaignId: string; // bytes32 hex string
  chain: string;
  shareToken: string;
  totalAmount: string; // bigint as string (USDC has 6 decimals)
}

export interface Campaign {
  rowId: string; // ${userId}-${chain}
  userId: Hex;
  onChainId: Hex;
  chain: ChainKey;
  shareToken: Hex;
  payToken: Hex;
  totalAmount: string;
  recordBlock: string;
  declareTxHash: Hex;
  status: CampaignStatus;
  createdAt: number;
  completedAt?: number;
}

export interface Holder {
  address: Hex;
  balance: bigint;
}

export interface Payout {
  holder: Hex;
  amount: bigint;
  sharesAtSnapshot: bigint;
}
