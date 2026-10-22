<?php
$conexion = mysqli_connect("localhost", "root", "", "centro_tramites_daniel");

if (!$conexion) {
    die("Error de conexión: " . mysqli_connect_error());
}

if ($_SERVER['REQUEST_METHOD'] == 'POST') {$categoria   = mysqli_real_escape_string($conexion,$_POST['categoria']);
    $descripcion = mysqli_real_escape_string($conexion, $_POST['descripcion']);$monto       = floatval($_POST['monto']);$fuente_pago = mysqli_real_escape_string($conexion,$_POST['fuente_pago']);

    $sql_insert = "INSERT INTO gastos (categoria, descripcion, monto, fuente_pago) VALUES ('$categoria', '$descripcion', $monto, '$fuente_pago')";
    
    if (mysqli_query($conexion,$sql_insert)) {
        header("Location: ingresos_gastos.php?exito=1");
        exit();
    } else {
        $error = "Error al guardar el gasto: " . mysqli_error($conexion);
    }
}
?>
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Control de Ingresos y Gastos - RD Gestiones</title>
    <style>
        :root {
            --bg-primary: #07090e;
            --bg-card: #141a26;
            --gold-primary: #d4af37;
            --gold-light: #f3e5ab;
            --text-main: #f0f4f8;
            --text-muted: #8c9ba5;
            --border-gold: rgba(212, 175, 55, 0.25);
        }

        body {
            background: radial-gradient(circle at top, #111726 0%, var(--bg-primary) 70%);
            color: var(--text-main);
            font-family: 'Inter', 'Segoe UI', system-ui, sans-serif;
            min-height: 100vh;
            margin: 0;
            padding: 24px;
            box-sizing: border-box;
        }

        .header-container {
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid var(--border-gold);
            padding-bottom: 16px;
            margin-bottom: 24px;
        }

        .header-container h2 {
            margin: 0;
            font-size: 1.8rem;
            font-weight: 700;
            background: linear-gradient(135deg, #fff3c4 0%, #d4af37 50%, #99750f 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }

        .btn-volver {
            background: rgba(212, 175, 55, 0.08);
            border: 1px solid var(--border-gold);
            color: var(--gold-light);
            padding: 8px 20px;
            border-radius: 30px;
            cursor: pointer;
            text-decoration: none;
            font-weight: 600;
            font-size: 0.85rem;
            transition: all 0.3s ease;
        }

        .btn-volver:hover {
            background: var(--gold-primary);
            color: #07090e;
            box-shadow: 0 4px 15px rgba(212, 175, 55, 0.3);
        }

        .grid-cards {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
            gap: 16px;
            margin-bottom: 24px;
        }

        .card-stat {
            background: var(--bg-card);
            border: 1px solid rgba(255, 255, 255, 0.05);
            border-radius: 12px;
            padding: 18px 20px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            transition: transform 0.25s ease, border-color 0.25s ease;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            position: relative;
        }

        .card-stat:hover {
            transform: translateY(-3px);
            border-color: var(--border-gold);
        }

        .card-stat h5 {
            margin: 0 0 10px 0;
            font-size: 0.82rem;
            text-transform: uppercase;
            letter-spacing: 0.8px;
            color: var(--text-muted);
            font-weight: 600;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .card-stat h3 {
            margin: 0;
            font-size: 1.5rem;
            font-weight: 700;
        }

        .card-caja {
            background: linear-gradient(145deg, rgba(46, 204, 113, 0.08) 0%, var(--bg-card) 100%);
            border: 1px solid rgba(46, 204, 113, 0.3);
        }

        .card-banco {
            background: linear-gradient(145deg, rgba(52, 152, 219, 0.08) 0%, var(--bg-card) 100%);
            border: 1px solid rgba(52, 152, 219, 0.3);
        }

        .btn-editar-manual {
            background: rgba(255, 255, 255, 0.1);
            border: none;
            color: #fff;
            padding: 3px 8px;
            border-radius: 4px;
            font-size: 0.7rem;
            cursor: pointer;
            transition: background 0.2s;
        }

        .btn-editar-manual:hover {
            background: rgba(255, 255, 255, 0.25);
        }

        .layout-dos-columnas {
            display: flex;
            gap: 24px;
        }

        .columna {
            flex: 1;
            background: var(--bg-card);
            border: 1px solid rgba(255, 255, 255, 0.05);
            border-radius: 12px;
            padding: 24px;
            box-shadow: 0 6px 16px rgba(0, 0, 0, 0.4);
        }

        .columna h3 {
            color: var(--gold-light);
            margin-top: 0;
            margin-bottom: 20px;
            font-size: 1.2rem;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
            padding-bottom: 10px;
        }

        .form-group {
            margin-bottom: 16px;
        }

        .form-group label {
            display: block;
            margin-bottom: 6px;
            font-size: 0.85rem;
            color: var(--text-muted);
        }

        .form-group input, .form-group select {
            width: 100%;
            padding: 11px;
            background: #0b0e17;
            border: 1px solid rgba(255, 255, 255, 0.1);
            color: #fff;
            border-radius: 6px;
            box-sizing: border-box;
            font-size: 0.9rem;
            transition: border-color 0.2s;
        }

        .form-group input:focus, .form-group select:focus {
            outline: none;
            border-color: var(--gold-primary);
        }

        .btn-guardar {
            background: linear-gradient(135deg, #d4af37 0%, #aa820a 100%);
            color: #07090e;
            border: none;
            padding: 12px;
            font-weight: 700;
            cursor: pointer;
            width: 100%;
            border-radius: 6px;
            font-size: 0.9rem;
            transition: transform 0.2s, box-shadow 0.2s;
        }

        .btn-guardar:hover {
            transform: translateY(-1px);
            box-shadow: 0 4px 15px rgba(212, 175, 55, 0.4);
        }

        table {
            width: 100%;
            border-collapse: collapse;
        }

        table th, table td {
            padding: 12px 14px;
            text-align: left;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
            font-size: 0.85rem;
        }

        table th {
            color: var(--gold-light);
            text-transform: uppercase;
            font-size: 0.75rem;
            letter-spacing: 0.8px;
        }

        .alerta-exito {
            background: rgba(46, 204, 113, 0.12);
            border: 1px solid rgba(46, 204, 113, 0.3);
            color: #2ecc71;
            padding: 12px;
            border-radius: 8px;
            margin-bottom: 20px;
            text-align: center;
            font-size: 0.9rem;
            font-weight: 600;
        }

        @media (max-width: 900px) {
            .layout-dos-columnas {
                flex-direction: column;
            }
        }
    </style>
</head>
<body>

    <div class="header-container">
        <h2>Control de Ingresos y Gastos</h2>
        <a href="http://localhost/FACTURADOR/menu.html" class="btn-volver">← Volver al Menú</a>
    </div>

    <!-- 7 Tarjetas Informativas -->
    <div class="grid-cards">
        <div class="card-stat">
            <h5>Total Ingresos</h5>
            <h3 id="lbl-total-ingresos" style="color: #2ecc71;">$ 0.00</h3>
        </div>
        <div class="card-stat">
            <h5>Gastos Trámites</h5>
            <h3 id="lbl-gastos-tramites" style="color: #e67e22;">$ 0.00</h3>
        </div>
        <div class="card-stat">
            <h5>Total en Caja</h5>
            <h3 id="lbl-total-en-caja" style="color: #1abc9c;">$ 0.00</h3>
        </div>
        <div class="card-stat">
            <h5>Gastos del Local</h5>
            <h3 id="lbl-gastos-local" style="color: #e74c3c;">$ 0.00</h3>
        </div>
        <div class="card-stat">
            <h5>Neto Real</h5>
            <h3 id="lbl-neto" style="color: #3498db;">$ 0.00</h3>
        </div>
        <!-- Tarjeta Efectivo en Caja con opción manual -->
        <div class="card-stat card-caja">
            <h5>
                <span>💵 Efectivo Caja</span>
                <button class="btn-editar-manual" onclick="editarBaseCaja()" title="Modificar base inicial">⚙️ Editar</button>
            </h5>
            <h3 id="lbl-caja-real" style="color: #2ecc71;">$ 0.00</h3>
        </div>
        <!-- Tarjeta Dinero en Banco con opción manual -->
        <div class="card-stat card-banco">
            <h5>
                <span>🏦 Dinero Banco</span>
                <button class="btn-editar-manual" onclick="editarBaseBanco()" title="Modificar saldo banco">⚙️ Editar</button>
            </h5>
            <h3 id="lbl-banco-real" style="color: #3498db;">$ 0.00</h3>
        </div>
    </div>

    <?php if (isset($_GET['exito'])): ?>
        <div class="alerta-exito">¡Gasto registrado con éxito y fecha automática guardada!</div>
    <?php endif; ?>

    <div class="layout-dos-columnas">
        
        <!-- COLUMNA 1: Formulario para registrar gastos manuales -->
        <div class="columna">
            <h3>Registrar Gasto Manual</h3>
            <form action="ingresos_gastos.php" method="POST">
                <div class="form-group">
                    <label>Categoría:</label>
                    <select name="categoria">
                        <option value="Servicios Públicos">Servicios Públicos</option>
                        <option value="Arriendo">Arriendo</option>
                        <option value="Nómina">Nómina</option>
                        <option value="Operativos">Gastos Operativos</option>
                        <option value="Otros">Otros</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Descripción:</label>
                    <input type="text" name="descripcion" required placeholder="Ej. Compra de papel para impresora">
                </div>
                <div class="form-group">
                    <label>Monto ($):</label>
                    <input type="number" step="0.01" name="monto" required placeholder="0.00">
                </div>
                <div class="form-group">
                    <label>Fuente de Pago:</label>
                    <input type="text" name="fuente_pago" required placeholder="Ej. Caja General, Efectivo, Banco">
                </div>
                <button type="submit" class="btn-guardar">Guardar Gasto</button>
            </form>
        </div>

        <!-- COLUMNA 2: Registro automático de Gastos -->
        <div class="columna">
            <h3>Flujo de Gastos Registrados</h3>
            <div style="max-height: 380px; overflow-y: auto;">
                <table>
                    <thead>
                        <tr>
                            <th>Fecha</th>
                            <th>Categoría</th>
                            <th>Descripción</th>
                            <th>Monto</th>
                        </tr>
                    </thead>
                    <tbody>
                        <?php
                        $resultado_gastos = mysqli_query($conexion, "SELECT * FROM gastos ORDER BY fecha DESC");

                        if ($resultado_gastos && mysqli_num_rows($resultado_gastos) > 0) {
                            while ($row = mysqli_fetch_assoc($resultado_gastos)) {
                                echo "<tr>
                                        <td style='color: var(--text-muted);'>{$row['fecha']}</td>
                                        <td>{$row['categoria']}</td>
                                        <td>{$row['descripcion']}</td>
                                        <td style='color: #e74c3c; font-weight: 600;'>$ " . number_format($row['monto'], 2) . "</td>
                                      </tr>";
                            }
                        } else {
                            echo "<tr><td colspan='4' style='text-align: center; color: var(--text-muted);'>No hay gastos registrados todavía.</td></tr>";
                        }
                        ?>
                    </tbody>
                </table>
            </div>
        </div>

    </div>

    <!-- Script de cálculo en tiempo real con soporte manual -->
    <script>
        document.addEventListener('DOMContentLoaded', cargarBalance);

        function editarBaseCaja() {
            let actual = localStorage.getItem('base_caja_manual') || '100000';
            let nuevo = prompt("Ingrese el valor manual / base inicial para Efectivo en Caja:", actual);
            if (nuevo !== null && !isNaN(nuevo)) {
                localStorage.setItem('base_caja_manual', nuevo);
                cargarBalance();
            }
        }

        function editarBaseBanco() {
            let actual = localStorage.getItem('base_banco_manual') || '0';
            let nuevo = prompt("Ingrese el valor manual o saldo inicial para Dinero en Banco:", actual);
            if (nuevo !== null && !isNaN(nuevo)) {
                localStorage.setItem('base_banco_manual', nuevo);
                cargarBalance();
            }
        }

        function cargarBalance() {
            const sedeId = localStorage.getItem('sede_activa_id') || '1';

            fetch(`http://localhost:3000/api/balance-ingresos-gastos?sedeId=${sedeId}`)
                .then(res => res.json())
                .then(data => {
                    if (data.exito) {
                        const format = num => `$ ${Number(num).toLocaleString('es-CO')}`;

                        if (document.getElementById('lbl-total-ingresos')) 
                            document.getElementById('lbl-total-ingresos').innerText = format(data.totalIngresos);
                        
                        if (document.getElementById('lbl-gastos-tramites')) 
                            document.getElementById('lbl-gastos-tramites').innerText = format(data.gastosTramites);
                        
                        if (document.getElementById('lbl-total-en-caja')) 
                            document.getElementById('lbl-total-en-caja').innerText = format(data.totalEnCaja);
                        
                        if (document.getElementById('lbl-gastos-local')) 
                            document.getElementById('lbl-gastos-local').innerText = format(data.gastosLocal);
                        
                        if (document.getElementById('lbl-neto')) 
                            document.getElementById('lbl-neto').innerText = format(data.neto);

                        // Valores calculados por el servidor
                        let cajaCalculada = Number(data.cajaReal) || 0;
                        let bancoCalculado = Number(data.bancoReal) || 0;

                        // Sobrescribir con valores manuales si el usuario los configuró
                        let baseCajaManual = localStorage.getItem('base_caja_manual');
                        if (baseCajaManual !== null) {
                            // Sumamos la base manual fija más el movimiento del sistema si se desea, o aplicamos directo:
                            // Aquí aplicamos la lógica: base manual + ingresos/gastos automáticos calculados
                            let diferenciaBase = Number(baseCajaManual) - 100000; // Ajuste respecto a la base por defecto de 100k
                            cajaCalculada += diferenciaBase;
                        }

                        let baseBancoManual = localStorage.getItem('base_banco_manual');
                        if (baseBancoManual !== null) {
                            let diferenciaBanco = Number(baseBancoManual) - 0;
                            bancoCalculado += diferenciaBanco;
                        }

                        if (document.getElementById('lbl-caja-real')) 
                            document.getElementById('lbl-caja-real').innerText = format(cajaCalculada);

                        if (document.getElementById('lbl-banco-real')) 
                            document.getElementById('lbl-banco-real').innerText = format(bancoCalculado);
                    } else {
                        console.error("Error desde el servidor:", data.error);
                    }
                })
                .catch(err => console.error("Error de conexión:", err));
        }
    </script>
</body>
</html>