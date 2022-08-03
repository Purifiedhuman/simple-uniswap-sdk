import { UniswapVersion } from '../../../enums/uniswap-version';
import { Token } from '../../token/models/token';

export interface UniswapRmLiquidityInfoContext {
  uniswapVersion: UniswapVersion;
  lpToken: Token | undefined;
  lpTokenBalance: string;
  tokenAPerLpToken: string;
  tokenBPerLpToken: string;
  estimatedTokenAOwned: string;
  estimatedTokenBOwned: string;
  poolShare: string;
  allowance: string;
  invalidPair: boolean;
}
