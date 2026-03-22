const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const TOKEN = '8545753030:AAFzvYB9x-7oTa4U5eeIbe58RiwFzwf2z0s';
const TELEGRAM = `https://api.telegram.org/bot${TOKEN}`;
const SHEET_API = 'https://script.google.com/macros/s/AKfycbxMk5piQaBgdWZtG2-xZwYNqi4WHTXeLhAaaFVynFlsn4gB9wGrrjgzHtHuC7yeAzpQCQ/exec';

// Estructura fija Campamento B
const SECTORES = [
  'Carpa 1','Carpa 2','Carpa 3','Carpa 4','Carpa 5','Carpa 6','Carpa 7',
  'Carpa 8','Carpa 9','Carpa 10','Carpa 11','Carpa 12','Carpa 13','Contenedor 5'
];
const COMPARTIMIENTOS = ['1','2','3','4','5','6','7','8','9'];
const CAMAS = ['Cama 1 Superior','Cama 1 Inferior','Cama 2 Superior','Cama 2 Inferior'];
const REGIMENES = ['5x2','10x4','6x1','14x7'];

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
  const r = await axios.get(url, { maxRedirects: 10, timeout: 15000 });
  return r.data;
}

// Botones de sectores (carpas) - 2 por fila
function btnsCarpa() {
  const btns = [];
  for (let i = 0; i < SECTORES.length; i += 2)
    btns.push(SECTORES.slice(i, i+2));
  return btns;
}

// Botones compartimientos - 3 por fila
function btnsComp() {
  return [['1','2','3'],['4','5','6'],['7','8','9']];
}

// Botones camas
function btnsCama(sector) {
  // Contenedor 5 solo tiene 1 camarote por compartimiento
  if (sector === 'Contenedor 5')
    return [['Cama 1 Superior','Cama 1 Inferior']];
  // Carpas pueden tener 2 camarotes
  return [['Cama 1 Superior','Cama 1 Inferior'],['Cama 2 Superior','Cama 2 Inferior']];
}

async function procesarMensaje(chatId, texto) {
  const e = estado(chatId);

  if (e.paso === 'inicio' || texto === '/start') {
    e.paso = 'esperando_dni';
    e.data = {};
    await send(chatId,
      '⛺ <b>CAMPAMENTO B — Control de Hospedaje</b>\n\n' +
      'Hola, ingresa tu <b>DNI</b> para continuar.\n' +
      '(Solo números, sin puntos ni guiones)');
    return;
  }

  if (e.paso === 'esperando_dni') {
    const dni = texto.trim().replace(/\D/g,'');
    if (dni.length < 6) {
      await send(chatId,'⚠️ DNI inválido. Ingresa solo números.');
      return;
    }
    await send(chatId,'🔍 Buscando tu registro...');
    try {
      const j = await apiSheet({ action:'buscar', dni });
      if (j.error) throw new Error(j.error);

      if (j.data.encontrado) {
        e.data.worker = j.data;
        const w = j.data;
        const est = w.estado==='PRESENTE' ? '🟢 PRESENTE' : '🔴 AUSENTE';
        let msg = `✅ <b>${w.nombre} ${w.apellidos}</b>\n`;
        msg += `🏕 ${w.sector} · Comp. ${w.compartimiento} · ${w.cama}\n`;
        msg += `🔄 Régimen: <b>${w.regimen}</b> · ${est}`;

        if (w.necesita_turno) {
          e.paso = 'esperando_turno';
          await send(chatId, msg+'\n\n¿En qué <b>turno</b> estás hoy?',
            [['☀️ Turno Día','🌙 Turno Noche']]);
        } else {
          e.paso = 'esperando_accion';
          await send(chatId, msg+'\n\n¿Qué registras?',
            [['✅ ENTRADA','🚪 SALIDA']]);
        }
      } else {
        e.data.dni = dni;
        e.paso = 'reg_nombre';
        await send(chatId,
          `❌ DNI <b>${dni}</b> no registrado.\n\n` +
          `📋 Te registramos ahora — solo una vez.\n\n` +
          `¿Cuál es tu <b>nombre</b>?`);
      }
    } catch(err) {
      console.error('buscar:', err.message);
      await send(chatId,'❌ Error de conexión. Escribe tu DNI de nuevo.');
      e.paso = 'esperando_dni';
    }
    return;
  }

  // REGISTRO - pasos de texto
  if (e.paso === 'reg_nombre') {
    e.data.nombre = texto.trim();
    e.paso = 'reg_apellido';
    await send(chatId,'¿Cuáles son tus <b>apellidos</b>?');
    return;
  }
  if (e.paso === 'reg_apellido') {
    e.data.apellidos = texto.trim();
    e.paso = 'reg_cargo';
    await send(chatId,'¿Cuál es tu <b>cargo</b>?',
      [['Operario','Supervisor'],['Jefe','Superintendente']]);
    return;
  }

  // TURNO usuario registrado 14x7
  if (e.paso === 'esperando_turno') {
    const turno = texto.includes('Día') ? 'Turno Día' : 'Turno Noche';
    e.data.turno = turno;
    e.paso = 'esperando_accion';
    await send(chatId,`Turno: <b>${turno}</b>\n\n¿Qué registras?`,
      [['✅ ENTRADA','🚪 SALIDA']]);
    return;
  }

  // ACCION usuario registrado
  if (e.paso === 'esperando_accion') {
    const accion = texto.includes('ENTRADA') ? 'ENTRADA' : 'SALIDA';
    await ejecutarMarcar(chatId, e, accion);
    return;
  }

  // DEFAULT
  e.paso = 'esperando_dni';
  e.data = {};
  await send(chatId,'Ingresa tu <b>DNI</b> para comenzar:');
}

async function ejecutarMarcar(chatId, e, accion) {
  const w = e.data.worker;
  await send(chatId,'⏳ Registrando...');
  try {
    const j = await apiSheet({
      action:'marcar', dni:w.dni,
      nombre:w.nombre, apellidos:w.apellidos,
      accion, regimen:w.regimen,
      turno: e.data.turno||'',
      campamento:'Campamento B',
      sector:w.sector,
      habitacion:w.compartimiento||''
    });
    if (j.error) throw new Error(j.error);
    const hora = new Date().toLocaleString('es-PE',{
      weekday:'long',day:'2-digit',month:'long',
      hour:'2-digit',minute:'2-digit'
    });
    const icon = accion==='ENTRADA' ? '✅' : '👋';
    await send(chatId,
      `${icon} <b>${accion} REGISTRADA</b>\n\n` +
      `${w.nombre} ${w.apellidos}\n📅 ${hora}\n\n` +
      `Escribe tu DNI para hacer otro registro.`);
  } catch(err) {
    console.error('marcar:', err.message);
    await send(chatId,'❌ Error al registrar. Intenta de nuevo.');
  }
  e.paso = 'esperando_dni';
  e.data = {};
}

async function finalizarRegistro(chatId, e) {
  await send(chatId,'⏳ Guardando tus datos...');
  try {
    const j = await apiSheet({
      action:'registrar_nuevo',
      dni:e.data.dni, nombre:e.data.nombre,
      apellidos:e.data.apellidos, cargo:e.data.cargo,
      genero:e.data.genero, campamento:'Campamento B',
      sector:e.data.sector,
      compartimiento:e.data.compartimiento,
      habitacion:'', cama:e.data.cama,
      regimen:e.data.regimen, turno:e.data.turno||''
    });
    if (j.error) throw new Error(j.error);
    const hora = new Date().toLocaleString('es-PE',{
      weekday:'long',day:'2-digit',month:'long',
      hour:'2-digit',minute:'2-digit'
    });
    await send(chatId,
      `✅ <b>REGISTRADO Y ENTRADA MARCADA</b>\n\n` +
      `${e.data.nombre} ${e.data.apellidos}\n` +
      `🏕 ${e.data.sector} · Comp. ${e.data.compartimiento} · ${e.data.cama}\n` +
      `📅 ${hora}\n\n` +
      `La próxima vez solo ingresa tu DNI.`);
  } catch(err) {
    console.error('registro:', err.message);
    await send(chatId,'❌ Error: '+err.message);
  }
  e.paso = 'esperando_dni';
  e.data = {};
}

async function procesarCallback(chatId, data, callbackId, messageId) {
  const e = estado(chatId);

  // Quitar botones del mensaje anterior
  await axios.post(`${TELEGRAM}/editMessageReplyMarkup`,{
    chat_id:chatId, message_id:messageId,
    reply_markup:{inline_keyboard:[]}
  }).catch(()=>{});
  await axios.post(`${TELEGRAM}/answerCallbackQuery`,{
    callback_query_id:callbackId
  }).catch(()=>{});

  // REGISTRO
  if (e.paso==='reg_cargo') {
    e.data.cargo = data;
    e.paso = 'reg_genero';
    await send(chatId,`Cargo: <b>${data}</b>\n\n¿Cuál es tu <b>género</b>?`,
      [['Masculino','Femenino']]);
    return;
  }
  if (e.paso==='reg_genero') {
    e.data.genero = data;
    e.paso = 'reg_sector';
    await send(chatId,`¿En qué <b>carpa o contenedor</b> te alojas?`, btnsCarpa());
    return;
  }
  if (e.paso==='reg_sector') {
    e.data.sector = data;
    e.paso = 'reg_compartimiento';
    await send(chatId,`${data}\n\n¿Cuál es tu <b>compartimiento</b>?`, btnsComp());
    return;
  }
  if (e.paso==='reg_compartimiento') {
    e.data.compartimiento = data;
    e.paso = 'reg_cama';
    await send(chatId,
      `Compartimiento <b>${data}</b>\n\n¿Cuál es tu <b>cama</b>?`,
      btnsCama(e.data.sector));
    return;
  }
  if (e.paso==='reg_cama') {
    e.data.cama = data;
    e.paso = 'reg_regimen';
    await send(chatId,`Cama: <b>${data}</b>\n\n¿Cuál es tu <b>régimen de turno</b>?`,
      [['5x2','10x4'],['6x1','14x7']]);
    return;
  }
  if (e.paso==='reg_regimen') {
    e.data.regimen = data;
    if (data==='14x7') {
      e.paso = 'reg_turno';
      await send(chatId,`Régimen: <b>14x7</b>\n\n¿En qué <b>turno</b> estás?`,
        [['☀️ Turno Día','🌙 Turno Noche']]);
    } else {
      await finalizarRegistro(chatId, e);
    }
    return;
  }
  if (e.paso==='reg_turno') {
    e.data.turno = data.includes('Día') ? 'Turno Día' : 'Turno Noche';
    await finalizarRegistro(chatId, e);
    return;
  }

  // Usuario registrado — turno y accion
  if (e.paso==='esperando_turno') {
    await procesarMensaje(chatId, data);
    return;
  }
  if (e.paso==='esperando_accion') {
    const accion = data.includes('ENTRADA') ? 'ENTRADA' : 'SALIDA';
    await ejecutarMarcar(chatId, e, accion);
    return;
  }

  // Default
  await procesarMensaje(chatId, data);
}

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (body.message) {
      await procesarMensaje(body.message.chat.id, body.message.text||'');
    } else if (body.callback_query) {
      await procesarCallback(
        body.callback_query.message.chat.id,
        body.callback_query.data,
        body.callback_query.id,
        body.callback_query.message.message_id
      );
    }
  } catch(err) {
    console.error('webhook:', err.message);
  }
});

app.get('/', (req,res) => res.send('Bot Campamento B activo ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Bot corriendo en puerto', PORT));
