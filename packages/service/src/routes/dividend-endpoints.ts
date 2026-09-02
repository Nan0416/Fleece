import { ListDividendsResponse } from '@fleece/shared';
import { DividendService } from '@fleece/core';
import { Router } from 'express';
import type { Express } from 'express';
import { parseListDividendsQuery } from '../utils/request-parsing';
import { Endpoints } from './endpoints';

export interface DividendEndpointsProps {
  readonly dividendService: DividendService;
}

/**
 * Dividends are read-only over HTTP. They are written by the corporate-action job,
 * which holds the ledger directly rather than coming through here.
 */
export class DividendEndpoints implements Endpoints {
  private readonly router: Router;

  constructor(props: DividendEndpointsProps) {
    const { dividendService } = props;
    this.router = Router();

    this.router.get('/dividends', async (req, res) => {
      const response: ListDividendsResponse = await dividendService.listDividends(parseListDividendsQuery(req.query));
      res.status(200).json(response);
    });
  }

  bind(app: Express): void {
    app.use(this.router);
  }
}
