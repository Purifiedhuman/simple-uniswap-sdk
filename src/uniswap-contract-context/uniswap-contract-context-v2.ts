import { JsonFragment } from '@ethersproject/abi';
import uniswapRouterV2AbiJson from '../ABI/uniswap-router-v2.json';
import uniswapFactoryV2AbiJson from '../ABI/uniswap-factory-v2.json';
import uniswapPairV2AbiJson from '../ABI/uniswap-pair-v2.json';

export class UniswapContractContextV2 {
  /**
   * The uniswap router address
   */
  public static routerAddress = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';

  /**
   * The uniswap factory address
   */
  public static factoryAddress = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f';

  /**
   * The uniswap pair address
   */
  public static pairAddress = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f';

  /**
   * Uniswap v2 router
   */
  public static routerAbi: JsonFragment[] = uniswapRouterV2AbiJson;

  /**
   * Uniswap v2 factory
   */
  public static factoryAbi: JsonFragment[] = uniswapFactoryV2AbiJson;

  /**
   * Uniswap v2 pair
   */
  public static pairAbi: JsonFragment[] = uniswapPairV2AbiJson;
}
