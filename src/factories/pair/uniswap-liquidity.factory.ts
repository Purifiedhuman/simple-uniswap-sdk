import BigNumber from 'bignumber.js';
import { Subject } from 'rxjs';
import { CoinGecko } from '../../coin-gecko';
import { Constants } from '../../common/constants';
import { ErrorCodes } from '../../common/errors/error-codes';
import { UniswapError } from '../../common/errors/uniswap-error';
import { deepClone } from '../../common/utils/deep-clone';
import { getTradePath } from '../../common/utils/trade-path';
import { TradePath } from '../../enums/trade-path';
import { UniswapVersion } from '../../enums/uniswap-version';
import { uniswapContracts } from '../../uniswap-contract-context/get-uniswap-contracts';
import { AllPossibleRoutes } from '../router/models/all-possible-routes';
import { BestRouteQuotes } from '../router/models/best-route-quotes';
import { RouteQuote } from '../router/models/route-quote';
import { UniswapRouterFactory } from '../router/uniswap-router.factory';
import { AllowanceAndBalanceOf } from '../token/models/allowance-balance-of';
import { Token } from '../token/models/token';
import { TokenFactory } from '../token/token.factory';
import { CurrencyLiquidityTradeContext } from './models/current-liquidity-trade-context';
import { LiquidityTradeContext } from './models/liquidity-trade-context';
import { TradeDirection } from './models/trade-direction';
import { Transaction } from './models/transaction';
import { UniswapPairFactoryContext } from './models/uniswap-pair-factory-context';

export class UniswapLiquidityFactory {
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

  private _watchingBlocks = false;
  private _currentLiquidityTradeContext: CurrencyLiquidityTradeContext | undefined;
  private _quoteChanged$: Subject<LiquidityTradeContext> = new Subject<LiquidityTradeContext>();

  constructor(
    private _coinGecko: CoinGecko,
    private _uniswapPairFactoryContext: UniswapPairFactoryContext
  ) { }

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
    direction: TradeDirection,
    convertAmount?: BigNumber
  ): Promise<LiquidityTradeContext> {
    switch (this.tradePath()) {
      case TradePath.erc20ToEth:
      case TradePath.ethToErc20:
      case TradePath.erc20ToErc20:
        return await this.findBestLiquidityPrice(amount, direction, convertAmount);
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
  private destroy(): void {
    for (let i = 0; i < this._quoteChanged$.observers.length; i++) {
      this._quoteChanged$.observers[i].complete();
    }
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
    direction: TradeDirection = TradeDirection.input,
    convertAmount?: string
  ): Promise<LiquidityTradeContext> {
    this.destroy();

    const trade = await this.executeTradePath(new BigNumber(amount), direction, convertAmount ? new BigNumber(convertAmount) : undefined);
    this._currentLiquidityTradeContext = this.buildCurrentTradeContext(trade);

    this.watchTradePrice();

    return trade;
  }

  /**
 * Find Supplied Pairs trade - this will loop through factory contract to check all supplied pairs for wallet address
 */
  public async findSuppliedPairs(): Promise<Array<String>> {
    return this._uniswapRouterFactory.getSuppliedPairs();
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
        ? this.fromToken.contractAddress
        : this.toToken.contractAddress,
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
  private buildCurrentTradeContext(trade: LiquidityTradeContext): CurrencyLiquidityTradeContext {
    return deepClone({
      baseConvertRequest: trade.baseConvertRequest,
      expectedConvertQuote: trade.expectedConvertQuote,
      quoteDirection: trade.quoteDirection,
      tokenA: trade.tokenA,
      tokenB: trade.tokenB,
      transaction: trade.transaction,
      tradeExpires: trade.tradeExpires,
    });
  }

  /**
   * finds the best liquidity price
   * @param baseConvertRequest The base convert request can be both input or output direction
   * @param direction The direction you want to get the quote from
   */
  private async findBestLiquidityPrice(
    baseConvertRequest: BigNumber,
    direction: TradeDirection,
    convertAmount?: BigNumber,
  ): Promise<LiquidityTradeContext> {
    const liquidityQuotes = await this._routes.getLiquidityQuote(
      baseConvertRequest,
      direction,
      convertAmount,
    );

    const tradeContext: LiquidityTradeContext = {
      uniswapVersion: UniswapVersion.v2, //hardcode, no support for v3
      quoteDirection: direction,
      isFirstSupplier: liquidityQuotes.isFirstSupplier,
      baseConvertRequest: liquidityQuotes.baseConvertRequest,
      expectedConvertQuote: liquidityQuotes.expectedConvertQuote,
      minTokenAAmountConvertQuote: direction === TradeDirection.input
        ? liquidityQuotes.baseConvertRequestMinWithSlippage : liquidityQuotes.expectedConvertQuoteMinWithSlippage,
      minTokenBAmountConvertQuote: direction === TradeDirection.input
        ? liquidityQuotes.expectedConvertQuoteMinWithSlippage : liquidityQuotes.baseConvertRequestMinWithSlippage,
      tradeExpires: liquidityQuotes.tradeExpires,
      tokenAHasEnoughAllowance: liquidityQuotes.fromHasEnoughAllowance,
      tokenBHasEnoughAllowance: liquidityQuotes.toHasEnoughAllowance,
      tokenAApprovalTransaction: !liquidityQuotes.fromHasEnoughAllowance
        ? await this.generateApproveMaxAllowanceData(
          liquidityQuotes.uniswapVersion,
          true
        )
        : undefined,
      tokenBApprovalTransaction: !liquidityQuotes.toHasEnoughAllowance
        ? await this.generateApproveMaxAllowanceData(
          liquidityQuotes.uniswapVersion,
          false
        )
        : undefined,
      tokenA: this.fromToken,
      tokenABalance: {
        hasEnough: liquidityQuotes.fromHasEnoughBalance,
        balance: liquidityQuotes.fromBalance,
      },
      tokenB: this.toToken,
      tokenBBalance: {
        hasEnough: liquidityQuotes.toHasEnoughBalance,
        balance: liquidityQuotes.toBalance,
      },
      lpTokensToReceive: liquidityQuotes.lpTokensToReceive,
      poolShare: liquidityQuotes.poolShares,
      transaction: liquidityQuotes.transaction,
      lpBalance: liquidityQuotes.lpBalance,
      quoteChanged$: this._quoteChanged$,
      destroy: () => this.destroy(),
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
    if (this._quoteChanged$.observers.length > 0 && this._currentLiquidityTradeContext) {
      const trade = await this.executeTradePath(
        new BigNumber(this._currentLiquidityTradeContext.baseConvertRequest),
        this._currentLiquidityTradeContext.quoteDirection,
        new BigNumber(this._currentLiquidityTradeContext.expectedConvertQuote)
      );

      if (
        trade.tokenA.contractAddress ===
        this._currentLiquidityTradeContext.tokenA.contractAddress &&
        trade.tokenB.contractAddress ===
        this._currentLiquidityTradeContext.tokenB.contractAddress &&
        trade.transaction.from ===
        this._uniswapPairFactoryContext.ethereumAddress
      ) {
        if (
          trade.expectedConvertQuote !==
          this._currentLiquidityTradeContext.expectedConvertQuote ||
          this._currentLiquidityTradeContext.tradeExpires >
          this._uniswapRouterFactory.generateTradeDeadlineUnixTime()
        ) {
          this._currentLiquidityTradeContext = this.buildCurrentTradeContext(trade);
          this._quoteChanged$.next(trade);
        }
      }
    }
  }
}
