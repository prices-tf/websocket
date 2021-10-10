import { Injectable } from '@nestjs/common';
import {
  HealthIndicator,
  HealthIndicatorResult,
  HealthCheckError,
} from '@nestjs/terminus';
import { SocketGateway } from '../socket/socket.gateway';

@Injectable()
export class GatewayHealthIndicator extends HealthIndicator {
  constructor(private readonly gateway: SocketGateway) {
    super();
  }

  isHealthy(key: string): Promise<HealthIndicatorResult> {
    return this.gateway
      .isHealthy()
      .then(() => {
        return this.getStatus(key, true);
      })
      .catch((err) => {
        throw new HealthCheckError(
          'Gateway check failed',
          this.getStatus(key, false, { message: err.message }),
        );
      });
  }
}
