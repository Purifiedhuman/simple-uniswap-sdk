import { JsonFragment } from '@ethersproject/abi';
import uniswapRouterV3AbiJson from '../ABI/uniswap-router-v3.json';
import uniswapFactoryV3AbiJson from '../ABI/uniswap-factory-v3.json';
import uniswapQuoterV3AbiJson from '../ABI/uniswap-quoter-v3.json';

export class UniswapContractContextV3 {
  /**
   * The uniswap router address
   */
  public static routerAddress = '0xE592427A0AEce92De3Edee1F18E0157C05861564';

  /**
   * The uniswap factory address
   */
  public static factoryAddress = '0x1F98431c8aD98523631AE4a59f267346ea31F984';

  /**
   * The uniswap quoter address
   */
  public static quoterAddress = '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6';

  /**
   * Uniswap router
   */
  public static routerAbi: JsonFragment[] = uniswapRouterV3AbiJson;

  /**
   * Uniswap factory
   */
  public static factoryAbi: JsonFragment[] = uniswapFactoryV3AbiJson;

  /**
   * Uniswap quoter
   */
  public static quoterAbi: JsonFragment[] = uniswapQuoterV3AbiJson;
}
