Read in English: [docs/CLOUD.md](../CLOUD.md)

# BrainAI en un servidor en la nube

El mismo BrainAI que en un servidor en casa (`docs/es/RUNBOOK.md`), pero en una pequeña máquina Linux alquilada en lugar de una en casa.

## Qué necesitas

- Un servidor Linux (x86_64 o arm64) con unos 2 GB de memoria, de cualquier proveedor. BrainAI usa hasta unos 1,5 GB;
  construir la imagen necesita algo más.
- Un dominio en Cloudflare, para el túnel.
- Acceso SSH con clave.

## Configurarlo

Sigue `docs/es/RUNBOOK.md`, sección 1, tal como está escrita: Docker, el clon, el túnel de Cloudflare, `.env`, el arranque, la
contraseña y el autenticador. Si vienes de la app para Mac, usa la sección 4 ("Pasar desde la app") en lugar de empezar
de cero.

## En qué se diferencia de un servidor en casa

- **Sin puertos que abrir.** El túnel se conecta hacia fuera, a Cloudflare, así que el cortafuegos del proveedor puede bloquear todos los
  puertos de entrada salvo SSH. Mantenlo así: BrainAI se fía de la cabecera de dirección del túnel solo porque nada más llega a él.
- **Las copias de seguridad salen de la máquina.** Un servidor alquilado puede desaparecer con sus discos. Apunta las copias de la
  copia nocturna (`COPY_DIRS` en `overlay/scripts.env`) a un almacenamiento en otro sitio, o conserva la copia semanal cifrada externa
  (RUNBOOK, sección 1), y prueba una restauración una vez (sección 3).
- **Las actualizaciones y los reinicios son cosa tuya.** Activa las actualizaciones de seguridad automáticas del proveedor para el
  sistema y asegúrate de que Docker arranca con la máquina (`sudo systemctl enable docker`). Actualizar BrainAI es el mismo `git pull && docker compose up -d
  --build`.
- **Coste:** las máquinas más pequeñas de los proveedores habituales cuestan unos pocos euros al mes; BrainAI no necesita más.
