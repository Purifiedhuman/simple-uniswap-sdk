import { Observable as UniswapStream } from 'rxjs';
import { UniswapVersion } from '../../../enums/uniswap-version';
import { Token } from '../../token/models/token';
import { TradeDirection } from './trade-direction';
import { Transaction } from './transaction';

export interface LiquidityTradeContext {
  uniswapVersion: UniswapVersion;
  quoteDirection: TradeDirection;
  isFirstSupplier: boolean;
  baseConvertRequest: string; //Depends on quoteDirection, if input then this is token a
  expectedConvertQuote: string; //Depends on quoteDirection, if input then this is token b
  minTokenAAmountConvertQuote: string; 
  minTokenBAmountConvertQuote: string;
  tradeExpires: number;
  tokenAHasEnoughAllowance: boolean;
  tokenBHasEnoughAllowance: boolean;
  tokenAApprovalTransaction?: Transaction | undefined;
  tokenABpprovalTransaction?: Transaction | undefined;
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
  gasPriceEstimatedBy: string | undefined;
  lpBalance: string;
  quoteChanged$: UniswapStream<LiquidityTradeContext>;
  destroy: () => void;
}
