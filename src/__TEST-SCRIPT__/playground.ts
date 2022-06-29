import { UniswapVersion } from '../enums/uniswap-version';
import { TradeDirection } from '../factories/pair/models/trade-direction';
import { UniswapPairSettings } from '../factories/pair/models/uniswap-pair-settings';
import { UniswapMain } from '../factories/pair/uniswap-main';

// WBTC - 0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599
// FUN - 0x419D0d8BdD9aF5e606Ae2232ed285Aff190E711b
// REP - 0x1985365e9f78359a9B6AD760e32412f4a445E862
// WETH - 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
// UNI - 0x1f9840a85d5af5bf1d1762f925bdaddc4201f984
// AAVE - 0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9
// GTC - 0xde30da39c46104798bb5aa3fe8b9e0e1f348163f

const routeTest = async () => {
  
  const fromTokenContractAddress = '0xC285cc080a40aE0Fb4Ae198b2FB5cbdb4A7F3E66'; //0x8a1aaE68BA6DDbfaDe8359f18321e87d8ab8Fae9
  const toTokenContractAddress = '0xa6673B7c3B6A30DA1B67e62dD4A0319bFE755Edb'; //0xC285cc080a40aE0Fb4Ae198b2FB5cbdb4A7F3E66
  const ethereumAddress = '0xFBE0f89Aa021d7FE6329F81CA89dBCe860B4B268';

  const uniswapMain = new UniswapMain({
    fromTokenContractAddress,
    toTokenContractAddress,
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

  // const startTime = new Date().getTime();

  const uniswapLiquidityFactory = await uniswapMain.createLiquidityFactory();

  const trade = await uniswapLiquidityFactory.trade('34', TradeDirection.input, '10');
  
  console.log('End', trade);
};

routeTest();
