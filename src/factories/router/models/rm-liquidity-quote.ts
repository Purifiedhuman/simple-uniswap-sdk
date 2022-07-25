import { UniswapVersion } from '../../../enums/uniswap-version';

export interface RmLiquidityQuote {
  uniswapVersion: UniswapVersion;
  invalidPair: boolean;
  lpAddress: string;
  lpTokenBalance: string;
  tokenAPerLpToken: string;
  tokenBPerLpToken: string;
  poolShare: string;
  allowance: string;
}
