'use strict';
/**
 * CLIENTE SOAP de IRelacionClinica (scheduling-service)  - TFU5
 *
 * records-service CONSUME el servicio SOAP en vez del viejo endpoint REST.
 * El cliente se genera en tiempo de ejecucion a partir del WSDL publicado por
 * scheduling (contract-first): si el contrato cambia de forma incompatible,
 * el cliente falla al crearse en vez de interpretar mal un JSON.
 *
 * Proteccion frente a las falacias de red:
 *  - TIMEOUT por llamada (SOAP_TIMEOUT_MS): "la latencia es cero" es falso; no
 *    nos colgamos esperando.
 *  - CIRCUIT BREAKER (el mismo de la TFU4, ahora generico): si scheduling no
 *    responde, dejamos de llamarlo por un rato y fallamos al instante.
 *  - FAIL-SECURE en el llamador: si no hay respuesta, el acceso se NIEGA.
 */
const soap = require('soap');
const config = require('../../shared/config');
const { conCircuito } = require('../../shared/httpClient');

const RUTA = '/soap/relacion-clinica';
const HOST_BREAKER = 'scheduling-soap';
let clientePromesa = null;

async function obtenerCliente() {
  if (!clientePromesa) {
    const endpoint = `${config.urls.scheduling}${RUTA}`;
    clientePromesa = soap.createClientAsync(`${endpoint}?wsdl`, {
      wsdl_options: { timeout: config.soapTimeoutMs }
    }).then((cliente) => {
      // El WSDL anuncia http://scheduling:3000; lo forzamos a la URL configurada.
      cliente.setEndpoint(endpoint);
      cliente.addHttpHeader('X-Internal-Token', config.internalToken);
      return cliente;
    }).catch((err) => {
      clientePromesa = null;           // reintentar crear el cliente la proxima vez
      throw err;
    });
  }
  return clientePromesa;
}

/**
 * Invoca ConsultarRelacionClinica. Devuelve
 *   { ok: true, consultaEnCurso, citaId, xmlRespuesta }   o
 *   { ok: false, circuitoAbierto, motivo }
 */
async function consultarRelacionClinica(medicoId, pacienteId, correlationId) {
  const r = await conCircuito(HOST_BREAKER, async () => {
    const cliente = await obtenerCliente();
    try {
      const [resultado, xmlRespuesta] = await cliente.ConsultarRelacionClinicaAsync(
        { medicoId, pacienteId },
        { timeout: config.soapTimeoutMs },
        { 'X-Correlation-Id': correlationId || 'sin-cid' });
      return { resultado, xmlRespuesta };
    } catch (err) {
      // soap:Client = el pedido estaba mal (equivale a un 4xx): no abre el circuito.
      const fault = err && err.root && err.root.Envelope && err.root.Envelope.Body
        && err.root.Envelope.Body.Fault;
      if (fault && String(fault.faultcode).includes('Client')) {
        const e = new Error(`SOAP Fault: ${fault.faultstring}`);
        e.esCliente = true;
        throw e;
      }
      throw err;
    }
  });
  if (!r.ok) return r;
  const res = r.valor.resultado || {};
  const enCurso = res.consultaEnCurso === true || res.consultaEnCurso === 'true';
  return { ok: true, consultaEnCurso: enCurso, citaId: res.citaId || null, xmlRespuesta: r.valor.xmlRespuesta };
}

module.exports = { consultarRelacionClinica };
