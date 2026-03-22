const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const TOKEN = '8545753030:AAFzvYB9x-7oTa4U5eeIbe58RiwFzwf2z0s';
const TELEGRAM = `https://api.telegram.org/bot${TOKEN}`;
const SHEET_API = 'https://script.google.com/macros/s/AKfycbxMk5piQaBgdWZtG2-xZwYNqi4WHTXeLhAaaFVynFlsn4gB9wGrrjgzHtHuC7yeAzpQCQ/exec';

// Estado de conversación por usuario
const estados = {};

function estado(chatId) {
  if (!estados[chatId]) estados[chatId] = { paso: 'inicio', data: {} };
  return estados[chatId];
}

async function send(chatId, text, buttons) {
  const payload = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (buttons) {
    payload.reply_markup = {
      inline_keyboard: buttons.map(row =>
        Array.isArray(row)
          ? row.map(b => ({ text: b, callback_data: b }))
          : [{ text: row, callback_data: row }]
      )
    };
  }
  await axios.post(`${TELEGRAM}/sendMessage`, payload);
}

async function apiSheet(params) {
  const url = SHEET_API + '?' + new URLSearchParams(params).toString();
  const r = await axios.get(url);
  return r.data;
}

async function procesarMensaje(chatId, texto) {
  const e = estado(chatId);

  // INICIO — pedir DNI
  if (e.paso === 'inicio' || texto === '/start') {
    e.paso = 'esperando_dni';
    e.data = {};
    await send(chatId, '⛺ <b>CAMPAMENTO — Control de Hospedaje</b>\n\nHola, ingresa tu <b>DNI</b> para continuar:');
    return;
  }

  // ESPERANDO DNI
  if (e.paso === 'esperando_dni') {
    const dni = texto.trim();
    if (dni.length < 6) {
      await send(chatId, '⚠️ DNI inválido. Ingresa tu número de documento sin puntos ni guiones.');
      return;
    }
    await send(chatId, '🔍 Buscando tu registro...');
    try {
      const j = await apiSheet({ action: 'buscar', dni });
      if (j.error) throw new Error(j.error);
      if (j.data.encontrado) {
        e.data.worker = j.data;
        e.paso = j.data.necesita_turno ? 'esperando_turno' : 'esperando_accion';
        const w = j.data;
        const esB = String(w.campamento).includes('B');
        const ubic = esB ? `${w.sector} · Comp. ${w.compartimiento} · ${w.cama}` : `${w.sector} · Hab. ${w.habitacion}`;
        let msg = `✅ <b>${w.nombre} ${w.apellidos}</b>\n`;
        msg += `📍 ${w.campamento} — ${ubic}\n`;
        msg += `🔄 Régimen: <b>${w.regimen}</b>`;
        if (w.estado === 'PRESENTE') msg += '\n🟢 Estado actual: PRESENTE';
        else msg += '\n🔴 Estado actual: AUSENTE';

        if (j.data.necesita_turno) {
          await send(chatId, msg + '\n\n¿En qué turno estás hoy?', [['☀️ Turno Día', '🌙 Turno Noche']]);
        } else {
          await send(chatId, msg + '\n\n¿Qué registras?', [['✅ ENTRADA', '🚪 SALIDA']]);
        }
      } else {
        // No registrado — iniciar registro
        e.data.dni = dni;
        e.paso = 'reg_nombre';
        await send(chatId, `❌ DNI <b>${dni}</b> no está registrado.\n\n📋 Vamos a registrarte. Solo lo haces una vez.\n\n¿Cuál es tu <b>nombre</b>?`);
      }
    } catch(err) {
      await send(chatId, '❌ Error de conexión. Intenta de nuevo escribiendo tu DNI.');
      e.paso = 'esperando_dni';
    }
    return;
  }

  // FLUJO REGISTRO
  if (e.paso === 'reg_nombre') {
    e.data.nombre = texto.trim();
    e.paso = 'reg_apellido';
    await send(chatId, '¿Cuáles son tus <b>apellidos</b>?');
    return;
  }
  if (e.paso === 'reg_apellido') {
    e.data.apellidos = texto.trim();
    e.paso = 'reg_cargo';
    await send(chatId, '¿Cuál es tu <b>cargo</b>?', [['Operario', 'Supervisor'], ['Jefe', 'Superintendente']]);
    return;
  }
  if (e.paso === 'reg_genero') {
    e.data.genero = texto.trim();
    e.paso = 'reg_campamento';
    await send(chatId, '¿En qué <b>campamento</b> te alojas?', [['Campamento A', 'Campamento B']]);
    return;
  }

  // FLUJO MARCAR TURNO (usuario registrado 14x7)
  if (e.paso === 'esperando_turno') {
    const turno = texto.includes('Día') ? 'Turno Día' : 'Turno Noche';
    e.data.turno = turno;
    e.paso = 'esperando_accion';
    await send(chatId, `Turno: <b>${turno}</b>\n\n¿Qué registras?`, [['✅ ENTRADA', '🚪 SALIDA']]);
    return;
  }

  // FLUJO MARCAR ENTRADA/SALIDA
  if (e.paso === 'esperando_accion') {
    const accion = texto.includes('ENTRADA') ? 'ENTRADA' : 'SALIDA';
    const w = e.data.worker;
    await send(chatId, '⏳ Registrando...');
    try {
      const j = await apiSheet({
        action: 'marcar',
        dni: w.dni,
        nombre: w.nombre,
        apellidos: w.apellidos,
        accion,
        regimen: w.regimen,
        turno: e.data.turno || '',
        campamento: w.campamento,
        sector: w.sector,
        habitacion: w.habitacion || w.compartimiento || ''
      });
      if (j.error) throw new Error(j.error);
      const hora = new Date().toLocaleString('es-PE', { weekday: 'long', day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' });
      const icon = accion === 'ENTRADA' ? '✅' : '👋';
      await send(chatId, `${icon} <b>${accion} REGISTRADA</b>\n\n${w.nombre} ${w.apellidos}\n📅 ${hora}\n\nEscribe tu DNI para hacer otro registro.`);
    } catch(err) {
      await send(chatId, '❌ Error al registrar. Intenta de nuevo.');
    }
    e.paso = 'esperando_dni';
    e.data = {};
    return;
  }

  // DEFAULT
  e.paso = 'esperando_dni';
  await send(chatId, 'Ingresa tu <b>DNI</b> para comenzar:');
}

async function procesarCallback(chatId, data, messageId) {
  const e = estado(chatId);

  // Editar mensaje para quitar botones
  await axios.post(`${TELEGRAM}/editMessageReplyMarkup`, {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: [] }
  }).catch(() => {});

  // Flujo registro con botones
  if (e.paso === 'reg_cargo') {
    e.data.cargo = data;
    e.paso = 'reg_genero';
    await send(chatId, `Cargo: <b>${data}</b>\n\n¿Cuál es tu <b>género</b>?`, [['Masculino', 'Femenino']]);
    return;
  }
  if (e.paso === 'reg_genero') {
    e.data.genero = data;
    e.paso = 'reg_campamento';
    await send(chatId, `¿En qué <b>campamento</b> te alojas?`, [['Campamento A', 'Campamento B']]);
    return;
  }
  if (e.paso === 'reg_campamento') {
    e.data.campamento = data;
    e.paso = 'reg_sector';
    // Cargar sectores del config
    try {
      const j = await apiSheet({ action: 'config' });
      const sectores = Object.keys(j.data[data] || {});
      e.data.config = j.data;
      const btns = [];
      for (let i = 0; i < sectores.length; i += 2) {
        btns.push(sectores.slice(i, i+2));
      }
      await send(chatId, `Campamento: <b>${data}</b>\n\n¿Cuál es tu <b>sector</b>?`, btns);
    } catch(err) {
      await send(chatId, '¿Cuál es tu sector? (escríbelo)');
    }
    return;
  }
  if (e.paso === 'reg_sector') {
    e.data.sector = data;
    const esB = e.data.campamento.includes('B');
    if (esB) {
      e.paso = 'reg_compartimiento';
      const comps = (e.data.config && e.data.config[e.data.campamento][data])
        ? e.data.config[e.data.campamento][data].compartimientos : [];
      const btns = [];
      for (let i = 0; i < comps.length; i += 2) btns.push(comps.slice(i, i+2));
      await send(chatId, `Sector: <b>${data}</b>\n\n¿Cuál es tu <b>compartimiento</b>?`, btns.length ? btns : [['Compartimiento 1', 'Compartimiento 2']]);
    } else {
      e.paso = 'reg_habitacion';
      const habs = (e.data.config && e.data.config[e.data.campamento][data])
        ? (e.data.config[e.data.campamento][data].habitaciones.length
            ? e.data.config[e.data.campamento][data].habitaciones
            : e.data.config[e.data.campamento][data].compartimientos)
        : [];
      if (habs.length > 0 && habs.length <= 20) {
        const btns = [];
        for (let i = 0; i < habs.length; i += 4) btns.push(habs.slice(i, i+4));
        await send(chatId, `¿Cuál es tu número de <b>habitación o módulo</b>?`, btns);
      } else {
        await send(chatId, `¿Cuál es tu número de <b>habitación o módulo</b>? (escríbelo)`);
      }
    }
    return;
  }
  if (e.paso === 'reg_compartimiento') {
    e.data.compartimiento = data;
    e.paso = 'reg_cama';
    await send(chatId, `Compartimiento: <b>${data}</b>\n\n¿Cuál es tu <b>cama</b>?`, [['Cama Superior', 'Cama Inferior']]);
    return;
  }
  if (e.paso === 'reg_habitacion') {
    e.data.habitacion = data;
    e.paso = 'reg_regimen';
    await send(chatId, `Habitación: <b>${data}</b>\n\n¿Cuál es tu <b>régimen de turno</b>?`, [['5x2', '10x4'], ['6x1', '14x7']]);
    return;
  }
  if (e.paso === 'reg_cama') {
    e.data.cama = data;
    e.paso = 'reg_regimen';
    await send(chatId, `Cama: <b>${data}</b>\n\n¿Cuál es tu <b>régimen de turno</b>?`, [['5x2', '10x4'], ['6x1', '14x7']]);
    return;
  }
  if (e.paso === 'reg_regimen') {
    e.data.regimen = data;
    if (data === '14x7') {
      e.paso = 'reg_turno';
      await send(chatId, `Régimen: <b>14x7</b>\n\n¿En qué <b>turno</b> estás actualmente?`, [['☀️ Turno Día', '🌙 Turno Noche']]);
    } else {
      await finalizarRegistro(chatId, e);
    }
    return;
  }
  if (e.paso === 'reg_turno') {
    e.data.turno = data.includes('Día') ? 'Turno Día' : 'Turno Noche';
    await finalizarRegistro(chatId, e);
    return;
  }

  // Pasar a procesarMensaje para manejar turno y accion
  await procesarMensaje(chatId, data);
}

async function finalizarRegistro(chatId, e) {
  await send(chatId, '⏳ Registrando tus datos...');
  try {
    const j = await apiSheet({
      action: 'registrar_nuevo',
      dni: e.data.dni,
      nombre: e.data.nombre,
      apellidos: e.data.apellidos,
      cargo: e.data.cargo,
      genero: e.data.genero,
      campamento: e.data.campamento,
      sector: e.data.sector,
      compartimiento: e.data.compartimiento || '',
      habitacion: e.data.habitacion || '',
      cama: e.data.cama || '',
      regimen: e.data.regimen,
      turno: e.data.turno || ''
    });
    if (j.error) throw new Error(j.error);
    const hora = new Date().toLocaleString('es-PE', { weekday: 'long', day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' });
    await send(chatId, `✅ <b>REGISTRADO Y ENTRADA MARCADA</b>\n\n${e.data.nombre} ${e.data.apellidos}\n📅 ${hora}\n\nLa próxima vez solo ingresa tu DNI.`);
  } catch(err) {
    await send(chatId, '❌ Error al registrar: ' + err.message);
  }
  e.paso = 'esperando_dni';
  e.data = {};
}

// WEBHOOK
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const body = req.body;
  try {
    if (body.message) {
      const chatId = body.message.chat.id;
      const texto = body.message.text || '';
      await procesarMensaje(chatId, texto);
    } else if (body.callback_query) {
      const chatId = body.callback_query.message.chat.id;
      const data = body.callback_query.data;
      const messageId = body.callback_query.message.message_id;
      await axios.post(`${TELEGRAM}/answerCallbackQuery`, { callback_query_id: body.callback_query.id });
      await procesarCallback(chatId, data, messageId);
    }
  } catch(err) {
    console.error('Error:', err.message);
  }
});

app.get('/', (req, res) => res.send('Bot Campamento activo ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Bot corriendo en puerto', PORT));
