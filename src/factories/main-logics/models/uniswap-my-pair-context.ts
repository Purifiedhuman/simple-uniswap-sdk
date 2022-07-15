import { ChainId } from '../../../enums/chain-id';
import { UniswapPairSettings } from '../../pair/models/uniswap-pair-settings';

interface UniswapMyPairContextBase {
  ethereumAddress: string;
  settings?: UniswapPairSettings | undefined;
}

export interface UniswapMyPairContextBaseForEthereumProvider
  extends UniswapMyPairContextBase {
  ethereumProvider: any;
}

export interface UniswapMyPairContextV2ForChainId extends UniswapMyPairContextBase {
  chainId: ChainId | number;
}

export interface UniswapMyPairContextV2ForProviderUrl
  extends UniswapMyPairContextV2ForChainId {
  providerUrl: string;
}
