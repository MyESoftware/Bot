const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys')
const pino = require('pino')
const QRCode = require('qrcode-terminal')
const { Boom } = require('@hapi/boom')
const fs = require('fs')
const path = require('path')

const baseDir = __dirname
const sessionsDir = path.join(baseDir, 'auth')
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
let botStatus = {
  connected: false,
  user: null,
  lastConnectionAt: null,
  lastQrAt: null,
  lastError: null
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
    companyName: process.env.COMPANY_NAME || 'MyE Software',
    humanHours: process.env.HUMAN_HOURS || 'Lunes a Viernes de 09:00 a 16:00 hs',
    advisorPhone: process.env.ADVISOR_PHONE || '',
    advisorEmail: process.env.ADVISOR_EMAIL || '',
    publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
    portfolioLinks: [
      'https://mye-software-demo-1.com',
      'https://mye-software-demo-2.com',
      'https://mye-software-demo-3.com'
    ],
    landingPriceFrom: 180000,
    corporatePriceFrom: 310000,
    systemPriceFrom: 650000,
    ecommercePriceFrom: 1200000,
    followupDelayMinutes: Number(process.env.FOLLOWUP_DELAY_MINUTES || 360),
    maxFollowups: Number(process.env.MAX_FOLLOWUPS || 2),
    webhookToken: process.env.WEBHOOK_TOKEN || 'cambiar-este-token',
    autoSendPortfolioAfterBudget: true,
    askEmailInFlow: true,
    askBudgetRangeInFlow: true,
    askDeadlineInFlow: true
  }

  const fileConfig = readJson(configFile, defaultConfig)
  return {
    ...defaultConfig,
    ...fileConfig,
    portfolioLinks: fileConfig.portfolioLinks?.length ? fileConfig.portfolioLinks : defaultConfig.portfolioLinks
  }
}

function detectBudgetRange(text = '') {
  const t = normalizeText(text)
  if (!t) return ''
  if (t.includes('menos') || t.includes('bajo') || t.includes('economico') || t.includes('150') || t.includes('200')) return 'bajo'
  if (t.includes('medio') || t.includes('300') || t.includes('400') || t.includes('500')) return 'medio'
  if (t.includes('alto') || t.includes('premium') || t.includes('600') || t.includes('1000') || t.includes('1.000')) return 'alto'
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
    { intent: 'portfolio', keywords: ['portfolio', 'portafolio', 'ejemplos', 'trabajos', 'muestras', 'casos'] },
    { intent: 'budget', keywords: ['precio', 'precios', 'presupuesto', 'costo', 'costos', 'cuanto sale', 'cuanto cuesta'] }
  ]

  for (const group of patterns) {
    if (group.keywords.some(k => t.includes(normalizeText(k)))) return group.intent
  }

  if (['1','2','3','4','5','6','7'].includes(t)) {
    return {
      '1': 'budget',
      '2': 'landing',
      '3': 'web',
      '4': 'tienda',
      '5': 'sistema',
      '6': 'portfolio',
      '7': 'asesor'
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
    leads.push({ ...defaultLead(phone), ...patch, updatedAt: new Date().toISOString() })
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
  if (lead.nivel) tags.add(`lead_${lead.nivel}`)

  const refreshedLevel = classifyLeadByIntent(lead.interes, `${lead.proyecto} ${lead.consulta}`, lead)
  saveLeadPatch(phone, { etiquetas: Array.from(tags), nivel: refreshedLevel })
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
  const config = getConfig()
  return `╔════════════════════╗
   *${config.companyName}*
╚════════════════════╝

Hola 👋 Soy el asistente virtual de *${config.companyName}*.

📌 Estoy preparado para ayudarte a elegir la mejor web para tu negocio.
⏰ Atención humana:
${config.humanHours}

*Elegí una opción:*

1️⃣ Presupuesto web
2️⃣ Landing Page
3️⃣ Página web empresarial
4️⃣ Tienda online
5️⃣ Sistema a medida
6️⃣ Ver portfolio
7️⃣ Hablar con asesor

También podés escribir:
*precio, presupuesto, web, tienda, sistema, portfolio, asesor*`
}

function buildPortfolioMessage() {
  const config = getConfig()
  const links = (config.portfolioLinks || []).map(l => `🌐 ${l}`).join('\n')
  return `📂 *Portfolio automático*

Estos son algunos ejemplos para que veas el tipo de trabajos que podemos hacer:\n\n${links}\n\nSi querés una propuesta, respondé:\n*1* para presupuesto\no escribí directamente:\n*asesor*`
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
    min = config.landingPriceFrom
    max = config.landingPriceFrom + 100000
  } else if (p.includes('tienda') || p.includes('ecommerce')) {
    tipo = 'Tienda Online'
    min = config.ecommercePriceFrom
    max = config.ecommercePriceFrom + 600000
  } else if (p.includes('sistema') || p.includes('app') || p.includes('panel')) {
    tipo = 'Sistema a medida'
    min = config.systemPriceFrom
    max = config.systemPriceFrom + 1550000
  } else {
    tipo = 'Página Web Profesional'
    min = config.corporatePriceFrom
    max = config.corporatePriceFrom + 240000
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

function buildSalesPitchForIntent(intent) {
  const config = getConfig()
  if (intent === 'landing') {
    return `🚀 *Landing Page*\n\nIdeal para vender un servicio puntual, lanzar campañas o captar leads.\n\nIncluye:\n• Diseño premium\n• Botón de WhatsApp\n• Formulario\n• SEO básico\n\n💰 Desde *$${formatMoney(config.landingPriceFrom)}*\n\nSi querés una propuesta exacta, respondé *presupuesto*.`
  }
  if (intent === 'web') {
    return `🌐 *Página Web Profesional*\n\nIdeal para empresas y negocios que necesitan presencia seria y que convierta.\n\nIncluye:\n• Hasta 5 secciones\n• Formulario de contacto\n• SEO básico\n• Integración con WhatsApp\n\n💰 Desde *$${formatMoney(config.corporatePriceFrom)}*\n\nSi querés una propuesta exacta, respondé *presupuesto*.`
  }
  if (intent === 'tienda') {
    return `🛒 *Tienda Online*\n\nIdeal para vender productos por internet y automatizar consultas.\n\nIncluye:\n• Catálogo\n• Carrito o pedido\n• Integración WhatsApp\n• Panel de administración\n\n💰 Desde *$${formatMoney(config.ecommercePriceFrom)}*\n\nSi querés, respondé *presupuesto*.`
  }
  if (intent === 'sistema') {
    return `⚙️ *Sistema a medida*\n\nPodemos desarrollar:\n• Turnos\n• Reservas\n• Gestión de clientes\n• Control de stock\n• Panel administrador\n\n💰 Desde *$${formatMoney(config.systemPriceFrom)}*\n\nSi querés, respondé *presupuesto*.`
  }
  return null
}

function defaultFallback() {
  return `No te entendí del todo 👌\n\nPodés responder con:\n\n1️⃣ Presupuesto web\n2️⃣ Landing Page\n3️⃣ Página web empresarial\n4️⃣ Tienda online\n5️⃣ Sistema a medida\n6️⃣ Ver portfolio\n7️⃣ Hablar con asesor\n\nO escribir:\n*precio, web, tienda, sistema, portfolio, asesor*`
}

function isSelfBotEcho(text) {
  const t = normalizeText(text)
  return [
    'mye software',
    'portfolio automatico',
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
      ? `Hola 👋 Solo quería saber si pudiste ver la información que te enviamos.\n\nSi querés seguimos por acá:\n1️⃣ Presupuesto\n2️⃣ Landing\n3️⃣ Web\n4️⃣ Tienda\n5️⃣ Sistema\n7️⃣ Asesor`
      : `Te escribo por última vez para no molestarte 😊\n\nSi todavía querés avanzar con tu proyecto, respondé:\n1️⃣ Presupuesto\n7️⃣ Asesor`

    try {
      await sendAndTrack(sock, reminder.chatId, message)
      reminder.sentCount = (reminder.sentCount || 0) + 1
      reminder.dueAt = new Date(Date.now() + config.followupDelayMinutes * 60 * 1000).toISOString()
      saveLeadPatch(reminder.telefono, {
        followupCount: reminder.sentCount,
        estado: reminder.sentCount >= config.maxFollowups ? 'seguimiento_finalizado' : 'seguimiento_activo'
      })
      updateTagsAndLevel(reminder.telefono)
      if (reminder.sentCount >= config.maxFollowups) reminder.active = false
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
  const digits = String(phone).replace(/\D/g, '')
  if (!digits) return ''
  if (digits.endsWith('@s.whatsapp.net')) return digits
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
  const phone = String(leadPayload.telefono || leadPayload.phone || '').replace(/\D/g, '')
  if (!phone) throw new Error('El lead debe incluir telefono')

  const project = leadPayload.proyecto || leadPayload.projectType || 'Página Web Profesional'
  const extrasRaw = leadPayload.extras || leadPayload.features || ''
  const extras = Array.isArray(extrasRaw) ? extrasRaw.join(', ') : extrasRaw
  const urgency = leadPayload.urgencia || leadPayload.timeline || leadPayload.deadline || 'Media'
  const budgetRange = detectBudgetRange(leadPayload.budgetRange || leadPayload.presupuesto || leadPayload.estimatedRange || '')
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
    nivel: classifyLeadByIntent(intent, `${project} ${leadPayload.consulta || ''}`, { budgetRange, urgencia: urgency })
  })
  updateTagsAndLevel(phone)

  const est = estimateByProject(project, extras)
  const message = `Hola ${leadPayload.nombre || ''} 👋\n\nGracias por solicitar un presupuesto en *${getConfig().companyName}*.\n\n🧩 Proyecto: *${project}*\n💰 Estimación inicial: *$${formatMoney(est.min)}* a *$${formatMoney(est.max)}*.*\n📌 Próximo paso: revisar detalles y enviarte propuesta final.\n\nSi querés, respondé este mensaje con más información o escribí *asesor*.`

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
    qrPreviewAvailable: Boolean(lastQr),
    leads: readJson(leadsFile, []).length
  }
}

function getLastQr() {
  return lastQr
}

async function startBot() {
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
    logger: pino({ level: 'silent' }),
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
      console.log('\n============================')
      console.log('ESCANEÁ ESTE QR CON WHATSAPP')
      console.log('============================\n')
      QRCode.generate(qr, { small: true })
      console.log('\nWhatsApp → Dispositivos vinculados → Vincular dispositivo\n')
    }

    if (connection === 'open') {
      reconnecting = false
      botStatus.connected = true
      botStatus.user = sock?.user?.id || null
      botStatus.lastConnectionAt = new Date().toISOString()
      botStatus.lastError = null
      console.log('✅ Bot conectado correctamente a WhatsApp.')
      console.log('✅ V6 activo: ventas, leads web, seguimiento, panel, webhook, Render.')
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
        setTimeout(() => startBot().catch(err => console.error('❌ Reintento fallido:', err.message)), 3000)
      } else if (!shouldReconnect) {
        console.log('❌ Sesión cerrada. Eliminá la carpeta auth y volvé a ejecutar.')
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
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
    if (senderName) saveLeadPatch(phone, { nombre: getLead(phone)?.nombre || senderName })

    try {
      cancelFollowup(phone)

      if (['menu', 'menú', 'cancelar', 'salir', 'reiniciar', 'inicio', 'hola', 'buenas'].includes(text)) {
        clearChatSession(from)
        await sendAndTrack(sock, from, buildMenu())
        return
      }

      if (session.step === 'budget_name') {
        session.data.nombre = rawText.trim()
        session.step = getConfig().askEmailInFlow ? 'budget_email' : 'budget_rubro'
        setChatSession(from, session)
        saveLeadPatch(phone, { nombre: rawText.trim(), estado: 'capturando_datos' })
        updateTagsAndLevel(phone)
        await sendAndTrack(sock, from, getConfig().askEmailInFlow
          ? `*Paso 2 de 8*\n¿Cuál es tu *email*?\n\nSi no querés dejarlo ahora, respondé *no tengo*.`
          : `*Paso 2 de 8*\n¿A qué se dedica tu negocio o rubro?`)
        return
      }

      if (session.step === 'budget_email') {
        session.data.email = rawText.trim()
        session.step = 'budget_rubro'
        setChatSession(from, session)
        saveLeadPatch(phone, { email: rawText.trim(), estado: 'capturando_datos' })
        updateTagsAndLevel(phone)
        await sendAndTrack(sock, from, `*Paso 3 de 8*\n¿A qué se dedica tu negocio o rubro?`)
        return
      }

      if (session.step === 'budget_rubro') {
        session.data.rubro = rawText.trim()
        session.step = 'budget_project'
        setChatSession(from, session)
        saveLeadPatch(phone, { rubro: rawText.trim(), estado: 'capturando_datos' })
        updateTagsAndLevel(phone)
        await sendAndTrack(sock, from, `*Paso 4 de 8*\n¿Qué necesitás?\n\nEjemplos:\n• Landing Page\n• Página web empresarial\n• Tienda online\n• Sistema a medida`)
        return
      }

      if (session.step === 'budget_project') {
        session.data.proyecto = rawText.trim()
        session.step = 'budget_extras'
        setChatSession(from, session)
        const intent = inferIntent(rawText) || 'web'
        saveLeadPatch(phone, {
          proyecto: rawText.trim(),
          interes: intent,
          nivel: classifyLeadByIntent(intent, rawText),
          estado: 'capturando_datos'
        })
        updateTagsAndLevel(phone)
        await sendAndTrack(sock, from, `*Paso 5 de 8*\n¿Necesitás algo extra?\n\nEjemplos:\n• Botón de WhatsApp\n• Formulario\n• Catálogo\n• Panel administrador\n• Nada más`)
        return
      }

      if (session.step === 'budget_extras') {
        session.data.extras = rawText.trim()
        session.step = getConfig().askBudgetRangeInFlow ? 'budget_range' : 'budget_urgency'
        setChatSession(from, session)
        saveLeadPatch(phone, { extras: rawText.trim(), estado: 'capturando_datos' })
        updateTagsAndLevel(phone)
        await sendAndTrack(sock, from, getConfig().askBudgetRangeInFlow
          ? `*Paso 6 de 8*\n¿Qué nivel de inversión aproximado tenés pensado?\n\nPodés responder:\n• Bajo\n• Medio\n• Alto\n• No lo sé todavía`
          : `*Paso 6 de 8*\n¿Qué tan urgente es?\n\nPodés responder:\n• Alta\n• Media\n• Baja`)
        return
      }

      if (session.step === 'budget_range') {
        session.data.budgetRange = rawText.trim()
        session.step = 'budget_urgency'
        setChatSession(from, session)
        saveLeadPatch(phone, { budgetRange: detectBudgetRange(rawText), estado: 'capturando_datos' })
        updateTagsAndLevel(phone)
        await sendAndTrack(sock, from, `*Paso 7 de 8*\n¿Qué tan urgente es?\n\nPodés responder:\n• Alta\n• Media\n• Baja`)
        return
      }

      if (session.step === 'budget_urgency') {
        session.data.urgencia = rawText.trim()
        session.step = 'budget_followup_permission'
        setChatSession(from, session)
        saveLeadPatch(phone, { urgencia: rawText.trim(), estado: 'capturando_datos' })
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

        let response = `${buildBudgetSummary(session.data)}\n\n${accepted ? '✅ Seguimiento automático activado. Te voy a escribir como máximo 2 veces si no respondés.' : '✅ Perfecto, no activamos seguimiento automático.'}\n\nSi querés ver ejemplos, escribí *portfolio*.\nSi querés hablar con una persona, escribí *asesor*.`
        if (getConfig().autoSendPortfolioAfterBudget) {
          response += `\n\n${buildPortfolioMessage()}`
        }
        await sendAndTrack(sock, from, response)
        return
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

        if (intent === 'portfolio') {
          saveLeadPatch(phone, { interes: 'portfolio', estado: 'portfolio_enviado' })
          updateTagsAndLevel(phone)
          await sendAndTrack(sock, from, buildPortfolioMessage())
          return
        }

        if (intent === 'asesor') {
          saveLeadPatch(phone, {
            interes: 'asesor',
            nivel: classifyLeadByIntent('asesor', rawText),
            estado: 'derivado_humano'
          })
          updateTagsAndLevel(phone)
          const cfg = getConfig()
          await sendAndTrack(sock, from, `👨‍💼 *Derivación automática a humano*\n\nPerfecto. Tu consulta quedó marcada para atención humana.\n\n⏰ Horario:\n${cfg.humanHours}\n${cfg.advisorPhone ? `📱 WhatsApp asesor: ${cfg.advisorPhone}\n` : ''}${cfg.advisorEmail ? `📧 Email: ${cfg.advisorEmail}\n` : ''}\nMientras tanto, si querés, dejame:\n• Tu nombre\n• Tu rubro\n• Qué necesitás\n\nAsí te ayudamos más rápido.`)
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
