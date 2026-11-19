Read in English: [SECURITY.md](SECURITY.md)

# Seguridad

## Informar de un problema

Informa de los problemas de seguridad en privado, con el botón "Report a vulnerability" de GitHub en la pestaña
Security de este repositorio, no en una incidencia pública. Cuenta qué encontraste, cómo reproducirlo y qué permite
hacer a alguien. Deberías recibir respuesta en una semana.

## Cómo está pensado ejecutar BrainAI

BrainAI guarda los recuerdos de una persona, así que está construido para que solo puedan llegar a él su dueño y sus
apps:

- **Un dueño, sin claves estáticas.** El panel exige una contraseña y un código de autenticación. Las apps se
  conectan con OAuth y el dueño aprueba cada una; cualquier conexión se puede cortar desde Ajustes o desde la línea de
  comandos.
- **Sin puertos abiertos.** `docker-compose.yml` no publica ninguno: un túnel de Cloudflare es la única entrada. El
  límite de intentos de inicio de sesión se fía de la cabecera `cf-connecting-ip` del túnel solo por eso
  (`TRUST_CF_CONNECTING_IP`).
- **Los secretos se rechazan.** El texto que parece una contraseña, una clave o un token no se guarda como recuerdo ni
  como página.
- **Las copias de seguridad no contienen datos de acceso:** ni contraseña, ni secreto de autenticación, ni sesiones, ni
  tokens. La copia externa se cifra con una clave que nunca toca el servidor.
- **Los recuerdos son información, no instrucciones.** A los asistentes se les dice que nunca ejecuten comandos ni
  envíen datos porque un recuerdo lo diga, y los recuerdos que parecen instrucciones esperan la aprobación del dueño.

Si lo ejecutas de otra forma (un puerto publicado, un proxy inverso distinto del túnel), deja
`TRUST_CF_CONNECTING_IP` desactivado y asegúrate de que solo tu proxy pueda llegar a la app.

## Versiones con soporte

Solo la versión más reciente recibe correcciones. Actualizar es `git pull && docker compose up -d --build`.
