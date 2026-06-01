import { TaskContext } from "compose";

// Address of your deployed RandomnessConsumer (see README to deploy your own).
// No-deploy option: to get this running and see it all working without
// deploying anything, point this at the totally open RandomnessConsumer on Base
// Sepolia, where anyone can fulfill (no fulfiller gate):
// 0x6273AB73C95Ba2233281F1eb8aa3b21D9352AD6d. Keep this in sync with the
// CONTRACT_ADDRESS in fulfill-randomness.ts and the `contract:` field in compose.yaml.
const CONTRACT_ADDRESS = "0xE05Ceb3E269029E3bab46E35515e8987060D1027";

export async function main(context: TaskContext): Promise<{
  requestId: string;
  txHash: string;
}> {
  const { evm } = context;

  const wallet = await evm.wallet({
    name: "randomness-requester",
  });

  // Instantiate typed contract (generated from src/contracts/RandomnessConsumer.json)
  const contract = new evm.contracts.RandomnessConsumer(
    CONTRACT_ADDRESS,
    evm.chains.baseSepolia,
    wallet
  );

  // Send the request transaction
  const { hash } = await contract.requestRandomness();

  // Read nextRequestId after tx - subtract 1 to get our requestId
  const nextId = await contract.nextRequestId();
  const requestId = String(BigInt(nextId) - 1n);

  return {
    requestId,
    txHash: hash,
  };
}
