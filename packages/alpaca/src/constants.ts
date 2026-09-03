export const ALPACA_REST_LIVE_URL = 'https://api.alpaca.markets';
export const ALPACA_REST_PAPER_URL = 'https://paper-api.alpaca.markets';

export const ALPACA_WS_LIVE_URL = 'wss://api.alpaca.markets/stream';
export const ALPACA_WS_PAPER_URL = 'wss://paper-api.alpaca.markets/stream';

export function restUrl(live: boolean): string {
  return live ? ALPACA_REST_LIVE_URL : ALPACA_REST_PAPER_URL;
}

export function websocketUrl(live: boolean): string {
  return live ? ALPACA_WS_LIVE_URL : ALPACA_WS_PAPER_URL;
}
