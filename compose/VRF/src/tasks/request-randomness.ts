import { TaskContext } from "compose";

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
