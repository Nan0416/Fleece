/**
 * How the position monitor writes numbers and names, shared by the rules, stdout and Discord.
 */
import type { OptionType } from '@fleece/marketdata';
import { Decimal } from '@fleece/utilities';

/** Rounded before the sign is read, so a loss of a tenth of a cent prints as `$0.00` rather than `-$0.00`. */
export function dollars(value: Decimal): string {
  const cents = value.round(2);
  return cents.signum() < 0 ? `-$${cents.neg().toFixed(2)}` : `$${cents.toFixed(2)}`;
}

export function signedDollars(value: Decimal): string {
  return value.round(2).signum() > 0 ? `+${dollars(value)}` : dollars(value);
}

export function percentOf(part: Decimal, whole: Decimal, scale: number = 1): string {
  const percent = part.mul(Decimal.of(100)).div(whole, scale);
  return `${percent.signum() === 0 ? percent.abs().toFixed(scale) : percent.toFixed(scale)}%`;
}

/** `360` or `232.5`, as a strike is quoted. */
export function strike(value: number): string {
  return String(value);
}

export function optionLetter(type: OptionType): string {
  return type === 'call' ? 'C' : 'P';
}

/** `10/23`, with the year only when it is not `today`'s, so a LEAP is not read as this year's. */
export function shortDate(date: string, today: string): string {
  const [year, month, day] = date.split('-');
  return year === today.slice(0, 4) ? `${month}/${day}` : `${month}/${day}/${year.slice(2)}`;
}

/** The message only: a stack says nothing to a channel, and a cron log gets it from the logger. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
