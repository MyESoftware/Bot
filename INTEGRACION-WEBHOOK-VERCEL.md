# Integración con tu web en Vercel

Usá este fetch desde tu formulario o simulador:

```js
await fetch('https://TU-BOT.onrender.com/api/webhook/lead', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-webhook-token': process.env.NEXT_PUBLIC_BOT_WEBHOOK_TOKEN || 'TU_TOKEN'
  },
  body: JSON.stringify({
    nombre,
    telefono,
    email,
    rubro,
    proyecto,
    extras,
    urgencia,
    budgetRange,
    fuente: 'web',
    deseaSeguimiento: true
  })
})
```

Variables sugeridas en Vercel:

- `NEXT_PUBLIC_BOT_WEBHOOK_URL`
- `BOT_WEBHOOK_TOKEN`

No subas el token al cliente si vas a enviar el lead directo desde frontend. La forma más segura es crear una ruta API en tu web y desde ahí reenviar al bot.
