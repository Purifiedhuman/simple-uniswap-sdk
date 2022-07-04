import BigNumber from 'bignumber.js';
import { Subject } from 'rxjs';
import { CoinGecko } from '../../coin-gecko';
import { Constants } from '../../common/constants';
import { deepClone } from '../../common/utils/deep-clone';
import { UniswapVersion } from '../../enums/uniswap-version';
import { uniswapContracts } from '../../uniswap-contract-context/get-uniswap-contracts';
import { AllPossibleRoutes } from '../router/models/all-possible-routes';
import { BestRouteQuotes } from '../router/models/best-route-quotes';
import { RouteQuote } from '../router/models/route-quote';
import { UniswapRouterFactory } from '../router/uniswap-router.factory';
import { AllowanceAndBalanceOf } from '../token/models/allowance-balance-of';
import { Token } from '../token/models/token';
import { TokenFactory } from '../token/token.factory';
import { CurrentLiquidityTradeContext } from './models/current-liquidity-trade-context';
import { LiquidityInfoContext } from './models/liquidity-info-context';
import { LiquidityTradeContext } from './models/liquidity-trade-context';
import { TradeDirection } from './models/trade-direction';
import { Transaction } from './models/transaction';
import { UniswapPairFactoryContext } from './models/uniswap-pair-factory-context';

export class UniswapAddLiquidityFactory {
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
  private _quoteChanged$: Array<Subject<LiquidityInfoContext>> = [];

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
   * Destroy the trade instance watchers + subscriptions
   */
  private destroy(): void {
    this._quoteChanged$.forEach((subject) => {
      for (let i = 0; i < subject.observers.length; i++) {
        subject.observers[i].complete();
      }
    })

    this.unwatchTradePrice();
  }

  /**
 * Find Supplied Pairs trade - this will loop through factory contract to check all supplied pairs for wallet address
 */
  public async findSuppliedPairs(): Promise<Array<string>> {
    return this._uniswapRouterFactory.getSuppliedPairs();
  }

  public async getPairsLiquidityInfo(pairAddresses: Array<string>
  ): Promise<Array<LiquidityInfoContext>> {
    const liquidityInfo = await this._uniswapRouterFactory.getPairLiquidityInfo(pairAddresses);
    const liquidityInfoContextArr: Array<LiquidityInfoContext> = [];

    liquidityInfo.forEach((val, index) => {
      this._quoteChanged$[index] = new Subject<LiquidityInfoContext>();

      const liquidityInfoContext: LiquidityInfoContext = {
        uniswapVersion: UniswapVersion.v2,
        pairAddress: val.pairAddress,
        token0: val.token0,
        token0EstimatedPool: val.token0EstimatedPool,
        token1: val.token1,
        token1EstimatedPool: val.token1EstimatedPool,
        lpTokens: val.lpTokens,
        poolShares: val.poolShares,
        quoteChanged$: this._quoteChanged$[index],
        destroy: () => this.destroy(),
      }

      liquidityInfoContextArr.push(liquidityInfoContext);
    });

    return liquidityInfoContextArr;
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
  private buildCurrentTradeContext(trade: LiquidityTradeContext): CurrentLiquidityTradeContext {
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
    // if (this._quoteChanged$.observers.length > 0 && this._currentLiquidityTradeContext) {
    //   const trade = await this.executeTradePath(
    //     new BigNumber(this._currentLiquidityTradeContext.baseConvertRequest),
    //     this._currentLiquidityTradeContext.quoteDirection,
    //     new BigNumber(this._currentLiquidityTradeContext.expectedConvertQuote)
    //   );

    //   if (
    //     trade.tokenA.contractAddress ===
    //     this._currentLiquidityTradeContext.tokenA.contractAddress &&
    //     trade.tokenB.contractAddress ===
    //     this._currentLiquidityTradeContext.tokenB.contractAddress &&
    //     trade.transaction.from ===
    //     this._uniswapPairFactoryContext.ethereumAddress
    //   ) {
    //     if (
    //       trade.expectedConvertQuote !==
    //       this._currentLiquidityTradeContext.expectedConvertQuote ||
    //       this._currentLiquidityTradeContext.tradeExpires >
    //       this._uniswapRouterFactory.generateTradeDeadlineUnixTime()
    //     ) {
    //       this._currentLiquidityTradeContext = this.buildCurrentTradeContext(trade);
    //       this._quoteChanged$.next(trade);
    //     }
    //   }
    // }
  }
}
