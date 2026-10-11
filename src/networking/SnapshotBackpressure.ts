import type { BufferedConnection, DataConnection } from 'peerjs';

export function snapshotBacklogged(connection: DataConnection, message: { t?: unknown }): boolean {
  return message.t === 's' && (
    ((connection as BufferedConnection).bufferSize ?? 0) > 0 ||
    (connection.dataChannel?.bufferedAmount ?? 0) > 64 * 1024
  );
}