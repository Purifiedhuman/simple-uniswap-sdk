import BigNumber from 'bignumber.js';
import { Subject, timer } from 'rxjs';
import { switchMap, takeUntil } from 'rxjs/operators';
import { CoinGecko } from '../../../coin-gecko';
import { Constants } from '../../../common/constants';
import { ErrorCodes } from '../../../common/errors/error-codes';
import { UniswapError } from '../../../common/errors/uniswap-error';
import {
  removeEthFromContractAddress,
  turnTokenIntoEthForResponse
} from '../../../common/tokens/eth';
import { deepClone } from '../../../common/utils/deep-clone';
import { getTradePath } from '../../../common/utils/trade-path';
import { TradePath } from '../../../enums/trade-path';
import { UniswapVersion } from '../../../enums/uniswap-version';
import { uniswapContracts } from '../../../uniswap-contract-context/get-uniswap-contracts';
import { CurrentTradeContext } from '../../pair/models/current-trade-context';
import { TradeContext } from '../../pair/models/trade-context';
import { TradeDirection } from '../../pair/models/trade-direction';
import { Transaction } from '../../pair/models/transaction';
import { UniswapPairFactoryContext } from '../../pair/models/uniswap-pair-factory-context';
import { AllPossibleRoutes } from '../../router/models/all-possible-routes';
import { BestRouteQuotes } from '../../router/models/best-route-quotes';
import { RouteQuote } from '../../router/models/route-quote';
import { UniswapRouterFactory } from '../../router/uniswap-router.factory';
import { AllowanceAndBalanceOf } from '../../token/models/allowance-balance-of';
import { Token } from '../../token/models/token';
import { TokenFactory } from '../../token/token.factory';

export class UniswapSwap {
  private _fromTokenFactory = new TokenFactory(
    this._uniswapPairFactoryContext.fromToken.contractAddress,
    this._uniswapPairFactoryContext.ethersProvider,
    this._uniswapPairFactoryContext.settings.customNetwork,
    this._uniswapPairFactoryContext.settings.cloneUniswapContractDetails
  );

  private _toTokenFactory = new TokenFactory(
    this._uniswapPairFactoryContext.toToken.contractAddress,
    this._uniswapPairFactoryContext.ethersProvider,
    this._uniswapPairFactoryContext.settings.customNetwork
  );

  private _uniswapRouterFactory = new UniswapRouterFactory(
    this._coinGecko,
    this._uniswapPairFactoryContext.ethereumAddress,
    this._uniswapPairFactoryContext.fromToken,
    this._uniswapPairFactoryContext.toToken,
    this._uniswapPairFactoryContext.settings,
    this._uniswapPairFactoryContext.ethersProvider
  );

  private readonly _triggerStopTimer$ = new Subject();
  private readonly _triggerRsTimer$ = new Subject();
  private _currentTradeContext: CurrentTradeContext | undefined;
  public quoteChanged$: Subject<TradeContext> = new Subject<TradeContext>();

  constructor(
    private _coinGecko: CoinGecko,
    private _uniswapPairFactoryContext: UniswapPairFactoryContext
  ) {
    //Start timer after 5 seconds, emits every 5 seconds
    this._triggerRsTimer$
      .pipe(
        switchMap(() => timer(5000, 5000)
          .pipe(takeUntil(this._triggerStopTimer$)))
      )
      .subscribe(() => {
        this.handleTimerBasedNewContextData();
      })
  }

  /**
   * The to token
   */
  public get toToken(): Token {
    return this._uniswapPairFactoryContext.toToken;
  }

  /**
   * The from token
   */
  public get fromToken(): Token {
    return this._uniswapPairFactoryContext.fromToken;
  }

  /**
   * Get the provider url
   */
  public get providerUrl(): string | undefined {
    return this._uniswapPairFactoryContext.ethersProvider.getProviderUrl();
  }

  /**
   * Get the to token balance
   */
  public async getFromTokenBalance(): Promise<string> {
    if (this.tradePath() === TradePath.ethToErc20) {
      const ethBalanceContext =
        await this._uniswapRouterFactory.getEthBalance();
      return ethBalanceContext.toFixed();
    }

    const erc20BalanceContext = await this._fromTokenFactory.balanceOf(
      this._uniswapPairFactoryContext.ethereumAddress
    );

    return new BigNumber(erc20BalanceContext)
      .shiftedBy(this.fromToken.decimals * -1)
      .toFixed();
  }

  /**
   * Get the to token balance
   */
  public async getToTokenBalance(): Promise<string> {
    if (this.tradePath() === TradePath.erc20ToEth) {
      const ethBalanceContext =
        await this._uniswapRouterFactory.getEthBalance();
      return ethBalanceContext.toFixed();
    }

    const erc20BalanceContext = await this._toTokenFactory.balanceOf(
      this._uniswapPairFactoryContext.ethereumAddress
    );

    return new BigNumber(erc20BalanceContext)
      .shiftedBy(this.toToken.decimals * -1)
      .toFixed();
  }

  /**
   * Execute the trade path
   * @param amount The amount
   * @param direction The direction you want to get the quote from
   */
  private async executeTradePath(
    amount: BigNumber,
    direction: TradeDirection
  ): Promise<TradeContext> {
    switch (this.tradePath()) {
      case TradePath.erc20ToEth:
        return await this.findBestPriceAndPathErc20ToEth(amount, direction);
      case TradePath.ethToErc20:
        return await this.findBestPriceAndPathEthToErc20(amount, direction);
      case TradePath.erc20ToErc20:
        return await this.findBestPriceAndPathErc20ToErc20(amount, direction);
      default:
        throw new UniswapError(
          `${this.tradePath()} is not defined`,
          ErrorCodes.tradePathIsNotSupported
        );
    }
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
   * Generate trade - this will return amount but you still need to send the transaction
   * if you want it to be executed on the blockchain
   * @param amount The amount you want to swap
   * @param direction The direction you want to get the quote from
   */
  public async trade(
    amount: string,
    direction: TradeDirection = TradeDirection.input
  ): Promise<TradeContext> {
    this.destroy();

    const trade = await this.executeTradePath(new BigNumber(amount), direction);

    this._currentTradeContext = this.buildCurrentTradeContext(trade);

    // this.watchTradePrice();

    return trade;
  }

  /**
   * Find the best route rate out of all the route quotes
   * @param amountToTrade The amount to trade
   * @param direction The direction you want to get the quote from
   */
  public async findBestRoute(
    amountToTrade: string,
    direction: TradeDirection
  ): Promise<BestRouteQuotes> {
    return await this._routes.findBestRoute(
      new BigNumber(amountToTrade),
      direction
    );
  }

  /**
   * Find the best route rate out of all the route quotes
   * @param amountToTrade The amount to trade
   * @param direction The direction you want to get the quote from
   */
  public async findAllPossibleRoutesWithQuote(
    amountToTrade: string,
    direction: TradeDirection
  ): Promise<RouteQuote[]> {
    return await this._routes.getAllPossibleRoutesWithQuotes(
      new BigNumber(amountToTrade),
      direction
    );
  }

  /**
   * Find all possible routes
   */
  public async findAllPossibleRoutes(): Promise<AllPossibleRoutes> {
    return await this._routes.getAllPossibleRoutes();
  }

  /**
   * Get the allowance and balance for the from token (erc20 > blah) only
   */
  public async getAllowanceAndBalanceOfForFromToken(): Promise<AllowanceAndBalanceOf> {
    return await this._fromTokenFactory.getAllowanceAndBalanceOf(
      this._uniswapPairFactoryContext.ethereumAddress
    );
  }

  /**
   * Get the allowance and balance for to from token (eth > erc20) only
   * @param uniswapVersion The uniswap version
   */
  public async getAllowanceAndBalanceOfForToToken(): Promise<AllowanceAndBalanceOf> {
    return await this._toTokenFactory.getAllowanceAndBalanceOf(
      this._uniswapPairFactoryContext.ethereumAddress
    );
  }

  /**
   * Get the allowance for the amount which can be moved from the `fromToken`
   * on the users behalf. Only valid when the `fromToken` is a ERC20 token.
   * @param uniswapVersion The uniswap version
   */
  public async allowance(uniswapVersion: UniswapVersion): Promise<string> {
    if (this.tradePath() === TradePath.ethToErc20) {
      return '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    }

    const allowance = await this._fromTokenFactory.allowance(
      uniswapVersion,
      this._uniswapPairFactoryContext.ethereumAddress
    );

    return allowance;
  }

  /**
   * Generate the from token approve data max allowance to move the tokens.
   * This will return the data for you to send as a transaction
   * @param uniswapVersion The uniswap version
   */
  public async generateApproveMaxAllowanceData(
    uniswapVersion: UniswapVersion
  ): Promise<Transaction> {
    if (this.tradePath() === TradePath.ethToErc20) {
      throw new UniswapError(
        'You do not need to generate approve uniswap allowance when doing eth > erc20',
        ErrorCodes.generateApproveMaxAllowanceDataNotAllowed
      );
    }

    const data = this._fromTokenFactory.generateApproveAllowanceData(
      uniswapVersion === UniswapVersion.v2
        ? uniswapContracts.v2.getRouterAddress(
          this._uniswapPairFactoryContext.settings.cloneUniswapContractDetails
        )
        : uniswapContracts.v3.getRouterAddress(
          this._uniswapPairFactoryContext.settings.cloneUniswapContractDetails
        ),
      '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
    );

    return {
      to: this.fromToken.contractAddress,
      from: this._uniswapPairFactoryContext.ethereumAddress,
      data,
      value: Constants.EMPTY_HEX_STRING,
    };
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
  private buildCurrentTradeContext(trade: TradeContext): CurrentTradeContext {
    return deepClone({
      baseConvertRequest: trade.baseConvertRequest,
      expectedConvertQuote: trade.expectedConvertQuote,
      quoteDirection: trade.quoteDirection,
      fromToken: trade.fromToken,
      toToken: trade.toToken,
      liquidityProviderFee: trade.liquidityProviderFee,
      transaction: trade.transaction,
      routeText: trade.routeText,
      tradeExpires: trade.tradeExpires,
    });
  }

  /**
   * finds the best price and path for Erc20ToEth
   * @param baseConvertRequest The base convert request can be both input or output direction
   * @param direction The direction you want to get the quote from
   */
  private async findBestPriceAndPathErc20ToEth(
    baseConvertRequest: BigNumber,
    direction: TradeDirection
  ): Promise<TradeContext> {
    const bestRouteQuotes = await this._routes.findBestRoute(
      baseConvertRequest,
      direction
    );

    const bestRouteQuote = bestRouteQuotes.bestRouteQuote;

    const tradeContext: TradeContext = {
      uniswapVersion: bestRouteQuote.uniswapVersion,
      quoteDirection: direction,
      baseConvertRequest: baseConvertRequest.toFixed(),
      minAmountConvertQuote:
        direction === TradeDirection.input
          ? bestRouteQuote.expectedConvertQuoteOrTokenAmountInMaxWithSlippage
          : null,
      maximumSent:
        direction === TradeDirection.input
          ? null
          : bestRouteQuote.expectedConvertQuoteOrTokenAmountInMaxWithSlippage,
      expectedConvertQuote: bestRouteQuote.expectedConvertQuote,
      liquidityProviderFee:
        direction === TradeDirection.input
          ? baseConvertRequest
            .times(bestRouteQuote.liquidityProviderFee)
            .toFixed(this.fromToken.decimals)
          : new BigNumber(bestRouteQuote.expectedConvertQuote)
            .times(bestRouteQuote.liquidityProviderFee)
            .toFixed(this.fromToken.decimals),
      liquidityProviderFeePercent: bestRouteQuote.liquidityProviderFee,
      tradeExpires: bestRouteQuote.tradeExpires,
      routePathTokenMap: bestRouteQuote.routePathArrayTokenMap,
      routeText: bestRouteQuote.routeText,
      routePath: bestRouteQuote.routePathArray.map((r) =>
        removeEthFromContractAddress(r)
      ),
      hasEnoughAllowance: bestRouteQuotes.hasEnoughAllowance,
      approvalTransaction: !bestRouteQuotes.hasEnoughAllowance
        ? await this.generateApproveMaxAllowanceData(
          bestRouteQuote.uniswapVersion
        )
        : undefined,
      toToken: turnTokenIntoEthForResponse(
        this.toToken,
        this._uniswapPairFactoryContext.settings?.customNetwork?.nativeCurrency
      ),
      toBalance: new BigNumber(bestRouteQuotes.toBalance)
        .shiftedBy(this.toToken.decimals * -1)
        .toFixed(),
      fromToken: this.fromToken,
      fromBalance: {
        hasEnough: bestRouteQuotes.hasEnoughBalance,
        balance: bestRouteQuotes.fromBalance,
      },
      transaction: bestRouteQuote.transaction,
      gasPriceEstimatedBy: bestRouteQuote.gasPriceEstimatedBy,
      allTriedRoutesQuotes: bestRouteQuotes.triedRoutesQuote
    };

    return tradeContext;
  }

  /**
   * finds the best price and path for Erc20ToErc20
   * @param baseConvertRequest The base convert request can be both input or output direction
   * @param direction The direction you want to get the quote from
   */
  private async findBestPriceAndPathErc20ToErc20(
    baseConvertRequest: BigNumber,
    direction: TradeDirection
  ): Promise<TradeContext> {
    const bestRouteQuotes = await this._routes.findBestRoute(
      baseConvertRequest,
      direction
    );
    const bestRouteQuote = bestRouteQuotes.bestRouteQuote;

    const tradeContext: TradeContext = {
      uniswapVersion: bestRouteQuote.uniswapVersion,
      quoteDirection: direction,
      baseConvertRequest: baseConvertRequest.toFixed(),
      minAmountConvertQuote:
        direction === TradeDirection.input
          ? bestRouteQuote.expectedConvertQuoteOrTokenAmountInMaxWithSlippage
          : null,
      maximumSent:
        direction === TradeDirection.input
          ? null
          : bestRouteQuote.expectedConvertQuoteOrTokenAmountInMaxWithSlippage,
      expectedConvertQuote: bestRouteQuote.expectedConvertQuote,
      liquidityProviderFee:
        direction === TradeDirection.input
          ? baseConvertRequest
            .times(bestRouteQuote.liquidityProviderFee)
            .toFixed(this.fromToken.decimals)
          : new BigNumber(bestRouteQuote.expectedConvertQuote)
            .times(bestRouteQuote.liquidityProviderFee)
            .toFixed(this.fromToken.decimals),
      liquidityProviderFeePercent: bestRouteQuote.liquidityProviderFee,
      tradeExpires: bestRouteQuote.tradeExpires,
      routePathTokenMap: bestRouteQuote.routePathArrayTokenMap,
      routeText: bestRouteQuote.routeText,
      routePath: bestRouteQuote.routePathArray,
      hasEnoughAllowance: bestRouteQuotes.hasEnoughAllowance,
      approvalTransaction: !bestRouteQuotes.hasEnoughAllowance
        ? await this.generateApproveMaxAllowanceData(
          bestRouteQuote.uniswapVersion
        )
        : undefined,
      toToken: this.toToken,
      toBalance: new BigNumber(bestRouteQuotes.toBalance)
        .shiftedBy(this.toToken.decimals * -1)
        .toFixed(),
      fromToken: this.fromToken,
      fromBalance: {
        hasEnough: bestRouteQuotes.hasEnoughBalance,
        balance: bestRouteQuotes.fromBalance,
      },
      transaction: bestRouteQuote.transaction,
      gasPriceEstimatedBy: bestRouteQuote.gasPriceEstimatedBy,
      allTriedRoutesQuotes: bestRouteQuotes.triedRoutesQuote
    };

    return tradeContext;
  }

  /**
   * Find the best price and route path to take (will round down the slippage)
   * @param baseConvertRequest The base convert request can be both input or output direction
   * @param direction The direction you want to get the quote from
   */
  private async findBestPriceAndPathEthToErc20(
    baseConvertRequest: BigNumber,
    direction: TradeDirection
  ): Promise<TradeContext> {
    const bestRouteQuotes = await this._routes.findBestRoute(
      baseConvertRequest,
      direction
    );
    const bestRouteQuote = bestRouteQuotes.bestRouteQuote;

    const tradeContext: TradeContext = {
      uniswapVersion: bestRouteQuote.uniswapVersion,
      quoteDirection: direction,
      baseConvertRequest: baseConvertRequest.toFixed(),
      minAmountConvertQuote:
        direction === TradeDirection.input
          ? bestRouteQuote.expectedConvertQuoteOrTokenAmountInMaxWithSlippage
          : null,
      maximumSent:
        direction === TradeDirection.input
          ? null
          : bestRouteQuote.expectedConvertQuoteOrTokenAmountInMaxWithSlippage,
      expectedConvertQuote: bestRouteQuote.expectedConvertQuote,
      liquidityProviderFee:
        direction === TradeDirection.input
          ? baseConvertRequest
            .times(bestRouteQuote.liquidityProviderFee)
            .toFixed(this.fromToken.decimals)
          : new BigNumber(bestRouteQuote.expectedConvertQuote)
            .times(bestRouteQuote.liquidityProviderFee)
            .toFixed(this.fromToken.decimals),
      liquidityProviderFeePercent: bestRouteQuote.liquidityProviderFee,
      tradeExpires: bestRouteQuote.tradeExpires,
      routePathTokenMap: bestRouteQuote.routePathArrayTokenMap,
      routeText: bestRouteQuote.routeText,
      routePath: bestRouteQuote.routePathArray.map((r) =>
        removeEthFromContractAddress(r)
      ),
      hasEnoughAllowance: true,
      toToken: this.toToken,
      toBalance: new BigNumber(bestRouteQuotes.toBalance)
        .shiftedBy(this.toToken.decimals * -1)
        .toFixed(),
      fromToken: turnTokenIntoEthForResponse(
        this.fromToken,
        this._uniswapPairFactoryContext.settings?.customNetwork?.nativeCurrency
      ),
      fromBalance: {
        hasEnough: bestRouteQuotes.hasEnoughBalance,
        balance: bestRouteQuotes.fromBalance,
      },
      transaction: bestRouteQuote.transaction,
      gasPriceEstimatedBy: bestRouteQuote.gasPriceEstimatedBy,
      allTriedRoutesQuotes: bestRouteQuotes.triedRoutesQuote
    };

    return tradeContext;
  }

  /**
   * Get the trade path
   */
  private tradePath(): TradePath {
    const network = this._uniswapPairFactoryContext.ethersProvider.network();
    return getTradePath(
      network.chainId,
      this.fromToken,
      this.toToken,
      this._uniswapPairFactoryContext.settings.customNetwork
        ?.nativeWrappedTokenInfo
    );
  }

  // /**
  //  * Watch trade price move automatically emitting the stream if it changes
  //  */
  // private watchTradePrice(): void {
  //   this._triggerStopTimer$.next();
  //   this._triggerRsTimer$.next();
  // }

  /**
   * unwatch any block streams
   */
  private unwatchTradePrice(): void {
    this._triggerStopTimer$.next();
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

    if (this.quoteChanged$.observers.length > 0 && this._currentTradeContext) {
      const trade = await this.executeTradePath(
        new BigNumber(this._currentTradeContext.baseConvertRequest),
        this._currentTradeContext.quoteDirection
      );

      if (
        trade.fromToken.contractAddress ===
        this._currentTradeContext.fromToken.contractAddress &&
        trade.toToken.contractAddress ===
        this._currentTradeContext.toToken.contractAddress &&
        trade.transaction.from ===
        this._uniswapPairFactoryContext.ethereumAddress
      ) {
        if (
          trade.baseConvertRequest === this._currentTradeContext.baseConvertRequest
          && (
            trade.expectedConvertQuote !==
            this._currentTradeContext.expectedConvertQuote ||
            trade.routeText !== this._currentTradeContext.routeText ||
            trade.liquidityProviderFee !==
            this._currentTradeContext.liquidityProviderFee ||
            this._currentTradeContext.tradeExpires >
            this._uniswapRouterFactory.generateTradeDeadlineUnixTime())
        ) {
          this._currentTradeContext = this.buildCurrentTradeContext(trade);
          this.quoteChanged$.next(trade);
        }
      }
    }

    return 1;
  }
}
