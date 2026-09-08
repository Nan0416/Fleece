/**
 * The broker account stamped on the synthetic orders a position transfer writes.
 *
 * A transfer is not a trade at any venue, but it moves shares and realises profit, so
 * it has to be recorded as orders for the ledger to add up. This id is what marks
 * those orders as internal when reconciling against a real brokerage statement.
 */
export const TRANSFER_BROKER_ACCOUNT_ID = 'Q-0001';
