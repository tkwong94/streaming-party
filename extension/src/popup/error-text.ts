// Popup text for every {ok:false, error} code. Connection codes name the server address.
const ERROR_TEXT: Record<string, string> = {
  UNSUPPORTED_PAGE: 'This page is not a supported watch page.',
  NO_PENDING_INVITE: 'No invite found on this page.',
  CONNECT_FAILED: 'Could not connect to the server.',
  JOIN_DENIED: 'The invite is invalid or the party has ended.',
  ROOM_FULL: 'The party is full (10 people).',
  BAD_MESSAGE: 'The server rejected the request. Check your nickname.',
  ALREADY_JOINED: 'Already in a party.',
  RATE_LIMITED: 'Too many requests. Try again shortly.',
  BAD_SERVER_URL: 'The server address must start with ws:// or wss://.',
};

const CONNECT_TEXT: Record<string, (server: string) => string> = {
  // Some HTTP server answered but no party socket opened; this does not prove a browser block.
  CONNECT_REJECTED: (server) =>
    `Reached ${server} but could not open a party connection. Check that this is the host's test-01 server address including the /ws path (for example wss://<name>.trycloudflare.com/ws) and that the host's server is still running.`,
  CONNECT_REFUSED: (server) =>
    `Could not reach the sync server at ${server}. Check that the host's server is running and the address is correct.`,
  // Duration-free: raised by the SW 5000 ms open timeout or the port-side 8000 ms timeout.
  CONNECT_TIMEOUT: (server) =>
    `The sync server at ${server} did not answer in time. Check that the host's server is running and the address is correct, then try again.`,
};

export function errorText(code: string, serverUrl?: string): string {
  const connect = CONNECT_TEXT[code];
  if (connect) return connect(serverUrl || 'the server address');
  return ERROR_TEXT[code] ?? `Error: ${code}`;
}
