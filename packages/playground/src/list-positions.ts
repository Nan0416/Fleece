import { Decimal, LoggerFactory } from '@fleece/utilities';
import { alpacaTradingClient } from './client';
import { OccSymbol, parseOccSymbol } from '@fleece/marketdata';
import { AlpacaPosition } from '@fleece/broker';

const logger = LoggerFactory.getLogger('ListPositions');

interface OptionPosition {
  readonly occSymbol: OccSymbol;
  readonly size: Decimal;
  readonly avgEntryPrice: Decimal;
  readonly currentPrice: Decimal;

  readonly marketValue: Decimal;
  readonly costBasis: Decimal;
}

function toOptionPosition(position: AlpacaPosition): OptionPosition | undefined {
  if (position.asset_class !== 'us_option') {
    return undefined;
  }
  const occSymbol = parseOccSymbol(position.symbol);
  if (occSymbol === undefined) {
    throw new Error(`Symbol is ${position.symbol} is not a valid option OCC symbol.`);
  }

  const marketValue = Decimal.of(position.market_value);
  const size = Decimal.of(position.qty);
  const costBasis = Decimal.of(position.cost_basis);

  const multiplier = marketValue.div(Decimal.of(position.current_price).mul(size), 0);
  if (!multiplier.eq(Decimal.of(100))) {
    throw new Error(`Position ${position.symbol} current market value ${position.market_value} is not x100 times of price ${position.current_price} * ${position.qty}`);
  }

  return {
    occSymbol,
    size: size,
    avgEntryPrice: Decimal.of(position.avg_entry_price),
    currentPrice: Decimal.of(position.market_value).div(size.mul(multiplier), 2),
    marketValue,
    costBasis,
  };
}

async function main(): Promise<void> {
  const client = alpacaTradingClient(true);
  const { positions } = await client.listPositions();
  const optionPositions: OptionPosition[] = positions.map((pos) => toOptionPosition(pos)).filter((pos) => pos !== undefined);
  const optionPositionsByExpirationByUnderlying: Map<string, Map<string, OptionPosition[]>> = new Map();

  optionPositions.forEach((optionPosition) => {
    let optionPositionsByExpiration = optionPositionsByExpirationByUnderlying.get(optionPosition.occSymbol.symbol);
    if (optionPositionsByExpiration === undefined) {
      optionPositionsByExpiration = new Map();
      optionPositionsByExpirationByUnderlying.set(optionPosition.occSymbol.symbol, optionPositionsByExpiration);
    }

    let positions = optionPositionsByExpiration.get(optionPosition.occSymbol.expiration);
    if (positions === undefined) {
      positions = [];
      optionPositionsByExpiration.set(optionPosition.occSymbol.expiration, positions);
    }
    positions.push(optionPosition);
  });

  for (const optionPositionsByExpiration of optionPositionsByExpirationByUnderlying.values()) {
    for (const positions of optionPositionsByExpiration.values()) {
      positions.forEach((position) => {
        console.log(`${position.occSymbol.symbol}, ${position.avgEntryPrice.toString()} ${position.currentPrice.toString()} ${position.size.toString()}`);
      });
    }
  }
}

main().catch((err: unknown) => {
  logger.error('The cancel failed.', err);
  process.exitCode = 1;
});
