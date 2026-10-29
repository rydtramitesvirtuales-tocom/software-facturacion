# Despliegue seguro del facturador

## Uso local en este PC (sin Internet)

1. En `.env`, usa `NODE_ENV=development`, `HOST=127.0.0.1` y `TRUST_PROXY=false`. La configuración local de esta PC usa MySQL `root` sin contraseña; no reutilices esa cuenta en un servidor público ni compartas el archivo.
2. En `C:\xampp\apache\conf\httpd.conf`, habilita `LoadModule proxy_http_module modules/mod_proxy_http.so` y agrega antes de `Include conf/extra/httpd-vhosts.conf`:

   ```apache
   ProxyPreserveHost On
   ProxyPass /FACTURADOR/ http://127.0.0.1:3000/
   ProxyPassReverse /FACTURADOR/ http://127.0.0.1:3000/
   ```

3. Reinicia Apache desde el panel de XAMPP después de editar su configuración e inicia MySQL. Ejecuta `node server.js` desde la carpeta del proyecto solo si aún no está corriendo; si el puerto 3000 ya está ocupado por esta aplicación, no abras otra instancia. Abre `http://localhost/FACTURADOR/`. Mantén el puerto 3000 accesible solo desde este PC; no configures el router para exponerlo.

## Configuración inicial

1. En PowerShell, copia `.env.example` como `.env` (`Copy-Item .env.example .env`) y reemplaza todos los valores `REPLACE_WITH_...`. No compartas ni subas `.env` al repositorio.
2. Genera `SESSION_SECRET` con:

   ```powershell
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```

3. Usa contraseñas diferentes, aleatorias y de al menos 14 caracteres para el administrador y el aprendiz. No reutilices las contraseñas anteriores.
4. Crea en MySQL un usuario exclusivo de la aplicación; no expongas `root` al servidor web:

   ```sql
   CREATE USER 'facturador_app'@'localhost' IDENTIFIED BY 'REEMPLAZAR_POR_UNA_CLAVE_SEGURA';
   GRANT SELECT, INSERT, UPDATE, DELETE, CREATE
       ON centro_tramites_daniel.* TO 'facturador_app'@'localhost';
   ```

   Usa la misma clave en `DB_PASSWORD`. Al arrancar, el servidor crea las tablas faltantes de sesión, anulaciones, aperturas mensuales, cierres diarios, control por cuenta, arqueos de caja, gastos personales y auditoría. Verifica que el usuario de la aplicación conserve permisos de lectura y escritura en esas tablas.
5. Para uso local, usa `NODE_ENV=development`, `HOST=127.0.0.1`, `TRUST_PROXY=false` y elimina `DB_SSL_CA_PATH` si no usas TLS local. No publiques los puertos 3000 ni 3306 en Internet.
6. Inicia Node con `npm start`. El servidor solo escucha después de comprobar la conexión de base de datos y el almacén MySQL de sesiones.

## Despliegue en Render con MySQL de Aiven

1. **Prepara la base de datos antes de desplegar.** Haz una copia de seguridad de MySQL local y restáurala en la base de Aiven. El servidor crea algunas tablas auxiliares, pero no crea las tablas principales (`registro_ventas_completo`, gastos y demás datos del negocio). Comprueba que tablas y registros se hayan migrado y que el usuario de Aiven tenga permisos de lectura, escritura y `CREATE` en esa base. No apuntes la aplicación de producción a la base local.
2. En Aiven, crea una base y un usuario para la aplicación. Copia el host, puerto, nombre de base, usuario y contraseña del servicio. Descarga el certificado CA de Aiven. En la lista de acceso público de Aiven, permite las direcciones de salida que informa Render para el servicio; no abras el acceso a cualquier IP (`0.0.0.0/0`).
3. En Render, crea un **Web Service** desde este repositorio y configura:
   - Build Command: `npm ci`
   - Start Command: `npm start`
   - Health Check Path: `/healthz`
   - Variables: `NODE_ENV=production`, `HOST=0.0.0.0`, `TRUST_PROXY=true`, `SESSION_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `APPRENTICE_USERNAME`, `APPRENTICE_PASSWORD`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` y `DB_PASSWORD`. Usa contraseñas nuevas, distintas y seguras; no reutilices las del `.env` local.
4. En Render, agrega el certificado CA como **Secret File** llamado `aiven-ca.pem` y configura `DB_SSL_CA_PATH=/etc/secrets/aiven-ca.pem`. El servidor valida el certificado TLS de MySQL; no desactives la verificación SSL. No configures `PORT`: Render lo proporciona y la aplicación lo usa automáticamente.
5. Antes de recibir operaciones reales, abre el servicio y comprueba `/healthz`, el inicio de sesión, ambas sedes, crear y consultar una operación de prueba, los permisos, y los reportes. Restaura una copia de seguridad de prueba para confirmar que los datos se pueden recuperar.

## Apache/XAMPP y HTTPS

El navegador debe acceder a la interfaz y a la API desde el mismo origen HTTPS. Para una instalación bajo `/FACTURADOR/`, configura Apache con `mod_proxy`, `mod_proxy_http`, `mod_headers`, SSL y PHP habilitados. En el VirtualHost HTTPS, usa una regla equivalente a esta; adapta el dominio, las rutas y los certificados a tu servidor:

```apache
ProxyPreserveHost On
RequestHeader set X-Forwarded-Proto "https"

# El resto de la aplicación y la API pasan por Node.
ProxyPass        /FACTURADOR/ http://127.0.0.1:3000/
ProxyPassReverse /FACTURADOR/ http://127.0.0.1:3000/
```

Protege el acceso público para que solo se pueda entrar por HTTPS. Configura el certificado TLS en Apache y confirma que las peticiones PHP y Node conservan el mismo host y la cookie de sesión. No uses el servidor de desarrollo de Node como servidor público directo.

La URL de acceso debe ser la del dominio configurado, por ejemplo `https://tu-dominio/FACTURADOR/login.html`; no uses `localhost` desde los equipos del negocio.

## Cierre y corrección de operaciones

- En cada factura selecciona la cuenta que recibió el pago. Si se pagó a un tramitador o entidad, selecciona también la cuenta desde la que salió cada pago.
- Después de registrar una venta en el facturador, usa “Descargar factura PDF” o “Compartir factura PDF” debajo del botón de WhatsApp; también puedes buscar el trámite en el historial y pulsar “Descargar PDF” o “Compartir PDF” cuando el cliente la solicite más adelante. Compartir abre el menú del dispositivo cuando es compatible; descargar guarda el archivo directamente. Solo se generan PDF de ventas activas de la sede seleccionada.
- Al registrar un gasto local, selecciona la fecha real y la cuenta de salida; no escribas un medio de pago libre. Se permiten fechas anteriores, no futuras. En el control histórico anterior, si registras un gasto de un día que ya tiene cierre, vuelve a consultar y guardar ese cierre para actualizar el saldo esperado.
- Para iniciar el nuevo control separado, entra en “Cuadre diario por cuenta” y define saldos reales para Caja diaria, Fondo físico mensual, Bancolombia, Nequi y otros medios digitales. El corte puede iniciar hoy o mañana; escoge los saldos que realmente existen al comienzo de esa fecha. Los registros históricos no se modifican. Registra el dinero que mueves entre Caja diaria y Fondo como traslado, no como gasto; cuando pagues un gasto desde el fondo, selecciona “Fondo físico mensual”. El arqueo compara el efectivo esperado con el contado y pide la base que quedará para el día siguiente; la diferencia se muestra como faltante o sobrante. El producido retirado queda fuera de las cuentas controladas y no se suma automáticamente a otra cuenta. Los gastos personales se registran separados de los gastos del local, pero disminuyen la cuenta de salida elegida. El resumen agrupa Caja + Fondo como efectivo físico y Bancolombia + Nequi + otros digitales como saldo digital.
- Si el control ya quedó programado para mañana, antes de su inicio se muestran los saldos iniciales guardados. El administrador puede adelantar el inicio a hoy únicamente si aún no existen movimientos o cierres del nuevo control; los saldos no cambian y los movimientos del día seleccionado cuentan desde esa apertura. Este cambio de fecha queda auditado.
- En el nuevo cuadro, concilia cada cuenta por separado: apertura + entradas − salidas = saldo esperado. Escribe el conteo real, revisa la diferencia y guarda una nota. Daviplata y PSE/tarjeta se agrupan como “Otros medios digitales”; Bancolombia y Nequi permanecen separados.
- El bloque de cierre del reporte diario anterior se reemplazó por un acceso al nuevo control. Los cierres y su auditoría previos siguen guardados en la base de datos, pero el cierre diario nuevo se realiza solo en “Cuadre diario por cuenta”.
- Para cada sede y mes, puedes registrar el saldo real de apertura de caja y banco en el balance. Si falta una apertura, el sistema continúa desde el último cierre diario anterior y suma los movimientos posteriores; solo empieza en cero si todavía no existe un cierre previo. Una apertura mensual registrada explícitamente tiene prioridad para esa cuenta.
- En “Reporte diario de ventas y gastos”, selecciona la fecha y consulta la sección “Cierre diario de caja y banco”. La apertura se calcula desde el último cierre registrado; si aún no hay uno ese mes, se usa la apertura mensual (o el cierre anterior arrastrado) más los movimientos hasta el día anterior. Compara el saldo esperado con el efectivo contado y los saldos verificados en banco/billeteras.
- Registra una nota en cada cierre diario. Los descuadres quedan visibles como diferencia y no modifican automáticamente facturas, gastos ni balances; investiga y documenta el motivo antes de cualquier corrección. Si corriges un cierre guardado, el cambio queda auditado.
- La utilidad neta se calcula como ingresos menos pagos a tramitadores, pagos a entidades y gastos locales. En el balance mensual, el saldo conciliado parte del último cierre diario guardado en el mes y suma los movimientos de los días posteriores; si no existe cierre en el mes, se muestra apertura más movimientos del período. El balance también conserva y presenta el saldo esperado según apertura y movimientos para que los descuadres no queden ocultos.
- Para corregir una venta o un gasto, un administrador debe anularlo con un motivo y volver a registrarlo correctamente. El registro original permanece en la auditoría y deja de participar en reportes y balances.
- Si un reporte advierte de medios de pago antiguos o sin clasificar, revisa las operaciones históricas antes de cerrar el periodo. No se asignan silenciosamente a caja ni a banco.

## Antes de usar datos reales

- Comprueba que cada rol solo puede realizar las operaciones autorizadas y que el servidor mantiene la sede seleccionada en la sesión, no en un parámetro manipulable del navegador.
- Ejecuta una copia de seguridad de MySQL y prueba restaurarla antes de habilitar el acceso público; programa respaldos periódicos.
- Valida facturación, registro de gastos, permisos y reportes con datos de prueba de ambas sedes.
- Revisa `npm audit` y actualiza las dependencias vulnerables en un cambio separado, ejecutando pruebas de regresión.
