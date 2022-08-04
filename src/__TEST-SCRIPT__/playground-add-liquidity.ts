import { UniswapVersion } from '../enums/uniswap-version';
import { UniswapPairSettings } from '../factories/pair/models/uniswap-pair-settings';
import { UniswapAddRmLiquidityFactory } from '../factories/main-logics/uniswap-add-remove-liquidity/uniswap-add-rm-liquidity.factory';

const routeTest = async () => {
  const ethereumAddress = '0xa207aDd901BF900C81Feb04D33968a0132bD68DA';

  const uniswapMain = new UniswapAddRmLiquidityFactory({
    tokenATokenContractAddress: '0x8a1aaE68BA6DDbfaDe8359f18321e87d8ab8Fae9',
    tokenBTokenContractAddress: '0xC285cc080a40aE0Fb4Ae198b2FB5cbdb4A7F3E66',
    ethereumAddress,
    chainId: 80001,
    providerUrl: 'https://polygon-mumbai.g.alchemy.com/v2/LOsCmKKqyJojD5OsLyqlAFVquaysK2Wb',
    settings: new UniswapPairSettings({
      slippage: 0.005,
      deadlineMinutes: 20,
      disableMultihops: false,
      uniswapVersions: [UniswapVersion.v2],
      cloneUniswapContractDetails: {
        v2Override: {
          routerAddress: "0x4ab7fFf214b76bcE1102A71271f44975B1F99e05",
          factoryAddress: "0xCfbE9a0B5224BC0384D5336E76c77734EABbb6ED",
          pairAddress: "0xCfbE9a0B5224BC0384D5336E76c77734EABbb6ED",
        },
      },
      customNetwork: {
        nameNetwork: "Mumbai Testnet",
        multicallContractAddress: "0xe9939e7Ea7D7fb619Ac57f648Da7B1D425832631", //https://github.com/joshstevens19/ethereum-multicall#readme
        nativeCurrency: {
          name: "Matic Coin",
          symbol: "MATIC",
        },
        nativeWrappedTokenInfo: {
          chainId: 80001,
          contractAddress: "0x451002da4394e8ff717Ff6Dc4F48BFfA6139A858",
          decimals: 18,
          name: "Matic Coin",
          symbol: "MATIC",
        },
      },
    }),
  });

  const uniswapLiquidityFactory = await uniswapMain.createAddLiquidityRatioBasedFactory();

  const addLiquidityTradeInfo = await uniswapLiquidityFactory.getAddLiquidityTradeInfo();

  console.log(addLiquidityTradeInfo);

  // uniswapLiquidityFactory?.quoteChanged$.subscribe(
  //   (quote) => {
  //     console.log("new quote desuyo", quote);
  //   }
  // );

  // const approvalTransaction = await uniswapLiquidityFactory.buildApproveAllowanceTransaction(
  //   UniswapVersion.v2, true
  // )

  // console.log(approvalTransaction);

  // const transaction = await uniswapLiquidityFactory.buildTransaction(
  //   new BigNumber('1'), new BigNumber('100')
  // )

  // console.log(transaction);

};

routeTest();
