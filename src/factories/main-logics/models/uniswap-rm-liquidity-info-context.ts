import { UniswapVersion } from '../../../enums/uniswap-version';

export interface UniswapRmLiquidityInfoContext {
  uniswapVersion: UniswapVersion;
  lpAddress: string;
  lpTokenBalance: string;
  tokenAPerLpToken: string;
  tokenBPerLpToken: string;
  poolShare: string;
}
