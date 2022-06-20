import { Token } from '../../token/models/token';
import { TradeDirection } from './trade-direction';
import { Transaction } from './transaction';

export interface CurrencyLiquidityTradeContext {
  baseConvertRequest: string;
  expectedConvertQuote: string;
  quoteDirection: TradeDirection;
  tokenA: Token;
  tokenB: Token;
  transaction: Transaction;
  tradeExpires: number;
}
