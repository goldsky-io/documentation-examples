import { TaskContext } from "compose";

const CONTRACT_ADDRESS = "0xE05Ceb3E269029E3bab46E35515e8987060D1027" as const;

export async function main(context: TaskContext): Promise<{
  requestId: string;
  txHash: string;
}> {
  const { evm } = context;

  const wallet = await evm.wallet({
    name: "randomness-requester",
  });

  // Send the request transaction
  const result = await wallet.writeContract(
    evm.chains.baseSepolia,
    CONTRACT_ADDRESS,
    "requestRandomness()",
    []
  );

  // Read nextRequestId after tx - subtract 1 to get our requestId
  const response = await wallet.readContract<string>(
    evm.chains.baseSepolia,
    CONTRACT_ADDRESS,
    "nextRequestId() returns (uint256)",
    []
  );
  const requestId = String(BigInt(response) - 1n);

  return {
    requestId,
    txHash: result.hash,
  };
}
