// Importamos los módulos para interactuar con la terminal (readline) y con el disco duro (fs)
const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout
});
const fs = require('fs'); 

console.log("--- SISTEMA DE CAJA CON BASE DE DATOS (DANIEL) ---");

// 1. Capturamos los datos dinámicamente
readline.question("Ingrese el nombre del cliente: ", (cliente) => {
    readline.question("Ingrese el tipo de trámite: ", (tipoTramite) => {
        readline.question("Valor del trámite (\$): ", (costoBase) => {
            readline.question("Método de pago (Efectivo / Plataforma): ", (metodoPago) => {
                
                const totalCobrar = Number(costoBase);
                // Creamos una marca de tiempo con la fecha y hora exacta de la venta
                const fechaActual = new Date().toLocaleString();

                // 2. CREAMOS EL OBJETO DE DATOS (La estructura que irá a la base de datos)
             // 2. CREAMOS EL OBJETO DE DATOS (La estructura que irá a la base de datos)
const nuevaFactura = {
    fecha: fechaActual,
    cliente: cliente.toUpperCase(),
    tramite: tipoTramite,
    total: totalCobrar,
    pago: metodoPago,
    sedeId: 1  // <--- 📌 CAMBIA ESTE NÚMERO SEGÚN LA SEDE: 1 para Alpujarra, 2 para Caracas
};

                // 3. LOGICA DE PERSISTENCIA: Guardamos en un archivo de texto plano llamado 'caja_diaria.txt'
                // '\n' sirve para hacer un salto de línea en el archivo de texto por cada factura nueva
                const textoAGuardar = `[${nuevaFactura.fecha}] Cliente: ${nuevaFactura.cliente} | Trámite: ${nuevaFactura.tramite} | Total: $${nuevaFactura.total} | Método: ${nuevaFactura.pago}\n`;

                // fs.appendFileSync se encarga de agregar texto al final del archivo sin borrar lo anterior
                fs.appendFileSync('caja_diaria.txt', textoAGuardar, 'utf8');

                // 4. Mostramos el resultado en pantalla
                console.log("\n---------------------------------------------");
                console.log("¡FACTURA REGISTRADA Y ALMACENADA CON ÉXITO!");
                console.log("Los datos se han guardado permanentemente en 'caja_diaria.txt'.");
                console.log("TOTAL COBRADO: \$" + totalCobrar);
                console.log("---------------------------------------------\n");

                readline.close();
            });
        });
    });
});
