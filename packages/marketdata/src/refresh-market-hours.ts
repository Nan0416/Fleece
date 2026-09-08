import { writeFileSync } from 'node:fs';
import * as path from 'node:path';

import 'dotenv/config';

import { AlpacaMarketDataClient } from './alpaca';

const FROM_DATE = '2001-01-02';
const TO_DATE = `${new Date().getUTCFullYear() + 2}-12-31`;
const FILE = path.join(__dirname, 'market-hours-data.json');

async function main(): Promise<void> {
  const apiKey = process.env['ALPACA_PAPER_API_KEY'];
  const secretKey = process.env['ALPACA_PAPER_SECRET_KEY'];
  if (apiKey === undefined || secretKey === undefined) {
    throw new Error('Put ALPACA_PAPER_API_KEY and ALPACA_PAPER_SECRET_KEY in .env.');
  }

  const { sessions } = await new AlpacaMarketDataClient({ apiKey, secretKey }).marketHours({ fromDate: FROM_DATE, toDate: TO_DATE });
  if (sessions.length === 0) {
    throw new Error(`Alpaca returned no sessions between ${FROM_DATE} and ${TO_DATE}; leaving the file alone.`);
  }

  writeFileSync(FILE, `${JSON.stringify(sessions, null, 2)}\n`);
  console.log(`Wrote ${sessions.length} sessions, ${sessions[0].date} to ${sessions[sessions.length - 1].date}.`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
