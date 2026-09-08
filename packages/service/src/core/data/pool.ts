import { LoggerFactory } from '@fleece/shared';
import { Pool, PoolConfig } from 'pg';

const logger = LoggerFactory.getLogger('Database');

export interface DatabaseProps {
  readonly connectionString: string;
  readonly maxConnections?: number;
}

export function createPool(props: DatabaseProps): Pool {
  const config: PoolConfig = {
    connectionString: props.connectionString,
    max: props.maxConnections ?? 10,
  };
  const pool = new Pool(config);

  // An idle client erroring (server restart, network blip) emits on the pool rather
  // than on any pending query. Without a listener node treats it as unhandled and
  // takes the process down.
  pool.on('error', (err) => {
    logger.error('Idle database client errored.', err);
  });

  return pool;
}
