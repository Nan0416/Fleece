import { Pool } from 'pg';
import { PgAccountDao } from '../data/pg-account-dao';
import { PgBrokerOrderDao } from '../data/pg-broker-order-dao';
import { PgDividendDao } from '../data/pg-dividend-dao';
import { PgLedgerDao } from '../data/pg-ledger-dao';
import { PgOrderGroupDao } from '../data/pg-order-group-dao';
import { AccountService } from '../services/account-service';
import { BrokerOrderService } from '../services/broker-order-service';
import { DividendService } from '../services/dividend-service';
import { LedgerService } from '../services/ledger-service';
import { OrderGroupService } from '../services/order-group-service';

/**
 * Everything the ledger offers, wired to one connection pool.
 *
 * The API process, the injector and the corporate-action job each build one of these
 * against the same database — they are three writers by design, which is the topology
 * the legacy system ran and the reason the write path locks rather than trusting a
 * single process to serialise itself.
 */
export interface LedgerServices {
  readonly accountService: AccountService;
  readonly ledgerService: LedgerService;
  readonly dividendService: DividendService;
  readonly orderGroupService: OrderGroupService;
  readonly brokerOrderService: BrokerOrderService;
}

export interface LedgerFactoryProps {
  readonly pool: Pool;
  /** Injectable so that dividend status derivation can be tested against a fixed date. */
  readonly now?: () => number;
}

export function createLedgerServices(props: LedgerFactoryProps): LedgerServices {
  const accountDao = new PgAccountDao(props.pool);
  const ledgerDao = new PgLedgerDao(props.pool);
  const dividendDao = new PgDividendDao(props.pool);
  const brokerOrderDao = new PgBrokerOrderDao(props.pool);
  const orderGroupDao = new PgOrderGroupDao(props.pool, brokerOrderDao);

  return {
    accountService: new AccountService(accountDao),
    ledgerService: new LedgerService(ledgerDao, accountDao),
    dividendService: new DividendService(dividendDao, accountDao, props.now),
    orderGroupService: new OrderGroupService(orderGroupDao, accountDao),
    brokerOrderService: new BrokerOrderService(brokerOrderDao, accountDao, orderGroupDao),
  };
}
