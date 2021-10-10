import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { GatewayHealthIndicator } from './gateway.health';

@Controller('health')
export class HealthController {
  constructor(
    private health: HealthCheckService,
    private gatewayHealthIndicator: GatewayHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([
      () => this.gatewayHealthIndicator.isHealthy('gateway'),
    ]);
  }
}
