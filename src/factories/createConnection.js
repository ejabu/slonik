// @flow

import {
  serializeError,
} from 'serialize-error';
import type {
  MaybePromiseType,
  ClientConfigurationType,
  ConnectionTypeType,
  DatabasePoolType,
  DatabasePoolConnectionType,
  InternalDatabaseConnectionType,
  InternalDatabasePoolType,
  LoggerType,
  TaggedTemplateLiteralInvocationType,
} from '../types';
import {
  createTypeOverrides,
} from '../routines';
import {
  bindPoolConnection,
} from '../binders';
import {
  ConnectionError,
  UnexpectedStateError,
} from '../errors';

type ConnectionHandlerType = (
  connectionLog: LoggerType,
  connection: InternalDatabaseConnectionType,
  boundConnection: DatabasePoolConnectionType,
  clientConfiguration: ClientConfigurationType
) => MaybePromiseType<*>;

type PoolHandlerType = (pool: DatabasePoolType) => Promise<*>;

const terminatePoolConnection = (pool, connection, error) => {
  if (!connection.connection.slonik.terminated) {
    connection.connection.slonik.terminated = error;
  }

  pool._remove(connection);
  pool._pulseQueue();
};

const createConnection = async (
  parentLog: LoggerType,
  pool: InternalDatabasePoolType,
  clientConfiguration: ClientConfigurationType,
  connectionType: ConnectionTypeType,
  connectionHandler: ConnectionHandlerType,
  poolHandler: PoolHandlerType,
  query?: TaggedTemplateLiteralInvocationType | null = null,
) => {
  for (const interceptor of clientConfiguration.interceptors) {
    if (interceptor.beforePoolConnection) {
      const maybeNewPool = await interceptor.beforePoolConnection({
        log: parentLog,
        poolId: pool.slonik.poolId,
        query,
      });

      if (maybeNewPool) {
        return poolHandler(maybeNewPool);
      }
    }
  }

  let connection: InternalDatabaseConnectionType;

  let remainingConnectionRetryLimit = clientConfiguration.connectionRetryLimit;

  while (true) {
    remainingConnectionRetryLimit--;

    try {
      connection = await pool.connect();

      break;
    } catch (error) {
      parentLog.error({
        error: serializeError(error),
        remainingConnectionRetryLimit,
      }, 'cannot establish connection');

      if (remainingConnectionRetryLimit > 1) {
        parentLog.info('retrying connection');

        continue;
      } else {
        throw new ConnectionError(error.message);
      }
    }
  }

  if (!connection) {
    throw new UnexpectedStateError('Connection handle is not present.');
  }

  if (!pool.typeOverrides) {
    pool.typeOverrides = createTypeOverrides(connection, clientConfiguration.typeParsers);
  }

  // eslint-disable-next-line id-match
  connection._types = await pool.typeOverrides;

  if (connection.native) {
    // eslint-disable-next-line id-match
    connection.native._types = await pool.typeOverrides;
  }

  const connectionId = connection.connection.slonik.connectionId;

  const connectionLog = parentLog.child({
    connectionId,
  });

  const connectionContext = {
    connectionId,
    connectionType,
    log: connectionLog,
    poolId: pool.slonik.poolId,
  };

  const boundConnection = bindPoolConnection(connectionLog, connection, clientConfiguration);

  try {
    for (const interceptor of clientConfiguration.interceptors) {
      if (interceptor.afterPoolConnection) {
        await interceptor.afterPoolConnection(connectionContext, boundConnection);
      }
    }
  } catch (error) {
    terminatePoolConnection(pool, connection, error);

    throw error;
  }

  let result;

  try {
    result = await connectionHandler(connectionLog, connection, boundConnection, clientConfiguration);
  } catch (error) {
    terminatePoolConnection(pool, connection, error);

    throw error;
  }

  try {
    for (const interceptor of clientConfiguration.interceptors) {
      if (interceptor.beforePoolConnectionRelease) {
        await interceptor.beforePoolConnectionRelease(connectionContext, boundConnection);
      }
    }
  } catch (error) {
    terminatePoolConnection(pool, connection, error);

    throw error;
  }

  // Do not use `connection.release()`:
  //
  // It is possible that user might mishandle connection release,
  // and same connection is going to end up being used by multiple
  // invocations of `pool.connect`, e.g.
  //
  // ```
  // pool.connect((connection1) => { setTimeout(() => { connection1; }, 1000) });
  // pool.connect((connection2) => { setTimeout(() => { connection2; }, 1000) });
  // ```
  //
  // In the above scenario, connection1 and connection2 are going to be the same connection.
  //
  // `pool._remove(connection)` ensures that we create a new connection for each `pool.connect()`.
  //
  // The downside of this approach is that we cannot leverage idle connection pooling.
  terminatePoolConnection(pool, connection, new ConnectionError('Forced connection recycling.'));

  return result;
};

export default createConnection;
