const fs = require('fs');
const mysql = require('mysql2');
const path = require('path');
require('dotenv').config();
process.env.TZ = process.env.TZ || 'America/Bogota';

const dbHost = process.env.DB_HOST;
const dbPort = Number(process.env.DB_PORT);
const dbUser = process.env.DB_USER;
const dbPassword = process.env.DB_PASSWORD;
const dbName = process.env.DB_NAME;
const caPath = process.env.DB_SSL_CA_PATH || path.join(__dirname, 'aiven-ca.pem.txt');

if (!dbHost || !dbPort || !dbUser || !dbPassword || !dbName) {
  console.error('❌ Configura DB_HOST, DB_PORT, DB_USER, DB_PASSWORD y DB_NAME en .env.');
  process.exit(1);
}

if (!Number.isInteger(dbPort) || dbPort < 1 || dbPort > 65535) {
  console.error('❌ DB_PORT debe ser un puerto válido (1–65535).');
  process.exit(1);
}

const connection = mysql.createConnection({
  host: dbHost,
  port: dbPort,
  user: dbUser,
  password: dbPassword,
  database: dbName,
  ssl: {
    ca: fs.readFileSync(caPath, 'utf8'),
    rejectUnauthorized: true
  },
  multipleStatements: true
});

connection.connect((err) => {
  if (err) {
    console.error('❌ Error al conectar a Aiven:', err.message);
    process.exitCode = 1;
    return;
  }
  console.log('🔗 ¡Conectado a Aiven exitosamente!');

  connection.query('SHOW TABLES', (tablesError, tables) => {
    if (tablesError) {
      console.error('❌ No se pudo comprobar si la base está vacía:', tablesError.message);
      connection.end(() => {
        process.exitCode = 1;
      });
      return;
    }

    if (tables.length > 0) {
      console.error(`❌ La base "${dbName}" ya contiene ${tables.length} tabla(s); no se importó el archivo.`);
      console.error('👉 No borres tablas sin una copia de seguridad. Importa solo en una base nueva y vacía.');
      connection.end(() => {
        process.exitCode = 1;
      });
      return;
    }

    importarBase();
  });
});

function importarBase() {
  fs.readFile(path.join(__dirname, 'centro_tramites_daniel.sql'), 'utf8', (err, sqlData) => {
    if (err) {
      console.error('❌ Error al leer el archivo SQL:', err.message);
      connection.end();
      return;
    }

    console.log('⏳ Desactivando restricción temporal de primary keys e importando...');

    // Desactivamos la variable global de Aiven para permitir tablas sin PK y luego ejecutamos tu SQL
    const fullQuery = `
      SET SESSION sql_require_primary_key = OFF;
      ${sqlData}
    `;

    connection.query(fullQuery, (err, results) => {
      if (err) {
        console.error('❌ Error al ejecutar las consultas SQL:', err.message);
        console.error('👉 La importación pudo quedar parcial. No la repitas en esta base; prepara otra base vacía.');
      } else {
        console.log('✅ ¡Base de datos migrada y subida a Aiven con éxito absoluto!');
      }
      connection.end((endError) => {
        if (endError) {
          console.error('❌ Error al cerrar la conexión:', endError.message);
        }
        if (err || endError) process.exitCode = 1;
      });
    });
  });
}