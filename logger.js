// logger.js
const { createLogger, format, transports } = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const { combine, timestamp, printf, colorize } = format;

const env = process.env.NODE_ENV || 'development';

const logFormat = printf(({ level, message, timestamp }) => {
  return `[${timestamp}] ${level}: ${message}`;
});

const loggerTransports = [
  new transports.Console({
    format: combine(colorize(), timestamp(), logFormat),
  }),

  new DailyRotateFile({
    filename: 'logs/app-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxSize: '20m',
    maxFiles: '14d', // keep logs for 14 days
    format: combine(timestamp(), logFormat),
  }),
];

const logger = createLogger({
  level: env === 'development' ? 'debug' : 'info',
  transports: loggerTransports,
});

module.exports = logger;
