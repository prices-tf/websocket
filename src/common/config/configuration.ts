export interface Config {
  port: number;
  redis: RedisConfig;
  services: Services;
}

export interface RedisConfig {
  isSentinel: boolean;
  host: string;
  port: number;
  password?: string;
  set?: string;
}

export interface Services {
  jwk: string;
}

export default (): Config => {
  return {
    port:
      process.env.NODE_ENV === 'production'
        ? 3000
        : parseInt(process.env.PORT, 10),
    redis: {
      isSentinel: process.env.REDIS_IS_SENTINEL === 'true',
      host: process.env.REDIS_HOST,
      port: parseInt(process.env.REDIS_PORT, 10),
      password: process.env.REDIS_PASSWORD,
      set: process.env.REDIS_SET,
    },
    services: {
      jwk: process.env.JWK_SERVICE_URL,
    },
  };
};
