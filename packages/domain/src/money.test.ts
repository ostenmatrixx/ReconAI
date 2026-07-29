import { describe, expect, it } from "vitest";

import {
  MoneyError,
  addMoney,
  asCurrency,
  money,
  parseMoneyDecimal,
  serializeMoney,
} from "./money.js";

describe("money", () => {
  const usd = asCurrency("USD");

  it("parses decimal strings into exact minor units", () => {
    expect(parseMoneyDecimal("1234.50", usd)).toEqual({ minor: 123_450n, currency: usd });
    expect(parseMoneyDecimal("-0.01", usd)).toEqual({ minor: -1n, currency: usd });
  });

  it("rejects excess precision unless an explicit rounding policy is provided", () => {
    expect(() => parseMoneyDecimal("1.005", usd)).toThrow(MoneyError);
    expect(parseMoneyDecimal("1.005", usd, "half_away_from_zero")).toEqual({
      minor: 101n,
      currency: usd,
    });
    expect(parseMoneyDecimal("-1.005", usd, "half_away_from_zero")).toEqual({
      minor: -101n,
      currency: usd,
    });
  });

  it("rejects floats, exponent notation, locale separators, and out-of-range values", () => {
    expect(() => parseMoneyDecimal(String(1.1), asCurrency("JPY"))).toThrow(MoneyError);
    expect(() => parseMoneyDecimal("1e2", usd)).toThrow(MoneyError);
    expect(() => parseMoneyDecimal("1,000.00", usd)).toThrow(MoneyError);
    expect(() => money(2n ** 63n, usd)).toThrow(MoneyError);
  });

  it("does not add values of different currencies", () => {
    expect(() => addMoney(money(100n, usd), money(100n, asCurrency("EUR")))).toThrow(
      /currency mismatch/u,
    );
  });

  it("serializes bigint as a base-10 string", () => {
    expect(serializeMoney(money(9007199254740993n, usd))).toEqual({
      minor: "9007199254740993",
      currency: "USD",
    });
  });
});
