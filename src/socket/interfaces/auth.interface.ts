import { WebsocketMessage } from './ws-message.interface';

export interface AuthMessage extends WebsocketMessage {
  type: 'AUTH';
  data: {
    accessToken: string;
  };
}
