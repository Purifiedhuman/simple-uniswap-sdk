import { CoinGecko } from '../../../coin-gecko';
import { ErrorCodes } from '../../../common/errors/error-codes';
import { UniswapError } from '../../../common/errors/uniswap-error';
import { getAddress } from '../../../common/utils/get-address';
import { isAddress } from '../../../common/utils/is-address';
import { ChainId } from '../../../enums/chain-id';
import { EthersProvider } from '../../../ethers-provider';
import {
  UniswapMyPairContextBaseForEthereumProvider, UniswapMyPairContextV2ForChainId, UniswapMyPairContextV2ForProviderUrl
} from '../models/uniswap-my-pair-context';
import { UniswapMyPairFactoryContext } from '../models/uniswap-my-pair-factory-context';
import { UniswapPairSettings } from '../../pair/models/uniswap-pair-settings';
import { UniswapMyLiquidity } from '../uniswap-my-liquidity/uniswap-my-liquidity';

export class UniswapMyLiquidityFactory {
  private _ethersProvider: EthersProvider;

  constructor(
    private _uniswapPairContext:
      | UniswapMyPairContextV2ForChainId
      | UniswapMyPairContextBaseForEthereumProvider
      | UniswapMyPairContextV2ForProviderUrl
  ) {
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

    const chainId = (<UniswapMyPairContextV2ForChainId>this._uniswapPairContext)
      .chainId;

    const providerUrl = (<UniswapMyPairContextV2ForProviderUrl>(
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

    const ethereumProvider = (<UniswapMyPairContextBaseForEthereumProvider>(
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
      'Your must supply a chainId or a ethereum provider please look at types `UniswapMyPairContextBaseForEthereumProvider`, `UniswapMyPairContextV2ForChainId` and `UniswapMyPairContextV2ForProviderUrl` to make sure your object is correct in what your passing in',
      ErrorCodes.invalidPairContext
    );
  }

  /**
   * Create factory to be able to call add liquidity methods on the 2 tokens
   */
  public async createMyLiquidityFactory(): Promise<UniswapMyLiquidity> {
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
    const uniswapFactoryContext: UniswapMyPairFactoryContext = {
      ethereumAddress: this._uniswapPairContext.ethereumAddress,
      settings: this._uniswapPairContext.settings || new UniswapPairSettings(),
      ethersProvider: this._ethersProvider,
    };

    return new UniswapMyLiquidity(new CoinGecko(), uniswapFactoryContext);
  }
}
