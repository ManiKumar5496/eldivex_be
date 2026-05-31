require('dotenv').config();

module.exports = {
  development: {
    client: 'mysql2',
    connection: {
      host: process.env.DB_HOST || '13.233.82.197',
      user: process.env.DB_USER || 'remoteuser',
      password: process.env.DB_PASS ?? '',
      database: process.env.DB_NAME || 'lifecirclefamily',
      timezone: 'local'
    },
    migrations: {
      directory: './migrations'
    },
    seeds: {
      directory: './seeds'
    }
  }
};


