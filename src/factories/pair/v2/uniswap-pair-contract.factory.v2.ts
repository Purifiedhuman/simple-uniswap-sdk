import { ContractContext as PairContractContext, GetReservesResponse } from '../../../ABI/types/uniswap-pair-v2';
import { EthersProvider } from '../../../ethers-provider';
import { UniswapContractContextV2 } from '../../../uniswap-contract-context/uniswap-contract-context-v2';

export class UniswapPairContractFactoryV2 {
  private _uniswapPairFactory =
    this._ethersProvider.getContract<PairContractContext>(
      JSON.stringify(UniswapContractContextV2.pairAbi),
      this._pairAddress
    );

  constructor(
    private _ethersProvider: EthersProvider,
    private _pairAddress: string = UniswapContractContextV2.pairAddress
  ) { }

  public async getReserves(): Promise<GetReservesResponse> {
    return await this._uniswapPairFactory.getReserves();
  }

  public async balanceOf(address: string): Promise<string> {
    return (await this._uniswapPairFactory.balanceOf(address)).toHexString();
  }

  public async getTokens() {
    const tokenA = await this._uniswapPairFactory.token0();
    const tokenB = await this._uniswapPairFactory.token1();

    return {
      tokenA, tokenB
    }
  }

  /**
   * Generate the token approve data allowance to move the tokens.
   * This will return the data for you to send as a transaction
   * @spender The contract address for which you are allowing to move tokens on your behalf
   * @value The amount you want to allow them to do
   */
  public generateApproveAllowanceData(spender: string, value: string): string {
    return this._uniswapPairFactory.interface.encodeFunctionData('approve', [
      spender,
      value,
    ]);
  }
}
