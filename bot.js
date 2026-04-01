const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys')
const pino = require('pino')
const { Boom } = require('@hapi/boom')
const fs = require('fs')
const path = require('path')
const QRCodeImage = require('qrcode')

const baseDir = __dirname
const sessionsDir = path.join(baseDir, process.env.AUTH_DIR || 'auth')
const dataDir = path.join(baseDir, 'data')
const leadsFile = path.join(dataDir, 'leads.json')
const sessionsFile = path.join(dataDir, 'chat_sessions.json')
const rulesFile = path.join(dataDir, 'responses.json')
const remindersFile = path.join(dataDir, 'reminders.json')
const configFile = path.join(dataDir, 'config.json')

let reconnecting = false
let reminderTimer = null
let activeSocket = null
let lastQr = null
let lastQrImage = null

let botStatus = {
  connected: false,
  user: null,
  lastConnectionAt: null,
  lastQrAt: null,
  lastError: null,
  serverMode: process.env.SERVER_MODE || 'oracle-vps',
  authDir: sessionsDir
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function ensureJsonFile(filePath, defaultValue) {
  ensureDir(path.dirname(filePath))
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2), 'utf8')
  }
}

function readJson(filePath, defaultValue) {
  try {
    ensureJsonFile(filePath, defaultValue)
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    console.error(`❌ Error leyendo ${path.basename(filePath)}:`, error.message)
    return defaultValue
  }
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8')
}

function normalizeText(text = '') {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s$+.,:-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function getTextFromMessage(msg) {
  return (
    msg?.message?.conversation ||
    msg?.message?.extendedTextMessage?.text ||
    msg?.message?.imageMessage?.caption ||
    msg?.message?.videoMessage?.caption ||
    ''
  )
}

function ownJids(sock) {
  const raw = sock?.user?.id || ''
  const phone = raw.split(':')[0]

  return new Set([
    raw,
    phone,
    `${phone}@s.whatsapp.net`,
    `${phone}@lid`
  ])
}

function getConfig() {
  const defaultConfig = {
    companyName: 'MyE Software',
    webSite: 'https://myesoftware.com.ar',
    publicBaseUrl: process.env.PUBLIC_BASE_URL || 'http://TU_IP:3000',
    humanHours: 'Lunes a Viernes de 09:00 a 18:00 hs',
    advisorPhone: '',
    advisorEmail: '',
    askEmailInFlow: true,
    askBudgetRangeInFlow: true,
    autoSendPortfolioAfterBudget: false,
    followupDelayMinutes: 60,
    maxFollowups: 2,
    landingPrice: { min: 160000, max: 260000 },
    webPrice: { min: 275000, max: 515000 },
    ecommercePrice: { min: 990000, max: 1550000 },
    systemPrice: { min: 490000, max: 2500000 },
    portfolioLinks: ['https://myesoftware.com.ar']
  }

  const fileConfig = readJson(configFile, defaultConfig)

  return {
    ...defaultConfig,
    ...fileConfig,
    landingPrice: {
      ...defaultConfig.landingPrice,
      ...(fileConfig.landingPrice || {})
    },
    webPrice: {
      ...defaultConfig.webPrice,
      ...(fileConfig.webPrice || {})
    },
    ecommercePrice: {
      ...defaultConfig.ecommercePrice,
      ...(fileConfig.ecommercePrice || {})
    },
    systemPrice: {
      ...defaultConfig.systemPrice,
      ...(fileConfig.systemPrice || {})
    },
    portfolioLinks:
      fileConfig.portfolioLinks?.length
        ? fileConfig.portfolioLinks
        : defaultConfig.portfolioLinks
  }
}

function detectBudgetRange(text = '') {
  const t = normalizeText(text)
  if (!t) return ''

  if (
    t.includes('menos') ||
    t.includes('bajo') ||
    t.includes('economico') ||
    t.includes('150') ||
    t.includes('200')
  ) return 'bajo'

  if (
    t.includes('medio') ||
    t.includes('300') ||
    t.includes('400') ||
    t.includes('500')
  ) return 'medio'

  if (
    t.includes('alto') ||
    t.includes('premium') ||
    t.includes('600') ||
    t.includes('1000') ||
    t.includes('1.000')
  ) return 'alto'

  return text.trim()
}

function classifyLeadByIntent(intent, text, lead = {}) {
  const t = normalizeText(text)
  const budgetRange = normalizeText(lead.budgetRange || '')
  const urgency = normalizeText(lead.urgencia || '')

  if (intent === 'asesor') return 'listo'
  if (intent === 'tienda' || intent === 'sistema') return 'caliente'

  if (intent === 'web' || intent === 'landing') {
    if (budgetRange === 'alto' || urgency === 'alta') return 'caliente'
    return 'tibio'
  }

  if (t.includes('precio') || t.includes('presupuesto') || t.includes('costo')) return 'tibio'
  return 'frio'
}

function inferIntent(rawText) {
  const t = normalizeText(rawText)

  const patterns = [
    { intent: 'asesor', keywords: ['asesor', 'humano', 'persona', 'hablar con alguien', 'contactame', 'llamame'] },
    { intent: 'tienda', keywords: ['tienda', 'ecommerce', 'e commerce', 'catalogo', 'carrito', 'productos'] },
    { intent: 'sistema', keywords: ['sistema', 'turnos', 'stock', 'panel', 'reservas', 'app web', 'gestion'] },
    { intent: 'landing', keywords: ['landing', 'landing page', 'una sola pagina', 'pagina simple'] },
    { intent: 'web', keywords: ['pagina web', 'sitio web', 'web', 'pagina para mi negocio', 'necesito una pagina'] },
    { intent: 'budget', keywords: ['precio', 'precios', 'presupuesto', 'costo', 'costos', 'cuanto sale', 'cuanto cuesta'] }
  ]

  for (const group of patterns) {
    if (group.keywords.some(k => t.includes(normalizeText(k)))) return group.intent
  }

  if (['1', '2', '3', '4', '5', '6'].includes(t)) {
    return {
      '1': 'budget',
      '2': 'landing',
      '3': 'web',
      '4': 'tienda',
      '5': 'sistema',
      '6': 'asesor'
    }[t]
  }

  return null
}

function loadRules() {
  const rawRules = readJson(rulesFile, [])
  return rawRules.map(rule => ({
    ...rule,
    normalizedKeywords: (rule.keywords || [])
      .map(k => normalizeText(k))
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
  }))
}

function findBestRule(message, rules) {
  const normalized = normalizeText(message)
  if (!normalized) return null

  let bestMatch = null

  for (const rule of rules) {
    for (const keyword of rule.normalizedKeywords) {
      const exact = normalized === keyword
      const includes = normalized.includes(keyword)

      if (exact || includes) {
        if (!bestMatch || keyword.length > bestMatch.keyword.length) {
          bestMatch = { rule, keyword }
        }
      }
    }
  }

  return bestMatch
}

function defaultLead(phone) {
  return {
    telefono: phone,
    nombre: '',
    email: '',
    rubro: '',
    proyecto: '',
    extras: '',
    consulta: '',
    urgencia: '',
    budgetRange: '',
    fuente: 'whatsapp',
    estado: 'nuevo',
    interes: '',
    etiquetas: [],
    nivel: 'frio',
    deseaSeguimiento: null,
    followupCount: 0,
    ultimoMensajeAt: new Date().toISOString(),
    createdAt: new Date().toISOString()
  }
}

function saveLeadPatch(phone, patch) {
  const leads = readJson(leadsFile, [])
  const idx = leads.findIndex(l => l.telefono === phone)

  if (idx === -1) {
    leads.push({
      ...defaultLead(phone),
      ...patch,
      updatedAt: new Date().toISOString()
    })
  } else {
    leads[idx] = {
      ...leads[idx],
      ...patch,
      updatedAt: new Date().toISOString()
    }
  }

  writeJson(leadsFile, leads)
  return getLead(phone)
}

function getLead(phone) {
  const leads = readJson(leadsFile, [])
  return leads.find(l => l.telefono === phone) || null
}

function updateTagsAndLevel(phone) {
  const lead = getLead(phone)
  if (!lead) return

  const tags = new Set(lead.etiquetas || [])

  if (lead.interes) tags.add(lead.interes)
  if (lead.fuente) tags.add(`fuente_${normalizeText(lead.fuente).replace(/\s+/g, '_')}`)
  if (lead.deseaSeguimiento === true) tags.add('acepta_seguimiento')
  if (lead.deseaSeguimiento === false) tags.add('sin_seguimiento')
  if (lead.nombre) tags.add('nombre_capturado')
  if (lead.email) tags.add('email_capturado')
  if (lead.rubro) tags.add('rubro_capturado')
  if (lead.proyecto) tags.add('proyecto_capturado')
  if (lead.budgetRange) tags.add(`presupuesto_${normalizeText(lead.budgetRange)}`)
  if (lead.estado) tags.add(`estado_${normalizeText(lead.estado).replace(/\s+/g, '_')}`)

  const refreshedLevel = classifyLeadByIntent(
    lead.interes,
    `${lead.proyecto} ${lead.consulta}`,
    lead
  )

  tags.add(`lead_${refreshedLevel}`)

  saveLeadPatch(phone, {
    etiquetas: Array.from(tags),
    nivel: refreshedLevel
  })
}

function getChatSessions() {
  return readJson(sessionsFile, {})
}

function getChatSession(chatId) {
  const sessions = getChatSessions()
  return sessions[chatId] || { step: null, data: {} }
}

function setChatSession(chatId, session) {
  const sessions = getChatSessions()
  sessions[chatId] = session
  writeJson(sessionsFile, sessions)
}

function clearChatSession(chatId) {
  const sessions = getChatSessions()
  delete sessions[chatId]
  writeJson(sessionsFile, sessions)
}

function saveReminder(phone, reminder) {
  const reminders = readJson(remindersFile, [])
  const idx = reminders.findIndex(r => r.telefono === phone)

  if (idx === -1) reminders.push(reminder)
  else reminders[idx] = reminder

  writeJson(remindersFile, reminders)
}

function removeReminder(phone) {
  const reminders = readJson(remindersFile, [])
  writeJson(remindersFile, reminders.filter(r => r.telefono !== phone))
}

function scheduleFollowup(phone, chatId) {
  const config = getConfig()
  const dueAt = new Date(Date.now() + config.followupDelayMinutes * 60 * 1000).toISOString()

  saveReminder(phone, {
    telefono: phone,
    chatId,
    dueAt,
    sentCount: 0,
    active: true
  })
}

function cancelFollowup(phone) {
  removeReminder(phone)
}

function buildMenu() {
  return `*MyE Software - Soluciones Digitales* 🚀

Hola. Seleccioná una opción escribiendo solo el *NÚMERO*:

1️⃣ Presupuesto Web
2️⃣ Landing Page
3️⃣ Página Web Empresarial
4️⃣ Tienda Online
5️⃣ Sistema a Medida
6️⃣ Hablar con Asesor

---
⚠️ Por favor, respondé solo con el número de la opción deseada.`
}

function buildProjectOptionsMenu() {
  return `*Paso 4 de 8*
¿Qué necesitás?

Respondé solo con el *número*:

1️⃣ Landing Page
2️⃣ Página web empresarial
3️⃣ Tienda online
4️⃣ Sistema a medida`
}

function buildExtrasOptionsMenu() {
  return `*Paso 5 de 8*
¿Qué extras necesitás?

Respondé uno o varios números separados por coma.

Ejemplo:
*1,2,4*

Opciones:
1️⃣ Botón de WhatsApp
2️⃣ Formulario de contacto
3️⃣ Catálogo
4️⃣ Panel administrador
5️⃣ Nada más`
}

function mapProjectOption(option) {
  const map = {
    '1': 'Landing Page',
    '2': 'Página web empresarial',
    '3': 'Tienda online',
    '4': 'Sistema a medida'
  }
  return map[option] || null
}

function mapExtrasOptions(input) {
  const map = {
    '1': 'Botón de WhatsApp',
    '2': 'Formulario',
    '3': 'Catálogo',
    '4': 'Panel administrador',
    '5': 'Nada más'
  }

  const values = String(input)
    .split(',')
    .map(v => v.trim())
    .filter(Boolean)

  if (!values.length) return null

  const unique = [...new Set(values)]

  if (unique.some(v => !map[v])) return null
  if (unique.includes('5') && unique.length > 1) return null

  return unique.map(v => map[v]).join(', ')
}

function estimateByProject(project, extras = '') {
  const p = normalizeText(project)
  const e = normalizeText(extras)
  const config = getConfig()

  let min = 0
  let max = 0
  let tipo = 'Página Web Profesional'

  if (p.includes('landing')) {
    tipo = 'Landing Page'
    min = config.landingPrice.min
    max = config.landingPrice.max
  } else if (p.includes('tienda') || p.includes('ecommerce')) {
    tipo = 'Tienda Online'
    min = config.ecommercePrice.min
    max = config.ecommercePrice.max
  } else if (p.includes('sistema') || p.includes('app') || p.includes('panel')) {
    tipo = 'Sistema a medida'
    min = config.systemPrice.min
    max = config.systemPrice.max
  } else {
    tipo = 'Página Web Profesional'
    min = config.webPrice.min
    max = config.webPrice.max
  }

  if (e.includes('panel')) { min += 120000; max += 350000 }
  if (e.includes('catalogo')) { min += 90000; max += 220000 }
  if (e.includes('formulario')) { min += 30000; max += 80000 }
  if (e.includes('whatsapp')) { min += 15000; max += 40000 }

  return { tipo, min, max }
}

function formatMoney(value) {
  return new Intl.NumberFormat('es-AR').format(value)
}

function buildBudgetStart() {
  return `💼 *Presupuesto automático V6*

Te voy a hacer unas preguntas rápidas para darte una estimación y ordenar tu consulta.

*Paso 1 de 8*
¿Cuál es tu *nombre*?`
}

function buildFollowupQuestion() {
  return `📌 Antes de terminar:
¿Querés que te haga seguimiento automático por este medio si todavía no decidís?

Respondé:
*SI* o *NO*`
}

function buildBudgetSummary(data) {
  const est = estimateByProject(data.proyecto || '', data.extras || '')

  return `📋 *Resumen de tu consulta*

👤 Nombre: ${data.nombre || '-'}
📧 Email: ${data.email || '-'}
🏢 Rubro: ${data.rubro || '-'}
🌐 Proyecto: ${data.proyecto || '-'}
📦 Extras: ${data.extras || '-'}
💵 Inversión estimada del cliente: ${data.budgetRange || '-'}
🔥 Prioridad: ${data.urgencia || '-'}

💰 *Presupuesto estimado para ${est.tipo}:*
Desde *$${formatMoney(est.min)}* hasta *$${formatMoney(est.max)}*

✅ Tu consulta quedó registrada.`
}

function buildPortfolioMessage() {
  const config = getConfig()
  const links = (config.portfolioLinks || []).join('\n• ')
  return `📁 *Portfolio / referencias*\n• ${links}`
}

function buildHumanCaptureStart() {
  return `👨‍💼 *Derivación automática a humano*

Perfecto. Tu consulta quedó marcada para atención humana.

Mientras tanto, para ayudarte más rápido, respondé con tu *nombre*.

*Paso 1 de 3*`
}

function buildSalesPitchForIntent(intent) {
  const config = getConfig()

  if (intent === 'landing') {
    return `🚀 *Landing Page*

Ideal para vender un servicio puntual, lanzar campañas o captar leads.

Incluye:
• Diseño premium
• Botón de WhatsApp
• Formulario
• SEO básico

💰 Desde *$${formatMoney(config.landingPrice.min)}*

Si querés una propuesta exacta, respondé *presupuesto*.`
  }

  if (intent === 'web') {
    return `🌐 *Página Web Profesional*

Ideal para empresas y negocios que necesitan presencia seria y que convierta.

Incluye:
• Hasta 5 secciones
• Formulario de contacto
• SEO básico
• Integración con WhatsApp

💰 Desde *$${formatMoney(config.webPrice.min)}*

Si querés una propuesta exacta, respondé *presupuesto*.`
  }

  if (intent === 'tienda') {
    return `🛒 *Tienda Online*

Ideal para vender productos por internet y automatizar consultas.

Incluye:
• Catálogo
• Carrito o pedido
• Integración WhatsApp
• Panel de administración

💰 Desde *$${formatMoney(config.ecommercePrice.min)}*

Si querés, respondé *presupuesto*.`
  }

  if (intent === 'sistema') {
    return `⚙️ *Sistema a medida*

Podemos desarrollar:
• Turnos
• Reservas
• Gestión de clientes
• Control de stock
• Panel administrador

💰 Desde *$${formatMoney(config.systemPrice.min)}*

Si querés, respondé *presupuesto*.`
  }

  return null
}

function defaultFallback() {
  return `No te entendí del todo 👌

Podés responder con:

1️⃣ Presupuesto web
2️⃣ Landing Page
3️⃣ Página web empresarial
4️⃣ Tienda online
5️⃣ Sistema a medida
6️⃣ Hablar con asesor`
}

function isSelfBotEcho(text) {
  const t = normalizeText(text)
  return [
    'mye software',
    'presupuesto automatico',
    'resumen de tu consulta',
    'no te entendi del todo',
    'perfecto',
    'hola soy el asistente virtual'
  ].some(prefix => t.includes(prefix))
}

async function sendAndTrack(sock, jid, text) {
  if (!sock) throw new Error('Bot no conectado a WhatsApp')
  await sock.sendMessage(jid, { text })
}

async function processReminders(sock) {
  const config = getConfig()
  const reminders = readJson(remindersFile, [])
  const now = Date.now()
  let changed = false

  for (const reminder of reminders) {
    if (!reminder.active) continue
    if (new Date(reminder.dueAt).getTime() > now) continue

    const lead = getLead(reminder.telefono)
    if (!lead || lead.deseaSeguimiento !== true) {
      reminder.active = false
      changed = true
      continue
    }

    if ((reminder.sentCount || 0) >= config.maxFollowups) {
      reminder.active = false
      saveLeadPatch(reminder.telefono, { estado: 'seguimiento_finalizado' })
      updateTagsAndLevel(reminder.telefono)
      changed = true
      continue
    }

    const message = reminder.sentCount === 0
      ? `Hola 👋 Solo quería saber si pudiste ver la información que te enviamos.

Si querés seguimos por acá:
1️⃣ Presupuesto
2️⃣ Landing
3️⃣ Web
4️⃣ Tienda
5️⃣ Sistema
6️⃣ Asesor`
      : `Te escribo por última vez para no molestarte 😊

Si todavía querés avanzar con tu proyecto, respondé:
1️⃣ Presupuesto
6️⃣ Asesor`

    try {
      await sendAndTrack(sock, reminder.chatId, message)

      reminder.sentCount = (reminder.sentCount || 0) + 1
      reminder.dueAt = new Date(
        Date.now() + config.followupDelayMinutes * 60 * 1000
      ).toISOString()

      saveLeadPatch(reminder.telefono, {
        followupCount: reminder.sentCount,
        estado:
          reminder.sentCount >= config.maxFollowups
            ? 'seguimiento_finalizado'
            : 'seguimiento_activo'
      })

      updateTagsAndLevel(reminder.telefono)

      if (reminder.sentCount >= config.maxFollowups) {
        reminder.active = false
      }

      changed = true
    } catch (error) {
      console.error('❌ Error enviando seguimiento:', error.message)
      botStatus.lastError = error.message
    }
  }

  if (changed) writeJson(remindersFile, reminders)
}

function startReminderLoop(sock) {
  if (reminderTimer) clearInterval(reminderTimer)
  reminderTimer = setInterval(() => processReminders(sock), 30000)
}

function normalizePhoneForWhatsApp(phone = '') {
  if (String(phone).includes('@s.whatsapp.net')) return phone
  const digits = String(phone).replace(/\D/g, '')
  if (!digits) return ''
  return `${digits}@s.whatsapp.net`
}

async function sendManualMessage(phone, text) {
  const sock = activeSocket
  if (!sock || !botStatus.connected) {
    throw new Error('El bot todavía no está conectado a WhatsApp')
  }

  const jid = normalizePhoneForWhatsApp(phone)
  if (!jid) throw new Error('Teléfono inválido')

  await sendAndTrack(sock, jid, text)
  return { ok: true, phone: jid }
}

async function ingestWebLead(leadPayload = {}) {
  const phone = String(
    leadPayload.telefono || leadPayload.phone || ''
  ).replace(/\D/g, '')

  if (!phone) throw new Error('El lead debe incluir telefono')

  const project = leadPayload.proyecto || leadPayload.projectType || 'Página Web Profesional'
  const extrasRaw = leadPayload.extras || leadPayload.features || ''
  const extras = Array.isArray(extrasRaw) ? extrasRaw.join(', ') : extrasRaw
  const urgency = leadPayload.urgencia || leadPayload.timeline || leadPayload.deadline || 'Media'
  const budgetRange = detectBudgetRange(
    leadPayload.budgetRange || leadPayload.presupuesto || leadPayload.estimatedRange || ''
  )
  const intent = inferIntent(project) || 'web'

  saveLeadPatch(phone, {
    telefono: phone,
    nombre: leadPayload.nombre || leadPayload.name || '',
    email: leadPayload.email || '',
    rubro: leadPayload.rubro || leadPayload.business || leadPayload.businessType || '',
    proyecto: project,
    extras,
    consulta: leadPayload.consulta || `Lead recibido desde web: ${project}`,
    urgencia: urgency,
    budgetRange,
    fuente: leadPayload.fuente || 'web',
    interes: intent,
    estado: 'lead_web_recibido',
    deseaSeguimiento: leadPayload.deseaSeguimiento === true,
    nivel: classifyLeadByIntent(intent, `${project} ${leadPayload.consulta || ''}`, {
      budgetRange,
      urgencia: urgency
    })
  })

  updateTagsAndLevel(phone)

  const est = estimateByProject(project, extras)
  const message = `Hola ${leadPayload.nombre || ''} 👋

Gracias por solicitar un presupuesto en *${getConfig().companyName}*.

🧩 Proyecto: *${project}*
💰 Estimación inicial: *$${formatMoney(est.min)}* a *$${formatMoney(est.max)}*.
📌 Próximo paso: revisar detalles y enviarte propuesta final.

Si querés, respondé este mensaje con más información o escribí *asesor*.`

  let sent = false

  try {
    await sendManualMessage(phone, message)
    sent = true
  } catch (error) {
    console.error('⚠️ Lead guardado pero no se pudo enviar WhatsApp:', error.message)
    botStatus.lastError = error.message
  }

  if (leadPayload.deseaSeguimiento === true) {
    scheduleFollowup(phone, normalizePhoneForWhatsApp(phone))
  }

  return { ok: true, sent, phone, estimate: est }
}

function getBotSnapshot() {
  return {
    ...botStatus,
    hasQr: Boolean(lastQr),
    qrPreviewAvailable: Boolean(lastQrImage),
    leads: readJson(leadsFile, []).length
  }
}

function getLastQr() {
  return lastQr
}

function getLastQrImage() {
  return lastQrImage
}

async function startBot() {
  ensureDir(sessionsDir)
  ensureJsonFile(leadsFile, [])
  ensureJsonFile(sessionsFile, {})
  ensureJsonFile(rulesFile, [])
  ensureJsonFile(remindersFile, [])
  ensureJsonFile(configFile, getConfig())

  const { state, saveCreds } = await useMultiFileAuthState(sessionsDir)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: process.env.LOG_LEVEL || 'silent' }),
    browser: ['Ubuntu', 'Chrome', '122.0.0.0'],
    markOnlineOnConnect: true,
    syncFullHistory: false
  })

  activeSocket = sock
  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      lastQr = qr
      botStatus.lastQrAt = new Date().toISOString()

      try {
        lastQrImage = await QRCodeImage.toDataURL(qr, {
          errorCorrectionLevel: 'M',
          margin: 2,
          scale: 8
        })
        console.log('✅ QR para panel web generado correctamente.')
      } catch (error) {
        console.error('❌ Error generando imagen QR para web:', error.message)
        botStatus.lastError = error.message
      }

      console.log('\n-------------------------------------------------------')
      console.log('🔗 LINK DE EMERGENCIA (Si el panel o la consola fallan):')
      console.log(`https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(qr)}&size=300x300`)
      console.log('-------------------------------------------------------\n')

      try {
        const QRCodeTerminal = require('qrcode-terminal')
        QRCodeTerminal.generate(qr, { small: true })
      } catch (e) {
        console.log('No se pudo mostrar QR en terminal, usá el link de arriba.')
      }

      console.log(`🌐 Recordá que podés entrar a: ${getConfig().publicBaseUrl}/qr`)
    }

    if (connection === 'open') {
      reconnecting = false
      botStatus.connected = true
      botStatus.user = sock?.user?.id || null
      botStatus.lastConnectionAt = new Date().toISOString()
      botStatus.lastError = null
      lastQr = null
      lastQrImage = null

      console.log('✅ Bot conectado correctamente a WhatsApp.')
      console.log('✅ Oracle VPS mode activo: sesión persistente, QR web, panel simple y PM2.')

      startReminderLoop(sock)
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut

      botStatus.connected = false
      botStatus.lastError = `Conexión cerrada. Código ${statusCode}`

      console.log('⚠️ Conexión cerrada. Código:', statusCode)

      if (shouldReconnect && !reconnecting) {
        reconnecting = true
        console.log('🔄 Reintentando conexión en 3 segundos...')
        setTimeout(() => {
          startBot().catch(err => console.error('❌ Reintento fallido:', err.message))
        }, 3000)
      } else if (!shouldReconnect) {
        console.log(`❌ Sesión cerrada. Eliminá la carpeta ${sessionsDir} y volvé a escanear.`)
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages?.[0]
    if (!msg?.message) return

    const from = msg.key.remoteJid
    const rawText = getTextFromMessage(msg)
    const text = normalizeText(rawText)

    if (!from || (!from.endsWith('@s.whatsapp.net') && !from.endsWith('@lid'))) return
    if (!text) return

    const own = ownJids(sock)
    const isSelfChat = own.has(from)

    if (msg.key.fromMe && !isSelfChat) return
    if (msg.key.fromMe && isSelfChat && isSelfBotEcho(rawText)) return

    const phone = from.replace('@s.whatsapp.net', '').replace('@lid', '')
    const senderName = msg.pushName || ''
    const session = getChatSession(from)
    const rules = loadRules()

    saveLeadPatch(phone, {
      telefono: phone,
      consulta: rawText,
      ultimoMensajeAt: new Date().toISOString()
    })

    if (senderName) {
      const currentLead = getLead(phone)
      saveLeadPatch(phone, { nombre: currentLead?.nombre || senderName })
    }

    try {
      cancelFollowup(phone)

      const insultos = ['boludo', 'mierda', 'estafa', 'hdp', 'pelotudo']
      if (insultos.some(i => text.includes(i))) {
        await sendAndTrack(
          sock,
          from,
          'Mantenemos un ambiente de respeto profesional. Si tenés dudas técnicas, por favor seleccioná una opción del menú.'
        )
        return
      }

      if (
        text.includes('portfolio') ||
        text.includes('ejemplos') ||
        text.includes('trabajos')
      ) {
        await sendAndTrack(
          sock,
          from,
          `Por políticas de privacidad de nuestros clientes, no exponemos trabajos actuales. Garantizamos calidad óptima en cada entrega.

Podés ver más en: ${getConfig().webSite}`
        )
        return
      }

      if (['menu', 'menú', 'cancelar', 'salir', 'reiniciar', 'inicio', 'hola', 'buenas'].includes(text)) {
        clearChatSession(from)
        await sendAndTrack(sock, from, buildMenu())
        return
      }

      if (session.step === 'human_name') {
        session.data.nombre = rawText.trim()
        session.step = 'human_rubro'
        setChatSession(from, session)

        saveLeadPatch(phone, {
          nombre: rawText.trim(),
          estado: 'derivado_humano_datos'
        })
        updateTagsAndLevel(phone)

        await sendAndTrack(sock, from, `*Paso 2 de 3*\n¿A qué se dedica tu negocio o rubro?`)
        return
      }

      if (session.step === 'human_rubro') {
        session.data.rubro = rawText.trim()
        session.step = 'human_need'
        setChatSession(from, session)

        saveLeadPatch(phone, {
          rubro: rawText.trim(),
          estado: 'derivado_humano_datos'
        })
        updateTagsAndLevel(phone)

        await sendAndTrack(sock, from, `*Paso 3 de 3*\nContame brevemente qué necesitás.`)
        return
      }

      if (session.step === 'human_need') {
        session.data.proyecto = rawText.trim()

        saveLeadPatch(phone, {
          nombre: session.data.nombre || getLead(phone)?.nombre || senderName || '',
          rubro: session.data.rubro || '',
          proyecto: rawText.trim(),
          consulta: rawText.trim(),
          interes: 'asesor',
          estado: 'pendiente_humano',
          nivel: 'listo'
        })
        updateTagsAndLevel(phone)

        clearChatSession(from)

        const cfg = getConfig()

        await sendAndTrack(
          sock,
          from,
          `✅ Gracias, ya guardé tus datos para atención humana.

👤 Nombre: ${session.data.nombre || '-'}
🏢 Rubro: ${session.data.rubro || '-'}
🧩 Necesidad: ${rawText.trim()}

⏰ Te responderemos dentro del horario de atención:
${cfg.humanHours}`
        )
        return
      }

      if (session.step === 'budget_name') {
        session.data.nombre = rawText.trim()
        session.step = getConfig().askEmailInFlow ? 'budget_email' : 'budget_rubro'
        setChatSession(from, session)

        saveLeadPatch(phone, {
          nombre: rawText.trim(),
          estado: 'capturando_datos'
        })
        updateTagsAndLevel(phone)

        await sendAndTrack(
          sock,
          from,
          getConfig().askEmailInFlow
            ? `*Paso 2 de 8*\n¿Cuál es tu *email*?\n\nSi no querés dejarlo ahora, respondé *no tengo*.`
            : `*Paso 2 de 8*\n¿A qué se dedica tu negocio o rubro?`
        )
        return
      }

      if (session.step === 'budget_email') {
        session.data.email = rawText.trim()
        session.step = 'budget_rubro'
        setChatSession(from, session)

        saveLeadPatch(phone, {
          email: rawText.trim(),
          estado: 'capturando_datos'
        })
        updateTagsAndLevel(phone)

        await sendAndTrack(sock, from, `*Paso 3 de 8*\n¿A qué se dedica tu negocio o rubro?`)
        return
      }

      if (session.step === 'budget_rubro') {
        session.data.rubro = rawText.trim()
        session.step = 'budget_project'
        setChatSession(from, session)

        saveLeadPatch(phone, {
          rubro: rawText.trim(),
          estado: 'capturando_datos'
        })
        updateTagsAndLevel(phone)

        await sendAndTrack(sock, from, buildProjectOptionsMenu())
        return
      }

      if (session.step === 'budget_project') {
        const proyecto = mapProjectOption(text)

        if (!proyecto) {
          await sendAndTrack(
            sock,
            from,
            `⚠️ Opción no válida.\nRespondé solo con uno de estos números:\n\n${buildProjectOptionsMenu()}`
          )
          return
        }

        session.data.proyecto = proyecto
        session.step = 'budget_extras'
        setChatSession(from, session)

        const intent = inferIntent(proyecto) || 'web'
        saveLeadPatch(phone, {
          proyecto,
          interes: intent,
          nivel: classifyLeadByIntent(intent, proyecto),
          estado: 'capturando_datos'
        })
        updateTagsAndLevel(phone)

        await sendAndTrack(sock, from, buildExtrasOptionsMenu())
        return
      }

      if (session.step === 'budget_extras') {
        const extras = mapExtrasOptions(text)

        if (!extras) {
          await sendAndTrack(
            sock,
            from,
            `⚠️ Opción no válida.\nRespondé con uno o varios números separados por coma.\n\n${buildExtrasOptionsMenu()}`
          )
          return
        }

        session.data.extras = extras
        session.step = getConfig().askBudgetRangeInFlow ? 'budget_range' : 'budget_urgency'
        setChatSession(from, session)

        saveLeadPatch(phone, {
          extras,
          estado: 'capturando_datos'
        })
        updateTagsAndLevel(phone)

        await sendAndTrack(
          sock,
          from,
          getConfig().askBudgetRangeInFlow
            ? `*Paso 6 de 8*\n¿Qué nivel de inversión aproximado tenés pensado?\n\nPodés responder:\n• Bajo\n• Medio\n• Alto\n• No lo sé todavía`
            : `*Paso 6 de 8*\n¿Qué tan urgente es?\n\nPodés responder:\n• Alta\n• Media\n• Baja`
        )
        return
      }

      if (session.step === 'budget_range') {
        session.data.budgetRange = rawText.trim()
        session.step = 'budget_urgency'
        setChatSession(from, session)

        saveLeadPatch(phone, {
          budgetRange: detectBudgetRange(rawText),
          estado: 'capturando_datos'
        })
        updateTagsAndLevel(phone)

        await sendAndTrack(
          sock,
          from,
          `*Paso 7 de 8*\n¿Qué tan urgente es?\n\nPodés responder:\n• Alta\n• Media\n• Baja`
        )
        return
      }

      if (session.step === 'budget_urgency') {
        session.data.urgencia = rawText.trim()
        session.step = 'budget_followup_permission'
        setChatSession(from, session)

        saveLeadPatch(phone, {
          urgencia: rawText.trim(),
          estado: 'capturando_datos'
        })
        updateTagsAndLevel(phone)

        await sendAndTrack(sock, from, buildFollowupQuestion())
        return
      }

      if (session.step === 'budget_followup_permission') {
        const accepted = ['si', 'sí', 's', 'ok', 'dale'].includes(text)
        const declined = ['no', 'nop', 'nah'].includes(text)

        if (!accepted && !declined) {
          await sendAndTrack(sock, from, `Respondé solo:\n*SI* o *NO*`)
          return
        }

        session.data.deseaSeguimiento = accepted
        clearChatSession(from)

        const intent = inferIntent(session.data.proyecto || '') || 'web'
        const normalizedRange = detectBudgetRange(session.data.budgetRange || '')
        const level = classifyLeadByIntent(intent, session.data.proyecto || '', {
          budgetRange: normalizedRange,
          urgencia: session.data.urgencia || ''
        })

        saveLeadPatch(phone, {
          nombre: session.data.nombre || getLead(phone)?.nombre || senderName || '',
          email: session.data.email || '',
          rubro: session.data.rubro || '',
          proyecto: session.data.proyecto || '',
          extras: session.data.extras || '',
          budgetRange: normalizedRange,
          urgencia: session.data.urgencia || '',
          deseaSeguimiento: accepted,
          interes: intent,
          nivel: level,
          estado: 'listo_para_venta'
        })
        updateTagsAndLevel(phone)

        if (accepted) scheduleFollowup(phone, from)

        let response = `${buildBudgetSummary(session.data)}

${accepted
  ? '✅ Seguimiento automático activado. Te voy a escribir como máximo 2 veces si no respondés.'
  : '✅ Perfecto, no activamos seguimiento automático.'}

Si querés hablar con una persona, escribí *asesor*.`

        if (getConfig().autoSendPortfolioAfterBudget) {
          response += `\n\n${buildPortfolioMessage()}`
        }

        await sendAndTrack(sock, from, response)
        return
      }

      const opcionesValidas = ['1', '2', '3', '4', '5', '6']
      if (!opcionesValidas.includes(text) && !session.step) {
        const knownIntent = inferIntent(rawText)
        const knownRule = findBestRule(rawText, rules)
        const knownWords = ['menu', 'menú', 'cancelar', 'salir', 'reiniciar', 'inicio', 'hola', 'buenas']

        if (!knownIntent && !knownRule && !knownWords.includes(text)) {
          await sendAndTrack(
            sock,
            from,
            `⚠️ Opción no válida. Por favor, ingresá solo el número de la opción deseada:\n\n${buildMenu()}`
          )
          return
        }
      }

      const intent = inferIntent(rawText)
      if (intent) {
        if (intent === 'budget') {
          setChatSession(from, { step: 'budget_name', data: {} })

          saveLeadPatch(phone, {
            interes: 'budget',
            nivel: classifyLeadByIntent('budget', rawText),
            estado: 'inicio_presupuesto'
          })
          updateTagsAndLevel(phone)

          await sendAndTrack(sock, from, buildBudgetStart())
          return
        }

        if (intent === 'asesor') {
          saveLeadPatch(phone, {
            interes: 'asesor',
            nivel: classifyLeadByIntent('asesor', rawText),
            estado: 'derivado_humano'
          })
          updateTagsAndLevel(phone)

          setChatSession(from, {
            step: 'human_name',
            data: {}
          })

          const cfg = getConfig()

          await sendAndTrack(
            sock,
            from,
            `${buildHumanCaptureStart()}

⏰ Horario de atención:
${cfg.humanHours}
${cfg.advisorPhone ? `📱 WhatsApp asesor: ${cfg.advisorPhone}\n` : ''}${cfg.advisorEmail ? `📧 Email: ${cfg.advisorEmail}\n` : ''}`.trim()
          )
          return
        }

        const pitch = buildSalesPitchForIntent(intent)
        if (pitch) {
          saveLeadPatch(phone, {
            interes: intent,
            nivel: classifyLeadByIntent(intent, rawText),
            estado: 'interes_servicio'
          })
          updateTagsAndLevel(phone)

          await sendAndTrack(sock, from, pitch)
          return
        }
      }

      const match = findBestRule(rawText, rules)
      if (match) {
        await sendAndTrack(sock, from, match.rule.response)
        return
      }

      await sendAndTrack(sock, from, defaultFallback())
    } catch (error) {
      botStatus.lastError = error.message
      console.error('❌ Error procesando mensaje:', error)
    }
  })

  return sock
}

module.exports = {
  startBot,
  getBotSnapshot,
  getLastQr,
  getLastQrImage,
  sendManualMessage,
  ingestWebLead,
  getConfig,
  readJson,
  writeJson,
  defaultLead
}

if (require.main === module) {
  startBot().catch((err) => {
    console.error('❌ Error al iniciar el bot:', err)
    process.exit(1)
  })
}