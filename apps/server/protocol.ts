import { AppError, PROTOCOL_VERSION } from '../../packages/contracts/index.js';

/** No silent downgrade: a caller specifying a version gets exactly that contract. */
export function requireProtocol(version: string | string[] | undefined) {
  if (version !== undefined && version !== PROTOCOL_VERSION)
    throw new AppError('UNSUPPORTED_API_VERSION', `Supported API version: ${PROTOCOL_VERSION}`, 409);
}
