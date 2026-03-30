const express = require('express')
const path = require('path')
const fs = require('fs')
const {
  startBot,
  getBotSnapshot,
  getLastQr,
  sendManualMessage,
  ingestWebLead,
  getConfig,
  readJson
} = require('./bot')

const app = express()
const PORT = process.env.PORT || 3000
const baseDir = __dirname
const dataDir = path.join(baseDir, 'data')
const leadsFile = path.join(dataDir, 'leads.json')
const configFile = path.join(dataDir, 'config.json')

function ensureFile(filePath, defaultValue) {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2), 'utf8')
  }
}

function authWebhook(req, res, next) {
  const token = req.headers['x-webhook-token'] || req.headers.authorization?.replace(/^Bearer\s+/i, '')
  if (!token || token !== getConfig().webhookToken) {
    return res.status(401).json({ ok: false, error: 'Token inválido o ausente' })
  }
  next()
}

ensureFile(leadsFile, [])
ensureFile(configFile, getConfig())

app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: true }))
app.use(express.static(path.join(baseDir, 'public')))

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'bot-whatsapp-master-pro-v6', status: getBotSnapshot() })
})

app.get('/api/status', (req, res) => {
  res.json(getBotSnapshot())
})

app.get('/api/qr', (req, res) => {
  const qr = getLastQr()
  if (!qr) return res.status(404).json({ ok: false, error: 'QR no disponible' })
  res.json({ ok: true, qr })
})

app.get('/api/leads', (req, res) => {
  const leads = readJson(leadsFile, [])
  const q = (req.query.q || '').toString().toLowerCase().trim()
  let data = leads

  if (q) {
    data = data.filter(lead => JSON.stringify(lead).toLowerCase().includes(q))
  }

  res.json(data.sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0)))
})

app.get('/api/stats', (req, res) => {
  const leads = readJson(leadsFile, [])
  const stats = {
    total: leads.length,
    caliente: leads.filter(l => l.nivel === 'caliente').length,
    tibio: leads.filter(l => l.nivel === 'tibio').length,
    frio: leads.filter(l => l.nivel === 'frio').length,
    listo: leads.filter(l => l.nivel === 'listo').length,
    seguimiento: leads.filter(l => l.deseaSeguimiento === true).length,
    web: leads.filter(l => l.fuente === 'web').length,
    whatsapp: leads.filter(l => l.fuente !== 'web').length
  }
  res.json(stats)
})

app.get('/api/config', (req, res) => {
  res.json(getConfig())
})

app.post('/api/webhook/lead', authWebhook, async (req, res) => {
  try {
    const result = await ingestWebLead(req.body || {})
    res.json(result)
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message })
  }
})

app.post('/api/send-message', authWebhook, async (req, res) => {
  try {
    const { telefono, mensaje } = req.body || {}
    if (!telefono || !mensaje) {
      return res.status(400).json({ ok: false, error: 'telefono y mensaje son obligatorios' })
    }
    const result = await sendManualMessage(telefono, mensaje)
    res.json(result)
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message })
  }
})

app.listen(PORT, async () => {
  console.log(`✅ Panel y API listos en puerto ${PORT}`)
  try {
    await startBot()
  } catch (error) {
    console.error('❌ Error iniciando WhatsApp:', error.message)
  }
})
