import { CoinGecko } from '../../../coin-gecko';
import { ErrorCodes } from '../../../common/errors/error-codes';
import { UniswapError } from '../../../common/errors/uniswap-error';
import { getAddress } from '../../../common/utils/get-address';
import { isAddress } from '../../../common/utils/is-address';
import { ChainId } from '../../../enums/chain-id';
import { EthersProvider } from '../../../ethers-provider';
import { UniswapAddRmPairFactoryContexts } from '../models/uniswap-add-rm-pair-factory-context';
import { UniswapPairSettings } from '../../pair/models/uniswap-pair-settings';
import { TokensFactory } from '../../token/tokens.factory';
import {
  UniswapAddRmPairContextBaseForEthereumProvider, UniswapAddRmPairContextV2ForChainId, UniswapAddRmPairContextV2ForProviderUrl
} from '../models/uniswap-add-rm-pair-context';
import { UniswapAddLiquidity } from './uniswap-add-liquidity';

export class UniswapAddRmLiquidityFactory {
  private _ethersProvider: EthersProvider;

  constructor(
    private _uniswapPairContext:
      | UniswapAddRmPairContextV2ForChainId
      | UniswapAddRmPairContextBaseForEthereumProvider
      | UniswapAddRmPairContextV2ForProviderUrl
  ) {
    if (!this._uniswapPairContext.tokenATokenContractAddress) {
      throw new UniswapError(
        'Must have a `tokenATokenContractAddress` on the context',
        ErrorCodes.fromTokenContractAddressRequired
      );
    }

    if (!isAddress(this._uniswapPairContext.tokenATokenContractAddress)) {
      throw new UniswapError(
        '`tokenATokenContractAddress` is not a valid contract address',
        ErrorCodes.fromTokenContractAddressNotValid
      );
    }

    this._uniswapPairContext.tokenATokenContractAddress = getAddress(
      this._uniswapPairContext.tokenATokenContractAddress,
      true
    );

    if (!this._uniswapPairContext.tokenBTokenContractAddress) {
      throw new UniswapError(
        'Must have a `tokenBTokenContractAddress` on the context',
        ErrorCodes.toTokenContractAddressRequired
      );
    }

    if (!isAddress(this._uniswapPairContext.tokenBTokenContractAddress)) {
      throw new UniswapError(
        '`tokenBTokenContractAddress` is not a valid contract address',
        ErrorCodes.toTokenContractAddressNotValid
      );
    }

    this._uniswapPairContext.tokenBTokenContractAddress = getAddress(
      this._uniswapPairContext.tokenBTokenContractAddress,
      true
    );

    if (!this._uniswapPairContext.ethereumAddress) {
      throw new UniswapError(
        'Must have a `ethereumAddress` on the context',
        ErrorCodes.ethereumAddressRequired
      );
    }

    if (!isAddress(this._uniswapPairContext.ethereumAddress)) {
      throw new UniswapError(
        '`ethereumAddress` is not a valid address',
        ErrorCodes.ethereumAddressNotValid
      );
    }

    this._uniswapPairContext.ethereumAddress = getAddress(
      this._uniswapPairContext.ethereumAddress
    );

    const chainId = (<UniswapAddRmPairContextV2ForChainId>this._uniswapPairContext)
      .chainId;

    const providerUrl = (<UniswapAddRmPairContextV2ForProviderUrl>(
      this._uniswapPairContext
    )).providerUrl;

    if (providerUrl && chainId) {
      this._ethersProvider = new EthersProvider({
        chainId,
        providerUrl,
        customNetwork: this._uniswapPairContext.settings?.customNetwork,
      });
      return;
    }

    if (chainId) {
      this._ethersProvider = new EthersProvider({ chainId });
      return;
    }

    const ethereumProvider = (<UniswapAddRmPairContextBaseForEthereumProvider>(
      this._uniswapPairContext
    )).ethereumProvider;

    if (ethereumProvider) {
      this._ethersProvider = new EthersProvider({
        ethereumProvider,
        customNetwork: this._uniswapPairContext.settings?.customNetwork,
      });
      return;
    }

    throw new UniswapError(
      'Your must supply a chainId or a ethereum provider please look at types `UniswapAddRmPairContextBaseForEthereumProvider`, `UniswapAddRmPairContextV2ForChainId` and `UniswapAddRmPairContextV2ForProviderUrl` to make sure your object is correct in what your passing in',
      ErrorCodes.invalidPairContext
    );
  }

  /**
   * Create factory to be able to call add liquidity methods on the 2 tokens
   */
  public async createAddLiquidityFactory(): Promise<UniswapAddLiquidity> {
    if (this._uniswapPairContext.settings?.customNetwork === undefined) {
      const chainId = this._ethersProvider.network().chainId;
      if (
        chainId !== ChainId.MAINNET &&
        chainId !== ChainId.ROPSTEN &&
        chainId !== ChainId.RINKEBY &&
        chainId !== ChainId.GÖRLI &&
        chainId !== ChainId.KOVAN
      ) {
        throw new UniswapError(
          `ChainId - ${chainId} is not supported. This lib only supports mainnet(1), ropsten(4), kovan(42), rinkeby(4), and görli(5)`,
          ErrorCodes.chainIdNotSupported
        );
      }
    }

    const tokensFactory = new TokensFactory(
      this._ethersProvider,
      this._uniswapPairContext.settings?.customNetwork
    );
    const tokens = await tokensFactory.getTokens([
      this._uniswapPairContext.tokenATokenContractAddress,
      this._uniswapPairContext.tokenBTokenContractAddress,
    ]);

    const uniswapFactoryContext: UniswapAddRmPairFactoryContexts = {
      tokenA: tokens.find(
        (t) =>
          t.contractAddress.toLowerCase() ===
          this._uniswapPairContext.tokenATokenContractAddress.toLowerCase()
      )!,
      tokenB: tokens.find(
        (t) =>
          t.contractAddress.toLowerCase() ===
          this._uniswapPairContext.tokenBTokenContractAddress.toLowerCase()
      )!,
      ethereumAddress: this._uniswapPairContext.ethereumAddress,
      settings: this._uniswapPairContext.settings || new UniswapPairSettings(),
      ethersProvider: this._ethersProvider,
    };

    return new UniswapAddLiquidity(new CoinGecko(), uniswapFactoryContext);
  }
}
