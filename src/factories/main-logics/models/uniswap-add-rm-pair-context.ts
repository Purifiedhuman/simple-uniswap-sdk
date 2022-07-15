import { ChainId } from '../../../enums/chain-id';
import { UniswapPairSettings } from '../../pair/models/uniswap-pair-settings';

interface UniswapAddRmPairContextBase {
  tokenATokenContractAddress: string;
  tokenBTokenContractAddress: string;
  ethereumAddress: string;
  settings?: UniswapPairSettings | undefined;
}

export interface UniswapAddRmPairContextBaseForEthereumProvider
  extends UniswapAddRmPairContextBase {
  ethereumProvider: any;
}

export interface UniswapAddRmPairContextV2ForChainId extends UniswapAddRmPairContextBase {
  chainId: ChainId | number;
}

export interface UniswapAddRmPairContextV2ForProviderUrl
  extends UniswapAddRmPairContextV2ForChainId {
  providerUrl: string;
}
