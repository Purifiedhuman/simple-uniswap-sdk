import BigNumber from 'bignumber.js';
import {
  CallReturnContext,
  ContractCallContext,
  ContractCallResults
} from 'ethereum-multicall';
import { TokenWithAllowanceInfo } from '../..';
import {
  ExactInputSingleRequest,
  ExactOutputSingleRequest
} from '../../ABI/types/uniswap-router-v3';
import { CoinGecko } from '../../coin-gecko';
import { Constants } from '../../common/constants';
import { ContractContext } from '../../common/contract-context';
import { ErrorCodes } from '../../common/errors/error-codes';
import { UniswapError } from '../../common/errors/uniswap-error';
import { COMP } from '../../common/tokens/comp';
import { DAI } from '../../common/tokens/dai';
import {
  ETH_SYMBOL,
  isNativeEth,
  removeEthFromContractAddress,
  turnTokenIntoEthForResponse
} from '../../common/tokens/eth';
import { USDC } from '../../common/tokens/usdc';
import { USDT } from '../../common/tokens/usdt';
import { WBTC } from '../../common/tokens/wbtc';
import { WETHContract } from '../../common/tokens/weth';
import { deepClone } from '../../common/utils/deep-clone';
import { formatEther } from '../../common/utils/format-ether';
import { hexlify } from '../../common/utils/hexlify';
import { onlyUnique } from '../../common/utils/only-unique';
import { parseEther } from '../../common/utils/parse-ether';
import { toEthersBigNumber } from '../../common/utils/to-ethers-big-number';
import { getTradePath } from '../../common/utils/trade-path';
import { CustomMulticall } from '../../custom-multicall';
import { ChainId } from '../../enums/chain-id';
import { TradePath } from '../../enums/trade-path';
import { UniswapVersion } from '../../enums/uniswap-version';
import { EthersProvider } from '../../ethers-provider';
import { uniswapContracts } from '../../uniswap-contract-context/get-uniswap-contracts';
import { UniswapContractContextV2 } from '../../uniswap-contract-context/uniswap-contract-context-v2';
import { UniswapContractContextV3 } from '../../uniswap-contract-context/uniswap-contract-context-v3';
import { UniswapAddLiquidityInfoContext } from '../main-logics/models/uniswap-add-liquidity-info-context';
import { UniswapRmLiquidityInfoContext } from '../main-logics/models/uniswap-rm-liquidity-info-context';
import { TradeDirection } from '../pair/models/trade-direction';
import { Transaction } from '../pair/models/transaction';
import { UniswapPairSettings } from '../pair/models/uniswap-pair-settings';
import { AllowanceAndBalanceOf } from '../token/models/allowance-balance-of';
import { Token } from '../token/models/token';
import { TokensFactory } from '../token/tokens.factory';
import { UniswapContractFactoryV2 } from '../uniswap-factory/v2/uniswap-contract.factory.v2';
import { RouterDirection } from './enums/router-direction';
import { AddLiquidityQuote } from './models/add-liquidity-quote';
import { AllPossibleRoutes } from './models/all-possible-routes';
import { BestRouteQuotes } from './models/best-route-quotes';
import { LiquidityInfo } from './models/liquidity-info';
import { RouteContext } from './models/route-context';
import { RouteQuote } from './models/route-quote';
import { RouteQuoteTradeContext } from './models/route-quote-trade-context';
import { TokenRoutes } from './models/token-routes';
import { UniswapRouterContractFactoryV2 } from './v2/uniswap-router-contract.factory.v2';
import {
  FeeAmount,
  feeToPercent,
  percentToFeeAmount
} from './v3/enums/fee-amount-v3';
import { UniswapRouterContractFactoryV3 } from './v3/uniswap-router-contract.factory.v3';

export class UniswapRouterFactory {
  private _multicall = new CustomMulticall(
    this._ethersProvider.provider,
    this._settings?.customNetwork?.multicallContractAddress
  );

  private _uniswapRouterContractFactoryV2 = new UniswapRouterContractFactoryV2(
    this._ethersProvider,
    uniswapContracts.v2.getRouterAddress(
      this._settings.cloneUniswapContractDetails
    )
  );

  private _uniswapContractFactoryV2 = new UniswapContractFactoryV2(
    this._ethersProvider,
    uniswapContracts.v2.getFactoryAddress(
      this._settings.cloneUniswapContractDetails
    )
  );

  private _uniswapRouterContractFactoryV3 = new UniswapRouterContractFactoryV3(
    this._ethersProvider,
    uniswapContracts.v3.getRouterAddress(
      this._settings.cloneUniswapContractDetails
    )
  );

  private _tokensFactory = new TokensFactory(
    this._ethersProvider,
    this._settings.customNetwork,
    this._settings.cloneUniswapContractDetails
  );

  private readonly LIQUIDITY_PROVIDER_FEE_V2 = 0.003;

  constructor(
    private _coinGecko: CoinGecko,
    private _ethereumAddress: string,
    private _fromToken: Token,
    private _toToken: Token,
    private _settings: UniswapPairSettings,
    private _ethersProvider: EthersProvider
  ) { }

  /**
   * Get all possible routes will only go up to 4 due to gas increase the more routes
   * you go.
   */
  public async getAllPossibleRoutes(directOverride = false): Promise<AllPossibleRoutes> {
    let findPairs: Token[][][] = [];

    if (!this._settings.disableMultihops && !directOverride) {
      findPairs = [
        this.mainCurrenciesPairsForFromToken,
        this.mainCurrenciesPairsForToToken,
        this.mainCurrenciesPairsForUSDT,
        this.mainCurrenciesPairsForCOMP,
        this.mainCurrenciesPairsForDAI,
        this.mainCurrenciesPairsForUSDC,
        this.mainCurrenciesPairsForWETH,
        this.mainCurrenciesPairsForWBTC,
        [[this._fromToken, this._toToken]],
      ];
    } else {
      // multihops turned off so only go direct
      findPairs = [[[this._fromToken, this._toToken]]];
    }

    // console.log(JSON.stringify(findPairs, null, 4));

    const contractCallContext: ContractCallContext[] = [];

    if (this._settings.uniswapVersions.includes(UniswapVersion.v2)) {
      contractCallContext.push({
        reference: UniswapVersion.v2,
        contractAddress: uniswapContracts.v2.getFactoryAddress(
          this._settings.cloneUniswapContractDetails
        ),
        abi: UniswapContractContextV2.factoryAbi,
        calls: [],
      });

      for (let pairs = 0; pairs < findPairs.length; pairs++) {
        for (
          let tokenPairs = 0;
          tokenPairs < findPairs[pairs].length;
          tokenPairs++
        ) {
          const fromToken = findPairs[pairs][tokenPairs][0];
          const toToken = findPairs[pairs][tokenPairs][1];

          contractCallContext[0].calls.push({
            reference: `${fromToken.contractAddress}-${toToken.contractAddress}-${fromToken.symbol}/${toToken.symbol}`,
            methodName: 'getPair',
            methodParameters: [
              removeEthFromContractAddress(fromToken.contractAddress),
              removeEthFromContractAddress(toToken.contractAddress),
            ],
          });
        }
      }
    }

    // for now v3 quotes will just be direct aka UNI > AAVE etc!
    if (this._settings.uniswapVersions.includes(UniswapVersion.v3)) {
      contractCallContext.push({
        reference: UniswapVersion.v3,
        contractAddress: uniswapContracts.v3.getFactoryAddress(
          this._settings.cloneUniswapContractDetails
        ),
        abi: UniswapContractContextV3.factoryAbi,
        calls: [
          {
            reference: `${this._fromToken.contractAddress}-${this._toToken.contractAddress}-${this._fromToken.symbol}/${this._toToken.symbol}`,
            methodName: 'getPool',
            methodParameters: [
              removeEthFromContractAddress(this._fromToken.contractAddress),
              removeEthFromContractAddress(this._toToken.contractAddress),
              FeeAmount.LOW,
            ],
          },
          {
            reference: `${this._fromToken.contractAddress}-${this._toToken.contractAddress}-${this._fromToken.symbol}/${this._toToken.symbol}`,
            methodName: 'getPool',
            methodParameters: [
              removeEthFromContractAddress(this._fromToken.contractAddress),
              removeEthFromContractAddress(this._toToken.contractAddress),
              FeeAmount.MEDIUM,
            ],
          },
          {
            reference: `${this._fromToken.contractAddress}-${this._toToken.contractAddress}-${this._fromToken.symbol}/${this._toToken.symbol}`,
            methodName: 'getPool',
            methodParameters: [
              removeEthFromContractAddress(this._fromToken.contractAddress),
              removeEthFromContractAddress(this._toToken.contractAddress),
              FeeAmount.HIGH,
            ],
          },
        ],
      });
    }

    const allPossibleRoutes: AllPossibleRoutes = { v2: [], v3: [] };

    const contractCallResults = await this._multicall.call(contractCallContext);

    if (this._settings.uniswapVersions.includes(UniswapVersion.v2)) {
      const results = contractCallResults.results[UniswapVersion.v2];

      const availablePairs = results.callsReturnContext.filter(
        (c) =>
          c.returnValues[0] !== '0x0000000000000000000000000000000000000000'
      );

      // console.log(JSON.stringify(results.callsReturnContext, null, 4));

      const fromTokenRoutes: TokenRoutes = {
        token: this._fromToken,
        pairs: {
          fromTokenPairs: this.getTokenAvailablePairs(
            this._fromToken,
            availablePairs,
            RouterDirection.from
          ),
        },
      };

      const toTokenRoutes: TokenRoutes = {
        token: this._toToken,
        pairs: {
          toTokenPairs: this.getTokenAvailablePairs(
            this._toToken,
            availablePairs,
            RouterDirection.to
          ),
        },
      };

      // console.log(JSON.stringify(fromTokenRoutes, null, 4));
      // console.log('break');
      // console.log(JSON.stringify(toTokenRoutes, null, 4));
      // console.log('break');

      const allMainRoutes: TokenRoutes[] = [];

      for (let i = 0; i < this.allMainTokens.length; i++) {
        const fromTokenPairs = this.getTokenAvailablePairs(
          this.allMainTokens[i],
          availablePairs,
          RouterDirection.from
        );

        const toTokenPairs = this.getTokenAvailablePairs(
          this.allMainTokens[i],
          availablePairs,
          RouterDirection.to
        );

        allMainRoutes.push({
          token: this.allMainTokens[i],
          pairs: { fromTokenPairs, toTokenPairs },
        });
      }

      // console.log(JSON.stringify(allMainRoutes, null, 4));

      allPossibleRoutes.v2 = this.workOutAllPossibleRoutes(
        fromTokenRoutes,
        toTokenRoutes,
        allMainRoutes
      );
    }

    if (this._settings.uniswapVersions.includes(UniswapVersion.v3)) {
      const results = contractCallResults.results[UniswapVersion.v3];

      for (let i = 0; i < results.callsReturnContext.length; i++) {
        if (
          results.callsReturnContext[i].returnValues[0] !==
          '0x0000000000000000000000000000000000000000'
        ) {
          let liquidityProviderFee!: FeeAmount;
          switch (i) {
            case 0:
              liquidityProviderFee = FeeAmount.LOW;
              break;
            case 1:
              liquidityProviderFee = FeeAmount.MEDIUM;
              break;
            case 2:
              liquidityProviderFee = FeeAmount.HIGH;
              break;
          }

          allPossibleRoutes.v3.push({
            route: [this._fromToken, this._toToken],
            liquidityProviderFee: feeToPercent(liquidityProviderFee),
          });
        }
      }
    }

    // console.log(JSON.stringify(allPossibleRoutes, null, 4));

    return allPossibleRoutes;
  }

  /**
   * Get all possible routes with the quotes
   * @param amountToTrade The amount to trade
   * @param direction The direction you want to get the quote from
   */
  public async getAllPossibleRoutesWithQuotes(
    amountToTrade: BigNumber,
    direction: TradeDirection
  ): Promise<RouteQuote[]> {
    const weiTradeAmountInHex = this.formatAmountToTrade(amountToTrade, direction);

    const routes = await this.getAllPossibleRoutes();

    const contractCallContext: ContractCallContext<RouteContext[]>[] = [];
    if (this._settings.uniswapVersions.includes(UniswapVersion.v2)) {
      contractCallContext.push({
        reference: UniswapVersion.v2,
        contractAddress: uniswapContracts.v2.getRouterAddress(
          this._settings.cloneUniswapContractDetails
        ),
        abi: UniswapContractContextV2.routerAbi,
        calls: [],
        context: routes.v2,
      });

      for (let i = 0; i < routes.v2.length; i++) {
        const routeCombo = routes.v2[i].route.map((c) => {
          return removeEthFromContractAddress(c.contractAddress);
        });

        contractCallContext[0].calls.push({
          reference: `route${i}`,
          methodName:
            direction === TradeDirection.input
              ? 'getAmountsOut'
              : 'getAmountsIn',
          methodParameters: [weiTradeAmountInHex, routeCombo],
        });
      }
    }

    if (this._settings.uniswapVersions.includes(UniswapVersion.v3)) {
      contractCallContext.push({
        reference: UniswapVersion.v3,
        contractAddress: uniswapContracts.v3.getQuoterAddress(
          this._settings.cloneUniswapContractDetails
        ),
        abi: UniswapContractContextV3.quoterAbi,
        calls: [],
        context: routes.v3,
      });

      for (let i = 0; i < routes.v3.length; i++) {
        const routeCombo = routes.v3[i].route.map((c) => {
          return removeEthFromContractAddress(c.contractAddress);
        });

        contractCallContext[
          this._settings.uniswapVersions.includes(UniswapVersion.v2) ? 1 : 0
        ].calls.push({
          reference: `route${i}`,
          methodName:
            direction === TradeDirection.input
              ? 'quoteExactInputSingle'
              : 'quoteExactOutputSingle',
          methodParameters: [
            routeCombo[0],
            routeCombo[1],
            percentToFeeAmount(routes.v3[i].liquidityProviderFee),
            weiTradeAmountInHex,
            0,
          ],
        });
      }
    }

    const contractCallResults = await this._multicall.call(contractCallContext);

    return this.buildRouteQuotesFromResults(
      amountToTrade,
      contractCallResults,
      direction
    );
  }

  /**
   * Finds the best route
   * @param amountToTrade The amount they want to trade
   * @param direction The direction you want to get the quote from
   */
  public async findBestRoute(
    amountToTrade: BigNumber,
    direction: TradeDirection
  ): Promise<BestRouteQuotes> {
    let allRoutes = await this.getAllPossibleRoutesWithQuotes(
      amountToTrade,
      direction
    );

    if (allRoutes.length === 0) {
      throw new UniswapError(
        `No routes found for ${this._fromToken.symbol} > ${this._toToken.symbol}`,
        ErrorCodes.noRoutesFound
      );
    }

    const allowanceAndBalances = await this.hasEnoughAllowanceAndBalance(
      amountToTrade,
      allRoutes[0],
      direction
    );

    if (
      this._ethersProvider.provider.network.chainId === ChainId.MAINNET &&
      this._settings.gasSettings &&
      allowanceAndBalances.enoughBalance
    ) {
      allRoutes = await this.filterWithTransactionFees(
        allRoutes,
        allowanceAndBalances.enoughV2Allowance,
        allowanceAndBalances.enoughV3Allowance
      );
    }

    return {
      bestRouteQuote: allRoutes[0],
      triedRoutesQuote: allRoutes.map((route) => {
        return {
          expectedConvertQuote: route.expectedConvertQuote,
          expectedConvertQuoteOrTokenAmountInMaxWithSlippage:
            route.expectedConvertQuoteOrTokenAmountInMaxWithSlippage,
          transaction: route.transaction,
          tradeExpires: route.tradeExpires,
          routePathArrayTokenMap: route.routePathArrayTokenMap,
          routeText: route.routeText,
          routePathArray: route.routePathArray,
          uniswapVersion: route.uniswapVersion,
          liquidityProviderFee: route.liquidityProviderFee,
          quoteDirection: route.quoteDirection,
          gasPriceEstimatedBy: route.gasPriceEstimatedBy,
        };
      }),
      hasEnoughBalance: allowanceAndBalances.enoughBalance,
      fromBalance: allowanceAndBalances.fromBalance,
      toBalance: allowanceAndBalances.toBalance,
      hasEnoughAllowance:
        allRoutes[0].uniswapVersion === UniswapVersion.v2
          ? allowanceAndBalances.enoughV2Allowance
          : allowanceAndBalances.enoughV3Allowance,
    };
  }

  /**
   * Get Supplied Pairs by wallet address
   */
  public async getSuppliedPairs(): Promise<Array<string>> {
    const suppliedPairsAddress: string[] = [];

    const allPairsLength = new BigNumber(await this._uniswapContractFactoryV2.allPairsLength()).toNumber();

    const allPairsContractCallContext: ContractCallContext<String>[] = [];

    allPairsContractCallContext.push({
      reference: `${UniswapVersion.v2}-factory`,
      contractAddress: uniswapContracts.v2.getFactoryAddress(
        this._settings.cloneUniswapContractDetails
      ),
      abi: UniswapContractContextV2.factoryAbi,
      calls: [],
    });

    for (let i = 0; i < allPairsLength; i++) {
      allPairsContractCallContext[0].calls.push({
        reference: `pair[${i}]`,
        methodName: 'allPairs',
        methodParameters: [i]
      })
    }

    //Get all pairs in factory contract
    const allPairsContractCallResults = await this._multicall.call(allPairsContractCallContext);

    const allPairsResults = allPairsContractCallResults.results[`${UniswapVersion.v2}-factory`];

    const allPairs = allPairsResults.callsReturnContext.filter(
      (c) => c.success
    ).map(
      (c) => c.returnValues[0]
    )

    const getPairsBalanceContractCallContext: ContractCallContext<String>[] = [];

    //Get balance for wallet address for every pairs
    for (let i = 0; i < allPairs.length; i++) {
      getPairsBalanceContractCallContext.push({
        reference: `${UniswapVersion.v2}-pair-${allPairs[i]}`,
        contractAddress: allPairs[i],
        abi: UniswapContractContextV2.pairAbi,
        calls: [
          {
            reference: `balanceOf-${i}`,
            methodName: 'balanceOf',
            methodParameters: [this._ethereumAddress],
          },
        ],
        context: allPairs[i]
      })
    }

    const getPairsBalanceContractCallResults = await this._multicall.call(getPairsBalanceContractCallContext);

    for (const key in getPairsBalanceContractCallResults.results) {
      const contractCallReturnContext = getPairsBalanceContractCallResults.results[key];
      if (contractCallReturnContext) {
        const callReturnContext = contractCallReturnContext.callsReturnContext[0];

        if (!callReturnContext.success) {
          continue;
        }

        const balance = new BigNumber(callReturnContext.returnValues[0].hex);

        if (balance.isGreaterThan(0)) {
          suppliedPairsAddress.push(contractCallReturnContext.originalContractCallContext.context);
        }
      }
    }

    return suppliedPairsAddress;

  }

  /**
   * Get pairs
   */
  public async getPairLiquidityInfo(pairAddresses: Array<string>
  ): Promise<Array<LiquidityInfo>> {
    if (pairAddresses.length === 0) { return []; }

    const suppliedLiquidityPairsInfo: LiquidityInfo[] = [];
    const tokenAddressLookUp: Set<string> = new Set();

    const contractCallContext: ContractCallContext<String>[] = [];

    for (let i = 0; i < pairAddresses.length; i++) {
      contractCallContext.push({
        reference: `${UniswapVersion.v2}-pair-${pairAddresses[i]}`,
        contractAddress: pairAddresses[i],
        abi: UniswapContractContextV2.pairAbi,
        calls: [
          {
            reference: `token0`,
            methodName: 'token0',
            methodParameters: [],
          },
          {
            reference: `token1`,
            methodName: 'token1',
            methodParameters: [],
          },
          {
            reference: `getReserves`,
            methodName: 'getReserves',
            methodParameters: [],
          },
          {
            reference: `totalSupply`,
            methodName: 'totalSupply',
            methodParameters: [],
          },
          {
            reference: `balanceOf`,
            methodName: 'balanceOf',
            methodParameters: [this._ethereumAddress],
          },
          {
            reference: `decimals`,
            methodName: 'decimals',
            methodParameters: [],
          }
        ],
        context: pairAddresses[i]
      })
    }

    const contractCallResults = await this._multicall.call(contractCallContext);

    for (const key in contractCallResults.results) {
      const contractCallReturnContext = contractCallResults.results[key];

      if (contractCallReturnContext) {
        let lpTokenDecimals = 18; //default
        let token0Address: string = '';
        let token1Address: string = '';
        // let weiToken0ReserveInHex: string = '';
        // let weiToken1ReserveInHex: string = '';
        let blockTimestampLast: string = '';
        let weiTotalSupplyInHex: string = '';
        let weiBalanceOfInHex: string = '';

        for (let i = 0; i < contractCallReturnContext.callsReturnContext.length; i++) {
          const callReturnContext = contractCallReturnContext.callsReturnContext[i];

          if (!callReturnContext.success) {
            continue;
          }

          switch (callReturnContext.reference) {
            case `token0`:
              token0Address = callReturnContext.returnValues[0];
              break;
            case `token1`:
              token1Address = callReturnContext.returnValues[0];
              break;
            case `getReserves`:
              // weiToken0ReserveInHex = callReturnContext.returnValues[0].hex;
              // weiToken1ReserveInHex = callReturnContext.returnValues[1].hex;
              blockTimestampLast = callReturnContext.returnValues[2];
              break;
            case `totalSupply`:
              weiTotalSupplyInHex = callReturnContext.returnValues[0].hex;
              break;
            case `balanceOf`:
              weiBalanceOfInHex = callReturnContext.returnValues[0].hex;
              break;
            case `decimals`:
              lpTokenDecimals = callReturnContext.returnValues[0];
              break;
          }
        }

        const etherBalanceOf = formatEther(new BigNumber(weiBalanceOfInHex));
        const etherTotalSupply = formatEther(new BigNumber(weiTotalSupplyInHex));

        tokenAddressLookUp.add(token0Address);
        tokenAddressLookUp.add(token1Address);

        suppliedLiquidityPairsInfo.push({
          walletAddress: this._ethereumAddress,
          pairAddress: contractCallReturnContext.originalContractCallContext.context,
          token0Address: token0Address,
          token1Address: token1Address,
          pairToken0Balance: '',
          pairToken1Balance: '',
          poolShares: this.calculatesPoolShare(etherBalanceOf, etherTotalSupply),
          lpTokens: new BigNumber(weiBalanceOfInHex).shiftedBy(lpTokenDecimals * -1).toFixed(),
          token0: undefined,
          token0EstimatedPool: undefined,
          token1: undefined,
          token1EstimatedPool: undefined,
          pairTotalSupply: etherTotalSupply.toFixed(),
          blockTimestampLast: blockTimestampLast
        })
      }
    }

    if (tokenAddressLookUp.size > 0) {
      const tokens = await this.lookUpTokens(tokenAddressLookUp);

      tokens.forEach((tokenInfo) => {
        suppliedLiquidityPairsInfo.map(
          (suppliedToken) => {
            if (suppliedToken.token0Address === tokenInfo.contractAddress) {
              suppliedToken.token0 = deepClone(tokenInfo);
            }

            if (suppliedToken.token1Address === tokenInfo.contractAddress) {
              suppliedToken.token1 = deepClone(tokenInfo);
            }

            return suppliedToken;
          }
        )
      });
    }

    /************************** Calculate token0 and token1 share according to LP(Start) ***************************/
    const pairBalanceOfToken01ContractCallContext: ContractCallContext<Number>[] = [];

    for (let i = 0; i < suppliedLiquidityPairsInfo.length; i++) {
      pairBalanceOfToken01ContractCallContext.push({
        reference: `${UniswapVersion.v2}-${suppliedLiquidityPairsInfo[i].pairAddress}-token0balance`,
        contractAddress: suppliedLiquidityPairsInfo[i].token0Address,
        abi: ContractContext.erc20Abi,
        calls: [
          {
            reference: `balanceOf`,
            methodName: 'balanceOf',
            methodParameters: [suppliedLiquidityPairsInfo[i].pairAddress],
          },
          {
            reference: `decimals`,
            methodName: 'decimals',
            methodParameters: [],
          }
        ],
        context: i
      })

      pairBalanceOfToken01ContractCallContext.push({
        reference: `${UniswapVersion.v2}-${suppliedLiquidityPairsInfo[i].pairAddress}-token1balance`,
        contractAddress: suppliedLiquidityPairsInfo[i].token1Address,
        abi: ContractContext.erc20Abi,
        calls: [
          {
            reference: `balanceOf`,
            methodName: 'balanceOf',
            methodParameters: [suppliedLiquidityPairsInfo[i].pairAddress],
          },
          {
            reference: `decimals`,
            methodName: 'decimals',
            methodParameters: [],
          }
        ],
        context: i
      })
    }

    const pairBalanceOfToken01ContractCallResults = await this._multicall.call(pairBalanceOfToken01ContractCallContext);

    for (const key in pairBalanceOfToken01ContractCallResults.results) {
      const contractCallReturnContext = pairBalanceOfToken01ContractCallResults.results[key];

      if (contractCallReturnContext) {
        let weiBalanceOfInHex: string = '';
        let tokenDecimals = 18; //default

        for (let i = 0; i < contractCallReturnContext.callsReturnContext.length; i++) {
          const callReturnContext = contractCallReturnContext.callsReturnContext[i];

          if (!callReturnContext.success) {
            continue;
          }

          switch (callReturnContext.reference) {
            case `balanceOf`:
              weiBalanceOfInHex = callReturnContext.returnValues[0].hex;
              break;
            case `decimals`:
              tokenDecimals = callReturnContext.returnValues[0];
              break;
          }
        }

        if (contractCallReturnContext.originalContractCallContext.reference.includes('token0balance')) {
          suppliedLiquidityPairsInfo[contractCallReturnContext.
            originalContractCallContext.context].pairToken0Balance = new BigNumber(weiBalanceOfInHex).shiftedBy(tokenDecimals * -1).toFixed(tokenDecimals);
        }

        if (contractCallReturnContext.originalContractCallContext.reference.includes('token1balance')) {
          suppliedLiquidityPairsInfo[contractCallReturnContext.
            originalContractCallContext.context].pairToken1Balance = new BigNumber(weiBalanceOfInHex).shiftedBy(tokenDecimals * -1).toFixed(tokenDecimals);
        }
      }
    }

    suppliedLiquidityPairsInfo.map((val) => {
      val.token0EstimatedPool = this.calculateToken0Token1PoolFromLP(
        new BigNumber(val.lpTokens), new BigNumber(val.pairTotalSupply), new BigNumber(val.pairToken0Balance), val.token0?.decimals ?? 18);

      val.token1EstimatedPool = this.calculateToken0Token1PoolFromLP(
        new BigNumber(val.lpTokens), new BigNumber(val.pairTotalSupply), new BigNumber(val.pairToken1Balance), val.token1?.decimals ?? 18);

      return val;
    })
    /************************** Calculate token0 and token1 share according to LP(End) ***************************/

    return suppliedLiquidityPairsInfo;
  }


  /**
   * Get add liquidity quote for the amountToTrade
   * @param etherAmountToTradeInBigNumber The amount to trade
   * @param direction The direction you want to get the quote from
   */
  public async getAddLiquidityQuote(
    etherAmountToTradeInBigNumber: BigNumber,
    direction: TradeDirection,
    etherDirectConvertAmount = new BigNumber(0),
  ): Promise<AddLiquidityQuote> {
    const weiTradeAmountInHex = this.formatAmountToTrade(etherAmountToTradeInBigNumber, direction);

    const routes = await this.getAllPossibleRoutes(true);

    const contractCallContext: ContractCallContext<RouteContext[]>[] = [];

    let lpTokenDecimals = 18; //default

    if (this._settings.uniswapVersions.includes(UniswapVersion.v2)) {

      //directOverride ensure tokenA and tokenB direct pair only (0 or 1 in length)
      for (let i = 0; i < routes.v2.length; i++) {
        const routeCombo = routes.v2[i].route.map((c) => {
          return removeEthFromContractAddress(c.contractAddress);
        });

        const pairAddress = await this._uniswapContractFactoryV2.getPair(routeCombo[0], routeCombo[1]);

        contractCallContext.push({
          reference: `${UniswapVersion.v2}-pair`,
          contractAddress: pairAddress,
          abi: UniswapContractContextV2.pairAbi,
          calls: [
            {
              reference: `token0`,
              methodName: 'token0',
              methodParameters: [],
            },
            {
              reference: `token1`,
              methodName: 'token1',
              methodParameters: [],
            },
            {
              reference: `getReserves`,
              methodName: 'getReserves',
              methodParameters: [],
            },
            {
              reference: `totalSupply`,
              methodName: 'totalSupply',
              methodParameters: [],
            },
            {
              reference: `balanceOf`,
              methodName: 'balanceOf',
              methodParameters: [this._ethereumAddress],
            },
            {
              reference: `decimals`,
              methodName: 'decimals',
              methodParameters: [],
            }
          ],
          context: routes.v2,
        });
      }
    }


    const contractCallResults = await this._multicall.call(contractCallContext);

    let isFirstSupplier = false;
    let token0Address: null | string = null;
    let token1Address: null | string = null;
    // let blockTimestampLast: null | string = null;
    let weiToken0ReserveInHex: null | string = null;
    let weiToken1ReserveInHex: null | string = null;
    let weiTotalSupplyInHex: null | string = null;
    let weiBalanceOfInHex: null | string = null;
    let weiExpectedConvertQuoteInHex: null | string = null;

    for (const key in contractCallResults.results) {
      const contractCallReturnContext = contractCallResults.results[key];
      if (contractCallReturnContext) {
        for (let i = 0; i < contractCallReturnContext.callsReturnContext.length; i++) {
          const callReturnContext = contractCallReturnContext.callsReturnContext[i];

          if (!callReturnContext.success) {
            continue;
          }

          switch (callReturnContext.reference) {
            case `token0`:
              token0Address = callReturnContext.returnValues[0];
              break;
            case `token1`:
              token1Address = callReturnContext.returnValues[0];
              break;
            case `getReserves`:
              weiToken0ReserveInHex = callReturnContext.returnValues[0].hex;
              weiToken1ReserveInHex = callReturnContext.returnValues[1].hex;
              // blockTimestampLast = callReturnContext.returnValues[2];
              break;
            case `totalSupply`:
              weiTotalSupplyInHex = callReturnContext.returnValues[0].hex;
              break;
            case `balanceOf`:
              weiBalanceOfInHex = callReturnContext.returnValues[0].hex;
              break;
            case `decimals`:
              lpTokenDecimals = callReturnContext.returnValues[0];
              break;
          }

        }
      }
    }

    let etherTotalSupply = new BigNumber(0);
    if (weiToken0ReserveInHex && weiToken1ReserveInHex) {
      isFirstSupplier = false;
      etherTotalSupply = new BigNumber(weiTotalSupplyInHex ?? 0).shiftedBy(lpTokenDecimals * -1);
      if (direction === TradeDirection.input) {
        //TradeDirection is tokenA(tradeAmount) -> tokenB(expectedConvertQuoteHex), tokenA(_fromToken) = token0
        if (token0Address === removeEthFromContractAddress(this._fromToken.contractAddress)) {
          weiExpectedConvertQuoteInHex = await this._uniswapRouterContractFactoryV2.quote(
            weiTradeAmountInHex, weiToken0ReserveInHex, weiToken1ReserveInHex);
          //TradeDirection is tokenA(tradeAmount) -> tokenB(expectedConvertQuoteHex), tokenB(_toToken) = token0
        } else if (token0Address === removeEthFromContractAddress(this._toToken.contractAddress)) {
          weiExpectedConvertQuoteInHex = await this._uniswapRouterContractFactoryV2.quote(
            weiTradeAmountInHex, weiToken1ReserveInHex, weiToken0ReserveInHex);
        }
      } else if (direction === TradeDirection.output) {
        //TradeDirection is tokenB(tradeAmount) -> tokenA(expectedConvertQuoteHex), tokenB = token1
        if (token1Address === removeEthFromContractAddress(this._toToken.contractAddress)) {
          weiExpectedConvertQuoteInHex = await this._uniswapRouterContractFactoryV2.quote(
            weiTradeAmountInHex, weiToken1ReserveInHex, weiToken0ReserveInHex);
          //TradeDirection is tokenB(tradeAmount) -> tokenA(expectedConvertQuoteHex), tokenB = token0
        } else if (token1Address === removeEthFromContractAddress(this._fromToken.contractAddress)) {
          weiExpectedConvertQuoteInHex = await this._uniswapRouterContractFactoryV2.quote(
            weiTradeAmountInHex, weiToken0ReserveInHex, weiToken1ReserveInHex);
        }
      }
    } else {
      isFirstSupplier = true;
    }

    if (isFirstSupplier) {
      token0Address = removeEthFromContractAddress(this._fromToken.contractAddress);
      token1Address = removeEthFromContractAddress(this._toToken.contractAddress);
    }

    const baseConvertRequestDecimals = direction === TradeDirection.input
      ? this._fromToken.decimals
      : this._toToken.decimals;

    const expectedConvertQuoteDecimals = direction === TradeDirection.input
      ? this._toToken.decimals
      : this._fromToken.decimals;

    const weiBaseConvertRequestInBigNumber = new BigNumber(weiTradeAmountInHex);
    const weiExpectedConvertQuoteInBigNumber =
      isFirstSupplier
        ? new BigNumber(etherDirectConvertAmount.shiftedBy(expectedConvertQuoteDecimals))
        : new BigNumber(weiExpectedConvertQuoteInHex ?? 0);

    const etherExpectedConvertQuoteInBigNumber = this.formatConvertQuoteToEtherBigNumber(weiExpectedConvertQuoteInBigNumber, direction);

    const etherBaseConvertRequestMinWithSlippageInBigNumber = new BigNumber(etherAmountToTradeInBigNumber)
      .minus(
        new BigNumber(etherAmountToTradeInBigNumber)
          .times(this._settings.slippage)
          .toFixed(baseConvertRequestDecimals)
      )
    const weiBaseConvertRequestMinWithSlippageInHex = this.formatAmountToTrade(etherBaseConvertRequestMinWithSlippageInBigNumber, direction);

    const etherExpectedConvertQuoteMinWithSlippageInBigNumber = etherExpectedConvertQuoteInBigNumber
      .minus(
        new BigNumber(etherExpectedConvertQuoteInBigNumber)
          .times(this._settings.slippage)
          .toFixed(expectedConvertQuoteDecimals)
      )

    const weiExpectedConvertQuoteMinWithSlippageInHex = this.formatConvertQuoteToTrade(etherExpectedConvertQuoteMinWithSlippageInBigNumber, direction);

    const tradeExpires = this.generateTradeDeadlineUnixTime();

    let data: null | string = null;
    let transaction: null | Transaction = null;

    switch (this.tradePath()) {
      case TradePath.ethToErc20:
        data = this.generateAddLiquidityDataEthAndErc20(
          UniswapVersion.v2,
          this._toToken.contractAddress,
          direction === TradeDirection.input ? weiExpectedConvertQuoteInBigNumber : weiBaseConvertRequestInBigNumber,
          direction === TradeDirection.input ? new BigNumber(weiExpectedConvertQuoteMinWithSlippageInHex) : new BigNumber(weiBaseConvertRequestMinWithSlippageInHex),
          direction === TradeDirection.input ? new BigNumber(weiBaseConvertRequestMinWithSlippageInHex) : new BigNumber(weiExpectedConvertQuoteMinWithSlippageInHex),
          tradeExpires.toString()
        )

        transaction = this.buildUpTransactionEth(UniswapVersion.v2, direction === TradeDirection.input
          ? etherAmountToTradeInBigNumber
          : etherExpectedConvertQuoteInBigNumber, data);
        break;
      case TradePath.erc20ToEth:
        data = this.generateAddLiquidityDataEthAndErc20(
          UniswapVersion.v2,
          this._fromToken.contractAddress,
          direction === TradeDirection.input ? weiBaseConvertRequestInBigNumber : weiExpectedConvertQuoteInBigNumber,
          direction === TradeDirection.input ? new BigNumber(weiBaseConvertRequestMinWithSlippageInHex) : new BigNumber(weiExpectedConvertQuoteMinWithSlippageInHex),
          direction === TradeDirection.input ? new BigNumber(weiExpectedConvertQuoteMinWithSlippageInHex) : new BigNumber(weiBaseConvertRequestMinWithSlippageInHex),
          tradeExpires.toString()
        )

        transaction = this.buildUpTransactionEth(UniswapVersion.v2, direction === TradeDirection.input
          ? etherExpectedConvertQuoteInBigNumber
          : etherAmountToTradeInBigNumber, data);
        break;
      case TradePath.erc20ToErc20:
        data = this.generateAddLiquidityDataErc20AndErc20(
          UniswapVersion.v2,
          this._fromToken.contractAddress,
          this._toToken.contractAddress,
          direction === TradeDirection.input ? weiBaseConvertRequestInBigNumber : weiExpectedConvertQuoteInBigNumber,
          direction === TradeDirection.input ? weiExpectedConvertQuoteInBigNumber : weiBaseConvertRequestInBigNumber,
          direction === TradeDirection.input ? new BigNumber(weiBaseConvertRequestMinWithSlippageInHex) : new BigNumber(weiExpectedConvertQuoteMinWithSlippageInHex),
          direction === TradeDirection.input ? new BigNumber(weiExpectedConvertQuoteMinWithSlippageInHex) : new BigNumber(weiBaseConvertRequestMinWithSlippageInHex),
          tradeExpires.toString()
        )

        transaction = this.buildUpTransactionErc20(UniswapVersion.v2, data);

        break;
      default:
        throw new UniswapError(
          `${this.tradePath} not found`,
          ErrorCodes.tradePathIsNotSupported
        );
    }

    const formattedLpBalance = new BigNumber(weiBalanceOfInHex ?? 0).shiftedBy(lpTokenDecimals * -1).toFixed(lpTokenDecimals);
    const formattedBaseConvertRequest = new BigNumber(etherAmountToTradeInBigNumber).toFixed(baseConvertRequestDecimals);
    const formattedExpectedConvertQuote = new BigNumber(etherExpectedConvertQuoteInBigNumber).toFixed(expectedConvertQuoteDecimals);
    const formattedBaseConvertRequestMinWithSlippage = new BigNumber(etherBaseConvertRequestMinWithSlippageInBigNumber).toFixed(baseConvertRequestDecimals);
    const formattedExpectedConvertQuoteMinWithSlippage = new BigNumber(etherExpectedConvertQuoteMinWithSlippageInBigNumber).toFixed(expectedConvertQuoteDecimals);

    const allowanceAndBalances = await this.hasEnoughAllowanceAndBalanceDirect(
      etherAmountToTradeInBigNumber,
      baseConvertRequestDecimals,
      etherExpectedConvertQuoteInBigNumber,
      expectedConvertQuoteDecimals,
      direction
    );

    /* Rearrange token according to pair contract */
    let etherTokenAmount0 = new BigNumber(0);
    let etherTokenAmount1 = new BigNumber(0);
    let etherReserve0 = new BigNumber(0);
    let etherReserve1 = new BigNumber(0);

    if (direction === TradeDirection.input) {
      if (token0Address === removeEthFromContractAddress(this._fromToken.contractAddress)) {
        etherTokenAmount0 = etherAmountToTradeInBigNumber;
        etherTokenAmount1 = isFirstSupplier ? etherDirectConvertAmount : etherExpectedConvertQuoteInBigNumber;
        etherReserve0 = new BigNumber(weiToken0ReserveInHex ?? 0).shiftedBy(baseConvertRequestDecimals * -1);
        etherReserve1 = new BigNumber(weiToken1ReserveInHex ?? 0).shiftedBy(expectedConvertQuoteDecimals * -1);
      } else if (token0Address === removeEthFromContractAddress(this._toToken.contractAddress)) {
        etherTokenAmount0 = isFirstSupplier ? etherDirectConvertAmount : etherExpectedConvertQuoteInBigNumber;
        etherTokenAmount1 = etherAmountToTradeInBigNumber;
        etherReserve0 = new BigNumber(weiToken0ReserveInHex ?? 0).shiftedBy(expectedConvertQuoteDecimals * -1);
        etherReserve1 = new BigNumber(weiToken1ReserveInHex ?? 0).shiftedBy(baseConvertRequestDecimals * -1);
      }
    } else if (direction === TradeDirection.output) {
      if (token1Address === removeEthFromContractAddress(this._toToken.contractAddress)) {
        etherTokenAmount0 = isFirstSupplier ? etherDirectConvertAmount : etherExpectedConvertQuoteInBigNumber;;
        etherTokenAmount1 = etherAmountToTradeInBigNumber;
        etherReserve0 = new BigNumber(weiToken0ReserveInHex ?? 0).shiftedBy(expectedConvertQuoteDecimals * -1);
        etherReserve1 = new BigNumber(weiToken1ReserveInHex ?? 0).shiftedBy(baseConvertRequestDecimals * -1);
      } else if (token1Address === removeEthFromContractAddress(this._fromToken.contractAddress)) {
        etherTokenAmount0 = etherAmountToTradeInBigNumber;
        etherTokenAmount1 = isFirstSupplier ? etherDirectConvertAmount : etherExpectedConvertQuoteInBigNumber;
        etherReserve0 = new BigNumber(weiToken0ReserveInHex ?? 0).shiftedBy(baseConvertRequestDecimals * -1);
        etherReserve1 = new BigNumber(weiToken1ReserveInHex ?? 0).shiftedBy(expectedConvertQuoteDecimals * -1);
      }
    }

    const lpTokens = this.calculatesLPTokensToReceive(
      etherTokenAmount0,
      etherTokenAmount1,
      etherReserve0,
      etherReserve1,
      etherTotalSupply,
      isFirstSupplier
    );

    return {
      isFirstSupplier,
      baseConvertRequest: formattedBaseConvertRequest,
      expectedConvertQuote: formattedExpectedConvertQuote,
      baseConvertRequestMinWithSlippage: formattedBaseConvertRequestMinWithSlippage,
      expectedConvertQuoteMinWithSlippage: formattedExpectedConvertQuoteMinWithSlippage,
      fromHasEnoughAllowance: allowanceAndBalances.enoughFromV2Allowance,
      toHasEnoughAllowance: allowanceAndBalances.enoughToV2Allowance,
      fromHasEnoughBalance: allowanceAndBalances.enoughFromBalance,
      toHasEnoughBalance: allowanceAndBalances.enoughToBalance,
      fromBalance: allowanceAndBalances.fromBalance,
      toBalance: allowanceAndBalances.toBalance,
      transaction,
      tradeExpires: tradeExpires,
      uniswapVersion: UniswapVersion.v2,
      quoteDirection: direction,
      lpBalance: formattedLpBalance,
      lpTokensToReceive: lpTokens.estimatedLPTokens,
      poolShares: lpTokens.estimatedPoolShares
    }
  }

  /**
   * Get remove liquidity quote
   */
  public async getRmLiquidityQuote(): Promise<UniswapRmLiquidityInfoContext> {
    const routes = await this.getAllPossibleRoutes(true);

    const contractCallContext: ContractCallContext<RouteContext[]>[] = [];
    let pairAddress = '';
    let lpTokenDecimals = 18; //default

    if (this._settings.uniswapVersions.includes(UniswapVersion.v2)) {

      //directOverride ensure tokenA and tokenB direct pair only (0 or 1 in length)
      for (let i = 0; i < routes.v2.length; i++) {
        const routeCombo = routes.v2[i].route.map((c) => {
          return removeEthFromContractAddress(c.contractAddress);
        });

        pairAddress = await this._uniswapContractFactoryV2.getPair(routeCombo[0], routeCombo[1]);

        contractCallContext.push({
          reference: `${UniswapVersion.v2}-pair`,
          contractAddress: pairAddress,
          abi: UniswapContractContextV2.pairAbi,
          calls: [
            {
              reference: `token0`,
              methodName: 'token0',
              methodParameters: [],
            },
            {
              reference: `token1`,
              methodName: 'token1',
              methodParameters: [],
            },
            {
              reference: `getReserves`,
              methodName: 'getReserves',
              methodParameters: [],
            },
            {
              reference: `totalSupply`,
              methodName: 'totalSupply',
              methodParameters: [],
            },
            {
              reference: `balanceOf`,
              methodName: 'balanceOf',
              methodParameters: [this._ethereumAddress],
            },
            {
              reference: `decimals`,
              methodName: 'decimals',
              methodParameters: [],
            }
          ],
          context: routes.v2,
        });
      }
    }

    const contractCallResults = await this._multicall.call(contractCallContext);

    let isPairReversed = false;
    let invalidPair = true;
    let token0Address: null | string = null;
    // let token1Address: null | string = null;
    let weiToken0ReserveInHex: null | string = null;
    let weiToken1ReserveInHex: null | string = null;
    let weiTotalSupplyInHex: null | string = null;
    let weiBalanceOfInHex: null | string = null;


    for (const key in contractCallResults.results) {
      const contractCallReturnContext = contractCallResults.results[key];
      if (contractCallReturnContext) {
        for (let i = 0; i < contractCallReturnContext.callsReturnContext.length; i++) {
          const callReturnContext = contractCallReturnContext.callsReturnContext[i];

          if (!callReturnContext.success) {
            continue;
          }

          switch (callReturnContext.reference) {
            case `token0`:
              token0Address = callReturnContext.returnValues[0];
              break;
            case `token1`:
              // token1Address = callReturnContext.returnValues[0];
              break;
            case `getReserves`:
              weiToken0ReserveInHex = callReturnContext.returnValues[0].hex;
              weiToken1ReserveInHex = callReturnContext.returnValues[1].hex;
              // blockTimestampLast = callReturnContext.returnValues[2];
              break;
            case `totalSupply`:
              weiTotalSupplyInHex = callReturnContext.returnValues[0].hex;
              break;
            case `balanceOf`:
              weiBalanceOfInHex = callReturnContext.returnValues[0].hex;
              break;
            case `decimals`:
              lpTokenDecimals = callReturnContext.returnValues[0];
              break;
          }

        }
      }
    }

    let etherTotalSupply = new BigNumber(0);
    if (weiToken0ReserveInHex && weiToken1ReserveInHex) {
      invalidPair = false;
      etherTotalSupply = new BigNumber(weiTotalSupplyInHex ?? 0).shiftedBy(lpTokenDecimals * -1);
      if (token0Address === removeEthFromContractAddress(this._fromToken.contractAddress)) {
        isPairReversed = false;
      } else if (token0Address === removeEthFromContractAddress(this._toToken.contractAddress)) {
        isPairReversed = true;
      }
    } else {
      invalidPair = true;
    }

    if (invalidPair) {
      //guard condition, exit immediately if pair is invalid
      return {
        uniswapVersion: UniswapVersion.v2, //hardcode, no support for v3
        lpToken: undefined,
        lpTokenBalance: '',
        tokenAPerLpToken: '',
        tokenBPerLpToken: '',
        estimatedTokenAOwned: '',
        estimatedTokenBOwned: '',
        poolShare: '',
        allowance: '',
        invalidPair: true
      };
    }

    let etherReserve0 = new BigNumber(0);
    let etherReserve1 = new BigNumber(0);

    const token0Decimals = isPairReversed
      ? this._toToken.decimals
      : this._fromToken.decimals;

    const token1Decimals = isPairReversed
      ? this._fromToken.decimals
      : this._toToken.decimals;

    etherReserve0 = new BigNumber(weiToken0ReserveInHex ?? 0).shiftedBy(token0Decimals * -1);
    etherReserve1 = new BigNumber(weiToken1ReserveInHex ?? 0).shiftedBy(token1Decimals * -1);
    const formattedLpBalance = new BigNumber(weiBalanceOfInHex ?? 0).shiftedBy(lpTokenDecimals * -1).toFixed(lpTokenDecimals);

    const etherTokenAAndTokenBPerLp = this.calculatesTokenAAndTokenBPerLp(
      etherReserve0,
      etherReserve1,
      etherTotalSupply,
    );

    const poolShare = this.calculatesPoolShare(new BigNumber(formattedLpBalance), etherTotalSupply);

    //Check allowance
    const allowanceAndBalanceOfForTokens = await this._tokensFactory.getAllowanceAndBalanceOfForContracts(
      this._ethereumAddress,
      [pairAddress],
      true
    );

    const tokensFactory = new TokensFactory(
      this._ethersProvider,
      this._settings?.customNetwork
    );

    const token = await tokensFactory.getTokens([
      pairAddress
    ]);

    return {
      uniswapVersion: UniswapVersion.v2, //hardcode, no support for v3
      lpToken: token[0],
      lpTokenBalance: formattedLpBalance,
      poolShare: poolShare,
      tokenAPerLpToken: isPairReversed ? etherTokenAAndTokenBPerLp.perLpEstimatedToken1 : etherTokenAAndTokenBPerLp.perLpEstimatedToken0,
      tokenBPerLpToken: isPairReversed ? etherTokenAAndTokenBPerLp.perLpEstimatedToken0 : etherTokenAAndTokenBPerLp.perLpEstimatedToken1,
      estimatedTokenAOwned: isPairReversed
        ? new BigNumber(formattedLpBalance).multipliedBy(etherTokenAAndTokenBPerLp.perLpEstimatedToken1).toFixed(this._toToken.decimals)
        : new BigNumber(formattedLpBalance).multipliedBy(etherTokenAAndTokenBPerLp.perLpEstimatedToken0).toFixed(this._fromToken.decimals),
      estimatedTokenBOwned: isPairReversed
        ? new BigNumber(formattedLpBalance).multipliedBy(etherTokenAAndTokenBPerLp.perLpEstimatedToken0).toFixed(this._fromToken.decimals)
        : new BigNumber(formattedLpBalance).multipliedBy(etherTokenAAndTokenBPerLp.perLpEstimatedToken1).toFixed(this._toToken.decimals),
      allowance: allowanceAndBalanceOfForTokens[0].allowanceAndBalanceOf.allowanceV2,
      invalidPair,
    };
  }

  /**
   * Get remove liquidity quote
   */
  public async getAddLiquidityRatioBasedQuote(): Promise<UniswapAddLiquidityInfoContext> {
    const routes = await this.getAllPossibleRoutes(true);

    const contractCallContext: ContractCallContext<RouteContext[]>[] = [];
    let pairAddress = '';
    let lpTokenDecimals = 18; //default

    if (this._settings.uniswapVersions.includes(UniswapVersion.v2)) {

      //directOverride ensure tokenA and tokenB direct pair only (0 or 1 in length)
      for (let i = 0; i < routes.v2.length; i++) {
        const routeCombo = routes.v2[i].route.map((c) => {
          return removeEthFromContractAddress(c.contractAddress);
        });

        pairAddress = await this._uniswapContractFactoryV2.getPair(routeCombo[0], routeCombo[1]);

        contractCallContext.push({
          reference: `${UniswapVersion.v2}-pair`,
          contractAddress: pairAddress,
          abi: UniswapContractContextV2.pairAbi,
          calls: [
            {
              reference: `token0`,
              methodName: 'token0',
              methodParameters: [],
            },
            {
              reference: `token1`,
              methodName: 'token1',
              methodParameters: [],
            },
            {
              reference: `getReserves`,
              methodName: 'getReserves',
              methodParameters: [],
            },
            {
              reference: `totalSupply`,
              methodName: 'totalSupply',
              methodParameters: [],
            },
            {
              reference: `balanceOf`,
              methodName: 'balanceOf',
              methodParameters: [this._ethereumAddress],
            },
            {
              reference: `decimals`,
              methodName: 'decimals',
              methodParameters: [],
            }
          ],
          context: routes.v2,
        });
      }
    }

    const contractCallResults = await this._multicall.call(contractCallContext);

    let isPairReversed = false;
    let isFirstSupplier = false;
    let token0Address: null | string = null;
    let token1Address: null | string = null;
    let weiToken0ReserveInHex: null | string = null;
    let weiToken1ReserveInHex: null | string = null;
    let weiTotalSupplyInHex: null | string = null;
    let weiBalanceOfInHex: null | string = null;


    for (const key in contractCallResults.results) {
      const contractCallReturnContext = contractCallResults.results[key];
      if (contractCallReturnContext) {
        for (let i = 0; i < contractCallReturnContext.callsReturnContext.length; i++) {
          const callReturnContext = contractCallReturnContext.callsReturnContext[i];

          if (!callReturnContext.success) {
            continue;
          }

          switch (callReturnContext.reference) {
            case `token0`:
              token0Address = callReturnContext.returnValues[0];
              break;
            case `token1`:
              token1Address = callReturnContext.returnValues[0];
              break;
            case `getReserves`:
              weiToken0ReserveInHex = callReturnContext.returnValues[0].hex;
              weiToken1ReserveInHex = callReturnContext.returnValues[1].hex;
              // blockTimestampLast = callReturnContext.returnValues[2];
              break;
            case `totalSupply`:
              weiTotalSupplyInHex = callReturnContext.returnValues[0].hex;
              break;
            case `balanceOf`:
              weiBalanceOfInHex = callReturnContext.returnValues[0].hex;
              break;
            case `decimals`:
              lpTokenDecimals = callReturnContext.returnValues[0];
              break;
          }

        }
      }
    }

    let etherTotalSupply = new BigNumber(0);
    if (weiToken0ReserveInHex && weiToken1ReserveInHex) {
      isFirstSupplier = false;
      etherTotalSupply = new BigNumber(weiTotalSupplyInHex ?? 0).shiftedBy(lpTokenDecimals * -1);
      if (token0Address === removeEthFromContractAddress(this._fromToken.contractAddress)) {
        isPairReversed = false;
      } else if (token0Address === removeEthFromContractAddress(this._toToken.contractAddress)) {
        isPairReversed = true;
      }
    } else {
      isFirstSupplier = true;
    }

    if (isFirstSupplier) {
      //guard condition, exit immediately if pair is not supplied before
      const allowanceAndBalancesForTokens = await this.getAllowanceAndBalanceForTokens();

      return {
        uniswapVersion: UniswapVersion.v2, //hardcode, no support for v3
        lpToken: undefined,
        lpTokenBalance: '',
        tokenAPerLpToken: '',
        tokenBPerLpToken: '',
        allowanceA: '',
        allowanceB: '',
        estimatedTokenAOwned: allowanceAndBalancesForTokens.fromToken.allowanceV2,
        estimatedTokenBOwned: '',
        isFirstSupplier,
        totalPoolLpToken: '',
        selfPoolLpToken: '',
      };
    }

    let etherReserve0 = new BigNumber(0);
    let etherReserve1 = new BigNumber(0);

    const token0Decimals = isPairReversed
      ? this._toToken.decimals
      : this._fromToken.decimals;

    const token1Decimals = isPairReversed
      ? this._fromToken.decimals
      : this._toToken.decimals;

    etherReserve0 = new BigNumber(weiToken0ReserveInHex ?? 0).shiftedBy(token0Decimals * -1);
    etherReserve1 = new BigNumber(weiToken1ReserveInHex ?? 0).shiftedBy(token1Decimals * -1);
    const formattedLpBalance = new BigNumber(weiBalanceOfInHex ?? 0).shiftedBy(lpTokenDecimals * -1).toFixed(lpTokenDecimals);

    const etherTokenAAndTokenBPerLp = this.calculatesTokenAAndTokenBPerLp(
      etherReserve0,
      etherReserve1,
      etherTotalSupply,
    );

    let allowanceAndBalanceOfForTokens: TokenWithAllowanceInfo[] = [];
    if (token0Address && token1Address) {
      //Check allowance
      allowanceAndBalanceOfForTokens = await this._tokensFactory.getAllowanceAndBalanceOfForContracts(
        this._ethereumAddress,
        [token0Address, token1Address],
        true
      );
    }


    const tokensFactory = new TokensFactory(
      this._ethersProvider,
      this._settings?.customNetwork
    );

    const token = await tokensFactory.getTokens([
      pairAddress
    ]);

    return {
      uniswapVersion: UniswapVersion.v2, //hardcode, no support for v3
      lpToken: token[0],
      lpTokenBalance: formattedLpBalance,
      tokenAPerLpToken: isPairReversed ? etherTokenAAndTokenBPerLp.perLpEstimatedToken1 : etherTokenAAndTokenBPerLp.perLpEstimatedToken0,
      tokenBPerLpToken: isPairReversed ? etherTokenAAndTokenBPerLp.perLpEstimatedToken0 : etherTokenAAndTokenBPerLp.perLpEstimatedToken1,
      allowanceA: isPairReversed ? allowanceAndBalanceOfForTokens[1].allowanceAndBalanceOf.allowanceV2 : allowanceAndBalanceOfForTokens[0].allowanceAndBalanceOf.allowanceV2,
      allowanceB: isPairReversed ? allowanceAndBalanceOfForTokens[0].allowanceAndBalanceOf.allowanceV2 : allowanceAndBalanceOfForTokens[1].allowanceAndBalanceOf.allowanceV2,
      estimatedTokenAOwned: isPairReversed
        ? new BigNumber(formattedLpBalance).multipliedBy(etherTokenAAndTokenBPerLp.perLpEstimatedToken1).toFixed(this._toToken.decimals)
        : new BigNumber(formattedLpBalance).multipliedBy(etherTokenAAndTokenBPerLp.perLpEstimatedToken0).toFixed(this._fromToken.decimals),
      estimatedTokenBOwned: isPairReversed
        ? new BigNumber(formattedLpBalance).multipliedBy(etherTokenAAndTokenBPerLp.perLpEstimatedToken0).toFixed(this._fromToken.decimals)
        : new BigNumber(formattedLpBalance).multipliedBy(etherTokenAAndTokenBPerLp.perLpEstimatedToken1).toFixed(this._toToken.decimals),
      isFirstSupplier,
      totalPoolLpToken: etherTotalSupply.toFixed(lpTokenDecimals),
      selfPoolLpToken: formattedLpBalance,
    };
  }

  /**
   * Generates the trade datetime unix time
   */
  public generateTradeDeadlineUnixTime(): number {
    const now = new Date();
    const expiryDate = new Date(
      now.getTime() + this._settings.deadlineMinutes * 60000
    );
    return (expiryDate.getTime() / 1e3) | 0;
  }

  /**
   * Get eth balance
   */
  public async getEthBalance(): Promise<BigNumber> {
    const balance = await this._ethersProvider.balanceOf(this._ethereumAddress);

    return new BigNumber(balance).shiftedBy(Constants.ETH_MAX_DECIMALS * -1);
  }

  /**
   * Generate addLiquidityEth data eth + erc20
   * @param uniswapVersion The uniswap version
   * @param tokenAddress The token address for erc20
   * @param tokenAmount The token amount in wei
   * @param minTokenAmount The minumum token amount in wei
   * @param minEthAmount The minimum ethers amount in wei
   * @param deadline The deadline it expires unix time
   */
  private generateAddLiquidityDataEthAndErc20(
    uniswapVersion: UniswapVersion,
    tokenAddress: string,
    tokenAmount: BigNumber,
    minTokenAmount: BigNumber,
    minEthAmount: BigNumber,
    deadline: string
  ): string {
    switch (uniswapVersion) {
      case UniswapVersion.v2:
        return this._uniswapRouterContractFactoryV2.addLiquidityETH(
          tokenAddress,
          hexlify(tokenAmount),
          hexlify(minTokenAmount),
          hexlify(minEthAmount),
          this._ethereumAddress,
          deadline
        )
      case UniswapVersion.v3:
      default:
        throw new UniswapError(
          'Uniswap version not supported',
          ErrorCodes.uniswapVersionNotSupported
        );
    }
  }

  /**
  * Generate addLiquidity data erc20 + erc20
  * @param uniswapVersion The uniswap version
  * @param tokenAAddress The token A address for erc20
  * @param tokenBAddress The token B address for erc20
  * @param tokenAmount The token A amount in wei
  * @param tokenBAmount The token B amount in wei
  * @param minTokenAAmount The minumum token A amount in wei
  * @param minTokenBAmount The minimum token B amount in wei
  * @param deadline The deadline it expires unix time
  */
  private generateAddLiquidityDataErc20AndErc20(
    uniswapVersion: UniswapVersion,
    tokenAAddress: string,
    tokenBAddress: string,
    tokenAAmount: BigNumber,
    tokenBAmount: BigNumber,
    minTokenAAmount: BigNumber,
    minTokenBAmount: BigNumber,
    deadline: string
  ): string {
    switch (uniswapVersion) {
      case UniswapVersion.v2:
        return this._uniswapRouterContractFactoryV2.addLiquidity(
          tokenAAddress,
          tokenBAddress,
          hexlify(tokenAAmount),
          hexlify(tokenBAmount),
          hexlify(minTokenAAmount),
          hexlify(minTokenBAmount),
          this._ethereumAddress,
          deadline
        )
      case UniswapVersion.v3:
      default:
        throw new UniswapError(
          'Uniswap version not supported',
          ErrorCodes.uniswapVersionNotSupported
        );
    }
  }

  /**
   * Generate trade data eth > erc20
   * @param ethAmountIn The eth amount in
   * @param tokenAmount The token amount
   * @param routeQuoteTradeContext The route quote trade context
   * @param deadline The deadline it expiries unix time
   */
  private generateTradeDataEthToErc20Input(
    ethAmountIn: BigNumber,
    tokenAmount: BigNumber,
    routeQuoteTradeContext: RouteQuoteTradeContext,
    deadline: string
  ): string {
    // uniswap adds extra digits on even if the token is say 8 digits long
    const convertedMinTokens = tokenAmount
      .shiftedBy(this._toToken.decimals)
      .decimalPlaces(0);

    switch (routeQuoteTradeContext.uniswapVersion) {
      case UniswapVersion.v2:
        return this._uniswapRouterContractFactoryV2.swapExactETHForTokens(
          hexlify(convertedMinTokens),
          routeQuoteTradeContext.routePathArray.map((r) =>
            removeEthFromContractAddress(r)
          ),
          this._ethereumAddress,
          deadline
        );
      case UniswapVersion.v3:
        return this.generateTradeDataForV3Input(
          parseEther(ethAmountIn),
          convertedMinTokens,
          routeQuoteTradeContext.liquidityProviderFee,
          deadline
        );
      default:
        throw new UniswapError(
          'Uniswap version not supported',
          ErrorCodes.uniswapVersionNotSupported
        );
    }
  }

  /**
   * Generate trade data eth > erc20
   * @param tokenAmountInMax The amount in max
   * @param ethAmountOut The amount to receive
   * @param routeQuote The route quote
   * @param deadline The deadline it expiries unix time
   */
  private generateTradeDataEthToErc20Output(
    ethAmountInMax: BigNumber,
    tokenAmountOut: BigNumber,
    routeQuoteTradeContext: RouteQuoteTradeContext,
    deadline: string
  ): string {
    const amountOut = tokenAmountOut
      .shiftedBy(this._toToken.decimals)
      .decimalPlaces(0);

    switch (routeQuoteTradeContext.uniswapVersion) {
      case UniswapVersion.v2:
        return this._uniswapRouterContractFactoryV2.swapETHForExactTokens(
          hexlify(amountOut),
          routeQuoteTradeContext.routePathArray.map((r) =>
            removeEthFromContractAddress(r)
          ),
          this._ethereumAddress,
          deadline
        );
      case UniswapVersion.v3:
        return this.generateTradeDataForV3Output(
          amountOut,
          parseEther(ethAmountInMax),
          routeQuoteTradeContext.liquidityProviderFee,
          deadline
        );
      default:
        throw new UniswapError(
          'Uniswap version not supported',
          ErrorCodes.uniswapVersionNotSupported
        );
    }
  }

  /**
   * Generate trade amount erc20 > eth for input direction
   * @param tokenAmount The amount in
   * @param ethAmountOutMin The min amount to receive
   * @param routeQuoteTradeContext The route quote trade context
   * @param deadline The deadline it expiries unix time
   */
  private generateTradeDataErc20ToEthInput(
    tokenAmount: BigNumber,
    ethAmountOutMin: BigNumber,
    routeQuoteTradeContext: RouteQuoteTradeContext,
    deadline: string
  ): string {
    // uniswap adds extra digits on even if the token is say 8 digits long
    const amountIn = tokenAmount
      .shiftedBy(this._fromToken.decimals)
      .decimalPlaces(0);

    switch (routeQuoteTradeContext.uniswapVersion) {
      case UniswapVersion.v2:
        return this._uniswapRouterContractFactoryV2.swapExactTokensForETH(
          hexlify(amountIn),
          hexlify(parseEther(ethAmountOutMin)),
          routeQuoteTradeContext.routePathArray.map((r) =>
            removeEthFromContractAddress(r)
          ),
          this._ethereumAddress,
          deadline
        );
      case UniswapVersion.v3:
        return this.generateTradeDataForV3Input(
          amountIn,
          parseEther(ethAmountOutMin),
          routeQuoteTradeContext.liquidityProviderFee,
          deadline
        );
      default:
        throw new UniswapError(
          'Uniswap version not supported',
          ErrorCodes.uniswapVersionNotSupported
        );
    }
  }

  /**
   * Generate trade amount erc20 > eth for input direction
   * @param tokenAmountInMax The amount in max
   * @param ethAmountOut The amount to receive
   * @param routeQuoteTradeContext The route quote trade context
   * @param deadline The deadline it expiries unix time
   */
  private generateTradeDataErc20ToEthOutput(
    tokenAmountInMax: BigNumber,
    ethAmountOut: BigNumber,
    routeQuoteTradeContext: RouteQuoteTradeContext,
    deadline: string
  ): string {
    // uniswap adds extra digits on even if the token is say 8 digits long
    const amountInMax = tokenAmountInMax
      .shiftedBy(this._fromToken.decimals)
      .decimalPlaces(0);

    switch (routeQuoteTradeContext.uniswapVersion) {
      case UniswapVersion.v2:
        return this._uniswapRouterContractFactoryV2.swapTokensForExactETH(
          hexlify(parseEther(ethAmountOut)),
          hexlify(amountInMax),
          routeQuoteTradeContext.routePathArray.map((r) =>
            removeEthFromContractAddress(r)
          ),
          this._ethereumAddress,
          deadline
        );
      case UniswapVersion.v3:
        return this.generateTradeDataForV3Output(
          parseEther(ethAmountOut),
          amountInMax,
          routeQuoteTradeContext.liquidityProviderFee,
          deadline
        );
      default:
        throw new UniswapError(
          'Uniswap version not supported',
          ErrorCodes.uniswapVersionNotSupported
        );
    }
  }

  /**
   * Generate trade amount erc20 > erc20 for input
   * @param tokenAmount The token amount
   * @param tokenAmountOut The min token amount out
   * @param routeQuoteTradeContext The route quote trade context
   * @param deadline The deadline it expiries unix time
   */
  private generateTradeDataErc20ToErc20Input(
    tokenAmount: BigNumber,
    tokenAmountMin: BigNumber,
    routeQuoteTradeContext: RouteQuoteTradeContext,
    deadline: string
  ): string {
    // uniswap adds extra digits on even if the token is say 8 digits long
    const amountIn = tokenAmount
      .shiftedBy(this._fromToken.decimals)
      .decimalPlaces(0);
    const amountMin = tokenAmountMin
      .shiftedBy(this._toToken.decimals)
      .decimalPlaces(0);

    switch (routeQuoteTradeContext.uniswapVersion) {
      case UniswapVersion.v2:
        return this._uniswapRouterContractFactoryV2.swapExactTokensForTokens(
          hexlify(amountIn),
          hexlify(amountMin),
          routeQuoteTradeContext.routePathArray,
          this._ethereumAddress,
          deadline
        );
      case UniswapVersion.v3:
        return this.generateTradeDataForV3Input(
          amountIn,
          amountMin,
          routeQuoteTradeContext.liquidityProviderFee,
          deadline
        );
      default:
        throw new UniswapError(
          'Uniswap version not supported',
          ErrorCodes.uniswapVersionNotSupported
        );
    }
  }

  /**
   * Generate trade amount erc20 > erc20 for output
   * @param tokenAmount The token amount
   * @param tokenAmountOut The min token amount out
   * @param routeQuoteTradeContext The route quote trade context
   * @param deadline The deadline it expiries unix time
   */
  private generateTradeDataErc20ToErc20Output(
    tokenAmountInMax: BigNumber,
    tokenAmountOut: BigNumber,
    routeQuoteTradeContext: RouteQuoteTradeContext,
    deadline: string
  ): string {
    // uniswap adds extra digits on even if the token is say 8 digits long
    const amountInMax = tokenAmountInMax
      .shiftedBy(this._fromToken.decimals)
      .decimalPlaces(0);

    const amountOut = tokenAmountOut
      .shiftedBy(this._toToken.decimals)
      .decimalPlaces(0);

    switch (routeQuoteTradeContext.uniswapVersion) {
      case UniswapVersion.v2:
        return this._uniswapRouterContractFactoryV2.swapTokensForExactTokens(
          hexlify(amountOut),
          hexlify(amountInMax),
          routeQuoteTradeContext.routePathArray,
          this._ethereumAddress,
          deadline
        );
      case UniswapVersion.v3:
        return this.generateTradeDataForV3Output(
          amountOut,
          amountInMax,
          routeQuoteTradeContext.liquidityProviderFee,
          deadline
        );
      default:
        throw new UniswapError(
          'Uniswap version not supported',
          ErrorCodes.uniswapVersionNotSupported
        );
    }
  }

  /**
   * Generate trade data for v3
   * @param tokenAmount The token amount
   * @param tokenAmountOut The min token amount out
   * @param liquidityProviderFee The liquidity provider fee
   * @param deadline The deadline it expiries unix time
   */
  private generateTradeDataForV3Input(
    tokenAmount: BigNumber,
    tokenAmountMin: BigNumber,
    liquidityProviderFee: number,
    deadline: string
  ): string {
    const isNativeReceivingNativeEth = isNativeEth(
      this._toToken.contractAddress
    );
    const params: ExactInputSingleRequest = {
      tokenIn: removeEthFromContractAddress(this._fromToken.contractAddress),
      tokenOut: removeEthFromContractAddress(this._toToken.contractAddress),
      fee: percentToFeeAmount(liquidityProviderFee),
      recipient:
        isNativeReceivingNativeEth === true
          ? '0x0000000000000000000000000000000000000000'
          : this._ethereumAddress,
      deadline,
      amountIn: hexlify(tokenAmount),
      amountOutMinimum: hexlify(tokenAmountMin),
      sqrtPriceLimitX96: 0,
    };

    const multicallData: string[] = [];

    multicallData.push(
      this._uniswapRouterContractFactoryV3.exactInputSingle(params)
    );
    if (isNativeEth(this._toToken.contractAddress)) {
      multicallData.push(
        this._uniswapRouterContractFactoryV3.unwrapWETH9(
          hexlify(tokenAmountMin),
          this._ethereumAddress
        )
      );
    }

    return this._uniswapRouterContractFactoryV3.multicall(multicallData);
  }

  /**
   * Generate trade data for v3
   * @param tokenAmountInMax The amount in max
   * @param ethAmountOut The amount to receive
   * @param liquidityProviderFee The liquidity provider fee
   * @param deadline The deadline it expiries unix time
   */
  private generateTradeDataForV3Output(
    amountOut: BigNumber,
    amountInMaximum: BigNumber,
    liquidityProviderFee: number,
    deadline: string
  ): string {
    const isNativeReceivingNativeEth = isNativeEth(
      this._toToken.contractAddress
    );

    const params: ExactOutputSingleRequest = {
      tokenIn: removeEthFromContractAddress(this._fromToken.contractAddress),
      tokenOut: removeEthFromContractAddress(this._toToken.contractAddress),
      fee: percentToFeeAmount(liquidityProviderFee),
      recipient:
        isNativeReceivingNativeEth === true
          ? '0x0000000000000000000000000000000000000000'
          : this._ethereumAddress,
      deadline,
      amountOut: hexlify(amountOut),
      amountInMaximum: hexlify(amountInMaximum),
      sqrtPriceLimitX96: 0,
    };

    const multicallData: string[] = [];

    multicallData.push(
      this._uniswapRouterContractFactoryV3.exactOutputSingle(params)
    );
    if (isNativeEth(this._toToken.contractAddress)) {
      multicallData.push(
        this._uniswapRouterContractFactoryV3.unwrapWETH9(
          hexlify(amountOut),
          this._ethereumAddress
        )
      );
    }

    return this._uniswapRouterContractFactoryV3.multicall(multicallData);
  }

  /** 
 * generateAddLiquidityData - Retrieve and massage and process ether amounts passed in to wei to generate data
 * @param tokenAAmountEther The tokenA amount to add
 * @param tokenBAmountEther The tokenB amount to add
 */
  public async generateAddLiquidityTransaction(
    tokenAAmountEther: BigNumber,
    tokenBAmountEther: BigNumber,
  ): Promise<Transaction> {
    const tradeExpires = this.generateTradeDeadlineUnixTime();
    const ethertokenAMinWithSlippageInBigNumber = new BigNumber(tokenAAmountEther)
      .minus(
        new BigNumber(tokenAAmountEther)
          .times(this._settings.slippage)
          .toFixed(this._fromToken.decimals)
      )

    const ethertokenBMinWithSlippageInBigNumber = new BigNumber(tokenBAmountEther)
      .minus(
        new BigNumber(tokenBAmountEther)
          .times(this._settings.slippage)
          .toFixed(this._toToken.decimals)
      )

    let data: null | string = null;
    let transaction: null | Transaction = null;
    switch (this.tradePath()) {
      case TradePath.ethToErc20:
        data = this.generateAddLiquidityDataEthAndErc20(
          UniswapVersion.v2,
          this._toToken.contractAddress,
          tokenBAmountEther.shiftedBy(this._toToken.decimals),
          ethertokenBMinWithSlippageInBigNumber.shiftedBy(this._toToken.decimals), //tokenB(toToken) is erc
          parseEther(ethertokenAMinWithSlippageInBigNumber), //tokenA(fromToken) is ETH
          tradeExpires.toString()
        )
        transaction = this.buildUpTransactionEth(UniswapVersion.v2, tokenAAmountEther, data);
        break;
      case TradePath.erc20ToEth:
        data = this.generateAddLiquidityDataEthAndErc20(
          UniswapVersion.v2,
          this._fromToken.contractAddress,
          tokenAAmountEther.shiftedBy(this._fromToken.decimals),
          ethertokenAMinWithSlippageInBigNumber.shiftedBy(this._fromToken.decimals), //tokenA(fromToken) is erc
          parseEther(ethertokenBMinWithSlippageInBigNumber), //tokenB(toToken) is ETH
          tradeExpires.toString()
        )
        transaction = this.buildUpTransactionEth(UniswapVersion.v2, tokenBAmountEther, data);
        break;
      case TradePath.erc20ToErc20:
        data = this.generateAddLiquidityDataErc20AndErc20(
          UniswapVersion.v2,
          this._fromToken.contractAddress,
          this._toToken.contractAddress,
          tokenAAmountEther.shiftedBy(this._fromToken.decimals),
          tokenBAmountEther.shiftedBy(this._toToken.decimals),
          ethertokenAMinWithSlippageInBigNumber.shiftedBy(this._fromToken.decimals), //tokenA(fromToken) is erc
          ethertokenBMinWithSlippageInBigNumber.shiftedBy(this._toToken.decimals), //tokenA(fromToken) is erc
          tradeExpires.toString()
        )
        transaction = this.buildUpTransactionErc20(UniswapVersion.v2, data);
        break;
    }
    return transaction;
  }

  /** 
   * generateRmLiquidityData - Retrieve and massage and process ether amounts passed in to wei to generate data
   * @param lpAmountEther The lpAmount to remove
   * @param tokenAAmountEther The tokenA amount to remove
   * @param tokenBAmountEther The tokenB amount to remove
   */
  public async generateRmLiquidityTransaction(
    lpAmountEther: BigNumber,
    tokenAAmountEther: BigNumber,
    tokenBAmountEther: BigNumber,
  ): Promise<Transaction> {
    const routes = await this.getAllPossibleRoutes(true);

    const contractCallContext: ContractCallContext<RouteContext[]>[] = [];
    let pairAddress = '';
    let lpTokenDecimals = 18; //default

    if (this._settings.uniswapVersions.includes(UniswapVersion.v2)) {

      //directOverride ensure tokenA and tokenB direct pair only (0 or 1 in length)
      for (let i = 0; i < routes.v2.length; i++) {
        const routeCombo = routes.v2[i].route.map((c) => {
          return removeEthFromContractAddress(c.contractAddress);
        });

        pairAddress = await this._uniswapContractFactoryV2.getPair(routeCombo[0], routeCombo[1]);

        contractCallContext.push({
          reference: `${UniswapVersion.v2}-pair`,
          contractAddress: pairAddress,
          abi: UniswapContractContextV2.pairAbi,
          calls: [
            {
              reference: `decimals`,
              methodName: 'decimals',
              methodParameters: [],
            }
          ],
          context: routes.v2,
        });
      }
    }

    const contractCallResults = await this._multicall.call(contractCallContext);

    for (const key in contractCallResults.results) {
      const contractCallReturnContext = contractCallResults.results[key];
      if (contractCallReturnContext) {
        for (let i = 0; i < contractCallReturnContext.callsReturnContext.length; i++) {
          const callReturnContext = contractCallReturnContext.callsReturnContext[i];

          if (!callReturnContext.success) {
            continue;
          }

          switch (callReturnContext.reference) {
            case `decimals`:
              lpTokenDecimals = callReturnContext.returnValues[0];
              break;
          }

        }
      }
    }

    const tradeExpires = this.generateTradeDeadlineUnixTime();
    const ethertokenAMinWithSlippageInBigNumber = new BigNumber(tokenAAmountEther)
      .minus(
        new BigNumber(tokenAAmountEther)
          .times(this._settings.slippage)
          .toFixed(this._fromToken.decimals)
      )

    const ethertokenBMinWithSlippageInBigNumber = new BigNumber(tokenBAmountEther)
      .minus(
        new BigNumber(tokenBAmountEther)
          .times(this._settings.slippage)
          .toFixed(this._toToken.decimals)
      )

    const weiLpAmountInBigNumber = lpAmountEther.shiftedBy(lpTokenDecimals);

    let data: null | string = null;
    let transaction: null | Transaction = null;
    switch (this.tradePath()) {
      case TradePath.ethToErc20:
        data = this.generateRmLiquidityDataEthAndErc20(
          UniswapVersion.v2,
          this._toToken.contractAddress,
          weiLpAmountInBigNumber,
          ethertokenBMinWithSlippageInBigNumber.shiftedBy(this._toToken.decimals), //tokenB(toToken) is erc
          parseEther(ethertokenAMinWithSlippageInBigNumber), //tokenA(fromToken) is ETH
          tradeExpires.toString()
        )
        transaction = this.buildUpTransactionErc20(UniswapVersion.v2, data);
        break;
      case TradePath.erc20ToEth:
        data = this.generateRmLiquidityDataEthAndErc20(
          UniswapVersion.v2,
          this._fromToken.contractAddress,
          weiLpAmountInBigNumber,
          ethertokenAMinWithSlippageInBigNumber.shiftedBy(this._fromToken.decimals), //tokenA(fromToken) is erc
          parseEther(ethertokenBMinWithSlippageInBigNumber), //tokenB(toToken) is ETH
          tradeExpires.toString()
        )
        transaction = this.buildUpTransactionErc20(UniswapVersion.v2, data);
        break;
      case TradePath.erc20ToErc20:
        data = this.generateRmLiquidityDataErc20AndErc20(
          UniswapVersion.v2,
          this._fromToken.contractAddress,
          this._toToken.contractAddress,
          weiLpAmountInBigNumber,
          ethertokenAMinWithSlippageInBigNumber.shiftedBy(this._fromToken.decimals), //tokenA(fromToken) is erc
          ethertokenBMinWithSlippageInBigNumber.shiftedBy(this._toToken.decimals), //tokenA(fromToken) is erc
          tradeExpires.toString()
        )
        transaction = this.buildUpTransactionErc20(UniswapVersion.v2, data);
        break;
    }
    return transaction;
  }

  /**
   * Generate generateRmLiquidityDataEthAndErc20 data eth + erc20
   * @param uniswapVersion The uniswap version
   * @param tokenAddress The token address for erc20
   * @param lpAmount The LP amount to remove in wei
   * @param minTokenAmount The minumum token amount in wei
   * @param minEthAmount The minimum ethers amount in wei
   * @param deadline The deadline it expires unix time
   */
  private generateRmLiquidityDataEthAndErc20(
    uniswapVersion: UniswapVersion,
    tokenAddress: string,
    lpAmount: BigNumber,
    minTokenAmount: BigNumber,
    minEthAmount: BigNumber,
    deadline: string
  ): string {
    switch (uniswapVersion) {
      case UniswapVersion.v2:
        return this._uniswapRouterContractFactoryV2.removeLiquidityETH(
          tokenAddress,
          hexlify(lpAmount),
          hexlify(minTokenAmount),
          hexlify(minEthAmount),
          this._ethereumAddress,
          deadline
        )
      case UniswapVersion.v3:
      default:
        throw new UniswapError(
          'Uniswap version not supported',
          ErrorCodes.uniswapVersionNotSupported
        );
    }
  }

  /**
  * Generate addLiquidity data erc20 + erc20
  * @param uniswapVersion The uniswap version
  * @param tokenAAddress The token A address for erc20
  * @param tokenBAddress The token B address for erc20
  * @param lpAmount The LP amount to remove in wei
  * @param minTokenAAmount The minumum token A amount in wei
  * @param minTokenBAmount The minimum token B amount in wei
  * @param deadline The deadline it expires unix time
  */
  private generateRmLiquidityDataErc20AndErc20(
    uniswapVersion: UniswapVersion,
    tokenAAddress: string,
    tokenBAddress: string,
    lpAmount: BigNumber,
    minTokenAAmount: BigNumber,
    minTokenBAmount: BigNumber,
    deadline: string
  ): string {
    switch (uniswapVersion) {
      case UniswapVersion.v2:
        return this._uniswapRouterContractFactoryV2.removeLiquidity(
          tokenAAddress,
          tokenBAddress,
          hexlify(lpAmount),
          hexlify(minTokenAAmount),
          hexlify(minTokenBAmount),
          this._ethereumAddress,
          deadline
        )
      case UniswapVersion.v3:
      default:
        throw new UniswapError(
          'Uniswap version not supported',
          ErrorCodes.uniswapVersionNotSupported
        );
    }
  }

  /**
   * Build up a transaction for erc20 from
   * @param data The data
   */
  public buildUpTransactionErc20(
    uniswapVersion: UniswapVersion,
    data: string
  ): Transaction {
    return {
      to:
        uniswapVersion === UniswapVersion.v2
          ? uniswapContracts.v2.getRouterAddress(
            this._settings.cloneUniswapContractDetails
          )
          : uniswapContracts.v3.getRouterAddress(
            this._settings.cloneUniswapContractDetails
          ),
      from: this._ethereumAddress,
      data,
      value: Constants.EMPTY_HEX_STRING,
    };
  }

  /**
   * Build up a transaction for eth from
   * @param ethValue The eth value
   * @param data The data
   */
  public buildUpTransactionEth(
    uniswapVersion: UniswapVersion,
    ethValue: BigNumber,
    data: string
  ): Transaction {
    return {
      to:
        uniswapVersion === UniswapVersion.v2
          ? uniswapContracts.v2.getRouterAddress(
            this._settings.cloneUniswapContractDetails
          )
          : uniswapContracts.v3.getRouterAddress(
            this._settings.cloneUniswapContractDetails
          ),
      from: this._ethereumAddress,
      data,
      value: toEthersBigNumber(parseEther(ethValue)).toHexString(),
    };
  }

  /**
   * Get the allowance and balance for the from and to token (will get balance for eth as well)
   */
  private async getAllowanceAndBalanceForTokens(): Promise<{
    fromToken: AllowanceAndBalanceOf;
    toToken: AllowanceAndBalanceOf;
  }> {
    const allowanceAndBalanceOfForTokens =
      await this._tokensFactory.getAllowanceAndBalanceOfForContracts(
        this._ethereumAddress,
        [this._fromToken.contractAddress, this._toToken.contractAddress],
        false
      );

    return {
      fromToken: allowanceAndBalanceOfForTokens.find(
        (c) =>
          c.token.contractAddress.toLowerCase() ===
          this._fromToken.contractAddress.toLowerCase()
      )!.allowanceAndBalanceOf,
      toToken: allowanceAndBalanceOfForTokens.find(
        (c) =>
          c.token.contractAddress.toLowerCase() ===
          this._toToken.contractAddress.toLowerCase()
      )!.allowanceAndBalanceOf,
    };
  }

  /**
   * Has got enough allowance to do the trade
   * @param amount The amount you want to swap
   */
  private hasGotEnoughAllowance(amount: string, allowance: string): boolean {
    if (this.tradePath() === TradePath.ethToErc20) {
      return true;
    }

    const bigNumberAllowance = new BigNumber(allowance).shiftedBy(
      this._fromToken.decimals * -1
    );

    if (new BigNumber(amount).isGreaterThan(bigNumberAllowance)) {
      return false;
    }

    return true;
  }

  /**
 * Has got enough allowance to do the trade
 * @param amount The amount you want to trade
 */
  private hasGotEnoughAllowanceDirect(amount: string, allowance: string, isFromToken: boolean): boolean {
    let bigNumberAllowance: BigNumber;

    if (isFromToken) {
      bigNumberAllowance = new BigNumber(allowance).shiftedBy(
        this._fromToken.decimals * -1
      );
    } else {
      bigNumberAllowance = new BigNumber(allowance).shiftedBy(
        this._toToken.decimals * -1
      );
    }


    if (new BigNumber(amount).isGreaterThan(bigNumberAllowance)) {
      return false;
    }

    return true;
  }

  private async hasEnoughAllowanceAndBalance(
    amountToTrade: BigNumber,
    bestRouteQuote: RouteQuote,
    direction: TradeDirection
  ): Promise<{
    enoughBalance: boolean;
    fromBalance: string;
    toBalance: string;
    enoughV2Allowance: boolean;
    enoughV3Allowance: boolean;
  }> {
    const allowanceAndBalancesForTokens =
      await this.getAllowanceAndBalanceForTokens();

    let enoughBalance = false;
    let fromBalance = allowanceAndBalancesForTokens.fromToken.balanceOf;

    switch (this.tradePath()) {
      case TradePath.ethToErc20:
        const result = await this.hasGotEnoughBalanceEth(
          direction === TradeDirection.input
            ? amountToTrade.toFixed()
            : bestRouteQuote.expectedConvertQuote
        );
        enoughBalance = result.hasEnough;
        fromBalance = result.balance;
        break;
      case TradePath.erc20ToErc20:
      case TradePath.erc20ToEth:
        if (direction == TradeDirection.input) {
          const result = this.hasGotEnoughBalanceErc20(
            amountToTrade.toFixed(),
            allowanceAndBalancesForTokens.fromToken.balanceOf
          );

          enoughBalance = result.hasEnough;
          fromBalance = result.balance;
        } else {
          const result = this.hasGotEnoughBalanceErc20(
            bestRouteQuote.expectedConvertQuote,
            allowanceAndBalancesForTokens.fromToken.balanceOf
          );

          enoughBalance = result.hasEnough;
          fromBalance = result.balance;
        }
    }

    const enoughV2Allowance =
      direction === TradeDirection.input
        ? this.hasGotEnoughAllowance(
          amountToTrade.toFixed(),
          allowanceAndBalancesForTokens.fromToken.allowanceV2
        )
        : this.hasGotEnoughAllowance(
          bestRouteQuote.expectedConvertQuote,
          allowanceAndBalancesForTokens.fromToken.allowanceV2
        );

    const enoughV3Allowance =
      direction === TradeDirection.input
        ? this.hasGotEnoughAllowance(
          amountToTrade.toFixed(),
          allowanceAndBalancesForTokens.fromToken.allowanceV3
        )
        : this.hasGotEnoughAllowance(
          bestRouteQuote.expectedConvertQuote,
          allowanceAndBalancesForTokens.fromToken.allowanceV3
        );

    return {
      enoughV2Allowance,
      enoughV3Allowance,
      enoughBalance,
      fromBalance,
      toBalance: allowanceAndBalancesForTokens.toToken.balanceOf,
    };
  }

  /**
 * Work out Allowance and Balance Directly with amount to trade and expected convert quote
 * @param amountToTrade amount to trade in Ether
 * @param expectedConvertQuote expectedConvertQuote in Ether
 * @param direction Trade Direction
 */
  private async hasEnoughAllowanceAndBalanceDirect(
    amountToTrade: BigNumber,
    amountToTradeDecimals: number,
    expectedConvertQuote: BigNumber,
    expectedConvertQuoteDecimals: number,
    direction: TradeDirection
  ): Promise<{
    enoughFromBalance: boolean;
    fromBalance: string;
    enoughToBalance: boolean
    toBalance: string;
    enoughFromV2Allowance: boolean;
    enoughToV2Allowance: boolean;
  }> {
    const allowanceAndBalancesForTokens =
      await this.getAllowanceAndBalanceForTokens();

    //From and To is fixed, regards of TradeDirection
    let enoughFromBalance = false;
    let fromBalance = allowanceAndBalancesForTokens.fromToken.balanceOf;

    let enoughToBalance = false;
    let toBalance = allowanceAndBalancesForTokens.toToken.balanceOf;

    let enoughFromV2Allowance = false;
    let enoughToV2Allowance = false;

    switch (this.tradePath()) {
      case TradePath.ethToErc20:
        if (direction == TradeDirection.input) {
          const fromTokenResult = await this.hasGotEnoughBalanceEth(amountToTrade.toFixed());

          const toTokenResult = this.hasGotEnoughBalanceErc20(
            expectedConvertQuote.toFixed(expectedConvertQuoteDecimals),
            allowanceAndBalancesForTokens.toToken.balanceOf
          );

          enoughFromBalance = fromTokenResult.hasEnough;
          fromBalance = fromTokenResult.balance;

          enoughToBalance = toTokenResult.hasEnough;
          toBalance = toTokenResult.balance;

          enoughFromV2Allowance = true;
          enoughToV2Allowance = this.hasGotEnoughAllowanceDirect(
            expectedConvertQuote.toFixed(expectedConvertQuoteDecimals),
            allowanceAndBalancesForTokens.toToken.allowanceV2,
            false,
          )

        } else {
          const fromTokenResult = await this.hasGotEnoughBalanceEth(expectedConvertQuote.toFixed(expectedConvertQuoteDecimals));

          const toTokenResult = this.hasGotEnoughBalanceErc20(
            amountToTrade.toFixed(amountToTradeDecimals),
            allowanceAndBalancesForTokens.toToken.balanceOf
          );

          enoughFromBalance = fromTokenResult.hasEnough;
          fromBalance = fromTokenResult.balance;

          enoughToBalance = toTokenResult.hasEnough;
          toBalance = toTokenResult.balance;

          enoughFromV2Allowance = true;
          enoughToV2Allowance = this.hasGotEnoughAllowanceDirect(
            amountToTrade.toFixed(amountToTradeDecimals),
            allowanceAndBalancesForTokens.toToken.allowanceV2,
            false,
          )
        }
        break;
      case TradePath.erc20ToErc20:
        if (direction == TradeDirection.input) {
          const fromTokenResult = await this.hasGotEnoughBalanceErc20(
            amountToTrade.toFixed(),
            allowanceAndBalancesForTokens.fromToken.balanceOf
          );

          const toTokenResult = this.hasGotEnoughBalanceErc20(
            expectedConvertQuote.toFixed(expectedConvertQuoteDecimals),
            allowanceAndBalancesForTokens.toToken.balanceOf
          );

          enoughFromBalance = fromTokenResult.hasEnough;
          fromBalance = fromTokenResult.balance;

          enoughToBalance = toTokenResult.hasEnough;
          toBalance = toTokenResult.balance;

          enoughFromV2Allowance = this.hasGotEnoughAllowanceDirect(
            amountToTrade.toFixed(amountToTradeDecimals),
            allowanceAndBalancesForTokens.fromToken.allowanceV2,
            true,
          );

          enoughToV2Allowance = this.hasGotEnoughAllowanceDirect(
            expectedConvertQuote.toFixed(expectedConvertQuoteDecimals),
            allowanceAndBalancesForTokens.toToken.allowanceV2,
            false,
          );

        } else {
          const fromTokenResult = await this.hasGotEnoughBalanceErc20(
            expectedConvertQuote.toFixed(expectedConvertQuoteDecimals),
            allowanceAndBalancesForTokens.fromToken.balanceOf
          );

          const toTokenResult = this.hasGotEnoughBalanceErc20(
            amountToTrade.toFixed(),
            allowanceAndBalancesForTokens.toToken.balanceOf
          );

          enoughFromBalance = fromTokenResult.hasEnough;
          fromBalance = fromTokenResult.balance;

          enoughToBalance = toTokenResult.hasEnough;
          toBalance = toTokenResult.balance;

          enoughFromV2Allowance = this.hasGotEnoughAllowanceDirect(
            expectedConvertQuote.toFixed(expectedConvertQuoteDecimals),
            allowanceAndBalancesForTokens.fromToken.allowanceV2,
            true,
          );

          enoughToV2Allowance = this.hasGotEnoughAllowanceDirect(
            amountToTrade.toFixed(amountToTradeDecimals),
            allowanceAndBalancesForTokens.toToken.allowanceV2,
            false,
          );
        }
        break;
      case TradePath.erc20ToEth:
        if (direction == TradeDirection.input) {
          const fromTokenResult = await this.hasGotEnoughBalanceErc20(
            amountToTrade.toFixed(amountToTradeDecimals),
            allowanceAndBalancesForTokens.fromToken.balanceOf
          );

          const toTokenResult = await this.hasGotEnoughBalanceEth(expectedConvertQuote.toFixed());

          enoughFromBalance = fromTokenResult.hasEnough;
          fromBalance = fromTokenResult.balance;

          enoughToBalance = toTokenResult.hasEnough;
          toBalance = toTokenResult.balance;

          enoughFromV2Allowance = this.hasGotEnoughAllowanceDirect(
            amountToTrade.toFixed(amountToTradeDecimals),
            allowanceAndBalancesForTokens.fromToken.allowanceV2,
            true,
          );

          enoughToV2Allowance = true;


        } else {
          const fromTokenResult = await this.hasGotEnoughBalanceErc20(
            expectedConvertQuote.toFixed(expectedConvertQuoteDecimals),
            allowanceAndBalancesForTokens.fromToken.balanceOf
          );

          const toTokenResult = await this.hasGotEnoughBalanceEth(amountToTrade.toFixed());

          enoughFromBalance = fromTokenResult.hasEnough;
          fromBalance = fromTokenResult.balance;

          enoughToBalance = toTokenResult.hasEnough;
          toBalance = toTokenResult.balance;

          enoughFromV2Allowance = this.hasGotEnoughAllowanceDirect(
            expectedConvertQuote.toFixed(expectedConvertQuoteDecimals),
            allowanceAndBalancesForTokens.fromToken.allowanceV2,
            true,
          );

          enoughToV2Allowance = true;

        }
        break;
    }

    return {
      enoughFromBalance,
      fromBalance,
      enoughToBalance,
      toBalance,
      enoughFromV2Allowance,
      enoughToV2Allowance
    };
  }


  /**
   * Has got enough balance to do the trade (eth check only)
   * @param amount The amount you want to swap
   */
  private async hasGotEnoughBalanceEth(amount: string): Promise<{
    hasEnough: boolean;
    balance: string;
  }> {
    const balance = await this.getEthBalance();

    if (new BigNumber(amount).isGreaterThan(balance)) {
      return {
        hasEnough: false,
        balance: balance.toFixed(),
      };
    }

    return {
      hasEnough: true,
      balance: balance.toFixed(),
    };
  }

  /**
   * Has got enough balance to do the trade (erc20 check only)
   * @param amount The amount you want to swap
   */
  private hasGotEnoughBalanceErc20(
    amount: string,
    balance: string
  ): {
    hasEnough: boolean;
    balance: string;
  } {
    const bigNumberBalance = new BigNumber(balance).shiftedBy(
      this._fromToken.decimals * -1
    );

    if (new BigNumber(amount).isGreaterThan(bigNumberBalance)) {
      return {
        hasEnough: false,
        balance: bigNumberBalance.toFixed(),
      };
    }

    return {
      hasEnough: true,
      balance: bigNumberBalance.toFixed(),
    };
  }

  /**
   * Calculates LP Tokens to receive
   * @param amount0 The ether amount0 to trade in PairContract
   * @param amount1 The ether amount1 to trade in PairContract
   * @param reserve0 The ether reserve0 in PairContract
   * @param reserve1 The ether reserve0 in PairContract
   * @param totalSupply The totalSupply in PairContract
   */
  private calculatesLPTokensToReceive(
    etherAmount0: BigNumber,
    etherAmount1: BigNumber,
    etherReserve0: BigNumber,
    etherReserve1: BigNumber,
    etherTotalSupply: BigNumber,
    isFirstSupplier: boolean,
  ): {
    estimatedLPTokens: string;
    estimatedPoolShares: string;
  } {
    let liquidity = new BigNumber(0);
    if (isFirstSupplier) {
      liquidity = etherAmount0.multipliedBy(etherAmount1).minus(new BigNumber('1000e-18')).sqrt();
    } else {
      liquidity = BigNumber.minimum(
        etherAmount0.multipliedBy(etherTotalSupply).div(etherReserve0),
        etherAmount1.multipliedBy(etherTotalSupply).div(etherReserve1),
      );
    }

    //In percent
    const percentEstimatedPoolShareInBigNumber = liquidity.div(etherTotalSupply.plus(liquidity))
      .shiftedBy(2);

    return {
      estimatedLPTokens: liquidity.toFixed(),
      estimatedPoolShares: percentEstimatedPoolShareInBigNumber.isGreaterThan(100) ? '100' : percentEstimatedPoolShareInBigNumber.toFixed(2)
    };
  }

  /**
   * Calculates TokenA and TokenB Ratio for 1 LP Token
   * @param reserve0 The ether reserve0 in PairContract
   * @param reserve1 The ether reserve0 in PairContract
   * @param totalSupply The totalSupply in PairContract
   */
  private calculatesTokenAAndTokenBPerLp(
    etherReserve0: BigNumber,
    etherReserve1: BigNumber,
    etherTotalSupply: BigNumber,
  ): {
    perLpEstimatedToken0: string;
    perLpEstimatedToken1: string;
  } {
    let perLpEstimatedToken0 = new BigNumber(0);
    let perLpEstimatedToken1 = new BigNumber(0);

    perLpEstimatedToken0 = new BigNumber(1).multipliedBy(etherReserve0).div(etherTotalSupply);
    perLpEstimatedToken1 = new BigNumber(1).multipliedBy(etherReserve1).div(etherTotalSupply);

    return {
      perLpEstimatedToken0: perLpEstimatedToken0.toFixed(),
      perLpEstimatedToken1: perLpEstimatedToken1.toFixed()
    };
  }

  private calculatesPoolShare(
    etherLpTokensAmount: BigNumber,
    etherTotalSupply: BigNumber
  ): string {
    const percentEstimatedPoolShareInBigNumber = etherLpTokensAmount.div(etherTotalSupply).shiftedBy(2);

    return percentEstimatedPoolShareInBigNumber.isGreaterThan(100) ? '100' : percentEstimatedPoolShareInBigNumber.toFixed(2);
  }

  private async lookUpTokens(
    address: Set<string>
  ): Promise<Array<Token>> {
    const tokens = await this._tokensFactory.getTokens(Array.from(address));

    return tokens;
  }

  private calculateToken0Token1PoolFromLP(
    etherLiquidity: BigNumber,
    etherTotalSupply: BigNumber,
    etherReserve: BigNumber,
    decimals: number
  ): string {
    const estimatedPoolToken = etherLiquidity.multipliedBy(etherReserve.div(etherTotalSupply));
    return estimatedPoolToken.toFixed(decimals);
  }

  /**
   * Work out trade fiat cost
   * @param allRoutes All the routes
   * @param enoughAllowanceV2 Has got enough allowance for v2
   * @param enoughAllowanceV3 Has got enough allowance for v3
   */
  private async filterWithTransactionFees(
    allRoutes: RouteQuote[],
    enoughAllowanceV2: boolean,
    enoughAllowanceV3: boolean
  ): Promise<RouteQuote[]> {
    if (this._settings.gasSettings && !this._settings.disableMultihops) {
      const ethContract = WETHContract.MAINNET().contractAddress;

      const fiatPrices = await this._coinGecko.getCoinGeckoFiatPrices([
        this._toToken.contractAddress,
        ethContract,
      ]);

      const toUsdValue = fiatPrices[this._toToken.contractAddress];
      const ethUsdValue = fiatPrices[WETHContract.MAINNET().contractAddress];

      if (toUsdValue && ethUsdValue) {
        const bestRouteQuoteHops = this.getBestRouteQuotesHops(
          allRoutes,
          enoughAllowanceV2,
          enoughAllowanceV3
        );

        const gasPriceGwei = await this._settings.gasSettings.getGasPrice();
        const gasPrice = new BigNumber(gasPriceGwei).times(1e9);

        let bestRoute:
          | {
            routeQuote: RouteQuote;
            expectedConvertQuoteMinusTxFees: BigNumber;
          }
          | undefined;
        for (let i = 0; i < bestRouteQuoteHops.length; i++) {
          const route = bestRouteQuoteHops[i];
          const expectedConvertQuoteFiatPrice = new BigNumber(
            route.expectedConvertQuote
          ).times(toUsdValue);

          const txFee = formatEther(
            new BigNumber(
              (
                await this._ethersProvider.provider.estimateGas(
                  route.transaction
                )
              ).toHexString()
            ).times(gasPrice)
          ).times(ethUsdValue);

          route.gasPriceEstimatedBy = gasPriceGwei;

          const expectedConvertQuoteMinusTxFees =
            expectedConvertQuoteFiatPrice.minus(txFee);

          if (bestRoute) {
            if (
              expectedConvertQuoteMinusTxFees.isGreaterThan(
                bestRoute.expectedConvertQuoteMinusTxFees
              )
            ) {
              bestRoute = {
                routeQuote: bestRouteQuoteHops[i],
                expectedConvertQuoteMinusTxFees,
              };
            }
          } else {
            bestRoute = {
              routeQuote: bestRouteQuoteHops[i],
              expectedConvertQuoteMinusTxFees,
            };
          }
        }

        if (bestRoute) {
          const routeIndex = allRoutes.findIndex(
            (r) =>
              r.expectedConvertQuote ===
              bestRoute!.routeQuote.expectedConvertQuote &&
              bestRoute!.routeQuote.routeText === r.routeText
          );

          allRoutes.splice(routeIndex, 1);
          allRoutes.unshift(bestRoute.routeQuote);
        }
      }
    }

    return allRoutes;
  }

  /**
   * Work out the best route quote hops aka the best direct, the best 3 hop and the best 4 hop
   * @param allRoutes All the routes
   * @param enoughAllowanceV2 Has got enough allowance for v2
   * @param enoughAllowanceV3 Has got enough allowance for v3
   */
  private getBestRouteQuotesHops(
    allRoutes: RouteQuote[],
    enoughAllowanceV2: boolean,
    enoughAllowanceV3: boolean
  ): RouteQuote[] {
    const routes: RouteQuote[] = [];
    for (let i = 0; i < allRoutes.length; i++) {
      if (
        routes.find((r) => r.routePathArray.length === 2) &&
        routes.find((r) => r.routePathArray.length === 3) &&
        routes.find((r) => r.routePathArray.length === 4)
      ) {
        break;
      }

      const route = allRoutes[i];
      if (
        route.uniswapVersion === UniswapVersion.v2
          ? enoughAllowanceV2
          : enoughAllowanceV3
      ) {
        if (
          route.routePathArray.length === 2 &&
          !routes.find((r) => r.routePathArray.length === 2)
        ) {
          routes.push(route);
          continue;
        }

        if (
          route.routePathArray.length === 3 &&
          !routes.find((r) => r.routePathArray.length === 3)
        ) {
          routes.push(route);
          continue;
        }

        if (
          route.routePathArray.length === 4 &&
          !routes.find((r) => r.routePathArray.length === 4)
        ) {
          routes.push(route);
          continue;
        }
      }
    }

    return routes;
  }

  // /**
  //  * Encode the route path for v3 ( WILL NEED WHEN WE SUPPORT V3 DOING NONE DIRECT ROUTES)
  //  * @param path The path
  //  * @param fees The fees
  //  */
  // public encodeRoutePathV3(path: string[], fees: FeeAmount[]): string {
  //   // to do move
  //   const FEE_SIZE = 3;

  //   if (path.length != fees.length + 1) {
  //     throw new Error('path/fee lengths do not match');
  //   }

  //   let encoded = '0x';
  //   for (let i = 0; i < fees.length; i++) {
  //     // 20 byte encoding of the address
  //     encoded += path[i].slice(2);
  //     // 3 byte encoding of the fee
  //     encoded += fees[i].toString(16).padStart(2 * FEE_SIZE, '0');
  //   }
  //   // encode the final token
  //   encoded += path[path.length - 1].slice(2);

  //   return encoded.toLowerCase();
  // }

  /**
   * Works out every possible route it can take - v2 only
   * @param fromTokenRoutes The from token routes
   * @param toTokenRoutes The to token routes
   * @param allMainRoutes All the main routes
   */
  private workOutAllPossibleRoutes(
    fromTokenRoutes: TokenRoutes,
    toTokenRoutes: TokenRoutes,
    allMainRoutes: TokenRoutes[]
  ): RouteContext[] {
    const jointCompatibleRoutes = toTokenRoutes.pairs.toTokenPairs!.filter(
      (t) =>
        fromTokenRoutes.pairs.fromTokenPairs!.find(
          (f) =>
            f.contractAddress.toLowerCase() === t.contractAddress.toLowerCase()
        )
    );

    const routes: RouteContext[] = [];
    if (
      fromTokenRoutes.pairs.fromTokenPairs!.find(
        (t) =>
          t.contractAddress.toLowerCase() ===
          toTokenRoutes.token.contractAddress.toLowerCase()
      )
    ) {
      routes.push({
        route: [fromTokenRoutes.token, toTokenRoutes.token],
        liquidityProviderFee: this.LIQUIDITY_PROVIDER_FEE_V2,
      });
    }

    for (let i = 0; i < allMainRoutes.length; i++) {
      const tokenRoute = allMainRoutes[i];
      if (
        jointCompatibleRoutes.find(
          (c) =>
            c.contractAddress.toLowerCase() ===
            tokenRoute.token.contractAddress.toLowerCase()
        )
      ) {
        routes.push({
          route: [fromTokenRoutes.token, tokenRoute.token, toTokenRoutes.token],
          liquidityProviderFee: this.LIQUIDITY_PROVIDER_FEE_V2,
        });

        for (let f = 0; f < fromTokenRoutes.pairs.fromTokenPairs!.length; f++) {
          const fromSupportedToken = fromTokenRoutes.pairs.fromTokenPairs![f];
          if (
            tokenRoute.pairs.toTokenPairs!.find(
              (pair) =>
                pair.contractAddress.toLowerCase() ===
                fromSupportedToken.contractAddress.toLowerCase()
            )
          ) {
            const workedOutFromRoute = [
              fromTokenRoutes.token,
              fromSupportedToken,
              tokenRoute.token,
              toTokenRoutes.token,
            ];
            if (
              workedOutFromRoute.filter(onlyUnique).length ===
              workedOutFromRoute.length
            ) {
              routes.push({
                route: workedOutFromRoute,
                liquidityProviderFee: this.LIQUIDITY_PROVIDER_FEE_V2,
              });
            }
          }
        }

        for (let f = 0; f < toTokenRoutes.pairs.toTokenPairs!.length; f++) {
          const toSupportedToken = toTokenRoutes.pairs.toTokenPairs![f];
          if (
            tokenRoute.pairs.fromTokenPairs!.find(
              (pair) =>
                pair.contractAddress.toLowerCase() ===
                toSupportedToken.contractAddress.toLowerCase()
            )
          ) {
            const workedOutToRoute = [
              fromTokenRoutes.token,
              tokenRoute.token,
              toSupportedToken,
              toTokenRoutes.token,
            ];

            if (
              workedOutToRoute.filter(onlyUnique).length ===
              workedOutToRoute.length
            ) {
              routes.push({
                route: workedOutToRoute,
                liquidityProviderFee: this.LIQUIDITY_PROVIDER_FEE_V2,
              });
            }
          }
        }
      }
    }

    return routes;
  }

  private getTokenAvailablePairs(
    token: Token,
    allAvailablePairs: CallReturnContext[],
    direction: RouterDirection
  ) {
    switch (direction) {
      case RouterDirection.from:
        return this.getFromRouterDirectionAvailablePairs(
          token,
          allAvailablePairs
        );
      case RouterDirection.to:
        return this.getToRouterDirectionAvailablePairs(
          token,
          allAvailablePairs
        );
    }
  }

  private getFromRouterDirectionAvailablePairs(
    token: Token,
    allAvailablePairs: CallReturnContext[]
  ): Token[] {
    const fromRouterDirection = allAvailablePairs.filter(
      (c) => c.reference.split('-')[0] === token.contractAddress
    );
    const tokens: Token[] = [];

    for (let index = 0; index < fromRouterDirection.length; index++) {
      const context = fromRouterDirection[index];
      tokens.push(
        this.allTokens.find(
          (t) => t.contractAddress === context.reference.split('-')[1]
        )!
      );
    }

    return tokens;
  }

  private getToRouterDirectionAvailablePairs(
    token: Token,
    allAvailablePairs: CallReturnContext[]
  ): Token[] {
    const toRouterDirection = allAvailablePairs.filter(
      (c) => c.reference.split('-')[1] === token.contractAddress
    );
    const tokens: Token[] = [];

    for (let index = 0; index < toRouterDirection.length; index++) {
      const context = toRouterDirection[index];
      tokens.push(
        this.allTokens.find(
          (t) => t.contractAddress === context.reference.split('-')[0]
        )!
      );
    }

    return tokens;
  }

  /**
   * Build up route quotes from results
   * @param contractCallResults The contract call results
   * @param direction The direction you want to get the quote from
   */
  private buildRouteQuotesFromResults(
    amountToTrade: BigNumber,
    contractCallResults: ContractCallResults,
    direction: TradeDirection
  ): RouteQuote[] {
    const tradePath = this.tradePath();

    const result: RouteQuote[] = [];

    for (const key in contractCallResults.results) {
      const contractCallReturnContext = contractCallResults.results[key];
      if (contractCallReturnContext) {
        for (
          let i = 0;
          i < contractCallReturnContext.callsReturnContext.length;
          i++
        ) {
          const callReturnContext =
            contractCallReturnContext.callsReturnContext[i];

          // console.log(JSON.stringify(callReturnContext, null, 4));

          if (!callReturnContext.success) {
            continue;
          }

          switch (tradePath) {
            case TradePath.ethToErc20:
              result.push(
                this.buildRouteQuoteForEthToErc20(
                  amountToTrade,
                  callReturnContext,
                  contractCallReturnContext.originalContractCallContext.context[
                  i
                  ],
                  direction,
                  contractCallReturnContext.originalContractCallContext
                    .reference as UniswapVersion
                )
              );
              break;
            case TradePath.erc20ToEth:
              result.push(
                this.buildRouteQuoteForErc20ToEth(
                  amountToTrade,
                  callReturnContext,
                  contractCallReturnContext.originalContractCallContext.context[
                  i
                  ],
                  direction,
                  contractCallReturnContext.originalContractCallContext
                    .reference as UniswapVersion
                )
              );
              break;
            case TradePath.erc20ToErc20:
              result.push(
                this.buildRouteQuoteForErc20ToErc20(
                  amountToTrade,
                  callReturnContext,
                  contractCallReturnContext.originalContractCallContext.context[
                  i
                  ],
                  direction,
                  contractCallReturnContext.originalContractCallContext
                    .reference as UniswapVersion
                )
              );
              break;
            default:
              throw new UniswapError(
                `${tradePath} not found`,
                ErrorCodes.tradePathIsNotSupported
              );
          }
        }
      }
    }

    if (direction === TradeDirection.input) {
      return result.sort((a, b) => {
        if (
          new BigNumber(a.expectedConvertQuote).isGreaterThan(
            b.expectedConvertQuote
          )
        ) {
          return -1;
        }
        return new BigNumber(a.expectedConvertQuote).isLessThan(
          b.expectedConvertQuote
        )
          ? 1
          : 0;
      });
    } else {
      return result.sort((a, b) => {
        if (
          new BigNumber(a.expectedConvertQuote).isLessThan(
            b.expectedConvertQuote
          )
        ) {
          return -1;
        }
        return new BigNumber(a.expectedConvertQuote).isGreaterThan(
          b.expectedConvertQuote
        )
          ? 1
          : 0;
      });
    }
  }

  /**
   * Build up the route quote for erc20 > eth (not shared with other method for safety reasons)
   * @param callReturnContext The call return context
   * @param routeContext The route context
   * @param direction The direction you want to get the quote from
   * @param uniswapVersion The uniswap version
   */
  private buildRouteQuoteForErc20ToErc20(
    amountToTrade: BigNumber,
    callReturnContext: CallReturnContext,
    routeContext: RouteContext,
    direction: TradeDirection,
    uniswapVersion: UniswapVersion
  ): RouteQuote {
    const convertQuoteUnformatted = this.getConvertQuoteUnformatted(
      callReturnContext,
      direction,
      uniswapVersion
    );

    const expectedConvertQuote =
      direction === TradeDirection.input
        ? convertQuoteUnformatted
          .shiftedBy(this._toToken.decimals * -1)
          .toFixed(this._toToken.decimals)
        : convertQuoteUnformatted
          .shiftedBy(this._fromToken.decimals * -1)
          .toFixed(this._fromToken.decimals);

    const expectedConvertQuoteOrTokenAmountInMaxWithSlippage =
      this.getExpectedConvertQuoteOrTokenAmountInMaxWithSlippage(
        expectedConvertQuote,
        direction,
        uniswapVersion
      );

    const tradeExpires = this.generateTradeDeadlineUnixTime();

    const routeQuoteTradeContext: RouteQuoteTradeContext = {
      uniswapVersion,
      liquidityProviderFee: routeContext.liquidityProviderFee,
      routePathArray: callReturnContext.methodParameters[1],
    };
    const data =
      direction === TradeDirection.input
        ? this.generateTradeDataErc20ToErc20Input(
          amountToTrade,
          new BigNumber(expectedConvertQuoteOrTokenAmountInMaxWithSlippage),
          routeQuoteTradeContext,
          tradeExpires.toString()
        )
        : this.generateTradeDataErc20ToErc20Output(
          new BigNumber(expectedConvertQuoteOrTokenAmountInMaxWithSlippage),
          amountToTrade,
          routeQuoteTradeContext,
          tradeExpires.toString()
        );

    const transaction = this.buildUpTransactionErc20(uniswapVersion, data);

    switch (uniswapVersion) {
      case UniswapVersion.v2:
        return {
          expectedConvertQuote,
          expectedConvertQuoteOrTokenAmountInMaxWithSlippage,
          transaction,
          tradeExpires,
          routePathArrayTokenMap: callReturnContext.methodParameters[1].map(
            (c: string) => {
              return this.allTokens.find((t) => t.contractAddress === c);
            }
          ),
          routeText: callReturnContext.methodParameters[1]
            .map((c: string) => {
              return this.allTokens.find((t) => t.contractAddress === c)!
                .symbol;
            })
            .join(' > '),
          // route array is always in the 1 index of the method parameters
          routePathArray: callReturnContext.methodParameters[1],
          uniswapVersion,
          liquidityProviderFee: routeContext.liquidityProviderFee,
          quoteDirection: direction,
        };
      case UniswapVersion.v3:
        return {
          expectedConvertQuote,
          expectedConvertQuoteOrTokenAmountInMaxWithSlippage,
          transaction,
          tradeExpires,
          routePathArrayTokenMap: [this._fromToken, this._toToken],
          routeText: `${this._fromToken.symbol} > ${this._toToken.symbol}`,
          routePathArray: [
            this._fromToken.contractAddress,
            this._toToken.contractAddress,
          ],
          uniswapVersion,
          liquidityProviderFee: routeContext.liquidityProviderFee,
          quoteDirection: direction,
        };
      default:
        throw new UniswapError('Invalid uniswap version', uniswapVersion);
    }
  }

  /**
   * Build up the route quote for eth > erc20 (not shared with other method for safety reasons)
   * @param callReturnContext The call return context
   * @param routeContext The route context
   * @param direction The direction you want to get the quote from
   * @param uniswapVersion The uniswap version
   */
  private buildRouteQuoteForEthToErc20(
    amountToTrade: BigNumber,
    callReturnContext: CallReturnContext,
    routeContext: RouteContext,
    direction: TradeDirection,
    uniswapVersion: UniswapVersion
  ): RouteQuote {
    const convertQuoteUnformatted = this.getConvertQuoteUnformatted(
      callReturnContext,
      direction,
      uniswapVersion
    );

    const expectedConvertQuote =
      direction === TradeDirection.input
        ? convertQuoteUnformatted
          .shiftedBy(this._toToken.decimals * -1)
          .toFixed(this._toToken.decimals)
        : new BigNumber(formatEther(convertQuoteUnformatted)).toFixed(
          this._fromToken.decimals
        );

    const expectedConvertQuoteOrTokenAmountInMaxWithSlippage =
      this.getExpectedConvertQuoteOrTokenAmountInMaxWithSlippage(
        expectedConvertQuote,
        direction,
        uniswapVersion
      );

    const tradeExpires = this.generateTradeDeadlineUnixTime();
    const routeQuoteTradeContext: RouteQuoteTradeContext = {
      uniswapVersion,
      liquidityProviderFee: routeContext.liquidityProviderFee,
      routePathArray: callReturnContext.methodParameters[1],
    };
    const data =
      direction === TradeDirection.input
        ? this.generateTradeDataEthToErc20Input(
          amountToTrade,
          new BigNumber(expectedConvertQuoteOrTokenAmountInMaxWithSlippage),
          routeQuoteTradeContext,
          tradeExpires.toString()
        )
        : this.generateTradeDataEthToErc20Output(
          new BigNumber(expectedConvertQuoteOrTokenAmountInMaxWithSlippage),
          amountToTrade,
          routeQuoteTradeContext,
          tradeExpires.toString()
        );

    const transaction = this.buildUpTransactionEth(
      uniswapVersion,
      direction === TradeDirection.input
        ? amountToTrade
        : new BigNumber(expectedConvertQuote),
      data
    );

    switch (uniswapVersion) {
      case UniswapVersion.v2:
        return {
          expectedConvertQuote,
          expectedConvertQuoteOrTokenAmountInMaxWithSlippage,
          transaction,
          tradeExpires,
          routePathArrayTokenMap: callReturnContext.methodParameters[1].map(
            (c: string, index: number) => {
              const token = deepClone(
                this.allTokens.find((t) => t.contractAddress === c)!
              );
              if (index === 0) {
                return turnTokenIntoEthForResponse(
                  token,
                  this._settings?.customNetwork?.nativeCurrency
                );
              }

              return token;
            }
          ),
          routeText: callReturnContext.methodParameters[1]
            .map((c: string, index: number) => {
              if (index === 0) {
                return this.getNativeTokenSymbol();
              }
              return this.allTokens.find((t) => t.contractAddress === c)!
                .symbol;
            })
            .join(' > '),
          // route array is always in the 1 index of the method parameters
          routePathArray: callReturnContext.methodParameters[1],
          uniswapVersion,
          liquidityProviderFee: routeContext.liquidityProviderFee,
          quoteDirection: direction,
        };
      case UniswapVersion.v3:
        return {
          expectedConvertQuote,
          expectedConvertQuoteOrTokenAmountInMaxWithSlippage,
          transaction,
          tradeExpires,
          routePathArrayTokenMap: [
            turnTokenIntoEthForResponse(
              this._fromToken,
              this._settings?.customNetwork?.nativeCurrency
            ),
            this._toToken,
          ],
          routeText: `${turnTokenIntoEthForResponse(
            this._fromToken,
            this._settings?.customNetwork?.nativeCurrency
          ).symbol
            } > ${this._toToken.symbol}`,
          routePathArray: [
            this._fromToken.contractAddress,
            this._toToken.contractAddress,
          ],
          uniswapVersion,
          liquidityProviderFee: routeContext.liquidityProviderFee,
          quoteDirection: direction,
        };
      default:
        throw new UniswapError('Invalid uniswap version', uniswapVersion);
    }
  }

  /**
   * Build up the route quote for erc20 > eth (not shared with other method for safety reasons)
   * @param callReturnContext The call return context
   * @param routeContext The route context
   * @param direction The direction you want to get the quote from
   * @param uniswapVersion The uniswap version
   */
  private buildRouteQuoteForErc20ToEth(
    amountToTrade: BigNumber,
    callReturnContext: CallReturnContext,
    routeContext: RouteContext,
    direction: TradeDirection,
    uniswapVersion: UniswapVersion
  ): RouteQuote {
    const convertQuoteUnformatted = this.getConvertQuoteUnformatted(
      callReturnContext,
      direction,
      uniswapVersion
    );

    const expectedConvertQuote =
      direction === TradeDirection.input
        ? new BigNumber(formatEther(convertQuoteUnformatted)).toFixed(
          this._toToken.decimals
        )
        : convertQuoteUnformatted
          .shiftedBy(this._fromToken.decimals * -1)
          .toFixed(this._fromToken.decimals);

    const expectedConvertQuoteOrTokenAmountInMaxWithSlippage =
      this.getExpectedConvertQuoteOrTokenAmountInMaxWithSlippage(
        expectedConvertQuote,
        direction,
        uniswapVersion
      );

    const tradeExpires = this.generateTradeDeadlineUnixTime();
    const routeQuoteTradeContext: RouteQuoteTradeContext = {
      uniswapVersion,
      liquidityProviderFee: routeContext.liquidityProviderFee,
      routePathArray: callReturnContext.methodParameters[1],
    };
    const data =
      direction === TradeDirection.input
        ? this.generateTradeDataErc20ToEthInput(
          amountToTrade,
          new BigNumber(expectedConvertQuoteOrTokenAmountInMaxWithSlippage),
          routeQuoteTradeContext,
          tradeExpires.toString()
        )
        : this.generateTradeDataErc20ToEthOutput(
          new BigNumber(expectedConvertQuoteOrTokenAmountInMaxWithSlippage),
          amountToTrade,
          routeQuoteTradeContext,
          tradeExpires.toString()
        );

    const transaction = this.buildUpTransactionErc20(uniswapVersion, data);

    switch (uniswapVersion) {
      case UniswapVersion.v2:
        return {
          expectedConvertQuote,
          expectedConvertQuoteOrTokenAmountInMaxWithSlippage,
          transaction,
          tradeExpires,
          routePathArrayTokenMap: callReturnContext.methodParameters[1].map(
            (c: string, index: number) => {
              const token = deepClone(
                this.allTokens.find((t) => t.contractAddress === c)!
              );
              if (index === callReturnContext.methodParameters[1].length - 1) {
                return turnTokenIntoEthForResponse(
                  token,
                  this._settings?.customNetwork?.nativeCurrency
                );
              }

              return token;
            }
          ),
          routeText: callReturnContext.methodParameters[1]
            .map((c: string, index: number) => {
              if (index === callReturnContext.methodParameters[1].length - 1) {
                return this.getNativeTokenSymbol();
              }
              return this.allTokens.find((t) => t.contractAddress === c)!
                .symbol;
            })
            .join(' > '),
          // route array is always in the 1 index of the method parameters
          routePathArray: callReturnContext.methodParameters[1],
          uniswapVersion,
          liquidityProviderFee: routeContext.liquidityProviderFee,
          quoteDirection: direction,
        };
      case UniswapVersion.v3:
        return {
          expectedConvertQuote,
          expectedConvertQuoteOrTokenAmountInMaxWithSlippage,
          transaction,
          tradeExpires,
          routePathArrayTokenMap: [
            this._fromToken,
            turnTokenIntoEthForResponse(
              this._toToken,
              this._settings?.customNetwork?.nativeCurrency
            ),
          ],
          routeText: `${this._fromToken.symbol} > ${turnTokenIntoEthForResponse(
            this._toToken,
            this._settings?.customNetwork?.nativeCurrency
          ).symbol
            }`,
          routePathArray: [
            this._fromToken.contractAddress,
            this._toToken.contractAddress,
          ],
          uniswapVersion,
          liquidityProviderFee: routeContext.liquidityProviderFee,
          quoteDirection: direction,
        };
      default:
        throw new UniswapError('Invalid uniswap version', uniswapVersion);
    }
  }

  /**
   * Get the convert quote unformatted from the call return context
   * @param callReturnContext The call return context
   * @param direction The direction you want to get the quote from
   * @param uniswapVersion The uniswap version
   */
  private getConvertQuoteUnformatted(
    callReturnContext: CallReturnContext,
    direction: TradeDirection,
    uniswapVersion: UniswapVersion
  ): BigNumber {
    switch (uniswapVersion) {
      case UniswapVersion.v2:
        if (direction === TradeDirection.input) {
          return new BigNumber(
            callReturnContext.returnValues[
              callReturnContext.returnValues.length - 1
            ].hex
          );
        } else {
          return new BigNumber(callReturnContext.returnValues[0].hex);
        }
      case UniswapVersion.v3:
        return new BigNumber(callReturnContext.returnValues[0].hex);
      default:
        throw new UniswapError('Invalid uniswap version', uniswapVersion);
    }
  }

  /**
   * Work out the expected convert quote taking off slippage
   * @param expectedConvertQuote The expected convert quote
   */
  private getExpectedConvertQuoteOrTokenAmountInMaxWithSlippage(
    expectedConvertQuote: string,
    tradeDirection: TradeDirection,
    uniswapVersion: UniswapVersion
  ): string {
    const decimals =
      tradeDirection === TradeDirection.input
        ? this._toToken.decimals
        : this._fromToken.decimals;

    if (
      tradeDirection === TradeDirection.output &&
      (uniswapVersion === UniswapVersion.v3 || UniswapVersion.v2)
    ) {
      return new BigNumber(expectedConvertQuote)
        .plus(
          new BigNumber(expectedConvertQuote)
            .times(this._settings.slippage)
            .toFixed(decimals)
        )
        .toFixed(decimals);
    }

    return new BigNumber(expectedConvertQuote)
      .minus(
        new BigNumber(expectedConvertQuote)
          .times(this._settings.slippage)
          .toFixed(decimals)
      )
      .toFixed(decimals);
  }

  /**
   * Format amount to trade into callable formats
   * @param amountToTrade The amount to trade
   * @param direction The direction you want to get the quote from
   */
  private formatAmountToTrade(
    amountToTrade: BigNumber,
    direction: TradeDirection
  ): string {
    switch (this.tradePath()) {
      case TradePath.ethToErc20:
        if (direction == TradeDirection.input) {
          const amountToTradeWei = parseEther(amountToTrade);
          return hexlify(amountToTradeWei);
        } else {
          return hexlify(amountToTrade.shiftedBy(this._toToken.decimals));
        }
      case TradePath.erc20ToEth:
        if (direction == TradeDirection.input) {
          return hexlify(amountToTrade.shiftedBy(this._fromToken.decimals));
        } else {
          const amountToTradeWei = parseEther(amountToTrade);
          return hexlify(amountToTradeWei);
        }
      case TradePath.erc20ToErc20:
        if (direction == TradeDirection.input) {
          return hexlify(amountToTrade.shiftedBy(this._fromToken.decimals));
        } else {
          return hexlify(amountToTrade.shiftedBy(this._toToken.decimals));
        }
      default:
        throw new UniswapError(
          `Internal trade path ${this.tradePath()} is not supported`,
          ErrorCodes.tradePathIsNotSupported
        );
    }
  }

  /**
 * Format convertQuoteToTrade into callable formats
 * @param convertQuoteToTrade The amount to trade
 * @param direction The direction you want to get the quote from
 */
  private formatConvertQuoteToTrade(
    convertQuoteToTrade: BigNumber,
    direction: TradeDirection
  ): string {
    switch (this.tradePath()) {
      case TradePath.ethToErc20:
        if (direction == TradeDirection.output) {
          const amountToTradeWei = parseEther(convertQuoteToTrade);
          return hexlify(amountToTradeWei);
        } else {
          return hexlify(convertQuoteToTrade.shiftedBy(this._toToken.decimals));
        }
      case TradePath.erc20ToEth:
        if (direction == TradeDirection.output) {
          return hexlify(convertQuoteToTrade.shiftedBy(this._fromToken.decimals));
        } else {
          const amountToTradeWei = parseEther(convertQuoteToTrade);
          return hexlify(amountToTradeWei);
        }
      case TradePath.erc20ToErc20:
        if (direction == TradeDirection.output) {
          return hexlify(convertQuoteToTrade.shiftedBy(this._fromToken.decimals));
        } else {
          return hexlify(convertQuoteToTrade.shiftedBy(this._toToken.decimals));
        }
      default:
        throw new UniswapError(
          `Internal trade path ${this.tradePath()} is not supported`,
          ErrorCodes.tradePathIsNotSupported
        );
    }
  }

  /**
 * Format amount to readable format
 * @param convertQuote The amount to trade
 * @param direction The direction you want to get the quote from
 */
  private formatConvertQuoteToEtherBigNumber(
    convertQuote: BigNumber,
    direction: TradeDirection
  ): BigNumber {
    switch (this.tradePath()) {
      case TradePath.ethToErc20:
        if (direction == TradeDirection.output) {
          const convertQuoteWei = formatEther(convertQuote);
          return convertQuoteWei;
        } else {
          return convertQuote.shiftedBy(this._toToken.decimals * -1);
        }
      case TradePath.erc20ToEth:
        if (direction == TradeDirection.output) {
          return convertQuote.shiftedBy(this._fromToken.decimals * -1);
        } else {
          const convertQuoteWei = formatEther(convertQuote);
          return convertQuoteWei;
        }
      case TradePath.erc20ToErc20:
        if (direction == TradeDirection.output) {
          return convertQuote.shiftedBy(this._fromToken.decimals * -1);
        } else {
          return convertQuote.shiftedBy(this._toToken.decimals * -1);
        }
      default:
        throw new UniswapError(
          `Internal trade path ${this.tradePath()} is not supported`,
          ErrorCodes.tradePathIsNotSupported
        );
    }
  }

  /**
   * Get the trade path
   */
  private tradePath(): TradePath {
    const network = this._ethersProvider.network();
    return getTradePath(
      network.chainId,
      this._fromToken,
      this._toToken,
      this._settings.customNetwork?.nativeWrappedTokenInfo
    );
  }

  private get allTokens(): Token[] {
    return [this._fromToken, this._toToken, ...this.allMainTokens];
  }

  private get allMainTokens(): Token[] {
    if (
      this._ethersProvider.provider.network.chainId === ChainId.MAINNET ||
      this._settings.customNetwork
    ) {
      const tokens: (Token | undefined)[] = [
        this.USDTTokenForConnectedNetwork,
        this.COMPTokenForConnectedNetwork,
        this.USDCTokenForConnectedNetwork,
        this.DAITokenForConnectedNetwork,
        this.WETHTokenForConnectedNetwork,
        this.WBTCTokenForConnectedNetwork,
      ];

      return tokens.filter((t) => t !== undefined) as Token[];
    }

    return [this.WETHTokenForConnectedNetwork];
  }

  private get mainCurrenciesPairsForFromToken(): Token[][] {
    if (
      this._ethersProvider.provider.network.chainId === ChainId.MAINNET ||
      this._settings.customNetwork
    ) {
      const pairs = [
        [this._fromToken, this.USDTTokenForConnectedNetwork],
        [this._fromToken, this.COMPTokenForConnectedNetwork],
        [this._fromToken, this.USDCTokenForConnectedNetwork],
        [this._fromToken, this.DAITokenForConnectedNetwork],
        [this._fromToken, this.WBTCTokenForConnectedNetwork],
      ];

      if (
        !isNativeEth(this._fromToken.contractAddress) &&
        !isNativeEth(this._toToken.contractAddress)
      ) {
        pairs.push([this._fromToken, this.WETHTokenForConnectedNetwork]);
      }

      return this.filterUndefinedTokens(pairs).filter(
        (t) => t[0].contractAddress !== t[1].contractAddress
      );
    }

    const pairs = [[this._fromToken, this.WETHTokenForConnectedNetwork]];
    return pairs.filter((t) => t[0].contractAddress !== t[1].contractAddress);
  }

  private get mainCurrenciesPairsForToToken(): Token[][] {
    if (
      this._ethersProvider.provider.network.chainId === ChainId.MAINNET ||
      this._settings.customNetwork
    ) {
      const pairs: (Token | undefined)[][] = [
        [this.USDTTokenForConnectedNetwork, this._toToken],
        [this.COMPTokenForConnectedNetwork, this._toToken],
        [this.USDCTokenForConnectedNetwork, this._toToken],
        [this.DAITokenForConnectedNetwork, this._toToken],
        [this.WBTCTokenForConnectedNetwork, this._toToken],
      ];

      if (
        !isNativeEth(this._toToken.contractAddress) &&
        !isNativeEth(this._toToken.contractAddress)
      ) {
        pairs.push([this.WETHTokenForConnectedNetwork, this._toToken]);
      }

      return this.filterUndefinedTokens(pairs).filter(
        (t) => t[0].contractAddress !== t[1].contractAddress
      );
    }

    const pairs: Token[][] = [
      [this.WETHTokenForConnectedNetwork, this._toToken],
    ];

    return pairs.filter((t) => t[0].contractAddress !== t[1].contractAddress);
  }

  private get mainCurrenciesPairsForUSDT(): Token[][] {
    if (
      this._ethersProvider.provider.network.chainId === ChainId.MAINNET ||
      this._settings.customNetwork
    ) {
      const pairs: (Token | undefined)[][] = [
        [this.USDTTokenForConnectedNetwork, this.COMPTokenForConnectedNetwork],
        [this.USDTTokenForConnectedNetwork, this.DAITokenForConnectedNetwork],
        [this.USDTTokenForConnectedNetwork, this.USDCTokenForConnectedNetwork],
        [this.USDTTokenForConnectedNetwork, this.WBTCTokenForConnectedNetwork],
      ];

      if (
        !isNativeEth(this._fromToken.contractAddress) &&
        !isNativeEth(this._toToken.contractAddress)
      ) {
        pairs.push([
          this.USDTTokenForConnectedNetwork,
          this.WETHTokenForConnectedNetwork,
        ]);
      }

      return this.filterUndefinedTokens(pairs);
    }

    return [];
  }

  private get mainCurrenciesPairsForCOMP(): Token[][] {
    if (
      this._ethersProvider.provider.network.chainId === ChainId.MAINNET ||
      this._settings.customNetwork
    ) {
      const pairs: (Token | undefined)[][] = [
        [this.COMPTokenForConnectedNetwork, this.USDTTokenForConnectedNetwork],
        [this.COMPTokenForConnectedNetwork, this.DAITokenForConnectedNetwork],
        [this.COMPTokenForConnectedNetwork, this.USDCTokenForConnectedNetwork],
      ];

      if (
        !isNativeEth(this._fromToken.contractAddress) &&
        !isNativeEth(this._toToken.contractAddress)
      ) {
        pairs.push([
          this.COMPTokenForConnectedNetwork,
          this.WETHTokenForConnectedNetwork,
        ]);
      }

      return this.filterUndefinedTokens(pairs);
    }

    return [];
  }

  private get mainCurrenciesPairsForDAI(): Token[][] {
    if (
      this._ethersProvider.provider.network.chainId === ChainId.MAINNET ||
      this._settings.customNetwork
    ) {
      const pairs: (Token | undefined)[][] = [
        [this.DAITokenForConnectedNetwork, this.COMPTokenForConnectedNetwork],
        [this.DAITokenForConnectedNetwork, this.WBTCTokenForConnectedNetwork],
        [this.DAITokenForConnectedNetwork, this.USDTTokenForConnectedNetwork],
        [this.DAITokenForConnectedNetwork, this.USDCTokenForConnectedNetwork],
      ];

      if (
        !isNativeEth(this._fromToken.contractAddress) &&
        !isNativeEth(this._toToken.contractAddress)
      ) {
        pairs.push([
          this.DAITokenForConnectedNetwork,
          this.WETHTokenForConnectedNetwork,
        ]);
      }

      return this.filterUndefinedTokens(pairs);
    }

    return [];
  }

  private get mainCurrenciesPairsForUSDC(): Token[][] {
    if (
      this._ethersProvider.provider.network.chainId === ChainId.MAINNET ||
      this._settings.customNetwork
    ) {
      const pairs: (Token | undefined)[][] = [
        [this.USDCTokenForConnectedNetwork, this.USDTTokenForConnectedNetwork],
        [this.USDCTokenForConnectedNetwork, this.COMPTokenForConnectedNetwork],
        [this.USDCTokenForConnectedNetwork, this.DAITokenForConnectedNetwork],
        [this.USDCTokenForConnectedNetwork, this.WBTCTokenForConnectedNetwork],
      ];

      if (
        !isNativeEth(this._fromToken.contractAddress) &&
        !isNativeEth(this._toToken.contractAddress)
      ) {
        pairs.push([
          this.USDCTokenForConnectedNetwork,
          this.WETHTokenForConnectedNetwork,
        ]);
      }

      return this.filterUndefinedTokens(pairs);
    }

    return [];
  }

  private get mainCurrenciesPairsForWBTC(): Token[][] {
    if (
      this._ethersProvider.provider.network.chainId === ChainId.MAINNET ||
      this._settings.customNetwork
    ) {
      const tokens: (Token | undefined)[][] = [
        [this.WBTCTokenForConnectedNetwork, this.USDTTokenForConnectedNetwork],
        [this.WBTCTokenForConnectedNetwork, this.DAITokenForConnectedNetwork],
        [this.WBTCTokenForConnectedNetwork, this.USDCTokenForConnectedNetwork],
        [this.WBTCTokenForConnectedNetwork, this.WETHTokenForConnectedNetwork],
      ];

      return this.filterUndefinedTokens(tokens);
    }

    return [];
  }

  private get mainCurrenciesPairsForWETH(): Token[][] {
    if (
      this._ethersProvider.provider.network.chainId === ChainId.MAINNET ||
      this._settings.customNetwork
    ) {
      const tokens: (Token | undefined)[][] = [
        [this.WETHTokenForConnectedNetwork, this.USDTTokenForConnectedNetwork],
        [this.WETHTokenForConnectedNetwork, this.COMPTokenForConnectedNetwork],
        [this.WETHTokenForConnectedNetwork, this.DAITokenForConnectedNetwork],
        [this.WETHTokenForConnectedNetwork, this.USDCTokenForConnectedNetwork],
        [this.WETHTokenForConnectedNetwork, this.WBTCTokenForConnectedNetwork],
      ];

      return this.filterUndefinedTokens(tokens);
    }

    return [];
  }

  private filterUndefinedTokens(tokens: (Token | undefined)[][]): Token[][] {
    return tokens.filter(
      (t) => t[0] !== undefined && t[1] !== undefined
    ) as Token[][];
  }

  private get USDTTokenForConnectedNetwork() {
    if (this._settings.customNetwork) {
      return this._settings.customNetwork.baseTokens?.usdt;
    }

    return USDT.token(this._ethersProvider.provider.network.chainId);
  }

  private get COMPTokenForConnectedNetwork() {
    if (this._settings.customNetwork) {
      return this._settings.customNetwork.baseTokens?.comp;
    }

    return COMP.token(this._ethersProvider.provider.network.chainId);
  }

  private get DAITokenForConnectedNetwork() {
    if (this._settings.customNetwork) {
      return this._settings.customNetwork.baseTokens?.dai;
    }

    return DAI.token(this._ethersProvider.provider.network.chainId);
  }

  private get USDCTokenForConnectedNetwork() {
    if (this._settings.customNetwork) {
      return this._settings.customNetwork.baseTokens?.usdc;
    }

    return USDC.token(this._ethersProvider.provider.network.chainId);
  }

  private get WETHTokenForConnectedNetwork() {
    if (this._settings.customNetwork) {
      return this._settings.customNetwork.nativeWrappedTokenInfo;
    }

    return WETHContract.token(this._ethersProvider.provider.network.chainId);
  }

  private get WBTCTokenForConnectedNetwork() {
    if (this._settings.customNetwork) {
      return this._settings.customNetwork.baseTokens?.wbtc;
    }

    return WBTC.token(this._ethersProvider.provider.network.chainId);
  }

  private getNativeTokenSymbol(): string {
    if (this._settings.customNetwork) {
      return this._settings.customNetwork.nativeCurrency.symbol;
    }

    return ETH_SYMBOL;
  }
}
