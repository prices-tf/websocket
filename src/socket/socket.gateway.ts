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
import { Config, RedisConfig } from '../common/config/configuration';
import { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import IORedis from 'ioredis';

type CustomWebSocket = WebSocket & {
  isAlive: boolean;
  pingInterval: NodeJS.Timer;
  expireTimeout: NodeJS.Timeout;
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
  @WebSocketServer()
  private readonly server: Server;

  private readonly subscriberClient = this.newRedisClient();

  constructor(private readonly configService: ConfigService<Config>) {}

  isHealthy(): Promise<boolean> {
    return this.subscriberClient.ping().then(() => true);
  }

  async onModuleInit() {
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
            data: parsed.payload,
          }),
        ),
      );
    });
  }

  async onModuleDestroy() {
    // Close Redis client before stopping
    await this.subscriberClient.quit();
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
        // Extract authorization type and token
        const [type, token] = info.req.headers.authorization.split(' ');

        if (type !== 'Bearer') {
          callback(false);
          return;
        }

        // Verify that the JWT is valid
        jwt.verify(token, this.configService.get('jwtSecret'), (err) => {
          if (err) {
            callback(false);
          } else {
            callback(true);
          }
        });
      },
    };
  }

  /**
   * Called after verifyClient
   */
  async handleConnection(ws: CustomWebSocket, req: Request) {
    // Decode jwt
    const [, token] = req.headers.authorization.split(' ');
    const decoded = jwt.decode(token, { json: true });

    // Create timeout for when the JWT expires
    ws.expireTimeout = setTimeout(() => {
      ws.terminate();
    }, decoded.exp * 1000 - new Date().getTime());

    // Stop unresponsive sockets
    ws.isAlive = true;

    // Create ping interval for the specific socket
    ws.pingInterval = setInterval(() => {
      if (ws.isAlive === false) {
        // Socket didn't respond in time
        return ws.terminate();
      }

      // Reset isAlive
      ws.isAlive = false;
      // Ping socket
      ws.ping();
    }, 30000);

    ws.on('pong', () => {
      // Received pong, socket is alive
      ws.isAlive = true;
    });
  }

  handleDisconnect(ws: CustomWebSocket) {
    // Clear intervals and timeouts when the socket disconnects
    clearInterval(ws.pingInterval);
    clearTimeout(ws.expireTimeout);
  }
}
