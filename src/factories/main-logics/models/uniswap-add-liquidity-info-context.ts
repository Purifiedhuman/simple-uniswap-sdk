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
  allowanceA: string;
  allowanceB: string;
  selfPoolLpToken: string;
  totalPoolLpToken: string;
}
