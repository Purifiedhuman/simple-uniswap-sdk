import BigNumber from 'bignumber.js';
import { Subject, timer } from 'rxjs';
import { startWith, switchMap, takeUntil } from 'rxjs/operators';
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

  private _timerEnabled = false;
  private readonly _triggerStopTimer$ = new Subject();
  private readonly _triggerRsTimer$ = new Subject();
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
    // for (let i = 0; i < this.quoteChanged$.observers.length; i++) {
    //   this.quoteChanged$.observers[i].complete();
    // }

    this.unwatchTradePrice();
  }

  /**
   * Get trade info - this will return the info pertinent to remove liquidity
   * @param amount The amount you want to swap
   */
  public async getRmTradeInfo(
  ): Promise<UniswapRmLiquidityInfoContext> {
    const tradeInfo = await this.findPairRmTradeInfo();

    if (!this._timerEnabled) {
      this._currentRmLiquidityInfoContext = this.buildCurrentInfoContext(tradeInfo);
    }

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
    etherAmountsToSend: string,
    lpDecimals = 18
  ): Promise<Transaction> {
    const pairContractFactory = new UniswapPairContractFactoryV2(
      this._uniswapPairFactoryContext.ethersProvider,
      pairAddress
    );

    const allowanceToRequest = new BigNumber(etherAmountsToSend)
      // .minus(etherAvailableAllowance)
      .shiftedBy(lpDecimals)

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
      lpToken: trade.lpToken,
      lpTokenBalance: trade.lpTokenBalance,
      poolShare: trade.poolShare,
      tokenAPerLpToken: trade.tokenAPerLpToken,
      tokenBPerLpToken: trade.tokenBPerLpToken,
      estimatedTokenAOwned: trade.estimatedTokenAOwned,
      estimatedTokenBOwned: trade.estimatedTokenBOwned,
      allowance: trade.allowance,
      invalidPair: trade.invalidPair
    });
  }

  /**
   * finds the remove trade information
   */
  private async findPairRmTradeInfo(): Promise<UniswapRmLiquidityInfoContext> {
    return await this._routes.getRmLiquidityQuote();
  }

  /**
   * Watch trade price move automatically emitting the stream if it changes
   */
  private watchTradePrice(): void {
    if (!this._timerEnabled) {
      // this._uniswapPairFactoryContext.ethersProvider.provider.on(
      //   'block',
      //   async () => {
      //     await this.handleNewBlock();
      //   }
      // );
      //Start timer after 5 seconds, emits every 5 seconds
      this._triggerRsTimer$
        .pipe(
          startWith(undefined as void),
          switchMap(() => timer(5000, 5000)
            .pipe(takeUntil(this._triggerStopTimer$)))
        )
        .subscribe(() => {
          this.handleTimerBasedNewContextData();
        })
      this._timerEnabled = true;
    }
  }

  /**
   * unwatch any block streams
   */
  private unwatchTradePrice(): void {
    // this._uniswapPairFactoryContext.ethersProvider.provider.removeAllListeners(
    //   'block'
    // );
    this._triggerStopTimer$.next();
    this._timerEnabled = false;
  }

  /**
   * @param forceResyncTimer resync timer 
   * Handle new data observable, runs on timer
   */
  public async handleTimerBasedNewContextData(forceResyncTimer = false): Promise<number> {
    if (forceResyncTimer) {
      this._triggerStopTimer$.next();
      this._triggerRsTimer$.next();
    };

    if (this.quoteChanged$.observers.length > 0 && this._currentRmLiquidityInfoContext) {
      const tradeInfo = await this.findPairRmTradeInfo();

      if (
        tradeInfo.tokenAPerLpToken !== this._currentRmLiquidityInfoContext.tokenAPerLpToken ||
        tradeInfo.tokenBPerLpToken !== this._currentRmLiquidityInfoContext.tokenBPerLpToken ||
        tradeInfo.lpTokenBalance !== this._currentRmLiquidityInfoContext.lpTokenBalance
      ) {
        this._currentRmLiquidityInfoContext = this.buildCurrentInfoContext(tradeInfo);
        this.quoteChanged$.next(tradeInfo);
      }
    }

    return 1;
  }
}
