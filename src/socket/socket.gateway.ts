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
import IORedis from 'ioredis';
import * as jwksClient from 'jwks-rsa';

type CustomWebSocket = WebSocket & {
  isAlive: boolean;
  expiresAt: Date;
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
      this.server.clients.forEach((ws) =>
        ws.send(
          JSON.stringify({
            type: parsed.type,
            data: parsed.data,
          }),
        ),
      );
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

    let options: IORedis.RedisOptions;

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

    return new IORedis(options);
  }

  afterInit() {
    this.server.options = {
      verifyClient: (info, callback) => {
        this.logger.debug('Verifying new client');

        if (info.req.headers.authorization === undefined) {
          callback(false, 400, 'Missing access token');
          return;
        }

        // Extract authorization type and token
        const [type, token] = info.req.headers.authorization.split(' ');

        if (type !== 'Bearer') {
          this.logger.debug('Missing access token');
          callback(false, 400, 'Missing access token');
          return;
        }

        const decoded = jwt.decode(token, {
          complete: true,
        });

        if (decoded === null) {
          this.logger.debug('Invalid token');
          callback(false);
          return;
        }

        if (!decoded.header.kid) {
          this.logger.debug('Token is missing kid');
          callback(false);
          return;
        }

        return this.JWKS.getSigningKey(decoded.header.kid)
          .then((publicKey) => {
            jwt.verify(token, publicKey.getPublicKey(), (err) => {
              if (err) {
                this.logger.error('Error verifying JWT: ' + err.message);
                callback(false);
              } else {
                callback(true);
              }
            });
          })
          .catch((err) => {
            // Error getting signing key
            if (err instanceof jwksClient.SigningKeyNotFoundError) {
              this.logger.debug(
                'Signing key ("' +
                  decoded.header.kid +
                  '") not found not exist',
              );
              // Signing key does not exist
              callback(false);
            } else {
              this.logger.error('Error getting signing key: ' + err.message);
              // Some other error
              callback(false, 500);
            }
          });
      },
    };
  }

  /**
   * Called after verifyClient
   */
  async handleConnection(ws: CustomWebSocket, req: Request) {
    this.logger.debug('Client connected');

    // Decode jwt
    const [, token] = req.headers.authorization.split(' ');
    const decoded = jwt.decode(token, { json: true });

    ws.expiresAt = new Date(decoded.exp * 1000);

    // Stop unresponsive sockets
    ws.isAlive = true;

    ws.on('pong', () => {
      // Received pong, socket is alive
      ws.isAlive = true;
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
        if (ws.readyState !== ws.OPEN) {
          return;
        }

        if (ws.expiresAt.getTime() <= now) {
          this.logger.debug('Access token expired');
          // Access token has expired
          ws.send(
            JSON.stringify({
              type: 'ACCESS_TOKEN_EXPIRED',
              data: null,
            }),
          );
          return ws.terminate();
        }
      });
    }, 1000);
  }

  handleDisconnect(ws: CustomWebSocket) {
    // Do nothing
    this.logger.debug('Client disconnected');
  }
}
