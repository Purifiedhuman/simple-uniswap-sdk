import { UniswapVersion } from '../../../enums/uniswap-version';
import { TradeDirection } from '../../pair/models/trade-direction';
import { Transaction } from '../../pair/models/transaction';

export interface LiquidityQuote {
  isFirstSupplier: boolean,
  baseConvertRequest: string;
  expectedConvertQuote: string;
  expectedConvertQuoteMinWithSlippage: string;
  baseConvertRequestMinWithSlippage: string;
  fromHasEnoughAllowance: boolean;
  toHasEnoughAllowance: boolean;
  fromHasEnoughBalance: boolean;
  toHasEnoughBalance: boolean;
  fromBalance: string;
  toBalance: string;
  transaction: Transaction;
  tradeExpires: number;
  uniswapVersion: UniswapVersion;
  quoteDirection: TradeDirection;
  lpBalance: string;
  lpTokensToReceive: string;
  gasPriceEstimatedBy?: string | undefined;
}
