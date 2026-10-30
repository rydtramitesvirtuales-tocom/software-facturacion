const express = require('express');
const mysql = require('mysql2');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
require('dotenv').config();
process.env.TZ = process.env.TZ || 'America/Bogota';

const app = express();
app.disable('x-powered-by');
const zonaHorariaNegocio = '-05:00';

const modoProduccion = process.env.NODE_ENV === 'production';
const sessionSecret = process.env.SESSION_SECRET;
const usuariosRD = [
    {
        usuario: process.env.ADMIN_USERNAME,
        contrasena: process.env.ADMIN_PASSWORD,
        rol: 'ADMINISTRADOR',
        nombre_real: process.env.ADMIN_DISPLAY_NAME || 'Administrador'
    },
    {
        usuario: process.env.APPRENTICE_USERNAME,
        contrasena: process.env.APPRENTICE_PASSWORD,
        rol: 'APRENDIZ',
        nombre_real: process.env.APPRENTICE_DISPLAY_NAME || 'Funcionario Aprendiz'
    }
];

if (!sessionSecret || sessionSecret.length < 32 || /replace_with|change_me/i.test(sessionSecret)) {
    throw new Error('Configura SESSION_SECRET con al menos 32 caracteres en el archivo .env.');
}
if (usuariosRD.some(usuario => !usuario.usuario || !usuario.contrasena)) {
    throw new Error('Configura ADMIN_USERNAME, ADMIN_PASSWORD, APPRENTICE_USERNAME y APPRENTICE_PASSWORD en .env.');
}
if (usuariosRD.some(usuario => usuario.contrasena.length < 14 || /replace_with|change_me|rd1234/i.test(usuario.contrasena))) {
    throw new Error('Cada contraseña debe tener al menos 14 caracteres y reemplazar los valores de ejemplo.');
}
if (usuariosRD[0].usuario === usuariosRD[1].usuario || usuariosRD[0].contrasena === usuariosRD[1].contrasena) {
    throw new Error('El administrador y el aprendiz deben tener credenciales diferentes.');
}
if (modoProduccion && (
    !process.env.DB_HOST ||
    !process.env.DB_NAME ||
    !process.env.DB_USER ||
    process.env.DB_USER.toLowerCase() === 'root' ||
    !process.env.DB_PASSWORD
)) {
    throw new Error('En producción configura DB_HOST, DB_NAME, DB_USER y DB_PASSWORD con un usuario MySQL exclusivo de la aplicación.');
}
if (modoProduccion && !process.env.DB_SSL_CA && !process.env.DB_SSL_CA_PATH) {
    throw new Error('En producción configura el certificado CA de MySQL en DB_SSL_CA o DB_SSL_CA_PATH.');
}
if (modoProduccion && process.env.TRUST_PROXY !== 'true') {
    throw new Error('En producción, Node debe estar detrás de un proxy HTTPS configurado con TRUST_PROXY=true.');
}

if (process.env.TRUST_PROXY === 'true') {
    app.set('trust proxy', 1);
}

// ==========================================
// 1. CONFIGURACIÓN GENERAL Y MIDDLEWARES
// ==========================================
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get('/healthz', (_req, res) => {
    conexion.ping(error => {
        if (error) {
            console.error('La comprobación de salud no pudo conectarse con MySQL:', error.message);
            return res.status(503).json({ status: 'unavailable' });
        }
        res.status(200).json({ status: 'ok' });
    });
});

const certificadoCa = process.env.DB_SSL_CA_PATH
    ? fs.readFileSync(process.env.DB_SSL_CA_PATH, 'utf8')
    : process.env.DB_SSL_CA;
const configuracionConexion = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'centro_tramites_daniel',
    port: Number(process.env.DB_PORT || 3306),
    timezone: zonaHorariaNegocio,
    ...(certificadoCa ? { ssl: { ca: certificadoCa } } : {})
};
const conexion = mysql.createConnection(configuracionConexion);

async function ejecutarTransaccion(operacion) {
    const conexionTransaccion = await mysql.createConnection(configuracionConexion);
    const db = conexionTransaccion.promise();
    let iniciada = false;
    try {
        await db.query(`SET time_zone = '${zonaHorariaNegocio}'`);
        await db.beginTransaction();
        iniciada = true;
        const resultado = await operacion(db);
        await db.commit();
        iniciada = false;
        return resultado;
    } catch (error) {
        if (iniciada) {
            try {
                await db.rollback();
            } catch (errorRollback) {
                console.error('No se pudo revertir la transacción contable:', errorRollback.message);
            }
        }
        throw error;
    } finally {
        await db.end();
    }
}

const metodosPagoPermitidos = ['Caja Física', 'Bancolombia', 'Nequi', 'Daviplata'];
const fuentesGastoPermitidas = [...metodosPagoPermitidos, 'Fondo físico mensual'];
const cuentasControlDiario = ['caja', 'fondo', 'bancolombia', 'nequi', 'otros_digitales'];

function clasificarCuenta(metodo) {
    const normalizado = String(metodo || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase();
    if (normalizado.includes('fondo')) return 'fondo';
    if (normalizado.includes('efectivo') || normalizado.includes('caja')) return 'caja';
    if (['banco', 'transfer', 'nequi', 'daviplata', 'pse', 'tarjeta'].some(term => normalizado.includes(term))) {
        return 'banco';
    }
    return null;
}

function cuentaControlDesdeMetodo(metodo) {
    const normalizado = String(metodo || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase();
    if (['caja fisica', 'efectivo'].includes(normalizado)) return 'caja';
    if (normalizado === 'fondo fisico mensual') return 'fondo';
    if (normalizado === 'bancolombia') return 'bancolombia';
    if (normalizado === 'nequi') return 'nequi';
    if (['daviplata', 'pse / tarjeta'].includes(normalizado)) return 'otros_digitales';
    return null;
}

function redondearMonto(monto) {
    return Math.round((monto + Number.EPSILON) * 100) / 100;
}

function crearResumenCuentas() {
    return Object.fromEntries(cuentasControlDiario.map(cuenta => [
        cuenta,
        {
            entradas: 0,
            salidas: 0,
            ventas: 0,
            pagosTramitadores: 0,
            pagosEntidades: 0,
            gastosLocal: 0,
            gastosPersonales: 0,
            trasladosEntrada: 0,
            trasladosSalida: 0,
            movimiento: 0
        }
    ]));
}

function registrarMovimientoCuenta(resumen, cuenta, tipo, categoria, monto) {
    if (!cuenta || !resumen[cuenta]) return false;
    resumen[cuenta][tipo] = redondearMonto(resumen[cuenta][tipo] + monto);
    resumen[cuenta][categoria] = redondearMonto(resumen[cuenta][categoria] + monto);
    resumen[cuenta].movimiento = redondearMonto(
        resumen[cuenta].entradas - resumen[cuenta].salidas
    );
    return true;
}

async function obtenerMovimientosCuentas(sedeId, fechaDesde, fechaHasta) {
    const resumen = crearResumenCuentas();
    let movimientosSinCuenta = 0;
    if (fechaDesde > fechaHasta) return { cuentas: resumen, movimientosSinCuenta };

    const [ventas] = await conexion.promise().query(
        `SELECT destino_fondos, metodo_pago_tramitador, metodo_pago_entidad,
                precio_tramite, precio_tramitador, pago_entidad
         FROM registro_ventas_completo v
         WHERE v.sede_id = ? AND v.fecha_hora >= ?
           AND v.fecha_hora < DATE_ADD(?, INTERVAL 1 DAY)
           AND NOT EXISTS (
               SELECT 1 FROM operaciones_anuladas a
               WHERE a.tipo = 'venta' AND a.operacion_id = v.id_registro
           )`,
        [sedeId, fechaDesde, fechaHasta]
    );
    const [gastos] = await conexion.promise().query(
        `SELECT fuente_pago, monto
         FROM gastos g
         WHERE g.sede_id = ? AND g.fecha >= ?
           AND g.fecha < DATE_ADD(?, INTERVAL 1 DAY)
           AND NOT EXISTS (
               SELECT 1 FROM operaciones_anuladas a
               WHERE a.tipo = 'gasto' AND a.operacion_id = g.id
           )`,
        [sedeId, fechaDesde, fechaHasta]
    );
    const [gastosPersonales] = await conexion.promise().query(
        `SELECT cuenta, monto
         FROM control_gastos_personales
         WHERE sede_id = ? AND fecha >= ? AND fecha < DATE_ADD(?, INTERVAL 1 DAY)`,
        [sedeId, fechaDesde, fechaHasta]
    );
    const [traslados] = await conexion.promise().query(
        `SELECT cuenta_origen, cuenta_destino, monto
         FROM control_traslados
         WHERE sede_id = ? AND fecha >= ? AND fecha < DATE_ADD(?, INTERVAL 1 DAY)`,
        [sedeId, fechaDesde, fechaHasta]
    );

    for (const venta of ventas) {
        const ingreso = Number(venta.precio_tramite) || 0;
        const cuentaIngreso = cuentaControlDesdeMetodo(venta.destino_fondos);
        if (!registrarMovimientoCuenta(resumen, cuentaIngreso, 'entradas', 'ventas', ingreso)) {
            movimientosSinCuenta += ingreso;
        }

        for (const [montoBruto, metodo, categoria] of [
            [venta.precio_tramitador, venta.metodo_pago_tramitador, 'pagosTramitadores'],
            [venta.pago_entidad, venta.metodo_pago_entidad, 'pagosEntidades']
        ]) {
            const monto = Number(montoBruto) || 0;
            if (!monto) continue;
            if (!registrarMovimientoCuenta(
                resumen,
                cuentaControlDesdeMetodo(metodo),
                'salidas',
                categoria,
                monto
            )) {
                movimientosSinCuenta += monto;
            }
        }
    }

    for (const gasto of gastos) {
        const monto = Number(gasto.monto) || 0;
        if (!registrarMovimientoCuenta(
            resumen,
            cuentaControlDesdeMetodo(gasto.fuente_pago),
            'salidas',
            'gastosLocal',
            monto
        )) {
            movimientosSinCuenta += monto;
        }
    }

    for (const gasto of gastosPersonales) {
        const monto = Number(gasto.monto) || 0;
        if (!registrarMovimientoCuenta(
            resumen,
            gasto.cuenta,
            'salidas',
            'gastosPersonales',
            monto
        )) {
            movimientosSinCuenta += monto;
        }
    }

    for (const traslado of traslados) {
        const monto = Number(traslado.monto) || 0;
        registrarMovimientoCuenta(
            resumen, traslado.cuenta_origen, 'salidas', 'trasladosSalida', monto
        );
        registrarMovimientoCuenta(
            resumen, traslado.cuenta_destino, 'entradas', 'trasladosEntrada', monto
        );
    }

    return { cuentas: resumen, movimientosSinCuenta: redondearMonto(movimientosSinCuenta) };
}

async function obtenerResumenContablePorRango(sedeId, fechaDesde, fechaHasta) {
    const [ventas] = await conexion.promise().query(
        `SELECT destino_fondos, metodo_pago_tramitador, metodo_pago_entidad,
                COALESCE(SUM(precio_tramite), 0) AS ingresos,
                COALESCE(SUM(precio_tramitador), 0) AS pagoTramitador,
                COALESCE(SUM(pago_entidad), 0) AS pagoEntidad
         FROM registro_ventas_completo v
         WHERE v.sede_id = ? AND v.fecha_hora >= ?
           AND v.fecha_hora < DATE_ADD(?, INTERVAL 1 DAY)
           AND NOT EXISTS (
               SELECT 1 FROM operaciones_anuladas a
               WHERE a.tipo = 'venta' AND a.operacion_id = v.id_registro
           )
         GROUP BY destino_fondos, metodo_pago_tramitador, metodo_pago_entidad`,
        [sedeId, fechaDesde, fechaHasta]
    );
    const [gastos] = await conexion.promise().query(
        `SELECT g.fuente_pago, COALESCE(SUM(g.monto), 0) AS monto
         FROM gastos g
         WHERE g.sede_id = ? AND g.fecha >= ?
           AND g.fecha < DATE_ADD(?, INTERVAL 1 DAY)
           AND NOT EXISTS (
               SELECT 1 FROM operaciones_anuladas a
               WHERE a.tipo = 'gasto' AND a.operacion_id = g.id
           )
         GROUP BY g.fuente_pago`,
        [sedeId, fechaDesde, fechaHasta]
    );

    const resumen = {
        totalIngresos: 0,
        ingresosCaja: 0,
        ingresosBanco: 0,
        ingresosSinClasificar: 0,
        gastosTramites: 0,
        gastosTramitesCaja: 0,
        gastosTramitesBanco: 0,
        gastosTramitesSinClasificar: 0,
        gastosLocal: 0,
        gastosLocalCaja: 0,
        gastosLocalFondo: 0,
        gastosLocalBanco: 0,
        gastosLocalSinClasificar: 0
    };

    for (const venta of ventas) {
        const ingreso = Number(venta.ingresos) || 0;
        const pagoTramitador = Number(venta.pagoTramitador) || 0;
        const pagoEntidad = Number(venta.pagoEntidad) || 0;
        resumen.totalIngresos += ingreso;
        resumen.gastosTramites += pagoTramitador + pagoEntidad;

        const cuentaIngreso = clasificarCuenta(venta.destino_fondos);
        if (cuentaIngreso === 'caja') resumen.ingresosCaja += ingreso;
        else if (cuentaIngreso === 'banco') resumen.ingresosBanco += ingreso;
        else resumen.ingresosSinClasificar += ingreso;

        for (const [monto, metodo] of [
            [pagoTramitador, venta.metodo_pago_tramitador],
            [pagoEntidad, venta.metodo_pago_entidad]
        ]) {
            const cuenta = clasificarCuenta(metodo);
            if (cuenta === 'caja') resumen.gastosTramitesCaja += monto;
            else if (cuenta === 'banco') resumen.gastosTramitesBanco += monto;
            else resumen.gastosTramitesSinClasificar += monto;
        }
    }

    for (const gasto of gastos) {
        const monto = Number(gasto.monto) || 0;
        resumen.gastosLocal += monto;
        const cuenta = clasificarCuenta(gasto.fuente_pago);
        if (cuenta === 'caja') resumen.gastosLocalCaja += monto;
        else if (cuenta === 'fondo') resumen.gastosLocalFondo += monto;
        else if (cuenta === 'banco') resumen.gastosLocalBanco += monto;
        else resumen.gastosLocalSinClasificar += monto;
    }

    resumen.utilidadNeta = resumen.totalIngresos - resumen.gastosTramites - resumen.gastosLocal;
    resumen.movimientoCaja = resumen.ingresosCaja - resumen.gastosTramitesCaja - resumen.gastosLocalCaja;
    resumen.movimientoBanco = resumen.ingresosBanco - resumen.gastosTramitesBanco - resumen.gastosLocalBanco;
    resumen.movimientoSinClasificar = resumen.ingresosSinClasificar
        - resumen.gastosTramitesSinClasificar - resumen.gastosLocalSinClasificar;
    return resumen;
}

async function obtenerResumenContableMensual(sedeId, periodo) {
    const [anio, mes] = periodo.split('-').map(Number);
    const ultimoDia = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
    return obtenerResumenContablePorRango(
        sedeId,
        `${periodo}-01`,
        `${periodo}-${String(ultimoDia).padStart(2, '0')}`
    );
}

async function obtenerSaldosIniciales(sedeId, periodo) {
    const [rows] = await conexion.promise().query(
        'SELECT cuenta, monto FROM saldos_iniciales WHERE sede_id = ? AND periodo = ?',
        [sedeId, periodo]
    );
    const saldos = rows.reduce((resultado, fila) => {
        resultado[fila.cuenta] = Number(fila.monto) || 0;
        return resultado;
    }, { caja: 0, banco: 0 });
    const cuentasSinApertura = ['caja', 'banco'].filter(cuenta =>
        !rows.some(fila => fila.cuenta === cuenta)
    );
    if (!cuentasSinApertura.length) return saldos;

    const inicioPeriodo = `${periodo}-01`;
    const fechaAnterior = sumarDias(inicioPeriodo, -1);
    const [[cierreAnterior]] = await conexion.promise().query(
        `SELECT DATE_FORMAT(fecha, '%Y-%m-%d') AS fecha, contado_caja, contado_banco
         FROM cierres_diarios
         WHERE sede_id = ? AND fecha < ?
         ORDER BY fecha DESC LIMIT 1`,
        [sedeId, inicioPeriodo]
    );
    if (!cierreAnterior) return saldos;

    let saldoArrastrado = {
        caja: Number(cierreAnterior.contado_caja) || 0,
        banco: Number(cierreAnterior.contado_banco) || 0
    };
    const fechaDesdeMovimientos = sumarDias(cierreAnterior.fecha, 1);
    if (fechaDesdeMovimientos <= fechaAnterior) {
        const movimientos = await obtenerResumenContablePorRango(
            sedeId,
            fechaDesdeMovimientos,
            fechaAnterior
        );
        saldoArrastrado = {
            caja: redondearMonto(saldoArrastrado.caja + movimientos.movimientoCaja),
            banco: redondearMonto(saldoArrastrado.banco + movimientos.movimientoBanco)
        };
    }
    for (const cuenta of cuentasSinApertura) saldos[cuenta] = saldoArrastrado[cuenta];
    return saldos;
}

async function obtenerSaldosFinalesMensuales(sedeId, periodo, resumenMensual) {
    const [anio, mes] = periodo.split('-').map(Number);
    const ultimoDia = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
    const fechaInicio = `${periodo}-01`;
    const fechaFin = `${periodo}-${String(ultimoDia).padStart(2, '0')}`;
    const [[hoyRow]] = await conexion.promise().query(
        "SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS hoy"
    );
    const fechaCorte = fechaFin < hoyRow.hoy ? fechaFin : hoyRow.hoy;
    const [aperturasControl] = await conexion.promise().query(
        `SELECT cuenta, DATE_FORMAT(fecha_inicio, '%Y-%m-%d') AS fecha_inicio
         FROM control_saldos_iniciales WHERE sede_id = ?`,
        [sedeId]
    );
    const fechaInicioControl = aperturasControl[0]?.fecha_inicio;
    const controlDiarioDisponible = aperturasControl.length === cuentasControlDiario.length
        && new Set(aperturasControl.map(apertura => apertura.fecha_inicio)).size === 1
        && cuentasControlDiario.every(cuenta =>
            aperturasControl.some(apertura => apertura.cuenta === cuenta)
        )
        && fechaCorte >= fechaInicioControl;

    if (controlDiarioDisponible) {
        const proyeccion = await obtenerProyeccionControlDiario(sedeId, fechaCorte);
        if (proyeccion.configurado && !proyeccion.fechaAnteriorAlInicio) {
            const cuentaCaja = proyeccion.cuentas.caja;
            const caja = proyeccion.arqueoCaja
                ? proyeccion.arqueoCaja.baseSiguiente
                : cuentaCaja.contado === null ? cuentaCaja.esperado : cuentaCaja.contado;
            const obtenerSaldoCuenta = cuenta => {
                const saldo = proyeccion.cuentas[cuenta];
                return saldo.contado === null ? saldo.esperado : saldo.contado;
            };
            const fondo = obtenerSaldoCuenta('fondo');
            const banco = redondearMonto(
                obtenerSaldoCuenta('bancolombia')
                + obtenerSaldoCuenta('nequi')
                + obtenerSaldoCuenta('otros_digitales')
            );
            const [[ultimoCierre]] = await conexion.promise().query(
                `SELECT DATE_FORMAT(MAX(fecha), '%Y-%m-%d') AS fecha
                 FROM control_cierres_diarios
                 WHERE sede_id = ? AND fecha >= ? AND fecha <= ?`,
                [sedeId, fechaInicioControl, fechaCorte]
            );
            const saldoEfectivo = redondearMonto(caja + fondo);
            return {
                caja: saldoEfectivo,
                banco,
                saldoContableCaja: saldoEfectivo,
                saldoContableBanco: banco,
                fechaUltimoCierre: ultimoCierre.fecha || null,
                origen: 'control_diario',
                fechaCorte
            };
        }
    }

    const saldosIniciales = await obtenerSaldosIniciales(sedeId, periodo);
    const saldoContableCaja = redondearMonto(saldosIniciales.caja + resumenMensual.movimientoCaja);
    const saldoContableBanco = redondearMonto(saldosIniciales.banco + resumenMensual.movimientoBanco);
    const [[cierre]] = await conexion.promise().query(
        `SELECT DATE_FORMAT(fecha, '%Y-%m-%d') AS fecha, contado_caja, contado_banco
         FROM cierres_diarios
         WHERE sede_id = ? AND fecha >= ? AND fecha <= ?
         ORDER BY fecha DESC LIMIT 1`,
        [sedeId, fechaInicio, fechaFin]
    );

    if (!cierre) {
        return {
            caja: saldoContableCaja,
            banco: saldoContableBanco,
            saldoContableCaja,
            saldoContableBanco,
            fechaUltimoCierre: null,
            origen: 'historico',
            fechaCorte
        };
    }

    const fechaDesdeMovimientos = sumarDias(cierre.fecha, 1);
    let movimientosPosteriores = { movimientoCaja: 0, movimientoBanco: 0 };
    if (fechaDesdeMovimientos <= fechaFin) {
        movimientosPosteriores = await obtenerResumenContablePorRango(
            sedeId,
            fechaDesdeMovimientos,
            fechaFin
        );
    }
    return {
        caja: redondearMonto(Number(cierre.contado_caja) + movimientosPosteriores.movimientoCaja),
        banco: redondearMonto(Number(cierre.contado_banco) + movimientosPosteriores.movimientoBanco),
        saldoContableCaja,
        saldoContableBanco,
        fechaUltimoCierre: cierre.fecha,
        origen: 'historico',
        fechaCorte
    };
}

function esFechaCalendarioValida(fecha) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return false;
    const fechaUtc = new Date(`${fecha}T00:00:00.000Z`);
    return Number.isFinite(fechaUtc.getTime()) && fechaUtc.toISOString().slice(0, 10) === fecha;
}

function sumarDias(fecha, cantidad) {
    const fechaUtc = new Date(`${fecha}T00:00:00.000Z`);
    fechaUtc.setUTCDate(fechaUtc.getUTCDate() + cantidad);
    return fechaUtc.toISOString().slice(0, 10);
}

async function obtenerProyeccionCierreDiario(sedeId, fecha) {
    const periodo = fecha.slice(0, 7);
    const aperturaMensual = await obtenerSaldosIniciales(sedeId, periodo);
    const fechaInicioMes = `${periodo}-01`;
    const fechaAnterior = sumarDias(fecha, -1);
    const [[cierreAnterior]] = await conexion.promise().query(
        `SELECT DATE_FORMAT(fecha, '%Y-%m-%d') AS fecha,
                contado_caja, contado_banco
         FROM cierres_diarios
         WHERE sede_id = ? AND fecha >= ? AND fecha < ?
         ORDER BY fecha DESC LIMIT 1`,
        [sedeId, fechaInicioMes, fecha]
    );

    let aperturaCaja = aperturaMensual.caja;
    let aperturaBanco = aperturaMensual.banco;
    let fechaDesdeMovimientos = fechaInicioMes;
    if (cierreAnterior) {
        aperturaCaja = Number(cierreAnterior.contado_caja) || 0;
        aperturaBanco = Number(cierreAnterior.contado_banco) || 0;
        fechaDesdeMovimientos = sumarDias(cierreAnterior.fecha, 1);
    }

    if (fechaDesdeMovimientos <= fechaAnterior) {
        const movimientosPrevios = await obtenerResumenContablePorRango(
            sedeId,
            fechaDesdeMovimientos,
            fechaAnterior
        );
        aperturaCaja = redondearMonto(aperturaCaja + movimientosPrevios.movimientoCaja);
        aperturaBanco = redondearMonto(aperturaBanco + movimientosPrevios.movimientoBanco);
    }

    const [movimientosHoy, cierresGuardados] = await Promise.all([
        obtenerResumenContablePorRango(sedeId, fecha, fecha),
        conexion.promise().query(
            `SELECT apertura_caja, esperado_caja, contado_caja, diferencia_caja,
                    apertura_banco, esperado_banco, contado_banco, diferencia_banco,
                    motivo, usuario, DATE_FORMAT(cerrado_en, '%Y-%m-%d %H:%i:%s') AS cerrado_en
             FROM cierres_diarios WHERE sede_id = ? AND fecha = ?`,
            [sedeId, fecha]
        )
    ]);
    const [cierres] = cierresGuardados;
    const guardado = cierres[0];
    if (guardado) {
        const esperadoCaja = redondearMonto(aperturaCaja + movimientosHoy.movimientoCaja);
        const esperadoBanco = redondearMonto(aperturaBanco + movimientosHoy.movimientoBanco);
        const contadoCaja = Number(guardado.contado_caja);
        const contadoBanco = Number(guardado.contado_banco);
        return {
            fecha,
            cierreRegistrado: true,
            caja: {
                apertura: aperturaCaja,
                esperado: esperadoCaja,
                contado: contadoCaja,
                diferencia: redondearMonto(contadoCaja - esperadoCaja)
            },
            banco: {
                apertura: aperturaBanco,
                esperado: esperadoBanco,
                contado: contadoBanco,
                diferencia: redondearMonto(contadoBanco - esperadoBanco)
            },
            motivo: guardado.motivo,
            usuario: guardado.usuario,
            cerradoEn: guardado.cerrado_en
        };
    }

    return {
        fecha,
        cierreRegistrado: false,
        caja: {
            apertura: aperturaCaja,
            movimiento: movimientosHoy.movimientoCaja,
            esperado: redondearMonto(aperturaCaja + movimientosHoy.movimientoCaja),
            contado: null,
            diferencia: null
        },
        banco: {
            apertura: aperturaBanco,
            movimiento: movimientosHoy.movimientoBanco,
            esperado: redondearMonto(aperturaBanco + movimientosHoy.movimientoBanco),
            contado: null,
            diferencia: null
        },
        motivo: '',
        usuario: '',
        cerradoEn: null
    };
}

const etiquetasCuentasControl = {
    caja: 'Caja diaria',
    fondo: 'Fondo físico mensual',
    bancolombia: 'Bancolombia',
    nequi: 'Nequi',
    otros_digitales: 'Otros medios digitales (Daviplata/PSE)'
};

async function obtenerProyeccionControlDiario(sedeId, fecha) {
    const [aperturas] = await conexion.promise().query(
        `SELECT cuenta, DATE_FORMAT(fecha_inicio, '%Y-%m-%d') AS fecha_inicio, saldo
         FROM control_saldos_iniciales WHERE sede_id = ?`,
        [sedeId]
    );
    const aperturaPorCuenta = new Map(aperturas.map(row => [row.cuenta, row]));
    if (aperturas.length !== cuentasControlDiario.length
        || !cuentasControlDiario.every(cuenta => aperturaPorCuenta.has(cuenta))) {
        return { configurado: false, cuentas: [] };
    }

    const fechaInicio = aperturas[0].fecha_inicio;
    const saldosIniciales = Object.fromEntries(
        aperturas.map(apertura => [
            apertura.cuenta,
            {
                etiqueta: etiquetasCuentasControl[apertura.cuenta],
                saldo: Number(apertura.saldo) || 0
            }
        ])
    );
    if (fecha < fechaInicio) {
        return {
            configurado: true,
            fechaInicio,
            fechaAnteriorAlInicio: true,
            saldosIniciales,
            cuentas: []
        };
    }

    const [cierresAnteriores] = await conexion.promise().query(
        `SELECT DATE_FORMAT(c.fecha, '%Y-%m-%d') AS fecha, c.cuenta, c.contado,
                arqueo.base_siguiente
         FROM control_cierres_diarios c
         LEFT JOIN control_arqueos_caja arqueo
           ON arqueo.sede_id = c.sede_id AND arqueo.fecha = c.fecha AND c.cuenta = 'caja'
         JOIN (
             SELECT cuenta, MAX(fecha) AS fecha
             FROM control_cierres_diarios
             WHERE sede_id = ? AND fecha < ?
             GROUP BY cuenta
         ) ultimo ON ultimo.cuenta = c.cuenta AND ultimo.fecha = c.fecha
         WHERE c.sede_id = ?
         ORDER BY c.fecha DESC`,
        [sedeId, fecha, sedeId]
    );
    const cierrePorCuenta = new Map();
    for (const cierre of cierresAnteriores) {
        if (!cierrePorCuenta.has(cierre.cuenta)) cierrePorCuenta.set(cierre.cuenta, cierre);
    }

    const fechaAyer = sumarDias(fecha, -1);
    const fechaUltimoCierre = cierresAnteriores[0]?.fecha || null;
    const fechaDesdePendientes = fechaUltimoCierre
        ? sumarDias(fechaUltimoCierre, 1)
        : fechaInicio;
    const [movimientosPrevios, movimientosHoy, cierresHoy, trasladosHoy, arqueosHoy, gastosPersonalesHoy] = await Promise.all([
        obtenerMovimientosCuentas(sedeId, fechaDesdePendientes, fechaAyer),
        obtenerMovimientosCuentas(sedeId, fecha, fecha),
        conexion.promise().query(
            `SELECT cuenta, contado, motivo, usuario,
                    DATE_FORMAT(cerrado_en, '%Y-%m-%d %H:%i:%s') AS cerrado_en
             FROM control_cierres_diarios WHERE sede_id = ? AND fecha = ?`,
            [sedeId, fecha]
        ),
        conexion.promise().query(
            `SELECT cuenta_origen, cuenta_destino, monto, descripcion, usuario
             FROM control_traslados WHERE sede_id = ? AND fecha = ? ORDER BY id`,
            [sedeId, fecha]
        ),
        conexion.promise().query(
            `SELECT contado_fisico, base_siguiente, producido_retirado,
                    esperado, diferencia, usuario,
                    DATE_FORMAT(actualizado_en, '%Y-%m-%d %H:%i:%s') AS actualizado_en
             FROM control_arqueos_caja WHERE sede_id = ? AND fecha = ?`,
            [sedeId, fecha]
        ),
        conexion.promise().query(
            `SELECT cuenta, monto, descripcion, usuario,
                    DATE_FORMAT(creado_en, '%Y-%m-%d %H:%i:%s') AS creado_en
             FROM control_gastos_personales
             WHERE sede_id = ? AND fecha = ? ORDER BY id`,
            [sedeId, fecha]
        )
    ]);
    const [cierresGuardados] = cierresHoy;
    const [trasladosDelDia] = trasladosHoy;
    const [arqueosDeCaja] = arqueosHoy;
    const arqueoDelDia = arqueosDeCaja[0] || null;
    const [gastosPersonalesDelDia] = gastosPersonalesHoy;
    const cierreHoyPorCuenta = new Map(cierresGuardados.map(row => [row.cuenta, row]));
    const cuentas = {};
    for (const cuenta of cuentasControlDiario) {
        const aperturaInicial = aperturaPorCuenta.get(cuenta);
        const cierreAnterior = cierrePorCuenta.get(cuenta);
        let apertura = Number(aperturaInicial.saldo) || 0;
        let desde = aperturaInicial.fecha_inicio;
        if (cierreAnterior) {
            apertura = Number(
                cuenta === 'caja' && cierreAnterior.base_siguiente !== null
                    ? cierreAnterior.base_siguiente
                    : cierreAnterior.contado
            ) || 0;
            desde = sumarDias(cierreAnterior.fecha, 1);
        }

        if (desde <= fechaAyer) {
            apertura = redondearMonto(
                apertura + movimientosPrevios.cuentas[cuenta].movimiento
            );
        }
        const esperado = redondearMonto(
            apertura + movimientosHoy.cuentas[cuenta].movimiento
        );
        const movimientosCuenta = movimientosHoy.cuentas[cuenta];
        const cierreHoy = cierreHoyPorCuenta.get(cuenta);
        const contado = cierreHoy ? Number(cierreHoy.contado) : null;
        cuentas[cuenta] = {
            etiqueta: etiquetasCuentasControl[cuenta],
            apertura,
            entradas: movimientosCuenta.entradas,
            salidas: movimientosCuenta.salidas,
            ventas: movimientosCuenta.ventas,
            pagosTramitadores: movimientosCuenta.pagosTramitadores,
            pagosEntidades: movimientosCuenta.pagosEntidades,
            gastosLocal: movimientosCuenta.gastosLocal,
            gastosPersonales: movimientosCuenta.gastosPersonales,
            trasladosEntrada: movimientosCuenta.trasladosEntrada,
            trasladosSalida: movimientosCuenta.trasladosSalida,
            esperado,
            contado,
            diferencia: contado === null ? null : redondearMonto(contado - esperado)
        };
    }

    return {
        configurado: true,
        fechaInicio,
        fechaAnteriorAlInicio: false,
        cierreRegistrado: cierresGuardados.length > 0,
        cierreCompleto: cuentasControlDiario.every(cuenta => cierreHoyPorCuenta.has(cuenta)),
        cuentas,
        traslados: trasladosDelDia.map(traslado => ({
            origen: etiquetasCuentasControl[traslado.cuenta_origen] || traslado.cuenta_origen,
            destino: etiquetasCuentasControl[traslado.cuenta_destino] || traslado.cuenta_destino,
            monto: Number(traslado.monto),
            descripcion: traslado.descripcion,
            usuario: traslado.usuario
        })),
        movimientosSinCuenta: redondearMonto(
            movimientosPrevios.movimientosSinCuenta + movimientosHoy.movimientosSinCuenta
        ),
        usuario: cierresGuardados[0]?.usuario || '',
        motivo: cierresGuardados[0]?.motivo || '',
        cerradoEn: cierresGuardados[0]?.cerrado_en || '',
        arqueoCaja: arqueoDelDia ? {
            contadoFisico: Number(arqueoDelDia.contado_fisico),
            baseSiguiente: Number(arqueoDelDia.base_siguiente),
            producidoRetirado: Number(arqueoDelDia.producido_retirado),
            esperado: Number(arqueoDelDia.esperado),
            diferencia: Number(arqueoDelDia.diferencia),
            usuario: arqueoDelDia.usuario,
            actualizadoEn: arqueoDelDia.actualizado_en
        } : null,
        gastosPersonales: gastosPersonalesDelDia.map(gasto => ({
            cuenta: gasto.cuenta,
            etiqueta: etiquetasCuentasControl[gasto.cuenta] || gasto.cuenta,
            monto: Number(gasto.monto),
            descripcion: gasto.descripcion,
            usuario: gasto.usuario,
            creadoEn: gasto.creado_en
        }))
    };
}

class MySQLSessionStore extends session.Store {
    constructor(connection) {
        super();
        this.connection = connection.promise();
    }

    onReady() {
        return this.connection.query(
            `CREATE TABLE IF NOT EXISTS express_sessions (
                session_id VARCHAR(128) NOT NULL PRIMARY KEY,
                expires BIGINT UNSIGNED NOT NULL,
                data MEDIUMTEXT NOT NULL,
                INDEX idx_express_sessions_expires (expires)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        ).then(() => this.connection.query(
            'DELETE FROM express_sessions WHERE expires <= ?',
            [Date.now()]
        )).then(() => this.connection.query(
            `CREATE TABLE IF NOT EXISTS operaciones_anuladas (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                tipo VARCHAR(20) NOT NULL,
                operacion_id BIGINT UNSIGNED NOT NULL,
                sede_id INT NOT NULL,
                motivo VARCHAR(500) NOT NULL,
                usuario VARCHAR(150) NOT NULL,
                anulada_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uq_operacion_anulada (tipo, operacion_id),
                INDEX idx_anuladas_sede_fecha (sede_id, anulada_en)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        )).then(() => this.connection.query(
            `CREATE TABLE IF NOT EXISTS saldos_iniciales (
                sede_id INT NOT NULL,
                periodo CHAR(7) NOT NULL,
                cuenta VARCHAR(10) NOT NULL,
                monto DECIMAL(12,2) NOT NULL DEFAULT 0,
                actualizado_por VARCHAR(150) NOT NULL,
                actualizado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (sede_id, periodo, cuenta)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        )).then(() => this.connection.query(
            `CREATE TABLE IF NOT EXISTS auditoria_saldos_iniciales (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                sede_id INT NOT NULL,
                periodo CHAR(7) NOT NULL,
                cuenta VARCHAR(10) NOT NULL,
                monto_anterior DECIMAL(12,2) NOT NULL,
                monto_nuevo DECIMAL(12,2) NOT NULL,
                motivo VARCHAR(500) NOT NULL,
                usuario VARCHAR(150) NOT NULL,
                cambiado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_auditoria_saldos (sede_id, periodo, cambiado_en)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        )).then(() => this.connection.query(
            `CREATE TABLE IF NOT EXISTS cierres_diarios (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                sede_id INT NOT NULL,
                fecha DATE NOT NULL,
                apertura_caja DECIMAL(12,2) NOT NULL,
                esperado_caja DECIMAL(12,2) NOT NULL,
                contado_caja DECIMAL(12,2) NOT NULL,
                diferencia_caja DECIMAL(12,2) NOT NULL,
                apertura_banco DECIMAL(12,2) NOT NULL,
                esperado_banco DECIMAL(12,2) NOT NULL,
                contado_banco DECIMAL(12,2) NOT NULL,
                diferencia_banco DECIMAL(12,2) NOT NULL,
                motivo VARCHAR(500) NOT NULL,
                usuario VARCHAR(150) NOT NULL,
                cerrado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uq_cierre_diario_sede_fecha (sede_id, fecha),
                INDEX idx_cierres_diarios_fecha (fecha)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        )).then(() => this.connection.query(
            `CREATE TABLE IF NOT EXISTS auditoria_cierres_diarios (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                sede_id INT NOT NULL,
                fecha DATE NOT NULL,
                contado_caja_anterior DECIMAL(12,2) NULL,
                contado_caja_nuevo DECIMAL(12,2) NOT NULL,
                contado_banco_anterior DECIMAL(12,2) NULL,
                contado_banco_nuevo DECIMAL(12,2) NOT NULL,
                motivo VARCHAR(500) NOT NULL,
                usuario VARCHAR(150) NOT NULL,
                cambiado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_auditoria_cierres_sede_fecha (sede_id, fecha, cambiado_en)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        )).then(() => this.connection.query(
            `CREATE TABLE IF NOT EXISTS control_saldos_iniciales (
                sede_id INT NOT NULL,
                cuenta VARCHAR(32) NOT NULL,
                fecha_inicio DATE NOT NULL,
                saldo DECIMAL(12,2) NOT NULL,
                usuario VARCHAR(150) NOT NULL,
                creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (sede_id, cuenta),
                INDEX idx_control_saldos_fecha (sede_id, fecha_inicio)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        )).then(() => this.connection.query(
            `CREATE TABLE IF NOT EXISTS control_traslados (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                sede_id INT NOT NULL,
                fecha DATE NOT NULL,
                cuenta_origen VARCHAR(32) NOT NULL,
                cuenta_destino VARCHAR(32) NOT NULL,
                monto DECIMAL(12,2) NOT NULL,
                descripcion VARCHAR(300) NOT NULL,
                usuario VARCHAR(150) NOT NULL,
                creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_control_traslados_sede_fecha (sede_id, fecha)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        )).then(() => this.connection.query(
            `CREATE TABLE IF NOT EXISTS control_cierres_diarios (
                sede_id INT NOT NULL,
                fecha DATE NOT NULL,
                cuenta VARCHAR(32) NOT NULL,
                apertura DECIMAL(12,2) NOT NULL,
                esperado DECIMAL(12,2) NOT NULL,
                contado DECIMAL(12,2) NOT NULL,
                diferencia DECIMAL(12,2) NOT NULL,
                motivo VARCHAR(500) NOT NULL,
                usuario VARCHAR(150) NOT NULL,
                cerrado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (sede_id, fecha, cuenta),
                INDEX idx_control_cierres_fecha (fecha)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        )).then(() => this.connection.query(
            `CREATE TABLE IF NOT EXISTS auditoria_control_cierres (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                sede_id INT NOT NULL,
                fecha DATE NOT NULL,
                cuenta VARCHAR(32) NOT NULL,
                contado_anterior DECIMAL(12,2) NULL,
                contado_nuevo DECIMAL(12,2) NOT NULL,
                motivo VARCHAR(500) NOT NULL,
                usuario VARCHAR(150) NOT NULL,
                cambiado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_auditoria_control_fecha (sede_id, fecha, cambiado_en)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        )).then(() => this.connection.query(
            `CREATE TABLE IF NOT EXISTS auditoria_control_aperturas (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                sede_id INT NOT NULL,
                fecha_anterior DATE NOT NULL,
                fecha_nueva DATE NOT NULL,
                usuario VARCHAR(150) NOT NULL,
                cambiado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_auditoria_aperturas_sede_fecha (sede_id, cambiado_en)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        )).then(() => this.connection.query(
            `CREATE TABLE IF NOT EXISTS control_arqueos_caja (
                sede_id INT NOT NULL,
                fecha DATE NOT NULL,
                contado_fisico DECIMAL(12,2) NOT NULL,
                base_siguiente DECIMAL(12,2) NOT NULL,
                producido_retirado DECIMAL(12,2) NOT NULL,
                esperado DECIMAL(12,2) NOT NULL,
                diferencia DECIMAL(12,2) NOT NULL,
                usuario VARCHAR(150) NOT NULL,
                actualizado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (sede_id, fecha),
                INDEX idx_control_arqueos_fecha (fecha)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        )).then(() => this.connection.query(
            `CREATE TABLE IF NOT EXISTS auditoria_control_arqueos_caja (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                sede_id INT NOT NULL,
                fecha DATE NOT NULL,
                contado_anterior DECIMAL(12,2) NULL,
                contado_nuevo DECIMAL(12,2) NOT NULL,
                base_anterior DECIMAL(12,2) NULL,
                base_nueva DECIMAL(12,2) NOT NULL,
                retirado_anterior DECIMAL(12,2) NULL,
                retirado_nuevo DECIMAL(12,2) NOT NULL,
                esperado DECIMAL(12,2) NOT NULL,
                diferencia DECIMAL(12,2) NOT NULL,
                motivo VARCHAR(500) NOT NULL,
                usuario VARCHAR(150) NOT NULL,
                cambiado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_auditoria_arqueo_sede_fecha (sede_id, fecha, cambiado_en)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        )).then(() => this.connection.query(
            `CREATE TABLE IF NOT EXISTS control_gastos_personales (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                sede_id INT NOT NULL,
                fecha DATE NOT NULL,
                cuenta VARCHAR(32) NOT NULL,
                monto DECIMAL(12,2) NOT NULL,
                descripcion VARCHAR(300) NOT NULL,
                usuario VARCHAR(150) NOT NULL,
                creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_control_gastos_personales_sede_fecha (sede_id, fecha)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
        )).then(() => {
            const cleanup = setInterval(() => {
                this.connection.query('DELETE FROM express_sessions WHERE expires <= ?', [Date.now()])
                    .catch(error => console.error('No se pudieron limpiar las sesiones vencidas:', error.message));
            }, 15 * 60 * 1000);
            cleanup.unref();
        });
    }

    get(sessionId, callback) {
        this.connection.query(
            'SELECT data FROM express_sessions WHERE session_id = ? AND expires > ?',
            [sessionId, Date.now()]
        ).then(([rows]) => {
            if (!rows.length) return callback(null, null);
            callback(null, JSON.parse(rows[0].data));
        }).catch(callback);
    }

    set(sessionId, sessionData, callback = () => {}) {
        const expires = sessionData.cookie?.expires
            ? new Date(sessionData.cookie.expires).getTime()
            : Date.now() + 8 * 60 * 60 * 1000;
        this.connection.query(
            `INSERT INTO express_sessions (session_id, expires, data) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE expires = VALUES(expires), data = VALUES(data)`,
            [sessionId, expires, JSON.stringify(sessionData)]
        ).then(() => callback(null)).catch(callback);
    }

    touch(sessionId, sessionData, callback = () => {}) {
        const expires = sessionData.cookie?.expires
            ? new Date(sessionData.cookie.expires).getTime()
            : Date.now() + 8 * 60 * 60 * 1000;
        this.connection.query(
            'UPDATE express_sessions SET expires = ? WHERE session_id = ?',
            [expires, sessionId]
        ).then(() => callback(null)).catch(callback);
    }

    destroy(sessionId, callback = () => {}) {
        this.connection.query('DELETE FROM express_sessions WHERE session_id = ?', [sessionId])
            .then(() => callback(null)).catch(callback);
    }

    clear(callback = () => {}) {
        this.connection.query('DELETE FROM express_sessions')
            .then(() => callback(null)).catch(callback);
    }

    length(callback) {
        this.connection.query('SELECT COUNT(*) AS total FROM express_sessions')
            .then(([rows]) => callback(null, Number(rows[0].total))).catch(callback);
    }
}

const sessionStore = new MySQLSessionStore(conexion);

app.use(session({
    name: 'rdg.sid',
    secret: sessionSecret,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: modoProduccion,
        sameSite: 'lax',
        maxAge: 8 * 60 * 60 * 1000
    }
}));

// Reject cross-site browser requests that could mutate the authenticated session.
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        try {
            if (new URL(origin).host !== req.get('host')) {
                return res.status(403).json({ exito: false, mensaje: 'Origen de solicitud no permitido.' });
            }
        } catch {
            return res.status(403).json({ exito: false, mensaje: 'Origen de solicitud no válido.' });
        }
    }
    next();
});

// ==========================================
// 3. SEGURIDAD Y PROTECCIÓN DE RUTAS HTML
// ==========================================
function verificarAutenticacion(req, res, next) {
    if (req.session && req.session.usuarioAutorizado) {
        return next();
    }
    if (req.path.startsWith('/api')) {
        return res.status(401).json({ exito: false, mensaje: 'Inicia sesión para continuar.' });
    }
    res.redirect('login.html');
}

function verificarAdministrador(req, res, next) {
    if (req.session?.rolUsuario === 'ADMINISTRADOR') {
        return next();
    }
    if (req.path.startsWith('/api')) {
        return res.status(403).json({ exito: false, mensaje: 'Esta función está disponible solo para el administrador.' });
    }
    res.status(403).send('Acceso exclusivo para el administrador.');
}

app.get('/', verificarAutenticacion, (req, res) => res.sendFile(__dirname + '/menu.html'));
app.get('/consola.html', verificarAutenticacion, (req, res) => res.sendFile(__dirname + '/consola.html'));
app.get('/panel.html', verificarAutenticacion, (req, res) => res.sendFile(__dirname + '/panel.html'));
app.get('/menu.html', verificarAutenticacion, (req, res) => res.sendFile(__dirname + '/menu.html'));
app.get('/control-tramites', verificarAutenticacion, (req, res) => res.sendFile(__dirname + '/tramites.html'));
app.get('/reporte-diario', verificarAutenticacion, verificarAdministrador, (req, res) => res.sendFile(__dirname + '/reporte.html'));
app.get('/balance-mensual', verificarAutenticacion, verificarAdministrador, (req, res) => res.sendFile(__dirname + '/balance.html'));
app.get('/seleccionar-sede', verificarAutenticacion, (req, res) => res.sendFile(path.join(__dirname, 'sedes.html')));
app.get('/ingresos_gastos.php', (req, res) => {
    res.redirect(301, '/ingresos-gastos.html');
});
app.get('/ingresos-gastos.html', verificarAutenticacion, verificarAdministrador, (req, res) => {
    res.sendFile(path.join(__dirname, 'ingresos_gastos.html'));
});

// Do not serve source-like templates or private files through Express static hosting.
app.use((req, res, next) => {
    if (req.path.toLowerCase().endsWith('.php')) {
        return res.sendStatus(404);
    }
    if (!req.path.toLowerCase().endsWith('.html') || req.path.toLowerCase().endsWith('/login.html')) {
        return next();
    }
    verificarAutenticacion(req, res, () => {
        const pagina = path.basename(req.path).toLowerCase();
        if (['balance.html', 'reporte.html', 'control_diario.html'].includes(pagina)) {
            return verificarAdministrador(req, res, next);
        }
        next();
    });
});

app.use('/api', (req, res, next) => {
    if (req.session?.usuarioAutorizado) return next();
    res.status(401).json({ exito: false, mensaje: 'Inicia sesión para continuar.' });
});

app.post('/api/sede-activa', (req, res) => {
    const sedeId = String(req.body.sedeId || '');
    if (!['1', '2'].includes(sedeId)) {
        return res.status(400).json({ exito: false, mensaje: 'Selecciona una sede válida.' });
    }
    req.session.sedeActivaId = sedeId;
    res.json({ exito: true, sedeId });
});

app.use('/api', (req, res, next) => {
    if (req.path === '/sede-activa' || req.path === '/sesion') return next();
    if (!['1', '2'].includes(String(req.session.sedeActivaId))) {
        return res.status(409).json({ exito: false, mensaje: 'Selecciona una sede antes de continuar.' });
    }
    req.query.sedeId = req.session.sedeActivaId;
    if (req.body && typeof req.body === 'object') {
        req.body.sedeId = req.session.sedeActivaId;
    }
    next();
});

app.get('/api/sesion', (req, res) => {
    res.json({
        exito: true,
        nombre: req.session.nombreUsuario,
        rol: req.session.rolUsuario,
        sedeId: req.session.sedeActivaId || null
    });
});

// ==========================================
// 4. GESTIÓN DE LOGIN Y SESIÓN
// ==========================================
app.get('/login.html', (req, res) => res.sendFile(__dirname + '/login.html'));
app.get('/login', (req, res) => res.redirect('login.html'));

const intentosLogin = new Map();
function limitarIntentosLogin(req, res, next) {
    const ip = req.ip;
    const ahora = Date.now();
    const intento = intentosLogin.get(ip);
    if (intento?.bloqueadoHasta > ahora) {
        return res.status(429).send('Demasiados intentos. Espera 15 minutos e inténtalo nuevamente.');
    }
    if (!intento && intentosLogin.size >= 5000) {
        intentosLogin.delete(intentosLogin.keys().next().value);
    }
    req.registrarFalloLogin = () => {
        const fallos = intento && intento.iniciaVentana > ahora ? intento.fallos + 1 : 1;
        intentosLogin.set(ip, {
            fallos,
            iniciaVentana: intento?.iniciaVentana > ahora ? intento.iniciaVentana : ahora + 15 * 60 * 1000,
            bloqueadoHasta: fallos >= 10 ? ahora + 15 * 60 * 1000 : 0
        });
    };
    req.registrarExitoLogin = () => intentosLogin.delete(ip);
    next();
}

app.post('/login', limitarIntentosLogin, (req, res) => {
    if (!req.body || Object.keys(req.body).length === 0) {
        return res.redirect('/login.html');
    }
    const usuarioInput = req.body.usuario;
    const contrasenaInput = req.body.contrasena;

    if (!usuarioInput || !contrasenaInput) {
        return res.redirect('/login.html');
    }

    const usuarioEncontrado = usuariosRD.find(usuario =>
        usuario.usuario === String(usuarioInput).trim() &&
        usuario.contrasena === String(contrasenaInput)
    );

    if (usuarioEncontrado) {
        req.registrarExitoLogin();
        return req.session.regenerate(error => {
            if (error) {
                console.error('Error al crear la sesión del usuario:', error);
                return res.status(500).send('No se pudo iniciar la sesión.');
            }
            req.session.usuarioAutorizado = true;
            req.session.nombreUsuario = usuarioEncontrado.nombre_real;
            req.session.rolUsuario = usuarioEncontrado.rol;
            req.session.save(errorAlGuardar => {
                if (errorAlGuardar) {
                    console.error('Error al guardar la sesión del usuario:', errorAlGuardar);
                    return res.status(500).send('No se pudo iniciar la sesión.');
                }
                res.redirect('seleccionar-sede');
            });
        });
    } else {
        req.registrarFalloLogin();
        return res.status(401).send("<script>alert('Usuario o contraseña incorrectos.'); window.location.href='login.html';</script>");
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(error => {
        if (error) {
            console.error('Error al cerrar la sesión:', error);
            return res.status(500).send('No se pudo cerrar la sesión.');
        }
        res.clearCookie('rdg.sid', {
            httpOnly: true,
            secure: modoProduccion,
            sameSite: 'lax'
        });
        res.redirect('login.html');
    });
});

// ==========================================
// 5. ENDPOINTS DE LA API (VENTAS, GASTOS Y REPORTES)
// ==========================================

// Endpoint: Registrar Venta Completa
app.post('/api/facturar-completa', async (req, res) => {
  try {
    const celular_cliente = req.body.cellular || req.body.celular || "";
    const {
        consecutivo, nombre, documento, email,
        tramite, tramitador, pago_tramitador, destino,
        m_pago_entidad, notas
    } = req.body;

    if (!metodosPagoPermitidos.includes(destino)) {
        return res.status(400).json({
            exito: false,
            mensaje: 'Selecciona cómo pagó el cliente y dónde ingresó el dinero.'
        });
    }

    const fechaVenta = String(req.body.fechaVenta || '').trim();
    if (fechaVenta && !esFechaCalendarioValida(fechaVenta)) {
        return res.status(400).json({
            exito: false,
            mensaje: 'La fecha de la venta no es válida.'
        });
    }
    if (fechaVenta) {
        try {
            const [[hoyRow]] = await conexion.promise().query(
                "SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS hoy"
            );
            if (fechaVenta > hoyRow.hoy) {
                return res.status(400).json({
                    exito: false,
                    mensaje: 'No se puede registrar una venta con fecha futura.'
                });
            }
        } catch (error) {
            console.error('No se pudo validar la fecha de la venta:', error);
            return res.status(500).json({
                exito: false,
                mensaje: 'No se pudo validar la fecha de la venta.'
            });
        }
    }

    const email_cliente = email || "";
    const v_precio_tramite = Number(req.body.precio_tramite ?? req.body.p_tramite);
    const v_precio_tramitador = Number(req.body.precio_tramitador ?? req.body.p_tramitador ?? 0);
    const v_pago_entidad = Number(req.body.pago_entidad ?? req.body.p_entidad ?? 0);
    const v_sede_id = Number(req.session.sedeActivaId);
    if (![v_precio_tramite, v_precio_tramitador, v_pago_entidad].every(Number.isFinite)
        || [v_precio_tramite, v_precio_tramitador, v_pago_entidad].some(valor => valor < 0)
        || !['1', '2'].includes(String(v_sede_id))) {
        return res.status(400).json({ exito: false, mensaje: 'Revisa los valores de la venta y la sede activa.' });
    }
    if ((v_precio_tramitador > 0 && !metodosPagoPermitidos.includes(pago_tramitador))
        || (v_pago_entidad > 0 && ![...metodosPagoPermitidos, 'PSE / Tarjeta'].includes(m_pago_entidad))) {
        return res.status(400).json({
            exito: false,
            mensaje: 'Selecciona cómo se pagó a cada tramitador o entidad.'
        });
    }
    const metodoPagoTramitador = v_precio_tramitador > 0 ? pago_tramitador : 'Ninguno';
    const metodoPagoEntidad = v_pago_entidad > 0 ? m_pago_entidad : 'Ninguno';
    const fechaHoraVenta = fechaVenta ? `${fechaVenta} 12:00:00` : null;

    const sqlVenta = `INSERT INTO registro_ventas_completo 
    (consecutivo, nombre_cliente, documento_cliente, celular_cliente, email_cliente, tipo_tramite, tramitador_responsable, metodo_pago_tramitador, metodo_pago_entidad, destino_fondos, precio_tramite, precio_tramitador, pago_entidad, observaciones_notas, sede_id, fecha_hora)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`;

    const valoresVenta = [
        consecutivo, nombre, documento, celular_cliente, email_cliente, 
        tramite, tramitador, metodoPagoTramitador, metodoPagoEntidad, destino,
        v_precio_tramite, v_precio_tramitador, v_pago_entidad,
        notas, v_sede_id, fechaHoraVenta
    ];

    conexion.query(sqlVenta, valoresVenta, (err, result) => {
      if (err) {
        console.error("❌ ERROR DETALLADO EN MYSQL:", err.message);
        return res.status(500).json({ error: err.message });
      }
      return res.status(200).json({ 
        exito: true, 
        mensaje: "Venta registrada con éxito",
        id: result.insertId 
      });
    });

  } catch (error) {
    console.error("❌ ERROR CRÍTICO EN EL SERVIDOR:", error.message);
    return res.status(500).json({ error: error.message });
  }
});

app.get('/api/facturas/:id/pdf', verificarAutenticacion, async (req, res) => {
    const ventaId = Number(req.params.id);
    if (!Number.isSafeInteger(ventaId) || ventaId <= 0) {
        return res.status(400).json({ exito: false, mensaje: 'El número de factura no es válido.' });
    }

    try {
        const [ventas] = await conexion.promise().query(
            `SELECT v.id_registro, v.consecutivo, v.nombre_cliente, v.documento_cliente,
                    v.celular_cliente, v.email_cliente, v.tipo_tramite, v.destino_fondos,
                    v.precio_tramite, v.fecha_hora, v.observaciones_notas, v.sede_id
             FROM registro_ventas_completo v
             WHERE v.id_registro = ? AND v.sede_id = ?
               AND NOT EXISTS (
                   SELECT 1 FROM operaciones_anuladas a
                   WHERE a.tipo = 'venta' AND a.operacion_id = v.id_registro
               )
             LIMIT 1`,
            [ventaId, req.session.sedeActivaId]
        );
        if (!ventas.length) {
            return res.status(404).json({ exito: false, mensaje: 'No se encontró una factura activa en la sede seleccionada.' });
        }

        const venta = ventas[0];
        const limpiarNombreArchivo = valor => String(valor || `factura-${ventaId}`)
            .replace(/[^a-zA-Z0-9_-]/g, '-')
            .replace(/-+/g, '-');
        const nombreArchivo = limpiarNombreArchivo(venta.consecutivo);
        const moneda = valor => `$ ${Number(valor || 0).toLocaleString('es-CO')}`;
        const montoTotal = Number(venta.precio_tramite) || 0;
        const fechaHora = new Date(venta.fecha_hora);
        const fechaLegible = Number.isNaN(fechaHora.getTime())
            ? 'Sin fecha'
            : `${fechaHora.toLocaleDateString('es-CO', {
                day: '2-digit',
                month: 'long',
                year: 'numeric'
            })} Hora: ${fechaHora.toLocaleTimeString('es-CO', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false
            })}`;

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivo}.pdf"`);
        const documento = new PDFDocument({ size: 'A4', margin: 48 });
        documento.on('error', error => {
            console.error('Error al generar el PDF de la factura:', error);
            if (!res.headersSent) res.status(500).json({ exito: false, mensaje: 'No se pudo generar el PDF de la factura.' });
            else res.destroy(error);
        });
        documento.pipe(res);

        const izquierda = documento.page.margins.left;
        const derecha = documento.page.width - documento.page.margins.right;
        const ancho = derecha - izquierda;
        const dibujarSeparador = y => {
            documento.moveTo(izquierda, y).lineTo(derecha, y)
                .lineWidth(0.7).strokeColor('#6B7280').stroke();
        };
        const dibujarEtiquetaValor = (etiqueta, valor, x, y, anchoTexto = ancho) => {
            documento.font('Helvetica-Bold').fontSize(10).fillColor('#111827')
                .text(`${etiqueta}:`, x, y, { width: anchoTexto * 0.3 });
            documento.font('Helvetica').fontSize(10).fillColor('#111827')
                .text(String(valor || 'No registrado'), x + anchoTexto * 0.3, y, {
                    width: anchoTexto * 0.7
                });
        };
        const yEmpresa = 86;
        documento.font('Helvetica-Bold').fontSize(20).fillColor('#111827')
            .text('Factura de Venta', izquierda, 42, { width: ancho, align: 'center' });
        documento.font('Helvetica-Bold').fontSize(11).fillColor('#111827')
            .text('RD GESTIONES EMPRESARIALES', izquierda, yEmpresa);
        documento.font('Helvetica').fontSize(10).fillColor('#111827')
            .text('CRA 52 # 42 -60 LOCAL 108', izquierda, yEmpresa + 17)
            .text('Teléfono: 3017222991', izquierda, yEmpresa + 32)
            .text('rydtramitesvirtuales@gmail.com', izquierda, yEmpresa + 47);
        dibujarSeparador(yEmpresa + 70);

        const yVenta = yEmpresa + 83;
        dibujarEtiquetaValor('Número de Factura', venta.consecutivo || `Venta-${venta.id_registro}`, izquierda, yVenta);
        dibujarEtiquetaValor('Fecha y Hora', fechaLegible, izquierda, yVenta + 19);
        dibujarEtiquetaValor('Cliente', venta.nombre_cliente || 'CLIENTE GENERAL', izquierda, yVenta + 38);
        dibujarEtiquetaValor('Teléfono', venta.celular_cliente || 'No registrado', izquierda, yVenta + 57);
        dibujarEtiquetaValor('Correo electrónico', venta.email_cliente || 'No registrado', izquierda, yVenta + 76);
        dibujarSeparador(yVenta + 97);

        const yCajero = yVenta + 111;
        dibujarEtiquetaValor('Cajero', req.session.nombreUsuario || 'No registrado', izquierda, yCajero);
        documento.font('Helvetica-Bold').fontSize(11).fillColor('#111827')
            .text('Descripción de Productos:', izquierda, yCajero + 28);

        const tablaY = yCajero + 49;
        const altoCabecera = 26;
        const altoFila = 34;
        const anchosColumnas = [ancho * 0.46, ancho * 0.14, ancho * 0.20, ancho * 0.20];
        const titulos = ['Producto', 'Cantidad', 'Precio unitario', 'Total'];
        documento.rect(izquierda, tablaY, ancho, altoCabecera).fill('#374151');
        let xColumna = izquierda;
        titulos.forEach((titulo, indice) => {
            documento.font('Helvetica-Bold').fontSize(9).fillColor('#FFFFFF')
                .text(titulo, xColumna + 6, tablaY + 8, {
                    width: anchosColumnas[indice] - 12,
                    align: indice === 0 ? 'left' : 'right',
                    lineBreak: false
                });
            xColumna += anchosColumnas[indice];
        });

        const filaY = tablaY + altoCabecera;
        documento.rect(izquierda, filaY, ancho, altoFila).fill('#F3F4F6');
        const valoresFila = [
            venta.tipo_tramite || 'Trámite',
            '1',
            moneda(montoTotal),
            moneda(montoTotal)
        ];
        xColumna = izquierda;
        valoresFila.forEach((valor, indice) => {
            documento.font('Helvetica').fontSize(9).fillColor('#111827')
                .text(String(valor), xColumna + 6, filaY + 11, {
                    width: anchosColumnas[indice] - 12,
                    align: indice === 0 ? 'left' : 'right',
                    lineBreak: false
                });
            xColumna += anchosColumnas[indice];
        });
        documento.rect(izquierda, filaY, ancho, altoFila + altoCabecera)
            .lineWidth(0.5).strokeColor('#9CA3AF').stroke();
        documento.y = filaY + altoFila + 24;

        const anchoTotales = 250;
        const xTotales = derecha - anchoTotales;
        [
            ['Total a Pagar', montoTotal],
            ['Cantidad pagada', montoTotal],
            ['Cambio', 0]
        ].forEach(([etiqueta, valor], indice) => {
            const y = documento.y + indice * 19;
            documento.font(indice === 0 ? 'Helvetica-Bold' : 'Helvetica')
                .fontSize(10).fillColor('#111827')
                .text(`${etiqueta}:`, xTotales, y, { width: 140 });
            documento.font(indice === 0 ? 'Helvetica-Bold' : 'Helvetica')
                .fontSize(10).fillColor('#111827')
                .text(moneda(valor), xTotales + 140, y, { width: anchoTotales - 140, align: 'right' });
        });
        documento.y += 85;
        documento.font('Helvetica-Bold').fontSize(12).fillColor('#111827')
            .text('¡Gracias por tu compra, vuelve pronto!', izquierda, documento.y, {
                width: ancho,
                align: 'center'
            });

        const notas = String(venta.observaciones_notas || '').trim() || 'Sin notas registradas.';
        const margenCampoNotas = 12;
        const anchoTextoNotas = ancho - margenCampoNotas * 2;
        const altoMinimoCampoNotas = 48;
        const espacioSuperiorNotas = 16;
        documento.font('Helvetica').fontSize(10);
        const altoTextoNotas = documento.heightOfString(notas, {
            width: anchoTextoNotas,
            align: 'center',
            lineGap: 2
        });
        const altoCampoNotas = Math.max(
            altoMinimoCampoNotas,
            altoTextoNotas + margenCampoNotas * 2
        );
        const altoSeccionNotas = 20 + 8 + altoCampoNotas;
        let yNotas = documento.y + espacioSuperiorNotas;
        const limiteInferior = documento.page.height - documento.page.margins.bottom;
        if (yNotas + altoSeccionNotas > limiteInferior) {
            documento.addPage();
            yNotas = documento.page.margins.top;
        }

        documento.font('Helvetica-Bold').fontSize(11).fillColor('#111827')
            .text('Notas:', izquierda, yNotas, { width: ancho, align: 'center' });
        const yCampoNotas = yNotas + 20;
        documento.roundedRect(izquierda, yCampoNotas, ancho, altoCampoNotas, 4)
            .fillAndStroke('#F9FAFB', '#9CA3AF');
        documento.font('Helvetica').fontSize(10).fillColor('#111827')
            .text(notas, izquierda + margenCampoNotas, yCampoNotas + margenCampoNotas, {
                width: anchoTextoNotas,
                align: 'center',
                lineGap: 2
            });
        documento.end();
    } catch (error) {
        console.error('Error al consultar la factura para generar su PDF:', error);
        if (!res.headersSent) {
            res.status(500).json({ exito: false, mensaje: 'No se pudo generar el PDF de la factura.' });
        }
    }
});

app.post('/api/gastos', verificarAdministrador, async (req, res) => {
    const categoria = String(req.body.categoria || '').trim();
    const descripcion = String(req.body.descripcion || '').trim();
    const fuentePago = String(req.body.fuente_pago || '').trim();
    const monto = Number(req.body.monto);
    const fechaSolicitada = req.body.fecha === undefined ? null : String(req.body.fecha).trim();

    if (!categoria || !descripcion || !fuentesGastoPermitidas.includes(fuentePago) || !Number.isFinite(monto) || monto <= 0) {
        return res.status(400).json({ exito: false, mensaje: 'Completa la categoría, descripción, cuenta de salida y un monto mayor que cero.' });
    }
    if (categoria.length > 100 || descripcion.length > 500 || fuentePago.length > 100) {
        return res.status(400).json({ exito: false, mensaje: 'Uno de los campos supera la longitud permitida.' });
    }
    if (fechaSolicitada !== null && !esFechaCalendarioValida(fechaSolicitada)) {
        return res.status(400).json({ exito: false, mensaje: 'La fecha del gasto no es válida.' });
    }

    try {
        const [[hoyRow]] = await conexion.promise().query(
            "SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS hoy"
        );
        const fecha = fechaSolicitada || hoyRow.hoy;
        if (fecha > hoyRow.hoy) {
            return res.status(400).json({ exito: false, mensaje: 'No se puede registrar un gasto con fecha futura.' });
        }
        const [resultado] = await conexion.promise().query(
            'INSERT INTO gastos (fecha, categoria, descripcion, monto, fuente_pago, sede_id) VALUES (?, ?, ?, ?, ?, ?)',
            [fecha, categoria, descripcion, monto, fuentePago, req.session.sedeActivaId]
        );
        res.status(201).json({ exito: true, id: resultado.insertId });
    } catch (error) {
        console.error('Error al registrar gasto:', error);
        res.status(500).json({ exito: false, mensaje: 'No se pudo registrar el gasto.' });
    }
});

app.post('/api/operaciones/:tipo/:id/anular', verificarAdministrador, async (req, res) => {
    const tablas = {
        venta: { tabla: 'registro_ventas_completo', columnaId: 'id_registro' },
        gasto: { tabla: 'gastos', columnaId: 'id' }
    };
    const operacion = tablas[req.params.tipo];
    const id = Number(req.params.id);
    const motivo = String(req.body.motivo || '').trim();
    const sedeId = Number(req.session.sedeActivaId);

    if (!operacion || !Number.isSafeInteger(id) || id <= 0 || !['1', '2'].includes(String(sedeId))) {
        return res.status(400).json({ exito: false, mensaje: 'La operación o sede seleccionada no es válida.' });
    }
    if (motivo.length < 5 || motivo.length > 500) {
        return res.status(400).json({ exito: false, mensaje: 'Escribe un motivo de anulación de entre 5 y 500 caracteres.' });
    }

    try {
        await ejecutarTransaccion(async db => {
            const [filas] = await db.query(
                `SELECT ${operacion.columnaId} FROM ${operacion.tabla}
                 WHERE ${operacion.columnaId} = ? AND sede_id = ? FOR UPDATE`,
                [id, sedeId]
            );
            if (!filas.length) {
                const error = new Error('No se encontró esa operación en la sede activa.');
                error.codigoHttp = 404;
                throw error;
            }

            const [anulaciones] = await db.query(
                'SELECT id FROM operaciones_anuladas WHERE tipo = ? AND operacion_id = ? FOR UPDATE',
                [req.params.tipo, id]
            );
            if (anulaciones.length) {
                const error = new Error('La operación ya fue anulada anteriormente.');
                error.codigoHttp = 409;
                throw error;
            }

            await db.query(
                `INSERT INTO operaciones_anuladas (tipo, operacion_id, sede_id, motivo, usuario)
                 VALUES (?, ?, ?, ?, ?)`,
                [req.params.tipo, id, sedeId, motivo, req.session.nombreUsuario || 'Administrador']
            );
        });
        res.json({ exito: true, mensaje: 'Operación anulada y registrada en el historial.' });
    } catch (error) {
        if (error.codigoHttp) {
            return res.status(error.codigoHttp).json({ exito: false, mensaje: error.message });
        }
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ exito: false, mensaje: 'La operación ya fue anulada anteriormente.' });
        }
        console.error('Error al anular una operación:', error);
        res.status(500).json({ exito: false, mensaje: 'No se pudo anular la operación.' });
    }
});

app.get('/api/auditoria-contable', verificarAdministrador, async (req, res) => {
    try {
        const [rows] = await conexion.promise().query(
            `SELECT tipo, operacion_id, referencia, detalle, monto, motivo, usuario, fecha
             FROM (
                 SELECT a.tipo, a.operacion_id,
                        COALESCE(v.consecutivo, CONCAT('Venta #', a.operacion_id)) AS referencia,
                        v.tipo_tramite AS detalle, v.precio_tramite AS monto,
                        a.motivo, a.usuario, a.anulada_en AS fecha, a.sede_id
                 FROM operaciones_anuladas a
                 LEFT JOIN registro_ventas_completo v
                    ON a.tipo = 'venta' AND v.id_registro = a.operacion_id
                 WHERE a.tipo = 'venta'
                 UNION ALL
                 SELECT a.tipo, a.operacion_id,
                        CONCAT('Gasto #', a.operacion_id) AS referencia,
                        g.categoria AS detalle, g.monto,
                        a.motivo, a.usuario, a.anulada_en AS fecha, a.sede_id
                 FROM operaciones_anuladas a
                 LEFT JOIN gastos g
                    ON a.tipo = 'gasto' AND g.id = a.operacion_id
                 WHERE a.tipo = 'gasto'
                 UNION ALL
                 SELECT 'saldo_inicial' AS tipo, a.id AS operacion_id,
                        CONCAT('Saldo inicial ', UPPER(a.cuenta)) AS referencia,
                        CONCAT(a.periodo, ' | Anterior: ', a.monto_anterior) AS detalle,
                        a.monto_nuevo AS monto,
                        a.motivo, a.usuario, a.cambiado_en AS fecha, a.sede_id
                 FROM auditoria_saldos_iniciales a
                 UNION ALL
                 SELECT 'cierre_diario' AS tipo, a.id AS operacion_id,
                        CONCAT('Cierre diario ', DATE_FORMAT(a.fecha, '%Y-%m-%d')) AS referencia,
                        CONCAT('Caja: ', COALESCE(a.contado_caja_anterior, 'sin cierre'), ' → ', a.contado_caja_nuevo,
                               ' | Banco: ', COALESCE(a.contado_banco_anterior, 'sin cierre'), ' → ', a.contado_banco_nuevo) AS detalle,
                        a.contado_caja_nuevo + a.contado_banco_nuevo AS monto,
                        a.motivo, a.usuario, a.cambiado_en AS fecha, a.sede_id
                 FROM auditoria_cierres_diarios a
             ) historial
             WHERE sede_id = ?
             ORDER BY fecha DESC
             LIMIT 100`,
            [req.session.sedeActivaId]
        );
        res.json({ exito: true, lista: rows });
    } catch (error) {
        console.error('Error al consultar la auditoría contable:', error);
        res.status(500).json({ exito: false, mensaje: 'No se pudo consultar el historial de auditoría.' });
    }
});

app.put('/api/saldos-iniciales', verificarAdministrador, async (req, res) => {
    const cuenta = String(req.body.cuenta || '');
    const monto = req.body.monto;
    const motivo = String(req.body.motivo || '').trim();
    const periodo = String(req.body.periodo || '');
    const sedeId = Number(req.session.sedeActivaId);
    if (!['caja', 'banco'].includes(cuenta) || typeof monto !== 'number' || !Number.isFinite(monto) || monto < 0
        || !/^\d{4}-(0[1-9]|1[0-2])$/.test(periodo)
        || !['1', '2'].includes(String(sedeId))) {
        return res.status(400).json({ exito: false, mensaje: 'La cuenta, sede o monto del saldo inicial no son válidos.' });
    }
    if (motivo.length < 5 || motivo.length > 500) {
        return res.status(400).json({ exito: false, mensaje: 'Escribe un motivo de entre 5 y 500 caracteres.' });
    }

    try {
        const resultado = await ejecutarTransaccion(async db => {
            const [previos] = await db.query(
                'SELECT monto FROM saldos_iniciales WHERE sede_id = ? AND periodo = ? AND cuenta = ? FOR UPDATE',
                [sedeId, periodo, cuenta]
            );
            const anterior = Number(previos[0]?.monto) || 0;
            await db.query(
                `INSERT INTO saldos_iniciales (sede_id, periodo, cuenta, monto, actualizado_por)
                 VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE monto = VALUES(monto), actualizado_por = VALUES(actualizado_por)`,
                [sedeId, periodo, cuenta, monto, req.session.nombreUsuario || 'Administrador']
            );
            await db.query(
                `INSERT INTO auditoria_saldos_iniciales
                    (sede_id, periodo, cuenta, monto_anterior, monto_nuevo, motivo, usuario)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [sedeId, periodo, cuenta, anterior, monto, motivo, req.session.nombreUsuario || 'Administrador']
            );
            return { periodo, anterior, monto };
        });
        res.json({ exito: true, ...resultado });
    } catch (error) {
        console.error('Error al guardar el saldo inicial:', error);
        res.status(500).json({ exito: false, mensaje: 'No se pudo guardar el saldo inicial.' });
    }
});

app.get('/api/control-diario', verificarAdministrador, async (req, res) => {
    const fecha = String(req.query.fecha || '');
    const sedeId = Number(req.session.sedeActivaId);
    if (!esFechaCalendarioValida(fecha) || !['1', '2'].includes(String(sedeId))) {
        return res.status(400).json({ exito: false, mensaje: 'La fecha o sede del control diario no son válidas.' });
    }

    try {
        const [[hoyRow]] = await conexion.promise().query(
            "SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS hoy"
        );
        if (fecha > hoyRow.hoy) {
            return res.status(400).json({ exito: false, mensaje: 'El control diario no permite fechas futuras.' });
        }
        const proyeccion = await obtenerProyeccionControlDiario(sedeId, fecha);
        res.json({ exito: true, ...proyeccion });
    } catch (error) {
        console.error('Error al consultar el control diario por cuenta:', error);
        res.status(500).json({ exito: false, mensaje: 'No se pudo consultar el control diario.' });
    }
});

app.get('/api/control-diario/resumen-cierre.pdf', verificarAdministrador, async (req, res) => {
    const fecha = String(req.query.fecha || '');
    const sedeId = Number(req.session.sedeActivaId);
    if (!esFechaCalendarioValida(fecha) || !['1', '2'].includes(String(sedeId))) {
        return res.status(400).json({ exito: false, mensaje: 'La fecha o sede del resumen no son válidas.' });
    }

    try {
        const [[hoyRow]] = await conexion.promise().query(
            "SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS hoy"
        );
        if (fecha > hoyRow.hoy) {
            return res.status(400).json({ exito: false, mensaje: 'No se puede generar un cierre de una fecha futura.' });
        }

        const proyeccion = await obtenerProyeccionControlDiario(sedeId, fecha);
        if (!proyeccion.configurado || proyeccion.fechaAnteriorAlInicio) {
            return res.status(409).json({ exito: false, mensaje: 'No hay un control diario configurado para esa fecha.' });
        }
        const [cierresGuardados] = await conexion.promise().query(
            `SELECT cuenta FROM control_cierres_diarios WHERE sede_id = ? AND fecha = ?`,
            [sedeId, fecha]
        );
        if (!cuentasControlDiario.every(cuenta =>
            cierresGuardados.some(cierre => cierre.cuenta === cuenta)
        ) || !proyeccion.arqueoCaja) {
            return res.status(409).json({
                exito: false,
                mensaje: 'Guarda el cierre y el arqueo de todas las cuentas antes de descargar el resumen.'
            });
        }

        const fechaSiguiente = sumarDias(fecha, 1);
        const aperturaSiguiente = await obtenerProyeccionControlDiario(sedeId, fechaSiguiente);
        if (!aperturaSiguiente.configurado || aperturaSiguiente.fechaAnteriorAlInicio) {
            return res.status(409).json({
                exito: false,
                mensaje: 'No se pudo calcular la apertura del día siguiente desde el cierre guardado.'
            });
        }

        const nombreSede = sedeId === 1 ? 'Alpujarra' : 'Caracas';
        const moneda = valor => `$ ${Number(valor || 0).toLocaleString('es-CO')}`;
        const fechaLegible = valor => {
            const [anio, mes, dia] = valor.split('-');
            return `${dia}/${mes}/${anio}`;
        };
        const fechaHoraLegible = valor => {
            if (!valor) return 'No disponible';
            const fechaValor = new Date(valor);
            if (Number.isNaN(fechaValor.getTime())) return String(valor);
            return new Intl.DateTimeFormat('es-CO', {
                timeZone: 'America/Bogota',
                day: '2-digit',
                month: '2-digit',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            }).format(fechaValor);
        };
        const fechaArchivo = fecha.replace(/-/g, '');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader(
            'Content-Disposition',
            `attachment; filename="arqueo-${nombreSede.toLowerCase()}-${fechaArchivo}.pdf"`
        );

        const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, bufferPages: true });
        doc.on('error', error => {
            console.error('Error al generar el resumen PDF del cierre diario:', error);
            if (!res.headersSent) res.status(500).json({ exito: false, mensaje: 'No se pudo generar el resumen PDF del cierre.' });
            else res.destroy(error);
        });
        doc.pipe(res);

        const margenIzquierdo = doc.page.margins.left;
        const ancho = doc.page.width - margenIzquierdo - doc.page.margins.right;
        const piePaginaY = doc.page.height - 24;
        const finContenidoY = piePaginaY - 18;
        const colorAzul = '#183153';
        const colorBorde = '#D9E1EA';
        const dibujarEncabezado = continuacion => {
            doc.save();
            doc.rect(0, 0, doc.page.width, 56).fill(colorAzul);
            doc.font('Helvetica-Bold').fontSize(12).fillColor('#FFFFFF')
                .text('RD GESTIONES EMPRESARIALES', margenIzquierdo, 12, { width: ancho });
            doc.font('Helvetica').fontSize(9).fillColor('#EAF0F6')
                .text(
                    `${continuacion ? 'Resumen de cierre diario (continuación)' : 'Resumen de cierre y arqueo diario'} | ${nombreSede} | ${fechaLegible(fecha)}`,
                    margenIzquierdo,
                    32,
                    { width: ancho }
                );
            doc.restore();
            doc.y = 68;
        };
        const asegurarEspacio = alto => {
            if (doc.y + alto <= finContenidoY) return;
            doc.addPage();
            dibujarEncabezado(true);
        };
        const dibujarSeccion = titulo => {
            asegurarEspacio(30);
            doc.moveDown(0.45);
            const y = doc.y;
            doc.rect(margenIzquierdo, y, 4, 16).fill('#D4AF37');
            doc.font('Helvetica-Bold').fontSize(10).fillColor(colorAzul)
                .text(titulo, margenIzquierdo + 10, y + 1, { width: ancho - 10 });
            doc.y = y + 22;
        };
        const dibujarTabla = (columnas, filas) => {
            const alturaCabecera = 24;
            const alturaFila = 22;
            asegurarEspacio(alturaCabecera + Math.min(filas.length, 2) * alturaFila);
            const pintarCabecera = () => {
                const y = doc.y;
                doc.rect(margenIzquierdo, y, ancho, alturaCabecera).fill('#374151');
                let x = margenIzquierdo;
                columnas.forEach(columna => {
                    doc.font('Helvetica-Bold').fontSize(7).fillColor('#FFFFFF')
                        .text(columna.titulo, x + 3, y + 7, {
                            width: columna.ancho - 6,
                            align: columna.alinear || 'left',
                            lineBreak: false
                        });
                    x += columna.ancho;
                });
                doc.y = y + alturaCabecera;
            };
            pintarCabecera();
            filas.forEach((fila, filaIndice) => {
                if (doc.y + alturaFila > finContenidoY) {
                    doc.addPage();
                    dibujarEncabezado(true);
                    pintarCabecera();
                }
                const y = doc.y;
                const esTotalGeneral = fila[0] === 'TOTAL GENERAL';
                if (esTotalGeneral) {
                    doc.rect(margenIzquierdo, y, ancho, alturaFila).fill('#FFF3C4');
                } else if (filaIndice % 2 === 0) {
                    doc.rect(margenIzquierdo, y, ancho, alturaFila).fill('#F3F6FA');
                }
                let x = margenIzquierdo;
                fila.forEach((valor, indice) => {
                    doc.font(esTotalGeneral ? 'Helvetica-Bold' : 'Helvetica').fontSize(esTotalGeneral ? 7.2 : 7).fillColor(esTotalGeneral ? '#183153' : '#263445')
                        .text(String(valor), x + 3, y + 7, {
                            width: columnas[indice].ancho - 6,
                            align: columnas[indice].alinear || 'left',
                            lineBreak: false
                        });
                    x += columnas[indice].ancho;
                });
                doc.y = y + alturaFila;
            });
            doc.moveTo(margenIzquierdo, doc.y).lineTo(margenIzquierdo + ancho, doc.y)
                .lineWidth(0.5).strokeColor(colorBorde).stroke();
        };

        dibujarEncabezado(false);
        const movimientos = [
            { titulo: 'Cuenta', ancho: ancho * 0.13 },
            { titulo: 'Apertura', ancho: ancho * 0.09, alinear: 'right' },
            { titulo: 'Ventas', ancho: ancho * 0.08, alinear: 'right' },
            { titulo: 'Pagos trámites', ancho: ancho * 0.10, alinear: 'right' },
            { titulo: 'Gastos local', ancho: ancho * 0.09, alinear: 'right' },
            { titulo: 'Gastos personales', ancho: ancho * 0.10, alinear: 'right' },
            { titulo: 'Traslados netos', ancho: ancho * 0.10, alinear: 'right' },
            { titulo: 'Esperado', ancho: ancho * 0.09, alinear: 'right' },
            { titulo: 'Contado', ancho: ancho * 0.09, alinear: 'right' },
            { titulo: 'Diferencia', ancho: ancho * 0.09, alinear: 'right' }
        ];
        movimientos[0].ancho = ancho - movimientos.slice(1).reduce((total, columna) => total + columna.ancho, 0);
        dibujarSeccion('Movimientos y conciliación por cuenta');
        const filasMovimientos = cuentasControlDiario.map(cuenta => {
            const fila = proyeccion.cuentas[cuenta];
            const contado = fila.contado === null ? 0 : fila.contado;
            return [
                fila.etiqueta,
                moneda(fila.apertura),
                moneda(fila.ventas),
                moneda(fila.pagosTramitadores + fila.pagosEntidades),
                moneda(fila.gastosLocal),
                moneda(fila.gastosPersonales),
                moneda(fila.trasladosEntrada - fila.trasladosSalida),
                moneda(fila.esperado),
                moneda(contado),
                moneda(fila.diferencia)
            ];
        });
        const sumaCuentas = campo => cuentasControlDiario.reduce((total, cuenta) => {
            const valor = proyeccion.cuentas[cuenta][campo];
            return total + (valor === null ? 0 : Number(valor) || 0);
        }, 0);
        filasMovimientos.push([
            'TOTAL GENERAL',
            moneda(sumaCuentas('apertura')),
            moneda(sumaCuentas('ventas')),
            moneda(cuentasControlDiario.reduce((total, cuenta) =>
                total + Number(proyeccion.cuentas[cuenta].pagosTramitadores || 0)
                    + Number(proyeccion.cuentas[cuenta].pagosEntidades || 0), 0)),
            moneda(sumaCuentas('gastosLocal')),
            moneda(sumaCuentas('gastosPersonales')),
            moneda(cuentasControlDiario.reduce((total, cuenta) =>
                total + Number(proyeccion.cuentas[cuenta].trasladosEntrada || 0)
                    - Number(proyeccion.cuentas[cuenta].trasladosSalida || 0), 0)),
            moneda(sumaCuentas('esperado')),
            moneda(cuentasControlDiario.reduce((total, cuenta) =>
                total + (proyeccion.cuentas[cuenta].contado === null ? 0 : Number(proyeccion.cuentas[cuenta].contado) || 0), 0)),
            moneda(sumaCuentas('diferencia'))
        ]);
        dibujarTabla(movimientos, filasMovimientos);

        dibujarSeccion('Arqueo de Caja diaria');
        const arqueo = proyeccion.arqueoCaja;
        const columnasArqueo = [
            { titulo: 'Esperado en caja', ancho: ancho * 0.2, alinear: 'right' },
            { titulo: 'Contado físico', ancho: ancho * 0.2, alinear: 'right' },
            { titulo: 'Diferencia', ancho: ancho * 0.2, alinear: 'right' },
            { titulo: 'Base para mañana', ancho: ancho * 0.2, alinear: 'right' },
            { titulo: 'Producido retirado', ancho: ancho * 0.2, alinear: 'right' }
        ];
        dibujarTabla(columnasArqueo, [[
            moneda(arqueo.esperado),
            moneda(arqueo.contadoFisico),
            moneda(arqueo.diferencia),
            moneda(arqueo.baseSiguiente),
            moneda(arqueo.producidoRetirado)
        ]]);
        asegurarEspacio(34);
        const textoProducido = 'El producido retirado queda fuera de las cuentas controladas. Una diferencia positiva indica sobrante; una negativa, faltante.';
        doc.roundedRect(margenIzquierdo, doc.y, ancho, 26, 4).fill('#F3F6FA');
        doc.font('Helvetica').fontSize(7.5).fillColor('#65758B')
            .text(textoProducido, margenIzquierdo + 10, doc.y + 6, {
                width: ancho - 20,
                height: 16,
                align: 'left',
                lineBreak: true,
                lineGap: 1
            });
        doc.y += 32;

        dibujarSeccion(`Comparación con la apertura del día siguiente (${fechaLegible(fechaSiguiente)})`);
        const columnasComparacion = [
            { titulo: 'Cuenta', ancho: ancho * 0.20 },
            { titulo: 'Contado al cierre', ancho: ancho * 0.20, alinear: 'right' },
            { titulo: 'Saldo trasladado', ancho: ancho * 0.20, alinear: 'right' },
            { titulo: 'Apertura calculada', ancho: ancho * 0.20, alinear: 'right' },
            { titulo: 'Diferencia', ancho: ancho * 0.20, alinear: 'right' }
        ];
        dibujarTabla(columnasComparacion, cuentasControlDiario.map(cuenta => {
            const cierreCuenta = proyeccion.cuentas[cuenta];
            const aperturaCuenta = aperturaSiguiente.cuentas[cuenta];
            const saldoTrasladado = cuenta === 'caja'
                ? arqueo.baseSiguiente
                : cierreCuenta.contado;
            return [
                cierreCuenta.etiqueta,
                moneda(cierreCuenta.contado),
                moneda(saldoTrasladado),
                moneda(aperturaCuenta.apertura),
                moneda(aperturaCuenta.apertura - saldoTrasladado)
            ];
        }));
        const textoCierreGuardado = `Cierre guardado por: ${proyeccion.usuario || 'Administrador'}`;
        const textoFechaCierre = `Fecha y hora: ${fechaHoraLegible(proyeccion.cerradoEn)}`;
        const textoNotaCierre = `Nota del cierre: ${proyeccion.motivo || 'Sin nota registrada'}`;
        const alturaNotaCierre = doc.heightOfString(textoNotaCierre, { width: ancho - 20, lineGap: 2 });
        asegurarEspacio(76 + alturaNotaCierre);
        const yBloqueCierre = doc.y;
        doc.roundedRect(margenIzquierdo, yBloqueCierre, ancho, 66 + alturaNotaCierre, 5)
            .fillAndStroke('#F8FAFC', '#D9E1EA');
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#263445')
            .text(textoCierreGuardado, margenIzquierdo + 10, yBloqueCierre + 10, {
                width: ancho / 2 - 10,
                lineGap: 2
            });
        doc.font('Helvetica').fontSize(8).fillColor('#263445')
            .text(textoFechaCierre, margenIzquierdo + ancho / 2, yBloqueCierre + 10, {
                width: ancho / 2 - 10,
                align: 'left',
                lineGap: 2
            });
        doc.font('Helvetica').fontSize(8).fillColor('#263445')
            .text(textoNotaCierre, margenIzquierdo + 10, yBloqueCierre + 34, {
                width: ancho - 20,
                height: alturaNotaCierre + 2,
                lineGap: 2,
                ellipsis: false
            });
        doc.y = yBloqueCierre + 66 + alturaNotaCierre;

        const paginas = doc.bufferedPageRange();
        for (let indice = paginas.start; indice < paginas.start + paginas.count; indice++) {
            doc.switchToPage(indice);
            doc.moveTo(margenIzquierdo, piePaginaY - 7)
                .lineTo(margenIzquierdo + ancho, piePaginaY - 7)
                .lineWidth(0.5).strokeColor(colorBorde).stroke();
            doc.font('Helvetica').fontSize(7).fillColor('#65758B')
                .text('Control diario por cuenta', margenIzquierdo, piePaginaY, {
                    width: ancho / 2,
                    lineBreak: false
                });
            doc.text(`Página ${indice + 1} de ${paginas.count}`, margenIzquierdo + ancho / 2, piePaginaY, {
                width: ancho / 2,
                align: 'right',
                lineBreak: false
            });
        }
        doc.end();
    } catch (error) {
        console.error('Error al consultar el resumen PDF del cierre diario:', error);
        if (!res.headersSent) {
            res.status(500).json({ exito: false, mensaje: 'No se pudo consultar el resumen del cierre diario.' });
        }
    }
});

app.post('/api/control-diario/aperturas', verificarAdministrador, async (req, res) => {
    const fechaInicio = String(req.body.fechaInicio || '');
    const saldos = req.body.saldos;
    const sedeId = Number(req.session.sedeActivaId);
    if (!esFechaCalendarioValida(fechaInicio) || !['1', '2'].includes(String(sedeId))
        || !saldos || typeof saldos !== 'object'
        || !cuentasControlDiario.every(cuenta =>
            typeof saldos[cuenta] === 'number'
            && Number.isFinite(saldos[cuenta])
            && saldos[cuenta] >= 0
            && saldos[cuenta] <= 9999999999.99
        )) {
        return res.status(400).json({ exito: false, mensaje: 'Ingresa una fecha válida y el saldo real de cada cuenta.' });
    }

    try {
        const [[hoyRow]] = await conexion.promise().query(
            "SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS hoy, DATE_FORMAT(DATE_ADD(CURDATE(), INTERVAL 1 DAY), '%Y-%m-%d') AS manana"
        );
        if (fechaInicio !== hoyRow.hoy && fechaInicio !== hoyRow.manana) {
            return res.status(400).json({ exito: false, mensaje: 'La fecha de inicio debe ser hoy o mañana.' });
        }

        await ejecutarTransaccion(async db => {
            const [existentes] = await db.query(
                'SELECT cuenta FROM control_saldos_iniciales WHERE sede_id = ? FOR UPDATE',
                [sedeId]
            );
            if (existentes.length) {
                const error = new Error('El control diario ya fue configurado para esta sede.');
                error.code = 'CONTROL_YA_CONFIGURADO';
                throw error;
            }
            for (const cuenta of cuentasControlDiario) {
                await db.query(
                    `INSERT INTO control_saldos_iniciales
                        (sede_id, cuenta, fecha_inicio, saldo, usuario)
                     VALUES (?, ?, ?, ?, ?)`,
                    [
                        sedeId, cuenta, fechaInicio, saldos[cuenta],
                        req.session.nombreUsuario || 'Administrador'
                    ]
                );
            }
        });
        res.status(201).json({ exito: true, mensaje: 'Saldos de apertura guardados. El historial anterior no fue modificado.' });
    } catch (error) {
        if (error.code === 'CONTROL_YA_CONFIGURADO') {
            return res.status(409).json({ exito: false, mensaje: error.message });
        }
        console.error('Error al configurar los saldos iniciales del control diario:', error);
        res.status(500).json({ exito: false, mensaje: 'No se pudieron guardar los saldos iniciales.' });
    }
});

app.post('/api/control-diario/aperturas/adelantar-a-hoy', verificarAdministrador, async (req, res) => {
    const sedeId = Number(req.session.sedeActivaId);
    if (!['1', '2'].includes(String(sedeId))) {
        return res.status(400).json({ exito: false, mensaje: 'Selecciona una sede válida antes de cambiar el inicio del control.' });
    }

    try {
        const [[fechas]] = await conexion.promise().query(
            `SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS hoy,
                    DATE_FORMAT(DATE_ADD(CURDATE(), INTERVAL 1 DAY), '%Y-%m-%d') AS manana`
        );
        await ejecutarTransaccion(async db => {
            const [aperturas] = await db.query(
                `SELECT cuenta, DATE_FORMAT(fecha_inicio, '%Y-%m-%d') AS fecha_inicio
                 FROM control_saldos_iniciales
                 WHERE sede_id = ? FOR UPDATE`,
                [sedeId]
            );
            if (aperturas.length !== cuentasControlDiario.length
                || !cuentasControlDiario.every(cuenta =>
                    aperturas.some(apertura =>
                        apertura.cuenta === cuenta && apertura.fecha_inicio === fechas.manana
                    )
                )) {
                const error = new Error('Solo se puede adelantar a hoy una apertura completa que esté configurada para mañana.');
                error.code = 'INICIO_NO_ADELANTABLE';
                throw error;
            }

            for (const tabla of [
                'control_traslados',
                'control_cierres_diarios',
                'control_gastos_personales',
                'control_arqueos_caja'
            ]) {
                const [registros] = await db.query(
                    `SELECT 1 FROM ${tabla} WHERE sede_id = ? LIMIT 1`,
                    [sedeId]
                );
                if (registros.length) {
                    const error = new Error('No se puede adelantar el inicio porque ya hay movimientos o cierres en el nuevo control.');
                    error.code = 'INICIO_CON_MOVIMIENTOS';
                    throw error;
                }
            }

            await db.query(
                `INSERT INTO auditoria_control_aperturas
                    (sede_id, fecha_anterior, fecha_nueva, usuario)
                 VALUES (?, ?, ?, ?)`,
                [
                    sedeId,
                    fechas.manana,
                    fechas.hoy,
                    req.session.nombreUsuario || 'Administrador'
                ]
            );
            await db.query(
                `UPDATE control_saldos_iniciales
                 SET fecha_inicio = ?
                 WHERE sede_id = ? AND fecha_inicio = ?`,
                [fechas.hoy, sedeId, fechas.manana]
            );
        });
        res.json({
            exito: true,
            mensaje: `El control ahora inicia hoy (${fechas.hoy}). Los saldos de apertura guardados no cambiaron.`
        });
    } catch (error) {
        if (error.code === 'INICIO_NO_ADELANTABLE' || error.code === 'INICIO_CON_MOVIMIENTOS') {
            return res.status(409).json({ exito: false, mensaje: error.message });
        }
        console.error('Error al adelantar la fecha de inicio del control diario:', error);
        res.status(500).json({ exito: false, mensaje: 'No se pudo adelantar la fecha de inicio del control.' });
    }
});

app.post('/api/control-diario/traslados', verificarAdministrador, async (req, res) => {
    const fecha = String(req.body.fecha || '');
    const cuentaOrigen = String(req.body.cuentaOrigen || '');
    const cuentaDestino = String(req.body.cuentaDestino || '');
    const monto = Number(req.body.monto);
    const descripcion = String(req.body.descripcion || '').trim();
    const sedeId = Number(req.session.sedeActivaId);
    if (!esFechaCalendarioValida(fecha) || !['1', '2'].includes(String(sedeId))
        || !cuentasControlDiario.includes(cuentaOrigen)
        || !cuentasControlDiario.includes(cuentaDestino)
        || cuentaOrigen === cuentaDestino
        || !Number.isFinite(monto) || monto <= 0 || monto > 9999999999.99
        || !descripcion || descripcion.length > 300) {
        return res.status(400).json({ exito: false, mensaje: 'Revisa la fecha, cuentas, monto y descripción del traslado.' });
    }

    try {
        const [[hoyRow]] = await conexion.promise().query(
            "SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS hoy"
        );
        if (fecha > hoyRow.hoy) {
            return res.status(400).json({ exito: false, mensaje: 'No se puede registrar un traslado futuro.' });
        }
        const [aperturas] = await conexion.promise().query(
            `SELECT cuenta, DATE_FORMAT(fecha_inicio, '%Y-%m-%d') AS fecha_inicio
             FROM control_saldos_iniciales WHERE sede_id = ?`,
            [sedeId]
        );
        if (aperturas.length !== cuentasControlDiario.length) {
            return res.status(409).json({ exito: false, mensaje: 'Configura primero los saldos iniciales del control diario.' });
        }
        if (fecha < aperturas[0].fecha_inicio) {
            return res.status(400).json({ exito: false, mensaje: 'La fecha del traslado debe ser igual o posterior al inicio del nuevo control.' });
        }
        await conexion.promise().query(
            `INSERT INTO control_traslados
                (sede_id, fecha, cuenta_origen, cuenta_destino, monto, descripcion, usuario)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                sedeId, fecha, cuentaOrigen, cuentaDestino, monto, descripcion,
                req.session.nombreUsuario || 'Administrador'
            ]
        );
        res.status(201).json({ exito: true, mensaje: 'Traslado registrado; no se contabilizó como ingreso ni como gasto.' });
    } catch (error) {
        console.error('Error al registrar un traslado entre cuentas:', error);
        res.status(500).json({ exito: false, mensaje: 'No se pudo registrar el traslado.' });
    }
});

app.post('/api/control-diario/gastos-personales', verificarAdministrador, async (req, res) => {
    const fecha = String(req.body.fecha || '');
    const cuenta = String(req.body.cuenta || '');
    const monto = Number(req.body.monto);
    const descripcion = String(req.body.descripcion || '').trim();
    const sedeId = Number(req.session.sedeActivaId);
    if (!esFechaCalendarioValida(fecha) || !['1', '2'].includes(String(sedeId))
        || !cuentasControlDiario.includes(cuenta)
        || !Number.isFinite(monto) || monto <= 0 || monto > 9999999999.99
        || !descripcion || descripcion.length > 300) {
        return res.status(400).json({ exito: false, mensaje: 'Revisa la fecha, cuenta, monto y descripción del gasto personal.' });
    }

    try {
        const [[hoyRow]] = await conexion.promise().query(
            "SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS hoy"
        );
        if (fecha > hoyRow.hoy) {
            return res.status(400).json({ exito: false, mensaje: 'No se puede registrar un gasto personal futuro.' });
        }
        const [aperturas] = await conexion.promise().query(
            `SELECT cuenta, DATE_FORMAT(fecha_inicio, '%Y-%m-%d') AS fecha_inicio
             FROM control_saldos_iniciales WHERE sede_id = ?`,
            [sedeId]
        );
        if (aperturas.length !== cuentasControlDiario.length) {
            return res.status(409).json({ exito: false, mensaje: 'Configura primero los saldos iniciales del control diario.' });
        }
        if (fecha < aperturas[0].fecha_inicio) {
            return res.status(400).json({ exito: false, mensaje: 'La fecha del gasto debe ser igual o posterior al inicio del nuevo control.' });
        }
        await conexion.promise().query(
            `INSERT INTO control_gastos_personales
                (sede_id, fecha, cuenta, monto, descripcion, usuario)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                sedeId, fecha, cuenta, monto, descripcion,
                req.session.nombreUsuario || 'Administrador'
            ]
        );
        res.status(201).json({
            exito: true,
            mensaje: `Gasto personal registrado; se descontará de ${etiquetasCuentasControl[cuenta]}.`
        });
    } catch (error) {
        console.error('Error al registrar un gasto personal:', error);
        res.status(500).json({ exito: false, mensaje: 'No se pudo registrar el gasto personal.' });
    }
});

app.post('/api/control-diario/cierre', verificarAdministrador, async (req, res) => {
    const fecha = String(req.body.fecha || '');
    const contados = req.body.contados;
    const baseCajaSiguiente = req.body.baseCajaSiguiente;
    const motivo = String(req.body.motivo || '').trim();
    const sedeId = Number(req.session.sedeActivaId);
    if (!esFechaCalendarioValida(fecha) || !['1', '2'].includes(String(sedeId))
        || !contados || typeof contados !== 'object'
        || !cuentasControlDiario.every(cuenta =>
            typeof contados[cuenta] === 'number'
            && Number.isFinite(contados[cuenta])
            && contados[cuenta] >= 0
            && contados[cuenta] <= 9999999999.99
        )
        || typeof baseCajaSiguiente !== 'number'
        || !Number.isFinite(baseCajaSiguiente)
        || baseCajaSiguiente < 0
        || baseCajaSiguiente > 9999999999.99) {
        return res.status(400).json({ exito: false, mensaje: 'Ingresa los saldos contados y una base válida para el día siguiente.' });
    }
    if (baseCajaSiguiente > contados.caja) {
        return res.status(400).json({ exito: false, mensaje: 'La base para el día siguiente no puede superar el efectivo contado en caja.' });
    }
    if (motivo.length < 5 || motivo.length > 500) {
        return res.status(400).json({ exito: false, mensaje: 'Escribe una nota de cierre de entre 5 y 500 caracteres.' });
    }

    try {
        const [[hoyRow]] = await conexion.promise().query(
            "SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS hoy"
        );
        if (fecha > hoyRow.hoy) {
            return res.status(400).json({ exito: false, mensaje: 'No se puede cerrar una fecha futura.' });
        }
        const proyeccion = await obtenerProyeccionControlDiario(sedeId, fecha);
        if (!proyeccion.configurado || proyeccion.fechaAnteriorAlInicio) {
            return res.status(409).json({ exito: false, mensaje: 'Configura la apertura del control y consulta una fecha desde el inicio elegido.' });
        }
        if (proyeccion.movimientosSinCuenta > 0) {
            return res.status(409).json({
                exito: false,
                mensaje: `Hay ${proyeccion.movimientosSinCuenta} en movimientos sin cuenta identificada. Revisa los medios de pago antes de cerrar.`
            });
        }

        await ejecutarTransaccion(async db => {
            const [arqueosAnteriores] = await db.query(
                `SELECT contado_fisico, base_siguiente, producido_retirado
                 FROM control_arqueos_caja
                 WHERE sede_id = ? AND fecha = ? FOR UPDATE`,
                [sedeId, fecha]
            );
            const producidoRetirado = redondearMonto(contados.caja - baseCajaSiguiente);
            const diferenciaCaja = redondearMonto(
                contados.caja - proyeccion.cuentas.caja.esperado
            );
            await db.query(
                `INSERT INTO control_arqueos_caja
                    (sede_id, fecha, contado_fisico, base_siguiente, producido_retirado,
                     esperado, diferencia, usuario)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    contado_fisico = VALUES(contado_fisico),
                    base_siguiente = VALUES(base_siguiente),
                    producido_retirado = VALUES(producido_retirado),
                    esperado = VALUES(esperado), diferencia = VALUES(diferencia),
                    usuario = VALUES(usuario)`,
                [
                    sedeId, fecha, contados.caja, baseCajaSiguiente, producidoRetirado,
                    proyeccion.cuentas.caja.esperado, diferenciaCaja,
                    req.session.nombreUsuario || 'Administrador'
                ]
            );
            await db.query(
                `INSERT INTO auditoria_control_arqueos_caja
                    (sede_id, fecha, contado_anterior, contado_nuevo,
                     base_anterior, base_nueva, retirado_anterior, retirado_nuevo,
                     esperado, diferencia, motivo, usuario)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    sedeId, fecha,
                    arqueosAnteriores.length ? Number(arqueosAnteriores[0].contado_fisico) : null,
                    contados.caja,
                    arqueosAnteriores.length ? Number(arqueosAnteriores[0].base_siguiente) : null,
                    baseCajaSiguiente,
                    arqueosAnteriores.length ? Number(arqueosAnteriores[0].producido_retirado) : null,
                    producidoRetirado,
                    proyeccion.cuentas.caja.esperado,
                    diferenciaCaja,
                    motivo,
                    req.session.nombreUsuario || 'Administrador'
                ]
            );
            for (const cuenta of cuentasControlDiario) {
                const fila = proyeccion.cuentas[cuenta];
                const diferencia = redondearMonto(contados[cuenta] - fila.esperado);
                const [previos] = await db.query(
                    `SELECT contado FROM control_cierres_diarios
                     WHERE sede_id = ? AND fecha = ? AND cuenta = ? FOR UPDATE`,
                    [sedeId, fecha, cuenta]
                );
                await db.query(
                    `INSERT INTO control_cierres_diarios
                        (sede_id, fecha, cuenta, apertura, esperado, contado, diferencia, motivo, usuario)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE
                        apertura = VALUES(apertura), esperado = VALUES(esperado),
                        contado = VALUES(contado), diferencia = VALUES(diferencia),
                        motivo = VALUES(motivo), usuario = VALUES(usuario)`,
                    [
                        sedeId, fecha, cuenta, fila.apertura, fila.esperado,
                        contados[cuenta], diferencia, motivo,
                        req.session.nombreUsuario || 'Administrador'
                    ]
                );
                await db.query(
                    `INSERT INTO auditoria_control_cierres
                        (sede_id, fecha, cuenta, contado_anterior, contado_nuevo, motivo, usuario)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [
                        sedeId, fecha, cuenta,
                        previos.length ? Number(previos[0].contado) : null,
                        contados[cuenta], motivo,
                        req.session.nombreUsuario || 'Administrador'
                    ]
                );
            }
        });
        res.json({ exito: true, mensaje: 'Cierre por cuenta guardado y auditado.' });
    } catch (error) {
        console.error('Error al guardar el cierre diario por cuenta:', error);
        res.status(500).json({ exito: false, mensaje: 'No se pudo guardar el cierre diario.' });
    }
});

app.get('/api/cierres-diarios', verificarAdministrador, async (req, res) => {
    const fecha = String(req.query.fecha || '');
    const sedeId = Number(req.session.sedeActivaId);
    if (!esFechaCalendarioValida(fecha) || !['1', '2'].includes(String(sedeId))) {
        return res.status(400).json({ exito: false, mensaje: 'La fecha o sede del cierre diario no son válidas.' });
    }

    try {
        const [[hoyRow]] = await conexion.promise().query(
            "SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS hoy"
        );
        if (fecha > hoyRow.hoy) {
            return res.status(400).json({ exito: false, mensaje: 'No se puede registrar un cierre de una fecha futura.' });
        }
        const cierre = await obtenerProyeccionCierreDiario(sedeId, fecha);
        res.json({ exito: true, ...cierre });
    } catch (error) {
        console.error('Error al consultar el cierre diario:', error);
        res.status(500).json({ exito: false, mensaje: 'No se pudo consultar el cierre diario.' });
    }
});

app.post('/api/cierres-diarios', verificarAdministrador, async (req, res) => {
    const fecha = String(req.body.fecha || '');
    const contadoCaja = req.body.contadoCaja;
    const contadoBanco = req.body.contadoBanco;
    const motivo = String(req.body.motivo || '').trim();
    const sedeId = Number(req.session.sedeActivaId);
    const montosValidos = [contadoCaja, contadoBanco].every(monto =>
        typeof monto === 'number' && Number.isFinite(monto) && monto >= 0 && monto <= 9999999999.99
    );

    if (!esFechaCalendarioValida(fecha) || !['1', '2'].includes(String(sedeId)) || !montosValidos) {
        return res.status(400).json({ exito: false, mensaje: 'La fecha, sede o montos contados no son válidos.' });
    }
    if (motivo.length < 5 || motivo.length > 500) {
        return res.status(400).json({ exito: false, mensaje: 'Escribe una nota o motivo de cierre de entre 5 y 500 caracteres.' });
    }

    try {
        const [[hoyRow]] = await conexion.promise().query(
            "SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS hoy"
        );
        if (fecha > hoyRow.hoy) {
            return res.status(400).json({ exito: false, mensaje: 'No se puede registrar un cierre de una fecha futura.' });
        }

        const proyeccion = await obtenerProyeccionCierreDiario(sedeId, fecha);
        const nuevo = {
            aperturaCaja: proyeccion.caja.apertura,
            esperadoCaja: proyeccion.caja.esperado,
            contadoCaja,
            diferenciaCaja: redondearMonto(contadoCaja - proyeccion.caja.esperado),
            aperturaBanco: proyeccion.banco.apertura,
            esperadoBanco: proyeccion.banco.esperado,
            contadoBanco,
            diferenciaBanco: redondearMonto(contadoBanco - proyeccion.banco.esperado)
        };

        await ejecutarTransaccion(async db => {
            const [cierresPrevios] = await db.query(
                `SELECT contado_caja, contado_banco FROM cierres_diarios
                 WHERE sede_id = ? AND fecha = ? FOR UPDATE`,
                [sedeId, fecha]
            );
            const cierrePrevio = cierresPrevios[0];
            await db.query(
                `INSERT INTO cierres_diarios
                    (sede_id, fecha, apertura_caja, esperado_caja, contado_caja, diferencia_caja,
                     apertura_banco, esperado_banco, contado_banco, diferencia_banco, motivo, usuario)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    apertura_caja = VALUES(apertura_caja), esperado_caja = VALUES(esperado_caja),
                    contado_caja = VALUES(contado_caja), diferencia_caja = VALUES(diferencia_caja),
                    apertura_banco = VALUES(apertura_banco), esperado_banco = VALUES(esperado_banco),
                    contado_banco = VALUES(contado_banco), diferencia_banco = VALUES(diferencia_banco),
                    motivo = VALUES(motivo), usuario = VALUES(usuario)`,
                [
                    sedeId, fecha, nuevo.aperturaCaja, nuevo.esperadoCaja, nuevo.contadoCaja, nuevo.diferenciaCaja,
                    nuevo.aperturaBanco, nuevo.esperadoBanco, nuevo.contadoBanco, nuevo.diferenciaBanco,
                    motivo, req.session.nombreUsuario || 'Administrador'
                ]
            );
            await db.query(
                `INSERT INTO auditoria_cierres_diarios
                    (sede_id, fecha, contado_caja_anterior, contado_caja_nuevo,
                     contado_banco_anterior, contado_banco_nuevo, motivo, usuario)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    sedeId, fecha,
                    cierrePrevio ? Number(cierrePrevio.contado_caja) : null,
                    contadoCaja,
                    cierrePrevio ? Number(cierrePrevio.contado_banco) : null,
                    contadoBanco,
                    motivo,
                    req.session.nombreUsuario || 'Administrador'
                ]
            );
        });

        res.json({
            exito: true,
            mensaje: 'Cierre diario guardado y registrado en auditoría.',
            cierre: {
                fecha,
                cierreRegistrado: true,
                caja: { apertura: nuevo.aperturaCaja, esperado: nuevo.esperadoCaja, contado: contadoCaja, diferencia: nuevo.diferenciaCaja },
                banco: { apertura: nuevo.aperturaBanco, esperado: nuevo.esperadoBanco, contado: contadoBanco, diferencia: nuevo.diferenciaBanco },
                motivo,
                usuario: req.session.nombreUsuario || 'Administrador'
            }
        });
    } catch (error) {
        console.error('Error al guardar el cierre diario:', error);
        res.status(500).json({ exito: false, mensaje: 'No se pudo guardar el cierre diario.' });
    }
});

app.get('/api/reporte-contable-diario', verificarAdministrador, async (req, res) => {
    const fecha = String(req.query.fecha || '');
    const sedeId = Number(req.session.sedeActivaId);
    if (!esFechaCalendarioValida(fecha) || !['1', '2'].includes(String(sedeId))) {
        return res.status(400).json({ exito: false, mensaje: 'La fecha o sede del reporte diario no son válidas.' });
    }

    try {
        const [[hoyRow]] = await conexion.promise().query(
            "SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS hoy"
        );
        if (fecha > hoyRow.hoy) {
            return res.status(400).json({ exito: false, mensaje: 'No se puede consultar un reporte de una fecha futura.' });
        }
        const [resumen, [ventas], [gastos]] = await Promise.all([
            obtenerResumenContablePorRango(sedeId, fecha, fecha),
            conexion.promise().query(
                `SELECT id_registro, consecutivo, nombre_cliente, documento_cliente,
                        tipo_tramite, tramitador_responsable, destino_fondos, precio_tramite,
                        precio_tramitador, pago_entidad, metodo_pago_tramitador, metodo_pago_entidad
                 FROM registro_ventas_completo v
                 WHERE v.sede_id = ? AND v.fecha_hora >= ?
                   AND v.fecha_hora < DATE_ADD(?, INTERVAL 1 DAY)
                   AND NOT EXISTS (
                       SELECT 1 FROM operaciones_anuladas a
                       WHERE a.tipo = 'venta' AND a.operacion_id = v.id_registro
                   )
                 ORDER BY v.fecha_hora, v.consecutivo`,
                [sedeId, fecha, fecha]
            ),
            conexion.promise().query(
                `SELECT g.id, DATE_FORMAT(g.fecha, '%Y-%m-%d %H:%i:%s') AS fecha,
                        g.categoria, g.descripcion, g.monto, g.fuente_pago
                 FROM gastos g
                 WHERE g.sede_id = ? AND g.fecha >= ?
                   AND g.fecha < DATE_ADD(?, INTERVAL 1 DAY)
                   AND NOT EXISTS (
                       SELECT 1 FROM operaciones_anuladas a
                       WHERE a.tipo = 'gasto' AND a.operacion_id = g.id
                   )
                 ORDER BY g.fecha, g.id`,
                [sedeId, fecha, fecha]
            )
        ]);

        res.json({
            exito: true,
            fecha,
            totalIngresos: resumen.totalIngresos,
            gastosTramites: resumen.gastosTramites,
            totalEnCaja: resumen.totalIngresos - resumen.gastosTramites,
            gastosLocal: resumen.gastosLocal,
            neto: resumen.utilidadNeta,
            ingresosCaja: resumen.ingresosCaja,
            ingresosBanco: resumen.ingresosBanco,
            movimientoCaja: resumen.movimientoCaja,
            movimientoBanco: resumen.movimientoBanco,
            movimientosSinClasificar: resumen.ingresosSinClasificar
                + resumen.gastosTramitesSinClasificar
                + resumen.gastosLocalSinClasificar,
            ventas,
            gastos
        });
    } catch (error) {
        console.error('Error al generar el reporte contable diario:', error);
        res.status(500).json({ exito: false, mensaje: 'No se pudo generar el reporte diario.' });
    }
});

// ENDPOINT: Contadores Diarios para el Menú Principal (Evita el error 404)
// Ejemplo en tu servidor (Node.js / Express)
app.get('/api/ventas-dia', verificarAdministrador, async (req, res) => {
    try {
        // Capturamos el ID de la sede que está activa en el navegador (1 o 2)
        const sedeId = req.query.sedeId || 1;
        const fecha = String(req.query.fecha || '').trim();
        if (fecha && !esFechaCalendarioValida(fecha)) {
            return res.status(400).json({ error: 'La fecha no es válida.' });
        }

        // IMPORTANTE: El WHERE sede_id = ? es el que separa las cuentas
        const [rows] = await conexion.promise().query(
            `SELECT * FROM registro_ventas_completo v
             WHERE v.sede_id = ? AND DATE(v.fecha_hora) = COALESCE(?, CURDATE())
               AND NOT EXISTS (
                   SELECT 1 FROM operaciones_anuladas a
                   WHERE a.tipo = 'venta' AND a.operacion_id = v.id_registro
               )`,
            [sedeId, fecha || null]
        );

        res.json(rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error al obtener las ventas' });
    }
});

app.get('/api/indicadores-dia', verificarAdministrador, async (req, res) => {
    try {
        const sedeId = req.query.sedeId || 1;
        const fecha = String(req.query.fecha || '').trim();
        if (fecha && !esFechaCalendarioValida(fecha)) {
            return res.status(400).json({ exito: false, error: 'La fecha no es válida.' });
        }
        const [rows] = await conexion.promise().query(
            `SELECT
                (SELECT COALESCE(SUM(precio_tramite), 0)
                FROM registro_ventas_completo v
                WHERE sede_id = ? AND DATE(fecha_hora) = COALESCE(?, CURDATE())
                  AND NOT EXISTS (
                      SELECT 1 FROM operaciones_anuladas a
                      WHERE a.tipo = 'venta' AND a.operacion_id = v.id_registro
                  )) AS ventasBrutas,
                (SELECT COALESCE(SUM(COALESCE(precio_tramitador, 0) + COALESCE(pago_entidad, 0)), 0)
                FROM registro_ventas_completo v
                WHERE sede_id = ? AND DATE(fecha_hora) = COALESCE(?, CURDATE())
                  AND NOT EXISTS (
                      SELECT 1 FROM operaciones_anuladas a
                      WHERE a.tipo = 'venta' AND a.operacion_id = v.id_registro
                  )) AS gastosTramites,
                (SELECT COALESCE(SUM(monto), 0)
                FROM gastos g
                WHERE sede_id = ? AND DATE(fecha) = COALESCE(?, CURDATE())
                  AND NOT EXISTS (
                      SELECT 1 FROM operaciones_anuladas a
                      WHERE a.tipo = 'gasto' AND a.operacion_id = g.id
                  )) AS gastosLocal`,
            [sedeId, fecha || null, sedeId, fecha || null, sedeId, fecha || null]
        );

        const indicadores = rows[0];
        const ventasBrutas = Number(indicadores.ventasBrutas) || 0;
        const gastosTramites = Number(indicadores.gastosTramites) || 0;
        const gastosLocal = Number(indicadores.gastosLocal) || 0;

        res.json({
            exito: true,
            ventasBrutas,
            utilidadNeta: ventasBrutas - gastosTramites - gastosLocal
        });
    } catch (error) {
        console.error('Error al obtener los indicadores diarios:', error);
        res.status(500).json({ exito: false, error: 'Error al obtener los indicadores diarios' });
    }
});

// ENDPOINT UNIFICADO Y CORREGIDO: Balance Gerencial y Consolidado Mensual
app.get('/api/reporte-contable-mensual', verificarAdministrador, async (req, res) => {
    try {
        const sedeId = req.session.sedeActivaId;
        const [[periodoActual]] = await conexion.promise().query(
            "SELECT DATE_FORMAT(CURDATE(), '%Y-%m') AS periodo"
        );
        const mes = req.query.mes || periodoActual.periodo;
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(mes))) {
            return res.status(400).json({ exito: false, mensaje: 'El periodo debe tener el formato YYYY-MM.' });
        }

        const resumen = await obtenerResumenContableMensual(sedeId, mes);
        const saldosFinales = await obtenerSaldosFinalesMensuales(sedeId, mes, resumen);
        const [resumen_servicios] = await conexion.promise().query(
            `SELECT tipo_tramite AS tramite, COUNT(*) AS cantidad, COALESCE(SUM(precio_tramite), 0) AS total
             FROM registro_ventas_completo v
             WHERE sede_id = ? AND DATE_FORMAT(fecha_hora, '%Y-%m') = ?
               AND NOT EXISTS (
                   SELECT 1 FROM operaciones_anuladas a
                   WHERE a.tipo = 'venta' AND a.operacion_id = v.id_registro
               )
             GROUP BY tipo_tramite`,
            [sedeId, mes]
        );
        const [resumen_gastos] = await conexion.promise().query(
            `SELECT categoria, COUNT(*) AS cantidad, COALESCE(SUM(monto), 0) AS total
             FROM gastos g
             WHERE sede_id = ? AND DATE_FORMAT(fecha, '%Y-%m') = ?
               AND NOT EXISTS (
                   SELECT 1 FROM operaciones_anuladas a
                   WHERE a.tipo = 'gasto' AND a.operacion_id = g.id
               )
             GROUP BY categoria`,
            [sedeId, mes]
        );

        res.json({
            exito: true,
            total_ingresos: resumen.totalIngresos,
            gastos_tramites: resumen.gastosTramites,
            total_caja: resumen.totalIngresos - resumen.gastosTramites,
            gastos_local: resumen.gastosLocal,
            neto_real: resumen.utilidadNeta,
            ingresos_efectivo: resumen.ingresosCaja,
            ingresos_banco: resumen.ingresosBanco,
            efectivo_caja: saldosFinales.caja,
            dinero_banco: saldosFinales.banco,
            saldo_contable_caja: saldosFinales.saldoContableCaja,
            saldo_contable_banco: saldosFinales.saldoContableBanco,
            fecha_ultimo_cierre: saldosFinales.fechaUltimoCierre,
            fecha_corte_saldos: saldosFinales.fechaCorte,
            origen_saldos: saldosFinales.origen,
            movimiento_caja: resumen.movimientoCaja,
            movimiento_banco: resumen.movimientoBanco,
            movimientos_sin_clasificar: resumen.ingresosSinClasificar
                + resumen.gastosTramitesSinClasificar
                + resumen.gastosLocalSinClasificar,
            resumen_servicios,
            resumen_gastos
        });

    } catch (error) {
        console.error("Error al generar reporte mensual:", error);
        res.status(500).json({ exito: false, mensaje: "Error en el servidor" });
    }
});

app.get('/api/reporte-balance-mensual', verificarAdministrador, async (req, res) => {
    const { sedeId, periodo } = req.query;
    if (!['1', '2'].includes(String(sedeId)) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(periodo))) {
        return res.status(400).json({ exito: false, mensaje: 'La sede o el periodo no son válidos.' });
    }

    try {
        const [ventas] = await conexion.promise().query(
            `SELECT fecha_hora, consecutivo, nombre_cliente, documento_cliente, tipo_tramite,
                    tramitador_responsable, destino_fondos, precio_tramite, precio_tramitador, pago_entidad
             FROM registro_ventas_completo v
             WHERE sede_id = ? AND fecha_hora LIKE ?
               AND NOT EXISTS (
                   SELECT 1 FROM operaciones_anuladas a
                   WHERE a.tipo = 'venta' AND a.operacion_id = v.id_registro
               )
             ORDER BY fecha_hora, consecutivo`,
            [sedeId, `${periodo}%`]
        );
        const [gastos] = await conexion.promise().query(
            `SELECT categoria, COUNT(*) AS cantidad, COALESCE(SUM(monto), 0) AS total
             FROM gastos g
             WHERE sede_id = ? AND fecha LIKE ?
               AND NOT EXISTS (
                   SELECT 1 FROM operaciones_anuladas a
                   WHERE a.tipo = 'gasto' AND a.operacion_id = g.id
               )
             GROUP BY categoria
             ORDER BY categoria`,
            [sedeId, `${periodo}%`]
        );
        const [resumenTramitadores] = await conexion.promise().query(
            `SELECT COALESCE(NULLIF(tramitador_responsable, ''), 'Sin asignar') AS tramitador,
                    COUNT(*) AS cantidad, COALESCE(SUM(precio_tramitador), 0) AS total
             FROM registro_ventas_completo
             WHERE sede_id = ? AND fecha_hora LIKE ?
               AND NOT EXISTS (
                   SELECT 1 FROM operaciones_anuladas a
                   WHERE a.tipo = 'venta' AND a.operacion_id = registro_ventas_completo.id_registro
               )
             GROUP BY tramitador
             ORDER BY tramitador`,
            [sedeId, `${periodo}%`]
        );

        const resumenPeriodo = await obtenerResumenContableMensual(sedeId, periodo);
        const saldosFinalesPeriodo = await obtenerSaldosFinalesMensuales(
            sedeId,
            periodo,
            resumenPeriodo
        );
        const totalIngresos = resumenPeriodo.totalIngresos;
        const gastosTramitadores = ventas.reduce((total, venta) => total + Number(venta.precio_tramitador || 0), 0);
        const pagosEntidades = ventas.reduce((total, venta) => total + Number(venta.pago_entidad || 0), 0);
        const gastosLocal = resumenPeriodo.gastosLocal;
        const utilidadNeta = resumenPeriodo.utilidadNeta;
        const nombreSede = sedeId === '1' ? 'Alpujarra' : 'Caracas';
        const datosSede = sedeId === '1'
            ? 'LOCAL ALPUJARRA | CRA 52 # 42 -60 LOCAL 108 | Tel: 301 722 2991'
            : 'LOCAL CARACAS | Calle 54 # 45-6, Local 104, Medellín | Tel: 300 901 2017';
        const rutaLogo = [path.join(__dirname, 'logo.png'), path.join(__dirname, 'logo.jpg')]
            .find(ruta => fs.existsSync(ruta));
        const periodoLegible = new Date(`${periodo}-01T12:00:00`).toLocaleDateString('es-CO', {
            month: 'long',
            year: 'numeric'
        });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="balance-${nombreSede.toLowerCase()}-${periodo}.pdf"`);

        const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true });
        doc.on('error', error => {
            console.error('Error al generar el PDF del balance mensual:', error);
            if (!res.headersSent) res.status(500).end();
            else res.destroy(error);
        });
        doc.pipe(res);

        const margenIzquierdo = doc.page.margins.left;
        const ancho = doc.page.width - margenIzquierdo - doc.page.margins.right;
        const piePaginaY = doc.page.height - 28;
        const finContenidoY = piePaginaY - 16;
        const colores = {
            azul: '#183153',
            azulClaro: '#EAF0F6',
            dorado: '#d4af37',
            texto: '#263445',
            tenue: '#65758B',
            borde: '#D9E1EA',
            fondoFila: '#F7F9FC',
            verde: '#18794E',
            rojo: '#B54747'
        };
        const moneda = valor => `$ ${Number(valor || 0).toLocaleString('es-CO')}`;
        const limpiarTexto = (valor, maximo = 100) => {
            const texto = String(valor || '').replace(/\s+/g, ' ').trim();
            return texto.length > maximo ? `${texto.slice(0, maximo - 1)}…` : texto;
        };
        const asegurarEspacio = (alto, encabezadoTabla) => {
            if (doc.y + alto <= finContenidoY) return;
            doc.addPage();
            dibujarEncabezadoContinuacion();
            if (encabezadoTabla) encabezadoTabla();
        };
        const dibujarEncabezadoContinuacion = () => {
            doc.save();
            doc.rect(0, 0, doc.page.width, 54).fill(colores.azul);
            doc.font('Helvetica-Bold').fontSize(10).fillColor('#FFFFFF')
                .text('RD GESTIONES EMPRESARIALES', margenIzquierdo, 12);
            doc.font('Helvetica').fontSize(8).fillColor('#DCE5F0')
                .text(`${datosSede}  |  ${periodoLegible}`, margenIzquierdo, 29, { width: ancho });
            doc.restore();
            doc.y = 70;
        };
        const dibujarTituloSeccion = titulo => {
            asegurarEspacio(38);
            doc.moveDown(0.8);
            const y = doc.y;
            doc.rect(margenIzquierdo, y, 4, 17).fill(colores.dorado);
            doc.font('Helvetica-Bold').fontSize(11).fillColor(colores.azul)
                .text(titulo, margenIzquierdo + 12, y + 1, { width: ancho - 12 });
            doc.y = y + 26;
        };
        const dibujarEncabezadoTabla = columnas => {
            const alto = 25;
            const y = doc.y;
            doc.rect(margenIzquierdo, y, ancho, alto).fill(colores.azulClaro);
            let x = margenIzquierdo;
            columnas.forEach(columna => {
                doc.font('Helvetica-Bold').fontSize(8).fillColor(colores.azul)
                    .text(columna.titulo, x + 7, y + 8, {
                        width: columna.ancho - 14,
                        align: columna.alinear || 'left',
                        lineBreak: false
                    });
                x += columna.ancho;
            });
            doc.y = y + alto;
        };
        const dibujarTabla = (titulo, columnas, filas) => {
            asegurarEspacio(64);
            dibujarTituloSeccion(titulo);
            const dibujarCabecera = () => dibujarEncabezadoTabla(columnas);
            dibujarCabecera();

            if (!filas.length) {
                asegurarEspacio(33, dibujarCabecera);
                doc.font('Helvetica').fontSize(8.5).fillColor(colores.tenue)
                    .text('No hay registros para este periodo.', margenIzquierdo + 8, doc.y + 10);
                doc.y += 30;
                return;
            }

            filas.forEach((fila, indice) => {
                const tamanoFuente = 8;
                const altoContenido = Math.max(...columnas.map((columna, celda) =>
                    doc.heightOfString(limpiarTexto(fila[celda], 100), {
                        width: columna.ancho - 14,
                        font: fila.negrita ? 'Helvetica-Bold' : 'Helvetica',
                        fontSize: tamanoFuente,
                        lineGap: 1
                    })
                ));
                const altoFila = Math.max(27, altoContenido + 12);
                asegurarEspacio(altoFila, dibujarCabecera);

                const y = doc.y;
                if (indice % 2 === 1) doc.rect(margenIzquierdo, y, ancho, altoFila).fill(colores.fondoFila);
                doc.save();
                doc.rect(margenIzquierdo, y, ancho, altoFila).clip();
                let x = margenIzquierdo;
                columnas.forEach((columna, celda) => {
                    doc.font(fila.negrita ? 'Helvetica-Bold' : 'Helvetica')
                        .fontSize(tamanoFuente)
                        .fillColor(fila.color || colores.texto)
                        .text(limpiarTexto(fila[celda], 100), x + 7, y + 6, {
                            width: columna.ancho - 14,
                            height: altoFila - 10,
                            align: columna.alinear || 'left',
                            lineGap: 1
                        });
                    x += columna.ancho;
                });
                doc.restore();
                doc.moveTo(margenIzquierdo, y + altoFila)
                    .lineTo(margenIzquierdo + ancho, y + altoFila)
                    .lineWidth(0.5).strokeColor(colores.borde).stroke();
                doc.y = y + altoFila;
            });
        };

        doc.save();
        doc.rect(0, 0, doc.page.width, 110).fill('#FFFFFF');
        if (rutaLogo) {
            doc.image(rutaLogo, 40, 35, { fit: [60, 60], align: 'center', valign: 'center' });
        } else {
            console.warn('No se encontró logo.png ni logo.jpg; se generará el PDF sin logotipo.');
        }
        doc.font('Helvetica-Bold').fontSize(14).fillColor(colores.azul)
            .text('RD GESTIONES EMPRESARIALES', 115, 35, { width: ancho - 75 });
        doc.font('Helvetica').fontSize(8.5).fillColor(colores.texto)
            .text(datosSede, 115, 57, { width: ancho - 75, lineGap: 3 });
        doc.font('Helvetica-Bold').fontSize(8).fillColor(colores.tenue)
            .text(`BALANCE MENSUAL  |  ${periodoLegible.toUpperCase()}`, 115, 84, { width: ancho - 75 });
        doc.moveTo(40, 108).lineTo(doc.page.width - 40, 108)
            .lineWidth(2).strokeColor(colores.dorado).stroke();
        doc.restore();
        doc.y = 126;

        const tarjetas = [
            { titulo: 'INGRESOS TOTALES', valor: totalIngresos, color: colores.azul },
            { titulo: 'GASTOS DEL LOCAL', valor: gastosLocal, color: colores.rojo },
            { titulo: 'UTILIDAD NETA', valor: utilidadNeta, color: utilidadNeta >= 0 ? colores.verde : colores.rojo }
        ];
        const espacioTarjetas = 8;
        const anchoTarjeta = (ancho - espacioTarjetas * 2) / 3;
        tarjetas.forEach((tarjeta, indice) => {
            const x = margenIzquierdo + indice * (anchoTarjeta + espacioTarjetas);
            const y = 126;
            doc.roundedRect(x, y, anchoTarjeta, 66, 5).fill('#F3F6FA');
            doc.rect(x, y, 4, 66).fill(tarjeta.color);
            doc.font('Helvetica-Bold').fontSize(7.5).fillColor(colores.tenue)
                .text(tarjeta.titulo, x + 13, y + 10, { width: anchoTarjeta - 22 });
            doc.font('Helvetica-Bold').fontSize(11).fillColor(tarjeta.color)
                .text(moneda(tarjeta.valor), x + 13, y + 30, { width: anchoTarjeta - 22, lineBreak: false });
        });
        doc.y = 208;

        const filasResumenFinanciero = [
            ['Ingresos por trámites', moneda(totalIngresos)],
            ['Ingresos recibidos en efectivo / caja', moneda(resumenPeriodo.ingresosCaja)],
            ['Ingresos recibidos por transferencia / banco', moneda(resumenPeriodo.ingresosBanco)],
            ['Pagos de trámites a tramitadores y entidades', moneda(gastosTramitadores + pagosEntidades)],
            ['Pagos de trámites realizados desde caja', moneda(resumenPeriodo.gastosTramitesCaja)],
            ['Pagos de trámites realizados desde banco', moneda(resumenPeriodo.gastosTramitesBanco)],
            ['Gastos del local', moneda(gastosLocal)],
            ['Gastos del local pagados desde caja', moneda(resumenPeriodo.gastosLocalCaja)],
            ['Gastos del local pagados desde banco', moneda(resumenPeriodo.gastosLocalBanco)],
            [
                saldosFinalesPeriodo.origen === 'control_diario'
                    ? 'Saldo final de efectivo físico (Caja + Fondo)'
                    : 'Saldo final histórico de caja',
                moneda(saldosFinalesPeriodo.caja)
            ],
            [
                saldosFinalesPeriodo.origen === 'control_diario'
                    ? 'Saldo final digital (Bancolombia + Nequi + otros)'
                    : 'Saldo final histórico de banco',
                moneda(saldosFinalesPeriodo.banco)
            ],
            {
                0: 'UTILIDAD NETA (ingresos menos pagos de trámites y gastos del local)',
                1: moneda(utilidadNeta),
                negrita: true,
                color: utilidadNeta >= 0 ? colores.verde : colores.rojo
            }
        ];

        dibujarTabla('Resumen financiero', [
            { titulo: 'CONCEPTO', ancho: ancho - 150 },
            { titulo: 'VALOR', ancho: 150, alinear: 'right' }
        ], filasResumenFinanciero);

        dibujarTabla('Actividad por tramitador', [
            { titulo: 'TRAMITADOR', ancho: ancho - 180 },
            { titulo: 'TRÁMITES', ancho: 75, alinear: 'right' },
            { titulo: 'TOTAL PAGADO', ancho: 105, alinear: 'right' }
        ], resumenTramitadores.map(item => [
            item.tramitador,
            Number(item.cantidad || 0).toLocaleString('es-CO'),
            moneda(item.total)
        ]));

        dibujarTabla('Gastos del local por categoría', [
            { titulo: 'CATEGORÍA', ancho: ancho - 180 },
            { titulo: 'REGISTROS', ancho: 75, alinear: 'right' },
            { titulo: 'TOTAL', ancho: 105, alinear: 'right' }
        ], gastos.map(item => [
            item.categoria || 'Sin categoría',
            Number(item.cantidad || 0).toLocaleString('es-CO'),
            moneda(item.total)
        ]));

        const formatearFecha = valor => {
            if (!valor) return 'Sin fecha';
            const partes = String(valor).slice(0, 10).split('-');
            return partes.length === 3 ? `${partes[2]}/${partes[1]}/${partes[0]}` : String(valor);
        };
        dibujarTabla(`Detalle de trámites (${ventas.length})`, [
            { titulo: 'FECHA / FOLIO', ancho: 88 },
            { titulo: 'CLIENTE / DOCUMENTO', ancho: 135 },
            { titulo: 'RECIBIDO EN', ancho: 68 },
            { titulo: 'TRÁMITE / TRAMITADOR', ancho: ancho - 88 - 135 - 68 - 92 },
            { titulo: 'INGRESO', ancho: 92, alinear: 'right' }
        ], ventas.map(venta => [
            `${formatearFecha(venta.fecha_hora)}\n${venta.consecutivo || 'Sin consecutivo'}`,
            `${venta.nombre_cliente || 'Sin nombre'}\nDoc. ${venta.documento_cliente || 'N/D'}`,
            venta.destino_fondos || 'Sin clasificar',
            `${venta.tipo_tramite || 'Sin tipo'}\nTramitador: ${venta.tramitador_responsable || 'Sin asignar'}`,
            moneda(venta.precio_tramite)
        ]));

        asegurarEspacio(74);
        const yNotaBalance = doc.y;
        doc.roundedRect(margenIzquierdo, yNotaBalance, ancho, 74, 4)
            .fillAndStroke('#F3F6FA', colores.borde);
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(colores.azul)
            .text('ACLARACIÓN SOBRE LOS SALDOS', margenIzquierdo + 10, yNotaBalance + 8, {
                width: ancho - 20
            });
        doc.font('Helvetica').fontSize(8).fillColor(colores.texto)
            .text(`Los saldos finales se calculan desde una sola fuente: ${saldosFinalesPeriodo.origen === 'control_diario' ? 'Control diario por cuenta' : 'balance histórico mensual'}. Los gastos del local son egresos y la utilidad neta (ingresos menos pagos de trámites y gastos del local) es un resultado del periodo; ninguno representa por sí mismo un saldo de caja.`, {
                width: ancho - 20,
                lineGap: 2
            });
        doc.font('Helvetica').fontSize(7.5).fillColor(colores.tenue)
            .text(`Movimientos con medio de pago no reconocido: ${moneda(resumenPeriodo.movimientoSinClasificar)}. Requieren revisión.`, {
                width: ancho - 20,
                lineGap: 1
            });
        doc.y = yNotaBalance + 84;

        const rangoPaginas = doc.bufferedPageRange();
        for (let indice = rangoPaginas.start; indice < rangoPaginas.start + rangoPaginas.count; indice++) {
            doc.switchToPage(indice);
            doc.moveTo(margenIzquierdo, piePaginaY - 7)
                .lineTo(doc.page.width - doc.page.margins.right, piePaginaY - 7)
                .lineWidth(0.5).strokeColor(colores.borde).stroke();
            doc.font('Helvetica').fontSize(7).fillColor(colores.tenue)
                .text('Documento generado por el sistema de facturación', margenIzquierdo, piePaginaY, {
                    width: ancho / 2,
                    lineBreak: false
                });
            doc.text(`Página ${indice + 1} de ${rangoPaginas.count}`, margenIzquierdo + ancho / 2, piePaginaY, {
                width: ancho / 2,
                align: 'right',
                lineBreak: false
            });
        }

        doc.end();
    } catch (error) {
        console.error('Error al consultar los datos del balance mensual:', error);
        if (!res.headersSent) {
            res.status(500).json({ exito: false, mensaje: 'No se pudo generar el reporte mensual.' });
        }
    }
});

// ENDPOINT ROBUSTO PARA LISTAR LOS TRÁMITES EN LA TABLA
app.get('/api/listar-tramites', (req, res) => {
    const sedeId = req.query.sedeId;
    const fecha = String(req.query.fecha || '').trim();
    if (fecha && !esFechaCalendarioValida(fecha)) {
        return res.status(400).json({ exito: false, mensaje: 'La fecha seleccionada no es válida.' });
    }
    let query = `SELECT v.* FROM registro_ventas_completo v
                 WHERE NOT EXISTS (
                     SELECT 1 FROM operaciones_anuladas a
                     WHERE a.tipo = 'venta' AND a.operacion_id = v.id_registro
                 )`;
    let params = [];

    if (fecha) {
        query += ' AND DATE(v.fecha_hora) = ?';
        params.push(fecha);
    }

    if (sedeId) {
        query += " AND v.sede_id = ? ORDER BY v.fecha_hora DESC, v.id_registro DESC";
        params.push(sedeId);
    } else {
        query += " ORDER BY v.fecha_hora DESC, v.id_registro DESC";
    }

    conexion.query(query, params, (err, results) => {
        if (err) {
            console.error("❌ Error al listar trámites:", err.message);
            return res.status(500).json({ exito: false, mensaje: 'No se pudieron consultar los trámites.' });
        }
        res.json({ exito: true, lista: results || [] });
    });
});

// Endpoint Vital: Listar Gastos de Local
app.get('/api/listar-gastos', verificarAdministrador, (req, res) => {
    const sedeId = req.query.sedeId || 1;
    const sql = `SELECT g.id, g.fecha, g.categoria, g.descripcion, g.monto, g.fuente_pago
                 FROM gastos g
                 WHERE g.sede_id = ?
                   AND NOT EXISTS (
                       SELECT 1 FROM operaciones_anuladas a
                       WHERE a.tipo = 'gasto' AND a.operacion_id = g.id
                   )
                 ORDER BY g.fecha DESC`;

    conexion.query(sql, [sedeId], (err, results) => {
        if (err) {
            console.error("Error al listar gastos:", err.message);
            return res.status(500).json({ exito: false, mensaje: 'No se pudieron consultar los gastos.' });
        }
        res.json({ exito: true, lista: results });
    });
});

// Cambiar estado operativo del trámite
app.post('/api/cambiar-estado-tramite', verificarAdministrador, (req, res) => {
    const { id, estadoActual } = req.body;
    const nuevoEstado = (estadoActual === 'LISTO' || estadoActual === 'FINALIZADO') ? 'PENDIENTE' : 'LISTO';

    const sql = `UPDATE registro_ventas_completo v SET estado = ?
                 WHERE id_registro = ? AND sede_id = ?
                   AND NOT EXISTS (
                       SELECT 1 FROM operaciones_anuladas a
                       WHERE a.tipo = 'venta' AND a.operacion_id = v.id_registro
                   )`;

    conexion.query(sql, [nuevoEstado, id, req.session.sedeActivaId], (err, result) => {
        if (err) {
            console.error("Error al actualizar estado:", err.message);
            return res.json({ exito: false, error: err.message });
        }
        if (!result.affectedRows) {
            return res.status(404).json({ exito: false, mensaje: 'No se encontró la venta activa en la sede.' });
        }
        res.json({ exito: true, nuevoEstado });
    });
});

// Cambiar estado de pago
app.post('/api/cambiar-estado-pago', verificarAdministrador, (req, res) => {
    const { id, estadoPagoActual } = req.body;
    const nuevoEstadoPago = (estadoPagoActual === 'PAGADO') ? 'PENDIENTE' : 'PAGADO';

    const sql = `UPDATE registro_ventas_completo v SET estado_pago = ?
                 WHERE id_registro = ? AND sede_id = ?
                   AND NOT EXISTS (
                       SELECT 1 FROM operaciones_anuladas a
                       WHERE a.tipo = 'venta' AND a.operacion_id = v.id_registro
                   )`;

    conexion.query(sql, [nuevoEstadoPago, id, req.session.sedeActivaId], (err, result) => {
        if (err) {
            console.error("Error al actualizar pago:", err.message);
            return res.json({ exito: false, error: err.message });
        }
        if (!result.affectedRows) {
            return res.status(404).json({ exito: false, mensaje: 'No se encontró la venta activa en la sede.' });
        }
        res.json({ exito: true, nuevoEstadoPago });
    });
});

// CONSECUTIVO AUTOMÁTICO DE VENTAS
app.get('/api/obtener-siguiente-consecutivo', (req, res) => {
    const sqlContar = "SELECT COUNT(*) as total FROM registro_ventas_completo";

    conexion.query(sqlContar, (err, results) => {
        if (err) {
            console.error("Error al contar registros en MySQL:", err);
                return res.status(500).json({ exito: false, mensaje: 'No se pudo generar el siguiente consecutivo.' });
        }

        const filas = JSON.parse(JSON.stringify(results));
        const totalRegistros = filas[0].total || 0;
        const numeroSiguiente = totalRegistros + 1;
        const siguienteConsecutivo = `FAC-2026-${String(numeroSiguiente).padStart(3, '0')}`;

        res.json({ exito: true, siguiente: siguienteConsecutivo });
    });
});

// Consolidated monthly account movement and account balances for the active site.
app.get('/api/balance-ingresos-gastos', verificarAdministrador, async (req, res) => {
    try {
        const sedeId = req.session.sedeActivaId;
        const [[periodoRow]] = await conexion.promise().query("SELECT DATE_FORMAT(CURDATE(), '%Y-%m') AS periodo");
        const resumen = await obtenerResumenContableMensual(sedeId, periodoRow.periodo);
        const saldosFinales = await obtenerSaldosFinalesMensuales(
            sedeId,
            periodoRow.periodo,
            resumen
        );

        res.json({
            exito: true,
            periodo: periodoRow.periodo,
            totalIngresos: resumen.totalIngresos,
            ingresosCaja: resumen.ingresosCaja,
            ingresosBanco: resumen.ingresosBanco,
            gastosTramites: resumen.gastosTramites,
            gastosTramitesCaja: resumen.gastosTramitesCaja,
            gastosTramitesBanco: resumen.gastosTramitesBanco,
            gastosLocal: resumen.gastosLocal,
            gastosLocalCaja: resumen.gastosLocalCaja,
            gastosLocalBanco: resumen.gastosLocalBanco,
            totalEnCaja: resumen.totalIngresos - resumen.gastosTramites,
            neto: resumen.utilidadNeta,
            cajaReal: saldosFinales.caja,
            bancoReal: saldosFinales.banco,
            fechaUltimoCierre: saldosFinales.fechaUltimoCierre,
            fechaCorteSaldos: saldosFinales.fechaCorte,
            origenSaldos: saldosFinales.origen,
            movimientosSinClasificar: resumen.ingresosSinClasificar
                + resumen.gastosTramitesSinClasificar
                + resumen.gastosLocalSinClasificar
        });
    } catch (error) {
        console.error('Error al generar el balance mensual de caja y banco:', error);
        res.status(500).json({ exito: false, mensaje: 'No se pudo generar el balance mensual.' });
    }
});

// ==========================================
// 6. INICIO DEL SERVIDOR
// ==========================================
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || (modoProduccion ? '0.0.0.0' : '127.0.0.1');

app.use((req, res, next) => {
    const ruta = req.path.toLowerCase();
    const archivosPrivados = [
        '/server.js',
        '/package.json',
        '/package-lock.json',
        '/.env',
        '/.env.example'
    ];
    if (archivosPrivados.includes(ruta) || ruta.startsWith('/node_modules/') || ruta.startsWith('/.git/')) {
        return res.sendStatus(404);
    }
    next();
});

app.use(express.static(__dirname, { dotfiles: 'deny', index: false }));

conexion.connect(error => {
    if (error) {
        console.error('Error de conexión con MySQL; el servidor no se iniciará:', error.message);
        process.exitCode = 1;
        return;
    }

    conexion.promise().query(`SET time_zone = '${zonaHorariaNegocio}'`).then(() =>
        sessionStore.onReady()
    ).then(() => {
        console.log('Conexiones a MySQL listas.');
        const servidor = app.listen(PORT, HOST, () => {
            console.log(`Servidor Contable RD escuchando en ${HOST}:${PORT}`);
        });
        servidor.on('error', errorEscucha => {
            console.error(`No se pudo iniciar el servidor en ${HOST}:${PORT}:`, errorEscucha.message);
            process.exitCode = 1;
        });
    }).catch(errorAlIniciar => {
        console.error('No se pudo configurar la zona horaria o preparar las tablas de inicio; el servidor no se iniciará:', errorAlIniciar.message);
        process.exitCode = 1;
    });
});