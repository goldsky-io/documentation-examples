import {
    ethereum 
} from "@graphprotocol/graph-ts"

import {
    GasData
} from "../../generated/schema"

export function handleBlock(block: ethereum.Block): void {
    const gasData = new GasData('auto');
    gasData.timestamp = block.timestamp.toI64();
    gasData.gasUsed = block.gasUsed;
    gasData.block = block.number;
    gasData.save()
  }
