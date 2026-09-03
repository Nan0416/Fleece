import {
  GetPositionResponse,
  GetProfitResponse,
  ListHistoricalPositionsResponse,
  ListPositionsResponse,
  ListProfitsResponse,
  ListTransactionsByReferenceIdResponse,
  ListTransactionsResponse,
  StockSplitResponse,
  TransferPositionResponse,
} from '@fleece/shared';
import { LedgerService } from '@fleece/core';
import { Router } from 'express';
import type { Express } from 'express';
import {
  optionalStringParam,
  parseListHistoricalPositionsQuery,
  parseListPositionsQuery,
  parseListTransactionsQuery,
  parseStockSplitRequest,
  parseTransferPositionRequest,
  requireStringParam,
} from '../utils/request-parsing';
import { Endpoints } from './endpoints';

export interface LedgerEndpointsProps {
  readonly ledgerService: LedgerService;
}

/** Positions, realised profit and the transaction log. */
export class LedgerEndpoints implements Endpoints {
  private readonly router: Router;

  constructor(props: LedgerEndpointsProps) {
    const { ledgerService } = props;
    this.router = Router();

    this.router.get('/positions', async (req, res) => {
      const response: ListPositionsResponse = await ledgerService.listPositions(parseListPositionsQuery(req.query));
      res.status(200).json(response);
    });

    this.router.get('/position', async (req, res) => {
      const response: GetPositionResponse = await ledgerService.getPosition({
        accountId: requireStringParam(req.query, 'accountId'),
        symbol: requireStringParam(req.query, 'symbol'),
      });
      res.status(200).json(response);
    });

    this.router.get('/historical-positions', async (req, res) => {
      const response: ListHistoricalPositionsResponse = await ledgerService.listHistoricalPositions(parseListHistoricalPositionsQuery(req.query));
      res.status(200).json(response);
    });

    this.router.put('/position/split', async (req, res) => {
      const response: StockSplitResponse = await ledgerService.stockSplit(parseStockSplitRequest(req.body));
      res.status(200).json(response);
    });

    this.router.post('/position/transfer', async (req, res) => {
      const response: TransferPositionResponse = await ledgerService.transferPosition(parseTransferPositionRequest(req.body));
      res.status(200).json(response);
    });

    this.router.get('/profits', async (req, res) => {
      const response: ListProfitsResponse = await ledgerService.listProfits({ accountId: requireStringParam(req.query, 'accountId') });
      res.status(200).json(response);
    });

    this.router.get('/profit', async (req, res) => {
      const response: GetProfitResponse = await ledgerService.getProfit({
        accountId: requireStringParam(req.query, 'accountId'),
        symbol: requireStringParam(req.query, 'symbol'),
      });
      res.status(200).json(response);
    });

    /**
     * Two listings on one path, chosen by which parameter is present.
     *
     * The legacy service had three: this shape, an unbounded `accountId`+`symbol`
     * variant marked `@deprecated` in its own source ("The api is not scale"), and a
     * `transactions-v2` path carrying the paged form. The deprecated one is gone and
     * the paged form moved onto this path, so a caller that omits `from`, `limit` and
     * `sort` now gets a 400 rather than an unbounded scan.
     */
    this.router.get('/transactions', async (req, res) => {
      const referenceId = optionalStringParam(req.query, 'referenceId');
      if (referenceId !== undefined) {
        const response: ListTransactionsByReferenceIdResponse = await ledgerService.listTransactionsByReferenceId({ referenceId });
        res.status(200).json(response);
        return;
      }
      const response: ListTransactionsResponse = await ledgerService.listTransactions(parseListTransactionsQuery(req.query));
      res.status(200).json(response);
    });
  }

  bind(app: Express): void {
    app.use(this.router);
  }
}
