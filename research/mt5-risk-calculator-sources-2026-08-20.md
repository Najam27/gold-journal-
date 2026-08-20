# MT5 Risk Calculator Source Notes

## Authoritative broker data contract

MetaQuotes documents that `AccountInfoDouble()` exposes account balance, equity, margin, free margin, margin level, and Stop Out properties. The Gold Journal calculator should display those EA-supplied values as a snapshot only; it must not infer margin availability from a local approximation.

MetaQuotes also documents that `SymbolInfoDouble()` exposes a symbol's trade tick value, tick size, contract size, minimum volume, maximum volume, and volume step. A broker-specific lot-size calculation therefore requires the EA to provide the selected XAUUSD symbol's live properties. The calculator must require a trader-entered entry price and stop-loss price, derive stop distance, calculate raw volume as `risk amount / (stop distance / tick size × loss tick value)`, and round down to the broker volume step between the broker minimum and maximum. It must show an unavailable/error state rather than apply a hardcoded XAUUSD contract assumption when required broker fields are missing or invalid.

The calculator is a pre-trade planning aid only. It does not send `OrderSend`, order-modification, or trade-execution requests.

## Sources

1. [MQL5 Account Properties](https://www.mql5.com/en/docs/constants/environment_state/accountinformation)
2. [MQL5 Symbol Properties](https://www.mql5.com/en/docs/constants/environment_state/marketinfoconstants)

## AI risk-coach contract

OpenRouter's structured-output guidance supports `response_format` with a strict JSON Schema, but notes that support varies by model/provider endpoint. The risk coach should therefore use the existing server-only OpenRouter key/model configuration, a bounded request deadline, strict output validation, explicit non-trading prompts, and a deterministic-calculator fallback when the provider is unavailable, rate-limited, or returns an invalid response. It must never receive browser-held credentials, screenshots, raw notes, or an instruction capable of placing an order.

The server should use a compact, validated calculator snapshot only: account metrics already returned by the authenticated MT5 workspace, trader-entered entry/stop/direction/risk percent, broker-reported symbol constraints, and deterministic calculated values. It should return only risk-limit observations, calculation warnings, and questions for the trader to verify; no BUY/SELL call, price forecast, or guaranteed result.

3. [OpenRouter Structured Outputs](https://openrouter.ai/docs/guides/features/structured-outputs)
4. [OpenRouter Errors and Debugging](https://openrouter.ai/docs/api_reference/errors-and-debugging)
