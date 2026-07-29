import { z } from "zod";

const isoCurrencyPattern = /^[A-Z]{3}$/u;
const decimalPattern = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/u;
const int64Minimum = -(2n ** 63n);
const int64Maximum = 2n ** 63n - 1n;

export const CurrencySchema = z
  .string()
  .regex(isoCurrencyPattern, "currency must be an uppercase ISO 4217 code")
  .brand<"Currency">();

export type Currency = z.infer<typeof CurrencySchema>;

export interface Money {
  readonly minor: bigint;
  readonly currency: Currency;
}

export interface MoneyJson {
  readonly minor: string;
  readonly currency: Currency;
}

export type RoundingMode = "reject" | "half_away_from_zero";

const currencyExponents: Readonly<Record<string, number>> = {
  BHD: 3,
  CAD: 2,
  EUR: 2,
  GBP: 2,
  JPY: 0,
  KWD: 3,
  PHP: 2,
  SGD: 2,
  USD: 2,
};

export class MoneyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

export function asCurrency(value: string): Currency {
  return CurrencySchema.parse(value);
}

export function currencyExponent(currency: Currency): number {
  const exponent = currencyExponents[currency];
  if (exponent === undefined) {
    throw new MoneyError(`unsupported currency exponent policy: ${currency}`);
  }
  return exponent;
}

export function money(minor: bigint, currency: Currency): Money {
  assertInt64(minor);
  return Object.freeze({ minor, currency });
}

export function parseMoneyDecimal(
  input: string,
  currency: Currency,
  rounding: RoundingMode = "reject",
): Money {
  const match = decimalPattern.exec(input);
  if (!match) throw new MoneyError("money must be a plain base-10 decimal string");

  const negative = match[1] === "-";
  const whole = match[2] ?? "0";
  const fraction = match[3] ?? "";
  const exponent = currencyExponent(currency);
  let keptFraction = fraction.slice(0, exponent).padEnd(exponent, "0");

  if (fraction.length > exponent) {
    if (rounding === "reject") {
      throw new MoneyError(
        `money has more than ${exponent.toString()} fractional digits for ${currency}`,
      );
    }
    const discarded = fraction.slice(exponent);
    if ((discarded[0] ?? "0") >= "5") {
      const scale = 10n ** BigInt(exponent);
      const magnitude = BigInt(whole) * scale + BigInt(keptFraction || "0") + 1n;
      return money(negative ? -magnitude : magnitude, currency);
    }
  }

  if (keptFraction.length === 0) keptFraction = "0";
  const scale = 10n ** BigInt(exponent);
  const magnitude = BigInt(whole) * scale + BigInt(keptFraction);
  return money(negative ? -magnitude : magnitude, currency);
}

export function addMoney(left: Money, right: Money): Money {
  assertSameCurrency(left, right);
  return money(left.minor + right.minor, left.currency);
}

export function subtractMoney(left: Money, right: Money): Money {
  assertSameCurrency(left, right);
  return money(left.minor - right.minor, left.currency);
}

export function absoluteMinorDifference(left: Money, right: Money): bigint {
  assertSameCurrency(left, right);
  const difference = left.minor - right.minor;
  return difference < 0n ? -difference : difference;
}

export function sumMoney(values: readonly Money[], currency: Currency): Money {
  return values.reduce((total, value) => addMoney(total, value), money(0n, currency));
}

export function moneyEquals(left: Money, right: Money): boolean {
  return left.currency === right.currency && left.minor === right.minor;
}

export function serializeMoney(value: Money): MoneyJson {
  return { minor: value.minor.toString(), currency: value.currency };
}

export function parseMoneyJson(value: MoneyJson): Money {
  if (!/^-?(?:0|[1-9]\d*)$/u.test(value.minor)) {
    throw new MoneyError("minor units must be a base-10 integer string");
  }
  return money(BigInt(value.minor), asCurrency(value.currency));
}

function assertSameCurrency(left: Money, right: Money): void {
  if (left.currency !== right.currency) {
    throw new MoneyError(`currency mismatch: ${left.currency} and ${right.currency}`);
  }
}

function assertInt64(value: bigint): void {
  if (value < int64Minimum || value > int64Maximum) {
    throw new MoneyError("minor units exceed signed 64-bit PostgreSQL range");
  }
}
