import BigNumber from 'bignumber.js';
import { Subject } from 'rxjs';
import { CoinGecko } from '../../../coin-gecko';
import { Constants } from '../../../common/constants';
import { deepClone } from '../../../common/utils/deep-clone';
import { hexlify } from '../../../common/utils/hexlify';
import { UniswapVersion } from '../../../enums/uniswap-version';
import { uniswapContracts } from '../../../uniswap-contract-context/get-uniswap-contracts';
import { Transaction } from '../../pair/models/transaction';
import { UniswapPairContractFactoryV2 } from '../../pair/v2/uniswap-pair-contract.factory.v2';
import { UniswapRouterFactory } from '../../router/uniswap-router.factory';
import { Token } from '../../token/models/token';
import { UniswapAddRmPairFactoryContexts } from '../models/uniswap-add-rm-pair-factory-context';
import { UniswapRmLiquidityInfoContext } from '../models/uniswap-rm-liquidity-info-context';

export class UniswapRmLiquidity {

  private _uniswapRouterFactory = new UniswapRouterFactory(
    this._coinGecko,
    this._uniswapPairFactoryContext.ethereumAddress,
    this._uniswapPairFactoryContext.tokenA,
    this._uniswapPairFactoryContext.tokenB,
    this._uniswapPairFactoryContext.settings,
    this._uniswapPairFactoryContext.ethersProvider
  );

  private _watchingBlocks = false;
  private _currentRmLiquidityInfoContext: UniswapRmLiquidityInfoContext | undefined;
  public quoteChanged$: Subject<UniswapRmLiquidityInfoContext> = new Subject<UniswapRmLiquidityInfoContext>();

  constructor(
    private _coinGecko: CoinGecko,
    private _uniswapPairFactoryContext: UniswapAddRmPairFactoryContexts
  ) { }

  /**
   * tokenA
   */
  public get tokenA(): Token {
    return this._uniswapPairFactoryContext.tokenA;
  }

  /**
   * tokenB
   */
  public get tokenB(): Token {
    return this._uniswapPairFactoryContext.tokenB;
  }

  /**
   * Get the provider url
   */
  public get providerUrl(): string | undefined {
    return this._uniswapPairFactoryContext.ethersProvider.getProviderUrl();
  }

  /**
   * Destroy the trade instance watchers + subscriptions
   */
  public destroy(): void {
    for (let i = 0; i < this.quoteChanged$.observers.length; i++) {
      this.quoteChanged$.observers[i].complete();
    }

    this.unwatchTradePrice();
  }

  /**
   * Get trade info - this will return the info pertinent to remove liquidity
   * @param amount The amount you want to swap
   */
  public async getRmTradeInfo(
  ): Promise<UniswapRmLiquidityInfoContext> {
    this.destroy();

    const tradeInfo = await this.findPairRmTradeInfo();
    this._currentRmLiquidityInfoContext = this.buildCurrentInfoContext(tradeInfo);

    this.watchTradePrice();

    return tradeInfo;
  }

  /**
   * buildTransaction - build transaction to remove liquidity
   * @param lpAmountEther The amount you want to remove
   * @param tokenAAmountEther calculated tokenA amount
   * @param tokenBAmountEther calculated tokenB amount
   */
  public async buildTransaction(
    lpAmountEther: BigNumber,
    tokenAAmountEther: BigNumber,
    tokenBAmountEther: BigNumber,
  ): Promise<Transaction> {
    return await this._routes.generateRmLiquidityTransaction(
      lpAmountEther, tokenAAmountEther, tokenBAmountEther
    );
  }

  /**
   * Generate the lp address approve data allowance to move the tokens.
   * This will return the data for you to send as a transaction
   * @param uniswapVersion The uniswap version
   */
  public async buildApproveAllowanceTransaction(
    uniswapVersion: UniswapVersion,
    pairAddress: string,
    etherAvailableAllowance: string,
    etherAmountsToSend: string
  ): Promise<Transaction> {
    const pairContractFactory = new UniswapPairContractFactoryV2(
      this._uniswapPairFactoryContext.ethersProvider,
      pairAddress
    );

    const allowanceToRequest = new BigNumber(etherAmountsToSend).minus(etherAvailableAllowance);

    const data = pairContractFactory.generateApproveAllowanceData(
      uniswapVersion === UniswapVersion.v2
        ? uniswapContracts.v2.getRouterAddress(
          this._uniswapPairFactoryContext.settings.cloneUniswapContractDetails
        )
        : uniswapContracts.v3.getRouterAddress(
          this._uniswapPairFactoryContext.settings.cloneUniswapContractDetails
        ),
      hexlify(allowanceToRequest)
    );

    return {
      to: pairAddress,
      from: this._uniswapPairFactoryContext.ethereumAddress,
      data,
      value: Constants.EMPTY_HEX_STRING,
    };
  }

  /**
   * Generates the trade datetime unix time
   */
  public generateTradeDeadlineUnixTime(): string {
    return this._routes.generateTradeDeadlineUnixTime().toString();
  }

  /**
 * calculateSlippageAmount  
 * @param tokenAmountEther The amount to calculate
 * @param decimal decimal to format
 * @param minimum to calculate minimum/maximum amount
 */
  public calculateSlippageAmount(
    tokenAmountEther: string,
    decimal: number,
    minimum = true
  ): string {
    if (minimum) {
      return new BigNumber(tokenAmountEther)
        .minus(
          new BigNumber(tokenAmountEther)
            .times(this._uniswapPairFactoryContext.settings.slippage)
        ).toFixed(decimal);
    } else {
      return new BigNumber(tokenAmountEther)
        .plus(
          new BigNumber(tokenAmountEther)
            .times(this._uniswapPairFactoryContext.settings.slippage)
        ).toFixed(decimal);
    }
  }

  /**
   * Route getter
   */
  private get _routes(): UniswapRouterFactory {
    return this._uniswapRouterFactory;
  }

  /**
   * Build the current trade context
   * @param trade The trade context
   */
  private buildCurrentInfoContext(trade: UniswapRmLiquidityInfoContext): UniswapRmLiquidityInfoContext {
    return deepClone({
      uniswapVersion: trade.uniswapVersion,
      lpAddress: trade.lpAddress,
      lpTokenBalance: trade.lpTokenBalance,
      poolShare: trade.poolShare,
      tokenAPerLpToken: trade.tokenAPerLpToken,
      tokenBPerLpToken: trade.tokenBPerLpToken,
      estimatedTokenAOwned: trade.estimatedTokenAOwned,
      estimatedTokenBOwned: trade.estimatedTokenBOwned,
      allowance: trade.allowance
    });
  }

  /**
   * finds the remove trade information
   */
  private async findPairRmTradeInfo(): Promise<UniswapRmLiquidityInfoContext> {
    const rmLiquidityQuotes = await this._routes.getRmLiquidityQuote();

    const infoContext: UniswapRmLiquidityInfoContext = {
      uniswapVersion: UniswapVersion.v2, //hardcode, no support for v3
      lpAddress: rmLiquidityQuotes.lpAddress,
      lpTokenBalance: rmLiquidityQuotes.lpTokenBalance,
      poolShare: rmLiquidityQuotes.poolShare,
      tokenAPerLpToken: rmLiquidityQuotes.tokenAPerLpToken,
      tokenBPerLpToken: rmLiquidityQuotes.tokenBPerLpToken,
      estimatedTokenAOwned: new BigNumber(rmLiquidityQuotes.lpTokenBalance).multipliedBy(rmLiquidityQuotes.tokenAPerLpToken).toFixed(this.tokenA.decimals),
      estimatedTokenBOwned: new BigNumber(rmLiquidityQuotes.lpTokenBalance).multipliedBy(rmLiquidityQuotes.tokenBPerLpToken).toFixed(this.tokenB.decimals),
      allowance: rmLiquidityQuotes.allowance
    };

    return infoContext;
  }

  /**
   * Watch trade price move automatically emitting the stream if it changes
   */
  private watchTradePrice(): void {
    if (!this._watchingBlocks) {
      this._uniswapPairFactoryContext.ethersProvider.provider.on(
        'block',
        async () => {
          await this.handleNewBlock();
        }
      );
      this._watchingBlocks = true;
    }
  }

  /**
   * unwatch any block streams
   */
  private unwatchTradePrice(): void {
    this._uniswapPairFactoryContext.ethersProvider.provider.removeAllListeners(
      'block'
    );
    this._watchingBlocks = false;
  }

  /**
   * Handle new block for the trade price moving automatically emitting the stream if it changes
   */
  private async handleNewBlock(): Promise<void> {
    if (this.quoteChanged$.observers.length > 0 && this._currentRmLiquidityInfoContext) {
      const tradeInfo = await this.getRmTradeInfo();

      if (
        tradeInfo.tokenAPerLpToken !== this._currentRmLiquidityInfoContext.tokenAPerLpToken ||
        tradeInfo.tokenBPerLpToken !== this._currentRmLiquidityInfoContext.tokenBPerLpToken
      ) {
        this._currentRmLiquidityInfoContext = this.buildCurrentInfoContext(tradeInfo);
        this.quoteChanged$.next(tradeInfo);
      }

    }
  }
}
