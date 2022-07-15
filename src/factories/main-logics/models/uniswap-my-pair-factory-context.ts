import { EthersProvider } from '../../../ethers-provider';
import { UniswapPairSettings } from '../../pair/models/uniswap-pair-settings';

export interface UniswapMyPairFactoryContext {
  ethereumAddress: string;
  settings: UniswapPairSettings;
  ethersProvider: EthersProvider;
}
