import { Token } from '../../token/models/token';

export interface LiquidityInfo {
  walletAddress: string;
  pairAddress: string;
  token0Address: string;
  token1Address: string;
  pairToken0Balance: string;
  pairToken1Balance: string;
  token0: Token | undefined;
  token0EstimatedPool: string | undefined;
  token1: Token | undefined;
  token1EstimatedPool: string | undefined;
  pairTotalSupply: string;
  lpTokens: string;
  poolShares: string;
  blockTimestampLast: string;
}
