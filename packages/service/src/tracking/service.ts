import { LoggerFactory } from '@fleece/shared';
import express, { ErrorRequestHandler, RequestHandler } from 'express';
import { Endpoints } from './routes/endpoints';

const logger = LoggerFactory.getLogger('TrackingService');

export interface TrackingServiceProps {
  readonly middleware: ReadonlyArray<RequestHandler>;
  readonly endpoints: ReadonlyArray<Endpoints>;
  readonly errorHandler: ErrorRequestHandler;
}

/** Assembles the Express app. Knows nothing about what the routes actually do. */
export class TrackingService {
  private readonly app: express.Express;

  constructor(private readonly props: TrackingServiceProps) {
    this.app = express();
  }

  init(): express.Express {
    // A claim is a short array of ids. The cap is well above the largest one the parser
    // will accept and well below anything that could buffer meaningful memory.
    this.app.use(express.json({ limit: '64kb' }));

    for (const middleware of this.props.middleware) {
      this.app.use(middleware);
    }
    for (const endpoints of this.props.endpoints) {
      endpoints.bind(this.app);
    }
    // Registered last: Express only routes to an error handler declared after the
    // routes that can fail.
    this.app.use(this.props.errorHandler);

    logger.info('Express application initialised.');
    return this.app;
  }
}
