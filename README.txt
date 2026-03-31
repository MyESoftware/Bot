BOT WHATSAPP MASTER PRO V6
==========================

Qué trae esta versión
---------------------
- Bot vendedor de webs (landing, web, tienda, sistema)
- Presupuesto guiado en 8 pasos
- Captura de nombre, email, rubro, proyecto, extras, urgencia y rango de inversión
- Seguimiento automático con máximo 2 recordatorios

- Derivación a humano
- Webhook para recibir leads desde tu web en Vercel
- Panel simple de leads
- Configuración lista para Render

Cómo correr local
-----------------
1) npm install
2) npm start
3) Abrí http://localhost:3000
4) Revisá la consola para escanear el QR

Deploy en Render
----------------
1) Subí este proyecto a GitHub
2) En Render: New + Web Service
3) Conectá el repo
4) Build Command: npm install
5) Start Command: npm start
6) Agregá variables de entorno usando .env.example
7) Cuando deploye, abrí /api/qr o los logs y escaneá el QR

Webhook para conectar tu web
----------------------------
POST /api/webhook/lead
Header: x-webhook-token: TU_TOKEN
Content-Type: application/json

Ejemplo body:
{
  "nombre": "Juan",
  "telefono": "5492611234567",
  "email": "juan@gmail.com",
  "rubro": "Estudio jurídico",
  "proyecto": "Landing Page",
  "extras": ["WhatsApp", "Formulario"],
  "urgencia": "Alta",
  "budgetRange": "Medio",
  "fuente": "web",
  "deseaSeguimiento": true
}

Qué devuelve
------------
- Guarda el lead
- Lo clasifica
- Intenta enviar WhatsApp automático
- Programa seguimiento si corresponde

Endpoints útiles
----------------
GET  /health
GET  /api/status
GET  /api/qr
GET  /api/leads
GET  /api/stats
GET  /api/config
POST /api/webhook/lead
POST /api/send-message

Importante sobre Render
-----------------------
- En free puede dormir el servicio
- Cuando despierte puede tardar unos segundos
- El bot NO va en Vercel; la web sí
