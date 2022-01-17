import { WebsocketMessage } from './ws-message.interface';

export interface AuthRequiredMessage extends WebsocketMessage {
  type: 'AUTH_REQUIRED';
  data: {
    // Timeout in milliseconds that client has to authenticate before they are
    // disconnected
    timeout: number;
  };
}
