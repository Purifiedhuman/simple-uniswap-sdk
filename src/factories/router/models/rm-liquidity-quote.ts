import { UniswapVersion } from '../../../enums/uniswap-version';
import { Token } from '../../token/models/token';

export interface RmLiquidityQuote {
  uniswapVersion: UniswapVersion;
  invalidPair: boolean;
  lpToken: Token | undefined;
  lpTokenBalance: string;
  tokenAPerLpToken: string;
  tokenBPerLpToken: string;
  poolShare: string;
  allowance: string;
}
