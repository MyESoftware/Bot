# BOT WHATSAPP MASTER PRO V6 - Oracle Cloud Free VPS

Esta versión ya viene preparada para:

- **guardar sesión correctamente** en la carpeta `auth/`
- **generar QR web real** en `/qr`
- **funcionar 24/7** con `pm2`
- **tener panel simple** en `/`

## 1. Requisitos recomendados en Oracle

- Instancia Ubuntu 22.04 o 24.04
- Puerto **3000** abierto en Oracle Cloud
- Puerto **80** opcional si después querés poner Nginx

## 2. Subida rápida al VPS

Subí este proyecto al servidor, por ejemplo a:

```bash
/home/ubuntu/bot-whatsapp-master-pro-v6
```

Entrá por SSH y ejecutá:

```bash
cd /home/ubuntu/bot-whatsapp-master-pro-v6
cp .env.example .env
nano .env
```

Configurá al menos estas variables:

```env
PORT=3000
PUBLIC_BASE_URL=http://TU_IP_PUBLICA:3000
WEBHOOK_TOKEN=tu_token_seguro
PANEL_PASSWORD=tu_clave_segura
```

## 3. Instalación

```bash
chmod +x deploy-oracle.sh
./deploy-oracle.sh
```

Si preferís manual:

```bash
sudo apt update
sudo apt install -y curl unzip nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
npm install
pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup
```

## 4. Abrir el panel

- Panel: `http://TU_IP_PUBLICA:3000/`
- QR web: `http://TU_IP_PUBLICA:3000/qr`
- Health: `http://TU_IP_PUBLICA:3000/health`

Si definiste `PANEL_PASSWORD`, el panel usa **Basic Auth**.

- usuario: cualquier valor
- contraseña: la de `PANEL_PASSWORD`

## 5. Persistencia de sesión

La sesión de WhatsApp se guarda en:

```text
auth/
```

Como en Oracle VPS el disco **sí persiste**, no deberías tener que escanear el QR cada reinicio normal del proceso o del servidor, salvo cierre de sesión real de WhatsApp.

## 6. Reiniciar o ver logs

```bash
pm2 list
pm2 logs bot-whatsapp-master-pro-v6
pm2 restart bot-whatsapp-master-pro-v6
pm2 stop bot-whatsapp-master-pro-v6
```

## 7. Webhook para tu web

Endpoint:

```text
POST /api/webhook/lead
```

Header:

```text
x-webhook-token: TU_TOKEN
```

Ejemplo de body:

```json
{
  "nombre": "Juan",
  "telefono": "2615551234",
  "email": "juan@email.com",
  "rubro": "Estudio jurídico",
  "proyecto": "Página web empresarial",
  "extras": ["Formulario", "WhatsApp"],
  "urgencia": "Media",
  "deseaSeguimiento": true,
  "fuente": "web"
}
```

## 8. Si querés poner dominio y HTTPS

Podés dejar Nginx como proxy y luego usar Certbot. Esta versión todavía no trae esa automatización para no tocar más cosas de las necesarias.
