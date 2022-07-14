import { Subject } from 'rxjs';
import { CoinGecko } from '../../coin-gecko';
import { Constants } from '../../common/constants';
import { UniswapVersion } from '../../enums/uniswap-version';
import { uniswapContracts } from '../../uniswap-contract-context/get-uniswap-contracts';
import { LiquidityInfo } from '../router/models/liquidity-info';
import { UniswapRouterFactory } from '../router/uniswap-router.factory';
import { AllowanceAndBalanceOf } from '../token/models/allowance-balance-of';
import { Token } from '../token/models/token';
import { TokenFactory } from '../token/token.factory';
import { LiquidityInfoContext, LiquidityInfoContextSingle } from './models/liquidity-info-context';
import { Transaction } from './models/transaction';
import { UniswapPairFactoryContext } from './models/uniswap-pair-factory-context';

export class UniswapMyLiquidityFactory {
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
  private _currentLiquidityInfoContext: LiquidityInfoContext | undefined;
  public quoteChanged$: Map<string, Subject<LiquidityInfoContextSingle>> = new Map();

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

    const liquidityContext = this.executeLiquidityInfo(pairAddresses);
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
  }
}
