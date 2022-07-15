import { UniswapVersion } from '../../../enums/uniswap-version';
import { Token } from '../../token/models/token';

export interface UniswapRmLiquidityTradeContext {
  uniswapVersion: UniswapVersion;
  isSupplier: boolean;
  
  minTokenAAmountConvertQuote: string; 
  minTokenBAmountConvertQuote: string;
  tradeExpires: number;
  tokenAHasEnoughAllowance: boolean;
  tokenBHasEnoughAllowance: boolean;
  tokenAApprovalTransaction?: Transaction | undefined;
  tokenBApprovalTransaction?: Transaction | undefined;
  tokenA: Token;
  tokenABalance: {
    hasEnough: boolean;
    balance: string;
  };
  tokenB: Token;
  tokenBBalance: {
    hasEnough: boolean;
    balance: string;
  };
  lpTokensToReceive: string;
  poolShare: string;
  transaction: Transaction;
  lpBalance: string;
}
