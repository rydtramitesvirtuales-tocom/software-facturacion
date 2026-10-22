const express = require('express');
const mysql = require('mysql2');
const session = require('express-session');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configuración de la sesión segura
app.use(session({
    secret: 'RDGestionesSecretKey2026',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));

// Permitir conexiones cruzadas (CORS)
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', 'http://localhost');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    next();
});

// FUNCIÓN PROTECTORA: Revisa si el dispositivo tiene sesión activa
function verificarAutenticacion(req, res, next) {
    if (req.session && req.session.usuarioAutorizado) {
        return next();
    }
    res.redirect('/login.html');
}

// PROTECCIÓN DE ARCHIVOS HTML
app.get('/', verificarAutenticacion, (req, res) => res.sendFile(__dirname + '/menu.html'));
app.get('/consola.html', verificarAutenticacion, (req, res) => res.sendFile(__dirname + '/consola.html'));
app.get('/panel.html', verificarAutenticacion, (req, res) => res.sendFile(__dirname + '/panel.html'));
app.get('/menu.html', verificarAutenticacion, (req, res) => res.sendFile(__dirname + '/menu.html'));
app.get('/control-tramites', verificarAutenticacion, (req, res) => res.sendFile(__dirname + '/tramites.html'));
app.get('/reporte-diario', verificarAutenticacion, (req, res) => res.sendFile(__dirname + '/reporte.html'));
app.get('/balance-mensual', verificarAutenticacion, (req, res) => res.sendFile(__dirname + '/balance.html'));
app.get('/seleccionar-sede', (req, res) => res.sendFile(require('path').join(__dirname, 'sedes.html')));

app.use(express.static(__dirname)); 

const conexion = mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'centro_tramites_daniel',
    port: process.env.DB_PORT || 3306,
    ssl: process.env.DB_HOST ? { rejectUnauthorized: false } : false
});
conexion.connect((error) => {
    if (error) {
        console.error("❌ Error de conexión en base de datos: " + error.message);
        return;
    }
    console.log("🚀 ¡Motor Contable Automatizado de RD Gestiones Activo!");
});

// ENDPOINT: REGISTRO DE VENTAS
app.post('/api/facturar-completa', (req, res) => {
  try {
    const celular_cliente = req.body.cellular || req.body.celular || "";
    const {
        consecutivo, nombre, documento, email,
        tramite, tramitador, pago_tramitador, destino,
        m_pago_entidad, notas
    } = req.body;

    const email_cliente = email || "";
    const v_precio_tramite = parseFloat(req.body.precio_tramite || req.body.p_tramite) || 0;
    const v_precio_tramitador = parseFloat(req.body.precio_tramitador || req.body.p_tramitador) || 0; 
    const v_pago_entidad = parseFloat(req.body.pago_entidad || req.body.p_entidad) || 0;
    const v_sede_id = parseInt(req.body.sedeId || 1);

    const sqlVenta = `INSERT INTO registro_ventas_completo 
    (consecutivo, nombre_cliente, documento_cliente, celular_cliente, email_cliente, tipo_tramite, tramitador_responsable, metodo_pago_tramitador, destino_fondos, precio_tramite, precio_tramitador, pago_entidad, observaciones_notas, sede_id) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    const valoresVenta = [
        consecutivo, nombre, documento, celular_cliente, email_cliente, 
        tramite, tramitador, pago_tramitador, destino, 
        v_precio_tramite, v_precio_tramitador, v_pago_entidad,
        notas, v_sede_id
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

// GESTIÓN DE LOGIN Y SESIÓN
app.get('/login.html', (req, res) => res.sendFile(__dirname + '/login.html'));
app.get('/login', (req, res) => res.redirect('/login.html'));

app.post('/login', (req, res) => {
    if (!req.body || Object.keys(req.body).length === 0) {
        return res.redirect('/login.html');
    }
    const usuarioInput = req.body.usuario;
    const contrasenaInput = req.body.contrasena;

    if (!usuarioInput || !contrasenaInput) {
        return res.redirect('/login.html');
    }

    const usuariosRD = [
        { usuario: 'admin', contrasena: 'rd1234', rol: 'ADMINISTRADOR', nombre_real: 'Daniel García' },
        { usuario: 'aprendiz', contrasena: 'rd1234', rol: 'APRENDIZ', nombre_real: 'Funcionario Aprendiz' }
    ];

    const usuarioEncontrado = usuariosRD.find(u => u.usuario === usuarioInput.trim() && u.contrasena === contrasenaInput.trim());

    if (usuarioEncontrado) {
        req.session.usuarioAutorizado = true;
        req.session.nombreUsuario = usuarioEncontrado.nombre_real;
        req.session.rolUsuario = usuarioEncontrado.rol;
        res.redirect('/seleccionar-sede');
    } else {
        return res.send("<script>alert('Usuario o contraseña incorrectos en RD Gestiones.'); window.location.href='/login.html';</script>");
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login.html');
});

// ==========================================
// ENDPOINT: REPORTE FINANCIERO DIARIO
// ==========================================
app.get('/api/reporte-contable-diario', (req, res) => {
    const sedeId = req.query.sedeId || 1;

    const sqlUniversal = `
        SELECT 
            COALESCE(SUM(precio_tramite), 0) as ingresos,
            COALESCE(SUM(precio_tramitador), 0) as tramitadores,
            COALESCE(SUM(pago_entidad), 0) as entidades
        FROM registro_ventas_completo
        WHERE sede_id = ?
    `;

    conexion.query(sqlUniversal, [sedeId], (err, results) => {
        if (err) {
            console.error("❌ Error en MySQL Diario:", err);
            return res.status(500).json({ exito: false });
        }

        const filas = JSON.parse(JSON.stringify(results));
        const data = (filas && filas.length > 0) ? filas[0] : { ingresos: 0, tramitadores: 0, entidades: 0 };

        const ingresos = parseFloat(data.ingresos) || 0;
        const tramitadores = parseFloat(data.tramitadores) || 0;
        const entidades = parseFloat(data.entidades) || 0;

        const neto = ingresos - (tramitadores + entidades);
        const fechaFormateada = new Date().toLocaleDateString('es-CO');

        res.json({
            exito: true,
            fecha: fechaFormateada,
            ingresos: ingresos,
            entidades: entidades,
            tramitadores: tramitadores,
            neto: neto
        });
    });
});

// ==========================================
// ENDPOINT: BALANCE MENSUAL DE FLUJOS (CORREGIDO Y RESTABLECIDO)
// ==========================================
app.get('/api/reporte-contable-mensual', (req, res) => {
  const sedeId = parseInt(req.query.sedeId || 1);

  const sqlMensual = `
    SELECT 
      destino_fondos,
      metodo_pago_tramitador,
      metodo_pago_entidad,
      COALESCE(SUM(precio_tramite), 0) AS ingresos_totales,
      COALESCE(SUM(precio_tramitador), 0) AS egresos_tramitador,
      COALESCE(SUM(pago_entidad), 0) AS egresos_entidad
    FROM registro_ventas_completo
    WHERE (sede_id = ? OR ? = 1)
      AND MONTH(fecha_hora) = MONTH(CURDATE()) 
      AND YEAR(fecha_hora) = YEAR(CURDATE())
    GROUP BY destino_fondos, metodo_pago_tramitador, metodo_pago_entidad
  `;

  conexion.query(sqlMensual, [sedeId, sedeId], (err, results) => {
    if (err) {
      console.error("❌ Error en MySQL Mensual:", err);
      return res.status(500).json({ exito: false, error: err.message });
    }

    const reporte = {
      efectivo_ingresos: 0,
      efectivo_egresos: 0,
      cuentas_ingresos: 0,
      cuentas_egresos: 0
    };

    (results || []).forEach(fila => {
      const destino = (fila.destino_fondos || "").toUpperCase();
      const pagoTramitador = (fila.metodo_pago_tramitador || "").toUpperCase();
      const pagoEntidad = (fila.metodo_pago_entidad || "").toUpperCase();

      const ing = parseFloat(fila.ingresos_totales) || 0;
      const egTram = parseFloat(fila.egresos_tramitador) || 0;
      const egEnt = parseFloat(fila.egresos_entidad) || 0;

      // Ingresos
      if (destino.includes('EFECTIVO') || destino.includes('CAJA')) {
        reporte.efectivo_ingresos += ing;
      } else {
        reporte.cuentas_ingresos += ing;
      }

      // Egresos Tramitador
      if (pagoTramitador.includes('EFECTIVO') || pagoTramitador.includes('CAJA')) {
        reporte.efectivo_egresos += egTram;
      } else {
        reporte.cuentas_egresos += egTram;
      }

      // Egresos Entidad
      if (pagoEntidad.includes('EFECTIVO') || pagoEntidad.includes('CAJA')) {
        reporte.efectivo_egresos += egEnt;
      } else {
        reporte.cuentas_egresos += egEnt;
      }
    });

    const cajaReal = reporte.efectivo_ingresos - reporte.efectivo_egresos;
    const bancoReal = reporte.cuentas_ingresos - reporte.cuentas_egresos;

    res.json({
      exito: true,
      efectivo_ingresos: reporte.efectivo_ingresos,
      efectivo_egresos: reporte.efectivo_egresos,
      caja_real: cajaReal,
      cuentas_ingresos: reporte.cuentas_ingresos,
      cuentas_egresos: reporte.cuentas_egresos,
      banco_real: bancoReal
    });
  });
});

// ==========================================
// MÓDULO: CONTROL DE TRÁMITES (FILAS INDIVIDUALES)
// ==========================================
app.get('/api/listar-tramites', (req, res) => {
    const sedeId = req.query.sedeId || '1';
    const query = "SELECT * FROM registro_ventas_completo";
    
    conexion.query(query, (err, results) => {
        if (err) {
            console.error("Error en la consulta SQL:", err.message);
            return res.json({ exito: false, lista: [], error: err.message });
        }
        
        const listaFiltrada = (results || []).filter(item => {
            if (item.sede_id === undefined || item.sede_id === null || item.sede_id === '') return true;
            return String(item.sede_id) === String(sedeId);
        });

        res.json({ exito: true, lista: listaFiltrada });
    });
});

// 1. Cambiar estado operativo del trámite
// 1. Cambiar estado operativo del trámite por id_registro
app.post('/api/cambiar-estado-tramite', (req, res) => {
    const { id, estadoActual } = req.body;
    const nuevoEstado = (estadoActual === 'LISTO' || estadoActual === 'FINALIZADO') ? 'PENDIENTE' : 'LISTO';

    const sql = `UPDATE registro_ventas_completo SET estado = ? WHERE id_registro = ?`;

    conexion.query(sql, [nuevoEstado, id], (err, result) => {
        if (err) {
            console.error("Error al actualizar estado:", err.message);
            return res.json({ exito: false, error: err.message });
        }
        res.json({ exito: true, nuevoEstado });
    });
});

// 2. Cambiar estado de pago por id_registro
app.post('/api/cambiar-estado-pago', (req, res) => {
    const { id, estadoPagoActual } = req.body;
    const nuevoEstadoPago = (estadoPagoActual === 'PAGADO') ? 'PENDIENTE' : 'PAGADO';

    const sql = `UPDATE registro_ventas_completo SET estado_pago = ? WHERE id_registro = ?`;

    conexion.query(sql, [nuevoEstadoPago, id], (err, result) => {
        if (err) {
            console.error("Error al actualizar pago:", err.message);
            return res.json({ exito: false, error: err.message });
        }
        res.json({ exito: true, nuevoEstadoPago });
    });
});
// CONSECUTIVO AUTOMÁTICO DE VENTAS
app.get('/api/obtener-siguiente-consecutivo', (req, res) => {
    if (!req.session || !req.session.usuarioAutorizado) {
        return res.status(401).json({ exito: false, mensaje: "No autenticado" });
    }

    const sqlContar = "SELECT COUNT(*) as total FROM registro_ventas_completo";

    conexion.query(sqlContar, (err, results) => {
        if (err) {
            console.error("Error al contar registros en MySQL:", err);
            return res.status(500).json({ exito: false, siguiente: "FAC-2026-001" });
        }

        const filas = JSON.parse(JSON.stringify(results));
        const totalRegistros = filas[0].total || 0;
        const numeroSiguiente = totalRegistros + 1;
        const siguienteConsecutivo = `FAC-2026-${String(numeroSiguiente).padStart(3, '0')}`;

        res.json({ exito: true, siguiente: siguienteConsecutivo });
    });
});

// RUTA CONSOLIDADA: BALANCE INGRESOS Y GASTOS (CAJA / BANCO)
app.get('/api/balance-ingresos-gastos', (req, res) => {
    const sedeId = req.query.sedeId || '1';

    const sqlVentas = `
        SELECT 
            destino_fondos,
            COALESCE(SUM(precio_tramite), 0) AS ingresos,
            COALESCE(SUM(precio_tramitador + pago_entidad), 0) AS gastosTramites
        FROM registro_ventas_completo 
        WHERE (sede_id = ? OR ? = '1')
        AND MONTH(fecha_hora) = MONTH(NOW())
        AND YEAR(fecha_hora) = YEAR(NOW())
        GROUP BY destino_fondos
    `;

    const sqlGastosLocal = `
        SELECT fuente_pago, COALESCE(SUM(monto), 0) AS gastosLocal
        FROM gastos
        GROUP BY fuente_pago
    `;

    conexion.query(sqlVentas, [sedeId, sedeId], (err, resVentas) => {
        if (err) {
            console.error("Error en ventas:", err.message);
            return res.json({ exito: false, error: err.message });
        }

        conexion.query(sqlGastosLocal, (errG, resGastos) => {
            if (errG) {
                console.error("Error en gastos:", errG.message);
                return res.json({ exito: false, error: errG.message });
            }

            let totalIngresos = 0;
            let gastosTramites = 0;
            let ingresoCaja = 0;
            let ingresoBanco = 0;

            (resVentas || []).forEach(row => {
                const ingresosFila = Number(row.ingresos) || 0;
                const gastosFila = Number(row.gastosTramites) || 0;
                const destino = (row.destino_fondos || "").toUpperCase();

                totalIngresos += ingresosFila;
                gastosTramites += gastosFila;

                if (destino.includes('EFECTIVO') || destino.includes('CAJA')) {
                    ingresoCaja += (ingresosFila - gastosFila);
                } else {
                    ingresoBanco += (ingresosFila - gastosFila);
                }
            });

            let gastosCajaLocal = 0;
            let gastosBancoLocal = 0;

            (resGastos || []).forEach(row => {
                const monto = Number(row.gastosLocal) || 0;
                const fuente = (row.fuente_pago || "").toUpperCase();

                if (fuente.includes('EFECTIVO') || fuente.includes('CAJA')) {
                    gastosCajaLocal += monto;
                } else {
                    gastosBancoLocal += monto;
                }
            });

            const totalEnCajaGeneral = totalIngresos - gastosTramites;
            const gastosLocalTotal = gastosCajaLocal + gastosBancoLocal;
            const neto = totalEnCajaGeneral - gastosLocalTotal;

            const cajaReal = ingresoCaja - gastosCajaLocal;
            const bancoReal = ingresoBanco - gastosBancoLocal;

            res.json({
                exito: true,
                totalIngresos,
                gastosTramites,
                totalEnCaja: totalEnCajaGeneral,
                gastosLocal: gastosLocalTotal,
                neto,
                cajaReal,   
                bancoReal   
            });
        });
    });
});

app.listen(PORT, () => {
    console.log(`📡 Servidor Contable RD corriendo en: http://localhost:${PORT}`);
const express = require('express');
const mysql = require('mysql2');
const session = require('express-session');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configuración de la sesión segura
app.use(session({
    secret: 'RDGestionesSecretKey2026',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));

// Permitir conexiones cruzadas (CORS)
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', 'http://localhost');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    next();
});

// FUNCIÓN PROTECTORA: Revisa si el dispositivo tiene sesión activa
function verificarAutenticacion(req, res, next) {
    if (req.session && req.session.usuarioAutorizado) {
        return next();
    }
    res.redirect('/login.html');
}

// PROTECCIÓN DE ARCHIVOS HTML
app.get('/', verificarAutenticacion, (req, res) => res.sendFile(__dirname + '/menu.html'));
app.get('/consola.html', verificarAutenticacion, (req, res) => res.sendFile(__dirname + '/consola.html'));
app.get('/panel.html', verificarAutenticacion, (req, res) => res.sendFile(__dirname + '/panel.html'));
app.get('/menu.html', verificarAutenticacion, (req, res) => res.sendFile(__dirname + '/menu.html'));
app.get('/control-tramites', verificarAutenticacion, (req, res) => res.sendFile(__dirname + '/tramites.html'));
app.get('/reporte-diario', verificarAutenticacion, (req, res) => res.sendFile(__dirname + '/reporte.html'));
app.get('/balance-mensual', verificarAutenticacion, (req, res) => res.sendFile(__dirname + '/balance.html'));
app.get('/seleccionar-sede', (req, res) => res.sendFile(require('path').join(__dirname, 'sedes.html')));

app.use(express.static(__dirname)); 

// CONEXIÓN A MYSQL EN XAMPP
const conexion = mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',      
    password: process.env.DB_PASSWORD || '',      
    database: process.env.DB_NAME || 'centro_tramites_daniel' 
});
conexion.connect((error) => {
    if (error) {
        console.error("❌ Error de conexión en base de datos: " + error.message);
        return;
    }
    console.log("🚀 ¡Motor Contable Automatizado de RD Gestiones Activo!");
});

// ENDPOINT: REGISTRO DE VENTAS
app.post('/api/facturar-completa', (req, res) => {
  try {
    const celular_cliente = req.body.cellular || req.body.celular || "";
    const {
        consecutivo, nombre, documento, email,
        tramite, tramitador, pago_tramitador, destino,
        m_pago_entidad, notas
    } = req.body;

    const email_cliente = email || "";
    const v_precio_tramite = parseFloat(req.body.precio_tramite || req.body.p_tramite) || 0;
    const v_precio_tramitador = parseFloat(req.body.precio_tramitador || req.body.p_tramitador) || 0; 
    const v_pago_entidad = parseFloat(req.body.pago_entidad || req.body.p_entidad) || 0;
    const v_sede_id = parseInt(req.body.sedeId || 1);

    const sqlVenta = `INSERT INTO registro_ventas_completo 
    (consecutivo, nombre_cliente, documento_cliente, celular_cliente, email_cliente, tipo_tramite, tramitador_responsable, metodo_pago_tramitador, destino_fondos, precio_tramite, precio_tramitador, pago_entidad, observaciones_notas, sede_id) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    const valoresVenta = [
        consecutivo, nombre, documento, celular_cliente, email_cliente, 
        tramite, tramitador, pago_tramitador, destino, 
        v_precio_tramite, v_precio_tramitador, v_pago_entidad,
        notas, v_sede_id
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

// GESTIÓN DE LOGIN Y SESIÓN
app.get('/login.html', (req, res) => res.sendFile(__dirname + '/login.html'));
app.get('/login', (req, res) => res.redirect('/login.html'));

app.post('/login', (req, res) => {
    if (!req.body || Object.keys(req.body).length === 0) {
        return res.redirect('/login.html');
    }
    const usuarioInput = req.body.usuario;
    const contrasenaInput = req.body.contrasena;

    if (!usuarioInput || !contrasenaInput) {
        return res.redirect('/login.html');
    }

    const usuariosRD = [
        { usuario: 'admin', contrasena: 'rd1234', rol: 'ADMINISTRADOR', nombre_real: 'Daniel García' },
        { usuario: 'aprendiz', contrasena: 'rd1234', rol: 'APRENDIZ', nombre_real: 'Funcionario Aprendiz' }
    ];

    const usuarioEncontrado = usuariosRD.find(u => u.usuario === usuarioInput.trim() && u.contrasena === contrasenaInput.trim());

    if (usuarioEncontrado) {
        req.session.usuarioAutorizado = true;
        req.session.nombreUsuario = usuarioEncontrado.nombre_real;
        req.session.rolUsuario = usuarioEncontrado.rol;
        res.redirect('/seleccionar-sede');
 } else {
    return res.send("<script>alert('Usuario o contraseña incorrectos en RD Gestiones.'); window.location.href='/login.html';</script>");
}
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login.html');
});

// ==========================================
// ENDPOINT: REPORTE FINANCIERO DIARIO
// ==========================================
app.get('/api/reporte-contable-diario', (req, res) => {
    const sedeId = req.query.sedeId || 1;

    const sqlUniversal = `
        SELECT 
            COALESCE(SUM(precio_tramite), 0) as ingresos,
            COALESCE(SUM(precio_tramitador), 0) as tramitadores,
            COALESCE(SUM(pago_entidad), 0) as entidades
        FROM registro_ventas_completo
        WHERE sede_id = ?
    `;

    conexion.query(sqlUniversal, [sedeId], (err, results) => {
        if (err) {
            console.error("❌ Error en MySQL Diario:", err);
            return res.status(500).json({ exito: false });
        }

        const filas = JSON.parse(JSON.stringify(results));
        const data = (filas && filas.length > 0) ? filas[0] : { ingresos: 0, tramitadores: 0, entidades: 0 };

        const ingresos = parseFloat(data.ingresos) || 0;
        const tramitadores = parseFloat(data.tramitadores) || 0;
        const entidades = parseFloat(data.entidades) || 0;

        const neto = ingresos - (tramitadores + entidades);
        const fechaFormateada = new Date().toLocaleDateString('es-CO');

        res.json({
            exito: true,
            fecha: fechaFormateada,
            ingresos: ingresos,
            entidades: entidades,
            tramitadores: tramitadores,
            neto: neto
        });
    });
});

// ==========================================
// ENDPOINT: BALANCE MENSUAL DE FLUJOS (CORREGIDO Y RESTABLECIDO)
// ==========================================
app.get('/api/reporte-contable-mensual', (req, res) => {
  const sedeId = parseInt(req.query.sedeId || 1);

  const sqlMensual = `
    SELECT 
      destino_fondos,
      metodo_pago_tramitador,
      metodo_pago_entidad,
      COALESCE(SUM(precio_tramite), 0) AS ingresos_totales,
      COALESCE(SUM(precio_tramitador), 0) AS egresos_tramitador,
      COALESCE(SUM(pago_entidad), 0) AS egresos_entidad
    FROM registro_ventas_completo
    WHERE (sede_id = ? OR ? = 1)
      AND MONTH(fecha_hora) = MONTH(CURDATE()) 
      AND YEAR(fecha_hora) = YEAR(CURDATE())
    GROUP BY destino_fondos, metodo_pago_tramitador, metodo_pago_entidad
  `;

  conexion.query(sqlMensual, [sedeId, sedeId], (err, results) => {
    if (err) {
      console.error("❌ Error en MySQL Mensual:", err);
      return res.status(500).json({ exito: false, error: err.message });
    }

    const reporte = {
      efectivo_ingresos: 0,
      efectivo_egresos: 0,
      cuentas_ingresos: 0,
      cuentas_egresos: 0
    };

    (results || []).forEach(fila => {
      const destino = (fila.destino_fondos || "").toUpperCase();
      const pagoTramitador = (fila.metodo_pago_tramitador || "").toUpperCase();
      const pagoEntidad = (fila.metodo_pago_entidad || "").toUpperCase();

      const ing = parseFloat(fila.ingresos_totales) || 0;
      const egTram = parseFloat(fila.egresos_tramitador) || 0;
      const egEnt = parseFloat(fila.egresos_entidad) || 0;

      // Ingresos
      if (destino.includes('EFECTIVO') || destino.includes('CAJA')) {
        reporte.efectivo_ingresos += ing;
      } else {
        reporte.cuentas_ingresos += ing;
      }

      // Egresos Tramitador
      if (pagoTramitador.includes('EFECTIVO') || pagoTramitador.includes('CAJA')) {
        reporte.efectivo_egresos += egTram;
      } else {
        reporte.cuentas_egresos += egTram;
      }

      // Egresos Entidad
      if (pagoEntidad.includes('EFECTIVO') || pagoEntidad.includes('CAJA')) {
        reporte.efectivo_egresos += egEnt;
      } else {
        reporte.cuentas_egresos += egEnt;
      }
    });

    const cajaReal = reporte.efectivo_ingresos - reporte.efectivo_egresos;
    const bancoReal = reporte.cuentas_ingresos - reporte.cuentas_egresos;

    res.json({
      exito: true,
      efectivo_ingresos: reporte.efectivo_ingresos,
      efectivo_egresos: reporte.efectivo_egresos,
      caja_real: cajaReal,
      cuentas_ingresos: reporte.cuentas_ingresos,
      cuentas_egresos: reporte.cuentas_egresos,
      banco_real: bancoReal
    });
  });
});

// ==========================================
// MÓDULO: CONTROL DE TRÁMITES (FILAS INDIVIDUALES)
// ==========================================
app.get('/api/listar-tramites', (req, res) => {
    const sedeId = req.query.sedeId || '1';
    const query = "SELECT * FROM registro_ventas_completo";
    
    conexion.query(query, (err, results) => {
        if (err) {
            console.error("Error en la consulta SQL:", err.message);
            return res.json({ exito: false, lista: [], error: err.message });
        }
        
        const listaFiltrada = (results || []).filter(item => {
            if (item.sede_id === undefined || item.sede_id === null || item.sede_id === '') return true;
            return String(item.sede_id) === String(sedeId);
        });

        res.json({ exito: true, lista: listaFiltrada });
    });
});

// 1. Cambiar estado operativo del trámite
// 1. Cambiar estado operativo del trámite por id_registro
app.post('/api/cambiar-estado-tramite', (req, res) => {
    const { id, estadoActual } = req.body;
    const nuevoEstado = (estadoActual === 'LISTO' || estadoActual === 'FINALIZADO') ? 'PENDIENTE' : 'LISTO';

    const sql = `UPDATE registro_ventas_completo SET estado = ? WHERE id_registro = ?`;

    conexion.query(sql, [nuevoEstado, id], (err, result) => {
        if (err) {
            console.error("Error al actualizar estado:", err.message);
            return res.json({ exito: false, error: err.message });
        }
        res.json({ exito: true, nuevoEstado });
    });
});

// 2. Cambiar estado de pago por id_registro
app.post('/api/cambiar-estado-pago', (req, res) => {
    const { id, estadoPagoActual } = req.body;
    const nuevoEstadoPago = (estadoPagoActual === 'PAGADO') ? 'PENDIENTE' : 'PAGADO';

    const sql = `UPDATE registro_ventas_completo SET estado_pago = ? WHERE id_registro = ?`;

    conexion.query(sql, [nuevoEstadoPago, id], (err, result) => {
        if (err) {
            console.error("Error al actualizar pago:", err.message);
            return res.json({ exito: false, error: err.message });
        }
        res.json({ exito: true, nuevoEstadoPago });
    });
});
// CONSECUTIVO AUTOMÁTICO DE VENTAS
app.get('/api/obtener-siguiente-consecutivo', (req, res) => {
    if (!req.session || !req.session.usuarioAutorizado) {
        return res.status(401).json({ exito: false, mensaje: "No autenticado" });
    }

    const sqlContar = "SELECT COUNT(*) as total FROM registro_ventas_completo";

    conexion.query(sqlContar, (err, results) => {
        if (err) {
            console.error("Error al contar registros en MySQL:", err);
            return res.status(500).json({ exito: false, siguiente: "FAC-2026-001" });
        }

        const filas = JSON.parse(JSON.stringify(results));
        const totalRegistros = filas[0].total || 0;
        const numeroSiguiente = totalRegistros + 1;
        const siguienteConsecutivo = `FAC-2026-${String(numeroSiguiente).padStart(3, '0')}`;

        res.json({ exito: true, siguiente: siguienteConsecutivo });
    });
});

// RUTA CONSOLIDADA: BALANCE INGRESOS Y GASTOS (CAJA / BANCO)
app.get('/api/balance-ingresos-gastos', (req, res) => {
    const sedeId = req.query.sedeId || '1';

    const sqlVentas = `
        SELECT 
            destino_fondos,
            COALESCE(SUM(precio_tramite), 0) AS ingresos,
            COALESCE(SUM(precio_tramitador + pago_entidad), 0) AS gastosTramites
        FROM registro_ventas_completo 
        WHERE (sede_id = ? OR ? = '1')
        AND MONTH(fecha_hora) = MONTH(NOW())
        AND YEAR(fecha_hora) = YEAR(NOW())
        GROUP BY destino_fondos
    `;

    const sqlGastosLocal = `
        SELECT fuente_pago, COALESCE(SUM(monto), 0) AS gastosLocal
        FROM gastos
        GROUP BY fuente_pago
    `;

    conexion.query(sqlVentas, [sedeId, sedeId], (err, resVentas) => {
        if (err) {
            console.error("Error en ventas:", err.message);
            return res.json({ exito: false, error: err.message });
        }

        conexion.query(sqlGastosLocal, (errG, resGastos) => {
            if (errG) {
                console.error("Error en gastos:", errG.message);
                return res.json({ exito: false, error: errG.message });
            }

            let totalIngresos = 0;
            let gastosTramites = 0;
            let ingresoCaja = 0;
            let ingresoBanco = 0;

            (resVentas || []).forEach(row => {
                const ingresosFila = Number(row.ingresos) || 0;
                const gastosFila = Number(row.gastosTramites) || 0;
                const destino = (row.destino_fondos || "").toUpperCase();

                totalIngresos += ingresosFila;
                gastosTramites += gastosFila;

                if (destino.includes('EFECTIVO') || destino.includes('CAJA')) {
                    ingresoCaja += (ingresosFila - gastosFila);
                } else {
                    ingresoBanco += (ingresosFila - gastosFila);
                }
            });

            let gastosCajaLocal = 0;
            let gastosBancoLocal = 0;

            (resGastos || []).forEach(row => {
                const monto = Number(row.gastosLocal) || 0;
                const fuente = (row.fuente_pago || "").toUpperCase();

                if (fuente.includes('EFECTIVO') || fuente.includes('CAJA')) {
                    gastosCajaLocal += monto;
                } else {
                    gastosBancoLocal += monto;
                }
            });

            const totalEnCajaGeneral = totalIngresos - gastosTramites;
            const gastosLocalTotal = gastosCajaLocal + gastosBancoLocal;
            const neto = totalEnCajaGeneral - gastosLocalTotal;

            const cajaReal = ingresoCaja - gastosCajaLocal;
            const bancoReal = ingresoBanco - gastosBancoLocal;

            res.json({
                exito: true,
                totalIngresos,
                gastosTramites,
                totalEnCaja: totalEnCajaGeneral,
                gastosLocal: gastosLocalTotal,
                neto,
                cajaReal,   
                bancoReal   
            });
        });
    });
});
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`📡 Servidor Contable RD corriendo en el puerto ${PORT}`);
    console.log(`🚀 ¡Motor Contable Automatizado de RD Gestiones Activo!`);
});