import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, WebSocket } from 'ws';
import * as jwt from 'jsonwebtoken';
import { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import { Config, RedisConfig, Services } from '../common/config/configuration';
import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis, { RedisOptions } from 'ioredis';
import * as jwksClient from 'jwks-rsa';
import { AuthRequiredMessage } from './interfaces/auth-required.interface';
import { WebsocketMessage } from './interfaces/ws-message.interface';
import { AuthMessage } from './interfaces/auth.interface';
import { AuthExpiredMessage } from './interfaces/auth-expired.interface';

type CustomWebSocket = WebSocket & {
  isAlive: boolean;
  isAuthenticated: boolean;
  expiresAt?: Date;
  authExpired?: boolean;
  authTimeout?: ReturnType<typeof setTimeout>;
};

@WebSocketGateway()
export class SocketGateway
  implements
    OnGatewayInit,
    OnGatewayConnection,
    OnGatewayDisconnect,
    OnModuleInit,
    OnModuleDestroy
{
  private readonly logger = new Logger(SocketGateway.name);

  @WebSocketServer()
  private readonly server: Server;

  private readonly subscriberClient = this.newRedisClient();

  private pingInterval: NodeJS.Timer;
  private expireInterval: NodeJS.Timer;

  private readonly JWKS = jwksClient({
    jwksUri: this.configService.get<Services>('services').jwk + '/jwks',
  });

  constructor(private readonly configService: ConfigService<Config>) {}

  isHealthy(): Promise<boolean> {
    return this.subscriberClient.ping().then(() => true);
  }

  async onModuleInit() {
    // Create ping interval for the specific socket

    // Subscribe to Redis websocket messages
    await this.subscriberClient.subscribe('websocket');

    // Listen for messages
    this.subscriberClient.on('message', (channel, message) => {
      if (channel !== 'websocket') {
        // Not a websocket message, skip it
        return;
      }

      let parsed;

      // Parse message
      try {
        parsed = JSON.parse(message);
      } catch (err) {}

      // Make sure message has required properties
      if (parsed?.data === undefined || parsed?.type === undefined) {
        return;
      }

      // Send message to all connected clients
      this.server.clients.forEach((ws: CustomWebSocket) => {
        if (ws.isAuthenticated) {
          this.sendMessage(ws, {
            type: parsed.type,
            data: parsed.data,
          });
        }
      });
    });

    this.createTimers();
  }

  async onModuleDestroy() {
    // Close Redis client before stopping
    await this.subscriberClient.quit();

    this.clearTimers();
  }

  private newRedisClient() {
    const redisConfig = this.configService.get<RedisConfig>('redis');

    let options: RedisOptions;

    if (redisConfig.isSentinel) {
      options = {
        sentinels: [
          {
            host: redisConfig.host,
            port: redisConfig.port,
          },
        ],
        name: redisConfig.set,
      };
    } else {
      options = {
        host: redisConfig.host,
        port: redisConfig.port,
        password: redisConfig.password,
      };
    }

    return new Redis(options);
  }

  afterInit() {
    this.server.options = {
      verifyClient: (info, callback) => {
        this.logger.debug('Verifying new client');

        if (info.req.headers.authorization === undefined) {
          callback(true);
          return;
        }

        // Extract authorization type and token
        const [type, token] = info.req.headers.authorization.split(' ');

        if (type !== 'Bearer') {
          this.logger.debug('Missing access token');
          callback(false, 400, 'Missing access token');
          return;
        }

        this.validateJWT(token)
          .then(({ isValid }) => {
            callback(isValid);
          })
          .catch((err) => {
            this.logger.error('Error validating jwt: ' + err.message);
            callback(false);
          });
      },
    };
  }

  /**
   * Called after verifyClient
   */
  async handleConnection(ws: CustomWebSocket, req: Request) {
    this.logger.debug(
      'Client connected (client count: ' + this.server.clients.size + ')',
    );

    ws.on('message', (message) => {
      let parsed: WebsocketMessage;

      // Parse message
      try {
        parsed = JSON.parse(message.toString('utf-8'));
      } catch (err) {}

      if (parsed.type === 'AUTH') {
        // TODO: Validate message?
        this.handleAuthMessage(ws, parsed as AuthMessage);
      }
    });

    if (req.headers.authorization === undefined) {
      // Websocket has not authenticated yet
      ws.isAuthenticated = false;
      this.authRequired(ws);
    } else {
      // Decode jwt
      const [, token] = req.headers.authorization.split(' ');
      const decoded = jwt.decode(token, { json: true });

      ws.expiresAt = new Date(decoded.exp * 1000);
      ws.isAuthenticated = true;
    }

    // Stop unresponsive sockets
    ws.isAlive = true;

    ws.on('pong', () => {
      // Received pong, socket is alive
      ws.isAlive = true;
    });
  }

  private handleAuthMessage(ws: CustomWebSocket, message: AuthMessage): void {
    const token = message?.data?.accessToken;

    if (!token) {
      return;
    }

    this.validateJWT(token)
      .then(({ isValid, payload }) => {
        if (!isValid) {
          return;
        }

        ws.expiresAt = new Date(payload.exp * 1000);
        ws.isAuthenticated = true;
        clearTimeout(ws.authTimeout);
        this.logger.debug('Client authenticated');
      })
      .catch((err) => {
        this.logger.error('Error verifying JWT: ' + err.message);
      });
  }

  private clearTimers() {
    clearInterval(this.pingInterval);
    clearInterval(this.expireInterval);
  }

  private createTimers() {
    this.pingInterval = setInterval(() => {
      this.server.clients.forEach((ws: CustomWebSocket) => {
        if (ws.readyState !== ws.OPEN) {
          return;
        }

        if (ws.isAlive === false) {
          this.logger.debug("Client didn't respond to ping");
          // Socket didn't respond in time / access token has expired
          return ws.terminate();
        }

        // Reset isAlive
        ws.isAlive = false;
        // Ping socket
        ws.ping();
      });
    }, 30000);

    this.expireInterval = setInterval(() => {
      const now = new Date().getTime();

      this.server.clients.forEach((ws: CustomWebSocket) => {
        if (
          ws.readyState !== ws.OPEN ||
          (!ws.isAuthenticated && !ws.authExpired)
        ) {
          return;
        }

        if (ws.expiresAt.getTime() <= now) {
          this.logger.debug('Access token expired');
          // Access token has expired

          ws.authExpired = true;
          this.authRequired(ws);
        }
      });
    }, 1000);
  }

  handleDisconnect(ws: CustomWebSocket) {
    // Do nothing
    this.logger.debug('Client disconnected');
    clearTimeout(ws.authTimeout);
  }

  private sendMessage(ws: WebSocket, message: WebsocketMessage): void {
    ws.send(JSON.stringify(message));
  }

  private authRequired(ws: CustomWebSocket): void {
    // Send auth required message
    const authRequiredMessage: AuthRequiredMessage = {
      type: 'AUTH_REQUIRED',
      data: {
        timeout: 1000,
      },
    };

    this.logger.debug('Notifying client that authentication is required');

    this.sendMessage(ws, authRequiredMessage);

    ws.authTimeout = setTimeout(() => {
      if (ws.authExpired) {
        const authExpiredMessage: AuthExpiredMessage = {
          type: 'AUTH_EXPIRED',
          data: null,
        };

        this.logger.debug('Client did not authenticate again in time');
        this.sendMessage(ws, authExpiredMessage);
        ws.close();
      } else if (!ws.isAuthenticated) {
        this.logger.debug('Client did not authenticate in time');
        ws.close();
      }
    }, authRequiredMessage.data.timeout);
  }

  private async validateJWT(
    token: string,
  ): Promise<{ isValid: boolean; payload?: jwt.JwtPayload }> {
    const decoded = jwt.decode(token, {
      complete: true,
    });

    if (decoded === null || !decoded.header.kid) {
      return {
        isValid: false,
      };
    }

    let publicKey: jwksClient.SigningKey = null;

    try {
      publicKey = await this.JWKS.getSigningKey(decoded.header.kid);
    } catch (err) {
      if (err instanceof jwksClient.SigningKeyNotFoundError) {
        return {
          isValid: false,
        };
      }

      // Generic error
      throw err;
    }

    return new Promise((resolve, reject) => {
      jwt.verify(token, publicKey.getPublicKey(), (err) => {
        if (err) {
          return reject(err);
        }

        return resolve({
          isValid: true,
          payload: decoded.payload as jwt.JwtPayload,
        });
      });
    });
  }
}
