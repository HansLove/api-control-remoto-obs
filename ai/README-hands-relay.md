# Animación 3D con manos para OBS

Overlay de partículas 3D controlado por gestos de manos.

---

## ⚠️ Transparencia: solo con “Fuente Navegador”, no con captura de ventana

Si pones la URL en **Chrome** y en OBS usas **Captura de ventana** (Window Capture) de esa ventana, **nunca** podrás tener fondo transparente: OBS solo recibe la imagen de la ventana (siempre opaca). La ventana de Chrome no “deja ver” lo que hay detrás.

Para tener **solo partículas sobre tu cámara** (fondo transparente) hay que usar en OBS la **Fuente Navegador** (Browser Source) con la URL del **overlay** y activar **«Usar fondo transparente»**. Ese navegador integrado no tiene cámara, por eso se usa el **relé**: Chrome (con cámara) detecta las manos y las envía; el overlay en OBS las recibe y dibuja las partículas con fondo transparente.

**Resumen:** Cámara = una fuente en OBS (ej. Dispositivo de captura de vídeo). Partículas = otra fuente, **Navegador**, con `live-anim-obs.html` y fondo transparente. Chrome con `live-anim.html?broadcast=1` solo tiene que estar abierto en segundo plano (puede estar minimizado o en otro monitor).

---

## Servidores (arrancar primero)

En **dos terminales** distintas, desde la **raíz del proyecto** (`control/`):

**Terminal 1 – Relé de manos**
```bash
cd /ruta/al/proyecto/control
npm run relay
```
→ Debe decir: `Hands relay: ws://localhost:8765`. **Déjalo abierto.**

**Terminal 2 – Servidor web**
```bash
cd /ruta/al/proyecto/control
npm start
```
→ Debe decir: `[SERVER] http://localhost:3000`. **Déjalo abierto.**

---

## Estrategia A: Relé (Chrome envía manos, OBS muestra overlay)

Sirve cuando quieres que en OBS solo se vea la animación (sin la cámara), y la cámara corre en otra pestaña.

### Paso 1 – Comprobar que los servidores están en marcha
- Terminal 1: `Hands relay: ws://localhost:8765`
- Terminal 2: `[SERVER] http://localhost:3000`

### Paso 2 – Pestaña “emisora” en Chrome
1. Abre **Chrome**.
2. Ve a: **http://localhost:3000/ai/live-anim.html?broadcast=1**
3. Cuando pida permiso, **permite la cámara**.
4. Debes ver la animación y, arriba en el centro, el texto en verde **«Enviando al relé ✓»**.  
   - Si no sale «Enviando al relé ✓», el relé no está conectado: revisa que en la Terminal 1 esté corriendo `npm run relay`.
5. **Mantén esta pestaña abierta** y con la cámara enfocando tus manos (buena luz, manos visibles).

### Paso 3 – Overlay en OBS
1. En OBS: **Fuente** → **Añadir** → **Navegador**.
2. Pon un nombre (ej. “Overlay manos”) y Aceptar.
3. En **URL** escribe exactamente:  
   **http://localhost:3000/ai/live-anim-obs.html**
4. En propiedades de la fuente:
   - Activa **«Usar fondo transparente»**.
   - Ancho y alto: los de tu escena (ej. 1920×1080).
5. Aceptar. Deberías ver las partículas; al mover las manos en la cámara de la pestaña de Chrome, la animación en OBS debería reaccionar.

### Si no detecta las manos (Estrategia A)
- Comprueba que en Chrome **sí** aparece «Enviando al relé ✓».
- Mejora la luz y acerca las manos a la cámara.
- Prueba en Chrome el **modo mouse** para verificar que el overlay responde: abre en el navegador  
  **http://localhost:3000/ai/live-anim-obs.html?mouse=1&hud=1**  
  y mueve el ratón: las partículas deberían reaccionar. Si eso funciona, el fallo está en la detección de manos o en la cámara.

---

## Estrategia B: Una sola ventana (recomendada si el relé no te detecta bien)

Aquí **no usas el overlay en OBS**. Abres solo la página con cámara y animación en Chrome y OBS captura **esa ventana**. La detección de manos ocurre en el mismo sitio que la animación, así que suele ser más estable.

### Paso 1 – Servidor web
Solo necesitas el servidor HTTP (Terminal 2 con `npm start`). El relé no hace falta para esta estrategia.

### Paso 2 – Chrome
1. Abre Chrome y ve a:  
   **http://localhost:3000/ai/live-anim.html**  
   (sin `?broadcast=1`).
2. Permite la cámara cuando la pida.
3. Deberías ver la animación y tus manos controlando las partículas en la **misma** ventana.
4. Opcional: **F11** para pantalla completa o deja la ventana a un tamaño cómodo.

### Paso 3 – OBS
1. **Fuente** → **Añadir** → **Captura de ventana** (o **Captura de ventana (Windows)** si usas Windows).
2. Elige la ventana de **Chrome** donde está abierta `live-anim.html`.
3. Ajusta posición y tamaño en la escena.

Con esto la animación y las manos van en la misma imagen; no depende del relé ni del navegador de OBS.

---

## Versión corazón 3D (amor y amistad)

Archivo **live-anim-heart.html**: mismo sistema de manos pero con un corazón 3D de partículas (rojo/rosa) que late suavemente y reacciona al acercar las manos (repulsión y dispersión). Ideal para stories o reels.

- **En Chrome (todo en uno):** `http://localhost:3000/ai/live-anim-heart.html`
- **Con relé (para OBS overlay):** emisor `live-anim-heart.html?broadcast=1` en Chrome; en OBS usa la fuente Navegador con `live-anim-obs.html` (el overlay genérico recibe las manos y puede mostrar partículas; para solo corazón habría que usar la misma URL del corazón en el navegador de OBS si tiene cámara, o capturar la ventana de Chrome con el corazón).

Para grabar para Instagram: abre `live-anim-heart.html` en Chrome, permite la cámara, acerca las manos al corazón y graba la ventana o la pantalla.

---

## Resumen de URLs

| Qué | URL |
|-----|-----|
| Emisor (cámara + enviar manos al relé) | http://localhost:3000/ai/live-anim.html?broadcast=1 |
| **Corazón 3D (amor/amistad)** | http://localhost:3000/ai/live-anim-heart.html |
| Overlay en OBS (recibe manos por relé) | http://localhost:3000/ai/live-anim-obs.html |
| Probar overlay con el ratón (sin OBS) | http://localhost:3000/ai/live-anim-obs.html?mouse=1&hud=1 |
| Todo en uno (Chrome, para Estrategia B) | http://localhost:3000/ai/live-anim.html |

### Fondo transparente (Browser source en OBS)
Si usas **Fuente Navegador** en OBS con `live-anim.html?broadcast=1`, la página ya lleva fondo transparente por defecto. En las **propiedades** de esa fuente en OBS activa **«Usar fondo transparente»** para que se vea lo que haya debajo (escena, cámara, etc.). Si quisieras fondo negro, añade `?transparent=0` a la URL.

---

## Gestos (resumen)

- **Mano izquierda:** 1–4 dedos = figura 3D (cubo, esfera, toro, cono). Palma abierta = CATCH.
- **Mano derecha:** puño = tocar/dispersar partículas. Palma abierta = NEBULA.
- **Ambas palmas abiertas:** pelota (“ultimate”).
- **Paz (2 dedos)** con la derecha = siguiente objeto flotante.

---

## Alternativa: servir solo la carpeta `ai`

Si no usas el servidor principal:

```bash
cd ai
npx serve -l 8080
```

En ese caso usa `http://localhost:8080/` en lugar de `http://localhost:3000/ai/` (y los archivos estarían en la raíz, ej. `http://localhost:8080/live-anim.html?broadcast=1`). El relé sigue siendo necesario para la Estrategia A: `npm run relay` desde la raíz del proyecto.
 