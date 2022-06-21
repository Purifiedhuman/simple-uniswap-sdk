import { UniswapVersion } from '../../../enums/uniswap-version';
import { TradeDirection } from '../../pair/models/trade-direction';
import { Transaction } from '../../pair/models/transaction';

export interface LiquidityQuote {
  baseConvertRequest: string;
  expectedConvertQuote: string;
  expectedConvertQuoteMinWithSlippage: string;
  baseConvertRequestMinWithSlippage: string;
  transaction: Transaction;
  tradeExpires: number;
  uniswapVersion: UniswapVersion;
  quoteDirection: TradeDirection;
  lpBalance: string;
  gasPriceEstimatedBy?: string | undefined;
}
