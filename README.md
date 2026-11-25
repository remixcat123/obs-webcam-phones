# Webcam P2P Persistente para OBS Studio (v2.1)

Aplicación web estática (pensada para desplegarse en **GitHub Pages** bajo HTTPS) que permite utilizar un teléfono móvil o una cámara web conectada a la PC como fuente de video de baja latencia en **OBS Studio** (mediante *Fuente de Navegador*) usando **WebRTC P2P sobre PeerJS** dentro de la red local (LAN).

## Características principales
- **Doble modo desde una misma URL:** Modo emisor por defecto (`?id=SALA`) y modo receptor transparente con reconexión automática (`?view&id=SALA`) y contraseña opcional.
- **Captura y formato:** Selección de lente/cámara (priorizando cámara trasera en móviles), presets de resolución en 16:9 y 9:16, FPS (`24`, `30`, `60`) y control de bitrate WebRTC (`maxBitrate` y `maintain-resolution`), con cambio de pista en caliente (`replaceTrack`).
- **Controles dinámicos del sensor:** Lectura de capacidades reales del dispositivo (`getCapabilities()` / `getSettings()`) con controles sincronizados, manejo de modos automáticos/manuales y reaplicación segura.
- **Perfiles persistentes y JSON:** Guardado de perfiles con persistencia en `localStorage` y exportación/importación manual en formato `.json` con ajuste de rangos (`clamping`) al sensor activo.
- **Ahorro energético y métricas:** Bloqueo de pantalla (`WakeLock`), modo ahorro OLED a doble toque ocultando el preview local y monitor de métricas WebRTC bajo demanda.

## Créditos y desarrollo
Proyecto desarrollado con arquitectura modular y especificación de requisitos definida por el autor, con asistencia iterativa de **Gemini (IA)** para el diseño de contratos, depuración y refinamiento del código.
