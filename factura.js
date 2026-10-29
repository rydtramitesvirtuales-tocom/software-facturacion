const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout
});
const fs = require('fs');
const path = require('path');

console.log("--- SISTEMA DE CAJA CON BASE DE DATOS (DANIEL) ---");

readline.question("Ingrese el nombre del cliente: ", (cliente) => {
    readline.question("Ingrese el tipo de trámite: ", (tipoTramite) => {
        readline.question("Valor del trámite ($): ", (costoBase) => {
            readline.question("Método de pago (Efectivo / Plataforma): ", (metodoPago) => {
                const totalCobrar = Number(costoBase);
                if (!Number.isFinite(totalCobrar) || totalCobrar < 0) {
                    console.error("Ingrese un valor numérico válido para el trámite.");
                    readline.close();
                    return;
                }

                const nuevaFactura = {
                    fecha: new Date().toLocaleString(),
                    cliente: cliente.toUpperCase(),
                    tramite: tipoTramite,
                    total: totalCobrar,
                    pago: metodoPago
                };
                const textoAGuardar = `[${nuevaFactura.fecha}] Cliente: ${nuevaFactura.cliente} | Trámite: ${nuevaFactura.tramite} | Total: $${nuevaFactura.total} | Método: ${nuevaFactura.pago}\n`;

                try {
                    fs.appendFileSync(path.join(__dirname, 'caja_diaria.txt'), textoAGuardar, 'utf8');
                    console.log("\n---------------------------------------------");
                    console.log("¡FACTURA REGISTRADA Y ALMACENADA CON ÉXITO!");
                    console.log("Los datos se han guardado permanentemente en 'caja_diaria.txt'.");
                    console.log("TOTAL COBRADO: $" + totalCobrar);
                    console.log("---------------------------------------------\n");
                } catch (error) {
                    console.error("No se pudo guardar la factura:", error.message);
                    process.exitCode = 1;
                } finally {
                    readline.close();
                }
            });
        });
    });
});
