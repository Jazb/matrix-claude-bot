# Ideas para mejoras futuras

Funcionalidades que se podrian anadir si se necesitan. El bot actual es funcional y cubre los casos principales, pero hay margen para expandirlo.

## Implementadas

Las siguientes mejoras de la lista original ya estan implementadas:

- **Markdown rendering**: respuestas renderizadas con `marked` y enviadas como HTML a Matrix.
- **Soporte E2EE**: encriptacion end-to-end completa con Megolm/Olm via Rust crypto SDK, incluyendo descarga y desencriptacion de media encriptados (audio, imagenes).
- **Modo bridge (tmux + hooks)**: Claude interactivo con aprobacion dinamica de herramientas via Matrix.
- **Modo IDE (MCP WebSocket)**: protocolo nativo de Claude Code con diff review desde Matrix.

## Streaming de respuestas

En vez de esperar a que Claude termine, enviar chunks conforme van llegando:

- Usar `--output-format stream-json` en Claude Code
- Parsear eventos JSON del stream de stdout
- Editar el mensaje de Matrix progresivamente o enviar mensajes parciales

Esto mejoraria mucho la experiencia para respuestas largas.

## Multiples usuarios

Cambiar de un solo `MATRIX_ALLOWED_USER_ID` a una lista o roles:

```bash
MATRIX_ALLOWED_USERS=@admin:server,@dev1:server,@dev2:server
```

O implementar roles:

- **admin**: puede usar todos los comandos y proyectos
- **user**: solo puede enviar prompts, no cambiar proyecto
- **readonly**: solo puede ver respuestas (observador)

## Verificacion de dispositivo programatica

`matrix-bot-sdk` no implementa cross-signing ni verificacion interactiva (`m.key.verification.*` esta listado como "not yet implemented"). Cuando el SDK lo soporte, el bot podria auto-verificarse al arrancar sin intervencion manual.

## Modelo de Claude configurable

Comando para cambiar de modelo sin reiniciar:

```
!model sonnet
!model opus
```

Esto pasaria `--model` al comando de Claude.

## Ficheros adjuntos en respuestas

Si Claude genera ficheros (patches, scripts, etc.), subirlos a Matrix como adjuntos:

```typescript
const mxcUri = await client.uploadContent(buffer, "text/plain", "patch.diff");
await client.sendMessage(roomId, {
  msgtype: "m.file",
  url: mxcUri,
  body: "patch.diff",
  info: { mimetype: "text/plain", size: buffer.length },
});
```

## Backup de sesiones

Copiar `sessions.json` periodicamente por si el servidor se cae:

```bash
# En cron
0 * * * * cp /opt/matrix-claude-bot/data/sessions.json /opt/matrix-claude-bot/data/sessions.backup.json
```

O usar un storage provider de base de datos en vez de JSON.

## Notificaciones proactivas

Inspirado en Jackpoint: enviar notificaciones cuando Claude necesita input, cuando termina una tarea larga, o cuando hay un error. El modo IDE ya soporta parcialmente esto via MCP tools (openDiff), pero podria expandirse.

## Rate limiting

Si se abre a multiples usuarios, anadir limites por usuario:

- Maximo N requests por minuto
- Maximo N requests concurrentes en cola
- Notificar al usuario si excede el limite

## Limpieza automatica de /tmp

Los ficheros de audio e imagen se acumulan en `TMP_DIR`. Un cron o un cleanup periodico dentro del bot podria eliminar ficheros antiguos:

```bash
# Eliminar ficheros de mas de 1 hora
find /tmp/matrix-claude-bot -type f -mmin +60 -delete
```
