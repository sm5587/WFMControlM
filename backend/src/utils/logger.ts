import winston from 'winston';
import path from 'path';
import { config } from '../config';
import { redactString, redactValue } from './log-redaction';

const redactFormat = winston.format((info) => {
  if (typeof info.message === 'string') {
    info.message = redactString(info.message);
  } else if (info.message != null) {
    info.message = redactString(String(info.message));
  }

  const skipKeys = new Set(['level', 'timestamp', 'service', 'splat']);
  for (const key of Object.keys(info)) {
    if (skipKeys.has(key) || key === 'message') continue;
    info[key] = redactValue(info[key], key);
  }

  return info;
});

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.errors({ stack: true }),
  redactFormat(),
  winston.format.printf(({ timestamp, level, message, service, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} [${level.toUpperCase()}] [${service || 'WFM-ControlM'}] ${message}${metaStr}`;
  })
);

export const logger = winston.createLogger({
  level: config.nodeEnv === 'production' ? 'info' : 'debug',
  format: logFormat,
  defaultMeta: { service: 'WFM-ControlM' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        logFormat
      ),
    }),
    new winston.transports.File({
      filename: path.join(config.logDir, 'error.log'),
      level: 'error',
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: path.join(config.logDir, 'combined.log'),
      maxsize: 10 * 1024 * 1024,
      maxFiles: 10,
    }),
  ],
});

export const createServiceLogger = (serviceName: string) => {
  return logger.child({ service: serviceName });
};
