import { Subject, timer } from 'rxjs';
import { startWith, switchMap, takeUntil } from 'rxjs/operators';
import { CoinGecko } from '../../../coin-gecko';
import { ChainId } from '../../../enums/chain-id';
import { UniswapVersion } from '../../../enums/uniswap-version';
import { LiquidityInfoContext, LiquidityInfoContextSingle } from '../../pair/models/liquidity-info-context';
import { LiquidityInfo } from '../../router/models/liquidity-info';
import { UniswapRouterFactory } from '../../router/uniswap-router.factory';
import { UniswapMyPairFactoryContext } from '../models/uniswap-my-pair-factory-context';

export class UniswapMyLiquidity {
  private _uniswapRouterFactory = new UniswapRouterFactory(
    this._coinGecko,
    this._uniswapPairFactoryContext.ethereumAddress,
    { chainId: ChainId.MAINNET, contractAddress: '', decimals: 0, name: '', symbol: '' }, //Does not matter
    { chainId: ChainId.MAINNET, contractAddress: '', decimals: 0, name: '', symbol: '' }, //Does not matter
    this._uniswapPairFactoryContext.settings,
    this._uniswapPairFactoryContext.ethersProvider
  );

  private _timerEnabled = false;
  private readonly _triggerStopTimer$ = new Subject();
  private readonly _triggerRsTimer$ = new Subject();
  private _currentLiquidityInfoContext: LiquidityInfoContext | undefined;
  public quoteChanged$: Map<string, Subject<LiquidityInfoContextSingle>> = new Map();

  constructor(
    private _coinGecko: CoinGecko,
    private _uniswapPairFactoryContext: UniswapMyPairFactoryContext
  ) { }

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
    this.quoteChanged$.forEach((subject) => {
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

  /**
  * this will retrieve pair liquidity information for the pair addresses passed in parameter along with the reactive observer for each individual pair address information
  */
  public async getPairsLiquidityInfo(pairAddresses: Array<string>
  ): Promise<LiquidityInfoContext> {
    this.destroy();

    const liquidityContext = await this.executeLiquidityInfo(pairAddresses);
    this.watchTradePrice();

    return liquidityContext;
  }

  /**
   * Execute the Liquidity Info
   */
  private async executeLiquidityInfo(
    pairAddresses: Array<string>
  ): Promise<LiquidityInfoContext> {
    const liquidityInfo = await this._uniswapRouterFactory.getPairLiquidityInfo(pairAddresses);
    const liquidityInfoContextArr: Array<LiquidityInfoContextSingle> = [];

    liquidityInfo.forEach((val) => {
      this.quoteChanged$.set(val.pairAddress, new Subject<LiquidityInfoContextSingle>());

      const liquidityInfoContext: LiquidityInfoContextSingle = this.buildCurrentLiquidityInfoContext(val);

      liquidityInfoContextArr.push(liquidityInfoContext);
    });

    this._currentLiquidityInfoContext = {
      liquidityInfoContext: [...liquidityInfoContextArr]
    }

    return this._currentLiquidityInfoContext;
  }

  /**
   * Build the current Liquidity Info context
   * @param trade The Liquidity Info context
   */
  private buildCurrentLiquidityInfoContext(liquidityInfo: LiquidityInfo): LiquidityInfoContextSingle {
    return {
      uniswapVersion: UniswapVersion.v2,
      pairAddress: liquidityInfo.pairAddress,
      token0: liquidityInfo.token0,
      token0EstimatedPool: liquidityInfo.token0EstimatedPool,
      token1: liquidityInfo.token1,
      token1EstimatedPool: liquidityInfo.token1EstimatedPool,
      lpTokens: liquidityInfo.lpTokens,
      poolShares: liquidityInfo.poolShares,
      blockTimestampLast: liquidityInfo.blockTimestampLast,
    };
  }

  /**
   * Watch trade price move automatically emitting the stream if it changes
   */
  private watchTradePrice(): void {
    if (!this._timerEnabled) {
      // this._uniswapPairFactoryContext.ethersProvider.provider.on(
      //   'block',
      //   async () => {
      //     await this.handleTimerBasedNewContextData();
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
   * @param forceResyncTimer resync timer 
   * Handle new data observable, runs on timer
   */
  public async handleTimerBasedNewContextData(forceResyncTimer = false): Promise<number> {
    if (forceResyncTimer) {
      this._triggerRsTimer$.next();
    };
    const cachedAddresses = this._currentLiquidityInfoContext?.liquidityInfoContext.map((_context) => _context.pairAddress) ?? [];
    const liquidityInfo = await this._uniswapRouterFactory.getPairLiquidityInfo(cachedAddresses);

    this.quoteChanged$.forEach(async (value, pairAddressKey) => {
      const currLiquidityInfoContextSingle = this._currentLiquidityInfoContext?.liquidityInfoContext.find((_info) => {
        return _info.pairAddress === pairAddressKey;
      });

      const latestLiquidityInfoContextSingle = liquidityInfo.find((_liquidityInfo) => {
        return _liquidityInfo.pairAddress === pairAddressKey;
      })

      if (!!currLiquidityInfoContextSingle && !!latestLiquidityInfoContextSingle) {
        if (latestLiquidityInfoContextSingle.blockTimestampLast > currLiquidityInfoContextSingle.blockTimestampLast) {
          const newLiquidityInfoContextSingle = this.buildCurrentLiquidityInfoContext(latestLiquidityInfoContextSingle);
          const index = this._currentLiquidityInfoContext!.liquidityInfoContext.findIndex((_context) => _context.pairAddress === pairAddressKey);
          this._currentLiquidityInfoContext!.liquidityInfoContext[index] = newLiquidityInfoContextSingle;
          value.next(newLiquidityInfoContextSingle)
        }
      }
    });

    return 1;
  }
}
