import { JsonFragment } from '@ethersproject/abi';
import erc20AbiJson from '../ABI/erc-20-abi.json';

export class ContractContext {
  /**
   * ERC20 abi
   */
  public static erc20Abi: JsonFragment[] = erc20AbiJson;
}
