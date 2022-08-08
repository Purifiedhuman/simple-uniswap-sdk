import { UniswapVersion } from '../../../enums/uniswap-version';
import { Token } from '../../token/models/token';

export interface UniswapAddLiquidityInfoContext {
  uniswapVersion: UniswapVersion;
  isFirstSupplier: boolean;
  lpToken: Token | undefined;
  lpTokenBalance: string;
  tokenAPerLpToken: string;
  tokenBPerLpToken: string;
  estimatedTokenAOwned: string;
  estimatedTokenBOwned: string;
  tokenAPerTokenB: string;
  tokenBPerTokenA: string;
  allowanceA: string;
  allowanceB: string;
  token0Reserve: string;
  token1Reserve: string;
  selfPoolLpToken: string;
  totalPoolLpToken: string;
  currentPoolShareInPercent: string;
}
