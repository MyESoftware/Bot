const express = require('express')
const path = require('path')
const fs = require('fs')
const {
  startBot,
  getBotSnapshot,
  getLastQr,
  getLastQrImage,
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

function authPanel(req, res, next) {
  const panelPassword = getConfig().panelPassword || ''
  if (!panelPassword) return next()

  const auth = req.headers.authorization || ''
  const [scheme, encoded] = auth.split(' ')
  if (scheme !== 'Basic' || !encoded) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Bot Panel"')
    return res.status(401).send('Autenticación requerida')
  }

  const decoded = Buffer.from(encoded, 'base64').toString('utf8')
  const [, password] = decoded.split(':')
  if (password !== panelPassword) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Bot Panel"')
    return res.status(401).send('Credenciales inválidas')
  }
  next()
}

ensureFile(leadsFile, [])
ensureFile(configFile, getConfig())

app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: true }))
app.use('/assets', express.static(path.join(baseDir, 'public')))

app.get('/', authPanel, (req, res) => {
  res.sendFile(path.join(baseDir, 'public', 'index.html'))
})

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'bot-whatsapp-master-pro-v6-oracle', status: getBotSnapshot() })
})

app.get('/api/status', authPanel, (req, res) => {
  res.json(getBotSnapshot())
})

app.get('/api/qr', authPanel, (req, res) => {
  const qr = getLastQr()
  const image = getLastQrImage()
  if (!qr || !image) return res.status(404).json({ ok: false, error: 'QR no disponible' })
  res.json({ ok: true, qr, image })
})

app.get('/qr', authPanel, (req, res) => {
  const image = getLastQrImage()

  if (!image) {
    return res.send(`
      <html>
        <body style="font-family:Arial,sans-serif;background:#081120;color:#fff;text-align:center;padding:40px;">
          <h1>QR no disponible</h1>
          <p>Puede que el bot ya esté conectado o todavía no haya generado uno nuevo.</p>
          <p><a href="/" style="color:#60a5fa;">Volver al panel</a></p>
        </body>
      </html>
    `)
  }

  res.send(`
    <html>
      <body style="font-family:Arial,sans-serif;background:#081120;color:#fff;text-align:center;padding:40px;">
        <h1>Escaneá este QR</h1>
        <p>WhatsApp → Dispositivos vinculados → Vincular dispositivo</p>
        <img src="${image}" style="max-width:340px;width:100%;background:#fff;padding:16px;border-radius:18px;" />
        <p style="margin-top:20px;"><a href="/" style="color:#60a5fa;">Volver al panel</a></p>
      </body>
    </html>
  `)
})

app.get('/api/leads', authPanel, (req, res) => {
  const leads = readJson(leadsFile, [])
  const q = (req.query.q || '').toString().toLowerCase().trim()
  let data = leads

  if (q) {
    data = data.filter(lead => JSON.stringify(lead).toLowerCase().includes(q))
  }

  res.json(data.sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0)))
})

app.get('/api/stats', authPanel, (req, res) => {
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

app.get('/api/config', authPanel, (req, res) => {
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

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`✅ Panel y API listos en puerto ${PORT}`)
  try {
    await startBot()
  } catch (error) {
    console.error('❌ Error iniciando WhatsApp:', error.message)
  }
})
