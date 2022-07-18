import { UniswapVersion } from '../../../enums/uniswap-version';
import { Token } from '../../token/models/token';

export interface UniswapRmLiquidityInfoContext {
  uniswapVersion: UniswapVersion;
  lpAddress: string;
  lpTokenBalance: string;
  tokenAPerLpToken: string;
  tokenBPerLpToken: string;
  poolShare: string;
}
