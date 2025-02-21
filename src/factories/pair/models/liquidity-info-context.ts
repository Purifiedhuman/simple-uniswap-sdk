import { UniswapVersion } from '../../../enums/uniswap-version';
import { Token } from '../../token/models/token';

export interface LiquidityInfoContextSingle {
  uniswapVersion: UniswapVersion;
  pairAddress: string;
  token0: Token | undefined;
  token0EstimatedPool: string | undefined;
  token1: Token | undefined;
  token1EstimatedPool: string | undefined;
  lpTokens: string;
  poolShares: string;
  blockTimestampLast: string;
}

export interface LiquidityInfoContext {
  liquidityInfoContext: Array<LiquidityInfoContextSingle>
}
