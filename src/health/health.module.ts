import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { GatewayHealthIndicator } from './gateway.health';
import { TerminusModule } from '@nestjs/terminus';
import { SocketModule } from '../socket/socket.module';

@Module({
  imports: [TerminusModule, SocketModule],
  providers: [GatewayHealthIndicator],
  controllers: [HealthController],
})
export class HealthModule {}
