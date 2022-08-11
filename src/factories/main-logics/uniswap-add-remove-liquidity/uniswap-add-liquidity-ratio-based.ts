import BigNumber from 'bignumber.js';
import { Subject, timer } from 'rxjs';
import { startWith, switchMap, takeUntil } from 'rxjs/operators';
import { CoinGecko } from '../../../coin-gecko';
import { Constants } from '../../../common/constants';
import { deepClone } from '../../../common/utils/deep-clone';
import { UniswapVersion } from '../../../enums/uniswap-version';
import { uniswapContracts } from '../../../uniswap-contract-context/get-uniswap-contracts';
import { Transaction } from '../../pair/models/transaction';
import { UniswapRouterFactory } from '../../router/uniswap-router.factory';
import { Token } from '../../token/models/token';
import { TokenFactory } from '../../token/token.factory';
import { UniswapAddLiquidityInfoContext } from '../models/uniswap-add-liquidity-info-context';
import { UniswapAddRmPairFactoryContexts } from '../models/uniswap-add-rm-pair-factory-context';

export class UniswapAddLiquidityRatioBased {
  private _fromTokenFactory = new TokenFactory(
    this._uniswapPairFactoryContext.tokenA.contractAddress,
    this._uniswapPairFactoryContext.ethersProvider,
    this._uniswapPairFactoryContext.settings.customNetwork,
    this._uniswapPairFactoryContext.settings.cloneUniswapContractDetails
  );

  private _toTokenFactory = new TokenFactory(
    this._uniswapPairFactoryContext.tokenB.contractAddress,
    this._uniswapPairFactoryContext.ethersProvider,
    this._uniswapPairFactoryContext.settings.customNetwork
  );

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
  private _currentAddLiquidityInfoContext: UniswapAddLiquidityInfoContext | undefined;
  public quoteChanged$: Subject<UniswapAddLiquidityInfoContext> = new Subject<UniswapAddLiquidityInfoContext>();

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
   * Stop the block watcher
   */
  public destroy(): void {
    this.unwatchTradePrice();
  }

  /**
   * Get trade info - this will return the info pertinent to add liquidity
   * @param amount The amount you want to swap
   */
  public async getAddLiquidityTradeInfo(
  ): Promise<UniswapAddLiquidityInfoContext> {
    const tradeInfo = await this.findPairAddTradeInfo();

    if (!this._timerEnabled) {
      this._currentAddLiquidityInfoContext = this.buildCurrentInfoContext(tradeInfo);
    }

    this.watchTradePrice();

    return tradeInfo;
  }

  /**
   * Calculates LP Tokens to receive
   * @param etherAmount0 The ether amount0 to trade in PairContract
   * @param etherAmount1 The ether amount1 to trade in PairContract
   * @param etherReserve0 The ether reserve0 in PairContract
   * @param etherReserve1 The ether reserve0 in PairContract
   * @param etherTotalSupply The totalSupply in PairContract
   * @param isFirstSupplier Is first supplier for the pair
   */
  public calculatesLpTokensToReceive(
    etherAmount0: BigNumber,
    etherAmount1: BigNumber,
    etherReserve0: BigNumber,
    etherReserve1: BigNumber,
    etherTotalSupply: BigNumber,
    isFirstSupplier: boolean,
    etherSelfSupply = new BigNumber(0),
    decimal = 18
  ): {
    estimatedLPTokens: string;
    estimatedPoolShares: string;
  } {
    return this._routes.calculatesLPTokensToReceive(
      etherAmount0, etherAmount1, etherReserve0, etherReserve1, etherTotalSupply, isFirstSupplier, etherSelfSupply, decimal
    );
  }

  /**
   * buildTransaction - build transaction to add liquidity
   * @param tokenAAmountEther calculated tokenA amount
   * @param tokenBAmountEther calculated tokenB amount
   */
  public async buildTransaction(
    tokenAAmountEther: BigNumber,
    tokenBAmountEther: BigNumber,
  ): Promise<Transaction> {
    return await this._routes.generateAddLiquidityTransaction(
      tokenAAmountEther, tokenBAmountEther
    );
  }

  /**
   * Generate the lp address approve data allowance to move the tokens.
   * This will return the data for you to send as a transaction
   * @param uniswapVersion The uniswap version
   */
  public async buildApproveAllowanceTransaction(
    uniswapVersion: UniswapVersion,
    isFromToken: boolean
  ): Promise<Transaction> {
    let data;
    if (isFromToken) {
      data = this._fromTokenFactory.generateApproveAllowanceData(
        uniswapVersion === UniswapVersion.v2
          ? uniswapContracts.v2.getRouterAddress(
            this._uniswapPairFactoryContext.settings.cloneUniswapContractDetails
          )
          : uniswapContracts.v3.getRouterAddress(
            this._uniswapPairFactoryContext.settings.cloneUniswapContractDetails
          ),
        '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
      );
    } else {
      data = this._toTokenFactory.generateApproveAllowanceData(
        uniswapVersion === UniswapVersion.v2
          ? uniswapContracts.v2.getRouterAddress(
            this._uniswapPairFactoryContext.settings.cloneUniswapContractDetails
          )
          : uniswapContracts.v3.getRouterAddress(
            this._uniswapPairFactoryContext.settings.cloneUniswapContractDetails
          ),
        '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
      );
    }


    return {
      to: isFromToken
        ? this.tokenA.contractAddress
        : this.tokenB.contractAddress,
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
  private buildCurrentInfoContext(trade: UniswapAddLiquidityInfoContext): UniswapAddLiquidityInfoContext {
    return deepClone({
      uniswapVersion: trade.uniswapVersion,
      lpToken: trade.lpToken,
      lpTokenBalance: trade.lpTokenBalance,
      tokenAPerLpToken: trade.tokenAPerLpToken,
      tokenBPerLpToken: trade.tokenBPerLpToken,
      estimatedTokenAOwned: trade.estimatedTokenAOwned,
      estimatedTokenBOwned: trade.estimatedTokenBOwned,
      tokenAPerTokenB: trade.tokenAPerTokenB,
      tokenBPerTokenA: trade.tokenBPerTokenA,
      tokenAReserve: trade.tokenAReserve,
      tokenBReserve: trade.tokenBReserve,
      allowanceA: trade.allowanceA,
      allowanceB: trade.allowanceB,
      isFirstSupplier: trade.isFirstSupplier,
      selfPoolLpToken: trade.selfPoolLpToken,
      totalPoolLpToken: trade.totalPoolLpToken,
      currentPoolShareInPercent: trade.currentPoolShareInPercent
    });
  }

  /**
   * finds the add trade information
   */
  private async findPairAddTradeInfo(): Promise<UniswapAddLiquidityInfoContext> {
    return await this._routes.getAddLiquidityRatioBasedQuote();
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
   * Handle new block for the trade price moving automatically emitting the stream if it changes
   */
  private async handleTimerBasedNewContextData(forceResyncTimer = false): Promise<void> {
    if (forceResyncTimer) {
      this._triggerRsTimer$.next();
    };

    if (this.quoteChanged$.observers.length > 0 && this._currentAddLiquidityInfoContext) {
      const tradeInfo = await this.getAddLiquidityTradeInfo();

      if (
        tradeInfo.tokenAPerLpToken !== this._currentAddLiquidityInfoContext.tokenAPerLpToken ||
        tradeInfo.tokenBPerLpToken !== this._currentAddLiquidityInfoContext.tokenBPerLpToken ||
        tradeInfo.lpTokenBalance !== this._currentAddLiquidityInfoContext.lpTokenBalance
      ) {
        this._currentAddLiquidityInfoContext = this.buildCurrentInfoContext(tradeInfo);
        this.quoteChanged$.next(tradeInfo);
      }

    }
  }
}
